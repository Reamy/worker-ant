/**
 * zx_20261111_3 「显」——任务**终态词表与判据**的零依赖落点。
 *
 * 病根（GUI 目视照出，2026-11-11）：`TaskDetailPage` 为取 `isTerminalStatus` 而 import 了
 *   `core/task-jobs.ts`；后者在**模块求值期**执行 `const logger = createLogger(...)`，而
 *   `core/logger.ts` 顶层读 `process.env` / `process.cwd()` —— 渲染进程**没有 `process`**
 *   ⇒ 任务详情页整页白屏（`ReferenceError: process is not defined`）。这是自 `zx_20261029_3`
 *   引入该 import 起就埋着的隐患，只是直到本轮重建渲染包才被照出来。
 *
 * 治法：把**纯判据**搬到这个零依赖模块（不引 logger / electron / better-sqlite3），
 *   `task-jobs.ts` 原样转出（main 侧调用点一字不改），渲染层改从这里取。
 *   判据只有一份实现，位置更"下层"——词表与"跑没跑"的机制解耦。
 */

/** 终态：这三态之下任务不再被 execution 作业拉起。 */
export const TERMINAL_STATUSES = ['completed', 'failed', 'archived'] as const;

/** 该状态是否终态。`undefined`/空串按"非终态"论（查不到行时不冒认终态）。 */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return !!status && (TERMINAL_STATUSES as readonly string[]).includes(status);
}
