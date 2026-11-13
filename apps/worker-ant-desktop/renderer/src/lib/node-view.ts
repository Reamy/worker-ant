/**
 * zx_20261004 M4/M6：协同面板的**展示层词表/换算**——一处，不在页面里手抄。
 *
 * 与 `deliverable-view.ts` / `status-view.ts` 同形（渲染层是词表的第二个落点，落成一处）。
 *
 * ⚠ 在线判据 **不在此处硬编码阈值**：`NODE_OFFLINE_SEC` 从共享真源引（M3「同一把尺」）——
 *   这里再写一个 90 就是第二份尺，ANS 侧改了这边不跟，面板的"在线"与派单侧的"在线"就分了家。
 *   zx_20261011_4 M3: 连**判据本体**（`isNodeOnline`）也随之归共享真源——main 侧编排预查要同引它
 *   （"面板可派的对端"与"编排器愿意派的对端"必须同一把尺）；本模块转出以保取数口不变。
 */
import {
  NODE_CARD_CATEGORIES, NODE_CARD_CATEGORY_LABEL, NODE_OFFLINE_SEC, REMOTE_PROGRESS_STALE_SEC,
  canDispatch, isNodeCardCategory, isNodeRole,
  type AnsNode, type NodeCardCategory, type NodeRequestProgress, type NodeRole,
} from '../../../../../packages/shared-types/src/nodes.js';
import { formatBytes, parseDbTime } from './deliverable-view';
// zx_20261011_4 M3: 在线判据的实现已上移共享真源（main 侧编排预查与面板 D2 **同一把尺**）——
//   此处**转出**（re-export）以保持 `PeersPage` 的 `from '../lib/node-view'` 取数口不变（一处实现）。
export { isNodeOnline } from '../../../../../packages/shared-types/src/nodes.js';
// M13 调用记录的形状取自 main 侧真源（`node-call-log.ts`）——仅类型引用，打包期擦除。
import type { NodeCallRecord } from '../../../src/main/core/node-call-log.js';
// zx_20261011 M4 出站记录的形状取自 main 侧真源（`node-dispatch-log.ts`）——仅类型引用，打包期擦除。
import type { NodeDispatchRecord } from '../../../src/main/core/node-dispatch-log.js';
// zx_20261030_1 M4：回执措辞真源（pure、零 IO ⇒ 渲染层可直引；与 `settings-bool.js` 同范式）。
import { receiptNote, type RemoteReceipt } from '../../../src/main/core/node-receipt.js';
// zx_20261108_1 B2：角色建议的瓶颈人话名与样本下限——与 main 侧**同一处**（无第二份词表/阈值）。
import { BOTTLENECK_LABEL, type AdviceBottleneck } from '../../../src/main/core/node-role-advice.js';
import { MIN_RELIABILITY_SAMPLES, type NodeReliability } from '../../../src/main/core/node-match.js';
// 四源余量快照的形状取自 main 真源（`node-heartbeat.ts`）——仅类型引用，打包期擦除。
import type { NodeCapacityBasis } from '../../../src/main/core/node-heartbeat.js';

/** 一条调用记录的结局 → 人话标签（**一处映射**，行内与徽标共用；枚举取自 `NodeCallRecord['status']` 不手抄）。 */
export const CALL_STATUS_LABEL: Record<NodeCallRecord['status'], string> = {
  // zx_20261030_1 M3：叫停后真停单列一档（不是失败，也不是办成了）。
  pending: '待办中', done: '已完成', error: '失败', cancelled: '已停止',
};

/**
 * zx_20261011 M4: **出站**记录的结局 → 人话标签。与入站的 `CALL_STATUS_LABEL` 刻意分开：
 *   同一个 `pending`，入站是"派给我的、我还没办"，出站是"我派的、对方还没回"——方向相反，
 *   共用一张表就会把"我欠别人"与"别人欠我"说成同一件事（承"同一件事才叫重复"的反面）。
 */
export const DISPATCH_STATUS_LABEL: Record<NodeDispatchRecord['status'], string> = {
  // zx_20261030_1 M3：`cancelled` 单列一档——"叫停后真停"既不是完成，也不是失败（不并入任何一档）。
  pending: '待回', done: '已完成', error: '失败', cancelled: '已停止',
};

/**
 * zx_20261011 M4: 该节点能力卡里的**类目**（收窄后）。卡是 JSON 列、取值须先过 `isNodeCardCategory`
 *   ——与派单侧同源（不在此手抄类目串表）。`CardLine`（展示）与「派活」卡（候选收窄）**同引此函数**。
 */
export function nodeCategories(node: Pick<AnsNode, 'card'>): NodeCardCategory[] {
  const raw = node.card && Array.isArray((node.card as { categories?: unknown }).categories)
    ? ((node.card as { categories: unknown[] }).categories) : [];
  return raw.filter(isNodeCardCategory);
}

/**
 * zx_20261112_1 B5：节点卡上的岗位（只 id/名称/版本）。
 *   `reported=false` ⇒ 旧版心跳没有该字段＝**未上报**（与「已上报但没有岗位」是两件事）。
 *   坏条目逐条丢弃；名称/版本坏的条目也算坏（宁可少报一条，不编岗位）。
 */
export function nodePositions(node: Pick<AnsNode, 'card'>): { reported: boolean; items: Array<{ id: string; name: string; version: number }> } {
  const raw = (node.card as { positions?: unknown } | null | undefined)?.positions;
  if (!Array.isArray(raw)) return { reported: false, items: [] };
  const items: Array<{ id: string; name: string; version: number }> = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : null;
    if (!id || !name || version == null) continue;
    items.push({ id, name, version });
  }
  return { reported: true, items };
}

/**
 * zx_20261112_1 B5：六类目在飞数——**按 `NODE_CARD_CATEGORIES` 顺序**逐类出（不按数值排序，
 * 免得面板次序随手跳动）。无快照/旧快照 ⇒ 每类 `running=null`，面板说「未知」。
 */
export function classLoadView(env: NodeEnvView | null): Array<{ category: NodeCardCategory; label: string; running: number | null }> {
  return NODE_CARD_CATEGORIES.map((category) => ({
    category,
    label: NODE_CARD_CATEGORY_LABEL[category],
    running: env?.class_running?.[category] ?? null,
  }));
}

/** 环境快照的**展示投影**——字段齐全但全部可空（"不知道"不许伪造成 0）。 */
export interface NodeEnvView {
  platform: string;
  arch: string;
  hostname: string;
  cpu_count: number | null;
  cpu_usage_percent: number | null;
  load_avg1: number | null;
  total_mem: number | null;
  free_mem: number | null;
  disk_free: number | null;
  disk_total: number | null;
  /** 作业数（**不是**机器执行槽位数）。 */
  jobs_running: number | null;
  /** 机器并发上限（与执行闸同源）；旧版快照无此字段 ⇒ null。 */
  machine_limit: number | null;
  /** 正占用机器槽位的任务数（`executing/preparing/planning`）；读不到 ⇒ null。 */
  running_tasks: number | null;
  /** 空闲槽位；读不到 ⇒ null。 */
  free_slots: number | null;
  concurrency_default: number | null;
  /** zx_20261007 M2 正名：旧名 `busy_ratio`——语义是"我方派单填充率"，非机器忙闲。 */
  dispatch_fill_ratio: number | null;
  /** zx_20261022_3 批一：机器槽位填充率 = running_tasks / machine_limit（与执行闸同一把尺）。 */
  slot_fill_ratio: number | null;
  /** zx_20261007 M2：机器余力（0–1，四源取严；B1 补磁盘）；不可知 ⇒ null。 */
  capacity_free_ratio: number | null;
  /** zx_20261108_1 B2：四源余量与瓶颈（取严来源）；旧版快照无此字段 ⇒ null（不猜）。 */
  capacity_basis: NodeCapacityBasis | null;
  /** zx_20261108_1 B2：OS 版本（`os.release()`）；旧快照/取不到 ⇒ null。 */
  os_release: string | null;
  /** zx_20261108_1 B2：CPU 型号；旧快照/取不到 ⇒ null。 */
  cpu_model: string | null;
  /** zx_20261108_1 B2：磁盘余量（0–1，可用/总量）；未知 ⇒ null。 */
  disk_spare: number | null;
  collected_at: string | null;
  /**
   * zx_20261007 M3：**断网缺口起点**（ISO）——本机上报失败期间由心跳捎进载荷（`node-heartbeat.ts`
   * 的 `state.staleSince`）。有值 = "这段数据是陈的，自此刻起就没再更新过"；ANS 存进 `status_json`
   * 后经 `toNode()` 原样回来。**不另存一份**——它只有 `status` 这一个来源。
   */
  stale_since: string | null;
  /**
   * zx_20261112_1 B5「衡」：按类目的在飞任务数（六类**齐全**才认；缺/坏 ⇒ `null`＝未上报，
   * 界面须说「未知」，不拿 0 冒充「都闲着」）。
   */
  class_running: Record<NodeCardCategory, number> | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const BOTTLENECKS: readonly AdviceBottleneck[] = ['cpu', 'mem', 'slot', 'disk'];

/** zx_20261112_1 B5：`class_running` 坏值/旧快照 ⇒ `null`（六类缺一即不认，不拿半截当齐全）。 */
function classRunningOf(v: unknown): Record<NodeCardCategory, number> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = {} as Record<NodeCardCategory, number>;
  for (const c of NODE_CARD_CATEGORIES) {
    const n = num(o[c]);
    if (n == null || n < 0) return null;
    out[c] = n;
  }
  return out;
}

/** `capacity_basis` 坏值/旧快照 ⇒ `null`（不抛、不拿半截对象冒充完整四源）。 */
function capacityBasis(v: unknown): NodeCapacityBasis | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const raw = o.bottleneck;
  const bottleneck = typeof raw === 'string' && (BOTTLENECKS as readonly string[]).includes(raw)
    ? (raw as AdviceBottleneck) : null;
  return { cpu: num(o.cpu), mem: num(o.mem), slot: num(o.slot), disk: num(o.disk), bottleneck };
}

/** `status` JSON 列 → 展示投影。从未心跳过（`null`）返回 `null`——"没有快照"与"快照全 0"不是一回事。 */
export function readNodeEnv(node: Pick<AnsNode, 'status'>): NodeEnvView | null {
  const s = node.status;
  if (!s || typeof s !== 'object') return null;
  return {
    platform: str(s.platform),
    arch: str(s.arch),
    hostname: str(s.hostname),
    os_release: str(s.os_release) || null,
    cpu_model: str(s.cpu_model) || null,
    cpu_count: num(s.cpu_count),
    cpu_usage_percent: num(s.cpu_usage_percent),
    load_avg1: num(s.load_avg1),
    total_mem: num(s.total_mem),
    free_mem: num(s.free_mem),
    disk_free: num(s.disk_free),
    disk_total: num(s.disk_total),
    disk_spare: num(s.disk_spare),
    jobs_running: num(s.jobs_running),
    machine_limit: num(s.machine_limit),
    running_tasks: num(s.running_tasks),
    free_slots: num(s.free_slots),
    concurrency_default: num(s.concurrency_default),
    dispatch_fill_ratio: num(s.dispatch_fill_ratio),
    slot_fill_ratio: num(s.slot_fill_ratio),
    capacity_free_ratio: num(s.capacity_free_ratio),
    capacity_basis: capacityBasis(s.capacity_basis),
    collected_at: str(s.collected_at) || null,
    stale_since: str(s.stale_since) || null,
    class_running: classRunningOf(s.class_running),
  };
}

/**
 * zx_20261011_3（老子·知止）: 「可否把这一行移出协同网络」的**唯一判据**——**只删他机 ∧ 离线**。
 *
 * 两条否定各有理由，不是一个数的正反面：
 *   - **本机不删**：删自己 = 退出协同网络（会吊销自己的凭据），与"清理他机"是两件事；
 *   - **在线不删**：对方仍在网，删了下一拍即回，且删完对方立刻大面积 401，语义混乱。
 * 收成**具名纯函数**（而非页面里内联的 `!local && !online`）：门槛类判据须能拿"该命中/不该命中"两只
 * 标本直跑（本机在线/本机离线/他机在线/他机离线，四格穷举——见 rr）。
 */
export function canRemovePeer(local: boolean, online: boolean): boolean {
  return !local && !online;
}

/**
 * zx_20261017_1 批四（毛选·谁是我们的敌人）: 「这一行能不能改档」的**唯一判据**——界面不内联。
 *
 * 与 ANS 侧 PATCH 权限**同义**（改他机须 `canDispatch`：primary/observer；worker 只接不分）：
 *   - **本机行**恒可编（自己的机器自己说了算，worker 也不例外）；
 *   - 他机行须本机 `canDispatch`；本机角色未知（`null`/非法）⇒ 不可编（**不猜**）。
 * 收成具名纯函数，四格标本（worker/primary × 本机/他机）可直跑——见 rr R-24。
 */
export function canEditNode(
  localRole: NodeRole | null | undefined,
  node: Pick<AnsNode, 'node_id'>,
  localNodeId: string | null,
): boolean {
  if (localNodeId && node.node_id === localNodeId) return true;
  return isNodeRole(localRole) && canDispatch({ role: localRole });
}

/** 秒数 → "多久前" 人话（**一处**，`seenAgo`/`snapshotAgo` 共用；两份格式必有一份漂移）。 */
function agoText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒前`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/** 距最近心跳多久——人话。无记录如实说"从未"。 */
export function seenAgo(lastSeenAt: string | null | undefined, nowMs: number): string {
  const d = parseDbTime(lastSeenAt);
  if (!d) return '从未';
  return agoText((nowMs - d.getTime()) / 1000);
}

/** 快照采集时刻距今多久——人话；无快照如实 `—`（"没有这个时刻"不说成"刚刚"）。 */
export function snapshotAgo(collectedAt: string | null | undefined, nowMs: number): string {
  const d = parseDbTime(collectedAt);
  if (!d) return '—';
  return agoText((nowMs - d.getTime()) / 1000);
}

/**
 * zx_20261007 M3：快照是否**陈旧**——`collected_at` 距今超 `NODE_OFFLINE_SEC`。
 * 阈值**只认共享真源**（与"在线判据"同一把尺）：这里再抄一个 90 就是第二份尺，ANS 侧改了这边不跟，
 * "面板说新鲜"与"派单侧说离线"就分了家。无时刻 ⇒ 不算陈旧（"不知道"不等于"陈旧"）。
 */
export function isSnapshotStale(collectedAt: string | null | undefined, nowMs: number): boolean {
  const d = parseDbTime(collectedAt);
  if (!d) return false;
  return nowMs - d.getTime() > NODE_OFFLINE_SEC * 1000;
}

/**
 * **派单填充**呈现（承 M2 的 `dispatch_fill_ratio`，旧名 `busy_ratio`）：`jobs/concurrency` + 归一化比值。
 * 无快照或分母缺失 ⇒ 如实说"无快照"，不拿 0 冒充"空闲"（0/0 与 0/3 是两回事）。
 */
export function dispatchFillView(env: NodeEnvView | null): { label: string; ratio: number | null } {
  if (!env || env.dispatch_fill_ratio == null) return { label: '无快照', ratio: null };
  const jobs = env.jobs_running ?? 0;
  const denom = env.concurrency_default ?? 0;
  return { label: `${jobs} / ${denom}`, ratio: env.dispatch_fill_ratio };
}

/**
 * zx_20261022_3 批一：**机器槽位**呈现——`running_tasks / machine_limit`，与执行闸同一把尺。
 * 旧版快照没有这两个字段 ⇒ 如实说"旧版快照"，**不**拿作业数冒充槽位（两件事不可混）。
 */
export function slotFillView(env: NodeEnvView | null): { label: string; ratio: number | null } {
  if (!env) return { label: '无快照', ratio: null };
  const running = env.running_tasks;
  const limit = env.machine_limit;
  const ratio = env.slot_fill_ratio ?? (running != null && limit != null && limit > 0 ? running / limit : null);
  if (ratio == null) return { label: '旧版快照', ratio: null };
  return { label: `${running ?? '?'} / ${limit ?? '?'}`, ratio };
}

/** 派单填充比的档位色——表现层的事，不进领域模块。 */
export function fillColor(ratio: number | null): string {
  if (ratio == null) return 'bg-gray-200';
  if (ratio >= 1) return 'bg-red-500';
  if (ratio >= 0.5) return 'bg-amber-500';
  if (ratio > 0) return 'bg-emerald-500';
  return 'bg-gray-300';
}

/**
 * **机器余力**呈现（M2 的 `capacity_free_ratio`）：0–1 → 百分比。不可知 ⇒ 如实"未知"。
 * 与"派单填充"刻意分开：填充答"我派了多少活"，余力答"机器还剩多少力"——两者会背离
 * （我方空闲但机器被别人占满时，填充低而余力也低），合并成一个数就是把两件事说成一件。
 */
export function capacityView(env: NodeEnvView | null): { label: string; ratio: number | null } {
  if (!env || env.capacity_free_ratio == null) return { label: '未知', ratio: null };
  return { label: `${Math.round(env.capacity_free_ratio * 100)}%`, ratio: env.capacity_free_ratio };
}

/** 余力档位色——**余力越低越红**（与填充条反向）。表现层的事，不进领域模块。 */
export function capacityColor(ratio: number | null): string {
  if (ratio == null) return 'bg-gray-200';
  if (ratio <= 0) return 'bg-red-500';
  if (ratio < 0.2) return 'bg-red-500';
  if (ratio < 0.5) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/**
 * zx_20261108_1 B2：**磁盘呈现**——已用/总量 + 可用百分比（总量未知时只报可用% 或"未知"）。
 * 余量优先读新心跳的 `disk_spare`，旧快照则由 `disk_free/disk_total` 派生（同一口径，不另算一份）。
 */
export function diskUsageView(env: NodeEnvView | null): { label: string; ratio: number | null } {
  if (!env) return { label: '未知', ratio: null };
  const total = env.disk_total;
  const free = env.disk_free;
  const spare = env.disk_spare
    ?? (total != null && total > 0 && free != null ? Math.max(0, Math.min(1, free / total)) : null);
  if (total != null && total > 0 && free != null) {
    const used = Math.max(0, total - free);
    return {
      label: `${formatBytes(used)} / ${formatBytes(total)}（可用 ${spare != null ? `${Math.round(spare * 100)}%` : '未知'}）`,
      ratio: spare,
    };
  }
  if (spare != null) return { label: `可用 ${Math.round(spare * 100)}%`, ratio: spare };
  return { label: '未知', ratio: null };
}

/**
 * zx_20261108_1 B2：**余力瓶颈一句话**（取严来源 + 该项余量）——无快照/无瓶颈 ⇒ `null`（不编）。
 * 人话名取自 `node-role-advice.ts` 的单表，与角色建议同词。
 */
export function bottleneckView(env: NodeEnvView | null): string | null {
  const basis = env?.capacity_basis;
  if (!basis || !basis.bottleneck) return null;
  const label = BOTTLENECK_LABEL[basis.bottleneck];
  const value = basis[basis.bottleneck];
  return value != null
    ? `余力瓶颈：${label}（该项余量 ${Math.round(value * 100)}%）`
    : `余力瓶颈：${label}`;
}

/**
 * zx_20261108_1 B2：集群行 → 角色建议用的可靠性画像。
 * 样本数低于派发侧的 `MIN_RELIABILITY_SAMPLES` ⇒ `null`（与 `matchNode` 同一把尺，不拿两三单定生死）。
 */
export function adviceReliabilityOf(
  row: { successRate: number | null; latency: number | null; successSamples: number } | null | undefined,
): NodeReliability | null {
  if (!row || row.successRate == null || row.successSamples < MIN_RELIABILITY_SAMPLES) return null;
  return { successRate: row.successRate, avgLatencyMs: row.latency, samples: row.successSamples };
}

/**
 * zx_20261011_4 M4: 一件"已外派"子任务的**展示形状**（renderer 侧镜像）——由 main 的
 *   `tasks:children` 投影而来（键名/判据真源＝`core/node-orchestrate.ts` 的 `remoteTaskView`）。
 *   只留上屏用得到的字段；未回传时 `summary=''`（**不把"没回传"伪造成有值**）。
 */
export interface RemoteAttemptView {
  nodeId: string;
  requestId: string;
  at: string;
  result: string;
  reason?: string;
}

export interface RemoteTaskBadge {
  nodeId: string;
  requestId: string;
  assignedAt: string;
  /** zx_20261101_2 M4：外派类目与尝试账（首派 + 改派；旧行没有 ⇒ 缺省）。 */
  category?: string;
  attempts?: RemoteAttemptView[];
  /** zx_20261030_1 M4：远端回传原样（含 `receipt`）；未回传 ⇒ `null`。 */
  result?: Record<string, unknown> | null;
  summary: string;
  resultAt: string;
  /** zx_20261104_3 M2：ANS 择机快照（派单理由）；旧行 / ANS 未给 ⇒ `null`。 */
  selection?: Record<string, unknown> | null;
}

/**
 * zx_20261104_3 M2：派单理由的唯一人话——`selection.reason`；没有就明说"ANS 未提供派单理由"。
 *   不拼第二份理由（ANS 是择机真源；桌面只负责如实转述）。
 */
export function selectionReasonOf(selection: Record<string, unknown> | null | undefined): string {
  const r = selection && typeof selection.reason === 'string' ? selection.reason.trim() : '';
  return r || 'ANS 未提供派单理由';
}

/**
 * zx_20261011_4 M4（道德经·知止）: 「这件子任务外派给谁、到哪一步了」的**唯一人话**——
 *   收成具名纯函数（不在页面里内联拼串），可拿标本直跑（本机名/无节点名回落/三相位，见 rr）。
 *
 * ⚠ 相位词取自**本地子任务状态**（远端驱动收口后本地即 `completed`/`failed`）——**不读第二份
 *   "远端请求态"**（承"一个概念，一个值"：否则同一件活有两个相位，必有一处漂）。
 * ⚠ 节点名由既有台账解析（`nameOf`）；取不到 ⇒ 显 nodeId 前 8 位（**不伪造节点名**）。
 */
export function orchestrationLabel(
  assign: Pick<RemoteTaskBadge, 'nodeId' | 'attempts'> | null | undefined,
  localStatus: string,
  nameOf?: (nodeId: string) => string,
): string {
  if (!assign || !assign.nodeId) return '';
  const id = assign.nodeId;
  const name = (nameOf?.(id) ?? '').trim() || id.slice(0, 8);
  const phase = localStatus === 'completed' ? '完成' : localStatus === 'failed' ? '失败' : '等待';
  // zx_20261101_2 M4：有改派史时先说"换过几台"（旧行无账 ⇒ 一字不改）。
  const tries = Array.isArray(assign.attempts) ? assign.attempts.length : 0;
  if (tries > 1) return `已改派 ${tries - 1} 次 · ${phase}`;
  return `已外派给 ${name} · ${phase}`;
}

/** 尝试账的结果词——收一处，面板与下钻共用（未知值原样显示，不编造）。 */
export function remoteAttemptResultWord(result: string): string {
  if (result === 'dispatched') return '已派';
  if (result === 'failed') return '失败';
  if (result === 'done') return '完成';
  if (result === 'cancelled') return '已停';
  if (result === 'timeout') return '超时';
  return result;
}

/**
 * zx_20261101_2 M4: 外派尝试链的人话（`甲·失败 → 乙·已派`）。空账 ⇒ `''`（旧行不显这一行）。
 * ⚠ 节点名取不到 ⇒ 显 nodeId 前 8 位（不伪造节点名）。
 */
export function remoteAttemptsLabel(
  attempts: RemoteAttemptView[] | null | undefined,
  nameOf?: (nodeId: string) => string,
): string {
  if (!Array.isArray(attempts) || attempts.length === 0) return '';
  return attempts
    .map((a) => {
      const name = (nameOf?.(a.nodeId) ?? '').trim() || (a.nodeId || '').slice(0, 8);
      return `${name}·${remoteAttemptResultWord(a.result)}`;
    })
    .join(' → ');
}

/**
 * zx_20261011_4 M4（N5 如实边界）: 远端回传结果的**边界说明**——用户可见文案一处真源（徽标下钻共用）。
 *   远端说完成 ≠ 本机复核过：本机只据远端自报改本地状态，**没有**独立核验其产出。
 */
export const REMOTE_RESULT_CAVEAT = '远端自报完成，本机未复核';

/**
 * zx_20261030_1 M4（维特根斯坦·意义即用法）: 从远端回传里**只读**回执（不可信形状一律当没有）。
 *   回执是 main 侧 `verifyRemoteReceipt` 写的；旧行没有 `receipt` ⇒ `null`，界面回落旧边界话。
 * ⚠ 措辞真源在 `core/node-receipt.ts`（pure、零 IO）——此处只做形状收窄，不另抄一份词表。
 */
export function remoteReceiptOf(result: Record<string, unknown> | null | undefined): RemoteReceipt | null {
  if (!result || typeof result !== 'object') return null;
  const raw = (result as { receipt?: unknown }).receipt;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const verdict = o.verdict;
  if (verdict !== 'verified' && verdict !== 'self-reported' && verdict !== 'failed') return null;
  return {
    verdict,
    missing: Array.isArray(o.missing) ? o.missing.filter((x): x is string => typeof x === 'string') : [],
    outputCount: typeof o.outputCount === 'number' && Number.isFinite(o.outputCount) ? o.outputCount : null,
    checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt : '',
  };
}

/**
 * zx_20261030_1 M4: 远端回传的**回执行**文案（三选一），无回执 ⇒ 回落旧边界话。
 *   ⚠ 「核对通过」也只到回执自洽：措辞不得越过"本机没有独立重跑其产出"这条线。
 */
export function remoteResultNote(result: Record<string, unknown> | null | undefined): string {
  const receipt = remoteReceiptOf(result);
  if (!receipt) return REMOTE_RESULT_CAVEAT;
  return `${receiptNote(receipt)}（只核回执自洽，未重跑其产出）`;
}

// ==================== zx_20261106_3 B5「见」：远端进度上屏 ====================

/**
 * 远端进度是否**已陈**——`at` 距今超 `REMOTE_PROGRESS_STALE_SEC`。
 * 阈值只认共享真源（同 `isSnapshotStale` 的理由：再写一个 120 就是第二把尺）。
 * 无时刻/坏时刻 ⇒ **不算陈旧**（"不知道"不等于"失联"，但调用方也不得把它画成"刚刚"）。
 */
export function isRemoteProgressStale(
  progress: Pick<NodeRequestProgress, 'at'> | null | undefined,
  nowMs: number,
): boolean {
  const d = parseDbTime(progress?.at);
  if (!d) return false;
  return nowMs - d.getTime() > REMOTE_PROGRESS_STALE_SEC * 1000;
}

/** 远端进度的人话投影（`null` = 对端尚未上报——界面须如实说"没有进度"，不得画 0%）。 */
export interface RemoteProgressView {
  /** 第 N 步 / 第 N/M 步（`total` 未知时**不编分母**）。 */
  stepText: string;
  /** 最近一步摘要（对端没说 ⇒ 空串，不编）。 */
  note: string;
  /** 距最近一次上报多久（人话）；坏时刻 ⇒ `—`。 */
  ago: string;
  /** 超过新鲜度阈值 ⇒ true（界面标「可能失联」，停更不装活）。 */
  stale: boolean;
}

export function remoteProgressView(
  progress: NodeRequestProgress | null | undefined,
  nowMs: number,
): RemoteProgressView | null {
  if (!progress) return null;
  const step = Number.isFinite(progress.step) ? Math.max(0, Math.trunc(progress.step)) : 0;
  const total = typeof progress.total === 'number' && Number.isFinite(progress.total) && progress.total > 0
    ? Math.trunc(progress.total) : null;
  const d = parseDbTime(progress.at);
  return {
    stepText: total != null ? `第 ${step}/${total} 步` : `已走 ${step} 步`,
    note: typeof progress.note === 'string' ? progress.note : '',
    ago: d ? agoText((nowMs - d.getTime()) / 1000) : '—',
    stale: isRemoteProgressStale(progress, nowMs),
  };
}

/**
 * 任务列表行「在节点 X 上运行」徽标——**有外派 ∧ 尚未回传**时给；已回传/未外派 ⇒ `null`。
 * 判据读 `context_digest` 的远端键（与 main 侧 `remoteTaskView` 同源键名）；取不到节点名 ⇒
 * 显 nodeId 前 8 位（不伪造节点名）。
 */
export function remoteRunBadgeOf(
  ctx: Record<string, unknown> | null | undefined,
  nameOf?: (nodeId: string) => string,
): { nodeId: string; label: string } | null {
  const o = ctx ?? {};
  const nodeId = typeof o.assigned_node_id === 'string' ? o.assigned_node_id : '';
  if (!nodeId) return null;
  const resultAt = typeof o.remote_result_at === 'string' ? o.remote_result_at : '';
  if (resultAt) return null;
  const name = (nameOf?.(nodeId) ?? '').trim() || nodeId.slice(0, 8);
  return { nodeId, label: `在 ${name} 上运行` };
}
