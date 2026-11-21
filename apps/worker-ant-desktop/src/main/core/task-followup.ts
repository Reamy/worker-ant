/**
 * zx_20261117_1 M5「接」：已完成父任务下的**后补子任务**计数（只读，不重判）。
 *
 * 标本 `b697b767` 于 `a55f9aa6` 完成后 13 分钟挂在其下；父任务仍是 4/4、界面无任何提示。
 * 本函数只数"父完成之后才创建的直接子任务"——**不**触发父任务重判（知止：历史结论不自动改写）。
 *
 * 时间基准须先归一：`wa_tasks.created_at` 是 SQLite `datetime('now')`（`YYYY-MM-DD HH:MM:SS`，UTC），
 * 而完成时刻来自 `completion_quality.at` / `task.completed` 事件（ISO `YYYY-MM-DDTHH:MM:SS.sssZ`）。
 * 直接字符串比大小会在第 10 位 `' ' < 'T'` 上翻错 ⇒ 先截成同形 `YYYY-MM-DD HH:MM:SS`（UTC）。
 */
import type Database from 'better-sqlite3';

export function countChildrenCreatedAfterCompletion(
  db: Database.Database,
  task: Record<string, unknown>,
): number {
  try {
    if (String(task.status ?? '') !== 'completed') return 0;
    let completedAt = '';
    try {
      const ctx = JSON.parse(String(task.context_json ?? '{}')) as { completion_quality?: { at?: unknown } };
      if (typeof ctx.completion_quality?.at === 'string') completedAt = ctx.completion_quality.at;
    } catch { /* 坏 JSON 走事件回退 */ }
    if (!completedAt) {
      const ev = db.prepare(
        "SELECT occurred_at FROM wa_event_log WHERE aggregate_id = ? AND event_type = 'task.completed' ORDER BY occurred_at DESC LIMIT 1",
      ).get(String(task.id ?? '')) as { occurred_at?: string } | undefined;
      completedAt = String(ev?.occurred_at ?? '');
    }
    if (!completedAt) return 0;
    const sqlAt = completedAt.replace('T', ' ').replace(/Z$/, '').slice(0, 19);
    const row = db.prepare('SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = ? AND created_at > ?')
      .get(String(task.id ?? ''), sqlAt) as { c?: number } | undefined;
    return Number(row?.c) || 0;
  } catch {
    return 0; // 读失败如实回 0（不编数；界面只在 >0 时显示徽标）
  }
}
