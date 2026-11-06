import { useState, useEffect } from 'react';
import { invoke } from '../lib/ipc';
import { Link } from 'react-router-dom';
import { Settings, Save, Plus, Trash2, RefreshCw, Brain, Wand2, Edit, Sparkles, Scan, AlertCircle } from 'lucide-react';
import { formatDbTime, parseDbTime } from '../lib/deliverable-view';

interface Preference { id: string; content: string; reasoning?: string; source: string; importance: number; created_at: string; updated_at?: string; }

const UI_PREF_KEYS = {
  theme: { label: '主题', options: ['auto', 'light', 'dark'], default: 'auto' },
  language: { label: '语言', options: ['zh-CN', 'en'], default: 'zh-CN' },
  pageSize: { label: '列表每页条数', options: ['10', '20', '50'], default: '20' },
};

function getUserId(): string {
  try {
    const t = localStorage.getItem('token');
    if (t) { const payload = JSON.parse(atob(t.split('.')[1]!)); return payload.sub || payload.id || 'default'; }
  } catch {}
  return 'default';
}

const SOURCE_LABELS: Record<string, string> = {
  user_instruction: 'Agent记录', user_manual: '手动添加', auto_extract: '自动提取',
  user_correction: '用户修正', agent_execution: '任务执行', user_onboarding: '引导采集',
};

const STALE_DAYS = 30;
function getStaleDays(prefs: Preference[]): number {
  if (prefs.length === 0) return Infinity;
  // 库内时间列是 UTC 且不带 Z——补 Z 的解析只此一份（lib/deliverable-view 的 parseDbTime），本页不再另抄
  const times = prefs.map(p => parseDbTime(p.updated_at || p.created_at)?.getTime()).filter((t): t is number => typeof t === 'number');
  if (times.length === 0) return Infinity;
  return (Date.now() - Math.max(...times)) / (1000 * 60 * 60 * 24);
}

export default function PreferencesPage() {
  const [uiPrefs, setUiPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wa_preferences') || '{}'); } catch { return {}; }
  });
  const [uiSaved, setUiSaved] = useState(false);
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [staleDays, setStaleDays] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [addContent, setAddContent] = useState('');
  const [addReasoning, setAddReasoning] = useState('');
  const [editing, setEditing] = useState<Preference | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editReasoning, setEditReasoning] = useState('');
  const userId = getUserId();

  const load = async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const data = await invoke<Preference[]>('preferences:list', { userId });
      setPrefs(Array.isArray(data) ? data : []);
      setStaleDays(getStaleDays(Array.isArray(data) ? data : []));
    } catch (e) { console.error('[prefs] load failed:', e, 'userId:', userId); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const saveUiPrefs = () => {
    localStorage.setItem('wa_preferences', JSON.stringify(uiPrefs));
    setUiSaved(true);
    setTimeout(() => setUiSaved(false), 2000);
  };

  async function handleAdd() {
    if (!addContent) return;
    try { await invoke('preferences:create', { userId, content: addContent, source: 'user_manual', reasoning: addReasoning }); setShowAdd(false); setAddContent(''); setAddReasoning(''); load(); } catch {}
  }
  async function handleDelete(id: string) {
    if (!confirm('删除这条偏好？')) return;
    try { await invoke('preferences:delete', id); load(); } catch {}
  }
  async function handleEdit() {
    if (!editing || !editContent) return;
    try { await invoke('preferences:update', { id: editing.id, content: editContent, reasoning: editReasoning }); setEditing(null); load(); } catch {}
  }
  async function handleAutoExtract() {
    setExtracting(true);
    try { await invoke('preferences:autoExtract', { userId }); load(); } catch { alert('自动提取失败'); }
    setExtracting(false);
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">用户偏好</h2>

      {/* UI 偏好 */}
      <div className="max-w-lg space-y-3 mb-8">
        <h3 className="text-sm font-medium text-gray-500 flex items-center gap-1"><Settings className="w-4 h-4"/>界面设置</h3>
        {(Object.entries(UI_PREF_KEYS) as [string, { label: string; options: string[]; default: string }][]).map(([key, cfg]) => (
          <div key={key} className="bg-white rounded-lg border p-3">
            <label className="block text-sm font-medium mb-1">{cfg.label}</label>
            <select value={uiPrefs[key] || cfg.default} onChange={e => setUiPrefs((p: Record<string, string>) => ({ ...p, [key]: e.target.value }))}
              className="w-full px-3 py-2 border rounded-lg text-sm">{cfg.options.map(o => <option key={o} value={o}>{o}</option>)}</select>
          </div>
        ))}
        <button onClick={saveUiPrefs} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${uiSaved ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
          {uiSaved ? '已保存' : <><Save className="w-4 h-4"/>保存界面偏好</>}
        </button>
      </div>

      {/* 过期提醒 */}
      {!loading && prefs.length > 0 && staleDays > STALE_DAYS && (
        <div className="max-w-2xl flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4">
          <AlertCircle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1"><p className="text-sm font-medium text-amber-800">偏好已 {Math.floor(staleDays)} 天未更新</p><p className="text-xs text-amber-600 mt-0.5">你的偏好可能已变化，建议重新设置以获得最佳体验</p></div>
          {/* zx_20261005 M14: 指向**偏好问卷**（`/preferences-wizard`），不是安装向导 `/onboarding`。 */}
          <Link to="/preferences-wizard" className="px-3 py-1.5 border border-amber-300 text-amber-700 rounded text-sm hover:bg-amber-100 flex-shrink-0">重新设置</Link>
        </div>
      )}

      {/* Agent 偏好 */}
      <div className="max-w-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-medium text-gray-500 flex items-center gap-1"><Brain className="w-4 h-4"/>已记住的偏好 ({prefs.length})</h3>
            <p className="text-xs text-gray-400 mt-0.5">通过偏好设置向导、Agent 对话或自动提取积累</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="p-1.5 hover:bg-gray-100 rounded"><RefreshCw className="w-3.5 h-3.5"/></button>
          </div>
        </div>

        {loading ? <p className="text-sm text-gray-400 py-4">加载中...</p> : prefs.length === 0 ? (
          <div className="bg-white rounded-lg border p-8 text-center text-gray-400">
            <Sparkles className="w-14 h-14 mx-auto mb-4 text-amber-400 opacity-60" />
            <p className="text-base font-medium mb-1">尚无用户偏好</p>
            <p className="text-sm mb-6">通过引导向导快速设置，或让 Agent 在对话中逐渐了解你</p>
            <div className="flex gap-3 justify-center flex-wrap">
              <Link to="/preferences-wizard" className="inline-flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Sparkles className="w-4 h-4"/>偏好设置向导</Link>
              <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50"><Plus className="w-4 h-4"/>添加偏好</button>
              <button onClick={handleAutoExtract} disabled={extracting} className="inline-flex items-center gap-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"><Scan className="w-4 h-4"/>{extracting ? '提取中...' : '自动提取'}</button>
            </div>
            <p className="text-xs text-gray-400 mt-4">或者通过 IM 对 Agent 说"记住我偏好..."开始积累</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <button onClick={() => setShowAdd(true)} className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1"><Plus className="w-3 h-3"/>添加偏好</button>
              <button onClick={handleAutoExtract} disabled={extracting} className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded hover:bg-purple-200 flex items-center gap-1"><Wand2 className="w-3 h-3"/>{extracting ? '提取中...' : '自动提取'}</button>
            </div>
            {prefs.map(p => (
              <div key={p.id} className="bg-white rounded-lg border p-4 flex items-start justify-between gap-4 hover:bg-gray-50 group">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700">{p.content}</p>
                  <div className="flex gap-2 mt-2 flex-wrap items-center">
                    {p.reasoning && <span className="text-xs text-gray-400">原因: {p.reasoning}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600`}>{SOURCE_LABELS[p.source] || p.source}</span>
                    <span className="text-xs text-gray-400">{formatDbTime(p.created_at)}</span>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button onClick={() => { setEditing(p); setEditContent(p.content); setEditReasoning(p.reasoning || ''); }} className="p-1 hover:bg-blue-50 rounded"><Edit className="w-3 h-3 text-blue-500"/></button>
                  <button onClick={() => handleDelete(p.id)} className="p-1 hover:bg-red-50 rounded"><Trash2 className="w-3 h-3 text-red-400"/></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 添加偏好弹窗 */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">添加偏好</h3>
            <div className="space-y-3">
              <div><label className="text-sm font-medium">偏好内容 *</label><textarea value={addContent} onChange={e => setAddContent(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mt-1" rows={3} placeholder="如：用户偏好使用TypeScript+Elysia+Zod做后端开发"/></div>
              <div><label className="text-sm font-medium">原因（可选）</label><input value={addReasoning} onChange={e => setAddReasoning(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mt-1" placeholder="如：用户在第3次纠正Agent的框架选择后明确表达"/></div>
            </div>
            <div className="flex justify-end gap-2 mt-4"><button onClick={() => setShowAdd(false)} className="px-4 py-2 border rounded-lg text-sm">取消</button><button onClick={handleAdd} disabled={!addContent} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">保存</button></div>
          </div>
        </div>
      )}

      {/* 编辑偏好弹窗 */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">编辑偏好</h3>
            <div className="space-y-3">
              <div><label className="text-sm font-medium">偏好内容</label><textarea value={editContent} onChange={e => setEditContent(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mt-1" rows={3}/></div>
              <div><label className="text-sm font-medium">原因（可选）</label><input value={editReasoning} onChange={e => setEditReasoning(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mt-1"/></div>
            </div>
            <div className="flex justify-end gap-2 mt-4"><button onClick={() => setEditing(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button><button onClick={handleEdit} disabled={!editContent} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">保存</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
