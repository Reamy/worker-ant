import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from './cx';

/**
 * Button「一处形状」—— 全局只有这一种按钮形。
 *
 * 语义（颜色只表达语义，页面不手写 bg-/text- 色值）：
 *   · primary   主行动（每屏至多一个）—— 主色墨蓝；
 *   · secondary 次行动 —— 白面 + 1px 线；
 *   · ghost     弱化动作（关闭、清空、行内轻操作）—— 无底无边；
 *   · danger    危险 / 不可逆 —— 朱砂，且只在这里出现。
 *
 * 异步纪律：`loading` 时立即禁用并改成「处理中…」，给即时反馈；成功与否由调用方按真实结果渲染。
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** 载入中的文案，默认「处理中…」 */
  loadingText?: ReactNode;
  /** 文字前的图标（可选；纯图标按钮请补 aria-label） */
  icon?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border border-transparent bg-accent text-paper hover:bg-accent/90',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-paper',
  ghost: 'border border-transparent bg-transparent text-ink-soft hover:bg-paper hover:text-ink',
  danger: 'border border-transparent bg-cinnabar text-paper hover:bg-cinnabar/90',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-10 gap-2 px-4 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    loadingText = '处理中…',
    icon,
    className,
    disabled,
    type = 'button',
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-control font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : icon}
      {loading ? loadingText : children}
    </button>
  );
});
