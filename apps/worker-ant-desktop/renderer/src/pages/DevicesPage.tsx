/**
 * zx_20261004 M10（周易·观卦「观国之光」/ 黑格尔·合理才存在 / 米勒 7±2）: **设备面板**——让局域网设备"看得见、控得住（且只控被允许的）"。
 *
 * 一屏四事：
 *   - **发现**（M7）：起/停发现（用户显式动作，**不自动扫网**），实时落台账（`device.discovered`）。
 *   - **台账**（M7）：名/类别/协议/地址/是否可控/是否已授权/最近状态——能力**一律设备自述**（庄子·不预设）。
 *   - **授权**（M9·知行合一）：逐设备"允许控制"开关，开才可真下命令（未授权只可读）。
 *   - **控制**（M9）：手动下发 turn_on / turn_off。
 *
 * ⚠ **界面不预判能不能控**：按不按键由服务端 `deviceControlVerdict`（K-6 一处真源）裁定，
 *   被拒时把"为什么 + 如何授权"**原样上屏**——界面不自写第二份判据（"判据两处"即是漂移）。
 *   界面只如实**呈现**台账自带字段（`authorized`/`controllable`）作为提示，不作裁决。
 *
 * zx_20261005 M22（Team 档软闸）：设备发现/控制属 Team 档能力——锁定（`gate.unlocked=false`）时
 *   顶部显示升级提示、发现/授权/控制动作**禁用**；台账仍可见（只读无害）。判据真源在 `core/team-gate.ts`。
 */
import { useState, useEffect, useCallback } from 'react';
import { devices as devicesApi, invoke, type DevicesListPayload } from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
import { FreshnessPill } from '../components/FreshnessPill';
import { formatDbTime } from '../lib/deliverable-view';
import { Router, RefreshCw, Radar, Power, PowerOff, ShieldCheck, ShieldOff, Lock, Radio, Pencil, Home } from 'lucide-react';
// 台账行 / 审计行 / 控制结果形状取自 main 侧零依赖语义模块真源（仅类型，打包期擦除）。
import type { AnsDevice, DeviceActionRow, DeviceControlOutcome, TaskRef } from '../../../src/main/core/device-registry.js';
// zx_20261014_1 批一/批二: "我们叫它什么"（别名优先、回退自述名）——**运行期**取零依赖真源，
//   与 main 侧同一份实现（若各处自写一份，改名后就会出现"面板叫 A、留痕叫 B"）。
import { deviceCallName } from '../../../src/main/core/device-name.js';
// zx_20261013_1 批五: MQTT 配置态形状取自 main 侧零依赖适配层真源（仅类型，打包期擦除）。
import type { MqttStatusPayload } from '../../../src/main/core/device-mqtt.js';

const PROTOCOL_LABEL: Record<string, string> = { mdns: 'mDNS', ssdp: 'SSDP', http: 'HTTP', mqtt: 'MQTT' };

/**
 * zx_20261015_3 批四（道德经·知止不殆）: **在线三态**徽章——`true`=在 / `false`=不在 / `null`=未知。
 * ⚠ **不**用 `last_seen`（"我们何时见过它"）冒充"它此刻在"——没见过可用性上报就如实显"未知"。
 */
function OnlineBadge({ online }: { online: boolean | null }) {
  const [cls, label] = online === true ? ['bg-emerald-50 text-emerald-600', '在']
    : online === false ? ['bg-red-50 text-red-600', '不在']
    : ['bg-gray-100 text-gray-500', '未知'];
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}
      title={online === null ? '设备尚未上报可用性（LWT/avty）——未知，不等于「不在」' : '来自设备可用性事件（LWT/avty 主题），非发现载荷推断'}>
      在线：{label}
    </span>
  );
}

/** 结果徽标：`ok`/`denied`/`error` 三态各一色（被拒**可见**——"全量留痕"含拒绝件）。 */
function ResultBadge({ result }: { result: string }) {
  const cls = result === 'ok' ? 'bg-emerald-50 text-emerald-600'
    : result === 'denied' ? 'bg-amber-50 text-amber-600'
    : 'bg-red-50 text-red-600';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{result}</span>;
}

function DeviceRow({ dev, onChanged, locked }: { dev: AnsDevice; onChanged: () => void; locked: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const status = dev.status as { last_action?: string; last_ok?: boolean; last_result?: string; at?: string } | null;
  // "我们叫它什么"——别名优先、回退设备自述名（与 main 侧同一份实现）。
  const callName = deviceCallName(dev) || dev.address;

  // zx_20261014_1 批二: 改名——写"我叫它什么"（本地别名，非设备自述名）。⚠ **不经 Team 档软闸**：
  //   改名不触网/不下发/不改设备状态，M22 的软闸只管动作出口（discover/authorize/control）。
  async function saveAlias() {
    setBusy('rename'); setMsg(null);
    try {
      await devicesApi.rename(dev.id, aliasDraft);
      setRenaming(false);
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '改名失败' });
    } finally { setBusy(null); }
  }

  async function toggleAuth(next: boolean) {
    setBusy('auth'); setMsg(null);
    try {
      await devicesApi.authorize(dev.id, next);
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '授权失败' });
    } finally { setBusy(null); }
  }

  async function control(action: string) {
    setBusy(action); setMsg(null);
    try {
      const out: DeviceControlOutcome = await devicesApi.control(dev.id, action);
      // 被拒时把服务端的"为什么 + 如何授权"**原样**上屏（不自造第二份文案）。
      setMsg(out.ok
        ? { ok: true, text: `已下发 ${action}：${out.result}` }
        : ('denied' in out ? { ok: false, text: `${out.error} ${out.how_to_authorize}` } : { ok: false, text: out.result }));
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '控制失败' });
    } finally { setBusy(null); }
  }

  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Router className="w-4 h-4 text-gray-400" />
        <span className="font-medium text-sm text-gray-800">{callName}</span>
        {/* 别名在场时附一枚"自述名"小字——两件事并陈，读的人分得清哪个是设备自称、哪个是我们的叫法。 */}
        {dev.alias && dev.name && <span className="text-[10px] text-gray-400" title={`设备自述名：${dev.name}`}>自述：{dev.name}</span>}
        <button onClick={() => { setAliasDraft(dev.alias ?? ''); setRenaming(v => !v); }} disabled={busy != null}
          className="p-0.5 rounded text-gray-300 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-40"
          title={dev.alias ? `重命名（当前别名：${dev.alias}）` : '给这台设备起个名字（后续人工/AI 按此名控制）'}>
          <Pencil className="w-3 h-3" />
        </button>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{dev.kind}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">{PROTOCOL_LABEL[dev.protocol] ?? dev.protocol}</span>
        <span className="text-[11px] text-gray-500 font-mono">{dev.address}{dev.port ? `:${dev.port}` : ''}</span>
        {/* 自述能力提示（如实呈现字段，非裁决）：可控 / 已授权。 */}
        <span className={`text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 ${dev.controllable ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'}`}>
          {dev.controllable ? <><ShieldCheck className="w-3 h-3" />自述可控</> : <><ShieldOff className="w-3 h-3" />仅只读</>}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${dev.authorized ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>{dev.authorized ? '已授权控制' : '未授权'}</span>
        <OnlineBadge online={dev.online} />
        <span className="text-[11px] text-gray-400 ml-auto">最近见到 {formatDbTime(dev.last_seen)}</span>
      </div>

      {renaming && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <input autoFocus value={aliasDraft} onChange={e => setAliasDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void saveAlias();
              else if (e.key === 'Escape') setRenaming(false);
            }}
            placeholder="给这台设备起个名字（留空 = 清除，回到自述名）"
            className="text-xs px-2 py-1 rounded border border-gray-300 w-64" />
          <button onClick={() => void saveAlias()} disabled={busy === 'rename'}
            className="text-[11px] px-2 py-0.5 bg-slate-700 text-white rounded hover:bg-slate-800 disabled:opacity-50">
            {busy === 'rename' ? '保存中…' : '保存'}
          </button>
          <button onClick={() => setRenaming(false)} disabled={busy === 'rename'}
            className="text-[11px] px-2 py-0.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">取消</button>
          <span className="text-[10px] text-gray-400">回车保存 · Esc 取消；后续人工/AI 任务按此名使唤（发现不会覆写它）</span>
        </div>
      )}

      {dev.capabilities.length > 0 && (
        <div className="mt-1.5 text-[11px] text-gray-400 truncate" title={dev.capabilities.join(' · ')}>自述能力：{dev.capabilities.join(' · ')}</div>
      )}

      {status && (
        <div className="mt-1.5 text-[11px] text-gray-500">
          最近动作 <span className="font-mono">{status.last_action ?? '—'}</span>
          {status.last_ok != null && <ResultBadge result={status.last_ok ? 'ok' : 'error'} />}
          {status.at && <span className="text-gray-300 ml-2">@{formatDbTime(status.at)}</span>}
          {status.last_result && <div className="text-gray-400 truncate mt-0.5" title={status.last_result}>{status.last_result}</div>}
        </div>
      )}

      <div className="mt-2 pt-2 border-t flex items-center gap-3 flex-wrap">
        <label className="text-[11px] text-gray-500 inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={dev.authorized} disabled={busy === 'auth' || locked} onChange={e => void toggleAuth(e.target.checked)} />
          允许控制
        </label>
        <button onClick={() => void control('turn_on')} disabled={busy != null || locked}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">
          <Power className="w-3 h-3" />{busy === 'turn_on' ? '下发中…' : '开'}
        </button>
        <button onClick={() => void control('turn_off')} disabled={busy != null || locked}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50">
          <PowerOff className="w-3 h-3" />{busy === 'turn_off' ? '下发中…' : '关'}
        </button>
        <span className="text-[10px] text-gray-400">能否下发由服务端授权闸裁定；门锁/安防类本轮不开放写操作</span>
      </div>
      {msg && <div className={`mt-1.5 text-[11px] ${msg.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{msg.text}</div>}
    </div>
  );
}

/**
 * zx_20261016_2 批三（维特根斯坦·意义即用法）: 留痕行**前置「来源」标签**——一行先答"谁按的"，再答"按了什么"。
 *
 * 来源一律取 `actor_kind`（本轮新增的**唯一**身份列，**写入时定**，**不在读时猜**）：
 *   · `task`     ⇒ 任务「标题」· 项目「名」（`taskRefs` 读时现查；查无 ⇒ 回退 id 前缀）
 *   · `external` ⇒ 外部终端「名」（`terminalRefs` 读时现查；查无 ⇒ 回退 id 前缀）
 *   · `panel`    ⇒ 面板手动（本地按钮，无外部引用）
 *   · `''`       ⇒ **整段不渲染**（本轮之前的历史行没有身份列——"认不出"就不假装认得出；
 *                    `database.ts` 已按**事实**把 `task_id != ''` 的旧行回填成 `task`：那时只有任务路带 id）
 * ⚠ 与设备列**同一把尺**：存 id、名字读时现查（名字会变，快照即失真）；查无即如实回退 8 位前缀。
 */
function SourceChip({ a, taskRef, terminalName }: { a: DeviceActionRow; taskRef?: TaskRef; terminalName?: string }) {
  if (a.actor_kind === 'panel') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">面板手动</span>;
  }
  if (a.actor_kind === 'external') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-600 shrink-0 inline-flex items-center">
        {terminalName !== undefined
          ? <span className="truncate max-w-[14rem]" title={`终端 id：${a.actor_ref}`}>外部终端「{terminalName}」</span>
          : <span className="font-mono truncate max-w-[8rem]" title={`终端已不在库：${a.actor_ref}`}>外部终端 {a.actor_ref.slice(0, 8)}</span>}
      </span>
    );
  }
  if (a.actor_kind === 'task') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 shrink-0 inline-flex items-center">
        {taskRef
          ? <span className="truncate max-w-[16rem]" title={`任务 id：${a.actor_ref}`}>任务「{taskRef.title}」{taskRef.projectName ? ` · 项目「${taskRef.projectName}」` : ''}</span>
          : <span className="font-mono truncate max-w-[8rem]" title={`任务已不在库：${a.actor_ref}`}>任务 {a.actor_ref.slice(0, 8)}</span>}
      </span>
    );
  }
  return null;
}

/**
 * zx_20261014_1 批一（道德经·名可名非常名）: 留痕**显名**——`alias || name`（取**当前**台账值）。
 *   `dev` 由页面按 `device_id` 从台账现查（不把名字冗余存进 `wa_device_actions`：名字会变，
 *   冗余存的是"当时的名字"，与"我们此刻叫它什么"是两件事——留痕记的是**动作**，不是名字的快照）。
 * ⚠ **设备已不在台账**时**回退**印 id 前 8 位（不假装它还在，也不凭空造名）。
 *
 * zx_20261014_3 批一（维特根斯坦·意义即用法 / 罗尔斯·同一把尺）: 任务列用同一条规则（现查、查无回退前缀）。
 * zx_20261016_2 批三: 任务列**前移为行首来源标签**（与外部终端/面板同处一列）——"谁在按"是**第一问**。
 */
function AuditRow({ a, dev, taskRef, terminalName }: { a: DeviceActionRow; dev?: AnsDevice; taskRef?: TaskRef; terminalName?: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-gray-500 py-1 border-b border-gray-50 last:border-0">
      <SourceChip a={a} taskRef={taskRef} terminalName={terminalName} />
      <ResultBadge result={a.result} />
      <span className="font-mono text-gray-700">{a.action}</span>
      {dev
        ? <span className="text-gray-600 truncate max-w-[12rem]" title={`${deviceCallName(dev)}（设备 id：${a.device_id}）`}>{deviceCallName(dev)}</span>
        : <span className="text-gray-400 font-mono truncate max-w-[10rem]" title={`设备已不在台账：${a.device_id}`}>{a.device_id.slice(0, 8)}</span>}
      <span className="ml-auto text-gray-300">{formatDbTime(a.created_at)}</span>
    </div>
  );
}

/**
 * zx_20261013_1 批五: **MQTT 接入配置**（适配层首切片的入口）。
 *
 * ⚠ 界面**不自写判据**（承 M10-H）：能否连接/是否装了客户端一律取 main 侧 `devices:mqtt_status` 的如实回包。
 * ⚠ **默认关**：连 broker 是可被察觉的网络行为，须人开（康德·自由以他人自由为界）。
 */
function MqttConfigBlock() {
  const [status, setStatus] = useState<MqttStatusPayload | null>(null);
  const [broker, setBroker] = useState('');
  const [topic, setTopic] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await devicesApi.mqttStatus();
      setStatus(s);
      setBroker(s.broker ?? '');
      setTopic(s.discoveryTopic);
      setEnabled(s.enabled);
    } catch (e) {
      setMsg((e as Error)?.message || '读取 MQTT 配置失败');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await invoke('settings:set', 'device.mqtt.broker', broker.trim());
      await invoke('settings:set', 'device.mqtt.discovery_topic', topic.trim());
      await invoke('settings:set', 'device.mqtt.enabled', enabled ? '1' : '0');
      await load();
      setMsg('已保存。若「发现」已在跑，请先「停止发现」再「开始发现」，MQTT 才会接入。');
    } catch (e) {
      setMsg((e as Error)?.message || '保存失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Radio className="w-4 h-4 text-slate-500" />
        <span className="text-sm font-medium text-gray-800">MQTT 设备接入</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">Beta</span>
        {status && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${status.clientAvailable ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
            {status.clientAvailable ? 'MQTT 客户端已安装' : 'MQTT 客户端未安装'}
          </span>
        )}
      </div>
      <p className="text-[11px] text-slate-500 mb-2">
        连上局域网 MQTT broker 后，设备在「发现主题」上**保留发布**自述 JSON，即可被本机发现、授权与控制。
        <b>默认关闭</b>——连 broker 是可被察觉的网络行为；设备能力一律取它自述，发现不等于授权。
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={broker} onChange={e => setBroker(e.target.value)} placeholder="192.168.1.9:1883"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-52 font-mono" />
        <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="workerant/discovery/#"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-56 font-mono" />
        <label className="text-[11px] text-gray-600 inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          启用 MQTT 发现
        </label>
        <button onClick={() => void save()} disabled={busy}
          className="text-[11px] px-2.5 py-1 rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50">
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      {msg && <div className="mt-1.5 text-[11px] text-slate-600">{msg}</div>}
    </div>
  );
}

/**
 * zx_20261015_3 批二/批四（道德经·不出户知天下）: **Home Assistant 标准桥**配置。
 *
 * ⚠ broker **与上面的 MQTT 卡共用**（HA 的 Mosquitto add-on 就是那个 broker）——此处只配开关与前缀。
 * ⚠ **默认关**（承 MQTT 卡同理）：连 broker 是可被察觉的网络行为，须人开。
 * ⚠ 界面**不自写判据**：接没接上、前缀是什么一律取 `devices:mqtt_status` 的如实回包。
 */
function HaConfigBlock() {
  const [prefix, setPrefix] = useState('homeassistant');
  const [enabled, setEnabled] = useState(false);
  const [broker, setBroker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await devicesApi.mqttStatus();
      setPrefix(s.ha.prefix);
      setEnabled(s.ha.enabled);
      setBroker(s.broker);
    } catch (e) {
      setMsg((e as Error)?.message || '读取 HA 桥配置失败');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await invoke('settings:set', 'device.ha.prefix', prefix.trim());
      await invoke('settings:set', 'device.ha.enabled', enabled ? '1' : '0');
      await load();
      setMsg('已保存。若「发现」已在跑，请先「停止发现」再「开始发现」，HA 桥才会接入。');
    } catch (e) {
      setMsg((e as Error)?.message || '保存失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Home className="w-4 h-4 text-emerald-600" />
        <span className="text-sm font-medium text-gray-800">Home Assistant 标准桥</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-200 text-emerald-800">HA</span>
        {broker == null && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600">未配置 broker（须先在上方 MQTT 卡填写）</span>}
      </div>
      <p className="text-[11px] text-emerald-700 mb-2">
        连上**用户自己的** Home Assistant（MQTT Discovery 标准协议）后，HA 已接入的**数百品牌**设备自动出现在台账——
        一条缝，零厂商对接。前缀缺省 <code className="font-mono">homeassistant</code>。
        <b>默认关闭</b>，broker 与上方 MQTT 卡共用；在线态只由设备可用性事件（LWT）回填，**不**从发现载荷推断。
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="homeassistant"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-48 font-mono" />
        <label className="text-[11px] text-gray-600 inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          启用 HA 桥
        </label>
        <button onClick={() => void save()} disabled={busy}
          className="text-[11px] px-2.5 py-1 rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50">
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      {msg && <div className="mt-1.5 text-[11px] text-emerald-800">{msg}</div>}
    </div>
  );
}

export default function DevicesPage() {
  // liveTypes 是**刷新触发**，不是数据源：两类设备事件都只让本页重新读台账（数据仍只有本地库一个来源）。
  const q = useLiveQuery<DevicesListPayload>(async () => devicesApi.list(), [], {
    liveTypes: ['device.discovered', 'device.status_changed'],
    debounceMs: 700,
  });
  const data = q.data;
  const [discovering, setDiscovering] = useState(false);

  async function toggleDiscovery() {
    if (!data) return;
    setDiscovering(true);
    try {
      if (data.discoveryRunning) await devicesApi.stop();
      else await devicesApi.discover();
      await q.reload();
    } finally { setDiscovering(false); }
  }

  if (q.loading && q.data == null) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;

  const devices = data?.devices ?? [];
  const actions = data?.actions ?? [];
  // 留痕按 `device_id` 现查台账取名（zx_20261014_1 批一）——名字来自**当前**台账，非冗余快照。
  const deviceById = new Map(devices.map(d => [d.id, d]));
  // 留痕按 `task_id` 现查任务引用（zx_20261014_3 批一）——标题/项目名由 main 读时查，同样非快照。
  const taskRefs = data?.taskRefs ?? {};
  // zx_20261016_2 批三: 外部终端路来的留痕按 `actor_ref` 现查终端名（同样读时查，非快照）。
  const terminalRefs = data?.terminalRefs ?? {};
  // zx_20261005 M22（Team 档软闸）：锁定即显示升级提示并禁用发现/授权/控制动作；台账仍可见（只读无害）。
  const gate = data?.gate ?? null;
  const locked = gate != null && !gate.unlocked;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">设备</h2>
        <div className="flex items-center gap-2">
          <FreshnessPill q={q} />
          <button onClick={() => void toggleDiscovery()} disabled={discovering || locked}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg ${data?.discoveryRunning ? 'bg-gray-600 text-white hover:bg-gray-700' : 'bg-blue-600 text-white hover:bg-blue-700'} disabled:opacity-50`}>
            {data?.discoveryRunning ? <><PowerOff className="w-3.5 h-3.5" />停止发现</> : <><Radar className="w-3.5 h-3.5" />开始发现</>}
          </button>
          <button onClick={() => void q.reload()} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {locked && (
        <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
          <div className="text-sm font-medium text-indigo-800 mb-1">「设备发现 / 设备控制」属于团队版能力</div>
          <div className="text-xs text-indigo-700">{gate!.detail}</div>
        </div>
      )}

      {/* 把"发现是显式动作 + 未授权只读"如实声明——不让用户误以为设备已被自动纳管/已可随意控制。 */}
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        「开始发现」才会在**局域网**内扫描（mDNS + SSDP + 已配置的 MQTT）；发现**不等于授权**——须逐设备打开「允许控制」才能真正下发命令。
        门锁/安防类高危设备本轮**不开放写操作**（只读状态）。
      </div>

      <MqttConfigBlock />

      <HaConfigBlock />

      {data?.discoveryRunning && (
        <div className="mb-3 text-[11px] text-emerald-600 inline-flex items-center gap-1"><Radar className="w-3.5 h-3.5 animate-pulse" />正在发现中…（新设备会实时出现在下方）</div>
      )}

      {devices.length === 0
        ? <p className="text-gray-400 text-center py-8">台账暂空——点右上「开始发现」扫描局域网设备。</p>
        : <div className="space-y-2 mb-6">{devices.map(d => <DeviceRow key={d.id} dev={d} onChanged={() => void q.reload()} locked={locked} />)}</div>}

      <div>
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 inline-flex items-center gap-1"><Lock className="w-3 h-3" />控制留痕（最近 {actions.length} 条）</p>
        {actions.length === 0
          ? <p className="text-gray-300 text-xs py-2">尚无控制记录。每次控制（**含被拒**）都会留一行。</p>
          : <div className="rounded-lg border bg-white px-3 py-1">{actions.map(a => <AuditRow key={a.id} a={a} dev={deviceById.get(a.device_id)} taskRef={taskRefs[a.task_id]} terminalName={a.actor_kind === 'external' ? terminalRefs[a.actor_ref] : undefined} />)}</div>}
      </div>
    </div>
  );
}
