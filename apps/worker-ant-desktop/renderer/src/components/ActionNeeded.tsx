import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, X, AlertCircle, MessageSquareText } from 'lucide-react';
import { invoke } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { parseDbTime } from '../lib/deliverable-view';

interface ActionItem {
  id: string;
  project_id: string | null;
  project_name?: string | null;
  title: string;
  status: string;
  kind: 'await_input' | 'failed';
  reason?: string;
  updated_at: string;
}

/** 触发即时刷新的关键事态（回复/失败/状态流转都会让清单增减） */
const LIVE_TYPES = new Set(['task.awaiting_input', 'task.failed', 'task.completed', 'task.status_changed']);

function fmtTime(ts?: string | null): string {
  // 库内时间列是 UTC 且不带 Z——解析只此一份（lib/deliverable-view 的 parseDbTime），本页只保留紧凑格式
  const d = parseDbTime(ts);
  if (!d) return ts || '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ActionNeeded() {
  const navigate = useNavigate();
  const { subscribe } = useActivity();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  const fetchAll = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await invoke<{ items: ActionItem[]; count: number }>('tasks:actionNeeded');
      setItems(Array.isArray(r?.items) ? r.items : []);
      setCount(typeof r?.count === 'number' ? r.count : 0);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  // zx_20260906_2 批4 (4b): failed 项 inline 重试——task:resume 恢复执行；完成后刷新清单(重跑即不再属于"需我处理")
  const retryTask = async (it: ActionItem) => {
    try { await invoke('task:resume', { id: it.id }); } catch { return; }
    void fetchAll();
  };

  useEffect(() => {
    fetchAll(true);
    // zx_20260908 实机复核补: 徽标偶发"处理完未清"的陈旧兜底——15s 静默轮询(单轻量 IPC)保证最终一致归零(事件为快路径)
    const t = window.setInterval(() => { void fetchAll(true); }, 15_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe((e) => {
      if (!LIVE_TYPES.has(e.type)) return;
      if (refreshTimer.current !== undefined) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        fetchAll(true);
      }, 600);
    });
    return () => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  const toggle = () => {
    if (open) {
      setOpen(false);
    } else {
      setOpen(true);
      fetchAll();
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="需我处理"
        title="需我处理"
        className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-800 transition-colors"
      >
        <Inbox className="w-5 h-5" />
        <span className="hidden md:inline text-xs">需处理</span>
        {count > 0 && (
          <span className="min-w-[17px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] leading-4 font-medium text-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 w-[24rem] max-w-[calc(100vw-18rem)] bg-white border border-gray-200 rounded-xl shadow-lg flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
              <p className="text-sm font-semibold text-gray-700">需我处理</p>
              <button type="button" onClick={() => setOpen(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-[min(70vh,460px)] overflow-y-auto">
              {loading ? (
                <p className="text-sm text-gray-400 text-center py-8">加载中...</p>
              ) : items.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">暂无需要你处理的项</p>
              ) : (
                <ul className="divide-y divide-gray-50">
                  {items.map((it) => (
                    <li key={`${it.kind}-${it.id}`}>
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() => { setOpen(false); navigate(`/tasks/${it.id}`); }}
                          className="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-gray-50 transition-colors"
                        >
                          <div className="flex items-start gap-2">
                            <span className={`mt-0.5 flex items-center ${it.kind === 'await_input' ? 'text-orange-500' : 'text-red-500'}`}>
                              {it.kind === 'await_input' ? <MessageSquareText className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-medium text-gray-800 truncate">{it.title}</p>
                                <span className="text-[10px] text-gray-400 shrink-0">{fmtTime(it.updated_at)}</span>
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${it.kind === 'await_input' ? 'bg-orange-50 text-orange-600' : 'bg-red-50 text-red-600'}`}>
                                  {it.kind === 'await_input' ? '等待回复' : '执行失败'}
                                </span>
                                {it.project_name && <span className="text-[10px] text-gray-400 truncate">{it.project_name}</span>}
                              </div>
                              {it.reason && <p className="text-xs text-gray-500 mt-0.5">{it.reason}</p>}
                            </div>
                          </div>
                        </button>
                        {it.kind === 'failed' && (
                          <button type="button" onClick={() => retryTask(it)} title="继续执行（保留对话，task:resume）；如需清空重跑请到任务详情用「重试」"
                            className="shrink-0 mr-2.5 text-[10px] px-2 py-1 rounded bg-green-50 text-green-700 hover:bg-green-100 font-medium">↻ 继续</button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
