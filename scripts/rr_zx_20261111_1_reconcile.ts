/**
 * zx_20261111_1 B3 复跑 —— 「治大国若烹小鲜」：**长作业不按 60 秒翻面**。
 *
 * 病根：调度器只有一把全局 60s 超龄尺。`project-init-brief` 合法要跑 170s（无 taskId），
 * 60s 就被判"无真实执行体"并重排 ⇒ 同一份须知被反复翻面；`embed-memory` 这类后台作业同理。
 *
 * 判据（假时钟注入，不依赖真实墙钟）：
 *   R-1 声明 200s 的作业：100s ⇒ 不重排；201s ⇒ 重排一次（两侧标本）。
 *   R-2 未声明且**有 taskId**：59s ⇒ 不重排；61s ⇒ 重排（旧行为保留）。
 *   R-3 未声明且**无 taskId**：5 分钟 ⇒ 不重排；11 分钟 ⇒ 重排（保守缺省 10 分钟）。
 *   R-4 有真实 run（`hasTaskRun`）⇒ 任何年龄都不重排；注销后同一把键立刻可对账。
 *   R-5 `processPending` 守卫与对账**同一把尺**：声明 200s 时新作业 100s 不抢跑、201s 才接手。
 *   R-6 静态接线：`register` 收 `orphanGraceMs`、两处守卫都走 `orphanMsOf`、
 *       `project-init-brief` 登记 200s（作业自身超时 + 30s）。
 *
 * 纪律：真源直 import（改签名即编译期红）；计数器断言有 0→1 正面；无轮次字面量；
 *       判据文案不得含失败字形（全量汇总按字形计失败数）。
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
/** 轮次由**载体自身**派生（批次后缀不属轮次）。 */
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

type InflightLike = {
  taskId: string; jobId?: string; type: string; payload: Record<string, unknown>;
  startedAt: number; runToken: string; requeues: number;
};
type SchedInternals = {
  pending: Map<string, { type: string; payload: Record<string, unknown>; jobId?: string }>;
  inflight: Map<string, InflightLike>;
  processPending(): Promise<void>;
  reconcileInflight(): number;
};

const jobRow = (db: AnyDb, id: string): { status: string; error: string | null } =>
  db.prepare('SELECT status, error FROM wa_jobs WHERE id = ?').get(id) as { status: string; error: string | null };

function addRunning(db: AnyDb, id: string, type: string, payload: Record<string, unknown>): void {
  db.prepare('INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, ?, ?, ?)')
    .run(id, type, JSON.stringify(payload), 'running');
}
function addPending(db: AnyDb, id: string, type: string, payload: Record<string, unknown>): void {
  db.prepare('INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, ?, ?, ?)')
    .run(id, type, JSON.stringify(payload), 'pending');
}

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

async function main(): Promise<void> {
  // ═══ K｜构建钉 ═══════════════════════════════════════════════════════════
  console.log(`\n【K】构建钉（${SELF_ROUND}）`);
  checkBuildPins(ok, { distDir: path.join(A, 'dist') });
  const execSrc = fs.readFileSync(path.join(root, `${A}/src/main/core/agent-executor.ts`), 'utf-8');
  const tag = /build:\s*'(zx_[0-9_]+)'/.exec(stripKeepingLines(execSrc).join('\n'))?.[1] ?? '';
  ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), '当前 build 快照不早于本脚本轮次（方向性比较）', `${tag} vs ${SELF_ROUND}`);

  // ═══ R-1｜声明 200s：100s 不重排 / 201s 重排一次 ═════════════════════════
  console.log('\n【R-1】声明 200s 的作业：先等它跑完，再谈收尸');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 1_000_000;
    sch.setClock(() => now);
    let requeued = 0;
    eventBus.on('job.inflight_requeued', (e) => {
      if (String((e.data as { jobId?: unknown }).jobId ?? '') === 'p1') requeued++;
    });
    sch.register('project-init-brief', async () => { /* 占位 */ }, { orphanGraceMs: 200_000 });

    const payload = { projectId: 'proj', trigger: 'manual' };
    addRunning(db, 'p1', 'project-init-brief', payload);
    inside.inflight.set('brief:p1', {
      taskId: '', jobId: 'p1', type: 'project-init-brief', payload,
      startedAt: now, runToken: 'tk1', requeues: 0,
    });

    now += 100_000;
    eq(inside.reconcileInflight(), 0, 'R-1a ★100s（远超旧 60s 尺）⇒ 不重排');
    ok(inside.inflight.has('brief:p1'), 'R-1b 键仍在册（合法长作业不得被当死键收掉）');
    eq(jobRow(db, 'p1').status, 'running', 'R-1c 作业行仍在 running');
    eq(requeued, 0, 'R-1d 重排事件 0 次（不无中生有）');

    now += 101_000; // 总计 201s
    eq(inside.reconcileInflight(), 1, 'R-1e ★201s ⇒ 重排一次（真挂死仍能收尸）');
    eq(jobRow(db, 'p1').status, 'pending', 'R-1f 被放回 pending 等着重跑');
    eq(jobRow(db, 'p1').error, 'inflight_orphan_reconcile', 'R-1g 重排带因由可查');
    eq(requeued, 1, 'R-1h ★重排事件 0→1');
    sch.stop();
  }

  // ═══ R-2｜未声明 + 有 taskId：旧 60s 尺保留 ═════════════════════════════
  console.log('\n【R-2】未声明且有 taskId：59s 不动 / 61s 重排');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 2_000_000;
    sch.setClock(() => now);
    sch.register('resume-ai-task', async () => { /* 占位 */ });

    const payload = { taskId: 'T2', projectId: 'p' };
    addRunning(db, 'r2', 'resume-ai-task', payload);
    inside.inflight.set('T2', { taskId: 'T2', jobId: 'r2', type: 'resume-ai-task', payload, startedAt: now, runToken: 'tk2', requeues: 0 });

    now += 59_000;
    eq(inside.reconcileInflight(), 0, 'R-2a 59s ⇒ 不重排（旧行为保留）');
    now += 2_000; // 总计 61s
    eq(inside.reconcileInflight(), 1, 'R-2b ★61s ⇒ 重排（有 taskId 的真挂死按旧尺收）');
    sch.stop();
  }

  // ═══ R-3｜未声明 + 无 taskId：保守缺省 10 分钟 ══════════════════════════
  console.log('\n【R-3】无 taskId 的后台作业：5 分钟不动 / 11 分钟重排');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 3_000_000;
    sch.setClock(() => now);
    sch.register('embed-memory', async () => { /* 占位 */ });

    const payload = { source: 'auto' };
    addRunning(db, 'e3', 'embed-memory', payload);
    inside.inflight.set('embed:auto', { taskId: '', jobId: 'e3', type: 'embed-memory', payload, startedAt: now, runToken: 'tk3', requeues: 0 });

    now += 300_000; // 5 分钟
    eq(inside.reconcileInflight(), 0, 'R-3a ★5 分钟 ⇒ 不重排（60s 翻面对后台长作业太苛刻）');
    now += 360_001; // 总计 660_001ms ≈ 11 分钟
    eq(inside.reconcileInflight(), 1, 'R-3b ★11 分钟 ⇒ 重排（不可能无限等）');
    sch.stop();
  }

  // ═══ R-4｜有真实 run ⇒ 任何年龄都不重排 ═════════════════════════════════
  console.log('\n【R-4】`hasTaskRun` 是唯一判活凭据，不被宽限改动绕过');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 5_000_000;
    sch.setClock(() => now);
    sch.register('resume-ai-task', async () => { /* 占位 */ });

    const ctrl = new AbortController();
    registerTaskRun('T8', ctrl);
    const payload = { taskId: 'T8', projectId: 'p' };
    addRunning(db, 'b4', 'resume-ai-task', payload);
    inside.inflight.set('T8', { taskId: 'T8', jobId: 'b4', type: 'resume-ai-task', payload, startedAt: now, runToken: 'tk4', requeues: 0 });

    now += 3_600_000; // 一小时——远超任何宽限
    eq(inside.reconcileInflight(), 0, 'R-4a ★有真实 run ⇒ 一小时也不重排');
    ok(inside.inflight.has('T8'), 'R-4b 键仍在');
    eq(jobRow(db, 'b4').status, 'running', 'R-4c 作业行仍在 running');

    unregisterTaskRun('T8', ctrl);
    eq(inside.reconcileInflight(), 1, 'R-4d ★run 注销后同一把键立刻可对账（两侧标本的"该动"那一侧）');
    sch.stop();
  }

  // ═══ R-5｜processPending 守卫与对账同一把尺 ═════════════════════════════
  console.log('\n【R-5】新作业不得在声明宽限内抢跑');
  {
    const db = mkdb();
    const sch = new TaskScheduler(db as never);
    const inside = sch as unknown as SchedInternals;
    let now = 7_000_000;
    sch.setClock(() => now);
    const gates: Array<() => void> = [];
    let calls = 0;
    sch.register('project-init-brief', async () => { calls++; await new Promise<void>((r) => gates.push(r)); },
      { orphanGraceMs: 200_000 });

    const payload = { projectId: 'proj', trigger: 'manual' };
    addPending(db, 'q1', 'project-init-brief', payload);
    inside.pending.set('brief:q', { type: 'project-init-brief', payload, jobId: 'q1' });
    const pA = inside.processPending();
    await tick();
    eq(calls, 1, 'R-5a 第一条起跑');

    now += 100_000;
    addPending(db, 'q2', 'project-init-brief', payload);
    inside.pending.set('brief:q', { type: 'project-init-brief', payload, jobId: 'q2' });
    await inside.processPending();
    await tick();
    eq(calls, 1, 'R-5b ★声明宽限内（100s）新作业不抢跑（旧 60s 尺会在这里翻面）');
    ok(inside.inflight.has('brief:q'), 'R-5c 键仍在册');
    eq(jobRow(db, 'q2').status, 'pending', 'R-5d 新作业老实等在队里');

    now += 101_000; // 总计 201s
    const pB = inside.processPending();
    await tick();
    eq(calls, 2, 'R-5e ★超声明宽限且无真实 run ⇒ 释放并接手');
    eq(jobRow(db, 'q1').error, 'inflight_orphan_released', 'R-5f 死作业如实收尾并留因由');
    eq(jobRow(db, 'q2').status, 'running', 'R-5g 新作业接手在跑');

    gates[0]!(); await pA; await tick();
    ok(inside.inflight.has('brief:q'), 'R-5h 旧 run 收尾后新 run 的键仍在（token 隔离未回退）');
    gates[1]!(); await pB; await tick();
    ok(!inside.inflight.has('brief:q'), 'R-5i 全部收尾后键清空');
    sch.stop();
  }

  // ═══ R-6｜静态接线 ══════════════════════════════════════════════════════
  console.log('\n【R-6】宽限声明真被登记、两处守卫真走同一把尺');
  {
    const sched = CODE(`${A}/src/main/core/task-scheduler.ts`);
    ok(/register\(type: string, handler: JobHandler, opts: \{ orphanGraceMs\?: number \} = \{\}\): void/.test(sched),
      'R-6a `register` 收 `orphanGraceMs`（声明入口唯一）');
    ok(/private orphanGrace = new Map<string, number>\(\)/.test(sched),
      'R-6b 按类型登记宽限（不是又一个全局常量）');
    ok(/const DEFAULT_NO_TASK_ORPHAN_MS = 600_000;/.test(sched),
      'R-6c 无 taskId 保守缺省 10 分钟在位');
    ok(/if \(declared > 0\) return Math\.max\(global, declared\);/.test(sched) &&
       /if \(!hasTaskId\) return Math\.max\(global, DEFAULT_NO_TASK_ORPHAN_MS\);/.test(sched),
      'R-6d `orphanMsOf` 阶梯：声明值优先 → 无 taskId 保守缺省 → 全局');
    eq((sched.match(/this\.orphanMsOf\(/g) ?? []).length, 2,
      'R-6e ★两处守卫都走 `orphanMsOf`（processPending + reconcileInflight），无第三处自写尺');
    ok(!/age < inflightOrphanMs\(\)/.test(sched),
      'R-6f 旧字面守卫已清除（不留两条真源）');

    const jobs = CODE(`${A}/src/main/core/jobs/index.ts`);
    ok(/BRIEF_GENERATE_TIMEOUT_MS, runProjectBriefInit/.test(jobs),
      'R-6g 作业侧 import 自身超时常量（宽限由载体派生，不手抄 200s）');
    ok(/scheduler\.register\('project-init-brief'[\s\S]{0,600}orphanGraceMs: BRIEF_GENERATE_TIMEOUT_MS \+ 30_000/.test(jobs),
      'R-6h ★`project-init-brief` 登记 = 作业超时 + 30s（自身先收口，调度器再收尸）');
  }

  console.log(`\n[rr_${SELF_ROUND}_reconcile] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
