# 工蚁系统——任务执行流程与调用时序

> 最后更新：2026-08-27（Electron 桌面端架构 + zx_1/zx_2/zx_3 记忆与人机确认机制）  
> 基于 `apps/worker-ant-desktop/src/main/` 核心文件  
> 旧版（Elysia 后端 + Next.js 前端）已归档至 `apps/_archive/`

---

## 1. 整体架构

```
Electron 桌面端（apps/worker-ant-desktop）
├── 主进程 main/
│   ├── index.ts                 # 入口：初始化 DB/调度器/作业/IPC/IM/记忆
│   ├── core/
│   │   ├── task-scheduler.ts    # 轻量调度器（内存队列 + SQLite 持久化 + cron）
│   │   ├── agent-executor.ts    # executeTask：Agent 执行核心（AI SDK generateText 多步循环）
│   │   ├── memory-manager.ts    # 记忆系统（59+ 机制）
│   │   ├── task-archetype.ts    # 任务原型分类（6 类）+ 复杂度 + 拆解
│   │   ├── feedback-engine.ts   # 反馈学习（策略/工具使用/阈值）
│   │   └── jobs/                # ai-task / resume-ai-task / background-review / consolidate-memories
│   ├── services/im-router.ts    # IM 路由（命令分发 + 审批 + F3 通知）
│   └── ipc/                     # 前端 ↔ 主进程 IPC
├── renderer/                    # React + Vite 前端（任务/项目/IM 管理 UI）
└── better-sqlite3 (data/worker-ant-server.db)
```

**关键进程外依赖**：ANS Gateway（:27183 模型资源中心）、MCP 服务、守护进程（A 股投顾项目）。

---

## 2. 任务生命周期状态机

```
pending → executing → completed
              │
              ├→ paused ──(确认/resume)──→ pending → executing
              ├→ failed ──(resume)────────→ pending → executing
              ├→ preparing（恢复中）
              ├→ planning（计划模式，子任务拆解）
              └→ stabilizing（等待人工确认，不自动超时）
```

| 状态转换                                                 | 触发位置                                | 事件                  |
| -------------------------------------------------------- | --------------------------------------- | --------------------- |
| `pending/paused/preparing` → `executing`                 | `executeTask` CAS 抢占                  | `task.status_changed` |
| `executing` → `paused`（待确认门禁/ask_user/无进展暂停） | `executeTask` 门禁 / `pauseForDecision` | `task.awaiting_input` |
| `executing` → `completed`                                | `finalize_task`                         | `task.completed`      |
| `executing` → `failed`                                   | 异常 / 超时（10min 无心跳）/ A3 降级    | `task.failed`         |
| `pending` → `preparing`                                  | `resume-ai-task`                        | `task.status_changed` |

---

## 3. 任务创建入口

| 入口     | 位置                                                         | 说明                                     |
| -------- | ------------------------------------------------------------ | ---------------------------------------- |
| 前端 IPC | `ipc/project.ipc.ts`                                         | 手动创建任务 → `ai-task` 作业            |
| IM 命令  | `im-router.ts handleCreateTask/handleStartTask`              | 「创建任务+标题」/「启动任务名」         |
| cron     | `task-scheduler.ts registerCronJob`                          | 按项目 `cron_create_task` 模板定时建任务 |
| 子任务   | `agent-executor.ts decomposeTaskWithLLM` + `enter_plan_mode` | 计划模式拆解为子任务（含 depends_on）    |
| 自治链   | `ai-task.ts checkAutonomousChain`                            | 项目自治模式下完成后自动建 backlog 任务  |

统一写入 `wa_tasks`（status=pending）+ `wa_jobs`（type=ai-task）。

---

## 4. 任务调度（TaskScheduler）

`core/task-scheduler.ts`：内存队列 + SQLite 持久化，重启自动恢复。

| 定时器                  | 周期  | 职责                                                                |
| ----------------------- | ----- | ------------------------------------------------------------------- |
| `processPending`        | 1s    | 分发 pending 作业到 handler                                         |
| `checkScheduled`        | 5s    | 处理定时作业（scheduled_at）                                        |
| `checkTimeouts`         | 30s   | executing 10min / planning 30min 超时                               |
| `scanReadyTasks`        | 10s   | 扫描就绪任务（依赖完成 + 活跃时间窗 + 并发≤maxConcurrency）自动入队 |
| `runBottleneckAnalysis` | 30min | 项目瓶颈分析（主要矛盾）                                            |

**启动恢复**：`start()` 扫描 `wa_jobs` pending/running → running 的 ai-task 转为 resume-ai-task。

---

## 5. 任务执行（executeTask）

`core/agent-executor.ts` 的 `executeTask(ctx, taskId)` 是执行核心。完整流程（按顺序）：

### 5.1 抢占与门禁

```
1. 读 task/project → workingDir
2. CAS 抢占：UPDATE status='executing' WHERE status IN (pending,paused,preparing)
   ├─ 成功 → emit task.status_changed(executing)
   └─ 失败(changes=0) → return "任务被抢占(CAS冲突)"
3. 【zx_3】待确认事项门禁（王阳明知行合一 + 老子知止）：
   detectPendingConfirmations(db, projectId, taskText, taskId, workingDir)
   ├─ 从任务描述提取方案文档路径（*.md）
   ├─ 正则提取「**【xxx确认/澄清/决策/答复/核实/核对/待定】**」标记 → 待确认事项
   ├─ 过滤已确认：同项目所有任务 confirmations + 文档「关键决策记录（已确认）」章节表格第一列
   ├─ 未确认事项 > 0 且 context_json.gate_triggered 未设置
   │   → 写 gate_triggered + [等待用户输入]...消息 + emit task.awaiting_input + IM 通知
   │   → 置 paused + return（等待用户确认）
   └─ gate_triggered=true（用户已确认 resume）→ 跳过门禁 + 回填 confirmations（{item,confirmed_at,channel}）
```

### 5.2 任务类型识别与策略

```
4. classifyArchetype(`${title} ${description}`) → 6 类原型
   ├─ 关键词正则（优先）→ 家族相似性（兜底）→ 长度规则（最终）
5. calibrateArchetype(db, projectId, text, archetype) → 分类模糊时用历史成功率破 tie
6. getAdaptiveStrategy(archetype) → 步数/温度/优先工具
7. applyPriorityTilt(strategy, priority) → 集中兵力（critical 升模型+1.5x步数）
8. determineExecutionMode + applyExecutionMode → 战略藐视（小任务快速模式）
9. assessComplexity(description) → simple/standard/complex
```

### 5.3 记忆上下文构建（buildMemoryContext）

注入 `wa_tasks.context_json.injected_memory_ids`（供完成后精确反馈）。section 顺序：

| section | 内容                                                                                                    | 来源机制                                               |
| ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 0       | 项目知识全景                                                                                            | 【zx_1】synthesizeProjectKnowledge（panorama）         |
| 0b      | 记忆有效性摘要                                                                                          | 【zx_1】buildMemoryEffectivenessStats                  |
| 0c      | 执行打法                                                                                                | 【zx_1】buildExecutionPlaybook                         |
| 0d      | 任务关键约束                                                                                            | 【zx_1】identifyTaskPrincipalContradiction（主要矛盾） |
| 0e      | 任务立志                                                                                                | 【zx_2】identifyTaskGoal（核心目标+成功标准+调查项）   |
| 1-10d   | 项目知识/近期经验/范例/相似任务/跨项目知识/任务相关/线索/知识图谱/前瞻/工作记忆/盲区/负空间/复盘/心中贼 | 记忆检索各类型                                         |

> `identifyTaskGoal` 与 `identifyTaskPrincipalContradiction` 均为 async LLM 调用，在 buildMemoryContext 前 await，结果作参数传入。

### 5.4 系统提示（SYSTEM_PROMPT_BASE）

含「核心规则」「代码保护铁律」「待确认事项铁律【zx_3】」「认知边界」等。

### 5.5 Agent 执行循环（generateText onStepFinish）

每步结束（onStepFinish）内：

```
stepCount++
├─ 心跳：UPDATE wa_tasks.updated_at（防超时）
├─ 记录 assistant 文本 / 工具调用 / 工具结果（落盘超长结果）
├─ 工具循环检测（loopRun：按**步**推进的游程，身份＝完整调用；探索工具豁免）
├─ 无进展检测：noProgressSteps ≥ noProgressHard → 暂停止损
├─ 每 5 步：assessFailureRisk（失败风险预警）
├─ 每 5 步：reassessComplexityDuringExecution（复杂度升级）
├─ 每 5 步：【zx_2】checkGoalDeviation（省察克治：LLM 比对进展 vs 立志目标，偏离注入提醒）
├─ 每 3 步：checkSufficiency（知足者富：早停提示）
├─ 预算：70% 预警 / 95% 催促 / 100% 强制产出
└─ 末步强制产出
```

### 5.6 完成

```
finalize_task → assessCompletionQuality（5 维度评分）→ status=completed
```

---

## 6. 任务完成后的记忆闭环

### 6.1 同步强化（ai-task.ts）

```
executeTask 返回 → memory.reinforceMemories(taskId, projectId, success, qualityScore)
  ├─ 读 injected_memory_ids（精确注入）
  ├─ 成功：importance +0.1*q，success_count+1，清除 staleness
  └─ 失败：importance -0.05，failure_count+1，标记 staleness（实践反驳）
```

### 6.2 异步背景复盘（background-review）

任务完成后 enqueue，异步执行：

```
1. extractTriplesWithLLM（知识图谱三元组）
2. LLM 提取关键记忆 → storeText
3. 【zx_2】assessProcessingDepth（加工深度：deep 记忆 importance+0.1）
4. 【zx_1】generateTaskRetrospective（任务复盘：计划 vs 实际 → retrospective）
5. 【zx_1】assessMemoryApplication（知行合一：判定注入记忆是否被应用 → 增量强化）
```

### 6.3 每小时记忆巩固（consolidate-memories）

```
runConsolidationPipeline：去重 / 冲突解决 / Ebbinghaus 衰减 / 忘却归档
clusterSimilarMemories（家族聚类）
spacedRepetition（间隔重复）
abstractSemanticKnowledge（情景→语义抽象）
extractProceduralSkills（程序性记忆→技能）
reconsolidateMemories（记忆再巩固）
【zx_1】synthesizeProjectKnowledge（项目知识全景）
【zx_1】extractApplicabilityConditions（记忆缘起条件）
【zx_1】extractLimitingBeliefs（破心中贼：失败任务提取自我设限信念）
```

---

## 7. 记忆系统机制索引（zx_1/zx_2 核心增量）

| 机制           | 方法                                                       | 哲学源                  | 说明                                                |
| -------------- | ---------------------------------------------------------- | ----------------------- | --------------------------------------------------- |
| 记忆缘起条件   | `extractApplicabilityConditions` / `applicabilityMismatch` | 空性·缘起性空           | 高价值记忆提取「适用条件+稳定性」，检索条件校验降权 |
| 记忆行动转化   | `assessMemoryApplication` / `_recordApplication`           | 王阳明知行合一          | 判定注入记忆是否被应用，被应用且成功强化            |
| 自我设限识别   | `extractLimitingBeliefs`                                   | 王阳明破心中贼          | 失败任务提取「自我设限信念」，注入心中贼提醒        |
| 任务级主要矛盾 | `identifyTaskPrincipalContradiction`                       | 毛选主要矛盾            | complex/standard 任务识别「成败关键」               |
| 记忆加工深度   | `assessProcessingDepth` / `_processingDepthBoost`          | 格物致知 + 加工水平理论 | 深/浅加工分级，deep 记忆更可靠                      |
| 任务立志       | `identifyTaskGoal`                                         | 王阳明立志 + 毛选调查   | 提炼「核心目标+成功标准+调查项」                    |
| 执行纠偏       | `checkGoalDeviation`                                       | 王阳明省察克治          | 每 5 步 LLM 比对进展 vs 目标，偏离注入提醒          |
| 待确认事项门禁 | `detectPendingConfirmations`                               | 知行合一 + 知止         | 方案待确认事项未确认则强制暂停                      |

---

## 8. 方法调用时序（端到端）

```
[任务创建] IPC/IM/cron → wa_tasks(pending) + wa_jobs(ai-task)
[调度]     TaskScheduler.processPending(1s) → ai-task handler
[并发]     ai-task 检查项目并发 → 满则退避重试
[执行]     executeTask:
             CAS抢占 → 待确认门禁【zx_3】→ 类型识别 → 世界快照
             → 记忆上下文(全景/有效性/打法/关键约束/立志/各类型记忆)
             → 立志【zx_2】→ 主要矛盾【zx_1】→ 系统提示 → generateText 多步循环
             → onStepFinish(复杂度/风险/纠偏/早停/预算) → finalize_task
[完成]     reinforceMemories(同步) + background-review(异步) + IM通知
[异步]     background-review: 三元组/关键记忆/加工深度【zx_2】/复盘/知行合一【zx_1】
[巩固]     consolidate-memories(每小时): 去重/抽象/技能/全景/缘起/心中贼【zx_1】
```

---

## 9. 关键文件索引

| 文件                     | 职责                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `core/agent-executor.ts` | executeTask（执行核心）+ buildMemoryContext + 门禁 + 纠偏              |
| `core/memory-manager.ts` | 记忆系统（检索/强化/巩固/缘起/知行合一/心中贼/加工深度/立志/主要矛盾） |
| `core/jobs/ai-task.ts`   | ai-task / resume-ai-task 作业                                          |
| `core/jobs/index.ts`     | background-review / consolidate-memories 作业                          |
| `core/task-scheduler.ts` | 调度器（队列/定时/超时/就绪扫描）                                      |
| `core/task-archetype.ts` | 原型分类/复杂度/拆解/优先级倾斜                                        |
| `services/im-router.ts`  | IM 路由（命令分发/审批/F3 通知）                                       |
