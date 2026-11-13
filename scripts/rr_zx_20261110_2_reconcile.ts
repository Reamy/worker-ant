/**
 * zx_20261110_2 B2 复跑 —— 「恒」：**键在 ≠ 在跑；一把死钥匙不得锁住整条队列**。
 *
 * 真标本：任务 339ef167 的三条 `resume-ai-task`（13:48:54 / 13:53:49 / 13:56:53）同键并存，
 * 前两条被 `superseded_by_*` 收尾，第三条在队 **55 分钟**才被取走——因为 `inflight` 那把键
 * 只在 handler 的 `finally` 删，而 handler 永不返回。
 *
 * 五组判据（假时钟注入，不依赖真实墙钟）：
 *   Z-1 启动去重：同 (type, taskId) 的三条 pending 只留**最新**一条，旧两条置 done + 留痕；
 *       不同任务 / 无 taskId 的作业**不受影响**（两侧标本）；
 *   Z-2 守卫释放：键在、无真实 run、超宽限 ⇒ 释放该键并**继续处理当前作业**；宽限内让位；
 *   Z-3 有真实 run ⇒ 永不释放（`hasTaskRun` 是唯一凭据，不凭"键老"判死）；
 *   Z-4 token 隔离：旧 run 的 `finally` 不得删新 run 的键；
 *   Z-5 用户释放：`releaseTaskRun` 只清点名任务的在途键与残留执行作业，别家纹丝不动。
 *
 * 纪律（承 auto-memory）：
 *   G-1 真源直 import（`TaskScheduler` 真实现，改签名即编译期红）；
 *   G-2 两只标本（该动的动了 / 不该动的没动）；
 *   G-4 计数器断言必有 0→1 正面；
 *   G-6 无轮次字面量（轮次由 `path.basename(__filename)` 派生，只做方向性比较）；
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines, buildNotOlderThan } from './lib/rr-pins.js';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
import { registerTaskRun, unregisterTaskRun } from '../apps/worker-ant-desktop/src/main/core/task-run-registry.js';
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
/** G-6：轮次由**载体自身**派生（批次后缀属批次、不属轮次，须剥掉）。 */
const SELF_ROUND = /^(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''))?.[1] ?? '';
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')));
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
const pendOf = (db: AnyDb, id: string): number =>
  (db.prepare("SELECT COUNT(*) AS c FROM wa_jobs WHERE id = ? AND status = 'pending'").get(id) as { c: number }).c;

function addJob(db: AnyDb, id: string, type: string, status: string, taskId: string, createdAt: string): void {
  db.prepare('INSERT INTO wa_jobs (id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, type, JSON.stringify(taskId ? { taskId, projectId: 'p' } : { source: 'x' }), status, createdAt);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

async function main(): Promise<void> {
  // ═══ K｜构建钉 ═══════════════════════════════════════════════════════════
  console.log(`\n【K】构建钉（${SELF_ROUND}）`);
  checkBuildPins(ok, { distDir: path.join(A, 'dist') });
  const src = fs.readFileSync(path.join(root, `${A}/src/main/core/agent-executor.ts`), 'utf-8');
  const tag = /build:\s*'(zx_[0-9_]+)'/.exec(stripKeepingLines(src).join('\n'))?.[1] ?? '';
  ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), '当前 build 快照不早于本脚本轮次（方向性比较）', `${tag} vs ${SELF_ROUND}`);

  // ═══ Z-1｜启动去重 ═══════════════════════════════════════════════════════
  console.log('\n【Z-1】启动去重：同 (type,taskId) 的重复待执行作业只留最新一条');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    // 事故形状：同一任务三条 resume（时刻递增），另有一条别家任务、一条无归属作业。
    addJob(db, 'r1', 'resume-ai-task', 'pending', 'T1', '2026-11-10 05:48:54');
    addJob(db, 'r2', 'resume-ai-task', 'pending', 'T1', '2026-11-10 05:53:49');
    addJob(db, 'r3', 'resume-ai-task', 'pending', 'T1', '2026-11-10 05:56:53');
    addJob(db, 'o1', 'resume-ai-task', 'pending', 'T2', '2026-11-10 05:50:00');
    addJob(db, 'n1', 'embed-memory', 'pending', '', '2026-11-10 05:00:00');

    const merged = sch.dedupePendingJobs();
    eq(merged, 2, 'Z-1a ★合并掉 2 条（3 条同组 ⇒ 只留 1 条）');
    eq(pendOf(db, 'r3'), 1, 'Z-1b 保留的是**最新**那一条（05:56:53 那份正是事故里被卡住的那条）');
    eq(jobRow(db, 'r1').status, 'done', 'Z-1c 旧条目如实收尾（不物理删，事后可查）');
    eq(jobRow(db, 'r1').error, 'superseded_by_dedupe', 'Z-1d 收尾带因由可查');
    eq(jobRow(db, 'r2').error, 'superseded_by_dedupe', 'Z-1e 第二条同因由');
    eq(pendOf(db, 'o1'), 1, 'Z-1f ★别家任务纹丝不动（键域按 (type,taskId)，不是按 type 一刀切）');
    eq(pendOf(db, 'n1'), 1, 'Z-1g ★无 taskId 的作业不参与去重（`embed-memory` 这类无归属作业不受影响）');
    eq(sch.dedupePendingJobs(), 0, 'Z-1h 幂等：再跑一次零合并（不会把已合并的又算一遍）');
  }

  // ═══ Z-2｜守卫释放 ═══════════════════════════════════════════════════════
  console.log('\n【Z-2】键在、无真实 run、超宽限 ⇒ 释放并继续处理当前作业');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 1_000_000;
    sch.setClock(() => now);

    const gates: Array<() => void> = [];
    let calls = 0;
    sch.register('resume-ai-task', async () => { calls++; await new Promise<void>((r) => gates.push(r)); });

    const launched: Record<string, number> = {};
    eventBus.on('job.inflight_released', (e) => {
      const id = String((e.data as { jobId?: unknown }).jobId ?? '');
      launched[id] = (launched[id] ?? 0) + 1;
    });

    const payload = { taskId: 'T9', projectId: 'p' };
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('a1','resume-ai-task',?,'pending')").run(JSON.stringify(payload));
    inside.pending.set('T9', { type: 'resume-ai-task', payload, jobId: 'a1' });
    const pA = inside.processPending();
    await tick();
    eq(calls, 1, 'Z-2a 第一条起跑');

    // 宽限内：让位（不抢跑）
    now += 10_000;
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('a2','resume-ai-task',?,'pending')").run(JSON.stringify(payload));
    inside.pending.set('T9', { type: 'resume-ai-task', payload, jobId: 'a2' });
    await inside.processPending();
    await tick();
    eq(calls, 1, 'Z-2b 宽限内（10s）不抢跑（旧行为保留）');
    ok(inside.inflight.has('T9'), 'Z-2c 键仍在册');

    // 超宽限：释放死键 + 继续
    now += 60_000;
    const pB = inside.processPending();
    await tick();
    eq(calls, 2, 'Z-2d ★超宽限且无真实 run ⇒ 释放并继续处理当前作业（旧实现恒 return）');
    eq(jobRow(db, 'a1').error, 'inflight_orphan_released', 'Z-2e 死作业如实收尾并留因由');
    eq(launched['a1'] ?? 0, 1, 'Z-2f ★`job.inflight_released` 事件 0→1（唯一观测口，有账可查）');
    eq(launched['a2'] ?? 0, 0, 'Z-2g 未释放的作业不记账（不无中生有）');

    // 收尾
    gates[0]!(); await pA; await tick();
    ok(inside.inflight.has('T9'), 'Z-2h 旧 run 收尾后新 run 的键仍在（token 隔离）');
    gates[1]!(); await pB; await tick();
    ok(!inside.inflight.has('T9'), 'Z-2i 全部收尾后键清空');
    sch.stop();
  }

  // ═══ Z-3｜有真实 run ⇒ 不释放 ═══════════════════════════════════════════
  console.log('\n【Z-3】有真实执行体在跑 ⇒ 键老也不释放');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 3_000_000;
    sch.setClock(() => now);
    sch.register('resume-ai-task', async () => { await new Promise<void>(() => { /* 永不返回 */ }); });

    const ctrl = new AbortController();
    registerTaskRun('T8', ctrl);
    const payload = { taskId: 'T8', projectId: 'p' };
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('b1','resume-ai-task',?,'pending')").run(JSON.stringify(payload));
    inside.pending.set('T8', { type: 'resume-ai-task', payload, jobId: 'b1' });
    void inside.processPending();
    await tick();

    now += 3_600_000; // 一小时——远超宽限
    eq(inside.reconcileInflight(), 0, 'Z-3a ★周期对账不碰有真实 run 的键');
    ok(inside.inflight.has('T8'), 'Z-3b 键仍在（合法的"正在跑"不得被当死键收掉）');
    eq(jobRow(db, 'b1').status, 'running', 'Z-3c 作业行仍在 running');

    unregisterTaskRun('T8', ctrl);
    eq(inside.reconcileInflight(), 1, 'Z-3d ★run 注销后同一把键立刻可对账（两侧标本的"该动"那一侧）');
    eq(jobRow(db, 'b1').status, 'pending', 'Z-3e 被放回 pending 等着重跑（重排，不是丢掉）');
    eq(inside.reconcileInflight(), 0, 'Z-3f 已释放的键不再重复记账');
    sch.stop();
  }

  // ═══ Z-4｜token 隔离 ════════════════════════════════════════════════════
  console.log('\n【Z-4】旧 run 的 finally 不得删新 run 的键');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 5_000_000;
    sch.setClock(() => now);
    const gates: Array<() => void> = [];
    sch.register('resume-ai-task', async () => { await new Promise<void>((r) => gates.push(r)); });

    const payload = { taskId: 'T7', projectId: 'p' };
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('c1','resume-ai-task',?,'pending')").run(JSON.stringify(payload));
    inside.pending.set('T7', { type: 'resume-ai-task', payload, jobId: 'c1' });
    const p1 = inside.processPending();
    await tick();
    const tok1 = inside.inflight.get('T7')!.runToken;

    now += 61_000;
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('c2','resume-ai-task',?,'pending')").run(JSON.stringify(payload));
    inside.pending.set('T7', { type: 'resume-ai-task', payload, jobId: 'c2' });
    const p2 = inside.processPending();
    await tick();
    const tok2 = inside.inflight.get('T7')!.runToken;
    ok(tok1 !== tok2, 'Z-4a 两把 token 不同');

    gates[0]!(); await p1; await tick();   // 旧 run 收尾（它那把键早已被释放）
    ok(inside.inflight.has('T7'), 'Z-4b ★旧 run 的 finally 不得删新 run 的键');
    eq(inside.inflight.get('T7')!.runToken, tok2, 'Z-4c 新键 token 原封未动');

    gates[1]!(); await p2; await tick();
    ok(!inside.inflight.has('T7'), 'Z-4d 自己那一把正常移除');
    sch.stop();
  }

  // ═══ Z-5｜用户释放 ══════════════════════════════════════════════════════
  console.log('\n【Z-5】`releaseTaskRun` 只清点名任务');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 7_000_000;
    sch.setClock(() => now);
    sch.register('ai-task', async () => { await new Promise<void>(() => { /* 占位 */ }); });

    const mkP = (tid: string) => ({ taskId: tid, projectId: 'p' });
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('d1','resume-ai-task',?,'pending')").run(JSON.stringify(mkP('TA')));
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('d2','resume-ai-task',?,'running')").run(JSON.stringify(mkP('TA')));
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('d3','resume-ai-task',?,'pending')").run(JSON.stringify(mkP('TB')));
    inside.inflight.set('TA', { taskId: 'TA', jobId: 'd2', type: 'resume-ai-task', payload: mkP('TA'), startedAt: now, runToken: 'x', requeues: 0 });
    inside.pending.set('TA', { type: 'resume-ai-task', payload: mkP('TA'), jobId: 'd1' });

    const ids = sch.releaseTaskRun('TA', 'released_by_user');
    ok(ids.includes('d1') && ids.includes('d2'), 'Z-5a 返回被清的作业 id（审计用）', ids.join(','));
    ok(!inside.inflight.has('TA'), 'Z-5b 在途键被清');
    ok(!inside.pending.has('TA'), 'Z-5c 内存队列里同键条目一并清（否则下一秒又被取起来）');
    eq(jobRow(db, 'd1').status, 'done', 'Z-5d TA 的 pending 作业如实收尾');
    eq(jobRow(db, 'd1').error, 'released_by_user', 'Z-5e 收尾带因由（人的意志留痕）');
    eq(jobRow(db, 'd2').status, 'done', 'Z-5f TA 的 running 作业一并收尾');
    eq(jobRow(db, 'd3').status, 'pending', 'Z-5g ★别家任务纹丝不动（不能一按清全场）');
    eq(pendOf(db, 'd3'), 1, 'Z-5h 别家任务仍在队');
    sch.stop();
  }

  // ═══ Z-6｜接线在册 ══════════════════════════════════════════════════════
  console.log('\n【Z-6】对账/去重在调度器里真被接线');
  {
    const sch = CODE(`${A}/src/main/core/task-scheduler.ts`);
    ok(/dedupePendingJobs\(\);[\s\S]{0,900}SELECT \* FROM wa_jobs WHERE status IN \('pending','running'\)/.test(sch),
      'Z-6a `start()` 先合并重复再谈恢复（顺序即语义：先合再放，否则重放的还是重复份）');
    ok(/_scanTimer[\s\S]{0,900}reconcileInflight\(\)/.test(sch),
      'Z-6b 周期对账挂在扫描定时器上（不靠重启这一次偶然而已）');
    // zx_20261111_1 B3：守卫宽限由**按类型取**（`orphanMsOf`）——重定向到更强真源，
    //   不再钉"全局 60s 字面量"（早先按类型声明 200s 的合法作业会在这里被判死）。
    ok(/const graceMs = this\.orphanMsOf\(existing\.type, !!taskIdOfJob\);/.test(sch) &&
       /if \(stillLive \|\| age < graceMs\) return;/.test(sch),
      'Z-6c 守卫两只条件都在：有真实 run **或** 未超声明宽限 ⇒ 让位（宽限按 type 取）');
    ok(/releaseInflightToken\(key, runToken, 'finished'\)/.test(sch),
      'Z-6d `finally` 按 runToken 比对删除（旧 run 不删新键）');
    ok(/INFLIGHT_MAX_REQUEUES/.test(sch) && /stalled_after_requeue/.test(sch),
      'Z-6e 重排有上界，到顶如实置 failed（不无限"卡死—重排"）');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
