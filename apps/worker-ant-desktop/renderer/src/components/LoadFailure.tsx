/**
 * zx_20261110_1 B5（海德格尔·在世存在）：卡片级「加载失败」与「确实没有数据」必须分得开。
 *
 * 病灶：五页里多路读取失败被 `catch {}` 吞掉并把状态置空/置 []，卡片随即渲染
 *   「暂无成员 / 暂无数据」——把"没取到"说成"没有"，界面与库分家。
 *
 * 治法：失败时卡片内显示失败因由 + 重试；有理据的空态仍由各页自己写。
 *
 * zx_20261121_3 M5-b：形状收进统一 `ErrorState`（一处形状），文案逐字不变：
 *   `<what>加载失败：<reason>`；重试走统一 Button。本组件只做参数转接，零判据。
 */
import { ErrorState } from './ui';

export default function LoadFailure({
  what,
  reason,
  onRetry,
  busy,
}: {
  what: string;
  reason: string;
  onRetry?: () => void;
  busy?: boolean;
}) {
  return <ErrorState compact title={`${what}加载失败`} reason={reason} onRetry={onRetry} busy={busy} />;
}
