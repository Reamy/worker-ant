/**
 * 席位闸（zx_20261017_1 批五）——「这份许可能坐几个人」的**单一判据**。
 *
 * 上限的唯一真源是 `TIER_LIMITS[tier].maxMembers`（`0 = 不限`）；本文件只做三件薄事：
 * 数现有席位、把上限与用量拼成人话、在**新增之前**拦下超员。
 *
 * ⚠ 只拦**新增**：已有成员不因满员/降档被删、被禁、被登出——席位是"还能不能再进来"的闸，
 *   不是"已经进来的人还算不算数"。故本模块**只有** `assertSeatAvailable`，没有"驱逐"。
 * ⚠ 档位由调用方经 `resolveLicenseTier(db)` 取（`license.ts` 的薄封装），本模块不自己解析许可
 *   ——否则同一把尺两处解析，试用/坏 key/到期各有一套说法。
 */
import { TIER_LABEL, TIER_LIMITS, type LicenseTier } from './feature-limits.js';

/** 读席位的最小库接口（同 `AuditDb` 形：可脱 better-sqlite3 被 rr 直跑）。 */
export interface SeatDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export interface SeatUsage {
  used: number;
  max: number;
  /** 人话档位名（界面直接用；漏一档是编译期错）。 */
  label: string;
}

/** 席位上限已满——IPC 层据此回 `SEAT_LIMIT`，文案里带 `已用/上限`，不吞掉具体数。 */
export class SeatLimitError extends Error {
  readonly code = 'SEAT_LIMIT';
  constructor(
    readonly used: number,
    readonly max: number,
    readonly tier: LicenseTier,
  ) {
    super(`${TIER_LABEL[tier]}席位已满（${used}/${max}）。已有成员不受影响；升级档位可增加席位。`);
    this.name = 'SeatLimitError';
  }
}

/** 现存席位 = `wa_users` 行数（**唯一**计数处；`license:status` 与闸门同引此函数）。 */
export function countSeats(db: SeatDb): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM wa_users').get() as { c?: number } | undefined;
  return typeof row?.c === 'number' ? row.c : 0;
}

/** 用量投影：`used` 恒有值，`max === 0` 表示不限。 */
export function seatUsage(db: SeatDb, tier: LicenseTier): SeatUsage {
  return { used: countSeats(db), max: TIER_LIMITS[tier].maxMembers, label: TIER_LABEL[tier] };
}

/** 是否已达上限（`max === 0` ⇒ 不限，恒 false）。 */
export function seatLimitReached(tier: LicenseTier, used: number): boolean {
  const max = TIER_LIMITS[tier].maxMembers;
  return max > 0 && used >= max;
}

/**
 * 新增席位前的闸。满员抛 `SeatLimitError`（含 `used/max`）；不限档永不抛。
 * **调用时机**：新用户**插入之前**（OAuth/邀请/管理员创建/自助注册四个入口同此一扇门）。
 */
export function assertSeatAvailable(db: SeatDb, tier: LicenseTier): void {
  const used = countSeats(db);
  if (seatLimitReached(tier, used)) {
    throw new SeatLimitError(used, TIER_LIMITS[tier].maxMembers, tier);
  }
}
