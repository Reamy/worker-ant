#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "🐜 工蚁桌面端启动"
echo ""

# 1. 构建前端
echo "📦 构建前端..."
pnpm --filter @worker-ant/desktop-renderer build --silent

# 2. 重建原生模块为 Electron ABI
echo "🔧 重建原生模块 (Electron ABI)..."
pnpm rebuild:native --silent

# 3. 编译 TypeScript
echo "🔨 编译 Main Process..."
pnpm tsup --silent

# 4. 启动 Electron
echo "🚀 启动 Electron..."
./node_modules/.bin/electron . --dev --no-sandbox

# 5. 恢复 Node.js ABI
echo "🔄 恢复 Node.js ABI..."
cd ../..
bash scripts/rebuild-ans-native.sh
echo "✅ 完成"
