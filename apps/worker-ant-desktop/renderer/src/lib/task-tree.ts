/**
 * zx_20261112_1 B4「诊」——子任务**成树**与族进度的唯一真源（零依赖纯模块）。
 *
 * 病根：族卡把 `tasks:children` 的行按**平铺**渲染。B2 起任务可以挂在任意父级下，
 *   孙任务与直系子任务在同一行层级里排开 ⇒ 用户看不出"谁是谁的子"，折叠也无从谈起；
 *   顶部也没有一句"这族做到哪了"，只能逐个读状态。
 *
 * 口径：
 *   - 树由 `parent_task_id` 构造；父不在本批行内（或自引用/成环）的行**提升为根**，
 *     保证每一行都出现在树上且只出现一次（`visited` 防环）。
 *   - 族进度 `done` 用 `isTerminalStatus`（与 main 的终态集合同源），不另写一份终态词表。
 *   - "运行中"只数引擎在跑的态；"等你处理"只数暂停/失败/稳定观察——待执行是队列里的事，
 *     不冒充"等你处理"。
 */
import { isTerminalStatus } from '../../../src/main/core/status-terms.js';

export interface TaskTreeLike {
  id: string;
  status: string;
  parent_task_id?: string | null;
}

export interface TaskTreeNode<T> {
  task: T;
  depth: number;
  children: TaskTreeNode<T>[];
}

export interface FlatTaskRow<T> {
  task: T;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/** 把扁平行构树。`rootId` 只是"父级边界"：父 == rootId 或父不在行集内 ⇒ 根。 */
export function buildTaskTree<T extends TaskTreeLike>(
  rows: readonly T[],
  rootId?: string | null,
): TaskTreeNode<T>[] {
  const byId = new Map<string, T>();
  for (const r of rows) if (r && !byId.has(r.id)) byId.set(r.id, r);

  const childMap = new Map<string, T[]>();
  const roots: T[] = [];
  for (const r of rows) {
    if (!r) continue;
    const pid = r.parent_task_id ?? null;
    // 父是本批里的另一行 ⇒ 挂到父下；父 == rootId / 父不在本批（孤儿）/ 无父 / 自引用 ⇒ 根。
    if (pid && pid !== r.id && pid !== rootId && byId.has(pid)) {
      const arr = childMap.get(pid);
      if (arr) arr.push(r); else childMap.set(pid, [r]);
    } else {
      roots.push(r);
    }
  }

  const visited = new Set<string>();
  const build = (t: T, depth: number): TaskTreeNode<T> | null => {
    if (visited.has(t.id)) return null;
    visited.add(t.id);
    const kids = (childMap.get(t.id) ?? [])
      .map((k) => build(k, depth + 1))
      .filter((x): x is TaskTreeNode<T> => x !== null);
    return { task: t, depth, children: kids };
  };
  const out: TaskTreeNode<T>[] = [];
  for (const r of roots) {
    const n = build(r, 0);
    if (n) out.push(n);
  }
  // 环上的行可能全部落不进 roots（每个父都在行集内且互指）：兜底按原序补成根。
  for (const r of rows) {
    if (!r || visited.has(r.id)) continue;
    const n = build(r, 0);
    if (n) out.push(n);
  }
  return out;
}

/** 按折叠集合摊平成可渲染行（深度 + 有无子 + 是否折叠）。 */
export function flattenTaskTree<T extends { id: string }>(
  nodes: readonly TaskTreeNode<T>[],
  collapsed: ReadonlySet<string>,
): FlatTaskRow<T>[] {
  const out: FlatTaskRow<T>[] = [];
  const walk = (n: TaskTreeNode<T>): void => {
    const hasChildren = n.children.length > 0;
    const isCollapsed = hasChildren && collapsed.has(n.task.id);
    out.push({ task: n.task, depth: n.depth, hasChildren, collapsed: isCollapsed });
    if (!isCollapsed) for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

export interface FamilyProgress {
  total: number;
  done: number;
  running: number;
  waiting: number;
}

const RUNNING_STATUSES = new Set(['executing', 'running', 'preparing', 'planning']);
const WAITING_STATUSES = new Set(['paused', 'failed', 'stabilizing']);

/** 族进度：完成/总数（终态同源）+ 运行中 + 等你处理。空集 ⇒ 全 0（调用方不得渲染"0/0"）。 */
export function familyProgress(rows: readonly TaskTreeLike[]): FamilyProgress {
  let done = 0;
  let running = 0;
  let waiting = 0;
  for (const r of rows) {
    if (!r) continue;
    if (isTerminalStatus(r.status)) done++;
    else if (RUNNING_STATUSES.has(r.status)) running++;
    else if (WAITING_STATUSES.has(r.status)) waiting++;
  }
  return { total: rows.length, done, running, waiting };
}
