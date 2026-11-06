/**
 * 「在途 run 的中断控制器」注册表——**零依赖**（不 import 任何 core 模块）。
 *
 * ## 为什么单独成模块（zx_20261021_2 D1）
 *
 * 实测事故：任务 `9cc5bb81` 于 `03:46:19` 被归档，执行体一直跑到 `03:51:12`（**归档后仍走 87 步**），
 * 收口时又把 `archived` 覆写成 `paused`。根因是 `archiveTask` **只改库、不碰执行体**，而执行体每步
 * 只认 `paused` 这一个信号（`exec-step.ts`）。
 *
 * 要让"归档"这一笔真正传到执行体，`task-archive.ts` 必须能拿到 `agent-executor.ts` 里那张
 * `Map<taskId, AbortController>`。若直接 import，就形成
 * `task-archive → agent-executor → …→ task-archive` 的静态环（本仓明令避免）。
 * 故把这张表抽成**无依赖的第三方模块**，两侧都只依赖它。
 *
 * ## 约定
 *
 * - 键是 `taskId`（同一任务在任一时刻至多一条在途 run；重跑时后者覆盖前者）。
 * - `abortTaskRun` **不抛**：abort 是副作用，调用方（归档）已经落完库，不能因它失败而回滚事实。
 * - `unregisterTaskRun` 只删**自己那一个** controller（传 controller 比对），避免旧 run 的
 *   `finally` 把新 run 的注册项删掉（resume/重试与上一轮收尾交叠时会撞上）。
 */

const runs = new Map<string, AbortController>();

/** run 开跑时登记（`executeTask` 内、创建 controller 之后立即调用）。 */
export function registerTaskRun(taskId: string, controller: AbortController): void {
  runs.set(taskId, controller);
}

/** run 收尾时注销。传 controller 则只在**仍是自己**时才删（新 run 的注册不被旧 run 误删）。 */
export function unregisterTaskRun(taskId: string, controller?: AbortController): void {
  if (!controller || runs.get(taskId) === controller) runs.delete(taskId);
}

/**
 * 中止某任务的在途 run。返回是否真有在途 run 被中止（`false`＝此刻没有执行体在跑，正常）。
 * 文案由调用方给：执行体 catch 分支按关键字分派（`status_terminal:` / `interrupt` / …）。
 */
export function abortTaskRun(taskId: string, message: string): boolean {
  const ctrl = runs.get(taskId);
  if (!ctrl) return false;
  try {
    ctrl.abort(new Error(message));
    return true;
  } catch {
    return false;
  }
}

/** 是否有在途 run（诊断/断言用）。 */
export function hasTaskRun(taskId: string): boolean {
  return runs.has(taskId);
}
