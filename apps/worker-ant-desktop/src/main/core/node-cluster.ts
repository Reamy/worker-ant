/**
 * zx_20261030_1 M4（孙子·谋攻「知彼知己」/ 米勒 7±2）: **集群聚合视图**的纯函数——一屏答「能、闲、稳、堵」。
 *
 * 病根：节点页此前只有逐行列表 + 派单账本，用户要回答「现在卡在哪」得自己把每行的槽位/在线/排队加一遍。
 *   本模块把「本机 + 对端」摊成一份汇总：**聚合数＝逐行数之和**（离线行不计入 running——离线机器没在跑活），
 *   瓶颈一句话当且仅当**满载或有排队**（没堵就别说堵）。
 *
 * ⚠ **纯函数、零 IO** ⇒ 受控回归可直引跑真实现（同 `node-list.ts` 的判据范式）。
 * ⚠ **不知道就说不知道**：槽位/CPU/内存/磁盘取不到 ⇒ `null`，不拿 0 冒充"全空/空闲"；
 *   成功率样本 < 3 单 ⇒ `null`（一单成功不等于"稳"）。他机档位不随心跳上送 ⇒ 他机 `tier` 恒 `null`（不猜）。
 * ⚠ 成功率/延迟只认**已收口**的派发出站单（`done`/`error`）；`cancelled` 既非成也非败，不进分母。
 */
import { isNodeCardCategory, isNodeOnline, type AnsNode, type NodeCardCategory, type NodeRole } from '@worker-ant/shared-types';
import type { LicenseTier } from './feature-limits.js';
import type { NodeDispatchRecord } from './node-dispatch-log.js';

/** 成功率至少要有几单已收口样本才敢报（一单成功不叫"稳"）。 */
const MIN_RATE_SAMPLES = 3;

/** 一个节点在集群视图上的一行（只放上屏用得到的数，取不到一律 `null`）。 */
export interface ClusterNode {
  id: string;
  name: string;
  role: NodeRole;
  online: boolean;
  /** 本机行——UI 置顶并标"本机"。 */
  local: boolean;
  /** 档位：本机读得到；他机不随心跳上送 ⇒ `null`（不猜别人的档）。 */
  tier: LicenseTier | null;
  /** 能力类目（取不到卡 ⇒ `[]`，不伪装成"什么都能干"）。 */
  capabilities: NodeCardCategory[];
  /** 空闲槽位；未知 ⇒ `null`。 */
  freeSlots: number | null;
  /** CPU 使用率 0–100；未知 ⇒ `null`。 */
  cpu: number | null;
  /** 内存可用占比 0–1；未知 ⇒ `null`。 */
  mem: number | null;
  /** 磁盘可用占比 0–1；未知 ⇒ `null`。 */
  disk: number | null;
  /** 我方派给它的单里"成/败"的比例（0–1，样本 < 3 ⇒ `null`）。 */
  successRate: number | null;
  /** 我方派给它的单的平均耗时（毫秒）；无样本 ⇒ `null`。 */
  latency: number | null;
  /** 正占机器槽位的任务数（本机取实时 DB 计数，他机取最近心跳快照）；未知 ⇒ `null`。 */
  running: number | null;
  /** 排队：他机＝我方派给它且未收口的单数；本机＝本地 `pending` 任务数。 */
  queued: number;
  /** 在线且**已知**无空闲槽位 ⇒ `true`；槽位不可知 ⇒ `false`（不知道该不该说满载）。 */
  atCapacity: boolean;
}

export interface ClusterTotals {
  online: number;
  /** Σ(在线 ? running : 0)——离线机器没在跑活，不计入。 */
  running: number;
  queued: number;
  offline: number;
  atCapacity: number;
}

export interface ClusterView {
  nodes: ClusterNode[];
  totals: ClusterTotals;
  /** 瓶颈一句话（列表）：**当且仅当**有满载或有排队时非空。 */
  bottlenecks: string[];
  /** 台账读取失败的人话原因（成功时缺省；与 `NodeLedger.error` 同源）。 */
  error?: string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function ratio(part: number | null, total: number | null): number | null {
  if (part == null || total == null || total <= 0) return null;
  return Math.max(0, Math.min(1, part / total));
}

function statusOf(node: Pick<AnsNode, 'status'>): Record<string, unknown> {
  return node.status && typeof node.status === 'object' ? (node.status as Record<string, unknown>) : {};
}

/** 能力类目（与派单侧同源判据；卡不是 JSON/无 `categories` ⇒ `[]`）。 */
function capabilitiesOf(node: Pick<AnsNode, 'card'>): NodeCardCategory[] {
  const raw = node.card && Array.isArray((node.card as { categories?: unknown }).categories)
    ? ((node.card as { categories: unknown[] }).categories)
    : [];
  return raw.filter(isNodeCardCategory);
}

/** 我方派给某节点的出站单 → (成功率, 平均耗时)。 */
function rateOf(dispatches: NodeDispatchRecord[], nodeId: string): { successRate: number | null; latency: number | null } {
  const settled = dispatches.filter(
    (d) => d.targetNodeId === nodeId && (d.status === 'done' || d.status === 'error'),
  );
  const done = settled.filter((d) => d.status === 'done').length;
  const latencies = settled.map((d) => d.durationMs).filter((v): v is number => v != null);
  return {
    successRate: settled.length >= MIN_RATE_SAMPLES ? done / settled.length : null,
    latency: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
  };
}

function atCapacityOf(online: boolean, freeSlots: number | null, running: number | null, limit: number | null): boolean {
  if (!online) return false;
  if (freeSlots != null) return freeSlots <= 0;
  if (running != null && limit != null && limit > 0) return running >= limit;
  return false;
}

/**
 * 把「ANS 台账 + 本机实时计数 + 出站台账」合成一屏集群视图。
 *
 * 排序：本机置顶 → 在线优先 → 名字（同组内稳定）。
 * 本机行若不在台账里（未注册/被人删了）⇒ 用 `localName`/`localRole` **合成一行**，别让面板把本机弄丢。
 */
export function buildClusterView(input: {
  nodes: AnsNode[];
  localNodeId: string;
  localName: string;
  localRole: NodeRole;
  local: { running: number; queued: number };
  dispatches: NodeDispatchRecord[];
  localTier: LicenseTier;
  nowMs: number;
  error?: string;
}): ClusterView {
  const rows: ClusterNode[] = [];
  let sawLocal = false;

  for (const n of input.nodes) {
    const isLocal = n.node_id === input.localNodeId;
    if (isLocal) sawLocal = true;
    const s = statusOf(n);
    const online = isOnline(n, input.nowMs);
    const limit = num(s.machine_limit);
    const envRunning = num(s.running_tasks);
    const running = isLocal ? input.local.running : envRunning;
    const freeSlots = isLocal && limit != null && limit > 0
      ? Math.max(0, limit - input.local.running)
      : num(s.free_slots);
    const { successRate, latency } = rateOf(input.dispatches, n.node_id);
    rows.push({
      id: n.node_id,
      name: n.name || n.node_id.slice(0, 8),
      role: n.role,
      online,
      local: isLocal,
      tier: isLocal ? input.localTier : null,
      capabilities: capabilitiesOf(n),
      freeSlots,
      cpu: num(s.cpu_usage_percent),
      mem: ratio(num(s.free_mem), num(s.total_mem)),
      disk: ratio(num(s.disk_free), num(s.disk_total)),
      successRate,
      latency,
      running,
      queued: isLocal ? input.local.queued : queuedTo(input.dispatches, n.node_id),
      atCapacity: atCapacityOf(online, freeSlots, running, limit),
    });
  }

  if (!sawLocal) {
    rows.push({
      id: input.localNodeId,
      name: input.localName || input.localNodeId.slice(0, 8),
      role: input.localRole,
      online: true,
      local: true,
      tier: input.localTier,
      capabilities: [],
      freeSlots: null,
      cpu: null,
      mem: null,
      disk: null,
      successRate: null,
      latency: null,
      running: input.local.running,
      queued: input.local.queued,
      atCapacity: false,
    });
  }

  rows.sort((a, b) => Number(b.local) - Number(a.local) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  const totals: ClusterTotals = {
    online: rows.filter((r) => r.online).length,
    running: rows.reduce((sum, r) => sum + (r.online ? (r.running ?? 0) : 0), 0),
    queued: rows.reduce((sum, r) => sum + r.queued, 0),
    offline: rows.filter((r) => !r.online).length,
    atCapacity: rows.filter((r) => r.atCapacity).length,
  };

  return {
    nodes: rows,
    totals,
    bottlenecks: bottleneckText(totals, rows),
    ...(input.error ? { error: input.error } : {}),
  };
}

function isOnline(node: AnsNode, nowMs: number): boolean {
  return isNodeOnline(node.last_seen_at, nowMs);
}

/** 我方派给它、还没收口的单数（`pending` 即"对方还没回"）。 */
function queuedTo(dispatches: NodeDispatchRecord[], nodeId: string): number {
  return dispatches.filter((d) => d.targetNodeId === nodeId && d.status === 'pending').length;
}

/**
 * 瓶颈一句话——**当且仅当**有满载或有排队。没堵就给空列表，别为了"有话说"编一句。
 * 「排队但还有空闲节点」也照实说（用户要知道是排着还是堵死）。
 */
function bottleneckText(totals: ClusterTotals, rows: ClusterNode[]): string[] {
  const out: string[] = [];
  if (totals.atCapacity > 0) out.push(`${totals.atCapacity} 台在线节点已满载`);
  if (totals.queued > 0) {
    const freeOnline = rows.filter((r) => r.online && (r.freeSlots == null ? false : r.freeSlots > 0)).length;
    out.push(freeOnline > 0 ? `${totals.queued} 单在排队，${freeOnline} 台空闲节点可接` : `${totals.queued} 单在排队，但没有空闲节点可接`);
  }
  return out;
}

/** 本机实时计数（running＝正占槽位的任务；queued＝等待执行的任务）。读不到 ⇒ 0（面板不因一张表缺而空）。 */
export interface ClusterCountDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export function readLocalClusterCounts(db: ClusterCountDb): { running: number; queued: number } {
  const count = (sql: string, ...args: unknown[]): number => {
    try {
      const row = db.prepare(sql).get(...args) as { c?: unknown } | undefined;
      return typeof row?.c === 'number' ? row.c : 0;
    } catch {
      return 0;
    }
  };
  return {
    running: count("SELECT COUNT(*) AS c FROM wa_tasks WHERE status IN ('executing','preparing','planning')"),
    queued: count("SELECT COUNT(*) AS c FROM wa_tasks WHERE status = 'pending'"),
  };
}
