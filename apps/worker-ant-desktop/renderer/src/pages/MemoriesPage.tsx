import { useState, useEffect, useRef } from 'react';
import { invoke, projects as projectsApi, admin, skills } from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
import { FreshnessPill } from '../components/FreshnessPill';
import { Brain, RefreshCw, Star, Trash2, Search, ThumbsDown, Plus, X, Pencil, FileText } from 'lucide-react';
import { formatDbTime } from '../lib/deliverable-view';
// zx_20260920_1 M7: 星号阈值引真源（同 ProjectDetailPage）——基线抬到 0.6 后 `> 0.5` 会让每条新记忆默认亮星。
import { MEM_IMPORTANCE_DEFAULT } from '../../../src/main/core/memory-constants.js';
// zx_20260930 M8: 哨兵取值（归档/墓碑）的中文名**不在这里手抄**——分级词表唯一真源在 core/memory-lifecycle.ts。
// zx_20261108_1 B4: **来源词表**同引这一份（`MEM_SOURCE_LABEL`），页面不再直接上屏 `agent_execution` 这类英文原值。
import { MEM_GRADES, MEM_SOURCE_LABEL, MEM_TYPE_ARCHIVED, MEM_TYPE_DELETED, MEM_TYPE_LABEL } from '../../../src/main/core/memory-lifecycle.js';
// zx_20261107_1 B4: 注入 ROI 的形状取 main 侧真源（仅类型，打包期擦除），不在本页手抄镜像。
import type { InjectionRoiView } from '../../../src/main/core/memory-injection-stats.js';
// zx_20261108_1 B4: 列表行/详情/容量的形状同取 main 侧零依赖真源（仅类型，打包期擦除）。
import type { MemoryAdminRow, MemoryCapacity, MemoryDetail, MemoryListResult, MemoryMutation } from '../../../src/main/core/memory-admin.js';

interface InjectionStats { injected: number; distinctMemories: number; usedTimes: number; completed: number; failed: number; pending: number; charsInjected: number; hitRate: number; failedShare: number; wasteChars: number; }
interface ProjectItem { id: string; name: string; }
interface HealthData { total: number; typeCounts: Record<string, number>; avgConfidence: number; conflictCount: number; exemplarCount: number; prospectCount: number; draftCount: number; tripleCount: number; }
interface SkillDraft { id: string; name: string; description: string; steps: string[]; }
type Notice = { kind: 'ok' | 'err'; text: string } | null;

const PAGE_SIZE = 50;
/** 新增/修订可选类型：哨兵（归档/墓碑）走生命周期动作，不经人工写口。 */
const TYPE_OPTIONS = Object.entries(MEM_TYPE_LABEL).filter(([k]) => k !== MEM_TYPE_ARCHIVED && k !== MEM_TYPE_DELETED);
const SOURCE_OPTIONS = Object.entries(MEM_SOURCE_LABEL);

export default function MemoriesPage() {
  const [items, setItems] = useState<MemoryAdminRow[]>([]);
  const [counts, setCounts] = useState<Array<{memory_type:string;cnt:number}>>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [injStats, setInjStats] = useState<InjectionStats | null>(null);
  const [roi, setRoi] = useState<InjectionRoiView | null>(null);
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [projFilter, setProjFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo] = useState('');
  const [projList, setProjList] = useState<ProjectItem[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [keywordMode, setKeywordMode] = useState<'fts' | 'like' | 'none'>('none');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [capacity, setCapacity] = useState<MemoryCapacity | null>(null);

  // zx_20261108_1 B4: 搜索改**服务端**取数（此前只在当前页 50 条里过滤 ⇒ 全库第 51 条起永远搜不到）。
  //   防抖 300ms 避免逐键打库；换筛选条件即回第 1 页（否则旧页码可能落在新结果集之外）。
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(0); }, [typeFilter, projFilter, sourceFilter, debouncedSearch, timeFrom, timeTo]);

  useEffect(() => { loadProjects(); loadHealth(); loadDrafts(); }, []);

  // A1/A2 (2026-09-04_2): useLiveQuery 统一保鲜 —— 记忆列表随 memory_injected（命中当前项目筛选）自动刷新；
  // 无常·保鲜：超 90s 无事件即提示"可能已过期"
  const q = useLiveQuery(async () => {
    const d = await admin.memories({
      type: typeFilter || undefined,
      projectId: projFilter || undefined,
      source: sourceFilter || undefined,
      keyword: debouncedSearch || undefined,
      timeFrom: timeFrom || undefined,
      timeTo: timeTo || undefined,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    return d;
  }, [typeFilter, projFilter, sourceFilter, debouncedSearch, timeFrom, timeTo, page], {
    liveTypes: ['task.memory_injected', 'memory.changed'],
    match: (e) => !projFilter || e.projectId === projFilter,
    debounceMs: 900,
    onRefreshed: () => { void loadHealth(); void loadInjectionStats(); void loadInjectionRoi(); },
  });
  // zx_20261018_3 批一: 注入账是本筛选项目（或全部）的一笔实数——与上面的列表同一刷新节奏。
  useEffect(() => { void loadInjectionStats(); void loadInjectionRoi(); }, [projFilter]);
  useEffect(() => {
    if (q.data) {
      setItems((q.data as MemoryListResult).list || []);
      setCounts(q.data.counts || []);
      setTotal(q.data.total || 0);
      setKeywordMode((q.data as MemoryListResult).keywordMode || 'none');
    }
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
  // zx_20261107_1 B4: 注入 ROI——同一序号纪律（快速切项目时旧响应不得覆盖新项目）。
  const roiSeq = useRef(0);
  async function loadInjectionRoi() {
    const seq = ++roiSeq.current;
    try {
      const v = await admin.injectionRoi(projFilter || undefined);
      if (seq === roiSeq.current) setRoi(v);
    } catch {}
  }
  async function loadDrafts() { try { const d = await skills.listDrafts(); setDrafts((d as unknown as { drafts: SkillDraft[] }).drafts || []); } catch {} }
  async function loadCapacity() { try { setCapacity(await admin.memoryCapacity()); } catch (e) { setNotice({ kind: 'err', text: `容量读取失败：${(e as Error).message}` }); } }

  /** 写后统一刷新：列表 + 健康 +（若容量已展开）容量。 */
  async function refreshAfterWrite() {
    await q.reload();
    void loadHealth();
    if (capacity) void loadCapacity();
  }

  async function handleDelete(id: string) {
    if (!confirm('确定遗忘此记忆？正文将清除，只在「墓碑」审计面留痕（不可恢复）。')) return;
    try {
      await admin.deleteMemory(id);
      setNotice({ kind: 'ok', text: '已遗忘该记忆（可在「墓碑」筛选中查看留痕）' });
      if (detail?.memory.id === id) setDetailId(null);
      await refreshAfterWrite();
    } catch (e) { setNotice({ kind: 'err', text: `遗忘失败：${(e as Error).message}` }); }
  }
  async function handleDownweight(id: string) {
    if (!confirm('确定降权此记忆？将降低其可信度（保留内容）。')) return;
    try { await admin.downweightMemory(id); setNotice({ kind: 'ok', text: '已降权' }); await refreshAfterWrite(); }
    catch (e) { setNotice({ kind: 'err', text: `降权失败：${(e as Error).message}` }); }
  }
  async function handleMarkExemplar(id: string) {
    try { await admin.markExemplar(id); setNotice({ kind: 'ok', text: '已标记为通用智慧样例' }); await refreshAfterWrite(); }
    catch (e) { setNotice({ kind: 'err', text: `标记失败：${(e as Error).message}` }); }
  }
  async function handleApproveDraft(draftId: string) { try { await skills.approve(draftId); loadDrafts(); } catch {} }
  async function handleRejectDraft(draftId: string) { try { await skills.reject(draftId); loadDrafts(); } catch {} }

  // ===== zx_20261108_1 B4: 详情抽屉（来源 / 证据 / 注入历史 / 改账历史）=====
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editType, setEditType] = useState('');
  const [editImportance, setEditImportance] = useState('');
  const [saving, setSaving] = useState(false);

  async function openDetail(id: string) {
    setDetailId(id); setDetail(null); setDetailError('');
    try {
      const d = await admin.memoryDetail(id);
      setDetail(d);
      setEditContent(d.memory.content || '');
      setEditType(d.memory.memory_type || '');
      setEditImportance(String(d.memory.importance ?? MEM_IMPORTANCE_DEFAULT));
    } catch (e) { setDetailError(`详情读取失败：${(e as Error).message}`); }
  }

  async function handleRevise() {
    if (!detail) return;
    const m = detail.memory;
    const patch: MemoryMutation = { op: 'revise', id: m.id };
    let changed = false;
    const content = editContent.trim();
    if (content && content !== m.content) { patch.content = content; changed = true; }
    if (editType && editType !== m.memory_type) { patch.type = editType; changed = true; }
    const imp = Number(editImportance);
    if (Number.isFinite(imp) && imp !== m.importance) { patch.importance = imp; changed = true; }
    if (!changed) { setDetailError('没有要修改的字段'); return; }
    setSaving(true); setDetailError('');
    try {
      await admin.memoryMutate(patch);
      setNotice({ kind: 'ok', text: '已保存修订' });
      await openDetail(m.id);
      await refreshAfterWrite();
    } catch (e) { setDetailError(`保存失败：${(e as Error).message}`); }
    finally { setSaving(false); }
  }

  // ===== zx_20261108_1 B4: 手动新增 =====
  const [addOpen, setAddOpen] = useState(false);
  const [addContent, setAddContent] = useState('');
  const [addProject, setAddProject] = useState('');
  const [addType, setAddType] = useState('episodic');
  const [addImportance, setAddImportance] = useState(String(MEM_IMPORTANCE_DEFAULT));

  async function handleAdd() {
    const content = addContent.trim();
    if (!content) { setNotice({ kind: 'err', text: '记忆内容不能为空' }); return; }
    setSaving(true);
    try {
      await admin.memoryMutate({
        op: 'add',
        content,
        projectId: addProject || null,
        type: addType,
        importance: Number(addImportance),
      });
      setAddOpen(false);
      setAddContent('');
      setNotice({ kind: 'ok', text: '已新增记忆（来源：手动新增）' });
      await refreshAfterWrite();
    } catch (e) { setNotice({ kind: 'err', text: `新增失败：${(e as Error).message}` }); }
    finally { setSaving(false); }
  }

  function signals(m: MemoryAdminRow): { conflict: boolean; deep: boolean; volatile: boolean; verified: boolean; sublated: boolean } {
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
  /** 墓碑/归档是 `memory_type` 列上的**哨兵取值**，与 `episodic` 等类型挤在一列 ⇒ 名字从分级词表取，不手抄。 */
  const isTombstone = (m: MemoryAdminRow) => m.memory_type === MEM_TYPE_DELETED;
  const hasFilters = !!(projFilter || sourceFilter || debouncedSearch || timeFrom || timeTo);
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
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">系统记忆</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setAddOpen(true)} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700"><Plus className="w-3.5 h-3.5"/>新增记忆</button>
          <FreshnessPill q={q} />
          <button onClick={() => { void q.reload(); void loadHealth(); void loadDrafts(); if (capacity) void loadCapacity(); }} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4"/></button>
        </div>
      </div>

      {/* zx_20261108_1 B4: 写口结果**当面上屏**（成功/失败都不静默）。 */}
      {notice && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-xs flex items-center justify-between gap-3 ${notice.kind === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="p-0.5 hover:bg-white/60 rounded"><X className="w-3.5 h-3.5"/></button>
        </div>
      )}

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
          {/* zx_20261101_2 M5: 注入效果账——字数、命中率、失败任务占比，"这段记忆值不值"可核对。 */}
          <span className="text-gray-500">已注入 <b className="text-gray-800">{injStats.charsInjected}</b> 字</span>
          <span className="text-gray-500">命中率 <b className={injStats.hitRate < 0.2 && injStats.injected > 0 ? 'text-amber-600' : 'text-gray-800'}>{(injStats.hitRate * 100).toFixed(0)}%</b>{injStats.distinctMemories > 0 ? <span className="text-gray-400">（{injStats.usedTimes}/{injStats.distinctMemories} 条）</span> : null}</span>
          <span className="text-gray-500">失败任务占比 <b className={injStats.failedShare > 0.3 ? 'text-red-600' : 'text-gray-800'}>{(injStats.failedShare * 100).toFixed(0)}%</b></span>
          <span className="text-gray-400">结局：完成 {injStats.completed} · 失败 {injStats.failed} · 待定 {injStats.pending}{injStats.wasteChars > 0 ? ` · 白注入 ${injStats.wasteChars} 字` : ''}</span>
          {injStats.injected > 0 && injStats.hitRate < 0.2 && (
            <span className="text-amber-600">命中偏低：可缩短记忆正文、降低记忆预算，或清理长期未被引用的条目。</span>
          )}
        </div>
      )}

      {/* zx_20261107_1 B4: 注入 ROI——来源合计当面可核；每任务明细归团队版审计视图（锁定则如实说）。只读。 */}
      {roi && (
        <div className="bg-white rounded-lg border p-3 mb-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <span className="text-xs font-medium text-gray-700">注入 ROI（按来源）{projFilter ? ' · 当前项目' : ' · 全部项目'}</span>
            <span className="text-[10px] text-gray-400">只读：不自动降权、不删记忆</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="py-1 pr-3 font-normal">来源</th>
                  <th className="py-1 pr-3 font-normal">注入</th>
                  <th className="py-1 pr-3 font-normal">字数</th>
                  <th className="py-1 pr-3 font-normal">约 token</th>
                  <th className="py-1 pr-3 font-normal">完成 / 失败 / 待定</th>
                  <th className="py-1 pr-3 font-normal">成功率</th>
                  <th className="py-1 font-normal">白注入字数</th>
                </tr>
              </thead>
              <tbody>
                {roi.summary.sources.map((s) => (
                  <tr key={s.source} className={s.injections === 0 ? 'text-gray-300' : 'text-gray-700'}>
                    <td className="py-1 pr-3">{s.label}</td>
                    <td className="py-1 pr-3">{s.injections}</td>
                    <td className="py-1 pr-3">{s.chars}</td>
                    <td className="py-1 pr-3">{s.estTokens}</td>
                    <td className="py-1 pr-3">{s.completed} / {s.failed} / {s.pending}</td>
                    <td className="py-1 pr-3">{(s.successRate * 100).toFixed(0)}%</td>
                    <td className={`py-1 ${s.wasteChars > 0 ? 'text-red-500' : ''}`}>{s.wasteChars}</td>
                  </tr>
                ))}
                <tr className="border-t font-medium text-gray-800">
                  <td className="py-1 pr-3">{roi.summary.totals.label}</td>
                  <td className="py-1 pr-3">{roi.summary.totals.injections}</td>
                  <td className="py-1 pr-3">{roi.summary.totals.chars}</td>
                  <td className="py-1 pr-3">{roi.summary.totals.estTokens}</td>
                  <td className="py-1 pr-3">{roi.summary.totals.completed} / {roi.summary.totals.failed} / {roi.summary.totals.pending}</td>
                  <td className="py-1 pr-3">{(roi.summary.totals.successRate * 100).toFixed(0)}%</td>
                  <td className={`py-1 ${roi.summary.totals.wasteChars > 0 ? 'text-red-500' : ''}`}>{roi.summary.totals.wasteChars}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-3 border-t pt-2">
            <div className="text-[11px] font-medium text-gray-700 mb-1">每任务明细</div>
            {!roi.detail.unlocked ? (
              <p className="text-[11px] text-amber-600">{roi.detail.refusal}</p>
            ) : roi.detail.rows.length === 0 ? (
              <p className="text-[11px] text-gray-400">暂无注入明细</p>
            ) : (
              <div className="space-y-1">
                {roi.detail.rows.map((t) => (
                  <div key={t.taskId} className="text-[11px] text-gray-600 flex items-center gap-2 flex-wrap">
                    <span className="text-gray-800 truncate max-w-[16rem]" title={t.title || t.taskId}>{t.title || t.taskId}</span>
                    <span className="text-gray-400">{t.status}</span>
                    <span>注入 {t.injections}</span>
                    <span>{t.chars} 字</span>
                    <span className="text-gray-400">完成 {t.completed} · 失败 {t.failed} · 待定 {t.pending}</span>
                    {t.wasteChars > 0 && <span className="text-red-500">白注入 {t.wasteChars} 字</span>}
                    <span className="text-gray-400">{t.bySource.map((x) => `${x.label}×${x.injections}`).join(' · ')}</span>
                  </div>
                ))}
                {roi.detail.truncated && <p className="text-[10px] text-gray-400">仅显示最近 {roi.detail.rows.length} 个任务（还有更多）</p>}
              </div>
            )}
          </div>
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

      {/* 筛选：搜索（服务端）+ 项目 + 来源 + 时间 + 类型 */}
      <div className="flex gap-2 mb-2 flex-wrap items-center">
        <div className="relative w-56">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e=>setSearch(e.target.value)} className="w-full pl-7 pr-2 py-1.5 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="搜索记忆内容（全库）..." />
        </div>
        <select value={projFilter} onChange={e => setProjFilter(e.target.value)} className="px-2 py-1.5 border rounded-lg text-xs bg-white">
          <option value="">全部项目</option>
          {projList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="px-2 py-1.5 border rounded-lg text-xs bg-white">
          <option value="">全部来源</option>
          {sourceFilter && !MEM_SOURCE_LABEL[sourceFilter] && <option value={sourceFilter}>{sourceFilter}</option>}
          {SOURCE_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <label className="text-[11px] text-gray-400 flex items-center gap-1">创建自
          <input type="date" value={timeFrom} onChange={e=>setTimeFrom(e.target.value)} className="px-1.5 py-1 border rounded-lg text-xs" />
        </label>
        <label className="text-[11px] text-gray-400 flex items-center gap-1">至
          <input type="date" value={timeTo} onChange={e=>setTimeTo(e.target.value)} className="px-1.5 py-1 border rounded-lg text-xs" />
        </label>
        {hasFilters && <button onClick={() => { setProjFilter(''); setSourceFilter(''); setTimeFrom(''); setTimeTo(''); setSearch(''); }} className="text-[11px] text-blue-600 hover:underline">清除筛选</button>}
        <span className="text-[11px] text-gray-400 ml-auto">共 {total} 条{debouncedSearch ? `（搜索：全库）` : ''}</span>
      </div>
      {debouncedSearch && keywordMode === 'like' && (
        <p className="text-[10px] text-amber-600 mb-2">全文索引不可用，已按「内容包含」匹配（LIKE）——结果可能少于全文检索。</p>
      )}

      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <button onClick={() => setTypeFilter('')} className={`px-3 py-1 rounded-lg text-xs font-medium ${typeFilter === '' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>全部{typeFilter === '' ? ` (${total})` : ''}</button>
        {counts.map(c => (
          <button key={c.memory_type} onClick={() => setTypeFilter(c.memory_type)} className={`px-3 py-1 rounded-lg text-xs font-medium ${typeFilter === c.memory_type ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {typeLabel(c.memory_type)} ({c.cnt})
          </button>
        ))}
      </div>

      {items.length===0?<p className="text-gray-400 text-center py-12">{hasFilters ? '没有匹配的记忆' : '暂无记忆'}</p>:<div className="space-y-2">{items.map(m=>{const tomb=isTombstone(m);const s=signals(m);return (
        <div key={m.id} className={`rounded-lg border p-4 ${tomb?'bg-stone-50 border-stone-200':'bg-white'}`}>
          <div className="flex items-start justify-between mb-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Brain className={`w-4 h-4 ${tomb?'text-stone-400':'text-purple-500'}`}/>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeColors[m.memory_type||''] || 'bg-gray-100'}`}>{typeLabel(m.memory_type||'')}</span>
              {m.project_name ? <span className="text-xs text-gray-400">{m.project_name}</span> : (!tomb && m.cross_project ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-600">跨项目经验</span> : null)}
              {!tomb&&<span className="text-xs text-gray-500" title={m.source}>{m.source_label || '未知来源'}</span>}
              {/* 墓碑只在审计面出现：只留 时刻/缘由/指纹，不再显示来源、评分与各类信号（正文已清空，它们无所依附）。 */}
              {!tomb&&<>{s.conflict&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-medium">冲突</span>}{s.deep&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-600">深加工</span>}{s.verified&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600">已验证</span>}{s.volatile&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600">易变</span>}{s.sublated&&<span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">已扬弃</span>}{m.is_exemplar?<span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">★样例</span>:null}<span className={`text-[10px] ${valenceColor(m.valence)}`}>{valenceLabel(m.valence)}</span><div className="flex items-center gap-1"><Star className={`w-3 h-3 ${(m.importance||0)>MEM_IMPORTANCE_DEFAULT?'text-yellow-500 fill-yellow-500':'text-gray-300'}`}/><span className="text-xs text-gray-400">{m.importance?.toFixed(1)}</span></div>{(m.injected_count||0)>0&&<span className="text-[10px] text-gray-400">注入{m.injected_count}次</span>}{(m.use_count||0)>0&&<span className="text-[10px] text-gray-400">引用{m.use_count}次</span>}{((m.success_count||0)+(m.failure_count||0))>0&&<span className="text-[10px] text-gray-400">实践{m.success_count||0}成/{m.failure_count||0}败</span>}</>}
            </div>
            <div className="flex gap-1 shrink-0">
              <button onClick={()=>void openDetail(m.id)} title="详情（来源 / 注入历史 / 改账）" className="p-1 hover:bg-blue-50 rounded"><FileText className="w-3.5 h-3.5 text-blue-400"/></button>
              {!tomb&&<><button onClick={()=>handleMarkExemplar(m.id)} title="标记为通用智慧样例" className="p-1 hover:bg-yellow-50 rounded"><Star className="w-3.5 h-3.5 text-yellow-400"/></button><button onClick={()=>handleDownweight(m.id)} title="降权（降低可信度）" className="p-1 hover:bg-orange-50 rounded"><ThumbsDown className="w-3.5 h-3.5 text-orange-400"/></button><button onClick={()=>handleDelete(m.id)} title="遗忘（落墓碑，可审计）" className="p-1 hover:bg-red-50 rounded"><Trash2 className="w-3.5 h-3.5 text-red-400"/></button></>}
            </div>
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
      {/* 分页（总数取服务端筛选后的 total，与列表同一套 WHERE） */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 mt-4 text-sm">
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">上一页</button>
          <span className="text-gray-500">第 {page + 1} / {Math.ceil(total / PAGE_SIZE)} 页（共 {total} 条）</span>
          <button onClick={() => setPage(Math.min(Math.ceil(total / PAGE_SIZE) - 1, page + 1))} disabled={page >= Math.ceil(total / PAGE_SIZE) - 1} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">下一页</button>
        </div>
      )}

      {/* zx_20261108_1 B4: 容量与索引健康——放**次级区域**（默认折叠，不挤首屏；展开才取数）。 */}
      <details
        className="mt-6 bg-white rounded-lg border p-3"
        onToggle={(e) => {
          const open = (e.currentTarget as HTMLDetailsElement).open;
          if (open && !capacity) void loadCapacity();
        }}
      >
        <summary className="text-xs font-medium text-gray-700 cursor-pointer select-none">容量与索引健康（按类型 / 来源 / 项目 · FTS · 重复候选）</summary>
        {!capacity ? (
          <p className="text-[11px] text-gray-400 mt-2">展开后读取…</p>
        ) : (
          <div className="mt-3 space-y-3 text-[11px] text-gray-600">
            <div className="flex items-center gap-4 flex-wrap">
              <span>总记忆 <b className="text-gray-800">{capacity.total}</b></span>
              <span>活记忆 <b className="text-gray-800">{capacity.live}</b></span>
              <span>正文 <b className="text-gray-800">{capacity.chars}</b> 字</span>
              <span className={capacity.fts.available ? 'text-gray-600' : 'text-red-600'}>
                FTS：{capacity.fts.available ? `索引 ${capacity.fts.indexed} 条 · 未索引 ${capacity.fts.missing} · 孤行 ${capacity.fts.orphaned}` : `不可用${capacity.fts.error ? `（${capacity.fts.error}）` : ''}`}
              </span>
            </div>
            <div>
              <p className="text-gray-500 mb-1">按类型</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {capacity.byType.map(t => <span key={t.type}>{t.label} <b className="text-gray-800">{t.count}</b>（活 {t.live}）</span>)}
              </div>
            </div>
            <div>
              <p className="text-gray-500 mb-1">按来源（活记忆）</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {capacity.bySource.map(s => <span key={s.source}>{s.label} <b className="text-gray-800">{s.count}</b></span>)}
              </div>
            </div>
            <div>
              <p className="text-gray-500 mb-1">按项目（活记忆）</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {capacity.byProject.map(p => <span key={p.projectId ?? '__cross__'}>{p.projectName || (p.projectId ? p.projectId : '跨项目/无项目')} <b className="text-gray-800">{p.count}</b></span>)}
              </div>
            </div>
            <div>
              <p className="text-gray-500 mb-1">可合并候选（正文完全相同，只读建议）</p>
              {capacity.mergeCandidates.length === 0 ? <p className="text-gray-400">无</p> : (
                <div className="space-y-1">
                  {capacity.mergeCandidates.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-gray-800">×{c.count}</span>
                      <span className="truncate max-w-[36rem]" title={c.preview}>{c.preview}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </details>

      {/* ===== 详情抽屉 ===== */}
      {detailId && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setDetailId(null)}>
          <div className="w-[34rem] max-w-full h-full bg-white shadow-xl overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-800">记忆详情</h3>
              <button onClick={() => setDetailId(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4"/></button>
            </div>
            {detailError && <p className="text-xs text-red-600 mb-2">{detailError}</p>}
            {!detail ? (
              <p className="text-xs text-gray-400">读取中…</p>
            ) : (
              <div className="space-y-4 text-xs text-gray-700">
                <div className="flex flex-wrap gap-2 items-center">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${typeColors[detail.memory.memory_type] || 'bg-gray-100'}`}>{detail.memory.type_label}</span>
                  <span className="text-gray-500">来源：<b className="text-gray-800">{detail.memory.source_label}</b></span>
                  <span className="text-gray-500">项目：{detail.memory.project_id ? (detail.memory.project_name || detail.memory.project_id) : '跨项目经验（无项目归属）'}</span>
                </div>
                <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
                  <span>创建 {formatDbTime(detail.memory.created_at)}</span>
                  <span>更新 {detail.memory.updated_at ? formatDbTime(detail.memory.updated_at) : '（未更新）'}</span>
                  <span>注入 {detail.roi.injected} 次 · 约 {detail.roi.chars} 字</span>
                  <span>结局：完成 {detail.roi.completed} · 失败 {detail.roi.failed} · 待定 {detail.roi.pending}</span>
                  <span>引用 {detail.memory.use_count} 次 · 实践 {detail.memory.success_count} 成 / {detail.memory.failure_count} 败</span>
                </div>

                <div>
                  <p className="text-gray-500 mb-1">正文</p>
                  {detail.memory.memory_type === MEM_TYPE_DELETED
                    ? <p className="text-stone-600">正文已清除（墓碑）——缘由：{detail.memory.deleted_reason || '（未记）'}；删除于 {detail.memory.deleted_at ? formatDbTime(detail.memory.deleted_at) : '（未记）'}</p>
                    : <p className="whitespace-pre-wrap bg-gray-50 rounded-lg p-2 text-gray-800">{detail.memory.content}</p>}
                </div>

                {detail.evidence && (
                  <div>
                    <p className="text-gray-500 mb-1">证据</p>
                    <pre className="bg-gray-50 rounded-lg p-2 text-[10px] overflow-x-auto whitespace-pre-wrap text-gray-700">{JSON.stringify(detail.evidence, null, 2)}</pre>
                  </div>
                )}

                <div>
                  <p className="text-gray-500 mb-1">注入历史（最近 {detail.injections.length} 条）</p>
                  {detail.injections.length === 0 ? <p className="text-gray-400">尚无注入记录</p> : (
                    <div className="space-y-1">
                      {detail.injections.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 flex-wrap text-[10px] text-gray-600">
                          <span className="text-gray-800 truncate max-w-[14rem]" title={r.task_title || r.task_id}>{r.task_title || r.task_id}</span>
                          <span>{r.source_label}</span>
                          <span>{r.chars} 字 / 约 {r.est_tokens} token</span>
                          <span className={r.outcome === 'failed' ? 'text-red-500' : r.outcome === 'completed' ? 'text-emerald-600' : 'text-gray-400'}>{r.outcome || '待定'}</span>
                          <span className="text-gray-400">{formatDbTime(r.updated_at || r.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-gray-500 mb-1">改账历史（人工新增/修订/遗忘）</p>
                  {detail.history.length === 0 ? <p className="text-gray-400">无人工改账记录</p> : (
                    <div className="space-y-1">
                      {detail.history.map((h) => (
                        <div key={h.id} className="text-[10px] text-gray-600 flex items-center gap-2 flex-wrap">
                          <span className="text-gray-800">{h.action}</span>
                          <span>{h.actor_kind}{h.actor_ref ? `（${h.actor_ref}）` : ''}</span>
                          <span className="text-gray-400">{formatDbTime(h.created_at)}</span>
                          <span className="text-gray-400 truncate max-w-[18rem]" title={JSON.stringify(h.detail)}>{JSON.stringify(h.detail)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {detail.memory.memory_type !== MEM_TYPE_DELETED && (
                  <div className="border-t pt-3">
                    <p className="text-gray-500 mb-1 flex items-center gap-1"><Pencil className="w-3 h-3"/>修订</p>
                    <textarea value={editContent} onChange={(e)=>setEditContent(e.target.value)} rows={5} className="w-full border rounded-lg p-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <p className="text-[10px] text-gray-400 mt-1">改正文即视为「{MEM_SOURCE_LABEL.user_correction}」（来源将记为 {MEM_SOURCE_LABEL.user_correction}）；只改类型/重要度不动来源。</p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <select value={editType} onChange={(e)=>setEditType(e.target.value)} className="px-2 py-1 border rounded-lg text-xs bg-white">
                        {TYPE_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                      <label className="text-[11px] text-gray-500 flex items-center gap-1">重要度
                        <input type="number" step="0.1" min="0" max="1" value={editImportance} onChange={(e)=>setEditImportance(e.target.value)} className="w-20 px-2 py-1 border rounded-lg text-xs" />
                      </label>
                      <button onClick={() => void handleRevise()} disabled={saving} className="px-3 py-1 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 disabled:opacity-50">保存修订</button>
                      <button onClick={() => void handleDelete(detail.memory.id)} className="px-3 py-1 bg-red-50 text-red-600 rounded-lg text-xs hover:bg-red-100">遗忘此记忆</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== 新增记忆 ===== */}
      {addOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={() => setAddOpen(false)}>
          <div className="w-[30rem] max-w-[92vw] bg-white shadow-xl rounded-xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-800">新增记忆</h3>
              <button onClick={() => setAddOpen(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4"/></button>
            </div>
            <div className="space-y-2">
              <textarea value={addContent} onChange={(e)=>setAddContent(e.target.value)} rows={5} placeholder="要记住的内容…" className="w-full border rounded-lg p-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <div className="flex items-center gap-2 flex-wrap">
                <select value={addProject} onChange={(e)=>setAddProject(e.target.value)} className="px-2 py-1 border rounded-lg text-xs bg-white">
                  <option value="">跨项目（无项目归属）</option>
                  {projList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={addType} onChange={(e)=>setAddType(e.target.value)} className="px-2 py-1 border rounded-lg text-xs bg-white">
                  {TYPE_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                <label className="text-[11px] text-gray-500 flex items-center gap-1">重要度
                  <input type="number" step="0.1" min="0" max="1" value={addImportance} onChange={(e)=>setAddImportance(e.target.value)} className="w-20 px-2 py-1 border rounded-lg text-xs" />
                </label>
              </div>
              <p className="text-[10px] text-gray-400">来源将记为「手动新增」，并写一条审计（谁在何时新增）。</p>
              {notice?.kind === 'err' && <p className="text-[11px] text-red-600">{notice.text}</p>}
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setAddOpen(false)} className="px-3 py-1.5 border rounded-lg text-xs hover:bg-gray-50">取消</button>
                <button onClick={() => void handleAdd()} disabled={saving} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 disabled:opacity-50">保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>);
}
