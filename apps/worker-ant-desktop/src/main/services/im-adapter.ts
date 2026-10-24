/**
 * IM 渠道适配器公共接口。
 * 各平台（微信个人号/钉钉/QQ/飞书/企业微信）实现此接口，
 * 通过统一契约接入 IM Router 与 IPC 分发。
 */

/** zx_20260914 M1-2(维特根斯坦·意义即使用): 非文本消息的**类型附注**。
 *  图片/文件/语音等本无文本可读——此前五家适配器一律 `return` **整条丢弃**，用户发的图在界面上
 *  从来没出现过，用户以为"发了"，系统以为"没发"（两边都不知道对方不知道）。
 *  现改为：转成类型占位符正文 + 此处带上真类型，让"收到过一条图"这件事**如实到场**。
 *  可选：既有调用方不传即行为不变（不给既有路径添负担）。 */
export interface ImMessageMeta {
  /** 真类型（各平台原始 type，如 image/file/voice/video/location/其他），非文本时才有 */
  kind?: string;
  /** 文件名（平台给了才有） */
  fileName?: string;
  /** 字节大小（平台给了才有）——真值，非估算 */
  sizeBytes?: number;
  /** 平台消息 id（平台给了才有）。用于**去重**：非文本无正文可辨，两条不同的图占位符一模一样，
   *  按正文去重会把第二张静默吞掉；有 id 才去得准（重放仍被挡，两张图各记一行）。 */
  messageId?: string;
  /**
   * zx_20260920_1 M5: **取件地址**（平台给了才有）。
   *
   * 病根：此前契约里只有 `kind/fileName/sizeBytes`——**知道"是张图"，却没有"去哪儿取字节"**，
   * 于是下游无论如何都拿不到件，`data/attachments/` 目录根本不存在。
   * 「这个字段在场」= 本平台**真的给了取件路径**（≠ 一定取到；取没取到看 `savedPath`/`mediaError`）。
   */
  mediaUrl?: string;
  /** zx_20260920_1 M5: 落盘**结果**（成功才有）。回话要报"落到哪了"，而这件事只有下载方知道。 */
  savedPath?: string;
  /** zx_20260920_1 M5: 落盘**失败的真因**（失败才有）。行照落、账照记，但**不许把"我丢了"说成"我收了"**——
   *  路由器据此写 `wa_im_conversations.last_error` 并如实回"没能落盘（原因）"。 */
  mediaError?: string;
}

/** 非文本类型 → 人读标签（**一处真源**：五家适配器 + 入站媒体回执共用，各家只把自己的原始类型映射进来）。
 *  只收**有据**的映射：`1`/`3` 来自 wechat 适配器 `extractText` 对 iLink item 的既有解读（文本/语音），
 *  其余为各平台公开类型名。不在表内的类型**原样带出**，不编造名字。
 *  ⚠ **导出**供 `services/im-media.ts` 的回执文案复用——此前那边自抄了一份 `RECEIPT_LABEL`，
 *    两份**漂移**了（回执少 7 个键），而这句"一处真源"当时并不成立。 */
export const NON_TEXT_LABELS: Record<string, string> = {
  '3': '语音',
  image: '图片', img: '图片',
  file: '文件', document: '文件',
  voice: '语音', audio: '语音',
  video: '视频',
  location: '位置', link: '链接',
  sticker: '表情', emoji: '表情',
  card: '卡片', rich_text: '富文本', markdown: '富文本',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** zx_20260914 M1-2: 非文本消息的**正文占位符**——让"收到过一条图/文件"如实到场。
 *  此前五家适配器一律 `return` 整条丢弃：用户以为"发了"，系统以为"没发"（两边都不知道对方不知道）。
 *  文件名/大小只在平台**真给了**才写（真值，不估算、不编造）。形如 `[图片]` / `[文件 report.pdf 1.2MB]`。
 *  注意：占位符是**正文**，为的是"这条消息在对话里看得见"；路由侧据此**止步**（见 routeImMessage），
 *  绝不进入指令/建任务管道——`[文件 …]` 长于 4 字，否则会被当自由文本建成任务。 */
export function nonTextPlaceholder(kind: string, fileName?: string, sizeBytes?: number): string {
  const label = NON_TEXT_LABELS[kind] || `其他消息(${kind})`;
  const extra: string[] = [];
  if (fileName) extra.push(fileName);
  if (typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes >= 0) extra.push(formatBytes(sizeBytes));
  return extra.length ? `[${label} ${extra.join(' ')}]` : `[${label}]`;
}

/** 消息回调：收到渠道消息时触发 */
export type ImMessageHandler = (
  fromUser: string,
  text: string,
  chatType: string,
  contextToken: string,
  meta?: ImMessageMeta,
) => void | Promise<void>;

/**
 * 运行期状态上报（zx_20260912 M1 · 海德格尔·在场 / 维特根斯坦·意义即使用）。
 *
 * 适配器内部的状态跃迁（长轮询连续失败、连接断开重连、扫码成功/过期、重连耗尽放弃）
 * 此前**一律不落库、不发事件** ⇒ 界面永久显示"运行中"而实际已死。
 * 现由适配器在**有意义的跃迁处**（而非每次轮询）调用 reporter，
 * 装机方（im.ipc.ts 的 createAdapter）负责落 `wa_im_channels.status` + 发 `channel.status_changed`。
 *
 * 语义约定：
 * - `inactive` **不上报**（停止由 `im:stopChannel` 统一写库+发 channel.stopped；
 *   且 `stopAllImAdapters()` 退出时故意不写库以便下次启动恢复）。
 * - `degraded` = 尚未放弃但已不健康（断连重连中 / 长轮询连续失败）——须如实示人，不可冒充 running。
 * - `error` = 已放弃（重连耗尽 / 无凭证 / 取码失败）。
 */
export interface ImStatusReport {
  status: string;
  detail?: string;
}
export type ImStatusReporter = (report: ImStatusReport) => void;

/** 出站发送的可选开关（zx_20260920 M4）。 */
export interface ImSendOpts {
  /** 见 `ImAdapter.sendReply` 的说明。**默认 `true`**。 */
  recordConversation?: boolean;
  /**
   * zx_20260930 M2-c: 这一条**属于哪个任务**——调用方手里确有那张 task 时才传。
   * 由适配器转交 `recordOutboundConversation`，写进出站行的 `task_id` 列。
   * 不传＝不知道（留空），**不猜**。
   */
  taskId?: string;
}

/**
 * zx_20260920 M4（维特根斯坦·意义即使用 / 一处真源）: **"适配器要不要自己记这一行"的唯一判据**。
 *
 * 五家适配器共用本函数，而不是各自写一遍 `opts?.recordConversation !== false`——
 * 默认值散成五份，改一处漏四处是迟早的事；且散写之后**判据无从受控复跑**
 * （`rr_zx_20260920` 的 Q-3 直调本函数，两只标本一起试：不传 ⇒ 落行、显式 `false` ⇒ 不落行。
 * 只用"该不落行"的标本试，任何过宽变体都会全票通过）。
 *
 * 语义只有一条：**只有显式说 `false` 才不落行**；不传、传 `{}`、传 `undefined`、传 `true` 都落行。
 * 这样既有调用方（不传）的行为**逐字不变**。
 */
export function shouldRecordConversation(opts?: ImSendOpts): boolean {
  return opts?.recordConversation !== false;
}

export interface ImAdapter {
  /** 启动渠道（连接 IM 服务） */
  start(): Promise<void>;
  /** 停止渠道 */
  stop(): Promise<void>;
  /** 获取渠道状态 */
  getStatus(): string;
  /** 发送回复消息。
   *
   *  `opts.recordConversation` **默认 `true`**——不传时行为逐字不变：适配器在**发送成功后**自己
   *  插一行 `direction='outbound'` 的 `wa_im_conversations` 记录并发 `im.message_outbound` 事件。
   *
   *  传 `{ recordConversation: false }` 表示"调用方自己负责记录这一行，适配器不要重复插"。
   *  这条是给**补发路径**用的：首次发送失败时那一行已经落库（`status='failed'`，带 `outbox_id`），
   *  补发成功后由 `flipConversationSent` 把**同一行**翻回 `'sent'`；适配器若再插一行，一行就变两行。
   *
   *  判据本身不在此处各写一遍——见 `shouldRecordConversation`（**唯一真源**）。 */
  sendReply(toUser: string, text: string, contextToken?: string, opts?: ImSendOpts): Promise<void>;
  /**
   * zx_20260924 M4（亚里士多德·潜能与现实）: **发一件文件**——可选方法，**不声明即不支持**。
   *
   * 与 `sendReply` 同一契约：失败**抛出**（不吞），供上层落 outbox 补发。
   *
   * 为什么是可选而不是在接口里声明成必需：五家里**至少微信个人号发不了件**（iLink 无上传通道）。
   * 若声明成必需，那家只能写个空实现或假成功——**"能力在场"是行为不是标签**，
   * 没这条通道就**不声明**，让调用方（`sendImMedia`）在类型层与运行层都拿到"本通道不支持"，
   * 而不是收到一句"发送成功"然后用户那边什么都没有（承 zx_20260911_2 M3 的名实相符）。
   *
   * `kind` 是**语义**（`image` 要按图片发、`file` 按文件发），不是扩展名——各平台上传接口与消息
   * 类型都按它分流（飞书 `image_key` vs `file_key`、钉钉 `sampleImageMsg` vs `sampleFile`）。
   * `name` 缺省取 `path` 的 basename。
   */
  sendMedia?(toUser: string, file: { path: string; kind: 'image' | 'file'; name?: string }, opts?: ImSendOpts): Promise<void>;
  /** 设置消息回调（将渠道消息交给 IM Router） */
  onMessage(handler: ImMessageHandler): void;
  /** 获取二维码状态（仅支持扫码登录的渠道） */
  getQrState?(): { qrcode_img: string; status: string } | null;
  /** 设置运行期状态上报器（可选——未实现的适配器行为完全不变） */
  setStatusReporter?(reporter: ImStatusReporter): void;
}

