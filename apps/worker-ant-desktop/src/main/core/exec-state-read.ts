/**
 * zx_20261110_2 B3「恒」——执行态**取数口**：把四个事实读齐，交给 `exec-state.ts` 的纯函数裁决。
 *
 * 为什么要单独一层：`deriveExecState` 必须是零依赖纯函数（rr 用假时钟直跑、GUI 与引擎共用一把尺）。
 * 而"四个事实"里三个来自库、一个来自 `task-run-registry`——把 IO 塞进纯函数就毁掉了那把尺。
 * 故此处只做**取数**，不做判据；判据只有 `exec-state.ts` 一处。
 *
 * 三处调用方共用本口（不许各写一份 SQL，否则"跑没跑"会有第二个答案）：
 *   · `jobs/ai-task.ts` 的 `resume-ai-task`（恢复入口的裁决）；
 *   · `ipc/project.ipc.ts` 的 `task:get`（界面显示）；
 *   · `ipc/project.ipc.ts` 的 `task:updateStatus` / `task:resume`（动作回执）。
 */
import { deriveExecState, type ExecStateSnapshotInputs, type ExecStateVerdict } from './exec-state.js';
import { hasTaskRun } from './task-run-registry.js';
import { EXEC_JOB_TYPES, execJobPayloadLike } from './task-jobs.js';

/** 仅需 prepare().get()/.all() 的最小库接口（可脱 electron，rr 用内存库直跑）。 */
export interface ExecStateDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

export interface ExecStateSnapshot extends ExecStateVerdict, ExecStateSnapshotInputs {
  /**
   * zx_20261110_2 B7：最老一条 **pending** 执行作业的年龄（ms）；无 pending ⇒ `null`。
   * 与 `oldestJobAgeMs`（pending+running 取最大）分开：界面要看的是"排队等了多久"。
   */
  pendingJobAgeMs: number | null;
}

export interface ReadExecStateOpts {
  /** 注入"此刻"（rr 用假时钟；生产缺省真实墙钟）。 */
  nowMs?: number;
  /** 排队宽限（缺省取 `EXEC_QUEUE_GRACE_MS`）。 */
  queueGraceMs?: number;
  /**
   * **调用方自己那条作业**占用的 running 数（缺省 0）。
   *
   * 为什么需要：`resume-ai-task` 的处理器被调用时，调度器已把它自己的作业置为 `running`——
   * 若不摘掉，"有 1 条 running 作业"永远成立 ⇒ 执行态恒为 `queued`，**幽灵永远判不出来**
   * （事故 339ef167 里状态词写着 executing、实则无人，正是被这一条挡住了）。
   */
  excludeRunning?: number;
}

interface JobFact { status: string; ageMs: number }

/** 库内 UTC 秒级时刻 → epoch ms；形状不认 ⇒ null（不猜）。 */
function utcMs(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /T|Z$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 读齐四个事实并裁决执行态。
 *
 * 老库/缺表不阻断：读不到作业就当"没有作业"（派生量不入库，本就一秒一变，不值得为它抛）。
 */
export function readExecState(
  db: ExecStateDb,
  taskId: string,
  opts: ReadExecStateOpts = {},
): ExecStateSnapshot {
  const nowMs = opts.nowMs ?? Date.now();

  let dbStatus: string | null = null;
  try {
    const row = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: unknown } | undefined;
    dbStatus = row && typeof row.status === 'string' ? row.status : null;
  } catch { /* 缺表：按"查不到行"处理 */ }

  const facts: JobFact[] = [];
  try {
    const rows = db.prepare(
      `SELECT status, created_at FROM wa_jobs
        WHERE status IN ('pending','running') AND type IN (${EXEC_JOB_TYPES.map(() => '?').join(',')}) AND payload LIKE ?`,
    ).all(...EXEC_JOB_TYPES, execJobPayloadLike(taskId)) as Array<{ status: string; created_at: string }>;
    for (const r of rows) {
      const ms = utcMs(r.created_at);
      facts.push({ status: String(r.status), ageMs: ms === null ? 0 : Math.max(0, nowMs - ms) });
    }
  } catch { /* 缺表：无作业 */ }

  // 摘掉调用方自己那条（它必然是最新的——调度器刚把它置 running）。
  let running = facts.filter((f) => f.status === 'running');
  const pending = facts.filter((f) => f.status === 'pending');
  const exclude = Math.max(0, Math.trunc(opts.excludeRunning ?? 0));
  if (exclude > 0) {
    const newestFirst = running.slice().sort((a, b) => a.ageMs - b.ageMs);
    running = newestFirst.slice(Math.min(exclude, newestFirst.length));
  }

  const kept = [...pending, ...running];
  const oldestJobAgeMs = kept.length === 0 ? null : Math.max(...kept.map((f) => f.ageMs));
  // 待跑作业的年龄**单独**给一份：`oldestJobAgeMs` 取最大（含 running），答的是"排队宽限过没过"；
  // 界面问的是"排队等了多久"——两个问题，不共用一个数。
  const pendingJobAgeMs = pending.length === 0 ? null : Math.max(...pending.map((f) => f.ageMs));

  const inputs: ExecStateSnapshotInputs = {
    dbStatus,
    hasLiveRun: hasTaskRun(taskId),
    pendingExecJobs: pending.length,
    runningExecJobs: running.length,
    oldestJobAgeMs,
  };
  const verdict = deriveExecState({ ...inputs, queueGraceMs: opts.queueGraceMs });
  return { ...verdict, ...inputs, pendingJobAgeMs };
}
