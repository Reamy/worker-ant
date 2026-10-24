/**
 * zx_20260929 M8-a（维特根斯坦·意义即使用 / 毛选·有据的话不许不说）:
 * **出站文本的长度尺**——「上限是多少」与「超了怎么截」两件事，放在同一处。
 *
 * 病根：有三处在往用户眼前送东西时**静默截断**（`text.slice(0, 4000)`）——
 * IM 命令的执行输出、F3 通知文件正文、QQ 出站正文。用户拿到的是一份"看起来完整"的内容，
 * 末尾少了没有、少了多少，全无线索；而发文的那一侧以为自己说全了。**截断不是错，不说才是错。**
 *
 * 上限只有 qqbot 一家有（官方单条 4000），其余四家原样发送 ⇒ 本表的语义是
 * 「**列出来的**渠道有上限，未列出的不设人为上限」。界面在**同一张表**上拦
 * （`manual-send.ts` 的 TOO_LONG 拒发就是读它）——「在哪儿截就在哪儿拦」，故表放这里、
 * 两个消费者都从这儿取，不各写一份。
 *
 * zx_20260930 M2-d：**发落**由 `fitOutboundText` 一处判（五家适配器出站都从它过）——
 * 「有上限才截（并告知）、无上限只提示（不截）」；各家不再自己决定"这条要不要动"。
 */

export const IM_SEND_TEXT_LIMIT: Record<string, number> = { qqbot: 4000 };

/**
 * IM **命令输出 / F3 通知正文**的兜底上限。语义与上表**不同**，刻意分开：
 *   - 上表是"**用户写的东西**发给这个渠道，平台最多收多少"（渠道属性 ⇒ 按渠道查表）；
 *   - 本值是"**机器贴给用户的一段文件正文**最多带多少"（与渠道无关的历史口径，两个落点同值）。
 * 两者值当下恰好都是 4000，但**同值是巧合、不是同一件事** —— 合成一个键就会在任一渠道上限变动时
 * 把另一半悄悄改掉。放这里是为了「上限在哪儿」只有一处可查（此前是两处内联字面量 `slice(0, 4000)`）。
 */
export const IM_ROUTER_OUTPUT_LIMIT = 4000;

/** 截断时贴在正文末尾的那句话。前置两个换行：在 IM 上自成一段，不跟正文黏成一句。
 *  长度按 UTF-16 码元算（= `String.length`），与上限同尺 ⇒ 截断结果**恒 ≤ limit**。 */
export const TRUNCATION_MARKER = '\n\n……（内容过长，已截断）';

/**
 * 超限即截断，并在末尾**如实告知**被截断了；未超限原样返回。
 * `limit` 缺省或 ≤0 ＝ 该渠道不设人为上限（原样返回，不是"截成 0 字"）。
 *
 * 为什么要扣额度：上限是"这条能发出去"的硬约束，标记不能把它顶破——
 * 故正文头只取 `limit - marker.length`，标记自己也在额度内。
 * 末位若恰好劈开一个代理对（emoji 的高位），丢该位：宁可少一个字符，也不给出半个乱码。
 */
export function clipWithNotice(text: string, limit?: number, marker: string = TRUNCATION_MARKER): string {
  if (!limit || limit <= 0 || text.length <= limit) return text;
  let head = text.slice(0, Math.max(0, limit - marker.length));
  const tail = head.charCodeAt(head.length - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) head = head.slice(0, -1);
  return head + marker;
}

/**
 * zx_20260930 M2-d（维特根斯坦·意义即使用 / 毛选·有据的话不许不说）:
 * **无已知上限的通道**，正文越过这条线就如实提示一声（**不截断**）。
 *
 * 取值 4000 与表内唯一已知的平台硬上限同值，但**语义不是"另外四家也收 4000"**——
 * 它表示"越过这条线，就没有一家能保证收得下"，故从这儿起每一句都该带上说明。
 * 与 `IM_SEND_TEXT_LIMIT` 恰好同值同样是巧合：一个是**硬约束**（超了要截），
 * 一个是**告知阈值**（超了只说），任一变动不得顺手改另一个。
 */
export const IM_TEXT_NOTICE_THRESHOLD = 4000;

/**
 * 无上限通道超阈值时贴的那句。**刻意不说"已截断"**——本轮没有动用户一个字，
 * 说成截断就是反方向的谎（对照 `TRUNCATION_MARKER`：那句只在真截了时才出现）。
 *
 * `KEPT_NOTICE_TAIL` 是它的**识别尾**：`fitOutboundText` 靠它做幂等（见该函数注释）。
 */
export const KEPT_NOTICE_TAIL = '未截断）';

export function overlongKeptNotice(length: number, threshold: number = IM_TEXT_NOTICE_THRESHOLD): string {
  return `\n\n……（本条 ${length} 字，超出 ${threshold} 字；本通道无已知上限，已原样完整发送，${KEPT_NOTICE_TAIL}`;
}

export interface FittedOutboundText {
  /** 真正会发出去的正文（截断 / 附说明之后）。 */
  text: string;
  /** 原文长度（未动之前，UTF-16 码元，与上限同尺）。 */
  originalLength: number;
  /** 本通道登记的上限；**无已知上限**时为 undefined。 */
  limit?: number;
  /** 是否真的截掉了字。 */
  truncated: boolean;
  /** 是否因超阈值附了"未截断"说明（**无上限通道专用**；与 `truncated` 互斥）。 */
  overlongNoted: boolean;
}

/**
 * zx_20260930 M2-d: **出站正文的唯一发落点**——「这条正文该原样发 / 该截 / 该附提示」只此一处判。
 *
 * 三态（判决依据**只有**渠道有没有登记上限，不猜平台的脾气）：
 *   - 有上限且超限 ⇒ **截断**并如实告知（`clipWithNotice`，标记在额度内）；
 *   - 无已知上限且超阈值 ⇒ **一字不动**，末尾如实附一句"未截断"（静默原样发送是病：用户以为自己拿全了，
 *     机器也以为自己说全了，而"这条发得出去吗"其实无人作保）；
 *   - 其余 ⇒ 原样。
 *
 * ⚠ 附了说明会比原文更长——无已知上限的通道上这是可接受的：宁可多一句实话，
 *   也不要为了"赌它收得下"而把用户的话说长。**有**上限的通道不走这条（那是截断那一态）。
 *
 * **幂等**（`fit(fit(x)) === fit(x)`）：有一次调用方要**自己先定形**再交给下游
 *   （`manual-send` 得先知道真发出去的是哪串，才能把同一串落进账里），而下游适配器
 *   还会再过一次本函数。截断那一态天然幂等（截完已 ≤ 上限，第二次不再进分支）；
 *   附说明那一态不会——故靠识别尾 `KEPT_NOTICE_TAIL` 挡住**第二次**追加，
 *   否则收件人会看到两句"本条 N 字"。
 */
export function fitOutboundText(channelType: string, text: string): FittedOutboundText {
  const limit = IM_SEND_TEXT_LIMIT[channelType];
  const originalLength = text.length;
  if (limit && originalLength > limit) {
    return { text: clipWithNotice(text, limit), originalLength, limit, truncated: true, overlongNoted: false };
  }
  if (!limit && originalLength > IM_TEXT_NOTICE_THRESHOLD) {
    if (text.endsWith(KEPT_NOTICE_TAIL)) {
      return { text, originalLength, truncated: false, overlongNoted: true };
    }
    return { text: text + overlongKeptNotice(originalLength), originalLength, truncated: false, overlongNoted: true };
  }
  return { text, originalLength, limit, truncated: false, overlongNoted: false };
}
