/**
 * zx_20261110_2 B5「损」：**收口之后的那几笔账**——它们的身份与去重口（一处真源）。
 *
 * 病根（本方案 §2 基线 16:24:06→16:24:27）：任务在 `executeTask` 里标完完成、`task.completed`
 * 事件也已发出之后，ai-task **仍**在关键路径上串着做完 IM 通知、推件、记忆强化、工作记忆提升……
 * 收尾 21s 里有大半是在"事已办成、账还没记完"。这些账**不属于收口**：它们只要求"迟早办到、且只办一次"。
 *
 * 本模块给它们两样东西：
 *   ① **身份**：`last_completed_run_id` —— 收口时写进 `context_json` 的那个 run。续跑是新 run、新身份，
 *      故"续跑后再次完成"也能各通知一次（若按 `background_reviewed_at` 这类**按终态**的键去重，
 *      第二、三次完成会被静默吞掉 —— 这正是本模块不复用它的理由，见方案 §9.1 Ruling）。
 *   ② **去重口**：`postlude_done_run` —— 后置账办完才写；进程重启后同一 run 的重复作业据此不再重做。
 *
 * ⚠ 写 `context_json` 一律**读改写**（`writeTaskContextField`）：裸对象整体覆写会静默抹掉
 *   兄弟键（附件/目标/方案/注入账……），这是本仓复发过三次的病（auto-memory
 *   `feedback_json_column_overwrite_wipes_siblings`）。坏 JSON 不覆盖——读不懂就**不写**，如实返回 false。
 */

import { generatePositionLessonCandidate, type PositionDb } from './positions.js';

/** 后置账作业的类型名（`wa_jobs.type`）。 */
export const POSTLUDE_JOB_TYPE = 'task-postlude';

/** `context_json` 键：本任务**最近一次收口**的 run id（收口两出口同写）。 */
export const LAST_COMPLETED_RUN_KEY = 'last_completed_run_id';
/** `context_json` 键：最近一次**办完后置账**的 run id（幂等键）。 */
export const POSTLUDE_DONE_RUN_KEY = 'postlude_done_run';

/** 仅需 prepare().get()/.run() 的最小库接口（与 `task-jobs.ts` 同形，保持本模块可脱 electron）。 */
export interface PostludeDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes?: number };
  };
}

/** 读任务 context_json（读不到/坏 JSON ⇒ 空对象；**不抛**）。 */
export function readTaskContext(db: PostludeDb, taskId: string): Record<string, unknown> {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const parsed = JSON.parse(row?.context_json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * 读改写一个 `context_json` 顶层键（**保留兄弟键**）。返回是否真的写进去了。
 * 坏 JSON ⇒ 返回 false 且**不覆盖**（宁可这笔账不落，也不抹掉别人的账）。
 */
export function writeTaskContextField(db: PostludeDb, taskId: string, key: string, value: unknown): boolean {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    if (!row) return false;
    const raw = row.context_json || '{}';
    let parsed: Record<string, unknown>;
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
      parsed = p as Record<string, unknown>;
    } catch { return false; }
    parsed[key] = value;
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(parsed), taskId);
    return true;
  } catch { return false; }
}

/** 收口时记下"这一 run 完成了"——**两个收口出口**都调这一处（run_close 与 finalize_task 工具路）。 */
export function markCompletedRun(db: PostludeDb, taskId: string, runId: string | null | undefined): void {
  // zx_20261112_1 B2「任」：收口即沉淀**候选**经验（只写 pending，人工采纳后才注入）。
  //   与 run 账同一处、同一时机（承 B5「损」：两出口只写一处）；准入判据全在 positions.ts
  //   （指派岗位 ∧ 岗位在 ∧ 非外派 ∧ 验收通过 ∧ 有人话摘要），任一不满足如实不写。
  try {
    generatePositionLessonCandidate(db as unknown as PositionDb, taskId);
  } catch { /* 沉淀失败不阻断收口 */ }
  const id = String(runId ?? '').trim();
  if (!id) return;
  writeTaskContextField(db, taskId, LAST_COMPLETED_RUN_KEY, id);
}

/** 最近一次收口的 run id（没有 ⇒ null）。 */
export function lastCompletedRunKey(db: PostludeDb, taskId: string): string | null {
  const v = readTaskContext(db, taskId)[LAST_COMPLETED_RUN_KEY];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 已办完后置账的 run id（没有 ⇒ null）。 */
export function postludeDoneRun(db: PostludeDb, taskId: string): string | null {
  const v = readTaskContext(db, taskId)[POSTLUDE_DONE_RUN_KEY];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 记"后置账办完了"。返回是否写入成功（写不进去 ⇒ 下次重复作业会重做，宁可多办一次也不静默丢）。 */
export function markPostludeDone(db: PostludeDb, taskId: string, runId: string): boolean {
  return writeTaskContextField(db, taskId, POSTLUDE_DONE_RUN_KEY, runId);
}

/**
 * **要不要办**——后置账的唯一判据（纯函数式，rr 直跑）。
 * 返回 `null` ⇒ 不办（无收口身份，或同一 run 已办过）；否则返回应办的 runKey。
 */
export function postludeDue(db: PostludeDb, taskId: string): { runKey: string } | null {
  const runKey = lastCompletedRunKey(db, taskId);
  if (!runKey) return null;
  if (postludeDoneRun(db, taskId) === runKey) return null;
  return { runKey };
}
