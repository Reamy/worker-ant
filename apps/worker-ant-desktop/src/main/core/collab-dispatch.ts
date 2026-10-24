/**
 * zx_20261017_1 批三（王阳明·知行合一 / 孙子·知彼知己）: **建单即派**——新任务在创建那一刻就交给他机。
 *
 * 病根：`zx_20261011_4` 的跨机编排只在"本机并发占满"时才外派溢出件——一件刚建好、本机闲着的重活
 *   永远留在本机跑。网络里明明有擅长这类活的对端，"建单"与"派活"却是两个互不相识的动作。
 *   本模块把两者接上：建单成功且**确属可外派**（无父/无依赖/无附件/无工作目录/未拆解/形态可路由）时，
 *   预查在线对端 → 提交（`require_target: true`）→ 记三键 → 由 `node-dispatcher` 留审计痕。
 *
 * ⚠ **默认关**：设置 `node.auto_dispatch_on_create` 只认显式 `'1'`；未配置/其他值一律当关——不惊扰既有行为
 *   （承 `node-orchestrate.readOrchestrateMode` 的默认关口径）。
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
import {
  markRemoteAssigned,
  remoteAssignOf,
  isRemoteOffered,
  markRemoteOffered,
  clearRemoteOffered,
  type OrchestrateDb,
} from './node-orchestrate.js';
import { fetchNodes, listDispatchablePeers, type NodeLedger } from './node-list.js';
import { NODE_ROLE_LABEL, isNodeRole, type NodeCardCategory, type NodeRole } from '@worker-ant/shared-types';
import { type DepState, parseDepIds } from './dep-graph.js';
import { resolveProjectConcurrency, type AccountingDb } from './task-accounting.js';
import { taskDepState } from './task-dep-gate.js';
import { routeCategoryForTask } from './task-routing.js';
import { UPSTREAM_MAX_CHARS, UPSTREAM_MAX_ITEMS, type UpstreamSummaryItem } from './exec-prelude.js';
import { createLogger } from './logger.js';

const logger = createLogger('collab-dispatch');

/**
 * 建单即派的设置键——**一处真源**（键名本体仍在 `NODE_SETTING_KEYS`，此处只导出带语义的别名，
 *   免调用方各自手抄字面量）。默认关：只认 `'1'`。
 */
export const AUTO_DISPATCH_SETTING_KEY = NODE_SETTING_KEYS.autoDispatchOnCreate;

/** 设置是否开启（**只认显式 `'1'`**；未配置/`'0'`/其他值皆关）。 */
export function isAutoDispatchOn(db: NodeSettingDb): boolean {
  return readNodeSetting(db, AUTO_DISPATCH_SETTING_KEY) === '1';
}

/** 一次性引导标记键——键名本体仍在 `NODE_SETTING_KEYS`（只导出语义别名）。 */
export const AUTO_DISPATCH_PROMPTED_KEY = NODE_SETTING_KEYS.autoDispatchPrompted;

/** 是否已问过（**只认显式 `'true'`**；未配置即尚未引导）。 */
export function isAutoDispatchPrompted(db: NodeSettingDb): boolean {
  return readNodeSetting(db, AUTO_DISPATCH_PROMPTED_KEY) === 'true';
}

/** 一次性引导的准入事实——纯函数，供 GUI/IPC 一处判定"该不该问"。 */
export interface AutoDispatchPromptFacts {
  /** Team `multi_node` 解锁（真源 `teamFeatureRefusal`）。 */
  teamUnlocked: boolean;
  /** 本机已入网。 */
  enrolled: boolean;
  /** 开关当前是否已开。 */
  enabled: boolean;
  /** 是否已问过。 */
  prompted: boolean;
}

/**
 * 是否**应当**弹出一次性引导（zx_20261018_1 R-9）：Team 已解锁 ∧ 已入网 ∧ 尚未开启 ∧ 尚未问过。
 * ⚠ 四者缺一不弹：社区/Pro **永不**弹（没有多机能力，问了也没用）；已开启的不打扰；问过的不再问。
 */
export function shouldPromptAutoDispatch(f: AutoDispatchPromptFacts): boolean {
  return f.teamUnlocked && f.enrolled && !f.enabled && !f.prompted;
}

export interface AutoDispatchOnboardingResult {
  ok: boolean;
  reason?: 'team-locked' | 'write-failed';
  enabled: boolean;
  prompted: boolean;
}

/**
 * 落一次引导结果：Team 未解锁 ⇒ 如实拒（`team-locked`，不假装写上了）；
 * 否则写开关（`'1'`/`'0'`）并**无论应否都记"已问过"**（拒绝也是一次回答——不再打扰）。
 * ⚠ 仅写设备**设置键**，不起任何派发；开关真生效仍由 `isAutoDispatchOn` 一处读取。
 */
export function applyAutoDispatchOnboarding(
  db: NodeSettingDb & LicenseSettingDb,
  accept: boolean,
): AutoDispatchOnboardingResult {
  if (teamFeatureRefusal(db, 'multi_node')) {
    return { ok: false, reason: 'team-locked', enabled: isAutoDispatchOn(db), prompted: isAutoDispatchPrompted(db) };
  }
  const wroteEnabled = writeNodeSetting(db, AUTO_DISPATCH_SETTING_KEY, accept ? '1' : '0');
  const wrotePrompted = writeNodeSetting(db, AUTO_DISPATCH_PROMPTED_KEY, 'true');
  return {
    ok: wroteEnabled && wrotePrompted,
    ...(wroteEnabled && wrotePrompted ? {} : { reason: 'write-failed' as const }),
    enabled: isAutoDispatchOn(db),
    prompted: isAutoDispatchPrompted(db),
  };
}

/**
 * 准入事实——**由调用方从真实行/设置读取**（纯函数不查库，保证判据可直跑）。
 * 六类排除各自一位，**不合并成一个布尔**：合并后"为什么没派"就说不出来了。
 */
export interface CreateDispatchFacts {
  /** 设置开关（只认显式 `'1'`）。 */
  settingOn: boolean;
  /** Team `multi_node` 是否解锁（真源 `teamFeatureRefusal`）。 */
  teamUnlocked: boolean;
  /** 本机是否已入网（真源 `isNodeEnrolled`）。 */
  enrolled: boolean;
  /** 有父任务（子任务属于既有工作单元）。 */
  hasParent: boolean;
  /** 有依赖（依赖链须在本机推进）。 */
  hasDependencies: boolean;
  /**
   * 依赖此刻的可解性（zx_20261023_5 批一）。**缺省时不改变旧行为**：有依赖仍按 `has-dependencies` 拒。
   * 给了就按三态判：`met`/`unresolved` ⇒ 可派；`waiting`/`dead` ⇒ 各自如实拒。
   */
  depState?: DepState;
  /** 有附件（附件落在本机盘上，他机读不到）。 */
  hasAttachments: boolean;
  /** 项目有 `working_dir`（外派节点没有这个本机目录）。 */
  hasWorkingDir: boolean;
  /** 本次建单触发了模板拆解（拆解后子任务才是工作单元）。 */
  decomposed: boolean;
  /** 任务形态路由出的类目；`null` = 对话/无法归类（不外派）。 */
  category: NodeCardCategory | null;
}

export type CreateDispatchReason =
  | 'eligible'
  | 'setting-off'
  | 'team-locked'
  | 'not-enrolled'
  | 'has-parent'
  | 'has-dependencies'
  /** 依赖未完成（会自动满足；满足后再派，不是永久拒）。 */
  | 'dependencies-waiting'
  /** 依赖已失败/归档/暂停待人工（不会自动满足）。 */
  | 'dependencies-dead'
  | 'has-attachments'
  | 'has-working-dir'
  | 'decomposed'
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
  if (!f.settingOn) return deny('setting-off');
  if (!f.teamUnlocked) return deny('team-locked');
  if (!f.enrolled) return deny('not-enrolled');
  if (f.hasParent) return deny('has-parent');
  if (f.hasDependencies) {
    // zx_20261023_5 批一：有依赖不等于永不外派——**依赖已满足**的任务和孤儿任务一样可派。
    //   未给 `depState` 的旧调用方保持原样（`has-dependencies`），不因本轮改动而默默放宽。
    if (f.depState === 'waiting') return deny('dependencies-waiting');
    if (f.depState === 'dead') return deny('dependencies-dead');
    if (f.depState === undefined) return deny('has-dependencies');
  }
  if (f.hasAttachments) return deny('has-attachments');
  if (f.hasWorkingDir) return deny('has-working-dir');
  if (f.decomposed) return deny('decomposed');
  if (!f.category) return deny('no-category');
  return { eligible: true, reason: 'eligible', category: f.category };
}

/** 理由 → 人话（界面/回执直接上屏；机器码仍保留在 `reason` 里供程序判定）。 */
export const CREATE_DISPATCH_REASON_LABEL: Record<CreateDispatchReason, string> = {
  eligible: '符合外派条件',
  'setting-off': '自动外派开关未开',
  'team-locked': 'Team 档未解锁多机协同',
  'not-enrolled': '本机尚未入网',
  'has-parent': '子任务随父任务本地推进',
  'has-dependencies': '任务有前置依赖',
  'dependencies-waiting': '前置尚未完成（完成后自动派发）',
  'dependencies-dead': '前置已失败/归档，不会自动解锁',
  'has-attachments': '任务带附件（附件在本机盘上）',
  'has-working-dir': '项目指定了本机工作目录',
  decomposed: '已按模板拆解（工作单元是子任务）',
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
}

/**
 * 组派单载荷：`prompt`（兼容）+ `title`/`description`/`acceptance_criteria`（结构化）。
 * ⚠ 三项**不拼接、不加工**——远端要的是"用户写的那句话本身"（验收标准若被塞进描述里，
 *   远端就再也分不出哪是验收、哪是正文；判卷读的正是这个字段）。
 */
export function buildDispatchPayload(task: CreatedTaskInput, upstream?: readonly DispatchUpstream[]): DispatchPayload {
  const base: DispatchPayload = {
    prompt: buildDispatchPrompt(task),
    title: String(task.title ?? '').trim(),
    description: String(task.description ?? '').trim(),
    acceptance_criteria: String(task.acceptanceCriteria ?? '').trim(),
  };
  const kept = (upstream ?? []).filter((u) => u && typeof u.id === 'string' && u.id !== '');
  return kept.length > 0 ? { ...base, upstream: kept.slice(0, UPSTREAM_MAX_ITEMS) } : base;
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
  const decision = decideCreateDispatch(facts);
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
  let result;
  try {
    result = await dispatchNodeRequest(
      db,
      { category, payload: { ...buildDispatchPayload(task, upstream) }, requireTarget: true },
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
  );
  // 三键落定后占位让位（三键在 `remoteBlockOf` 里优先——即便这一清失败也仍按"已派定"拦）。
  clearOffer();
  if (!marked) return { attempted: true, ok: false, reason: 'assign-mark-failed' };
  return { attempted: true, ok: true, reason: '', nodeId: result.targetNodeId };
}

/** context_json 各形态 → 对象；坏 JSON / 非对象一律 `{}`（不把"读不成"当成有值）。 */
function parseTaskContext(raw: unknown): Record<string, unknown> {
  try {
    const s = raw == null ? '' : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
    const o = s ? JSON.parse(s) : null;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch { return {}; }
}

/**
 * zx_20261023_5 批一：**已存在的任务**要不要外派——准入事实逐项从真实行/设置读（与建单那路同一把尺
 * `decideCreateDispatch`，不另写一套判据）。
 * `depState` 给的是**此刻**的依赖可解性：`met`/`unresolved` ⇒ 可派；`waiting`/`dead` ⇒ 各自如实拒。
 */
export function buildExistingTaskDispatchFacts(db: Database.Database, taskId: string): CreateDispatchFacts {
  let row:
    | { title?: unknown; description?: unknown; acceptance_criteria?: unknown; parent_task_id?: unknown; depends_on?: unknown; context_json?: unknown; project_id?: unknown }
    | undefined;
  try {
    row = db
      .prepare('SELECT title, description, acceptance_criteria, parent_task_id, depends_on, context_json, project_id FROM wa_tasks WHERE id = ?')
      .get(taskId) as typeof row;
  } catch { row = undefined; }
  const ctx = parseTaskContext(row?.context_json);
  let depState: DepState = 'met';
  try { depState = taskDepState(db, taskId); } catch { /* 读不到依赖 ⇒ 按 met（派发提交前 ANS 侧仍会把关） */ }
  const deps = parseDepIds(row?.depends_on);
  return {
    settingOn: isAutoDispatchOn(db as unknown as NodeSettingDb),
    teamUnlocked: teamFeatureRefusal(db as unknown as LicenseSettingDb, 'multi_node') === null,
    enrolled: isNodeEnrolled(db as unknown as NodeSettingDb),
    hasParent: Boolean(row?.parent_task_id),
    hasDependencies: deps.length > 0,
    depState,
    hasAttachments: Array.isArray(ctx.attachments) && ctx.attachments.length > 0,
    hasWorkingDir: projectHasWorkingDir(db, String(row?.project_id ?? '')),
    decomposed: ctx.auto_decomposed === true,
    category: routeCategoryForTask(row?.title, row?.description),
  };
}

/** 依赖三态的人话名（视图与协同面板共用一份；机器码仍以 `DepState` 为准）。 */
const DEP_STATE_LABEL: Record<DepState, string> = {
  met: '前置已全部完成',
  waiting: '前置未完成（完成后自动派发）',
  dead: '前置已失败/归档，不会自动解锁',
  unresolved: '前置状态无法解析（按可派处理）',
};

/** 派单理由三行之一。`key` 供 rr 钉行序，不参与展示。 */
export interface DispatchReasonLine {
  key: 'role' | 'capacity' | 'deps';
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

  return {
    eligible: !assigned && decision.eligible,
    reason: assigned ? 'already-dispatched' : decision.reason,
    label: assigned ? '已外派他机执行，本机不再重复派' : CREATE_DISPATCH_REASON_LABEL[decision.reason],
    category: decision.category,
    lines: [
      { key: 'role', label: '角色/权重', value: roleText },
      { key: 'capacity', label: '机器余力', value: capacity },
      { key: 'deps', label: '依赖状态', value: depsText },
    ],
  };
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
    enabled: isAutoDispatchOn(db as unknown as NodeSettingDb),
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
    if (!isAutoDispatchOn(db as unknown as NodeSettingDb)) return;
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

/** 供 IPC 组准入事实时共用：项目是否指定了本机工作目录。 */
export function projectHasWorkingDir(db: Database.Database, projectId: string): boolean {
  try {
    const row = db.prepare('SELECT working_dir FROM wa_projects WHERE id = ?').get(projectId) as { working_dir?: unknown } | undefined;
    return typeof row?.working_dir === 'string' && row.working_dir.trim() !== '';
  } catch {
    return false; // 读不到 ⇒ 不因此拦（外派仍由 ANS 侧把关）
  }
}
