/**
 * A1 (2026-09-02): 工作记忆→长期记忆巩固门 promoteWorkingMemory 定向验证（PLAN_zx_20260902.md Phase A1）。
 *
 * 用法：先打包再运行（同其它 smoke）：
 *   npx tsup scripts/smoke-a1-working-memory.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-a1-working-memory.mjs
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库。
 * 覆盖：
 *   1. promoteWorkingMemory 成功任务：工作笔记写入 wa_memories（source='working_memory:*'，content 含成败上下文）
 *   2. 去重：二次 promote 同一任务同一笔记 → 条数不增（sameSourceReplace 合并）
 *   3. 空工作记忆任务 → 返回 0 静默
 *   4. 过短笔记(<10字符) → 跳过不沉淀
 *   5. 检索侧：episodic 记忆可被 retrieveByType 召回
 */
import { createRequire } from 'node:module';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';

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
  CREATE TABLE wa_memories (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
    content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
    importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
    user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
    is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    use_count INTEGER DEFAULT 0, last_used_at TEXT, similar_to TEXT DEFAULT '',
    last_reinforced_at TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0
  );
  CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, context_json TEXT DEFAULT '{}'
  );
`);

const ansClient = { getOptimalModel: async () => null } as unknown as import('@worker-ant/ans-client').AnsClient;
const memory = new MemoryManager(db, ansClient);

const countWm = (): number => (db.prepare("SELECT COUNT(*) as c FROM wa_memories WHERE source LIKE 'working_memory:%'").get() as { c: number }).c;

async function main(): Promise<void> {
  console.log('\n===== A1 工作记忆→长期记忆巩固门 验证 =====\n');

  // 0. 准备：带工作记忆的成功任务 t1（2 条有价值笔记 + 1 条过短笔记应被跳过）
  const wmNotes = [
    { content: 'MCP 服务配置的关键：先在 ans 侧建 mcp_server，再重启工蚁加载 cached_tools', ts: new Date().toISOString() },
    { content: '部署验证要点：用 execute_command 测连通而非只看注册成功', ts: new Date().toISOString() },
    { content: '太短', ts: new Date().toISOString() },
  ];
  db.prepare('INSERT INTO wa_tasks (id, title, description, status, context_json) VALUES (?, ?, ?, ?, ?)').run(
    't1', '配置 MCP 服务器并验证', '', 'completed',
    JSON.stringify({ working_memory: wmNotes, archetype: 'configuration' }),
  );
  // 空工作记忆任务 t2（失败路径也测）
  db.prepare('INSERT INTO wa_tasks (id, title, description, status, context_json) VALUES (?, ?, ?, ?, ?)').run(
    't2', '空笔记任务', '', 'failed', JSON.stringify({ working_memory: [] }),
  );

  console.log('[1] promoteWorkingMemory 成功任务');
  const promoted = memory.promoteWorkingMemory('t1', 'proj-1', true);
  assert('返回条数 = 2（过短笔记被跳过）', promoted === 2, `got ${promoted}`);
  const rows = db.prepare("SELECT content, source, memory_type, valence, context_json FROM wa_memories WHERE source LIKE 'working_memory:%'").all() as Array<{ content: string; source: string; memory_type: string; valence: string; context_json: string }>;
  assert('落库 2 条 source=working_memory:*', rows.length === 2, `got ${rows.length}`);
  assert('content 含成败上下文[成功任务', rows.every(r => r.content.includes('[成功任务')), JSON.stringify(rows.map(r => r.content.slice(0, 40))));
  assert('memory_type=episodic', rows.every(r => r.memory_type === 'episodic'));
  assert('valence=positive', rows.every(r => r.valence === 'positive'));
  assert('context_json 含 encoding_context.archetype=configuration（storeText 编码语境）', rows.every(r => (r.context_json || '').includes('configuration')));
  assert('source 不含过短笔记', rows.every(r => !r.content.includes('太短')));

  console.log('[2] 二次 promote 同一任务 → 去重（条数不增）');
  const promoted2 = memory.promoteWorkingMemory('t1', 'proj-1', true);
  assert('返回条数仍 = 2', promoted2 === 2, `got ${promoted2}`);
  assert('DB 总条数仍 = 2（sameSourceReplace 合并而非重复插入）', countWm() === 2, `got ${countWm()}`);
  const updatedRow = db.prepare("SELECT content FROM wa_memories WHERE source LIKE 'working_memory:%' LIMIT 1").get() as { content: string };
  assert('同源记忆合并带 [更新] 标记', (updatedRow.content || '').includes('[更新]'), updatedRow.content.slice(0, 60));

  console.log('[3] 空工作记忆任务 → 返回 0 静默');
  const p3 = memory.promoteWorkingMemory('t2', 'proj-1', false);
  assert('返回 0', p3 === 0, `got ${p3}`);
  assert('不新增任何记忆', countWm() === 2, `got ${countWm()}`);

  console.log('[4] 检索侧召回（episodic 可被 retrieveByType 命中）');
  const hits = memory.retrieveByType('episodic', 'proj-1', 5);
  assert('retrieveByType 命中沉淀的工作记忆', hits.some(h => h.source === rows[0]!.source), `hits=${hits.length}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====`);
  process.exit(failCount > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
