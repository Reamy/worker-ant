/**
 * zx_20261110_1 B5（海德格尔·在世存在）：卡片级「加载失败」与「确实没有数据」必须分得开。
 *
 * 病灶：五页里多路读取失败被 `catch {}` 吞掉并把状态置空/置 []，卡片随即渲染
 *   「暂无成员 / 暂无数据」——把"没取到"说成"没有"，界面与库分家。
 *
 * 治法：失败时卡片内显示失败因由 + 重试；有理据的空态仍由各页自己写。
 */
import { AlertTriangle, RefreshCw } from 'lucide-react';

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
  return (
    <div className="text-sm p-2 bg-red-50 border border-red-100 rounded">
      <p className="text-red-700 flex items-start gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{what}加载失败：{reason}</span>
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 border border-red-200 rounded-lg text-xs text-gray-600 hover:bg-white disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
          重试
        </button>
      )}
    </div>
  );
}
