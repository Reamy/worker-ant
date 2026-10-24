/**
 * Phase A(记忆加工深度/格物致知) 纯逻辑冒烟测试（PLAN_20260827_zx_2.md）。
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：maturityOf 深加工加速(×1.5)、confidenceOf 深加工 +0.05、
 *       retrieveByType 深加工排序优先(_processingDepthBoost)。
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

function setDepth(memId: string, depth: 'deep' | 'shallow'): void {
  const row = db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(memId) as { context_json: string };
  const ctx = JSON.parse(row.context_json || '{}');
  ctx.processing_depth = depth;
  db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), memId);
}
function getMem(memId: string): never {
  return db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(memId) as never;
}

function main(): void {
  console.log('\n===== 记忆加工深度(processing_depth) 纯逻辑冒烟测试 =====\n');

  // [1] maturityOf 深加工加速
  console.log('[1] 深加工记忆成熟加速(×1.5)');
  const deepId = memory.storeText({ project_id: 'p1', content: '规律：先 read 后 edit 再验证是编码任务的高效打法', type: 'semantic' });
  const shallowId = memory.storeText({ project_id: 'p1', content: '今天端口用了 3018', type: 'semantic' });
  setDepth(deepId, 'deep');
  setDepth(shallowId, 'shallow');
  // 使两条基础分一致（同 success_count/created_at）
  db.prepare('UPDATE wa_memories SET success_count = 3, created_at = datetime(\'now\', \'-30 days\') WHERE id IN (?, ?)').run(deepId, shallowId);
  const matDeep = memory.maturityOf(getMem(deepId));
  const matShallow = memory.maturityOf(getMem(shallowId));
  assert('deep 记忆 maturity > shallow', matDeep > matShallow, `deep=${matDeep.toFixed(3)} shallow=${matShallow.toFixed(3)}`);

  // [2] confidenceOf 深加工 +0.05
  console.log('\n[2] 深加工记忆可信度更高');
  const confDeep = memory.confidenceOf(getMem(deepId));
  const confShallow = memory.confidenceOf(getMem(shallowId));
  assert('deep 记忆 confidence > shallow', confDeep > confShallow, `deep=${confDeep.toFixed(3)} shallow=${confShallow.toFixed(3)}`);

  // [3] retrieveByType 深加工排序优先
  console.log('\n[3] 深加工记忆检索排序优先');
  const aId = memory.storeText({ project_id: 'p2', content: '深加工：跨项目通用部署流程', type: 'procedural' });
  const bId = memory.storeText({ project_id: 'p2', content: '浅加工：今天临时改了个端口', type: 'procedural' });
  setDepth(aId, 'deep');
  setDepth(bId, 'shallow');
  db.prepare('UPDATE wa_memories SET importance = 0.6, success_count = 2, use_count = 2, last_used_at = datetime(\'now\') WHERE id IN (?, ?)').run(aId, bId);
  const ranked = memory.retrieveByType('procedural', 'p2', 10);
  const idxA = ranked.findIndex(r => r.id === aId);
  const idxB = ranked.findIndex(r => r.id === bId);
  assert('deep 记忆排在同分 shallow 记忆之前', idxA >= 0 && idxB >= 0 && idxA < idxB, `deep@${idxA} shallow@${idxB}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
