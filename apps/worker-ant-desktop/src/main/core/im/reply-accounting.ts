/**
 * zx_20260920 M2（维特根斯坦《哲学研究》§580·内在过程须有外在判据 / 毛选·有据的话不许不说）:
 * **机器回话失败的唯一记账点**。
 *
 * 病根（方案 §1.3-S2）：`routeImMessage` 的回话点里 14 处 `.catch(() => {})`，
 * 而 `ctx.sendReply` 的构造处也只在 `console.warn` 里说一句 —— 回话没送到时，
 * 对话视图里**根本没有那一行**。用户看到的是"工蚁没理我"，而"工蚁理了但没送到"
 * 与"工蚁压根没理"共用一个外在表现（沉默）。本函数给前者补上自己的形状：**一行 `failed`**。
 *
 * 口径（D4·就地裁定）：机器回话失败**只落账、不入 outbox**。
 * 理由是 outbox 会自动重试推送，而机器回话是对用户某一句话的应答；迟到的重试＝骚扰，且烧微信配额。
 * ⇒ 落一行供 GUI 当场看见、并可按既有 `im:resend` 手动补发；**不**写 `wa_im_outbox`、
 *   **不**写 `outbox_id`（没有补发账可关联——界面正据此把该行走 `im:resend` 口而非 `im:outboxRetry` 口）。
 *
 * 与 `im-outbox.enqueueImOutbox` 的分工：那个管"**要**送达的通知 / 人手工回话"（重试有意义），
 * 本函数管"**一次性的应答**"（重试没有意义）。两条路各自只有一处写者，互不越界。
 *
 * 表/列缺失（旧库、旧夹具）时静默跳过，不拖累路由 —— 与 `recordFailedConversation` 同口径的容忍。
 */
import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { emitOutboundMessage } from './outbound-event.js';

export interface ReplyFailureArgs {
  channelId: string;
  externalUserId: string;
  /** 那条**没能送到**的回话正文（原样落库，不截断——落库的是证据，不是摘要）。 */
  text: string;
  /** 真原因。调用方手里有就带进来；没有就留空，账上如实显示"原因未记录"，不编。 */
  error?: string;
  /**
   * zx_20260929 M8-c（维特根斯坦·一个词一个用法 / 毛选·有据的话不许不说）:
   * 这次失败是不是**发送条件缺失**（配额耗尽 / 登录态丢失）——即"等条件恢复就能送到"，
   * 而非"这条消息这次真没发出去"。
   *
   * 此前本表只有一个 `failed`，两种境遇在账上长得一模一样：用户看到"未送达"，
   * 无从知道**该不该等**。同样的区分在补发账（`wa_im_outbox`）里本就有（`blocked_quota` 不烧次数），
   * 此处只是让**人机回话那本账**也说同一句话（`blocked_quota` 与 outbox 同值同义）。
   */
  quota?: boolean;
}

export function accountOutboundFailure(db: Database, args: ReplyFailureArgs): void {
  // 状态值只有两个来源：`quota` 与否。**不**从 `error` 文案里猜（猜文案＝第二把尺，
  // 而"这次算不算条件缺失"的裁定已由调用方按类型做完了 —— 一个概念，一个值）。
  const status = args.quota ? 'blocked_quota' : 'failed';
  try {
    db.prepare(
      "INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, status, last_error, created_at) VALUES (?, ?, ?, ?, 'outbound', ?, ?, datetime('now'))"
    ).run(
      crypto.randomUUID(),
      args.channelId,
      args.externalUserId || '',
      JSON.stringify({ text: args.text || '', reply_failed: true, ...(args.quota ? { quota_blocked: true } : {}) }),
      status,
      (args.error || '').trim(),
    );
  } catch { /* 对话表缺列(旧库)不阻断路由 */ }
  // 到场：让正看着该渠道的 GUI 立刻把这一行前插进来（复用既有 `im.message_outbound`，不新增事件名）。
  // **不置 `pending`** —— 那个标记的语义是"已入补发账"（见 outbound-event.ts 的注释）；本行不入账，
  // 置 true 会让横幅口径与账目对不上（横幅数的是 outbox 行）。
  try {
    const ch = db.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(args.channelId) as { channel_type?: string } | undefined;
    emitOutboundMessage({
      channelId: args.channelId,
      channelType: ch?.channel_type || '',
      toUser: args.externalUserId || '',
      preview: args.text || '',
    });
  } catch { /* 事件发不出不影响落账本身 */ }
}
