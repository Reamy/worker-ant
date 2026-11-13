/**
 * zx_20261107_1 B9（庄子·庖丁解牛）：执行期实时块（CoT / 流式生成 / 步骤状态 / 心跳）。
 *
 * 从 TaskDetailPage 抽出，**只负责摆**；判据（何时算执行中、实时值怎么来）仍在页面。
 * 原 D11/D13 的布局结论随代码一并搬来：块在操作栏**下方**，不限高、不块内滚动。
 */
import type { ReactNode } from 'react';
import { formatTokens } from '../../lib/format';

function StreamPane({ className, title, children }: { className: string; title?: string; children: ReactNode }) {
  return <div className={className} title={title}>{children}</div>;
}

function LivePane({ children }: { children: ReactNode }) {
  return <div className="mt-2 space-y-2">{children}</div>;
}

export interface TaskEstimateView {
  tokens: number;
  steps: number;
}

export interface TaskHeartbeatView {
  ts: number;
  elapsedSec: number;
  tokens: number;
}

export default function TaskProgress({
  status,
  streamingReasoning,
  showThinking,
  onToggleThinking,
  thinkingSince,
  thinkingSec,
  streamingText,
  liveStatus,
  liveToolNames,
  liveWaterPct,
  liveBias,
  estimate,
  heartbeatFresh,
  heartbeat,
}: {
  status: string;
  streamingReasoning: string;
  showThinking: boolean;
  onToggleThinking: () => void;
  thinkingSince: number;
  thinkingSec: number;
  streamingText: string;
  liveStatus: Record<string, unknown> | null;
  liveToolNames: string[];
  liveWaterPct: number | null;
  liveBias: number | null;
  estimate: TaskEstimateView | null;
  heartbeatFresh: boolean;
  heartbeat: TaskHeartbeatView | null;
}) {
  if (status !== 'executing' && status !== 'running') return null;

  return (
    <LivePane>
      {/* D3 (2026-09-03 核实修复): 首个 step_finished 到达前 liveStatus 为空，此时独立渲染流式横幅，避免第 1 步 token 流式不可见 */}
      {streamingText && !liveStatus && <div className="p-2 mb-3 bg-blue-50 border border-blue-200 rounded-lg space-y-1"><div className="flex items-center gap-2 flex-wrap"><span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"/><span className="text-sm text-blue-800 font-medium">AI 正在生成…</span></div><StreamPane title={streamingText} className="text-xs text-blue-700 whitespace-pre-wrap break-words font-mono"><span className="text-blue-400">⏵ </span>{streamingText}</StreamPane></div>}
      {/* Phase A: 执行中实时状态条（过程可见，非模态不打断） */}
      {liveStatus && <div className="p-2 mb-3 bg-blue-50 border border-blue-200 rounded-lg space-y-1"><div className="flex items-center gap-2 flex-wrap"><span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"/><span className="text-sm text-blue-800 font-medium">执行中 · 第 {String(liveStatus.step)} 步</span>{thinkingSince > 0 && <span className="text-xs text-blue-500 animate-pulse font-medium" title="最近步骤已完成，AI 正在生成下一步">🤖 AI 思考中… {thinkingSec}s</span>}{estimate?.steps ? <span className="text-xs text-cyan-600">/ 预估 {estimate.steps} 步{estimate.steps > 0 ? `（${Math.min(100, Math.round((Number(liveStatus.step) / estimate.steps) * 100))}%）` : ''}</span> : null}{estimate?.steps && Number(liveStatus.step) < estimate.steps ? <span className="text-xs text-cyan-500">预计剩余约 {estimate.steps - Number(liveStatus.step)} 步</span> : null}{liveStatus.totalTokens != null && <span className="text-xs text-blue-600">{formatTokens(liveStatus.totalTokens as number)} tokens</span>}{liveStatus.token_delta != null && <span className="text-xs text-blue-500" title="本步 token 增量"> · 本步 +{formatTokens(Number(liveStatus.token_delta))}</span>}{liveStatus.totalTokens != null && liveWaterPct != null && <span className={`text-xs ${liveWaterPct >= 85 ? 'text-red-500 font-medium' : 'text-amber-600'}`} title="上下文占用近似估算(T2预算水位，随步骤实时刷新)"> · 上下文~{liveWaterPct}%</span>}{liveBias != null && estimate?.tokens ? <span className={`text-xs ${liveBias >= 50 ? 'text-red-500 font-medium' : 'text-purple-600'}`} title="实际 vs 预估 token 偏差">{liveBias > 0 ? `超预估 +${liveBias}%` : `低于预估 ${liveBias}%`}</span> : null}</div>{estimate?.steps ? <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.min(100, (Number(liveStatus.step) / estimate.steps) * 100)}%` }} /></div> : null}{liveStatus.toolCalls ? <p className="text-xs text-blue-500" title={String(liveStatus.toolCalls)}>正在调用工具: {liveToolNames.length > 0 ? liveToolNames.join('、') : String(liveStatus.toolCalls)}</p> : null}{streamingText ? <StreamPane title={streamingText} className="text-xs text-blue-700 whitespace-pre-wrap break-words font-mono"><span className="text-blue-400">⏵ </span>{streamingText}</StreamPane> : liveStatus.text ? <p className="text-xs text-blue-700" title={String(liveStatus.text)}>{String(liveStatus.text).slice(0, 200)}</p> : null}</div>}
      {/* CoT (2026-09-03): 推理模型思考过程逐字上屏（紫色独立块，思考阶段可见）
          zx_20261110_1 G23：执行中块在上、思考块在下——先答"跑哪一步了"，再答"正在想什么"。 */}
      {streamingReasoning && <div className="p-2 mb-3 bg-indigo-50 border border-indigo-200 rounded-lg space-y-1"><div className="flex items-center gap-2 flex-wrap"><span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"/><span className="text-sm text-indigo-700 font-medium">🧠 AI 思考中…</span>{thinkingSince > 0 && <span className="text-xs text-indigo-400">{thinkingSec}s</span>}<button onClick={onToggleThinking} className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-500 hover:bg-indigo-200" title="折叠/展开思考过程">{showThinking ? '收起' : '展开'}</button></div>{showThinking && <StreamPane title={streamingReasoning} className="text-xs text-indigo-700 whitespace-pre-wrap break-words font-mono">{streamingReasoning}</StreamPane>}</div>}
      {/* zx_20260906 批4 (4b): 长单步执行中心跳脉冲（task.heartbeat 消费）——界面持续"呼吸"，不显伪冻结 */}
      {heartbeatFresh && heartbeat && (
        <div className="p-2 mb-3 bg-cyan-50 border border-cyan-200 rounded-lg flex items-center gap-2">
          <span className="relative flex h-2 w-2 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" /></span>
          <span className="text-xs text-cyan-800">AI 正在执行长步骤（任务仍在推进）{heartbeat.elapsedSec >= 60 ? `· 已运行 ${Math.floor(heartbeat.elapsedSec / 60)}m${heartbeat.elapsedSec % 60}s` : `· 已运行 ${heartbeat.elapsedSec}s`}{heartbeat.tokens > 0 ? ` · ${formatTokens(heartbeat.tokens)} tokens` : ''}</span>
        </div>
      )}
      {!streamingReasoning && !streamingText && !liveStatus && !heartbeatFresh && <p className="text-xs text-gray-400">等待执行输出…</p>}
    </LivePane>
  );
}
