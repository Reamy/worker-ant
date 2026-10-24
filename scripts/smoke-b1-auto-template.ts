/**
 * B1 (2026-09-02): 成功拆解自动生成模板 autoCreateTemplatesFromSuccesses 定向验证（PLAN_zx_20260902.md Phase B1）。
 *
 * 用法：先打包再运行（同其它 smoke）：
 *   npx tsup scripts/smoke-b1-auto-template.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai --external pino --external pino-pretty --external pino-roll \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-b1-auto-template.mjs
 *
 * 数据库：node:sqlite 内存库(:memory:)。
 * 覆盖：
 *   1. 质量门：同 archetype 成功拆解 样本≥3 且成功率≥0.5 → 生成 source='auto' 模板（取最近成功父任务子任务结构）
 *   2. 样本不足（<3）不生成；成功率不足（<0.5）不生成
 *   3. 防重：二次调用同 archetype 不再生成
 *   4. 生成后 loadTemplatePool 入匹配池（source='auto' 可参与匹配）
 */
import { createRequire } from 'node:module';
import { autoCreateTemplatesFromSuccesses, loadTemplatePool, getTemplatePool } from '../apps/worker-ant-desktop/src/main/core/task-templates.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint } };
  };
};

let passCount = 0;
let failCount = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else { failCount++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE wa_task_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
    description TEXT DEFAULT '', subtasks TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
    source TEXT DEFAULT 'user', match_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '',
    title TEXT, description TEXT, acceptance_criteria TEXT, status TEXT,
    priority INTEGER DEFAULT 0, context_json TEXT DEFAULT '{}',
    depends_on TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// 插入一个 auto_decomposed 父任务 + children
function addParent(id: string, status: string, archetype: string, children: Array<{ t: string; d: string; a: string }>, updatedAt: string): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'proj-x', '', `${archetype} ${id} 标题`, status,
      JSON.stringify({ auto_decomposed: true, archetype, template: null }),
      updatedAt, updatedAt);
  children.forEach((c, i) => {
    db.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, acceptance_criteria, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`c_${id}_${i}`, 'proj-x', id, c.t, c.d, c.a, 'completed', i);
  });
}

const autoTemplates = (): Array<{ id: string; name: string; category: string; subtasks: string; keywords: string }> =>
  db.prepare("SELECT id, name, category, subtasks, keywords FROM wa_task_templates WHERE source='auto'").all() as Array<{ id: string; name: string; category: string; subtasks: string; keywords: string }>;

async function main(): Promise<void> {
  console.log('\n===== B1 成功拆解自动生成模板 验证 =====\n');

  // ===== 场景1：dashboard archetype 达标（3 样本 2 成功 → 率 0.667 ≥0.5）→ 生成 =====
  console.log('[1] 达标 archetype → 自动生成');
  // 3 个 dashboard 父任务：2 completed + 1 failed；代表 = 最近 updated 的 completed（含 2 子任务）
  addParent('d1', 'completed', 'dashboard', [{ t: '准备数据源', d: '连接数据库取数', a: '数据可查' }, { t: '绘制看板', d: '用图表库渲染', a: '看板可交互' }], '2026-09-02 10:00:00');
  addParent('d2', 'completed', 'dashboard', [{ t: '准备数据源', d: '…', a: '…' }, { t: '绘制看板', d: '…', a: '…' }], '2026-09-02 09:00:00');
  addParent('d3', 'failed', 'dashboard', [{ t: 'x', d: 'y', a: 'z' }], '2026-09-01 10:00:00');
  const created = autoCreateTemplatesFromSuccesses(db);
  assert('返回生成数 1', created === 1, `got ${created}`);
  const rows = autoTemplates();
  assert('库中 1 条 source=auto', rows.length === 1, `got ${rows.length}`);
  assert('category = archetype(dashboard)', rows[0]?.category === 'dashboard', rows[0]?.category);
  assert('subtasks 取最近成功代表(d1)的 2 个子任务', (JSON.parse(rows[0]?.subtasks || '[]') as unknown[]).length === 2, rows[0]?.subtasks);
  assert('keywords 非空（启发式提炼）', (JSON.parse(rows[0]?.keywords || '[]') as unknown[]).length > 0, rows[0]?.keywords);

  console.log('[2] 防重：二次调用不再生成');
  assert('二次调用返回 0', autoCreateTemplatesFromSuccesses(db) === 0);
  assert('库中仍 1 条', autoTemplates().length === 1);

  console.log('[3] 低质量 archetype（样本≥3 但成功率<0.5）→ 不生成');
  addParent('l1', 'failed', 'lowquality', [{ t: 'a', d: 'b', a: 'c' }], '2026-09-02 10:00:00');
  addParent('l2', 'failed', 'lowquality', [{ t: 'a', d: 'b', a: 'c' }], '2026-09-02 09:00:00');
  addParent('l3', 'completed', 'lowquality', [{ t: 'a', d: 'b', a: 'c' }, { t: 'd', d: 'e', a: 'f' }], '2026-09-02 08:00:00');
  assert('返回 0（率 1/3=0.33<0.5）', autoCreateTemplatesFromSuccesses(db) === 0);
  assert('无 lowquality auto 模板', autoTemplates().every(r => r.category !== 'lowquality'));

  console.log('[4] 样本不足 archetype（<3）→ 不生成');
  addParent('f1', 'completed', 'fewdata', [{ t: 'a', d: 'b', a: 'c' }, { t: 'd', d: 'e', a: 'f' }], '2026-09-02 10:00:00');
  addParent('f2', 'completed', 'fewdata', [{ t: 'a', d: 'b', a: 'c' }, { t: 'd', d: 'e', a: 'f' }], '2026-09-02 09:00:00');
  assert('返回 0（仅 2 样本）', autoCreateTemplatesFromSuccesses(db) === 0);
  assert('无 fewdata auto 模板', autoTemplates().every(r => r.category !== 'fewdata'));

  console.log('[5] 生成后入匹配池（loadTemplatePool 重载后可见）');
  const pool = getTemplatePool();
  assert('模板池含 source=auto 模板', pool.some(t => t.source === 'auto' && t.category === 'dashboard'), `pool=${pool.length}`);
  // loadTemplatePool 重载后仍可见（表里 status='active'）
  loadTemplatePool(db);
  const pool2 = getTemplatePool();
  assert('重载后仍含 auto 模板', pool2.some(t => t.source === 'auto' && t.category === 'dashboard'));

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====`);
  process.exit(failCount > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
