import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, Check, Download, Plus, RefreshCw, Save, Send, Trash2, Upload, X } from 'lucide-react';
import {
  positions as positionsIpc,
  tasks as tasksIpc,
  type PositionDetail,
  type PositionListRow,
  type PositionProfile,
  type PositionWriteBody,
} from '../lib/ipc';
// zx_20261113_1 B4「晋」: 晋升目标与来源词表取 main 侧同一份（不在页面手抄第二套中文名）。
import {
  POSITION_LESSON_SOURCE_LABEL,
  POSITION_PROMOTE_TARGET_LABEL,
  type PositionLessonPromoteTarget,
} from '../../../src/main/core/positions.js';

interface FormState {
  name: string;
  category: string;
  description: string;
  rules: string;
  skills: string;
  knowledge: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  category: 'custom',
  description: '',
  rules: '',
  skills: '',
  knowledge: '',
  enabled: true,
};

function splitLines(raw: string): string[] {
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

function toBody(f: FormState): PositionWriteBody {
  return {
    name: f.name.trim(),
    category: f.category.trim(),
    description: f.description.trim(),
    rules: splitLines(f.rules),
    skills: splitLines(f.skills),
    knowledge: splitLines(f.knowledge),
    enabled: f.enabled,
  };
}

function formOf(d: PositionDetail): FormState {
  const p = d.position;
  return {
    name: p.name,
    category: p.category,
    description: p.description,
    rules: p.rules.join('\n'),
    skills: p.skills.join('\n'),
    knowledge: p.knowledge.join('\n'),
    enabled: p.enabled,
  };
}

const inputCls = 'w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

export default function PositionsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<PositionListRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<PositionDetail | null>(null);
  // zx_20261113_1 B5「像」: 岗位画像（只读派生；读不到如实说，不挡详情）。
  const [profile, setProfile] = useState<PositionProfile | null>(null);
  const [profileError, setProfileError] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);
  // zx_20261112_1 B2「任」: 派活——岗位固定（不可改），项目只在**该岗位已启用的未归档项目**里选。
  // zx_20261113_2 M17：经验编辑（缩短后再晋升）。
  const [editingLesson, setEditingLesson] = useState<{ id: string; content: string } | null>(null);
  const [showDispatch, setShowDispatch] = useState(false);
  const [dispatchForm, setDispatchForm] = useState({ projectId: '', title: '', description: '', acceptance: '' });
  const [dispatching, setDispatching] = useState(false);

  useEffect(() => {
    void loadList();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
  }, [selectedId]);

  async function loadList(preferId?: string) {
    setLoading(true);
    setError('');
    try {
      const r = await positionsIpc.list();
      setRows(r.positions);
      const next = preferId || selectedId || r.positions[0]?.id || '';
      if (next !== selectedId) setSelectedId(next);
      else if (next) await loadDetail(next);
      if (r.positions.length === 0) setDetail(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }

  async function loadDetail(id: string) {
    try {
      const d = await positionsIpc.get(id);
      setDetail(d);
      setForm(formOf(d));
      // 画像与详情分开取：画像读失败只影响画像卡，不把岗位详情整页打空。
      try {
        setProfile(await positionsIpc.profile(id));
        setProfileError('');
      } catch (e) {
        setProfile(null);
        setProfileError((e as Error).message);
      }
    } catch (e) {
      setError((e as Error).message);
      setDetail(null);
      setProfile(null);
    }
  }

  async function save() {
    if (!detail) return;
    if (!form.name.trim()) {
      setError('岗位名称不能为空');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.update(detail.position.id, toBody(form));
      setDetail({ ...detail, position: r.position });
      setForm(formOf({ ...detail, position: r.position }));
      setNotice('已保存');
      await loadList(r.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  }

  async function toggle(p: PositionListRow) {
    setError('');
    try {
      await positionsIpc.toggle(p.id, !p.enabled);
      await loadList(p.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(p: PositionListRow) {
    if (!confirm(`确定删除岗位「${p.name}」？已确认的经验会保留，项目绑定将解除。`)) return;
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.remove(p.id);
      setNotice(`已删除：解除 ${r.unboundProjects} 个项目绑定，保留 ${r.keptLessons} 条经验`);
      setSelectedId('');
      setDetail(null);
      await loadList('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleProject(projectId: string, enabled: boolean) {
    if (!detail) return;
    setError('');
    try {
      const r = await positionsIpc.projectToggle(detail.position.id, projectId, enabled);
      setDetail({ ...detail, projects: r.projects });
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function decideLesson(id: string, decision: 'accepted' | 'rejected') {
    if (!detail) return;
    setError('');
    try {
      await positionsIpc.decideLesson(id, decision);
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function promoteLesson(id: string, target: PositionLessonPromoteTarget) {
    if (!detail) return;
    setError('');
    setNotice('');
    try {
      await positionsIpc.promoteLesson(id, target);
      setNotice(`已晋升到「${POSITION_PROMOTE_TARGET_LABEL[target]}」——晋升后不再作为经验重复注入。`);
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // zx_20261113_2 M17：保存经验编辑；晋升上限 200 字由 core 晋升口再判一次。
  async function saveLessonEdit() {
    if (!editingLesson || !detail) return;
    setError('');
    setNotice('');
    try {
      await positionsIpc.updateLesson(editingLesson.id, editingLesson.content);
      setNotice('经验已更新。');
      setEditingLesson(null);
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function unpromoteLesson(id: string) {
    if (!detail) return;
    setError('');
    setNotice('');
    try {
      await positionsIpc.unpromoteLesson(id);
      setNotice('已撤回晋升——该经验恢复为可注入经验。');
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function exportPack() {
    if (!detail) return;
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.exportPackage(detail.position.id);
      if (r.cancelled) return;
      setNotice(`已导出 ${r.lessons ?? 0} 条已采纳经验到 ${r.path ?? ''}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importPack(mode: 'merge' | 'replace') {
    if (mode === 'replace' && !window.confirm('覆盖导入会用知识包里的四段替换同名岗位的现有内容（经验仍只追加候选）。确定继续？')) return;
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.importPackage(mode);
      if (r.cancelled) return;
      setNotice(`已导入：条目新增 ${r.addedSections ?? 0} · 经验新增 ${r.addedLessons ?? 0}（跳过 ${r.skippedLessons ?? 0}）——导入经验为待审候选，采纳后才注入。`);
      if (r.position?.id) {
        setSelectedId(r.position.id);
        await loadList(r.position.id);
        await loadDetail(r.position.id);
      } else {
        await loadList();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function create() {
    if (!createForm.name.trim()) {
      setError('岗位名称不能为空');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await positionsIpc.create(toBody(createForm));
      setShowCreate(false);
      setCreateForm(EMPTY_FORM);
      await loadList(r.position.id);
      setSelectedId(r.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  }

  // 可派活的项目 = 未归档（listPositionProjects 已在 SQL 里滤掉）∧ 该岗位已启用。
  const dispatchProjects = detail ? detail.projects.filter((p) => p.enabled) : [];

  function openDispatch() {
    setError('');
    setDispatchForm({ projectId: dispatchProjects[0]?.id ?? '', title: '', description: '', acceptance: '' });
    setShowDispatch(true);
  }

  async function submitDispatch() {
    if (!detail) return;
    const title = dispatchForm.title.trim();
    if (!dispatchForm.projectId) { setError('请选择项目'); return; }
    if (!title) { setError('任务标题不能为空'); return; }
    setDispatching(true);
    setError('');
    try {
      const r = await tasksIpc.create(
        dispatchForm.projectId, title, dispatchForm.description.trim(), 0,
        dispatchForm.acceptance.trim(), undefined, undefined, undefined, undefined,
        detail.position.id,
      );
      const newId = String((r as { id?: unknown }).id ?? '');
      setShowDispatch(false);
      if (newId) navigate(`/tasks/${newId}`);
      else await loadDetail(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
    setDispatching(false);
  }

  if (loading && rows.length === 0) {
    return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold">岗位</h2>
          <p className="text-xs text-gray-500 mt-1">长期在岗的知识载体：说明 / 规范 / 技能 / 知识四段常驻，任务可指派，收口经验需人工确认。</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void loadList()} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setCreateForm(EMPTY_FORM); setShowCreate(true); }} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5" />新建岗位</button>
        </div>
      </div>

      {error && <p className="text-red-500 text-sm mb-3">错误：{error}</p>}
      {notice && <p className="text-green-600 text-sm mb-3">{notice}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2">
          {rows.length === 0 && <p className="text-gray-400 text-center py-8">暂无岗位</p>}
          {rows.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`w-full text-left bg-white rounded-lg border p-3 hover:border-blue-300 ${selectedId === p.id ? 'border-blue-500 ring-1 ring-blue-200' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-blue-500 flex-shrink-0" />
                <span className="font-medium text-sm truncate">{p.name}</span>
                {p.builtin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">内置</span>}
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${p.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{p.enabled ? '启用' : '停用'}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-500">
                <span>绑定 {p.projectCount} 个项目</span>
                {p.pendingLessons > 0 && <span className="text-amber-600">待确认经验 {p.pendingLessons}</span>}
              </div>
            </button>
          ))}
        </div>

        <div className="lg:col-span-2">
          {!detail ? (
            <div className="bg-white rounded-lg border p-8 text-center text-gray-400">选择左侧岗位查看详情</div>
          ) : (
            <div className="space-y-4">
              <div className="bg-white rounded-lg border p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{detail.position.name}</h3>
                    <span className="text-[10px] text-gray-400">v{detail.position.version}</span>
                    {detail.position.builtin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">内置</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {detail.position.enabled && dispatchProjects.length === 0 && <span className="text-[11px] text-amber-600">先在下方「项目启用」勾选一个项目</span>}
                    <button
                      onClick={openDispatch}
                      disabled={!detail.position.enabled || dispatchProjects.length === 0}
                      title={!detail.position.enabled ? '岗位已停用——先启用岗位' : dispatchProjects.length === 0 ? '没有可派活的项目——先在下方「项目启用」勾选一个项目' : '用该岗位新建一个任务（岗位固定，不可改）'}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    ><Send className="w-3 h-3" />派活</button>
                    <button onClick={() => void toggle({ ...detail.position, projectCount: 0, pendingLessons: 0 })} className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">{detail.position.enabled ? '停用' : '启用'}</button>
                    <button onClick={() => void remove({ ...detail.position, projectCount: 0, pendingLessons: 0 })} className="p-1.5 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-4 h-4 text-red-400" /></button>
                  </div>
                </div>
                {/* zx_20261113_1 B6「商」: 知识包搬运（Pro）——导出/合并导入/覆盖导入；本机使用不挂闸。 */}
                <div className="flex items-center gap-1.5 flex-wrap mb-3 text-[11px]">
                  <button onClick={() => void exportPack()} className="flex items-center gap-1 px-2 py-1 rounded border text-gray-600 hover:bg-gray-50" title="导出岗位四段 + 已采纳经验（Pro 能力）">
                    <Download className="w-3 h-3" />导出知识包
                  </button>
                  <button onClick={() => void importPack('merge')} className="flex items-center gap-1 px-2 py-1 rounded border text-gray-600 hover:bg-gray-50" title="合并导入：只补缺失条目与经验，不覆盖本机已有内容（Pro 能力）">
                    <Upload className="w-3 h-3" />导入（合并）
                  </button>
                  <button onClick={() => void importPack('replace')} className="px-2 py-1 rounded border border-amber-200 text-amber-700 hover:bg-amber-50" title="覆盖导入：用包里的四段替换同名岗位现有内容（经验仍只追加候选；Pro 能力）">
                    覆盖导入
                  </button>
                  <span className="text-gray-400">导入经验一律为待审候选；本机生成/注入/晋升不挂闸。</span>
                </div>

                {/* zx_20261113_1 B5「像」: 第一屏画像——做过多少 / 做得怎么样 / 学到什么 / 用了多少。
                    无任务时如实写"还没有指派过任务"，不拿 0 冒充"一切正常"。 */}
                {profileError && (
                  <div className="mb-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    画像加载失败：{profileError}（岗位详情仍可编辑）
                  </div>
                )}
                {profile && (
                  <div className="mb-3 rounded-lg border bg-gray-50/70 px-3 py-2 text-sm">
                    {profile.taskTotal === 0 ? (
                      <p className="text-gray-500">还没有指派过任务——先在下方「项目启用」勾选项目，建单时选这个岗位。</p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>做过 <b>{profile.taskTotal}</b> 件</span>
                        <span>完成 {profile.taskCompleted}</span>
                        <span className={profile.taskFailed > 0 ? 'text-red-600' : ''}>失败 {profile.taskFailed}</span>
                        {profile.taskActive > 0 && <span>在办 {profile.taskActive}</span>}
                        <span>验收通过 {profile.acceptancePassed}</span>
                        <span>经验 采纳 {profile.lessons.accepted} · 待审 {profile.lessons.pending}{profile.lessons.promoted > 0 ? ` · 已晋升 ${profile.lessons.promoted}` : ''}</span>
                        <span className="text-gray-600">
                          注入 {profile.injections.rows} 条 · {profile.injections.estTokens} token
                          {profile.injections.rows > 0 ? `（完成 ${profile.injections.completed} / 失败 ${profile.injections.failed}）` : ''}
                        </span>
                        {!profile.injections.available && <span className="text-amber-700">注入账不可用：{profile.injections.reason}</span>}
                        {profile.lastActive && <span className="text-gray-400">最近活跃 {profile.lastActive}</span>}
                      </div>
                    )}
                    <p className="text-[10px] text-gray-400 mt-1">
                      口径：任务/验收来自本机任务账；注入来自 wa_context_injections（source=position）；只读派生，不另算。
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">名称 *</label>
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">分类</label>
                    <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls} placeholder="如 tech / business" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium mb-1">说明（一句：这个岗位负责什么）</label>
                    <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">规范（每行一条，最多 20 条）</label>
                    <textarea value={form.rules} onChange={(e) => setForm({ ...form, rules: e.target.value })} rows={4} className={inputCls} placeholder="先对齐验收标准再开工" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">技能（每行一条）</label>
                    <textarea value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} rows={4} className={inputCls} placeholder="任务拆解" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium mb-1">知识（每行一条；手工维护，不跨机）</label>
                    <textarea value={form.knowledge} onChange={(e) => setForm({ ...form, knowledge: e.target.value })} rows={3} className={inputCls} />
                  </div>
                </div>
                <div className="flex items-center justify-between mt-3">
                  <span className="text-[11px] text-gray-400">注入上限 1200 字；执行时只取说明 / 前 3 条规范 / 前 3 条技能 / 前 3 条知识 / 最近 3 条已采纳经验。</span>
                  <button onClick={() => void save()} disabled={saving} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"><Save className="w-3.5 h-3.5" />{saving ? '保存中…' : '保存'}</button>
                </div>
              </div>

              <div className="bg-white rounded-lg border p-4">
                <h4 className="text-sm font-semibold mb-2">项目启用</h4>
                {detail.projects.length === 0 ? (
                  <p className="text-xs text-gray-400">还没有未归档项目。岗位只在已启用的项目里可被指派。</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.projects.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={p.enabled} onChange={(e) => void toggleProject(p.id, e.target.checked)} />
                        <span className="truncate">{p.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white rounded-lg border p-4">
                <h4 className="text-sm font-semibold mb-2">经验（复盘可迁移教训优先；采纳后注入，晋升后并入岗位四段）</h4>
                {detail.lessons.length === 0 ? (
                  <p className="text-xs text-gray-400">暂无经验候选——指派岗位的任务完成且验收通过后，这里会出现待审候选。</p>
                ) : (
                  <div className="space-y-2">
                    {detail.lessons.map((l) => (
                      <div key={l.id} className={`rounded-lg border p-3 ${l.status === 'pending' ? 'border-amber-200 bg-amber-50' : 'bg-gray-50'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            {editingLesson?.id === l.id ? (
                              <div className="space-y-1">
                                <textarea value={editingLesson.content} onChange={(e) => setEditingLesson({ ...editingLesson, content: e.target.value })} rows={4} className="w-full px-2 py-1 border rounded text-sm" />
                                <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                  <span className={editingLesson.content.trim().length > 200 ? 'text-amber-600' : ''}>{editingLesson.content.trim().length} 字{editingLesson.content.trim().length > 200 ? '（晋升需 ≤200）' : ''}</span>
                                  <button onClick={() => void saveLessonEdit()} className="px-2 py-0.5 bg-blue-600 text-white rounded text-xs">保存</button>
                                  <button onClick={() => setEditingLesson(null)} className="px-2 py-0.5 border rounded text-xs">取消</button>
                                </div>
                              </div>
                            ) : (
                              <p className="text-sm whitespace-pre-wrap">{l.content}</p>
                            )}
                            {!editingLesson && l.content.trim().length > 200 && !l.promotedTo && (
                              <p className="text-[11px] text-amber-600 mt-1">当前 {l.content.trim().length} 字，超过晋升单条上限 200 字——先「编辑」缩短。</p>
                            )}
                            <div className="flex items-center gap-1.5 flex-wrap mt-1">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${l.source === 'retrospective' ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-500'}`}>
                                {(POSITION_LESSON_SOURCE_LABEL as Record<string, string>)[l.source] ?? l.source}
                              </span>
                              {!l.reusable && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700" title="项目摘要或复盘判定不可复用——只留档，不注入、不可晋升">不可迁移</span>}
                              {l.origin === 'imported' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">导入候选</span>}
                              <span className="text-[11px] text-gray-500">
                                来源：{l.taskTitle || l.taskId} · {l.projectName || l.projectId} · {l.createdAt}
                              </span>
                            </div>
                          </div>
                          {l.status === 'pending' ? (
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <button onClick={() => setEditingLesson({ id: l.id, content: l.content })} className="px-2 py-1 border rounded text-xs hover:bg-gray-100">编辑</button>
                              <button onClick={() => void decideLesson(l.id, 'accepted')} className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"><Check className="w-3 h-3" />采纳</button>
                              <button onClick={() => void decideLesson(l.id, 'rejected')} className="px-2 py-1 border rounded text-xs hover:bg-gray-100"><X className="w-3 h-3" /></button>
                            </div>
                          ) : l.status === 'accepted' ? (
                            l.promotedTo ? (
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                                  已晋升：{(POSITION_PROMOTE_TARGET_LABEL as Record<string, string>)[l.promotedTo] ?? l.promotedTo}
                                </span>
                                <button onClick={() => void unpromoteLesson(l.id)} className="px-2 py-1 border rounded text-xs hover:bg-gray-100">撤回晋升</button>
                              </div>
                            ) : l.reusable ? (
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button onClick={() => setEditingLesson({ id: l.id, content: l.content })} className="px-2 py-1 border rounded text-xs hover:bg-gray-100">编辑</button>
                                <span className="text-[10px] text-gray-400">晋升到</span>
                                {(['rules', 'skills', 'knowledge'] as const).map((t) => (
                                  <button key={t} onClick={() => void promoteLesson(l.id, t)} className="px-1.5 py-1 border rounded text-[10px] text-gray-600 hover:bg-gray-100">
                                    {POSITION_PROMOTE_TARGET_LABEL[t]}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 flex-shrink-0">已采纳·不可迁移</span>
                            )
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 flex-shrink-0">已拒绝</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-lg p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">新建岗位</h3>
              <button onClick={() => setShowCreate(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div><label className="block text-xs font-medium mb-1">名称 *</label><input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} className={inputCls} placeholder="如 数据分析师" /></div>
              <div><label className="block text-xs font-medium mb-1">分类</label><input value={createForm.category} onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })} className={inputCls} placeholder="custom" /></div>
              <div><label className="block text-xs font-medium mb-1">说明</label><textarea value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} rows={2} className={inputCls} /></div>
              <div><label className="block text-xs font-medium mb-1">规范（每行一条）</label><textarea value={createForm.rules} onChange={(e) => setCreateForm({ ...createForm, rules: e.target.value })} rows={3} className={inputCls} /></div>
              <div><label className="block text-xs font-medium mb-1">技能（每行一条）</label><textarea value={createForm.skills} onChange={(e) => setCreateForm({ ...createForm, skills: e.target.value })} rows={3} className={inputCls} /></div>
              <div><label className="block text-xs font-medium mb-1">知识（每行一条）</label><textarea value={createForm.knowledge} onChange={(e) => setCreateForm({ ...createForm, knowledge: e.target.value })} rows={2} className={inputCls} /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
              <button onClick={() => void create()} disabled={saving || !createForm.name.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{saving ? '创建中…' : '创建'}</button>
            </div>
          </div>
        </div>
      )}

      {showDispatch && detail && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowDispatch(false)}>
          <div className="bg-white rounded-xl shadow-lg p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">派活</h3>
              <button onClick={() => setShowDispatch(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-gray-500 mb-3">岗位固定为「{detail.position.name}」——建成普通任务，复用既有拆解 / 调度 / 验收流程；执行时注入该岗位的说明 / 规范 / 技能 / 知识与已采纳经验（≤1200 字）。</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1">项目 *</label>
                <select value={dispatchForm.projectId} onChange={(e) => setDispatchForm({ ...dispatchForm, projectId: e.target.value })} className={inputCls}>
                  {dispatchProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div><label className="block text-xs font-medium mb-1">标题 *</label><input value={dispatchForm.title} onChange={(e) => setDispatchForm({ ...dispatchForm, title: e.target.value })} className={inputCls} placeholder="要做的事" /></div>
              <div><label className="block text-xs font-medium mb-1">描述</label><textarea value={dispatchForm.description} onChange={(e) => setDispatchForm({ ...dispatchForm, description: e.target.value })} rows={3} className={inputCls} placeholder="背景、范围、约束" /></div>
              <div><label className="block text-xs font-medium mb-1">验收标准</label><textarea value={dispatchForm.acceptance} onChange={(e) => setDispatchForm({ ...dispatchForm, acceptance: e.target.value })} rows={3} className={inputCls} placeholder="可核对的一条条判据" /></div>
            </div>
            {error && <p className="text-red-500 text-xs mt-3">错误：{error}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowDispatch(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
              <button onClick={() => void submitDispatch()} disabled={dispatching || !dispatchForm.title.trim() || !dispatchForm.projectId} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700 disabled:opacity-50">{dispatching ? '创建中…' : '创建并打开'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
