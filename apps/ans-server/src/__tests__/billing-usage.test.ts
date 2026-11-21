/**
 * zx_20261117_2「名」：`GET /api/v1/billing/usage` 必须带回**人可见的模型名**。
 *
 * 病根（真库 `data/ans-server.db` 2026-11-17）：该接口此前只投影 `model_id`，渲染层首选
 * `model_name` 恒为 undefined，于是兜到 `model_id.slice(0,20)`——Ollama 等 UUID 主键模型
 * （`27683d97-…` = `qwen3.5:9b`）在运维看板「Token 消耗（按模型）」里显示成 UUID 前缀。
 *
 * 两条规矩在本用例里钉死：
 *   ① 聚合粒度不变——仍只按 `model_id` 分组（zx_20261112_2 B4 的单一真源）；
 *   ② JOIN 只取显示名——孤儿账（模型表查无此 id）如实回 `model_name: null`，不伪造、不并账。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { billingRoutes } from '../routes/billing.js';

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: 'GET' });
}

interface UsageRow {
  model_id: string;
  model_name: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost: number;
  call_count: number;
}

describe('zx_20261117_2 billing usage: 回包带模型名', () => {
  let db: Database.Database;
  let app: ReturnType<typeof billingRoutes>;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE ans_billing_records (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT,
        model_id TEXT,
        project_id TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost REAL DEFAULT 0.0,
        currency TEXT DEFAULT 'USD',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO ans_ai_models (id, name) VALUES (?, ?)').run(
      '27683d97-a588-4784-89e5-d67e3318bf5d',
      'qwen3.5:9b',
    );
    db.prepare('INSERT INTO ans_ai_models (id, name) VALUES (?, ?)').run('deepseek-v4-flash', 'deepseek-v4-flash');

    const ins = db.prepare(
      'INSERT INTO ans_billing_records (id, model_id, tokens_in, tokens_out, cost) VALUES (?, ?, ?, ?, ?)',
    );
    // UUID 主键模型两笔（验证按 id 聚合未被打散）
    ins.run('b1', '27683d97-a588-4784-89e5-d67e3318bf5d', 100, 50, 0.01);
    ins.run('b2', '27683d97-a588-4784-89e5-d67e3318bf5d', 200, 100, 0.02);
    // id 恰等于名字的常见形态
    ins.run('b3', 'deepseek-v4-flash', 400, 200, 0.03);
    // 孤儿账：模型表里查无此 id（真库标本 `qwen2.5:3b`）
    ins.run('b4', 'qwen2.5:3b', 7, 3, 0.001);

    app = billingRoutes(db);
  });

  async function fetchUsage(): Promise<UsageRow[]> {
    const r = await app.handle(get('/api/v1/billing/usage?days=30'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: UsageRow[] };
    return body.data;
  }

  it('N-01 UUID 主键模型回人可见名（qwen3.5:9b），而非只有 id', async () => {
    const rows = await fetchUsage();
    const uuidRow = rows.find((x) => x.model_id === '27683d97-a588-4784-89e5-d67e3318bf5d');
    expect(uuidRow).toBeDefined();
    expect(uuidRow?.model_name).toBe('qwen3.5:9b');
  });

  it('N-02 按 model_id 聚合不变：两笔并一行，token 合计 300/150，call_count=2', async () => {
    const rows = await fetchUsage();
    const uuidRow = rows.find((x) => x.model_id === '27683d97-a588-4784-89e5-d67e3318bf5d');
    expect(uuidRow?.total_tokens_in).toBe(300);
    expect(uuidRow?.total_tokens_out).toBe(150);
    expect(uuidRow?.call_count).toBe(2);
    // 每个 model_id 恰一行（没有因 JOIN 被拆散）
    expect(rows.filter((x) => x.model_id === '27683d97-a588-4784-89e5-d67e3318bf5d')).toHaveLength(1);
  });

  it('N-03 孤儿账如实回 model_name=null（不伪造、不并入同名/他模型）', async () => {
    const rows = await fetchUsage();
    const orphan = rows.find((x) => x.model_id === 'qwen2.5:3b');
    expect(orphan).toBeDefined();
    expect(orphan?.model_name).toBeNull();
    // 孤儿与其余模型各占一行
    expect(rows).toHaveLength(3);
  });

  it('N-04 id 恰等于名字的模型也有 model_name 列（不靠渲染层猜）', async () => {
    const rows = await fetchUsage();
    const row = rows.find((x) => x.model_id === 'deepseek-v4-flash');
    expect(row?.model_name).toBe('deepseek-v4-flash');
  });
});
