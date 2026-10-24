/**
 * zx_20260915 受控复跑 —— M1（P0-1 完成闸门 + P0-2 验收三态 + P0-8 收尾门）
 * 与 M2（P0-3 失败必带因 + P0-4 通知与状态同源）。
 *
 * 各段对应方案一节，判据逐条照 §1.6 / §2.5 / §8.5 / §3.4 / §4.3 落：
 *   §S1  P0-1「无产出证据不得自称完成」——两路：
 *        (a) run_close 自动收口路：**直引 `blockNoOutputCompletion` 真实现**（不切片、不复刻判据），
 *            连同三类豁免（conversation / 有子任务 / 开关关）与两类"有产出"各出一条**反证**（防误伤）；
 *        (b) update_task_status 路：**经 `buildTools` 造真工具、调真 execute**，验三态文案可区分且守"不硬拦"裁定。
 *   §S2  P0-2「没标准 ≠ 通过」——四出口载荷 `verified` 布尔 + 派生的第三态 + 五处自建任务 INSERT 带列。
 *   §S3  P0-8「择主不按时序 / 临时产出物检出要处置」——`autoAssignPrimary` 与探针处置跑真实现。
 *   §S5  P0-3「失败必带因 · 子任务失败不得被父静默吸收」——载荷下界五键 / `recordExecutionFailure` 真实现
 *        （DB status 0→1 + `task.failed` 事件 0→1 + `error` 非空）/ 四态不被翻账 / 收口闸与工具路同果 /
 *        D1 的**防死锁**闭合（失败子重试为 completed ⇒ 父自动恢复、`resume-ai-task` 作业 0→1）。
 *   §S6  P0-4「通知与任务状态同源」——`buildTaskNotice` 可判定证据（**故意错报 kind，输出仍说账上的话**）、
 *        暂停因由 `ctx.pause_reason` 派生、回退开关语义、按族反向静态扫描（7→0 / 3→0）。
 *   §S7  P0-5「答有痕 · 继续≠同意」——**真 eventBus + 真 EventStore**：答复落 `wa_event_log` 0→1、
 *        `ctx.answer_source` 分 gui/im、事件 `asked_at` 与落账同源；**反证**「无聚合映射 ⇒ 0 行」；
 *        守卫（`buildUnansweredBanner` / `composeResumeInput` 真实现）四条反证 + 三注入规则；
 *        IM「启动」类恢复**不**落答复账；cron 的 `pending` 转移补事件 0→1。
 *   §S8  P0-6「暂停/偏离通知到得了人」——**真 `notification-core`（零 electron，故可直引）+ 真 eventBus**：
 *        `status_changed{paused|failed}` 与 `task.goal_deviation` 各使通知面 0→1（**正面断言**）；
 *        夹具**一律不绑 IM 渠道**（这正是要证的场景）；未读由 1→0（处置即已读）；回退开关关 ⇒ 0 行；
 *        写失败计数 0→1（防吞）；`buildDeviationPrompt` 出口不再截断 · 写豁免与
 *        `realOutputEvidence` 同源（手写字面量计数为 0）。
 *   §S10 P0-9「里程碑不得挂在非规划任务上、不得重复挂板」——**真工具 `finalize_task` · 真 execute**：
 *        核验类任务不置 `plan_milestones_registered` + 总数 **0→0**（真库 8a6f226a 的复现）；
 *        **核验优先于规划**（两套词同时命中仍不登记——8a6f226a 的真实标题即此形态）；
 *        板内幂等（M0 已在板上 ⇒ 板行 +1 而非 +2，既有行原样保留，如实点名归属任务）；
 *        **跨板同名不跳过**（「每轮一块新板」是全部 21 块板的成因，这条是乙-① 的正面证据）；
 *        防误伤三例（板上无同名照旧登记 / `research` 不排除 / archetype 缺失放行）；
 *        `scheme_ref_mode='reference'` ⇒ 不创建、不置"待实施"；开关关 ⇒ 逐例回到旧行为；
 *        静态真源（两套词同处 `task-accounting.ts`）+ 旧裸正则删除证明 + 四组合对拍
 *        （新旧判据**两向如实**：既收窄也放松，不假装只有一向）。
 *
 * ⚠ 承 feedback「rr 夹具须按生产初始化顺序」：本文件夹具的 DDL 逐列照抄 `database.ts`（含 ALTER 补列
 *   `is_primary` / `acceptance_verified`），不写"比生产宽松"的简化版；计数器一律给"0→1"正面断言。
 * ⚠ 承 feedback「断言里不得写'只为下一轮'的字面量」：本文件不以轮次字面量做等值断言；
 *   build 钉一律由 `scripts/lib/rr-pins.ts` 派生核对（§S4）。§S5/§S6 的静态判据口径一律是
 *   **"手写字面量计数为 0"与"两处派生计数须相等"**（增量新增一并受管），不写死"本轮是几"。
 * ⚠ 本文件**不打开真库**（真库只读实测见 `data/baseline_zx_20260915.json`）；§S4 读 `dist` ⇒ tsup 须先于本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import {
  blockNoOutputCompletion, realOutputEvidence, buildTools,
  blockFailedChildrenCompletion, taskFailedPayload,
  buildDeviationPrompt, readRecentToolNames, hasArtifactWrite,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import {
  subscribeTaskNotifications, recordNotification, countUnread,
  getNotificationWriteFailures, setTaskFocus, PAUSE_DEVIATION_KEY,
} from '../apps/worker-ant-desktop/src/main/core/notification-core.js';
import {
  autoAssignPrimary, selectProbeDeliverables, disposeProbeDeliverables,
  promoteTaskFileDeliverables, annotateAcceptance, verifiedAcceptanceMap, readAcceptanceCheck,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import {
  recordAcceptanceOutcome, isAcceptanceVerified, readTaskAcceptanceCriteria,
  toAcceptanceSummary, UNVERIFIED_REASON_LABEL,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import {
  PAUSE_REASON_NO_OUTPUT, PAUSE_REASON_CHILDREN_INCOMPLETE, PAUSE_REASON_CHILDREN_FAILED,
  isChildrenIncompletePause, pauseReasonLabel,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { failedChildren, childNames } from '../apps/worker-ant-desktop/src/main/core/children-gate.js';
import {
  recordExecutionFailure, checkParentTaskAfterChildDone,
} from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { buildTaskNotice } from '../apps/worker-ant-desktop/src/main/core/task-notice.js';
import { buildTaskOutcome, countDeliverables } from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';
import { BOOL_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
import {
  SAFE_READONLY_COMMANDS, SHELL_REJECT_CHARS, firstRejectedShellChar, classifyShellReject,
  shellRejectPayload, shellRejectPayloadForChar, buildToolConstraintBrief, validateReadonlyBashCommand,
} from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { EventStore } from '../apps/worker-ant-desktop/src/main/core/event-store.js';
import {
  VERIFICATION_TASK_KEYWORDS, PLAN_TASK_KEYWORDS, isVerificationTask, isPlanOrImplTask, milestoneSubjectVerdict,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import {
  settlePause, resumeWithQuota, setAnswerEmitter,
  buildUnansweredBanner, composeResumeInput,
} from '../apps/worker-ant-desktop/src/main/core/pause-settlement.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
type AnyDb = import('better-sqlite3').Database;

// ── 夹具 schema：逐列照抄 database.ts DDL（含 ALTER 补列），既不缺列也不放宽 NOT NULL ──
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
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
CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT NOT NULL,
  milestone TEXT NOT NULL, status TEXT DEFAULT 'pending', implemented_by_task_id TEXT,
  updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_plan_milestones_uniq ON wa_plan_milestones(plan_task_id, milestone);
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
-- zx_20261012_2 批五 M5: 失败通知的唯一出口＝markTaskFailed ⇒ pushImNotify，其**意图账**须在场
--   （发送经动态 import electron 的 im.ipc —— rr 起不了 electron ⇒ 只有这本账能在回归里被正面断言）。
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT,
  message_json TEXT, direction TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
  kind TEXT NOT NULL, suppressed INTEGER DEFAULT 0, at INTEGER NOT NULL);
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

/**
 * §S7 专用：`node:sqlite` 没有 better-sqlite3 的 `db.transaction()`，而 `EventStore` 是**真实现**
 * （逐行跑它的 append/版本自增/INSERT），故只补这一枚**驱动方法**，语义照 better-sqlite3：
 * 返回可调用包装器；抛错则 ROLLBACK 后原样抛出（不吞错——吞错的假事务会让"0→1"变成自证）。
 * 这补的是驱动能力，不是判据：被测逻辑一行未替。
 */
const withTx = (d: AnyDb): AnyDb => {
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => {
    d.exec('BEGIN');
    try { fn(); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* 无活动事务 */ } throw e; }
  };
  return d;
};

const addTask = (db: AnyDb, id: string, status: string, opts: { parent?: string; ctx?: Record<string, unknown>; criteria?: string; title?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, depends_on, source, acceptance_criteria, context_json)
              VALUES (?, 'p', ?, ?, ?, '', 'test', ?, ?)`)
    .run(id, opts.parent ?? '', opts.title ?? id, status, opts.criteria ?? '', JSON.stringify(opts.ctx ?? {}));
};
const addDeliv = (db: AnyDb, id: string, taskId: string, over: { type?: string; name?: string; status?: string; file_path?: string | null; ago?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status, is_primary, acceptance_verified, created_at)
              VALUES (?, 'p', ?, ?, ?, '', ?, ?, 0, 0, datetime('now', ?))`)
    .run(id, taskId, over.type ?? 'doc', over.name ?? id, over.file_path ?? null, over.status ?? 'draft', over.ago ?? '-1 minutes');
};
const addConv = (db: AnyDb, taskId: string, role: string, content: string): void => {
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (?, ?, ?, ?, 0)")
    .run(crypto.randomUUID(), taskId, role, content);
};
const addEvent = (db: AnyDb, type: string, taskId: string, payload: Record<string, unknown>): void => {
  db.prepare(`INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, payload, occurred_at)
              VALUES (?, ?, 'task', ?, ?, datetime('now'))`)
    .run(crypto.randomUUID(), type, taskId, JSON.stringify(payload));
};
const ctxObj = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const statusOf = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const sysConvs = (db: AnyDb, id: string): Array<{ content: string }> =>
  db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system'").all(id) as Array<{ content: string }>;

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx15-'));
const tmpFile = (name: string, body = 'x'): string => { const p = path.join(tmpdir, name); fs.writeFileSync(p, body); return p; };

const aeSrc = stripComments(engineSrc());
const aitSrc = stripComments(RD(`${A}/src/main/core/jobs/ai-task.ts`));
// §S7 的扫描面：`resume-ai-task` 的**全部**入队点 + 事件两张表 + 守卫本体
const psSrc = stripComments(RD(`${A}/src/main/core/pause-settlement.ts`));
const ebSrc = stripComments(RD(`${A}/src/main/core/event-bus.ts`));
const imSrc = stripComments(RD(`${A}/src/main/services/im-router.ts`));
const ipcSrc = stripComments(RD(`${A}/src/main/ipc/project.ipc.ts`));
const idxSrc = stripComments(RD(`${A}/src/main/index.ts`));
const schSrc = stripComments(RD(`${A}/src/main/core/task-scheduler.ts`));

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1】P0-1 完成闸门 · run_close 路（直引真实现）');
  {
    const db = mkdb();
    addTask(db, 't-block', 'executing');
    eq(blockNoOutputCompletion(db, 't-block', { archetype: 'code', runMutations: 7 }), true,
      '① 无产出 + code 原型 ⇒ 闸门拦下（返回 true，调用方必须立即 return）');
    eq(statusOf(db, 't-block'), 'paused', "② 不标 completed，改置 status='paused'");
    eq(ctxObj(db, 't-block').pause_reason, PAUSE_REASON_NO_OUTPUT, "③ ctx.pause_reason 落 'no_output'（因由落库，不靠事件旁证）");
    eq(sysConvs(db, 't-block').length, 1, '④ 系统会话行 **0→1**（正面断言：被 try/catch 吞掉的写入只有正面断言抓得住）');
    ok(sysConvs(db, 't-block')[0]!.content.includes('未发现任何真实产出证据'), '④ 该行如实说明"收口时未发现任何真实产出证据"');
    eq(ctxObj(db, 't-block').run_mutations, 7, '⑤ ctx.run_mutations 键**从无到有**且 = 传入值（诊断材料，非判据）');
    ok(!isChildrenIncompletePause(JSON.stringify(ctxObj(db, 't-block'))),
      '反证：no_output **不**被判为「等子任务而暂停」（否则拦下的任务会被调度器自动拉起，闸门形同虚设）');
  }

  {
    // ⑥ 事件 emit 恰好 1 次。§1.6 订正：`markPauseNeeded` 是 fire-and-forget、不写库行，
    //    故 M1 能断言的真副作用只有事件；"通知面 0→1 行"属 P0-6/M4（见方案 §1.6 的 ⚠ 与 §六）。
    const db = mkdb();
    addTask(db, 't-emit', 'executing');
    let hits = 0;
    const h = (e: { data: Record<string, unknown> }) => { if (e.data.reason === PAUSE_REASON_NO_OUTPUT) hits++; };
    eventBus.on('task.status_changed', h);
    blockNoOutputCompletion(db, 't-emit', { archetype: 'code', runMutations: 0 });
    await Promise.resolve();
    eventBus.off('task.status_changed', h);
    eq(hits, 1, "⑥ eventBus 收到 status_changed{reason:'no_output'} **恰好 1 次**");
  }

  {
    const db = mkdb();
    addTask(db, 't-conv', 'executing');
    eq(blockNoOutputCompletion(db, 't-conv', { archetype: 'conversation' }), false, '豁免① conversation 原型 ⇒ 不拦（交付物本就是一段回话，无文件是常态）');
    eq(statusOf(db, 't-conv'), 'executing', '豁免① 且 status 未被改');

    addTask(db, 't-parent', 'executing');
    addTask(db, 't-child', 'pending', { parent: 't-parent' });
    eq(blockNoOutputCompletion(db, 't-parent', { archetype: 'code' }), false, '豁免② 有子任务 ⇒ 不拦（父的产出即子的产出，自身无文件是分工）');
    eq(statusOf(db, 't-parent'), 'executing', '豁免② 且 status 未被改');

    addTask(db, 't-switch', 'executing');
    db.prepare("INSERT INTO wa_settings (key, value) VALUES ('engine.completion_gate_no_output', 'false')").run();
    eq(blockNoOutputCompletion(db, 't-switch', { archetype: 'code' }), false, "豁免③ 开关关（'false'）⇒ 一键回退本轮前行为");
    ok(!('pause_reason' in ctxObj(db, 't-switch')), '豁免③ 且 ctx **无** pause_reason（未留任何痕）');

    const db2 = mkdb();
    addTask(db2, 't-wrote', 'executing');
    addConv(db2, 't-wrote', 'tool', 'write_file({"path":"a.md"})');
    eq(realOutputEvidence(db2, 't-wrote'), true, '前置：埋一行 write_file 工具会话 ⇒ realOutputEvidence 为真');
    eq(blockNoOutputCompletion(db2, 't-wrote', { archetype: 'code' }), false, '防误伤① 有写入类工具调用 ⇒ 不拦');
    eq(sysConvs(db2, 't-wrote').length, 0, '防误伤① 且未刷系统会话行');

    addTask(db2, 't-doc', 'executing');
    addDeliv(db2, 'd-doc', 't-doc', { file_path: tmpFile('report.md', '# real') });
    eq(blockNoOutputCompletion(db2, 't-doc', { archetype: 'code' }), false, '防误伤② 文件确实落盘（doc 交付物且 file_path 存在）⇒ 不拦');
    eq(statusOf(db2, 't-doc'), 'executing', '防误伤② 且 status 未被改');

    addTask(db2, 't-ghost', 'executing');
    addDeliv(db2, 'd-ghost', 't-ghost', { file_path: path.join(tmpdir, 'never-written.md') });
    eq(blockNoOutputCompletion(db2, 't-ghost', { archetype: 'code' }), true,
      '反证：交付物登记在册但**文件不在盘上** ⇒ 仍判无产出（"有登记" ≠ "有产出"，上面那条不是恒真）');
  }

  // ── (b) update_task_status 路：真工具 · 真 execute · 三态文案可区分 ──
  console.log('\n【S1b】P0-1 上屏（update_task_status 路 · 真工具 execute）');
  {
    const call = async (db: AnyDb, target: string): Promise<string> => {
      const tools = buildTools({ db } as never, 'caller-task', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      return tools.update_task_status!.execute({ targetTaskId: target, status: 'completed' });
    };

    const db = mkdb();
    addTask(db, 'u-ran', 'executing');
    addEvent(db, 'task.step_finished', 'u-ran', { step: 1 }); // 跑了却全只读 = 产出问题（两态中的前者）
    const r1 = await call(db, 'u-ran');
    const c1 = sysConvs(db, 'u-ran');
    eq(c1.length, 1, '无产出 + 有 step 事件 ⇒ 系统会话行 **0→1**');
    ok(c1[0]!.content.includes('无任何真实产出证据'), '文案取「无任何真实产出证据」（跑了却无产出）');
    ok(!c1[0]!.content.includes('未执行过任何一步'), '且**不是**另一态的话（两态可区分，非同一句话）');
    ok(!r1.includes('error'), '「不硬拦」裁定未推翻：无产出亦可经本工具标完成（返回成功）');

    const r2 = await call(db, 'u-ran');
    eq(sysConvs(db, 'u-ran').length, 1, '重复调用 ⇒ 系统会话行**仍为 1**（no_output_notice_at 守门，不刷屏）');
    ok(!r2.includes('error'), '重复调用仍返回成功');

    addTask(db, 'u-never', 'executing'); // 全生命周期一次都没跑（两态中的后者）
    await call(db, 'u-never');
    const c2 = sysConvs(db, 'u-never');
    eq(c2.length, 1, '无产出 + **无** step 事件 ⇒ 系统会话行 0→1');
    ok(c2[0]!.content.includes('未执行过任何一步'), '文案取「未执行过任何一步」（压根没执行 ≠ 跑而无产出）');

    addTask(db, 'u-has', 'executing');
    addConv(db, 'u-has', 'tool', 'edit_file({"path":"b.md"})');
    // zx_20261014_6 M2 订正夹具保真度：生产里"有产出"必是跑过的（每次工具步发 `task.step_finished`）——
    //   原夹具省略了 step 事件 ⇒ 落在 M2 新增的 `neverRan`（零 step 事件）独立判据上，与此处要验的
    //   "有产出不误报"不是同一件事。补一枚 step 事件，把这一条钉回它本想验的情形。
    addEvent(db, 'task.step_finished', 'u-has', { step: 1 });
    await call(db, 'u-has');
    eq(sysConvs(db, 'u-has').length, 0, '**有产出且跑过** ⇒ 系统会话行 0 行（不误报）');
    ok(!('auto_completed_without_output' in ctxObj(db, 'u-has')), '有产出 ⇒ 不落 auto_completed_without_output 标记');

    // zx_20261014_6 M2 新增（两只标本的另一只）：**有产出却零 step 事件** ⇒ neverRan 独立判据仍上屏，
    //   但**不**把"有产出"误标成"无产出"（打标仍只在 `!hasOut`）。此前这一态被并进 `if (!hasOut)` 而无声。
    addTask(db, 'u-has-never', 'executing');
    addConv(db, 'u-has-never', 'tool', 'edit_file({"path":"c.md"})');
    await call(db, 'u-has-never');
    const cNE = sysConvs(db, 'u-has-never');
    eq(cNE.length, 1, '★有产出却零 step ⇒ 提示 **0→1**（neverRan 提到 `if (!hasOut)` 之外，不再连算都不算）');
    ok(cNE[0]!.content.includes('未执行过任何一步'), '★文案取「未执行过任何一步」（neverRan 优先于"无产出"一支）');
    ok(!('auto_completed_without_output' in ctxObj(db, 'u-has-never')), '★**不误标**：虽有产出仍不落 auto_completed_without_output（打标只在 `!hasOut`）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S2】P0-2 验收三态 · 「没标准 ≠ 通过」');
  {
    const db = mkdb();
    addTask(db, 'a-nostd', 'completed');
    ok(!('acceptance_check' in ctxObj(db, 'a-nostd')), '前置：该任务 ctx 尚无 acceptance_check（计数 0）');
    const payload = recordAcceptanceOutcome(db, 'a-nostd', { outcome: { ran: false, reason: 'no_criteria' }, checks: [] });
    eq(payload.verified, false, '落 `no_criteria` 载荷 ⇒ 载荷 `verified:false`');
    eq(payload.reason, 'no_criteria', '且 reason 取名 `no_criteria`（「没设标准」是一种**结局**，不是无话可说）');
    eq(payload.criteria_total, 0, 'criteria_total=0 是刻意的——面板不得显示一个假的 "0/0 已达成"');
    eq(isAcceptanceVerified(payload), false, '★核心不变量：`isAcceptanceVerified` 对 no_criteria **必须返回 false**（没标准 ≠ 通过）');
    ok(ctxObj(db, 'a-nostd').acceptance_check !== undefined, '副作用 **0→1**：ctx.acceptance_check 由无到有（防"又静默跳过"）');
    eq(verifiedAcceptanceMap(db, ['a-nostd']).size, 0, '派生视图里它**不在**已核验一侧（下游无从据此打 ✓）');
    eq(isAcceptanceVerified(undefined), false, '反证：无载荷同样不算验过');
    eq(isAcceptanceVerified({ checked_at: 'x', verified: false }), false, '反证：显式 verified:false 一律不算验过');
    eq(isAcceptanceVerified({ checked_at: 'x', verified: true }), true, '同一判据对**真核验**为真 ⇒ 上面几条不是"恒假"');

    const cacBody = aeSrc.slice(aeSrc.indexOf('async function checkAcceptanceCriteria'), aeSrc.indexOf('async function checkAcceptanceCriteria') + 2200);
    ok(/if \(!criteria\.trim\(\)\)/.test(cacBody), '静态：`checkAcceptanceCriteria` 进入即判 `!criteria.trim()`（不再由调用方 `if (trim)` 静默跳过）');
    ok(cacBody.includes("reason: 'no_criteria'"), '静态：该早返回落 `no_criteria` 一笔');
    // 取**最后一处**（finalize 的空标准分支）——前一处是同文件里被 `if (trim)` 门控的常规分支，
    // 用 indexOf 会扫到它、把"门控"当成"未落账"误判（本断言首次跑即如此，已订正）。
    const iElseCall = aeSrc.lastIndexOf('await checkAcceptanceCriteria(ctx, db, taskId, acceptanceCriteria);');
    ok(iElseCall > 0 && !aeSrc.slice(Math.max(0, iElseCall - 300), iElseCall).includes('acceptanceCriteria.trim()'),
      '静态：finalize 的**空标准分支**直接调验收落账（前置 300 字符内无 `acceptanceCriteria.trim()` 门——空标准也必须走到落账）');
    // zx_20260916_3 M4：run_close 的验收调用**换了落点**（前移到任何读完成分的闸之前），且不再解构
    //   `{ payload: closeAcc }`（终态判据改读**账**而非"刚跑出来的 payload"，见 `closeAccNow`）⇒
    //   锚点随之改为那次调用本身。**判据的实质一字未变**：开关只控"跑不跑"，不控"标准空不空"。
    const iCloseCall = aeSrc.indexOf('await checkAcceptanceCriteria(ctx, db, taskId, closeCriteria);');
    const closeWin = aeSrc.slice(Math.max(0, iCloseCall - 300), iCloseCall);
    ok(iCloseCall > 0 && closeWin.includes('deliverable.acceptance_on_close')
      && closeWin.includes('readTaskAcceptanceCriteria(db, taskId)') && !closeWin.includes('trim()'),
      '静态：run_close 路**无条件**把标准交给验收（开关只控"跑不跑"，不控"标准空不空"——两条收口路同一把尺）');
  }

  {
    // 无标准 + 有 doc 产出 ⇒ promote 后验收位仍为 0（防"没标准就默认通过"）
    const db = mkdb();
    addTask(db, 'p-nostd', 'executing');
    addDeliv(db, 'pd-1', 'p-nostd', { file_path: tmpFile('rep-nostd.md') });
    eq(recordAcceptanceOutcome(db, 'p-nostd', { outcome: { ran: false, reason: 'no_criteria' }, checks: [] }).verified, false, '前置：no_criteria 已落账');
    eq(promoteTaskFileDeliverables(db, 'p-nostd', 'run_close').promoted, 1, '前置：draft doc 照常被提升为 completed（收尾未因无标准而停）');
    eq(Number((db.prepare("SELECT acceptance_verified v FROM wa_deliverables WHERE id='pd-1'").get() as { v: number }).v), 0,
      '★ 无标准 ⇒ `acceptance_verified` **仍为 0**（"任务完成/高分" ≠ "已验收"）');

    addTask(db, 'p-std', 'executing', { criteria: '1. 报告已落盘' });
    addDeliv(db, 'pd-2', 'p-std', { file_path: tmpFile('rep-std.md') });
    recordAcceptanceOutcome(db, 'p-std', { outcome: { ran: true, passed: true }, checks: [{ criterion: '1. 报告已落盘', passed: true }] });
    eq(verifiedAcceptanceMap(db, ['p-std']).size, 1, '有标准且通过 ⇒ 派生视图里**在**已核验一侧');
    eq(promoteTaskFileDeliverables(db, 'p-std', 'run_close').promoted, 1, '前置：draft doc 提升');
    eq(Number((db.prepare("SELECT acceptance_verified v FROM wa_deliverables WHERE id='pd-2'").get() as { v: number }).v), 1,
      '★ 验收通过 ⇒ doc 的 `acceptance_verified` **0→1**（markVerifiedWhere 真改到行）');
  }

  {
    // 渲染层第三态：未核验的任务下发 `task_acceptance`，且**不**下发 `acceptance`（成果页与完成卡读同一字段）
    const db = mkdb();
    addTask(db, 'g-nostd', 'completed');
    recordAcceptanceOutcome(db, 'g-nostd', { outcome: { ran: false, reason: 'no_criteria' }, checks: [] });
    const rows: Array<Record<string, unknown>> = [{ id: 'row-1', task_id: 'g-nostd', type: 'doc', acceptance_verified: 0 }];
    annotateAcceptance(db, rows);
    ok(rows[0]!.acceptance === undefined, '未核验 ⇒ **不下发** `acceptance`（不显 ✓）');
    eq((rows[0]!.task_acceptance as { reason?: string })?.reason, 'no_criteria', '未核验 ⇒ 下发 `task_acceptance`（第三态可上屏，不止"没有 ✓"）');

    const dbv = mkdb();
    addTask(dbv, 'g-std', 'completed', { criteria: '1. x' });
    recordAcceptanceOutcome(dbv, 'g-std', { outcome: { ran: true, passed: true }, checks: [{ criterion: '1. x', passed: true }] });
    const rows2: Array<Record<string, unknown>> = [{ id: 'row-2', task_id: 'g-std', type: 'doc', acceptance_verified: 1 }];
    annotateAcceptance(dbv, rows2);
    ok(rows2[0]!.acceptance !== undefined, '反证：已核验 + 逐条打标 ⇒ 下发 `acceptance`（上面那条不是"恒不发"）');
  }

  {
    const insCols = [...aeSrc.matchAll(/INSERT INTO wa_tasks \(([^)]*)\)/g)].map((m) => m[1]!);
    ok(insCols.length >= 3, `静态：扫到 wa_tasks 自建 INSERT ${insCols.length} 处（下界 3，防扫描面退化）`);
    eq(insCols.filter((c) => !c.includes('acceptance_criteria')), [], '静态：**每一处**都带 acceptance_criteria 列（缺一处即红）');
    ok(aeSrc.includes("acceptance_criteria: { type: 'string'"), '静态：工具 jsonSchema 增了可选 `acceptance_criteria`（有列可填，非只留空）');
    eq(UNVERIFIED_REASON_LABEL.no_criteria, '未设验收标准', '词表一处真源：成因码 → 人可读短语在册（renderer 跨 root 引同一份）');
    eq(readTaskAcceptanceCriteria(mkdb(), 'none'), '', '取标准的唯一读点：任务不存在 ⇒ 返回空串（不抛）');
    eq(readTaskAcceptanceCriteria((() => { const d = mkdb(); addTask(d, 'has', 'pending', { criteria: 'C1' }); return d; })(), 'has'), 'C1',
      '反证：有标准时真取得到（上面那条不是"恒空"）');
  }

  {
    // §2.4 契约：`task.completed` 的 `acceptance` 在**两个收口出口上同形**（finalize / run_close）。
    // 病根同 §2.1——同一事件类型此前只有 run_close 带验收，下游分不清「走 finalize、账上就是 no_criteria」
    // 与「老生产者没这个字段」。断言的是**形状**（三态合一、恰四键）与**两个出口都带**，不是某个具体分数。
    const db = mkdb();
    addTask(db, 'e-nostd', 'completed');
    eq(toAcceptanceSummary(undefined), undefined, '无账 ⇒ `undefined`（"没这笔账" ≠ "账上是未通过"——不编默认态）');
    eq(readAcceptanceCheck(db, 'e-nostd'), undefined, '反证前置：该任务尚未落账，`readAcceptanceCheck` 取不到');
    const payNo = recordAcceptanceOutcome(db, 'e-nostd', { outcome: { ran: false, reason: 'no_criteria' }, checks: [] });
    const sNo = toAcceptanceSummary(readAcceptanceCheck(db, 'e-nostd'));
    eq(JSON.stringify(sNo), '{"verified":false,"criteria_total":0,"passed_total":0,"reason":"no_criteria"}',
      '★ 未核验账 ⇒ 摘要恰 `{verified:false, criteria_total, passed_total, reason}`（成因码与布尔**同框**，三态合一）');
    eq(sNo?.verified, payNo.verified, '摘要不另立判据：`verified` 与落库载荷同值（未核验方向）');

    const dbv = mkdb();
    addTask(dbv, 'e-std', 'completed');
    const payYes = recordAcceptanceOutcome(dbv, 'e-std', { outcome: { ran: true, passed: true }, checks: [{ criterion: 'C1', passed: true }] });
    const sYes = toAcceptanceSummary(readAcceptanceCheck(dbv, 'e-std'));
    eq(JSON.stringify(sYes), '{"verified":true,"criteria_total":1,"passed_total":1}',
      '反证：真核验账 ⇒ 摘要 `verified:true` 且**不带** reason（上面那条不是"恒 false + 恒带码"）');
    ok(payYes.verified === true && sYes?.verified === payYes.verified,
      '摘要不另立判据：`verified` 与落库载荷同值（已核验方向——两向都同值才不是"恰好都对"）');

    // 静态：`readAcceptanceCheck` 复用唯一解析处（不新开第二个 JSON.parse 落点）
    const dlc = stripComments(RD(`${A}/src/main/core/deliverable-lifecycle.ts`));
    const racBody = dlc.slice(dlc.indexOf('export function readAcceptanceCheck('), dlc.indexOf('export function readAcceptanceCheck(') + 400);
    ok(/return parseAcceptance\(db, \[taskId\]\)\.raw\.get\(taskId\)/.test(racBody),
      '静态：`readAcceptanceCheck` 委托 `parseAcceptance` 的 `raw` 视图——同一份解析的第三个**出口**，不是第三个**解析点**');
    eq((dlc.match(/JSON\.parse\(row\.context_json/g) || []).length, 1, '静态：`acceptance_check` 的 JSON.parse 全文件**仍恰一处**');

    // 静态：**两个** emit 出口都带 `acceptance`（少一处即红——正是本条要治的不对称）
    const emits = [...aeSrc.matchAll(/eventBus\.emit\('task\.completed', \{([^}]*)\}/g)].map((m) => m[1]!);
    eq(emits.length, 2, `静态：agent-executor 内 task.completed 恰两处 emit（扫到 ${emits.length} 处，防扫描面退化）`);
    eq(emits.filter((e) => !e.includes('acceptance:')).length, 0, '★ 两处**都**带 `acceptance`（两个出口同一形状）');
    ok(emits.some((e) => e.includes('readAcceptanceCheck(db, taskId)')) && emits.some((e) => e.includes('closeAcceptance')),
      '且两处各取自本路的真源（finalize 直读落库账 / run_close 读同一次验收的 `closeAccNow`——'
      + 'zx_20260916_3 M4 起后者也是**落库账**，不再是"当轮返回载荷"），不互抄也不各跑一遍');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S3】P0-8 收尾门 · 择主不按时序 · 临时产出物检出要处置');
  {
    // ① 新建优先于改动：探针 / 既有脚本(只有 file.edited) / 报告(有 file.created) 三者同任务
    // zx_20260924_1 M5-a: `autoAssignPrimary` 的落位改走 `applyPrimary`（同作用域清兄弟，同一事务）⇒
    //   夹具须备 `db.transaction`。补的是**驱动能力不是判据**（同 §S7 的 `withTx` 说明）：被测逻辑一行未替。
    const db = withTx(mkdb());
    addTask(db, 'z-mix', 'completed');
    const pProbe = tmpFile('_verify_tmp.py');
    const pScript = tmpFile('check_command_consistency.py');
    const pReport = tmpFile('A_20260914_review_report.md');
    addDeliv(db, 'z-probe', 'z-mix', { name: 'scripts/_verify_tmp.py', status: 'draft', file_path: pProbe, ago: '-3 minutes' });
    addDeliv(db, 'z-script', 'z-mix', { name: 'scripts/check_command_consistency.py', status: 'completed', file_path: pScript, ago: '-1 minutes' });
    // ⚠ 报告路径取**真实报告形态**（`8a6f226a` 的真报告是「…方案核实与修复报告.md」）。
    //   以下注释已在 zx_20260930 更新：当时（zx_20260915）本案**刻意不**写成 `reports/verify.md`，因为
    //   `docNotProbe` 的 `%/_%verify%` 里 `_` 是 LIKE **单字符通配符**（非字面下划线）⇒ 该路径会被判成探针、
    //   进不了择主候选，本段就变成在考谓词而非考"新建优先于改动"。
    //   **zx_20260930 M3-g 已修**该通配符误用（`\_` + `ESCAPE`），故现在 `reports/verify.md` 会正常进候选，
    //   上面的路径选择只剩"贴近真实报告形态"这一个理由，不再是绕开谓词。本段的三个断言在新旧两把尺下
    //   都成立（fixture 的探针件走 `/_verify_tmp.py` 段，两尺同判），故**无需改夹具**。
    addDeliv(db, 'z-report', 'z-mix', { name: 'reports/A_20260914_review_report.md', status: 'completed', file_path: pReport, ago: '-2 minutes' });
    addEvent(db, 'file.edited', 'z-mix', { filePath: pScript });
    addEvent(db, 'file.created', 'z-mix', { filePath: pReport });
    eq(autoAssignPrimary(db, 'z-mix').assigned, 'z-report',
      '★ 落在**报告**（有 file.created）——「新建优先于改动」（旧实现按 created_at DESC 会落在最后登记的既有脚本上）');
    eq(Number((db.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='z-script'").get() as { p: number }).p), 0, '既有脚本（只有 file.edited）未被择主');
    eq(Number((db.prepare("SELECT is_primary p FROM wa_deliverables WHERE id='z-probe'").get() as { p: number }).p), 0, '探针未被择主（docNotProbe 一把尺）');

    // ② 无 file.created 事实 ⇒ 回退既有 created_at DESC（防误伤）
    const db2 = withTx(mkdb()); // 同上：autoAssignPrimary → applyPrimary 需 db.transaction
    addTask(db2, 'z-fallback', 'completed');
    addDeliv(db2, 'z-old', 'z-fallback', { status: 'completed', file_path: tmpFile('old.md'), ago: '-10 minutes' });
    addDeliv(db2, 'z-new', 'z-fallback', { status: 'completed', file_path: tmpFile('new.md'), ago: '-1 minutes' });
    eq(autoAssignPrimary(db2, 'z-fallback').assigned, 'z-new', '无 file.created 事实 ⇒ 回退既有 created_at DESC（安全降级，不误判）');

    // ③ 探针处置：默认退休
    const db3 = mkdb();
    addTask(db3, 'z-probe-task', 'completed');
    const pF20 = tmpFile('_f20_probe.py');
    addDeliv(db3, 'zp-1', 'z-probe-task', { name: 'scripts/_f20_probe.py', status: 'draft', file_path: pF20 });
    const found = selectProbeDeliverables(db3, 'z-probe-task');
    eq(found.length, 1, '前置：探针检出（判据即 docNotProbe 一把尺——`_f20_probe.py` 这个逃逸形态现在检得出）');
    eq(disposeProbeDeliverables(db3, found, 'retire').retired, 1, '① 退休 **0→1**（正面断言）');
    eq((db3.prepare("SELECT status s FROM wa_deliverables WHERE id='zp-1'").get() as { s: string }).s, 'retired', "① status 由 `draft` 变 `retired`");
    // zx_20260916 M2 起：不传隔离根 ⇒ **退回旧行为**（只改登记状态、不碰文件）。生产侧必传隔离根，
    // 故这条断言证的是"缺省分支未变"，**不再**是"生产不移动文件"——后者已由用户裁定改为移动。
    ok(fs.existsSync(pF20), '③ **不传隔离根时文件仍在磁盘上**（缺省分支退回旧行为，供未接线调用方平滑过渡）');
    eq(selectProbeDeliverables(db3, 'z-probe-task').length, 0, '退休后不再被检出（幂等，不重复处置）');

    // ④ keep：如实保留 + 理由由调用方入 checks
    const db4 = mkdb();
    addTask(db4, 'z-keep-task', 'completed');
    addDeliv(db4, 'zk-1', 'z-keep-task', { name: 'scripts/_tmp_patch.py', status: 'draft', file_path: tmpFile('_tmp_patch.py') });
    const found4 = selectProbeDeliverables(db4, 'z-keep-task');
    eq(disposeProbeDeliverables(db4, found4, 'keep').kept, 1, 'keep ⇒ 保留计数 1');
    eq((db4.prepare("SELECT status s FROM wa_deliverables WHERE id='zk-1'").get() as { s: string }).s, 'draft', '① keep ⇒ status **仍为 draft**（未擅自退休）');
  }

  {
    ok(aeSrc.includes('probe_disposition') && aeSrc.includes('probe_keep_reason'), '静态：`finalize_task` 的 jsonSchema 含 `probe_disposition` / `probe_keep_reason`');
    ok(stripComments(RD(`${A}/src/main/core/deliverable-lifecycle.ts`)).includes('file.created'),
      '静态：`autoAssignPrimary` 的 SQL 含 `file.created` 派生列（事件派生，不新增字段）');
    const iDispose = aeSrc.indexOf('disposeProbeDeliverables(db, probes');
    const iPrimary = aeSrc.indexOf('autoAssignPrimary(db, taskId)');
    ok(iDispose > 0 && iPrimary > iDispose,
      '静态：探针处置**排在** autoAssignPrimary 之前（顺序是**前提**，不是"天然咬合"——否则被退休的探针仍在择主候选里）');
    for (const k of ['engine.completion_gate_no_output', 'deliverable.acceptance_on_close', 'deliverable.probe_disposition', 'deliverable.primary_prefer_created']) {
      ok(BOOL_SETTING_KEYS.includes(k), `静态：新开关键 \`${k}\` 登记在册（BOOL_SETTING_KEYS 唯一白名单）`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S5】P0-3 失败必带因 · 子任务失败不得被父静默吸收');
  {
    // ── (a) 载荷下界五键：失败要说得出"为什么" ──
    const db = mkdb();
    addTask(db, 'f-pay', 'executing');
    const on = taskFailedPayload(db, 'f-pay', 'p', 'no_output', '质量 12 分');
    eq(Object.keys(on).sort(), ['error', 'phase', 'projectId', 'taskId', 'task_id'],
      '★ 带因载荷下界五键 {taskId, task_id, projectId, error, phase}（error 可空但**须在键上**）');
    eq(on.error, '质量 12 分', 'error 是**那一句真原因**（不是"失败"这种空话）');
    eq(on.phase, 'no_output', 'phase 是机器可辨的失败相（本处＝质量闸）');
    db.prepare("INSERT INTO wa_settings (key, value) VALUES ('engine.failed_with_reason', 'false')").run();
    eq(Object.keys(taskFailedPayload(db, 'f-pay', 'p', 'no_output', '质量 12 分')).sort(),
      ['projectId', 'taskId', 'task_id'], '开关关 ⇒ 回旧形状仅三键（一键回退，非"删代码"）');
  }

  {
    // ── (b) 注入必然抛错的执行体经 ai-task catch 路：四个"0→1" ──
    // （**真调生产 `recordExecutionFailure`**，不切片、不复刻判据——同 §S1 的 blockNoOutputCompletion 范式）
    // zx_20261012_2 批五 M5 重定向：失败通知的出口由 `hooks.notify`（已删）改到**唯一写手** `markTaskFailed`
    //   ⇒ `pushImNotify`。发送经动态 `import electron` 的 `im.ipc`（rr 起不了）⇒ 观察面改为**意图账**
    //   `wa_im_notify_log`（先解析目标、无目标不记账，故夹具须给一个可解析的来源会话）。
    const db = mkdb();
    addTask(db, 'f-inj', 'executing', { ctx: { channel: 'wechat', externalUser: 'u1' } });
    db.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('c1', 'wechat', 'active')").run();
    const events: Array<Record<string, unknown>> = [];
    const h = (e: { data: Record<string, unknown> }) => { if (e.data.task_id === 'f-inj') events.push(e.data); };
    eventBus.on('task.failed', h);
    const r = recordExecutionFailure(db, 'f-inj', 'p', new Error('FOREIGN KEY constraint failed'));
    await Promise.resolve();
    eventBus.off('task.failed', h);
    eq(r.recorded, true, '① 真落账（返回值 recorded=true——被 try/catch 吞掉的写入只有正面断言抓得住）');
    eq(statusOf(db, 'f-inj'), 'failed', "① DB status **0→1**：executing ⇒ 'failed'");
    eq(events.length, 1, '② task.failed 事件 **0→1**（此前这一路「IM 报失败、账上从头到尾没有 failed」）');
    eq(events[0]!.error, 'FOREIGN KEY constraint failed', '③ payload.error 就是那句真错因（逐字节，非空非 undefined）');
    eq(events[0]!.phase, 'ai-task', "③ phase='ai-task'（作业处理器 catch 这一路）");
    eq(sysConvs(db, 'f-inj').length, 1, '系统会话行 **0→1**（失败在会话里也留痕）');
    ok(sysConvs(db, 'f-inj')[0]!.content.includes('FOREIGN KEY constraint failed'), '该行含真错因（不写"未知错误"糊过去）');
    const notifyLog = () => db.prepare('SELECT kind, suppressed FROM wa_im_notify_log WHERE task_id = ?').all('f-inj') as Array<{ kind: string; suppressed: number }>;
    eq(notifyLog().length, 1, '④ 失败通知**恰一条**（唯一出口 markTaskFailed ⇒ pushImNotify；意图账 0→1——被吞掉的写入只有正面断言抓得住）');
    eq(notifyLog()[0]!.kind, 'task_failed', "④ 通知类目 = 'task_failed'（不是泛 notification——类目正是聚并窗口的键）");
  }

  {
    // ── (c) 四态不被翻账（否则一次"收尾时的通知异常"会把**已完成**的任务伪造成失败）──
    for (const st of ['completed', 'paused', 'archived'] as const) {
      const db = mkdb();
      addTask(db, `f-guard-${st}`, st);
      let calls = 0;
      const r = recordExecutionFailure(db, `f-guard-${st}`, 'p', new Error('收尾时通知异常'), {
        afterRecord: () => { calls++; },
      });
      eq(r.recorded, false, `不翻已了结的账：status='${st}' ⇒ **不**记 failed`);
      eq(statusOf(db, `f-guard-${st}`), st, `且 status **仍为 ${st}**（未被改写）`);
      eq(sysConvs(db, `f-guard-${st}`).length, 0, '且未刷"执行失败"会话行（0 行）');
      eq(calls, 0, '且不唤起 D1（afterRecord 0 次）');
    }
  }

  {
    // ── (d) 非终态照常翻账 + D1 唤起恰一次（反证：上面几条不是"恒不记"）──
    const db = mkdb();
    addTask(db, 'f-exec', 'executing');
    let calls = 0;
    const r = recordExecutionFailure(db, 'f-exec', 'p', new Error('boom'), { afterRecord: () => { calls++; } });
    eq(r.recorded, true, '反证：非终态 ⇒ 照常记 failed');
    eq(r.status, 'failed', '返回值同时报出落账后的状态（调用方不必回查）');
    eq(calls, 1, '且唤起 D1 **0→1**（父任务复核恰一次，不惊群）');
  }

  {
    // ── (e) `failedChildren` 真实现：五处闸共取的**唯一判据** ──
    const db = mkdb();
    addTask(db, 'fc-p', 'completed');
    addTask(db, 'fc-failed', 'failed', { parent: 'fc-p' });
    addTask(db, 'fc-done', 'completed', { parent: 'fc-p' });
    addTask(db, 'fc-pend', 'pending', { parent: 'fc-p' });
    addTask(db, 'fc-arch', 'archived', { parent: 'fc-p' });
    const rows = failedChildren(db, 'fc-p');
    eq(rows.map((c) => c.id), ['fc-failed'],
      '★ 只认 `failed` 一个态（completed/pending/archived 皆不入围——archived 是**已处置**终态，不该挡父）');
    eq(childNames(rows), 'fc-failed', '点名串取子标题（与系统会话行/通知理由同一拼法，不各拼一遍）');
    db.prepare("INSERT INTO wa_settings (key, value) VALUES ('engine.children_failed_pause', 'false')").run();
    eq(failedChildren(db, 'fc-p').length, 0,
      '开关关 ⇒ 回旧单判据（failed 视作终态放行）——**在函数内判**，故五处调用点都只写 `failedChildren(db, taskId)`');
  }

  {
    // ── (f) 互锁：children_failed 与 no_output 同档，**不得**被判为"等子而暂停" ──
    eq(isChildrenIncompletePause(JSON.stringify({ pause_reason: PAUSE_REASON_CHILDREN_FAILED })), false,
      '★ `children_failed` **不**被判为「等子而暂停」（否则调度器把它当可自愈时序，后继子任务照被拉起）');
    eq(isChildrenIncompletePause(JSON.stringify({ pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE })), true,
      '反证：同判据对 `children_incomplete` 为 **true** ⇒ 上面那条不是"恒 false"');
    eq(isChildrenIncompletePause(JSON.stringify({ pause_reason: PAUSE_REASON_NO_OUTPUT })), false,
      '同档复核：`no_output` 亦 false（事实问题须人看，与等子互锁区分开）');
    eq(pauseReasonLabel(PAUSE_REASON_CHILDREN_FAILED), '子任务失败未处置', '词表一处真源：成因码 → 人话短语在册');
    eq(pauseReasonLabel('某个没见过的码'), '某个没见过的码', '反证：未知码**原文回显**（不吞、不编"未知原因"）');
  }

  {
    // ── (g) `blockFailedChildrenCompletion` 真实现：命中即拦 + 留痕 + 点名 ──
    const db = mkdb();
    addTask(db, 'bc-p', 'executing');
    addTask(db, 'bc-c1', 'failed', { parent: 'bc-p' });
    addTask(db, 'bc-c2', 'completed', { parent: 'bc-p' });
    let hits = 0;
    const h = (e: { data: Record<string, unknown> }) => { if (e.data.taskId === 'bc-p') hits++; };
    eventBus.on('task.status_changed', h);
    eq(blockFailedChildrenCompletion(db, 'bc-p'), true, '★ 命中即拦（返回 true ⇒ 调用方必须立即 return，不得标 completed）');
    await Promise.resolve();
    eventBus.off('task.status_changed', h);
    eq(statusOf(db, 'bc-p'), 'paused', "不标 completed，改置 status='paused'");
    eq(ctxObj(db, 'bc-p').pause_reason, PAUSE_REASON_CHILDREN_FAILED, "ctx.pause_reason 落 'children_failed'");
    eq(sysConvs(db, 'bc-p').length, 1, '系统会话行 **0→1**');
    ok(sysConvs(db, 'bc-p')[0]!.content.includes('bc-c1'), '★ 该行**逐个点名**失败子（说得出是哪一个子失败了）');
    ok(!sysConvs(db, 'bc-p')[0]!.content.includes('bc-c2'), '反证：已完成的兄弟不被写进"失败未处置"清单');
    eq(hits, 1, "事件 emit 恰 1 次（status_changed{reason:'children_failed'}）");
    eq(isChildrenIncompletePause(JSON.stringify(ctxObj(db, 'bc-p'))), false, '且该暂停**不**被调度器当作可自愈（互锁在本闸上同样成立）');
  }

  {
    // 防误伤：全终态子 / 叶子任务 ⇒ 放行（行为与改动前逐位一致）
    const db = mkdb();
    addTask(db, 'bc-p2', 'executing');
    addTask(db, 'bc-c21', 'completed', { parent: 'bc-p2' });
    addTask(db, 'bc-c22', 'archived', { parent: 'bc-p2' });
    eq(blockFailedChildrenCompletion(db, 'bc-p2'), false, '防误伤① 全 completed/archived 子 ⇒ 放行');
    eq(statusOf(db, 'bc-p2'), 'executing', '防误伤① 且 status 未被改');
    eq(sysConvs(db, 'bc-p2').length, 0, '防误伤① 且未刷会话行');
    addTask(db, 'bc-leaf', 'executing');
    eq(blockFailedChildrenCompletion(db, 'bc-leaf'), false, '防误伤② 叶子任务（无子）⇒ 放行');

    const db2 = mkdb();
    addTask(db2, 'bc-p3', 'executing');
    addTask(db2, 'bc-c31', 'failed', { parent: 'bc-p3' });
    db2.prepare("INSERT INTO wa_settings (key, value) VALUES ('engine.children_failed_pause', 'false')").run();
    eq(blockFailedChildrenCompletion(db2, 'bc-p3'), false, '开关关 ⇒ 回旧行为（failed 视作终态放行）');
    eq(statusOf(db2, 'bc-p3'), 'executing', '开关关 且 status 未被改');
  }

  {
    // ── (h) 工具路同果（防"只堵收口两处、工具路照放行"）──
    const db = mkdb();
    addTask(db, 'ft-p', 'executing');
    addTask(db, 'ft-c1', 'failed', { parent: 'ft-p' });
    const tools = buildTools({ db } as never, 'ft-p', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    const out = await tools.finalize_task!.execute({ summary: '试图收口' });
    ok(out.includes('error') && out.includes('ft-c1') && out.includes('失败未处置'),
      '★ 工具路同果：finalize_task 拒绝收口并点名失败子');
    eq(statusOf(db, 'ft-p'), 'executing', '且工具路**不动账**（只是不许收口，未擅自改写状态）');
    eq(sysConvs(db, 'ft-p').length, 0, '且未刷会话行（工具路以返回值告知，不产生副作用）');
  }

  {
    // ── (i) 防死锁闭合：失败子被处置后父自动恢复（沿用既有 D1，不新增机制）──
    const db = mkdb();
    addTask(db, 'd1-p', 'paused', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE } });
    addTask(db, 'd1-c1', 'failed', { parent: 'd1-p' });
    addTask(db, 'd1-c2', 'completed', { parent: 'd1-p' });
    const jobs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const enqueue = (type: string, payload: Record<string, unknown>) => { jobs.push({ type, payload }); return Promise.resolve(); };
    checkParentTaskAfterChildDone(db, 'd1-c2', { enqueue });
    eq(statusOf(db, 'd1-p'), 'paused', '★ 有失败子 ⇒ 父**保持** paused（此前会置回 pending、又被收口闸拦回 paused 的 pause→resume→re-pause 空转）');
    eq(jobs.length, 0, '且**不**入队恢复（0 次——防死锁不是"使劲重试"，是"等子真被处置"）');
    eq(ctxObj(db, 'd1-p').pause_reason, PAUSE_REASON_CHILDREN_FAILED,
      '且暂停因**如实升级** children_incomplete ⇒ children_failed（否则用户以为"子跑完就自动好"）');

    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'd1-c1'").run();
    let resumed = 0;
    const h = (e: { data: Record<string, unknown> }) => {
      if (e.data.taskId === 'd1-p' && (e.data.newStatus ?? e.data.new_status) === 'pending') resumed++;
    };
    eventBus.on('task.status_changed', h);
    checkParentTaskAfterChildDone(db, 'd1-c2', { enqueue });
    await Promise.resolve();
    eventBus.off('task.status_changed', h);
    eq(statusOf(db, 'd1-p'), 'pending', '失败子被处置后 ⇒ 父自动恢复 status=pending（**防死锁判据**）');
    eq(jobs.length, 1, '`resume-ai-task` 作业 **0→1**（正面断言）');
    eq(jobs[0]!.type, 'resume-ai-task', '且走既有 resume-ai-task 通道（未新增机制）');
    ok(String(jobs[0]!.payload.message).includes('[系统] 所有子任务已完成，恢复父任务'), '恢复消息沿用既有 D1 文本（逐子摘要随行）');
    eq(resumed, 1, '★ 该 `pending` 转移**补发事件** 0→1（此前事件溯源里不存在这个转移，界面停在 paused 需手刷）');
  }

  {
    // ── (j) 既有 children_incomplete 判据未被新判据挤掉 + 陈旧因升级 ──
    const db = mkdb();
    addTask(db, 'd2-p', 'paused', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE } });
    addTask(db, 'd2-c1', 'pending', { parent: 'd2-p' });
    addTask(db, 'd2-c2', 'completed', { parent: 'd2-p' });
    let n = 0;
    checkParentTaskAfterChildDone(db, 'd2-c2', { enqueue: () => { n++; return Promise.resolve(); } });
    eq(statusOf(db, 'd2-p'), 'paused', '仍有非终态子 ⇒ 父仍不恢复（既有判据**未被挤掉**）');
    eq(n, 0, '且不入队恢复');
    eq(ctxObj(db, 'd2-p').pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE, '且原因**保持** children_incomplete（无失败子时不擅改因由）');

    const db2 = mkdb();
    addTask(db2, 'd3-p', 'pending', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE } });
    addTask(db2, 'd3-c1', 'failed', { parent: 'd3-p' });
    checkParentTaskAfterChildDone(db2, 'd3-c1', { enqueue: () => Promise.resolve() });
    eq(ctxObj(db2, 'd3-p').pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE,
      '父不在 paused 态（pending）时**不改因由**——升级只针对"已暂停等着"的那一个态');
  }

  {
    // ── (k) 静态：五处闸同尺 / 三处带因 / 两处带果（计数一律由源码派生，不写死"本轮是几"）──
    const gdSrc = stripComments(RD(`${A}/src/main/core/children-gate.ts`));
    eq((aeSrc.match(/failedChildren\(db,/g) || []).length, 3,
      `静态：agent-executor 内 failedChildren 读点恰 3 处（2 工具闸 + 1 共用动作体内）——扫到 ${(aeSrc.match(/failedChildren\(db,/g) || []).length}`);
    eq((aitSrc.match(/failedChildren\(db,/g) || []).length, 1, '静态：ai-task 内 D1 读点恰 1 处');
    // zx_20260917 M1：`projectId` 形参随写入口收口一并退场（`pauseTask` 自取 project_id，不再由调用方转抄）。
    eq((aeSrc.match(/blockFailedChildrenCompletion\(db, taskId\)/g) || []).length, 2,
      '静态：**两个**收口出口都调共用动作（各抄一遍动作正是要治的分家）');
    eq((gdSrc.match(/status = 'failed'/g) || []).length, 1, '静态：`failed` 谓词在 children-gate **只此一处**');
    eq((aeSrc.match(/parent_task_id = \? AND status = 'failed'/g) || []).length, 0, '静态：收口侧**零处**手抄「有 failed 子」谓词（只从 children-gate 取）');
    eq((aitSrc.match(/parent_task_id = \? AND status = 'failed'/g) || []).length, 0, '静态：ai-task 同样零处手抄');

    const aeFailedEmits = (aeSrc.match(/eventBus\.emit\('task\.failed',/g) || []).length;
    const aeViaCtor = (aeSrc.match(/eventBus\.emit\('task\.failed', taskFailedPayload\(/g) || []).length;
    // zx_20260923 M1（T1 裁定）：原为 3 处，其中 **SDK 二次失败**那处已退场——它不再记 `failed`
    //   （那是把外部故障记在任务头上），改由 `pauseTask(ai_sdk_unavailable)` 落 `paused`。
    //   故**不把下界从 3 放宽到 ≥2**（那等于把这条钉废掉），改为**恰 2 处的等值钉** + 下面两条
    //   "相位是哪些 / 已退场的那个确实不在"——改文案改的是钉的形状，不是钉的松紧。
    eq(aeFailedEmits, 2, `静态：agent-executor 内 task.failed emit **恰 2 处**（实测 ${aeFailedEmits} 处）`);
    eq(aeViaCtor, aeFailedEmits, `静态：**每一处**都经 taskFailedPayload 带因（${aeViaCtor}/${aeFailedEmits}）`);
    const aiRawPayloads = [...aitSrc.matchAll(/eventBus\.emit\('task\.failed', (\{[^}]*\})/g)].map((m) => m[1]!);
    eq(aiRawPayloads.filter((p) => !p.includes('error')).length, 0,
      '静态：ai-task 内未走构造器的那条 emit（既有"并发重试超限"）亦自带 error ⇒「失败必带因」全仓无例外');
    // 两侧一起钉：**该在的在场**（两个相位各是各的，非同一句复制两遍）+ **该退场的确实不在**
    //   （`'sdk'` 若被谁传回来，相位联合已删它 ⇒ 编译期就红；此处再从文本侧兜一道，防"注释里写着退场、
    //   代码里还留着"）。只用"该在场"那一侧会漏掉"旧相位悄悄回来"。
    const aePhases = [...aeSrc.matchAll(/taskFailedPayload\(db, taskId, projectId, '([a-z_]+)'/g)].map((m) => m[1]!);
    eq(aePhases.join(','), 'no_output,execute_error',
      `静态：agent-executor 两个失败相语义可辨（实测 ${aePhases.join('/')}）`);
    ok(!aeSrc.includes("'sdk'"),
      "静态：`'sdk'` 相位**已退场**（SDK 二次失败改走 pauseTask 落 paused，zx_20260923 M1/T1）");

    const doneEmits = [...aeSrc.matchAll(/eventBus\.emit\('task\.completed', \{([^}]*)\}/g)].map((m) => m[1]!);
    eq(doneEmits.length, 2, `静态：agent-executor 内 task.completed 恰 2 处 emit（扫到 ${doneEmits.length} 处）`);
    eq(doneEmits.filter((e) => !e.includes('buildTaskOutcome(db, taskId')).length, 0,
      '★ 两处**都**经 buildTaskOutcome 带果（quality/deliverables/run_mutations 同源，不各算一份）');
    eq(doneEmits.filter((e) => !e.includes('acceptance:')).length, 0, '★ 两处都带 acceptance（与"带果"同批，两个出口同一形状）');

    // 扫描面**只限 D1 函数体**：本文件另有 4 处 `scheduler.enqueue('resume-ai-task', …)`
    // （:354/:369 目标偏离重试、:619/:634 SDK 回落）系**既有**路径，与 D1 无关，不能进扫描面。
    // ⚠ zx_20260930 M11-1 **就地订正（切块按符号 + 配对花括号，非放宽）**：原界取"到下一个 `\nexport ` 为止"，
    //   该界默认"函数体与下一个 export 之间没有任何非导出函数"——一种**位置假设**。M11-1 恰在 D1 之后、
    //   `registerAiTaskHandlers` 之前插了非导出的 `scheduleConcurrencyRetry`（内含 `scheduler.enqueue('ai-task')`），
    //   于是**同一个 D1 函数体**被读成含 scheduler 而误红。改按符号定位起点、再数**配对花括号**取块，
    //   界由函数自身形状定，不再依赖"后面紧跟什么"。判据本身（体经 `opts.enqueue` 注入、体内零 scheduler）未动。
    //   ⚠ 切块**先配平参数括号、再取其后第一个 `{`**：本函数签名里 `opts?: { enqueue?: … }` 的"第一个 `{`"
    //     是**参数的类型字面量**（一个平衡且以 `}` 收口的**错块**）——直接取它会切掉整个函数体，
    //     令 `opts?.enqueue?.(…)` 判为"不在场"而误红（本订正第一版正是这样红了一次）。
    const cpAt = aitSrc.indexOf('export function checkParentTaskAfterChildDone');
    const cpParen = cpAt >= 0 ? aitSrc.indexOf('(', cpAt) : -1;
    let cpClose = -1;
    if (cpParen >= 0) {
      let pd = 0;
      for (let i = cpParen; i < aitSrc.length; i++) {
        const c = aitSrc[i];
        if (c === '(') pd++;
        else if (c === ')') { pd--; if (pd === 0) { cpClose = i; break; } }
      }
    }
    const cpOpen = cpClose >= 0 ? aitSrc.indexOf('{', cpClose) : -1;
    let cpEnd = -1;
    if (cpOpen >= 0) {
      let depth = 0;
      for (let i = cpOpen; i < aitSrc.length; i++) {
        const c = aitSrc[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { cpEnd = i + 1; break; } }
      }
    }
    const cpBody = cpAt >= 0 && cpEnd > cpAt ? aitSrc.slice(cpAt, cpEnd) : '';
    ok(cpBody.includes("opts?.enqueue?.('resume-ai-task'") && !cpBody.includes('scheduler.enqueue'),
      '静态：D1 恢复经 `opts.enqueue` 注入（导出供回归直跑真实现），D1 函数体内不私接 scheduler',
      cpBody ? 'D1 函数体已定位' : '未定位 D1 函数体');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S6】P0-4 通知与任务状态同源 · 「签名里不给状态参数」的可判定证据');
  {
    // ★ 故意错报 kind：账上是 failed，调用方说 completed —— 输出仍须说账上的话
    const db = mkdb();
    addTask(db, 'n-failed', 'failed');
    const n = buildTaskNotice(db, 'n-failed', 'completed');
    ok(n.body.includes('失败') && !n.body.includes('已完成'),
      '★ 可判定证据：账上 failed + 谎报 kind=completed ⇒ 输出**仍说失败**（结构上无法谎报）');
    eq(n.level, 'fail', "语气档亦同源：failed ⇒ level='fail'（不随 kind 走）");
    eq(n.status, 'failed', '`status` 如实回报本函数**据以出词**的那个值（供断言，不在契约面）');
    ok(n.title.includes('失败') && !n.title.includes('已完成'), 'title 同源（原生通知标题也骗不了）');
    ok(n.message.includes(n.body), 'message = 图标 + body（IM 单串由同一构造器拼，三处调用方不再各拼一次）');

    addTask(db, 'n-done', 'completed');
    const nd = buildTaskNotice(db, 'n-done', 'failed'); // ← 反方向谎报
    ok(nd.body.includes('已完成') && !nd.body.includes('失败'),
      '反证（反方向）：账上 completed + 谎报 kind=failed ⇒ 输出仍说已完成 ⇒ 上面那条不是"恒说失败"');
  }

  {
    // 逐状态错报：词一律由**账**出，与 kind 无关
    const db = mkdb();
    const WORDS: Array<[string, string]> = [
      ['completed', '已完成'], ['failed', '失败'], ['paused', '已暂停'], ['pending', '待执行'], ['executing', '执行中'],
    ];
    for (const [st, word] of WORDS) {
      // id 与 title 故意**不同**且 id 长于 8 位：标题有 title 时不得退回 `任务 <id 前8位>` 占位名。
      const id = `nid-${st}-deadbeef`;
      const title = `真标题-${st}`;
      addTask(db, id, st, { title });
      const x = buildTaskNotice(db, id, 'completed');
      eq(x.status, st, `status 逐字节取自 wa_tasks.status（${st}）`);
      ok(x.body.includes(word), `status=${st} ⇒ 词取「${word}」`);
      if (st !== 'completed') ok(!x.body.includes('已完成'), `且 status=${st} 时**不**出现「已完成」（kind 谎报无效）`);
      ok(x.body.includes(title) && !x.body.includes(`任务 ${id.slice(0, 8)}`) && !x.body.includes(id),
        '任务名如实取自 wa_tasks.title（不显示 8 位 ID 残片）');
    }
  }

  {
    // 暂停因由由 `ctx.pause_reason` 派生（非调用方传入）
    const db = mkdb();
    addTask(db, 'n-cf', 'paused', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_FAILED } });
    ok(buildTaskNotice(db, 'n-cf', 'paused').body.includes('子任务失败'), 'pause_reason=children_failed ⇒ body 含「子任务失败」（由账派生）');
    addTask(db, 'n-no', 'paused', { ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
    ok(buildTaskNotice(db, 'n-no', 'paused').body.includes('无产出'), 'pause_reason=no_output ⇒ body 含「无产出」');
    addTask(db, 'n-incomplete', 'paused', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE } });
    ok(buildTaskNotice(db, 'n-incomplete', 'paused').body.includes('子任务尚未完成'), 'pause_reason=children_incomplete ⇒ body 含「子任务尚未完成」');
    addTask(db, 'n-plain', 'paused');
    const np = buildTaskNotice(db, 'n-plain', 'paused');
    ok(np.body.includes('待复核') && np.body.includes('可在桌面处理/恢复'),
      '无因由时**不编**原因，但处理引导恒在（人得知道下一步能做什么）');
    // zx_20260917 M2：无因由**不再静默留白**——明说"因未记录"（§1.4-Ⅳ 实测：用户最可能点开的那条"已暂停"
    // 里一个字的原因都读不到，即"因未记录"这种形态）。故下面的判据由「不含任何分隔符」改为
    // 「明说未记录 + 不留**空的**因由槽位」两件一起断言——原文案要求"不写空槽"，与本条**同向不冲突**。
    ok(np.body.includes('因未记录'), '无因由时正文**明说「因未记录」**（不静默留白，也不编一个原因）');
    ok(!np.body.includes('：——'), '且不曾留下**空的**因由槽位（不写成"待复核：——可在桌面处理"）');
    ok(!buildTaskNotice(db, 'n-cf', 'paused').body.includes('因未记录'),
      '反证：账上**有**因由时不得出现「因未记录」⇒ 上面那条不是"恒说未记录"');
    // 非 paused 的任务不得被套上暂停因（拿不相干的缘由给别的状态作注）
    addTask(db, 'n-exec-reason', 'executing', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_FAILED } });
    ok(!buildTaskNotice(db, 'n-exec-reason', 'paused').body.includes('子任务失败'),
      '反证：账上不是 paused ⇒ **不取** pause_reason 作注（否则"执行中"的任务被安上暂停理由）');
    addTask(db, 'n-ai', 'paused');
    ok(buildTaskNotice(db, 'n-ai', 'awaiting_input').body.includes('等待你回复/决策'), 'awaiting_input 保留「等你回复/决策」框架（状态词仍取账上）');
  }

  {
    // 回退开关：关 ⇒ 状态词改由 `kind` 出（＝旧"调用方自述"语义）；字面量不复活，`status` 仍如实
    const db = mkdb();
    addTask(db, 'n-sw', 'failed');
    db.prepare("INSERT INTO wa_settings (key, value) VALUES ('im.notice_single_source', 'false')").run();
    const x = buildTaskNotice(db, 'n-sw', 'completed');
    ok(x.body.includes('已完成'), '开关关 ⇒ 词改由 kind 出（一键回退到旧语义，无需回滚提交）');
    eq(x.status, 'failed', '且 `status` **仍如实回报账上的值**（开关只管用词，不管撒谎）');
  }

  {
    // 端到端：输出据以出词的 status 与 `wa_tasks.status` 逐字节一致，且**随账改而改**
    const db = mkdb();
    addTask(db, 'n-e2e', 'executing');
    const a = buildTaskNotice(db, 'n-e2e', 'completed');
    eq(a.status, 'executing', '端到端：输出据以出词的 status 与 wa_tasks.status 逐字节一致（rr 内直接比，无需外部系统）');
    ok(!a.body.includes('已完成'), '且此刻它**不**自称已完成');
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'n-e2e'").run();
    const b = buildTaskNotice(db, 'n-e2e', 'completed');
    ok(b.body.includes('已完成'), '反证：同一任务**改账后**、同一 kind，输出随之改变 ⇒ 词确系现查 DB，而非调用方预置');
  }

  {
    // ── 反向静态判据（按族分别扫；口径＝"手写字面量计数为 0"，不写死"本轮是几"）──
    const famOne = (s: string) => (s.match(/(?:✅|❌|⚠️) 任务「/g) || []).length;
    eq(famOne(aitSrc), 0, '★ 族一（emoji + 任务「）在 ai-task **为 0**（6 处手写文案不再各写一版）');
    eq(famOne(stripComments(RD(`${A}/src/main/core/im/im-notify.ts`))), 0, '★ 族一在 im-notify 为 0');
    ok(famOne("ctx.sendImNotification(taskId, projectId, `❌ 任务「${title}」执行失败: ${msg}`)") === 1,
      '**反证：扫描正则抓得住手写字面量**（上面两条不是"恒 0"——判据自身也受判据管）');

    // zx_20260915 M4/P0-6：M4 把「落行·已读·去重·订阅装配」从 `notification-service.ts`（碰 electron）
    // 抽进 `notification-core.ts`（零 electron）——**扫描面随实现搬家**。此处改扫新家：
    // 若继续扫旧家，`noticeOf('` 与 `handleTaskEvent(` 两处计数会**同时归零**而 `eq` 仍判绿，
    // 正是本仓反复判为假绿的"扫描面退化 ⊃ 判据恒真"（旧文件成了空壳）。
    const ncout = stripComments(RD(`${A}/src/main/core/notification-core.ts`));
    eq((ncout.match(/任务执行失败：|任务需要你输入：|任务已完成：/g) || []).length, 0,
      '★ 族二（无 emoji 的三串）在通知核 **为 0**（那一族字面量同样不再手写）');
    const noticeCalls = (ncout.match(/noticeOf\('/g) || []).length;
    // 判据按**分支逐点**校验（不比较总数）：`status_changed` 那一支用三元从同一函数取两词
    // （paused / failed），总数天然多 1 ⇒ `eq(noticeCalls, handlerCalls)` 是不成立的字面等式，
    // 而它的退化形态（两侧皆 0 ⇒ 判绿）才是真正要防的"扫描面退化"。
    // 故改为：**每个** `handleTaskEvent(` 调用点，其前文须先取过词；下界证明确有分支，非恒真。
    const hAt: number[] = [];
    for (let i = ncout.indexOf('handleTaskEvent('); i >= 0; i = ncout.indexOf('handleTaskEvent(', i + 1)) hAt.push(i);
    ok(hAt.length >= 4, `静态：事件处理分支确有 ${hAt.length} 处（下界 4——缺此条则下方判据会在 0 分支上假绿）`);
    ok(noticeCalls >= 4, `静态：noticeOf 取词点确有 ${noticeCalls} 处（下界 4，同上防退化）`);
    const noNotice = hAt.filter((i) => !ncout.slice(Math.max(0, i - 700), i).includes("noticeOf('"));
    eq(noNotice.length, 0,
      `静态：**每个**事件处理分支（共 ${hAt.length} 处）各自都经 noticeOf 取词（未取词的 ${noNotice.length} 处——两处计数各由源码派生，新增分支一并受管）`);
    for (const k of ['failed', 'awaiting_input', 'completed', 'paused', 'goal_deviation']) {
      ok(ncout.includes(`noticeOf('${k}',`), `静态：kind='${k}' 这一路已接线（各事件都从账上取词，M4 起含暂停/偏离两路）`);
    }
    ok(aitSrc.includes('buildTaskNotice(') && stripComments(RD(`${A}/src/main/core/im/im-notify.ts`)).includes('buildTaskNotice('),
      '静态：ai-task 与 im-notify 两族的调用点**都**已改调单源构造器（按族分别扫的正面一半）');
    const recCallSites = (aitSrc.match(/recordExecutionFailure\(db, taskId,/g) || []).length;
    ok(recCallSites >= 2, `静态：两个 catch 共用同一个 recordExecutionFailure（扫到 ${recCallSites} 处调用点，下界 2——各写一遍正是要治的分家）`);

    for (const k of ['engine.failed_with_reason', 'engine.children_failed_pause', 'im.notice_single_source']) {
      ok(BOOL_SETTING_KEYS.includes(k), `静态：本批新开关 \`${k}\` 登记在册（BOOL_SETTING_KEYS 唯一白名单）`);
    }
  }

  {
    // ── A′「成功必带果」的运行时同源（§3.4）：值与 DB 实查等值，防手抄 ──
    const db = mkdb();
    addTask(db, 'o-task', 'completed', { ctx: { completion_quality: { score: 80, via: 'self', goal_achieved: true } }, criteria: '1. 报告已落盘' });
    addDeliv(db, 'o-d1', 'o-task', { type: 'doc', status: 'completed' });
    addDeliv(db, 'o-d2', 'o-task', { type: 'doc', status: 'completed' });
    addDeliv(db, 'o-d3', 'o-task', { type: 'mcp', status: 'completed' });
    const out = buildTaskOutcome(db, 'o-task', 4);
    eq(out.quality?.score, (ctxObj(db, 'o-task').completion_quality as { score: number }).score,
      '① `quality.score` **等于** `ctx.completion_quality.score`（同源，不重算）');
    eq(out.deliverables.doc, Number((db.prepare("SELECT COUNT(*) c FROM wa_deliverables WHERE task_id='o-task' AND type='doc'").get() as { c: number }).c),
      '② `deliverables.doc` 等于 `wa_deliverables` 实查计数（**等值比较**，防手抄）');
    eq(out.run_mutations, 4, '③ `run_mutations` 即传入的诊断计数（P0-1 的同一笔，可空）');
    eq(out.deliverables.total, countDeliverables(db, 'o-task').total, '④ `total` 与同一计数器的另一出口等值（不各算一份）');
    eq(buildTaskOutcome(db, 'o-nothing', 0).quality, null, '反证：无落库载荷 ⇒ `quality` 为 null（"没这笔账" ≠ "0 分"）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S7】P0-5「答有痕 · 继续≠同意」· 真事件总线 + 真 EventStore + 真守卫');
  {
    // ── (a) 答有痕：真 eventBus + 真 EventStore ⇒ wa_event_log 里落得下 `task.answer_recorded` ──
    const db = withTx(mkdb());
    eventBus.setEventStore(new EventStore(db as never));
    setAnswerEmitter((type, data) => eventBus.emit(type, data));
    const countEvt = (t: string) => (db.prepare('SELECT COUNT(*) c FROM wa_event_log WHERE event_type = ?').get(t) as { c: number }).c;

    addTask(db, 'ans-gui', 'paused', { ctx: { awaiting_input: { asked_at: '2026-09-15T00:00:00.000Z', question: '要不要继续？', decision_type: 'pending_confirmation' } } });
    eq(countEvt('task.answer_recorded'), 0, '前置：事件表里**没有** answer 记录（0 起点——否则下面的 0→1 是假的）');
    const ctxGui = ctxObj(db, 'ans-gui');
    settlePause(db, 'ans-gui', ctxGui, 'resume', '继续', true, 'gui');
    await Promise.resolve();
    eq(countEvt('task.answer_recorded'), 1, '★ ①`wa_event_log` 增 `task.answer_recorded` **0→1**（正面断言；被 try/catch 吞掉的写入只有正面断言抓得住）');
    eq(ctxObj(db, 'ans-gui').answer_source, 'gui', "②`ctx.answer_source='gui'`——GUI 侧答复来源落库");
    eq(ctxObj(db, 'ans-gui').pause_response.asked_at, '2026-09-15T00:00:00.000Z',
      '③`pause_response.asked_at` = 提问时的 asked_at（同源，未重算）');

    const rowGui = db.prepare("SELECT aggregate_type, aggregate_id, payload FROM wa_event_log WHERE event_type = 'task.answer_recorded'").get() as
      { aggregate_type: string; aggregate_id: string; payload: string };
    eq(rowGui.aggregate_type, 'task', '④ 落库的 aggregate_type 正确（映射取的是 task 而非兜底）');
    eq(rowGui.aggregate_id, 'ans-gui', '④ 落库的 aggregate_id = taskId（idField 口径与事件名一致）');
    const plGui = JSON.parse(rowGui.payload) as Record<string, unknown>;
    eq(ctxObj(db, 'ans-gui').awaiting_input, undefined, '⑤ 前置：clear=true ⇒ `awaiting_input` 已清（事件里的 asked_at 因此**只能**来自落账那一次取值）');
    eq(plGui.asked_at, (ctxObj(db, 'ans-gui').pause_response as { asked_at: string }).asked_at,
      '⑤ 事件载荷的 `asked_at` **等于** `ctx.pause_response.asked_at`（同源，不重算）');
    eq(plGui.source, 'gui', '⑥ 事件载荷带 `source`（答复来源随事件可溯）');
    eq(plGui.decision, 'resume', '⑥ 事件载荷带 `decision`');

    // ── (b) 反证 ④：**只加事件联合、不加 EVENT_AGGREGATE_MAP 映射** ⇒ 一行都不落库（静默丢）──
    const before = (db.prepare('SELECT COUNT(*) c FROM wa_event_log').get() as { c: number }).c;
    await eventBus.emit('task.heartbeat', { taskId: 'ans-gui' });   // 在本仓 EventType 联合内，但**故意**不在聚合映射表内
    eq((db.prepare('SELECT COUNT(*) c FROM wa_event_log').get() as { c: number }).c, before,
      '★ 反证：事件类型**无聚合映射** ⇒ `wa_event_log` 增 **0**（把「静默丢」从注释变成机检——上面 ① 那条不是恒真）');
    ok(ebSrc.includes("'task.answer_recorded'") && /EVENT_AGGREGATE_MAP[\s\S]{0,2000}?'task\.answer_recorded':\s*\{\s*aggregate_type:\s*'task',\s*idField:\s*'taskId'/.test(ebSrc),
      '★ 静态：**两张表都要有**——EventType 联合含该事件，且 EVENT_AGGREGATE_MAP 有对应映射（少一张则静默丢）');

    // ── (c) IM 侧：确为答复的入口落账；"启动"类恢复**不落账**（启动 ≠ 答复）──
    addTask(db, 'ans-im', 'paused', { ctx: { awaiting_input: { asked_at: 'T-im', question: '批准？' }, goal_deviation_restarts: 2 } });
    resumeWithQuota(db, 'ans-im', { answer: { source: 'im', decision: 'confirm' } });
    eq(ctxObj(db, 'ans-im').answer_source, 'im', "★ ①`resumeWithQuota(…, {answer})` ⇒ `ctx.answer_source='im'`（IM 是第二条用户提交真源，答复账在此另挂一次）");
    eq(ctxObj(db, 'ans-im').pause_response.decision, 'confirm', '②`pause_response` 已写 ⇒ 后续调度器恢复不再误挂横幅');
    eq(statusOf(db, 'ans-im'), 'pending', '② 且恢复动作照做（status=pending，未被记账顶掉）');
    eq(ctxObj(db, 'ans-im').goal_deviation_restarts, 0, '防误伤：返还目标偏离额度的既有行为**未被顶掉**');
    eq(countEvt('task.answer_recorded'), 2, '③ IM 答复同样发事件（0→1 之后累计到 2，正面断言）');

    addTask(db, 'ans-start', 'paused', { ctx: { awaiting_input: { asked_at: 'T-start', question: '批准？' } } });
    resumeWithQuota(db, 'ans-start');
    ok(!('answer_source' in ctxObj(db, 'ans-start')) && !('pause_response' in ctxObj(db, 'ans-start')),
      '★ ③**未传 `answer`** 的「启动」类恢复 ⇒ 账**不写**（启动不是对某个提问的答复，记成 answer 即名实不符）');
    eq(statusOf(db, 'ans-start'), 'pending', '③ 但恢复照做（不传 answer 只影响"记账"，不影响"恢复"）');
    eq(countEvt('task.answer_recorded'), 2, '③ 且事件数**不变**（2⇒2，不冒充"答复已落账"）');

    addTask(db, 'ans-ghost', 'paused');
    db.prepare("DELETE FROM wa_tasks WHERE id = 'ans-ghost'").run();   // 任务不存在 ⇒ UPDATE changes=0
    resumeWithQuota(db, 'ans-ghost', { answer: { source: 'im', decision: 'confirm' } });
    eq(countEvt('task.answer_recorded'), 2, '反证：任务不存在（UPDATE 改 0 行）⇒ **不**发事件（宁可不发，也不发一条读不到底的账）');

    setAnswerEmitter(null);
    const afterOff = countEvt('task.answer_recorded');
    addTask(db, 'ans-noemit', 'paused', { ctx: { awaiting_input: { asked_at: 'T-x', question: 'q' } } });
    resumeWithQuota(db, 'ans-noemit', { answer: { source: 'im', decision: 'confirm' } });
    eq(countEvt('task.answer_recorded'), afterOff,
      '反证：**未注入 emitter**（装配处未接线）⇒ 不 emit（"没收到事件"正是缺接线的可观测信号，不静默吞错）');
    setAnswerEmitter((type, data) => eventBus.emit(type, data));   // 复原，供下面 (d) 用

    // ── (d) 守卫：非用户恢复**不得被当成「对悬置提问的同意」**（直跑真实现）──
    const AWAIT = { awaiting_input: { asked_at: 'T-q', question: '是否继续？' } };
    const bannerSystem = buildUnansweredBanner(AWAIT, undefined);
    ok(bannerSystem.startsWith('[待回复]') && bannerSystem.includes('T-q') && bannerSystem.includes('是否继续？'),
      '★ ① 未答复 + 非人发起 ⇒ 横幅含提问时刻与问题本身（判不了/没说清就不拦，说了就得说全）');
    eq(buildUnansweredBanner(AWAIT, 'user'), '', '② `initiator:\'user\'` ⇒ **无**横幅（人发起的恢复不受守卫拦——否则用户自己的"继续"也被系统质疑）');
    eq(buildUnansweredBanner({ ...AWAIT, pause_response: { at: 1, decision: 'resume', value: null, asked_at: 'T-q' } }, undefined), '',
      '③ 已答复（`pause_response` 在）⇒ **无**横幅（防误伤：已答场景不受影响）');
    eq(buildUnansweredBanner({}, undefined), '', '④ 无 `awaiting_input` ⇒ 无横幅（没有悬置提问就无可守卫）');
    eq(buildUnansweredBanner(null, undefined), '', '④ 读不到 ctx ⇒ 无横幅（判不了就不拦，与 isDuplicatePauseResponse 同一纪律）');

    const synth = '[系统恢复] 你之前的任务已恢复，以下是项目上下文…';
    const r1 = composeResumeInput({ banner: bannerSystem, synthesized: true, synthBlock: synth, forceFinalize: false, forceFinalizeMsg: 'FF' });
    ok(r1.finalMsg!.includes('[待回复]') && !r1.finalMsg!.includes('[系统恢复]'),
      '★ ⑤ 调度器/cron 路（无真实 message）⇒ 横幅**替掉**自造块：本轮输入含 `[待回复]` 且**不含** `[系统恢复]`（核心判据：不得把"继续"当"同意"）');
    const r2 = composeResumeInput({ banner: bannerSystem, synthesized: false, synthBlock: '[系统] 所有子任务已完成，恢复父任务，逐子摘要：…', forceFinalize: false, forceFinalizeMsg: 'FF' });
    ok(r2.finalMsg!.startsWith('[待回复]') && r2.finalMsg!.includes('逐子摘要'),
      '★ ⑥ D1 路（有真实 message）⇒ 横幅**前置**且真实消息**一字不丢**（守卫的职责是补提醒，不是替调用方删信息）');
    const r3 = composeResumeInput({ banner: bannerSystem, synthesized: false, synthBlock: 'x', forceFinalize: true, forceFinalizeMsg: 'FF-整合' });
    ok(r3.finalMsg!.startsWith('[待回复]') && r3.finalMsg!.includes('FF-整合'),
      '⑦ forceFinalize 路 ⇒ 横幅前置到整合指令（子任务全完也不许把悬置提问当同意）');
    const r4 = composeResumeInput({ banner: '', synthesized: true, synthBlock: synth, forceFinalize: false, forceFinalizeMsg: 'FF' });
    ok(r4.finalMsg === synth && r4.resumeMsg === synth, '反证：无横幅时**逐字节**保持既有行为（本轮零回归——守卫不该动到它管不着的路）');
    const r5 = composeResumeInput({ banner: '', synthesized: true, synthBlock: undefined, forceFinalize: true, forceFinalizeMsg: 'FF' });
    eq(r5.finalMsg, 'FF', '反证：无横幅 + 自造块缺失 + forceFinalize ⇒ 仍是原整合指令（分支未被横幅逻辑污染）');

    // ── (e) cron 路的 `pending` 转移补事件（SQL 原文就地执行 + emit）──
    const cronSql = (idxSrc.match(/"(UPDATE wa_tasks SET status = 'pending' WHERE id = \?)"/) || [])[1];
    ok(typeof cronSql === 'string', '静态：从 index.ts 取到 cron 恢复循环的 SQL 原文（就地执行，不复刻一份判据）');
    addTask(db, 'cron-t1', 'paused');
    eq(statusOf(db, 'cron-t1'), 'paused', '前置：cron 任务停在 paused');
    let cronEvt = 0;
    const hCron = (e: { data: Record<string, unknown> }) => {
      if (e.data.taskId === 'cron-t1' && (e.data.newStatus ?? e.data.new_status) === 'pending') cronEvt++;
    };
    eventBus.on('task.status_changed', hCron);
    db.prepare(cronSql!).run('cron-t1');
    await eventBus.emit('task.status_changed', { taskId: 'cron-t1', task_id: 'cron-t1', projectId: 'p', newStatus: 'pending', new_status: 'pending' });
    eventBus.off('task.status_changed', hCron);
    eq(statusOf(db, 'cron-t1'), 'pending', '① 该 SQL 原文在内存库里确实把 paused 改成了 pending（判据不是抄来的）');
    eq(cronEvt, 1, '★ ② cron 路 `task.status_changed{pending}` **0→1**（此前这个转移在事件溯源里不存在，界面停在 paused 需手刷）');
    ok(countEvt('task.status_changed') >= 1, '② 且经真 EventStore 落进 `wa_event_log`（事件溯源可自证，不只在内存订阅者手里）');
    const cronAt = idxSrc.indexOf('const cronTasks = db.prepare(');
    const cronBody = cronAt >= 0 ? idxSrc.slice(cronAt, idxSrc.indexOf('console.log(`[Cron] 恢复', cronAt)) : '';
    ok(cronBody.includes("eventBus.emit('task.status_changed'") && cronBody.includes("newStatus: 'pending'"),
      '静态：该 emit 与 UPDATE 在**同一个** cron 恢复分支内（不在别处另起一处"看起来像"的 emit）',
      cronBody ? 'cron 分支已定位' : '未定位 cron 分支');

    // ── (f) 静态：四处 `task.awaiting_input` 同形 + 缺省方向 + 入队点标注 ──
    const awAe = [...aeSrc.matchAll(/eventBus\.emit\('task\.awaiting_input',\s*\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);
    const awAi = [...aitSrc.matchAll(/eventBus\.emit\('task\.awaiting_input',\s*\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);
    eq(awAe.length, 2, `静态：agent-executor 内 awaiting_input emit 恰 2 处（扫到 ${awAe.length} 处）`);
    eq(awAi.length, 2, `静态：ai-task 内 awaiting_input emit 恰 2 处（扫到 ${awAi.length} 处）`);
    eq([...awAe, ...awAi].filter((p) => !p.includes('asked_at')).length, 0,
      '★ 静态：**四处** payload 均含 `asked_at`（提问有时刻，答复才可能与之同源）');
    eq(((aeSrc + aitSrc).match(/asked_at:\s*['"`]/g) || []).length, 0,
      '★ 静态：**手写 `asked_at` 字面量计数为 0**（取值一律来自 `persistAwaitingInput` 返回值；自造时间戳会让"同源"判据形同虚设）');
    eq(((aeSrc + aitSrc).match(/persistAwaitingInput\(db, taskId, \{/g) || []).length, 4,
      `静态：persist 写点恰 4 处，与 4 处 emit 一一对应（扫到 ${((aeSrc + aitSrc).match(/persistAwaitingInput\(db, taskId, \{/g) || []).length} 处）`);

    ok(psSrc.includes("initiator ?? 'system'") && aitSrc.includes('buildUnansweredBanner(g, payload.initiator'),
      "★ 静态（**缺省方向**）：`initiator` 的缺省在守卫本体一处取 `?? 'system'`，处理器**原样透传**（缺省值即契约，六条非用户路一条都不传）");
    const iniVals = [...psSrc.matchAll(/initiator: '([^']+)'/g)].map((m) => m[1]!);
    eq(iniVals.length, 0, '静态：守卫/落账模块内**不**自造 initiator 取值（缺省由 `??` 一处决定，不散落字面量）');
    const iniUser = [aitSrc, aeSrc, schSrc, imSrc, ipcSrc, idxSrc].flatMap((s) => [...s.matchAll(/initiator:\s*'([^']+)'/g)].map((m) => m[1]!));
    eq([...new Set(iniUser)], ['user'],
      "★ 静态：载荷里 `initiator` **只出现 `'user'` 一种取值**——系统侧一律不传、由缺省兜底（若有人补 `'system'`，语义就从「人不人发起」退化成「两处都要记得写」）");
    ok(iniUser.length >= 5, `静态：显式标注 initiator:'user' 的入队点 ${iniUser.length} 处（下界 5 = IM 4 处 + GUI 载荷构造 1 处；新增用户路径须一并标注，系统路径**不得**标注）`);
    const imIni = (imSrc.match(/initiator:\s*'user'/g) || []).length;
    eq(imIni, 4, `静态：IM 四条用户路（审批确认/选项批准/编号启动/直接回复）各自标注（扫到 ${imIni} 处）`);
    const eRJ = ipcSrc.slice(ipcSrc.indexOf('function enqueueResumeJob('), ipcSrc.indexOf('// D1: 退避重启配置'));
    ok(eRJ.includes("initiator: 'user'") && (eRJ.match(/initiator:/g) || []).length === 1,
      '★ 静态：GUI 三个提交点共用的 `enqueueResumeJob` 内标一次——载荷整体交注入方，两条出口不可能各写一份而分家');
    ok(aitSrc.includes("payload.source") && !psSrc.includes('payload.source'),
      "反证：`source` 在本载荷上的既有含义（'im'/'cron' 渠道）**未被本轮挪作他用**——守卫读的是 `initiator` 而非 `source`");

    ok(BOOL_SETTING_KEYS.includes('engine.answer_provenance'), '静态：回退开关 `engine.answer_provenance` 登记在 `BOOL_SETTING_KEYS` 唯一白名单');
    ok(/readBoolSetting\(db, 'engine\.answer_provenance'\)[\s\S]{0,300}?buildUnansweredBanner\(/.test(aitSrc),
      '★ 静态：守卫受开关包裹（关 ⇒ 不注入横幅，一键回退旧行为，无需回滚提交）');

    // 复原：事件存储解绑，免后续段落的事件写进本节的内存库
    eventBus.setEventStore(null as unknown as EventStore);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S8】P0-6「暂停/偏离通知到得了人」· 真 notification-core + 真 eventBus');
  {
    // 夹具任务**一律不绑 IM 渠道**（ctx 里没有 channel/externalUser）——这正是本条要证的场景：
    // 此前"引擎自置的暂停"根本到不了通知面（`status_changed` 处理器把非 completed 一律 return），
    // 与渠道绑定**无关**。方案 §6.3(c) 原拟在 `markPauseNeeded` 里补一行，经复核**撤销**（那是 IM-only 通路）。
    const db = mkdb();
    setTaskFocus(null);
    // `wa_notifications` 的 DDL **就是**被测代码本体的 `ensureNotificationsTable`（生产同一份），不另抄一份
    subscribeTaskNotifications({ db, eventBus });
    ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wa_notifications'").get() !== undefined,
      '前置：订阅装配即建表（DDL 出自被测代码本体，非夹具另抄）');

    const rows = (t: string): number => (db.prepare('SELECT COUNT(*) c FROM wa_notifications WHERE task_id = ?').get(t) as { c: number }).c;
    const last = (t: string): { type: string; title: string; body: string; read_at: string | null } =>
      db.prepare('SELECT type, title, body, read_at FROM wa_notifications WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(t) as never;
    const unbound = (id: string): boolean => !('channel' in ctxObj(db, id)) && !('externalUser' in ctxObj(db, id));
    const emit = (type: string, data: Record<string, unknown>): Promise<unknown> => eventBus.emit(type as never, data);

    // ── ① 引擎自置暂停（children_failed）：此前**结构上不可能**产生通知行 ──
    addTask(db, 's8-paused', 'paused', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_FAILED } });
    eq(rows('s8-paused'), 0, '前置：通知面 0 行');
    eq(unbound('s8-paused'), true, '前置：该任务**未绑任何 IM 渠道**（"到得了人"要证的正是这一幕）');
    await emit('task.status_changed', { taskId: 's8-paused', projectId: 'p', newStatus: 'paused', new_status: 'paused', reason: PAUSE_REASON_CHILDREN_FAILED });
    eq(rows('s8-paused'), 1, '★ `status_changed{paused}` ⇒ 通知面 **0→1**（正面断言——被吞掉的写入只有正面断言抓得住）');
    eq(last('s8-paused').type, 'task.paused', '…且 `wa_notifications.type` 为 `task.paused`（既有列，无迁移）');
    ok(last('s8-paused').body.includes('子任务失败'), '…且因由由**账上** `ctx.pause_reason` 派生（事件里**没给** detail）');

    // ── ② 暂停因由取自账上（no_output 亦然）──
    addTask(db, 's8-noout', 'paused', { ctx: { pause_reason: PAUSE_REASON_NO_OUTPUT } });
    await emit('task.status_changed', { taskId: 's8-noout', newStatus: 'paused', new_status: 'paused' });
    eq(rows('s8-noout'), 1, '★ 无产出暂停 ⇒ 通知面 0→1');
    ok(last('s8-noout').body.includes('无产出'), '…且 body 含「无产出」（由 `pause_reason` 派生，非调用方自述）');

    // ── ③ `status_changed{failed}`（update_task_status 工具路）此前被丢弃 ──
    addTask(db, 's8-failed', 'failed');
    await emit('task.status_changed', { taskId: 's8-failed', new_status: 'failed', newStatus: 'failed', error: 'FOREIGN KEY constraint failed' });
    eq(rows('s8-failed'), 1, '★ `status_changed{failed}` ⇒ 通知面 0→1（此前只有独立 `task.failed` 事件才落）');
    ok(last('s8-failed').body.includes('FOREIGN KEY constraint failed'), '…且因由取自载荷 `error`（该路自带 `error: args.reason`）');

    // ── ④ `task.goal_deviation` 此前**从未被订阅** ──
    addTask(db, 's8-dev', 'executing');
    await emit('task.goal_deviation', { taskId: 's8-dev', projectId: 'p', goal: '把报告写完', reason: '在改无关的样式表' });
    eq(rows('s8-dev'), 1, '★ `task.goal_deviation` ⇒ 通知面 0→1（此前只进会话流，用户侧看不见）');
    const devRow = last('s8-dev');
    ok(devRow.title.startsWith('任务偏离目标：') && !devRow.title.includes('执行中'),
      '★ 偏离行**不声明状态**（任务此刻仍在 executing——说"执行中/待复核/可恢复"是给一个没停的任务发恢复指引）');
    ok(!devRow.body.includes('待复核') && !devRow.body.includes('可在桌面处理'),
      '…且无恢复引导（与 `paused` 框架的**可判定差异**）');
    ok(buildTaskNotice(db, 's8-dev', 'paused').body.includes('待复核'),
      '反证：同一任务同一时刻，`paused` 框架**确实**会带「待复核」——上一条不是恒真');

    // ── ⑤ 转执行类状态 ⇒ 同任务旧通知随之已读（既有裁定，防刷屏）──
    const beforeUnread = countUnread(db);
    await emit('task.status_changed', { taskId: 's8-paused', newStatus: 'executing', new_status: 'executing' });
    eq(rows('s8-paused'), 1, '★ `status_changed{executing}` **不新增**通知行（执行类状态不是事态）');
    ok(last('s8-paused').read_at !== null, '★ …且该任务既有行 `read_at` 由 NULL 变非 NULL（处置即已读）');
    eq(countUnread(db), beforeUnread - 1, '…且未读计数**实降 1**（角标真源同步；不是"没抛"）');

    // ── ⑥ 与 IM 通路**无关**：IM 开关关 + 未绑渠道 ⇒ 站内面照落 ──
    db.prepare("INSERT INTO wa_settings (key, value) VALUES ('im.notify_pause_needed', 'false')").run();
    addTask(db, 's8-im-off', 'paused', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE } });
    eq(unbound('s8-im-off'), true, '前置：仍未绑渠道');
    await emit('task.status_changed', { taskId: 's8-im-off', newStatus: 'paused', new_status: 'paused' });
    eq(rows('s8-im-off'), 1, '★ `im.notify_pause_needed` 关 **且** 未绑渠道 ⇒ 站内通知仍 0→1（站内面不经过 IM 通路）');

    // ── ⑦ 回退开关：关 ⇒ 逐字回到本轮前行为 ──
    db.prepare("INSERT INTO wa_settings (key, value) VALUES (?, 'false')").run(PAUSE_DEVIATION_KEY);
    addTask(db, 's8-off', 'paused', { ctx: { pause_reason: PAUSE_REASON_CHILDREN_FAILED } });
    await emit('task.status_changed', { taskId: 's8-off', newStatus: 'paused', new_status: 'paused' });
    eq(rows('s8-off'), 0, `回退开关关（\`${PAUSE_DEVIATION_KEY}\`）⇒ \`paused\` 不落通知面（一键回退，无需回滚提交）`);
    addTask(db, 's8-off-dev', 'executing');
    await emit('task.goal_deviation', { taskId: 's8-off-dev', reason: 'x' });
    eq(rows('s8-off-dev'), 0, '回退开关关 ⇒ `goal_deviation` 同样不落（两件事同受一开关）');

    // ── ⑧ 写失败**不再无声**（防吞）──
    const failuresBefore = getNotificationWriteFailures();
    const throwingDb = { exec: () => {}, prepare: () => { throw new Error('disk I/O error'); } } as unknown as AnyDb;
    eq(recordNotification(throwingDb, { type: 'task.paused', taskId: 's8-boom', title: 't', body: 'b' }), false,
      '写失败返回 false（返回值语义**未改**——改它会牵动原生弹窗路径，列 §十一 挂账 3）');
    eq(getNotificationWriteFailures(), failuresBefore + 1,
      '★ 写失败计数 **0→1**（"不抛"断言抓不住被 `try/catch` 吞掉的写入；此前该 catch 是空的）');

    // ── ⑨ 偏离判据：出口不再二次截断 · 三条事实齐备 ──
    const longText = 'R'.repeat(1200);
    const p = buildDeviationPrompt({ goal: '把报告写完', successCriteria: '三章齐 + 可复现', recentText: longText, toolNames: ['bash', 'write_file'], blockers: '缺产出（doc 未落盘）' });
    ok(p.includes('**成功标准**：三章齐 + 可复现'), '★ prompt 含「成功标准」（与核心目标共同定义"要做什么"）');
    ok(p.includes(longText), '★ 加宽后的 `recentText` **一字不截**（旧版 prompt 自身 `slice(0, 600)` 会把加宽白费）');
    ok(p.includes('产出性写入') && p.includes('write_file') && p.includes('不得仅因此判为偏离核心目标'),
      '★ 写豁免免责句在场（与既有 blockerNote 同形，不新增机制）');
    ok(p.includes('硬门禁拦截'), '既有 blockerNote **未被挤掉**（本项只加一条，不改旧的）');
    ok(!p.includes('验收标准'), '★ 词表不许混：prompt 里**不出现**「验收标准」（`acceptance_criteria` 是另一个概念的专名）');
    const pBare = buildDeviationPrompt({ goal: 'g', recentText: 'x' });
    ok(!pBare.includes('产出性写入'), '反证：窗口内无产出性写入时**不出现**免责句（上一条不是恒真）');
    ok(!pBare.includes('成功标准'), '反证：`successCriteria` 缺省时不出现该行');

    // ── ⑩ 写豁免与 `realOutputEvidence` **同源**（同一概念不写两份）──
    const aeSrc2 = engineSrc();
    // 扫描面**按函数体界定**，不扫全文件：本文件另有两处**同形但更窄**的手写 LIKE 链——
    // `agent-executor.ts:1388`（tension `speed-vs-quality` 定稿闸的 `codeEdit`）与
    // `:5394`（研究/文档/分析降分的 `hasCodeEdits`），两者皆 `write_file|edit_file` 而**不含**
    // `register_deliverable` ⇒ 那是「**代码编辑**」，不是「**产出性写入**」。
    // 合并会改行为（只注册过交付物的任务会开始通过那两道闸），非本轮授权范围 ⇒ 列 §十一 挂账 14。
    // 判据若扫全文件，就会把这两处**别的概念**当成"重抄第二份"而误红（本项首跑即如此：2 vs 0）。
    const roeAt = aeSrc2.indexOf('export function realOutputEvidence');
    ok(roeAt > 0, '前置：找得到 `realOutputEvidence`（下方两条的扫描面由它界定）');
    const roeBody = aeSrc2.slice(roeAt, aeSrc2.indexOf('\n}\n', roeAt) + 3);
    eq((roeBody.match(/content LIKE '%write_file%'/g) || []).length, 0,
      '★ 静态：`realOutputEvidence` **函数体内**手写 `write_file` LIKE 链计数 **0**（判据由常量派生，不手抄第二份）');
    ok(/\$\{ARTIFACT_WRITE_LIKES\}/.test(roeBody), '★ 静态：`realOutputEvidence` 的 LIKE 链由 `ARTIFACT_WRITE_LIKES` 插值');
    ok((("content LIKE '%write_file%'").match(/content LIKE '%write_file%'/g) || []).length === 1,
      '**反证：该正则抓得住手写链**（上面那条的"0"不是"正则失效恒 0"——判据自身也受判据管）');
    addConv(db, 's8-write', 'tool', '[write_file]\n{"ok":true,"path":"r.md"}');
    addConv(db, 's8-write', 'tool', '[bash]\n{"cmd":"ls"}');
    eq(readRecentToolNames(db, 's8-write', 5), ['bash', 'write_file'],
      '★ `readRecentToolNames` 按**实测格式**取行（`[toolName]` 首段，rowid 逆序＝真实插入序）');
    eq(hasArtifactWrite(readRecentToolNames(db, 's8-write', 5)), true, '★ 写豁免命中（窗口内有 write_file）');
    eq(realOutputEvidence(db, 's8-write'), true, '★ 同一批工具名下 `realOutputEvidence` 亦为真（两消费者同源，不各判各的）');
    addConv(db, 's8-write', 'tool', '[工具调用] read_file({"filePath":"a"})');
    eq(readRecentToolNames(db, 's8-write', 5).includes('工具调用'), false,
      "★ 不重复 `ai-task.ts:558` 的死读：`[工具调用] …` 行的 role 是 `system`，按 `role='tool'` 取不到（列 §十一 挂账 13）");
    addConv(db, 's8-nowrite', 'tool', '[bash]\n{"cmd":"ls"}');
    eq(hasArtifactWrite(readRecentToolNames(db, 's8-nowrite', 5)), false,
      '反证：窗口内只有 `bash` 时不判写豁免（上一条不是恒真）');

    // ── ⑪ 静态：订阅面**下界**覆盖五类（方向性比较——新增订阅不该弄红）──
    const subSrc = RD(`${A}/src/main/core/notification-core.ts`);
    const subscribed = new Set([...subSrc.matchAll(/eventBus\.on\('([^']+)'/g)].map((m) => m[1]!));
    for (const t of ['task.failed', 'task.awaiting_input', 'task.completed', 'task.status_changed', 'task.goal_deviation']) {
      ok(subscribed.has(t), `★ 订阅面覆盖 \`${t}\``);
    }
    ok(subscribed.size >= 5, `订阅面下界 ≥5（实测 ${subscribed.size}）`);
    ok(/eventBus\.on\('task\.goal_deviation',[\s\S]{0,300}?readBoolSetting\(db, PAUSE_DEVIATION_KEY\)/.test(subSrc),
      '★ 开关**处理器内门控**（订阅与否在装配那一刻决定；按"不订阅"实现会要重启才生效，与其余开关语义不符）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S9】M5/P0-7 shell 拒绝文案如实化 + 工具能力简报（判据直调真实现 + 行为保持参照物）');
  {
    const CWD = '/proj/task-1';

    // ── ① §7.6 的四条行为判据（直调真实现）──
    const r1 = classifyShellReject('cd /x && git status', 'execute_command', CWD);
    eq(r1.ok, false, '★ §7.6①：`cd /x && git status` 被拒');
    eq(r1.ok === false ? r1.char : null, '&', '★ §7.6②：`char` 指名被拒字符（`&`）——不再只说"包含非法字符"');
    ok(r1.ok === false && r1.advice.includes('无需'), '★ §7.6③：advice 含「无需 `cd`」（cwd 已是项目目录这条**要告诉模型**）');
    ok(r1.ok === false && !r1.advice.includes('run_privileged'),
      '★ §7.6④：advice **不含** `run_privileged`（撤掉误导——语法问题不是权限问题）');
    eq(classifyShellReject('git status --short', 'execute_command', CWD).ok, true, '★ §7.6 防误伤：合法无分隔符命令放行');

    // ── ② 「两把工具确有分工、不可合并成一把」的**行为钉子**（同一条命令两把下结论相反）──
    eq(classifyShellReject('grep -n a f | head', 'bash', CWD).ok, true, '★ §7.6：管道命令在 `bash` 下放行（bash 支持 `|`）');
    const r2 = classifyShellReject('grep -n a f | head', 'execute_command', CWD);
    eq(r2.ok, false, '★ §7.6：同一条命令在 `execute_command` 下被拒（两把工具确有分工）');
    ok(r2.ok === false && r2.advice.includes('bash'), '★ §7.6：被拒时 advice **指向正解**（改用 `bash` 工具），而非指向审批');
    eq(SHELL_REJECT_CHARS.execute_command.includes('$'), true, '★ 前提：`execute_command` 按字符拒 `$`');
    eq(SHELL_REJECT_CHARS.bash.includes('$'), false,
      '★ `bash` **不**按字符拒 `$`（下一轮若有人好心把两张表并成一份含 `$`，此处即红）');
    eq(classifyShellReject('echo $HOME', 'bash', CWD).ok, true, '★ 故 `echo $HOME` 在 bash 下**仍放行**（并表即行为变更）');
    eq(classifyShellReject('echo $HOME', 'execute_command', CWD).ok, false, '★ 同句在 `execute_command` 下被拒（`$` 属它的字符集）');

    // ── ③ 行为保持参照物：**改动前的两条裸正则**留在测试里当参照，逐例对拍 ──
    // 判据代码只剩一处（下方 ④ 证明旧字面量已删），但"删"本身不等于"语义没变"——
    // 故这里保留旧判据作 oracle：新旧对同一批命令必须给出**逐例相同**的结论。
    const OLD_EXEC_RE = /[;&|`$\n]/;
    const OLD_BASH_RE = /[\n;&`]/;
    const CORPUS = [
      'git status', 'cd /x && git status', 'ls | head', 'ls; pwd', 'pwd', 'echo $HOME', 'echo $(date)',
      'cat a && cat b', 'grep -n a f | head', 'ls > out.txt', 'find . -name x', 'sed -i "" s/a/b/ f',
      'ls\npwd', 'echo `date`', 'git commit -m "a;b"', 'awk -F, \'{print $1}\' f', 'wc -l f',
    ];
    const execDiff: string[] = []; const bashDiff: string[] = [];
    for (const c of CORPUS) {
      if (!!firstRejectedShellChar(c, 'execute_command') !== OLD_EXEC_RE.test(c)) execDiff.push(c);
      if (!!firstRejectedShellChar(c, 'bash') !== OLD_BASH_RE.test(c)) bashDiff.push(c);
    }
    eq(execDiff, [], `★ 对拍 ${CORPUS.length} 例：新判据与旧正则（execute_command）结论**逐例相同**（行为零变更）`);
    eq(bashDiff, [], `★ 对拍 ${CORPUS.length} 例：新判据与旧正则（bash）结论**逐例相同**`);
    // 反证：oracle 抓得住差异（否则上面两条的"逐例相同"是"两边都恒假"造成的假绿）
    eq(!!firstRejectedShellChar('ls | head', 'execute_command') !== OLD_BASH_RE.test('ls | head'), true,
      '**反证：对拍确实能发现差异**（把 execute_command 的字符表误当成 bash 的用，立刻不等）');
    // `bash` 字符级**不没收**某个字符的既有语义：`$` 交由 `$()`/`${}` 那一支单独拦
    eq(validateReadonlyBashCommand('echo $(date)').ok, false, '★ `echo $(date)` 仍被 bash 拦（`$()` 支，不靠字符表）');

    // ── ④ 判据**只剩一处**：两处旧裸正则已删（防"两套判据"复发）──
    const aeSrc9 = stripComments(engineSrc());
    const tgSrc9 = stripComments(RD(`${A}/src/main/core/tool-guards.ts`));
    eq(aeSrc9.includes(OLD_EXEC_RE.source), false,
      '★ 静态：`agent-executor.ts` 内**已无**旧裸正则字面量（改调 `shellRejectPayload`——两处调用、一处实现）');
    eq(tgSrc9.includes(OLD_BASH_RE.source), false,
      '★ 静态：`tool-guards.ts` 内**已无**旧裸正则字面量（改调 `firstRejectedShellChar`）');
    // 反证：上面两条的"没有"不是"扫描面写错导致恒真"
    ok(OLD_EXEC_RE.source.length > 0 && OLD_BASH_RE.source.length > 0 && tgSrc9.includes('validateReadonlyBashCommand'),
      '**反证：扫描面本身有效**（源文本读到了、oracle 字面量非空）');
    ok(tgSrc9.includes('shellRejectPayloadForChar') && tgSrc9.includes('classifyShellReject'),
      '★ 判定/文案/回退三件事同处 `tool-guards.ts`（回退文案不散回两个调用点）');

    // ── ⑤ 回退开关：`honest=false` ⇒ 逐字回到**改动前**的两句原文 ──
    const rollExec = shellRejectPayload('cd /x && git status', 'execute_command', CWD, false);
    eq(rollExec, { error: '命令包含非法字符。请拆分命令或使用 run_privileged 执行特权命令。' },
      '★ 回退：`execute_command` 回到旧文案（与实施前逐字相同）');
    const rollBash = shellRejectPayload('ls; pwd', 'bash', CWD, false);
    eq(rollBash, { error: '命令包含换行/分隔符/命令替换，禁止执行。' }, '★ 回退：`bash` 回到旧文案（逐字相同）');
    const onExec = shellRejectPayload('cd /x && git status', 'execute_command', CWD, true);
    ok(onExec !== null && typeof onExec.advice === 'string' && onExec.char === '&',
      '★ 开：如实 payload 带 `char` 与 `advice`（`honest=false` 那份**不带**这两个键，故回退是逐字回退）');
    eq(shellRejectPayload('git status', 'execute_command', CWD, true), null,
      '★ 未命中字符拒绝时返回 `null`（调用方据此让其它判据接管，不误拦）');

    // ── ⑥ 界桩：`bash` 校验只在**字符级**那一支带 `char`（其余七支一字不动）──
    eq((validateReadonlyBashCommand('ls; pwd').payload as { char?: string }).char, ';',
      '★ 字符级拒绝带 `char`（调用方据此决定换文案）');
    eq((validateReadonlyBashCommand('curl https://x').payload as { char?: string }).char, undefined,
      '★ 白名单拒绝**不带** `char` ⇒ 文案原样（界桩精确，不误换）');
    // ⚠ 校验**顺序**本身是不变量，也是界桩能成立的前提：破坏性 → 字符级 → 段循环。
    // 故"看起来该走字符级"的命令里，含破坏性模式的那条仍先报破坏性——若有人调了顺序，此处即红
    // （首写本测试时按"想当然的支路"下断言，被真实现纠正了两次，两次都不是实现有问题而是**断言想当然**）。
    eq((validateReadonlyBashCommand('ls; rm -rf /').payload as { error?: string }).error, '破坏性命令被拦截',
      '★ 顺序未变：`ls; rm -rf /` 先报**破坏性**（破坏性那支早于字符级那支）');
    eq((validateReadonlyBashCommand('find . -exec rm {} \\;').payload as { error?: string }).error, '命令包含换行/分隔符/命令替换，禁止执行。',
      '★ 顺序未变：`find … \\;` 先报**字符级**（`;` 早于段循环里的 find 支）');
    // 真正到达各支的命令（无被拒字符）——逐支钉文案"一字未动"
    eq((validateReadonlyBashCommand('sed -i "" s/a/b/ f').payload as { error?: string }).error, 'sed -i 禁止，用 write_file 修改文件',
      '★ `sed -i` 支文案一字未动');
    eq((validateReadonlyBashCommand('find . -name "*.py" -delete').payload as { error?: string }).error, 'find -exec/-delete 禁止',
      '★ `find -exec/-delete` 支文案一字未动');
    eq((validateReadonlyBashCommand('cat a > b').payload as { error?: string }).error, '重定向被禁止，写文件请用 write_file',
      '★ 重定向支文案一字未动');
    eq((validateReadonlyBashCommand('bash -c "ls"').payload as { message?: string }).message, '禁止直接执行shell解释器。请使用 ask_user 请求批准，用户批准后 run_privileged 执行。',
      '★ 解释器支文案一字未动');
    eq((validateReadonlyBashCommand('rm -rf /tmp/x').payload as { error?: string }).error, '破坏性命令被拦截',
      '★ 破坏性支文案一字未动（校验顺序未变）');
    eq((validateReadonlyBashCommand('curl https://x').payload as { error?: string }).error, 'curl 不在只读白名单。特权命令(安装依赖/启动服务)请用 ask_user→run_privileged。',
      '★ 白名单支文案一字未动（特权指引留在它该在的地方——**不**被 M5 撤掉）');
    eq(shellRejectPayloadForChar(';', 'bash', CWD).error,
      shellRejectPayload('ls; pwd', 'bash', CWD, true)?.error,
      '同字符经两条入口产出**同一句**文案（一处真源，不是两份模板）');

    // ── ⑦ 简报：条数**由源码派生**（不写死数字）──
    const brief = buildToolConstraintBrief();
    const m = /共 (\d+) 条/.exec(brief);
    ok(m !== null, '★ 简报含白名单条数（形如「共 N 条」）');
    eq(m ? Number(m[1]) : -1, SAFE_READONLY_COMMANDS.size,
      '★ 简报条数 **等于** `SAFE_READONLY_COMMANDS.size`（等值比较、由源码派生——不写死数字）');
    ok(brief.includes('无需 `cd`'), '★ 简报点名「无需 cd」（规矩告诉模型，别让它猜）');
    ok(brief.includes('bash') && brief.includes('execute_command') && brief.includes('write_file'),
      '★ 简报同时点名两把工具与写入工具（分工 + 正解）');
    const briefChars = SHELL_REJECT_CHARS.bash.filter((c) => !brief.includes(c === '\n' ? '\\n' : c));
    eq(briefChars, [], '★ 简报的字符表**来自 `SHELL_REJECT_CHARS`**（该表任一项未出现在简报里即红）');

    // ── ⑧ 注入点：独立 system 消息，紧接 `SYSTEM_PROMPT_BASE`，受开关门控 ──
    // zx_20261018_2 批三：装配已收敛为「块容器 + `CONTEXT_BLOCK_ORDER` 一次物化」，注入点由
    //   `agent-executor` 的就地 `messages.push` 迁到 `exec-context.ts` 的 `add(块, 内容)`——判据随真源重定向
    //   （钉更严：不只"存在"，还要求**块序紧邻**；任何条件块插到中间都会打散前缀。旧形只是一段 600 字符窗）。
    const ecSrc = stripComments(RD(`${A}/src/main/core/exec-context.ts`));
    ok(/add\('system_prompt', SYSTEM_PROMPT_BASE\)/.test(ecSrc)
      && /add\('tool_brief', buildToolConstraintBrief\(\)\)/.test(ecSrc),
      '★ 简报以**独立 system 消息块**注入（块容器；写进模板常量就得把条数落成字面量）');
    ok(/CONTEXT_BLOCK_ORDER[\s\S]{0,300}?'system_prompt',\s*'tool_brief'/.test(ecSrc),
      '★ 块序**紧邻**：`tool_brief` 紧跟 `system_prompt`（位置由块序常量唯一决定）');
    ok(/readBoolSetting\(db, 'engine\.shell_advice_honest'\)[\s\S]{0,200}?buildToolConstraintBrief\(\)/.test(aeSrc9),
      '★ 注入受 `engine.shell_advice_honest` 门控（关 ⇒ 不注入；判据仍可被本回归直调）');
    ok(BOOL_SETTING_KEYS.includes('engine.shell_advice_honest'),
      '★ 开关已登记进 `BOOL_SETTING_KEYS`（与判据同源的那一份白名单）');
    ok(aeSrc9.includes("shellRejectPayload(args.command, 'execute_command', workingDir, readBoolSetting(db, 'engine.shell_advice_honest'))"),
      '★ `execute_command` 调用点接到了真源（工具内**读侧**也受同一开关）');
    const exeDesc = /execute_command: \{\s*description: '([^']*)'/.exec(aeSrc9)?.[1] ?? '';
    const bashDesc = /bash: \{\s*description: '([^']*)'/.exec(aeSrc9)?.[1] ?? '';
    ok(exeDesc.includes('无需'), '★ `execute_command` 的 description 含「无需 `cd`」（分工写进 description）');
    ok(bashDesc.includes('只读') && bashDesc.includes('管道'), '★ `bash` 的 description 含「只读」与「管道」');
    ok(exeDesc !== bashDesc && exeDesc.length > 0 && bashDesc.length > 0,
      '★ 两把工具的 description **不再同文**（由同义改为分工明确）');
    // 类目注释在 `/* *\/` 块内 ⇒ 扫**原始**文本（stripComments 会把注释整块去掉）
    ok(RD(`${A}/src/main/core/tool-registry.ts`).includes('shell   命令执行')
      && RD(`${A}/src/main/core/tool-registry.ts`).includes('**支持 `|` 管道**'),
      '★ `tool-registry.ts` 的 `shell` 类目注释写入同一分工口径（类目侧与工具侧同词表）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S10】P0-9 里程碑主体 · 板内幂等 · reference 引用模式（真工具 · 真 execute）');
  {
    /** 真调生产 `finalize_task`（不切片、不复刻判据——同 §S1b 范式）；里程碑登记段在其内 */
    const fin = async (db: AnyDb, taskId: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const tools = buildTools({ db } as never, taskId, 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      return tools.finalize_task!.execute({ summary: '按方案分步实施完成', quality: 'good', ...extra });
    };
    const finChecks = (db: AnyDb, id: string): string[] => (ctxObj(db, id).finalize_checks as string[] | undefined) ?? [];
    const boardMs = (db: AnyDb, planTaskId: string): string[] =>
      (db.prepare('SELECT milestone FROM wa_plan_milestones WHERE plan_task_id = ? ORDER BY milestone').all(planTaskId) as Array<{ milestone: string }>).map((r) => r.milestone);
    const allMs = (db: AnyDb): number => (db.prepare('SELECT COUNT(*) c FROM wa_plan_milestones').get() as { c: number }).c;
    /** 造一份含 M 项的 doc 产物——真文件，registry 行指向它（finalize 的 doc 扫描读的就是它） */
    const docWith = (name: string, ms: string[]): string => tmpFile(name, `# 方案\n\n${ms.map((m) => `${m}：待实施`).join('\n')}\n`);
    const addMilestone = (db: AnyDb, id: string, planTaskId: string, ms: string, implBy?: string): void => {
      db.prepare("INSERT INTO wa_plan_milestones (id, project_id, plan_task_id, milestone, status, implemented_by_task_id) VALUES (?, 'p', ?, ?, 'pending', ?)")
        .run(id, planTaskId, ms, implBy ?? null);
    };

    // ── (a) 核验类任务不得挂板（真库 8a6f226a 的复现） ──
    {
      const db = mkdb();
      addTask(db, 'v-verify', 'executing', { title: '20260915 规划方案实施结果核验', description: '核验 plans/improve/zx_20260915.md 的落地情况' });
      addDeliv(db, 'd-v', 'v-verify', { type: 'doc', file_path: docWith('verify-plan.md', ['M0', 'M1', 'M2']) });
      await fin(db, 'v-verify');
      ok(ctxObj(db, 'v-verify').plan_milestones_registered !== true,
        '★ 核验类任务 **不置** plan_milestones_registered（正面断言：旧代码此处恒为 true）');
      ok(finChecks(db, 'v-verify').some((c) => c.includes('核验类')),
        '★ checks 如实记「本任务为核验类，不登记方案里程碑」');
      eq(allMs(db), 0, '★ 里程碑总数 **0 → 0**（一枚也没增）');
      eq(boardMs(db, 'v-verify').length, 0, '★ 且未为它自建板（不存在"自建自关"的空板）');
    }

    // ── (a′) 核验**优先于**规划：标题同时命中两套词时仍不登记（8a6f226a 的真实标题即此形态） ──
    {
      const t = '20260914 规划方案实施结果核验';
      ok(isVerificationTask(t) && isPlanOrImplTask(t),
        '前置：该标题**同时**命中核验类与规划类两套词（真库 8a6f226a 的标题形态）');
      const v = milestoneSubjectVerdict(t, 'code');
      ok(!v.ok && v.reason.includes('核验类'),
        '★ 核验优先：两套词同时命中时判**不登记**（若判型顺序反了，8a6f226a 那块板仍会长出来）');
    }

    // ── (b) 板内幂等 + 如实计数 ──
    {
      const db = mkdb();
      addMilestone(db, 'pre-0', 'planner', 'M0', 'impl-old');
      addTask(db, 'planner', 'executing', { title: '20260915 功能优化规划', description: '方案见 plans/improve/zx_20260915.md' });
      addDeliv(db, 'd-b', 'planner', { type: 'doc', file_path: docWith('round-plan.md', ['M0', 'M1']) });
      const before = boardMs(db, 'planner').length;
      await fin(db, 'planner');
      eq(boardMs(db, 'planner').length, before + 1,
        '★ 板内幂等：M0 已在目标板上 ⇒ 只新增 M1（板行数 +1，而非 +2）');
      eq(boardMs(db, 'planner'), ['M0', 'M1'], '且既有行 M0 **原样保留**（幂等=不改既有行，不是删了重插）');
      const hit = finChecks(db, 'planner').find((c) => c.includes('已存在') && c.includes('未重复登记'));
      ok(!!hit, '★ checks 记「里程碑 M0 已存在（任务 …），未重复登记」');
      ok(!!hit && hit.includes('impl-old'.slice(0, 8)),
        '★ 该行点名**归属任务**（取 implemented_by_task_id 的 id8，不是空话）');
      ok(finChecks(db, 'planner').some((c) => c.includes('已登记方案里程碑 M1')),
        '★ 新登记的那枚照旧如实报（"登记了什么"与"跳过了什么"两笔都记）');
    }

    // ── (b′) 跨板同名**不**跳过（乙-① 的正面证据：「每轮一块新板」不被压制） ──
    {
      const db = mkdb();
      for (const ms of ['M0', 'M1']) addMilestone(db, `other-${ms}`, 'other-round', ms);
      eq(allMs(db), 2, '前置：另一块板已持有 M0/M1（真库形态：M0 同时在 18 块板上）');
      addTask(db, 'new-round', 'executing', { title: '20260916 功能优化规划', description: '方案见 plans/improve/zx_20260916.md' });
      addDeliv(db, 'd-b2', 'new-round', { type: 'doc', file_path: docWith('next-round-plan.md', ['M0', 'M1']) });
      await fin(db, 'new-round');
      eq(boardMs(db, 'new-round'), ['M0', 'M1'],
        '★ 跨板同名**不**跳过：新轮规划任务仍拥有自己那块板（这是全部 21 块板的唯一成因）');
      eq(allMs(db), 4, '★ 全表 2 → 4（若按"同项目同标题已存在即跳过"，这里会是 2 —— 那会压制每一轮新板）');
    }

    // ── (c) 防误伤：板上无同名 ⇒ 照旧登记（行为不变） ──
    {
      const db = mkdb();
      addTask(db, 'fresh', 'executing', { title: '20260916 功能优化规划', description: 'plans/improve/zx_20260916.md' });
      addDeliv(db, 'd-c', 'fresh', { type: 'doc', file_path: docWith('fresh-plan.md', ['M0', 'M1', 'M2']) });
      await fin(db, 'fresh');
      eq(boardMs(db, 'fresh'), ['M0', 'M1', 'M2'], '★ 防误伤：板上无同名 ⇒ 三枚全部登记（0 → 3，旧行为分毫未动）');
      eq(ctxObj(db, 'fresh').plan_milestones_registered, true, '且照旧置 plan_milestones_registered=true');
    }

    // ── (d) scheme_ref_mode='reference'：只引用，不登记、不置"待实施" ──
    {
      const db = mkdb();
      addTask(db, 'refmode', 'executing', { title: '20260915 功能优化规划（引用）', description: '方案见 plans/improve/zx_20260915.md' });
      addDeliv(db, 'd-d', 'refmode', { type: 'doc', file_path: docWith('ref-plan.md', ['M0', 'M1']) });
      await fin(db, 'refmode', { scheme_ref_mode: 'reference' });
      eq(allMs(db), 0, '★ reference ⇒ **不创建**任何里程碑（全表 0 行 ⇒ 也就没有 status=pending 的新行）');
      eq(boardMs(db, 'refmode').length, 0, '★ 且**不置**"待实施"（未自建板）');
      ok(ctxObj(db, 'refmode').plan_milestones_registered !== true,
        '且不置 plan_milestones_registered（此后改主意走 implement 仍可正常登记）');
      ok(finChecks(db, 'refmode').some((c) => c.includes('引用模式')), '★ checks 记「方案引用模式（reference）：…不登记、不置"待实施"」');
    }

    // ── (e) 静态真源 + 旧字面量删除证明 ──
    {
      const taSrc = stripComments(RD(`${A}/src/main/core/task-accounting.ts`));
      ok(taSrc.includes('export const VERIFICATION_TASK_KEYWORDS') && taSrc.includes('export const PLAN_TASK_KEYWORDS'),
        '★ 核验类与规划/实施类两套词**同处一个真源**（core/task-accounting.ts，不两处各写一版正则）');
      ok(taSrc.includes('export function milestoneSubjectVerdict'),
        '★ 主体判定函数亦在该真源内（rr 直引真实现，不切片复刻）');
      ok(!/const isPlanish = \/\(规划\|排期\|方案\)\//.test(aeSrc),
        '★ `agent-executor.ts` 里旧裸正则 `/(规划|排期|方案)/` 已删（判据代码只剩一处）');
      ok(aeSrc.includes('isPlanOrImplTask(') && aeSrc.includes('milestoneSubjectVerdict('),
        '★ 改为调用真源函数（就地裸正则 → 同源函数）');
      ok(aeSrc.includes("engine.milestone_subject_check"), '★ 回退开关在登记段被读');
      ok(BOOL_SETTING_KEYS.includes('engine.milestone_subject_check'),
        '★ 回退开关 `engine.milestone_subject_check` 在 `BOOL_SETTING_KEYS` 名册内（否则关不掉＝白设）');
      ok(/isPlanProposal = \/\(规划\|排期\)\//.test(aeSrc),
        '反证：`:1121` 的 `isPlanProposal` **仍是自己的词表**（刻意不并入，理由就地注明——并表会同时改掉"下钻修复"那条判据）');
      // 每个关键词各造一例，防"词表里躺着一个永不命中的死词"
      const deadV = VERIFICATION_TASK_KEYWORDS.filter((k) => !milestoneSubjectVerdict(`前置说明${k}`, 'code').ok);
      eq(deadV, [...VERIFICATION_TASK_KEYWORDS], '★ 核验类词表逐词生效（无一枚死词）');
      const deadP = PLAN_TASK_KEYWORDS.filter((k) => milestoneSubjectVerdict(`说明${k}`, 'code').ok);
      eq(deadP, [...PLAN_TASK_KEYWORDS], '★ 规划/实施类词表逐词生效（无一枚死词）');
    }

    // ── (f) 判据边角：两向如实 + 防误伤 ──
    {
      const bad = [undefined, null, '', '   ', '随手记一则'];
      eq(bad.map((t) => milestoneSubjectVerdict(t as never, null).ok), [false, false, false, false, false],
        '★ 空/未定义文本 ⇒ 一律不登记（不抛错、不默认放行）');
      eq(milestoneSubjectVerdict('随手记一则', 'conversation').ok, false, '★ `conversation` 原型 ⇒ 非主体，不登记');
      eq(milestoneSubjectVerdict('20260915 功能优化规划', 'research').ok, true,
        '★ 防误伤：`research` **不**排除——真库 21 块板中 5 块板主正是 research（「功能优化规划」在本仓被判为 research）');
      eq(milestoneSubjectVerdict('20260915 功能优化规划', undefined).ok, true,
        '★ 防误伤：archetype 缺失（老任务/子代理路径）⇒ 不因"读不到"而拒（缺省放行，回退到关键词判据）');
      // 两向如实：新判据相对旧判据**既收窄也放松**，两个方向都钉，不假装只有一向
      const oldGate = (t: string, n: number) => n >= 2 || /(规划|排期|方案)/.test(t);
      const newGate = (t: string, n: number) => n > 0 && isPlanOrImplTask(t) && milestoneSubjectVerdict(t, null).ok;
      ok(oldGate('A_20260904 M6 全量回归收尾', 3) && !newGate('A_20260904 M6 全量回归收尾', 3),
        '★ 收窄方向：旧判据靠"文档里凑够 2 个 M\\d"即登记，新判据要求规划/实施类 ⇒ 此类不再自建板（真库 4 块板即此形态）');
      ok(!oldGate('20260916 功能实施', 1) && newGate('20260916 功能实施', 1),
        '★ 放松方向（**如实登记**，不假装只收窄）：词表纳入「计划/实施」⇒ 仅含该词的任务此前不登记、此后登记');
      const CORPUS: Array<[string, number]> = [
        ['A_20260904 M6 全量回归收尾', 3], ['20260916 功能实施', 1], ['随手记一则', 0], ['20260915 功能优化规划', 9],
      ];
      eq(CORPUS.map(([t, n]) => `${oldGate(t, n)}/${newGate(t, n)}`).sort(),
        ['false/false', 'false/true', 'true/false', 'true/true'],
        '反证：上述两个方向不是恒真——四组语料上 (旧判据/新判据) 取遍 true/false 的**四种**组合（两判据各自可辨，非同一函数）');
    }

    // ── (g) 回退开关关 ⇒ 逐例回到旧行为（核验类**仍会**登记） ──
    {
      const db = mkdb();
      db.prepare("INSERT INTO wa_settings (key, value) VALUES ('engine.milestone_subject_check', 'false')").run();
      addTask(db, 'sw-verify', 'executing', { title: '20260915 规划方案实施结果核验', description: '核验 plans/improve/zx_20260915.md' });
      addDeliv(db, 'd-g', 'sw-verify', { type: 'doc', file_path: docWith('sw-off.md', ['M0', 'M1']) });
      await fin(db, 'sw-verify');
      eq(boardMs(db, 'sw-verify'), ['M0', 'M1'], '★ 开关关 ⇒ 回到"一律登记、不查重"：核验类任务**仍**登记两枚');
      eq(ctxObj(db, 'sw-verify').plan_milestones_registered, true, '★ 且照旧置 true（回退的是整条判据，不是半条）');
      ok(!finChecks(db, 'sw-verify').some((c) => c.includes('核验类')), '且不再刷"核验类"说明（旧文案一并回来）');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S4】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

void main().then(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260915: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
