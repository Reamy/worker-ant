# 工蚁系统部署指南

> ⚠️ **文档状态（2026-10-05）**：本文的「三服务 / Docker 三容器（:9410 / :9411 / :3001）」描述的是 **2026-08-08 已归档**的旧形态（现位于 `apps/_archive/`，**勿改勿跑**）。**现行形态**：Electron 桌面端（引擎在 main 进程内）+ ANS（默认 `:27183`）。桌面包用 `electron-builder` 出 dmg/nsis（见 `apps/worker-ant-desktop/run.sh` 与 `electron-builder.yml`）。下文端口与服务清单已过期，仅作历史参考。

## 环境要求

| 依赖          | 版本      |
| ------------- | --------- |
| Node.js       | v22.21.1+ |
| pnpm          | 9.x+      |
| Docker (可选) | 24+       |

## 快速启动

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，至少设置:
#   ANS_ENCRYPTION_KEY=<64位hex>   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   WA_JWT_SECRET=<随机字符串>

# 3. 启动所有服务（开发模式）
pnpm dev
# ANS服务端 → http://localhost:3001
# 工蚁后端   → http://localhost:9411
# 工蚁前端   → http://localhost:9410
```

## Docker 部署

```bash
# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down

# 数据持久化: 使用 docker volumes (ans-data, waserver-data)
```

## 配置项

### 必填

| 变量                 | 说明                     | 示例                      |
| -------------------- | ------------------------ | ------------------------- |
| `ANS_ENCRYPTION_KEY` | AES-256加密密钥(64位hex) | `openssl rand -hex 32`    |
| `WA_JWT_SECRET`      | JWT签名密钥              | `openssl rand -base64 32` |

### 可选

| 变量                    | 说明                          | 默认值             |
| ----------------------- | ----------------------------- | ------------------ |
| `ANS_SERVER_PORT`       | ANS端口                       | 3001               |
| `WA_SERVER_PORT`        | 工蚁后端端口                  | 9411               |
| `ANS_API_KEYS`          | API密钥对(key:secret逗号分隔) | dev-key:dev-secret |
| `AUTH_SECRET`           | Auth.js密钥                   | —                  |
| `AUTH_GITHUB_ID/SECRET` | GitHub OAuth                  | —                  |

## 健康检查

```bash
# ANS
curl http://localhost:3001/api/v1/health

# 工蚁后端
curl http://localhost:9411/api/v1/admin/health

# 前端
curl http://localhost:9410
```

## 数据库备份与恢复

```bash
# 备份
cp data/ans-server.db data/backups/ans-$(date +%Y%m%d-%H%M).db
cp data/worker-ant-server.db data/backups/wa-$(date +%Y%m%d-%H%M).db

# 恢复
cp data/backups/ans-20260624-1200.db data/ans-server.db
cp data/backups/wa-20260624-1200.db data/worker-ant-server.db

# 定时备份(crontab)
# 0 * * * * cd /opt/worker-ant && ./scripts/backup.sh
```

## 桌面端打包

工蚁系统支持打包为跨平台桌面应用（macOS/Windows/Linux）。

### 前置准备

```bash
# 1. 构建所有服务
pnpm --filter @worker-ant/server build
pnpm --filter @worker-ant/web build

# 2. 构建桌面端 TypeScript
pnpm --filter @worker-ant/desktop build
```

### 本地测试（未压缩目录）

```bash
pnpm --filter @worker-ant/desktop pack
# 输出: apps/worker-ant-desktop/release/mac-arm64/
```

### 生成安装包

```bash
# macOS (需要 macOS 环境)
pnpm --filter @worker-ant/desktop dist
# 输出: apps/worker-ant-desktop/release/工蚁-0.1.0-mac-arm64.dmg

# Windows (需要 Windows 环境)
# 输出: apps/worker-ant-desktop/release/工蚁-0.1.0-win-x64.exe

# Linux
# 输出: apps/worker-ant-desktop/release/工蚁-0.1.0-linux-x64.AppImage
```

### 代码签名（可选）

- **macOS**: 需要 Apple Developer 证书 + 公证（`electron-builder.yml` 中配置 `mac.notarize`）
- **Windows**: 需要代码签名证书（`electron-builder.yml` 中配置 `win.certificateFile`）
- 本地开发可跳过签名

## 默认账户

首次启动后使用以下账户登录前端：

- 邮箱: `admin@worker-ant.local`
- 密码: `admin123`

> ⚠️ 生产环境请立即修改默认密码。

## 策略配置

在 `data/policies.yml` 中配置策略规则（参考 `policies.example.yml`），无需重启自动生效（30秒刷新）。
