/**
 * Phase B(记忆事实保鲜) staleness 生命周期冒烟测试。
 *
 * 用法（tsx 不在 PATH，用仓内那份；或先用 tsup 打包）：
 *   apps/worker-ant-desktop/node_modules/.bin/tsx scripts/smoke-staleness.ts
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库。
 *
 * zx_20260930 M6（夏克特·错误归因）重写口径 —— 旧版钉的是**已被判为病根的行为**
 *   （「失败 ⟹ 凡注入过的记忆全打 staleness」），那正是"一次基础设施故障连坐十几条无关记忆"。
 * 新口径：**只有本次 run 真入文（`context_json.memory_used_ids_run`）且与失败可指认关联**
 *   （`failureAnchors` / `isAttributable`：失败自己留下的字据里取得到硬锚点）的记忆才降权/打 stale；
 *   指认不了 ⇒ **只记 `failure_count`**，importance / `last_reinforced_at` / staleness **分文不动**；
 *   老任务（读不到 per-run 键）⇒ 同样只记计数。
 *
 * 覆盖（**两侧都给标本**，不是只证"该标的自标了"）：
 *   [1] 失败 + 可指认 ⇒ staleness 标记、降权、计数 0→1
 *   [2] 失败 + **不可指认** ⇒ 无 staleness、importance 不变、`last_reinforced_at` 仍为 NULL、计数 0→1
 *   [3] 老任务（无 per-run 键）⇒ 只记计数（不奖不罚）——"宁可少标，不可乱标"
 *   [4] 本次 run 真入文为空集 ⇒ **连计数都不动**（"空集"与"不知道"刻意区别）
 *   [5] 成功 + 可指认 ⇒ 清除 staleness、confidence 回升（既有保鲜闭环不被 M6 破坏）
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
// ⚠ 先 `new` 服务类（构造里建 FTS 同步触发器）**再**插记忆行——顺序颠倒则断言假绿（feedback_rr_fixture_production_order）
const memory = new MemoryManager(db, ansClient);

interface Snap { stale: boolean; imp: number; fail: number; succ: number; reinf: string | null }
const snap = (memId: string): Snap => {
  const row = db.prepare('SELECT importance, context_json, failure_count, success_count, last_reinforced_at FROM wa_memories WHERE id = ?').get(memId) as
    { importance: number; context_json: string; failure_count: number; success_count: number; last_reinforced_at: string | null };
  let stale = false;
  try { stale = !!(JSON.parse(row.context_json || '{}')).staleness; } catch { /* 非法 context_json ⇒ 视为未标 */ }
  return { stale, imp: row.importance, fail: row.failure_count, succ: row.success_count, reinf: row.last_reinforced_at };
};
const conf = (memId: string): number => memory.confidenceOf(db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(memId) as never);
const newTask = (id: string, title: string, ctx: Record<string, unknown>, status = 'failed'): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)')
    .run(id, 'p1', title, status, JSON.stringify(ctx));
};

function main(): void {
  console.log('\n===== 记忆事实保鲜(staleness) 生命周期冒烟测试 —— zx_20260930 M6 口径 =====\n');

  // 甲：正文含失败字据里的硬锚点（"端口 8080"）⇒ 可指认
  const memHit = memory.storeText({ project_id: 'p1', content: '用方案 A 部署到生产环境前，先确认端口 8080 未被占用', type: 'procedural' });
  // 乙：正文与失败字据**无任何词面重叠** ⇒ 指认不了
  const memMiss = memory.storeText({ project_id: 'p1', content: '代码评审时优先看函数是否单一职责', type: 'procedural' });

  const hitBefore = snap(memHit);
  const missBefore = snap(memMiss);
  const confHitBefore = conf(memHit);

  console.log('[1]/[2] 失败一次 —— 同一次 run 两条都真入文，字据只指认得甲');
  newTask('t1', '部署任务', {
    memory_used_ids_run: [memHit, memMiss],
    // 锚点**只从失败自己留下的字据里取**：tools[] + reason 实词 + 标题实词
    failure_record: { reason: '端口 8080 被占用', stepsUsed: 4, toolCount: 2, tools: ['deploy'] },
  });
  const touched1 = memory.reinforceMemories('t1', 'p1', false);
  const hitAfter = snap(memHit);
  const missAfter = snap(memMiss);

  assert('①② 两条都真入文 ⇒ 都被处理（返回值 2，正面断言非"不抛"）', touched1 === 2, `touched=${touched1}`);
  assert('[1] 甲与字据可指认 ⇒ staleness **已标记**', hitAfter.stale === true);
  assert('[1] 甲被降权（importance 下降）', hitAfter.imp < hitBefore.imp, `${hitBefore.imp} → ${hitAfter.imp}`);
  assert('[1] 甲 `failure_count` 0→1', hitAfter.fail === 1, `${hitBefore.fail} → ${hitAfter.fail}`);
  assert('[1] 甲 `last_reinforced_at` 被写（实践反馈真的落到这条上）', !!hitAfter.reinf);
  assert('[2] 乙**指认不了** ⇒ staleness **未标记**（错误归因的另一侧）', missAfter.stale === false);
  assert('[2] 乙 importance **分文不动**（指认不了就不降权）', missAfter.imp === missBefore.imp, `${missBefore.imp} → ${missAfter.imp}`);
  assert('[2] 乙 `last_reinforced_at` **仍为 NULL**（没动它）', missAfter.reinf === null, String(missAfter.reinf));
  assert('[2] 乙 `failure_count` 仍 0→1（"只记计数"照记，不是什么都不做）', missAfter.fail === 1, `${missBefore.fail} → ${missAfter.fail}`);
  assert('★ 甲 confidence 下降（staleness ⇒ ×0.7，见 confidenceOf）', conf(memHit) < confHitBefore, `${confHitBefore.toFixed(3)} → ${conf(memHit).toFixed(3)}`);

  console.log('\n[3] 老任务（无 per-run 键，只有跨 run 的 union）⇒ 只记计数，不奖不罚');
  const memLegacy = memory.storeText({ project_id: 'p1', content: '历史遗留记忆：与本次失败毫无关系的一段知识', type: 'semantic' });
  const legacyBefore = snap(memLegacy);
  newTask('t2', '旧任务', { injected_memory_ids: [memLegacy] }); // ← 没有 memory_used_ids_run（M6 之前的存量形状）
  const touched2 = memory.reinforceMemories('t2', 'p1', false);
  const legacyAfter = snap(memLegacy);
  assert('[3] 老任务仍被处理（返回 1）', touched2 === 1, `touched=${touched2}`);
  assert('[3] staleness 未标记（"不知道用过什么"⇒不乱标）', legacyAfter.stale === false);
  assert('[3] importance 不变、`last_reinforced_at` 仍 NULL', legacyAfter.imp === legacyBefore.imp && legacyAfter.reinf === null);
  assert('[3] `failure_count` 仍 0→1（计数照记）', legacyAfter.fail === 1, `${legacyBefore.fail} → ${legacyAfter.fail}`);

  console.log('\n[4] 本次 run 真入文为**空集** ⇒ 连计数都不动（"空集"≠"不知道"）');
  const memUnused = memory.storeText({ project_id: 'p1', content: '本次一条都没用上的记忆', type: 'semantic' });
  const unusedBefore = snap(memUnused);
  newTask('t3', '未用任务', { memory_used_ids_run: [], injected_memory_ids: [memUnused] });
  const touched3 = memory.reinforceMemories('t3', 'p1', false);
  const unusedAfter = snap(memUnused);
  assert('[4] 返回 0（本次一条没用上 ⇒ 谁都不碰）', touched3 === 0, `touched=${touched3}`);
  assert('[4] 计数亦不动：`failure_count` 仍 0、无 staleness', unusedAfter.fail === unusedBefore.fail && unusedAfter.fail === 0 && unusedAfter.stale === false);

  console.log('\n[5] 成功 + 可指认 ⇒ 清除 staleness、confidence 回升（既有保鲜闭环）');
  const confHitFailed = conf(memHit);
  newTask('t4', '复验任务', { memory_used_ids_run: [memHit] }, 'completed');
  const touched4 = memory.reinforceMemories('t4', 'p1', true);
  const hitSuccess = snap(memHit);
  assert('[5] 成功被处理（返回 1）', touched4 === 1, `touched=${touched4}`);
  assert('[5] staleness **已清除**（实践重新验证）', hitSuccess.stale === false);
  assert('[5] `success_count` 0→1', hitSuccess.succ === 1, `→ ${hitSuccess.succ}`);
  assert('[5] confidence 回升（> 失败时）', conf(memHit) > confHitFailed, `fail=${confHitFailed.toFixed(3)} success=${conf(memHit).toFixed(3)}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
