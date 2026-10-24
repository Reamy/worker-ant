import { useState, useEffect, useRef } from 'react';
import { invoke, projects as projectsApi, admin, skills } from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
import { FreshnessPill } from '../components/FreshnessPill';
import { Brain, RefreshCw, Star, Trash2, Search, ThumbsDown } from 'lucide-react';
import { formatDbTime } from '../lib/deliverable-view';
// zx_20260920_1 M7: 星号阈值引真源（同 ProjectDetailPage）——基线抬到 0.6 后 `> 0.5` 会让每条新记忆默认亮星。
import { MEM_IMPORTANCE_DEFAULT } from '../../../src/main/core/memory-constants.js';
// zx_20260930 M8: 哨兵取值（归档/墓碑）的中文名**不在这里手抄**——分级词表唯一真源在 core/memory-lifecycle.ts。
import { MEM_GRADES, MEM_TYPE_DELETED, MEM_TYPE_LABEL } from '../../../src/main/core/memory-lifecycle.js';

interface Memory { id: string; content: string; memory_type?: string; importance?: number; source?: string; valence?: string; project_id?: string; project_name?: string; created_at: string; use_count?: number; last_used_at?: string; injected_count?: number; last_injected_at?: string | null; similar_to?: string; context_json?: string; is_exemplar?: number; success_count?: number; failure_count?: number; deleted_at?: string; deleted_reason?: string; }
interface InjectionStats { injected: number; distinctMemories: number; usedTimes: number; completed: number; failed: number; pending: number; }
interface ProjectItem { id: string; name: string; }
interface HealthData { total: number; typeCounts: Record<string, number>; avgConfidence: number; conflictCount: number; exemplarCount: number; prospectCount: number; draftCount: number; tripleCount: number; }
interface SkillDraft { id: string; name: string; description: string; steps: string[]; }

export default function MemoriesPage() {
  const [items, setItems] = useState<Memory[]>([]);
  const [counts, setCounts] = useState<Array<{memory_type:string;cnt:number}>>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [injStats, setInjStats] = useState<InjectionStats | null>(null);
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [projFilter, setProjFilter] = useState('');
  const [projList, setProjList] = useState<ProjectItem[]>([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => { loadProjects(); loadHealth(); loadDrafts(); }, []);

  // A1/A2 (2026-09-04_2): useLiveQuery 统一保鲜 —— 记忆列表随 memory_injected（命中当前项目筛选）自动刷新；
  // 无常·保鲜：超 90s 无事件即提示"可能已过期"
  const q = useLiveQuery(async () => {
    const d = await invoke<{list: Memory[]; counts: Array<{memory_type:string;cnt:number}>; total: number}>('admin:memories', { type: typeFilter || undefined, projectId: projFilter || undefined, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
    return d;
  }, [typeFilter, projFilter, page], {
    liveTypes: ['task.memory_injected', 'memory.changed'],
    match: (e) => !projFilter || e.projectId === projFilter,
    debounceMs: 900,
    onRefreshed: () => { void loadHealth(); void loadInjectionStats(); },
  });
  // zx_20261018_3 批一: 注入账是本筛选项目（或全部）的一笔实数——与上面的列表同一刷新节奏。
  useEffect(() => { void loadInjectionStats(); }, [projFilter]);
  useEffect(() => {
    if (q.data) { setItems(q.data.list || []); setCounts(q.data.counts || []); setTotal(q.data.total || 0); }
  }, [q.data]);

  async function loadProjects() { try { const d = await projectsApi.list() as unknown as ProjectItem[]; setProjList(d); } catch {} }
  async function loadHealth() { try { const h = await admin.memoryHealth(); setHealth(h); } catch {} }
  // 只认最后一次请求：快速切换项目筛选时，旧响应不得覆盖新项目的结果。
  const injSeq = useRef(0);
  async function loadInjectionStats() {
    const seq = ++injSeq.current;
    try {
      const s = await admin.memoryInjectionStats(projFilter || undefined);
      if (seq === injSeq.current) setInjStats(s);
    } catch {}
  }
  async function loadDrafts() { try { const d = await skills.listDrafts(); setDrafts((d as unknown as { drafts: SkillDraft[] }).drafts || []); } catch {} }
  async function handleDelete(id: string) { if (!confirm('确定删除此记忆？')) return; try { await invoke('admin:deleteMemory', id); await q.reload(); } catch {} }
  async function handleDownweight(id: string) { if (!confirm('确定降权此记忆？将降低其可信度（保留内容）。')) return; try { await admin.downweightMemory(id); await q.reload(); } catch {} }
  async function handleMarkExemplar(id: string) { try { await admin.markExemplar(id); await q.reload(); } catch {} }
  async function handleApproveDraft(draftId: string) { try { await skills.approve(draftId); loadDrafts(); } catch {} }
  async function handleRejectDraft(draftId: string) { try { await skills.reject(draftId); loadDrafts(); } catch {} }

  function signals(m: Memory): { conflict: boolean; deep: boolean; volatile: boolean; verified: boolean; sublated: boolean } {
    try {
      const ctx = JSON.parse(m.context_json || '{}') as Record<string, unknown>;
      const app = ctx.applicability as { stability?: string } | undefined;
      const ev = ctx.evidence as { verified?: boolean; file_path?: string } | undefined;
      return {
        conflict: !!(ctx.conflict_flag || ctx.potential_conflict),
        deep: ctx.processing_depth === 'deep',
        volatile: app?.stability === 'volatile',
        verified: !!(ev?.verified || ev?.file_path),
        sublated: !!ctx.sublated,
      };
    } catch { return { conflict: false, deep: false, volatile: false, verified: false, sublated: false }; }
  }

  // zx_20261019 实机 E2E 修: 类型词表**不在本页手抄**——取 `core/memory-lifecycle.ts` 的唯一一份
  //   （此前本页与 ProjectDetailPage 各一份，两份都漏 `acceptance_failure`/`panorama` ⇒ 显示英文原始键）。
  const SENTINEL_LABEL: Record<string, string> = Object.fromEntries(MEM_GRADES.map(g => [g.grade, g.label]));
  const typeLabel = (t: string) => MEM_TYPE_LABEL[t] || SENTINEL_LABEL[t] || t;
  // zx_20260930 M8: 归档/墓碑的颜色（**颜色是表现层的事**，不进领域模块）——沿用分级词表的 grade 键，名字从那边取。
  const typeColors: Record<string, string> = { episodic:'bg-blue-100 text-blue-700', semantic:'bg-green-100 text-green-700', procedural:'bg-purple-100 text-purple-700', preference:'bg-yellow-100 text-yellow-700', prospective:'bg-cyan-100 text-cyan-700', retrospective:'bg-indigo-100 text-indigo-700', limiting_belief:'bg-rose-100 text-rose-700', failure_knowledge:'bg-red-100 text-red-700', subagent_experience:'bg-teal-100 text-teal-700', acceptance_failure:'bg-orange-100 text-orange-700', archetype_correction:'bg-violet-100 text-violet-700', panorama:'bg-sky-100 text-sky-700', negative:'bg-red-100 text-red-700', unknown:'bg-gray-100 text-gray-600', archived:'bg-gray-100 text-gray-500', deleted:'bg-stone-200 text-stone-600' };
  const valenceLabel = (v: string|undefined) => v === 'positive' ? '✓正' : v === 'negative' ? '✗负' : '';
  const valenceColor = (v: string|undefined) => v === 'positive' ? 'text-green-500' : v === 'negative' ? 'text-red-500' : 'text-gray-300';
  const filtered = search ? items.filter(m => (m.content||'').toLowerCase().includes(search.toLowerCase())) : items;
  /** 墓碑/归档是 `memory_type` 列上的**哨兵取值**，与 `episodic` 等类型挤在一列 ⇒ 名字从分级词表取，不手抄。 */
  const isTombstone = (m: Memory) => m.memory_type === MEM_TYPE_DELETED;
  // C1 (2026-09-03_2): 记忆冲突批量处理（接线 superseded 语义，零新机制）
  const resolveConflicts = async () => {
    const conflicts = items.filter((m) => signals(m).conflict);
    if (conflicts.length < 2) return;
    const keep = conflicts.reduce((a, b) => ((b.importance || 0) > (a.importance || 0) ? b : a));
    const removeIds = conflicts.filter((m) => m.id !== keep.id).map((m) => m.id);
    try { await invoke('memory:resolveConflicts', { keepId: keep.id, removeIds }); } catch { /* ignore */ }
    await q.reload(); await loadHealth();
  };

  if (q.loading && q.data == null) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"/></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6"><h2 className="text-xl font-bold">系统记忆</h2><div className="flex items-center gap-2"><FreshnessPill q={q} /><button onClick={() => { void q.reload(); void loadHealth(); void loadDrafts(); }} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4"/></button></div></div>

      {/* Phase C (2026-08-28 zx_1): 记忆健康度概览（元认知监控——让系统记忆质量可见） */}
      {health && (
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="bg-white rounded-lg border p-3"><p className="text-lg font-bold text-gray-800">{health.total}</p><p className="text-[10px] text-gray-400">总记忆</p></div>
          <div className="bg-white rounded-lg border p-3"><p className="text-lg font-bold text-blue-600">{health.avgConfidence}%</p><p className="text-[10px] text-gray-400">平均可信度</p></div>
          <div className="bg-white rounded-lg border p-3"><p className={`text-lg font-bold ${health.conflictCount>0?'text-red-600':'text-gray-800'}`}>{health.conflictCount}</p><p className="text-[10px] text-gray-400">冲突记忆</p></div>
          <div className="bg-white rounded-lg border p-3"><p className="text-lg font-bold text-yellow-600">{health.exemplarCount}</p><p className="text-[10px] text-gray-400">通用智慧样例</p></div>
          <div className="bg-white rounded-lg border p-3"><p className="text-lg font-bold text-purple-600">{health.prospectCount}</p><p className="text-[10px] text-gray-400">前瞻记忆</p></div>
          <div className="bg-white rounded-lg border p-3"><p className="text-lg font-bold text-emerald-600">{health.tripleCount}</p><p className="text-[10px] text-gray-400">知识图谱三元组</p></div>
          <div className="bg-white rounded-lg border p-3"><p className="text-lg font-bold text-cyan-600">{health.draftCount}</p><p className="text-[10px] text-gray-400">待审批技能草案</p></div>
          <div className="bg-white rounded-lg border p-3"><p className="text-lg font-bold text-gray-500">{Object.keys(health.typeCounts).length}</p><p className="text-[10px] text-gray-400">记忆类型数</p></div>
        </div>
      )}

      {/* zx_20261018_3 批一: 注入账（`wa_context_injections` 的读者）——注入与主动引用**分账**，不再混为一谈。 */}
      {injStats && (
        <div className="bg-white rounded-lg border px-3 py-2 mb-4 flex items-center gap-4 flex-wrap text-xs">
          <span className="font-medium text-gray-700">记忆注入账{projFilter ? '（当前项目）' : '（全部项目）'}</span>
          <span className="text-gray-500">注入 <b className="text-gray-800">{injStats.injected}</b> 次</span>
          <span className="text-gray-500">覆盖 <b className="text-gray-800">{injStats.distinctMemories}</b> 条</span>
          <span className="text-gray-500">主动引用 <b className="text-gray-800">{injStats.usedTimes}</b> 次</span>
          <span className="text-gray-400">结局：完成 {injStats.completed} · 失败 {injStats.failed} · 待定 {injStats.pending}</span>
        </div>
      )}

      {/* C1 (2026-09-03_2): 冲突记忆批量处理（选最高重要性保留，其余标 superseded + 降权） */}
      {health && health.conflictCount > 1 && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4 flex items-center justify-between gap-3">
          <p className="text-xs text-red-700">检测到 {health.conflictCount} 条冲突记忆。可一键扬弃其中的低权旧记忆（自动保留最高重要性一条，其余降权并标 superseded，不再注入）。</p>
          <button type="button" onClick={resolveConflicts} className="text-xs px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 shrink-0">一键扬弃其余</button>
        </div>
      )}

      {/* Phase C (2026-08-28 zx_1): 技能草案待审批（复用已有 skills:listDrafts/approve/reject IPC，前端接线） */}
      {drafts.length > 0 && (
        <div className="bg-white rounded-lg border p-4 mb-4">
          <h3 className="font-medium mb-2 text-sm flex items-center gap-1"><Brain className="w-4 h-4 text-cyan-500"/>技能草案待审批 ({drafts.length})</h3>
          <div className="space-y-2">
            {drafts.map(d => (
              <div key={d.id} className="flex items-start justify-between gap-2 border-b last:border-0 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-700">{d.name}</p>
                  <p className="text-xs text-gray-500 truncate" title={d.description}>{d.description}</p>
                  {d.steps.length>0 && <p className="text-[10px] text-gray-400 mt-0.5">{d.steps.length} 步</p>}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={()=>handleApproveDraft(d.id)} className="text-[10px] px-2 py-0.5 bg-emerald-50 rounded hover:bg-emerald-100 text-emerald-600">批准</button>
                  <button onClick={()=>handleRejectDraft(d.id)} className="text-[10px] px-2 py-0.5 bg-gray-100 rounded hover:bg-gray-200 text-gray-600">拒绝</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 筛选：项目 + 类型 + 搜索 */}
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <div className="relative w-48">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e=>setSearch(e.target.value)} className="w-full pl-7 pr-2 py-1.5 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="搜索记忆内容..." />
        </div>
        <select value={projFilter} onChange={e => setProjFilter(e.target.value)} className="px-2 py-1.5 border rounded-lg text-xs bg-white">
          <option value="">全部项目</option>
          {projList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => setTypeFilter('')} className={`px-3 py-1 rounded-lg text-xs font-medium ${typeFilter === '' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>全部 ({filtered.length})</button>
        {counts.map(c => (
          <button key={c.memory_type} onClick={() => setTypeFilter(c.memory_type)} className={`px-3 py-1 rounded-lg text-xs font-medium ${typeFilter === c.memory_type ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {typeLabel(c.memory_type)} ({c.cnt})
          </button>
        ))}
      </div>

      {filtered.length===0?<p className="text-gray-400 text-center py-12">暂无记忆</p>:<div className="space-y-2">{filtered.map(m=>{const tomb=isTombstone(m);const s=signals(m);return (
        <div key={m.id} className={`rounded-lg border p-4 ${tomb?'bg-stone-50 border-stone-200':'bg-white'}`}>
          <div className="flex items-start justify-between mb-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Brain className={`w-4 h-4 ${tomb?'text-stone-400':'text-purple-500'}`}/>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeColors[m.memory_type||''] || 'bg-gray-100'}`}>{typeLabel(m.memory_type||'')}</span>
              {m.project_name&&<span className="text-xs text-gray-400">{m.project_name}</span>}
              {!tomb&&<span className="text-xs text-gray-300">{m.source}</span>}
              {/* 墓碑只在审计面出现：只留 时刻/缘由/指纹，不再显示来源、评分与各类信号（正文已清空，它们无所依附）。 */}
              {!tomb&&<>{s.conflict&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-medium">冲突</span>}{s.deep&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600">深加工</span>}{s.verified&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600">已验证</span>}{s.volatile&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600">易变</span>}{s.sublated&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">已扬弃</span>}{m.is_exemplar?<span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">★样例</span>:null}<span className={`text-[10px] ${valenceColor(m.valence)}`}>{valenceLabel(m.valence)}</span><div className="flex items-center gap-1"><Star className={`w-3 h-3 ${(m.importance||0)>MEM_IMPORTANCE_DEFAULT?'text-yellow-500 fill-yellow-500':'text-gray-300'}`}/><span className="text-xs text-gray-400">{m.importance?.toFixed(1)}</span></div>{(m.injected_count||0)>0&&<span className="text-[10px] text-gray-400">注入{m.injected_count}次</span>}{(m.use_count||0)>0&&<span className="text-[10px] text-gray-400">引用{m.use_count}次</span>}{((m.success_count||0)+(m.failure_count||0))>0&&<span className="text-[10px] text-gray-400">实践{m.success_count||0}成/{m.failure_count||0}败</span>}</>}
            </div>
            {!tomb&&<div className="flex gap-1 shrink-0"><button onClick={()=>handleMarkExemplar(m.id)} title="标记为通用智慧样例" className="p-1 hover:bg-yellow-50 rounded"><Star className="w-3.5 h-3.5 text-yellow-400"/></button><button onClick={()=>handleDownweight(m.id)} title="降权（降低可信度）" className="p-1 hover:bg-orange-50 rounded"><ThumbsDown className="w-3.5 h-3.5 text-orange-400"/></button><button onClick={()=>handleDelete(m.id)} className="p-1 hover:bg-red-50 rounded"><Trash2 className="w-3.5 h-3.5 text-red-400"/></button></div>}
          </div>
          {tomb
            ? <div className="text-xs text-stone-600 flex items-center gap-2 flex-wrap"><span className="font-medium">正文已清除</span><span className="px-1.5 py-0.5 rounded bg-stone-200 text-stone-700">{m.deleted_reason||'（缘由未记）'}</span><span className="text-[10px] text-stone-400">删除于 {formatDbTime(m.deleted_at||m.created_at)}</span></div>
            : <p className="text-sm text-gray-700">{m.content?.slice(0,300)}{(m.content?.length||0)>300?'...':''}</p>}
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {!tomb&&<p className="text-xs text-gray-400">{formatDbTime(m.created_at)}</p>}
            {!tomb&&m.last_used_at&&<span className="text-[10px] text-gray-300">最近访问:{formatDbTime(m.last_used_at)}</span>}
            {!tomb&&m.similar_to&&(()=>{try{const sim=JSON.parse(m.similar_to)as string[];return sim.length>0?<span className="text-[10px] text-blue-400">关联{sim.length}条相似记忆</span>:null;}catch{return null;}})()}
          </div>
        </div>);})}</div>}
      {/* 分页 */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 mt-4 text-sm">
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">上一页</button>
          <span className="text-gray-500">第 {page + 1} / {Math.ceil(total / PAGE_SIZE)} 页（共 {total} 条）</span>
          <button onClick={() => setPage(Math.min(Math.ceil(total / PAGE_SIZE) - 1, page + 1))} disabled={page >= Math.ceil(total / PAGE_SIZE) - 1} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">下一页</button>
        </div>
      )}
    </div>);
}
