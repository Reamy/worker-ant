/**
 * ANS 端口/托管 IPC（zx_20261005 M21 / K-11）——渲染层的三个读出与一个动作。
 *
 * 为什么渲染层不直接引 `@worker-ant/shared-types`：renderer 的构建入口 `run.sh` **不先构建**
 *   shared-types 的 `dist`，直接引会跛（且 renderer 无该 workspace 依赖）。故真源值经此 IPC 过桥，
 *   与 `license.ipc.ts` 的 `app:version` 同形——**渲染层只显示、不落库**（缺省值不写进 `wa_settings`）。
 *
 * `ans:start` 是**用户显式动作**（设置页按钮）：探测不可达才拉起本地 ANS；只杀本进程拉起的那个。
 */
import { ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { ANS_DEFAULT_BASE_URL } from '@worker-ant/shared-types';
import { resolveAnsCreds, ansCredentialsConfigured, ansRuntimeIsDev } from '../core/ans-signed-request.js';
import { ensureAnsStarted, stopManagedAnsAndWait, ansSupervisorState, findRepoRoot } from '../core/ans-supervisor.js';

// 本模块被 tsup **并进** `dist/main/index.js` 单一入口 ⇒ 此处 `import.meta.url` 与 `main/index.ts`
//   的 `__dirname` 同值（`.../dist/main`），故 `findRepoRoot` 派生结果一致。
const here = path.dirname(fileURLToPath(import.meta.url));

export function initAnsIpc(db: Database.Database): void {
  /** ANS 地址**缺省真源**（渲染层 fallback / placeholder / 示例用；不含用户配置值）。 */
  ipcMain.handle('ans:defaults', async () => {
    try {
      return { data: { baseUrl: ANS_DEFAULT_BASE_URL } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /**
   * 当前生效的 ANS 地址 + 托管状态（渲染层据此显示"已连接/未启动/由本机托管"）。
   *
   * zx_20261005 M16：附带 `configured`（apiKey/secretKey 是否齐备）与 `isDev`——**三态判据**：
   *   未配置(生产首启) ⇒ 渲染层如实报"未配置"并引导，而不是把缺身份当"服务没起"。
   *   此前渲染层无从分辨这两件事，只能一律显示缺省地址，用户于是拿 dev-key 去撞 401。
   */
  ipcMain.handle('ans:status', async () => {
    try {
      const creds = resolveAnsCreds(db);
      return { data: { baseUrl: creds.baseUrl, configured: ansCredentialsConfigured(creds), isDev: ansRuntimeIsDev(), ...ansSupervisorState() } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /**
   * 显式拉起（用户点按）。返回如实结果：`started`＝本次是否真的新拉起；`reachable`＝当前可否达。
   *
   * zx_20261006 M3：**必须**带上 `isDev`/`repoRoot`——`resolveAnsLaunchCommand` 首行即
   *   `if (!opts.isDev) return null`，原实现两参数都没传 ⇒ 用户手点「一键拉起」**恒**回 `no-entry`。
   */
  ipcMain.handle('ans:start', async () => {
    try {
      const creds = resolveAnsCreds(db);
      return { data: await ensureAnsStarted(creds, { isDev: ansRuntimeIsDev(), repoRoot: findRepoRoot(here) ?? undefined }) };
    } catch (err) {
      return { error: { code: 'ANS_START_FAILED', message: (err as Error).message } };
    }
  });

  /** 停止**本进程拉起的** ANS（用户配置的既有服务不动）。 */
  ipcMain.handle('ans:stop', async () => {
    try {
      return { data: { stopped: await stopManagedAnsAndWait() } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  console.log('[IPC] ANS handlers registered');
}
