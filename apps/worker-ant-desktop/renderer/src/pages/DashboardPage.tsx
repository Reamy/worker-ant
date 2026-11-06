import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { admin, ansProxy, invoke } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { JOB_STATUS_LABEL } from '../lib/status-view';
import { FreshnessPill } from '../components/FreshnessPill';
import { useStaleness } from '../lib/useLiveQuery';
// zx_20260924_1 M6（F7）: 自省两本账的形状由 main 侧真源提供（与 lib/ipc.ts 的 `admin.diagnostics()` 同源）——
//   此前在此手抄过一份窄镜像并用 `as unknown as` 强转，强转会把"类型漂移"盖住。
import type { SimplificationReport } from '../../../src/main/core/simplification-audit.js';
import type { HealingRecord } from '../../../src/main/core/self-healing-monitor.js';
// zx_20261016_3 批四（M34）：自产提案的**状态词表第二落点**——同引自 main 侧零运行期 import 的真源
//   （`self-evolve.ts`），不在此手抄一份"pending/applied 各叫什么"。手抄的那份会在真源加态时悄悄骗人。
import { SELF_EVOLVE_STATUSES, type SelfEvolveProposal, type ProposalDecision } from '../../../src/main/core/self-evolve.js';
// zx_20260930 M14-1（维特根斯坦·一个用途一个词）：自愈结果态的**词表第二落点**——渲染层跨 root 引
//   `healing-outcome.ts`（零 import ⇒ 引得动），不在此手抄一份"什么算成功"。改前这里按 `h.success` 二值
//   显示，于是"仅记录 / 需人工 / 已熔断"三种结果**全被显示成"失败"**（与"真的修好了"只差一个颜色）。
import { HEAL_OUTCOME_LABEL, healOutcomeOf, type HealOutcome } from '../../../src/main/core/healing-outcome.js';
// zx_20260930 M14-4（维特根斯坦·一个用途一个词）：健康三态词表的**第二落点**——同样跨 root 引真源
//   （`health-check.ts` 的运行时依赖只有零 import 的 `im-channel-status.ts` ⇒ 引得动），
//   不在此手抄一份"ok/degraded/unavailable 各叫什么"。改前这里按 `status==='healthy'` 判——
//   新三态进来后 `ok` 与 `unavailable` **会被显示成同一个词**（"空闲"），正是"名实不符"。
import { HEALTH_LEVEL_LABEL, type HealthLevel, type HealthReport } from '../../../src/main/core/health-check.js';
import { Clock, Activity, AlertTriangle, CheckCircle, XCircle, BarChart3, RefreshCw, TrendingUp, Wrench, Heart, FileText, GitBranch, Server } from 'lucide-react';
// 产出物类型词表——与产出物各页共此一份真源（此前此处另有窄表，缺 code 且简写 "MCP"/"守护"）
import { DELIVERABLE_TYPE_LABEL } from '../lib/deliverable-view';
// zx_20261011_5「名正而后事成」: 首屏**诚实空态**——首启判据补了模型前提，但"软跳过/老用户"仍可能无可用
//   chat 模型而看到一片空白。此处按 `setup:model-availability` 的**三态**如实提示（401/读失败/0 目录/缺 chat
//   分家说），不把"读不动"混成"没配"。文案真源在 `probe-models.ts`（与向导②同一句）。
import { modelAvailability } from '../lib/firstRun';
import { probeModelsLine } from '../lib/probe-models';
// zx_20261013_1 批三「称引于人」: 首启**一次性**导览——落点/闸在 `tourGate`（纯判定），
//   词表在 `navConfig`（从导航配置派生），本页只负责**弹一次 + 写标记**（一处写口）。
import { TOUR_SETTING_KEY, parseTourDone, shouldShowTour } from '../lib/tourGate';
import { skipOnboarding, isOnboardingSkipped } from '../lib/onboardingSkip';
import TourOverlay from '../components/TourOverlay';
import type { ModelProbe } from '../../../src/main/core/model-availability.js';

// zx_20260930 M14-4: `report` 是 M14-3 的**真健康自检**结果（五面 × 三态 × 一句依据），
//   由 `admin:health` 一并下发——界面若只读 `status` 一个词，五面的**依据**就全丢了。
interface HealthData { status: string; report?: HealthReport; projects: number; tasks: number; runningTasks: number; enabledChannels: number; uptime: number; }
interface StatsData { totalTokens?: number; totalMemories?: number; totalDeliverables?: number; }
interface EventItem { event_type: string; aggregate_type: string; occurred_at: string; payload: string; }

/**
 * 六态的观感（zx_20260930 M14-1；zx_20261002 M12-1 增 `pending_recheck`）。`Record<HealOutcome, string>`
 * 是**穷举**：词表若再加一态，这里立刻类型报错——不会出现"新态悄悄沿用旧的绿底"这种名不副实。
 * 颜色只表达**语义强弱**（是否办成）：`recorded`（仅记录）刻意用**灰**而非红（既不是成功也不是失败，
 * 是"看清了、记了一笔"）；`pending_recheck`（待复验）用**淡蓝**——做了、但还没被证实，既不该绿也不该红。
 */
const HEAL_OUTCOME_CLASS: Record<HealOutcome, string> = {
  healed: 'bg-green-100 text-green-700',
  pending_recheck: 'bg-sky-100 text-sky-700',
  recorded: 'bg-gray-100 text-gray-600',
  needs_human: 'bg-amber-100 text-amber-700',
  skipped_alarm: 'bg-orange-100 text-orange-700',
  failed: 'bg-red-100 text-red-700',
};

/**
 * 自产提案五态的观感（zx_20261016_3 批四）。与上面两份**同一把尺**：`Record<SelfEvolveStatus, …>` 是
 * **穷举**——真源加了态这里立刻类型报错，不会出现"新态悄悄沿用旧色"。色义按"离生效多远"：
 * `pending`（等人工）灰 / `approved`（批了但没有应用器）淡蓝 / `applied`（**行为真变了**）绿 /
 * `rejected` 红 / `rolled_back`（生效过、已还原）琥珀。
 */
type ProposalStatusMeta = { label: string; cls: string };
const PROPOSAL_STATUS_META: Record<(typeof SELF_EVOLVE_STATUSES)[number], ProposalStatusMeta> = {
  pending: { label: '待批', cls: 'bg-gray-100 text-gray-600' },
  approved: { label: '已批准（未生效）', cls: 'bg-sky-100 text-sky-700' },
  applied: { label: '已生效', cls: 'bg-green-100 text-green-700' },
  rejected: { label: '已拒绝', cls: 'bg-red-100 text-red-700' },
  rolled_back: { label: '已回滚', cls: 'bg-amber-100 text-amber-700' },
};
/** 库里真出了词表外的状态 ⇒ **如实显示原文** + 中性色（不假装它属于某一态，也不藏起来）。 */
function proposalStatusMeta(status: string): ProposalStatusMeta {
  const m = (PROPOSAL_STATUS_META as Record<string, ProposalStatusMeta | undefined>)[status];
  return m ?? { label: status, cls: 'bg-gray-100 text-gray-600' };
}

/**
 * 健康三态的观感（zx_20260930 M14-4）。同样是**穷举** `Record<HealthLevel, string>`：
 * 词表再加一态即类型报错，不会出现"新态悄悄沿用旧的绿底"。
 */
const HEALTH_LEVEL_CLASS: Record<HealthLevel, string> = {
  ok: 'bg-green-100 text-green-700',
  degraded: 'bg-yellow-100 text-yellow-700',
  unavailable: 'bg-red-100 text-red-700',
};

/**
 * 取整体健康态——**只认 `report`**（`report` 缺失即如实返回 `null`，界面显示"—"）。
 * 不拿旧 `status` 字面量猜一个词出来：那正是"名实不符"的入口（旧码把 `ok`/`unavailable` 都显示成"空闲"）。
 */
function healthLevelOf(h: HealthData | null): HealthLevel | null {
  const l = h?.report?.level;
  return l && l in HEALTH_LEVEL_LABEL ? l : null;
}
const TAB_ITEMS = [
  { key: 'overview' as const, label: '系统状态' },
  { key: 'events' as const, label: '事件时间线' },
  { key: 'stats' as const, label: '使用趋势' },
  { key: 'health' as const, label: '项目健康' },
  { key: 'diagnostics' as const, label: '架构诊断' },
  { key: 'logs' as const, label: '系统日志' },
];

export default function DashboardPage() {
  const navigate = useNavigate();
  // zx_20260906 批3 (3d): 项目大盘产出物 chip 配色（admin:overview projectOutcomes）；文案取共享词表
  const OUT_TYPE_CLS: Record<string, string> = { mcp: 'bg-blue-100 text-blue-700', a2a: 'bg-green-100 text-green-700', ui: 'bg-purple-100 text-purple-700', doc: 'bg-amber-100 text-amber-700', daemon: 'bg-orange-100 text-orange-700', code: 'bg-slate-100 text-slate-700' };
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'overview'|'events'|'stats'|'health'|'diagnostics'|'logs'>('overview');
  const [billing, setBilling] = useState<Array<{model_name?:string;model_id?:string;total_tokens_in:number;total_tokens_out:number;total_cost:number}>>([]);
  const [toolStats, setToolStats] = useState<Array<{tool_name:string;call_count:number;error_count:number}>>([]);
  const [projHealth, setProjHealth] = useState<Array<Record<string,unknown>>>([]);
  const [trends, setTrends] = useState<Array<{date:string;calls:number;tokens:number}>>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [logLevel, setLogLevel] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [overview, setOverview] = useState<{bottlenecks:Array<Record<string,unknown>>;recentTasks:Array<Record<string,unknown>>;resourceSummary:Array<Record<string,unknown>>;projectDeps:Array<Record<string,unknown>>;projectOutcomes:Array<Record<string,unknown>>}>({bottlenecks:[],recentTasks:[],resourceSummary:[],projectDeps:[],projectOutcomes:[]});
  // zx_20261016_3 批四（M34）：`proposals` 与另两本账同走唯一诊断出口（`admin.diagnostics`）。
  const [diagnostics, setDiagnostics] = useState<{invariants:Array<Record<string,unknown>>;failureClusters:Array<Record<string,unknown>>;simplification:SimplificationReport|null;selfHealing:HealingRecord[];proposals:SelfEvolveProposal[]}>({invariants:[],failureClusters:[],simplification:null,selfHealing:[],proposals:[]});
  // 内部取值 → 中文口径（low/medium/high 是库里的取值，不直接摆给用户看）
  const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
  const SEVERITY_CLS: Record<string, string> = { high: 'bg-red-100 text-red-700', medium: 'bg-amber-100 text-amber-700', low: 'bg-gray-100 text-gray-600' };
  // 架构不变量修复的瞬时反馈文案（成功后行转绿 + 此提示）
  const [diagMsg, setDiagMsg] = useState<string | null>(null);
  // A1 (2026-09-03_1): 调度/队列状态
  const [scheduler, setScheduler] = useState<{ counts: Record<string, number>; running: Array<Record<string, unknown>>; scheduled: Array<Record<string, unknown>>; recent: Array<Record<string, unknown>> }>({ counts: {}, running: [], scheduled: [], recent: [] });
  // A1 (2026-09-04_2): 运维看板保鲜度（无常标记；事件驱动自动刷新，此处仅上报刷新时刻）
  const [healthUpdatedAt, setHealthUpdatedAt] = useState<number | null>(null);
  const healthStale = useStaleness(healthUpdatedAt);
  // F1 (2026-09-04_2): 全局"此刻最需你介入"单条（抓主要矛盾·实时化）
  const [mainIssue, setMainIssue] = useState<{ taskId: string; title: string; kind: string; reason: string } | null>(null);
  const [mainIssueTotal, setMainIssueTotal] = useState(0);
  // zx_20261011_5: 模型可用性快照（首屏空态 banner 用）。与 loadAll 分开、**挂载即现探一次**
  //   （`force=true`）——不受 30s 轮询牵连，也覆盖 `setup:state` 为省往返而不探的格（有项目的老用户）。
  const [modelProbe, setModelProbe] = useState<ModelProbe | null>(null);

  const loadAll = useCallback(async () => {
    try { const [h, s] = await Promise.all([admin.health() as unknown as HealthData, admin.stats() as unknown as StatsData]); setHealth(h); setStats(s); } catch(e) { setError((e as Error).message); }
    try { const d = await invoke<EventItem[]>('admin:events'); setEvents((Array.isArray(d) ? d : []).slice(0, 50)); } catch {}
    try { const b = await ansProxy.get<Array<{model_name?:string;total_tokens_in:number;total_tokens_out:number;total_cost:number}>>('/api/v1/billing/usage?days=30'); setBilling(b as Array<{model_name?:string;total_tokens_in:number;total_tokens_out:number;total_cost:number}>||[]); } catch {}
    try { const ts = await invoke<{stats?:Array<{tool_name:string;call_count:number;error_count:number}>}>('admin:toolStats'); setToolStats((ts && ts.stats || []).slice(0, 10)); } catch {}
    if (tab === 'health') { try { const ph = await invoke<Array<Record<string,unknown>>>('admin:projectHealth'); setProjHealth(Array.isArray(ph) ? ph : []); } catch {} }
    if (tab === 'stats') { try { const tr = await ansProxy.get<Array<{date:string;total_tokens:number;cost:number;call_count:number}>>('/api/v1/billing/usage/daily?days=30'); setTrends(Array.isArray(tr) ? tr.map((x) => ({ date: x.date, calls: x.call_count ?? 0, tokens: x.total_tokens ?? 0 })) : []); } catch {} }
    if (tab === 'logs') { try { const lg = await invoke<string[]>('admin:logs', { lines: 200, level: logLevel || undefined }); setLogs(Array.isArray(lg) ? lg : []); } catch {} }
    // zx_20260924_1 M6（F7）: `simplification` / `selfHealing` 由 admin:diagnostics（唯一诊断出口）带出，
    //   类型已并入公共 ipc.ts 的 `admin.diagnostics()`（自 main 侧真源取，不再强转）。
    if (tab === 'diagnostics') { try {
      const dg = await admin.diagnostics();
      setDiagnostics({ invariants: dg.invariants || [], failureClusters: dg.failureClusters || [], simplification: dg.simplification ?? null, selfHealing: Array.isArray(dg.selfHealing) ? dg.selfHealing : [], proposals: Array.isArray(dg.proposals) ? dg.proposals : [] });
    } catch {} }
    try { const ov = await invoke<{bottlenecks:Array<Record<string,unknown>>;recentTasks:Array<Record<string,unknown>>;resourceSummary:Array<Record<string,unknown>>;projectDeps:Array<Record<string,unknown>>;projectOutcomes:Array<Record<string,unknown>>}>('admin:overview'); if (ov) setOverview({bottlenecks:ov.bottlenecks||[],recentTasks:ov.recentTasks||[],resourceSummary:ov.resourceSummary||[],projectDeps:ov.projectDeps||[],projectOutcomes:ov.projectOutcomes||[]}); } catch {}
    // A1 (2026-09-03_1): 调度/队列只读状态
    try { const st = await invoke<{ counts: Record<string, number>; running: Array<Record<string, unknown>>; scheduled: Array<Record<string, unknown>>; recent: Array<Record<string, unknown>> }>('scheduler:status'); if (st) setScheduler({ counts: st.counts || {}, running: st.running || [], scheduled: st.scheduled || [], recent: st.recent || [] }); } catch {}
    // F1: 全局主矛盾（事件驱动 loadAll 一并刷新，实时单条）
    try {
      const mi = await invoke<{ issue: { taskId: string; title: string; kind: string; reason: string } | null; total: number }>('tasks:mainIssue');
      setMainIssue(mi?.issue ?? null);
      setMainIssueTotal(mi?.total ?? 0);
    } catch {}
    setHealthUpdatedAt(Date.now());
  }, [tab]);

  const handleRepairInvariant = useCallback(async (name: string, guidance: string) => {
    if (!window.confirm(`修复「${name}」\n\n${guidance}\n\n确认执行？`)) return;
    try {
      const r = await admin.repairInvariant(name);
      setDiagMsg(`✓ ${r.detail}`);
      await loadAll();
    } catch (e) {
      setDiagMsg(`✗ 修复失败：${(e as Error).message}`);
    }
    window.setTimeout(() => setDiagMsg(null), 6000);
  }, [loadAll]);

  // zx_20261016_3 批四（M34）：自产提案的人工闸。**只有这一个入口**——引擎侧无任何自动应用路径。
  //   "未生效"必须如实显形：`decide` 返回错误时把原因摆出来（如红线拒、状态不符），不假装已办。
  const handleProposalDecide = useCallback(async (id: string, decision: ProposalDecision, label: string) => {
    if (!window.confirm(`${label}？\n\n该操作会留痕（可回滚），但不会删除记录。确认执行？`)) return;
    try {
      const r = await admin.selfEvolveDecide(id, decision);
      setDiagMsg(`✓ ${r.detail || `已${label}`}`);
      await loadAll();
    } catch (e) {
      setDiagMsg(`✗ 未生效：${(e as Error).message}`);
    }
    window.setTimeout(() => setDiagMsg(null), 6000);
  }, [loadAll]);

  useEffect(() => { loadAll(); }, [loadAll]);
  // zx_20261011_5: 挂载即现探一次模型可用性（`force`）——`modelAvailability` 永不抛，失败如实回 null。
  useEffect(() => { modelAvailability(true).then(setModelProbe).catch(() => setModelProbe(null)); }, []);
  useEffect(() => { if (tab === 'logs') { invoke<string[]>('admin:logs', { lines: 200, level: logLevel || undefined }).then(lg => setLogs(Array.isArray(lg) ? lg : [])).catch(() => {}); } }, [logLevel]);
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(loadAll, 30_000);
    return () => clearInterval(t);
  }, [autoRefresh, loadAll]);

  // zx_20260905 批6: 窗口恢复可见/聚焦时自动刷新——长挂起(最小化/切走/休眠)后回到看板数据立即追赶，不再以陈旧示人
  const lastFocusReload = useRef(0);
  useEffect(() => {
    const onVisible = () => {
      const now = Date.now();
      if (now - lastFocusReload.current < 8000) return;
      lastFocusReload.current = now;
      void loadAll();
    };
    window.addEventListener('focus', onVisible);
    const onVis = () => { if (document.visibilityState === 'visible') onVisible(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVis); };
  }, [loadAll]);

  // A1 事件驱动刷新：订阅全局实时事件，节流触发 loadAll（30s 轮询降为兜底）
  const { subscribe } = useActivity();
  const reloadTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    return subscribe((e) => {
      const t = e.type;
      if (t === 'task.step_streaming') return;
      // A2 (2026-09-04_2): channel.* 事件驱动 —— 已启用渠道数/IM 状态不再陈旧
      const relevant = t.startsWith('task.') || t.startsWith('project.') || t.startsWith('file.') || t.startsWith('channel.') || t === 'deliverable.registered' || t === 'deliverable.status_changed';
      if (!relevant) return;
      if (reloadTimer.current !== undefined) return;
      reloadTimer.current = window.setTimeout(() => { reloadTimer.current = undefined; loadAll(); }, 900);
    });
  }, [subscribe, loadAll]);
  useEffect(() => () => { if (reloadTimer.current !== undefined) window.clearTimeout(reloadTimer.current); }, []);

  // zx_20261013_1 批三: 首启导览——挂载时读一次标记，决定弹不弹。**判"该弹"的三件**：
  //   ① 未落库（`onboarding.tour_done`）；② 本次会话未软跳过；③ 页面上有可高亮的侧栏入口。
  //   读不动 ⇒ 不弹（宁可少打扰，也不因读库失败把浮层永久焊在屏幕上）。
  const [tour, setTour] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await invoke<string | null>('settings:get', TOUR_SETTING_KEY);
        if (!alive) return;
        setTour(shouldShowTour({ done: parseTourDone(raw), skipped: isOnboardingSkipped() }));
      } catch { /* 读不动：不弹，不打扰 */ }
    })();
    return () => { alive = false; };
  }, []);
  // 走完 → **落库**（一次性；下次进来不再弹）；跳过 → **只放行本次会话**（不落库，刷新仍如实引导）。
  const finishTour = useCallback(async () => {
    setTour(false);
    try { await invoke('settings:set', TOUR_SETTING_KEY, '1'); } catch { /* 落库失败：本次已关，下次仍提示——如实，不假装记住 */ }
  }, []);
  const skipTour = useCallback(() => { skipOnboarding(); setTour(false); }, []);

  // D1 (2026-09-04_2 整改): 长任务心跳——执行中任务带。
  // 注意：task.heartbeat 属高频瞬态，ActivityProvider.dispatch 对瞬态事件不入缓冲也不通知
  // useActivity.subscribe 订阅者（activity.tsx STREAMING 早退），因此这里必须直连
  // window.electronAPI.onTaskEvent 订阅（与 TaskDetail/Tasks 同源），否则心跳带永远收不到事件。
  const [heartbeats, setHeartbeats] = useState<Record<string, { title: string; tokens: number; elapsedSec: number; ts: number }>>({});
  useEffect(() => {
    if (!window.electronAPI?.onTaskEvent) return;
    return window.electronAPI.onTaskEvent((event) => {
      const id = event.taskId ?? event.task_id;
      if (!id) return;
      if (event.type === 'task.heartbeat') {
        setHeartbeats((p) => ({ ...p, [id]: { title: event.title || '', tokens: Number(event.tokens) || 0, elapsedSec: Number(event.heartbeatElapsedSec) || 0, ts: Date.now() } }));
      } else {
        const ns = String(event.newStatus ?? event.new_status ?? '');
        const terminal = event.type === 'task.completed' || event.type === 'task.failed' || (event.type === 'task.status_changed' && ['completed', 'failed', 'archived'].includes(ns));
        if (terminal) setHeartbeats((p) => { if (!p[id]) return p; const q = { ...p }; delete q[id]; return q; });
      }
    });
  }, []);

  const formatUptime = (s: number) => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };
  const formatToken = (n?: number) => n?n>=1000?(n/1000).toFixed(0)+'K':String(n):'0';
  // zx_20260906_2 批4 (2026-09-06): 承接 4f——终核修正(2026-09-06)：heartbeat.tokens 与 admin:stats.totalTokens 同源于 wa_task_conversations.token_count(SUM)，
  // 叠加会双计且长单步期间 DB 无新对话行则其值本不变 → 不加"实时 token 增量"；改为执行中任务「心跳在线」副行(计数+最长时长，随 heartbeat 每~20s 跳动)诚实表达推进、不虚增账
  const liveRunCount = Object.keys(heartbeats).length;
  const liveMaxSec = Object.values(heartbeats).reduce((a, h) => Math.max(a, Number(h.elapsedSec) || 0), 0);
  const eventIcon = (t: string) => t.includes('completed')?<CheckCircle className="w-4 h-4 text-green-500"/>:t.includes('failed')?<XCircle className="w-4 h-4 text-red-500"/>:t.includes('warning')?<AlertTriangle className="w-4 h-4 text-yellow-500"/>:<Clock className="w-4 h-4 text-blue-400"/>;
  // zx_20261011_5: 模型未就绪的诚实说明（文案真源与向导②同一句）。
  const modelsLine = modelProbe ? probeModelsLine(modelProbe) : null;

  return (
    <div>
      {/* zx_20261013_1 批三: 首启**一次性**导览浮层（非阻塞、可跳过）——只在 Dashboard 首访弹一次。 */}
      {tour && <TourOverlay onDone={finishTour} onSkip={skipTour} />}
      <div className="flex items-center justify-between mb-6"><h2 className="text-xl font-bold">运维看板</h2><div className="flex items-center gap-2">
        <FreshnessPill q={{ loading: healthUpdatedAt == null, data: null, error: null, updatedAt: healthUpdatedAt, stale: healthStale, isLive: !healthStale && healthUpdatedAt != null, reload: loadAll as () => Promise<void> }} />
        <button onClick={()=>setAutoRefresh(!autoRefresh)} className={`text-xs px-2 py-1 rounded ${autoRefresh?'bg-green-100 text-green-700':'bg-gray-100 text-gray-500'}`}>{autoRefresh?'⏱ 30s自动刷新':'手动刷新'}</button><button onClick={loadAll} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4"/></button></div></div>
      {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

      {/* F1 (2026-09-04_2): 全局此刻最需你介入（矛盾论·抓主要矛盾实时化） */}
      {mainIssue && (
        <div className={`mb-4 rounded-lg border px-4 py-3 flex items-center gap-3 ${mainIssue.kind === 'await' ? 'bg-amber-50 border-amber-200' : mainIssue.kind === 'failed' ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'}`}>
          <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" /><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" /></span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-800 truncate">⚠ 此刻最需你介入：{mainIssue.title}</p>
            <p className="text-xs text-gray-600">{mainIssue.reason}{mainIssueTotal > 1 ? `（另有 ${mainIssueTotal - 1} 项次要待处理）` : ''}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {mainIssue.kind === 'failed' && <button type="button" onClick={async () => { try { await invoke('task:resume', { id: mainIssue.taskId }); setError(''); } catch (e) { setError(`恢复失败：${(e as Error).message}`); } await loadAll(); }} className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700">恢复</button>}
            <button type="button" onClick={() => navigate(`/tasks/${mainIssue.taskId}`)} className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700">前往处理</button>
          </div>
        </div>
      )}

      {/* zx_20261011_5「名正而后事成」: 模型未就绪的**诚实空态**——首启判据补了模型前提，但用户若
          "软跳过向导"或"有项目但模型被删"仍会落到空白 Dashboard。此处如实分因（401/读失败/0 目录/缺 chat），
          并给出**走得通**的动作（去模型页配置）——不把"读不动"混成"没配"，也不静默留白。 */}
      {modelsLine && !modelsLine.ok && (
        <div className="mb-4 rounded-lg border px-4 py-3 flex items-center gap-3 bg-amber-50 border-amber-200">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-800">⚠ 模型未就绪——任务可能跑不出成果</p>
            <p className="text-xs text-gray-600">{modelsLine.text}</p>
          </div>
          {modelProbe?.read === 'ok' && (
            <button type="button" onClick={() => navigate('/models')} className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 shrink-0">去配置模型</button>
          )}
        </div>
      )}

      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          {label:'项目数',value:health?.projects??'—',color:'bg-green-50 text-green-700'},
          {label:'总任务',value:health?.tasks??'—',color:'bg-blue-50 text-blue-700'},
          {label:'活跃任务',value:health?.runningTasks??'—',color:'bg-yellow-50 text-yellow-700',animate:!!health?.runningTasks},
          { label:'Token消耗', value:formatToken(stats?.totalTokens), color:'bg-purple-50 text-purple-700',
            sub: liveRunCount > 0 ? `⏳ 执行中 ${liveRunCount} 项 · 最长 ${liveMaxSec >= 60 ? `${Math.floor(liveMaxSec / 60)}m${liveMaxSec % 60}s` : `${liveMaxSec}s`} 心跳在线` : undefined,
            animate: liveRunCount > 0 }
        ].map(({label,value,color,animate,sub})=>(
          <div key={label} className={`${color} rounded-lg p-4`}><p className="text-sm opacity-75">{label}</p><p className={`text-2xl font-bold mt-1 ${animate?'animate-pulse':''}`}>{value}</p>{sub ? <p className="text-[11px] opacity-80 mt-1 truncate" title="长单步期间由 task.heartbeat(每~20s)驱动跳动——已入账总额不重复叠加心跳 token(同源于对话 token_count)">{sub}</p> : null}</div>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[{label:'已启用渠道',value:health?.enabledChannels??'—'},{label:'系统记忆',value:stats?.totalMemories??'—'},{label:'产出物',value:stats?.totalDeliverables??'—'},{label:'运行时间',value:health?formatUptime(health.uptime):'—'}].map(({label,value})=>(
          <div key={label} className="bg-white rounded-lg border p-4"><p className="text-xs text-gray-400">{label}</p><p className="text-xl font-bold mt-1">{value}</p></div>
        ))}
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {TAB_ITEMS.map(item => (
          <button key={item.key} onClick={() => setTab(item.key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium ${tab === item.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div className="space-y-4">
          {/* D1 (2026-09-04_2): 长任务心跳——离开详情页仍"知天下"（克制陪伴） */}
          {Object.keys(heartbeats).length > 0 && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-2 text-sm flex items-center gap-1"><Server className="w-4 h-4 text-blue-500"/>执行中任务（长任务心跳 · 仍在推进）</h3>
              <div className="space-y-1">
                {Object.entries(heartbeats).map(([tid, h]) => (
                  <button key={tid} type="button" onClick={() => navigate(`/tasks/${tid}`)} className="w-full flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-blue-50 hover:bg-blue-100 text-left">
                    <span className="relative flex h-2 w-2 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" /></span>
                    <span className="flex-1 min-w-0 truncate text-gray-700">{h.title || tid.slice(0, 8)}</span>
                    <span className="shrink-0 text-blue-600 font-medium">{h.tokens >= 1000 ? (h.tokens / 1000).toFixed(1) + 'K' : String(h.tokens)} tokens</span>
                    <span className="shrink-0 text-gray-400">{h.elapsedSec >= 60 ? `${Math.floor(h.elapsedSec / 60)}m${h.elapsedSec % 60}s` : `${h.elapsedSec}s`}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="bg-white rounded-lg border p-6">
            <h3 className="font-semibold mb-4 flex items-center gap-2"><Activity className="w-4 h-4"/>系统状态</h3>
            <div className="space-y-2 text-sm">
              {/* zx_20260930 M14-4: 三态词取自真源（`HEALTH_LEVEL_LABEL`）——改前按 `status==='healthy'` 二分，
                  新词表下 `ok` 与 `unavailable` 会同时落到"空闲"这一支（**名实不符**）。 */}
              <div className="flex justify-between py-2 border-b"><span className="text-gray-500">整体状态</span>{(() => {
                const lvl = healthLevelOf(health);
                return lvl ? <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${HEALTH_LEVEL_CLASS[lvl]}`}>{HEALTH_LEVEL_LABEL[lvl]}</span> : <span className="text-gray-400">—</span>;
              })()}</div>
              <div className="flex justify-between py-2 border-b"><span className="text-gray-500">架构模式</span><span className="text-blue-600 font-medium">单进程 Electron + IPC</span></div>
              <div className="flex justify-between py-2 border-b"><span className="text-gray-500">数据库引擎</span><span>better-sqlite3 (WAL)</span></div>
              <div className="flex justify-between py-2 border-b"><span className="text-gray-500">运行时间</span><span>{health?formatUptime(health.uptime):'—'}</span></div>
              <div className="flex justify-between py-2"><span className="text-gray-500">IPC 状态</span><span className="text-green-600 font-medium">连接正常</span></div>
            </div>
          </div>

          {/* A1 (2026-09-03_1): 调度/队列只读状态 */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Server className="w-4 h-4 text-indigo-500"/>调度/队列</h3>
            <div className="grid grid-cols-4 gap-3 mb-3">
              {[{ k: 'running', c: scheduler.counts.running || 0, cls: 'text-blue-600' }, { k: 'pending', c: scheduler.counts.pending || 0, cls: 'text-amber-600' }, { k: 'done', c: scheduler.counts.done || 0, cls: 'text-green-600' }, { k: 'failed', c: scheduler.counts.failed || 0, cls: 'text-red-600' }].map(x => (
                <div key={x.k} className="p-2 bg-gray-50 rounded text-center"><p className={`text-xl font-bold ${x.cls}`}>{x.c}</p><p className="text-[10px] text-gray-400">{JOB_STATUS_LABEL[x.k] ?? x.k}</p></div>
              ))}
            </div>
            {scheduler.recent.length > 0 && (
              <div className="space-y-1">
                {scheduler.recent.map((j, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-xs py-1 px-2 rounded bg-gray-50">
                    <span className="font-mono text-gray-600 truncate min-w-0" title={String(j.type)}>{String(j.type)}</span>
                    <span className={`shrink-0 ${j.status === 'failed' ? 'text-red-600' : j.status === 'running' ? 'text-blue-600' : j.status === 'pending' ? 'text-amber-600' : 'text-gray-400'}`}>{String(j.status)}</span>
                    {j.status === 'failed' && j.error ? <span className="shrink-0 text-red-400 truncate max-w-[40%]" title={String(j.error)}>{String(j.error).slice(0, 40)}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* zx_20260906 批3 (3d): 项目成果·方案里程碑·质量聚合（量变质变/矛盾论——大盘当给主要成果与质量；随 deliverable/task 事件刷新） */}
          {overview.projectOutcomes.length > 0 && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><FileText className="w-4 h-4 text-teal-500"/>项目成果 · 方案里程碑 · 质量（每活跃项目）</h3>
              <div className="space-y-3">
                {overview.projectOutcomes.map((po: Record<string, unknown>, i: number) => {
                  const q = (po.quality as { count?: number; avg?: number | null; low?: number }) || {};
                  const recs = (po.recentDeliverables as Array<Record<string, unknown>>) || [];
                  const hasM = !!po.milestoneLine;
                  if (!hasM && recs.length === 0 && !(q.count || 0)) return null;
                  return (
                    <button key={i} type="button" onClick={() => navigate(`/projects/${String(po.projectId)}`)} className="w-full text-left p-3 rounded-lg border border-gray-100 hover:border-teal-300 hover:bg-teal-50/30 transition-colors">
                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                        <span className="font-medium text-sm text-gray-800">{String(po.projectName)}</span>
                        {q.avg != null && <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${q.avg >= 80 ? 'bg-green-100 text-green-700' : q.avg >= 60 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>平均质量 {q.avg}</span>}
                        {(q.count || 0) > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">评定 {q.count} 项{q.low ? ` · 低质 ${q.low}` : ''}</span>}
                        <span className="ml-auto text-xs text-gray-300 hover:text-teal-500">进入项目 →</span>
                      </div>
                      {/* zx_20260906_1 3e: 大盘 M 里程碑结构化——含 impl 可点进落地任务（量变质变；原纯文本 milestoneLine 为兜底） */}
                      {(((po.milestoneList as Array<Record<string, unknown>>) || []).length > 0) ? (
                        <div className="flex items-center gap-1 flex-wrap mb-1.5">
                          {((po.milestoneList as Array<Record<string, unknown>>) || []).map((m: Record<string, unknown>) => {
                            const st = String(m.st || '');
                            const target = m.impl ? String(m.impl) : (m.plan_id ? String(m.plan_id) : '');
                            return (
                              <span key={String(m.ms)} role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); if (target) navigate(`/tasks/${target}`); }}
                                className={`text-[10px] px-1.5 py-0.5 rounded font-mono cursor-pointer hover:ring-1 hover:ring-blue-400 ${st === 'done' ? 'bg-green-100 text-green-700' : st === 'doing' ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-300' : 'bg-gray-100 text-gray-500'}`}
                                title={`${String(m.ms)} · ${st === 'done' ? '已落地' : st === 'doing' ? '进行中' : '待实施'}${target ? ' · 点击打开任务' : ''}`}>
                                {String(m.ms)}{st === 'done' ? '✓' : st === 'doing' ? '●' : '○'}
                              </span>
                            );
                          })}
                        </div>
                      ) : hasM ? <p className="text-xs text-indigo-600 bg-indigo-50 rounded px-2 py-1 mb-1.5">{String(po.milestoneLine)}</p> : null}
                      {recs.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {recs.map((r: Record<string, unknown>, j: number) => (
                            <span key={j} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${OUT_TYPE_CLS[String(r.type)] || 'bg-gray-100 text-gray-600'}`} title={`${String(r.name)} · ${String(r.status)}`}>
                              {DELIVERABLE_TYPE_LABEL[String(r.type)] || String(r.type)} · {String(r.name).slice(0, 24)}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 瓶颈告警 */}
          {overview.bottlenecks.length > 0 && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-red-500"/>瓶颈告警 ({overview.bottlenecks.length})</h3>
              <div className="space-y-2">
                {overview.bottlenecks.map((b:Record<string,unknown>,i:number) => (
                  <div key={i} className="flex items-center justify-between text-sm p-2 bg-red-50 rounded">
                    <span className="font-medium text-red-800">{b.projectName as string}</span>
                    <span className="text-xs text-red-600">失败任务: {b.failedTasks as number} | 卡住: {b.stuckTasks as number}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 资源使用热图 */}
          {overview.resourceSummary.length > 0 && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-blue-500"/>项目资源使用</h3>
              <div className="space-y-2">
                {overview.resourceSummary.map((r:Record<string,unknown>,i:number) => {
                  const tokens = (r.totalTokens as number) || 0;
                  const maxTokens = Math.max(...overview.resourceSummary.map((x:Record<string,unknown>)=>x.totalTokens as number||0), 1);
                  const pct = maxTokens > 0 ? (tokens / maxTokens * 100) : 0;
                  return (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-28 text-xs text-gray-500 truncate">{r.projectName as string}</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-4">
                        <div className="bg-blue-500 rounded-full h-4" style={{width:`${pct}%`}}/>
                      </div>
                      <span className="w-24 text-right text-xs text-gray-500">{tokens>=1000?(tokens/1000).toFixed(0)+'K':String(tokens)} tokens | {r.taskCount as number}任务</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 最近任务 */}
          {overview.recentTasks.length > 0 && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><CheckCircle className="w-4 h-4 text-green-500"/>最近任务 ({overview.recentTasks.length})</h3>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {overview.recentTasks.slice(0, 15).map((t:Record<string,unknown>,i:number) => (
                  <div key={i} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                    <span className="truncate flex-1 text-xs">{t.title as string}</span>
                    <span className="text-xs text-gray-400 mx-2">{t.project_name as string}</span>
                    <span className={`text-xs px-1 py-0.5 rounded ${t.status==='completed'?'bg-green-100 text-green-700':t.status==='failed'?'bg-red-100 text-red-600':'bg-gray-100'}`}>{t.status as string}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 任务依赖 DAG */}
          {overview.projectDeps.some((p: Record<string, unknown>) => ((p.tasks as Array<Record<string, unknown>>) || []).some((t: Record<string, unknown>) => t.depends_on || t.parent_task_id)) && (
            <div className="bg-white rounded-lg border p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><GitBranch className="w-4 h-4 text-purple-500"/>任务依赖 DAG</h3>
              <div className="space-y-3">
                {overview.projectDeps.map((p: Record<string, unknown>, i: number) => {
                  const tasks = (p.tasks as Array<Record<string, unknown>>) || [];
                  const deps = tasks.filter((t: Record<string, unknown>) => t.depends_on || t.parent_task_id);
                  if (deps.length === 0) return null;
                  return (
                    <div key={i} className="p-3 bg-gray-50 rounded">
                      <p className="text-xs font-medium text-gray-600 mb-2">{p.projectName as string}</p>
                      <div className="space-y-1">
                        {deps.map((t: Record<string, unknown>, j: number) => (
                          <div key={j} className="flex items-center gap-2 text-xs">
                            <span className="text-gray-500 font-mono w-16 truncate">{String(t.depends_on || t.parent_task_id || '').slice(0, 8)}</span>
                            <span className="text-gray-300">→</span>
                            <span className="truncate flex-1">{t.title as string}</span>
                            <span className={`px-1.5 py-0.5 rounded ${t.status === 'paused' ? 'bg-orange-100 text-orange-600' : 'bg-blue-100 text-blue-600'}`}>{t.status as string}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : tab==='health' ? (
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Heart className="w-4 h-4"/>项目健康报告</h3>
          {projHealth.length===0?<p className="text-gray-400 text-center py-8">暂无数据</p>:(
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-gray-400"><th className="py-2">项目</th><th className="py-2">状态</th><th className="py-2">活跃度</th><th className="py-2">任务</th><th className="py-2">健康分</th></tr></thead>
              <tbody>{projHealth.map((p: Record<string,unknown>,i:number)=>(<tr key={i} className="border-b last:border-0"><td className="py-2 font-medium">{p.name as string}</td><td className="py-2"><span className={`text-xs px-1.5 py-0.5 rounded-full ${p.status==='active'?'bg-green-100 text-green-700':'bg-gray-100'}`}>{p.status as string}</span></td><td className="py-2 text-xs">{p.stale as string}</td><td className="py-2 text-xs">{p.taskCompleted as number}/{p.taskTotal as number} (失败:{p.taskFailed as number})</td><td className="py-2"><div className="flex items-center gap-2"><div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden"><div className={`h-full rounded-full ${(p.healthScore as number)>=80?'bg-green-500':(p.healthScore as number)>=50?'bg-yellow-500':'bg-red-500'}`} style={{width:`${p.healthScore}%`}}/></div><span className="text-xs">{(p.healthScore as number)}分</span></div></td></tr>))}</tbody>
            </table>
          )}
        </div>
      ) : tab==='stats' ? (
        <div className="space-y-4">
          {/* 使用趋势 */}
          {trends.length>0 && <div className="bg-white rounded-lg border p-4"><h3 className="font-semibold mb-3 flex items-center gap-2"><TrendingUp className="w-4 h-4"/>Token 使用趋势 (近30天·自然日·ANS记账)</h3><div className="flex gap-0.5 h-32">{trends.map((t,i)=>{const maxT=Math.max(...trends.map(x=>x.tokens));const barPx=maxT>0?(t.tokens>0?Math.max(2,Math.round(t.tokens/maxT*112)):0):0;return <div key={i} className="flex-1 h-full min-w-0 flex flex-col justify-end items-center" title={`${t.date}: ${formatToken(t.tokens)}`}><div className={`w-full rounded-t transition-colors ${barPx>0?'bg-blue-400 hover:bg-blue-600':''}`} style={{height:`${barPx}px`}}/><span className="text-[8px] text-gray-400 leading-4 whitespace-nowrap overflow-hidden w-full text-center hidden sm:block">{t.date.slice(5)}</span></div>;})}</div></div>}
          {/* Token 消耗按模型 */}
          {billing.length>0 && <div className="bg-white rounded-lg border p-4"><h3 className="font-semibold mb-3 flex items-center gap-2"><BarChart3 className="w-4 h-4"/>Token 消耗 (按模型·近30×24h·ANS记账)</h3><div className="space-y-2">{billing.slice(0,8).map((b,i)=>{const total=b.total_tokens_in+b.total_tokens_out;const max=Math.max(...billing.map(x=>x.total_tokens_in+x.total_tokens_out));return(<div key={i} className="flex items-center gap-2 text-sm"><span className="w-32 text-xs text-gray-500 truncate">{b.model_name||b.model_id?.slice(0,20)||'unknown'}</span><div className="flex-1 bg-gray-100 rounded-full h-4"><div className="bg-blue-500 rounded-full h-4" style={{width:`${max>0?(total/max*100):0}%`}}/></div><span className="w-20 text-right text-xs text-gray-500">{total>=1000?(total/1000).toFixed(1)+'K':String(total)}</span></div>);})}</div></div>}
          {/* 工具调用统计 */}
          {toolStats.length>0 && <div className="bg-white rounded-lg border p-4"><h3 className="font-semibold mb-3 flex items-center gap-2"><Wrench className="w-4 h-4"/>工具调用 (Top 10)</h3><div className="space-y-2">{toolStats.map((t,i)=>{const total=t.call_count+t.error_count;const max=Math.max(...toolStats.map(x=>x.call_count+x.error_count));const errRate=total>0?(t.error_count/total*100):0;return(<div key={i} className="flex items-center gap-2 text-sm"><span className="w-36 text-xs text-gray-500 truncate">{t.tool_name}</span><div className="flex-1 bg-gray-100 rounded-full h-4"><div className={`rounded-full h-4 ${errRate>20?'bg-red-500':errRate>5?'bg-yellow-500':'bg-green-500'}`} style={{width:`${max>0?(total/max*100):0}%`}}/></div><span className="w-24 text-right text-xs text-gray-500">{total}次{errRate>0?` (${errRate.toFixed(0)}%错)`:''}</span></div>);})}</div></div>}
        </div>
      ) : tab==='diagnostics' ? (
        <div className="space-y-4">
          {/* zx_20260930 M14-4：**真健康自检结果上屏**——五面各给三态与一句**依据**。
              此前 `admin:health` 只被用来显示"整体状态"一个词，`report` 里的五面依据全丢；
              于是"哪一面降级了、凭什么这么判"在界面上一概看不见（只能看日志）。 */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-blue-500"/>系统健康自检
              {(() => { const lvl = healthLevelOf(health); return lvl ? <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${HEALTH_LEVEL_CLASS[lvl]}`}>{HEALTH_LEVEL_LABEL[lvl]}</span> : null; })()}
              {health?.report ? <span className="ml-auto text-[10px] font-normal text-gray-400">检查时刻(UTC)：{(health.report.checkedAt || '').slice(0, 19)}</span> : null}
            </h3>
            {!health?.report || health.report.items.length === 0 ? (
              // 空态如实：既可能"后端未返回 report"（未升级/异常），也可能"本次尚未检查"——不伪造一个"正常"
              <p className="text-gray-400 text-center py-4">暂无健康自检结果（未返回 report，或本次尚未检查）</p>
            ) : (
              <div className="space-y-1">
                {health.report.items.map((it) => (
                  <div key={it.key} className="flex items-start gap-2 text-sm py-1 border-b last:border-0">
                    <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${HEALTH_LEVEL_CLASS[it.level]}`}>{HEALTH_LEVEL_LABEL[it.level]}</span>
                    <span className="shrink-0 w-24 text-gray-500">{it.label}</span>
                    <span className="flex-1 text-xs text-gray-600 break-all">{it.evidence}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-blue-500"/>架构不变量自检 ({diagnostics.invariants.length})</h3>
            {diagMsg ? <div className="mb-2 px-2 py-1 rounded text-xs bg-blue-50 text-blue-700">{diagMsg}</div> : null}
            {diagnostics.invariants.length === 0 ? <p className="text-gray-400 text-center py-6">暂无诊断数据</p> : (
              <div className="space-y-2">
                {diagnostics.invariants.map((inv: Record<string,unknown>, i:number) => (
                  <div key={i} className={`flex items-start gap-2 p-2 rounded border ${inv.passed ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
                    <span className="mt-0.5">{inv.passed ? <CheckCircle className="w-4 h-4 text-green-500"/> : <AlertTriangle className="w-4 h-4 text-red-500"/>}</span>
                    <div className="flex-1 text-sm">
                      <span className="font-medium">{inv.name as string}</span>
                      <span className="text-xs text-gray-500 ml-2">{inv.description as string}</span>
                      {!inv.passed && (inv.violations as Array<{detail:string}>|undefined)?.length ? (
                        <div className="text-xs text-red-600 mt-1">{(inv.violations as Array<{detail:string}>).map((v: {detail:string}) => v.detail).join('; ')}</div>
                      ) : null}
                      {!inv.passed && (inv.remediation as Record<string,unknown>|undefined) ? (
                        <div className="text-xs text-gray-600 mt-1">💡 {String((inv.remediation as Record<string,unknown>).guidance ?? '')}</div>
                      ) : null}
                    </div>
                    {!inv.passed && (inv.remediation as Record<string,unknown>|undefined)?.autoFixable ? (
                      <button
                        type="button"
                        className="shrink-0 text-xs px-2 py-1 rounded border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 whitespace-nowrap"
                        onClick={() => handleRepairInvariant(inv.name as string, String((inv.remediation as Record<string,unknown>).guidance ?? ''))}
                      >修复</button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><XCircle className="w-4 h-4 text-red-500"/>失败聚类 (近14天)</h3>
            {diagnostics.failureClusters.length === 0 ? <p className="text-gray-400 text-center py-4">暂无失败记录</p> : (
              <div className="space-y-1">{diagnostics.failureClusters.map((f: Record<string,unknown>, i:number) => (
                <div key={i} className="flex justify-between text-sm py-1 border-b last:border-0"><span className="font-mono text-xs">{f.toolName as string}</span><span className="text-xs text-red-600">{f.failCount as number} 次</span></div>
              ))}</div>
            )}
          </div>
          {/* zx_20260924_1 M6（F7）：架构简化审查报表——此前只写进 wa_simplification_reports，界面看不到 */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Wrench className="w-4 h-4 text-gray-500"/>架构简化审查 (最近一次)</h3>
            {!diagnostics.simplification ? (
              // 空态须如实：无报告既可能是"没跑过"，也可能是"跑过但本次无发现"（无发现项时不写行）
              <p className="text-gray-400 text-center py-4">暂无审查报告（未跑过审查，或最近一次审查未发现问题）</p>
            ) : (() => {
              const rep = diagnostics.simplification;
              const findings = rep.findings || [];
              const counts = rep.severity_counts;
              return (<>
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-2">
                  {/* 时间为 DB 口径（UTC）——不标基准会让 20:01 生成的一份报表显示成 12:01（本仓踩过的坑） */}
                  <span>报告时间(UTC)：{rep.created_at ? rep.created_at.slice(0, 19) : '未知'}</span>
                  <span>共 {findings.length} 项</span>
                  {(['high','medium','low'] as const).map(k => (
                    <span key={k} className={`px-1.5 py-0.5 rounded ${SEVERITY_CLS[k]}`}>{SEVERITY_LABEL[k]} {counts ? (counts[k] ?? 0) : '—'}</span>
                  ))}
                </div>
                {rep.parse_error ? <p className="text-xs text-red-600 mb-2">报告解析失败：{rep.parse_error}</p> : null}
                {findings.length === 0 ? <p className="text-gray-400 text-center py-4">本次审查无发现项</p> : (
                  <div className="space-y-2">{findings.map((f, i) => (
                    <div key={i} className="p-2 rounded border bg-gray-50">
                      <div className="flex items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded ${SEVERITY_CLS[f.severity || 'low'] || SEVERITY_CLS.low}`}>{SEVERITY_LABEL[f.severity || 'low'] || '低'}</span>
                        <span className="text-gray-500 truncate">{f.location}</span>
                      </div>
                      <p className="text-sm mt-1">{f.description}</p>
                      {f.suggestion ? <p className="text-xs text-gray-500 mt-0.5">建议：{f.suggestion}</p> : null}
                    </div>
                  ))}</div>
                )}
              </>);
            })()}
          </div>
          {/* zx_20260924_1 M6（F7）：自愈日志——此前只作 24h 熔断计数，没有任何读取面 */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Heart className="w-4 h-4 text-orange-500"/>最近自愈记录 ({diagnostics.selfHealing.length})<span className="ml-auto text-[10px] font-normal text-gray-400">时间为 UTC</span></h3>
            {diagnostics.selfHealing.length === 0 ? <p className="text-gray-400 text-center py-4">暂无自愈记录</p> : (
              <div className="space-y-1">{diagnostics.selfHealing.map((h, i) => {
                // zx_20260930 M14-1: 五态（存量行的 `outcome` 为 NULL ⇒ `healOutcomeOf` 按 `success` 如实回退）
                const o = healOutcomeOf(h);
                return (
                  <div key={i} className="flex items-center gap-2 text-sm py-1 border-b last:border-0">
                    <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${HEAL_OUTCOME_CLASS[o]}`} title={o}>{HEAL_OUTCOME_LABEL[o]}</span>
                    <span className="truncate flex-1" title={h.anomaly}>{h.anomaly}</span>
                    <span className="shrink-0 text-xs text-gray-500">{h.action}</span>
                    <span className="shrink-0 text-xs text-gray-400 font-mono">{h.created_at ? h.created_at.slice(0, 19) : ''}</span>
                  </div>
                );
              })}</div>
            )}
          </div>
          {/* zx_20261016_3 批四（M34）：**自产提案**——自愈熔断产出的"改引擎行为"之物在此等人工裁决。
              红线：目标落在源码树（apps/ packages/ scripts/ .github/）**一律不落账、也批不动**；
              生效过的可**回滚**（旧值存于 rollback_point），且回滚只改状态、不删记录。 */}
          <div className="bg-white rounded-lg border p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><GitBranch className="w-4 h-4 text-purple-500"/>自产提案 ({diagnostics.proposals.length})<span className="ml-auto text-[10px] font-normal text-gray-400">须人工批准才生效 · 时间为 UTC</span></h3>
            {diagnostics.proposals.length === 0 ? <p className="text-gray-400 text-center py-4">暂无提案（自愈熔断反复命中时才会产生）</p> : (
              <div className="space-y-1">{diagnostics.proposals.map((p) => {
                const st = proposalStatusMeta(p.status);
                return (
                  <div key={p.id} className="flex items-center gap-2 text-sm py-1.5 border-b last:border-0">
                    <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${st.cls}`} title={p.status}>{st.label}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate" title={p.note || p.target}>{p.note || p.target}</div>
                      <div className="text-[11px] text-gray-400 font-mono truncate" title={p.target}>{p.kind} · {p.target}</div>
                      {p.apply_result && <div className="text-[11px] text-gray-500 truncate" title={p.apply_result}>{p.apply_result}</div>}
                    </div>
                    <span className="shrink-0 text-xs text-gray-400 font-mono">{p.created_at ? p.created_at.slice(0, 19) : ''}</span>
                    <div className="shrink-0 flex gap-1">
                      {p.status === 'pending' && (<>
                        <button onClick={() => handleProposalDecide(p.id, 'approve', '批准')} className="text-xs px-2 py-0.5 rounded border border-green-300 text-green-700 hover:bg-green-50">批准</button>
                        <button onClick={() => handleProposalDecide(p.id, 'reject', '拒绝')} className="text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">拒绝</button>
                      </>)}
                      {p.status === 'applied' && (
                        <button onClick={() => handleProposalDecide(p.id, 'rollback', '回滚')} className="text-xs px-2 py-0.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50">回滚</button>
                      )}
                    </div>
                  </div>
                );
              })}</div>
            )}
          </div>
        </div>
      ) : tab==='logs' ? (
        <div className="bg-white rounded-lg border p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2"><FileText className="w-4 h-4"/>系统日志</h3>
            <select value={logLevel} onChange={e => setLogLevel(e.target.value)} className="px-2 py-1 border rounded text-xs bg-white">
              <option value="">全部级别</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </div>
          {logs.length===0?<p className="text-gray-400 text-center py-8">暂无日志</p>:(
            <div className="max-h-[60vh] overflow-y-auto font-mono text-xs space-y-0.5">
              {logs.map((line, i) => {
                const isError = line.includes('"level":"error"') || line.includes('"level":50');
                const isWarn = line.includes('"level":"warn"') || line.includes('"level":40');
                return <div key={i} className={`py-0.5 px-2 rounded ${isError?'bg-red-50 text-red-700':isWarn?'bg-yellow-50 text-yellow-700':'text-gray-600'}`}>{line.slice(0, 300)}</div>;
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><BarChart3 className="w-4 h-4"/>事件时间线<span className="ml-auto text-[10px] font-normal text-gray-400">时间为 UTC</span></h3>
          {events.length===0?<p className="text-gray-400 text-center py-8">暂无事件（执行任务操作后将自动记录事件）</p>:<div className="space-y-1">{events.map((e,i)=>(<div key={i} className="flex items-start gap-3 py-2 border-b last:border-0 text-sm"><div className="mt-0.5">{eventIcon(e.event_type)}</div><div className="flex-1 min-w-0"><div className="flex items-center gap-2"><span className="font-medium text-xs text-blue-600">{e.event_type}</span><span className="text-xs text-gray-400">{e.aggregate_type}</span></div><p className="text-xs text-gray-500 font-mono mt-0.5">{e.occurred_at?.slice(0,19)}</p></div></div>))}</div>}
        </div>
      )}
    </div>
  );
}
