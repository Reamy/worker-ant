/**
 * 通知中心 IPC（A3 2026-09-03）。
 * 数据源：wa_notifications（wa_event_log 的用户侧物化视图 + 已读状态）。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { ensureNotificationsTable, refreshUnreadBadge } from '../core/notification-service.js';

export function initNotificationsIpc(db: Database.Database): void {
  ensureNotificationsTable(db);

  const unreadCount = (): number => {
    const r = db.prepare('SELECT COUNT(*) AS c FROM wa_notifications WHERE read_at IS NULL').get() as { c: number };
    return r.c;
  };

  ipcMain.handle('notifications:list', async (_event, opts?: { limit?: number; offset?: number; type?: string; projectId?: string }) => {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 300);
    const offset = Math.max(opts?.offset ?? 0, 0);
    // C2 (2026-09-04_2): 支持 type / project 过滤（家族由代码 map 推断，不加列不迁移）
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.type) { where.push('type = ?'); params.push(opts.type); }
    if (opts?.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    const wsql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const items = db.prepare(
      `SELECT id, type, task_id, project_id, title, body, read_at, created_at FROM wa_notifications ${wsql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    // C2 (2026-09-04_2 整改): 返回 total——铃铛"加载更多/分页"依赖（同过滤条件下的总条数）
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM wa_notifications ${wsql}`).get(...params) as { c: number } | undefined;
    return { data: { items, total: totalRow?.c ?? items.length, unread: unreadCount() } };
  });

  ipcMain.handle('notifications:unread', async () => ({ data: { unread: unreadCount() } }));

  ipcMain.handle('notifications:markRead', async (_event, id: string) => {
    db.prepare("UPDATE wa_notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL").run(id);
    const c = unreadCount();
    refreshUnreadBadge(db);
    return { data: { unread: c } };
  });

  ipcMain.handle('notifications:markAllRead', async () => {
    db.prepare("UPDATE wa_notifications SET read_at = datetime('now') WHERE read_at IS NULL").run();
    refreshUnreadBadge(db);
    return { data: { unread: 0 } };
  });

  // C2 (2026-09-04_2): 单任务已读（批量处置同任务反复提醒）
  ipcMain.handle('notifications:markTaskRead', async (_event, taskId: string) => {
    db.prepare("UPDATE wa_notifications SET read_at = datetime('now') WHERE task_id = ? AND read_at IS NULL").run(taskId);
    const c = unreadCount();
    refreshUnreadBadge(db);
    return { data: { unread: c } };
  });

  // C2 (2026-09-04_2): 清空已读（仅删已读历史，未读保留）
  ipcMain.handle('notifications:clearRead', async () => {
    db.prepare("DELETE FROM wa_notifications WHERE read_at IS NOT NULL").run();
    refreshUnreadBadge(db);
    return { data: { unread: unreadCount() } };
  });
}
