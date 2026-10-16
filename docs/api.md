# API 文档

> ⚠️ **文档状态（2026-10-05）**：其中的**「工蚁后端 :9411」**一节描述的是 **2026-08-08 已归档**的旧 `worker-ant-server`（现位于 `apps/_archive/`，**勿改勿跑**）。现行形态是 **Electron 桌面端（引擎在 main 进程内）+ ANS（`:27183`）**，桌面端不暴露 HTTP API。以源码为准。

> 除登录/注册/健康检查外，所有接口需要 JWT 认证：`Authorization: Bearer <token>`

## ANS 服务端 (port 27183)

Swagger: `http://localhost:27183/docs`

### 健康检查

```
GET /api/v1/health
→ { status: "ok", timestamp: "..." }
```

### AI模型管理

```
GET    /api/v1/models/providers          # 供应商列表
POST   /api/v1/models/providers          # 创建 { name, base_url? }
GET    /api/v1/models/providers/:id      # 供应商详情
PUT    /api/v1/models/providers/:id      # 更新 { name, base_url? }
DELETE /api/v1/models/providers/:id      # 禁用

GET    /api/v1/models                    # 模型列表
POST   /api/v1/models                    # 创建 { provider_id, name, capabilities, ... }
PUT    /api/v1/models/:id                # 更新
DELETE /api/v1/models/:id                # 禁用

GET    /api/v1/models/:modelId/endpoints # 端点列表
POST   /api/v1/models/:modelId/endpoints # 创建 { url, api_key, priority?, weight? }
PUT    /api/v1/models/endpoints/:id      # 更新
DELETE /api/v1/models/endpoints/:id      # 禁用

POST   /api/v1/models/optimal            # 最优匹配 { capabilities, strategy?, maxCostPer1k? }
```

### 技能 / MCP / A2A

```
GET/POST/PUT/DELETE /api/v1/skills/...
POST                /api/v1/skills/optimal

GET/POST/PUT/DELETE /api/v1/mcp/...
POST                /api/v1/mcp/optimal
POST                /api/v1/mcp/:id/health-check

GET/POST/PUT/DELETE /api/v1/a2a/...
POST                /api/v1/a2a/optimal
POST                /api/v1/a2a/:id/health-check
```

### AI Gateway

```
GET  /api/v1/gateway/providers
POST /api/v1/gateway/chat
     { messages, strategy?, capabilities?, maxCostPer1k?, preferredProvider?, project_id? }
```

### 计费

```
GET  /api/v1/billing/records             # ?project_id= &days=30
POST /api/v1/billing/records             # 写入记录
GET  /api/v1/billing/usage               # 按模型统计 ?days=30
GET  /api/v1/billing/usage/by-project    # 按项目统计
```

### API Key 管理

```
GET    /api/v1/auth/api-keys             # 列表
POST   /api/v1/auth/api-keys             # 创建 { name?, resource_groups? } → { api_key, secret }
PUT    /api/v1/auth/api-keys/:prefix     # 更新资源组 { resource_groups }
DELETE /api/v1/auth/api-keys/:prefix     # 吊销
```

## 工蚁后端 (port 9411) —— ⚠️ 已归档（见文首说明）

Swagger: `http://localhost:9411/docs`

### 认证

```
POST /api/v1/auth/register        # 注册 { email, password, name }
POST /api/v1/auth/login           # 登录 { email, password } → { accessToken, refreshToken, user }
POST /api/v1/auth/oauth           # OAuth回调 { email, name, provider, providerAccountId }
GET  /api/v1/auth/me              # 当前用户
GET  /api/v1/auth/users           # 用户列表
PUT  /api/v1/auth/users/:id/role  # 修改角色 { role } (super_admin)
```

### 项目

```
GET    /api/v1/projects                  # 列表
POST   /api/v1/projects                  # 创建 { name, description?, cron_schedule?, working_dir? }
GET    /api/v1/projects/:id              # 详情
PUT    /api/v1/projects/:id              # 更新
POST   /api/v1/projects/:id/clone        # 克隆 { name? } → 复制任务结构
PUT    /api/v1/projects/:id/status       # 状态流转 { status }
GET    /api/v1/projects/:id/members      # 成员列表
POST   /api/v1/projects/:id/members      # 添加成员 { user_id, role? }
```

### 任务

```
GET    /api/v1/projects/:id/tasks        # 项目任务列表
POST   /api/v1/projects/:id/tasks        # 创建 { title, description?, priority? }
GET    /api/v1/tasks/:id                 # 详情
PUT    /api/v1/tasks/:id                 # 更新
PUT    /api/v1/tasks/:id/status          # 状态更新 { status }
POST   /api/v1/tasks/:id/resume          # 恢复暂停任务 { reply? }
GET    /api/v1/tasks/:id/detail          # 完整详情(任务+对话+产出物)
GET    /api/v1/tasks/:id/conversations   # 对话记录
```

### IM 渠道

```
GET    /api/v1/im/channels              # 列表
POST   /api/v1/im/channels              # 创建 { channel_type, name?, config? }
PUT    /api/v1/im/channels/:id          # 更新
DELETE /api/v1/im/channels/:id          # 删除
POST   /api/v1/im/channels/:id/start    # 启动
POST   /api/v1/im/channels/:id/stop     # 停止
POST   /api/v1/im/channels/:id/diagnose # 诊断
GET    /api/v1/im/channels/:id/qr       # 二维码(微信)
GET    /api/v1/im/status                # 全部状态
GET    /api/v1/im/conversations         # 对话 ?channel_id=
POST   /api/v1/im/webhook/:platform     # Webhook回调
```

### 产出物

```
GET    /api/v1/projects/:id/deliverables  # 项目产出物列表
POST   /api/v1/projects/:id/deliverables  # 创建 { type, name, description?, task_id?, file_path? }
GET    /api/v1/deliverables               # 全部产出物(最近100条)
POST   /api/v1/deliverables/:id/register  # 注册到ANS
GET    /api/v1/deliverables/:id/runtime-status  # 运行时状态
GET    /api/v1/deliverables/runtime-list  # 运行时列表
```

### 运维

```
GET  /api/v1/admin/health                # 健康检查(免认证)
GET  /api/v1/admin/stats                 # 统计概览 { projects, tasks, activeTasks, memories }
GET  /api/v1/admin/stats/trend           # 每日趋势 ?days=7
GET  /api/v1/admin/stats/workload        # 工作量 { total_executions, total_tokens, total_cost, byModel }
GET  /api/v1/admin/stats/project-health  # 项目健康报告
GET  /api/v1/admin/memories/unembedded   # 待嵌入记忆
GET  /api/v1/admin/jobs                  # 调度队列 ?status=
GET  /api/v1/admin/events                # SSE实时事件流 ?token= (EventSource)
GET  /api/v1/admin/task-templates        # 任务模板列表
GET  /api/v1/admin/metrics               # 请求指标
GET  /api/v1/admin/logs                  # 系统日志 ?level= &limit=
GET  /api/v1/admin/user-preferences      # 用户偏好 ?user_id=
GET  /api/v1/admin/skills                # 技能列表
POST /api/v1/admin/skills                # 创建技能 { name, category?, description?, config? }
PUT  /api/v1/admin/skills/:id            # 更新 { enabled }
DELETE /api/v1/admin/skills/:id          # 删除
```

### ANS 代理（前端通过后端访问 ANS）

```
GET/POST/PUT/DELETE /api/v1/ans-proxy/models/providers/...
GET/POST/PUT/DELETE /api/v1/ans-proxy/models/...
GET/POST/PUT/DELETE /api/v1/ans-proxy/models/:modelId/endpoints/...
GET/POST/PUT/DELETE /api/v1/ans-proxy/skills/...
GET/POST/PUT/DELETE /api/v1/ans-proxy/mcp/...
GET/POST/PUT/DELETE /api/v1/ans-proxy/a2a/...
GET                  /api/v1/ans-proxy/billing/usage ?days=30
GET/POST/PUT/DELETE  /api/v1/ans-proxy/auth/api-keys/...
GET                  /api/v1/ans-proxy/health
```

## SSE 事件类型

通过 `GET /api/v1/admin/events?token=<jwt>` 订阅，事件类型：

| 事件                     | 说明            |
| ------------------------ | --------------- |
| `task.status`            | 任务状态变更    |
| `task.conversation`      | 新增对话消息    |
| `project.status`         | 项目状态变更    |
| `im.message`             | IM新消息        |
| `deliverable.created`    | 产出物创建      |
| `deliverable.registered` | 产出物注册到ANS |
| `channel.status`         | 渠道状态变更    |
