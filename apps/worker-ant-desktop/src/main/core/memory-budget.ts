/**
 * zx_20261101_2 M5（道德经·知止 / 管子·度量衡）: 记忆上下文预算随模型窗口与任务体量自适应。
 *
 * 病根：`CTX_MEMORY_MAX_CHARS` 只有一个固定值——128k 窗口的模型与 8k 窗口的模型拿同样多的记忆预算；
 * 一句话的小任务与长文任务也拿同样多。预算不跟着真实容量走，要么浪费（大窗口用不满），
 * 要么挤占（小窗口被记忆吃掉装配空间）。
 *
 * 口径（纯函数，零依赖，rr 直跑）：
 *   · 基准 = 窗口 12% 的字符量（按 4 字符/token 折算），再夹在 [3000, 24000] 内；
 *   · 小任务（标题+描述 < 2000 字符）再打 6 折——任务本身没多少信息，记忆不必铺满；
 *   · 下限 2000 字符（再少记忆块就没有意义）；
 *   · 上限不超过窗口 20% 的字符量（窗口极小时以 2000 下限为准，宁可留一段有用记忆）。
 *   · 窗口非法（非有限值 / ≤0）⇒ 回 `MEMORY_BUDGET_DEFAULT_CHARS`，不猜。
 */

/** 缺省预算（= 旧 `CTX_MEMORY_MAX_CHARS` 的取值；未知窗口时用它，也是真源常量）。 */
export const MEMORY_BUDGET_DEFAULT_CHARS = 6000;
/** 预算下限（字符）。 */
export const MEMORY_BUDGET_MIN_CHARS = 2000;
/** 基准夹取范围（字符）。 */
export const MEMORY_BUDGET_BASE_MIN_CHARS = 3000;
export const MEMORY_BUDGET_BASE_MAX_CHARS = 24000;
/** 基准占窗口的份额（字符口径 = token × 4 × 0.12）。 */
export const MEMORY_BUDGET_WINDOW_SHARE = 0.12;
/** 硬上限占窗口的份额（不超过窗口 20%）。 */
export const MEMORY_BUDGET_WINDOW_CAP_SHARE = 0.2;
/** 小任务判定阈值（标题+描述字符数）。 */
export const MEMORY_BUDGET_SMALL_TASK_CHARS = 2000;
export const MEMORY_BUDGET_SMALL_TASK_FACTOR = 0.6;
/** token→字符折算（与 `token-estimate.ts` 同为 4）。 */
const CHARS_PER_TOKEN = 4;

export function memoryBudgetCharsFor(o: { contextWindowTokens: number; taskChars: number }): number {
  const window = Number(o?.contextWindowTokens);
  if (!Number.isFinite(window) || window <= 0) return MEMORY_BUDGET_DEFAULT_CHARS;

  let chars = Math.min(
    MEMORY_BUDGET_BASE_MAX_CHARS,
    Math.max(MEMORY_BUDGET_BASE_MIN_CHARS, Math.round(window * CHARS_PER_TOKEN * MEMORY_BUDGET_WINDOW_SHARE)),
  );

  const taskChars = Number(o?.taskChars);
  // 非法任务体量**不当作小任务**——"量不出"与"确实小"是两件事，后者才打折。
  if (Number.isFinite(taskChars) && taskChars < MEMORY_BUDGET_SMALL_TASK_CHARS) {
    chars = Math.round(chars * MEMORY_BUDGET_SMALL_TASK_FACTOR);
  }

  const windowCap = Math.max(
    MEMORY_BUDGET_MIN_CHARS,
    Math.round(window * CHARS_PER_TOKEN * MEMORY_BUDGET_WINDOW_CAP_SHARE),
  );
  return Math.min(windowCap, Math.max(MEMORY_BUDGET_MIN_CHARS, chars));
}
