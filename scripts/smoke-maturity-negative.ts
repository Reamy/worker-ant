/**
 * Phase A(知识成熟度) + Phase B(负空间记忆) 端到端冒烟测试（PLAN_20260826_zx_1.md）。
 *
 * 用法（同 smoke-phase-a，tsx 不可用时用 tsup 打包）：
 *   npx tsup scripts/smoke-maturity-negative.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai \
 *     --external pino --external pino-pretty --external pino-roll \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-maturity-negative.mjs
 *
 * 覆盖：
 *   A 成熟度：maturityOf 对「验证次数×龄期」给出正确分级（稚嫩<0.25 暂定 / 成熟>=0.6）
 *   B 负空间：storeNegative → listNegatives → retrieveNegativeHits 命中/不命中链路
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
`);

const ansClient = { getOptimalModel: async () => null } as unknown as import('@worker-ant/ans-client').AnsClient;
const memory = new MemoryManager(db, ansClient);

function main(): void {
  console.log('\n===== 知识成熟度 + 负空间记忆 冒烟测试 =====\n');

  // ===== Phase A 成熟度 =====
  console.log('[1] maturityOf 验证深度×龄期');
  // 稚嫩：success=3 但 1 小时前创建
  db.prepare(
    "INSERT INTO wa_memories (id, project_id, content, memory_type, success_count, created_at) VALUES ('young', 'p1', '年轻知识', 'semantic', 3, datetime('now', '-1 hour'))",
  ).run();
  // 成熟：success=10 且 90 天前创建
  db.prepare(
    "INSERT INTO wa_memories (id, project_id, content, memory_type, success_count, created_at) VALUES ('mature', 'p1', '成熟知识', 'semantic', 10, datetime('now', '-90 days'))",
  ).run();

  const young = db.prepare("SELECT * FROM wa_memories WHERE id = 'young'").get() as Record<string, unknown>;
  const mature = db.prepare("SELECT * FROM wa_memories WHERE id = 'mature'").get() as Record<string, unknown>;
  const youngMat = memory.maturityOf(young as never);
  const matureMat = memory.maturityOf(mature as never);
  console.log(`    young maturity=${youngMat.toFixed(3)}  mature maturity=${matureMat.toFixed(3)}`);
  assert('稚嫩记忆 maturity < 0.25（暂定）', youngMat < 0.25, `实际=${youngMat.toFixed(3)}`);
  assert('成熟记忆 maturity >= 0.6（成熟）', matureMat >= 0.6, `实际=${matureMat.toFixed(3)}`);
  assert('稚嫩 < 成熟', youngMat < matureMat);

  console.log('\n[2] confidenceOf 融入成熟度（同 success_count 仅龄期不同 → 可信度差）');
  // 两条 success=4 但龄期不同，隔离成熟度对 confidenceOf 的净影响。
  // D1 (2026-08-31) 遗忘曲线基准 = max(last_used_at, last_reinforced_at)，未使用/未强化的旧记忆按遗忘衰减；
  // 故成熟记忆需「近期被强化/维护」（last_reinforced_at 近）才能体现「成熟提升可信度」的本意——否则 90 天未被使用的旧记忆
  // 被正确遗忘（这是 D1 引入的正确行为，非缺陷）。
  db.prepare(
    "INSERT INTO wa_memories (id, project_id, content, memory_type, success_count, created_at) VALUES ('c_young', 'p1', 'c', 'semantic', 4, datetime('now', '-1 hour'))",
  ).run();
  db.prepare(
    "INSERT INTO wa_memories (id, project_id, content, memory_type, success_count, created_at, last_reinforced_at) VALUES ('c_mature', 'p1', 'c', 'semantic', 4, datetime('now', '-90 days'), datetime('now', '-1 day'))",
  ).run();
  const cy = db.prepare("SELECT * FROM wa_memories WHERE id = 'c_young'").get() as Record<string, unknown>;
  const cm = db.prepare("SELECT * FROM wa_memories WHERE id = 'c_mature'").get() as Record<string, unknown>;
  const confY = memory.confidenceOf(cy as never);
  const confM = memory.confidenceOf(cm as never);
  console.log(`    confidenceOf young=${confY.toFixed(3)}  mature=${confM.toFixed(3)}`);
  assert('成熟记忆可信度 > 稚嫩记忆', confM > confY, `young=${confY.toFixed(3)} mature=${confM.toFixed(3)}`);

  // ===== Phase B 负空间 =====
  console.log('\n[3] storeNegative → listNegatives → retrieveNegativeHits');
  const nid = memory.storeNegative('p1', 't1', '用 Docker Swarm 部署会导致回滚失败', 'tried_failed');
  assert('storeNegative 返回 id', !!nid, nid);
  const negatives = memory.listNegatives('p1');
  assert('listNegatives 返回 1 条', negatives.length === 1, `实际=${negatives.length}`);
  assert('负空间类型为 negative', negatives[0]!.memory_type === 'negative', negatives[0]!.memory_type);

  const hits = memory.retrieveNegativeHits('现在要执行 Docker Swarm 部署任务', 'p1');
  assert('命中相关任务 → 返回负空间', hits.length >= 1, `实际=${hits.length}`);
  const miss = memory.retrieveNegativeHits('现在做一个完全无关的文档整理', 'p1');
  assert('无关任务 → 不误命中', miss.length === 0, `实际=${miss.length}`);

  console.log('\n[4] 纯中文无分隔符场景（中文 bigram 回退）');
  const nid2 = memory.storeNegative('p1', 't2', '用蓝绿部署方案会导致回滚失败', 'avoid');
  assert('storeNegative(纯中文) 返回 id', !!nid2, nid2);
  const hits2 = memory.retrieveNegativeHits('现在要执行蓝绿部署任务', 'p1');
  assert('纯中文任务 → bigram 回退命中负空间', hits2.length >= 1, `实际=${hits2.length}`);
  const miss2 = memory.retrieveNegativeHits('现在整理项目文档', 'p1');
  assert('纯中文无关任务 → 不误命中', miss2.length === 0, `实际=${miss2.length}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
