/**
 * zx_20261027_3 M1「实况」：派单择机的**纯函数**（零网络、零 DB）。
 *
 * 取代原先的 SQL 排序
 *   `ORDER BY weight * COALESCE(json_extract(status_json,'$.capacity_free_ratio'), 1.0) DESC`
 * 它把「余力未知」当成 **1.0 = 满血空闲**：一台没上报容量的机器会与真正空闲的机器同分，
 * 甚至凭高权重压过一台已知 70% 空闲的机器。本轮改为固定三层（道德经「知人者智，自知者明」）：
 *
 *   ① 已知有余力（ratio > 0）—— 净收益 `weight × ratio` 降序；
 *   ② 余力未知       —— 按 weight 降序（读不到负载**不惩罚**，但也不假装它满血）；
 *   ③ 已知满负荷（ratio = 0）—— 按 weight 降序，永远排在有/未知余力之后。
 *
 * 层内再按 `free_slots` 降序（未知排已知之后）、`last_seen_at` 降序、`node_id` 升序兜底（保证确定性）。
 * 非法数据（ratio 超出 0..1、非有限数、非数字）一律按「未知」处理——脏值不该被当成事实。
 *
 * zx_20261030_1 M1「稳」：层内再加**历史成败与耗时**的次级键（毛选「没有调查，没有发言权」——
 *   样本来自 `ans_node_requests` 的**既有行**，不新增上报字段、不拍脑袋）。
 *   ⚠ 成功率**只在同一 tier 内**当次级键：一个满载但成功率高 10% 的节点，**不得**越过有闲节点。
 *   ⚠ 样本不足（< MIN_RELIABLE_SAMPLES）一律用中性先验 0.5——新节点不该因「还没跑过」被罚。
 */

export type RankGroup = 'free' | 'unknown' | 'full';

/** 历史可靠性（由既有请求行派生；`samples` 只数已终态者）。 */
export interface NodeReliability {
  /** 拉普拉斯平滑成功率 `(success + 1) / (success + failure + 2)`；样本 0 时 = 0.5。 */
  successRate: number;
  /** 平均耗时（毫秒，`done_at - claimed_at`）；无可用样本为 `null`。 */
  avgLatencyMs: number | null;
  /** 参与计算的终态行数（窗口内；取消不计入分子分母）。 */
  samples: number;
  /** 失败数（超时/报错；取消不算失败）——给人看的理由要用。 */
  failures: number;
}

/** 一条已终态请求行（`ans_node_requests` 的投影，只取算可靠性所需列）。 */
export interface RequestOutcomeRow {
  status: string;
  claimed_at: string | null;
  done_at: string | null;
}

/** 少于这个样本数就用中性先验——「还没跑过」不是劣迹。 */
export const MIN_RELIABLE_SAMPLES = 3;

/** 每节点参与计算的最近终态请求条数上限（有界窗口，防止陈年账永远压着新表现）。 */
export const RELIABILITY_WINDOW = 50;

export interface RankableNode {
  node_id: string;
  weight: number;
  status_json: string | null;
  last_seen_at: string | null;
  /** 历史可靠性；缺省（`undefined`/`null`）按中性处理——面板/回归可只喂容量。 */
  reliability?: NodeReliability | null;
}

/** zx_20261108_1 B1：余力瓶颈来源（与心跳 `capacity_basis.bottleneck` 同一词表）。 */
export type CapacityBottleneck = 'cpu' | 'mem' | 'slot' | 'disk';

/** 四源余量（0..1；未知为 `null`）——只用于解释"哪一项最紧"，不参与排序。 */
export interface CapacityBasis {
  cpu: number | null;
  mem: number | null;
  slot: number | null;
  disk: number | null;
}

export interface ParsedCapacity {
  /** 已知空闲比例 0..1；`null` = 未知或非法。`0` 是**已知满负荷**，与 `null` 不同。 */
  ratio: number | null;
  /** 已知剩余槽位（非负整数）；`null` = 未知或非法。 */
  freeSlots: number | null;
  /**
   * B1：最紧的那一项（心跳 `capacity_basis.bottleneck`）。
   * 旧客户端/坏值 ⇒ **键缺省**（不是 `null` 值），使旧调用的深比较不变。
   */
  bottleneck?: CapacityBottleneck;
  /** B1：四源余量快照（与 `bottleneck` 同来同去）。 */
  basis?: CapacityBasis;
  /** B1：磁盘字节（仅当合法时出现），用于人话"可用 X / Y"。 */
  diskFree?: number;
  diskTotal?: number;
}

export interface RankedCandidate<T> {
  item: T;
  nodeId: string;
  group: RankGroup;
  weight: number;
  ratio: number | null;
  freeSlots: number | null;
  lastSeenAt: string | null;
  /** 层内排序分：free 层 = `weight × ratio`，unknown/full 层 = `weight`。 */
  score: number;
  /** 历史可靠性（缺省时 `samples: 0` 的中性态）。 */
  reliability: NodeReliability;
  /** B1：最紧的一项（仅解释用，不参与排序）；未知 ⇒ `null`。 */
  bottleneck: CapacityBottleneck | null;
  /** B1：四源余量快照（仅解释用）；未知 ⇒ `null`。 */
  basis: CapacityBasis | null;
  /** B1：磁盘字节（仅当心跳给出）；用于"可用 X / Y"。 */
  diskFree: number | null;
  diskTotal: number | null;
}

export interface SelectionSnapshot {
  nodeId: string;
  group: RankGroup;
  score: number;
  ratio: number | null;
  freeSlots: number | null;
  /** zx_20261030_1 M1：历史可靠性快照（样本不足时为中性态，`samples` 照实）。 */
  reliability: NodeReliability;
  /** B1：最紧的一项（仅解释用）；心跳未给 ⇒ `null`。 */
  bottleneck: CapacityBottleneck | null;
  /** 人话理由——面板/日志可答「为什么派给它」。 */
  reason: string;
}

const GROUP_ORDER: Record<RankGroup, number> = { free: 0, unknown: 1, full: 2 };

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ratio01(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function bytes(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * B1：从心跳 status 里读**瓶颈**与四源快照。只在字段合法时**加上键**——旧客户端没有这些字段，
 * 返回的形状与旧版逐键相同（既有深比较断言不受影响）。
 */
function parseBasis(obj: Record<string, unknown>): Pick<ParsedCapacity, 'bottleneck' | 'basis'> {
  const raw = obj.capacity_basis;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const b = raw as Record<string, unknown>;
  const basis: CapacityBasis = {
    cpu: ratio01(b.cpu),
    mem: ratio01(b.mem),
    slot: ratio01(b.slot),
    disk: ratio01(b.disk),
  };
  const bn = b.bottleneck;
  const bottleneck: CapacityBottleneck | undefined =
    bn === 'cpu' || bn === 'mem' || bn === 'slot' || bn === 'disk' ? bn : undefined;
  return { basis, ...(bottleneck ? { bottleneck } : {}) };
}

export function parseCapacity(statusJson: string | null | undefined): ParsedCapacity {
  const obj = parseJsonObject(statusJson);
  if (!obj) return { ratio: null, freeSlots: null };
  const rawRatio = obj.capacity_free_ratio;
  const ratio = ratio01(rawRatio);
  const rawSlots = obj.free_slots;
  const freeSlots =
    typeof rawSlots === 'number' && Number.isFinite(rawSlots) && rawSlots >= 0 ? Math.floor(rawSlots) : null;
  const diskFree = bytes(obj.disk_free);
  const diskTotal = bytes(obj.disk_total);
  return {
    ratio,
    freeSlots,
    ...parseBasis(obj),
    ...(diskFree !== undefined && diskTotal !== undefined ? { diskFree, diskTotal } : {}),
  };
}

function safeWeight(weight: number): number {
  return typeof weight === 'number' && Number.isFinite(weight) ? weight : 1;
}

/**
 * zx_20261101_2 M3：**项目权重缩放**（纯函数，唯一处）。
 *
 * 只在层内改分数：调用方在 `rankDispatchCandidates` **之前**把缩放后的权重写进候选，
 *   `ratio` 仍来自节点余力 ⇒ 一个被项目加权 10 倍的满负荷节点**仍排在**有闲节点之后
 *   （三层分组与可靠性次级键不变，承 `zx_20261030_1` 的"稳"）。
 * 非法/缺省倍率 ⇒ 原权重（不因脏值改变排序）；乘积夹在 0.1..10，避免极端值把排序压成常量。
 */
export function scaleRankWeight(weight: number, scale: number | undefined | null): number {
  const w = safeWeight(weight);
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return w;
  const s = Math.min(10, Math.max(0.1, scale));
  return Math.min(10, Math.max(0.1, w * s));
}

/**
 * zx_20261101_2 M3：**按项目白名单收窄候选**（纯函数，唯一处）。
 *
 * `candidateNodeIds` 缺省（`undefined`/`null`）⇒ 原样返回（不按项目分工收窄）；
 *   给出（含空数组）⇒ 只留白名单内者——空数组即"本项目一个节点也不派"。
 * ⚠ 白名单只做**成员判定**；"这节点此刻接不接这类活"仍由 `DISPATCHABLE_WHERE`
 *   （生产查询已先行过滤，与 `nodeQualifies` 同源）把关，此处不另写第二把尺。
 */
export function filterRankCandidates<T extends { node_id: string }>(
  nodes: readonly T[],
  candidateNodeIds: readonly string[] | undefined | null,
): T[] {
  if (candidateNodeIds === undefined || candidateNodeIds === null) return [...nodes];
  const allow = new Set(candidateNodeIds);
  return nodes.filter((n) => allow.has(n.node_id));
}

function groupOf(ratio: number | null): RankGroup {
  if (ratio === null) return 'unknown';
  return ratio > 0 ? 'free' : 'full';
}

/** 中性先验（样本不足时用）；`samples: 0` 让界面能如实说「还没有样本」。 */
export function neutralReliability(): NodeReliability {
  return { successRate: 0.5, avgLatencyMs: null, samples: 0, failures: 0 };
}

/** `'YYYY-MM-DD HH:MM:SS'`（SQLite UTC）→ 毫秒；不可解析 ⇒ `null`（不猜）。 */
function parseUtcMs(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(`${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 历史可靠性——**纯函数**（零 DB）：传入该节点的终态行（**按时间降序**，最多 `window` 条）。
 *   · `done` 记成功；`error` 记失败；`cancelled`（zx_20261030_1 M3 新增终态）**不计**——
 *     用户叫停不是节点的过错。
 *   · 成功率用拉普拉斯平滑 ⇒ 样本 0 时恰为 0.5，1 成功 = 2/3，1 失败 = 1/3（不出现 100%/0% 的假确定）。
 *   · 耗时只取既有 `claimed_at` 与 `done_at`（两端都有值才算）；样本不足 ⇒ `avgLatencyMs: null`。
 */
export function reliabilityOf(
  rows: readonly RequestOutcomeRow[],
  window: number = RELIABILITY_WINDOW,
): NodeReliability {
  let success = 0;
  let failure = 0;
  let latencySum = 0;
  let latencyCount = 0;
  for (const row of rows.slice(0, Math.max(0, window))) {
    if (row.status === 'done') success++;
    else if (row.status === 'error') failure++;
    else continue; // cancelled / 其它中间态不进分子分母
    const start = parseUtcMs(row.claimed_at);
    const end = parseUtcMs(row.done_at);
    if (start !== null && end !== null && end >= start) {
      latencySum += end - start;
      latencyCount++;
    }
  }
  const samples = success + failure;
  return {
    successRate: (success + 1) / (samples + 2),
    avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    samples,
    failures: failure,
  };
}

/**
 * 样本不足时**排序用中性态**（否则「1 单失败」就会被读成 33% = 劣迹）；
 * `samples/failures` 照原值保留，界面可以如实说「样本还不够」。
 */
function effectiveReliability(raw: NodeReliability | null | undefined): NodeReliability {
  if (!raw) return neutralReliability();
  if (raw.samples < MIN_RELIABLE_SAMPLES) {
    return { successRate: 0.5, avgLatencyMs: null, samples: raw.samples, failures: raw.failures };
  }
  return raw;
}

/** 单节点 → 排序候选（层级/分数口径唯一处）。 */
function toCandidate<T extends RankableNode>(item: T): RankedCandidate<T> {
  const capacity = parseCapacity(item.status_json);
  const { ratio, freeSlots } = capacity;
  const weight = safeWeight(item.weight);
  const group = groupOf(ratio);
  const score = group === 'free' && ratio !== null ? weight * ratio : weight;
  return {
    item,
    nodeId: item.node_id,
    group,
    weight,
    ratio,
    freeSlots,
    lastSeenAt: item.last_seen_at,
    score,
    reliability: effectiveReliability(item.reliability),
    bottleneck: capacity.bottleneck ?? null,
    basis: capacity.basis ?? null,
    diskFree: capacity.diskFree ?? null,
    diskTotal: capacity.diskTotal ?? null,
  };
}

/** 单个节点的人话说明（手动指定目标时用：不排序，但要同一口径的层级/余力快照）。 */
export function describeNode(node: RankableNode): SelectionSnapshot {
  return explainSelection(toCandidate(node));
}

export function rankDispatchCandidates<T extends RankableNode>(nodes: readonly T[]): Array<RankedCandidate<T>> {
  const ranked = nodes.map(toCandidate);

  return ranked.sort((a, b) => {
    const byGroup = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
    if (byGroup !== 0) return byGroup;
    if (b.score !== a.score) return b.score - a.score;
    // zx_20261030_1 M1：同层同分才看「稳」与「快」——**绝不越过上面的层级与净收益**。
    if (b.reliability.successRate !== a.reliability.successRate) {
      return b.reliability.successRate - a.reliability.successRate;
    }
    const aLat = a.reliability.avgLatencyMs ?? Number.POSITIVE_INFINITY;
    const bLat = b.reliability.avgLatencyMs ?? Number.POSITIVE_INFINITY;
    if (aLat !== bLat) return aLat - bLat;
    const aSlots = a.freeSlots ?? -1;
    const bSlots = b.freeSlots ?? -1;
    if (bSlots !== aSlots) return bSlots - aSlots;
    const aSeen = a.lastSeenAt ?? '';
    const bSeen = b.lastSeenAt ?? '';
    if (aSeen !== bSeen) return aSeen < bSeen ? 1 : -1;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

const BOTTLENECK_LABEL: Record<CapacityBottleneck, string> = {
  cpu: 'CPU',
  mem: '内存',
  slot: '槽位',
  disk: '磁盘',
};

/** 字节 → 人话（1 位小数；单位到 GB/TB 为止）。只用于理由文案。 */
function fmtBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function explainSelection<T>(candidate: RankedCandidate<T>): SelectionSnapshot {
  const slots = candidate.freeSlots === null ? '' : `，剩余槽位 ${candidate.freeSlots}`;
  let reason: string;
  if (candidate.group === 'free' && candidate.ratio !== null) {
    reason = `已知余力 ${pct(candidate.ratio)}${slots}，净收益 ${candidate.weight} × ${candidate.ratio} = ${candidate.score.toFixed(2)}`;
  } else if (candidate.group === 'unknown') {
    reason = `余力未知（不惩罚），按权重 ${candidate.weight} 排序${slots}`;
  } else {
    reason = `已知满负荷（权重 ${candidate.weight}），排在有/未知余力之后${slots}`;
  }
  // zx_20261030_1 M1：有足够样本才把历史写进理由——否则「1 单」会被读成结论（样本不足时实话实说）。
  const rel = candidate.reliability;
  if (rel.samples >= MIN_RELIABLE_SAMPLES) {
    const latency = rel.avgLatencyMs === null ? '' : `，均耗 ${Math.round(rel.avgLatencyMs / 1000)}s`;
    reason += `；历史 ${rel.samples} 单，成功率 ${pct(rel.successRate)}（失败 ${rel.failures}）${latency}`;
  } else if (rel.samples > 0) {
    reason += `；历史 ${rel.samples} 单（样本不足，按中性 50% 排序）`;
  }
  // B1：说明"这个余力数是被哪一项压低的"——未知不编（没有 bottleneck 就不加这句话）。
  if (candidate.bottleneck) {
    const spare = candidate.basis?.[candidate.bottleneck] ?? null;
    const pieces: string[] = [];
    if (spare != null) pieces.push(`余量 ${pct(spare)}`);
    if (candidate.bottleneck === 'disk' && candidate.diskFree != null && candidate.diskTotal != null) {
      pieces.push(`可用 ${fmtBytes(candidate.diskFree)} / ${fmtBytes(candidate.diskTotal)}`);
    }
    reason += `；瓶颈：${BOTTLENECK_LABEL[candidate.bottleneck]}${pieces.length ? `（${pieces.join('，')}）` : ''}`;
  }
  return {
    nodeId: candidate.nodeId,
    group: candidate.group,
    score: candidate.score,
    ratio: candidate.ratio,
    freeSlots: candidate.freeSlots,
    reliability: rel,
    bottleneck: candidate.bottleneck,
    reason,
  };
}
