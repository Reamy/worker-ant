/**
 * zx_20261105_1 M4（维特根斯坦·意义即用法 / 道德经·少则得）：`context_json` 的**合并写口**。
 *
 * 病根：`context_json` 是高频读改写热点，各处裸对象整体覆写会静默抹掉兄弟键（附件/目标/方案）。
 * 本仓已三次复发（control/executor/retry）。新键（`subagent_result`、后续 M6 的判据候选等）
 * 一律经本模块写入：读最新值 → 浅合并非 `undefined` 键 → **CAS 一条 UPDATE**。
 *
 * 边界：坏 JSON 不当新账的底座（返回 false，不覆盖别人的东西）；CAS 未命中（并发写过）有界重试；
 * 只写 `context_json`，不动状态/时刻（与既有上下文写口同口径）。
 */
import type Database from 'better-sqlite3';

/** 纯合并：基底不是对象时按空对象处理；patch 里值为 `undefined` 的键视为「未提供」，不抹掉已有账。 */
export function applyContextPatch(
  current: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 读最新上下文 → 合并 → 一次 UPDATE。返回是否写成功（无变化也算成功；坏账/无此行返回 false）。
 * CAS 用 `context_json IS ?`：SQLite 的 `IS` 对 NULL 也成立，故空账与字符串账都能比。
 */
export function mergeTaskContext(
  db: Database.Database,
  taskId: string,
  patch: Record<string, unknown>,
): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let row: { context_json?: string | null } | undefined;
    try {
      row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as
        | { context_json?: string | null }
        | undefined;
    } catch {
      return false;
    }
    if (!row) return false;
    const raw = row.context_json ?? null;
    let current: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      current = parsed as Record<string, unknown>;
    } catch {
      return false; // 坏账宁可不动，也不拿它当底座把别的账覆盖掉
    }
    const nextJson = JSON.stringify(applyContextPatch(current, patch));
    if (nextJson === (raw ?? '{}')) return true;
    try {
      const res = db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ? AND context_json IS ?')
        .run(nextJson, taskId, raw);
      if (((res as { changes?: number })?.changes ?? 0) > 0) return true;
    } catch {
      return false;
    }
  }
  return false;
}
