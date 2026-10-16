import { ipcMain, shell, dialog } from 'electron';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WechatAdapter } from '../services/wechat-adapter.js';
import { DingtalkAdapter } from '../services/dingtalk-adapter.js';
import { QqbotAdapter } from '../services/qqbot-adapter.js';
import { FeishuAdapter } from '../services/feishu-adapter.js';
import { WecomAdapter } from '../services/wecom-adapter.js';
import type { ImAdapter, ImSendOpts } from '../services/im-adapter.js';
import { routeImMessage, setNotificationDir, startF3NotificationPush, stopF3NotificationPush } from '../services/im-router.js';
import { eventBus } from '../core/event-bus.js';
import { channelCapabilities, MEDIA_UNSUPPORTED_TEXT } from '../core/im/channel-capabilities.js';
import { listOutbox, outboxStats, outboxStatusCounts, retryOutboxEntry, enqueueImOutbox } from '../core/im/im-outbox.js';
import { emitOutboundMessage } from '../core/im/outbound-event.js';
import { markImRead, computeImUnread, computeImUnreadByChannel } from '../core/im/im-unread.js';
import { accountOutboundFailure } from '../core/im/reply-accounting.js';
// zx_20260929 M8-c: 「发送条件缺失」的判尺（类型判定，跨动态 import 边界安全）——失败分两态时唯一依据。
import { isImQuotaError } from '../core/im/im-errors.js';
import { imChannelEnabledSql } from '../core/im/im-channel-status.js';
import { attachTaskTitles, listConversations } from '../core/im/im-conversations-query.js';
import { sendManualImMessage, sendManualImMedia, type ManualSendArgs, type ManualMediaArgs } from '../core/im/manual-send.js';
import { resolveAudioPreview, resolveVideoPreview } from '../core/im/im-media-view.js';
import { resolveImagePreview } from '../core/image-preview.js';
import { resolveAttachmentRead } from '../services/im-media.js';
// zx_20260930 M5: 只作类型用（取实例走 `_getMemoryForIm` 惰性取用，本模块不持有它、也不构造它）。
import type { MemoryManager } from '../core/memory-manager.js';

// 活跃的 IM 适配器实例
const activeAdapters = new Map<string, ImAdapter>();

/** 接线运行期状态上报：适配器报告跃迁 → 落库 wa_im_channels.status + 发瞬态事件 channel.status_changed。
 *  唯一接线点=createAdapter 工厂 ⇒ 启动恢复与 im:startChannel 两条路径自动同时生效。 */
function wireStatusReporter(db: Database.Database, adapter: ImAdapter, channelId: string): void {
  if (!adapter.setStatusReporter) return;
  adapter.setStatusReporter((report) => {
    try {
      db.prepare('UPDATE wa_im_channels SET status = ? WHERE id = ?').run(report.status, channelId);
      const ch = db.prepare('SELECT name, channel_type FROM wa_im_channels WHERE id = ?').get(channelId) as { name: string; channel_type: string } | undefined;
      void eventBus.emitTransient('channel.status_changed', {
        channelId,
        channelType: ch?.channel_type || '',
        name: ch?.name || '',
        status: report.status,
        detail: report.detail || '',
      });
    } catch (err) {
      console.warn(`[IM] 状态上报落库失败 channel=${channelId.slice(0, 8)}: ${(err as Error).message}`);
    }
  });
}

/** 根据渠道类型创建适配器 */
function createAdapter(db: Database.Database, channelId: string, channelType: string, config: Record<string, string>, dataDir: string): ImAdapter {
  let adapter: ImAdapter;
  switch (channelType) {
    // zx_20260924 M3: 五家**一律**收 `dataDir`——入站媒体落盘（`im-media.persistInboundMedia`）
    //   要往 `<dataDir>/attachments/<UTC 日期>/` 写，此前只有微信一家拿得到它，其余四家
    //   结构上就不可能落盘（不是"忘了调"，是**没拿到根**）。
    case 'dingtalk': adapter = new DingtalkAdapter(db, channelId, config, dataDir); break;
    case 'qqbot': adapter = new QqbotAdapter(db, channelId, config, dataDir); break;
    case 'feishu': adapter = new FeishuAdapter(db, channelId, config, dataDir); break;
    case 'wecom': adapter = new WecomAdapter(db, channelId, config, dataDir); break;
    case 'wechat-personal': adapter = new WechatAdapter(db, channelId, config, dataDir); break;
    default: throw new Error(`不支持的渠道类型: ${channelType}`);
  }
  wireStatusReporter(db, adapter, channelId);
  return adapter;
}

let _dbForIm: Database.Database | null = null;
let _dataDirForIm = '';
/** zx_20260930 M5: `MemoryManager` 的惰性取用（本模块初始化时它还没构造，见 `main/index.ts`）。 */
let _getMemoryForIm: (() => MemoryManager | undefined) | undefined;

/** 获取在用渠道列表（供F3推送用）。
 *  口径＝「启用中」= 适配器状态非 `inactive`（见 core/im/im-channel-status.ts）：
 *  `degraded`/`pending`/`error` 也纳入——它们不是「不发」，而是「发、失败则照常落 outbox 记因」，
 *  排除它们才是静默丢弃（反噬 M3）。M1 曾只补 `degraded`（半拉子），M6 按同口径补齐。 */
function getEnabledChannels(): Array<{ id: string; channelType: string; sendReply: (toUser: string, text: string) => Promise<void>; lastExternalUser?: string }> {
  const channels: Array<{ id: string; channelType: string; sendReply: (toUser: string, text: string) => Promise<void>; lastExternalUser?: string }> = [];
  for (const [id, adapter] of activeAdapters) {
    if (adapter.getStatus() !== 'inactive') {
      const ch = _dbForIm?.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(id) as { channel_type: string } | undefined;
      channels.push({
        id,
        channelType: ch?.channel_type || 'wechat-personal',
        sendReply: async (toUser, text) => { await adapter.sendReply(toUser, text); },
      });
    }
  }
  return channels;
}

export function initImIpc(db: Database.Database, dataDir: string, getMemory?: () => MemoryManager | undefined): void {
  _dbForIm = db;
  _dataDirForIm = dataDir;
  // zx_20260930 M5: 惰性取用（同 `initProjectIpc` 的既有形——本函数早于 `MemoryManager` 构造被调用）。
  _getMemoryForIm = getMemory;

  // 初始化通知目录 + 启动F3推送
  const notifyDir = path.join(dataDir, 'notification_payloads');
  setNotificationDir(notifyDir);
  startF3NotificationPush(db, getEnabledChannels);

  // L1: 启动时恢复之前已启用的 IM 渠道
  console.log('[IM] 启动恢复：检查待恢复的IM渠道...');
  // 先查全部看DB是否正确
  const allChannels = db.prepare("SELECT id, name, channel_type, status FROM wa_im_channels").all() as Array<Record<string, unknown>>;
  console.log(`[IM] 全部渠道(${allChannels.length}):`, allChannels.map(c => `${c.name}(${c.status})`).join(', '));
  // 再查待恢复（所有支持的渠道类型）。M6：口径＝「启用中」（非用户停用）——
  // 旧谓词只认 active/running/pending，会把 M1 起才落库的 degraded/error 渠道漏掉：
  // 它们在 degraded/error 状态下退出 ⇒ 重启不再拉起 ⇒ IM 网关静默缺失（F3 推送无渠道）。
  const enabledChannels = db.prepare(
    `SELECT * FROM wa_im_channels WHERE channel_type IN ('wechat-personal','dingtalk','qqbot','feishu','wecom') AND ${imChannelEnabledSql()}`
  ).all() as Array<Record<string, unknown>>;
  console.log(`[IM] 待恢复渠道数: ${enabledChannels.length}`);
  for (const ch of enabledChannels) {
    try {
      const cfg = typeof ch.config === 'string' ? JSON.parse(ch.config as string) : (ch.config || {});
      const channelType = ch.channel_type as string;
      const adapter = createAdapter(db, ch.id as string, channelType, cfg, dataDir);
      adapter.onMessage((fromUser, text, chatType, contextToken, meta) => {
        routeImMessage({
          db, channelId: ch.id as string, channelType,
          getMemory: _getMemoryForIm,
          sendReply: async (toUser, replyText) => {
            // 同 startChannel：人机回话失败不阻断路由（适配器已"失败即抛"）+ **落账**（zx_20260920 M2）。
            try {
              await adapter.sendReply(toUser, replyText, contextToken);
            } catch (err) {
              console.warn(`[IM] 回话未送达 channel=${channelType} to=${toUser.slice(0, 8)}: ${(err as Error).message}`);
              // zx_20260929 M8-c: 失败**分两种境遇**——条件缺失（配额/登录态，等恢复即达）与真失败。
              //   判据取适配器**抛出的类型**（`isImQuotaError`，见 im-errors.ts），不猜文案。
              accountOutboundFailure(db, { channelId: ch.id as string, externalUserId: toUser, text: replyText, error: (err as Error).message, quota: isImQuotaError(err) });
            }
          },
        }, fromUser, text, chatType, contextToken, meta);
      });
      activeAdapters.set(ch.id as string, adapter);
      (async () => {
        console.log(`[IM] 开始恢复渠道: ${ch.name || ch.channel_type} id=${(ch.id as string).slice(0,8)}`);
        await adapter.start();
        db.prepare("UPDATE wa_im_channels SET status = ? WHERE id = ?").run(adapter.getStatus(), ch.id);
        console.log(`[IM] 恢复渠道完成: ${ch.name || ch.channel_type} status=${adapter.getStatus()}`);
      })().catch((e) => console.error(`[IM] 恢复渠道异常: ${ch.name || 'unknown'}`, (e as Error).message));
    } catch (e) {
      console.error(`[IM] 恢复渠道失败: ${ch.name || 'unknown'}`, (e as Error).message);
    }
  }
  console.log(`[IM] 已恢复 ${enabledChannels.length} 个渠道`);

  ipcMain.handle('im:channels', async () => {
    try {
      const data = db.prepare('SELECT * FROM wa_im_channels ORDER BY created_at DESC').all();
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('im:createChannel', async (_event, { channel_type, name, config }: {
    channel_type: string; name?: string; config?: Record<string, string>
  }) => {
    try {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, config, status) VALUES (?, ?, ?, ?, ?)').run(
        id, channel_type, name || channel_type, JSON.stringify(config || {}), 'inactive'
      );
      const data = db.prepare('SELECT * FROM wa_im_channels WHERE id = ?').get(id);
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('im:updateChannel', async (_event, { id, body }: {
    id: string; body: { name?: string; config?: Record<string, string> }
  }) => {
    try {
      if (body.name) db.prepare('UPDATE wa_im_channels SET name = ? WHERE id = ?').run(body.name, id);
      if (body.config) db.prepare('UPDATE wa_im_channels SET config = ? WHERE id = ?').run(JSON.stringify(body.config), id);
      const data = db.prepare('SELECT * FROM wa_im_channels WHERE id = ?').get(id);
      return { data: data || null };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('im:startChannel', async (_event, { id }: { id: string }) => {
    try {
      const ch = db.prepare('SELECT * FROM wa_im_channels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!ch) return { error: { code: 'NOT_FOUND', message: '渠道不存在' } };

      // 停止旧的适配器（如果存在）
      const old = activeAdapters.get(id);
      if (old) { await old.stop(); activeAdapters.delete(id); }

      // 根据类型启动适配器（支持全部渠道类型）
      const channelType = ch.channel_type as string;
      const supported = ['wechat-personal', 'dingtalk', 'qqbot', 'feishu', 'wecom'];
      if (!supported.includes(channelType)) {
        console.log(`[IM] 渠道类型 ${channelType} 暂无适配器，仅标记状态`);
        db.prepare("UPDATE wa_im_channels SET status = 'active' WHERE id = ?").run(id);
        void eventBus.emit('channel.started', { channelId: id, channelType, name: ch.name, status: 'active' }).catch(() => {});
        return { data: { id, status: 'active' } };
      }

      const cfg = typeof ch.config === 'string' ? JSON.parse(ch.config as string) : (ch.config || {});
      const adapter = createAdapter(db, id, channelType, cfg, _dataDirForIm);
      adapter.onMessage((fromUser, text, chatType, contextToken, meta) => {
        routeImMessage({
          db, channelId: id, channelType,
          getMemory: _getMemoryForIm,
          sendReply: async (toUser, replyText) => {
            // zx_20260911_2 M2: 适配器 sendReply 现已"失败即抛"（通知路径靠它落 outbox）。
            // 人机回话路径契约相反——尽力而为、失败不阻断路由，故在此单点兜住并告警。
            // zx_20260920 M2: 兜住之外还要**落账**——`accountOutboundFailure` 是机器回话失败的唯一记账点
            //   （落 1 行 failed + 真因，**不入 outbox**：D4 人机回话不自动补发）。
            //   这也是 `ImContext.sendReply` **永不 reject** 的地方 ⇒ im-router 的调用点不需要各自 .catch。
            try {
              await adapter.sendReply(toUser, replyText, contextToken);
            } catch (err) {
              console.warn(`[IM] 回话未送达 channel=${channelType} to=${toUser.slice(0, 8)}: ${(err as Error).message}`);
              // zx_20260929 M8-c: 同启动恢复路——失败分「条件缺失」与「真失败」两态，判据取抛出类型。
              accountOutboundFailure(db, { channelId: id, externalUserId: toUser, text: replyText, error: (err as Error).message, quota: isImQuotaError(err) });
            }
          },
        }, fromUser, text, chatType, contextToken, meta);
      });
      activeAdapters.set(id, adapter);
      await adapter.start();
      db.prepare("UPDATE wa_im_channels SET status = ? WHERE id = ?").run(adapter.getStatus(), id);
      // A2 (2026-09-04_2): channel.* 真实 emit —— Dashboard 已启用渠道数事件驱动新鲜
      void eventBus.emit('channel.started', { channelId: id, channelType, name: ch.name, status: adapter.getStatus() }).catch(() => {});
      return { data: { id, status: adapter.getStatus() } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('im:stopChannel', async (_event, { id }: { id: string }) => {
    try {
      const ch = db.prepare('SELECT name, channel_type FROM wa_im_channels WHERE id = ?').get(id) as { name?: string; channel_type?: string } | undefined;
      const adapter = activeAdapters.get(id);
      if (adapter) { await adapter.stop(); activeAdapters.delete(id); }
      db.prepare("UPDATE wa_im_channels SET status = 'inactive' WHERE id = ?").run(id);
      // A2 (2026-09-04_2): 渠道停止真实 emit
      void eventBus.emit('channel.stopped', { channelId: id, channelType: ch?.channel_type, name: ch?.name, status: 'inactive' }).catch(() => {});
      return { data: { id, status: 'inactive' } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20260911_5 M2-3(上手状态): 补 offset——此前一次 LIMIT 50 到顶、更早记录不可达。
  // zx_20260912 M2-4(维特根斯坦·同一把尺): 分页改 **rowid 游标**——created_at 是秒级(datetime('now')),
  //   实时入站与翻页同在秒内发生时, `ORDER BY created_at DESC` 并列不稳 + OFFSET 随插入整体位移 ⇒ 重/漏。
  //   rowid 单调且与插入序一致(created_at 恒由 datetime('now') 写入) ⇒ 以「已加载最旧行的 rowid」为界,
  //   排序与游标同一把尺, 既稳定又不受新插入影响。`offset` 仍接受(兼容旧调用), 但渲染侧走 beforeSeq。
  // zx_20260913 M1-5(庄子·得鱼忘筌 / 海德格尔·上手状态): 补**搜索**与**方向筛选**——此前只能翻页,
  //   7004 条对话里找一条等于没有。过滤条件与服务端**同一 WHERE**(参数化绑定, 不拼字符串)——
  //   游标/offset 与过滤条件组合后仍"不重不漏"(同一把尺: 排序、游标、过滤同源)。
  ipcMain.handle('im:conversations', async (_event, { channelId, offset, beforeSeq, q, direction }: { channelId: string; offset?: number; beforeSeq?: number; q?: string; direction?: string }) => {
    try {
      // zx_20260930 M2-c: 取回本页后**补任务名**（`task_id` → 「属于任务X」的标牌）。
      //   补在已取回的行上、不改分页 SQL——理由见 `attachTaskTitles` 的注释（分页形状被前序 rr 钉死）。
      const data = attachTaskTitles(db, listConversations(db, { channelId, offset, beforeSeq, q, direction }));
      return { data };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20260914 M1-3(维特根斯坦·同一把尺 / 海德格尔·在场): **只读**未读——导航红点取初值用。
  //   与 `im:markRead` 同源同形（都出自 `computeImUnread`，故两值恒等），但**绝不写库**：
  //   刻意不调 `refreshImUnread`——那是"报到显示端"的口（托盘），"看一眼"不该产生任何副作用。
  ipcMain.handle('im:unread', async () => {
    try {
      if (!_dbForIm) return { data: { unread: 0 } };
      return { data: { unread: computeImUnread(_dbForIm) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20261003 M12(维特根斯坦·意义即使用): **逐渠道**未读——与 `im:unread` 同为**只读**（取初值红点用），
  //   未读账仍 main 一处算（`computeImUnreadByChannel`），显示端只取数、**不自算**（承 zx_20260914 M1-3）。
  ipcMain.handle('im:unreadByChannel', async () => {
    try {
      if (!_dbForIm) return { data: { byChannel: {} } };
      return { data: { byChannel: computeImUnreadByChannel(_dbForIm) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20260912 M2-3(海德格尔·在场): 「确实在看 IM」= 标记已读——未读账唯一真源写在此处。
  // zx_20261002 M2: 收 `channelId` —— 只清**该渠道**（打开某渠道的对话 / 正看着它时收到新入站）。
  //   不传 = 全部已读。此前无参即全局，导致"打开任意一个渠道"等于"所有渠道都读过"（方案 §1.1-5）。
  ipcMain.handle('im:markRead', async (_event, channelId?: string) => {
    try {
      if (!_dbForIm) return { data: { unread: 0 } };
      return { data: { unread: markImRead(_dbForIm, typeof channelId === 'string' && channelId ? channelId : undefined) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('im:deleteChannel', async (_event, { id }: { id: string }) => {
    try {
      const ch = db.prepare('SELECT name, channel_type FROM wa_im_channels WHERE id = ?').get(id) as { name?: string; channel_type?: string } | undefined;
      const adapter = activeAdapters.get(id);
      if (adapter) { await adapter.stop(); activeAdapters.delete(id); }
      db.prepare('DELETE FROM wa_im_conversations WHERE channel_id = ?').run(id);
      db.prepare('DELETE FROM wa_im_channels WHERE id = ?').run(id);
      // A2 (2026-09-04_2): 渠道删除同样视为停止（实时一致）
      void eventBus.emit('channel.stopped', { channelId: id, channelType: ch?.channel_type, name: ch?.name, status: 'removed' }).catch(() => {});
      return { data: { id, deleted: true } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('im:getQr', async (_event, id: string) => {
    try {
      const adapter = activeAdapters.get(id);
      if (adapter) {
        const qr = adapter.getQrState?.();
        if (qr) {
          const imgRaw = qr.qrcode_img;
          if (!imgRaw) return { data: { qrcode_img: '', status: qr.status } };
          // iLink 返回的是 liteapp 短链接（如 https://liteapp.weixin.qq.com/q/xxx），
          // 用 qrserver.com 生成二维码图片，微信扫码后跳转 liteapp 完成登录。
          try {
            const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(imgRaw)}`;
            const resp = await fetch(qrApiUrl);
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              return { data: { qrcode_img: `data:image/png;base64,${buf.toString('base64')}`, status: qr.status } };
            }
          } catch (e) {
            return { data: { qrcode_img: '', status: qr.status }, error: { code: 'QR_GEN_FAILED', message: (e as Error).message } };
          }
          return { data: { qrcode_img: '', status: qr.status } };
        }
      }
      // 回退：检查DB并尝试从iLink获取
      const ch = db.prepare('SELECT channel_type, config FROM wa_im_channels WHERE id = ?').get(id) as { channel_type: string; config: string } | undefined;
      if (!ch) return { error: { code: 'NOT_FOUND', message: '渠道不存在' } };
      if (ch.channel_type === 'wechat-personal') {
        try {
          const cfg = JSON.parse(ch.config || '{}');
          const resp = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: cfg.token, base_url: cfg.base_url, base_info: { channel_version: '2.2.0' } }),
          });
          const data = await resp.json() as { qrcode_img?: string; qrcode?: string };
          return { data: { qrcode_img: data.qrcode_img || data.qrcode, status: 'pending' } };
        } catch { return { data: { qrcode_img: null, status: 'error' } }; }
      }
      return { data: { qrcode_img: null, status: 'unsupported' } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('im:diagnose', async (_event, id: string) => {
    try {
      const ch = db.prepare('SELECT * FROM wa_im_channels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!ch) return { error: { code: 'NOT_FOUND' } };
      const adapter = activeAdapters.get(id);
      const caps = channelCapabilities(ch.channel_type as string);
      // 运行健康：直接读 wechat 长轮询心跳（此前该键只写不读）。非微信渠道无心跳 ⇒ 如实说明"无此信号"。
      let health: { pass: boolean; detail: string };
      const hbRow = db.prepare("SELECT value FROM wa_settings WHERE key = 'im_wechat_heartbeat'").get() as { value: string } | undefined;
      if (hbRow) {
        const hb = JSON.parse(hbRow.value) as { last_ok_at?: string | null; last_error_at?: string | null; last_error_detail?: string | null; consecutive_failures?: number };
        const fails = hb.consecutive_failures || 0;
        health = fails === 0
          ? { pass: true, detail: `长轮询正常（最近成功 ${hb.last_ok_at || '未知'}）` }
          : { pass: false, detail: `长轮询连续失败 ${fails} 次（最近失败 ${hb.last_error_at || '未知'}：${hb.last_error_detail || '无详情'}）` };
      } else {
        health = { pass: true, detail: '本品类无心跳信号（仅微信个人号记录长轮询心跳）' };
      }
      // 渠道状态：DB 记录 vs 适配器实况——二者不一致即"界面与真实相反"，须显形。
      // zx_20260912 M6/G7：本项**只答一致性**（记录与实况是否相符）；"是否健康"由下方「运行健康」如实作答。
      // 旧谓词 `dbStatus === 'active' || 'running'` 是 M1 前「健康中」的手抄口径——它让 degraded/pending
      // 渠道在"记录与实况一致"（正是本项要确认的事）时反被判 ❌，与 M6 的口径决定自相矛盾。
      const adapterStatus = adapter ? adapter.getStatus() : null;
      const dbStatus = (ch.status as string) || 'unknown';
      const diverged = !!adapterStatus && adapterStatus !== dbStatus;
      const statusDetail = diverged
        ? `记录=${dbStatus}，实况=${adapterStatus}（不一致）`
        : adapterStatus ? `记录=${dbStatus}，实况一致` : `记录=${dbStatus}（适配器未启动，无从比对）`;
      const results: Array<{ check: string; pass: boolean; detail: string }> = [
        { check: '数据库记录', pass: true, detail: `渠道类型: ${ch.channel_type}` },
        { check: '配置完整', pass: !!(ch.config), detail: ch.config ? '已配置' : '未配置' },
        { check: '适配器运行', pass: !!adapter, detail: adapter ? `适配器状态: ${adapterStatus}` : '适配器未启动' },
        { check: '渠道状态', pass: !diverged, detail: statusDetail },
        { check: '运行健康', pass: health.pass, detail: health.detail },
        // zx_20260911_2 M3: 如实登记收发能力(企微入站未实现→pass:false), 避免"界面写支持实则收不到"
        // zx_20260924 M4: 补**发件**一档——能力表新增 media 后必须在这里露出来，否则"如实登记"没人看得见。
        { check: '收发能力', pass: caps.inbound, detail: `入站: ${caps.inbound ? '可用' : '不可用'}；出站: ${caps.outbound ? '可用' : '不可用'}；发件: ${caps.media ? '可用' : '不可用'}。${caps.note}` },
      ];
      return { data: results };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20260911_2 M3(如实): 出站补发账只读统计——pending=待补发, dead=超窗/超次已放弃。
  // zx_20260911_5 M1-2(康德·范畴穷尽): 补 blocked_quota(等条件恢复)与 other 兜底——此前二者完全不计,
  //   且页面横幅仅在 pending/dead>0 时出现 ⇒ 全 blocked_quota 时整条横幅消失。
  // zx_20260930 M4-3(一处真源): 一并回**逐状态原始计数** `byStatus`——与上面五档同出 `outboxStatusCounts`
  //   那一次 `GROUP BY status`。界面按它说每组的"共 M 条"（折叠档说不清"哪几态、各几条"）。
  ipcMain.handle('im:outboxStats', async () => {
    try {
      if (!_dbForIm) return { data: { pending: 0, blocked_quota: 0, dead: 0, sent: 0, other: 0, byStatus: {} } };
      return { data: { ...outboxStats(_dbForIm), byStatus: outboxStatusCounts(_dbForIm) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20260911_5 M1-1(庄子·得鱼忘筌): 补发账**逐条明细**——此前界面只有数字, "是那几条"看不到。
  // 只读、不触发任何发送；带渠道名/任务标题, 供页面把汇总翻回原本的"事"。
  // zx_20260930 M4-3: 透传 `offset`——明细**翻得到底**（配合统计的全量口径，数得到的就取得到）。
  ipcMain.handle('im:outboxList', async (_event, args?: { status?: string; limit?: number; offset?: number }) => {
    try {
      if (!_dbForIm) return { data: [] };
      return { data: listOutbox(_dbForIm, { status: args?.status, limit: args?.limit, offset: args?.offset }) };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20260911_5 M1-4(王阳明·知行合一 / 罗尔斯·同一规则): **单条**手动补发——看得见就要做得了。
  // 复用自动补发同一套语义(严格 send / 配额类不烧次数 / 退避 3 次转 dead)与 `im:resend` 的配额如实口径。
  ipcMain.handle('im:outboxRetry', async (_event, id: string) => {
    try {
      if (!_dbForIm) return { error: { code: 'NO_DB', message: '数据库未就绪' } };
      const r = await retryOutboxEntry(_dbForIm, id);
      if (!r.ok && r.status === 'not_found') return { error: { code: 'NOT_FOUND', message: '补发记录不存在' } };
      const channelId = (_dbForIm.prepare('SELECT channel_id FROM wa_im_outbox WHERE id = ?').get(id) as { channel_id?: string } | undefined)?.channel_id || '';
      const channelType = (_dbForIm.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(channelId) as { channel_type?: string } | undefined)?.channel_type || '';
      const note = r.quota && channelType === 'wechat-personal'
        ? '本次补发无上下文 token，按主动推送计配额；配额耗尽时将无法送达，请让用户回复任意消息刷新。'
        : undefined;
      return { data: { ok: r.ok, status: r.status, attempts: r.attempts, ...(r.quota ? { quota: true } : {}), ...(r.error ? { error: r.error } : {}), ...(note ? { note } : {}) } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  ipcMain.handle('im:resend', async (_event, convId: string) => {
    try {
      const conv = db.prepare('SELECT * FROM wa_im_conversations WHERE id = ?').get(convId) as Record<string, unknown> | undefined;
      if (!conv) return { error: { code: 'NOT_FOUND', message: '对话记录不存在' } };
      const channelId = conv.channel_id as string;
      const externalUserId = conv.external_user_id as string;
      // 解析消息内容
      let text = '';
      try {
        const msgJson = JSON.parse((conv.message_json as string) || '{}');
        text = msgJson.text || msgJson.body || '';
      } catch {}
      if (!text) return { error: { code: 'NO_CONTENT', message: '消息无文本内容' } };

      // 通过适配器重新发送
      const adapter = activeAdapters.get(channelId);
      if (adapter) {
        // zx_20260911_2 M2(金刚经·如实): 重发走主动推送路径(无原文 contextToken)——
        // 成功才落账并如实告知"按主动推送计配额"; 失败如实报错, 不再静默假装已送达。
        const channelType = (db.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(channelId) as { channel_type?: string } | undefined)?.channel_type || '';
        try {
          // zx_20260920 M4: 落账由本 handler 负责(成功/失败两支各落一行) ⇒ 传 `recordConversation:false`,
          //   让适配器**只发不记**。否则适配器插一行、本 handler 再插一行 —— 一次重发在对话里**两个气泡**
          //   (与补发账那条路是同一个病: 一个消息两行; 见 `defaultSend` / `sendManualImMessage`)。
          await adapter.sendReply(externalUserId, text, undefined, { recordConversation: false });
        } catch (err) {
          // zx_20260913 M1-4(罗尔斯·同一把尺): 重发失败也**到场**——此前只回错误、不落行,
          //   正在看该渠道对话的人对"这次重发没送到"一无所知。本条无 outbox 关联(手发非补发账),
          //   界面据此用 `im:resend` 作就地补发入口(outbox 关联行则用 `im:outboxRetry`)。
          // zx_20260929 M8-c: 与 `accountOutboundFailure` **同一张状态表、同一个判据**（抛出类型）——
          //   重发失败也分「条件缺失」（等配额/登录态恢复）与「真失败」两态，否则同一件事两处各说一套。
          const quota = isImQuotaError(err);
          db.prepare(
            "INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, status, last_error, created_at) VALUES (?, ?, ?, ?, 'outbound', ?, ?, datetime('now'))"
          ).run(crypto.randomUUID(), channelId, externalUserId, JSON.stringify({ text, resent: true, original_id: convId, ...(quota ? { quota_blocked: true } : {}) }), quota ? 'blocked_quota' : 'failed', (err as Error).message || String(err));
          emitOutboundMessage({ channelId, channelType, toUser: externalUserId, preview: text, pending: true });
          return { error: { code: 'SEND_FAILED', message: `重发失败：${(err as Error).message}` } };
        }
        // 记录重发
        db.prepare(
          "INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, 'outbound', datetime('now'))"
        ).run(crypto.randomUUID(), channelId, externalUserId, JSON.stringify({ text, resent: true, original_id: convId }));
        // zx_20260912 M2-2(海德格尔·在场): 重发也要到场——此前静默改库, 正在看该渠道对话的人看不到这条。
        // 复用 im.message_outbound（不新增事件名），与适配器初次发送同一条通道。
        emitOutboundMessage({ channelId, channelType, toUser: externalUserId, preview: text });
        const note = channelType === 'wechat-personal'
          ? '本次重发无上下文 token，按主动推送计配额；配额耗尽时将无法送达，请让用户回复任意消息刷新。'
          : undefined;
        return { data: { id: convId, resent: true, ...(note ? { note } : {}) } };
      }
      return { error: { code: 'NO_ADAPTER', message: '渠道适配器未运行' } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // zx_20260914 M1-1(庄子·得鱼忘筌 / 维特根斯坦·意义即使用): **界面手工回话**——此前 GUI 只能看
  //   (`im:conversations` 只读)与**重发别人的话**(`im:resend` 认 convId)，不能**自己说一句**。
  //   "回得了话"的最后一环：看得见对话 ⇒ 也要说得上话。
  //
  //   三处必须与既有路径**同尺**（否则同一件事两套真相）：
  //   ① 成功走 `im:resend` 同一条 INSERT（靠列 DEFAULT 落 sent，不手写 status —— 与"列 DEFAULT 一处真源"同尺）；
  //   ② 失败**必须走 `enqueueImOutbox`**：补发账 + failed 对话行 + pending 事件由它一处记全。
  //      此处**不得**自写 failed 行——「failed 行恰两处写者」是不变量（rr_zx_20260913 钉死），
  //      自写会同时撑破 `statusWriters.length === 2`。
  //   ③ 送达与否如实回话（带真因），不静默假装已送达。
  // 判定与落库全在 `sendManualImMessage`（真源一处）——本 handler 只做接线，
  // 使受控复跑能对**生产函数本体**做断言，而非对着一段复制品。
  ipcMain.handle('im:send', async (_event, { channelId, externalUserId, text }: ManualSendArgs) =>
    sendManualImMessage({ db, adapters: activeAdapters }, { channelId, externalUserId, text }));

  // zx_20260930 M1(维特根斯坦·意义即使用): **界面手工发件**——此前 GUI 只能发文字，
  //   `sendImMedia` 虽已写在册（补发路一直在用它），却**没有任何界面走得到它**。
  //   判定与落库全在 `sendManualImMedia`（真源一处）——本 handler 只做接线，
  //   使受控复跑能对**生产函数本体**做断言（与 `im:send` 同一手法）。
  ipcMain.handle('im:sendMedia', async (_event, { channelId, externalUserId, filePath, name }: ManualMediaArgs) =>
    sendManualImMedia({ db, adapters: activeAdapters }, { channelId, externalUserId, filePath, name }));

  // zx_20260930 M1: **只读**取件——件在盘上，界面得拿到它的字节才谈得上「显形」。
  //
  // 三条硬红线复用 `resolveAttachmentRead`（**不新造一套路径规则**）：须在 `data/attachments/` 根内、
  // 须是绝对路径（拒 URL 方案与相对路径）、须是既有文件。
  // 内联与否的另三条（白名单 / 上限 / 读盘之前先判）**直接复用既有两把尺**——
  // 图片走 `resolveImagePreview`（成果预览那张白名单，与 `im-media-view.renderOf` 同一张），
  // 音频走 `resolveAudioPreview`，视频走 `resolveVideoPreview`（三者读的是同一张族上限表）。
  // 本处**不另写第二份**「MIME 表 + 10MB」。
  //
  // 为什么依次试且 `oversize` 要**当场回报**而不是继续往下试：一个 20MB 的 `.png`
  //   过不了图片的上限，也不在任何音频/视频表里；若把 oversize 当"不支持"往下走，用户读到的会是
  //   「不能预览」而不是真相「这件太大了」。**如实**优先于"少一种错误"。
  //
  // ⚠ 三条硬红线的**具体理由**要送到界面（"越界"与"件不在盘上"是两回事，界面上该各说各的），
  //   故走本文件通行的 `{error:{code}}` 形状：渲染层从 `IpcError.code` 读理由码（大写），
  //   `message` 仍是那句**人读原文**（`resolveAttachmentRead` / 两条预览判据产出的那串），不另编。
  const reject = (reason: string, message: string) => ({ error: { code: reason.toUpperCase(), message } });

  ipcMain.handle('im:mediaRead', async (_event, { filePath }: { filePath: string }) => {
    const gate = resolveAttachmentRead(_dataDirForIm, filePath);
    if (!gate.ok) return reject(gate.reason, gate.error);
    const name = path.basename(gate.path);
    const img = resolveImagePreview(gate.path, name, fs);
    if (img.ok) {
      return { data: { kind: 'image', mime: img.mime, size: img.size, dataUrl: `data:${img.mime};base64,${img.base64}` } };
    }
    if (img.reason === 'oversize') return reject('oversize', `件超过内联上限（${img.size} > ${img.limit} 字节）`);
    const aud = resolveAudioPreview(gate.path, name, fs);
    if (aud.ok) {
      return { data: { kind: 'audio', mime: aud.mime, size: aud.size, dataUrl: `data:${aud.mime};base64,${aud.base64}` } };
    }
    if (aud.reason === 'oversize') return reject('oversize', `件超过内联上限（${aud.size} > ${aud.limit} 字节）`);
    const vid = resolveVideoPreview(gate.path, name, fs);
    if (vid.ok) {
      return { data: { kind: 'video', mime: vid.mime, size: vid.size, dataUrl: `data:${vid.mime};base64,${vid.base64}` } };
    }
    if (vid.reason === 'oversize') return reject('oversize', `件超过内联上限（${vid.size} > ${vid.limit} 字节）`);
    return reject('unsupported', '这种件不能内联预览；可用「打开」或「另存」');
  });

  // zx_20260930 M1: 「打开」「另存」——**只读**出口，同样先过围栏。
  //   ⚠ 越界路径交给 `shell.openPath` 等于把围栏整个拆掉（`openPath` 会照办），故两处**都**判。
  //   「在文件夹中显示」不在此列：preload 已暴露 `showItemInFolder`，无需新增 IPC。
  ipcMain.handle('im:mediaOpen', async (_event, { filePath }: { filePath: string }) => {
    const gate = resolveAttachmentRead(_dataDirForIm, filePath);
    if (!gate.ok) return reject(gate.reason, gate.error);
    const err = await shell.openPath(gate.path);
    // 空串 = 成功（Electron 的契约）。非空串是**系统给的原文**，如实带上，不吞成"打开失败"四个字。
    return err ? reject('open_failed', err) : { data: { ok: true } };
  });

  ipcMain.handle('im:mediaSave', async (_event, { filePath, name }: { filePath: string; name?: string }) => {
    const gate = resolveAttachmentRead(_dataDirForIm, filePath);
    if (!gate.ok) return reject(gate.reason, gate.error);
    const suggested = (typeof name === 'string' && name.trim()) || path.basename(gate.path);
    const picked = await dialog.showSaveDialog({ defaultPath: suggested });
    // 「用户取消」**不是错误**——它是一次正常的取舍结果，故走 `data` 而不是 `error`
    //   （走 error 会让"我点了取消"在界面上显示成一条红字失败）。
    if (picked.canceled || !picked.filePath) return { data: { saved: false, cancelled: true } };
    // 选到自己身上：`copyFileSync` 到同一路径会抛 EINVAL —— 那本来就已经是"另存成功"了。
    if (path.resolve(picked.filePath) === gate.path) return { data: { saved: true, savedTo: gate.path } };
    try {
      fs.copyFileSync(gate.path, picked.filePath);
    } catch (err) {
      return reject('copy_failed', (err as Error).message);
    }
    return { data: { saved: true, savedTo: picked.filePath } };
  });

  console.log('[IPC] IM handlers registered');
}

/** 发送 IM 消息（调用方已拼好完整内容，此处原样发送，不再二次包裹）
 *  zx_20260909_1 M1/M2(A3 空性·无常/毛选·自我批评): 返回是否送达——无适配器/发送抛错均 false，
 *  供上层(pushImNotify)对关键通知失败落 outbox 短窗补发；普通入站回话调用方忽略返回值不受影响。
 *  zx_20260912 M3(管子·度量衡): 由 `boolean` 改 **`{ ok, error? }`**——失败要**带原因**回落。
 *  此前 `catch {}` 把真原因吞掉, 账上只剩"未送达"三个字, 用户无从知道为什么。 */
export async function sendImCompletionNotice(channelId: string, toUser: string, taskId: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const adapter = activeAdapters.get(channelId);
  if (!adapter) return { ok: false, error: '[IM] 渠道适配器未运行' };
  try {
    // zx_20260930 M2-c: 本函数**手里本来就有** `taskId`（是它的形参，此前一直没往下传）——
    //   「知道却不说」与「不知道」在账上长得一样，正是要消的那种。故此处**据实**把它交给适配器，
    //   由出站行记进 `task_id`。⚠ `taskId` 为空串时传 `undefined`（=不知道），不写空归属。
    await adapter.sendReply(toUser || '', message, undefined, taskId ? { taskId } : undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

/**
 * zx_20260911_4 M2-2: **严格**发送入口——无适配器/发送异常一律抛出，不吞。
 * 供 outbox 补发区分「发送条件缺失」(`ImQuotaError`: 配额耗尽/无 token，可等入站复活、不烧次数)
 * 与「真失败」(网络/接口错误，按 1/2/4 min 退避、3 次后 dead)。
 * 布尔版 `sendImCompletionNotice` 保持原契约(通知调用方只关心"到没到")。
 */
export async function sendImMessage(
  channelId: string,
  toUser: string,
  message: string,
  opts?: ImSendOpts,
): Promise<void> {
  const adapter = activeAdapters.get(channelId);
  if (!adapter) throw new Error('[IM] 渠道适配器未运行');
  await adapter.sendReply(toUser || '', message, undefined, opts);
}

/**
 * zx_20260924 M4: **严格**发件入口——与 `sendImMessage` 同契约（无适配器/未实现/发送异常**一律抛出**）。
 *
 * 三条"不假装"：
 *  · 无适配器 ⇒ 抛"渠道适配器未运行"；
 *  · 适配器**没声明** `sendMedia` ⇒ 抛那句共享真源（**绝不静默降级成发个文件名**——
 *    用户会在对话里看到 `report.pdf` 这行字，以为文件到了）；
 *  · 适配器抛什么就上抛什么，供 outbox 区分 `ImQuotaError` 与真失败。
 *
 * zx_20260924_1 M8: 这句话**不再在此手写**——`MEDIA_UNSUPPORTED_TEXT`（`channel-capabilities.ts`）
 * 同时喂着能力表 `note`、补发路的前置拒绝与界面禁用钮的 title，四处同源。
 */
export async function sendImMedia(
  channelId: string,
  toUser: string,
  file: { path: string; kind: 'image' | 'file'; name?: string },
  opts?: ImSendOpts,
): Promise<void> {
  const adapter = activeAdapters.get(channelId);
  if (!adapter) throw new Error('[IM] 渠道适配器未运行');
  if (!adapter.sendMedia) throw new Error(`[IM] ${MEDIA_UNSUPPORTED_TEXT}`);
  await adapter.sendMedia(toUser || '', file, opts);
}

/** 停止所有 IM 适配器 + F3 推送（退出时调用） */
/** 停止所有运行中的适配器（不修改DB状态，保留供下次启动恢复） */
export async function stopAllImAdapters(): Promise<void> {
  stopF3NotificationPush();
  for (const [id, adapter] of activeAdapters) {
    try { await adapter.stop(); } catch {}
  }
  activeAdapters.clear();
  console.log('[IM] 所有 IM 适配器已停止（DB状态保留）');
}
