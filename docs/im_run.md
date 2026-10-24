# 工蚁系统——IM 命令与通知推送运行机制

> 最后更新：2026-08-27（Electron 桌面端架构 + zx_3 待确认门禁 IM 唤醒）  
> 基于 `apps/worker-ant-desktop/src/main/services/im-router.ts`  
> 旧版（Elysia 后端）已归档至 `apps/_archive/worker-ant-server`

---

## 1. 两大 IM 通道

```
┌─────────────────────────────────────────────────────┐
│ 通道A: IM 命令（用户主动查询）                         │
│ routeImMessage → tryImCommand（匹配 im_commands）     │
│ → execSync 脚本 → Python 写 .txt 到通知目录           │
│ → 读取最新 .txt → sendReply 发送                     │
├─────────────────────────────────────────────────────┤
│ 通道B: F3 通知推送（系统主动推送）                     │
│ Cron/Agent/Python 写 .txt 到通知目录                  │
│ → processF3NotificationFiles（30s 扫描）→ IM 发送    │
└─────────────────────────────────────────────────────┘
```

---

## 2. IM 消息入口（routeImMessage）

`services/im-router.ts` 的 `routeImMessage(ctx, fromUser, text, chatType, contextToken)` 是消息总入口，按顺序：

```
0.  空消息过滤（trim 后为空 → return）
1.  消息去重（isDuplicate：30s 窗口，channel:from:body前80字指纹）
2.  消息风暴检测（isStorm：2条/2s → 15s 冷却，冷却期跳过）
3.  存储入站消息（wa_im_conversations，direction=inbound）
4.  记住偏好/习惯（handleRememberPreference：用户「记住...」→ storeUserPreference）
5.  编号选择（handleNumberSelection：数字选择选项）
6.  Agent 回复路由（handleAgentReply）
7.  审批队列检查（checkPendingApproval：内存队列 LIFO）
8.  审批回退 DB 扫描（checkDbApprovalFallback：队列空时扫描 paused+[等待用户输入]）
9.  IM 命令分发（tryImCommand：遍历项目 im_commands，关键词子串匹配）
10. LLM 意图分类（classifyIntentWithLLM：regex 未匹配且 >4 字时）
11. 系统状态查询 / 简单问候 / 启动任务（handleStartTask）/ 创建任务（handleCreateTask）
12. 兜底（「收到，输入帮助查看指令」）
```

### 2.1 防护层参数

| 防护     | 参数                  | 说明                         |
| -------- | --------------------- | ---------------------------- |
| 消息去重 | 30s 窗口，80 字指纹   | WeChat 重投 5-7 次实测       |
| 风暴检测 | 2 条/2s → 15s 冷却    | 冷却期跳过所有消息（含审批） |
| 消费缓存 | 120s 窗口，200 条上限 | 防微信重投「是」重复恢复     |

---

## 3. 审批队列（含 zx_3 待确认门禁唤醒）

`checkPendingApproval` + `checkDbApprovalFallback` 两层：

```
第一层 - 内存队列（pendingImApprovals: Map<channel:from, Array<PendingApproval>>）：
  ├─ 注册：ask_user/待确认门禁 暂停时 push（同任务去重，不同任务共存）
  ├─ 消费「是/确认」：CONFIRM_REGEX 匹配 → LIFO pop → isTaskApprovable 校验
  │   → 写 [用户确认执行] → enqueue resume-ai-task
  └─ 消费选项文字：approval.options 匹配 → 写 [用户选择:xxx] → resume-ai-task

第二层 - DB 回退扫描（队列空/失效时）：
  matchDbApprovalOption：扫描 paused/failed + 含「[等待用户输入]」+ 选项匹配
  → 直接写回复 + resume-ai-task
```

### 3.1 启动恢复

`rebuildPendingApprovalsOnStartup`：扫描 paused/failed + 含「[等待用户输入]」+ 1h 内 → 重建审批队列。

### 3.2 zx_3 待确认门禁的 IM 唤醒

```
executeTask 门禁暂停 → 写「[等待用户输入] 任务执行前需确认... [选项: A | B]」
                    → emit task.awaiting_input + sendImAskUser 发 IM 消息
用户 IM 回复「是」或选项 → checkDbApprovalFallback 匹配「[等待用户输入]」→ resume-ai-task
```

> 门禁系统消息复用 ask_user 的「[等待用户输入] ... [选项: A | B]」格式（选项用 `|` 分隔），
> 使 IM 回复唤醒能识别门禁暂停的任务。

---

## 4. IM 命令分发（通道A · tryImCommand）

各项目通过 `wa_projects.context_json.im_commands` 自注册命令：

```json
{
  "im_commands": {
    "持仓概况": { "script": "python3 scripts/portfolio_overview.py", "label": "持仓概况" },
    "选股推荐": { "script": "python3 scripts/stock_recommendation.py", "label": "选股推荐" }
  }
}
```

分发流程：

```
tryImCommand(ctx, toUser, msgText):
  ├─ 遍历 active 项目的 context_json.im_commands
  ├─ 对每个命令：msgText.includes(keyword) → 匹配
  ├─ spawn(cmd.script, {cwd: project.working_dir, env: {NOTIFICATION_PAYLOAD_DIR}, timeout: 10min})
  │   （异步执行，不阻塞主线程，收集 stderr 供失败定位）
  ├─ 读取 NOTIFICATION_PAYLOAD_DIR 最新 .txt（排除 P0_ 前缀）
  ├─ sendReply(输出内容 ≤4000 字) + 删除文件
  └─ 无输出 → 「命令已执行但未生成输出文件」；失败 → 「生成失败请稍后重试」
```

---

## 5. F3 通知推送（通道B）

### 5.1 处理流程（processF3NotificationFiles，30s 周期）

```
1. 扫描 NOTIFICATION_PAYLOAD_DIR 下 .txt（按文件名排序，取前 20）
2. 防重：_f3ProcessedFiles Set
3. 时间门槛：mtime < 10s 的文件跳过（避免读未写完文件）
4. 读取 ≤4000 字，<20 字跳过删除
5. 遍历 active IM 渠道 → 取 lastExternalUser → sendReply
6. 全部成功 → 删除文件 + 更新 _f3LastSuccess
7. 失败 → 保留文件待下次扫描重试（超 2h 才放弃删除）
```

### 5.2 通知目录契约

```
NOTIFICATION_PAYLOAD_DIR = data/notification_payloads/
主进程 index.ts 启动时设置 process.env.NOTIFICATION_PAYLOAD_DIR
子进程（cron 脚本/守护进程/IM 命令）通过环境变量读取，写 .txt 到该目录
```

### 5.3 文件命名

| 类型     | 格式                                | 说明                        |
| -------- | ----------------------------------- | --------------------------- |
| 定时播报 | `broadcast_{slot}_{date}.txt`       | 开盘/上午/收盘前快报        |
| IM 命令  | `{command}_{timestamp}.txt`         | 脚本自由命名，F3 按名取最新 |
| 告警     | `P0_daemon_alert_{slot}_{date}.txt` | 播报健康检查失败            |
| 优先级   | `P0_ > P1_ > P2_`                   | 文件名排序自动优先          |

---

## 6. 端到端时序

### 6.1 IM 命令完整链路（通道A）

```
用户微信「持仓概况」
→ IM 适配器 → routeImMessage
→ 去重/风暴/存储/记住偏好/编号/Agent回复/审批 均不命中
→ tryImCommand：匹配 im_commands["持仓概况"]
→ spawn python3 scripts/portfolio_overview.py（cwd=a-stock-advisor）
→ 脚本拉 DSA/tickflow 数据 → 写 portfolio_overview_*.txt 到通知目录
→ spawn 返回 → 读最新 .txt → sendReply → 删除文件
→ 用户微信收到 📊持仓概况
```

### 6.2 待确认门禁确认链路（zx_3）

```
任务「方案实施」执行 → executeTask 门禁 detectPendingConfirmations
→ 检测到 3 项待确认事项 → 暂停 + 写「[等待用户输入]...」+ IM 发「[待回复]...选项: A | B」
→ 用户 IM 回复「是」→ checkDbApprovalFallback 匹配 → resume-ai-task
→ executeTask 重新执行 → gate_triggered=true → 跳过门禁 + 回填 confirmations → 继续执行
```

### 6.3 定时播报链路（通道B）

```
09:35 → alert_dashboard 守护进程 → scheduled_broadcast.py
→ 拉持仓/行情/大盘 → 写 broadcast_morning_open_{date}.txt
→ F3 30s 扫描 → processF3NotificationFiles → sendReply → 删除文件
```

---

## 7. 相关文件索引

| 文件                     | 职责                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `services/im-router.ts`  | routeImMessage（消息入口）+ tryImCommand + 审批 + F3 通知            |
| `core/agent-executor.ts` | pauseForDecision（统一暂停助手）+ detectPendingConfirmations（门禁） |
| `core/jobs/ai-task.ts`   | resume-ai-task（确认后恢复执行）                                     |
| `ipc/im.ipc.ts`          | IM 适配器生命周期（启动/停止/消息转发）                              |
| `ipc/project.ipc.ts`     | task:respond（桌面端结构化决策响应）                                 |
