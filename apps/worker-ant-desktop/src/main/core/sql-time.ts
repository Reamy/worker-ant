/**
 * zx_20261022_2 批二（道德经·五十四章「修之于身，其德乃真」）: 时刻比较的**一把尺**。
 *
 * 病根：`updated_at` 在真库里混着两种写法——命令路写 `datetime('now')`（`YYYY-MM-DD HH:MM:SS`），
 * 事件投影器写 `event.timestamp`（ISO `…T…Z`）。SQLite 的字符串比较逐字节进行，
 * `'2026-10-22T05:37:42.109Z' < datetime('now','-10 minutes')` 恒为 0（`T` > 空格）⇒
 * 自愈/超时判据对 ISO 行**永不命中**（真库 257 行中 160 行为 ISO）。
 *
 * `datetime(col)` 让 SQLite 用同一套解析规则把两种写法都归一成 `YYYY-MM-DD HH:MM:SS` 再比。
 * 列名**只由仓库内字面量传入**（不接用户输入）；一处真源，不各写一份 `datetime(...)`。
 */
export function utcSql(col: string): string {
  return `datetime(${col})`;
}
