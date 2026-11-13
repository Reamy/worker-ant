/**
 * zx_20261108_1 B6（维特根斯坦·意义即用法）: 产出物清单 CSV 导出——**列名与取值只此一处**。
 *
 * 与列表共用 `queryDeliverables`（同 WHERE/排序）⇒ 导出的 N 条就是界面上筛出来的 N 条；
 * 导出落点由 main 侧系统保存对话框决定（渲染层不递任意写路径），失败如实返回字符串。
 *
 * 编码：UTF-8 **带 BOM** + CRLF——Excel 打开中文表头不花码（无 BOM 的 UTF-8 CSV 在 Excel 里是乱码）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CSV_HEADERS = ['项目', '任务', '名称', '类型', '状态', '大小（字节）', '版本数', '创建时间'] as const;

/** UTF-8 BOM。用码点常量而非文件里的不可见字符——源码里肉眼看不见的字符不算"一处真源"。 */
const CSV_BOM = String.fromCharCode(0xfeff);

export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 行 → CSV 文本（表头 + 数据 + 结尾 CRLF）。`size_bytes == null` 留空——"不知道"不冒充 0。 */
export function buildDeliverableCsv(rows: Array<Record<string, unknown>>): string {
  const lines = [CSV_HEADERS.map((h) => csvCell(h)).join(',')];
  for (const r of rows) {
    lines.push([
      r.project_name,
      r.task_title,
      r.name,
      r.type,
      r.status,
      r.size_bytes == null ? '' : r.size_bytes,
      r.version_count == null ? '' : r.version_count,
      r.created_at,
    ].map(csvCell).join(','));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 导出文件名（本地时间，秒级）；只用于 defaultPath，用户仍可在对话框里改名。 */
export function csvFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `deliverables-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;
}

export type CsvWriteResult = { ok: true; count: number; path: string } | { ok: false; error: string };

/** 写 CSV 到**用户已选定**的路径（不在此判定白名单——落点来自系统对话框）。 */
export function writeDeliverableCsv(rows: Array<Record<string, unknown>>, targetPath: string): CsvWriteResult {
  try {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, buildDeliverableCsv(rows), 'utf-8');
    return { ok: true, count: rows.length, path: targetPath };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}
