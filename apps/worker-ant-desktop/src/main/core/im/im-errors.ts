/**
 * zx_20260911_4 M2-2(海德格尔·上手状态 / 王阳明·知行合一): IM 发送的类型化失败。
 *
 * `ImQuotaError` 标记的是**发送条件当下缺失**，而非消息本身的问题(内容错/网络抖动都算普通失败)：
 *   - 微信个人号主动推送配额已耗尽(无 contextToken 的推送按窗口计次，`wechat-adapter.pushQuota`)；
 *   - 渠道未持有 token(登录态丢失)。
 * 二者都可能在**该用户下一次入站**后恢复——入站会重置配额窗口(`wechat-adapter.handleMessage`)，
 * 故 outbox 补发遇本类**不消耗 attempts**、标 `blocked_quota`，待人入站复活再试；
 * 超窗仍未达则置 `dead`(与 pending 同一终态口径，不留下永远扫不动的悬行)。
 */
export class ImQuotaError extends Error {
  readonly kind = 'im_quota' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ImQuotaError';
  }
}

/** 跨模块/跨动态 import 边界的类型判定(instanceof 在双实例下会失效，故并认 kind 标记)。 */
export function isImQuotaError(e: unknown): e is ImQuotaError {
  if (e instanceof ImQuotaError) return true;
  return (e as { kind?: unknown } | null | undefined)?.kind === 'im_quota';
}

/**
 * zx_20260912 M3(管子·度量衡 / 王阳明·知行合一): **普通发送失败**也带上真原因。
 *
 * 与 `ImQuotaError` 的分工：本类 = "消息这次真没发出去"(网络/接口/内容错)，按既有 1/2/4 退避烧次数、
 * 3 次转 dead；`ImQuotaError` = "发送条件缺失"，不烧次数。二者**各自的既有处置一律不变**。
 * 之所以要有这个类型：`defaultSend` 此前对非配额异常 `catch { return false }`——真原因正在这一行被丢掉，
 * 账上只剩"未送达"三个字。补发失败要如实记因，就得把这句话从栈上带进账里。
 */
export class ImSendError extends Error {
  readonly kind = 'im_send' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ImSendError';
  }
}

/** 同上：跨模块/跨动态 import 边界的类型判定。 */
export function isImSendError(e: unknown): e is ImSendError {
  if (e instanceof ImSendError) return true;
  return (e as { kind?: unknown } | null | undefined)?.kind === 'im_send';
}

/**
 * zx_20260929 M8-e（管子·度量衡 / 维特根斯坦·一个词一个用法）:
 * **「发送条件缺失」的唯一判尺与唯一构造点**。
 *
 * 此前这条尺只有微信适配器持有：它内联了一份正则去认远端文案里的配额/频率信号
 * （`/quota|limit|frequen|too many|exceed|配额|限制|频繁/i`），其余四家各抛各的普通 `Error`。
 * 于是同一件事（"此刻发不出去，且不是这条消息的错"）在五个适配器里有五种形状，
 * 而 outbox 只能认出其中一种 ⇒ 同样的境遇，有的行不烧次数等条件恢复、有的行烧完 3 次转 `dead`。
 * 尺与构造归到此处后，五家说的是同一句话。
 */
export const QUOTA_HINT_RE = /quota|limit|frequen|too many|exceed|配额|限制|频繁/i;

/** 远端文案里有没有配额/频率类信号（**唯一一份**；此前只有微信适配器有）。 */
export function looksLikeQuotaHint(text: string): boolean {
  return QUOTA_HINT_RE.test(String(text || ''));
}

/** 「发送条件缺失」的唯一构造点：与 outbox 的 `blocked_quota` 同尺——不烧尝试次数，等条件恢复。 */
export function conditionMissing(channelLabel: string, detail: string): ImQuotaError {
  return new ImQuotaError(`[IM:${channelLabel}] 发送条件缺失：${detail}`);
}

/**
 * 取凭证失败的**分因**（唯一一处）。依据是**能分辨的那一个**事实——渠道凭证配没配上，
 * 而不是去猜远端为什么拒：
 *   - 根本没配（`missingConfig`）⇒ 条件缺失（`ImQuotaError`）：重试一万次也是同一个结果，
 *     要等有人去配置/授权；把它埋进 1/2/4 退避，只会把一个**没人配的渠道**演成"试过 3 次才放弃"。
 *   - 其余（网络抖动、接口故障、远端拒签）⇒ `ImSendError`：照旧退避烧次数。
 *     **这些不会因为"用户发来一条消息"而自愈** —— 把它们一起下沉成 `blocked_quota`，
 *     会让一条通知白等一个不会到来的入站，反而不如原样重试三次。
 *
 * ⚠ 与微信的分工：微信的 `!token` 是**登录态**（扫码登录的令牌不在），无处可配也无处可重试，
 *   故它恒走条件缺失；这三家/QQ 是"拿静态凭证现场换 token"，`!token` 才是失败**结果**。
 */
export function credentialFailure(
  channelLabel: string,
  o: { missingConfig: boolean; detail: string },
): ImQuotaError | ImSendError {
  return o.missingConfig
    ? conditionMissing(channelLabel, `${o.detail}（渠道凭证未配置）`)
    : new ImSendError(`[IM:${channelLabel}] ${o.detail}`);
}
