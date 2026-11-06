import type { LiveQuery } from '../lib/useLiveQuery';
import { RotateCw } from 'lucide-react';

/**
 * A1 (2026-09-04_2): 数据保鲜度指示（空性·无常 → 界面数据皆时点投影）。
 * 三种观感：
 *  - loading（首次加载）
 *  - 实时（isLive 且未过期）：绿点 + "实时 · HH:mm:ss"
 *  - 新鲜（无自动源但刚刷新）：灰 "更新于 HH:mm:ss"
 *  - stale（距最近刷新超阈值）：琥珀 "数据可能已过期 · 刷新"（可点击 reload）
 */
export function FreshnessPill<T>({ q, className = '', onReload }: {
  q: LiveQuery<T>;
  className?: string;
  onReload?: () => void;
}): React.ReactElement | null {
  if (q.loading && q.data == null) {
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 ${className}`} title="正在加载">
        <RotateCw className="w-3 h-3 animate-spin" />加载中
      </span>
    );
  }

  const fmt = (ms: number | null): string => {
    if (ms == null) return '';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  if (q.stale && q.updatedAt != null) {
    return (
      <button
        type="button"
        onClick={() => { void q.reload(); onReload?.(); }}
        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200 cursor-pointer ${className}`}
        title={`数据可能已过期（更新于 ${fmt(q.updatedAt)}），点击刷新`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />数据可能已过期·刷新
      </button>
    );
  }

  if (q.isLive && !q.stale) {
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-green-50 text-green-700 ${className}`} title={`事件驱动自动刷新 · 更新于 ${fmt(q.updatedAt)}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />实时 {fmt(q.updatedAt)}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 ${className}`} title="手动刷新 · 距最近一次加载">
      <RotateCw className="w-3 h-3" />更新于 {fmt(q.updatedAt)}
    </span>
  );
}
