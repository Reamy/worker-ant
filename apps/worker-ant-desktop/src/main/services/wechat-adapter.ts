/**
 * 微信个人号渠道适配器（iLink 协议）。
 * 从原工蚁服务端移植到桌面端（Electron 主进程）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ImSendError, conditionMissing, looksLikeQuotaHint } from '../core/im/im-errors.js';
import { recordOutboundConversation } from '../core/im/outbound-record.js';
import { fitOutboundText } from '../core/im/im-text.js';
import { reviveQuotaBlockedOutbox } from '../core/im/im-outbox.js';
import type { ImMessageMeta, ImSendOpts, ImStatusReporter } from './im-adapter.js';
import { nonTextPlaceholder, shouldRecordConversation } from './im-adapter.js';
import type { InboundMedia, PersistMediaResult } from './im-media.js';
import { mediaFromIlinkItems, persistInboundMedia } from './im-media.js';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode';
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status';
const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';

/**
 * 出站换行适配（2026-09-10 定向实测）：
 * - 手机微信：`\n` / `\r\n` / 空行 / U+2028 都能断行；
 * - **macOS 微信：单个换行（无论 LF 还是 CRLF）一律折叠成空格，只有空行或 U+2028 才断行**；
 * - U+2028 与 `\n` 等长（BMP 码位，1 个 UTF-16 码元），不增字数、不会把卡片撑成双倍行距。
 * 故把逻辑换行统一在**唯一发送出口**转成 U+2028 —— 业务侧无需关心客户端差异，
 * 也无需在行内嵌 `\r\n`（该手法经实测无效）。
 */
const IM_LINE_SEP = '\u2028';

/** 把任意行尾（CRLF / CR / LF）归一后转为 U+2028。幂等。 */
export function toImText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, IM_LINE_SEP);
}

interface TokenData { token: string; base_url: string; account_id: string; scanner_user_id: string; saved_at: string; }

// zx_20260914 M1-2: 补可选 `meta`（非文本类型附注）——与共享契约 ImMessageHandler 同尺，
// 既有调用方不传即行为不变。
export type MessageHandler = (fromUser: string, text: string, chatType: string, contextToken: string, meta?: ImMessageMeta) => void | Promise<void>;

/** zx_20260912 M1: 长轮询连续失败达此次数 ⇒ 上报 degraded（不退出循环，仅如实示人）。 */
const DEGRADED_AFTER_FAILURES = 3;

/** iLink **会话级**错误码：`-14` = session timeout。
 *  与业务级 `ret` 是两条轴——服务端用 `HTTP 200 + {"errcode":-14,"errmsg":"session timeout"}` 表达
 *  "这个绑定已被顶掉/登录态已失效"，**响应里没有 `ret` 字段**（2026-10-10 实机误判根因）。 */
const ILINK_ERR_SESSION_TIMEOUT = -14;

export class WechatAdapter {
  private db: Database.Database;
  private channelId: string;
  private config: Record<string, string>;
  private status = 'inactive';
  private token: TokenData | null = null;
  private running = false;
  private syncBuf = '';
  private contextTokens = new Map<string, string>();
  private qrState: { qrcode: string; qrcode_img: string; status: string } | null = null;
  private dataDir: string;
  private pollBackoffMs = 1_000;
  private onMessageHandler: MessageHandler | null = null;
  private statusReporter: ImStatusReporter | null = null;
  /** 第十一轮 Phase 5: 主动推送配额追踪（key=toUser，用户 inbound 后重置统计窗口）。warned=本窗口是否已提醒过刷新配额。 */
  private pushQuota = new Map<string, { used: number; limit: number; lastUserMsgAt: number; warned: boolean }>();
  private static readonly QUOTA_LIMIT_DEFAULT = 5;
  private static readonly QUOTA_WARN_THRESHOLD = 1;

  constructor(db: Database.Database, channelId: string, config: Record<string, string>, dataDir: string) {
    this.db = db;
    this.channelId = channelId;
    this.config = config;
    this.dataDir = dataDir;
  }

  /** 设置消息处理器（由 IM Router 注入） */
  onMessage(handler: MessageHandler): void { this.onMessageHandler = handler; }
  /** zx_20260912 M1: 状态上报器（由 im.ipc 的 createAdapter 装配） */
  setStatusReporter(reporter: ImStatusReporter): void { this.statusReporter = reporter; }

  getStatus() { return this.status; }
  getQrState() { return this.qrState; }

  /** 状态跃迁的唯一出口：改内存 + 上报（上报方落库并发 channel.status_changed）。
   *  `stop()` 不走此处——停止由 im:stopChannel 统一写库发事件；退出时的 stopAll 故意不写库。 */
  private report(status: string, detail?: string): void {
    this.status = status;
    try { this.statusReporter?.({ status, ...(detail ? { detail } : {}) }); } catch { /* 上报失败不影响适配器 */ }
  }

  async start(): Promise<void> {
    if (this.status === 'running') return;
    this.report('starting', '正在启动');
    console.log(`[IM:wechat] 启动渠道 ${this.channelId}`);

    const saved = this.loadToken();
    if (saved) {
      this.token = saved;
      if (saved.base_url) this.config.base_url = saved.base_url;
      this.running = true;
      this.report('running', '使用已保存令牌启动');
      this.startLongPoll();
      console.log(`[IM:wechat] 使用已保存令牌启动 channel=${this.channelId} account=${saved.account_id}`);
      return;
    }

    // 获取QR码
    try {
      const botType = this.config.bot_type || '3';
      const qrResp = await this.apiGet(EP_GET_BOT_QR, { bot_type: botType });
      const qrcode = qrResp.qrcode as string | undefined;
      if (!qrcode) { this.report('error', '获取微信二维码失败'); throw new Error('获取微信QR码失败'); }
      const imgContent = (qrResp.qrcode_img_content as string) || (qrResp.qrcode_img as string) || '';
      this.qrState = { qrcode, qrcode_img: imgContent, status: 'waiting' };
      this.report('pending', '等待扫码登录');
      this.pollQrStatus(qrcode);
      console.log(`[IM:wechat] QR码已生成，等待扫码 channel=${this.channelId}`);
    } catch (err) {
      this.report('error', `启动失败：${(err as Error).message}`);
      console.error(`[IM:wechat] 启动失败:`, (err as Error).message);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.status = 'inactive';
    console.log(`[IM:wechat] 渠道已停止 channel=${this.channelId}`);
  }

  private async pollQrStatus(qrcode: string): Promise<void> {
    const deadline = Date.now() + 480_000;
    while (Date.now() < deadline && this.status === 'pending') {
      await this.sleep(2000);
      if (this.status !== 'pending') return;
      try {
        const resp = await this.apiGet(EP_GET_QR_STATUS, { qrcode }, 10_000);
        const st = (resp.status as string) || 'wait';
        if (st === 'scaned') {
          this.qrState = { ...this.qrState!, status: 'scanned' };
          console.log('[IM:wechat] QR码已扫码');
        } else if (st === 'confirmed') {
          const token = resp.bot_token as string;
          const baseUrl = (resp.baseurl as string) || this.config.base_url || ILINK_BASE_URL;
          const accountId = (resp.ilink_bot_id as string) || '';
          const userId = (resp.ilink_user_id as string) || '';
          if (!token || !accountId) { this.report('error', '扫码已确认但未取到 token/account'); return; }
          this.token = { token, base_url: baseUrl, account_id: accountId, scanner_user_id: userId, saved_at: new Date().toISOString() };
          this.config.token = token; this.config.base_url = baseUrl;
          this.persistToken(token, baseUrl, accountId, userId);
          this.qrState = { ...this.qrState!, status: 'authenticated' };
          this.running = true;
          // zx_20260912 M1: 落库+发事件统一由状态上报器完成（不再就地写库）——单一真源
          this.report('running', '扫码登录成功');
          this.startLongPoll();
          console.log(`[IM:wechat] QR登录成功 account=${accountId}`);
          return;
        } else if (st === 'expired') {
          this.qrState = { ...this.qrState!, status: 'expired' };
          // 扫码过期＝本次登录未成，如实上报（此前只改内存 qrState、界面停在"等待扫码"）
          this.report('error', '二维码已过期，未登录');
          console.log('[IM:wechat] QR码已过期');
          return;
        }
      } catch { await this.sleep(3000); }
    }
  }

  private startLongPoll(): void {
    this.pollLoop().catch(err => console.error('[IM:wechat] 长轮询异常:', (err as Error).message));
  }

  /** 记录长轮询心跳到 wa_settings（key=im_wechat_heartbeat），供排查发送中断时定位根因。
   *  status: ok=正常 / ret_error=getupdates 返回非0(疑似token失效或服务端错误) / error=网络或HTTP异常
   *  维护 last_ok_at / last_error_at / consecutive_failures，便于定位"中断起点 + 失败类型"。
   *  zx_20260912 M1: 返回本次心跳（含 consecutive_failures），供 pollLoop 判定是否降级。 */
  private recordHeartbeat(status: 'ok' | 'error' | 'ret_error', detail: string, extra?: Record<string, unknown>): Record<string, unknown> {
    let hb: Record<string, unknown> = {};
    try {
      let old: Record<string, unknown> = {};
      try {
        const row = this.db.prepare("SELECT value FROM wa_settings WHERE key = 'im_wechat_heartbeat'").get() as { value: string } | undefined;
        if (row) old = JSON.parse(row.value);
      } catch {}
      const now = new Date().toISOString();
      hb = {
        last_ok_at: status === 'ok' ? now : (old.last_ok_at || null),
        last_error_at: status !== 'ok' ? now : (old.last_error_at || null),
        last_error_status: status !== 'ok' ? status : (old.last_error_status || null),
        last_error_detail: status !== 'ok' ? detail : (old.last_error_detail || null),
        consecutive_failures: status === 'ok' ? 0 : ((old.consecutive_failures as number) || 0) + 1,
        ...(extra || {}),
      };
      this.db.prepare(
        "INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES ('im_wechat_heartbeat', ?, datetime('now'))"
      ).run(JSON.stringify(hb));
    } catch {}
    return hb;
  }

  /** 长轮询健康 → 状态跃迁（不改循环语义：只加上报）。
   *  连续失败达阈值 ⇒ degraded（detail=最后错误）；恢复正常 ⇒ 回到 running。 */
  private reportPollHealth(failures: number, detail: string): void {
    if (failures >= DEGRADED_AFTER_FAILURES) {
      if (this.status !== 'degraded') this.report('degraded', `长轮询连续失败 ${failures} 次：${detail}`);
    } else if (this.status === 'degraded') {
      this.report('running', '长轮询已恢复正常');
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const resp = await this.apiPost(EP_GET_UPDATES, { get_updates_buf: this.syncBuf }, 35_000);
        // 会话级失败（顶层 `errcode`）优先于业务级 `ret` 判定：会话失效时响应里根本没有 `ret`，
        // 旧码只看 `ret` ⇒ 落进 `else` 分支记成 `ok` ⇒ 死绑定被当健康、界面永久"运行中"还在空转轮询。
        const errcode = resp.errcode as number | undefined;
        if (errcode !== undefined && errcode !== 0) {
          if (errcode === ILINK_ERR_SESSION_TIMEOUT) {
            this.handleSessionExpired(`iLink 会话超时（errcode=${errcode}${resp.errmsg ? ` ${String(resp.errmsg)}` : ''}）`);
            return;
          }
          const hb = this.recordHeartbeat('ret_error', `getupdates errcode=${errcode}`, { errcode });
          this.reportPollHealth((hb.consecutive_failures as number) || 0, `getupdates errcode=${errcode}`);
          await this.sleep(this.pollBackoffMs);
          this.pollBackoffMs = Math.min(this.pollBackoffMs * 2, 60_000);
          continue;
        }
        const ret = resp.ret as number | undefined;
        if (ret !== undefined && ret !== 0) {
          // 原实现不检查 ret，token 失效时静默收不到消息；这里记录 ret_error 心跳便于定位
          const hb = this.recordHeartbeat('ret_error', `getupdates ret=${ret}`, { ret });
          this.reportPollHealth((hb.consecutive_failures as number) || 0, `getupdates ret=${ret}`);
        } else {
          this.pollBackoffMs = 1_000;
          const hb = this.recordHeartbeat('ok', '长轮询正常', { msgs: (resp.msgs as unknown[] | undefined)?.length || 0 });
          this.reportPollHealth((hb.consecutive_failures as number) || 0, '');
        }
        const newBuf = resp.get_updates_buf as string | undefined;
        if (newBuf) this.syncBuf = newBuf;
        const msgs = (resp.msgs as unknown[]) || [];
        // 逐条 await（M5 起 handleMessage 含**取件下载**）：批内顺序与平台顺序一致；
        // 单条出错**只丢该条**，不把整批拖进下面的退避分支（一次下载失败 ≠ 长轮询坏了）。
        for (const msg of msgs) {
          try { await this.handleMessage(msg as Record<string, unknown>); }
          catch (e) { console.error('[IM:wechat] 单条消息处理异常:', (e as Error).message); }
        }
      } catch (err) {
        const hb = this.recordHeartbeat('error', (err as Error).message, { backoff_ms: this.pollBackoffMs });
        this.reportPollHealth((hb.consecutive_failures as number) || 0, (err as Error).message);
        console.error(`[IM:wechat] 长轮询错误 (退避${this.pollBackoffMs}ms):`, (err as Error).message);
        await this.sleep(this.pollBackoffMs);
        this.pollBackoffMs = Math.min(this.pollBackoffMs * 2, 60_000);
      }
    }
  }

  // zx_20260920_1 M5: 改 async 只为「取件下载」这一步（其余全程同步），调用方按批内顺序逐条 await。
  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const fromUserId = String(msg.from_user_id || '').trim();
    if (!fromUserId) return;
    const accountId = this.token?.account_id || '';
    if (fromUserId === accountId) return;

    // 更新context token
    const ctxToken = String(msg.context_token || '').trim();
    if (ctxToken) this.contextTokens.set(fromUserId, ctxToken);
    // 第十一轮 Phase 5: 用户发消息刷新主动推送配额窗口（从收到用户消息后开始统计）
    const quota = this.pushQuota.get(fromUserId) || { used: 0, limit: WechatAdapter.QUOTA_LIMIT_DEFAULT, lastUserMsgAt: 0, warned: false };
    quota.used = 0;
    quota.lastUserMsgAt = Date.now();
    quota.warned = false; // 用户发消息=窗口刷新，允许下次低配额再提醒一次
    this.pushQuota.set(fromUserId, quota);
    // M2-2: 入站即复活该用户此前被配额挡下的 outbox 行(窗口已刷新，可再试一次)。
    try { reviveQuotaBlockedOutbox(this.db, fromUserId); } catch { /* 复活失败不影响入站处理 */ }

    const itemList = (msg.item_list as unknown[]) || [];
    const { text, kind, media } = this.extractText(itemList);
    if (!text) return;

    const roomId = String(msg.room_id || '').trim();
    const chatId = roomId || fromUserId;

    console.log(`[IM:wechat] 收到消息 from=${fromUserId.slice(0,8)} text="${text.slice(0, 50)}"`);

    // zx_20260920_1 M5: **取件 + 落盘**（下载是传输层的事，故在适配器做；回话归路由器，此处不回）。
    //   结果只有两种：`savedPath`（真落盘）或 `mediaError`（真因）——**不许静默**：两者都由路由器如实回出去。
    const saved = media ? await this.persistInboundMedia(media) : {};
    const { bytes: savedBytes, ...savedMeta } = saved;
    const meta: ImMessageMeta = {
      ...(kind ? { kind } : {}),
      ...(media?.mediaUrl ? { mediaUrl: media.mediaUrl } : {}),
      ...(media?.fileName ? { fileName: media.fileName } : {}),
      // 大小以**盘上真件的字节数**为准（落盘那次是实测）；没落盘就退回平台自报的 `len`
      //   ——两者在这条链上本应相等（平台报的是明文长度），不相等时以实测为准，别让"平台说多大"与"我存了多大"各说各话。
      ...(savedBytes !== undefined ? { sizeBytes: savedBytes }
        : media?.sizeBytes !== undefined ? { sizeBytes: media.sizeBytes } : {}),
      ...savedMeta,
    };

    // 交给消息路由器处理（意图分类、任务创建/启动、回复等）
    if (this.onMessageHandler) {
      // sendReply 失败会抛异常，这里用 catch 兜底，避免单个消息的回复失败中断长轮询
      Promise.resolve(this.onMessageHandler(fromUserId, text, roomId ? 'group' : 'direct', ctxToken, Object.keys(meta).length ? meta : undefined))
        .catch(err => console.error('[IM:wechat] 消息处理异常:', (err as Error).message));
    } else {
      // 兜底：无路由器时的简单回复
      this.sendReply(chatId, `工蚁已收到：${text.slice(0, 50)}`, ctxToken).catch(err => {
        console.error('[IM:wechat] 兜底回复失败:', (err as Error).message);
      });
    }
  }

  /** 发送回复消息（由 IM Router 调用）。失败时抛异常，供 F3 感知发送失败并重试。 */
  async sendReply(toUser: string, text: string, contextToken?: string, opts?: ImSendOpts): Promise<void> {
    if (!this.token) {
      // M2-2: 登录态缺失同属"发送条件缺失"(非消息问题)，类型化以便 outbox 不烧尝试次数。
      // zx_20260929 M8-e: 构造归一处（`conditionMissing`）——五家说的是同一句话，此前只有微信持有这把尺。
      throw conditionMissing('wechat', '登录态缺失（无 token）');
    }
    // M2-2: 主动推送(无 contextToken)配额已耗尽 → 不再发出去换个空回声，直接如实抛类型化错误：
    // 该用户下一次入站会重置窗口(handleMessage)，届时 outbox 复活再试。
    if (!contextToken) {
      const q = this.pushQuota.get(toUser);
      if (q && q.limit - q.used <= 0) {
        throw conditionMissing('wechat', `主动推送配额已耗尽 used=${q.used}/limit=${q.limit}，待该用户入站刷新`);
      }
    }
    // 第十一轮 Phase 5: 主动推送（无 contextToken）且剩余配额≤阈值时，追加刷新配额提示。
    // 2026-09-04 修复: 原实现低配额下每一条主动推送都追加 → 突发多推送时每条重复同一句(用户收到3-4条相同提示)。
    // 改为"同一配额窗口内仅提醒一次"(warned)，直到用户发消息刷新(inbound 已重置 warned)才可再次提醒。
    let finalText = text;
    if (!contextToken) {
      const quota = this.pushQuota.get(toUser);
      if (quota && !quota.warned && quota.limit - quota.used <= WechatAdapter.QUOTA_WARN_THRESHOLD) {
        finalText = `${text}\n\n⚠️ 主动推送配额即将用完，请回复工蚁任意一条消息刷新配额，以免错过后续推送`;
        quota.warned = true;
      }
    }
    // zx20260930 M2-d: 发落归**一处真源**（`fitOutboundText`）。本家**没有**登记上限
    //   ⇒ 超阈值时**一字不动**，只在末尾如实附一句"未截断"（静默原样发送是病：用户以为拿全了，
    //     而"这条发得出去吗"其实无人作保）。落在 `finalText` 上（配额提示之后）——
    //     下面发送与落账都用同一串，账即实物。
    finalText = fitOutboundText('wechat-personal', finalText).text;

    const msg = {
      from_user_id: this.token.account_id,
      to_user_id: toUser,
      client_id: `wa-${Date.now()}`,
      message_type: 2,
      message_state: 2,
      // 出站文本转 U+2028（DB/outbox 仍存原文，便于阅读与重发）；重发同样经本函数，幂等。
      item_list: [{ type: 1, text_item: { text: toImText(finalText) } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    };

    const resp = await this.apiPost(EP_SEND_MESSAGE, { msg });
    const ret = resp.ret as number | undefined;
    if (ret !== undefined && ret !== 0) {
      const errMsg = String(resp.err_msg || '');
      // M2-2: 接口侧明示的配额/频率限制同归"发送条件缺失"，等待入站刷新后重试(而非烧完尝试次数转 dead)。
      // zx_20260929 M8-e: 认不认得出配额信号，改由**共享判尺** `looksLikeQuotaHint` 说了算
      //   （本处此前内联一份正则，是五家里唯一一份——另外四家各抛各的普通 Error，同一件事五种形状）。
      if (looksLikeQuotaHint(errMsg)) {
        throw conditionMissing('wechat', `发送被配额/频率限制 ret=${ret} msg=${errMsg}`);
      }
      // 远端拒签、网络以外的接口错误：**这条消息这次真没发出去** ⇒ 与另四家同一个形状
      //   （此前是裸 `Error`，靠 outbox 的 `defaultSend` 兜底包一层；人机回话那条路不经过它，故本处显式定型）。
      throw new ImSendError(`[IM:wechat] 发送回复失败 ret=${ret} msg=${errMsg}`);
    }
    console.log(`[IM:wechat] 已回复 to=${toUser.slice(0, 8)} len=${finalText.length}`);

    // 第十一轮 Phase 5: 主动推送后更新配额计数（解析 iLink 配额字段，无则本地统计兜底）
    if (!contextToken) {
      const quota = this.pushQuota.get(toUser) || { used: 0, limit: WechatAdapter.QUOTA_LIMIT_DEFAULT, lastUserMsgAt: Date.now(), warned: false };
      const remain = this._parseQuotaRemain(resp);
      if (typeof remain === 'number') {
        quota.limit = quota.used + 1 + remain;
      } else {
        quota.used += 1;
      }
      this.pushQuota.set(toUser, quota);
    }

    // 补发路径传 recordConversation:false —— 原行已在首次失败时落库，由 flipConversationSent 翻正，不另插新行。
    if (shouldRecordConversation(opts)) {
      try {
        recordOutboundConversation(this.db, {
          channelId: this.channelId, channelType: 'wechat-personal', externalUserId: toUser,
          messageJson: { text: finalText },
          taskId: opts?.taskId,
        });
      } catch {}
    }
  }

  /** 解析 iLink sendMessage 响应中的配额余量字段（候选字段名，联调确认）。无则返回 null。 */
  private _parseQuotaRemain(resp: Record<string, unknown>): number | null {
    const candidates = ['remain', 'remain_count', 'quota_remain', 'quota_left', 'left', 'msg_quota', 'push_remain', 'available'];
    for (const key of candidates) {
      const v = resp[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    const data = resp.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object') {
      for (const key of candidates) {
        const v = (data as Record<string, unknown>)[key];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
    }
    return null;
  }

  /** 取入站正文 + 非文本类型附注（zx_20260914 M1-2）+ **取件信息**（zx_20260920_1 M5）。
   *  type 1=文本；3=语音（有 ASR 文本则按文本走——语音转文字是"真的话"）；
   *  **其余类型不再静默丢弃**：转成占位符如实到场。语音无 ASR 文本也不再丢（本身就是一条消息）。
   *  类型名不猜：iLink 的数值类型此处只见 1/3，其余原样带出（详见 nonTextPlaceholder）。
   *  M5 起附带 `media`（**去哪儿取件** + 平台给的真件名/大小）：此前只有 kind，下游永远拿不到字节。 */
  private extractText(items: unknown[]): { text: string; kind?: string; media?: InboundMedia } {
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const typed = item as Record<string, unknown>;
      if (typed.type === 1) return { text: String((typed.text_item as Record<string, unknown>)?.text || '') };
      if (typed.type === 3) {
        const voiceText = String((typed.voice_item as Record<string, unknown>)?.text || '');
        if (voiceText) return { text: voiceText };
      }
    }
    // 件名/大小由此处**一并带出**（此前占位符只写 `[图片]`，平台给了名也不写）
    const media = mediaFromIlinkItems(items);
    if (media) {
      return { text: nonTextPlaceholder(media.kind, media.fileName, media.sizeBytes), kind: media.kind, media };
    }
    const first = items.find((x) => typeof x === 'object' && x !== null) as Record<string, unknown> | undefined;
    if (first && typeof first.type !== 'undefined') {
      const kind = String(first.type);
      return { text: nonTextPlaceholder(kind), kind };
    }
    return { text: '' };
  }

  /**
   * 取件 + 落盘（M5）。**只如实返回结果，不在此回话**——用户可见串的唯一出口是 im-router。
   *
   * zx_20260924 M3：实现**收归 `im-media.persistInboundMedia`**（原先这两个私有方法只服务微信一家，
   *   其余四家要吃同一条链就只能各抄一份）。本处只剩**本平台特有的一件事**：请求头。
   *   平台没给取件地址（`mediaUrl` 缺席）⇒ `persistInboundMedia` 返回 `{}`，不尝试、不报错。
   *   （本平台的 CDN 件是 AES 密文 ⇒ 解密也收归那条链了，此处不另开一份。）
   */
  private async persistInboundMedia(media: InboundMedia): Promise<PersistMediaResult> {
    const saved = await persistInboundMedia(this.dataDir, media, {
      headers: media.mediaUrl ? this.mediaHeaders(media.mediaUrl) : {},
    });
    if (saved.savedPath) console.log(`[IM:wechat] 入站媒体已落盘 ${path.basename(saved.savedPath)}`);
    return saved;
  }

  /** 取件请求头：**只对平台自己的域名**带 bot 凭证——平台给的可能是第三方 CDN 预签名地址，
   *  把 token 发给它是把凭证交出去（预签名 URL 本就不需要额外凭证）。 */
  private mediaHeaders(url: string): Record<string, string> {
    try {
      if (new URL(url).host === new URL(this.baseUrl()).host) return this.authHeaders();
    } catch { /* 非法 URL：按第三方处理（不带凭证） */ }
    return {};
  }

  /** iLink 鉴权头（**一处真源**：api 调用与取件共用同一份，避免两处各抄一遍后走样）。 */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers.AuthorizationType = 'ilink_bot_token';
      headers.Authorization = `Bearer ${this.token.token}`;
      headers['iLink-App-Id'] = 'ilink_bot';
      headers['iLink-App-ClientVersion'] = '2.2.0';
    } else {
      headers.AuthorizationType = 'ilink_bot_token';
    }
    return headers;
  }

  // ===== iLink API =====
  private baseUrl(): string { return this.config.base_url || this.token?.base_url || ILINK_BASE_URL; }

  private async apiGet(endpoint: string, params: Record<string, string>, timeout = 15_000): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams(params).toString();
    return this.doFetch(`${this.baseUrl()}/${endpoint}?${qs}`, 'GET', undefined, timeout);
  }
  private async apiPost(endpoint: string, payload: Record<string, unknown>, timeout = 15_000): Promise<Record<string, unknown>> {
    return this.doFetch(`${this.baseUrl()}/${endpoint}`, 'POST', { ...payload, base_info: { channel_version: '2.2.0' } }, timeout);
  }
  private async doFetch(url: string, method: string, body: unknown, timeout: number): Promise<Record<string, unknown>> {
    const headers = this.authHeaders();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      if (!resp.ok) throw new Error(`iLink HTTP ${resp.status}`);
      return resp.json() as Promise<Record<string, unknown>>;
    } finally { clearTimeout(timer); }
  }

  // ===== Token 持久化 =====
  private getTokenDir(): string {
    const dir = path.join(this.dataDir, '.wechat-personal');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  private persistToken(token: string, baseUrl: string, accountId: string, scannerUserId = ''): void {
    const data: TokenData = { token, base_url: baseUrl, account_id: accountId, scanner_user_id: scannerUserId, saved_at: new Date().toISOString() };
    try { fs.writeFileSync(path.join(this.getTokenDir(), `${accountId}.json`), JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 }); } catch {}
  }
  private loadToken(): TokenData | null {
    try {
      const dir = this.getTokenDir();
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      if (files.length > 0) return JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf-8')) as TokenData;
    } catch {}
    return null;
  }

  /** 会话失效 ⇒ 令牌已是**死绑定**：归档它（移入 `<dir>/_expired/`，可逆、不删），
   *  使下次 `start()` 读不到令牌而转入二维码登录——否则重启仍会读同一死令牌、again 谎报"运行中"。
   *  `_expired` 不以 `.json` 结尾，故 `loadToken` 的 `endsWith('.json')` 过滤器天然跳过它。 */
  private archiveDeadToken(accountId: string): void {
    if (!accountId) return;
    try {
      const dir = this.getTokenDir();
      const src = path.join(dir, `${accountId}.json`);
      if (!fs.existsSync(src)) return;
      const dest = path.join(dir, '_expired');
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(src, path.join(dest, `${accountId}.${Date.now()}.json`));
    } catch (e) {
      console.warn(`[IM:wechat] 归档失效令牌失败 account=${accountId}: ${(e as Error).message}`);
    }
  }

  /** iLink 会话失效的**唯一收口**：停轮询、清内存登录态、归档死令牌、如实上报 `error`（"异常 + 重新启动"）。
   *  此前 `errcode` 被无视 ⇒ 死会话被当健康、界面永久"运行中"（2026-10-10 实机照出）。 */
  private handleSessionExpired(detail: string): void {
    const accountId = this.token?.account_id || '';
    this.running = false;
    this.syncBuf = '';
    this.token = null;
    this.archiveDeadToken(accountId);
    this.report('error', `${detail}——登录态已失效，请重新扫码登录`);
    console.error(`[IM:wechat] 登录态失效 account=${accountId}：${detail}（已归档令牌并停止长轮询）`);
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
