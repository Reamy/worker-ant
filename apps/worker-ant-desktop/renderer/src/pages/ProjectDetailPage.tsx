import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { projects, tasks, admin, invoke, deliverables, knowledge } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { useStaleness } from '../lib/useLiveQuery';
import { useSettings } from '../lib/settingsStore';
import { useDeliverableDrawer } from '../lib/deliverableDrawer';
import { FreshnessPill } from '../components/FreshnessPill';
import DeleteProjectDialog from '../components/DeleteProjectDialog';
import DeliveryDigestCard from '../components/DeliveryDigestCard';
import ServiceCallCard from '../components/ServiceCallCard';
import KnowledgeFaceCard from '../components/KnowledgeFaceCard';
import NodeDivisionCard from '../components/NodeDivisionCard';
import CollabBoardCard from '../components/CollabBoardCard';
import KnowledgePackCard from '../components/KnowledgePackCard';
import KnowledgeInboxCard from '../components/KnowledgeInboxCard';
// zx_20261113_1 B1「联」: 项目详情岗位卡——能派给谁、各自干了多少；IM 拒因指向的入口由此真实存在。
import ProjectPositionsCard from '../components/ProjectPositionsCard';
import DomainPackCard from '../components/DomainPackCard';
import LoadFailure from '../components/LoadFailure';
// zx_20261111_3「显」：第一行的唯一真源在 main 纯模块（页面只说事实，不自己排优先级）。
import NextActionBar from '../components/NextActionBar';
import { nextActionForProject, type NextActionId } from '../../../src/main/core/next-action.js';
import { ArrowLeft, Play, Pause, Check, Archive, Edit, Trash2, Brain, Clock, Terminal, Activity, AlertTriangle, Lightbulb, RefreshCw, Package, BookOpen, Network, Users } from 'lucide-react';
// zx_20261029_1「知」: 须知的渲染数据类型与 main 侧同形（IPC 只传纯数据）。
import type { ProjectBriefRecord, ProjectModelOverridePayload, KnowledgeBusinessStatus } from '../lib/ipc';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// zx_20260920_1 M7: ★ 的语义是「**高于**基线」。基线抬到 0.6 后若仍写 `> 0.5`，则**每条新记忆默认带 ★**
//   （因为新写入恰为 0.6）——星号就失去意义。故阈值改引真源，不手抄 0.5/0.6。
import { MEM_IMPORTANCE_DEFAULT } from '../../../src/main/core/memory-constants.js';
// zx_20261107_1 B6: 指定来源词表取 main 同一份（跨 root 引真源，不在页面里手抄第二份）。
import { PIN_SOURCE_LABEL } from '../../../src/main/core/model-selection.js';
// zx_20261019 实机 E2E 修: 记忆类型词表取**唯一一份**（core/memory-lifecycle.ts）——此前本页与
//   `MemoriesPage` 各手抄一份，两份都漏 `acceptance_failure`/`panorama`/`retrospective` 等 ⇒ 显示英文键。
import { MEM_TYPE_LABEL } from '../../../src/main/core/memory-lifecycle.js';
// 交付物类型/状态词表与库内时间——四处渲染点共此一份真源
// zx_20260930 M3-d: 大小换算也取同一份（成果页签需要，不在这里自带第二套除 1024 的写法）
import { DELIVERABLE_TYPE_LABEL, DELIVERABLE_STATUS_LABEL, formatDbTime, formatBytes } from '../lib/deliverable-view';
// zx_20261107_1 B9: 计数/金额/ token 展示与其它页同尺（此前本页 `toLocaleString` 与内联 K 各写一份）
import { formatCount, formatMoney, formatTokens } from '../lib/format';
import { TASK_STATUS_LABEL, PROJECT_STATUS_LABEL, statusText } from '../lib/status-view';
// zx_20261021_1 M1: 策略/健康视图/调参历史词表的唯一真源（此前面板直出内部键：capability-best、costEfficiency…）
import { MODEL_STRATEGY_LABEL, HEALTH_VIEW_LABEL, HEALTH_METRIC_LABEL, formatStrategyAdjustments, formatStrategyNumber } from '../lib/project-insight';
// zx_20260930 M4-2: 列表批次大小（成果页/本页/任务详情共用一份，见该模块头注）
import { LIST_PAGE_SIZE, pageExhausted } from '../lib/list-page';
// zx_20261108_1 B5：动作路径的可见结果（失败回显 + 原因）。
import { ActionFeedback, useActionFeedback, messageOf } from '../lib/action-feedback';

interface Project { id: string; name: string; description: string; status: string; cron_schedule?: string; cron_timezone?: string; working_dir?: string; autonomous_mode?: string; sandbox_mode?: string; context_json?: string; taskStats?: { total: number; completed: number }; deliverableStats?: { total: number } & Record<string, number>; tokenStats?: { total_tokens: number }; lastActive?: string; staleness?: string; created_at: string; updated_at: string; }
interface CtxData { budget?: { max_tokens_per_task?: number; max_cost_usd_per_task?: number }; rhythm?: { activeHourStart?: number; activeHourEnd?: number; maxConcurrency?: number }; cron_run_command?: string; im_commands?: Record<string, { script: string; label: string }>; cron_create_task?: { title: string; description: string }; }

// zx_20261019: 类型中文名**只此一处**（core/memory-lifecycle.ts 的 `MEM_TYPE_LABEL`），本页直引。
//   词表缺项的后果是页面显示英文原始键（「renderer 是词表的第二个落点」——已两次复发）。
const MEMORY_TYPES: Record<string, string> = MEM_TYPE_LABEL;
// zx_20260906 批3 (3c): 产出物类型 chip 配色（知识全景 byType/最近产出物共用）；文案取共享词表
const DELIV_TYPE_CLS: Record<string, string> = { mcp: 'bg-blue-100 text-blue-700', a2a: 'bg-green-100 text-green-700', ui: 'bg-purple-100 text-purple-700', doc: 'bg-amber-100 text-amber-700', daemon: 'bg-orange-100 text-orange-700', code: 'bg-slate-100 text-slate-700' };

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // zx_20260909 X1(就地成果抽屉): 最近产出物行点开详情(deliverable.doc_drawer 门控)
  const settings = useSettings();
  const drawerOn = boolSetting(settings['deliverable.doc_drawer']);
  const { open: openDeliv } = useDeliverableDrawer();
  const [project, setProject] = useState<Project | null>(null);
  const [ctx, setCtx] = useState<CtxData>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', cron_schedule: '', cron_timezone: 'Asia/Shanghai', working_dir: '', autonomous_mode: 'off', sandbox_mode: 'workspace' });
  const [budgetForm, setBudgetForm] = useState({ max_tokens_per_task: '', max_cost_usd_per_task: '' });
  const [rhythmForm, setRhythmForm] = useState({ activeHourStart: '9', activeHourEnd: '18', maxConcurrency: '2' });
  const [cronForm, setCronForm] = useState({ cron_task_title: '', cron_task_desc: '', cron_run_command: '' });
  // zx_20261107_1 B6: 项目级模型覆盖。生效项由 main 按「恢复路 > 项目 > 全局默认」裁定，本页只显示不重算。
  const [modelOv, setModelOv] = useState<ProjectModelOverridePayload | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [modelSaving, setModelSaving] = useState(false);
  // 记忆 Tab
  // zx_20260930 M3-d(成果页签): 本项目的产出此前只能跳到全局成果页再看（该页是跨项目的）。
  //   新增「本项成果」页签：取数与全局页**同一个端口** `deliverables.list(projectId)`，
  //   类型/状态文案取**同一份词表**（DELIVERABLE_TYPE_LABEL/DELIVERABLE_STATUS_LABEL），
  //   行点开也进**同一个**就地抽屉 ⇒ 不产生第二套"什么叫已完成"的判据。
  const [activeTab, setActiveTab] = useState<'overview' | 'memories' | 'milestones' | 'tensions' | 'deliverables' | 'packs'>('overview');
  // zx_20261021_3 批五: 领域包页签随项目事件重载（与既有页签同形：靠换 key 触发卡内 load）。
  const [packTick, setPackTick] = useState(0);
  const [memories, setMemories] = useState<Array<Record<string, unknown>>>([]);
  const [memCounts, setMemCounts] = useState<Array<{ memory_type: string; cnt: number }>>([]);
  const [memTypeFilter, setMemTypeFilter] = useState('');
  const [memLoading, setMemLoading] = useState(false);
  // 里程碑
  const [blockers, setBlockers] = useState<Array<Record<string, unknown>>>([]);
  const [milestones, setMilestones] = useState<Array<Record<string, unknown>>>([]);
  // zx_20260905 批4: 方案里程碑(M0-M6) 项目级聚合（含 doing/done/pending 自动流转展示）
  const [planMilestones, setPlanMilestones] = useState<Array<Record<string, unknown>>>([]);
  // zx_20261027_1 M6: 空转看板（done+doing=0）默认折叠——真库多块「九行全 pending」的板与真在推进的板混排。
  const [showIdleBoards, setShowIdleBoards] = useState(false);
  const [milestoneLoading, setMilestoneLoading] = useState(false);
  // zx_20260905 批5: 项目质量聚合（均质/趋势）
  const [qualityStats, setQualityStats] = useState<Record<string, unknown> | null>(null);
  // zx_20261112_2 B6「面」：三处此前被 `catch {}` 吞掉的失败——现在如实上屏（"没取到"不等于"没有数据"）。
  const [qualityError, setQualityError] = useState('');
  const [headerError, setHeaderError] = useState('');
  const [ctxError, setCtxError] = useState('');
  // 矛盾张力面板
  const [tensions, setTensions] = useState<Record<string, Record<string, unknown>>>({});
  const [tensionConfigs, setTensionConfigs] = useState<Record<string, Record<string, unknown>>>({});
  // 多维度健康视图 + 知识全景
  const [healthViews, setHealthViews] = useState<Record<string, Record<string, unknown>>>({});
  const [panorama, setPanorama] = useState<Record<string, unknown> | null>(null);
  // zx_20261110_1 B5：卡片级读取失败与「确实没有数据」分家（失败带因由 + 重试，不置空冒充无数据）。
  const [healthErr, setHealthErr] = useState('');
  const [panoErr, setPanoErr] = useState('');
  const [membersErr, setMembersErr] = useState('');
  const [usersErr, setUsersErr] = useState('');
  const [briefErr, setBriefErr] = useState('');
  const [healthBusy, setHealthBusy] = useState(false);
  const [panoBusy, setPanoBusy] = useState(false);
  const [membersBusy, setMembersBusy] = useState(false);
  // 本项目成果页签（zx_20260930 M3-d）
  const [pjDelivs, setPjDelivs] = useState<Array<Record<string, unknown>>>([]);
  // zx_20260930 M4-2: 真分页——`pjDelivTotal` 取服务端总数（"共 M 条"），`pjDelivExhausted` 决定是否出「加载更多」。
  const [pjDelivTotal, setPjDelivTotal] = useState(0);
  const [pjDelivExhausted, setPjDelivExhausted] = useState(false);
  const [pjDelivMoreBusy, setPjDelivMoreBusy] = useState(false);
  const [pjDelivLoading, setPjDelivLoading] = useState(false);
  // 成员管理
  const [members, setMembers] = useState<Array<Record<string, unknown>>>([]);
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [addMemberId, setAddMemberId] = useState('');
  // C1 (2026-09-03): 自适应策略可视 + D1 主要矛盾可视
  const [strategyInfo, setStrategyInfo] = useState<{ modelStrategy?: string | null; temperature?: number | null; maxSteps?: number | null; updatedAt?: string | null; adjustments?: Array<Record<string, unknown>> } | null>(null);
  const [bottleneck, setBottleneck] = useState<{ summary?: string; principals?: Array<Record<string, unknown>>; computedAt?: string } | null>(null);
  // zx_20261108_1 B5：项目本体**加载失败**与「项目不存在」是两回事——前者可重试，后者是事实。
  const [loadError, setLoadError] = useState('');
  // zx_20261111_3「显」：本项目「等你回复 / 执行失败」的件数——**复用全局那本账**（`tasks:actionNeeded`），
  //   不在这里另写一份 SQL。`null` = 没取到（第一行据此说"读不到"，不冒充 0 件）。
  const [projectAction, setProjectAction] = useState<{ awaiting: number; failed: number } | null>(null);
  const [projectActionError, setProjectActionError] = useState('');
  // zx_20261113_4 B2「荐」：首屏业务知识状态（画像 / 已启用领域包 / 待采纳建议）。
  const [bizStatus, setBizStatus] = useState<KnowledgeBusinessStatus | null>(null);
  const [bizStatusError, setBizStatusError] = useState('');

  // zx_20261111_3「显」：本项目的"等你回复/失败"件数取自全局账，按 project_id 过滤（不新造查询）。
  async function loadProjectAction(): Promise<void> {
    try {
      const r = await invoke<{ items?: Array<{ project_id?: string | null; kind?: string }> }>('tasks:actionNeeded');
      const mine = (r?.items ?? []).filter((it) => String(it.project_id ?? '') === String(id ?? ''));
      setProjectAction({
        awaiting: mine.filter((it) => it.kind === 'await_input').length,
        failed: mine.filter((it) => it.kind === 'failed').length,
      });
      setProjectActionError('');
    } catch (e) {
      setProjectAction(null);
      setProjectActionError(messageOf(e));
    }
  }
  // zx_20261113_4 B2「荐」：首屏业务知识状态——一次调用回齐；读不到如实说，不冒充"未成型"或"0 条"。
  async function loadBusinessStatus(): Promise<void> {
    if (!id) return;
    try {
      setBizStatus(await knowledge.businessStatus(id));
      setBizStatusError('');
    } catch (e) {
      setBizStatus(null);
      setBizStatusError(messageOf(e));
    }
  }
  useEffect(() => { if (id) { void load(); void loadQuality(); void loadBrief(); void loadProjectAction(); void loadBusinessStatus(); } }, [id]);
  // A1/A2 (2026-09-04_2): 项目详情保鲜度——事件驱动静默刷新头部统计（无常·保鲜；不打断编辑态）
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const projStale = useStaleness(lastUpdated);
  const { subscribe } = useActivity();
  const projRefreshTimer = useRef<number | undefined>(undefined);
  // zx_20261108_1 B5：动作失败可见（含原因）——此前这些 catch 全为空，"点了没反应"与"成功"在界面上无差别。
  const fb = useActionFeedback();
  async function refreshHeader() {
    if (!id) return;
    try {
      const p = await projects.get(id) as unknown as Project;
      setProject(p);
      setLastUpdated(Date.now());
      setHeaderError('');
    } catch (e) {
      // 失败如实说：头部不刷新 ≠ 项目没变化。
      setHeaderError(`项目头部刷新失败：${(e as Error)?.message || String(e)}`);
    }
    void loadQuality();
    // zx_20260906 批3 (3c): 知识全景随 deliverable.* 等事件刷新（byType/最近产出物保鲜）
    void loadPanorama();
  }
  // zx_20260905 批5: 项目质量聚合加载（任务完成/事件刷新头部时同步刷新，保持均质/趋势保鲜）
  async function loadQuality() {
    if (!id) return;
    try {
      const q = await projects.qualityStats(id) as unknown as Record<string, unknown>;
      setQualityStats(q);
      setQualityError('');
    } catch (e) {
      // 读不到 ≠ 没有质量数据（旧实现把两者都显示成"没有"）。
      setQualityStats(null);
      setQualityError(`质量数据读取失败：${(e as Error)?.message || String(e)}`);
    }
  }
  // zx_20260905 批6: 张力自调结果实时回推——auto_adjusted 命中当前项目即静默刷新策略/瓶颈/张力（此前主进程每5min自调仅 console.log，页面为死区）
  useEffect(() => {
    if (!id || !window.electronAPI?.onTaskEvent) return;
    return window.electronAPI.onTaskEvent((event) => {
      if (event.type !== 'tension.auto_adjusted') return;
      if (event.projectId && event.projectId !== id) return;
      invoke<{ modelStrategy?: string | null; temperature?: number | null; maxSteps?: number | null; updatedAt?: string | null; adjustments?: Array<Record<string, unknown>> }>('project:strategy', id).then((r) => { if (r) setStrategyInfo(r); }).catch(() => {});
      invoke<{ summary?: string; principals?: Array<Record<string, unknown>>; computedAt?: string }>('project:bottleneck', id).then((r) => { if (r) setBottleneck(r); }).catch(() => {});
      void loadTensions();
    });
  }, [id]);
  // zx_20260906_1 4d: 子面板随事件刷新——memories/milestones/tensions 标签停留时，命中当前项目的事件按 activeTab 重载对应面板（memory.changed 亦触发记忆重载）
  const activeTabRef = useRef(activeTab); useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  const panelTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    return subscribe((e) => {
      if (e.projectId && e.projectId !== id) return;
      const liveProjectEvent = e.type === 'project.status_changed' || e.type === 'deliverable.registered' || e.type === 'deliverable.status_changed' || e.type === 'task.status_changed' || e.type === 'task.completed' || e.type === 'task.failed' || e.type === 'memory.changed';
      if (!liveProjectEvent) return;
      if (projRefreshTimer.current !== undefined) return;
      projRefreshTimer.current = window.setTimeout(() => { projRefreshTimer.current = undefined; void refreshHeader(); void loadProjectAction(); }, 700);
      const tab = activeTabRef.current;
      if (tab === 'memories' || tab === 'milestones' || tab === 'tensions' || tab === 'deliverables' || tab === 'packs') {
        if (panelTimer.current !== undefined) window.clearTimeout(panelTimer.current);
        panelTimer.current = window.setTimeout(() => {
          panelTimer.current = undefined;
          if (tab === 'memories') void loadMemories();
          else if (tab === 'milestones') void loadMilestones();
          else if (tab === 'deliverables') void loadProjectDeliverables();
          else if (tab === 'packs') setPackTick((n) => n + 1);
          else void loadTensions();
        }, 500);
      }
    });
  }, [id, subscribe]);
  useEffect(() => () => {
    if (projRefreshTimer.current !== undefined) window.clearTimeout(projRefreshTimer.current);
    for (const t of Object.values(tensionTimers.current)) window.clearTimeout(t);
  }, []);
  // C1/D1: 加载项目自适应策略与当前主要矛盾（IPC 返回，非 UI 假数据）
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    invoke<{ modelStrategy?: string | null; temperature?: number | null; maxSteps?: number | null; updatedAt?: string | null; adjustments?: Array<Record<string, unknown>> }>('project:strategy', id)
      .then((r) => { if (!cancelled && r) setStrategyInfo(r); }).catch(() => {});
    invoke<{ summary?: string; principals?: Array<Record<string, unknown>>; computedAt?: string }>('project:bottleneck', id)
      .then((r) => { if (!cancelled && r) setBottleneck(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  async function load() {
    setLoading(true);
    setLoadError('');
    setCtxError('');
    try {
      const p = await projects.get(id!) as unknown as Project;
      setProject(p);
      setForm({ name: p.name, description: p.description || '', cron_schedule: p.cron_schedule || '', cron_timezone: p.cron_timezone || 'Asia/Shanghai', working_dir: p.working_dir || '', autonomous_mode: p.autonomous_mode || 'off', sandbox_mode: p.sandbox_mode || 'workspace' });
      const c = (() => {
        const raw = p.context_json;
        if (!raw) { console.warn('[ProjectDetail] context_json is empty'); return {}; }
        if (typeof raw === 'object') {
          console.log('[ProjectDetail] context_json already object, keys:', Object.keys(raw as Record<string,unknown>).slice(0,5), 'im_commands:', Object.keys((raw as Record<string,unknown>).im_commands || {}).length);
          return raw as Record<string,unknown>;
        }
        try { const parsed = JSON.parse(raw as string); return parsed; }
        catch(e) {
          setCtxError(`项目配置解析失败：${(e as Error)?.message || String(e)}`);
          console.error('[ProjectDetail] parse error:', e, 'raw type:', typeof raw, 'first 40:', String(raw).slice(0, 40));
          return {};
        }
      })() as CtxData;
      setCtx(c);
      if (c.budget) setBudgetForm({ max_tokens_per_task: String(c.budget.max_tokens_per_task || ''), max_cost_usd_per_task: String(c.budget.max_cost_usd_per_task || '') });
      if (c.rhythm) setRhythmForm({ activeHourStart: String(c.rhythm.activeHourStart || 9), activeHourEnd: String(c.rhythm.activeHourEnd || 18), maxConcurrency: String(c.rhythm.maxConcurrency || 2) });
      if (c.cron_create_task) setCronForm({ cron_task_title: c.cron_create_task.title || '', cron_task_desc: c.cron_create_task.description || '', cron_run_command: c.cron_run_command || '' });
      else setCronForm({ cron_task_title: '', cron_task_desc: '', cron_run_command: c.cron_run_command || '' });
      // B6: 模型覆盖与项目同批读——取不到就按"没读到"显示（不伪造一个生效模型）。
      try {
        const mo = await projects.modelOverride.get(id!);
        setModelOv(mo);
        setModelDraft(mo.project_override || '');
      } catch { setModelOv(null); setModelDraft(''); }
    } catch (e) {
      setLoadError(messageOf(e));
    }
    setLoading(false);
    setLastUpdated(Date.now());
  }

  // B6: `next` 省略 ⇒ 用输入框；显式传 `null` ⇒ 清除（删 `context_json.model_override` 一个键）。
  async function saveModelOverride(next?: string | null) {
    if (!id) return;
    setModelSaving(true);
    try {
      await projects.modelOverride.set(id, next === undefined ? (modelDraft.trim() || null) : next);
      const mo = await projects.modelOverride.get(id);
      setModelOv(mo);
      setModelDraft(mo.project_override || '');
      fb.ok(next === null ? '已清除项目指定模型' : '项目指定模型已保存');
    } catch (e) { fb.fail('「项目指定模型」未保存', e); }
    setModelSaving(false);
  }

  // zx_20260930 M3-d: 本项目成果——与全局成果页同一个 `deliverables.list`（仅多传 projectId），
  //   不新造端口、不新造过滤口径。
  // zx_20260930 M4-2: 该端口返回体已由裸数组改为 `{ rows, total, … }`（真分页）；此处读 `.rows`，
  //   并把服务端 `total` 当作"共 M 条"——页头再印 `pjDelivs.length`（已加载数）就会与本项目全量不符。
  async function loadProjectDeliverables() {
    setPjDelivLoading(true);
    try {
      const d = await deliverables.list({ projectId: id!, limit: LIST_PAGE_SIZE, offset: 0 });
      const rows = (d?.rows ?? []) as unknown as Array<Record<string, unknown>>;
      const total = Number(d?.total) || 0;
      setPjDelivs(rows);
      setPjDelivTotal(total);
      setPjDelivExhausted(pageExhausted(rows.length, total));
    } catch (e) {
      setPjDelivs([]); setPjDelivTotal(0); setPjDelivExhausted(true);
      fb.fail('「本项目成果」加载失败', e);
    }
    setPjDelivLoading(false);
  }

  // zx_20260930 M4-2: 「加载更多」——偏移量取**已列出的条数**，并按 id 去重合并（翻页期间新件插入会使
  //   按 offset 取到重复行；去重是"同一条不列两次"的保证，不是可选的优化）。
  async function loadMoreProjectDeliverables() {
    setPjDelivMoreBusy(true);
    try {
      const d = await deliverables.list({ projectId: id!, limit: LIST_PAGE_SIZE, offset: pjDelivs.length });
      const more = (d?.rows ?? []) as unknown as Array<Record<string, unknown>>;
      setPjDelivs(prev => {
        const seen = new Set(prev.map(r => String(r.id)));
        return [...prev, ...more.filter(r => !seen.has(String(r.id)))];
      });
      const total = Number(d?.total) || 0;
      setPjDelivTotal(total);
      setPjDelivExhausted(pageExhausted(pjDelivs.length + more.length, total));
    } catch (e) { fb.fail('「加载更多成果」失败', e); }
    setPjDelivMoreBusy(false);
  }

  async function loadMemories(type?: string) {
    setMemLoading(true);
    try {
      const d = await projects.memories(id!, type || undefined) as unknown as { list: Array<Record<string, unknown>>; counts: Array<{ memory_type: string; cnt: number }> };
      setMemories(d.list || []);
      setMemCounts(d.counts || []);
    } catch (e) { fb.fail('「记忆」加载失败', e); }
    setMemLoading(false);
  }

  async function loadMilestones() {
    setMilestoneLoading(true);
    try {
      const d = await projects.milestones(id!) as unknown as { blockers: Array<Record<string, unknown>>; milestones: Array<Record<string, unknown>>; planMilestones: Array<Record<string, unknown>> };
      setBlockers(d.blockers || []);
      setMilestones(d.milestones || []);
      setPlanMilestones(d.planMilestones || []);
    } catch (e) { fb.fail('「里程碑」加载失败', e); }
    setMilestoneLoading(false);
  }

  async function loadTensions() {
    try {
      const d = await projects.tensions(id!) as unknown as { tensions: Record<string, Record<string, unknown>>; configs: Record<string, Record<string, unknown>> };
      setTensions(d.tensions || {});
      setTensionConfigs(d.configs || {});
    } catch (e) { fb.fail('「矛盾张力」加载失败', e); }
  }

  // zx_20261110_1 B5：拖动中只更新本地（此前每动一格写一次库），停手 400ms 才写一次；
  //   写失败如实回显并撤掉本地草稿 ⇒ 滑杆回落服务端值（不把"没存上"显示成"已存"）。
  const [tensionDraft, setTensionDraft] = useState<Record<string, number>>({});
  const tensionTimers = useRef<Record<string, number>>({});
  function onTensionInput(tensionId: string, position: number) {
    setTensionDraft((p) => ({ ...p, [tensionId]: position }));
    const prev = tensionTimers.current[tensionId];
    if (prev !== undefined) window.clearTimeout(prev);
    tensionTimers.current[tensionId] = window.setTimeout(() => {
      delete tensionTimers.current[tensionId];
      void commitTension(tensionId, position);
    }, 400);
  }
  async function commitTension(tensionId: string, position: number) {
    try {
      await projects.updateTension(id!, tensionId, position);
      await loadTensions();
    } catch (e) {
      fb.fail('「张力位置」未保存', e);
    } finally {
      setTensionDraft((p) => { const n = { ...p }; delete n[tensionId]; return n; });
    }
  }

  useEffect(() => {
    if (activeTab === 'memories') loadMemories(memTypeFilter);
    if (activeTab === 'milestones') loadMilestones();
    if (activeTab === 'tensions') loadTensions();
    if (activeTab === 'deliverables') loadProjectDeliverables();
  }, [activeTab, memTypeFilter]);

  useEffect(() => {
    if (id) { loadHealthViews(); loadPanorama(); loadMembers(); }
  }, [id]);

  async function loadMembers() {
    setMembersBusy(true);
    try { const m = await projects.members(id!); setMembers((m as Array<Record<string, unknown>>) || []); setMembersErr(''); }
    catch (e) { setMembersErr(messageOf(e)); }
    try { const u = await admin.users(); setUsers((u as Array<Record<string, unknown>>) || []); setUsersErr(''); }
    catch (e) { setUsersErr(messageOf(e)); }
    setMembersBusy(false);
  }
  async function handleAddMember() {
    if (!addMemberId) return;
    try { await projects.addMember(id!, addMemberId); setAddMemberId(''); loadMembers(); }
    catch (e) { fb.fail('「添加成员」失败', e); }
  }

  // zx_20261029_1「知」: 项目须知（模型读工作目录一次生成；生成在后台作业里，页面只读不生成）。
  const [briefRec, setBriefRec] = useState<ProjectBriefRecord | null>(null);
  // zx_20261111_2「述」：项目描述也是须知来源——有描述即可生成，不再要求必须有工作目录。
  const hasBriefSource = Boolean(project?.working_dir || project?.description?.trim());
  const [briefStale, setBriefStale] = useState<boolean | null>(null);
  const [briefLoading, setBriefLoading] = useState(true);
  const [briefWait, setBriefWait] = useState(false);
  const briefTimer = useRef<number | undefined>(undefined);
  async function loadBrief(): Promise<ProjectBriefRecord | null> {
    if (!id) return null;
    try {
      const d = await projects.brief(id);
      setBriefRec(d.brief);
      setBriefStale(d.stale);
      setBriefErr('');
      return d.brief;
    } catch (e) { setBriefErr(messageOf(e)); return null; }
    finally { setBriefLoading(false); }
  }
  async function handleInitBrief() {
    if (!id || briefWait) return;
    const prevAt = briefRec?.updatedAt || '';
    setBriefWait(true);
    try { await projects.initBrief(id); } catch (e) { setBriefWait(false); fb.fail('「项目须知」生成未启动', e); return; }
    // 轮询：看到 `updatedAt` 变化（新一轮已落账）或进入 failed 即停；最多 3 分钟。
    let attempts = 0;
    const tick = async () => {
      const rec = await loadBrief();
      attempts += 1;
      const landed = !!rec && ((!!rec.updatedAt && rec.updatedAt !== prevAt) || rec.status === 'failed');
      if (landed || attempts >= 60) { setBriefWait(false); return; }
      briefTimer.current = window.setTimeout(() => { void tick(); }, 3000);
    };
    briefTimer.current = window.setTimeout(() => { void tick(); }, 1500);
  }
  useEffect(() => () => { if (briefTimer.current !== undefined) window.clearTimeout(briefTimer.current); }, []);
  // 打开页面时恰在生成中 ⇒ 自动跟进到落定（否则要用户手动刷新才看得到结果）。
  useEffect(() => {
    if (briefRec?.status !== 'running') return;
    const t = window.setTimeout(() => { void loadBrief(); }, 3000);
    return () => window.clearTimeout(t);
  }, [briefRec]);

  async function loadHealthViews() {
    setHealthBusy(true);
    try { const d = await projects.healthViews(id!) as unknown as Record<string, Record<string, unknown>>; setHealthViews(d || {}); setHealthErr(''); }
    catch (e) { setHealthErr(messageOf(e)); }  // 保留上一份数据：清空等于把"没取到"说成"没有"
    setHealthBusy(false);
  }
  async function loadPanorama() {
    setPanoBusy(true);
    try { const d = await projects.knowledgePanorama(id!) as unknown as Record<string, unknown>; setPanorama(d || null); setPanoErr(''); }
    catch (e) { setPanoErr(messageOf(e)); }
    setPanoBusy(false);
  }

  async function handleStatus(status: string) {
    try { await projects.updateStatus(id!, status); load(); }
    catch (e) { fb.fail('「项目状态」未更改', e); }
  }
  // zx_20261012_3 批一: 与 `ProjectsPage` **同一个** `DeleteProjectDialog`（带「同时删除项目数据目录」复选框）。
  const [showDelete, setShowDelete] = useState(false);
  async function confirmDelete(removeDataDir: boolean) {
    setShowDelete(false);
    try { await projects.delete(id!, { removeDataDir }); navigate('/projects'); }
    catch (e) { fb.fail('「删除项目」失败', e); }
  }
  async function handleSave() {
    try {
      const body: Record<string, unknown> = { name: form.name, description: form.description, cron_schedule: form.cron_schedule, cron_timezone: form.cron_timezone, working_dir: form.working_dir, autonomous_mode: form.autonomous_mode, sandbox_mode: form.sandbox_mode };
      body.budget = { max_tokens_per_task: Number(budgetForm.max_tokens_per_task) || undefined, max_cost_usd_per_task: Number(budgetForm.max_cost_usd_per_task) || undefined };
      body.rhythm = { activeHourStart: Number(rhythmForm.activeHourStart), activeHourEnd: Number(rhythmForm.activeHourEnd), maxConcurrency: Number(rhythmForm.maxConcurrency) };
      body.cron_create_task = cronForm.cron_task_title ? { title: cronForm.cron_task_title, description: cronForm.cron_task_desc } : undefined;
      body.cron_run_command = cronForm.cron_run_command || undefined;
      await projects.update(id!, body);
      setEditing(false); load();
    } catch (e) { fb.fail('「项目设置」未保存', e); }
  }

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"/></div>;
  // zx_20261108_1 B5：读失败与「不存在」分开说——读失败给重试，不把"没加载到"谎报成"没有"。
  if (!project && loadError) return (
    <div className="p-6 space-y-3">
      <p className="text-sm text-red-600">项目加载失败：{loadError}</p>
      <button onClick={() => void load()} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700">重试</button>
    </div>
  );
  if (!project) return <p className="text-red-500 p-6">项目不存在</p>;

  // zx_20261027_1 M6: 有推进的板在前；空转板（done+doing=0）折叠到开关后。
  const boardProgress = (p: Record<string, unknown>) => Number(p.done || 0) + Number(p.doing || 0);
  const activeBoards = planMilestones.filter((p) => boardProgress(p) > 0);
  const idleBoards = planMilestones.filter((p) => boardProgress(p) === 0);
  const shownBoards = showIdleBoards ? [...activeBoards, ...idleBoards] : activeBoards;
  // zx_20261107_1 B7: 交付物计数 **UI 单源**——统计卡与知识全景都从这一处取。
  //   数据层本已同源（`countDeliverablesByType`），此前病在页面把同一把尺印了两次。
  const projectDeliverables = project.deliverableStats;

  // zx_20261112_2 B6：Cron 五段校验（空 = 未设，合法）。非法时不提交，避免"保存成功但从不触发"。
  const cronRaw = form.cron_schedule.trim();
  const cronValid = !cronRaw || /^(\S+\s+){4}\S+$/.test(cronRaw);

  // zx_20261111_3「显」：第一行——只喂事实，优先级由 main 纯函数定（页面不再写第二份 if 链）。
  const projectNextAction = nextActionForProject({
    loadError: loadError || projectActionError || null,
    status: project?.status ?? null,
    awaiting: projectAction?.awaiting ?? null,
    failed: projectAction?.failed ?? null,
    briefStatus: briefRec?.status ?? null,
    briefStale,
    briefError: briefRec?.error || briefErr || null,
    hasBriefSource,
  });
  function handleNextAction(aid: NextActionId): void {
    if (aid === 'view_tasks') navigate(`/tasks?projectId=${id}`);
    else if (aid === 'init_brief') void handleInitBrief();
    else if (aid === 'edit_project') setEditing(true);
    else if (aid === 'view_deliverables') navigate(`/deliverables?projectId=${id}`);
  }

  return (
    <div className="space-y-6">
      {/* zx_20261108_1 B5：动作/面板失败在此如实上屏（含原因） */}
      <ActionFeedback note={fb.note} onClose={() => fb.setNote(null)} />
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/projects')} className="p-1 hover:bg-gray-100 rounded"><ArrowLeft className="w-5 h-5"/></button>
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <span className={`text-sm px-2 py-0.5 rounded-full ${project.status==='active'?'bg-green-100 text-green-700':project.status==='paused'?'bg-yellow-100 text-yellow-700':'bg-gray-100'}`}>{statusText(PROJECT_STATUS_LABEL, project.status)}</span>
        <div className="flex-1"/>
        <FreshnessPill q={{ loading: lastUpdated == null, data: null, error: null, updatedAt: lastUpdated, stale: projStale, isLive: true, reload: refreshHeader }} />
        <Link to={`/tasks?projectId=${id}`} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">查看任务</Link>
        <button onClick={() => setEditing(!editing)} className="p-1.5 hover:bg-gray-100 rounded"><Edit className="w-4 h-4 text-gray-500"/></button>
        <button onClick={() => setShowDelete(true)} className="p-1.5 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4 text-red-500"/></button>
      </div>

      {/* zx_20261111_3「显」：第一行——此刻是什么 / 凭什么 / 下一步点哪个（唯一真源 `core/next-action.ts`） */}
      <NextActionBar action={projectNextAction} onAction={handleNextAction} />

      {/* zx_20261112_2 B6：状态操作收进「更多操作」——第一行已有主操作时，不再三个按钮并列抢注意力。
          「完成」是不可逆动作，先问一句（完成后只能归档）。 */}
      <details className="rounded-lg border bg-white">
        <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">更多操作（状态）</summary>
        <div className="flex items-center gap-2 px-3 pb-2.5">
          {project.status==='active' && <button onClick={() => handleStatus('paused')} className="flex items-center gap-1 px-3 py-1 border rounded-lg text-sm hover:bg-yellow-50"><Pause className="w-3.5 h-3.5 text-yellow-600"/>暂停</button>}
          {project.status==='paused' && <button onClick={() => handleStatus('active')} className="flex items-center gap-1 px-3 py-1 border rounded-lg text-sm hover:bg-green-50"><Play className="w-3.5 h-3.5 text-green-600"/>恢复</button>}
          {(project.status==='active'||project.status==='paused')&&<button onClick={() => { if (window.confirm('确定把项目标记为「完成」吗？完成后不可退回进行中，只能归档。')) void handleStatus('completed'); }} className="flex items-center gap-1 px-3 py-1 border rounded-lg text-sm hover:bg-blue-50"><Check className="w-3.5 h-3.5 text-blue-600"/>完成</button>}
          {project.status==='completed'&&<button onClick={() => handleStatus('archived')} className="flex items-center gap-1 px-3 py-1 border rounded-lg text-sm hover:bg-gray-100"><Archive className="w-3.5 h-3.5"/>归档</button>}
        </div>
      </details>

      {project.description && <p className="text-sm text-gray-500">{project.description}</p>}

      {/* zx_20261112_2 B6「面」：首屏一条「进度 + 风险 + 待办」摘要。
          数据与既有读口同源（taskStats / projectDeliverables / blockers / tokenStats），不新建计数器；
          风险不再藏在「里程碑」Tab 里——阻塞数就在首屏，点一下直达。 */}
      {(() => {
        const total = project.taskStats?.total || 0;
        const done = project.taskStats?.completed || 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return (
          <div className="bg-white rounded-lg border px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-semibold text-gray-700">进度</span>
            <span title="本项目全部任务（含子任务）">任务 {total} · 完成 {done}（{pct}%）</span>
            <span className="text-gray-500">未完成 {Math.max(0, total - done)}</span>
            <button type="button" onClick={() => setActiveTab('milestones')}
              className={`px-1.5 py-0.5 rounded ${blockers.length > 0 ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'text-gray-500 hover:bg-gray-50'}`}
              title="点击打开「里程碑/阻塞」">
              阻塞 {blockers.length}
            </button>
            <span title="本项目全部任务的成果合计——与任务页「本任务（含子任务）」不是同一把尺">产出物 {projectDeliverables?.total || 0} 条</span>
            <span className="text-gray-500">Token {formatTokens(project.tokenStats?.total_tokens)}</span>
            <span className="ml-auto text-xs text-gray-400">{project.staleness==='healthy'?'活跃':project.staleness==='stale'?'低活跃':'不活跃'}</span>
          </div>
        );
      })()}

      {/* zx_20261113_4 B2「荐」：首屏业务知识状态——画像 / 已启用领域包 / 待采纳建议。
          数据一次回齐（`knowledge:business-status`），不在这里另算；点一下直达知识资产区。 */}
      <div className="bg-white rounded-lg border px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-semibold text-gray-700">业务知识</span>
        {bizStatusError ? (
          <span className="text-xs text-red-600">读取失败：{bizStatusError}</span>
        ) : !bizStatus ? (
          <span className="text-xs text-gray-400">读取中…</span>
        ) : (
          <>
            <span className={bizStatus.profile.exists ? 'text-gray-700' : 'text-gray-500'}>
              画像 {bizStatus.profile.exists
                ? (bizStatus.profile.enabled ? '已成型 · 启用中' : '已成型 · 已停用')
                : '未成型'}
              {bizStatus.profile.stale ? ' · 已过期' : ''}
            </span>
            <span className="text-gray-500">已启用领域包 {bizStatus.appliedPacks}</span>
            <span className={bizStatus.suggestedPacks > 0 ? 'text-teal-700' : 'text-gray-500'}>
              待采纳建议 {bizStatus.suggestedPacks}
            </span>
            <button
              type="button"
              onClick={() => {
                // zx_20261113_5 M3「口」：只滚动不展开 ⇒ 用户看不到画像/知识包正文。
                const el = document.getElementById('project-knowledge-assets') as HTMLDetailsElement | null;
                if (!el) return;
                el.open = true;
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className="ml-auto text-xs text-teal-700 hover:underline"
            >
              查看知识资产
            </button>
          </>
        )}
      </div>

      {/* zx_20261112_2 B6：三处失败如实上屏（此前 `catch {}` 显示成"没有数据"） */}
      {(headerError || qualityError || ctxError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 space-y-0.5">
          {headerError && <div>{headerError}</div>}
          {qualityError && <div>{qualityError}</div>}
          {ctxError && <div>{ctxError}</div>}
        </div>
      )}

      {/* zx_20260905 批5: 项目质量聚合（均质/趋势——quality_score 列与 context_json 双写） */}
      {(qualityStats && Number((qualityStats as { count?: number }).count ?? 0) > 0) && (
        <div className="mt-3 bg-white rounded-lg border p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-700">质量评定</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">平均 ★{(qualityStats as { avg?: number | null }).avg ?? '—'}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">已评定 {(qualityStats as { count?: number }).count ?? 0} 项</span>
            {(qualityStats as { low?: number }).low ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">低质&lt;60 {(qualityStats as { low?: number }).low} 项</span> : null}
          </div>
          {((qualityStats as { recent?: Array<Record<string, unknown>> }).recent?.length ?? 0) > 0 && (
            <div className="mt-2 flex items-center gap-1.5 flex-wrap">
              {(qualityStats as { recent?: Array<Record<string, unknown>> }).recent!.map((r: Record<string, unknown>, i: number) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 text-gray-500" title={`${String(r.title)}`}>★{String(r.score)}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* zx_20260908 M2(B1): 本阶段成果交付单（done里程碑→落地任务/主要成果·已验收doc/高质任务 单页直达） */}
      <DeliveryDigestCard projectId={id!} />

      {/* zx_20261002 M11: 本项目外部调用账（MCP/A2A/守护进程——只收账、只读展示） */}
      <ServiceCallCard projectId={id!} />

      {/* zx_20261003 M6: 本项目运行面（守护/作业的当前存量——知识全景此前唯一未上屏的一半） */}
      <KnowledgeFaceCard projectId={id!} />

      {/* zx_20261107_1 B7：首屏卡 ≤6（米勒 7±2 / 老子·无为）——两两同域者收成一组建默认折叠。
          ① 协同组：节点分工（谁能接）+ 协同看板（谁在跑哪件）回答同一件事的两半。 */}
      <details className="mt-3">
        <summary className="cursor-pointer select-none text-sm font-semibold text-gray-700 flex items-center gap-2 py-1">
          <Network className="w-4 h-4 text-teal-600 shrink-0" />协同（节点分工 · 协同看板）
          <span className="text-xs font-normal text-gray-400">谁能接、谁在跑哪件</span>
        </summary>
        {/* zx_20261101_2 M3: 项目节点分工——谁参与/项目角色/项目权重（保存即生效，ANS 只收窄候选并在层内缩放） */}
        <NodeDivisionCard projectId={id!} />

        {/* zx_20261106_3 B8「协」: 协同看板——谁在跑哪件、为何选它、进度到哪、改派过几次（数据同源，不另算） */}
        <CollabBoardCard projectId={id!} />
      </details>

      {/* ② 岗位组：谁来做——绑定后才可指派；规范与经验随岗位跨项目复用。
          IM 拒因「到项目详情的「岗位」里启用」指向的就是这一块（B1 前是断链）。 */}
      <details className="mt-3">
        <summary className="cursor-pointer select-none text-sm font-semibold text-gray-700 flex items-center gap-2 py-1">
          <Users className="w-4 h-4 text-emerald-600 shrink-0" />岗位（谁来做 · 学到什么）
          <span className="text-xs font-normal text-gray-400">绑定后才可指派；经验随岗位跨项目</span>
        </summary>
        <ProjectPositionsCard projectId={id!} />
      </details>

      {/* ③ 知识资产组：知识包（会被注入什么）+ 知识收件箱（新知识从哪来）。 */}
      <details className="mt-3" id="project-knowledge-assets">
        <summary className="cursor-pointer select-none text-sm font-semibold text-gray-700 flex items-center gap-2 py-1">
          <BookOpen className="w-4 h-4 text-indigo-600 shrink-0" />知识资产（知识包 · 知识收件箱）
          <span className="text-xs font-normal text-gray-400">会被注入什么、新知识从哪来</span>
        </summary>
        {/* zx_20261017_1 批七: 项目知识包——预览（与注入同一把尺）+ 导出 JSONL（仅导出，不训练） */}
        <KnowledgePackCard projectId={id!} onChanged={() => void loadBusinessStatus()} />

        {/* zx_20261030_1 M6「荐」: 知识收件箱——增量水位 / 建议的领域包（候选永不自动启用）/ 相似项目（只展示） */}
        <KnowledgeInboxCard projectId={id!} onChanged={() => void loadBusinessStatus()} />
      </details>

      {/* zx_20261029_1「知」: 项目须知——模型读工作目录一次生成的仓库快照。
          它不进普通记忆表（记忆按年限衰减、按相关度检索），而是单独成表 + 稳定前缀注入。 */}
      <div className="bg-white rounded-lg border p-4">
        <div className="flex items-center justify-between mb-2 gap-2">
          <h3 className="font-semibold flex items-center gap-2"><BookOpen className="w-4 h-4 text-cyan-600"/>项目须知
            <span className="text-xs font-normal text-gray-400">· 读工作目录生成的仓库快照，任务执行时自动带上</span>
          </h3>
          <button onClick={() => void handleInitBrief()} disabled={briefWait || briefRec?.status === 'running' || !hasBriefSource}
            title={!hasBriefSource ? '未设置工作目录且项目描述为空，无法初始化' : '重新读一遍工作目录与项目描述并生成须知（后台执行，不阻塞页面）'}
            className="flex items-center gap-1 px-2.5 py-1 border rounded-lg text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 shrink-0">
            <RefreshCw className={`w-3.5 h-3.5 ${briefWait || briefRec?.status === 'running' ? 'animate-spin' : ''}`} />
            {briefWait || briefRec?.status === 'running' ? '生成中…' : briefRec?.brief ? '重新初始化' : '生成须知'}
          </button>
        </div>
        {briefStale === true && (
          <div className="mb-2 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">仓库文件或项目描述已变化，须知可能过期——可点「重新初始化」更新。</div>
        )}
        {briefLoading ? (
          <p className="text-sm text-gray-400 py-2">加载中…</p>
        ) : !briefRec?.brief ? (
          briefErr ? (
            <LoadFailure what="「项目须知」" reason={briefErr} onRetry={() => void loadBrief()} busy={briefLoading} />
          ) : briefRec?.status === 'failed' ? (
            <div className="text-sm p-2 bg-red-50 rounded">
              <p className="text-red-700">生成失败：{briefRec.error || '原因未记录'}</p>
              <p className="text-xs text-gray-500 mt-1">
                尝试模型 {briefRec.attemptModel || '—'} · 失败于 {formatDbTime(briefRec.updatedAt)}。确认工作目录可读、ANS 已连接后点「生成须知」重试。
              </p>
            </div>
          ) : briefRec?.status === 'running' || briefWait ? (
            <p className="text-sm text-gray-500 py-2">正在读工作目录生成须知（通常 1 分钟内完成，可离开本页）。</p>
          ) : (
            <p className="text-sm text-gray-400 py-2">{hasBriefSource ? '尚未生成须知。' : '未设置工作目录且项目描述为空，无法初始化。'}</p>
          )
        ) : (
          <div className="space-y-2 text-sm">
            {briefErr && <LoadFailure what="「项目须知」" reason={briefErr} onRetry={() => void loadBrief()} busy={briefLoading} />}
            {briefRec.status === 'failed' && briefRec.error && (
              <div className="text-xs text-red-700 bg-red-50 rounded px-2 py-1">
                <p>上次重跑失败：{briefRec.error}（下方仍是上一份成功的须知）</p>
                <p className="text-gray-500 mt-0.5">
                  尝试模型 {briefRec.attemptModel || '—'} · 失败于 {formatDbTime(briefRec.updatedAt)}
                </p>
              </div>
            )}
            {briefRec.brief.summary && <p className="text-gray-700">{briefRec.brief.summary}</p>}
            {briefRec.brief.stack.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-xs text-gray-400">技术栈</span>
                {briefRec.brief.stack.map((s, i) => <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700">{s}</span>)}
              </div>
            )}
            {briefRec.brief.commands.length > 0 && (
              <div>
                <p className="text-xs text-gray-400 mb-0.5">常用命令</p>
                <ul className="space-y-0.5">{briefRec.brief.commands.map((c, i) => (
                  <li key={i} className="text-xs"><span className="text-gray-600">{c.name}</span><span className="text-gray-400 mx-1">·</span><code className="font-mono text-gray-700 bg-gray-50 rounded px-1">{c.cmd}</code></li>
                ))}</ul>
              </div>
            )}
            {briefRec.brief.entry_points.length > 0 && (
              <p className="text-xs text-gray-600"><span className="text-gray-400">入口：</span><span className="font-mono">{briefRec.brief.entry_points.join(' · ')}</span></p>
            )}
            {briefRec.brief.layout.length > 0 && (
              <div>
                <p className="text-xs text-gray-400 mb-0.5">目录职责</p>
                <ul className="space-y-0.5">{briefRec.brief.layout.map((l, i) => (
                  <li key={i} className="text-xs"><code className="font-mono text-gray-700">{l.path}</code><span className="text-gray-400 mx-1">—</span><span className="text-gray-600">{l.purpose}</span></li>
                ))}</ul>
              </div>
            )}
            {briefRec.brief.conventions.length > 0 && (
              <p className="text-xs text-gray-600"><span className="text-gray-400">约定：</span>{briefRec.brief.conventions.join('；')}</p>
            )}
            {briefRec.brief.gotchas.length > 0 && (
              <p className="text-xs text-amber-700"><span className="text-gray-400">注意：</span>{briefRec.brief.gotchas.join('；')}</p>
            )}
          </div>
        )}
        {briefRec?.brief && (
          <p className="text-[10px] text-gray-400 mt-2">
            上次成功生成于 {formatDbTime(briefRec.generatedAt || briefRec.updatedAt)} · 模型 {briefRec.model || '—'}（成功那轮） · 约 {formatCount(briefRec.tokensIn + briefRec.tokensOut)} tokens · {briefRec.trigger === 'create' ? '创建时生成' : '手动重跑'}
          </p>
        )}
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-2">
        {[{k:'overview',l:'运行配置'},{k:'memories',l:'项目记忆'},{k:'milestones',l:'里程碑/阻塞'},{k:'deliverables',l:'本项目成果'},{k:'tensions',l:'矛盾张力'},{k:'packs',l:'领域包'}].map(tab=>(
          <button key={tab.k} onClick={()=>setActiveTab(tab.k as typeof activeTab)} className={`px-4 py-1.5 rounded-lg text-sm font-medium ${activeTab===tab.k?'bg-blue-600 text-white':'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{tab.l}</button>
        ))}
      </div>
      {/* A3 (2026-09-03_2): 项目活动时间线入口（对象回看） */}
      <div className="mt-1"><button type="button" onClick={() => navigate(`/activity?obj=${id}`)} className="px-3 py-1.5 rounded-lg text-sm bg-white border text-gray-600 hover:text-blue-600 hover:border-blue-300">项目活动时间线</button></div>

      {/* Tab内容 */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          {/* C1 (2026-09-03): 自适应策略可视（系统自知——道法自然） */}
          {strategyInfo && (strategyInfo.modelStrategy || (strategyInfo.adjustments && strategyInfo.adjustments.length > 0)) && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Lightbulb className="w-4 h-4 text-amber-500"/>自适应策略（系统自知）</h3>
              <div className="grid grid-cols-3 gap-3 text-sm mb-3">
                <div className="p-2 bg-gray-50 rounded"><p className="text-xs text-gray-400">模型策略</p><p className="font-semibold" title={strategyInfo.modelStrategy || undefined}>{strategyInfo.modelStrategy ? statusText(MODEL_STRATEGY_LABEL, strategyInfo.modelStrategy) : '—'}</p></div>
                <div className="p-2 bg-gray-50 rounded"><p className="text-xs text-gray-400">温度</p><p className="font-semibold">{formatStrategyNumber(strategyInfo.temperature)}</p></div>
                <div className="p-2 bg-gray-50 rounded"><p className="text-xs text-gray-400">最大步数</p><p className="font-semibold">{strategyInfo.maxSteps ?? '—'}</p></div>
              </div>
              {strategyInfo.adjustments && strategyInfo.adjustments.length > 0 && (
                <div>
                  <p className="text-xs text-gray-400 mb-1">最近调参（{strategyInfo.adjustments.length}）</p>
                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                    {strategyInfo.adjustments.slice().reverse().map((a, i) => (
                      <li key={i} className="text-xs bg-gray-50 rounded px-2 py-1">
                        <span className="text-gray-400 mr-2">{String((a.at as string) || '').slice(5, 16)}</span>
                        <span className="text-blue-600 mr-2">{a.reason ? statusText(TASK_STATUS_LABEL, a.reason) : ''}</span>
                        <span className="text-gray-600">{formatStrategyAdjustments(a.adjustments)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {/* D1 (2026-09-03): 当前主要矛盾可视（矛盾论——抓主要矛盾） */}
          {bottleneck && ((bottleneck.principals && bottleneck.principals.length > 0) || bottleneck.summary) && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-2 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-red-500"/>当前主要矛盾</h3>
              {bottleneck.summary ? <p className="text-sm text-gray-700 mb-2">{bottleneck.summary}</p> : <p className="text-sm text-gray-400 mb-2">当前无阻塞性主要矛盾</p>}
              {bottleneck.principals && bottleneck.principals.length > 0 && (
                <ul className="space-y-1">
                  {bottleneck.principals.map((p, i) => (
                    <li key={i} className="flex items-center justify-between text-sm bg-red-50 rounded px-2 py-1">
                      <Link to={`/tasks/${String(p.taskId)}`} className="text-blue-600 hover:underline truncate">{String(p.title || p.taskId)}</Link>
                      <span className="text-xs text-gray-500 shrink-0 ml-2">状态 {statusText(TASK_STATUS_LABEL, p.status)} · 动态优先级 {Number(p.dynamicPriority).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {bottleneck.computedAt && <p className="text-[10px] text-gray-400 mt-2">分析时间 {formatDbTime(bottleneck.computedAt)}</p>}
            </div>
          )}
          {/* zx_20261107_1 B7：运行配置与 IM 命令是「改一次长期不动」的配置面，下沉到高级区默认折叠；
              内容逐字未动（含 B6 的项目级模型指定），只是不再抢占首屏。 */}
          <details className="mt-3">
          <summary className="cursor-pointer select-none text-sm font-semibold text-gray-600 flex items-center gap-2 py-1">
            <Terminal className="w-4 h-4 text-gray-500 shrink-0" />高级：运行配置与 IM 命令
            <span className="text-xs font-normal text-gray-400">预算 · 节奏 · 模型指定 · IM 关键词</span>
          </summary>
          <div className="grid grid-cols-2 gap-4 mt-2">
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity className="w-4 h-4"/>运行配置</h3>
              <div className="space-y-2 text-sm">
                {ctx.budget ? <>
                  <div className="flex justify-between"><span className="text-gray-500">Token预算/任务</span><span>{formatCount(ctx.budget.max_tokens_per_task)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">费用上限(¥)/任务</span><span>{formatMoney(ctx.budget.max_cost_usd_per_task)}</span></div>
                  {!ctx.budget.max_cost_usd_per_task && <p className="text-[10px] text-gray-400">费用上限「—」= 本项目暂无金额闸（任务仅按 Token 预算收敛；费用照常累计与展示，可在项目设置中填写上限）</p>}
                </> : <p className="text-gray-400 text-xs">未设置预算</p>}
                {ctx.rhythm ? <div className="flex justify-between"><span className="text-gray-500">活跃时段</span><span>{ctx.rhythm.activeHourStart}:00-{ctx.rhythm.activeHourEnd}:00 · 并发{ctx.rhythm.maxConcurrency||2}</span></div> : <p className="text-gray-400 text-xs">未设置节奏</p>}
                {project.cron_schedule && <div className="flex justify-between"><span className="text-gray-500">Cron</span><span className="font-mono text-xs">{project.cron_schedule}</span></div>}
                {project.working_dir && <div className="flex justify-between"><span className="text-gray-500">工作目录</span><span className="font-mono text-xs truncate">{project.working_dir}</span></div>}
                {/* zx_20261107_1 B6: 项目级模型覆盖——「生效项」由 main 裁定，用户只填「本项目指定」。
                    池外回落与逐次来源记在任务选型记录里（本页不判"这模型在不在池"。） */}
                <div className="pt-2 border-t border-gray-100">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-500">模型</span>
                    <span className="text-xs">
                      {modelOv?.effective ? (
                        <>{modelOv.effective.requested}
                          <span className="text-gray-400 ml-1">（{PIN_SOURCE_LABEL[modelOv.effective.source] ?? modelOv.effective.source}）</span>
                        </>
                      ) : <span className="text-gray-400">按任务自动选型</span>}
                    </span>
                  </div>
                  <div className="flex gap-1 mt-1">
                    <input
                      value={modelDraft}
                      onChange={e => setModelDraft(e.target.value)}
                      placeholder="本项目指定模型（留空=跟随全局/自动）"
                      className="flex-1 min-w-0 border rounded px-2 py-1 text-xs"
                    />
                    <button onClick={() => void saveModelOverride()} disabled={modelSaving} className="px-2 py-1 text-xs bg-blue-600 text-white rounded disabled:opacity-50">保存</button>
                    {modelOv?.project_override && (
                      <button onClick={() => void saveModelOverride(null)} disabled={modelSaving} className="px-2 py-1 text-xs border rounded">清除</button>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1">优先级：恢复路（续跑沿用）&gt; 本项目指定 &gt; 全局默认；指定模型不在本次可用池时自动回落，并如实记入任务选型记录。</p>
                </div>
              </div>
            </div>
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Terminal className="w-4 h-4"/>IM 命令 ({Object.keys(ctx.im_commands||{}).length})</h3>
              {ctx.im_commands && Object.keys(ctx.im_commands).length>0 ? (
                <div className="space-y-1 max-h-48 overflow-y-auto">{Object.entries(ctx.im_commands).map(([cmd, info])=>(
                  <div key={cmd} className="flex items-center justify-between text-sm py-1 px-2 bg-gray-50 rounded">
                    <span className="font-mono text-xs text-blue-600">"{cmd}"</span>
                    <span className="text-xs text-gray-400 mx-2">→</span>
                    <span className="text-xs text-gray-500">{info.label}</span>
                  </div>
                ))}</div>
              ) : <p className="text-gray-400 text-xs">未配置 IM 命令</p>}
            </div>
          </div>
          </details>

          {/* 多维度健康视图 */}
          {(Object.keys(healthViews).length > 0 || healthErr) && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-green-500"/>多维度健康视图</h3>
              {healthErr && <div className="mb-3"><LoadFailure what="「健康视图」" reason={healthErr} onRetry={() => void loadHealthViews()} busy={healthBusy} /></div>}
              <div className="grid grid-cols-3 gap-3">
                {(['investor', 'developer', 'manager'] as const).map(view => {
                  const v = healthViews[view];
                  if (!v) return null;
                  const score = v.score as number ?? 0;
                  return (
                    <div key={view} className="p-3 bg-gray-50 rounded border">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-sm font-medium">{statusText(HEALTH_VIEW_LABEL, view)}</span>
                        <span className={`text-lg font-bold ${score >= 80 ? 'text-green-600' : score >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>{score}</span>
                      </div>
                      {Object.entries(v).filter(([k]) => k !== 'score' && k !== 'parkedReason').map(([k, val]) => (
                        <div key={k} className="flex justify-between text-xs py-0.5"><span className="text-gray-500" title={k}>{statusText(HEALTH_METRIC_LABEL, k)}</span><span>{String(val)}</span></div>
                      ))}
                      {/* zx_20260930 M11-7: 待办搁置——「有任务在队列里，但项目当前不参与自动调度」。
                          `parkedReason` 是**一句人话**不是指标，故不混进上面那串指标行（此前那种做法会把它
                          挤成一行超长灰字）。单看条数会误以为"调度器漏了"，故条数与因由同处呈现。 */}
                      {view === 'manager' && Number(v.parkedTaskCount) > 0 && (
                        <div className="mt-2 pt-2 border-t border-gray-200 text-[11px] text-orange-700">⏸ {Number(v.parkedTaskCount)} 个待办未自动拉起：{String(v.parkedReason || '原因未记录')}<span className="text-gray-400">（恢复项目运行/回到活跃时段后会自动接上）</span></div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 知识全景 */}
          {(panorama || panoErr) && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Brain className="w-4 h-4 text-indigo-500"/>知识全景</h3>
              {panoErr && <div className="mb-3"><LoadFailure what="「知识全景」" reason={panoErr} onRetry={() => void loadPanorama()} busy={panoBusy} /></div>}
              {panorama && <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="p-3 bg-gray-50 rounded">
                  <p className="text-xs text-gray-400 mb-1">记忆总览</p>
                  <p className="font-bold">{Number((panorama.memorySummary as Record<string, unknown>)?.total ?? 0)} 条记忆</p>
                  <p className="text-xs text-gray-500 mt-1">语义 {(panorama.memorySummary as Record<string, unknown>)?.byType ? ((panorama.memorySummary as Record<string, unknown>).byType as Record<string, number>).semantic : 0} · 情景 {((panorama.memorySummary as Record<string, unknown>).byType as Record<string, number>)?.episodic ?? 0} · 程序 {((panorama.memorySummary as Record<string, unknown>).byType as Record<string, number>)?.procedural ?? 0}</p>
                </div>
                <div className="p-3 bg-gray-50 rounded">
                  <p className="text-xs text-gray-400 mb-1">知识图谱</p>
                  <p className="font-bold">{Number((panorama.graphSummary as Record<string, unknown>)?.totalTriples ?? 0)} 个三元组</p>
                  <p className="text-xs text-gray-500 mt-1">核心实体: {((panorama.graphSummary as Record<string, unknown>).topEntities as Array<{name:string}>|undefined)?.slice(0,4).map(e=>e.name).join('、') || '无'}</p>
                </div>
                {/* zx_20260906 批3 (3c): 产出物 byType 分布。
                    zx_20261107_1 B7: 总数不再在此重印（统计卡「产出物（项目合计）」已是同一把尺的唯一落点），
                    本格只做类型分解，且分项与总数取自**同一个** `projectDeliverables`。 */}
                <div className="p-3 bg-gray-50 rounded" title="产出物类型分布（与统计卡「产出物（项目合计）」同源）">
                  <p className="text-xs text-gray-400 mb-1">产出物类型分布</p>
                  <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                    {Object.entries(projectDeliverables || {}).map(([t, c]) => t !== 'total' && c > 0 ? (
                      <span key={t} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${DELIV_TYPE_CLS[t] || 'bg-gray-100 text-gray-600'}`}>{DELIVERABLE_TYPE_LABEL[t] || t} {c}</span>
                    ) : null)}
                  </div>
                </div>
                <div className="p-3 bg-gray-50 rounded">
                  <p className="text-xs text-gray-400 mb-1">执行模式</p>
                  <p className="font-bold">{Number((panorama.executionSummary as Record<string, unknown>)?.totalTasks ?? 0)} 个完成任务</p>
                  <p className="text-xs text-gray-500 mt-1">平均 {Number((panorama.executionSummary as Record<string, unknown>)?.avgSteps ?? 0)} 步/任务</p>
                </div>
              </div>
              {/* zx_20260906 批3 (3c): 最近产出物（跨类型 ≤5，随 deliverable.* 事件刷新）
                  zx_20260909 X1(可直达·消三跳): 行内点开"就地成果详情抽屉"(doc_drawer 门控) */}
              {(((panorama.deliverableSummary as Record<string, unknown>)?.recentDeliverables as Array<{ id?: string; name: string; type: string; status: string; created_at?: string }> | undefined)?.length ?? 0) > 0 && (
                <div className="mt-3 border border-indigo-100 rounded p-2.5 bg-indigo-50/40">
                  <p className="text-[11px] font-medium text-indigo-700 mb-1.5">最近产出物（点行开详情）</p>
                  <ul className="space-y-1">
                    {((panorama.deliverableSummary as Record<string, unknown>).recentDeliverables as Array<{ id?: string; name: string; type: string; status: string; created_at?: string }>).map((r, i) => (
                      <li key={i}
                        onClick={() => { if (drawerOn && r.id) openDeliv(r.id); else navigate('/deliverables'); }}
                        className={`flex items-center gap-2 text-xs cursor-pointer hover:bg-white rounded px-1 -mx-1`}
                        title={drawerOn && r.id ? '查看成果详情' : '打开产出物页'}>
                        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${DELIV_TYPE_CLS[r.type] || 'bg-gray-100 text-gray-600'}`}>{DELIVERABLE_TYPE_LABEL[r.type] || r.type}</span>
                        <span className={`truncate flex-1 ${r.status === 'completed' ? 'text-gray-700' : 'text-gray-500'}`}>{r.name}</span>
                        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${r.status === 'completed' ? 'bg-green-100 text-green-700' : r.status === 'running' ? 'bg-green-100 text-green-700' : r.status === 'failed' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500'}`}>{DELIVERABLE_STATUS_LABEL[r.status] || r.status}</span>
                        <span className="shrink-0 text-gray-400 text-[10px]">{formatDbTime(r.created_at, { dateOnly: true })}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(panorama.missingArchetypes as Array<{label:string}>|undefined)?.length ? (
                <div className="mt-3 p-3 bg-yellow-50 rounded">
                  <p className="text-xs font-medium text-yellow-700">知识空白（未覆盖的任务类型）:</p>
                  <p className="text-xs text-yellow-600 mt-1">{(panorama.missingArchetypes as Array<{label:string}>).map(a=>a.label).join('、')}</p>
                </div>
              ) : null}
              </>}
            </div>
          )}

          {/* 成员管理 */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Clock className="w-4 h-4 text-gray-500"/>成员管理 ({members.length})</h3>
            {membersErr && <div className="mb-2"><LoadFailure what="「项目成员」" reason={membersErr} onRetry={() => void loadMembers()} busy={membersBusy} /></div>}
            {usersErr && <div className="mb-2"><LoadFailure what="「用户列表」" reason={usersErr} onRetry={() => void loadMembers()} busy={membersBusy} /></div>}
            {members.length === 0 ? (membersErr ? null : <p className="text-xs text-gray-400">暂无成员</p>) : (
              <div className="space-y-1 mb-3">
                {members.map((m: Record<string, unknown>, i: number) => (
                  <div key={i} className="flex items-center justify-between text-sm py-1 px-2 bg-gray-50 rounded">
                    <span className="font-medium">{m.name as string}</span>
                    <span className="text-xs text-gray-400">{m.email as string}</span>
                    <span className="text-xs text-blue-600">{m.role as string}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <select value={addMemberId} onChange={e => setAddMemberId(e.target.value)} className="flex-1 px-2 py-1 border rounded text-xs">
                <option value="">选择用户添加...</option>
                {users.filter((u: Record<string, unknown>) => !members.some((m: Record<string, unknown>) => m.id === u.id)).map((u: Record<string, unknown>) => (
                  <option key={u.id as string} value={u.id as string}>{u.name as string} ({u.email as string})</option>
                ))}
              </select>
              <button onClick={handleAddMember} disabled={!addMemberId} className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50">添加</button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'memories' && (
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2"><Brain className="w-4 h-4"/>项目记忆</h3>
            <button onClick={() => loadMemories(memTypeFilter)} className="p-1 hover:bg-gray-100 rounded" title="刷新"><RefreshCw className="w-3.5 h-3.5"/></button>
          </div>
          {/* 类型筛选 */}
          <div className="flex gap-1.5 mb-3 flex-wrap">
            <button onClick={() => setMemTypeFilter('')} className={`px-2.5 py-1 rounded text-xs font-medium ${memTypeFilter===''?'bg-blue-600 text-white':'bg-gray-100 text-gray-600'}`}>全部 ({memories.length})</button>
            {memCounts.map(c => (
              <button key={c.memory_type} onClick={() => setMemTypeFilter(c.memory_type)} className={`px-2.5 py-1 rounded text-xs font-medium ${memTypeFilter===c.memory_type?'bg-blue-600 text-white':'bg-gray-100 text-gray-600'}`}>{MEMORY_TYPES[c.memory_type]||c.memory_type} ({c.cnt})</button>
            ))}
          </div>
          {memLoading ? <p className="text-sm text-gray-400 py-4">加载中...</p> : memories.length===0 ? <p className="text-gray-400 text-sm py-4 text-center">暂无记忆</p> : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {memories.map((m: Record<string,unknown>) => {
                const hasConflict = (() => { try { const j = JSON.parse(String(m.context_json||'{}')); return !!(j.conflict_flag || j.potential_conflict); } catch { return false; } })();
                return (
                <div key={m.id as string} className="border rounded p-3 text-sm">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{MEMORY_TYPES[m.memory_type as string] || String(m.memory_type)}</span>
                    {(m.importance as number) > MEM_IMPORTANCE_DEFAULT && <span className="text-yellow-500 text-[10px]">★{(m.importance as number).toFixed(1)}</span>}
                    <span className="text-xs text-gray-400">{String(m.source || '')}</span>
                    {hasConflict && <span className="text-[10px] px-1 rounded bg-red-100 text-red-600">冲突</span>}
                    {(m.use_count as number) > 0 && <span className="text-[10px] text-gray-400">引用{m.use_count as number}次</span>}
                  </div>
                  <p className="text-gray-700">{(m.content as string)?.slice(0, 200)}</p>
                  <p className="text-xs text-gray-400 mt-1">{formatDbTime(m.created_at as string)}{m.last_used_at ? ` · 最近访问:${formatDbTime(m.last_used_at as string)}` : ''}</p>
                </div>
              )})}
            </div>
          )}
        </div>
      )}

      {activeTab === 'milestones' && (
        <div className="space-y-4">
          {/* 方案里程碑(M0-M6)项目级进度（zx_20260905 批4：聚合 wa_plan_milestones，doing 随实施任务动工自动流转） */}
          {!milestoneLoading && planMilestones.length > 0 && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Check className="w-4 h-4 text-teal-500"/>方案里程碑(M0-M6)进度</h3>
              <div className="space-y-3">{shownBoards.map((p: Record<string,unknown>)=>(
                <div key={String(p.plan_task_id)} className="border border-gray-100 rounded p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-gray-800 truncate max-w-[55%]">{String(p.plan_title || '方案')}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-teal-50 text-teal-700">{String(p.done)}/{String(p.total)} 已落地</span>
                    <button type="button" onClick={()=>navigate(`/tasks/${String(p.plan_task_id)}`)} className="ml-auto text-xs text-teal-600 hover:text-teal-800">查看方案任务 →</button>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {/* zx_20260906_1 3e: M chip 含 impl 时可点进对应实施任务（量变质变·语言游戏——里程碑状态有合法"玩法"：跳转落地任务） */}
                    {(p.milestones as Array<Record<string,unknown>>).map((m: Record<string,unknown>,j:number)=>(
                      m.impl ? (
                        <button key={j} type="button" onClick={()=>navigate(`/tasks/${String(m.impl)}`)} className={`text-[10px] px-1.5 py-0.5 rounded font-mono hover:ring-1 hover:ring-blue-400 cursor-pointer ${m.st==='done'?'bg-green-100 text-green-700 hover:bg-green-200':m.st==='doing'?'bg-amber-100 text-amber-700 ring-1 ring-amber-300 hover:bg-amber-200':'bg-gray-100 text-gray-500 hover:bg-gray-200'}`} title={`${String(m.ms)} · ${m.st==='done'?'已落地':m.st==='doing'?'进行中':'待实施'} · 点击打开落地任务`}>{String(m.ms)}{m.st==='done'?'✓':m.st==='doing'?'●':'○'}</button>
                      ) : (
                        <span key={j} className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${m.st==='done'?'bg-green-100 text-green-700':m.st==='doing'?'bg-amber-100 text-amber-700 ring-1 ring-amber-300':'bg-gray-100 text-gray-500'}`} title={`${String(m.ms)} · ${m.st==='done'?'已落地':m.st==='doing'?'进行中':'待实施'}`}>{String(m.ms)}{m.st==='done'?'✓':m.st==='doing'?'●':'○'}</span>
                      )
                    ))}
                  </div>
                </div>
              ))}</div>
              {idleBoards.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowIdleBoards((v) => !v)}
                  className="mt-3 text-xs text-gray-500 hover:text-teal-700 underline underline-offset-2"
                  title="空转看板：板上没有任何里程碑处于进行中或已落地"
                >
                  {showIdleBoards ? '收起空转看板' : `另有 ${idleBoards.length} 块方案看板尚无任何里程碑推进`}
                </button>
              )}
            </div>
          )}
          {/* 阻塞分析（修复：analyzeBlockers 实际返回 taskId/title/status/blockedCount/impactScore） */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-red-500"/>阻塞项 ({blockers.length})</h3>
            {milestoneLoading ? <p className="text-sm text-gray-400 py-2">加载中...</p> : blockers.length===0 ? <p className="text-sm text-gray-400">未检测到阻塞项</p> : (
              <div className="space-y-2">{blockers.map((b: Record<string,unknown>,i:number)=>(
                <div key={i} className="flex items-start gap-2 text-sm p-2 bg-red-50 rounded">
                  <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0"/>
                  <div className="min-w-0">
                    <button type="button" onClick={()=>b.taskId && navigate(`/tasks/${String(b.taskId)}`)} className="font-medium text-red-800 hover:underline text-left" title="打开该任务详情">{String(b.title ?? b.taskId ?? '—')}</button>
                    <p className="text-xs text-red-500 mt-0.5">阻塞 {String(b.blockedCount ?? '?')} 个下游任务 · 影响分 {String(b.impactScore != null ? Math.round(Number(b.impactScore)) : '—')} · [{String(b.status ?? '')}]</p>
                  </div>
                </div>
              ))}</div>
            )}
          </div>
          {/* 里程碑建议（启发式 phase_transition/refactor/knowledge_mature，与方案 M0-M6 语义不同） */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Lightbulb className="w-4 h-4 text-blue-500"/>里程碑建议 ({milestones.length})</h3>
            {milestoneLoading ? <p className="text-sm text-gray-400 py-2">加载中...</p> : milestones.length===0 ? <p className="text-sm text-gray-400">暂无建议</p> : (
              <div className="space-y-2">{milestones.map((ml: Record<string,unknown>,i:number)=>(
                <div key={i} className="text-sm p-2 bg-blue-50 rounded">
                  <p className="font-medium text-blue-800">{String(ml.title ?? ml.milestone ?? '')}</p>
                  <p className="text-xs text-blue-500 mt-0.5">{String(ml.type ?? '')}{ml.reason ? ` · ${String(ml.reason)}` : ''}</p>
                </div>
              ))}</div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'tensions' && (
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Activity className="w-4 h-4 text-blue-500"/>矛盾张力面板（矛盾论）</h3>
          {Object.keys(tensionConfigs).length === 0 ? <p className="text-sm text-gray-400 py-4 text-center">暂无张力数据</p> : (
            <div className="space-y-4">
              {Object.entries(tensionConfigs).map(([tid, cfg]) => {
                const t = tensions[tid] || { position: 50 };
                const pos = tensionDraft[tid] ?? (t.position as number) ?? 50;
                return (
                  <div key={tid} className="p-3 border rounded">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="font-medium">{cfg.name as string}</span>
                      <span className="text-xs text-gray-400">{cfg.description as string}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-20 text-right">{cfg.leftLabel as string} ({100-pos}%)</span>
                      <input type="range" min={0} max={100} value={pos} onChange={e => onTensionInput(tid, Number(e.target.value))} className="flex-1"/>
                      <span className="text-xs text-gray-500 w-20">{cfg.rightLabel as string} ({pos}%)</span>
                    </div>
                    {/* zx_20260905 批6: 自动调节开关——启用后主进程每5min按规则自动微调并实时回推本页(此前 autoAdjust 无 UI 入口=默认 false 永不触发) */}
                    <label className="mt-2 flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                      <input type="checkbox" checked={!!(t.autoAdjust)} onChange={(e) => { void projects.updateTension(id!, tid, undefined, e.target.checked); window.setTimeout(loadTensions, 150); }} />
                      自动调节 <span className="text-gray-400">（每5min按规则微调，变更实时回推）</span>
                      {!!(t.autoAdjust) && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600">已启用</span>}
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* zx_20260930 M3-d(本项目成果): 「本项目的产出」不必再跳全局页。
          三处共用（不新造第二套）：取数端口 `deliverables.list(projectId)`、类型/状态**同一份词表**、
          行点开**同一个**就地抽屉（doc_drawer 门控，与全局页/最近产出物行同尺）。 */}
      {activeTab === 'deliverables' && (
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2"><Package className="w-4 h-4 text-amber-500"/>本项目成果
              {/* zx_20260930 M4-2: 「已加载 K / 共 M」——两个数各是各的口径（K=已取到的行、M=服务端全量），
                  分页后只印 K 会把"还没取"说成"只有这些"。 */}
              <span className="text-xs font-normal text-gray-400">· 已加载 {pjDelivs.length} / 共 {pjDelivTotal} 条（含已退休）</span>
            </h3>
            <div className="flex items-center gap-2">
              <button onClick={() => void loadProjectDeliverables()} className="p-1.5 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-3.5 h-3.5 text-gray-500" /></button>
              <button onClick={() => navigate('/deliverables')} className="text-xs px-2 py-1.5 border rounded-lg text-gray-600 hover:bg-gray-50" title="打开产出物管理（跨项目、含筛选与批量操作）">在产出物管理中查看</button>
            </div>
          </div>
          {pjDelivLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full" /></div>
          ) : pjDelivs.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">本项目暂无成果</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b text-xs text-gray-500">
                <tr>
                  <th className="text-left p-2 font-medium">名称</th>
                  <th className="text-left p-2 font-medium">类型</th>
                  <th className="text-left p-2 font-medium">状态</th>
                  <th className="text-left p-2 font-medium">大小</th>
                  <th className="text-left p-2 font-medium">产出任务</th>
                  <th className="text-left p-2 font-medium">最近变更</th>
                </tr>
              </thead>
              <tbody>
                {pjDelivs.map((d) => {
                  const id2 = String(d.id);
                  const type = String(d.type ?? '');
                  const status = String(d.status ?? '');
                  const retired = status === 'retired';
                  return (
                    <tr key={id2}
                      onClick={() => { if (drawerOn) openDeliv(id2); else if (d.task_id) navigate(`/tasks/${d.task_id}`); }}
                      className={`border-t hover:bg-gray-50 ${drawerOn || d.task_id ? 'cursor-pointer' : ''} ${retired ? 'opacity-60 bg-gray-50' : ''}`}>
                      <td className="p-2 font-medium">{String(d.name ?? '')}</td>
                      <td className="p-2"><span className={`text-[10px] px-1.5 py-0.5 rounded ${DELIV_TYPE_CLS[type] || 'bg-gray-100 text-gray-600'}`}>{DELIVERABLE_TYPE_LABEL[type] || type}</span></td>
                      <td className="p-2"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{DELIVERABLE_STATUS_LABEL[status] || status}</span></td>
                      {/* 未知大小印 `—`（不冒充 0 字节）——与全局页同一条判据 */}
                      <td className="p-2 text-xs text-gray-500 whitespace-nowrap">{formatBytes(d.size_bytes as number | null | undefined)}</td>
                      <td className="p-2 text-xs text-gray-500">
                        {d.task_id
                          ? <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${d.task_id}`); }}
                              className="text-blue-500 hover:text-blue-700 hover:underline truncate max-w-[180px]" title={String(d.task_title || d.task_id)}>
                              {String(d.task_title || '未知任务')}
                            </button>
                          : <span className="text-gray-400">项目级</span>}
                      </td>
                      <td className="p-2 text-xs text-gray-400 whitespace-nowrap">{formatDbTime(String(d.updated_at || d.created_at || '')) || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {/* zx_20260930 M4-2: 分页页脚——与全局成果页同一形状（「已加载 K / 共 M」+「加载更多」）。
              只在**还有未加载行时**出现。 */}
          {!pjDelivLoading && pjDelivs.length > 0 && !pjDelivExhausted && (
            <div className="flex items-center justify-between gap-3 border-t px-2 py-2 mt-1 bg-gray-50/60 text-xs text-gray-500">
              <span>已加载 {pjDelivs.length} / 共 {pjDelivTotal} 条</span>
              <button onClick={() => void loadMoreProjectDeliverables()} disabled={pjDelivMoreBusy}
                title="取下一页（按已列出的条数作偏移，同一条不会重复列出）"
                className="px-2 py-1 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                {pjDelivMoreBusy ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* zx_20261021_3 批五: 领域包页签——生成/启用/撤销/注入成效。判据与闸全在 main（core/domain-pack）。
          事件驱动重载靠换 key（卡内 load 的 effect 挂在 projectId 上，key 变即重挂）。 */}
      {activeTab === 'packs' && (
        <DomainPackCard key={packTick} projectId={id!} onChanged={() => void loadBusinessStatus()} />
      )}

      {ctx.cron_run_command && <div className="bg-white rounded-lg border p-4"><h3 className="font-semibold mb-2 flex items-center gap-2"><Clock className="w-4 h-4"/>Cron 运行命令</h3><pre className="text-xs font-mono bg-gray-50 p-2 rounded overflow-x-auto">{ctx.cron_run_command}</pre></div>}

      {/* 编辑弹窗（含 budget/rhythm） */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={()=>setEditing(false)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">编辑项目</h3>
            <div className="space-y-3">
              <div><label className="text-sm font-medium">名称</label><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1"/></div>
              <div><label className="text-sm font-medium">描述</label><textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1" rows={2}/></div>
              <div>
                <label className="text-sm font-medium">Cron</label>
                <input value={form.cron_schedule} onChange={e=>setForm({...form,cron_schedule:e.target.value})} className={`w-full px-3 py-2 border rounded-lg text-sm mt-1 font-mono ${cronRaw && !cronValid ? 'border-red-400' : ''}`} placeholder="0 9 * * 1-5"/>
                {cronRaw && !cronValid && <p className="text-xs text-red-600 mt-1">Cron 需 5 段（分 时 日 月 周），例如 `0 9 * * 1-5`；非法表达式不会生效，先改对再保存。</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-sm font-medium">时区</label><input value={form.cron_timezone} onChange={e=>setForm({...form,cron_timezone:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1"/></div>
                <div><label className="text-sm font-medium">沙箱模式</label><select value={form.sandbox_mode} onChange={e=>setForm({...form,sandbox_mode:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1"><option value="workspace">工作区(可写)</option><option value="strict">严格只读</option><option value="off">无限制</option></select></div>
              </div>
              <div><label className="text-sm font-medium">自主模式</label><select value={form.autonomous_mode} onChange={e=>setForm({...form,autonomous_mode:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1"><option value="off">关闭</option><option value="auto">全自动</option><option value="semi">半自动</option></select></div>
              <div><label className="text-sm font-medium">工作目录</label><input value={form.working_dir} onChange={e=>setForm({...form,working_dir:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1 font-mono text-xs"/></div>
              <hr/>
              <p className="text-sm font-semibold text-gray-700">Cron 任务配置</p>
              <div><label className="text-xs text-gray-500">定时任务标题</label><input value={cronForm.cron_task_title} onChange={e=>setCronForm({...cronForm,cron_task_title:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5" placeholder="定时任务标题（创建AI任务时用）"/></div>
              <div><label className="text-xs text-gray-500">定时任务描述</label><textarea value={cronForm.cron_task_desc} onChange={e=>setCronForm({...cronForm,cron_task_desc:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5" rows={2} placeholder="定时任务描述（可选）"/></div>
              <div><label className="text-xs text-gray-500">Cron 运行命令</label><input value={cronForm.cron_run_command} onChange={e=>setCronForm({...cronForm,cron_run_command:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5 font-mono text-xs" placeholder="python3 run_scheduled.py（直接执行脚本，绕过AI）"/></div>
              <hr/>
              <p className="text-sm font-semibold text-gray-700">预算设置</p>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-gray-500">Token预算/任务</label><input type="number" value={budgetForm.max_tokens_per_task} onChange={e=>setBudgetForm({...budgetForm,max_tokens_per_task:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5" placeholder="500000"/></div>
                <div><label className="text-xs text-gray-500">费用上限(¥)/任务</label><input type="number" step="0.01" value={budgetForm.max_cost_usd_per_task} onChange={e=>setBudgetForm({...budgetForm,max_cost_usd_per_task:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5" placeholder="留空 = 不设金额闸"/></div>
              </div>
              <p className="text-sm font-semibold text-gray-700 mt-2">资源节奏</p>
              <div className="grid grid-cols-3 gap-3">
                <div><label className="text-xs text-gray-500">活跃起始(时)</label><input type="number" min={0} max={23} value={rhythmForm.activeHourStart} onChange={e=>setRhythmForm({...rhythmForm,activeHourStart:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5"/></div>
                <div><label className="text-xs text-gray-500">活跃结束(时)</label><input type="number" min={0} max={23} value={rhythmForm.activeHourEnd} onChange={e=>setRhythmForm({...rhythmForm,activeHourEnd:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5"/></div>
                <div><label className="text-xs text-gray-500">最大并发</label><input type="number" min={1} max={10} value={rhythmForm.maxConcurrency} onChange={e=>setRhythmForm({...rhythmForm,maxConcurrency:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-0.5"/></div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6"><button onClick={()=>setEditing(false)} className="px-4 py-2 border rounded-lg text-sm">取消</button><button onClick={handleSave} disabled={!cronValid} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed">保存</button></div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗（与 `ProjectsPage` 共用一处真源） */}
      {showDelete && project && (
        <DeleteProjectDialog
          projectId={project.id}
          projectName={project.name}
          onCancel={() => setShowDelete(false)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
