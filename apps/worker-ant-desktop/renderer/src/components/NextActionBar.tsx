/**
 * zx_20261111_3「显」（乔布斯·简洁是终极的复杂 / 道德经·少则得）:
 *   五页共用的**第一行**——只负责把 `NextAction` 画出来。
 *
 * 纪律：
 *   · **零判据**：说什么、给什么按钮、什么语气，全由 `core/next-action.ts` 决定；
 *     本组件只做 tone → 配色 的映射与排版（改文案不动这里）。
 *   · **不摆两个按钮**：`action` 至多一个；没有 `action` 就只显示一句话。
 *   · 一行高、细条、不占卡片位（首屏卡 ≤6 的约束不因它被打破）。
 */
import type { NextAction, NextActionId } from '../../../src/main/core/next-action.js';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, HelpCircle } from 'lucide-react';

const TONE: Record<NextAction['tone'], { cls: string; Icon: typeof AlertTriangle }> = {
  act: { cls: 'bg-blue-50 border-blue-200 text-blue-900', Icon: AlertTriangle },
  waiting: { cls: 'bg-amber-50 border-amber-200 text-amber-900', Icon: Clock },
  blocked: { cls: 'bg-red-50 border-red-200 text-red-900', Icon: AlertTriangle },
  ok: { cls: 'bg-green-50 border-green-200 text-green-900', Icon: CheckCircle2 },
  unknown: { cls: 'bg-gray-50 border-gray-200 text-gray-700', Icon: HelpCircle },
};

export default function NextActionBar({
  action,
  onAction,
}: {
  action: NextAction;
  onAction?: (id: NextActionId) => void;
}) {
  const { cls, Icon } = TONE[action.tone] ?? TONE.unknown;
  // zx_20261118_2 M1（答）：两行式——标题独占第一行，说明另起一行。
  //   病根：原实现把 headline / detail / button 塞同一 flex 行，detail 用 `truncate` ⇒
  //   待答任务的完整问题被截成一行省略号，且长说明把标题挤窄。这里不再用 `truncate`：
  //   说明按原样换行；超长时块内滚动（max-h-24），不省略、不截断。
  return (
    <div
      className={`px-3 py-2 rounded-lg border text-sm ${cls}`}
      data-next-action={action.key}
      data-next-tone={action.tone}
      role="status"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 shrink-0" />
        <span className="font-medium min-w-0 flex-1">{action.headline}</span>
        {action.action && onAction && (
          <button
            type="button"
            onClick={() => onAction(action.action!.id)}
            className="shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-white/70 border border-current/20 hover:bg-white"
          >
            {action.action.label}
            <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      {action.detail && (
        <p className="mt-1 text-xs opacity-80 whitespace-pre-wrap break-words max-h-24 overflow-y-auto" title={action.detail}>
          {action.detail}
        </p>
      )}
    </div>
  );
}
