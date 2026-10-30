/**
 * zx_20261029_2 M6「堵空档」⑤：**早鸟终身**的名额闸——100 席卖完即止，不能只写在价目表上。
 *
 * 真源是 `EARLY_BIRD.seats`（`core/pricing.ts`）。本模块**不复制** 100：改价目表一处，这里跟着变。
 *
 * 零依赖纯逻辑（不碰 fs）：「已用几席」由签发工具从台账 `data/early-bird-redemptions.jsonl`
 *   读出后喂进来；台账解析也给纯函数 `countRedemptions`，rr 可直测（不靠临时文件）。
 *   fs 留在两侧调用点（`scripts/issue-license.ts` 写、rr 读替身），本模块只做判定。
 */
import { EARLY_BIRD } from './pricing.js';

/** 剩余席位数（已登记 ≥ 总席位 ⇒ 0；负数/非数按 0 算，不出现"负数余量"）。 */
export function earlyBirdRemaining(redeemed: number): number {
  const n = Number.isFinite(redeemed) && redeemed > 0 ? Math.floor(redeemed) : 0;
  return Math.max(0, EARLY_BIRD.seats - n);
}

/** 还能不能卖：`null` = 可以；否则给**判据原文**（命令行/界面照发，不另编话术）。 */
export function earlyBirdRefusal(redeemed: number): string | null {
  if (earlyBirdRemaining(redeemed) > 0) return null;
  return `早鸟终身 ${EARLY_BIRD.seats} 席已售罄（已登记 ${Math.floor(redeemed)} 席）——按价目表转常规专业版`;
}

/** 台账计数：一行一条 JSON。空行/坏行**不计**（手改台账时名额按真实可读记录算）。 */
export function countRedemptions(jsonl: string): number {
  let n = 0;
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as unknown;
      if (o !== null && typeof o === 'object' && !Array.isArray(o)) n++;
    } catch { /* 坏行不计 */ }
  }
  return n;
}

/** 一行台账记录（签发工具写；仅供对账，不参与授权判定——授权仍看签名许可本身）。 */
export interface EarlyBirdRedemptionRecord {
  /** 签发时刻（ISO，即载荷 `issuedAt`）。 */
  at: string;
  subject: string;
  tier: string;
  expiresAt: string | null;
  /** 绑定设备数（早鸟是个人买断，通常 0/1）。 */
  devices: number;
}

/** 序列化成台账行（含换行）——写口与 rr 断言共用同一形状。 */
export function redemptionLine(rec: EarlyBirdRedemptionRecord): string {
  return JSON.stringify(rec) + '\n';
}
