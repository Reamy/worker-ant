/**
 * zx_20261108_1 B6（维特根斯坦·同一把尺 / 管子·度量衡）: 产出物列表**取数、筛选、排序、分页的唯一实现**。
 *
 * 病根：`deliverable:list` 的筛选只到 projectId/type/status/keyword，任务/时间/主件/排序全在渲染层
 * **对已加载的那一页**做——分页后"筛选结论"与"全表结论"是两件事，界面只能加免责声明。
 * B6 把整条取数链搬到 main 侧：列表、已退休计数、CSV 导出**同一次装配**（FROM/JOIN/WHERE/params），
 * 故"导出 N 条"与"列表共 N 条"必是同一个集合。
 *
 * 一处真源：
 *   · 范围谓词仍走 `deliverableScopeSql`（探针滤除、可含已退休）；
 *   · 盘上大小走 `statSizeBytes`（`size` 排序时才全量 stat，其余排序只 stat 当页）；
 *   · `otherWriters` / `annotateAcceptance` 仍由 `deliverable-lifecycle` 派生，不在此重写。
 *
 * ⚠ `size` 排序：库内**没有 size 列**（见 database.ts 注记），服务端排序必须把**命中集合逐行 stat**
 *   再排——这是"按大小排序"本身的代价，故只在用户显式选它时发生（默认 `created_at` 走 SQL）。
 * ⚠ 稳定排序：同值一律按 `d.rowid` 同向兜底；`created_at` 只到秒，不兜底则翻页会重复/遗漏。
 */
import type Database from 'better-sqlite3';
import { resolvePage } from './pagination.js';
import { annotateAcceptance, deliverableScopeSql, otherWriters } from './deliverable-lifecycle.js';
import { statSizeBytes } from './deliverable-size.js';
import { DELIVERABLE_TASK_NONE } from './deliverable-types.js';

/** 「项目级（无产出任务）」哨兵**唯一定义**在零依赖的 `deliverable-types`（渲染层也要引），此处转出。 */
export { DELIVERABLE_TASK_NONE };

/** 可排序字段（词表唯一定义处）。旧渲染层的 `created`/`updated` 作为别名接受。 */
export const DELIVERABLE_SORTS = [
  'created_at', 'updated_at', 'name', 'type', 'status', 'quality', 'project', 'size', 'version_count',
] as const;
export type DeliverableSort = (typeof DELIVERABLE_SORTS)[number];

const SORT_ALIASES: Record<string, DeliverableSort> = { created: 'created_at', updated: 'updated_at' };

export type DeliverableOrder = 'asc' | 'desc';

export interface DeliverableListParams {
  projectId?: string;
  type?: string;
  status?: string;
  keyword?: string;
  /** 产出任务 id；`DELIVERABLE_TASK_NONE` 表示 `task_id IS NULL`（项目级）。 */
  taskId?: string;
  /** 创建时间下界（`YYYY-MM-DD` 或 ISO 8601）。 */
  since?: string;
  /** 创建时间上界（`YYYY-MM-DD` 含当日；或 ISO 8601）。 */
  until?: string;
  /** 只看 ★ 主要成果。 */
  primary?: boolean;
  /** 是否含已退休件（缺省 true = 档案视图；与 `deliverable:list` 既有口径一致）。 */
  showRetired?: boolean;
  sort?: DeliverableSort | 'created' | 'updated' | string;
  order?: DeliverableOrder | string;
  limit?: number;
  offset?: number;
}

export interface DeliverableQueryResult {
  rows: Array<Record<string, unknown>>;
  total: number;
  retiredCount: number;
  limit: number;
  offset: number;
}

export interface DeliverableQueryOptions {
  /** 取全量（导出用）：忽略 limit/offset，排序仍生效。 */
  all?: boolean;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SQL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * 时间筛选归一到库内 `YYYY-MM-DD HH:MM:SS`（UTC 基准，与 `datetime('now')` 同尺）。
 *   · `YYYY-MM-DD`：按边取当日 00:00:00 / 23:59:59；
 *   · 已是 SQL 时：原样；
 *   · ISO 8601：取 UTC 部分。
 * 空串返回空串（不加条件）；**非空但不认识则抛**——静默忽略会让用户以为筛选生效了。
 */
export function toSqlUtc(input: unknown, edge: 'start' | 'end'): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (DATE_ONLY_RE.test(raw)) return `${raw} ${edge === 'start' ? '00:00:00' : '23:59:59'}`;
  if (SQL_TIME_RE.test(raw)) return raw;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 19).replace('T', ' ');
  throw new Error(`时间格式无效：${raw}（支持 YYYY-MM-DD 或 ISO 8601）`);
}

/** 排序词归一；未知值**抛**（不静默回退到默认排序）。 */
export function normalizeSort(input: unknown): DeliverableSort {
  const raw = String(input ?? '').trim();
  if (!raw) return 'created_at';
  const normalized = SORT_ALIASES[raw] ?? raw;
  if (!(DELIVERABLE_SORTS as readonly string[]).includes(normalized)) throw new Error(`不支持的排序：${raw}`);
  return normalized as DeliverableSort;
}

/** 方向词归一；未知值**抛**。 */
export function normalizeOrder(input: unknown): DeliverableOrder {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return 'desc';
  if (raw === 'asc' || raw === 'desc') return raw;
  throw new Error(`不支持的排序方向：${raw}（仅 asc / desc）`);
}

/** SQL 侧排序表达式（`size` 无 SQL 表达式，走 JS 侧）。 */
function sortExpr(sort: DeliverableSort): string | null {
  switch (sort) {
    case 'created_at': return 'd.created_at';
    case 'updated_at': return 'COALESCE(d.updated_at, d.created_at)';
    case 'name': return "LOWER(COALESCE(d.name, ''))";
    case 'type': return "COALESCE(d.type, '')";
    case 'status': return "COALESCE(d.status, '')";
    case 'quality': return 'COALESCE(t.quality_score, -1)';
    case 'project': return "LOWER(COALESCE(p.name, ''))";
    case 'version_count': return '(SELECT COUNT(*) FROM wa_deliverable_versions v WHERE v.deliverable_id = d.id)';
    case 'size': return null;
  }
}

/**
 * 产出物列表（含分页/总数/已退休计数）。**不抛业务错**之外的东西——参数非法会抛（调用方回 INVALID_PARAM）。
 */
export function queryDeliverables(
  db: Database.Database,
  params: DeliverableListParams = {},
  opts: DeliverableQueryOptions = {},
): DeliverableQueryResult {
  const p = params ?? {};
  const sort = normalizeSort(p.sort);
  const order = normalizeOrder(p.order);
  const dir = order === 'asc' ? 'ASC' : 'DESC';

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (p.projectId) { conditions.push('d.project_id = ?'); values.push(p.projectId); }
  if (p.type) { conditions.push('d.type = ?'); values.push(p.type); }
  if (p.status) { conditions.push('d.status = ?'); values.push(p.status); }
  const kw = (p.keyword || '').trim();
  if (kw) {
    conditions.push("(d.name LIKE ? OR d.description LIKE ? OR d.type LIKE ? OR d.file_path LIKE ? OR COALESCE(d.registry_id, '') LIKE ?)");
    const like = `%${kw}%`;
    values.push(like, like, like, like, like);
  }
  if (p.taskId === DELIVERABLE_TASK_NONE) conditions.push('d.task_id IS NULL');
  else if (p.taskId) { conditions.push('d.task_id = ?'); values.push(p.taskId); }
  const since = toSqlUtc(p.since, 'start');
  if (since) { conditions.push('d.created_at >= ?'); values.push(since); }
  const until = toSqlUtc(p.until, 'end');
  if (until) { conditions.push('d.created_at <= ?'); values.push(until); }
  if (p.primary === true) conditions.push('d.is_primary = 1');

  // 取数范围（探针滤除；档案视图含已退休）与附加筛选同接一处——与旧 handler 同一顺序。
  const scope = deliverableScopeSql({ alias: 'd', includeRetired: true });
  conditions.push(scope.sql);
  values.push(...scope.params);

  // 明细口径：仅在「未显式选状态」且「不收已退休」时把 retired 挡在列表外。
  //   `total` 与 rows 必须同尺（同 WHERE），故 total 用 display 条件；`retiredCount` 用 core 条件算。
  const coreWhere = conditions.join(' AND ');
  const displayConditions = [...conditions];
  if (p.showRetired === false && !p.status) displayConditions.push("d.status != 'retired'");
  const displayWhere = displayConditions.join(' AND ');

  const from = `FROM wa_deliverables d
        JOIN wa_projects p ON d.project_id = p.id
        LEFT JOIN wa_tasks t ON t.id = d.task_id`;

  const total = (db.prepare(`SELECT COUNT(*) AS c ${from} WHERE ${displayWhere}`).get(...values) as { c: number }).c;
  const retiredCount = (db.prepare(`SELECT COUNT(*) AS c ${from} WHERE ${coreWhere} AND d.status = 'retired'`).get(...values) as { c: number }).c;

  const page = resolvePage(p.limit, p.offset);
  const select = `SELECT d.*, d.rowid AS _rowid, p.name as project_name, t.title as task_title, t.status as task_status, t.quality_score as task_quality_score,
        (SELECT COUNT(*) FROM wa_deliverable_versions v WHERE v.deliverable_id = d.id) AS version_count
        ${from} WHERE ${displayWhere}`;

  const expr = sortExpr(sort);
  let rows: Array<Record<string, unknown>>;
  let limit = page.limit;
  let offset = page.offset;
  if (opts.all || sort === 'size') {
    rows = db.prepare(`${select} ORDER BY ${expr ?? 'd.created_at'} ${dir}, d.rowid ${dir}`).all(...values) as Array<Record<string, unknown>>;
    if (sort === 'size') {
      for (const r of rows) r.size_bytes = statSizeBytes(r.file_path);
      const sign = order === 'asc' ? 1 : -1;
      rows.sort((a, b) => {
        const va = a.size_bytes == null ? -1 : Number(a.size_bytes);
        const vb = b.size_bytes == null ? -1 : Number(b.size_bytes);
        if (va !== vb) return sign * (va - vb);
        return sign * (Number(a._rowid) - Number(b._rowid));
      });
    }
    if (opts.all) { limit = rows.length; offset = 0; }
    else rows = rows.slice(page.offset, page.offset + page.limit);
  } else {
    rows = db.prepare(`${select} ORDER BY ${expr} ${dir}, d.rowid ${dir}${page.sql}`)
      .all(...values, ...page.params) as Array<Record<string, unknown>>;
  }

  const writers = otherWriters(db, rows as Array<{ id: string; task_id?: string | null }>);
  for (const r of rows) r.other_writers = writers.get(String(r.id)) || [];
  annotateAcceptance(db, rows);
  if (sort !== 'size') for (const r of rows) r.size_bytes = statSizeBytes(r.file_path);
  for (const r of rows) delete r._rowid;

  return { rows, total, retiredCount, limit, offset };
}
