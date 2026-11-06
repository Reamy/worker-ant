import { useCallback, useEffect, useState } from 'react';
import { projects, type ProjectDispatchMode, type ProjectDispatchModePayload, type ProjectNodePolicyPayload } from '../lib/ipc';
import { RefreshCw, Network } from 'lucide-react';

/**
 * zx_20261101_2 M3（维特根斯坦·意义即用法）: 项目「节点分工」卡。
 *
 * 回答一句此前**无处可说**的话：这个项目里，**哪几台参与、各自什么角色、谁权重高**。
 *   - 未登记 = 跟随全局（新入网节点不被这张表挡在外面）；
 *   - 参与 = 不打勾 ⇒ 本项目退出（该节点不接本项目的活）；
 *   - 项目角色 = observer ⇒ 本项目只上报不承接；`跟随全局` = 用全局角色；
 *   - 项目权重（1..10）只在 ANS 的**同一层内**改分数，不越过"有闲节点优先"。
 * 本机行只读：派活是交给他机，本机永不入候选（选了也等于空转一圈）。
 * ⚠ 数据与词表全部来自 main（`project:node_policy_get` 随载荷下发 `role_options`），本卡不手抄第二份。
 */
export default function NodeDivisionCard({ projectId }: { projectId: string }) {
  const [payload, setPayload] = useState<ProjectNodePolicyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { participate: boolean; role: string; weight: number }>>({});
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null);
  // zx_20261106_3 B3: 项目级派发模式（与分工同一张卡——两者回答的是同一件事的两半：谁能接、怎么选）。
  const [dispatch, setDispatch] = useState<ProjectDispatchModePayload | null>(null);
  const [dispatchSaving, setDispatchSaving] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [next, modePayload] = await Promise.all([
        projects.nodePolicy.get(projectId),
        projects.dispatchMode.get(projectId).catch((e) => { setDispatchError((e as Error).message); return null; }),
      ]);
      setPayload(next);
      setDispatch(modePayload);
      setDraft(
        Object.fromEntries(
          next.rows.map((r) => [r.node_id, { participate: r.participate, role: r.role, weight: r.weight }]),
        ),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (!projectId) return null;

  const gate = payload?.gate;
  const locked = gate != null && !gate.unlocked;
  const localId = payload?.local_node_id ?? '';
  const rows = payload?.rows ?? [];
  const roleOptions = payload?.role_options ?? [];

  const setRow = (nodeId: string, patch: Partial<{ participate: boolean; role: string; weight: number }>) => {
    setDraft((d) => {
      const prev = d[nodeId] ?? { participate: true, role: '', weight: 1 };
      return { ...d, [nodeId]: { ...prev, ...patch } };
    });
    setSaveNote(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveNote(null);
    try {
      const settings = rows
        .filter((r) => r.node_id !== localId)
        .map((r) => {
          const d = draft[r.node_id] ?? { participate: r.participate, role: r.role, weight: r.weight };
          return { nodeId: r.node_id, participate: d.participate, role: d.role, weight: d.weight };
        });
      const res = await projects.nodePolicy.set(projectId, settings);
      setSaveNote({ ok: true, text: res.configured ? `已保存：${res.count} 台节点参与本项目分工` : '已清空：本项目回到交给 ANS 按余力自动选' });
      await load();
    } catch (e) {
      setSaveNote({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const clearAll = async () => {
    setSaving(true);
    setSaveNote(null);
    try {
      await projects.nodePolicy.set(projectId, []);
      setSaveNote({ ok: true, text: '已清空：本项目回到交给 ANS 按余力自动选' });
      await load();
    } catch (e) {
      setSaveNote({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const saveDispatchMode = async (value: string) => {
    setDispatchSaving(true);
    setDispatchError(null);
    try {
      await projects.dispatchMode.set(projectId, value === '' ? null : (value as ProjectDispatchMode));
      const next = await projects.dispatchMode.get(projectId);
      setDispatch(next);
    } catch (e) {
      setDispatchError((e as Error).message);
    } finally {
      setDispatchSaving(false);
    }
  };

  const roleLabel = (role: string) => roleOptions.find((o) => o.value === role)?.label ?? role;
  const resolvedLabel = { off: '关闭', overflow: '溢出外派', capability: '能力优先' } as const;

  return (
    <div className="mt-3 bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Network className="w-4 h-4 text-indigo-500" />节点分工
          {payload?.configured && (
            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
              已登记显式分工
            </span>
          )}
        </h3>
        <button type="button" onClick={() => void load()} title="刷新" className="p-1 rounded hover:bg-gray-100">
          <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
        </button>
      </div>

      {locked && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 mb-2">
          <div className="text-xs font-medium text-indigo-800 mb-0.5">「多机协同」是团队版旗舰能力</div>
          <div className="text-[11px] text-indigo-700">{gate?.detail}</div>
          <div className="text-[11px] text-indigo-700 mt-1">
            专业版仍为单机（并发与项目照常，不跨机派活）；团队授权包覆盖最多 20 台协同节点。
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 mb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-gray-700">派发模式</div>
          <select
            value={dispatch?.project_mode ?? ''}
            disabled={dispatchSaving || locked}
            onChange={(e) => void saveDispatchMode(e.target.value)}
            className="border rounded px-1.5 py-0.5 text-xs disabled:opacity-50"
            title={locked
              ? '多机协同是团队版旗舰能力——当前档位只读'
              : '项目设置优先于全局缺省；未设置时按全局模式并在满足团队版条件时默认能力优先'}
          >
            <option value="">未设置（跟随全局）</option>
            {(dispatch?.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        {dispatch && (
          <div className="text-[11px] text-gray-500 mt-1">
            生效：<span className="font-medium text-gray-700">{resolvedLabel[dispatch.resolved.mode]}</span>
            {' · '}{dispatch.resolved.reason}
          </div>
        )}
        {dispatch && (
          <div className="text-[10px] text-gray-400 mt-0.5">
            档位 {dispatch.tier}{dispatch.enrolled ? ' · 已入网' : ' · 未入网'} · 在线他机 {dispatch.online_peers} 台
          </div>
        )}
        {dispatchError && <div className="text-[11px] text-red-600 mt-1">派发模式读取失败：{dispatchError}</div>}
      </div>

      {error && <p className="text-xs text-red-600">分工读取失败：{error}</p>}
      {!error && payload?.error && <p className="text-xs text-red-600">读不到节点台账：{payload.error}</p>}

      {!error && !locked && rows.length === 0 && (
        <p className="text-xs text-gray-400">台账里还没有其他节点——加入协同网络后，这里可以指定谁参与本项目。</p>
      )}

      {!locked && rows.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="font-normal py-1 pr-2">节点</th>
                  <th className="font-normal py-1 pr-2">平台</th>
                  <th className="font-normal py-1 pr-2">在线</th>
                  <th className="font-normal py-1 pr-2">全局角色</th>
                  <th className="font-normal py-1 pr-2">项目角色</th>
                  <th className="font-normal py-1 pr-2">项目权重</th>
                  <th className="font-normal py-1">参与</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = draft[r.node_id] ?? { participate: r.participate, role: r.role, weight: r.weight };
                  const isLocal = r.node_id === localId;
                  return (
                    <tr key={r.node_id} className={`border-t ${isLocal ? 'bg-gray-50 text-gray-400' : ''}`}>
                      <td className="py-1 pr-2 max-w-[16rem] truncate" title={`${r.name || r.node_id}（${r.node_id}）`}>
                        {r.name || r.node_id}
                        {isLocal && <span className="ml-1 text-[10px] px-1 rounded bg-gray-200 text-gray-600">本机</span>}
                      </td>
                      <td className="py-1 pr-2">{r.platform || '—'}</td>
                      <td className="py-1 pr-2">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${r.online ? 'bg-green-500' : 'bg-gray-300'}`} />
                        <span className="ml-1">{r.online ? '在线' : '离线'}</span>
                      </td>
                      <td className="py-1 pr-2">{roleLabel(r.global_role)}</td>
                      <td className="py-1 pr-2">
                        <select
                          value={d.role}
                          disabled={isLocal || saving}
                          onChange={(e) => setRow(r.node_id, { role: e.target.value })}
                          className="border rounded px-1 py-0.5 text-xs disabled:opacity-50"
                          title="项目角色：观察者在本项目只上报、不承接"
                        >
                          {roleOptions.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={d.weight}
                          disabled={isLocal || saving}
                          onChange={(e) => setRow(r.node_id, { weight: Number(e.target.value) })}
                          className="w-14 border rounded px-1 py-0.5 text-xs disabled:opacity-50"
                          title="项目权重 1..10：只在同一层内提高优先级，不会越过有闲节点"
                        />
                      </td>
                      <td className="py-1">
                        <input
                          type="checkbox"
                          checked={d.participate}
                          disabled={isLocal || saving}
                          onChange={(e) => setRow(r.node_id, { participate: e.target.checked })}
                          title="不勾选 = 该节点在本项目退出"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存分工'}
            </button>
            <button
              type="button"
              onClick={() => void clearAll()}
              disabled={saving || !payload?.configured}
              className="text-xs px-2.5 py-1 rounded border text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              title="清空登记 = 本项目回到交给 ANS 按余力自动选"
            >
              清空（跟随全局）
            </button>
            {saveNote && (
              <span className={`text-[11px] ${saveNote.ok ? 'text-green-600' : 'text-red-600'}`}>{saveNote.text}</span>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-1">
            保存即生效；不设置 = 交给 ANS 按余力自动选。未登记的节点跟随全局。
          </p>
        </>
      )}
    </div>
  );
}
