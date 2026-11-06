/**
 * zx_20261027_2 M2：「删除任务」清的是**一棵子树**，不是一行。
 *
 * 病根（实机）：`task:delete` 只删根行，`wa_tasks.parent_task_id` 又无外键 ⇒ 子任务既没被删、
 * 也没了父，列表里只能按"孤儿"顶到根级显示。删除的语义是"这摊活不要了"，不是一个节点不要了。
 *
 * 裁决：
 *   - **终态才可删**（`isTerminalStatus`）。子树里只要有一个还在 pending/executing/paused…，
 *     整棵都不删并如实点名——删一个正在跑的节点，等于让在途作业写一个已亡的任务。
 *   - **一个事务内完整清账**：对话/产出物/版本/记忆墓碑/通知/作业与该任务行，逐任务照旧清（含子树每个 id）。
 *   - **不做事后"放行父任务"**：能被删的子树成员本就已是终态，其父在该成员转终态那一刻已经问过
 *     （`afterTaskTerminalStatus`）；再问一次只会在"父已恢复/已入队"时重复入队。宁可少问，不可重问。
 *
 * 与 `task-jobs.ts` 同一手法：只声明最小 prepare 接口，可脱 electron 用内存真库跑受控回归。
 */
import { isTerminalStatus, type TaskJobDb } from './task-jobs.js';
import { MEM_DELETE_REASONS, tombstoneMemoriesBy } from './memory-lifecycle.js';

export interface TaskDeleteBlocker {
  id: string;
  title: string;
  status: string;
}

export type TaskDeleteResult =
  | { ok: true; deletedIds: string[] }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'has-unsettled'; blockers: TaskDeleteBlocker[] };

interface TaskRow {
  id: string;
  title: string;
  status: string;
}

/**
 * 根任务 + 全部后代（任意层）。`UNION`（非 `UNION ALL`）兼作环保护：
 * 万一 `parent_task_id` 被改出环，递归停在首次重复的 id 上，而不是把主进程转死。
 */
export function collectTaskSubtree(db: TaskJobDb, rootId: string): TaskRow[] {
  return db.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM wa_tasks WHERE id = ?
       UNION
       SELECT t.id FROM wa_tasks t JOIN sub ON t.parent_task_id = sub.id
     )
     SELECT t.id AS id, t.title AS title, t.status AS status
       FROM wa_tasks t JOIN sub ON t.id = sub.id`
  ).all(rootId) as TaskRow[];
}

/** 清一个任务的全部关联账（顺序即约束顺序：先子表再任务行，墓碑先于行删除）。 */
function deleteOneTask(db: TaskJobDb, id: string): void {
  const dIds = (db.prepare('SELECT id FROM wa_deliverables WHERE task_id = ?').all(id) as Array<{ id: string }>)
    .map((r) => r.id);
  db.prepare('DELETE FROM wa_task_conversations WHERE task_id = ?').run(id);
  if (dIds.length > 0) {
    db.prepare(`DELETE FROM wa_deliverable_versions WHERE deliverable_id IN (${dIds.map(() => '?').join(',')})`)
      .run(...dIds);
  }
  db.prepare('DELETE FROM wa_deliverables WHERE task_id = ?').run(id);
  // 须在 `DELETE FROM wa_tasks` 之前：tombstoneMemoriesBy 要先按 task_id 取到记忆行。
  tombstoneMemoriesBy(db, 'task_id', id, MEM_DELETE_REASONS.taskCascade);
  db.prepare('DELETE FROM wa_notifications WHERE task_id = ?').run(id);
  db.prepare("DELETE FROM wa_jobs WHERE payload LIKE '%' || ? || '%'").run(id);
  db.prepare('DELETE FROM wa_tasks WHERE id = ?').run(id);
}

/**
 * 删除 `rootId` 及其全部后代。调用方须包在一个事务里（本函数逐行改库，不自开事务）。
 * 任一成员非终态 ⇒ **整棵不删**，返回阻断名单（不部分删除）。
 */
export function deleteTaskSubtree(db: TaskJobDb, rootId: string): TaskDeleteResult {
  const rows = collectTaskSubtree(db, rootId);
  if (rows.length === 0) return { ok: false, reason: 'not-found' };
  const blockers = rows
    .filter((r) => !isTerminalStatus(r.status))
    .map((r) => ({ id: r.id, title: r.title, status: r.status }));
  if (blockers.length > 0) return { ok: false, reason: 'has-unsettled', blockers };
  for (const r of rows) deleteOneTask(db, r.id);
  return { ok: true, deletedIds: rows.map((r) => r.id) };
}
