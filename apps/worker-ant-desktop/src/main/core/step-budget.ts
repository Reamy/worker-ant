/**
 * 步数预算：上限怎么定、撞顶怎么算、撞顶了怎么说——**一处真源**（zx_20260916_1 M4 / #5）。
 *
 * 为什么单独成模块：这三条原先是**内联**在 agent-executor 的巨型函数里（`maxSteps` 公式）或
 * 干脆不存在（撞顶判定与告知）。内联的判据 rr 碰不到，只能自造等价入参去断言——那样的断言
 * 是在自我印证，不是在验生产。抽成纯函数（零 electron / 零 DB / 零 IO）后，rr 跑的就是
 * 生产同一份实现。
 *
 * ## 两把尺**刻意不同，勿合并**（下轮若想"归一"，先读这段）
 *
 * - `stepsCapReached`（本模块）：`stepCount >= maxSteps`。语义是**已经**被上限所截——用于**交付文本里的断言**，
 *   必须为真才准写。
 * - `agent-executor` 里的 `prematureEnd` / `wasPremature`：`stepCount >= maxSteps - 2`。语义是**可能**被截
 *   （留 2 步给收尾），是**闸门/标记**用的缓冲，件件都要求"铁证"会把两件确有其事的截断漏掉。
 *
 * 合并二者只有两条路：把"可能"写成"已"（交付文本变假），或把闸门收窄到 `>= maxSteps`（改语义、放松了拦截）。
 * 两条都不取。故并列实现，各自命名把语义写进方法名。
 */

/** 步数上限：基准步数 × 项目规模系数，与估时步数的 1.5 倍**取大**。
 *
 * 取大的理由（承 A2）：`base` 是原型/学习策略的**经验值**，`sizeMultiplier` 只看文件数；
 * 而 `task_estimate.steps` 是**本任务同类历史样本**的加权平均步数（`:3014` 写入）。三者都不代表本任务上限，
 * 取大是"至少给足历史同类所需的 1.5 倍"——宁可多给步数让模型自己停，也不要因上限把任务腰斩
 * （与 `:2767` 既有注释"历史平均步数不代表上限"同尺）。
 *
 * `estSteps <= 0`（无历史样本 / 缺 `task_estimate`）⇒ 右项为 0，`max` 落回 `round(base × mult)` 原值。
 * **不给缺失估时兜底一个默认步数**——没有许诺者的数字不得凭空造出（承 zx_20260910_6 口径）。 */
export function resolveMaxSteps(baseMaxSteps: number, sizeMultiplier: number, estSteps: number): number {
  return Math.max(Math.round(baseMaxSteps * sizeMultiplier), estSteps > 0 ? Math.ceil(estSteps * 1.5) : 0);
}

/** 步数**确实**撞顶：本步执行到上限即止（`stepCount` 计的是已完成步数，故"用满"即 `>= maxSteps`）。
 *
 * 只用于"可以对外断言"的场合（交付文本）。闸门/标记的"可能撞顶"请用 agent-executor 里的 `maxSteps - 2` 那把尺。 */
export function stepsCapReached(maxSteps: number, stepCount: number): boolean {
  return maxSteps > 0 && stepCount >= maxSteps;
}

/**
 * zx_20260922_1 M6（F8）· 「预算到没到顶」的**唯一判据**——放行侧与禁用侧读的是**同一个 `band`**。
 *
 * **病根**（真库标本 `a290ae2b`）：同一句"预算爆没爆"，两处读不同的表。
 * 禁用侧按 `max(tokenBand, costBand)` **双尺取严**（费用尺爆表即禁工具），
 * 而放行侧（`tools/control.ts` 的 `forcedByBudget`、本文件消费者 `prematureEnd`）只读 **Token 尺**的
 * `budget_usage_ratio` ⇒ 费用尺 109% 把 `bash`/`read_file`/`edit_file` 全禁光的同时，
 * 闸门判"没到顶（14%）"照常拦收口 —— **干不了活 + 不许收口** 同时成立 = 夹死。
 *
 * **真源**是 `context_json.budget_warn_band`（`agent-executor.ts` 预算追踪段**一处**算出并写回）。
 * 取 `>= 4`：band 4 = 95% 档，正是系统**首次宣告「预算超限」**、开始禁探索类工具的那一档；
 * band 5 = 98% 档（硬上限，连 read/execute 一并禁）。判据取**首次宣告**那一档，
 * 因为"放行"是为了解开死结、不是为了等到更晚。
 *
 * **兼容性**：此式是旧式 `budget_usage_ratio >= 0.95` 的**严格超集**——
 * 旧式 ⟺ `tokenBand >= 4`，而 `max(tokenBand, costBand) >= 4` 在 `tokenBand >= 4` 时必然成立。
 * ⇒ **没有任何一处原先放行的收口现在会变得不放行**；新增放行的恰是"费用尺到顶而 Token 尺未到"这一病态情形。
 */
export const BUDGET_BAND_CAP = 4;

export function budgetCapReached(ctxJson: unknown): boolean {
  const band = Number((ctxJson as { budget_warn_band?: unknown } | null | undefined)?.budget_warn_band) || 0;
  return band >= BUDGET_BAND_CAP;
}

/** 撞顶的如实告知——注入最终交付文本。
 *
 * 治的病（§1.5）：模型在步数用尽时被 SDK 截停，收尾文本只剩一句拼接的"开始 M0…开始 M2"，
 * 用户无从判断任务其实**没做完**，只当它做完了。故把"未完成、仅为上限所截"这句**事实**写进交付文本，
 * 并带上任务目标里还没做完的部分，供人接手。
 *
 * `goal` 为空则如实只说截断、不编"剩余工作"。 */
export function buildStepCapNote(maxSteps: number, goal: string): string {
  const rest = (goal || '').trim();
  return `[步数上限已到] 步数上限（${maxSteps}）已到：任务**未完成**，仅为上限所截，请勿视为交付完成。`
    + (rest ? `剩余工作：${rest}` : '请核验已产出的内容并决定是否恢复继续。');
}
