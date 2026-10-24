/**
 * zx_20261023_5 批五：**云端权益契约**（骨架）。
 *
 * 单一真源：ANS `GET /api/v1/entitlements` 的生产者与桌面 `core/entitlement-client.ts` 的消费者
 * 共引本文件——不各写一份镜像（承 `feedback_enum_value_sweep_readers` 的"第二落点"教训）。
 *
 * ⚠ 本轮边界（如实）：
 *   · `limits` 是**签发时记录的快照**，执行面仍以桌面本地 `TIER_LIMITS` 为准（同一档位语义）；
 *   · `features` 是契约字段（当前执行面按"档位 ⇒ 全部 Pro/Team 能力"判），本轮**不按项放行**；
 *   · `signature` 由签发动作写入，桌面**不验签**——HMAC 通道已确立来源，签名为审计与将来离线校验预留。
 */
export const ENTITLEMENT_TIERS = ['community', 'pro', 'team'] as const;
export type EntitlementTier = (typeof ENTITLEMENT_TIERS)[number];

/** `cloud` = 有生效权益；`none` = 该 Key 未签发；`expired` = 已过期（按无权益处理）。 */
export type EntitlementSource = 'cloud' | 'none' | 'expired';

/** 上限快照（字段与桌面 `TierLimits` 同形；`0 = 不限`）。 */
export interface AnsEntitlementLimits {
  maxProjectConcurrency: number;
  maxProjects: number;
  maxMembers: number;
  maxNodes: number;
}

export interface AnsEntitlement {
  /** 生效档位；`none`/`expired` 时恒为 `community`。 */
  tier: EntitlementTier;
  /** 上限快照；无权益为空对象（桌面不据此缩权，仍按本地档位）。 */
  limits: Partial<AnsEntitlementLimits>;
  /** 签发时登记的能力键（Pro/Team 词表）；无权益为空数组。 */
  features: string[];
  seats: number;
  expires_at: string | null;
  issued_at: string | null;
  signature: string;
  source: EntitlementSource;
}

/** 运行期收窄（外部输入不可信）。 */
export function isEntitlementTier(v: unknown): v is EntitlementTier {
  return typeof v === 'string' && (ENTITLEMENT_TIERS as readonly string[]).includes(v);
}

/** 档位高低（用于"云端只升不降"的合并；未知档位按最低）。 */
export function entitlementTierRank(tier: EntitlementTier): number {
  return ENTITLEMENT_TIERS.indexOf(tier);
}
