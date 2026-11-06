/**
 * zx_20261018_1 批七「账」（道德经·知止 / 管子·度量衡）：**最小 token 的裁法**。
 *
 * 只回答两件事，且都是纯函数：
 *   ① 给定七源字符数与总预算，超了该按什么顺序裁、每源裁掉多少字（`applyContextBudget`）；
 *   ② 各源的上限从哪来（`caps` 入参，由调用方用**既有常量**派生，本模块不另立阈值）。
 *
 * 铁律（R-56）：裁只动 `knowledge → memory → history` 三源，**顺序即优先级**；
 *   `user / acceptance / system / tools / output` **一个字符都不裁**——用户的请求、验收标准、
 *   系统骨架与工具 schema 是"任务"本身，省它们等于改名换义。
 *
 * 裁法：把「需减的 token」换成「需减的字符」= `need × TOKEN_CHARS_PER_UNIT`，从当前源里按字符砍；
 *   逐源重算后继续，直到达标或三个可裁源全部见底。见底仍超 ⇒ `overAfter: true` **如实返回**
 *   （不裁不可裁的源来凑数，也不谎报"已达标"）。
 */
import { estimateTokensFromChars, TOKEN_CHARS_PER_UNIT } from './token-estimate.js';
import { emptyTokenChars, type TokenChars, type TokenSource, type TokenTokens } from './token-ledger.js';

/** 裁剪顺序（唯一真源）：先知识、再记忆、最后历史。 */
export const CONTEXT_TRIM_ORDER = ['knowledge', 'memory', 'history'] as const;
/** 永不裁的源：用户请求 / 验收标准 / 系统骨架 / 工具 schema / 产出。`acceptance` 在账上并入 `system`，但名字保留在名单里。 */
export const CONTEXT_NEVER_TRIM = ['user', 'acceptance', 'system', 'tools', 'output'] as const;

export interface ContextBudgetInput {
  chars: Partial<Record<string, number>>;
  /** 总预算（token）。 */
  budgetTokens: number;
  /** 七源各自的上限（token）。调用方用既有常量派生；缺省不限。 */
  capsTokens?: Partial<Record<TokenSource, number>>;
}

export interface ContextBudgetResult {
  /** 裁剪后的每源字符数（七源齐备）。 */
  chars: TokenChars;
  /** 每源被裁字符数（七源齐备，未裁者 0）——R-57 的账。 */
  trimmedChars: TokenChars;
  totalTokensBefore: number;
  totalTokensAfter: number;
  trimmedTokens: TokenTokens;
  budgetTokens: number;
  overBefore: boolean;
  overAfter: boolean;
  /** 调用方回传的上限（原样带出，供落账；本函数不据此另裁）。 */
  capsTokens: Partial<Record<TokenSource, number>>;
}

function toChars(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/**
 * 超预算 ⇒ 按 `knowledge → memory → history` 裁，记录每源被裁字符数。
 * 未超预算 ⇒ 原样返回（`trimmedChars` 全 0）——两只标本都要走这一个函数。
 */
export function applyContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  const chars = emptyTokenChars();
  for (const src of Object.keys(chars) as TokenSource[]) chars[src] = toChars(input.chars[src]);
  const trimmedChars = emptyTokenChars();
  const capsTokens = input.capsTokens ?? {};
  const budgetTokens = Math.max(0, Math.floor(input.budgetTokens));

  const sumTokens = (): number =>
    (Object.keys(chars) as TokenSource[]).reduce((n, s) => n + estimateTokensFromChars(chars[s]), 0);

  const totalTokensBefore = sumTokens();
  let over = totalTokensBefore - budgetTokens;
  for (const src of CONTEXT_TRIM_ORDER) {
    if (over <= 0) break;
    const cur = chars[src];
    if (cur <= 0) continue;
    // 每 4 字 ≈ 1 token：减 `over` 个 token 至少要砍这么多字符；不足则把本源砍空。
    const cut = Math.min(cur, over * TOKEN_CHARS_PER_UNIT);
    if (cut <= 0) continue;
    chars[src] = cur - cut;
    trimmedChars[src] = cut;
    over -= estimateTokensFromChars(cur) - estimateTokensFromChars(chars[src]);
  }
  const totalTokensAfter = sumTokens();
  const trimmedTokens = { ...trimmedChars } as TokenTokens;
  for (const src of Object.keys(trimmedTokens) as TokenSource[]) {
    trimmedTokens[src] = estimateTokensFromChars(trimmedChars[src]);
  }
  return {
    chars,
    trimmedChars,
    totalTokensBefore,
    totalTokensAfter,
    trimmedTokens,
    budgetTokens,
    overBefore: totalTokensBefore > budgetTokens,
    overAfter: totalTokensAfter > budgetTokens,
    capsTokens,
  };
}
