/**
 * zx_20261018_1 批七「账」（王阳明·知行合一 / 道德经·少则得）：`execution_metrics` 的**唯一写口**。
 *
 * 病根（zx_20260928 D4 的老账）：`execution_metrics` 有**四个收口出口**（finalize_completed /
 *   finalize_paused / run_close / 旁路 token 并账 reconcile）。此前每个出口各写一段 JSON——
 *   形状靠"逐字同构"的口头约定维持：谁多写一个键、谁漏写一个键，读方（产出率 / 步数估计 /
 *   archetype 统计）都读不出来，且**没有一处能保证它们写的是同一件事**。
 *
 * 本模块把"写"收成一处：
 *   · `writeExecutionMetrics` —— 合并进 `context_json.execution_metrics`（**保留未知兄弟键**，
 *     不做裸对象整体覆写——`feedback_json_column_overwrite_wipes_siblings`），并附带
 *     `token_breakdown`（七源分账，批七新增）。
 *   · `reconcileExecutionTokens` —— 旁路子 LLM 的 token 并账（收口内容门在首次落账后才发生的花费），
 *     同一处改 `cost_estimate.tokens` 与 `execution_metrics.totalTokens`，不再两段各改一半。
 *
 * 纪律：本模块只认 `taskId` 与既有 `context_json`；不读任务行以外的东西、不触别表。
 */
import type Database from 'better-sqlite3';
import type { TokenChars, TokenLedger } from './token-ledger.js';

/** 落进 `execution_metrics.token_breakdown` 的形状（七源齐备 + 裁剪账）。 */
export interface TokenBreakdownRecord extends TokenLedger {
  /** 每源被预算裁掉的字符数（七源齐备，未裁者 0）。 */
  trimmedChars: TokenChars;
  /** 本次上下文预算（token）。0 ⇒ 未启用预算。 */
  budgetTokens: number;
  /** 裁完仍超预算（不可裁的源本身即超）——如实落账，不谎报达标。 */
  overBudget: boolean;
}

export interface ExecutionMetricsInput {
  archetype: string;
  stepsUsed: number;
  totalTokens: number;
  hasDeliverable: boolean;
  tokenBreakdown?: TokenBreakdownRecord;
}

function readContextJson(db: Database.Database, taskId: string): Record<string, unknown> {
  const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
  return JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
}

function writeContextJson(db: Database.Database, taskId: string, ctx: Record<string, unknown>): void {
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
}

/**
 * 合并写 `execution_metrics`。四个出口都调它——同一形状、同一处、同一把尺。
 * 失败向上抛（调用方各自的 try/catch 保留既有 best-effort 语义，不在此吞掉）。
 */
export function writeExecutionMetrics(db: Database.Database, taskId: string, input: ExecutionMetricsInput): void {
  const ctx = readContextJson(db, taskId);
  const prev = ctx.execution_metrics && typeof ctx.execution_metrics === 'object'
    ? (ctx.execution_metrics as Record<string, unknown>)
    : {};
  ctx.execution_metrics = {
    ...prev,
    archetype: input.archetype,
    stepsUsed: input.stepsUsed,
    totalTokens: input.totalTokens,
    hasDeliverable: input.hasDeliverable,
    ...(input.tokenBreakdown ? { token_breakdown: input.tokenBreakdown } : {}),
  };
  writeContextJson(db, taskId, ctx);
}

export interface ReconcileResult {
  changed: boolean;
  totalTokens: number;
}

/**
 * 旁路 token 并账：`sideNow > sideAtFirstPersist` 时把增量并回
 * `cost_estimate.tokens` / `cost_estimate.sideTokens` / `execution_metrics.totalTokens`。
 * 首次落账时已并入的部分**不重复加**（差值口径），与旧实现逐字同义。
 */
export function reconcileExecutionTokens(
  db: Database.Database,
  taskId: string,
  o: { fallbackTotal: number; sideNow: number; sideAtFirstPersist: number },
): ReconcileResult {
  if (!(o.sideNow > o.sideAtFirstPersist)) return { changed: false, totalTokens: o.fallbackTotal };
  const ctx = readContextJson(db, taskId);
  const cePrev = (ctx.cost_estimate as { tokens?: number } | undefined)?.tokens;
  const baseTotal = Number(cePrev) || o.fallbackTotal;
  const realNow = baseTotal + (o.sideNow - o.sideAtFirstPersist);
  if (ctx.cost_estimate && typeof ctx.cost_estimate === 'object') {
    (ctx.cost_estimate as Record<string, unknown>).tokens = realNow;
    (ctx.cost_estimate as Record<string, unknown>).sideTokens = o.sideNow;
  }
  if (ctx.execution_metrics && typeof ctx.execution_metrics === 'object') {
    (ctx.execution_metrics as Record<string, unknown>).totalTokens = realNow;
  }
  writeContextJson(db, taskId, ctx);
  return { changed: true, totalTokens: realNow };
}
