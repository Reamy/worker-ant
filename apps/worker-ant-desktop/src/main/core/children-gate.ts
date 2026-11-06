/**
 * 「父任务为什么还不能收口」的**失败子**判据（zx_20260915 P0-3(c)）。
 *
 * 病根：收口闸的终态白名单一直是 `NOT IN ('completed','failed','archived')`——
 * `failed` 被当作"已了结"，于是**子任务失败不阻塞父任务完成**。
 * 实测 `02adce34` 失败（事件仅 `{"newStatus":"failed"}`），**106 秒后**父任务 M0 `completed`：
 * 父把子的失败**静默吸收**了，里程碑达成与成果汇总随之失真。
 *
 * 判据全仓有 **5 处**同一把尺（只堵一处 = 另外四处照放行，同形复发）：
 *   - `agent-executor.ts` run_close 收口闸 / finalize 收口闸
 *   - `agent-executor.ts` `finalize_task` 工具的两道子任务闸
 *   - `jobs/ai-task.ts` `checkParentTaskAfterChildDone`（D1 兄弟判据）
 * 故「有 failed 子」这一问**只此一处**回答，五处皆从此取——勿在别处手抄 `status = 'failed'`。
 *
 * 顺序要求：**先失败、后未完成**。一个子任务失败时它同时"不在未完成集里"，
 * 若先问未完成，失败子会被静默略过（正是本病灶）。
 *
 * 后路（防死锁）：失败子被处置——重试至 `completed`、或人工 `archived`/标记完成——
 * 之后 `checkParentTaskAfterChildDone` 再判即归零，父任务自动恢复（沿用既有 D1，不新增机制）。
 */

import { boolSetting } from './settings-bool.js';

/** 只需 prepare().get()/.all() 的最小库接口（同 settings-bool 范式：可脱 better-sqlite3 跑真实现） */
export interface ChildrenGateDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

export interface ChildRow {
  id: string;
  title: string;
}

/**
 * 本父任务下**尚未处置**的失败子任务。空数组 = 无失败子（可继续走既有未完成判据）。
 *
 * 只查 `status = 'failed'` 一态：`archived` 是用户/引擎已处置过的终态（M3-6 已确立不该挡父），
 * 而 `completed` 本就了结。
 *
 * 回退开关 `engine.children_failed_pause`（默认 true）**在本函数内**判——五处调用点因此都是
 * 同一句 `failedChildren(db, taskId)`：开关的"键名 + 判据 + 读取动作"三者同源一处。
 * 若把开关留在五处各读一遍，就又回到「一条规则写在多处必然分家」（见 settings-bool.ts 头注释）。
 */
export function failedChildren(db: ChildrenGateDb, parentId: string): ChildRow[] {
  try {
    const sw = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get('engine.children_failed_pause') as { value?: string } | undefined;
    if (!boolSetting(sw?.value)) return []; // 关 ⇒ 回到旧单判据（failed 视为终态放行）
  } catch {
    /* 读不到按"缺省即开"，与 boolSetting 语义同向（不因读设置失败就悄悄放宽一道闸） */
  }
  try {
    return db
      .prepare("SELECT id, title FROM wa_tasks WHERE parent_task_id = ? AND status = 'failed' ORDER BY created_at ASC")
      .all(parentId) as ChildRow[];
  } catch {
    /* 查不出时**不放行**也不拦：按"无失败子"论，由既有未完成判据兜底（不因读库失败把父永久扣住） */
    return [];
  }
}

/** 失败子标题串（系统会话行 / 通知理由共用同一拼法，避免两处各拼一遍） */
export function childNames(rows: ChildRow[]): string {
  return rows.map((c) => c.title).join('; ');
}

/**
 * 本父任务下**非终态**的子任务（`status NOT IN ('completed','failed','archived')`）。
 *
 * 与 `failedChildren` 互补：它答"还没到头的"，`failedChildren` 答"到了头但结果不可接受的"。
 *
 * ⚠ **不读开关**：`engine.children_failed_pause` 只决定"failed 是否算妨碍收口"，而"还在跑"的子任务
 *   在任何口径下都妨碍父收口（旧判据亦然）。故本函数恒用同一把尺、恒不受开关影响。
 *
 * 收口闸（`exec-finalize.ts` 的 `unfinishedAtClose`）与"过早结束"闸（`exec-close.ts` 的 `prematureEnd`）
 *   **同取此处**——同一条"还没了结"若写两处，就会从缝里溜回"闸说没 pending、判卷说有过早"的分家
 *   （zx_20261013_2 批二即从这条缝里照出真库标本 `7c39678e`）。
 */
export function unfinishedChildren(db: ChildrenGateDb, parentId: string): ChildRow[] {
  return db
    .prepare("SELECT id, title FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed','archived')")
    .all(parentId) as ChildRow[];
}

/**
 * 父任务此刻**是否在等子任务**（收口前的"还没了结"信号）。
 *
 * 用于 `exec-close.ts` 的 `prematureEnd` 闸：预算/步数到顶 + 还有子任务没了结 ⇒
 *   **"过早结束"这一判断本身不成立**（不是过早，是**在等**）⇒ 该闸不得抢在良性子任务闸之前
 *   把父判成"低分过早结束"。真库标本 `7c39678e`（2026-10-13）：整份 8 里程碑方案只做完 M0
 *   ⇒ 拿整份方案判卷必得 45 分、落 `quality_below_bar`；而按良性闸本应落 `children_incomplete`
 *   （"非故障，待子任务完成自动恢复"）——**门是自己关的，锁也是自己上的**。
 *
 * 判据 = 失败子 ∪ 非终态子，**先失败、后未完成**（同本文件头注释的顺序要求：失败子同时
 *   "不在未完成集里"，只问未完成会把它静默略过）。
 *
 * 读库失败按"没在等"论（false）：闸门退回改动前的行为（照常判 `prematureEnd`），方向是
 *   **不因判据自身读不到库而更放宽或更收紧**——与 `failedChildren` 的降级同向。
 */
export function childrenPendingAttention(db: ChildrenGateDb, parentId: string): boolean {
  try {
    return failedChildren(db, parentId).length > 0 || unfinishedChildren(db, parentId).length > 0;
  } catch {
    return false;
  }
}
