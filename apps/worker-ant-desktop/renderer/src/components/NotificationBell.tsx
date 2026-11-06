import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, ChevronDown, ChevronRight, X, Trash2 } from 'lucide-react';
import { invoke } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { parseDbTime } from '../lib/deliverable-view';

interface NotifItem {
  id: string;
  type: string;
  task_id: string | null;
  project_id: string | null;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

// zx_20260915 M4/P0-6：增 `task.goal_deviation`——引擎的偏离提醒此前只进会话流、
// 从不落通知面，铃自然收不到。漏了它则"偏离到了眼前"这件事要手刷才可见。
const LIVE_TYPES = new Set(['task.failed', 'task.awaiting_input', 'task.completed', 'task.goal_deviation']);

// C2 (2026-09-04_2): 事件"家族相似"映射（代码推断，不加表列不迁移）——家族：失败/需处理/完成/其它
type FamilyKey = 'failed' | 'await' | 'done' | 'other';
// zx_20260915 M4/P0-6：`task.paused`（引擎自置暂停）与 `task.goal_deviation`（偏离）都归"需处理"家族
// ——两者都是"要人看一眼"的事态，归 `other` 会让它们既不计数也不可筛。
const FAMILY_OF_MAP: Record<string, FamilyKey> = {
  'task.failed': 'failed',
  'task.awaiting_input': 'await',
  'task.paused': 'await',
  'task.goal_deviation': 'await',
  'task.completed': 'done',
};
const FAMILY_OF = (t: string): FamilyKey => FAMILY_OF_MAP[t] ?? 'other';

/** `task.status_changed` 里**会落通知行**的状态（与 main 侧 `notification-core.ts` 的分支同集） */
const NOTABLE_VIA_STATUS = new Set(['completed', 'paused', 'failed']);
const FAMILY_META: Record<FamilyKey, { l: string; dot: string }> = {
  failed: { l: '失败', dot: 'bg-red-500' },
  await: { l: '需处理', dot: 'bg-orange-400' },
  done: { l: '完成', dot: 'bg-green-500' },
  other: { l: '其它', dot: 'bg-gray-400' },
};

function fmtTime(ts?: string | null): string {
  // 库内时间列是 UTC 且不带 Z——解析只此一份（lib/deliverable-view 的 parseDbTime），本页只保留紧凑格式
  const d = parseDbTime(ts);
  if (!d) return ts || '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const { subscribe } = useActivity();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotifItem[]>([]);
  const [loading, setLoading] = useState(false);
  // C2 (2026-09-04_2): 家族过滤 + 合并展开
  const [familyFilter, setFamilyFilter] = useState<'' | FamilyKey>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // C2 (2026-09-04_2 整改): 项目过滤 + 分页"加载更多"（增量合入去重——同任务同家族跨页仍合并 ×N）
  const PAGE_SIZE = 60;
  const [projFilter, setProjFilter] = useState('');
  const [projectOpts, setProjectOpts] = useState<Array<{ id: string; name: string }>>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);
  const itemsRef = useRef<NotifItem[]>([]);
  const projRef = useRef('');
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { projRef.current = projFilter; }, [projFilter]);

  // 项目下拉：通知 project_id → 名称映射（供项目过滤）
  useEffect(() => {
    invoke<Array<Record<string, unknown>>>('project:list')
      .then((list) => setProjectOpts((Array.isArray(list) ? list : []).map((p) => ({ id: String(p.id), name: String(p.name || p.id) }))))
      .catch(() => { /* 拉取失败则项目过滤仅显示全部 */ });
  }, []);

  const fetchUnread = async () => {
    try {
      const r = await invoke<{ unread: number }>('notifications:unread');
      setUnread(typeof r?.unread === 'number' ? r.unread : 0);
    } catch { /* ignore */ }
  };

  const fetchList = async (reset = true) => {
    if (reset) setLoading(true);
    else setLoadingMore(true);
    const offset = reset ? 0 : itemsRef.current.length;
    try {
      const r = await invoke<{ items: NotifItem[]; unread: number; total?: number }>('notifications:list', { limit: PAGE_SIZE, offset, projectId: projRef.current || undefined });
      const incoming = Array.isArray(r?.items) ? r.items : [];
      setItems((prev) => {
        if (reset) return incoming;
        const seen = new Set(prev.map((it) => it.id));
        return [...prev, ...incoming.filter((it) => !seen.has(it.id))];
      });
      if (typeof r?.total === 'number') setTotal(r.total);
      if (typeof r?.unread === 'number') setUnread(r.unread);
    } catch { /* ignore */ } finally { setLoading(false); setLoadingMore(false); }
  };

  const applyProjectFilter = (pid: string) => {
    projRef.current = pid;
    setProjFilter(pid);
    setFamilyFilter('');
    setExpanded(new Set());
    void fetchList(true);
  };

  const hasMore = total != null && items.length < total;

  useEffect(() => { fetchUnread(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // A1 全局事件 → 关键事态到达刷新未读
  useEffect(() => {
    const unsubscribe = subscribe((e) => {
      // zx_20260906_1 4e: 铃点覆盖兜底——部分流程只发 status_changed(new_status=completed) 而无 task.completed，纳入刷新避免未读漏更
      // zx_20260915 M4/P0-6: 兜底面由「只管 completed」**扩到三种会落通知行的状态**——M4 之后
      // `status_changed{paused|failed}` 也落通知行（引擎自置暂停、`update_task_status` 工具路的失败），
      // 只兜 completed 则这些**新通知要手刷才可见**，与"到得了人"直接冲突。
      const nsRaw = (e as { new_status?: string; newStatus?: string }).new_status ?? (e as { new_status?: string; newStatus?: string }).newStatus;
      const notableViaStatus = e.type === 'task.status_changed'
        && typeof nsRaw === 'string' && NOTABLE_VIA_STATUS.has(nsRaw);
      if (!LIVE_TYPES.has(e.type) && !notableViaStatus) return;
      if (refreshTimer.current !== undefined) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        if (open) fetchList(); else fetchUnread();
      }, 500);
    });
    return () => { if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current); unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, open]);

  const toggle = () => { if (open) { setOpen(false); } else { setOpen(true); setFamilyFilter(''); setExpanded(new Set()); fetchList(); } };

  const markRead = async (id: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, read_at: new Date().toISOString() } : it)));
    try { const r = await invoke<{ unread: number }>('notifications:markRead', id); if (typeof r?.unread === 'number') setUnread(r.unread); } catch { /* ignore */ }
  };

  const markAllRead = async () => {
    setItems((prev) => prev.map((it) => ({ ...it, read_at: new Date().toISOString() })));
    setUnread(0);
    try { await invoke('notifications:markAllRead'); } catch { /* ignore */ }
  };

  const markTaskRead = async (taskId: string | null) => {
    if (!taskId) return;
    setItems((prev) => prev.map((it) => (it.task_id === taskId ? { ...it, read_at: new Date().toISOString() } : it)));
    try { const r = await invoke<{ unread: number }>('notifications:markTaskRead', taskId); if (typeof r?.unread === 'number') setUnread(r.unread); } catch { /* ignore */ }
  };

  // zx_20260906_2 批4 (4b): 失败通知 inline 重试——复用 task:resume 恢复语义(与 Dashboard mainIssue 同款)；成功后 markTaskRead 使铃/dock/家族计数即降(处置即已读)
  const retryFailed = async (it: NotifItem) => {
    if (!it.task_id) return;
    try { await invoke('task:resume', { id: it.task_id }); } catch { /* 恢复失败保持原样 */ return; }
    if (!it.read_at) await markTaskRead(it.task_id);
    void fetchList();
  };

  const clearRead = async () => {
    if (!window.confirm('确定清除已读通知历史？未读保留。')) return;
    setItems((prev) => prev.filter((it) => !it.read_at));
    try { const r = await invoke<{ unread: number }>('notifications:clearRead'); if (typeof r?.unread === 'number') setUnread(r.unread); } catch { /* ignore */ }
  };

  const openTask = async (it: NotifItem) => {
    if (!it.read_at) await markRead(it.id);
    setOpen(false);
    if (it.task_id) navigate(`/tasks/${it.task_id}`);
  };

  // C2: 家族计数 + 反复合并视图（同任务同家族合并为单条可展开）
  const famCounts = useMemo(() => {
    const m: Record<FamilyKey, { n: number; unread: number }> = { failed: { n: 0, unread: 0 }, await: { n: 0, unread: 0 }, done: { n: 0, unread: 0 }, other: { n: 0, unread: 0 } };
    items.forEach((it) => { const f = FAMILY_OF(it.type); m[f].n += 1; if (!it.read_at) m[f].unread += 1; });
    return m;
  }, [items]);

  const groups = useMemo(() => {
    const filtered = familyFilter ? items.filter((it) => FAMILY_OF(it.type) === familyFilter) : items;
    const map = new Map<string, { key: string; family: FamilyKey; task_id: string | null; items: NotifItem[] }>();
    const order: Array<{ key: string; family: FamilyKey; task_id: string | null; items: NotifItem[] }> = [];
    for (const it of filtered) {
      const key = `${FAMILY_OF(it.type)}:${it.task_id ?? it.id}`;
      let g = map.get(key);
      if (!g) { g = { key, family: FAMILY_OF(it.type), task_id: it.task_id, items: [] }; map.set(key, g); order.push(g); }
      g.items.push(it);
    }
    return order;
  }, [items, familyFilter]);

  const rowUnread = (its: NotifItem[]) => its.some((i) => !i.read_at);
  const renderItem = (it: NotifItem) => {
    const fam = FAMILY_OF(it.type);
    const canRetry = fam === 'failed' && !!it.task_id;
    return (
      <div role="button" tabIndex={0} onClick={() => openTask(it)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(it); } }} className={`w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors cursor-pointer ${!it.read_at ? 'bg-blue-50/40' : ''}`}>
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${!it.read_at ? FAMILY_META[fam].dot : 'bg-transparent border border-gray-200'}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-gray-800 truncate">{it.title}</p>
              <span className="text-[10px] text-gray-400 shrink-0">{fmtTime(it.created_at)}</span>
            </div>
            {it.body && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{it.body}</p>}
          </div>
        </div>
        {canRetry && (
          <div className="flex justify-end mt-1 -mb-0.5">
            <button type="button" onClick={(e) => { e.stopPropagation(); retryFailed(it); }} title="继续执行（保留对话，task:resume）；如需清空重跑请到任务详情用「重试」" className="text-[10px] px-2 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100 font-medium">↻ 继续</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="relative">
      <button type="button" onClick={toggle} aria-label="通知中心" title="通知中心" className="relative p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors">
        <Bell className="w-5 h-5" />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 font-medium text-center">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 w-[26rem] max-w-[calc(100vw-18rem)] bg-white border border-gray-200 rounded-xl shadow-lg flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
              <p className="text-sm font-semibold text-gray-700">通知中心</p>
              <div className="flex items-center gap-1">
                {unread > 0 && (
                  <button type="button" onClick={markAllRead} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50">
                    <CheckCheck className="w-3.5 h-3.5" />全部已读
                  </button>
                )}
                {items.some((i) => i.read_at) && (
                  <button type="button" onClick={clearRead} title="清除已读历史" className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-100">
                    <Trash2 className="w-3 h-3" />清空已读
                  </button>
                )}
                <button type="button" onClick={() => setOpen(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100"><X className="w-4 h-4" /></button>
              </div>
            </div>

            {/* C2 (2026-09-04_2 整改): 项目过滤（通知按 project_id 分组查看） */}
            {projectOpts.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-50">
                <span className="text-[10px] text-gray-400 shrink-0">项目</span>
                <select value={projFilter} onChange={(e) => applyProjectFilter(e.target.value)} className="flex-1 min-w-0 px-2 py-1 border border-gray-200 rounded text-xs bg-white text-gray-600" aria-label="按项目过滤通知">
                  <option value="">全部项目</option>
                  {projectOpts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {projFilter && <button type="button" onClick={() => applyProjectFilter('')} className="shrink-0 text-[10px] text-gray-400 hover:text-gray-600">清除</button>}
              </div>
            )}

            {/* C2 (2026-09-04_2): 家族相似过滤 chips（含未读角标） */}
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-gray-50 text-[11px]">
              <button type="button" onClick={() => setFamilyFilter('')} className={`px-2 py-0.5 rounded-full font-medium ${familyFilter === '' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>全部 {items.length}</button>
              {(['failed', 'await', 'done'] as FamilyKey[]).map((f) => famCounts[f].n > 0 ? (
                <button key={f} type="button" onClick={() => setFamilyFilter(familyFilter === f ? '' : f)} className={`px-2 py-0.5 rounded-full font-medium flex items-center gap-1 ${familyFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {FAMILY_META[f].l} {famCounts[f].n}{famCounts[f].unread > 0 ? <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> : null}
                </button>
              ) : null)}
            </div>

            <div className="max-h-[min(70vh,440px)] overflow-y-auto">
              {loading ? (
                <p className="text-sm text-gray-400 text-center py-8">加载中...</p>
              ) : groups.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">暂无通知</p>
              ) : (
                <ul className="divide-y divide-gray-50">
                  {groups.map((g) => {
                    const first = g.items[0]!;
                    const count = g.items.length;
                    const unreadGrp = rowUnread(g.items);
                    const isOpen = expanded.has(g.key);
                    if (count === 1) return <li key={first.id}>{renderItem(first)}</li>;
                    return (
                      <li key={g.key}>
                        <div className="flex items-center px-2">
                          <button type="button" onClick={() => setExpanded((p) => { const s = new Set(p); if (s.has(g.key)) s.delete(g.key); else s.add(g.key); return s; })} className="shrink-0 p-1 text-gray-300 hover:text-gray-500">
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                          <button type="button" onClick={() => openTask(first)} className={`flex-1 min-w-0 text-left px-1 py-2.5 hover:bg-gray-50 transition-colors ${unreadGrp ? 'bg-blue-50/40' : ''}`}>
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 shrink-0 rounded-full ${unreadGrp ? FAMILY_META[g.family].dot : 'bg-transparent border border-gray-200'}`} />
                              <p className="flex-1 min-w-0 text-sm font-medium text-gray-800 truncate">{first.title}</p>
                              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">×{count}</span>
                              <span className="text-[10px] text-gray-400 shrink-0">{fmtTime(g.items[g.items.length - 1]?.created_at)}</span>
                            </div>
                          </button>
                          {unreadGrp && (
                            <button type="button" onClick={() => markTaskRead(g.task_id)} title="本任务已读" className="shrink-0 p-1 text-blue-400 hover:text-blue-600"><CheckCheck className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                        {isOpen && (
                          <ul className="pl-7 pr-2 pb-1 border-l ml-5">
                            {g.items.map((it) => (
                              <li key={it.id}>{renderItem(it)}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {/* C2 (2026-09-04_2 整改): 分页"加载更多"（增量合入，同任务同家族跨页仍合并 ×N） */}
            {hasMore && (
              <button type="button" onClick={() => fetchList(false)} disabled={loadingMore} className="w-full py-2 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-wait border-t border-gray-50">
                {loadingMore ? '加载中...' : `加载更多（已显示 ${items.length} / ${total ?? items.length}）`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
