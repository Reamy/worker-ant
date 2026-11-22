import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * PageHeader「一处形状」—— 每页第一屏只此一个页头。
 *
 * 三段式（潘诺夫斯基：标题先回答「这是哪」，再回答「看什么」）：
 *   · eyebrow  眉题：所处域 / 位置（小号、字距拉开，用标题宋体）
 *   · title    标题：这一页叫什么（宋体 + 大字重，和正文明显分层）
 *   · claim    一句主张：**此刻是什么 + 凭什么**（必填，不准只写模块名；栏宽 ≤ 42em）
 *
 * 纪律：
 *   · 主行动至多一个（`primaryAction`）；其余动作一律 `actions`（secondary/ghost）。
 *   · 本组件只管排版与四至，不判据、不发请求。
 */
export interface PageHeaderProps {
  /** 眉题：这一页属于哪个域 */
  eyebrow?: ReactNode;
  /** 页标题 */
  title: ReactNode;
  /** 一句主张（必填）：此刻是什么、凭什么、下一步 */
  claim: ReactNode;
  /** 次行动：secondary / ghost，可多个 */
  actions?: ReactNode;
  /** 主行动：至多一个，调用方用 <Button variant="primary"> */
  primaryAction?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, claim, actions, primaryAction, className }: PageHeaderProps) {
  return (
    <header data-page-header className={cx('mb-5 flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="font-display text-[11px] tracking-[0.18em] text-ink-mute">{eyebrow}</p>
        )}
        <h1 className="mt-1 font-display text-[22px] font-semibold leading-tight text-ink">{title}</h1>
        <p className="measure mt-1.5 text-sm leading-relaxed text-ink-soft">{claim}</p>
      </div>
      {(actions || primaryAction) && (
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {actions}
          {primaryAction}
        </div>
      )}
    </header>
  );
}
