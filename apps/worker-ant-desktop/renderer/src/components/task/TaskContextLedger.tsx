/**
 * zx_20261115_3 M6「简」（管子·度量衡 / 维特根斯坦·一个数只能有一个值）：
 * 任务详情的**上下文成本账**——七源分账（引擎落账）+ 注入摘要（注入账）。
 *
 * 三条纪律：
 *   ① 只读派生：token 用引擎写的 `execution_metrics.token_breakdown`（同一把 `chars÷4` 尺），本组件不另算；
 *   ② 三态分家：**未记录**（旧任务没有账）/ 已记录 / **读失败**（解析错误）——不把读不到说成 0；
 *   ③ 来源词表不复制第二份：注入来源的人话名引 main 侧 `injection-sources.ts`（零依赖）。
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react';
import { injectionSourceLabel } from '../../../../src/main/core/injection-sources.js';
// zx_20261115_3 M6：账的形状取 main 侧纯函数模块（类型擦除，不引运行时依赖链）。
import type { ContextLedgerView } from '../../../../src/main/core/context-ledger-view.js';
import { formatTokens } from '../../lib/format';

export type { ContextLedgerView };

export interface InjectionSummaryRow {
  source: string;
  rows: number;
  tokens: number;
}

const SOURCE_META: Array<{ key: string; label: string; tone: string }> = [
  { key: 'system', label: '系统骨架', tone: 'bg-slate-400' },
  { key: 'memory', label: '记忆', tone: 'bg-violet-400' },
  { key: 'knowledge', label: '知识', tone: 'bg-sky-400' },
  { key: 'tools', label: '工具面', tone: 'bg-amber-400' },
  { key: 'history', label: '历史', tone: 'bg-emerald-400' },
  { key: 'user', label: '用户输入', tone: 'bg-rose-400' },
  { key: 'output', label: '模型产出', tone: 'bg-indigo-400' },
];

/** 被裁字符的人话名（与上方分账同一组标签；只列真裁过的源）。 */
function trimmedLabels(trimmed: Record<string, number>): string {
  const labels: Record<string, string> = {};
  for (const s of SOURCE_META) labels[s.key] = s.label;
  labels.output = '模型产出';
  return Object.entries(trimmed)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${labels[k] ?? k} ${Number(v)} 字`)
    .join('、');
}

export default function TaskContextLedger({
  ledger,
  error,
  injections,
}: {
  /** `null` = 本轮执行没有落分账（旧任务）；`undefined` 不应出现（main 总会给键）。 */
  ledger: ContextLedgerView | null;
  error: string;
  injections: InjectionSummaryRow[];
}) {
  const [open, setOpen] = useState(false);
  const total = Number(ledger?.totalTokens) || 0;
  const hasInjection = injections.length > 0;
  const summary = error
    ? '读不到'
    : ledger
      ? `本次上下文约 ${formatTokens(total)} token${ledger.budgetTokens ? ` / 预算 ${formatTokens(ledger.budgetTokens)}` : ''}`
      : '未记录';

  return (
    <div className="bg-white rounded-lg border p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full text-left font-medium text-sm flex items-center gap-1">
        {open ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
        <Gauge className="w-4 h-4 text-cyan-600 shrink-0" />上下文与成本
        <span className="text-[10px] font-normal text-gray-400">{summary}</span>
      </button>
      {open && <div className="mt-2 space-y-2">
        {error && <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</p>}
        {!error && !ledger && (
          <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-1">
            本轮执行<span className="font-medium">没有落上下文分账</span>（旧版本任务 / 未进入执行）——这不是"0 token"。
          </p>
        )}
        {!error && ledger && (
          <>
            <div className="flex h-2 w-full overflow-hidden rounded bg-gray-100">
              {SOURCE_META.map((s) => {
                const v = Number(ledger.tokens?.[s.key]) || 0;
                const pct = total > 0 ? Math.max(v > 0 ? 2 : 0, Math.round((v / total) * 100)) : 0;
                return v > 0 ? <div key={s.key} className={s.tone} style={{ width: `${pct}%` }} title={`${s.label}：${formatTokens(v)} token`} /> : null;
              })}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[11px] text-gray-600">
              {SOURCE_META.map((s) => (
                <span key={s.key} className="flex items-center gap-1 min-w-0">
                  <span className={`inline-block w-2 h-2 rounded-sm ${s.tone} shrink-0`} />
                  <span className="truncate">{s.label}</span>
                  <span className="ml-auto font-mono text-gray-800">{formatTokens(Number(ledger.tokens?.[s.key]) || 0)}</span>
                </span>
              ))}
            </div>
            <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
              <span>合计 <span className="font-mono text-gray-800">{formatTokens(total)}</span> token</span>
              {ledger.budgetTokens != null && <span>预算 <span className="font-mono text-gray-800">{formatTokens(ledger.budgetTokens)}</span></span>}
              {ledger.overBudget === true && <span className="text-amber-700">裁剪后仍超预算（不可裁的源本身即超）</span>}
              {ledger.trimmedChars && Object.values(ledger.trimmedChars).some((v) => Number(v) > 0) && (
                <span>已裁：{trimmedLabels(ledger.trimmedChars)}</span>
              )}
              {(ledger.inputTokens != null || ledger.outputTokens != null) && (
                <span>实报 token：输入 <span className="font-mono text-gray-800">{formatTokens(Number(ledger.inputTokens) || 0)}</span> / 输出 <span className="font-mono text-gray-800">{formatTokens(Number(ledger.outputTokens) || 0)}</span></span>
              )}
              {ledger.cost != null && ledger.cost > 0 && <span>估算费用 <span className="font-mono text-gray-800">¥{ledger.cost.toFixed(4)}</span></span>}
            </div>
            <p className="text-[10px] text-gray-400">口径：token 为 chars÷4 估算（`core/token-estimate.ts` 一处真源）；「实报 token」取 provider usage。两者不可相加。</p>
          </>
        )}
        <div className="pt-1 border-t border-gray-100">
          <p className="text-[11px] text-gray-500 mb-1">注入账（本任务树写进了哪些记忆/知识，来源与人话名同源）</p>
          {hasInjection ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 text-[11px] text-gray-600">
              {injections.map((r) => (
                <span key={r.source} className="flex items-center gap-1 min-w-0">
                  <span className="truncate">{injectionSourceLabel(r.source)}</span>
                  <span className="ml-auto font-mono text-gray-800">{r.rows} 条 · {formatTokens(r.tokens)} token</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-gray-400">本任务树没有注入记录（不是"0 token 注入"——是这几次执行确实没写注入账）。</p>
          )}
        </div>
      </div>}
    </div>
  );
}
