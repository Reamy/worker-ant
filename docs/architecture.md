# 工蚁系统架构文档

> **现行形态（2026-11-21，v0.9.0）**：只有一个应用形态 —— **Electron 桌面端**（整个引擎运行在 main 进程内）+ **ANS**（AI 资源中心，默认 `:27183`）。
> 2026-08-08 之前的「浏览器三服务（:9410 Web / :9411 Server / :3001 ANS）」已归档到 `apps/_archive/`，**勿改勿跑**，本文不再描述。
> 以源码为准。

## 系统组成

```
┌──────────────────────────────────────────────────────────────┐
│                    worker-ant-desktop (Electron)              │
│                                                              │
│  ┌─ renderer (React 19 + Vite + Tailwind v4) ─────────────┐ │
│  │  Dashboard / Projects / Tasks / Positions / Deliverables │ │
│  │  Memories / TeamLibrary / Inbox / IM / Models / ApiKeys  │ │
│  │  Skills / MCP / A2A / Plugins / Templates / Users / …    │ │
│  └──────────────────────────┬───────────────────────────────┘ │
│                             │ preload + IPC（contextBridge）   │
│  ┌─ main 主进程 —— 引擎本体 ─▼───────────────────────────────┐ │
│  │  事件溯源项目/任务引擎 · 调度器（cron/自主模式）             │ │
│  │  Agent 执行循环 · 子代理 · 验收评分 · 产出校验              │ │
│  │  记忆 / 配方 / 知识蒸馏 · 技能与工具注册表 · MCP 客户端池    │ │
│  │  岗位（角色）/ 项目画像与业务知识 · 团队共享库               │ │
│  │  A2A 运行时 · IM 适配器 · 成果交付 · 通知 · 设备/协同        │ │
│  │  ans-client（HMAC + LRU） ———————————┐                    │ │
│  └───────────────────────────────────────┼────────────────────┘ │
└──────────────────────────────────────────┼──────────────────────┘
                                           │ 出站 HMAC 签名
                             ┌─────────────▼─────────────┐
                             │  ANS 资源中心  :27183      │
                             │  模型匹配 / Gateway / 计费  │
                             │  技能同步 / MCP / A2A / 插件 │
                             └─────────────┬─────────────┘
                                           │ OpenAI 兼容
                             ┌─────────────▼─────────────┐
                             │  你的模型端点（BYO Key）    │
                             └───────────────────────────┘
```

- **桌面端**：`apps/worker-ant-desktop`。main 进程持有引擎与数据库；renderer 只做展示与交互；
  preload 暴露受控 IPC。打包版把 ANS 运行时放在 `Resources/ans-server/`，以 `ELECTRON_RUN_AS_NODE=1` 代起。
- **ANS**：`apps/ans-server`，唯一常驻 HTTP 服务，默认 `:27183`。桌面端经 `packages/ans-client`（HMAC）调用。
- **共享包**：`packages/shared-types`（跨端类型）。

### v0.8.0 新增模块（按职责）

| 模块                                                          | 职责                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `core/project-skills.ts` / `skill-registry.ts`                | 项目技能独立表（`(project_id,name)` 唯一）、项目作用域注册、显式提升为全局；解析顺序岗位 > 项目 > 全局 |
| `core/project-experience.ts` / `project-experience-labels.ts` | 零 LLM 项目经验账：规模 p50/p90、工具可靠度、浪费坑、失败因、服务/ROI；≤120 token 注入段               |
| `core/external-grant.ts`                                      | 外部终端授权边界纯判据：设备范围（设备/房间/品类）、滚动频率、是否允许联动                             |
| `core/external-calls.ts`                                      | 门内执行点：`/capabilities` 范围过滤、`/invoke`/`/intent` 范围+频率+联动复核                           |
| `core/device-automation.ts`                                   | 设备联动规则：状态/属性/每日时刻触发，冷却/试运行/运行账；动作仍走 `runDeviceControl`                  |
| `core/remote-workspace.ts` / `core/ops-overview.ts`           | 跨机只读分析工作区（有界/可清理）；运维一页（只读，读不到写原因）                                      |

### v0.9.0 新增模块（按职责）

| 模块                                                   | 职责                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `core/model-performance.ts`                            | 模型实绩只读派生：单数/成功率/p50·p90 token/均成本；样本 <3 不报成功率、缺数不补 0          |
| `core/self-evolve-scan.ts`                             | 自省提案生产者：30 天 ≥20 次拒绝归并 `rule` 提案，6h 巡检，只产 pending                     |
| `core/self-evolve-impact.ts`                           | 批准前后同类拒绝频率复盘（按天归一；证据不足如实说）                                        |
| `core/knowledge-inbox.ts`                              | 知识待办只读读模型：经验/技能/领域包/提案四组，读不到≠0                                     |
| `renderer/src/lib/theme.ts` + `renderer/src/index.css` | 界面主题三态（system/light/dark）、`@theme` 浅色 token、`:root.wa-dark` 暗色 token 与兼容层 |

## 技术栈

| 层            | 技术                                        |
| ------------- | ------------------------------------------- |
| 运行时        | Node.js ≥ v22.21.1                          |
| 语言          | TypeScript strict                           |
| 桌面壳        | Electron 33                                 |
| 引擎 / 数据   | better-sqlite3（WAL，事件溯源）             |
| AI Agent      | Vercel AI SDK v4 + 自建 Agent Loop + 子代理 |
| AI 资源中心   | ElysiaJS + ans-client（HMAC）               |
| GUI           | React 19 + Vite + Tailwind CSS v4           |
| 认证          | jose (JWT) + bcrypt（+ 可选 OAuth）         |
| IM            | 微信 / QQ / 飞书 / 钉钉 / 企业微信          |
| 包管理 / 构建 | pnpm workspace · tsup · turbo               |

## 数据模型（SQLite）

- `data/worker-ant-server.db` —— 桌面工蚁主库。核心表域：
  - 认证：`wa_users` / `wa_user_credentials` / `wa_oauth_accounts`
  - 项目与任务：`wa_projects` / `wa_project_members` / `wa_tasks` / `wa_task_conversations` / `wa_task_files` / `wa_task_templates`
  - 事件溯源：`wa_event_log` / `wa_audit_events` / `wa_audit_trail`
  - 成果：`wa_deliverables` / `wa_deliverable_versions`
  - 记忆与知识：`wa_memories` / `wa_knowledge_triples` / `wa_knowledge_cards` / `wa_project_knowledge` / `wa_domain_packs`
  - IM 与通知：`wa_im_channels` / `wa_im_conversations` / `wa_im_outbox` / `wa_notifications`
  - 执行与协同：`wa_jobs` / `wa_approvals` / `wa_external_calls` / `wa_devices` / `wa_device_actions` / `wa_external_terminals`
  - 配置：`wa_settings` / `wa_skills`
- `data/ans-server.db` —— ANS 库。核心表：`ans_ai_providers` / `ans_ai_models` / `ans_model_endpoints` /
  `ans_api_keys` / `ans_nodes` / `ans_skills` / `ans_mcp_servers` / `ans_plugins` / `ans_entitlements` /
  `ans_billing_records` / `ans_audit_logs`。
- dev 数据目录为仓库根 `data/`；生产为 `app.getPath('userData')`。

## 核心流程

### 任务执行

```
用户派活（桌面端 / IM）
→ 任务入库（pending）→ 调度器认领（running）
→ Agent 执行循环：选模型（出站 HMAC → ANS）→ 工具调用（本机文件/命令/git）
→ 每步写事件（wa_event_log，可暂停/恢复/重放/审计）
→ 产出校验 + 验收评分 → 成果登记（wa_deliverables）
→ 通知 / IM 回执
```

### 模型调用

```
main 进程 → ans-client（HMAC 签名）→ ANS 匹配最优端点（能力/成本/供应商过滤）
→ ANS Gateway 调模型（OpenAI 兼容，主/备双路）→ 计费记录 → 返回结果
```

### IM 入站媒体

```
IM 适配器收消息 → 媒体落盘 data/attachments/<YYYYMMDD UTC>/<件名>
（同名追加 -2/-3，不覆盖）→ 任务上下文引用附件 → 回执确认
```

## 安全

| 层级     | 措施                                           |
| -------- | ---------------------------------------------- |
| 桌面↔ANS | HMAC-SHA256 签名 + 时间戳窗口                  |
| 密钥存储 | 环境变量 / DB settings + AES-256-GCM 加密字段  |
| SQL 注入 | 全量参数化查询（better-sqlite3）               |
| 工具执行 | 权限分级 + 越界即拒 + 每步真停                 |
| 设备控制 | 「看见不等于授权」，原始控制须显式勾选         |
| 许可     | 档位化上限 + fail-open（许可服务不可用不阻断） |

> 应用内的注入检测、YOLO 分类器等是启发式检查，**不是**安全边界；真正的边界是操作系统级隔离
> （文件系统权限、网络隔离、专用账户/容器）。详见 [`SECURITY.md`](SECURITY.md)。

## 启动

```bash
pnpm install
pnpm dev:ans                                # 终端 1：ANS :27183
cd apps/worker-ant-desktop && bash run.sh   # 终端 2：桌面端（用 Terminal.app）
```

打包与发布见 [`DEPLOY.md`](DEPLOY.md)。
