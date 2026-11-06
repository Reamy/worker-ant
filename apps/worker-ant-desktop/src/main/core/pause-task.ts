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
import { PAUSE_REASON_CHILDREN_INCOMPLETE, PAUSE_REASON_POLICY_PAUSED, pauseReasonLabel, pauseSettlesParent } from './pause-reason.js';
import { isTerminalStatus } from './task-jobs.js';
import { markGoalNotAchieved } from './task-outcome.js';

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

export interface PauseTaskResult {
  /** 状态行是否真被这次调用写成 `paused` */
  changed: boolean;
  /** 未写的原因（仅 `terminal`：目标已是 completed/failed/archived，拒绝覆写） */
  skipped?: 'terminal';
}

/**
 * 置任务为 `paused`，并**同时**落因、发事件、（按需）告知创建人。
 *
 * 顺序（不可换）：**先改库、后发事件**——事件订阅者（GUI/通知）收到事件即回查库，
 * 库未落笔则读到旧态（本仓既有纪律："先落库、后发事件"）。
 */
export function pauseTask(db: Database.Database, opts: PauseTaskOptions): PauseTaskResult {
  const { taskId, reason, note, extraContext } = opts;
  const row = db.prepare('SELECT project_id, context_json, status FROM wa_tasks WHERE id = ?').get(taskId) as
    | { project_id?: string | null; context_json?: string | null; status?: string }
    | undefined;

  // zx_20261021_2 D2（知止）：**终态不可覆写**。此前本函数无条件 `UPDATE … status='paused'`，
  //   真库事故：`9cc5bb81` 已于 03:46:19 归档，收尾段仍把它改成 `paused`；`58c60680` 同理被改成
  //   `completed`（另一处写口）。`archived` 的用法是"这件事了结了"，不是"再挂起等恢复"。
  //   ⚠ 只挡**写入**，不挡 abort：调用方（如 `interruptTask`）若拿到的任务已终态，仍应中止在途 run。
  if (isTerminalStatus(row?.status)) {
    return { changed: false, skipped: 'terminal' };
  }

  let ctxJson: string;
  try {
    const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
    ctx.pause_reason = reason;
    if (extraContext) Object.assign(ctx, extraContext);
    // zx_20261023_2 批三（「知止」）：**暂停即目标未达成**，两处账同置 false。
    //   病根：收尾段先按分数写 `goal_achieved=true`，之后才因「子未完成 / 验收未判」暂停——
    //   暂停不回改账，于是同一行里「已达成」与「paused」并存。收在这里（唯一暂停写入口）一次盖住
    //   所有暂停因（含以后新增的），不必在每个暂停点各补一刀。
    markGoalNotAchieved(ctx);
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

  // zx_20261022_3 批十二（信·名实）：**暂停 = 已停**，编排层必须知情。
  //   · 引擎判定的定局暂停（验收未过/低于标准/工具循环…）⇒ 唤醒父任务复核子结局；
  //   · 因等子而暂停 ⇒ 若未完成子**已全部暂停**，立即复核自身（否则父停在等子态、子已停、
  //     再无人唤醒——真标本 M2 两个任务从未被拉起）。
  //   ⚠ 动态 import：`jobs/ai-task.ts` 静态引用本模块，静态反向引用即成环；本调用只在落库之后、
  //     失败也只影响"放行父"这一跳，不推翻本次暂停（与 `task-terminal-release` 的失败纪律同尺）。
  if (pauseSettlesParent(reason) || reason === PAUSE_REASON_CHILDREN_INCOMPLETE) {
    void import('./task-terminal-release.js')
      .then((m) => {
        if (pauseSettlesParent(reason)) {
          try { m.afterTaskSettled(db, taskId); } catch { /* 放行父失败不推翻暂停 */ }
        }
        if (reason === PAUSE_REASON_CHILDREN_INCOMPLETE) {
          try { m.reevaluateSelfWhenWaitingOnChildren(db, taskId); } catch { /* 复核失败同上 */ }
        }
      })
      .catch(() => { /* 模块加载失败：本次暂停照旧成立，只是少一次自动放行 */ });
  }
  return { changed: true };
}
