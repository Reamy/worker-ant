#!/usr/bin/env bash
# zx_20261108_1 B8：把跨机验收用过的容器固化成"一条命令复跑"。
#
# 做三件事：确认宿主 ANS 在听 → 凭据不够就从宿主库读 → build 并起命名容器 `wa-headless`。
# 想换镜像/容器名/时长：WA_IMAGE / WA_CONTAINER_NAME / WA_DURATION / WA_HEARTBEAT_SEC。
#
#   bash scripts/headless-docker.sh          # 构建并后台起节点（默认驻留 300s）
#   docker logs -f wa-headless               # 看注册/心跳/中继事件
#   docker rm -f wa-headless                 # 停掉（数据卷 wa-headless-data 保留节点身份）
#
# 前提：宿主 `pnpm dev:ans` 已起（:27183 在听）。容器里 localhost ≠ 宿主，故 ANS_SERVER_URL 固定
# 缺省为 http://host.docker.internal:27183；显式传 ANS_SERVER_URL 才覆盖。
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=${WA_CONTAINER_NAME:-wa-headless}
IMAGE=${WA_IMAGE:-wa-headless:dev}
DURATION=${WA_DURATION:-300}
HEARTBEAT=${WA_HEARTBEAT_SEC:-5}

if ! lsof -iTCP:27183 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ANS :27183 未监听——先跑 pnpm dev:ans" >&2
  exit 1
fi

# 宿主库里的凭据（与桌面/GUI 同一份真源）；已显式给 env 则不读。
if [[ -z "${ANS_API_KEY:-}" || -z "${ANS_SECRET_KEY:-}" ]]; then
  CREDS=$(node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("data/worker-ant-server.db", { readOnly: true });
    const keep = new Set(["ans_api_key", "ans_secret_key"]);
    const m = Object.fromEntries(
      db.prepare("select key,value from wa_settings").all()
        .filter((r) => keep.has(r.key))
        .map((r) => [r.key, r.value]),
    );
    db.close();
    console.log((m.ans_api_key || "") + " " + (m.ans_secret_key || ""));
  ' 2>/dev/null) || CREDS=''
  read -r DB_KEY DB_SECRET <<<"$CREDS"
  ANS_API_KEY=${ANS_API_KEY:-$DB_KEY}
  ANS_SECRET_KEY=${ANS_SECRET_KEY:-$DB_SECRET}
fi
if [[ -z "${ANS_API_KEY:-}" || -z "${ANS_SECRET_KEY:-}" ]]; then
  echo "没有凭据：设置 ANS_API_KEY / ANS_SECRET_KEY，或确认 data/worker-ant-server.db 里有 settings" >&2
  exit 1
fi
ANS_SERVER_URL=${ANS_SERVER_URL:-http://host.docker.internal:27183}

docker build -f Dockerfile.headless -t "$IMAGE" .
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --add-host=host.docker.internal:host-gateway \
  -e ANS_SERVER_URL="$ANS_SERVER_URL" \
  -e ANS_API_KEY="$ANS_API_KEY" \
  -e ANS_SECRET_KEY="$ANS_SECRET_KEY" \
  -e WA_NODE_NAME="${WA_NODE_NAME:-wa-docker-linux}" \
  -e WA_DATA_DIR=/data \
  -v wa-headless-data:/data \
  "$IMAGE" --duration "$DURATION" --heartbeat-sec "$HEARTBEAT" --work

echo "已起容器 ${NAME}（镜像 ${IMAGE}，时长 ${DURATION}s，心跳 ${HEARTBEAT}s）"
echo "看日志：docker logs -f ${NAME}"
