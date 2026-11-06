import { useCallback, useEffect, useState } from 'react';
import { projects } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { formatDbTime } from '../lib/deliverable-view';
import { RefreshCw, Plug } from 'lucide-react';
// zx_20261002 M11: 类目词表与返回形状取 main 侧**同一份真源**（`service-call-ledger.ts`）——渲染层不再自带第二份写法
//   （同 `settings-bool` / `memory-constants` 的既有做法）。该模块**刻意不依赖 node 内建**，故可被 renderer 打包。
import { SERVICE_CALL_KIND_LABEL, type ServiceCallReport } from '../../../src/main/core/service-call-ledger.js';

/**
 * zx_20261002 M11: 项目「外部调用账」只读卡。
 *
 * 回答一句此前**无直观**的话：本项目对外/对服务调用的成败与耗时。
 * 数据只来自 `service-calls:project`（main 侧 `describeServiceCalls`，只读）；本卡**纯展示、不改判**。
 * 三类调用（MCP 调用 / A2A 启动 / 守护进程启动）**都出栏**——"这一类零调用"与"没有这一栏"是两回事。
 */
export default function ServiceCallCard({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<ServiceCallReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try { setReport(await projects.serviceCalls(projectId)); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // 事件驱动刷新：服务启停（守护/A2A）与任务流转（MCP 调用发生在任务执行中）到达即重取——不轮询。
  const { subscribe } = useActivity();
  useEffect(() => {
    const un = subscribe((e) => {
      const t = e.type;
      if (t.startsWith('deliverable.') || t.startsWith('task.')) void load();
    });
    return un;
  }, [subscribe, load]);

  if (!projectId) return null;

  const byKind = report?.byKind ?? [];
  const total = report?.total ?? 0;

  return (
    <div className="mt-3 bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Plug className="w-4 h-4 text-blue-500" />外部调用账
          {report && (
            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
              共 {total} 笔 · 成功 {report.ok} / 失败 {report.failed}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-300">MCP 调用 / A2A 启动 / 守护进程启动 — 只收账，不参与任何决策</span>
          <button type="button" onClick={() => void load()} title="刷新" className="p-1 rounded hover:bg-gray-100">
            <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-600">调用账读取失败：{error}</p>}
      {!error && report && total === 0 && (
        <p className="text-xs text-gray-400">本项目暂无外部调用记录（MCP 工具调用、A2A / 守护进程启动时会自动落账）。</p>
      )}

      {!error && report && total > 0 && (
        <>
          <div className="grid grid-cols-3 gap-3 text-sm mb-3">
            {byKind.map((k) => (
              <div key={k.kind} className="p-2 bg-gray-50 rounded">
                <p className="text-xs text-gray-400">{SERVICE_CALL_KIND_LABEL[k.kind] ?? k.kind}</p>
                <p className="font-semibold mt-0.5">
                  {k.calls}
                  {k.failed > 0 && <span className="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">失败 {k.failed}</span>}
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {k.calls === 0
                    ? '未发生过'
                    : `均 ${k.avgMs ?? 0}ms${k.maxMs != null ? ` · 峰值 ${k.maxMs}ms` : ''}${k.lastAt ? ` · 最近 ${formatDbTime(k.lastAt)}` : ''}`}
                </p>
                {k.lastError != null && (
                  <p className="text-[10px] text-red-500 mt-0.5 truncate" title={k.lastError}>最近失败：{k.lastError || '（原因未记录）'}</p>
                )}
              </div>
            ))}
          </div>

          <p className="text-[11px] text-gray-400 mb-1">最近 {report.recent.length} 笔</p>
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {report.recent.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-gray-400 w-24 shrink-0">{SERVICE_CALL_KIND_LABEL[r.kind] ?? r.kind}</span>
                <span className="font-mono text-gray-700 truncate">{r.target || '—'}</span>
                <span className="text-gray-400 shrink-0">{r.operation}</span>
                <span className="text-gray-400 shrink-0">{r.durationMs}ms</span>
                {!r.ok && <span className="text-red-500 truncate" title={r.error}>{r.error || '失败'}</span>}
                <span className="flex-1" />
                <span className="text-gray-300 shrink-0">{formatDbTime(r.createdAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
