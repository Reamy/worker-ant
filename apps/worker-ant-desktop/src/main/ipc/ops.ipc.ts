/**
 * zx_20261120_1 M9「运·一页」：运维概览 IPC（**只读**）。
 *
 * 只做壳：取 ANS 地址 → 调 `buildOpsOverview`。不做任何写操作、不杀进程、不删文件。
 */
import { ipcMain } from 'electron';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { buildOpsOverview } from '../core/ops-overview.js';
import { resolveAnsCreds } from '../core/ans-signed-request.js';

export function initOpsIpc(db: Database.Database, opts: { dataDir: string; dbPath?: string }): void {
  ipcMain.handle('ops:overview', async () => {
    // ⚠ 必须回 `{ data }` / `{ error }` 信封：渲染层 `ipcCall` 只认这一形，裸返回会被解成
    //   `undefined`，「运维」页八块因此恒显示「加载中」（2026-11-22 修）。
    try {
      let baseUrl = '';
      try { baseUrl = String(resolveAnsCreds(db).baseUrl || ''); } catch { baseUrl = ''; }
      const data = await buildOpsOverview({
        db,
        dataDir: opts.dataDir,
        dbPath: opts.dbPath ?? path.join(opts.dataDir, 'worker-ant-server.db'),
        ansBaseUrl: baseUrl,
      });
      return { data };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });
  console.log('[IPC] Ops handlers registered');
}
