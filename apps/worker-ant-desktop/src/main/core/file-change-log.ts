/**
 * zx_20261118_1 「回」：任务完成态回看「文件变更」的**唯一取数面**。
 *
 * 病根：详情页的「实时文件变更」只累积实时事件，完成后再进页面 `fileStream` 为空；
 *   而三类文件事件早已随 `eventBus.emit()` 写进不可变日志 `wa_event_log`
 *   （`event-bus.ts` 的聚合映射 + `event-store.ts` 的 append），**数据一直都在**，
 *   缺的只是这条读路径。本模块只读、不新增存储、不改写入侧。
 *
 * 形状与实时转发**同形**：`src/main/index.ts` 的 `forwardToRenderer` 发的是
 *   `{ type, ...data }`，故这里返回 `{ type: event_type, ...payload, occurred_at }`，
 *   渲染层既有的 `FileChangeItem` 无需任何改动即可吃下（action/filePath/size/content/
 *   hunks/additions/deletions/truncated）。
 *
 * 口径（与运行中实时视图一致）：
 *   · 只认 `write_file`/`edit_file` 发出的三类事件；shell 落盘本就不发事件，不在本账。
 *   · 不按路径归并——每次编辑是一条，保留先后（实时视图也是逐事件累积）。
 *   · 只回**最近** `limit` 条（与渲染层实时流的 200 条上限同尺），`total` 如实计全量。
 *   · 脏行（`payload` 非 JSON，或合法 JSON 但缺 `filePath`）跳过该行，不抛、不影响其余行
 *     ——不编造、不整批失败，也不让渲染层画出"无文件名"的空条目。
 */
import type Database from 'better-sqlite3';

/** 三类文件事件（与 `event-bus.ts` 的聚合映射、`tools/write.ts` 的发点一一对应） */
export const FILE_CHANGE_EVENT_TYPES = ['file.created', 'file.updated', 'file.edited'] as const;

/** 回放显示上限：与渲染层实时流的 `prev.slice(-199)` 同尺（200 条） */
export const FILE_CHANGE_REPLAY_LIMIT = 200;

export interface FileChangeSnapshot {
  /** 时间升序的回放项：`{ type, ...payload, occurred_at }` */
  items: Array<Record<string, unknown>>;
  /** 该任务文件事件总条数（不受 limit 影响，供"共 N 条"如实披露） */
  total: number;
}

// 事件类型只有一处手写（上方常量）；SQL 列表由它派生，防"加了类型却漏改 SQL"的静默漂移。
const EVENT_LIST_SQL = `(${FILE_CHANGE_EVENT_TYPES.map((t) => `'${t}'`).join(',')})`;

/**
 * 取某任务的文件变更事件回放。
 *
 * @param limit 显示上限（默认 200）；传 0 或负数按默认值处理，避免空清单冒充"没有变更"。
 */
export function collectFileChangeEvents(
  db: Database.Database,
  taskId: string,
  limit: number = FILE_CHANGE_REPLAY_LIMIT,
): FileChangeSnapshot {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : FILE_CHANGE_REPLAY_LIMIT;
  let total = 0;
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM wa_event_log
        WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type IN ${EVENT_LIST_SQL}`,
    ).get(taskId) as { c: number } | undefined;
    total = Number(row?.c ?? 0);
  } catch {
    return { items: [], total: 0 };
  }
  if (total === 0) return { items: [], total: 0 };

  let rows: Array<{ event_type: string; payload: string; occurred_at: string }> = [];
  try {
    rows = db.prepare(
      `SELECT event_type, payload, occurred_at FROM wa_event_log
        WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type IN ${EVENT_LIST_SQL}
        ORDER BY id DESC LIMIT ?`,
    ).all(taskId, cap) as Array<{ event_type: string; payload: string; occurred_at: string }>;
  } catch {
    return { items: [], total };
  }

  const items: Array<Record<string, unknown>> = [];
  for (const r of rows.reverse()) {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(r.payload || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue; // 脏载荷跳过该行（不编造、不整批失败）
    }
    // 合法 JSON 但缺路径的脏行同样不进清单——渲染层会画出"无文件名"的空条目（方案 §5-3）。
    if (typeof payload.filePath !== 'string' || payload.filePath.length === 0) continue;
    items.push({ type: r.event_type, ...payload, occurred_at: r.occurred_at });
  }
  return { items, total };
}
