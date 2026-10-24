/**
 * 钉钉渠道适配器（Stream 长连接模式，免公网 IP）。
 * 从 ANS worker-ant 移植：通过 WebSocket 长连接接收消息，REST API 发送。
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

const DINGTALK_API = 'https://api.dingtalk.com';
/** 媒体上传走的是**旧域名**——它与 `oapi` 系接口成对，`access_token` 由下面 `getOapiToken` 单独取。 */
const DINGTALK_OAPI = 'https://oapi.dingtalk.com';

interface AccessToken { token: string; expiresAt: number; }

export class DingtalkAdapter implements ImAdapter {
  private db: Database.Database;
  private channelId: string;
  private config: Record<string, string>;
  private dataDir: string;
  private status = 'inactive';
  private ws: WebSocket | null = null;
  private accessToken: AccessToken | null = null;
  private onMessageHandler: ImMessageHandler | null = null;
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
   * zx_20260929 M8-e: 取 token 失败的**分因**——两个 getter（新版 `getAccessToken` / 上传用 `getOapiToken`）
   * 对"远端拒签/网络抖动"与"压根没配"都返回 `null`，能分辨的只有"配上没配上"这一件事，就按它分。
   * 没配 ⇒ 条件缺失（不烧次数，等有人去配）；其余 ⇒ 普通失败（照旧退避烧次数）。
   */
  private tokenFailure(detail: string): Error {
    return credentialFailure('dingtalk', {
      missingConfig: !((this.config.clientId || this.config.appKey) && (this.config.clientSecret || this.config.appSecret)),
      detail,
    });
  }

  async start(): Promise<void> {
    this.report('starting', '正在启动');
    this.manuallyStopped = false;
    const clientId = this.config.clientId || this.config.appKey || '';
    const clientSecret = this.config.clientSecret || this.config.appSecret || '';
    if (!clientId || !clientSecret) {
      this.report('error', '缺少 clientId / clientSecret');
      throw new Error('钉钉 clientId 和 clientSecret 是必需的');
    }
    await this.connectStream();
  }

  async stop(): Promise<void> {
    this.manuallyStopped = true;
    this.status = 'inactive';
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.accessToken = null;
    this.oapiToken = null;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.token;
    try {
      const resp = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: this.config.clientId || this.config.appKey, appSecret: this.config.clientSecret || this.config.appSecret }),
      });
      const data = await resp.json() as { accessToken?: string; expiresIn?: number };
      if (!data.accessToken) return null;
      this.accessToken = { token: data.accessToken, expiresAt: Date.now() + ((data.expiresIn || 7200) - 300) * 1000 };
      return this.accessToken.token;
    } catch { return null; }
  }

  /**
   * zx_20260924 M4: 发一件文件——**两步**，且两步用的**不是同一个 token**（这是钉钉与飞书/企微最大的不同）。
   *
   * ① 上传换 `media_id`：`POST https://oapi.dingtalk.com/media/upload?access_token=…`，
   *    multipart 只有两个字段：`type`(image|file) + `media`(二进制)。
   * ② 发单聊消息：`POST /v1.0/robot/oToMessages/batchSend`（与 `sendReply` 同一接口），
   *    `msgKey` 图片 `sampleImage` / 文件 `sampleFile`，`msgParam` 里放 `mediaId`
   *    （文件另带 `fileName`/`fileSize`/`fileType`，后两者可选但有就给）。
   *
   * ⚠ **`sampleImageMsg`（`photoURL`，URL 版）与 `sampleImage`（`mediaId`，上传版）是两个 msgKey**：
   *   本路手里只有盘上的字节、没有公网 URL，故**只能**走上传版 `sampleImage`。写错成前者会得到一个
   *   HTTP 200 但图片不显示的结果——**"发成功"却什么都没有**，正是本项目最忌讳的那种谎。
   *
   * 上传那步**刻意另取旧版 token**（`getOapiToken`）：`oapi` 域与 `gettoken` 是官方成对的一组，
   * 而本适配器流/发消息用的是 `api.dingtalk.com` 的新版 token——两者能否互换**没有实测依据**，
   * 故不靠"大概通用"去省一次请求。任一步 `errcode !== 0` 一律抛出（不吞、不假装）。
   */
  async sendMedia(toUser: string, file: { path: string; kind: 'image' | 'file'; name?: string }, opts?: ImSendOpts): Promise<void> {
    const name = file.name || path.basename(file.path);
    const buf = fs.readFileSync(file.path);
    const oapiToken = await this.getOapiToken();
    if (!oapiToken) throw this.tokenFailure('无法获取上传用 access_token，发送失败');
    const form = new FormData();
    form.append('type', file.kind);
    form.append('media', new Blob([new Uint8Array(buf)]), name);
    const upResp = await fetch(`${DINGTALK_OAPI}/media/upload?access_token=${encodeURIComponent(oapiToken)}`, { method: 'POST', body: form });
    const up = await upResp.json() as { errcode?: number; errmsg?: string; media_id?: string };
    if (up.errcode !== 0 || !up.media_id) {
      throw new Error(`[IM:dingtalk] 上传文件失败 errcode=${up.errcode} errmsg=${up.errmsg || ''}`);
    }
    const token = await this.getAccessToken();
    if (!token) throw this.tokenFailure('无法获取 access_token，发送失败');
    const msgParam = file.kind === 'image'
      ? { mediaId: up.media_id }
      : { mediaId: up.media_id, fileName: name, fileSize: String(buf.byteLength), fileType: (path.extname(name).replace('.', '') || 'file') };
    const resp = await fetch(`${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        robotCode: this.config.robotCode || '',
        userIds: [toUser],
        msgKey: file.kind === 'image' ? 'sampleImage' : 'sampleFile',
        msgParam: JSON.stringify(msgParam),
      }),
    });
    const data = await resp.json() as { code?: number; message?: string; processQueryKey?: string };
    if (!data.processQueryKey) {
      throw new Error(`[IM:dingtalk] 发送文件失败 code=${data.code} msg=${data.message || ''}`);
    }
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'dingtalk', externalUserId: toUser,
        messageJson: { text: `📎 ${name}`, media: { kind: file.kind, name, path: file.path } },
        taskId: opts?.taskId,
      });
    }
  }

  /** `oapi` 系接口的旧版 token（仅上传媒体用）。与 `getAccessToken` **分开缓存**——两者换不来换得去没实测依据。 */
  private oapiToken: AccessToken | null = null;

  private async getOapiToken(): Promise<string | null> {
    if (this.oapiToken && Date.now() < this.oapiToken.expiresAt) return this.oapiToken.token;
    const appKey = this.config.clientId || this.config.appKey || '';
    const appSecret = this.config.clientSecret || this.config.appSecret || '';
    if (!appKey || !appSecret) return null;
    try {
      const resp = await fetch(`${DINGTALK_OAPI}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`);
      const data = await resp.json() as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
      if (data.errcode !== 0 || !data.access_token) {
        console.warn(`[IM:dingtalk] 旧版 token 获取失败 errcode=${data.errcode} errmsg=${data.errmsg || ''}`);
        return null;
      }
      this.oapiToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in || 7200) - 300) * 1000 };
      return this.oapiToken.token;
    } catch { return null; }
  }

  private async connectStream(): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) { this.report('error', '无法获取 access_token'); throw new Error('无法获取钉钉 access_token'); }

    const wsUrl = `${DINGTALK_API.replace('https', 'wss')}/v1.0/gateway/connections/open?token=${token}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.report('running', 'Stream 已连接');
      this.reconnectAttempts = 0;
      console.log(`[IM:dingtalk] Stream 已连接 channel=${this.channelId}`);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>;
        void this.handleMessage(data);
      } catch { /* 忽略解析错误 */ }
    };

    this.ws.onclose = () => {
      if (this.manuallyStopped) return;
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error(`[IM:dingtalk] Stream 错误:`, err);
    };
  }

  private scheduleReconnect(): void {
    if (this.manuallyStopped || this.status === 'inactive') return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > 5) {
      this.report('error', '重连失败（已达最大次数 5）');
      console.error('[IM:dingtalk] 重连失败(已达最大次数)');
      return;
    }
    this.report('degraded', `连接断开，重连中（第 ${this.reconnectAttempts} 次）`);
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    // 失败后不再自动续试（既有语义不变）；但把原因如实上报，避免「静默地死」。
    this.reconnectTimer = setTimeout(() => {
      void this.connectStream().catch((err: unknown) => {
        this.report('error', `重连失败：${err instanceof Error ? err.message : String(err)}`);
      });
    }, delay);
  }

  /**
   * 处理一帧 Stream 推送。
   *
   * zx_20260924 M3 **就地纠了两处让钉钉入站等于不存在的老账**（不是本轮新引入的）：
   *   ① 帧的 `type` 官方三态是 `SYSTEM` / `EVENT` / `CALLBACK`（回调 Topic 固定 `/v1.0/im/bot/messages/get`），
   *      原判据只认 `MESSAGE`/`SYSTEM` ⇒ **真帧（`CALLBACK`）在第一行就被丢掉**；
   *   ② 帧的 `data` 是**推送数据的 JSON 字符串**（官方协议描述原文），须二次解析——原码 `data.data` 直接当对象用。
   * 另有一处字段错位：文本在 `payload.text.content`，`payload.content` 是**对象**（非文本的媒体体）。
   * 三处叠加的后果是：文本读不到（真字段在别处）、非文本拿到对象（`body.slice` 抛 TypeError 被外层 catch 吞掉）
   * ⇒ 钉钉入站**两类消息全数无声丢弃**，而 rr 夹具喂的是 `{type:'MESSAGE', data:{msgtype}}` 这种**生产里不存在**
   * 的形状，故一直假绿。本轮按官方文档把三处一并归位，并补上非文本的**取件 + 落盘**。
   *
   * ⚠ 未做（如实挂账）：官方 Stream 协议要求处理完后**回一个带 `messageId` 的响应帧**（否则平台会重投），
   *   本实现未回 ⇒ 实机联调时需观察是否出现重投（重投的文本消息会重复落行）。此处不新增协议能力，留档待验。
   */
  private async handleMessage(data: Record<string, unknown>): Promise<void> {
    const type = data.type as string | undefined;
    if (type !== 'MESSAGE' && type !== 'SYSTEM' && type !== 'CALLBACK') return;
    // 帧 `data`：Stream 模式是 JSON 字符串（须二次解析），HTTP 回调模式已是对象。两种都收（同一份协议的两个形态）。
    let payload: Record<string, unknown> | undefined;
    if (typeof data.data === 'string') {
      try { payload = JSON.parse(data.data) as Record<string, unknown>; } catch { return; }
    } else if (data.data && typeof data.data === 'object') {
      payload = data.data as Record<string, unknown>;
    }
    if (!payload) return;
    // 文本在 `payload.text.content`；`payload.content` 是**对象**（picture/file/audio/video/richText 的媒体体）。
    // 保留对 `payload.content` 是字符串的兼容读取：老版 webhook 形态如此（移植前的实现即两处都读）。
    const textObj = payload.text as Record<string, unknown> | undefined;
    const text = (typeof textObj?.content === 'string' ? textObj.content : '')
      || (typeof payload.content === 'string' ? payload.content : '');
    // zx_20260914 M1-2(维特根斯坦·意义即使用): 钉钉机器人消息用 `msgtype` 标注类型（text/picture/richText/
    // audio/video/file…），非文本没有正文——此前 `if (!text) return` 把整条丢弃。有类型判据即如实到场。
    const msgType = (payload.msgtype as string) || (payload.msg_type as string) || '';
    const isNonText = !!msgType && msgType !== 'text';
    if (!text && !isNonText) return;
    const senderId = (payload.senderStaffId as string) || (payload.senderId as string) || 'unknown';
    const conversationType = payload.conversationType as string;
    const chatType = conversationType === '1' ? 'direct' : 'group';
    // 只随非文本带 meta：文本路径字节不变（`messageId` 也不给文本——不挪既有去重语义）。
    let meta: ImMessageMeta | undefined;
    if (isNonText) {
      const content = (payload.content && typeof payload.content === 'object')
        ? payload.content as Record<string, unknown> : {};
      const fileName = (content.fileName as string) || undefined;
      meta = { kind: msgType, ...(fileName ? { fileName } : {}) };
      const messageId = (payload.msgId as string) || undefined;
      if (messageId) meta.messageId = messageId;
      // 媒体标识：**单类型消息**是 `content.downloadCode`（picture/file/audio/video 同一位置）；
      //   **富文本**里每个图片件在 `content.richText[]`（`{type:'picture', downloadCode, pictureDownloadCode}`）。
      //   件类型与消息类型**不是一回事**：richText 消息里取出的那张图，件类型是 `picture`（决定落盘后缀），
      //   消息类型仍是 `richText`（决定正文占位符）。此处分别如实记录，不把两者压成一个。
      let mediaKind = msgType;
      let downloadCode = (content.downloadCode as string) || undefined;
      if (msgType === 'richText') {
        const items = Array.isArray(content.richText) ? content.richText as Array<Record<string, unknown>> : [];
        const pic = items.find((it) => it && typeof it === 'object' && (it.downloadCode || it.pictureDownloadCode));
        if (pic) {
          downloadCode = (pic.downloadCode as string) || (pic.pictureDownloadCode as string) || undefined;
          mediaKind = 'picture';
        }
      }
      if (downloadCode) {
        // 官方「下载机器人接收消息的文件内容」是**两步**：downloadCode → 临时下载地址 → 取字节。
        const token = await this.getAccessToken();
        if (!token) {
          meta.mediaError = '无法获取 access_token，未能取件';
        } else {
          const got = await this.resolveDownloadUrl(downloadCode, token);
          if (!got.ok) {
            meta.mediaError = got.error;
          } else {
            meta.mediaUrl = got.url;
            const media: InboundMedia = { kind: mediaKind, mediaUrl: got.url, ...(fileName ? { fileName } : {}) };
            // 第二步的 GET **不带鉴权头**（临时地址自带签名）。
            Object.assign(meta, await persistInboundMedia(this.dataDir, media));
          }
        }
      }
    }
    const body = text || nonTextPlaceholder(msgType, meta?.fileName);

    console.log(`[IM:dingtalk] 收到消息 from=${String(senderId).slice(0, 8)} text="${body.slice(0, 50)}"`);
    if (this.onMessageHandler) {
      void this.onMessageHandler(senderId, body, chatType, '', meta);
    }
  }

  /** `downloadCode` → 临时下载地址（两步法的第一步）。**永不抛**：失败如实返回真因，由调用方写进 `mediaError`。 */
  private async resolveDownloadUrl(downloadCode: string, token: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    try {
      const resp = await fetch(`${DINGTALK_API}/v1.0/robot/messageFiles/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        // `robotCode` 官方明示**可取 clientId**；配置里没填时退到 clientId/appKey，与发送路同源。
        body: JSON.stringify({ downloadCode, robotCode: this.config.robotCode || this.config.clientId || this.config.appKey || '' }),
      });
      const data = await resp.json() as { downloadUrl?: string; code?: string; message?: string };
      if (!data.downloadUrl) {
        return { ok: false, error: `换取下载地址失败 code=${data.code || resp.status} ${data.message || ''}`.trim() };
      }
      return { ok: true, url: data.downloadUrl };
    } catch (e) {
      return { ok: false, error: `换取下载地址失败：${(e as Error).message.slice(0, 200)}` };
    }
  }

  /** 发送回复消息。失败时抛异常（与 wechat 同契约），供上层感知"未送达"并落 outbox 补发。
   *  `contextToken` 槽位本家**不用**（`ImAdapter` 契约占位，保持与 wechat 同一位置约定），`opts` 恒在其后。 */
  async sendReply(toUser: string, text: string, _contextToken?: string, opts?: ImSendOpts): Promise<void> {
    if (!text) return;
    // zx_20260930 M2-d: 发落归**一处真源**（`fitOutboundText`）——有上限才截并告知，无上限不截只提示。
    //   本家**没有**登记上限 ⇒ 超阈值时一字不动，只在末尾如实附一句"未截断"（静默原样发送是病）。
    //   ⚠ 此后 `text` 就是**真发出去的那串**，下面落账也用它（账与实物同一串）。
    text = fitOutboundText('dingtalk', text).text;
    const token = await this.getAccessToken();
    if (!token) throw this.tokenFailure('无法获取 access_token，发送失败');
    const resp = await fetch(`${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        robotCode: this.config.robotCode || '',
        userIds: [toUser],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      }),
    });
    const data = await resp.json() as { code?: number; message?: string; processQueryKey?: string };
    if (!data.processQueryKey) {
      throw new Error(`[IM:dingtalk] 发送回复失败 code=${data.code} msg=${data.message || ''}`);
    }
    // 补发路径传 recordConversation:false —— 原行已在首次失败时落库，由 flipConversationSent 翻正，不另插新行。
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'dingtalk', externalUserId: toUser,
        messageJson: { text },
        taskId: opts?.taskId,
      });
    }
  }
}
