import type { ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { cx } from './cx';

/**
 * ErrorState「一处形状」—— 错态 = 原因 + 重试。
 *
 * 纪律：
 *   · **读不到 ≠ 0**：错误绝不渲染成空态，`reason` 必须是真原因（接口/异常原文），不编。
 *   · 与 EmptyState / Skeleton 同位置、同尺寸、同语气（三态同形）。
 *   · 重试走统一 Button（secondary / sm），点击即禁用 + 转圈，按钮词保持「重试」不变
 *     （同一个词全局同一个词；「处理中…」留给真正会改世界的动作）。
 */
export interface ErrorStateProps {
  /** 错在哪件事上，默认「读取失败」 */
  title?: ReactNode;
  /** 真原因（来自接口/异常） */
  reason: ReactNode;
  onRetry?: () => void;
  retryLabel?: ReactNode;
  busy?: boolean;
  compact?: boolean;
  className?: string;
}

export function ErrorState({
  title = '读取失败',
  reason,
  onRetry,
  retryLabel = '重试',
  busy = false,
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      data-state="error"
      className={cx(
        'rounded-card border border-bad/20 bg-bad-soft',
        compact ? 'px-3 py-2.5' : 'px-4 py-3.5',
        className,
      )}
    >
      <p className="flex items-start gap-2 text-sm font-medium text-bad">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          {title}
          <span className="font-normal text-ink-soft">：{reason}</span>
        </span>
      </p>
      {onRetry && (
        <div className="mt-2.5 pl-6">
          <Button
            size="sm"
            variant="secondary"
            onClick={onRetry}
            loading={busy}
            loadingText={retryLabel}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
