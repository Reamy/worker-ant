/**
 * zx_20261011_4 M2（维特根斯坦·意义即使用 / 道德经·知止）: 跨机**编排**的右半场——
 *   把"已外派他机"的本地子任务**读回**并**收口**：远端 `done` ⇒ 本地子任务真 `completed` ∧ 真写回传结果
 *   ∧ 真走既有 `checkParentTaskAfterChildDone` 让父任务真恢复；远端 `error` ⇒ 本地如实 `failed`。
 *
 * 病根（`plans/improve/zx_20261011_4.md` §哲学三源「意义即使用」）：外派若只打了个「已外派」的标、
 *   远端却从不回流，那不是外派，是**假装外派**。判据是**端到端**（本地任务树真的动了），不是"键写进去了"。
 *
 * ⚠ 本模块**不触网**：`io` / `emit` / `enqueue` 皆可注入（真机＝`makeAnsDispatchIo` / `eventBus.emit` /
 *   `enqueueJob`；回归喂假），故受控回归可不出网直跑真实现（同 `node-dispatcher.ts` 纪律）。
 * ⚠ **永不抛**：失败装进返回值（`errors` 计数 + 逐条 `logger.warn`），由调用方（心跳拍）自行决定下一步。
 * ⚠ 状态写一律 **CAS**（`WHERE id=? AND status='pending'`）——心跳与人工操作可能并发，`changes=0` 即
 *   "已被别的路处理"，本拍**不再落账**（幂等；防同一单被读回多次时重复 emit / 重复恢复父）。
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { refreshDispatchResult, type DispatchIo, type DispatchEventSink } from './node-dispatcher.js';
import {
  REMOTE_ASSIGN_AT_KEY,
  REMOTE_ASSIGN_NODE_KEY,
  REMOTE_ASSIGN_REQUEST_KEY,
  REMOTE_RESULT_AT_KEY,
  REMOTE_RESULT_KEY,
  REMOTE_SUMMARY_KEY,
  clearRemoteAssigned,
  remoteAssignOf,
  type OrchestrateDb,
} from './node-orchestrate.js';
import { checkParentTaskAfterChildDone } from './jobs/ai-task.js';
import { scheduleDependentDispatch } from './collab-dispatch.js';
import { buildTaskOutcome } from './task-outcome.js';
import { enqueueJob } from './job-enqueuer.js';
import { markTaskFailed, type TaskTerminalDb } from './task-terminal.js';

const logger = createLogger('node-remote-driver');

/**
 * 外派**等远端回传**的上限（毫秒）。取"relay 侧上限 10min + 余量"（见方案 §5 风险）：
 *   远端若在 relay 上限 10min 内自决，本侧 15min 足够收；超过仍非终态（对端崩/断网）⇒ **撤归属**退回本地。
 *   ⚠ 上限取固定值（非可调）：本轮只打编排一处，不引入新设置面；如实边界写入日志。
 */
export const REMOTE_ASSIGN_TIMEOUT_MS = 15 * 60 * 1000;

/** 事件出口（真机＝`eventBus.emit`）——收 `task.*` 与 `node.request_*` 两类；回归喂假。 */
export type DriverEventSink = (type: string, data: Record<string, unknown>) => unknown;

export interface DriveRemoteDeps {
  /** 注入 IO（缺省懒建真实现 `makeAnsDispatchIo(db)`，经 `refreshDispatchResult` 内的解析）。 */
  io?: DispatchIo;
  /** 注入事件出口（缺省懒取 `eventBus.emit`）。 */
  emit?: DriverEventSink;
  /** 父任务恢复所需的入队出口（缺省＝`enqueueJob` 写库 + 入调度器内存队列）。 */
  enqueue?: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  /** `now` 注入（回归不依赖墙钟；缺省 `Date.now`）。 */
  now?: () => number;
  /** 超时上限覆盖（回归免等 15min；缺省 `REMOTE_ASSIGN_TIMEOUT_MS`）。 */
  timeoutMs?: number;
}

/** 一拍驱动结局（供 rr 正面断言与日志）。 */
export interface DriveRemoteResult {
  /** 本拍扫到的"已外派"子任务数。 */
  checked: number;
  /** 远端 `done` ⇒ 本地置 `completed` 的条数。 */
  completed: number;
  /** 远端 `error` ⇒ 本地置 `failed` 的条数。 */
  failed: number;
  /** 超时撤归属退回 `pending` 的条数。 */
  reclaimed: number;
  /** 读回失败（网络/凭据）——本拍**不动**该任务，下拍再试的条数。 */
  errors: number;
}

/** 懒取事件出口——只在没注入时才引 eventBus（保持本模块 import 图不绑死总线）。 */
async function resolveEmit(injected?: DriverEventSink): Promise<DriverEventSink> {
  if (injected) return injected;
  const { eventBus } = await import('./event-bus.js');
  return (type, data) => eventBus.emit(type as Parameters<typeof eventBus.emit>[0], data);
}

/**
 * 列本项目里"已外派 ∧ 仍 `pending`"的子任务——**SQL 粗筛 + 解析精判**（同 `countRemoteAssignedPending` 手法）。
 * 粗筛用 `LIKE '%assigned_request_id%'` 只为**少读几行**；真判一律由 `remoteAssignOf` 定（不把"含子串"当外派）。
 */
function listRemoteAssignedPending(db: Database.Database): Array<{ id: string; project_id: string; context_json: string | null }> {
  try {
    return db
      .prepare(
        "SELECT id, project_id, context_json FROM wa_tasks WHERE status = 'pending' AND context_json LIKE ?",
      )
      .all(`%${REMOTE_ASSIGN_REQUEST_KEY}%`) as Array<{ id: string; project_id: string; context_json: string | null }>;
  } catch {
    return [];
  }
}

/** 读-改-写整份 context_json（与 `node-orchestrate` 同一 RMW 纪律：不抹兄弟键）。成功 ⇒ true。 */
function patchContext(db: Database.Database, taskId: string, patch: Record<string, unknown>): boolean {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: unknown } | undefined;
    if (!row) return false;
    let ctx: Record<string, unknown> = {};
    try {
      const raw = row.context_json;
      const s = raw == null ? '' : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
      const o = s ? JSON.parse(s) : null;
      if (o && typeof o === 'object' && !Array.isArray(o)) ctx = o as Record<string, unknown>;
    } catch { /* 坏 JSON 当空对象（不把"读不成"当成"有值"） */ }
    Object.assign(ctx, patch);
    const r = db
      .prepare("UPDATE wa_tasks SET context_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(ctx), taskId) as { changes?: number } | undefined;
    return (r?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** 落一条 system 会话记录（如实登记——与 `exec-finalize` 同形）。 */
function appendSystemNote(db: Database.Database, taskId: string, content: string): void {
  try {
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))",
    ).run(crypto.randomUUID(), taskId, content);
  } catch { /* 会话记录缺失不该改收口结局 */ }
}

/** 从远端 `result` 摘一句**人话摘要**（供父任务逐子简报与面板下钻；取不出则如实说明）。 */
function summarizeResult(status: string, result: Record<string, unknown> | null): string {
  if (!result) return `远端 ${status}（无回传摘要）`;
  const err = result.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  const ts = result.taskStatus;
  if (typeof ts === 'string' && ts.trim()) return `远端任务态：${ts.trim()}`;
  try {
    const s = JSON.stringify(result);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return `远端 ${status}（回传摘要不可序列化）`;
  }
}

/** 归属时刻（ISO8601）是否已超上限；解析不出时刻 ⇒ **不判超时**（不把"读不成"当成"超时了"）。 */
function isTimedOut(assignedAt: string, nowMs: number, timeoutMs: number): boolean {
  if (!assignedAt) return false;
  const t = Date.parse(assignedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > timeoutMs;
}

/**
 * 驱动一拍：把本项目"已外派他机"的 `pending` 子任务逐个读回并收口。**永不抛**。
 *
 * 逐条处置（承方案 §批二）：
 *   - `done` ⇒ CAS 置 `completed`（命中才落账）→ 写回传摘要进 context → system 会话留痕 →
 *     emit `task.completed`（满足 invariant #1：completed 必有事件）→ 既有 `checkParentTaskAfterChildDone` 恢复父。
 *   - `error`（且非"等作答"）⇒ CAS 置 `failed`（如实）→ emit `task.failed` → 父按既有 children-gate 处置（不静默恢复）。
 *   - `error` ∧ `question_status='asked'`（B 端在问）⇒ **非终态**，不动（等作答；与 `refreshDispatchResult` 同判据）。
 *   - `pending`/`assigned`/`awaiting_answer` ⇒ 非终态，不动。
 *   - **超时**（`now - assignedAt > 上限` ∧ 仍非终态）⇒ `clearRemoteAssigned` 退回 `pending` + 留痕（知止：不无限等一个可能已死的对端）。
 *
 * 读回失败（`errors`）⇒ 本拍**不动**（下拍再试；超时兜底仍会把它收回）。
 */
export async function driveRemoteSubtasks(db: Database.Database, deps: DriveRemoteDeps = {}): Promise<DriveRemoteResult> {
  const out: DriveRemoteResult = { checked: 0, completed: 0, failed: 0, reclaimed: 0, errors: 0 };
  const nowMs = () => (deps.now ? deps.now() : Date.now());
  const timeoutMs = deps.timeoutMs ?? REMOTE_ASSIGN_TIMEOUT_MS;

  const rows = listRemoteAssignedPending(db);
  if (rows.length === 0) return out;

  const emit = await resolveEmit(deps.emit);
  const enqueue = deps.enqueue
    ?? (async (type: string, payload: Record<string, unknown>) => { enqueueJob(db, type, payload); return ''; });

  for (const row of rows) {
    const taskId = row.id;
    const assign = remoteAssignOf(row.context_json);
    if (!assign) continue; // 粗筛误捞（含子串但非外派）——精判否决，不动
    out.checked++;

    let read;
    try {
      read = await refreshDispatchResult(db, assign.requestId, { ...(deps.io ? { io: deps.io } : {}), ...(deps.emit ? { emit: deps.emit as DispatchEventSink } : {}) });
    } catch (e) {
      out.errors++;
      logger.warn({ taskId, requestId: assign.requestId, err: (e as Error)?.message }, '读回外派结果失败（本拍不动，下拍再试）');
      continue;
    }

    // 读不回（网络/凭据）⇒ 本拍不动（下拍再试）；超时兜底仍在下方（但此处无 request ⇒ 只能等下一拍读到）
    if (!read.ok || !read.request) {
      out.errors++;
      // 读不回也可能超时——但本轮保守：读不回时**不撤归属**（可能是本机网络抽风而远端在跑），
      //   只留痕。超时撤归属只在"真读到非终态"时进行（宁可多等一拍，不误收正在跑的远端活）。
      logger.warn({ taskId, requestId: assign.requestId, note: read.note }, '读回外派结果未果（本拍不动，下拍再试）');
      continue;
    }

    const req = read.request;

    if (req.status === 'done') {
      const cas = db
        .prepare("UPDATE wa_tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(taskId) as { changes?: number };
      if ((cas?.changes ?? 0) === 0) continue; // 已被别的路处理（幂等：不再落账）
      out.completed++;
      const summary = summarizeResult('done', req.result);
      // 先写 context（含 `completion_summary` ⇒ 父任务逐子简报取得到），再恢复父。
      patchContext(db, taskId, {
        [REMOTE_RESULT_KEY]: req.result,
        [REMOTE_SUMMARY_KEY]: summary,
        [REMOTE_RESULT_AT_KEY]: new Date(nowMs()).toISOString(),
      });
      appendSystemNote(db, taskId, `[协同·远端完成] 子任务已由他机（${assign.nodeId.slice(0, 8)}）执行并回传 done。**远端自报完成，本机未复核**（如实边界）。回传摘要：${summary}`);
      try {
        await emit('task.completed', { taskId, task_id: taskId, projectId: row.project_id, ...buildTaskOutcome(db, taskId, 0), remote_result: req.result ?? undefined });
      } catch { /* 事件失败不该改收口结局 */ }
      try { checkParentTaskAfterChildDone(db, taskId, { enqueue }); } catch { /* 放行父失败不阻断本子收口 */ }
      // zx_20261023_5 批一：上游在本机到站 ⇒ 依赖它的后继**重新走一次派发决策**（有依赖也照样能跨机）。
      //   与本地完成处共用同一个触发口；开关未开时一次库查询后即返回，不发网络请求。
      scheduleDependentDispatch(db, taskId);
      logger.info({ taskId, requestId: req.id, nodeId: assign.nodeId }, '远端 done ⇒ 本地子任务已置 completed 并放行父任务');
      continue;
    }

    if (req.status === 'error' && req.question_status !== 'asked') {
      // 走**唯一写手**（`markTaskFailed`）而非手写 SQL：`failed` 全树一个落笔口，同一个 CAS 语义
      //   （`expectStatus:'pending'` ⇒ `WHERE id=? AND status='pending'`）**外加**翻掉上一次 run 的判卷
      //   （G12「账要能自己翻篇」——一次远端失败不被读成"质量 90 分"）。手写一句 SQL 即弄红 M6-A。
      // 批五 M5: 因由先算、随翻状态交出（失败 IM 由 `markTaskFailed` 一处发）——不依赖下面那条
      //   `task.failed` 事件经投影器绕一圈（投影器在 rr/未注册场景缺席，而通知不该因此丢）。
      const summary = summarizeResult('error', req.result);
      const failed = markTaskFailed(db as unknown as TaskTerminalDb, taskId, { expectStatus: 'pending', reason: summary });
      if (!failed.changed) continue; // 已被别的路处理（幂等）
      out.failed++;
      patchContext(db, taskId, { [REMOTE_RESULT_KEY]: req.result, [REMOTE_RESULT_AT_KEY]: new Date(nowMs()).toISOString() });
      appendSystemNote(db, taskId, `[协同·远端失败] 子任务由他机（${assign.nodeId.slice(0, 8)}）执行后回传 error，本机如实置 failed。回传：${summary}`);
      try {
        await emit('task.failed', { taskId, task_id: taskId, projectId: row.project_id, error: summary, phase: 'remote' });
      } catch { /* 同上 */ }
      try { checkParentTaskAfterChildDone(db, taskId, { enqueue }); } catch { /* 有失败子 ⇒ 该函数只升级父的暂停因，不静默恢复 */ }
      logger.warn({ taskId, requestId: req.id, nodeId: assign.nodeId }, '远端 error ⇒ 本地子任务已置 failed');
      continue;
    }

    // 非终态（pending/assigned/awaiting_answer，或 error∧等作答）⇒ 超时才收（知止：不无限等）
    if (isTimedOut(assign.assignedAt, nowMs(), timeoutMs)) {
      if (clearRemoteAssigned(db as unknown as OrchestrateDb, taskId)) {
        out.reclaimed++;
        const mins = Math.round(timeoutMs / 60000);
        patchContext(db, taskId, { remote_reclaimed_at: new Date(nowMs()).toISOString() });
        appendSystemNote(db, taskId, `[协同·超时收回] 外派给 ${assign.nodeId.slice(0, 8)} 的子任务已等待超过 ${mins} 分钟仍未回传终态（对端崩/断网/慢），已**撤回外派归属**、退回本机调度。远端若稍后回传，本机不再据此改状态（该子任务已按本地路径重跑）。`);
        logger.warn({ taskId, requestId: req.id, nodeId: assign.nodeId, status: req.status, timeoutMs }, '外派超时 ⇒ 撤归属退回本机调度');
      }
    }
  }

  return out;
}

/** 供调试/回归读取三键名（避免测试重复字面量）。 */
export const REMOTE_DRIVER_KEYS = { node: REMOTE_ASSIGN_NODE_KEY, request: REMOTE_ASSIGN_REQUEST_KEY, at: REMOTE_ASSIGN_AT_KEY } as const;
