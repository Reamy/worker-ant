#!/usr/bin/env bash
# zx_20261008 M4 —— 在先使用权固证（《商标法》§59(3) 的零成本对冲）。
#
# 背景：R2 不注册商标 ⇒ 改用「在先使用权」抗辩替代排他权
#   （business-plan/plans/biz_20261008.md §3.2）。前提是**首发当日起留痕**，不可事后补。
#
# 本脚本把**可独立复核**的证据追加进 docs/prior-use-evidence.md（**只追加，不修改历史行**）：
#   · 固证时刻：**真 UTC**——由 commit 的 epoch 换算得到。
#     ⚠ 不可用 `git log --date=format:'…Z'` 直接加 Z：它输出的是**原偏移下的钟面**
#       （本仓东八区 ⇒ 会平白少 8 小时），是**假 UTC**。
#   · tag：HEAD 未打 tag 时如实记「—」。
#   · commit 短哈希 / 仓 URL（优先 github 远端，规范化为 https）。
#   · 标识：中英两枚「工蚁 / Worker Ant」——二者都纳入保护范围。
#
# ⚠ 主证据仍是**公开仓 / 发行版本身**（GitHub release 的 UTC 时间戳不可改、tag 可验）；
#   本文件是**冗余备份**（防单一平台失效），不作唯一凭据。
#
# 用法： bash scripts/record-prior-use.sh [--out <file>] [--note <text>]
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"

OUT="docs/prior-use-evidence.md"
NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out)  OUT="${2:?--out 需要一个参数}"; shift 2 ;;
    --note) NOTE="${2:?--note 需要一个参数}"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

COMMIT="$(git rev-parse --short HEAD)"
EPOCH="$(git log -1 --format=%ct)"
# epoch → UTC：BSD(macOS) 用 -r，GNU(Linux) 用 -d @。两分支都输出同一格式。
if date -u -r "$EPOCH" +%Y >/dev/null 2>&1; then
  UTC="$(date -u -r "$EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
else
  UTC="$(date -u -d "@$EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
fi
TAG="$(git tag --points-at HEAD 2>/dev/null | head -1)"; [ -z "$TAG" ] && TAG="—"
RAW_URL="$(git remote get-url github 2>/dev/null || git remote get-url origin 2>/dev/null || true)"
URL="$(printf '%s' "$RAW_URL" | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')"
[ -z "$URL" ] && URL="—（未配置远端）"
IDENT="工蚁 / Worker Ant"
LOCAL_TS="$(date +%Y-%m-%dT%H:%M:%S%z)"   # 记录者本地时刻：与 UTC 双标注，防时区误读

mkdir -p "$(dirname "$OUT")"
if [ ! -f "$OUT" ]; then
  cat > "$OUT" <<'HDR'
# 在先使用固证台账（Prior-Use Evidence）

> 依据：`business-plan/plans/biz_20261008.md` §3.2 —— R2 不注册商标，改用《商标法》§59(3) **在先使用权**对冲。
> **《商标法》§59(3)**：在商标注册人**申请注册前**，他人已在同一种或类似商品上**先于**商标注册人使用相同或近似商标的，
> 注册商标专用权人**无权禁止**该使用人在**原使用范围内**继续使用该商标。
> ⚠ 这是**抗辩权**，**不是**排他权：保的是「**你能继续用自己的名字**」，**不保**「别人不能用这个名字」。
>
> **本仓公开使用的标识（两枚都纳入保护范围）**：「工蚁」／「Worker Ant」。
>
> **留痕纪律**：**从首发当日起**追加；**只追加、不修改历史行**（改了就自毁证据力）。
> **主证据**仍是公开仓 / 发行版本身（GitHub release 的 UTC 时间戳不可改、tag 可验）；
> 本文件是**冗余备份**，防单一平台失效。
> 「固证时刻」为 **commit 提交时刻的真 UTC**（由 epoch 换算，**不是**钟面照抄）。
> 「备注」写明该行性质：**首发行**（首次公开发布，§59(3) 起点）／**预登记**（公开发布前的代码存在固证）／其它。

| # | 固证时刻(UTC) | tag | commit | 仓 URL | 标识 | 备注 |
|---|---|---|---|---|---|---|
HDR
fi

N=$(( $(grep -cE '^\| [0-9]+ \|' "$OUT" || true) + 1 ))
printf '| %s | %s | %s | %s | %s | %s | %s |\n' \
  "$N" "$UTC" "$TAG" "$COMMIT" "$URL" "$IDENT" \
  "${NOTE:-固证（记录者本地时刻 ${LOCAL_TS}）}" >> "$OUT"

echo "✅ 已追加固证 #${N} → ${OUT}"
echo "   固证时刻：${UTC}（UTC）   记录者本地：${LOCAL_TS}"
echo "   tag：${TAG}    commit：${COMMIT}"
echo "   仓 URL：${URL}"
echo "   标识：${IDENT}"
