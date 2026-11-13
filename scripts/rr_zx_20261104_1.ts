/**
 * zx_20261104_1「凭」受控回归 —— 完成要有凭据，不是自说自话。
 *
 * 本套件随里程碑分批加段；M1（G1 + G8）先落 `goal_achieved` 的凭据链：
 *   A 凭据四态：`goalEvidenceOf` 对「有题全过 / 有题未过 / 无题 / 无账 / 未判成 / 0/0」各归其位。
 *   B 五参判据：`goalAchievedOf` 两侧标本（验收通过/未通过/仅分数/被迫收尾/无目标），以及偏离上限仍优先。
 *   C 账的唯一构造器：`buildCompletionAccount` 必带 `goal_evidence`，`premature` 只在为真时出现；
 *     存量三参**运行时**调用按 `score_only` 归一（不让 `undefined` 被 JSON 序列化吞掉）。
 *   D 终态载荷：`buildTaskOutcome` 从**落库账**带出 `goal_evidence`/`premature`（不读内存、不编）；
 *     `countNewDeliverablesSince` 只认本 run 起始时刻之后的行（历史交付物不替空转背书）。
 *   E 接线形状：六个构造点全带 `evidence:`；exec-close 的「重算 → prematureEnd → 账 → 两条出口」
 *     次序；本 run 起始时刻与无产出出口；exec-finalize 的被迫收尾注记只在标完成之后写。
 *   I 探索配额按总步数派生（M4）：比例表一处真源、派生文案带本次值、A7 预留按上限派生。
 *   J 恢复选型（M5）：首选命中 / 备用提升（名钥价一起搬）/ 不在池中回落 / 首跑零留痕 / 只在恢复路接线。
 *   K 费用闸三态（M6）：active / no_cap / no_price 一处落库，任务详情与模型管理同源上屏。
 *   L 快照审计（M7）：截断给覆盖率 N/M，收口第二通道列本任务写入清单并与改写计数对账。
 *   M 收口上屏（M8）：达成凭据四态 + 被迫收尾标记，只读、与引擎账同源。
 *   N 暂停（M9）：续额自动续跑只认"引擎因撞顶而停"；人一接管即作废该承诺（续额本身仍有效）。
 *   H 构建钉与套件自检（无前向字面量、无失败字形、收尾行如实印数）。
 *
 * 纪律：零网络 / 零 electron；夹具自建 DDL；计数器带 0→1 正面断言；不以真实墙钟为判据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  goalEvidenceOf,
  acceptanceVerdictOf,
  type GoalEvidence,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import {
  goalAchievedOf,
  buildCompletionAccount,
  buildTaskOutcome,
  countNewDeliverablesSince,
  type TaskOutcomeDb,
} from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';
import { completionCapFloors } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { classifyArchetypeDetailed, OBSERVABLE_DEFECT_RE } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { resolveExplorationQuota, shouldAutoResumeOnStepCap, STEP_CAP_GRANT_LIMIT } from '../apps/worker-ant-desktop/src/main/core/step-budget.js';
import { settlePause, resumeWithQuota } from '../apps/worker-ant-desktop/src/main/core/pause-settlement.js';
import {
  PAUSE_REASON_QUALITY_BELOW_BAR,
  PAUSE_REASON_USER_INTERRUPT,
  PAUSE_REASON_AWAITING_INPUT,
  PAUSE_REASON_CHILDREN_INCOMPLETE,
  PAUSE_REASON_POLICY_PAUSED,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { deriveShellExploreQuota, SHELL_EXPLORE_QUOTA, SHELL_EXPLORE_QUOTA_KEY } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { selectModelForTask } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
import { costGateReasonOf } from '../apps/worker-ant-desktop/src/main/core/exec-budget.js';
import {
  describeSnapshotCoverage,
  compareSnapshots,
  auditWorldConsistency,
  TRUNCATION_ISSUE_PREFIX,
} from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import { ROUND_RE, checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const MAIN = `${A}/src/main/core`;
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function readCode(rel: string): string {
  return stripKeepingLines(readText(rel)).join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// A 凭据四态
// ══════════════════════════════════════════════════════════════════════

function sectionA(): void {
  console.log('\n【A】M1：达成凭据四态（goalEvidenceOf）');
  eq(goalEvidenceOf(undefined), 'none', 'A-1 无账 ⇒ none（"没这笔账"不是"按分数推断"）');
  eq(goalEvidenceOf(null), 'none', 'A-2 null ⇒ none');

  const passed = goalEvidenceOf({ checked_at: '2026-11-04 01:00:00', verified: true, criteria_total: 2, passed_total: 2 });
  eq(passed, 'acceptance_passed', 'A-3 有题且全过 ⇒ acceptance_passed（唯一可直接背书的凭据）');

  const failed = goalEvidenceOf({ checked_at: '2026-11-04 01:00:00', verified: true, criteria_total: 2, passed_total: 1 });
  eq(failed, 'acceptance_failed', 'A-4 有题但未全过 ⇒ acceptance_failed（明确反证）');

  const unjudged = goalEvidenceOf({ checked_at: '2026-11-04 01:00:00', verified: false, reason: 'error' });
  eq(unjudged, 'score_only', 'A-5 有题未判成 ⇒ score_only（没判成不等于判过了，也不凭空判未过）');

  const noCriteria = goalEvidenceOf({ checked_at: '2026-11-04 01:00:00', verified: true, criteria_total: 0, passed_total: 0, reason: 'no_criteria' });
  eq(noCriteria, 'score_only', 'A-6 verified 且 0/0 ⇒ score_only（没有题目就没有凭据，空数组全过不算验收达成）');

  eq(goalEvidenceOf({ verified: true, criteria_total: 2, passed_total: 2 }), 'none',
    'A-7 缺 checked_at ⇒ none（没落账时刻的记录不是一笔账）');

  eq(goalEvidenceOf({ checked_at: '2026-11-04 01:00:00', criteria_total: 3, passed_total: 3 }), 'acceptance_passed',
    'A-8 存量无 verified 字段 ⇒ 按已验证读（老数据只有真通过才落库），3/3 仍是 acceptance_passed');

  // 与既有一处真源对齐：四态不得与验收三态互相打脸
  eq([acceptanceVerdictOf({ checked_at: 'x', verified: true, criteria_total: 2, passed_total: 2 }), passed],
    ['passed', 'acceptance_passed'], 'A-9 全过：验收判 passed，凭据判 acceptance_passed（同源同义）');
  eq([acceptanceVerdictOf({ checked_at: 'x', verified: true, criteria_total: 2, passed_total: 1 }), failed],
    ['failed', 'acceptance_failed'], 'A-10 未全过：验收判 failed，凭据判 acceptance_failed');
}

// ══════════════════════════════════════════════════════════════════════
// B 五参判据两侧标本
// ══════════════════════════════════════════════════════════════════════

function sectionB(): void {
  console.log('\n【B】M1：达成判据五参（goalAchievedOf）两侧标本');
  eq(goalAchievedOf(false, 0, 40, 'acceptance_passed' as GoalEvidence, false), true,
    'B-1 验收全过 ⇒ 即便分数 40 也判达成（验收是唯一可背书的凭据）');
  eq(goalAchievedOf(false, 0, 95, 'acceptance_failed' as GoalEvidence, false), false,
    'B-2 验收未过 ⇒ 即便 95 分也不得宣告达成（G8 病根）');
  eq(goalAchievedOf(false, 0, 95, 'acceptance_passed' as GoalEvidence, true), false,
    'B-3 被迫收尾 ⇒ 即便验收全过也不宣告达成（触顶是被截停的，方案 §5.1）');
  eq(goalAchievedOf(false, 0, 60, 'score_only' as GoalEvidence, false), true,
    'B-4 仅按分数推断：60 ⇒ 达成（分数线一处真源）');
  eq(goalAchievedOf(false, 0, 59, 'score_only' as GoalEvidence, false), false,
    'B-5 仅按分数推断：59 ⇒ 未达成（反证，防"恒真"变体）');
  eq(goalAchievedOf(false, 0, 80, 'none' as GoalEvidence, false), true,
    'B-6 无账（none）⇒ 退到分数推断，80 ⇒ 达成（不因缺账一律判否）');
  eq(goalAchievedOf(true, 2, 90, 'score_only' as GoalEvidence, false), false,
    'B-7 有显式目标且偏离触上限 ⇒ 一律未达成（既有约束原样保留，先于分数）');
  eq(goalAchievedOf(true, 0, 90, 'score_only' as GoalEvidence, false), true,
    'B-8 有目标但偏离未触上限 ⇒ 90 分判达成（反证上限不是恒拦）');
}

// ══════════════════════════════════════════════════════════════════════
// C 账的唯一构造器
// ══════════════════════════════════════════════════════════════════════

function sectionC(): void {
  console.log('\n【C】M1：completion_quality 的唯一构造器');
  const passedAcct = buildCompletionAccount({
    score: 70, goalAchieved: true, via: 'run_close', feedback: 'ok', evidence: 'acceptance_passed', premature: false,
  });
  eq([passedAcct.score, passedAcct.goal_achieved, passedAcct.via, passedAcct.goal_evidence],
    [70, true, 'run_close', 'acceptance_passed'], 'C-1 构造器落笔四键同值（score 与 goal_achieved 同处一份账）');
  ok(!('premature' in passedAcct), 'C-2 未触顶 ⇒ 不写 premature 键（"没这笔账"不是"账上是 false"）');

  const forced = buildCompletionAccount({
    score: 90, goalAchieved: false, via: 'run_close', evidence: 'score_only', premature: true,
  });
  eq([forced.goal_achieved, forced.goal_evidence, forced.premature], [false, 'score_only', true],
    'C-3 触顶 ⇒ 一笔账里同时带 false / score_only / premature:true');

  const legacy = buildCompletionAccount({
    score: 66, goalAchieved: true, via: 'x',
  } as unknown as Parameters<typeof buildCompletionAccount>[0]);
  eq(legacy.goal_evidence, 'score_only',
    'C-4 存量三参运行时调用 ⇒ 凭据按 score_only 归一（不让 undefined 进 JSON 被序列化丢掉）');
  ok(!('premature' in legacy), 'C-5 存量调用不凭空长出 premature 键');
  ok(!('feedback' in passedAcct) === false, 'C-6 有 feedback 时照常落笔');
  ok(!('feedback' in buildCompletionAccount({ score: 60, goalAchieved: false, via: 'y', evidence: 'none' })),
    'C-7 空 feedback 不写键（"没这笔账"不是"账上是一句空话"）');
}

// ══════════════════════════════════════════════════════════════════════
// D 终态载荷与"本 run 新增交付物"
// ══════════════════════════════════════════════════════════════════════

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT);`);
  db.exec(`CREATE TABLE wa_deliverables (task_id TEXT, type TEXT, created_at TEXT);`);
  return db;
}
const asOutcomeDb = (db: DatabaseSync): TaskOutcomeDb => db as unknown as TaskOutcomeDb;

function sectionD(): void {
  console.log('\n【D】M1：终态载荷从落库账带出（buildTaskOutcome）');
  const db = mkDb();
  db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t1', JSON.stringify({
    completion_quality: {
      score: 90, via: 'run_close', goal_achieved: false,
      goal_evidence: 'acceptance_failed', premature: true,
    },
  }));
  const out = buildTaskOutcome(asOutcomeDb(db), 't1', 0);
  eq([out.quality?.score, out.quality?.goal_achieved, out.quality?.goal_evidence, out.quality?.premature],
    [90, false, 'acceptance_failed', true],
    'D-1 事件载荷带出落库账的 score / goal_achieved / goal_evidence / premature（不读内存、不重判）');
  eq(out.run_mutations, 0, 'D-2 写入类调用次数如实带 0（正面值，不是"没这笔账"）');

  db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t2', JSON.stringify({
    completion_quality: { score: 70, via: 'finalize_task', goal_achieved: true },
  }));
  const old = buildTaskOutcome(asOutcomeDb(db), 't2', undefined);
  eq([old.quality?.goal_evidence, old.quality?.premature], [undefined, undefined],
    'D-3 存量老账无新键 ⇒ 载荷也不凭空造（如实"没这笔账"）');
  ok(!('run_mutations' in old), 'D-4 调用方不传 runMutations ⇒ 载荷不带该键（"没这笔账"不是"账上是 0"）');

  db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t3', '{}');
  eq(buildTaskOutcome(asOutcomeDb(db), 't3').quality, null, 'D-5 无完成账 ⇒ quality 为 null（不编 0 分）');

  // 本 run 新增交付物：历史行不替空转背书（0→1 正面断言）
  const d2 = mkDb();
  d2.prepare('INSERT INTO wa_deliverables (task_id, type, created_at) VALUES (?, ?, ?)')
    .run('t4', 'doc', '2026-01-01T00:00:00.000Z');
  const sinceMs = Date.parse('2026-11-04T00:00:00.000Z');
  eq(countNewDeliverablesSince(asOutcomeDb(d2), 't4', sinceMs), 0,
    'D-6 仅有历史交付物 ⇒ 本 run 新增为 0（不替这一轮的空转背书）');
  d2.prepare('INSERT INTO wa_deliverables (task_id, type, created_at) VALUES (?, ?, ?)')
    .run('t4', 'doc', '2026-11-04T00:00:01.000Z');
  eq(countNewDeliverablesSince(asOutcomeDb(d2), 't4', sinceMs), 1,
    'D-7 本轮新增一条 ⇒ 计数 0 变 1（计数器正面断言）');
}

// ══════════════════════════════════════════════════════════════════════
// E 接线形状
// ══════════════════════════════════════════════════════════════════════

function sectionE(): void {
  console.log('\n【E】M1：六个构造点与 exec-close 新出口的接线形状');
  const files = [
    `${MAIN}/agent-executor.ts`,
    `${MAIN}/exec-close.ts`,
    `${MAIN}/tools/control-finalize.ts`,
    `${MAIN}/finalize-by-human.ts`,
    `${MAIN}/tools/control.ts`,
  ];
  const sources = files.map((f) => readCode(f));

  // 每个构造点：`completion_quality = buildCompletionAccount({ … })` 的参数表必带 evidence:
  const needles: string[] = [];
  for (const src of sources) {
    let from = 0;
    while (true) {
      const i = src.indexOf('completion_quality = buildCompletionAccount(', from);
      if (i < 0) break;
      const end = src.indexOf('});', i);
      needles.push(src.slice(i, end < 0 ? i + 500 : end + 3));
      from = i + 10;
    }
  }
  eq(needles.length, 6, `E-1 构造点恰 6 处（agent-executor 1 / exec-close 1 / control-finalize 1 / finalize-by-human 2 / control 1），实测 ${needles.length}`);
  // 实参键两种合法写法都算：`evidence: <expr>` 与 shorthand `evidence,`
  const hasEvidenceArg = (n: string): boolean => /^\s*evidence\s*[,:]/m.test(n);
  ok(needles.every(hasEvidenceArg), 'E-2 每一处构造点都把 evidence 作实参传入（凭据不是可选装饰）',
    needles.map((n, i) => `${i + 1}:${hasEvidenceArg(n)}`).join(' '));
  ok(needles.every((n) => n.includes('buildCompletionAccount({')), 'E-3 六处全是同一构造器（无第二份手拼对象）');

  const outcome = readCode(`${MAIN}/task-outcome.ts`);
  ok(/export function goalAchievedOf\([\s\S]*?premature: boolean,\s*\): boolean/.test(outcome),
    'E-4 判据签名含第五参 premature（被迫收尾不是分数维度）');
  ok(/export function goalEvidenceOf\(/.test(readCode(`${MAIN}/acceptance-check.ts`)),
    'E-5 goalEvidenceOf 在 acceptance-check 一处导出（凭据派生不散落）');

  // exec-close：重算 → prematureEnd → 账 → 两条出口；账要读 premature，故必须晚于 prematureEnd
  const close = readCode(`${MAIN}/exec-close.ts`);
  const iRecompute = close.indexOf('qualityScore = assessCompletionQuality(db, taskId, stepCount,');
  const iPri = close.indexOf('const prematureEnd =');
  const iAcct = close.indexOf('completion_quality = buildCompletionAccount(', iPri);
  const iExit1 = close.indexOf('if (prematureEnd &&', iPri);
  const iExit2 = close.indexOf('if (prematureEnd &&', iExit1 + 1);
  ok(iRecompute > 0 && iRecompute < iPri && iPri < iAcct && iAcct < iExit1 && iExit1 < iExit2,
    'E-6 收口序：完成分重算 → prematureEnd → 完成账 → 出口一（无产出）→ 出口二（低分）',
    `重算@${iRecompute} 早于@${iPri} 账@${iAcct} 出口1@${iExit1} 出口2@${iExit2}`);
  ok(close.slice(iExit1, iExit1 + 160).includes('!hasRunOutput'),
    'E-7 出口一判的是「被迫收尾且本轮无产出」（即便分数够也不放行）');
  ok(close.slice(iExit2, iExit2 + 160).includes('qualityScore.score < 60'),
    'E-8 出口二仍是既有「低分<60」闸（原样保留，不合并）');
  ok(close.includes('premature: prematureEnd') && close.includes('evidence: goalEvidenceNow'),
    'E-9 账上同杆带 premature 与 evidence（同一份账里两句话不打架）');
  ok(close.includes('countNewDeliverablesSince(db, taskId, runStartedAtMs)')
    && /const hasRunOutput = fileMutationCount > 0 \|\| runDeliverables > 0/.test(close)
    && close.includes("archetype === 'conversation' && finalContent.trim().length > 0"),
    'E-10 「本轮产出」三支齐备：文件改写 / 本轮新增交付物 / 对话非空回话');
  ok(close.includes('PAUSE_REASON_QUALITY_BELOW_BAR'), 'E-11 无产出出口落既有暂停因由（不新造枚举值）');
  ok(readText(`${MAIN}/exec-close.ts`).includes('[未达交付·被迫收尾]'),
    'E-12 暂停时如实写「未达交付·被迫收尾」（不把"分数够"写成"目标达成"）');
  ok(readText(`${MAIN}/exec-close.ts`).includes('[已完成·未经验收]'),
    'E-13 被迫收尾但有产出时如实写「已完成·未经验收」');
  ok(close.includes('runStartedAtMs: number;') && readCode(`${MAIN}/agent-executor.ts`).includes('runStartedAtMs'),
    'E-14 本 run 起始时刻一路传到收口段（接口声明 + 调用点同形）');
  ok(close.includes('prematureNote,'), 'E-15 被迫收尾的会话注记交给收口函数，在"真标完成"之后才写');

  // exec-finalize：注记必须排在标 completed 之后（早退口不写"完成"）
  const fin = readCode(`${MAIN}/exec-finalize.ts`);
  const iCompleted = fin.indexOf("UPDATE wa_tasks SET status = 'completed'");
  const iNote = fin.indexOf('if (prematureNote)');
  ok(iCompleted > 0 && iNote > iCompleted, 'E-16 注记只在真的标完成之后写（暂停出口不带"完成"字样）',
    `标完成@${iCompleted} 注记@${iNote}`);
  ok(fin.includes('prematureNote?: string'), 'E-17 入参可选：未触顶的收口零行为变化');

  // 五个文件都从同一处派生凭据
  ok(sources.every((s) => s.includes('goalEvidenceOf(')), 'E-18 五个构造点所在文件均引 goalEvidenceOf（无一处凭分数臆造）',
    files.map((f, i) => `${path.basename(f)}:${sources[i]!.includes('goalEvidenceOf(')}`).join(' '));
}

// ══════════════════════════════════════════════════════════════════════
// F M2 本轮无新增产出不得判好
// ══════════════════════════════════════════════════════════════════════

const F_SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', status TEXT DEFAULT 'executing');
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
  status TEXT DEFAULT 'draft', file_path TEXT);
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
`;

function sectionF(): void {
  console.log('\n【F】M2：本轮无新增产出不得判「好」（历史产出不替本轮背书）');

  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx1104-'));
  const artifactPath = path.join(wdir, 'report.md');
  fs.writeFileSync(artifactPath, 'x'.repeat(1200), 'utf-8');

  const mkdb = (taskId: string, archetype: string | undefined, withHistorical: boolean): DatabaseSync => {
    const db = new DatabaseSync(':memory:');
    db.exec(F_SCHEMA);
    const ctx = archetype ? JSON.stringify({ archetype }) : '{}';
    db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run(taskId, ctx);
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, 'assistant', ?)")
        .run(`${taskId}-c${i}`, taskId, `第 ${i + 1} 轮结论`);
    }
    if (withHistorical) {
      db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, status, file_path) VALUES (?, ?, 'doc', 'r', 'draft', ?)")
        .run(`${taskId}-d`, taskId, artifactPath);
    }
    return db;
  };
  const capsOf = (db: DatabaseSync, taskId: string, archetype: string | undefined, hasDeliv: boolean,
    runArtifacts?: { mutations: number; newDeliverables: number }) =>
    completionCapFloors(db as never, { taskId, workingDir: wdir, archetype, hasDeliverables: hasDeliv, runArtifacts });

  // F-1/F-2/F-3：同一份「有历史产出」的账，只看本 run 计数是否压降
  {
    const db = mkdb('hist', 'document', true);
    const capped = capsOf(db, 'hist', 'document', true, { mutations: 0, newDeliverables: 0 });
    eq(capped.cap, 45, 'F-1 有历史产出 + 本轮 0 改写 0 新登记 ⇒ cap=45（旧成果不替空转背书）');
    ok(capped.typeNote.includes('本轮无新增产出'), 'F-2 注记如实点名压降因由（不是无因压分）', capped.typeNote);

    const worked = capsOf(db, 'hist', 'document', true, { mutations: 1, newDeliverables: 0 });
    eq(worked.cap, 95, 'F-3 本轮有文件改写 ⇒ 不压降（反证：不是"凡传 runArtifacts 就压"）');
    ok(!worked.typeNote.includes('本轮无新增产出'), 'F-4 未压降时不带该注记');

    const legacy = capsOf(db, 'hist', 'document', true);
    eq(legacy.cap, 95, 'F-5 不传入 runArtifacts ⇒ 不解此判（其余完成出口行为零变）');

    const newDeliv = capsOf(db, 'hist', 'document', true, { mutations: 0, newDeliverables: 1 });
    eq(newDeliv.cap, 95, 'F-6 本轮新登记交付物 ⇒ 不压降（三支任一成立即算有产出）');
  }

  // F-7：conversation 原型豁免——对话本身就是交付物
  {
    const db = mkdb('conv', 'conversation', false);
    const caps = capsOf(db, 'conv', 'conversation', false, { mutations: 0, newDeliverables: 0 });
    eq(caps.cap, 95, 'F-7 conversation 原型本轮 0 文件改写 ⇒ 不按此条压降（对话即交付物）');
    ok(!caps.typeNote.includes('本轮无新增产出'), 'F-8 conversation 也不带该注记（豁免是不压，不是换句话压）');
  }

  // F-9：`0efa0c0e` 形状——2 步、0 交付、有旧对话 ⇒ 不得 ≥60（两因并列，注记都须在场）
  {
    const db = mkdb('spent', 'document', false);
    const caps = capsOf(db, 'spent', 'document', false, { mutations: 0, newDeliverables: 0 });
    eq(caps.cap, 45, 'F-9 0efa0c0e 形状（2 步 0 交付有旧对话）⇒ cap=45，不得 ≥60');
    ok(caps.typeNote.includes('本轮无新增产出') && caps.typeNote.includes('类无产出物'),
      'F-10 两因并列时注记都在场（新因不吞旧因）', caps.typeNote);
  }

  // F-11/F-12/F-13：接线——只有收口段带本 run 计数，且计数先于评分
  const ae = readCode(`${MAIN}/agent-executor.ts`);
  ok(/runArtifacts\?:\s*\{\s*mutations: number; newDeliverables: number\s*\}/.test(ae),
    'F-11 评分函数签名带可选 runArtifacts（不传则行为零变）');
  ok(/const caps = completionCapFloors\(db, \{ taskId, workingDir, archetype, hasDeliverables: delivs\.c > 0, runArtifacts \}\);/.test(ae),
    'F-12 评分函数把 runArtifacts 原样转给封顶真源（不在体内另判一遍）');
  const close = readCode(`${MAIN}/exec-close.ts`);
  const iCount = close.indexOf('countNewDeliverablesSince(db, taskId, runStartedAtMs)');
  const iScore = close.indexOf('qualityScore = assessCompletionQuality(db, taskId, stepCount,');
  ok(iCount > 0 && iScore > iCount && close.slice(iScore, iScore + 320).includes('{ mutations: fileMutationCount, newDeliverables: runDeliverables }'),
    'F-13 收口段先算本 run 新交付物再评分，并把改写数/新增数一并喂入',
    `计数@${iCount} 评分@${iScore}`);
  // 其余调用面（首评 / 人工标记完成 / GUI IPC）不传本 run 计数——它们不在 run 里，无此事实可传
  const otherCallers = [`${MAIN}/tools/control.ts`, `${A}/src/main/ipc/project.ipc.ts`].map((f) => readCode(f));
  const iFirstAssess = ae.indexOf('assessCompletionQuality(db, taskId, stepCount,');
  ok(close.includes('newDeliverables: runDeliverables')
    && !ae.slice(iFirstAssess, iFirstAssess + 320).includes('runArtifacts')
    && otherCallers.every((s) => !s.includes('newDeliverables')),
    'F-14 只有收口一处喂本 run 计数（首评与其余出口维持原判，不共享）',
    `首评@${iFirstAssess} / 其余调用面 ${otherCallers.map((s) => s.includes('newDeliverables')).join(',')}`);
  ok((ae.match(/本轮无新增产出/g)?.length ?? 0) === 1,
    'F-15 压降注记文案一处真源（不在第二处手抄）');
}

// ══════════════════════════════════════════════════════════════════════
// G M3 可观察缺陷 ⇒ code
// ══════════════════════════════════════════════════════════════════════

function sectionG(): void {
  console.log('\n【G】M3：可观察缺陷 ⇒ 修复（code）');

  const real = classifyArchetypeDetailed('编辑个人资料 出生日期/省市区显示为空');
  eq([real.archetype, real.source, real.reason], ['code', 'keyword', '可观察缺陷+界面/数据=修复'],
    'G-1 怡寿里原题 ⇒ code / keyword / 判据理由（修 bug 不是陪聊）');

  const doc = classifyArchetypeDetailed('生成页面需求文档');
  eq([doc.archetype, doc.reason], ['document', '明确文档生成意图'],
    'G-2 负标本「生成页面需求文档」原判不变（有产物词无缺陷词）');

  const perf = classifyArchetypeDetailed('分析首页加载性能');
  ok(perf.archetype !== 'code', 'G-3 负标本「分析首页加载性能」不被新规则吞（无缺陷词）', perf.archetype);

  const adv = classifyArchetypeDetailed('如何让列表不显示广告');
  eq(adv.archetype, 'conversation', 'G-4 负标本「如何…」是征询不是缺陷报障 ⇒ 不判 code');

  eq(classifyArchetypeDetailed('页面字段显示为空').archetype, 'code',
    'G-5 产物词在前、缺陷词在后也命中（任一顺序）');
  eq(classifyArchetypeDetailed('列表数据丢失').archetype, 'code', 'G-6 紧邻共现（产物词在前）同样命中');

  const far = classifyArchetypeDetailed('界面' + '啊'.repeat(25) + '报错');
  ok(far.archetype !== 'code', 'G-7 词距超过 24 字不命中（判据是共现窗口，不是全文各出现一次）', far.archetype);

  ok(OBSERVABLE_DEFECT_RE instanceof RegExp && OBSERVABLE_DEFECT_RE.test('数据不刷新'),
    'G-8 词表一处真源（导出的正则直用，测试不手抄第二份）');
}

// ══════════════════════════════════════════════════════════════════════
// I 探索配额按步数派生 + 末步比例预留（M4）
// ══════════════════════════════════════════════════════════════════════

function sectionI(): void {
  console.log('\n【I】M4：探索配额按总步数派生 / 末步预留按上限派生');

  eq(resolveExplorationQuota(18, 'analysis'), { soft: 5, hard: 9 },
    'I-1 病根标本：analysis@18 步（旧静态 12/20 比总步数还大）⇒ 派生 5/9，探路不再吃掉半个预算');
  eq(resolveExplorationQuota(40, 'code'), { soft: 12, hard: 20 },
    'I-2 大预算（≥40 步）回到既有 12/20——大预算不需要收紧，判据与旧行为相接');
  const conv = resolveExplorationQuota(10, 'conversation');
  eq(conv, { soft: 4, hard: 6 }, 'I-3 conversation@10 ⇒ 4/6（上下限各自夹紧：soft ≥ 4，hard ≥ 6）');
  ok(conv.soft < conv.hard, 'I-4 软线**永远**在硬线之前一档（留缓冲，不同一步软硬齐发）');

  const research = resolveExplorationQuota(20, 'research');
  ok(research.hard > resolveExplorationQuota(20, 'code').hard,
    'I-5 research 比例更宽（读活更费步），同 20 步下 hard 更大', `${research.hard} vs ${resolveExplorationQuota(20, 'code').hard}`);
  eq(resolveExplorationQuota(20, 'no-such-archetype'), resolveExplorationQuota(20, undefined),
    'I-6 未知原型落回缺省比例（不因拼错名字而把配额算成 0 或 NaN）');

  const derived = deriveShellExploreQuota(18, 'analysis');
  eq([derived.soft, derived.hard], [5, 9], 'I-7 派生口吐出的阈值即纯函数值（唯一派生口，不抄第二份比例）');
  ok(derived.softMsg.includes('已调用 5 次') && derived.hardMsg.includes('已调用 9 次'),
    'I-8 文案带上**本次派生值**（写死 12/20 的文案会与实际的闸门数字不符）',
    `${derived.softMsg.slice(0, 24)}… / ${derived.hardMsg.slice(0, 28)}…`);
  ok(!derived.softMsg.includes('已调用 12 次') && !derived.hardMsg.includes('已调用 20 次'),
    'I-9 反证：小预算下文案**不再**出现静态 12/20');
  const big = deriveShellExploreQuota(60, 'code');
  eq([big.soft, big.hard], [SHELL_EXPLORE_QUOTA.soft, SHELL_EXPLORE_QUOTA.hard],
    'I-10 ≥40 步派生值与静态 meta 数字一致（静态对象继续给无步数上下文的调用方用）');
  eq([big.softMsg, big.hardMsg], [SHELL_EXPLORE_QUOTA.softMsg, SHELL_EXPLORE_QUOTA.hardMsg],
    'I-11 且文案逐字一致——大预算下没有为派生而改写措辞');

  const execStep = readCode('apps/worker-ant-desktop/src/main/core/exec-step.ts');
  ok(execStep.includes(`toolRegistry.quotaKeyOf(tc.toolName) === SHELL_EXPLORE_QUOTA_KEY`)
    && execStep.includes('deriveShellExploreQuota(d.maxSteps, d.archetype)'),
    'I-12 接线：A3 只对 shell_explore 那本账派生（其余工具照读 meta 配额），且取本次 maxSteps/archetype');
  ok(execStep.includes('gate(toolRegistry.quotaKeyOf(tc.toolName), limit)')
    && execStep.includes('${limit.hard}次'),
    'I-13 判定与拒绝文案都读派生后的 limit（不是派生一套、闸门仍用静态一套）');
  const ratioSites = fs.readdirSync(path.join(ROOT, MAIN)).filter((f) => f.endsWith('.ts'))
    .filter((f) => fs.readFileSync(path.join(ROOT, MAIN, f), 'utf-8').includes('EXPLORATION_QUOTA_RATIO'));
  eq(ratioSites, ['step-budget.ts'], 'I-14 比例表**一处真源**（只有 step-budget 定义；tool-registry/exec-step 不抄表）');

  ok(execStep.includes('const reserveSteps = Math.max(3, Math.ceil(d.maxSteps * 0.1));'),
    'I-15 A7 末步预留按上限派生：10 步以内仍为 3（旧行为），预算更大时同步放大');
  ok(!/d\.maxSteps - d\.stepCount <= 3\b/.test(execStep),
    'I-16 反证：A7 的判据里**不再**写死 3');
  ok(execStep.includes('剩余 ${d.maxSteps - d.stepCount} 步 ≤ 预留 ${reserveSteps} 步；步数上限 ${d.maxSteps}，已用 ${d.stepCount}'),
    'I-17 A7 文案如实给出剩余/预留/上限/已用四个数（模型据此判断还剩多少收尾空间）');
}

// ══════════════════════════════════════════════════════════════════════
// J 恢复路沿用上次模型（M5）
// ══════════════════════════════════════════════════════════════════════

const J_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
`;

/** 一份合法的 ANS 回包；端点用环回未监听端口 ⇒ 探活确定性快速失败，不碰真网。 */
const jPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm-primary', model_name: 'qwen3.5:9b', url: 'http://127.0.0.1:1', api_key: 'k1',
  max_output_tokens: 4096, context_window: 128_000,
  input_price_per_1k: 0, output_price_per_1k: 0,
  capabilities: ['chat', 'function-calling'], capabilityMatch: 'full',
  sameProviderFallback: null, crossProviderFallback: null, fallback: null, ...o,
});

interface JPick { conv: string[]; model: string; apiKey: unknown; maxOut: unknown; ctx: unknown; prices: [unknown, unknown]; }

/** 跑一次**生产** `selectModelForTask` 并取回最终在用的端点 + 落下的会话行。 */
async function jpick(taskId: string, preferredModel: string | undefined, payload: Record<string, unknown>): Promise<JPick> {
  const db = new DatabaseSync(':memory:');
  db.exec(J_SCHEMA);
  db.prepare('INSERT INTO wa_tasks (id, project_id) VALUES (?, ?)').run(taskId, 'p-j');
  const r = await selectModelForTask({
    db: db as never, taskId, projectId: 'p-j', taskCtxJson: '{}',
    ansClient: { getOptimalModel: async () => payload } as never,
    archetype: 'conversation' as never, modelStrategy: 'balanced',
    ...(preferredModel !== undefined ? { preferredModel } : {}),
  });
  if ('stopped' in r) throw new Error(`选型被策略暂停：${r.stopped.content}`);
  const m = r.modelResult;
  const conv = (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ content: string }>)
    .map((x) => x.content);
  return { conv, model: String(m.model_name), apiKey: m.api_key, maxOut: m.max_output_tokens, ctx: m.context_window, prices: [m.input_price_per_1k, m.output_price_per_1k] };
}

async function sectionJ(): Promise<void> {
  console.log('\n【J】M5：恢复路沿用上次模型');

  const primary = await jpick('t-j1', 'qwen3.5:9b', jPayload());
  eq(primary.model, 'qwen3.5:9b', 'J-1 上次模型就是本次首选 ⇒ 最终仍在用它');
  ok(primary.conv.includes('[选型·沿用] 恢复沿用上次模型 qwen3.5:9b'),
    'J-1② 账上如实写"沿用"（含模型名）', primary.conv.filter((l) => l.startsWith('[选型·沿用]')).join(' | '));

  const alt = {
    model_id: 'm-alt', model_name: 'prev-model', url: 'http://127.0.0.1:1', api_key: 'k-alt',
    max_output_tokens: 8192, context_window: 96_000,
    input_price_per_1k: 1.5, output_price_per_1k: 2.5,
    capabilities: ['chat', 'function-calling'],
  };
  const promoted = await jpick('t-j2', 'prev-model', jPayload({ sameProviderFallback: alt }));
  eq([promoted.model, promoted.apiKey, promoted.maxOut, promoted.ctx, ...promoted.prices],
    ['prev-model', 'k-alt', 8192, 96_000, 1.5, 2.5],
    'J-2 上次模型在备用端点 ⇒ 提升为在用：名字/钥匙/输出上限/窗口/价格**一起**搬（只搬名字会让成本账与实际模型脱节）');
  ok(promoted.conv.includes('[选型·沿用] 恢复沿用上次模型 prev-model'),
    'J-2② 提升后账上如实写"沿用"（不是"未能沿用"）',
    promoted.conv.filter((l) => l.startsWith('[选型·沿用]')).join(' | '));

  const ghost = await jpick('t-j3', 'ghost-model', jPayload());
  eq(ghost.model, 'qwen3.5:9b', 'J-3 上次模型不在本次可用端点中 ⇒ 不硬塞，照常选型');
  ok(ghost.conv.includes('[选型·沿用] 上次模型 ghost-model 不在本次可用端点中，已重新选型为 qwen3.5:9b'),
    'J-3② 且如实说清"为什么没沿用 + 换成了谁"（不是静默换掉）');

  const firstRun = await jpick('t-j4', undefined, jPayload());
  ok(!firstRun.conv.some((l) => l.startsWith('[选型·沿用]')),
    'J-4 首跑（不传 preferredModel）⇒ 一条沿用账都不落（行为零变）');

  const ae = readCode(`${MAIN}/agent-executor.ts`);
  ok(ae.includes('preferredModel: options?.preferredModel'), 'J-5 接线：执行体把 options.preferredModel 原样交给选型段');
  const job = readCode(`${MAIN}/jobs/ai-task.ts`);
  ok(job.includes('.last_model') && job.includes('preferredModel ? { preferredModel } : undefined'),
    'J-5② 恢复路从 `last_model` 取值并传给 executeTask');
  const firstCall = job.indexOf('executeTask({ ...ctx, sendImAskUser: ctx.sendImAskUser }, taskId)');
  ok(firstCall > 0 && !job.slice(firstCall, firstCall + 160).includes('preferredModel'),
    'J-5③ 反证：首跑（ai-task）那处调用**不传** preferredModel——只钉恢复路');

  const ems = readCode(`${MAIN}/exec-model-select.ts`);
  const iNotice = ems.indexOf('[选型·沿用]');
  const iSwapNote = ems.indexOf('if (swapped || noSwapReason)');
  ok(iNotice > iSwapNote && iSwapNote > 0,
    'J-6 沿用账写在**所有换路之后**（先说换没换、再说沿用结果——先写"已沿用"后换走就是假话）');

  const mainDir = path.join(ROOT, `${A}/src/main`);
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (/\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [])));
  const sites = walk(mainDir).filter((f) => fs.readFileSync(f, 'utf-8').includes('[选型·沿用]'))
    .map((f) => path.relative(mainDir, f));
  eq(sites, ['core/exec-model-select.ts'], 'J-7 沿用账一处真源（src/main 只此一个文件写该前缀）');
}

// ══════════════════════════════════════════════════════════════════════
// K 费用闸三态（M6）
// ══════════════════════════════════════════════════════════════════════

function sectionK(): void {
  console.log('\n【K】M6：费用闸三态（有效 / 没设上限 / 设了但没单价）');
  eq(costGateReasonOf('task', true), 'active', 'K-1 有上限且已定价 ⇒ active');
  eq(costGateReasonOf('project', false), 'no_price', 'K-2 设了上限但模型未定价 ⇒ no_price（不是 no_cap）');
  eq(costGateReasonOf('none', false), 'no_cap', 'K-3 未设上限 ⇒ no_cap（没有闸，谈不上失效）');
  eq(costGateReasonOf('none', true), 'active', 'K-4 布尔为真时永远 active（两字段不打架）');

  const step = readCode(`${MAIN}/exec-step.ts`);
  ok(step.includes('ctxJson.cost_gate_reason = costGateReasonOf(d.costSrc, d.costGateActive);'),
    'K-5 引擎在布尔同一处落三态原因（一次写库，GUI 不必二次推断）');
  ok(step.includes('ctxJson.cost_gate_active = d.costGateActive;'),
    'K-6 旧布尔仍在（旧读方不被新字段替掉）');
  const mainDir = path.join(ROOT, `${A}/src/main`);
  const walkK = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walkK(path.join(d, e.name)) : (/\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [])));
  const reasonSites = walkK(mainDir).filter((f) => /cost_gate_reason\s*=/.test(fs.readFileSync(f, 'utf-8')))
    .map((f) => path.relative(mainDir, f));
  eq(reasonSites, ['core/exec-step.ts'], 'K-7 三态原因一处写点（不出现第二份各自判）');

  const td = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  // zx_20261107_1 B9: 费用区按关节抽成 `TaskCost`——判据按符号重定向到渲染真源（只移动位置，不放宽）：
  //   页面仍须把 `cost_gate_reason` 读出来并做三态派生；三态比较与文案在组件里。
  const tdCost = readCode(`${A}/renderer/src/components/task/TaskCost.tsx`);
  ok(td.includes('cost_gate_reason') && tdCost.includes("costGateReason === 'no_price'"),
    'K-8 任务详情按三态显示（不是只看布尔）');
  ok(tdCost.includes('费用闸未生效') && tdCost.includes('模型管理'),
    'K-9 no_price 文案如实指出原因并指向模型管理');
  ok(td.includes("ctx?.cost_gate_reason") && td.includes('costGateActive === true'),
    'K-10 旧任务无新字段时按既有两字段回退（不显示"未知"）');

  const mp = readCode(`${A}/renderer/src/pages/ModelsPage.tsx`);
  ok(mp.includes('缺单价·费用闸不生效'), 'K-11 模型管理对双侧单价均缺的模型加标记');
  ok(/Number\(m\.input_price_per_1k \|\| 0\) === 0 && Number\(m\.output_price_per_1k \|\| 0\) === 0/.test(mp),
    'K-12 标记判据：两侧单价都按 0 计（只缺一侧不算"无法计量"）');
}

// ══════════════════════════════════════════════════════════════════════
// L 快照审计覆盖率与第二通道（M7）
// ══════════════════════════════════════════════════════════════════════

async function sectionL(): Promise<void> {
  console.log('\n【L】M7：截断给覆盖率，收口给本任务写入清单');

  const full = { fileCount: 3, truncated: false, fileHashes: ['/w/a:1', '/w/b:2', '/w/c:3'] };
  const covFull = describeSnapshotCoverage(full);
  eq([covFull.truncated, covFull.sampled, covFull.total, covFull.coverageText], [false, 3, 3, ''],
    'L-1 未截断 ⇒ 覆盖率声明为空（没有"不知道的部分"就不硬造边界声明）');

  const big = { fileCount: 2500, truncated: true, fileHashes: Array.from({ length: 2000 }, (_, i) => `/w/f${i}:1`), taskStates: [] };
  const covBig = describeSnapshotCoverage(big);
  eq([covBig.truncated, covBig.sampled, covBig.total], [true, 2000, 2500], 'L-2 截断 ⇒ sampled/total 分列（样本量不冒充总数）');
  eq(covBig.coverageText, '样本覆盖 2000/2500 个路径（按顶层目录轮转），样本外未审计', 'L-3 覆盖率文案：N/M + 抽样口径 + 样本外未审计');

  const truncatedIssues = compareSnapshots({ fileCount: 100, truncated: false, fileHashes: ['/w/a:1'], taskStates: [] }, big);
  ok(truncatedIssues.length === 1 && truncatedIssues[0]!.startsWith(TRUNCATION_ISSUE_PREFIX),
    'L-4 截断 ⇒ 仍只出一条"未做增删判定"（不冒充发现不一致）', truncatedIssues.join(' | '));
  ok(truncatedIssues[0]!.includes('样本覆盖 2000/2500 个路径（按顶层目录轮转），样本外未审计'),
    'L-5 该条里带覆盖率（读者知道哪部分没审计）', truncatedIssues[0]);
  ok(!/无增删|无变化/.test(truncatedIssues.join(' ')),
    'L-6 截断文案不含"无增删/无变化"（不知道就不说知道）');

  const cleanIssues = compareSnapshots(
    { fileCount: 2, truncated: false, fileHashes: ['/w/a:1', '/w/gone:9'], taskStates: [] },
    { fileCount: 2, truncated: false, fileHashes: ['/w/a:1', '/w/new:5'], taskStates: [] },
  );
  ok(cleanIssues.some((s) => s.includes('文件删除')) && cleanIssues.some((s) => s.includes('文件新增')),
    'L-7 未截断 ⇒ 正常做增删判定（覆盖率声明不越权顶替真结论）', cleanIssues.join(' | '));

  // 第二证据通道：真调 `auditWorldConsistency`（临时工作目录 + 内存库），不靠静态扫描自证。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m7-'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, working_dir TEXT);
             CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT);`);
    db.prepare('INSERT INTO wa_projects (id, working_dir) VALUES (?, ?)').run('wp-l', dir);
    db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('T-l', '{}');
    fs.writeFileSync(path.join(dir, 'made-by-task.txt'), 'x');
    const since = Date.now() - 60_000;
    await auditWorldConsistency(db as never, 'T-l', 'wp-l', () => {}, { runStartedAtMs: since, fileMutationCount: 3 });
    const raw = (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('T-l') as { context_json: string }).context_json;
    const checks = (JSON.parse(raw).finalize_checks || []) as string[];
    const ch = checks.find((c) => c.includes('第二通道')) || '';
    ok(ch.includes('本任务命令窗口写入 1 个文件') && ch.includes('made-by-task.txt'),
      'L-8 第二通道如实列出本任务窗口内写入的文件（不依赖前后快照）', ch);
    ok(ch.includes('不是世界全量'), 'L-9 清单自报边界（本任务写过的 ≠ 世界全量）');
    ok(ch.includes('与文件改写计数不符') && ch.includes('引擎记 3 次、窗口盘点 1 个'),
      'L-10 与 fileMutationCount 对不上 ⇒ 如实写差额（不静默）', ch);

    db.prepare('DELETE FROM wa_tasks WHERE id = ?').run('T-l');
    db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('T-l2', '{}');
    await auditWorldConsistency(db as never, 'T-l2', 'wp-l', () => {}, { runStartedAtMs: since, fileMutationCount: 1 });
    const raw2 = (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('T-l2') as { context_json: string }).context_json;
    const ch2 = ((JSON.parse(raw2).finalize_checks || []) as string[]).find((c) => c.includes('第二通道')) || '';
    ok(ch2 && !ch2.includes('与文件改写计数不符'), 'L-11 对得上 ⇒ 不写差额句（不制造假的不一致）', ch2);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const ws = readCode(`${MAIN}/world-snapshot.ts`);
  ok(ws.includes('describeSnapshotCoverage(snap).coverageText'),
    'L-12 覆盖率文案一处派生（compareSnapshots 不手抄样本量）');
  // zx_20261109_1 B2：取数口由 `listFilesWrittenSince` **原位换成本 run 的一次扫描**（同一份同时供
  //   第二通道与 after 快照使用）。断言钉**两处同源**，不钉旧函数名——它如今只作无扫描时的退路。
  ok(ws.includes("typeof f.mtimeMs === 'number' && f.mtimeMs >= since")
    && ws.includes('snapshotFromScan(db, projectId, await ensureScan())'),
    'L-13 第二通道与 after 快照复用**同一份**工作目录扫描（B2：不再各扫一遍；窗口判定仍按 mtime ≥ 本轮起始时刻）');
  const ae = readCode(`${MAIN}/agent-executor.ts`);
  // zx_20261109_1 B5 按符号重定向：同一处注入面再添 `runId`（审计行前缀与完成事件同源同一 run），
  //   钉的仍是"完整形状同处一次注入"，多第五项而非放宽。
  ok(ae.includes('auditWorldConsistency(') && ae.includes('{ dataDir: ctx.dataDir, runStartedAtMs, fileMutationCount, scan: auditScan, runId: ctx.runId }')
    && ae.includes('runWorldAudit = () => {'),
    'L-14 接线：收口把本轮起始时刻、改写计数、**本 run 的同一份扫描**与 run_id 交给审计；且由 `runWorldAudit` 在收口落定后触发（B2 延后，不阻塞完成路径）');
}

// ══════════════════════════════════════════════════════════════════════
// M 收口如实上屏（M8）
// ══════════════════════════════════════════════════════════════════════

function sectionM(): void {
  console.log('\n【M】M8：达成凭据四态 + 被迫收尾标记上屏');
  const td = readCode(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(td.includes('goal_evidence') && td.includes('premature'),
    'M-1 任务详情读引擎落的 `goal_evidence` / `premature`（不从分数二次推断）');
  ok(td.includes("ev === 'acceptance_passed' ? '已验收达成'"), 'M-2 验收全过 ⇒ 已验收达成');
  ok(td.includes("ev === 'acceptance_failed' ? '验收未通过'"), 'M-3 验收未过 ⇒ 验收未通过');
  // zx_20261106_1 M2：仅分数这一支**结论须随账上 `goal_achieved` 翻面**（生产标本 d628e8e1：
  //   goal_achieved=false + premature 却印「达成」，与同卡「未达目标」自相矛盾）。
  //   故由"钉死一句字面量"升级为"钉住两支 + 翻面条件"，比原断言更强。
  {
    const s = td.indexOf("ev === 'score_only' ?");
    const e = td.indexOf("ev === 'none'", s);
    const scoreOnly = s >= 0 ? td.slice(s, e > s ? e : s + 800) : '';
    ok(scoreOnly.includes('仅按质量分推断，未验收')
      && scoreOnly.includes('未达成（仅按质量分推断，未验收）')
      && scoreOnly.includes('goal_achieved === false'),
      'M-4 仅分数 ⇒ 明写"仅按质量分推断，未验收"，且未达成时不冒充已达成');
  }
  ok(td.includes("ev === 'none' ? '未判定'"), 'M-5 无账 ⇒ 未判定（不编结论）');
  ok(td.includes('被迫收尾（步数/预算触顶）') && td.includes('completionQuality?.premature === true'),
    'M-6 premature 为真才追加"被迫收尾"标记');
  ok(td.includes('达成凭据：'), 'M-7 标记以"达成凭据"上屏（用户知道这句话的依据是什么）');

  const blockStart = td.indexOf('const ev = completionQuality?.goal_evidence;');
  const blockEnd = td.indexOf('})()}', blockStart);
  const block = blockStart >= 0 && blockEnd > blockStart ? td.slice(blockStart, blockEnd) : '';
  ok(block.length > 0 && !/onClick|button/.test(block),
    'M-8 该块只读（不接按钮/操作流）');

  const to = readCode(`${MAIN}/task-outcome.ts`);
  ok(to.includes('goal_evidence') && to.includes('completion_quality'),
    'M-9 上屏字段与引擎账同源（buildCompletionAccount 落 completion_quality.goal_evidence）');
}

// ══════════════════════════════════════════════════════════════════════
// N 人的决定不被续额替人取消（M9）
// ══════════════════════════════════════════════════════════════════════

function sectionN(): void {
  console.log('\n【N】M9：撞顶续额自动续跑只认"引擎因撞顶而停"那一次');

  const cap = { step_cap_grants: 1, step_cap_hit: { resume_bonus: 45 } };
  eq(shouldAutoResumeOnStepCap({ ...cap, pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR }).due, true,
    'N-1 引擎因撞顶停（quality_below_bar）+ 有续额 ⇒ due（原功能不被误伤）');
  eq(shouldAutoResumeOnStepCap({ ...cap, pause_reason: PAUSE_REASON_USER_INTERRUPT }).due, false,
    'N-2 用户中止 + 同账 ⇒ false（人点暂停就是停）');
  eq(shouldAutoResumeOnStepCap({ ...cap, pause_reason: PAUSE_REASON_AWAITING_INPUT }).due, false,
    'N-3 等用户回复 + 同账 ⇒ false');
  eq(shouldAutoResumeOnStepCap({ ...cap, pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE }).due, false,
    'N-4 等子任务 + 同账 ⇒ false（子完成走它自己的唤醒路）');
  eq(shouldAutoResumeOnStepCap({ ...cap, pause_reason: PAUSE_REASON_POLICY_PAUSED }).due, false,
    'N-5 策略暂停 + 同账 ⇒ false');
  eq(shouldAutoResumeOnStepCap({ ...cap }).due, false, 'N-6 无停因记录 + 同账 ⇒ false（判不了就不替人做主）');

  eq([
    shouldAutoResumeOnStepCap({ pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR }).due,
    shouldAutoResumeOnStepCap({ pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR, step_cap_hit: { resume_bonus: 0 } }).due,
    shouldAutoResumeOnStepCap({ pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR, step_cap_hit: { resume_bonus: 45, auto_resumed: 'x' } }).due,
    shouldAutoResumeOnStepCap({ pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR, step_cap_grants: STEP_CAP_GRANT_LIMIT + 1, step_cap_hit: { resume_bonus: 45 } }).due,
  ], [false, false, false, false], 'N-7 既有四态（无账 / 未发续额 / 已续跑 / 次数超限）逐条保留');

  const blocked = shouldAutoResumeOnStepCap({ ...cap, pause_reason: PAUSE_REASON_USER_INTERRUPT }).reason;
  ok(blocked.includes('用户中止/暂停') && blocked.includes('不自动续跑'),
    'N-8 挡下时判词如实写停因与"不自动续跑"（不静默跳过）', blocked);

  const sb = readCode(`${MAIN}/step-budget.ts`);
  ok(sb.includes('pauseReason !== PAUSE_REASON_QUALITY_BELOW_BAR'),
    'N-9 白名单取常量（不手抄字面量；改词表即编译错）');

  const sched = readCode(`${MAIN}/task-scheduler.ts`);
  ok(sched.includes('const decision = shouldAutoResumeOnStepCap(ctx);') && !/resume_bonus/.test(sched),
    'N-10 调度器只调唯一判据，不另判续额（规则不出现第二份）');
  ok(sched.includes('撞顶续额：闸挡下，不自动续跑') && sched.includes('pause_reason: ctx.pause_reason'),
    'N-11 被挡下时留 debug 且带停因（可溯源，不改既有系统消息）');

  const ps = readCode(`${MAIN}/pause-settlement.ts`);
  ok(ps.includes('delete ctx.step_cap_hit;') && !/delete ctx\.step_budget_bonus/.test(ps) && !/delete ctx\.step_cap_grants/.test(ps),
    'N-12 人接管只作废"自动续跑"凭据，续额与次数保留');
  const callSites = (ps.match(/voidStepCapAutoResume\(ctx\);/g) || []).length;
  eq(callSites, 2, 'N-13 恰好两处调用（settlePause 的 clear 支 + resumeWithQuota），不多不少');
  ok(/if \(clear\) \{\s*delete ctx\.awaiting_input;\s*delete ctx\.pending_approval;\s*voidStepCapAutoResume\(ctx\);/.test(ps),
    'N-14 只在 clear=true 清账（连续拒绝、仍暂停时账仍成立）');

  // 真 SQL：清账与保留两侧
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', status TEXT DEFAULT 'paused', context_json TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')));
             CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));`);
    const mk = (id: string, ctx: Record<string, unknown>) => db.prepare(
      'INSERT INTO wa_tasks (id, project_id, status, context_json) VALUES (?, ?, ?, ?)',
    ).run(id, 'p', 'paused', JSON.stringify(ctx));
    const readCtx = (id: string) => JSON.parse(
      (db.prepare('SELECT context_json AS c FROM wa_tasks WHERE id = ?').get(id) as { c: string }).c,
    ) as Record<string, unknown>;

    const c1 = { step_budget_bonus: 90, step_cap_grants: 1, step_cap_hit: { count: 1, resume_bonus: 45 }, pause_reason: PAUSE_REASON_USER_INTERRUPT };
    mk('n1', c1);
    settlePause(db as never, 'n1', c1, 'resume', undefined, true);
    const r1 = readCtx('n1');
    eq([('step_cap_hit' in r1), r1.step_budget_bonus, r1.step_cap_grants], [false, 90, 1],
      'N-15 GUI 恢复（clear=true）⇒ 撞顶账清、续额留（落库为据，不只看内存）');

    const c2 = { step_budget_bonus: 90, step_cap_grants: 1, step_cap_hit: { count: 1, resume_bonus: 45 } };
    mk('n2', c2);
    settlePause(db as never, 'n2', c2, 'reject', undefined, false);
    eq(readCtx('n2').step_cap_hit, { count: 1, resume_bonus: 45 }, 'N-16 连续拒绝（clear=false）⇒ 撞顶账原样保留');

    const c3 = { step_budget_bonus: 90, step_cap_grants: 1, step_cap_hit: { count: 1, resume_bonus: 45 } };
    mk('n3', c3);
    resumeWithQuota(db as never, 'n3');
    const r3 = readCtx('n3');
    const s3 = (db.prepare('SELECT status AS s FROM wa_tasks WHERE id = ?').get('n3') as { s: string }).s;
    eq([('step_cap_hit' in r3), r3.step_budget_bonus, s3], [false, 90, 'pending'],
      'N-17 IM 恢复同属人已接管：撞顶账清、续额留、置 pending');

    // 时间线复现：同一笔续额，只换停因，调度判据的结果相反（闸只挡人停，不挡原功能）
    const timeline = (reason: string) => ({ ...cap, pause_reason: reason });
    eq([shouldAutoResumeOnStepCap(timeline(PAUSE_REASON_USER_INTERRUPT)).due,
      shouldAutoResumeOnStepCap(timeline(PAUSE_REASON_QUALITY_BELOW_BAR)).due], [false, true],
      'N-18 时间线对照：停因 user_interrupt 不拉起、quality_below_bar 拉起');
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  const ae = readCode(`${MAIN}/agent-executor.ts`);
  ok(!/interruptTask[\s\S]{0,600}?step_cap_hit/.test(ae),
    'N-19 暂停写入口不加特例（因由闸在唯一判据处，避免规则第二份）');
}

// ══════════════════════════════════════════════════════════════════════
// H 构建钉与套件自检
// ══════════════════════════════════════════════════════════════════════

function sectionH(): void {
  console.log('\n【H】构建钉与套件自检');
  checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });

  ok(ROUND_RE.test(SELF_ROUND), 'H-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);
  ok(fs.existsSync(path.join(ROOT, `plans/improve/${SELF_ROUND}.md`)), `H-2 本轮方案在册：plans/improve/${SELF_ROUND}.md`);

  const selfLines = stripKeepingLines(fs.readFileSync(__filename, 'utf-8'));
  const dud = selfLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'zx_\d{8}(?:_\d+)?'/.test(line));
  ok(dud.length === 0, 'H-3 本套件无「只为下一轮」字面量', dud.map((x) => `${x.i + 1}:${x.line.trim()}`).join(' | '));

  const selfText = fs.readFileSync(__filename, 'utf-8');
  const badGlyphs = [0x2717, 0x2713].map((c) => String.fromCodePoint(c));
  ok(!badGlyphs.some((g) => selfText.includes(g)), 'H-4 本套件文案无失败/通过字形（全量汇总器按失败字形计数）');
  ok(/通过 \/ .*失败/.test(selfText), 'H-5 收尾行如实印出断言数（通过 / 失败）');
}

async function main(): Promise<void> {
  console.log(`rr_${SELF_ROUND} 受控回归（凭：完成要有凭据）`);
  sectionA();
  sectionB();
  sectionC();
  sectionD();
  sectionE();
  sectionF();
  sectionG();
  sectionI();
  await sectionJ();
  sectionK();
  await sectionL();
  sectionM();
  sectionN();
  sectionH();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

void main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch((e: unknown) => {
    console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
    console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail + 1} 失败\n`);
    process.exit(1);
  });
