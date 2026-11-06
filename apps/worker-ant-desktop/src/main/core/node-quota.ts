/**
 * 协同节点闸（zx_20261023_1「称」）——「这份许可最多让几台工蚁入网」的**单一判据**。
 *
 * 病根：价目表把「20 席位」当 Team 能力行，而席位只是本机 `wa_users` 的行数（`seat-quota.ts`），
 *   **跨机不可聚合**——两台机器各持一份许可，谁也不数谁的账号。真正可跨机兑现的是「入网节点数」，
 *   此前却没有上限：`multi_node` 只判「是不是 Team」，不判「已经来了几台」。
 *
 * 本模块只做三件薄事：数台账里**除本机外**的节点、比上限、给一句带真实数的人话。
 *
 * ⚠ 只拦**新增**：已注册节点不因满员/降档被删（与席位闸同一纪律）。
 * ⚠ **台账读不到 ⇒ fail-open**（`refusal=null` + `note`）：不通网不该把用户锁在门外；
 *   但「本次没校验」必须如实回传，不假装校验过。
 * ⚠ 计数非原子：两机并发入网可能同时通过，最终一致由 ANS 台账兜底。本闸的验收口径是
 *   「单机顺序注册能被拦」，不宣称分布式锁。
 * ⚠ 零 electron 依赖（只引 `feature-limits` 与 `NodeLedger` 类型）：rr 直跑，IPC 只作壳。
 */
import { TIER_LABEL, TIER_LIMITS, type LicenseTier } from './feature-limits.js';
import type { NodeLedger } from './node-list.js';

/** 台账里**除本机**外的节点数（"谁是本机"由 `localNodeId` 定，不按 name 猜）。 */
export function countOtherNodes(ledger: NodeLedger): number {
  return ledger.nodes.filter((n) => n.node_id !== ledger.localNodeId).length;
}

/** 是否已达上限（`maxNodes === 0` ⇒ 不限，恒 false）。`usedOthers` 不含本机——本机这一次也占一个位。 */
export function nodeQuotaReached(tier: LicenseTier, usedOthers: number): boolean {
  const max = TIER_LIMITS[tier].maxNodes;
  return max > 0 && usedOthers + 1 > max;
}

export interface NodeQuotaCheck {
  /** 非空即拦：人话拒因（带已注册/上限的真实数）。 */
  refusal: string | null;
  /** 台账不可读时的如实说明（fail-open：不拦，但要让用户知道这次没校验）。 */
  note?: string;
}

/**
 * 入网前的闸。`ledger` 须是**本次**刚读的台账（同一次判断不跨时刻复用）。
 * 读失败 ⇒ `refusal=null` + `note`；满员 ⇒ 带数拒因；其余 ⇒ 放行。
 */
export function nodeQuotaCheck(tier: LicenseTier, ledger: NodeLedger): NodeQuotaCheck {
  if (ledger.error) {
    return { refusal: null, note: `协同节点台账读取失败（${ledger.error}），本次未校验节点数上限。` };
  }
  const usedOthers = countOtherNodes(ledger);
  if (nodeQuotaReached(tier, usedOthers)) {
    const max = TIER_LIMITS[tier].maxNodes;
    return {
      refusal: `${TIER_LABEL[tier]}协同节点已满（已注册 ${usedOthers} 台，上限 ${max} 台）。`
        + '已注册节点不受影响；升级档位可增加节点。',
    };
  }
  return { refusal: null };
}
