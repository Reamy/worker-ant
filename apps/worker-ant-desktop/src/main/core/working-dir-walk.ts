/**
 * zx_20261109_1 B1：工作目录遍历的**唯一一处**（目录级剪枝）。
 *
 * 病根：旧实现 `fsp.readdir(root, { recursive: true })` 先把整棵树枚举完（怡寿里实测 61,008 条目 /
 * 12,235 个目录），再逐条丢掉 `node_modules`/`.git`/`dist` 等目录里的 52,151 条——被跳过的目录
 * 我们**根本不关心**，却为它们付了 readdir + 逐条 path.join/relative/正则的全部成本。
 *
 * 本模块按目录边界下刀：目录项自身命中剪枝谓词就**不下沉**（不读它的子项）。
 * 语义边界（缺一不可，均有 rr 集合等价断言）：
 * ① **不剪隐藏目录**——旧实现只按 basename 过滤文件，`.foo/a.txt` 仍被收录；剪掉隐藏目录会缩小采样面；
 * ② 不跟随符号链接（`Dirent.isDirectory()` 对软链为 false，与 `readdir({recursive:true})` 同）；
 * ③ 最终文件谓词由调用方传入（`world-snapshot.ts` 的 `isSampledWorkingFile`），本模块不复制正则。
 *
 * 纯遍历、零业务判断；`statMode:'all'` 只服务于需要 size 的 `generateFactSnapshot`。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface WorkingFile {
  abs: string;
  rel: string;
  size: number | null;
  mtimeMs: number | null;
}

export interface WalkOptions {
  /** 只列目录/文件、最多下沉到的目录深度（root 的子目录 = 1）。默认不限。 */
  maxDepth?: number;
  /** 检查的原始目录项上限（含被剪枝目录本身）。超限即停并置 `truncatedScan`。默认不限。 */
  maxEntries?: number;
  /** 总耗时上限（ms）。超限即停并置 `truncatedScan`。默认不限。 */
  deadlineMs?: number;
  /** 每检查多少条目让出一拍（默认 2048）。 */
  yieldEvery?: number;
  /** 目录项是否剪枝；`relDir` 带尾斜杠、根下目录形如 `node_modules/`。 */
  shouldSkipDir?: (relDir: string, name: string) => boolean;
  /** 文件项是否跳过；`rel` 为相对 root 的路径。 */
  shouldSkipFile?: (name: string, rel: string) => boolean;
  /** 每个未被剪枝的目录（含因深度不再下沉的）回调一次，`rel` 无尾斜杠。 */
  onDir?: (rel: string) => void;
  /** 每个被收录的文件按遍历顺序回调一次（供需要保持 readdir 交错顺序的消费者）。 */
  onFile?: (file: WorkingFile) => void;
  /** 是否收录非普通文件（软链等）。默认 false——与 `readdir({recursive:true})` + `Dirent.isFile()` 同口径。 */
  includeNonFiles?: boolean;
  /** 'all' = 逐文件 stat 填 size/mtimeMs（失败留 null）；'none' = 不 stat。 */
  statMode?: 'none' | 'all';
}

export interface WalkResult {
  files: WorkingFile[];
  dirsScanned: number;
  entriesScanned: number;
  truncatedScan: boolean;
}

/**
 * 深度优先遍历工作目录。目录顺序/文件顺序与 `readdir` 返回一致（不排序，由调用方按需排）。
 * 目录不可读只跳过该目录（与旧实现同一纪律：不让一条坏路径废掉整轮盘点）。
 */
export async function walkWorkingDir(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const files: WorkingFile[] = [];
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY;
  const deadlineAt = opts.deadlineMs != null ? Date.now() + opts.deadlineMs : Number.POSITIVE_INFINITY;
  const yieldEvery = Math.max(1, opts.yieldEvery ?? 2048);
  const statAll = opts.statMode === 'all';
  let dirsScanned = 0;
  let entriesScanned = 0;
  let truncatedScan = false;

  const overLimit = (): boolean => {
    if (entriesScanned >= maxEntries || Date.now() > deadlineAt) { truncatedScan = true; return true; }
    return false;
  };

  const walk = async (dirAbs: string, relDir: string, depth: number): Promise<void> => {
    if (overLimit()) return;
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (overLimit()) return;
      entriesScanned++;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // 深度检查与目录可见性分离：旧 `generateFactSnapshot` 会列出"因深度不再下沉"的那层目录，
        // 故先回调再决定是否继续（语义等价，见 rr B1-F）。
        if (opts.shouldSkipDir?.(`${rel}/`, e.name)) continue;
        dirsScanned++;
        opts.onDir?.(rel);
        if (depth + 1 <= maxDepth) await walk(path.join(dirAbs, e.name), rel, depth + 1);
      } else if (e.isFile() || (opts.includeNonFiles === true && !e.isDirectory())) {
        if (opts.shouldSkipFile?.(e.name, rel)) continue;
        const abs = path.join(dirAbs, e.name);
        let size: number | null = null;
        let mtimeMs: number | null = null;
        if (statAll) {
          try { const st = await fsp.stat(abs); size = st.size; mtimeMs = st.mtimeMs; } catch { /* 单文件不可读：留 null */ }
        }
        const file: WorkingFile = { abs, rel, size, mtimeMs };
        files.push(file);
        opts.onFile?.(file);
      }
      if (entriesScanned % yieldEvery === 0) await new Promise<void>((r) => setImmediate(r));
    }
  };

  await walk(root, '', 0);
  return { files, dirsScanned, entriesScanned, truncatedScan };
}
