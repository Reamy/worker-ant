/**
 * 「置暂停」的**唯一写入口**——状态 / 因 / 事件 / 告知，一次写全。
 *
 * 为什么需要它：zx_20260917 M0 实测，全量 `src/main` 下 24 处 `UPDATE wa_tasks SET status = 'paused'`
 * 直写点里 **20 处不写因**（另 2 处经变量写状态、字面扫描看不见），于是：
 *   - `wa_event_log` 里 97 条暂停事件 **89 条 `reason` 为空** —— 人或调度器都不知道该等、还是该救；
 *   - `pause-reason.ts` 开篇自称「一处真源」成了一句空话：写点根本不从它取。
 *
 * 本函数把这些写点收成一个语义化入口，`reason` **必填**（取值域 `PauseReason`）——
 * 「无因暂停」在类型层**不可表达**。此后凡绕过本函数直写 `status='paused'` 的即算回归
 * （判据见 `scripts/rr_zx_20260917.ts`）。
 *
 * 为什么**不**落在 `pause-reason.ts`：那里是"因"的**词表**，且已被 `task-notice.ts` 静态引用；
 * 而本模块必须静态引用 `im/im-notify.ts`（→ `task-notice.ts`），放一起即形成
 * `pause-reason → task-notice → pause-reason` 静态环（本仓既有纪律：能避的静态环一律避）。
 * 词表仍只此一份（`pause-reason.ts`），本模块只做"写"。
 *
 * 为什么**不**收 `projectId` 形参：本函数本就要读该任务行取 `context_json`，`project_id` 从**同一行**取即可；
 * 调用方转述与账各说各话正是本仓反复治过的病（同 `buildTaskNotice` 的"**不信任调用方的转述**"）。
 */
import type Database from 'better-sqlite3';
import { eventBus } from './event-bus.js';
import { markPauseNeeded } from './im/im-notify.js';
import type { PauseReason } from './pause-reason.js';
import { PAUSE_REASON_POLICY_PAUSED, pauseReasonLabel } from './pause-reason.js';

export interface PauseTaskOptions {
  taskId: string;
  /** 因由码（**必填**）——写进 `context_json.pause_reason` 与 `task.status_changed` 的 `reason` */
  reason: PauseReason;
  /**
   * 人话因由。**传即告知创建人**（`markPauseNeeded`，与既有 13 个暂停点同形）；不传则**除下面这一例外**不告知。
   *
   * ⚠ 这个"传即告知"的语义是为了**逐字保持既有行为**：哪些暂停该告知属"告"面（M2）的裁定范围，
   *   本批只治"录"面，不擅自增删通知（否则会与 M2 判据 C-2「一次停只发一条」打架）。
   *
   * ⚠ **例外（zx_20261012_2 批五 M5）**：`reason === PAUSE_REASON_POLICY_PAUSED` 时，`note` 缺省
   *   **自带一句因由**（文案由 `pause-reason.ts` 单一真源派生），使下面 `if (note)` 那一跳**真触发**。
   *   病根：熔断器喊停是本系统**自己**做的决定，最该让人知道，而它此前恰恰是唯一从不传 `note` 的调用点
   *   （`exec-model-select.ts` 那处 `pauseTask(...)`）⇒ 策略暂停静默无通知，用户实机"很多暂停、IM 一条没有"
   *   的一支。这不是"增删通知面"（其余 13 个暂停点逐字不变），而是**把漏传的那一个补上**。
   */
  note?: string;
  /** 额外要一并落进 `context_json` 的键（如 `run_mutations`、`pause_note`） */
  extraContext?: Record<string, unknown>;
}

/**
 * 置任务为 `paused`，并**同时**落因、发事件、（按需）告知创建人。
 *
 * 顺序（不可换）：**先改库、后发事件**——事件订阅者（GUI/通知）收到事件即回查库，
 * 库未落笔则读到旧态（本仓既有纪律："先落库、后发事件"）。
 */
export function pauseTask(db: Database.Database, opts: PauseTaskOptions): void {
  const { taskId, reason, note, extraContext } = opts;
  const row = db.prepare('SELECT project_id, context_json FROM wa_tasks WHERE id = ?').get(taskId) as
    | { project_id?: string | null; context_json?: string | null }
    | undefined;

  let ctxJson: string;
  try {
    const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
    ctx.pause_reason = reason;
    if (extraContext) Object.assign(ctx, extraContext);
    ctxJson = JSON.stringify(ctx);
  } catch {
    // 账不是合法 JSON：**不因"写不进账"而放弃"落停"**——状态留在 executing 比丢一份坏账严重得多。
    // 退化为最小账（坏账本就解析不出来，保不住）；下一位写者会把它覆盖回正常形态。
    ctxJson = JSON.stringify({ pause_reason: reason });
  }
  db.prepare("UPDATE wa_tasks SET status = 'paused', updated_at = datetime('now'), context_json = ? WHERE id = ?")
    .run(ctxJson, taskId);

  eventBus
    .emit('task.status_changed', {
      taskId,
      task_id: taskId,
      projectId: row?.project_id ?? null,
      newStatus: 'paused',
      new_status: 'paused',
      reason,
    })
    .catch(() => {});

  // 批五 M5: `policy_paused`（熔断器喊停）**自带一句因由**——它是本系统自己做的决定，最该让人知道，
  //   却恰恰是唯一从不传 `note` 的调用点 ⇒ 那一跳恒不触发、策略暂停静默无通知（见 `PauseTaskOptions.note`）。
  //   其余因由维持"传即告知"（逐字不变）。
  const effectiveNote = note ?? (reason === PAUSE_REASON_POLICY_PAUSED ? pauseReasonLabel(reason) : undefined);
  if (effectiveNote) markPauseNeeded(db, taskId, effectiveNote);
}
