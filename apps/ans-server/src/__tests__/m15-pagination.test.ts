/**
 * zx_20260930 M15-⑤：列表分页（models / skills / mcp / a2a / plugins）。
 *
 * 约定（刻意，与"静默截断"相反）：`limit` **缺省即全量** ⇒ 给既有阅读面凭空加一道上限，
 *   等于把"名实不符"从一处搬到另一处。插件市场是唯一例外（它**本来就是**硬 `LIMIT 100`，
 *   活库 748 个 active 插件静默只露 100）——那里补 `total`/`has_more` 把"还有多少"如实说出来。
 *
 * 判据两侧：
 *   - **缺省**：条数与加 pagination 之前**一模一样**（不引入截断）——这是本项最容易做坏的一面。
 *   - **显式**：`limit`/`offset` 生效，且 `total` 是**条件命中总数**（不随分页变小）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Elysia } from 'elysia';
import Database from 'better-sqlite3';
import { parsePagination, paginationClause, paginationArgs, pageMeta, MAX_PAGE_SIZE } from '../utils/pagination.js';
import { modelsRoutes } from '../routes/models.js';
import { skillsRoutes } from '../routes/skills.js';
import { mcpRoutes } from '../routes/mcp.js';
import { a2aRoutes } from '../routes/a2a.js';
import { pluginMarketplaceRoutes } from '../routes/plugin-marketplace.js';
import { handleRouteError } from '../utils/error-handler.js';

describe('M15-⑤ parsePagination（纯函数）', () => {
  it('缺省 limit = null（**不限**，SQL 不带 LIMIT）', () => {
    expect(parsePagination({})).toEqual({ limit: null, offset: 0 });
    expect(parsePagination(undefined)).toEqual({ limit: null, offset: 0 });
    expect(parsePagination(null)).toEqual({ limit: null, offset: 0 });
    expect(parsePagination({ limit: '' })).toEqual({ limit: null, offset: 0 });
  });

  it('可传 defaultLimit（插件市场用 100）', () => {
    expect(parsePagination({}, 100)).toEqual({ limit: 100, offset: 0 });
  });

  it('非法 limit 退回缺省（列表的读面不该因一个格式错整页失败）', () => {
    for (const bad of ['0', '0', '-5', 'abc', 'NaN']) {
      expect(parsePagination({ limit: bad }).limit).toBeNull();
    }
    expect(parsePagination({ limit: 0 }, 100)).toEqual({ limit: 100, offset: 0 });
  });

  it('limit 被 MAX_PAGE_SIZE 夹住（挡 limit=1e9 拖垮库）', () => {
    expect(parsePagination({ limit: '999999999' })).toEqual({ limit: MAX_PAGE_SIZE, offset: 0 });
    expect(parsePagination({ limit: '3' })).toEqual({ limit: 3, offset: 0 });
  });

  it('offset 单给也生效；负数/非数退回 0', () => {
    expect(parsePagination({ offset: '5' })).toEqual({ limit: null, offset: 5 });
    expect(parsePagination({ offset: -1 })).toEqual({ limit: null, offset: 0 });
    expect(parsePagination({ offset: 'x' })).toEqual({ limit: null, offset: 0 });
  });

  it('paginationClause / paginationArgs 成对（拼错一处就会静默错页）', () => {
    expect(paginationClause({ limit: null, offset: 0 })).toBe('');
    expect(paginationArgs({ limit: null, offset: 0 })).toEqual([]);
    expect(paginationClause({ limit: null, offset: 5 })).toBe(' LIMIT -1 OFFSET ?');
    expect(paginationArgs({ limit: null, offset: 5 })).toEqual([5]);
    expect(paginationClause({ limit: 10, offset: 5 })).toBe(' LIMIT ? OFFSET ?');
    expect(paginationArgs({ limit: 10, offset: 5 })).toEqual([10, 5]);
  });

  it('pageMeta：has_more 由 total 与「本次返回数」算（total 不随分页变小）', () => {
    expect(pageMeta(10, { limit: null, offset: 0 }, 10)).toEqual({
      total: 10,
      limit: null,
      offset: 0,
      has_more: false,
    });
    expect(pageMeta(10, { limit: 3, offset: 0 }, 3)).toEqual({ total: 10, limit: 3, offset: 0, has_more: true });
    expect(pageMeta(10, { limit: 3, offset: 9 }, 1)).toEqual({ total: 10, limit: 3, offset: 9, has_more: false });
  });
});

describe('M15-⑤ 路由层（真 SQL：缺省不改条数，显式才分页）', () => {
  let db: Database.Database;
  // 类型由**构建表达式派生**（`models-routes.test.ts` 的成法）：`let app: Elysia` 是"裸泛型"，与带
  // 路由表的实例不同型（onStart 不兼容）⇒ 赋值处会 TS2322。
  const buildApp = (d: Database.Database) =>
    new Elysia()
      .onError(handleRouteError)
      .use(modelsRoutes(d))
      .use(skillsRoutes(d))
      .use(mcpRoutes(d))
      .use(a2aRoutes(d))
      .use(pluginMarketplaceRoutes(d, { runGit: async () => {} }));
  let app: ReturnType<typeof buildApp>;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', source TEXT DEFAULT 'user', enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER DEFAULT 4096, max_output_tokens INTEGER DEFAULT 1024, input_price_per_1k REAL DEFAULT 0, output_price_per_1k REAL DEFAULT 0, status TEXT DEFAULT 'active', source TEXT DEFAULT 'user', description TEXT DEFAULT '', enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), health_check_at TEXT DEFAULT '', health_status TEXT DEFAULT '', last_latency_ms INTEGER DEFAULT 0);
      CREATE TABLE ans_audit_logs (id TEXT PRIMARY KEY, actor TEXT, action TEXT, resource_type TEXT, resource_id TEXT, detail TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_model_quality_logs (id TEXT PRIMARY KEY, model_id TEXT, project_id TEXT, task_type TEXT, capability TEXT, success INTEGER DEFAULT 1, output_accepted INTEGER DEFAULT 1, token_efficiency REAL, latency_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_billing_records (id TEXT PRIMARY KEY, endpoint_id TEXT, model_id TEXT, project_id TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0.0, currency TEXT DEFAULT 'USD', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_skills (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '', input_schema TEXT DEFAULT '{}', mcp_server_id TEXT, tags TEXT DEFAULT '[]', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_mcp_servers (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, endpoint TEXT NOT NULL, transport TEXT DEFAULT 'streamable-http', auth_config TEXT DEFAULT '{"type":"none"}', status TEXT DEFAULT 'active', health_check_at TEXT, cached_tools TEXT DEFAULT '[]', cached_server_info TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_a2a_servers (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, agent_card_url TEXT NOT NULL, capabilities TEXT DEFAULT '[]', auth_config TEXT DEFAULT '{"type":"none"}', status TEXT DEFAULT 'active', health_check_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_plugin_marketplaces (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, source_type TEXT NOT NULL, source_url TEXT NOT NULL, source_ref TEXT DEFAULT 'main', status TEXT DEFAULT 'active', auto_refresh INTEGER DEFAULT 1, last_refresh_at TEXT, created_at TEXT DEFAULT (datetime('now')), last_error TEXT DEFAULT '', last_error_at TEXT DEFAULT '');
      CREATE TABLE ans_plugins (id TEXT PRIMARY KEY, marketplace_id TEXT, name TEXT NOT NULL, version TEXT DEFAULT '0.1.0', display_name TEXT, description TEXT, description_zh TEXT, author TEXT, language TEXT DEFAULT 'zh', category TEXT, tags TEXT DEFAULT '[]', source_path TEXT, state TEXT DEFAULT 'available', installed_version TEXT, installed_at TEXT, user_config TEXT DEFAULT '{}', stars REAL DEFAULT 0, install_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_plugin_registrations (id TEXT PRIMARY KEY, plugin_id TEXT, resource_type TEXT NOT NULL, ans_resource_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    `);
    db.prepare(
      "INSERT INTO ans_ai_providers (id, name, base_url) VALUES ('p1', 'openai', 'https://api.openai.com')",
    ).run();
    for (const [i, nm] of ['m1', 'm2', 'm3'].entries()) {
      db.prepare(
        "INSERT INTO ans_ai_models (id, provider_id, name, capabilities) VALUES (?, 'p1', ?, '[\"chat\"]')",
      ).run(nm, `model-${nm}-${i}`);
    }
    db.prepare("INSERT INTO ans_skills (id, name, tags) VALUES ('s1', 'alpha', '[\"a\"]')").run();
    db.prepare("INSERT INTO ans_skills (id, name, tags) VALUES ('s2', 'beta', '[\"b\"]')").run();
    db.prepare("INSERT INTO ans_skills (id, name, tags) VALUES ('s3', 'gamma', '[\"a\"]')").run();
    db.prepare("INSERT INTO ans_mcp_servers (id, name, endpoint) VALUES ('c1', 'one', 'http://x')").run();
    db.prepare("INSERT INTO ans_mcp_servers (id, name, endpoint) VALUES ('c2', 'two', 'http://y')").run();
    db.prepare(
      "INSERT INTO ans_a2a_servers (id, name, agent_card_url) VALUES ('a1', 'one', 'http://x/agent.json')",
    ).run();
    db.prepare(
      "INSERT INTO ans_a2a_servers (id, name, agent_card_url) VALUES ('a2', 'two', 'http://y/agent.json')",
    ).run();
    db.prepare(
      "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url) VALUES ('mk1', 'demo', 'github', 'https://github.com/x/y')",
    ).run();
    for (const i of [1, 2, 3]) {
      // language='zh' ⇒ 后台翻译器 needs 为空，不触网（夹具不必依赖网络）
      db.prepare(
        "INSERT INTO ans_plugins (id, marketplace_id, name, language, description) VALUES (?, 'mk1', ?, 'zh', 'd')",
      ).run(`pl${i}`, `plugin-${i}`);
    }
    app = buildApp(db);
  });

  const get = async (path: string) => {
    const res = await app.handle(new Request(`http://localhost${path}`));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      data: Array<{ id: string }>;
      total: number;
      limit: number | null;
      offset: number;
      has_more: boolean;
    };
  };

  it('models：缺省不限 ⇒ 3 条全在 + total=3（**不引入静默截断**）', async () => {
    const r = await get('/api/v1/models');
    expect(r.data.length).toBe(3);
    expect(r.total).toBe(3);
    expect(r.limit).toBeNull();
    expect(r.has_more).toBe(false);
  });

  it('models：limit=1&offset=1 ⇒ 1 条，total 仍 3，has_more=true', async () => {
    const r = await get('/api/v1/models?limit=1&offset=1');
    expect(r.data.length).toBe(1);
    expect(r.total).toBe(3);
    expect(r.limit).toBe(1);
    expect(r.offset).toBe(1);
    expect(r.has_more).toBe(true);
  });

  it('skills：缺省 3 条；limit=2 ⇒ 2 条 + total=3 + has_more', async () => {
    expect((await get('/api/v1/skills')).data.length).toBe(3);
    const r = await get('/api/v1/skills?limit=2');
    expect(r.data.length).toBe(2);
    expect(r.total).toBe(3);
    expect(r.has_more).toBe(true);
  });

  it('skills?tags=a：total 是**过滤后**的全量（不是表全量）', async () => {
    const r = await get('/api/v1/skills?tags=a&limit=1');
    expect(r.data.length).toBe(1);
    expect(r.total).toBe(2); // s1/s3 带 tag a（不是表里的 3 条）
    expect(r.has_more).toBe(true);
  });

  it('mcp：缺省 2 条；limit=1 ⇒ total 仍 2', async () => {
    expect((await get('/api/v1/mcp')).data.length).toBe(2);
    const r = await get('/api/v1/mcp?limit=1');
    expect(r.data.length).toBe(1);
    expect(r.total).toBe(2);
  });

  it('a2a：缺省 2 条；limit=1 ⇒ total 仍 2', async () => {
    expect((await get('/api/v1/a2a')).data.length).toBe(2);
    const r = await get('/api/v1/a2a?limit=1');
    expect(r.data.length).toBe(1);
    expect(r.total).toBe(2);
  });

  it('plugins：缺省 limit=100（**沿用原硬上限**，不改 GUI 现阅读到的条数）+ total=3', async () => {
    const r = await get('/api/v1/plugins');
    expect(r.data.length).toBe(3);
    expect(r.total).toBe(3);
    expect(r.limit).toBe(100);
    expect(r.has_more).toBe(false);
  });

  it('plugins：limit=1 ⇒ 1 条 + total=3 + has_more=true（原来这些信息读不出来）', async () => {
    const r = await get('/api/v1/plugins?limit=1');
    expect(r.data.length).toBe(1);
    expect(r.total).toBe(3);
    expect(r.has_more).toBe(true);
  });

  it('plugins：search 过滤后的 total 与筛选同口径', async () => {
    const r = await get('/api/v1/plugins?search=plugin-2');
    expect(r.total).toBe(1);
    expect(r.data.length).toBe(1);
  });
});
