/**
 * zx_20261121_1 M7「用·采」：**采纳项目预算**的唯一写口。
 *
 * 病根（真库 2026-11-21）：预算仍按 `ARCHETYPE_BUDGETS` 静态值；项目经验账给出 p90 后，
 *   用户需要一个“点一下把建议落到项目级上限”的动作。这个动作**只改一个键**
 *   （`context_json.budget.max_tokens_per_task`），兄弟键（cron/附件/目标/方案）必须原地保留。
 *
 * 三条纪律：
 *   ① **只改一个键**：`json_set` 单键，不整体覆写 `context_json`（承 `feedback_json_column_overwrite_wipes_siblings`）；
 *   ② **不自动调用**：只由人点采纳；本模块不做任何“按经验自动调预算”的判断；
 *   ③ **校验在写前**：非整数/越界/项目不存在 ⇒ 如实拒，零写入。
 *
 * 零 electron / 零网络；rr 可拿内存库直跑真实现。
 */
export interface ProjectBudgetDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes?: number };
  };
}

export type AdoptBudgetResult =
  | { ok: true; previous: number | null; next: number }
  | { ok: false; code: 'BAD_INPUT' | 'NOT_FOUND' | 'INTERNAL'; message: string };

export const ADOPT_BUDGET_MIN = 1;
export const ADOPT_BUDGET_MAX = 20_000_000;

export function adoptProjectBudget(
  db: ProjectBudgetDb,
  input: { projectId: string; maxTokens: number },
): AdoptBudgetResult {
  const pid = String(input.projectId ?? '').trim();
  const n = Number(input.maxTokens);
  if (!pid) return { ok: false, code: 'BAD_INPUT', message: '缺少项目 id' };
  if (!Number.isInteger(n) || n < ADOPT_BUDGET_MIN || n > ADOPT_BUDGET_MAX) {
    return { ok: false, code: 'BAD_INPUT', message: `预算须为 ${ADOPT_BUDGET_MIN}..${ADOPT_BUDGET_MAX} 的整数` };
  }
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(pid) as { context_json?: string } | undefined;
    if (!row) return { ok: false, code: 'NOT_FOUND', message: '项目不存在' };
    const prevRow = db.prepare("SELECT json_extract(context_json,'$.budget.max_tokens_per_task') AS prev FROM wa_projects WHERE id = ?")
      .get(pid) as { prev?: number | null } | undefined;
    const previous = prevRow?.prev == null ? null : Number(prevRow.prev);
    db.prepare(
      "UPDATE wa_projects SET context_json = json_set(COALESCE(context_json,'{}'), '$.budget.max_tokens_per_task', ?), updated_at = datetime('now') WHERE id = ?",
    ).run(n, pid);
    return { ok: true, previous, next: n };
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: (e as Error)?.message || String(e) };
  }
}
