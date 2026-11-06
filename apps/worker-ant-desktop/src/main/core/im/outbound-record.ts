/**
 * zx_20260930 M2-c（维特根斯坦·意义即使用 / 一实一名）: **五家适配器出站行的唯一落点**。
 *
 * 病根：五家适配器各自内联 `INSERT INTO wa_im_conversations …`（共 9 处，文本行与件行各一），
 *   于是"一条出站行该记哪些列"有 9 份拷贝。本轮要给这一行加一列 `task_id`（"这句话属于哪个任务"），
 *   若仍各写各的，就是"同一处规则散在九处"的老病——改一处漏八处。
 * 修法：形状收进本函数（**插行 + 发出站事件**一步做完）。适配器只报"说什么、发给谁、属于哪个任务"。
 *
 * ⚠ `taskId` **只在真知道时传**：调用方（`sendImCompletionNotice` 一类）手里确有那张 task 才给；
 *   不知道就留空——空串的语义是"本条无归属"，不是"归属为某个空的东西"（**不猜**）。
 *   这也正是本列不叫 `run_id`、不做模糊匹配的原因：宁可少标一行，不可标错一行。
 *
 * ⚠ 与 `wa_im_outbox` 那条路**无关**：未送达的行由 `im-outbox.enqueueImOutbox` 落（带 `outbox_id`），
 *   本函数只负责**发出去之后**那一行。两者的字段与归属判据都不同，不要合并。
 *
 * ⚠ **边界（勿把本函数读成"全仓出站行的唯一落点"）**：本轮收进来的是**五家适配器**那 9 处拷贝。
 *   表内另有三类写者**各有其形状、各自留着**，不可合并：
 *   ① 失败行（`im-outbox` / `reply-accounting` / `im:resend` 失败支）——多 `status`/`last_error`，
 *      且**不该带 `task_id`**（`im:resend` 那条路手上没有任务）；
 *   ② 手工回话/手工发件（`manual-send.ts` 两支）——`message_json` 多 `manual:true`，
 *      且走**可注入的 `emit`**（rr 的受控复跑要用它，本函数直连模块级 emit 反而接不上）；
 *   ③ 入站行（`im-router`）——方向是 `inbound`，形状另一套（扁平、非嵌套）。
 *   它们的**共同点只到"都往同一张表插一行"为止**；形状与归属判据不同 ⇒ 合并即造假接口。
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { emitOutboundMessage } from './outbound-event.js';

export function recordOutboundConversation(db: Database.Database, o: {
  channelId: string;
  channelType: string;
  externalUserId: string;
  /** 落库的正文形状（入站扁平/出站嵌套两形状中**出站**那一种），原样 JSON 化。 */
  messageJson: Record<string, unknown>;
  /** 本条属于哪个任务——**只有真知道时才传**。 */
  taskId?: string;
}): void {
  db.prepare(
    "INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, task_id, created_at) VALUES (?, ?, ?, ?, 'outbound', ?, datetime('now'))"
  ).run(crypto.randomUUID(), o.channelId, o.externalUserId, JSON.stringify(o.messageJson), o.taskId || '');
  emitOutboundMessage({
    channelId: o.channelId,
    channelType: o.channelType,
    toUser: o.externalUserId,
    preview: typeof o.messageJson.text === 'string' ? o.messageJson.text : '',
  });
}
