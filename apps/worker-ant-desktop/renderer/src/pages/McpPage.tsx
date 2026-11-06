import { useState, useEffect } from 'react';
import { ansProxy } from '../lib/ipc';
import { Server, RefreshCw, Circle, Trash2, Pencil, Plus, Activity, RotateCcw, Eye, X } from 'lucide-react';
// 库内时间列是 UTC 且不带 Z——换算只此一份（写在本行所示模块里），不在本页另抄
import { formatDbTime } from '../lib/deliverable-view';

interface McpServer { id: string; name: string; endpoint?: string; transport?: string; status?: string; description?: string; health_check_at?: string; cached_tools?: unknown; cached_server_info?: unknown; auth_config?: unknown; }

function formatTime(utcStr: string | undefined | null): string {
  if (!utcStr) return '未检查';
  return formatDbTime(utcStr) || utcStr;
}
function safeParse(v: unknown): unknown {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

export default function McpPage() {
  const [items, setItems] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<McpServer | null>(null);
  const [detail, setDetail] = useState<McpServer | null>(null);

  useEffect(() => { load(); }, []);
  async function load() { setLoading(true); setError(''); try { const d = await ansProxy.get<McpServer[]>('/api/v1/mcp?all=1'); setItems(d as McpServer[]); } catch(e) { setError((e as Error).message); } setLoading(false); }
  async function handleDelete(id: string) { if (!confirm('确定删除？')) return; try { await ansProxy.delete(`/api/v1/mcp/${id}`); load(); } catch {} }
  async function handleHealthCheck(id: string) { try { await ansProxy.post(`/api/v1/mcp/${id}/health-check`); load(); } catch { alert('健康检查失败'); } }
  async function handleRefresh(id: string) { try { await ansProxy.post(`/api/v1/mcp/${id}/refresh`); load(); } catch { alert('刷新工具缓存失败'); } }
  async function showDetail(id: string) { try { const d = await ansProxy.get<McpServer>(`/api/v1/mcp/${id}`); setDetail(d as McpServer); } catch { setDetail(items.find(i => i.id === id) || null); } }

  const statusLabels: Record<string, string> = { active: '正常', error: '异常', disabled: '已禁用', healing: '恢复中', unknown: '未知' };
  const statusColors: Record<string, string> = { active: 'bg-green-100 text-green-700', error: 'bg-red-100 text-red-700', disabled: 'bg-gray-100 text-gray-500', healing: 'bg-yellow-100 text-yellow-700', unknown: 'bg-gray-100 text-gray-500' };

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">MCP 服务</h2>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setEditItem(null); setShowForm(true); }} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5" />注册服务</button>
        </div>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">错误: {error}</p>}
      {items.length === 0 ? <p className="text-gray-400 text-center py-12">暂无 MCP 服务</p> : (
        <div className="space-y-2">
          {items.map(m => (
            <div key={m.id} className="bg-white rounded-lg border p-4 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Server className="w-5 h-5 text-purple-500 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{m.name}</h3>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded cursor-pointer hover:underline text-blue-600`} onClick={() => showDetail(m.id)}><Eye className="w-3 h-3 inline" /> 详情</span>
                  </div>
                  <p className="text-xs text-gray-400 font-mono truncate">{m.endpoint || '—'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">传输: {m.transport || '—'} · 最近检查: {formatTime(m.health_check_at)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[m.status || 'unknown'] || 'bg-gray-100 text-gray-500'}`}>{statusLabels[m.status || 'unknown'] || m.status || '未知'}</span>
                <button onClick={() => handleHealthCheck(m.id)} className="p-1 hover:bg-blue-50 rounded" title="健康检查"><Activity className="w-3.5 h-3.5 text-blue-500" /></button>
                <button onClick={() => handleRefresh(m.id)} className="p-1 hover:bg-green-50 rounded" title="刷新工具缓存"><RotateCcw className="w-3.5 h-3.5 text-green-500" /></button>
                <button onClick={() => { setEditItem(m); setShowForm(true); }} className="p-1 hover:bg-blue-50 rounded" title="编辑"><Pencil className="w-3.5 h-3.5 text-blue-500" /></button>
                <button onClick={() => handleDelete(m.id)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showForm && <McpDialog server={editItem} onClose={() => { setShowForm(false); setEditItem(null); }} onSuccess={load} />}
      {detail && <McpDetailDialog detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function McpDetailDialog({ detail, onClose }: { detail: McpServer | null; onClose: () => void }) {
  if (!detail) return null;
  const tools = (Array.isArray(detail.cached_tools) ? detail.cached_tools : safeParse(detail.cached_tools)) as { name: string; description: string }[] || [];
  const info = (typeof detail.cached_server_info === 'object' && detail.cached_server_info ? detail.cached_server_info : safeParse(detail.cached_server_info)) as { name?: string; version?: string } || {};
  const st = detail.status || 'unknown';
  const statusLabels: Record<string, string> = { active: '正常', error: '异常', disabled: '已禁用', healing: '恢复中' };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">MCP 服务: {detail.name}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div><span className="text-gray-500">状态</span><p className="font-medium">{statusLabels[st] || st}</p></div>
            <div><span className="text-gray-500">传输协议</span><p>{detail.transport || '-'}</p></div>
            <div className="col-span-2"><span className="text-gray-500">端点</span><p className="font-mono text-xs break-all">{detail.endpoint}</p></div>
            {info?.version && <div><span className="text-gray-500">服务版本</span><p>{info.version}</p></div>}
            {info?.name && <div><span className="text-gray-500">服务名</span><p>{info.name}</p></div>}
            <div><span className="text-gray-500">最近检查</span><p className="text-xs">{formatTime(detail.health_check_at)}</p></div>
            <div><span className="text-gray-500">工具数量</span><p className="font-medium">{tools.length} 个</p></div>
          </div>
          {tools.length > 0 && (
            <div>
              <p className="text-gray-500 font-medium mb-2">已注册工具 ({tools.length})</p>
              <div className="max-h-60 overflow-y-auto space-y-2">
                {tools.map((t, i) => (
                  <div key={i} className="p-2 bg-gray-50 rounded text-xs">
                    <p className="font-semibold text-blue-700">{t.name}</p>
                    <p className="text-gray-500 mt-0.5 line-clamp-2">{t.description?.slice(0, 200) || '无描述'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function McpDialog({ server, onClose, onSuccess }: { server?: McpServer | null; onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState(server?.name || '');
  const [endpoint, setEndpoint] = useState(server?.endpoint || '');
  const [transport, setTransport] = useState(server?.transport || 'streamable-http');
  const [authType, setAuthType] = useState('none');
  const [authToken, setAuthToken] = useState('');
  const [saving, setSaving] = useState(false);
  const isEdit = !!server;

  useEffect(() => {
    if (server?.auth_config) {
      try {
        const ac = typeof server.auth_config === 'string' ? JSON.parse(server.auth_config) : server.auth_config;
        const cfg = ac as Record<string, unknown>;
        if (cfg.type === 'bearer') { setAuthType('bearer'); setAuthToken((cfg.token as string) || ''); }
      } catch {}
    }
  }, [server]);

  async function submit() {
    if (!name || !endpoint) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name, endpoint, transport, auth_config: authType === 'bearer' ? { type: 'bearer', token: authToken } : { type: 'none' } };
      if (isEdit) {
        await ansProxy.put(`/api/v1/mcp/${server!.id}`, body);
      } else {
        await ansProxy.post('/api/v1/mcp', body);
      }
      onSuccess(); onClose();
    } catch {}
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{isEdit ? '编辑 MCP 服务' : '注册 MCP 服务'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div><label className="block text-sm font-medium mb-1">名称 *</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 github-mcp" /></div>
          <div><label className="block text-sm font-medium mb-1">端点 URL *</label><input value={endpoint} onChange={e => setEndpoint(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="https://mcp.example.com" /></div>
          <div><label className="block text-sm font-medium mb-1">传输模式</label>
            <select value={transport} onChange={e => setTransport(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="streamable-http">Streamable HTTP</option>
              <option value="stdio">stdio</option>
            </select>
          </div>
          <div><label className="block text-sm font-medium mb-1">认证方式</label>
            <select value={authType} onChange={e => setAuthType(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="none">无认证</option>
              <option value="bearer">Bearer Token</option>
            </select>
          </div>
          {authType === 'bearer' && <div><label className="block text-sm font-medium mb-1">Token</label><input type="password" value={authToken} onChange={e => setAuthToken(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Bearer token" /></div>}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
          <button onClick={submit} disabled={!name || !endpoint || saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
