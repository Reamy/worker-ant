/**
 * 完成事件收口：**发一次**（同一 run 幂等）+ **问一次**（这一笔到底落没落库）。
 *
 * zx_20261119_1 M1「迹」：`task.completed` 有两个发射出口（finalize 收口 / run_close 收口），
 * 此前两处各写一段"发射 + 静默 catch"——判"本 run 已发过"的分支完全无声，真库标本 `91dfe739`
 * 完成态无事件、账上无任何说明。本模块把两出口的同一件事收成一处：
 *   · `emitCompletionEvent`：`claimCompletedEmit` 不放行时记 warn（带 run_id 与已见 run 列表），
 *     发射 rejection 记 error（不再 `.catch(() => {})` 吞掉）；
 *   · `verifyCompletionEvent`：收口后只读一条索引查询问"落没落库"，缺则 error + system 会话行。
 *
 * ⚠ 判据只认 `task.completed`（不认 `task.status_changed` 顶替）——与 `architectural-invariants`
 *   的 `task-completion-audit` 同一把尺，两处不各写一版。
 * ⚠ 抽成模块的另一个理由：`agent-executor.ts` 有"行数 < 4000"的架构自检（R-75a），
 *   两出口内联会把执行体顶破阈值；此处也是"执行体只保留编排"的应有之义。
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { eventBus } from './event-bus.js';
import { claimCompletedEmit, completedEmitDecision, type CompletedEmitContext } from './run-trace.js';
import { buildTaskOutcome, hasCompletionEvent } from './task-outcome.js';
import { createLogger } from './logger.js';

const logger = createLogger('completion-emit');

export type CompletionEmitTag = 'finalize_task' | 'run_close';

export interface CompletionEmitInput {
  db: Database.Database;
  ctx: CompletedEmitContext;
  taskId: string;
  projectId: string | null;
  fileMutationCount: number;
  /** 验收三态之一；无账则传 `undefined`（"没这笔账"≠"账上是未通过"） */
  acceptance?: unknown;
  tag: CompletionEmitTag;
}

/** 发一次 `task.completed`（同一 run 只发一次），两条失败路径都留痕。 */
export function emitCompletionEvent(input: CompletionEmitInput): void {
  const { db, ctx, taskId, projectId, fileMutationCount, acceptance, tag } = input;
  if (claimCompletedEmit(ctx)) {
    eventBus
      .emit('task.completed', {
        taskId,
        task_id: taskId,
        projectId,
        run_id: ctx.runId,
        ...buildTaskOutcome(db, taskId, fileMutationCount),
        acceptance,
      })
      .catch((err) => logger.error({ err, taskId, runId: ctx.runId, tag }, '完成事件发射失败'));
    return;
  }
  const decision = completedEmitDecision(ctx);
  logger.warn({ taskId, runId: decision.id, seen: decision.seen, tag }, '完成事件判定为本 run 已发过，未再发');
}

/**
 * 收口自检：`task.completed` 是否已落库。缺则 error 日志 + 一条**用户可见**的 system 会话行。
 * 自检失败不阻断收口（事件仍可能已落库）。
 */
export function verifyCompletionEvent(
  input: Pick<CompletionEmitInput, 'db' | 'ctx' | 'taskId' | 'tag'>,
): void {
  const { db, ctx, taskId, tag } = input;
  try {
    if (hasCompletionEvent(db, taskId)) return;
    logger.error({ taskId, runId: ctx.runId, tag }, '完成事件未落库（收口自检）');
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))",
    ).run(
      crypto.randomUUID(),
      taskId,
      `[完成事件缺失] 任务已置完成，但本 run 的 task.completed 未落库（run ${String(ctx.runId || '').slice(0, 8)}）——请查事件总线；可到运维看板按清单回填。`,
    );
  } catch {
    /* 自检失败不阻断收口 */
  }
}
