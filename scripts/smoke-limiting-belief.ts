/**
 * Phase C(自我设限信念/破心中贼) 存取闭环冒烟测试（PLAN_20260827_zx_1.md）。
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：memory_type='limiting_belief' 记忆的 storeText 存取 + retrieveByType 检索
 *       （buildMemoryContext「心中贼提醒」section 依赖的检索路径）。
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
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE wa_task_conversations (
    id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
  );
`);

const ansClient = { getOptimalModel: async () => null } as unknown as import('@worker-ant/ans-client').AnsClient;
const memory = new MemoryManager(db, ansClient);

function main(): void {
  console.log('\n===== 自我设限信念(limiting_belief) 存取闭环冒烟测试 =====\n');

  const id = memory.storeText({ project_id: 'p1', content: '[心中贼] 认为本任务需要人工介入', type: 'limiting_belief', source: 'limiting_belief' });
  assert('storeText 存 limiting_belief 返回 id', !!id);

  const hits = memory.retrieveByType('limiting_belief', 'p1', 5);
  assert('retrieveByType 检索到 limiting_belief 记忆', hits.length === 1 && hits[0]!.id === id, `hits=${hits.length}`);
  assert('记忆 source 为 limiting_belief', hits[0]?.source === 'limiting_belief', `source=${hits[0]?.source}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
