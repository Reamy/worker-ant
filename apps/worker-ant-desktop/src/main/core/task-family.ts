/**
 * zx_20261112_1 B4「诊」——主进程侧**子树收集**（零依赖纯函数）。
 *
 * 病根：`tasks:children` 只取**直接**子任务（`WHERE parent_task_id = ?`）。B2 起任务可以挂到
 *   任意父级下，孙任务在族卡上根本不出现——父页"族验收：全部子项已终态"会在孙任务还在跑时
 *   就成立（判据用的是这一批行）。
 *
 * 治法：按父指针**广度优先**收集整棵子树（有界深度，`seen` 防环），SQL 仍是一条按父取行的语句，
 *   由调用方注入加载跳（本模块不碰 DB，便于受控回归直引真实现）。
 */
export const TASK_FAMILY_MAX_DEPTH = 5;

export function collectDescendants<T extends { id: string }>(
  loadChildren: (parentId: string) => readonly T[],
  rootId: string,
  maxDepth: number = TASK_FAMILY_MAX_DEPTH,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>([rootId]);
  let frontier: string[] = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const pid of frontier) {
      for (const row of loadChildren(pid)) {
        if (!row?.id || seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return out;
}
