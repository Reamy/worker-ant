/**
 * 飞书渠道适配器（WebSocket 长连接模式，免公网 IP）。
 * 从 ANS worker-ant 移植：使用 @larksuiteoapi/node-sdk 建立长连接。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ImAdapter, ImMessageHandler, ImMessageMeta, ImSendOpts, ImStatusReporter } from './im-adapter.js';
import { nonTextPlaceholder, shouldRecordConversation } from './im-adapter.js';
import type { InboundMedia } from './im-media.js';
import { persistInboundMedia } from './im-media.js';
import { credentialFailure } from '../core/im/im-errors.js';
import { fitOutboundText } from '../core/im/im-text.js';
import { recordOutboundConversation } from '../core/im/outbound-record.js';

const FEISHU_API = 'https://open.feishu.cn/open-apis';
/** 握手超时：不设则 SDK 可能无限期挂住（不触发任何回调）⇒ 渠道永远停在「启动中」。 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

interface LarkWsClient {
  start: (opts: { eventDispatcher: unknown }) => void;
  stop?: () => void;
}
interface LarkWsClientCtor {
  new (o: {
    appId: string;
    appSecret: string;
    onReady?: () => void;
    onError?: (err: Error) => void;
    onReconnecting?: () => void;
    onReconnected?: () => void;
    handshakeTimeoutMs?: number;
  }): LarkWsClient;
}

export class FeishuAdapter implements ImAdapter {
  private db: Database.Database;
  private channelId: string;
  private config: Record<string, string>;
  private dataDir: string;
  private status = 'inactive';
  private wsClient: LarkWsClient | null = null;
  private onMessageHandler: ImMessageHandler | null = null;
  private statusReporter: ImStatusReporter | null = null;

  constructor(db: Database.Database, channelId: string, config: Record<string, string>, dataDir = '') {
    this.db = db;
    this.channelId = channelId;
    this.config = config;
    this.dataDir = dataDir;
  }

  onMessage(handler: ImMessageHandler): void { this.onMessageHandler = handler; }
  getStatus() { return this.status; }
  setStatusReporter(reporter: ImStatusReporter): void { this.statusReporter = reporter; }

  /** 状态跃迁的唯一出口：改内存 + 上报（上报方落库并发 channel.status_changed）。
   *  `stop()` 不走此处——停止由 im:stopChannel 统一写库发事件；退出时的 stopAll 故意不写库。 */
  private report(status: string, detail?: string): void {
    this.status = status;
    try { this.statusReporter?.({ status, ...(detail ? { detail } : {}) }); } catch {}
  }

  /**
   * zx_20260929 M8-e（管子·度量衡 / 维特根斯坦·一个词一个用法）：取 token 失败的**分因**。
   *
   * `getTenantToken()` 对"远端拒签/网络抖动"与"压根没配 appId/appSecret"**返回同一个 `null`**
   * ——它能分辨的只有"配上没配上"这一件事，那就按这一件事分（`credentialFailure` 的唯一依据）。
   * 没配 ⇒ 条件缺失（不烧次数，等有人去配）；其余 ⇒ 普通发送失败（照旧退避烧次数）。
   */
  private tokenFailure(): Error {
    return credentialFailure('feishu', {
      missingConfig: !(this.config.appId && this.config.appSecret),
      detail: '无法获取 tenant_access_token，发送失败',
    });
  }

  async start(): Promise<void> {
    this.report('starting', '正在启动');
    const appId = this.config.appId || '';
    const appSecret = this.config.appSecret || '';
    if (!appId || !appSecret) {
      this.report('error', '缺少 appId / appSecret');
      throw new Error('飞书 appId 和 appSecret 是必需的');
    }
    try {
      const Lark = await import('@larksuiteoapi/node-sdk');
      // SDK 自带 onReady/onError/onReconnecting/onReconnected 与无限重连（reconnectCount=-1）：
      // 此前一个都没接 ⇒ 断连永不为人知。现在如实映射到 degraded/running/error。
      const wsClient = new (Lark as unknown as { WSClient: LarkWsClientCtor }).WSClient({
        appId,
        appSecret,
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        onReady: () => { this.report('running', '长连接已就绪'); },
        onReconnecting: () => { this.report('degraded', '长连接断开，重连中'); },
        onReconnected: () => { this.report('running', '长连接已恢复'); },
        onError: (err: Error) => { this.report('error', `长连接失败：${err.message}`); },
      });
      const eventDispatcher = new (Lark as unknown as { EventDispatcher: new (o: Record<string, unknown>) => { register: (m: Record<string, (data: unknown) => Promise<Record<string, unknown>>>) => unknown } }).EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => { await this.handleSdkMessage(data); return {}; },
      });
      wsClient.start({ eventDispatcher });
      this.wsClient = wsClient;
      // 保持 'starting'：握手尚未成功，onReady 才会置 running（此前在此处直写 running 是不实之言）。
      console.log(`[IM:feishu] SDK 长连接已发起 channel=${this.channelId}`);
    } catch (err) {
      this.report('error', `长连接启动失败：${(err as Error).message}`);
      throw new Error(`飞书 SDK 长连接启动失败: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.status = 'inactive';
    if (this.wsClient?.stop) { try { this.wsClient.stop(); } catch {} }
    this.wsClient = null;
  }

  /** 处理 SDK 投递的消息事件。
   *
   *  zx_20260924 M3：非文本**取件 + 落盘**（此前只记 `kind`，字节永远拿不到）。飞书的资源地址是
   *  `im/v1/messages/{message_id}/resources/{file_key}?type=image|file`（官方「获取消息中的资源文件」），
   *  鉴权走 `Authorization: Bearer <tenant_access_token>` ⇒ 取件是异步的，本方法改 `async`：
   *  **文本那条路仍同步走完，行为逐字不变**（只是外层 await 一个立即 resolve 的 async 函数）。 */
  private async handleSdkMessage(rawData: unknown): Promise<void> {
    const data = rawData as Record<string, unknown>;
    const message = data.message as Record<string, unknown> | undefined;
    const sender = data.sender as Record<string, unknown> | undefined;
    if (!message || !sender) return;
    const content = message.content as string | undefined;
    if (!content) return;
    // zx_20260914 M1-2(维特根斯坦·意义即使用): 非文本(`message_type !== 'text'`)不再整条丢弃——
    // 转成类型占位符，让"收到过一条图/文件"如实到场。`content` 里的 file_name/file_size 有就带上（真值）。
    const messageType = (message.message_type as string) || '';
    let text = '';
    let meta: ImMessageMeta | undefined;
    if (messageType && messageType !== 'text') {
      let fileName: string | undefined;
      let sizeBytes: number | undefined;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
        fileName = (parsed.file_name as string) || (parsed.fileName as string) || undefined;
        const sz = parsed.file_size ?? parsed.fileSize;
        if (typeof sz === 'number' && Number.isFinite(sz)) sizeBytes = sz;
      } catch { /* content 非 JSON 不影响"到场"，只是没有附注 */ }
      text = nonTextPlaceholder(messageType, fileName, sizeBytes);
      meta = { kind: messageType, ...(fileName ? { fileName } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}) };
      // 平台消息 id：供路由侧去重（非文本占位符长得一样，按正文去重会吞掉第二张图）。
      // **只随非文本带出**——文本消息的去重语义（按正文）保持原样，不给既有路径改行为。
      // M3 起它还多一个用处：**资源地址的路径段**（`/messages/{message_id}/resources/…`），故提前取。
      const messageId = (message.message_id as string) || undefined;
      if (messageId) meta.messageId = messageId;
      // 取件标识：**图片是 `image_key`，其余（文件/音频/视频）是 `file_key`**——两个字段名对应两种 `type`
      //   实参（官方文档：`type=image` 对应消息中的图片，`type=file` 对应文件、音频、视频）。别混用。
      const fileKey = (parsed.file_key as string) || (parsed.image_key as string) || undefined;
      if (fileKey && messageId) {
        const resourceType = parsed.image_key ? 'image' : 'file';
        const mediaUrl = `${FEISHU_API}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${resourceType}`;
        meta.mediaUrl = mediaUrl;
        const token = await this.getTenantToken();
        if (!token) {
          meta.mediaError = '无法获取 tenant_access_token，未能取件';
        } else {
          const media: InboundMedia = { kind: messageType, mediaUrl, ...(fileName ? { fileName } : {}) };
          Object.assign(meta, await persistInboundMedia(this.dataDir, media, { headers: { Authorization: `Bearer ${token}` } }));
        }
      }
    } else {
      try { text = (JSON.parse(content) as Record<string, unknown>).text as string || ''; } catch { return; }
    }
    const senderType = sender.sender_type as string | undefined;
    if (senderType !== 'user') return;
    const chatType = message.chat_type === 'p2p' ? 'direct' : 'group';
    const senderId = ((sender.sender_id as Record<string, unknown>)?.open_id as string) || (message.chat_id as string) || 'unknown';

    console.log(`[IM:feishu] 收到消息 from=${senderId.slice(0, 8)} text="${text.slice(0, 50)}"`);
    if (this.onMessageHandler) void this.onMessageHandler(senderId, text, chatType, '', meta);
  }

  /** 发送回复消息。失败时抛异常（与 wechat 同契约），供上层感知"未送达"并落 outbox 补发。
   *  `contextToken` 槽位本家**不用**（`ImAdapter` 契约占位，保持与 wechat 同一位置约定），`opts` 恒在其后。 */
  async sendReply(toUser: string, text: string, _contextToken?: string, opts?: ImSendOpts): Promise<void> {
    if (!text) return;
    // zx_20260930 M2-d: 发落归**一处真源**（`fitOutboundText`）——有上限才截并告知，无上限不截只提示。
    //   本家**没有**登记上限 ⇒ 超阈值时一字不动，只在末尾如实附一句"未截断"（静默原样发送是病）。
    //   ⚠ 此后 `text` 就是**真发出去的那串**，下面落账也用它（账与实物同一串）。
    text = fitOutboundText('feishu', text).text;
    const token = await this.getTenantToken();
    if (!token) throw this.tokenFailure();
    const receiveIdType = toUser.startsWith('oc_') ? 'chat_id' : 'open_id';
    const resp = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: toUser, msg_type: 'text', content: JSON.stringify({ text }) }),
    });
    const data = await resp.json() as { code?: number; msg?: string };
    if (data.code !== 0) {
      throw new Error(`[IM:feishu] 发送回复失败 code=${data.code} msg=${data.msg || ''}`);
    }
    // 补发路径传 recordConversation:false —— 原行已在首次失败时落库，由 flipConversationSent 翻正，不另插新行。
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'feishu', externalUserId: toUser,
        messageJson: { text },
        taskId: opts?.taskId,
      });
    }
  }

  /**
   * zx_20260924 M4: 发一件文件——**两步**（官方无"直接发件"接口）。
   *
   * ① 上传换 key：图片走 `POST /im/v1/images`（`image_type=message` + `image`），
   *    文件走 `POST /im/v1/files`（`file_type=stream` + `file_name` + `file`）；
   * ② 拿 key 按 `msg_type=image|file` 发消息（与 `sendReply` 同一个发消息接口，只是 `content` 换形状）。
   *
   * 第二步失败 ⇒ 上传的 key 成孤儿（飞书会自行过期回收，**不留半条消息**，故不必补偿）。
   * 任一步失败一律**抛出**（与 `sendReply` 同契约），供上层落 outbox 用 `sendMedia` 原样补发。
   */
  async sendMedia(toUser: string, file: { path: string; kind: 'image' | 'file'; name?: string }, opts?: ImSendOpts): Promise<void> {
    const token = await this.getTenantToken();
    if (!token) throw this.tokenFailure();
    const name = file.name || path.basename(file.path);
    const buf = fs.readFileSync(file.path);
    const form = new FormData();
    let uploadUrl: string;
    let msgType: string;
    let content: string;
    if (file.kind === 'image') {
      uploadUrl = `${FEISHU_API}/im/v1/images`;
      form.append('image_type', 'message');
      form.append('image', new Blob([new Uint8Array(buf)]), name);
      msgType = 'image';
      const key = await this.uploadForKey(uploadUrl, form, token, 'image_key');
      content = JSON.stringify({ image_key: key });
    } else {
      uploadUrl = `${FEISHU_API}/im/v1/files`;
      form.append('file_type', 'stream');
      form.append('file_name', name);
      form.append('file', new Blob([new Uint8Array(buf)]), name);
      msgType = 'file';
      const key = await this.uploadForKey(uploadUrl, form, token, 'file_key');
      content = JSON.stringify({ file_key: key });
    }
    const receiveIdType = toUser.startsWith('oc_') ? 'chat_id' : 'open_id';
    const resp = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: toUser, msg_type: msgType, content }),
    });
    const data = await resp.json() as { code?: number; msg?: string };
    if (data.code !== 0) {
      throw new Error(`[IM:feishu] 发送文件失败 code=${data.code} msg=${data.msg || ''}`);
    }
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'feishu', externalUserId: toUser,
        messageJson: { text: `📎 ${name}`, media: { kind: file.kind, name, path: file.path } },
        taskId: opts?.taskId,
      });
    }
  }

  /** 上传换 key（images/files 两个接口响应同形，只差 `data` 里的键名——键名由调用方给，不猜）。
   *  报错只报**键名**（`image_key`/`file_key`）不报中文类型名：本仓有一条反向钉明文要求
   *  「五家适配器无一家自带类型词表，词表只有 `im-adapter.ts` 一处」（`rr_zx_20260914_2` S2.6），
   *  在适配器里写 `'图片'` 这类中文字面量即便只为拼一句报错，也照样是第二份词表的开头。 */
  private async uploadForKey(url: string, form: FormData, token: string, keyName: string): Promise<string> {
    const resp = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const data = await resp.json() as { code?: number; msg?: string; data?: Record<string, string> };
    const key = data.data?.[keyName];
    if (data.code !== 0 || !key) {
      throw new Error(`[IM:feishu] 上传未返回 ${keyName} code=${data.code} msg=${data.msg || ''}`);
    }
    return key;
  }

  private async getTenantToken(): Promise<string | null> {
    try {
      const resp = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      });
      const data = await resp.json() as { code?: number; tenant_access_token?: string };
      return data.code === 0 ? (data.tenant_access_token || null) : null;
    } catch { return null; }
  }
}
