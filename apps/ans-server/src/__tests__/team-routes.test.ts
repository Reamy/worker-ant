/**
 * zx_20261017_1 批六：**团队共享库** ANS 路由判据（R-31..R-33）。
 *
 * 为什么在 ans-server vitest 而不在 rr：这三条要的是**真 HMAC + 生产建表**——
 *   `deriveRequesterNodeId` 读的是 `ans_api_keys.resource_groups`，签名校验在 `hmacAuth`；
 *   桌面 rr 里造一个"等价"的身份头，证的是自造的等价物（G-1）。
 *
 * 身份用 `ApiKeyManager.createApiKey(name, resourceGroups)` 真发钥匙：
 *   两把节点钥匙（node:n-a / node:n-b）+ 一把非节点钥匙（外部终端/dev 形态）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Elysia } from 'elysia';
import { initDatabase } from '../db/schema.js';
import { ApiKeyManager, hmacAuth } from '../utils/security.js';
import { teamRoutes } from '../routes/team.js';
import { handleRouteError } from '../utils/error-handler.js';
import { createHmacSignature } from '@worker-ant/ans-client';
import { TEAM_ITEM_KINDS } from '@worker-ant/shared-types';

type Handle = { handle(r: Request): Response | Promise<Response> };
type Cred = { apiKey: string; secret: string };

describe('zx_20261017_1 批六 团队共享库（ANS）', () => {
  let db: Database.Database;
  let app: Handle;
  let nodeA: Cred;
  let nodeB: Cred;
  let plain: Cred;

  beforeAll(() => {
    db = initDatabase(':memory:');
    const km = new ApiKeyManager(db);
    nodeA = km.createApiKey('node-a', ['node:n-a']);
    nodeB = km.createApiKey('node-b', ['node:n-b']);
    plain = km.createApiKey('external', []);
    app = new Elysia().onError(handleRouteError).use(hmacAuth(db)).use(teamRoutes(db)) as unknown as Handle;
  });

  afterAll(() => {
    db.close();
  });

  const headers = (cred: Cred, bodyText = ''): Record<string, string> => {
    const ts = String(Date.now());
    return {
      'content-type': 'application/json',
      'x-api-key': cred.apiKey,
      'x-timestamp': ts,
      'x-signature': createHmacSignature(cred.secret, ts, bodyText),
    };
  };

  const call = async (
    method: string,
    path: string,
    cred: Cred,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: () => Promise<unknown> }> => {
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const r = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: headers(cred, bodyText),
        ...(body === undefined ? {} : { body: bodyText }),
      }),
    );
    const text = await r.text();
    return { status: r.status, text, json: async () => JSON.parse(text) as unknown };
  };

  const share = (cred: Cred, extra: Record<string, unknown> = {}) =>
    call('POST', '/api/v1/team/items', cred, {
      kind: 'template',
      title: '共享模板',
      body: { name: '共享模板', subtasks: [] },
      ...extra,
    });

  it('R-31 来源节点由凭据派生：body 里伪造 source_node_id 无效（反证：落库值 = 调用方）', async () => {
    const r = await share(nodeA, { source_node_id: 'n-b' });
    expect(r.status).toBe(201);
    const item = (await r.json()) as { data: { source_node_id: string; id: string } };
    expect(item.data.source_node_id).toBe('n-a');
    // 直接查库：落库值也只能是调用方（不是响应体哄人）。
    const row = db.prepare('SELECT source_node_id FROM ans_team_items WHERE id = ?').get(item.data.id) as {
      source_node_id: string;
    };
    expect(row.source_node_id).toBe('n-a');
  });

  it('R-31b 非节点凭据（外部终端/dev key）写 ⇒ 403，且不落行', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM ans_team_items').get() as { c: number }).c;
    const r = await share(plain);
    expect(r.status).toBe(403);
    expect(r.text).toContain('只有已注册工蚁节点');
    expect((db.prepare('SELECT COUNT(*) AS c FROM ans_team_items').get() as { c: number }).c).toBe(before);
  });

  it('R-32 删他人条目 ⇒ 403（条目仍在）；删自己的 ⇒ 成功', async () => {
    const r = await share(nodeA);
    const id = ((await r.json()) as { data: { id: string } }).data.id;

    const denied = await call('DELETE', `/api/v1/team/items/${id}`, nodeB);
    expect(denied.status).toBe(403);
    expect(db.prepare('SELECT 1 FROM ans_team_items WHERE id = ?').get(id)).toBeDefined();

    const gone = await call('DELETE', `/api/v1/team/items/${id}`, nodeA);
    expect(gone.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM ans_team_items WHERE id = ?').get(id)).toBeUndefined();
  });

  it('R-32b 删不存在的条目 ⇒ 404（与"他人的"分得开）', async () => {
    const r = await call('DELETE', '/api/v1/team/items/no-such-id', nodeA);
    expect(r.status).toBe(404);
  });

  it('R-33a 超长标题 ⇒ 400 且拒因含上限；不落行', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM ans_team_items').get() as { c: number }).c;
    const r = await share(nodeA, { title: 'x'.repeat(201) });
    expect(r.status).toBe(400);
    expect(r.text).toContain('上限 200');
    expect((db.prepare('SELECT COUNT(*) AS c FROM ans_team_items').get() as { c: number }).c).toBe(before);
  });

  it('R-33b 超 64KB 载荷 ⇒ 400 且拒因含上限；不落行', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM ans_team_items').get() as { c: number }).c;
    // 64KB 之上再多一点（按 UTF-8 字节算）。
    const r = await share(nodeA, { body: { blob: 'x'.repeat(64 * 1024) } });
    expect(r.status).toBe(400);
    expect(r.text).toContain('上限 65536');
    expect((db.prepare('SELECT COUNT(*) AS c FROM ans_team_items').get() as { c: number }).c).toBe(before);
  });

  it('R-33c 第 501 条 ⇒ 409；删一条后同一请求可写入（闸判的是条数，不是内容）', async () => {
    // 该节点清场后直接铺 500 行（配额判的是行数，不必走 500 次 HTTP）。
    db.prepare("DELETE FROM ans_team_items WHERE source_node_id = 'n-a'").run();
    const ins = db.prepare(
      "INSERT INTO ans_team_items (id, kind, title, body_json, source_node_id) VALUES (?, 'template', 'x', '{}', 'n-a')",
    );
    for (let i = 0; i < 500; i++) ins.run(`bulk-${i}`);

    const full = await share(nodeA);
    expect(full.status).toBe(409);
    expect(full.text).toContain('上限 500');

    db.prepare("DELETE FROM ans_team_items WHERE id = 'bulk-0'").run();
    const ok = await share(nodeA);
    expect(ok.status).toBe(201);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM ans_team_items WHERE source_node_id = 'n-a'").get() as { c: number }).c,
    ).toBe(500);
  });

  it('R-34 四类均可写入；未知类拒绝且拒因含全部类名（由 TEAM_ITEM_KINDS 派生）', async () => {
    for (const kind of TEAM_ITEM_KINDS) {
      const r = await share(nodeB, { kind, title: `共享-${kind}`, body: { marker: kind } });
      expect(r.status).toBe(201);
      const item = (await r.json()) as { data: { kind: string } };
      expect(item.data.kind).toBe(kind);
    }
    const count = () => (db.prepare('SELECT COUNT(*) AS c FROM ans_team_items').get() as { c: number }).c;
    const before = count();
    const bad = await share(nodeB, { kind: 'not_a_kind' });
    expect(bad.status).toBe(400);
    // 拒因由真源派生：新增一类不会留下"三选一"的旧话。
    for (const kind of TEAM_ITEM_KINDS) expect(bad.text).toContain(kind);
    expect(count()).toBe(before);
  });

  it('读面：按 kind 过滤 + 分页元信息（total 是条件命中总数）', async () => {
    const r = await call('GET', '/api/v1/team/items?kind=template&limit=2', nodeB);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: unknown[]; total: number; limit: number; has_more: boolean };
    expect(body.data.length).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.total).toBeGreaterThan(2);
    expect(body.has_more).toBe(true);
  });

  it('接线：`teamRoutes(db)` 挂在 index.ts 的 hmacApi 组（HMAC 路由组）', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../index.ts'), 'utf-8');
    const firstHmac = src.indexOf('.use(hmacAuth(db))');
    const mount = src.indexOf('.use(teamRoutes(db))');
    const secondGroup = src.indexOf('const hmacManagement');
    expect(firstHmac).toBeGreaterThanOrEqual(0);
    expect(mount).toBeGreaterThan(firstHmac);
    expect(mount).toBeLessThan(secondGroup);
  });
});
