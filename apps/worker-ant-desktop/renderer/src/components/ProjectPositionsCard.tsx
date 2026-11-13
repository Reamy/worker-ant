/**
 * zx_20261113_1 B1「联」: 项目详情「岗位」卡——**这个项目能派给谁、各自干了多少**。
 *
 * 判据/计数全在 main 侧 `listProjectPositionBoard`（一条 SQL 取齐），本卡只负责：
 *   ① 显示绑定态（含未启用岗位——页面才看得见"为什么派不了"）；
 *   ② 勾选即启用/解除（`positions:projectToggle`，写口在 core）；
 *   ③ 本项目任务数 / 在办数 / 待审经验数原样上屏，不在 renderer 遍历任务自己加。
 *
 * 空态不伪造：没有岗位就写"还没有岗位"，没有绑定就写"勾选后建单时可指派"。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Users } from 'lucide-react';
import { positions as positionsApi } from '../lib/ipc';
import type { ProjectPositionBoardRow } from '../../../src/main/core/positions.js';

export default function ProjectPositionsCard({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<ProjectPositionBoardRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const r = await positionsApi.projectBoard(projectId);
      setRows(r.positions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async (row: ProjectPositionBoardRow) => {
    setBusy(row.id);
    setError(null);
    try {
      await positionsApi.projectToggle(row.id, projectId, !row.bound);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [projectId, load]);

  const boundCount = rows.filter((r) => r.bound).length;

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Users className="w-4 h-4 text-emerald-600" />岗位
          <span className="text-[10px] font-normal text-gray-400">· 谁来做；规范与经验随岗位跨项目复用</span>
        </h3>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            title="刷新"
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-gray-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <Link to="/positions" className="text-xs px-2 py-1 rounded border text-gray-600 hover:bg-gray-50">岗位管理</Link>
        </div>
      </div>

      {error && (
        <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 flex items-center justify-between gap-2">
          <span>岗位加载失败：{error}</span>
          <button type="button" onClick={() => void load()} className="shrink-0 underline">重试</button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <p className="text-sm text-gray-400 py-2">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400 py-2">
          还没有岗位——可到 <Link to="/positions" className="text-blue-600 underline">岗位页</Link> 新建。
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            {rows.map((r) => (
              <label
                key={r.id}
                className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-sm ${r.bound ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'}`}
                title={r.enabled ? '勾选后可在本项目建单时指派该岗位' : '岗位已全局停用——先到岗位页启用，勾选也不会生效'}
              >
                <input
                  type="checkbox"
                  checked={r.bound}
                  disabled={busy === r.id}
                  onChange={() => void toggle(r)}
                  className="shrink-0"
                />
                <span className="font-medium truncate">{r.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">{r.category}</span>
                {r.builtin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 shrink-0">内置</span>}
                {!r.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 shrink-0">岗位已停用</span>}
                <span className="ml-auto text-[11px] text-gray-500 shrink-0">
                  任务 {r.taskTotal} · 完成 {r.taskCompleted}
                  {r.taskActive > 0 ? ` · 在办 ${r.taskActive}` : ''}
                  {r.pendingLessons > 0 ? ` · 待审经验 ${r.pendingLessons}` : ''}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-gray-400">
            {boundCount === 0
              ? '本项目还没有启用岗位——勾选上面的岗位，建单时就能指派。'
              : `本项目已启用 ${boundCount} 个岗位；同一个岗位可跨项目复用它的规范与经验。`}
          </p>
        </>
      )}
    </div>
  );
}
