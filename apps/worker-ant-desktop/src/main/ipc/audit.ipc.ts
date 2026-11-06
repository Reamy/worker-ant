/**
 * zx_20261017_1 批二（管子·度量衡）: **审计视图**的 IPC 出口——一个只读口。
 *
 * `audit:list` 的次序是判据本身：**先过 Team 软闸，锁定即回 `TEAM_REQUIRED` 且不查库**
 *   （`listAuditEventsGated` 一处实现）。不在此另写一份档位判断（承"判据的自我印证"纪律）。
 *
 * zx_20261018_3 批七（亚里士多德·目的因）: **`audit:export`**——价格表说 Team 含「审计导出（CSV）」，
 *   这个口就是兑现它的那一跳。次序仍是判据：**先过 `audit_export` 闸，再读，再落盘**；
 *   锁定 ⇒ `TEAM_REQUIRED`，`core` 侧直接返回、**不读库、不建目录、不写文件**。
 *
 * ⚠ 读模型合并三本账（新审计账 / 设备控制 / 外部终端调用），形状见 `core/audit-log.ts`。
 * ⚠ 筛选参数只做**取值校验**（limit 夹取在 core 侧），不在壳里复刻业务规则。
 */
import { ipcMain } from 'electron';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  exportAuditCsvGated,
  listAuditEventsGated,
  type AuditDb,
  type AuditExportFilter,
  type AuditFilter,
} from '../core/audit-log.js';
import { isAuditSource } from '../core/audit-labels.js';
import type { LicenseSettingDb } from '../core/license.js';

/** 导出目录：`<dataDir>/exports/`（与附件落盘约定同源；目录由 core 侧按需创建）。 */
function exportFileName(now: Date = new Date()): string {
  // UTC 时刻与库内 `datetime('now')` 同基准；`Z` 之后去掉，文件名只留数字与连字符。
  const iso = now.toISOString(); // 2026-10-19T13:45:12.345Z
  const [d, t] = iso.split('T');
  const stamp = `${(d ?? '').replace(/-/g, '')}-${(t ?? '').replace(/[:.]/g, '').slice(0, 9)}`;
  return `audit-${stamp}.csv`;
}

export function initAuditIpc(db: Database.Database, dataDir: string): void {
  ipcMain.handle('audit:list', (_event, filter?: AuditFilter) => {
    try {
      const f: AuditFilter = {
        ...(typeof filter?.limit === 'number' ? { limit: filter.limit } : {}),
        ...(typeof filter?.offset === 'number' ? { offset: filter.offset } : {}),
        ...(typeof filter?.action === 'string' && filter.action ? { action: filter.action } : {}),
        ...(isAuditSource(filter?.source) ? { source: filter.source } : {}),
      };
      const r = listAuditEventsGated(
        db as unknown as AuditDb,
        db as unknown as LicenseSettingDb,
        f,
      );
      // 锁定 ⇒ 如实回 TEAM_REQUIRED（不返回一张空表假装"没有审计记录"）。
      if (!r.unlocked) return { error: { code: 'TEAM_REQUIRED', message: r.refusal } };
      return { data: { events: r.events } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('audit:export', (_event, filter?: AuditFilter) => {
    try {
      // 导出吃的是**筛选**，不是分页：limit/offset 一律不接（否则"导出"只会导一屏）。
      const f: AuditExportFilter = {
        ...(typeof filter?.action === 'string' && filter.action ? { action: filter.action } : {}),
        ...(isAuditSource(filter?.source) ? { source: filter.source } : {}),
      };
      const fileName = exportFileName();
      const r = exportAuditCsvGated(
        db as unknown as AuditDb,
        db as unknown as LicenseSettingDb,
        join(dataDir, 'exports', fileName),
        f,
      );
      if (!r.unlocked) return { error: { code: 'TEAM_REQUIRED', message: r.refusal } };
      if (!r.saved) return { error: { code: 'EXPORT_FAILED', message: r.error } };
      return { data: { savedTo: r.path, rows: r.rows } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  console.log('[IPC] Audit handlers registered');
}
