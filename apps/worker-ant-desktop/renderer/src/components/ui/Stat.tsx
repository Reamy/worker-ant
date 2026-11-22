import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * Stat「一处形状」—— 指标 = 标签 + 等宽数值 + 单位 + 口径提示。
 *
 * 纪律：
 *   · 数值一律 `.tnum`（等宽数字，字形宽度不跳）；字体走 mono 栈，和中文正文分层。
 *   · 口径能写就写（`hint` → title）：数字不裸奔，用户可核对「这个数怎么来的」。
 *   · tone 只用于结果语义（ok/warn/bad）或主色强调，不做装饰。
 */
export type StatTone = 'default' | 'accent' | 'ok' | 'warn' | 'bad';

const VALUE_TONE: Record<StatTone, string> = {
  default: 'text-ink',
  accent: 'text-accent',
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
};

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  /** 口径提示（悬停可见） */
  hint?: string;
  tone?: StatTone;
  className?: string;
}

export function Stat({ label, value, unit, hint, tone = 'default', className }: StatProps) {
  return (
    <div className={cx('min-w-0', className)} title={hint}>
      <p className="text-xs text-ink-mute">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-1">
        <span className={cx('tnum font-mono text-xl font-medium leading-none', VALUE_TONE[tone])}>{value}</span>
        {unit && <span className="text-xs text-ink-mute">{unit}</span>}
      </p>
    </div>
  );
}
