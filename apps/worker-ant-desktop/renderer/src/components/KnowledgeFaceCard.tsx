import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { projects } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { DELIVERABLE_STATUS_LABEL } from '../lib/deliverable-view';
import { JOB_STATUS_LABEL } from '../lib/status-view';
import { RefreshCw, Activity } from 'lucide-react';
// zx_20261003 M6: 形状取 main 侧**同一份真源**（`project-runtime-summary.ts`）——渲染层不自带第二份写法
//   （同 `ServiceCallCard` 引 `service-call-ledger.js` 的既有做法）。该模块**零 electron/node 内建**，故可被打包。
import type { ProjectRuntimeSummary } from '../../../src/main/core/project-runtime-summary.js';

/**
 * zx_20261003 M6（柏拉图·洞穴喻 / 维特根斯坦·意义即用法）: 项目「**运行面**」只读卡。
 *
 * 为什么只有运行面这一半：项目知识全景（`project:knowledgePanorama`）经 M4 补全后有七块——
 *   记忆/图谱/交付物/执行 已由 overview 内联「知识全景」块呈现，**调用账**已由 `ServiceCallCard` 呈现
 *   （两者同取 `describeServiceCalls`），唯独 **运行面（守护/作业的当前存量）此前无任何直观**。
 *   本卡补的正是这块空白——"上屏"到齐，而非为"看起来有"空造块（承方案 M6 约束）。
 *
 * ⚠ **与 `ServiceCallCard` 不是一回事，别合并**：那张是**事件流水**（起过几次），本卡是**当前存量**
 *   （此刻几个在跑）。量尺不同（理由见 `project-runtime-summary.ts` 头注释）。
 * ⚠ **只读**：本卡纯展示、不改判；数据源 `project:knowledgePanorama`（main 侧只读聚合）。
 */

/** 状态徽章配色。未知状态退灰（如实呈现，不硬塞进某个已知档）。 */
function statusCls(status: string): string {
  if (status === 'running') return 'bg-green-100 text-green-700';
  if (status === 'failed') return 'bg-red-100 text-red-600';
  if (status === 'pending') return 'bg-amber-100 text-amber-700';
  if (status === 'done' || status === 'completed') return 'bg-blue-100 text-blue-700';
  return 'bg-gray-100 text-gray-500';
}

/** 一栏（守护 或 作业）：合计 + 按状态分项。空 ⇒ 如实写"未发生"。 */
function FaceColumn({
  title, icon, total, byStatus, labelOf, emptyText,
}: {
  title: string; icon: ReactNode; total: number;
  byStatus: Array<{ status: string; count: number }>;
  labelOf: (s: string) => string; emptyText: string;
}) {
  return (
    <div className="p-3 bg-gray-50 rounded">
      <p className="text-xs text-gray-400 mb-1 flex items-center gap-1">{icon}{title}</p>
      <p className="font-bold">{total} 个</p>
      {total === 0 ? (
        <p className="text-[11px] text-gray-400 mt-1">{emptyText}</p>
      ) : (
        <div className="mt-1.5 flex items-center gap-1 flex-wrap">
          {byStatus.map((s) => (
            <span key={s.status || '(未登记)'} className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusCls(s.status)}`}>
              {labelOf(s.status)} {s.count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function KnowledgeFaceCard({ projectId }: { projectId: string }) {
  const [runtime, setRuntime] = useState<ProjectRuntimeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const pano = await projects.knowledgePanorama(projectId);
      setRuntime((pano.runtimeSummary as ProjectRuntimeSummary | undefined) ?? null);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // 事件驱动刷新：守护启停是 deliverable.* 事件，作业入队/出队是 task.* 事件——到达即重取，不轮询。
  const { subscribe } = useActivity();
  useEffect(() => {
    const un = subscribe((e) => {
      const t = e.type;
      if (t.startsWith('deliverable.') || t.startsWith('task.')) void load();
    });
    return un;
  }, [subscribe, load]);

  if (!projectId) return null;

  const daemons = runtime?.daemons ?? { total: 0, byStatus: [] };
  const jobs = runtime?.jobs ?? { total: 0, byStatus: [] };

  return (
    <div className="mt-3 bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Activity className="w-4 h-4 text-emerald-500" />项目运行面
          {runtime && (
            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              守护 {daemons.total} · 作业 {jobs.total}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-300">守护进程 / 作业队列的<strong>当前存量</strong>（与「外部调用账」的流水是两把尺）</span>
          <button type="button" onClick={() => void load()} title="刷新" className="p-1 rounded hover:bg-gray-100">
            <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-600">运行面读取失败：{error}</p>}

      {!error && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <FaceColumn
            title="守护进程" icon={<span className="text-[10px]">🛡</span>}
            total={daemons.total} byStatus={daemons.byStatus}
            labelOf={(s) => DELIVERABLE_STATUS_LABEL[s] ?? (s || '未登记')} emptyText="本项目暂无守护进程。"
          />
          <FaceColumn
            title="作业队列" icon={<span className="text-[10px]">⛏</span>}
            total={jobs.total} byStatus={jobs.byStatus}
            labelOf={(s) => JOB_STATUS_LABEL[s] ?? (s || '未登记')} emptyText="本项目暂无在册作业（作业表为引擎全局，此处只算 payload 里点了本项目的）。"
          />
        </div>
      )}
    </div>
  );
}
