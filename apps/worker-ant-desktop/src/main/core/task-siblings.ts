/**
 * zx_20261116_1 M6「序」：同父**在途**兄弟——派生修复任务的串行边界。
 *
 * 病根（真事故 2026-11-16）：报告子任务 `7e60cf1c` 收口时派生的修复任务 `9e1e31f5` 只把“报告任务”
 * 当前置；同父的另一个子任务 `72319f17` 当时仍在跑（09:17:19–09:22:50），二者可同时改同一份方案文档。
 * 本次未实际冲突（时间上错开），但风险真实存在。
 *
 * 口径（窄版，刻意不扩大）：
 *   · 只串**在途**兄弟：`executing/preparing/planning/running/stabilizing`——它们才可能正在动手；
 *   · `pending` 尚未动手，`paused/failed/archived` 已在等人处置，不纳入（否则派生任务可能被永久拖住）；
 *   · 无父（根任务）或读库失败 ⇒ 空数组（回旧行为，不因一次读失败把修复任务永久卡住）。
 *
 * 零 electron 依赖；rr 可直引。
 */

export interface SiblingDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** “在途”状态集：可能正在改同一棵工作树。与 `task-chain.CHAIN_BUSY_STATUSES` 同源语义，另加稳定观察态。 */
export const IN_FLIGHT_SIBLING_STATUSES = ['executing', 'preparing', 'planning', 'running', 'stabilizing'] as const;

export function inFlightSiblingIds(db: SiblingDb, taskId: string): string[] {
  try {
    const row = db.prepare('SELECT parent_task_id FROM wa_tasks WHERE id = ?').get(taskId) as { parent_task_id?: string | null } | undefined;
    const pid = row?.parent_task_id;
    if (!pid) return [];
    const ph = IN_FLIGHT_SIBLING_STATUSES.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id FROM wa_tasks WHERE parent_task_id = ? AND id != ? AND status IN (${ph}) ORDER BY created_at ASC`,
    ).all(pid, taskId, ...IN_FLIGHT_SIBLING_STATUSES) as Array<{ id?: unknown }>;
    return rows.map((r) => String(r.id ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}
