/**
 * 席位用量的**展示词表**（zx_20261017_1 批五）——用户页与设置页共用一处。
 *
 * ⚠ 只格式化，不判断"能不能加"：满员与否的真判据在 main 侧 `assertSeatAvailable`；
 *   界面按 `license:status.seats` 如实上屏。`max === 0` 表示**不限**（不是"没有席位"）。
 * ⚠ 上限/用量不在前端重算：`used` 来自 `countSeats`，界面抄一遍 `users.length` 就会与
 *   并发写入各说各话（"同一件事，才叫重复"的反面）。
 */
import type { SeatUsage } from '../../../src/main/core/seat-quota.js';

export function seatText(seats: SeatUsage | null | undefined): string {
  if (!seats) return '本机账号 —';
  return seats.max > 0 ? `已用 ${seats.used} / 上限 ${seats.max}` : `已用 ${seats.used}（不限）`;
}

export function seatsFull(seats: SeatUsage | null | undefined): boolean {
  return !!seats && seats.max > 0 && seats.used >= seats.max;
}
