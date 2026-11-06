/**
 * zx_20261106_3 B7「通」: 外部 AI 终端的**双模协商**——意图优先、指令兜底。
 *
 * 病根：门内两种说话方式（意图两跳 `intent/resolve → intent/execute` 与原始 `invoke`）各走各的，
 *   终端该用哪一种**只在调用发生那一刻**由 `external-calls` 的许可闸判。用户在配对时看不见
 *   "这台终端进门后会怎么说话"，终端自己也不知道——协商结果没有落到任何一处可读之处。
 *
 * 判据（只此一条，纯函数）：
 *   - 门牌**未声明意图** ⇒ `invoke`（没有意图可言，谈不上意图协议）；
 *   - 门牌声明了意图 ∧ 已授予 `intent_control` ⇒ `intent`（意图优先）；
 *   - 门牌声明了意图 ∧ 未授予 `intent_control` ⇒ `invoke`（兜底；意图能力未授予就不假称能走）。
 *
 * ⚠ 零依赖（只引 `INTENT_CAPABILITY` 这个能力 id 的真源）⇒ rr 直引跑真实现，也不与
 *   `external-terminals.ts` / `external-calls.ts` 形成环。
 * ⚠ 本函数**只表达"该走哪条路"**，不是授权；真正的闸仍在 `external-calls` 一次一判。
 */
import { INTENT_CAPABILITY } from './intent-protocol.js';

export type TerminalInteractionMode = 'intent' | 'invoke';

export interface TerminalNegotiation {
  mode: TerminalInteractionMode;
  /** 门牌自报的意图（去重、截断后的稳定形态；空数组=未声明）。 */
  declaredIntents: string[];
  /** 直接上屏的人话理由（"为什么是这条路"）。 */
  reason: string;
}

/** 门牌意图条目的上限——门牌是**别人写的**，不设上限等于把内存交给对端。 */
export const MAX_DECLARED_INTENTS = 16;
const MAX_INTENT_LEN = 64;

/** 收敛门牌意图：只留非空字符串，去重、截断；非法形态一律丢弃（不猜）。 */
export function sanitizeDeclaredIntents(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, MAX_INTENT_LEN);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_DECLARED_INTENTS) break;
  }
  return out;
}

export function negotiateTerminalMode(input: {
  cardIntents?: readonly unknown[] | null;
  grantedCapabilities?: readonly string[] | null;
}): TerminalNegotiation {
  const declaredIntents = sanitizeDeclaredIntents(input.cardIntents ?? []);
  const granted = Array.isArray(input.grantedCapabilities) ? input.grantedCapabilities : [];
  if (declaredIntents.length === 0) {
    return {
      mode: 'invoke',
      declaredIntents,
      reason: '门牌未声明意图 ⇒ 走 invoke 原始调用。',
    };
  }
  if (granted.includes(INTENT_CAPABILITY)) {
    return {
      mode: 'intent',
      declaredIntents,
      reason: `门牌声明 ${declaredIntents.length} 个意图且已授予「意图控制」⇒ 意图优先（intent/resolve → intent/execute）。`,
    };
  }
  return {
    mode: 'invoke',
    declaredIntents,
    reason: '门牌声明了意图，但本机未授予「意图控制」⇒ 只能走 invoke 原始调用。',
  };
}
