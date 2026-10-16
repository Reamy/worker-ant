/**
 * zx_20261016_3 受控复跑 —— 「自新」自优化三件闭环。
 *
 * 本轮口径（方案 §0/§1）：闭环此前只知道"任务**跑得成**"，不知道"任务**跑得好**"——
 *   M32 质量分不进闸、M33-a 自愈只熔断不给对策、M33-b 子任务无目的因、M34 无"能改变引擎行为的东西"的闸。
 *
 * 分组（方案 §3）：
 *   M · M32 质量分入闸        —— `qualityBandOf`/`strategyVerdictOf` 分带边值与升降档后果（本批 §五-1）
 *   C · M33-a 自愈对策        —— 复发 ⇒ **一条具体对策**，且**作用到行为**（两侧标本）
 *   D · M33-b 子任务四因      —— （批三回填）
 *   E · M34 提案闸与红线      —— （批四回填）
 *   S · 哑雷自检 + build 钉   —— （批五回填）
 *
 * §判据纪律（逐条对上本仓 auto-memory）：
 *   G-1 **用生产函数、不自造等价实现**：只调生产导出（`qualityBandOf` / `strategyVerdictOf` /
 *       `adjustProjectStrategy` / `proposeCountermeasure` / `applyCountermeasure` / `tryHeal` …）。
 *   G-2 **每条判据都能被合法数据满足**，且**有区分度**：正反两侧各给一只真标本
 *       （`feedback_predicate_needs_both_sides_specimen`）。
 *   G-3 **计数器用"0→1"正面断言**，不用"不抛"代替（被 `catch {}` 吞掉的写入只有正面断言抓得住）。
 *   G-4 **不依赖真实墙钟**：不 sleep、不比真实时刻；`isStrategyBreakerActive` 走可注入的 `nowMs`。
 *   G-5 静态判据一律读**原文**（不去注释）；锚点钉**符号/语句形状**。
 *   G-6 **无轮次字面量**：不写 `zx_…` 常量；轮次相关一律由 `path.basename(__filename)` 派生。
 *   G-7 夹具 schema 逐列照抄 `database.ts` DDL（既不缺列也不放宽 NOT NULL），且**先 `new` 服务类再插行**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// M · M32：质量分带 + 升/降档判据（零依赖真源）
import { QUALITY_BANDS, qualityBandOf, strategyVerdictOf } from '../apps/worker-ant-desktop/src/main/core/quality-gate.js';
// M/C · 闭环：策略调整 / 出账 / 自然涌现 / 项目级熔断
import {
  adjustProjectStrategy, recordStrategyOutcome, naturalStrategySelection,
  stepUpTier, stepDownTier, MODEL_TIER_LADDER,
  STRATEGY_BREAKER_HOURS, isStrategyBreakerActive, setStrategyBreaker, readActiveStrategyBreaker,
  type ExecutionMetrics,
} from '../apps/worker-ant-desktop/src/main/core/feedback-engine.js';
// C · M33-a：对策生产者与落点（与写入方同处一文件的真源）
import {
  proposeCountermeasure, applyCountermeasure, resolveProjectIdForTarget, tryHeal,
  DAEMON_STALE_MINUTES_CURRENT, DAEMON_STALE_MINUTES_SUGGESTED, DAEMON_STALE_MINUTES_SETTING_KEY,
  SELF_HEALING_LOGS_DDL,
} from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
// C · M34 半边：提案台账建表真源（夹具**引生产 DDL**，不手抄）
import { SELF_EVOLVE_DDL, listProposals } from '../apps/worker-ant-desktop/src/main/core/self-evolve.js';
// E · M34 批四：人工闸（approve/reject/rollback）+ 红线守卫 + 决策词表
import {
  assertProposalTargetAllowed, recordProposal, hasPendingProposalFor, decideProposal,
  PROPOSAL_DECISIONS, SELF_EVOLVE_STATUSES, SOURCE_TREE_PREFIXES,
} from '../apps/worker-ant-desktop/src/main/core/self-evolve.js';
// E · 向前依赖的兑现点：阈值提案**真的被读到行为里**（`runHealthScan` 第 1 项的取数口）
import { readDaemonStaleMinutes, runHealthScan } from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
// D · M33-b：四因词表 + 判据一处真源（零 import，故跨 root 引得动）
import { FOUR_CAUSES, FOUR_CAUSE_LABEL, hasFinalCause, fourCauseOf } from '../apps/worker-ant-desktop/src/main/core/four-causes.js';
// D · M33-b：拆解解析口（拒无目的因）+ 落行（写 `$.purpose`）+ 「到点即拆」执行体（端到端）
import {
  buildDecomposePrompt, parseDecomposition, planSubtasksFromTemplate, autoDecomposeForTask,
  DECOMPOSE_MIN_SUBTASKS, type DecomposeDeps,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string): void =>
  ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
type AnyDb = import('better-sqlite3').Database;

/** 本脚本轮次**由文件名派生**（不写字面量——写了就是给下一轮设哑雷，见 §S）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

// ── 夹具 schema：按 database.ts DDL 摘取本文件用到的列（NOT NULL 照抄；两张账本表引**生产 DDL**）──
const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
  title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
  context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT REFERENCES wa_tasks(id),
  role TEXT NOT NULL, content TEXT DEFAULT '', tool_calls TEXT,
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
  task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '',
  file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
` + SELF_HEALING_LOGS_DDL + SELF_EVOLVE_DDL;

function fdb(): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec('PRAGMA foreign_keys = ON');
  d.exec(SCHEMA);
  return d;
}

/** 建项目（`context_json` 可注入既有状态）。 */
function mkProject(db: AnyDb, id: string, ctx: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?, ?, ?)').run(id, `P-${id}`, JSON.stringify(ctx));
}
/** 建任务（挂在项目下）——`resolveProjectIdForTarget` 靠它把目标解析到项目。 */
function mkTask(db: AnyDb, id: string, projectId: string): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title) VALUES (?, ?, ?)').run(id, projectId, `T-${id}`);
}
/** 建成果（守护进程类）——第 2 类异常的靶子。 */
function mkDaemon(db: AnyDb, id: string, projectId: string): void {
  db.prepare("INSERT INTO wa_deliverables (id, project_id, type, name, status) VALUES (?, ?, 'daemon', ?, 'running')").run(id, projectId, `D-${id}`);
}
const ctxOf = (db: AnyDb, projectId: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string }).context_json || '{}');
const logCount = (db: AnyDb): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM wa_self_healing_logs').get() as { c: number }).c;
const lastLog = (db: AnyDb, anomaly: string) =>
  db.prepare('SELECT anomaly, action, success, outcome, detail FROM wa_self_healing_logs WHERE anomaly = ? ORDER BY rowid DESC LIMIT 1')
    .get(anomaly) as { anomaly: string; action: string; success: number; outcome: string | null; detail: string | null } | undefined;

/** 造一个闭环指标（各测点只覆盖自己关心的字段）。 */
function M(o: Partial<ExecutionMetrics> & { projectId: string }): ExecutionMetrics {
  return {
    taskId: 't', archetype: 'code', stepsUsed: 1, maxSteps: 15, toolCalls: 1,
    totalTokens: 1000, estimatedCost: 0.01, hasDeliverable: true, qualityScore: 90,
    status: 'completed', modelName: 'm',
    ...o,
  } as ExecutionMetrics;
}

// ══════════════════════════════════════════════════════════════════
// 【M】M32 · 质量分入闸（闭环从"跑得成"到"跑得好"）
// ══════════════════════════════════════════════════════════════════
function groupM(): void {
  console.log('\n【M】M32 · 质量分入闸（靶心：低分完成此前与高分完成在闭环里长得一模一样）');

  eq(QUALITY_BANDS, { high: 80, mid: 60 }, 'M-1 ★分带阈值**一处真源**：高 80 / 中 60（改值即红）');

  // 边值两侧都要有标本（承 feedback_predicate_needs_both_sides_specimen：只用"该命中"样本
  //   会让任何过宽的变体全票通过）。
  eq(
    [qualityBandOf(80), qualityBandOf(79.9), qualityBandOf(60), qualityBandOf(59.9), qualityBandOf(0), qualityBandOf(100)],
    ['high', 'mid', 'mid', 'low', 'low', 'high'],
    'M-2 ★分带**边值**逐点：80 起算高、60 起算中、59.9 落低——边界含左不含右（`>=` 而非 `>`）',
  );
  eq(
    [qualityBandOf(undefined), qualityBandOf(null), qualityBandOf(NaN)],
    ['mid', 'mid', 'mid'],
    'M-3 ★**未知 ⇒ 中带**（不是低带）："没记过账"≠"跑得差"（承 zx_20260928 M5 弃权纪律）——'
    + '若回退成 `low`，存量任务会被一律判为"低分完成"而疯狂升档',
  );

  eq(
    [
      strategyVerdictOf({ status: 'failed' }),
      strategyVerdictOf({ status: 'completed', qualityScore: 50 }),
      strategyVerdictOf({ status: 'completed', qualityScore: 70 }),
      strategyVerdictOf({ status: 'completed', qualityScore: 95 }),
      strategyVerdictOf({ status: 'paused' }),
    ],
    ['step_up', 'step_up', 'step_down_eligible', 'step_down_eligible', 'hold'],
    'M-4 ★★升降档判据**两侧标本齐全**：失败⇒升；**低分完成⇒升**（这是本轮靶心——改前它算"成功"）；'
    + '中/高分完成⇒可回落；暂停⇒不动（`hold` 不是 `step_down_eligible`，暂停不该被算成"成功"）',
  );

  // ── 后果：同一状态、只有质量分不同 ⇒ 后续策略**不同**（判据要落到行为，不能只判纯函数）──
  {
    const db = fdb();
    mkProject(db, 'pA', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } });
    mkProject(db, 'pB', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } });

    // stepsUsed 刻意取 10（≥ `15*0.5`）⇒ "高效完成微调"那一支**不**参与，两边的差异只可能来自质量分。
    adjustProjectStrategy(db as never, 'pA', M({ projectId: 'pA', status: 'completed', qualityScore: 50, stepsUsed: 10 }));
    adjustProjectStrategy(db as never, 'pB', M({ projectId: 'pB', status: 'completed', qualityScore: 95, stepsUsed: 10 }));

    eq(ctxOf(db, 'pA').learned_strategy, { modelStrategy: 'capability-best', temperature: 0.6, maxSteps: 15 },
      'M-5 ★★**低分完成 ⇒ 升档**（balanced → capability-best），且 temperature 同时降至 0.6（低分⇒提精确度）：'
      + '判卷没过就该换更强的模型、更收敛的采样，而不是像改前那样被当成"连续成功"、反而往便宜的档位回落');
    eq(ctxOf(db, 'pB').learned_strategy, { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 },
      'M-6 ★★**高分完成 ⇒ 一律不动**（档位、temperature、maxSteps 全原值）——同一 `status`、只有质量分不同，'
      + '两条路的结局必须不同（这是"入闸"二字的实义）；两侧标本都在，任何"只看 status"的过宽变体都过不了');
  }

  // ── 低分完成**打断**连续计数；非低分完成才计入回落 ──
  {
    const db = fdb();
    mkProject(db, 'pC', { learned_strategy: { modelStrategy: 'capability-best', temperature: 0.7, maxSteps: 15 }, learned_strategy_success_streak: 2 });
    adjustProjectStrategy(db as never, 'pC', M({ projectId: 'pC', status: 'completed', qualityScore: 50 }));
    eq(ctxOf(db, 'pC').learned_strategy_success_streak, 0,
      'M-7 ★低分完成**清零** `success_streak`——"判卷没过"不该被计入"连续高质量完成"（改前正是这么算的）');
  }
  {
    const db = fdb();
    mkProject(db, 'pD', { learned_strategy: { modelStrategy: 'capability-best', temperature: 0.7, maxSteps: 15 }, learned_strategy_success_streak: 2 });
    adjustProjectStrategy(db as never, 'pD', M({ projectId: 'pD', status: 'completed', qualityScore: 95 }));
    eq([ctxOf(db, 'pD').learned_strategy_success_streak, (ctxOf(db, 'pD').learned_strategy as { modelStrategy: string }).modelStrategy],
      [0, 'balanced'],
      'M-8 ★非低分完成**计入**回落：streak 2 → 3 ⇒ 降一档并清零（capability-best → balanced）——'
      + '与 M-7 配对，"低分"与"非低分"两侧各有一只真标本');
  }
  {
    const db = fdb();
    mkProject(db, 'pE', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } });
    adjustProjectStrategy(db as never, 'pE', M({ projectId: 'pE', status: 'completed', qualityScore: 70 }));
    eq([(ctxOf(db, 'pE').learned_strategy as { modelStrategy: string }).modelStrategy, ctxOf(db, 'pE').learned_strategy_success_streak],
      ['balanced', 1],
      'M-9 中带完成：既不升档、也不降档，只把 streak 记到 1（`step_down_eligible` 需攒满 3）');
  }

  // ── 质量分按同一口径滚动平均进 `avgQuality`（供择优选档）；`successCount` 原义不变 ──
  {
    const db = fdb();
    mkProject(db, 'pF', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } });
    const base = { projectId: 'pF', strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } };
    recordStrategyOutcome(db as never, 'pF', M({ ...base, status: 'completed', qualityScore: 100 }));
    recordStrategyOutcome(db as never, 'pF', M({ ...base, status: 'completed', qualityScore: 60 }));
    const rec = (ctxOf(db, 'pF').strategy_history as Record<string, { avgQuality?: number; successCount: number; totalCount: number }>)['balanced|code']!;
    eq([rec.avgQuality, rec.successCount, rec.totalCount], [80, 2, 2],
      'M-10 ★滚动平均两侧都对：`(100+60)/2=80`；而 `successCount` 仍计 2（**质量只进 `avgQuality`**，'
      + '不与"完成"计数混为一谈——两本账各记各的）');
  }

  // ── 存量行缺 `avgQuality` ⇒ 回退旧口径（成功率 → 成本），不把未知读成坏值 ──
  {
    const db = fdb();
    mkProject(db, 'pG', {
      strategy_history: {
        'cost-optimal|code': { modelStrategy: 'cost-optimal', archetype: 'code', successCount: 3, totalCount: 3, avgTokens: 100, avgCost: 0.002, avgSteps: 5 },
        'capability-best|code': { modelStrategy: 'capability-best', archetype: 'code', successCount: 2, totalCount: 3, avgTokens: 900, avgCost: 0.05, avgSteps: 20 },
      },
    });
    eq(naturalStrategySelection(db as never, 'pG', 'code')?.modelStrategy, 'cost-optimal',
      'M-11 ★存量行（**无** `avgQuality`）回退旧口径：两条都没有质量分 ⇒ 比成功率（1.0 vs 0.67）'
      + '⇒ 仍选成功率高的那条——**不**因缺质量分而抛错、也不把未知当 0 分');
  }
  {
    const db = fdb();
    mkProject(db, 'pH', {
      strategy_history: {
        'cost-optimal|code': { modelStrategy: 'cost-optimal', archetype: 'code', successCount: 3, totalCount: 3, avgTokens: 100, avgCost: 0.002, avgSteps: 5, avgQuality: 55 },
        'capability-best|code': { modelStrategy: 'capability-best', archetype: 'code', successCount: 3, totalCount: 3, avgTokens: 900, avgCost: 0.05, avgSteps: 20, avgQuality: 92 },
      },
    });
    eq(naturalStrategySelection(db as never, 'pH', 'code')?.modelStrategy, 'capability-best',
      'M-12 ★★质量分**优先于**成功率与成本：两者成功率都是 1.0、成本差 25 倍，但 `capability-best` 质量 92 vs 55 '
      + '⇒ 它胜出（"跑得好"压过"跑得便宜"）——这正是本轮把质量分接进自然涌现择档的落点',
    );
  }
  {
    const db = fdb();
    mkProject(db, 'pI', {
      strategy_history: {
        'cost-optimal|code': { modelStrategy: 'cost-optimal', archetype: 'code', successCount: 3, totalCount: 3, avgTokens: 100, avgCost: 0.002, avgSteps: 5, avgQuality: 90 },
        'capability-best|code': { modelStrategy: 'capability-best', archetype: 'code', successCount: 3, totalCount: 3, avgTokens: 900, avgCost: 0.05, avgSteps: 20, avgQuality: 90.5 },
      },
    });
    eq(naturalStrategySelection(db as never, 'pI', 'code')?.modelStrategy, 'cost-optimal',
      'M-13 ★质量分差 **< 1 分视同并列** ⇒ 落回成功率/成本（90 vs 90.5 换档没有意义，只是抖振）——'
      + '两条都认得质量分，故这不是"未知回退"，是**并列判定**（两回事，各有标本）',
    );
  }
  {
    const db = fdb();
    mkProject(db, 'pJ', {
      strategy_history: {
        'cost-optimal|code': { modelStrategy: 'cost-optimal', archetype: 'code', successCount: 3, totalCount: 3, avgTokens: 100, avgCost: 0.002, avgSteps: 5 },
        'capability-best|code': { modelStrategy: 'capability-best', archetype: 'code', successCount: 3, totalCount: 3, avgTokens: 900, avgCost: 0.05, avgSteps: 20, avgQuality: 92 },
      },
    });
    eq(naturalStrategySelection(db as never, 'pJ', 'code')?.modelStrategy, 'cost-optimal',
      'M-13b ★**一侧无质量分**（存量行）⇒ 这一对**不比质量**（"没记过账"≠"低分"，承 zx_20260928 M5 弃权纪律）'
      + '⇒ 回退成功率（并列）→ 成本 ⇒ 便宜者胜。若把未知当 0 分，92 会一边倒地赢——那是**凭空造事实**',
    );
  }

  // ── 阶梯两侧端点（升/降都不越界） ──
  eq([stepUpTier('cost-optimal'), stepUpTier('capability-best'), stepDownTier('cost-optimal'), stepDownTier('capability-best')],
    ['balanced', 'capability-best', 'cost-optimal', 'balanced'],
    'M-14 升/降档**封顶与触底**：两端原值返回（不越界、不造出第四档）');
  ok(MODEL_TIER_LADDER.length === 3 && stepUpTier('balanced') === 'capability-best' && stepDownTier('balanced') === 'cost-optimal',
    'M-15 阶梯**同集同序**（与 `task-archetype.ts` 的 `modelOrder` 一把尺）：三档、中间档双向各走一步');
}

// ══════════════════════════════════════════════════════════════════
// 【C】M33-a · 自愈对策（复发 ⇒ 一条具体对策，且作用到行为）
// ══════════════════════════════════════════════════════════════════
function groupC(): void {
  console.log('\n【C】M33-a · 自愈对策（靶心：熔断此前只写一句"需人工排查"就结束，没告诉人该动哪里）');

  // ── ① 对策表（纯函数，两侧标本） ──
  const cmTimeout = proposeCountermeasure({ anomaly: '任务执行超时', count: 3 });
  eq([cmTimeout.kind, cmTimeout.hours], ['strategy_breaker', STRATEGY_BREAKER_HOURS],
    'C-1 ★`任务执行超时` 反复 ⇒ 对策＝**冻结该项目策略升档**（`strategy_breaker`）——'
    + '这是**能直接作用到行为**的那一类（`adjustProjectStrategy` 读它）');
  ok(cmTimeout.text.includes('只降不升') && cmTimeout.text.includes('3'),
    'C-1b 对策文案**自带依据**（次数与处置），不是一句"请排查"',
    cmTimeout.text);

  const cmDaemon = proposeCountermeasure({ anomaly: '守护进程无心跳', count: 4 });
  eq([cmDaemon.kind, cmDaemon.proposal?.kind, cmDaemon.proposal?.target, cmDaemon.proposal?.payload],
    ['proposal', 'threshold', DAEMON_STALE_MINUTES_SETTING_KEY, { current: DAEMON_STALE_MINUTES_CURRENT, suggested: DAEMON_STALE_MINUTES_SUGGESTED }],
    'C-2 ★`守护进程无心跳` 反复 ⇒ 对策＝**阈值调整提案**（改全局阈值＝改引擎行为 ⇒ **不得自动生效**，'
    + '投 `pending` 进人工闸）——这一类与 C-1 **刻意走两条不同的路**');
  ok(cmDaemon.hours === undefined,
    'C-2b 提案类**不带** `hours`（它不是项目级熔断，不该被 `applyCountermeasure` 当熔断处理）');

  eq(proposeCountermeasure({ anomaly: '作业运行超时', count: 5 }).kind, 'none',
    'C-3 反标本一：`作业运行超时` 无内置对策（多由上游任务超时连带，随任务侧处置即可；'
    + '另立一件只会让人以为"还有第二处要改"）');
  const cmUnknown = proposeCountermeasure({ anomaly: '某个从没见过的异常', count: 9 });
  ok(cmUnknown.kind === 'none' && cmUnknown.text.includes('无内置对策') && cmUnknown.text.includes('某个从没见过的异常'),
    'C-4 ★反标本二：**未知异常如实说"无现成对策，转人工"**——不编一条看起来像对策的话（如实优先于好看）',
    cmUnknown.text);

  // ── ② 熔断判据可注入 `nowMs`（不依赖真实墙钟，G-4） ──
  {
    const NOW = 1_700_000_000_000;
    const live = { until: new Date(NOW + 3600_000).toISOString(), anomaly: 'a', count: 3 };
    const dead = { until: new Date(NOW - 3600_000).toISOString(), anomaly: 'a', count: 3 };
    eq([isStrategyBreakerActive(live, NOW), isStrategyBreakerActive(dead, NOW), isStrategyBreakerActive(null, NOW), isStrategyBreakerActive(undefined, NOW)],
      [true, false, false, false],
      'C-5 ★熔断判活**两侧标本**（`nowMs` 注入，不读墙钟）：未到期⇒真、已到期⇒假且**自动解除**（无需人来清）、'
      + '未设⇒假。⏱ 基准是 **ISO-8601 UTC**，与库内 `datetime(\'now\')` 同基准');
    eq(isStrategyBreakerActive({ until: 'not-a-date', anomaly: 'a', count: 3 }, NOW), false,
      'C-5b 坏 `until` 不作数：解析不出来一律当**未生效**（fail-closed——不许因坏数据而误冻项目）');
  }

  // ── ③ 熔断支：3 次 ⇒ 有对策 + `strategy_breaker` 落库 + 升档被止（正标本） ──
  {
    const db = fdb();
    mkProject(db, 'P1', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } });
    mkTask(db, 't1', 'P1');
    eq([logCount(db), listProposals(db).length], [0, 0], 'C-6 起手**两本账都为空**（下面 0→N 才是正面断言，G-3）');

    // 同异常 24h 内先有 3 笔
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome) VALUES (?, '任务执行超时', 'seed', 0, 'recorded')").run(`seed-${i}`);
    }
    let called = false;
    const r = tryHeal(db as never, 't1', '任务执行超时', '自动暂停', () => { called = true; return 'healed'; }, 'target: t1');

    const l = lastLog(db, '任务执行超时');
    eq([r, l?.outcome, l?.success, l?.action], ['skipped_alarm', 'skipped_alarm', 0, 'ALARM_SKIPPED'],
      'C-7 ★熔断**结果态不变**：仍是 `skipped_alarm`（这一路确实没动手）——'
      + '对策是"接下来该动哪里"，与"本次有没有动手"**是两件事**（一个用途一个词，不改既有词表）');
    eq(called, false, 'C-8 熔断支**真的没调 healFn**（该不动的一步都没动）');
    ok(!!l?.detail && l.detail.includes('对策：') && l.detail.includes('只降不升'),
      'C-9 ★★**对策进了账**：`skipped_alarm` 的 detail 里带着具体对策原文——'
      + '改前这一行只到"需人工排查"就断了（这就是靶心），界面上看得见"该动哪里"',
      l?.detail ?? '(none)');

    const b = ctxOf(db, 'P1').strategy_breaker as { until: string; anomaly: string; count: number } | undefined;
    ok(!!b && b.anomaly === '任务执行超时' && b.count === 3 && Date.parse(b.until) > Date.now(),
      'C-10 ★★对策**落到了行为**：`wa_projects.context_json.strategy_breaker` 已写入（王阳明·知行合一——'
      + '不是"给了一句建议"就算完，载体必须接上）',
      JSON.stringify(b));

    // 同一异常再来一轮：熔断支每轮都命中 ⇒ 熔断**续期**、但**不重复记账**
    const before = logCount(db);
    tryHeal(db as never, 't1', '任务执行超时', '自动暂停', () => 'healed', 'target: t1');
    eq(logCount(db), before + 1, 'C-11 第二笔熔断**照记**（每轮熔断都是独立事实，账要留痕）');
    eq(readActiveStrategyBreaker(db as never, 'P1')?.anomaly, '任务执行超时', 'C-11b 熔断仍生效（续期语义：以最新一次为准）');
  }

  // ── ④ 反标本：仅 1 次 ⇒ **不产对策、不写熔断**（不误伤） ──
  {
    const db = fdb();
    mkProject(db, 'P2', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } });
    mkTask(db, 't2', 'P2');
    db.prepare("INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome) VALUES ('s0', '任务执行超时', 'seed', 0, 'recorded')").run();

    const r = tryHeal(db as never, 't2', '任务执行超时', '自动暂停', () => 'healed', 'target: t2');
    eq(r, 'pending_recheck', 'C-12 ★反标本：只 1 次（未达阈值）⇒ 走**正常自愈路**（`pending_recheck`），不是熔断');
    eq(ctxOf(db, 'P2').strategy_breaker, undefined,
      'C-13 ★★**不写** `strategy_breaker`：正常执行的项目**不得**被误冻（只熔一次就冻结全部项目＝把阈值判成摆设）');
    eq(listProposals(db).length, 0, 'C-14 ★也**不产**提案：正常路线上不该往人工闸里塞东西');
  }

  // ── ⑤ 提案类对策：**以 `pending` 进台账**，且同一目标**不重复记账** ──
  {
    const db = fdb();
    mkProject(db, 'P3');
    mkDaemon(db, 'd3', 'P3');
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome) VALUES (?, '守护进程无心跳', 'seed', 0, 'recorded')").run(`dseed-${i}`);
    }
    eq(listProposals(db).length, 0, 'C-15 起手台账空（0→1 正面断言）');

    tryHeal(db as never, 'd3', '守护进程无心跳', '标记为stale', () => 'healed', 'target: d3');
    const rows = listProposals(db);
    eq([rows.length, rows[0]?.kind, rows[0]?.target, rows[0]?.status], [1, 'threshold', DAEMON_STALE_MINUTES_SETTING_KEY, 'pending'],
      'C-16 ★★`守护进程无心跳` 对策**以 `pending` 进台账**（M34 台账的**第一个真生产者**——'
      + '承「不为 M34 造空壳」纪律：台账建好就必须有真东西进来）');
    eq(JSON.parse(rows[0]!.payload_json ?? '{}'), { current: DAEMON_STALE_MINUTES_CURRENT, suggested: DAEMON_STALE_MINUTES_SUGGESTED },
      'C-17 提案体带**现值与建议值**（人工闸上看得到"从多少改到多少"，不是一句"请调阈值"）');
    eq(rows[0]?.source, 'self_healing:守护进程无心跳', 'C-18 来源可溯：这条提案是自愈那一路产的（不是凭空出现的）');

    // 熔断支每 10 分钟都会再命中一次 ⇒ 必须**去重**，否则人工闸被噪声淹没
    tryHeal(db as never, 'd3', '守护进程无心跳', '标记为stale', () => 'healed', 'target: d3');
    eq(listProposals(db).length, 1,
      'C-19 ★★**同一目标不重复记账**：自愈扫描每 10 分钟一跳、熔断每轮都命中，'
      + '若每轮都投一条，十条一屏全是同一件事（"狼来了"）——人工闸会被自己的噪声淹没');
  }

  // ── ⑥ 对策**作用到行为**：熔断生效期 `adjustProjectStrategy` 只降不升 ──
  {
    const db = fdb();
    mkProject(db, 'P4', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.7, maxSteps: 15 } });
    setStrategyBreaker(db as never, { projectId: 'P4', anomaly: '任务执行超时', count: 3 });

    // 失败本该升档（M-4：failed ⇒ step_up）——但熔断生效中，升档被止
    const out = adjustProjectStrategy(db as never, 'P4', M({ projectId: 'P4', status: 'failed' }));
    eq((out as unknown as { modelStrategy?: string } | null)?.modelStrategy, 'balanced',
      'C-20 ★★**熔断生效期不升档**：失败本该 balanced → capability-best，此刻**保持 balanced**——'
      + '这条正是"对策落到行为"的判据（只写进 `context_json` 而不被读，就等于没接线）');
    const adjs = (ctxOf(db, 'P4').strategy_adjustments as Array<{ adjustments: string[] }>).at(-1)?.adjustments ?? [];
    ok(adjs.some((s) => s.includes('策略熔断生效中') && s.includes('暂不升')),
      'C-21 ★被压下的"升"**如实记账**（不许静默）：人工排查时看得见"本该升、因熔断未升"',
      JSON.stringify(adjs));
    ok(adjs.some((s) => s.includes('任务执行超时')),
      'C-21b 记账里带**是哪一类异常**触发的熔断（可追溯）');

    // 连续高质量完成**攒满** ⇒ 降档照放行（"只降不升"，降不是被冻的那一半）
    mkProject(db, 'P5', { learned_strategy: { modelStrategy: 'capability-best', temperature: 0.7, maxSteps: 15 }, learned_strategy_success_streak: 2 });
    setStrategyBreaker(db as never, { projectId: 'P5', anomaly: '任务执行超时', count: 3 });
    const out5 = adjustProjectStrategy(db as never, 'P5', M({ projectId: 'P5', status: 'completed', qualityScore: 95 }));
    eq((out5 as unknown as { modelStrategy?: string } | null)?.modelStrategy, 'balanced',
      'C-22 ★★**"只降不升"的后半句**：降档**照常放行**（capability-best → balanced）——'
      + '若把"冻结"实现成"什么都别动"，反复超时的项目就会永远钉在最贵的档上，正好是我们要治的病');

    // 步数配额与 temperature 上调同样被止
    const db2 = fdb();
    mkProject(db2, 'P6', { learned_strategy: { modelStrategy: 'balanced', temperature: 0.5, maxSteps: 15 } });
    setStrategyBreaker(db2 as never, { projectId: 'P6', anomaly: '守护进程无心跳', count: 3 });
    adjustProjectStrategy(db2 as never, 'P6', M({ projectId: 'P6', status: 'completed', qualityScore: 95, stepsUsed: 14, maxSteps: 15 }));
    eq(ctxOf(db2, 'P6').learned_strategy, { modelStrategy: 'balanced', temperature: 0.5, maxSteps: 15 },
      'C-23 ★另两处"升"也一并被止：`maxSteps` 不加（14/15 已 >80%）、temperature 不上调（高效完成那条）——'
      + '否则熔断只堵住模型档一条，配额仍会一路爬升');
  }

  // ── ⑦ 目标解析（对策要知道"这是哪个项目的事"） ──
  {
    const db = fdb();
    mkProject(db, 'P7');
    mkTask(db, 't7', 'P7');
    mkDaemon(db, 'd7', 'P7');
    eq([resolveProjectIdForTarget(db as never, 't7'), resolveProjectIdForTarget(db as never, 'd7'), resolveProjectIdForTarget(db as never, 'P7')],
      ['P7', 'P7', 'P7'],
      'C-24 任务 / 成果 / 项目 三种目标**都能解析到项目**（三条查路各命中一次）');
    eq(resolveProjectIdForTarget(db as never, '不存在的 id'), null,
      'C-25 ★查不到一律 `null`——**不猜**、不退回第一条项目（猜错＝冻了无辜的项目）');
  }

  // ── ⑧ 落点说明如实（"做了什么"要看得见，不能只回一句"已给对策"） ──
  {
    const db = fdb();
    mkProject(db, 'P8');
    mkTask(db, 't8', 'P8');
    const landed = applyCountermeasure(db, { countermeasure: proposeCountermeasure({ anomaly: '任务执行超时', count: 3 }), targetId: 't8', anomaly: '任务执行超时', count: 3 });
    ok(landed.includes('已作用到行为') && landed.includes('P8'),
      'C-26 ★落点说明带**具体落点**（项目 id 与冻结截止）——不是一句"已给对策"（那又是"说了等于没说"）',
      landed);
    // 目标解析不到项目 ⇒ 如实说"未落到行为"，不假装成功
    const landed2 = applyCountermeasure(db, { countermeasure: proposeCountermeasure({ anomaly: '任务执行超时', count: 3 }), targetId: '飞来的 id', anomaly: '任务执行超时', count: 3 });
    ok(landed2.startsWith('未落到行为'),
      'C-27 ★★**落不下去就如实回**（`未落到行为：…`）——把"没做成"说成"已处置"正是本仓反复治过的假成功',
      landed2);
  }

  // ── ⑨ 静态接线：对策在**生产调用点**真的被调用（只建函数不接 = 全量照样绿，承 feedback_equivalence_needs_wiring_criterion）──
  {
    // G-5：静态判据读**去注释后仍保留行号**的代码（注释不能发请求，也调不了函数）。
    const stripped = stripKeepingLines(RD(`${A}/src/main/core/self-healing-monitor.ts`)).join('\n');
    ok(/proposeCountermeasure\s*\(/.test(stripped) && /applyCountermeasure\s*\(/.test(stripped),
      'C-28 ★两个具名函数在生产源码里**都被调用**（不是只导出等着别人用）');
    const breakerBranch = stripped.slice(stripped.indexOf('count24h.c >= 3'));
    ok(breakerBranch.includes('proposeCountermeasure(') && breakerBranch.includes('applyCountermeasure('),
      'C-29 ★★**接在熔断支那一跳上**：`count24h.c >= 3` 之后的分支体内确实调了这两个函数——'
      + '按语句形状钉（不按行号），熔断支挪位置也不假红/假绿（承 feedback_criteria_must_be_satisfiable 的锚点纪律）');
    const fb = stripKeepingLines(RD(`${A}/src/main/core/feedback-engine.ts`)).join('\n');
    const adjBody = fb.slice(fb.indexOf('export function adjustProjectStrategy'), fb.indexOf('export function recordStrategyOutcome'));
    ok(adjBody.includes('readActiveStrategyBreaker('),
      'C-30 ★★`adjustProjectStrategy` **读**熔断（写而不读＝对策没接线）——'
      + '两侧都要有：C-10 判"写得进"，本条判"有人读"');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【D】M33-b · 子任务四因（目的因必填；判据须能被合法数据满足）
// ══════════════════════════════════════════════════════════════════
async function groupD(): Promise<void> {
  console.log('\n【D】M33-b · 子任务四因（靶心：拆出来的子任务只有"做什么/等谁"，没有"为什么有它"）');

  // ── ① 词表一处真源（改值即红） ──
  eq(FOUR_CAUSES, ['material', 'formal', 'efficient', 'final'],
    'D-1 ★四因词表**一处真源**且**同集同序**（质料→形式→动力→目的）——main 与 renderer 引同一份，不各写一遍');
  ok(FOUR_CAUSES.every((c) => (FOUR_CAUSE_LABEL[c] ?? '').length > 0),
    'D-1b 每一因都有**人话标签**（renderer 直接取用，不另立第二份词表）',
    FOUR_CAUSES.map((c) => FOUR_CAUSE_LABEL[c]).join(' / '));

  // ── ② `hasFinalCause` 三态：有内容 / 空串 / 空白 / 缺键 / 非字符串 ──
  eq(
    [hasFinalCause({ purpose: '服务于父目标' }), hasFinalCause({ purpose: '' }), hasFinalCause({ purpose: '   ' }),
      hasFinalCause({}), hasFinalCause(null), hasFinalCause(undefined)],
    [true, false, false, false, false, false],
    'D-2 ★★`hasFinalCause` **两侧标本**：有内容⇒真；**空串/纯空白/缺键**一律假——'
    + '"必填"落不到空白串上（与 `title` 那道门同一把尺）');
  eq(hasFinalCause({ purpose: 123 as unknown as string }), false,
    'D-2b 非字符串的 `purpose`（模型偶发把数字塞进来）不作数——不把 `123` 当"写过了"');

  // ── ③ 四因视图：tri-state「判不了 ≠ 缺失」（承 zx_20261011 现实闸三态） ──
  const full = fourCauseOf({
    acceptance_criteria: '服务能在 :8080 响应 200',
    purpose: '让后续步骤有可运行的目标',
    dependsOn: [1],
  });
  eq(full.map((v) => v.cause), ['material', 'formal', 'efficient', 'final'],
    'D-3 视图**按词表同序**逐项给出（不重排、不增删）');
  eq(full.map((v) => v.state), ['runtime', 'carried', 'carried', 'carried'],
    'D-4 ★★四因俱全 ⇒ 除质料因外**全 `carried`**；质料因恒 `runtime`（执行者/模型档由运行期派生，'
    + '模板里根本没有这一格）——**不是 `missing`**：判不了不等于缺失');

  const bare = fourCauseOf({ acceptance_criteria: '', purpose: '', dependsOn: [] });
  eq(bare.map((v) => v.state), ['runtime', 'missing', 'runtime', 'missing'],
    'D-5 ★★反标本：形式因空串、目的因空 ⇒ **`missing`**（本该写着却空着）；'
    + '而**无前置的动力因是 `runtime`**（"独立子任务、启动即放行"是**合法值**，不是缺口）——'
    + '若把无前置判成 `missing`，每个独立子任务都会被误报"缺动力因"，判据沦为噪声');

  // ── ④ 解析口：`purpose` 是**第四道门**（拒的是条目，不是整条拆解） ──
  const T = (title: string, purpose?: string) => ({
    title, description: `${title} 的执行内容`, acceptance_criteria: `${title} 通过`,
    ...(purpose !== undefined ? { purpose } : {}),
  });
  const reply = (items: Array<Record<string, unknown>>) => JSON.stringify(items);

  //   ⚠ 标本里的 title **必须 ≥2 字**：`parseDecomposition` 本就有一道 `title.length > 1` 的闸。
  //     用单字标题（'甲'/'乙'/'丙'）会被**那道闸**滤掉 ⟹ purpose 那道门根本没被考到，
  //     而 `[]` 与 `[]` 相比又是绿的（自我印证）——夹具比生产宽松，断言就只是在自我印证。
  const mixed = parseDecomposition(reply([T('甲项', '目的甲'), T('乙项'), T('丙项', '目的丙')]), '父目标');
  eq(mixed.map((t) => t.title), ['甲项', '丙项'],
    'D-6 ★★正标本：3 条回话中**1 条缺 purpose**（`乙项`）⇒ 只落 2 条，被拒的**只是这一条**，'
    + '同批其余照建（"少建"不是"不建"）');
  eq(mixed.map((t) => t.purpose), ['目的甲', '目的丙'], 'D-6b 通过者的 `purpose` **逐条原样**带出');

  eq(parseDecomposition(reply([T('甲项', '目的甲'), T('乙项', '目的乙'), T('丙项', '目的丙')]), '父目标').length, 3,
    'D-7 ★反标本：四因俱全（都写了 purpose）⇒ **全数通过**（不误伤）——两侧标本都在，'
    + '任何"一刀切拒收"或"一刀切放行"的变体都过不了');

  eq(parseDecomposition(reply([T('甲项', '目的甲'), T('乙项'), T('丙项')]), '父目标'), [],
    `D-8 ★★边界：3 条中 **2 条缺** ⇒ 只剩 1 条 < \`DECOMPOSE_MIN_SUBTASKS\`（${DECOMPOSE_MIN_SUBTASKS}）`
    + '⇒ 走既有 `[]` 路（单任务照跑、不阻断）——第四道门与"至少 2 个"那道门**串联**，不是各自为政');
  eq(parseDecomposition(reply([T('丁项'), T('戊项', '目的戊'), T('己项', '目的己')]), '父目标').length, 2,
    'D-8b ★反证**同一形状的回话**：3 条里**只 1 条缺** ⇒ 剩 2 条 ≥ 下界 ⇒ **不返回 `[]`**——'
    + '与 D-8 是一对（同为"3 条回话"，差别只在缺几条），证明走的是**下界**，不是"见缺即空"');

  eq(parseDecomposition(reply([T('甲项', ''), T('乙项', '   '), T('丙项', '目的丙'), T('丁项', '目的丁')]), '父目标').map((t) => t.title),
    ['丙项', '丁项'],
    'D-9 空白串与缺键**等价**（都算没写）：`\'\'` 与 `\'   \'` 两条都拒，剩下两条照过——'
    + '与 D-2 同一把尺（且剩余 2 条 ≥ 下界 ⇒ 本条判的是"谁被滤掉"，不是 D-8 的下界）');

  // ── ⑤ 落行：purpose 进 `context_json.$.purpose`；**无 purpose 则不写该键**（不编空串冒充） ──
  {
    const db = fdb();
    mkProject(db, 'DP');
    mkTask(db, 'dp-parent', 'DP');
    const r = planSubtasksFromTemplate(db as never, {
      parentTaskId: 'dp-parent', projectId: 'DP', depth: 0, source: 'auto-decompose',
      template: [
        { title: '有目的', description: 'd1', acceptance_criteria: 'a1', purpose: '为父目标产出主体' },
        { title: '无目的', description: 'd2', acceptance_criteria: 'a2' },
      ],
    });
    eq([r.created, r.planned], [2, 2], 'D-10 落行计数：`created === planned === 2`（本轮两数同值，非偶然）');
    const kids = db.prepare("SELECT title, context_json FROM wa_tasks WHERE parent_task_id = 'dp-parent'").all() as Array<{ title: string; context_json: string }>;
    const ctxOfTitle = (t: string) => JSON.parse(kids.find((x) => x.title === t)!.context_json) as Record<string, unknown>;
    eq(ctxOfTitle('有目的').purpose, '为父目标产出主体',
      'D-11 ★★目的因**真的落进了子任务 context**（`$.purpose`）——详情页读的就是它（写而不读＝没接线）');
    ok(!('purpose' in ctxOfTitle('无目的')),
      'D-12 ★★**无 purpose 则 `context_json` 不写该键**——不编一个空串冒充"目的已标注"'
      + '（缺键 ≠ 坏值；GUI 模板路/内置模板不走解析口，正落在这条上）',
      JSON.stringify(ctxOfTitle('无目的')));
  }

  // ── ⑥ 端到端：真 `autoDecomposeForTask` + 桩依赖 ⇒ 会话流那行**报的是实建数** ──
  const stubDeps = (text: string): DecomposeDeps => ({
    resolveModel: async () => ({ url: 'http://stub.invalid', api_key: 'k' }),
    chat: async () => ({ ok: true as const, text }),
  });
  const GOAL = '把服务从零跑起来';
  const mkAuto = (db: AnyDb, tid: string, text: string) => autoDecomposeForTask({
    db: db as never, taskId: tid, projectId: tid.split('-')[0] ?? '', goal: GOAL,
    depth: 0, getDeps: async () => stubDeps(text), label: '任务启动', noDepWhen: '立即启动',
  });
  const convOf = (db: AnyDb, tid: string): string =>
    ((db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system' ORDER BY rowid DESC LIMIT 1").get(tid) as { content?: string } | undefined)?.content) ?? '';

  {
    // 正标本：模型回话写了 3 条，其中 1 条缺 purpose
    const db = fdb();
    mkProject(db, 'DZ');
    mkTask(db, 'DZ-parent', 'DZ');
    const r1 = await mkAuto(db, 'DZ-parent',
      reply([T('克隆仓库', '让后续步骤有代码可改'), T('安装依赖'), T('启动服务', '验证改动可运行')]));
    ok(r1?.created === 2 && r1?.planned === 2,
      'D-13 ★★端到端正标本：回话 3 条、1 条缺 purpose ⇒ 实建 **2**（`created`/`planned` 都是 2）',
      JSON.stringify(r1));
    ok(convOf(db, 'DZ-parent').includes('已自动拆分为2个子任务') && !convOf(db, 'DZ-parent').includes('已自动拆分为3'),
      'D-14 ★★**会话流那行报的是实建数**（"已自动拆分为2个子任务"）：模型回话里写的是 3 条，'
      + '但只有 2 条带 purpose ⇒ 报 2——**报"模型说要拆几个"＝把计划当成事实**（本仓反复治过的病）',
      convOf(db, 'DZ-parent'));
    const kids = db.prepare("SELECT context_json FROM wa_tasks WHERE parent_task_id = 'DZ-parent'").all() as Array<{ context_json: string }>;
    eq(kids.length, 2, 'D-15 端到端**真落了 2 行**子任务（不只是回话好看：库里数得出来）');
    ok(kids.every((k) => typeof (JSON.parse(k.context_json) as { purpose?: unknown }).purpose === 'string'),
      'D-16 每行都带 `$.purpose`（正标本里被留下的两条）', JSON.stringify(kids.map((k) => JSON.parse(k.context_json))));
    eq((db.prepare("SELECT status FROM wa_tasks WHERE id = 'DZ-parent'").get() as { status: string }).status, 'pending',
      'D-17 `autoDecomposeForTask` **不写父任务状态**（计划模式/启动路各有各的状态出口）——只建子、不越权');

    // 边界：回话 3 条但只 1 条带 purpose ⇒ 解析不足下界 ⇒ 整条拆解退场
    const db3 = fdb();
    mkProject(db3, 'DZ3');
    mkTask(db3, 'DZ3-parent', 'DZ3');
    const r3 = await mkAuto(db3, 'DZ3-parent', reply([T('甲', '目的甲'), T('乙'), T('丙')]));
    eq(r3, null, 'D-18 ★边界端到端：回话 3 条但仅 1 条带 purpose ⇒ 解析不足下界 ⇒ **返回 null**'
      + '（不建子任务、父按单任务照跑——"少到不成拆"与"拆得成"是两件事）');
    eq((db3.prepare("SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = 'DZ3-parent'").get() as { c: number }).c, 0,
      'D-19 ★且**不产** `[智能拆解]` 行——不假装拆过（`null` ≠ "拆了 0 个"）');
  }

  {
    // 反标本端到端：四因俱全 ⇒ 实建 3、报 3（不误伤）
    const db2 = fdb();
    mkProject(db2, 'DZ2');
    mkTask(db2, 'DZ2-parent', 'DZ2');
    const r2 = await mkAuto(db2, 'DZ2-parent',
      reply([T('克隆仓库', '让后续步骤有代码可改'), T('安装依赖', '让服务能跑起来'), T('启动服务', '验证改动可运行')]));
    ok(r2?.created === 3 && r2?.planned === 3,
      'D-20 ★反标本端到端：四因俱全 ⇒ 实建 3（与 D-13 配对：该拒的拒、该全建的全建）', JSON.stringify(r2));
    ok(convOf(db2, 'DZ2-parent').includes('已自动拆分为3个子任务'),
      'D-21 反标本的会话行报 3 —— 与 D-14 是一对尺的两侧', convOf(db2, 'DZ2-parent'));
  }

  // ── ⑦ 静态接线：提示词同步 / 解析口引判据真源 / 落行侧按条件写 / detail 页消费 ──
  {
    const dec = stripKeepingLines(RD(`${A}/src/main/core/task-decompose.ts`)).join('\n');

    // 类型：模板带 `purpose?:`，且**不假装模板承载质料因**
    const iface = dec.slice(dec.indexOf('export interface DecompositionTemplate'),
      dec.indexOf('}', dec.indexOf('export interface DecompositionTemplate')));
    ok(/purpose\??:\s*string/.test(iface),
      'D-22 ★模板类型带 `purpose`（四因·目的因是模板条目承载得住的）', iface.replace(/\s+/g, ' ').trim());
    ok(!/archetype|modelStrategy/.test(iface),
      'D-23 ★★模板**不含** `archetype` / `modelStrategy`：质料因由运行期派生，模板里没有这一格——'
      + '不为了"四因都在模板里"而虚构字段（名实相符）');

    // 提示词：新增行/新增要求**只在末尾追加**，既有行逐字仍在
    const promptBody = dec.slice(dec.indexOf('export function buildDecomposePrompt'), dec.indexOf('export function parseDecomposition'));
    ok(promptBody.includes('- title: 子任务标题') && promptBody.includes('- description: 子任务描述')
      && promptBody.includes('- acceptance_criteria: 验收标准') && promptBody.includes('- dependsOn: 前置子任务的序号数组'),
      'D-24 提示词**既有四行逐字仍在**（改的是"加一行"，不是"重写提示词"）');
    ok(promptBody.includes('- purpose:'), 'D-25 ★提示词新增 `- purpose:` 字段行（模型看得见要写什么）——这是"想让人写"的唯一出口');
    ok(promptBody.indexOf('- purpose:') > promptBody.indexOf('- dependsOn:'),
      'D-26 新字段**接在 `dependsOn` 之后**（只在末尾追加，既有行序不变）');
    ok(/6\.\s*每个子任务\*\*必须\*\*写 purpose/.test(promptBody)
      && promptBody.indexOf('6. 每个子任务') > promptBody.indexOf('5. 若某子任务'),
      'D-27 ★★提示词新增**要求 6**（缺 purpose 不会被创建），且排在要求 5 之后（追加而非插队）');

    // 解析口：第四道门确由**判据真源**把守
    const parseBody = dec.slice(dec.indexOf('export function parseDecomposition'), dec.indexOf('export async function decomposeTask'));
    ok(parseBody.includes('hasFinalCause('),
      'D-28 ★★解析口的第四道门**引 `hasFinalCause`**（与 four-cause 视图同源）——'
      + '不在此手抄一份 `purpose !== \'\'`（判据的第二次实现，本仓反复治过）');

    // 落行侧：`$.purpose` 的写法按**语句形状**钉（不按行号）
    const planBody = dec.slice(dec.indexOf('export function planSubtasksFromTemplate'));
    ok(/\.\.\.\(opts\.template\[i\]!\.purpose\s*\?\s*\{\s*purpose:\s*opts\.template\[i\]!\.purpose\s*\}\s*:\s*\{\}\)/.test(planBody),
      'D-29 ★★落行侧**按条件展开**写 `purpose`（有才写、无则整键不写）——'
      + '若改成无条件 `purpose: opts.template[i]!.purpose`，无目的子任务会落一个 `undefined`/空串冒充"已标注"');

    // renderer 第二落点：详情页**消费**四因真源（否则"详情页可见"是空话）
    const page = stripKeepingLines(RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`)).join('\n');
    ok(page.includes('fourCauseOf('),
      'D-30 ★renderer **消费** `fourCauseOf`（跨 root 引 main/core 真源）——'
      + '只建函数不接＝全量照样绿（承 feedback_equivalence_needs_wiring_criterion）');
    ok(page.includes('子任务目的'),
      'D-31 ★★详情页有**用户可见的**「子任务目的」块（搜**中文串**不搜标识符——renderer 产物会被 minify）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【E】M34 · 受控自进化闸与边界（红线：**绝不**自动改源码）
// ══════════════════════════════════════════════════════════════════
function groupE(): void {
  console.log('\n【E】M34 · 受控自进化闸与边界（靶心：源码改不动 · 不批不生效 · 生效可回滚）');

  // ── ① 红线守卫：两侧标本（源码树 ⇒ 拒 / 设置键 ⇒ 放行） ──
  {
    // 反证标本（方案 §批四点名的那一条，逐字用它）+ 各种绕行写法
    const forbidden: Array<[string, string]> = [
      ['apps/worker-ant-desktop/src/main/core/agent-executor.ts', '★方案点名的反证标本（真源码文件）'],
      ['apps', '裸目录段（无尾斜杠）'],
      ['packages/shared-types/src/nodes.ts', 'packages 树'],
      ['scripts/rr_zx_20261016_3.ts', '回归脚本自身也在红线内'],
      ['.github/workflows/ci.yml', 'CI 定义'],
      ['./apps/worker-ant-desktop/src/main/index.ts', '带 `./` 前缀（不得因前缀而漏网）'],
      ['AppS/worker-ant-desktop/src/main/index.ts', '★大写变体——macOS 卷大小写不敏感，`AppS/x` 就是 `apps/x`'],
      ['/Users/someone/works/worker-ant/apps/worker-ant-desktop/src/main/index.ts', '绝对路径（任一段命中即拒）'],
      ['src\\main\\core\\x.ts'.replace('src', 'scripts'), '反斜杠写法（Windows 分隔符）'],
    ];
    for (const [t, why] of forbidden) {
      const g = assertProposalTargetAllowed(t);
      ok(g.ok === false && g.reason === 'source_mutation_forbidden', `E-1 ★拒：${why}`, t);
    }
    // 正标本：本闸**允许**动的东西（设置键——"能改变引擎行为"但不碰源码）
    for (const t of [DAEMON_STALE_MINUTES_SETTING_KEY, 'policy.cascade_fail_threshold']) {
      const g = assertProposalTargetAllowed(t);
      ok(g.ok === true, `E-2 ★放行：设置键（本闸允许动的对象）`, t);
    }
    // 空目标：**换一个因由**，不与"改源码"混同一个词（一个用途一个词）
    const empty = assertProposalTargetAllowed('   ');
    ok(empty.ok === false && empty.reason === 'empty_target', 'E-3 空目标是 `empty_target`（不是 `source_mutation_forbidden`）',
      JSON.stringify(empty));
  }

  // ── ② 写口守卫：**落库前就拒**（不许先把"改源码"记进账再说） ──
  {
    const db = fdb();
    const bad = recordProposal(db, { kind: 'rule', target: 'apps/worker-ant-desktop/src/main/core/agent-executor.ts', note: '试图改源码' });
    eq(bad, { ok: false, reason: 'source_mutation_forbidden' }, 'E-4 ★★写口拒源码目标（返回因由）');
    eq(listProposals(db).length, 0, 'E-5 ★★而且**一行都没落**（"pending 也不许"——账本身就是一种承认）');

    const good = recordProposal(db, { kind: 'threshold', target: DAEMON_STALE_MINUTES_SETTING_KEY, payload: { current: 10, suggested: 15 }, source: 'test', note: '阈值放宽' });
    ok(good.ok === true, 'E-6 合法目标**落得下**（0→1 正面断言）', JSON.stringify(good));
    eq(listProposals(db).length, 1, 'E-7 ★台账由 0 变 1（不是"没抛就算过"）');
    const row = listProposals(db)[0]!;
    eq([row.kind, row.status, row.decided_at, row.rollback_point], ['threshold', 'pending', null, null],
      'E-8 新账恒为 `pending` 且**无回滚点**（未生效者不该有回滚点——那是有东西可回滚才有的）');

    ok(hasPendingProposalFor(db, DAEMON_STALE_MINUTES_SETTING_KEY) === true, 'E-9 去重谓词认得出"同目标已有待批"');
    ok(hasPendingProposalFor(db, 'policy.cascade_fail_threshold') === false, 'E-10 ★两侧：别的目标**不**被误判为已有待批');
  }

  // ── ③ 不批不生效 / 状态机不许"点了没反应但状态变了" ──
  {
    const db = fdb();
    const r = recordProposal(db, { kind: 'threshold', target: DAEMON_STALE_MINUTES_SETTING_KEY, payload: { current: 10, suggested: 15 }, note: 'n' });
    const id = (r as { ok: true; id: string }).id;
    const settingOf = (): number =>
      (db.prepare('SELECT COUNT(*) AS c FROM wa_settings WHERE key = ?').get(DAEMON_STALE_MINUTES_SETTING_KEY) as { c: number }).c;

    eq(settingOf(), 0, 'E-11 ★★**只是 pending 时，设置一行都没写**（提案≠生效）');
    eq(decideProposal(db, { id, decision: 'rollback' }), { ok: false, status: 'pending', reason: 'bad_state' },
      'E-12 ★未生效的**回滚不动**（`bad_state` 且**回带当下状态**——界面据此如实显示"没动过"）');
    eq(decideProposal(db, { id, decision: 'approve', by: 'u1' }).status, 'applied', 'E-13 ★人工批准 ⇒ 生效');
    eq(db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(DAEMON_STALE_MINUTES_SETTING_KEY),
      { value: '15' }, 'E-14 ★★`applied` 意味着**引擎行为真的变了**（设置键已写 15）');
    const applied = listProposals(db)[0]!;
    eq([applied.status, applied.decided_by], ['applied', 'u1'], 'E-15 生效留痕：状态 + 谁批的');
    eq(JSON.parse(applied.rollback_point || '{}'), { setting_key: DAEMON_STALE_MINUTES_SETTING_KEY, previous: null },
      'E-16 ★回滚点存的是**旧值本身**（此处"本来没设过"⇒ `previous: null`，不是补一个默认值）');
    eq(decideProposal(db, { id, decision: 'approve' }).reason, 'bad_state', 'E-17 ★已生效的**不能重复应用**');
    eq(decideProposal(db, { id, decision: 'reject' }),
      { ok: false, status: 'applied', reason: 'bad_state' },
      'E-18 ★已生效的**拒不动**（`bad_state` 且**回带当下状态 `applied`**——拒绝是给"待批"用的）');
  }

  // ── ④ 回滚：恢复旧值 + 留痕不删（两侧：旧值"没有"与"有"） ──
  {
    const db = fdb();
    const K = DAEMON_STALE_MINUTES_SETTING_KEY;
    const r = recordProposal(db, { kind: 'threshold', target: K, payload: { current: 10, suggested: 15 }, note: 'n' });
    const id = (r as { ok: true; id: string }).id;
    decideProposal(db, { id, decision: 'approve' });
    const rb = decideProposal(db, { id, decision: 'rollback' });
    eq(rb.status, 'rolled_back', 'E-19 回滚动作生效');
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_settings WHERE key = ?').get(K) as { c: number }).c, 0,
      'E-20 ★★旧值"没设过" ⇒ 回滚**把键删掉**，恢复"未设置"——不是写回一个等价的 10（"没设过"与"等于 10"在账上不是一回事）');
    eq(listProposals(db).length, 1, 'E-21 ★★留痕**不删**：回滚后账还在（append-only 的台账才谈得上"回头看")');
    const back = listProposals(db)[0]!;
    ok(back.status === 'rolled_back' && !!back.apply_result && !!back.decided_at,
      'E-22 回滚也留痕（状态 + 缘由 + 时刻齐）', back.apply_result ?? '');

    // 另一侧：旧值**存在**时须恢复**那个值**
    const db2 = fdb();
    db2.prepare("INSERT INTO wa_settings (key, value) VALUES (?, '7')").run(K);
    const r2 = recordProposal(db2, { kind: 'threshold', target: K, payload: { current: 10, suggested: 15 } }) as { ok: true; id: string };
    decideProposal(db2, { id: r2.id, decision: 'approve' });
    eq(db2.prepare('SELECT value FROM wa_settings WHERE key = ?').get(K), { value: '15' }, 'E-23 生效改掉了旧值');
    decideProposal(db2, { id: r2.id, decision: 'rollback' });
    eq(db2.prepare('SELECT value FROM wa_settings WHERE key = ?').get(K), { value: '7' },
      'E-24 ★★回滚恢复的是**原来那个值 7**（不是缺省 10、也不是删除）——"恢复旧值"须按旧值的**实际形态**恢复');
  }

  // ── ⑤ `decide` 处**再判一次**红线（写口被绕过时仍动不了） ──
  {
    const db = fdb();
    // 直插一行绕过 `recordProposal` 的守卫（模拟"守卫在写口、但有人从别处塞了行"）
    db.prepare(
      "INSERT INTO wa_self_evolve_proposals (id, kind, target, payload_json, status, note) VALUES ('sneaky', 'threshold', 'apps/worker-ant-desktop/src/main/core/agent-executor.ts', '{\"suggested\":\"1\"}', 'pending', '偷偷改源码')",
    ).run();
    const d = decideProposal(db, { id: 'sneaky', decision: 'approve' });
    eq(d, { ok: false, status: 'pending', reason: 'source_mutation_forbidden' },
      'E-25 ★★**decide 处同判据**：写口被绕过塞进来的源码目标，批也批不动（留 `pending` + 如实回因由）');

    // 但人工**可以**把它显式拒掉——"不许动"不等于"不许否决"
    eq(decideProposal(db, { id: 'sneaky', decision: 'reject' }).status, 'rejected',
      'E-26 ★拒得掉（红线拦的是"动"，不是"表态"）');
  }

  // ── ⑥ 无自动应用路径（静态读**去注释后的原文**） ──
  {
    const ev = stripKeepingLines(RD(`${A}/src/main/core/self-evolve.ts`)).join('\n');
    ok(!/setInterval|setTimeout/.test(ev),
      'E-27 ★★台账模块**无任何定时器**——没有"定时自动应用"这条路（红线：绝不自动改源码）');
    const calls = (ev.match(/applyProposal\s*\(/g) ?? []).length;
    ok(calls === 2, 'E-28 ★`applyProposal` 只此两处（声明 + `decideProposal` 内那一次调用）——'
      + '除人工闸外**无处可达**', `命中 ${calls} 处`);
    const decideBody = ev.slice(ev.indexOf('export function decideProposal'), ev.indexOf('/** 读提案'));
    ok(decideBody.includes("o.decision === 'approve'") && decideBody.indexOf('applyProposal(db, row)') > decideBody.indexOf("o.decision === 'approve'"),
      'E-29 ★应用那一跳**确实在 `approve` 分支内**（按语句形状钉，不按行号）');
    ok(decideBody.includes('assertProposalTargetAllowed('),
      'E-30 ★★`decide` 内**再判红线**（与写口两处同判据——只判一处，绕一处即全线失守）');

    eq([...PROPOSAL_DECISIONS], ['approve', 'reject', 'rollback'], 'E-31 决策词表三态（IPC 与面板同引此份）');
    eq([...SELF_EVOLVE_STATUSES], ['pending', 'approved', 'rejected', 'applied', 'rolled_back'],
      'E-32 状态词表五态（renderer 的观感表按它穷举，加态即类型报错）');
    eq([...SOURCE_TREE_PREFIXES], ['apps/', 'packages/', 'scripts/', '.github/'],
      'E-33 红线前缀表（改目录结构须同步此表——它是这条红线的唯一真源）');
  }

  // ── ⑦ 向前依赖的兑现（承批二 §五-2-8）：阈值提案**真的读到了行为里** ★本批最强一条 ──
  {
    // 读侧：现读现取 + 坏值不得把扫描打成两极
    const db = fdb();
    eq(readDaemonStaleMinutes(db), DAEMON_STALE_MINUTES_CURRENT, 'E-34 ★键不存在 ⇒ 取缺省 10');
    db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(DAEMON_STALE_MINUTES_SETTING_KEY, '15');
    eq(readDaemonStaleMinutes(db), 15, 'E-35 ★键存在 ⇒ 取键值（提案批准后即时生效，不必重启）');
    db.prepare('UPDATE wa_settings SET value = ? WHERE key = ?').run('abc', DAEMON_STALE_MINUTES_SETTING_KEY);
    eq(readDaemonStaleMinutes(db), DAEMON_STALE_MINUTES_CURRENT,
      'E-36 ★坏值（非数）⇒ 回缺省——不许把"读不动"变成"永远不判失联"');
    db.prepare('UPDATE wa_settings SET value = ? WHERE key = ?').run('-5', DAEMON_STALE_MINUTES_SETTING_KEY);
    eq(readDaemonStaleMinutes(db), DAEMON_STALE_MINUTES_CURRENT, 'E-37 ★负数（会令窗口反向）⇒ 回缺省');

    // 行为侧：**两侧标本**——同一只"12 分钟无心跳"的守护，阈值不同则结局相反
    const at = (minutesAgo: number): string =>
      (db.prepare(`SELECT datetime('now', '-${minutesAgo} minutes') AS t`).get() as { t: string }).t;
    const mk12 = (d: AnyDb) => { d.prepare("INSERT INTO wa_deliverables (id, type, name, status, updated_at) VALUES ('d1','daemon','守护一','running',?)").run(at(12)); };

    const dbA = fdb();
    mk12(dbA);
    runHealthScan(dbA);           // 阈值缺省 10 ⇒ 12 分钟算失联
    eq((dbA.prepare("SELECT status FROM wa_deliverables WHERE id='d1'").get() as { status: string }).status, 'stale',
      'E-38 ★★阈值 10（缺省）：12 分钟无心跳 ⇒ 被标 stale');

    const dbB = fdb();
    mk12(dbB);
    dbB.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(DAEMON_STALE_MINUTES_SETTING_KEY, '15');
    runHealthScan(dbB);           // 阈值 15 ⇒ 12 分钟在窗内，**不该动手**
    eq((dbB.prepare("SELECT status FROM wa_deliverables WHERE id='d1'").get() as { status: string }).status, 'running',
      'E-39 ★★阈值 15（提案生效后）：同一只守护**原样不动** —— '
      + '两格结局相反即证明"提案确实读进了行为"（写而不读＝一纸空文）');

    // 接线：SQL 里**不再写死** `-10 minutes`，且阈值是**参数**走的
    const mon = stripKeepingLines(RD(`${A}/src/main/core/self-healing-monitor.ts`)).join('\n');
    const scanBody = mon.slice(mon.indexOf('export function runHealthScan'));
    ok(!/datetime\('now',\s*'-10 minutes'\)/.test(scanBody),
      'E-40 ★★扫描 SQL 里**不再有写死的 `-10 minutes`**（写死则提案永远读不到）');
    ok(scanBody.includes("datetime('now', '-' || ? || ' minutes')"),
      'E-41 ★扫描 SQL 用**参数**承载阈值（`|| ? ||` 占位符——拼接值则阈值恒为字面量、提案读不到）');
    ok(scanBody.includes('readDaemonStaleMinutes('),
      'E-42 ★★`runHealthScan` 第 1 项**真引** `readDaemonStaleMinutes`（接线那一跳，按符号钉）');
  }

  // ── ⑧ 两端接线：IPC 单出口 + 面板第二落点 ──
  {
    const ipc = stripKeepingLines(RD(`${A}/src/main/ipc/admin.ipc.ts`)).join('\n');
    ok(ipc.includes("'selfEvolve:decide'"), 'E-43 ★动作 IPC `selfEvolve:decide` 在册');
    const diagBody = ipc.slice(ipc.indexOf("ipcMain.handle('admin:diagnostics'"));
    ok(diagBody.includes('proposals') && diagBody.includes('listProposals('),
      'E-44 ★★读面**并进唯一诊断出口**（`admin:diagnostics`）——不另开第二个读口（两个读口迟早各说各话）');
    ok(ipc.includes('decideProposal(db,') && ipc.includes('PROPOSAL_DECISIONS'),
      'E-45 ★IPC 只转发：判断全在 core（引 `decideProposal` 与决策词表真源，不在此手抄三态）');

    const lib = stripKeepingLines(RD(`${A}/renderer/src/lib/ipc.ts`)).join('\n');
    ok(lib.includes('PROPOSAL_DECISIONS') && lib.includes('selfEvolveDecide'),
      'E-46 ★renderer IPC 层引**词表真源**（`self-evolve.ts` 零运行期 import，正是为了 renderer 引得动）');

    const page = stripKeepingLines(RD(`${A}/renderer/src/pages/DashboardPage.tsx`)).join('\n');
    ok(page.includes('SELF_EVOLVE_STATUSES'),
      'E-47 ★★面板的观感表按 `SELF_EVOLVE_STATUSES` **穷举**（加一态即类型报错，不手抄一份会漂的清单）');
    for (const s of ['自产提案', '待批', '已生效', '已回滚']) {
      ok(page.includes(s), `E-48 ★面板有用户可见的「${s}」文案（搜**中文串**——renderer 产物会被 minify）`);
    }
    ok(page.includes("'approve'") && page.includes("'reject'") && page.includes("'rollback'"),
      'E-49 ★三个动作都接到了按钮上（`applied` 行才有回滚）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【S】哑雷自检 + build 钉（**派生核对，不写轮次字面量**）
// ══════════════════════════════════════════════════════════════════
function groupS(): void {
  console.log('\n【S】哑雷自检 + build 钉（靶心：判据自身不受"只为下一轮引爆"的字面量污染）');

  // ── ① 本文件零"轮次字面量"（G-6：写了就是给下一轮设哑雷） ──
  {
    const selfPath = `scripts/${path.basename(__filename)}`;
    // 与 `rr-pins.ts` 的 `PIN_RE` **同一形状**：`build: 'zx_…'` / `ROUND = 'zx_…'` / `includes('zx_…')`。
    const pinRe = /(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g;
    const code = stripKeepingLines(RD(selfPath)).join('\n');
    const pins = [...code.matchAll(pinRe)].map((m) => m[1]!);
    ok(pins.length === 0, 'S-1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）', pins.join(',') || '0 处');

    // ⚠ **等值比较**这一种（`eq(x, 'zx_…')` / `=== 'zx_…'` / `!== 'zx_…'`）——`PIN_RE` 认不出它，
    //   正是 `rr_zx_20260913` 那处哑雷躲过 P5 的语法外壳。本套件自带这一门，防自己复发。
    const eqLit = /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'(zx_\d{8}(?:_\d+)?)'/g;
    const eqPins = [...code.matchAll(eqLit)].map((m) => m[1]!);
    ok(eqPins.length === 0, 'S-2 本文件零"等值比较裸轮次字面量"', eqPins.join(',') || '0 处');

    // **反证**：把那行原形喂进 S-2 判据 ⇒ 必须命中（证明判据**在认**，不是恒真）
    const specimen = "eq(someRound, 'zx_20990101', 'x');";
    ok([...stripKeepingLines(specimen).join('\n').matchAll(eqLit)].length === 1,
      'S-2b ★反证：人造标本喂进等值判据 ⇒ 命中 1 处（判据非恒真）');
  }

  // ── ② 方向性自指（由载体自身派生，非抄来的常量） ──
  {
    ok(/^zx_\d{8}(_\d+)?$/.test(SELF_ROUND), 'S-3 ★轮次由 `path.basename(__filename)` **派生**（非字面量）', SELF_ROUND);
    ok(fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-4 本轮方案文件在场（轮次由载体派生）', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S-5 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);
  }

  // ── ③ build 钉（P1–P6 一把尺，多个 rr 脚本共用；**读 dist ⇒ tsup 必须先于本脚本**） ──
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  groupM();
  groupC();
  await groupD();
  groupE();

  groupS();

  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_${path.basename(__filename, '.ts').replace(/^rr_/, '')}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error(e); process.exit(1); });
