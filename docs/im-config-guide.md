# IM 渠道配置指南

> 适用形态（2026-10-24）：Electron 桌面端。适配器位于
> `apps/worker-ant-desktop/src/main/services/`，渠道配置页为渲染层 `/im`（`IMPage.tsx`）。
> 字段名与页面**逐字一致**；能力边界（入站 / 出站）以适配器实现为准。

## 概述

工蚁桌面端支持 5 个 IM 渠道：微信个人号（iLink）、QQ、飞书、钉钉、企业微信。

| 平台       | 类型标识          | 入站 | 出站 | 传输方式                     |
| ---------- | ----------------- | ---- | ---- | ---------------------------- |
| 微信个人号 | `wechat-personal` | ✅   | ✅   | iLink HTTP 长轮询 + 扫码登录 |
| QQ         | `qqbot`           | ✅   | ✅   | Gateway WebSocket 长连接     |
| 飞书       | `feishu`          | ✅   | ✅   | WebSocket 长连接             |
| 钉钉       | `dingtalk`        | ✅   | ✅   | Stream 长连接                |
| 企业微信   | `wecom`           | ❌   | ✅   | 仅出站（应用消息 API）       |

> 飞书 / 钉钉 / QQ 均为**出站长连接**，不需要公网 IP，也不需要在本机开放入站端口。
> 企业微信没有原生 WebSocket / 长轮询，桌面端也不提供公网回调服务，因此**入站未实现**。

---

## 飞书 (Feishu)

### 1. 创建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)。
2. 创建企业自建应用，填写名称（如「工蚁助手」）。
3. 在「应用凭证」页获取 **App ID** 与 **App Secret**。

### 2. 开通权限

在「权限管理」中开通：

- `im:message` —— 接收 / 发送消息
- `im:message:send_as_bot` —— 以机器人身份发送

### 3. 开启长连接

在「事件订阅」中：

- 打开「长连接模式」开关。
- 订阅事件：`im.message.receive_v1`。

### 4. 在工蚁中配置（`/im` → 添加渠道 → 飞书）

| 字段       | 填什么                  |
| ---------- | ----------------------- |
| App ID     | `cli_xxx...`            |
| App Secret | 应用凭证页的 App Secret |

### 5. 技术说明

- 传输：WebSocket 长连接（免公网 IP）。
- SDK：`@larksuiteoapi/node-sdk`。
- 自动重连：指数退避（1s → 30s）。
- 入站：`im.message.receive_v1` 事件（文本与非文本占位符）。
- 外发：消息 API，按 `chat_id` 路由；支持发图片 / 文件。

---

## 钉钉 (DingTalk)

### 1. 创建应用

1. 访问 [钉钉开放平台](https://open.dingtalk.com)。
2. 创建企业内部应用，填写名称。
3. 在「凭证与基础信息」页获取 **AppKey** 与 **AppSecret**。

### 2. 开通权限

在「权限管理」中开通机器人发送消息相关权限（如 `Robot.Message.Send`）。

### 3. 在工蚁中配置（`/im` → 添加渠道 → 钉钉）

| 字段                       | 填什么                        |
| -------------------------- | ----------------------------- |
| AppKey（Client ID）        | AppKey                        |
| AppSecret（Client Secret） | AppSecret                     |
| Robot Code（可选）         | 机器人编码；缺省回落到 AppKey |

> 桌面端使用 **Stream 长连接模式**（免公网 IP）。旧文档里的「Outgoing Robot Webhook 回调地址」
> 不适用于桌面端——本机没有公网地址，也不需要配置回调 URL。

### 4. 技术说明

- 外发：机器人消息 API。
- 入站：Stream 长连接（无需开放入站端口）。
- Token：AccessToken 自动刷新（2 小时，提前 1 分钟刷新）。
- 群聊与单聊能力受钉钉平台限制，以实际平台行为为准。

---

## 企业微信 (WeCom)

### 1. 创建应用

1. 访问 [企业微信管理后台](https://work.weixin.qq.com)。
2. 应用管理 → 创建应用，填写名称。
3. 在「我的企业」页获取 **CorpID**。
4. 在应用详情页获取 **AgentID** 与 **Secret**。

### 2. 在工蚁中配置（`/im` → 添加渠道 → 企业微信）

| 字段        | 填什么        |
| ----------- | ------------- |
| Corp ID     | `wwxxx...`    |
| Corp Secret | 应用的 Secret |
| Agent ID    | `100000x`     |

### 3. 能力边界（重要）

- **仅出站**：工蚁发出的通知 / 回执能到达企业微信；**用户回复不会进入引擎**。
- 原因：企业微信没有原生 WebSocket / 长轮询，桌面端也没有公网回调服务。
- 渠道列表会给该渠道标「仅出站」徽标；这是如实标注，不是故障。
- 需要双向对话请使用微信 / QQ / 飞书 / 钉钉。

### 4. 技术说明

- 外发：应用消息 API。
- AccessToken 自动刷新（2 小时，提前 1 分钟刷新）。
- 适配器在启动时上报状态「已启动（发送可用，接收需回调地址）」。

---

## 微信个人号 (WeChat)

### 在工蚁中配置

- 渠道类型：微信个人号。
- **无需填写凭证**：保存后点「启动」，页面显示二维码，用手机微信扫码登录。
- 二维码来自 iLink Bot API（`ilinkai.weixin.qq.com`），扫码后跳转完成登录。

### 技术说明

- 传输：HTTP 长轮询 + QR 码登录。
- 支持文本消息收发；**发文件不支持的通道不声明**（适配器未实现 `sendMedia` 时，
  上层会如实得到「本通道不支持」，而不是假成功）。
- 参考：`apps/worker-ant-desktop/src/main/services/wechat-adapter.ts`。

---

## QQ

### 在工蚁中配置（`/im` → 添加渠道 → QQ）

| 字段          | 填什么                       |
| ------------- | ---------------------------- |
| App ID        | QQ 开放平台 Bot 的 AppID     |
| Client Secret | QQ 开放平台 Bot 的 AppSecret |

### 技术说明

- 传输：QQ 开放平台 Gateway WebSocket 长连接（免公网 IP）。
- 认证：AppID + ClientSecret → Access Token。
- 参考：`apps/worker-ant-desktop/src/main/services/qqbot-adapter.ts`。

---

## 通用说明

### 适配器契约

五家适配器实现同一接口（`services/im-adapter.ts`）：

- `start()` / `stop()` —— 启停渠道。
- `getStatus()` —— 当前状态。
- `sendReply(toUser, text, contextToken?, opts?)` —— 发送回复；发送成功后由适配器写入
  `wa_im_conversations`（出站）。补发路径传 `recordConversation: false`，避免一行变两行。
- `sendMedia?(...)` —— **可选**；不声明即本通道不支持发文件（微信个人号即如此）。
- `onMessage(handler)` —— 注册入站回调，交给 IM Router。
- `getQrState?()` —— 扫码登录渠道的二维码状态（仅微信个人号）。
- `setStatusReporter?(...)` —— 运行期状态上报。

渠道实例由 `ipc/im.ipc.ts` 的 `createAdapter` 工厂创建，`activeAdapters` 管理启停。

### 诊断

渠道行上的「诊断」检查：

- 配置完整性（必填凭证是否齐备）。
- API 连通性（能否获取 Token）。
- 连接状态（长连接是否在线）。

### 入站媒体

图片 / 文件 / 语音等非文本消息会：

1. 以类型占位符进入对话（如 `[图片]`、`[文件 report.pdf 1.2MB]`）；
2. 落盘到 `data/attachments/<YYYYMMDD UTC>/<件名>`，同名追加 `-2` / `-3`，不覆盖；
3. **止步于对话**，不会被误建成任务。

### 消息流程

```
用户消息 → IM 适配器接收 → 命令分发 / 意图识别 → 建任务或恢复任务
→ Agent 引擎执行 → IM 回执 / 通知
```
