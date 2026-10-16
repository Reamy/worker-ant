#!/bin/bash
# 工蚁桌面端启动脚本 — 从 Terminal.app 运行
# 不要在 JetBrains/VS Code 终端中运行！会被 SIGKILL
set -e
cd "$(dirname "$0")"

# 检查是否在 IDE 终端中
if [ -n "$JETBRAINS_HOME" ] || [ -n "$VSCODE_PID" ] || [ -n "$TERM_PROGRAM" ] && [ "$TERM_PROGRAM" != "Apple_Terminal" ]; then
  echo "⚠️  检测到 IDE 终端环境，请在 macOS Terminal.app 中运行此脚本"
  echo ""
  echo "  方式1：在 Terminal.app 中执行："
  echo "    cd $(pwd)"
  echo "    bash run.sh"
  echo ""
  echo "  方式2：执行以下命令自动打开 Terminal.app："
  echo "    open -a Terminal $(pwd)/run.sh"
  exit 1
fi

echo "🐜 工蚁桌面端"
echo ""

# 1. 构建前端
echo "📦 构建前端..."
pnpm --filter @worker-ant/desktop-renderer build 2>&1 | tail -1

# 2. 重建原生模块 (Electron ABI)
echo "🔧 ABI 切换 (Electron)..."
npx electron-rebuild -f 2>&1 | tail -1

# 3. 编译 TypeScript
echo "🔨 编译..."
npx tsup 2>&1 | tail -1

# 3.5 原生模块重签 + 启动前自检
#     macOS 代码签名「缓存 cs_mtime ≠ 磁盘 mtime」⇒ 内核逐页拒绝 ⇒ Electron 秒退 SIGKILL（无遗言）。
#     真源：scripts/resign-native-macos.sh / plans/improve/zx_20261009_1.md
if ! bash ../../scripts/resign-native-macos.sh --probe; then
  echo "🔄 自检未过，恢复 ABI (Node.js)..."
  cd ../..
  bash scripts/rebuild-ans-native.sh
  exit 1
fi

# 4. 启动 Electron
echo "🚀 启动 Electron..."
# zx_20261011_2：**多实例并存**（双 clone 实机 E2E）需各自独立的 userData——
#   Electron 的单实例锁按 userData 目录分（`main/index.ts` 的 `requestSingleInstanceLock`），
#   默认目录下第二个实例拿不到锁即退出。设 `WA_ELECTRON_UDATA=<目录>` 即把本实例 profile 指过去
#   （如 `<clone>/.electron-udata`，已在 .gitignore）。**缺省不设 ⇒ 行为与原样一字不变**。
UDATA_ARGS=()
[ -n "${WA_ELECTRON_UDATA:-}" ] && UDATA_ARGS=(--user-data-dir="$WA_ELECTRON_UDATA")
./node_modules/.bin/electron . --dev "${UDATA_ARGS[@]}"
EXIT_CODE=$?

# 5. 恢复 Node.js ABI
echo "🔄 恢复 ABI (Node.js)..."
cd ../..
bash scripts/rebuild-ans-native.sh

echo "✅ 完成 (exit: $EXIT_CODE)"
