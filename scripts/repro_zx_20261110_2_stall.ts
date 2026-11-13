/**
 * zx_20261110_2 事故**受控复现** —— 「恒」：卡住的执行体，不得再把整条恢复队列堵死。
 *
 * ## 复现的是哪一段（真标本：任务 339ef167，2026-11-10）
 *
 *   13:38:42 执行体最后一次有动静；600s 超时 abort 发出，`streamText` 不兑现 ⇒ handler **永不返回**；
 *   13:48:54 / 13:53:49 / 13:56:53 用户三次「恢复」各建一条 `resume-ai-task` 作业；
 *   14:51:57 第三条才被取走——**在队 55 分钟**，前两条被静默跳过。
 *
 * 用假时钟把这段压到毫秒级：同一 taskId 排队两次 + 第一个 handler 永不返回。
 *
 * ## 钉的是"修好之后会怎样"（两侧标本，不只证"能跑通"）
 *
 *   R-1 宽限内让位（**旧行为保留**）：键在、刚起跑、无在途 run ⇒ 不抢跑（否则一入队就双跑）；
 *   R-2 超宽限释放：键在、无在途 run、超龄 ⇒ 释放该键并**继续处理当前作业**（事故的直接病灶）；
 *   R-3 有真实 run ⇒ 永不释放（`hasTaskRun` 是唯一凭据，不能凭"键老"就判死）；
 *   R-4 旧 run 的 `finally` 不删新 run 的键（按 `runToken` 比对）；
 *   R-5 周期对账把"键在、run 没了"的键**重排**，且重排有上界（到顶如实置 failed）。
 *
 * 记账侧同时验：`job.inflight_released` / `job.inflight_requeued` / `job.requeue_exhausted`
 * 三笔事件真落（事件总线是唯一观测口，计数器断言有 0→1 正面）。
 *
 * 纪律：假时钟注入（`setClock`），不依赖真实墙钟；判据文案不含失败字形；不写任何轮次字面量。
 *
 * 用法：`npx tsx scripts/repro_zx_20261110_2_stall.ts`
 */
import { DatabaseSync } from 'node:sqlite';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
import {
  registerTaskRun,
  unregisterTaskRun,
} from '../apps/worker-ant-desktop/src/main/core/task-run-registry.js';
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

/** 与生产同形的列（只取本脚本触碰到的那些）。 */
const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
`;

function mkdb(): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d as unknown as AnyDb;
}

type SchedInternals = {
  pending: Map<string, { type: string; payload: Record<string, unknown>; jobId?: string }>;
  inflight: Map<string, { taskId: string; jobId?: string; startedAt: number; runToken: string; requeues: number }>;
  processPending(): Promise<void>;
  reconcileInflight(): number;
};

const jobRow = (db: AnyDb, id: string): { status: string; error: string | null } =>
  db.prepare('SELECT status, error FROM wa_jobs WHERE id = ?').get(id) as { status: string; error: string | null };

const TID = 'task-339ef167';

/** 造一条 pending 作业行 + 内存队列条目（走调度器自己的键域口径：有 taskId 就用 taskId 做键）。 */
function enqueueRaw(sch: TaskScheduler, db: AnyDb, jobId: string): void {
  const payload = { taskId: TID, projectId: 'proj-erp', source: 'repro' };
  db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, 'resume-ai-task', ?, 'pending')")
    .run(jobId, JSON.stringify(payload));
  (sch as unknown as SchedInternals).pending.set(TID, { type: 'resume-ai-task', payload, jobId });
}

/** 事件计数（订阅总线，只统计本脚本关心的三类）。 */
function watchEvents(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of ['job.inflight_released', 'job.inflight_requeued', 'job.requeue_exhausted'] as const) {
    counts[t] = 0;
    eventBus.on(t, () => { counts[t] = (counts[t] ?? 0) + 1; });
  }
  return counts;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

async function main(): Promise<void> {
  const ev = watchEvents();

  // ═══ R-1 / R-2 / R-4：事故主干 ════════════════════════════════════════════
  console.log('\n【R-1/R-2/R-4】永不返回的 handler 不得把同任务后续作业堵死');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 1_000_000;
    sch.setClock(() => now);

    // 全部 handler 都不返回——事故里 `streamText` 收到 abort 后 promise 未结，就是这个形状。
    const gates: Array<() => void> = [];
    let calls = 0;
    sch.register('ai-task', async () => { calls++; await new Promise<void>((r) => gates.push(r)); });
    sch.register('resume-ai-task', async () => { calls++; await new Promise<void>((r) => gates.push(r)); });

    // ── 第一次入队：起跑，永不返回 ──
    enqueueRaw(sch, db, 'job-A');
    const pA = inside.processPending();
    await tick();
    eq(calls, 1, 'R-1a 第一条作业已起跑');
    ok(inside.inflight.has(TID), 'R-1b 在途键在册（与 `pending` 同域，键＝taskId）');
    const tokenA = inside.inflight.get(TID)!.runToken;

    // ── 宽限内第二次入队：让位（旧行为保留，两侧标本的"不该动"那一侧）──
    now += 10_000;
    enqueueRaw(sch, db, 'job-B');
    await inside.processPending(); // 这一跳在守卫处就 return 了（无人接手），故可安全 await
    await tick();
    eq(calls, 1, 'R-1c ★宽限内（10s < 60s）宽限生效：无人接手，不得抢跑出第二份');
    ok(inside.inflight.get(TID)?.runToken === tokenA, 'R-1d 在途键仍是第一条那把（未被顶替）');
    ok(inside.pending.has(TID), 'R-1e 被挡下的条目仍留在队里（不静默丢弃，下一跳再看）');

    // ── 超宽限再跳一次：释放死键，继续处理当前作业（事故病灶的直接治法）──
    now += 60_000; // 键龄 70s > 60s，且 `hasTaskRun(TID)` 为假
    // 这一跳会**真的接手第二条作业**（它同样永不返回）⇒ 不能 await，否则本脚本自己卡住。
    const pB2 = inside.processPending();
    await tick();
    eq(calls, 2, 'R-2a ★超宽限且无真实 run ⇒ 释放死键并继续处理当前作业（旧实现恒 return）');
    const rowA = jobRow(db, 'job-A');
    eq(rowA.status, 'done', 'R-2b 被释放的死作业如实收尾（不留在 running 假装在跑）');
    eq(rowA.error, 'inflight_orphan_released', 'R-2c 收尾带因由（事后可查"为什么它被提前结束"）');
    ok(ev['job.inflight_released'] >= 1, 'R-2d 释放这笔账落了事件（0→1 正面断言）',
      `实测 ${ev['job.inflight_released'] ?? 0}`);

    // ── 旧 run 的 finally 回来：不得删新 run 的键 ──
    ok(inside.inflight.has(TID), 'R-4a 第二条作业此刻占着同一个键');
    const tokenB = inside.inflight.get(TID)!.runToken;
    ok(tokenB !== tokenA, 'R-4b 两把 token 不同（新旧可辨）');
    gates[0]!(); // 让第一条 handler 返回 ⇒ 它的 finally 跑 `releaseInflightToken(key, tokenA)`
    await pA;
    await tick();
    ok(inside.inflight.has(TID), 'R-4c ★旧 run 的 finally 不得删新 run 的键（按 runToken 比对）');
    ok(inside.inflight.get(TID)?.runToken === tokenB, 'R-4d 新键原封未动');

    // ── 收尾 ──
    gates[1]!();
    await pB2;
    await tick();
    ok(!inside.inflight.has(TID), 'R-4e 自己那一把正常移除（闸不是永久的）');
    eq(jobRow(db, 'job-B').status, 'done', 'R-4f 第二条作业如实收尾');
    sch.stop();
  }

  // ═══ R-3：有真实 run ⇒ 永不释放 ═════════════════════════════════════════
  console.log('\n【R-3】有真实执行体在跑 ⇒ 键老也不得被释放');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 5_000_000;
    sch.setClock(() => now);

    const ctrl = new AbortController();
    registerTaskRun(TID, ctrl); // 真在跑（执行体登记了句柄）
    let calls = 0;
    // ⚠ 作业类型须与 `enqueueRaw` 造的一致（`resume-ai-task`）——类型对不上时
    //   `processPending` 在第一行 `if (!handler) return` 就退出了，键根本不入册，
    //   那样"对账 0 释放"是**无人可释放**，不是"真在跑被放过"（假绿）。
    sch.register('resume-ai-task', async () => { calls++; await new Promise<void>(() => { /* 永不返回 */ }); });

    enqueueRaw(sch, db, 'job-C');
    void inside.processPending();
    await tick();
    eq(calls, 1, 'R-3a 第一条起跑');

    now += 600_000; // 10 分钟——远超宽限
    eq(inside.reconcileInflight(), 0, 'R-3b ★周期对账不碰有真实 run 的键（0 释放）');
    ok(inside.inflight.has(TID), 'R-3c 键仍在（合法的"正在跑"不得被当死键收掉）');
    eq(jobRow(db, 'job-C').status, 'running', 'R-3d 作业行仍在 running（未被打断）');

    unregisterTaskRun(TID, ctrl);
    now += 1_000;
    eq(inside.reconcileInflight(), 1, 'R-3e ★run 注销后同一把键立刻可对账（两侧标本的"该动"那一侧）');
    ok(!inside.inflight.has(TID), 'R-3f 键已释放');
    sch.stop();
  }

  // ═══ R-5：周期对账重排 + 上界 ═══════════════════════════════════════════
  console.log('\n【R-5】周期对账把死键重排，且重排有上界');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 9_000_000;
    sch.setClock(() => now);
    // 本场景不真跑 handler：只造"键在、run 没了、超龄"的状态，专测对账本身。
    sch.register('ai-task', async () => { /* 占位 */ });

    const payload = { taskId: TID, projectId: 'proj-erp', source: 'repro' };
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('job-D', 'ai-task', ?, 'running')")
      .run(JSON.stringify(payload));
    inside.inflight.set(TID, {
      taskId: TID, jobId: 'job-D', type: 'ai-task', payload: payload as Record<string, unknown>,
      startedAt: now, runToken: 'tok-D', requeues: 0,
    });
    const before = ev['job.inflight_requeued'] ?? 0;

    now += 61_000;
    eq(inside.reconcileInflight(), 1, 'R-5a 超龄死键被对账释放');
    ok(inside.pending.has(TID), 'R-5b 死作业被放回内存队列（重排，而不是丢掉）');
    eq(jobRow(db, 'job-D').status, 'pending', 'R-5c 作业行放回 pending');
    eq(ev['job.inflight_requeued'] ?? 0, before + 1, 'R-5d 重排这笔账落了事件（计数 0→1）');

    // 重排上界：连造三轮"又卡住" ⇒ 第三轮不再重排，如实置 failed。
    for (let i = 0; i < 3; i++) {
      const entry = inside.pending.get(TID);
      inside.pending.delete(TID);
      inside.inflight.set(TID, {
        taskId: TID, jobId: 'job-D', type: 'ai-task', payload: payload as Record<string, unknown>,
        startedAt: now, runToken: `tok-D${i}`, requeues: 0,
      });
      now += 61_000;
      inside.reconcileInflight();
      if (entry) { /* 只为保持循环读一次，避免未用变量 */ }
    }
    const row = jobRow(db, 'job-D');
    eq(row.status, 'failed', 'R-5e ★重排到顶 ⇒ 如实置 failed（不再无限"卡死—重排"）');
    eq(row.error, 'stalled_after_requeue', 'R-5f 失败因由可查');
    ok((ev['job.requeue_exhausted'] ?? 0) >= 1, 'R-5g 到顶这笔账落了事件（0→1 正面断言）',
      `实测 ${ev['job.requeue_exhausted'] ?? 0}`);
    sch.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
