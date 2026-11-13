/**
 * models 路由 E2E 测试（C1/C2）：验证「启用/禁用」持久化 + 无端点不可用 + /optimal 尊重 enabled。
 * 直调 Elysia app.handle，使用内存 DB。
 *
 * zx_20260924 M6-b: `/optimal` 的用例**不再走 `modelsRoutes` 的 handle**——那条路径上的
 *   `.post('/optimal')` 是实现之二，且从未在生产生效（Elysia 后注册者胜）。改直调
 *   `resolveOptimalModel`（= `index.ts` 活体路由调的那一个），并补上**价格字段在场**的正面断言：
 *   两份实现在这一点上**不同**，只断言 `error?.code` 的话，把实现换回缺价格的那份也照样绿。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { modelsRoutes } from '../routes/models.js';
import { resolveOptimalModel } from '../routes/optimal-model.js';
import { parseModelCapabilities } from '../services/resource-matcher.js';
import { buildEndpointTestRequest } from '../services/endpoint-test.js';
import { encryptApiKey } from '../utils/security.js';

function jsonReq(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('models routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof modelsRoutes>;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', source TEXT DEFAULT 'user', enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER DEFAULT 4096, max_output_tokens INTEGER DEFAULT 1024, input_price_per_1k REAL DEFAULT 0, output_price_per_1k REAL DEFAULT 0, status TEXT DEFAULT 'active', source TEXT DEFAULT 'user', description TEXT DEFAULT '', enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), health_check_at TEXT DEFAULT '', health_status TEXT DEFAULT '', last_latency_ms INTEGER DEFAULT 0);
      CREATE TABLE ans_audit_logs (id TEXT PRIMARY KEY, actor TEXT, action TEXT, resource_type TEXT, resource_id TEXT, detail TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_model_quality_logs (id TEXT PRIMARY KEY, model_id TEXT, project_id TEXT, task_type TEXT, capability TEXT, success INTEGER DEFAULT 1, output_accepted INTEGER DEFAULT 1, token_efficiency REAL, latency_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_billing_records (id TEXT PRIMARY KEY, endpoint_id TEXT, model_id TEXT, project_id TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0.0, currency TEXT DEFAULT 'USD', created_at TEXT DEFAULT (datetime('now')));
    `);
    db.prepare(
      "INSERT INTO ans_ai_providers (id, name, base_url) VALUES ('p1', 'openai', 'https://api.openai.com')",
    ).run();
    db.prepare(
      "INSERT INTO ans_ai_models (id, provider_id, name, capabilities) VALUES ('m1', 'p1', 'gpt-4o', '[\"chat\"]')",
    ).run();
    const enc = encryptApiKey('sk-test');
    db.prepare(
      "INSERT INTO ans_model_endpoints (id, model_id, url, api_key_ref) VALUES ('e1', 'm1', 'https://api.openai.com/v1', ?)",
    ).run(enc);
    app = modelsRoutes(db);
  });

  it('C1: PUT provider enabled=0 持久化，GET 返回 enabled', async () => {
    const r1 = await app.handle(jsonReq('/api/v1/models/providers/p1', 'PUT', { enabled: 0 }));
    expect(r1.status).toBe(200);
    const row = db.prepare('SELECT enabled FROM ans_ai_providers WHERE id = ?').get('p1') as { enabled: number };
    expect(row.enabled).toBe(0);
    const r2 = await app.handle(jsonReq('/api/v1/models/providers/p1', 'GET'));
    const data = (await r2.json()) as { data: { enabled: number } };
    expect(data.data.enabled).toBe(0);
  });

  it('C1: PUT model enabled=0 持久化', async () => {
    const r = await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { enabled: 0 }));
    expect(r.status).toBe(200);
    const row = db.prepare('SELECT enabled FROM ans_ai_models WHERE id = ?').get('m1') as { enabled: number };
    expect(row.enabled).toBe(0);
    await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { enabled: 1 }));
    const row2 = db.prepare('SELECT enabled FROM ans_ai_models WHERE id = ?').get('m1') as { enabled: number };
    expect(row2.enabled).toBe(1);
  });

  it('C1: PUT provider 部分字段更新不动其他字段', async () => {
    await app.handle(jsonReq('/api/v1/models/providers/p1', 'PUT', { name: 'openai-2' }));
    const row = db.prepare('SELECT name, enabled, base_url FROM ans_ai_providers WHERE id = ?').get('p1') as {
      name: string;
      enabled: number;
      base_url: string;
    };
    expect(row.name).toBe('openai-2');
    expect(row.enabled).toBe(0); // 上一次置 0，未被动
    expect(row.base_url).toBe('https://api.openai.com');
  });

  it('C1: /optimal 尊重 enabled（禁用模型不再被匹配）', async () => {
    await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { enabled: 0 }));
    const data = resolveOptimalModel(db, { capabilities: ['chat'] }) as { error?: { code: string } };
    expect(data.error?.code).toBe('NOT_FOUND'); // 唯一模型被禁用 → 无可用模型
    await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { enabled: 1 }));
  });

  it('M6-b: /optimal 成功回包带价格二键与三级降级链键（缺一即静默丢成本依据）', async () => {
    // 复位：前序用例禁用过 provider（matcher 会筛 `p.enabled = 1`）。本用例要的是**成功路**，
    //   故自己把状态摆正，不依赖别的用例的顺序（那正是同族"假绿"的来源）。
    await app.handle(jsonReq('/api/v1/models/providers/p1', 'PUT', { enabled: 1 }));
    await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { enabled: 1 }));
    const data = resolveOptimalModel(db, { capabilities: ['chat'] }) as {
      id?: string;
      input_price_per_1k?: number;
      output_price_per_1k?: number;
    };
    expect(data.id).toBe('m1');
    // 正面断言：价格必须在场——它是桌面侧成本闸读的那两个键
    expect(typeof data.input_price_per_1k).toBe('number');
    expect(typeof data.output_price_per_1k).toBe('number');
    // 降级链三键必须在场（值可为 null：本例只有一个端点，无备用）
    for (const k of ['sameProviderFallback', 'crossProviderFallback', 'fallback'] as const) {
      expect(Object.prototype.hasOwnProperty.call(data, k)).toBe(true);
    }
  });

  it('M6-a: /optimal 回包带 capabilities（纯追加）且解析归 parseModelCapabilities', () => {
    const ok = resolveOptimalModel(db, { capabilities: ['chat'] }) as { capabilities?: unknown };
    expect(ok.capabilities).toEqual(['chat']);
    // 零命中回包**不带** capabilities（只有成功路上才有得说）
    const miss = resolveOptimalModel(db, { capabilities: ['audio'] }) as { capabilities?: unknown };
    expect(miss.capabilities).toBeUndefined();
  });

  it('M14: /optimal 回包带 capabilityMatch（**跨进程事实**：调用方算不出"当时有没有全中模型可选"，只有 ANS 知道）', () => {
    // 全中：m1 具备 chat ⇒ 'full'
    const full = resolveOptimalModel(db, { capabilities: ['chat'] }) as { capabilityMatch?: string };
    expect(full.capabilityMatch).toBe('full');
    // 部分命中：m1 有 chat 无 streaming ⇒ 全中池空、退用部分命中并**如实标降级**
    const partial = resolveOptimalModel(db, { capabilities: ['chat', 'streaming'] }) as {
      capabilityMatch?: string;
      id?: string;
    };
    expect(partial.id).toBe('m1');
    expect(partial.capabilityMatch).toBe('partial');
    // 真零命中：失败形回包，不带 capabilityMatch（失败路没有"主模型满足度"可说）
    const miss = resolveOptimalModel(db, { capabilities: ['audio'] }) as { capabilityMatch?: string };
    expect(miss.capabilityMatch).toBeUndefined();
  });

  it('B2: preferRemote —— 有远端选远端且带 usedLocalFallback=false；仅本地时如实 true；不传则无此键', () => {
    db.prepare(
      "INSERT INTO ans_ai_providers (id, name, base_url) VALUES ('p-local', 'ollama', 'http://127.0.0.1:11434')",
    ).run();
    db.prepare(
      "INSERT INTO ans_ai_models (id, provider_id, name, capabilities) VALUES ('m-local', 'p-local', 'qwen-local', '[\"chat\"]')",
    ).run();
    // 本地 priority 故意更高：preferRemote 生效时远端仍必须胜出
    db.prepare(
      "INSERT INTO ans_model_endpoints (id, model_id, url, api_key_ref, priority) VALUES ('e-local', 'm-local', 'http://127.0.0.1:11434/v1', ?, 99)",
    ).run(encryptApiKey('sk-local'));
    try {
      const remote = resolveOptimalModel(db, { capabilities: ['chat'], preferRemote: true }) as {
        id?: string;
        usedLocalFallback?: boolean;
      };
      expect(remote.id).toBe('m1');
      expect(remote.usedLocalFallback).toBe(false);
      expect('usedLocalFallback' in remote).toBe(true);

      db.prepare("UPDATE ans_model_endpoints SET status = 'inactive' WHERE id = 'e1'").run();
      const local = resolveOptimalModel(db, { capabilities: ['chat'], preferRemote: true }) as {
        id?: string;
        usedLocalFallback?: boolean;
      };
      expect(local.id).toBe('m-local');
      expect(local.usedLocalFallback).toBe(true);
      db.prepare("UPDATE ans_model_endpoints SET status = 'active' WHERE id = 'e1'").run();

      // 旧调用方：不传 preferRemote ⇒ 回包形状逐字不变（无 usedLocalFallback 键）
      const legacy = resolveOptimalModel(db, { capabilities: ['chat'] }) as unknown as Record<string, unknown>;
      expect('usedLocalFallback' in legacy).toBe(false);
    } finally {
      db.prepare("DELETE FROM ans_model_endpoints WHERE id = 'e-local'").run();
      db.prepare("DELETE FROM ans_ai_models WHERE id = 'm-local'").run();
      db.prepare("DELETE FROM ans_ai_providers WHERE id = 'p-local'").run();
    }
  });

  it('M6-a: parseModelCapabilities 两面标本——认得出来的要认出来，认不出的当空数组（不猜不抛）', () => {
    expect(parseModelCapabilities('["chat","vision"]')).toEqual(['chat', 'vision']);
    expect(parseModelCapabilities('[]')).toEqual([]);
    // 认不出的那一面：非字符串 / 解不开 / 不是数组 / 数组成分不是串 —— 一律空数组
    expect(parseModelCapabilities(null)).toEqual([]);
    expect(parseModelCapabilities(undefined)).toEqual([]);
    expect(parseModelCapabilities('')).toEqual([]);
    expect(parseModelCapabilities('{"a":1}')).toEqual([]);
    expect(parseModelCapabilities('not json')).toEqual([]);
    expect(parseModelCapabilities('["chat",1,null]')).toEqual(['chat']);
  });

  it('C2: 无端点模型不可用——GET /models 返回 has_endpoint/available', async () => {
    db.prepare(
      "INSERT INTO ans_ai_models (id, provider_id, name, capabilities) VALUES ('m2', 'p1', 'no-endpoint-model', '[\"chat\"]')",
    ).run();
    const r = await app.handle(jsonReq('/api/v1/models', 'GET'));
    const data = (await r.json()) as { data: Array<{ id: string; has_endpoint: boolean; available: boolean }> };
    const m1 = data.data.find((m) => m.id === 'm1')!;
    const m2 = data.data.find((m) => m.id === 'm2')!;
    expect(m1.has_endpoint).toBe(true);
    expect(m1.available).toBe(true);
    expect(m2.has_endpoint).toBe(false);
    expect(m2.available).toBe(false);
  });

  it('C2: GET /providers 返回 available_models 与 available 派生', async () => {
    await app.handle(jsonReq('/api/v1/models/providers/p1', 'PUT', { enabled: 1 })); // 复位（前序用例禁用过）
    const r = await app.handle(jsonReq('/api/v1/models/providers', 'GET'));
    const data = (await r.json()) as { data: Array<{ id: string; available_models: number; available: boolean }> };
    const p1 = data.data.find((p) => p.id === 'p1')!;
    expect(p1.available_models).toBe(1); // 只有 m1 有 active 端点
    expect(p1.available).toBe(true);
  });

  it('C1/C2: GET /models 返回 stats 使用统计 + quality_score（有数据聚合；无数据为 null）', async () => {
    db.prepare(
      "INSERT INTO ans_model_quality_logs (id, model_id, success, token_efficiency, latency_ms) VALUES ('q1', 'm1', 1, 0.8, 500)",
    ).run();
    db.prepare(
      "INSERT INTO ans_model_quality_logs (id, model_id, success, token_efficiency, latency_ms) VALUES ('q2', 'm1', 1, 0.9, 700)",
    ).run();
    db.prepare(
      "INSERT INTO ans_model_quality_logs (id, model_id, success, token_efficiency, latency_ms) VALUES ('q3', 'm1', 0, 0.5, 3000)",
    ).run();
    db.prepare(
      "INSERT INTO ans_billing_records (id, model_id, tokens_in, tokens_out, cost) VALUES ('b1', 'm1', 1000, 500, 0.03)",
    ).run();
    const r = await app.handle(jsonReq('/api/v1/models', 'GET'));
    const data = (await r.json()) as {
      data: Array<{
        id: string;
        stats: {
          call_count: number;
          success_rate: number | null;
          avg_latency_ms: number | null;
          total_cost: number;
          total_tokens: number;
        };
        quality_score: number | null;
      }>;
    };
    const m1 = data.data.find((m) => m.id === 'm1')!;
    expect(m1.stats.call_count).toBe(3);
    expect(m1.stats.success_rate).toBeCloseTo(2 / 3, 2);
    expect(m1.stats.total_cost).toBeCloseTo(0.03, 4);
    expect(m1.stats.total_tokens).toBe(1500);
    expect(m1.stats.avg_latency_ms).toBeGreaterThan(0);
    expect(m1.quality_score).not.toBeNull();
    const m2 = data.data.find((m) => m.id === 'm2')!;
    expect(m2.stats.call_count).toBe(0);
    expect(m2.quality_score).toBeNull(); // 无使用数据 → null（resource-matcher 行为不变）
  });

  it('C1: GET /providers 返回 stats 供应商级使用统计', async () => {
    const r = await app.handle(jsonReq('/api/v1/models/providers', 'GET'));
    const data = (await r.json()) as {
      data: Array<{ id: string; stats: { call_count: number; success_rate: number | null; total_cost: number } }>;
    };
    const p1 = data.data.find((p) => p.id === 'p1')!;
    expect(p1.stats.call_count).toBe(3); // m1 的 3 条 quality_logs
    expect(p1.stats.success_rate).toBeCloseTo(2 / 3, 2);
    expect(p1.stats.total_cost).toBeCloseTo(0.03, 4);
  });

  it('C4: POST /endpoints/:id/test 探测成功并持久化健康状态', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{"data":[{"id":"m1"}]}', { status: 200 }));
    try {
      const r = await app.handle(jsonReq('/api/v1/models/endpoints/e1/test', 'POST'));
      expect(r.status).toBe(200);
      const data = (await r.json()) as {
        data: {
          success: boolean;
          latency_ms: number;
          health_status: string;
          health_check_at: string;
          error: string | null;
        };
      };
      expect(data.data.success).toBe(true);
      expect(data.data.health_status).toBe('ok');
      expect(data.data.latency_ms).toBeGreaterThanOrEqual(0);
      expect(data.data.health_check_at).not.toBe('');
      const row = db
        .prepare('SELECT health_status, last_latency_ms, health_check_at FROM ans_model_endpoints WHERE id = ?')
        .get('e1') as { health_status: string; last_latency_ms: number; health_check_at: string };
      expect(row.health_status).toBe('ok');
      expect(row.last_latency_ms).toBeGreaterThanOrEqual(0);
      expect(row.health_check_at).not.toBe('');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('C4: 端点测试失败返回原因并持久化 fail', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 }));
    try {
      const r = await app.handle(jsonReq('/api/v1/models/endpoints/e1/test', 'POST'));
      const data = (await r.json()) as { data: { success: boolean; error: string | null; health_status: string } };
      expect(data.data.success).toBe(false);
      expect(data.data.error).toContain('500');
      expect(data.data.health_status).toBe('fail');
      const row = db.prepare('SELECT health_status FROM ans_model_endpoints WHERE id = ?').get('e1') as {
        health_status: string;
      };
      expect(row.health_status).toBe('fail');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('C4: 端点测试解密失败返回明确错误', async () => {
    db.prepare(
      "INSERT INTO ans_model_endpoints (id, model_id, url, api_key_ref) VALUES ('e2', 'm1', 'https://api.openai.com/v1', 'not-a-valid-encrypted-key')",
    ).run();
    const r = await app.handle(jsonReq('/api/v1/models/endpoints/e2/test', 'POST'));
    const data = (await r.json()) as { data: { success: boolean; error: string | null } };
    expect(data.data.success).toBe(false);
    expect(data.data.error).toContain('解密失败');
  });

  it('M6: Ollama 原生 /api/embed 端点用 POST 原 URL（不是 GET .../models）', async () => {
    db.prepare(
      "INSERT INTO ans_ai_models (id, provider_id, name, capabilities) VALUES ('m-embed', 'p1', 'nomic-embed-text-v2-moe:latest', '[\"embedding\"]')",
    ).run();
    db.prepare(
      "INSERT INTO ans_model_endpoints (id, model_id, url, api_key_ref) VALUES ('e-embed', 'm-embed', 'http://localhost:11434/api/embed', ?)",
    ).run(encryptApiKey('ollama'));
    const origFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{"embeddings":[[0.1]]}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const r = await app.handle(jsonReq('/api/v1/models/endpoints/e-embed/test', 'POST'));
      const data = (await r.json()) as { data: { success: boolean } };
      expect(data.data.success).toBe(true);
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toBe('http://localhost:11434/api/embed');
      expect(call.init?.method).toBe('POST');
      expect(JSON.parse(String(call.init?.body))).toEqual({ model: 'nomic-embed-text-v2-moe:latest', input: 'ping' });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('M6: 协议自适应纯函数——OpenAI 基址 GET /models；/v1/embeddings POST 原 URL', () => {
    expect(buildEndpointTestRequest('https://api.openai.com/v1')).toEqual({
      method: 'GET',
      url: 'https://api.openai.com/v1/models',
    });
    expect(buildEndpointTestRequest('https://x/v1/embeddings', 'e')).toEqual({
      method: 'POST',
      url: 'https://x/v1/embeddings',
      body: { model: 'e', input: 'ping' },
    });
    expect(buildEndpointTestRequest('http://h/api/embeddings', 'e')).toEqual({
      method: 'POST',
      url: 'http://h/api/embeddings',
      body: { model: 'e', prompt: 'ping' },
    });
  });
});

/**
 * zx_20261107_1 B6：币种单源——`provider_currency` 从目录 JSON 经三个出口如实带出，
 * 目录里查不到（用户自建 UUID）⇒ `null`，**不臆造**。
 */
describe('B6: 币种单源三出口', () => {
  let b6db: Database.Database;
  let b6app: ReturnType<typeof modelsRoutes>;

  beforeAll(() => {
    b6db = new Database(':memory:');
    b6db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', source TEXT DEFAULT 'user', enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER DEFAULT 4096, max_output_tokens INTEGER DEFAULT 1024, input_price_per_1k REAL DEFAULT 0, output_price_per_1k REAL DEFAULT 0, status TEXT DEFAULT 'active', source TEXT DEFAULT 'user', description TEXT DEFAULT '', enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), health_check_at TEXT DEFAULT '', health_status TEXT DEFAULT '', last_latency_ms INTEGER DEFAULT 0);
      CREATE TABLE ans_audit_logs (id TEXT PRIMARY KEY, actor TEXT, action TEXT, resource_type TEXT, resource_id TEXT, detail TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_model_quality_logs (id TEXT PRIMARY KEY, model_id TEXT, project_id TEXT, task_type TEXT, capability TEXT, success INTEGER DEFAULT 1, output_accepted INTEGER DEFAULT 1, token_efficiency REAL, latency_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE ans_billing_records (id TEXT PRIMARY KEY, endpoint_id TEXT, model_id TEXT, project_id TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0.0, currency TEXT DEFAULT 'USD', created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO ans_ai_providers (id, name, base_url, source) VALUES ('openai', 'OpenAI', 'https://api.openai.com/v1', 'system');
      INSERT INTO ans_ai_providers (id, name, base_url, source) VALUES ('uuid-user', '我的自建', 'http://127.0.0.1:11434', 'user');
      INSERT INTO ans_ai_models (id, provider_id, name, capabilities, source) VALUES ('gpt-6-astra', 'openai', 'gpt-6-astra', '["chat"]', 'system');
      INSERT INTO ans_ai_models (id, provider_id, name, capabilities, source) VALUES ('my-local', 'uuid-user', 'my-local', '["chat"]', 'user');
    `);
    const enc = encryptApiKey('sk-test');
    b6db
      .prepare(
        "INSERT INTO ans_model_endpoints (id, model_id, url, api_key_ref) VALUES ('e-openai', 'gpt-6-astra', 'https://api.openai.com/v1', ?)",
      )
      .run(enc);
    b6app = modelsRoutes(b6db);
  });

  it('/providers 每行带 currency：目录内 → USD；自建 UUID → null', async () => {
    const r = await b6app.handle(jsonReq('/api/v1/models/providers', 'GET'));
    const data = (await r.json()) as { data: Array<{ id: string; currency: string | null }> };
    expect(data.data.find((p) => p.id === 'openai')!.currency).toBe('USD');
    expect(data.data.find((p) => p.id === 'uuid-user')!.currency).toBeNull();
  });

  it('/recommended 的 provider_currency 与逐行 currency 同源于目录 JSON', async () => {
    const r = await b6app.handle(jsonReq('/api/v1/models/recommended', 'GET'));
    const data = (await r.json()) as {
      data: Array<{ id: string; currency: string | null }>;
      provider_currency: Record<string, string>;
      use_cases: unknown[];
    };
    expect(data.provider_currency.openai).toBe('USD');
    expect(data.provider_currency.deepseek).toBe('CNY');
    expect(data.data.find((m) => m.id === 'gpt-6-astra')!.currency).toBe('USD');
    // use_cases 仍原样回传（场景 bug 修复依赖这个键名）
    expect(Array.isArray(data.use_cases)).toBe(true);
    expect(data.use_cases.length).toBeGreaterThan(0);
  });

  it('/optimal 主模型带 provider_id + provider_currency', () => {
    const ok = resolveOptimalModel(b6db, { capabilities: ['chat'] }) as {
      provider_id?: string;
      provider_currency?: string | null;
    };
    expect(ok.provider_id).toBe('openai');
    expect(ok.provider_currency).toBe('USD');
  });
});
