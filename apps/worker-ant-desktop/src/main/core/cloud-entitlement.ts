/**
 * zx_20261023_5 批五（管子·度量衡 / 维特根斯坦·一个规则一处）：**云端权益的纯逻辑**（零网络/零 electron）。
 *
 * 与 `entitlement-client.ts` **刻意分家**：
 *   · 本文件只做"缓存的读/写/收窄/合并"，被 `license.ts` 的 `resolveLicenseState` 直接引——
 *     许可热路径不该为了读一个档位字符就把 ANS SDK 拖进来；
 *   · 网络与失败留痕在 `entitlement-client.ts`（import `ans-signed-request`）。
 *
 * ⚠ **只升不降**：云端权益比本地许可高 ⇒ 采用云端；比本地低/无 ⇒ 本地为准。
 *   （方案原文「以云端为准（仍受本地许可下限约束）」的落地口径。）
 * ⚠ 缓存是 `wa_settings` 的一行 JSON（`license.cloud_entitlement`），**不加密**——里面没有密钥。
 *   本机用户能改它 ⇒ 只影响他自己这台机器的档位；商业防线不靠这行（见 §2.10 诚实边界）。
 */
import { entitlementTierRank, isEntitlementTier, type AnsEntitlement } from '@worker-ant/shared-types';
import { LICENSE_TIERS, type LicenseTier } from './feature-limits.js';

/** 缓存键——**只此一处**（写/读两端同引）。 */
export const CLOUD_ENTITLEMENT_SETTING_KEY = 'license.cloud_entitlement';

/** 有界拉取上限（与 `ans-signed-request` 缺省同值；此处置名以便 rr 与文档引用）。 */
export const CLOUD_ENTITLEMENT_TIMEOUT_MS = 5000;

/** 读设置的最小库接口（`LicenseSettingDb` 同形；不 import 它以免成环）。 */
export interface CloudEntitlementDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

/** 写设置的最小库接口（拉取成功后落缓存）。 */
export interface CloudEntitlementWriteDb extends CloudEntitlementDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
}

/**
 * 缓存形态：最近一次**成功**的权益 + 最近一次**失败**的原因（两者并存，失败不清空成功值）。
 *
 * ⚠ `fetchedAt`/`entitlement` 可空，是**如实**而非偷懒：从未成功拉过时，界面要能说
 *   「云端不可达 · 原因」，而不是把"没同步过"伪造成"已同步但无权益"。
 */
export interface CloudEntitlementCache {
  /** 最近一次成功拉取时刻（ISO）；从未成功过 ⇒ null。 */
  fetchedAt: string | null;
  entitlement: AnsEntitlement | null;
  /** 最近一次失败原因（成功后清空）。 */
  lastError: string | null;
  /** 最近一次失败时刻（ISO）。 */
  lastErrorAt: string | null;
}

/** 把外部 JSON 收窄成 `AnsEntitlement`；不合规回 `null`（不猜）。 */
export function parseCloudEntitlement(raw: unknown): AnsEntitlement | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const tier = o.tier;
  if (!isEntitlementTier(tier)) return null;
  const source = o.source;
  if (source !== 'cloud' && source !== 'none' && source !== 'expired') return null;
  const limits = o.limits && typeof o.limits === 'object' && !Array.isArray(o.limits)
    ? (o.limits as Record<string, unknown>)
    : {};
  const cleanLimits: Record<string, number> = {};
  for (const k of ['maxProjectConcurrency', 'maxProjects', 'maxMembers', 'maxNodes']) {
    const n = limits[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) cleanLimits[k] = Math.floor(n);
  }
  return {
    tier,
    limits: cleanLimits,
    features: Array.isArray(o.features) ? o.features.filter((x): x is string => typeof x === 'string') : [],
    seats: typeof o.seats === 'number' && Number.isFinite(o.seats) && o.seats > 0 ? Math.floor(o.seats) : 1,
    expires_at: typeof o.expires_at === 'string' && o.expires_at ? o.expires_at : null,
    issued_at: typeof o.issued_at === 'string' && o.issued_at ? o.issued_at : null,
    signature: typeof o.signature === 'string' ? o.signature : '',
    source,
  };
}

/**
 * 读缓存。缺行/坏 JSON ⇒ `null`（fail-open 方向：没有云端权益，按本地跑）。
 * 「有失败账、从未成功」是**合法**形态（`entitlement: null`）——界面据此如实显示不可达原因。
 */
export function readCloudEntitlementCache(db: CloudEntitlementDb | null | undefined): CloudEntitlementCache | null {
  if (!db) return null;
  let raw: string | null = null;
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(CLOUD_ENTITLEMENT_SETTING_KEY) as
      | { value?: string }
      | undefined;
    raw = row?.value ?? null;
  } catch {
    return null; // 表未建 ⇒ 同"没有"
  }
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const entitlement = o.entitlement == null ? null : parseCloudEntitlement(o.entitlement);
    // 有 entitlement 字段却收窄不出合法权益 ⇒ 这一行整体不可信（不拿半份脏值去合并档位）。
    if (o.entitlement != null && entitlement === null) return null;
    const fetchedAt = typeof o.fetchedAt === 'string' && o.fetchedAt ? o.fetchedAt : null;
    if (entitlement && !fetchedAt) return null; // 有权益却不知何时取得 = 坏行
    const cache: CloudEntitlementCache = {
      fetchedAt,
      entitlement,
      lastError: typeof o.lastError === 'string' && o.lastError ? o.lastError : null,
      lastErrorAt: typeof o.lastErrorAt === 'string' && o.lastErrorAt ? o.lastErrorAt : null,
    };
    if (!cache.entitlement && !cache.lastError) return null; // 两样都没有 = 空壳
    return cache;
  } catch {
    return null;
  }
}

/**
 * 写缓存。只写不抛（写失败 ⇒ 本次记忆不生效，下次再拉；**不**因此让调用方误以为拿到了权益）。
 * 返回是否写入成功。
 */
export function writeCloudEntitlementCache(db: CloudEntitlementWriteDb | null | undefined, cache: CloudEntitlementCache): boolean {
  if (!db) return false;
  try {
    db.prepare(
      "INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime('now'))",
    ).run(CLOUD_ENTITLEMENT_SETTING_KEY, JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

/** 该权益此刻是否**仍然生效**（`source==='cloud'` ∧ 未过期）。缓存会 stale ⇒ 读侧再判一次。 */
export function isCloudEntitlementActive(e: AnsEntitlement, now: Date = new Date()): boolean {
  if (e.source !== 'cloud' || !isEntitlementTier(e.tier)) return false;
  if (!e.expires_at) return true;
  const exp = new Date(e.expires_at).getTime();
  return Number.isFinite(exp) && exp > now.getTime();
}

/**
 * 当前**生效的云端档位**；无缓存/已过期/未生效 ⇒ `null`。
 * 注意返回值仍可能低于本地许可——合并由 `mergeLicenseTier` 做，本函数不替调用方决定。
 */
export function cloudActiveTier(
  db: CloudEntitlementDb | null | undefined,
  now: Date = new Date(),
): LicenseTier | null {
  const cache = readCloudEntitlementCache(db);
  if (!cache?.entitlement) return null;
  return isCloudEntitlementActive(cache.entitlement, now) ? cache.entitlement.tier : null;
}

/** 两档取高（`cloud === null` ⇒ 本地；未知值按最低）。**只升不降**。 */
export function mergeLicenseTier(local: LicenseTier, cloud: LicenseTier | null): LicenseTier {
  if (!cloud) return local;
  const lr = entitlementTierRank(local);
  const cr = entitlementTierRank(cloud);
  return cr > lr ? cloud : local;
}

/** 档位集合（供 rr 断言顺序/合法性时派生，不在测试里手抄）。 */
export const ENTITLEMENT_TIER_ORDER: readonly LicenseTier[] = LICENSE_TIERS;
