import { useEffect, useMemo, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft } from 'lucide-react';
import { invoke } from '../lib/ipc';
import { useSettings } from '../lib/settingsStore';
import { useDeliverableDrawer } from '../lib/deliverableDrawer';
import { TASK_STATUS_LABEL, PROJECT_STATUS_LABEL, statusText } from '../lib/status-view';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';

/**
 * G2 (2026-09-04_2): 命令面板 Cmd/Ctrl+K —— 键盘直达任意页面（行事之道即时可用，王阳明知行合一）。
 * zx_20260906_2 批4 (4c): 增「对象直达」——输入关键词异步检索 项目/任务/产出物/里程碑(只读 search.global)，
 * 支持按名直达详情；任务项 failed 给 inline「重试」(task:resume 同款恢复)。页面导航 + 对象命中 两段并列展示。
 */
const PAGES: Array<{ to: string; label: string; keywords: string }> = [
  { to: '/', label: '运维看板', keywords: 'dashboard 看板 运维' },
  { to: '/activity', label: '活动中心', keywords: 'activity 活动 事件 时间线' },
  { to: '/projects', label: '项目管理', keywords: 'project 项目' },
  { to: '/tasks', label: '任务管理', keywords: 'task 任务' },
  { to: '/templates', label: '任务模板', keywords: 'template 模板' },
  { to: '/deliverables', label: '产出物', keywords: 'deliverable 产出' },
  { to: '/im', label: 'IM 渠道', keywords: 'im channel 渠道 消息' },
  { to: '/memories', label: '系统记忆', keywords: 'memory 记忆' },
  { to: '/models', label: 'AI 模型', keywords: 'model 模型' },
  { to: '/skills', label: '技能', keywords: 'skill 技能' },
  { to: '/mcp', label: 'MCP 服务', keywords: 'mcp' },
  { to: '/a2a', label: 'A2A 服务', keywords: 'a2a agent' },
  { to: '/api-keys', label: 'API Keys', keywords: 'api key' },
  { to: '/preferences', label: '用户偏好', keywords: 'preference 偏好' },
  { to: '/users', label: '用户管理', keywords: 'user 用户' },
  { to: '/settings', label: '系统设置', keywords: 'settings 设置' },
];

interface ObjResult {
  projects: Array<{ id: string; name: string; status: string }>;
  tasks: Array<{ id: string; project_id: string; title: string; status: string }>;
  deliverables: Array<{ id: string; project_id: string; task_id: string | null; name: string; type: string; status: string }>;
  milestones: Array<{ project_id: string; milestone: string; status: string; implemented_by_task_id: string | null }>;
}
const EMPTY_OBJ: ObjResult = { projects: [], tasks: [], deliverables: [], milestones: [] };


export default function CommandPalette() {
  const navigate = useNavigate();
  // zx_20260909 X1(可直达): 产出物命中开就地抽屉(doc_drawer 门控)
  const settings = useSettings();
  const drawerOn = boolSetting(settings['deliverable.doc_drawer']);
  const { open: openDeliv } = useDeliverableDrawer();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [objs, setObjs] = useState<ObjResult>(EMPTY_OBJ);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 对象检索：q≥1 时 200ms 防抖调 search.global(只读 IPC)
  useEffect(() => {
    const s = q.trim();
    if (!s) { setObjs(EMPTY_OBJ); return; }
    setSearching(true);
    const t = window.setTimeout(() => {
      invoke<{ data?: ObjResult }>('search.global', { q: s })
        .then((r) => setObjs(r?.data ?? EMPTY_OBJ))
        .catch(() => setObjs(EMPTY_OBJ))
        .finally(() => setSearching(false));
    }, 200);
    return () => window.clearTimeout(t);
  }, [q]);

  const navResults = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return PAGES;
    return PAGES.filter((p) => (p.label + ' ' + p.keywords).toLowerCase().includes(s));
  }, [q]);

  const go = (to: string) => { setOpen(false); setQ(''); navigate(to); };
  const openObj = (kind: 'project' | 'task' | 'deliverable' | 'milestone', o: Record<string, unknown>) => {
    setOpen(false); setQ('');
    if (kind === 'project') navigate(`/projects/${String(o.id)}`);
    else if (kind === 'task') navigate(`/tasks/${String(o.id)}`);
    // zx_20260909 X1(就地成果抽屉): 产出物命中先关面板 → 就地开详情抽屉(doc_drawer 门控); 关则回落跳任务页(原行为)
    else if (kind === 'deliverable') {
      if (drawerOn && String(o.id || '')) { openDeliv(String(o.id)); return; }
      const tid = o.task_id ? String(o.task_id) : ''; if (tid) navigate(`/tasks/${tid}`); else navigate('/deliverables');
    }
    else navigate(`/projects/${String(o.project_id)}`);
  };
  const retryTaskObj = async (o: Record<string, unknown>) => {
    try { await invoke('task:resume', { id: String(o.id) }); } catch { /* 恢复失败保持原样 */ return; }
  };

  // 对象命中扁平化(用于回车首选)
  const flatObjs = useMemo(() => {
    const rows: Array<{ kind: 'project' | 'task' | 'deliverable' | 'milestone'; o: Record<string, unknown>; label: string; sub: string }> = [];
    objs.projects.forEach((o) => rows.push({ kind: 'project', o, label: String(o.name || ''), sub: `项目 · ${statusText(PROJECT_STATUS_LABEL, o.status)}` }));
    objs.tasks.forEach((o) => rows.push({ kind: 'task', o, label: String(o.title || ''), sub: `任务 · ${statusText(TASK_STATUS_LABEL, o.status)}` }));
    objs.deliverables.forEach((o) => rows.push({ kind: 'deliverable', o, label: String(o.name || ''), sub: `产出物 · ${String(o.type)} · ${String(o.status)}` }));
    objs.milestones.forEach((o) => rows.push({ kind: 'milestone', o, label: String(o.milestone || ''), sub: '方案里程碑' }));
    return rows;
  }, [objs]);
  const hasObjs = flatObjs.length > 0;

  const onEnter = (e: RKeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const nav = navResults[0];
    const obj = flatObjs[0];
    e.preventDefault();
    if (nav) go(nav.to);
    else if (obj) openObj(obj.kind, obj.o);
  };
  const reset = () => { setOpen(false); setQ(''); };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95] bg-black/25 flex items-start justify-center pt-[16vh]" onClick={reset}>
      <div className="w-[34rem] max-w-[92vw] bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <Search className="w-4 h-4 text-gray-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onEnter} placeholder="跳转页面 / 按名直达项目·任务·产出物…（Esc 关闭）" className="flex-1 text-sm focus:outline-none" />
          <kbd className="text-[10px] text-gray-400 border rounded px-1.5 py-0.5">Ctrl/⌘ K</kbd>
        </div>
        <ul className="max-h-[46vh] overflow-y-auto py-1">
          {!q.trim() ? (
            navResults.map((p) => (
              <li key={p.to}>
                <button type="button" onClick={() => go(p.to)} className="w-full flex items-center justify-between gap-3 px-4 py-2 text-sm text-left hover:bg-blue-50">
                  <span className="text-gray-700">{p.label}</span>
                  <CornerDownLeft className="w-3 h-3 text-gray-300" />
                </button>
              </li>
            ))
          ) : (
            <>
              {navResults.length > 0 && (
                <li><p className="px-4 pt-1.5 pb-1 text-[10px] text-gray-400 font-medium uppercase tracking-wide">页面导航</p>
                  <div className="flex flex-wrap gap-1 px-3 pb-1.5">
                    {navResults.map((p) => (
                      <button key={p.to} type="button" onClick={() => go(p.to)} className="text-xs px-2 py-1 rounded-md bg-gray-100 text-gray-600 hover:bg-blue-100 hover:text-blue-700">{p.label}</button>
                    ))}
                  </div>
                </li>
              )}
              <li>
                <p className="px-4 pt-1.5 pb-1 text-[10px] text-gray-400 font-medium uppercase tracking-wide">直达对象 {searching ? '…' : hasObjs ? `(${flatObjs.length})` : ''}</p>
                {!hasObjs ? (
                  !searching && <p className="px-4 py-4 text-sm text-gray-400 text-center">无匹配对象</p>
                ) : (
                  <div className="pb-1">
                    {flatObjs.map((row, i) => (
                      <div key={`${row.kind}-${i}`} className="flex items-center gap-1 pl-3 pr-2">
                        <button type="button" onClick={() => openObj(row.kind, row.o)} className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1.5 text-left hover:bg-blue-50 rounded-lg">
                          <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded font-medium ${row.kind === 'project' ? 'bg-green-100 text-green-700' : row.kind === 'task' ? 'bg-blue-100 text-blue-700' : row.kind === 'deliverable' ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'}`}>
                            {row.kind === 'project' ? '项目' : row.kind === 'task' ? '任务' : row.kind === 'deliverable' ? '产出' : '里程碑'}
                          </span>
                          <span className="truncate text-sm text-gray-800">{row.label}</span>
                          <span className="truncate text-[10px] text-gray-400 shrink-0">{row.sub}</span>
                        </button>
                        {row.kind === 'task' && String(row.o.status) === 'failed' && (
                          <button type="button" onClick={() => retryTaskObj(row.o)} title="继续执行（保留对话，task:resume）；如需清空重跑请到任务详情用「重试」" className="shrink-0 text-[10px] px-2 py-1 rounded bg-green-50 text-green-700 hover:bg-green-100 font-medium">继续</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
}
