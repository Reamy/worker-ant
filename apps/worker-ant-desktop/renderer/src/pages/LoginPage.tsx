import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../lib/ipc';
import brandLogo from '../assets/worker-ant-logo.png';

const REMEMBER_KEY = 'wa_remembered_credentials';

function loadCredentials(): { email: string; password: string } | null {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (raw) {
      // 简单base64编码存储（桌面端单用户场景，安全即可）
      const decoded = atob(raw);
      return JSON.parse(decoded);
    }
  } catch {}
  return null;
}

function saveCredentials(email: string, password: string) {
  try {
    const encoded = btoa(JSON.stringify({ email, password }));
    localStorage.setItem(REMEMBER_KEY, encoded);
  } catch {}
}

function clearCredentials() {
  localStorage.removeItem(REMEMBER_KEY);
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(false);

  // 页面加载时自动填充记住的账号密码
  useEffect(() => {
    const saved = loadCredentials();
    if (saved) {
      setEmail(saved.email);
      setPassword(saved.password);
      setRemember(true);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'register') {
        const result = await auth.register(email, password, name || email.split('@')[0]!);
        await window.electronAPI?.setToken(result.accessToken);
        await window.electronAPI?.setRefreshToken(result.refreshToken);
      } else {
        const result = await auth.login(email, password);
        await window.electronAPI?.setToken(result.accessToken);
        await window.electronAPI?.setRefreshToken(result.refreshToken);
        // 记住账号密码
        if (remember) {
          saveCredentials(email, password);
        } else {
          clearCredentials();
        }
      }
      navigate('/');
    } catch (err) {
      setError((err as Error).message || (mode === 'login' ? '登录失败' : '注册失败'));
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = (provider: string) => {
    if (window.electronAPI?.isElectron) {
      window.electronAPI.openOAuth(provider);
    } else {
      setError('桌面端 OAuth 仅在 Electron 环境中可用');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border p-8 space-y-6">
        <div className="text-center">
          <img src={brandLogo} alt="工蚁" className="mx-auto h-16 w-16 rounded-xl" />
          <h1 className="mt-3 text-2xl font-bold">工蚁系统</h1>
          <p className="text-gray-500 mt-1">Worker Ant Desktop {mode === 'register' ? '· 注册' : '· 登录'}</p>
        </div>

        {/* OAuth 登录 */}
        <div className="space-y-2">
          <button onClick={() => handleOAuth('github')} className="w-full flex items-center justify-center gap-2 py-2 px-4 border rounded-lg text-sm hover:bg-gray-50 transition-colors">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            GitHub 登录
          </button>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
          <div className="relative flex justify-center text-xs"><span className="bg-white px-2 text-gray-400">或使用邮箱</span></div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium mb-1">昵称</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="你的昵称" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">邮箱</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder={mode === 'login' ? 'admin@worker-ant.local' : 'your@email.com'} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">密码</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="••••••" />
          </div>

          {mode === 'login' && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span className="text-sm text-gray-500">记住账号密码</span>
            </label>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" disabled={loading} className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {loading ? '处理中...' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500">
          {mode === 'login' ? '没有账号？' : '已有账号？'}
          <button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }} className="text-blue-600 hover:underline ml-1">
            {mode === 'login' ? '立即注册' : '去登录'}
          </button>
        </p>
      </div>
    </div>
  );
}
