/**
 * zx_20261022_2 批三（毛选·矛盾论）: 孤立刻 `running` 的周期对账。
 *
 * 病根：`TaskScheduler.start()` 的对账只在**进程启动时**跑一次（`zx_20260907 M5`）。
 * 运行期的任务是"状态行写了 running、却没有执行作业消费"的僵尸时，只等重启这**一次偶然**——
 * 真库 `0ba7a0d4` 的两个 M1 子任务正是这样躺到重启才被救起。
 *
 * 判据只认 `running`，**不碰 `executing`**：后者是执行体已认领的态，误判会双跑。
 * `hasPendingExecutionJob` 取既有真源（`task-jobs.ts`），不在此手抄载荷匹配式。
 */
import { hasPendingExecutionJob, type TaskJobDb } from './task-jobs.js';
import { utcSql } from './sql-time.js';

export interface OrphanRunningTask {
  id: string;
  project_id: string | null;
}

/**
 * 找出「status='running' ∧ 无在途执行作业 ∧ 已过宽限窗」的任务（**只找不动**）。
 *
 * @param graceMinutes 宽限分钟数；`0`/缺省表示不设时间约束（启动对账用——进程刚起，
 *   时间不是判据，缺作业才是）。周期对账传 2：刚被置 running、作业尚在途中者不得误判。
 */
export function findOrphanRunningTasks(db: TaskJobDb, graceMinutes = 0): OrphanRunningTask[] {
  const minutes = Math.max(0, Math.floor(Number(graceMinutes) || 0));
  const timeFilter = minutes > 0 ? ` AND ${utcSql('t.updated_at')} < datetime('now', ?)` : '';
  const params: unknown[] = minutes > 0 ? [`-${minutes} minutes`] : [];
  const rows = db.prepare(
    `SELECT t.id, t.project_id FROM wa_tasks t WHERE t.status = 'running'${timeFilter}`
  ).all(...params) as OrphanRunningTask[];
  return rows.filter(t => !hasPendingExecutionJob(db, t.id));
}
