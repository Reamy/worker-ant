/**
 * `failed` 这一终态的**唯一写手**（zx_20260923 M6-b / G12）。
 *
 * ## 治的病：判卷写在甲处，终态落在乙处，乙处不翻甲处的页
 *
 * `completion_quality` 是"这次 run 干得怎么样"的一笔账，写在 run_close / finalize /
 * update_task_status 三条**完成路**上。而 `failed` 有**六个**写点（见下）。
 * 两者从不相干：一次 run 攒下一笔 90 分的账、任务停在 `paused`，隔天同一个任务**崩溃**被标 `failed`——
 * 账还留在那儿。于是 GUI 上出现真库标本 `a290ae2b` 的形状：
 *
 * ```
 * status = failed
 * "completion_quality": {"score":90,"goal_achieved":false,"via":"run_close",
 *                        "feedback":"质量: excellent (…)"}
 * "acceptance_check":   {"checked_at":"2026-09-23T02:31:29.943Z","verified":false,
 *                        "reason":"output_insufficient",…}
 * ```
 *
 * 一次 SDK 崩溃，被读成"质量 excellent / 90 分"。**账要能自己翻篇。**
 *
 * ## 为什么必须抽成一处：`failed` 有六个写点，不是一个
 *
 * `agent-executor.ts`（质量<20 无产出 / catch `execute_error`）· `jobs/ai-task.ts`（`recordExecutionFailure` /
 * 并发重试超限）· `self-healing-monitor.ts`（依赖无出路）· **`event-projectors.ts`（`task.failed` 事件投影）**。
 *
 * ⚠ zx_20260930 M11-3 起**不是七处而是六处**：`task-scheduler.ts` 的心跳超时原来走 `markTaskFailed`
 *   ⇒ 与自愈监视器的同因（无心跳）**两果**（`failed` 终态 vs `paused` 可救）。本轮"看门狗归一"把调度器这一路
 *   收进 `self-healing-monitor.reclaimStaleExecutingTask`（同一函数、同一结局 `paused` + `exec_timeout`），
 *   调度器不再直接落 `failed`——故写点少一处，此处台账与代码同步减一（"注释说有、代码零调用"的反面：
 *   注释里的数**必须**跟着代码走）。
 *
 * `event-projectors.ts` 这处最易漏：它是**事件溯源侧**的第二个在线写点（本仓**没有**由 `wa_event_log`
 * 重建库的回放路径，`registerProjectors` 只订阅活体总线）——正因为是在线的第二写点，"谁最后落笔"就决定了账的形状。
 * 六处各写一遍清账 ⇒ 必漏其一，正是本轮"一条修复只走了一条路"的同形。
 *
 * ## 清什么、留什么
 *
 * | 键 / 列 | 处置 | 为什么 |
 * |---|---|---|
 * | `ctx.completion_quality` | **删** | 全部读点（`TaskDetailPage.tsx` / `project.ipc.ts` / `ai-task.ts` / `memory-manager.ts`）都按形状**直接取值**、没有"陈旧位"判据。加 `stale:true` 而不改全部读点 ⇒ 新键无人读（本仓明令"做了没用上"）；改全部读点 ⇒ 面更大且要新增一个跨端词表。**证据不靠它留**：七个写点各自已落一条会话消息（含失败因），`task.failed` 事件亦在场 |
 * | `ctx.acceptance_check` | **删** | 与 `completion_quality` 同属"上一次 run 的判卷"，同一次落笔、同一次翻页 |
 * | 顶层 `ctx.goal_achieved` | 置 **false** | 失败即未达成。**不删**——顶层那份是给 SQL 直读的，删了就成了"没这笔账"而非"没达成" |
 * | `wa_tasks.quality_score` 列 | 置 **NULL** | 该列是 `completion_quality.score` 的双写（`syncQualityColumn`）。消费者 `project-analytics.ts` 的项目均质/低分数、`project.ipc.ts` 的"高分已完成"榜都只看这一列 ⇒ 不清则失败任务仍按 90 分进聚合 |
 *
 * ## 幂等与 CAS
 *
 * `opts.expectStatus` 保住自愈路原有的 `AND status = 'pending'`（扫描与写入之间可能已被别的路放行），
 * `opts.at` 保住事件投影路的**事件时刻**（它刻意不取 `datetime('now')`，取的是 `event.timestamp`）。
 * 无可清即不动库（投影器每次 `task.failed` 都会过一遍这里）。
 */
import type { TaskOutcomeDb } from './task-outcome.js';
import { markGoalNotAchieved } from './task-outcome.js';
import { buildTaskNotice } from './task-notice.js';
import { pushImNotify } from './im/im-notify.js';

/**
 * zx_20260930 M5: `background-review` 的**可复盘终态集**——一个概念一个值。
 *
 * 病根：调度守卫在三处各自写死 `status === 'completed'`（`jobs/ai-task.ts` 两条完成路 +
 *   `jobs/index.ts` 的提示词假定），于是**失败任务从不复盘**——而失败的教训与阻塞条件恰恰比成功配方更该被记住。
 *   放宽到含 `failed` 之后，"哪些终态可复盘"就**必须是一个值**：守卫认它、提示词按它分叉，两边分开写就会再次分家。
 *
 * ⚠ **不含 `paused`**：暂停是"等人"，任务还会被 `resume`；此刻复盘等于按一本未完成的账总结，
 *   且 resume 之后会再复盘一次（同一段对话被 LLM 读两遍）。
 * ⚠ **不含 `archived`**：归档是回收入库的收尾态，复盘时机早已过去。
 * ⚠ 与 `task-jobs.ts` 的 `isTerminalTask`（`completed|failed|archived`）**同值不同义，刻意不并入**：
 *   那个回答"这任务还跑不跑得动"（调度/依赖闸用），这个回答"这任务的一生值不值得总结一次"。
 *   合并会把两个本可独立调节的概念锁死成一个（同 `memory-constants.ts` 里那条 0.6 的既有裁定）。
 */
export const REVIEWABLE_STATUSES = ['completed', 'failed'] as const;

/** 该状态是否可复盘（收进这一函数：三处守卫不再各写一份名单）。 */
export function isReviewableStatus(status: string | null | undefined): boolean {
  return !!status && (REVIEWABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * 复盘该总结成什么——`completed` → 「配方」（有效做法，可复用）；`failed` → 「教训」（失败因 + 阻塞条件 + 下次怎么做）。
 *
 * 抽成**纯函数**而非在两个写点各写一个三元：提示词（`jobs/index.ts`）与复盘生成
 * （`memory-manager.generateTaskRetrospective`）都读它，两处必须同一把尺。
 */
export function reviewFocus(status: string | null | undefined): 'recipe' | 'lessons' {
  return status === 'failed' ? 'lessons' : 'recipe';
}

/** 只需 `prepare().run()/.get()` 的最小库接口（同 `TaskOutcomeDb` 范式：可脱 better-sqlite3 跑真实现） */
export interface TaskTerminalDb extends TaskOutcomeDb {
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export interface MarkFailedOpts {
  /** 只在这个状态下才翻（CAS）。自愈路要求"此刻仍是 pending" */
  expectStatus?: string;
  /** `updated_at` 取**事件时刻**（投影路）而非库钟 `datetime('now')`（命令路） */
  at?: string;
  /**
   * zx_20261012_2 批五 M5: 失败因由（取**既有真源**——调用方手上的 `err.message` / 策略文案 / 事件的 `error`）。
   *
   * 非空 ⇒ 落 `failed` 后**并**经 `pushImNotify` 发一条**带因**的 IM（`kind='task_failed'`，
   *   同类同项目短窗内至多一条，见 `im/im-notify-log.ts`）。
   * 空 ⇒ **不发**——不是因为"无因就不值得知道"，而是**顺序**：本仓 `task.failed` 事件必带 `error`
   *   （一处真源 `taskFailedPayload`，投影器随后会把因由带进来）。若此处先抢发一条无因的，
   *   投影器那条**带因的**反被聚并吃掉 ⇒ 用户只收到一句空话（见 `notifyFailure` 头注）。
   */
  reason?: string;
}

export interface MarkFailedResult {
  /** 状态行是否真被这次调用翻到 `failed`（CAS 未命中 ⇒ false，调用方据此跳过后续记账） */
  changed: boolean;
  /** 是否真翻了账的页（无可清 ⇒ false，库里没动） */
  pageTurned: boolean;
}

/**
 * 把任务落到 `failed` 终态，**并翻掉上一次 run 留下的判卷**，**并**（带因时）发一条失败 IM。
 *
 * 调用方仍自负其责的部分：会话消息、`task.failed` 事件、父任务复核——
 * 那些各写点形状不同（`recordExecutionFailure` 还带 `hooks`），不该被吞进这里。
 * 本函数管**状态行 + 账 + 通知**这三件"凡失败必同形"的事。
 *
 * 「通知」是 zx_20261012_2 批五 M5 收进来的：此前失败 IM 只有 `jobs/ai-task.recordExecutionFailure`
 * 一条路发（`hooks.notify`），于是自愈监视器、`update_task_status`、`agent-executor` 的无产出/异常
 * 两条路**一处也不发**——用户实机遇到的"9 连败一条通知没有"正是这个形状。收进唯一写手后：
 * **一处发、六处收**（六个写点都经本函数）。
 */
export function markTaskFailed(db: TaskTerminalDb, taskId: string, opts: MarkFailedOpts = {}): MarkFailedResult {
  const where = opts.expectStatus ? ' WHERE id = ? AND status = ?' : ' WHERE id = ?';
  const whereArgs: unknown[] = opts.expectStatus ? [taskId, opts.expectStatus] : [taskId];
  let changed = false;
  try {
    const stmt = opts.at
      ? db.prepare(`UPDATE wa_tasks SET status = 'failed', updated_at = ?${where}`)
      : db.prepare(`UPDATE wa_tasks SET status = 'failed', updated_at = datetime('now')${where}`);
    const res = opts.at ? stmt.run(opts.at, ...whereArgs) : stmt.run(...whereArgs);
    changed = (res?.changes ?? 0) > 0;
  } catch {
    return { changed: false, pageTurned: false };
  }
  if (!changed) return { changed, pageTurned: false };
  const pageTurned = turnAccountPage(db, taskId);
  notifyFailure(db, taskId, opts.reason);
  return { changed, pageTurned };
}

/**
 * 失败 IM 的**唯一出口**（批五 M5）。只在 `markTaskFailed` 真翻动状态（`changed`）后调，
 * 且**只在有因由时发**。
 *
 * ## 为什么"无因即不发"（这不是"静默丢掉"，是**顺序**）
 *
 * 同一次失败常**两跳**到达本口：写点自己调 `markTaskFailed`，随即 `emit('task.failed')`（投影器**再**调一次）。
 * 两跳里**带因的往往是后一跳**——`agent-executor` 的两条路先裸调 `markTaskFailed`（无因）再发事件
 * （事件里带 `error`）。若先发的无因那条占了聚并窗口，后发带因的就被吃掉，用户收到的是"任务失败"四个字的空话。
 * 故取"**让带因的那条说话**"：无因一律不发。
 *
 * 代价与防线：万一某个 `task.failed` 的 emit **忘了带 `error`**，这条失败就没有 IM。防线是**静态判据**——
 * 受控回归扫全仓 `emit('task.failed'` 处**处处带 `error`**（去注释码；真源 `taskFailedPayload` 亦恒带）。
 * ⚠ 本轮边界冻结 `agent-executor.ts`，那两条路的因由**只能**经事件投影器进来（那正是"带因的后一跳"）。
 *
 * 不抛：通知失败不阻断失败落账（`pushImNotify` 自身亦不抛）。
 */
function notifyFailure(db: TaskTerminalDb, taskId: string, reason?: string): void {
  const detail = (reason ?? '').trim();
  if (!detail) return;
  try {
    const { message } = buildTaskNotice(db, taskId, 'failed', { detail: detail.slice(0, 100) });
    void pushImNotify(db, taskId, message, 'task_failed');
  } catch { /* 通知失败不阻断失败落账 */ }
}

/**
 * 「上一笔判卷」的**结账**：清掉上一次 run 的判卷，把顶层目标达成如实置 false。
 *
 * 抽出来是为了**可被单独驱动**（rr 直跑真实现），也是为了让"翻页"这件事在源码里
 * 只有一个落点可被扫描——七个写点共用它，不是七份手抄。
 */
export function turnAccountPage(db: TaskTerminalDb, taskId: string): boolean {
  let ctx: Record<string, unknown>;
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string | null } | undefined;
    const parsed: unknown = JSON.parse(row?.context_json || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    ctx = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  const hadAccount = ctx.completion_quality !== undefined;
  const hadAcceptance = ctx.acceptance_check !== undefined;
  const goalSaysAchieved = ctx.goal_achieved !== false;
  if (!hadAccount && !hadAcceptance && !goalSaysAchieved) return false;

  if (hadAccount) delete ctx.completion_quality;
  if (hadAcceptance) delete ctx.acceptance_check;
  // 顶层 `goal_achieved` 不裸写：走 `task-outcome` 的**方向②助手**（`sync/mark` 两个方向是那条
  // 「顶层与账上同值」不变式的**唯一**落笔口；本处账已清，助手退化为只置顶层这一半）。
  markGoalNotAchieved(ctx);
  const payload = JSON.stringify(ctx);
  try {
    db.prepare('UPDATE wa_tasks SET context_json = ?, quality_score = NULL WHERE id = ?').run(payload, taskId);
  } catch {
    // 既存夹具/老库可能没有 `quality_score` 列（该列由 `database.ts` 迁移添加）⇒ 退一步只写 ctx
    try { db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(payload, taskId); } catch { return false; }
  }
  return true;
}

/**
 * 「产出闸的重试额度」——**用户手动恢复 = 一次新的介入** ⇒ 额度还给他（zx_20260923 M6-a / G11）。
 *
 * ## 治的病：额度记在"任务的一生"上
 *
 * `agent-executor.ts` 的两道产出闸（产出未落盘 / 内容不充分）各自：
 * `const retries = Number(ctxJson.deliverable_missing_retries) || 0; … retries + 1`，随后 `if (retries < 1)` **自动**补跑一轮，
 * 否则 `pauseTask` 等人工。计数器**只在成功收口时清**（那条 `delete` 在 run_close 成功路上）。
 * 于是失败/暂停路径上它单调累加，到 3 之后 `retries < 1` **恒假** ⇒ 这道"自动补一轮"的通道**永久关闭**：
 * 真库标本 `a290ae2b` 的 ctx 里 `deliverable_missing_retries = 3`，此后无论用户恢复多少次，
 * 引擎都不会再自己去补一次——**只能手工动库**（G16 记的正是这次手工：从 `output_validations` 删两行、删两条 `wa_deliverables`）。
 *
 * ## 两个键一起动（写入点与成功清除点都是成对的），但 `forced` 例外
 *
 * `deliverable_missing_retries` 与 `deliverable_unfulfilled` 在写入点（`agent-executor.ts` 两道闸，
 * 各写相邻两行）与成功清除点（同文件 run_close 成功路）**都是成对的**，只清一个即"只改一半"。
 * 但 `deliverable_unfulfilled` 另有一个**非本闸**的写点：`tools/control.ts` 在**预算强制收尾**时写
 * `{paths, forced: true}`——那是"强制放行留痕"（M7-b 要核它），与本闸的重试额度**不是同一件事** ⇒
 * `forced === true` 的那一份**保留**。
 *
 * ## 为什么不"按 run 代次重算"
 *
 * 那是看起来更彻底的候选（每次新 run 就把计数清零），**必须否决**：自动补跑本身也开新 run，
 * 而自动恢复同样会 `bumpResumeLedger` 记 `auto_resume_count`——清一次 → 再自动补一次 → 再清，
 * **这道闸永不关闭**，把"知止不殆"整条拆掉。故额度只能由**人的介入**发放，不由 run 的代次发放。
 */
export function grantDeliverableRetryQuota(ctx: Record<string, unknown>): boolean {
  const hadCounter = ctx.deliverable_missing_retries !== undefined;
  const unf = ctx.deliverable_unfulfilled as { forced?: boolean } | undefined;
  const clearUnfulfilled = unf !== undefined && unf.forced !== true;
  if (!hadCounter && !clearUnfulfilled) return false;
  delete ctx.deliverable_missing_retries;
  if (clearUnfulfilled) delete ctx.deliverable_unfulfilled;
  return true;
}
