/**
 * zx_20260913 M1-5(庄子·得鱼忘筌 / 维特根斯坦·同一把尺): 对话取数条件与分页的**唯一出口**。
 *
 * 病根: `im:conversations` 此前只能在「全渠道对话」上翻页——7004 条里找一条等于没有;
 *   且排序、游标、过滤若各处各拼一份条件, 迟早出现"排序一套、过滤一套"(同一把尺的旧账)。
 * 修法: 把 WHERE/ORDER/LIMIT/OFFSET 全部收进本函数, `im:conversations` 与受控复跑**同源**——
 *   rr 能在内存库上跑**生产真入参**(而非自造等价 SQL), 见 feedback「往返/闭环判据须在生产入参上证」。
 *
 * 安全: 一律**参数化绑定**(`?`), 不拼字符串; `q` 只作 LIKE 值, 无注入面。
 * 语义: `direction` 只认 inbound/outbound, 其余(含空)视为不过滤; `beforeSeq` 优先于 `offset`。
 */
import type { Database } from 'better-sqlite3';

/** 与渲染侧 `CONV_PAGE` 同尺（一页条数）。 */
export const CONV_PAGE_SIZE = 50;

export interface ConvQueryOpts {
  channelId: string;
  offset?: number;
  beforeSeq?: number;
  /** 搜索词：对 `message_json` 做 LIKE（参数化）。 */
  q?: string;
  /** 方向筛选：'inbound' | 'outbound'；其余值视为不过滤。 */
  direction?: string;
}

export interface ConvQuery {
  sql: string;
  params: Array<string | number>;
}

export function buildConversationsQuery(opts: ConvQueryOpts): ConvQuery {
  const where: string[] = ['channel_id = ?'];
  const params: Array<string | number> = [opts.channelId];
  const kw = (opts.q || '').trim();
  if (kw) { where.push('message_json LIKE ?'); params.push(`%${kw}%`); }
  const dir = (opts.direction || '').trim();
  if (dir === 'inbound' || dir === 'outbound') { where.push('direction = ?'); params.push(dir); }
  const filter = where.join(' AND ');
  const cursor = Number(opts.beforeSeq);
  // 游标与过滤**组合后**仍不重不漏：排序(rowid DESC)、游标(rowid <)、过滤同一 WHERE。
  if (Number.isFinite(cursor) && cursor > 0) {
    return {
      sql: `SELECT rowid AS seq, * FROM wa_im_conversations WHERE ${filter} AND rowid < ? ORDER BY rowid DESC LIMIT ${CONV_PAGE_SIZE}`,
      params: [...params, cursor],
    };
  }
  const off = Math.max(0, Math.floor(Number(opts.offset) || 0));
  return {
    sql: `SELECT rowid AS seq, * FROM wa_im_conversations WHERE ${filter} ORDER BY rowid DESC LIMIT ${CONV_PAGE_SIZE} OFFSET ?`,
    params: [...params, off],
  };
}

/** 便捷执行（生产 handler 用；rr 亦可直接跑真 SQL）。 */
export function listConversations(db: Database, opts: ConvQueryOpts): Array<Record<string, unknown>> {
  const { sql, params } = buildConversationsQuery(opts);
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

/**
 * zx_20260930 M2-c（维特根斯坦·意义即使用）: 给已取回的对话行**补上任务名**
 *   （行 → 它所属任务的人读标牌），供 IM 页显示「属于任务X」。
 *
 * 为什么**不做成 JOIN**（而在这里补一趟）：
 *   ① `buildConversationsQuery` 的 SQL 形状**被前序 rr 逐字钉死**
 *      （`rr_zx_20260912` 钉 `ORDER BY rowid DESC LIMIT 50 OFFSET ?` 与 `AND rowid < ? ORDER BY rowid DESC`）；
 *      加 JOIN 就必须把 `rowid` 限定成 `c.rowid`，为了一处**显示**用的小标牌去动分页真源，得不偿失。
 *   ② 「取数条件与分页」与「把已取到的行翻成人读的文字」是**两件事**：前者必须**一页一行不多不少**，
 *      后者只对**本页这 50 行**负责。混进同一条 SQL 会让分页语义被 join 出的行数绑架。
 *
 * 语义只有一条：**`task_id` 为空串的行不标**（无归属就是无归属，不替它编一个名字）。
 * 任务已被删除/查不到时标**空串**（界面据此不显示标牌），**不猜一个标题**。
 */
export function attachTaskTitles(
  db: Database,
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const ids = [...new Set(rows.map((r) => String(r.task_id ?? '')).filter(Boolean))];
  if (!ids.length) return rows;
  // 参数化绑定（只拼占位符个数，值一律走 `?`；与本事取数口径同源，无注入面）。
  const ph = ids.map(() => '?').join(',');
  const titles = new Map(
    (db.prepare(`SELECT id, title FROM wa_tasks WHERE id IN (${ph})`).all(...ids) as Array<{ id: string; title?: string }>)
      .map((t) => [t.id, t.title || '']),
  );
  for (const r of rows) {
    const tid = String(r.task_id ?? '');
    if (tid) r.task_title = titles.get(tid) || '';
  }
  return rows;
}
