/**
 * 项目调用记账（zx_20261002 M11）——「小模型」的原料之一。
 *
 * **真源表 `wa_service_calls`**：一行 = 一次对外/对服务调用，记 **项目 + 调用对象 + 动作 + 成败 + 耗时**。
 * 三类调用此前各有各的「没人管」：
 *   - MCP 工具调用（`tools/resource.ts` 的 `call_mcp_tool`）——失败只在连接池内存里数，重启即失忆；
 *   - A2A 服务启动（`a2a-runtime.ts`）——**零记账**，起没起得来只体现在交付物状态上；
 *   - 守护进程启动（`project.ipc.ts` 的 `deliverable:start` daemon 支）——此前只有心跳（`updated_at`）。
 *
 * 三条硬约束（方案 M11 原话）：
 *   1. **只收账、不据此做决策**。本模块只提供 `recordServiceCall`（写）/ `describeServiceCalls`（读聚合）。
 *      任何调度、选型、熔断路径**不得**读这张表——"账未准就自动化"是换一种病（K-3）。
 *   2. **一处真源表，禁散落 `context_json`**。三类调用的成败/耗时只落这里，不往任务 ctx 里塞。
 *   3. **写必须 best-effort**。记账失败**绝不**能把一次真调用弄崩（三个写点都在用户可见路径上）。
 *      但"不抛"不等于"可以不写"——真写了没有，由 rr 的 0→1 正面断言看住（"计数器类断言须有值从 0 变 1"）。
 */
import type Database from 'better-sqlite3';
// zx_20261113_3 B2：占位名单与 MCP 前置**同一份**（不各写一条正则）。
import { isPlaceholderMcpServerName } from './mcp-server-registry.js';

/**
 * 行 id。**不用 `node:crypto`**——`SERVICE_CALL_KIND_LABEL` 要出给渲染层，
 * 本模块须保持可被 renderer 打包（node 内建会让 vite 打不出来），故走 `globalThis.crypto`（同 `lib/ipc.ts` 的 `newClientRequestId`）。
 */
function newCallId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type ServiceCallKind = 'mcp' | 'a2a' | 'daemon';

/** 三类调用**枚举一处**：读侧据此把"零调用"的类目也如实列出来（"没发生过"与"没这一栏"是两回事）。 */
export const SERVICE_CALL_KINDS: readonly ServiceCallKind[] = ['mcp', 'a2a', 'daemon'];

export const SERVICE_CALL_KIND_LABEL: Record<ServiceCallKind, string> = {
  mcp: 'MCP 工具调用',
  a2a: 'A2A 服务启动',
  daemon: '守护进程启动',
};

export interface ServiceCallEntry {
  projectId: string;
  /** 触发本次调用的任务（可空——服务启停未必挂在某个任务上）。 */
  taskId?: string;
  kind: ServiceCallKind;
  /** 调用对象：MCP = `服务名/工具名`；A2A / 守护进程 = 交付物名。 */
  target: string;
  /** 动作：MCP = `call`；A2A / 守护进程 = `start`。 */
  operation: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** 错误文本落库前的上限——一次超长 stderr 不该把账撑爆（截断而非丢弃）。 */
const MAX_ERROR_CHARS = 500;

/**
 * 记一笔调用账。**best-effort：绝不对调用方抛**。
 * 三个写点（`tools/resource.ts` / `project.ipc.ts` ×2）都在用户可见路径上，记账失败不该让真调用失败。
 */
export function recordServiceCall(db: Database.Database, entry: ServiceCallEntry): void {
  try {
    const duration = Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0;
    db.prepare(
      `INSERT INTO wa_service_calls (id, project_id, task_id, kind, target, operation, ok, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newCallId(),
      entry.projectId || '',
      entry.taskId || '',
      entry.kind,
      entry.target || '',
      entry.operation || '',
      entry.ok ? 1 : 0,
      duration,
      (entry.error || '').slice(0, MAX_ERROR_CHARS),
    );
  } catch { /* 记账失败不阻塞真调用 */ }
}

export interface ServiceCallKindAggregate {
  kind: ServiceCallKind;
  calls: number;
  ok: number;
  failed: number;
  avgMs: number | null;
  maxMs: number | null;
  /** 该类最近一次调用的时刻（UTC，`datetime('now')` 同基准）。 */
  lastAt: string | null;
  /** 该类最近一次**失败**的原因（没失败过则 null——不编造）。 */
  lastError: string | null;
  /** zx_20261113_3 B1：最近一次失败的时刻——历史失败不冒充“当前故障”。 */
  lastErrorAt: string | null;
  /** zx_20261113_3 B1：最近一次调用（不论成败）的结论与时刻。 */
  lastOutcome: 'ok' | 'failed' | null;
  lastOutcomeAt: string | null;
}

export interface ServiceCallRecentRow {
  kind: ServiceCallKind;
  target: string;
  operation: string;
  ok: boolean;
  durationMs: number;
  error: string;
  createdAt: string;
  /** zx_20261113_3 B1：产生该调用的任务（可空）。 */
  taskId: string;
  /** 任务存在或无 taskId ⇒ true；taskId 非空但 `wa_tasks` 无此行 ⇒ false（“任务已删除”）。 */
  taskExists: boolean;
  taskTitle: string | null;
  /** 占位/探针服务器名（只标注，不删账）。 */
  probe: boolean;
}

/**
 * zx_20261113_3 B1/B2：占位/探针服务器名——**窄口径**，只认明确的占位声明。
 * `nonexistent-probe` / `probe` / `test-probe` / `example` / `fake` / `placeholder` / `unknown` 命中；
 * `probe-api` 这类正常名**不**命中（避免把真服务误标成探针）。
 * 真源在 `mcp-server-registry.ts`（与 `call_mcp_tool` 前置同一份），此处只按 `server/tool` 取 server 段。
 */
export function isProbeServiceCallTarget(target: string): boolean {
  const server = String(target || '').split('/')[0]?.trim() || '';
  return isPlaceholderMcpServerName(server);
}

export interface ServiceCallReport {
  projectId: string;
  total: number;
  ok: number;
  failed: number;
  byKind: ServiceCallKindAggregate[];
  /** 最近 20 笔明细（按插入序倒排，供下钻）。 */
  recent: ServiceCallRecentRow[];
}

/** 最近明细条数上限——只读面用于下钻，不承担全量导出。 */
const RECENT_LIMIT = 20;

/**
 * 读某项目的调用聚合（只读）。**不写任何东西**——界面每次刷新都不该改库。
 * 三类**都出栏**（哪怕零调用）：调用方由此能如实显示"这一类没发生过"，而不是把它藏起来。
 */
export function describeServiceCalls(db: Database.Database, projectId: string): ServiceCallReport {
  const stats = db.prepare(
    `SELECT kind, COUNT(*) AS calls, SUM(ok) AS ok, SUM(1 - ok) AS failed,
            AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms, MAX(created_at) AS last_at
     FROM wa_service_calls WHERE project_id = ? GROUP BY kind`,
  ).all(projectId) as Array<{ kind: string; calls: number; ok: number | null; failed: number | null; avg_ms: number | null; max_ms: number | null; last_at: string | null }>;
  const byKindMap = new Map(stats.map(s => [s.kind, s]));

  // 最近失败原因：每类取**最新**那一笔（`created_at` 秒级 ⇒ 同秒并列时按 `rowid` 定序，即真插入序）。
  const lastErrors = new Map<string, { error: string; at: string | null }>();
  const errRows = db.prepare(
    `SELECT kind, error, created_at FROM wa_service_calls WHERE project_id = ? AND ok = 0 ORDER BY rowid DESC`,
  ).all(projectId) as Array<{ kind: string; error: string | null; created_at: string | null }>;
  for (const r of errRows) if (!lastErrors.has(r.kind)) lastErrors.set(r.kind, { error: r.error || '', at: r.created_at || null });

  // zx_20261113_3 B1：“最近一次调用”与“最近一次失败”分开——后来成功过就不该只显示旧失败。
  const lastOutcomes = new Map<string, { ok: number; at: string | null }>();
  const outcomeRows = db.prepare(
    `SELECT kind, ok, created_at FROM wa_service_calls WHERE project_id = ? ORDER BY rowid DESC`,
  ).all(projectId) as Array<{ kind: string; ok: number; created_at: string | null }>;
  for (const r of outcomeRows) if (!lastOutcomes.has(r.kind)) lastOutcomes.set(r.kind, { ok: r.ok, at: r.created_at || null });

  const byKind: ServiceCallKindAggregate[] = SERVICE_CALL_KINDS.map((kind) => {
    const s = byKindMap.get(kind);
    const e = lastErrors.get(kind);
    const o = lastOutcomes.get(kind);
    return {
      kind,
      calls: s?.calls ?? 0,
      ok: s?.ok ?? 0,
      failed: s?.failed ?? 0,
      avgMs: s?.avg_ms == null ? null : Math.round(s.avg_ms),
      maxMs: s?.max_ms ?? null,
      lastAt: s?.last_at ?? null,
      lastError: e?.error ?? null,
      lastErrorAt: e?.at ?? null,
      lastOutcome: o ? (o.ok === 1 ? 'ok' : 'failed') : null,
      lastOutcomeAt: o?.at ?? null,
    };
  });

  const recent = db.prepare(
    `SELECT s.kind, s.target, s.operation, s.ok, s.duration_ms, s.error, s.created_at,
            s.task_id, t.id AS task_id_exists, t.title AS task_title
       FROM wa_service_calls s
       LEFT JOIN wa_tasks t ON t.id = s.task_id
      WHERE s.project_id = ? ORDER BY s.rowid DESC LIMIT ?`,
  ).all(projectId, RECENT_LIMIT) as Array<{
    kind: string; target: string | null; operation: string | null; ok: number; duration_ms: number | null;
    error: string | null; created_at: string | null; task_id: string | null; task_id_exists: string | null; task_title: string | null;
  }>;

  return {
    projectId,
    total: byKind.reduce((n, k) => n + k.calls, 0),
    ok: byKind.reduce((n, k) => n + k.ok, 0),
    failed: byKind.reduce((n, k) => n + k.failed, 0),
    byKind,
    recent: recent.map(r => ({
      kind: r.kind as ServiceCallKind,
      target: r.target || '',
      operation: r.operation || '',
      ok: r.ok === 1,
      durationMs: r.duration_ms ?? 0,
      error: r.error || '',
      createdAt: r.created_at || '',
      taskId: r.task_id || '',
      // 无 taskId（A2A/守护进程等）不算“已删除”；只有 taskId 非空且 JOIN 不到才标 false。
      taskExists: !r.task_id || r.task_id_exists != null,
      taskTitle: r.task_title || null,
      probe: isProbeServiceCallTarget(r.target || ''),
    })),
  };
}
