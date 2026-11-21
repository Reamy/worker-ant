/**
 * zx_20261116_2 M1「属」：产出物的**文件级归属**——复用 `wa_task_files`，不另造第二本账。
 *
 * 病根（真事故 2026-11-16）：`plans/backend/20261116-新后端易宝支付对接方案.md` 由 7 个任务写过，
 * 但 `wa_deliverables` 只有一行、owner 是 `7e60cf1c`；汇总子任务 `27c904d5` 与父任务 `18c076d9`
 * 编辑了它却没有自己的产出物行，于是：
 *   · 父任务 `finalize_task` 的检查 2 报 `[WARN] 无产出物`；
 *   · `completionCapFloors` 的 document 类无产出封顶可能误伤共享贡献者。
 *
 * 本模块只做**读**：
 *   · `deliverableContributors`：某件产出物的文件被哪些任务写过（来自 `wa_task_files`）；
 *   · `taskDeliverablePaths`：本任务写过哪些路径；
 *   · `taskDeliverableCounts`：本任务 own（名下登记）/ shared（写过的文件上、owner 不是本任务）各几件。
 *
 * 零 electron 依赖；rr 可直引。写侧仍由 `write_file`/`edit_file`/`register_deliverable` 的
 * `recordTaskFile` 记 `wa_task_files`——本模块不新增写口。
 */

export interface AttributionDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

/** 某件产出物（按 deliverable id）的文件被哪些任务写过；owner 恒在首位，读不到文件路径也返回 owner。 */
export function deliverableContributors(db: AttributionDb, deliverableId: string): string[] {
  try {
    const row = db.prepare('SELECT file_path, task_id FROM wa_deliverables WHERE id = ?').get(deliverableId) as { file_path?: string | null; task_id?: string | null } | undefined;
    const owner = row?.task_id ? String(row.task_id) : '';
    const path = row?.file_path;
    const writers = path
      ? (db.prepare('SELECT task_id FROM wa_task_files WHERE path = ? ORDER BY last_at ASC').all(path) as Array<{ task_id?: unknown }>)
        .map((r) => String(r.task_id ?? '')).filter(Boolean)
      : [];
    return [...new Set([owner, ...writers].filter(Boolean))];
  } catch {
    return [];
  }
}

/** 本任务写过的全部路径（`wa_task_files`，唯一写入账）。 */
export function taskDeliverablePaths(db: AttributionDb, taskId: string): string[] {
  try {
    const rows = db.prepare('SELECT path FROM wa_task_files WHERE task_id = ? ORDER BY last_at ASC').all(taskId) as Array<{ path?: unknown }>;
    return rows.map((r) => String(r.path ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 本任务的产出物计数：
 *   · `own`：`wa_deliverables.task_id = 本任务` 的行；
 *   · `shared`：本任务写过（`wa_task_files`）但 owner 不是本任务（含 owner 为空的手工成果）的行。
 * 两者用 `COUNT(DISTINCT d.id)`，同一路径多行也不会重复计。
 */
export function taskDeliverableCounts(db: AttributionDb, taskId: string): { own: number; shared: number } {
  try {
    const own = (db.prepare('SELECT COUNT(DISTINCT d.id) AS c FROM wa_deliverables d WHERE d.task_id = ?').get(taskId) as { c?: unknown } | undefined)?.c;
    const shared = (db.prepare(
      `SELECT COUNT(DISTINCT d.id) AS c FROM wa_deliverables d
       WHERE d.file_path IN (SELECT path FROM wa_task_files WHERE task_id = ?)
         AND (d.task_id IS NULL OR d.task_id != ?)`,
    ).get(taskId, taskId) as { c?: unknown } | undefined)?.c;
    return { own: Number(own) || 0, shared: Number(shared) || 0 };
  } catch {
    return { own: 0, shared: 0 };
  }
}

/** 本任务的贡献说明（`context_json.contribution`）形状。 */
export interface TaskContribution {
  files: string[];
  summary: string;
  source?: string;
  at?: string;
}

/**
 * 写本任务的贡献说明：文件来自 `wa_task_files`（唯一写入账），摘要由调用方给（finalize 的 summary /
 * update_task_status 的 reason）。用 `json_set` 只改这一格，保留 `task_goal`、`verification_*` 等兄弟键。
 */
export function recordContribution(db: AttributionDb, taskId: string, summary: string, source: string): void {
  try {
    const payload: TaskContribution = {
      files: taskDeliverablePaths(db, taskId),
      summary: String(summary ?? '').slice(0, 1000),
      source,
      at: new Date().toISOString(),
    };
    db.prepare(
      "UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json, '{}'), '$.contribution', json(?)) WHERE id = ?",
    ).run(JSON.stringify(payload), taskId);
  } catch { /* best-effort：贡献说明写不成不阻断收口 */ }
}

/** 读回贡献说明；缺键/坏 JSON ⇒ null（不编）。 */
export function readContribution(db: AttributionDb, taskId: string): TaskContribution | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string | null } | undefined;
    const c = JSON.parse(row?.context_json || '{}').contribution as Partial<TaskContribution> | undefined;
    if (!c || typeof c !== 'object') return null;
    return {
      files: Array.isArray(c.files) ? c.files.map(String) : [],
      summary: typeof c.summary === 'string' ? c.summary : '',
      source: typeof c.source === 'string' ? c.source : undefined,
      at: typeof c.at === 'string' ? c.at : undefined,
    };
  } catch {
    return null;
  }
}
