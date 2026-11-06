/**
 * zx_20261029_3 M4「列表层四个账说清」的**判据唯一真源**（纯函数，零 React）。
 *
 * 列表一行只贴一个账徽标（互斥优先级：未设验收 > 验收未过 > 待你回复 > 自动派生），
 * 外加「★ 旁自评小字」——两处都按 `completion_quality.via` 的来路分。
 *
 * 抽到 `lib/` 是为了**可喂标本**：受控回归能用正/反标本直接跑判断，
 * 而不是拿 grep 冒充"四个徽标都验过"（本仓反复踩过的"断言名冒充覆盖面"）。
 */

export interface TaskBadgeView {
  status: string;
  acc_total?: number | null;
  acc_passed?: number | null;
  context_digest?: string | null;
}

export interface BadgeSpec {
  text: string;
  cls: string;
  title: string;
}

function ctxOf(t: TaskBadgeView): Record<string, unknown> {
  try { return JSON.parse(t.context_digest || '{}') as Record<string, unknown>; } catch { return {}; }
}

/** paused 且带 awaiting_input / pending_approval = 在等用户回复/审批（不是手动暂停）。 */
export function isAwaitingReplyTask(t: TaskBadgeView): boolean {
  if (t.status !== 'paused') return false;
  const c = ctxOf(t);
  return !!(c.awaiting_input || c.pending_approval);
}

/** 一行一个账徽标；没有该说的账就返回 null（不贴空徽标）。 */
export function accountBadgeTask(t: TaskBadgeView): BadgeSpec | null {
  const total = Number(t.acc_total) || 0;
  const passed = Number(t.acc_passed) || 0;
  if (t.status === 'completed' && !(total > 0)) {
    return { text: '未设验收', cls: 'bg-gray-100 text-gray-500', title: '创建时未设验收标准——「已完成」不等于「已验收」' };
  }
  if (t.status === 'completed' && passed < total) {
    return { text: `验收 ${passed}/${total}`, cls: 'bg-red-100 text-red-600', title: '账上验收有判据未达成——「已完成」不等于「已验收」，详见详情页' };
  }
  if (isAwaitingReplyTask(t)) {
    return { text: '待你回复', cls: 'bg-orange-100 text-orange-700', title: '任务在等你回复/审批后才会继续' };
  }
  if (ctxOf(t).verification_fix) {
    return { text: '自动派生', cls: 'bg-cyan-50 text-cyan-700', title: '引擎验收发现问题后自动立项的修复任务' };
  }
  return null;
}

/**
 * ★ 旁的「自评」小字：**只有收口自评**（`finalize_task`）才标。
 * `run_close` 是引擎跑真验收后的分，不得冒充自评；没有 quality 就没有这行小字。
 */
export function isSelfAssessedQuality(t: TaskBadgeView): boolean {
  const q = ctxOf(t).completion_quality as { score?: number; via?: string } | undefined;
  return q?.score != null && q?.via === 'finalize_task';
}
