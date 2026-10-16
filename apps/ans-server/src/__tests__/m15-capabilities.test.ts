/**
 * zx_20260930 M15-⑦：模型 `capabilities` 取值域。
 *
 * 病根：ANS 侧 schema 原为 `t.Array(t.String())`——**什么都放行**，
 *   `capabilities: ['__no_such_cap__']` 能一路落库，而落库值会被 `resource-matcher` 当筛选条件用。
 *
 * 判据纪律：
 *   G-1 直调生产导出（`validateCapabilities` / `MODEL_CAPABILITIES`），并经真路由跑一遍。
 *   G-2 正反两侧各给真标本：**合法值**（含活库在册的 `translation`）要收下；
 *       **表外值**、**空数组**、**非数组**要判死。
 *   G-7 夹具逐列照抄 schema.ts DDL。
 *   「必填」的边界（本项的**关键裁定**）：只能是"非空"，**不能是"必含 chat"**——
 *       活库有 7 个模型无 `chat`（6 个 embedding-only + `deepseek-r1: reasoning,streaming`），
 *       要求必含 `chat` 会把**合法的在册模型**判非法（违「判据须能被合法数据满足」）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Elysia } from 'elysia';
import Database from 'better-sqlite3';
import { MODEL_CAPABILITY_META } from '@worker-ant/shared-types';
import { MODEL_CAPABILITIES, isModelCapability, validateCapabilities } from '../services/model-capabilities.js';
import { modelsRoutes } from '../routes/models.js';
import { handleRouteError } from '../utils/error-handler.js';

function jsonReq(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('M15-⑦ validateCapabilities（纯函数：两侧标本）', () => {
  it('取值域**派生自真源**（不是手抄一份）——与 MODEL_CAPABILITY_META 的键集一字不差', () => {
    expect(MODEL_CAPABILITIES).toEqual(Object.keys(MODEL_CAPABILITY_META));
    // 正面断言：活库在册的第 11 值也在（此前 shared-types 只有 10 值，`qwen3.5:9b` 的
    //   `translation` 在库里"说得通"、在表里"查不到" ⇒ 一旦用 GUI 编辑它就会被误拒）
    expect(MODEL_CAPABILITIES).toContain('translation');
    expect(MODEL_CAPABILITIES.length).toBe(11);
  });

  it('合法值收下（含 translation）', () => {
    expect(validateCapabilities(['chat'])).toEqual({ ok: true, value: ['chat'] });
    expect(validateCapabilities(['reasoning', 'streaming'])).toEqual({ ok: true, value: ['reasoning', 'streaming'] });
    expect(validateCapabilities(['translation'])).toEqual({ ok: true, value: ['translation'] });
    expect(isModelCapability('translation')).toBe(true);
  });

  it('表外值判死，并把"不在域内的那几个"点出来', () => {
    const r = validateCapabilities(['chat', '__no_such_cap__']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('__no_such_cap__');
      expect(r.reason).toContain('chat'); // 合法值清单也在文案里，用户知道能填什么
    }
    expect(isModelCapability('__no_such_cap__')).toBe(false);
    expect(isModelCapability(1)).toBe(false);
    expect(isModelCapability(null)).toBe(false);
  });

  it('空数组判死（"没写能力"与"能力为空"都不该被当作合法建模）', () => {
    const r = validateCapabilities([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不可为空');
  });

  it('非数组判死', () => {
    expect(validateCapabilities('chat').ok).toBe(false);
    expect(validateCapabilities(null).ok).toBe(false);
    expect(validateCapabilities({}).ok).toBe(false);
  });

  it('边界：**不要求必含 chat** —— 活库真标本 `deepseek-r1: [reasoning, streaming]` 必须合法', () => {
    expect(validateCapabilities(['reasoning', 'streaming']).ok).toBe(true);
    expect(validateCapabilities(['embedding']).ok).toBe(true);
  });
});

describe('M15-⑦ 路由落库（真跑 POST/PUT）', () => {
  let db: Database.Database;
  // 类型由**构建表达式派生**（`models-routes.test.ts` 的成法）：`let app: Elysia` 是"裸泛型"，与带
  // 路由表的实例不同型（onStart 不兼容）⇒ 赋值处会 TS2322。派生型跟着 `.use()` 链走，不手抄。
  const buildApp = (d: Database.Database) => new Elysia().onError(handleRouteError).use(modelsRoutes(d));
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
    `);
    db.prepare(
      "INSERT INTO ans_ai_providers (id, name, base_url) VALUES ('p1', 'openai', 'https://api.openai.com')",
    ).run();
    db.prepare(
      "INSERT INTO ans_ai_models (id, provider_id, name, capabilities) VALUES ('m1', 'p1', 'gpt-4o', '[\"chat\"]')",
    ).run();
    app = buildApp(db);
  });

  const count = () => (db.prepare('SELECT COUNT(*) as c FROM ans_ai_models').get() as { c: number }).c;

  it('POST 合法能力 → 201，且**落库**的就是校验后的值（正面：行数 1→2）', async () => {
    const before = count();
    const res = await app.handle(
      jsonReq('/api/v1/models', 'POST', {
        provider_id: 'p1',
        name: 'qwen3.5:9b',
        capabilities: ['chat', 'translation'],
      }),
    );
    expect(res.status).toBe(201);
    expect(count()).toBe(before + 1); // G-3：「值从 0 变 1」的正面断言，不只看"不抛"
    const row = db.prepare("SELECT capabilities FROM ans_ai_models WHERE name = 'qwen3.5:9b'").get() as {
      capabilities: string;
    };
    expect(JSON.parse(row.capabilities)).toEqual(['chat', 'translation']);
  });

  it('POST 表外能力 → 400，且**一行都不落**（计数器正面断言）', async () => {
    const before = count();
    const res = await app.handle(
      jsonReq('/api/v1/models', 'POST', {
        provider_id: 'p1',
        name: 'dirty',
        capabilities: ['__no_such_cap__'],
      }),
    );
    expect(res.status).toBe(400);
    expect(count()).toBe(before); // 静默落库才算病根复发
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('__no_such_cap__');
  });

  it('POST 空数组 → 400（schema minItems 挡形状；经生产错误处置映射成 400 而非 Elysia 默认 422）', async () => {
    const before = count();
    const res = await app.handle(
      jsonReq('/api/v1/models', 'POST', {
        provider_id: 'p1',
        name: 'empty-caps',
        capabilities: [],
      }),
    );
    expect(res.status).toBe(400);
    expect(count()).toBe(before);
  });

  it('POST 缺 capabilities → 400（必填）', async () => {
    const before = count();
    const res = await app.handle(jsonReq('/api/v1/models', 'POST', { provider_id: 'p1', name: 'no-caps' }));
    expect(res.status).toBe(400);
    expect(count()).toBe(before);
  });

  it('**PUT {enabled} 不得被必填打成 400**（ModelsPage 启停开关只发这一个键）', async () => {
    const res = await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { enabled: 0 }));
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT enabled FROM ans_ai_models WHERE id = ?').get('m1') as { enabled: number };
    expect(row.enabled).toBe(0);
    await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { enabled: 1 }));
  });

  it('PUT 给了能力就校验：表外值 → 400 且**库里的值没被改**', async () => {
    const res = await app.handle(jsonReq('/api/v1/models/m1', 'PUT', { capabilities: ['__no_such_cap__'] }));
    expect(res.status).toBe(400);
    const row = db.prepare('SELECT capabilities FROM ans_ai_models WHERE id = ?').get('m1') as { capabilities: string };
    expect(JSON.parse(row.capabilities)).toEqual(['chat']); // 原值仍在
  });
});
