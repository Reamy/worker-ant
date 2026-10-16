# 工蚁系统 - 多服务 Dockerfile
# 构建: docker build --target <ans|server|web> -t worker-ant-<name> .
# 或使用 docker-compose up 一键启动
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/shared-types ./packages/shared-types
COPY packages/ans-client ./packages/ans-client

# === ANS 服务端 ===
FROM base AS ans-build
COPY apps/ans-server ./apps/ans-server
RUN pnpm install --frozen-lockfile && pnpm --filter @worker-ant/ans-server build

FROM node:22-slim AS ans
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY --from=ans-build /app/apps/ans-server/dist ./dist
COPY --from=ans-build /app/apps/ans-server/package.json ./
COPY --from=ans-build /app/apps/ans-server/node_modules ./node_modules
EXPOSE 3001
CMD ["node", "dist/index.js"]

# === 工蚁后端 ===
FROM base AS server-build
COPY apps/worker-ant-server ./apps/worker-ant-server
RUN pnpm install --frozen-lockfile && pnpm --filter @worker-ant/server build

FROM node:22-slim AS server
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY --from=server-build /app/apps/worker-ant-server/dist ./dist
COPY --from=server-build /app/apps/worker-ant-server/package.json ./
COPY --from=server-build /app/apps/worker-ant-server/node_modules ./node_modules
EXPOSE 9411
CMD ["node", "dist/index.js"]

# === 工蚁前端 ===
FROM base AS web-build
COPY apps/worker-ant-web ./apps/worker-ant-web
RUN pnpm install --frozen-lockfile && pnpm --filter @worker-ant/web build

FROM node:22-slim AS web
WORKDIR /app
COPY --from=web-build /app/apps/worker-ant-web/.next ./.next
COPY --from=web-build /app/apps/worker-ant-web/package.json ./
COPY --from=web-build /app/apps/worker-ant-web/public ./public
COPY --from=web-build /app/apps/worker-ant-web/node_modules ./node_modules
EXPOSE 9410
CMD ["npx", "next", "start", "--port", "9410"]
