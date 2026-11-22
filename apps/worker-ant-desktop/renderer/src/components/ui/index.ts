/**
 * 共用 UI 原语桶文件 —— 新页面一律从这里取，不另写第二份按钮/卡片/三态。
 *
 * 一处形状：PageHeader / Card·Section / Button / EmptyState / ErrorState / Skeleton / Stat / Pill。
 * 视觉 token 唯一真源在 `renderer/src/index.css` 的 `@theme`。
 */
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { Card, Section, type CardProps } from './Card';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export { Skeleton, SkeletonText } from './Skeleton';
export { Stat, type StatProps, type StatTone } from './Stat';
export { Pill, type PillProps, type PillTone } from './Pill';
export { cx } from './cx';
