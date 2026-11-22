import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, X, AlertCircle, MessageSquareText } from 'lucide-react';
import { invoke, knowledge as knowledgeApi } from '../lib/ipc';
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

/** 触发即时刷新的关键事态（回复/失败/状态流转/知识决定都会让清单增减） */
const LIVE_TYPES = new Set(['task.awaiting_input', 'task.failed', 'task.completed', 'task.status_changed', 'knowledge.changed']);

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
  // zx_20261121_3 M4「见·首」：知识待办也是「该我办」——铃铛计入，但只在待办中心一处批。
  //   读失败如实记（`null` 不当作 0）。
  const [knowledgeCount, setKnowledgeCount] = useState<number | null>(null);
  const [knowledgeError, setKnowledgeError] = useState('');
  const refreshTimer = useRef<number | undefined>(undefined);

  const fetchAll = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [r, k] = await Promise.all([
        invoke<{ items: ActionItem[]; count: number }>('tasks:actionNeeded'),
        knowledgeApi.inbox(1).then((d) => ({ ok: true as const, d }))
          .catch((e) => ({ ok: false as const, e })),
      ]);
      setItems(Array.isArray(r?.items) ? r.items : []);
      setCount(typeof r?.count === 'number' ? r.count : 0);
      if (k.ok) {
        const groups = [k.d.lessons, k.d.skills, k.d.packs, k.d.proposals];
        const total = groups.reduce((n, g) => n + (g.status === 'ok' ? g.count : 0), 0);
        setKnowledgeCount(total);
        setKnowledgeError(groups.some((g) => g.status === 'error') ? '部分读取失败' : '');
      } else {
        setKnowledgeCount(null);
        setKnowledgeError((k.e as Error)?.message || String(k.e));
      }
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

  // 徽标 = 任务类 + 知识类；知识读不到时只显示任务类（不把「读不到」算成 0 之后还谎称总数准确）。
  const totalCount = count + (knowledgeCount ?? 0);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label="需我处理"
        title="需我处理"
        className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-control text-sm text-ink-soft hover:bg-paper hover:text-ink transition-colors"
      >
        <Inbox className="w-5 h-5" />
        <span className="hidden md:inline text-xs">需处理</span>
        {totalCount > 0 && (
          <span className="min-w-[17px] h-4 px-1 rounded-full bg-cinnabar text-paper text-[10px] leading-4 font-medium text-center tnum">
            {totalCount > 99 ? '99+' : totalCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 w-[24rem] max-w-[calc(100vw-18rem)] bg-surface border border-line rounded-card shadow-card flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-line">
              <p className="font-display text-sm font-semibold text-ink">需我处理</p>
              <button type="button" onClick={() => setOpen(false)} className="p-1 text-ink-mute hover:text-ink rounded hover:bg-paper">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-[min(70vh,460px)] overflow-y-auto">
              {loading ? (
                <p className="text-sm text-ink-mute text-center py-8">加载中...</p>
              ) : items.length === 0 && (knowledgeCount ?? 0) === 0 && !knowledgeError ? (
                <p className="text-sm text-ink-mute text-center py-8">暂无需要你处理的项</p>
              ) : items.length === 0 ? null : (
                <ul className="divide-y divide-line/70">
                  {items.map((it) => (
                    <li key={`${it.kind}-${it.id}`}>
                      <div className="flex items-center">
                        <button
                          type="button"
                          onClick={() => { setOpen(false); navigate(`/tasks/${it.id}`); }}
                          className="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-paper transition-colors"
                        >
                          <div className="flex items-start gap-2">
                            <span className={`mt-0.5 flex items-center ${it.kind === 'await_input' ? 'text-warn' : 'text-bad'}`}>
                              {it.kind === 'await_input' ? <MessageSquareText className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-medium text-ink truncate">{it.title}</p>
                                <span className="text-[10px] text-ink-mute shrink-0 tnum">{fmtTime(it.updated_at)}</span>
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${it.kind === 'await_input' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad'}`}>
                                  {it.kind === 'await_input' ? '等待回复' : '执行失败'}
                                </span>
                                {it.project_name && <span className="text-[10px] text-ink-mute truncate">{it.project_name}</span>}
                              </div>
                              {it.reason && <p className="text-xs text-ink-mute mt-0.5">{it.reason}</p>}
                            </div>
                          </div>
                        </button>
                        {it.kind === 'failed' && (
                          <button type="button" onClick={() => retryTask(it)} title="继续执行（保留对话，task:resume）；如需清空重跑请到任务详情用「重试」"
                            className="shrink-0 mr-2.5 text-[10px] px-2 py-1 rounded bg-ok-soft text-ok hover:bg-ok-soft/80 font-medium">↻ 继续</button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* zx_20261121_3 M4：知识待办只给入口，不在弹层里批（决定统一在待办中心一处办）。 */}
            {(knowledgeError || (knowledgeCount !== null && knowledgeCount > 0)) && (
              <div className="border-t border-line px-3 py-2">
                {knowledgeError ? (
                  <p className="text-xs text-bad">知识待办读取失败：{knowledgeError}（不当作「没有待办」）</p>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setOpen(false); navigate('/inbox#knowledge'); }}
                    className="flex w-full items-center justify-between gap-2 rounded-control px-1 py-1 text-left text-xs text-ink-soft hover:bg-paper hover:text-ink"
                  >
                    <span>知识待办 <span className="tnum">{knowledgeCount}</span> 条（经验 / 技能 / 领域包 / 提案）</span>
                    <span className="shrink-0 text-accent">去待办中心 →</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
