#!/bin/bash
# 原生模块启动前重签 —— 治「代码签名缓存 cs_mtime ≠ 磁盘 mtime ⇒ 内核逐页拒绝 ⇒ SIGKILL 秒退」。
#
# 真源：plans/improve/zx_20261009_1.md §1.3
#   §1.1 内核原行：CODE SIGNING: ... rejecting invalid page ... better_sqlite3.node
#                  (cs_mtime:1786180816.643578368 != mtime:1746658220.0)
#   §1.2 该 cs_mtime **不在文件里**（整文件扫描零命中）⇒ 是 AMFI 按 cdhash 缓存的"首载时刻"；
#        磁盘 mtime 1746658220.0（整秒）= pnpm store / tarball 产物。
#   §1.3 重签实测同时做到三件事，方向一致地把"对不上"变"对得上"：
#        ①换 cdhash（旧缓存条目不适用）②去掉 linker-signed 位（0x20002→0x2）③刷新 mtime 为此刻。
#
# 幂等；非 macOS 原样跳过（无 AMFI）。用法：bash scripts/resign-native-macos.sh [--probe]
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROBE=0
[ "$1" = "--probe" ] && PROBE=1

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ℹ  非 macOS（$(uname -s)）—— 无代码签名页校验，跳过原生模块重签"
  exit 0
fi

# 载入集由**唯一真源** scripts/diag-cs-sig.mjs --list 给出（实测 dlopen 结果），此处不自立一套 find。
# ⚠ macOS 自带 bash 3.2 —— 不得用 mapfile；用 while read + 数组。
NODES=()
while IFS= read -r f; do
  [ -n "$f" ] && NODES+=("$f")
done < <(node "$ROOT/scripts/diag-cs-sig.mjs" --list 2>/dev/null)

if [ "${#NODES[@]}" -eq 0 ]; then
  echo "⚠️  未找到待重签的原生模块（node_modules 是否已安装？）"
  exit 0
fi

echo "🔏 原生模块重签 (macOS)"
RESIGN_FAIL=0
for f in "${NODES[@]}"; do
  if codesign --force --sign - "$f" >/dev/null 2>&1; then
    echo "   ✓ $f"
  else
    echo "   ✗ 重签失败：$f"
    RESIGN_FAIL=1
  fi
done
[ "$RESIGN_FAIL" -eq 1 ] && echo "⚠️  有模块重签失败（交由下方加载探针裁定）"

# ── 启动前具名自检（M4）────────────────────────────────────────────────────────
# 真问题不是"崩了"，是"秒退且无遗言"：用户只见 `exited with signal SIGKILL`，被引向"是不是我代码错了"。
# 此处用 **Electron 的 node 模式** 加载这两个原生模块——与真启动**同一条 mmap / 签名校验路径**；
# 失败即具名中止，不进入 `electron .`。成功亦顺带让 AMFI 为该 cdhash 建一条与当前 mtime 一致的
# 缓存条目，等于给紧随其后的真启动"预热"。
# ⚠ 须在 electron-rebuild **之后**调用（此时模块为 Electron ABI）；否则 ABI 不符亦会秒退。
if [ "$PROBE" -eq 1 ]; then
  ELECTRON_BIN="$ROOT/apps/worker-ant-desktop/node_modules/.bin/electron"
  if [ ! -x "$ELECTRON_BIN" ]; then
    echo "ℹ  未找到 electron，跳过加载探针：$ELECTRON_BIN"
    exit 0
  fi
  # ABI 前置判（否则 ABI 不符的秒退会被**误读**成"签名被拒"——两者都是 SIGKILL 无遗言）。
  BSQL_NODE=""
  for f in "${NODES[@]}"; do case "$f" in */better_sqlite3.node) BSQL_NODE="$f"; break ;; esac; done
  ELE_ABI="$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -p 'process.versions.modules' 2>/dev/null || true)"
  if [ -n "$BSQL_NODE" ] && [ -n "$ELE_ABI" ] && command -v nm >/dev/null 2>&1; then
    BIN_ABI="$(nm "$BSQL_NODE" 2>/dev/null | grep -oE 'node_register_module_v[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
    if [ -n "$BIN_ABI" ] && [ "$BIN_ABI" != "$ELE_ABI" ]; then
      echo "ℹ  跳过加载探针：原生模块 ABI=$BIN_ABI ≠ Electron ABI=$ELE_ABI"
      echo "    （此刻加载必秒退，但那是 ABI 不符、非签名问题；本探针须在 electron-rebuild 之后运行）"
      exit 0
    fi
  fi
  echo "🔎 原生模块加载探针 (ELECTRON_RUN_AS_NODE)"
  PROBE_LOG="$(mktemp)"
  # cwd 落在桌面包内，使 better-sqlite3 / bcrypt 可解析（它们是该包的依赖，非仓库根依赖）。
  if (cd "$ROOT/apps/worker-ant-desktop" && ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" \
        -e "require('better-sqlite3'); require('bcrypt')") >"$PROBE_LOG" 2>&1; then
    echo "   ✓ 原生模块加载正常"
    rm -f "$PROBE_LOG"
  else
    RC=$?
    echo "   ✗ 原生模块加载失败（exit=$RC）"
    sed 's/^/     | /' "$PROBE_LOG" | head -20
    rm -f "$PROBE_LOG"
    if [ "$RC" -ge 128 ]; then
      echo "   ⇒ 被信号 $((RC - 128)) 终止 —— 典型：内核代码签名页校验拒绝（cs_mtime ≠ 磁盘 mtime）"
      echo "      真源诊断：log show --last 30m --predicate 'eventMessage CONTAINS \"cs_invalid_page\"'"
      echo "      兜底重建：rm -rf node_modules && pnpm install（使磁盘 mtime 不再是 tarball 旧值）"
    else
      echo "   ⇒ 非信号退出（可能是 ABI 不符或依赖解析问题），见上方 stderr"
    fi
    exit 1
  fi
fi
