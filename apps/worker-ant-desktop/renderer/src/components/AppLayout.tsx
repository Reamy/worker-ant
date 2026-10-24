import { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut, BellRing } from 'lucide-react';
// zx_20261013_1 批三: 导航表提为**一处真源**（`lib/navConfig`）——侧栏与首启导览消费同一个数组，
//   不再各自持有入口清单（导览词表由此派生，见 `tourEntries()`）。
import { NAV_GROUPS } from '../lib/navConfig';
import { im } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { imReminderChannel, isImRoute, imInboundNotice } from '../lib/im-reminder';
import NotificationBell from './NotificationBell';
import ActionNeeded from './ActionNeeded';
import CommandPalette from './CommandPalette';
import PresenceBar from './PresenceBar';

function decodeToken(token: string): { email?: string; role?: string } | null {
  try { const parts = token.split('.'); if (parts.length !== 3) return null; return JSON.parse(atob(parts[1]!)); } catch { return null; }
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<{ email?: string; role?: string }>({});
  // zx_20260905 批6: 前瞻记忆「到期」提醒浮出——main 已推 prospective.due（此前 renderer 无消费被丢弃），这里全局消费：横幅浮出可点定位
  const [prospective, setProspective] = useState<{ content: string; projectId?: string } | null>(null);
  // zx_20260914 M1-3(海德格尔·在场): IM 导航红点——未读只在 main 算一次（`computeImUnread`），
  //   这里**只接收 main 推来的那一个数**（`im.unread`），绝不自己加减。见方案 §批 M1-B.1（方案①有竞态）。
  const [imUnread, setImUnread] = useState(0);
  // zx_20261002 M1: IM 跨页提醒（**原生横幅**那一路）——窗口不可见时，入站消息经系统通知送达。
  //   「该走哪条通道」由纯判据 `imReminderChannel` 定：不可见→native（此处），可见不在 IM 页→toast
  //   （`lib/toast.tsx`），可见且在本页→none。两条路互斥，不重复打扰。
  const { subscribe } = useActivity();
  useEffect(() => {
    return subscribe((e) => {
      if (e.type !== 'im.message_inbound') return;
      const channel = imReminderChannel({ visible: document.visibilityState === 'visible', onImPage: isImRoute(window.location.hash) });
      if (channel !== 'native') return;
      const { title, body } = imInboundNotice(e.raw as Record<string, unknown>);
      void window.electronAPI?.showNotification?.(title, body);
    });
  }, [subscribe]);

  useEffect(() => {
    if (window.electronAPI?.isElectron) {
      window.electronAPI.getToken().then(t => { if (t) setUser(decodeToken(t) || {}); });
    } else {
      const t = localStorage.getItem('token');
      if (t) setUser(decodeToken(t) || {});
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onTaskEvent) return;
    return window.electronAPI.onTaskEvent((event) => {
      // zx_20260914 M1-3: 未读推送（入站到达 / 标记已读 / 启动对账时由 main 的单点 `refreshImUnread` 发出）。
      if (event.type === 'im.unread') { setImUnread(Number(event.unread) || 0); return; }
      if (event.type !== 'prospective.due') return;
      setProspective({ content: String(event.content ?? '').slice(0, 140), projectId: event.projectId ? String(event.projectId) : undefined });
    });
  }, []);
  // zx_20260914 M1-3: 初值自取一次——启动那次推送早于渲染进程订阅（窗口还没建好），不自取则红点永为 0。
  useEffect(() => { void im.unread().then(r => setImUnread(Number(r?.unread) || 0)).catch(() => {}); }, []);
  // 自动收起（新前瞻到期会重置）
  useEffect(() => {
    if (!prospective) return;
    const t = window.setTimeout(() => setProspective(null), 12_000);
    return () => window.clearTimeout(t);
  }, [prospective]);

  const handleLogout = async () => {
    if (window.electronAPI?.isElectron) await window.electronAPI.clearTokens();
    else { localStorage.removeItem('token'); localStorage.removeItem('refreshToken'); }
    navigate('/login');
  };

  return (
    <div className="flex h-screen">
      <aside className="w-56 bg-gray-900 text-white flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-lg font-bold">🐜 工蚁系统</h1>
          <p className="text-xs text-gray-400 mt-0.5">Worker Ant Desktop</p>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {NAV_GROUPS.map(group => (
            <div key={group.label} className="mb-3">
              <p className="px-3 mb-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{group.label}</p>
              {group.items.map(({ to, icon: Icon, label }) => (
                <NavLink key={to} to={to} end={to === '/'} data-tour={to}
                  className={({ isActive }) => `flex items-center gap-3 px-3 py-1.5 rounded-md text-sm transition-colors ${isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}>
                  <Icon className="w-4 h-4" />{label}
                  {/* zx_20260914 M1-3: IM 未读红点——数与托盘角标同源（都来自 main 那一次计算），
                      这里不自增、不自减；上限 99+ 只是显示收敛，不改真值。 */}
                  {to === '/im' && imUnread > 0 && (
                    <span className="ml-auto min-w-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] leading-[18px] text-center" title={`${imUnread} 条未读消息`}>
                      {imUnread > 99 ? '99+' : imUnread}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-700 space-y-2">
          {user.email && <p className="text-xs text-gray-400 truncate">{user.email}{user.role && <span className="ml-1 text-gray-500">({user.role})</span>}</p>}
          <button onClick={handleLogout} className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors w-full"><LogOut className="w-3 h-3" />退出登录</button>
          <p className="text-xs text-gray-600">v0.2.0</p>
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        {/* A3: 全局顶栏（通知中心入口 + 未来全局动作） */}
        <header className="h-12 shrink-0 bg-white border-b border-gray-200 flex items-center justify-end px-4 gap-1 z-20">
          <ActionNeeded />
          <NotificationBell />
        </header>
        <div className="flex-1 overflow-auto p-6">
          {/* zx_20260908 D1/D4: 全局执行在场条（任意页可见，含无推进反色） */}
          <PresenceBar />
          {prospective && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-cyan-200 bg-cyan-50 p-3 text-sm shadow-sm">
              <BellRing className="w-4 h-4 text-cyan-500 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-cyan-700">前瞻记忆·到期提醒</p>
                <button type="button" onClick={() => { if (prospective.projectId) navigate(`/projects/${prospective.projectId}`); else navigate('/memories'); setProspective(null); }} className="text-left text-cyan-800 hover:text-cyan-950 hover:underline break-words" title="点击定位">“{prospective.content}”</button>
              </div>
              <button type="button" onClick={() => setProspective(null)} className="text-cyan-400 hover:text-cyan-700 text-xs">✕</button>
            </div>
          )}
          {children}
        </div>
      </main>
      {/* G2 (2026-09-04_2): Cmd/Ctrl+K 命令面板 */}
      <CommandPalette />
    </div>
  );
}
