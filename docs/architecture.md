# 工蚁系统架构文档

> ⚠️ **文档状态（2026-10-05）**：本文的「浏览器模式（:9410/:9411）」描述的是 **2026-08-08 已归档**的旧形态（现位于 `apps/_archive/`，**勿改勿跑**）。**现行主形态是 Electron 桌面端**：整个引擎运行在 Electron main 进程内，GUI 为内嵌 `renderer`（React），经 preload+IPC 驱动 main；ANS（AI 资源中心）默认 `:27183`。以源码为准。

## 系统架构

工蚁系统支持**两种部署模式**，由四个子系统组成，采用 monorepo 管理：

### 浏览器模式（`pnpm dev`）

```
┌──────────────────────────────────────────────────────────────────┐
│                   工蚁前端 (Next.js :9410)                         │
│          运维看板 │ 配置管理 │ 项目管理 │ 用户认证                    │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HTTP REST (JWT)
┌─────────────────────────────▼────────────────────────────────────┐
│                    工蚁后端 (Elysia :9411)                         │
│  IM适配器 │ 项目管理 │ 任务调度 │ 记忆管理 │ AI Agent │ 认证授权     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              ANS 客户端 (本地SDK，LRU缓存)                     │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
└─────────────────────────────┼────────────────────────────────────┘
                              │ HTTPS + HMAC签名
┌─────────────────────────────▼────────────────────────────────────┐
│                  ANS 服务端 (Elysia :3001)                         │
│  AI模型管理 │ 技能注册中心 │ MCP注册中心 │ A2A注册中心              │
│  AI Gateway (主/备双路) │ 资源匹配引擎 │ 计费 │ 审计 │ 速率限制     │
│  ┌──────────────────────────────────────────────────────┐       │
│  │          数据层: SQLite (单文件) + 本地文件系统        │       │
│  └──────────────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────────────────┘
```

### 桌面模式（`pnpm desktop:dev:full`）

```
┌─────────────────────────────────────────────────────────────┐
│              worker-ant-desktop (Electron)                    │
│                                                              │
│  ┌─ Main Process ─────────────────────────────────────────┐ │
│  │  工蚁后端 (Elysia :9411) ← createServer() 嵌入式启动     │ │
│  │  系统托盘 │ safeStorage │ 原生通知 │ OAuth协议 │ 自动更新 │ │
│  │  崩溃重启 │ 休眠恢复 │ 单实例锁                          │ │
│  └────────────────────────────────────────────────────────┘ │
│                          │ IPC (contextBridge)                │
│  ┌─ Renderer (BrowserWindow) ─────────────────────────────┐ │
│  │  工蚁前端 (Next.js :9410)                                │ │
│  │  JWT → safeStorage │ OAuth → worker-ant://协议           │ │
│  └────────────────────────────────────────────────────────┘ │
│                          │                                    │
│               HTTPS + HMAC 签名                               │
│                          ▼                                    │
│               ANS 服务端 (:3001)                               │
└─────────────────────────────────────────────────────────────┘
```

## 技术栈

| 层         | 技术                                                                  |
| ---------- | --------------------------------------------------------------------- |
| 运行时     | Node.js v22.21.1                                                      |
| 语言       | TypeScript strict                                                     |
| 后端框架   | ElysiaJS (Schema-first验证 + Swagger自动生成)                         |
| 数据库     | better-sqlite3 (MVP单文件，WAL模式)                                   |
| AI Agent   | Vercel AI SDK v4 (generateText/streamText/tool)                       |
| AI Gateway | 自建轻量网关 (主/备双路 + OpenAI兼容格式)                             |
| 前端       | Next.js 16 App Router + shadcn/ui + Tailwind CSS v4                   |
| 桌面端     | Electron 33 (系统托盘/原生通知/safeStorage/OAuth协议/崩溃重启)        |
| 认证       | JWT (jose) + Auth.js v5 + OAuth (GitHub/Google/桌面worker-ant://协议) |
| 包管理     | pnpm workspace monorepo                                               |
| 构建       | tsup (后端/桌面端) / Next.js (前端)                                   |
| CI         | GitHub Actions (lint + typecheck + format check)                      |

## 数据模型

### ANS 服务端 (7张表)

- `ans_ai_providers` — AI供应商（openai/anthropic等）
- `ans_ai_models` — AI模型（名称/能力标签/上下文窗口/价格）
- `ans_model_endpoints` — 模型端点（URL/API Key加密存储/优先级/权重）
- `ans_skills` — 技能注册（名称/输入Schema/关联MCP/标签）
- `ans_mcp_servers` — MCP服务注册（端点/传输模式/认证）
- `ans_a2a_servers` — A2A服务注册（Agent Card URL/能力列表）
- `ans_billing_records` — 计费记录（token使用量/费用）
- `ans_audit_logs` — 审计日志

### 工蚁后端 (11张表)

- `wa_users` / `wa_user_credentials` / `wa_oauth_accounts` — 用户认证
- `wa_projects` / `wa_project_members` — 项目与成员
- `wa_tasks` / `wa_task_conversations` — 任务与对话记录
- `wa_memories` — 向量记忆（embedding + 余弦相似度检索）
- `wa_im_channels` / `wa_im_conversations` — IM渠道与对话
- `wa_deliverables` — 项目产出物（MCP/A2A/UI/DOC）
- `wa_jobs` — 任务队列（持久化 + 崩溃恢复）

## 核心流程

### AI调用流程

```
1. 工蚁后端通过ANS客户端发起请求
2. ANS客户端使用HMAC签名调用ANS服务端
3. ANS服务端匹配引擎查询最优模型端点（能力/成本/供应商过滤）
4. AI Gateway使用主URL调用LLM（OpenAI兼容格式）
5. 主URL失败自动切换备用端点
6. 计费记录写入，结果返回
```

### IM消息处理流程

```
用户微信/QQ消息 → IM适配器接收 → 创建工单 → 任务调度器入队
→ Agent引擎获取ANS最优模型 → AI生成回复 → 保存对话记录
→ 异步提取记忆embedding → IM适配器推送回复
```

## 安全

| 层级     | 措施                                   |
| -------- | -------------------------------------- |
| API认证  | HMAC-SHA256签名 + 时间戳窗口(5分钟)    |
| 密钥存储 | 环境变量 + AES-256-GCM加密存储         |
| 速率限制 | 内存滑动窗口 60 req/min                |
| 断路器   | 5次连续失败打开，30秒冷却              |
| SQL注入  | 参数化查询 (better-sqlite3)            |
| AI内容   | `<user_content>`标签包裹，成本上限检查 |

## 启动

```bash
pnpm install
cp .env.example .env  # 编辑配置
pnpm dev              # 同时启动三个服务
# ANS: http://localhost:3001/docs
# 后端: http://localhost:9411/docs
# 前端: http://localhost:9410
```
