/**
 * 出站消息对称事件——与入站 `im.message_inbound` 对称。
 *
 * 此前只有入站有实时事件：IMPage 能看到"用户说了什么"，看不到"工蚁回了什么"，
 * 出站成功/失败在界面上不可见（补发机制尤其不可见）。本函数由各适配器在
 * **成功落 outbound 行后**调用；瞬态事件，不写事件日志（与入站同一取舍）。
 */
import { eventBus } from '../event-bus.js';

export function emitOutboundMessage(args: {
  channelId: string;
  channelType: string;
  toUser: string;
  preview: string;
  /** zx_20260911_5 M1-5: 落账(未送达入 outbox)时置 true——界面据此刷新补发账, 别把"未送达"当"已发出"。 */
  pending?: boolean;
}): void {
  void eventBus.emitTransient('im.message_outbound', {
    channelId: args.channelId,
    channel_id: args.channelId,
    channelType: args.channelType,
    channel_type: args.channelType,
    toUser: args.toUser,
    to_user_id: args.toUser,
    preview: args.preview.slice(0, 60),
    ...(args.pending ? { pending: true } : {}),
    createdAt: new Date().toISOString(),
  }).catch(() => {});
}
