/**
 * zx_20261005 M14（柏拉图·洞穴喻：别只看影子的问卷，要看"能不能跑起来"这把火）:
 * **真·安装向导**——干净机器上 ≤5 分钟跑出第一个成果。
 *
 * 与 `PreferencesWizardPage`（偏好采集问卷，`/preferences-wizard`）**并存、不合并**：
 *   本页是**阻塞式**安装向导（路由 `/onboarding`），答的是"**这台机器跑起来没有**"；
 *   那页是可跳过的偏好问卷，答的是"你习惯什么"。此前二者混为一页（旧 `OnboardingPage` 只采偏好），
 *   于是新用户装完看到一张 17 题问卷，却始终没跑出东西——漏斗第一跳就漏在这里。
 *
 * 四步（每一步都用**生产既有的** IPC，不自造接口）：
 *   ① 连接模型：填 ANS 地址/凭据（模型由 ANS 网关提供）→ ② ANS 自检（可达？有模型？）
 *   → ③ 选/建项目 → ④ 选模板建第一个任务。
 *
 * ⚠ 首启判据**不在此页**：真源在 main `core/first-run.ts`，渲染层经 `lib/firstRun.ts` 读。
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke, ans as ansApi, ansProxy, newClientRequestId } from '../lib/ipc';
import { invalidateNeedsSetup } from '../lib/firstRun';
// zx_20261011_5: 会话级软跳过——不想现在配置的新用户可"先进去看看"（判据不变，只放行一次；刷新即复位）。
import { skipOnboarding } from '../lib/onboardingSkip';
import { probeModelsLine, type ModelsRead } from '../lib/probe-models';
import { parseCapabilities } from '../lib/model-caps';
// zx_20261023_4: 首启「本机所有者」设置密码卡片——判据在 main，不适用时组件自隐。
import LocalOwnerPasswordCard from '../components/LocalOwnerPasswordCard';
import { Plug, ShieldCheck, FolderPlus, Rocket, Check, ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';

interface ProjectRow { id: string; name: string; description?: string; status?: string }
interface TemplateRow { id: string; name: string; category?: string; description?: string; subtasks?: Array<{ title: string }> }

// ② 自检态：`catalog`/`available`/`hasChat`/`hasEmbedding` 四个真数（zx_20261010 M3——
//   "已接入几个"须按**可用**点，且 chat（跑成果）/ embedding（记忆向量）两个前提分列）。
interface ProbeState {
  phase: 'idle' | 'running' | 'done';
  reachable: boolean;
  note: string;
  read: ModelsRead;
  catalog: number;
  available: number;
  hasChat: boolean;
  hasEmbedding: boolean;
}
const PROBE_IDLE: ProbeState = { phase: 'idle', reachable: false, note: '', read: 'ok', catalog: 0, available: 0, hasChat: false, hasEmbedding: false };

const STEPS = ['连接模型', 'ANS 自检', '选 / 建项目', '跑出第一个成果'] as const;

export default function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // ① 连接模型（= 配 ANS 网关：模型从这里来）
  const [ansForm, setAnsForm] = useState({ url: '', apiKey: '', secretKey: '' });
  // 密钥读侧已脱敏（`settings:getAll` 回 `***`）：表单恒置空，只以"是否已配置"驱动占位文案；留空＝不修改。
  const [ansSecretSet, setAnsSecretSet] = useState({ apiKey: false, secretKey: false });
  const [ansDefaultUrl, setAnsDefaultUrl] = useState('');
  const [saving, setSaving] = useState(false);

  // ② 自检
  const [probe, setProbe] = useState<ProbeState>(PROBE_IDLE);

  // ② 就地配置 chat 模型端点（zx_20261010 M5）：向导原先只叫人"去配置"，但首启态下模型页
  //   受 `ProtectedRoute` 弹回 ⇒ 走不通。此处内嵌最小表单，复用生产接口 `POST /api/v1/models/:id/endpoints`
  //   （与模型页 `EndpointDialog` 同一跳），保存后**立即重探**。
  const [chatModels, setChatModels] = useState<Array<{ id: string; name: string; provider_id?: string }>>([]);
  const [providerUrls, setProviderUrls] = useState<Record<string, string>>({});
  const [epModel, setEpModel] = useState('');
  const [epUrl, setEpUrl] = useState('');
  const [epKey, setEpKey] = useState('');
  const [epBusy, setEpBusy] = useState(false);
  const [epErr, setEpErr] = useState('');

  // ③ 项目
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [picked, setPicked] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [busy, setBusy] = useState(false);

  // ④ 模板
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [pickedTpl, setPickedTpl] = useState('');

  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const defUrl = await ansApi.defaults().then((d) => d.baseUrl).catch(() => '');
        setAnsDefaultUrl(defUrl);
        const all = await invoke<Record<string, string>>('settings:getAll').catch(() => ({} as Record<string, string>));
        setAnsForm({ url: all?.ans_server_url || defUrl, apiKey: '', secretKey: '' });
        const st = await invoke<Record<string, boolean>>('settings:secretStatus').catch(() => ({} as Record<string, boolean>));
        setAnsSecretSet({ apiKey: st?.ans_api_key === true, secretKey: st?.ans_secret_key === true });
      } catch { /* 读不到就留空表单，不阻断向导 */ }
    })();
  }, []);

  const runProbe = async () => {
    setProbe({ ...PROBE_IDLE, phase: 'running' });
    try {
      // 探针复用生产的 ANS 托管探测（不可达则尝试拉起本地 ANS——与 M21 同一跳）。
      const started = await ansApi.start();
      if (!started.reachable) {
        setProbe({ ...PROBE_IDLE, phase: 'done', note: started.reason || 'ANS 不可达' });
        return;
      }
      // 可达 ⇒ 数一下"目录几条 / 可用几条"，并分列 chat（跑成果）/ embedding（记忆向量）两个前提。
      // zx_20261009 M5：「读到 0 个」与「读不动」也要分开——401 由 main 侧 IPC 映成 `code='ANS_UNAUTHORIZED'`，
      //   此处据 code 分因（渲染层不解析 message 文本）。
      // zx_20261010 M3：N 不能取 `ms.length`（那是**目录条数**，零端点也>0）——须按行的 `available` 与
      //   `capabilities` 派生（`available` 由 ANS 侧 SQL 派生，此处不再重算）。
      let note = '';
      let read: ModelsRead = 'ok';
      let catalog = 0, available = 0, hasChat = false, hasEmbedding = false;
      try {
        const ms = await ansProxy.get<Array<{ id?: string; name?: string; provider_id?: string; available?: boolean; capabilities?: unknown }>>('/api/v1/models');
        const rows = Array.isArray(ms) ? ms : [];
        catalog = rows.length;
        available = rows.filter((m) => m.available === true).length;
        hasChat = rows.some((m) => m.available === true && parseCapabilities(m.capabilities).includes('chat'));
        hasEmbedding = rows.some((m) => m.available === true && parseCapabilities(m.capabilities).includes('embedding'));
        // 候选 chat 模型（供②就地配置挑）——不限"已可用"，含待配端点的。
        setChatModels(rows.filter((m) => !!m.id && parseCapabilities(m.capabilities).includes('chat')).map((m) => ({ id: m.id!, name: m.name || m.id!, provider_id: m.provider_id })));
        // 供应商 `base_url`（预填 Base URL，省用户手抄；取不到不阻断——用户可手填）。
        try {
          const ps = await ansProxy.get<Array<{ id?: string; base_url?: string }>>('/api/v1/models/providers');
          const map: Record<string, string> = {};
          for (const p of Array.isArray(ps) ? ps : []) if (p.id && p.base_url) map[p.id] = p.base_url;
          setProviderUrls(map);
        } catch { /* 预填失败无所谓 */ }
      } catch (e) {
        read = (e as { code?: string }).code === 'ANS_UNAUTHORIZED' ? 'auth' : 'error';
        note = (e as Error).message;
        setChatModels([]);
      }
      setProbe({ phase: 'done', reachable: true, note, read, catalog, available, hasChat, hasEmbedding });
    } catch (e) {
      setProbe({ ...PROBE_IDLE, phase: 'done', note: (e as Error).message });
    }
  };

  // 候选到位后默认选中第一个并预填其供应商 Base URL（用户仍可改）。
  useEffect(() => {
    if (epModel || chatModels.length === 0) return;
    const first = chatModels[0]!;
    setEpModel(first.id);
    const u = first.provider_id ? providerUrls[first.provider_id] : '';
    if (u) setEpUrl(u);
  }, [chatModels, providerUrls, epModel]);

  const pickEpModel = (id: string) => {
    setEpModel(id);
    const m = chatModels.find((c) => c.id === id);
    const u = m?.provider_id ? providerUrls[m.provider_id] : '';
    if (u) setEpUrl(u);
  };

  // 保存端点：走生产接口（与模型页 `EndpointDialog` 同一个 POST），成功后**立即重探**——绿灯须随配置点亮。
  const saveEndpoint = async () => {
    const url = epUrl.trim(); const key = epKey.trim();
    if (!epModel) { setEpErr('请选择要配置的 chat 模型'); return; }
    if (!url || !key) { setEpErr('请填写 Base URL 与 API Key'); return; }
    setEpBusy(true); setEpErr('');
    try {
      await ansProxy.post(`/api/v1/models/${epModel}/endpoints`, { url, api_key: key, priority: 0, weight: 1 });
      setEpKey('');
      await runProbe();
    } catch (e) {
      setEpErr((e as Error).message);
    } finally { setEpBusy(false); }
  };

  const saveAndProbe = async () => {
    setSaving(true); setErr('');
    try {
      await invoke('settings:set', 'ans_server_url', ansForm.url);
      if (ansForm.apiKey !== '') await invoke('settings:set', 'ans_api_key', ansForm.apiKey);
      if (ansForm.secretKey !== '') await invoke('settings:set', 'ans_secret_key', ansForm.secretKey);
      const st = await invoke<Record<string, boolean>>('settings:secretStatus').catch(() => ({} as Record<string, boolean>));
      setAnsSecretSet({ apiKey: st?.ans_api_key === true, secretKey: st?.ans_secret_key === true });
      setAnsForm((p) => ({ ...p, apiKey: '', secretKey: '' }));
      setStep(1);
      await runProbe();
    } catch (e) {
      setErr((e as Error).message || '保存失败');
    } finally { setSaving(false); }
  };

  const loadProjects = async () => {
    try {
      const rows = await invoke<ProjectRow[]>('project:list');
      setProjects(Array.isArray(rows) ? rows : []);
    } catch { setProjects([]); }
  };

  const goProjects = async () => { setErr(''); await loadProjects(); setStep(2); };

  const createProject = async () => {
    const name = newProjectName.trim();
    if (!name) { setErr('请填写项目名称'); return; }
    setBusy(true); setErr('');
    try {
      const p = await invoke<{ id: string }>('project:create', { name, description: '由安装向导创建' });
      if (!p?.id) throw new Error('项目创建失败');
      // 建了项目 ⇒ 首启状态已变，作废缓存，免得下一步被旧态拦回向导。
      invalidateNeedsSetup();
      setPicked(p.id);
      await loadProjects();
      await goTemplates(p.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // ⚠ 收显式 `pid`：`createProject` 刚 `setPicked`，同一 tick 内闭包里的 `picked` 仍是旧值——
  //   若此处读 state，新建项目那条路会误报"请先选择项目"（setState 不同步，是 React 的常态不是缺陷）。
  const goTemplates = async (pid?: string) => {
    const id = pid ?? picked;
    if (!id) { setErr('请先选择一个项目'); return; }
    setPicked(id);
    setErr('');
    try {
      const rows = await invoke<TemplateRow[]>('template:list');
      setTemplates(Array.isArray(rows) ? rows : []);
    } catch { setTemplates([]); }
    setStep(3);
  };

  const runFirstTask = async () => {
    const tpl = templates.find((t) => t.id === pickedTpl);
    if (!tpl) { setErr('请选择一个任务模板'); return; }
    setBusy(true); setErr('');
    try {
      const task = await invoke<{ id: string }>('task:create', {
        projectId: picked,
        title: tpl.name,
        description: tpl.description || '',
        acceptance_criteria: (tpl.subtasks || []).map((s) => s.title).join('；'),
        client_request_id: newClientRequestId(),
      });
      if (!task?.id) throw new Error('任务创建失败');
      invalidateNeedsSetup();
      navigate(`/tasks/${task.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const inputCls = 'w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500';
  const modelsLine = probeModelsLine(probe);
  // 本页答的是"这台机器跑起来没有" ⇒ 绿只认"有可用 chat 模型"（zx_20261010 M3：`ok` 取 `hasChat`）。
  const canRun = probe.reachable && probe.hasChat;

  // zx_20261011_5: 软跳过——记一次会话豁免后进桌面。判据（`needsSetup`）**不变**；跳过只是**推迟**配置，
  //   首屏会用模型 banner 如实提示"还差什么"，漏斗没丢。
  const skip = () => { skipOnboarding(); navigate('/'); };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 pt-8 pb-12">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">欢迎使用工蚁</h1>
          <p className="text-sm mt-1 text-gray-500">四步跑出你的第一个成果</p>
        </div>
        {/* zx_20261011_5: 软跳过出口——不想现在配置也能先进桌面看看（判据不变，只免一次；首屏会如实提示缺模型）。 */}
        <div className="flex justify-end mt-3">
          <button onClick={skip} className="text-xs text-gray-400 hover:text-gray-600">先进去看看，稍后再配置 →</button>
        </div>

        {/* zx_20261023_4: 本机所有者已在后台自动登录；此时可顺手设自己的密码（不设也不影响使用）。 */}
        <div className="mt-3">
          <LocalOwnerPasswordCard />
        </div>

        {/* 步骤条 */}
        <div className="flex items-center gap-2 mt-8 mb-6">
          {STEPS.map((s, i) => (
            <div key={s} className="flex-1 flex items-center gap-2">
              <div className={`flex items-center justify-center w-6 h-6 shrink-0 rounded-full text-xs font-semibold ${i < step ? 'bg-green-500 text-white' : i === step ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className={`text-xs truncate ${i === step ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>{s}</span>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl border p-6 shadow-sm">
          {step === 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-gray-900"><Plug className="w-4 h-4" /><h2 className="font-semibold">连接 AI 资源（ANS 网关）</h2></div>
              <p className="text-xs text-gray-500">模型由 ANS 网关统一提供。若本机已装 ANS，直接回车即可（启动时会自动拉起）；否则填入你的 ANS 地址与凭据。</p>
              <div><label className="block text-sm font-medium mb-1">服务地址</label>
                <input value={ansForm.url} onChange={(e) => setAnsForm({ ...ansForm, url: e.target.value })} placeholder={ansDefaultUrl || 'http://localhost:27183'} className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">API Key</label>
                <input value={ansForm.apiKey} onChange={(e) => setAnsForm({ ...ansForm, apiKey: e.target.value })} placeholder={ansSecretSet.apiKey ? '已配置（留空不修改）' : '未配置'} className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">Secret Key</label>
                <input type="password" value={ansForm.secretKey} onChange={(e) => setAnsForm({ ...ansForm, secretKey: e.target.value })} placeholder={ansSecretSet.secretKey ? '已配置（留空不修改）' : '未配置'} className={inputCls} /></div>
              <div className="flex justify-end">
                <button onClick={saveAndProbe} disabled={saving} className="flex items-center gap-1 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}保存并自检
                </button>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-gray-900"><ShieldCheck className="w-4 h-4" /><h2 className="font-semibold">ANS 自检</h2></div>
              {probe.phase === 'running' && <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin" />正在探测 ANS 服务与模型…</p>}
              {probe.phase === 'done' && (
                <div className="space-y-2">
                  <p className={`flex items-center gap-2 text-sm ${probe.reachable ? 'text-green-600' : 'text-amber-600'}`}>
                    {probe.reachable ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                    {probe.reachable ? 'ANS 服务可达' : `ANS 不可达：${probe.note || '未知原因'}`}
                  </p>
                  {probe.reachable && (
                    <p className={`flex items-center gap-2 text-sm ${modelsLine.ok ? 'text-green-600' : 'text-amber-600'}`}>
                      {modelsLine.ok ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                      {modelsLine.text}
                    </p>
                  )}
                </div>
              )}
              {/* 就地配置 chat 模型端点（zx_20261010 M5）：缺可用 chat 时给出**走得通**的动作，
                  不再只写"去 ANS 配"却无路可达（首启态下模型页会被守卫弹回）。 */}
              {probe.phase === 'done' && probe.reachable && !probe.hasChat && chatModels.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-2">
                  <p className="text-xs font-medium text-gray-700">就地配置一个 chat 模型端点（保存后自动重探）</p>
                  <select value={epModel} onChange={(e) => pickEpModel(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm bg-white">
                    {chatModels.map((m) => <option key={m.id} value={m.id}>{m.name}{m.provider_id ? ` — ${m.provider_id}` : ''}</option>)}
                  </select>
                  <input value={epUrl} onChange={(e) => setEpUrl(e.target.value)} placeholder="Base URL，如 https://api.deepseek.com/v1" className={inputCls} />
                  <input type="password" value={epKey} onChange={(e) => setEpKey(e.target.value)} placeholder="API Key" className={inputCls} />
                  {epErr && <p className="text-xs text-red-600">{epErr}</p>}
                  <div className="flex justify-end">
                    <button onClick={saveEndpoint} disabled={epBusy} className="flex items-center gap-1 px-4 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 disabled:opacity-50">
                      {epBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}保存并重探
                    </button>
                  </div>
                </div>
              )}
              <div className="flex justify-between">
                <button onClick={() => setStep(0)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">上一步</button>
                <div className="flex gap-2">
                  <button onClick={runProbe} disabled={probe.phase === 'running'} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">重新自检</button>
                  {/* 自检未过仍可继续——但如实标注"可能跑不出结果"，不假装通过（承「缺失即如实」纪律）。 */}
                  <button onClick={goProjects} className={`px-5 py-2 rounded-lg text-sm text-white ${canRun ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 hover:bg-gray-500'}`}>
                    {canRun ? '下一步' : '仍要继续'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-gray-900"><FolderPlus className="w-4 h-4" /><h2 className="font-semibold">选择或新建项目</h2></div>
              {projects.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {projects.map((p) => (
                    <label key={p.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer ${picked === p.id ? 'border-blue-500 bg-blue-50' : 'hover:bg-gray-50'}`}>
                      <input type="radio" name="proj" checked={picked === p.id} onChange={() => setPicked(p.id)} />
                      <span className="text-sm">{p.name}</span>
                    </label>
                  ))}
                </div>
              )}
              <div><label className="block text-sm font-medium mb-1">新建项目</label>
                <div className="flex gap-2">
                  <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="例如：我的第一个项目" className={inputCls} />
                  <button onClick={createProject} disabled={busy} className="shrink-0 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">创建</button>
                </div>
              </div>
              <div className="flex justify-between">
                <button onClick={() => setStep(1)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">上一步</button>
                <button onClick={() => goTemplates()} disabled={!picked} className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">下一步</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-gray-900"><Rocket className="w-4 h-4" /><h2 className="font-semibold">跑出第一个成果</h2></div>
              <p className="text-xs text-gray-500">选一个开箱模板，工蚁会自动拆解并执行——这是你的第一个成果。</p>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {templates.map((t) => (
                  <label key={t.id} className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer ${pickedTpl === t.id ? 'border-blue-500 bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <input type="radio" name="tpl" className="mt-1" checked={pickedTpl === t.id} onChange={() => setPickedTpl(t.id)} />
                    <span><span className="text-sm font-medium">{t.name}</span><span className="block text-xs text-gray-500">{t.description}</span></span>
                  </label>
                ))}
                {templates.length === 0 && <p className="text-sm text-gray-400">暂无可用模板。</p>}
              </div>
              {/* M4（《道德经·六十三章》为之于未有）：缺可用 chat 模型时**前置如实标注**——任务照建，但成果可能出不来。
                  与②"仍要继续"同一纪律：**不禁用**按钮（不假装通过，也不阻断）。 */}
              {probe.phase === 'done' && !probe.hasChat && (
                <p className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>当前无可用 chat 模型——任务会创建，但**可能跑不出成果**（执行侧选不到模型会如实记 no_model）。回第 ② 步：在配置区为该模型填写端点与 Key。</span>
                </p>
              )}
              <div className="flex justify-between">
                <button onClick={() => setStep(2)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">上一步</button>
                <button onClick={runFirstTask} disabled={busy || !pickedTpl} className="flex items-center gap-1 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}创建并开始
                </button>
              </div>
            </div>
          )}

          {err && <p className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        </div>

        <p className="text-center mt-4">
          <button onClick={() => { invalidateNeedsSetup(); navigate('/preferences-wizard'); }} className="text-xs text-gray-400 hover:text-gray-600">已完成设置？前往偏好向导 →</button>
        </p>
      </div>
    </div>
  );
}
