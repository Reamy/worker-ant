/**
 * zx_20260911_2 M3(维特根斯坦·语言即用法): 渠道能力单一真源。
 *
 * 「已支持」不是标签而是行为——本表按各适配器**实际有无接收通道**如实登记，
 * 供诊断(im:diagnose)与前端提示统一取用，避免"界面写支持、实际收不到"的名实不符。
 * 新增渠道时改此表一处，诊断与提示同步生效。
 *
 * zx_20260924_1 M8(维特根斯坦·意义即使用): 本表曾**只有 `im:diagnose` 一个读者**——
 * "本通道不支持发送文件"这句话在此写了、`sendImMedia` 里又写一遍，而补发路两处**都不读**
 * ⇒ 用户点「补发」，拿到的是普通失败(attempts+1、退避、再 dead)，界面显示成"未送达"；
 * 真相是"这条永远不会送达，因为这个通道根本发不了件"。现在补发路
 * (`im-outbox.ts` 的 `retryOutboxEntry`/`retryImOutbox`)与 IM 页的补发钮都读
 * `mediaUnsupportedReason(...)`，文案只此一份(`MEDIA_UNSUPPORTED_TEXT`)。
 */
export interface ChannelCapabilities {
  /** 是否有入站通道（能收到用户消息）。false = 只能出站，用户回复无法到达引擎。 */
  inbound: boolean;
  /** 是否有出站通道（能主动发送消息）。 */
  outbound: boolean;
  /**
   * zx_20260924 M4: 能否**发送文件**（不只是文本）。
   *
   * 与 `inbound/outbound` 同一口径——**按适配器实际有无声明 `sendMedia` 如实登记**，
   * 不按"平台理论上支持"登记。`false` 的含义是"本通道发不了件"，
   * 调用方据此**如实拒绝**（`mediaUnsupportedReason(type)` 取那句说明），
   * 不得静默降级成发一条文件名文字。
   *
   * zx_20260924_1 M8: 这里的"调用方"是真有人的——补发两条路(`retryOutboxEntry`/`retryImOutbox`)
   * 在**进入发送之前**就用它拒，`listOutbox` 把它派生成界面上的禁用钮理由；不再只是书面口径。
   */
  media: boolean;
  /** 面向用户的一句如实说明。 */
  note: string;
}

/**
 * zx_20260924_1 M8(一处真源): "本通道发不了件"这句话的**唯一**出处。
 *
 * 目前有四处要说这句话——能力表 `note`、`sendImMedia` 的抛出、补发路的拒绝、IM 页禁用钮的 title；
 * 各写一遍的后果是改一处、剩下几处继续说着旧话（本仓"两套口径并存"的老病根）。
 * 故：其余三处一律由它派生，**不许出现第二份同义文案**。
 */
export const MEDIA_UNSUPPORTED_TEXT = '本通道不支持发送文件';

/**
 * 「该渠道此刻发不了件」的理由——**唯一判据**，返回空串 = 发得了。
 *
 * 取 `media` 这一列本身，而不是各调用方各判一份：判据与文案同源，能力表改了这里就跟着改。
 * 两条补发路与界面共用它；未知渠道类型(含渠道行已删)按能力表的兜底口径登记为 `media:false`，
 * 同样如实拒绝——宁可说"发不了"，也不去撞一个注定抛错的发送。
 */
export function mediaUnsupportedReason(type: string): string {
  return channelCapabilities(type).media ? '' : MEDIA_UNSUPPORTED_TEXT;
}

const CAPABILITIES: Record<string, ChannelCapabilities> = {
  // iLink 只有文本消息通道，没有上传接口 ⇒ 发不了件。这是**事实登记**，不是"暂未实现"。
  'wechat-personal': { inbound: true, outbound: true, media: false, note: `入站长轮询 + 出站发送（${MEDIA_UNSUPPORTED_TEXT}）` },
  qqbot: { inbound: true, outbound: true, media: true, note: 'WebSocket 长连接 + 出海发送（支持发件，单件 ≤10MB）' },
  dingtalk: { inbound: true, outbound: true, media: true, note: 'Stream 长连接 + 出海发送（支持发件）' },
  feishu: { inbound: true, outbound: true, media: true, note: 'SDK 长连接 + 出海发送（支持发件）' },
  wecom: { inbound: false, outbound: true, media: true, note: '仅出站（支持发件）；入站未实现（企业微信无原生长连接，需公网回调服务）' },
};

export function channelCapabilities(type: string): ChannelCapabilities {
  return CAPABILITIES[type] || { inbound: false, outbound: false, media: false, note: '未知渠道类型' };
}
