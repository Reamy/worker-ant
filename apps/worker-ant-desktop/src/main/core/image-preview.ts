/**
 * zx_20260914 M2-2(夏克特·七宗罪·信息失落): 图片成果就地预览的**判定与读取**——抽为纯函数，
 * 使 rr 能跑真实现（承「抽纯函数让 rr 跑真实现」），而非切片 handler 源码。
 *
 * 为什么在主进程读：renderer 拿不到本地文件系统（`file://` 在 sandbox 下也常被拒），只能由主进程代读。
 * 三条边界，**每一条都在读盘之前**（读盘本身才是风险面：大文件会卡住主进程、非图片没有意义）：
 *   ①白名单：`png/jpg/jpeg/gif/webp/svg` 之外一律 `unsupported`；
 *   ②上限 **10MB**（用户裁定，见方案 §5.3 D1）：超限 `oversize`，**只 stat 不 read**；
 *   ③路径须是**既有文件**：缺失/目录 `missing`。
 *
 * `io` 是**注入**的（而非直接 `import fs`）——为的是让 rr 挂一个记调用的替身，把"没读盘"变成
 * 可证伪的事实而不是靠读返回值猜。
 */
import path from 'node:path';
import { IMAGE_PREVIEW_MIME, IMAGE_PREVIEW_MAX_BYTES } from './deliverable-types.js';

/** 只取用到的两个方法，避免把 node 类型面铺到调用方。 */
export interface PreviewIo {
  statSync(p: string): { isFile(): boolean; size: number };
  readFileSync(p: string): { toString(encoding: 'base64'): string };
}

export type PreviewOutcome =
  | { ok: true; mime: string; size: number; base64: string }
  | { ok: false; reason: 'unsupported' | 'missing' | 'oversize'; size?: number; limit?: number };

/**
 * 解析一条成果的可预览性。**纯函数**：同样的入参与同样的文件状态必得同样的结论。
 * 三种失败**分别回报**（不是笼统一句"看不了"），渲染层据此各说各的话。
 */
export function resolveImagePreview(filePath: string | null | undefined, name: string | null | undefined, io: PreviewIo): PreviewOutcome {
  const fp = filePath || '';
  const ext = path.extname(fp || name || '').toLowerCase();
  const mime = IMAGE_PREVIEW_MIME[ext];
  if (!mime || !fp) return { ok: false, reason: 'unsupported' };
  let size = 0;
  try {
    const st = io.statSync(fp);
    if (!st.isFile()) return { ok: false, reason: 'missing' };
    size = st.size;
  } catch { return { ok: false, reason: 'missing' }; }
  if (size > IMAGE_PREVIEW_MAX_BYTES) return { ok: false, reason: 'oversize', size, limit: IMAGE_PREVIEW_MAX_BYTES };
  const base64 = io.readFileSync(fp).toString('base64');
  return { ok: true, mime, size, base64 };
}
