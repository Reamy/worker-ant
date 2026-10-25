# 工蚁系统部署指南

> **现行形态**：Electron 桌面端（整个引擎运行在 main 进程内）+ ANS（AI 资源中心，默认 `:27183`）。
> 桌面包由 `electron-builder` 产出 dmg（配置见 `apps/worker-ant-desktop/electron-builder.yml`，启动脚本 `run.sh`）。
> 旧的「三服务 / Docker 三容器（:9410 Web / :9411 Server / :3001 ANS）」形态已于 **2026-08-08 归档**到 `apps/_archive/`，
> 不再维护；对应的 `Dockerfile` / `docker-compose.yml` 已删除。本文只描述现行形态。

## 环境要求

| 依赖          | 版本                                 |
| ------------- | ------------------------------------ |
| Node.js       | v22.21.1+                            |
| pnpm          | 9.x+                                 |
| macOS（打包） | 13+，Apple Silicon（arm64）          |
| Xcode CLT     | 提供 `codesign` / `xcrun notarytool` |

## 从源码运行

```bash
pnpm install

# 终端 1 —— 启动 ANS（:27183）。必须先起：它把 better-sqlite3 重建为 Node ABI
pnpm dev:ans

# 终端 2 —— 启动桌面端（请在 macOS Terminal.app 中运行，勿用 IDE 终端）
cd apps/worker-ant-desktop && bash run.sh
```

> 两条 ABI 互斥：`run.sh` / `desktop:dev` 会把共享的 `better-sqlite3` 重编为 Electron ABI，
> 而 ANS 需要 Node ABI。故源码态下必须先跑 `pnpm dev:ans`；桌面端的「按需代起」在 dev 下会如实失败。
> 打包版不受影响：ANS 运行时随包在 `Resources/ans-server/`，以 `ELECTRON_RUN_AS_NODE=1` 代起。

## 数据目录

- **dev**：仓库根 `data/`；**生产**：`app.getPath('userData')`（以 `main/index.ts` 顶部注释为准）。
- `data/ans-server.db` —— ANS 库；`data/worker-ant-server.db` —— 桌面工蚁主库（WAL）。
- 另有 `projects/ task_outputs/ notification_payloads/ attachments/ logs/ plugins/` 等子目录。

```bash
# 备份
cp data/ans-server.db data/backups/ans-$(date +%Y%m%d-%H%M).db
cp data/worker-ant-server.db data/backups/wa-$(date +%Y%m%d-%H%M).db

# 恢复
cp data/backups/ans-20260624-1200.db data/ans-server.db
cp data/backups/wa-20260624-1200.db data/worker-ant-server.db
```

> 跨仓库契约（勿破坏）：`NOTIFICATION_PAYLOAD_DIR=data/notification_payloads`（推送 `.txt` 落盘）；
> `data/cron_heartbeat.json`（cron 存活心跳，30 分钟阈值）。

## 桌面端打包

```bash
# 1. 构建桌面端 TypeScript（renderer 另行构建）
pnpm --filter @worker-ant/desktop build

# 2. 本地测试产物（未压缩目录，跳过公证）
pnpm --filter @worker-ant/desktop pack
# 输出: apps/worker-ant-desktop/release/mac-arm64/

# 3. 生成 macOS 安装包（走签名 + 公证）
cd apps/worker-ant-desktop && pnpm dist:mac
# 输出: release/工蚁-<version>-mac-arm64.dmg / .zip
# 上传前复制为 ASCII 文件名（如 worker-ant-0.2.2-mac-arm64.dmg）
```

打包后**必须还原 Node ABI**（否则 `pnpm dev:ans` 无法加载原生模块）：

```bash
bash scripts/rebuild-ans-native.sh
```

### 代码签名与公证（macOS 发布必做）

- `electron-builder.yml` 已写死 Developer ID 证书与 `mac.notarize: true`。
  **发布件一律走** `pnpm dist:mac`——它先跑 `scripts/require-notarize-env.mjs`，缺公证凭据直接停，
  不会产出"已签名但未公证"的包（那种包首次打开仍会被 Gatekeeper 拦，且从产物上看不出来）。
  凭据三选一（终端 export 或写进不提交的本地 `.env` 后 source）：
  ① `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`（推荐）；
  ② `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID=XRZNWLDU86`；
  ③ `xcrun notarytool store-credentials <profile> …` 后 `APPLE_KEYCHAIN_PROFILE=<profile>`。
  实测（2026-10-24，`APPLE_KEYCHAIN_PROFILE=worker-ant`）：公证提交 `023dc2ae-9428-43f1-b980-ddb37bede4ca`
  状态 `Accepted`，票据已装订；DMG/ZIP 内的应用 `spctl --assess` 均为 `accepted / Notarized Developer ID`。
  **注意：DMG 容器本身不经签名/装订**（electron-builder 默认行为），`spctl` 对 `.dmg` 文件会报
  `rejected / no usable signature`；Gatekeeper 判的是挂载后的应用，故不影响首次启动。若要连容器一并签名，
  须另行开启 `dmg.sign` 并对 DMG 单独公证。
- **Windows**：尚未配置代码签名证书，因此不发布 Windows 安装包。

### 发布到 GitHub Releases

```bash
# 产物文件名用 ASCII（避免上传/下载链路的编码问题）
gh release create v0.2.2 \
  release/worker-ant-0.2.2-mac-arm64.dmg \
  release/worker-ant-0.2.2-mac-arm64.zip \
  --repo Reamy/worker-ant \
  --title "工蚁 v0.2.2 — 修复退出残留与首启向导" \
  --notes-file <发布说明.md>
```

- 发布说明须列出 **SHA-256 校验值**与系统要求（macOS 13+ / arm64）。
- 自动更新尚未启用（`publish.provider: github` 保持注释），升级暂时靠手动下载新版本。
- 公开仓源码由 `scripts/publish-oss.ts` 从 `git archive HEAD` 导出后生成**快照提交**，
  与本地提交历史不一一对应。

## 默认账户

首次启动自动以本机所有者身份登录（无需输入密码），账本如下（亦可用作兜底登录）：

- 邮箱: `admin@worker-ant.local`
- 密码: `admin123`

设置自己的密码或新增第二位用户后，自动登录永久失效，改用邮箱+密码登录。

> ⚠️ 生产环境请立即修改默认密码。

## 策略配置

策略引擎的内置默认规则是唯一真源（见 `apps/worker-ant-desktop/src/main/core/policy-engine.ts`）。
根目录的 `policies.example.yml` 是归档前旧形态的示例，运行时**不再读取**。
