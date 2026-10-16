/**
 * zx_20260914 M1-1(维特根斯坦·意义即使用 / 毛选·没有调查就没有发言权): 手工回话/发件的**唯一下游**。
 *
 * zx_20260930 M1 起，本文件住着**两条**手工出站路（`sendManualImMessage` 发文字、`sendManualImMedia` 发件）。
 *   同住一处不是凑巧：两者的四条口径（失败只走 `enqueueImOutbox` / 成功行不手写 `status` /
 *   列集与 `im:resend` 同尺 / 传 `recordConversation:false`）**逐条相同**，分两处住就会分叉。
 *
 * 病根: 界面此前只能**看**(`im:conversations` 只读)、只能**重发别人的话**(`im:resend` 认 convId),
 *   不能自己说一句 —— "回得了话"缺最后一环。
 * 修法: 判定与落库整段收进本函数, `im:send` handler 只做接线; 受控复跑直接调本函数 **同一份真源**
 *   (而非在测试里重写一遍), 见 feedback「往返/闭环判据须在生产入参上证」。
 *
 * 口径三条, 各有其不可替代之处:
 *   ① 超限只**如实告知**、**不代用户截断** —— 静默截断是篡改用户的话, 与"回得了话"宗旨相反。
 *   ② 成功行**不手写 status**, 靠列 DEFAULT(一处真源); 否则列默认改了这里就悄悄分叉。
 *   ③ 失败**只走** `enqueueImOutbox`(唯一记账点) —— 不另开 `'failed'` 写者
 *      (不变量: 恰**三**处, 见 `rr_zx_20260920.ts` 的 P-4; 第三处是 zx_20260920 M2 新增的机器回话记账),
 *      又自动获得补发/重试与"未送达"出站事件。
 *   ④ zx_20260920 M4: 发送那一步传 `recordConversation:false`(适配器**只发不记**) ——
 *      落账由本函数两支各落一行负责。否则适配器一插、本函数再插 ⇒ **一个消息两个气泡**。
 */
import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { enqueueImOutbox } from './im-outbox.js';
import { emitOutboundMessage } from './outbound-event.js';
import { MEDIA_UNSUPPORTED_TEXT, mediaUnsupportedReason } from './channel-capabilities.js';
import { familyOf } from '../attachment-kinds.js';
import { baseNameOf, extOf } from './im-media-view.js';
import type { ImSendOpts } from '../../services/im-adapter.js';

/** 手工回话的**单条文本上限**——真源在 `im-text.ts`（与"超了怎么截"的 `clipWithNotice` 同处）。
 *  本处只**取用**它: **界面在哪儿拦、适配器就在哪儿截**, 是同一把尺、同一张表。 */
export { IM_SEND_TEXT_LIMIT } from './im-text.js';
import { IM_SEND_TEXT_LIMIT, fitOutboundText } from './im-text.js';

export interface ManualSendArgs {
  channelId: string;
  externalUserId: string;
  text: string;
}

export type ManualSendResult =
  | { data: { sent: true; note?: string } }
  | { error: { code: string; message: string } };

export interface ManualSendDeps {
  db: Database;
  /** 运行中的适配器, 按 channelId 取(与 `im:resend` 同一张表)。`opts` 见 `ImSendOpts`。
   *  `sendMedia` 是**可选**的——与 `ImAdapter` 上那一跳同形: 它不在名册上就是"本通道结构上发不了件"
   *  （`channel-capabilities` 按同一事实登记 `media:false`），不是"暂未实现"。 */
  adapters: Map<string, {
    sendReply: (toUser: string, text: string, contextToken?: string, opts?: ImSendOpts) => Promise<void>;
    sendMedia?: (toUser: string, file: { path: string; kind: 'image' | 'file'; name?: string }, opts?: ImSendOpts) => Promise<void>;
  }>;
  /** 出站瞬态事件出口; 缺省即生产实现。 */
  emit?: typeof emitOutboundMessage;
}

export async function sendManualImMessage(deps: ManualSendDeps, args: ManualSendArgs): Promise<ManualSendResult> {
  const db = deps.db;
  const emit = deps.emit || emitOutboundMessage;
  const { channelId, externalUserId } = args;
  try {
    const body = typeof args.text === 'string' ? args.text.trim() : '';
    if (!body) return { error: { code: 'NO_CONTENT', message: '消息内容为空' } };
    if (!channelId || !externalUserId) return { error: { code: 'BAD_REQUEST', message: '缺少渠道或收件人' } };
    const ch = db.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(channelId) as { channel_type?: string } | undefined;
    if (!ch) return { error: { code: 'NOT_FOUND', message: '渠道不存在' } };
    const channelType = ch.channel_type || '';
    const limit = IM_SEND_TEXT_LIMIT[channelType];
    if (limit && body.length > limit) {
      return { error: { code: 'TOO_LONG', message: `该渠道单条文本上限 ${limit} 字，当前 ${body.length} 字` } };
    }
    const adapter = deps.adapters.get(channelId);
    if (!adapter) return { error: { code: 'NO_ADAPTER', message: '渠道适配器未运行' } };
    // zx_20260930 M2-d: 发落**自己先定形**（`fitOutboundText`，与适配器同一处真源、幂等）。
    //   为什么要先定形：落账归本函数（见下），若只让适配器在内部改，本函数落进账的仍是用户敲的原文 ⇒
    //   账上 5000 字、收件人收到 5000 字加一句说明 —— 又是"账与实物两个值"。
    //   超限（有登记上限）那支已在上方 TOO_LONG 拦下，此处只会是"无上限但超阈值 ⇒ 附一句未截断"。
    const fitted = fitOutboundText(channelType, body);
    try {
      // zx_20260920 M4: 落账由**本函数**负责(成功/失败两支各落一行) ⇒ 传 `recordConversation:false`,
      //   让适配器**只发不记**。否则适配器插一行、本函数再插一行 —— 一次手发在对话里出现**两个气泡**
      //   (与补发账那条路是同一个病: 一个消息两行)。
      await adapter.sendReply(externalUserId, fitted.text, undefined, { recordConversation: false });
    } catch (err) {
      // 一条手工回话没送到 = 一笔补发账(唯一记账点)。taskId 传 '' : 手发不属于任何任务。
      enqueueImOutbox(db, { channelId, externalUserId, taskId: '', kind: 'manual_reply', message: body }, (err as Error).message || String(err));
      return { error: { code: 'SEND_FAILED', message: `发送失败：${(err as Error).message}` } };
    }
    db.prepare(
      "INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, 'outbound', datetime('now'))"
    ).run(crypto.randomUUID(), channelId, externalUserId, JSON.stringify({ text: fitted.text, manual: true }));
    emit({ channelId, channelType, toUser: externalUserId, preview: fitted.text });
    // 界面上是手打的, 但链路上无原文 contextToken ⇒ 微信个人号按主动推送计配额(与 im:resend 同一口径如实告知)。
    const quotaNote = channelType === 'wechat-personal'
      ? '本次手发无上下文 token，按主动推送计配额；配额耗尽时将无法送达，请让用户回复任意消息刷新。'
      : '';
    // zx_20260930 M2-d: 无已知上限的通道超阈值 ⇒ **一字未截**，只在末尾附了句说明。回执照实说，
    //   免得操作者下一句就问"是不是被截了"（这正是"静默"要付的代价）。
    const overlongNote = fitted.overlongNoted
      ? `本条 ${fitted.originalLength} 字，该通道无已知上限，已原样完整发送（末尾附了一句说明，未截断）。`
      : '';
    const note = [quotaNote, overlongNote].filter(Boolean).join(' ') || undefined;
    return { data: { sent: true, ...(note ? { note } : {}) } };
  } catch (err) {
    return { error: { code: 'INTERNAL', message: (err as Error).message } };
  }
}

export interface ManualMediaArgs {
  channelId: string;
  externalUserId: string;
  /** **盘上**的绝对路径（界面从文件选择器拿到的那个）。不是取件地址、不是相对路径。 */
  filePath: string;
  /** 声明的件名；缺省取路径末段（与入库那条路同一处 `baseNameOf`）。 */
  name?: string;
}

/**
 * zx_20260930 M1（维特根斯坦·意义即使用）: 手工**发件**的唯一下游——与 `sendManualImMessage` 同形同尺。
 *
 * 病根：`sendImMedia` 早就写在册（补发路一直在用它），但**没有任何界面能走到它**——
 *   用户从 IM 页只能发文字。「发得出件」这一条此前只有机器回话那条路有。
 *
 * 与文本那条**刻意同尺**（两处各拍一份就会分叉）：
 *   ① 失败**只走** `enqueueImOutbox`（唯一记账点）——不在这里另写失败行；
 *   ② 成功行**不手写 `status`**（靠列 DEFAULT），列集与 `im:resend` 逐字相同；
 *   ③ 发送那一跳传 `recordConversation:false`（落账归本函数，否则一次手发两个气泡）。
 *
 * 与文本那条**刻意的两处不同**，各有其理：
 *   ① **发件前先问能力表**（`mediaUnsupportedReason`）。文本没有"通道结构上发不了"这回事，
 *      件有——`wechat-personal` 名册上根本没有 `sendMedia`。撞上去只会得到一个 TypeError，
 *      用户读到的是"发送失败"而不是真相"本通道不支持发件"。故**绝不去撞一个注定抛错的 send**
 *      （M8 在补发两条路上已立此口径，此处是第三处，仍由同一句真源回话）。
 *   ② 不支持这件事**仍要落一条账**：否则用户点了发件、界面上什么也没发生——**沉默不是一种**。
 *      落账后 `listOutbox` 立刻据 `media_path` + 能力表派生 `media_unsupported`，
 *      所以界面当场就显示真因而**不必等**下一次补发轮询把 status 从 `pending` 拨到 `unsupported_media`
 *      （那条路 `attempts` 不动，见 `markUnsupportedMedia`）。
 */
export async function sendManualImMedia(deps: ManualSendDeps, args: ManualMediaArgs): Promise<ManualSendResult> {
  const db = deps.db;
  const emit = deps.emit || emitOutboundMessage;
  const { channelId, externalUserId } = args;
  try {
    const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
    if (!filePath) return { error: { code: 'NO_CONTENT', message: '未选择文件' } };
    if (!channelId || !externalUserId) return { error: { code: 'BAD_REQUEST', message: '缺少渠道或收件人' } };
    // 只认盘上的绝对路径。`https://…` 与 `a/b.txt` 一并被这条挡下——**刻意不为 URL 单开一档**：
    //   入库那条路要分辨地址是因为平台的 `saved_path` 里**真的可能是地址**；这里是用户从选择器挑的件，
    //   没有"合法地拿到一个地址"的情形，硬分两档反而多一份同义文案。
    if (!path.isAbsolute(filePath)) return { error: { code: 'BAD_REQUEST', message: '件路径必须是绝对路径' } };
    try {
      if (!fs.statSync(filePath).isFile()) return { error: { code: 'FILE_NOT_FOUND', message: '盘上这个路径不是文件' } };
    } catch {
      return { error: { code: 'FILE_NOT_FOUND', message: '盘上找不到这个件' } };
    }
    const ch = db.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(channelId) as { channel_type?: string } | undefined;
    if (!ch) return { error: { code: 'NOT_FOUND', message: '渠道不存在' } };
    const adapter = deps.adapters.get(channelId);
    if (!adapter) return { error: { code: 'NO_ADAPTER', message: '渠道适配器未运行' } };

    // 判型取**族**（`attachment-kinds` 的唯一判据），不是"图片就这几个后缀"的第二次抄写。
    const kind: 'image' | 'file' = familyOf(extOf(filePath)) === 'image' ? 'image' : 'file';
    const name = (typeof args.name === 'string' ? args.name.trim() : '') || baseNameOf(filePath);
    // 能力表说发不了 / 适配器名册上没有 `sendMedia` ⇒ 同一句真源回话。两者是同一事实的两面，
    //   取"或"是为了让名册与能力表万一不同步时也**保守地拒**，而不是去撞。
    const sendMedia = adapter.sendMedia;
    const unsupported = mediaUnsupportedReason(ch.channel_type || '') || (sendMedia ? '' : MEDIA_UNSUPPORTED_TEXT);
    if (unsupported || !sendMedia) {
      const reason = unsupported || MEDIA_UNSUPPORTED_TEXT;
      enqueueImOutbox(db, { channelId, externalUserId, taskId: '', kind: 'manual_media', message: '', mediaPath: filePath, mediaKind: kind }, reason);
      return { error: { code: 'UNSUPPORTED_MEDIA', message: reason } };
    }

    try {
      await sendMedia(externalUserId, { path: filePath, kind, name }, { recordConversation: false });
    } catch (err) {
      // 一件手工发出的件没送到 = 一笔补发账（唯一记账点）。带 `mediaPath` ⇒ 补发走 `sendMedia` 而不是发一串文件名。
      enqueueImOutbox(db, { channelId, externalUserId, taskId: '', kind: 'manual_media', message: '', mediaPath: filePath, mediaKind: kind }, (err as Error).message || String(err));
      return { error: { code: 'SEND_FAILED', message: `发送失败：${(err as Error).message}` } };
    }
    // 成功行的 `message_json` 用**出站的嵌套形状**（`media.path`）——与 `im-outbox` 的 `mediaJson()` 同一写法，
    //   故 IM 页那段 `imMediaOf()` 认得出这是一件、认得出它是什么族（Z-1 显形走的就是这一条）。
    db.prepare(
      "INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, 'outbound', datetime('now'))"
    ).run(crypto.randomUUID(), channelId, externalUserId, JSON.stringify({ text: `📎 ${name}`, media: { kind, name, path: filePath }, manual: true }));
    emit({ channelId, channelType: ch.channel_type || '', toUser: externalUserId, preview: `📎 ${name}` });
    return { data: { sent: true } };
  } catch (err) {
    return { error: { code: 'INTERNAL', message: (err as Error).message } };
  }
}
