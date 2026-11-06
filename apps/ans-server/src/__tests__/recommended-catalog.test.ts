/**
 * zx_20261106_2：推荐目录**同步**行为 + 目录 JSON 完整性。
 *
 * 旧实现 `INSERT OR IGNORE` 的病：目录 JSON 改了，库里已有的 `source='system'` 行一个字都不会变。
 * 这里钉四件事：
 *   ① 新行会插入、内容变了会更新（且只报真实变化数）；
 *   ② 用户自建行（`source='user'`）即使 id 撞名也不被覆盖；
 *   ③ 用户对 system 行的运行态选择（enabled / status）不被目录同步重写；
 *   ④ 同一份目录连跑两次，第二次是 0 变化（幂等，日志不说假话）。
 *
 * 另附真实目录文件的结构断言：id 唯一、provider 引用存在、能力词表合法、价格非负、
 *   `use_cases` 的主/备模型都能在 models 里找到。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from '../db/schema.js';
import {
  syncRecommendedCatalog,
  readRecommendedCatalog,
  type RecommendedCatalogConfig,
} from '../services/recommended-catalog.js';

function fixture(): RecommendedCatalogConfig {
  return {
    version: 'test',
    providers: [{ id: 'p1', name: 'Provider One', base_url: 'https://p1.example.com' }],
    models: [
      {
        id: 'm1',
        provider_id: 'p1',
        name: 'Model One',
        capabilities: ['chat', 'function-calling'],
        context_window: 128000,
        max_output_tokens: 8192,
        input_price_per_1k: 0.001,
        output_price_per_1k: 0.002,
        description: 'first',
      },
    ],
  };
}

describe('syncRecommendedCatalog', () => {
  let db: ReturnType<typeof initDatabase>;

  beforeEach(() => {
    db = initDatabase(':memory:');
  });

  it('首次同步：插入 system 行并如实计数', () => {
    const r = syncRecommendedCatalog(db, fixture());
    expect(r).toEqual({ providersInserted: 1, providersUpdated: 0, modelsInserted: 1, modelsUpdated: 0 });
    const p = db.prepare('SELECT name, base_url, source FROM ans_ai_providers WHERE id = ?').get('p1') as {
      name: string;
      base_url: string;
      source: string;
    };
    expect(p).toEqual({ name: 'Provider One', base_url: 'https://p1.example.com', source: 'system' });
    const m = db
      .prepare(
        'SELECT capabilities, input_price_per_1k, output_price_per_1k, description, source FROM ans_ai_models WHERE id = ?',
      )
      .get('m1') as {
      capabilities: string;
      input_price_per_1k: number;
      output_price_per_1k: number;
      description: string;
      source: string;
    };
    expect(JSON.parse(m.capabilities)).toEqual(['chat', 'function-calling']);
    expect(m.input_price_per_1k).toBe(0.001);
    expect(m.output_price_per_1k).toBe(0.002);
    expect(m.description).toBe('first');
    expect(m.source).toBe('system');
  });

  it('目录内容变化：更新 system 行（价格/说明跟着变）', () => {
    syncRecommendedCatalog(db, fixture());
    const next = fixture();
    next.providers[0]!.name = 'Provider One Renamed';
    next.models[0]!.input_price_per_1k = 0.003;
    next.models[0]!.description = 'second';

    const r = syncRecommendedCatalog(db, next);
    expect(r).toEqual({ providersInserted: 0, providersUpdated: 1, modelsInserted: 0, modelsUpdated: 1 });
    const p = db.prepare('SELECT name FROM ans_ai_providers WHERE id = ?').get('p1') as { name: string };
    expect(p.name).toBe('Provider One Renamed');
    const m = db.prepare('SELECT input_price_per_1k, description FROM ans_ai_models WHERE id = ?').get('m1') as {
      input_price_per_1k: number;
      description: string;
    };
    expect(m.input_price_per_1k).toBe(0.003);
    expect(m.description).toBe('second');
  });

  it('幂等：同一份目录连跑两次，第二次零变化', () => {
    syncRecommendedCatalog(db, fixture());
    const r = syncRecommendedCatalog(db, fixture());
    expect(r).toEqual({ providersInserted: 0, providersUpdated: 0, modelsInserted: 0, modelsUpdated: 0 });
  });

  it('用户自建行（source=user）即使 id 撞名也不被覆盖', () => {
    db.prepare("INSERT INTO ans_ai_providers (id, name, source) VALUES ('p1', 'My Own Provider', 'user')").run();
    db.prepare(
      "INSERT INTO ans_ai_models (id, provider_id, name, input_price_per_1k, source) VALUES ('m1', 'p1', 'My Own Model', 9.9, 'user')",
    ).run();

    const r = syncRecommendedCatalog(db, fixture());
    expect(r.providersInserted).toBe(0);
    expect(r.modelsInserted).toBe(0);
    expect(r.providersUpdated).toBe(0);
    expect(r.modelsUpdated).toBe(0);

    const p = db.prepare('SELECT name, source FROM ans_ai_providers WHERE id = ?').get('p1') as {
      name: string;
      source: string;
    };
    expect(p).toEqual({ name: 'My Own Provider', source: 'user' });
    const m = db.prepare('SELECT name, input_price_per_1k, source FROM ans_ai_models WHERE id = ?').get('m1') as {
      name: string;
      input_price_per_1k: number;
      source: string;
    };
    expect(m).toEqual({ name: 'My Own Model', input_price_per_1k: 9.9, source: 'user' });
  });

  it('用户对 system 行的启停选择不被目录同步重写', () => {
    syncRecommendedCatalog(db, fixture());
    db.prepare("UPDATE ans_ai_models SET enabled = 0, status = 'disabled' WHERE id = 'm1'").run();

    const next = fixture();
    next.models[0]!.output_price_per_1k = 0.004;
    syncRecommendedCatalog(db, next);

    const m = db.prepare('SELECT enabled, status, output_price_per_1k FROM ans_ai_models WHERE id = ?').get('m1') as {
      enabled: number;
      status: string;
      output_price_per_1k: number;
    };
    expect(m.enabled).toBe(0);
    expect(m.status).toBe('disabled');
    expect(m.output_price_per_1k).toBe(0.004);
  });

  it('非法目录在写库前就拒绝', () => {
    const bad = fixture();
    bad.models[0]!.provider_id = 'missing';
    expect(() => syncRecommendedCatalog(db, bad)).toThrow(/不存在的 provider/);
    const count = db.prepare('SELECT COUNT(*) AS n FROM ans_ai_models').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('recommended-models.json 真实目录', () => {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '../data/recommended-models.json');
  const config = readRecommendedCatalog(configPath);
  const providerIds = new Set(config.providers.map((p) => p.id));
  const modelIds = new Set(config.models.map((m) => m.id));

  it('provider / model id 唯一且非空', () => {
    expect(providerIds.size).toBe(config.providers.length);
    expect(modelIds.size).toBe(config.models.length);
    for (const p of config.providers) expect(p.id.trim()).not.toBe('');
    for (const m of config.models) expect(m.id.trim()).not.toBe('');
  });

  it('每个模型的 provider_id 都存在', () => {
    for (const m of config.models) {
      expect(providerIds.has(m.provider_id), `${m.id} -> ${m.provider_id}`).toBe(true);
    }
  });

  it('能力值都在共享词表内', () => {
    const allowed = new Set([
      'chat',
      'function-calling',
      'structured_output',
      'vision',
      'embedding',
      'reasoning',
      'streaming',
      'code',
      'image-generation',
      'audio',
      'translation',
    ]);
    for (const m of config.models) {
      for (const cap of m.capabilities ?? []) {
        expect(allowed.has(cap), `${m.id} 含未知能力 ${cap}`).toBe(true);
      }
      expect((m.capabilities ?? []).length, `${m.id} 无能力标注`).toBeGreaterThan(0);
    }
  });

  it('价格非负、上下文/输出上限为正（嵌入模型输出可为 0）', () => {
    for (const m of config.models) {
      expect(Number.isFinite(m.input_price_per_1k)).toBe(true);
      expect(Number.isFinite(m.output_price_per_1k)).toBe(true);
      expect(m.input_price_per_1k!).toBeGreaterThanOrEqual(0);
      expect(m.output_price_per_1k!).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(m.context_window)).toBe(true);
      expect(m.context_window!).toBeGreaterThan(0);
      const hasEmbedding = (m.capabilities ?? []).includes('embedding');
      if (hasEmbedding) expect(m.max_output_tokens!).toBeGreaterThanOrEqual(0);
      else expect(m.max_output_tokens!).toBeGreaterThan(0);
    }
  });

  it('use_cases 的 primary / fallback 都指向存在的模型', () => {
    for (const uc of config.use_cases ?? []) {
      const u = uc as { title?: string; primary?: string | string[]; fallback?: string | string[] };
      const refs = [u.primary, u.fallback].flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []));
      for (const id of refs) {
        expect(modelIds.has(id), `${u.title} 引用不存在的模型 ${id}`).toBe(true);
      }
    }
  });

  it('provider_currency 覆盖全部 provider', () => {
    const currency = (config as unknown as { provider_currency?: Record<string, string> }).provider_currency ?? {};
    for (const p of config.providers) {
      expect(currency[p.id], `${p.id} 缺货币标注`).toBeTruthy();
    }
  });
});
