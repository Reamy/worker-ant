/**
 * zx_20261106_3 B6「协·知止」: 父任务**失败**后，把仍在其名下的子任务收口——
 *   本机子任务归档、远端子任务叫停。**只有父失败才级联**（完成/取消不动任何人）。
 *
 * ## 治的病
 *
 * 父任务一旦 `failed` 就不会再被唤醒（`failed` 是终态，没有 resume 路）。可它的子任务
 * 仍可能停在 `pending`/`running`（远端的还占着对端算力），变成**无人认领的孤儿**：
 * 继续烧本机并发位/远端资源，完成后还会回写一份没人看的产出。前两轮方案把这条挂账两次，
 * 本模块是收口。
 *
 * ## 裁量（为什么只收「还在跑」的）
 *
 * - **只由 `failed` 触发**：`completed` 的子任务按既有路径收口；`cancelled`（父被归档/叫停）
 *   本身已是"了结"，不再替人追加动作——扩大语义会把"用户主动停"误读成"失败了要清场"。
 * - **`paused` 不算孤儿**：暂停是"等人处置"，停着的任务不烧任何资源；此时归档会越过人的判断
 *   （验收未判/验收失败正等父代理带因处置）。故级联只碰非终态且非 `paused` 的任务。
 * - **递归到整棵子树**：父失败后子任务也永远不会再被唤醒；若只收一层，孙辈仍是孤儿。
 *   以失败任务为根做递归 CTE，逐层取"仍在跑"的成员。
 *
 * ## 远端：未确认就**不写「已停止」**
 *
 * 远端子任务只能经 ANS 叫停。`cancelNodeRequest` 回来的状态分两类：
 *   - `cancelled` ⇒ 对端已真停 ⇒ 本地归档（`archiveTask`，原因 `parent_failed`）；
 *   - 其余（`pending`/`assigned`/`awaiting_answer`，或读回失败）⇒ **只记「叫停已发出，尚未确认」**，
 *     下拍再试；任务状态、界面都不改写成"已停"。旧版对端不读叫停位时，会跑完回真实结局，
 *     届时由 `driveRemoteSubtasks` 按回传如实收口——两条路不互相冒充。
 *
 * 状态落在子任务 `context_json.parent_failure_cascade`（合并写口，保留兄弟键）；`confirmed`
 * 之后不再重复打 ANS，只补归档（上拍可能因并发/CAS 没落成）。
 *
 * ⚠ 本模块**触网只在默认 cancel 实现里**（`cancelNodeRequest`）；rr 注入假 cancel 即不出网。
 * ⚠ **永不抛**：单条失败装进计数与日志，心跳下一拍再来。
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { cancelNodeRequest, type DispatchEventSink, type DispatchIo, type DispatchReadResult } from './node-dispatcher.js';
import { isRemoteAssigned, remoteAssignOf } from './node-orchestrate.js';
import { archiveTask } from './task-archive.js';
import type { TaskTerminalDb } from './task-terminal.js';
import { isTerminalStatus, TERMINAL_STATUSES } from './task-jobs.js';

const logger = createLogger('task-failure-cascade');

/** 级联归档的因由（写进 `context_json.archive_reason`，也随 `task.status_changed` 出事件）。 */
export const CASCADE_ARCHIVE_REASON = 'parent_failed';

/** 级联状态落在子任务 `context_json` 的键名——**只此一处**。 */
export const PARENT_FAILURE_CASCADE_KEY = 'parent_failure_cascade';

/** `planFailureCascade` 的输入成员——只取判据需要的三样。 */
export interface CascadeChild {
  id: string;
  status: string;
  /** 是否已外派他机（`isRemoteAssigned` 的结论，调用方判一次传进来）。 */
  remote: boolean;
}

export interface FailureCascadePlan {
  /** 本机仍在跑的子任务：归档。 */
  localToArchive: string[];
  /** 远端仍在跑的子任务：叫停。 */
  remoteToCancel: string[];
}

/**
 * 纯决策：把一批子任务分成「本机归档 / 远端叫停」。
 * 终态（`completed|failed|archived`）与 `paused` 一律不动——理由见文件头「裁量」。
 */
export function planFailureCascade(children: readonly CascadeChild[]): FailureCascadePlan {
  const localToArchive: string[] = [];
  const remoteToCancel: string[] = [];
  for (const child of children) {
    if (isTerminalStatus(child.status) || child.status === 'paused') continue;
    (child.remote ? remoteToCancel : localToArchive).push(child.id);
  }
  return { localToArchive, remoteToCancel };
}

export interface CascadeState {
  parentId: string;
  state: 'requested' | 'confirmed';
  requestedAt: string;
  confirmedAt?: string;
  attempts: number;
  note?: string;
}

/** 读级联状态；无记录 / 坏 JSON 返回 `null`（不编造）。 */
export function cascadeStateOf(contextJson: string | Buffer | null | undefined): CascadeState | null {
  try {
    const s = Buffer.isBuffer(contextJson) ? contextJson.toString('utf-8') : String(contextJson ?? '');
    const ctx = JSON.parse(s || '{}') as Record<string, unknown>;
    const raw = ctx[PARENT_FAILURE_CASCADE_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.state !== 'requested' && o.state !== 'confirmed') return null;
    return {
      parentId: typeof o.parent_id === 'string' ? o.parent_id : '',
      state: o.state,
      requestedAt: typeof o.requested_at === 'string' ? o.requested_at : '',
      ...(typeof o.confirmed_at === 'string' ? { confirmedAt: o.confirmed_at } : {}),
      attempts: typeof o.attempts === 'number' ? o.attempts : 0,
      ...(typeof o.note === 'string' ? { note: o.note } : {}),
    };
  } catch {
    return null;
  }
}

export interface FailureCascadeDeps {
  /** 注入 IO（缺省走 `cancelNodeRequest` 的懒建真实现）。 */
  io?: DispatchIo;
  /** 注入事件出口（缺省 `eventBus.emit`）。 */
  emit?: DispatchEventSink;
  /** 注入叫停实现（rr 用；缺省 `cancelNodeRequest`）。 */
  cancel?: (requestId: string) => Promise<DispatchReadResult>;
  /** `now` 注入（回归不依赖墙钟；缺省 `Date.now`）。 */
  now?: () => number;
}

export interface FailureCascadeResult {
  /** 本拍扫到的失败根数（有仍在跑的后代才算数）。 */
  roots: number;
  /** 本拍处理的仍在跑的任务数（本机 + 远端）。 */
  checked: number;
  /** 本机子任务被归档的条数（真翻了状态）。 */
  localArchived: number;
  /** 远端叫停**已确认**并归档的条数。 */
  remoteCancelConfirmed: number;
  /** 远端叫停已发出、**尚未确认**的条数（下拍重试）。 */
  remoteCancelRequested: number;
  /** 叫停请求本身失败（网络/凭据/未入网）的条数。 */
  errors: number;
}

interface CascadeRow {
  id: string;
  project_id: string | null;
  status: string;
  context_json: string | null;
  root_id: string;
}

/**
 * 递归列出"失败任务的全部后代中仍在跑的那部分"。
 * 终态与 `paused` 在 SQL 层先滤掉（少读行）；真判仍由 `planFailureCascade` 做（一处判据）。
 */
function listActiveDescendants(db: Database.Database): CascadeRow[] {
  const excluded = [...TERMINAL_STATUSES, 'paused'].map((s) => `'${s}'`).join(', ');
  const sql = `
    WITH RECURSIVE roots(id) AS (
      SELECT id FROM wa_tasks WHERE status = 'failed'
    ),
    tree(id, project_id, status, context_json, root_id) AS (
      SELECT c.id, c.project_id, c.status, c.context_json, r.id
        FROM wa_tasks c JOIN roots r ON c.parent_task_id = r.id
      UNION ALL
      SELECT c.id, c.project_id, c.status, c.context_json, t.root_id
        FROM wa_tasks c JOIN tree t ON c.parent_task_id = t.id
    )
    -- 一个失败任务可能同时是另一个失败任务的后代 ⇒ 递归结果会重复；按 id 归并只处理一次。
    SELECT id, project_id, status, context_json, MIN(root_id) AS root_id
      FROM tree
     WHERE status NOT IN (${excluded})
     GROUP BY id
     ORDER BY id`;
  try {
    return db.prepare(sql).all() as CascadeRow[];
  } catch {
    return [];
  }
}

/** 读-改-写整份 `context_json`（与 `node-orchestrate` 同一 RMW 纪律：不抹兄弟键）。 */
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
    } catch { /* 坏 JSON 当空对象 */ }
    Object.assign(ctx, patch);
    const r = db
      .prepare("UPDATE wa_tasks SET context_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(ctx), taskId) as { changes?: number } | undefined;
    return (r?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/** 落一条 system 会话记录（与 `node-remote-driver` 同形；收口证据上屏）。 */
function appendSystemNote(db: Database.Database, taskId: string, content: string): void {
  try {
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))",
    ).run(crypto.randomUUID(), taskId, content);
  } catch { /* 会话记录缺失不该改收口结局 */ }
}

/**
 * 驱动一拍：把"父已失败、自己仍在跑"的任务收口。**永不抛**。
 *
 * 逐条处置：
 *   - 本机 ⇒ `archiveTask(reason='parent_failed', expectStatus=扫描时状态)`（CAS 幂等）；
 *   - 远端 ∧ 状态已 `confirmed` ⇒ 只补归档（不再打 ANS）；
 *   - 远端 ∧ 未确认 ⇒ 叫停；回来 `cancelled` ⇒ 记 confirmed + 归档；
 *     其余 ⇒ 记 requested（下拍重试），**不改状态、不写「已停止」**。
 */
export async function driveFailureCascades(db: Database.Database, deps: FailureCascadeDeps = {}): Promise<FailureCascadeResult> {
  const out: FailureCascadeResult = { roots: 0, checked: 0, localArchived: 0, remoteCancelConfirmed: 0, remoteCancelRequested: 0, errors: 0 };
  const rows = listActiveDescendants(db);
  if (rows.length === 0) return out;

  const nowIso = () => new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const cancel = deps.cancel
    ?? ((requestId: string) => cancelNodeRequest(db, requestId, {
      ...(deps.io ? { io: deps.io } : {}),
      ...(deps.emit ? { emit: deps.emit } : {}),
    }));
  const terminalDb = db as unknown as TaskTerminalDb;

  const plan = planFailureCascade(rows.map((r) => ({
    id: r.id,
    status: r.status,
    remote: isRemoteAssigned(r.context_json),
  })));
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const roots = new Set(rows.map((r) => r.root_id));
  out.roots = roots.size;

  for (const id of plan.localToArchive) {
    const row = rowsById.get(id);
    if (!row) continue;
    out.checked++;
    const res = archiveTask(terminalDb, { taskId: id, reason: CASCADE_ARCHIVE_REASON, expectStatus: row.status });
    if (!res.changed) continue; // 已被别的路处置（幂等）
    out.localArchived++;
    appendSystemNote(db, id, `[协同·父失败收口] 父任务（${row.root_id.slice(0, 8)}）已失败且不会再被唤醒；本机子任务不再跑，如实归档（未完成，不记成功/失败）。`);
    logger.info({ taskId: id, rootId: row.root_id, status: row.status }, '父失败 ⇒ 本机子任务已归档');
  }

  for (const id of plan.remoteToCancel) {
    const row = rowsById.get(id);
    if (!row) continue;
    out.checked++;
    const assign = remoteAssignOf(row.context_json);
    if (!assign) {
      // 粗判为远端但精判不成（键不全）⇒ 当本机处理，不拿一个不知道去向的单去叫停。
      const res = archiveTask(terminalDb, { taskId: id, reason: CASCADE_ARCHIVE_REASON, expectStatus: row.status });
      if (res.changed) {
        out.localArchived++;
        appendSystemNote(db, id, '[协同·父失败收口] 父任务已失败；本机子任务不再跑，如实归档。');
      }
      continue;
    }

    const prev = cascadeStateOf(row.context_json);
    const base = {
      parentId: row.root_id,
      requestedAt: prev?.requestedAt || nowIso(),
      attempts: prev?.attempts ?? 0,
    } satisfies Omit<CascadeState, 'state'>;

    // 上拍已确认：远端确实停了，只补归档（归档可能因并发/CAS 未落成）。
    if (prev?.state === 'confirmed') {
      const res = archiveTask(terminalDb, { taskId: id, reason: CASCADE_ARCHIVE_REASON, expectStatus: row.status });
      if (res.changed) {
        out.localArchived++;
        appendSystemNote(db, id, '[协同·父失败收口] 父任务已失败；远端子任务此前已确认叫停，本机如实归档。');
      }
      continue;
    }

    let read: DispatchReadResult;
    let threw = '';
    try {
      read = await cancel(assign.requestId);
    } catch (e) {
      threw = (e as Error)?.message || String(e);
      read = { ok: false, request: null, note: threw };
    }

    if (!read.ok || !read.request) {
      out.errors++;
      const note = read.note || threw || '叫停未果';
      patchContext(db, id, {
        [PARENT_FAILURE_CASCADE_KEY]: { ...base, state: 'requested', attempts: base.attempts + 1, note },
      });
      logger.warn({ taskId: id, requestId: assign.requestId, note }, '父失败 ⇒ 远端子任务叫停未成（本拍不动，下拍再试）');
      continue;
    }

    if (read.request.status === 'cancelled') {
      out.remoteCancelConfirmed++;
      patchContext(db, id, {
        [PARENT_FAILURE_CASCADE_KEY]: { ...base, state: 'confirmed', confirmedAt: nowIso(), attempts: base.attempts + 1 },
      });
      const res = archiveTask(terminalDb, { taskId: id, reason: CASCADE_ARCHIVE_REASON, expectStatus: row.status });
      if (res.changed) {
        out.localArchived++;
        appendSystemNote(db, id, `[协同·父失败收口] 父任务（${row.root_id.slice(0, 8)}）已失败；已叫停他机（${assign.nodeId.slice(0, 8)}）并**确认远端已停**（回传 cancelled），本机子任务如实归档。`);
      }
      logger.info({ taskId: id, requestId: assign.requestId, nodeId: assign.nodeId }, '父失败 ⇒ 远端子任务已确认叫停并归档');
      continue;
    }

    // 未确认：只记「叫停已发出」。**不写「已停止」、不动任务状态。**
    out.remoteCancelRequested++;
    const note = `叫停已发出，远端状态仍为 ${read.request.status}`;
    patchContext(db, id, {
      [PARENT_FAILURE_CASCADE_KEY]: { ...base, state: 'requested', attempts: base.attempts + 1, note },
    });
    if (!prev) {
      appendSystemNote(db, id, `[协同·父失败收口] 父任务（${row.root_id.slice(0, 8)}）已失败，已向他机（${assign.nodeId.slice(0, 8)}）发出叫停；**尚未确认远端已停**（当前 ${read.request.status}），下拍继续确认。`);
    }
    logger.info({ taskId: id, requestId: assign.requestId, status: read.request.status }, '父失败 ⇒ 远端子任务叫停已发出（未确认）');
  }

  return out;
}
