/**
 * zx_20261108_1 B6（维特根斯坦·一处真源）: 成果"盘上真实字节数"的**唯一取数点**。
 *
 * 原在 `ipc/project.ipc.ts` 内私有，B6 后列表查询搬到 `core/deliverable-query.ts`（rr 可直跑），
 * 导出 CSV 也走同一份查询——三处若各 stat 一遍就是三把尺。故上提到零 electron 依赖的 core。
 *
 * `wa_deliverables` **没有 size 列**（DB 里的 size 只存在于 `wa_deliverable_versions.size`，且那是
 * **字符数**，见 database.ts 该列的 DDL 注记），故只能按 `file_path` 现场 stat。
 * **失败一律 `null`（界面 `—`），绝不抛**——一个件的路径失效不该把整页列表打红；
 * "不知道大小"与"大小为零"是两回事，故不返回 0。
 */
import fs from 'node:fs';

export function statSizeBytes(filePath: unknown): number | null {
  const p = typeof filePath === 'string' ? filePath.trim() : '';
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch { return null; }
}
