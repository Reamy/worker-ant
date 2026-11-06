/**
 * zx_20261003 M11（维特根斯坦·意义即使用）: 「要不要折叠」的**唯一一把尺**——纯函数，渲染层不自带第二份。
 *
 * 病根：IM 会话流正文此前**不设上限**——一条长播报（a-stock 推送常上千字）在屏上铺满整个
 * 55vh 滚动区，同屏后几条被挤到看不见；用户既没法一眼扫过，也没法只看某条。折叠与展开是
 * 渲染层的**形态**，但"多长算长"这个判定**不该散在 JSX 条件里**——它须能被单测/rr 直接求值，
 * 否则改一处忘另一处（G8/G9 老病的同一形态：同一条规则的第二处载体）。
 *
 * 判据取**字符数 or 行数**（纯算术，不测 DOM）：跨平台确定、rr 可跑真实现。
 *   · 字符阈值：长播报多是**一行超长**（无换行）⇒ 必须按字符数挡。
 *   · 行数阈值：多段短行累计也够高（如逐条清单）⇒ 行数补上字符数挡不住的形态。
 */
export const CLAMP_MAX_CHARS = 280;
export const CLAMP_MAX_LINES = 8;

/** 该正文是否需要折叠（`>阈值` 即折叠；空串如实不折叠）。 */
export function needsClamp(text: string): boolean {
  if (!text) return false;
  if (text.length > CLAMP_MAX_CHARS) return true;
  return text.split('\n').length > CLAMP_MAX_LINES;
}
