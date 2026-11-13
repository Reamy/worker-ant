/**
 * zx_20261106_3 B2「协」/ zx_20261107_1 B10a「实·通·信」（孙子·知彼知己 / 管子·仓廪实）:
 *   **节点与任务需求的匹配分**——双尺：用户权重（0＝不参与）+ 实测（成功率/时延/忙闲/资源）。
 *
 * 病根：派发只会看"本机有没有空位"，不看"这台机器是否更合适"。本模块给每台候选节点（**含本机**）
 *   算同一个分、说同一句人话理由，供 `capability-dispatch` 决策与 GUI 解释。
 *
 * 七面加权 + 硬否决：
 *   类目 0.40 / 意图 0.18 / 设备品类 0.18 / 历史可靠性 0.08 / 时延 0.04 / 余力 0.05 / 资源 0.07；
 *   用户权重只作**倍率**（1..10 → ×0.7..×1.0），不另立一面。
 *
 * 硬否决（缺一即不可派）：离线 / 缺主类目 / 缺要求意图 / 缺要求设备品类 / 余力低于 0.15 /
 *   **权重 ≤ 0（用户明确不参与协同）**。
 *   余力/时延/资源未知（`null`）不否决也不装高——按中性 0.5 计分；未知绝不按 0 冒充"满载/最慢"。
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

/**
 * 心跳快照里的资源面（b10a）：与负载/余力**分开**——余力问"还有没有工位"，
 *   资源问"机器本身扛不扛得住"。取不到就是 `null`（"没有这个数"≠"空闲"）。
 */
export interface NodeResources {
  /** CPU 余量 0..1；`null` = 未知。 */
  cpuSpare: number | null;
  /** 内存余量 0..1；`null` = 未知。 */
  memSpare: number | null;
  /** 每核 1 分钟负载（0..n，0 最好）；`null` = 未知（Windows 无 loadavg）。 */
  loadPerCore: number | null;
  /** 磁盘余量 0..1；`null`/缺省 = 未知（未采集或总量取不到）。 */
  diskSpare?: number | null;
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
  /** 用户权重（1..10 作倍率；**≤0 即不参与协同**）。 */
  weight: number;
  reliability: NodeReliability | null;
  /** 资源面；缺省/`null` = 未知（按中性 0.5 计，不否决）。 */
  resources?: NodeResources | null;
  /**
   * B5：本机公示的岗位 id（`card.positions[].id`）。缺省/空＝**未上报或没有岗位**——
   *   岗位加成只在"任务点名某岗位且此节点公示含该 id"时生效，未命中的一律 0。
   */
  positions?: string[];
  /** B5：六类目在跑数；缺省/`null` = 未知（不加不减，绝不按 0 读成"空闲"）。 */
  classRunning?: Record<NodeCardCategory, number> | null;
  /** B5：机器并发上限；缺省/`null`/≤0 = 未知（类目压力不生效）。 */
  machineLimit?: number | null;
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
  category: 0.4,
  intent: 0.18,
  device: 0.18,
  reliability: 0.08,
  latency: 0.04,
  free: 0.05,
  resource: 0.07,
} as const;

/** 时延归一：≤300ms 记满分，≥5000ms 记 0（`null` 未知按中性 0.5）。 */
export const LATENCY_FAST_MS = 300;
export const LATENCY_SLOW_MS = 5000;

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

/** 时延分 0..1（快⇒高）；`null` = 未知。 */
function latencyScore(avgLatencyMs: number | null | undefined): number | null {
  if (typeof avgLatencyMs !== 'number' || !Number.isFinite(avgLatencyMs)) return null;
  const ms = Math.max(0, avgLatencyMs);
  return 1 - clamp01((ms - LATENCY_FAST_MS) / (LATENCY_SLOW_MS - LATENCY_FAST_MS));
}

/**
 * 资源分 0..1：已知项的均值（CPU 余量 / 内存余量 / 1−每核负载 / 磁盘余量）；
 *   **未知项跳过**，全部未知 ⇒ `null`（调用方按中性 0.5 计）。未知不按 0 拉低。
 * zx_20261108_1 B1：磁盘作第四源——低磁盘的节点会**如实地**被拉低，而不是看着"CPU 空着"就派。
 */
export function resourceScore(resources: NodeResources | null | undefined): number | null {
  if (!resources) return null;
  const parts: number[] = [];
  if (typeof resources.cpuSpare === 'number' && Number.isFinite(resources.cpuSpare)) {
    parts.push(clamp01(resources.cpuSpare));
  }
  if (typeof resources.memSpare === 'number' && Number.isFinite(resources.memSpare)) {
    parts.push(clamp01(resources.memSpare));
  }
  if (typeof resources.loadPerCore === 'number' && Number.isFinite(resources.loadPerCore)) {
    parts.push(1 - clamp01(Math.max(0, resources.loadPerCore)));
  }
  if (typeof resources.diskSpare === 'number' && Number.isFinite(resources.diskSpare)) {
    parts.push(clamp01(resources.diskSpare));
  }
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
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
 * zx_20261107_1 B5：**能力覆盖**的唯一判据——三面（类目/意图/设备品类）逐项比对，
 * 缺口按**原值**回传（供否决码）并附可读标签（供人话）。
 *
 * 抽出原因：拆解预检只需要"这台节点具备不具备"，不该复用派发期的余力/可靠性否决
 *   （那是"此刻派不派"），否则会出现"机器明明会做、却因此刻忙被判不会做"。`matchNode` 与
 *   `task-preflight` 同引本函数 ⇒ "具备"这一概念只此一份。
 */
export interface CapabilityGap {
  /** 命中的可读标签（`类目:文本`）——与 `MatchResult.matched` 同形、同序。 */
  matched: string[];
  /** 缺口的可读标签（`类目:媒体`）——与 `MatchResult.missing` 同形、同序。 */
  missing: string[];
  missingCategories: NodeCardCategory[];
  missingIntents: string[];
  missingDevices: DeviceKindClass[];
}

export function capabilityGap(
  profile: Pick<NodeMatchProfile, 'categories' | 'intents' | 'deviceClasses'>,
  req: DispatchRequirements,
): CapabilityGap {
  const matched: string[] = [];
  const missing: string[] = [];
  const missingCategories: NodeCardCategory[] = [];
  const missingIntents: string[] = [];
  const missingDevices: DeviceKindClass[] = [];

  const cats = new Set(profile.categories);
  for (const c of req.categories) {
    if (cats.has(c)) matched.push(`类目:${CATEGORY_LABEL[c]}`);
    else { missing.push(`类目:${CATEGORY_LABEL[c]}`); missingCategories.push(c); }
  }
  const intents = new Set(profile.intents);
  for (const i of req.intents) {
    if (intents.has(i)) matched.push(`意图:${i}`);
    else { missing.push(`意图:${i}`); missingIntents.push(i); }
  }
  const devices = new Set(profile.deviceClasses);
  for (const d of req.deviceClasses) {
    if (devices.has(d)) matched.push(`品类:${d}`);
    else { missing.push(`品类:${d}`); missingDevices.push(d); }
  }
  return { matched, missing, missingCategories, missingIntents, missingDevices };
}

/** B5：岗位命中加成上限（**唯一一处**；改值即全处跟，勿在调用方再写 +0.05）。 */
export const POSITION_BONUS_MAX = 0.05;
/** B5：某类目在跑数达到机器上限的这个比例即开始压分（`ceil(limit×比例)` 为门槛）。 */
export const CLASS_PRESSURE_RATIO = 0.75;
/** B5：类目拥挤最多扣这么多分（只压分、**不否决**——拥不拥挤由其余六面继续裁）。 */
export const CLASS_PRESSURE_PENALTY_MAX = 0.1;

/**
 * B5：岗位匹配加成——任务点名岗位（`req.positionId`）且本节点公示含该 id ⇒ `+0.05`；
 *   未点名 / 未上报 / 未命中 ⇒ **0**（不猜、不惩罚）。
 */
export function positionBonus(
  profile: Pick<NodeMatchProfile, 'positions'>,
  req: DispatchRequirements,
): number {
  const wanted = req.positionId;
  if (!wanted) return 0;
  return (profile.positions ?? []).includes(wanted) ? POSITION_BONUS_MAX : 0;
}

export interface ClassPressure {
  /** 0..`CLASS_PRESSURE_PENALTY_MAX`；无要求/未知 ⇒ 0。 */
  penalty: number;
  /** 最挤的那个要求类目（`penalty>0` 时有值）。 */
  category: NodeCardCategory | null;
  /** 直接可上屏的一句（`penalty>0` 时才给，免得"已占 0/8"噪声）。 */
  note: string | null;
}

/**
 * B5：类目拥挤扣分——按任务的**要求类目**看本节点该类目在跑数：
 *   达门槛（`ceil(limit×0.75)`）起压，跑满封顶 `−0.10`；多个要求类目取最挤的那个。
 *   无类目要求 / 上限未知 / 在跑数未知 ⇒ **0**（未知不装"很挤"）。
 */
export function classPressurePenalty(
  profile: Pick<NodeMatchProfile, 'classRunning' | 'machineLimit'>,
  req: DispatchRequirements,
): ClassPressure {
  const limit = profile.machineLimit;
  const running = profile.classRunning;
  if (!limit || limit <= 0 || !running || req.categories.length === 0) {
    return { penalty: 0, category: null, note: null };
  }
  const threshold = Math.ceil(limit * CLASS_PRESSURE_RATIO);
  const span = Math.max(1, limit - threshold + 1);
  let worst: { category: NodeCardCategory; penalty: number; running: number } | null = null;
  for (const category of req.categories) {
    const n = running[category] ?? 0;
    if (n < threshold) continue;
    const penalty = CLASS_PRESSURE_PENALTY_MAX * Math.min(1, (n - threshold + 1) / span);
    if (!worst || penalty > worst.penalty) worst = { category, penalty, running: n };
  }
  if (!worst) return { penalty: 0, category: null, note: null };
  return {
    penalty: worst.penalty,
    category: worst.category,
    note: `类目忙:${CATEGORY_LABEL[worst.category]} 已占 ${worst.running}/${limit} 槽位`,
  };
}

/**
 * 算一台节点对一件任务的匹配分。`req` 三面都为空（无任何要求）⇒ 只剩可靠性/余力分，
 *   但**派发层必须另行拒绝空需求**（这里不替它做主）。
 */
export function matchNode(profile: NodeMatchProfile, req: DispatchRequirements): MatchResult {
  const vetoes: string[] = [];
  const setVeto = (code: string) => { if (!vetoes.includes(code)) vetoes.push(code); };

  if (!profile.online) setVeto('offline');
  // zx_20261107_1 B10a：权重 0＝用户明确不参与协同（与 `isDispatchable` / ANS `weight > 0` 同义）。
  if (Number.isFinite(profile.weight) && profile.weight <= 0) setVeto('weight-zero');

  // B5：三面覆盖同引 `capabilityGap`（拆解预检与派发共用同一把"具备不具备"的尺）。
  const gap = capabilityGap(profile, req);
  const matched = gap.matched;
  const missing = gap.missing;
  for (const c of gap.missingCategories) setVeto(`missing-category:${c}`);
  for (const i of gap.missingIntents) setVeto(`missing-intent:${i}`);
  for (const d of gap.missingDevices) setVeto(`missing-device:${d}`);

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
      : veto === 'weight-zero' ? '权重为 0（用户已关闭，不参与协同）'
      : veto.startsWith('free-too-low') ? `余力过低（${free.toFixed(2)}）`
      : veto.startsWith('low-reliability') ? `历史成功率过低（${(reliability?.successRate ?? 0).toFixed(2)}）`
      : veto;
    return { score: 0, veto, matched, missing, reason: `不可派：${why}` };
  }

  // 过了硬否决 ⇒ 要求的类目/意图/品类**全部具备**（没要求则视为满足），三面各记满分。
  const relComp = reliability ? clamp01(reliability.successRate) : 0.6;
  const latScore = latencyScore(reliability?.avgLatencyMs ?? null);
  const resScore = resourceScore(profile.resources);
  const base =
    MATCH_WEIGHTS.category +
    MATCH_WEIGHTS.intent +
    MATCH_WEIGHTS.device +
    MATCH_WEIGHTS.reliability * relComp +
    MATCH_WEIGHTS.latency * (latScore ?? 0.5) +
    MATCH_WEIGHTS.free * free +
    MATCH_WEIGHTS.resource * (resScore ?? 0.5);
  const weightNorm = (normWeight(profile.weight) - 1) / 9;
  // B5：岗位加成（≤+0.05）与类目拥挤扣分（≤−0.10）都是**总分上的修正**，不改 `MATCH_WEIGHTS`；
  //   两者皆为 0 时（无岗位要求、无类目压力或未知）表达式与旧版**逐字节相同**。
  const bonus = positionBonus(profile, req);
  const pressure = classPressurePenalty(profile, req);
  const score = clamp01(base * (0.7 + 0.3 * weightNorm) + bonus - pressure.penalty);

  const parts = [...matched];
  parts.push(`成功率:${reliability ? `${Math.round(clamp01(reliability.successRate) * 100)}%` : '未知'}`);
  parts.push(`时延:${typeof reliability?.avgLatencyMs === 'number' ? `${Math.round(reliability.avgLatencyMs)}ms` : '未知'}`);
  parts.push(`余力:${profile.freeRatio === null ? '未知' : `${Math.round(free * 100)}%`}`);
  parts.push(`资源:${resScore === null ? '未知' : `${Math.round(resScore * 100)}%`}`);
  parts.push(`权重:${normWeight(profile.weight)}`);
  if (bonus > 0) parts.push(`岗位匹配:+${bonus.toFixed(2)}`);
  if (pressure.note) parts.push(pressure.note);
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
