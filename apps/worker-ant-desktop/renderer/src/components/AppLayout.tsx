import { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LogOut, BellRing } from 'lucide-react';
// zx_20261013_1 批三: 导航表提为**一处真源**（`lib/navConfig`）——侧栏与首启导览消费同一个数组，
//   不再各自持有入口清单（导览词表由此派生，见 `tourEntries()`）。
import { NAV_GROUPS } from '../lib/navConfig';
import brandLogo from '../assets/worker-ant-logo.png';
import { approvalApi, im, license } from '../lib/ipc';
import { useActivity } from '../lib/activity';
// zx_20261104_3 M3: 授权台角标——与 `/inbox` 页同一份取数（`approval:inbox`）与同一份保鲜词表。
import { useLiveQuery } from '../lib/useLiveQuery';
import { APPROVAL_LIVE_TYPES, APPROVAL_POLL_MS } from '../lib/approval-live';
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
  // 侧栏版本号**不写死**：走 `app:version`（main 侧 `app.getVersion()` 唯一真源），
  //   写死的字面量每次发版就过期（0.2.0 就曾把首启崩溃版显示成"已更新"的样子）。
  const [appVersion, setAppVersion] = useState('');
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
      license.appVersion().then(setAppVersion).catch(() => { /* 通道未注册时留空 */ });
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
  // zx_20261104_3 M3: 授权台角标——数由 `approval:inbox` 一处派生（页面与角标不分家）；
  //   事件驱动刷新 + 15s 兜底（与 `/inbox` 页同引 `approval-live` 的常量）。
  const inbox = useLiveQuery(() => approvalApi.inbox(), [], { liveTypes: APPROVAL_LIVE_TYPES, debounceMs: 700 });
  useEffect(() => {
    const t = window.setInterval(() => { void inbox.reload(); }, APPROVAL_POLL_MS);
    return () => window.clearInterval(t);
  }, [inbox.reload]);
  const inboxCount = inbox.data?.counts.total ?? 0;
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
      {/* zx_20261121_3 M5-c「墨与纸」：侧栏墨面、当前项纸色文字 + 2px 朱砂左棱（不用整块蓝底）。 */}
      <aside className="w-56 bg-sidebar text-sidebar-ink flex flex-col shrink-0">
        <div className="p-4 border-b border-sidebar-ink/10">
          <h1 className="flex items-center gap-2 font-display text-lg font-semibold tracking-wide">
            <img src={brandLogo} alt="" className="h-7 w-7 rounded-control" />
            工蚁系统
          </h1>
          <p className="text-xs text-sidebar-ink/55 mt-0.5">Worker Ant Desktop</p>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {NAV_GROUPS.map(group => (
            <div key={group.label} className="mb-4">
              <p className="pl-3.5 pr-3 mb-1.5 font-display text-[10px] font-medium tracking-[0.18em] text-sidebar-ink/40 uppercase">{group.label}</p>
              {group.items.map(({ to, icon: Icon, label }) => (
                <NavLink key={to} to={to} end={to === '/'} data-tour={to}
                  className={({ isActive }) => `flex items-center gap-3 border-l-2 px-3 py-1.5 text-sm transition-colors ${isActive ? 'border-cinnabar bg-sidebar-ink/5 text-sidebar-ink font-medium' : 'border-transparent text-sidebar-ink/70 hover:bg-sidebar-ink/5 hover:text-sidebar-ink'}`}>
                  <Icon className="w-4 h-4" />{label}
                  {/* zx_20260914 M1-3: IM 未读红点——数与托盘角标同源（都来自 main 那一次计算），
                      这里不自增、不自减；上限 99+ 只是显示收敛，不改真值。 */}
                  {to === '/im' && imUnread > 0 && (
                    <span className="ml-auto min-w-[18px] px-1 rounded-full bg-cinnabar text-paper text-[10px] leading-[18px] text-center tnum" title={`${imUnread} 条未读消息`}>
                      {imUnread > 99 ? '99+' : imUnread}
                    </span>
                  )}
                  {/* zx_20261104_3 M3: 待办角标（三类合计；数来自 approval:inbox，不在此自算）。 */}
                  {to === '/inbox' && inboxCount > 0 && (
                    <span className="ml-auto min-w-[18px] px-1 rounded-full bg-sidebar-ink/15 text-sidebar-ink text-[10px] leading-[18px] text-center tnum" title={`${inboxCount} 件授权待办（知识待办见待办页）`}>
                      {inboxCount > 99 ? '99+' : inboxCount}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-sidebar-ink/10 space-y-2">
          {user.email && <p className="text-xs text-sidebar-ink/55 truncate">{user.email}{user.role && <span className="ml-1 text-sidebar-ink/35">({user.role})</span>}</p>}
          <button onClick={handleLogout} className="flex items-center gap-2 text-xs text-sidebar-ink/55 hover:text-sidebar-ink transition-colors w-full"><LogOut className="w-3 h-3" />退出登录</button>
          {appVersion && <p className="text-xs text-sidebar-ink/30 tnum">v{appVersion}</p>}
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        {/* A3: 全局顶栏（通知中心入口 + 未来全局动作）——纸面 + 1px 线 */}
        <header className="h-12 shrink-0 bg-paper border-b border-line flex items-center justify-end px-4 gap-1 z-20">
          <ActionNeeded />
          <NotificationBell />
        </header>
        <div className="flex-1 overflow-auto p-6 lg:p-8">
          {/* zx_20260908 D1/D4: 全局执行在场条（任意页可见，含无推进反色） */}
          <PresenceBar />
          {prospective && (
            <div className="mb-3 flex items-start gap-2 rounded-card border border-accent/20 bg-accent-soft p-3 text-sm shadow-card">
              <BellRing className="w-4 h-4 text-accent mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-accent">前瞻记忆·到期提醒</p>
                <button type="button" onClick={() => { if (prospective.projectId) navigate(`/projects/${prospective.projectId}`); else navigate('/memories'); setProspective(null); }} className="text-left text-ink hover:text-accent hover:underline break-words transition-colors" title="点击定位">“{prospective.content}”</button>
              </div>
              <button type="button" onClick={() => setProspective(null)} className="text-accent/70 hover:text-accent text-xs transition-colors">✕</button>
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
