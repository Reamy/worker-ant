/**
 * 企业微信渠道适配器。
 * 从 ANS worker-ant 移植：发送走 message/send API；接收需回调地址（企业微信无原生 WebSocket/长轮询）。
 * 桌面端本地无公网 IP，接收消息需配合回调地址（标 — 部分适用）。
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

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';

export class WecomAdapter implements ImAdapter {
  private db: Database.Database;
  private channelId: string;
  private config: Record<string, string>;
  private dataDir: string;
  private status = 'inactive';
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
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
   * zx_20260929 M8-e: 取 access_token 失败的**分因**——`getAccessToken()` 只分得出"配没配"这一件事。
   * 没配 ⇒ 条件缺失（不烧次数，等有人去配）；网络抖动/远端拒签 ⇒ 普通失败（照旧退避烧次数）。
   * ⚠ 本家**没有入站通道**（接收需公网回调地址）⇒ 条件缺失不会"等来一次入站"自愈，只能等人去配——
   *   正因如此，把"网络抖动"也判成条件缺失会更糟（一条通知白等到天荒地老）。
   */
  private tokenFailure(): Error {
    return credentialFailure('wecom', {
      missingConfig: !(this.config.corpId && this.config.corpSecret),
      detail: '无法获取 access_token，发送失败',
    });
  }

  async start(): Promise<void> {
    this.report('starting', '正在启动');
    const corpId = this.config.corpId || '';
    const corpSecret = this.config.corpSecret || '';
    const agentId = this.config.agentId || '';
    if (!corpId || !corpSecret || !agentId) {
      this.report('error', '缺少 corpId / corpSecret / agentId');
      throw new Error('企业微信 corpId、corpSecret 和 agentId 是必需的');
    }
    const token = await this.getAccessToken();
    if (!token) { this.report('error', '无法获取 access_token'); throw new Error('无法获取企业微信 access_token'); }
    // 本渠道仅出站（接收需公网回调地址，桌面端不具备）⇒ 启动成功即静态 running，无运行期断连可言。
    this.report('running', '已启动（发送可用，接收需回调地址）');
    console.log(`[IM:wecom] 已启动（发送可用，接收消息需回调地址） channel=${this.channelId}`);
  }

  async stop(): Promise<void> {
    this.status = 'inactive';
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    try {
      const resp = await fetch(`${WECOM_API}/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.corpSecret}`);
      const data = await resp.json() as { errcode?: number; access_token?: string; expires_in?: number };
      if (data.errcode === 0 && data.access_token) {
        this.accessToken = data.access_token;
        this.tokenExpiresAt = Date.now() + ((data.expires_in || 7200) - 300) * 1000;
        return this.accessToken;
      }
      return null;
    } catch { return null; }
  }

  /** 处理企业微信回调消息（供回调接收器调用）。
   *
   *  zx_20260924 M3：非文本消息**取件 + 落盘**（此前只记 `kind`，字节永远拿不到）。
   *  取件地址由 `<MediaId>` 现拼（`media/get`，见下）——`media_id` **3 天**有效，
   *  故不做任何暂存，收到即取。取件是**异步**的 ⇒ 本方法改 `async`：
   *  **无 `MediaId` 的那条路（含全部文本消息）仍同步调 handler，行为逐字不变**。
   */
  async handleMessagePayload(payload: Record<string, unknown>): Promise<void> {
    const msgType = (payload.MsgType as string) || '';
    const content = (payload.Content as string) || '';
    const fromUser = (payload.FromUserName as string) || 'unknown';
    const chatType = String(payload.ToUserName || '').startsWith('chat_') ? 'group' : 'direct';
    // zx_20260914 M1-2(维特根斯坦·意义即使用): 非文本（image/voice/video/location/link…）不再
    // 整条丢弃——转类型占位符如实到场。**只随非文本带 meta**：文本路径字节不变，
    // `messageId` 也只在非文本时带出（占位符长得一样，按正文去重会吞掉第二张图）。
    const isNonText = !!msgType && msgType !== 'text';
    if (!content && !isNonText) return;
    const text = content || nonTextPlaceholder(msgType, (payload.FileName as string) || undefined);
    let meta: ImMessageMeta | undefined;
    if (isNonText) {
      meta = { kind: msgType };
      const fileName = (payload.FileName as string) || undefined;
      if (fileName) meta.fileName = fileName;
      const messageId = (payload.MsgId as string) || undefined;
      if (messageId) meta.messageId = messageId;
      // 取件：标识字段是 **`MediaId`（PascalCase）**——自建应用的回调只有加密 XML 一种形态，
      //   字段名跟着 XML 走。`media_ids`/`media_id` 是**别的产品**（客服 sync_msg / 智能机器人）的形状，别混。
      const mediaId = (payload.MediaId as string) || undefined;
      if (mediaId) {
        const token = await this.getAccessToken();
        if (!token) {
          meta.mediaError = '无法获取 access_token，未能取件';
        } else {
          // `media/get` 的 token 走 **query**（本家惯例），故请求头为空——不是漏了。
          const mediaUrl = `${WECOM_API}/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;
          meta.mediaUrl = mediaUrl;
          const media: InboundMedia = { kind: msgType, mediaUrl, ...(fileName ? { fileName } : {}) };
          Object.assign(meta, await persistInboundMedia(this.dataDir, media));
        }
      }
    }
    console.log(`[IM:wecom] 收到回调消息 from=${fromUser.slice(0, 8)} text="${text.slice(0, 50)}"`);
    if (this.onMessageHandler) void this.onMessageHandler(fromUser, text, chatType, '', meta);
  }

  /** 发送回复消息。失败时抛异常（与 wechat 同契约），供上层感知"未送达"并落 outbox 补发。
   *  `contextToken` 槽位本家**不用**（`ImAdapter` 契约占位，保持与 wechat 同一位置约定），`opts` 恒在其后。 */
  async sendReply(toUser: string, text: string, _contextToken?: string, opts?: ImSendOpts): Promise<void> {
    if (!text) return;
    // zx_20260930 M2-d: 发落归**一处真源**（`fitOutboundText`）——有上限才截并告知，无上限不截只提示。
    //   本家**没有**登记上限 ⇒ 超阈值时一字不动，只在末尾如实附一句"未截断"（静默原样发送是病）。
    //   ⚠ 此后 `text` 就是**真发出去的那串**，下面落账也用它（账与实物同一串）。
    text = fitOutboundText('wecom', text).text;
    const token = await this.getAccessToken();
    if (!token) throw this.tokenFailure();
    const resp = await fetch(`${WECOM_API}/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: toUser,
        msgtype: 'text',
        agentid: parseInt(this.config.agentId || '0', 10),
        text: { content: text },
      }),
    });
    const data = await resp.json() as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) {
      throw new Error(`[IM:wecom] 发送回复失败 errcode=${data.errcode} errmsg=${data.errmsg || ''}`);
    }
    // 补发路径传 recordConversation:false —— 原行已在首次失败时落库，由 flipConversationSent 翻正，不另插新行。
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'wecom', externalUserId: toUser,
        messageJson: { text },
        taskId: opts?.taskId,
      });
    }
  }

  /**
   * zx_20260924 M4: 发一件文件——**两步**（与飞书同构：先换 id 再发消息）。
   *
   * ① `POST /cgi-bin/media/upload?access_token=…&type=image|file`（multipart，字段名恒为 `media`）
   *    → `media_id`；② 按 `msgtype=image|file` 发 `message/send`。
   *
   * ⚠ **上传的 `type` 与发消息的 `msgtype` 必须同值**（官方：`type=image` 得的 media_id 只能当图片发）。
   *   `kind` 只有两个取值，故直接一一对应，不做映射表。
   * ⚠ `media_id` **3 天内有效**——本函数不做任何缓存：拿到即发，用过期 id 换来"发送成功"才是更糟的谎。
   */
  async sendMedia(toUser: string, file: { path: string; kind: 'image' | 'file'; name?: string }, opts?: ImSendOpts): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) throw this.tokenFailure();
    const name = file.name || path.basename(file.path);
    const buf = fs.readFileSync(file.path);
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(buf)]), name);
    const upResp = await fetch(`${WECOM_API}/media/upload?access_token=${token}&type=${file.kind}`, { method: 'POST', body: form });
    const up = await upResp.json() as { errcode?: number; errmsg?: string; media_id?: string };
    if (up.errcode !== 0 || !up.media_id) {
      throw new Error(`[IM:wecom] 上传文件失败 errcode=${up.errcode} errmsg=${up.errmsg || ''}`);
    }
    const resp = await fetch(`${WECOM_API}/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: toUser,
        msgtype: file.kind,
        agentid: parseInt(this.config.agentId || '0', 10),
        [file.kind]: { media_id: up.media_id },
      }),
    });
    const data = await resp.json() as { errcode?: number; errmsg?: string };
    if (data.errcode !== 0) {
      throw new Error(`[IM:wecom] 发送文件失败 errcode=${data.errcode} errmsg=${data.errmsg || ''}`);
    }
    if (shouldRecordConversation(opts)) {
      recordOutboundConversation(this.db, {
        channelId: this.channelId, channelType: 'wecom', externalUserId: toUser,
        messageJson: { text: `📎 ${name}`, media: { kind: file.kind, name, path: file.path } },
        taskId: opts?.taskId,
      });
    }
  }
}
