/**
 * zx_20261115_2 M1（道德经·知止不殆 / 维特根斯坦·意义即用法）: 中继任务树的**有界预算**。
 *
 * 病根（zx_20261115_1 M6 真机标本）：外部/对端派来的中继任务被模型用 `spawn_subagent` / `create_task`
 *   逐层自拆成 `[Sub] [Sub] 复核…`，全局只有 `MAX_TASK_DEPTH=5` 与 `MAX_CHILD_BREADTH=5`，
 *   整个任务树**没有总时窗、没有相对深度、没有总任务数**；中继 10 分钟超时后又只停止等待、
 *   不终止远端树 ⇒ 一件本可成功的活被判死，远端还在烧 token。
 *
 * 本模块只做三件**可判**的事（零 electron / 零 better-sqlite3，rr 可直引）：
 *   ① `beginRelayTree`：中继根建单时生成一份树预算（根 id、相对深度上限、总任务数上限、绝对截止时刻）；
 *   ② `readRelayTree`：从任意任务的 `context_json.relay_tree` 读出预算；缺键/坏形状 ⇒ `null`（旧任务逐字节不变）；
 *   ③ `relayTreeRefusal`：四条建子路共用的**唯一判据**——超深 / 超总数 / 过期，返回人话拒因；无树 ⇒ `null`。
 *
 * ⚠ **不在这里做继承**：继承由 `task-accounting.ts` 的 `inheritedConstraintContext` 一处负责
 *   （`buildChildContext` + `spawn_subagent` + `planSubtasksFromTemplate` 三路引用），避免第二套白名单。
 * ⚠ 只认显式 `relay_tree` 键：本地用户任务没有它 ⇒ 判据恒 `null`，既有行为零变化。
 */

/** 树预算在任务 `context_json` 里的键名——写口/读口只此一处。 */
export const RELAY_TREE_KEY = 'relay_tree';

/** 相对中继根的拆解深度上限：根 + 一层子任务；`[Sub] [Sub]` 不再出现。 */
export const RELAY_TREE_MAX_DEPTH = 1;

/** 整树任务总数上限（含根）：防"子终态腾槽后无限再建"。 */
export const RELAY_TREE_MAX_TASKS = 8;

/** 树时窗 = 中继 timeout − 该余量，留给收口/归档（不让 runner 先于树收口报超时）。 */
export const RELAY_TREE_DEADLINE_GRACE_MS = 60_000;

export interface RelayTreeBudget {
  /** 中继根任务 id——整棵树的身份（总任务数按它聚合）。 */
  root_id: string;
  /** 根任务的 `depth`（顶层=0）；相对深度 = 子任务 depth − base_depth。 */
  base_depth: number;
  /** 允许的相对拆解深度（不含根）。 */
  max_depth: number;
  /** 整树任务总数上限（含根）。 */
  max_tasks: number;
  /** 绝对截止时刻（epoch ms）。 */
  deadline_at: number;
}

/** 判据只需要一个最小 db 接口（better-sqlite3 / node:sqlite 同形）。 */
export interface RelayTreeDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

function finiteNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 中继根建单时生成树预算。`timeoutMs` 取中继轮询的同一条上界；
 * 余量后至少留 1 秒（不让极小 timeout 造出一个"建单即过期"的树）。
 */
export function beginRelayTree(nowMs: number, timeoutMs: number, rootTaskId: string): RelayTreeBudget {
  const span = Math.max(1_000, (finiteNumber(timeoutMs) ?? 0) - RELAY_TREE_DEADLINE_GRACE_MS);
  return {
    root_id: String(rootTaskId),
    base_depth: 0,
    max_depth: RELAY_TREE_MAX_DEPTH,
    max_tasks: RELAY_TREE_MAX_TASKS,
    deadline_at: (finiteNumber(nowMs) ?? Date.now()) + span,
  };
}

/** 从任务上下文（对象或 JSON 串）读取树预算；缺键/坏形状一律 `null`（不编一个默认树）。 */
export function readRelayTree(context: Record<string, unknown> | string | null | undefined): RelayTreeBudget | null {
  let ctx: Record<string, unknown> | null = null;
  if (typeof context === 'string') {
    try {
      const parsed: unknown = JSON.parse(context || '{}');
      ctx = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch { return null; }
  } else if (context && typeof context === 'object' && !Array.isArray(context)) {
    ctx = context;
  }
  if (!ctx) return null;
  const raw = ctx[RELAY_TREE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const rootId = typeof r.root_id === 'string' ? r.root_id.trim() : '';
  const baseDepth = finiteNumber(r.base_depth);
  const maxDepth = finiteNumber(r.max_depth);
  const maxTasks = finiteNumber(r.max_tasks);
  const deadlineAt = finiteNumber(r.deadline_at);
  if (!rootId || baseDepth === null || maxDepth === null || maxTasks === null || deadlineAt === null) return null;
  if (baseDepth < 0 || maxDepth < 0 || maxTasks < 1) return null;
  return {
    root_id: rootId,
    base_depth: Math.floor(baseDepth),
    max_depth: Math.floor(maxDepth),
    max_tasks: Math.floor(maxTasks),
    deadline_at: deadlineAt,
  };
}

/** 整树任务总数（含根）——按 `relay_tree.root_id` 聚合；读不到 ⇒ `null`（不把"读不到"当 0）。 */
export function relayTreeTaskCount(db: RelayTreeDb, tree: RelayTreeBudget): number | null {
  try {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM wa_tasks WHERE json_extract(context_json, '$.relay_tree.root_id') = ?",
    ).get(tree.root_id) as { c?: unknown } | undefined;
    const n = finiteNumber(row?.c);
    return n === null ? null : Math.max(0, Math.floor(n));
  } catch { return null; }
}

/**
 * 四条建子路共用的判据：超深 / 超总数 / 过期 ⇒ 人话拒因；无树 / 读不到 ⇒ `null`（放行）。
 *
 * 方向性：**只会更窄**。没有 `relay_tree` 的本地任务恒放行；有树的任务三类越界一律拒绝，
 *   不给"拆不出就绕过去"的第二条路。
 */
export function relayTreeRefusal(
  db: RelayTreeDb,
  parentContext: Record<string, unknown> | string | null | undefined,
  childDepth: number,
  nowMs: number = Date.now(),
): string | null {
  const tree = readRelayTree(parentContext);
  if (!tree) return null;
  const depth = finiteNumber(childDepth);
  if (depth === null) return null;
  const relative = Math.floor(depth) - tree.base_depth;
  if (relative > tree.max_depth) {
    return `本次派单的任务树只允许拆解 ${tree.max_depth} 层（当前将到第 ${relative} 层）——请在当前任务内完成，或由派活方先拆好再派。`;
  }
  if ((finiteNumber(nowMs) ?? Date.now()) >= tree.deadline_at) {
    return `本次派单的任务树总时窗已用尽（截止 ${new Date(tree.deadline_at).toISOString()}）——不再拆解；已完成的部分产出保留，未完成部分请由派活方重新发起。`;
  }
  const active = relayTreeTaskCount(db, tree);
  if (active !== null && active >= tree.max_tasks) {
    return `本次派单的任务树已达 ${tree.max_tasks} 个任务上限——请在当前任务内收口，或由派活方重新发起。`;
  }
  return null;
}
