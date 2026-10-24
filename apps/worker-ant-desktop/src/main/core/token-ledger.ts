/**
 * zx_20261018_1 批七「账」（管子·度量衡 / 维特根斯坦·一个数只能有一个值）：
 * 上下文的**七源分账**——纯函数、零依赖（只依赖 `token-estimate.ts` 的既有口径）。
 *
 * 病根：`context_watermark.approxTokens` 只有一个总数。总量超了，用户与维护者都无从回答
 *   "这钱花在哪一源"；而七源各有各的上游裁法（记忆按段、历史按尾、知识按节），谁都量不了全局。
 *   本模块把总量拆成七份，每份都走 `estimateTokensFromChars` **同一把尺**。
 *
 * 口径：
 *   · 七源固定为 `TOKEN_SOURCES`；**表外键一律记 0**（不把未知来源塞进分账，否则和数对不上）。
 *   · `totalTokens` = 各源 token **逐项相加**，**不是**「总字符再除 4」——两张账必须能对上
 *     （逐项取整后相加，与先加后除必然差几个 token；分账之和等于总量是 R-55 的正面断言）。
 *   · 字符数一律取非负整数：负数/NaN/Infinity ⇒ 0（账里不出现负值）。
 */
import { estimateTokensFromChars } from './token-estimate.js';

/** 七源（顺序即报表顺序）。 */
export const TOKEN_SOURCES = ['system', 'memory', 'knowledge', 'history', 'tools', 'user', 'output'] as const;
export type TokenSource = (typeof TOKEN_SOURCES)[number];
export type TokenChars = Record<TokenSource, number>;
export type TokenTokens = Record<TokenSource, number>;

/** 七源齐备的零账——`Record` 形状本身就是"七源齐备"的判据。 */
export function emptyTokenChars(): TokenChars {
  return { system: 0, memory: 0, knowledge: 0, history: 0, tools: 0, user: 0, output: 0 };
}

export interface TokenLedger {
  /** 每源字符数（整数、非负）。 */
  chars: TokenChars;
  /** 每源 token 估算（`chars ÷ 4` 上取整，逐项算）。 */
  tokens: TokenTokens;
  /** 七源字符之和。 */
  totalChars: number;
  /** 七源 token 之和——**分账之和**，不是总量的二次取整。 */
  totalTokens: number;
}

function sanitizeCharCount(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

/** 由各源字符数生成分账。表外键忽略（不参与总和）。 */
export function ledgerFromChars(input: Partial<Record<string, number>> = {}): TokenLedger {
  const chars = emptyTokenChars();
  const tokens = { ...chars } as TokenTokens;
  for (const src of TOKEN_SOURCES) {
    const c = sanitizeCharCount(input[src]);
    chars[src] = c;
    tokens[src] = estimateTokensFromChars(c);
  }
  const totalChars = TOKEN_SOURCES.reduce((n, s) => n + chars[s], 0);
  const totalTokens = TOKEN_SOURCES.reduce((n, s) => n + tokens[s], 0);
  return { chars, tokens, totalChars, totalTokens };
}

/** 只把某一源的字符数换掉（收口时补上 `output`），其余原样——账的其余六源不动。 */
export function withSourceChars(ledger: TokenLedger, source: TokenSource, chars: number): TokenLedger {
  const next: Partial<Record<string, number>> = { ...ledger.chars, [source]: chars };
  return ledgerFromChars(next);
}
