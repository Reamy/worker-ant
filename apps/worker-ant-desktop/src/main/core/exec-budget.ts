/**
 * zx_20260921 M8（重构·只动形不动义）: `executeTask` 的**预算段**——项目/任务级 Token 与金额上限的解析、
 * 保底默认、费用闸两态如实告知、项目预算过低提示。
 *
 * 搬迁来源：`core/agent-executor.ts` 的 `executeTask` 原 `:1361`–`:1417`，**逐行搬运**，只加函数包裹层、
 * 把外部读值提成参数（`db`·`taskId` / `projectBudget` / `modeBudget` / `archetype` / 两侧单价），
 * 并把段内对 `maxTokens` 的**就地改写**收敛成函数末尾的一次返回。
 *
 * **本模块是纯计算 + 如实告知**，不写任何任务行：段内那几处 `INSERT INTO wa_task_conversations` 是
 * "把判断结果说给用户听"（不是状态变更），照搬不变。`budget_max_tokens/budget_max_cost/cost_budget_src`
 * 落 `context_json` 的那一步**留在调用方**——它与 `archetype`/`archetype_label` 同属一个 ctx 镜像写，
 * 不在本段职责内，且搬走会把 `adaptiveStrategy` 也拖进来（越拆越散）。
 *
 * **两个项目上下文读取点**：调用方自带 `projCtxJson`（下游 `language_game` 还要用），本模块只收
 * 它派生出的 `projectBudget`——避免同一份 `context_json` 被 parse 两次。
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { resolveCostBudget } from './agent-executor.js';
import { ARCHETYPE_BUDGETS, type TaskArchetype } from './task-archetype.js';

export interface BudgetResolution {
  /** 最终 Token 预算（任务级 > 项目级 > 原型默认 > 保底 250k）。 */
  maxTokens: number;
  /** 金额上限；**无许诺者时为 0**（0 = 没有闸，不是"闸在 0 元"）。 */
  maxCost: number;
  /** 上限来源：任务级 / 项目级 / **无**。GUI 靠它区分"未设金额闸"与"设了但模型未定价"。 */
  costSrc: 'task' | 'project' | 'none';
  /** 费用闸是否**真的成立**（有人许了上限 **且** 模型已定价）——两个条件缺一即假。 */
  costGateActive: boolean;
}

export function resolveTaskBudget(o: {
  db: Database.Database;
  taskId: string;
  /** 项目级预算：`project.context_json.budget || {}`（调用方已解析，本模块不再 parse 一遍）。 */
  projectBudget: { max_tokens_per_task?: number; max_cost_usd_per_task?: number };
  /** 执行模式叠加后的原型预算（`modeApplied.budget`）——注意取 `.tokens` 一个值。 */
  modeBudget: { tokens: number };
  archetype: TaskArchetype;
  inputPricePer1k: number;
  outputPricePer1k: number;
}): BudgetResolution {
  const { db, taskId, projectBudget, modeBudget, archetype, inputPricePer1k, outputPricePer1k } = o;
  // zx_20260910_5 M2b: 任务级预算覆盖补上「最后一环」。任务详情页「任务预算」编辑经 task:context
  // 把 max_tokens_per_task / max_cost_usd_per_task 合并写入**任务** context_json 顶层，
  // 而引擎此前只读**项目**级 budget ⇒ 该输入是**死输入**（真库只读实测：132 个任务 0 条有值，从未生效）。
  // 一个写着「费用预算（¥ 人民币/任务）」的输入框若不改变任何行为，正是本轮要消灭的「名实不符」。
  const taskBudCtx = (() => {
    try { return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as { max_tokens_per_task?: number; max_cost_usd_per_task?: number }; }
    catch { return {} as { max_tokens_per_task?: number; max_cost_usd_per_task?: number }; }
  })();
  let maxTokens = Number(taskBudCtx.max_tokens_per_task) || (projectBudget.max_tokens_per_task as number) || modeBudget.tokens;
  // zx_20260910_4 C1: 字段名 max_cost_usd_per_task 是**历史误名**——本仓成本自 zx_20260904_7 起统一按
  // 人民币(CNY)计费（见 `agent-executor.ts` 上方 USD_TO_CNY_RATE/cnyFactor 与收口处 currency:'CNY'
  // ——M8 搬迁后这两个符号仍在执行体，勿按"本文件"去找）。
  // 此值按 ¥ 存、按 ¥ 用、按 ¥ 展示，勿据字段名把展示改回 $。
  // zx_20260910_6 M1: 金额上限带**来源**解析（任务级 > 项目级 > 无）。
  // 原先末端还有 `|| modeApplied.budget.cost`（原型默认金额），使从未标定的常量冒充「用户设的上限」——
  // 该兜底已随 ARCHETYPE_BUDGETS.cost 一并删除。无显式设置 ⇒ maxCost=0（无金额闸），
  // 但 cost_used 仍照常累计与落库（**没有上限 ≠ 没有账**）。
  const { maxCost, src: costSrc } = resolveCostBudget(taskBudCtx, projectBudget as { max_cost_usd_per_task?: number });
  // B1 (2026-09-03_3): 默认预算保底——项目/原型预算缺省或 ≤0 时给保守默认，使 E3 band(60/75/95/98) 真实触发（防"未设预算无限烧"）
  if (!maxTokens || maxTokens <= 0) {
    const archTokens = (ARCHETYPE_BUDGETS[archetype] as { tokens?: number } | undefined)?.tokens;
    maxTokens = archTokens && archTokens > 0 ? archTokens : 250_000;
    try {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), taskId, `[预算提示] 该项目/原型未配置有效 Token 预算，已启用默认安全上限 ${maxTokens.toLocaleString()} token（60%/75% 收敛提示、95% 禁探索、98% 硬收尾强制产出；跨恢复累计计入）。可在项目设置中调整。`);
    } catch { /* ignore */ }
  }
  // zx_20260910_5 M1b (X5): 原 D1「跨 resume 累计起点」budgetAccumStart ← budget_accum 已删除。
  // 该双计数跨 resume 重复计入（totalTokensUsed 恢复时已含历史，再加历史一次），真库实测
  // budget_usage_ratio 最高 20.96（2096%），令恢复过的任务开头即可能落 band 5 被禁工具。
  // 现改为单计数器 totalTokensUsed（见下方恢复逻辑与 ratio 计算），与费用侧同口径。
  // zx_20260910_5 M1 / zx_20260910_6 M1: 费用闸成立条件校验（缘起性空——条件具足则法生，不具足则如实说无）。
  // 成立需两个条件同时具足：①有人显式许下上限（costSrc!=='none' ⇒ maxCost>0）②模型已定价（单价非 0）。
  // 两条不具足的路径**如实分开说**（不混为一句"未生效"，也不静默）：
  //   - 未设上限：本就没有闸，谈不上"失效" ⇒ [费用闸未启用]，只收敛不设金额硬闸。
  //   - 设了但未定价：条件不具足 ⇒ [费用闸未生效]（沿用 zx_20260910_5 路径）。
  const costGateActive = maxCost > 0 && (inputPricePer1k + outputPricePer1k) > 0;
  if (costSrc === 'none') {
    try {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), taskId, `[费用闸未启用] 本任务未设置金额上限，仅按 Token 预算（${maxTokens.toLocaleString()} tokens）收敛；费用照常累计与展示。如需金额硬闸，请在项目或任务设置中填写费用上限。`);
    } catch { /* ignore */ }
  } else if (!costGateActive) {
    try {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), taskId, `[费用闸未生效] 已配置费用上限 ¥${maxCost.toFixed(2)}（来源：${costSrc === 'task' ? '任务级' : '项目级'}），但所选模型未配置单价（input/output_price_per_1k 均为 0），费用无法计量 ⇒ 费用闸不生效，仅 Token 闸生效。如需费用闸，请在模型管理中为该模型配置单价。`);
    } catch { /* ignore */ }
  }

  // Phase E (2026-08-28 zx_3): 项目预算校验——项目自定义预算低于该类型默认预算 50% 时提示（避免频繁超限却不知情）
  try {
    const projBudgetTokens = Number(projectBudget.max_tokens_per_task);
    const defaultTokens = ARCHETYPE_BUDGETS[archetype].tokens;
    if (projBudgetTokens > 0 && projBudgetTokens < defaultTokens * 0.5) {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), taskId, `[预算提示] 项目自定义预算 ${projBudgetTokens.toLocaleString()} token 低于该类型(${archetype})默认预算 ${defaultTokens.toLocaleString()} 的 50%，可能频繁超限，建议在项目设置中上调。`);
    }
  } catch { /* 预算校验 best-effort */ }
  return { maxTokens, maxCost, costSrc, costGateActive };
}
