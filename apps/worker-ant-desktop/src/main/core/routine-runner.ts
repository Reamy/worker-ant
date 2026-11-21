/**
 * zx_20261120_1 M2「例·跑」：岗位例行的**触发执行体**（建单 + 留痕 + 入队）。
 *
 * 只做三件事：现读事实 → 五态判据 → 建一条普通任务并入队。
 * 不拆解、不审批、不执行——那些仍走既有 `ai-task` 链路。
 *
 * 纪律：
 *   · 跳过也留痕（`wa_position_routine_runs.status='skipped'` + 原因），看板能说「这次为什么没跑」。
 *   · 同 `period_key` 只建一次（唯一键兜底；判据先查一次，避免把唯一冲突当业务异常）。
 *   · 入队失败**不谎报成功**：任务与运行账已落库（如实留账），结果回 `ok:false`。
 *   · 零 electron / 零网络；`enqueue` 由调用方注入，rr 直接跑真逻辑。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  createRoutineTask,
  getRoutine,
  periodDuplicate,
  periodKeyOf,
  previousRunOpen,
  recordRoutineSkip,
  routineBindingVerdict,
  routineFireDecision,
  updateRoutineRunForTask,
  type RoutineSkipReason,
} from './position-routines.js';

export interface RoutineRunResult {
  ok: boolean;
  taskId: string;
  runId: string;
  skipped: RoutineSkipReason | null;
  reason: string;
}

export interface RoutineRunOpts {
  trigger: 'schedule' | 'manual';
  /** 触发时刻（缺省 now）；定时路由 node-cron 给出，手动路由调用方给。 */
  fireAt?: Date | number | string;
  /** 入队（真机＝`enqueueJob(db,'ai-task',…)`；rr 喂桩）。 */
  enqueue: (taskId: string, projectId: string) => void;
  /** 注入时钟（ISO），rr 用。 */
  nowIso?: string;
}

/**
 * 跑一条例行。**永不抛**：失败装进 `{ok:false, reason}`。
 *
 * 期次键：定时按 cron 粒度取桶；手动用 `manual:<ISO>:<短随机>`——
 *   手动是「用户现在就要跑一次」，不受「本期已跑过」限制；但**仍受上一单在跑限制**（不叠单）。
 */
export function runRoutine(db: Database.Database, routineId: string, opts: RoutineRunOpts): RoutineRunResult {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const fail = (reason: string): RoutineRunResult => ({ ok: false, taskId: '', runId: '', skipped: null, reason });
  try {
    const routine = getRoutine(db, routineId);
    if (!routine) return fail('not_found');

    const fireAt = opts.fireAt ?? nowIso;
    const periodKey = opts.trigger === 'manual'
      ? `manual:${new Date(fireAt).toISOString()}:${randomUUID().slice(0, 8)}`
      : periodKeyOf(routine.cron, fireAt);
    if (!periodKey) return fail('bad_fire_time');

    const bind = routineBindingVerdict(db, routine.position_id, routine.project_id);
    const projectStatus = (db.prepare('SELECT status FROM wa_projects WHERE id = ?').get(routine.project_id) as { status?: string } | undefined)?.status ?? '';
    const facts = {
      routineEnabled: Number(routine.enabled) === 1,
      projectStatus,
      positionEnabled: bind.reason !== 'position_disabled',
      bindingEnabled: bind.reason !== 'binding_disabled',
      previousRunOpen: previousRunOpen(db, routine.id),
      periodDuplicate: opts.trigger === 'schedule' ? periodDuplicate(db, routine.id, periodKey) : false,
    };
    const decision = routineFireDecision(facts, periodKey);
    if (!decision.ok) {
      const skipped = decision.skipReason ?? 'period_duplicate';
      // 同期重复不再写第二行（唯一键会挡住，且重复触发不该放大台账）。
      if (skipped !== 'period_duplicate') recordRoutineSkip(db, routine.id, periodKey, skipped, nowIso);
      return { ok: false, taskId: '', runId: '', skipped, reason: skipped };
    }

    const created = createRoutineTask(db, routine, periodKey, nowIso);
    if (!created.ok) {
      return { ok: false, taskId: created.taskId, runId: created.runId, skipped: null, reason: created.reason };
    }
    try {
      opts.enqueue(created.taskId, routine.project_id);
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).trim() || 'enqueue_failed';
      // 任务与运行账已落库——如实回失败，让调用方可重试入队/人工处理；不删账。
      return { ok: false, taskId: created.taskId, runId: created.runId, skipped: null, reason: `enqueue_failed: ${why}` };
    }
    return { ok: true, taskId: created.taskId, runId: created.runId, skipped: null, reason: '' };
  } catch (e) {
    return fail((e instanceof Error ? e.message : String(e)).trim() || 'unknown_error');
  }
}

/** 任务到终态时回填运行账（由收口出口旁路调用；无对应 run 行时为 0，不抛）。 */
export function backfillRoutineRunForTask(db: Database.Database, taskId: string, status: string): number {
  return updateRoutineRunForTask(db, taskId, status);
}
