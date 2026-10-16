/**
 * Phase B(记忆行动转化/知行合一) 纯逻辑冒烟测试（PLAN_20260827_zx_1.md）。
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：_recordApplication 的知行合一增量强化——
 *       被应用且成功 → importance +0.03 + applied.count+1；
 *       被检索未应用且成功 → importance -0.03（知而不行只是未知）；
 *       被应用但失败 → 不额外强化（走既有 staleness 机制）。
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
// 冒烟测试直接访问私有方法 _recordApplication（运行时 JS 无 private 限制），验证知行合一增量强化核心逻辑
const recordApplication = (memory as unknown as { _recordApplication: (id: string, applied: boolean, success: boolean) => void })._recordApplication.bind(memory);

function importanceOf(id: string): number {
  return (db.prepare('SELECT importance FROM wa_memories WHERE id = ?').get(id) as { importance: number }).importance;
}
function appliedCount(id: string): number {
  const row = db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(id) as { context_json: string };
  try { return ((JSON.parse(row.context_json || '{}')).applied as { count?: number })?.count ?? 0; } catch { return 0; }
}

function main(): void {
  console.log('\n===== 记忆行动转化(知行合一) 纯逻辑冒烟测试 =====\n');

  console.log('[1] 被应用且成功 → importance +0.03 + applied.count+1');
  const aId = memory.storeText({ project_id: 'p1', content: '用方案 A 部署', type: 'procedural' });
  db.prepare('UPDATE wa_memories SET importance = 0.5 WHERE id = ?').run(aId);
  const aBefore = importanceOf(aId);
  recordApplication(aId, true, true);
  assert('importance +0.03', Math.abs(importanceOf(aId) - (aBefore + 0.03)) < 0.001, `${aBefore} → ${importanceOf(aId)}`);
  assert('applied.count 0→1', appliedCount(aId) === 1, `count=${appliedCount(aId)}`);

  console.log('\n[2] 被检索未应用且成功 → 抵消基础强化并额外降权（知而不行只是未知）');
  const bId = memory.storeText({ project_id: 'p1', content: '端口号 3018', type: 'semantic' });
  db.prepare('UPDATE wa_memories SET importance = 0.5 WHERE id = ?').run(bId);
  const bBefore = importanceOf(bId);
  recordApplication(bId, false, true); // 默认 reinforceDelta=0.07 → 降权 0.07+0.03=0.10（抵消基础强化，净 -0.03）
  assert('importance 降权 0.10（抵消基础强化0.07+额外0.03）', Math.abs(importanceOf(bId) - (bBefore - 0.10)) < 0.001, `${bBefore} → ${importanceOf(bId)}`);
  assert('applied.count 保持 0', appliedCount(bId) === 0, `count=${appliedCount(bId)}`);

  console.log('\n[3] 被应用但失败 → applied.count+1 但不额外强化（走既有 staleness）');
  const cId = memory.storeText({ project_id: 'p1', content: '临时方案 B', type: 'procedural' });
  db.prepare('UPDATE wa_memories SET importance = 0.5 WHERE id = ?').run(cId);
  const cBefore = importanceOf(cId);
  recordApplication(cId, true, false);
  assert('importance 不变', Math.abs(importanceOf(cId) - cBefore) < 0.001, `${cBefore} → ${importanceOf(cId)}`);
  assert('applied.count 0→1', appliedCount(cId) === 1, `count=${appliedCount(cId)}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
