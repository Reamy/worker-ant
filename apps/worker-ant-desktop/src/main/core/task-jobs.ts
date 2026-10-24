/**
 * zx_20260917 M5：任务-执行作业一致性的四个纯 DB 谓词（原住 `task-scheduler.ts`）。
 *
 * 迁出理由（不是搬着好玩的）：`core/task-chain.ts` 的"链上至多一个在跑"判据要用
 * `hasPendingExecutionJob`，而它原在 `task-scheduler.ts` 内 —— `task-scheduler` 又要反过来引
 * `task-chain`（拉起前问一句），直接互引即成**循环**。四个谓词只依赖一个最小 db 接口、
 * 不碰调度器任何内部状态，故提到本模块，两侧共用**同一份**实现（一处真源）。
 *
 * 与 `task-accounting.ts` 同一手法：只声明最小的 prepare 接口，使本模块可脱 electron，
 * 在受控回归里用内存库跑**真** SQL，而非在测试里复刻判据（复刻的断言只是自我印证）。
 */

/** 仅需 prepare().run()/.get()/.all() 的最小库接口 */
export interface TaskJobStmt {
  run(...args: unknown[]): { changes?: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
export interface TaskJobDb {
  prepare(sql: string): TaskJobStmt;
}

/** 执行类作业类型——"这个任务是否已有在途执行作业"只认这两类（post 类 background-review 不算）。 */
export const EXEC_JOB_TYPES = ['ai-task', 'resume-ai-task'] as const;

/**
 * 执行作业载荷里定位 taskId 的匹配式——**唯一真源**。
 *
 * 载荷是 JSON 串，故用 `"taskId":"<id>"` 作子串匹配（既有的、被四个谓词沿用的写法）。
 * 抽成函数是为了不再有第 2、3 份手抄：此处改一处，四个谓词与 `task-chain` 的批量探测同时改。
 */
export function execJobPayloadLike(taskId: string): string {
  return `%"taskId":"${taskId}"%`;
}

/**
 * 任务终态三元组——**唯一真源**（zx_20261021_2 D2/D3 收口）。
 *
 * 此前这个三元组以字面量散在执行体、暂停写口、编排工具各处；`pauseTask` 与 `update_task_status`
 * 都**没有**它 ⇒ 已归档/已完成的任务能被后续流程改写成 `paused`（真库事故 `9cc5bb81` / `58c60680`）。
 * 现统一从此取；本模块零 import，故任何 core 模块引用它都不会成环。
 */
export const TERMINAL_STATUSES = ['completed', 'failed', 'archived'] as const;

/** 该状态是否终态。`undefined`/空串按"非终态"论（查不到行时不冒认终态）。 */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 任务是否已终态（completed/failed/archived）——终态任务不应再被 execution 作业拉起 */
export function isTerminalTask(db: TaskJobDb, taskId: string): boolean {
  try {
    const r = db.prepare("SELECT status FROM wa_tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
    return !!r && isTerminalStatus(r.status);
  } catch { return false; }
}

/** 该任务是否已有待执行/执行中的执行作业（ai-task/resume-ai-task）——用于重复 enqueue 去重 */
// zx_20260908 M10(实机复核): 纳入 status='running'——此前只认 pending，首个作业被 processPending 标 running 后，
// 第二个入队不被拦截 → 同任务 ai-task+resume 并发双跑(实机 B 任务见 ai-task 05:36 + resume 05:38 双 running、finalize 反复被拒/翻转)。
export function hasPendingExecutionJob(db: TaskJobDb, taskId: string): boolean {
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS c FROM wa_jobs WHERE status IN ('pending','running') AND type IN (${EXEC_JOB_TYPES.map(() => '?').join(',')}) AND payload LIKE ?`
    ).get(...EXEC_JOB_TYPES, execJobPayloadLike(taskId)) as { c: number };
    return r.c > 0;
  } catch { return false; }
}

/** 终态时清理该任务残留的 pending/running 执行作业（杀"幽灵作业"；保留 done 历史与 post 类 background-review） */
export function cleanupTaskExecutionJobs(db: TaskJobDb, taskId: string): void {
  try {
    db.prepare(
      `UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = 'superseded_by_terminal' WHERE status IN ('pending','running') AND type IN (${EXEC_JOB_TYPES.map(() => '?').join(',')}) AND payload LIKE ?`
    ).run(...EXEC_JOB_TYPES, execJobPayloadLike(taskId));
  } catch { /* best-effort */ }
}

/**
 * 显式作废该任务遗留/并发的执行作业（zx_20260909 Q2 修：resume 静默去重死锁根治）。
 * 旧逻辑：task:resume 若 hasPendingExecutionJob 命中(历史遗留 pending/running)即静默 skip——
 *   状态不置 pending、也不入队 → "回复并恢复"点了没反应、任务永远停在 paused。
 * 新逻辑：用户显式恢复时，凡该任务残留的 pending|running 执行作业一律作废(任务既已 paused/failed，
 *   任何残留作业都是过期幽灵——真在跑的 executeTask 早已把任务置 executing，resume 入口进不来)，
 *   然后才置 pending + 入队新作业。保留 done 历史与 post 类 background-review。
 */
export function supersedeExecutionJobs(db: TaskJobDb, taskId: string, reason = 'superseded_by_resume'): void {
  try {
    db.prepare(
      `UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = ? WHERE status IN ('pending','running') AND type IN (${EXEC_JOB_TYPES.map(() => '?').join(',')}) AND payload LIKE ?`
    ).run(reason, ...EXEC_JOB_TYPES, execJobPayloadLike(taskId));
  } catch { /* best-effort */ }
}
