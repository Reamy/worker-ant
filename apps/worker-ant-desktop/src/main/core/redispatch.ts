/**
 * zx_20261101_2 M4（周易·穷则变 / 道德经·知止 / 毛选·没有调查没有发言权）:
 * **远端确认失败后的有界改派**——只对"已确认失败"（远端回传 error / 回执不符）换一台再派；
 *   超时不改派（没有调查没有发言权：对端可能还在跑），仍由远端驱动退回本机。
 *
 * 三条判据（次序即边界）：
 *   ① **有界**：首派 1 次 + 改派 ≤2 次（`REMOTE_DISPATCH_MAX`），超限如实交回原失败收口；
 *   ② **不重试同一台**：候选里剔除已试节点（尝试账）与本次失败节点；
 *   ③ **按同一把尺选人**：有项目分工 ⇒ 用 `buildDispatchPolicy` 的候选/倍率；
 *      无分工 ⇒ 台账里在线、可派、能力卡含该类目的对端。空候选 ⇒ 不改派（不硬塞给谁）。
 *
 * ⚠ 本模块**不触网**：`listLedger` / `io` / `emit` 皆可注入（真机＝`fetchNodes` / `makeAnsDispatchIo` /
 *   `eventBus.emit`；回归喂假）；`listLedger` **必填**——没有台账源就不改派（旧调用方行为不变）。
 * ⚠ **永不抛**：失败装进返回值；改派不成功时调用方仍按原逻辑把任务置 failed（本模块不改任务状态）。
 * ⚠ `context_json` 的写口一律在 `node-orchestrate.ts`（读-改-写整份，不抹兄弟键）。
 */
import type Database from 'better-sqlite3';
import type { NodeCardCategory, NodeDispatchPolicy } from '@worker-ant/shared-types';
import type { NodeLedger } from './node-list.js';
import { dispatchNodeRequest, type DispatchEventSink, type DispatchIo } from './node-dispatcher.js';
import {
  REMOTE_DISPATCH_MAX,
  appendRemoteAttempt,
  clearRemoteAssigned,
  clearRemoteOffered,
  markRemoteAssigned,
  markRemoteAttemptResult,
  markRemoteOffered,
  remoteAssignOf,
  remoteAttemptsOf,
  remoteCategoryOf,
  type OrchestrateDb,
} from './node-orchestrate.js';
import {
  buildDispatchPolicy,
  projectHasNodePolicy,
  toWireDispatchPolicy,
  type ProjectDispatchPolicy,
  type ProjectNodePolicyDb,
} from './project-node-policy.js';
import {
  buildDispatchPayload,
  collectUpstreamSummaries,
  isAutoDispatchOn,
  peersSupportingCategory,
} from './collab-dispatch.js';
import { routeCategoryForTask } from './task-routing.js';
import type { LicenseSettingDb } from './license.js';
import type { NodeSettingDb } from './node-identity.js';
import { createLogger } from './logger.js';

const logger = createLogger('redispatch');

/** 本模块只需要的任务行字段。 */
interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: string;
  context_json: string | Buffer | null;
}

export interface RedispatchFacts {
  /** 刚失败的那台节点。 */
  nodeId: string;
  /** 刚失败的那一单（用于把尝试账里对应那条标成 failed）。 */
  requestId: string;
  /** 失败人话原因（写进尝试账与留痕，不改任务状态）。 */
  reason: string;
}

export interface RedispatchDeps {
  /** 台账读取（真机＝`fetchNodes`）；**必填**——没有台账源就不改派。 */
  listLedger: () => Promise<NodeLedger>;
  io?: DispatchIo;
  emit?: DispatchEventSink;
  /** 时钟注入（在线判据不依赖真实墙钟）。 */
  nowMs?: number;
}

export interface RedispatchOutcome {
  ok: boolean;
  /** `ok=false` 的机器可读原因（调用方只记日志，不据此编造状态）。 */
  reason: string;
  /** 成功时的目标节点/新单号。 */
  toNode?: string;
  requestId?: string;
  /** 这是第几次改派（1-based）。 */
  attempt?: number;
}

function readTaskRow(db: Database.Database, taskId: string): TaskRow | null {
  try {
    const row = db
      .prepare(
        'SELECT id, project_id, title, description, acceptance_criteria, status, context_json FROM wa_tasks WHERE id = ?',
      )
      .get(taskId) as Partial<TaskRow> | undefined;
    if (!row) return null;
    return {
      id: String(row.id ?? taskId),
      project_id: String(row.project_id ?? ''),
      title: String(row.title ?? ''),
      description: String(row.description ?? ''),
      acceptance_criteria: String(row.acceptance_criteria ?? ''),
      status: String(row.status ?? ''),
      context_json: (row.context_json as string | Buffer | null | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * 尝试把一件**已确认失败**的外派子任务改派给另一台节点。**永不抛、不改任务状态**。
 *   - 任务已非 `pending`（已被别的路收口）⇒ 不改派；
 *   - 尝试账已达 `REMOTE_DISPATCH_MAX` ⇒ `attempts-exhausted`（交回原失败收口）；
 *   - 无可用候选 ⇒ `no-candidate`（**不硬塞**）；
 *   - 提交失败 ⇒ 任务保持无归属（退回本机调度，由调用方按原逻辑置 failed 或本地重跑）。
 */
export async function attemptRedispatch(
  db: Database.Database,
  taskId: string,
  failed: RedispatchFacts,
  deps: RedispatchDeps,
): Promise<RedispatchOutcome> {
  try {
    // 自动外派关着 ⇒ 不再自动换人（用户关掉的是"自动"，不是"这一件活"）；交回原失败收口。
    let autoOn = false;
    try { autoOn = isAutoDispatchOn(db as unknown as NodeSettingDb & LicenseSettingDb); } catch { autoOn = false; }
    if (!autoOn) return { ok: false, reason: 'auto-dispatch-off' };

    const row = readTaskRow(db, taskId);
    if (!row) return { ok: false, reason: 'task-missing' };
    if (row.status !== 'pending') return { ok: false, reason: 'not-pending' };

    const nowMs = deps.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // —— 先把"这次失败"记进尝试账（旧行没有首派账 ⇒ 以此补记；不补则上限永远数不到它）——
    let attempts = remoteAttemptsOf(row.context_json);
    if (!attempts.some((a) => a.requestId === failed.requestId)) {
      const assign = remoteAssignOf(row.context_json);
      const seeded = {
        nodeId: failed.nodeId,
        requestId: failed.requestId,
        at: assign?.assignedAt || nowIso,
        result: 'failed',
        reason: failed.reason,
      };
      if (!appendRemoteAttempt(db as unknown as OrchestrateDb, taskId, seeded)) {
        return { ok: false, reason: 'attempt-record-failed' };
      }
      attempts = [...attempts, seeded];
    } else {
      markRemoteAttemptResult(db as unknown as OrchestrateDb, taskId, failed.requestId, 'failed', failed.reason);
    }
    if (attempts.length >= REMOTE_DISPATCH_MAX) return { ok: false, reason: 'attempts-exhausted' };

    const category = (remoteCategoryOf(row.context_json) || routeCategoryForTask(row.title, row.description)) as NodeCardCategory | null;
    if (!category) return { ok: false, reason: 'no-category' };

    const tried = new Set(attempts.map((a) => a.nodeId).filter(Boolean));
    tried.add(failed.nodeId);

    let ledger: NodeLedger;
    try {
      ledger = await deps.listLedger();
    } catch (e) {
      return { ok: false, reason: `ledger-failed: ${(e as Error)?.message || String(e)}` };
    }

    const targeted = row.project_id !== '' && projectHasNodePolicy(db as unknown as ProjectNodePolicyDb, row.project_id);
    let policy: ProjectDispatchPolicy | null = null;
    if (targeted) {
      try {
        policy = buildDispatchPolicy(db as unknown as ProjectNodePolicyDb, row.project_id, category, ledger, nowMs);
      } catch (e) {
        logger.warn({ taskId, projectId: row.project_id, err: (e as Error)?.message }, '项目分工读取失败，改派退回按台账选人');
        policy = null;
      }
    }
    const candidates = (policy ? policy.candidateNodeIds : peersSupportingCategory(ledger, category, nowMs))
      .filter((id) => !tried.has(id));
    if (candidates.length === 0) {
      // 有项目分工时以分工候选为准（不越出用户点名的那几台）；无分工才用台账。
      return { ok: false, reason: 'no-candidate' };
    }
    const wire: NodeDispatchPolicy = toWireDispatchPolicy({
      candidateNodeIds: candidates,
      weightScale: policy ? { ...policy.weightScale } : {},
    });

    // —— 先撤旧归属、落占位（提交前本机不抢跑），再提交（带收窄后的候选）——
    if (!clearRemoteAssigned(db as unknown as OrchestrateDb, taskId)) return { ok: false, reason: 'clear-assign-failed' };
    if (!markRemoteOffered(db as unknown as OrchestrateDb, taskId, nowIso)) return { ok: false, reason: 'offer-mark-failed' };
    const clearOffer = () => clearRemoteOffered(db as unknown as OrchestrateDb, taskId);

    let result;
    try {
      result = await dispatchNodeRequest(
        db,
        {
          category,
          payload: { ...buildDispatchPayload({ id: taskId, title: row.title, description: row.description, acceptanceCriteria: row.acceptance_criteria }, collectUpstreamSummaries(db, taskId)) },
          requireTarget: true,
          policy: wire,
        },
        { ...(deps.io ? { io: deps.io } : {}), ...(deps.emit ? { emit: deps.emit } : {}) },
      );
    } catch (e) {
      clearOffer();
      return { ok: false, reason: `dispatch-threw: ${(e as Error)?.message || String(e)}` };
    }
    if (!result.ok) {
      clearOffer();
      return { ok: false, reason: `dispatch-failed: ${result.note}` };
    }
    if (!result.targetNodeId || !result.requestId) {
      clearOffer();
      return { ok: false, reason: 'ans-returned-incomplete' };
    }

    const marked = markRemoteAssigned(
      db as unknown as OrchestrateDb,
      taskId,
      { nodeId: result.targetNodeId, requestId: result.requestId },
      nowIso,
      { category, result: 'dispatched', selection: result.selection },
    );
    clearOffer();
    if (!marked) return { ok: false, reason: 'assign-mark-failed' };

    // 第几次改派：账里首派之外的第 N 条（`attempts` 是本轮提交前的账）。
    return { ok: true, reason: '', toNode: result.targetNodeId, requestId: result.requestId, attempt: attempts.length };
  } catch (e) {
    return { ok: false, reason: `redispatch-threw: ${(e as Error)?.message || String(e)}` };
  }
}
