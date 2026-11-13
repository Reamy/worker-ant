/**
 * zx_20261017_1 批三（王阳明·知行合一 / 孙子·知彼知己）: **建单即派**——新任务在创建那一刻就交给他机。
 *
 * 病根：`zx_20261011_4` 的跨机编排只在"本机并发占满"时才外派溢出件——一件刚建好、本机闲着的重活
 *   永远留在本机跑。网络里明明有擅长这类活的对端，"建单"与"派活"却是两个互不相识的动作。
 *   本模块把两者接上：建单成功且**确属可外派**（无父/无依赖/无附件/无工作目录/未拆解/形态可路由）时，
 *   预查在线对端 → 提交（`require_target: true`）→ 记三键 → 由 `node-dispatcher` 留审计痕。
 *
 * ⚠ **三态（zx_20261029_2 M7）**：设置 `node.auto_dispatch_on_create` 显式 `'1'` 开、显式 `'0'` 关；
 *   未配置时跟 Team 许可 + 入网（团队版已解锁且已入网 ⇒ 开），近似真值一律当关。
 *   缺省开**仅在满负荷时溢出**（`local-capacity`）——本机跑得动就先在本机跑，不替用户把活推走。
 * ⚠ **不猜**：任何一项准入不满足即**不外派**，并回**机器可读理由**（界面据此说人话）；不确定就留在本机。
 * ⚠ 失败**不阻断建单**：外派只是这一件事的分流，建单是用户的主动作——`dispatchCreatedTask` 永不抛。
 * ⚠ 本模块**不触网**：台账读取与派发 IO 皆可注入（真机＝`fetchNodes` / `makeAnsDispatchIo`；回归喂假）。
 */
import type Database from 'better-sqlite3';
import { NODE_SETTING_KEYS, ensureNodeIdentity, readNodeSetting, writeNodeSetting, type NodeSettingDb } from './node-identity.js';
import { isNodeEnrolled } from './node-heartbeat.js';
import { teamFeatureRefusal } from './team-gate.js';
import type { LicenseSettingDb } from './license.js';
import { dispatchNodeRequest, type DispatchEventSink, type DispatchIo } from './node-dispatcher.js';
import { readProjectDispatchModeRaw } from './project-dispatch-mode.js';
import {
  markRemoteAssigned,
  remoteAssignOf,
  isRemoteOffered,
  markRemoteOffered,
  clearRemoteOffered,
  type OrchestrateDb,
} from './node-orchestrate.js';
import { fetchNodes, listDispatchablePeers, type NodeLedger } from './node-list.js';
import {
  buildDispatchPolicy,
  projectHasNodePolicy,
  toWireDispatchPolicy,
  type ProjectNodePolicyDb,
} from './project-node-policy.js';
import { NODE_ROLE_LABEL, isNodeRole, type NodeCardCategory, type NodeRole } from '@worker-ant/shared-types';
import { type DepState, parseDepIds } from './dep-graph.js';
import {
  countMachineRunning,
  resolveMachineConcurrencyLimit,
  resolveProjectConcurrency,
  type AccountingDb,
} from './task-accounting.js';
import { taskDepState } from './task-dep-gate.js';
import { routeCategoryForTask } from './task-routing.js';
import { getPosition, positionDispatchSummary, type DispatchPosition, type PositionDb } from './positions.js';
import { statusWord } from './task-notice.js';
import { UPSTREAM_MAX_CHARS, UPSTREAM_MAX_ITEMS, type UpstreamSummaryItem } from './exec-prelude.js';
import { createLogger } from './logger.js';

const logger = createLogger('collab-dispatch');

/**
 * 建单即派的设置键——**一处真源**（键名本体仍在 `NODE_SETTING_KEYS`，此处只导出带语义的别名，
 *   免调用方各自手抄字面量）。默认关：只认 `'1'`。
 */
export const AUTO_DISPATCH_SETTING_KEY = NODE_SETTING_KEYS.autoDispatchOnCreate;

/**
 * 开关的三态（zx_20261029_2 M7）：显式 `'1'` 开、显式 `'0'` 关、**未配置**时跟随许可与入网——
 *   团队版已解锁 ∧ 本机已入网 ⇒ 默认开；社区/Pro 或未入网 ⇒ 默认关。
 *
 * 为何缺省不再是"关"：多机协同是 Team 档**买来**的能力，买了却要用户先去设置里找开关才生效，
 *   等于"承诺的没兑现"。缺省开仍守"不惊扰"——**只在满负荷时溢出**（`localHasFreeSlot`），
 *   本机跑得过来就一件都不外派。
 *
 * ⚠ 近似真值（`'true'`/`'on'`/空白以外的任意串）**一律按关**，不因为"看起来像开"就开——
 *   写坏的值不该悄悄改变行为；空串视同未配置（历史写入口可能落空串）。
 */
export interface AutoDispatchPolicyFacts {
  /** 设置原值（`null` = 从未配置）。 */
  raw: string | null;
  teamUnlocked: boolean;
  enrolled: boolean;
}

export interface AutoDispatchPolicy {
  enabled: boolean;
  /** `explicit` = 用户显式设过；`default` = 缺省三态（跟随 Team + 入网）。 */
  source: 'explicit' | 'default';
  /** 给界面显示的一句话（说清"为什么开/关"）。 */
  reason: string;
}

export function decideAutoDispatchPolicy(f: AutoDispatchPolicyFacts): AutoDispatchPolicy {
  const raw = f.raw == null ? '' : f.raw.trim();
  if (raw === '1') return { enabled: true, source: 'explicit', reason: '已手动开启' };
  if (raw === '0') return { enabled: false, source: 'explicit', reason: '已手动关闭' };
  if (raw !== '') return { enabled: false, source: 'explicit', reason: `设置值「${raw}」无法识别，按关闭处理` };
  if (!f.teamUnlocked) return { enabled: false, source: 'default', reason: '团队版未解锁——不默认开启多机外派' };
  if (!f.enrolled) return { enabled: false, source: 'default', reason: '本机尚未入网——加入协同网络后默认开启' };
  return { enabled: true, source: 'default', reason: '团队版已解锁且本机已入网——默认开启，仅在本机满负荷时溢出' };
}

/** 从库现读三态（纯判据在 `decideAutoDispatchPolicy`；此处只取事实）。永不抛。 */
export function autoDispatchPolicy(db: NodeSettingDb & LicenseSettingDb): AutoDispatchPolicy {
  let teamUnlocked = false;
  try { teamUnlocked = teamFeatureRefusal(db, 'multi_node') === null; } catch { /* 读不到许可 ⇒ 当锁定 */ }
  let enrolled = false;
  try { enrolled = isNodeEnrolled(db); } catch { /* 读不到设置 ⇒ 当未入网 */ }
  return decideAutoDispatchPolicy({ raw: readNodeSetting(db, AUTO_DISPATCH_SETTING_KEY), teamUnlocked, enrolled });
}

/** 设置是否**生效**（三态合成后的唯一读口）。 */
export function isAutoDispatchOn(db: NodeSettingDb & LicenseSettingDb): boolean {
  return autoDispatchPolicy(db).enabled;
}

/** 一次性引导标记键——键名本体仍在 `NODE_SETTING_KEYS`（只导出语义别名）。 */
export const AUTO_DISPATCH_PROMPTED_KEY = NODE_SETTING_KEYS.autoDispatchPrompted;

/** 是否已问过（**只认显式 `'true'`**；未配置即尚未引导）。 */
export function isAutoDispatchPrompted(db: NodeSettingDb): boolean {
  return readNodeSetting(db, AUTO_DISPATCH_PROMPTED_KEY) === 'true';
}

/** 一次性告知的准入事实——纯函数，供 GUI/IPC 一处判定"该不该说一声"。 */
export interface AutoDispatchPromptFacts {
  /** Team `multi_node` 解锁（真源 `teamFeatureRefusal`）。 */
  teamUnlocked: boolean;
  /** 本机已入网。 */
  enrolled: boolean;
  /** 开关当前是否**生效**。 */
  enabled: boolean;
  /** 开关来由（`autoDispatchPolicy().source`）。缺省按显式对待——旧调用方不被新语义骚扰。 */
  source?: 'explicit' | 'default';
  /** 是否已告知过。 */
  prompted: boolean;
}

/**
 * 是否**应当**说一声（zx_20261029_2 M7：从「询问」改为「告知」）：
 *   Team 已解锁 ∧ 已入网 ∧ 此刻**确由缺省打开** ∧ 尚未告知。
 *
 * ⚠ 语义变了，判据也跟着变——旧口径是"还没开 ⇒ 问要不要开"，新口径是"已经替你开了 ⇒ 告诉你一声、
 *   给你一键关闭"。所以：
 *   - `enabled=false` 不再弹（没有"已开启"可告知，问了也是空话）；
 *   - `source='explicit'` 不再弹（用户自己设过，不是"替你开的"）；
 *   - 社区/Pro 永不弹（没有多机能力）；告知过的不再打扰。
 */
export function shouldPromptAutoDispatch(f: AutoDispatchPromptFacts): boolean {
  return f.teamUnlocked && f.enrolled && f.enabled && (f.source === undefined || f.source === 'default') && !f.prompted;
}

export interface AutoDispatchOnboardingResult {
  ok: boolean;
  reason?: 'team-locked' | 'write-failed';
  enabled: boolean;
  prompted: boolean;
}

/**
 * 落一次「告知」结果（zx_20261029_2 M7：询问 → 告知）：
 *   - `accept=true`（"知道了，保持开启"）⇒ **只记"已告知"，不写开关**。若这里写 `'1'`，
 *     缺省开就被钉成**显式**开，随之解除「满负荷才溢出」这道闸——恰恰是本轮要避免的"把本机跑得动的活推走"。
 *   - `accept=false`（"一键关闭"）⇒ 写 `'0'`（显式关，此后默认三态不再替用户开）。
 *   - Team 未解锁 ⇒ 如实拒（`team-locked`，不假装写上了）。
 * ⚠ 仅写设备**设置键**，不起任何派发；开关真生效仍由 `autoDispatchPolicy`/`isAutoDispatchOn` 一处读取。
 */
export function applyAutoDispatchOnboarding(
  db: NodeSettingDb & LicenseSettingDb,
  accept: boolean,
): AutoDispatchOnboardingResult {
  if (teamFeatureRefusal(db, 'multi_node')) {
    return { ok: false, reason: 'team-locked', enabled: isAutoDispatchOn(db), prompted: isAutoDispatchPrompted(db) };
  }
  const wroteEnabled = accept || writeNodeSetting(db, AUTO_DISPATCH_SETTING_KEY, '0');
  const wrotePrompted = writeNodeSetting(db, AUTO_DISPATCH_PROMPTED_KEY, 'true');
  return {
    ok: wroteEnabled && wrotePrompted,
    ...(wroteEnabled && wrotePrompted ? {} : { reason: 'write-failed' as const }),
    enabled: isAutoDispatchOn(db),
    prompted: isAutoDispatchPrompted(db),
  };
}

/**
 * 父任务状态事实（`zx_20261104_3` M1）：从"有父任务"一刀切，改成**看父任务接不接得住结果**。
 * 只取两项，独立成窄接口：编排侧逐件判时不必组装整份准入事实。
 */
export interface ParentDispatchFacts {
  parentExists?: boolean;
  parentStatus?: string | null;
}

/**
 * 父任务是否**阻止**子任务外派（纯函数）。返回 `null` 即放行。
 *
 * ⚠ 只拦**终态与缺失**：`failed` / `archived` / `completed` 的父任务不会再被唤醒，子任务派出去
 *   也没人接结果；`paused`（等子任务的正常态）、`pending` / `in_progress` / `running` 都放行。
 *   状态读不到（`undefined`）同样放行——"不确定就留在本机"的旧纪律在这里**反过来**：
 *   凭"有父任务"就把活永远钉在本机，才是真正把用户挡在门外。
 */
export function parentDispatchBlock(f: ParentDispatchFacts): CreateDispatchReason | null {
  if (f.parentExists === false) return 'parent-missing';
  const status = typeof f.parentStatus === 'string' ? f.parentStatus.trim() : '';
  if (status === 'failed') return 'parent-failed';
  if (status === 'archived') return 'parent-archived';
  if (status === 'completed') return 'parent-completed';
  return null;
}

/**
 * 准入事实——**由调用方从真实行/设置读取**（纯函数不查库，保证判据可直跑）。
 * 六类排除各自一位，**不合并成一个布尔**：合并后"为什么没派"就说不出来了。
 */
export interface CreateDispatchFacts extends ParentDispatchFacts {
  /** 设置开关**生效**与否（三态合成后的结果；真源 `autoDispatchPolicy`）。 */
  settingOn: boolean;
  /**
   * 开关来由（`autoDispatchPolicy().source`）。**缺省按显式对待**——旧调用方不因本轮新增判据而改变行为。
   * 只有 `'default'`（Team 缺省替用户开）才受「满负荷才溢出」约束：显式开启是用户自己的选择。
   */
  autoDispatchSource?: 'explicit' | 'default';
  /**
   * 本机此刻是否尚有余力（`countMachineRunning < resolveMachineConcurrencyLimit`，
   * 与心跳的 `free_slots` / Peers 页同一真源）。
   * **缺省（无此键）不改变旧行为**：不因此拦外派。含义（zx_20261029_2 M7）：
   * 缺省开时只见「满负荷才溢出」——本机跑得动就先在本机跑。
   */
  localHasFreeSlot?: boolean;
  /** Team `multi_node` 是否解锁（真源 `teamFeatureRefusal`）。 */
  teamUnlocked: boolean;
  /** 本机是否已入网（真源 `isNodeEnrolled`）。 */
  enrolled: boolean;
  /**
   * 父任务**是否还存在**（`false` = 有父 id 但行已不在，结果无处可回）。
   * `undefined` = 无父任务或读不到——**不拦**（交 ANS 侧既有校验，不因一次读失败卡死子任务）。
   */
  parentExists?: boolean;
  /**
   * 父任务当前状态。只有**终态**才拦：`failed` / `archived` / `completed`。
   * `paused` 是等子任务的**正常等待态**（`checkParentTaskAfterChildDone` 只认它和 `pending`），
   * `pending` / `in_progress` / `running` 同理放行——父任务还接得住结果，就没有理由阻止子任务外派。
   */
  parentStatus?: string | null;
  /** 有依赖（依赖链须在本机推进）。 */
  hasDependencies: boolean;
  /**
   * 依赖此刻的可解性（zx_20261023_5 批一）。**缺省时不改变旧行为**：有依赖仍按 `has-dependencies` 拒。
   * 给了就按三态判：`met`/`unresolved` ⇒ 可派；`waiting`/`dead` ⇒ 各自如实拒。
   */
  depState?: DepState;
  /** 有附件（附件落在本机盘上，他机读不到）。 */
  hasAttachments: boolean;
  /**
   * **这个任务**是否需要本机工作目录（zx_20261112_2 B1）。
   * 真源 `taskNeedsLocalWorkspace`：项目有 `working_dir` 时，只有「纯调研且题面无仓库信号」的任务判 `false`。
   * 新调用方传这个；旧调用方只传 `hasWorkingDir` 时按旧语义（项目级）处理，行为不变。
   */
  needsLocalWorkspace?: boolean;
  /**
   * 项目有 `working_dir`（外派节点没有这个本机目录）。
   * @deprecated 旧口径（项目级一刀切）。仅为兼容既有调用方保留；新调用方用 `needsLocalWorkspace`。
   */
  hasWorkingDir?: boolean;
  /** 本次建单触发了模板拆解（拆解后子任务才是工作单元）。 */
  decomposed: boolean;
  /** 任务形态路由出的类目；`null` = 对话/无法归类（不外派）。 */
  category: NodeCardCategory | null;
  /**
   * zx_20261101_2 M3：项目**已登记**节点分工（`wa_project_nodes` 有行）。
   * 显式分工是用户对"交给谁"的直接表达 ⇒ 不受「缺省开时满负荷才溢出」约束（否则登记了也白登记）。
   * 缺省（无此键）不改变旧行为。
   */
  projectTargeted?: boolean;
  /**
   * zx_20261110_1 B3：项目**显式**把 `dispatch_mode` 设成 `off`。
   *   缺省（无此键）不改变旧行为——全局缺省 off 只是"不自动扫拍"，与建单开关是两件事，
   *   据此拦建单会把 Team 档缺省开一并打死（见方案 B3 实施注记）。
   */
  projectDispatchOff?: boolean;
}

export type CreateDispatchReason =
  | 'eligible'
  /** zx_20261110_1 B3：项目显式关闭外派——比全局开关更具体，最先说。 */
  | 'project-mode-off'
  | 'setting-off'
  | 'team-locked'
  | 'not-enrolled'
  /** 父任务行已不存在（结果无处可回）。 */
  | 'parent-missing'
  /** 父任务已失败。 */
  | 'parent-failed'
  /** 父任务已归档（主动弃掉）。 */
  | 'parent-archived'
  /** 父任务已完成。 */
  | 'parent-completed'
  | 'has-dependencies'
  /** 依赖未完成（会自动满足；满足后再派，不是永久拒）。 */
  | 'dependencies-waiting'
  /** 依赖已失败/归档/暂停待人工（不会自动满足）。 */
  | 'dependencies-dead'
  | 'has-attachments'
  | 'has-working-dir'
  | 'decomposed'
  /** 本机尚有余力（缺省开时「满负荷才溢出」；显式开不受此限）。 */
  | 'local-capacity'
  | 'no-category';

export interface CreateDispatchDecision {
  eligible: boolean;
  reason: CreateDispatchReason;
  category: NodeCardCategory | null;
}

/**
 * 准入判据（**纯函数**）。判定顺序固定：开关 → 档位 → 入网 → 六类排除 → 形态。
 * 首个不满足者即理由——用户看到的是**最上游的那道闸**，不是一串后续噪音。
 */
export function decideCreateDispatch(f: CreateDispatchFacts): CreateDispatchDecision {
  const deny = (reason: CreateDispatchReason): CreateDispatchDecision => ({ eligible: false, reason, category: null });
  if (f.projectDispatchOff === true) return deny('project-mode-off');
  if (!f.settingOn) return deny('setting-off');
  if (!f.teamUnlocked) return deny('team-locked');
  if (!f.enrolled) return deny('not-enrolled');
  // zx_20261104_3 M1：不再"有父任务即留本机"——只看父任务接不接得住结果（暂停/进行中照常可派）。
  const parentBlock = parentDispatchBlock(f);
  if (parentBlock) return deny(parentBlock);
  if (f.hasDependencies) {
    // zx_20261023_5 批一：有依赖不等于永不外派——**依赖已满足**的任务和孤儿任务一样可派。
    //   未给 `depState` 的旧调用方保持原样（`has-dependencies`），不因本轮改动而默默放宽。
    if (f.depState === 'waiting') return deny('dependencies-waiting');
    if (f.depState === 'dead') return deny('dependencies-dead');
    if (f.depState === undefined) return deny('has-dependencies');
  }
  if (f.hasAttachments) return deny('has-attachments');
  // zx_20261112_2 B1：「项目有工作目录」一刀切下沉为「这个任务需不需要本机工作目录」。
  //   新调用方给 `needsLocalWorkspace`；只给旧键的调用方按项目级旧语义（逐字节不变）。
  const needsLocal = f.needsLocalWorkspace ?? f.hasWorkingDir;
  if (needsLocal === true) return deny('has-working-dir');
  if (f.decomposed) return deny('decomposed');
  // zx_20261029_2 M7：「缺省开」不等于「无条件外派」——本机还有余力就先在本机跑，满负荷才溢出。
  //   显式开启（用户在设置里自己打的开关）不受此限：那是用户的主动选择，不是我们替他做的默认。
  // zx_20261101_2 M3：**项目里登记了分工**同理——用户点名了「交给哪几台」，就不该再被
  //   「本机闲着」挡回去（否则"指定了也永远留在本机"）。只见于缺省开；显式开本就不受此闸。
  if (f.autoDispatchSource === 'default' && f.localHasFreeSlot === true && f.projectTargeted !== true) {
    return deny('local-capacity');
  }
  if (!f.category) return deny('no-category');
  return { eligible: true, reason: 'eligible', category: f.category };
}

/** 理由 → 人话（界面/回执直接上屏；机器码仍保留在 `reason` 里供程序判定）。 */
export const CREATE_DISPATCH_REASON_LABEL: Record<CreateDispatchReason, string> = {
  eligible: '符合外派条件',
  'project-mode-off': '项目已关闭外派（只在本机跑）',
  'setting-off': '自动外派开关未开',
  'team-locked': 'Team 档未解锁多机协同',
  'not-enrolled': '本机尚未入网',
  'parent-missing': '父任务已不存在（结果无处可回）',
  'parent-failed': '父任务已失败（结果无处可回）',
  'parent-archived': '父任务已归档（结果无处可回）',
  'parent-completed': '父任务已完成（结果无处可回）',
  'has-dependencies': '任务有前置依赖',
  'dependencies-waiting': '前置尚未完成（完成后自动派发）',
  'dependencies-dead': '前置已失败/归档，不会自动解锁',
  'has-attachments': '任务带附件（附件在本机盘上）',
  'has-working-dir': '任务需要本机工作目录（代码类或题面涉及本机仓库/文件）',
  decomposed: '已按模板拆解（工作单元是子任务）',
  'local-capacity': '本机尚有余力（满负荷才溢出到其他节点）',
  'no-category': '任务形态不明确（留在本机）',
};

/**
 * 台账里**在线且能力卡含该类目**的可派对端。
 * 在线/可派判据由 `listDispatchablePeers` 一处给；类目取 `card.categories`（与 ANS `DISPATCHABLE_WHERE`
 *   同一份词表、同一份卡——本地只做"省一趟空提交"的预查，最终选谁仍由 ANS 定）。
 */
export function peersSupportingCategory(
  ledger: NodeLedger,
  category: NodeCardCategory,
  nowMs: number,
): string[] {
  return listDispatchablePeers(ledger, nowMs)
    .filter((n) => {
      const card = n.card;
      const cats = card && typeof card === 'object' ? (card as Record<string, unknown>).categories : undefined;
      return Array.isArray(cats) && cats.includes(category);
    })
    .map((n) => n.node_id);
}

/** 外派结局（**机器可读理由 + 如实计数**）。`attempted` = 真向 ANS 提交过；`ok` = 真落单且三键记上。 */
export interface CreateDispatchOutcome {
  attempted: boolean;
  ok: boolean;
  reason: string;
  /** 成功时的目标节点；未定目标/失败为空。 */
  nodeId?: string;
}

export interface CreatedTaskInput {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

export interface DispatchCreatedTaskOpts {
  /** 台账读取（缺省真实现 `fetchNodes`）；**回归注入假**。 */
  listLedger?: () => Promise<NodeLedger>;
  /** 派发 IO（透传 `dispatchNodeRequest`）；缺省真实现。 */
  io?: DispatchIo;
  /** 事件出口（透传）；缺省 eventBus。 */
  emit?: DispatchEventSink;
  /** 时钟注入（在线判据不依赖真实墙钟）。 */
  nowMs?: number;
  /** 团队许可库（缺省与主库同一份）。 */
  licenseDb?: LicenseSettingDb;
}

/** 读任务 context_json（读不到 ⇒ `undefined`；调用方按"不当作有值"处置）。 */
function readTaskContextJson(db: Database.Database, taskId: string): string | Buffer | null | undefined {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: unknown } | undefined;
    return row?.context_json as string | Buffer | null | undefined;
  } catch {
    return undefined;
  }
}

/** 本次任务是否**已经**外派（三键齐备）——幂等守卫，防同一建单重放再派一次。 */
function alreadyDispatched(db: Database.Database, taskId: string): boolean {
  const ctx = readTaskContextJson(db, taskId);
  return ctx !== undefined && remoteAssignOf(ctx) !== null;
}

/**
 * 项目是否**显式**关闭外派（`wa_projects.context_json.dispatch_mode === 'off'`）。
 * 读不到项目行/坏 JSON ⇒ `false`（不拦，交既有闸与 ANS 侧把关）。
 */
export function projectDispatchOff(db: Database.Database, projectId: string): boolean {
  if (!projectId) return false;
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as
      | { context_json?: unknown }
      | undefined;
    return readProjectDispatchModeRaw(row?.context_json as string | null | undefined) === 'off';
  } catch {
    return false;
  }
}

/** 任务所属项目 id（读不到 ⇒ `''`——空项目即"没有项目分工"）。 */
export function projectIdOfTask(db: Database.Database, taskId: string): string {
  try {
    const row = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id?: unknown } | undefined;
    return String(row?.project_id ?? '');
  } catch {
    return '';
  }
}

/** 组派单提示语：标题 + 描述 + 验收标准（旧对端只认这个键——**保留**其形状，新增键只是补充）。 */
export function buildDispatchPrompt(task: CreatedTaskInput): string {
  const title = String(task.title ?? '').trim();
  const description = String(task.description ?? '').trim();
  const acceptance = String(task.acceptanceCriteria ?? '').trim();
  return [title, description, acceptance ? `验收标准：${acceptance}` : ''].filter(Boolean).join('\n\n');
}

/**
 * zx_20261023_5 批一：跨机任务**随行带上的上游摘要**——本机依赖图不进 ANS（不在那边再造一套 DAG），
 *   只把"这件活的前置做完了什么"带过去，远端执行时由 `exec-prelude` 的上游块渲染。
 *   型式与上限的真源在 `exec-prelude.ts`（读口），此处只借用它的名字，不另立一套。
 */
export type DispatchUpstream = UpstreamSummaryItem;

/** 结构化派单载荷（zx_20261018_1 批一 R-6）：三项**原样**带上，远端据此保真落库。 */
export interface DispatchPayload {
  /** 兼容键——旧对端（`relayTaskTitle` 只读它）照旧可建单。 */
  prompt: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  /** 前置任务摘要（无依赖/读不到 ⇒ 不出现该键）。 */
  upstream?: DispatchUpstream[];
  /**
   * zx_20261112_1 B5：任务点名的岗位（`{id,name,version,summary}`，`summary` ≤600 且**不含知识与经验**）。
   * 未指派岗位/岗位已删 ⇒ 不出现该键（旧载荷形状逐字节不变）。
   */
  position?: DispatchPosition;
}

/**
 * 组派单载荷：`prompt`（兼容）+ `title`/`description`/`acceptance_criteria`（结构化）。
 * ⚠ 三项**不拼接、不加工**——远端要的是"用户写的那句话本身"（验收标准若被塞进描述里，
 *   远端就再也分不出哪是验收、哪是正文；判卷读的正是这个字段）。
 */
export function buildDispatchPayload(
  task: CreatedTaskInput,
  upstream?: readonly DispatchUpstream[],
  position?: DispatchPosition | null,
): DispatchPayload {
  const base: DispatchPayload = {
    prompt: buildDispatchPrompt(task),
    title: String(task.title ?? '').trim(),
    description: String(task.description ?? '').trim(),
    acceptance_criteria: String(task.acceptanceCriteria ?? '').trim(),
  };
  const kept = (upstream ?? []).filter((u) => u && typeof u.id === 'string' && u.id !== '');
  // B5：无岗位 / 无上游时**不出现新键**——旧载荷形状与字节不变。
  return {
    ...base,
    ...(kept.length > 0 ? { upstream: kept.slice(0, UPSTREAM_MAX_ITEMS) } : {}),
    ...(position ? { position } : {}),
  };
}

/**
 * zx_20261112_1 B5：任务指派岗位 → 跨机派单里的 `position` 段（`null`＝未指派/岗位已删/读不到）。
 * 摘要只取说明 + 至多 3 条规范（`positionDispatchSummary`）；**知识/经验不出本机**。
 */
export function dispatchPositionOfTask(db: Database.Database, taskId: string): DispatchPosition | null {
  try {
    const row = db.prepare('SELECT position_id FROM wa_tasks WHERE id = ?').get(taskId) as { position_id?: unknown } | undefined;
    const positionId = String(row?.position_id ?? '').trim();
    if (!positionId) return null;
    const position = getPosition(db as unknown as PositionDb, positionId);
    if (!position) return null;
    return {
      id: position.id,
      name: position.name,
      version: position.version,
      summary: positionDispatchSummary(position),
    };
  } catch {
    return null;
  }
}

/**
 * 读本任务的前置完成摘要（最多 5 条、总字符 ≤ 1200）。**永不抛**：读不到就返回空数组。
 * 摘要来源：`context_json.completion_summary`（既有真源）；已 completed 但无摘要 ⇒ 如实说"无登记摘要"。
 */
export function collectUpstreamSummaries(db: Database.Database, taskId: string): DispatchUpstream[] {
  let depIds: string[];
  try {
    const row = db.prepare('SELECT depends_on FROM wa_tasks WHERE id = ?').get(taskId) as { depends_on?: unknown } | undefined;
    depIds = parseDepIds(row?.depends_on);
  } catch { return []; }
  if (depIds.length === 0) return [];

  const out: DispatchUpstream[] = [];
  let used = 0;
  for (const id of depIds) {
    if (out.length >= UPSTREAM_MAX_ITEMS) break;
    let r: { id?: unknown; title?: unknown; status?: unknown; context_json?: unknown } | undefined;
    try {
      r = db.prepare('SELECT id, title, status, context_json FROM wa_tasks WHERE id = ?').get(id) as typeof r;
    } catch { continue; }
    if (!r) continue;
    let summary = '';
    try {
      const raw = r.context_json;
      const s = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw ?? '');
      if (s) {
        const ctx = JSON.parse(s) as Record<string, unknown>;
        if (typeof ctx.completion_summary === 'string') summary = ctx.completion_summary.trim();
      }
    } catch { /* 坏 context ⇒ 按无摘要处理 */ }
    if (!summary) summary = String(r.status ?? '') === 'completed' ? '已完成（无登记摘要）' : String(r.status ?? '');
    const item: DispatchUpstream = {
      id: String(r.id ?? id),
      title: String(r.title ?? id),
      summary: summary.slice(0, 400),
    };
    const cost = item.title.length + item.summary.length + 8;
    if (used + cost > UPSTREAM_MAX_CHARS) break;
    used += cost;
    out.push(item);
  }
  return out;
}

/**
 * 建单后的外派编排：**判准入 → 预查 → 提交（require_target）→ 记三键**。**永不抛**。
 *
 * 三键只在**真派出且 ANS 回了目标 + 单号**后写（`markRemoteAssigned` 读-改-写整份 context_json，不抹兄弟键）；
 *   任何失败都不写 ⇒ 任务保持本地可跑（建单这件主动作不受影响）。
 * zx_20261018_3 批三：提交**前**落"派单在途"占位（`markRemoteOffered`），任一出路都清——
 *   成功时让位给三键，失败时任务回本地可跑；占位在途期间本机认领路不抢（两阶段见 `node-orchestrate`）。
 */
export async function dispatchCreatedTask(
  db: Database.Database,
  task: CreatedTaskInput,
  facts: CreateDispatchFacts,
  opts: DispatchCreatedTaskOpts = {},
): Promise<CreateDispatchOutcome> {
  // zx_20261101_2 M3：项目分工由库现读（调用方不必逐处记着传）；显式给了以显式为准。
  const projectId = projectIdOfTask(db, task.id);
  const projectTargeted = facts.projectTargeted ?? (projectId !== '' && projectHasNodePolicy(db as unknown as ProjectNodePolicyDb, projectId));
  // zx_20261110_1 B3：项目显式关闭外派 ⇒ 建单这一路也停（调用方无须再记着传）。
  const dispatchOff = facts.projectDispatchOff ?? projectDispatchOff(db, projectId);
  const decision = decideCreateDispatch({ ...facts, projectTargeted, projectDispatchOff: dispatchOff });
  if (!decision.eligible) return { attempted: false, ok: false, reason: decision.reason };
  const category = decision.category!;

  if (alreadyDispatched(db, task.id)) return { attempted: false, ok: false, reason: 'already-dispatched' };

  const nowMs = opts.nowMs ?? Date.now();
  let ledger: NodeLedger;
  try {
    ledger = opts.listLedger
      ? await opts.listLedger()
      : await fetchNodes(db, ensureNodeIdentity(db as unknown as NodeSettingDb).id);
  } catch (e) {
    return { attempted: false, ok: false, reason: `ledger-failed: ${(e as Error)?.message || String(e)}` };
  }
  if (peersSupportingCategory(ledger, category, nowMs).length === 0) {
    return { attempted: false, ok: false, reason: 'no-peer' };
  }

  // zx_20261101_2 M3：有项目分工 ⇒ 把"候选白名单 + 权重倍率"随单交给 ANS（它只收窄/缩放，不重排）。
  //   读不到（旧库缺表/数据坏）⇒ 如实退回既有自动选，**不因一次读失败就把活卡在本机**。
  let policy: ReturnType<typeof buildDispatchPolicy> = null;
  if (projectTargeted) {
    try {
      policy = buildDispatchPolicy(db as unknown as ProjectNodePolicyDb, projectId, category, ledger, nowMs);
    } catch (e) {
      logger.warn({ taskId: task.id, projectId, err: (e as Error)?.message }, '项目分工读取失败，退回按全局自动选');
      policy = null;
    }
  }
  // 已有一单正在派（占位未过期）⇒ 不重复提交（建单重放/双击都会走到这里）。
  if (isRemoteOffered(readTaskContextJson(db, task.id), nowMs)) {
    return { attempted: false, ok: false, reason: 'dispatch-in-flight' };
  }

  // zx_20261018_3 批三：**提交前**先落占位——从这一刻起本机不再认领它（回包前也无从知目标，故只记时刻）。
  const offeredAt = new Date(nowMs).toISOString();
  if (!markRemoteOffered(db as unknown as OrchestrateDb, task.id, offeredAt)) {
    return { attempted: false, ok: false, reason: 'offer-mark-failed' };
  }

  const clearOffer = () => clearRemoteOffered(db as unknown as OrchestrateDb, task.id);
  // zx_20261023_5 批一：依赖已满足的任务，把"前置做完了什么"随单带走——远端没有本机依赖图，
  //   这份摘要是它唯一的上游依据（`exec-prelude` 渲染成上游块）。读不到 ⇒ 空数组，照常派。
  const upstream = collectUpstreamSummaries(db, task.id);
  // B5：指派了岗位 ⇒ 随单带上「岗位名+说明+规范」摘要（≤600，不含知识与经验）；未指派 ⇒ 不出现该键。
  const position = dispatchPositionOfTask(db, task.id);
  let result;
  try {
    result = await dispatchNodeRequest(
      db,
      {
        category,
        payload: { ...buildDispatchPayload(task, upstream, position) },
        requireTarget: true,
        ...(policy ? { policy: toWireDispatchPolicy(policy) } : {}),
      },
      { ...(opts.io ? { io: opts.io } : {}), ...(opts.emit ? { emit: opts.emit } : {}) },
    );
  } catch (e) {
    clearOffer();
    return { attempted: false, ok: false, reason: `dispatch-threw: ${(e as Error)?.message || String(e)}` };
  }
  if (!result.ok) {
    clearOffer();
    return { attempted: true, ok: false, reason: result.note };
  }
  if (!result.targetNodeId || !result.requestId) {
    clearOffer();
    return { attempted: true, ok: false, reason: 'ans-returned-incomplete' };
  }

  const marked = markRemoteAssigned(
    db as unknown as OrchestrateDb,
    task.id,
    { nodeId: result.targetNodeId, requestId: result.requestId },
    undefined,
    // zx_20261101_2 M4：首派即记类目与尝试账（改派要按同一类目选人、要数得清第几次）。
    // zx_20261104_3 M2：连同 ANS 的择机快照一起落 context（任务详情不必再猜"为什么派给它"）。
    { category, selection: result.selection },
  );
  // 三键落定后占位让位（三键在 `remoteBlockOf` 里优先——即便这一清失败也仍按"已派定"拦）。
  clearOffer();
  if (!marked) return { attempted: true, ok: false, reason: 'assign-mark-failed' };
  return { attempted: true, ok: true, reason: '', nodeId: result.targetNodeId };
}

/**
 * zx_20261112_2 B1 M4：把一次派发结局**只合并**进 `context_json.dispatch_decision`。
 *
 * 纪律（工蚁第三次踩过 JSON 列整体覆写的坑）：只覆盖这一个键，兄弟键逐字节保留；
 *   解析失败/空 ⇒ 以 `{ dispatch_decision }` 起新对象并带 `_parse_error`，不假装原内容为空。
 * 纯函数、不改库；写库由 `persistDispatchDecision` 一处做。
 */
export function mergeDispatchDecision(
  rawCtx: unknown,
  decision: { attempted: boolean; ok: boolean; reason: string; nodeId?: string; at: string },
): { json: string; parsed: boolean } {
  const s = rawCtx == null ? '' : Buffer.isBuffer(rawCtx) ? rawCtx.toString('utf-8') : String(rawCtx);
  let obj: Record<string, unknown> = {};
  let parsed = true;
  if (s.trim()) {
    try {
      const o: unknown = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) obj = o as Record<string, unknown>;
      else parsed = false;
    } catch { parsed = false; }
  }
  obj.dispatch_decision = decision;
  if (!parsed) obj._parse_error = true;
  return { json: JSON.stringify(obj), parsed };
}

/** 把派发结局落库（读-合并-写一处；永不抛）。 */
export function persistDispatchDecision(
  db: Database.Database,
  taskId: string,
  outcome: CreateDispatchOutcome,
  atIso = new Date().toISOString(),
): boolean {
  try {
    const raw = readTaskContextJson(db, taskId);
    const { json } = mergeDispatchDecision(raw, {
      attempted: outcome.attempted,
      ok: outcome.ok,
      reason: outcome.reason,
      ...(outcome.nodeId ? { nodeId: outcome.nodeId } : {}),
      at: atIso,
    });
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(json, taskId);
    return true;
  } catch (e) {
    logger.warn({ taskId, err: (e as Error)?.message }, '派发结局落库失败（不影响建单）');
    return false;
  }
}

/** context_json 各形态 → 对象；坏 JSON / 非对象一律 `{}`（不把"读不成"当成有值）。 */
function parseTaskContext(raw: unknown): Record<string, unknown> {
  try {
    const s = raw == null ? '' : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
    const o = s ? JSON.parse(s) : null;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** 行内父任务三列 → 事实；无 `parent_task_id` 即无父（两项皆 `undefined`，判据不拦）。 */
function parentFactsOfRow(parentTaskId: unknown, parentRowId: unknown, parentStatus: unknown): ParentDispatchFacts {
  const pid = String(parentTaskId ?? '').trim();
  if (!pid) return {};
  return parentRowId
    ? { parentExists: true, parentStatus: String(parentStatus ?? '') }
    : { parentExists: false, parentStatus: null };
}

/**
 * 从库现读父任务事实（建单路径用）。读不到库/坏行 ⇒ `{}`（不拦，交 ANS 侧校验）。
 * 与 `buildExistingTaskDispatchFacts` 的 LEFT JOIN 同一判据，只是少取其余列。
 */
export function parentDispatchFacts(db: Database.Database, parentTaskId: unknown): ParentDispatchFacts {
  const pid = String(parentTaskId ?? '').trim();
  if (!pid) return {};
  try {
    const row = db.prepare('SELECT id, status FROM wa_tasks WHERE id = ?').get(pid) as { id?: unknown; status?: unknown } | undefined;
    return row ? { parentExists: true, parentStatus: String(row.status ?? '') } : { parentExists: false, parentStatus: null };
  } catch {
    return {};
  }
}

/**
 * 薄壳：某件任务的父状态是否阻止外派（编排侧逐件判用）。
 * 与 `decideCreateDispatch` **同一判据**（`parentDispatchBlock`），不另写一套 SQL 规则。
 */
export function taskParentDispatchBlock(db: Database.Database, taskId: string): CreateDispatchReason | null {
  try {
    const row = db
      .prepare(
        `SELECT t.parent_task_id AS pid, p.id AS parent_id, p.status AS parent_status
           FROM wa_tasks t LEFT JOIN wa_tasks p ON p.id = t.parent_task_id
          WHERE t.id = ?`,
      )
      .get(taskId) as { pid?: unknown; parent_id?: unknown; parent_status?: unknown } | undefined;
    return parentDispatchBlock(parentFactsOfRow(row?.pid, row?.parent_id, row?.parent_status));
  } catch {
    return null; // 读不到 ⇒ 不拦（外派仍由 ANS 侧把关）
  }
}

/**
 * zx_20261023_5 批一：**已存在的任务**要不要外派——准入事实逐项从真实行/设置读（与建单那路同一把尺
 * `decideCreateDispatch`，不另写一套判据）。
 * `depState` 给的是**此刻**的依赖可解性：`met`/`unresolved` ⇒ 可派；`waiting`/`dead` ⇒ 各自如实拒。
 */
export function buildExistingTaskDispatchFacts(db: Database.Database, taskId: string): CreateDispatchFacts {
  let row:
    | {
      title?: unknown; description?: unknown; acceptance_criteria?: unknown; parent_task_id?: unknown;
      depends_on?: unknown; context_json?: unknown; project_id?: unknown;
      parent_id?: unknown; parent_status?: unknown;
    }
    | undefined;
  try {
    row = db
      .prepare(
        `SELECT t.title, t.description, t.acceptance_criteria, t.parent_task_id, t.depends_on, t.context_json, t.project_id,
                p.id AS parent_id, p.status AS parent_status
           FROM wa_tasks t LEFT JOIN wa_tasks p ON p.id = t.parent_task_id
          WHERE t.id = ?`,
      )
      .get(taskId) as typeof row;
  } catch { row = undefined; }
  const ctx = parseTaskContext(row?.context_json);
  let depState: DepState = 'met';
  try { depState = taskDepState(db, taskId); } catch { /* 读不到依赖 ⇒ 按 met（派发提交前 ANS 侧仍会把关） */ }
  const deps = parseDepIds(row?.depends_on);
  let policy: AutoDispatchPolicy;
  try {
    policy = autoDispatchPolicy(db as unknown as NodeSettingDb & LicenseSettingDb);
  } catch {
    policy = { enabled: false, source: 'explicit', reason: '读不到开关设置，按关闭处理' };
  }
  const category = routeCategoryForTask(row?.title, row?.description);
  const hasAttachments = Array.isArray(ctx.attachments) && ctx.attachments.length > 0;
  return {
    settingOn: policy.enabled,
    autoDispatchSource: policy.source,
    localHasFreeSlot: localHasFreeSlot(db),
    teamUnlocked: teamFeatureRefusal(db as unknown as LicenseSettingDb, 'multi_node') === null,
    enrolled: isNodeEnrolled(db as unknown as NodeSettingDb),
    ...parentFactsOfRow(row?.parent_task_id, row?.parent_id, row?.parent_status),
    hasDependencies: deps.length > 0,
    depState,
    hasAttachments,
    // zx_20261112_2 B1：与建单路同一把尺——任务级而非项目级。
    needsLocalWorkspace: taskNeedsLocalWorkspace({
      projectHasWorkingDir: projectHasWorkingDir(db, String(row?.project_id ?? '')),
      category,
      title: row?.title,
      description: row?.description,
      hasAttachments,
    }),
    decomposed: ctx.auto_decomposed === true,
    category,
    projectTargeted: projectHasNodePolicy(db as unknown as ProjectNodePolicyDb, String(row?.project_id ?? '')),
    // zx_20261110_1 B3：任务详情的「派单理由」与真派同一把尺——项目关了外派也照实说。
    projectDispatchOff: projectDispatchOff(db, String(row?.project_id ?? '')),
  };
}

/** 依赖三态的人话名（视图与协同面板共用一份；机器码仍以 `DepState` 为准）。 */
const DEP_STATE_LABEL: Record<DepState, string> = {
  met: '前置已全部完成',
  waiting: '前置未完成（完成后自动派发）',
  dead: '前置已失败/归档，不会自动解锁',
  unresolved: '前置状态无法解析（按可派处理）',
};

/** 派单理由之一。`key` 供 rr 钉行序，不参与展示。 */
export interface DispatchReasonLine {
  key: 'role' | 'capacity' | 'deps' | 'parent';
  label: string;
  value: string;
}

/** 任务详情「派单理由」视图（zx_20261023_5 批一）。 */
export interface DispatchReasonView {
  eligible: boolean;
  reason: CreateDispatchReason | 'already-dispatched';
  label: string;
  category: NodeCardCategory | null;
  lines: DispatchReasonLine[];
}

/**
 * 任务详情页的「派单理由」三行——**与真派同一把尺**（`decideCreateDispatch`），
 * 不另写一套"界面上看着能派"的判据。
 *   - 角色/权重：本机设置里的身份（未设如实说未设，不假装是 worker）；
 *   - 机器余力：项目并发口径（与调度器同一函数 `resolveProjectConcurrency`）；
 *   - 依赖状态：`taskDepState` 的人话名（无依赖亦如实说）。
 */
export function dispatchReasonForTask(db: Database.Database, taskId: string): DispatchReasonView {
  const facts = buildExistingTaskDispatchFacts(db, taskId);
  const decision = decideCreateDispatch(facts);
  const assigned = alreadyDispatched(db, taskId);

  const roleRaw = readNodeSetting(db, NODE_SETTING_KEYS.role);
  const role: NodeRole | null = isNodeRole(roleRaw) ? roleRaw : null;
  const weight = readNodeSetting(db, NODE_SETTING_KEYS.weight);
  const roleText = role
    ? `${NODE_ROLE_LABEL[role]}${weight ? ` · 权重 ${weight}` : ' · 权重未设'}`
    : '角色未设（按默认权重）';

  let capacity = '项目并发不可读';
  try {
    const row = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id?: unknown } | undefined;
    const c = resolveProjectConcurrency(db as unknown as AccountingDb, String(row?.project_id ?? ''));
    capacity = `本机并发 ${c.running}/${c.limit}（余 ${c.available}）`;
  } catch { /* 读不到并发不改变派单判据，如实回退 */ }

  const depsText = facts.hasDependencies ? DEP_STATE_LABEL[facts.depState ?? 'unresolved'] : '无前置依赖';
  const parentLine = parentReasonLine(db, taskId);

  return {
    eligible: !assigned && decision.eligible,
    reason: assigned ? 'already-dispatched' : decision.reason,
    label: assigned ? '已外派他机执行，本机不再重复派' : CREATE_DISPATCH_REASON_LABEL[decision.reason],
    category: decision.category,
    lines: [
      { key: 'role', label: '角色/权重', value: roleText },
      { key: 'capacity', label: '机器余力', value: capacity },
      { key: 'deps', label: '依赖状态', value: depsText },
      ...(parentLine ? [parentLine] : []),
    ],
  };
}

/**
 * 子任务的「父任务」理由行（zx_20261104_3 M1）：父任务存在即列出标题与状态，
 * 让"为什么派得出去/派不出去"在详情页可核对。无父任务 ⇒ `null`（不加假行）。
 */
function parentReasonLine(db: Database.Database, taskId: string): DispatchReasonLine | null {
  try {
    const row = db
      .prepare(
        `SELECT t.parent_task_id AS pid, p.id AS parent_id, p.title AS parent_title, p.status AS parent_status
           FROM wa_tasks t LEFT JOIN wa_tasks p ON p.id = t.parent_task_id
          WHERE t.id = ?`,
      )
      .get(taskId) as { pid?: unknown; parent_id?: unknown; parent_title?: unknown; parent_status?: unknown } | undefined;
    const pid = String(row?.pid ?? '').trim();
    if (!pid) return null;
    if (!row?.parent_id) return { key: 'parent', label: '父任务', value: '父任务行缺失（不会被唤醒）' };
    const title = String(row?.parent_title ?? '').trim() || pid;
    return { key: 'parent', label: '父任务', value: `${title} · ${statusWord(row?.parent_status)}` };
  } catch {
    return null;
  }
}

/** 协同面板的一件候选任务（只带面板要说的几句话）。 */
export interface DispatchBoardItem {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  reason: string;
  label: string;
}

/** 协同面板三分组读数（`scanned` 为本拍扫过的 pending 件数，供如实计数）。 */
export interface DispatchBoardPayload {
  enabled: boolean;
  eligible: DispatchBoardItem[];
  waiting: DispatchBoardItem[];
  dead: DispatchBoardItem[];
  scanned: number;
}

/**
 * 协同面板的分组视图：本项目/全部项目的 pending 任务，按**同一把尺**分成
 * 「可派 / 等待依赖 / 上游已死」三组；其余"本来就不外派"的理由（有父、附件、工作目录…）
 * 不在此列出——它们是本机工作的常态，不是待办。
 * ⚠ 开关关/档位锁/未入网时 `eligible` 为空：判据本身就是"此刻不能派"，面板不假装能派。
 */
export function dispatchBoard(db: Database.Database, limit = 50): DispatchBoardPayload {
  const out: DispatchBoardPayload = {
    enabled: isAutoDispatchOn(db as unknown as NodeSettingDb & LicenseSettingDb),
    eligible: [],
    waiting: [],
    dead: [],
    scanned: 0,
  };
  let rows: Array<{ id?: unknown; title?: unknown; project_id?: unknown; project_name?: unknown; context_json?: unknown }>;
  try {
    rows = db
      .prepare(
        `SELECT t.id, t.title, t.project_id, p.name AS project_name, t.context_json
           FROM wa_tasks t LEFT JOIN wa_projects p ON p.id = t.project_id
          WHERE t.status = 'pending'
          ORDER BY t.priority DESC, t.created_at ASC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as typeof rows;
  } catch { return out; }

  for (const r of rows) {
    out.scanned++;
    const taskId = String(r.id ?? '');
    if (!taskId) continue;
    if (remoteAssignOf(r.context_json as string | Buffer | null | undefined)) continue; // 已派定/在途 ⇒ 不在候选面
    let facts: CreateDispatchFacts;
    let decision: CreateDispatchDecision;
    try {
      facts = buildExistingTaskDispatchFacts(db, taskId);
      decision = decideCreateDispatch(facts);
    } catch { continue; }
    const depState = facts.hasDependencies ? (facts.depState ?? 'unresolved') : null;
    // 依赖两组按**依赖态本身**分类（开关没开时也看得见"在等谁/谁死了"）；
    //   "可派"仍按同一把尺（判据说能派才算能派，开关关着时这一组恒空，不假装）。
    const group: 'dead' | 'waiting' | 'eligible' | null =
      depState === 'dead' ? 'dead'
        : depState === 'waiting' ? 'waiting'
          : decision.eligible ? 'eligible'
            : null;
    if (!group) continue;
    const label = group === 'dead' ? DEP_STATE_LABEL.dead : group === 'waiting' ? DEP_STATE_LABEL.waiting : CREATE_DISPATCH_REASON_LABEL.eligible;
    const item: DispatchBoardItem = {
      taskId,
      title: String(r.title ?? ''),
      projectId: String(r.project_id ?? ''),
      projectName: String(r.project_name ?? ''),
      reason: decision.reason,
      label,
    };
    out[group].push(item);
  }
  return out;
}

/** 一件依赖任务的外派结局（供 rr 与日志逐件核对）。 */
export interface DependentDispatchResult {
  taskId: string;
  outcome: CreateDispatchOutcome;
}

/**
 * zx_20261023_5 批一（毛选·集中优势兵力）：**上游到站 ⇒ 后继重新走一次派发决策**。
 *
 * 只找"本项目内、仍 pending、`depends_on` 点名了刚完成这件"的任务，逐件问同一把尺：
 *   - `met`（其余前置也都到了）⇒ 允许派；`waiting`/`dead` ⇒ 如实不派（理由随结果返回，不静默）。
 * 幂等由 `dispatchCreatedTask` 自带（已派/在途中/未准入都不重复提交）。**永不抛**。
 *
 * ⚠ 依赖图仍在本机解析：派出去的只是"任务本体 + 上游摘要"，ANS 侧不新增跨机 DAG。
 */
export async function dispatchReadyDependents(
  db: Database.Database,
  completedTaskId: string,
  opts: DispatchCreatedTaskOpts = {},
): Promise<DependentDispatchResult[]> {
  const out: DependentDispatchResult[] = [];
  let rows: Array<{ id?: unknown; title?: unknown; description?: unknown; acceptance_criteria?: unknown; depends_on?: unknown }>;
  try {
    const base = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(completedTaskId) as { project_id?: unknown } | undefined;
    if (!base) return out;
    rows = db
      .prepare(
        "SELECT id, title, description, acceptance_criteria, depends_on FROM wa_tasks WHERE project_id = ? AND status = 'pending' AND depends_on LIKE ?",
      )
      .all(String(base.project_id ?? ''), `%${completedTaskId}%`) as typeof rows;
  } catch { return out; }

  for (const r of rows) {
    const taskId = String(r.id ?? '');
    if (!taskId) continue;
    // LIKE 只是粗筛：真判一律按解析后的 id 列表（不把"含子串"当成依赖）。
    if (!parseDepIds(r.depends_on).includes(completedTaskId)) continue;
    const facts = buildExistingTaskDispatchFacts(db, taskId);
    const decision = decideCreateDispatch(facts);
    if (!decision.eligible) {
      out.push({ taskId, outcome: { attempted: false, ok: false, reason: decision.reason } });
      continue;
    }
    const outcome = await dispatchCreatedTask(
      db,
      {
        id: taskId,
        title: String(r.title ?? ''),
        description: String(r.description ?? ''),
        acceptanceCriteria: String(r.acceptance_criteria ?? ''),
      },
      facts,
      opts,
    );
    if (outcome.ok || outcome.attempted) {
      logger.info({ taskId, completedTaskId, reason: outcome.reason, nodeId: outcome.nodeId }, '上游完成 ⇒ 后继外派决策已执行');
    }
    out.push({ taskId, outcome });
  }
  return out;
}

/**
 * 收口跳上的**唯一触发口**（fire-and-forget）：上游一到终态就调用它，由内部判据决定要不要真派。
 * 开关未开 / 无依赖后继 ⇒ 一次库查询后立即返回，不发任何网络请求。
 * **永不抛**（建单/收尾的调用方不该被一次外派拖垮）。
 */
export function scheduleDependentDispatch(db: Database.Database, completedTaskId: string): void {
  try {
    if (!isAutoDispatchOn(db as unknown as NodeSettingDb & LicenseSettingDb)) return;
    void dispatchReadyDependents(db, completedTaskId).catch((e: unknown) => {
      logger.warn({ completedTaskId, err: (e as Error)?.message }, '后继外派调度失败（不影响已完成任务）');
    });
  } catch (e) {
    logger.warn({ completedTaskId, err: (e as Error)?.message }, '后继外派调度入口异常（已忽略）');
  }
}

/** 最近一次**自动外派**（`requireTarget=true`）的审计投影——面板顶部如实显示"最近一次派去了哪"。 */
export interface LastAutoDispatch {
  at: string;
  nodeId: string;
  requestId: string;
  category: string;
}

export function lastAutoDispatch(db: Database.Database): LastAutoDispatch | null {
  try {
    const row = db
      .prepare(
        `SELECT target_id, detail_json, created_at FROM wa_audit_events
          WHERE action = 'node.dispatch' AND json_extract(detail_json, '$.requireTarget') = 1
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get() as { target_id?: unknown; detail_json?: unknown; created_at?: unknown } | undefined;
    if (!row) return null;
    let detail: Record<string, unknown> = {};
    try {
      const v = JSON.parse(String(row.detail_json ?? '{}'));
      if (v && typeof v === 'object' && !Array.isArray(v)) detail = v as Record<string, unknown>;
    } catch { /* 坏载荷如实回空明细 */ }
    return {
      at: String(row.created_at ?? ''),
      nodeId: String(row.target_id ?? ''),
      requestId: typeof detail.requestId === 'string' ? detail.requestId : '',
      category: typeof detail.category === 'string' ? detail.category : '',
    };
  } catch {
    return null; // 表缺失（旧库/夹具）⇒ 如实无记录，不编一条
  }
}

/** 供 IPC 组准入事实时共用：任务行是否有依赖（`depends_on` 为空/`[]` 即无）。 */
export function taskHasDependencies(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  return s !== '' && s !== '[]';
}

/**
 * 本机此刻是否尚有余力（zx_20261029_2 M7）。**与心跳/Peers 页同一真源**：
 *   `resolveMachineConcurrencyLimit`（机器并发上限）+ `countMachineRunning`（全机运行中任务数），
 *   不另立计数器（否则"界面上看着有余力、判据说没有"）。
 * 读不到 ⇒ 当**有余力**（不在本机跑满就外派是更坏的结果——"不确定就留在本机"，承本模块首注）。
 */
export function localHasFreeSlot(db: Database.Database): boolean {
  try {
    const accounting = db as unknown as AccountingDb;
    const limit = resolveMachineConcurrencyLimit(accounting, {}).limit;
    return countMachineRunning(accounting) < limit;
  } catch {
    return true;
  }
}

/**
 * 题面里出现这些词，就认为任务要**碰本机仓库/文件**——保守：宁可留本机，不把读不到目录的活送出去。
 * 单独成常量，rr 可直引；改词表须同步 `taskNeedsLocalWorkspace` 的两只反例标本。
 */
export const REPO_BOUND_TOKENS: readonly RegExp[] = [
  /代码|仓库|代码库|工程|目录|文件|路径|提交|分支|合并|拉取|推送|依赖|编译|构建|测试|包管理/i,
  /README|package\.json|pull request|\bPR\b|\bgit\b|\bcommit\b|\bpush\b|\bpull\b|\bmerge\b|\bbranch\b|\bbuild\b|\btest\b/i,
];

/**
 * 「**这个任务**」是否需要本机工作目录（纯函数，零 IO）。
 *
 * 病根（zx_20261112_2 B1）：建单派发此前按**项目**一刀切——项目有 `working_dir` 就整项目不外派。
 *   同一项目里「调研向量库选型」这种不碰仓库的活，也被一起钉在本机。
 *
 * 判「不需要」须**同时**满足（先假设需要，只有证据充分才放行）：
 *   ① 项目确实有 `working_dir`（没有则本判据不适用 ⇒ `false`）；
 *   ② 无附件（附件在本机盘上）；
 *   ③ 外派类目是 `research`（`code`/`text`/`project_task`/`media`/`device`/`null` 一律留本机）；
 *   ④ 题面不含任何 `REPO_BOUND_TOKENS`（`分析代码库` 会被判成 research，但它必须读本机仓库）。
 * 任一不满足 ⇒ `true`（留本机）。远端失败/超时仍由 `node-remote-driver` 收回本机重跑。
 */
export function taskNeedsLocalWorkspace(input: {
  projectHasWorkingDir: boolean;
  category: NodeCardCategory | null;
  title?: unknown;
  description?: unknown;
  hasAttachments?: boolean;
}): boolean {
  if (!input.projectHasWorkingDir) return false;
  if (input.hasAttachments === true) return true;
  if (input.category !== 'research') return true;
  const text = `${String(input.title ?? '')} ${String(input.description ?? '')}`;
  return REPO_BOUND_TOKENS.some((re) => re.test(text));
}

/**
 * **建单路径**的准入事实组装（zx_20261112_2 B1）：IPC 与 E2E 共用一处，
 * 不在调用点手拼（手拼两份即两把尺——本轮刚把工作目录判据收成一处）。
 */
export function buildCreatedTaskDispatchFacts(
  db: Database.Database,
  input: {
    taskId: string;
    title: unknown;
    description: unknown;
    parentTaskId?: unknown;
    hasAttachments: boolean;
    decomposed: boolean;
    projectId: string;
  },
): CreateDispatchFacts {
  const policy = autoDispatchPolicy(db as unknown as NodeSettingDb & LicenseSettingDb);
  const category = routeCategoryForTask(input.title, input.description);
  let dependsOn: unknown;
  try {
    dependsOn = (db.prepare('SELECT depends_on FROM wa_tasks WHERE id = ?').get(input.taskId) as { depends_on?: unknown } | undefined)?.depends_on;
  } catch { dependsOn = undefined; }
  return {
    settingOn: policy.enabled,
    autoDispatchSource: policy.source,
    localHasFreeSlot: localHasFreeSlot(db),
    teamUnlocked: teamFeatureRefusal(db as unknown as LicenseSettingDb, 'multi_node') === null,
    enrolled: isNodeEnrolled(db as unknown as NodeSettingDb),
    ...parentDispatchFacts(db, input.parentTaskId),
    hasDependencies: taskHasDependencies(dependsOn),
    hasAttachments: input.hasAttachments,
    needsLocalWorkspace: taskNeedsLocalWorkspace({
      projectHasWorkingDir: projectHasWorkingDir(db, input.projectId),
      category,
      title: input.title,
      description: input.description,
      hasAttachments: input.hasAttachments,
    }),
    decomposed: input.decomposed,
    category,
    projectTargeted: projectHasNodePolicy(db as unknown as ProjectNodePolicyDb, input.projectId),
    projectDispatchOff: projectDispatchOff(db, input.projectId),
  };
}

/** 供 IPC 组准入事实时共用：项目是否指定了本机工作目录。 */
export function projectHasWorkingDir(db: Database.Database, projectId: string): boolean {
  try {
    const row = db.prepare('SELECT working_dir FROM wa_projects WHERE id = ?').get(projectId) as { working_dir?: unknown } | undefined;
    return typeof row?.working_dir === 'string' && row.working_dir.trim() !== '';
  } catch {
    return false; // 读不到 ⇒ 不因此拦（外派仍由 ANS 侧把关）
  }
}
