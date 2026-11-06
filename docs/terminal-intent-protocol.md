# 外部 AI 终端接入协议（推荐：意图两跳）

本文写给**门外那台 AI 终端**的开发者：工蚁开了一道局域网小门，终端可以在这里读设备清单、
把一句话落成动作。**推荐走「意图两跳」**——终端只负责把自然语言解成结构化意图，
由工蚁本机解析、过安全闸、逐条执行；终端不直接碰设备。

> 真源在代码里，本文所有形状都照实现抄录：
> `apps/worker-ant-desktop/src/main/core/inbound-gate.ts`（路由）、
> `external-calls.ts`（能力面与错误码）、`intent-protocol.ts`（意图词表）、
> `external-terminals.ts`（配对与凭据）。若本文与代码不一致，以代码为准并提 issue。

## 0. 前提与围栏

- 工蚁桌面端「协同面板 → 门」已开启入站门，默认监听 `http://<工蚁局域网地址>:27184`
  （`WA_INBOUND_PORT` 可改）。门只在 **Team 档/试用期**可开。
- **只认私网对端**：`127/8`、`::1`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、
  `fe80::/10`、`fc00::/7`（含 IPv4-mapped IPv6）。其余一律 `403 {"error":"forbidden"}`。
- 未配对前只能用门牌与配对两跳；配对并获批后，才能访问 `/api/v1/*` 能力面。
- 凭据形如 `Bearer <key>.<secret>`。**明文只在 `pair/status` 首次轮询时回一次**，
  库中只存 `key_prefix` 与 secret 的哈希；丢了只能请主人在桌面「重新签发」或吊销重配。

## 1. 首次接入：发现 → 配对 → 凭据

### 1.1 读门牌（免凭据）

```http
GET /.well-known/agent.json
GET /.well-known/agent-card.json   # 两个路径回同一份门牌
```

门牌含节点名、版本、入口 URL、可用的意图词表与**设备类目计数**（只有类目，没有设备实例）。

### 1.2 申请配对

```http
POST /api/v1/pair/request
Content-Type: application/json

{ "name": "书房的派单机" }
```

成功 `200`：

```json
{ "pairing_id": "9f0c…", "pair_code": "482913" }
```

同一来源地址同时最多挂 3 条待批；超了如实回 `429 {"error":"too_many_pending"}`。

工蚁主人在桌面面板或 IM 里看到申请（IM 回执会写明将授予的能力类目与撤销去处）。
**默认只授予「意图控制」**；原始设备控制、任务请求须主人在桌面显式勾选。

### 1.3 轮询取凭据

```http
GET /api/v1/pair/status?pairing_id=9f0c…&pair_code=482913
```

四态：

```json
{ "status": "pending" }
{ "status": "rejected" }
{ "status": "revoked" }
{ "status": "approved", "credentials": { "key": "wa_term_…", "secret": "…" } }
```

- `approved` **首次**带 `credentials`，此后只回 `{"status":"approved"}`（`delivered_at` 已落）。
- 进程重启后明文丢失 ⇒ 回 `{"status":"approved","note":"credentials_lost"}`，
  须请主人在桌面点「重新签发」（旧钥匙立即作废），或吊销后重新配对。
- 授权默认 90 天到期，到期后凭据校验回 `403 {"error":"not_approved:…"}` / `grant_expired`。

## 2. 推荐路径：意图两跳

一句话：**终端做 NLU，工蚁做执行**。

### 2.1 先看能力面（只读自省）

```http
GET /api/v1/capabilities
Authorization: Bearer <key>.<secret>
```

`200`：

```json
{
  "terminal_id": "9f0c…",
  "capabilities": ["intent_control"],
  "intents": [
    {
      "id": "home.comfort",
      "label": "…",
      "params": [
        { "key": "room", "label": "…", "required": true },
        { "key": "feeling", "label": "…", "required": true, "values": ["hot", "cold", "dark", "bright"] }
      ]
    }
  ],
  "rooms": ["客厅", "书房"],
  "devices": [
    {
      "call_name": "客厅窗帘",
      "kind": "cover",
      "kind_class": "curtain",
      "room": "客厅",
      "actions": ["close", "open"]
    }
  ]
}
```

- `capabilities` ＝ **词表白名单 ∩ 该终端获批**，未批准的不列。
- `devices` 刻意只给五样：`call_name` / `kind` / `kind_class` / `room` / `actions`。
  **不给**网络地址、端口、协议、授权态、在线态（罗尔斯·无知之幕）。
- `call_name` 是"主人怎么叫它"（别名优先，回退自述名），执行时按它指定设备。
- `kind_class` 已归一（`curtain` / `aircon` / `light` / `fan` / …），建议按类目而不是按 `kind` 原词做判断。

### 2.2 第一跳：解析意图 → 计划（零设备动作）

```http
POST /api/v1/intent/resolve
Authorization: Bearer <key>.<secret>
Content-Type: application/json

{
  "intent": "home.comfort",
  "params": { "room": "客厅", "feeling": "hot" },
  "utterance": "客厅有点热"
}
```

- `intent` / `params` 走词表校验；`utterance` 只进留痕账，**不参与解析**（可省略）。
- 成功 `200`：

```json
{
  "planId": "6b1d…",
  "expiresIn": 120,
  "steps": [{ "call_name": "客厅窗帘", "action": "close", "reason": "室温偏高：先关窗帘，减少阳光直射进来的热量。" }],
  "skipped": [],
  "source": "rule"
}
```

- `steps` 是**有序**的设备动作；`source` 为 `rule`（确定性规则）或 `model`（规则排不出时模型补的，仍会再过安全闸）。
- `skipped` 如实列"相关但没做"的设备与原因（未授权 / 不可控 / 高危 / 不在可执行清单）。
- 计划 **120 秒**（`INTENT_PLAN_TTL_SEC`）内有效，过期须重新 resolve。
- 解析**绝不碰设备**：设备动作账仍为 0 行。

- 失败 `409`（设备/房间层面排不出）：

```json
{ "error": "no_controllable_device", "skipped": [], "message": "…给用户看的下一步…" }
```

其他常见 `error`：`no_recognized_kind`、`room_unassigned`、`needs_clarification`（带 `candidates`）。

- 参数不合词表 `400`：

```json
{ "error": "invalid_params", "allowed": ["home.comfort"], "errors": ["…逐条原因…"] }
```

- 未授予 `intent_control`：`403 {"error":"capability_not_granted","capability":"intent_control"}`。
- 本机解析器不可用：`503 {"error":"intent_resolver_unavailable"}`。

### 2.3 第二跳：执行计划（只执行一次）

```http
POST /api/v1/intent/execute
Authorization: Bearer <key>.<secret>
Content-Type: application/json

{ "planId": "6b1d…" }
```

成功 `200`：

```json
{
  "planId": "6b1d…",
  "status": "executed",
  "steps": [{ "call_name": "客厅窗帘", "action": "close", "ok": true, "result": "…" }]
}
```

- `status` 为 `executed`（全部步骤成功）或 `failed`（任一步失败，**不回滚**已执行步骤，逐条如实回）。
- 计划由终端认领执行：**同一计划只能执行一次**（`wa_intent_plans` 上 `planned → executing → executed/failed`）。
- 失败 `409`：`plan_id_required`（400）/ `plan_not_found` / `plan_expired` / `plan_already_executed` / `plan_executing`；
  别人的计划执行回 `403 {"error":"plan_not_yours"}`。
- 每一跳（包括被拒）都落 `wa_external_calls`；真正执行时每一步落 `wa_device_actions`
  （含 `actor_kind='external'`、`actor_ref=<terminal_id>`、`plan_id`）。

## 3. 备选一：原始 `/invoke`（需显式勾选 `device_control`）

若终端自己做决策、只想让工蚁当"手"，可走 `/invoke`：

```http
POST /api/v1/invoke
Authorization: Bearer <key>.<secret>
Content-Type: application/json

{
  "capability": "device_control",
  "args": { "name": "客厅窗帘", "action": "close", "args": {} }
}
```

成功 `200`：`{ "ok": true, "capability": "device_control", "result": "…" }`。
被安全闸拒：`403 { "ok": false, "capability": "device_control", "error": "not_authorized", "how_to_authorize": "…" }`。

前提与边界：

- 该终端必须被主人**显式勾选** `device_control`（默认只给 `intent_control`）。
- `intent_control` **不可**经 `/invoke` 直调，回 `403 {"error":"capability_not_invocable"}`——
  否则"默认授予的意图能力"就成了绕过原始动作授权的后门。
- 同样受 K-6 安全闸：设备须在台账、可控、已授权、非高危。
- `task_request` 亦经 `/invoke`（`args: { prompt, acceptanceCriteria }`），同一终端同时只允许 1 件在途。

## 4. 备选二：只读自省

只需了解环境、不想动手时，只调 `GET /api/v1/capabilities`（见 2.1）。
它不写计划、不写设备动作，是最小权限的接入方式。

## 5. 错误码速查

| HTTP | error                                                       | 含义 / 下一步                               |
| ---- | ----------------------------------------------------------- | ------------------------------------------- |
| 403  | `forbidden`                                                 | 对端不是私网地址（门先认街坊）              |
| 401  | `missing_credentials` / `unknown_key` / `bad_secret`        | 凭据缺失或不符；检查 `key.secret`           |
| 403  | `not_approved:<state>`                                      | 终端未批准/已拒/已吊销                      |
| 403  | `grant_expired`                                             | 授权到期，请主人重新批准                    |
| 403  | `capability_not_granted`                                    | 这项能力没获批（默认只有 `intent_control`） |
| 403  | `capability_not_allowed` / `capability_not_invocable`       | 能力名不在白名单 / 不能经 `/invoke` 直调    |
| 400  | `invalid_params` / `unknown_intent`                         | 意图/参数不合词表；看 `allowed` 与 `errors` |
| 409  | `no_controllable_device` 等                                 | 排不出计划；看 `skipped` 与 `message`       |
| 409  | `plan_expired` / `plan_already_executed` / `plan_executing` | 计划过期或已被执行；重新 resolve            |
| 403  | `plan_not_yours`                                            | 不能执行别人的计划                          |
| 403  | `team_required`                                             | 工蚁当前档位未解锁团队版能力                |
| 429  | `too_many_pending` / `busy`                                 | 待批申请超上限 / 该终端已有任务在途         |

## 6. 安全与留痕（请终端开发者知悉）

- **发现 ≠ 授权**：局域网广播只进主人面板的待接入列表，30 秒无广播即消失；点「接入」才走配对。
- **批准 ≠ 终身**：默认 90 天到期；主人可随时在「协同面板」撤销，撤销后凭据**立即**失效。
- **最小可见**：能力面不暴露网络坐标与授权态；设备动作账与外部调用账都在主人那边可见（被拒也留痕）。
- **意图优先**：建议优先走意图两跳——终端不必知道每台设备的协议细节，安全判断留在工蚁本机。
