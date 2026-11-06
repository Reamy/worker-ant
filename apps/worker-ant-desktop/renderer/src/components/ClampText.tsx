import { useState } from 'react';
import { needsClamp } from '../lib/clamp-text';

/**
 * zx_20261003 M11: 长文正文的**可收可展**渲染——折叠态限高 + 「展开全文」提示，展开态全文 + 「收起」。
 *
 * 为什么是个组件而不是内联 JSX：折叠态是**每一行各自**的状态（同屏多条各收各展），
 * 而会话流是按 `convs.map(...)` 渲染的——在 map 里放 `useState` 会被 React 的 Hooks 规则拒。
 * 故把"每条自己的折叠态"收进这个组件（每行一个实例）。
 *
 * ⚠ 折叠与否由 `needsClamp`（`lib/clamp-text.ts`）**一处**判；此组件不自带第二把尺。
 * ⚠ **不改消息数据契约**：只渲染，正文原样来自 `messageViewOf`（本组件不做任何截断/改写文本）。
 */
export function ClampText({
  text, className = '', textClassName = '',
}: {
  text: string; className?: string; textClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const clamp = needsClamp(text);
  const collapsed = clamp && !expanded;
  return (
    <div className={`min-w-0 ${className}`}>
      <p
        className={`whitespace-pre-wrap break-words ${collapsed ? 'max-h-40 overflow-hidden' : ''} ${textClassName}`}
        title={collapsed ? '长文已折叠——点下方「展开全文」看全部' : undefined}
      >
        {text}
      </p>
      {clamp && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[11px] text-blue-600 hover:underline"
        >
          {expanded ? '收起' : `展开全文（共 ${text.length} 字）`}
        </button>
      )}
    </div>
  );
}
