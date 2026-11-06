/**
 * 「恢复时要不要强制收口」的唯一判据（zx_20261103_1）。
 *
 * 旧行为（`jobs/ai-task.ts` 内联）：根任务（`source='user'`）的子任务全部终态 ⇒ 把本轮恢复消息
 * 换成"整合产出并 finalize"的指令。该判据对系统唤醒（D1 子任务终态放行父）成立；但对
 * **用户从已完成态追加输入**不成立——那一次恢复的消息本身就是人的新指令，换成整合指令等于
 * 把用户的话静默吞掉（`composeResumeInput` 在 forceFinalize 分支替换真实消息）。
 *
 * 故增加一维 `fromCompleted`（由 `task:resume` 在重开已完成任务时置真）：那一次永不强收。
 * 纯函数、零依赖，受控回归直跑真实现，不在测试里复刻判据。
 */

const TERMINAL_CHILD = new Set(['completed', 'failed']);

export interface ForceFinalizeInput {
  /** 任务来源：只有 `user`（根任务）才可能走强收 */
  source: string | null | undefined;
  /** 直接子任务状态；空/缺省 ⇒ 不强收 */
  childStatuses: readonly string[] | null | undefined;
  /** 本次恢复是否来自「已完成任务追加输入」——是则那不是系统收口，而是人的新指令 */
  fromCompleted: boolean;
}

export function shouldForceFinalize(o: ForceFinalizeInput): boolean {
  if (o.fromCompleted) return false;
  if (o.source !== 'user') return false;
  const kids = o.childStatuses ?? [];
  return kids.length > 0 && kids.every((s) => TERMINAL_CHILD.has(s));
}
