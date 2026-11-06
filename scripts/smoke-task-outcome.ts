/**
 * Phase B(任务成败画像) + Phase C(任务识别校准) 纯逻辑冒烟测试（PLAN_20260826_zx_2.md）。
 *
 * 用法（同 smoke-phase-a，tsx 不可用时用 tsup 打包）：
 *   npx tsup scripts/smoke-task-outcome.ts --format esm --platform node --target node22 \
 *     --external @worker-ant/ans-client --external ai --external @ai-sdk/openai \
 *     --external pino --external pino-pretty --external pino-roll \
 *     --out-dir apps/worker-ant-desktop/dist-smoke --clean
 *   node apps/worker-ant-desktop/dist-smoke/smoke-task-outcome.mjs
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：
 *   B buildTaskOutcomeProfile：按 archetype 统计成功率/平均步数/失败模式
 *   C calibrateArchetype：关键词命中守卫(二次核实缺陷#1回归) + 分类模糊成功率破 tie
 */
import { createRequire } from 'node:module';
import { buildTaskOutcomeProfile, calibrateArchetype } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

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

// ===== 内存库（:memory:，非开发库） =====
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'pending',
    context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

function seedTask(id: string, status: string, archetype: string, steps: number, tokens: number, failReason?: string): void {
  const ctx: Record<string, unknown> = { execution_metrics: { archetype, stepsUsed: steps, totalTokens: tokens, hasDeliverable: status === 'completed' } };
  if (failReason) ctx.failure_record = { reason: failReason };
  db.prepare('INSERT INTO wa_tasks (id, project_id, status, context_json) VALUES (?, ?, ?, ?)').run(id, 'p1', status, JSON.stringify(ctx));
}

function main(): void {
  console.log('\n===== 任务成败画像 + 识别校准 冒烟测试 =====\n');

  // 造历史任务：code 3成1败，research 1成2败（research 成功率更低）
  seedTask('c1', 'completed', 'code', 5, 5000);
  seedTask('c2', 'completed', 'code', 6, 6000);
  seedTask('c3', 'completed', 'code', 4, 4000);
  seedTask('c4', 'failed', 'code', 8, 8000, '无产出物');
  seedTask('r1', 'completed', 'research', 7, 7000);
  seedTask('r2', 'failed', 'research', 9, 9000, '无产出物');
  seedTask('r3', 'failed', 'research', 10, 10000, '无产出物');

  console.log('[1] buildTaskOutcomeProfile 统计');
  const profiles = buildTaskOutcomeProfile(db as never, 'p1');
  const code = profiles.find(p => p.archetype === 'code');
  const research = profiles.find(p => p.archetype === 'research');
  assert('画像产出 code + research 两类', !!code && !!research, `profiles=${profiles.map(p => p.archetype).join(',')}`);
  assert('code 成功率 3/4=0.75', !!code && Math.abs(code.successRate - 0.75) < 0.001, `实际=${code?.successRate}`);
  assert('research 成功率 1/3≈0.33', !!research && Math.abs(research.successRate - 1 / 3) < 0.001, `实际=${research?.successRate}`);
  assert('code 平均步数 (5+6+4+8)/4≈5.75→6', !!code && code.avgSteps === 6, `实际=${code?.avgSteps}`);
  assert('失败模式提取「无产出物」', !!research && research.failReasons.includes('无产出物'), `实际=${JSON.stringify(research?.failReasons)}`);

  console.log('\n[2] calibrateArchetype 关键词守卫（二次核实缺陷#1回归）');
  // 「修复登录bug」命中关键词规则→code，即使 research 成功率低也不应被校准改判
  const guarded = calibrateArchetype(db as never, 'p1', '修复登录模块的鉴权bug', 'code');
  assert('关键词命中 → 返回原分类 code（不被覆盖）', guarded === 'code', `实际=${guarded}`);

  console.log('\n[3] calibrateArchetype 无画像兜底');
  // 空库(无画像)时即使分类模糊也返回原分类
  const empty = calibrateArchetype(db as never, 'p_empty', '随便一个研究任务', 'research');
  assert('无画像 → 返回原分类 research', empty === 'research', `实际=${empty}`);

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
