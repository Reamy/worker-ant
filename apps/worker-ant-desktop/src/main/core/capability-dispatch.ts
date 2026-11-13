/**
 * zx_20261106_3 B4「协」（孙子·知彼知己 / 道德经·知止）: **能力优先派发**的决策纯函数。
 *
 * 病根：溢出模式只会问"本机跑得过来吗"——某件子任务明明在某台他机上匹配度更高，
 *   只要本机还有空位，它就永远留在本机。本模块给"该不该交出去、交给谁、为什么"一处裁定。
 *
 * 三条判据（次序即优先级）：
 *   ① 模式必须归一为 `capability`（`off`/`overflow` 一律不在此决策，各走各的路，不交叉）；
 *   ② 对端须 `beatsLocal(peer, local, 0.12)`——只强一点点不折腾（防 ping-pong）；
 *   ③ 同任务累计外派 < 2 次、对端不在 30 分钟冷却内、每拍 ≤ 3 件，按 margin 降序取。
 *
 * 对话形态 / 判不出类目（`requirements.categories` 空）**永不外派**——没有能力要求就没有匹配可言。
 *
 * ⚠ 纯函数、零 IO / 零时钟：ready/local/peers/attempts/cooldown/now 由调用方查好再喂。
 */
import { isNodeCardCategory, isNodeOnline, type AnsNode, type NodeCardCategory } from '@worker-ant/shared-types';
import { DEVICE_KIND_CLASSES, type DeviceKindClass } from './device-kind.js';
import { normalizeOrchestrateMode, type OrchestrateMode } from './node-orchestrate.js';
import { beatsLocal, matchNode, type NodeMatchProfile, type NodeReliability, type NodeResources } from './node-match.js';
import type { DispatchRequirements } from './task-capability.js';
import { sanitizeClassRunning, type ClassRunning } from './node-class-load.js';

/** 对端须比本机高出这么多分才值得把活交出去（与 `beatsLocal` 缺省同一把尺）。 */
export const CAPABILITY_MARGIN = 0.12;
/** 每拍最多外派的件数（知止：不一拍把整批都推出去）。 */
export const CAPABILITY_MAX_PER_TICK = 3;
/** 同一任务累计最多外派几次（首派 + 一次改派；超限交回失败收口，不再 ping-pong）。 */
export const CAPABILITY_MAX_ATTEMPTS = 2;
/** 派发失败后该对端的冷却时长——30 分钟内不再往它身上派。 */
export const PEER_COOLDOWN_MS = 30 * 60_000;

/** 就绪件 + 已解析的能力需求（`requirementsForTask` 的产物；调用方负责洗值）。 */
export interface CapabilityReadyTask {
  id: string;
  title?: string;
  requirements: DispatchRequirements;
}

export interface CapabilityDispatchDecision {
  taskId: string;
  peerNodeId: string;
  /** 派给 ANS 的类目（取任务要求的第一个对端也具备的类目）。 */
  category: NodeCardCategory;
  peerScore: number;
  localScore: number;
  margin: number;
  /** 直接可上屏的人话理由。 */
  reason: string;
}

export interface PlanCapabilityDispatchInput {
  mode: OrchestrateMode | string;
  ready: CapabilityReadyTask[];
  local: NodeMatchProfile;
  peers: NodeMatchProfile[];
  /** taskId → 已外派次数（真源＝`context_json.remote_attempts` 的条数）。 */
  attempts: Map<string, number>;
  /** peerNodeId → 冷却截止时刻（epoch ms）；缺省视为无冷却。 */
  cooldownUntil: Map<string, number>;
  now: number;
  maxPerTick?: number;
}

/**
 * 本拍能力优先派发决策（按 margin 降序，最多 `maxPerTick` 件）。
 * 调用方据它逐件 `dispatchNodeRequest({ targetNodeId, requireTarget: true })`。
 */
export function planCapabilityDispatch(input: PlanCapabilityDispatchInput): CapabilityDispatchDecision[] {
  if (normalizeOrchestrateMode(input.mode) !== 'capability') return [];
  const max = input.maxPerTick ?? CAPABILITY_MAX_PER_TICK;
  if (max <= 0) return [];

  const localId = input.local.nodeId;
  const decisions: Array<CapabilityDispatchDecision & { order: number }> = [];

  input.ready.forEach((task, order) => {
    const req = task.requirements;
    // 对话/判不出 ⇒ 空类目 ⇒ 没有能力要求，不外派（不猜一个类目硬派）。
    if (!req || req.categories.length === 0) return;
    if ((input.attempts.get(task.id) ?? 0) >= CAPABILITY_MAX_ATTEMPTS) return;

    const localResult = matchNode(input.local, req);
    let best: { peer: NodeMatchProfile; result: ReturnType<typeof matchNode>; margin: number } | null = null;

    for (const peer of input.peers) {
      if (peer.nodeId === localId) continue;
      const until = input.cooldownUntil.get(peer.nodeId);
      if (until !== undefined && until > input.now) continue;
      const result = matchNode(peer, req);
      if (!beatsLocal(result, localResult, CAPABILITY_MARGIN)) continue;
      const margin = result.score - localResult.score;
      if (!best || margin > best.margin) best = { peer, result, margin };
    }
    if (!best) return;

    // 类目：优先取任务要求里**该对端也具备**的第一个（两把尺同源于卡）；都不具备时 `beatsLocal`
    //   早已因缺类目否决，故此处兜底只取第一个，不会把缺类目的派出去。
    const category = req.categories.find((c) => best!.peer.categories.includes(c)) ?? req.categories[0]!;

    decisions.push({
      taskId: task.id,
      peerNodeId: best.peer.nodeId,
      category,
      peerScore: best.result.score,
      localScore: localResult.score,
      margin: best.margin,
      reason: `能力更匹配 ${best.peer.nodeId}（${best.margin.toFixed(2)}）：对端 ${best.result.reason}｜本机 ${localResult.reason}`,
      order,
    });
  });

  return decisions
    .sort((a, b) => b.margin - a.margin || a.order - b.order)
    .slice(0, max)
    .map(({ order: _order, ...d }) => d);
}

// ==================== 台账 → 匹配画像（纯映射，供编排器与 rr 共用） ====================

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 卡上的类目（坏值/未声明 ⇒ `[]`，不伪装成什么都能干）。 */
export function cardCategoriesOf(card: Record<string, unknown> | null | undefined): NodeCardCategory[] {
  const raw = asRecord(card).categories;
  return Array.isArray(raw) ? raw.filter(isNodeCardCategory) : [];
}

/** 卡上的意图 id（`card.intents` 为 `{id,label}[]`；坏形状丢弃）。 */
export function cardIntentsOf(card: Record<string, unknown> | null | undefined): string[] {
  const raw = asRecord(card).intents;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) => asRecord(i).id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

/** 卡上的设备类目（只认 `DEVICE_KIND_CLASSES` 且排除 `unknown`——与节点卡上送同一词表）。 */
export function cardDeviceClassesOf(card: Record<string, unknown> | null | undefined): DeviceKindClass[] {
  const raw = asRecord(card).device_categories;
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<string>(DEVICE_KIND_CLASSES.filter((c) => c !== 'unknown'));
  return raw
    .map((d) => asRecord(d).class)
    .filter((c): c is DeviceKindClass => typeof c === 'string' && allowed.has(c));
}

/** B5：卡上公示的岗位 id（`card.positions` 为 `{id,name,version}[]`；缺/坏 ⇒ `[]`＝未上报或没有）。 */
export function cardPositionIdsOf(card: Record<string, unknown> | null | undefined): string[] {
  const raw = asRecord(card).positions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => asRecord(p).id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
}

/** B5：心跳快照里的六类目在跑数；未上报/坏形 ⇒ `null`（未知，不按全 0 读）。 */
export function classRunningOfStatus(status: Record<string, unknown> | null | undefined): ClassRunning | null {
  return sanitizeClassRunning(asRecord(status).class_running);
}

/** B5：心跳快照里的机器并发上限；取不到/≤0 ⇒ `null`（未知）。 */
export function machineLimitOfStatus(status: Record<string, unknown> | null | undefined): number | null {
  const limit = num(asRecord(status).machine_limit);
  return limit != null && limit > 0 ? limit : null;
}

/** 心跳快照里的余力占比（0..1；取不到 ⇒ `null`——"不知道"不拿 0 冒充满载）。 */
export function freeRatioOfStatus(status: Record<string, unknown> | null | undefined): number | null {
  const s = asRecord(status);
  const limit = num(s.machine_limit);
  const running = num(s.running_tasks);
  const freeSlots = num(s.free_slots);
  if (limit == null || limit <= 0) return null;
  if (freeSlots != null) return Math.max(0, Math.min(1, freeSlots / limit));
  if (running != null) return Math.max(0, Math.min(1, (limit - running) / limit));
  return null;
}

/**
 * zx_20261107_1 B10a：心跳快照 → 资源面（CPU 余量 / 内存余量 / 每核负载）。
 * zx_20261108_1 B1：补磁盘余量——优先读 `disk_spare`（心跳已派生），旧客户端只有
 *   `disk_free/disk_total` 时在同处派生；都取不到 ⇒ `null`（未知不补零）。
 * 本机与对端**同引本函数**（同一把"机器扛不扛得住"的尺）。
 */
export function resourceProfileOfStatus(status: Record<string, unknown> | null | undefined): NodeResources {
  const s = asRecord(status);
  const cpuUsage = num(s.cpu_usage_percent);
  const cpuSpare = cpuUsage == null ? null : Math.max(0, Math.min(1, (100 - cpuUsage) / 100));
  const totalMem = num(s.total_mem);
  const freeMem = num(s.free_mem);
  const memSpare = totalMem != null && totalMem > 0 && freeMem != null
    ? Math.max(0, Math.min(1, freeMem / totalMem))
    : null;
  const load = num(s.load_avg1);
  const cpus = num(s.cpu_count);
  const loadPerCore = load != null && load >= 0 && cpus != null && cpus > 0 ? load / cpus : null;
  const diskSpare = (() => {
    const raw = num(s.disk_spare);
    if (raw != null) return Math.max(0, Math.min(1, raw));
    const free = num(s.disk_free);
    const total = num(s.disk_total);
    return free != null && total != null && total > 0 ? Math.max(0, Math.min(1, free / total)) : null;
  })();
  return { cpuSpare, memSpare, loadPerCore, diskSpare };
}

/** 台账节点 → 匹配画像（`reliability` 由调用方按出站台账算好传入；未知给 `null`）。 */
export function peerProfileOf(
  node: AnsNode,
  nowMs: number,
  reliability: NodeReliability | null,
): NodeMatchProfile {
  const card = node.card ?? null;
  return {
    nodeId: node.node_id,
    isLocal: false,
    online: isNodeOnline(node.last_seen_at, nowMs),
    categories: cardCategoriesOf(card),
    intents: cardIntentsOf(card),
    deviceClasses: cardDeviceClassesOf(card),
    freeRatio: freeRatioOfStatus(node.status),
    weight: typeof node.weight === 'number' && Number.isFinite(node.weight) ? node.weight : 5,
    reliability,
    // B10a：资源面取自**最近一次心跳快照**；从未心跳/缺字段 ⇒ 各项 null（未知，不补零）。
    resources: resourceProfileOfStatus(node.status),
    // B5：岗位公示取卡、类目忙闲与机器上限取心跳快照；缺哪样就哪样未知（不加不减）。
    positions: cardPositionIdsOf(card),
    classRunning: classRunningOfStatus(node.status),
    machineLimit: machineLimitOfStatus(node.status),
  };
}
