import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projects, invoke, license as licenseApi } from '../lib/ipc';
// zx_20261022_3 批九: 项目用量/档位差异取 main 真源（`core/tier-usage.ts`）；本页不自行数库或猜上限。
import type { TierUsagePayload } from '../../../src/main/core/tier-usage.js';
import { useLiveQuery } from '../lib/useLiveQuery';
import { FreshnessPill } from '../components/FreshnessPill';
import DeleteProjectDialog from '../components/DeleteProjectDialog';
import { PROJECT_STATUS_LABEL, statusText } from '../lib/status-view';
import { Plus, Edit, Trash2, Play, Pause, Check, Archive, FolderKanban, Copy, Brain, Search } from 'lucide-react';

interface Project {
  id: string; name: string; description: string; status: string;
  cron_schedule?: string; cron_timezone?: string; working_dir?: string; context_json?: string;
  sandbox_mode?: string; autonomous_mode?: string;
  taskStats?: { total: number; completed: number };
  // zx_20261018_3 批五「显」: 统计取数失败 ⇒ 界面写"统计不可用"（不伪造 0）。
  taskStatsUnavailable?: boolean;
  // zx_20260913 M2-4(名实相符): 分项键不固定——main 侧由 GROUP BY type **实得**展开 ⇒ total + 任意类型键。
  // 旧写法把 mcp/a2a/ui/doc 声明为必有，而实得里它们可能整键不存在（类型没产出时）。
  deliverableStats?: { total: number } & Record<string, number>;
  tokenStats?: { total_tokens: number };
  budget?: { max_tokens_per_task?: number; max_cost_usd_per_task?: number };
  rhythm?: { activeHourStart?: number; activeHourEnd?: number; maxConcurrency?: number };
  lastActive?: string; staleness?: string;
  // zx_20261012_1 批四: 示例项目隔离标记（1=示例）——渲染层据此打「示例」徽标（真源在 main 侧 core/sample-project.ts）。
  is_sample?: number;
  created_at: string; updated_at: string;
}

const COMMON_TIMEZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Seoul', 'Asia/Kolkata', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney', 'UTC'];
const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: '每30分钟', expr: '*/30 * * * *' },
  { label: '每小时', expr: '0 * * * *' },
  { label: '每天9:00', expr: '0 9 * * *' },
  { label: '每天18:00', expr: '0 18 * * *' },
  { label: '每周一9:00', expr: '0 9 * * 1' },
  { label: '每月1号9:00', expr: '0 9 1 * *' },
];

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  // zx_20261029_1「知」: 创建后如实告知"须知是否已排队生成"（不静默）。
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const emptyForm = { name: '', description: '', cron_schedule: '', cron_timezone: 'Asia/Shanghai', working_dir: '', cron_task_title: '', cron_task_desc: '', cron_run_command: '', sandbox_mode: 'workspace', autonomous_mode: 'off', backlog: '', budget_tokens: '', budget_cost: '', rhythm_start: '0', rhythm_end: '24', rhythm_conc: '2' };
  const [form, setForm] = useState({ ...emptyForm });

  // A1/A2 (2026-09-04_2): useLiveQuery 统一保鲜——loader 返回增强项目列表；
  // 实时类命中即自动刷新（无常·保鲜：数据变化事件驱动，超 90s 无事件才提示 stale）
  const q = useLiveQuery<Project[]>(async () => {
    // zx_20261018_3 批五「显」: 项目列表 + 任务统计**各一次调用**（此前对每个项目各调一次
    //   `tasks.list` = N+1 IPC，且把失败写成 `{total:0}`）。统计单独取：它失败只影响统计列，
    //   不拖垮项目列表，也不把失败伪造成"这项目真没任务"。
    const [taskData, statsRes] = await Promise.all([
      projects.list() as unknown as Promise<Project[]>,
      invoke<{ stats: Record<string, { total: number; completed: number }> }>('projects:stats').catch(() => null),
    ]);
    return taskData.map((p) => {
      if (statsRes) p.taskStats = statsRes.stats?.[p.id] ?? { total: 0, completed: 0 };
      else { p.taskStats = undefined; p.taskStatsUnavailable = true; }
      // 解析 context_json 获取预算和节奏
      try {
        const ctx = JSON.parse(p.context_json || '{}');
        if (ctx.budget) p.budget = ctx.budget as Project['budget'];
        if (ctx.rhythm) p.rhythm = ctx.rhythm as Project['rhythm'];
      } catch {}
      return p;
    });
  }, [], {
    // zx_20260906_1 4d: 补 deliverable.status_changed(retire/流转后项目卡产出物计数即时刷新)/task.awaiting_input(待审批即时)
    liveTypes: ['task.status_changed', 'task.completed', 'task.failed', 'project.status_changed', 'deliverable.registered', 'deliverable.status_changed', 'task.awaiting_input'],
    debounceMs: 1200,
  });
  const list = q.data ?? [];

  // zx_20261022_3 批九: 项目数用量（含档位上限）。建/删/克隆后重取——界面上的"已用 x/y"须跟库走。
  const [usage, setUsage] = useState<TierUsagePayload | null>(null);
  const loadUsage = () => { licenseApi.usage().then(setUsage).catch(() => { /* 读不到就不显示用量行 */ }); };
  useEffect(() => { loadUsage(); }, []);
  const projectLimit = usage?.projects.limit ?? 0;
  const atProjectLimit = !!usage && projectLimit > 0 && usage.projects.used >= projectLimit;
  const upgradeGains = usage ? [...usage.upgrade.quotas, ...usage.upgrade.capabilities] : [];

  async function handleSave() {
    try {
      const budget = (form.budget_tokens || form.budget_cost) ? { max_tokens_per_task: form.budget_tokens ? parseInt(form.budget_tokens) : undefined, max_cost_usd_per_task: form.budget_cost ? parseFloat(form.budget_cost) : undefined } : undefined;
      const rhythm = (form.rhythm_start !== '0' || form.rhythm_end !== '24' || form.rhythm_conc !== '2') ? { activeHourStart: parseInt(form.rhythm_start) || 0, activeHourEnd: parseInt(form.rhythm_end) || 24, maxConcurrency: parseInt(form.rhythm_conc) || 2 } : undefined;
      const backlog = form.backlog.trim() ? form.backlog.split('\n').map(s => s.trim()).filter(Boolean) : [];
      const body = {
        name: form.name,
        description: form.description,
        cron_schedule: form.cron_schedule || undefined,
        cron_timezone: form.cron_schedule ? form.cron_timezone : undefined,
        working_dir: form.working_dir || undefined,
        cron_create_task: form.cron_schedule && form.cron_task_title ? { title: form.cron_task_title, description: form.cron_task_desc } : undefined,
        cron_run_command: form.cron_run_command || undefined,
        sandbox_mode: form.sandbox_mode,
        autonomous_mode: form.autonomous_mode,
        backlog: backlog.length > 0 ? backlog : undefined,
        budget,
        rhythm,
      };
      if (editing) {
        await projects.update(editing.id, body);
        setNotice('');
      } else {
        const created = await projects.create(body) as { initBrief?: { state?: string; reason?: string } };
        const ib = created?.initBrief;
        setNotice(
          ib?.state === 'queued'
            ? '项目已创建，正在后台读取工作目录生成「项目须知」，可在项目详情页查看。'
            : ib?.state === 'skipped'
              ? `项目已创建；未生成项目须知：${ib.reason || '工作目录不可用'}。`
              : '',
        );
      }
      setError('');
      setShowModal(false); setEditing(null);
      setForm({ ...emptyForm }); await q.reload(); loadUsage();
    } catch (e) { setError((e as Error).message); }
  }

  function openCreate() { setEditing(null); setNotice(''); setForm({ ...emptyForm }); setShowModal(true); }
  function openEdit(p: Project) {
    setEditing(p);
    const ctx = (() => { try { return JSON.parse(p.context_json || '{}'); } catch { return {}; } })();
    const bgt = ctx.budget as { max_tokens_per_task?: number; max_cost_usd_per_task?: number } | undefined;
    const rtm = ctx.rhythm as { activeHourStart?: number; activeHourEnd?: number; maxConcurrency?: number } | undefined;
    const ct = ctx.cron_create_task as { title?: string; description?: string } | undefined;
    setForm({
      ...emptyForm,
      name: p.name, description: p.description || '', cron_schedule: p.cron_schedule || '',
      cron_timezone: p.cron_timezone || 'Asia/Shanghai',
      working_dir: p.working_dir || '',
      cron_task_title: ct?.title || '', cron_task_desc: ct?.description || '',
      cron_run_command: (ctx.cron_run_command as string) || '',
      sandbox_mode: p.sandbox_mode || 'workspace',
      autonomous_mode: p.autonomous_mode || 'off',
      backlog: (ctx.backlog as string[] || []).join('\n'),
      budget_tokens: bgt?.max_tokens_per_task ? String(bgt.max_tokens_per_task) : '',
      budget_cost: bgt?.max_cost_usd_per_task ? String(bgt.max_cost_usd_per_task) : '',
      rhythm_start: rtm?.activeHourStart != null ? String(rtm.activeHourStart) : '0',
      rhythm_end: rtm?.activeHourEnd != null ? String(rtm.activeHourEnd) : '24',
      rhythm_conc: rtm?.maxConcurrency != null ? String(rtm.maxConcurrency) : '2',
    });
    setShowModal(true);
  }

  // zx_20261012_3 批一: 不再用原生 `confirm()`——弹窗里带「同时删除项目数据目录」复选框（默认勾选），
  //   并把"将清哪个盘"的**真实路径**如实给用户看（`DeleteProjectDialog` 一处真源）。
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  async function confirmDelete(removeDataDir: boolean) {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    try { await projects.delete(id, { removeDataDir }); await q.reload(); loadUsage(); }
    catch (e) { setError((e as Error).message); }
  }

  async function handleClone(id: string) {
    try { await projects.clone(id); await q.reload(); loadUsage(); }
    catch (e) { setError((e as Error).message); }
  }
  async function handleStatus(id: string, status: string) {
    try { await projects.updateStatus(id, status); await q.reload(); }
    catch (e) { setError((e as Error).message); }
  }

  const statusBadge = (s: string) => {
    const map: Record<string, string> = { active: 'bg-green-100 text-green-700', paused: 'bg-yellow-100 text-yellow-700', completed: 'bg-blue-100 text-blue-700', archived: 'bg-gray-100 text-gray-500' };
    return `text-xs px-2 py-0.5 rounded-full font-medium ${map[s] || 'bg-gray-100'}`;
  };

  if (q.loading && q.data == null) return <div className="flex items-center justify-center h-64"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;

  // 分页：先搜索过滤，再分页
  const filteredList = search ? list.filter(p => (p.name + (p.description || '')).toLowerCase().includes(search.toLowerCase())) : list;
  const totalPages = Math.max(1, Math.ceil(filteredList.length / PAGE_SIZE));
  const paginatedList = filteredList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">项目管理</h2>
        <div className="flex items-center gap-2">
          {/* zx_20261022_3 批九: 项目数用量——达到档位上限时转黄，与下方横幅同源。 */}
          {usage && (
            <span className={`text-xs ${atProjectLimit ? 'font-medium text-amber-600' : 'text-gray-500'}`}>
              项目 {projectLimit === 0 ? `${usage.projects.used}（不限）` : `${usage.projects.used}/${projectLimit}`}
            </span>
          )}
          <FreshnessPill q={q} />
          <button onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors">
            <Plus className="w-4 h-4" />新建项目
          </button>
        </div>
      </div>

      {/* zx_20261022_3 批九: 已达项目上限时把**真实**升级差异摆出来（能力名取自 tier-catalog，
          上限取自 TIER_LIMITS，不另写卖点）。未达上限不占版面。 */}
      {atProjectLimit && usage && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          项目已用 {usage.projects.used}/{projectLimit}（{usage.tierLabel}上限）。
          {usage.upgrade.toLabel && upgradeGains.length > 0
            ? <>升级{usage.upgrade.toLabel}可获得：{upgradeGains.join('、')}。</>
            : <>当前已是最高档。</>}
        </div>
      )}

      {(error || q.error) && <p className="text-red-500 text-sm mb-4">{error || q.error}</p>}
      {notice && (
        <div className="mb-4 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-800 flex items-start justify-between gap-3">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="text-cyan-600 hover:text-cyan-800 shrink-0">关闭</button>
        </div>
      )}

      <div className="relative mb-4 w-64">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
        <input value={search} onChange={e=>setSearch(e.target.value)} className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="搜索项目名称或描述..."/>
      </div>

      {paginatedList.length === 0 ? (
        <div className="bg-white rounded-lg border p-12 text-center text-gray-400">
          <FolderKanban className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg mb-2">暂无项目</p>
          <p className="text-sm">点击"新建项目"创建第一个项目</p>
        </div>
      ) : (
        <div className="space-y-3">
          {paginatedList.map(p => (
            <div key={p.id} className="bg-white rounded-lg border p-4 hover:shadow-sm transition-shadow">
              <div className="flex items-start justify-between">
                <div className="flex-1 cursor-pointer" onClick={() => navigate(`/projects/${p.id}`)}>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-gray-900 hover:text-blue-600">{p.name}</h3>
                    {p.is_sample === 1 && <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 border border-amber-200">示例</span>}
                    <span className={statusBadge(p.status)}>{statusText(PROJECT_STATUS_LABEL, p.status)}</span>
                    {p.staleness === 'stale' && <span className="text-xs text-orange-500">● 长时间未更新</span>}
                  </div>
                  {p.description && <p className="text-sm text-gray-500 mb-2">{p.description.slice(0,120)}</p>}
                  <div className="flex items-center gap-4 text-xs text-gray-400 flex-wrap">
                    {p.taskStatsUnavailable
                      ? <span className="text-orange-500" title="任务统计取数失败——不是「没有任务」">统计不可用</span>
                      : <span>任务 {p.taskStats?.total||0}(✅{p.taskStats?.completed||0})</span>}
                    {p.deliverableStats?.total ? <span>产出物 {p.deliverableStats.total} (MCP:{p.deliverableStats.mcp||0} A2A:{p.deliverableStats.a2a||0})</span> : null}
                    {p.tokenStats?.total_tokens ? <span>Token {p.tokenStats.total_tokens>=1000?(p.tokenStats.total_tokens/1000).toFixed(0)+'K':String(p.tokenStats.total_tokens)}</span> : null}
                    {p.cron_schedule && <span className="font-mono">⏰ {p.cron_schedule}</span>}
                    {p.budget?.max_tokens_per_task ? <span title="任务Token预算">💰 {p.budget.max_tokens_per_task>=1000?(p.budget.max_tokens_per_task/1000).toFixed(0)+'K':String(p.budget.max_tokens_per_task)}</span> : null}
                    {p.rhythm && (p.rhythm.activeHourStart!=null || p.rhythm.activeHourEnd!=null) && <span title={`活跃时间 ${p.rhythm.activeHourStart??''}-${p.rhythm.activeHourEnd??''}点`}>🕐 {p.rhythm.activeHourStart??0}-{p.rhythm.activeHourEnd??24}点</span>}
                    {p.staleness==='stale' && <span className="text-orange-500">● 低活跃</span>}
                    {p.staleness==='dormant' && <span className="text-red-400">● 不活跃</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-4">
                  {p.status === 'active' && <button onClick={() => handleStatus(p.id, 'paused')} title="暂停" className="p-1.5 hover:bg-yellow-50 rounded"><Pause className="w-4 h-4 text-yellow-600" /></button>}
                  {p.status === 'paused' && <button onClick={() => handleStatus(p.id, 'active')} title="恢复" className="p-1.5 hover:bg-green-50 rounded"><Play className="w-4 h-4 text-green-600" /></button>}
                  {(p.status === 'active' || p.status === 'paused') && <button onClick={() => handleStatus(p.id, 'completed')} title="完成" className="p-1.5 hover:bg-blue-50 rounded"><Check className="w-4 h-4 text-blue-600" /></button>}
                  {p.status === 'completed' && <button onClick={() => handleStatus(p.id, 'archived')} title="归档" className="p-1.5 hover:bg-gray-100 rounded"><Archive className="w-4 h-4 text-gray-500" /></button>}
                  <button onClick={() => openEdit(p)} title="编辑" className="p-1.5 hover:bg-gray-100 rounded"><Edit className="w-4 h-4 text-gray-500" /></button>
                  <button onClick={() => handleClone(p.id)} title="克隆" className="p-1.5 hover:bg-purple-50 rounded"><Copy className="w-4 h-4 text-purple-500" /></button>
                  <button onClick={() => navigate(`/projects/${p.id}/memories`)} title="项目记忆" className="p-1.5 hover:bg-green-50 rounded"><Brain className="w-4 h-4 text-green-500" /></button>
                  <button onClick={() => setPendingDelete({ id: p.id, name: p.name })} title="删除" className="p-1.5 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4 text-red-500" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 分页 */}
      {filteredList.length > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 mt-4 text-sm">
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">上一页</button>
          <span className="text-gray-500">第 {page + 1} / {totalPages} 页（共 {filteredList.length} 个）</span>
          <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-40">下一页</button>
        </div>
      )}

      {/* 删除确认弹窗（带「同时删除项目数据目录」复选框，默认勾选） */}
      {pendingDelete && (
        <DeleteProjectDialog
          projectId={pendingDelete.id}
          projectName={pendingDelete.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}

      {/* 创建/编辑弹窗 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">{editing ? '编辑项目' : '新建项目'}</h3>
            <div className="space-y-3">
              <div><label className="block text-sm font-medium mb-1">名称 *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="项目名称" /></div>
              <div><label className="block text-sm font-medium mb-1">描述</label><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" rows={2} placeholder="项目描述（可选）" /></div>
              <div><label className="block text-sm font-medium mb-1">定时调度 (cron)</label><div className="flex flex-wrap gap-1.5 mb-2">{CRON_PRESETS.map(p => <button key={p.expr} type="button" onClick={() => setForm({ ...form, cron_schedule: form.cron_schedule === p.expr ? '' : p.expr })} className={`px-2 py-1 rounded text-xs border ${form.cron_schedule === p.expr ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>{p.label}</button>)}</div><input value={form.cron_schedule} onChange={e => setForm({ ...form, cron_schedule: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" placeholder="或手动输入: 分 时 日 月 周（可选）" /></div>
              {form.cron_schedule && <>
                <div><label className="block text-sm font-medium mb-1">时区</label><select value={form.cron_timezone} onChange={e => setForm({ ...form, cron_timezone: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">{COMMON_TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}</select></div>
                <div><label className="block text-sm font-medium mb-1">定时任务标题（可选，设置后 cron 自动创建该任务）</label><input value={form.cron_task_title} onChange={e => setForm({ ...form, cron_task_title: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如：定时刷新最新数据" /></div>
                {form.cron_task_title && <div><label className="block text-sm font-medium mb-1">定时任务描述</label><textarea value={form.cron_task_desc} onChange={e => setForm({ ...form, cron_task_desc: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" rows={2} placeholder="任务详细描述，AI Agent 据此执行" /></div>}
                <div><label className="block text-sm font-medium mb-1">定时执行命令（可选，设置后直接执行 shell 命令绕过 AI）</label><input value={form.cron_run_command} onChange={e => setForm({ ...form, cron_run_command: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs" placeholder="cd scripts && python3 run.py" /></div>
              </>}
              <div><label className="block text-sm font-medium mb-1">工作目录</label><input value={form.working_dir} onChange={e => setForm({ ...form, working_dir: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs" placeholder="留空自动创建（可选）" /></div>
              <div><label className="block text-sm font-medium mb-1">安全沙箱</label><select value={form.sandbox_mode} onChange={e => setForm({ ...form, sandbox_mode: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="workspace">工作区读写（默认）</option><option value="strict">严格只读</option><option value="off">无限制</option></select></div>
              <div><label className="block text-sm font-medium mb-1">资源节奏</label><div className="flex items-center gap-2 text-sm"><span>活跃</span><input type="number" value={form.rhythm_start} onChange={e => setForm({ ...form, rhythm_start: e.target.value })} className="w-16 px-2 py-1 border rounded-lg text-sm" /> 时 - <input type="number" value={form.rhythm_end} onChange={e => setForm({ ...form, rhythm_end: e.target.value })} className="w-16 px-2 py-1 border rounded-lg text-sm" /> 时 <span className="ml-2">最大并行</span><input type="number" value={form.rhythm_conc} onChange={e => setForm({ ...form, rhythm_conc: e.target.value })} className="w-16 px-2 py-1 border rounded-lg text-sm" /></div><p className="text-[10px] text-gray-400 mt-1">默认全天活跃/最大2并行</p></div>
              <div><label className="block text-sm font-medium mb-1">Token 预算</label><div className="flex gap-2"><input value={form.budget_tokens} onChange={e => setForm({ ...form, budget_tokens: e.target.value })} className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="单任务Token上限(如400000)" /><input value={form.budget_cost} onChange={e => setForm({ ...form, budget_cost: e.target.value })} className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="单任务费用上限¥(如3.6)" /></div><p className="text-[10px] text-gray-400 mt-1">费用上限留空 = 不设金额闸（任务仅按 Token 预算收敛）；金额闸只在填写后生效，系统不再自动兜底一个默认金额</p></div>
              <div><label className="block text-sm font-medium mb-1">自治模式</label><select value={form.autonomous_mode} onChange={e => setForm({ ...form, autonomous_mode: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="off">关闭（仅人工）</option><option value="supervised">半自动（自动创建需确认）</option><option value="auto">全自动（自动创建并执行）</option></select></div>
              {form.autonomous_mode !== 'off' && <div><label className="block text-sm font-medium mb-1">待办列表 (backlog)</label><textarea value={form.backlog} onChange={e => setForm({ ...form, backlog: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" rows={3} placeholder="每行一项待办任务" /></div>}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
              <button onClick={handleSave} disabled={!form.name} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
