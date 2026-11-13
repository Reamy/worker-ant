/**
 * zx_20261110_2 B3「恒」——**幽灵自动接管的账与上限**（一处真源，rr 直跑本文件）。
 *
 * 为什么单独成文件：判据（几次算到顶）与账（记在哪一列）必须是**同一个人**说了算。
 * 若写在 `jobs/ai-task.ts` 里，回归只能抄一份复刻，抄错了也照样绿——本仓已有过这种"自我印证"的绿灯。
 *
 * 病根（事故 339ef167，2026-11-10）：任务状态停在 `executing`，实则无执行体（handler 永不返回、
 * 600s abort 不兑现）。此时"自动恢复"若没有上界，就是**永动的假动作**：恢复→又成幽灵→再恢复，
 * 界面一直在动、事情一直在原地。上界之外还须**出声**：到顶时落一条会话行 + 置暂停，
 * 让人看见"自动重试已停，请人工介入"，而不是静默重试。
 */

/** 自动接管次数上界（超过即停）。与方案 §6「自动重排 1 次、封顶 2」同一把尺。 */
export const GHOST_REQUEUE_CAP = 2;

/** `context_json` 里记次数的键名（读方只此一处，勿在别处手抄字符串）。 */
export const GHOST_REQUEUE_KEY = 'ghostRequeueCount';

/** 仅需 `prepare().get()/.run()` 的最小库接口（rr 用 node:sqlite 内存库直跑）。 */
export interface GhostDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): { changes: number } };
}

/**
 * 记一次幽灵自动接管，返回**本次**是第几次（1 起）。
 *
 * ⚠ 读-改-写而非整体覆写 `context_json`：该列还挂着附件/目标/方案等兄弟键，裸对象覆写会把它们
 *   静默抹掉（本仓已复发三次，见 auto-memory `feedback_json_column_overwrite_wipes_siblings`）。
 * ⚠ 坏 JSON ⇒ **不写**（原样留着）并返回 `cap + 1`（当作已到顶）：把读不懂的账覆写成 `{}` 等于
 *   亲手抹掉兄弟键——那是比"这次没接管"严重得多的损失。宁可停下让人看见，也不静默毁账。
 */
export function bumpGhostRequeueCount(db: GhostDb, taskId: string): number {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
    const prev = Number(ctx[GHOST_REQUEUE_KEY]);
    const next = (Number.isFinite(prev) && prev > 0 ? prev : 0) + 1;
    ctx[GHOST_REQUEUE_KEY] = next;
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
    return next;
  } catch {
    // 读不懂 / 写不进去 ⇒ 当作"已到顶"（`cap + 1`）：宁可这次停下让人看见，也不静默覆写掉读不懂的账。
    return GHOST_REQUEUE_CAP + 1;
  }
}

/** 读到当前次数（0＝没记过）。 */
export function readGhostRequeueCount(db: GhostDb, taskId: string): number {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
    const n = Number(ctx[GHOST_REQUEUE_KEY]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

/** 到顶判定（`>` 而非 `>=`：第 1、2 次仍照常接管，第 3 次才停）。 */
export function ghostCapReached(count: number, cap: number = GHOST_REQUEUE_CAP): boolean {
  return Number(count) > Number(cap);
}

/**
 * 到顶时的会话行文案——**一处真源**（首跑与恢复两路不同，但"停了"这句话只有一份）。
 * 说人话：状态显示在运行、实则无执行体；已停自动重试；请检查后手动恢复。
 */
export function ghostSelfHealStopLine(cap: number = GHOST_REQUEUE_CAP): string {
  return `[执行态自愈停止] 已连续 ${cap} 次自动接管仍未跑起来（状态显示在运行、实则无执行体）。`
    + '已置为暂停，请检查后手动恢复——继续自动重试只会重复同一次失败。';
}
