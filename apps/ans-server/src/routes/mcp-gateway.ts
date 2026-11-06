/**
 * MCP Gateway — per-server proxy endpoints.
 * Each registered MCP server gets its own endpoint: POST /mcp/:name
 * Uses SDK-based Client to forward JSON-RPC requests to the real MCP server.
 */
import { Elysia, t } from 'elysia';
import type Database from 'better-sqlite3';
import { forwardToMcpServer } from '../services/mcp-gateway-client.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp-gateway');

export function mcpGatewayRoutes(db: Database.Database) {
  return (
    new Elysia({ prefix: '/mcp' })

      // Per-server MCP proxy: POST /mcp/:name
      // M15-⑥: 这里原有一句「名字等于 message 就回 400」的分支——它是**够不着的死码**：
      //   `/mcp/message` 由 `routes/mcp-proxy.ts` 的**静态**路由接走（Elysia 1.2 静态恒胜动态段）。
      //   保留名现在由 `utils/mcp-reserved-names.ts` 一处声明，并在**入口**（routes/mcp.ts 建/改）
      //   判死 ⇒ 「谁接 /mcp/message」不再取决于注册顺序。
      .post(
        '/:name',
        async ({ params: { name }, body, set }) => {
          const server = db
            .prepare(
              "SELECT id, name, endpoint, transport, auth_config, status FROM ans_mcp_servers WHERE name = ? AND status = 'active'",
            )
            .get(name) as Record<string, unknown> | undefined;

          if (!server) {
            set.status = 404;
            return { jsonrpc: '2.0', id: null, error: { code: -32000, message: `MCP server not found: ${name}` } };
          }

          const request = body as {
            jsonrpc: string;
            id: number | string;
            method: string;
            params?: Record<string, unknown>;
          };
          if (request.jsonrpc !== '2.0') {
            set.status = 400;
            return {
              jsonrpc: '2.0',
              id: request.id ?? null,
              error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
            };
          }

          logger.info({ name, method: request.method, endpoint: server.endpoint }, 'MCP gateway proxying');

          const result = await forwardToMcpServer(server.endpoint as string, {
            jsonrpc: '2.0',
            id: request.id,
            method: request.method,
            params: request.params,
          });

          // If the proxied server returned an error, propagate the status
          if (result.error) {
            set.status = result.error.code === -32601 ? 404 : 502;
          }

          return result;
        },
        {
          body: t.Object({
            jsonrpc: t.String(),
            id: t.Optional(t.Unknown()),
            method: t.String(),
            params: t.Optional(t.Record(t.String(), t.Unknown())),
          }),
        },
      )
  );
}
