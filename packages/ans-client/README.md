# ANS Client SDK

工蚁系统 ANS (AI Navigation Service) 客户端 SDK。为工蚁端、机器人、AI终端及第三方集成方提供统一的资源获取接口。

## 安装

```bash
pnpm add @worker-ant/ans-client
```

## 快速开始

```ts
import { AnsClient } from '@worker-ant/ans-client';

const client = new AnsClient({
  serverUrl: 'http://localhost:3001',
  apiKey: 'your-api-key',
  secretKey: 'your-secret-key',
  cacheTTL: 60_000, // 可选，本地缓存TTL(毫秒)，默认60秒
});
```

## API 参考

### `getOptimalModel(req)`

获取最优AI模型端点（含备用）。

```ts
const model = await client.getOptimalModel({
  capabilities: ['chat', 'function-calling'],
  strategy: 'cost-optimal', // 'cost-optimal' | 'latency-optimal' | 'capability-best' | 'balanced'
  maxCostPer1k: 0.1,
  preferredProvider: 'openai',
});
// → { id, url, api_key_ref, model_id, ...fallback }
```

### `getOptimalSkill(req)`

获取最优技能。

```ts
const skill = await client.getOptimalSkill({
  tags: ['dev', 'review'],
  name: 'code-review', // 精确匹配（可选）
});
```

### `getOptimalMcp(req)`

获取最优 MCP 服务端点。

```ts
const mcp = await client.getOptimalMcp({
  tags: ['github'],
});
```

### `getOptimalA2A(req)`

获取最优 A2A 服务端点。

```ts
const a2a = await client.getOptimalA2A({
  capabilities: ['chat', 'code-gen'],
});
```

### `healthCheck()`

检查 ANS 服务端健康状态。

```ts
const { status, latency } = await client.healthCheck();
// → { status: 'ok', latency: 42 }
```

### `clearCache()`

清空所有本地缓存。

```ts
client.clearCache();
```

## 认证机制

ANS 客户端使用 HMAC-SHA256 签名认证：

1. 每个请求附加 `X-Api-Key`、`X-Timestamp`（毫秒时间戳）、`X-Signature` 三个头
2. 签名计算：`HMAC-SHA256(secretKey, timestamp + '\n' + body)`
3. 服务端验证时间戳在 5 分钟内，并校验签名

## 缓存策略

- 默认 TTL 60 秒，可通过 `cacheTTL` 配置
- 最多缓存 1000 条记录，超出时 LRU 淘汰
- 不同资源类型独立缓存（model/skill/mcp/a2a）

## 非 TypeScript 集成

ANS 服务端启动后自动生成 OpenAPI 3.0 规范文件，可通过以下地址获取：

```
http://localhost:3001/docs/json    # OpenAPI JSON
http://localhost:3001/docs         # Swagger UI 交互文档
```

### 使用 OpenAPI 生成客户端 SDK

```bash
# Python
openapi-generator-cli generate -i http://localhost:3001/docs/json -g python -o ./ans-client-python

# Go
openapi-generator-cli generate -i http://localhost:3001/docs/json -g go -o ./ans-client-go

# Rust
openapi-generator-cli generate -i http://localhost:3001/docs/json -g rust -o ./ans-client-rust
```

### 裸 REST API 调用

所有 ANS API 均需 HMAC-SHA256 签名认证。非 JS 环境可参考以下示例：

```bash
# 获取模型列表（需 HMAC 签名）
curl -H "X-Api-Key: your-key" \
     -H "X-Timestamp: $(date +%s000)" \
     -H "X-Signature: <hmac-sha256-hex>" \
     http://localhost:3001/api/v1/models
```

具体端点列表见 Swagger UI (`/docs`) 或 OpenAPI JSON (`/docs/json`)。

## 工具函数

```ts
import { generateApiKey, createHmacSignature, verifyHmacSignature } from '@worker-ant/ans-client';

// 生成 API Key
const apiKey = generateApiKey('wa'); // → "wa_xxxx...base64url..."

// 签名
const sig = createHmacSignature('secret', '1700000000000', 'request body');

// 验证
const valid = verifyHmacSignature('secret', '1700000000000', 'request body', sig);
```
