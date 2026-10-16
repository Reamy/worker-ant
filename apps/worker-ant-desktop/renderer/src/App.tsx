import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, Suspense, lazy } from 'react';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
// zx_20260909 X1(就地成果抽屉): 全局轻状态 Provider——任意入口 open(id) 就地展开主要成果详情(版本流/验收/溯源/预览)
import { DeliverableDrawerProvider } from './lib/deliverableDrawer';
import { requestImOutbox } from './lib/uiIntent';
// zx_20261005 M14: 首启判据**按状态**（无项目 ∧ 未真配 ANS），读 main `setup:state`——不再看 localStorage 标志。
// zx_20261011_5: 补一条**会话级**软跳过出口（`isOnboardingSkipped`）——判据不变，只是给"先逛逛"的用户放行一次。
import { needsSetup } from './lib/firstRun';
import { isOnboardingSkipped } from './lib/onboardingSkip';

// 代码分割：页面组件懒加载，减少首屏 JS 体积
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ActivityPage = lazy(() => import('./pages/ActivityPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'));
const IMPage = lazy(() => import('./pages/IMPage'));
const ModelsPage = lazy(() => import('./pages/ModelsPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const DeliverablesPage = lazy(() => import('./pages/DeliverablesPage'));
const SkillsPage = lazy(() => import('./pages/SkillsPage'));
const TemplatesPage = lazy(() => import('./pages/TemplatesPage'));
const McpPage = lazy(() => import('./pages/McpPage'));
const A2aPage = lazy(() => import('./pages/A2aPage'));
const PluginsPage = lazy(() => import('./pages/PluginsPage'));
const MemoriesPage = lazy(() => import('./pages/MemoriesPage'));
// zx_20261004 M4: 协同面板（群蚁共在一屏 + 本机档位配置）
const PeersPage = lazy(() => import('./pages/PeersPage'));
// zx_20261004 M10: 设备面板（局域网设备发现/台账/授权控制）
const DevicesPage = lazy(() => import('./pages/DevicesPage'));
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage'));
const PreferencesPage = lazy(() => import('./pages/PreferencesPage'));
// zx_20261005 M14: 两个向导各归其位——`SetupPage`（真·安装向导，`/onboarding`，阻塞）
//   与 `PreferencesWizardPage`（偏好采集问卷，`/preferences-wizard`，可跳过）。旧 `OnboardingPage` 已更名。
const SetupPage = lazy(() => import('./pages/SetupPage'));
const PreferencesWizardPage = lazy(() => import('./pages/PreferencesWizardPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // zx_20261005 M14: 首启拦人改由**状态**定（`setup:state`）；`null` = 还没答上来，此时先别拦也别放行。
  const [setup, setSetup] = useState<boolean | null>(null);
  // zx_20261011_5: 会话级软跳过——挂载时取一次（跳过后必 `navigate` 到受保护路由 ⇒ 本组件重挂载，届时读到新值）。
  const [dismissed] = useState<boolean>(() => isOnboardingSkipped());

  useEffect(() => {
    checkAuth();
    needsSetup().then(setSetup).catch(() => setSetup(false));
  }, []);

  async function checkAuth() {
    try {
      if (window.electronAPI?.isElectron) {
        const token = await window.electronAPI.getToken();
        if (token) {
          // 判断 access token 是否过期（JWT payload 是 base64url，需先还原再 atob）
          const expired = (() => {
            try {
              const parts = token.split('.');
              if (parts.length !== 3) return true;
              const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
              const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
              const payload = JSON.parse(atob(padded));
              return payload.exp * 1000 <= Date.now();
            } catch {
              return true; // 解码失败视为无效
            }
          })();
          if (!expired) {
            setAuthed(true);
            return;
          }
          // access token 过期/无效：用 refresh token 静默刷新（refresh 7 天有效）
          const refreshToken = await window.electronAPI.getRefreshToken();
          if (refreshToken) {
            try {
              const res = (await window.electronAPI.invoke('auth:refresh', { refreshToken })) as {
                data?: { accessToken: string; refreshToken: string };
                error?: { code: string };
              };
              if (res?.data?.accessToken) {
                await window.electronAPI.setToken(res.data.accessToken);
                if (res.data.refreshToken) await window.electronAPI.setRefreshToken(res.data.refreshToken);
                setAuthed(true);
                return;
              }
            } catch { /* 刷新失败，落到登录页 */ }
          }
        }
      } else {
        const token = localStorage.getItem('token');
        if (token) { setAuthed(true); return; }
      }
      setAuthed(false);
    } catch {
      setAuthed(false);
    }
  }

  if (authed === null || setup === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-gray-500 text-sm">工蚁系统启动中...</p>
        </div>
      </div>
    );
  }

  if (!authed) return <Navigate to="/login" replace />;
  // zx_20261005 M14: 首启引导**按状态**（既无项目、又未真配 ANS ⇒ 弹安装向导），
  //   不再是那个"点过没点过按钮"的 localStorage 布尔标志（它拦不准真新用户）。
  // zx_20261011_5: 会话级软跳过（`dismissed`）——判据**不变**，只是给"先进去看看"的用户放行一次（刷新即复位）。
  if (setup && !dismissed && window.location.hash !== '#/onboarding') return <Navigate to="/onboarding" replace />;
  return <AppLayout>{children}</AppLayout>;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  // A2: 原生通知点击 → 跳转对应任务详情
  // zx_20260912 M2-3: 同一通道兼作托盘「IM 未读 N 条 →」跳转（type='im.navigate'）——不新建托盘框架。
  // zx_20260912 M3: 同通道再兼「出站未送达 N 条 →」（type='im.outbox'）——先落意图再跳，IM 页挂载时展开明细。
  useEffect(() => {
    if (!window.electronAPI?.isElectron || typeof window.electronAPI.onTaskFocus !== 'function') return;
    return window.electronAPI.onTaskFocus(({ type, taskId }) => {
      if (type === 'im.navigate') { navigate('/im'); return; }
      if (type === 'im.outbox') { requestImOutbox(); navigate('/im'); return; }
      if (taskId) navigate(`/tasks/${taskId}`);
    });
  }, [navigate]);

  // A2: 上报当前路由任务焦点（主进程用于原生通知「正在看该任务则不弹」）
  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;
    const m = location.pathname.match(/^\/tasks\/([^/]+)/);
    window.electronAPI.invoke('ui:taskFocus', { taskId: m ? m[1] : null }).catch(() => {});
  }, [location.pathname]);

  // 桌面端：监听 OAuth 回调完成登录
  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;
    window.electronAPI.onOAuthCallback(async ({ token, refreshToken }) => {
      await window.electronAPI!.setToken(token);
      if (refreshToken) await window.electronAPI!.setRefreshToken(refreshToken);
      window.location.hash = '#/';
      window.location.reload();
    });
  }, []);

  return (
    <DeliverableDrawerProvider>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          <Route path="/activity" element={<ProtectedRoute><ActivityPage /></ProtectedRoute>} />
          <Route path="/projects" element={<ProtectedRoute><ProjectsPage /></ProtectedRoute>} />
          <Route path="/tasks" element={<ProtectedRoute><TasksPage /></ProtectedRoute>} />
          <Route path="/tasks/:id" element={<ProtectedRoute><TaskDetailPage /></ProtectedRoute>} />
          <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetailPage /></ProtectedRoute>} />
          <Route path="/im" element={<ProtectedRoute><IMPage /></ProtectedRoute>} />
          <Route path="/models" element={<ProtectedRoute><ModelsPage /></ProtectedRoute>} />
          <Route path="/users" element={<ProtectedRoute><UsersPage /></ProtectedRoute>} />
          <Route path="/deliverables" element={<ProtectedRoute><DeliverablesPage /></ProtectedRoute>} />
          <Route path="/skills" element={<ProtectedRoute><SkillsPage /></ProtectedRoute>} />
          <Route path="/templates" element={<ProtectedRoute><TemplatesPage /></ProtectedRoute>} />
          <Route path="/mcp" element={<ProtectedRoute><McpPage /></ProtectedRoute>} />
          <Route path="/a2a" element={<ProtectedRoute><A2aPage /></ProtectedRoute>} />
          <Route path="/plugins" element={<ProtectedRoute><PluginsPage /></ProtectedRoute>} />
          <Route path="/memories" element={<ProtectedRoute><MemoriesPage /></ProtectedRoute>} />
          <Route path="/peers" element={<ProtectedRoute><PeersPage /></ProtectedRoute>} />
          <Route path="/devices" element={<ProtectedRoute><DevicesPage /></ProtectedRoute>} />
          <Route path="/api-keys" element={<ProtectedRoute><ApiKeysPage /></ProtectedRoute>} />
          <Route path="/preferences" element={<ProtectedRoute><PreferencesPage /></ProtectedRoute>} />
          {/* zx_20261005 M14: `/onboarding` = **真·安装向导**（阻塞）；偏好问卷迁至 `/preferences-wizard`（可跳过）。 */}
          <Route path="/onboarding" element={<SetupPage />} />
          <Route path="/preferences-wizard" element={<PreferencesWizardPage />} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        </Routes>
      </Suspense>
    </DeliverableDrawerProvider>
  );
}
