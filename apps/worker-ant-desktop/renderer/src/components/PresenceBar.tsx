import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../lib/settingsStore';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';
import { Activity, AlertTriangle } from 'lucide-react';

/**
 * zx_20260908 D1/D4: 全局「执行在场条」——main 每 20s 心跳扫描聚合 presence.update 广播，
 * 任意页顶部显示 执行中任务数/最长已运行时长；D4: 状态为 running 但 wa_tasks.updated_at 久未推进(>120s)
 * 的项反色标「⚠ 无推进」，识破"看似运行"假名(空性·无自性)；reaper 超 >10min 仍自动按失败回收兜底。
 * 开关 ui.presence_bar / ui.stale_running_hint；点击项直达任务详情。
 */
interface PresenceTask { taskId: string; projectId?: string; title: string; tokens: number; elapsedSec: number; staleSec: number; updatedAt?: string | null }
const STALE_MS = 120;

export default function PresenceBar() {
  const navigate = useNavigate();
  const settings = useSettings();
  const enabled = boolSetting(settings['ui.presence_bar']);
  const staleHint = boolSetting(settings['ui.stale_running_hint']);
  const [tasks, setTasks] = useState<PresenceTask[]>([]);
  // 本地秒针——场条时长 1s 平滑走（非每 20s 更新一次的"跳秒"，看着不冻）；主进程空转会发空列表清场
  const [, setTick] = useState(0);
  const lastBeatRef = useRef(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !window.electronAPI?.onTaskEvent) return;
    return window.electronAPI.onTaskEvent((event) => {
      if (event.type !== 'presence.update') return;
      const payload = event as unknown as { tasks?: PresenceTask[] };
      lastBeatRef.current = Date.now();
      setTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
    });
  }, [enabled]);

  if (!enabled || tasks.length === 0) return null;
  // 本地秒针平滑：距上次 presence.update 内逐秒累加(上限 25s，防挂起/漏beat后虚高)；主进程空转会发空列表清场
  const liveExtra = Math.min(25, Math.max(0, Math.floor((Date.now() - lastBeatRef.current) / 1000)));
  const smooth = (s?: number) => (s || 0) + liveExtra;
  const longest = tasks.reduce((m, t) => Math.max(m, smooth(t.elapsedSec)), 0);
  const staleCount = staleHint ? tasks.filter(t => (t.staleSec || 0) > STALE_MS).length : 0;
  const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? `${Math.round(s % 60)}s` : ''}` : `${s}s`);

  return (
    <div className={`mb-3 rounded-lg border p-2.5 text-sm shadow-sm ${staleCount > 0 ? 'border-orange-200 bg-orange-50' : 'border-blue-200 bg-blue-50'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1 text-xs font-semibold text-blue-700"><Activity className="w-4 h-4 animate-pulse" />执行中 {tasks.length}{tasks.length > 1 ? ` · 最长 ${fmt(longest)}` : ''}</span>
        {staleCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-600">⚠ {staleCount} 项 {STALE_MS}s 无推进</span>}
        <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1 justify-end">
          {tasks.map((t) => {
            const stale = staleHint && (t.staleSec || 0) > STALE_MS;
            return (
              <button key={t.taskId} type="button" onClick={() => navigate(`/tasks/${t.taskId}`)}
                title={`${t.title}\n已运行 ${fmt(smooth(t.elapsedSec))} · tokens ${t.tokens}${t.updatedAt ? `\n最近推进 ${String(t.updatedAt).slice(5, 19)}` : ''}`}
                className={`text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${stale ? 'bg-red-50 text-red-600 border-red-200' : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-100'}`}>
                {stale && <AlertTriangle className="w-3 h-3 text-red-500" />}
                <span className="max-w-[160px] truncate">{t.title || t.taskId.slice(0, 8)}</span>
                <span className="opacity-70">{fmt(smooth(t.elapsedSec))}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
