import { useState, useEffect } from 'react';
import { ansProxy, ans as ansApi } from '../lib/ipc';
import { Key, RefreshCw, Plus, Trash2, Copy, X } from 'lucide-react';
import { formatDbTime } from '../lib/deliverable-view';

interface ApiKey { id: string; key_prefix?: string; name?: string; status?: string; resource_groups?: string[]; created_at?: string; last_used_at?: string; }
interface NewKeyResult { api_key: string; secret: string; name: string; resource_groups: string[]; }

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [newKey, setNewKey] = useState<NewKeyResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [ansBaseUrl, setAnsBaseUrl] = useState('');

  useEffect(() => { load(); }, []);
  useEffect(() => { ansApi.defaults().then((d) => setAnsBaseUrl(d.baseUrl)).catch(() => setAnsBaseUrl('')); }, []);
  async function load() { setLoading(true); setError(''); try { const d = await ansProxy.get<ApiKey[]>('/api/v1/auth/api-keys'); setKeys(d as ApiKey[]); } catch(e) { setError((e as Error).message); } setLoading(false); }
  async function handleDelete(prefix: string) { if (!confirm('确定吊销此 API Key？')) return; try { await ansProxy.delete(`/api/v1/auth/api-keys/${prefix}`); load(); } catch {} }

  async function copyToClipboard(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(null), 2000); } catch { alert('复制失败'); }
  }

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">API Keys</h2>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setNewKey(null); setShowForm(true); }} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5" />创建 API Key</button>
        </div>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">错误: {error}</p>}

      {keys.length === 0 ? <p className="text-gray-400 text-center py-12">暂无 API Key</p> : (
        <div className="space-y-2 mb-6">
          {keys.map(k => (
            <div key={k.id} className="bg-white rounded-lg border p-4 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Key className="w-5 h-5 text-yellow-500 flex-shrink-0" />
                <div>
                  <h3 className="font-medium font-mono text-sm">{k.key_prefix || k.id?.slice(0, 12)}****</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-400">{k.name || '—'}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${k.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{k.status === 'active' ? '启用' : '已吊销'}</span>
                    {k.resource_groups && k.resource_groups.length > 0 && k.resource_groups.map(g => <span key={g} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">{g}</span>)}
                    <span className="text-xs text-gray-400">创建: {formatDbTime(k.created_at) || '—'}</span>
                    {k.status === 'active' && (
                      <button onClick={(e) => { e.stopPropagation(); const v = prompt('编辑资源组（逗号分隔，留空=全部资源）', (k.resource_groups || []).join(', ')); if (v !== null) { const g = v.split(',').map(s=>s.trim()).filter(Boolean); ansProxy.put(`/api/v1/auth/api-keys/${k.key_prefix || k.id}`, {resource_groups:g}).then(load).catch(()=>{}); } }} className="text-[10px] px-1 py-0.5 bg-gray-100 rounded hover:bg-gray-200 ml-1">编辑</button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => copyToClipboard(k.key_prefix || '', k.key_prefix || '')} className="p-1.5 hover:bg-gray-100 rounded" title="复制 Key 前缀">
                  {copied === k.key_prefix ? <span className="text-xs text-green-500 px-1">已复制</span> : <Copy className="w-4 h-4 text-gray-400" />}
                </button>
                {k.status === 'active' && <button onClick={() => handleDelete(k.key_prefix || k.id)} className="p-1 hover:bg-red-50 rounded" title="吊销"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 使用说明 */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="font-bold mb-3">使用说明</h3>
        <div className="text-sm text-gray-600 space-y-2">
          <p>向 ANS API 发起请求时需要携带以下 HTTP 头：</p>
          <div className="space-y-1 font-mono text-xs bg-gray-50 p-3 rounded">
            <p><span className="text-blue-600">X-Api-Key</span>: wa_xxxxxxxxxxxxx</p>
            <p><span className="text-blue-600">X-Timestamp</span>: {Date.now()}</p>
            <p><span className="text-blue-600">X-Signature</span>: HMAC-SHA256(secret, timestamp + ':' + request_body)</p>
          </div>
          <p className="text-xs text-gray-400">签名算法：使用创建时返回的 Secret，将时间戳和请求体用冒号拼接后做 HMAC-SHA256 签名</p>
          <p className="text-xs text-gray-400">资源组：为空=可访问全部资源；设置后仅匹配同组或无组资源</p>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => copyToClipboard(`curl -H "X-Api-Key: YOUR_KEY" -H "X-Timestamp: ${Date.now()}" -H "X-Signature: YOUR_SIGNATURE" ${ansBaseUrl || 'http://localhost:27183'}/api/v1/models`, 'curl')} className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200">
              {copied === 'curl' ? '已复制' : '复制 curl 示例'}
            </button>
          </div>
        </div>
      </div>

      {showForm && <CreateKeyDialog onSuccess={(result) => { setNewKey(result); setShowForm(false); load(); }} onClose={() => setShowForm(false)} />}
      {newKey && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setNewKey(null)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-red-600">Secret 仅显示一次</h3>
              <button onClick={() => setNewKey(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-sm text-red-500 mb-3">请立即复制并安全保存，关闭后将无法再次查看！</p>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500">API Key</label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-xs bg-gray-50 px-2 py-1.5 rounded flex-1 break-all font-mono">{newKey.api_key}</code>
                  <button onClick={() => copyToClipboard(newKey.api_key, 'apikey')} className="p-1 hover:bg-gray-100 rounded"><Copy className="w-4 h-4" /></button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500">Secret</label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-xs bg-gray-50 px-2 py-1.5 rounded flex-1 break-all font-mono">{newKey.secret}</code>
                  <button onClick={() => copyToClipboard(newKey.secret, 'secret')} className="p-1 hover:bg-gray-100 rounded"><Copy className="w-4 h-4" /></button>
                </div>
              </div>
              {newKey.resource_groups?.length > 0 && (
                <div className="flex gap-1 flex-wrap">
                  {newKey.resource_groups.map(g => <span key={g} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">{g}</span>)}
                </div>
              )}
            </div>
            <div className="flex justify-end mt-4">
              <button onClick={() => setNewKey(null)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">我已保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateKeyDialog({ onSuccess, onClose }: { onSuccess: (result: NewKeyResult) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [groupsStr, setGroupsStr] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const groups = groupsStr.split(',').map(s => s.trim()).filter(Boolean);
      const r = await ansProxy.post<NewKeyResult>('/api/v1/auth/api-keys', { name: name || 'default', resource_groups: groups });
      if (r) onSuccess(r as NewKeyResult);
    } catch {}
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">创建 API Key</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div><label className="text-sm font-medium">名称</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 team-a-key" /></div>
          <div><label className="text-sm font-medium">资源组（逗号分隔，留空=全部资源可见）</label><input value={groupsStr} onChange={e => setGroupsStr(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 team-a,team-b" /><p className="text-xs text-gray-400 mt-1">绑定资源组后，此 Key 只能访问对应资源组的模型/技能/MCP/A2A</p></div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
          <button onClick={submit} disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"><Key className="w-4 h-4 inline mr-1" />生成</button>
        </div>
      </div>
    </div>
  );
}
