/**
 * zx_20261107_1 B9（庄子·庖丁解牛）：执行期日志块（实时执行流 + 工具时间线）。
 *
 * 从 TaskDetailPage 抽出——数据仍由页面从 `task:step_finished` 事件累积后传入；
 * 本组件持有自己的滚动容器 ref，新步骤到达时滚到底（原 effect 随块一并搬来）。
 */
import { useEffect, useRef } from 'react';
import { Activity, Clock } from 'lucide-react';
import { formatDuration, formatTokens } from '../../lib/format';

export default function TaskLogs({ stepStream }: { stepStream: Array<Record<string, unknown>> }) {
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [stepStream]);

  if (stepStream.length === 0) return null;

  return (
    <>
      {/* Phase A: 实时执行流（D2: 逐步展示耗时/token增量/工具成败） */}
      <div className="bg-white rounded-lg border p-4">
        <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Activity className="w-4 h-4 text-blue-500" />实时执行流 ({stepStream.length})</h4>
        <div ref={streamRef} className="space-y-2 max-h-80 overflow-y-auto">
          {stepStream.map((s, i) => (
            <div key={i} className="border-l-2 border-blue-200 pl-3 py-1">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1 flex-wrap">
                <span className="font-medium text-blue-600">第 {String(s.step)} 步</span>
                {s.duration_ms != null && <span className="shrink-0" title="本步骤耗时">⏱ {formatDuration(Number(s.duration_ms))}</span>}
                {s.toolCalls ? <span className="truncate flex-1 min-w-0" title={String(s.toolCalls)}>{String(s.toolCalls).slice(0, 80)}</span> : null}
                {s.toolCalls ? <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${s.toolOk ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`} title={s.toolOk ? '工具调用成功' : '工具调用出现错误'}>{s.toolOk ? '✓ 工具成功' : '✗ 工具出错'}</span> : null}
                {s.token_delta != null ? <span className="shrink-0" title="本步骤 token 增量">+{formatTokens(s.token_delta as number)} tokens</span> : (s.tokens != null && <span className="shrink-0">{formatTokens(s.tokens as number)} tokens</span>)}
              </div>
              {s.text ? <p className="text-xs text-gray-700 whitespace-pre-wrap" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{String(s.text).slice(0, 500)}</p> : null}
            </div>
          ))}
        </div>
      </div>

      {/* C1 (2026-08-31): 工具调用时间线（人类记忆情节记忆——执行过程的时间序列，独立展示工具调用） */}
      <div className="bg-white rounded-lg border p-4">
        <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Clock className="w-4 h-4 text-cyan-500" />工具时间线</h4>
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {stepStream.filter(s => s.toolCalls).map((s, i) => (
            <div key={i} className="flex items-start gap-2 text-xs py-1 border-b border-gray-50 last:border-0">
              <span className="shrink-0 text-cyan-600 font-mono">第{String(s.step)}步</span>
              <span className="text-gray-600 truncate" title={String(s.toolCalls)}>{String(s.toolCalls)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
