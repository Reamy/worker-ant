# 工蚁系统操作使用说明

> ⚠️ **文档状态（2026-10-05）**：本文描述的是 **2026-08-08 已归档**的「三服务（:9410 Web / :9411 Server / :3001 ANS）」形态。该形态现位于 `apps/_archive/`（**勿改勿跑**）。**现行形态是 Electron 桌面端**（引擎运行在 main 进程内，GUI 为内嵌 renderer，经 IPC 驱动），加 ANS（默认 `:27183`，可自动拉起）。以源码为准；下文端口表与启动步骤已过期，仅作历史参考。

## 目录

1. [概述](#概述)
2. [安装与启动](#安装与启动)
3. [登录与认证](#登录与认证)
4. [AI资源管理](#ai资源管理)
5. [项目管理](#项目管理)
6. [任务管理](#任务管理)
7. [IM渠道管理](#im渠道管理)
8. [运维看板](#运维看板)
9. [用户管理](#用户管理)
10. [API Key 管理](#api-key-管理)
11. [技能管理](#技能管理)
12. [策略配置](#策略配置)
13. [Docker 部署](#docker-部署)

## 概述

工蚁系统是一个AI资源管理与任务执行平台，提供AI模型的统一网关、项目/任务的Agent驱动执行、多渠道IM集成等功能。系统由三个微服务组成：

| 服务              | 端口 | 说明                |
| ----------------- | ---- | ------------------- |
| ANS Server        | 3001 | AI资源中心与网关    |
| Worker Ant Server | 9411 | 核心后端与Agent引擎 |
| Web UI            | 9410 | 前端管理界面        |

## 安装与启动

### 环境要求

- Node.js ≥ 22.21.1
- pnpm ≥ 9

### 开发环境

```bash
# 1. 进入项目目录
cd worker-ant

# 2. 安装依赖
pnpm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，参考下方配置说明

# 4. 启动全部服务
pnpm dev
```

### 环境变量配置

`.env` 文件核心配置：

```bash
# ANS Server
ANS_ENCRYPTION_KEY=<64位hex密钥>      # 必填: openssl rand -hex 32
ANS_API_KEYS=dev-key:dev-secret        # API Key对，生产环境更换

# Worker Ant Server
WA_JWT_SECRET=<任意随机字符串>          # 必填: JWT签名密钥

# OAuth (可选)
AUTH_GITHUB_ID=<GitHub Client ID>
AUTH_GITHUB_SECRET=<GitHub Client Secret>
AUTH_GOOGLE_ID=<Google Client ID>
AUTH_GOOGLE_SECRET=<Google Client Secret>
```

### 单独启动

```bash
pnpm dev:ans      # ANS Server only
pnpm dev:server   # Worker Ant Server only
pnpm dev:web      # Frontend only
```

### 桌面端启动

工蚁系统支持 Electron 桌面应用，提供系统托盘、原生通知、safeStorage 加密存储等特性。

```bash
# 完整桌面开发（构建server + 启动web + 启动Electron）
pnpm desktop:dev:full

# 或分步启动：
pnpm dev:server          # 1. 启动后端
pnpm dev:web             # 2. 启动前端
pnpm desktop:dev         # 3. 启动Electron壳
```

桌面端首次启动后，系统托盘会出现工蚁图标：

- **左键点击**：显示/隐藏主窗口
- **右键菜单**：显示主窗口 / 退出工蚁
- **关闭窗口**：最小化到托盘（不退出）

桌面端 OAuth 登录通过系统浏览器 + `worker-ant://` 自定义协议完成，无需在应用内输入密码。

### 健康检查

```bash
curl http://localhost:3001/api/v1/health    # ANS Server
curl http://localhost:9411/api/v1/admin/health  # Worker Ant Server
```

## 登录与认证

### 默认管理员

首次启动自动创建：

- 邮箱：`admin@worker-ant.local`
- 密码：`admin123`
- 角色：`super_admin`

> 生产环境请立即修改默认密码。

### 登录方式

1. **邮箱登录**：在 `/login` 输入邮箱和密码
2. **GitHub OAuth**：配置 `AUTH_GITHUB_ID` 和 `AUTH_GITHUB_SECRET` 后可用
3. **Google OAuth**：配置 `AUTH_GOOGLE_ID` 和 `AUTH_GOOGLE_SECRET` 后可用

### 角色权限

| 角色          | 权限                       |
| ------------- | -------------------------- |
| `super_admin` | 全部权限，包括修改用户角色 |
| `admin`       | 管理项目、任务、资源       |
| `developer`   | 创建和管理自己的项目/任务  |
| `viewer`      | 只读查看                   |

## AI资源管理

### 供应商管理（/models）

供应商代表AI服务提供商（如 OpenAI、Anthropic）。

**添加供应商：**

1. 进入「AI模型」页面
2. 点击「添加供应商」
3. 填写供应商名称和 API Base URL
4. 保存

### 模型管理

**添加模型：**

1. 在供应商下点击「添加模型」
2. 填写模型信息：
   - 模型ID（如 `gpt-4o`）
   - 模型名称
   - 能力标签（chat/embedding/vision/function-calling/image-generation/audio）
   - 上下文窗口大小（如 128000）
   - 最大输出 Tokens
   - 输入/输出价格（每千 tokens）
3. 保存

### 端点管理

每个模型可配置多个端点，支持主备和负载均衡。

**添加端点：**

1. 展开模型，点击「添加端点」
2. 填写 API URL 和 API Key
3. 设置优先级和权重
4. 保存

### 网关匹配策略

系统根据任务需求自动选择最优模型：

- **最低成本** — 价格优先
- **最低延迟** — 响应速度优先
- **最佳能力** — 匹配度优先
- **均衡** — 综合评分

降级链路：首选 → 同供应商备选 → 跨供应商备选。

### MCP 服务（/mcp）

注册 Model Context Protocol 服务供 Agent 调用。

**添加 MCP 服务：**

1. 进入「MCP 服务」页面
2. 点击「添加」
3. 填写服务名称、端点URL、传输类型（stdio/streamable-http）
4. 如需认证，填写认证配置
5. 保存（系统会自动探测工具清单）

### A2A 服务（/a2a）

注册 Agent-to-Agent 服务实现代理间协作。

**添加 A2A 服务：**

1. 进入「A2A 服务」页面
2. 点击「添加」
3. 填写服务名称和 Agent Card URL
4. 保存

### 技能注册（/skills）

注册可被 Agent 调用的技能模块。内置技能包括 `code_review` 和 `security_check`。

## 项目管理

### 创建项目（/projects）

1. 进入「项目管理」页面
2. 点击「新建项目」
3. 填写项目信息：
   - **名称**：项目名称
   - **描述**：项目说明
   - **定时调度**：cron 表达式（可选），如 `0 */6 * * *` 每6小时执行
   - **工作目录**：Agent 执行时的根目录（可选）
4. 保存

### 项目状态

| 状态        | 说明                 |
| ----------- | -------------------- |
| `active`    | 活跃，调度器正常运行 |
| `paused`    | 暂停，停止新任务调度 |
| `completed` | 完成，项目归档       |
| `archived`  | 归档，只读           |

通过状态按钮进行状态流转：启动 → 暂停 → 完成 → 归档。

### 克隆项目

克隆项目会复制项目的所有任务结构（任务状态重置为 pending），适合快速创建相似项目。

### 项目健康评分

系统自动评估项目健康度（活性30% + 产出25% + 成功率25% + 时效20%）：

- ≥70分：健康（绿色）
- 40-69分：需关注（黄色）
- <40分：异常（红色）

## 任务管理

### 创建任务（/tasks）

1. 进入「任务管理」页面
2. 选择目标项目
3. 点击「新建任务」
4. 填写任务信息：
   - **标题**：任务名称
   - **描述**：详细说明（支持 Markdown）
   - **优先级**：普通(0)、高(1)、紧急(2)
   - **父任务**：设为子任务时可选择父任务
5. 保存

> **约束：** 父子嵌套最多5层，每个父任务最多5个子任务，每个项目最多30个并发活跃任务。

### 任务状态

| 状态        | 说明                   |
| ----------- | ---------------------- |
| `pending`   | 待执行                 |
| `planning`  | Agent 正在规划         |
| `preparing` | Agent 正在准备上下文   |
| `executing` | Agent 正在执行工具调用 |
| `completed` | 已完成                 |
| `failed`    | 执行失败               |
| `paused`    | 暂停等待输入           |

### 会话恢复

当任务处于 `paused` 状态时（如 Agent 需要用户反馈），可通过「恢复」按钮发送回复继续执行。

### 任务模板

系统内置三种任务模板：

- **可行性分析** — 评估技术方案的可行性
- **代码开发** — 编写和修改代码
- **文档编写** — 撰写技术文档

### Agent 工具清单

Agent 可调用以下工具：

| 类别     | 工具                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 信息获取 | `get_current_time`、`search_web`、`get_project_info`、`task_get`、`list_project_tasks` |
| 项目管理 | `create_task`、`update_task_status`                                                    |
| 记忆     | `search_project_memory`、`save_memory`、`update_memory`、`merge_memories`              |
| 文件操作 | `write_file`、`git_clone`、`bash`（只读白名单）                                        |
| 模型选择 | `find_best_model`、`find_mcp_service`                                                  |
| 产出物   | `create_deliverable`、`register_deliverable`                                           |
| 协作     | `send_message_to_task`、`spawn_debate`、`decide`、`recruit_swarm`                      |
| 偏好     | `remember_preference`、`list_my_preferences`、`forget_preference`                      |

### 安全机制

- 5级权限分类：只读 → 工作区写入 → 危险写入 → 提示 → 允许
- 危险代码检测：15种 shell/SQL/密钥模式
- 熔断器：连续3次相同调用自动阻断
- 并发限制：每项目5并发、每分钟20任务

## IM渠道管理

### 支持的平台（/im）

| 平台       | 类型标识          |
| ---------- | ----------------- |
| 微信个人号 | `wechat-personal` |
| QQ         | `qq`              |
| 飞书       | `feishu`          |
| 钉钉       | `dingtalk`        |
| 企业微信   | `wecom`           |

### 添加渠道

1. 进入「IM渠道」页面
2. 点击「添加渠道」
3. 选择渠道类型
4. 填写渠道名称和配置
5. 保存

### 启动渠道

渠道保存后状态为「未启动」，点击「启动」按钮：

- **微信**：显示二维码，手机扫码登录
- **其他平台**：根据配置自动连接

### 渠道诊断

点击「诊断」按钮检测渠道连接状态，包括配置验证、网络连通性、认证有效性等。

### 意图识别

IM 消息自动识别用户意图：

- **创建项目** — 自动创建新项目
- **查询状态** — 查询项目/任务进展
- **通用对话** — 由 Agent 处理

## 运维看板

### 仪表盘（/admin）

- **指标卡片**：项目数、任务总数、进行中任务、记忆条数
- **模型调用统计**：近30天Token使用量柱状图
- **费用分布**：按模型统计费用占比饼图
- **使用趋势**：近7天Token与成本变化面积图
- **项目健康报告**：各项目活性、任务完成率、健康评分
- **Agent 工作量**：总执行次数、总Token消耗、总费用

### 实时事件

仪表盘通过 SSE 实时显示任务状态变更、项目状态变更、渠道事件等。

### 产出物管理（/deliverables）

查看和管理项目的产出物（MCP服务、A2A服务、UI界面、文档等）。产出物可注册到 ANS 系统，支持启动/停止MCP和A2A运行时。

## 用户管理

### 用户列表（/users）

查看所有注册用户，包括邮箱、名称、角色、认证方式、注册时间。

### 修改角色（仅 super_admin）

1. 进入「用户管理」页面
2. 找到目标用户
3. 通过 API 修改角色：
   ```bash
   curl -X PUT http://localhost:9411/api/v1/auth/users/<用户ID>/role \
     -H "Authorization: Bearer <your-token>" \
     -H "Content-Type: application/json" \
     -d '{"role": "admin"}'
   ```

### 偏好设置（/preferences）

查看 Agent 记录的用户偏好，可删除不需要的偏好。

## API Key 管理

### 创建 API Key（/api-keys）

用于外部服务以编程方式访问 ANS 网关。

1. 进入「API Keys」页面
2. 点击「创建 API Key」
3. 填写名称和资源组
4. 保存后**立即复制密钥**（仅此一次可见）

### 管理 API Key

- **资源组绑定**：限制 Key 可访问的资源范围
- **吊销**：立即撤销 Key 的访问权限

## 策略配置

系统支持通过 YAML 文件定义自动化策略。在项目根目录创建 `data/policies.yml`：

```yaml
# 示例：成本限制策略
- name: cost-limit
  type: cost_control
  config:
    max_daily_cost: 10.0 # 每日最高费用(美元)
    max_task_cost: 2.0 # 单任务最高费用
    action: pause_project # 超限操作: pause_project | notify

# 示例：错误率熔断
- name: error-circuit-breaker
  type: circuit_breaker
  config:
    error_rate_threshold: 0.5 # 错误率阈值
    window_minutes: 30 # 统计窗口
    cooldown_minutes: 60 # 熔断冷却时间
```

策略文件每30秒自动重新加载。

## Docker 部署

```bash
# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

### 数据持久化

`data/` 目录包含 SQLite 数据库文件：

- `ans-server.db` — AI资源数据
- `worker-ant-server.db` — 用户、项目、任务数据

备份只需在服务空闲时复制这两个文件即可。

### 数据库重置

```bash
rm data/ans-server.db data/worker-ant-server.db
pnpm dev    # 重启自动创建新数据库
```
