import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { History, RefreshCw, ChevronDown, ChevronRight, X, CheckCircle2, XCircle, MessageSquareText } from 'lucide-react';
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
        <button onClick={() => fetchPage(0)} className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded text-gray-600"><RefreshCw className="w-3.5 h-3.5"/>刷新</button>
      </div>
      {obj && (
        <div className="mb-3 flex items-center gap-2 text-sm bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
          <span className="text-blue-700 font-medium">对象回看：{obj.slice(0, 12)}</span>
          <button type="button" onClick={() => { params.delete('obj'); setParams(params); }} className="flex items-center gap-1 text-blue-500 hover:text-blue-700 text-xs"><X className="w-3.5 h-3.5"/>清除</button>
        </div>
      )}
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
