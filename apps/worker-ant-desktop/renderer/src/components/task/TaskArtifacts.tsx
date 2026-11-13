/**
 * zx_20261107_1 B9（庄子·庖丁解牛）：产出物块。
 *
 * 从 TaskDetailPage 抽出——树由 main 侧零依赖纯函数 `buildDeliverableTree` 建（两条规则见该模块头注释），
 * 本组件只负责"摆"：**这是摆法不是筛选**，展平后逐条与改前相等（件数不变、不重不漏，由 rr 【UI】束④钉住）。
 * 折叠状态是块内私有（默认折叠），条数、分页与跳转判据仍由页面给。
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Package as PackageIcon, Star, Folder, Eye, History } from 'lucide-react';
import { buildDeliverableTree, type DeliverableTreeChild } from '../../../../src/main/core/deliverable-tree.js';
import { isPreviewType } from '../../../../src/main/core/deliverable-types.js';
import { DELIVERABLE_STATUS_LABEL } from '../../lib/deliverable-view';
import { statusText } from '../../lib/status-view';

/** 与任务页的 `DelivItem` 同形；组件不反向依赖页面类型。 */
export interface TaskArtifactItem {
  id: string;
  name: string;
  type: string;
  status: string;
  file_path?: string;
  created_at: string;
  is_primary?: number;
  acceptance_verified?: number;
  owner_task_id?: string | null;
  owner_task_title?: string | null;
  other_writers?: Array<{ id: string; title: string }>;
}

export default function TaskArtifacts({
  currentTaskId,
  items,
  total,
  exhausted,
  moreBusy,
  showAcceptance,
  drawerEnabled,
  onLoadMore,
  onPreview,
  onOpenDrawer,
  onNavigateTask,
}: {
  currentTaskId: string;
  items: TaskArtifactItem[];
  total: number;
  exhausted: boolean;
  moreBusy: boolean;
  showAcceptance: boolean;
  drawerEnabled: boolean;
  onLoadMore: () => void;
  onPreview: (d: TaskArtifactItem) => void;
  onOpenDrawer: (id: string) => void;
  onNavigateTask: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  const tree = buildDeliverableTree(items);

  // 叶子行：类型 / ★主要成果 / 子任务归属 / ✓已验收 / 另有写过 / status / 预览 / 版本流抽屉。
  // 目录树与「无盘上路径」桶共用这一行，避免两处各写一份迟早分叉（本仓 G8 老病）。
  // 标题仍是 `d.name`，不是 basename：真库多条的 `name` 是人写标题，换 basename 会丢掉可读名。
  const row = (d: TaskArtifactItem, depth: number) => (
    <div key={d.id} className="flex items-center justify-between text-sm py-1 px-2 hover:bg-gray-50 rounded" style={{ paddingLeft: `${8 + depth * 14}px` }}>
      <span className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-mono text-gray-400 shrink-0">{d.type}</span>
        {d.is_primary === 1 && <span title="主要成果" className="shrink-0"><Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400" /></span>}
        <span className="truncate" title={d.file_path || undefined}>{d.name}</span>
        {d.owner_task_id && d.owner_task_id !== currentTaskId && (
          <button type="button" onClick={() => onNavigateTask(d.owner_task_id!)}
            title={`来自子任务：${d.owner_task_title || '未知任务'}（点击跳转）`}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700 hover:bg-teal-100">
            子任务 {d.owner_task_title || '未知任务'}
          </button>
        )}
        {showAcceptance && d.acceptance_verified === 1 && (
          <span title="该成果已通过验收核验（doc/code 级如实）" className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">✓已验收</span>
        )}
        {!!d.other_writers?.length && (
          <span className="shrink-0 text-[10px] text-gray-400" title={d.other_writers.map((w) => `${w.title}（${w.id}）`).join('\n')}>
            另有 {d.other_writers.map((w) => w.title).join('、')} 写过
          </span>
        )}
      </span>
      <span className="flex items-center gap-1 shrink-0">
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${d.status === 'running' ? 'bg-green-100 text-green-700' : 'bg-gray-100'}`}>
          {statusText(DELIVERABLE_STATUS_LABEL, d.status)}
        </span>
        {isPreviewType(d.type) && <button onClick={() => onPreview(d)} title="预览" className="p-0.5 hover:bg-blue-50 rounded"><Eye className="w-3.5 h-3.5 text-blue-500" /></button>}
        {isPreviewType(d.type) && drawerEnabled && <button onClick={() => onOpenDrawer(d.id)} title="版本流详情(抽屉)" className="p-0.5 hover:bg-amber-50 rounded"><History className="w-3.5 h-3.5 text-amber-500" /></button>}
      </span>
    </div>
  );

  const renderTree = (children: DeliverableTreeChild<TaskArtifactItem>[], depth: number): ReactNode =>
    children.map((c) => c.kind === 'dir' ? (
      <div key={`dir:${c.name}`}>
        <div className="flex items-center gap-1.5 text-sm py-1 px-2 text-gray-600" style={{ paddingLeft: `${8 + depth * 14}px` }}>
          <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span className="font-medium truncate" title={c.name}>{c.name}</span>
          <span className="text-[10px] text-gray-400 shrink-0">{c.count} 件</span>
        </div>
        {renderTree(c.children, depth + 1)}
      </div>
    ) : row(c.item, depth));

  return (
    <div className="bg-white rounded-lg border p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full text-left font-medium text-sm flex items-center gap-1">
        {open ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
        <PackageIcon className="w-4 h-4 text-purple-500 shrink-0" />产出物
        {/* 计数取服务端全量口径（`total`）——印 `items.length` 会把"这一批"说成"一共就这些"，与「加载更多」自相矛盾。 */}
        <span className="text-[10px] font-normal text-gray-400">本任务（含子任务）{total} 条</span>
      </button>
      {open && <div className="mt-2">
        {tree.commonPrefix.length > 0 && <p className="text-[10px] text-gray-400 px-2 mb-1">相对根：{tree.commonPrefix.join('/')}/</p>}
        {renderTree(tree.root, 0)}
        {/* 没有盘上路径的件如实单列，不塞进任何假目录（塞了就是编造"它在哪"） */}
        {tree.noPath.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            <p className="text-[10px] text-gray-400 px-2">（无盘上路径 · {tree.noPath.length} 条）</p>
            {tree.noPath.map((d) => row(d, 0))}
          </div>
        )}
      </div>}
      {open && !exhausted && (
        <div className="flex items-center justify-between gap-3 border-t mt-2 pt-2 text-[11px] text-gray-500">
          <span>已加载 {items.length} / 共 {total} 条</span>
          <button onClick={onLoadMore} disabled={moreBusy}
            className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-50">{moreBusy ? '加载中…' : '加载更多'}</button>
        </div>
      )}
    </div>
  );
}
