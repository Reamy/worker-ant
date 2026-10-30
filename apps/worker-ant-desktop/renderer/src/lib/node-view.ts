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
import { NODE_OFFLINE_SEC, canDispatch, isNodeCardCategory, isNodeRole, type AnsNode, type NodeCardCategory, type NodeRole } from '../../../../../packages/shared-types/src/nodes.js';
import { parseDbTime } from './deliverable-view';
// zx_20261011_4 M3: 在线判据的实现已上移共享真源（main 侧编排预查与面板 D2 **同一把尺**）——
//   此处**转出**（re-export）以保持 `PeersPage` 的 `from '../lib/node-view'` 取数口不变（一处实现）。
export { isNodeOnline } from '../../../../../packages/shared-types/src/nodes.js';
// M13 调用记录的形状取自 main 侧真源（`node-call-log.ts`）——仅类型引用，打包期擦除。
import type { NodeCallRecord } from '../../../src/main/core/node-call-log.js';
// zx_20261011 M4 出站记录的形状取自 main 侧真源（`node-dispatch-log.ts`）——仅类型引用，打包期擦除。
import type { NodeDispatchRecord } from '../../../src/main/core/node-dispatch-log.js';
// zx_20261030_1 M4：回执措辞真源（pure、零 IO ⇒ 渲染层可直引；与 `settings-bool.js` 同范式）。
import { receiptNote, type RemoteReceipt } from '../../../src/main/core/node-receipt.js';

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
  /** zx_20261007 M2：机器余力（0–1，三源取严）；不可知 ⇒ null。 */
  capacity_free_ratio: number | null;
  collected_at: string | null;
  /**
   * zx_20261007 M3：**断网缺口起点**（ISO）——本机上报失败期间由心跳捎进载荷（`node-heartbeat.ts`
   * 的 `state.staleSince`）。有值 = "这段数据是陈的，自此刻起就没再更新过"；ANS 存进 `status_json`
   * 后经 `toNode()` 原样回来。**不另存一份**——它只有 `status` 这一个来源。
   */
  stale_since: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** `status` JSON 列 → 展示投影。从未心跳过（`null`）返回 `null`——"没有快照"与"快照全 0"不是一回事。 */
export function readNodeEnv(node: Pick<AnsNode, 'status'>): NodeEnvView | null {
  const s = node.status;
  if (!s || typeof s !== 'object') return null;
  return {
    platform: str(s.platform),
    arch: str(s.arch),
    hostname: str(s.hostname),
    cpu_count: num(s.cpu_count),
    cpu_usage_percent: num(s.cpu_usage_percent),
    load_avg1: num(s.load_avg1),
    total_mem: num(s.total_mem),
    free_mem: num(s.free_mem),
    disk_free: num(s.disk_free),
    disk_total: num(s.disk_total),
    jobs_running: num(s.jobs_running),
    machine_limit: num(s.machine_limit),
    running_tasks: num(s.running_tasks),
    free_slots: num(s.free_slots),
    concurrency_default: num(s.concurrency_default),
    dispatch_fill_ratio: num(s.dispatch_fill_ratio),
    slot_fill_ratio: num(s.slot_fill_ratio),
    capacity_free_ratio: num(s.capacity_free_ratio),
    collected_at: str(s.collected_at) || null,
    stale_since: str(s.stale_since) || null,
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
 * zx_20261011_4 M4: 一件"已外派"子任务的**展示形状**（renderer 侧镜像）——由 main 的
 *   `tasks:children` 投影而来（键名/判据真源＝`core/node-orchestrate.ts` 的 `remoteTaskView`）。
 *   只留上屏用得到的字段；未回传时 `summary=''`（**不把"没回传"伪造成有值**）。
 */
export interface RemoteTaskBadge {
  nodeId: string;
  requestId: string;
  assignedAt: string;
  /** zx_20261030_1 M4：远端回传原样（含 `receipt`）；未回传 ⇒ `null`。 */
  result?: Record<string, unknown> | null;
  summary: string;
  resultAt: string;
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
  assign: Pick<RemoteTaskBadge, 'nodeId'> | null | undefined,
  localStatus: string,
  nameOf?: (nodeId: string) => string,
): string {
  if (!assign || !assign.nodeId) return '';
  const id = assign.nodeId;
  const name = (nameOf?.(id) ?? '').trim() || id.slice(0, 8);
  const phase = localStatus === 'completed' ? '完成' : localStatus === 'failed' ? '失败' : '等待';
  return `已外派给 ${name} · ${phase}`;
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
