/**
 * zx_20261107_1 B5「实·通·信」（孙子·不战而屈人之兵 / 毛选·不打无准备之仗）:
 *   **拆解预检**——模板落库之前先问四件事，答不上就**不落半成品**。
 *
 * 病根：拆解只看"模型给了几条模板"，从不问"这些子任务这台机器/这张网跑不跑得了"。
 *   拆出的子任务可能要求本机与他机都没有的设备品类，或者项目每任务预算小到必然触顶——
 *   于是父任务被挂起等一批**永远启动不了**的子任务，用户只看到"卡住"，看不到"卡在哪"。
 *
 * 四态（次序即裁定序，先命中先报）：
 *   ① `no-capable-node`：某条子任务要求的能力，**本机与台账里没有任何节点**具备；
 *   ② `budget-impossible`：项目级每任务 Token 预算**显式**低于本仓最小原型默认（拆出的子任务必在产出前触顶）；
 *   ③ `nodes-offline`：有节点具备该能力，但**全部离线或权重为 0**（"会做"但此刻"派不到"）；
 *   ④ `ok`。
 *
 * **依赖无环不在此判**：兄弟环由 `planSubtasksFromTemplate` 按边逐条丢（既有更强行为，
 *   `rr_zx_20261018_3` B-8 钉着），预检不另造第二把环尺——那会把"能自动化解的互锁"误判成整批拒绝。
 *
 * 三条诚实纪律：
 *   - **未知不装已知**：远端台账没读到（`peersKnown=false`）⇒ 只按本机判覆盖，缺了也**不判死**
 *     （"不知道对端有没有"≠"对端没有"）；
 *   - **能力 ≠ 派发**：覆盖判据走 `capabilityGap`（与 `matchNode` 同一份），但**不看**余力/成功率——
 *     机器"会做"不该因为此刻忙而被预检判成"不会做"；
 *   - **本机永远可执行**：本机权重 0 表示"不参与协同外派"，不表示"本机执行不了"。
 *
 * ⚠ `runPreflight` 是**纯函数**（零 IO / 零时钟）；`collectPreflightInput` 是它唯一的取数口
 *   （读设备台账/节点台账/项目预算），永不抛——取不到就返回 `null`（调用方按"不预检"的旧行为走）。
 */
import type Database from 'better-sqlite3';
import { isNodeOnline, type NodeCardCategory } from '@worker-ant/shared-types';
import type { DeviceKindClass } from './device-kind.js';
import { capabilityGap } from './node-match.js';
import { ARCHETYPE_BUDGETS } from './task-archetype.js';
import type { DispatchPreflightRecord, DispatchRequirements } from './task-capability.js';
import { cardCategoriesOf, cardDeviceClassesOf, cardIntentsOf } from './capability-dispatch.js';
import { deviceCategoryInventory, publicIntents } from './capability-vocabulary.js';
import { deriveNodeCategories } from './node-card.js';
import { listDevices, type DeviceDb } from './device-registry.js';
import { ensureNodeIdentity, type NodeSettingDb } from './node-identity.js';
import { fetchNodes } from './node-list.js';
import type { AccountingDb } from './task-accounting.js';

/**
 * 子任务最小 Token 底：取本仓**最小原型预算**（`ARCHETYPE_BUDGETS` 的最小值），不另造阈值。
 * 子任务各自是一条完整任务（自己解析预算），最小可达者即 `conversation` 的默认——
 * 项目级每任务预算低于它，等于每条子任务都带着一个"必然触顶"的上限出生。
 */
export const MIN_SUBTASK_TOKENS = Math.min(...Object.values(ARCHETYPE_BUDGETS).map((b) => b.tokens));

/** 判预检时的一台节点（只取"具备不具备"三面 + 可用性，不含余力/可靠性——那是派发期的事）。 */
export interface PreflightNodeProfile {
  nodeId: string;
  isLocal: boolean;
  online: boolean;
  /** 权重 ≤0 ⇒ 不参与协同；**本机除外**（本机执行不靠权重）。 */
  weight: number;
  categories: NodeCardCategory[];
  intents: string[];
  deviceClasses: DeviceKindClass[];
}

export interface PreflightSubtask {
  /** 模板序（1-based，只用于点名）。 */
  index: number;
  title: string;
  requirements: DispatchRequirements;
}

export interface PreflightBudget {
  /**
   * 项目级「每任务 Token 预算」的**显式**取值（>0）；`null` = 未显式设置。
   * 只认项目级：任务级预算**不随子任务继承**（子任务 ctx 从零构造），把它算进来就是凭空的约束。
   */
  projectTokens: number | null;
}

/** 预检的**环境输入**（与"要判哪些子任务"分开：后者由模板在现场派生，避免两处各列一遍）。 */
export interface PreflightContext {
  /** 本机 + 台账里的对端（本机必须在册）。 */
  nodes: readonly PreflightNodeProfile[];
  /** 对端台账是否**真读到**（false ⇒ 只按本机判覆盖，"不知道"不冒充"没有"）。 */
  peersKnown: boolean;
  budget: PreflightBudget;
}

export interface PreflightInput extends PreflightContext {
  subtasks: readonly PreflightSubtask[];
}

export interface PreflightResult extends DispatchPreflightRecord {
  /** 判定旁注（如"远端台账未读到，仅按本机判"）；`ok` 时也可能非空——它是披露，不是失败。 */
  notes: string[];
}

function resourceNodeAvailable(n: PreflightNodeProfile): boolean {
  // 本机永远可执行（权重 0 只关协同派发，不关本机跑活）。
  return n.isLocal || (n.online && n.weight > 0);
}

function availabilityNote(n: PreflightNodeProfile): string {
  if (!n.online && n.weight <= 0) return `${n.nodeId}（离线且权重 0）`;
  if (!n.online) return `${n.nodeId}（离线）`;
  return `${n.nodeId}（权重 0）`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** 缺口最少的那台节点（用来把"缺什么"说到最接近的那份上）——同分取先序，结论可复现。 */
function closestGap(nodes: readonly PreflightNodeProfile[], req: DispatchRequirements) {
  let best: { node: PreflightNodeProfile; missing: string[] } | null = null;
  for (const n of nodes) {
    const gap = capabilityGap(n, req);
    if (gap.missing.length === 0) return { node: n, missing: gap.missing };
    if (!best || gap.missing.length < best.missing.length) best = { node: n, missing: gap.missing };
  }
  return best;
}

/**
 * 跑预检。返回的 `verdict==='ok'` 才算过；其余附人话 `reason`（可直接上屏）。
 * `nodes` 为空 ⇒ 无从判定 ⇒ 按 `ok` + 旁注（未知不装已知）。
 */
export function runPreflight(input: PreflightInput): PreflightResult {
  const notes: string[] = [];
  const nodeCount = input.nodes.length;
  const peersKnown = input.peersKnown;
  if (nodeCount === 0) {
    return { verdict: 'ok', peersKnown, nodeCount, notes: ['预检未取到任何节点画像，能力覆盖未判'] };
  }
  if (!peersKnown) notes.push('远端节点台账未读到：能力覆盖只按本机判定，远端是否具备未核');

  // ① 能力覆盖：有没有"会做"的节点。
  for (const s of input.subtasks) {
    const req = s.requirements;
    // 三面全空 ⇒ 没有能力要求（对话/判不出），本机可跑，不判死。
    if (req.categories.length === 0 && req.intents.length === 0 && req.deviceClasses.length === 0) continue;
    const covering = input.nodes.filter((n) => capabilityGap(n, req).missing.length === 0);
    if (covering.length > 0) continue;
    // 远端未知 ⇒ 缺口可能出在对端，不判死（如实记旁注）。
    if (!peersKnown) continue;
    const closest = closestGap(input.nodes, req);
    const missing = closest?.missing.join('、') || '未知项';
    return {
      verdict: 'no-capable-node',
      reason: `子任务「${s.title}」所需能力没有节点具备：缺${missing}（本机与 ${Math.max(0, nodeCount - 1)} 台对端均不具备）`,
      peersKnown,
      nodeCount,
      notes,
    };
  }

  // ② 预算：只对**显式**项目级预算判"不足"；未设置 ⇒ 子任务回落原型默认，不构成拒绝理由。
  const pt = input.budget.projectTokens;
  if (pt != null && pt > 0 && pt < MIN_SUBTASK_TOKENS) {
    return {
      verdict: 'budget-impossible',
      reason: `项目级每任务 Token 预算 ${fmtTokens(pt)} 低于本仓最小原型默认 ${fmtTokens(MIN_SUBTASK_TOKENS)}（conversation）——拆出的子任务会在产出前触顶`,
      peersKnown,
      nodeCount,
      notes,
    };
  }

  // ③ 节点可用：有"会做"的，但全都派不到（离线/不参与协同）。
  for (const s of input.subtasks) {
    const req = s.requirements;
    const covering = input.nodes.filter((n) => capabilityGap(n, req).missing.length === 0);
    if (covering.length === 0) continue; // 已由 ①（或无要求）处置
    if (covering.some(resourceNodeAvailable)) continue;
    return {
      verdict: 'nodes-offline',
      reason: `子任务「${s.title}」所需能力仅 ${covering.map(availabilityNote).join('、')} 具备，但均派不到（离线或权重为 0）`,
      peersKnown,
      nodeCount,
      notes,
    };
  }

  return { verdict: 'ok', peersKnown, nodeCount, notes };
}

/** 预检结果 → 落库记录（去掉旁注：那是给人看的披露，不是判定）。 */
export function toPreflightRecord(r: PreflightResult): DispatchPreflightRecord {
  return {
    verdict: r.verdict,
    ...(r.reason ? { reason: r.reason } : {}),
    peersKnown: r.peersKnown,
    nodeCount: r.nodeCount,
  };
}

/**
 * 取数口：本机画像 + 节点台账 + 项目级预算 → `PreflightContext`。
 * 永不抛；任何一步取不到 ⇒ `null`（调用方按"不预检"的旧行为继续，不阻断拆解）。
 */
export async function collectPreflightContext(
  db: AccountingDb,
  opts: { projectId: string | null | undefined; nowMs?: number },
): Promise<PreflightContext | null> {
  try {
    const localNodeId = ensureNodeIdentity(db as unknown as NodeSettingDb).id;
    const localSummary = peerCapabilitySummaryOfLocal(db);
    const local: PreflightNodeProfile = {
      nodeId: localNodeId,
      isLocal: true,
      online: true,
      // 本机可执行性不靠权重（`resourceNodeAvailable` 对本机恒真）；给中性 5 只为形状完整。
      weight: 5,
      categories: localSummary.categories,
      intents: localSummary.intents,
      deviceClasses: localSummary.deviceClasses,
    };

    const ledger = await fetchNodes(db as unknown as Database.Database, localNodeId);
    const nowMs = opts.nowMs ?? Date.now();
    const peers: PreflightNodeProfile[] = ledger.nodes
      .filter((n) => n.node_id !== localNodeId)
      .map((n) => ({
        nodeId: n.node_id,
        isLocal: false,
        online: isNodeOnline(n.last_seen_at, nowMs),
        weight: typeof n.weight === 'number' && Number.isFinite(n.weight) ? n.weight : 5,
        categories: cardCategoriesOf(n.card ?? null),
        intents: cardIntentsOf(n.card ?? null),
        deviceClasses: cardDeviceClassesOf(n.card ?? null),
      }));

    return {
      nodes: [local, ...peers],
      peersKnown: !ledger.error,
      budget: { projectTokens: projectTokenBudget(db, opts.projectId) },
    };
  } catch {
    return null;
  }
}

/** 本机能力三面（与编排器建本机画像同一处取法）。 */
function peerCapabilitySummaryOfLocal(db: AccountingDb): {
  categories: NodeCardCategory[];
  intents: string[];
  deviceClasses: DeviceKindClass[];
} {
  const devices = listDevices(db as unknown as DeviceDb);
  return {
    categories: deriveNodeCategories(db as unknown as DeviceDb),
    intents: publicIntents().map((i) => i.id),
    deviceClasses: deviceCategoryInventory(devices).map((d) => d.class),
  };
}

/** 项目级「每任务 Token 预算」的显式值；未设/≤0/坏值 ⇒ `null`（≤0 在引擎里等同未设，会被默认值兜底）。 */
function projectTokenBudget(db: AccountingDb, projectId: string | null | undefined): number | null {
  if (!projectId) return null;
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as
      | { context_json?: string | null }
      | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as { budget?: { max_tokens_per_task?: unknown } };
    const n = Number(ctx?.budget?.max_tokens_per_task);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
