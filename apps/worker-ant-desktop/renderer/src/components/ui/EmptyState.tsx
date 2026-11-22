import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * EmptyState「一处形状」—— 空态 = 一句事实 + 一个出口。
 *
 * 纪律：
 *   · 不写「暂无数据」了事：说清这里本该有什么，并给下一步（`action`）。
 *   · **读不到 ≠ 0**：接口失败请用 ErrorState，不许拿空态冒充。
 *   · 与 ErrorState / Skeleton 同位置、同尺寸、同语气（三态同形）。
 */
export interface EmptyStateProps {
  /** 一句事实（这里本该有什么） */
  title: ReactNode;
  /** 一句解释 / 下一步线索 */
  description?: ReactNode;
  /** 一个出口（Button / 链接，通常 secondary） */
  action?: ReactNode;
  /** 可选线性图标（不要 emoji） */
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ title, description, action, icon, compact = false, className }: EmptyStateProps) {
  return (
    <div
      data-state="empty"
      className={cx(
        'flex flex-col items-center justify-center rounded-card border border-dashed border-line bg-paper text-center',
        compact ? 'px-4 py-6' : 'px-6 py-12',
        className,
      )}
    >
      {icon && <div className="mb-2 text-ink-mute">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="measure mt-1 text-xs leading-relaxed text-ink-mute">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
