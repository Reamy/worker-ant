/**
 * zx_20261018_2 批一（管子·度量衡）: 图片降质阶梯的**唯一实现**。
 *
 * 来历：`attachment-inline.ts` 原有一份私有 `electronDownscale`（开局附件内联用）；
 *   批一的 `view_image` 视觉子调用也要"把大图压到能发的体量"。若各写一份，
 *   同一张图在两条路上会被压成两种字节数，用户看到的"为什么没送出去"也就有两种口径。
 *   故整体搬到这里，两处同引。
 *
 * ⚠ 静态零 electron 依赖：`nativeImage` 走动态 import；rr 注入自己的桩即可直跑。
 */
export interface DownscaledImage {
  data: Buffer;
  mimeType: string;
}

/** 降质阶梯：**先缩尺寸、再降质量**，命中即停。 */
export const DOWNSCALE_SCALES = [1, 0.6, 0.35] as const;
export const DOWNSCALE_QUALITIES = [75, 55, 35] as const;

/**
 * 生产缺省的图片降质：`nativeImage` 动态 import。
 * 失败一律返回 `null`（**不抛**）：降不了质是**降级**，不该把调用方搞挂。
 */
export async function electronDownscale(p: string, maxBytes: number): Promise<DownscaledImage | null> {
  try {
    const { nativeImage } = await import('electron');
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (!width || !height) return null;
    for (const scale of DOWNSCALE_SCALES) {
      const resized = scale === 1 ? img : img.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good',
      });
      for (const q of DOWNSCALE_QUALITIES) {
        const data = resized.toJPEG(q);
        if (data.length > 0 && data.length <= maxBytes) return { data, mimeType: 'image/jpeg' };
      }
    }
    return null;
  } catch {
    return null;
  }
}
