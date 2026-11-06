import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { notFound, AppError, ErrorCode } from '../utils/errors.js';
import { AuditService } from '../services/audit.js';
import { discoverMcpServer } from '../services/mcp-discovery.js';
import { getResourceGroupsFromApiKey } from '../utils/security.js';
import { parsePagination, paginationClause, paginationArgs, pageMeta } from '../utils/pagination.js';
import { isReservedMcpServerName, MCP_GATEWAY_RESERVED_REASON } from '../utils/mcp-reserved-names.js';

export function mcpRoutes(db: Database.Database) {
  const audit = new AuditService(db);

  return (
    new Elysia({ prefix: '/api/v1/mcp' })
      .get('/', ({ query }) => {
        // M15-⑤: 加 `limit`/`offset`/`total`（**缺省不限**——不给上限，就不改现有阅读面读到的条数）
        const includeAll = query?.all === '1';
        const filter = includeAll ? '' : "WHERE status != 'disabled'";
        const page = parsePagination(query as Record<string, unknown>);
        const total = (db.prepare(`SELECT COUNT(*) as c FROM ans_mcp_servers ${filter}`).get() as { c: number }).c;
        const rows = db
          .prepare(`SELECT * FROM ans_mcp_servers ${filter} ORDER BY created_at DESC${paginationClause(page)}`)
          .all(...paginationArgs(page));
        return { data: rows, ...pageMeta(total, page, rows.length) };
      })
      .get('/:id', ({ params: { id } }) => {
        const row = db.prepare('SELECT * FROM ans_mcp_servers WHERE id = ?').get(id);
        if (!row) throw notFound('MCP Server', id);
        return { data: formatMCP(row as Record<string, unknown>) };
      })
      .post(
        '/',
        async ({ body, set }) => {
          // M15-⑥: 保留名入口判死——名字撞上网关静态路由的服务器**永远代理不到**，落库即"在册而不可达"
          if (isReservedMcpServerName(body.name)) {
            throw new AppError(ErrorCode.INVALID_REQUEST, `MCP 服务器名不合法：${MCP_GATEWAY_RESERVED_REASON}`, 400);
          }
          const id = randomUUID();
          const authConfig = body.auth_config ? JSON.stringify(body.auth_config) : '{"type":"none"}';

          // 先写入基础记录
          db.prepare(
            'INSERT INTO ans_mcp_servers (id, name, endpoint, transport, auth_config) VALUES (?, ?, ?, ?, ?)',
          ).run(id, body.name, body.endpoint, body.transport ?? 'streamable-http', authConfig);
          audit.log({
            actor: 'api',
            action: 'create_mcp',
            resource_type: 'mcp_server',
            resource_id: id,
            detail: { name: body.name },
          });

          // 自动预热：连接服务器发现工具列表
          const discovery = await discoverMcpServer(body.endpoint);

          if (discovery.success) {
            db.prepare(
              "UPDATE ans_mcp_servers SET cached_tools = ?, cached_server_info = ?, health_check_at = datetime('now') WHERE id = ?",
            ).run(JSON.stringify(discovery.tools), JSON.stringify(discovery.serverInfo ?? {}), id);
          }

          set.status = 201;
          return {
            data: {
              id,
              name: body.name,
              endpoint: body.endpoint,
              transport: body.transport ?? 'streamable-http',
              auth_config: body.auth_config ?? { type: 'none' },
              discovery: {
                success: discovery.success,
                toolCount: discovery.tools.length,
                tools: discovery.tools.map((t) => t.name),
                error: discovery.error,
              },
            },
          };
        },
        {
          body: t.Object({
            name: t.String(),
            endpoint: t.String(),
            transport: t.Optional(t.String()),
            auth_config: t.Optional(t.Object({ type: t.String(), token: t.Optional(t.String()) })),
          }),
        },
      )
      .put(
        '/:id',
        ({ params: { id }, body }) => {
          const existing = db.prepare('SELECT id FROM ans_mcp_servers WHERE id = ?').get(id);
          if (!existing) throw notFound('MCP Server', id);
          // M15-⑥: 改名同样能撞上保留名（改完就永久不可达），故这一路也判
          if (isReservedMcpServerName(body.name)) {
            throw new AppError(ErrorCode.INVALID_REQUEST, `MCP 服务器名不合法：${MCP_GATEWAY_RESERVED_REASON}`, 400);
          }
          const authConfig = body.auth_config ? JSON.stringify(body.auth_config) : '{"type":"none"}';
          db.prepare(
            'UPDATE ans_mcp_servers SET name = ?, endpoint = ?, transport = ?, auth_config = ?, status = ? WHERE id = ?',
          ).run(body.name, body.endpoint, body.transport ?? 'streamable-http', authConfig, 'active', id);
          return { data: { id, ...body } };
        },
        {
          body: t.Object({
            name: t.String(),
            endpoint: t.String(),
            transport: t.Optional(t.String()),
            auth_config: t.Optional(t.Object({ type: t.String(), token: t.Optional(t.String()) })),
          }),
        },
      )
      .delete('/:id', ({ params: { id } }) => {
        db.prepare('UPDATE ans_mcp_servers SET status = ?, health_check_at = NULL WHERE id = ?').run('disabled', id);
        return { data: { id, status: 'disabled' } };
      })
      // 真实健康检查：连接MCP服务器执行initialize验证可用性
      .post('/:id/health-check', async ({ params: { id }, set }) => {
        const server = db.prepare('SELECT id, name, endpoint FROM ans_mcp_servers WHERE id = ?').get(id) as
          | { id: string; name: string; endpoint: string }
          | undefined;
        if (!server) throw notFound('MCP Server', id);

        const discovery = await discoverMcpServer(server.endpoint);

        if (discovery.success) {
          db.prepare(
            "UPDATE ans_mcp_servers SET status = 'active', health_check_at = datetime('now'), cached_tools = ?, cached_server_info = ? WHERE id = ?",
          ).run(JSON.stringify(discovery.tools), JSON.stringify(discovery.serverInfo ?? {}), id);
          return {
            data: {
              id,
              status: 'healthy',
              health_check_at: new Date().toISOString(),
              toolCount: discovery.tools.length,
              tools: discovery.tools.map((t) => t.name),
              serverInfo: discovery.serverInfo,
            },
          };
        }

        set.status = 502;
        return {
          data: {
            id,
            status: 'unhealthy',
            error: discovery.error,
          },
        };
      })
      // 手动刷新工具缓存
      .post('/:id/refresh', async ({ params: { id }, set }) => {
        const server = db.prepare('SELECT id, name, endpoint FROM ans_mcp_servers WHERE id = ?').get(id) as
          | { id: string; name: string; endpoint: string }
          | undefined;
        if (!server) throw notFound('MCP Server', id);

        const discovery = await discoverMcpServer(server.endpoint);

        if (discovery.success) {
          db.prepare(
            "UPDATE ans_mcp_servers SET status = 'active', cached_tools = ?, cached_server_info = ?, health_check_at = datetime('now') WHERE id = ?",
          ).run(JSON.stringify(discovery.tools), JSON.stringify(discovery.serverInfo ?? {}), id);
          return {
            data: {
              id,
              status: 'refreshed',
              toolCount: discovery.tools.length,
              tools: discovery.tools.map((t) => t.name),
              serverInfo: discovery.serverInfo,
            },
          };
        }

        set.status = 502;
        return { data: { id, status: 'refresh_failed', error: discovery.error } };
      })
      // 最优匹配（增强版：返回缓存工具列表，支持基于工具的精确匹配）
      .post(
        '/optimal',
        ({ body, request }) => {
          const resourceGroups = getResourceGroupsFromApiKey(db, request);
          let query =
            "SELECT id, name, endpoint, transport, auth_config, cached_tools, cached_server_info FROM ans_mcp_servers WHERE status = 'active'";
          const params: string[] = [];
          if (body.name) {
            query += ' AND name = ?';
            params.push(body.name);
          }
          // 8.1: 资源组过滤
          if (resourceGroups.length > 0) {
            query += ` AND (${resourceGroups.map(() => "resource_group = ? OR resource_group = '' OR resource_group IS NULL").join(' OR ')})`;
            resourceGroups.forEach((g) => params.push(g));
          }
          query += ' ORDER BY health_check_at DESC NULLS LAST LIMIT 1';
          const row = db.prepare(query).get(...params) as Record<string, unknown> | undefined;
          if (!row) throw notFound('MCP Server', body.name ?? 'any');

          const tools = safeJsonParse(row.cached_tools, []) as Array<{ name: string; description?: string }>;
          const serverInfo = safeJsonParse(row.cached_server_info, {});

          // 如果请求指定了tool requirements，进行工具级别的精确匹配
          let toolMatchScore = 0;
          if (body.toolName && tools.length > 0) {
            const matched = tools.find(
              (t) => t.name === body.toolName || t.name.toLowerCase().includes(body.toolName!.toLowerCase()),
            );
            toolMatchScore = matched ? 1 : 0;
          }

          return {
            data: {
              id: row.id,
              name: row.name,
              endpoint: row.endpoint,
              transport: row.transport,
              auth_config: parseJson(row.auth_config),
              cachedTools: tools,
              serverInfo,
              toolCount: tools.length,
              toolMatchScore,
            },
          };
        },
        {
          body: t.Object({
            name: t.Optional(t.String()),
            tags: t.Optional(t.Array(t.String())),
            toolName: t.Optional(t.String()),
          }),
        },
      )
  );
}

function formatMCP(row: Record<string, unknown>) {
  return {
    ...row,
    auth_config: parseJson(row.auth_config),
    cached_tools: safeJsonParse(row.cached_tools, []),
    cached_server_info: safeJsonParse(row.cached_server_info, {}),
  };
}

function parseJson(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function safeJsonParse(val: unknown, fallback: unknown): unknown {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  if (val === null || val === undefined) return fallback;
  return val;
}
