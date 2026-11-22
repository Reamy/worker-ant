import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

/**
 * Card / Section「一处形状」—— 内容四至（沃尔夫林：封闭形，每块内容有清楚的边界）。
 *
 * 共同的骨：1px 线 + 白面 + radius-card；固定三处位置：标题、提示、右上动作。
 * 两者的差别只有「是否抬升」：
 *   · Card    —— 抬升面（shadow-card 唯一一档），用于一屏里的主块；
 *   · Section —— 不抬升，用于页面内的分段容器。
 * 纪律：**不叠阴影、不做嵌套卡片**；同一条线不在内外各画一次。
 */
export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 卡片标题（宋体，与正文分层） */
  title?: ReactNode;
  /** 标题下的一句提示（弱墨小字） */
  description?: ReactNode;
  /** 右上动作（secondary / ghost；主行动留在页头） */
  actions?: ReactNode;
  /** 正文是否带内边距；表格类内容传 false 自己贴边 */
  padded?: boolean;
}

function Frame({
  title,
  description,
  actions,
  padded = true,
  elevated,
  className,
  children,
  ...rest
}: CardProps & { elevated: boolean }) {
  const hasHead = Boolean(title || description || actions);
  return (
    <div className={cx('rounded-card border border-line bg-surface', elevated && 'shadow-card', className)} {...rest}>
      {hasHead && (
        <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
          <div className="min-w-0">
            {title && <h3 className="font-display text-[15px] font-semibold leading-snug text-ink">{title}</h3>}
            {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'p-4' : undefined}>{children}</div>
    </div>
  );
}

/** 抬升面：一屏里需要「被看见」的主块 */
export function Card(props: CardProps) {
  return <Frame {...props} elevated />;
}

/** 不抬升的分段容器：与 Card 同形，但留在纸面上 */
export function Section(props: CardProps) {
  return <Frame {...props} elevated={false} />;
}
