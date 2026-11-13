/**
 * zx_20261111_3 「显」——时长/时刻差的**人话换算一处真源**。
 *
 * 原实现只在 `renderer/src/lib/exec-view.ts`（执行态徽标用）。本轮新增的「第一行」也要说
 * 「已卡 12 分钟」，若在页面再写一份倒计时换算，两处迟早各说各话（同一件事两个数）。
 * 故上收 main 侧零依赖模块，renderer 反引（与 `settings-bool` / `deliverable-types` 同一范式）。
 *
 * ⚠ 零依赖、零时钟：`nowMs` 一律由调用方传入（判据不得依赖真实墙钟）。
 */

/** 毫秒 → 人话时长（"已卡 2 小时 5 分钟"用）。负数/非数 ⇒ `''`（不编一个 0）。 */
export function durationText(ms: number | null | undefined): string {
  const v = Number(ms);
  if (ms == null || !Number.isFinite(v) || v < 0) return '';
  const sec = Math.round(v / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  if (hr < 24) return rest > 0 ? `${hr} 小时 ${rest} 分钟` : `${hr} 小时`;
  const day = Math.floor(hr / 24);
  return `${day} 天`;
}
