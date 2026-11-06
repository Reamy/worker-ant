/**
 * 首启本机所有者的「设置密码」卡片（zx_20261023_4）。
 *
 * 出现条件完全由 main 判定（`auth:localOwnerState`）：库里只有未改密的种子管理员时才显示。
 * 用户设了自己的密码后判据即失效，本卡片在下次挂载时自行消失——渲染层不缓存、不猜。
 *
 * 诚实边界：不设密码不影响使用（本机会持续自动登录）；设置后下次启动需输入新密码，
 * 且本机没有找回入口。这两句都写在卡面上，不藏在注释里。
 */
import { useEffect, useState } from 'react';
import { invoke } from '../lib/ipc';
import { Lock, Check, ShieldCheck } from 'lucide-react';

interface LocalOwnerState { eligible: boolean; email: string }

export default function LocalOwnerPasswordCard() {
  const [owner, setOwner] = useState<LocalOwnerState | null>(null);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<LocalOwnerState>('auth:localOwnerState')
      .then((s) => setOwner(s && typeof s.eligible === 'boolean' ? s : null))
      .catch(() => setOwner(null));
  }, []);

  if (done) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 flex items-center gap-2">
        <Check className="w-4 h-4" /> 密码已设置。下次启动请用新密码登录；请记牢，本机没有找回入口。
      </div>
    );
  }
  if (!owner?.eligible) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 6) { setErr('密码至少 6 位'); return; }
    if (next !== confirm) { setErr('两次输入的密码不一致'); return; }
    setBusy(true); setErr('');
    try {
      await invoke('auth:setLocalOwnerPassword', { newPassword: next });
      setDone(true);
      setNext(''); setConfirm('');
    } catch (e2) {
      setErr((e2 as Error).message || '密码设置失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
      <div className="flex items-center gap-2 text-amber-900 font-medium text-sm">
        <ShieldCheck className="w-4 h-4" /> 已以本机所有者身份自动登录
      </div>
      <p className="text-sm text-amber-900">
        当前账号 <span className="font-mono">{owner.email}</span> 使用初始密码。
        <span className="font-medium">不设置密码也不影响使用</span>——本机会一直自动登录。
      </p>
      <p className="text-xs text-amber-800">设置后下次启动需输入新密码，且本机没有找回入口，请记牢。</p>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">新密码</label>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="至少 6 位"
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">确认新密码</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再输入一次"
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        {err && <p className="text-sm text-red-500">{err}</p>}
        <button type="submit" disabled={busy}
          className="flex items-center gap-1 px-4 py-2 rounded-lg text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50">
          <Lock className="w-3.5 h-3.5" />{busy ? '设置中...' : '设置密码'}
        </button>
      </form>
    </div>
  );
}
