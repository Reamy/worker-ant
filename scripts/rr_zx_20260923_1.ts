/**
 * zx_20260923_1 受控复跑 —— 「没判成 ≠ 判过了」。
 *
 * 一节对应方案 `plans/improve/zx_20260923_1.md` 一段，判据逐条照 §3 落：
 *   §S1 M1「账本守卫：非结论不得覆盖结论」——**直引真实现**（`maySupersedeLedger` +
 *        `persistAcceptanceCheck` 的真读回语义），并经**生产写账链**（`decideAcceptanceOutcome` →
 *        `recordAcceptanceOutcome` / `recordProposedCheck`）走一遍，不拿手造载荷冒充"账"：
 *        (a) 拦：账上 `verified:true`（真结论）⇒ `error`/`no_json`/代拟 一律**不得**顶掉它；
 *        (b) 放：`failed` → `passed`（改好了重判）**依然走得通**——守卫拦的是"非结论覆盖结论"，
 *            不是"结论更新结论"（这条是 (a) 的反证，防守卫过宽把正常重判也锁死）；
 *        (c) 旧账**不是结论**（缺席 / `verified:false`）⇒ 一律放行（任何新账都比"没判成"强）；
 *        (d) 存量兼容：老载荷（无 `verified` 字段但有 `checked_at`）**算结论**，同样受守卫保护；
 *        (e) 读回语义：被拦下时 `persistAcceptanceCheck` 返回**旧账**，调用方据此知道"我这笔没落上"。
 *   §S2 M2「有题未判成」独立一态 ——
 *        (f) 词表一处真源：六码**由 `UNVERIFIED_REASON_LABEL` 派生**后分两类（不在此另抄清单）；
 *        (g) ★ 标本案型的硬断言：`verified:false/reason:'error'` ⇒ `unjudged`（真库 `a290ae2b` 正是此形）；
 *        (h) 不压分：`capScoreByAcceptanceVerdict(_, 'unjudged')` **逐位等于**无账基线，
 *            且真 `assessCompletionQuality` 的完成分**逐位等于**基线（处置在终态层，不在评分层）；
 *        (i) 因由词表：`PAUSE_REASON_ACCEPTANCE_UNJUDGED` 有 label、与 `acceptance_failed` **不同名**，
 *            且 `isChildrenIncompletePause` 对它返回 **false**（不被当作可自愈的时序暂停 ⇒ 后继继续被拦）；
 *        (j) ★ 反证：`no_criteria`/`no_user_criteria`/`output_insufficient` 仍读 `not_checked`
 *            （A4 的理据**只覆盖"没有题目"**，不得扩大打击面）。
 *   §S3 M2 终态层（`exec-finalize.ts` 静态切块）——
 *        (k) `unjudged` 分支在场、**先于**"标完成"落笔、经唯一写入口 `pauseTask` 置暂停、**不压分**、
 *            且**不写第二版账**；
 *        (l) 分支次序：`failed` 在前、`unjudged` 在后（顺序倒了 `unjudged` 会把 `failed` 吞掉）。
 *   §S4 M3 renderer 第二落点 ——
 *        (m) 直引 `isUnjudgedReason`（不另抄三码清单）+ 分型分支在场；
 *        (n) 「产出物」「对话历史」`useState(false)` 默认折叠，且折叠**真接线**（按钮切换 + 条件渲染）；
 *        (o) 产出物块**移位**：`{delivsBlock}` 出现在「事件时间线」锚点**之前**，且清单五处标注一字未丢。
 *   §S5 build 钉（派生核对，不写轮次字面量）。
 *
 * ⚠ 承 feedback「rr 夹具须按生产初始化顺序」：本文件夹具 DDL 逐列照抄 `database.ts`；计数器一律给
 *   "0→1"正面断言（见 §S1 的"落账前 0 / 落账后 1"）。
 * ⚠ 承 feedback「断言里不得写只为下一轮的字面量」：本文件不以轮次字面量做等值断言；词表一律**派生**
 *   （`UNVERIFIED_REASON_LABEL` 的键集），build 钉由 `scripts/lib/rr-pins.ts` 派生核对（§S5）。
 * ⚠ 本文件**不打开真库**（真库只读实测见方案 §1.1）；§S5 读 `dist` ⇒ tsup 须先于本脚本。
 * ⚠ 本文件的静态切块锚点**一律按符号**（`if (closeVerdict === …)` / `UPDATE …`），不按行号。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  acceptanceVerdictOf, capScoreByAcceptanceVerdict, maySupersedeLedger, isUnjudgedReason,
  proposeAcceptanceCriteria,
  UNJUDGED_REASONS, UNVERIFIED_REASON_LABEL,
  decideAcceptanceOutcome, recordAcceptanceOutcome, recordProposedCheck,
  type AcceptanceCheckPayload, type AcceptanceUnverifiedReason,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { assessCompletionQuality } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import {
  PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_ACCEPTANCE_UNJUDGED, PAUSE_REASON_LABEL, isChildrenIncompletePause,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';

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
function mkTask(db: AnyDb, id: string, dir: string, criteria = ''): { file: string; workingDir: string } {
  const workingDir = path.join(dir, `${id}-wd`);
  fs.mkdirSync(workingDir, { recursive: true });
  const file = path.join(workingDir, 'A_out.md');
  fs.writeFileSync(file, '# 产出\n' + 'x'.repeat(1200));
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, source, acceptance_criteria, context_json)
              VALUES (?, 'p', ?, '', 'completed', 'test', ?, '{}')`).run(id, id, criteria);
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
const readLedger = (db: AnyDb, id: string): unknown =>
  (JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json) as { acceptance_check?: unknown }).acceptance_check;

/** 只写关心的几个键、其余取中性缺省——供**守卫本身**（纯谓词）的单点判据使用。 */
const payloadOf = (o: Partial<AcceptanceCheckPayload> & { checked_at: string }): AcceptanceCheckPayload =>
  ({ verified: false, criteria_total: 0, passed_total: 0, passed: [], failed: [], ...o });

async function main(): Promise<void> {
  const feSrc = strip(RD(`${A}/src/main/core/exec-finalize.ts`));
  const tdpRaw = RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  const tdpSrc = strip(tdpRaw);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx231-'));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1a】M1 账本守卫：非结论不得覆盖结论（真写链 · 真回读）');
  {
    const db = mkdb();
    mkTask(db, 'g', dir);
    eq(readLedger(db, 'g'), undefined, '前置：落账前 `acceptance_check` **不在账上**（0）');

    // 账上先落一笔**真结论**：10 条判据 2 通过（真库标本 `a290ae2b` run-2 的形态）
    const first = writeLedgerViaProduction(db, 'g', 'ok', credJson([
      { criterion: '须提供回测记录', passed: true },
      { criterion: '须有提交哈希', passed: false, reason: '未提供提交哈希' },
    ]));
    eq([first.verified, first.criteria_total, first.passed_total], [true, 2, 1], '前置：真结论落上（2 条 1 通过）');
    ok(readLedger(db, 'g') !== undefined, '① 落账 **0→1**（正面断言：值从"无"变为一份载荷）');
    eq(acceptanceVerdictOf(readLedger(db, 'g')), 'failed', '① ★ 闭环：**生产写的那笔账**经**生产读判据**读出 `failed`');

    // ① 拦：核对异常（error）**不得**顶掉它——真库标本正是这样被洗成"没证据"的
    const kept = writeLedgerViaProduction(db, 'g', 'exception', null);
    eq([kept.verified, kept.passed_total], [true, 1], '① ★ 返回的是**账上生效的那一笔**（读回语义：旧账，仍 2 条 1 通过）');
    eq(acceptanceVerdictOf(readLedger(db, 'g')), 'failed', '① ★ 账上仍是 `failed`——一次"没有结论"没能拔掉一条"有结论"');
    eq(readLedger(db, 'g'), kept, '① 库里的账与回传值**同物**（不是"回传旧账但库里已改"）');

    // ② 拦：没吐 JSON（no_json）同样不得顶掉
    eq(acceptanceVerdictOf(writeLedgerViaProduction(db, 'g', 'ok', '模型的自由散文，无 JSON')),
      'failed', '② `no_json` 亦被拦（成因不同、结论相同：都不是结论）');
    // ③ 拦：无可用模型（no_model）同样不得顶掉
    eq(acceptanceVerdictOf(writeLedgerViaProduction(db, 'g', 'no_model', null)),
      'failed', '③ `no_model` 亦被拦（"模型不在场"同样不构成对旧结论的否定）');
    // ④ 拦：代拟（恒 verified:false）不得顶掉真结论——判据由**真代拟器**出，不手造
    const proposed = recordProposedCheck(db, 'g', proposeAcceptanceCriteria({
      title: '方案写入指定路径 docs/plan.md', description: '',
      deliverables: [{ name: 'A_out', file_path: path.join(dir, 'g-wd', 'A_out.md') }],
      pathExists: () => true,
    }));
    eq([proposed.verified, proposed.passed_total], [true, 1], '④ 代拟被拦：账上仍是那笔真结论（代拟的"自核通过"不得冒充验收结论）');
    eq(acceptanceVerdictOf(readLedger(db, 'g')), 'failed', '④ ★ 且判据仍读 `failed`');

    // ⑤ 放：failed → passed（改好了重判）**走得通**——守卫的反证
    const fixed = writeLedgerViaProduction(db, 'g', 'ok', credJson([
      { criterion: '须提供回测记录', passed: true }, { criterion: '须有提交哈希', passed: true },
    ]));
    eq([fixed.verified, fixed.criteria_total, fixed.passed_total], [true, 2, 2], '⑤ ★ 反证：真结论**可以**更新真结论（`failed` → `passed` 未被守卫锁死）');
    eq(acceptanceVerdictOf(readLedger(db, 'g')), 'passed', '⑤ 账上读到 `passed`（结论更新结论，一路放行）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1b】M1 守卫的边界：旧账"不是结论" ⇒ 一律放行 + 存量老载荷算结论');
  {
    const db = mkdb();
    mkTask(db, 'h', dir);
    // 旧账 = 没判成（error）
    writeLedgerViaProduction(db, 'h', 'exception', null);
    eq(acceptanceVerdictOf(readLedger(db, 'h')), 'unjudged', '前置：第一笔即"没判成"（`unjudged`）');
    // 新账 = 真结论 ⇒ 必须放行（任何新账都比"没判成"强）
    const then = writeLedgerViaProduction(db, 'h', 'ok', credJson([{ criterion: 'a', passed: false, reason: 'r' }]));
    eq([then.verified, then.criteria_total, then.passed_total], [true, 1, 0], '★ 旧账非结论 ⇒ **放行**（"没判成"不得挡住后来的真结论）');
    eq(acceptanceVerdictOf(readLedger(db, 'h')), 'failed', '★ 且账上已是新结论（`unjudged` 未被当成"钉子户"）');

    // 另一路：旧账非结论 ⇒ 新账也是非结论，同样放行（成因要能更新，否则永远停在第一因）
    const db2 = mkdb();
    mkTask(db2, 'h2', dir);
    writeLedgerViaProduction(db2, 'h2', 'no_model', null);
    const later = writeLedgerViaProduction(db2, 'h2', 'exception', null);
    eq([later.verified, later.reason], [false, 'error'], '★ 非结论**可以**更新非结论（"这轮为什么没判成"该是最近一次的原因）');

    // 存量兼容：老载荷（无 `verified` 字段，但有 `checked_at` + 计数）**算结论**
    const legacy: AcceptanceCheckPayload = { checked_at: '2026-09-01T00:00:00.000Z', criteria_total: 3, passed_total: 0 } as AcceptanceCheckPayload;
    eq(maySupersedeLedger(legacy, payloadOf({ checked_at: 't', reason: 'error' })),
      false, '★ 存量：老载荷（无 `verified`）**算结论**，同样受守卫保护（口径同 `isAcceptanceVerified`）');
    eq(maySupersedeLedger(legacy, payloadOf({ checked_at: 't', verified: true, criteria_total: 3, passed_total: 3 })),
      true, '★ 存量：但它**可以被新结论取代**（改好重判的路对老任务同样开着）');
    eq(maySupersedeLedger(undefined, payloadOf({ checked_at: 't', reason: 'error' })),
      true, '★ 无账 ⇒ 放行（守卫不拦第一次落账）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S2a】M2 「有题未判成」一态：词表一处真源 + 两侧分流');
  {
    // 词表**派生**：不在此另抄六码清单——直接取 `UNVERIFIED_REASON_LABEL` 的键集（真源即它的类型）
    const allReasons = Object.keys(UNVERIFIED_REASON_LABEL) as AcceptanceUnverifiedReason[];
    ok(allReasons.length >= 6, `前置：成因词表共 ${allReasons.length} 码（六码为 zx_20260916 在册值）`);
    eq(allReasons.filter(isUnjudgedReason).sort(), ['error', 'no_json', 'no_model'],
      '★ M2 正面断言：「有题未判成」恰这三码（从真源派生，多一个即误伤"无人许诺判据"的规划类任务）');
    eq([...UNJUDGED_REASONS].slice().sort(), ['error', 'no_json', 'no_model'],
      '★ 且词表常量 `UNJUDGED_REASONS` 与判定函数**同物**（一处真源，非两处手抄）');
    const notJudged = allReasons.filter((r) => !isUnjudgedReason(r));
    ok(notJudged.includes('no_criteria') && notJudged.includes('no_user_criteria') && notJudged.includes('output_insufficient'),
      '★ 反证：`no_criteria`/`no_user_criteria`（**没有题目**）与 `output_insufficient`（内容闸自己的处置）**不**进此支',
      notJudged.join('/'));
    eq(isUnjudgedReason(null), false, '缺 reason ⇒ 不判成 `unjudged`（"没说为什么"不编成因）');
    eq(isUnjudgedReason(undefined), false, '未核验但成因缺席（存量）⇒ 仍读 `not_checked`（不回溯加罪）');

    // 判定两侧：经真 `acceptanceVerdictOf`（不是只看词表函数）
    const mk = (reason: AcceptanceUnverifiedReason) => ({ checked_at: 't', verified: false, reason, criteria_total: 0, passed_total: 0 });
    eq(allReasons.map((r) => acceptanceVerdictOf(mk(r))), allReasons.map((r) => (isUnjudgedReason(r) ? 'unjudged' : 'not_checked')),
      '★ 判定**委托**词表（同一真源：判定函数与渲染层读的是同一个 `isUnjudgedReason`，不各写一份）');
    eq(acceptanceVerdictOf(mk('error')), 'unjudged',
      '★ 标本案型（真库 `a290ae2b`：`verified:false` + `reason:error` + 判据 348 字）⇒ **`unjudged`**');
    eq(acceptanceVerdictOf({ checked_at: 't', verified: true, criteria_total: 10, passed_total: 2 }), 'failed',
      '★ 对照：同题真判过（10 条 2 通过）⇒ `failed`——"判了没达标"与"没判成"**不得同名**（两个出口处置不同）');
    eq(acceptanceVerdictOf({ checked_at: 't', verified: true, criteria_total: 2, passed_total: 2 }), 'passed', '对照：全达成 ⇒ `passed`');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S2b】M2 不压分（处置在终态层，不在评分层）+ 因由词表');
  {
    eq(capScoreByAcceptanceVerdict(95, 'unjudged'), 95, '★ 「没判成 ≠ 没达成」：`unjudged` **不压分**（压降只对 `failed` 动作）');
    eq(capScoreByAcceptanceVerdict(95, 'not_checked'), 95, '对照：`not_checked` 也不压分（A4 原样）');
    ok(capScoreByAcceptanceVerdict(95, 'failed') < 60, '对照：`failed` 仍压到 60 分以下（本轮的"不压分"没有顺手松开它）');

    // 真实现侧：带判据的任务核对 error ⇒ 完成分**逐位等于**无账基线，但 feedback **点名**该态
    const db = mkdb();
    const { workingDir } = mkTask(db, 'u', dir, '1. 须提供回测记录\n2. 须有提交哈希');
    eq(quality(db, 'u', workingDir).score, BASE_SCORE, '前置：无账基线分 = 95（压降一旦生效必现形）');
    writeLedgerViaProduction(db, 'u', 'exception', null);
    const q = quality(db, 'u', workingDir);
    eq(q.score, BASE_SCORE, '★ 真 `assessCompletionQuality`：`unjudged` 的完成分**逐位等于**基线（不是"少压一点"）');
    ok(q.feedback.includes('验收未判成') && !q.feedback.includes('验收未通过'),
      '★ 且 `feedback` **点名**该态而非"压了分却说没事"（文案与实际同源，不许静默）');
    ok(q.feedback.includes('未压分'), '★ 且明写"未压分"——用户读得出"分没降 ≠ 判过了"', q.feedback.slice(0, 80));

    // 因由词表（renderer/main 共用同一 label 表）
    const lbl = PAUSE_REASON_LABEL[PAUSE_REASON_ACCEPTANCE_UNJUDGED];
    ok(typeof lbl === 'string' && lbl.length > 0, `★ 因由有 label：${lbl}`);
    ok(lbl !== PAUSE_REASON_LABEL[PAUSE_REASON_ACCEPTANCE_FAILED],
      '★ 且与 `acceptance_failed` 的 label **不同名**（"判了没达标"与"没判成"要人做的事不同：核验产出 vs 恢复重跑）');
    ok(PAUSE_REASON_ACCEPTANCE_UNJUDGED !== PAUSE_REASON_ACCEPTANCE_FAILED
      && PAUSE_REASON_ACCEPTANCE_UNJUDGED === 'acceptance_unjudged', '因由码独立且落库值稳定');
    eq(isChildrenIncompletePause(JSON.stringify({ pause_reason: PAUSE_REASON_ACCEPTANCE_UNJUDGED })), false,
      '★ 且**不**被当作可自愈的时序暂停（否则调度器会把它当"等子任务"自动放行，后继继续被拦这条就落空了）');
    eq(isChildrenIncompletePause(JSON.stringify({ pause_reason: PAUSE_REASON_ACCEPTANCE_FAILED })), false,
      '对照：`acceptance_failed` 同样 false（两个验收暂停点同尺）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S3】M2 终态层：`exec-finalize.ts` 的 `unjudged` 分支在场且不标完成（静态切块）');
  {
    const failedIdx = feSrc.indexOf("if (closeVerdict === 'failed') {");
    const unjudgedIdx = feSrc.indexOf("if (closeVerdict === 'unjudged') {");
    const completedIdx = unjudgedIdx > 0 ? feSrc.indexOf("UPDATE wa_tasks SET status = 'completed'", unjudgedIdx) : -1;
    ok(failedIdx > 0 && failedIdx < unjudgedIdx,
      '★ 分支次序：`failed` 在前、`unjudged` 在后（顺序倒了 `unjudged` 会把 `failed` 吞掉——同一份账只该被读一次）');
    ok(unjudgedIdx > 0 && completedIdx > unjudgedIdx,
      '★ 新分支**先于**"标完成"落笔（顺序倒了这闸就是摆设）');
    const blk = (unjudgedIdx > 0 && completedIdx > unjudgedIdx) ? feSrc.slice(unjudgedIdx, completedIdx) : '';
    ok(blk.length > 0, '前置：切到块（空块会让下面每条判据都空转）', `${blk.split('\n').length} 行`);
    ok(blk.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_ACCEPTANCE_UNJUDGED'),
      '★ 该分支经唯一写入口 `pauseTask` 置 `paused`（不是 `completed`），且因落 `acceptance_unjudged`');
    ok(/pauseTask\(db, \{[^)]*note:/.test(blk), '★ 并登记暂停因由（`note` 随 `pauseTask` 一并落，与其余暂停点同尺，不静默）');
    ok(!/completion_quality\s*=/.test(blk),
      '★ **不写第二版账**（承 zx_20260916_3 M4：一份 `context_json` 内只许一版账，该分支只置暂停与如实告知）');
    ok(!blk.includes('capScoreByAcceptanceVerdict') && !/Math\.min\([^)]*45/.test(blk),
      '★ **不压分**（压降只对 `failed` 动作——评分层与终态层各司其职，不是两本账）');
    ok(blk.includes('UNVERIFIED_REASON_LABEL'),
      '★ 如实告知**点名成因**（"没判成"要说出为什么没判成，用户才知道做什么）');
    ok(blk.includes('wa_task_conversations'),
      '★ 且落一条会话行（详情页/IM 可见，不只在日志里）');
    ok(feSrc.includes('PAUSE_REASON_ACCEPTANCE_UNJUDGED'), '接线：因由常量已 import 进本模块（未 import 则上面那句根本编译不过，此处为显式在册）');
    const verdictSites = feSrc.split('closeVerdict').length - 1;
    ok(verdictSites >= 4, `★ 判据取自 closeVerdict（由 acceptanceVerdictOf 派生，非本处另判一遍），实测出现 ${verdictSites} 次`);
    ok(!/passed_total\s*<\s*criteria_total/.test(feSrc),
      '★ 判据唯一：本文件**无**手写的三态比较（同一规则两处手抄即分叉之源）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S4a】M3 renderer 第二落点：直引真源 + 分型分支');
  {
    ok(/import \{[^}]*isUnjudgedReason[^}]*\} from '[^']*core\/acceptance-check\.js'/.test(tdpSrc),
      '★ renderer **直引** `isUnjudgedReason`（跨 root 引纯 main 模块；不另抄一份三码清单）');
    ok(tdpRaw.includes('未核验不等于通过'),
      '★ 未判成分支的如实文案在场（**中文串**核对——minify 会丢标识符，故按文案核）');
    ok(/isUnjudgedReason\(acceptanceCheck\.reason\)/.test(tdpSrc),
      '★ 且 分型**按真源函数**判（不是"内容里有没有某个词"的就地正则）');
    const unknownIdx = tdpSrc.indexOf('ACCEPTANCE_REASON_LABEL[');
    ok(unknownIdx > 0, '且成因文案经 label 表转写（不把 error/no_json 这类机器码直接甩给用户）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S4b】M3 默认折叠（真接线）+ 产出物上移至事件时间线之前');
  {
    ok(/const \[showDelivs, setShowDelivs\] = useState\(false\)/.test(tdpSrc), '★ 「产出物」默认折叠（`useState(false)`）');
    ok(/const \[showConvs, setShowConvs\] = useState\(false\)/.test(tdpSrc), '★ 「对话历史」默认折叠（`useState(false)`）');
    ok(/onClick=\{\(\) => setShowDelivs\(\(v\) => !v\)\}/.test(tdpSrc) && /onClick=\{\(\) => setShowConvs\(\(v\) => !v\)\}/.test(tdpSrc),
      '★ 折叠**真接线**：两块各有点击切换（默认折叠 ≠ 折叠不起来）');
    ok(/showDelivs && <div/.test(tdpSrc) && /showConvs && <div/.test(tdpSrc),
      '★ 且内容按状态条件渲染（有开关无消费＝假折叠）');
    // zx_20260929 M7 **就地订正（钉更强真源，非放宽）**：文案由「（本任务及子任务 · N 条）」改为
    //   「本任务（含子任务）N 条」——与项目页「产出物（项目合计）」取名言清，消「同名不同分母」
    //   （子树聚合 / 项目级合计 / primary∪verified 三种分母此前共用一个词）。
    // zx_20260930 M4-1+M4-2 **再订正（同样钉更强真源，非放宽）**：计数表达式由 `{delivs.length}` 改为
    //   `{delivTotal}`——M4-1 把计数收敛到**一处真源**、M4-2 给详情页上了分页，此后 `delivs` 只是
    //   **已加载的那一页**，拿它的 length 当"共几条"是假账；`delivTotal` 直取 `task:get` 的
    //   `deliverablesTotal`（子树聚合），才是折叠头该报的那个数。钉住的仍是**那个真源表达式**，
    //   （文案换了却漏掉条数，一样红）。
    ok(tdpSrc.includes('本任务（含子任务）{delivTotal} 条'),
      '★ 折叠头报**条数**（折叠态下若连有几条都看不见，那叫"默认消失"不叫"默认折叠"）；'
      + '且取名言明分母（与项目页「产出物（项目合计）」不是同一把尺）');

    const blkIdx = tdpSrc.indexOf('const delivsBlock = delivs.length > 0 && (');
    const useIdx = tdpSrc.indexOf('{delivsBlock}');
    // ⚠ zx_20260924 §2c UI-2 **就地订正**：时间线由 `<h4>事件时间线</h4>` 改为**可折叠标题钮**
    //   （用户 2026-09-24 点名"事件时间线增加折叠"），旧锚点（`事件时间线</h4>`）已随之下线。
    //   改锚在**折叠开关的函数身份**上（`setShowEvents` 接线）——它比文案稳：文案会改，接线不会。
    const tlIdx = tdpSrc.indexOf('setShowEvents((v) => !v)');
    ok(blkIdx > 0 && useIdx > blkIdx, '前置：产出物块**抽成变量**后再引用（移动的是位置，不是内容）');
    ok(useIdx > 0 && tlIdx > 0 && useIdx < tlIdx && tdpSrc.includes('事件时间线 ('),
      '★ 移位成立：`{delivsBlock}` 渲染在「事件时间线」**之前**（用户 2026-09-23 点名；锚点=折叠开关接线 + 标题仍在场，防锚点空转）',
      `delivs@${useIdx} < timeline@${tlIdx}`);
    // 只搬「产出物」一块：整体次序为 **产出物验证 → 产出物 → 事件时间线**（前者一步未动）
    const ovIdx = tdpSrc.indexOf('产出物验证 (');
    ok(ovIdx > 0 && ovIdx < useIdx && useIdx < tlIdx,
      '★ 且只搬了「产出物」一块——「产出物验证」仍在原位（用户裁定：只移一块，不牵连邻块）',
      `验证@${ovIdx} < 产出物@${useIdx} < 时间线@${tlIdx}`);
    // 清单内部五处标注一字未丢（搬的是"位置"，不是"内容"）
    // ⚠ zx_20260924 §2c UI-3 **就地订正**：产出物由"一维平铺"改为"按盘上路径分目录层级"，
    //   五行标注随之**抽到共用行渲染器 `delivRow`**（目录树叶子与「无盘上路径」桶共用同一行——
    //   两处各写一份标注正是本仓 G8 老病）。故扫描面由 `[blkIdx, useIdx)` 前移到 `[delivRow 定义, useIdx)`：
    //   钉的仍是"一字未丢"，只是把落点跟着代码走（不是放宽——下方另加钉"两处确实共用同一个渲染器"）。
    const rowIdx = tdpSrc.indexOf('const delivRow = (d: DelivItem, depth: number) => (');
    const blkText = (rowIdx > 0 && useIdx > rowIdx) ? tdpSrc.slice(rowIdx, useIdx) : '';
    ok(['主要成果', '✓已验收', '另有 ', 'owner_task_id', '子任务 '].every((s) => blkText.includes(s)),
      '★ 清单五处标注（类型/主要成果/归属/已验收/另有写过）随块整体搬移，一字未丢',
      ['主要成果', '✓已验收', '另有 ', 'owner_task_id', '子任务 '].filter((s) => !blkText.includes(s)).join(',') || '全在');
    ok(/delivRow\(c\.item, depth\)/.test(tdpSrc) && /delivRow\(d, 0\)/.test(tdpSrc),
      '★ 且 目录树叶子与「无盘上路径」桶**共用同一个行渲染器**（各自手写一份行标注＝分叉之源）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S5】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  fs.rmSync(dir, { recursive: true, force: true });
}

void main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260923_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
