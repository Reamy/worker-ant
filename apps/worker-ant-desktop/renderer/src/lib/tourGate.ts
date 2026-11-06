/**
 * zx_20261013_1 批三「称引于人」——首启一次性导览的**闸**（零 import ⇒ 可被 rr 直跑真实现）。
 *
 * 病根：工蚁有 20+ 入口，纯"诚实空态"只能让人看懂**空白**，看不懂**功能地图**；而
 *   `biz_20261011 §3` 又定案"不做独立导览页"（怕养出第二份词表、怕和安装向导打架）。
 *
 * 治法：把**一条可跳过的一次性浮层**与那一定案调和开——
 *   · **一次性**标记落 `wa_settings`（`TOUR_SETTING_KEY`）：看过即**永不重弹**；
 *   · **会话级**跳过复用 `onboardingSkip.ts`：点了只放行本次，**不落库**（刷新仍如实引导）；
 *   · 导览词表**从导航配置派生**（`navConfig.tourEntries()`），不手写第二份。
 *
 * 本模块只放**判定**，不放词表、不碰 DOM——词表在 `navConfig.ts`，落点是调用方（`DashboardPage`）。
 */

/** 一次性标记的键名（写读**同一常量**，杜绝字面量两处各写一遍）。 */
export const TOUR_SETTING_KEY = 'onboarding.tour_done';

/**
 * 落库值 → 是否已看过导览。`'1'` / `'true'` 为真；缺省与其它一律为假。
 * 刻意**不**把"读不动/读成怪值"当成"看过"——宁可按没看过如实引导，也不静默吞掉整个导览。
 */
export function parseTourDone(raw: unknown): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** 是否该弹首启导览：未落库 ∧ 本次会话未跳过。 */
export function shouldShowTour(o: { done: boolean; skipped: boolean }): boolean {
  return !o.done && !o.skipped;
}
