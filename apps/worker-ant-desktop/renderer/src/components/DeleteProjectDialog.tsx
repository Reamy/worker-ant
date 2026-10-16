/**
 * zx_20261012_3 批一：删除项目确认弹窗——**一处真源**（`ProjectsPage` / `ProjectDetailPage` 共用）。
 *
 * 为何不用原生 `confirm()`：原生框**塞不下复选框**，且此前那句文案对"文件删不删"只字未提——
 *   用户根本不知道盘上那份数据目录会/不会被清（正是本期「明处」要治的"藏在暗处"）。
 * 本弹窗把三件事**说清**：
 *   ① 将清的是**工蚁自有的** `<数据目录>/projects/<id>/`（真实路径由 main 给，渲染层不手拼）；
 *   ② 复选框**默认勾选**（"删得清"是同向默认），取消勾选则**只删库、保留盘**；
 *   ③ **明示**项目工作目录（用户代码仓）**永不受影响**——它是用户的东西，不是工蚁的数据。
 */
import { useEffect, useState } from 'react';
import { projects } from '../lib/ipc';

export interface DeleteProjectDialogProps {
  projectId: string;
  projectName: string;
  onCancel: () => void;
  /** `removeDataDir=false` 表示用户取消勾选 ⇒ 只删库、保留盘。 */
  onConfirm: (removeDataDir: boolean) => void | Promise<void>;
}

export default function DeleteProjectDialog({ projectId, projectName, onCancel, onConfirm }: DeleteProjectDialogProps) {
  const [removeDataDir, setRemoveDataDir] = useState(true);
  const [projectsDir, setProjectsDir] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // 真实路径由 main 给（dev 是仓库根 `data/`、生产是 `userData`，渲染层拼不出两种根）。
  useEffect(() => {
    let alive = true;
    projects.projectsDir()
      .then((r) => { if (alive) setProjectsDir(r.projectsDir); })
      .catch(() => { /* 取不到就退回只显示相对说明，不编一个假路径 */ });
    return () => { alive = false; };
  }, []);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(removeDataDir); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-3">删除项目</h3>
        <p className="text-sm text-gray-700">
          确定删除「<span className="font-medium">{projectName}</span>」？所有任务、对话与记忆将被永久删除。
        </p>

        <label className="flex items-start gap-2 mt-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={removeDataDir}
            onChange={(e) => setRemoveDataDir(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-blue-600"
          />
          <span className="text-sm">
            同时删除项目数据目录
            <span className="block text-xs text-gray-500 mt-0.5 font-mono break-all">
              {projectsDir ? `${projectsDir}/${projectId}/` : `…/projects/${projectId}/`}
            </span>
            <span className="block text-xs text-gray-400 mt-0.5">（任务产出物、会话数据；不勾选则只删库、盘上保留）</span>
          </span>
        </label>

        <p className="text-xs text-amber-600 mt-3">⚠ 项目工作目录（你的代码仓）不受影响——工蚁只清自有数据目录。</p>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onCancel} disabled={busy} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">取消</button>
          <button onClick={confirm} disabled={busy} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50">
            {busy ? '删除中…' : '删除'}
          </button>
        </div>
      </div>
    </div>
  );
}
