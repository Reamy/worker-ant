/**
 * 「归档（放弃）」这一终态的**唯一写入口**——状态 / 因 / 账页 / 事件，一次写全。
 *
 * ## 治的病：`failed` 一个名字装了两件事（zx_20261012_2 批二）
 *
 * 「放弃」此前**没有自己的状态**：GUI 子任务族卡上的「放弃」按钮走 `task:updateStatus` 把它标成
 * **`failed`**（`reason:'abandoned_by_user'`）。于是两种**语义完全不同**的事挤进同一个值：
 *   - **真失败**：引擎/模型跑砸了——读者（复盘、告警、用户）该按「教训」处理；
 *   - **主动放弃**：人或编排决定"这单不要了"——该按「已了结、可放下」处理。
 *
 * 挤成一态的直接病灶：收口闸 `failedChildren`（`children-gate.ts`）只认 `status='failed'`，
 * 于是用户**主动弃掉**的子任务被当成"失败子"**挡住父任务收口**（明明是"处置过了"）；
 * 而 `failed` 又进 `REVIEWABLE_STATUSES`（被当作"值得复盘的教训"）——弃掉的任务被拿去总结教训。
 *
 * ## 为什么必须成态、必须一处写
 *
 * `completed|failed|archived` 这个收口闸的终态三元组**早已写在引擎各处**（`task-jobs.isTerminalTask`、
 * `checkParentTaskAfterChildDone` 的 `status NOT IN ('completed','failed','archived')`、
 * `children-gate` 注释、`task-terminal-release` 头注释）——**代码早就在等这一态**，
 * 只是 `TaskStatus` 类型里没有它、也没有一个把它**写全**（状态 + 因 + 翻账页 + 事件）的入口。
 * 纯 `UPDATE … SET status='archived'` 会重犯 `pause-task.ts` 头注释里那条旧病：
 * 状态改了、因没落、账页没翻（`completion_quality` 还留着上一次 run 的判分）。
 *
 * ## 与 `pauseTask` 的分工（两者都是"非完成终态"，但两码事）
 *
 * | | `paused` | `archived` |
 * |---|---|---|
 * | 语义 | **等**——等人恢复，任务还有下文 | **了结**——主动弃，没有下文了 |
 * | 读点 | 可恢复、可派子（`PARENT_INTERRUPTED_PAUSE_REASONS`） | 不恢复、不派子、不计入失败子 |
 *
 * 故两条口刻意**不合并**：合成一条就得带一个布尔开关去分叉，那正是"一个名字装两件事"的复发。
 *
 * ## 与 `pause-task.ts` 的形制一致处
 *
 * 先改库、后发事件（事件订阅者回查库时不读到旧态）；`reason` 落 `context_json` 的新键
 * `archive_reason`（键名常量一处）；`expectStatus` 走 CAS 保"扫描与写入之间已被别的路处置"的幂等。
 *
 * **为什么不发 IM**：归档是**人主动**的动作（GUI 点「放弃」/ 编排工具显式弃单），不是"出事了要喊人"；
 * 与 `pauseTask` 的"传 `note` 才告知"同向——此处连 `note` 都不收，"弃"本身即当事人自己的决定，无需回告。
 */
import { eventBus } from './event-bus.js';
import { turnAccountPage, type TaskTerminalDb } from './task-terminal.js';

/** 归档因由落在 `context_json` 的键名——**只此一处**，读写方皆从这里取。 */
export const ARCHIVE_REASON_KEY = 'archive_reason';

export interface ArchiveTaskOptions {
  taskId: string;
  /** 人话因由（可选）。写进 `context_json.archive_reason`，并随 `task.status_changed` 的 `reason` 出事件。 */
  reason?: string;
  /** 只在目标任务此刻仍是该状态时才翻（CAS）。不传则无条件翻（幂等：已 archived 再翻只有一次 `changes>0`）。 */
  expectStatus?: string;
}

export interface ArchiveTaskResult {
  /** 状态行是否真被这次调用翻到 `archived`（CAS 未命中 ⇒ false，调用方据此跳过后续收尾） */
  changed: boolean;
  /** 是否真翻了账页（无可清 ⇒ false，库里没动） */
  pageTurned: boolean;
}

/**
 * 把任务落到 `archived` 终态：改状态 + 落因 + 翻掉上一次 run 的判卷 + 发事件。
 *
 * 顺序（不可换）：**先落库、后发事件**——订阅者收到事件即回查库，库未落笔则读到旧态。
 */
export function archiveTask(db: TaskTerminalDb, opts: ArchiveTaskOptions): ArchiveTaskResult {
  const { taskId, reason, expectStatus } = opts;
  const row = db.prepare('SELECT project_id, context_json FROM wa_tasks WHERE id = ?').get(taskId) as
    | { project_id?: string | null; context_json?: string | null }
    | undefined;

  let ctxJson: string | null = null;
  if (reason) {
    try {
      const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
      ctx[ARCHIVE_REASON_KEY] = reason;
      ctxJson = JSON.stringify(ctx);
    } catch {
      // 账不是合法 JSON：**不因"写不进账"而放弃"落归档"**——状态留在旧态比丢一份坏账严重得多。
      ctxJson = JSON.stringify({ [ARCHIVE_REASON_KEY]: reason });
    }
  }

  let changed = false;
  try {
    const where = expectStatus ? ' WHERE id = ? AND status = ?' : ' WHERE id = ?';
    const whereArgs: unknown[] = expectStatus ? [taskId, expectStatus] : [taskId];
    const sql = ctxJson
      ? `UPDATE wa_tasks SET status = 'archived', updated_at = datetime('now'), context_json = ?${where}`
      : `UPDATE wa_tasks SET status = 'archived', updated_at = datetime('now')${where}`;
    const res = ctxJson ? db.prepare(sql).run(ctxJson, ...whereArgs) : db.prepare(sql).run(...whereArgs);
    changed = ((res as { changes?: number })?.changes ?? 0) > 0;
  } catch {
    return { changed: false, pageTurned: false };
  }
  if (!changed) return { changed: false, pageTurned: false };

  // 翻页：作废也须翻掉上一次 run 的判卷（与"凡终态必同形"同一条尺），否则 `project-analytics`
  //   仍按旧 `quality_score` 把已弃任务计入项目均质。
  const pageTurned = turnAccountPage(db, taskId);

  eventBus
    .emit('task.status_changed', {
      taskId,
      task_id: taskId,
      projectId: row?.project_id ?? null,
      newStatus: 'archived',
      new_status: 'archived',
      ...(reason ? { reason } : {}),
    })
    .catch(() => {});

  return { changed: true, pageTurned };
}
