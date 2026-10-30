/**
 * zx_20261027_1 受控复跑 —— 「备」：一码一义、一路一账、一读到底。
 *
 * 由来（2026-10-26 对怡寿里「20261022 规划方案实施」/「SQL 优化」两条任务及其自动子任务的实机复盘）：
 *   1. 方案里的 `M2.5` 在系统里被读成 `M2`——同一个号，两种意思；
 *   2. 走 `run_close` 收口的任务**从不落地里程碑**——同一个"完成"，两条路两笔账；
 *   3. 子任务被判失败后，父任务**没有任何工具可处置**（终态守卫拒绝一切改写），只能等人工；
 *   4. `read_file` 截断读取**不留痕**，核验类任务"只读了前 50k 字"也能收口而无从得知；
 *   5. 工作记忆沉淀进长期记忆时**一律记作 direct（亲历）**，推断与实证同权；
 *   6. 项目详情页把 21 块方案看板平铺，空转板与真推进板混排。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：A/B/C/D/E 全走真实现（`milestoneRefsIn`/`finalizeRunClose`/`buildTools` 的
 *       真 `execute`/`readonlyTools`/`MemoryManager`），不另写影子判据。
 *   G-2 **两侧标本**：每条"该命中"都配反证（M2.5 vs M2 / 带因 vs 无因 / 直接子 vs 兄弟孙 /
 *       截断 vs 未截断 / 已读 vs 未读）。计数器类断言给 **0→1** 的正面证据。
 *   G-6 **无轮次字面量**：轮次标识由 `path.basename(__filename)` 派生（S 组自检）。
 *   ⚠ 静态判据**按符号切片**（不按行号）；判"接线那一跳"读**去注释后**的代码。
 *   ⚠ 本文件的断言文案里**不写**失败字形（`pnpm rr:all` 汇总器按日志里的失败字形计数）。
 *   ⚠ 夹具 DDL 逐列照抄 `database.ts`（不做"比生产宽松"的简化）；记忆夹具先 `new MemoryManager`
 *     （建 FTS 触发器）再插数据行——顺序颠倒会让同步触发器吞掉首次 UPDATE。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：读真源**静态导入**（被删/改名即编译期失败）。
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { readonlyTools } from '../apps/worker-ant-desktop/src/main/core/tools/readonly.js';
import { finalizeRunClose } from '../apps/worker-ant-desktop/src/main/core/exec-finalize.js';
import {
  milestoneRefsIn, milestoneTitledRefsIn, milestoneFromTitle, milestoneTokenRegex,
  revertMilestoneDoneForTask,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
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
CREATE TABLE wa_memories (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT ''
);
`;
type AnyDb = import('better-sqlite3').Database;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx27-1-'));
const workC = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx27-1-c-'));
const workD = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx27-1-d-'));
const workE = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx27-1-e-'));

type ToolBag = Record<string, { execute: (a: unknown) => Promise<string> }>;

const statusOf = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const ctxObj = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const addTask = (db: AnyDb, id: string, status: string, o: { parent?: string | null; ctx?: Record<string, unknown>; title?: string; description?: string; dependsOn?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, status, depends_on, source, context_json)
              VALUES (?, 'p', ?, ?, ?, ?, ?, 'test', ?)`)
    .run(id, o.parent ?? '', o.title ?? id, o.description ?? '', status, o.dependsOn ?? '', JSON.stringify(o.ctx ?? {}));
};
const addConv = (db: AnyDb, taskId: string, role: string, content: string): void => {
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 0)")
    .run(taskId, role, content);
};
const addBoard = (db: AnyDb, planId: string, ms: string, status = 'pending', impl: string | null = null): void => {
  db.prepare("INSERT INTO wa_plan_milestones (id, project_id, plan_task_id, milestone, status, implemented_by_task_id) VALUES (?, 'p', ?, ?, ?, ?)")
    .run(`${planId}:${ms}`, planId, ms, status, impl);
};
const boardOf = (db: AnyDb, planId: string, ms: string): [string, string | null] => {
  const r = db.prepare('SELECT status, implemented_by_task_id AS impl FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?')
    .get(planId, ms) as { status: string; impl: string | null };
  return [r.status, r.impl];
};
const systemLines = (db: AnyDb, taskId: string): string =>
  (db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system'").all(taskId) as Array<{ content: string }>)
    .map((r) => r.content).join('\n');
const listenMilestones = (): { events: Array<Record<string, unknown>>; off: () => void } => {
  const events: Array<Record<string, unknown>> = [];
  // eventBus 投递的是 AppEvent 外壳 `{type,timestamp,data}`；直接 emit 回调投的是载荷本身。
  const h = (e: unknown): void => {
    const rec = e as Record<string, unknown>;
    events.push((rec?.data as Record<string, unknown>) ?? rec);
  };
  eventBus.on('project.milestone_changed', h);
  return { events, off: () => eventBus.off('project.milestone_changed', h) };
};

async function main(): Promise<void> {
  // ═══ A｜M1 里程碑号一处真源（维特根斯坦·意义即用法）═══════════════════════════════════════
  console.log('\n【A】M1 里程碑号一处真源 —— 「M2.5 与 M2 是两种玩法」');
  {
    eq([...milestoneRefsIn('M2 与 M2.5 同板')].sort(), ['M2', 'M2.5'],
      'A-1 ★同一句里的 M2 与 M2.5 是两个号（小数不再退化成整数）');
    eq([...milestoneRefsIn('M12')], ['M12'], 'A-1b ★M12 完整匹配，不被截成 M1');
    eq([...milestoneRefsIn('XM2.5Y')], [], 'A-1c 反证：词内嵌的 M2.5 不算里程碑号');
    eq([...milestoneRefsIn('M1', '2 号')].sort(), ['M1'],
      'A-1d ★逐段取值：相邻段尾与段首不拼出假号 M12');
    eq(milestoneFromTitle('M2.5 建表'), 'M2.5', 'A-2a ★标题前缀取到小数里程碑');
    eq(milestoneFromTitle('M2. 设计'), 'M2', 'A-2b 前缀后的孤点不算小数段（M2. 仍是 M2）');
    eq(milestoneFromTitle('M12'), 'M12', 'A-2c M12 不被截成 M1');
    eq([...milestoneTitledRefsIn('| M2.5 建表 | done |\n### M3 接口')],
      [['M2.5', '建表'], ['M3', '接口']],
      'A-3 ★板行与标题行都取到真名（小数号不再是匿名号）');

    const r1 = milestoneTokenRegex(); const r2 = milestoneTokenRegex();
    ok(r1 !== r2, 'A-3a ★每次调用新建正则实例');
    r1.exec('M1 M2');
    ok(r1.lastIndex === 2 && r2.lastIndex === 0,
      'A-3b ★两个实例的 lastIndex 互不串味（共享 g 正则即状态串味）', `${r1.lastIndex} / ${r2.lastIndex}`);

    // ── A-4 撤回：只退"该任务落地的 done"，别家的不动；幂等 ──
    const db = mkdb();
    addBoard(db, 'p-A', 'M2', 'done', 't-x');
    addBoard(db, 'p-A', 'M3', 'done', 't-y');
    addBoard(db, 'p-A', 'M4', 'pending', null);
    const m = listenMilestones();
    const reverted = revertMilestoneDoneForTask(db as never, 't-x', (e) => m.events.push(e as unknown as Record<string, unknown>));
    m.off();
    eq(reverted, ['M2'], 'A-4a ★只退回该任务名下的 done 里程碑');
    eq(boardOf(db, 'p-A', 'M2'), ['pending', null], 'A-4b M2 退回 pending 并清实施者');
    eq(boardOf(db, 'p-A', 'M3'), ['done', 't-y'], 'A-4c ★反证：别人的里程碑逐字未动');
    eq(boardOf(db, 'p-A', 'M4'), ['pending', null], 'A-4d 本就 pending 的行不受影响');
    eq(m.events.map((e) => [e.milestone, e.status]), [['M2', 'pending']],
      'A-4e ★撤回发一次 pending 事件（0→1）');
    eq(revertMilestoneDoneForTask(db as never, 't-x'), [], 'A-4f 再调用无行可退（幂等）');
  }

  // ═══ B｜M2 run_close 与 finalize 同一笔账（毛选·抓而不紧等于不抓）══════════════════════════
  console.log('\n【B】M2 run_close 收口也落地里程碑');
  {
    const db = mkdb();
    addTask(db, 'p-plan', 'executing');
    addTask(db, 't-b1', 'executing', { parent: 'p-plan', title: 'M2.5 建表' });
    addBoard(db, 'p-plan', 'M2');
    addBoard(db, 'p-plan', 'M2.5');
    addConv(db, 't-b1', 'tool', `[write_file] {"ok":true,"path":"${path.join(tmpdir, 'b1.txt')}"}`);
    const m = listenMilestones();
    const res = finalizeRunClose({
      db, ctx: { dataDir: tmpdir } as never, taskId: 't-b1', projectId: 'p',
      archetype: 'research', adaptiveStrategy: { modelStrategy: 'x', temperature: 0 },
      fileMutationCount: 1, finalContent: '', stepCount: 1,
      qualityScore: { score: 80, feedback: '' }, closeVerdict: 'not_checked',
      closeTotal: 0, closeFailedN: 0, closeAcceptance: undefined,
      title: 'M2.5 建表', modelName: 'm', maxSteps: 10,
      totalTokensUsed: 0, toolCallCount: 1, rawCost: 0,
    } as never);
    m.off();
    eq(statusOf(db, 't-b1'), 'completed', 'B-1a 达标收口标 completed');
    eq(res.steps, 1, 'B-1b 返回形状与搬迁前一致（steps 原样）');
    eq(boardOf(db, 'p-plan', 'M2.5'), ['done', 't-b1'],
      'B-1c ★run_close 真把 M2.5 落成 done 并记实施者（此前这一路零写入）');
    eq(boardOf(db, 'p-plan', 'M2'), ['pending', null],
      'B-1d ★反证：同板 M2 不被误写（号不混用）');
    eq(m.events.map((e) => [e.milestone, e.status]), [['M2.5', 'done']],
      'B-1e ★里程碑事件 0→1，且只发真正改行的那一条');

    // ── B-2 反证：被失败子任务拦下（置 paused）的任务不落里程碑 ──
    const db2 = mkdb();
    addTask(db2, 't-b2', 'executing', { title: 'M7 建表' });
    addTask(db2, 'c-b2', 'failed', { parent: 't-b2' });
    addBoard(db2, 't-b2', 'M7');
    addConv(db2, 't-b2', 'tool', `[write_file] {"ok":true,"path":"${path.join(tmpdir, 'b2.txt')}"}`);
    const m2 = listenMilestones();
    const res2 = finalizeRunClose({
      db: db2, ctx: { dataDir: tmpdir } as never, taskId: 't-b2', projectId: 'p',
      archetype: 'research', adaptiveStrategy: { modelStrategy: 'x', temperature: 0 },
      fileMutationCount: 1, finalContent: '', stepCount: 1,
      qualityScore: { score: 80, feedback: '' }, closeVerdict: 'not_checked',
      closeTotal: 0, closeFailedN: 0, closeAcceptance: undefined,
      title: 'M7 建表', modelName: 'm', maxSteps: 10,
      totalTokensUsed: 0, toolCallCount: 1, rawCost: 0,
    } as never);
    m2.off();
    eq(res2.content, '任务暂停：有失败子任务未处置', 'B-2a 失败子任务仍拦住父收口（既有闸未松动）');
    eq(statusOf(db2, 't-b2'), 'paused', 'B-2b 父任务置 paused');
    eq(boardOf(db2, 't-b2', 'M7'), ['pending', null], 'B-2c ★未标完成的任务不落里程碑');
    eq(m2.events.length, 0, 'B-2d 且零里程碑事件（写面与事件面同止）');

    // ── B-3 静态：位置与三出口同一份实现 ──
    const efSrc = CODE(`${A}/src/main/core/exec-finalize.ts`);
    const iDone = efSrc.indexOf("SET status = 'completed'");
    const iMs = efSrc.indexOf('writeMilestoneDone(db, taskId, msCtx');
    ok(iDone > 0 && iMs > iDone,
      'B-3a ★run_close 先标完成、后落里程碑（只有真 completed 才写 done）', `${iDone} < ${iMs}`);
    ok(efSrc.includes('backfillBoardRemainderToSelf(db, taskId, msCtx, emitMs);'),
      'B-3b 补归口与另两出口同一调用形状');
    const exits: Array<[string, string]> = [
      ['finalize_task', `${A}/src/main/core/tools/control-finalize.ts`],
      ['update_task_status', `${A}/src/main/core/tools/control.ts`],
      ['run_close', `${A}/src/main/core/exec-finalize.ts`],
    ];
    for (const [name, rel] of exits) {
      eq(CODE(rel).split('writeMilestoneDone(db,').length - 1, 1,
        `B-3c ${name} 恰有一处里程碑写入（不另写第二份判据）`);
    }
  }

  // ═══ C｜M3 终态守卫的两个窄口（道德经·可纠正的止）══════════════════════════════════════════
  console.log('\n【C】M3 父任务可处置直接子任务（终态守卫留两个窄口）');
  {
    // ── C-1 failed→archived（带 reason）⇒ 允许；父随后可收口 ──
    const db = mkdb();
    addTask(db, 'p-parent', 'executing');
    addTask(db, 'c-failed', 'failed', { parent: 'p-parent' });
    const tools = buildTools({ db } as never, 'p-parent', 'p', workC) as unknown as ToolBag;
    const r1 = JSON.parse(await tools.update_task_status!.execute({
      targetTaskId: 'c-failed', status: 'archived', reason: '确认该子任务已失败，放弃',
    })) as { error?: string };
    ok(!r1.error, 'C-1a ★父把失败子任务置 archived（带 reason）被允许', String(r1.error || ''));
    eq(statusOf(db, 'c-failed'), 'archived', 'C-1b 状态落 archived');
    ok(String(ctxObj(db, 'c-failed').archive_reason || '').includes('放弃'),
      'C-1c 归档因由落库（archive_reason）');
    ok(systemLines(db, 'c-failed').includes('[放弃失败子任务]'),
      'C-1d ★留下处置会话行（父的裁决有据可查）');
    addConv(db, 'p-parent', 'tool', `[write_file] {"ok":true,"path":"${path.join(workC, 'parent.txt')}"}`);
    const fr = JSON.parse(await tools.finalize_task!.execute({ summary: '子任务已处置', quality: 'good' })) as { status?: string; error?: string };
    eq(fr.status, 'finalized', 'C-1e ★父任务随后可收口（失败闸已解除，不必再等人工）');

    // ── C-2 反证：无因 / 兄弟 / 孙 / 只开两个窄口 ──
    const db2 = mkdb();
    addTask(db2, 'p2', 'executing');
    addTask(db2, 'c2-failed', 'failed', { parent: 'p2' });
    addTask(db2, 'p-other', 'executing');
    addTask(db2, 'c2-sib', 'failed', { parent: 'p-other' });
    addTask(db2, 'c2-mid', 'completed', { parent: 'p2' });
    addTask(db2, 'c2-gc', 'failed', { parent: 'c2-mid' });
    const tools2 = buildTools({ db: db2 } as never, 'p2', 'p', workC) as unknown as ToolBag;

    const n1 = JSON.parse(await tools2.update_task_status!.execute({ targetTaskId: 'c2-failed', status: 'archived' })) as { error?: string };
    ok(!!n1.error && n1.error.includes('终态'), 'C-2a ★无 reason ⇒ 退回原守卫（拒绝）', String(n1.error || ''));
    eq(statusOf(db2, 'c2-failed'), 'failed', 'C-2b 状态仍是 failed');

    const n2 = JSON.parse(await tools2.update_task_status!.execute({ targetTaskId: 'c2-failed', status: 'completed', reason: '翻案' })) as { error?: string };
    ok(!!n2.error && n2.error.includes('终态'), 'C-2c ★failed→completed 不开（只开两个窄口）');
    eq(statusOf(db2, 'c2-failed'), 'failed', 'C-2d 状态仍是 failed');

    const n3 = JSON.parse(await tools2.update_task_status!.execute({ targetTaskId: 'c2-sib', status: 'archived', reason: '越权' })) as { error?: string };
    ok(!!n3.error && n3.error.includes('终态'), 'C-2e ★兄弟任务（非直接子）仍被拒');
    eq(statusOf(db2, 'c2-sib'), 'failed', 'C-2f 兄弟状态未动');

    const n4 = JSON.parse(await tools2.update_task_status!.execute({ targetTaskId: 'c2-gc', status: 'archived', reason: '越层' })) as { error?: string };
    ok(!!n4.error && n4.error.includes('终态'), 'C-2g ★孙任务（跨层）仍被拒——这是刻意收窄');
    eq(statusOf(db2, 'c2-gc'), 'failed', 'C-2h 孙任务状态未动');

    // ── C-3 completed（质量 45）→failed（带 reason）⇒ 允许，且里程碑退回 ──
    const db3 = mkdb();
    addTask(db3, 'p3', 'executing');
    addTask(db3, 'c3-low', 'completed', { parent: 'p3' });
    db3.prepare('UPDATE wa_tasks SET quality_score = 45 WHERE id = ?').run('c3-low');
    addBoard(db3, 'p3', 'M3', 'done', 'c3-low');
    const m3 = listenMilestones();
    const tools3 = buildTools({ db: db3 } as never, 'p3', 'p', workC) as unknown as ToolBag;
    const r3 = JSON.parse(await tools3.update_task_status!.execute({
      targetTaskId: 'c3-low', status: 'failed', reason: '复核发现产出为空',
    })) as { error?: string };
    m3.off();
    ok(!r3.error, 'C-3a ★低分完成被父复核推翻（带 reason）被允许', String(r3.error || ''));
    eq(statusOf(db3, 'c3-low'), 'failed', 'C-3b 状态落 failed');
    eq(boardOf(db3, 'p3', 'M3'), ['pending', null],
      'C-3c ★其名下的里程碑退回 pending 并清实施者（完成不再冒充）');
    eq(m3.events.map((e) => [e.milestone, e.status]), [['M3', 'pending']],
      'C-3d ★撤回事件 0→1');
    const lines3 = systemLines(db3, 'c3-low');
    ok(lines3.includes('[复核推翻]') && lines3.includes('45'),
      'C-3e ★留下复核推翻会话行且写明分数');
    ok(lines3.includes('成果物不自动撤回'), 'C-3f 如实交代边界（已提升成果物不自动撤回）');

    // ── C-4 反证：高分完成（90）不得被任意翻案 ──
    const db4 = mkdb();
    addTask(db4, 'p4', 'executing');
    addTask(db4, 'c4-high', 'completed', { parent: 'p4' });
    db4.prepare('UPDATE wa_tasks SET quality_score = 90 WHERE id = ?').run('c4-high');
    const tools4 = buildTools({ db: db4 } as never, 'p4', 'p', workC) as unknown as ToolBag;
    const r4 = JSON.parse(await tools4.update_task_status!.execute({
      targetTaskId: 'c4-high', status: 'failed', reason: '翻案',
    })) as { error?: string };
    ok(!!r4.error && r4.error.includes('终态'), 'C-4a ★质量分 90 的完成被拒（复核推翻只针对明显不合格）');
    eq(statusOf(db4, 'c4-high'), 'completed', 'C-4b 状态仍是 completed');

    // ── C-5 静态：窄口与处置动作都在册 ──
    const ctrl = CODE(`${A}/src/main/core/tools/control.ts`);
    ok(ctrl.includes('const closureOfFailedChild =') && ctrl.includes('const reopenLowQualityChild ='),
      'C-5a ★两个窄口各是一个具名条件（不是散落在守卫里的魔法值）');
    ok(ctrl.includes('!closureOfFailedChild && !reopenLowQualityChild'),
      'C-5b ★原守卫表达式保留，只在尾部放行两个窄口');
    const iFail = ctrl.indexOf('markTaskFailed(db, args.targetTaskId');
    const iRev = ctrl.indexOf('revertMilestoneDoneForTask(db, args.targetTaskId');
    ok(iFail > 0 && iRev > iFail,
      'C-5c ★先翻失败、后退里程碑（顺序是判据的一部分）', `${iFail} < ${iRev}`);
    ok(ctrl.includes('[放弃失败子任务]') && ctrl.includes('[复核推翻]'),
      'C-5d 两条处置都有会话留痕');
  }

  // ═══ D｜M4 截断读取留痕（道德经·知不知，上）═════════════════════════════════════════════════
  console.log('\n【D】M4 截断读取留痕 —— 「没读到」不等于「不存在」');
  {
    const large = path.join(workD, 'large.log');
    const small = path.join(workD, 'small.log');
    const lineOf = (i: number): string => `${String(i).padStart(4, '0')} ${'a'.repeat(54)}`;
    fs.writeFileSync(large, `${Array.from({ length: 1000 }, (_, i) => lineOf(i)).join('\n')}\n`, 'utf-8');
    fs.writeFileSync(small, '一行\n二行\n', 'utf-8');

    const db = mkdb();
    const readFiles = new Set<string>();
    const truncatedReads = new Set<string>();
    const tools = readonlyTools({
      ctx: {}, db, taskId: 't-read', projectId: 'p', workingDir: workD, readFiles, truncatedReads,
    } as never) as unknown as ToolBag;

    const first = await tools.read_file!.execute({ filePath: large });
    const resolved = path.resolve(large);
    ok(readFiles.has(resolved), 'D-1a 读成功即入已经读册');
    ok(truncatedReads.has(resolved), 'D-1b ★超大文件首读入截断册（此前这一事实被丢弃）');
    const offM = /续读：offset=(\d+)/.exec(first);
    ok(!!offM, 'D-1c 回话给出续读 offset');
    const next = Number(offM?.[1] ?? -1);
    ok(next > 0, 'D-1d 续读 offset 为正数');
    const second = await tools.read_file!.execute({ filePath: large, offset: next });
    ok(!truncatedReads.has(resolved), 'D-1e ★读到末尾即出截断册（不永久污名）');
    ok(!/续读：offset=/.test(second), 'D-1f 读到末尾不再给续读提示');
    await tools.read_file!.execute({ filePath: small });
    ok(!truncatedReads.has(path.resolve(small)), 'D-2 ★反证：未截断的读取不入截断册');

    // ── D-3 端到端：真 buildTools 的 read_file + finalize_task，账落库 ──
    const finalizeWith = async (taskId: string, title: string): Promise<{ out: { status?: string; checks?: string[] } }> => {
      addTask(db, taskId, 'executing', { title });
      addConv(db, taskId, 'tool', `[write_file] {"ok":true,"path":"${large}"}`);
      const t = buildTools({ db, dataDir: workD } as never, taskId, 'p', workD) as unknown as ToolBag;
      await t.read_file!.execute({ filePath: large });
      const raw = await t.finalize_task!.execute({ summary: '收口', quality: 'good' });
      return { out: JSON.parse(raw) as { status?: string; checks?: string[] } };
    };

    const ver = await finalizeWith('t-ver', '核验日志内容');
    eq(ver.out.status, 'finalized', 'D-3a 核验类任务照常收口（只报不拦）');
    const verWarn = (ver.out.checks ?? []).find((c) => c.startsWith('[WARN] 本次有 1 个文件只读取了部分内容'));
    ok(!!verWarn && verWarn.includes('本任务为核验类——据此判定'),
      'D-3b ★核验类收口账含截断告警与"核验类"尾注', String(verWarn || ''));
    const verPersist = ((ctxObj(db, 't-ver').finalize_checks as string[] | undefined) ?? []).join('\n');
    ok(verPersist.includes('[WARN] 本次有 1 个文件只读取了部分内容') && verPersist.includes('本任务为核验类'),
      'D-3c ★告警已随 finalize_checks 落库（不只是返回值）');

    const plain = await finalizeWith('t-plain', '整理日志内容');
    eq(plain.out.status, 'finalized', 'D-4a 非核验类任务照常收口');
    const plainWarn = (plain.out.checks ?? []).find((c) => c.startsWith('[WARN] 本次有 1 个文件只读取了部分内容'));
    ok(!!plainWarn && plainWarn.includes('若要据此下结论，请补读'),
      'D-4b ★非核验类同样如实报告，尾注不同（两句话，不是"只对核验类说"）', String(plainWarn || ''));
    const plainPersist = ((ctxObj(db, 't-plain').finalize_checks as string[] | undefined) ?? []).join('\n');
    ok(plainPersist.includes('若要据此下结论，请补读'), 'D-4c 非核验类的告警同样落库');

    // ── D-5 静态：入册/出册与注入一处不落 ──
    const ro = CODE(`${A}/src/main/core/tools/readonly.ts`);
    ok(ro.includes('if (page.truncated) deps.truncatedReads?.add(resolvedFp);')
      && ro.includes('else deps.truncatedReads?.delete(resolvedFp);'),
      'D-5a ★read_file 按 paginate 的 truncated 真入册/出册（不再丢弃）');
    const ae = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(ae.includes('const truncatedReads = new Set<string>();') && ae.includes('readFiles, truncatedReads,'),
      'D-5b ★buildTools 每任务新建一份并注入 deps');
    const cf = CODE(`${A}/src/main/core/tools/control-finalize.ts`);
    ok(cf.includes('const truncated = [...(truncatedReads ?? [])];')
      && cf.includes('本任务为核验类——据此判定')
      && cf.includes('若要据此下结论，请补读'),
      'D-5c ★finalize 读同一份截断册，两种尾注各在册');
  }

  // ═══ E｜M5 工作记忆带出处（维特根斯坦·不要想，要看）════════════════════════════════════════
  console.log('\n【E】M5 工作记忆沉淀带出处（已核验 / 推断）');
  {
    fs.writeFileSync(path.join(workE, 'note.txt'), 'UTC 时间基准\n', 'utf-8');
    const db = mkdb();
    addTask(db, 't-mem', 'executing', { title: '记忆出处标本' });
    // ⚠ 先 new MemoryManager（建 FTS 触发器）再插数据行——顺序颠倒会让同步触发器吞掉首次 UPDATE。
    const mm = new MemoryManager(db as never, null as never);
    const tools = buildTools({ db, memory: mm, dataDir: workE } as never, 't-mem', 'p', workE) as unknown as ToolBag;
    await tools.read_file!.execute({ filePath: 'note.txt' });

    // ⚠ 笔记常量不要叫 A/B/C——会遮蔽顶层的仓库相对路径常量 A（E-7 静态判据会拿笔记正文当路径）。
    const NOTE_VERIFIED = '日志时区为 UTC，解析须按 UTC 处理';
    const NOTE_DEPLOY = '部署前须先跑受控回归再提交';
    const NOTE_UNREAD = '未读文件里的结论不可信';
    const ra = JSON.parse(await tools.note_working_context!.execute({ content: NOTE_VERIFIED, source_file: 'note.txt' })) as Record<string, unknown>;
    eq([ra.status, ra.verified, ra.evidence], ['noted', true, 'verified'],
      'E-1 ★已读文件 ⇒ verified=true / evidence=verified');
    const rc = JSON.parse(await tools.note_working_context!.execute({ content: NOTE_UNREAD, source_file: 'unread.txt' })) as Record<string, unknown>;
    eq([rc.verified, rc.evidence], [false, 'inferred'],
      'E-2 ★未读文件 ⇒ verified=false（不冒认已核验）');
    ok(String(rc.note || '').includes('不在本任务已读清单内'), 'E-2b 并如实提示原因');
    const rb = JSON.parse(await tools.note_working_context!.execute({ content: NOTE_DEPLOY })) as Record<string, unknown>;
    eq(rb.evidence, 'inferred', 'E-2c 无出处的笔记记作推断');
    // 复述不带 source_file 时响应体不含 verified 字段（如实：本次没给出处），但 evidence 由已存项派生，
    // 仍须是 verified——「只升不降」看的是库里那条，不是本次入参的形状。
    const ra2 = JSON.parse(await tools.note_working_context!.execute({ content: NOTE_VERIFIED })) as Record<string, unknown>;
    eq(ra2.evidence, 'verified', 'E-3 ★复述不带出处时不把已核验降级（evidence 仍 verified）');
    const item = mm.getWorkingMemory('t-mem').find((w) => w.content === NOTE_VERIFIED);
    ok(!!item && item.verified === true && !!item.file_path,
      'E-3b 工作记忆项保留 verified/file_path');

    await tools.note_working_context!.execute({ content: '短' });
    const promoted = mm.promoteWorkingMemory('t-mem', 'p', true);
    eq(promoted, 3, 'E-4 三条有效笔记沉淀（过短的一条跳过）');
    type MemRow = { content: string; context_json: string };
    const rows = db.prepare('SELECT content, context_json FROM wa_memories ORDER BY content').all() as MemRow[];
    eq(rows.length, 3, 'E-4b 长期记忆恰三行（复述不重复沉淀）');
    const parsed = rows.map((r) => ({ content: r.content, ctx: JSON.parse(r.context_json || '{}') as Record<string, any> }));
    eq(parsed.filter((r) => r.ctx.experience === 'direct').length, 1,
      'E-5a ★direct 恰一条（已核验那条）');
    eq(parsed.filter((r) => r.ctx.experience === 'inferred').length, 2,
      'E-5b ★inferred 两条（不再一律 direct）');
    ok(parsed.some((r) => r.content.includes('[已核验]') && r.ctx.evidence?.verified === true),
      'E-5c ★已核验记忆正文带标记且 evidence.verified=true');
    eq(parsed.filter((r) => r.content.includes('[推断]')).length, 2,
      'E-5d ★推断记忆正文同样如实标注');

    const promoted2 = mm.promoteWorkingMemory('t-mem', 'p', true);
    eq(promoted2, 3, 'E-6 重跑仍处理三条');
    const rows2 = db.prepare('SELECT content, context_json FROM wa_memories ORDER BY content').all() as MemRow[];
    eq(rows2.length, 3, 'E-6b ★同源覆盖不增行');
    ok(rows2.some((r) => r.content.includes('[更新]')), 'E-6c 同源覆盖留下 [更新] 痕');
    eq(rows2.filter((r) => (JSON.parse(r.context_json || '{}') as Record<string, unknown>).experience === 'direct').length, 1,
      'E-6d ★重放后 direct 仍是一条（只升不降）');

    // ── E-7 静态：出处由引擎核验，不接受自我声明 ──
    const mem = CODE(`${A}/src/main/core/tools/memory.ts`);
    ok(mem.includes('readFiles?.has(absFile)') && mem.includes('source_file'),
      'E-7a ★note_working_context 的出处查本任务已读册');
    const mmSrc = CODE(`${A}/src/main/core/memory-manager.ts`);
    ok(mmSrc.includes('if (evidence?.verified) hit.verified = true;'),
      'E-7b ★复述只升不降');
    ok(mmSrc.includes('const verified = item.verified === true;')
      && mmSrc.includes("const grade = verified ? '[已核验]' : '[推断]';"),
      'E-7c ★沉淀时按出处取标记');
    ok(mmSrc.includes("experience: verified ? 'direct' : 'inferred',"),
      'E-7d ★experience 不再固定 direct');
  }

  // ═══ F｜M6 空转方案看板折叠（纯展示层）══════════════════════════════════════════════════════
  console.log('\n【F】M6 空转方案看板折叠');
  {
    const rp = RD(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
    ok(rp.includes('const [showIdleBoards, setShowIdleBoards] = useState(false);'),
      'F-1 折叠开关默认收起');
    ok(rp.includes('const boardProgress =') && rp.includes('p.done || 0') && rp.includes('p.doing || 0'),
      'F-2 ★进度判据是 done+doing（一处定义）');
    ok(rp.includes('const activeBoards = planMilestones.filter') && rp.includes('const idleBoards = planMilestones.filter'),
      'F-3 按进度拆两组');
    ok(rp.includes('const shownBoards = showIdleBoards ? [...activeBoards, ...idleBoards] : activeBoards;'),
      'F-4 ★默认只展示有推进的板');
    ok(rp.includes('{shownBoards.map('), 'F-5 渲染走 shownBoards');
    ok(rp.includes('另有 ${idleBoards.length} 块方案看板尚无任何里程碑推进'),
      'F-6 ★空转计数如实上屏');
    ok(rp.includes('收起空转看板') && rp.includes('空转看板：板上没有任何里程碑处于进行中或已落地'),
      'F-7 展开态与悬停说明在册');
  }

  // ═══ G｜M7 构建钉（P1–P6）═══════════════════════════════════════════════════════════════════
  console.log('\n【G】M7 构建钉（P1–P6）');
  {
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }

  // ═══ S｜自指 + 静态接线（G-6 派生核对）═══════════════════════════════════════════════════════
  console.log('\n【S】自指 + 静态接线');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S-1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S-3 本套件在册（脚本名由载体派生）');

    // M1：五处旧写法已收口到一处真源（去注释后只剩真源本身那一行）
    const ta = CODE(`${A}/src/main/core/task-accounting.ts`);
    const cf1 = CODE(`${A}/src/main/core/tools/control-finalize.ts`);
    const ad = CODE(`${A}/src/main/ipc/admin.ipc.ts`);
    const legacy = 'M\\d+';
    eq([ta.split(legacy).length - 1, cf1.split(legacy).length - 1, ad.split(legacy).length - 1], [1, 0, 0],
      'S-4 ★里程碑号词形只剩 task-accounting 一处真源（其余调用点零旧写法）');
    ok(ta.includes('MILESTONE_NUM_SOURCE = String.raw`M\\d+(?:\\.\\d+)?`'),
      'S-4b ★真源支持可选小数段');
    ok(cf1.includes('const re = milestoneTokenRegex();') && ad.includes('const re = milestoneTokenRegex();'),
      'S-4c ★两个历史回填入口改用工厂（不共享 lastIndex）');
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行通过假象。
(async () => {
  try {
    await main();
    console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261027_1: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e: unknown) {
    console.error('\n💥 rr_zx_20261027_1 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
    fail++;
    console.log(`\n❌ rr_zx_20261027_1: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  }
})();
