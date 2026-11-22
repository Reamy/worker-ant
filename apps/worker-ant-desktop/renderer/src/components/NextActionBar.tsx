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
import { Button } from './ui';

// zx_20261121_3 M5-d：tone → 语义 token（act=主色 / waiting=warn / blocked=朱砂 / ok=绿 / unknown=线）。
//   颜色只表达语义；文案与判据仍全在 `core/next-action.ts`，本组件零判据。
const TONE: Record<NextAction['tone'], { box: string; icon: string; Icon: typeof AlertTriangle }> = {
  act: { box: 'border-accent/25 bg-accent-soft', icon: 'text-accent', Icon: AlertTriangle },
  waiting: { box: 'border-warn/25 bg-warn-soft', icon: 'text-warn', Icon: Clock },
  blocked: { box: 'border-cinnabar/25 bg-cinnabar-soft', icon: 'text-cinnabar', Icon: AlertTriangle },
  ok: { box: 'border-ok/25 bg-ok-soft', icon: 'text-ok', Icon: CheckCircle2 },
  unknown: { box: 'border-line bg-surface', icon: 'text-ink-mute', Icon: HelpCircle },
};

export default function NextActionBar({
  action,
  onAction,
}: {
  action: NextAction;
  onAction?: (id: NextActionId) => void;
}) {
  const { box, icon, Icon } = TONE[action.tone] ?? TONE.unknown;
  // zx_20261118_2 M1（答）：两行式——标题独占第一行，说明另起一行。
  //   病根：原实现把 headline / detail / button 塞同一 flex 行，detail 用 `truncate` ⇒
  //   待答任务的完整问题被截成一行省略号，且长说明把标题挤窄。这里不再用 `truncate`：
  //   说明按原样换行；超长时块内滚动（max-h-24），不省略、不截断。
  return (
    <div
      className={`px-3 py-2 rounded-card border text-sm text-ink ${box}`}
      data-next-action={action.key}
      data-next-tone={action.tone}
      role="status"
    >
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 shrink-0 ${icon}`} />
        <span className="font-medium min-w-0 flex-1">{action.headline}</span>
        {action.action && onAction && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onAction(action.action!.id)}
            className="shrink-0"
          >
            {action.action.label}
            <ArrowRight className="w-3 h-3" />
          </Button>
        )}
      </div>
      {action.detail && (
        <p className="mt-1 text-xs text-ink-soft whitespace-pre-wrap break-words max-h-24 overflow-y-auto" title={action.detail}>
          {action.detail}
        </p>
      )}
    </div>
  );
}
