/**
 * zx_20261023_5 批五（毛选·不打无准备之仗 / 管子·度量衡）：**云端权益端点（骨架）**。
 *
 * `GET /api/v1/entitlements`——HMAC 保护，按调用方 API Key 前缀回一档权益。
 *   桌面启动时 5 秒有界拉取，**失败 fail-open**（按本地许可运行），设置页如实显示不可达原因。
 *
 * ⚠ 只读：本文件**没有写入口**。签发由运维直接落 `ans_entitlements`（含 `signature`），
 *   免得把"谁能改权益"做成又一条可攻击的活口。
 * ⚠ 判据抽成纯函数 `resolveEntitlement`（只吃 db + keyPrefix + now）——rr 用内存库直跑生产同一份，
 *   路由壳只做 header 取参与 JSON 整形。
 * ⚠ 过期与未签发**分开**回（`source: 'expired' | 'none'`）：两种"没有"在排查时是两件事。
 */
import type Database from 'better-sqlite3';
import { Elysia } from 'elysia';
import { randomUUID } from 'node:crypto';
import {
  isEntitlementTier,
  type AnsEntitlement,
  type AnsEntitlementLimits,
  type EntitlementSource,
} from '@worker-ant/shared-types';

interface EntitlementRow {
  id: string;
  key_prefix: string;
  tier: string;
  limits_json: string;
  features_json: string;
  seats: number;
  expires_at: string | null;
  signature: string;
  status: string;
  issued_at: string | null;
}

/** 无权益的回包（未签发 / 已过期共用形状，档位一律 community）。 */
function emptyEntitlement(source: EntitlementSource, row?: EntitlementRow): AnsEntitlement {
  return {
    tier: 'community',
    limits: {},
    features: [],
    seats: 1,
    expires_at: row?.expires_at ?? null,
    issued_at: row?.issued_at ?? null,
    signature: row?.signature ?? '',
    source,
  };
}

function parseLimits(raw: string): Partial<AnsEntitlementLimits> {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const o = v as Record<string, unknown>;
    const out: Partial<AnsEntitlementLimits> = {};
    for (const k of ['maxProjectConcurrency', 'maxProjects', 'maxMembers', 'maxNodes'] as const) {
      const n = o[k];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
    }
    return out;
  } catch {
    return {}; // 坏载荷 ⇒ 不据此缩权（执行面本来只认档位）
  }
}

function parseFeatures(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 按 API Key 前缀解析权益。**不 throw**：任何异常都按"未签发"回（fail-open 方向）。
 *   · 无行 / `status != 'active'` ⇒ `source: 'none'`
 *   · 有行但 `expires_at` 已过 ⇒ `source: 'expired'`（档位回 community，**不**继续给权益）
 *   · 有行且档位不合法 ⇒ `none`（脏值不撒谎）
 */
export function resolveEntitlement(
  db: Database.Database | null | undefined,
  keyPrefix: string,
  now: Date = new Date(),
): AnsEntitlement {
  const prefix = (keyPrefix ?? '').trim();
  if (!db || prefix.length < 8) return emptyEntitlement('none');
  let row: EntitlementRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT id, key_prefix, tier, limits_json, features_json, seats, expires_at, signature, status, issued_at
           FROM ans_entitlements WHERE key_prefix = ? AND status = 'active' LIMIT 1`,
      )
      .get(prefix) as EntitlementRow | undefined;
  } catch {
    return emptyEntitlement('none');
  }
  if (!row) return emptyEntitlement('none');
  if (!isEntitlementTier(row.tier)) return emptyEntitlement('none', row);
  if (row.expires_at) {
    const exp = new Date(row.expires_at).getTime();
    if (!Number.isFinite(exp) || exp <= now.getTime()) return emptyEntitlement('expired', row);
  }
  return {
    tier: row.tier,
    limits: parseLimits(row.limits_json),
    features: parseFeatures(row.features_json),
    seats: Number.isFinite(row.seats) && row.seats > 0 ? Math.floor(row.seats) : 1,
    expires_at: row.expires_at ?? null,
    issued_at: row.issued_at ?? null,
    signature: row.signature ?? '',
    source: 'cloud',
  };
}

/** 签发（运维脚本/测试用）：写入一行权益，签名由调用方给出。**不是 HTTP 入口**。 */
export function issueEntitlement(
  db: Database.Database,
  input: {
    keyPrefix: string;
    tier: string;
    limits?: Partial<AnsEntitlementLimits>;
    features?: string[];
    seats?: number;
    expiresAt?: string | null;
    signature: string;
    note?: string;
    now?: Date;
  },
): { ok: boolean; detail: string } {
  if (!isEntitlementTier(input.tier)) return { ok: false, detail: `档位不合法：${String(input.tier)}` };
  if ((input.keyPrefix ?? '').length < 8) return { ok: false, detail: 'API Key 前缀至少 8 位' };
  if (!input.signature) return { ok: false, detail: '缺少签名（签发须给出 signature）' };
  try {
    db.prepare(
      `INSERT INTO ans_entitlements
         (id, key_prefix, tier, limits_json, features_json, seats, expires_at, signature, note, status, issued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(key_prefix) DO UPDATE SET
         tier = excluded.tier, limits_json = excluded.limits_json, features_json = excluded.features_json,
         seats = excluded.seats, expires_at = excluded.expires_at, signature = excluded.signature,
         note = excluded.note, status = 'active', issued_at = excluded.issued_at, updated_at = excluded.updated_at`,
    ).run(
      randomUUID(),
      input.keyPrefix,
      input.tier,
      JSON.stringify(input.limits ?? {}),
      JSON.stringify(input.features ?? []),
      Math.max(1, Math.floor(input.seats ?? 1)),
      input.expiresAt ?? null,
      input.signature,
      input.note ?? '',
      (input.now ?? new Date()).toISOString(),
      (input.now ?? new Date()).toISOString(),
    );
    return { ok: true, detail: `已签发：${input.tier}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export function entitlementsRoutes(db: Database.Database) {
  return new Elysia({ prefix: '/api/v1' }).get('/entitlements', ({ request }) => {
    // HMAC 已验过身份；这里只取前缀。缺头 ⇒ 空权益（不是 401——上层闸已拦）。
    const apiKey = request.headers.get('x-api-key') ?? '';
    return resolveEntitlement(db, apiKey.slice(0, 8));
  });
}
