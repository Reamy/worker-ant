/**
 * Gateway端到端测试：验证模型匹配+API调用完整链路。
 * 使用内存数据库模拟完整流程。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { matchOptimalModel } from '../services/resource-matcher.js';
import { encryptApiKey, decryptApiKey } from '../utils/security.js';

describe('Gateway E2E', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
      CREATE TABLE ans_billing_records (id TEXT PRIMARY KEY, endpoint_id TEXT, model_id TEXT, project_id TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0.0, created_at TEXT DEFAULT (datetime('now')));
    `);

    // 添加测试数据
    db.prepare("INSERT INTO ans_ai_providers VALUES ('p1', 'openai', 'https://api.openai.com', 'active', 1)").run();
    db.prepare("INSERT INTO ans_ai_providers VALUES ('p2', 'deepseek', 'https://api.deepseek.com', 'active', 1)").run();

    db.prepare(
      "INSERT INTO ans_ai_models VALUES ('m1', 'p1', 'gpt-4o', '[\"chat\",\"vision\"]', 128000, 4096, 0.035, 0.105, 'active', 1)",
    ).run();
    db.prepare(
      "INSERT INTO ans_ai_models VALUES ('m2', 'p2', 'deepseek-chat', '[\"chat\"]', 128000, 4096, 0.001, 0.002, 'active', 1)",
    ).run();

    const encKey = encryptApiKey('sk-test-openai-key');
    db.prepare(
      "INSERT INTO ans_model_endpoints VALUES ('e1', 'm1', 'https://api.openai.com/v1', ?, 0, 1.0, 'active', 0)",
    ).run(encKey);
    const encKey2 = encryptApiKey('sk-test-deepseek-key');
    db.prepare(
      "INSERT INTO ans_model_endpoints VALUES ('e2', 'm2', 'https://api.deepseek.com/v1', ?, 10, 1.0, 'active', 0)",
    ).run(encKey2);
  });

  it('matchOptimalModel returns primary and fallback for chat', () => {
    const result = matchOptimalModel(db, { capabilities: ['chat'], strategy: 'cost-optimal' });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).toBe('m2'); // deepseek cheaper
  });

  it('matchOptimalModel with preferredProvider', () => {
    const result = matchOptimalModel(db, { capabilities: ['chat'], preferredProvider: 'p1' });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).toBe('m1');
  });

  it('matchOptimalModel with maxCost filter', () => {
    const result = matchOptimalModel(db, { capabilities: ['chat'], maxCostPer1k: 0.01 });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).toBe('m2'); // only deepseek under 0.01
  });

  it('matchOptimalModel returns null for unmatched capability', () => {
    const result = matchOptimalModel(db, { capabilities: ['audio'] });
    expect(result.primary).toBeNull();
  });

  it('encryptApiKey/decryptApiKey round-trip', () => {
    const original = 'sk-prod-secret-1234567890abcdef';
    const encrypted = encryptApiKey(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).not.toContain('sk-prod');
    const decrypted = decryptApiKey(encrypted);
    expect(decrypted).toBe(original);
  });

  it('decryptApiKey from stored endpoint', () => {
    const ep = db.prepare("SELECT api_key_ref FROM ans_model_endpoints WHERE id = 'e1'").get() as {
      api_key_ref: string;
    };
    const decrypted = decryptApiKey(ep.api_key_ref);
    expect(decrypted).toBe('sk-test-openai-key');
  });

  it('billing records inserted correctly', () => {
    db.prepare(
      'INSERT INTO ans_billing_records (id, endpoint_id, model_id, project_id, tokens_in, tokens_out, cost) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('b1', 'e1', 'm1', 'proj-1', 100, 200, 0.0255);
    const stats = db
      .prepare(
        'SELECT SUM(tokens_in) as total_in, SUM(tokens_out) as total_out, SUM(cost) as total_cost FROM ans_billing_records WHERE model_id = ?',
      )
      .get('m1') as { total_in: number; total_out: number; total_cost: number };
    expect(stats.total_in).toBe(100);
    expect(stats.total_out).toBe(200);
    expect(stats.total_cost).toBeCloseTo(0.0255, 4);
  });
});
