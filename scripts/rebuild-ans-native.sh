#!/bin/bash
# 重建 ans-server 依赖的 better-sqlite3 为 Node.js ABI。
#
# 背景：桌面端 electron-rebuild 会把工作区内所有 better-sqlite3 编译为 Electron ABI，
# 之后跑 pnpm dev:ans（Node.js）会报 ERR_DLOPEN_FAILED（NODE_MODULE_VERSION 不匹配）。
# pnpm rebuild 走 prebuild-install 缓存、不会真正重编，故这里直接 node-gyp 源码重编。
#
# 用法：bash scripts/rebuild-ans-native.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 凭据通道自检（zx_20261009 M4）────────────────────────────────────────────
# dev 下桌面**不可能**代起本机 ANS（ABI 互斥，见 CLAUDE.md「为什么 dev 下不能只跑桌面」）
#   ⇒ 本机 ANS 的凭据**只能来自 `.env`**：`ANS_API_KEYS=dev-key:dev-secret` 经 env 回退被
#   ANS 的 `getSecrets` 认，桌面（缺省 dev-key/dev-secret）才认得出它。
# 无 `.env` ⇒ ANS **无任何可用凭据** ⇒ 桌面发出的一切签名请求**必 401 `Invalid API key`**
#   （用户看到的是「服务可达，但读不到模型」——名不符实，正是 M5 要治的病）。
# ⚠ **不自动生成** `.env`（本仓「如实优先」：不替用户做他没看见的决定）——只把后果大声说清。
if [ ! -f "$ROOT/.env" ]; then
  echo ""
  echo "⚠️  未发现仓库根 .env —— 本机 ANS 将**无任何可用凭据**（源码只从 ../../.env 取 env 回退）。"
  echo "    ⇒ 桌面端发出的签名请求**必 401 \`Invalid API key\`**（表现：「服务可达，但读不到模型」）。"
  echo "    ⇒ 修复（一步）： cp .env.example .env     （.env 已在 .gitignore，不会误提交）"
  echo ""
fi

# 定位 ans-server 实际使用的 better-sqlite3 包目录（require.resolve 只解析路径、不加载 .node）
BSQL3_DIR="$(cd apps/ans-server && node -e "console.log(require('path').dirname(require('path').dirname(require.resolve('better-sqlite3'))))" 2>/dev/null || true)"

if [ -z "$BSQL3_DIR" ] || [ ! -d "$BSQL3_DIR" ]; then
  echo "⚠️  无法定位 ans-server 的 better-sqlite3，跳过 ABI 重建"
  exit 0
fi

# 定位编译产物 .node 文件
NODE_BIN=""
for p in "$BSQL3_DIR/build/Release/better_sqlite3.node" "$BSQL3_DIR/build/Debug/better_sqlite3.node"; do
  if [ -f "$p" ]; then NODE_BIN="$p"; break; fi
done

# 探测 .node 的 ABI：读取符号 node_register_module_v{ABI} 与当前 Node 对比。
# 注意不能用 require()/new Database() 加载来探测——加载 ABI 不匹配的原生模块会直接
# 崩溃(SIGKILL)而非抛 JS 异常，且 bash 会向终端打印 "Killed: 9" 噪音。
NEED_REBUILD=1
if [ -n "$NODE_BIN" ] && command -v nm >/dev/null 2>&1; then
  BIN_ABI="$(nm "$NODE_BIN" 2>/dev/null | grep -oE 'node_register_module_v[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
  NODE_ABI="$(node -p 'process.versions.modules' 2>/dev/null || true)"
  if [ -n "$BIN_ABI" ] && [ -n "$NODE_ABI" ] && [ "$BIN_ABI" = "$NODE_ABI" ]; then
    echo "✅ better-sqlite3 ABI 已匹配 Node.js (v$NODE_ABI)，无需重建"
    NEED_REBUILD=0
  fi
fi

if [ "$NEED_REBUILD" -eq 1 ]; then
  echo "🔧 better-sqlite3 ABI 不匹配，重建为 Node.js ABI: $BSQL3_DIR"
  (cd "$BSQL3_DIR" && npm run build-release --silent)
  echo "✅ better-sqlite3 已重建为 Node.js ABI"
fi

# ── 重签原生模块（zx_20261009_1 M3）───────────────────────────────────────────
# dev 下 ANS 用**系统 node** 加载同一批原生模块，内核同样会因「代码签名缓存 cs_mtime
#   ≠ 磁盘 mtime」拒页 SIGKILL（内核日志实证 `p[…][node]: rejecting invalid page`）。
# ⚠ 必须排在**重建之后**：重签须作用于**最终**的 .node。若先重签再重建，重建产出的新
#   二进制（ld 默认 adhoc,linker-signed + 全新 mtime）从未被重签 ⇒ 原病灶原样回来。
bash "$ROOT/scripts/resign-native-macos.sh"
