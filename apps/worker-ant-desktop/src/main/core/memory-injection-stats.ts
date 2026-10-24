/**
 * zx_20261018_3 批一（维特根斯坦·意义即用法 / 管子·度量衡）: **注入账的读者**。
 *
 * 病根：`wa_context_injections` 早已把每次注入记成明细账，但 `source='memory'` 的行**全仓无人读**
 * ——账写了、没读者，等于没写。本模块给记忆页和 rr 一个统一的读口：
 *   · `injected`        = 注入行数（记忆·次；同一任务重复注入按唯一键只留一行，与写口同尺）
 *   · `distinctMemories`= 被注入过的**不同记忆**条数
 *   · `usedTimes`       = 这些记忆的 `use_count` 之和（**主动引用**，与注入分账）
 *   · 结局三态           = completed / failed / pending（由 `backfillInjectionOutcomes` 回填）
 *
 * 口径与 `knowledgeInjectionStats` 对称：都按 `task_id` 归到项目；本函数只看 `source='memory'`。
 * 纯 SQL、零 electron 依赖（rr 直跑）。
 */
import type Database from 'better-sqlite3';

export interface MemoryInjectionStats {
  /** 注入行数（记忆·次）。 */
  injected: number;
  /** 被注入过的不同记忆条数。 */
  distinctMemories: number;
  /** 这些记忆的主动引用次数之和（`use_count`）。 */
  usedTimes: number;
  completed: number;
  failed: number;
  pending: number;
}

type ReadDb = Pick<Database.Database, 'prepare'>;

export function memoryInjectionStats(db: ReadDb, projectId?: string): MemoryInjectionStats {
  const scope = projectId ? 't.project_id = ? AND ' : '';
  const params = projectId ? [projectId] : [];

  const outcomes = db.prepare(
    `SELECT ci.outcome AS outcome, COUNT(*) AS cnt
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE ${scope}ci.source = 'memory'
      GROUP BY ci.outcome`,
  ).all(...params) as Array<{ outcome: string | null; cnt: number }>;

  const distinct = db.prepare(
    `SELECT COUNT(DISTINCT ci.ref_id) AS n
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE ${scope}ci.source = 'memory'`,
  ).get(...params) as { n: number } | undefined;

  const used = db.prepare(
    `SELECT COALESCE(SUM(m.use_count), 0) AS n
       FROM (SELECT DISTINCT ci.ref_id AS id
               FROM wa_context_injections ci
               JOIN wa_tasks t ON t.id = ci.task_id
              WHERE ${scope}ci.source = 'memory') x
       JOIN wa_memories m ON m.id = x.id`,
  ).get(...params) as { n: number } | undefined;

  const stats: MemoryInjectionStats = {
    injected: 0,
    distinctMemories: Number(distinct?.n) || 0,
    usedTimes: Number(used?.n) || 0,
    completed: 0,
    failed: 0,
    pending: 0,
  };
  for (const r of outcomes) {
    const n = Number(r.cnt) || 0;
    stats.injected += n;
    if (r.outcome === 'completed') stats.completed += n;
    else if (r.outcome === 'failed') stats.failed += n;
    else stats.pending += n;
  }
  return stats;
}
