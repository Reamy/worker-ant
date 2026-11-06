/**
 * zx_20260930 M15-⑤：列表分页的**唯一处**（models / skills / mcp / a2a / plugins 共用）。
 *
 * 约定（刻意，与"静默截断"相反）：
 *   - `limit` 缺省即**全量**（`defaultLimit = null` ⇒ SQL 不带 LIMIT）——给一个既有阅读面凭空加
 *     一道上限，等于把"名实不符"从一处搬到另一处。要截断，须调用方**显式**开口。
 *   - 插件市场是唯一的例外：它**本来就是**硬 `LIMIT 100`（活库 748 个 active 插件），
 *     故其 `defaultLimit` 取 100——**不改 GUI 现阅读到的条数**，只把"还有多少"如实说出来。
 *   - `offset` 单给也生效（`LIMIT -1 OFFSET n`，SQLite 语义 = 从第 n 行起取全部）。
 *
 * 纯函数、零依赖：判据可直引。
 */
export interface Pagination {
  /** `null` = 不限（SQL 不带 LIMIT）。 */
  limit: number | null;
  offset: number;
}

/** 单页上限：挡 `limit=1e9` 这类把库拖垮的取值。 */
export const MAX_PAGE_SIZE = 500;

/**
 * 从 query 解析分页。**非法值一律退回缺省**（不 400——列表的读面不该因为一个格式错就整页失败）；
 * 但 `limit` 合法时会被 `MAX_PAGE_SIZE` 夹住，`has_more` 仍如实体现在 `total` 上。
 */
export function parsePagination(
  query: Record<string, unknown> | undefined | null,
  defaultLimit: number | null = null,
): Pagination {
  const rawOffset = Number(query?.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const rawLimit = query?.limit;
  if (rawLimit === undefined || rawLimit === null || String(rawLimit).trim() === '') {
    return { limit: defaultLimit, offset };
  }
  const n = Number(rawLimit);
  if (!Number.isFinite(n) || n <= 0) return { limit: defaultLimit, offset };
  return { limit: Math.min(Math.floor(n), MAX_PAGE_SIZE), offset };
}

/** SQL 尾巴（`''` 或 ` LIMIT ? OFFSET ?`）。 */
export function paginationClause(p: Pagination): string {
  if (p.limit === null) return p.offset > 0 ? ' LIMIT -1 OFFSET ?' : '';
  return ' LIMIT ? OFFSET ?';
}

/** 与 `paginationClause` 成对的占位符实参。 */
export function paginationArgs(p: Pagination): unknown[] {
  if (p.limit === null) return p.offset > 0 ? [p.offset] : [];
  return [p.limit, p.offset];
}

/** 响应里的分页元信息：`total` 是**条件命中总数**（与当前筛选同口径），`has_more` 据它算。 */
export function pageMeta(
  total: number,
  p: Pagination,
  returned: number,
): {
  total: number;
  limit: number | null;
  offset: number;
  has_more: boolean;
} {
  return { total, limit: p.limit, offset: p.offset, has_more: p.offset + returned < total };
}
