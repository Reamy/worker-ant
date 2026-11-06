/**
 * 邀请令牌的**两跳**（zx_20261017_1 批五）——「发得出」与「接得进」共用一扇席位门。
 *
 * 病根（R-27/R-28）：此前 `auth:invite` 不看席位、`auth:acceptInvite` **先核销令牌再建用户**——
 *   满员时邀请照样发出、接受时令牌已被烧掉、用户却没进来（"邀请发出却接不进来"且无法复用）。
 * 治法：席位闸前移到两跳：
 *   - 发：`issueInviteToken` **先**过闸再落行（满员不落 `wa_invite_tokens`）；
 *   - 接：`claimInviteToken` 先找有效令牌、**再过闸**；建用户成功后才由 `markInviteUsed` 核销
 *     （满员失败时令牌保持可用，去掉一人即可接）。
 *
 * ⚠ 本模块只搬 SQL 与次序，**不**建用户（bcrypt 在 `AuthService`，IPC 负责把三跳串起来）；
 *   令牌列的真形状（`used_at` 无 `used`）见 zx_20261002 M16-④——此处沿用真列，不再另写。
 */
import { assertSeatAvailable, type SeatDb } from './seat-quota.js';
import type { LicenseTier } from './feature-limits.js';

export interface InviteDb extends SeatDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
}

export interface InviteTokenRow {
  id: string;
  token: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
}

/** 发邀请：**先过席位闸**再落行——满员时抛 `SeatLimitError`，令牌表零新增。 */
export function issueInviteToken(
  db: InviteDb,
  tier: LicenseTier,
  args: { id: string; token: string; expiresAt: string },
): void {
  assertSeatAvailable(db, tier);
  db.prepare('INSERT INTO wa_invite_tokens (id, token, expires_at) VALUES (?, ?, ?)').run(
    args.id,
    args.token,
    args.expiresAt,
  );
}

export type ClaimResult =
  | { ok: true; invite: InviteTokenRow }
  | { ok: false; reason: 'invalid' };

/**
 * 接邀请的第一跳：令牌存在、未使用、未过期 ⇒ 再看席位。令牌无效 ⇒ 如实 `invalid`；
 * 满员 ⇒ **抛 `SeatLimitError`**（调用方不得核销令牌）。真正的核销在 `markInviteUsed`。
 */
export function claimInviteToken(db: InviteDb, tier: LicenseTier, token: string): ClaimResult {
  // `expires_at` 存的是 ISO（带 `T`/`Z`），与 `datetime('now')` 的 `YYYY-MM-DD HH:MM:SS` **不同形**，
  //   直接字符串比大小在"同日"会读错 ⇒ 两侧都过 `datetime()` 归一后再比（承 zx_20261002 M16-④）。
  const invite = db
    .prepare(
      "SELECT * FROM wa_invite_tokens WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')",
    )
    .get(token) as InviteTokenRow | undefined;
  if (!invite) return { ok: false, reason: 'invalid' };
  assertSeatAvailable(db, tier);
  return { ok: true, invite };
}

/** 建用户**成功后**的核销（写 `used_at`；令牌若已被另一请求抢先使用，`changes=0` 如实返回）。 */
export function markInviteUsed(db: InviteDb, token: string): boolean {
  const r = db.prepare("UPDATE wa_invite_tokens SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL").run(
    token,
  ) as { changes?: number };
  return (r?.changes ?? 0) > 0;
}
