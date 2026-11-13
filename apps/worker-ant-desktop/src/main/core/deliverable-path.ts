/**
 * zx_20261108_1 B6（管子·度量衡 / 海德格尔·上手状态）: 成果「打开 / 在文件夹中显示」的**路径围栏**。
 *
 * 病根：此前 GUI 的「在文件夹中显示」把渲染层手里的 `file_path` 原样递给 `shell:showItemInFolder`，
 * 仅判"绝对路径 + 存在"——路径来自库，而库里的行可能是手工成果登记的任何路径。B6 新增
 * `deliverable:open`（`shell.openPath`，会**真启动**文件）后，这一跳必须有白名单：
 *
 *   · 根：只允许 `dataDir` 与**该件所属项目的工作目录**下（调用方把两者传进来，本模块不猜目录）；
 *   · `..` 一律拒（与写侧 `TRAVERSAL_ERROR` 同一纪律）；
 *   · **符号链接**：候选与根两侧都过 `fs.realpath` 再判根——链接指向根外即拒（只比字面路径会被绕过）；
 *   · 失败**如实分词**（`no_path|url|not_absolute|traversal|out_of_root|missing`），不笼统一句"打不开"。
 *
 * 根校验口径归 `path-fence.isInsideRoot`（含分隔符比对），本模块不另写 `startsWith`。
 * ⚠ 只用于**只读/打开**这条跳：另存/导出的落点由用户经系统对话框选，不走此围栏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isInsideRoot } from './path-fence.js';

export type DeliverableFsReason = 'no_path' | 'url' | 'not_absolute' | 'traversal' | 'out_of_root' | 'missing';

export type DeliverableFsResult =
  | { ok: true; path: string }
  | { ok: false; reason: DeliverableFsReason; error: string };

/** URL 方案前缀。与 `im-media.resolveAttachmentRead` / `shell:showItemInFolder` 同形。 */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** realpath 的容错形态：根不存在时退回 resolve（不因根缺失把合法件判死）。 */
function realOrResolved(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * 把库里的 `file_path` 解析成"可以交给系统打开的那一个盘上文件"。
 * @param filePath 库内路径（未知类型按空处理）
 * @param roots 允许的根（`dataDir`、项目工作目录等；空/undefined 项被忽略）
 */
export function resolveDeliverableFsPath(filePath: unknown, roots: Array<string | null | undefined>): DeliverableFsResult {
  const raw = String(filePath ?? '').trim();
  if (!raw) return { ok: false, reason: 'no_path', error: '这条成果没有记录盘上路径' };
  if (URL_SCHEME_RE.test(raw)) return { ok: false, reason: 'url', error: '这是链接地址，不是盘上的文件路径' };
  if (raw.includes('..')) return { ok: false, reason: 'traversal', error: '禁止路径遍历(..)' };
  if (!path.isAbsolute(raw)) return { ok: false, reason: 'not_absolute', error: '成果路径不是绝对路径（已拒绝按当前目录解析）' };

  const realRoots = roots.filter((r): r is string => !!r && String(r).trim().length > 0).map((r) => realOrResolved(String(r).trim()));
  if (realRoots.length === 0) return { ok: false, reason: 'out_of_root', error: '没有可用的授权目录（无法判定路径归属）' };

  let realCand: string;
  try {
    realCand = fs.realpathSync(raw);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: 'missing', error: `盘上找不到这个文件${code ? `（${code}）` : ''}` };
  }
  if (!realRoots.some((root) => isInsideRoot(realCand, root))) {
    return { ok: false, reason: 'out_of_root', error: '成果路径越出数据目录与项目工作目录（已拒绝打开）' };
  }
  try {
    if (!fs.statSync(realCand).isFile()) return { ok: false, reason: 'missing', error: '盘上这个路径不是文件' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: 'missing', error: `盘上找不到这个文件${code ? `（${code}）` : ''}` };
  }
  return { ok: true, path: realCand };
}
