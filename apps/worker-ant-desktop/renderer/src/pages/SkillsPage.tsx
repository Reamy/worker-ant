import { useState, useEffect } from 'react';
import { ansProxy, skills as skillsIpc } from '../lib/ipc';
import { Wand2, RefreshCw, Plus, Trash2, Pencil, X, Check, Sparkles } from 'lucide-react';

interface Skill { id: string; name: string; description?: string; category?: string; enabled?: number; status?: string; tags?: string; version?: number; config?: string; }
interface SkillDraft { id: string; name: string; description: string; steps: string[]; }

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<Skill | null>(null);
  // 记忆衍生技能草稿
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  // DataTable 排序
  const [sortBy, setSortBy] = useState<'name' | 'status' | 'category'>('name');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => { load(); loadDrafts(); }, []);
  async function load() { setLoading(true); setError(''); try { const d = await ansProxy.get<Skill[]>('/api/v1/skills'); setSkills(d as Skill[]); } catch(e) { setError((e as Error).message); } setLoading(false); }
  async function loadDrafts() { try { const r = await skillsIpc.listDrafts(); setDrafts(r.drafts); } catch {} }
  async function handleApprove(id: string) { try { await skillsIpc.approve(id); loadDrafts(); } catch {} }
  async function handleReject(id: string) { try { await skillsIpc.reject(id); loadDrafts(); } catch {} }
  async function handleDelete(id: string) { if (!confirm('确定删除？')) return; try { await ansProxy.delete(`/api/v1/skills/${id}`); load(); } catch {} }
  async function handleToggle(skill: Skill) { try { await ansProxy.put(`/api/v1/skills/${skill.id}`, { enabled: !skill.enabled }); load(); } catch {} }

  function parseTags(skill: Skill): string[] {
    try { return JSON.parse(skill.tags || '[]') as string[]; } catch { return []; }
  }
  // DataTable 排序
  const sortedSkills = [...skills].sort((a, b) => {
    const ca = sortBy === 'name' ? a.name : sortBy === 'status' ? String(a.status || (a.enabled ? '启用' : '禁用')) : (a.category || '');
    const cb = sortBy === 'name' ? b.name : sortBy === 'status' ? String(b.status || (b.enabled ? '启用' : '禁用')) : (b.category || '');
    const cmp = ca.localeCompare(cb);
    return sortAsc ? cmp : -cmp;
  });

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">技能管理</h2>
        <div className="flex items-center gap-2">
          <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
            <option value="name">按名称</option>
            <option value="category">按分类</option>
            <option value="status">按状态</option>
          </select>
          <button onClick={() => setSortAsc(!sortAsc)} className="px-2 py-1.5 border rounded-lg text-sm bg-white hover:bg-gray-50" title="切换升降序">{sortAsc ? '↑升序' : '↓降序'}</button>
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setEditItem(null); setShowForm(true); }} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5" />添加技能</button>
        </div>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">错误: {error}</p>}

      {drafts.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-gray-700">技能草稿审批（程序性记忆自动提炼，待批准生效）</h3>
          </div>
          <div className="space-y-2">
            {drafts.map(d => (
              <div key={d.id} className="bg-amber-50 rounded-lg border border-amber-200 p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <h4 className="font-medium text-sm">{d.name}</h4>
                    <p className="text-xs text-gray-500 mt-0.5">{d.description}</p>
                    <ol className="mt-2 space-y-0.5">
                      {d.steps.map((s, i) => <li key={i} className="text-xs text-gray-600"><span className="text-gray-400">{i + 1}.</span> {s}</li>)}
                    </ol>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    <button onClick={() => handleApprove(d.id)} className="flex items-center gap-1 px-2.5 py-1.5 bg-green-600 text-white rounded-lg text-xs hover:bg-green-700"><Check className="w-3.5 h-3.5" />批准</button>
                    <button onClick={() => handleReject(d.id)} className="flex items-center gap-1 px-2.5 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-50"><X className="w-3.5 h-3.5" />拒绝</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {skills.length === 0 ? <p className="text-gray-400 text-center py-12">暂无技能</p> : (
        <div className="space-y-2">
          {sortedSkills.map(s => {
            const tags = parseTags(s);
            return (
              <div key={s.id} className="bg-white rounded-lg border p-4 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <Wand2 className="w-5 h-5 text-purple-500 flex-shrink-0" />
                  <div className="min-w-0">
                    <h3 className="font-medium">{s.name}</h3>
                    <p className="text-xs text-gray-400 truncate">{s.description?.slice(0, 80) || '—'}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {s.category && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{s.category}</span>}
                      <span className="text-[10px] text-gray-400">v{s.version || 1}</span>
                      {tags.map(t => <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">{t}</span>)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${s.status === 'active' ? 'bg-green-100 text-green-700' : s.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{s.status || (s.enabled ? '启用' : '禁用')}</span>
                  <button onClick={() => handleToggle(s)} className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200">{s.enabled ? '禁用' : '启用'}</button>
                  <button onClick={() => { setEditItem(s); setShowForm(true); }} className="p-1 hover:bg-blue-50 rounded" title="编辑"><Pencil className="w-3.5 h-3.5 text-blue-500" /></button>
                  <button onClick={() => handleDelete(s.id)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showForm && <SkillDialog skill={editItem} onClose={() => { setShowForm(false); setEditItem(null); }} onSuccess={load} />}
    </div>
  );
}

function SkillDialog({ skill, onClose, onSuccess }: { skill?: Skill | null; onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState(skill?.name || '');
  const [desc, setDesc] = useState(skill?.description || '');
  const [category, setCategory] = useState(skill?.category || '');
  const [tagsStr, setTagsStr] = useState(() => {
    try { return (JSON.parse(skill?.tags || '[]') as string[]).join(', '); } catch { return ''; }
  });
  const [saving, setSaving] = useState(false);
  const isEdit = !!skill;

  async function submit() {
    if (!name) return;
    setSaving(true);
    try {
      const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
      const body: Record<string, unknown> = { name, description: desc, category, tags };
      if (isEdit) {
        await ansProxy.put(`/api/v1/skills/${skill!.id}`, body);
      } else {
        await ansProxy.post('/api/v1/skills', body);
      }
      onSuccess(); onClose();
    } catch {}
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{isEdit ? '编辑技能' : '添加技能'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div><label className="block text-sm font-medium mb-1">名称 *</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 code-review" /></div>
          <div><label className="block text-sm font-medium mb-1">描述</label><input value={desc} onChange={e => setDesc(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="技能描述" /></div>
          <div><label className="block text-sm font-medium mb-1">分类</label><input value={category} onChange={e => setCategory(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 dev, review" /></div>
          <div><label className="block text-sm font-medium mb-1">标签（逗号分隔）</label><input value={tagsStr} onChange={e => setTagsStr(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 dev, code-review" /></div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
          <button onClick={submit} disabled={!name || saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
