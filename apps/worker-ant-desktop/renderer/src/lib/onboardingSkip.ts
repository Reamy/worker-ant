/**
 * zx_20261011_5「名正而后事成」——首启向导的**会话级软跳过出口**（《道德经·六十三章》"为之于未有"：
 *   不把用户逼进死角，先给他一条看得见状态的路）。
 *
 * 病根（N2）：`App.tsx` 的首启拦截（`setup && hash!=='#/onboarding'` ⇒ 弹回向导）**无出口**——
 *   只想"先进去看看"的新用户被反复弹回向导，无法评估工蚁是否值得配置（漏斗第一跳把人焊死）。
 *
 * 治法：给一次**本次会话**的临时豁免。**刻意不落盘**——不写 `localStorage`、不写 DB 标志。
 *   M14 的裁决是「首启判据**按状态不按标志**」：若把"跳过"写进 localStorage，就等于把判据退回标志
 *   （重装/清缓存又会重弹；且一次误点会**永久吞掉**引导）。故这里只是一个**模块级布尔**：刷新即复位，
 *   用户下次进来仍被如实引导；而跳过之后**首屏照样如实提示"缺模型"**（见 `DashboardPage` 的模型 banner），
 *   漏斗没有丢，只是**推迟并如实提示**。
 *
 * ⚠ 读端（`ProtectedRoute`）在**挂载时**取一次即可：跳过总是发生在 `SetupPage` 里，且其后必 `navigate`
 *   到受保护路由 ⇒ 触发 `ProtectedRoute` **重挂载**，届时读到新值（无需订阅、无需 React state 同步）。
 */
let skipped = false;

/** 记录"本次会话已跳过引导"（用户在向导里点了「先进去看看」）。 */
export function skipOnboarding(): void { skipped = true; }

/** 本次会话是否已跳过引导（刷新即复位——**不是**持久化标志）。 */
export function isOnboardingSkipped(): boolean { return skipped; }
