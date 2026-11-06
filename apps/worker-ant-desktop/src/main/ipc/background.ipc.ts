/**
 * zx_20261029_3 M3：后台进程面板的 IPC（`background:list` / `background:stop` / `background:stopOrphan`）。
 *
 * 纪律（对应 plans/improve/zx_20261029_3.md §3 M3 与 §7 风险表）：
 *   - 停止只认**登记表里的 id**；孤儿链只认**当轮重扫命中**的 pid+pgid——先复核再动手；
 *   - 面板读取时顺带对账（`probeLeftovers`）与清理已终结旧行（保留期 7 天，**不碰未结束行**）；
 *   - 孤儿识别**只报不杀**：本模块的 list 绝不触发任何杀动作。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  listBackgroundJobs,
  probeLeftovers,
  pruneBackgroundJobs,
  scanOrphanServiceChains,
  stopBackgroundJob,
  stopOrphanServiceChain,
  trackedPgidsOf,
} from '../core/background-jobs.js';
import { findRepoRoot } from '../core/ans-supervisor.js';

export function initBackgroundIpc(db: Database.Database): void {
  ipcMain.handle('background:list', async (_event, opts?: { limit?: number; projectId?: string; taskId?: string }) => {
    try { probeLeftovers(db); } catch { /* 对账失败不阻断面板 */ }
    try { pruneBackgroundJobs(db); } catch { /* 清理失败不阻断面板 */ }
    const items = listBackgroundJobs(db, opts);
    // 仓库根只用于**孤儿服务链**识别；打包版（上溯不到）如实空列表，不猜路径。
    let orphans: ReturnType<typeof scanOrphanServiceChains> = [];
    try {
      const repoRoot = findRepoRoot(process.cwd());
      if (repoRoot) orphans = scanOrphanServiceChains({ repoRoot, trackedPgids: trackedPgidsOf(db) });
    } catch { /* ps 不可用 ⇒ 不列，不假装扫描过 */ }
    return { data: { items, orphans } };
  });

  ipcMain.handle('background:stop', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { data: { ok: false, status: 'exited', message: '参数不合法：需要登记表内的 id' } };
    return { data: await stopBackgroundJob(db, id) };
  });

  ipcMain.handle('background:stopOrphan', async (_event, target: unknown) => {
    const t = target as { pid?: unknown; pgid?: unknown } | null;
    const pid = Number(t?.pid);
    const pgid = Number(t?.pgid);
    if (!Number.isFinite(pid) || !Number.isFinite(pgid) || pid <= 0 || pgid <= 0) {
      return { data: { ok: false, status: 'exited', message: '参数不合法：需要 pid 与 pgid' } };
    }
    const repoRoot = findRepoRoot(process.cwd());
    if (!repoRoot) return { data: { ok: false, status: 'unsupported', message: '无法定位本仓根目录，未执行任何杀动作' } };
    return { data: await stopOrphanServiceChain(db, { pid, pgid }, { repoRoot }) };
  });
}
