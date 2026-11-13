/**
 * zx_20261110_1 B2（维特根斯坦·意义即使用 / 《周易》言行枢机）: **中置信意图的确认分支**。
 *
 * 病根：模型给出 `create_task` / `start_task` 时（规则未命中、只能信模型），路由**直接动世界**——
 *   建了任务或启动了任务，用户却从未回答过"这确实是我要的"。模型只有中置信，副作用却是确定的。
 *   治法：把"模型判为中置信建单/启动"降级成**一问**：先回「我理解你想建单：…。回复「确认」执行」，
 *   用户确认后才执行。**确认词、摘要截断、提示文案**都是判定，收在本纯模块；
 *   路由层只留状态（Map/过期）与"认领 + 真落库 + 执行"。
 *
 * ⚠ 纯函数、零 IO、零时钟（`now` 由调用方传入）：受控回归直引跑真实现。
 */

/** 待确认的动作只有两种——查询/闲聊没有需要确认的副作用，不在此列。 */
export type PendingIntentKind = 'create' | 'start';

export interface PendingIntentConfirmation {
  kind: PendingIntentKind;
  /** 触发确认的**原话**（确认后按它执行，不按确认词执行）。 */
  text: string;
  /** 给用户看的摘要（截短、压成一行）。 */
  summary: string;
  expiresAt: number;
}

/**
 * 30 分钟。比项目编号候选（5 分钟）宽——确认是"想清楚再点"，不是"马上挑一个"；
 *   但也不能无限：半小时后同一句话的上下文早已变了，旧问题不该再被一个「确认」激活。
 */
export const INTENT_CONFIRMATION_TTL_MS = 30 * 60_000;
/** 摘要上限：够看清是哪件事，又不至于把长文整段回显。 */
export const INTENT_CONFIRMATION_SUMMARY_CHARS = 40;

export function confirmationKey(channelType: string, fromUser: string): string {
  return `${channelType}:${fromUser}`;
}

/** 一行化 + 截断（截断加省略号，让用户知道后文还有）。 */
export function summarizeIntentText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > INTENT_CONFIRMATION_SUMMARY_CHARS
    ? `${oneLine.slice(0, INTENT_CONFIRMATION_SUMMARY_CHARS)}…`
    : oneLine;
}

export function buildPendingIntent(
  kind: PendingIntentKind,
  text: string,
  now: number = Date.now(),
): PendingIntentConfirmation {
  return {
    kind,
    text,
    summary: summarizeIntentText(text),
    expiresAt: now + INTENT_CONFIRMATION_TTL_MS,
  };
}

/** 用户看到的那一句话——动作名与两个出口同在此处，不散落在路由分支里。 */
export function intentConfirmationPrompt(kind: PendingIntentKind, summary: string): string {
  const action = kind === 'create' ? '建单' : '启动';
  return `我理解你想${action}：「${summary}」。回复「确认」执行，回复「取消」放弃。`;
}

export type ConfirmationVerdict = 'confirm' | 'cancel';

/**
 * 确认词表（**整句匹配**，不是子串）。容忍句尾标点与「吧/一下」这类语气尾巴；
 *   `确认执行` / `先确认一下这个任务` 这类**带宾语的长句不算确认**——那可能是另一个话题，
 *   宁可让路由把它当新消息处理，也不能因一个「确认」子串就执行旧动作。
 */
const CONFIRM_RE = /^(确认|确定|是|对|yes|y|ok|好的|好)(吧|一下|啊|呀|呢)?$/i;
const CANCEL_RE = /^(取消|否|不|no|n|算了|放弃|不用了|不要了)(吧|一下|啊|呀|呢)?$/i;

export function parseConfirmationReply(text: string): ConfirmationVerdict | null {
  const t = text.trim().replace(/[。.!！?？~～\s]+$/g, '');
  if (!t) return null;
  if (CONFIRM_RE.test(t)) return 'confirm';
  if (CANCEL_RE.test(t)) return 'cancel';
  return null;
}
