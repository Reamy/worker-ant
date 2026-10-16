/**
 * QQ 渠道适配器（Bot Gateway WebSocket 长连接，免公网 IP）。
 * 从 ANS worker-ant 移植：WebSocket Gateway 接收消息，REST API 发送。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ImAdapter, ImMessageHandler, ImMessageMeta, ImSendOpts, ImStatusReporter } from './im-adapter.js';
import { nonTextPlaceholder, shouldRecordConversation } from './im-adapter.js';
import type { InboundMedia } from './im-media.js';
import { persistInboundMedia } from './im-media.js';
import { credentialFailure } from '../core/im/im-errors.js';
import { recordOutboundConversation } from '../core/im/outbound-record.js';
// zx_20260929 M8-a: 长度尺与「超了怎么截」的**唯一一份**（本家是五家里唯一设了人为上限的）。
import { fitOutboundText } from '../core/im/im-text.js';

const QQ_API_BASE = 'https://api.sgroup.qq.com';
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 } as const;

/** QQ 富媒体 `file_type`（官方枚举）：1=图片 2=视频 3=语音 4=文件。本适配器只会用 1 与 4。 */
const QQ_FILE_TYPE = { image: 1, file: 4 } as const;
/** `file_data`（base64 直传）的**单次**上限，官方约 10MB；再大须走分片上传（`upload_prepare`→PUT→合并，本适配器未实现）。 */
const QQ_MEDIA_SINGLE_MAX_BYTES = 10 * 1024 * 1024;
const EVENT = { READY: 'READY', AT_MESSAGE_CREATE: 'AT_MESSAGE_CREATE', C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE', DIRECT_MESSAGE_CREATE: 'DIRECT_MESSAGE_CREATE', GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE' } as const;

interface AccessToken { token: string; expiresAt: number; }

export class QqbotAdapter implements ImAdapter {
  private db: Database.Database;
  private channelId: string;
  private config: Record<string, string>;
  private dataDir: string;
  private status = 'inactive';
  private ws: WebSocket | null = null;
  private accessToken: AccessToken | null = null;
  private onMessageHandler: ImMessageHandler | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manuallyStopped = false;
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
   * zx_20260929 M8-e: 取令牌失败的**分因**（与另四家同一把尺）。
   * 本家 `getAccessToken()` 抛出的两条消息（`获取 QQ 访问令牌失败: <status>` / `QQ 访问令牌为空`）
   * 里**没有**"配没配"这个信息——能分辨那件事的只有 `config` 本身，故判据取自配置，不猜远端为什么拒。
   */
  private tokenFailure(detail: string): Error {
    return credentialFailure('qqbot', {
      missingConfig: !((this.config.app_id || this.config.appId) && (this.config.client_secret || this.config.clientSecret)),
      detail,
    });
  }

  async start(): Promise<void> {
    this.report('starting', '正在启动');
    this.manuallyStopped = false;
    const appId = this.config.app_id || this.config.appId || '';
    const clientSecret = this.config.client_secret || this.config.clientSecret || '';
    if (!appId || !clientSecret) {
      this.report('error', '缺少 app_id / client_secret');
      throw new Error('QQ Bot 需要 app_id 和 client_secret');
    }
    await this.connectGateway();
  }

  async stop(): Promise<void> {
    this.manuallyStopped = true;
    this.status = 'inactive';
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) { try { this.ws.close(1000, 'Bot stopped'); } catch {} this.ws = null; }
    this.accessToken = null;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.token;
    const resp = await fetch(QQ_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.config.app_id || this.config.appId, clientSecret: this.config.client_secret || this.config.clientSecret }),
    });
    if (!resp.ok) throw new Error(`获取 QQ 访问令牌失败: ${resp.status}`);
    const data = await resp.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('QQ 访问令牌为空');
    this.accessToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) - 300) * 1000 };
    return this.accessToken.token;
  }

  private async getGatewayUrl(): Promise<string> {
    const token = await this.getAccessToken();
    const resp = await fetch(`${QQ_API_BASE}/gateway`, { headers: { Authorization: `QQBot ${token}` } });
    if (!resp.ok) throw new Error(`获取 QQ Gateway 失败: ${resp.status}`);
    const data = await resp.json() as { url?: string };
    if (!data.url) throw new Error('QQ Gateway 响应缺少 url');
    return data.url;
  }

  private async connectGateway(): Promise<void> {
    const gatewayUrl = await this.getGatewayUrl();
    this.ws = new WebSocket(gatewayUrl);

    this.ws.onmessage = (event) => {
      try { this.handleGatewayMessage(JSON.parse(String(event.data)) as Record<string, unknown>); } catch {}
    };
    this.ws.onclose = () => { if (!this.manuallyStopped) this.scheduleReconnect(); };
    this.ws.onerror = () => {};
  }

  private handleGatewayMessage(data: Record<string, unknown>): void {
    const op = data.op as number;
    if (data.s !== undefined && data.s !== null) this.seq = data.s as number;
    const d = (data.d as Record<string, unknown>) || {};

    if (op === OP.HELLO) {
      const interval = (d.heartbeat_interval as number) || 30_000;
      this.startHeartbeat(interval);
      this.identify();
    } else if (op === OP.DISPATCH) {
      this.reconnectAttempts = 0;
      const t = data.t as string;
      if (t === EVENT.READY) {
        this.report('running', 'Bot 已连接');
        console.log(`[IM:qqbot] Bot 已连接 channel=${this.channelId}`);
      } else if (([EVENT.AT_MESSAGE_CREATE, EVENT.C2C_MESSAGE_CREATE, EVENT.DIRECT_MESSAGE_CREATE, EVENT.GROUP_AT_MESSAGE_CREATE] as string[]).includes(t)) {
        void this.handleMessage(t, d);
      }
    } else if (op === OP.RECONNECT) {
      this.scheduleReconnect();
    } else if (op === OP.INVALID_SESSION) {
      this.seq = null;
      this.scheduleReconnect();
    }
  }

  private identify(): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({
      op: OP.IDENTIFY,
      d: {
        token: `QQBot ${this.accessToken?.token || ''}`,
        intents: (1 << 30) | (1 << 12) | (1 << 25),
        shard: [0, 1],
      },
    }));
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws) this.ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
    }, intervalMs);
  }

  private scheduleReconnect(): void {
    if (this.manuallyStopped || this.status === 'inactive') return;
    this.reconnectAttempts++;
    // 无上限重连（QQ Gateway 会话可长期存活）⇒ 永远停在 degraded，如实示人："还没放弃，但不健康"。
    this.report('degraded', `连接断开，重连中（第 ${this.reconnectAttempts} 次）`);
    const delays = [2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(this.reconnectAttempts - 1, delays.length - 1)];
    this.reconnectTimer = setTimeout(() => { void this.connectGateway().catch(() => this.scheduleReconnect()); }, delay);
  }

  /**
   * zx_20260924 M4: 发一件文件——**一步**（QQ 与飞书/企微/钉钉不同：不换 id，直接传字节）。
   *
   * `POST /v2/{groups|users}/{openid}/files`，`file_data` 放 base64、`srv_send_msg: true` 让它直接投递
   * （官方推荐 `false` 再走发消息接口，但那是为了一条 file_info 复用发多处；本路一次只发一处，少一步少一处失配）。
   *
   * 三条如实：
   *  · 路径按 `toUser` 前缀分流——**与 `sendReply` 同一套判据**（群 `R_` / 用户 `0x`，其余按纯数字判频道）；
   *  · `file_data` 有**单次约 10MB** 上限，超了**明说"需分片上传（未实现）"**，不丢给平台去回一个莫名其妙的状态码；
   *  · 频道（`/channels/` 那条）**未实测有无对应的富媒体接口**，故**不做猜测性调用**，直接抛出"本通道暂不支持发件"——
   *    宁可这一次明确失败（上层照常落账补发），也不发一条"成功"却什么也没到的消息。
   */
  async sendMedia(toUser: string, file: { path: string; kind: 'image' | 'file'; name?: string }, opts?: ImSendOpts): Promise<void> {
    const name = file.name || path.basename(file.path);
    const buf = fs.readFileSync(file.path);
    if (buf.byteLength > QQ_MEDIA_SINGLE_MAX_BYTES) {
      throw new Error(`[IM:qqbot] 件大小 ${buf.byteLength}B 超过单次上传上限 ${QQ_MEDIA_SINGLE_MAX_BYTES}B，需分片上传（未实现）`);
    }
    if (!toUser.startsWith('R_') && !toUser.startsWith('0x') && /[^0-9]/.test(toUser)) {
      throw new Error('[IM:qqbot] 频道消息暂不支持发送文件');
    }
    const token = await this.getAccessToken();
    const scope = toUser.startsWith('R_') ? 'groups' : 'users';
    const resp = await fetch(`${QQ_API_BASE}/v2/${scope}/${toUser}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
      // `file_name` 在 `file_data` 模式下平台**未必采信**（自定义件名须走分片上传）——带上，但不假装它一定生效。
      body: JSON.stringify({ file_type: QQ_FILE_TYPE[file.kind], file_data: buf.toString('base64'), srv_send_msg: true, file_name: name }),
    });
    const data = await resp.json() as { file_uuid?: string; id?: string; code?: number; message?: string };
    if (!resp.ok || (!data.file_uuid && !data.id)) {
      throw new Error(`[IM:qqbot] 发送文件失败 status=${resp.status} code=${data.code} msg=${data.message || ''}`);
    }
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'qqbot', externalUserId: toUser,
        messageJson: { text: `📎 ${name}`, media: { kind: file.kind, name, path: file.path } },
        taskId: opts?.taskId,
      });
    }
  }

  /**
   * 处理一条消息事件。
   *
   * zx_20260924 M3：非文本**取件 + 落盘**——QQ 的富媒体不像企微/钉钉那样要换码，
   * `attachments[0].url` **直接就是可下载的地址**（平台 CDN，**带签名且有时效**）
   * ⇒ 必须收到即取，不做任何暂存（暂存下来的链接到期即失效，等于没取）。
   * 取件是异步的故本方法改 `async`：**文本那条路行为逐字不变**（只是外层 await 一个立即 resolve 的 async 函数）。
   */
  private async handleMessage(eventType: string, data: Record<string, unknown>): Promise<void> {
    const authorObj = (data.author as Record<string, unknown>) || {};
    let from = '';
    let content = '';
    let chatType = 'direct';

    if (eventType === EVENT.C2C_MESSAGE_CREATE) {
      from = (authorObj.user_openid as string) || '';
      content = (data.content as string) || '';
      chatType = 'direct';
    } else if (eventType === EVENT.GROUP_AT_MESSAGE_CREATE) {
      from = (data.group_openid as string) || '';
      content = (data.content as string) || '';
      chatType = 'group';
    } else if (eventType === EVENT.AT_MESSAGE_CREATE) {
      from = (data.channel_id as string) || '';
      content = (data.content as string) || '';
      chatType = 'group';
    } else if (eventType === EVENT.DIRECT_MESSAGE_CREATE) {
      from = (data.guild_id as string) || '';
      content = (data.content as string) || '';
      chatType = 'direct';
    } else {
      return;
    }
    if (!content) {
      // zx_20260914 M1-2(维特根斯坦·意义即使用): 非文本消息（图片/文件/语音/视频）在 QQ 侧走
      // `attachments`、`content` 为空——此前 `if (!content) return` 把整条丢弃。现按第一个附件
      // 如实到场：类型取 `content_type` 主类型，文件名/大小有就带（真值，平台没给就不写）。
      const attachments = Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : [];
      const a = attachments[0];
      if (a) {
        const contentType = (a.content_type as string) || '';
        const kind = contentType.includes('/') ? (contentType.split('/')[0] || 'attachment') : (contentType || 'attachment');
        const fileName = (a.filename as string) || undefined;
        const size = a.size;
        const sizeBytes = typeof size === 'number' && Number.isFinite(size) ? size : undefined;
        content = nonTextPlaceholder(kind, fileName, sizeBytes);
        const messageId = (data.id as string) || undefined;
        const meta: ImMessageMeta = { kind, ...(fileName ? { fileName } : {}), ...(sizeBytes !== undefined ? { sizeBytes } : {}), ...(messageId ? { messageId } : {}) };
        // 取件：`attachments[0].url` 即下载地址（**自带签名**，故 GET 不带任何鉴权头——不是漏了）。
        const url = (a.url as string) || undefined;
        if (url) {
          meta.mediaUrl = url;
          const media: InboundMedia = { kind, mediaUrl: url, ...(fileName ? { fileName } : {}) };
          Object.assign(meta, await persistInboundMedia(this.dataDir, media));
        }
        console.log(`[IM:qqbot] 收到非文本消息 from=${from.slice(0, 8)} kind=${kind} placeholder="${content}"`);
        if (this.onMessageHandler) void this.onMessageHandler(from, content, chatType, '', meta);
        return;
      }
      return;
    }

    console.log(`[IM:qqbot] 收到消息 from=${from.slice(0, 8)} text="${content.slice(0, 50)}"`);
    if (this.onMessageHandler) void this.onMessageHandler(from, content, chatType, '');
  }

  /** 发送回复消息。失败时抛异常（与 wechat 同契约），供上层感知"未送达"并落 outbox 补发。
   *  `contextToken` 槽位本家**不用**（`ImAdapter` 契约占位，保持与 wechat 同一位置约定），`opts` 恒在其后。 */
  async sendReply(toUser: string, text: string, _contextToken?: string, opts?: ImSendOpts): Promise<void> {
    if (!text) return;
    // zx_20260930 M2-d: 发落归**一处真源**（`fitOutboundText`）——有上限才截并告知，无上限不截只提示。
    //   本家登记了上限（官方单条 4000）⇒ 走截断那一态，与 `IM_SEND_TEXT_LIMIT` 读同一张表。
    //   ⚠ 此后 `text` 就是**真发出去的那串**：下面落账也用它——此前落的是未截的原文，
    //     于是 IM 页显示 4700 字、用户收到 4000 字，账与实物不符（同一件事两个值）。
    text = fitOutboundText('qqbot', text).text;
    // zx_20260929 M8-e: 本家 `getAccessToken()` 是**抛**的（另四家返回 null）——形状不同，但"这次失败算什么事"
    //   的判尺必须是同一把：没配凭证 ⇒ 条件缺失（不烧次数）；网络/远端拒签 ⇒ 普通失败（照旧退避烧次数）。
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err) {
      throw this.tokenFailure((err as Error).message);
    }
    let endpoint: string;
    if (toUser.startsWith('R_')) endpoint = `/v2/groups/${toUser}/messages`;
    else if (toUser.startsWith('0x')) endpoint = `/v2/users/${toUser}/messages`;
    else if (/[^0-9]/.test(toUser)) endpoint = `/v2/users/${toUser}/messages`;
    else endpoint = `/channels/${toUser}/messages`;

    const resp = await fetch(`${QQ_API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
      // zx_20260930 M2-d: 正文已在函数头经 `fitOutboundText('qqbot', …)` 定形（截断 + 告知），
      //   此处原样发出即可——**不再在发请求这一行里截**（发的那一行只该管"怎么发"，不该管"发多少"）。
      body: JSON.stringify({ content: text, msg_type: 0 }),
    });
    if (!resp.ok) {
      throw new Error(`[IM:qqbot] 发送回复失败 status=${resp.status}`);
    }
    // 补发路径传 recordConversation:false —— 原行已在首次失败时落库，由 flipConversationSent 翻正，不另插新行。
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'qqbot', externalUserId: toUser,
        messageJson: { text },
        taskId: opts?.taskId,
      });
    }
  }
}
