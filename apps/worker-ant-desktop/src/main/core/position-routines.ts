/**
 * zx_20261120_1 M1「例·基」：**岗位例行任务**的单一真源（DDL + 纯判据 + 读写）。
 *
 * 病根：项目级 `cron_create_task` 只会建「同一条固定题」，不绑岗位、不看上一单是否还在跑；
 *   岗位页只有「派活」（一次性）。用户每月/每周重复的那类活，今天只能每次手动重述。
 *
 * 三条纪律：
 *   ① 例行只**建一条普通任务**（带岗位/期次），拆解、执行、验收、经验沉淀全部复用既有链路。
 *   ② 到点触发前**现读**项目/岗位/绑定状态；停用即跳过并留痕，不删已有定义。
 *   ③ 本模块零 electron / 零网络；rr 用 node:sqlite / better-sqlite3 内存库直跑真逻辑。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isTerminalStatus } from './status-terms.js';

/** 表 DDL 单一真源：`database.ts` 与 rr 夹具同引这一份。 */
export const POSITION_ROUTINES_DDL = `
  CREATE TABLE IF NOT EXISTS wa_position_routines (
    id TEXT PRIMARY KEY,
    position_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT '',
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (position_id, project_id, name)
  );
  CREATE TABLE IF NOT EXISTS wa_position_routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    task_id TEXT NOT NULL DEFAULT '',
    period_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (routine_id, period_key)
  );
  CREATE INDEX IF NOT EXISTS idx_wa_position_routine_runs_routine
    ON wa_position_routine_runs(routine_id, created_at);
`;

/** 运行账的合法状态（新增态须同步 `routineRunLabel` 与 GUI 词表）。 */
export const ROUTINE_RUN_STATUSES = ['created', 'completed', 'failed', 'archived', 'skipped'] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

export interface PositionRoutine {
  id: string;
  position_id: string;
  project_id: string;
  name: string;
  cron: string;
  timezone: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  priority: number;
  enabled: number;
  created_by: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PositionRoutineInput {
  position_id: string;
  project_id: string;
  name: string;
  cron: string;
  timezone?: string;
  title: string;
  description?: string;
  acceptance_criteria?: string;
  priority?: number;
  enabled?: boolean;
  created_by?: string;
}

export type RoutineSkipReason =
  | 'routine_disabled'
  | 'project_inactive'
  | 'position_disabled'
  | 'binding_disabled'
  | 'previous_run_open'
  | 'period_duplicate';

export interface RoutineFireFacts {
  routineEnabled: boolean;
  projectStatus: string;
  positionEnabled: boolean;
  bindingEnabled: boolean;
  /** 上一单（含暂停）是否仍未到终态。 */
  previousRunOpen: boolean;
  /** 同一个 `periodKey` 是否已有运行账。 */
  periodDuplicate: boolean;
}

export interface RoutineFireDecision {
  ok: boolean;
  skipReason: RoutineSkipReason | null;
  periodKey: string;
}

/**
 * 期次键：按 cron 的**粒度**取桶（分钟 / 小时 / 日），用于「同一期只跑一次」。
 * 时刻统一走 UTC ISO 前缀——只为幂等，不解释 cron 语义（真正触发由 node-cron 负责）。
 * 非法时刻回空串（调用方按「无法判期次」拒建，不猜）。
 */
export function periodKeyOf(cron: string, fireAt: Date | number | string): string {
  const d = new Date(fireAt);
  if (!Number.isFinite(d.getTime())) return '';
  const fields = String(cron ?? '').trim().split(/\s+/).filter(Boolean);
  const hour = fields[1] ?? '*';
  const dom = fields[2] ?? '*';
  const mon = fields[3] ?? '*';
  const iso = d.toISOString();
  if (mon !== '*' || dom !== '*') return iso.slice(0, 10);
  if (hour !== '*') return iso.slice(0, 13);
  return iso.slice(0, 16);
}

/** 五态判据的**唯一一份**（顺序即优先级：定义 → 项目 → 岗位 → 绑定 → 在跑 → 同期）。 */
export function routineFireDecision(facts: RoutineFireFacts, periodKey: string): RoutineFireDecision {
  const skip = (r: RoutineSkipReason): RoutineFireDecision => ({ ok: false, skipReason: r, periodKey });
  if (!facts.routineEnabled) return skip('routine_disabled');
  if (facts.projectStatus !== 'active') return skip('project_inactive');
  if (!facts.positionEnabled) return skip('position_disabled');
  if (!facts.bindingEnabled) return skip('binding_disabled');
  if (facts.previousRunOpen) return skip('previous_run_open');
  if (facts.periodDuplicate) return skip('period_duplicate');
  return { ok: true, skipReason: null, periodKey };
}

/** 归属判据：岗位启用 ∧ 项目 active ∧ 绑定启用。创建/更新/触发三处同引。 */
export function routineBindingVerdict(
  db: Database.Database,
  positionId: string,
  projectId: string,
): { ok: boolean; reason: 'position_disabled' | 'project_inactive' | 'binding_disabled' | null } {
  try {
    const pos = db.prepare('SELECT enabled FROM wa_positions WHERE id = ?').get(positionId) as { enabled?: number } | undefined;
    if (!pos || Number(pos.enabled) !== 1) return { ok: false, reason: 'position_disabled' };
    const proj = db.prepare('SELECT status FROM wa_projects WHERE id = ?').get(projectId) as { status?: string } | undefined;
    if (!proj || proj.status !== 'active') return { ok: false, reason: 'project_inactive' };
    const bind = db.prepare('SELECT enabled FROM wa_project_positions WHERE project_id = ? AND position_id = ?')
      .get(projectId, positionId) as { enabled?: number } | undefined;
    if (!bind || Number(bind.enabled) !== 1) return { ok: false, reason: 'binding_disabled' };
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'binding_disabled' };
  }
}

/** 上一单是否仍未到终态（最新一条**带 task** 的运行账；无 task 的跳过账不算在跑）。 */
export function previousRunOpen(db: Database.Database, routineId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT r.task_id, t.status AS task_status
         FROM wa_position_routine_runs r
         LEFT JOIN wa_tasks t ON t.id = r.task_id
        WHERE r.routine_id = ? AND r.task_id != ''
        ORDER BY r.created_at DESC, r.rowid DESC
        LIMIT 1`,
    ).get(routineId) as { task_id?: string; task_status?: string | null } | undefined;
    if (!row || !row.task_id) return false;
    // 任务行没了 ⇒ 无法判"在跑"；按未在跑处理（不因台账缺行把例行永久卡死）。
    if (!row.task_status) return false;
    return !isTerminalStatus(row.task_status);
  } catch {
    return false;
  }
}

/** 该期是否已有运行账（已跳过也算，避免同一期反复写跳过行）。 */
export function periodDuplicate(db: Database.Database, routineId: string, periodKey: string): boolean {
  try {
    return !!db.prepare('SELECT 1 FROM wa_position_routine_runs WHERE routine_id = ? AND period_key = ?')
      .get(routineId, periodKey);
  } catch {
    return false;
  }
}

/** 任务上下文四键——只描述「这次是谁、哪一期」，不塞岗位知识（岗位知识仍走既有注入）。 */
export function routineTaskContext(routine: Pick<PositionRoutine, 'id' | 'name'>, periodKey: string): Record<string, unknown> {
  return {
    source: 'routine',
    routine_id: routine.id,
    routine_name: routine.name,
    period_key: periodKey,
    cron_triggered: true,
    // zx_20261120_3 M1「职·全」：例行建单的来源是岗位（任务详情可按同一词表显示）。
    position_source: 'routine',
  };
}

export interface CreateRoutineTaskResult {
  ok: boolean;
  taskId: string;
  runId: string;
  reason: string;
}

/**
 * 建一条例行任务 + 一行运行账（**同一事务**）。
 * 不查准入（由调用方先过 `routineFireDecision`）；唯一键冲突如实回 `period_duplicate`。
 */
export function createRoutineTask(
  db: Database.Database,
  routine: PositionRoutine,
  periodKey: string,
  nowIso = new Date().toISOString(),
): CreateRoutineTaskResult {
  const taskId = randomId();
  const runId = randomId();
  const ctx = JSON.stringify(routineTaskContext(routine, periodKey));
  try {
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO wa_tasks (id, project_id, title, description, status, source, position_id, acceptance_criteria, priority, context_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 'routine', ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskId, routine.project_id, routine.title, routine.description || '', routine.position_id,
        routine.acceptance_criteria || '', Number(routine.priority) || 0, ctx, nowIso, nowIso,
      );
      db.prepare(
        `INSERT INTO wa_position_routine_runs (id, routine_id, task_id, period_key, status, created_at)
         VALUES (?, ?, ?, ?, 'created', ?)`,
      ).run(runId, routine.id, taskId, periodKey, nowIso);
      db.prepare('UPDATE wa_position_routines SET last_run_at = ?, updated_at = ? WHERE id = ?')
        .run(nowIso, nowIso, routine.id);
    });
    tx();
    return { ok: true, taskId, runId, reason: '' };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).trim();
    if (/UNIQUE/i.test(msg)) return { ok: false, taskId: '', runId: '', reason: 'period_duplicate' };
    return { ok: false, taskId: '', runId: '', reason: msg || 'insert_failed' };
  }
}

/** 跳过也留痕：同 `periodKey` 已有行时不再写（避免反复触发写放大）。 */
export function recordRoutineSkip(
  db: Database.Database,
  routineId: string,
  periodKey: string,
  reason: RoutineSkipReason,
  nowIso = new Date().toISOString(),
): boolean {
  try {
    const r = db.prepare(
      `INSERT OR IGNORE INTO wa_position_routine_runs (id, routine_id, task_id, period_key, status, reason, created_at)
       VALUES (?, ?, '', ?, 'skipped', ?, ?)`,
    ).run(randomId(), routineId, periodKey, reason, nowIso);
    return r.changes > 0;
  } catch {
    return false;
  }
}

/** 任务到终态时回填运行账；只改 `created`（已结行不再改写）。 */
export function updateRoutineRunForTask(db: Database.Database, taskId: string, status: string): number {
  if (!taskId) return 0;
  const next = status === 'completed' || status === 'failed' || status === 'archived' ? status : '';
  if (!next) return 0;
  try {
    return db.prepare(
      "UPDATE wa_position_routine_runs SET status = ? WHERE task_id = ? AND status = 'created'",
    ).run(next, taskId).changes;
  } catch {
    return 0;
  }
}

export function getRoutine(db: Database.Database, id: string): PositionRoutine | null {
  try {
    return (db.prepare('SELECT * FROM wa_position_routines WHERE id = ?').get(id) as PositionRoutine | undefined) ?? null;
  } catch {
    return null;
  }
}

export interface RoutineListRow extends PositionRoutine {
  position_name: string;
  project_name: string;
  last_run_status: string | null;
  last_run_reason: string | null;
}

export function listRoutines(
  db: Database.Database,
  filter: { positionId?: string; projectId?: string; enabledOnly?: boolean } = {},
): RoutineListRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.positionId) { where.push('r.position_id = ?'); args.push(filter.positionId); }
  if (filter.projectId) { where.push('r.project_id = ?'); args.push(filter.projectId); }
  if (filter.enabledOnly) where.push('r.enabled = 1');
  try {
    return db.prepare(
      `SELECT r.*, COALESCE(p.name, '') AS position_name, COALESCE(pr.name, '') AS project_name,
              (SELECT lr.status FROM wa_position_routine_runs lr
                WHERE lr.routine_id = r.id ORDER BY lr.created_at DESC, lr.rowid DESC LIMIT 1) AS last_run_status,
              (SELECT lr.reason FROM wa_position_routine_runs lr
                WHERE lr.routine_id = r.id ORDER BY lr.created_at DESC, lr.rowid DESC LIMIT 1) AS last_run_reason
         FROM wa_position_routines r
         LEFT JOIN wa_positions p ON p.id = r.position_id
         LEFT JOIN wa_projects pr ON pr.id = r.project_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY r.enabled DESC, r.name ASC`,
    ).all(...args) as RoutineListRow[];
  } catch {
    return [];
  }
}

export interface RoutineWriteResult {
  ok: boolean;
  id: string;
  reason: string;
}

/** 创建例行：先过归属判据；同名（同岗位同项目）如实拒，不覆盖。 */
export function createRoutine(
  db: Database.Database,
  input: PositionRoutineInput,
  nowIso = new Date().toISOString(),
): RoutineWriteResult {
  const bad = validateInput(input);
  if (bad) return { ok: false, id: '', reason: bad };
  const bind = routineBindingVerdict(db, input.position_id, input.project_id);
  if (!bind.ok) return { ok: false, id: '', reason: bind.reason ?? 'binding_disabled' };
  const id = randomId();
  try {
    db.prepare(
      `INSERT INTO wa_position_routines
         (id, position_id, project_id, name, cron, timezone, title, description, acceptance_criteria, priority, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.position_id, input.project_id, input.name.trim(), input.cron.trim(),
      (input.timezone || 'Asia/Shanghai').trim(), input.title.trim(), input.description || '',
      input.acceptance_criteria || '', Number(input.priority) || 0, input.enabled === false ? 0 : 1,
      input.created_by || '', nowIso, nowIso,
    );
    return { ok: true, id, reason: '' };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).trim();
    return { ok: false, id: '', reason: /UNIQUE/i.test(msg) ? 'duplicate_name' : (msg || 'insert_failed') };
  }
}

/** 更新例行：归属变了要重新过判据；同名冲突如实拒。 */
export function updateRoutine(
  db: Database.Database,
  id: string,
  patch: Partial<PositionRoutineInput> & { enabled?: boolean },
  nowIso = new Date().toISOString(),
): RoutineWriteResult {
  const cur = getRoutine(db, id);
  if (!cur) return { ok: false, id, reason: 'not_found' };
  const next: PositionRoutineInput = {
    position_id: String(patch.position_id ?? cur.position_id),
    project_id: String(patch.project_id ?? cur.project_id),
    name: String(patch.name ?? cur.name),
    cron: String(patch.cron ?? cur.cron),
    timezone: String(patch.timezone ?? cur.timezone),
    title: String(patch.title ?? cur.title),
    description: String(patch.description ?? cur.description),
    acceptance_criteria: String(patch.acceptance_criteria ?? cur.acceptance_criteria),
    priority: Number(patch.priority ?? cur.priority) || 0,
    enabled: patch.enabled ?? Number(cur.enabled) === 1,
    created_by: cur.created_by,
  };
  const bad = validateInput(next);
  if (bad) return { ok: false, id, reason: bad };
  const bind = routineBindingVerdict(db, next.position_id, next.project_id);
  if (!bind.ok) return { ok: false, id, reason: bind.reason ?? 'binding_disabled' };
  try {
    db.prepare(
      `UPDATE wa_position_routines
          SET position_id = ?, project_id = ?, name = ?, cron = ?, timezone = ?, title = ?, description = ?,
              acceptance_criteria = ?, priority = ?, enabled = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      next.position_id, next.project_id, next.name.trim(), next.cron.trim(), (next.timezone || 'Asia/Shanghai').trim(),
      next.title.trim(), next.description || '', next.acceptance_criteria || '', next.priority,
      next.enabled === false ? 0 : 1, nowIso, id,
    );
    return { ok: true, id, reason: '' };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).trim();
    return { ok: false, id, reason: /UNIQUE/i.test(msg) ? 'duplicate_name' : (msg || 'update_failed') };
  }
}

/** 删除例行定义：**不删历史任务**（历史仍可按 `context_json.routine_id` 归组）。 */
export function deleteRoutine(db: Database.Database, id: string): boolean {
  try {
    return db.prepare('DELETE FROM wa_position_routines WHERE id = ?').run(id).changes > 0;
  } catch {
    return false;
  }
}

function validateInput(input: PositionRoutineInput): string {
  if (!String(input.position_id || '').trim()) return 'position_required';
  if (!String(input.project_id || '').trim()) return 'project_required';
  if (!String(input.name || '').trim()) return 'name_required';
  if (!String(input.cron || '').trim()) return 'cron_required';
  if (!String(input.title || '').trim()) return 'title_required';
  return '';
}

function randomId(): string {
  return randomUUID();
}

// ── 建议「设为例行」（只读、零写入） ─────────────────────────────────────────

export interface RoutineSuggestion {
  position_id: string;
  project_id: string;
  title: string;
  runs: number;
  last_run_at: string;
  sample_titles: string[];
}

interface SuggestTaskRow {
  id: string;
  title: string;
  description: string;
  context_json: string;
  updated_at: string;
}

/**
 * 近 N 天同项目同岗位的**同形完成任务**聚成簇（≥ `minRuns` 次）→ 建议设为例行。
 * 只读：不写任何表。有 embedding 走余弦；无 embedding 退化为标题 2-gram Jaccard。
 */
export function suggestRoutineCandidates(
  db: Database.Database,
  input: { projectId: string; positionId: string; days?: number; minRuns?: number; limit?: number },
): RoutineSuggestion[] {
  const days = Math.max(1, Math.trunc(input.days ?? 90));
  const minRuns = Math.max(2, Math.trunc(input.minRuns ?? 3));
  const limit = Math.max(1, Math.trunc(input.limit ?? 5));
  let rows: SuggestTaskRow[] = [];
  try {
    rows = db.prepare(
      `SELECT id, title, description, context_json, updated_at
         FROM wa_tasks
        WHERE project_id = ? AND position_id = ? AND status = 'completed'
          AND updated_at >= datetime('now', ?)
        ORDER BY updated_at DESC LIMIT 200`,
    ).all(input.projectId, input.positionId, `-${days} days`) as SuggestTaskRow[];
  } catch {
    return [];
  }
  const existing = new Set(
    listRoutines(db, { positionId: input.positionId, projectId: input.projectId })
      .map((r) => normalizeTitle(r.title)),
  );
  const clusters: Array<{ titles: string[]; last: string; emb: number[] | null }> = [];
  for (const r of rows) {
    const emb = embeddingOf(r.context_json);
    let hit = false;
    for (const c of clusters) {
      if (similarity(c.emb, emb, c.titles[0] ?? '', r.title) >= 0.7) {
        c.titles.push(r.title);
        if (r.updated_at > c.last) c.last = r.updated_at;
        hit = true;
        break;
      }
    }
    if (!hit) clusters.push({ titles: [r.title], last: r.updated_at, emb });
  }
  return clusters
    .filter((c) => c.titles.length >= minRuns)
    .map((c) => ({
      position_id: input.positionId,
      project_id: input.projectId,
      title: c.titles[0] ?? '',
      runs: c.titles.length,
      last_run_at: c.last,
      sample_titles: [...new Set(c.titles)].slice(0, 5),
    }))
    .filter((s) => s.title && !existing.has(normalizeTitle(s.title)))
    .slice(0, limit);
}

function embeddingOf(contextJson: unknown): number[] | null {
  try {
    const v = (JSON.parse(String(contextJson ?? '{}')) as { task_embedding?: unknown }).task_embedding;
    return Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number') ? (v as number[]) : null;
  } catch {
    return null;
  }
}

function similarity(a: number[] | null, b: number[] | null, titleA: string, titleB: string): number {
  if (a && b && a.length === b.length && a.length > 0) {
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]!; }
    if (aa > 0 && bb > 0) return dot / (Math.sqrt(aa) * Math.sqrt(bb));
  }
  return jaccard(shingles(titleA), shingles(titleB));
}

function normalizeTitle(s: string): string {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}\d]+/gu, '');
}

function shingles(s: string): Set<string> {
  const n = normalizeTitle(s);
  const out = new Set<string>();
  if (n.length <= 2) { if (n) out.add(n); return out; }
  for (let i = 0; i + 2 <= n.length; i++) out.add(n.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── 岗位绩效看板（例行 vs 临时；数字现算） ─────────────────────────────────

export interface RoutineBoardBucket {
  tasks: number;
  completed: number;
  acceptance_passed: number;
  avg_tokens: number | null;
  avg_steps: number | null;
  /**
   * 平均时长（毫秒）——**估算**：`created_at → updated_at` 的差（收口会更新 `updated_at`）。
   * 它不是纯执行时长；无样本/时间不可解析 ⇒ `null`（不编 0）。
   */
  avg_duration_ms: number | null;
}

export interface RoutineBoard {
  routine: RoutineBoardBucket;
  adhoc: RoutineBoardBucket;
  due_next: Array<{ routine_id: string; name: string; last_run_status: string | null; last_run_reason: string | null }>;
}

interface BoardTaskRow {
  id: string;
  source: string;
  status: string;
  context_json: string;
  created_at: string;
  updated_at: string;
}

export function routineBoard(
  db: Database.Database,
  input: { positionId: string; projectId?: string; days?: number },
): RoutineBoard {
  const days = Math.max(1, Math.trunc(input.days ?? 90));
  const where = ['position_id = ?', 'created_at >= datetime(\'now\', ?)'];
  const args: unknown[] = [input.positionId, `-${days} days`];
  if (input.projectId) { where.push('project_id = ?'); args.push(input.projectId); }
  let rows: BoardTaskRow[] = [];
  try {
    rows = db.prepare(
      `SELECT id, source, status, context_json, created_at, updated_at FROM wa_tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 2000`,
    ).all(...args) as BoardTaskRow[];
  } catch { rows = []; }
  const routine: BoardTaskRow[] = [];
  const adhoc: BoardTaskRow[] = [];
  for (const r of rows) (r.source === 'routine' ? routine : adhoc).push(r);
  const due_next = listRoutines(db, { positionId: input.positionId, ...(input.projectId ? { projectId: input.projectId } : {}), enabledOnly: true })
    .map((r) => ({ routine_id: r.id, name: r.name, last_run_status: r.last_run_status, last_run_reason: r.last_run_reason }));
  return { routine: bucketOf(routine), adhoc: bucketOf(adhoc), due_next };
}

function bucketOf(rows: BoardTaskRow[]): RoutineBoardBucket {
  let completed = 0, acceptance = 0, tok = 0, tokN = 0, steps = 0, stepsN = 0, dur = 0, durN = 0;
  for (const r of rows) {
    if (r.status === 'completed') {
      completed++;
      const ms = durationMsOf(r.created_at, r.updated_at);
      if (ms != null) { dur += ms; durN++; }
    }
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(r.context_json || '{}') as Record<string, unknown>; } catch { ctx = {}; }
    const acc = (ctx.acceptance_check ?? {}) as { verified?: unknown };
    if (acc.verified === true) acceptance++;
    const metrics = (ctx.execution_metrics ?? ctx.cost_estimate ?? {}) as { totalTokens?: unknown; stepsUsed?: unknown };
    const t = Number(metrics.totalTokens);
    if (Number.isFinite(t) && t > 0) { tok += t; tokN++; }
    const s = Number(metrics.stepsUsed);
    if (Number.isFinite(s) && s > 0) { steps += s; stepsN++; }
  }
  return {
    tasks: rows.length,
    completed,
    acceptance_passed: acceptance,
    avg_tokens: tokN > 0 ? Math.round(tok / tokN) : null,
    avg_steps: stepsN > 0 ? Math.round(steps / stepsN) : null,
    avg_duration_ms: durN > 0 ? Math.round(dur / durN) : null,
  };
}

/** SQLite `'YYYY-MM-DD HH:MM:SS'`（UTC）→ 毫秒差；不可解析回 `null`。 */
function durationMsOf(from: string, to: string): number | null {
  const parse = (s: string): number => {
    const t = String(s || '').trim();
    if (!t) return NaN;
    return new Date(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`).getTime();
  };
  const a = parse(from);
  const b = parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}
