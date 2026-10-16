/**
 * zx_20260920_1 M3（面一 · 判据 C5）：**人工收口**的一处真源。
 *
 * 病根（真库标本 `9788ce4f`，只读实测）：GUI 点「标记完成」走 `ipc/project.ipc.ts` 的
 * `task:updateStatus`，那条路上只有一句 `if (!existing?.score)` 的总闸——**已经有账的任务整段跳过**，
 * 于是同一个任务同时挂着三种自相矛盾的状态：
 *   · `status = 'completed'` 与 `pause_reason = 'output_insufficient'` 并存在一份 `context_json` 里
 *     （"已完成"与"还在等人工介入"是两句话）；
 *   · 顶层 `goal_achieved = 0` 而账上 `completion_quality.goal_achieved = false`（这一份当时**碰巧**同值，
 *     但两处各写一份，同值只是巧合——`5126b303` 就是它们分家的那一次）；
 *   · `via` 永远停在 `'run_close'`——**这笔终态是人在 GUI 上裁的**，账上却记成"引擎收的口"。
 * 而"有账"恰恰是这条路上最常见的状态 ⇒ 那道总闸对最需要它的情形**不生效**。
 *
 * 本模块只做**终态清算**，不重跑验收、不重算分。它与引擎侧三处调用共用同一批真源：
 *   · `buildCompletionAccount` / `goalAchievedOf` / `syncGoalAchievedFromAccount`（`task-outcome.ts`）
 *   · `promoteTaskFileDeliverables`（`deliverable-lifecycle.ts`）——**同一个符号**，不是等价的第二份逻辑
 *
 * 刻意**不引 electron / eventBus / logger**：rr 可喂内存库直跑真实现（承 `feedback_rr_fixture_production_order`）。
 */
import type Database from 'better-sqlite3';
import { buildCompletionAccount, goalAchievedOf, syncGoalAchievedFromAccount } from './task-outcome.js';
import { promoteTaskFileDeliverables } from './deliverable-lifecycle.js';

/** 无账时由调用方注入的审计结论（`assessCompletionQuality` 的产出；缺则**如实不编分**）。 */
export interface FinalizeAudit {
  score: number;
  feedback?: string;
}

/** `account` 的四种如实取值：账被原样留下 / 只换署名 / 新造一笔 / 压根没有账。 */
export type FinalizeAccountKind = 'kept' | 'relabelled' | 'fresh' | 'none';

export interface FinalizeResult {
  /** **实际**从 `context_json` 移除的陈旧键（一个都没清 ⇒ 空数组，不谎报"清了 N 个"）。 */
  cleared: string[];
  account: FinalizeAccountKind;
  /** 收口后账上的分（`account:'none'` ⇒ `null`——"没这笔账"不是"账上是 0 分"）。 */
  score: number | null;
  /** 收口后顶层 `goal_achieved`（与账内同值的不变式成立时才有意义；非布尔即 `null`）。 */
  goalAchieved: boolean | null;
  /** 交由 `promoteTaskFileDeliverables` 归位的 doc 件数（其内部自带 `forced` 红线与探针尺）。 */
  promoted: number;
}

/**
 * 终态与暂停因由**不可共存**——终态携带 `pause_reason` 是自相矛盾（"已完成"与"还在等"同处一份账）。
 * 只清暂停专属的两个键；`reason` **不动**（它另属 `failed`/`abandoned_by_user` 语义，非暂停专属）。
 *
 * zx_20261015_2 D2：**导出**——`update_task_status(completed)` 那条出口（第三条完成路）同守此不变量，
 * 须复用本一处键表（同族写口，不另抄键名）。
 */
export const STALE_PAUSE_KEYS = ['pause_reason', 'pause_note'] as const;

/**
 * 人工裁定「完成」后的收口清算。**四件事，按序**：
 *
 * 1. **清陈旧暂停键**（`STALE_PAUSE_KEYS`）——返回**真清掉的那些**，清不掉的不入列。
 * 2. **完成账**：有账 ⇒ `score`/`goal_achieved`/`feedback` **逐字保留**，只把 `via` 换成人工路
 *    （人工裁的是**终态**，不是**判卷结论**：把人裁写成"引擎说达成"＝伪造，反过来硬把未达成掰成
 *    `true` 亦同）；无账且调用方注入了 `audit` ⇒ 用**同一个构造器**造一笔；两者都无 ⇒ 如实 `'none'`。
 * 3. **不变式**：`syncGoalAchievedFromAccount(ctx)`——顶层与账内同值（方向①，`task-outcome.ts` 一处真源）。
 * 4. **面三**：`promoteTaskFileDeliverables`——「人工收口也是收口」，doc 状态随之落定。
 *
 * ⚠ 边界如实（承 M3 开工测绘）：第 4 步的打标判据是 `isAcceptanceVerified`（`verified !== false`），
 *   **不是** `acceptanceVerdictOf`。故一个 `verified:true` 而 `0/5 未通过` 的任务（标本 `9788ce4f`）
 *   其 doc **仍会被打上 `acceptance_verified=1`** —— 这是既有口径的**如实继承**，本轮不改（已登记于方案）。
 */
export function finalizeTaskByHuman(
  db: Database.Database,
  opts: { taskId: string; via: string; audit?: FinalizeAudit },
): FinalizeResult {
  const { taskId, via, audit } = opts;
  const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as
    | { context_json?: string | null }
    | undefined;
  const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;

  // ① 清陈旧暂停键（只记**真动过**的）
  const cleared: string[] = [];
  for (const k of STALE_PAUSE_KEYS) {
    if (k in ctx) {
      delete ctx[k];
      cleared.push(k);
    }
  }

  // ② 完成账
  const existing = ctx.completion_quality as
    | { score?: unknown; goal_achieved?: unknown; feedback?: unknown; via?: unknown }
    | undefined;
  let account: FinalizeAccountKind = 'none';
  if (existing && typeof existing.score === 'number') {
    // 逐字保留 score / goal_achieved / feedback，只换署名。
    // 署名**已经是**人工路（重复点「标记完成」）⇒ 一个键都不用改写，如实报 `'kept'`——
    //   这样"账没被重写"这件事**可观测**（对照 `'relabelled'`：真的换了署名）。
    if (existing.via === via) {
      account = 'kept';
    } else {
      // 换署名也是**重写一笔账** ⇒ 必须过唯一构造器（`zx_20260916_3` 判据 C-3：全 `src/main`
      //   不许出现 `completion_quality = {` 形式的对象字面量）。分数与评语逐字保留。
      //
      // `goal_achieved` 该取谁：账内有布尔 ⇒ 取账内（**判卷结论**，人工裁的是终态不是判卷结论）；
      //   账内没有（存量老账，实测 114 笔只有 `{score}`/`{score,via}`）⇒ 退到顶层同名字段，
      //   顶层也没有 ⇒ 才用 `goalAchievedOf` 按分数推。**推出来的值不冒充判卷结论**，仅补全形状。
      const goalAchieved =
        typeof existing.goal_achieved === 'boolean'
          ? existing.goal_achieved
          : typeof ctx.goal_achieved === 'boolean'
            ? ctx.goal_achieved
            : goalAchievedOf(
                !!(ctx.task_goal as { goal?: string } | undefined)?.goal,
                ctx.goal_deviation_restarts,
                existing.score,
              );
      ctx.completion_quality = buildCompletionAccount({
        score: existing.score,
        goalAchieved,
        via,
        feedback: typeof existing.feedback === 'string' ? existing.feedback : undefined,
      });
      account = 'relabelled';
    }
  } else if (audit && typeof audit.score === 'number') {
    const goalAchieved = goalAchievedOf(
      !!(ctx.task_goal as { goal?: string } | undefined)?.goal,
      ctx.goal_deviation_restarts,
      audit.score,
    );
    ctx.completion_quality = buildCompletionAccount({
      score: audit.score,
      goalAchieved,
      via,
      feedback: audit.feedback,
    });
    account = 'fresh';
  }

  // ③ 不变式
  syncGoalAchievedFromAccount(ctx);

  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);

  // ④ 面三
  const promoted = promoteTaskFileDeliverables(db, taskId, via).promoted;

  const acct = ctx.completion_quality as { score?: unknown } | undefined;
  return {
    cleared,
    account,
    score: typeof acct?.score === 'number' ? acct.score : null,
    goalAchieved: typeof ctx.goal_achieved === 'boolean' ? ctx.goal_achieved : null,
    promoted,
  };
}
