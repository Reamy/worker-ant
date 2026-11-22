import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, Check, Clock, Download, Plus, RefreshCw, Save, Send, Trash2, Upload, X } from 'lucide-react';
import {
  invoke,
  positions as positionsIpc,
  positionRoutines as routinesIpc,
  tasks as tasksIpc,
  type PositionDetail,
  type PositionListRow,
  type PositionProfile,
  type PositionWriteBody,
  type RoutineBoard,
  type RoutineListRow,
  type RoutineSuggestion,
  type PositionSkill,
} from '../lib/ipc';
// zx_20261120_3 M4/M6：技能状态词表（纯模块，不进主进程链）。
import { POSITION_SKILL_STATUS_LABEL } from '../../../src/main/core/position-skill-meta.js';
// zx_20261113_1 B4「晋」: 晋升目标与来源词表取 main 侧同一份（不在页面手抄第二套中文名）。
import {
  POSITION_LESSON_SOURCE_LABEL,
  POSITION_PROMOTE_TARGET_LABEL,
  type PositionLessonPromoteTarget,
} from '../../../src/main/core/positions.js';
import { routineSkipLabel, routineStatusLabel } from '../lib/routine-view';
// zx_20261121_3 M5：页头 / 按钮 / 三态统一走共用原语（一处形状），逻辑与文案保持原样。
import { PageHeader, Button, EmptyState, ErrorState, Skeleton } from '../components/ui';

interface FormState {
  name: string;
  category: string;
  description: string;
  rules: string;
  skills: string;
  knowledge: string;
  /** zx_20261115_1 M1：工具白名单（每行一个工具名；空＝沿用任务形态默认面）。 */
  tools: string;
  /** MCP 白名单（每行一个名称；空＝项目全部可用）。 */
  mcp: string;
  /** 沙箱档：空＝继承项目；只能调严。 */
  sandboxScope: '' | 'strict' | 'workspace' | 'off';
  /** 参与跨机派单。 */
  participate: boolean;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  category: 'custom',
  description: '',
  rules: '',
  skills: '',
  knowledge: '',
  tools: '',
  mcp: '',
  sandboxScope: '',
  participate: true,
  enabled: true,
};

function splitLines(raw: string): string[] {
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

function toBody(f: FormState): PositionWriteBody {
  return {
    name: f.name.trim(),
    category: f.category.trim(),
    description: f.description.trim(),
    rules: splitLines(f.rules),
    skills: splitLines(f.skills),
    knowledge: splitLines(f.knowledge),
    tools: splitLines(f.tools),
    mcp: splitLines(f.mcp),
    sandboxScope: f.sandboxScope,
    participate: f.participate,
    enabled: f.enabled,
  };
}

function formOf(d: PositionDetail): FormState {
  const p = d.position;
  return {
    name: p.name,
    category: p.category,
    description: p.description,
    rules: p.rules.join('\n'),
    skills: p.skills.join('\n'),
    knowledge: p.knowledge.join('\n'),
    tools: p.tools.join('\n'),
    mcp: p.mcp.join('\n'),
    sandboxScope: p.sandboxScope,
    participate: p.participate,
    enabled: p.enabled,
  };
}

const inputCls = 'w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent';


export default function PositionsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<PositionListRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<PositionDetail | null>(null);
  // zx_20261113_1 B5「像」: 岗位画像（只读派生；读不到如实说，不挡详情）。
  const [profile, setProfile] = useState<PositionProfile | null>(null);
  const [profileError, setProfileError] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);
  // zx_20261112_1 B2「任」: 派活——岗位固定（不可改），项目只在**该岗位已启用的未归档项目**里选。
  // zx_20261113_2 M17：经验编辑（缩短后再晋升）。
  const [editingLesson, setEditingLesson] = useState<{ id: string; content: string } | null>(null);
  const [showDispatch, setShowDispatch] = useState(false);
  const [dispatchForm, setDispatchForm] = useState({ projectId: '', title: '', description: '', acceptance: '' });
  const [dispatching, setDispatching] = useState(false);
  // zx_20261120_1 M3：例行（到点该做的那件事）+ 建议（只读）+ 绩效看板。
  const [routines, setRoutines] = useState<RoutineListRow[]>([]);
  const [routineSuggestions, setRoutineSuggestions] = useState<RoutineSuggestion[]>([]);
  const [routineBoardData, setRoutineBoardData] = useState<RoutineBoard | null>(null);
  const [routineError, setRoutineError] = useState('');
  const [showRoutine, setShowRoutine] = useState(false);
  const [routineForm, setRoutineForm] = useState({ projectId: '', name: '', cron: '0 9 * * 1', title: '', description: '', acceptance: '' });
  const [routineSaving, setRoutineSaving] = useState(false);
  // 例行完成是否也推 IM（缺省不推，只失败推；开关有读写口，承「承诺开关须有 GUI 口」）。
  const [routineNotify, setRoutineNotify] = useState(false);
  // zx_20261120_3 M6「积·账」：能力页签——可调用技能 + 经验生命周期。
  const [detailTab, setDetailTab] = useState<'overview' | 'skills'>('overview');
  const [skills, setSkills] = useState<PositionSkill[]>([]);
  const [skillError, setSkillError] = useState('');
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: '', description: '', steps: '' });

  useEffect(() => {
    void loadList();
    void invoke<{ data?: Record<string, string> }>('settings:getAll')
      .then((res) => setRoutineNotify(res?.data?.['routine.notify_on_success'] === '1'))
      .catch(() => { /* 读不到按缺省（不推） */ });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
  }, [selectedId]);

  async function loadList(preferId?: string) {
    setLoading(true);
    setError('');
    try {
      const r = await positionsIpc.list();
      setRows(r.positions);
      const next = preferId || selectedId || r.positions[0]?.id || '';
      if (next !== selectedId) setSelectedId(next);
      else if (next) await loadDetail(next);
      if (r.positions.length === 0) setDetail(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }

  async function loadDetail(id: string) {
    try {
      const d = await positionsIpc.get(id);
      setDetail(d);
      setForm(formOf(d));
      // 画像与详情分开取：画像读失败只影响画像卡，不把岗位详情整页打空。
      try {
        setProfile(await positionsIpc.profile(id));
        setProfileError('');
      } catch (e) {
        setProfile(null);
        setProfileError((e as Error).message);
      }
      // 技能账与详情分开取：读失败只影响「能力」页签。
      try {
        const sk = await positionsIpc.skills(id);
        setSkills(sk.skills);
        setSkillError('');
      } catch (e) {
        setSkills([]);
        setSkillError((e as Error).message);
      }
      void loadRoutines(id, d.projects.filter((p) => p.enabled).map((p) => p.id));
    } catch (e) {
      setError((e as Error).message);
      setDetail(null);
      setProfile(null);
    }
  }

  async function save() {
    if (!detail) return;
    if (!form.name.trim()) {
      setError('岗位名称不能为空');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.update(detail.position.id, toBody(form));
      setDetail({ ...detail, position: r.position });
      setForm(formOf({ ...detail, position: r.position }));
      setNotice('已保存');
      await loadList(r.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  }

  async function toggle(p: PositionListRow) {
    setError('');
    try {
      await positionsIpc.toggle(p.id, !p.enabled);
      await loadList(p.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(p: PositionListRow) {
    if (!confirm(`确定删除岗位「${p.name}」？已确认的经验会保留，项目绑定将解除。`)) return;
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.remove(p.id);
      setNotice(`已删除：解除 ${r.unboundProjects} 个项目绑定，保留 ${r.keptLessons} 条经验`);
      setSelectedId('');
      setDetail(null);
      await loadList('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleProject(projectId: string, enabled: boolean) {
    if (!detail) return;
    setError('');
    try {
      const r = await positionsIpc.projectToggle(detail.position.id, projectId, enabled);
      setDetail({ ...detail, projects: r.projects });
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function decideLesson(id: string, decision: 'accepted' | 'rejected') {
    if (!detail) return;
    setError('');
    try {
      await positionsIpc.decideLesson(id, decision);
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function promoteLesson(id: string, target: PositionLessonPromoteTarget) {
    if (!detail) return;
    setError('');
    setNotice('');
    try {
      await positionsIpc.promoteLesson(id, target);
      setNotice(`已晋升到「${POSITION_PROMOTE_TARGET_LABEL[target]}」——晋升后不再作为经验重复注入。`);
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // zx_20261113_2 M17：保存经验编辑；晋升上限 200 字由 core 晋升口再判一次。
  async function saveLessonEdit() {
    if (!editingLesson || !detail) return;
    setError('');
    setNotice('');
    try {
      await positionsIpc.updateLesson(editingLesson.id, editingLesson.content);
      setNotice('经验已更新。');
      setEditingLesson(null);
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function unpromoteLesson(id: string) {
    if (!detail) return;
    setError('');
    setNotice('');
    try {
      await positionsIpc.unpromoteLesson(id);
      setNotice('已撤回晋升——该经验恢复为可注入经验。');
      await loadDetail(detail.position.id);
      await loadList(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // zx_20261120_3 M6：能力页签动作（草案/审批/生命周期）。
  async function createSkill() {
    if (!detail) return;
    setSkillSaving(true); setSkillError(''); setNotice('');
    try {
      const steps = skillForm.steps.split('\n').map((s) => s.trim()).filter(Boolean);
      await positionsIpc.skillCreate({
        positionId: detail.position.id,
        name: skillForm.name.trim(),
        description: skillForm.description.trim(),
        steps,
      });
      setNotice(`技能草案「${skillForm.name.trim()}」已创建——批准后才可被任务调用。`);
      setSkillForm({ name: '', description: '', steps: '' });
      await loadDetail(detail.position.id);
    } catch (e) {
      setSkillError((e as Error).message);
    }
    setSkillSaving(false);
  }

  async function decideSkill(id: string, decision: 'approved' | 'rejected') {
    if (!detail) return;
    setSkillError(''); setNotice('');
    try {
      await positionsIpc.skillDecide(id, decision);
      setNotice(decision === 'approved' ? '技能已批准——该岗位的任务可在 list_skills 看到并调用。' : '技能已拒绝。');
      await loadDetail(detail.position.id);
    } catch (e) {
      setSkillError((e as Error).message);
    }
  }

  async function lessonLifecycle(id: string, action: 'applies' | 'verify' | 'retire' | 'unretire' | 'supersede' | 'unsupersede', extra: { appliesTo?: string; reason?: string; byId?: string } = {}) {
    if (!detail) return;
    setError(''); setNotice('');
    try {
      await positionsIpc.lessonLifecycle({ id, action, ...extra });
      setNotice('经验生命周期已更新。');
      await loadDetail(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addLessonAsSkill(l: { id: string; content: string }) {
    if (!detail) return;
    const name = window.prompt('技能名（≤40 字，可用英文/中文）', '')?.trim();
    if (!name) return;
    setSkillSaving(true); setSkillError('');
    try {
      await positionsIpc.skillCreate({
        positionId: detail.position.id,
        name,
        description: `来自已采纳经验：${l.content.slice(0, 120)}`,
        steps: [l.content],
        sourceLessonId: l.id,
      });
      setNotice(`已从经验沉淀技能草案「${name}」——批准后才可调用。`);
      await loadDetail(detail.position.id);
      setDetailTab('skills');
    } catch (e) {
      setSkillError((e as Error).message);
    }
    setSkillSaving(false);
  }

  async function exportPack() {
    if (!detail) return;
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.exportPackage(detail.position.id);
      if (r.cancelled) return;
      setNotice(`已导出 ${r.lessons ?? 0} 条已采纳经验到 ${r.path ?? ''}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importPack(mode: 'merge' | 'replace') {
    if (mode === 'replace' && !window.confirm('覆盖导入会用知识包里的四段替换同名岗位的现有内容（经验仍只追加候选）。确定继续？')) return;
    setError('');
    setNotice('');
    try {
      const r = await positionsIpc.importPackage(mode);
      if (r.cancelled) return;
      setNotice(`已导入：条目新增 ${r.addedSections ?? 0} · 经验新增 ${r.addedLessons ?? 0}（跳过 ${r.skippedLessons ?? 0}）——导入经验为待审候选，采纳后才注入。`);
      if (r.position?.id) {
        setSelectedId(r.position.id);
        await loadList(r.position.id);
        await loadDetail(r.position.id);
      } else {
        await loadList();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function create() {
    if (!createForm.name.trim()) {
      setError('岗位名称不能为空');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await positionsIpc.create(toBody(createForm));
      setShowCreate(false);
      setCreateForm(EMPTY_FORM);
      await loadList(r.position.id);
      setSelectedId(r.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  }

  // 可派活的项目 = 未归档（listPositionProjects 已在 SQL 里滤掉）∧ 该岗位已启用。
  const dispatchProjects = detail ? detail.projects.filter((p) => p.enabled) : [];

  function openDispatch() {
    setError('');
    setDispatchForm({ projectId: dispatchProjects[0]?.id ?? '', title: '', description: '', acceptance: '' });
    setShowDispatch(true);
  }

  async function submitDispatch() {
    if (!detail) return;
    const title = dispatchForm.title.trim();
    if (!dispatchForm.projectId) { setError('请选择项目'); return; }
    if (!title) { setError('任务标题不能为空'); return; }
    setDispatching(true);
    setError('');
    try {
      const r = await tasksIpc.create(
        dispatchForm.projectId, title, dispatchForm.description.trim(), 0,
        dispatchForm.acceptance.trim(), undefined, undefined, undefined, undefined,
        detail.position.id,
      );
      const newId = String((r as { id?: unknown }).id ?? '');
      setShowDispatch(false);
      if (newId) navigate(`/tasks/${newId}`);
      else await loadDetail(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
    setDispatching(false);
  }

  async function loadRoutines(positionId: string, projectIds: string[]) {
    setRoutineError('');
    try {
      const r = await routinesIpc.list({ positionId });
      setRoutines(r.routines);
    } catch (e) {
      setRoutines([]);
      setRoutineError(`例行加载失败：${(e as Error).message}`);
    }
    try {
      setRoutineBoardData(await routinesIpc.board(positionId));
    } catch {
      setRoutineBoardData(null);
    }
    try {
      const groups = await Promise.all(projectIds.map((pid) => routinesIpc.suggestions(positionId, pid)));
      setRoutineSuggestions(groups.flatMap((g) => g.suggestions ?? []));
    } catch {
      setRoutineSuggestions([]);
    }
  }

  function openRoutine(seed?: Partial<{ projectId: string; name: string; title: string; description: string; acceptance: string; cron: string }>) {
    setRoutineForm({
      projectId: seed?.projectId ?? dispatchProjects[0]?.id ?? '',
      name: seed?.name ?? '',
      cron: seed?.cron ?? '0 9 * * 1',
      title: seed?.title ?? '',
      description: seed?.description ?? '',
      acceptance: seed?.acceptance ?? '',
    });
    setShowRoutine(true);
  }

  async function submitRoutine() {
    if (!detail) return;
    if (!routineForm.projectId) { setError('请选择项目'); return; }
    if (!routineForm.name.trim()) { setError('例行名称不能为空'); return; }
    if (!routineForm.title.trim()) { setError('任务标题不能为空'); return; }
    if (!routineForm.cron.trim()) { setError('cron 表达式不能为空'); return; }
    setRoutineSaving(true);
    setError('');
    try {
      await routinesIpc.create({
        position_id: detail.position.id,
        project_id: routineForm.projectId,
        name: routineForm.name.trim(),
        cron: routineForm.cron.trim(),
        title: routineForm.title.trim(),
        description: routineForm.description.trim(),
        acceptance_criteria: routineForm.acceptance.trim(),
      });
      setShowRoutine(false);
      setNotice('例行已创建——到点会自动建单；也可点「立刻跑一次」先试。');
      await loadDetail(detail.position.id);
    } catch (e) {
      setError((e as Error).message);
    }
    setRoutineSaving(false);
  }

  async function toggleRoutine(r: RoutineListRow) {
    try {
      await routinesIpc.update(r.id, { enabled: !(r.enabled === 1) });
      if (detail) await loadRoutines(detail.position.id, dispatchProjects.map((p) => p.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeRoutine(r: RoutineListRow) {
    if (!confirm(`删除例行「${r.name}」？历史任务与运行记录会保留。`)) return;
    try {
      await routinesIpc.remove(r.id);
      setNotice('例行已删除（历史任务保留）。');
      if (detail) await loadRoutines(detail.position.id, dispatchProjects.map((p) => p.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleRoutineNotify(next: boolean) {
    setRoutineNotify(next); // 乐观写；失败回滚（界面诚实）
    try {
      await invoke('settings:set', 'routine.notify_on_success', next ? '1' : '0');
    } catch (e) {
      setRoutineNotify(!next);
      setError(`开关保存失败：${(e as Error).message}`);
    }
  }

  async function runRoutineNow(r: RoutineListRow) {
    try {
      const res = await routinesIpc.runNow(r.id);
      if (res.ok) {
        setNotice(`已建单：${res.taskId.slice(0, 8)}（去任务页查看）`);
        if (res.taskId) navigate(`/tasks/${res.taskId}`);
      } else {
        setError(`未跑：${routineSkipLabel(res.skipped) || res.reason}`);
      }
      if (detail) await loadRoutines(detail.position.id, dispatchProjects.map((p) => p.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // zx_20261121_3 M5：首屏三态同形（载入骨架 / 读失败可重试 / 空态给出口），读不到不冒充"没有岗位"。
  const loadingFirst = loading && rows.length === 0;
  const enabledCount = rows.filter((p) => p.enabled).length;
  const pendingLessonTotal = rows.reduce((n, p) => n + (p.pendingLessons || 0), 0);
  // 一句主张只用页面已有事实（岗位数 / 启用数 / 待确认经验数），不编数字。
  const positionClaim = loadingFirst
    ? '正在读取岗位列表。'
    : error && rows.length === 0
      ? '岗位列表读取失败，可在下方重试。'
      : rows.length === 0
        ? '还没有岗位——新建后可指派任务。'
        : `共 ${rows.length} 个岗位，${enabledCount} 个启用${pendingLessonTotal > 0 ? `，${pendingLessonTotal} 条经验待确认` : ''}。`;

  const header = (
    <PageHeader
      eyebrow="项目管理"
      title="岗位"
      claim={positionClaim}
      actions={<Button variant="ghost" size="sm" aria-label="刷新岗位列表" title="刷新" icon={<RefreshCw className="w-4 h-4" />} onClick={() => void loadList()} />}
      primaryAction={
        <Button variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setCreateForm(EMPTY_FORM); setShowCreate(true); }}>新建岗位</Button>
      }
    />
  );

  if (loadingFirst) {
    return (
      <div>
        {header}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
          <div className="lg:col-span-2"><Skeleton className="h-72 w-full" /></div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}

      {/* zx_20261121_3 M5：读失败走 ErrorState（原文原因 + 重试）；有列表时的失败是操作失败，分开说。 */}
      {error && rows.length === 0 && <div className="mb-3"><ErrorState title="岗位列表读取失败" reason={error} onRetry={() => void loadList()} /></div>}
      {error && rows.length > 0 && <div className="mb-3"><ErrorState title="操作失败" reason={error} /></div>}
      {notice && <p className="text-green-600 text-sm mb-3">{notice}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-2">
          {rows.length === 0 && !error && (
            <EmptyState
              compact
              icon={<Briefcase className="w-8 h-8" />}
              title="暂无岗位"
              description="长期在岗的知识载体：说明 / 规范 / 技能 / 知识四段常驻，任务可指派，收口经验需人工确认。"
            />
          )}
          {rows.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`w-full text-left bg-white rounded-lg border p-3 hover:border-accent/30 ${selectedId === p.id ? 'border-accent ring-1 ring-accent/25' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-accent flex-shrink-0" />
                <span className="font-medium text-sm truncate">{p.name}</span>
                {p.builtin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">内置</span>}
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${p.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{p.enabled ? '启用' : '停用'}</span>
              </div>
              <div className="tnum flex items-center gap-2 mt-1 text-[11px] text-gray-500">
                <span>绑定 {p.projectCount} 个项目</span>
                {p.pendingLessons > 0 && <span className="text-amber-600">待确认经验 {p.pendingLessons}</span>}
              </div>
            </button>
          ))}
        </div>

        <div className="lg:col-span-2">
          {!detail ? (
            <EmptyState title="选择左侧岗位查看详情" />
          ) : (
            <>
            {/* zx_20261120_3 M6「能力」页签：本机积累全档可用；带走/共享是 Pro/Team 的另一道闸。 */}
            <div className="flex items-center gap-1 mb-2">
              <button onClick={() => setDetailTab('overview')} className={`px-3 py-1 rounded-lg text-xs font-medium ${detailTab === 'overview' ? 'bg-accent text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>概览</button>
              <button onClick={() => setDetailTab('skills')} className={`px-3 py-1 rounded-lg text-xs font-medium ${detailTab === 'skills' ? 'bg-accent text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>能力（技能 / 生命周期）</button>
              <span className="text-[10px] text-gray-400 ml-1">本机积累全档可用；带走（Pro）与团队共享（Team）是另一道闸。</span>
            </div>
            <div className={detailTab === 'skills' ? 'hidden' : 'space-y-4'}>
              <div className="bg-white rounded-lg border p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{detail.position.name}</h3>
                    <span className="tnum text-[10px] text-gray-400">v{detail.position.version}</span>
                    {detail.position.builtin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">内置</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {detail.position.enabled && dispatchProjects.length === 0 && <span className="text-[11px] text-amber-600">先在下方「项目启用」勾选一个项目</span>}
                    <button
                      onClick={openDispatch}
                      disabled={!detail.position.enabled || dispatchProjects.length === 0}
                      title={!detail.position.enabled ? '岗位已停用——先启用岗位' : dispatchProjects.length === 0 ? '没有可派活的项目——先在下方「项目启用」勾选一个项目' : '用该岗位新建一个任务（岗位固定，不可改）'}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    ><Send className="w-3 h-3" />派活</button>
                    <button onClick={() => void toggle({ ...detail.position, projectCount: 0, pendingLessons: 0 })} className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">{detail.position.enabled ? '停用' : '启用'}</button>
                    <button onClick={() => void remove({ ...detail.position, projectCount: 0, pendingLessons: 0 })} className="p-1.5 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-4 h-4 text-red-400" /></button>
                  </div>
                </div>
                {/* zx_20261113_1 B6「商」: 知识包搬运（Pro）——导出/合并导入/覆盖导入；本机使用不挂闸。 */}
                <div className="flex items-center gap-1.5 flex-wrap mb-3 text-[11px]">
                  <button onClick={() => void exportPack()} className="flex items-center gap-1 px-2 py-1 rounded border text-gray-600 hover:bg-gray-50" title="导出岗位四段 + 已采纳经验（Pro 能力）">
                    <Download className="w-3 h-3" />导出知识包
                  </button>
                  <button onClick={() => void importPack('merge')} className="flex items-center gap-1 px-2 py-1 rounded border text-gray-600 hover:bg-gray-50" title="合并导入：只补缺失条目与经验，不覆盖本机已有内容（Pro 能力）">
                    <Upload className="w-3 h-3" />导入（合并）
                  </button>
                  <button onClick={() => void importPack('replace')} className="px-2 py-1 rounded border border-amber-200 text-amber-700 hover:bg-amber-50" title="覆盖导入：用包里的四段替换同名岗位现有内容（经验仍只追加候选；Pro 能力）">
                    覆盖导入
                  </button>
                  <span className="text-gray-400">导入经验一律为待审候选；本机生成/注入/晋升不挂闸。</span>
                </div>

                {/* zx_20261113_1 B5「像」: 第一屏画像——做过多少 / 做得怎么样 / 学到什么 / 用了多少。
                    无任务时如实写"还没有指派过任务"，不拿 0 冒充"一切正常"。 */}
                {profileError && (
                  <div className="mb-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                    画像加载失败：{profileError}（岗位详情仍可编辑）
                  </div>
                )}
                {profile && (
                  <div className="mb-3 rounded-lg border bg-gray-50/70 px-3 py-2 text-sm">
                    {profile.taskTotal === 0 ? (
                      <p className="text-gray-500">还没有指派过任务——先在下方「项目启用」勾选项目，建单时选这个岗位。</p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>做过 <b>{profile.taskTotal}</b> 件</span>
                        <span>完成 {profile.taskCompleted}</span>
                        <span className={profile.taskFailed > 0 ? 'text-red-600' : ''}>失败 {profile.taskFailed}</span>
                        {profile.taskActive > 0 && <span>在办 {profile.taskActive}</span>}
                        <span>验收通过 {profile.acceptancePassed}</span>
                        <span>经验 采纳 {profile.lessons.accepted} · 待审 {profile.lessons.pending}{profile.lessons.promoted > 0 ? ` · 已晋升 ${profile.lessons.promoted}` : ''}</span>
                        <span className="text-gray-600">
                          注入 {profile.injections.rows} 条 · {profile.injections.estTokens} token
                          {profile.injections.rows > 0 ? `（完成 ${profile.injections.completed} / 失败 ${profile.injections.failed}）` : ''}
                        </span>
                        {!profile.injections.available && <span className="text-amber-700">注入账不可用：{profile.injections.reason}</span>}
                        {profile.lastActive && <span className="text-gray-400">最近活跃 {profile.lastActive}</span>}
                      </div>
                    )}
                    <p className="text-[10px] text-gray-400 mt-1">
                      口径：任务/验收来自本机任务账；注入来自 wa_context_injections（source=position）；只读派生，不另算。
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">名称 *</label>
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">分类</label>
                    <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls} placeholder="如 tech / business" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium mb-1">说明（一句：这个岗位负责什么）</label>
                    <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">规范（每行一条，最多 20 条）</label>
                    <textarea value={form.rules} onChange={(e) => setForm({ ...form, rules: e.target.value })} rows={4} className={inputCls} placeholder="先对齐验收标准再开工" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">技能（每行一条）</label>
                    <textarea value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} rows={4} className={inputCls} placeholder="任务拆解" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium mb-1">知识（每行一条；手工维护，不跨机）</label>
                    <textarea value={form.knowledge} onChange={(e) => setForm({ ...form, knowledge: e.target.value })} rows={3} className={inputCls} />
                  </div>
                  {/* zx_20261115_1 M1「职」：岗位从"自由文本"长出**能约束执行**的三项 + 派单开关。
                      每个勾选/输入都对应一个真读口；空值一律等于"沿用默认"，不会悄悄改变既有行为。 */}
                  <div>
                    <label className="block text-xs font-medium mb-1">允许的工具（每行一个；留空＝按任务形态默认）</label>
                    <textarea value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} rows={3} className={inputCls} placeholder="read_file" />
                    <p className="text-[10px] text-gray-400 mt-1">只能收窄：只保留这里列出的工具，且不会把任务形态挡掉的工具加回来。</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">允许的 MCP（每行一个；留空＝项目全部）</label>
                    <textarea value={form.mcp} onChange={(e) => setForm({ ...form, mcp: e.target.value })} rows={3} className={inputCls} placeholder="github" />
                    <p className="text-[10px] text-gray-400 mt-1">只能收窄：只列白名单内的 MCP，不会把项目里没有的加进来。</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">沙箱档（只能调严，不能放宽）</label>
                    <select
                      value={form.sandboxScope}
                      onChange={(e) => setForm({ ...form, sandboxScope: e.target.value as FormState['sandboxScope'] })}
                      className={inputCls}
                    >
                      <option value="">跟随项目</option>
                      <option value="strict">严格（最严）</option>
                      <option value="workspace">仅工作目录</option>
                      <option value="off">不限制</option>
                    </select>
                    <p className="text-[10px] text-gray-400 mt-1">取「岗位」与「项目」中更严者——选「不限制」也不会把项目的严格档放宽。</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">跨机派单</label>
                    <label className="flex items-center gap-2 text-sm mt-2">
                      <input type="checkbox" checked={form.participate} onChange={(e) => setForm({ ...form, participate: e.target.checked })} />
                      <span>该岗位的任务可派给其他工蚁</span>
                    </label>
                    <p className="text-[10px] text-gray-400 mt-1">取消后，指派到该岗位的任务只在本机执行（拒因：该岗位已设为不参与跨机派单）。</p>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-3">
                  <span className="text-[11px] text-gray-400">注入上限 1200 字；执行时只取说明 / 前 3 条规范 / 前 3 条技能 / 前 3 条知识 / 最近 3 条已采纳经验。</span>
                  <button onClick={() => void save()} disabled={saving} className="flex items-center gap-1 px-3 py-1.5 bg-accent text-white rounded-lg text-sm hover:bg-accent/90 disabled:opacity-50"><Save className="w-3.5 h-3.5" />{saving ? '保存中…' : '保存'}</button>
                </div>
              </div>

              <div className="bg-white rounded-lg border p-4">
                <h4 className="text-sm font-semibold mb-2">项目启用</h4>
                {detail.projects.length === 0 ? (
                  <p className="text-xs text-gray-400">还没有未归档项目。岗位只在已启用的项目里可被指派。</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.projects.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={p.enabled} onChange={(e) => void toggleProject(p.id, e.target.checked)} />
                        <span className="truncate">{p.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* zx_20261120_1 M3「例·见」：到点该做的那件事——例行列表 / 建议（只读）/ 绩效看板。
                  档位口径：本机例行全档可用；跨机执行仍走既有 multi_node，不新增闸。 */}
              <div className="bg-white rounded-lg border p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold flex items-center gap-1.5"><Clock className="w-4 h-4 text-accent" />例行（到点该做的那件事）</h4>
                  <label className="flex items-center gap-1 text-[11px] text-gray-500 mr-auto ml-3" title="缺省只在失败时推 IM；勾选后完成也推">
                    <input type="checkbox" checked={routineNotify} onChange={(e) => void toggleRoutineNotify(e.target.checked)} />
                    完成也推 IM
                  </label>
                  <button
                    onClick={() => openRoutine()}
                    disabled={!detail.position.enabled || dispatchProjects.length === 0}
                    title={dispatchProjects.length === 0 ? '先在「项目启用」勾选一个项目' : '按 cron 到点自动建一条任务'}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  ><Plus className="w-3 h-3" />新建例行</button>
                </div>
                {routineError && <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">{routineError}</p>}

                {routineBoardData && (
                  <div className="mb-3 rounded-lg border bg-gray-50/70 px-3 py-2 text-[12px] text-gray-700 flex flex-wrap gap-x-4 gap-y-1">
                    <span>例行 <b>{routineBoardData.routine.tasks}</b> 件（完成 {routineBoardData.routine.completed} · 验收通过 {routineBoardData.routine.acceptance_passed}）</span>
                    <span>临时 {routineBoardData.adhoc.tasks} 件（完成 {routineBoardData.adhoc.completed} · 验收通过 {routineBoardData.adhoc.acceptance_passed}）</span>
                    <span>平均 token {routineBoardData.routine.avg_tokens == null ? '未记录' : routineBoardData.routine.avg_tokens}</span>
                    <span>平均步数 {routineBoardData.routine.avg_steps == null ? '未记录' : routineBoardData.routine.avg_steps}</span>
                    <span>平均时长（估算）{routineBoardData.routine.avg_duration_ms == null ? '未记录' : `${Math.round(routineBoardData.routine.avg_duration_ms / 60000)} 分钟`}</span>
                  </div>
                )}

                {routines.length === 0 ? (
                  <p className="text-xs text-gray-400">还没有例行——把每月/每周重复的活建成例行，到点自动建单；建成普通任务，照常拆解、执行、验收。</p>
                ) : (
                  <div className="space-y-2">
                    {routines.map((r) => (
                      <div key={r.id} className="rounded-lg border p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm truncate">{r.name}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.enabled === 1 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{r.enabled === 1 ? '启用' : '停用'}</span>
                              <span className="text-[10px] text-gray-500">{r.project_name || '项目已删除'}</span>
                            </div>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                              cron <code className="bg-gray-100 px-1 rounded">{r.cron}</code> · {r.title}
                            </p>
                            <p className="text-[11px] mt-0.5 text-gray-500">
                              上次：{r.last_run_status ? routineStatusLabel(r.last_run_status) : '从未触发'}
                              {r.last_run_reason ? `（${routineSkipLabel(r.last_run_reason)}）` : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button onClick={() => void runRoutineNow(r)} disabled={r.enabled !== 1} title="立刻跑一次（仍不叠单）" className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">立刻跑</button>
                            <button onClick={() => void toggleRoutine(r)} className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">{r.enabled === 1 ? '停用' : '启用'}</button>
                            <button onClick={() => void removeRoutine(r)} className="p-1.5 hover:bg-red-50 rounded" title="删除例行（历史任务保留）"><Trash2 className="w-4 h-4 text-red-400" /></button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {routineSuggestions.length > 0 && (
                  <div className="mt-3 rounded-lg border border-accent/15 bg-accent-soft/50 p-2.5">
                    <p className="text-[11px] text-accent mb-1">近 90 天有同类任务反复出现——设为例行？（只建议，不自动建）</p>
                    <div className="space-y-1">
                      {routineSuggestions.map((s) => (
                        <div key={`${s.project_id}:${s.title}`} className="flex items-center justify-between gap-2 text-[12px]">
                          <span className="truncate">{s.title} · {s.runs} 次 · 最近 {s.last_run_at?.slice(0, 10)}</span>
                          <button
                            onClick={() => openRoutine({ projectId: s.project_id, name: s.title.slice(0, 20), title: s.title, cron: '0 9 * * 1' })}
                            className="text-[11px] px-2 py-0.5 rounded border border-accent/25 text-accent hover:bg-accent-soft"
                          >设为例行</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-white rounded-lg border p-4">
                <h4 className="text-sm font-semibold mb-2">经验（复盘可迁移教训优先；采纳后注入，晋升后并入岗位四段）</h4>
                {detail.lessons.length === 0 ? (
                  <p className="text-xs text-gray-400">暂无经验候选——指派岗位的任务完成且验收通过后，这里会出现待审候选。</p>
                ) : (
                  <div className="space-y-2">
                    {detail.lessons.map((l) => (
                      <div key={l.id} className={`rounded-lg border p-3 ${l.status === 'pending' ? 'border-amber-200 bg-amber-50' : 'bg-gray-50'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            {editingLesson?.id === l.id ? (
                              <div className="space-y-1">
                                <textarea value={editingLesson.content} onChange={(e) => setEditingLesson({ ...editingLesson, content: e.target.value })} rows={4} className="w-full px-2 py-1 border rounded text-sm" />
                                <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                  <span className={editingLesson.content.trim().length > 200 ? 'text-amber-600' : ''}>{editingLesson.content.trim().length} 字{editingLesson.content.trim().length > 200 ? '（晋升需 ≤200）' : ''}</span>
                                  <button onClick={() => void saveLessonEdit()} className="px-2 py-0.5 bg-accent text-white rounded text-xs">保存</button>
                                  <button onClick={() => setEditingLesson(null)} className="px-2 py-0.5 border rounded text-xs">取消</button>
                                </div>
                              </div>
                            ) : (
                              <p className="text-sm whitespace-pre-wrap">{l.content}</p>
                            )}
                            {!editingLesson && l.content.trim().length > 200 && !l.promotedTo && (
                              <p className="text-[11px] text-amber-600 mt-1">当前 {l.content.trim().length} 字，超过晋升单条上限 200 字——先「编辑」缩短。</p>
                            )}
                            {/* zx_20261115_1 M2「用」：经验**真被任务用上**的次数与晋升建议。
                                次数取自注入账（不是"选进候选"）；建议只是建议，采纳与晋升仍须人点。 */}
                            {l.injectedCount > 0 && (
                              <p className="text-[11px] text-gray-500 mt-1">
                                已被 {l.injectedCount} 个任务用上
                                {l.crossProjectCount > 1 && `，跨 ${l.crossProjectCount} 个项目（可迁移的直接证据）`}
                              </p>
                            )}
                            {l.promoteSuggested && (
                              <p className="text-[11px] text-accent mt-0.5">已反复用上，建议晋升到「规范/技能/知识」——仍由你决定。</p>
                            )}
                            <div className="flex items-center gap-1.5 flex-wrap mt-1">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${l.source === 'retrospective' ? 'bg-accent-soft text-accent' : 'bg-gray-100 text-gray-500'}`}>
                                {(POSITION_LESSON_SOURCE_LABEL as Record<string, string>)[l.source] ?? l.source}
                              </span>
                              {!l.reusable && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700" title="项目摘要或复盘判定不可复用——只留档，不注入、不可晋升">不可迁移</span>}
                              {l.origin === 'imported' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">导入候选</span>}
                              <span className="text-[11px] text-gray-500">
                                {/* zx_20261115_1 M3：删任务/删项目后如实说"已删除"，不显示裸 id 假装还在。 */}
                                来源：{l.taskTitle || (l.taskId ? '任务已删除' : '任务')} · {l.projectName || (l.projectId ? '项目已删除' : '项目')} · {l.createdAt}
                              </span>
                            </div>
                          </div>
                          {l.status === 'pending' ? (
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <button onClick={() => setEditingLesson({ id: l.id, content: l.content })} className="px-2 py-1 border rounded text-xs hover:bg-gray-100">编辑</button>
                              <button onClick={() => void decideLesson(l.id, 'accepted')} className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700"><Check className="w-3 h-3" />采纳</button>
                              <button onClick={() => void decideLesson(l.id, 'rejected')} className="px-2 py-1 border rounded text-xs hover:bg-gray-100"><X className="w-3 h-3" /></button>
                            </div>
                          ) : l.status === 'accepted' ? (
                            l.promotedTo ? (
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                                  已晋升：{(POSITION_PROMOTE_TARGET_LABEL as Record<string, string>)[l.promotedTo] ?? l.promotedTo}
                                </span>
                                <button onClick={() => void unpromoteLesson(l.id)} className="px-2 py-1 border rounded text-xs hover:bg-gray-100">撤回晋升</button>
                              </div>
                            ) : l.reusable ? (
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button onClick={() => setEditingLesson({ id: l.id, content: l.content })} className="px-2 py-1 border rounded text-xs hover:bg-gray-100">编辑</button>
                                <span className="text-[10px] text-gray-400">晋升到</span>
                                {(['rules', 'skills', 'knowledge'] as const).map((t) => (
                                  <button key={t} onClick={() => void promoteLesson(l.id, t)} className="px-1.5 py-1 border rounded text-[10px] text-gray-600 hover:bg-gray-100">
                                    {POSITION_PROMOTE_TARGET_LABEL[t]}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 flex-shrink-0">已采纳·不可迁移</span>
                            )
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 flex-shrink-0">已拒绝</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {detailTab === 'skills' && (
              <div className="space-y-4">
                <div className="bg-white rounded-lg border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold">可调用技能</h4>
                    <span className="text-[10px] text-gray-400">只有「已批准」会出现在任务的 list_skills，并可被 skill 工具调用</span>
                  </div>
                  {skillError && <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">{skillError}</p>}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2">
                    <input value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} className={inputCls} placeholder="技能名（≤40 字）" />
                    <input value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} className={inputCls} placeholder="一句话说明" />
                    <button onClick={() => void createSkill()} disabled={skillSaving || !skillForm.name.trim() || !skillForm.steps.trim()} className="px-3 py-1.5 bg-accent text-white rounded-lg text-xs hover:bg-accent/90 disabled:opacity-50">沉淀为技能草案</button>
                  </div>
                  <textarea value={skillForm.steps} onChange={(e) => setSkillForm({ ...skillForm, steps: e.target.value })} rows={3} className={inputCls} placeholder="步骤（每行一步；批准后作为提示词型技能内容）" />
                  <div className="mt-3 space-y-1.5">
                    {skills.length === 0 ? (
                      <p className="text-xs text-gray-400">暂无岗位技能。可从已采纳经验「沉淀为技能」，或在这里直接写一份草案。</p>
                    ) : skills.map((s) => (
                      <div key={s.id} className="flex items-start gap-2 rounded border px-2 py-1.5 text-xs">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium">{s.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : s.status === 'rejected' ? 'bg-gray-200 text-gray-500' : 'bg-amber-100 text-amber-700'}`}>{POSITION_SKILL_STATUS_LABEL[s.status]}</span>
                            <span className="text-[10px] text-gray-400">用过 {s.useCount} 次{s.lastUsedAt ? ` · 最近 ${s.lastUsedAt}` : ''}</span>
                          </div>
                          {s.description && <p className="text-gray-500 truncate" title={s.description}>{s.description}</p>}
                          <p className="text-[10px] text-gray-400 truncate" title={s.steps.join(' → ')}>{s.steps.join(' → ')}</p>
                        </div>
                        {s.status === 'draft' && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button onClick={() => void decideSkill(s.id, 'approved')} className="px-2 py-1 bg-emerald-600 text-white rounded text-[11px] hover:bg-emerald-700">批准</button>
                            <button onClick={() => void decideSkill(s.id, 'rejected')} className="px-2 py-1 border rounded text-[11px] hover:bg-gray-100">拒绝</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="text-sm font-semibold mb-1">经验生命周期</h4>
                  <p className="text-[11px] text-gray-500 mb-2">
                    口径：≥{90} 天未复验/未成功使用为「老化」，≥{180} 天为「待复验」；退役/被替代不再注入与晋升。机器不替人改写已采纳内容。
                  </p>
                  {profile && (
                    <div className="text-[11px] bg-gray-50 border rounded px-2 py-1 mb-2 flex flex-wrap gap-x-3">
                      <span>待复验 {profile.lessons.stale}</span>
                      <span>未验证 {profile.lessons.unverified}</span>
                      <span>已替代 {profile.lessons.superseded}</span>
                      <span>已退役 {profile.lessons.retired}</span>
                      <span>可调用技能 {profile.skills.approved}（草案 {profile.skills.draft}）</span>
                    </div>
                  )}
                  {detail.lessons.filter((l) => l.status === 'accepted').length === 0 ? (
                    <p className="text-xs text-gray-400">还没有已采纳经验。先去「概览」采纳候选。</p>
                  ) : detail.lessons.filter((l) => l.status === 'accepted').map((l) => (
                    <div key={l.id} className="rounded border px-2 py-1.5 mb-1.5 text-xs">
                      <p className="text-gray-800">{l.content}</p>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1 text-[10px] text-gray-500">
                        {l.appliesTo ? <span className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">适用：{l.appliesTo}</span> : <span>适用条件未标注</span>}
                        {l.retiredAt && <span className="px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">已退役{l.retireReason ? `：${l.retireReason}` : ''}</span>}
                        {l.supersededBy && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">已被替代</span>}
                        {!l.verifiedAt && <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">未在本机验证</span>}
                        <button onClick={() => {
                          const text = window.prompt('适用条件（≤200 字；空=清除）', l.appliesTo || '');
                          if (text !== null) void lessonLifecycle(l.id, 'applies', { appliesTo: text });
                        }} className="px-1.5 py-0.5 border rounded hover:bg-gray-50">适用条件</button>
                        <button onClick={() => void lessonLifecycle(l.id, 'verify')} className="px-1.5 py-0.5 border rounded hover:bg-gray-50">标记已验证</button>
                        <button onClick={() => {
                          if (l.retiredAt) { void lessonLifecycle(l.id, 'unretire'); return; }
                          const reason = window.prompt('退役原因（≤200 字；空=无原因）', '');
                          if (reason !== null) void lessonLifecycle(l.id, 'retire', { reason });
                        }} className="px-1.5 py-0.5 border rounded hover:bg-gray-50">{l.retiredAt ? '撤销退役' : '退役'}</button>
                        <button onClick={() => {
                          if (l.supersededBy) { void lessonLifecycle(l.id, 'unsupersede'); return; }
                          const byId = window.prompt('用哪条已采纳经验的 id 替代它？（可在「概览」经验列表的「来源」行核对）', '');
                          if (byId && byId.trim()) void lessonLifecycle(l.id, 'supersede', { byId: byId.trim() });
                        }} className="px-1.5 py-0.5 border rounded hover:bg-gray-50">{l.supersededBy ? '撤销替代' : '标记被替代'}</button>
                        <button onClick={() => void addLessonAsSkill(l)} className="px-1.5 py-0.5 border rounded hover:bg-gray-50" title="生成技能草案；批准后才可调用">沉淀为技能</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </>
          )}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-lg p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">新建岗位</h3>
              <button onClick={() => setShowCreate(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <div><label className="block text-xs font-medium mb-1">名称 *</label><input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} className={inputCls} placeholder="如 数据分析师" /></div>
              <div><label className="block text-xs font-medium mb-1">分类</label><input value={createForm.category} onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })} className={inputCls} placeholder="custom" /></div>
              <div><label className="block text-xs font-medium mb-1">说明</label><textarea value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} rows={2} className={inputCls} /></div>
              <div><label className="block text-xs font-medium mb-1">规范（每行一条）</label><textarea value={createForm.rules} onChange={(e) => setCreateForm({ ...createForm, rules: e.target.value })} rows={3} className={inputCls} /></div>
              <div><label className="block text-xs font-medium mb-1">技能（每行一条）</label><textarea value={createForm.skills} onChange={(e) => setCreateForm({ ...createForm, skills: e.target.value })} rows={3} className={inputCls} /></div>
              <div><label className="block text-xs font-medium mb-1">知识（每行一条）</label><textarea value={createForm.knowledge} onChange={(e) => setCreateForm({ ...createForm, knowledge: e.target.value })} rows={2} className={inputCls} /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
              <button onClick={() => void create()} disabled={saving || !createForm.name.trim()} className="px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent/90 disabled:opacity-50">{saving ? '创建中…' : '创建'}</button>
            </div>
          </div>
        </div>
      )}

      {showRoutine && detail && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowRoutine(false)}>
          <div className="bg-white rounded-xl shadow-lg p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">新建例行</h3>
              <button onClick={() => setShowRoutine(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-gray-500 mb-3">到点自动建一条普通任务（岗位固定为「{detail.position.name}」）；上一单没结束就跳过并留痕，不叠单。</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1">项目 *（只列该岗位已启用的项目）</label>
                <select value={routineForm.projectId} onChange={(e) => setRoutineForm({ ...routineForm, projectId: e.target.value })} className={inputCls}>
                  {dispatchProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div><label className="block text-xs font-medium mb-1">例行名称 *（本岗位内唯一）</label><input value={routineForm.name} onChange={(e) => setRoutineForm({ ...routineForm, name: e.target.value })} className={inputCls} placeholder="如 每周报销审核" /></div>
              <div>
                <label className="block text-xs font-medium mb-1">触发（cron）*</label>
                <div className="flex flex-wrap gap-1 mb-1">
                  {[
                    ['每天 9:00', '0 9 * * *'],
                    ['每周一 9:00', '0 9 * * 1'],
                    ['每月 1 日 9:00', '0 9 1 * *'],
                  ].map(([label, expr]) => (
                    <button key={expr} type="button" onClick={() => setRoutineForm({ ...routineForm, cron: expr })} className="text-[11px] px-2 py-0.5 rounded border hover:bg-gray-50">{label}</button>
                  ))}
                </div>
                <input value={routineForm.cron} onChange={(e) => setRoutineForm({ ...routineForm, cron: e.target.value })} className={inputCls} placeholder="0 9 * * 1" />
                <p className="text-[10px] text-gray-400 mt-1">分 时 日 月 周；多条用换行或分号分隔。到期由调度器触发。</p>
              </div>
              <div><label className="block text-xs font-medium mb-1">任务标题 *</label><input value={routineForm.title} onChange={(e) => setRoutineForm({ ...routineForm, title: e.target.value })} className={inputCls} placeholder="审核销售部本周报销单" /></div>
              <div><label className="block text-xs font-medium mb-1">描述</label><textarea value={routineForm.description} onChange={(e) => setRoutineForm({ ...routineForm, description: e.target.value })} rows={3} className={inputCls} placeholder="背景、范围、约束" /></div>
              <div><label className="block text-xs font-medium mb-1">验收标准</label><textarea value={routineForm.acceptance} onChange={(e) => setRoutineForm({ ...routineForm, acceptance: e.target.value })} rows={2} className={inputCls} placeholder="可核对的一条条判据" /></div>
            </div>
            {error && <p className="text-red-500 text-xs mt-3">错误：{error}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowRoutine(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
              <button onClick={() => void submitRoutine()} disabled={routineSaving || !routineForm.name.trim() || !routineForm.title.trim() || !routineForm.projectId} className="px-4 py-2 bg-accent text-white rounded-lg text-sm hover:bg-accent/90 disabled:opacity-50">{routineSaving ? '创建中…' : '创建'}</button>
            </div>
          </div>
        </div>
      )}

      {showDispatch && detail && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowDispatch(false)}>
          <div className="bg-white rounded-xl shadow-lg p-5 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">派活</h3>
              <button onClick={() => setShowDispatch(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-gray-500 mb-3">岗位固定为「{detail.position.name}」——建成普通任务，复用既有拆解 / 调度 / 验收流程；执行时注入该岗位的说明 / 规范 / 技能 / 知识与已采纳经验（≤1200 字）。</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1">项目 *</label>
                <select value={dispatchForm.projectId} onChange={(e) => setDispatchForm({ ...dispatchForm, projectId: e.target.value })} className={inputCls}>
                  {dispatchProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div><label className="block text-xs font-medium mb-1">标题 *</label><input value={dispatchForm.title} onChange={(e) => setDispatchForm({ ...dispatchForm, title: e.target.value })} className={inputCls} placeholder="要做的事" /></div>
              <div><label className="block text-xs font-medium mb-1">描述</label><textarea value={dispatchForm.description} onChange={(e) => setDispatchForm({ ...dispatchForm, description: e.target.value })} rows={3} className={inputCls} placeholder="背景、范围、约束" /></div>
              <div><label className="block text-xs font-medium mb-1">验收标准</label><textarea value={dispatchForm.acceptance} onChange={(e) => setDispatchForm({ ...dispatchForm, acceptance: e.target.value })} rows={3} className={inputCls} placeholder="可核对的一条条判据" /></div>
            </div>
            {error && <p className="text-red-500 text-xs mt-3">错误：{error}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowDispatch(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
              <button onClick={() => void submitDispatch()} disabled={dispatching || !dispatchForm.title.trim() || !dispatchForm.projectId} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700 disabled:opacity-50">{dispatching ? '创建中…' : '创建并打开'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
