import { useState, useEffect } from 'react';
import { templates as tplIpc, type AutoTemplateGateReport } from '../lib/ipc';
import { LayoutTemplate, RefreshCw, Plus, Trash2, Pencil, X, Check, Play, ChevronDown, ChevronRight, Activity } from 'lucide-react';
import { formatDbTime } from '../lib/deliverable-view';

interface Template {
  id: string; name: string; category: string; description: string;
  subtasks: Array<{ title: string; description: string; acceptance_criteria: string }>;
  keywords: string[]; status: string; priority: number; source: string;
  match_count: number; success_rate: number | null; created_at?: string; updated_at?: string;
}

// M10 (zx_20261002): 台账文案——把"卡在哪一级/哪条门"翻译成用户看得懂的话
const FUNNEL_STEPS: Array<[keyof AutoTemplateGateReport['funnel'], string]> = [
  ['parentTasks', '父任务'], ['autoDecomposed', '其中自动拆解'], ['terminal', '其中已终态'],
  ['candidates', '候选（非内置）'], ['groups', '分类组'],
];
const BLOCK_LABEL: Record<NonNullable<AutoTemplateGateReport['blockedAt']>, string> = {
  'parent-tasks': '尚无父任务',
  'auto-decomposed': '尚无自动拆解任务（M5/M6 的拆解产出尚未积累）',
  'terminal': '自动拆解任务尚无终态（completed / failed）',
  'candidates': '候选任务全被内置模板排除',
  'groups': '候选无法按 archetype 分类（context_json 缺 archetype）',
};
const VERDICT_LABEL: Record<string, string> = {
  passed: '过门', 'no-archetype': '无分类', 'insufficient-samples': '样本 < 3',
  'low-success-rate': '成功率 < 50%', 'duplicate-exists': '已有自动模板', 'no-representative': '无代表任务',
  'too-few-children': '子任务 < 2', 'no-keywords': '关键词为空',
};

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // M10: 自动模板质量门台账（与模板列表分开取——台账读失败不该把列表也吞掉）
  const [gate, setGate] = useState<AutoTemplateGateReport | null>(null);
  const [gateError, setGateError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<Template | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // 匹配测试（zx_20260924: 标题/描述分栏——两者的命中门槛不同（标题 ≥2、描述 ≥3），
  //   合成一栏就没法与 task:create 同口径）
  const [testTitle, setTestTitle] = useState('');
  const [testDesc, setTestDesc] = useState('');
  const [testResult, setTestResult] = useState<{ id: string; name: string; category: string; priority: number; success_rate: number | null; hitKeywords: string[]; method?: string; similarity?: number | null; field?: 'title' | 'description' | ''; subtaskCount: number } | null>(null);
  const [testSkip, setTestSkip] = useState<'explicit_subtasks' | 'planning_intent' | 'repair_intent' | null>(null);
  // zx_20261028_2 M4: 语义门槛由主进程回传（`semanticMinSimilarity`），界面不再手抄数字（原写死 0.4）
  const [testMinSim, setTestMinSim] = useState<number | null>(null);
  const [testRan, setTestRan] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true); setError(''); setGateError('');
    try { const d = await tplIpc.list(); setTemplates(d as unknown as Template[]); }
    catch (e) { setError((e as Error).message); }
    // M10: 台账为**只读诊断**，单独取；失败如实显示在台账栏，不连累模板列表
    try { setGate(await tplIpc.autoGate()); }
    catch (e) { setGate(null); setGateError((e as Error).message); }
    setLoading(false);
  }
  async function handleDelete(t: Template) {
    if (t.source === 'system') { alert('系统内置模板不可删除，可编辑或禁用'); return; }
    if (!confirm(`确定删除模板「${t.name}」？`)) return;
    try { await tplIpc.delete(t.id); load(); } catch (e) { alert((e as Error).message); }
  }
  async function handleToggle(t: Template) {
    try { await tplIpc.update(t.id, { status: t.status === 'active' ? 'disabled' : 'active' }); load(); }
    catch (e) { alert((e as Error).message); }
  }
  async function handleTest() {
    if (!testTitle.trim() && !testDesc.trim()) return;
    setTesting(true); setTestResult(null); setTestSkip(null); setTestRan(false);
    try { const r = await tplIpc.test(testTitle, testDesc); setTestResult(r.matched); setTestSkip(r.skip); setTestMinSim(r.semanticMinSimilarity); setTestRan(true); }
    catch (e) { alert((e as Error).message); }
    setTesting(false);
  }

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">任务模板</h2>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setEditItem(null); setShowForm(true); }} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5" />新建模板</button>
        </div>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">错误: {error}</p>}

      {/* 匹配测试 */}
      <div className="bg-white rounded-lg border p-4 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Play className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-gray-700">匹配测试（与任务创建同口径：守卫看标题+描述 → 关键词优先 → 语义兜底）</h3>
        </div>
        <div className="space-y-2">
          <input value={testTitle} onChange={e => setTestTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleTest(); }}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="任务标题（关键词命中 ≥2 参与匹配）..." />
          <textarea value={testDesc} onChange={e => setTestDesc(e.target.value)} rows={2}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y" placeholder="任务描述（可选；关键词命中 ≥3 参与匹配）..." />
          <div className="flex justify-end">
            <button onClick={handleTest} disabled={testing || (!testTitle.trim() && !testDesc.trim())} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{testing ? '测试中...' : '测试'}</button>
          </div>
        </div>
        {/* zx_20260924: 结果分三态——**会拆**（走的就是 task:create 那条路）/ **本可命中但守卫不拆** / 未命中。
            后两态此前一个字都不说（只知道"没命中"），用户没法据此改输入。 */}
        {testRan && (testSkip ? (
          <p className="mt-2 text-sm">
            <span className="text-amber-600 font-medium">创建时不会自动拆解：{testSkip === 'explicit_subtasks'
              ? '任务已含显式子任务（子任务X / 报告X）'
              : testSkip === 'repair_intent'
                ? '判定为修复/排查意图（标题或描述含"修复/排查/定位/报错…"），交由引擎按诊断步骤拆解'
                : '判定为规划/优化意图（标题或描述含"规划/方案/排期/优化/设计…"），交由 AI 自主规划'}</span>
            {testResult && <span className="text-gray-400 ml-2">（关键词本可命中模板「{testResult.name}」{testResult.hitKeywords.length > 0 ? `：${testResult.hitKeywords.join(', ')}` : ''}）</span>}
          </p>
        ) : testResult ? (
          <p className="mt-2 text-sm">
            <span className="text-green-600 font-medium">命中模板：{testResult.name}</span>
            <span className="text-gray-400 ml-2">分类 {testResult.category} · 优先级 {testResult.priority}{testResult.success_rate != null ? ` · 成功率 ${(testResult.success_rate * 100).toFixed(0)}%` : ''}</span>
            {/* B2: 匹配可解释性——展示匹配方式与命中依据 */}
            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${testResult.method === 'semantic' ? 'bg-indigo-50 text-indigo-600' : 'bg-blue-50 text-blue-600'}`}>{testResult.method === 'semantic' ? `语义匹配${testResult.similarity != null ? ` 相似度 ${testResult.similarity}` : ''}` : '关键词匹配'}</span>
            {testResult.field ? <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">命中{testResult.field === 'title' ? '标题' : '描述'}</span> : null}
            {testResult.hitKeywords.length > 0 && <span className="text-gray-500 ml-2">命中关键词: {testResult.hitKeywords.join(', ')}</span>}
            {testResult.hitKeywords.length === 0 && testResult.method === 'semantic' && <span className="text-gray-400 ml-2">（无关键词命中，靠语义兜底命中）</span>}
            {testResult.subtaskCount < 2 && <span className="text-amber-600 ml-2">该模板只声明 {testResult.subtaskCount} 个子任务（不足 2 个），创建时**不会**拆解</span>}
          </p>
        ) : (
          <p className="mt-2 text-sm text-gray-500">未命中任何模板（关键词未达门槛：标题 ≥2 个或描述 ≥3 个；语义兜底亦无相似度 ≥ {testMinSim ?? '—'} 的模板）——创建时按单任务执行，不拆解。</p>
        ))}
      </div>

      {/* M10: 自动模板台账——「成功拆解 → 自动模板」为何产出 0、卡在哪一级，直接上屏 */}
      <div className="bg-white rounded-lg border p-4 mb-6">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <Activity className="w-4 h-4 text-purple-500" />
          <h3 className="text-sm font-semibold text-gray-700">自动模板台账（成功拆解 → 自动模板）</h3>
          <span className="text-[10px] text-gray-400">同一类任务成功拆解 ≥3 次且成功率 ≥50% 才自动生成（防噪声模板；门槛未放宽）</span>
        </div>
        {gateError ? <p className="text-xs text-red-500">台账读取失败：{gateError}</p> : gate && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              {FUNNEL_STEPS.map(([k, label], i) => (
                <span key={k} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-gray-300">→</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${gate.funnel[k] === 0 ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-600'}`}>
                    {label} <b>{gate.funnel[k]}</b>
                  </span>
                </span>
              ))}
            </div>
            {gate.blockedAt && (
              <p className="text-xs text-amber-600">当前卡在：<b>{BLOCK_LABEL[gate.blockedAt]}</b></p>
            )}
            {gate.gates.length > 0 && (
              <ul className="text-xs text-gray-600 space-y-0.5">
                {gate.gates.map((g, i) => (
                  <li key={i}>
                    <span className="text-gray-500">{g.archetype ?? '(无分类)'}</span>
                    {' '}样本 {g.total} · 成功 {g.success}（{(g.rate * 100).toFixed(0)}%）
                    {' → '}<span className={g.verdict === 'passed' ? 'text-green-600' : 'text-amber-600'}>{VERDICT_LABEL[g.verdict] ?? g.verdict}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {templates.length === 0 ? <p className="text-gray-400 text-center py-12">暂无模板</p> : (
        <div className="space-y-2">
          {templates.map(t => (
            <div key={t.id} className="bg-white rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <LayoutTemplate className="w-5 h-5 text-blue-500 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">{t.name}</h3>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{t.status === 'active' ? '启用' : '禁用'}</span>
                      {t.source === 'system' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-600">内置</span>}
                      {t.source === 'user' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">自定义</span>}
                    </div>
                    <p className="text-xs text-gray-400 truncate">{t.description || '—'}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{t.category || 'custom'}</span>
                      <span className="text-[10px] text-gray-400">{t.subtasks?.length || 0} 个子任务</span>
                      {/* G1 (2026-09-04_2): 再实践闭环可视化——匹配计数 + 最近复用时间 */}
                      <span className="text-[10px] text-gray-400" title={t.updated_at ? `最近复用于 ${formatDbTime(t.updated_at)}` : undefined}>匹配 {t.match_count || 0} 次{t.updated_at ? ` · 最近 ${formatDbTime(t.updated_at)}` : ''}</span>
                      <span className="text-[10px] text-gray-400">优先级 {t.priority ?? 0}</span>
                      {t.success_rate != null && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.success_rate >= 0.3 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>成功率 {(t.success_rate * 100).toFixed(0)}%</span>
                      )}
                      {t.keywords?.length > 0 && t.keywords.slice(0, 5).map(k => <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">{k}</span>)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => setPreviewId(previewId === t.id ? null : t.id)} className="p-1 hover:bg-gray-100 rounded" title="预览子任务">{previewId === t.id ? <ChevronDown className="w-3.5 h-3.5 text-gray-600" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}</button>
                  <button onClick={() => handleToggle(t)} className={`text-xs px-2 py-0.5 rounded ${t.status === 'active' ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}>{t.status === 'active' ? '禁用' : '启用'}</button>
                  <button onClick={() => { setEditItem(t); setShowForm(true); }} className="p-1 hover:bg-blue-50 rounded" title="编辑"><Pencil className="w-3.5 h-3.5 text-blue-500" /></button>
                  <button onClick={() => handleDelete(t)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                </div>
              </div>
              {previewId === t.id && (
                <ol className="mt-3 pt-3 border-t border-gray-100 space-y-1.5">
                  {t.subtasks?.map((s, i) => (
                    <li key={i} className="text-xs text-gray-600">
                      <span className="text-gray-400">{i + 1}.</span> {s.title}
                      {s.acceptance_criteria && <span className="text-gray-400"> — 验收: {s.acceptance_criteria}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}
      {showForm && <TemplateDialog template={editItem} onClose={() => { setShowForm(false); setEditItem(null); }} onSuccess={() => { load(); }} />}
    </div>
  );
}

function TemplateDialog({ template, onClose, onSuccess }: { template?: Template | null; onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState(template?.name || '');
  const [category, setCategory] = useState(template?.category || 'custom');
  const [desc, setDesc] = useState(template?.description || '');
  const [priority, setPriority] = useState(template?.priority ?? 0);
  const [keywordsStr, setKeywordsStr] = useState(() => (template?.keywords || []).join(', '));
  const [subtasksJson, setSubtasksJson] = useState(() => JSON.stringify(template?.subtasks || [], null, 2));
  const [status, setStatus] = useState(template?.status || 'active');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const isEdit = !!template;

  async function submit() {
    if (!name.trim()) { setErr('名称必填'); return; }
    let subtasks: Array<{ title: string; description: string; acceptance_criteria: string }> = [];
    try {
      const parsed = JSON.parse(subtasksJson || '[]') as Array<{ title: string; description: string; acceptance_criteria: string }>;
      subtasks = Array.isArray(parsed) ? parsed : [];
    } catch { setErr('子任务必须是合法 JSON 数组（[{title, description, acceptance_criteria}]）'); return; }
    setSaving(true); setErr('');
    try {
      const body = {
        name: name.trim(), category: category.trim() || 'custom', description: desc,
        priority: Number(priority) || 0, status,
        keywords: keywordsStr.split(',').map(k => k.trim()).filter(Boolean),
        subtasks,
      };
      if (isEdit) { await tplIpc.update(template!.id, body); }
      else { await tplIpc.create(body); }
      onSuccess(); onClose();
    } catch (e) { setErr((e as Error).message); }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{isEdit ? '编辑模板' : '新建模板'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium mb-1">名称 *</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 mcp_deploy" /></div>
            <div><label className="block text-sm font-medium mb-1">分类</label><input value={category} onChange={e => setCategory(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 deploy" /></div>
          </div>
          <div><label className="block text-sm font-medium mb-1">描述</label><textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="模板用途描述" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium mb-1">优先级（大者优先）</label><input type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
            <div><label className="block text-sm font-medium mb-1">状态</label><select value={status} onChange={e => setStatus(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white"><option value="active">启用</option><option value="disabled">禁用</option></select></div>
          </div>
          <div><label className="block text-sm font-medium mb-1">关键词（逗号分隔，命中 ≥2 参与匹配）</label><input value={keywordsStr} onChange={e => setKeywordsStr(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 mcp, 部署, 启动" /></div>
          <div>
            <label className="block text-sm font-medium mb-1">子任务（JSON 数组：title / description / acceptance_criteria）</label>
            <textarea value={subtasksJson} onChange={e => setSubtasksJson(e.target.value)} rows={8} className="w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        {err && <p className="text-red-500 text-sm mt-2">{err}</p>}
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
          <button onClick={submit} disabled={saving} className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"><Check className="w-3.5 h-3.5" />{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
