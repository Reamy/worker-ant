import { useState, useEffect } from 'react';
import { ansProxy, invoke } from '../lib/ipc';
import { Globe, RefreshCw, Trash2, Pencil, Plus, Activity, RotateCcw, X, LayoutGrid, LayoutList } from 'lucide-react';
import { formatDbTime } from '../lib/deliverable-view';

interface A2aServer { id: string; name: string; agent_card_url?: string; endpoint?: string; status?: string; description?: string; capabilities?: string; health_check_at?: string; }

/** 本进程 A2A 运行时的实况条目（`deliverable:a2a-list` → `core/a2a-runtime.listA2AServers`）。 */
interface LocalA2aRuntime { deliverableId: string; name: string; port: number; endpoint: string; agentCardUrl: string; startedAt?: string; }

const STATUS_LABELS: Record<string, string> = { active: '正常', error: '异常', disabled: '已禁用', healing: '恢复中' };
const STATUS_COLORS: Record<string, string> = { active: 'bg-green-100 text-green-700', error: 'bg-red-100 text-red-700', disabled: 'bg-gray-100 text-gray-500', healing: 'bg-yellow-100 text-yellow-700' };

// 库内时间列是 UTC 且不带 Z——补 Z 的写法只此一份（在 lib/deliverable-view 里），本页不再另抄。
// zx_20260929 M12: **返回值必须是字符串**。此前 `|| s` 在 `formatDbTime` 判不出时把 `s` 原样吐出，
// 而 Electron IPC 的结构化克隆能送来一个**活 `Date`**（声明成 `string` 也拦不住运行期），对象进 JSX
// 即 React error #31（`args[]=[object Date]`）。兜底一律 `String(s)`，永不让非字符串穿到渲染层。
function formatTime(s: string | undefined | null): string {
  if (!s) return '未检查';
  return formatDbTime(s) || String(s);
}

export default function A2aPage() {
  const [items, setItems] = useState<A2aServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<A2aServer | null>(null);
  // 卡片/列表视图切换 + 详情弹窗
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [detailItem, setDetailItem] = useState<A2aServer | null>(null);
  const [local, setLocal] = useState<LocalA2aRuntime[]>([]);

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true); setError('');
    try { const d = await ansProxy.get<A2aServer[]>('/api/v1/a2a?all=1'); setItems(d as A2aServer[]); } catch(e) { setError((e as Error).message); }
    // zx_20260929 M2: 「ANS 在册的目录」与「本进程真在跑的」是两件事。此前本页只显示前者 ⇒
    // 桌面里跑着的 A2A 服务在页面上看不见（写头有、读头无）。取不到就如实置空，不编造。
    try { setLocal((await invoke<LocalA2aRuntime[]>('deliverable:a2a-list')) || []); } catch { setLocal([]); }
    setLoading(false);
  }
  /** ANS 在册条目 ↔ 本进程运行实况 的对应（两边各自的端点/Agent Card 地址，任一相同即视为同一个）。 */
  const runningHere = (a: A2aServer): LocalA2aRuntime | undefined =>
    local.find(l => [a.endpoint, a.agent_card_url].some(x => !!x && (x === l.endpoint || x === l.agentCardUrl)));
  async function handleDelete(id: string) { if (!confirm('确定删除？')) return; try { await ansProxy.delete(`/api/v1/a2a/${id}`); load(); } catch {} }
  async function handleHealthCheck(id: string) { try { await ansProxy.post(`/api/v1/a2a/${id}/health-check`); load(); } catch {} }
  async function handleRefresh(id: string) { try { await ansProxy.post(`/api/v1/a2a/${id}/refresh`); load(); } catch {} }

  const parseCaps = (s: A2aServer) => { try { if (s.capabilities) return JSON.parse(s.capabilities) as string[]; } catch {} return []; };

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">A2A 服务</h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0 border rounded-lg overflow-hidden">
            <button onClick={() => setView('list')} className={`p-1.5 ${view === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`} title="列表视图"><LayoutList className="w-4 h-4" /></button>
            <button onClick={() => setView('grid')} className={`p-1.5 ${view === 'grid' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`} title="卡片视图"><LayoutGrid className="w-4 h-4" /></button>
          </div>
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setEditItem(null); setShowForm(true); }} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5" />注册服务</button>
        </div>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">错误: {error}</p>}
      {local.length > 0 && (
        <div className="mb-4 border border-green-200 bg-green-50 rounded-lg p-3">
          <div className="text-xs font-medium text-green-800 mb-1">本进程运行中 {local.length} 个（桌面端 A2A 运行时实况，非 ANS 在册目录）</div>
          {local.map(l => (
            <div key={l.deliverableId} className="text-xs text-green-900 font-mono truncate">
              {l.name} · 端口 {l.port} · {l.endpoint}（启动于 {formatTime(l.startedAt)}）
            </div>
          ))}
        </div>
      )}
      {items.length === 0 ? <p className="text-gray-400 text-center py-12">暂无 A2A 服务</p> : view === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map(a => {
            const caps = parseCaps(a);
            return (
              <div key={a.id} className="bg-white rounded-lg border p-4 hover:shadow-sm cursor-pointer" onClick={() => setDetailItem(a)}>
                <div className="flex items-center gap-2 mb-2">
                  <Globe className="w-4 h-4 text-green-500 flex-shrink-0" />
                  <h3 className="font-medium truncate">{a.name}</h3>
                  {runningHere(a) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-600 text-white flex-shrink-0" title={`本进程运行中：端口 ${runningHere(a)!.port}`}>本进程运行中</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ml-auto flex-shrink-0 ${STATUS_COLORS[a.status || 'unknown']}`}>{STATUS_LABELS[a.status || 'unknown'] || a.status || '未知'}</span>
                </div>
                <p className="text-xs text-gray-400 font-mono truncate">{a.agent_card_url || a.endpoint || '—'}</p>
                <p className="text-xs text-gray-400 mt-1">{caps.length > 0 && caps.map(c => <span key={c} className="text-[10px] px-1 py-0.5 bg-gray-100 rounded mr-0.5">{c}</span>)}</p>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(a => {
            const caps = parseCaps(a);
            return (
              <div key={a.id} className="bg-white rounded-lg border p-4 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <Globe className="w-5 h-5 text-green-500 flex-shrink-0" />
                  <div className="min-w-0">
                    <h3 className="font-medium cursor-pointer hover:text-blue-600" onClick={() => setDetailItem(a)}>{a.name}</h3>
                    <p className="text-xs text-gray-400 font-mono truncate">{a.agent_card_url || a.endpoint || '—'}</p>
                    <p className="text-xs text-gray-400 mt-0.5">最近检查: {formatTime(a.health_check_at)} {caps.length > 0 && <span className="ml-2">{caps.map(c => <span key={c} className="text-[10px] px-1 py-0.5 bg-gray-100 rounded mr-0.5">{c}</span>)}</span>}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {runningHere(a) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-600 text-white" title={`本进程运行中：端口 ${runningHere(a)!.port}`}>本进程运行中</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status || 'unknown']}`}>{STATUS_LABELS[a.status || 'unknown'] || a.status || '未知'}</span>
                  <button onClick={() => handleHealthCheck(a.id)} className="p-1 hover:bg-blue-50 rounded" title="健康检查"><Activity className="w-3.5 h-3.5 text-blue-500" /></button>
                  <button onClick={() => handleRefresh(a.id)} className="p-1 hover:bg-green-50 rounded" title="刷新代理卡"><RotateCcw className="w-3.5 h-3.5 text-green-500" /></button>
                  <button onClick={() => { setEditItem(a); setShowForm(true); }} className="p-1 hover:bg-blue-50 rounded" title="编辑"><Pencil className="w-3.5 h-3.5 text-blue-500" /></button>
                  <button onClick={() => handleDelete(a.id)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showForm && <A2aDialog server={editItem} onClose={() => { setShowForm(false); setEditItem(null); }} onSuccess={load} />}
      {detailItem && <A2aDetailDialog server={detailItem} onClose={() => setDetailItem(null)} />}
    </div>
  );
}

function A2aDetailDialog({ server, onClose }: { server: A2aServer; onClose: () => void }) {
  const caps = (() => { try { if (server.capabilities) return JSON.parse(server.capabilities) as string[]; } catch {} return []; })();
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{server.name}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-gray-500">状态</span><span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[server.status || 'unknown']}`}>{STATUS_LABELS[server.status || 'unknown'] || server.status || '未知'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Agent Card URL</span><span className="font-mono text-xs truncate max-w-[260px]">{server.agent_card_url || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Endpoint</span><span className="font-mono text-xs truncate max-w-[260px]">{server.endpoint || '—'}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">最近检查</span><span className="text-xs">{formatTime(server.health_check_at)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">描述</span><span className="text-xs text-right">{server.description || '—'}</span></div>
          {caps.length > 0 && (
            <div><span className="text-gray-500 block mb-1">能力</span><div className="flex flex-wrap gap-1">{caps.map(c => <span key={c} className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded">{c}</span>)}</div></div>
          )}
        </div>
        <div className="flex justify-end mt-4"><button onClick={onClose} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50">关闭</button></div>
      </div>
    </div>
  );
}

function A2aDialog({ server, onClose, onSuccess }: { server?: A2aServer | null; onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState(server?.name || '');
  const [url, setUrl] = useState(server?.agent_card_url || server?.endpoint || '');
  const [desc, setDesc] = useState(server?.description || '');
  const [saving, setSaving] = useState(false);
  const isEdit = !!server;

  async function submit() {
    if (!name || !url) return;
    setSaving(true);
    try {
      const body = { name, agent_card_url: url, description: desc };
      if (isEdit) await ansProxy.put(`/api/v1/a2a/${server!.id}`, body);
      else await ansProxy.post('/api/v1/a2a', body);
      onSuccess(); onClose();
    } catch {}
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{isEdit ? '编辑 A2A 服务' : '注册 A2A 服务'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div><label className="block text-sm font-medium mb-1">名称 *</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" placeholder="如 github-agent" /></div>
          <div><label className="block text-sm font-medium mb-1">Agent Card URL *</label><input value={url} onChange={e => setUrl(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm font-mono" placeholder="https://agent.example.com/.well-known/agent.json" /></div>
          <div><label className="block text-sm font-medium mb-1">描述</label><input value={desc} onChange={e => setDesc(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" /></div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">取消</button>
          <button onClick={submit} disabled={!name || !url || saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
