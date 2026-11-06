/**
 * zx_20260930 M4-2(管子·度量衡 / 维特根斯坦·同一把尺): 列表分页参数的**唯一夹取处**。
 *
 * 病根：`deliverable:list` 与 `task:get` 的 conversations/deliverables 都是"全表返回"——
 * 真库 `wa_task_conversations` 已有 2.6 万行、`wa_deliverables` 406 行，任务详情要为此
 * 把整条对话链一次性读进内存（且 `deliverable:list` 还逐行 `stat` 文件取大小）。
 * 加 `limit`/`offset` 时若各调用点自己夹取，就会出现"这处夹 500、那处夹 200、另一处忘了夹"
 * 的第二把尺——故夹取规则收在此一处。
 *
 * **刻意不合并**：`core/im/im-outbox.ts` 的 `OUTBOX_PAGE_MAX`（补发账单页硬上限）与这里的
 * `PAGE_MAX` 今日恰同值，但**语义不同**（前者是"一本账一次最多吐多少条"，后者是"通用列表页大小"）；
 * 合并会让"改通用页上限"顺手改动补发账的吐量。二者各自独立，此处登记以免日后被"顺手统一"。
 */

/** 未指定 `limit` 时的默认页大小。 */
export const PAGE_DEFAULT = 100;

/** 单页**硬上限**——超此值一律夹回（不报错，也不让一次查询把整表拉满）。 */
export const PAGE_MAX = 500;

export interface Page {
  limit: number;
  offset: number;
  /** 直接拼在 `ORDER BY …` 之后的片段（本模块只出**片段**，不出整条 SQL）。 */
  sql: string;
  /** 与 `sql` 里两个 `?` 逐位对应的参数。 */
  params: number[];
}

/**
 * 夹取分页参数。规则：
 * - `limit` 缺省/非数/0 ⇒ `PAGE_DEFAULT`；下限 1、上限 `PAGE_MAX`。
 * - `offset` 缺省/非数/负 ⇒ `0`（**刻意不用"报错"或"夹到末页"**：负偏移量是调用方的口误，
 *   当成第 0 页最接近其本意，且不会让整页错位）。
 */
export function resolvePage(limit?: unknown, offset?: unknown): Page {
  const rawLim = Math.trunc(Number(limit));
  const rawOff = Math.trunc(Number(offset));
  const lim = Math.min(Math.max(Number.isFinite(rawLim) && rawLim !== 0 ? rawLim : PAGE_DEFAULT, 1), PAGE_MAX);
  const off = Math.max(Number.isFinite(rawOff) ? rawOff : 0, 0);
  return { limit: lim, offset: off, sql: ' LIMIT ? OFFSET ?', params: [lim, off] };
}
