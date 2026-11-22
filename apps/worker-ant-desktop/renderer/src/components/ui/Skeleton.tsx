import type { HTMLAttributes } from 'react';
import { cx } from './cx';

/**
 * Skeleton「一处形状」—— 载入态与真实内容同尺寸，不跳动。
 *
 * 纪律：
 *   · 静止的暖灰块 + 读屏「载入中」，不用循环闪烁动画（与 prefers-reduced-motion 同一立场）。
 *   · 与 EmptyState / ErrorState 同位置、同尺寸、同语气（三态同形）。
 *   · 骨架尺寸要照着真实行高画（行高 ≥ 40px 的列表就画 40px），别画一排细条糊弄。
 */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cx('rounded bg-line/60', className)} {...rest} />;
}

/** 多行文本骨架：最后一行收窄到 2/3，看起来像一段话而不是一叠砖 */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cx('space-y-2', className)}>
      <span className="sr-only">载入中…</span>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cx('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
