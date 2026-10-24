/**
 * zx_20261018_3 批二「序」：**「能不能开跑」的唯一运行时判据**。
 *
 * 病灶：`classifyDep`/`depBlocksRun` 早已是依赖可解性的唯一真源，但此前**只有调度器**
 * （`getReadyTasks`）问它。三条人工入口——GUI「执行」（`task:updateStatus→running`）、
 * 「重试」（`task:retry`）、「恢复」（`task:resume`）——**都不问**：前置未完成也照样置状态、
 * 照样入队。于是"依赖是一道闸"只在自动调度这一侧成立，用户从侧门一点，闸就绕过去了。
 *
 * 本模块把"读当前任务的依赖现状"收成一处（调度器与三条入口同引），不另写第二把尺：
 *   · `taskDepState`：`met/waiting/dead/unresolved`（分类仍归 `dep-graph.ts`）；
 *   · `taskDependencyBlock`：**该拦时**给出人话（文案取 `depBlockInfo` 唯一真源，不在此另拼）；
 *   · `dependencyRefusal`：IPC 入口直接可用的拒绝体（`DEPENDENCY_BLOCKED`）。
 *
 * ⚠ `unresolved`（前置 id 在库里查不到）**不拦**——承 M3-2 的字节等价裁定：笔误不阻塞调度，
 *   也不该在人工入口上变成新的拦截面。只 `waiting`/`dead` 拦。
 */
import { classifyDep, depBlockInfo, depBlocksRun, parseDepIds, type DepState } from './dep-graph.js';
import type { AccountingDb } from './task-accounting.js';

interface DepRow {
  id: string;
  title: string | null;
  status: string;
  context_json: string | null;
}

export interface TaskDepRead {
  deps: string[];
  state: DepState;
  rows: DepRow[];
}

/** 读一个任务的前置 id 与它们此刻在库里的样子（一次 IN 查询；查不到者由 `classifyDep` 记 `unresolved`）。 */
export function readTaskDeps(db: AccountingDb, taskId: string): TaskDepRead {
  const row = db.prepare('SELECT depends_on FROM wa_tasks WHERE id = ?').get(taskId) as
    | { depends_on?: string | null }
    | undefined;
  const deps = parseDepIds(row?.depends_on);
  if (deps.length === 0) return { deps, state: 'met', rows: [] };
  const rows = db.prepare(
    `SELECT id, title, status, context_json FROM wa_tasks WHERE id IN (${deps.map(() => '?').join(',')})`,
  ).all(...deps) as DepRow[];
  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  const ctxById = new Map(rows.map((r) => [r.id, r.context_json]));
  const state = classifyDep(deps, (id) => statusById.get(id), (id) => ctxById.get(id));
  return { deps, state, rows };
}

/** 前置可解性状态（调度闸与人工入口同一读法）。 */
export function taskDepState(db: AccountingDb, taskId: string): DepState {
  return readTaskDeps(db, taskId).state;
}

export interface DependencyBlock {
  state: DepState;
  /** 人话（`depBlockInfo.text`）——点名是哪个前置、为什么等、能不能自解。 */
  message: string;
}

/**
 * 该拦时返回阻塞事实；可开跑（`met`/`unresolved`）返回 null。
 * 文案与 `depBlockInfo` 同源（查不到的前置 id 用原文，不冒充一个标题）。
 */
export function taskDependencyBlock(db: AccountingDb, taskId: string): DependencyBlock | null {
  const { deps, state, rows } = readTaskDeps(db, taskId);
  if (!depBlocksRun(state)) return null;
  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  const ctxById = new Map(rows.map((r) => [r.id, r.context_json]));
  const titleById = new Map(rows.map((r) => [r.id, r.title]));
  const info = depBlockInfo(
    deps,
    (id) => statusById.get(id),
    (id) => titleById.get(id) || id,
    (id) => ctxById.get(id),
  );
  return { state, message: info.text || `前置未满足（${state}）` };
}

/** IPC 入口的拒绝体——三条人工入口共用同一个码与同一句话。 */
export interface DependencyRefusal {
  error: { code: 'DEPENDENCY_BLOCKED'; message: string };
}

export function dependencyRefusal(db: AccountingDb, taskId: string): DependencyRefusal | null {
  const block = taskDependencyBlock(db, taskId);
  return block ? { error: { code: 'DEPENDENCY_BLOCKED', message: block.message } } : null;
}
