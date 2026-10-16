import { useState, useEffect, type ReactNode } from 'react';
import { ansProxy } from '../lib/ipc';
import { parseCapabilities } from '../lib/model-caps';
// zx_20261011_5: 端点增删改后作废首启缓存——否则"配好模型"后首启判据/首屏 banner 仍按旧态（缺模型）拦人/提示。
import { invalidateNeedsSetup } from '../lib/firstRun';
import { Cpu, RefreshCw, Plus, Trash2, Link, Pencil, ChevronRight, ChevronDown, Lightbulb, X, Scale } from 'lucide-react';

interface ModelStats { call_count?: number; success_rate?: number | null; avg_latency_ms?: number | null; total_cost?: number; total_tokens?: number; }
interface Model { id: string; name: string; provider_id?: string; provider_name?: string; capabilities?: string; context_window?: number; max_output_tokens?: number; input_price_per_1k?: number; output_price_per_1k?: number; enabled?: number; status?: string; description?: string; source?: string; has_endpoint?: boolean; available?: boolean; endpoint_count?: number; stats?: ModelStats; quality_score?: number | null; }
interface Provider { id: string; name: string; base_url?: string; enabled?: number; status?: string; available?: boolean; available_models?: number; stats?: ModelStats; }
interface Endpoint { id: string; url?: string; priority?: number; weight?: number; status?: string; api_key?: string; health_status?: string; last_latency_ms?: number; health_check_at?: string; }
interface EpTestResult { success: boolean; latency_ms: number; error: string | null; at: string; }
interface RecData { recommended?: { scenario: string; primary: string; fallback: string; note: string }[]; use_cases?: Record<string, unknown>[]; }

// ── 词表**单源**（zx_20260929 M6-3）────────────────────────────────────────────
// 本页此前**手抄三份**镜像（`CAPABILITIES` / `PROVIDER_CAP_HINTS` / `MODEL_NAME_HINTS`），
// 与真源 `packages/shared-types/src/models.ts` **已经互相漂开**——`deepseek-r1` 是否带
// `function-calling`、`gpt-4o` 的正则、泛化 `qwen`/`deepseek`/`llama` 规则**只有这边有**；
// 更麻烦的是真源那份当时**无任何生产读者**（只在册、不在路）：本机真库里的
// `qwen3.5:9b` / `qwen3-omni-flash` / `deepseek-v4-*` **只有这边的手抄泛化规则兜得住**。
// 故改为**直引真源**（renderer 可跨 root import 纯模块，`zx_20260916_3` E-1 已有先例），
// 三份手抄表**全部删除**，并把真源此前只被手抄表用到的 `mistral` / 泛化规则**并回真源**。
import {
  MODEL_CAPABILITY_META,
  MODEL_NAME_CAPABILITY_HINTS,
  PROVIDER_CAPABILITY_HINTS,
} from '../../../../../packages/shared-types/src/models.js';

// 展示序：core → advanced → specialized（同 `MODEL_CAPABILITY_META.category`；`sort` 稳定，
// 同类内保持真源的键序）。旧表是手排的，故本页按钮/下拉的**次序会变**——文案一字未改。
const CATEGORY_ORDER = { core: 0, advanced: 1, specialized: 2 } as const;

const CAPABILITIES = (
  Object.entries(MODEL_CAPABILITY_META) as Array<[
    string,
    { label: string; description: string; category: keyof typeof CATEGORY_ORDER },
  ]>
)
  .sort((a, b) => CATEGORY_ORDER[a[1].category] - CATEGORY_ORDER[b[1].category])
  .map(([value, m]) => ({ value, label: m.label, desc: m.description }));

// 真源 `PROVIDER_CAPABILITY_HINTS` 与本表同名同义，直接改引（旧手抄表缺 `openrouter`）。
const PROVIDER_CAP_HINTS: Record<string, string[]> = PROVIDER_CAPABILITY_HINTS;

// 真源用 `add`/`remove`，本页用 `caps`；`remove` 见下方 `suggestedOf`。
const MODEL_NAME_HINTS: { pattern: RegExp; caps: string[]; remove?: string[]; tip: string }[] =
  MODEL_NAME_CAPABILITY_HINTS.map((h) => ({ pattern: h.pattern, caps: h.add, remove: h.remove, tip: h.tip }));

// ⚠ 本表**没有**真源：它只驱动价格前缀（¥/$）的显示，属本页私有的展示映射。
const PROVIDER_CURRENCY: Record<string, string> = {
  openai: 'USD', anthropic: 'USD', google: 'USD', deepseek: 'CNY', qwen: 'CNY', zhipu: 'CNY', moonshot: 'CNY', bytedance: 'CNY', minimax: 'CNY', stepfun: 'CNY',
};

function formatContext(n: number | undefined): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
function parseContext(s: string): number {
  s = s.trim().toUpperCase();
  if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
  if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000);
  return parseInt(s) || 0;
}
/** C2: 模型可用性状态徽标——已禁用/待配置端点/可用（无端点模型默认不可用） */
function modelStatusBadge(m: Model): { label: string; cls: string } {
  if (m.enabled === 0) return { label: '已禁用', cls: 'bg-gray-100 text-gray-500' };
  if (!m.has_endpoint) return { label: '待配置端点', cls: 'bg-orange-100 text-orange-700' };
  return { label: '可用', cls: 'bg-green-100 text-green-700' };
}
/** C2: 供应商可用性状态徽标——已禁用/无可用模型/可用 */
function providerStatusBadge(p: Provider): { label: string; cls: string } {
  if (p.enabled === 0) return { label: '已禁用', cls: 'bg-gray-100 text-gray-500' };
  if (!p.available_models || p.available_models === 0) return { label: '无可用模型', cls: 'bg-orange-100 text-orange-700' };
  return { label: '可用', cls: 'bg-green-100 text-green-700' };
}
/** C1: 使用统计展示文案（无数据返回空串则 UI 不显示） */
function fmtStats(s?: ModelStats): string {
  if (!s || !(s.call_count ?? 0)) return '';
  const parts = [`${s.call_count} 次调用`];
  if (s.success_rate != null) parts.push(`成功率 ${(s.success_rate * 100).toFixed(0)}%`);
  if (s.avg_latency_ms) parts.push(`均延迟 ${s.avg_latency_ms}ms`);
  if ((s.total_cost ?? 0) > 0) parts.push(`成本 ¥${(s.total_cost || 0).toFixed(4)}`);
  if (s.total_tokens) parts.push(`${s.total_tokens >= 1000 ? (s.total_tokens / 1000).toFixed(0) + 'K' : s.total_tokens} tokens`);
  return parts.join(' · ');
}
/** C2: 模型质量分徽标（0-100 色阶；null 无使用数据不显示） */
function qualityBadge(q?: number | null): { label: string; cls: string } | null {
  if (q == null) return null;
  const cls = q >= 80 ? 'bg-green-100 text-green-700' : q >= 60 ? 'bg-emerald-50 text-emerald-700' : q >= 40 ? 'bg-amber-50 text-amber-700' : 'bg-red-100 text-red-600';
  return { label: `质量分 ${q}`, cls };
}

export default function ModelsPage() {
  const [tab, setTab] = useState<'providers' | 'models'>('providers');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editItem, setEditItem] = useState<Provider | Model | null>(null);
  const [eps, setEps] = useState<Endpoint[]>([]);
  const [epsModelId, setEpsModelId] = useState<string | null>(null);
  const [showEpForm, setShowEpForm] = useState(false);
  const [editEp, setEditEp] = useState<Endpoint | null>(null);
  const [recommended, setRecommended] = useState<RecData | null>(null);
  const [providerGuides, setProviderGuides] = useState<Record<string, Record<string, unknown>>>({});
  const [expandedGuide, setExpandedGuide] = useState<string | null>(null);
  // DataTable 排序
  const [sortBy, setSortBy] = useState<'name' | 'price' | 'context' | 'status'>('name');
  const [sortAsc, setSortAsc] = useState(true);
  // C3 (2026-09-01): 供应商/模型筛选条件（状态/供应商/能力/是否有端点，可组合）
  const [filter, setFilter] = useState<{ status: string; provider: string; cap: string; hasEp: string }>({ status: 'all', provider: '', cap: '', hasEp: 'all' });
  // C4 (2026-09-03): 模型对比——勾选 2-4 个模型并排对比（能力/上下文/价格/质量分/使用统计）
  const [compareSel, setCompareSel] = useState<string[]>([]);
  const toggleCompare = (id: string) => setCompareSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : (prev.length >= 4 ? prev : [...prev, id]));

  useEffect(() => { loadData(); }, [tab]);
  async function loadData() {
    setLoading(true); setError('');
    try {
      const [p, m] = tab === 'providers'
        ? [await ansProxy.get<Provider[]>('/api/v1/models/providers'), []]
        : [await ansProxy.get<Provider[]>('/api/v1/models/providers'), await ansProxy.get<Model[]>('/api/v1/models')];
      setProviders(p as Provider[]);
      if (tab === 'models') setModels(m as Model[]);
      try { const rm = await ansProxy.get<RecData>('/api/v1/models/recommended'); setRecommended(rm as RecData); } catch {}
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }
  async function handleDelete(type: string, id: string) { if (!confirm('确定删除？')) return; try { await ansProxy.delete(`/api/v1/${type}/${id}`); loadData(); } catch {} }
  async function handleToggleProvider(id: string, enabled: boolean) {
    try { await ansProxy.put(`/api/v1/models/providers/${id}`, { enabled: enabled ? 1 : 0 }); loadData(); } catch {}
  }
  async function handleToggleModel(id: string, enabled: boolean) {
    try { await ansProxy.put(`/api/v1/models/${id}`, { enabled: enabled ? 1 : 0 }); loadData(); } catch {}
  }
  async function loadEndpoints(modelId: string) {
    if (epsModelId === modelId) { setEpsModelId(null); setEps([]); return; }
    setEpsModelId(modelId); setEps([]);
    try { const d = await ansProxy.get<Endpoint[]>(`/api/v1/models/${modelId}/endpoints`); setEps(d as Endpoint[]); } catch {}
  }
  async function refreshEndpoints(modelId: string) {
    try { const d = await ansProxy.get<Endpoint[]>(`/api/v1/models/${modelId}/endpoints`); setEps(d as Endpoint[]); } catch {}
  }
  async function handleDeleteEp(id: string) {
    if (!confirm('确定删除此端点？')) return;
    try { await ansProxy.delete(`/api/v1/models/endpoints/${id}`); invalidateNeedsSetup(); setEps(prev => prev.filter(e => e.id !== id)); } catch {}
  }
  // C4 (2026-09-01): 端点连通性测试——POST /endpoints/:id/test，结果徽标 + 持久化 health 状态
  const [testingEp, setTestingEp] = useState<string | null>(null);
  const [epTest, setEpTest] = useState<Record<string, EpTestResult>>({});
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [modelTest, setModelTest] = useState<Record<string, EpTestResult>>({});
  async function handleTestEp(id: string, modelId?: string) {
    setTestingEp(id);
    try {
      const d = await ansProxy.post<{ id: string; success: boolean; latency_ms: number; health_status: string; health_check_at: string; error: string | null }>(`/api/v1/models/endpoints/${id}/test`, {});
      const res: EpTestResult = { success: d.success, latency_ms: d.latency_ms, error: d.error, at: d.health_check_at };
      setEpTest(prev => ({ ...prev, [id]: res }));
      if (modelId) setModelTest(prev => ({ ...prev, [modelId]: res }));
      if (epsModelId) refreshEndpoints(epsModelId);
    } catch {}
    setTestingEp(null);
  }
  async function testModel(m: Model) {
    setTestingModel(m.id);
    try {
      const d = await ansProxy.get<Endpoint[]>(`/api/v1/models/${m.id}/endpoints`);
      setEps(d as Endpoint[]);
      setEpsModelId(m.id);
      const first = (d as Endpoint[]).find(e => e.status === 'active');
      if (!first?.id) {
        setModelTest(prev => ({ ...prev, [m.id]: { success: false, latency_ms: 0, error: '无可用端点，请先配置', at: new Date().toISOString().slice(0, 19).replace('T', ' ') } }));
      } else {
        await handleTestEp(first.id, m.id);
      }
    } catch {}
    setTestingModel(null);
  }
  async function loadProviderGuide(providerId: string) {
    if (providerGuides[providerId]) return;
    try {
      const r = await ansProxy.get<Record<string, unknown>>(`/api/v1/models/providers/${providerId}/guide`);
      setProviderGuides(prev => ({ ...prev, [providerId]: r as Record<string, unknown> }));
    } catch {}
  }

  const getCurrency = (pid?: string) => {
    if (!pid) return '$';
    const p = providers.find(x => x.id === pid);
    const name = (p?.name || '').toLowerCase();
    for (const [key, cur] of Object.entries(PROVIDER_CURRENCY)) { if (name.includes(key)) return cur === 'CNY' ? '¥' : '$'; }
    return '$';
  };
  // DataTable 排序：模型列表按列排序
  const sortedModels = [...models].sort((a, b) => {
    let va = 0, vb = 0, ca = '', cb = '';
    if (sortBy === 'name') { ca = (a.description || a.name || ''); cb = (b.description || b.name || ''); }
    else if (sortBy === 'price') { va = a.input_price_per_1k ?? 0; vb = b.input_price_per_1k ?? 0; }
    else if (sortBy === 'context') { va = a.context_window ?? 0; vb = b.context_window ?? 0; }
    else { ca = String(a.status || (a.enabled ? '启用' : '禁用')); cb = String(b.status || (b.enabled ? '启用' : '禁用')); }
    const cmp = sortBy === 'name' || sortBy === 'status' ? ca.localeCompare(cb) : va - vb;
    return sortAsc ? cmp : -cmp;
  });
  const sortedProviders = [...providers].sort((a, b) => (sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)));
  // C3: 筛选匹配——模型状态语义与 modelStatusBadge 一致（已禁用优先 / 待配置端点 / 可用）
  const matchModelFilters = (m: Model) => {
    if (filter.status === 'available' && !(m.enabled !== 0 && m.has_endpoint)) return false;
    if (filter.status === 'no-endpoint' && !(m.enabled !== 0 && !m.has_endpoint)) return false;
    if (filter.status === 'disabled' && m.enabled !== 0) return false;
    if (filter.provider && m.provider_id !== filter.provider) return false;
    if (filter.cap && !parseCapabilities(m.capabilities).includes(filter.cap)) return false;
    if (filter.hasEp === 'yes' && !m.has_endpoint) return false;
    if (filter.hasEp === 'no' && m.has_endpoint) return false;
    return true;
  };
  // C3: 供应商筛选匹配——状态语义与 providerStatusBadge 一致
  const matchProviderFilters = (p: Provider) => {
    if (filter.status === 'available' && !(p.enabled !== 0 && (p.available_models ?? 0) > 0)) return false;
    if (filter.status === 'no-model' && !(p.enabled !== 0 && !(p.available_models ?? 0))) return false;
    if (filter.status === 'disabled' && p.enabled !== 0) return false;
    return true;
  };
  const filteredModels = sortedModels.filter(matchModelFilters);
  const filteredProviders = sortedProviders.filter(matchProviderFilters);
  const isFiltering = filter.status !== 'all' || filter.provider !== '' || filter.cap !== '' || filter.hasEp !== 'all';
  const resetFilter = () => setFilter({ status: 'all', provider: '', cap: '', hasEp: 'all' });

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">AI 模型管理</h2>
        <div className="flex items-center gap-2">
          {tab === 'models' && (
            <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
              <option value="name">按名称</option>
              <option value="price">按价格</option>
              <option value="context">按上下文窗口</option>
              <option value="status">按状态</option>
            </select>
          )}
          <button onClick={() => setSortAsc(!sortAsc)} className="px-2 py-1.5 border rounded-lg text-sm bg-white hover:bg-gray-50" title="切换升降序">{sortAsc ? '↑升序' : '↓降序'}</button>
          <button onClick={loadData} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => { setShowAdd(true); setEditItem(null); }} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5" />添加{tab === 'providers' ? '供应商' : '模型'}</button>
        </div>
      </div>
      <div className="flex gap-2 mb-4">
        {(['providers', 'models'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-lg text-sm font-medium ${tab === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{t === 'providers' ? '供应商' : '模型列表'}</button>
        ))}
      </div>

      {/* C3: 供应商/模型筛选栏（条件可组合） */}
      <div className="flex flex-wrap gap-2 mb-4 items-center bg-gray-50 border rounded-lg px-3 py-2">
        <select value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))} className="px-2 py-1.5 border rounded-lg text-sm bg-white" title="状态筛选">
          <option value="all">全部状态</option>
          {tab === 'models' ? (
            <>
              <option value="available">可用</option>
              <option value="no-endpoint">待配置端点</option>
              <option value="disabled">已禁用</option>
            </>
          ) : (
            <>
              <option value="available">可用</option>
              <option value="no-model">无可用模型</option>
              <option value="disabled">已禁用</option>
            </>
          )}
        </select>
        {tab === 'models' && (
          <>
            <select value={filter.provider} onChange={e => setFilter(f => ({ ...f, provider: e.target.value }))} className="px-2 py-1.5 border rounded-lg text-sm bg-white" title="按供应商筛选">
              <option value="">全部供应商</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={filter.cap} onChange={e => setFilter(f => ({ ...f, cap: e.target.value }))} className="px-2 py-1.5 border rounded-lg text-sm bg-white" title="按能力筛选">
              <option value="">全部能力</option>
              {CAPABILITIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <select value={filter.hasEp} onChange={e => setFilter(f => ({ ...f, hasEp: e.target.value }))} className="px-2 py-1.5 border rounded-lg text-sm bg-white" title="按端点筛选">
              <option value="all">全部端点</option>
              <option value="yes">有端点</option>
              <option value="no">无端点</option>
            </select>
          </>
        )}
        {isFiltering && <button onClick={resetFilter} className="text-xs px-2 py-1.5 text-blue-600 hover:bg-blue-50 rounded-lg">清除筛选</button>}
        <span className="text-xs text-gray-400 ml-auto">共 {(tab === 'models' ? filteredModels : filteredProviders).length} 个{isFiltering && `（过滤）`}</span>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">错误: {error}</p>}

      {/* 使用场景速查 */}
      {tab === 'models' && recommended?.recommended && (recommended.recommended.length > 0 || recommended.use_cases) && (
        <details className="mb-4 bg-white rounded-lg border">
          <summary className="px-4 py-2 text-sm font-medium text-gray-700 cursor-pointer hover:bg-gray-50 select-none">使用场景速查</summary>
          <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {(recommended.recommended || recommended.use_cases || []).map((uc: Record<string, unknown>, i: number) => (
              <div key={i} className="border rounded-lg p-3 text-sm">
                <p className="font-medium text-gray-800">{uc.scenario as string}</p>
                <p className="text-xs text-gray-500 mt-1">
                  <span className="text-blue-600 font-medium">首选：{uc.primary as string}</span>
                  <span className="mx-1">|</span>
                  <span className="text-gray-400">备选：{uc.fallback as string}</span>
                </p>
              </div>
            ))}
          </div>
        </details>
      )}

      {tab === 'providers' ? (
        <div className="space-y-2">
          {filteredProviders.length === 0 && <p className="text-gray-400 text-center py-8">{providers.length === 0 ? '暂无供应商' : '无匹配供应商'}</p>}
          {filteredProviders.map(p => (
            <div key={p.id} className="bg-white rounded-lg border p-4 flex items-center justify-between">
              <div>
                <h3 className="font-medium">{p.name}</h3>
                <p className="text-xs text-gray-400 font-mono mt-0.5">{p.base_url || '—'}</p>
                {fmtStats(p.stats) ? <p className="text-[11px] text-gray-500 mt-0.5" title="基于该供应商全部模型的真实使用日志">{fmtStats(p.stats)}</p> : null}
              </div>
              <div className="flex items-center gap-2">
                {(() => { const b = providerStatusBadge(p); return <span className={`text-xs px-2 py-0.5 rounded-full ${b.cls}`}>{b.label}</span>; })()}
                <span className="text-xs text-gray-400" title="可用模型数">{p.available_models ?? 0} 可用</span>
                <button onClick={() => handleToggleProvider(p.id, p.enabled !== 1)} className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200">{p.enabled === 1 ? '禁用' : '启用'}</button>
                <button onClick={() => { setEditItem(p); setShowAdd(true); }} className="p-1 hover:bg-blue-50 rounded" title="编辑"><Pencil className="w-3.5 h-3.5 text-blue-500" /></button>
                <button onClick={() => handleDelete('models/providers', p.id)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {/* C4: 模型对比表（勾选 ≥2 个模型并排对比能力/上下文/价格/质量分/使用统计） */}
          {compareSel.length >= 2 && (() => {
            const sel = models.filter(x => compareSel.includes(x.id));
            if (sel.length < 2) return null;
            const row = (label: string, render: (m: Model) => ReactNode) => (
              <div className="grid py-1.5 border-b border-gray-100 items-start gap-2" style={{ gridTemplateColumns: `110px repeat(${sel.length}, 1fr)` }}>
                <span className="text-[11px] text-gray-400 font-medium pt-0.5">{label}</span>
                {sel.map(m => <div key={m.id} className="text-xs break-words min-w-0">{render(m)}</div>)}
              </div>
            );
            return (
              <div className="bg-white rounded-lg border border-blue-300 p-3 overflow-x-auto">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-gray-700 flex items-center gap-1"><Scale className="w-4 h-4 text-blue-500" />模型对比（{sel.length} 个）</p>
                  <button onClick={() => setCompareSel([])} className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-0.5"><X className="w-3 h-3" />清除对比</button>
                </div>
                {row('模型', m => <span className="font-medium">{m.description || m.name}</span>)}
                {row('供应商', m => m.provider_name || m.provider_id || '—')}
                {row('状态', m => { const b = modelStatusBadge(m); return <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${b.cls}`}>{b.label}</span>; })}
                {row('能力', m => { const c = parseCapabilities(m.capabilities); return c.length > 0 ? c.join(', ') : '—'; })}
                {row('上下文', m => formatContext(m.context_window))}
                {row('价格/1K', m => `${getCurrency(m.provider_id)}${m.input_price_per_1k || '—'} / ${getCurrency(m.provider_id)}${m.output_price_per_1k || '—'}`)}
                {row('质量分', m => m.quality_score != null ? String(m.quality_score) : '—')}
                {row('使用统计', m => fmtStats(m.stats) || '暂无数据')}
              </div>
            );
          })()}
          {filteredModels.length === 0 && <p className="text-gray-400 text-center py-8">{models.length === 0 ? '暂无模型' : '无匹配模型'}</p>}
          {filteredModels.map(m => {
            const caps = parseCapabilities(m.capabilities);
            const isExpanded = epsModelId === m.id;
            const isRecommended = m.source === 'system';
            const guide = providerGuides[m.provider_id || ''];
            const isGuideExpanded = expandedGuide === m.id;
            return (
              <div key={m.id} className={`bg-white rounded-lg border p-4 ${isRecommended ? 'bg-blue-50/50' : ''} ${compareSel.includes(m.id) ? 'ring-2 ring-blue-400' : ''}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1">
                    <button onClick={() => loadEndpoints(m.id)} className="hover:text-blue-600"><Cpu className="w-5 h-5 text-blue-500" /></button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium">{m.description || m.name}</h3>
                        {isRecommended && <span className="text-[10px] px-1.5 py-0.5 bg-blue-500 text-white rounded-full">推荐</span>}
                        {/* C5: 端点数量角标 */}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${(m.endpoint_count ?? 0) > 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-400'}`} title="端点数量">{m.endpoint_count ?? 0} 端点</span>
                      </div>
                      <p className="text-xs text-gray-400">{m.provider_name || m.provider_id || '—'} · {caps.length > 0 ? caps.map(c => <span key={c} className="inline-block text-[10px] px-1 py-0.5 bg-gray-200 rounded mr-0.5">{c}</span>) : '—'} · {formatContext(m.context_window)}</p>
                      {/* C1/C2: 使用统计 + 质量分（源自真实 quality_logs/billing_records 聚合） */}
                      <div className="flex items-center gap-2 flex-wrap mt-1">
                        {(() => { const q = qualityBadge(m.quality_score); return q ? <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${q.cls}`} title="综合成功率/延迟/token效率的质量分">{q.label}</span> : null; })()}
                        {fmtStats(m.stats) ? <span className="text-[11px] text-gray-500" title="基于实际使用日志的统计">{fmtStats(m.stats)}</span> : <span className="text-[11px] text-gray-300">暂无使用数据</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <p className="text-xs text-gray-500">{getCurrency(m.provider_id)}{m.input_price_per_1k || '—'} / {getCurrency(m.provider_id)}{m.output_price_per_1k || '—'} /1K</p>
                    <button onClick={() => loadEndpoints(m.id)} className="p-1 hover:bg-blue-50 rounded" title="端点">{isExpanded ? <ChevronDown className="w-4 h-4 text-blue-500" /> : <ChevronRight className="w-4 h-4 text-blue-500" />}</button>
                    {(() => { const b = modelStatusBadge(m); return <span className={`text-xs px-2 py-0.5 rounded-full ${b.cls}`}>{b.label}</span>; })()}
                    {modelTest[m.id] && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${modelTest[m.id].success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`} title={`${modelTest[m.id].error || ''} @ ${modelTest[m.id].at || ''}`}>
                        {modelTest[m.id].success ? `✓ ${modelTest[m.id].latency_ms}ms` : '✗ 不可用'}
                      </span>
                    )}
                    <button onClick={() => toggleCompare(m.id)} className={`text-xs px-2 py-0.5 rounded flex items-center gap-1 ${compareSel.includes(m.id) ? 'bg-blue-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`} title={compareSel.includes(m.id) ? '取消对比' : '加入对比（最多 4 个）'}><Scale className="w-3 h-3" />{compareSel.includes(m.id) ? '已选' : '对比'}</button>
                    <button onClick={() => testModel(m)} disabled={testingModel === m.id} className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-50" title="测试首选端点连通性">{testingModel === m.id ? '测试中...' : '测试'}</button>
                    <button onClick={() => handleToggleModel(m.id, m.enabled !== 1)} className="text-xs px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200">{m.enabled === 1 ? '禁用' : '启用'}</button>
                    <button onClick={() => { setEditItem(m); setShowAdd(true); }} className="p-1 hover:bg-blue-50 rounded" title="编辑"><Pencil className="w-3.5 h-3.5 text-blue-500" /></button>
                    <button onClick={() => handleDelete('models', m.id)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                  </div>
                </div>
                {/* 端点列表 */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-gray-400">端点 ({eps.length}){(() => { const hs = eps.filter(e => e.health_status === 'ok').length; const hf = eps.filter(e => e.health_status === 'fail').length; if (hs + hf === 0) return null; return <span className="ml-2 font-medium"><span className="text-emerald-600">健康 {hs}</span><span className={hf > 0 ? 'text-red-500 ml-1' : 'text-gray-400 ml-1'}>{hf > 0 ? `异常 ${hf}` : ''}</span></span>; })()}</p>
                      <button onClick={() => { setShowEpForm(true); setEditEp(null); }} className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700"><Plus className="w-3 h-3 inline" /> 添加端点</button>
                    </div>
                    {eps.length === 0 ? (
                      <div className="text-xs text-orange-500 flex items-center gap-2 flex-wrap">
                        待配置端点
                        {isRecommended && (
                          <button className="text-blue-500 hover:text-blue-700 underline" onClick={(e) => {
                            e.stopPropagation();
                            if (isGuideExpanded) { setExpandedGuide(null); return; }
                            setExpandedGuide(m.id);
                            loadProviderGuide(m.provider_id || '');
                          }}>如何获取API Key?</button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {eps.map(e => (
                          <div key={e.id} className="flex items-center justify-between text-xs py-1.5 px-2 bg-gray-50 rounded">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span className="font-mono text-gray-500 truncate">{e.url || '—'}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] ${e.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{e.status || 'active'}</span>
                              {e.health_status && (
                                <span className={`px-1.5 py-0.5 rounded text-[10px] ${e.health_status === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
                                  {e.health_status === 'ok' ? `健康 ${e.last_latency_ms ?? '—'}ms` : '异常'}
                                </span>
                              )}
                              {e.health_check_at && <span className="text-gray-400 flex-shrink-0" title="上次检测">@ {e.health_check_at}</span>}
                            </div>
                            {epTest[e.id] && (
                              <span className={`flex-shrink-0 mx-1 ${epTest[e.id].success ? 'text-green-600' : 'text-red-500'}`}>
                                {epTest[e.id].success ? `✓ ${epTest[e.id].latency_ms}ms` : `✗ ${epTest[e.id].error}`}
                              </span>
                            )}
                            <button onClick={() => handleTestEp(e.id!, epsModelId ?? undefined)} disabled={testingEp === e.id} className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-50 flex-shrink-0">{testingEp === e.id ? '测试中...' : '测试'}</button>
                            <span className="text-gray-400 mx-2 flex-shrink-0">P{e.priority ?? 0} W{e.weight ?? 1}</span>
                            <button onClick={() => { setEditEp(e); setShowEpForm(true); }} className="p-0.5 hover:bg-blue-50 rounded"><Pencil className="w-3 h-3 text-blue-500" /></button>
                            <button onClick={() => handleDeleteEp(e.id!)} className="p-0.5 hover:bg-red-50 rounded"><Trash2 className="w-3 h-3 text-red-400" /></button>
                          </div>
                        ))}
                      </div>
                    )}
                    {isGuideExpanded && guide && (
                      (() => {
                        const apiGuide = (guide as Record<string, unknown>).api_key_guide as Record<string, unknown> | undefined;
                        const steps = apiGuide?.steps as string[] | undefined;
                        const docsUrl = apiGuide?.docs_url as string | undefined;
                        return (
                          <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded text-xs">
                            <p className="font-medium text-blue-800 mb-1">{(apiGuide?.title as string) || 'API Key获取指引'}</p>
                            {steps && <ol className="list-decimal list-inside space-y-0.5 text-gray-600">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
                            {docsUrl && <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline mt-1 inline-block">官方文档 →</a>}
                          </div>
                        );
                      })()
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showAdd && (tab === 'providers' ? (
        <ProviderDialog provider={editItem as Provider | undefined} onClose={() => { setShowAdd(false); setEditItem(null); }} onSuccess={loadData} />
      ) : (
        <ModelDialog model={editItem as Model | undefined} providers={providers} onClose={() => { setShowAdd(false); setEditItem(null); }} onSuccess={loadData} />
      ))}
      {showEpForm && epsModelId && (
        <EndpointDialog modelId={epsModelId} endpoint={editEp} providerUrl={providers.find(p => p.id === models.find(m => m.id === epsModelId)?.provider_id)?.base_url} onClose={() => { setShowEpForm(false); setEditEp(null); }} onSuccess={() => { setShowEpForm(false); setEditEp(null); setEps([]); loadEndpoints(epsModelId); }} />
      )}
    </div>
  );
}

function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ProviderDialog({ provider, onClose, onSuccess }: { provider?: Provider; onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState(provider?.name || '');
  const [baseUrl, setBaseUrl] = useState(provider?.base_url || '');
  const [enabled, setEnabled] = useState(provider?.enabled !== 0); // C5: 启用/禁用开关（创建默认启用）
  const [saving, setSaving] = useState(false);
  const isEdit = !!provider;

  async function submit() {
    if (!name) return;
    setSaving(true);
    try {
      if (isEdit) {
        await ansProxy.put(`/api/v1/models/providers/${provider!.id}`, { name, base_url: baseUrl || undefined, enabled: enabled ? 1 : 0 });
      } else {
        await ansProxy.post('/api/v1/models/providers', { name, base_url: baseUrl || undefined });
      }
      onSuccess(); onClose();
    } catch {}
    setSaving(false);
  }

  return (
    <Modal onClose={onClose} title={isEdit ? '编辑供应商' : '添加供应商'}>
      <div className="space-y-3">
        <div><label className="block text-sm font-medium mb-1">名称 *</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 openai" /></div>
        <div><label className="block text-sm font-medium mb-1">Base URL</label><input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="https://api.openai.com" /></div>
        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="w-4 h-4 accent-blue-600" />
            启用（关闭后该供应商模型不参与匹配）
          </label>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
        <button onClick={submit} disabled={!name || saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
      </div>
    </Modal>
  );
}

function ModelDialog({ model, providers, onClose, onSuccess }: { model?: Model; providers: Provider[]; onClose: () => void; onSuccess: () => void }) {
  const [pid, setPid] = useState(model?.provider_id || '');
  const [name, setName] = useState(model?.name || '');
  const [desc, setDesc] = useState(model?.description || '');
  const [caps, setCaps] = useState<string[]>(parseCapabilities(model?.capabilities));
  const [context, setContext] = useState(formatContext(model?.context_window || 128000));
  const [maxTokens, setMaxTokens] = useState(formatContext(model?.max_output_tokens || 4096));
  const [inp, setInp] = useState(String(model?.input_price_per_1k ?? '0.035'));
  const [out, setOut] = useState(String(model?.output_price_per_1k ?? '0.105'));
  const [enabled, setEnabled] = useState(model?.enabled !== 0); // C5: 启用/禁用开关（创建默认启用）
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const isEdit = !!model;

  const selProviderName = providers.find(p => p.id === pid)?.name || '';
  const providerHint = Object.entries(PROVIDER_CAP_HINTS).find(([k]) => selProviderName.toLowerCase().includes(k))?.[1] || ['chat', 'function-calling', 'streaming'];
  const modelHint = MODEL_NAME_HINTS.find(h => h.pattern.test(name));

  // zx_20260929 M6-3：真源那套规则是 `add` / `remove` 两半——只读 `add` 会把 `remove` 变成死字段，
  //   而 `remove` 正是"这个名字**不是**什么"的那一半（如 `deepseek-r1` 不 `function-calling`）。
  //   故 `remove` 优先于 `add`、也优先于供应商的泛化建议（模型名的裁定比供应商宽泛建议更具体）。
  function suggestedOf(val: string): boolean {
    if (modelHint) {
      if ((modelHint.remove ?? []).includes(val)) return false;
      if (modelHint.caps.includes(val)) return true;
    }
    return providerHint.includes(val);
  }

  function toggleCap(val: string) {
    if (caps.includes(val)) setCaps(caps.filter(c => c !== val));
    else setCaps([...caps, val]);
  }

  async function submit() {
    if (!pid || !name) return;
    // zx_20260930 M15-⑦: ANS 侧 `capabilities` 现为**非空**受限集（EMPTY 会 400）。
    //   以前这里 `catch {}` 把拒绝**吞掉** ⇒ 取消勾选全部能力后点保存，界面毫无反应（既没保存也没报错）。
    if (caps.length === 0) { setErr('至少要选一项能力——"能力为空"的模型无法参与匹配。'); return; }
    setSaving(true); setErr('');
    try {
      const body: Record<string, unknown> = { name, provider_id: pid, description: desc, capabilities: caps, context_window: parseContext(context), max_output_tokens: parseContext(maxTokens), input_price_per_1k: Number(inp), output_price_per_1k: Number(out) };
      if (isEdit) body.enabled = enabled ? 1 : 0;
      if (isEdit) {
        await ansProxy.put(`/api/v1/models/${model!.id}`, body);
      } else {
        await ansProxy.post('/api/v1/models', body);
      }
      onSuccess(); onClose();
    } catch (e) { setErr((e as Error).message); } // 不再静默：失败要说出来（ANS 的拒绝因在 message 里）
    setSaving(false);
  }

  return (
    <Modal onClose={onClose} title={isEdit ? '编辑模型' : '添加模型'}>
      <div className="space-y-3">
        <div><label className="block text-sm font-medium mb-1">供应商 *</label>
          <select value={pid} onChange={e => setPid(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
            <option value="">选择供应商...</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div><label className="block text-sm font-medium mb-1">模型名称 *</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 gpt-4o" /></div>
        <div><label className="block text-sm font-medium mb-1">描述</label><input value={desc} onChange={e => setDesc(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="模型说明" /></div>
        <div>
          <label className="block text-sm font-medium mb-1">能力</label>
          <div className="flex flex-wrap gap-1">
            {CAPABILITIES.map(c => {
              const suggested = suggestedOf(c.value);
              const selected = caps.includes(c.value);
              return (
                <button key={c.value} type="button" onClick={() => toggleCap(c.value)} title={c.desc}
                  className={`px-2 py-0.5 rounded text-xs border ${selected ? 'bg-blue-100 border-blue-300 text-blue-800 font-medium' : suggested ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-white border-gray-200 text-gray-400 hover:border-gray-300'}`}>
                  {c.label}{suggested && !selected ? ' *' : ''}
                </button>
              );
            })}
          </div>
          {modelHint && <p className="text-xs mt-1 flex items-center gap-1 text-amber-700 bg-amber-50 px-2 py-1 rounded"><Lightbulb className="w-3 h-3" />{modelHint.tip}（*建议能力）</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium mb-1">上下文窗口</label><input value={context} onChange={e => setContext(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="128K" /></div>
          <div><label className="block text-sm font-medium mb-1">最大输出tokens</label><input value={maxTokens} onChange={e => setMaxTokens(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="4K" /></div>
          <div><label className="block text-sm font-medium mb-1">输入价格/1K tokens</label><input type="number" step="0.0001" value={inp} onChange={e => setInp(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="0.0050" /></div>
          <div><label className="block text-sm font-medium mb-1">输出价格/1K tokens</label><input type="number" step="0.0001" value={out} onChange={e => setOut(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="0.0150" /></div>
        </div>
        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="w-4 h-4 accent-blue-600" />
            启用（关闭后该模型不参与匹配）
          </label>
        )}
      </div>
      {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1 mt-3 whitespace-pre-wrap break-words">{err}</p>}
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
        <button onClick={submit} disabled={!pid || !name || saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
      </div>
    </Modal>
  );
}

function EndpointDialog({ modelId, endpoint, providerUrl, onClose, onSuccess }: { modelId: string; endpoint?: Endpoint | null; providerUrl?: string; onClose: () => void; onSuccess: () => void }) {
  const [url, setUrl] = useState(endpoint?.url || providerUrl || '');
  const [key, setKey] = useState('');
  const [priority, setPriority] = useState(String(endpoint?.priority ?? '0'));
  const [weight, setWeight] = useState(String(endpoint?.weight ?? '1'));
  const [saving, setSaving] = useState(false);
  const isEdit = !!endpoint;

  async function submit() {
    if (!url) return;
    setSaving(true);
    try {
      if (isEdit) {
        const body: Record<string, unknown> = { url, priority: Number(priority), weight: Number(weight) };
        if (key) body.api_key = key;
        await ansProxy.put(`/api/v1/models/endpoints/${endpoint!.id}`, body);
      } else {
        if (!key) { alert('请提供API Key'); setSaving(false); return; }
        await ansProxy.post(`/api/v1/models/${modelId}/endpoints`, { url, api_key: key, priority: Number(priority), weight: Number(weight) });
      }
      invalidateNeedsSetup();
      onSuccess();
    } catch {}
    setSaving(false);
  }

  return (
    <Modal onClose={onClose} title={isEdit ? '编辑端点' : '添加端点'}>
      {!isEdit && providerUrl && <p className="text-xs text-blue-600 bg-blue-50 px-3 py-2 rounded mb-3">已自动填入供应商Base URL</p>}
      <div className="space-y-3">
        <div><label className="block text-sm font-medium mb-1">端点URL *</label><input value={url} onChange={e => setUrl(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" placeholder="https://api.openai.com/v1" /></div>
        <div><label className="block text-sm font-medium mb-1">API Key {!isEdit && '*'}</label><input type="password" value={key} onChange={e => setKey(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder={isEdit ? '留空则不修改' : 'sk-...'} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium mb-1">优先级</label><input type="number" value={priority} onChange={e => setPriority(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
          <div><label className="block text-sm font-medium mb-1">权重</label><input type="number" step="0.1" value={weight} onChange={e => setWeight(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
        <button onClick={submit} disabled={!url || saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
      </div>
    </Modal>
  );
}
