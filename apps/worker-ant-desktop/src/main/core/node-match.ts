/**
 * zx_20261106_3 B2「协」（孙子·知彼知己 / 维特根斯坦·意义即用法）: **节点与任务需求的匹配分**。
 *
 * 病根：派发只会看"本机有没有空位"，不看"这台机器是否更合适"。本模块给每台候选节点（**含本机**）
 *   算同一个分、说同一句人话理由，供 `capability-dispatch` 决策与 GUI 解释。
 *
 * 五面加权 + 硬否决：
 *   类目 0.45 / 意图 0.2 / 设备品类 0.2 / 历史可靠性 0.1 / 余力 0.05；
 *   权重只作**倍率**（1..10 → ×0.7..×1.0），不另立第六面。
 *
 * 硬否决（缺一即不可派）：离线 / 缺主类目 / 缺要求意图 / 缺要求设备品类 / 余力低于 0.15。
 *   余力未知（`null`）不否决也不装高——按中性 0.5 计分。
 *
 * ⚠ 纯函数、零 IO / 零时钟：rr 可直跑真实现；**本机与他机必须用同一个 `matchNode`**。
 */
import type { NodeCardCategory } from '@worker-ant/shared-types';
import type { DeviceKindClass } from './device-kind.js';
import type { DispatchRequirements } from './task-capability.js';

export interface NodeReliability {
  successRate: number;
  avgLatencyMs: number | null;
  samples: number;
}

export interface NodeMatchProfile {
  nodeId: string;
  isLocal: boolean;
  online: boolean;
  categories: NodeCardCategory[];
  intents: string[];
  deviceClasses: DeviceKindClass[];
  /** 0..1；`null` = 未知（按中性 0.5 计，不否决）。 */
  freeRatio: number | null;
  /** 1..10（越界按边界夹住）。 */
  weight: number;
  reliability: NodeReliability | null;
}

export interface MatchResult {
  /** 0..1；有否决时为 0。 */
  score: number;
  /** 非空即不可派（人话编码，如 `missing-category:code`）。 */
  veto: string | null;
  matched: string[];
  missing: string[];
  /** 直接可上屏的人话。 */
  reason: string;
}

export const MATCH_WEIGHTS = {
  category: 0.45,
  intent: 0.2,
  device: 0.2,
  reliability: 0.1,
  free: 0.05,
} as const;

/** 余力低于此即判"本机/它机都跑不动了"（与溢出模式的"满"不同：留一点呼吸空间）。 */
export const MIN_FREE_RATIO = 0.15;
/** 有历史账但成功率低于此 ⇒ 不派（样本不足 5 条不据此否决，避免一条失败就判死）。 */
export const MIN_RELIABILITY_SAMPLES = 5;
export const MIN_SUCCESS_RATE = 0.35;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function normWeight(w: number): number {
  if (!Number.isFinite(w)) return 1;
  return Math.max(1, Math.min(10, w));
}

const CATEGORY_LABEL: Record<NodeCardCategory, string> = {
  text: '文本',
  code: '编码',
  research: '调研',
  media: '媒体',
  device: '设备',
  project_task: '任务编排',
};

/**
 * 算一台节点对一件任务的匹配分。`req` 三面都为空（无任何要求）⇒ 只剩可靠性/余力分，
 *   但**派发层必须另行拒绝空需求**（这里不替它做主）。
 */
export function matchNode(profile: NodeMatchProfile, req: DispatchRequirements): MatchResult {
  const matched: string[] = [];
  const missing: string[] = [];
  const vetoes: string[] = [];
  const setVeto = (code: string) => { if (!vetoes.includes(code)) vetoes.push(code); };

  if (!profile.online) setVeto('offline');

  const cats = new Set(profile.categories);
  for (const c of req.categories) {
    if (cats.has(c)) matched.push(`类目:${CATEGORY_LABEL[c]}`);
    else { missing.push(`类目:${CATEGORY_LABEL[c]}`); setVeto(`missing-category:${c}`); }
  }
  const intents = new Set(profile.intents);
  for (const i of req.intents) {
    if (intents.has(i)) matched.push(`意图:${i}`);
    else { missing.push(`意图:${i}`); setVeto(`missing-intent:${i}`); }
  }
  const devices = new Set(profile.deviceClasses);
  for (const d of req.deviceClasses) {
    if (devices.has(d)) matched.push(`品类:${d}`);
    else { missing.push(`品类:${d}`); setVeto(`missing-device:${d}`); }
  }

  const free = profile.freeRatio === null ? 0.5 : clamp01(profile.freeRatio);
  if (free < MIN_FREE_RATIO) setVeto(`free-too-low:${free.toFixed(2)}`);

  const reliability = profile.reliability;
  if (reliability && reliability.samples >= MIN_RELIABILITY_SAMPLES && reliability.successRate < MIN_SUCCESS_RATE) {
    setVeto(`low-reliability:${reliability.successRate.toFixed(2)}`);
  }

  const veto = vetoes[0] ?? null;
  if (veto) {
    const why = veto.startsWith('missing-')
      ? `缺${veto.includes('category') ? '类目' : veto.includes('intent') ? '意图' : '设备品类'} ${veto.split(':')[1] ?? ''}`
      : veto === 'offline' ? '离线'
      : veto.startsWith('free-too-low') ? `余力过低（${free.toFixed(2)}）`
      : veto.startsWith('low-reliability') ? `历史成功率过低（${(reliability?.successRate ?? 0).toFixed(2)}）`
      : veto;
    return { score: 0, veto, matched, missing, reason: `不可派：${why}` };
  }

  // 过了硬否决 ⇒ 要求的类目/意图/品类**全部具备**（没要求则视为满足），三面各记满分。
  const relComp = reliability ? clamp01(reliability.successRate) : 0.6;
  const base =
    MATCH_WEIGHTS.category +
    MATCH_WEIGHTS.intent +
    MATCH_WEIGHTS.device +
    MATCH_WEIGHTS.reliability * relComp +
    MATCH_WEIGHTS.free * free;
  const weightNorm = (normWeight(profile.weight) - 1) / 9;
  const score = clamp01(base * (0.7 + 0.3 * weightNorm));

  const parts = [...matched];
  parts.push(`成功率:${reliability ? `${Math.round(clamp01(reliability.successRate) * 100)}%` : '未知'}`);
  parts.push(`余力:${profile.freeRatio === null ? '未知' : `${Math.round(free * 100)}%`}`);
  parts.push(`权重:${normWeight(profile.weight)}`);
  return { score, veto: null, matched, missing, reason: parts.join(' · ') };
}

/**
 * 对端是否**明显强于本机**才值得把活交出去（默认 margin 0.12）。
 * 本机被否决（离线/满/缺能力）时只要求对端可派；两边都不可派 ⇒ 不派。
 */
export function beatsLocal(peer: MatchResult, local: MatchResult, margin = 0.12): boolean {
  if (peer.veto !== null || peer.score <= 0) return false;
  if (local.veto !== null) return true;
  return peer.score - local.score > margin;
}
