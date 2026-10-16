/**
 * Phase B(任务立志) 分支逻辑冒烟测试（PLAN_20260827_zx_2.md）。
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：identifyTaskGoal 的复杂度分支——simple 任务跳过 LLM（零成本）；
 *       complex/standard 任务触发 LLM 识别。
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

let llmCalls = 0;
const ansClient = { getOptimalModel: async () => { llmCalls++; return null; } } as unknown as import('@worker-ant/ans-client').AnsClient;
const memory = new MemoryManager(db, ansClient);

async function main(): Promise<void> {
  console.log('\n===== 任务立志(identifyTaskGoal) 分支冒烟测试 =====\n');

  console.log('[1] simple 任务跳过 LLM（零成本）');
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description) VALUES ('t-simple', 'p1', '你好', '')").run();
  const callsBefore = llmCalls;
  const simpleResult = await memory.identifyTaskGoal('t-simple', 'p1');
  assert('simple 任务返回 null', simpleResult === null, `result=${JSON.stringify(simpleResult)}`);
  assert('simple 任务未触发 LLM', llmCalls === callsBefore, `llmCalls 增量=${llmCalls - callsBefore}`);

  console.log('\n[2] complex 任务触发 LLM 识别');
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description) VALUES ('t-complex', 'p1', '重构认证模块', '重构整个认证模块，涉及多服务协调、数据迁移与回归测试，需要保证向后兼容并处理并发写入的一致性问题')").run();
  const callsBefore2 = llmCalls;
  const complexResult = await memory.identifyTaskGoal('t-complex', 'p1');
  assert('complex 任务触发了 LLM', llmCalls > callsBefore2, `llmCalls 增量=${llmCalls - callsBefore2}`);
  assert('LLM 不可用时返回 null（不抛异常）', complexResult === null, `result=${JSON.stringify(complexResult)}`);

  console.log('\n[3] 已有 task_goal 复用（C3 落地生效回归：不覆盖用户纠正）');
  db.prepare("UPDATE wa_tasks SET context_json = ? WHERE id = 't-complex'").run(JSON.stringify({ task_goal: { goal: '完成认证模块重构并通过回归测试', success_criteria: '回归通过', investigate: [] } }));
  const callsBefore3 = llmCalls;
  const reusedResult = await memory.identifyTaskGoal('t-complex', 'p1');
  assert('复用已有 task_goal（不再触发 LLM）', llmCalls === callsBefore3, `llmCalls 增量=${llmCalls - callsBefore3}`);
  assert('返回用户纠正的目标', reusedResult?.goal === '完成认证模块重构并通过回归测试', `result=${JSON.stringify(reusedResult)}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
