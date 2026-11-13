/**
 * zx_20261107_1 B9（庄子·庖丁解牛）：任务详情头部**的统计与元信息段**。
 *
 * 从 2474 行的 TaskDetailPage 里按关节抽出——本组件只摆事实（统计卡/退休提示/元信息），
 * **不承载任何业务判据**：数字怎么算、链接跳哪里都由页面决定并作为 props 传入。
 * 标题、徽标与动作栏仍留在页面（那一行与 20+ 个动作状态耦合，属 B7 重组的范围）。
 */
import { Clock, TrendingUp, GitBranch, AlertTriangle } from 'lucide-react';
import { formatTokens, formatTimeOrRaw } from '../../lib/format';

export interface TaskHeaderStats {
  /** 展示用 token 数（执行中取实时值）。 */
  tokens: number;
  executing: boolean;
  conversations: number;
  /** 本任务（含子任务）产出物计数——服务端全量口径。 */
  deliverables: number;
  version: number;
}

export interface TaskHeaderMeta {
  createdAt: string;
  updatedAt: string;
  sourceLabel: string;
  dependsOn: Array<{ id: string; label: string }>;
  parent: { id: string; label: string } | null;
  stepInfo: string | null;
}

export default function TaskHeader({
  stats,
  retiredCount,
  meta,
  onNavigateTask,
  onOpenDeliverables,
}: {
  stats: TaskHeaderStats;
  retiredCount: number;
  meta: TaskHeaderMeta;
  onNavigateTask: (id: string) => void;
  onOpenDeliverables: () => void;
}) {
  return (
    <>
      <div className="grid grid-cols-4 gap-3 mb-3">
        <div className="bg-blue-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-blue-700">{formatTokens(stats.tokens)}</p><p className="text-[10px] text-blue-500">{stats.executing ? 'Token消耗(实时)' : 'Token消耗'}</p></div>
        <div className="bg-purple-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-purple-700">{stats.conversations}</p><p className="text-[10px] text-purple-500">对话轮次</p></div>
        <div className="bg-green-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-green-700">{stats.deliverables}</p><p className="text-[10px] text-green-500" title="含子任务产出（task:get 子树聚合）">本任务（含子任务）</p></div>
        <div className="bg-orange-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-orange-700">{stats.version}</p><p className="text-[10px] text-orange-500">版本</p></div>
      </div>
      {/* zx_20260906_1 3e: 重试后信息差——当前成果空但存在已退休(旧版)成果时透出，避免误读为"无成果" */}
      {stats.deliverables === 0 && retiredCount > 0 && (
        <div className="mb-3 px-3 py-2 rounded bg-gray-50 border border-gray-200 text-xs text-gray-500 flex items-center justify-between gap-2">
          <span>当前无有效产出物——该任务曾重试，有 <b>{retiredCount}</b> 项旧成果已退休(soft-retired，版本历史保留)。</span>
          <button type="button" onClick={onOpenDeliverables} className="shrink-0 text-blue-500 hover:text-blue-700 hover:underline">前往产出物管理查看 →</button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
        <div className="flex items-center gap-1"><Clock className="w-3 h-3"/>创建: {formatTimeOrRaw(meta.createdAt)}</div>
        <div className="flex items-center gap-1"><TrendingUp className="w-3 h-3"/>更新: {formatTimeOrRaw(meta.updatedAt)}</div>
        <div className="flex items-center gap-1">来源: {meta.sourceLabel}</div>
        {meta.dependsOn.length > 0 && <div className="flex items-center gap-1 flex-wrap col-span-2"><GitBranch className="w-3 h-3"/>前置依赖: {meta.dependsOn.map((d) => (
          <button key={d.id} type="button" onClick={() => onNavigateTask(d.id)} title={`跳转前置任务：${d.label}`} className="text-blue-500 hover:text-blue-700 hover:underline">{d.label}</button>
        ))}</div>}
        {meta.parent && <div className="flex items-center gap-1"><GitBranch className="w-3 h-3"/>父任务: <button type="button" onClick={() => onNavigateTask(meta.parent!.id)} title="跳转父任务" className="text-blue-500 hover:text-blue-700 hover:underline">{meta.parent.label}</button></div>}
        {meta.stepInfo && <div className="flex items-center gap-1 col-span-2 text-blue-500"><AlertTriangle className="w-3 h-3"/>{meta.stepInfo}</div>}
      </div>
    </>
  );
}
