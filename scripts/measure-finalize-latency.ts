/**
 * zx_20261110_2 B5 量测 —— 「损」：**收口之后的那几笔账，别再压住收口本身**。
 *
 * 计时口径（如实）：
 *   ① **收口关键路径增量** = 「发 `task.completed` 事件」→「后置作业入队返回」的耗时——这是收口这一轮**多付**的钱，
 *      目标 ≤1s（实测应为毫秒级：只有一次 `wa_jobs` INSERT + 内存入队）；
 *   ② **端到端时延** = 「`task.completed` 事件」→「最后一条后置账办完」。后置作业由 `processPending` **每秒一跳**
 *      驱动，故端到端受这一跳约束（结构性下界，不是运气）——本脚本同时打印数值与门限，判据取"一个心跳 + 余量"。
 *
 * 断言（都是可证伪的）：
 *   M-1 收口事件先于后置账（两条时间戳的先后 + 事件持久化回调里记下的 `occurred_at`）；
 *   M-2 收口关键路径只多了一次入队（≤1s）；
 *   M-3 端到端 ≤ 一个心跳 + 余量；
 *   M-4 同一 run 重放同一后置作业 ⇒ **不再办第二遍**（计数不涨）；
 *   M-5 续跑后再次收口（新 run）⇒ 该办，且办的就是新 run（"续跑各通知一次"这件事没被后置化弄丢）；
 *   M-6 作业行真的被消费成 `done`（不是只有内存里跑过）。
 *
 * 用真 `TaskScheduler` + 真 `postlude.ts` + 真 `eventBus`（内存库）：判据在作用域内，不用假时钟凑时延。
 */
import { DatabaseSync } from 'node:sqlite';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import {
  POSTLUDE_JOB_TYPE, markCompletedRun, postludeDue, markPostludeDone,
} from '../apps/worker-ant-desktop/src/main/core/postlude.js';

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
CREATE TABLE wa_event_log (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT DEFAULT '',
  aggregate_id TEXT DEFAULT '', payload TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
`;

/** 收口关键路径增量门限（与方案同值）：只多一次入队。 */
const CRITICAL_PATH_BUDGET_MS = 1_000;
/** 端到端门限：`processPending` 每秒一跳 + 余量（结构性下界，不是"看看能不能撞上"）。 */
const HOP_BUDGET_MS = 2_500;

async function main(): Promise<void> {
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '项目')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t1', 'p1', '任务', 'completed', '{}')").run();

  // 事件持久化回调（真实 `emit` 路径）：记下 `occurred_at` 作为"收口事件已落账"的物证。
  const persisted: Array<{ event_type: string; occurred_at: string }> = [];
  eventBus.setEventStore({
    append: (e: { event_type: string; occurred_at: string }) => { persisted.push(e); return { event_id: 'rr-event' }; },
  } as never);

  const order: string[] = [];
  const stamp: Record<string, number> = {};
  eventBus.on('task.completed', () => { order.push('event'); stamp.eventAt = Date.now(); });

  const sched = new TaskScheduler(db);
  let accountingCount = 0;
  let handledRun = '';
  // 处理器 = 生产那一段的**判据本尊**（`postludeDue` / `markPostludeDone`），只是把"四笔账"换成一个计数。
  sched.register(POSTLUDE_JOB_TYPE, async (payload) => {
    const taskId = String(payload.taskId ?? '');
    const row = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined;
    if (row?.status !== 'completed') return;
    const due = postludeDue(db as never, taskId);
    if (!due) return;
    accountingCount++;
    handledRun = due.runKey;
    stamp.doneAt = Date.now();
    order.push('postlude');
    markPostludeDone(db as never, taskId, due.runKey);
  });

  sched.start();
  try {
    // ── 收口这一刻：先发事件（真相已成），再记 run 身份，再发后置作业 ──
    await eventBus.emit('task.completed', { taskId: 't1', projectId: 'p1' });
    markCompletedRun(db as never, 't1', 'run-A');
    const tEnq0 = Date.now();
    const jobId = await sched.enqueue(POSTLUDE_JOB_TYPE, {
      taskId: 't1', projectId: 'p1', finalContent: '本轮正文', source: 'run_completed',
    });
    stamp.enqueuedAt = Date.now();
    const criticalPathMs = stamp.enqueuedAt - (stamp.eventAt ?? tEnq0);

    ok(criticalPathMs <= CRITICAL_PATH_BUDGET_MS,
      'M-2 收口关键路径只多了一次入队', `${criticalPathMs}ms（门限 ${CRITICAL_PATH_BUDGET_MS}ms）`);

    // 等后置作业被真实心跳消费。判据含 `wa_jobs` 行落到 `done`：处理器**返回后**调度器才收尾作业行，
    //   故只等"处理器里记的时间戳"会读到 `running`（那正是"只在内存里跑过"与"账已结"的分界）。
    const jobStatus = (id: string): string => (db.prepare('SELECT status FROM wa_jobs WHERE id = ?').get(id) as { status?: string } | undefined)?.status ?? '';
    const waitFor = async (pred: () => boolean, ms = 8_000): Promise<boolean> => {
      const started = Date.now();
      while (Date.now() - started < ms) {
        if (pred()) return true;
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      return pred();
    };
    ok(await waitFor(() => stamp.doneAt != null && jobStatus(jobId) === 'done'), 'M-3a 后置作业被真实心跳消费完（作业行已结）');

    eq(order, ['event', 'postlude'], 'M-1 收口事件先于后置账');
    ok(stamp.doneAt != null && stamp.eventAt != null && stamp.doneAt > stamp.eventAt, 'M-1b 两条时间戳的先后与上一条一致');
    eq(persisted.length, 1, 'M-1c 收口事件已持久化（fake store 收到的就是它）');
    const lat = (stamp.doneAt ?? 0) - (stamp.eventAt ?? 0);
    ok(lat > 0 && lat <= HOP_BUDGET_MS, 'M-3 端到端在一个心跳 + 余量内', `${lat}ms（门限 ${HOP_BUDGET_MS}ms）`);
    eq(accountingCount, 1, 'M-1d 后置账真的办了（计数 0→1，不是"没抛就算过"）');
    eq(handledRun, 'run-A', 'M-1e 办的是本轮 run');
    eq(jobStatus(jobId), 'done', 'M-6 作业行被消费成 `done`（不是只在内存里跑过）');

    // ── 重放同一 run：不办第二遍 ──
    const before = accountingCount;
    const replayJob = await sched.enqueue(POSTLUDE_JOB_TYPE, { taskId: 't1', projectId: 'p1', finalContent: '重放', source: 'run_completed' });
    await waitFor(() => jobStatus(replayJob) === 'done');
    eq(jobStatus(replayJob), 'done', 'M-4a 重放作业确实被消费过（不是"没跑"冒充"没重复"）');
    eq(accountingCount, before, 'M-4 同一 run 重放 ⇒ 不再办第二遍（幂等键生效）');

    // ── 续跑后再次完成：新 run，各办一次 ──
    markCompletedRun(db as never, 't1', 'run-B');
    const thirdJob = await sched.enqueue(POSTLUDE_JOB_TYPE, { taskId: 't1', projectId: 'p1', finalContent: '续跑完成', source: 'run_completed' });
    await waitFor(() => accountingCount === before + 1 && jobStatus(thirdJob) === 'done');
    eq(accountingCount, before + 1, 'M-5 续跑后再次完成 ⇒ 再办一次（按 run 身份，不按终态去重）');
    eq(handledRun, 'run-B', 'M-5b 办的是新 run');

    console.log(`\n  量测：收口关键路径增量 ${criticalPathMs}ms；端到端（含一个心跳）${lat}ms`);
  } finally {
    sched.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
