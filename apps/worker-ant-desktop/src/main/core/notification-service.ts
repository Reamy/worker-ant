/**
 * 原生系统通知接线 + 通知中心持久化（A2/A3，2026-09-03）。
 *
 * A2 原生通知触发面克制（道德经「不如守中」）：
 * - 任务完成：仅当窗口失焦/最小化（用户不在观看）时弹；
 * - 任务失败 / 等待用户输入：任何「非正在观看该任务」状态都弹；
 * - 开关：wa_settings.ui_system_notifications（'1'/'0'），Settings 页即时生效。
 *
 * A3 通知中心：
 * - 关键事态落 `wa_notifications`（wa_event_log 为唯一真相源，本表为其用户侧物化视图 + 已读状态）；
 * - 写入/已读后刷新未读数并同步 Dock/任务栏角标。
 *
 * zx_20260915 M4/P0-6：本文件**退化为装配壳**——「落行 · 已读 · 去重 · 订阅装配」整体移入
 * `notification-core.ts`（零 electron），此处只留**碰 electron 的两件事**（原生横幅、Dock 角标）
 * 与之的接线，并 re-export 既有公开符号 ⇒ 三个既有 import 点
 * （`index.ts` 的 `setupTaskNativeNotifications`、`ipc-handlers.ts` 的 `setTaskFocus`、
 * `ipc/notifications.ipc.ts` 的 `ensureNotificationsTable`/`refreshUnreadBadge`）**零改动**。
 *
 * 为何要切这一刀：判据必须直跑真实现。此前整份文件都被 electron 绑住，受控回归只能复刻一份实现
 * 来自我印证——那正是本仓反复判为假绿的那种断言（同 `task-notice.ts` / `pause-settlement.ts`）。
 */
import { Notification, BrowserWindow, app } from 'electron';
import type Database from 'better-sqlite3';
import type { EventBus } from './event-bus.js';
import {
  setNotifBadge,
  setNotifPopup,
  subscribeTaskNotifications,
  type NotifPopupRequest,
} from './notification-core.js';

export {
  ensureNotificationsTable,
  refreshUnreadBadge,
  countUnread,
  recordNotification,
  markTaskRead,
  setTaskFocus,
  getTaskFocus,
  getNotificationWriteFailures,
  subscribeTaskNotifications,
  setNotifPopup,
  setNotifBadge,
  EXECUTING_STATUSES,
  PAUSE_DEVIATION_KEY,
} from './notification-core.js';

const ENABLED_KEY = 'ui_system_notifications';

/** zx_20261002 M1: `showSystemNotification` 用的库引用——由 `setupTaskNativeNotifications` 注入。 */
let _notifDb: Database.Database | null = null;

/**
 * B1 (2026-09-03_2): 免打扰时段——`notify_quiet_start`/`notify_quiet_end`（HH:MM，可跨午夜）。
 * 时段内完成类不弹原生、仅记录；关键事态（失败/需输入）仍弹。
 */
export function isQuietTime(db: Database.Database): boolean {
  try {
    const start = (db.prepare('SELECT value FROM wa_settings WHERE key=?').get('notify_quiet_start') as { value: string } | undefined)?.value?.trim() || '';
    const end = (db.prepare('SELECT value FROM wa_settings WHERE key=?').get('notify_quiet_end') as { value: string } | undefined)?.value?.trim() || '';
    if (!start || !end) return false;
    const toMin = (hh: string): number | null => { const m = /^(\d{1,2}):(\d{2})$/.exec(hh); if (!m) return null; return Number(m[1]) * 60 + Number(m[2]); };
    const a = toMin(start); const b = toMin(end);
    if (a == null || b == null) return false;
    const now = new Date();
    const n = now.getHours() * 60 + now.getMinutes();
    return a <= b ? n >= a && n < b : n >= a || n < b;
  } catch {
    return false;
  }
}

function isEnabled(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(ENABLED_KEY) as { value: string } | undefined;
    return row?.value !== '0';
  } catch {
    return true;
  }
}

function getWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

// D2 (2026-09-04_2): 声音按事件类静音映射（读库即时，勿扰时段外仍可控制声音打扰强度）
const SOUND_MUTE_KEY: Record<string, string> = {
  'task.completed': 'sound_completed',
  'task.failed': 'sound_failed',
  'task.awaiting_input': 'sound_await',
};
function sval(db: Database.Database, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value;
  } catch { return undefined; }
}
function isSoundMuted(db: Database.Database, type: string): boolean {
  try {
    if (sval(db, 'notify_sound_enabled') === '0') return true;
    const muteKey = SOUND_MUTE_KEY[type];
    if (muteKey && sval(db, muteKey) === '0') return true;
    return false;
  } catch { return false; }
}

/** 应用角标：macOS Dock 数字徽标 / Linux Unity；Windows 无则跳过 */
function applyBadge(count: number): void {
  try {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(count > 0 ? String(count) : '');
    } else {
      app.setBadgeCount(count);
    }
  } catch {
    /* 平台不支持时静默 */
  }
}

/**
 * 原生横幅（**该不该弹**的判据全在此，核只管"有没有被去重"）：
 * 开关 / 勿扰 / 未聚焦 / 免打扰时段 / 分事件类静音。
 */
function popup(db: Database.Database, opts: NotifPopupRequest): void {
  if (!isEnabled(db)) return;
  if (!Notification.isSupported()) return;
  // zx_20260906 批4 (4c): 全局免打扰总开关——开启后一律不弹原生（仍记录通知中心/铃点/徽标/需处理列表，降为一路中心记录）
  if (sval(db, 'ui_dnd') === '1') return;
  const win = getWindow();
  if (!win) return;
  const focused = win.isFocused() && !win.isMinimized();

  // zx_20260906 批4 (4c): 通知跨通道归一——聚焦时主呈现=应用内 toast(ToastProvider)与页面实时态，
  // 原生横幅仅窗口失焦/最小化时弹，避免失败时"OS横幅+toast+声音+铃点+dock徽标+ActionNeeded"六路齐发。
  if (focused) return;
  // B1 (2026-09-03_2): 免打扰时段内完成类（onlyWhenAway）不弹原生、仅记录
  if (opts.onlyWhenAway && isQuietTime(db)) return;
  // zx_20260909 Y3(知行合一·不标而不用): notify_quiet_mute_critical 此前仅 renderer toast 消费(静音"失败/需输入"应用内 toast),
  // main 原生弹窗缺位致"toast 已静音而原生横幅仍弹"不一致——补齐: 免打扰时段内该键=1 → critical(失败/需输入等非 onlyWhenAway) 原生亦静音(仅记录通知中心)
  if (isQuietTime(db) && sval(db, 'notify_quiet_mute_critical') === '1') return;

  // D2 (2026-09-04_2): 声音开关即时生效（全局/分事件类静音 → silent）
  const n = new Notification({ title: opts.title, body: opts.body, silent: isSoundMuted(db, opts.type) });
  n.on('click', () => {
    const w = getWindow();
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      if (opts.taskId) {
        w.webContents.send('notif:focus-task', { type: opts.type, taskId: opts.taskId });
      }
    }
  });
  n.show();
}

/**
 * zx_20261002 M1: 供 renderer **主动请求**的原生通知出口（`notifications:show`）。
 *
 * 此前 `notifications:show`（`ipc-handlers.ts`）直接 `new Notification` 裸发——不读任何开关。
 * 该通道原本零调用方，一旦接线（IM 跨页提醒正是首个调用方）就会**绕过**用户已关的系统通知与全局免打扰。
 * 这里把"该不该弹"收回到与 `popup()` **同一把尺**：开关 / 全局免打扰 / 免打扰时段静音关键。
 *
 * 与 `popup()` 的**唯一差别**：不做"窗口聚焦即静默"——调用方（renderer）已按
 * 「在 IM 页且可见则不打扰」判过，走到这里就是"该提醒"；此处只守开关与勿扰。
 */
export function showSystemNotification(title: string, body: string, type = 'im.message_inbound'): void {
  const db = _notifDb;
  if (!db) return; // 装配未完成（启动早期）⇒ 静默不弹，不抛
  if (!isEnabled(db)) return;
  if (!Notification.isSupported()) return;
  if (sval(db, 'ui_dnd') === '1') return;
  if (isQuietTime(db) && sval(db, 'notify_quiet_mute_critical') === '1') return;
  const n = new Notification({ title, body, silent: isSoundMuted(db, type) });
  n.on('click', () => {
    const w = getWindow();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    // 复用既有 `notif:focus-task` 通道（`App.tsx` 已处理 type='im.navigate'）——不新开 preload 面
    w.webContents.send('notif:focus-task', { type: 'im.navigate' });
  });
  n.show();
}

export function setupTaskNativeNotifications(opts: { db: Database.Database; eventBus: EventBus }): void {
  const { db, eventBus } = opts;
  _notifDb = db;
  // 两个施加器先注入再订阅：否则首个事件在被去重前到达时无处投递（角标/横幅都要闭包住 db）
  setNotifBadge(applyBadge);
  setNotifPopup((req) => popup(db, req));
  subscribeTaskNotifications({ db, eventBus });
}
