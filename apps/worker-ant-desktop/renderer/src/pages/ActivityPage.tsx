import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { History, RefreshCw, ChevronDown, ChevronRight, X, CheckCircle2, XCircle, MessageSquareText, Square } from 'lucide-react';
import { invoke } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { parseDbTime } from '../lib/deliverable-view';

interface FeedItem {
  event_type: string;
  label: string;
  level: 'error' | 'warn' | 'info';
  aggregate_type: string;
  aggregate_id: string;
  object_name: string;
  occurred_at: string;
  text: string;
  payload: string;
}

/** zx_20261029_3 M3：「后台进程」面板——形状与 main 侧 `core/background-jobs.ts` 的
 *  `BackgroundJobView` / `OrphanServiceChain` 同形（此处只镜像字段，状态词表见下）。 */
interface BackgroundJobView {
  id: string;
  project_id: string;
  task_id: string;
  tool: string;
  command: string;
  cwd: string;
  pgid: number | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  status: 'running' | 'leftover' | 'exited' | 'stopped' | 'unsupported';
  leftover_probe_at: string | null;
  stopped_at: string | null;
  stop_signal: string | null;
  group_attributable: boolean;
}
interface OrphanServiceChainView { pid: number; pgid: number; started_at: string; command: string; reason: string }
interface StopPayload { ok: boolean; status: string; message: string; signal?: string }

/** 五态说人话：`leftover` 是**命令已返回、进程组仍在**那种（工蚁最该替用户盯着的一类）。 */
const BG_STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  running: { label: '运行中', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  leftover: { label: '残留运行', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  exited: { label: '已退出', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
  stopped: { label: '已停止', cls: 'bg-green-50 text-green-700 border-green-200' },
  unsupported: { label: '无法整组归属', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
};
const BG_STATUS_ORDER = ['running', 'leftover', 'exited', 'stopped', 'unsupported'];

const LEVEL_ICON: Record<string, React.ReactNode> = { error: <XCircle className="w-3.5 h-3.5 text-red-500" />, warn: <MessageSquareText className="w-3.5 h-3.5 text-orange-500" />, info: <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" /> };
const LEVEL_DOT: Record<string, string> = { error: 'bg-red-500', warn: 'bg-orange-400', info: 'bg-blue-400' };
const TIME_OPTS = [{ v: '', l: '全部' }, { v: '1', l: '近1小时' }, { v: '24', l: '近24小时' }, { v: '168', l: '近7天' }];
const TYPE_OPTS = [
  { v: '', l: '关键事态(默认)' }, { v: 'task.completed', l: '任务完成' }, { v: 'task.failed', l: '任务失败' },
  { v: 'task.awaiting_input', l: '等待输入' }, { v: 'task.status_changed', l: '状态变更' },
  { v: 'project.status_changed', l: '项目变更' }, { v: 'deliverable.registered', l: '交付物' }, { v: '__all', l: '全部(含步骤等噪声)' },
];

function fmtTime(ts?: string | null): string {
  // 库内时间列是 UTC 且不带 Z——解析只此一份（lib/deliverable-view 的 parseDbTime），本页只保留紧凑格式
  const d = parseDbTime(ts);
  if (!d) return ts || '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function projIdOf(payload: string): string {
  try { const p = JSON.parse(payload || '{}') as { projectId?: string; project_id?: string }; return p.projectId ?? p.project_id ?? ''; } catch { return ''; }
}

export default function ActivityPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const obj = params.get('obj') || '';
  const [type, setType] = useState('');
  const [time, setTime] = useState('');
  const [showNoisy, setShowNoisy] = useState(false);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projFilter, setProjFilter] = useState('');
  const { subscribe } = useActivity();
  const seen = useRef(new Set<string>());

  // ── 后台进程（zx_20261029_3 M3）────────────────────────────────────────
  // 列表读取**顺带对账**（main 侧 probeLeftovers + prune）；孤儿**只报不杀**，停一律走显式点击，
  // 且 main 侧动手前会再核一次命令行。读不到就如实空，不编造。
  const [bgOpen, setBgOpen] = useState(false);
  const [bgJobs, setBgJobs] = useState<BackgroundJobView[]>([]);
  const [bgOrphans, setBgOrphans] = useState<OrphanServiceChainView[]>([]);
  const [bgStatusFilter, setBgStatusFilter] = useState('');
  const [bgLoading, setBgLoading] = useState(false);
  const [bgBusy, setBgBusy] = useState('');
  const [bgMsg, setBgMsg] = useState('');

  const loadBackground = useCallback(async () => {
    setBgLoading(true);
    try {
      const r = await invoke<{ items: BackgroundJobView[]; orphans: OrphanServiceChainView[] }>('background:list', { limit: 50 });
      if (r) { setBgJobs(Array.isArray(r.items) ? r.items : []); setBgOrphans(Array.isArray(r.orphans) ? r.orphans : []); }
    } catch { /* 读不到就如实空 */ } finally { setBgLoading(false); }
  }, []);

  useEffect(() => { void loadBackground(); }, [loadBackground]);
  // 命令落幕/残留是**别人在动**的状态 ⇒ 面板开着时每 15 秒对一次账（关闭时不打扰）。
  useEffect(() => {
    if (!bgOpen) return;
    const t = window.setInterval(() => { void loadBackground(); }, 15_000);
    return () => window.clearInterval(t);
  }, [bgOpen, loadBackground]);

  const stopJob = async (j: BackgroundJobView) => {
    if (!window.confirm(`停止这个后台进程组？\n\n${j.command.slice(0, 200)}\n\n先发 SIGTERM，2 秒内未退出再发 SIGKILL。`)) return;
    setBgBusy(j.id);
    try {
      const r = await invoke<StopPayload>('background:stop', j.id);
      setBgMsg(r?.message ?? '已发出停止请求');
    } catch (e) { setBgMsg(`停止失败：${(e as Error).message}`); }
    finally { setBgBusy(''); await loadBackground(); }
  };

  const stopOrphan = async (o: OrphanServiceChainView) => {
    if (!window.confirm(`停止疑似遗留进程组 ${o.pgid}（pid ${o.pid}）？\n\n${o.command}\n\n动手前会再扫一次，命令对不上就不动手。`)) return;
    const key = `orphan:${o.pgid}:${o.pid}`;
    setBgBusy(key);
    try {
      const r = await invoke<StopPayload>('background:stopOrphan', { pid: o.pid, pgid: o.pgid });
      setBgMsg(r?.message ?? '已发出停止请求');
    } catch (e) { setBgMsg(`停止失败：${(e as Error).message}`); }
    finally { setBgBusy(''); await loadBackground(); }
  };

  const bgLeftover = bgJobs.filter((j) => j.status === 'leftover' || j.status === 'running').length;
  const bgShown = bgStatusFilter ? bgJobs.filter((j) => j.status === bgStatusFilter) : bgJobs;

  const keyOf = (it: FeedItem) => `${it.event_type}:${it.aggregate_id}:${it.occurred_at}:${it.text}`;

  const fetchPage = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const r = await invoke<{ items: FeedItem[]; total: number }>('events:feed', {
        offset,
        limit: 50,
        type: type && type !== '__all' ? type : undefined,
        // 终核整改 (2026-09-03): 对象回看默认含步骤/信号等完整事件（对象时间线要完整，非仅"关键"）
        showNoisy: type === '__all' ? true : (obj && !type ? true : showNoisy),
        sinceHours: time ? Number(time) : undefined,
        aggregateId: obj || undefined,
      });
      if (!r) return;
      const uniq = r.items.filter((x) => !seen.current.has(keyOf(x)));
      uniq.forEach((x) => seen.current.add(keyOf(x)));
      setItems((prev) => (offset === 0 ? uniq : [...prev, ...uniq]));
      setTotal(r.total);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [type, time, showNoisy, obj]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    seen.current.clear();
    setExpanded({});
    setItems([]);
    fetchPage(0);
  }, [fetchPage]);

  // B1 (2026-09-04_2): 实时尾追——任何视图都持续实时，不因筛选/对象回看而退回手动。
  // 默认关键事态视图：在列表顶即时 prepend；带筛选/对象回看视图：相关事件到达 → 防抖重取 DB（DB 为权威源，无合成去重缺陷）。
  const filterRef = useRef({ type, time, obj, showNoisy, projFilter, hasItems: items.length > 0 });
  useEffect(() => {
    filterRef.current = { type, time, obj, showNoisy, projFilter, hasItems: items.length > 0 };
  }, [type, time, obj, showNoisy, projFilter, items.length]);
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = subscribe((e) => {
      if (e.type === 'task.step_streaming') return;
      const liveTypes = e.type.startsWith('task.') || e.type.startsWith('project.') || e.type === 'deliverable.registered' || e.type.startsWith('channel.');
      if (!liveTypes) return;
      const f = filterRef.current;
      const hasFilter = !!(f.type || f.time || f.obj || f.showNoisy || f.projFilter);
      if (!hasFilter) {
        if (!f.hasItems) return;
        setItems((prev) => {
          const tmp: FeedItem = { event_type: e.type, label: e.title.split(' · ')[0] || e.type, level: e.level, aggregate_type: 'task', aggregate_id: e.taskId || '', object_name: '', occurred_at: e.ts, text: '', payload: '' };
          if (seen.current.has(keyOf(tmp))) return prev;
          seen.current.add(keyOf(tmp));
          return [tmp, ...prev].slice(0, 120);
        });
        return;
      }
      if (timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; void fetchPage(0); }, 400);
    });
    return () => { unsubscribe(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [subscribe, fetchPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const projects = useMemo(() => {
    const m = new Map<string, string>();
    items.forEach((x) => { const pid = projIdOf(x.payload); if (pid && !m.has(pid)) m.set(pid, x.object_name || pid.slice(0, 8)); });
    return [...m.entries()];
  }, [items]);

  const goObject = (it: FeedItem) => {
    if (it.aggregate_type === 'project') { navigate(`/projects/${it.aggregate_id}`); return; }
    if (it.aggregate_type === 'deliverable') { navigate('/deliverables'); return; }
    if (it.aggregate_id) navigate(`/tasks/${it.aggregate_id}`);
  };

  const filtered = projFilter ? items.filter((x) => projIdOf(x.payload) === projFilter) : items;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold flex items-center gap-2"><History className="w-5 h-5 text-blue-600"/>活动中心</h2>
        <button onClick={() => { void fetchPage(0); void loadBackground(); }} className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded text-gray-600"><RefreshCw className="w-3.5 h-3.5"/>刷新</button>
      </div>
      {obj && (
        <div className="mb-3 flex items-center gap-2 text-sm bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          <span className="text-blue-700 font-medium">对象回看：{obj.slice(0, 12)}</span>
          <button type="button" onClick={() => { params.delete('obj'); setParams(params); }} className="flex items-center gap-1 text-blue-500 hover:text-blue-700 text-xs"><X className="w-3.5 h-3.5"/>清除</button>
        </div>
      )}

      {/* zx_20261029_3 M3：后台进程——看得见、停得掉。命令正常返回后仍在跑的进程组是工蚁起的，
          用户不必去系统监视器里猜哪个是它。孤儿一栏**只报不杀**，停止一律是显式点击。 */}
      <div className="mb-4 bg-white rounded-lg border">
        <button type="button" onClick={() => setBgOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700">
          {bgOpen ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          <span className="font-medium">后台进程</span>
          <span className="text-xs text-gray-500">
            {bgLeftover > 0 ? `${bgLeftover} 个仍在运行` : '无仍在运行的'}
            {bgOrphans.length > 0 ? ` · 疑似遗留 ${bgOrphans.length} 组` : ''}
          </span>
          {bgLoading && <span className="text-[10px] text-gray-400">读取中…</span>}
          <span className="ml-auto text-[11px] text-gray-400">工蚁起的进程组；退出应用时自动带走</span>
        </button>
        {bgOpen && (
          <div className="border-t px-3 py-2 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <select value={bgStatusFilter} onChange={(e) => setBgStatusFilter(e.target.value)} className="px-2 py-1 border rounded bg-white text-gray-700">
                <option value="">全部状态</option>
                {BG_STATUS_ORDER.map((s) => <option key={s} value={s}>{BG_STATUS_TEXT[s].label}</option>)}
              </select>
              <button type="button" onClick={() => void loadBackground()} className="flex items-center gap-1 px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded text-gray-600"><RefreshCw className="w-3 h-3"/>刷新</button>
              {bgMsg && <span className="text-gray-600">{bgMsg}</span>}
            </div>

            {bgShown.length === 0 && <p className="text-gray-400 text-xs py-3">暂无登记的后台进程（工具起过的命令都会记在这里）</p>}
            {bgShown.map((j) => {
              const st = BG_STATUS_TEXT[j.status] ?? { label: j.status, cls: 'bg-gray-50 text-gray-500 border-gray-200' };
              const canStop = (j.status === 'leftover' || j.status === 'running') && j.group_attributable;
              return (
                <div key={j.id} className="border rounded px-2 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                    <span className="text-gray-500">{j.tool}</span>
                    <code className="text-gray-800 truncate flex-1 min-w-0" title={j.command}>{j.command}</code>
                    <span className="text-[10px] text-gray-400 shrink-0">{fmtTime(j.started_at)}</span>
                    {canStop && (
                      <button type="button" disabled={bgBusy === j.id} onClick={() => void stopJob(j)} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 shrink-0">
                        <Square className="w-3 h-3" />停止
                      </button>
                    )}
                  </div>
                  {/* 如实标注「为什么这里没有停止按钮」——不假装按钮只是藏起来了 */}
                  {!canStop && (j.status === 'leftover' || j.status === 'running') && (
                    <p className="text-[10px] text-gray-400 mt-1">该行未记录进程组（Windows 或命令未能挂上进程组），无法整组停止</p>
                  )}
                  {j.status === 'unsupported' && <p className="text-[10px] text-gray-400 mt-1">命令没有跑起来（spawn 失败），仅留一行记录</p>}
                  {j.status === 'leftover' && j.leftover_probe_at && <p className="text-[10px] text-gray-400 mt-1">上次对账：{fmtTime(j.leftover_probe_at)} 仍在</p>}
                  {j.cwd && <p className="text-[10px] text-gray-400 mt-1 truncate" title={j.cwd}>工作目录：{j.cwd}</p>}
                </div>
              );
            })}

            <div className="pt-2 border-t">
              <p className="text-xs font-medium text-gray-700 mb-1">疑似遗留服务链 <span className="font-normal text-gray-400">（登记表外 · 只报告，点停止才动手）</span></p>
              {bgOrphans.length === 0 && <p className="text-gray-400 text-xs py-1">未发现本仓路径下的遗留 ans-server / tsx watch 进程</p>}
              {bgOrphans.map((o) => {
                const key = `orphan:${o.pgid}:${o.pid}`;
                return (
                  <div key={key} className="border border-orange-200 bg-orange-50/40 rounded px-2 py-1.5 text-xs mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-orange-700">组 {o.pgid} · pid {o.pid}</span>
                      <code className="text-gray-700 truncate flex-1 min-w-0" title={o.command}>{o.command}</code>
                      <span className="text-[10px] text-gray-400 shrink-0">{o.started_at}</span>
                      <button type="button" disabled={bgBusy === key} onClick={() => void stopOrphan(o)} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 shrink-0">
                        <Square className="w-3 h-3" />停止
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5">{o.reason}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <select value={type} onChange={(e) => setType(e.target.value)} className="px-2 py-1.5 border rounded-lg bg-white text-gray-700">{TYPE_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
        <select value={time} onChange={(e) => setTime(e.target.value)} className="px-2 py-1.5 border rounded-lg bg-white text-gray-700">{TIME_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
        {projects.length > 0 && (
          <select value={projFilter} onChange={(e) => setProjFilter(e.target.value)} className="px-2 py-1.5 border rounded-lg bg-white text-gray-700">
            <option value="">全部项目</option>
            {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-gray-500"><input type="checkbox" checked={showNoisy} onChange={(e) => setShowNoisy(e.target.checked)} /> 显示步骤/信号等噪声</label>
      </div>

      <div className="space-y-1">
        {filtered.length === 0 && !loading && <p className="text-gray-400 text-sm py-10 text-center">暂无活动</p>}
        {filtered.map((it, i) => {
          const isOpen = !!expanded[i];
          return (
            <div key={`${keyOf(it)}-${i}`} className="bg-white rounded-lg border px-3 py-2">
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setExpanded((p) => ({ ...p, [i]: !p[i] }))} className="text-gray-300 hover:text-gray-500 shrink-0">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button>
                {LEVEL_ICON[it.level]}
                <button type="button" onClick={() => goObject(it)} className="font-medium text-sm text-gray-800 hover:text-blue-600 hover:underline shrink-0 max-w-[30%] truncate">{it.label}</button>
                {it.object_name && <span className="text-xs text-gray-500 truncate max-w-[24%]">{it.object_name}</span>}
                {it.text && <span className="text-xs text-gray-500 truncate flex-1 min-w-0">{it.text}</span>}
                <span className="text-[10px] text-gray-400 shrink-0">{fmtTime(it.occurred_at)}</span>
              </div>
              {isOpen && it.payload && <pre className="mt-2 text-[11px] text-gray-500 bg-gray-50 rounded p-2 overflow-x-auto max-h-60">{it.payload}</pre>}
            </div>
          );
        })}
      </div>
      {items.length < total && (
        <button type="button" disabled={loading} onClick={() => fetchPage(items.length)} className="w-full mt-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50">{loading ? '加载中...' : `加载更多（${items.length}/${total}）`}</button>
      )}
    </div>
  );
}
