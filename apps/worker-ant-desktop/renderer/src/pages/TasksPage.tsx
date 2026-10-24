import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { projects, tasks as tasksApi, invoke, newClientRequestId } from '../lib/ipc';
import { useSettings } from '../lib/settingsStore';
import { Plus, Play, Pause, RotateCcw, RefreshCw, Filter, Edit, LayoutList, Columns, ChevronRight, ChevronDown, Check, Trash2, AlertTriangle } from 'lucide-react';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// zx_20260913 M3-5: 前置阻塞态判据唯一真源（与详情页同尺——renderer 是词表第二落点，不另抄一份）
import { depBlockInfo } from '../../../src/main/core/dep-graph.js';
// 库内时间（UTC 且不带 Z）→ 本地展示 / Date：与产出物各页同一份换算
import { formatDbTime, parseDbTime } from '../lib/deliverable-view';
// zx_20260930 M4-4: 任务状态词表**唯一真源**（此前本文件手抄一份，缺 investigating）
import { TASK_STATUS_LABEL, PROJECT_STATUS_LABEL, statusText } from '../lib/status-view';

// zx_20260908 M2(B2a): task:list 派生列——已完成任务成果摘要(deliverable_count/primary_count/acc p-t)
interface Task { id: string; project_id: string; title: string; description?: string; status: string; priority: number; source: string; parent_task_id?: string; depends_on?: string; acceptance_criteria?: string; context_json?: string; created_at: string; updated_at: string; deliverable_count?: number; primary_count?: number; acc_total?: number | null; acc_passed?: number | null; }
interface Project { id: string; name: string; status: string; }

const STATUS_COLOR: Record<string, string> = { pending:'bg-gray-100 text-gray-600', executing:'bg-yellow-100 text-yellow-700', running:'bg-yellow-100 text-yellow-700', completed:'bg-green-100 text-green-700', failed:'bg-red-100 text-red-600', paused:'bg-orange-100 text-orange-600', /* zx_20260930 M11-5: `stabilizing` 原无档 ⇒ 徽标落灰底(与"不认识的态"混同)；人工出口在任务详情页 */ stabilizing:'bg-amber-50 text-amber-700' };

function isStuck(t: Task): boolean { if (!['executing','running','preparing'].includes(t.status)) return false; const d = parseDbTime(t.updated_at); if (!d) return false; return Date.now()-d.getTime()>30*60*1000; }
function getDynamicPriority(t: Task): number|null { try { const ctx=JSON.parse(t.context_json||'{}'); return ctx.dynamic_priority as number||null; } catch{return null;} }
function getCtx(t: Task): Record<string, unknown> { try { return JSON.parse(t.context_json||'{}'); } catch { return {}; } }
function getQualityScore(t: Task): number|null { const q = getCtx(t).completion_quality as { score?: number } | undefined; return q?.score ?? null; }
function getTokensUsed(t: Task): number|null { return (getCtx(t).tokens_used as number) ?? null; }
function getBudgetMax(t: Task): number|null { return (getCtx(t).budget_max_tokens as number) ?? null; }
// C1 (2026-09-03_1): 策略来源 + 卡住/动态优先级解释
const STRATEGY_SOURCE_LABEL: Record<string, string> = { learned: '已学习', natural: '自然选择', default: '默认' };
function getStrategySource(t: Task): string|null { const s = getCtx(t).strategy_source as string|undefined; return s && ['learned','natural','default'].includes(s) ? s : null; }
function getBottleneckExplain(t: Task): string|null {
  const b = getCtx(t).bottleneck_score as { blocking_count?: number; resource_criticality?: number; time_sensitivity?: number; is_principal_contradiction?: boolean } | undefined;
  const dp = getDynamicPriority(t);
  if (!b && dp == null) return null;
  const parts: string[] = [];
  if (b) { parts.push(`阻塞 ${b.blocking_count ?? 0}`); if (b.resource_criticality != null) parts.push(`资源 ${Number(b.resource_criticality).toFixed(2)}`); if (b.time_sensitivity != null) parts.push(`时间敏感 ${Number(b.time_sensitivity).toFixed(2)}`); if (b.is_principal_contradiction) parts.push('主要矛盾'); }
  if (dp != null) parts.push(`动态优先级 ${dp}`);
  return parts.join(' · ');
}

const PAGE_STATE_KEY = 'wa_tasks_page_state';
// zx_20261018_3 D8: 折叠集合按项目分开存；没有记录的项目在渲染前用这一个共享空集兜底。
const EMPTY_COLLAPSED: Set<string> = new Set();
function loadPageState(): { pid: string; filter: 'all'|'active'|'completed' } {
  try { const s = localStorage.getItem(PAGE_STATE_KEY); if (s) { const p = JSON.parse(s); if (p && typeof p.pid === 'string') return { pid: p.pid, filter: ['all','active','completed'].includes(p.filter) ? p.filter : 'active' }; } } catch {}
  return { pid: '', filter: 'active' };
}

export default function TasksPage() {
  const navigate = useNavigate();
  // zx_20260908 M2(B2a): 任务列表成果摘要开关（deliverable.task_achievement_summary）
  const settings = useSettings();
  const summaryOn = boolSetting(settings['deliverable.task_achievement_summary']);  // zx_20260909_1 M4(Z1 为之于未有): plan.link_at_create=false 隐藏新建表单"关联方案"下拉(仅留详情页事后关联)
  const linkOn = boolSetting(settings['plan.link_at_create']);
  const [projList, setProjList] = useState<Project[]>([]);
  const [selectedPid, setSelectedPid] = useState(() => loadPageState().pid);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  // zx_20261018_3 批五「显」: 列表真分页——`tasksTotal` 是服务端全量口径，界面对照"已加载 K / 共 M"。
  const [tasksTotal, setTasksTotal] = useState(0);
  const PAGE_LIMIT = 100;
  // 建单对话框的父任务候选：打开时按页取全本项目任务（弹窗按需取，不让列表页常驻载全量）。
  const [parentCandidates, setParentCandidates] = useState<Task[]>([]);
  const [filter, setFilter] = useState<'all'|'active'|'completed'|'await'>(() => loadPageState().filter);
  const [view, setView] = useState<'list'|'kanban'>('list');
  const [sortBy, setSortBy] = useState<'priority'|'title'|'status'|'date'>('date'); // zx_20260904_6 D7: 默认按时间降序(最近创建在上)
  const [sortAsc, setSortAsc] = useState(false);
  // zx_20261018_3 D8（组5 实机照出）: 折叠状态此前是**全局**一份 + 全局 userCollapsedRef——
  //   在怡寿里手动折叠过之后切到 A股，默认折叠因"用户已手动操作"而不再重算 ⇒ A股全部展开。
  //   现按项目各存一份；手动操作只标记当前项目。
  const [collapsedByPid, setCollapsedByPid] = useState<Record<string, Set<string>>>({});
  const collapsed = (selectedPid && collapsedByPid[selectedPid]) || EMPTY_COLLAPSED;
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  // zx_20261013_1 批二(K7): attachmentPaths——建任务时一并挂的本地件（绝对路径，main 侧落盘+写 context_json）。
  const [newTask, setNewTask] = useState({ title:'', description:'', priority:0, acceptance_criteria:'', parentTaskId:'', planTaskId:'', attachmentPaths:[] as string[] });
  // zx_20260914 M0.6: 在途标志（体验层，挡"已在创建中"）+ 本次表单会话的幂等键（判据层的输入，见 lib/ipc.ts）。
  const [creating, setCreating] = useState(false);
  const createReqIdRef = useRef('');
  // zx_20260909_1 M4(Z1): 新建即选"关联方案(规划)"候选(plan:projectPlans 同项目方案任务)
  const [createPlans, setCreatePlans] = useState<Array<{ id: string; title: string; status: string; milestoneCount: number }>>([]);
  useEffect(() => {
    if (!showCreate || !selectedPid) return;
    let cancelled = false;
    invoke<{ plans: Array<{ id: string; title: string; status: string; milestoneCount: number }> }>('plan:projectPlans', { projectId: selectedPid })
      .then((r) => { if (!cancelled && r) setCreatePlans(Array.isArray(r.plans) ? r.plans : []); }).catch(() => { setCreatePlans([]); });
    // zx_20261018_3 批五「显」: 父任务候选须是**全项目**（列表页只载第一页）——弹窗打开时按页取全；
    //   取不动则退回已加载页，不假装"没有别的父任务"。
    tasksApi.listAll(selectedPid)
      .then((rows) => { if (!cancelled) setParentCandidates(rows as unknown as Task[]); })
      .catch(() => { if (!cancelled) setParentCandidates([]); });
    return () => { cancelled = true; };
  }, [showCreate, selectedPid]);
  // zx_20260914 M0.6: 一次表单会话 = 一次用户意图 ⇒ 打开面板时生成一个键，会话内所有提交共用它。
  useEffect(() => { if (showCreate) createReqIdRef.current = newClientRequestId(); }, [showCreate]);
  const [showEdit, setShowEdit] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [editForm, setEditForm] = useState({ title:'', description:'', priority:0, acceptance_criteria:'' });
  // 模板任务
  const [templates, setTemplates] = useState<Array<Record<string, unknown>>>([]);
  // D4: 列表实时执行进度（task.step_finished 轻量更新，免整表刷新）
  const [progressMap, setProgressMap] = useState<Record<string, { step: number; tokens: number; toolCalls: string }>>({});
  // 行内动作的「在途」与结果反馈：此前请求失败被 `catch {}` 静默吞掉——用户点了没反应也不知为何。
  // 反馈形状与产出物页同尺（3s 自动消失、成功绿/失败红）；在途期间该行动作不可再点（防重复提交）。
  const [acting, setActing] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const showToast = (msg: string, type: 'success' | 'error') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };
  const failMsg = (e: unknown) => (e as Error)?.message || '未知原因';

  useEffect(() => { loadProjects(); loadTemplates(); }, []);
  useEffect(() => { if(selectedPid) loadTasks(); }, [selectedPid]);
  // 持久化选中项目 + 任务类别，返回任务管理时恢复（避免重置为默认）
  useEffect(() => { try { localStorage.setItem(PAGE_STATE_KEY, JSON.stringify({ pid: selectedPid, filter })); } catch {} }, [selectedPid, filter]);
  // Phase A (2026-08-28 zx_5): 任务列表实时状态——订阅任务状态事件，防抖刷新列表（事上磨练：列表实时）
  // D4 (2026-09-01): 补 task.step_finished/task.memory_injected——step 事件轻量更新进度（免整表刷新），防抖同步
  useEffect(() => {
    if (!window.electronAPI?.onTaskEvent) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.electronAPI.onTaskEvent((event) => {
      if (event.projectId && event.projectId !== selectedPid) return;
      // 逐步执行事件：轻量更新该任务进度（第X步/token/工具），较长时间防抖整表同步避免卡顿
      if (event.type === 'task.step_finished' && event.taskId) {
        setProgressMap(prev => ({ ...prev, [event.taskId as string]: { step: Number(event.step) || 0, tokens: Number(event.totalTokens) || 0, toolCalls: String(event.toolCalls || '') } }));
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { loadTasks(); }, 1000);
        return;
      }
      // 记忆注入：低频事件，短防抖刷新（列表可显示注入状态）
      if (event.type === 'task.memory_injected') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { loadTasks(); }, 300);
        return;
      }
      // 状态变化：任务退出执行 → 清空其进度缓存
      if (event.type === 'task.status_changed' && event.taskId) {
        const ns = String(event.newStatus || event.new_status || '');
        if (ns !== 'executing' && ns !== 'running') {
          setProgressMap(prev => { if (!prev[event.taskId as string]) return prev; const next = { ...prev }; delete next[event.taskId as string]; return next; });
        }
      }
      // zx_20260906_1 4a: 待审批/待回复实时——awaiting_input(门禁/ask_user 暂停)也触发列表刷新，消除"伪滞留"(DB 已 paused 但列表此前停在 executing)
      if (event.type === 'task.awaiting_input') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { loadTasks(); }, 300);
        return;
      }
      if (event.type !== 'task.status_changed' && event.type !== 'task.completed' && event.type !== 'task.failed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { loadTasks(); }, 300);
    });
    return () => { if (timer) clearTimeout(timer); unsubscribe(); };
  }, [selectedPid]);

  async function loadProjects() { try { const d=await projects.list() as unknown as Project[]; setProjList(d); const exists = d.some(p => p.id === selectedPid); if((!selectedPid || !exists) && d.length>0){const a=d.find(p=>p.status==='active')||d[0]; if(a?.id)setSelectedPid(a.id);} } catch{} }
  // zx_20261018_3 批五「显」: 首屏只取第一页（main 侧缺省 100/硬上限 500）；`append` 为真时续取下一页。
  //   失败时**保留已有行**（不让一次读故障把界面清空），也不把 total 归零（宁可显示上次的"共 M"）。
  async function loadTasks(append = false) {
    setLoading(true);
    try {
      let offset = append ? allTasks.length : 0;
      let acc: Task[] = append ? allTasks : [];
      let total = 0;
      // zx_20261019 缺陷 D3（批五分页的连带）: 父子可能被页边界切开——子任务在新的一侧进了页，
      //   父任务差几条落在下一页 ⇒ 子任务无父行承接被当孤儿提到顶层平铺（用户实机照出：
      //   全部任务底部两个"散行"，且不会自动折叠）。此时**有界地续取下一页**直到父行补齐；
      //   页大小与 offset 口径不变（只补边界那一两页），铺满/取空/5 页仍未补齐即停。
      for (let i = 0; i < 5; i++) {
        const d = await tasksApi.list(selectedPid, { limit: PAGE_LIMIT, offset }) as unknown as {
          rows: Task[]; total: number;
        };
        total = Number(d.total) || 0;
        const rows = d.rows || [];
        acc = [...acc, ...rows];
        offset += rows.length;
        const ids = new Set(acc.map((t) => t.id));
        const missingParent = acc.some((t) => t.parent_task_id && !ids.has(t.parent_task_id));
        if (!missingParent || rows.length === 0 || offset >= total) break;
      }
      setTasksTotal(total);
      setAllTasks(acc);
    } catch { /* keep last good view */ }
    setLoading(false);
  }
  async function loadTemplates() { try { const t = await tasksApi.templates(); setTemplates((t as Array<Record<string, unknown>>) || []); } catch { setTemplates([]); } }
  function applyTemplate(tplId: string) { const t = templates.find(x => x.id === tplId); if (t) setNewTask({ ...newTask, title: t.name as string, description: t.description as string }); }
  // 一个动作 = 一次在途标记 + 一条明确反馈（成功/失败各自有话说，不再静默）
  async function runAction(key: string, fn: () => Promise<unknown>, okMsg: string, failPrefix: string) {
    if (acting) return;
    setActing(key);
    try { await fn(); showToast(okMsg, 'success'); await loadTasks(); }
    catch (e) { showToast(`${failPrefix}：${failMsg(e)}`, 'error'); }
    finally { setActing(null); }
  }
  async function handleStatus(id: string, status: string) { await runAction(`${id}:status:${status}`, () => tasksApi.updateStatus(id, status), `已置为「${statusText(TASK_STATUS_LABEL, status)}」`, '状态更新失败'); }
  async function handleRetry(id: string) { await runAction(`${id}:retry`, () => tasksApi.retry(id), '已重新开始执行', '重试失败'); }
  async function handleResume(id: string) { await runAction(`${id}:resume`, () => tasksApi.resume(id), '已恢复执行', '恢复失败'); }
  async function handleInterrupt(id: string) { if (!confirm('确定中止此任务的当前执行？')) return; await runAction(`${id}:interrupt`, () => tasksApi.interrupt(id), '已中止当前执行', '中止失败'); }
  async function handleDelete(id: string) { if (!confirm('确定删除此任务？对话记录和产出物将被清除。')) return; await runAction(`${id}:delete`, () => tasksApi.delete(id), '任务已删除', '删除失败'); }
  // zx_20260914 M0.6(老子·为之于未有 / 康德·范畴穷尽): 一次点击只该创建一个任务。
  // 此前双击 = 两次并发 IPC = 两行（真库实证 f07ad74a/8d9be3f8 相隔 286ms 各建一份，各自跑完判型/目标/记忆）。
  // 两层：①在途标志挡"已在创建中"（体验）；②本次表单会话的键随提交上送，main 侧查—插幂等（判据）。
  // ②才是兜底——同一 tick 的两次点击 state 来不及变，但两次调用带的是**同一个键**。
  // zx_20261013_1 批二(K7): GUI 挂件——本地**选文件**（多选对话框）与**拖文件**（drag-drop）两条入口，
  //   都只收集盘上**绝对路径**；落盘与写 `context_json.attachments` 一律由 main 侧一条链完成（本层不碰字节）。
  //   去重按路径（同一件拖两次不该落两份账）。
  const addAttachmentPaths = (paths: string[]) => { if (paths.length === 0) return; setNewTask((prev) => ({ ...prev, attachmentPaths: Array.from(new Set([...prev.attachmentPaths, ...paths])) })); };
  const pickAttachments = async () => { try { const picked = await window.electronAPI?.openFilesDialog(); addAttachmentPaths(Array.isArray(picked) ? picked : []); } catch { /* 选文件失败静默——用户可重试 */ } };
  const dropAttachments = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // 拖入的 `File` 只有裸名，须经 `webUtils.getPathForFile`（preload 暴露）还原盘上路径。
    const paths: string[] = [];
    for (const f of Array.from(files)) { try { const p = window.electronAPI?.getPathForFile?.(f); if (p) paths.push(p); } catch { /* 单件取路径失败跳过 */ } }
    addAttachmentPaths(paths);
  };
  const removeAttachment = (p: string) => setNewTask((prev) => ({ ...prev, attachmentPaths: prev.attachmentPaths.filter((x) => x !== p) }));

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const reqId = createReqIdRef.current || (createReqIdRef.current = newClientRequestId());
      await tasksApi.create(selectedPid, newTask.title, newTask.description, newTask.priority, newTask.acceptance_criteria || undefined, newTask.parentTaskId || undefined, newTask.planTaskId || undefined, reqId, newTask.attachmentPaths.length > 0 ? newTask.attachmentPaths : undefined);
      setShowCreate(false); setNewTask({title:'',description:'',priority:0,acceptance_criteria:'',parentTaskId:'',planTaskId:'',attachmentPaths:[]}); setCreatePlans([]); loadTasks();
    } catch{} finally { setCreating(false); }
  }
  async function handleUpdate() {
    if (!editing || acting) return;
    setActing('update');
    try {
      await tasksApi.update(editing.id, { title: editForm.title, description: editForm.description, priority: editForm.priority, acceptance_criteria: editForm.acceptance_criteria || undefined });
      showToast('任务已更新', 'success');
      setShowEdit(false); setEditing(null); await loadTasks();
    } catch (e) { showToast(`更新失败：${failMsg(e)}`, 'error'); }
    finally { setActing(null); }
  }

  const activeStatuses = ['pending','planning','preparing','executing','running','paused','failed'];
  // C2 (2026-09-03_3): "放弃"= failed + reason=abandoned_by_user → 排除出活跃清单（可再恢复/重试，见"全部"）
  const isAbandoned = (t: Task): boolean => { try { const c = JSON.parse(t.context_json || '{}') as { reason?: string }; return c.reason === 'abandoned_by_user'; } catch { return false; } };
  const isActive = (t: Task): boolean => activeStatuses.includes(t.status) && !(t.status === 'failed' && isAbandoned(t));
  // zx_20260904_7 I2 (2026-09-04): 待回复 = paused 且含 awaiting_input / pending_approval（ask_user/审批类暂停，非手动暂停）
  const isAwaitingReply = (t: Task): boolean => { if (t.status !== 'paused') return false; try { const c = JSON.parse(t.context_json || '{}') as { awaiting_input?: unknown; pending_approval?: unknown }; return !!(c.awaiting_input || c.pending_approval); } catch { return false; } };
  const awaitCount = allTasks.filter(isAwaitingReply).length;
  // C1 (2026-09-04): id→title 映射，用于子任务"父:xxx"导航 chip
  const idTitleMap = new Map(allTasks.map((t) => [t.id, t.title]));
  // zx_20260907 M3(D2 复核补): 父任务下拉候选——当前项目内未归档任务(可引用已完成父任务造链)
  const parentOptions = (parentCandidates.length > 0 ? parentCandidates : allTasks)
    .filter((t) => t.project_id === selectedPid && t.status !== 'archived');
  const filtered = allTasks.filter(t=>filter==='all'?true:filter==='active'?isActive(t):filter==='await'?isAwaitingReply(t):t.status==='completed')
    .sort((a,b)=>{
      const mul = sortAsc ? 1 : -1;
      if (sortBy==='priority') return (a.priority - b.priority) * mul;
      if (sortBy==='title') return a.title.localeCompare(b.title) * mul;
      if (sortBy==='status') return a.status.localeCompare(b.status) * mul;
      if (sortBy==='date') return ((parseDbTime(a.created_at)?.getTime() ?? 0) - (parseDbTime(b.created_at)?.getTime() ?? 0)) * mul;
      return 0;
    });
  const activeCount = allTasks.filter(isActive).length;

  const toggleSort = (field: typeof sortBy) => {
    if (sortBy === field) setSortAsc(!sortAsc);
    else { setSortBy(field); setSortAsc(false); }
  };
  const toggleCollapse = (id: string) => {
    if (!selectedPid) return;
    userCollapsedRef.current.add(selectedPid);
    setCollapsedByPid(prev => {
      const next = new Set(prev[selectedPid] || []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...prev, [selectedPid]: next };
    });
  };

  // zx_20260908 优化3: 默认折叠"已完成且子子孙孙均已终态(completed/archived)"的任务——避免长列表堆满已完成主任务；
  // 若主任务下仍有未完成任务(非 completed/archived，含 pending/执行中/暂停/failed)则保持展开，不漏看未完成工作。
  // 用户手动折叠/展开后(userCollapsedRef 记下**哪个项目**)不再自动覆盖；项目各自判断。
  const userCollapsedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedPid || allTasks.length === 0) return;
    if (userCollapsedRef.current.has(selectedPid)) return;
    const childMap = new Map<string, Task[]>();
    for (const t of allTasks) { if (t.parent_task_id) { const l = childMap.get(t.parent_task_id) || []; l.push(t); childMap.set(t.parent_task_id, l); } }
    const hasUnfinishedDesc = (id: string): boolean => {
      for (const c of (childMap.get(id) || [])) {
        if (!['completed', 'archived'].includes(c.status)) return true;
        if (hasUnfinishedDesc(c.id)) return true;
      }
      return false;
    };
    const dflt = new Set<string>();
    for (const t of allTasks) {
      if ((childMap.get(t.id) || []).length === 0) continue;
      if (t.status === 'completed' && !hasUnfinishedDesc(t.id)) dflt.add(t.id);
    }
    setCollapsedByPid(prev => ({ ...prev, [selectedPid]: dflt }));
  }, [allTasks, selectedPid]);

  // 构建任务树：父任务 → 子任务
  const taskTree = (() => {
    const roots: Task[] = [];
    const childrenMap = new Map<string, Task[]>();
    for (const t of filtered) {
      if (t.parent_task_id) {
        const list = childrenMap.get(t.parent_task_id) || [];
        list.push(t); childrenMap.set(t.parent_task_id, list);
      } else {
        roots.push(t);
      }
    }
    // 终核修复（2026-09-03）：活跃子任务的父任务被当前筛选排除（如父已完成而子仍 active/paused）时，
    // 子任务会被 childrenMap 收走却无父行承接 → 出现"计数在(activeCount 全量统计)却看不到"。
    // 把这类"孤儿"子任务提升为独立行（depth0）展示，保证计数与可见一致。
    const idSet = new Set(filtered.map((f) => f.id));
    for (const t of filtered) {
      if (t.parent_task_id && !idSet.has(t.parent_task_id) && !roots.some((r) => r.id === t.id)) roots.push(t);
    }
    // 递归扁平化，带缩进层级
    // zx_20260904_6 D8: 孤儿(祖先被筛选排除)按其隐藏祖先级数保留缩进，不再一律压成 depth0 与 L1 平级
    const orphanDepth = new Map<string, number>();
    for (const t of filtered) {
      if (!t.parent_task_id || idSet.has(t.parent_task_id)) continue;
      if (roots.some((r) => r.id === t.id)) {
        let d = 0;
        let cur = t.parent_task_id as string | undefined;
        let guard = 0;
        while (cur && !idSet.has(cur) && guard < 12) {
          d++; guard++;
          cur = allTasks.find((x) => x.id === cur)?.parent_task_id;
        }
        orphanDepth.set(t.id, Math.max(1, d));
      }
    }
    const flatten = (tasks: Task[], baseDepth: number, forcedDepth?: number): Array<{task: Task; depth: number; hasChildren: boolean}> => {
      const result: Array<{task: Task; depth: number; hasChildren: boolean}> = [];
      for (const t of tasks) {
        const children = childrenMap.get(t.id) || [];
        const depth = forcedDepth ?? (orphanDepth.has(t.id) ? orphanDepth.get(t.id)! : baseDepth);
        result.push({ task: t, depth, hasChildren: children.length > 0 });
        if (!collapsed.has(t.id)) {
          result.push(...flatten(children, depth + 1));
        }
      }
      return result;
    };
    return flatten(roots, 0);
  })();

  return (
    <div>
      {toast && <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded shadow-lg text-sm ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{toast.msg}</div>}
      <div className="flex items-center justify-between mb-4"><h2 className="text-xl font-bold">任务管理</h2><div className="flex items-center gap-2"><button onClick={()=>loadTasks()} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4"/></button><button onClick={()=>setShowCreate(true)} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5"/>新建任务</button></div></div>

      {/* 项目选择器 + 过滤器 */}
      <div className="flex items-center gap-3 mb-4">
        <select value={selectedPid} onChange={e=>setSelectedPid(e.target.value)} className="px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]">
          {projList.map(p=><option key={p.id} value={p.id}>{p.name} ({statusText(PROJECT_STATUS_LABEL, p.status)})</option>)}
        </select>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          {(['await','active','completed','all']as const).map(f=>f==='await'&&awaitCount===0?null:(<button key={f} onClick={()=>setFilter(f)} className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${filter===f?'bg-white shadow text-gray-900':'text-gray-500 hover:text-gray-700'}`}>{f==='await'?`待回复(${awaitCount})`:f==='active'?`活跃(${activeCount})`:f==='completed'?'已完成':'全部'}</button>))}
        </div>
        <div className="flex-1"/>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
          <button onClick={()=>setView('list')} className={`px-2 py-1 rounded-md text-xs ${view==='list'?'bg-white shadow text-gray-900':'text-gray-500'}`}><LayoutList className="w-3.5 h-3.5 inline"/></button>
          <button onClick={()=>setView('kanban')} className={`px-2 py-1 rounded-md text-xs ${view==='kanban'?'bg-white shadow text-gray-900':'text-gray-500'}`}><Columns className="w-3.5 h-3.5 inline"/></button>
        </div>
        {/* zx_20261018_3 批五「显」: 分页后如实写"已加载 K / 共 M"，并把未载部分做成一个可达动作 */}
        <span className="text-xs text-gray-400">{filtered.length} 个任务{allTasks.length < tasksTotal ? `（已加载 ${allTasks.length}/${tasksTotal}）` : ''}</span>
        {allTasks.length < tasksTotal && <button onClick={()=>loadTasks(true)} disabled={loading} className="px-2 py-1 text-xs border rounded-lg hover:bg-gray-50 disabled:opacity-50">加载更多</button>}
      </div>

      {view==='kanban' ? (
        <div className="overflow-x-auto">
          <div className="flex gap-2 min-w-[900px]">
            {(['pending','planning','preparing','executing','running','paused','failed','completed'] as const).map(status => {
              const colTasks = filtered.filter(t=>t.status===status);
              return (
                <div key={status} className="flex-1 min-w-[120px] bg-gray-50 rounded-lg p-2">
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLOR[status]||'bg-gray-100'}`}>{statusText(TASK_STATUS_LABEL, status)}</span>
                    <span className="text-xs text-gray-400">{colTasks.length}</span>
                  </div>
                  <div className="space-y-1 max-h-[60vh] overflow-y-auto">
                    {colTasks.map(t=>(
                      <div key={t.id} className="bg-white rounded border p-2 text-xs cursor-pointer hover:shadow-sm" onClick={()=>navigate(`/tasks/${t.id}`)}>
                        <p className="font-medium truncate">{t.title}</p>
                        <div className="flex items-center gap-1 mt-1">
                          {t.priority>0&&<span className="text-orange-500">P{t.priority}</span>}
                          {isStuck(t)&&<span className="text-red-500">●卡住</span>}
                          <span className="text-gray-400">{t.source}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : loading?<div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"/></div>:filtered.length===0?<p className="text-gray-400 text-center py-12">暂无任务</p>:<div className="space-y-1"><div className="flex items-center gap-2 mb-1 text-xs text-gray-400 px-1"><span className="flex-1 cursor-pointer hover:text-gray-600" onClick={()=>toggleSort('title')}>任务名称 {sortBy==='title'&&(sortAsc?'↑':'↓')}</span><span className="w-16 text-center cursor-pointer hover:text-gray-600" onClick={()=>toggleSort('priority')}>优先级 {sortBy==='priority'&&(sortAsc?'↑':'↓')}</span><span className="w-16 text-center cursor-pointer hover:text-gray-600" onClick={()=>toggleSort('status')}>状态 {sortBy==='status'&&(sortAsc?'↑':'↓')}</span><span className="w-24 text-center cursor-pointer hover:text-gray-600" onClick={()=>toggleSort('date')}>时间 {sortBy==='date'&&(sortAsc?'↑':'↓')}</span></div>{taskTree.map(({task:t,depth,hasChildren})=>{
        const stuck=isStuck(t); const dp=getDynamicPriority(t); const quality=getQualityScore(t); const tokens=getTokensUsed(t); const budgetMax=getBudgetMax(t); const overBudget = budgetMax!=null && tokens!=null && tokens>budgetMax; const prog=progressMap[t.id]; const liveTokens=prog?.tokens ?? tokens; const liveStep=prog?.step;
        // 该行的动作是否有在途请求（在途即整簇动作不可点，防重复提交）
        const rowBusy = !!acting && acting.startsWith(t.id + ':');
        // zx_20260913 M3-5(名实相符): 前置阻塞态按状态算——与"用户手动暂停"（状态徽标「已暂停」）视觉可分
        // zx_20260917 M3: 同详情页同一把尺——第四个取值函数给前置 `context_json`（`paused` 按因由细分）
        const depInfo = depBlockInfo(String(t.depends_on||'').split(',').map(s=>s.trim()).filter(Boolean), (id)=>allTasks.find(x=>x.id===id)?.status, (id)=>idTitleMap.get(id)||`${id.slice(0,8)}...`, (id)=>allTasks.find(x=>x.id===id)?.context_json);
        // C1 (2026-09-03_1): 策略来源徽标 + 卡住/动态 tooltip
        const strat = getStrategySource(t); const bottleneckInfo = getBottleneckExplain(t);
        // zx_20260904_6 D8 修(2026-09-04): 整卡按 depth 递增左移(marginLeft)，层级线(border-l)随卡右移——消除"L2 与 L1 视觉平级"
        const ml = depth * 20;
        return (<div key={t.id} className={`bg-white rounded-lg border p-3 hover:shadow-sm transition-shadow cursor-pointer ${depth>0?'border-l-2 border-l-blue-200':''}`} style={{ marginLeft: depth > 0 ? ml : 0 }} onClick={()=>navigate(`/tasks/${t.id}`)}><div className="flex items-center justify-between"><div className="flex-1 min-w-0"><div className="flex items-center gap-2 mb-1 flex-wrap">{hasChildren&&<button onClick={e=>{e.stopPropagation();toggleCollapse(t.id);}} className="p-0.5 hover:bg-gray-100 rounded">{collapsed.has(t.id)?<ChevronRight className="w-3.5 h-3.5"/>:<ChevronDown className="w-3.5 h-3.5"/>}</button>}<span className="font-medium text-sm truncate">{t.title}</span>{depth>0&&<span className="text-[10px] text-gray-400 bg-gray-50 px-1 rounded">L{depth}</span>}{t.parent_task_id&&idTitleMap.get(t.parent_task_id)?<button onClick={(e)=>{e.stopPropagation();navigate(`/tasks/${t.parent_task_id}`);}} className="text-[10px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 shrink-0" title={`父任务: ${idTitleMap.get(t.parent_task_id)}`}>↑{String(idTitleMap.get(t.parent_task_id)).slice(0,10)}</button>:null}{(t.depends_on||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,3).map(did=>idTitleMap.get(did)?<button key={did} onClick={(e)=>{e.stopPropagation();navigate(`/tasks/${did}`);}} title={`前置任务: ${idTitleMap.get(did)}`} className="text-[10px] px-1 py-0.5 rounded bg-rose-50 text-rose-700 hover:bg-rose-100 shrink-0">前置:{String(idTitleMap.get(did)).slice(0,10)}</button>:null)}<span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLOR[t.status]||'bg-gray-100'}`}>{statusText(TASK_STATUS_LABEL, t.status)}</span>{t.priority>0&&<span className="text-xs text-orange-500 font-medium shrink-0">P{t.priority}</span>}{t.status!=='completed'&&depInfo.state!=='met'&&<span title={depInfo.text} className={`text-[10px] px-1 py-0.5 rounded-full shrink-0 ${depInfo.state==='dead'?'bg-red-100 text-red-700':depInfo.state==='unresolved'?'bg-gray-100 text-gray-500':'bg-yellow-100 text-yellow-700'}`}>{depInfo.state==='dead'?'前置永不可满足':depInfo.state==='unresolved'?'前置不存在':'⏳等待前置'}</span>}{strat&&<span title="模型策略来源" className="text-[10px] px-1 py-0.5 rounded-full bg-teal-50 text-teal-600 shrink-0">{STRATEGY_SOURCE_LABEL[strat]||strat}</span>}{dp!=null&&<span title={bottleneckInfo||'未分析'} className="text-xs text-purple-500 shrink-0">动态{dp}</span>}{stuck&&<span title={bottleneckInfo||'未分析'} className="text-xs text-red-500 shrink-0">●卡住</span>}{quality!=null&&<span title={`完成质量 ${quality}分`} className={`text-[10px] px-1 py-0.5 rounded-full font-medium ${quality>=80?'bg-green-100 text-green-700':quality>=60?'bg-yellow-100 text-yellow-700':quality>=40?'bg-orange-100 text-orange-700':'bg-red-100 text-red-600'}`}>★{quality}</span>}{liveTokens!=null&&<span title={overBudget?'超出预算':'Token消耗'} className={`text-[10px] px-1 py-0.5 rounded-full ${overBudget?'bg-red-100 text-red-700':'bg-gray-100 text-gray-500'}`}>{liveTokens>=1000?(liveTokens/1000).toFixed(1)+'K':String(liveTokens)}{overBudget?' ⚠':''}</span>}{liveStep!=null&&<span title={prog?.toolCalls||'最近执行进度'} className="text-[10px] px-1 py-0.5 rounded-full bg-blue-50 text-blue-600">⏵第{liveStep}步</span>}{summaryOn&&t.status==='completed'&&(Number(t.deliverable_count)||0)>0&&<span title="本任务及子任务交付的产出物/验收（已完成任务成果回看；计数在 task:list 由子树聚合）" className="text-[10px] px-1 py-0.5 rounded-full bg-indigo-50 text-indigo-600 shrink-0">成果 {t.deliverable_count}{Number(t.acc_total)>0?` · ✓验收 ${Number(t.acc_passed)||0}/${Number(t.acc_total)}`:''}{Number(t.primary_count)>0?` · ★主${t.primary_count}`:''}</span>}</div><p className="text-xs text-gray-400">{t.source} · {formatDbTime(t.created_at)}</p></div><div className={`flex items-center gap-1 ml-2 shrink-0 ${rowBusy?'pointer-events-none opacity-40':''}`} aria-busy={rowBusy} onClick={e=>e.stopPropagation()}>{rowBusy&&<span className="text-[10px] text-blue-500 animate-pulse">处理中…</span>}{t.status==='pending'&&<button onClick={()=>handleStatus(t.id,'running')} className="p-1 hover:bg-green-50 rounded" title="执行"><Play className="w-3.5 h-3.5 text-green-600"/></button>}{(t.status==='executing'||t.status==='running')&&<button onClick={()=>handleStatus(t.id,'paused')} className="p-1 hover:bg-orange-50 rounded" title="暂停（立即中止在途，可恢复）"><Pause className="w-3.5 h-3.5 text-orange-600"/></button>}{(t.status==='executing'||t.status==='running')&&<button onClick={()=>handleInterrupt(t.id)} className="p-1 hover:bg-red-50 rounded" title="中止（立即中断；同暂停，保留产出可恢复）"><AlertTriangle className="w-3.5 h-3.5 text-red-500"/></button>}{(t.status==='paused'||t.status==='failed')&&<button onClick={()=>handleResume(t.id)} className="p-1 hover:bg-blue-50 rounded" title="恢复（保留对话继续）"><RotateCcw className="w-3.5 h-3.5 text-blue-600"/></button>}{t.status==='failed'&&<button onClick={()=>handleRetry(t.id)} className="p-1 hover:bg-indigo-50 rounded" title="重试（清空对话从零开始）"><RefreshCw className="w-3.5 h-3.5 text-indigo-600"/></button>}{(t.status==='paused'||t.status==='failed')&&<button onClick={()=>handleStatus(t.id,'completed')} className="p-1 hover:bg-emerald-50 rounded" title="标记完成"><Check className="w-3.5 h-3.5 text-emerald-600"/></button>}{t.status==='completed'&&<button onClick={()=>handleRetry(t.id)} className="p-1 hover:bg-purple-50 rounded" title="重新执行"><RotateCcw className="w-3.5 h-3.5 text-purple-600"/></button>}{(t.status==='completed'||t.status==='failed')&&<button onClick={()=>handleDelete(t.id)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-500"/></button>}<button onClick={()=>{setEditing(t);setEditForm({title:t.title,description:t.description||'',priority:t.priority,acceptance_criteria:t.acceptance_criteria||''});setShowEdit(true);}} className="p-1 hover:bg-gray-100 rounded" title="编辑"><Edit className="w-3.5 h-3.5 text-gray-400"/></button></div></div></div>);
      })}</div>}

      {showCreate && <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={()=>setShowCreate(false)}><div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-3xl max-h-[88vh] overflow-y-auto" onClick={e=>e.stopPropagation()}><h3 className="text-lg font-bold mb-4">新建任务</h3><div className="space-y-3">{templates.length>0&&<div><label className="block text-sm font-medium mb-1">任务模板</label><select onChange={e=>applyTemplate(e.target.value)} defaultValue="" className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="" disabled>选择模板（可选）</option>{templates.map((t,i)=><option key={i} value={t.id as string}>{t.name as string} · {t.category as string}</option>)}</select></div>}<div><label className="block text-sm font-medium mb-1">标题*</label><input value={newTask.title} onChange={e=>setNewTask({...newTask,title:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">描述</label><textarea value={newTask.description} onChange={e=>setNewTask({...newTask,description:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed resize-y" rows={7}/></div><div><label className="block text-sm font-medium mb-1">优先级</label><select value={newTask.priority} onChange={e=>setNewTask({...newTask,priority:Number(e.target.value)})} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value={0}>普通</option><option value={1}>优先</option><option value={2}>紧急</option><option value={3}>最高</option></select></div><div><label className="block text-sm font-medium mb-1">验收标准</label><textarea value={newTask.acceptance_criteria} onChange={e=>setNewTask({...newTask,acceptance_criteria:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed resize-y" rows={5} placeholder="完成标准（可选）"/></div><div><label className="block text-sm font-medium mb-1">父任务（可选）</label><select value={newTask.parentTaskId} onChange={e=>setNewTask({...newTask,parentTaskId:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">无（独立任务）</option>{parentOptions.map(o=>{const st=statusText(TASK_STATUS_LABEL, o.status); return <option key={o.id} value={o.id}>{(o.title||'').slice(0,40)}{o.status==='completed'?' ✓':''}（{st}）</option>;})}</select></div>{/* zx_20260909_1 M4(Z1): 新建即选"关联方案(规划)"——创建即落 scheme_ref, 先于 ≈10s 自动动工; 仅 link_at_create 开 & 同项目有方案任务 */}{linkOn && createPlans.length>0 && <div><label className="block text-sm font-medium mb-1">🔗 关联方案（规划）</label><select value={newTask.planTaskId} onChange={e=>setNewTask({...newTask,planTaskId:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">无（不关联方案）</option>{createPlans.map(p=><option key={p.id} value={p.id}>{(p.title||'').slice(0,40)}（{statusText(TASK_STATUS_LABEL, p.status)} · M{p.milestoneCount}）</option>)}</select></div>}{/* zx_20261013_1 批二(K7): 本地挂件——选/拖文件随建任务一并挂上（件就在手边，路在此接通） */}<div><label className="block text-sm font-medium mb-1">附件（可选）</label><div onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();dropAttachments(e.dataTransfer?.files??null);}} onClick={pickAttachments} className="border-2 border-dashed rounded-lg p-3 text-center text-xs text-gray-400 hover:border-blue-400 hover:text-blue-500 cursor-pointer">拖文件到此，或点击选择（图片/文档/音视频）</div>{newTask.attachmentPaths.length>0&&<ul className="mt-2 space-y-1">{newTask.attachmentPaths.map(p=><li key={p} className="flex items-center justify-between gap-2 text-xs bg-gray-50 rounded px-2 py-1"><span className="truncate" title={p}>{p.split(/[\\/]/).pop()}</span><button type="button" onClick={()=>removeAttachment(p)} className="text-red-400 hover:text-red-600 shrink-0">移除</button></li>)}</ul>}</div></div><div className="flex justify-end gap-2 mt-6"><button onClick={()=>setShowCreate(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button><button onClick={handleCreate} disabled={!newTask.title || creating} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{creating ? '创建中…' : '创建'}</button></div></div></div>}
      {showEdit && editing && <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={()=>setShowEdit(false)}><div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-3xl max-h-[88vh] overflow-y-auto" onClick={e=>e.stopPropagation()}><h3 className="text-lg font-bold mb-4">编辑任务</h3><div className="space-y-3"><div><label className="block text-sm font-medium mb-1">标题</label><input value={editForm.title} onChange={e=>setEditForm({...editForm,title:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">描述</label><textarea value={editForm.description} onChange={e=>setEditForm({...editForm,description:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed resize-y" rows={6}/></div><div><label className="block text-sm font-medium mb-1">优先级</label><select value={editForm.priority} onChange={e=>setEditForm({...editForm,priority:Number(e.target.value)})} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value={0}>普通</option><option value={1}>优先</option><option value={2}>紧急</option><option value={3}>最高</option></select></div><div><label className="block text-sm font-medium mb-1">验收标准</label><textarea value={editForm.acceptance_criteria} onChange={e=>setEditForm({...editForm,acceptance_criteria:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed resize-y" rows={4} placeholder="完成标准（可选）"/></div></div><div className="flex justify-end gap-2 mt-6"><button onClick={()=>setShowEdit(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button><button onClick={handleUpdate} disabled={!editForm.title} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">保存</button></div></div></div>}
    </div>
  );
}
