/**
 * zx_20261108_1 B2（亚里士多德·潜能成现实 / 管子·量力而行）: **节点角色建议**——纯函数，只建议不改。
 *
 * 病根：面板只答"这台现在什么样"，不答"它该当什么角色"——用户得自己把余力/成功率/离线/权重
 *   在脑子里做心算，改错角色又会把活派进死路。
 *
 * 三条硬边界：
 *   1. **只出建议**：本模块零 IO、零时钟、无 db 参数——采纳与否由用户点「采纳」走既有 `nodes:update`；
 *   2. **不知道就说不知道**：余力/成功率/槽位缺失 ⇒ 不当 0，也不当满分；数据不足按中性建议并降置信；
 *   3. **与派发同一把尺**：阈值与样本下限取自 `node-match.ts`（`MIN_FREE_RATIO` / `MIN_SUCCESS_RATE` /
 *      `MIN_RELIABILITY_SAMPLES`），不在此另抄一份数（否则建议与硬否决各说各话）。
 */
import { NODE_ROLE, type NodeRole } from '@worker-ant/shared-types';
import {
  MIN_FREE_RATIO,
  MIN_RELIABILITY_SAMPLES,
  MIN_SUCCESS_RATE,
  type NodeReliability,
} from './node-match.js';

/** 建议角色——就是 `NodeRole` 三档（不另立第四档）。 */
export type SuggestedRole = NodeRole;
export type AdviceConfidence = 'low' | 'medium' | 'high';

/**
 * 余力最紧的来源——与 `node-heartbeat.ts` 的 `CapacitySource` **同枚举**。
 * 此处按住处收窄：建议模块被 renderer 直引，不引心跳模块那棵重 import 树（DB/许可/ANS）。
 */
export type AdviceBottleneck = 'cpu' | 'mem' | 'slot' | 'disk';

/** 瓶颈来源的人话名——单处；面板与理由共用（加一源是编译期错误）。 */
export const BOTTLENECK_LABEL: Record<AdviceBottleneck, string> = {
  cpu: 'CPU', mem: '内存', slot: '槽位', disk: '磁盘',
};

export interface RoleAdviceInput {
  online: boolean;
  currentRole: NodeRole;
  weight: number;
  capacityFreeRatio: number | null;
  bottleneck: AdviceBottleneck | null;
  freeSlots: number | null;
  reliability: NodeReliability | null;
}

export interface RoleAdvice {
  suggested: SuggestedRole;
  reasons: string[];
  confidence: AdviceConfidence;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function capText(ratio: number, bottleneck: AdviceBottleneck | null): string {
  return bottleneck ? `余力 ${pct(ratio)}（瓶颈：${BOTTLENECK_LABEL[bottleneck]}）` : `余力 ${pct(ratio)}`;
}

/**
 * 给一台节点出**角色建议**。规则按"先否决、后择业"排序——任一否决在先，就不拿后面的好话去冲淡：
 *   - 离线 ⇒ 观察者（派过去的活没人接）；
 *   - 权重 ≤ 0 ⇒ 观察者（用户已明说"不参与协同"，角色口径要跟上）；
 *   - 有足够样本且成功率低于派发阈值 ⇒ 观察者（与 `matchNode` 的硬否决同尺）；
 *   - 余力低于可接活下限 ⇒ 观察者（先把活留给还能跑的地方）；
 *   - 余力充足 ∧ 可靠性高 ⇒ 主节点；余力尚可 ⇒ 工作节点；
 *   - 什么都不知道 ⇒ 工作节点 + 低置信，并明写"数据不足"。
 */
export function suggestNodeRole(input: RoleAdviceInput): RoleAdvice {
  const { online, currentRole, weight, capacityFreeRatio, bottleneck, freeSlots, reliability } = input;
  const rel = reliability;

  if (!online) {
    return {
      suggested: NODE_ROLE.observer,
      reasons: ['当前离线——派过去的活没人接，建议先当观察者'],
      confidence: 'high',
    };
  }

  if (!Number.isFinite(weight) || weight <= 0) {
    return {
      suggested: NODE_ROLE.observer,
      reasons: ['权重为 0（已关闭参与协同）——角色同步为观察者，面板与派发口径才一致'],
      confidence: 'high',
    };
  }

  if (rel !== null && rel.samples >= MIN_RELIABILITY_SAMPLES && rel.successRate < MIN_SUCCESS_RATE) {
    return {
      suggested: NODE_ROLE.observer,
      reasons: [`近 ${rel.samples} 单成功率 ${pct(rel.successRate)}（低于 ${pct(MIN_SUCCESS_RATE)} 阈值），不宜再接活`],
      confidence: 'high',
    };
  }

  if (isNum(capacityFreeRatio) && capacityFreeRatio < MIN_FREE_RATIO) {
    return {
      suggested: NODE_ROLE.observer,
      reasons: [
        capText(capacityFreeRatio, bottleneck),
        `低于 ${pct(MIN_FREE_RATIO)} 的可接活下限——先把活留给还能跑的地方`,
      ],
      confidence: 'medium',
    };
  }

  const relHealthy = rel !== null && rel.samples >= MIN_RELIABILITY_SAMPLES && rel.successRate >= 0.7;
  const capAmple = isNum(capacityFreeRatio) && capacityFreeRatio >= 0.5;
  const slotsFree = isNum(freeSlots) && freeSlots >= 1;
  const hasCapacityData = isNum(capacityFreeRatio) || isNum(freeSlots);

  if (relHealthy && rel !== null && (capAmple || slotsFree)) {
    const reasons = [`近 ${rel.samples} 单成功率 ${pct(rel.successRate)}`];
    if (isNum(capacityFreeRatio)) reasons.push(capText(capacityFreeRatio, bottleneck));
    if (slotsFree) reasons.push(`空闲槽位 ${Math.trunc(freeSlots)}`);
    reasons.push('余力与可靠性都够——建议作为主节点（可派单亦可承接）');
    return { suggested: NODE_ROLE.primary, reasons, confidence: capAmple ? 'high' : 'medium' };
  }

  if (hasCapacityData) {
    const reasons: string[] = [];
    if (isNum(capacityFreeRatio)) reasons.push(capText(capacityFreeRatio, bottleneck));
    if (slotsFree) reasons.push(`空闲槽位 ${Math.trunc(freeSlots)}`);
    reasons.push(rel !== null && rel.samples >= MIN_RELIABILITY_SAMPLES
      ? `近 ${rel.samples} 单成功率 ${pct(rel.successRate)}`
      : '样本不足，按中性建议');
    reasons.push('适合作为工作节点接活');
    return { suggested: NODE_ROLE.worker, reasons, confidence: relHealthy || capAmple ? 'medium' : 'low' };
  }

  return {
    suggested: NODE_ROLE.worker,
    reasons: [`没有余力快照、槽位与足够的出站样本——数据不足，${currentRole === NODE_ROLE.worker ? '维持工作节点' : '按中性建议工作节点'}`],
    confidence: 'low',
  };
}
