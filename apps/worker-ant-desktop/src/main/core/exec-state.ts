/**
 * zx_20261110_2 B3「恒」——**执行态派生**：`running` 这个词必须由真实 run 兑现，否则只是空词。
 *
 * 病根（真标本：任务 339ef167，2026-11-10）：
 *   `wa_tasks.status` 写着 `executing`，而**没有任何执行体在跑**（600s abort 没兑现、handler 永不返回）。
 *   用户点「恢复」→ `resume-ai-task` 看到 `curStatus` 属 running 族就 `return`（"已在执行"）⇒
 *   点了什么都不发生；GUI 只读 DB 状态 ⇒ 一直显示在跑。**同一个词，两个用法**：库里是"曾经置过"，
 *   界面读成"此刻在跑"（维特根斯坦：意义即用法）。
 *
 * 治法：把"此刻到底在不在跑"做成一个**派生量**，由四个事实同时说了算：
 *   DB 状态 · 有无在途 run 句柄 · 在途执行作业数与年龄。
 * 不新增任务列（派生量不入库——它一秒就变，落库即陈旧）。
 *
 * 零依赖纯函数 ⇒ rr 用假时钟直跑，GUI 与引擎共用同一把尺（`task:get` 与 `resume-ai-task` 同源）。
 */

export type ExecState = 'live' | 'queued' | 'ghost' | 'idle' | 'terminal';

/** 终态（与 `core/task-jobs.ts` 的 `TERMINAL_STATUSES` 同值；此处不 import 以保持零依赖）。 */
const TERMINAL = new Set(['completed', 'failed', 'archived']);
/** running 族（与 `self-healing-monitor.ts` 的 `EXEC_STALE_STATUSES` 同族）。 */
const RUNNING_FAMILY = new Set(['executing', 'preparing', 'running']);

/** 排队宽限：刚入队的作业要给它一个"正要起跑"的窗口，不能一入队就判成幽灵。 */
export const EXEC_QUEUE_GRACE_MS = 120_000;

/**
 * **四个事实**（`exec-state-read.ts` 取数后的形状）——判据只用这四个，多一个都不给。
 * 单独导出是为了让"取数口"与"判据"共用一个类型：加事实即编译期同时提醒两侧。
 */
export interface ExecStateSnapshotInputs {
  /** `wa_tasks.status`。查不到行 ⇒ `null`。 */
  dbStatus: string | null | undefined;
  /** `hasTaskRun(taskId)`——真有在途执行体。 */
  hasLiveRun: boolean;
  /** 该任务 pending 状态的执行作业数（ai-task/resume-ai-task）。 */
  pendingExecJobs: number;
  /** 该任务 running 状态的执行作业数。 */
  runningExecJobs: number;
  /** 其中最老一条作业的年龄（ms）；无作业 ⇒ `null`。 */
  oldestJobAgeMs: number | null;
}

export interface ExecStateInput extends ExecStateSnapshotInputs {
  /** 排队宽限（缺省 `EXEC_QUEUE_GRACE_MS`）。 */
  queueGraceMs?: number;
}

export interface ExecStateVerdict {
  state: ExecState;
  /** 稳定可读因由（进 `task:get` / 会话行 / 事件）；`terminal` 与 `live` 也各有一句。 */
  reason: string;
}

/**
 * 派生执行态（纯函数）。
 *
 * 次序即语义（**不得重排**）：
 *   1. `terminal`  —— 终态就是终态，别的都不重要；
 *   2. `live`      —— 真有在途 run（**这一条压过状态词**：暂停后收尾未完的执行体仍算 live）；
 *   3. `queued`    —— 无在途 run，但有未超龄的执行作业在排/在跑；
 *   4. `ghost`     —— **仅** running 族：无在途 run、也无未超龄作业 ⇒ 状态词是空的；
 *   5. `idle`      —— 其余非终态（pending/planning/paused 且无作业）。
 */
export function deriveExecState(input: ExecStateInput): ExecStateVerdict {
  const status = String(input.dbStatus ?? '').trim();
  if (TERMINAL.has(status)) return { state: 'terminal', reason: `terminal:${status}` };

  if (input.hasLiveRun) return { state: 'live', reason: 'live_run' };

  const grace = input.queueGraceMs ?? EXEC_QUEUE_GRACE_MS;
  const jobs = Math.max(0, Number(input.pendingExecJobs) || 0) + Math.max(0, Number(input.runningExecJobs) || 0);
  const youngEnough = input.oldestJobAgeMs === null || input.oldestJobAgeMs <= grace;
  if (jobs > 0 && youngEnough) return { state: 'queued', reason: `queued_jobs:${jobs}` };

  if (RUNNING_FAMILY.has(status)) {
    return {
      state: 'ghost',
      reason: jobs > 0 ? `ghost_stale_jobs:${jobs}` : 'ghost_no_job',
    };
  }

  return { state: 'idle', reason: jobs > 0 ? `idle_stale_jobs:${jobs}` : 'no_run_no_job' };
}

/** 该状态词是否属 running 族（供调用方与 `deriveExecState` 共用一把尺，不再手抄名单）。 */
export function isRunningFamily(status: string | null | undefined): boolean {
  return RUNNING_FAMILY.has(String(status ?? '').trim());
}

/**
 * 恢复入口的**动作**（纯函数，`resume-ai-task` 处理器只照它办，不再自己看状态词）：
 *
 *   · `skip_live`     —— 真有在途 run：本次恢复会让同一件事跑两遍（历史上"点了没反应"的反面）。
 *   · `skip_terminal` —— 终态不复活（与既有守卫同义）。
 *   · `yield_sibling` —— 同任务还有别的执行作业在排队：本次是队列里靠前的那一条，让位给排在后面的
 *                        那条，才用得上**最新的**那句话（两条都跑不了两件不同的事，先跑只会让后者
 *                        一起来就看见 `live` 而被跳过）。
 *   · `ghost`         —— 状态词写着在跑、实则无执行体：**必须往下走**，但要按上限自动接管并留痕。
 *   · `proceed`       —— 其余（`idle`，以及只挂着 running 作业行却无在途 run 的 `queued`：
 *                        那正是幽灵的另一面，继续往下走由 CAS 兜住双跑）。
 *
 * `pendingExecJobs` 单独入参而**不**从 verdict 里推：`state==='queued'` 两个来源（pending 与 running）
 * 在这一问上处置相反，而 verdict 只是一个词。
 */
export type ResumeAction = 'skip_live' | 'skip_terminal' | 'yield_sibling' | 'ghost' | 'proceed';

export function resumeAction(v: ExecStateVerdict, pendingExecJobs: number): ResumeAction {
  if (v.state === 'live') return 'skip_live';
  if (v.state === 'terminal') return 'skip_terminal';
  if (v.state === 'ghost') return 'ghost';
  if (v.state === 'queued' && Math.max(0, Number(pendingExecJobs) || 0) > 0) return 'yield_sibling';
  return 'proceed';
}
