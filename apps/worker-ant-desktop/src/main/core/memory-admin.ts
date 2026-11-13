/**
 * zx_20261108_1 B4「忆」（维特根斯坦·意义即使用 / 管子·度量衡）: **记忆的读口与人工写口**。
 *
 * 病根（四件，同批治）：
 *   ① 记忆列表的搜索只在渲染层过滤**当前页的 50 条**——全库第 51 条起永远搜不到；
 *   ② 一条记忆"从哪来、被哪个任务注入过、改过没有"没有可查的读口（只有卡片上的两个计数）；
 *   ③ 用户没有**新增/修订**记忆的入口；删除绕开了审计（删了就只剩墓碑，谁删的、什么时候删的没有账）；
 *   ④ 容量（按类型/来源/项目）与 FTS 索引健康没有任何可看的地方。
 *
 * 本模块是**零 electron 依赖**的纯 SQL 模块（只引 `node:crypto` 的 UUID 与本目录纯模块），
 * 故受控回归可直引**生产实现**（不自造等价物），IPC 层只做转发。
 *
 * 纪律：
 *   · 所有用户输入一律参数化；FTS 查询先做**关键词白名单清洗**（只留字母/数字/下划线并加引号），
 *     FTS 不可用/语法失败/改零命中时**回落 LIKE**（`keywordMode` 如实回报走的是哪条路）。
 *     零命中回落是必要的：FTS5 默认分词器把整段连续中文当一个 token，单搜「部署」匹配不到「部署流程：…」。
 *   · 人工写口必写审计（`wa_audit_events`），审计失败不改变主动作结局（`recordAudit` 永不抛）。
 *   · 遗忘走**墓碑**（`tombstoneMemory`），不做物理删；`deleted_reason` 记缘由。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  MEM_DELETE_REASONS,
  MEM_LIVE_SQL,
  MEM_SOURCE_MANUAL,
  MEM_TYPE_LABEL,
  memSourceLabel,
  tombstoneMemory,
  utcNowIso,
} from './memory-lifecycle.js';
import { MEM_IMPORTANCE_DEFAULT, MEM_SOURCE_USER_CORRECTION } from './memory-constants.js';
import { recordAudit } from './audit-log.js';
import { injectionSourceLabel } from './injection-sources.js';

/** 最小库接口（可脱 better-sqlite3 被 rr 直跑）。 */
export interface MemoryAdminDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes?: number };
    all(...args: unknown[]): unknown[];
  };
}

// ==================== 一、列表（服务端筛选） ====================

export interface MemoryListFilter {
  /** 关键词：优先 FTS5（全文），失败回落 LIKE（包含）。空白即不过滤。 */
  keyword?: string;
  source?: string;
  /** 精确匹配 `memory_type`；点名 `deleted` 即墓碑审计面，点名 `archived` 即归档面。 */
  type?: string;
  projectId?: string;
  /** 创建时刻下界（含）；`YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM:SS`。 */
  timeFrom?: string;
  /** 创建时刻上界（含）；`YYYY-MM-DD` 当日按 23:59:59 计。 */
  timeTo?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryAdminRow {
  id: string;
  project_id: string | null;
  project_name: string;
  task_id: string | null;
  content: string;
  memory_type: string;
  type_label: string;
  source: string;
  source_label: string;
  importance: number;
  valence: string;
  created_at: string;
  updated_at: string | null;
  use_count: number;
  last_used_at: string | null;
  injected_count: number;
  last_injected_at: string | null;
  success_count: number;
  failure_count: number;
  is_exemplar: number;
  similar_to: string;
  context_json: string;
  deleted_at: string | null;
  deleted_reason: string;
  /** 无项目归属（用户偏好/全局经验）——界面据此标「跨项目经验」。 */
  cross_project: boolean;
}

export interface MemoryListResult {
  list: MemoryAdminRow[];
  /** 与 `list` 同值；给新调用点的别名，不破坏旧调用（旧调用读 `list`）。 */
  items: MemoryAdminRow[];
  counts: Array<{ memory_type: string; cnt: number }>;
  total: number;
  /** 关键词实际走的取数路：`fts` 全文 / `like` 包含回落 / `none` 未搜索。 */
  keywordMode: 'fts' | 'like' | 'none';
}

const LIST_MAX_LIMIT = 500;

/** 关键词白名单：只留字母/数字/下划线（中文字符属字母），最多 8 个词。 */
export function keywordTerms(raw: unknown): string[] {
  return (String(raw ?? '').match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 8);
}

/** 把关键词拼成 FTS5 查询（每词双引号包裹，彻底消掉 FTS 语法元字符）。 */
export function sanitizeFtsQuery(raw: unknown): string {
  const terms = keywordTerms(raw);
  return terms.length === 0 ? '' : terms.map((t) => `"${t}"`).join(' ');
}

/** LIKE 回落：任一关键词命中即算（与检索簇 `searchByKeywords` 的 OR 口径同向）。 */
function likeWhere(terms: string[], column: string): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  for (const t of terms) {
    parts.push(`${column} LIKE ? ESCAPE '\\'`);
    params.push(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** `YYYY-MM-DD` / `YYYY-MM-DD HH:MM[:SS]` / ISO（Z 或偏移）⇒ 库内 UTC 串；认不出返回空串。 */
export function normalizeDbTime(raw: unknown, endOfDay = false): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) return `${dateOnly[0]} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  const full = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (full) return `${full[1]} ${full[2]}${full[3] ?? ':00'}`;
  return '';
}

function mapRow(r: Record<string, unknown>): MemoryAdminRow {
  const memoryType = String(r.memory_type ?? '');
  const source = String(r.source ?? '');
  return {
    id: String(r.id ?? ''),
    project_id: r.project_id == null ? null : String(r.project_id),
    project_name: String(r.project_name ?? ''),
    task_id: r.task_id == null ? null : String(r.task_id),
    content: String(r.content ?? ''),
    memory_type: memoryType,
    type_label: MEM_TYPE_LABEL[memoryType] ?? memoryType,
    source,
    source_label: memSourceLabel(source),
    importance: Number(r.importance) || 0,
    valence: String(r.valence ?? ''),
    created_at: String(r.created_at ?? ''),
    updated_at: r.updated_at == null ? null : String(r.updated_at),
    use_count: Number(r.use_count) || 0,
    last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
    injected_count: Number(r.injected_count) || 0,
    last_injected_at: r.last_injected_at == null ? null : String(r.last_injected_at),
    success_count: Number(r.success_count) || 0,
    failure_count: Number(r.failure_count) || 0,
    is_exemplar: Number(r.is_exemplar) || 0,
    similar_to: String(r.similar_to ?? ''),
    context_json: String(r.context_json ?? '{}'),
    deleted_at: r.deleted_at == null ? null : String(r.deleted_at),
    deleted_reason: String(r.deleted_reason ?? ''),
    cross_project: r.project_id == null,
  };
}

/**
 * 服务端筛选 + 分页。`total` 与列表**同一套 WHERE**（带筛选的翻页页数才对）。
 * 关键词先试 FTS5；任何 FTS 异常（表缺/语法/查询失败）⇒ 回落 LIKE，并如实回报 `keywordMode`。
 */
export function listMemories(db: MemoryAdminDb, filter: MemoryListFilter = {}): MemoryListResult {
  const limit = Math.min(
    LIST_MAX_LIMIT,
    Math.max(1, Number.isFinite(filter.limit) ? Math.floor(Number(filter.limit)) : 50),
  );
  const offset = Math.max(0, Number.isFinite(filter.offset) ? Math.floor(Number(filter.offset)) : 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) { where.push('m.project_id = ?'); params.push(filter.projectId); }
  if (filter.source) { where.push('m.source = ?'); params.push(filter.source); }
  if (filter.type) { where.push('m.memory_type = ?'); params.push(filter.type); }
  else { where.push(`m.${MEM_LIVE_SQL}`); }
  const from = normalizeDbTime(filter.timeFrom, false);
  if (from) { where.push('m.created_at >= ?'); params.push(from); }
  const to = normalizeDbTime(filter.timeTo, true);
  if (to) { where.push('m.created_at <= ?'); params.push(to); }

  const build = (ftsQuery: string | null): { list: MemoryAdminRow[]; total: number } => {
    const w = [...where];
    const p: unknown[] = [...params];
    let join = '';
    let order = 'm.created_at DESC, m.rowid DESC';
    if (ftsQuery) {
      join = ' JOIN wa_memories_fts f ON f.rowid = m.rowid';
      w.push('wa_memories_fts MATCH ?');
      p.push(ftsQuery);
      order = 'f.rank, m.created_at DESC, m.rowid DESC';
    }
    const whereSql = ` WHERE ${w.join(' AND ')}`;
    const list = db.prepare(
      `SELECT m.*, p.name AS project_name FROM wa_memories m` +
      ` LEFT JOIN wa_projects p ON m.project_id = p.id${join}${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(...p, limit, offset) as Array<Record<string, unknown>>;
    const total = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM wa_memories m${join}${whereSql}`,
    ).get(...p) as { c?: number } | undefined)?.c) || 0;
    return { list: list.map(mapRow), total };
  };

  const counts = db.prepare(
    'SELECT memory_type, COUNT(*) AS cnt FROM wa_memories GROUP BY memory_type',
  ).all() as Array<{ memory_type: string; cnt: number }>;

  const rawKeyword = String(filter.keyword ?? '').trim();
  if (rawKeyword) {
    const terms = keywordTerms(rawKeyword);
    const fts = sanitizeFtsQuery(rawKeyword);
    if (fts) {
      try {
        const r = build(fts);
        if (r.total > 0) {
          return { ...r, items: r.list, counts, keywordMode: 'fts' };
        }
        // **零命中不是答案**：FTS5 默认分词器把整段连续中文当作一个 token，
        //   搜「部署」匹配不到「部署流程：…」这类正文（实测）。故 FTS 语法成功但零行时，
        //   再补一次 LIKE「内容包含」；真命中才采用（`keywordMode` 如实改报 `like`）。
        if (terms.length > 0) {
          const lc = likeWhere(terms, 'm.content');
          where.push(lc.sql);
          params.push(...lc.params);
          const lr = build(null);
          if (lr.total > 0) return { ...lr, items: lr.list, counts, keywordMode: 'like' };
        }
        // 两边都无 ⇒ 如实空结果（不编）。
        return { ...r, items: r.list, counts, keywordMode: 'fts' };
      } catch {
        // FTS 表缺/查询失败 ⇒ 走下面的 LIKE 回落（如实回报）。
      }
    }
    if (terms.length > 0) {
      const lc = likeWhere(terms, 'm.content');
      where.push(lc.sql);
      params.push(...lc.params);
      const r = build(null);
      return { ...r, items: r.list, counts, keywordMode: 'like' };
    }
  }
  const r = build(null);
  return { ...r, items: r.list, counts, keywordMode: 'none' };
}

// ==================== 二、单条详情（来源 / 注入历史 / 改账） ====================

export interface MemoryInjectionRow {
  id: string;
  task_id: string;
  task_title: string;
  source: string;
  source_label: string;
  chars: number;
  est_tokens: number;
  outcome: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryAuditRow {
  id: string;
  action: string;
  actor_kind: string;
  actor_ref: string;
  created_at: string;
  detail: Record<string, unknown>;
}

export interface MemoryDetailRoi {
  injected: number;
  chars: number;
  completed: number;
  failed: number;
  pending: number;
}

export interface MemoryDetail {
  memory: MemoryAdminRow;
  /** 解析后的 `context_json`（证据/编码语境都在这里）；坏 JSON 如实给空对象。 */
  context: Record<string, unknown>;
  /** 证据锚点（`context_json.evidence`），无则 null。 */
  evidence: Record<string, unknown> | null;
  /** 该记忆作为「记忆」来源被注入的明细（最近 100 条）。 */
  injections: MemoryInjectionRow[];
  roi: MemoryDetailRoi;
  /** 该记忆的人工改账（`recordAudit` 写的）；旧库无表时为空数组。 */
  history: MemoryAuditRow[];
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function memoryDetail(db: MemoryAdminDb, id: string): MemoryDetail | null {
  const row = db.prepare(
    `SELECT m.*, p.name AS project_name FROM wa_memories m LEFT JOIN wa_projects p ON m.project_id = p.id WHERE m.id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  let injections: MemoryInjectionRow[] = [];
  const roi: MemoryDetailRoi = { injected: 0, chars: 0, completed: 0, failed: 0, pending: 0 };
  try {
    const rows = db.prepare(
      `SELECT ci.id, ci.task_id, ci.source, ci.ref_id, ci.chars, ci.est_tokens, ci.outcome,
              ci.created_at, ci.updated_at, COALESCE(t.title, '') AS task_title
         FROM wa_context_injections ci LEFT JOIN wa_tasks t ON t.id = ci.task_id
        WHERE ci.source = 'memory' AND ci.ref_id = ?
        ORDER BY ci.updated_at DESC, ci.id DESC LIMIT 100`,
    ).all(id) as Array<Record<string, unknown>>;
    injections = rows.map((r) => ({
      id: String(r.id ?? ''),
      task_id: String(r.task_id ?? ''),
      task_title: String(r.task_title ?? ''),
      source: String(r.source ?? ''),
      source_label: injectionSourceLabel(String(r.source ?? '')),
      chars: Number(r.chars) || 0,
      est_tokens: Number(r.est_tokens) || 0,
      outcome: String(r.outcome ?? ''),
      created_at: String(r.created_at ?? ''),
      updated_at: String(r.updated_at ?? ''),
    }));
    const agg = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS chars,
              COALESCE(SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
              COALESCE(SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
              COALESCE(SUM(CASE WHEN outcome NOT IN ('completed', 'failed') THEN 1 ELSE 0 END), 0) AS pending
         FROM wa_context_injections WHERE source = 'memory' AND ref_id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    roi.injected = Number(agg?.n) || 0;
    roi.chars = Number(agg?.chars) || 0;
    roi.completed = Number(agg?.completed) || 0;
    roi.failed = Number(agg?.failed) || 0;
    roi.pending = Number(agg?.pending) || 0;
  } catch {
    // 旧库/夹具无注入表 ⇒ 如实为空（不编历史）。
  }

  let history: MemoryAuditRow[] = [];
  try {
    const rows = db.prepare(
      `SELECT id, action, actor_kind, actor_ref, detail_json, created_at
         FROM wa_audit_events WHERE target_type = 'memory' AND target_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 50`,
    ).all(id) as Array<Record<string, unknown>>;
    history = rows.map((r) => ({
      id: String(r.id ?? ''),
      action: String(r.action ?? ''),
      actor_kind: String(r.actor_kind ?? ''),
      actor_ref: String(r.actor_ref ?? ''),
      created_at: String(r.created_at ?? ''),
      detail: parseObject(r.detail_json),
    }));
  } catch {
    // 旧库无 `wa_audit_events` ⇒ 如实为空。
  }

  const context = parseObject(row.context_json);
  const memory = mapRow(row);
  return {
    memory,
    context,
    evidence: context.evidence && typeof context.evidence === 'object' && !Array.isArray(context.evidence)
      ? (context.evidence as Record<string, unknown>) : null,
    injections,
    roi,
    history,
  };
}

// ==================== 三、人工写口（新增 / 修订 / 遗忘） ====================

export type MemoryMutation =
  | { op: 'add'; content: string; projectId?: string | null; type?: string; importance?: number }
  | { op: 'revise'; id: string; content?: string; type?: string; importance?: number }
  | { op: 'forget'; id: string; reason?: string };

export interface MemoryMutateResult {
  ok: boolean;
  id: string;
  /** 失败时的人话原因；成功为空串。 */
  error: string;
  /** 本次写入后的来源（`add` 恒为 `manual`；`revise` 按是否改正文决定）。 */
  source: string;
}

function clampImportance(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

/**
 * 人工写口。返回 `{ok,id,error,source}`——调用方据 `ok` 决定回执，不靠抛异常交流。
 * 每一步成功都写审计（`memory.create` / `memory.update` / `memory.forget`）；审计失败不影响主动作。
 */
export function mutateMemory(
  db: MemoryAdminDb,
  input: MemoryMutation,
  opts: { nowMs?: number; actorRef?: string } = {},
): MemoryMutateResult {
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const actorRef = String(opts.actorRef ?? '');

  if (input?.op === 'add') {
    const content = String(input.content ?? '').trim();
    if (!content) return { ok: false, id: '', error: '记忆内容不能为空', source: '' };
    const projectId = input.projectId ? String(input.projectId) : null;
    if (projectId) {
      const exists = db.prepare('SELECT 1 FROM wa_projects WHERE id = ?').get(projectId);
      if (!exists) return { ok: false, id: '', error: `项目不存在：${projectId}`, source: '' };
    }
    const type = String(input.type ?? '').trim() || 'episodic';
    const importance = clampImportance(input.importance) ?? MEM_IMPORTANCE_DEFAULT;
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, reasoning, source, user_id, valence, context_json, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, '', ?, '', 'neutral', ?, ?)`,
      ).run(id, projectId, content, type, importance, MEM_SOURCE_MANUAL, JSON.stringify({ manual: true }), utcNowIso(nowMs));
    } catch (e) {
      return { ok: false, id: '', error: (e as Error)?.message || String(e), source: '' };
    }
    recordAudit(db, {
      actorKind: 'local',
      actorRef,
      action: 'memory.create',
      targetType: 'memory',
      targetId: id,
      detail: { source: MEM_SOURCE_MANUAL, type, projectId, chars: content.length },
    });
    return { ok: true, id, error: '', source: MEM_SOURCE_MANUAL };
  }

  if (input?.op === 'revise') {
    const id = String(input.id ?? '');
    if (!id) return { ok: false, id: '', error: '缺少记忆 id', source: '' };
    const row = db.prepare(
      `SELECT id, content, source, importance FROM wa_memories WHERE id = ? AND ${MEM_LIVE_SQL}`,
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, id, error: '记忆不存在或已删除', source: '' };

    const sets: string[] = [];
    const params: unknown[] = [];
    const fields: string[] = [];
    const content = typeof input.content === 'string' ? input.content.trim() : undefined;
    if (content !== undefined && content !== String(row.content ?? '')) {
      if (!content) return { ok: false, id, error: '记忆内容不能为空', source: '' };
      sets.push('content = ?');
      params.push(content);
      fields.push('content');
    }
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    if (type && type !== '') {
      sets.push('memory_type = ?');
      params.push(type);
      fields.push('memory_type');
    }
    const importance = clampImportance(input.importance);
    if (importance !== null) {
      sets.push('importance = ?');
      params.push(importance);
      fields.push('importance');
    }
    if (sets.length === 0) return { ok: false, id, error: '没有要修改的字段', source: String(row.source ?? '') };

    // 改正文＝用户对这条记忆的纠正（与 `preferences:update` 同一口径）⇒ 来源改 `user_correction`，
    //   由此获得在册的三条保护（置信顶分 / 同源永不覆盖 / 衰减豁免）。只改类型或重要度不动来源。
    const source = fields.includes('content') ? MEM_SOURCE_USER_CORRECTION : String(row.source ?? '');
    if (fields.includes('content')) {
      sets.push('source = ?');
      params.push(source);
    }
    sets.push('updated_at = ?');
    params.push(utcNowIso(nowMs));
    try {
      db.prepare(`UPDATE wa_memories SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    } catch (e) {
      return { ok: false, id, error: (e as Error)?.message || String(e), source: '' };
    }
    recordAudit(db, {
      actorKind: 'local',
      actorRef,
      action: 'memory.update',
      targetType: 'memory',
      targetId: id,
      detail: { fields, previousSource: String(row.source ?? ''), source },
    });
    return { ok: true, id, error: '', source };
  }

  if (input?.op === 'forget') {
    const id = String(input.id ?? '');
    if (!id) return { ok: false, id: '', error: '缺少记忆 id', source: '' };
    const reason = String(input.reason ?? '').trim() || MEM_DELETE_REASONS.userMemory;
    const deleted = tombstoneMemory(db, id, reason, nowMs);
    if (!deleted) return { ok: false, id, error: '记忆不存在或已删除', source: '' };
    recordAudit(db, {
      actorKind: 'local',
      actorRef,
      action: 'memory.forget',
      targetType: 'memory',
      targetId: id,
      detail: { reason },
    });
    return { ok: true, id, error: '', source: '' };
  }

  return { ok: false, id: '', error: '未知操作', source: '' };
}

// ==================== 四、容量与索引健康（只读） ====================

export interface MemoryCapacity {
  total: number;
  live: number;
  chars: number;
  byType: Array<{ type: string; label: string; count: number; live: number; chars: number }>;
  bySource: Array<{ source: string; label: string; count: number }>;
  byProject: Array<{ projectId: string | null; projectName: string; count: number }>;
  fts: { available: boolean; indexed: number; missing: number; orphaned: number; error: string };
  /** 只读建议：正文完全相同的活记忆组（不自动合并）。 */
  mergeCandidates: Array<{ ids: string[]; count: number; preview: string }>;
}

export function memoryCapacity(db: MemoryAdminDb): MemoryCapacity {
  const base = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${MEM_LIVE_SQL} THEN 1 ELSE 0 END), 0) AS live,
            COALESCE(SUM(LENGTH(content)), 0) AS chars
       FROM wa_memories`,
  ).get() as Record<string, unknown> | undefined;

  const byType = (db.prepare(
    `SELECT memory_type AS type, COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN ${MEM_LIVE_SQL} THEN 1 ELSE 0 END), 0) AS live,
            COALESCE(SUM(LENGTH(content)), 0) AS chars
       FROM wa_memories GROUP BY memory_type ORDER BY count DESC, memory_type`,
  ).all() as Array<Record<string, unknown>>).map((r) => ({
    type: String(r.type ?? ''),
    label: MEM_TYPE_LABEL[String(r.type ?? '')] ?? String(r.type ?? ''),
    count: Number(r.count) || 0,
    live: Number(r.live) || 0,
    chars: Number(r.chars) || 0,
  }));

  const bySource = (db.prepare(
    `SELECT source, COUNT(*) AS count FROM wa_memories WHERE ${MEM_LIVE_SQL} GROUP BY source ORDER BY count DESC, source`,
  ).all() as Array<Record<string, unknown>>).map((r) => ({
    source: String(r.source ?? ''),
    label: memSourceLabel(String(r.source ?? '')),
    count: Number(r.count) || 0,
  }));

  const byProject = (db.prepare(
    `SELECT m.project_id AS project_id, COALESCE(p.name, '') AS project_name, COUNT(*) AS count
       FROM wa_memories m LEFT JOIN wa_projects p ON m.project_id = p.id
      WHERE m.${MEM_LIVE_SQL}
      GROUP BY m.project_id ORDER BY count DESC`,
  ).all() as Array<Record<string, unknown>>).map((r) => ({
    projectId: r.project_id == null ? null : String(r.project_id),
    projectName: String(r.project_name ?? ''),
    count: Number(r.count) || 0,
  }));

  const fts: MemoryCapacity['fts'] = { available: false, indexed: 0, missing: 0, orphaned: 0, error: '' };
  try {
    fts.indexed = Number((db.prepare('SELECT COUNT(*) AS c FROM wa_memories_fts').get() as { c?: number } | undefined)?.c) || 0;
    fts.missing = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM wa_memories m WHERE m.${MEM_LIVE_SQL}
          AND NOT EXISTS (SELECT 1 FROM wa_memories_fts f WHERE f.rowid = m.rowid)`,
    ).get() as { c?: number } | undefined)?.c) || 0;
    fts.orphaned = Number((db.prepare(
      `SELECT COUNT(*) AS c FROM wa_memories_fts f
        WHERE NOT EXISTS (SELECT 1 FROM wa_memories m WHERE m.rowid = f.rowid)`,
    ).get() as { c?: number } | undefined)?.c) || 0;
    fts.available = true;
  } catch (e) {
    fts.error = (e as Error)?.message || String(e);
  }

  const mergeCandidates = (db.prepare(
    `SELECT content, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
       FROM wa_memories WHERE ${MEM_LIVE_SQL} AND content <> ''
      GROUP BY content HAVING COUNT(*) > 1 ORDER BY n DESC, content LIMIT 20`,
  ).all() as Array<Record<string, unknown>>).map((r) => ({
    ids: String(r.ids ?? '').split(',').filter(Boolean),
    count: Number(r.n) || 0,
    preview: String(r.content ?? '').slice(0, 80),
  }));

  return {
    total: Number(base?.total) || 0,
    live: Number(base?.live) || 0,
    chars: Number(base?.chars) || 0,
    byType,
    bySource,
    byProject,
    fts,
    mergeCandidates,
  };
}
