import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { notFound } from '../utils/errors.js';
import { AuditService } from '../services/audit.js';
import { discoverAgentCard, getAgentCardUrl } from '../services/a2a-discovery.js';
import { getResourceGroupsFromApiKey } from '../utils/security.js';
import { parsePagination, paginationClause, paginationArgs, pageMeta } from '../utils/pagination.js';

export function a2aRoutes(db: Database.Database) {
  const audit = new AuditService(db);

  return (
    new Elysia({ prefix: '/api/v1/a2a' })
      .get('/', ({ query }) => {
        // M15-⑤: 加 `limit`/`offset`/`total`（**缺省不限**——不给上限，就不改现有阅读面读到的条数）
        const page = parsePagination(query as Record<string, unknown>);
        const total = (
          db.prepare("SELECT COUNT(*) as c FROM ans_a2a_servers WHERE status != 'disabled'").get() as { c: number }
        ).c;
        const rows = db
          .prepare(
            `SELECT * FROM ans_a2a_servers WHERE status != 'disabled' ORDER BY created_at DESC${paginationClause(page)}`,
          )
          .all(...paginationArgs(page));
        return { data: rows, ...pageMeta(total, page, rows.length) };
      })
      .get('/:id', ({ params: { id } }) => {
        const row = db.prepare('SELECT * FROM ans_a2a_servers WHERE id = ?').get(id) as Record<string, unknown>;
        if (!row) throw notFound('A2A Server', id);
        return { data: formatA2A(row) };
      })
      .post(
        '/',
        async ({ body, set }) => {
          const id = randomUUID();
          const agentCardUrl = getAgentCardUrl(body.agent_card_url);
          const authConfig = body.auth_config ? JSON.stringify(body.auth_config) : '{"type":"none"}';

          // 自动发现Agent Card能力
          const discovery = await discoverAgentCard(agentCardUrl);
          const capabilities = discovery.success ? discovery.capabilities : (body.capabilities ?? []);

          db.prepare(
            'INSERT INTO ans_a2a_servers (id, name, agent_card_url, capabilities, auth_config, status, health_check_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            id,
            body.name,
            agentCardUrl,
            JSON.stringify(capabilities),
            authConfig,
            'active',
            discovery.success ? new Date().toISOString() : null,
          );

          audit.log({
            actor: 'api',
            action: 'create_a2a',
            resource_type: 'a2a_server',
            resource_id: id,
            detail: { name: body.name, autoDiscovered: discovery.success, capabilityCount: capabilities.length },
          });

          set.status = 201;
          return {
            data: {
              id,
              name: body.name,
              agent_card_url: agentCardUrl,
              capabilities,
              auth_config: body.auth_config ?? { type: 'none' },
              discovery: {
                success: discovery.success,
                skillNames: discovery.skillNames,
                inputModes: discovery.inputModes,
                outputModes: discovery.outputModes,
                error: discovery.error,
              },
            },
          };
        },
        {
          body: t.Object({
            name: t.String(),
            agent_card_url: t.String(),
            capabilities: t.Optional(t.Array(t.String())),
            auth_config: t.Optional(t.Object({ type: t.String(), token: t.Optional(t.String()) })),
          }),
        },
      )
      .put(
        '/:id',
        ({ params: { id }, body }) => {
          const existing = db.prepare('SELECT id FROM ans_a2a_servers WHERE id = ?').get(id);
          if (!existing) throw notFound('A2A Server', id);
          const authConfig = body.auth_config ? JSON.stringify(body.auth_config) : '{"type":"none"}';
          const agentCardUrl = body.agent_card_url;
          db.prepare(
            'UPDATE ans_a2a_servers SET name = ?, agent_card_url = ?, capabilities = ?, auth_config = ? WHERE id = ?',
          ).run(body.name, agentCardUrl, JSON.stringify(body.capabilities ?? []), authConfig, id);
          return { data: { id, ...body } };
        },
        {
          body: t.Object({
            name: t.String(),
            agent_card_url: t.String(),
            capabilities: t.Optional(t.Array(t.String())),
            auth_config: t.Optional(t.Object({ type: t.String(), token: t.Optional(t.String()) })),
          }),
        },
      )
      .delete('/:id', ({ params: { id } }) => {
        db.prepare('UPDATE ans_a2a_servers SET status = ?, health_check_at = NULL WHERE id = ?').run('disabled', id);
        return { data: { id, status: 'disabled' } };
      })
      // 真实健康检查：拉取Agent Card验证可用性
      .post('/:id/health-check', async ({ params: { id }, set }) => {
        const server = db
          .prepare('SELECT id, name, agent_card_url FROM ans_a2a_servers WHERE id = ? AND status = ?')
          .get(id, 'active') as { id: string; name: string; agent_card_url: string } | undefined;
        if (!server) throw notFound('A2A Server', id);

        const discovery = await discoverAgentCard(server.agent_card_url);

        if (discovery.success) {
          // 更新健康检查时间 + 同步最新capabilities
          db.prepare("UPDATE ans_a2a_servers SET health_check_at = datetime('now'), capabilities = ? WHERE id = ?").run(
            JSON.stringify(discovery.capabilities),
            id,
          );
          return {
            data: {
              id,
              status: 'healthy',
              health_check_at: new Date().toISOString(),
              capabilities: discovery.capabilities,
              skills: discovery.skillNames,
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
      // 最优匹配（增强版：基于自动发现的能力匹配 + 8.1资源组过滤）
      .post(
        '/optimal',
        ({ body, request }) => {
          const groups = getResourceGroupsFromApiKey(db, request);
          let a2aQuery =
            "SELECT id, name, agent_card_url, capabilities, auth_config, resource_group FROM ans_a2a_servers WHERE status = 'active'";
          const a2aParams: string[] = [];
          if (groups.length > 0) {
            a2aQuery += ` AND (${groups.map(() => "resource_group = ? OR resource_group = '' OR resource_group IS NULL").join(' OR ')})`;
            groups.forEach((rg) => a2aParams.push(rg));
          }
          a2aQuery += ' ORDER BY health_check_at DESC';
          const servers = db.prepare(a2aQuery).all(...a2aParams) as Array<Record<string, unknown>>;

          if (body.capabilities && body.capabilities.length > 0) {
            // 按匹配能力数量排序
            const scored = servers.map((s) => {
              const caps: string[] = safeParseCapabilities(s.capabilities);
              const hits = body.capabilities!.filter((c: string) =>
                caps.some(
                  (sc) => sc.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(sc.toLowerCase()),
                ),
              ).length;
              return { server: s, score: hits };
            });
            scored.sort((a, b) => b.score - a.score);
            if (scored.length > 0 && scored[0]!.score > 0) {
              return { data: formatA2A(scored[0]!.server), matchScore: scored[0]!.score };
            }
          }
          if (servers.length > 0) return { data: formatA2A(servers[0]!), matchScore: 0 };
          throw notFound('A2A Server', 'any');
        },
        {
          body: t.Object({ capabilities: t.Optional(t.Array(t.String())) }),
        },
      )
  );
}

function formatA2A(row: Record<string, unknown>) {
  return {
    ...row,
    capabilities: parseJson(row.capabilities),
    auth_config: parseJson(row.auth_config),
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

function safeParseCapabilities(val: unknown): string[] {
  const parsed = parseJson(val);
  if (Array.isArray(parsed)) return parsed as string[];
  return [];
}
