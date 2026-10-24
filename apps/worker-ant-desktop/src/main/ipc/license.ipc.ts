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
import { resolveLicenseState, resolveLicenseTier, activateLicense, licenseDeviceCap, type LicenseState } from '../core/license.js';
import { recordAudit, type AuditDb } from '../core/audit-log.js';
import { seatUsage, type SeatUsage } from '../core/seat-quota.js';
import { pricingRows, EARLY_BIRD, PURCHASE_URL, type PricingPayload } from '../core/pricing.js';
import { tierCatalog, type TierCatalogPayload } from '../core/tier-catalog.js';
import { tierUsage, type TierUsagePayload } from '../core/tier-usage.js';
import { ensureNodeIdentity, type NodeSettingDb } from '../core/node-identity.js';
import { isCloudEntitlementActive, readCloudEntitlementCache } from '../core/cloud-entitlement.js';
import { pullCloudEntitlement } from '../core/entitlement-client.js';
import { ansCredentialsConfigured, resolveAnsCreds } from '../core/ans-signed-request.js';
import type { EntitlementSource, EntitlementTier } from '@worker-ant/shared-types';
import { TIER_LABEL } from '../core/feature-limits.js';

/**
 * zx_20261017_1 批五: `license:status` 的返回形状 = 许可本体 ⊕ 席位用量。
 *   席位**不塞进** `LicenseState`（那是"许可说了什么"，席位是"这台机上坐了几个人"）；
 *   `used` 由 `seatUsage → countSeats` 一处计算，界面不重算。
 */
export interface LicenseStatusPayload extends LicenseState {
  seats: SeatUsage;
  /** 本档一份许可最多绑几台（`licenseDeviceCap` 一处派生；界面不写死 3/20，换档即变）。 */
  deviceCap: number;
}

/**
 * zx_20261023_5 批五：**云端权益**在界面上的如实形态。
 *   · 从未同步过 ⇒ `fetchedAt/tier/source` 全 null（界面说"尚未同步"，不伪造一档）；
 *   · 同步过但不可达 ⇒ 旧权益保留 + `lastError` 上屏（界面说"不可达（原因）"）；
 *   · `active` 是**读侧再判一次**的结果（缓存会 stale，过期即不再抬高档位）。
 */
export interface CloudEntitlementPayload {
  /** 是否配了 ANS 凭据（未配 ⇒ 没去过，不是"去了没回"）。 */
  configured: boolean;
  fetchedAt: string | null;
  tier: EntitlementTier | null;
  /** 档位人话名（`TIER_LABEL` 一处派生）——渲染层不手抄档位词表。 */
  tierLabel: string | null;
  source: EntitlementSource | null;
  /** 来源人话名（未签发 / 已过期 / 云端下发）——同由 main 给，渲染层不自译。 */
  sourceLabel: string | null;
  expiresAt: string | null;
  active: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  /** 合并云端后**实际生效**的档位（界面"当前档位"那一行读的是 `license:status.tier`，二者同源）。 */
  effectiveTier: string;
}

/** 权益来源的人话名（词表**一处**；渲染层不自译，免得两侧漂开）。 */
const CLOUD_SOURCE_LABEL: Record<EntitlementSource, string> = {
  cloud: '云端下发',
  none: '未签发',
  expired: '已过期',
};

function cloudPayload(db: Database.Database): CloudEntitlementPayload {
  const cache = readCloudEntitlementCache(db);
  const e = cache?.entitlement ?? null;
  return {
    configured: ansCredentialsConfigured(resolveAnsCreds(db)),
    fetchedAt: cache?.fetchedAt ?? null,
    tier: e?.tier ?? null,
    tierLabel: e ? TIER_LABEL[e.tier] : null,
    source: e?.source ?? null,
    sourceLabel: e ? CLOUD_SOURCE_LABEL[e.source] : null,
    expiresAt: e?.expires_at ?? null,
    active: e ? isCloudEntitlementActive(e) : false,
    lastError: cache?.lastError ?? null,
    lastErrorAt: cache?.lastErrorAt ?? null,
    effectiveTier: resolveLicenseTier(db),
  };
}

export function initLicenseIpc(db: Database.Database): void {
  /** 当前许可状态（档位 / 试用剩余 / 本机指纹 / 到期 / 如实说明）+ 席位用量——M8 界面直接上屏。 */
  ipcMain.handle('license:status', async () => {
    try {
      const state = resolveLicenseState(db);
      const payload: LicenseStatusPayload = { ...state, seats: seatUsage(db, resolveLicenseTier(db)), deviceCap: licenseDeviceCap(state.tier) };
      return { data: payload };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /** 激活：`activateLicense` 验签通过才落库；失败如实回错误码，界面据此显示原因。 */
  ipcMain.handle('license:activate', async (_event, licenseText: string) => {
    try {
      const res = activateLicense(db, String(licenseText ?? ''));
      if (!res.ok) return { error: { code: 'LICENSE_INVALID', message: res.detail } };
      // zx_20261017_1 批二: 激活留痕（**只记档位/类型/到期**，绝不把许可原文写进审计账）。
      recordAudit(db as unknown as AuditDb, {
        actorKind: 'local',
        action: 'license.activate',
        targetType: 'license',
        targetId: res.state.tier,
        detail: { tier: res.state.tier, kind: res.state.kind, expiresAt: res.state.expiresAt },
      });
      // 激活后档位可能变了（席位上限随之变）⇒ 与 `license:status` 同一组合返回，界面不必再拉一次。
      const payload: LicenseStatusPayload = { ...res.state, seats: seatUsage(db, resolveLicenseTier(db)), deviceCap: licenseDeviceCap(res.state.tier) };
      return { data: payload };
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

  /**
   * 档位能力对照（zx_20261018_2 批五）——真源在 `core/tier-catalog.ts`：
   *   `included` 由 `pro-gate` / `team-gate` 的同一对纯函数派生，`capability` 由 `TIER_LIMITS` 派生。
   * 渲染层经此摆对照面板，**不**自带能力词表或档位判断（"第二落点"必漂）。
   */
  ipcMain.handle('license:catalog', async () => {
    try {
      const payload: TierCatalogPayload = tierCatalog();
      return { data: payload };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /**
   * 档位用量（zx_20261022_3 批九）——真源在 `core/tier-usage.ts`：
   *   项目/席位/并发复用既有计数，节点取 `fetchNodes` 台账（读不到如实 `unavailable`，不写 0 在线）。
   *   渲染层经此摆用量条，**不**自行数库/猜上限。
   */
  ipcMain.handle('license:usage', async () => {
    try {
      const localNodeId = ensureNodeIdentity(db as unknown as NodeSettingDb).id;
      const payload: TierUsagePayload = await tierUsage(db, { localNodeId });
      return { data: payload };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /**
   * zx_20261023_5 批五：云端权益**读**（只读缓存，不发请求）。
   * 设置页据此显示「已同步档位/到期/拉取时刻」或「不可达（原因）」，不自己解析 JSON。
   */
  ipcMain.handle('license:cloud', async () => {
    try {
      return { data: cloudPayload(db) };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /**
   * 手动重拉一次云端权益（用户点「重试」）——5 秒有界，失败 fail-open。
   * 返回与 `license:cloud` 同形 + `reason`（本次如实原因；成功为 null）。
   */
  ipcMain.handle('license:cloud_refresh', async () => {
    try {
      const res = await pullCloudEntitlement(db);
      return { data: { ...cloudPayload(db), reason: res.reason } };
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
