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
 * **不给缺失估时兜底一个默认步数**——没有许诺者的数字不得凭空造出（承 zx_20260910_6 口径）。
 *
 * zx_20261021_4 批四：「恢复续额」`bonusSteps` 加在取大结果**之上**（不复与它取大）——
 * 续额的语义是"在上一轮实际用尽的上限之外，再加这么多步"，不是"换一个更宽松的公式再算一遍"。
 * 真库标本 `03c71f39`：估算 40 步、实跑 90 步撞顶；用户恢复一次、原样再撞一次——上限成了天花板而非预算。 */
export function resolveMaxSteps(baseMaxSteps: number, sizeMultiplier: number, estSteps: number, bonusSteps = 0): number {
  const base = Math.max(Math.round(baseMaxSteps * sizeMultiplier), estSteps > 0 ? Math.ceil(estSteps * 1.5) : 0);
  const bonus = Number.isFinite(bonusSteps) && bonusSteps > 0 ? Math.ceil(bonusSteps) : 0;
  return base + bonus;
}

/**
 * zx_20261021_4 批四：撞顶时**发一次续额**——把本次上限计入 `step_budget_bonus`，至多 {@link STEP_CAP_GRANT_LIMIT} 次。
 *
 * 有界是硬约束：无界续额等于"上限不存在"，一次模型死循环就能把 token 烧穿。
 * 三次封顶后 `granted=false`，恢复仍是原上限——此时人该做的是核验产出或拆小任务，不是再点一次恢复。
 *
 * 直接改传入的 `ctxJson`（调用方负责落库），返回本次结果供文案与账目使用。 */
export const STEP_CAP_GRANT_LIMIT = 3;

export interface StepCapGrantResult {
  /** 累计续额（步） */
  bonus: number;
  /** 本次新增的续额（未发为 0） */
  grantedSteps: number;
  granted: boolean;
  /** 含本次在内的续额次数 */
  grants: number;
  limit: number;
}

export function grantStepBudgetOnCapHit(ctxJson: unknown, maxSteps: number): StepCapGrantResult {
  const o = ctxJson && typeof ctxJson === 'object' ? ctxJson as Record<string, unknown> : null;
  const grants = Math.max(0, Math.floor(Number(o?.step_cap_grants) || 0));
  const bonus = Math.max(0, Math.floor(Number(o?.step_budget_bonus) || 0));
  const limit = STEP_CAP_GRANT_LIMIT;
  if (!o || !(maxSteps > 0) || !Number.isFinite(maxSteps)) {
    return { bonus, grantedSteps: 0, granted: false, grants, limit };
  }
  if (grants >= limit) return { bonus, grantedSteps: 0, granted: false, grants, limit };
  const grantedSteps = Math.ceil(maxSteps);
  const nextBonus = bonus + grantedSteps;
  const nextGrants = grants + 1;
  o.step_budget_bonus = nextBonus;
  o.step_cap_grants = nextGrants;
  return { bonus: nextBonus, grantedSteps, granted: true, grants: nextGrants, limit };
}

/** 上一次撞顶留下的续额账（`ctx.step_cap_hit`）；没撞过顶 ⇒ `null`。 */
export interface StepCapContinuation {
  grantedSteps: number;
  granted: boolean;
  grants: number;
  limit: number;
}

export function stepCapContinuationOf(ctxJson: unknown): StepCapContinuation | null {
  const hit = (ctxJson as { step_cap_hit?: Record<string, unknown> } | null | undefined)?.step_cap_hit;
  if (!hit || typeof hit !== 'object') return null;
  const grantedSteps = Math.max(0, Math.floor(Number(hit.resume_bonus) || 0));
  const grants = Math.max(0, Math.floor(Number(hit.count) || 0));
  return { grantedSteps, granted: grantedSteps > 0, grants, limit: STEP_CAP_GRANT_LIMIT };
}

/** 撞顶续额的如实告知：**发没发、发多少、还能不能发**，三者都要说出来。 */
export function buildStepContinuationNote(c: StepCapContinuation): string {
  return c.granted
    ? `[步数续额] 本次上限已计入续额：恢复后将获 ${c.grantedSteps} 步续额（第 ${c.grants}/${c.limit} 次），可点「恢复继续」按原目标接着做。`
    : `[步数续额已用尽] 续额已用满 ${c.limit} 次，恢复不会再增加步数上限——请核验已产出的内容后人工收口，或把剩余工作拆成更小的任务。`;
}

/**
 * zx_20261022_3 批十二（毛选·实事求是）：**撞顶续额是否该自动续跑**。
 *
 * 病根（真标本 1ec0a89a）：引擎撞顶当刻已发续额（`step_budget_bonus=86`），任务却停在 paused
 * 等人工点「恢复继续」——续额发了不用，等于没发。本判据只认"**引擎自己发过的那一笔**"：
 * `step_cap_hit.resume_bonus > 0` ∧ 未标记 `auto_resumed` ∧ 次数未到上限。
 * 三条任一不成立即 `due=false`，绝不把"续额用尽/从未撞顶"的任务偷偷拉起。
 */
export function shouldAutoResumeOnStepCap(ctxJson: unknown): { due: boolean; reason: string; grants: number; limit: number } {
  const o = ctxJson && typeof ctxJson === 'object' ? ctxJson as Record<string, unknown> : null;
  const hit = o?.step_cap_hit as Record<string, unknown> | undefined;
  const grants = Math.max(0, Math.floor(Number(o?.step_cap_grants) || 0));
  const limit = STEP_CAP_GRANT_LIMIT;
  if (!hit || typeof hit !== 'object') return { due: false, reason: '本轮无撞顶账', grants, limit };
  if (hit.auto_resumed) return { due: false, reason: '本次撞顶已自动续跑过', grants, limit };
  const resumeBonus = Math.max(0, Math.floor(Number(hit.resume_bonus) || 0));
  if (resumeBonus <= 0) return { due: false, reason: '续额已用尽（未发新额度）', grants, limit };
  if (grants > limit) return { due: false, reason: `续额次数 ${grants} 已超上限 ${limit}`, grants, limit };
  return { due: true, reason: `已发 ${resumeBonus} 步续额（第 ${grants}/${limit} 次），自动续跑`, grants, limit };
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
