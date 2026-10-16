/**
 * 「AI 引擎故障」这一次事故的账——**一处真源**（zx_20260923 M1 / G2）。
 *
 * ## 治的病：一面"任务一生"的旗，管着"这一次要不要重试"
 *
 * 原实现把 `sdk_failed` 当成"这任务摔过没有"来记：**立旗在首次失败，清旗只在成功**。
 * 而它唯一被读的地方是 `if (!retryCtx.sdk_failed)`——**"这一次要不要重试"**。
 * 两者作用域不同，遇上一个**长期没成功**的任务就出事：真库标本 `a290ae2b` 的两行物证——
 *
 * ```
 * 2026-09-22 07:03:08  [AI引擎失败] …已标记降级重试…        ← 立旗（拿到重试）
 * 2026-09-23 03:34:42  [AI引擎不可用] …                      ← 20 小时 31 分后，被当成"第二次"
 * ```
 *
 * 第二次那笔 run **本身是第一次 SDK 错误**（22 步事件里另无 SDK 错误），却因旗还在，
 * **零重试直接判死**。机器以为自己在"知止"，其实是在**替上一次的账，斩这一次的头**。
 *
 * ## 故把"旗"改成"事故"
 *
 * 键名与三个动作（开 / 查 / 清）都从这里取，调用方不手抄字面量——否则"改一处漏一处"必然复发。
 * 事故的边界由**谁在续它**决定，不由时间决定：
 *   - **引擎自动重试**（`sdkFailed` 重新入队）：同一次事故，旗保留 ⇒ 再次失败即到顶；
 *   - **用户手动恢复**（`initiator === 'user'`）：**新事故**，清旗 ⇒ 重新获得一次重试额度；
 *   - **任务成功**：事故早已结束，清旗。
 *
 * 纯函数、零 import，回归可直跑真实现（承本仓既有手法）。
 */

/** 事故的键——**不手抄**。`sdk_failed` 早于本轮存在（存量行可能只有它、没有时间戳）。 */
export const SDK_INCIDENT_KEY = 'sdk_failed' as const;
/** 事故**始于何时**——存量行缺此键 ⇒ 视为"时间未知的事故"，`hasOpenSdkIncident` 仍为真。 */
export const SDK_INCIDENT_AT_KEY = 'sdk_failed_at' as const;

/** 账上是否有一笔**未结**的事故（唯一读点，即"这一次该不该重试"的判据）。 */
export function hasOpenSdkIncident(ctx: Record<string, unknown> | null | undefined): boolean {
  return ctx?.[SDK_INCIDENT_KEY] === true;
}

/** 事故开始时刻（ISO）；存量行缺键 ⇒ 空串（**不编时间**）。 */
export function sdkIncidentAt(ctx: Record<string, unknown> | null | undefined): string {
  const v = ctx?.[SDK_INCIDENT_AT_KEY];
  return typeof v === 'string' ? v : '';
}

/** 开一笔事故（首次失败时调用）。已在事故中则**不覆盖起始时刻**——事故的"开始"只有一个。 */
export function openSdkIncident(ctx: Record<string, unknown>, atIso: string): void {
  if (hasOpenSdkIncident(ctx)) return;
  ctx[SDK_INCIDENT_KEY] = true;
  ctx[SDK_INCIDENT_AT_KEY] = atIso;
}

/** 结一笔事故，返回**是否真有旗被结掉**（供调用方决定要不要写库，也供回归做 0→1→0 的正面断言）。 */
export function closeSdkIncident(ctx: Record<string, unknown> | null | undefined): boolean {
  if (!ctx) return false;
  const had = hasOpenSdkIncident(ctx) || SDK_INCIDENT_AT_KEY in ctx;
  delete ctx[SDK_INCIDENT_KEY];
  delete ctx[SDK_INCIDENT_AT_KEY];
  return had;
}
