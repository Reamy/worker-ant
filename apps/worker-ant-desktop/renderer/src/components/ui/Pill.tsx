import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * Pill「一处形状」—— 状态徽标：颜色由 tone 唯一决定，页面不手写色值。
 *
 * tone 语义（与 index.css 的 token 一一对应）：
 *   neutral  中性信息（纸/线）
 *   accent   可行动 / 进行中（主色）
 *   ok       成功 / 实时（绿）
 *   warn     待办 / 可能过期（黄）
 *   bad      失败 / 读取失败（红）
 *   cinnabar 危险 / 最高优先（朱砂，同屏至多一处）
 */
export type PillTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'cinnabar';

const TONE: Record<PillTone, { box: string; dot: string }> = {
  neutral: { box: 'border-line bg-paper text-ink-soft', dot: 'bg-ink-mute' },
  accent: { box: 'border-accent/20 bg-accent-soft text-accent', dot: 'bg-accent' },
  ok: { box: 'border-ok/20 bg-ok-soft text-ok', dot: 'bg-ok' },
  warn: { box: 'border-warn/20 bg-warn-soft text-warn', dot: 'bg-warn' },
  bad: { box: 'border-bad/20 bg-bad-soft text-bad', dot: 'bg-bad' },
  cinnabar: { box: 'border-cinnabar/20 bg-cinnabar-soft text-cinnabar', dot: 'bg-cinnabar' },
};

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  /** 前置圆点（呼吸/实时感，不闪烁） */
  dot?: boolean;
  title?: string;
  className?: string;
}

export function Pill({ tone = 'neutral', children, dot = false, title, className }: PillProps) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
        t.box,
        className,
      )}
    >
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', t.dot)} aria-hidden="true" />}
      {children}
    </span>
  );
}
