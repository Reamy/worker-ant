/**
 * zx_20261021_2 受控复跑 —— 「止」：归档即停 / 终态不可覆写 / 派生任务须成话。
 *
 * 由来（2026-10-21 对怡寿里「20260924 规划方案实施结果核验」的实机复核）：
 *   引擎在 03:09 / 03:46 把两个修复任务归档后，执行体仍在跑（分别再走 **72 / 87 步**），收尾段又把
 *   `archived` 覆写成 `paused` / `completed`——"归档"只活在事件里，库里一次也没留住。
 *   同时，核实报告派生的修复任务，描述是 `1. 不通过` / `8. ️ 静态成立` 这类**判定词碎片**：
 *   取的是表格里"第一个含 ❌/⚠️ 的单元格"，而那一格恰是判定列。
 *
 * 本轮口径（道德经·知止 / 维特根斯坦·意义即用法 / 毛选·实事求是）：
 *   - 「归档」的用法是"这件事了结了"⇒ 在途执行体必须真停下，终态不得被任何下一段流程改写；
 *   - 「修复 X」要求 X 是一句说得清的话；`不通过` 是判定，不是 X；
 *   - 名实相符：账上 `archived`，程序就不得再写一个字。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：A/B 组直引 `archiveTask` / `pauseTask` / 注册表真实现；C/D 组经
 *       `buildTools` 造真工具、调真 `execute`；D-1~D-6 直引 `extractVerificationIssues`。
 *   G-2 **两侧标本**：每条"该命中"都配反证（终态三只 vs executing 一只；有在途 run vs 无；
 *       同值幂等 vs 改值拒绝；判定碎片 vs 真问题）。计数器类断言给"0→1"正面证据。
 *   G-6 **无轮次字面量**：轮次标识由 `path.basename(__filename)` 派生（S 组自检）。
 *   ⚠ 静态判据**按符号切片**（不按行号）；判"接线那一跳"读去注释后的代码
 *     （去注释是为了不被注释里的同名调用骗过；本文件的断言文案里**不写**失败字形）。
 *   ⚠ 夹具 DDL 逐列照抄 `database.ts`（不做"比生产宽松"的简化）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：读真源**静态导入**（被删/改名即编译期失败）。
import { archiveTask } from '../apps/worker-ant-desktop/src/main/core/task-archive.js';
import { pauseTask } from '../apps/worker-ant-desktop/src/main/core/pause-task.js';
import { PAUSE_REASON_QUALITY_BELOW_BAR } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { registerTaskRun, unregisterTaskRun, abortTaskRun, hasTaskRun } from '../apps/worker-ant-desktop/src/main/core/task-run-registry.js';
import { isTerminalStatus } from '../apps/worker-ant-desktop/src/main/core/task-jobs.js';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { extractVerificationIssues, createVerificationFixTask, MAX_VERIFICATION_ISSUES, isReportDocPath } from '../apps/worker-ant-desktop/src/main/core/verification-issues.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 判"接线/调用形状"读**去注释后**的代码；判"注释在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本轮标识由载体自身派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/* ── 夹具 schema：逐列照抄 database.ts DDL（含 ALTER 补列），被查的列一列不缺 ── */
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
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT,
  message_json TEXT, direction TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
  kind TEXT NOT NULL, suppressed INTEGER DEFAULT 0, at INTEGER NOT NULL);
`;
type AnyDb = import('better-sqlite3').Database;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx21-2-'));

const statusOf = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const ctxObj = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const addTask = (db: AnyDb, id: string, status: string, o: { parent?: string | null; ctx?: Record<string, unknown>; title?: string; description?: string; dependsOn?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, status, depends_on, source, context_json)
              VALUES (?, 'p', ?, ?, ?, ?, ?, 'test', ?)`)
    .run(id, o.parent ?? '', o.title ?? id, o.description ?? '', status, o.dependsOn ?? '', JSON.stringify(o.ctx ?? {}));
};
const addDoc = (db: AnyDb, id: string, taskId: string, filePath: string): void => {
  db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, 'p', ?, 'doc', ?, 'draft', ?)")
    .run(id, taskId, path.basename(filePath), filePath);
};
const addConv = (db: AnyDb, taskId: string, role: string, content: string): void => {
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 0)")
    .run(taskId, role, content);
};
const jobCount = (db: AnyDb): number => (db.prepare('SELECT COUNT(*) c FROM wa_jobs').get() as { c: number }).c;

/** 本次事故的**真实报告片段**（节选，列结构照真报告：项 | 判定 | 说明/依据）。 */
const REPORT_TEXT = [
  '# 20260924 实施结果核验总报告',
  '',
  '| 检查项 | 判定 | 说明 |',
  '| --- | --- | --- |',
  '| 端到端业务链（下单→派单→履约→完成→支付→回款） | ⚠️ **代码级通过，实调未完成** | 链路代码齐备；受环境限制未实跑 |',
  '| 页面数据来源真实性 | ⚠️ **部分通过** | 11 页仍读静态 mock，其中**价格与后端锁价不同源**（R-10，交易正确性风险） |',
  '| 生产就绪 | ❌ **不通过** | 3 项上线阻断：后端 /upload 缺失、属地化定价未落地、履约定位为模拟实现 |',
  '| M1-BUG-13 | /upload 前端纯 mock | ⚠️ 半闭环（后端无端点→R-06b） |',
  '',
  '### 8. ⚠️ 演示级',
  '',
  '| 编号 | 判定 | 依据 |',
  '| --- | --- | --- |',
  '| 1 | ⚠️ 不通过 | 依据：状态机的 3 个分支未接入 |',
  '| 4 | ⚠️ 需修正 | 键名不一致：acceptance_check 与 accept_check |',
  '| 10 | ⚠️ 静态成立 | 依据：单元测试通过 |',
].join('\n');

async function main(): Promise<void> {
  // ═══ A｜D1 归档即停（道德经·知止）═══════════════════════════════════════════════════════════
  console.log('\n【A】D1 归档即停 —— 「知止不殆」');
  {
    const db = mkdb();
    addTask(db, 'a-run', 'executing', { ctx: { keep_me: 'sibling' } });
    const ctrl = new AbortController();
    let statusAtAbort = '';
    let abortMsg = '';
    ctrl.signal.addEventListener('abort', () => {
      statusAtAbort = statusOf(db, 'a-run');
      const r = (ctrl.signal as unknown as { reason?: unknown }).reason;
      abortMsg = r instanceof Error ? r.message : String(r ?? '');
    });
    registerTaskRun('a-run', ctrl);
    const res = archiveTask(db, { taskId: 'a-run', reason: '用户归档' });
    ok(res.changed, 'A-1a ★归档确实落库（changed=true）');
    eq(statusOf(db, 'a-run'), 'archived', 'A-1b 状态为 archived');
    ok(ctrl.signal.aborted, 'A-1c ★★在途 run 被中止（signal.aborted）——归档不再只改库');
    eq(statusAtAbort, 'archived', 'A-1d ★abort 发生在**落库之后**（监听器回查库读到 archived，不是旧态）');
    ok(abortMsg.includes('status_terminal:archived'), 'A-1e abort 因由带 status_terminal:archived（执行体 catch 按它分派）');
    eq(ctxObj(db, 'a-run').keep_me, 'sibling', 'A-1f 归档落因不抹兄弟键（context_json 合并写）');
    eq(ctxObj(db, 'a-run').archive_reason, '用户归档', 'A-1g archive_reason 落库');
    unregisterTaskRun('a-run', ctrl);
    ok(!hasTaskRun('a-run'), 'A-1h 收尾注销后注册表清空');

    // ── A-2 反证：无在途 run ⇒ 归档不抛、照常 changed（abort 是副作用，不是前置）──
    const db2 = mkdb();
    addTask(db2, 'a-idle', 'executing');
    let threw = '';
    let res2: { changed: boolean } | null = null;
    try { res2 = archiveTask(db2, { taskId: 'a-idle' }); } catch (e) { threw = String(e); }
    ok(!threw && !!res2?.changed, 'A-2 ★反证：无在途 run 时归档不抛、照常 changed');
    eq(statusOf(db2, 'a-idle'), 'archived', 'A-2b 且状态仍落 archived');

    // ── A-3 反证：CAS 未命中 ⇒ 不 abort（只有真翻转才惊动执行体）──
    const db3 = mkdb();
    addTask(db3, 'a-cas', 'executing');
    archiveTask(db3, { taskId: 'a-cas' });
    const c3 = new AbortController();
    registerTaskRun('a-cas', c3);
    const res3 = archiveTask(db3, { taskId: 'a-cas', expectStatus: 'executing' });
    ok(!res3.changed, 'A-3a CAS 未命中（已是 archived）⇒ changed=false');
    ok(!c3.signal.aborted, 'A-3b ★abort 只在**真发生状态翻转**时发出（没翻转就不惊动执行体）');
    unregisterTaskRun('a-cas', c3);

    // ── A-4 注册表按 controller 比对：旧 run 的 finally 不误删新 run ──
    const c1 = new AbortController();
    const c2 = new AbortController();
    registerTaskRun('a-swap', c1);
    registerTaskRun('a-swap', c2);
    unregisterTaskRun('a-swap', c1);
    ok(hasTaskRun('a-swap'), 'A-4a ★旧 run 的注销不误删新 run（按 controller 比对）');
    eq(abortTaskRun('a-swap', 'x'), true, 'A-4b abortTaskRun 命中在途 run 返回 true');
    ok(c2.signal.aborted && !c1.signal.aborted, 'A-4c 中止的是**当前** run（旧 controller 不受影响）');
    unregisterTaskRun('a-swap', c2);
    eq(abortTaskRun('a-swap', 'x'), false, 'A-4d 无在途 run 时返回 false（正常态，不是错误）');

    // ── A-5 终态判定的唯一真源（`isTerminalStatus`）──
    eq(['completed', 'failed', 'archived', 'paused', 'executing', 'pending', ''].map((s) => isTerminalStatus(s)),
      [true, true, true, false, false, false, false],
      'A-5 ★终态三元组判定唯一真源：completed/failed/archived 为真，其余（含空串）为假');
    eq(isTerminalStatus(undefined), false, 'A-5b 查不到行（undefined）不冒认终态');
  }

  // ═══ B｜D2 置暂停不得覆写终态（维特根斯坦·意义即用法）════════════════════════════════════════
  console.log('\n【B】D2 置暂停不得覆写终态');
  {
    const db = mkdb();
    const terminals = ['completed', 'failed', 'archived'];
    for (const st of terminals) addTask(db, `b-${st}`, st, { ctx: { keep_me: st } });

    let pauseEvents = 0;
    const h = () => { pauseEvents++; };
    eventBus.on('task.status_changed', h);

    const results = terminals.map((st) => pauseTask(db, { taskId: `b-${st}`, reason: PAUSE_REASON_QUALITY_BELOW_BAR }));
    eq(results.map((r) => [r.changed, r.skipped]), terminals.map(() => [false, 'terminal']),
      'B-1 ★三只终态标本一律 {changed:false, skipped:terminal}');
    eq(terminals.map((st) => statusOf(db, `b-${st}`)), terminals,
      'B-1b 三只标本的库内状态**逐字未动**（archived 仍是 archived）');
    eq(terminals.map((st) => Number(typeof ctxObj(db, `b-${st}`).pause_reason === 'string')), [0, 0, 0],
      'B-1c 且未落 pause_reason（0 行——"未写"这件事有正面证据）');
    eq(terminals.map((st) => ctxObj(db, `b-${st}`).keep_me), terminals,
      'B-1d 兄弟键原样（拒绝覆写不等于清账）');
    eq(pauseEvents, 0, 'B-1e ★终态拒绝时**不发** status_changed（事件面与写面同止）');

    addTask(db, 'b-live', 'executing', { ctx: { keep_me: 'x' } });
    const rl = pauseTask(db, { taskId: 'b-live', reason: PAUSE_REASON_QUALITY_BELOW_BAR });
    eq([rl.changed, rl.skipped ?? null], [true, null], 'B-2 执行中的任务照常可暂停（{changed:true}）');
    eq(statusOf(db, 'b-live'), 'paused', 'B-2b 状态落 paused');
    eq(ctxObj(db, 'b-live').pause_reason, PAUSE_REASON_QUALITY_BELOW_BAR,
      'B-2c ★pause_reason **0→1**（既有"停必录因"不变量未受本轮影响）');
    eq(ctxObj(db, 'b-live').keep_me, 'x', 'B-2d 兄弟键保留');
    eq(pauseEvents, 1, 'B-2e ★事件 **0→1**（真暂停仍发一次）');
    eventBus.off('task.status_changed', h);
  }

  // ═══ C｜D3 编排工具不得改写终态（真工具 · 真 execute）══════════════════════════════════════════
  console.log('\n【C】D3 编排工具不得改写终态');
  {
    const db = mkdb();
    const tools = buildTools({ db } as never, 'caller-task', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
    const call = async (target: string, status: string): Promise<string> =>
      tools.update_task_status!.execute({ targetTaskId: target, status });

    addTask(db, 'c-arch', 'archived');
    const r1 = await call('c-arch', 'paused');
    ok(JSON.parse(r1).error && JSON.parse(r1).error.includes('终态'),
      'C-1 ★对 archived 目标请求 paused ⇒ 返回 error 且点名"终态"');
    eq(statusOf(db, 'c-arch'), 'archived', 'C-1b 状态仍是 archived（事故里被覆写的那一笔，现被挡住）');

    const r2 = await call('c-arch', 'completed');
    ok(JSON.parse(r2).error && JSON.parse(r2).error.includes('终态'),
      'C-2 ★对 archived 目标请求 completed ⇒ 同样被拒（事故方向：archived 被收尾段改成 completed）');
    eq(statusOf(db, 'c-arch'), 'archived', 'C-2b 状态仍是 archived');

    addTask(db, 'c-done', 'completed');
    const r3 = await call('c-done', 'completed');
    ok(!JSON.parse(r3).error, 'C-3 ★同值幂等仍放行（completed→completed 不返回 error）——既有"不硬拦"裁定未推翻');
    eq(statusOf(db, 'c-done'), 'completed', 'C-3b 状态保持 completed');

    addTask(db, 'c-pend', 'pending');
    const r4 = await call('c-pend', 'completed');
    ok(!JSON.parse(r4).error, 'C-4 pending→completed 照常成功（既有完成路无回归）');
    eq(statusOf(db, 'c-pend'), 'completed', 'C-4b 状态落 completed');

    addTask(db, 'c-live', 'executing');
    const r5 = await call('c-live', 'paused');
    ok(!JSON.parse(r5).error, 'C-5 executing→paused 照常成功');
    eq(statusOf(db, 'c-live'), 'paused', 'C-5b 状态落 paused');
    eq(ctxObj(db, 'c-live').pause_reason, 'agent_paused', 'C-5c 且经唯一写入口落因（agent_paused）');
  }

  // ═══ D｜D4 派生任务须成话、且不得与父并发（毛选·实事求是）════════════════════════════════════
  console.log('\n【D】D4 核实报告 → 修复任务：取主语、不取判定列');
  {
    // ── D-1 真实报告片段：抽出来的是"要修什么"，不是判定词 ──
    const { issues, overflow } = extractVerificationIssues([REPORT_TEXT]);
    ok(issues.length > 0, 'D-1a 真实报告片段能抽出问题（正面证据：非空）', `${issues.length} 条`);
    ok(issues.some((s) => s.includes('上线阻断')),
      'D-1b ★「生产就绪」一行取到**细节**「3 项上线阻断…」——不再取判定列「不通过」');
    ok(issues.some((s) => s.includes('不同源')),
      'D-1c ★判定格只有「部分通过」时，细节回退到右侧说明格（不同源那一句）');
    ok(issues.some((s) => s.includes('实调未完成')),
      'D-1d ★「端到端业务链」的「实调未完成」作为细节被保住（判定词表只禁"单独成题"，不禁它出现在句子里）');
    ok(issues.some((s) => s.includes('键名不一致')),
      'D-1e 编号行（| 4 | 需修正 | 键名不一致…）⇒ 取细节一句（编号不是主语）');
    eq(overflow, 0, 'D-1f 未超上限（overflow=0）');

    // ── D-2 判定词碎片一条也不得单独成题 ──
    ok(!issues.some((s) => s.trim() === '不通过' || /^[\d\s.、]*不通过$/.test(s.trim())),
      'D-2a ★`不通过` 不再单独成一条（真库派生任务的第一行正是它）');
    ok(!issues.some((s) => s.includes('静态成立')), 'D-2b ★`静态成立` 一条不立项');
    ok(!issues.some((s) => s.includes('演示级')), 'D-2c ★`演示级` 一条不立项');
    ok(!issues.some((s) => s.includes('展示域')), 'D-2d ★`展示域` 一条不立项');
    ok(!issues.some((s) => /^(依据|证据|说明|结果|判定)/.test(s)), 'D-2e ★证据列不得被当成问题主语');

    // ── D-3 反证：只有判定碎片 + 依据的文档 ⇒ 0 条（不是"总能凑出点什么"）──
    const junkOnly = [
      '| 编号 | 判定 | 依据 |',
      '| --- | --- | --- |',
      '| 1 | ⚠️ 不通过 | 依据：状态机的 3 个分支未接入 |',
      '| 10 | ⚠️ 静态成立 | 依据：单元测试通过 |',
      '### 8. ⚠️ 演示级',
      '### 9. ❌ 展示域',
    ].join('\n');
    const junk = extractVerificationIssues([junkOnly]);
    eq([junk.issues.length, junk.overflow], [0, 0],
      'D-3 ★整篇只有判定碎片与依据 ⇒ 0 条立项（反证：抽取器不会把判定词洗成问题）');

    // ── D-4 去重归一：同一行出现两次只立一条 ──
    const dupRow = '| 生产就绪 | ❌ **不通过** | 3 项上线阻断：后端 /upload 缺失 |';
    eq(extractVerificationIssues([dupRow, dupRow]).issues.length, 1, 'D-4 同一行重复出现 ⇒ 去重后 1 条');

    // ── D-5 上限 20 + 如实报溢出 ──
    eq(MAX_VERIFICATION_ISSUES, 20, 'D-5a 单批上限为 20（一处常量）');
    const many = Array.from({ length: 25 }, (_, i) => `| 检查项${i + 1} | ❌ 未落地 | 细节${i + 1} |`).join('\n');
    const capped = extractVerificationIssues([many]);
    eq([capped.issues.length, capped.overflow], [20, 5], 'D-5b ★25 条 ⇒ 20 条立项 + overflow=5（溢出如实回传，不静默吞）');

    // ── D-6 createVerificationFixTask 的形状（直接调用）──
    {
      const db = mkdb();
      const fix = createVerificationFixTask({ db, taskId: 'report-x', projectId: 'p', issues: ['甲：未接入', '乙：不同源'] });
      const row = db.prepare('SELECT parent_task_id, depends_on, status, description, acceptance_criteria, context_json FROM wa_tasks WHERE id = ?').get(fix.id) as Record<string, unknown>;
      eq(row.parent_task_id, null, 'D-6a ★parent_task_id 为 NULL（不是子任务 ⇒ 不顶住父的 children_incomplete 闸）');
      eq(row.depends_on, 'report-x', 'D-6b ★depends_on = 核实报告任务（先收口、后修）');
      eq(row.status, 'pending', 'D-6c 状态 pending（由调度器接续，不立即入队）');
      const ctx = JSON.parse(String(row.context_json)) as Record<string, unknown>;
      eq([ctx.verification_fix, ctx.verification_fix_of], [true, 'report-x'], 'D-6d context 带 verification_fix / verification_fix_of');
      const criteria = String(row.acceptance_criteria).split('\n');
      eq(criteria.length, 2, 'D-6e 验收标准逐条一题（2 条问题 ⇒ 2 行）');
      ok(criteria.every((c) => c.includes('可复核证据')),
        'D-6f ★每条验收标准都点名"可复核证据"（旧模板「已落地且可核验」对"未落地"是空话）');
      eq(jobCount(db), 0, 'D-6g ★wa_jobs 零新增行（不再 enqueueJob）');
    }

    // ── D-7 端到端：真 `finalize_task` 里检查 7 那一跳（真文件 · 真读盘）──
    {
      const db = mkdb();
      const reportPath = path.join(tmpdir, 'verify-report.md');
      fs.writeFileSync(reportPath, REPORT_TEXT, 'utf-8');
      addTask(db, 'v-report', 'executing', {
        title: '20260924 实施结果核验',
        description: '核验上一轮实施结果是否符合要求，并汇总未落地事项',
      });
      addDoc(db, 'd-report', 'v-report', reportPath);
      addConv(db, 'v-report', 'assistant', '核验完成，详见报告');

      const tools = buildTools({ db } as never, 'v-report', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      const raw = await tools.finalize_task!.execute({ summary: '核验完成', quality: 'good' });
      const out = JSON.parse(raw) as { status?: string; error?: string; checks?: string[] };
      eq(out.status, 'finalized',
        'D-7a ★父任务照常 finalized（新修复任务不是子任务 ⇒ 不被 children_incomplete 扣住）', String(raw).slice(0, 160));
      const checks = (out.checks ?? []).join('\n');
      ok(checks.includes('已建立修复任务') && checks.includes('前置=本任务'),
        'D-7b ★checks 如实说"前置=本任务、收口后接续"（不再说"已自动创建"并立即开跑）');

      const fixes = db.prepare("SELECT id, description, acceptance_criteria, parent_task_id, depends_on, status, context_json FROM wa_tasks WHERE depends_on = 'v-report'").all() as Array<Record<string, unknown>>;
      eq(fixes.length, 1, 'D-7c ★恰好立了 1 个修复任务（已按 depends_on 可查）');
      const fix = fixes[0]!;
      eq([fix.parent_task_id, fix.status], [null, 'pending'], 'D-7d 根任务 · pending');
      eq(JSON.parse(String(fix.context_json)).verification_fix_of, 'v-report', 'D-7e 账上点名来源报告任务');
      const desc = String(fix.description);
      ok(desc.includes('上线阻断'), 'D-7f ★派生任务描述含真问题「上线阻断」');
      ok(!desc.includes('不通过') && !desc.includes('静态成立') && !desc.includes('演示级'),
        'D-7g ★★描述里不再出现判定词碎片（旧实现十条里没有一条说得清要修什么）');
      eq(desc.split('\n').length, 5, 'D-7h 问题条数 = 抽取结果的 5 条（逐条编号）');
      ok(String(fix.acceptance_criteria).includes('可复核证据'), 'D-7i 验收标准保留"可复核证据"要求');
      eq(jobCount(db), 0, 'D-7j ★wa_jobs 零新增行（与父任务不并发改文件）');
      eq(ctxObj(db, 'v-report').verification_fix_created, fix.id, 'D-7k 父任务账上留痕（幂等键=新任务 id）');

      // 反证：同一父任务再收口 ⇒ 幂等键挡住，不再重复立项
      const raw2 = await tools.finalize_task!.execute({ summary: '再收口一次', quality: 'good' });
      ok(!String(raw2).includes('已建立修复任务'), 'D-7l 重复收口不再立项（verification_fix_created 幂等键）');
      eq((db.prepare("SELECT COUNT(*) c FROM wa_tasks WHERE depends_on = 'v-report'").get() as { c: number }).c, 1,
        'D-7m 修复任务行数仍为 1');
    }

    // ── D-8 递归闸：修复任务自身收口时不再派生"修复修复任务"（真库 e1033ab6 的形态）──
    {
      const db = mkdb();
      const fixDoc = path.join(tmpdir, 'fix-report.md');
      fs.writeFileSync(fixDoc, '| 检查项 | ❌ 未落地 | 后端 /upload 仍缺失 |', 'utf-8');
      addTask(db, 'v-fixself', 'executing', {
        title: '修复核实发现的未落地问题（1 个）',
        description: '修复核实报告点名的问题',
        ctx: { depth: 1, verification_fix: true, verification_fix_of: 'r-root' },
      });
      addDoc(db, 'd-fixself', 'v-fixself', fixDoc);
      addConv(db, 'v-fixself', 'assistant', '已修复并给出证据');

      const tools = buildTools({ db } as never, 'v-fixself', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      const raw = await tools.finalize_task!.execute({ summary: '修复完成', quality: 'good' });
      ok(!String(raw).includes('已建立修复任务'),
        'D-8a ★修复任务收口不再派生修复任务（verification_fix 递归闸）', String(raw).slice(0, 160));
      eq((db.prepare('SELECT COUNT(*) c FROM wa_tasks').get() as { c: number }).c, 1,
        'D-8b ★任务表仍只有本任务一行（零新增；反证：判别依据是真任务行，不是返回文案）');
    }

    // ── D-9 只读报告类文档：配置注释里的 ⚠/❌ 不是核实结论（真库 openapi.yaml:308 标本）──
    {
      eq([isReportDocPath('a/b/report.md'), isReportDocPath('x.MARKDOWN'), isReportDocPath('n.txt'), isReportDocPath('n2.TXT')],
        [true, true, true, true], 'D-9a 报告类扩展名（md/markdown/txt，大小写不敏感）入扫描面');
      eq([isReportDocPath('openapi.yaml'), isReportDocPath('client.js'), isReportDocPath('Service.java'), isReportDocPath(null), isReportDocPath('')],
        [false, false, false, false, false], 'D-9b 源码/配置/空路径一律出局');

      const db = mkdb();
      const yamlPath = path.join(tmpdir, 'openapi.yaml');
      fs.writeFileSync(yamlPath, '#           ⚠ ②③ 属破坏性变更，三端 mock/前端需跟改——见 G5-挂账清单 §D6；\n', 'utf-8');
      addTask(db, 'v-yaml', 'executing', {
        title: '20260924 实施结果核验',
        description: '核验上一轮实施结果是否符合要求，并汇总未落地事项',
      });
      addDoc(db, 'd-yaml', 'v-yaml', yamlPath);
      addConv(db, 'v-yaml', 'assistant', '核验完成');

      const tools = buildTools({ db } as never, 'v-yaml', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      const raw = await tools.finalize_task!.execute({ summary: '核验完成', quality: 'good' });
      ok(!String(raw).includes('已建立修复任务'),
        'D-9c ★配置注释不再被当成核实问题立项（openapi.yaml 真标本）', String(raw).slice(0, 160));
      eq((db.prepare('SELECT COUNT(*) c FROM wa_tasks').get() as { c: number }).c, 1, 'D-9d 任务表零新增行');
    }
  }

  // ═══ E｜静态接线（按符号切片，不按行号）═════════════════════════════════════════════════════
  console.log('\n【E】静态接线');
  {
    // zx_20261023_3 批一就地改钉（按新载体，更强）：每步判据从 exec-step 内联搬到 `stop-signals.ts`
    //   的 `stepStopVerdict`（起跑判据 `runStartRefusal` 同源一处）；exec-step 只消费判据并真 abort。
    //   原断言钉的是"内联 isTerminalStatus + 模板串 abort"，新断言钉三层：判据在册 / 真被调用 / 真 abort，
    //   并反证 exec-step 不再自抄终态三元组。
    const stepSrc = CODE(`${A}/src/main/core/exec-step.ts`);
    const stopSrc = CODE(`${A}/src/main/core/stop-signals.ts`);
    ok(stopSrc.includes("import { isTerminalStatus } from './task-jobs.js'")
      && /isTerminalStatus\(status\)[\s\S]{0,120}?status_terminal:\$\{status\}/.test(stopSrc),
      'E-1 ★每步状态检查认**全部终态**（唯一真源 task-jobs），并给出 status_terminal:<s> 因由');
    ok(stepSrc.includes("import { stepStopVerdict } from './stop-signals.js'")
      && stepSrc.includes('const stop = stepStopVerdict(')
      && stepSrc.includes('d.controller.abort(new Error(stop.abortReason))'),
      'E-1a ★exec-step 走同一 AbortController 链路（归档/暂停那一拍才真传得到执行体）');
    ok(!stepSrc.includes('isTerminalStatus(') && !stepSrc.includes("status_terminal:"),
      'E-1b 反证：终态判断与因由串不再在 exec-step 另抄一份');

    const exeSrc = CODE(`${A}/src/main/core/agent-executor.ts`);
    const iPaused = exeSrc.indexOf("if (curStatus === 'paused') {");
    const iTerm = exeSrc.indexOf('if (isTerminalStatus(curStatus)) {');
    ok(iPaused > 0 && iTerm > iPaused, 'E-2 ★catch 里终态分支排在 paused 判据**之后**（顺序断言：暂停语义优先）', `${iPaused} < ${iTerm}`);
    ok(exeSrc.includes('registerTaskRun(taskId, controller)') && exeSrc.includes('unregisterTaskRun(taskId, controller)'),
      'E-3 在途 run 登记/注销走注册表');
    ok(!/new Map<string, AbortController>\(\)/.test(exeSrc), 'E-3b 执行体内不再自持 abort 表（唯一真源在 task-run-registry）');
    ok(exeSrc.includes('abortTaskRun(taskId, \'被 interrupt 中断\')'), 'E-3c interrupt 也经注册表（不另搞一份）');
    ok(exeSrc.includes('if (isTerminalStatus(stAtFinalize))') && exeSrc.includes('finalize 收口不改写状态'),
      'E-4 ★finalize_completed 支先查库内终态（事故 58c60680 被改成 completed 的那一行）');

    const archSrc = CODE(`${A}/src/main/core/task-archive.ts`);
    const iUpd = archSrc.indexOf("SET status = 'archived'");
    const iAbort = archSrc.indexOf("abortTaskRun(taskId, 'status_terminal:archived')");
    ok(iUpd > 0 && iAbort > iUpd, 'E-5 ★task-archive **先落库、后 abort**（abort 是副作用，库是事实）', `${iUpd} < ${iAbort}`);

    const ptSrc = CODE(`${A}/src/main/core/pause-task.ts`);
    const iGuard = ptSrc.indexOf('isTerminalStatus(row?.status)');
    const iPauseUpd = ptSrc.indexOf("UPDATE wa_tasks SET status = 'paused'");
    ok(iGuard > 0 && iGuard < iPauseUpd, 'E-6 ★pauseTask 的终态守卫在写库**之前**', `${iGuard} < ${iPauseUpd}`);

    const ctrlSrc = CODE(`${A}/src/main/core/tools/control.ts`);
    ok(ctrlSrc.includes('isTerminalStatus(trow.status) && trow.status !== args.status'),
      'E-7 ★update_task_status 只挡"改值"，同值幂等仍放行（既有裁定不推翻）');

    const efSrc = CODE(`${A}/src/main/core/exec-finalize.ts`);
    ok(efSrc.includes('const statusAtClose =') && efSrc.includes('if (isTerminalStatus(statusAtClose))'),
      'E-8 ★run_close 收尾段先查库内终态（第二道网：abort 没赶上也不覆写）');

    const cfSrc = CODE(`${A}/src/main/core/tools/control-finalize.ts`);
    ok(cfSrc.includes('extractVerificationIssues(contents)'), 'E-9 ★检查 7 的抽取走 `verification-issues.ts` 一处真源');
    ok(cfSrc.includes('createVerificationFixTask({ db, taskId, projectId, issues })'), 'E-9b ★立项走同一模块的唯一入口');
    ok(!cfSrc.includes('enqueueJob'), 'E-9c ★检查 7 不再 enqueueJob（不立即开跑 ⇒ 不与父并发）');

    const viSrc = CODE(`${A}/src/main/core/verification-issues.ts`);
    const viImports = [...viSrc.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    eq(viImports, ['node:crypto'], 'E-10 ★抽取/立项模块零运行期依赖（仅 node:crypto ⇒ rr 可直接喂真报告片段）');

    // 检查 7 整段按符号切片（从幂等键读取到方案里程碑读取之间）
    const i7 = cfSrc.indexOf('const fixCtx = JSON.parse(');
    const i7End = cfSrc.indexOf('const bctx = JSON.parse(');
    const check7 = i7 >= 0 && i7End > i7 ? cfSrc.slice(i7, i7End) : '';
    ok(/if \(!fixCtx\.verification_fix_created && !fixCtx\.verification_fix\)/.test(check7),
      'E-11 ★检查 7 的幂等键与递归闸在**同一条件**里（修复任务不再下钻）');
    ok(check7.includes('isReportDocPath(d.file_path)'),
      'E-12 ★检查 7 只读报告类文档（源码/配置注释不得当成核实结论）');

    // 完成提示须说人话：主进程转发补任务名，渲染层先取任务名、缺名才退回 id
    const idxSrc = CODE(`${A}/src/main/index.ts`);
    const iFwd = idxSrc.indexOf('const forwardToRenderer');
    const iFwdEnd = iFwd >= 0 ? idxSrc.indexOf('eventBus.on(', iFwd) : -1;
    const fwdBody = iFwd >= 0 && iFwdEnd > iFwd ? idxSrc.slice(iFwd, iFwdEnd) : '';
    ok(fwdBody.includes('taskTitleOf(') && fwdBody.includes('taskTitle'),
      'E-13 ★任务事件转发补 taskTitle（完成提示此前只能显示 id 前 8 位）');
    const actSrc = CODE(`${A}/renderer/src/lib/activity.tsx`);
    const iTitle = actSrc.indexOf('function titleOf');
    const iTitleEnd = iTitle >= 0 ? actSrc.indexOf('export function ActivityProvider', iTitle) : -1;
    const titleBody = iTitle >= 0 && iTitleEnd > iTitle ? actSrc.slice(iTitle, iTitleEnd) : '';
    ok(titleBody.includes('raw.taskTitle') && titleBody.indexOf('raw.taskTitle') < titleBody.indexOf('slice(0, 8)'),
      'E-13b ★titleOf 先取任务名、缺名才退回 id 前 8 位（顺序断言）');
  }

  // ═══ S｜自指 + build 钉（G-6 派生核对）═══════════════════════════════════════════════════════
  console.log('\n【S】自指 + build 钉（派生核对）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S-1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S-3 本套件在册（脚本名由载体派生）');

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行通过假象。
(async () => {
  try {
    await main();
    console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261021_2: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e: unknown) {
    console.error('\n💥 rr_zx_20261021_2 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
    fail++;
    console.log(`\n❌ rr_zx_20261021_2: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  }
})();
