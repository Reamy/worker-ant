/**
 * zx_20260930 M15-⑥：`/mcp/message` 重名——「谁在跑」由白名单回答，不再由注册顺序回答。
 *
 * 病根：`mcp-gateway.ts` 的 `POST /mcp/:name`（动态段）与 `mcp-proxy.ts` 的 `POST /mcp/message`
 *   （静态段）同名。Elysia 实测**静态恒胜动态段，与注册顺序无关** ⇒ 动态段那支里那句
 *   「保留端点」是**够不着的死码**；而名字叫 `message` 的 MCP 服务器能落库、能被
 *   `/mcp/optimal` 选中，却**永远代理不到**——一种静默的「在册而不可达」。
 *
 * 三条判据：
 *   ① 保留名一处在册（`utils/mcp-reserved-names.ts`），入口（建/改）判死 ⇒ 不可达者进不了册；
 *   ② 网关那支死码**不在源码里**（G-5：读**原文**、锚**语句形状**——不 `stripComments`，
 *      故注释也一并避开该字面量，否则订正注释会把自己判红）；
 *   ③ "静态胜动态"这个事实**当场跑一遍**（组装两支真路由，POST /mcp/message 看谁接）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Elysia } from 'elysia';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_GATEWAY_RESERVED_NAMES,
  MCP_GATEWAY_RESERVED_REASON,
  isReservedMcpServerName,
} from '../utils/mcp-reserved-names.js';
import { mcpRoutes } from '../routes/mcp.js';
import { mcpProxyRoutes } from '../routes/mcp-proxy.js';
import { mcpGatewayRoutes } from '../routes/mcp-gateway.js';
import { handleRouteError } from '../utils/error-handler.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ans_mcp_servers (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, endpoint TEXT NOT NULL, transport TEXT DEFAULT 'streamable-http', auth_config TEXT DEFAULT '{"type":"none"}', status TEXT DEFAULT 'active', health_check_at TEXT, cached_tools TEXT DEFAULT '[]', cached_server_info TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE ans_audit_logs (id TEXT PRIMARY KEY, actor TEXT, action TEXT, resource_type TEXT, resource_id TEXT, detail TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
  `);
  return db;
}

describe('M15-⑥ 保留名在册（两侧标本）', () => {
  it('message 是保留名；普通名不是', () => {
    expect(isReservedMcpServerName('message')).toBe(true);
    expect(isReservedMcpServerName('filesystem')).toBe(false);
    expect(isReservedMcpServerName('Message')).toBe(false); // 大小写不同 ⇒ 不是同一段路径
    expect(isReservedMcpServerName(undefined)).toBe(false);
    expect(MCP_GATEWAY_RESERVED_NAMES).toContain('message');
  });

  it('理由文案说清"为什么不行"（点出保留名本身）', () => {
    expect(MCP_GATEWAY_RESERVED_REASON).toContain('message');
  });
});

describe('M15-⑥ 入口判死（真跑建/改）', () => {
  let db: Database.Database;
  // 类型由**构建表达式派生**（`models-routes.test.ts` 的成法）：`let app: Elysia` 是"裸泛型"，与带
  // 路由表的实例不同型（onStart 不兼容）⇒ 赋值处会 TS2322。派生型跟着 `.use()` 链走，不手抄。
  const buildApp = (d: Database.Database) => new Elysia().onError(handleRouteError).use(mcpRoutes(d));
  let app: ReturnType<typeof buildApp>;

  beforeAll(() => {
    db = makeDb();
    app = buildApp(db);
  });

  const post = (body: unknown) =>
    app.handle(
      new Request('http://localhost/api/v1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const put = (id: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost/api/v1/mcp/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const count = () => (db.prepare('SELECT COUNT(*) as c FROM ans_mcp_servers').get() as { c: number }).c;

  it('POST name=message → 400 且**一行都不落**（计数器正面断言）', async () => {
    const before = count();
    const res = await post({ name: 'message', endpoint: 'http://127.0.0.1:1/' });
    expect(res.status).toBe(400);
    expect(count()).toBe(before);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('message');
  });

  it('POST 普通名 → 201（行数 0→1；`discoverMcpServer` 对不可达端点是"如实失败"而非抛）', async () => {
    const before = count();
    const res = await post({ name: 'filesystem', endpoint: 'http://127.0.0.1:1/' });
    expect(res.status).toBe(201);
    expect(count()).toBe(before + 1);
    const body = (await res.json()) as { data: { name: string; discovery: { success: boolean } } };
    expect(body.data.name).toBe('filesystem');
    expect(body.data.discovery.success).toBe(false); // 端口 1 不可达 ⇒ 如实报失败
  });

  it('PUT 改名撞保留名 → 400 且**库里的名字没被改**', async () => {
    const id = (db.prepare("SELECT id FROM ans_mcp_servers WHERE name = 'filesystem'").get() as { id: string }).id;
    const res = await put(id, { name: 'message', endpoint: 'http://127.0.0.1:1/' });
    expect(res.status).toBe(400);
    const row = db.prepare('SELECT name FROM ans_mcp_servers WHERE id = ?').get(id) as { name: string };
    expect(row.name).toBe('filesystem');
  });
});

describe('M15-⑥ 网关死码不在源码里（G-5：读原文、锚语句形状）', () => {
  it('mcp-gateway.ts 的 POST /:name **不再**含 `name === "message"` 那支', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../routes/mcp-gateway.ts'), 'utf-8');
    // 该字面量在注释里也被刻意避开（订正注释若含它，这条断言会把自己判红）
    expect(src).not.toContain("name === 'message'");
    expect(src).not.toContain('name === "message"');
    // 正面：保留名收口到模块，源码里点得到它
    expect(src).toContain('mcp-reserved-names');
  });
});

describe('M15-⑥ 「静态胜动态」当场跑一遍（谁接 /mcp/message 有事实）', () => {
  it('同时挂两支真路由：POST /mcp/message 走 **mcp-proxy**（introspection），不走网关动态段', async () => {
    const db = makeDb();
    // 刻意把**网关（动态段）先挂**：若"谁在跑"取决于注册顺序，这里就该是网关赢。
    const app = new Elysia().onError(handleRouteError).use(mcpGatewayRoutes(db)).use(mcpProxyRoutes(db));

    const res = await app.handle(
      new Request('http://localhost/mcp/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } }; error?: { message: string } };
    // 网关那支对不存在的服务器名会回 -32000 `MCP server not found: message`；
    // 拿到 result 即证静态段赢了（与注册顺序无关）。
    expect(body.error).toBeUndefined();
    expect(body.result?.serverInfo?.name).toBe('ans-mcp-server');
  });
});
