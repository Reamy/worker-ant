# API 文档

> **现行形态（2026-10-24）**：**Electron 桌面端（引擎在 main 进程内）+ ANS（`:27183`）**。
> 桌面端**不暴露 HTTP API**；桌面与 ANS 之间是进程内的 `ans-client` 调用。
> 本文只描述 ANS 的 HTTP 接口。旧的 `worker-ant-server`（`:9411`）已于 2026-08-08 归档到
> `apps/_archive/`，其接口不再提供，本文不再列出。

## 认证

ANS 使用 **HMAC-SHA256** 签名认证（不是 JWT）。`packages/ans-client` 每次请求自动带上：

```
X-Api-Key:   <api key>
X-Timestamp: <毫秒时间戳>
X-Signature: HMAC-SHA256(secret, timestamp + body)
```

时间戳超出窗口的请求会被拒。除健康检查与 Swagger 外，下文的资源管理与网关接口都需要签名。

Swagger: `http://localhost:27183/docs`

### 健康检查

```
GET /api/v1/health
→ { status: "ok", timestamp: "..." }
```

## AI 模型管理

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

POST   /api/v1/models/optimal            # 最优匹配
       { strategy?, capabilities?, maxCostPer1k?, preferredProvider?, minContextWindow? }
```

## 技能 / MCP / A2A

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

## AI Gateway

```
GET  /api/v1/gateway/providers
POST /api/v1/gateway/chat
     { messages, strategy?, capabilities?, maxCostPer1k?, preferredProvider?, project_id? }
```

Gateway 与 `/models/optimal` 使用**同一把上下文尺**：`minContextWindow` 在两处都生效，不会因走网关而绕过。

## 计费

```
GET  /api/v1/billing/records             # ?project_id= &days=30
POST /api/v1/billing/records             # 写入记录
GET  /api/v1/billing/usage               # 按模型统计 ?days=30
GET  /api/v1/billing/usage/by-project    # 按项目统计
```

## API Key 管理

```
GET    /api/v1/auth/api-keys             # 列表
POST   /api/v1/auth/api-keys             # 创建 { name?, resource_groups? } → { api_key, secret }
PUT    /api/v1/auth/api-keys/:prefix     # 更新资源组 { resource_groups }
DELETE /api/v1/auth/api-keys/:prefix     # 吊销
```

## 节点 / 权益 / 团队

```
# 节点注册/心跳/列表/改档/请求分派/令牌台 —— HMAC
POST   /api/v1/nodes/register
POST   /api/v1/nodes/heartbeat
GET    /api/v1/nodes
DELETE /api/v1/nodes/:nodeId
GET    /api/v1/nodes/requests
POST   /api/v1/nodes/requests
GET    /api/v1/nodes/requests/:id
GET    /api/v1/nodes/enrollment-tokens
POST   /api/v1/nodes/enrollment-tokens
DELETE /api/v1/nodes/enrollment-tokens/:token

# 云端权益（只读，桌面启动时有界拉取，失败 fail-open）
GET    /api/v1/entitlements

# 团队共享库：读任何调用方；写/删只认节点凭据
GET    /api/v1/team/items
POST   /api/v1/team/items
DELETE /api/v1/team/items/:id
```

具体字段以 `http://localhost:27183/docs` 的 Swagger 为准，或以源码
`apps/ans-server/src/routes/` 为准。
