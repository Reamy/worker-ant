/**
 * zx_20261004 M1：**ANS 节点注册表 + 自助注册（令牌换 key）** 的判据。
 *
 * 两条腿（缺一即假绿，承 auto-memory `feedback_equivalence_needs_wiring_criterion`）：
 *   ① **真跑**：令牌闸（一次性/过期/用尽/不存在各自一句）→ 签发 key → 落 `ans_nodes`；
 *      且**签发出的 key 真能过 `hmacAuth`**（心跳 200）——这是"注册真的接上了"的唯一硬证据。
 *   ② **接线**：`index.ts` 里注册端点在**公开组**、其余节点端点在 **hmacApi 组**（按语句形状切）。
 *
 * ⚠ 本文件刻意用**生产 `initDatabase(':memory:')`** 建表（而非手写 DDL）：
 *   auto-memory `feedback_rr_fixture_production_order` 的教训——夹具自建 DDL 从不跑真建表逻辑，
 *   则"表/索引/迁移顺序"缺陷照不出。这里跑的就是生产那一份 DDL。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Elysia } from 'elysia';
import { initDatabase } from '../db/schema.js';
import { hmacAuth } from '../utils/security.js';
import { nodeEnrollRoute, nodesRoutes } from '../routes/nodes.js';
import { a2aAgentCardRoute } from '../routes/a2a-proxy.js';
import { handleRouteError } from '../utils/error-handler.js';
import { createHmacSignature } from '@worker-ant/ans-client';

const DEV_KEY = 'dev-key';
const DEV_SECRET = 'dev-secret';

type Handle = { handle(r: Request): Response | Promise<Response> };

describe('M1 节点注册表 + 自助注册', () => {
  let db: Database.Database;
  let enrollmentApp: Handle;
  let guardedApp: Handle;
  const prevApiKeys = process.env.ANS_API_KEYS;

  beforeAll(() => {
    db = initDatabase(':memory:');
    process.env.ANS_API_KEYS = `${DEV_KEY}:${DEV_SECRET}`;
    enrollmentApp = new Elysia().onError(handleRouteError).use(nodeEnrollRoute(db)) as unknown as Handle;
    guardedApp = new Elysia().onError(handleRouteError).use(hmacAuth(db)).use(nodesRoutes(db)) as unknown as Handle;
  });

  afterAll(() => {
    if (prevApiKeys === undefined) delete process.env.ANS_API_KEYS;
    else process.env.ANS_API_KEYS = prevApiKeys;
    db.close();
  });

  /** 用开发态身份（ANS_API_KEYS env 那一对）签头——令牌台端点须 HMAC。 */
  const devHeaders = (bodyText = ''): Record<string, string> => {
    const ts = String(Date.now());
    return {
      'content-type': 'application/json',
      'x-api-key': DEV_KEY,
      'x-timestamp': ts,
      'x-signature': createHmacSignature(DEV_SECRET, ts, bodyText),
    };
  };

  const call = async (
    app: Handle,
    method: string,
    path: string,
    headers: Record<string, string>,
    bodyText?: string,
  ): Promise<{ status: number; text: string; json: () => Promise<unknown> }> => {
    const r = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      }),
    );
    const text = await r.text();
    return { status: r.status, text, json: async () => JSON.parse(text) as unknown };
  };

  /** 走**真令牌台端点**签一枚令牌（不是直接插库——那样测不到令牌台本身）。 */
  const mintToken = async (opts: { max_uses?: number; expires_in_sec?: number } = {}): Promise<string> => {
    const bodyText = JSON.stringify(opts);
    const r = await call(guardedApp, 'POST', '/api/v1/nodes/enrollment-tokens', devHeaders(bodyText), bodyText);
    expect(r.status).toBe(201);
    const token = ((await r.json()) as { data: { token: string } }).data.token;
    expect(typeof token).toBe('string');
    return token;
  };

  const register = (body: Record<string, unknown>) => {
    const bodyText = JSON.stringify(body);
    return call(enrollmentApp, 'POST', '/api/v1/nodes/register', { 'content-type': 'application/json' }, bodyText);
  };

  const nodeHeaders = (apiKey: string, secret: string, bodyText = ''): Record<string, string> => {
    const ts = String(Date.now());
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-timestamp': ts,
      'x-signature': createHmacSignature(secret, ts, bodyText),
    };
  };

  it('未登记令牌 ⇒ 403 Invalid enrollment token（不是 401/404）', async () => {
    const r = await register({ enrollment_token: 'nope-nope-nope', node_id: 'n-x' });
    expect(r.status).toBe(403);
    expect(r.text).toContain('Invalid enrollment token');
  });

  it('★ 过期令牌 ⇒ 403 expired（与「用尽」「不存在」分得开）', async () => {
    const token = await mintToken({ expires_in_sec: -10 }); // 10 秒前即过期
    const r = await register({ enrollment_token: token, node_id: 'n-expired' });
    expect(r.status).toBe(403);
    expect(r.text).toContain('Enrollment token expired');
    expect(r.text).not.toContain('Invalid enrollment token');
  });

  it('★★★ 往返：令牌换 key ⇒ 201，且**签发出的 key 真能过 hmacAuth**（心跳 200）', async () => {
    const token = await mintToken({ max_uses: 1 });
    const reg = await register({ enrollment_token: token, node_id: 'n-e2e', name: 'e2e-node', platform: 'test/arm64' });
    expect(reg.status).toBe(201);
    const body = (await reg.json()) as { node_id: string; api_key: string; secret: string; resource_group: string };
    expect(body.node_id).toBe('n-e2e');
    expect(body.resource_group).toBe('node:n-e2e'); // K-5 一节点一资源组
    expect(body.api_key.startsWith('wa_')).toBe(true);
    expect(body.secret.length).toBeGreaterThan(0);

    // 真跳：用返回的 key/secret 签一个心跳。若 key 没落进 ans_api_keys 或没带 secret_enc ⇒ 这里 401。
    const hbText = JSON.stringify({ node_id: 'n-e2e', status: { os: 'test', busy: 0.25 } });
    const hb = await call(
      guardedApp,
      'POST',
      '/api/v1/nodes/heartbeat',
      nodeHeaders(body.api_key, body.secret, hbText),
      hbText,
    );
    expect([hb.status, hb.text.includes('"node_id":"n-e2e"')]).toEqual([200, true]);
  });

  it('★★ 一次性令牌：同一枚第二次换 key ⇒ 403 exhausted', async () => {
    const token = await mintToken({ max_uses: 1 });
    const first = await register({ enrollment_token: token, node_id: 'n-once-1' });
    expect(first.status).toBe(201);
    const second = await register({ enrollment_token: token, node_id: 'n-once-2' });
    expect(second.status).toBe(403);
    expect(second.text).toContain('Enrollment token exhausted');
  });

  it('重复 node_id ⇒ 409（另一枚有效令牌也不行）', async () => {
    const t1 = await mintToken();
    const a = await register({ enrollment_token: t1, node_id: 'n-dup' });
    expect(a.status).toBe(201);
    const t2 = await mintToken();
    const b = await register({ enrollment_token: t2, node_id: 'n-dup' });
    expect(b.status).toBe(409);
    expect(b.text).toContain('already registered');
  });

  it('★ 心跳：last_seen_at 由 NULL 变非空 + status_json 存入（0→1 正面断言）', async () => {
    const token = await mintToken();
    const reg = await register({ enrollment_token: token, node_id: 'n-hb', name: 'hb-node' });
    expect(reg.status).toBe(201);
    const { api_key, secret } = (await reg.json()) as { api_key: string; secret: string };

    const before = db.prepare('SELECT last_seen_at, status_json FROM ans_nodes WHERE node_id = ?').get('n-hb') as {
      last_seen_at: string | null;
      status_json: string;
    };
    expect(before.last_seen_at).toBeNull(); // 0
    expect(before.status_json).toBe('{}');

    const hbText = JSON.stringify({ node_id: 'n-hb', status: { cpu: 0.4, mem_free: 123 } });
    const hb = await call(guardedApp, 'POST', '/api/v1/nodes/heartbeat', nodeHeaders(api_key, secret, hbText), hbText);
    expect(hb.status).toBe(200);

    const after = db.prepare('SELECT last_seen_at, status_json FROM ans_nodes WHERE node_id = ?').get('n-hb') as {
      last_seen_at: string | null;
      status_json: string;
    };
    expect(after.last_seen_at).not.toBeNull(); // 0→1
    expect(JSON.parse(after.status_json)).toEqual({ cpu: 0.4, mem_free: 123 });
  });

  it('未注册节点心跳 ⇒ 404（"认不得的节点"不是"已收到"）', async () => {
    const bodyText = JSON.stringify({ node_id: 'n-ghost', status: {} });
    const r = await call(guardedApp, 'POST', '/api/v1/nodes/heartbeat', devHeaders(bodyText), bodyText);
    expect(r.status).toBe(404);
  });

  it('★★ 列表：缺省只列 active、role 缺省 worker、participate=true（缺省档如实在上屏）', async () => {
    const token = await mintToken();
    await register({ enrollment_token: token, node_id: 'n-list', name: 'list-node' });
    const r = await call(guardedApp, 'GET', '/api/v1/nodes', devHeaders());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: Array<{ node_id: string; role: string; participate: boolean; capabilities: string[]; status: unknown }>;
      total: number;
    };
    const row = body.data.find((n) => n.node_id === 'n-list');
    expect(row).toBeDefined();
    expect(row?.role).toBe('worker');
    expect(row?.participate).toBe(true);
    expect(row?.capabilities).toEqual([]);
  });

  it('★★ PATCH：非法 role ⇒ 400；合法改档生效且 participate=false 如实反映（以本机节点身份）', async () => {
    const token = await mintToken();
    const reg = await register({ enrollment_token: token, node_id: 'n-patch', name: 'patch-node' });
    const { api_key, secret } = (await reg.json()) as { api_key: string; secret: string };

    const badText = JSON.stringify({ role: 'overlord' });
    const bad = await call(
      guardedApp,
      'PATCH',
      '/api/v1/nodes/n-patch',
      nodeHeaders(api_key, secret, badText),
      badText,
    );
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('Invalid node role');

    const okText = JSON.stringify({ role: 'observer', weight: 2.5, participate: false, name: 'renamed' });
    const ok = await call(guardedApp, 'PATCH', '/api/v1/nodes/n-patch', nodeHeaders(api_key, secret, okText), okText);
    expect(ok.status).toBe(200);
    const { data } = (await ok.json()) as {
      data: { role: string; weight: number; participate: boolean; name: string };
    };
    expect([data.role, data.weight, data.participate, data.name]).toEqual(['observer', 2.5, false, 'renamed']);
  });

  it('未知 node_id 改档 ⇒ 404（以已入网节点身份）', async () => {
    const token = await mintToken();
    const reg = await register({ enrollment_token: token, node_id: 'n-known', name: 'known-node' });
    const { api_key, secret } = (await reg.json()) as { api_key: string; secret: string };
    const bodyText = JSON.stringify({ role: 'worker' });
    const r = await call(
      guardedApp,
      'PATCH',
      '/api/v1/nodes/n-absent',
      nodeHeaders(api_key, secret, bodyText),
      bodyText,
    );
    expect(r.status).toBe(404);
  });

  it('令牌台：签发 → 列表可见 → 吊销 → 再删 404', async () => {
    const token = await mintToken({ max_uses: 3 });
    const list = await call(guardedApp, 'GET', '/api/v1/nodes/enrollment-tokens', devHeaders());
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: Array<{ token: string; max_uses: number }> }).data;
    expect(rows.find((t) => t.token === token)?.max_uses).toBe(3);

    const del = await call(guardedApp, 'DELETE', `/api/v1/nodes/enrollment-tokens/${token}`, devHeaders());
    expect(del.status).toBe(200);
    const del2 = await call(guardedApp, 'DELETE', `/api/v1/nodes/enrollment-tokens/${token}`, devHeaders());
    expect(del2.status).toBe(404);
  });

  it('① 接线：注册端点在公开组、其余节点端点在 hmacApi 组（按语句形状切，非子串）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf-8');
    const startHmacApi = src.indexOf('const hmacApi = new Elysia()');
    const startManagement = src.indexOf('const hmacManagement = new Elysia()');
    const startApp = src.indexOf('const app = new Elysia(');
    // 锚点自证：锚点改名会让 indexOf 返回 -1 ⇒ 下面各段变空、断言会"空转通过"。故在此判死。
    expect(startHmacApi).toBeGreaterThanOrEqual(0);
    expect(startManagement).toBeGreaterThan(startHmacApi);
    expect(startApp).toBeGreaterThan(startManagement);
    const hmacApiSeg = src.slice(startHmacApi, startManagement);
    const appSeg = src.slice(startApp);
    // 切对了段（非空、确实是那一组）
    expect(hmacApiSeg).toContain('mcpProxyRoutes(db)');
    expect(appSeg).toContain('.use(hmacManagement)');
    // ① 其余节点端点在 hmacApi 组内，且**不在**公开的 app 段内
    expect(hmacApiSeg).toContain('nodesRoutes(db)');
    expect(appSeg).not.toContain('nodesRoutes(db)');
    // ② 注册端点在公开组（app 段）内，且**不在** hmacApi 段内
    expect(appSeg).toContain('nodeEnrollRoute(db)');
    expect(hmacApiSeg).not.toContain('nodeEnrollRoute(');
  });
});

/**
 * M11（能力卡类目级登记/曝光）+ M12（中转队列：提交/选目标/拉取/回传）。
 *
 * 全部**真跑**生产路由（`initDatabase(':memory:')` 建表 + 真 HMAC 头），不手写 DDL、不 mock 库——
 * 承 auto-memory `feedback_rr_fixture_production_order`（夹具自建 DDL 照不出"表/索引顺序"缺陷）。
 * 两侧标本：该分配/不该分配、该拒绝/该放行，各一侧。
 */
describe('M11/M12 能力卡曝光 + 中转队列', () => {
  let db: Database.Database;
  let enrollmentApp: Handle;
  let guardedApp: Handle;
  let cardApp: Handle;
  const prevApiKeys = process.env.ANS_API_KEYS;

  // 逐例新建内存库：**隔离**是判据成立的前提——否则"无合适节点 ⇒ pending"会被前例 enroll 的
  // 在线同名类目节点污染；且 `datetime('now')` 只到秒，同权重的两个在线节点 last_seen_at 相等 ⇒
  // `selectTargetNode` 的 `weight DESC, last_seen_at DESC` 退化为任意序，"该选谁"的断言就成了掷硬币。
  beforeEach(() => {
    db = initDatabase(':memory:');
    process.env.ANS_API_KEYS = `${DEV_KEY}:${DEV_SECRET}`;
    enrollmentApp = new Elysia().onError(handleRouteError).use(nodeEnrollRoute(db)) as unknown as Handle;
    guardedApp = new Elysia().onError(handleRouteError).use(hmacAuth(db)).use(nodesRoutes(db)) as unknown as Handle;
    cardApp = new Elysia().use(a2aAgentCardRoute()) as unknown as Handle;
  });

  afterEach(() => {
    if (prevApiKeys === undefined) delete process.env.ANS_API_KEYS;
    else process.env.ANS_API_KEYS = prevApiKeys;
    db.close();
  });

  const devHeaders = (bodyText = ''): Record<string, string> => {
    const ts = String(Date.now());
    return {
      'content-type': 'application/json',
      'x-api-key': DEV_KEY,
      'x-timestamp': ts,
      'x-signature': createHmacSignature(DEV_SECRET, ts, bodyText),
    };
  };
  const keyHeaders = (apiKey: string, secret: string, bodyText = ''): Record<string, string> => {
    const ts = String(Date.now());
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-timestamp': ts,
      'x-signature': createHmacSignature(secret, ts, bodyText),
    };
  };
  const call = async (
    app: Handle,
    method: string,
    path: string,
    headers: Record<string, string>,
    bodyText?: string,
  ): Promise<{ status: number; json: () => Promise<any> }> => {
    const r = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      }),
    );
    const text = await r.text();
    return { status: r.status, json: async () => JSON.parse(text) };
  };

  const mintToken = async (): Promise<string> => {
    const bodyText = JSON.stringify({ max_uses: 10 });
    const r = await call(guardedApp, 'POST', '/api/v1/nodes/enrollment-tokens', devHeaders(bodyText), bodyText);
    expect(r.status).toBe(201);
    return (await r.json()).data.token as string;
  };

  /** 注册一个节点并（可选）用一次心跳把卡上送 + last_seen_at 置活。返回它自己的 key/secret。
   *  `status` 可注入（zx_20261011 M2：负载选目标须造"忙/闲不同"的标本，故 status 必须可定制）。 */
  const enrollNode = async (
    nodeId: string,
    card?: { name: string; node_id: string; platform: string; categories: string[] },
    patch?: Record<string, unknown>,
    status?: Record<string, unknown>,
  ) => {
    const token = await mintToken();
    const regText = JSON.stringify({ enrollment_token: token, node_id: nodeId, name: nodeId });
    const reg = await call(
      enrollmentApp,
      'POST',
      '/api/v1/nodes/register',
      { 'content-type': 'application/json' },
      regText,
    );
    expect(reg.status).toBe(201);
    const { api_key, secret } = (await reg.json()) as { api_key: string; secret: string };
    if (patch) {
      const pText = JSON.stringify(patch);
      // zx_20261017_1 批四：改档身份由凭据派生 ⇒ 用自己的 key 改自己（注册后即可，无需等心跳）。
      const p = await call(guardedApp, 'PATCH', `/api/v1/nodes/${nodeId}`, keyHeaders(api_key, secret, pText), pText);
      expect(p.status).toBe(200);
    }
    if (card) {
      const hbText = JSON.stringify({ node_id: nodeId, status: status ?? { os: 'test' }, card });
      const hb = await call(guardedApp, 'POST', '/api/v1/nodes/heartbeat', keyHeaders(api_key, secret, hbText), hbText);
      expect(hb.status).toBe(200);
    }
    return { apiKey: api_key, secret };
  };

  const submit = (category: string, payload?: Record<string, unknown>) => {
    const bodyText = JSON.stringify({ category, ...(payload ? { payload } : {}) });
    return call(guardedApp, 'POST', '/api/v1/nodes/requests', devHeaders(bodyText), bodyText);
  };

  /** 提交时**指定目标**（zx_20261011 M2）。 */
  const submitTo = (category: string, targetNodeId: string, payload?: Record<string, unknown>) => {
    const bodyText = JSON.stringify({ category, target_node_id: targetNodeId, ...(payload ? { payload } : {}) });
    return call(guardedApp, 'POST', '/api/v1/nodes/requests', devHeaders(bodyText), bodyText);
  };

  /** 以**某节点自己的 key** 提交（zx_20261011 M1：请求方身份的派生与读回）。 */
  const submitAs = (apiKey: string, secret: string, category: string, payload?: Record<string, unknown>) => {
    const bodyText = JSON.stringify({ category, ...(payload ? { payload } : {}) });
    return call(guardedApp, 'POST', '/api/v1/nodes/requests', keyHeaders(apiKey, secret, bodyText), bodyText);
  };

  /** 造一张卡（categories 需与 node_id 一致才便于断言）。 */
  const card = (id: string, categories: string[]) => ({ name: id, node_id: id, platform: 'test/x', categories });

  it('M11-① 公开卡：既有三技能**不动** + 新增 ans_nodes 占位（只增不改）', async () => {
    const r = await call(cardApp, 'GET', '/a2a/.well-known/agent.json', {});
    expect(r.status).toBe(200);
    const ids = ((await r.json()).skills as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['ans_chat', 'ans_discover', 'ans_task']));
    expect(ids).toContain('ans_nodes');
  });

  it('M11-② 卡随心跳落库并在 GET /nodes 曝光（两侧标本：无卡 / 有卡原样）', async () => {
    await enrollNode('n-nocard');
    await enrollNode('n-withcard', {
      name: 'n-withcard',
      node_id: 'n-withcard',
      platform: 'darwin/arm64',
      categories: ['text', 'code', 'device'],
    });
    const r = await call(guardedApp, 'GET', '/api/v1/nodes', devHeaders());
    expect(r.status).toBe(200);
    const rows = (await r.json()).data as Array<{ node_id: string; card: Record<string, unknown> }>;
    const noCard = rows.find((n) => n.node_id === 'n-nocard');
    const withCard = rows.find((n) => n.node_id === 'n-withcard');
    expect(noCard?.card.categories).toBeUndefined(); // 从没送过卡
    expect(withCard?.card.categories).toEqual(['text', 'code', 'device']); // 原样曝光
    expect(withCard?.card.platform).toBe('darwin/arm64');
  });

  it('M12-① 非法类目 ⇒ 400（不落一行待办）', async () => {
    const r = await submit('not-a-category');
    expect(r.status).toBe(400);
  });

  it('M12-② 两侧标本：无合适节点 ⇒ pending(target NULL)；类目命中的在线可派节点 ⇒ assigned', async () => {
    // 该侧一：此刻台账无一台能做 'media' 的在线节点 ⇒ 落 pending、不伪造目标。
    const none = await submit('media', { prompt: 'x' });
    expect(none.status).toBe(201);
    const noneRow = (await none.json()).data as { status: string; target_node_id: string | null };
    expect(noneRow.status).toBe('pending');
    expect(noneRow.target_node_id).toBeNull();

    // 该侧二：让**唯一**一台能 code 的节点上线（心跳带卡），再提交 code 类目 —— 唯一 ⇒ 目标无歧义。
    await enrollNode('n-capable', {
      name: 'n-capable',
      node_id: 'n-capable',
      platform: 'linux/x64',
      categories: ['text', 'code'],
    });
    const hit = await submit('code', { prompt: 'y' });
    expect(hit.status).toBe(201);
    const hitRow = (await hit.json()).data as {
      status: string;
      target_node_id: string | null;
      requester_key_prefix: string;
    };
    expect(hitRow.status).toBe('assigned');
    expect(hitRow.target_node_id).toBe('n-capable');
    expect(hitRow.requester_key_prefix).toBe(DEV_KEY.slice(0, 8)); // 仅前缀
  });

  it('zx_20261017_1 批一：require_target ⇒ 无合格目标 409 且**不落行**（自动外派不造悬空单）', async () => {
    // 该侧一：此刻无一台在线可派节点能做 'media' ⇒ 拒绝，且台账行数不变（不落 pending）。
    const before = (db.prepare('SELECT COUNT(*) AS n FROM ans_node_requests').get() as { n: number }).n;
    const refusedText = JSON.stringify({ category: 'media', payload: { prompt: 'zz' }, require_target: true });
    const refused = await call(guardedApp, 'POST', '/api/v1/nodes/requests', devHeaders(refusedText), refusedText);
    expect(refused.status).toBe(409);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM ans_node_requests').get() as { n: number }).n;
    expect(after).toBe(before);

    // 该侧二：有可派节点 ⇒ 照常 201/assigned（"无目标即挂起"的既有语义仅对**未置位**者保留）。
    await enrollNode('n-require-target', {
      name: 'n-require-target',
      node_id: 'n-require-target',
      platform: 'test/x',
      categories: ['text', 'code'],
    });
    const okText = JSON.stringify({ category: 'code', require_target: true });
    const accepted = await call(guardedApp, 'POST', '/api/v1/nodes/requests', devHeaders(okText), okText);
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()).data as { status: string }).status).toBe('assigned');
  });

  it('zx_20261011_1 M1 许可闸：注册带 participate=false ⇒ 落 0 且**不进候选**（闸真有齿）；省略 ⇒ 落 1（向后兼容）', async () => {
    // 该侧一（闸有齿）：一台**在线的、卡含 project_task** 的节点，注册时即报 participate=false。
    //   ⇒ GET /nodes 如实回 false；此后提交该类目**不该**被派给它（唯一可选者已退出）。
    const t1 = await mintToken();
    const regNo = JSON.stringify({ enrollment_token: t1, node_id: 'n-nopart', name: 'n-nopart', participate: false });
    const r1 = await call(
      enrollmentApp,
      'POST',
      '/api/v1/nodes/register',
      { 'content-type': 'application/json' },
      regNo,
    );
    expect(r1.status).toBe(201);
    const { api_key: k1, secret: s1 } = (await r1.json()) as { api_key: string; secret: string };
    const hb1 = JSON.stringify({ node_id: 'n-nopart', card: card('n-nopart', ['project_task']) });
    expect((await call(guardedApp, 'POST', '/api/v1/nodes/heartbeat', keyHeaders(k1, s1, hb1), hb1)).status).toBe(200);

    const rows0 = (
      (await (await call(guardedApp, 'GET', '/api/v1/nodes', devHeaders())).json()) as {
        data: Array<{ node_id: string; participate: boolean }>;
      }
    ).data;
    expect(rows0.find((n) => n.node_id === 'n-nopart')?.participate).toBe(false);

    const pending = await submit('project_task', { prompt: 'p' });
    expect((await pending.json()).data.status).toBe('pending'); // 唯一能做者已退出 ⇒ 无目标，不伪造

    // 该侧二（向后兼容 + 只是这台才被选）：另一台省略 participate（旧客户端形态）⇒ 缺省落 1，
    //   仍是**唯一**参与且能做的节点 ⇒ 目标无歧义地是它。
    await enrollNode('n-yespart', {
      name: 'n-yespart',
      node_id: 'n-yespart',
      platform: 'x',
      categories: ['project_task'],
    });
    const rows1 = (
      (await (await call(guardedApp, 'GET', '/api/v1/nodes', devHeaders())).json()) as {
        data: Array<{ node_id: string; participate: boolean }>;
      }
    ).data;
    expect(rows1.find((n) => n.node_id === 'n-yespart')?.participate).toBe(true); // 省略 ⇒ 1

    const hit = await submit('project_task', { prompt: 'p2' });
    expect((await hit.json()).data.target_node_id).toBe('n-yespart'); // n-nopart 未被选（闸生效）
  });

  it('M12-③ 越权拉取 ⇒ 403；本节点自己的 key ⇒ 200，且**不认领卡外类目**的积压件', async () => {
    const { apiKey, secret } = await enrollNode('n-puller', {
      name: 'n-puller',
      node_id: 'n-puller',
      platform: 'x',
      categories: ['code'],
    });
    // 先放一件 n-puller 卡类目**之外**（media）的积压件——它来拉时**不该**顺手认领。
    const media = await submit('media', { prompt: 'm' });
    const mediaId = (await media.json()).data.id as string;

    // DEV_KEY 未绑 `node:n-puller` ⇒ 换 node_id 也读不走他人待办。
    const forbidden = await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-puller', devHeaders());
    expect(forbidden.status).toBe(403);

    const mine = await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-puller', keyHeaders(apiKey, secret));
    expect(mine.status).toBe(200);
    const rows = (await mine.json()).data as Array<{ id: string; target_node_id: string }>;
    expect(rows.every((r) => r.target_node_id === 'n-puller')).toBe(true); // 只回自己的
    expect(rows.some((r) => r.id === mediaId)).toBe(false); // 卡外类目未被认领
    const still = db.prepare('SELECT target_node_id, status FROM ans_node_requests WHERE id = ?').get(mediaId) as {
      target_node_id: string | null;
      status: string;
    };
    expect(still.target_node_id).toBeNull(); // 仍 pending、无主
    expect(still.status).toBe('pending');
  });

  it('M12-④ 状态机流转 pending → assigned：节点上线后来拉即认领（否则 pending 是死档）', async () => {
    const pending = await submit('device', { prompt: 'z' });
    expect((await pending.json()).data.status).toBe('pending');
    // 一台能做 device 的节点随后上线并来拉 ⇒ 该件应被认领（target = 它、status = assigned）。
    const { apiKey, secret } = await enrollNode('n-later', {
      name: 'n-later',
      node_id: 'n-later',
      platform: 'x',
      categories: ['device'],
    });
    const poll = await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-later', keyHeaders(apiKey, secret));
    expect(poll.status).toBe(200);
    const rows = (await poll.json()).data as Array<{ category: string; status: string; target_node_id: string }>;
    const claimed = rows.find((r) => r.category === 'device');
    expect(claimed?.target_node_id).toBe('n-later');
    expect(claimed?.status).toBe('assigned');
  });

  it('M12-⑤ 拉取即记 claimed_at（0→1 正面断言）', async () => {
    const { apiKey, secret } = await enrollNode('n-claim', {
      name: 'n-claim',
      node_id: 'n-claim',
      platform: 'x',
      categories: ['research'],
    });
    const created = await submit('research', { prompt: 'r' });
    const id = (await created.json()).data.id as string;
    const before = db.prepare('SELECT claimed_at FROM ans_node_requests WHERE id = ?').get(id) as {
      claimed_at: string | null;
    };
    expect(before.claimed_at).toBeNull(); // 0
    await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-claim', keyHeaders(apiKey, secret));
    const after = db.prepare('SELECT claimed_at FROM ans_node_requests WHERE id = ?').get(id) as {
      claimed_at: string | null;
    };
    expect(after.claimed_at).not.toBeNull(); // 0→1
  });

  it('M12-⑥ 越权回传 ⇒ 403；目标节点回传 ⇒ done + done_at 非空，且随即从待办消失', async () => {
    const { apiKey, secret } = await enrollNode('n-report', {
      name: 'n-report',
      node_id: 'n-report',
      platform: 'x',
      categories: ['code'],
    });
    const created = await submit('code', { prompt: 'r' });
    const id = (await created.json()).data.id as string;
    expect((await created.json()).data.target_node_id).toBe('n-report');
    await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-report', keyHeaders(apiKey, secret)); // 认领（记 claimed_at）

    // 越权：冒用别的 node_id。
    const badText = JSON.stringify({ node_id: 'n-other', status: 'done', result: { ok: 1 } });
    const bad = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/result`,
      keyHeaders(apiKey, secret, badText),
      badText,
    );
    expect(bad.status).toBe(403);

    const okText = JSON.stringify({ node_id: 'n-report', status: 'done', result: { summary: 'done!' } });
    const ok = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/result`,
      keyHeaders(apiKey, secret, okText),
      okText,
    );
    expect(ok.status).toBe(200);
    const row = (await ok.json()).data as { status: string; done_at: string | null; result: { summary: string } };
    expect(row.status).toBe('done');
    expect(row.done_at).not.toBeNull();
    expect(row.result.summary).toBe('done!');

    const remain = await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-report', keyHeaders(apiKey, secret));
    expect(((await remain.json()).data as Array<{ id: string }>).some((r) => r.id === id)).toBe(false);
  });

  it('zx_20261011_1 M2 协议幂等：终态一次——重复回传不改结果、不翻案；done_at 不刷', async () => {
    const { apiKey, secret } = await enrollNode('n-idem', card('n-idem', ['project_task']));
    const report = (id: string, status: 'done' | 'error', result: Record<string, unknown>) => {
      const t = JSON.stringify({ node_id: 'n-idem', status, result });
      return call(guardedApp, 'POST', `/api/v1/nodes/requests/${id}/result`, keyHeaders(apiKey, secret, t), t);
    };

    // 该侧一：先 done。再投一笔**不同**的 done ⇒ 结果仍＝第一次、done_at 不刷。
    const a = await submit('project_task', { prompt: 'a' });
    const idA = (await a.json()).data.id as string;
    await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-idem', keyHeaders(apiKey, secret));
    const firstA = await report(idA, 'done', { summary: 'first' });
    expect(firstA.status).toBe(200);
    const doneAtA = ((await firstA.json()).data as { done_at: string }).done_at;
    const repeatA = await report(idA, 'done', { summary: 'second' });
    expect(repeatA.status).toBe(200);
    const rowA = (await repeatA.json()).data as { status: string; result: { summary: string }; done_at: string };
    expect(rowA.status).toBe('done');
    expect(rowA.result.summary).toBe('first'); // ★=第一次（旧实现此处会被改成 'second'）
    expect(rowA.done_at).toBe(doneAtA); // 未刷

    // 该侧二（不翻案）：先 error。再投一记 done ⇒ 仍 error、结果不变。
    const b = await submit('project_task', { prompt: 'b' });
    const idB = (await b.json()).data.id as string;
    await call(guardedApp, 'GET', '/api/v1/nodes/requests?node_id=n-idem', keyHeaders(apiKey, secret));
    expect((await report(idB, 'error', { why: 'boom' })).status).toBe(200);
    const lateB = await report(idB, 'done', { summary: 'late' });
    expect(lateB.status).toBe(200);
    const rowB = (await lateB.json()).data as { status: string; result: { why: string } };
    expect(rowB.status).toBe('error'); // ★不因迟到 done 翻案
    expect(rowB.result.why).toBe('boom');

    // 反证（幂等守卫**未越权**）：非目标节点重复投递 ⇒ 仍 403（双校验先跑）。
    const badText = JSON.stringify({ node_id: 'n-elsewhere', status: 'done', result: {} });
    const bad = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${idA}/result`,
      keyHeaders(apiKey, secret, badText),
      badText,
    );
    expect(bad.status).toBe(403);
  });

  it('zx_20261011_1 M3 角色语义：派发侧也看角色——worker 只接不分(400)；primary/observer 可派(201)；observer 仍不可接', async () => {
    // worker（缺省角色）⇒ 400，且文案点明"只接不分"。
    const w = await enrollNode('n-disp-w');
    const rw = await submitAs(w.apiKey, w.secret, 'media', { prompt: 'w' });
    expect(rw.status).toBe(400);
    expect(JSON.stringify(await rw.json())).toContain('worker');

    // primary ⇒ 201（可派；无合适目标则 pending，仍 201）。
    const p = await enrollNode('n-disp-p', undefined, { role: 'primary' });
    expect((await submitAs(p.apiKey, p.secret, 'media', { prompt: 'p' })).status).toBe(201);

    // observer ⇒ 201（"只分不接"的那一半：可派）。
    const o = await enrollNode('n-disp-o', undefined, { role: 'observer' });
    expect((await submitAs(o.apiKey, o.secret, 'media', { prompt: 'o' })).status).toBe(201);

    // ★反证：observer **仍不可接**（指定它为目标 ⇒ 400，`nodeQualifies` 拦下）——语义未被 M3 误伤。
    const t = JSON.stringify({ category: 'media', target_node_id: 'n-disp-o', payload: { x: 1 } });
    const intoObserver = await call(guardedApp, 'POST', '/api/v1/nodes/requests', devHeaders(t), t);
    expect(intoObserver.status).toBe(400);
  });

  // ==================== zx_20261011 M1/M2：请求方身份 + 读回 + 负载选目标 ====================

  it('M12-⑦ zx_20261011 M1：请求方身份由**凭据派生**（节点 key ⇒ node:<id>；dev-key ⇒ null）', async () => {
    // zx_20261011_1 M3：此节点要**当派发方**⇒ 须 `canDispatch`（`worker` 只接不分）——升 `primary` 后本测原意（身份派生）不变。
    const { apiKey, secret } = await enrollNode('n-reqid', card('n-reqid', ['code']), { role: 'primary' });
    const byNode = await submitAs(apiKey, secret, 'code', { prompt: 'hi' });
    expect(byNode.status).toBe(201);
    expect((await byNode.json()).data.requester_node_id).toBe('n-reqid');

    // 非节点终端（dev-key 无 `node:` 资源组）⇒ 请求方为 null（**不伪造**一个身份）。
    const byDev = await submit('code', { prompt: 'hi' });
    expect((await byDev.json()).data.requester_node_id).toBeNull();
  });

  it('M12-⑧ zx_20261011 M1：读回两侧标本——请求方 200 / 非请求方 403 / 未知 id 404', async () => {
    // zx_20261011_1 M3：同上——本测要它**发一单**（测读回鉴权），故升 `primary`。
    const { apiKey, secret } = await enrollNode('n-readback', card('n-readback', ['code']), { role: 'primary' });
    const created = await submitAs(apiKey, secret, 'code', { prompt: 'x' });
    const id = (await created.json()).data.id as string;

    // 该侧一：请求方（同一节点 key）⇒ 200，且**本件确是自己那件**。
    const mine = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, keyHeaders(apiKey, secret));
    expect(mine.status).toBe(200);
    expect((await mine.json()).data.id).toBe(id);

    // 该侧二：非请求方（dev-key，前缀也不同）⇒ 403（读不到 ≠ 猜得到）。
    const other = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, devHeaders());
    expect(other.status).toBe(403);

    // 未知 id ⇒ 404（"认不得" 与 "不许读" 分得开）。
    const none = await call(
      guardedApp,
      'GET',
      '/api/v1/nodes/requests/00000000-0000-0000-0000-000000000000',
      devHeaders(),
    );
    expect(none.status).toBe(404);
  });

  it('M12-⑨ zx_20261011 M1：非节点终端（dev-key）读回**自身**请求 ⇒ 200（前缀退路）', async () => {
    const created = await submit('text', { prompt: 'y' });
    const id = (await created.json()).data.id as string;
    const r = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, devHeaders());
    expect(r.status).toBe(200);
    expect((await r.json()).data.id).toBe(id);
  });

  it('zx_20261018_3 批三：请求方**有节点身份**时不再接受前缀兜底——同前缀异节点 403，真身份 200（两只标本）', async () => {
    const a = await enrollNode('n-ident-a', card('n-ident-a', ['code']), { role: 'primary' });

    // ── 标本一：读回端 GET /requests/:id ────────────────────────────────
    // B **在本单提交之后**才入网 ⇒ 本单目标不可能是 B（排除 `byTarget` 这条合法路，只留前缀在起作用）。
    const created = await submitAs(a.apiKey, a.secret, 'code', { prompt: 'read' });
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id as string;
    expect((await created.json()).data.requester_node_id).toBe('n-ident-a');

    const b = await enrollNode('n-ident-b', card('n-ident-b', ['code']));
    const bPrefix = b.apiKey.slice(0, 8);
    // 制造"前缀碰撞"：登记前缀指向 B（真实故障形态——8 位可撞，或旧行前缀指向他人）。
    db.prepare('UPDATE ans_node_requests SET requester_key_prefix = ? WHERE id = ?').run(bPrefix, id);
    const row0 = db
      .prepare('SELECT requester_node_id, target_node_id, requester_key_prefix FROM ans_node_requests WHERE id = ?')
      .get(id) as { requester_node_id: string | null; target_node_id: string | null; requester_key_prefix: string };
    expect(row0.requester_node_id).toBe('n-ident-a');
    expect(row0.requester_key_prefix).toBe(bPrefix); // 碰撞条件真的成立
    expect(row0.target_node_id).not.toBe('n-ident-b'); // B 不是目标（否则 `byTarget` 会名正言顺放行）

    const byB = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, keyHeaders(b.apiKey, b.secret));
    expect(byB.status).toBe(403); // 旧实现此处＝200（前缀对上就放行）
    const byA = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, keyHeaders(a.apiKey, a.secret));
    expect(byA.status).toBe(200);
    expect((await byA.json()).data.id).toBe(id);

    // ── 标本二：作答端 POST /requests/:id/answer（同一把尺）──────────────
    // 这单**显式指定**目标 = B（让 B 走生产路由提问），请求方仍是 A。
    const qBody = JSON.stringify({ category: 'code', target_node_id: 'n-ident-b', payload: { prompt: 'answer' } });
    const created2 = await call(
      guardedApp,
      'POST',
      '/api/v1/nodes/requests',
      keyHeaders(a.apiKey, a.secret, qBody),
      qBody,
    );
    expect(created2.status).toBe(201);
    const id2 = (await created2.json()).data.id as string;
    expect((await created2.json()).data.requester_node_id).toBe('n-ident-a');
    expect((await created2.json()).data.target_node_id).toBe('n-ident-b');

    const questionText = JSON.stringify({ node_id: 'n-ident-b', question: '要继续吗？' });
    const q = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id2}/question`,
      keyHeaders(b.apiKey, b.secret, questionText),
      questionText,
    );
    expect(q.status).toBe(200);
    expect((await q.json()).data.question_status).toBe('asked');

    db.prepare('UPDATE ans_node_requests SET requester_key_prefix = ? WHERE id = ?').run(bPrefix, id2); // 同一碰撞条件

    const ansText = JSON.stringify({ answer: '继续' });
    const answerByB = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id2}/answer`,
      keyHeaders(b.apiKey, b.secret, ansText),
      ansText,
    );
    expect(answerByB.status).toBe(403); // 旧实现此处＝200（前缀兜底把身份闸架空）
    const untouched = db
      .prepare('SELECT question_status, answer_json FROM ans_node_requests WHERE id = ?')
      .get(id2) as {
      question_status: string | null;
      answer_json: string | null;
    };
    expect(untouched.question_status).toBe('asked'); // 反证：被拒的作答**没落库**
    expect(untouched.answer_json).toBeNull();

    const answerByA = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id2}/answer`,
      keyHeaders(a.apiKey, a.secret, ansText),
      ansText,
    );
    expect(answerByA.status).toBe(200);
    const answered = (await answerByA.json()).data as { question_status: string; answer: { answer: string } };
    expect(answered.question_status).toBe('answered');
    expect(answered.answer.answer).toBe('继续');
  });

  it('M12-⑩ zx_20261011 M2：负载选目标——忙的高权重机**让位**给闲的低权重机', async () => {
    // 分值须**不同**（0.5 vs 0.95）⇒ 结果由分值唯一决定，不靠 `datetime('now')` 的秒级抖。
    await enrollNode(
      'n-busy-heavy',
      card('n-busy-heavy', ['code']),
      { weight: 10 },
      { os: 't', capacity_free_ratio: 0.05 },
    );
    await enrollNode(
      'n-idle-light',
      card('n-idle-light', ['code']),
      { weight: 1 },
      { os: 't', capacity_free_ratio: 0.95 },
    );
    const r = await submit('code', { prompt: 'z' });
    expect((await r.json()).data.target_node_id).toBe('n-idle-light');
  });

  it('M12-⑪ zx_20261011 M2：反向标本——闲的高权重机**优先**（核心未丢：权重仍占份量）', async () => {
    // 9.5 vs 0.05 ⇒ 高权重且闲者胜。
    await enrollNode(
      'n-idle-heavy',
      card('n-idle-heavy', ['code']),
      { weight: 10 },
      { os: 't', capacity_free_ratio: 0.95 },
    );
    await enrollNode(
      'n-busy-light',
      card('n-busy-light', ['code']),
      { weight: 1 },
      { os: 't', capacity_free_ratio: 0.05 },
    );
    const r = await submit('code', { prompt: 'z' });
    expect((await r.json()).data.target_node_id).toBe('n-idle-heavy');
  });

  it('M12-⑫ zx_20261011 M2：余力**未知** ⇒ 取 neutral 1.0（不因"没这个数"受罚）', async () => {
    // 一台权重 2、无余力字段（status 不含 capacity_free_ratio ⇒ json_extract 回 NULL ⇒ COALESCE 1.0 ⇒ 分 2.0）；
    // 一台权重 1、余力 0.95（分 0.95）。前者分高 ⇒ 被选，证明"未知"未被当成 0（否则 2*0=0 会被后者压过）。
    await enrollNode('n-unknown', card('n-unknown', ['text']), { weight: 2 }, { os: 't' });
    await enrollNode('n-known', card('n-known', ['text']), { weight: 1 }, { os: 't', capacity_free_ratio: 0.95 });
    const r = await submit('text', { prompt: 'z' });
    expect((await r.json()).data.target_node_id).toBe('n-unknown');
  });

  it('M12-⑬ zx_20261011 M2：手动指定目标——合格则**直派**（即便非分值最高）；不合格 400 如实', async () => {
    // 自动选会挑 n-fast（分 9.5）；手动点名 n-slow ⇒ 派给 n-slow（人可覆盖算法）。
    await enrollNode('n-fast', card('n-fast', ['code']), { weight: 10 }, { os: 't', capacity_free_ratio: 0.95 });
    await enrollNode('n-slow', card('n-slow', ['code']), { weight: 1 }, { os: 't', capacity_free_ratio: 0.05 });
    const manual = await submitTo('code', 'n-slow', { prompt: 'm' });
    expect(manual.status).toBe(201);
    expect((await manual.json()).data.target_node_id).toBe('n-slow');

    // 不合格一：观察者（role != 'observer' 不满足）⇒ 400。
    await enrollNode('n-obs', card('n-obs', ['code']), { role: 'observer' });
    const obs = await submitTo('code', 'n-obs');
    expect(obs.status).toBe(400);

    // 不合格二：目标卡**不含该类目** ⇒ 400。
    const missCat = await submitTo('media', 'n-fast');
    expect(missCat.status).toBe(400);

    // 不合格三：未知节点 ⇒ 400（不是 404——它是个**非法入参**，不是不存在的资源）。
    const unknown = await submitTo('code', 'n-nobody');
    expect(unknown.status).toBe(400);
  });

  // ==================== zx_20261011_1 M4：双向澄清（B 问 / A 答 / 两跳） ====================

  it('M4-① 双向澄清全链：B 提问 ⇒ awaiting_answer(asked) ⇒ A、B 各读得到 ⇒ A 作答 ⇒ 回 assigned(answered)', async () => {
    // A＝派活方（`primary` 才派得出去）；B＝执行方（卡含类目 ⇒ 可接）。
    const a = await enrollNode('n-m4-a', undefined, { role: 'primary' });
    const b = await enrollNode('n-m4-b', card('n-m4-b', ['code']));
    const created = await submitAs(a.apiKey, a.secret, 'code', { prompt: '干活' });
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id as string;
    expect((await created.json()).data.target_node_id).toBe('n-m4-b');

    // 跳①：B 提问 ⇒ 200；状态转 `awaiting_answer`、`question_status='asked'`、问题（含选项）原样回。
    const qText = JSON.stringify({ node_id: 'n-m4-b', question: '用哪种口径？', options: ['A', 'B'] });
    const asked = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/question`,
      keyHeaders(b.apiKey, b.secret, qText),
      qText,
    );
    expect(asked.status).toBe(200);
    const askedBody = (await asked.json()).data;
    expect(askedBody.status).toBe('awaiting_answer');
    expect(askedBody.question_status).toBe('asked');
    expect(askedBody.question.question).toBe('用哪种口径？');
    expect(askedBody.question.options).toEqual(['A', 'B']);

    // 读回①：A（请求方）读得到这一问。
    const aRead = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, keyHeaders(a.apiKey, a.secret));
    expect(aRead.status).toBe(200);
    expect((await aRead.json()).data.question_status).toBe('asked');
    // 读回②：B（**目标方**）也读得到——M4 扩 `byTarget`（B 须轮询自己那一单的作答）。
    const bRead = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, keyHeaders(b.apiKey, b.secret));
    expect(bRead.status).toBe(200);
    // 第三方（另一节点，非请求方亦非目标）⇒ 403（无知之幕不破）。
    const c = await enrollNode('n-m4-c');
    const stranger = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, keyHeaders(c.apiKey, c.secret));
    expect(stranger.status).toBe(403);

    // 跳②：A 作答 ⇒ 200；转回 `assigned`（B 可续跑）、`question_status='answered'`。
    const ansText = JSON.stringify({ answer: '按 A 口径' });
    const answered = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/answer`,
      keyHeaders(a.apiKey, a.secret, ansText),
      ansText,
    );
    expect(answered.status).toBe(200);
    const answeredBody = (await answered.json()).data;
    expect(answeredBody.status).toBe('assigned');
    expect(answeredBody.question_status).toBe('answered');
    expect(answeredBody.answer.answer).toBe('按 A 口径');

    // B 轮询即拿到答（同一读回端点）。
    const bPoll = await call(guardedApp, 'GET', `/api/v1/nodes/requests/${id}`, keyHeaders(b.apiKey, b.secret));
    expect((await bPoll.json()).data.answer.answer).toBe('按 A 口径');
  });

  it('M4-② 作答**幂等**：重复作答原样回既有（不覆盖答案、不翻状态）', async () => {
    const a = await enrollNode('n-m4i-a', undefined, { role: 'primary' });
    const b = await enrollNode('n-m4i-b', card('n-m4i-b', ['code']));
    const id = (await (await submitAs(a.apiKey, a.secret, 'code', { prompt: 'x' })).json()).data.id as string;
    const qText = JSON.stringify({ node_id: 'n-m4i-b', question: 'q' });
    await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/question`,
      keyHeaders(b.apiKey, b.secret, qText),
      qText,
    );

    const first = JSON.stringify({ answer: '第一次' });
    const r1 = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/answer`,
      keyHeaders(a.apiKey, a.secret, first),
      first,
    );
    expect(r1.status).toBe(200);
    expect((await r1.json()).data.answer.answer).toBe('第一次');

    // 迟到/重复的第二笔 ⇒ 200 原样回**既有**（不改成"第二次"，状态不动）。
    const second = JSON.stringify({ answer: '第二次' });
    const r2 = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/answer`,
      keyHeaders(a.apiKey, a.secret, second),
      second,
    );
    expect(r2.status).toBe(200);
    const r2Body = (await r2.json()).data;
    expect(r2Body.answer.answer).toBe('第一次');
    expect(r2Body.status).toBe('assigned');
  });

  it('M4-③ 边界如实：非目标提问 403 / 非请求方作答 403 / 无待答而作答 400 / 非 assigned 而提问 400', async () => {
    const a = await enrollNode('n-m4e-a', undefined, { role: 'primary' });
    const b = await enrollNode('n-m4e-b', card('n-m4e-b', ['code']));
    const c = await enrollNode('n-m4e-c');
    const id = (await (await submitAs(a.apiKey, a.secret, 'code', { prompt: 'x' })).json()).data.id as string;

    // 非目标节点提问 ⇒ 403（双校验：`target_node_id === node_id`）。
    const cAskText = JSON.stringify({ node_id: 'n-m4e-c', question: 'q' });
    const cAsk = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/question`,
      keyHeaders(c.apiKey, c.secret, cAskText),
      cAskText,
    );
    expect(cAsk.status).toBe(403);

    // 非请求方（目标 B）作答 ⇒ 403（作答端按**请求方**身份鉴权）。
    const bAnsText = JSON.stringify({ answer: 'x' });
    const bAns = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/answer`,
      keyHeaders(b.apiKey, b.secret, bAnsText),
      bAnsText,
    );
    expect(bAns.status).toBe(403);

    // 无待答而作答（A 直接答，B 还没问）⇒ 400。
    const early = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/answer`,
      keyHeaders(a.apiKey, a.secret, bAnsText),
      bAnsText,
    );
    expect(early.status).toBe(400);

    // B 先正常问一记 ⇒ 转 awaiting_answer；此时**再问** ⇒ 非 'assigned' ⇒ 400（状态机不搅乱）。
    const qText = JSON.stringify({ node_id: 'n-m4e-b', question: 'q1' });
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${id}/question`,
          keyHeaders(b.apiKey, b.secret, qText),
          qText,
        )
      ).status,
    ).toBe(200);
    const q2Text = JSON.stringify({ node_id: 'n-m4e-b', question: 'q2' });
    const again = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${id}/question`,
      keyHeaders(b.apiKey, b.secret, q2Text),
      q2Text,
    );
    expect(again.status).toBe(400);
  });

  it('M4-④ D10 终态不可复活：done/error 的件作答 ⇒ 400；已答终态件重投仍幂等 200', async () => {
    // 病根（实机坐实）：`done ∧ question_status='asked'` 的件此前仍可被作答 ⇒ 置回 `assigned` ⇒ worker 重拉 ⇒
    //   把已完成的活重跑一遍。本闸挡它；次序上**幂等分支在前**（已答的重投不该因收口而报错）。
    const a = await enrollNode('n-m4f-a', undefined, { role: 'primary' });
    const b = await enrollNode('n-m4f-b', card('n-m4f-b', ['code']));
    const qText = JSON.stringify({ node_id: 'n-m4f-b', question: 'q' });
    const ansText = JSON.stringify({ answer: '按 A 口径' });

    // 标本一：B 提问（asked）→ B **未获作答**即回传 done ⇒ `done ∧ asked`（D10 实机标本形）⇒ 作答 400，且库内状态**未被翻动**。
    const idDone = (await (await submitAs(a.apiKey, a.secret, 'code', { prompt: 'x' })).json()).data.id as string;
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idDone}/question`,
          keyHeaders(b.apiKey, b.secret, qText),
          qText,
        )
      ).status,
    ).toBe(200);
    const doneText = JSON.stringify({ node_id: 'n-m4f-b', status: 'done', result: { taskId: 't1' } });
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idDone}/result`,
          keyHeaders(b.apiKey, b.secret, doneText),
          doneText,
        )
      ).status,
    ).toBe(200);
    const rowDone = db.prepare('SELECT status, question_status FROM ans_node_requests WHERE id = ?').get(idDone) as {
      status: string;
      question_status: string;
    };
    expect(rowDone.status).toBe('done'); // 标本成立：确为 done…
    expect(rowDone.question_status).toBe('asked'); // …且仍挂着一个未答的提问
    const late = await call(
      guardedApp,
      'POST',
      `/api/v1/nodes/requests/${idDone}/answer`,
      keyHeaders(a.apiKey, a.secret, ansText),
      ansText,
    );
    expect(late.status).toBe(400);
    expect(
      (db.prepare('SELECT status FROM ans_node_requests WHERE id = ?').get(idDone) as { status: string }).status,
    ).toBe('done'); // 未被复活

    // 标本二：`error ∧ asked` 同形 ⇒ 同样 400（失败件也不许被作答复活）。
    const idErr = (await (await submitAs(a.apiKey, a.secret, 'code', { prompt: 'y' })).json()).data.id as string;
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idErr}/question`,
          keyHeaders(b.apiKey, b.secret, qText),
          qText,
        )
      ).status,
    ).toBe(200);
    const errText = JSON.stringify({ node_id: 'n-m4f-b', status: 'error', result: { error: 'boom' } });
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idErr}/result`,
          keyHeaders(b.apiKey, b.secret, errText),
          errText,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idErr}/answer`,
          keyHeaders(a.apiKey, a.secret, ansText),
          ansText,
        )
      ).status,
    ).toBe(400);

    // 标本三：**已答**终态件（done ∧ answered）重投 ⇒ 仍幂等 200——证明终态闸在幂等分支**之后**，不误伤重投。
    const idOk = (await (await submitAs(a.apiKey, a.secret, 'code', { prompt: 'z' })).json()).data.id as string;
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idOk}/question`,
          keyHeaders(b.apiKey, b.secret, qText),
          qText,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idOk}/answer`,
          keyHeaders(a.apiKey, a.secret, ansText),
          ansText,
        )
      ).status,
    ).toBe(200);
    const doneText2 = JSON.stringify({ node_id: 'n-m4f-b', status: 'done', result: { taskId: 't2' } });
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idOk}/result`,
          keyHeaders(b.apiKey, b.secret, doneText2),
          doneText2,
        )
      ).status,
    ).toBe(200);
    const rowOk = db.prepare('SELECT status, question_status FROM ans_node_requests WHERE id = ?').get(idOk) as {
      status: string;
      question_status: string;
    };
    expect(rowOk.status).toBe('done');
    expect(rowOk.question_status).toBe('answered');
    expect(
      (
        await call(
          guardedApp,
          'POST',
          `/api/v1/nodes/requests/${idOk}/answer`,
          keyHeaders(a.apiKey, a.secret, ansText),
          ansText,
        )
      ).status,
    ).toBe(200);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // zx_20261011_3：**删除离线节点**（硬删 + 吊销该节点 key + 解套停滞件）。
  //   两标本逐条：该删（离线他机）成 / 不该删（在线 / 自删）拒各一侧。
  // ══════════════════════════════════════════════════════════════════════════════

  it('M3-① 删离线他机：200 + 行消失 + 其 key 真被吊销（心跳 401）+ 二次删 404', async () => {
    const off = await enrollNode('n-del-off');
    // 标本成立：从未心跳 ⇒ `last_seen_at` 为 NULL ⇒ 离线。
    const seen = db.prepare('SELECT last_seen_at FROM ans_nodes WHERE node_id = ?').get('n-del-off') as {
      last_seen_at: string | null;
    };
    expect(seen.last_seen_at).toBeNull();

    const del = await call(guardedApp, 'DELETE', '/api/v1/nodes/n-del-off', devHeaders());
    expect(del.status).toBe(200);
    expect((await del.json()).data).toMatchObject({
      node_id: 'n-del-off',
      removed: true,
      key_revoked: true,
      requeued: 0,
    });

    // 行真没了——连 `?all=1` 也找不到（**硬删**，非软删）。
    const all = (await (await call(guardedApp, 'GET', '/api/v1/nodes?all=1', devHeaders())).json()).data as Array<{
      node_id: string;
    }>;
    expect(all.some((n) => n.node_id === 'n-del-off')).toBe(false);

    // key 真被吊销：该节点自己的 key 发心跳 ⇒ 401（若只删行不吊销，此处会是 404 —— 这是"吊销"的正面证据）。
    const hb = JSON.stringify({ node_id: 'n-del-off' });
    expect(
      (await call(guardedApp, 'POST', '/api/v1/nodes/heartbeat', keyHeaders(off.apiKey, off.secret, hb), hb)).status,
    ).toBe(401);

    // 二次删除 ⇒ 404（行已不在）。
    expect((await call(guardedApp, 'DELETE', '/api/v1/nodes/n-del-off', devHeaders())).status).toBe(404);
  });

  it('M3-② 在线他机不可删：409 且行仍在', async () => {
    await enrollNode('n-del-on', card('n-del-on', ['project_task']), undefined, { os: 't' });
    expect((await call(guardedApp, 'DELETE', '/api/v1/nodes/n-del-on', devHeaders())).status).toBe(409);
    const all = (await (await call(guardedApp, 'GET', '/api/v1/nodes', devHeaders())).json()).data as Array<{
      node_id: string;
    }>;
    expect(all.some((n) => n.node_id === 'n-del-on')).toBe(true);
  });

  it('M3-③ 未知 nodeId ⇒ 404', async () => {
    expect((await call(guardedApp, 'DELETE', '/api/v1/nodes/n-absent', devHeaders())).status).toBe(404);
  });

  it('M3-④ 自删被拒：400 且行仍在（即便离线）', async () => {
    const self = await enrollNode('n-del-self');
    // 用**该节点自己的 key** 删自己 ⇒ 400（本机删除=退出协同网络，与"清理他机"是两件事）。
    const del = await call(guardedApp, 'DELETE', '/api/v1/nodes/n-del-self', keyHeaders(self.apiKey, self.secret));
    expect(del.status).toBe(400);
    expect(db.prepare('SELECT node_id FROM ans_nodes WHERE node_id = ?').get('n-del-self')).toBeTruthy();
  });

  it('M3-⑤ 停滞件解套：删掉已离线的目标节点 ⇒ 该件退回 pending，可被他人认领（0→1）', async () => {
    await enrollNode('n-delq-a', card('n-delq-a', ['project_task']), undefined, { os: 't' });
    const reqId = (await (await submitTo('project_task', 'n-delq-a')).json()).data.id as string;
    expect(
      (db.prepare('SELECT status FROM ans_node_requests WHERE id = ?').get(reqId) as { status: string }).status,
    ).toBe('assigned');

    // A 转离线：真时间下 90s 不可等 ⇒ 直接改 `last_seen_at`（仍走生产判据 `last_seen_at > datetime('now', -90s)`）。
    db.prepare("UPDATE ans_nodes SET last_seen_at = datetime('now', '-120 seconds') WHERE node_id = 'n-delq-a'").run();
    const del = await call(guardedApp, 'DELETE', '/api/v1/nodes/n-delq-a', devHeaders());
    expect(del.status).toBe(200);
    expect((await del.json()).data.requeued).toBe(1);

    // 件真退回：`pending` ∧ `target_node_id` 清空（否则派活方会轮询"待回"到天荒地老）。
    const row = db.prepare('SELECT status, target_node_id FROM ans_node_requests WHERE id = ?').get(reqId) as {
      status: string;
      target_node_id: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.target_node_id).toBeNull();

    // 另一台在线工蚁来拉 ⇒ 认领到这一件（**0→1 正面断言**，承 feedback_rr_fixture_production_order）。
    const b = await enrollNode('n-delq-b', card('n-delq-b', ['project_task']), undefined, { os: 't' });
    const pulled = await call(
      guardedApp,
      'GET',
      '/api/v1/nodes/requests?node_id=n-delq-b',
      keyHeaders(b.apiKey, b.secret),
    );
    expect(pulled.status).toBe(200);
    const list = (await pulled.json()).data as Array<{ id: string }>;
    expect(list.length).toBe(1);
    expect(list.map((r) => r.id)).toEqual([reqId]);
  });

  it('M3-⑥ 硬删的证据：删除后同一 node_id 用新令牌重新注册 ⇒ 201（软删会 409）', async () => {
    await enrollNode('n-del-reg');
    expect((await call(guardedApp, 'DELETE', '/api/v1/nodes/n-del-reg', devHeaders())).status).toBe(200);
    const token = await mintToken();
    const regText = JSON.stringify({ enrollment_token: token, node_id: 'n-del-reg', name: 'again' });
    const reg = await call(
      enrollmentApp,
      'POST',
      '/api/v1/nodes/register',
      { 'content-type': 'application/json' },
      regText,
    );
    expect(reg.status).toBe(201);
  });

  // ═══ 批四（zx_20261017_1）: 改档的调用方权限 —— R-20 / R-21 / R-22 ═══════════
  /** 建好四台节点：primary / observer / worker（改档发起方）+ target（被改方）。 */
  async function enrollPermNodes() {
    const primary = await enrollNode('perm-primary', undefined, { role: 'primary' });
    const observer = await enrollNode('perm-observer', undefined, { role: 'observer' });
    const worker = await enrollNode('perm-worker', undefined, { role: 'worker' });
    const target = await enrollNode('perm-target', undefined, { role: 'worker' });
    return { primary, observer, worker, target };
  }
  const patchAs = (who: { apiKey: string; secret: string }, targetId: string, patch: Record<string, unknown>) => {
    const text = JSON.stringify(patch);
    return call(guardedApp, 'PATCH', `/api/v1/nodes/${targetId}`, keyHeaders(who.apiKey, who.secret, text), text);
  };
  const weightOf = (nodeId: string) =>
    (db.prepare('SELECT weight FROM ans_nodes WHERE node_id = ?').get(nodeId) as { weight: number }).weight;

  it('★★ R-20 改档权限矩阵四格：self ✓ / primary 改他机 ✓ / observer 改他机 ✓ / worker 改他机 ✗', async () => {
    const { primary, observer, worker } = await enrollPermNodes();

    // ① 本机改自己：worker 也可以（自己的机器自己说了算）。
    const self = await patchAs(worker, 'perm-worker', { weight: 1.5 });
    expect(self.status).toBe(200);
    expect(weightOf('perm-worker')).toBe(1.5);

    // ② primary 改他机 ⇒ 200。
    const byPrimary = await patchAs(primary, 'perm-target', { weight: 2 });
    expect(byPrimary.status).toBe(200);
    expect(weightOf('perm-target')).toBe(2);

    // ③ observer 改他机 ⇒ 200（只分不接，但仍是分方）。
    const byObserver = await patchAs(observer, 'perm-target', { weight: 3 });
    expect(byObserver.status).toBe(200);
    expect(weightOf('perm-target')).toBe(3);

    // ④ worker 改他机 ⇒ 403，且值**正面断言未变**（不是"拒了但已落库"）。
    const byWorker = await patchAs(worker, 'perm-target', { weight: 9 });
    expect(byWorker.status).toBe(403);
    expect((await byWorker.json()).error.message).toContain('cannot modify peer');
    expect(weightOf('perm-target')).toBe(3);
  });

  it('★★ R-21 非节点凭据（外部终端 / dev key）改档 ⇒ 403，且不落库', async () => {
    await enrollPermNodes();
    const before = weightOf('perm-target');
    const text = JSON.stringify({ weight: 9 });
    const r = await call(guardedApp, 'PATCH', '/api/v1/nodes/perm-target', devHeaders(text), text);
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain('Only enrolled nodes');
    expect(weightOf('perm-target')).toBe(before);
  });

  it('★★ R-22 权限只读凭据派生身份：body 里伪造 requester_node_id 仍是 403', async () => {
    const { worker } = await enrollPermNodes();
    const before = weightOf('perm-target');
    const forged = await patchAs(worker, 'perm-target', { weight: 9, requester_node_id: 'perm-primary' });
    expect(forged.status).toBe(403);
    expect(weightOf('perm-target')).toBe(before);
  });
});
