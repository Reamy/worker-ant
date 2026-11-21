/**
 * zx_20261117_1 M4「忆」：**验收失败记忆的解除**——零依赖纯函数（只碰 db 与 memory 的最小接口）。
 *
 * 病根（标本 06）：`wa_memories 07eef72f`（`acceptance_failure`）在任务已 95/4/4 通过后，
 * 仍以「任务「H2幂等测试」验收未达…」被注入 34 次；后续同项目任务会把已解决的历史当当前预警。
 *
 * 治法（道德经·知止 / 维特根斯坦·意义即用法）：
 *   · 任务**本轮真通过**时，在项目 `acceptance_failure` 记忆里按**本任务标题**追加一行 `[已解除]`；
 *   · 不删除、不降权历史正文（历史仍是历史，只是不再代表当前状态）；
 *   · 同一条记忆可能含多个任务的失败（`sameSourceReplace` 按项目累加）⇒ 只定位本任务、不整条删。
 */
import type Database from 'better-sqlite3';

export interface AcceptanceMemoryApi {
  retrieveByType: (memoryType: string, projectId: string, limit?: number) => Array<{ id: string; content: string; reasoning?: string }>;
  updateMemory: (id: string, content: string, reasoning?: string) => void;
}

/**
 * 把本项目 `acceptance_failure` 记忆里对应任务的「验收未达」标为 `[已解除]`。
 *
 * @returns 是否真的写入了解除标记（无对应记忆/已解除 ⇒ false，调用方据此决定是否记日志）
 */
export function resolveAcceptanceFailureMemory(
  db: Database.Database,
  memory: AcceptanceMemoryApi,
  projectId: string,
  title: string,
  taskId: string,
  now: Date = new Date(),
): boolean {
  if (!projectId || !title) return false;
  const at = now.toISOString();
  const taskMarker = `任务「${title}」`;
  const resolvedMarker = `[已解除] ${taskMarker}于 ${at} 通过验收`;
  let changed = false;
  for (const mem of memory.retrieveByType('acceptance_failure', projectId, 5)) {
    if (!mem.content.includes(taskMarker)) continue;
    if (mem.content.includes(`[已解除] ${taskMarker}`)) continue;
    memory.updateMemory(mem.id, `${mem.content}\n${resolvedMarker}（原失败原因仅作历史）`, mem.reasoning ?? '');
    try {
      // 只写这一格：`context_json.acceptance_resolved[<taskId>] = <at>`（json_set 保留兄弟键）。
      const jsonPath = `$.acceptance_resolved."${String(taskId).replace(/"/g, '')}"`;
      db.prepare("UPDATE wa_memories SET context_json = json_set(COALESCE(context_json, '{}'), ?, ?) WHERE id = ?")
        .run(jsonPath, at, mem.id);
    } catch { /* 上下文写失败不影响正文解除 */ }
    changed = true;
  }
  return changed;
}
