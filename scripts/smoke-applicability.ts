/**
 * Phase A(记忆缘起条件) 纯逻辑冒烟测试（PLAN_20260827_zx_1.md）。
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：applicabilityMismatch 条件匹配/不匹配；
 *       confidenceOf 对 volatile(无常细节) 的降权；
 *       retrieveByType 对 volatile 记忆的排序微降。
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

function setApplicability(memId: string, conditions: string[], stability: 'stable' | 'volatile'): void {
  const row = db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(memId) as { context_json: string };
  const ctx = JSON.parse(row.context_json || '{}');
  ctx.applicability = { conditions, stability };
  db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), memId);
}

function getMem(memId: string): never {
  return db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(memId) as never;
}

function main(): void {
  console.log('\n===== 记忆缘起条件(applicability) 纯逻辑冒烟测试 =====\n');

  // [1] applicabilityMismatch 条件匹配/不匹配
  console.log('[1] 条件匹配判定');
  const mem1 = memory.storeText({ project_id: 'p1', content: '用方案 A 在 Windows 环境部署', type: 'procedural' });
  setApplicability(mem1, ['仅适用于 Windows 环境'], 'stable');
  assert('条件关键词不在任务文本 → mismatch=true', memory.applicabilityMismatch(getMem(mem1), '在 Linux 服务器上部署服务') === true);
  assert('条件关键词在任务文本 → mismatch=false', memory.applicabilityMismatch(getMem(mem1), '在 Windows 服务器上部署服务') === false);

  // [2] confidenceOf volatile 降权
  console.log('\n[2] 无常(volatile) 可信度降权');
  const stableId = memory.storeText({ project_id: 'p1', content: '技术栈选型：主服务用 ElysiaJS', type: 'semantic' });
  const volatileId = memory.storeText({ project_id: 'p1', content: '当前临时端口号 3001', type: 'semantic' });
  setApplicability(stableId, [], 'stable');
  setApplicability(volatileId, [], 'volatile');
  // 使两条记忆的基础分一致（同 use_count/success_count），仅 stability 不同
  const confStable = memory.confidenceOf(getMem(stableId));
  const confVolatile = memory.confidenceOf(getMem(volatileId));
  assert('volatile 记忆 confidence 低于 stable', confVolatile < confStable, `stable=${confStable.toFixed(3)} volatile=${confVolatile.toFixed(3)}`);

  // [3] retrieveByType 对 volatile 排序微降
  console.log('\n[3] 检索排序：volatile 靠后');
  const aId = memory.storeText({ project_id: 'p2', content: '恒常规律：代码需先 read 后 edit', type: 'procedural' });
  const bId = memory.storeText({ project_id: 'p2', content: '无常细节：临时用端口 3018', type: 'procedural' });
  setApplicability(aId, [], 'stable');
  setApplicability(bId, [], 'volatile');
  db.prepare('UPDATE wa_memories SET importance = 0.7, success_count = 3, use_count = 3, last_used_at = datetime(\'now\') WHERE id IN (?, ?)').run(aId, bId);
  const ranked = memory.retrieveByType('procedural', 'p2', 10);
  const idxA = ranked.findIndex(r => r.id === aId);
  const idxB = ranked.findIndex(r => r.id === bId);
  assert('volatile 记忆排在同分 stable 记忆之后', idxA >= 0 && idxB >= 0 && idxA < idxB, `stable@${idxA} volatile@${idxB}`);

  // [4] 条件不匹配 → 排序降权（空性·缘起：适用条件与任务不符则 ×0.6）
  console.log('\n[4] 条件不匹配 → 排序降权');
  const condId = memory.storeText({ project_id: 'p3', content: '用方案 X 在 Windows 环境部署', type: 'semantic' });
  const plainId = memory.storeText({ project_id: 'p3', content: '通用部署步骤', type: 'semantic' });
  setApplicability(condId, ['仅适用于 Windows 环境'], 'stable'); // plain 无 applicability
  db.prepare('UPDATE wa_memories SET importance = 0.7, success_count = 3, use_count = 3, last_used_at = datetime(\'now\') WHERE id IN (?, ?)').run(condId, plainId);
  const ranked2 = memory.retrieveByType('semantic', 'p3', 10, null, '在 Linux 服务器上部署服务');
  const idxCond = ranked2.findIndex(r => r.id === condId);
  const idxPlain = ranked2.findIndex(r => r.id === plainId);
  assert('条件不匹配的记忆排到无条件记忆之后', idxCond >= 0 && idxPlain >= 0 && idxPlain < idxCond, `plain@${idxPlain} cond@${idxCond}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
