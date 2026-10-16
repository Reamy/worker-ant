# IM渠道配置指南

## 概述

工蚁系统支持5个IM渠道：微信个人号(iLink)、QQ、飞书、钉钉、企业微信。所有渠道适配器代码已完整实现，只需在对应开放平台获取凭证后填入即可使用。

---

## 飞书 (Feishu)

### 1. 创建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 创建企业自建应用 → 填写名称"工蚁助手"
3. 获取 **App ID** 和 **App Secret**（「应用凭证」页面）

### 2. 开通权限

在「权限管理」中开通：

- `im:message` — 接收/发送消息
- `im:message:send_as_bot` — 以机器人身份发送

### 3. 配置事件订阅

在「事件订阅」中：

- 打开「长连接模式」开关
- 订阅事件：`im.message.receive_v1`（接收消息）
- 获取 **Encrypt Key**（可选）和 **Verification Token**（可选）

### 4. 在工蚁中配置

在工蚁前端「IM渠道管理」页面：

- 渠道类型：飞书
- App ID: `cli_xxx...`
- App Secret: `xxx...`
- Encrypt Key: `xxx...`（可选）
- Verification Token: `xxx...`（可选）

### 5. 技术说明

- 传输方式：WebSocket 长连接（无需公网IP）
- SDK：`@larksuiteoapi/node-sdk`
- 自动重连：指数退避（1s → 30s）
- 入站消息：`im.message.receive_v1` 事件（仅文本）
- 外发消息：`im.message.create` API（chat_id 路由）

---

## 钉钉 (Dingtalk)

### 1. 创建应用

1. 访问 [钉钉开放平台](https://open.dingtalk.com)
2. 创建企业内部应用 → 填写名称"工蚁助手"
3. 获取 **AppKey** 和 **AppSecret**（「凭证与基础信息」页面）

### 2. 开通权限

在「权限管理」中开通：

- `Robot.Message.Send` — 机器人发送消息
- 企业内机器人发送消息权限

### 3. 配置 Outgoing Robot（入站消息）

在「机器人」→「Outgoing机制」中：

- 设置回调地址：`https://<你的服务器>/api/v1/im/webhook/dingtalk`
- 注意：Outgoing机制仅支持群聊场景

### 4. 在工蚁中配置

在工蚁前端「IM渠道管理」页面：

- 渠道类型：钉钉
- App ID: AppKey
- App Secret: AppSecret

### 5. 技术说明

- 外发：Robot API（`oToMessages/batchSend`）
- 入站：Outgoing Robot Webhook 回调
- Session Webhook：缓存15分钟，支持自动回复
- Token管理：AccessToken自动刷新（2小时+提前1分钟刷新）
- 不支持单聊入站（钉钉限制）

---

## 企业微信 (Wecom)

### 1. 创建应用

1. 访问 [企业微信管理后台](https://work.weixin.qq.com)
2. 应用管理 → 创建应用 → 填写名称"工蚁助手"
3. 获取 **CorpID**（「我的企业」页面）
4. 获取 **AgentID** 和 **Secret**（应用详情页）

### 2. 配置接收消息

在应用详情「接收消息」中：

- 设置回调URL：`https://<你的服务器>/api/v1/im/webhook/wecom`
- 设置 **Token**（自定义，3-32字符）
- 设置 **EncodingAESKey**（随机生成43字符）
- 注意：需要公网服务器（企业微信会验证回调URL）

### 3. 在工蚁中配置

在工蚁前端「IM渠道管理」页面：

- 渠道类型：企业微信
- Corp ID: `wwxxx...`
- Agent ID: `100000x`
- App Secret: `xxx...`
- Token: 回调Token
- Encoding AES Key: 回调EncodingAESKey

### 4. 技术说明

- 外发：应用消息API（`message/send`）
- 入站：HTTP Webhook回调（支持加密XML + AES-256-CBC解密）
- 文件格式：JSON明文模式 + XML加密模式
- Token管理：AccessToken自动刷新（2小时+提前1分钟刷新）

---

## 微信个人号 (Wechat) — 已配置

### 技术说明

- 使用iLink Bot API (`ilinkai.weixin.qq.com`)
- HTTP长轮询 + QR码登录
- 支持文本消息收发
- 参考 `apps/worker-ant-server/src/services/im/wechat.ts`

---

## QQ — 已配置

### 技术说明

- 使用QQ开放平台 WebSocket + REST API
- AppID + AppSecret → Access Token
- 参考 `apps/worker-ant-server/src/services/im/qq.ts`

---

## 通用说明

### 架构

所有IM渠道通过统一的 `ImChannel` 接口适配，在 `ImAdapterManager` 中管理：

- `start(config)` — 启动渠道
- `stop()` — 停止渠道
- `send(envelope, payload)` — 发送消息
- `onMessage(callback)` — 注册消息回调
- `diagnose()` — 诊断检查
- `ping()` — 健康探测

### 诊断

在工蚁前端「IM渠道管理」页面，可以点击「诊断」按钮检查每个渠道的：

- 配置完整性（凭证是否配置）
- API连通性（Token是否能获取）
- 连接状态（WebSocket/Webhook是否在线）

### 消息流程

```
用户消息 → IM渠道适配器接收 → 意图分类(LLM) → 查找项目/任务
→ 创建或恢复任务 → Agent引擎执行 → IM渠道回复
```
