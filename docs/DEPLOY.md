# 工蚁系统部署指南

> **现行形态**：Electron 桌面端（整个引擎运行在 main 进程内）+ ANS（AI 资源中心，默认 `:27183`）。
> 桌面包由 `electron-builder` 产出 dmg（配置见 `apps/worker-ant-desktop/electron-builder.yml`，启动脚本 `run.sh`）。
> 旧的「三服务 / Docker 三容器（:9410 Web / :9411 Server / :3001 ANS）」形态已于 **2026-08-08 归档**到 `apps/_archive/`，
> 不再维护；对应的 `Dockerfile` / `docker-compose.yml` 已删除。本文只描述现行形态。

## 环境要求

| 依赖               | 版本                                                         |
| ------------------ | ------------------------------------------------------------ |
| Node.js            | v22.21.1+                                                    |
| pnpm               | 9.x+                                                         |
| macOS（打包）      | 13+，Apple Silicon（arm64）                                  |
| Xcode CLT          | 提供 `codesign` / `xcrun notarytool`                         |
| Windows/Linux 打包 | 在 macOS 上交叉构建（`dist:win` / `dist:linux`），产物未签名 |

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

> 目录约定：`NOTIFICATION_PAYLOAD_DIR=data/notification_payloads`（推送 `.txt` 落盘）；
> `data/cron_heartbeat.json`（cron 存活心跳，30 分钟阈值）。

## 桌面端打包

```bash
# 1. 构建桌面端 TypeScript（renderer 另行构建）
pnpm --filter @worker-ant/desktop build

# 2. 本地测试产物（未压缩目录，跳过公证）
pnpm --filter @worker-ant/desktop pack
# 输出: apps/worker-ant-desktop/release/mac-arm64/

# 3. 生成 macOS 安装包（走签名 + 公证）
cd apps/worker-ant-desktop && APPLE_KEYCHAIN_PROFILE=worker-ant pnpm dist:mac
# 输出: release/工蚁-<version>-mac-arm64.dmg / .zip

# 4. 生成 Windows 安装包（x64 NSIS，未签名）
pnpm dist:win
# 输出: release/工蚁-<version>-win-x64.exe

# 5. 生成 Linux 安装包（x64 AppImage + deb，未签名）
pnpm dist:linux
# 输出: release/工蚁-<version>-linux-x86_64.AppImage / 工蚁-<version>-linux-amd64.deb

# 上传前复制为 ASCII 文件名（如 worker-ant-0.6.0-mac-arm64.dmg），并生成 SHA256SUMS.txt
#   → apps/worker-ant-desktop/release/github-assets/
```

> 跨平台构建需要下载目标平台的 Electron 与 electron-builder 工具件；国内网络下若超时，可加
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
> Windows NSIS 在 macOS 上构建依赖 electron-builder 自带的 wine（首次运行需初始化 wine prefix，可能需要重试一次）。

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
- **Windows / Linux**：暂未配置代码签名证书，因此两个平台的安装包均为**未签名**发布。发布说明与下载页必须如实标注
  「Windows SmartScreen 可能提示未知发布者、Linux 包未签名」，不假装签名已完成。

### 发布到 GitHub Releases

```bash
# 产物文件名用 ASCII（避免上传/下载链路的编码问题）
gh release create v0.6.0 \
  release/github-assets/worker-ant-0.6.0-mac-arm64.dmg \
  release/github-assets/worker-ant-0.6.0-mac-arm64.zip \
  release/github-assets/worker-ant-0.6.0-win-x64.exe \
  release/github-assets/worker-ant-0.6.0-linux-x86_64.AppImage \
  release/github-assets/worker-ant-0.6.0-linux-amd64.deb \
  release/github-assets/SHA256SUMS.txt \
  --repo Reamy/worker-ant \
  --title "工蚁 v0.6.0 — 岗位与项目业务知识、共享库可预览、任务级跨机真派" \
  --notes-file <发布说明.md>
```

> ⚠ **发布件一律取本机构建**。`.github/workflows/build.yml` 只上传 Actions artifacts，
> 且公开仓 `actions/secrets` 为空 ⇒ 其 macOS job 恒走 `Package (macOS, unsigned — no signing secrets)`。
> 拿 CI 的 dmg 当发布件，就等于把「已签名 + 公证」这句话变成假的（v0.5.0 的 5 个资产字节数与本地文件逐一相同，即本机构建）。

- 发布说明须列出 **SHA-256 校验值**与系统要求（macOS 13+ / arm64、Windows 10/11 x64、Linux x86_64），并如实写明
  Windows / Linux 安装包**未做代码签名**。
- 自动更新尚未启用（`publish.provider: github` 保持注释），升级暂时靠手动下载新版本。
- 公开仓源码由 `scripts/publish-oss.ts` 从 `git archive HEAD` 导出后生成**快照提交**，与本地提交历史不一一对应。
  日常发版用 `--append`（把本次导出树叠在远端 `main` 之上，提交正文自动列出自上一枚公开提交 `Local-Head`
  以来的变更），tag 须打在**这一枚公开提交**上；`--push --force` 只在需要整体替换时用（会孤儿化历史）。

## 默认账户

首次启动自动以本机所有者身份登录（无需输入密码），账本如下（亦可用作兜底登录）：

- 邮箱: `admin@worker-ant.local`
- 密码: `admin123`

设置自己的密码或新增第二位用户后，自动登录永久失效，改用邮箱+密码登录。

> ⚠️ 生产环境请立即修改默认密码。

## 策略配置

策略引擎的内置默认规则是唯一真源（见 `apps/worker-ant-desktop/src/main/core/policy-engine.ts`）。
根目录的 `policies.example.yml` 是归档前旧形态的示例，运行时**不再读取**。
