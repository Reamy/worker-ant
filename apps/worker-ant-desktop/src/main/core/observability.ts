/**
 * C2: 系统可观测性基础设施（从原工蚁 observability.ts 移植精简版）。
 * 基于事件日志的执行追踪 + 行为分析。
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

/**
 * zx_20261021_4 批六：一条执行事件里工具名的**合并标签**（去重、保持首次出现顺序）。
 *
 * 事件粒度从「每个工具调用一条」改为「每步一条」后，多个工具进同一格——去重合并，不重复列同一工具。
 * 纯文本步（无工具）如实标「（无工具）」，不冒充工具调用、也不留空让下游猜。
 */
export function stepEventToolLabel(toolCalls: readonly { toolName?: string }[] | null | undefined): string {
  const seen: string[] = [];
  for (const tc of toolCalls ?? []) {
    const n = String(tc?.toolName ?? '').trim();
    if (n && !seen.includes(n)) seen.push(n);
  }
  return seen.length > 0 ? seen.join('+') : '（无工具）';
}

/** C2.1: 写入 agent.step_executed 事件到事件日志 */
export function logStepExecution(
  db: Database.Database,
  taskId: string,
  projectId: string,
  step: { toolName: string; toolCallId?: string; duration?: number; tokens?: number },
): void {
  try {
    db.prepare(`
      INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, metadata, occurred_at)
      VALUES (?, 'agent.step_executed', 'task', ?, 0, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      taskId,
      JSON.stringify({ toolName: step.toolName, toolCallId: step.toolCallId || '', durationMs: step.duration || 0, tokens: step.tokens || 0 }),
      JSON.stringify({ project_id: projectId }),
      new Date().toISOString(),
    );
  } catch { /* best-effort */ }
}

/** C2.2: 获取任务的完整执行追踪 */
export function getExecutionTrace(db: Database.Database, taskId: string): Array<{ step: number; toolName: string; occurredAt: string; durationMs: number; tokens: number }> {
  try {
    const events = db.prepare("SELECT payload, occurred_at FROM wa_event_log WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type = 'agent.step_executed' ORDER BY id ASC").all(taskId) as Array<{ payload: string; occurred_at: string }>;
    return events.map((e, i) => {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload); } catch { /* */ }
      return { step: i + 1, toolName: (p.toolName as string) || 'unknown', occurredAt: e.occurred_at, durationMs: (p.durationMs as number) || 0, tokens: (p.tokens as number) || 0 };
    });
  } catch { return []; }
}

/** C2.3: 工具使用频次统计（最近N天） */
export function getToolFrequencyStats(db: Database.Database, days = 7): Array<{ toolName: string; count: number; avgTokens: number }> {
  try {
    return db.prepare(`
      SELECT json_extract(payload, '$.toolName') as toolName, COUNT(*) as count, AVG(COALESCE(json_extract(payload, '$.tokens'), 0)) as avgTokens
      FROM wa_event_log WHERE event_type = 'agent.step_executed' AND occurred_at >= datetime('now', ?)
      GROUP BY toolName ORDER BY count DESC
    `).all(`-${days} days`) as Array<{ toolName: string; count: number; avgTokens: number }>;
  } catch { return []; }
}

/** C2.4: 失败聚类统计（最近N天按工具名聚合失败） */
export function getFailureClusters(db: Database.Database, days = 14): Array<{ toolName: string; failCount: number }> {
  try {
    return db.prepare(`
      SELECT json_extract(payload, '$.toolName') as toolName, COUNT(*) as failCount
      FROM wa_event_log WHERE event_type = 'task.failed' AND occurred_at >= datetime('now', ?)
      GROUP BY toolName ORDER BY failCount DESC
    `).all(`-${days} days`) as Array<{ toolName: string; failCount: number }>;
  } catch { return []; }
}
