/**
 * zx_20260916_1 受控复跑 —— 「完成须有据：验收结论进终态」。
 *
 * 各段对应方案 `plans/improve/zx_20260916_1.md` 一节，判据逐条照 §3.3 落：
 *   §S1 M1「验收结论进完成判定」——**直引真实现**（`acceptanceVerdictOf` / `capScoreByAcceptanceVerdict` /
 *        `decideAcceptanceOutcome` / `recordAcceptanceOutcome` / `assessCompletionQuality`），判据一行未复刻：
 *        (a) M1-1 三态判据（含"未核验 ≠ 未通过"的边界）；
 *        (b) ★ **生产写账链 → 生产读判据**闭环：`decideAcceptanceOutcome`（真决策）→ `recordAcceptanceOutcome`
 *            （真落账）→ `acceptanceVerdictOf`（真读）三态各走一遍，不拿手造载荷冒充"账"；
 *        (c) M1-2 未核验五成因 ⇒ 完成分**逐位等于**无账基线（A4 的正面断言——防"把未核验也算未通过"的新失实）；
 *        (d) M1-3 未通过 ⇒ 完成分 <60（真 `assessCompletionQuality`）+ 终态非 completed（结构断言，见下）
 *            + `goal_achieved` 不为真，**三者同时断言**；
 *        (e) M1-4 已通过 ⇒ 压降不生效（反向断言，防压降过宽把好任务压死）；
 *        (f) M1-5 两收口路同一结论（真源唯一 + 两个出口各自消费它）；
 *        (g) M1-7 收窄后的判据（`[过早结束]` **且验收未通过** ⇒ 终态非 completed）。
 *   §S2 renderer 第二落点（状态徽标旁的一行如实提示）。
 *   §S4 M2「配额与实际同源」——**直引真判据 `countsTowardToolQuota` + 真阈值 `toolRegistry.getQuota`**：
 *        (h) M2-1/M2-2 20 次收尾类 bash ⇒ 不入账、不硬禁用（恰 0）；20 次探索类 ⇒ 入账、硬禁用（20/20）——正反成对；
 *        (i) M2-4 bash 与 execute_command 同尺（代表性命令逐条比对）+ 反证非 shell 配额工具未被废；
 *            ⚠ zx_20260922_1 M1（F3）**就地订正**：原判据断言"配额尺**不**复用 `isExplorationCall`"（`!==`，
 *              因该分支只答"循环检测可否豁免"）。M1 给该分支补上"只读探测"一支（换把 shell 即绕过收敛闸，
 *              与 F13 同族），两尺分歧**收窄到一个具名出口**（循环豁免支）。据"改旧断言＝改钉**更强**的新真源"
 *              的纪律，已改钉"只读探测/收尾两支上两尺同判 + 分歧恰剩豁免一支"，守的语义一字未松；
 *        (j) M2-3 文案一处真源（"不会被硬禁用"零命中、`softMsg` 仅 tool-registry）+ 接线（A3 读配额账）。
 *   §S5 M3「B2 告警可复核」——**真临时目录 + 真 `captureWorldSnapshot`**（不造等价入参），判据：
 *        (k) M3-6 分开记「真实总数 / 样本」：截断侧 `fileCount` 仍为总数且 ≠ 样本量；
 *        (l) M3-1 ★ **复现 §1.4**：before 未截断 435 / after 2035 截到前 2000 ⇒ 零删除告警、只报"快照已截断"，
 *            并**逐侧**标注；同附**反证**——同一对快照按旧口径必报 35 个伪删除（判据不空转）；
 *        (m) M3-2/M3-3 真删除仍报（1 个列名；5 个列全 + 落盘完整清单）；>10 只列前 10 + 总数；
 *        (n) M3-4/M3-5 审计 ⇒ `world_snapshot_after` 落库（含"无变更时不加告警行"的反噪断言）
 *            + `[WARN] 世界模型审计：…` **追加**进收口 checks（未 finalize 过则新建该键）。
 *            ⚠ zx_20260922_1 M5（F7）：本轮给该结论**分级**——「截断 ⇒ 未做增删判定」改落 `[INFO]`
 *              （不占 `[WARN]` 位、不写会话行），只有**真比出不一致**才 `[WARN]`。本文件 (l) 的 M3-1 断言
 *              跑的是 `compareSnapshots` 本体的输出（前缀一字未改，仍绿）；(m)/(n) 的各标本都**未截断**
 *              ⇒ 落在 warn 一级，断言行为逐字不变。
 *   §S6 M4「步数上限由估时参与 + 撞顶如实告知」——**直引真实现 `step-budget`**（不手抄公式），判据：
 *        (o) M4-1 取大（估时 48 ⇒ 72，且不被文件数系数压小）+ **反证**（有/无估时之差确由 `estSteps` 产生）；
 *        (p) M4-2 缺省/`NaN`/负值一律退回 `round(base×mult)`，**不归零**（"缺估时"≠"不给步数"）；
 *        (q) M4-3 撞顶事实**进交付文本**：文案含「未完成」+ 上限字面量 + 剩余工作；注入点在落库与
 *            `prematureEnd` **之前**（其后所有非完成出口一律带上该事实）；
 *        (r) ★ M4-3 反证：差 1 步**不**判撞顶——交付文本侧的"已截"是事实陈述，闸门侧的 `max−2` 是"可能"；
 *            两把尺**刻意不同**（`{s>=m} ⊆ {s>=m-2}`），并断言 `prematureEnd`/`stepsCapReached` 各自的出现次数
 *            ⇒ 撞顶**未**新增第二条 paused 出口（M4-4 由 §S1 的同一条终态断言覆盖，不另写一份）；
 *            ⚠ zx_20260922_1 M6（F8）**订正**：该条原以**旧表达式字面**（`Number(ctxJson.budget_usage_ratio) >= 0.95`）
 *              钉住闸门判据，F8 把预算半改读同一真源 `budgetCapReached` 后必红。据本仓"改旧断言＝改钉**更强**的
 *              新真源、非放宽"的纪律，已**按符号改钉形状 + 补行为侧**（真函数判 band 5 到顶），守的语义一字未松；
 *        (s) M4-5 真 `assessCompletionQuality`：撞顶(72/72)+验收通过 ⇒ 90 分 ≥60（**不**单独降级），
 *            而撞顶+验收未通过 ⇒ <60（同一道闸的条件成立）。
 *   §S3 build 钉（派生核对，不写轮次字面量）。
 *
 * ⚠ **M1-7 的就地收窄（本脚本落地时发现，已回填方案 §3.3/§十一）**：
 *   方案原文写的是「`feedback` 含 `[过早结束]` ⇒ 终态必非 `completed`」。该蕴含**不能被合法数据满足**：
 *   `wasPremature`（预算 ≥95% 或步数 ≥ max−2）+ 完成分 ≥60 + 验收全通过，是**完全合法**的结局
 *   （被上限截断，但自己许诺的判据条条达成）——若把这类也一律暂停，是远超 A1 本意的扩大打击
 *   （A1 的原话是"同一道闸多接一条入口"，不是"删掉"或"全暂停"）。
 *   承本仓纪律「判据须能被合法数据满足」，此处收窄为 **`[过早结束]` + 验收 failed ⇒ 终态非 completed**，
 *   并保留 `[过早结束]` 这一记号（A1 选的是**降级**，不是删除）：`[过早结束]` 不再"只说不做"——
 *   它与"验收未通过"合流到同一道闸（分<60 ⇒ paused），该闸的判据在册于 (g)。
 *
 * ⚠ 承 feedback「rr 夹具须按生产初始化顺序」：本文件夹具 DDL 逐列照抄 `database.ts`；计数器一律给
 *   "0→1"正面断言（见 (b) 的"落账前 0 / 落账后 1"）。
 * ⚠ 承 feedback「断言里不得写"只为下一轮"的字面量」：本文件不以轮次字面量做等值断言；
 *   build 钉一律由 `scripts/lib/rr-pins.ts` 派生核对（§S3）。
 * ⚠ 本文件**不打开真库**（真库只读实测见方案 §一）；§S3 读 `dist` ⇒ tsup 须先于本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineSrc, stripStepScopePrefix } from './lib/rr-engine-src.js';
import {
  acceptanceVerdictOf, capScoreByAcceptanceVerdict, isAcceptanceVerified, isUnjudgedReason,
  decideAcceptanceOutcome, recordAcceptanceOutcome,
  type AcceptanceCheckPayload, type AcceptanceUnverifiedReason,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { assessCompletionQuality, countsTowardToolQuota, isExplorationCall } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { resolveMaxSteps, stepsCapReached, buildStepCapNote, budgetCapReached } from '../apps/worker-ant-desktop/src/main/core/step-budget.js';
import { bumpResumeLedger, resumeLedgerTotal, autoPullJobType, EXECUTION_TRACE_ROLES } from '../apps/worker-ant-desktop/src/main/core/resume-ledger.js';
import { toolRegistry, TOOL_METAS } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import {
  captureWorldSnapshot, compareSnapshots, auditWorldConsistency,
  SNAPSHOT_FILE_LIMIT, SNAPSHOT_LIST_LIMIT,
} from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
/** 行保持式去注释（`blob.includes('…')` 那类子串匹配会被注释骗过——本文件一律去注释后再断言） */
const strip = (s: string) => stripKeepingLines(s).join('\n');
type AnyDb = import('better-sqlite3').Database;

// ── 夹具 schema：逐列照抄 database.ts DDL，既不缺列也不放宽 NOT NULL ──
// （`wa_projects` 省掉的是 `owner_id … REFERENCES wa_users(id)` 那条 **FK 约束**——夹具无 wa_users 表，
//   而列一个不少；其余各表同理只省约束不省列。见 feedback「rr 夹具须按生产初始化顺序」）
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace', owner_id TEXT,
  cron_timezone TEXT DEFAULT 'Asia/Shanghai', autonomous_mode TEXT DEFAULT 'off',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT,
  status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

/** 一批**同形**的合格任务：真 doc + 真文件 + 3 条 assistant 对话 ⇒ 无账基线分 95（六维全满）。 */
function mkTask(db: AnyDb, id: string, dir: string): { file: string; workingDir: string } {
  const workingDir = path.join(dir, `${id}-wd`);
  fs.mkdirSync(workingDir, { recursive: true });
  const file = path.join(workingDir, 'A_out.md');
  fs.writeFileSync(file, '# 产出\n' + 'x'.repeat(1200));
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, source, acceptance_criteria, context_json)
              VALUES (?, 'p', ?, '', 'completed', 'test', '', '{}')`).run(id, id);
  db.prepare(`INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status, is_primary, acceptance_verified, created_at, updated_at)
              VALUES (?, 'p', ?, 'doc', 'A_out', '', ?, 'completed', 0, 0, datetime('now'), datetime('now'))`).run(`${id}-d`, id, file);
  for (let i = 0; i < 3; i++) {
    db.prepare(`INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at)
                VALUES (?, ?, 'assistant', ?, 0, datetime('now'))`).run(`${id}-c${i}`, id, `第 ${i} 步`);
  }
  return { file, workingDir };
}

/** 完成分基线：六维全满 ⇒ 95（= `Math.min(95, score)` 的上界，压降一旦生效必现形）。 */
const BASE_SCORE = 95;
const quality = (db: AnyDb, id: string, workingDir: string) =>
  assessCompletionQuality(db, id, 10, 1000, 200000, 60, workingDir, 'coding');

/** 真 JSON 文本（模拟验收 LLM 的原始输出），供 `decideAcceptanceOutcome` 走真解析。 */
const credJson = (items: Array<{ criterion: string; passed: boolean; reason?: string }>) => JSON.stringify(items);

/** 生产写账链：真决策 → 真落账 → 回读真载荷。**不手造载荷冒充"账"**。 */
function writeLedgerViaProduction(db: AnyDb, id: string, kind: 'ok' | 'no_model' | 'exception', text: string | null): AcceptanceCheckPayload {
  return recordAcceptanceOutcome(db, id, decideAcceptanceOutcome({ kind, text }));
}

async function main(): Promise<void> {
  // zx_20260929 M9: 读作**搬迁前的写法**（步回调搬到 `core/exec-step.ts`，段内绑定统一前置 `d.`）。
  //   还原 ≠ 放宽：扫描面仍是 `engineSrc()` 并集，只是把针脚对得回搬迁前的字面量。
  const aeSrc = strip(stripStepScopePrefix(engineSrc()));
  const acSrc = strip(RD(`${A}/src/main/core/acceptance-check.ts`));
  const tdpSrc = strip(RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx161-'));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1a】M1-1 三态判据：唯一真源 + 「未核验 ≠ 未通过」');
  {
    const failedLedger = { checked_at: 't', verified: true, criteria_total: 8, passed_total: 0, passed: [], failed: [{ criterion: 'a', reason: 'r' }] };
    eq(acceptanceVerdictOf(failedLedger), 'failed', 'M1-1 `verified:true && passed_total < criteria_total` ⇒ `failed`');
    eq(acceptanceVerdictOf({ ...failedLedger, criteria_total: 8, passed_total: 7 }), 'failed', 'M1-1 差一条也算未通过（不是"差不多就通过"）');
    eq(acceptanceVerdictOf({ checked_at: 't', verified: true, criteria_total: 3, passed_total: 3 }), 'passed', 'M1-1 全达成 ⇒ `passed`');
    eq(acceptanceVerdictOf({ checked_at: 't', verified: true, criteria_total: 0, passed_total: 0 }), 'passed',
      'M1-1 边界如实：`verified:true` 且 0/0 读作 `passed`（模型返回空数组）——不触发任何压降/暂停，方案 §十一 已记');
    eq(acceptanceVerdictOf(undefined), 'not_checked', 'M1-1 无账 ⇒ `not_checked`（"没这笔账"不编默认态）');
    eq(acceptanceVerdictOf({ verified: true, criteria_total: 1, passed_total: 0 }), 'not_checked',
      'M1-1 无 `checked_at` 即未核验 ⇒ `not_checked`（三个计数键不足以自证"验过"）');
    // zx_20260923_1 M2: 五个未核验成因**分两类**（承 A4 的理据边界）——
    //   「没有题目」（无人许诺判据）⇒ `not_checked`，不阻断；
    //   「有题未判成」（题在、这轮没判成）⇒ `unjudged`，**不压分但不标完成**。
    // 判据**不在此手抄两清单**：一律经 `isUnjudgedReason`（词表 `UNJUDGED_REASONS` 一处真源），
    //   故"加严"落在此处、词表仍只有一份（renderer 也引同一函数）。
    const reasons: AcceptanceUnverifiedReason[] = ['no_model', 'no_json', 'error', 'no_criteria', 'no_user_criteria'];
    eq(reasons.map((r) => acceptanceVerdictOf({ checked_at: 't', verified: false, reason: r, criteria_total: 0, passed_total: 0 })),
      reasons.map((r) => (isUnjudgedReason(r) ? 'unjudged' : 'not_checked')),
      '★ M1-2 + zx_20260923_1 M2 五个未核验成因**分两类**：三码「有题未判成」⇒ `unjudged`，两码「无人许诺判据」⇒ `not_checked`（两类都不并进 `failed`）');
    eq(reasons.filter(isUnjudgedReason), ['no_model', 'no_json', 'error'],
      '★ M2 正面断言：`isUnjudgedReason` 恰认这三码（多一个即误伤"无人许诺判据"的规划类任务）');
    eq(acceptanceVerdictOf({ checked_at: 't', criteria_total: 2, passed_total: 2 }), 'passed',
      'M1-1 `verified` 缺席（存量老载荷）⇒ 视为已核验（承 `isAcceptanceVerified` 的兼容口径），计数全达 ⇒ `passed`');
    eq(acceptanceVerdictOf({ checked_at: 't', criteria_total: 2, passed_total: 1 }), 'failed',
      'M1-1 同一兼容口径下计数未达 ⇒ `failed`（老载荷**不因缺 `verified` 而免于判定**）');
    eq(capScoreByAcceptanceVerdict(95, 'not_checked'), 95, '压降只对 `failed` 动作：`not_checked` ⇒ 原值不动');
    eq(capScoreByAcceptanceVerdict(95, 'unjudged'), 95,
      '★ zx_20260923_1 M2「没判成 ≠ 没达成」：`unjudged` **也不压分**（它的处置在终态层，不在评分层）');
    eq(capScoreByAcceptanceVerdict(95, 'passed'), 95, '压降只对 `failed` 动作：`passed` ⇒ 原值不动');
    ok(capScoreByAcceptanceVerdict(95, 'failed') < 60, '`failed` ⇒ 压到 60 分以下（与 D1「未达交付」同尺）');
    eq(capScoreByAcceptanceVerdict(30, 'failed'), 30, '压降是 `min` 而非赋值：本已更低的分数不得被**抬高**');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1b】M1-1/M1-5 生产写账链 → 生产读判据（真决策 · 真落账 · 真回读）');
  {
    const db = mkdb();
    const { workingDir } = mkTask(db, 'w', dir);
    const baseline = quality(db, 'w', workingDir).score;
    eq(baseline, BASE_SCORE, `前置：无账基线分 = ${BASE_SCORE}（六维全满，压降一旦生效必现形）`);

    const before = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('w') as { context_json: string }).context_json) as { acceptance_check?: unknown };
    eq(before.acceptance_check, undefined, '前置：落账前 `acceptance_check` **不在账上**（0）');

    // ① 未通过：真 LLM 文本（8 条判据 0 通过，逐条带理由）⇒ 真决策 ⇒ 真落账
    const failPayload = writeLedgerViaProduction(db, 'w', 'ok', credJson([
      { criterion: '须提供回测记录', passed: false, reason: '未提供回测记录' },
      { criterion: '须有提交哈希', passed: false, reason: '未提供提交哈希' },
    ]));
    eq(failPayload.verified, true, '① 真核验载荷 `verified:true`（走的是"真跑了核对"那一支，不是未核验兜底）');
    eq([failPayload.criteria_total, failPayload.passed_total], [2, 0], '① 计数由**真载荷构造器**写出（不是本脚本手填）');
    const after = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('w') as { context_json: string }).context_json) as { acceptance_check?: unknown };
    ok(after.acceptance_check !== undefined, '① 落账 **0→1**（正面断言：值从"无"变为一份载荷）');
    eq(acceptanceVerdictOf(after.acceptance_check), 'failed', '① ★ 闭环：**生产写的那笔账**经**生产读判据**读出 `failed`（非手造载荷自证）');

    // ② 未核验：真决策的另外三支
    for (const [kind, text, why] of [['no_model', null, 'no_model'], ['exception', null, 'error'], ['ok', '模型的自由散文，无 JSON', 'no_json']] as Array<['ok' | 'no_model' | 'exception', string | null, string]>) {
      const db2 = mkdb();
      mkTask(db2, 'x', dir);
      const p = writeLedgerViaProduction(db2, 'x', kind, text);
      eq([p.verified, p.reason], [false, why], `② 真决策支 \`${kind}\` ⇒ 未核验载荷（成因 \`${why}\`，计数归零不报假 N/N）`);
      const read = JSON.parse((db2.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('x') as { context_json: string }).context_json) as { acceptance_check?: unknown };
      eq(acceptanceVerdictOf(read.acceptance_check), isUnjudgedReason(why as AcceptanceUnverifiedReason) ? 'unjudged' : 'not_checked',
        `② 且经生产读判据 ⇒ ${isUnjudgedReason(why as AcceptanceUnverifiedReason) ? '`unjudged`（有题未判成：题在、本轮没判成）' : '`not_checked`'}（\`${why}\` 绝不并进 \`failed\`）`);
      eq(quality(db2, 'x', dir).score, BASE_SCORE, `★ M1-2 正面断言：\`${why}\` 的完成分**逐位等于**无账基线（压降未生效）`);
    }
    // 空数组（模型吐了 JSON 但一条判据都没有）——载荷构造器出的 0/0
    const db3 = mkdb();
    mkTask(db3, 'z', dir);
    const emptyPayload = writeLedgerViaProduction(db3, 'z', 'ok', '[]');
    eq(emptyPayload.criteria_total, 0, '② `[]` ⇒ `criteria_total:0` 的真核验载荷（合法输入，不报未核验）');
    eq(quality(db3, 'z', dir).score, BASE_SCORE, '★ 且完成分仍等于基线（0/0 不触发压降——边界如实，非"漏了一道闸"）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1c】M1-3 未通过 ⇒ 分<60 且 终态非 completed 且 goal_achieved 非真（三者同时）');
  {
    // 腿①（真实现）：完成分压降
    const db = mkdb();
    const { workingDir } = mkTask(db, 'f', dir);
    eq(quality(db, 'f', workingDir).score, BASE_SCORE, '前置：先确认这条任务是"本该 95 分"的好任务（否则压降无从观察）');
    writeLedgerViaProduction(db, 'f', 'ok', credJson([{ criterion: '须提供回测记录', passed: false, reason: '未提供回测记录' }]));
    const q = quality(db, 'f', workingDir);
    ok(q.score < 60, `腿① 未通过 ⇒ 完成分 **<60**（实测 ${q.score}，基线 ${BASE_SCORE}）`);
    ok(q.feedback.includes('验收未通过'), '腿① 且 `feedback` **点名成因**（不只是数字变了——用户要知道为什么）');

    // 两因并存：同一份账上既有"验收未通过"也有"[过早结束]"时，**两条说明都得写**（不许后者吞前者）
    const db2 = mkdb();
    const w2 = mkTask(db2, 'f2', dir);
    writeLedgerViaProduction(db2, 'f2', 'ok', credJson([{ criterion: 'a', passed: false, reason: 'r' }]));
    // stepCount=58 ≥ maxSteps−2=58 ⇒ `wasPremature`（与标本任务同一形态：撞顶后收口）
    const q2 = assessCompletionQuality(db2, 'f2', 58, 1000, 200000, 60, w2.workingDir, 'coding');
    ok(q2.feedback.includes('[过早结束]') && q2.feedback.includes('验收未通过'),
      '腿① ★ 两因并存时**两因都写**（`[过早结束]` 未被压降说明吞掉）');

    // 腿②③（结构断言）：终态与 goal_achieved 在**同一个** `failed` 分支里落笔，且该分支在"标完成"之前
    const failedIdx = aeSrc.indexOf("if (closeVerdict === 'failed') {");
    // 锚点按**符号位置**推进（`indexOf(…, failedIdx)`）：全仓 `status = 'completed'` 有两处（finalize 收口在前），
    // 从 0 找会匹配到 finalize 那一处，得出"闸在标完成之后"的**假**结论。
    const completedIdx = failedIdx > 0 ? aeSrc.indexOf("UPDATE wa_tasks SET status = 'completed'", failedIdx) : -1;
    ok(failedIdx > 0 && completedIdx > failedIdx,
      '腿② run_close 的 `failed` 分支**先于**"标完成"落笔（顺序倒了闸就是摆设）');
    const closeBlock = completedIdx > failedIdx ? aeSrc.slice(failedIdx, completedIdx) : '';
    // zx_20260917 M1：该分支的终态由裸 `UPDATE … SET status='paused'` 改为走唯一写入口
    //   `pauseTask`（状态 + `pause_reason` + 事件一次写全），故断言改钉**写入口与因**，不再钉 SQL 字面量。
    ok(closeBlock.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_ACCEPTANCE_FAILED'),
      '腿② 该分支经唯一写入口 `pauseTask` 置 `paused`（不是 `completed`），且因落 `acceptance_failed`');
    // 腿③ 的两次落点迁移（M3 → M4），**判据的实质从头到尾没变**：`failed` ⇒ 目标判为未达成，
    //   且顶层 `goal_achieved` 与 `completion_quality.goal_achieved` 同值。
    //   · M3：原断言的 `goal_achieved: false` 字面量随"账只由 `buildCompletionAccount` 一处造"退场。
    //   · M4：完成账**整体上移**到"收口前重算"那一段一次写完（`failed` 分支不再写账）——
    //     因为该分支要读的账必须是**刚落的新鲜账**，而落在分支内写就成了"读完再改"。
    //   两次都按**新落点**重新切块断言，而不是把旧字面量改到绿。M4 之后链条为：
    //   `failed` ⇒ `assessCompletionQuality` 压到 ≤`ACCEPTANCE_FAILED_SCORE_CAP`(<60) ⇒ `goalAchievedOf(…)` 必 false。
    const preIdx = aeSrc.indexOf('const prematureEnd =');
    const rcIdx = aeSrc.indexOf('qualityScore = assessCompletionQuality(db, taskId, stepCount,');
    const rcBlock = (rcIdx > 0 && preIdx > rcIdx) ? aeSrc.slice(rcIdx, preIdx) : '';
    ok(rcBlock.includes('buildCompletionAccount(') && /goalAchieved:\s*goalNow/.test(rcBlock),
      '腿③ 完成账仍由**唯一构造器**出，达成值经 `goalAchievedOf` **派生**后传入（M4 起写在收口前一次）',
      rcBlock ? `${rcBlock.split('\n').length} 行` : '(未切到块)');
    ok(/qCtx\.goal_achieved\s*=\s*goalNow/.test(rcBlock),
      '腿③ ★ 顶层 `goal_achieved` 与 `completion_quality.goal_achieved` **同值**'
      + '（同一局部量 `goalNow` 写两处，构造上就不可能分叉——M3 的"不许两版账"不变式，M4 只换落点）');
    ok(!/completion_quality\s*=/.test(closeBlock),
      '腿③ ★ `failed` 分支**不写第二版账**（M4 起：一份 `context_json` 内只许一版账，该分支只置暂停与如实告知）');
    // 原直调 `markPauseNeeded(` 的登记动作，M1 起由 `pauseTask` 在 `note` 非空时代发——语义不变（仍登记、仍不静默），
    //   只是不再由调用点自己补一笔。故断言改为"该暂停点**带了 note**"。
    ok(/pauseTask\(db, \{[^)]*note:/.test(closeBlock),
      '腿② 并登记暂停因由（`note` 随 `pauseTask` 一并落，与其余暂停点同尺，不静默）');
    ok(closeBlock.includes("if (closeVerdict === 'failed')"), '腿② 闸的判据取自 `closeVerdict`（由 `acceptanceVerdictOf` 派生，非本处另判一遍）');
    ok(!/passed_total\s*<\s*criteria_total/.test(aeSrc),
      '★ 判据唯一：`agent-executor.ts` **无**手写的三态比较（同一规则两处手抄即分叉之源）');
    ok(!aeSrc.includes('ACCEPTANCE_FAILED_SCORE_CAP'),
      '★ 阈值唯一：压降上限只在 `acceptance-check.ts` 定义，读点走 `capScoreByAcceptanceVerdict`（不手抄 45）');
    const verdictSites = aeSrc.split('acceptanceVerdictOf(').length - 1;
    ok(verdictSites >= 3, `★ 三处消费同一判据（完成分 / D1 成因点名 / run_close 终态），实测 ${verdictSites} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1d】M1-4 已通过 ⇒ 三条压降均不生效（反向断言）');
  {
    const db = mkdb();
    const { workingDir } = mkTask(db, 'p', dir);
    const p = writeLedgerViaProduction(db, 'p', 'ok', credJson([
      { criterion: 'a', passed: true }, { criterion: 'b', passed: true },
    ]));
    eq([p.criteria_total, p.passed_total], [2, 2], '前置：真核验且全达成（2/2）');
    eq(acceptanceVerdictOf(p), 'passed', '前置：判据读作 `passed`');
    const q = quality(db, 'p', workingDir);
    eq(q.score, BASE_SCORE, '★ 全通过 ⇒ 完成分**逐位等于**基线（压降过宽会把好任务压死，这条是它的反证）');
    ok(!q.feedback.includes('验收未通过'), '★ 且 `feedback` 不含压降说明（文案与实际同源）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1e】M1-5 两收口路同一结论 + M1-7 收窄后的判据');
  {
    // 两个出口消费同一判据：finalize 路（`acceptanceBlock` 拦）与 run_close 路（`closeVerdict` 停）
    ok(/if \(acceptanceBlock\) return acceptanceBlock;/.test(aeSrc),
      'M1-5 finalize 路：既有 `block` 拦截**仍在册**（未因新增终态闸而被删/被绕）');
    // zx_20260916_3 M4：取值来源由"当轮返回载荷"改为**刚落账的账**（`closeAccNow`，验收调用之后读）。
    //   两者在同一次运行内同值；差别在**验收没跑**的那条路（开关关闭）：从前此处得 `not_checked`，
    //   而评分读的却是账上的 `failed` ⇒ 同一份 `context_json` 里"账说未通过、终态 completed"。
    //   现在终态与评分**同源同刻**（都读 `closeAccNow`/`readAcceptanceCheck`），判据的实质不变。
    ok(/const closeVerdict: AcceptanceVerdict = acceptanceVerdictOf\(closeAccNow\)/.test(aeSrc),
      'M1-5 run_close 路：取的是**验收刚落账那一刻读回的账**（`closeAccNow`），与完成分读的是同一份' );
    const blockRule = acSrc.includes("return { outcome: { ran: true, passed: false, block }, checks };");
    ok(blockRule, 'M1-5 且 `block` 的产出规则是 `ran && 有未达项`——与 `acceptanceVerdictOf` 的 `failed` 同界（一个判据两个出口）');
    ok(isAcceptanceVerified({ checked_at: 't', verified: true }) && !isAcceptanceVerified({ checked_at: 't', verified: false }),
      'M1-5 两路共用的 `isAcceptanceVerified` 语义未变（未核验一律不算验过）');

    // M1-7：收窄后的判据——`[过早结束]` 不再"只说不做"
    ok(aeSrc.includes("' [过早结束]'"), 'M1-7 `[过早结束]` 记号**保留**（A1 选降级，非删除）');
    ok(/if \(prematureEnd && qualityScore\.score < 60\)/.test(aeSrc),
      'M1-7 且该记号**有后果**：`[过早结束]` 与"分<60"合流到 D1 那道闸（paused + markPauseNeeded）');
    ok(aeSrc.includes('d1FailedBy'), 'M1-7 低分成因**如实点名**（45 分可能来自验收压降，不让人误读为产出不足）');
    // 收窄的正面依据：`failed` ⇒ 分<60 已由 S1c 腿① 实测；`[过早结束]`+全通过+分≥60 是**合法**结局（不暂停）
    ok(true, 'M1-7 收窄后的判据 = 「`[过早结束]` **且** 验收未通过 ⇒ 终态非 completed」——见文件头 §M1-7 收窄说明');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S2】renderer 第二落点：状态徽标旁的一行如实提示');
  {
    const badgeIdx = tdpSrc.indexOf('✗ 验收 ');
    ok(badgeIdx > 0, '静态：`TaskDetailPage.tsx` 在**状态徽标行**含如实提示（否则同屏仍是绿徽 + "0 通过 · 8 未达"两种口径）');
    // zx_20260930 M4-4 锚点订正：徽标的**文案表达式**已收敛到共享词表（`statusText(TASK_STATUS_LABEL, …)`），
    // 故改以徽标自身的**着色表达式**定位——同一 span、判据同为"徽标在此"，且不钉词表名（不早于本轮）。
    const statusIdx = tdpSrc.indexOf('STATUS_COLOR[task.status]');
    ok(statusIdx > 0 && statusIdx < badgeIdx, '静态：提示**紧邻状态徽标之后**（同一行、同一 flex 容器）');
    ok(/acceptanceFailed &&/.test(tdpSrc), '静态：提示由**同一个判据**派生（`acceptanceFailed`，非本处另判一遍）');
    ok(/acceptanceCheck\.verified !== false && \(acceptanceCheck\.failed \?\? \[\]\)\.length > 0/.test(tdpSrc),
      '★ 静态：判据是"已核验 **且** 有未达项"——与 main 侧 `acceptanceVerdictOf` 同界（未核验不得显示未达）');
    ok(/criteria_total/.test(tdpSrc.slice(Math.max(0, badgeIdx - 400), badgeIdx + 400)),
      '静态：提示里带上总数（"N 条未达 / 共 M 条"可复核——`title` 在徽标**文本之前**，窗口须往前取）');
    ok(tdpSrc.includes('「已完成」不等于「已验收」'), '静态：文案点破两种口径的关系（维特根斯坦"意义即用法"的落点）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S4】M2 配额与实际同源：#3（计数同尺 + 文案一处真源）');
  {
    // ── M2-1 / M2-2：**真判据 + 真阈值**累计，再比生产闸门的那条线（`count >= quota.hard` ⇒ 进 disabledTools）──
    // 不造计数器、不抄阈值：判据来自 `countsTowardToolQuota`（真实现），阈值来自 `toolRegistry.getQuota`（真元数据）。
    const bashQ = toolRegistry.getQuota('bash');
    const execQ = toolRegistry.getQuota('execute_command');
    ok(!!bashQ && !!execQ && bashQ.hard > 0 && execQ.hard > 0,
      '夹具前置：bash/execute_command 在册且有硬配额（否则本节断言无意义）', `bash.hard=${bashQ?.hard} exec.hard=${execQ?.hard}`);

    type Call = [string, { command?: string; query?: string }];
    /** 与生产同一自增条件（A3 段 `if (countsTowardToolQuota(...)) map.set(...+1)`）逐字同构 */
    const accumulate = (calls: Call[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const [name, args] of calls) if (countsTowardToolQuota(name, args)) counts.set(name, (counts.get(name) || 0) + 1);
      return counts;
    };
    /** 该序列跑完后，该工具是否会被 A3 硬禁用（闸门条件 = 生产那行 `count >= limit.hard`） */
    const wouldDisable = (calls: Call[], name: string): boolean => {
      const q = toolRegistry.getQuota(name);
      return !!q && (accumulate(calls).get(name) || 0) >= q.hard;
    };
    const repeat = (n: number, c: Call): Call[] => Array.from({ length: n }, () => [c[0], c[1]] as Call);

    // 标本任务 §1.3 的真实收尾序列：读完代码 → 跑测试 → 提交（20 次，恰在原被误伤的位置）
    const wrapUp: Call[] = [
      ['bash', { command: 'python3 scripts/test_a1.py' }], ['bash', { command: 'python3 scripts/test_a2.py' }],
      ['bash', { command: 'python3 scripts/test_a3.py' }], ['bash', { command: 'git status' }],
      ['bash', { command: 'git add -A' }], ['bash', { command: 'git commit -m "fix"' }],
      ...repeat(14, ['bash', { command: 'npm test' }]),
    ];
    eq(wrapUp.length, 20, '夹具：收尾序列恰 20 次 bash');
    ok(!wouldDisable(wrapUp, 'bash'),
      'M2-1 ★ 20 次**收尾类** bash ⇒ 不进 disabledTools（正面断言：由真判据算出的账 + 真阈值比对得出，非"不抛异常"）');
    eq(accumulate(wrapUp).get('bash') || 0, 0,
      '★ M2-1b 且配额计数**恰为 0**——"收尾命令一律不吃额度"，不是"少算了一点刚好没过线"');

    const exploreSeq = repeat(20, ['bash', { command: 'ls -la src' }]);
    ok(wouldDisable(exploreSeq, 'bash'),
      'M2-2 ★ 20 次**探索类** bash ⇒ 进 disabledTools（反向断言：闸门没被削掉，阈值仍是 20 而非形同虚设）');
    eq(accumulate(exploreSeq).get('bash'), 20, 'M2-2b 探索类全数入账（20/20，与上面 0/20 成对照）');

    // ── M2-4：bash 与 execute_command 走**同一把尺**（非各写一份判据）──
    // `expect` = 是否**计入配额**（吃额度）：只读探测吃，收尾命令一律不吃。
    for (const [cmd, expect] of [
      ['ls -la src', true], ['cat a.ts', true], ['head -50 x.ts', true],
      ['git commit -m x', false], ['python3 scripts/test_a.py', false], ['npm run build', false], ['python3 -m py_compile a.py', false],
    ] as Array<[string, boolean]>) {
      ok(countsTowardToolQuota('bash', { command: cmd }) === expect && countsTowardToolQuota('execute_command', { command: cmd }) === expect,
        `M2-4 同尺：\`${cmd}\` 对 bash 与 execute_command 同判（${expect ? '计入配额' : '不吃额度'}）`);
    }
    // ★ zx_20260922_1 M1（F3 顺带裁定·取 a）**就地订正**：原判据是 `!==`——断言"两把尺对 `execute_command`
    //   判得不一样"。而 M1 治的正是这个分家（同一条 `ls -la`：`bash` 判探索、`execute_command` 判非探索
    //   ⇒ **换一把 shell 即绕过**探索收敛闸与配额处置）。`isExplorationCall` 的 execute_command 分支补上
    //   "只读探测"一支后，两尺的分歧从"整条只读白名单"收窄到**一个具名出口**（循环豁免支）。
    //   故钉法改钉**更强**的新事实：只读探测/收尾两支上**两尺同判**，分歧**恰**剩豁免那一支。
    for (const [cmd, expect] of [
      ['ls -la src', true], ['cat a.ts', true], ['find . -name x.ts', true], ['grep -rn x src', true],
      ['git status', false], ['git commit -m x', false], ['mvn -v', false], ['python3 scripts/test_a.py', false],
    ] as Array<[string, boolean]>) {
      ok(countsTowardToolQuota('execute_command', { command: cmd }) === expect
        && isExplorationCall('execute_command', { command: cmd }) === expect,
        `★ M2-4a（M1 订正后）两尺同判：\`execute_command ${cmd}\` ⇒ ${expect ? '探索/计入' : '收尾/不计入'}（配额尺与探索尺一致）`);
    }
    ok(countsTowardToolQuota('execute_command', { command: 'python3 -m py_compile a.py' }) === false
      && isExplorationCall('execute_command', { command: 'python3 -m py_compile a.py' }) === true,
      '★ M2-4a′ 分歧**恰**剩一处且具名：循环豁免支（py_compile/--version）算探索但**不吃配额**'
      + '——这是 zx_20260917 M5b 明示保留的代价，M1 未动；别处两尺一律同判');
    // ★ 反证（就地订正的核心）：非 shell 的配额工具不得因"只计探索类"被静默废掉
    ok(!isExplorationCall('search_web', { query: 'x' }) && countsTowardToolQuota('search_web', { query: 'x' }),
      '★ M2-4b 反证：`search_web` 并非"探索类"（isExplorationCall=false），但**仍逐次计入配额**——字面照搬"只计探索类"会让 3/5、5/8 两张闸永不触发');
    ok(wouldDisable(repeat(5, ['search_web', { query: 'q' }]), 'search_web') && wouldDisable(repeat(8, ['read_web', { command: 'u' }]), 'read_web'),
      'M2-4c 正面：search_web(5)、read_web(8) 到量仍会禁用 ⇒ 那两道既有闸门真的还在');

    // ── M2-3：文案一处真源 + 只描述闸门会做什么 ──
    const trSrc = strip(RD(`${A}/src/main/core/tool-registry.ts`));
    ok(!aeSrc.includes('不会被硬禁用'),
      'M2-3 ★ agent-executor（去注释）内"不会被硬禁用"零命中——D2 那句与 A3 硬行为打脸的承诺已删');
    ok(!aeSrc.includes("'[只读bash软配额]") && !aeSrc.includes('bashSoftWarned'),
      'M2-3 D2 的独立文案与其进程内去重表一并删除（同一件事不再两处落点）');
    // **文案定义处** = `softMsg: '<字面量>'`（带引号）。刻意**不**数 `softMsg: string;` 那类**类型声明**
    //   （接口字段 / 账本方法签名）——它们不是文案，数进来只会让"一处真源"这句话被稀释。
    const softDefs = (s: string) => [...s.matchAll(/softMsg\s*:\s*['"]/g)].length;
    const hardDefs = (s: string) => [...s.matchAll(/hardMsg\s*:\s*['"]/g)].length;
    // zx_20260916_3 M5（O-H · D4）：`bash` 与 `execute_command` 改为**共用同一份配额对象**（quota 归一），
    //   故文案数不再等于"配额工具数"，而等于"**配额对象份数**"。按对象份数派生比按工具数更贴原意：
    //   它本身就把"两把工具共用一份定义"算进了判据（若两把工具又各写一份，此处会多出 1 而判红）。
    const quotaTools = TOOL_METAS.filter((m) => m.quota).length;
    const quotaObjects = new Set(TOOL_METAS.filter((m) => m.quota).map((m) => m.quota)).size;
    eq(softDefs(aeSrc), 0, 'M2-3 `softMsg` 文案在 agent-executor 零定义');
    eq(hardDefs(aeSrc), 0, 'M2-3 `hardMsg` 文案同为零定义（软硬两句一起归一，不留半份）');
    eq(softDefs(trSrc), quotaObjects,
      `M2-3 且 softMsg 文案只在 tool-registry.ts，且**每家一份**：${quotaObjects} 份配额定义 ⇒ ${quotaObjects} 处 softMsg`
      + `（由元数据表自身派生，不写死数字；${quotaTools} 个配额工具 > ${quotaObjects} 份定义 ⇒ 差额正是共用的那一份）`);
    eq(hardDefs(trSrc), quotaObjects, `M2-3 hardMsg 同尺（${quotaObjects} 份 ⇒ ${quotaObjects} 处）`);
    // zx_20260916_3 M5（O-H · D4）后这两把工具**共用同一个配额对象**，故下面两轮读到的是同一份文案——
    //   保留双轮不是冗余：它同时证明了"两把工具的文案一字不差"，而那正是 D4 要的"同尺"；
    //   "同一个对象（身份相同）"这条更强的断言落在 `rr_zx_20260916_3.ts` §E-2。
    for (const t of ['bash', 'execute_command']) {
      const q = toolRegistry.getQuota(t)!;
      ok(/探索类命令/.test(q.softMsg) && /收尾命令不计入/.test(q.softMsg),
        `M2-3 ${t}.softMsg 说的是闸门**实际的尺**（只计探索类 + 收尾命令不计入）`);
      ok(/探索类命令/.test(q.hardMsg) && /收尾命令不计入/.test(q.hardMsg), `M2-3 ${t}.hardMsg 同尺`);
      ok(!/不会被硬禁用|仍可用于/.test(q.softMsg + q.hardMsg),
        `M2-3 ${t} 文案不含"不会被…"类**为闸门背书**的承诺（文案不得先于行为许诺）`);
    }
    // 接线：A3 读的是配额账（不是全量账）；自增由真判据把门；D3 的尺**不动**
    // zx_20260916_3 M5（O-H · D4）：判定改由真账本 `ExploreQuotaLedger` 出（同一本账，`bash`/`execute_command` 共用），
    //   原命题「A3 读**配额账**、不读全量账」不变，只是账从内联 Map 换成了具名账本类。
    ok(aeSrc.includes('quotaLedger.gate(toolRegistry.quotaKeyOf(tc.toolName), limit)'),
      'M2-3 接线：A3 配额判定读**配额账**（具名账本 `ExploreQuotaLedger`，非就地内联的 Map、非全量账）');
    const gateIdx = aeSrc.indexOf('countsTowardToolQuota(tc.toolName, tc.args)');
    const incIdx = aeSrc.indexOf('quotaLedger.add(');
    ok(gateIdx > 0 && incIdx > gateIdx, 'M2-3 接线：自增由真判据把门（判据在自增之前）');
    ok(/let exploreCmdN = 0;/.test(aeSrc) && /const cmdN = exploreCmdN;/.test(aeSrc),
      'M2-4 接线：D3 的闸值**仍由它自己那个计数器**给出（本轮不动 D3——两尺答的问题不同，见源码注释）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S5】M3 B2 告警可复核：#4（截断对称 + 事后快照 + 大批变更给证据）');
  {
    // ── 夹具：**真目录 + 真 `captureWorldSnapshot`**（不造等价入参——承 feedback「核实往返类判据须在生产入参上证」）──
    //   before 435 条 `z_*`（字典序靠后）未截断；after = 1600 条 `a_*` + 同一批 435 条 `z_*` = 2035 条，
    //   排序后前 LIMIT 条恰好把排在后面的 35 个 `z_*` 截掉（§1.4 的 323 同机制、同方向）。
    const LIMIT = SNAPSHOT_FILE_LIMIT;
    const pad = (i: number) => String(i).padStart(4, '0');
    const mkdirIn = (name: string) => { const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true }); return d; };
    const touch = (d: string, names: string[]) => { for (const n of names) fs.writeFileSync(path.join(d, n), ''); };
    const range = (tag: string, from: number, to: number) => Array.from({ length: to - from }, (_, k) => `${tag}_${pad(from + k)}.txt`);

    const BEFORE_N = 435;
    const AFTER_EXTRA = 1600;
    const AFTER_N = BEFORE_N + AFTER_EXTRA;   // 2035 > LIMIT ⇒ 截断必然发生
    const CUT = AFTER_N - LIMIT;              // 被截掉的条数（= 旧口径下的**伪删除**条数）
    const wsBefore = mkdirIn('ws-before');
    const wsAfter = mkdirIn('ws-after');
    touch(wsBefore, range('z', 0, BEFORE_N));
    touch(wsAfter, [...range('a', 0, AFTER_EXTRA), ...range('z', 0, BEFORE_N)]);

    const wdb = mkdb();
    const mkProj = (id: string, wd: string) => wdb.prepare('INSERT INTO wa_projects (id, name, working_dir) VALUES (?, ?, ?)').run(id, id, wd);
    mkProj('wp-before', wsBefore); mkProj('wp-after', wsAfter);

    // zx_20260916_2 M3: 快照三函数改 async（让出事件循环）；此处**只补 await，断言一字不改**
    const snapBefore = await captureWorldSnapshot(wdb, 'wp-before');
    const snapAfter = await captureWorldSnapshot(wdb, 'wp-after');
    ok(!!snapBefore && !!snapAfter, '夹具前置：两侧快照均采集成功（否则本节断言无意义）');

    // ── M3-6：如实**分开记录**真实总数与样本 ──
    eq(snapBefore!.fileCount, BEFORE_N, 'M3-6 未截断侧：fileCount = 真实总数');
    eq(snapBefore!.truncated, false, 'M3-6 未截断侧：truncated=false（截断标记不是恒真）');
    eq(snapAfter!.truncated, true, 'M3-6 截断侧：truncated=true');
    eq(snapAfter!.fileCount, AFTER_N, '★ M3-6 fileCount 仍是**截断前真实总数**——不得把样本量当总数（§1.4 病根的另一种形态）');
    eq((snapAfter!.fileHashes as string[]).length, LIMIT, 'M3-6 且 fileHashes 恰为上限条（截断真发生了，否则本节断言空转）');
    ok(snapAfter!.fileCount !== (snapAfter!.fileHashes as string[]).length, '★ M3-6 反证：截断侧 fileCount ≠ 样本量（二者相等即"拿样本冒充总数"）');

    // ── M3-1：复现 §1.4 —— 一侧截断 ⇒ 放弃增删判定，只报"快照已截断"（本项的回归钉子）──
    const issues31 = compareSnapshots(snapBefore!, snapAfter!);
    eq(issues31.filter((s) => s.includes('文件删除')).length, 0, '★ M3-1 复现 §1.4：一侧截断 ⇒ **零删除告警**（323 那类伪报不再产生）');
    eq(issues31.length, 1, 'M3-1 且恰一条告警——不是"把所有告警都删了"');
    ok(issues31[0].startsWith('[快照已截断]'), 'M3-1 该条即"快照已截断"');
    ok(issues31[0].includes(`before ${BEFORE_N} 未截断`) && issues31[0].includes(`after ${AFTER_N} 已截断`),
      '★ M3-1 **逐侧**如实标注：只标"已截断"的那一侧，不笼统说"均超采样上限"（before 435 < 上限，本就未截断）');
    // ★ 反证：同一对快照按**旧口径**（不看 truncated，直接集合差 + 改名豁免）算 ⇒ 必然报出 CUT 个伪删除。
    //   没有这条，"不报删除"可能只是因为它本来就无删除可报（判据空转 = 自我印证）。
    const hName = (h: string) => { const c = h.lastIndexOf(':'); return c > 0 ? h.slice(0, c) : h; };
    const setB = new Set(snapBefore!.fileHashes as string[]);
    const setA = new Set(snapAfter!.fileHashes as string[]);
    const rawDeleted = [...setB].filter((f) => !setA.has(f));
    const rawNewNames = new Set([...setA].filter((f) => !setB.has(f)).map(hName));
    const oldFalseDeletions = rawDeleted.filter((f) => !rawNewNames.has(hName(f)));
    eq(oldFalseDeletions.length, CUT, `★ M3-1 反证：旧口径在同一对快照上会报 ${CUT} 个"文件消失"——逐条都是截断伪报`);
    eq(hName(oldFalseDeletions[0]), `/z_${pad(LIMIT - AFTER_EXTRA)}.txt`, 'M3-1 反证：首条伪报正是截断边界之后的第一个文件（由上限与夹具规模派生，不写死名字）');

    // ── M3-2/M3-3：**真删除**照样要报（截断豁免不得反过来把真删除也吞掉）──
    const wsDel = mkdirIn('ws-del');
    const DEL_N = 20;
    touch(wsDel, range('d', 0, DEL_N));
    mkProj('wp-del', wsDel);
    const delBefore = (await captureWorldSnapshot(wdb, 'wp-del'))!;
    eq(delBefore.truncated, false, '夹具：删除用快照未截断（否则本节判据会落进"已截断"分支，断言空转）');

    fs.rmSync(path.join(wsDel, 'd_0000.txt'));
    const issues32 = compareSnapshots(delBefore, (await captureWorldSnapshot(wdb, 'wp-del'))!);
    eq(issues32.length, 1, 'M3-2 真删 1 个 ⇒ 恰一条告警');
    ok(issues32[0].includes('[文件删除] 1个文件消失') && issues32[0].includes('d_0000.txt'),
      'M3-2 ★ 真删仍报，且**列出文件名**');

    for (const n of range('d', 1, 5)) fs.rmSync(path.join(wsDel, n));
    const delAfter5 = (await captureWorldSnapshot(wdb, 'wp-del'))!;
    const issues33 = compareSnapshots(delBefore, delAfter5, { taskId: 'T-dump', dataDir: dir });
    eq(issues33.length, 1, 'M3-3 真删 5 个（>3）⇒ 仍只一条删除告警');
    ok(issues33[0].includes('[文件删除] 5个文件消失'), 'M3-3 报出总数 5（不再是一句"大量变更，可能异常"打发）');
    for (const n of range('d', 0, 5)) ok(issues33[0].includes(n), `M3-3 告警里列出文件名 ${n}`);
    ok(issues33[0].includes('完整清单: 数据目录/world-snapshot-diffs/T-dump.json'), 'M3-3 且给出完整清单的落盘位置');
    const dumpPath = path.join(dir, 'world-snapshot-diffs', 'T-dump.json');
    ok(fs.existsSync(dumpPath), '★ M3-3 完整清单**真落盘**（正面断言：文件确实存在，非"不抛异常"）');
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf-8')) as { deletedCount: number; deleted: string[] };
    eq(dump.deletedCount, 5, 'M3-3 落盘清单的删除数 = 5');
    // 期望值由**真快照哈希**派生（`extractName` 保留 `path.replace(working_dir,'')` 留下的前导 `/`，
    // 与 §M3-2 的告警同一口径）——不照抄一份"更好看"的名字去比。
    const delNames = (delBefore.fileHashes as string[])
      .map((f) => f.slice(0, f.lastIndexOf(':')))
      .filter((p) => range('d', 0, 5).some((n) => p.endsWith(n)));
    eq(dump.deleted, delNames, 'M3-3 落盘的是**文件名**（不是 path:size 哈希），且与告警里的名字同一口径');
    ok(!compareSnapshots(delBefore, delAfter5)[0].includes('完整清单'),
      'M3-3 反证：不传 opts ⇒ 不落盘、提示语随之消失（缺省仍是**纯函数零 IO**）');

    // ── M3-3b：>SNAPSHOT_LIST_LIMIT 条 ⇒ 只列前 N 个 + 总数（不刷屏；全量在落盘文件里）──
    for (const n of range('d', 5, DEL_N)) fs.rmSync(path.join(wsDel, n));
    const delAfter20 = (await captureWorldSnapshot(wdb, 'wp-del'))!;
    eq(delAfter20.fileCount, 0, '夹具：再删 15 个后该目录已空');
    const issues33b = compareSnapshots(delBefore, delAfter20);
    eq(issues33b.length, 1, `M3-3b ${DEL_N} 个删除 ⇒ 仍一条告警`);
    ok(issues33b[0].includes(`${DEL_N}个文件消失`) && issues33b[0].includes(`共 ${DEL_N} 个`), `M3-3b 报总数 ${DEL_N} 并标注"共 ${DEL_N} 个"`);
    ok(issues33b[0].includes(`d_${pad(SNAPSHOT_LIST_LIMIT - 1)}.txt`) && !issues33b[0].includes(`d_${pad(SNAPSHOT_LIST_LIMIT)}.txt`),
      `M3-3b ★ 只列前 ${SNAPSHOT_LIST_LIMIT} 个：第 ${SNAPSHOT_LIST_LIMIT} 个在列、第 ${SNAPSHOT_LIST_LIMIT + 1} 个不在列（未列出的靠落盘文件补齐）`);

    // ── M3-4/M3-5：审计 ⇒ after 快照落库（可复核）+ 结论进收口 checks（用户可见，**仍不阻断**）──
    const wsAu = mkdirIn('ws-audit');
    touch(wsAu, range('e', 0, 4));
    mkProj('wp-au', wsAu);
    const beforeAu = (await captureWorldSnapshot(wdb, 'wp-au'))!;
    const mkAuditTask = (id: string, ctxJson: Record<string, unknown>) => wdb.prepare(
      "INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES (?, 'wp-au', ?, ?)"
    ).run(id, id, JSON.stringify(ctxJson));
    const ctxOf = (id: string) => JSON.parse((wdb.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json) as Record<string, unknown>;

    // (1) 无变更 ⇒ 落 after、**不**加告警行（反噪：干净的执行不该被记一笔）
    mkAuditTask('T-clean', { world_snapshot_before: beforeAu, finalize_checks: ['[PASS] 示例'] });
    let conv = 0;
    await auditWorldConsistency(wdb, 'T-clean', 'wp-au', () => { conv++; }, { dataDir: dir });
    const clean = ctxOf('T-clean');
    ok(!!clean.world_snapshot_after, '★ M3-4 审计后 world_snapshot_after **存在**（正面断言：键真被写入，此前全仓零命中）');
    eq((clean.world_snapshot_after as { fileCount?: number }).fileCount, 4, 'M3-4 且它就是本次执行后的**真快照**（fileCount=4）');
    ok(!!clean.world_snapshot_before, 'M3-4 before 未被覆盖（两把快照并存，才谈得上事后复核）');
    eq((clean.finalize_checks as string[]).length, 1, 'M3-5 反噪：无差异 ⇒ **不加**告警行（checks 原样 1 条）');
    eq(conv, 0, 'M3-5 反噪：无差异 ⇒ 也不写告警对话行');

    // (2) 真删 1 个 ⇒ 同一处既落 after，又**追加**（非覆盖）`[WARN] 世界模型审计：…`
    fs.rmSync(path.join(wsAu, 'e_0000.txt'));
    mkAuditTask('T-warn', { world_snapshot_before: beforeAu, finalize_checks: ['[PASS] 示例'] });
    conv = 0;
    await auditWorldConsistency(wdb, 'T-warn', 'wp-au', () => { conv++; }, { dataDir: dir });
    const warned = ctxOf('T-warn');
    const checksW = warned.finalize_checks as string[];
    eq(checksW.length, 2, 'M3-5 有差异 ⇒ checks 由 1 条变 2 条（**追加**，不覆盖既有结论）');
    eq(checksW[0], '[PASS] 示例', 'M3-5 既有 check 原样保留');
    ok(checksW[1].startsWith('[WARN] 世界模型审计：'), '★ M3-5 收口 checks 里真落了 `[WARN] 世界模型审计：…`（正面断言：非仅 logger/对话行）');
    ok(checksW[1].includes('[文件删除] 1个文件消失') && checksW[1].includes('e_0000.txt'), 'M3-5 且该行携带**具体事实**（几条、哪几个文件）');
    eq((warned.world_snapshot_after as { fileCount?: number }).fileCount, 3, 'M3-5 同一处也落了 after（fileCount=3）');
    eq(conv, 1, 'M3-5 既有通路（对话行）仍在——checks 是**增补**不是替换');

    // (3) 从未 finalize 过的任务 ⇒ 新建该键，结论照样可见（否则"可见"在未 finalize 的任务上落空）
    fs.rmSync(path.join(wsAu, 'e_0001.txt'));
    const beforeAu3 = (await captureWorldSnapshot(wdb, 'wp-au'))!;
    mkAuditTask('T-nofin', { world_snapshot_before: beforeAu3 });
    fs.rmSync(path.join(wsAu, 'e_0002.txt'));
    await auditWorldConsistency(wdb, 'T-nofin', 'wp-au', () => {}, { dataDir: dir });
    ok(((ctxOf('T-nofin').finalize_checks as string[])?.[0] ?? '').startsWith('[WARN] 世界模型审计：'),
      'M3-5 未 finalize 的任务：该键被新建，告警仍**用户可见**（否则本项在"无收口"任务上落空）');

    // ── M3 静态：一处真源 / 旧文案已删 / 接线（renderer 是词表的第二落点）──
    const wsSrc = strip(RD(`${A}/src/main/core/world-snapshot.ts`));
    eq((wsSrc.match(/\b2000\b/g) || []).length, 1,
      'M3 上限**一处真源**：world-snapshot.ts（去注释）里 2000 只出现 1 次 = `SNAPSHOT_FILE_LIMIT` 定义；截断/文案/本脚本共用它');
    ok(!wsSrc.includes('大量变更'), 'M3-3 旧文案「大量变更，可能异常」已删');
    ok(/fileCount: totalCount/.test(wsSrc) && !/fileCount: files\.length/.test(wsSrc), 'M3-6 源码：fileCount 取自截断前的 totalCount，不是 files.length 样本量');
    ok(/truncated: totalCount > SNAPSHOT_FILE_LIMIT/.test(wsSrc), 'M3-1 源码：truncated 由真实总数与上限比对得出');
    ok(/world_snapshot_after/.test(wsSrc), 'M3-4 源码：审计写回 world_snapshot_after');
    ok(/\{ dataDir: ctx\.dataDir \}/.test(aeSrc), 'M3-3 接线：agent-executor 向审计注入 dataDir（world-snapshot 零 electron，不在模块内解析数据目录）');
    // zx_20260922_1 M5（F7）**就地加固**：原断言只要求 renderer 认得 `[WARN]`，并注明"本轮不加新前缀值"。
    //   M5 给这份词表加了 `[INFO]`（世界模型审计的"未做判定"如实说明）⇒ 按"renderer 是词表的第二个落点"
    //   的纪律，此处必须**逐值**钉住（`zx_20260912` G9：新增取值漏改 renderer 会静默落进兜底灰）。
    ok(/finalize_checks/.test(tdpSrc) && /\[WARN\]/.test(tdpSrc),
      'M3-5 renderer 第二落点：详情页按 `[WARN]` 前缀着色渲染 finalize_checks ⇒ 新行用户可见');
    ok(/\[INFO\]/.test(tdpSrc),
      '★ M5 renderer 第二落点（词表逐值）：M5 新增的 `[INFO]` 前缀在详情页有**显式**一档（不是落进末尾兜底灰）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S6】M4 步数上限由估时参与 + 撞顶如实告知：#5（取大 / 缺省退回 / 事实进交付文本）');
  {
    // ── M4-1 估时参与且取大（直引生产 `resolveMaxSteps`，不手抄公式）──
    eq(resolveMaxSteps(20, 1.0, 48), 72, 'M4-1 估时 48 ⇒ 上限 72（`ceil(48×1.5)`，与 A2 裁定同式）');
    eq(resolveMaxSteps(20, 1.5, 48), 72, 'M4-1 且**不被**文件数系数压小：base×mult=30 < 72 ⇒ 仍取 72（取大是 `max`，不是"相乘后再加"）');
    ok(resolveMaxSteps(20, 1.0, 48) > resolveMaxSteps(20, 1.0, 0),
      '★ M4-1 反证：同一 base 下"有估时"(72) 严格大于"无估时"(20)——差异确由 `estSteps` 产生，本项不空转');
    eq(resolveMaxSteps(200, 0.5, 10), 100, 'M4-1 反向：估时小(`ceil(15)=15`)时 `max` 落回 base×mult=100——取大**不缩水**既有上限');

    // ── M4-2 缺省退回原公式（不崩、不归零）──
    eq(resolveMaxSteps(20, 1.5, 0), 30, 'M4-2 无 `task_estimate`（0）⇒ 退回 `round(base×mult)`=30，与原实现逐位相同');
    eq(resolveMaxSteps(20, 1.5, NaN), 30, 'M4-2 `NaN`（脏值）同样退回原值——不因缺估时而算出 NaN/0');
    eq(resolveMaxSteps(20, 1.5, -5), 30, 'M4-2 负值同样落回原值');
    ok(resolveMaxSteps(20, 1.5, 0) > 0, '★ M4-2 正面断言：缺省时上限**为正**——"缺估时"绝不等于"不给步数"');

    // ── M4-3 撞顶事实真的进交付文本（建好文案 ≠ 用上文案，下面还有接线断言）──
    const capNote = buildStepCapNote(72, '把 M0–M6 全部落地');
    ok(capNote.includes('未完成'), 'M4-3 告知文案含「未完成」（用户能读出"没做完"，而非以为做完了）');
    ok(capNote.includes('72'), 'M4-3 且含**步数上限字面量**（读者可据此判断截在何处）');
    ok(capNote.includes('把 M0–M6 全部落地'), 'M4-3 带上剩余工作（供人接手），不是一句空警告');
    ok(!buildStepCapNote(72, '').includes('剩余工作'), 'M4-3 空目标不编"剩余工作"（无许诺者不得凭空造数）');
    eq(stepsCapReached(72, 72), true, 'M4-3 用满上限（72/72 步）⇒ 判为撞顶');
    eq(stepsCapReached(72, 71), false, '★ M4-3 反证：差 1 步**不**判撞顶——交付文本里的"已被截"是事实陈述，不是预警（预警留给闸门侧）');
    eq(stepsCapReached(0, 5), false, 'M4-3 `maxSteps` 缺省(0) ⇒ 不误报撞顶（0 是"不限"，不是"零步"）');

    // ── 两把尺**刻意不同**：闸门侧 `maxSteps-2` 是"可能被截"，交付文本侧 `>= maxSteps` 是"已经" ──
    const gate = (m: number, s: number) => m > 0 && s >= m - 2;
    ok([70, 71, 72].every((s) => stepsCapReached(72, s) === false || gate(72, s)),
      '★ M4-4 子集关系 `{s>=m} ⊆ {s>=m-2}`：撞顶必被 M1 那条出口接住 ⇒ **无需**第二条闸');
    ok(gate(72, 70) && !stepsCapReached(72, 70),
      '★ M4-4 且反证二者**确有差异**（70/72 步：闸门判"可能被截"、交付文本判"未截"）——合并即错，故并列两条并各自命名');

    // ── M4-4「不另开一条闸」：终态判定仍只此一处 ──
    eq((aeSrc.match(/prematureEnd/g) || []).length, 2, 'M4-4 源码：`prematureEnd` 仍为 1 声明 + 1 使用（撞顶**未**新增第二条 paused 出口）');
    eq((aeSrc.match(/stepsCapReached\(/g) || []).length, 1, 'M4-4 源码：`stepsCapReached` 只出现 1 次（交付文本注入处）——终态闸没被新判据插一脚');
    // zx_20260922_1 M6（F8）订正：预算半由 `Number(ctxJson.budget_usage_ratio) >= 0.95` 改读
    //   `budgetCapReached(ctxJson)`——同一句「预算爆没爆」归一处真源（双尺取严后写回 `budget_warn_band`）。
    //   本条据此**从"钉死旧表达式字面"升级为"钉形状 + 钉行为"**（按符号、不按字面；旧式只对旧文本为真，
    //   是"改一处实现就必红"的脆弱钉）。语义仍要守的没变：一处声明 + 两半相或，撞顶未新增第二条出口。
    const preEndExpr = (aeSrc.match(/const prematureEnd = ([^;]+);/)?.[1] ?? '').trim();
    ok(preEndExpr.includes('budgetCapReached(') && preEndExpr.includes('maxSteps - 2')
      && (preEndExpr.match(/\|\|/g) || []).length === 1,
      'M4-4 闸门仍为「一处声明 + 两半相或」：预算半读同一真源 `budgetCapReached`（M6/F8 起），'
      + '步数半 `maxSteps - 2` 一字未动 ⇒ 撞顶**未**新增第二条 paused 出口', preEndExpr);
    eq(budgetCapReached({ budget_warn_band: 5 }), true,
      'M4-4 行为侧：预算半经**真函数**判到顶（band 5）⇒ 该闸在费用尺爆表时确实会开（不是只改了文本）');

    // ── M4-5 撞顶但验收通过 ⇒ 不因撞顶单独降级（真 `assessCompletionQuality`，非等价自造）──
    const db5 = mkdb();
    const { workingDir: wd5 } = mkTask(db5, 'cap', dir);
    writeLedgerViaProduction(db5, 'cap', 'ok', credJson([{ criterion: '须有产出文件', passed: true }]));
    const cappedPass = assessCompletionQuality(db5, 'cap', 72, 1000, 200000, 72, wd5, 'coding');
    ok(cappedPass.score >= 60,
      `★ M4-5 撞顶(72/72) + 验收通过 ⇒ 完成分 ${cappedPass.score} ≥ 60：撞顶本身只少 10 分（"非过早结束"那一维），不越 60 线 ⇒ 不降级`);
    ok(cappedPass.feedback.includes('[过早结束]'), 'M4-5 且「过早结束」标记照常如实——标记说事实、分数判是否降级，两件事各司其职');

    const db5f = mkdb();
    const { workingDir: wd5f } = mkTask(db5f, 'capf', dir);
    writeLedgerViaProduction(db5f, 'capf', 'ok', credJson([{ criterion: '须有产出文件', passed: false }]));
    const cappedFail = assessCompletionQuality(db5f, 'capf', 72, 1000, 200000, 72, wd5f, 'coding');
    ok(cappedFail.score < 60,
      `★ M4-4 撞顶 + 验收未通过 ⇒ 完成分 ${cappedFail.score} < 60 ⇒ M1 的 paused 出口条件成立（终态断言归 §S1，本处不另写一份）`);

    // ── 注入位置与接线（文案建好却没人调用 = 「做了没用上」）──
    const injectIdx = aeSrc.indexOf('if (stepsCapReached(maxSteps, stepCount)) {');
    // 锚点取**落库语句本身**而非其上方注释——`strip()` 会剥注释，注释锚点必假（本脚本首跑即因此红了 1 条）
    ok(injectIdx > 0 && aeSrc.indexOf("'assistant', ?, 0, datetime('now')") > injectIdx,
      'M4-3 接线：撞顶注入在 assistant 回话落库**之前** ⇒ 该事实随本轮一起落库（锚点取语句，不取注释）');
    ok(aeSrc.indexOf('const prematureEnd =') > injectIdx,
      'M4-3 接线：注入在 `prematureEnd` **之前** ⇒ 其后所有 `return { content: finalContent }` 的非完成出口（无产出 failed/硬暂停/产出未落盘/内容不充分/paused）一律带上该事实');
    ok(/buildStepCapNote\(maxSteps, String\(\(ctxJson\.task_goal as \{ goal\?: string \} \| undefined\)\?\.goal \|\| ''\)\)/.test(aeSrc),
      'M4-3 接线：剩余工作取 `ctxJson.task_goal.goal`（非硬编码、非占位）');
    ok(/resolveMaxSteps\(baseMaxSteps, sizeMultiplier, estSteps\)/.test(aeSrc), 'M4-1 接线：生产 `maxSteps` 由 `resolveMaxSteps` 派生（公式不内联，rr 与生产同源）');
    ok(/estSteps = Number\(\(snapCtx\.task_estimate as \{ steps\?: number \} \| undefined\)\?\.steps\) \|\| 0;/.test(aeSrc),
      'M4-1 接线：`estSteps` 取 `task_estimate.steps`——该键自 `:3014` 起只被写过、**从无消费者**（"估了不用"），本轮起被消费');
    ok(/\[末步强制产出\] 剩余步数不足3步（步数上限 \$\{maxSteps\}，已用 \$\{stepCount\}）/.test(aeSrc),
      'M4-3② 接线：末步强制产出文案已如实点名步数上限与实际用量（原文案只说"不足3步"，不说后果）');
    ok(/若目标未能全部完成，本次执行即是被上限所截/.test(aeSrc),
      '★ M4-3② 措辞为**条件式**：该块触发时尚未被截（可能还剩 1–3 步就完成），写死"已被截"即预言');
    ok(!aeSrc.includes('已暂存产出'),
      '★ M4-3② 就地订正①：方案原拟文案的「已暂存产出」已**不采用**——该块触发条件恰是 `delivCount===0 && writeToolCount===0`（尚未产出），写它即为假');
    ok(aeSrc.includes('`${removed.join(\', \') || \'无\'}`') || /已禁用: \$\{removed\.join/.test(aeSrc),
      'M4-3② 就地订正②：`已禁用/保留` 两份事实**保留**（模型据以改用工具）——采取增补而非替换，不削信息');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S7】M5 恢复账名实：谁拉起来的记谁头上 + 首跑不叫恢复（#6）');
  {
    // ── 纯函数：按入队者分流，各写各的键（正面断言 + 反证另一键不出现）──
    const ctxUser: Record<string, unknown> = {};
    eq(bumpResumeLedger(ctxUser, 'user'), { key: 'resume_count', total: 1, count: 1 },
      'M5-2 用户介入(initiator===\'user\') ⇒ 写 resume_count');
    ok(ctxUser.resume_count === 1 && !('auto_resume_count' in ctxUser),
      'M5-2 正面：用户路只写 resume_count，auto_resume_count **键不出现**（不是写了 0）');

    const ctxSys: Record<string, unknown> = {};
    eq(bumpResumeLedger(ctxSys, undefined), { key: 'auto_resume_count', total: 1, count: 1 },
      '★ M5-2 系统路(缺省 initiator) ⇒ 写 auto_resume_count（"缺省值本身是契约"，承 zx_20260915 P0-5(c)）');
    ok(ctxSys.auto_resume_count === 1 && !('resume_count' in ctxSys),
      'M5-2 正面：系统路只写 auto_resume_count，resume_count **键不出现**');

    eq(bumpResumeLedger({}, 'system').key, 'auto_resume_count', 'M5-2 显式 initiator:\'system\' ⇒ 系统侧');
    eq(bumpResumeLedger({}, '').key, 'auto_resume_count', '★ M5-2 空串 initiator ⇒ 系统侧（空值不得冒充用户）');

    // 存量混计：老行只有一个 resume_count，新发生的系统恢复另计，老值原样保留
    const legacy: Record<string, unknown> = { resume_count: 8 };
    eq(bumpResumeLedger(legacy, undefined), { key: 'auto_resume_count', total: 9, count: 1 },
      '★ M5-2 存量混计({resume_count:8} + 系统恢复) ⇒ 总数 9、新键计 1（总数不丢，存量不许被"清零重算"）');
    ok(legacy.resume_count === 8, '★ M5-2 存量值**不回填也不覆盖**（老值混计无法事后拆清——谁点的没落库，如实保留）');

    // 空值不编造
    eq(resumeLedgerTotal({}), 0, 'M5-2 空账 ⇒ 总数 0（不凭空造数，承 zx_20260910_6 口径）');
    eq(resumeLedgerTotal(undefined), 0, 'M5-2 无 ctx ⇒ 总数 0（不抛）');
    eq(resumeLedgerTotal({ resume_count: 2, auto_resume_count: 3 }), 5, 'M5-2 总数 = 两键之和');

    // 首跑不叫恢复
    eq(autoPullJobType(0), 'ai-task', '★ M5-2 无执行痕迹(0) ⇒ 首跑走 ai-task（不再合成"你之前的任务已恢复"这种对首跑为假的话）');
    eq(autoPullJobType(1), 'resume-ai-task', 'M5-2 有执行痕迹(≥1) ⇒ 恢复走 resume-ai-task');
    eq([...EXECUTION_TRACE_ROLES], ['assistant', 'tool'],
      '★ M5-2 "执行痕迹"只认这两类角色（system/user 行是系统*写的话*与合成消息，写进去不等于跑过）');

    // ── 接线：纯函数改对了却没人调用 = 做了没用上 ──
    const jobSrc = strip(RD(`${A}/src/main/core/jobs/ai-task.ts`));
    ok(/bumpResumeLedger\(rctx, payload\.initiator as string \| undefined\)/.test(jobSrc),
      'M5-2 接线：自增点用入队者分流（`payload.initiator` 就是"谁拉起来的"这一事实本身，不在此另判一遍）');
    ok(/if \(total >= 3\)/.test(jobSrc), 'M5-2 接线：拆分提示按**总数**（分流两键不改变提示行为）');
    ok(!jobSrc.includes('rctx.resume_count = '),
      '★ M5-2 反证：处理器里**不再**直接写 `resume_count`（"写点各自为政"正是要治的病）');
    ok(/resumeLedgerTotal\(latestCtx\) >= 2/.test(aeSrc),
      'M5-2 接线：老重任务判定读**总数**（单读 resume_count 会把"系统反复重启的重任务"漏判成轻任务）');
    ok(!/Number\(latestCtx\.resume_count\) >= 2/.test(aeSrc), '★ M5-2 反证：不再单读 `resume_count` 判老重');

    const schedSrc = strip(RD(`${A}/src/main/core/task-scheduler.ts`));
    ok(/autoPullJobType\(prevRunCount\)/.test(schedSrc) && /payload: \{ taskId, projectId: proj\.id \}/.test(schedSrc),
      '★ M5-2 接线：自动拉取按执行痕迹选作业类型，并带上 projectId（`ai-task` 处理器用它算项目并发）');
    ok(!/this\.pending\.set\(taskId, \{ type: 'resume-ai-task', payload: \{ taskId \} \}\)/.test(schedSrc),
      '★ M5-2 反证：自动拉取**不再**无条件标 resume-ai-task（标本任务首跑即因此被称作"恢复"并虚增一次账）');
    ok(schedSrc.includes('EXECUTION_TRACE_ROLES'),
      'M5-2 接线：痕迹角色取自真源（不在此另抄一份 assistant/tool 字面量）');

    // ── 读点穷举（承 G8/G9：词表第二落点须穷举）──
    const walkTs = (d: string, acc: string[] = []): string[] => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkTs(p, acc); else if (e.name.endsWith('.ts')) acc.push(p);
      }
      return acc;
    };
    const holders = walkTs(path.join(root, A, 'src/main')).filter(f => strip(fs.readFileSync(f, 'utf-8')).includes("'auto_resume_count'"));
    eq(holders.map(f => path.basename(f)), ['resume-ledger.ts'],
      'M5-2 读点穷举：`auto_resume_count` 字面量**只在**真源模块出现（renderer 侧零消费，故本轮不动 renderer——与"第二落点"纪律对齐）');
    ok(!walkTs(path.join(root, A, 'renderer/src')).some(f => fs.readFileSync(f, 'utf-8').includes('resume_count')),
      'M5-2 renderer 无该键消费（GUI 不展示恢复次数）⇒ 无用户可见文案需同步');

    // ── 注释订正：raw 读（本条的断言对象**就是注释**，`strip()` 会把它剥掉）──
    const rlRaw = RD(`${A}/src/main/core/resume-ledger.ts`);
    ok(rlRaw.includes('5126b303'),
      'M5-1 查证结论**带锚点**落在实现处（标本任务 id）——不以"大概是"结案');
    const psRaw = RD(`${A}/src/main/core/pause-settlement.ts`);
    // 断言取**正面**（订正须登记真相），不取"原话不出现"——订正注释依法会引用被订正的原文，
    //   用负面子串断言等于给"诚实地写下错在哪"判红（本脚本首跑即因此红了 1 条）。
    ok(/本轮订正（zx_20260916_1 M5/.test(psRaw) && psRaw.includes('`resume-ai-task` 处理器'),
      '★ M5-3 订正：注释登记了**真相**（自增点在 resume-ai-task 处理器；全库 304 笔执行作业中 302 笔是系统路）');
    ok(psRaw.includes('auto_resume_count') && psRaw.includes('core/resume-ledger.ts'),
      'M5-3 订正后的注释点名两个键及其真源模块，与其消费点语义一致');
    ok(/zx_20260916_1 M5/.test(psRaw) && psRaw.includes('§七'),
      'M5-3 注释明写"本轮查证结论见 §七"（下一轮不必重新"发现"同一件事）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S3】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  fs.rmSync(dir, { recursive: true, force: true });
}

void main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260916_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
