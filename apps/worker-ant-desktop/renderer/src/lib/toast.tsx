import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, XCircle, MessageSquareText, X } from 'lucide-react';
import { useActivity } from '../lib/activity';
import { useSettings, isQuietTimeActive } from '../lib/settingsStore';
import { shouldPlaySound, playToastSound } from '../lib/sound';
import { imReminderChannel, isImRoute, imInboundNotice } from '../lib/im-reminder';

interface ToastItem {
  id: string;
  type: string;
  title: string;
  taskId?: string;
  /** 点击跳转目标（IM 提醒 → `/im`）；与 `taskId` 互斥，二者皆无则点击仅关闭。 */
  to?: string;
  level: 'error' | 'warn' | 'info';
}

const TOAST_TYPES = new Set(['task.failed', 'task.awaiting_input', 'task.completed']);
const DEDUPE_MS = 8000;

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { subscribe } = useActivity();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const lastSeen = useRef(new Map<string, number>());
  // C1 (2026-09-04_2): 免打扰2.0——响应式设置，运行中改即时生效（不再"挂载读一次"）
  const settings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const unsubscribe = subscribe((e) => {
      // zx_20261002 M1: IM 入站的**应用内**提醒——只在"可见但不在 IM 页"时给（不可见走原生横幅，
      //   见 `AppLayout.tsx`；在 IM 页则不打扰）。通道判据与原生那路**同一函数**，不各写一份。
      if (e.type === 'im.message_inbound') {
        const channel = imReminderChannel({ visible: document.visibilityState === 'visible', onImPage: isImRoute(window.location.hash) });
        if (channel !== 'toast') return;
        if (settingsRef.current.ui_dnd === '1') return;
        const n = imInboundNotice(e.raw as Record<string, unknown>);
        const id = `im-${e.seq}-${Date.now()}`;
        setToasts((prev) => [...prev.slice(-3), { id, type: 'im.message_inbound', title: `${n.title}：${n.body}`, to: '/im', level: 'info' }]);
        window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 7000);
        return;
      }
      if (!TOAST_TYPES.has(e.type)) return;
      const s = settingsRef.current;
      // zx_20260906 批4 (4c): 全局免打扰总开关——应用内 toast/声音一并收敛（事件仍进通知中心·铃点·需处理）
      if (s.ui_dnd === '1') return;
      const quiet = isQuietTimeActive(s);
      // B1 (2026-09-03_2): 安静时段完成类勿扰（默认）
      if (e.type === 'task.completed' && quiet) return;
      // C1 (2026-09-04_2): 可选——安静时段连"失败/需输入"应用内 toast 也静音（原生仍守中弹出）
      if (quiet && s.notify_quiet_mute_critical === '1' && (e.type === 'task.failed' || e.type === 'task.awaiting_input')) return;
      const now = Date.now();
      const key = `${e.type}:${e.taskId || ''}`;
      const last = lastSeen.current.get(key);
      if (last && now - last < DEDUPE_MS) return;
      lastSeen.current.set(key, now);
      if (lastSeen.current.size > 100) { const oldest = lastSeen.current.keys().next().value; if (oldest !== undefined) lastSeen.current.delete(oldest); }
      const t: ToastItem = { id: `${key}-${now}`, type: e.type, title: e.title, taskId: e.taskId, level: e.level };
      setToasts((prev) => [...prev.slice(-3), t]);
      // D2 (2026-09-04_2): 应用内提示音（按事件类 × 声音开关 × 免打扰）
      if (shouldPlaySound(e.type, settingsRef.current)) playToastSound(e.type);
      window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 7000);
    });
    return unsubscribe;
  }, [subscribe]);

  const dismiss = (id: string) => setToasts((prev) => prev.filter((x) => x.id !== id));

  const iconOf = (t: ToastItem) => t.type === 'im.message_inbound' ? <MessageSquareText className="w-4 h-4 text-blue-500" /> : t.level === 'error' ? <XCircle className="w-4 h-4 text-red-500" /> : t.level === 'warn' ? <MessageSquareText className="w-4 h-4 text-orange-500" /> : <CheckCircle2 className="w-4 h-4 text-green-500" />;

  return (
    <>
      {children}
      <div className="fixed top-4 right-4 z-[90] flex flex-col gap-2 w-80 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className={`pointer-events-auto bg-white border rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 ${t.level === 'error' ? 'border-red-200' : t.level === 'warn' ? 'border-orange-200' : 'border-green-200'}`}>
            {iconOf(t)}
            <button type="button" className="flex-1 min-w-0 text-left" onClick={() => { dismiss(t.id); if (t.to) navigate(t.to); else if (t.taskId) navigate(`/tasks/${t.taskId}`); }} title={t.to ? '点击前往 IM' : '点击跳转任务'}>
              <p className="text-sm font-medium text-gray-800 truncate">{t.title}</p>
            </button>
            <button type="button" onClick={() => dismiss(t.id)} className="shrink-0 text-gray-300 hover:text-gray-500"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
    </>
  );
}
