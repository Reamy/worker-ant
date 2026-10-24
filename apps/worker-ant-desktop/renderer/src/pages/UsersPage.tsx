import { useState, useEffect } from 'react';
import { admin, invoke, license as licenseApi } from '../lib/ipc';
import { Users, RefreshCw, Shield, Plus, Key, Link } from 'lucide-react';
import { formatDbTime } from '../lib/deliverable-view';
import { seatText, seatsFull } from '../lib/seat-view';
import type { SeatUsage } from '../../../src/main/core/seat-quota.js';

interface User { id: string; email: string; name: string; role: string; created_at: string; }

const ROLES = ['super_admin', 'admin', 'developer', 'viewer'] as const;

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [seats, setSeats] = useState<SeatUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editRole, setEditRole] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ email:'', password:'', name:'', role:'viewer' });
  const [resetPwUser, setResetPwUser] = useState<User | null>(null);
  const [newPw, setNewPw] = useState('');
  const [inviteLink, setInviteLink] = useState('');

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true);
    try { const d = await admin.users() as unknown as User[]; setUsers(d); } catch {}
    // 席位用量取 main 侧的同一份投影（不在前端数 users.length——删/禁/并发会让两处各说各话）。
    try { const st = await licenseApi.status(); setSeats(st.seats); } catch { setSeats(null); }
    setLoading(false);
  }
  async function handleRoleChange() { if (!editUser) return; try { await invoke('auth:changeRole', { userId: editUser.id, role: editRole }); setEditUser(null); load(); } catch {} }
  async function handleAddUser() { try { await invoke('auth:createUser', addForm); setShowAdd(false); setAddForm({email:'',password:'',name:'',role:'viewer'}); load(); } catch(e) { alert((e as Error).message); } }
  async function handleResetPw() { if (!resetPwUser || !newPw) return; try { await invoke('auth:resetPassword', { userId: resetPwUser.id, newPassword: newPw }); setResetPwUser(null); setNewPw(''); alert('密码已重置'); } catch(e) { alert((e as Error).message); } }
  async function handleInvite() { try { const r = await invoke<{url:string;token:string;expires_at:string}>('auth:invite'); setInviteLink(r.url); } catch(e) { alert((e as Error).message); } }

  const roleBadge = (r: string) => {
    const m: Record<string, string> = { super_admin: 'bg-red-100 text-red-700', admin: 'bg-orange-100 text-orange-700', developer: 'bg-blue-100 text-blue-700', viewer: 'bg-gray-100 text-gray-500' };
    return m[r] || 'bg-gray-100';
  };

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"/></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold">用户管理</h2>
          {/* zx_20261017_1 批五: 席位用量取 `license:status.seats`（与设置页同源，不在前端数 users.length）。 */}
          <span className={`text-xs px-2 py-0.5 rounded-full ${seatsFull(seats) ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{seatText(seats)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4"/></button>
          <button onClick={handleInvite} disabled={seatsFull(seats)} title={seatsFull(seats) ? '席位已满：邀请发出也接不进来，升级档位可增加席位' : undefined} className="flex items-center gap-1 px-3 py-1.5 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"><Link className="w-3.5 h-3.5"/>邀请用户</button>
          <button onClick={()=>setShowAdd(true)} disabled={seatsFull(seats)} title={seatsFull(seats) ? '席位已满：升级档位可增加席位' : undefined} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"><Plus className="w-3.5 h-3.5"/>添加用户</button>
        </div>
      </div>
      {seatsFull(seats) && (
        <p className="mb-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          席位已满：现有 {seats?.used} 位成员不受影响；新建/受邀用户须先升级档位（或移除成员）后才会被接受。
        </p>
      )}
      {inviteLink && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-medium text-green-800">邀请链接已生成（72小时有效）</p>
          <div className="flex items-center gap-2 mt-1">
            <code className="text-xs bg-white px-2 py-1 rounded flex-1 font-mono break-all">{inviteLink}</code>
            <button onClick={() => navigator.clipboard.writeText(inviteLink).then(() => alert('已复制'))} className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700">复制</button>
          </div>
        </div>
      )}
      {users.length===0 ? <p className="text-gray-400 text-center py-12">暂无用户</p> : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr><th className="text-left p-3 font-medium text-gray-500">用户</th><th className="text-left p-3 font-medium text-gray-500">角色</th><th className="text-left p-3 font-medium text-gray-500 hidden md:table-cell">注册时间</th><th className="text-right p-3 font-medium text-gray-500">操作</th></tr></thead>
            <tbody>{users.map(u => (
              <tr key={u.id} className="border-t hover:bg-gray-50">
                <td className="p-3"><p className="font-medium">{u.name||'—'}</p><p className="text-xs text-gray-400">{u.email}</p></td>
                <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadge(u.role)}`}>{u.role}</span></td>
                <td className="p-3 text-gray-400 hidden md:table-cell">{formatDbTime(u.created_at, { dateOnly: true })}</td>
                <td className="p-3 text-right">
                  <button onClick={() => { setEditUser(u); setEditRole(u.role); }} className="p-1.5 hover:bg-blue-50 rounded" title="修改角色"><Shield className="w-4 h-4 text-blue-500"/></button>
                  <button onClick={() => { setResetPwUser(u); setNewPw(''); }} className="p-1.5 hover:bg-orange-50 rounded" title="重置密码"><Key className="w-4 h-4 text-orange-500"/></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {/* 修改角色弹窗 */}
      {editUser && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setEditUser(null)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">修改角色 — {editUser.email}</h3>
            <select value={editRole} onChange={e => setEditRole(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mb-4">{ROLES.map(r => <option key={r} value={r}>{r}</option>)}</select>
            <div className="flex justify-end gap-2"><button onClick={() => setEditUser(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button><button onClick={handleRoleChange} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">保存</button></div>
          </div>
        </div>
      )}

      {/* 添加用户弹窗 */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">添加用户</h3>
            <div className="space-y-3">
              <div><label className="text-sm font-medium">邮箱*</label><input value={addForm.email} onChange={e=>setAddForm({...addForm,email:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1" placeholder="user@example.com"/></div>
              <div><label className="text-sm font-medium">密码*</label><input type="password" value={addForm.password} onChange={e=>setAddForm({...addForm,password:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1" placeholder="最小6位"/></div>
              <div><label className="text-sm font-medium">姓名</label><input value={addForm.name} onChange={e=>setAddForm({...addForm,name:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1"/></div>
              <div><label className="text-sm font-medium">角色</label><select value={addForm.role} onChange={e=>setAddForm({...addForm,role:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm mt-1">{ROLES.map(r=><option key={r} value={r}>{r}</option>)}</select></div>
            </div>
            <div className="flex justify-end gap-2 mt-6"><button onClick={()=>setShowAdd(false)} className="px-4 py-2 border rounded-lg text-sm">取消</button><button onClick={handleAddUser} disabled={!addForm.email||!addForm.password||seatsFull(seats)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">添加</button></div>
          </div>
        </div>
      )}

      {/* 重置密码弹窗 */}
      {resetPwUser && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setResetPwUser(null)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">重置密码 — {resetPwUser.email}</h3>
            <div><label className="text-sm font-medium">新密码</label><input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm mt-1" placeholder="最小6位"/></div>
            <div className="flex justify-end gap-2 mt-6"><button onClick={()=>setResetPwUser(null)} className="px-4 py-2 border rounded-lg text-sm">取消</button><button onClick={handleResetPw} disabled={!newPw} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">重置</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
