/**
 * zx_20261003 M9（纯搬移·零语义变更）: 风暴检测的**纯判定**——阈值常量、`StormState`、`stormVerdict` 与判暴文案。
 *
 * 搬迁来源：`services/im-router.ts` 原 `:105`–`:130`（`STORM_WINDOW_MS` … `stormVerdict`）与 `:134`–`:135`
 *   （`STORM_NOTICE`），**逐字搬运**。模块态 `stormTracker`（原 `:132`）**留在调用方**——那是"按用户记状态"
 *   的调用方职责，不是纯判定的一部分；本模块**不读写任何全局状态**，只吃 `prev` 与 `now`。
 *
 * 阈值一字未动（风暴雨 2 秒 / 第 3 条 / 冷却 15 秒）——zx_20260920 M1 只把判定抽成可测纯函数，本轮只是**换住处**。
 */

// ====== 风暴检测（zx_20260920 M1：阈值一字未动，只把"判定"抽成可测纯函数）======
//
// 为什么抽出来：判定要能被**直调真实现**地复跑（不复刻它的时序逻辑）。
// 为什么抽出来**不改语义**：风暴雨 2 秒 / 第 3 条 / 冷却 15 秒是防刷屏的正当机制，
//   本轮治的是"丢了不吭声"，不是"别丢"（方案 §2.5-D3）。
export const STORM_WINDOW_MS = 2_000;    // 同一用户 **2 秒**内的连发才算"密"
export const STORM_COOLDOWN_MS = 15_000; // 判暴后**冷却 15 秒**（提示本身也不许变成刷屏）
export const STORM_THRESHOLD = 2;        // 窗内**第 3 条**起判暴（count > 2）

export interface StormState { count: number; firstTs: number; cooldownUntil: number }

/**
 * 风暴判定（**纯函数**：只吃 `prev` 与 `now`，不读钟、不碰全局表）。
 * `firstInCooldown` 为真 = "刚判暴、且是本次冷却里的第一条" —— 调用方**据此只提示一次**。
 */
export function stormVerdict(prev: StormState | undefined, now: number): { next: StormState; storm: boolean; firstInCooldown: boolean } {
  if (!prev || now - prev.firstTs > STORM_WINDOW_MS) {
    return { next: { count: 1, firstTs: now, cooldownUntil: 0 }, storm: false, firstInCooldown: false };
  }
  if (prev.cooldownUntil > now) return { next: prev, storm: true, firstInCooldown: false };
  const count = prev.count + 1;
  if (count > STORM_THRESHOLD) {
    return { next: { count, firstTs: prev.firstTs, cooldownUntil: now + STORM_COOLDOWN_MS }, storm: true, firstInCooldown: true };
  }
  return { next: { ...prev, count }, storm: false, firstInCooldown: false };
}

/** 判暴时给用户的那句话——**如实**说明"收到了，只是压一压"，不是沉默也不是搪塞。 */
export const STORM_NOTICE = '收到，消息来得有点密，已按顺序记下；我先把手头的处理完再回你。';
