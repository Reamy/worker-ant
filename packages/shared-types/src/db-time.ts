/**
 * 库内时间列的**解析真源**（zx_20261011_4 M3：由 renderer 的 `deliverable-view.ts` 上移至此）。
 *
 * 为什么要上移到 shared-types：库内时间列是 UTC 且**不带 `Z`**（`datetime('now')` 的产物），
 *   直接喂 `new Date` 会被按**本地时区**解析 ⇒ 差 8 小时。凡"这个时刻离现在多久"的判据
 *   （在线/离线、快照是否陈旧、任务是否卡死）都要先过这一步——而这类判据现在**两侧都要**
 *   （renderer 面板判在线 ∧ main 编排预查判在线，见 `isNodeOnline`）。
 *   两份实现即"同一件事两处各记各的"，任一份修了时区另一份不跟（承 auto-memory
 *   `feedback_timezone_clock_basis` 与「一个概念一个值」）。故收此一处。
 *
 * ⚠ 本文件**零依赖**（纯函数）——shared-types 不引 electron / better-sqlite3 / renderer。
 */

/**
 * 库内时间列（SQLite `datetime('now')` = UTC、且不带 `Z`）→ `Date`。
 * 空值与非法值返回 `null`（"没有这个时间"不伪造成某个时刻）。
 * 本来就是 ISO（带 `Z`/偏移）的照原样解析——只有不带时区的才补 `Z`。
 */
export function parseDbTime(s?: string | null): Date | null {
  if (!s) return null;
  try {
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
    // 纯日期（YYYY-MM-DD）本身就按 UTC 解析，再补 `Z` 反而变成非法串
    const iso = hasZone || /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}
