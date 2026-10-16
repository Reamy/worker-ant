/**
 * 许可 IPC（zx_20261005 M8）——渲染层「设置 → 许可」的读写口。
 *
 * 两个 handler 都**薄**：真正的判定/落库在 `core/license.ts`（零依赖，rr 直跑同一份）——
 * 本文件只做 IPC 壳与错误码整形。**不在此复刻任何校验**（承「判据的自我印证」纪律：
 * 若此处再判一次，rr 验的是壳、生产走的是壳，两处迟早各说各话）。
 *
 * ⚠ 激活必须走 `license:activate`（验签通过才落库）；**不要**用通用 `settings:set` 直接写
 *   `license.key`——那样能塞进一把坏 key，绕过校验（M6-27 的正面反证即防此）。
 */
import { app, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { resolveLicenseState, activateLicense } from '../core/license.js';
import { pricingRows, EARLY_BIRD, PURCHASE_URL, type PricingPayload } from '../core/pricing.js';

export function initLicenseIpc(db: Database.Database): void {
  /** 当前许可状态（档位 / 试用剩余 / 本机指纹 / 到期 / 如实说明）——M8 界面直接上屏。 */
  ipcMain.handle('license:status', async () => {
    try {
      return { data: resolveLicenseState(db) };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /** 激活：`activateLicense` 验签通过才落库；失败如实回错误码，界面据此显示原因。 */
  ipcMain.handle('license:activate', async (_event, licenseText: string) => {
    try {
      const res = activateLicense(db, String(licenseText ?? ''));
      if (!res.ok) return { error: { code: 'LICENSE_INVALID', message: res.detail } };
      return { data: res.state };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /**
   * 定价与权益（zx_20261005 M11）——真源在 `core/pricing.ts`（与 `feature-limits.ts` 同一把尺）。
   * 渲染层经此取值，**不**自带价格字面量（否则改一次价要改 N 处、还必漏一处）。
   */
  ipcMain.handle('license:pricing', async () => {
    try {
      const payload: PricingPayload = { tiers: pricingRows(), earlyBird: EARLY_BIRD, purchaseUrl: PURCHASE_URL };
      return { data: payload };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /** 应用版本（`系统信息` 一处真源 = `app.getVersion()`，不再手写会腐的字面量）。 */
  ipcMain.handle('app:version', async () => {
    try {
      return { data: app.getVersion() };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  console.log('[IPC] License handlers registered');
}
