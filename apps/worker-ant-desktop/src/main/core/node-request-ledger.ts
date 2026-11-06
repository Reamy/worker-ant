/**
 * zx_20261027_3 M2「一单一跑」：跨机请求的**执行账**（零 electron、零网络的最小库接口）。
 *
 * 病：`node-request-worker` 对**同一 `req.id`** 是"至少一次"语义——回传失败后下一轮会重拉、重跑，
 *   于是同一件活可能建出两行任务（用户看到两份产出、两份消耗）。ANS 侧只在**回传成功**时才置终态，
 *   它挡不住这一侧的重建。故本侧必须有"这件 `req.id` 已经跑过、跑成了什么"的账。
 *
 * 判据（唯一真源在本模块）：
 *   - `running`：已建任务、正在等终态；
 *   - `done` / `error` / `cancelled`：任务已收口且结果**已写入**——重拉时**原样重放**，绝不重建；
 *   - `run_lost`：账说在跑、任务行却没了（进程崩溃/手工删任务）——如实标记后**允许重建一次**。
 *
 * ⚠ 回传失败**不改账**：账记的是"本机跑成了什么"，与"ANS 收没收到"是两件事；回传失败时账仍是
 *   `done/error/cancelled`，下一轮重拉照样重放同一结果——这正是"第二次返回同一 taskId"的来源。
 * ⚠ zx_20261030_1 M3：`cancelled` 是**派活方叫停后真停**的收口（任务已归档），与 `error` 分开记——
 *   重放时如实回 `cancelled`，不把"停"冒充成"失败"或"完成"。
 */

export type NodeRequestRunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'run_lost';

export interface NodeRequestRunRow {
  request_id: string;
  task_id: string;
  status: NodeRequestRunStatus;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

/** 最小库接口（`better-sqlite3` 与 `node:sqlite` 都满足；受控回归可直跑真实现）。 */
export interface NodeRequestLedgerDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
  exec(sql: string): unknown;
}

/** 幂等建表（生产在 `makeRelayRunner` 起手时调用；回归夹具可直接调用）。 */
export function ensureNodeRequestRunsTable(db: NodeRequestLedgerDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_node_request_runs (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export function findNodeRequestRun(db: NodeRequestLedgerDb, requestId: string): NodeRequestRunRow | null {
  const row = db
    .prepare('SELECT request_id, task_id, status, result_json, created_at, updated_at FROM wa_node_request_runs WHERE request_id = ?')
    .get(requestId) as NodeRequestRunRow | undefined;
  return row ?? null;
}

/** 记下"这个 req.id 由这个 taskId 承担"，状态置 `running`（`run_lost` 行可被同一 upsert 重建）。 */
export function beginNodeRequestRun(db: NodeRequestLedgerDb, requestId: string, taskId: string): void {
  db.prepare(
    `INSERT INTO wa_node_request_runs (request_id, task_id, status, result_json, created_at, updated_at)
     VALUES (?, ?, 'running', NULL, datetime('now'), datetime('now'))
     ON CONFLICT(request_id) DO UPDATE SET
       task_id = excluded.task_id,
       status = 'running',
       result_json = NULL,
       updated_at = datetime('now')`,
  ).run(requestId, taskId);
}

export function finishNodeRequestRun(
  db: NodeRequestLedgerDb,
  requestId: string,
  status: 'done' | 'error' | 'cancelled',
  result: Record<string, unknown>,
): void {
  db.prepare(
    `UPDATE wa_node_request_runs
        SET status = ?, result_json = ?, updated_at = datetime('now')
      WHERE request_id = ?`,
  ).run(status, JSON.stringify(result), requestId);
}

/** 账在跑、任务行却没了 ⇒ 只改状态，保留 task_id 供事后追查；下一次 `begin` 才换号。 */
export function markNodeRequestRunLost(db: NodeRequestLedgerDb, requestId: string): void {
  db.prepare("UPDATE wa_node_request_runs SET status = 'run_lost', updated_at = datetime('now') WHERE request_id = ?").run(
    requestId,
  );
}
