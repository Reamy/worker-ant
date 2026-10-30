/**
 * zx_20261030_1 M2「见」：**本机派出去的单**的进度，在内存里的一小块投影。
 *
 * 为什么不落库、不进事件日志：
 *   · 进度每 2s 一条、收口即废——写进 `wa_event_log` 只会把不可变日志淹掉（同 `node.heartbeat` 的取舍）；
 *   · 另建一张表＝"同一件事第二处记"（它的真源在 ANS 的 `ans_node_requests.progress_json`）。
 * 本机只在**读回那一刻**（`refreshDispatchResult` 的既有 5s 轮询）顺手抄一份，供 `nodes:dispatches` 上屏。
 * 进程重启即空——这是**如实**：面板会等下轮读回再显示，不假装记得上一次。
 */
import type { NodeRequestProgress } from '@worker-ant/shared-types';

const cache = new Map<string, NodeRequestProgress>();

/** 抄一份最新进度（`null` ⇒ 抹掉：对端未上报 / 已收口）。 */
export function recordDispatchProgress(requestId: string, progress: NodeRequestProgress | null): void {
  if (!requestId) return;
  if (progress) cache.set(requestId, progress);
  else cache.delete(requestId);
}

/** 读最新进度（未读回过 ⇒ `null`，界面说"对方未上报进度"）。 */
export function dispatchProgress(requestId: string): NodeRequestProgress | null {
  return cache.get(requestId) ?? null;
}

/** 收口即抹（终态没有"进行中"可言）。 */
export function clearDispatchProgress(requestId: string): void {
  cache.delete(requestId);
}

/** 受控回归用：清空（模块级状态须可重置，否则用例相互污染）。 */
export function resetDispatchProgressCache(): void {
  cache.clear();
}
