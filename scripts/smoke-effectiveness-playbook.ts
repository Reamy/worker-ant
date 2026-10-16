/**
 * Phase B(记忆有效性) + Phase C(执行元认知) 纯逻辑冒烟测试（PLAN_20260827_zx.md）。
 *
 * 用法（同 smoke-phase-a，tsx 不可用时用 tsup 打包）：
 *   npx tsup scripts/smoke-effectiveness-playbook.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai \
 *     --external pino --external pino-pretty --external pino-roll \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-effectiveness-playbook.mjs
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：
 *   B buildMemoryEffectivenessStats：按 memory_type 统计注入后任务成功率
 *   C buildExecutionPlaybook：按 archetype 从 tool_usage 学执行打法(优先/避免工具)
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
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'pending',
    context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
`);

const ansClient = { getOptimalModel: async () => null } as unknown as import('@worker-ant/ans-client').AnsClient;
const memory = new MemoryManager(db, ansClient);

function seedMem(id: string, type: string): void {
  db.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type) VALUES (?, 'p1', ?, ?)").run(id, `${type} ${id}`, type);
}
function seedTask(id: string, memIds: string[], status: string): void {
  db.prepare("INSERT INTO wa_tasks (id, project_id, status, context_json) VALUES (?, 'p1', ?, ?)").run(id, status, JSON.stringify({ injected_memory_ids: memIds }));
}

function main(): void {
  console.log('\n===== 记忆有效性 + 执行元认知 冒烟测试 =====\n');

  // ===== B: buildMemoryEffectivenessStats =====
  seedMem('s1', 'semantic');
  seedMem('s2', 'semantic');
  seedMem('p1m', 'procedural');
  seedMem('p2m', 'procedural');
  // semantic: s1 注入 2 次成功, s2 注入 1 次失败 → 2成1败, 3样本, 成功率 0.67
  // procedural: p1m 注入 1 次成功, p2m 注入 2 次失败 → 1成2败, 3样本, 成功率 0.33
  seedTask('t1', ['s1'], 'completed');
  seedTask('t2', ['s1'], 'completed');
  seedTask('t3', ['s2'], 'failed');
  seedTask('t4', ['p1m'], 'completed');
  seedTask('t5', ['p2m'], 'failed');
  seedTask('t6', ['p2m'], 'failed');

  console.log('[1] buildMemoryEffectivenessStats 按类型统计成功率');
  const stats = memory.buildMemoryEffectivenessStats('p1');
  const sem = stats.find(s => s.memoryType === 'semantic');
  const proc = stats.find(s => s.memoryType === 'procedural');
  assert('产出 semantic + procedural 两类', !!sem && !!proc, `实际=${stats.map(s => s.memoryType).join(',')}`);
  assert('semantic 成功率 2/3≈0.67', !!sem && Math.abs(sem.successRate - 2 / 3) < 0.01, `实际=${sem?.successRate}`);
  assert('procedural 成功率 1/3≈0.33', !!proc && Math.abs(proc.successRate - 1 / 3) < 0.01, `实际=${proc?.successRate}`);

  // ===== C: buildExecutionPlaybook =====
  db.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p1', '测试', ?)").run(JSON.stringify({
    tool_usage: {
      'read_file:code': { toolName: 'read_file', archetype: 'code', successCount: 8, failCount: 1 },
      'search_content:code': { toolName: 'search_content', archetype: 'code', successCount: 1, failCount: 4 },
      'write_file:document': { toolName: 'write_file', archetype: 'document', successCount: 5, failCount: 0 },
    },
  }));

  console.log('\n[2] buildExecutionPlaybook 按 archetype 学打法');
  const playbook = memory.buildExecutionPlaybook('p1');
  const codePb = playbook['code'];
  const docPb = playbook['document'];
  assert('code 打法含「优先: read_file」', !!codePb && codePb.includes('优先: read_file'), `实际=${codePb}`);
  assert('code 打法含「避免: search_content」', !!codePb && codePb.includes('避免: search_content'), `实际=${codePb}`);
  assert('document 打法含「优先: write_file」', !!docPb && docPb.includes('优先: write_file'), `实际=${docPb}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
