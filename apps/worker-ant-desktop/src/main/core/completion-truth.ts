/**
 * zx_20261118_2 M6「计」：完成账是否表明「没达成目标」的**零依赖**真源。
 *
 * 病根：`ai-task.ts` 的 `isIncompleteCompletion`（父任务简报用）与
 * `task-accounting.ts` 的子任务完成计数（收口自检用）各判各的——前者把
 * `goal_achieved=false` 读成「完成·未达目标」，后者却把它并进「已完成」，
 * 于是父任务的自检写「所有 5 个子任务已完成」，而其中 1 个是 45 分未达目标
 * （真库标本 `b50aa9e4` / 子 `a7fbd7e0`）。
 *
 * 本模块只读 `context_json` 的完成账，不写库、不发事件、不依赖 electron——
 * `ai-task.ts`（简报）与 `task-accounting.ts`（自检）同引这一份，任何一侧
 * 改判据都只改这里。
 *
 * 口径（与 IM/收口卡片同源）：`completion_quality.premature === true`（被迫收尾）
 * 或 `completion_quality.goal_achieved === false` 任一为真。**没有这笔账**
 * （存量数据 / 未完成子）一律不算未达——不替它补结论。
 */
export function isIncompleteCompletion(ctx: Record<string, unknown>): boolean {
  const q = ctx.completion_quality as { premature?: unknown; goal_achieved?: unknown } | undefined;
  return q?.premature === true || q?.goal_achieved === false;
}
