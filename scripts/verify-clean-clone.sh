#!/usr/bin/env bash
# zx_20261008 M2 —— 「干净 clone 能不能跑起来」的**可复现**验证。
#
# 病根：`fea5a207` 只修了「无 .env 会崩」这一个点。**修了一个点 ≠ 整条路通**。
#   本仓纪律：不做「我以为能跑」的背书 —— 开源的**第一跳**就是「陌生人能不能跑起来」。
#
# 本脚本做的（**可复现的那部分**）：
#   ① 干净目录 `git clone`（无 node_modules / 无 data / 无 .env）
#   ② `pnpm install`
#   ③ 后台起 `pnpm dev:ans`（**有界等待**）→ 轮询探活 ANS 健康端点
#   ③b **认证跳**（zx_20261009 M4 补）：以 `.env.example` 口径的身份对**受保护端点**签名请求一次
#       —— 健康端点**无需认证**，旧覆盖面止于此 ⇒ 对 401 **结构性不可见**（在册病族「断言名冒充
#       覆盖面」）。补上这一跳后，脚本自述与覆盖面才一致。
#   ④ 打印**下一步（人工）**：在 macOS Terminal.app 里跑桌面端看 GUI
#   ⑤ 清理临时目录 + 杀**自己拉起的**整棵 ANS 进程树（按自起子进程定位，不动别人的实例）
#
# ⚠ GUI 那一步**必须人工**（Terminal.app）——**不对 GUI 一步下任何结论**。
#   （以下措辞刻意不给"假绿"判据留把柄：连否定句里也不写那些字样。）
#
# ⚠ **两只标本（缺一不可）**：干净 clone **无 `.env`** ⇒ ANS 无凭据 ⇒ 认证跳**必红**（如实暴露
#   401 —— 这是"该命中"的真标本，证明本判据不是过宽变体）；加 `--with-env`（`cp .env.example .env`）
#   ⇒ 认证跳**绿**。只有"该命中"一只标本的判据＝过宽变体全票通过（在册病族）。
#
# 用法： bash scripts/verify-clean-clone.sh [--port N] [--wait S] [--keep] [--repo <path>] [--with-env]
#   默认端口 27183（可被 ANS_SERVER_PORT 覆盖）；--wait 默认 180 秒。
#   --with-env：clone 后把 `.env.example` 复制为 `.env`（**绿标本**用；默认不复制=红标本）。
# 退出码：
#   0 = **本脚本自起的** ANS 探活成功 **且** 认证跳通过（引擎侧端到端通过）
#   4 = 健康端点通、**认证跳未过**（401 等）⇒ 如实暴露：dev 无 `.env` 时**必**如此
#   3 = 端口已被占用 ⇒ **未能验证**（**不冒充**通过）
#   1 = 真失败（clone / install / 启动 / 探活超时）
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
REPO="$ROOT"
PORT="${ANS_SERVER_PORT:-27183}"
WAIT=180
KEEP=0
WITH_ENV=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port 需要一个参数}"; shift 2 ;;
    --wait) WAIT="${2:?--wait 需要一个参数}"; shift 2 ;;
    --repo) REPO="${2:?--repo 需要一个参数}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --with-env) WITH_ENV=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

HEALTH="http://127.0.0.1:${PORT}/api/v1/health"
MODELS="http://127.0.0.1:${PORT}/api/v1/models"
probe() { curl -sS -m 2 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"'; }

# 认证跳：HMAC 签名（与 `packages/ans-client` 的 `createHmacSignature` **同式**：
#   `sha256(secret, "<ts>\n<body>")` hex，头名 `X-Api-Key`/`X-Timestamp`/`X-Signature`）。
# 内联 node 而非引 ans-client —— 门禁须**自足**（不依赖 workspace 包是否已 build）。输出 JSON 便于解析。
auth_hop() {
  node -e '
    const { createHmac } = require("node:crypto");
    const [base, apiKey, secret] = [process.argv[1], process.argv[2], process.argv[3]];
    const ts = Date.now().toString();
    const sig = createHmac("sha256", secret).update(ts + "\n").digest("hex");
    fetch(base, { headers: { "X-Api-Key": apiKey, "X-Timestamp": ts, "X-Signature": sig } })
      .then(async (r) => console.log(JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 140) })))
      .catch((e) => console.log(JSON.stringify({ status: 0, body: String(e && e.message || e).slice(0, 140) })));
  ' "$MODELS" "$1" "$2"
}

TMP=""; LOG=""; STARTED=0; ANS_PID=0

# 列出 pid 及其全部后代（先根后叶）。收尾时**连祖先链一起**清掉：只杀端口监听者会留下
# `pnpm dev:ans` 的祖先链（`tsx watch` 杀了监听进程仍续活、剩一个「不听」的空壳），那就与收尾
# 自述「已停掉本次拉起的 ANS」不符 —— 同一病族：**断言名 ≠ 真正覆盖的面**。
kill_tree() {
  # ⚠ 逐条声明：macOS 自带 bash 3.2 里 `local a=1 b=$a` **看不到** 同一句刚赋的 `a`，
  #   合并写会让 `frontier` 恒为空 ⇒ 本函数静默返回空、收尾**什么也没杀**（正是本仓在册病族）。
  local root="$1" pids="" next p
  local frontier
  frontier="$root"
  while [ -n "$frontier" ]; do
    next=""
    for p in $frontier; do next="$next $(pgrep -P "$p" 2>/dev/null | tr '\n' ' ')"; done
    pids="$pids $frontier"
    frontier="$(echo $next)"
  done
  echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u
}

cleanup() {
  # --keep：保留临时目录**与**其 ANS（人工 GUI 一步要用），只提示如何收尾。
  if [ "$KEEP" -eq 1 ]; then
    echo "( --keep：已保留 ${TMP:-<临时目录>} 与其 ANS（端口 ${PORT}）。收尾：lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill )"
    return 0
  fi
  # 只杀**本脚本自己拉起的**那个 ANS。`STARTED` 未置位（早退：端口被占 / clone·install 失败）
  # ⇒ **一律不碰别人的实例**——否则「如实报端口被占」这条退出路径反手把人家在跑的 ANS 杀掉。
  if [ "$STARTED" -eq 1 ]; then
    local pids
    # 并集：自起子进程树（含 tsx watch 这类「杀了叶子仍续活」的祖先）+ 端口监听者（防 daemonize
    # 脱离父链、树里找不到的那个）。只取其一都会漏 —— 病根见 `kill_tree` 注释。
    pids="$( { kill_tree "$ANS_PID"; lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null; } | sort -u )"
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill 2>/dev/null || true
      sleep 1
      pids="$( { kill_tree "$ANS_PID"; lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null; } | sort -u )"
      [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
  fi
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT

echo "== M2 干净 clone 验证 =="
echo "   源仓：${REPO}"
echo "   端口：${PORT}    健康端点：${HEALTH}"

# ── 0. 端口必须先为空；已被占用 ⇒ 如实报「未能验证」，绝不假绿 ──────────────
if probe; then
  echo
  echo "⚠️  端口 ${PORT} 上**已经有 ANS 在响应**（不是本脚本拉起的）。"
  echo "    ⇒ 无法验证『干净 clone 里自起的 ANS 能否探活』——**本轮未能验证**。"
  echo "    ⇒ 请换一个空闲端口重跑，例如：bash scripts/verify-clean-clone.sh --port 27199"
  exit 3
fi
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo
  echo "⚠️  端口 ${PORT} 已被占用（有监听，但健康端点未响应）。**未能验证**。"
  echo "    ⇒ 请换端口重跑：bash scripts/verify-clean-clone.sh --port 27199"
  exit 3
fi

# ── 1. 干净 clone ────────────────────────────────────────────────────────────
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wa-clean-clone.XXXXXX")"
LOG="$TMP/dev-ans.log"
echo
echo "① 干净 clone → ${TMP}"
if ! git clone --quiet "$REPO" "$TMP/repo"; then
  echo "   ✗ clone 失败"; exit 1
fi
WORK="$TMP/repo"
for junk in node_modules data .env; do
  if [ -e "$WORK/$junk" ]; then echo "   ✗ 克隆结果不干净：存在 $junk"; exit 1; fi
done
echo "   ✓ 无 node_modules / 无 data / 无 .env（干净）"

# ── 1b. 标本二选一：默认=红标本（无 .env），--with-env=绿标本（有 .env）────────
# 认证跳的凭据口径**取自 `.env.example`**（与 ANS 的 env 回退 `ANS_API_KEYS` 同源）：
#   无 .env ⇒ ANS 拿不到凭据 ⇒ 认证跳必 401；--with-env ⇒ ANS 认得出 ⇒ 认证跳绿。
# 两只标本缺一不可：只有「该命中」的红标本 ⇒ 任何过宽变体（连 401 都不算失败）全票通过。
ENV_EXAMPLE="$WORK/.env.example"
AUTH_PAIR="$(grep -E '^ANS_API_KEYS=' "$ENV_EXAMPLE" 2>/dev/null | head -1 \
  | sed -E 's/^ANS_API_KEYS=//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//' | cut -d, -f1 || true)"
AUTH_KEY="${AUTH_PAIR%%:*}"
AUTH_SECRET="${AUTH_PAIR#*:}"
# 口径自证：必须形如 `key:secret`（key 非空、secret 非空、且确有冒号分隔）。
if [ -z "$AUTH_PAIR" ] || [ "$AUTH_KEY" = "$AUTH_PAIR" ] || [ -z "$AUTH_SECRET" ]; then
  echo "   ✗ 从 .env.example 取不到 \`ANS_API_KEYS=key:secret\` 口径 ⇒ **未能验证**"
  exit 1
fi

if [ "$WITH_ENV" -eq 1 ]; then
  # 去掉 `.env.example` 里的 ANS_SERVER_PORT 行，端口一律由本脚本的 ANS_SERVER_PORT 环境变量定
  grep -v '^ANS_SERVER_PORT=' "$ENV_EXAMPLE" > "$WORK/.env"
  echo "   --with-env：已 cp .env.example → .env（去端口行；端口由脚本 ANS_SERVER_PORT 定）"
  SPECIMEN="绿标本（有 .env）"
else
  echo "   默认：**无 .env** —— 本函数**预期认证跳红**（401），这是「该命中」的真标本"
  SPECIMEN="红标本（无 .env）"
fi
echo "   认证跳凭据（取自 .env.example）：key=${AUTH_KEY}  secret=<省略>"

# ── 2. pnpm install ─────────────────────────────────────────────────────────
echo
echo "② pnpm install（可能需编译原生模块，耗时数分钟）"
if ! ( cd "$WORK" && pnpm install > "$TMP/install.log" 2>&1 ); then
  echo "   ✗ install 失败，日志尾部："; tail -25 "$TMP/install.log"; exit 1
fi
echo "   ✓ install 完成"

# ── 3. 后台起 ANS（有界等待）+ 探活 ─────────────────────────────────────────
echo
echo "③ 后台启动 ANS（ANS_SERVER_PORT=${PORT}）并轮询探活（上限 ${WAIT}s）"
( cd "$WORK" && ANS_SERVER_PORT="$PORT" pnpm dev:ans ) > "$LOG" 2>&1 &
ANS_PID=$!   # 该后台子 shell 的 pid —— 收尾时以它为根杀掉整棵自起的进程树
disown 2>/dev/null || true   # 脱离子任务表：收尾 kill 时 bash 不再打印 “Terminated: 15 …” 噪音
STARTED=1    # 自此刻起，本脚本才「拥有」端口 ${PORT} 上那个 ANS，收尾时才有权杀它
deadline=$(( $(date +%s) + WAIT ))
ok=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if probe; then ok=1; break; fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "   ✗ 等待 ${WAIT}s 后仍未探活成功 —— **失败**"
  echo "   ---- dev:ans 日志尾部 ----"; tail -30 "$LOG"
  exit 1
fi

echo "   ✓ 探活成功：${HEALTH} 返回 status=ok"
# 版本信息（顺带证明是 clone 里新起的那个进程）
echo "   响应：$(curl -sS -m 2 "$HEALTH" 2>/dev/null)"

# ── 3b. 认证跳：以 `.env.example` 口径的身份对**受保护端点**签名请求一次 ────────
# 健康端点**无需认证** ⇒ 旧覆盖面止于「服务起来了」，对 401 **结构性不可见**
#   （在册病族「断言名冒充覆盖面」）。这一跳把覆盖面扩到「**认证真通过**」——
#   补上它，脚本自述与覆盖面才一致。
echo
echo "③b 认证跳（${SPECIMEN}）：GET ${MODELS}（HMAC 签名）"
HOP_JSON="$(auth_hop "$AUTH_KEY" "$AUTH_SECRET")"
# auth_hop 恒输出单行 JSON：`{"status":<N>,"body":"…"}`（status 为首键，故锚 ^）
HOP_STATUS="$(printf '%s' "$HOP_JSON" | sed -E 's/^\{"status":([0-9]+),.*/\1/')"
echo "   响应：${HOP_JSON}"

if [ "$HOP_STATUS" = "200" ]; then
  echo "   ✓ 认证跳通过（HTTP 200）——签名被 ANS 认下（凭据通道端到端成立）"
else
  echo "   ✗ 认证跳未过（HTTP ${HOP_STATUS}）"
  if [ "$WITH_ENV" -eq 0 ]; then
    echo "     ⇒ **如实暴露**：dev 干净 clone 无 .env ⇒ ANS 无凭据 ⇒ 401 —— 这是默认标本的**预期**结果。"
    echo "     ⇒ 要验另一只「有 .env ⇒ 绿」的标本，请加 --with-env 重跑。"
  fi
  exit 4
fi

# ── 4. 人工一步：GUI（本脚本不代劳、也不代下结论）──────────────────────────
echo
echo "④ 下一步（**人工**，本脚本不代劳）："
echo "   在 **macOS Terminal.app**（勿用 IDE 终端，会被 SIGKILL）里执行："
echo "     cd ${WORK}/apps/worker-ant-desktop && bash run.sh"
echo "   确认 **GUI 真出界面**。"
echo
echo "   注：本脚本只验到「ANS 探活成功」为止 —— 桌面端 GUI 是否真出界面，"
echo "       以您在上述步骤的**亲眼所见**为准。"
echo
echo "✅ 引擎侧验证完成（clone → install → dev:ans → 探活 OK → 认证跳 OK）。"
if [ "$KEEP" -eq 1 ]; then
  echo "   --keep：临时目录 ${WORK} 与其 ANS（端口 ${PORT}）均**保留**，可直接做上面第 ④ 步。"
else
  echo "   （退出时已清理临时目录并停掉本次拉起的 ANS；若要留着做第 ④ 步，请加 --keep）"
fi
exit 0
