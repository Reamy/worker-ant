/**
 * zx_20261115_3 M6「简」（管子·度量衡）：任务详情「上下文与成本」的**读侧纯函数**。
 *
 * 只读派生，零依赖：
 *   · 七源分账取 `context_json.execution_metrics.token_breakdown`（引擎落账，同一把 chars÷4 尺）；
 *   · 费用/实报 token 取 `context_json.cost_estimate`；
 *   · **未记录 ≠ 0**：缺键 ⇒ `ledger: null`；坏 JSON ⇒ `error` 如实带出（不吞成"没有账"）。
 */
export interface ContextLedgerView {
  tokens: Record<string, number> | null;
  chars: Record<string, number> | null;
  totalTokens: number | null;
  totalChars: number | null;
  budgetTokens: number | null;
  trimmedChars: Record<string, number> | null;
  overBudget: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}

export interface ContextLedgerBuild {
  ledger: ContextLedgerView | null;
  error: string;
}

function numRecord(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(x);
    if (Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function buildContextLedgerView(rawContextJson: string | null | undefined): ContextLedgerBuild {
  let ctx: {
    execution_metrics?: { token_breakdown?: Record<string, unknown> };
    cost_estimate?: { inputTokens?: unknown; outputTokens?: unknown; cost?: unknown };
  };
  try {
    const parsed = JSON.parse(String(rawContextJson ?? '{}'));
    ctx = parsed && typeof parsed === 'object' ? (parsed as typeof ctx) : {};
  } catch (e) {
    return { ledger: null, error: `上下文账解析失败：${(e as Error)?.message || String(e)}` };
  }
  const tb = ctx.execution_metrics?.token_breakdown;
  if (!tb || typeof tb !== 'object') return { ledger: null, error: '' };
  const cost = ctx.cost_estimate ?? {};
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    ledger: {
      tokens: numRecord(tb.tokens),
      chars: numRecord(tb.chars),
      totalTokens: num(tb.totalTokens),
      totalChars: num(tb.totalChars),
      budgetTokens: num(tb.budgetTokens),
      trimmedChars: numRecord(tb.trimmedChars),
      overBudget: typeof tb.overBudget === 'boolean' ? tb.overBudget : null,
      inputTokens: num(cost.inputTokens),
      outputTokens: num(cost.outputTokens),
      cost: num(cost.cost),
    },
    error: '',
  };
}
