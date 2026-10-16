import { useState, useEffect } from 'react';
import { invoke } from '../lib/ipc';
// zx_20261005 M8: 许可读写走专用通道（激活须验签落库，不经通用 settings:set）；`LicenseState` 取 main 侧真源。
import { license as licenseApi, IpcError, nodes as nodesApi, sample as sampleApi } from '../lib/ipc';
// zx_20261005 M21: ANS 缺省地址**单一真源**在 shared-types；renderer 经 `ans:defaults` 过桥取（不直引包）。
import { ans as ansApi } from '../lib/ipc';
import type { LicenseState } from '../../../src/main/core/license.js';
// zx_20261005 M11: 定价与权益同引 main 侧**唯一真源**（`core/pricing.ts`）——渲染层不自带价格字面量。
import type { PricingPayload } from '../../../src/main/core/pricing.js';
import { Monitor, Cpu, HardDrive, RefreshCw, Lock, Check, Globe, Save, Bell, Package, GitBranch, Shield, ShieldCheck } from 'lucide-react';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——读写同一口径，防"写 '0' 而读只认 'false'"
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// zx_20260924 M6-c: 成本上限的**键名**同样不手抄——读端（`readMaxCostPer1k`）在哪，键就在哪
import { MAX_COST_PER_1K_KEY } from '../../../src/main/core/model-request.js';
// zx_20261012_2 批一（策略可配）: 五个 policy.* 数值键的**名单**与主进程共用同一份零依赖模块
//   （`policy-config` 经 `policy-engine → logger(pino)` 带 node 依赖，渲染层不可引；故键名独立成 `policy-keys`）。
import { POLICY_OVERRIDES } from '../../../src/main/core/policy-keys.js';

// 购买入口与各档定价由 main 侧 `core/pricing.ts` 一处供（经 `license:pricing` 过桥）——
// 渲染层**不再**自带价格字面量或 URL（改价只改真源一处；承 M21「第二落点」纪律）。

export default function SettingsPage() {
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [pwForm, setPwForm] = useState({ oldPassword: '', newPassword: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [pwOk, setPwOk] = useState(false);
  const [ansConfig, setAnsConfig] = useState({ ans_server_url: '', ans_api_key: '', ans_secret_key: '' });
  const [ansLoaded, setAnsLoaded] = useState(false);
  const [ansSaved, setAnsSaved] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  // A2 (2026-09-03): 桌面原生通知开关
  const [sysNotif, setSysNotif] = useState(true);
  // zx_20260906 批4 (4c): 全局免打扰总开关（六路降为一路中心记录——通知中心/铃点/需处理仍记录，不弹不响）
  const [dnd, setDnd] = useState(false);
  // B1 (2026-09-03_2): 免打扰时段
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  // C1 (2026-09-04_2): 安静时段是否连"失败/需输入"应用内 toast 也静音（原生仍守中弹）
  const [quietMuteCritical, setQuietMuteCritical] = useState(false);
  // D2 (2026-09-04_2): 提示音（全局 + 分事件类）
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [snd, setSnd] = useState({ completed: true, failed: true, await: true });
  // zx_20260909 X2④(道德经·有无相生 / 王阳明·知行合一): 成果展示开关组——deliverable.* 键此前无 GUI 只能 DB 直改(回退"标而不准"), 本组让其真实可点
  const DELIV_OPTS: Array<{ key: string; label: string; desc: string; mainConsumed?: boolean }> = [
    { key: 'show_delivery_digest', label: '本阶段成果交付单', desc: '项目详情顶部成果交付单卡（里程碑/主要成果/已验收/高质）。' },
    { key: 'digest_window_switch', label: '交付单时间窗切换', desc: '交付单 全部/近30/近7 切换条（false=回 all-time）。' },
    { key: 'primary_marker', label: '★主要成果标记', desc: '产出物页/抽屉/交付单的 ★ 置主与展示。' },
    { key: 'primary_auto', label: 'finalize 自动置 primary', desc: '验收全过后自动把最新 doc 置主要成果（人工仍可撤）。主进程消费，下一任务收口生效。', mainConsumed: true },
    { key: 'show_acceptance', label: '验收徽标(✓已验收)', desc: '产出物列表/交付单/抽屉的验收证据透出；false 时两入口(list/digest/preview)一致隐藏。' },
    { key: 'per_doc_acceptance', label: '验收按产出物逐条显示', desc: '同一任务多 doc 各显各的 ✓（验收后才补的 doc 不显）；关=回落整任务扇出。主进程消费，下一收口生效。', mainConsumed: true },
    { key: 'task_achievement_summary', label: '任务列表成果摘要', desc: '任务列表行「成果N·✓验收p/t·★主」chip。' },
    { key: 'doc_drawer', label: '就地成果详情抽屉', desc: '交付单/最近产出物/任务详情/命令面板点 doc 就地展开版本流·验收·溯源。' },
  ];
  const [delivOpts, setDelivOpts] = useState<Record<string, boolean>>(Object.fromEntries(DELIV_OPTS.map((o) => [o.key, true])));
  // zx_20260909_1 补⑤(§十三): IM 通知开关组——im.* 键此前无 GUI 只能 DB 直改
  const IM_OPTS: Array<{ key: string; label: string; desc: string }> = [
    { key: 'notify_to_creator', label: '关键通知只发给任务创建人', desc: '完成/失败通知投给任务创建人（无 IM 来源的任务回落最近 1:1 私聊）。关=回落旧「全渠道广播」（多渠道部署会把通知发给非创建人）。' },
    { key: 'notify_pause_needed', label: '需人工介入暂停时通知', desc: 'agent 判定需人介入的暂停（硬暂停/无进展/内容不充分/partial 悬置）推 ⚠️ 给创建人；用户主动暂停（GUI/托盘）不推。' },
  ];
  const [imOpts, setImOpts] = useState<Record<string, boolean>>(Object.fromEntries(IM_OPTS.map((o) => [o.key, true])));
  const [outboxRetryMin, setOutboxRetryMin] = useState('10');
  // zx_20261012_2 批一(策略可配): 策略引擎——阈值/窗口此前写死在源码、GUI 无处可调（只能 DB 直改）。
  //   键名名单与主进程**共用**（`POLICY_OVERRIDES`）；中文标签在此（用户可见文案，第二落点）。
  const POLICY_NUM_LABELS: Record<string, { label: string; desc: string; min: number; max: number }> = {
    'policy.cascade_fail_threshold': { label: '熔断：近期失败数阈值', desc: '项目「最近 N 个任务」中失败数达到此值 ⇒ 暂停新任务（N 见下一条）。', min: 1, max: 9999 },
    'policy.cascade_fail_window': { label: '熔断：统计窗口（最近 N 个任务）', desc: '只数最近 N 个任务的失败数。此前该窗口写了却从不生效（数的是全时段），历史失败会误触熔断致新任务开跑即停。', min: 1, max: 9999 },
    'policy.notify_fail_threshold': { label: '通知：近期失败数阈值', desc: '项目近期失败数达到此值 ⇒ 记一条策略通知（不暂停任务）。', min: 1, max: 9999 },
    'policy.notify_fail_window': { label: '通知：统计窗口（最近 N 个任务）', desc: '只数最近 N 个任务的失败数。', min: 1, max: 9999 },
    'policy.budget_tokens': { label: 'Token 预算上限', desc: '任务 Token 消耗上限。当前在「执行前」评估（此刻消耗必为 0）⇒ 该闸实际从不触发，属在册待改项。', min: 0, max: 999999999 },
  };
  const [policyCheck, setPolicyCheck] = useState(true);
  const [policyNums, setPolicyNums] = useState<Record<string, string>>({});
  // zx_20261013_1 批一（称器于事）: 能力硬需把关开关（缺省即开）。开 ⇒ 最终在用模型缺本任务**硬需**能力
  //   （vision/chat/function-calling）则如实拒；关 ⇒ 逐字回"只记不拦"旧行为（一键回退）。真源 `core/settings-bool.ts`。
  const [capGate, setCapGate] = useState(true);
  // zx_20260924 M6-c: 模型选型成本上限（美元/1k tokens）的**写端**。
  //   此前该键只有读端（`readMaxCostPer1k`，由 `exec-model-select` 喂进 ANS 的 `maxCostPer1k`），
  //   GUI 无处可点 ⇒ 成本闸实际上是一条"装好了却没人能上电"的线。此处补上入口。
  const [maxCostPer1k, setMaxCostPer1k] = useState('');
  // zx_20261005 M8: 许可状态 / 输入 / 结果提示 + 应用版本（版本取 `app.getVersion()`，不再手写字面量）。
  const [lic, setLic] = useState<LicenseState | null>(null);
  const [licInput, setLicInput] = useState('');
  const [licMsg, setLicMsg] = useState('');
  const [licBusy, setLicBusy] = useState(false);
  // zx_20261012_1 批四: 示例项目一键载入/删除（与真实数据隔离；真逻辑在 main 侧 core/sample-project.ts）。
  const [sampleMsg, setSampleMsg] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  // zx_20261005 M11: 定价与权益（真源 main `core/pricing.ts`）；读不到就整块不显示，不摆空壳价。
  const [pricing, setPricing] = useState<PricingPayload | null>(null);
  // zx_20261005 M21: ANS 缺省地址（来自 `ans:defaults` 的单一真源，作未配置时的 fallback / placeholder）。
  const [ansDefaultUrl, setAnsDefaultUrl] = useState('');
  // zx_20261005 M16: 三态判据（未配置 / 已配置 / 开发态）——由 main 侧 `ans:status` 过桥。
  //   渲染层**不自行推断**"配没配"（否则是同一判据的第二个落点，两侧漂开即名实不符）。
  const [ansStatus, setAnsStatus] = useState<{ configured: boolean; isDev: boolean } | null>(null);
  // zx_20261011_4 M4: 多机协同**编排模式**（本机设置 `node.orchestrate_mode`）。词表由 main 一处真源给
  //   （`nodes:orchestrate-mode` 随读回传 `modes`）——本页只按它摆选项，不手抄 `off`/`auto`。
  const [orchMode, setOrchMode] = useState('off');
  const [orchModes, setOrchModes] = useState<string[]>([]);
  const ORCH_LABEL: Record<string, string> = {
    off: '关闭（默认）—— 全部在本机跑',
    auto: '自动外派 —— 本机并发占满时把溢出的就绪子任务派给他机',
  };

  const reloadLicense = async () => {
    try { setLic(await licenseApi.status()); } catch { /* 读不到就留空态，不打断设置页 */ }
  };
  useEffect(() => {
    void reloadLicense();
    licenseApi.appVersion().then(setAppVersion).catch(() => { /* 浏览器态无此通道 */ });
    licenseApi.pricing().then(setPricing).catch(() => { /* 浏览器态无此通道 */ });
  }, []);

  async function handleActivateLicense() {
    const text = licInput.trim();
    if (!text) { setLicMsg('请先粘贴许可文本'); return; }
    setLicBusy(true); setLicMsg('');
    try {
      const next = await licenseApi.activate(text);
      setLic(next); setLicInput(''); setLicMsg(`✓ 已激活：${next.tierLabel}`);
    } catch (e) {
      // 坏件如实回原因（`IpcError.code === 'LICENSE_INVALID'` 时 message 即校验结论）
      setLicMsg(`${e instanceof IpcError ? '' : '激活失败：'}${(e as Error).message}`);
    } finally { setLicBusy(false); }
  }

  // 加载 ANS 配置 + 桌面通知开关
  useEffect(() => {
    (async () => {
      try {
        // zx_20261005 M21: 未配置时的 fallback 取 `ans:defaults`（单一真源），不再手抄 localhost:3001——
        //   否则改端口后此处会显示一个**已不存在**的地址（名实不符）。
        const defUrl = await ansApi.defaults().then((d) => d.baseUrl).catch(() => '');
        setAnsDefaultUrl(defUrl);
        // zx_20261005 M16: 三态由 main 侧 `ans:status` 给（真源在 `resolveAnsCreds`+形态开关，不在此自判）。
        ansApi.status().then((s) => setAnsStatus({ configured: !!s.configured, isDev: !!s.isDev })).catch(() => {});
        const all = await invoke<Record<string,string>>('settings:getAll') as unknown as Record<string,string>;
        // zx_20261005 M16: **不再**用开发凭据兜底（`||` 到 dev 缺省）——那是 dev 缺省在渲染层的
        //   第二个落点：生产构建里它会把开发凭据 **预填给用户**（本 M16 要拦的正是这件事）。
        //   表单缺省改为空串；开发态的 dev 缺省由 main 侧首启种子(`ansSeedCreds`)写库、此处 `all.*` 自然读到。
        if (all) setAnsConfig({ ans_server_url: all.ans_server_url || defUrl, ans_api_key: all.ans_api_key || '', ans_secret_key: all.ans_secret_key || '' });
        setSysNotif((all.ui_system_notifications ?? '1') !== '0');
        setDnd(all.ui_dnd === '1');
        setQuietStart(all.notify_quiet_start || '');
        setQuietEnd(all.notify_quiet_end || '');
        setQuietMuteCritical(all.notify_quiet_mute_critical === '1');
        setSoundEnabled((all.notify_sound_enabled ?? '1') !== '0');
        setSnd({ completed: (all.sound_completed ?? '1') !== '0', failed: (all.sound_failed ?? '1') !== '0', await: (all.sound_await ?? '1') !== '0' });
        // zx_20260909 X2④: 成果展示开关组装载(deliverable.* 点号键; 缺省视为 true)
        // zx_20260910_3 M3(G3): 判据改用与 main/渲染各页共用的唯一实现 boolSetting——
        // 它同时认 'false' 与历史写法的 '0'(旧写端曾落 '0'/'1', show_acceptance 残留 '0' 即此故)，开关才不再"关而不灭"
        const dl: Record<string, boolean> = {};
        for (const o of DELIV_OPTS) dl[o.key] = boolSetting(all[`deliverable.${o.key}`]);
        setDelivOpts(dl);
        // zx_20260909_1 补⑤: IM 通知组(im.* 点号键; 布尔键缺省 true, 写 'true'/'false'; 补发窗口为分钟数, 0=关)
        const im: Record<string, boolean> = {};
        for (const o of IM_OPTS) im[o.key] = boolSetting(all[`im.${o.key}`]);
        setImOpts(im);
        setOutboxRetryMin(all['im.outbox_retry_min'] ?? '10');
        // zx_20261012_2 批一: 策略闸开关 + 五个 policy.* 数值(键名取自共用名单; 读不到留空=内置缺省)
        setPolicyCheck(boolSetting(all['engine.policy_check']));
        // zx_20261013_1 批一: 能力把关开关（同 `boolSetting` 一处真源；缺省即开）
        setCapGate(boolSetting(all['engine.model_capability_gate']));
        const pn: Record<string, string> = {};
        for (const o of POLICY_OVERRIDES) pn[o.key] = all[o.key] ?? '';
        setPolicyNums(pn);
        setMaxCostPer1k(all[MAX_COST_PER_1K_KEY] ?? '');
        // zx_20261011_4 M4: 编排模式（词表随读回传；取不到就留空态，不下发假模式）
        nodesApi.orchestrateMode().then((r) => { setOrchMode(r.mode); setOrchModes(Array.isArray(r.modes) ? r.modes : []); }).catch(() => { /* 浏览器态无此通道 */ });
      } catch {} finally { setAnsLoaded(true); }
    })();
  }, []);

  const toggleSysNotif = async (on: boolean) => {
    setSysNotif(on);
    try { await invoke('settings:set', 'ui_system_notifications', on ? '1' : '0'); } catch {}
  };
  const toggleDnd = async (on: boolean) => {
    setDnd(on);
    try { await invoke('settings:set', 'ui_dnd', on ? '1' : '0'); } catch {}
  };

  const setQuietHour = async (which: 'start' | 'end', v: string) => {
    if (which === 'start') setQuietStart(v); else setQuietEnd(v);
    try { await invoke('settings:set', which === 'start' ? 'notify_quiet_start' : 'notify_quiet_end', v); } catch {}
  };
  const toggleQuietMuteCritical = async (on: boolean) => {
    setQuietMuteCritical(on);
    try { await invoke('settings:set', 'notify_quiet_mute_critical', on ? '1' : '0'); } catch {}
  };
  const toggleSoundGlobal = async (on: boolean) => {
    setSoundEnabled(on);
    try { await invoke('settings:set', 'notify_sound_enabled', on ? '1' : '0'); } catch {}
  };
  const toggleSoundClass = async (cls: 'completed' | 'failed' | 'await', on: boolean) => {
    setSnd((p) => ({ ...p, [cls]: on }));
    const key = { completed: 'sound_completed', failed: 'sound_failed', await: 'sound_await' }[cls];
    try { await invoke('settings:set', key, on ? '1' : '0'); } catch {}
  };
  const toggleDeliv = async (key: string, on: boolean) => {
    setDelivOpts((p) => ({ ...p, [key]: on }));
    // M5 实机复核修: 写 'true'/'false'(deliverable.* 消费方按 !=='false' 判定); 写 '0'/'1' 会致关闭不生效
    try { await invoke('settings:set', `deliverable.${key}`, on ? 'true' : 'false'); } catch {}
  };
  const toggleIm = async (key: string, on: boolean) => {
    setImOpts((p) => ({ ...p, [key]: on }));
    // 与 deliverable.* 同口径: 消费方按 !=='false' 判定, 故写 'true'/'false'(写 '0'/'1' 会致关闭不生效)
    try { await invoke('settings:set', `im.${key}`, on ? 'true' : 'false'); } catch {}
  };
  const commitOutboxMinutes = async (raw: string) => {
    const v = Math.max(0, Math.min(1440, Math.floor(Number(raw) || 0)));
    setOutboxRetryMin(String(v));
    try { await invoke('settings:set', 'im.outbox_retry_min', String(v)); } catch {}
  };
  // zx_20261012_2 批一: 策略闸开关 + 数值提交口（照 `commitOutboxMinutes` 手法：受控输入 + 失焦提交 + 回写钳位值）。
  //   空串**不**当 0——按"用内置缺省"办（主进程 `readNumberSetting` 读空即回落 `DEFAULT_POLICIES` 同名字段）。
  const togglePolicyCheck = async (on: boolean) => {
    setPolicyCheck(on);
    try { await invoke('settings:set', 'engine.policy_check', on ? 'true' : 'false'); } catch {}
  };
  // zx_20261013_1 批一: 能力把关开关（`engine.model_capability_gate`，缺省即开；写 'true'/'false' 与消费端一致）。
  const toggleCapGate = async (on: boolean) => {
    setCapGate(on);
    try { await invoke('settings:set', 'engine.model_capability_gate', on ? 'true' : 'false'); } catch {}
  };
  const commitPolicyNum = async (key: string, raw: string, min: number, max: number) => {
    const t = raw.trim();
    const n = Number(t);
    const v = t === '' || !Number.isFinite(n) ? '' : String(Math.max(min, Math.min(max, Math.floor(n))));
    setPolicyNums((p) => ({ ...p, [key]: v }));
    try { await invoke('settings:set', key, v); } catch {}
  };
  /**
   * zx_20260924 M6-c: 成本上限的提交口。与 `commitOutboxMinutes` 同形（受控输入 + 失焦提交 + 回写规范化后的值）。
   *
   * 判据与**读端 `readMaxCostPer1k` 同口径**：空 / 非数 / ≤0 一律按"未配置"办（**键写空串**）。
   *   特别地 `0` **不**是"不限"、也不能当上限用——ANS 侧 `(input+output) <= 0` 是"只要免费模型"，
   *   手滑写个 0 会把整池付费模型一次筛没（这正是读端宁 `undefined` 也不返回 0 的原因）。
   */
  /**
   * zx_20261011_4 M4: 编排模式的提交口。写口过 main（`nodes:set-orchestrate-mode`）校验并落库；
   *   失败（含非法值）则**回滚本地显示**（不把"没写进去"显示成"已切过去"）。
   */
  const commitOrchMode = async (mode: string) => {
    const prev = orchMode;
    setOrchMode(mode);
    try { await nodesApi.setOrchestrateMode(mode); } catch { setOrchMode(prev); }
  };
  const commitMaxCostPer1k = async (raw: string) => {
    const n = Number(raw);
    const v = Number.isFinite(n) && n > 0 ? String(n) : '';
    setMaxCostPer1k(v);
    try { await invoke('settings:set', MAX_COST_PER_1K_KEY, v); } catch {}
  };
  const Switch = ({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) => (
    <button type="button" role="switch" aria-checked={on} onClick={() => onToggle(!on)} className={`relative w-9 h-5 shrink-0 rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-gray-300'}`}>
      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );

  const handleSaveAns = async () => {
    try {
      await invoke('settings:set', 'ans_server_url', ansConfig.ans_server_url);
      await invoke('settings:set', 'ans_api_key', ansConfig.ans_api_key);
      await invoke('settings:set', 'ans_secret_key', ansConfig.ans_secret_key);
      setAnsSaved(true); setTimeout(() => setAnsSaved(false), 2000);
    } catch {}
  };

  const handleInstallSample = async () => {
    if (sampleBusy) return;
    setSampleBusy(true); setSampleMsg('载入中…');
    try {
      const r = await sampleApi.install();
      setSampleMsg(r.created ? '示例项目已载入——到「项目」页即可看到。' : '示例项目已存在，未重复载入。');
    } catch (e) { setSampleMsg(`载入失败：${(e as Error).message}`); }
    setSampleBusy(false);
  };

  const handleRemoveSample = async () => {
    if (sampleBusy) return;
    setSampleBusy(true); setSampleMsg('删除中…');
    try {
      const r = await sampleApi.remove();
      setSampleMsg(r.removed ? '示例项目已删除（含落盘产出物）。' : '未找到示例项目，无需删除。');
    } catch (e) { setSampleMsg(`删除失败：${(e as Error).message}`); }
    setSampleBusy(false);
  };

  const handleCheckUpdate = async () => {
    if (!window.electronAPI?.isElectron) { setUpdateMsg('仅桌面端支持'); return; }
    setChecking(true); setUpdateMsg('检查中...');
    try {
      const r = await window.electronAPI.checkForUpdates();
      // 无更新通道时 main 如实返回原因——照实上屏，不写"检查中"了事
      if (r && r.started === false) setUpdateMsg(r.reason || '未配置更新通道');
      else setUpdateMsg('已触发检查，如有新版本会提示');
    } catch (e) { setUpdateMsg((e as Error).message); }
    setChecking(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault(); setPwMsg(''); setPwOk(false);
    try {
      const token = await window.electronAPI?.getToken();
      if (!token) { setPwMsg('未登录'); return; }
      const parts = token.split('.'); const payload = JSON.parse(atob(parts[1]!));
      const result = await invoke<{ success?: boolean; error?: string }>('auth:changePassword', { userId: payload.sub, oldPassword: pwForm.oldPassword, newPassword: pwForm.newPassword }) as { success?: boolean; error?: string };
      if ((result as { success?: boolean }).success) { setPwOk(true); setPwMsg('密码修改成功'); setPwForm({ oldPassword: '', newPassword: '' }); }
      else setPwMsg((result as { error?: string }).error || '修改失败');
    } catch (e) { setPwMsg((e as Error).message); }
  };

  return (
    <div><h2 className="text-xl font-bold mb-6">设置</h2>
      <div className="space-y-6 max-w-2xl">
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Lock className="w-4 h-4"/>修改密码</h3>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div><label className="block text-sm font-medium mb-1">当前密码</label><input type="password" value={pwForm.oldPassword} onChange={e => setPwForm({...pwForm,oldPassword:e.target.value})} required className="w-full max-w-xs px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div>
            <div><label className="block text-sm font-medium mb-1">新密码</label><input type="password" value={pwForm.newPassword} onChange={e => setPwForm({...pwForm,newPassword:e.target.value})} required className="w-full max-w-xs px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div>
            {pwMsg && <p className={`text-sm ${pwOk?'text-green-600':'text-red-500'}`}>{pwMsg}</p>}
            <button type="submit" className={`flex items-center gap-1 px-4 py-2 rounded-lg text-sm text-white transition-colors ${pwOk?'bg-green-600':'bg-blue-600 hover:bg-blue-700'}`}>{pwOk?<><Check className="w-3.5 h-3.5"/>已修改</>:'修改密码'}</button>
          </form>
        </div>
        {/* ANS 服务配置 */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Globe className="w-4 h-4"/>ANS 服务配置</h3>
          {!ansLoaded ? <p className="text-sm text-gray-400">加载中...</p> : <div className="space-y-3">
            {/* zx_20261005 M16: 凭据三态如实上屏——未配置是**生产首启的正常态**，须引导而非沉默 */}
            {ansStatus && (ansStatus.configured
              ? null
              : (ansStatus.isDev
                ? <p className="text-xs text-gray-400">开发构建：未配置时使用内置开发凭据（dev-key / dev-secret，仅本机 ANS）。</p>
                : <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">尚未配置 ANS 凭据，无法连接 ANS 资源服务。请填写下方 API Key 与 Secret Key（发布构建不使用内置开发凭据）。</p>))}
            <div><label className="block text-sm font-medium mb-1">服务地址</label><input value={ansConfig.ans_server_url} onChange={e=>setAnsConfig({...ansConfig,ans_server_url:e.target.value})} className="w-full max-w-md px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder={ansDefaultUrl || 'http://localhost:27183'}/></div>
            <div><label className="block text-sm font-medium mb-1">API Key</label><input value={ansConfig.ans_api_key} onChange={e=>setAnsConfig({...ansConfig,ans_api_key:e.target.value})} className="w-full max-w-md px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"/></div>
            <div><label className="block text-sm font-medium mb-1">Secret Key</label><div className="flex items-center gap-2"><input type={showSecret?'text':'password'} value={ansConfig.ans_secret_key} onChange={e=>setAnsConfig({...ansConfig,ans_secret_key:e.target.value})} className="w-full max-w-md px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"/><button onClick={()=>setShowSecret(!showSecret)} className="text-xs text-gray-400 hover:text-gray-600">{showSecret?'隐藏':'显示'}</button></div></div>
            <button onClick={handleSaveAns} className={`flex items-center gap-1 px-4 py-2 rounded-lg text-sm text-white transition-colors ${ansSaved?'bg-green-600':'bg-blue-600 hover:bg-blue-700'}`}>{ansSaved?<><Check className="w-3.5 h-3.5"/>已保存（即时生效）</>:'保存配置'}</button>
            <p className="text-xs text-gray-400">修改后立即生效，所有 ANS 资源页面将使用新配置重连。</p>
          </div>}
        </div>

        {/* A2 (2026-09-03): 桌面原生通知开关 */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Bell className="w-4 h-4"/>桌面通知</h3>
          {/* zx_20260906 批4 (4c): 全局免打扰总开关——六路(OS横幅/toast/声音/铃点/dock/需处理)降为一路中心记录 */}
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">免打扰总开关</p>
              <p className="text-xs text-gray-400 mt-1">开启后不再弹原生横幅 / 应用内 toast / 提示音；事件仍记录到通知中心·铃点·需处理列表（中心记录不丢）。改动即时生效。</p>
            </div>
            <button type="button" role="switch" aria-checked={dnd} onClick={() => toggleDnd(!dnd)} className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${dnd ? 'bg-blue-600' : 'bg-gray-300'}`}>
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${dnd ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">关键事态原生系统通知</p>
              <p className="text-xs text-gray-400 mt-1">聚焦窗口时以应用内提示为主（不弹系统横幅）；失焦/最小化时弹系统横幅（归一主通道）。任务失败 / 等待输入即时；完成仅在离开窗口时弹；正在观看该任务不打扰。</p>
            </div>
            <button type="button" role="switch" aria-checked={sysNotif} onClick={() => toggleSysNotif(!sysNotif)} className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${sysNotif ? 'bg-blue-600' : 'bg-gray-300'}`}>
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${sysNotif ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-3">仅桌面端生效；开关即时生效，无需重启。</p>
          {/* B1 (2026-09-03_2): 免打扰时段（完成类不弹，仅记录；失败/需输入仍弹） */}
          <div className="mt-4 pt-3 border-t border-gray-100">
            <p className="text-sm font-medium mb-1">免打扰时段</p>
            {/* C1 (2026-09-04_2): 免打扰2.0——运行中即时生效（settings.changed 推送），描述更新 */}
            <p className="text-xs text-gray-400 mb-2">该时段内任务完成不弹原生通知/应用内 toast（仍记录到通知中心）；失败与"需你输入"仍弹（守中）。设置改动即时生效，无需重启。</p>
            <div className="flex items-center gap-2 text-sm">
              <input type="time" value={quietStart} onChange={(e) => setQuietHour('start', e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <span className="text-gray-400">—</span>
              <input type="time" value={quietEnd} onChange={(e) => setQuietHour('end', e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <button type="button" onClick={() => { setQuietHour('start', ''); setQuietHour('end', ''); }} className="text-xs text-gray-400 hover:text-gray-600 px-2">清除（停用）</button>
            </div>
            {/* C1 (2026-09-04_2): 安静时段关键态应用内静音选项（打扰矩阵可选项） */}
            <div className="mt-3 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">安静时段内也静音"失败/需输入"应用内提示</p>
                <p className="text-xs text-gray-400 mt-0.5">原生系统通知仍会弹出（关键事态守中）；仅收敛应用内 toast。勾选后即刻生效。</p>
              </div>
              <button type="button" role="switch" aria-checked={quietMuteCritical} onClick={() => toggleQuietMuteCritical(!quietMuteCritical)} className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${quietMuteCritical ? 'bg-blue-600' : 'bg-gray-300'}`}>
                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${quietMuteCritical ? 'translate-x-5' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        {/* D2 (2026-09-04_2): 提示音（全局 + 分事件类，运行中即时生效；系统通知/应用内 toast 均受控） */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Bell className="w-4 h-4"/>提示音</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div><p className="text-sm font-medium">提示音总开关</p><p className="text-xs text-gray-400 mt-0.5">关闭后原生系统通知与应用内 toast 均无声（仍会弹出）；改动即时生效。</p></div>
              <Switch on={soundEnabled} onToggle={toggleSoundGlobal} />
            </div>
            <div className="pt-3 border-t border-gray-100 space-y-2">
              <p className="text-xs text-gray-400">按事件类静音（默认全开）：</p>
              {[{ k: 'completed' as const, l: '任务完成' }, { k: 'failed' as const, l: '任务失败' }, { k: 'await' as const, l: '等待你输入' }].map(({ k, l }) => (
                <div key={k} className="flex items-center justify-between gap-4">
                  <p className="text-sm text-gray-600">{l}</p>
                  <Switch on={snd[k]} onToggle={(v) => toggleSoundClass(k, v)} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* zx_20260909 X2④(道德经·有无相生 / 王阳明·知行合一): 成果展示开关组——deliverable.* 可回退真实可点 */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Package className="w-4 h-4"/>成果展示</h3>
          <p className="text-xs text-gray-400 mb-3">控制「主要成果」在交付单 / 产出物列表 / 任务列表 / 就地抽屉中的呈现。renderer 即时生效；primary_auto 等主进程消费键在下一任务收口生效。</p>
          <div className="space-y-3">
            {DELIV_OPTS.map((o) => (
              <div key={o.key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{o.label}{o.mainConsumed && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span>}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{o.desc}</p>
                </div>
                <Switch on={!!delivOpts[o.key]} onToggle={(v) => toggleDeliv(o.key, v)} />
              </div>
            ))}
          </div>
        </div>

        {/* zx_20260924 M6-c: 模型选型成本上限——此前只有读端无写端（GUI 无处可点，只能 DB 直改） */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Cpu className="w-4 h-4"/>模型选型</h3>
          <p className="text-xs text-gray-400 mb-3">向 ANS 申请模型时附带的成本上限；ANS 按「输入+输出单价之和 ≤ 该值」筛模型。主进程消费，下一个任务生效。
            {/* zx_20261013_2 批四（维特根斯坦·语言游戏）:「美元」在「模型单价」与「任务预算」**两场游戏**里指的不是一回事，
                此前同页两处金额各用一词却都叫"成本/费用上限"，用户无从分辨。此处说清是哪一场——**不改币种**：
                ANS 定价基准本就是美元，把显示改人民币而底层仍按美元筛＝名实不符（正是本仓反复点名的病）。 */}
            <br/>币种说明：这里的「美元」是**模型的单位价格**（ANS 定价基准即美元），<span className="text-gray-500">与任务/项目预算的「¥ 人民币」是两回事</span>——这一栏筛的是模型贵不贵，不是本任务能花多少钱。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">模型单价上限（美元 / 1k tokens，按 ANS 定价）<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">留空 = 不设上限（所有在册模型都参与匹配）。填 <span className="font-mono">0</span> 不是「不限」而是「只要免费模型」，会把付费模型一次筛没，故按未配置处理；非数字同样按未配置处理。</p>
            </div>
            <input
              type="number" min={0} step="0.001" value={maxCostPer1k} placeholder="未配置"
              onChange={(e) => setMaxCostPer1k(e.target.value)}
              onBlur={(e) => commitMaxCostPer1k(e.target.value)}
              className="w-28 px-2 py-1 border rounded text-sm text-right"
            />
          </div>
        </div>

        {/* zx_20261012_2 批一(策略可配): 策略引擎——阈值/窗口此前写死在源码，GUI 无处可调（只能 DB 直改） */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Shield className="w-4 h-4"/>策略引擎</h3>
          <p className="text-xs text-gray-400 mb-3">任务「执行前」的策略闸：项目近期失败过多则暂停/通知。主进程消费，下一个任务生效。留空 = 用内置缺省。</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">启用策略闸<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                <p className="text-xs text-gray-400 mt-0.5">关 ⇒ 不读失败数、不评估任何策略（一键回退旧行为）。</p>
              </div>
              <Switch on={policyCheck} onToggle={togglePolicyCheck} />
            </div>
            {POLICY_OVERRIDES.map((o) => {
              const m = POLICY_NUM_LABELS[o.key];
              const min = m?.min ?? 0;
              const max = m?.max ?? 99999;
              return (
                <div key={o.key} className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{m?.label ?? o.key}<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                    {m?.desc && <p className="text-xs text-gray-400 mt-0.5">{m.desc}</p>}
                  </div>
                  <input
                    type="number" min={min} max={max} value={policyNums[o.key] ?? ''} placeholder="内置缺省"
                    onChange={(e) => setPolicyNums((p) => ({ ...p, [o.key]: e.target.value }))}
                    onBlur={(e) => commitPolicyNum(o.key, e.target.value, min, max)}
                    className="w-28 px-2 py-1 border rounded text-sm text-right"
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* zx_20261013_1 批一(称器于事): 模型能力把关——选型后若最终在用模型缺本任务**硬需**能力，如实拒而非静默降级 */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><ShieldCheck className="w-4 h-4"/>模型能力把关</h3>
          <p className="text-xs text-gray-400 mb-3">
            任务「选型定稿」之后、执行之前：若最终在用的模型缺本任务**硬需**能力（vision/chat/function-calling），则**如实拒并写「[选型失败]」**，而不是让装配层省略图片把缺口掩盖过去。软需能力（code/reasoning）缺则允许续跑（如实记账）。主进程消费，下一个任务生效。
          </p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">启用能力把关<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">关 ⇒ 硬需缺也不拦，逐字回「只记不拦」旧行为（一键回退）。</p>
            </div>
            <Switch on={capGate} onToggle={toggleCapGate} />
          </div>
        </div>

        {/* zx_20261011_4 M4: 多机协同**编排模式**——把本机跑不过来的就绪子任务外派给网络里的他机 */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><GitBranch className="w-4 h-4"/>多机协同编排</h3>
          <p className="text-xs text-gray-400 mb-3">缺省关闭（不变更既有行为）。开启后，当本机该项目并发位已占满且仍有就绪子任务时，把溢出的（每拍至多 3 件）外派给协同网络里的他机执行；结果回传后本机如实收口并继续推进依赖链。仅在本机已入网且 Team 档已解锁时生效。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">外派策略<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">「跑得过来就不外派」——本机空闲时一律在本机跑。</p>
            </div>
            <select value={orchMode} onChange={(e) => commitOrchMode(e.target.value)} className="px-2 py-1 border rounded text-sm">
              {(orchModes.length ? orchModes : ['off', 'auto']).map((m) => (<option key={m} value={m}>{ORCH_LABEL[m] ?? m}</option>))}
            </select>
          </div>
        </div>

        {/* zx_20260909_1 补⑤(§十三): IM 通知开关组——im.notify_to_creator/notify_pause_needed/outbox_retry_min 可回退真实可点 */}
        <div className="bg-white rounded-lg border p-6">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Bell className="w-4 h-4"/>IM 通知</h3>
          <p className="text-xs text-gray-400 mb-3">控制任务关键通知（完成 / 失败 / 需人工介入暂停）经 IM 渠道投递给创建人的行为。主进程消费，下一次通知（或下一轮补发扫描）生效。</p>
          <div className="space-y-3">
            {IM_OPTS.map((o) => (
              <div key={o.key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{o.label}<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                  <p className="text-xs text-gray-400 mt-0.5">{o.desc}</p>
                </div>
                <Switch on={!!imOpts[o.key]} onToggle={(v) => toggleIm(o.key, v)} />
              </div>
            ))}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">出站失败补发窗口（分钟）<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                <p className="text-xs text-gray-400 mt-0.5">关键通知发送失败时落账，按 1/2/4 分钟退避重发（至多 3 次）；自落账起超过该窗口仍未达则放弃。0=关闭补发。留空/非法按 0 处理。</p>
              </div>
              <input
                type="number" min={0} max={1440} value={outboxRetryMin}
                onChange={(e) => setOutboxRetryMin(e.target.value)}
                onBlur={(e) => commitOutboxMinutes(e.target.value)}
                className="w-20 px-2 py-1 border rounded text-sm text-right"
              />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border p-6"><h3 className="font-semibold mb-4 flex items-center gap-2"><Package className="w-4 h-4"/>许可与激活</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">当前档位</span><span className="font-medium">{lic?.tierLabel ?? '—'}{lic?.kind === 'trial' && lic.trialDaysLeft != null ? `（试用中，还剩 ${lic.trialDaysLeft} 天）` : ''}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">状态</span><span className="text-gray-600 text-right">{lic?.detail ?? '—'}</span></div>
            {lic?.expiresAt && <div className="flex justify-between"><span className="text-gray-500">到期</span><span className="font-mono">{lic.expiresAt}</span></div>}
            <div className="flex justify-between items-center gap-2">
              <span className="text-gray-500">本机指纹</span>
              <span className="font-mono text-xs flex items-center gap-2">
                {lic?.fingerprint ?? '—'}
                {lic?.fingerprint && (
                  <button
                    onClick={() => { navigator.clipboard?.writeText(lic.fingerprint).then(() => setLicMsg('已复制本机指纹')).catch(() => {}); }}
                    className="text-blue-600 hover:underline"
                  >复制</button>
                )}
              </span>
            </div>
            <p className="text-xs text-gray-400">购买/续期时把「本机指纹」发给签发方（每台机器一个，一份许可最多绑 3 台）。</p>
            <div className="flex justify-between"><span className="text-gray-500">购买 / 升级</span>
              {pricing?.purchaseUrl
                ? <a href={pricing.purchaseUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">前往购买</a>
                : <span className="text-gray-400">入口即将开放</span>}
            </div>

            {/* zx_20261005 M11: 定价与权益——**真源 main `core/pricing.ts`**（价与能力上限同一把尺）。 */}
            {pricing && (
              <div className="pt-3 border-t mt-3">
                <p className="text-xs text-gray-400 mb-2">定价与权益</p>
                <div className="space-y-2">
                  {pricing.tiers.map((t) => {
                    const isCurrent = (lic?.tier ?? 'community') === t.tier;
                    const price = t.priceMonthlyCny === 0 ? '免费' : t.priceYearlyCny > 0 ? `¥${t.priceMonthlyCny}/月 · ¥${t.priceYearlyCny}/年` : `¥${t.priceMonthlyCny}/人/月`;
                    return (
                      <div key={t.tier} className={`rounded-lg border px-3 py-2 ${isCurrent ? 'border-blue-300 bg-blue-50' : ''}`}>
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium">{t.label}{isCurrent && <span className="ml-1 text-[10px] text-blue-600">当前</span>}</span>
                          <span className="text-sm text-gray-700">{price}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5">能力上限：{t.capability}</p>
                        <p className="text-[11px] text-gray-400">{t.benefits.join(' · ')}</p>
                      </div>
                    );
                  })}
                  <div className="rounded-lg border px-3 py-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium">{pricing.earlyBird.label}<span className="ml-1 text-[10px] text-amber-600">限 {pricing.earlyBird.seats} 名</span></span>
                      <span className="text-sm text-gray-700">¥{pricing.earlyBird.priceCny} 一次性</span>
                    </div>
                    <p className="text-[11px] text-gray-400">{pricing.earlyBird.note}</p>
                  </div>
                </div>
              </div>
            )}
            <div className="pt-3 border-t mt-3">
              <textarea
                value={licInput}
                onChange={(e) => setLicInput(e.target.value)}
                rows={3}
                placeholder="粘贴许可文本（WA-LICENSE-v1.…）"
                className="w-full px-2 py-1 border rounded text-xs font-mono"
              />
              <div className="flex items-center gap-2 mt-2">
                <button onClick={handleActivateLicense} disabled={licBusy} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">{licBusy ? '激活中…' : '激活'}</button>
                {licMsg && <span className="text-xs text-gray-500">{licMsg}</span>}
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border p-6"><h3 className="font-semibold mb-4 flex items-center gap-2"><Package className="w-4 h-4"/>示例项目</h3>
          <p className="text-sm text-gray-500 mb-3">一键载入一份示例（项目 / 任务 / 产出物 / 记忆），用于快速了解工蚁。示例带「示例」徽标，与你的真实数据隔离，可随时一键删除。</p>
          <div className="flex items-center gap-2">
            <button onClick={handleInstallSample} disabled={sampleBusy} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">载入示例项目</button>
            <button onClick={handleRemoveSample} disabled={sampleBusy} className="px-3 py-1.5 border border-red-200 text-red-600 rounded text-sm hover:bg-red-50 disabled:opacity-50">删除示例项目</button>
          </div>
          {sampleMsg && <p className="text-xs text-gray-500 mt-2">{sampleMsg}</p>}
        </div>
        <div className="bg-white rounded-lg border p-6"><h3 className="font-semibold mb-4 flex items-center gap-2"><Monitor className="w-4 h-4"/>系统信息</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">应用版本</span><span className="font-mono">{appVersion || '—'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">架构模式</span><span className="text-blue-600 font-medium">单进程 Electron + IPC</span></div>
            <div className="flex justify-between"><span className="text-gray-500">前端框架</span><span>Vite 6 + React 19 + Tailwind CSS v4</span></div>
            <div className="flex justify-between"><span className="text-gray-500">数据库</span><span>better-sqlite3 (WAL)</span></div>
            <div className="flex justify-between"><span className="text-gray-500">平台</span><span className="font-mono">{window.electronAPI?.platform||'browser'}</span></div>
          </div>
        </div>
        <div className="bg-white rounded-lg border p-6"><h3 className="font-semibold mb-4 flex items-center gap-2"><RefreshCw className="w-4 h-4"/>自动更新</h3>
          <button onClick={handleCheckUpdate} disabled={checking} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${checking?'animate-spin':''}`}/>{checking?'检查中...':'检查更新'}</button>
          {updateMsg && <p className="text-sm text-gray-500 mt-2">{updateMsg}</p>}
        </div>
        <div className="bg-white rounded-lg border p-6"><h3 className="font-semibold mb-4 flex items-center gap-2"><Cpu className="w-4 h-4"/>技术栈</h3>
          <div className="flex flex-wrap gap-2">{['TypeScript','Electron 33','React 19','Vite 6','Tailwind CSS v4','better-sqlite3','Vercel AI SDK v4','JWT (jose)','bcrypt','node-cron'].map(t=>(<span key={t} className="px-2 py-1 bg-gray-100 rounded text-xs font-mono text-gray-600">{t}</span>))}</div>
        </div>
      </div>
    </div>);
}
