/**
 * zx_20261011_4 M1（道德经·知止 / 维特根斯坦·意义即使用）: 跨机**编排**的最小真源——
 *   "本机某件子任务已交由他机执行"这**一个事实**的唯一记法。
 *
 * 为什么不新增持久化 status（用户 2026-10-11 裁定，见方案 §决策）：
 *   本仓纪律要求新增持久化枚举值须**穷举全部读取谓词**（SQL / 内存 / 局部变量 / 第二进程词表落点四形态），
 *   漏一处即静默错。故"已外派"不落成 status，而落成 `context_json` 三键：
 *   - 子任务仍留 `status='pending'`（本地调度器据本模块的判据**显式排除**它、并留可见理由，防静默分叉）；
 *   - 三个键同此一处读写，键名散落即"同一件事两个名字"，必有一处漂（承 `NODE_REQUEST_ID_KEY` 的教训）。
 *
 * ⚠ `TaskManager.updateContext` 是**整体替换** context_json（`UPDATE wa_tasks SET context_json=?`）——
 *   故本模块的写口一律**读-改-写整份**（在此一处实现，调用点不得各写一份 RMW，否则相互抹键）。
 * ⚠ 本模块**不触网、不引 electron/better-sqlite3**：只吃最小库接口（`OrchestrateDb`），
 *   故受控回归可**直引真实现**直跑（同 `node-identity.ts` / `node-card.ts` 范式）。
 */
import { NODE_SETTING_KEYS, readNodeSetting, type NodeSettingDb } from './node-identity.js';

/** 读设置 / 读写 `wa_tasks` 的最小库接口（使本模块可脱 better-sqlite3 被 rr 直跑）。 */
export interface OrchestrateDb extends NodeSettingDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/**
 * "已外派"三键——**一处真源**。
 *   - `assigned_node_id`：承接该子任务的他机 node_id（面板上屏用）。
 *   - `assigned_request_id`：对应的 ANS `ans_node_requests.id`（远端驱动据它读回；它**非空即"单已出去"**）。
 *   - `assigned_at`：外派时刻（ISO8601，UTC）——远端驱动的**超时收回**据此判定。
 */
export const REMOTE_ASSIGN_NODE_KEY = 'assigned_node_id';
export const REMOTE_ASSIGN_REQUEST_KEY = 'assigned_request_id';
export const REMOTE_ASSIGN_AT_KEY = 'assigned_at';

/**
 * M4: 远端**回传结果**在 `context_json` 的落点键——**一处真源**（写口 `node-remote-driver.ts`，
 *   读口任务详情投影）。
 *   - `remote_result`：远端回传的原始结果（结构化）。
 *   - `completion_summary`：人话摘要（父任务逐子简报与面板下钻同引它）。
 *   - `remote_result_at`：回传时刻（ISO）。
 *   ⚠ 名字散落即"同一件事两个名字"（承三键的教训）——写读两侧一律引此常量，不再手抄字面量。
 */
export const REMOTE_RESULT_KEY = 'remote_result';
export const REMOTE_SUMMARY_KEY = 'completion_summary';
export const REMOTE_RESULT_AT_KEY = 'remote_result_at';

/** 编排模式词表——**一处真源**（渲染层/后端同引；增删一格须同步全部读点）。 */
export const ORCHESTRATE_MODES = ['off', 'auto'] as const;
export type OrchestrateMode = (typeof ORCHESTRATE_MODES)[number];

export function isOrchestrateMode(value: unknown): value is OrchestrateMode {
  return typeof value === 'string' && (ORCHESTRATE_MODES as readonly string[]).includes(value);
}

/** 读编排模式：设置项 `node.orchestrate_mode`；未配 / 非法 ⇒ **`off`**（未配即关，不惊扰既有行为）。 */
export function readOrchestrateMode(db: NodeSettingDb): OrchestrateMode {
  const raw = readNodeSetting(db, NODE_SETTING_KEYS.orchestrateMode);
  return isOrchestrateMode(raw) ? raw : 'off';
}

/** 一件"已外派"的归属（三键齐备时才有值）。 */
export interface RemoteAssign {
  nodeId: string;
  requestId: string;
  assignedAt: string;
}

/** 把 context_json 各形态（string / Buffer / null）归一成对象；非法 ⇒ `{}`（不把"读不成"当成"有值"）。 */
function parseCtx(contextJson: string | Buffer | null | undefined): Record<string, unknown> {
  if (contextJson == null) return {};
  const s = Buffer.isBuffer(contextJson) ? contextJson.toString('utf-8') : String(contextJson);
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 取"已外派"归属——`node_id` 与 `request_id` **两者皆非空串**才算数（单已出去且知去向）。
 * 非外派（或键不全）⇒ `null`（＝"这不是一件外派的活"）。
 */
export function remoteAssignOf(contextJson: string | Buffer | null | undefined): RemoteAssign | null {
  const c = parseCtx(contextJson);
  const nodeId = c[REMOTE_ASSIGN_NODE_KEY];
  const requestId = c[REMOTE_ASSIGN_REQUEST_KEY];
  if (typeof nodeId !== 'string' || nodeId.length === 0) return null;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  const at = c[REMOTE_ASSIGN_AT_KEY];
  return { nodeId, requestId, assignedAt: typeof at === 'string' ? at : '' };
}

/** 该任务的 context_json 是否表示"已外派"（调度器据此让位；**一处判据**，勿在别处另写一份）。 */
export function isRemoteAssigned(contextJson: string | Buffer | null | undefined): boolean {
  return remoteAssignOf(contextJson) !== null;
}

/**
 * M4: 一件"已外派"子任务的**展示投影**（供任务详情 `tasks:children` 与面板下钻）。
 *   有归属（`node_id` ∧ `request_id` 皆非空）才返回；否则 `null`（＝"这不是一件外派的活"）。
 *   回传三键各可缺省（**尚未回传**即 `result=null` / `summary=''`）——**不把"没回传"伪造成有值**。
 */
export interface RemoteTaskView {
  nodeId: string;
  requestId: string;
  assignedAt: string;
  /** 远端回传的原始结果（结构化）；未回传 ⇒ `null`。 */
  result: unknown;
  /** 人话摘要（`completion_summary`）；未回传 ⇒ `''`。 */
  summary: string;
  /** 回传时刻（ISO）；未回传 ⇒ `''`。 */
  resultAt: string;
}

/** 把一份 context_json 投影成"已外派"展示视图；非外派 / 键不全 ⇒ `null`。 */
export function remoteTaskView(contextJson: string | Buffer | null | undefined): RemoteTaskView | null {
  const assign = remoteAssignOf(contextJson);
  if (!assign) return null;
  const c = parseCtx(contextJson);
  const result = c[REMOTE_RESULT_KEY];
  const summary = c[REMOTE_SUMMARY_KEY];
  const resultAt = c[REMOTE_RESULT_AT_KEY];
  return {
    nodeId: assign.nodeId,
    requestId: assign.requestId,
    assignedAt: assign.assignedAt,
    result: result === undefined ? null : result,
    summary: typeof summary === 'string' ? summary : '',
    resultAt: typeof resultAt === 'string' ? resultAt : '',
  };
}

/** 读一份任务的 context_json 为对象；任务不存在 ⇒ `null`（与"context 为空"区分）。 */
function readTaskCtx(db: OrchestrateDb, taskId: string): Record<string, unknown> | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: unknown } | undefined;
    if (!row) return null;
    return parseCtx(row.context_json as string | Buffer | null | undefined);
  } catch {
    return null;
  }
}

/** 读-改-写整份 context_json（RMW 只此一处）。成功 ⇒ true。 */
function writeTaskCtx(db: OrchestrateDb, taskId: string, ctx: Record<string, unknown>): boolean {
  try {
    const r = db
      .prepare("UPDATE wa_tasks SET context_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(ctx), taskId) as { changes?: number } | undefined;
    return (r?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 记"这件子任务已外派给他机"。**读-改-写整份**（不抹兄弟键）。任务不存在 / 写失败 ⇒ `false`（如实）。
 * `at` 可注入（回归不依赖墙钟）；缺省取 `new Date().toISOString()`（UTC，与库内 `datetime('now')` 同基准）。
 */
export function markRemoteAssigned(
  db: OrchestrateDb,
  taskId: string,
  assign: { nodeId: string; requestId: string },
  at?: string,
): boolean {
  const ctx = readTaskCtx(db, taskId);
  if (ctx === null) return false;
  ctx[REMOTE_ASSIGN_NODE_KEY] = assign.nodeId;
  ctx[REMOTE_ASSIGN_REQUEST_KEY] = assign.requestId;
  ctx[REMOTE_ASSIGN_AT_KEY] = at ?? new Date().toISOString();
  return writeTaskCtx(db, taskId, ctx);
}

/** 撤"已外派"归属（超时收回 / 外派失败回滚）。**只删三键、留其余**。任务不存在 / 写失败 ⇒ `false`。 */
export function clearRemoteAssigned(db: OrchestrateDb, taskId: string): boolean {
  const ctx = readTaskCtx(db, taskId);
  if (ctx === null) return false;
  delete ctx[REMOTE_ASSIGN_NODE_KEY];
  delete ctx[REMOTE_ASSIGN_REQUEST_KEY];
  delete ctx[REMOTE_ASSIGN_AT_KEY];
  return writeTaskCtx(db, taskId, ctx);
}

/**
 * 本项目里"已外派给本机以外、仍在 pending"的任务数——供调度器**留可见理由**（"不抢跑"要说得明白）。
 * 与 `isRemoteAssigned` **同一判据**（此处只做 SQL 粗筛 + 本判据精判，不另写第二套）。
 */
export function countRemoteAssignedPending(db: OrchestrateDb, projectId: string): number {
  try {
    const rows = db
      .prepare("SELECT context_json FROM wa_tasks WHERE project_id = ? AND status = 'pending'")
      .all(projectId) as Array<{ context_json?: unknown }>;
    return rows.filter((r) => isRemoteAssigned(r.context_json as string | Buffer | null | undefined)).length;
  } catch {
    return 0;
  }
}

/** 每拍最多外派的件数——**知止**：不一拍把整批溢出全推给对端（对端也有自己的并发与队列）。 */
export const ORCHESTRATE_OVERFLOW_PER_TICK = 3;

/** `planOffloads` 的入参——各数**皆由既有真源派生**（不在此处重算并发/就绪）。 */
export interface PlanOffloadsInput {
  /** 该项目的**就绪**任务行（真源＝`TaskScheduler.getReadyTasks`：依赖满足 ∧ 未外派 ∧ pending）。 */
  ready: Array<Record<string, unknown>>;
  /** 该项目此刻**已在跑**的并发位占用数（真源＝`resolveProjectConcurrency().running`）。 */
  localOccupied: number;
  /** 该项目此刻**还空着**的并发位（真源＝`resolveProjectConcurrency().available`）。 */
  available: number;
  /** 编排模式（真源＝`readOrchestrateMode`）。 */
  mode: OrchestrateMode;
  /** 本拍上限覆盖（缺省 `ORCHESTRATE_OVERFLOW_PER_TICK`）。 */
  maxPerTick?: number;
}

/**
 * **外派决策纯函数**（M3）：给定本项目此刻的就绪任务与本机并发余量，算出"该外派哪几件"。
 *
 * 知止缺省（方案 §5 风险 / §1 N3）：**只有本机自己跑不过来时才外派**——
 *   ① `mode !== 'auto'` ⇒ 不外派（缺省 `off`，不惊扰既有行为）；
 *   ② 本机该项目**并发位未占满**（`available > 0`）⇒ 不外派（"跑得过来就不外派"，不自足者不外派）；
 *   ③ 并发位占满 ∧ 本机确有在跑的（`localOccupied > 0`，排除"上限=0"这类误配而不把整批倒给对端）
 *      ⇒ 取**溢出**的就绪任务（按既有优先级序原样取前 N，不再排一次），有界（`maxPerTick`）。
 *
 * ⚠ **纯函数**：不读库、不触网（喂标本即可直跑，见 rr 【D】）。排序/就绪判据**沿用既有真源**，
 *   此处只做"取多少"的截断，不自作主张重排。
 */
export function planOffloads(input: PlanOffloadsInput): string[] {
  if (input.mode !== 'auto') return [];
  if (input.available > 0) return [];
  if (input.localOccupied <= 0) return [];
  const max = input.maxPerTick ?? ORCHESTRATE_OVERFLOW_PER_TICK;
  if (max <= 0) return [];
  return input.ready
    .slice(0, max)
    .map((r) => (typeof r.id === 'string' ? r.id : ''))
    .filter((id) => id !== '');
}
