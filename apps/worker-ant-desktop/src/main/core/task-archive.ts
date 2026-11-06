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
import { abortTaskRun } from './task-run-registry.js';
import {
  PAUSE_REASON_ACCEPTANCE_FAILED,
  PAUSE_REASON_ACCEPTANCE_UNJUDGED,
  recordedPauseReason,
} from './pause-reason.js';

/** 归档因由落在 `context_json` 的键名——**只此一处**，读写方皆从这里取。 */
export const ARCHIVE_REASON_KEY = 'archive_reason';

/** 归档时判卷快照落在 `context_json` 的键名——**只此一处**，读写方皆从这里取。 */
export const ARCHIVED_SNAPSHOT_KEY = 'archived_snapshot';

/**
 * 归档时留下的判卷底账（zx_20261105_1 M3）。
 *
 * `turnAccountPage` 会把上一次 run 的 `acceptance_check`/`completion_quality` 与 `quality_score`
 * 列一并清掉（失败/重试的账页语义不变），但归档之后仍应能复盘"当时判了什么、得了多少分"。
 * 故归档**先留底、再翻页**：快照只含当时**确实存在**的键，不补空对象。
 */
export interface ArchivedSnapshot {
  acceptance_check?: unknown;
  completion_quality?: unknown;
  quality_score?: number;
  archived_at?: string;
  archive_reason?: string;
}

/** 读归档快照；无快照/坏 JSON 返回 null——**不编造**。 */
export function archivedSnapshotOf(contextJson: string | null | undefined): ArchivedSnapshot | null {
  try {
    const s = (JSON.parse(contextJson || '{}') as Record<string, unknown>)[ARCHIVED_SNAPSHOT_KEY];
    return s && typeof s === 'object' && !Array.isArray(s) ? (s as ArchivedSnapshot) : null;
  } catch {
    return null;
  }
}

/** 读归档因由（顶层 `archive_reason`，旧账无此键时回落快照内的同名键）；无记录返回空串。 */
export function archivedReasonOf(contextJson: string | null | undefined): string {
  try {
    const ctx = JSON.parse(contextJson || '{}') as Record<string, unknown>;
    const top = ctx[ARCHIVE_REASON_KEY];
    if (typeof top === 'string' && top.trim() !== '') return top.trim();
    const snap = ctx[ARCHIVED_SNAPSHOT_KEY] as { archive_reason?: unknown } | undefined;
    return typeof snap?.archive_reason === 'string' ? snap.archive_reason.trim() : '';
  } catch {
    return '';
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * 构造/续写归档快照。**首次快照的判卷内容优先**（重复归档只更新时刻与因由，不拿已被清空的现账覆盖底账）；
 * 现账若确有一份旧快照没有的判卷（旧账归档前未走过本函数），按"只补缺"补进来。
 * 三项判卷全无 ⇒ 返回 null（归档前无账，不写空快照）。
 */
function buildArchivedSnapshot(
  ctx: Record<string, unknown>,
  qualityScore: number | null,
  reason: string | undefined,
  at: string,
): ArchivedSnapshot | null {
  const prev = asRecord(ctx[ARCHIVED_SNAPSHOT_KEY]);
  const snap: ArchivedSnapshot = {};
  const acc = prev?.acceptance_check ?? ctx.acceptance_check;
  const cq = prev?.completion_quality ?? ctx.completion_quality;
  const qs = typeof prev?.quality_score === 'number' ? prev.quality_score : (typeof qualityScore === 'number' ? qualityScore : undefined);
  if (acc !== undefined) snap.acceptance_check = acc;
  if (cq !== undefined) snap.completion_quality = cq;
  if (qs !== undefined) snap.quality_score = qs;
  if (acc === undefined && cq === undefined && qs === undefined) return null;
  snap.archived_at = at;
  const prevReason = typeof prev?.archive_reason === 'string' ? prev.archive_reason : '';
  const nextReason = String(reason ?? '').trim();
  if (nextReason !== '' || prevReason !== '') snap.archive_reason = nextReason || prevReason;
  return snap;
}

export type ArchiveRejectCode = 'archive_reason_required';

export interface ArchiveDecisionInput {
  /** 目标任务**此刻**的状态（归档前一行读出的真值，不是调用方声称的目标值）。 */
  status: string;
  /** 目标任务是否某父任务的直接子任务（`parent_task_id` 非空）。 */
  isDirectChild: boolean;
  /** 账上记录的暂停因由原文（`recordedPauseReason`），无记录为空串。 */
  pauseReason: string;
  /** 本次归档附的人话理由。 */
  reason?: string;
}

export type ArchiveDecision =
  | { allow: true }
  | { allow: false; code: ArchiveRejectCode; message: string };

const ARCHIVE_REASON_REQUIRED_MESSAGE =
  '该子任务停在验收未判/验收失败，归档须写明放弃理由（会显示在任务详情）';

/**
 * zx_20261105_1 M2（维特根斯坦·语言即用 / 王阳明·知行合一）：归档闸的**唯一判据**。
 *
 * 病根：子任务因「验收没判成」或「验收未通过」被引擎暂停后，父代理可以用 `archived` 把它
 * **静默清掉**——收口闸只看终态，弃了就"处置过了"，于是"没判"与"判了不过"这两笔账
 * 在父任务完成时查无此据。归档是了结，但这类了结必须留下**为什么放弃**的人话。
 *
 * 只拦一类（不扩大）：
 *   · 仅 `paused`；`failed` 子的归档已有 `closureOfFailedChild` 的"带因"旧路径；
 *   · 仅直接子任务（父代理的处置权范围）；
 *   · 仅 `acceptance_unjudged` / `acceptance_failed` 两种暂停因由；
 *   · 其余暂停因由（等子、用户中断、供应商故障…）与所有非暂停态一律放行。
 */
export function archiveDecision(input: ArchiveDecisionInput): ArchiveDecision {
  const acceptanceStall =
    input.pauseReason === PAUSE_REASON_ACCEPTANCE_UNJUDGED ||
    input.pauseReason === PAUSE_REASON_ACCEPTANCE_FAILED;
  if (input.status !== 'paused' || !input.isDirectChild || !acceptanceStall) return { allow: true };
  if (String(input.reason ?? '').trim() !== '') return { allow: true };
  return { allow: false, code: 'archive_reason_required', message: ARCHIVE_REASON_REQUIRED_MESSAGE };
}

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
  /** 被归档闸拒绝（zx_20261105_1 M2）：库未动、事件未发，调用方据此把因由回给模型/用户。 */
  rejected?: { code: ArchiveRejectCode; message: string };
}

/**
 * 把任务落到 `archived` 终态：改状态 + 落因 + 翻掉上一次 run 的判卷 + 发事件。
 *
 * 顺序（不可换）：**先落库、后发事件**——订阅者收到事件即回查库，库未落笔则读到旧态。
 */
export function archiveTask(db: TaskTerminalDb, opts: ArchiveTaskOptions): ArchiveTaskResult {
  const { taskId, reason, expectStatus } = opts;
  const row = db.prepare('SELECT project_id, context_json, status, parent_task_id, quality_score FROM wa_tasks WHERE id = ?').get(taskId) as
    | { project_id?: string | null; context_json?: string | null; status?: string | null; parent_task_id?: string | null; quality_score?: number | null }
    | undefined;

  // zx_20261105_1 M2: 闸在**唯一写入口**——GUI（`task:archive` / `task:updateStatus('archived')`）、
  //   编排工具（`update_task_status`）、节点取消全部经此；判据只一份 `archiveDecision`，
  //   故不存在"某个口能绕过闸"的分叉。被拒时**先于任何写**返回，库与事件都保持原样。
  const parentTaskId = row?.parent_task_id;
  const decision = archiveDecision({
    status: String(row?.status ?? ''),
    isDirectChild: typeof parentTaskId === 'string' && parentTaskId.trim() !== '',
    pauseReason: recordedPauseReason(row?.context_json ?? null),
    reason,
  });
  if (!decision.allow) {
    return { changed: false, pageTurned: false, rejected: { code: decision.code, message: decision.message } };
  }

  // zx_20261105_1 M3（道德经·知止 / 王阳明·知行合一）：**先留底、再翻页**——快照与因由在**同一次**
  //   read-modify-write 里写进 `context_json`（一次 UPDATE），随后才调 `turnAccountPage` 清现账。
  //   重复归档：底账判卷内容保留首次，`archived_at`/`archive_reason` 更新为本次（后一次归档是人的新决定）。
  let ctxJson: string | null = null;
  {
    const at = new Date().toISOString();
    try {
      const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
      if (!asRecord(ctx)) throw new Error('context_json 不是对象');
      // 坏账（数组/标量）不当对象用：与下面 catch 同一条"保住归档"的底线。
      if (reason) ctx[ARCHIVE_REASON_KEY] = reason;
      const snap = buildArchivedSnapshot(ctx, typeof row?.quality_score === 'number' ? row.quality_score : null, reason, at);
      if (snap) ctx[ARCHIVED_SNAPSHOT_KEY] = snap;
      ctxJson = (reason || snap) ? JSON.stringify(ctx) : null;
    } catch {
      // 账不是合法 JSON：**不因"写不进账"而放弃"落归档"**——状态留在旧态比丢一份坏账严重得多。
      // 本处无现账可留底，只落因由（若有）。
      ctxJson = reason ? JSON.stringify({ [ARCHIVE_REASON_KEY]: reason }) : null;
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

  // zx_20261021_2 D1（知止）：**归档即停**——把"这件事了结了"这一笔真正传到在途执行体。
  //   实测事故：`9cc5bb81` 于 03:46:19 归档，执行体跑到 03:51:12（归档后 87 步），末尾还把
  //   `archived` 覆写成 `paused`。此前本函数只改库，执行体每步只看 `paused` ⇒ 归档对它不存在。
  //   顺序：**先落库、后 abort**——库是事实，abort 只是把事实通知出去；反过来若 abort 先引爆
  //   执行体 catch（其中会回查状态），它读到的仍是旧态，等于白发一枪。
  abortTaskRun(taskId, 'status_terminal:archived');

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
