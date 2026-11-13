/**
 * zx_20261113_2 M11——目标事件的**如实分型**（零依赖纯模块）。
 *
 * 病根（2026-11-13 真标本）：同一任务 5 个 run 里 `task.goal_identified` 发了 4 次。
 *   `runTaskPrelude` 本身已对 `task_goal` 做缓存（缓存命中不调 LLM），但事件仍叫「identified」——
 *   账上读起来像"每轮都重新识别"，而实际是"复用上轮目标"。同一件事两种说法，复盘就会错判成本。
 *
 * 口径：`reused=true` ⇒ `task.goal_reused`；否则 `task.goal_identified`。
 *   两个事件都进不可变事件日志（`event-bus.ts` 的聚合映射两处都要在，缺一即静默不落库）。
 */
export type GoalEventType = 'task.goal_identified' | 'task.goal_reused';

export function goalEventType(reused: boolean): GoalEventType {
  return reused ? 'task.goal_reused' : 'task.goal_identified';
}
