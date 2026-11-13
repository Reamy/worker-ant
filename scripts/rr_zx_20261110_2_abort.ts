/**
 * zx_20261110_2 B4 复跑 —— 「恒」：**置暂停 ≠ 真断**。
 *
 * 病根（事故 339ef167）：超时回收只写 `status='paused'`，不动执行体。执行体的暂停判据要到**下一步**
 * 才看状态词——若它正卡在一次永不返回的调用里，那一步永不到来：库里"已暂停"、进程里照跑。
 * 同一个词（停）两个用法：库里停了，事上没停。
 *
 * 判据：
 *   A-1 有在途句柄 ⇒ **真断**（signal 被 abort）且 paused，会话行如实写"已找到句柄并中止本轮"，
 *       并发 `run.abort_sent`（`source='self_heal'`）；
 *   A-2 无在途句柄 ⇒ 不谎报（不发 `run.abort_sent`），会话行如实写"未找到在途执行句柄"（两只标本）；
 *   A-3 `supersedeExecutionJobs` 作废作业**不等于**中止执行体：作业行收尾了，在途 run 仍在 ——
 *       这正是它现在必须出声的那句实话（静态钉住出声处，行为钉住"事实"）；
 *   A-4 `interruptTask` 的 `aborted` 真值一路透传到 `task:updateStatus('paused')` 回执（不再被丢弃）。
 *
 * 纪律：真源直 import（`reclaimStaleExecutingTask` / `supersedeExecutionJobs` / `interruptTask` 本尊），
 *       不在此复刻 SQL；判据文案不含失败字形；无"只本轮为真"的字面量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines, buildNotOlderThan } from './lib/rr-pins.js';
import { reclaimStaleExecutingTask, type StaleExecTask } from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
import { supersedeExecutionJobs, hasPendingExecutionJob } from '../apps/worker-ant-desktop/src/main/core/task-jobs.js';
import { interruptTask } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { registerTaskRun, unregisterTaskRun, hasTaskRun } from '../apps/worker-ant-desktop/src/main/core/task-run-registry.js';
import { PAUSE_REASON_EXEC_TIMEOUT } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

type AnyDb = import('better-sqlite3').Database;

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const SELF_ROUND = /^(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''))?.[1] ?? '';
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT DEFAULT '',
  aggregate_id TEXT DEFAULT '', payload TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
`;

function mkdb(): AnyDb {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '项目')").run();
  return db as unknown as AnyDb;
}
function addTask(db: AnyDb, id: string, status: string): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'p1', `任务 ${id}`, status, JSON.stringify({ task_goal: '把事做完' }));
}
const staleRow = (id: string): StaleExecTask => ({ id, title: `任务 ${id}`, project_id: 'p1', status: 'executing', updated_at: '2026-11-10 05:00:00' });
const statusOf = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const ctxOf = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const convOf = (db: AnyDb, id: string): string[] =>
  (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid ASC').all(id) as Array<{ content: string }>).map((r) => r.content);

/** 取一个具名函数的函数体（按符号定位 + 配对花括号；不按行号）。 */
function fnBody(src: string, symbol: string): string {
  const at = src.indexOf(symbol);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return '';
}

async function main(): Promise<void> {
  // ═══ K｜构建钉 ═══════════════════════════════════════════════════════════
  console.log('\n【K】构建钉');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  {
    const src = fs.readFileSync(path.join(root, `${A}/src/main/core/agent-executor.ts`), 'utf-8');
    const tag = /build:\s*'(zx_[0-9_]+)'/.exec(stripKeepingLines(src).join('\n'))?.[1] ?? '';
    ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), 'K-7 当前 build 快照不早于本脚本轮次（方向性比较）', `${tag} vs ${SELF_ROUND}`);
  }

  // ═══ A-1｜有句柄 ⇒ 真断 ═════════════════════════════════════════════════
  console.log('\n【A-1】超时回收：有在途句柄 ⇒ 真的断（不只是把状态词改成 paused）');
  {
    const db = mkdb();
    addTask(db, 't-1', 'executing');
    const ctrl = new AbortController();
    registerTaskRun('t-1', ctrl);
    const sent: Array<Record<string, unknown>> = [];
    const h = (e: { data?: Record<string, unknown> }) => { if (e.data?.taskId === 't-1' && e.data?.source === 'self_heal') sent.push(e.data); };
    eventBus.on('run.abort_sent', h as never);

    eq(statusOf(db, 't-1'), 'executing', 'A-1a 前置：回收前状态仍是 executing');
    ok(!ctrl.signal.aborted, 'A-1b 前置：句柄尚未被中止（0 态）');
    const done = reclaimStaleExecutingTask(db, staleRow('t-1'));
    await Promise.resolve(); await Promise.resolve();
    eventBus.off('run.abort_sent', h as never);

    ok(done, 'A-1c 回收成立');
    eq(statusOf(db, 't-1'), 'paused', 'A-1d 状态落 paused');
    eq(ctxOf(db, 't-1').pause_reason, PAUSE_REASON_EXEC_TIMEOUT, 'A-1e 因由落 `exec_timeout`（不是无因暂停）');
    ok(ctrl.signal.aborted, 'A-1f ★ 在途句柄**真的被中止**（signal.aborted 从 false 变 true：只写库的那种实现过不了这一条）');
    eq((ctrl.signal as unknown as { reason?: Error }).reason?.message?.split(':')[0], 'self_heal_stale_exec',
      'A-1g abort 因由是机器可辨的 `self_heal_stale_exec`（执行体据此归到暂停族，不记成失败）');
    const lines = convOf(db, 't-1');
    eq(lines.length, 1, 'A-1h 恰一条系统会话行（不刷屏）');
    ok(lines[0]!.includes('已找到在途执行句柄') && lines[0]!.includes('中止本轮'),
      'A-1i ★ 会话行如实写"已找到句柄并中止本轮"', lines[0]!.slice(0, 40) + '…');
    unregisterTaskRun('t-1', ctrl);
  }

  // ═══ A-2｜无句柄 ⇒ 不谎报 ═══════════════════════════════════════════════
  console.log('\n【A-2】超时回收：无在途句柄 ⇒ 如实说"没找到"，不谎报"已中止"');
  {
    const db = mkdb();
    addTask(db, 't-2', 'preparing');
    ok(!hasTaskRun('t-2'), 'A-2a 前置：无在途 run');
    const sent: Array<Record<string, unknown>> = [];
    const h = (e: { data?: Record<string, unknown> }) => { if (e.data?.taskId === 't-2') sent.push(e.data); };
    eventBus.on('run.abort_sent', h as never);
    const done = reclaimStaleExecutingTask(db, { ...staleRow('t-2'), status: 'preparing' });
    // emit 是异步派发：让一轮宏任务跑完再收账（否则"没收到"可能只是还没到）
    await new Promise((r) => setTimeout(r, 30));
    eventBus.off('run.abort_sent', h as never);

    ok(done, 'A-2b 回收成立（没有句柄也要落暂停——事要停）');
    eq(statusOf(db, 't-2'), 'paused', 'A-2c 状态落 paused');
    eq(sent.length, 0, 'A-2d ★ 不谎报：**没有**发 `run.abort_sent`（发了与停了是两笔账，本轮红线）');
    const lines = convOf(db, 't-2');
    ok(lines[0]!.includes('未找到在途执行句柄'), 'A-2e ★ 会话行如实写"未找到在途执行句柄"', lines[0]!.slice(0, 40) + '…');
    ok(!lines[0]!.includes('已找到'), 'A-2f 反证：同一句里不出现"已找到"（两只标本的差就在这一处）');
  }

  // ═══ A-1k｜有句柄时事件真的发出（宏任务后收账） ═══════════════════════════
  console.log('\n【A-1k】有句柄 ⇒ `run.abort_sent`（source=self_heal）真的到账');
  {
    const db = mkdb();
    addTask(db, 't-3', 'executing');
    registerTaskRun('t-3', new AbortController());
    const sent: Array<Record<string, unknown>> = [];
    const h = (e: { data?: Record<string, unknown> }) => { if (e.data?.taskId === 't-3') sent.push(e.data); };
    eventBus.on('run.abort_sent', h as never);
    reclaimStaleExecutingTask(db, staleRow('t-3'));
    await new Promise((r) => setTimeout(r, 30));
    eventBus.off('run.abort_sent', h as never);
    eq(sent.length, 1, 'A-1k1 ★ 事件恰一次（0→1 的正面断言）');
    eq(sent[0]?.source, 'self_heal', 'A-1k2 `source=self_heal`（与看门狗的 `watchdog` 分得开）');
    eq(sent[0]?.reason, 'self_heal_stale_exec', 'A-1k3 因由与 abort 报文同源');
    unregisterTaskRun('t-3');
  }

  // ═══ A-3｜作废作业 ≠ 中止执行体 ═════════════════════════════════════════
  console.log('\n【A-3】`supersedeExecutionJobs`：作业行收尾了，在途 run 仍在 —— 必须出声');
  {
    const db = mkdb();
    addTask(db, 't-4', 'paused');
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('j1', 'resume-ai-task', ?, 'pending')")
      .run(JSON.stringify({ taskId: 't-4' }));
    eq(hasPendingExecutionJob(db as never, 't-4'), true, 'A-3a 前置：确有一条在途执行作业');
    const ctrl = new AbortController();
    registerTaskRun('t-4', ctrl);

    supersedeExecutionJobs(db as never, 't-4', 'superseded_by_resume');
    eq(hasPendingExecutionJob(db as never, 't-4'), false, 'A-3b 作业行如实收尾（作废生效）');
    eq((db.prepare("SELECT status FROM wa_jobs WHERE id = 'j1'").get() as { status: string }).status, 'done', 'A-3c 作业行置 done');
    eq((db.prepare("SELECT error FROM wa_jobs WHERE id = 'j1'").get() as { error: string }).error, 'superseded_by_resume', 'A-3d 收尾带因由');
    eq(hasTaskRun('t-4'), true, 'A-3e ★ 执行体**没被碰**（作废的是作业行，不是人）');
    ok(!ctrl.signal.aborted, 'A-3f ★ 反证：没有顺手 abort（各路口各有处置，此函数不越权）');

    // 反证（另一只标本）：没有在途 run 时，同一判据不该出声
    addTask(db, 't-5', 'paused');
    eq(hasTaskRun('t-5'), false, 'A-3g 另一只标本：无在途 run');
    supersedeExecutionJobs(db as never, 't-5', 'superseded_by_resume');
    eq(hasTaskRun('t-5'), false, 'A-3h 判据是 `hasTaskRun`（不是"作废了就叫一声"）');

    const body = fnBody(CODE(`${A}/src/main/core/task-jobs.ts`), 'export function supersedeExecutionJobs');
    ok(/hasTaskRun\(taskId\)/.test(body), 'A-3i 出声条件取自 `task-run-registry`（真有在途 run 的唯一凭据）');
    ok(body.includes('job_superseded_but_run_live'), 'A-3j 出声文案在册（运维可 grep 到这句）');
    ok(/logger\.warn\(/.test(body), 'A-3k 用 warn 级（不是 debug：这条要能在默认级别看见）');
    unregisterTaskRun('t-4', ctrl);
  }

  // ═══ A-4｜`aborted` 真值透传 ════════════════════════════════════════════
  console.log('\n【A-4】`interruptTask` 的 `aborted` 一路透传到 GUI 回执（不再被丢弃）');
  {
    const db = mkdb();
    addTask(db, 't-6', 'executing');
    const noHandle = interruptTask(db as never, 't-6');
    eq(noHandle.aborted, false, 'A-4a 无句柄 ⇒ `aborted=false` 如实回（此前调用方一律以为断了）');
    ok(typeof noHandle.note === 'string' && String(noHandle.note).length > 0, 'A-4b 附带一句"没断"的说明');
    eq(statusOf(db, 't-6'), 'paused', 'A-4c 库仍置 paused（停这件事照做）');

    addTask(db, 't-7', 'executing');
    const ctrl = new AbortController();
    registerTaskRun('t-7', ctrl);
    const withHandle = interruptTask(db as never, 't-7');
    eq(withHandle.aborted, true, 'A-4d 有句柄 ⇒ `aborted=true`');
    ok(ctrl.signal.aborted, 'A-4e 句柄真被中止');
    unregisterTaskRun('t-7', ctrl);

    addTask(db, 't-8', 'paused');
    eq(interruptTask(db as never, 't-8').status, 'not_running', 'A-4f 本就不在跑 ⇒ 如实 `not_running`（不冒充中断）');

    const ipc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/pauseAborted = typeof ir\.aborted === 'boolean' \? ir\.aborted : null/.test(ipc),
      'A-4g `task:updateStatus("paused")` 接住 `interruptTask` 的返回值（此前直接丢弃）');
    ok(/aborted: pauseAborted/.test(ipc), 'A-4h 回执带 `aborted`（渲染层据此说人话）');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
