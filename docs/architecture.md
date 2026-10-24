# 工蚁系统架构文档

> **现行形态（2026-10-24）**：只有一个应用形态 —— **Electron 桌面端**（整个引擎运行在 main 进程内）+ **ANS**（AI 资源中心，默认 `:27183`）。
> 2026-08-08 之前的「浏览器三服务（:9410 Web / :9411 Server / :3001 ANS）」已归档到 `apps/_archive/`，**勿改勿跑**，本文不再描述。
> 以源码为准。

## 系统组成

```
┌──────────────────────────────────────────────────────────────┐
│                    worker-ant-desktop (Electron)              │
│                                                              │
│  ┌─ renderer (React 19 + Vite + Tailwind v4) ─────────────┐ │
│  │  Dashboard / Projects / Tasks / Deliverables / Memories  │ │
│  │  IM / Models / ApiKeys / Skills / MCP / A2A / Plugins    │ │
│  │  Templates / Users / Activity / Settings                 │ │
│  └──────────────────────────┬───────────────────────────────┘ │
│                             │ preload + IPC（contextBridge）   │
│  ┌─ main 主进程 —— 引擎本体 ─▼───────────────────────────────┐ │
│  │  事件溯源项目/任务引擎 · 调度器（cron/自主模式）             │ │
│  │  Agent 执行循环 · 子代理 · 验收评分 · 产出校验              │ │
│  │  记忆 / 配方 / 知识蒸馏 · 技能与工具注册表 · MCP 客户端池    │ │
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
