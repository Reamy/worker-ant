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
import { devices as devicesApi, invoke, type CloudStatusPayload, type DevicesListPayload } from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
import { FreshnessPill } from '../components/FreshnessPill';
import { formatDbTime } from '../lib/deliverable-view';
import { Router, RefreshCw, Radar, Power, PowerOff, ShieldCheck, ShieldOff, Lock, Radio, Pencil, Home, Cloud, Plus } from 'lucide-react';
// zx_20261023_5 批三: 统一接入向导（一步一屏；渠道目录由 main 的 `devices:channels` 给，界面不预判）。
import { DeviceOnboardingWizard } from '../components/DeviceOnboardingWizard';
// zx_20261017_1 批八: 区域词表从**零依赖**真源取（不引 `tuya-cloud.ts`——那里有 node:crypto，进不了渲染包）。
import { TUYA_REGION_LABEL, TUYA_REGIONS } from '../../../src/main/core/providers/tuya-regions.js';
// 台账行 / 审计行 / 控制结果形状取自 main 侧零依赖语义模块真源（仅类型，打包期擦除）。
import type { AnsDevice, DeviceActionRow, DeviceControlOutcome, TaskRef } from '../../../src/main/core/device-registry.js';
// zx_20261014_1 批一/批二: "我们叫它什么"（别名优先、回退自述名）——**运行期**取零依赖真源，
//   与 main 侧同一份实现（若各处自写一份，改名后就会出现"面板叫 A、留痕叫 B"）。
import { deviceCallName } from '../../../src/main/core/device-name.js';
// zx_20261013_1 批五: MQTT 配置态形状取自 main 侧零依赖适配层真源（仅类型，打包期擦除）。
import type { MqttStatusPayload } from '../../../src/main/core/device-mqtt.js';
// zx_20261022_3 批三: 实时状态投影/摘要与发现错误聚合取**零依赖**真源（运行期，不拉 node:crypto/DB），
//   与 main 侧 `device_status` 工具、面板三处同一句判据——不各猜一遍。
import {
  aggregateDiscoveryErrors,
  liveSourceLabel,
  liveStateOf,
  liveStateSummary,
  type DeviceTestResult,
} from '../../../src/main/core/device-diagnostics.js';

const PROTOCOL_LABEL: Record<string, string> = { mdns: 'mDNS', ssdp: 'SSDP', http: 'HTTP', mqtt: 'MQTT', cloud: '三方云', miio: '米家 miIO' };

/**
 * zx_20261022_3 批三: 「测试连接」结果的**统一呈现**（形状取 main 侧 `DeviceTestResult`）。
 * ⚠ `ok:false` 也是结果：把 `detail`（超时/HTTP 码/涂鸦因由）原样上屏，不缩成一句"失败了"。
 */
function TestResultLine({ r }: { r: DeviceTestResult | null }) {
  if (!r) return null;
  return (
    <div className={`mt-1.5 text-[11px] ${r.ok ? 'text-emerald-600' : 'text-amber-600'}`}>
      {r.ok ? '连接成功' : '连接失败'} · {r.protocol.toUpperCase()} · <span className="font-mono text-gray-600">{r.endpoint}</span>
      {r.latencyMs > 0 && <span className="text-gray-400"> · {r.latencyMs}ms</span>}
      {r.discoveryTopics != null && <span className="text-gray-400"> · 测试窗口收到 {r.discoveryTopics} 条保留消息</span>}
      {r.deviceCount != null && <span className="text-gray-400"> · 账号下 {r.deviceCount} 台设备</span>}
      {r.statusCode != null && <span className="text-gray-400"> · HTTP {r.statusCode}</span>}
      <div className="text-gray-500">{r.detail}</div>
    </div>
  );
}

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
  const [editingRoom, setEditingRoom] = useState(false);
  const [roomDraft, setRoomDraft] = useState('');
  const [testResult, setTestResult] = useState<DeviceTestResult | null>(null);
  const status = dev.status as { last_action?: string; last_ok?: boolean; last_result?: string; at?: string; live?: unknown } | null;
  // zx_20261022_3 批三: 上行实时态与"上次控制快照"**分名两行**（投影取零依赖真源，与 `device_status` 同一份）。
  const live = liveStateOf(dev.status as Record<string, unknown> | null);
  // "我们叫它什么"——别名优先、回退设备自述名（与 main 侧同一份实现）。
  const callName = deviceCallName(dev) || dev.address;

  /** 逐设备 HTTP 探活（只有 http 设备有这一问；结果如实上屏，含超时/状态码）。 */
  async function testHttp() {
    setBusy('test'); setMsg(null); setTestResult(null);
    try {
      setTestResult(await devicesApi.test('http', dev.id));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '探活失败' });
    } finally { setBusy(null); }
  }

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

  // zx_20261018_1 批三: 指派房间——写 `wa_devices.room`（人的显式数据，非发现猜测）。
  //   ⚠ 同改名：本地元数据，**不经** Team 档软闸；空串=清除（回到"未分配"）。
  async function saveRoom() {
    setBusy('room'); setMsg(null);
    try {
      await devicesApi.setRoom(dev.id, roomDraft);
      setEditingRoom(false);
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '房间保存失败' });
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
        {/* zx_20261018_1 批三: 房间是**人指派的显式数据**；空 ⇒ 「未分配」，不显示发现提示冒充。 */}
        <button onClick={() => { setRoomDraft(dev.room ?? ''); setEditingRoom(v => !v); }} disabled={busy != null}
          className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 hover:bg-indigo-100 inline-flex items-center gap-0.5 disabled:opacity-40"
          title={dev.room ? `房间：${dev.room}（点击修改）` : '未分配房间——点击指派（发现提示只填空、不覆盖人设的值）'}>
          <Home className="w-3 h-3" />{dev.room || '未分配'}
        </button>
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

      {editingRoom && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <input autoFocus value={roomDraft} onChange={e => setRoomDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void saveRoom();
              else if (e.key === 'Escape') setEditingRoom(false);
            }}
            placeholder="房间名（如 客厅；留空 = 清除，回到未分配）"
            className="text-xs px-2 py-1 rounded border border-gray-300 w-64" />
          <button onClick={() => void saveRoom()} disabled={busy === 'room'}
            className="text-[11px] px-2 py-0.5 bg-slate-700 text-white rounded hover:bg-slate-800 disabled:opacity-50">
            {busy === 'room' ? '保存中…' : '保存'}
          </button>
          <button onClick={() => setEditingRoom(false)} disabled={busy === 'room'}
            className="text-[11px] px-2 py-0.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">取消</button>
          <span className="text-[10px] text-gray-400">回车保存 · Esc 取消；房间按名称精确匹配，发现提示不会覆盖你设的值</span>
        </div>
      )}

      {dev.capabilities.length > 0 && (
        <div className="mt-1.5 text-[11px] text-gray-400 truncate" title={dev.capabilities.join(' · ')}>自述能力：{dev.capabilities.join(' · ')}</div>
      )}

      {/* zx_20261022_3 批三: 设备**此刻说自己是什么状态**（上行原文 + 采集时刻 + 来源），
          「最近动作」是**指令留下**的快照——两件事分名两行，不让读的人把旧快照当实时态。 */}
      {live
        ? (
          <div className="mt-1.5 text-[11px] text-gray-600">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 mr-1">实时</span>
            {liveStateSummary(live)}
            <span className="text-gray-400 ml-2">{liveSourceLabel(live.source)}{live.at ? ` · 采集于 ${formatDbTime(live.at)}` : ''}</span>
          </div>
        )
        : (
          <div className="mt-1.5 text-[11px] text-gray-400" title="没有收到过设备上行消息（state/jattr 主题）——「最近动作」只是我们下过命令留下的快照。">
            未收到设备上行状态——只有最近一次控制快照（若有）。
          </div>
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
        {/* zx_20261022_3 批三: 逐设备探活（只有 http 设备有这一问；诊断不是控制，不受授权闸约束）。 */}
        {dev.protocol === 'http' && (
          <button onClick={() => void testHttp()} disabled={busy != null}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            title="对该设备的 HTTP 端点发一次有界 GET，看它答不答、答什么状态码">
            <Radio className="w-3 h-3" />{busy === 'test' ? '测试中…' : '测试连接'}
          </button>
        )}
        <span className="text-[10px] text-gray-400">能否下发由服务端授权闸裁定；门锁/安防类本轮不开放写操作</span>
      </div>
      <TestResultLine r={testResult} />
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
  // zx_20261022_3 批三: 认证与 TLS——密码**只写不读**（输入框留空=不修改；回包只说"已配/未配"）。
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tls, setTls] = useState(false);
  const [rejectUnauthorized, setRejectUnauthorized] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<DeviceTestResult | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await devicesApi.mqttStatus();
      setStatus(s);
      setBroker(s.broker ?? '');
      setTopic(s.discoveryTopic);
      setEnabled(s.enabled);
      setUsername(s.username);
      setTls(s.tls);
      setRejectUnauthorized(s.rejectUnauthorized);
    } catch (e) {
      setMsg((e as Error)?.message || '读取 MQTT 配置失败');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy('save'); setMsg(null);
    try {
      await invoke('settings:set', 'device.mqtt.broker', broker.trim());
      await invoke('settings:set', 'device.mqtt.discovery_topic', topic.trim());
      await invoke('settings:set', 'device.mqtt.enabled', enabled ? '1' : '0');
      await invoke('settings:set', 'device.mqtt.username', username.trim());
      await invoke('settings:set', 'device.mqtt.tls', tls ? '1' : '0');
      await invoke('settings:set', 'device.mqtt.reject_unauthorized', rejectUnauthorized ? '1' : '0');
      // 密码留空 = 保持原值（与三方云 Secret 同一约定）——不拿空串抹掉已配的密码。
      if (password !== '') await invoke('settings:set', 'device.mqtt.password', password);
      setPassword('');
      await load();
      setMsg('已保存。若「发现」已在跑，请先「停止发现」再「开始发现」，MQTT 才会接入。');
    } catch (e) {
      setMsg((e as Error)?.message || '保存失败');
    } finally { setBusy(null); }
  }

  /** 用**当前已保存**的配置测一次（不含未保存的输入——否则测的不是将生效的那份）。 */
  async function test() {
    setBusy('test'); setMsg(null); setTestResult(null);
    try {
      setTestResult(await devicesApi.test('mqtt'));
    } catch (e) {
      setMsg((e as Error)?.message || '测试失败');
    } finally { setBusy(null); }
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
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        <input value={broker} onChange={e => setBroker(e.target.value)} placeholder="192.168.1.9:1883"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-52 font-mono" />
        <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="workerant/discovery/#"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-56 font-mono" />
        <label className="text-[11px] text-gray-600 inline-flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          启用 MQTT 发现
        </label>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="用户名（可选）" autoComplete="off"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-40 font-mono" />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder={status?.passwordSet ? '密码已配置（留空不修改）' : '密码（可选）'}
          className="text-xs px-2 py-1 rounded border border-gray-300 w-48 font-mono" autoComplete="new-password" />
        <label className="text-[11px] text-gray-600 inline-flex items-center gap-1 cursor-pointer" title="broker 走 TLS（mqtts://；缺端口时用 8883）">
          <input type="checkbox" checked={tls} onChange={e => setTls(e.target.checked)} />
          TLS
        </label>
        <label className={`text-[11px] inline-flex items-center gap-1 ${tls ? 'text-gray-600 cursor-pointer' : 'text-gray-300'}`}
          title="TLS 下是否校验 broker 证书；缺省校验，关掉须你显式勾选（自签名证书才需要）">
          <input type="checkbox" checked={rejectUnauthorized} disabled={!tls}
            onChange={e => setRejectUnauthorized(e.target.checked)} />
          校验证书
        </label>
        <button onClick={() => void save()} disabled={busy != null}
          className="text-[11px] px-2.5 py-1 rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50">
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button onClick={() => void test()} disabled={busy != null || status?.broker == null}
          className="text-[11px] px-2.5 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          title={status?.broker == null ? '请先填写 broker 并保存' : '用已保存的配置连一次 broker（不产生设备改动）'}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
      </div>
      <TestResultLine r={testResult} />
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
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<DeviceTestResult | null>(null);

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
    setBusy('save'); setMsg(null);
    try {
      await invoke('settings:set', 'device.ha.prefix', prefix.trim());
      await invoke('settings:set', 'device.ha.enabled', enabled ? '1' : '0');
      await load();
      setMsg('已保存。若「发现」已在跑，请先「停止发现」再「开始发现」，HA 桥才会接入。');
    } catch (e) {
      setMsg((e as Error)?.message || '保存失败');
    } finally { setBusy(null); }
  }

  /** 用与 MQTT 卡**共用**的 broker 测一次（订阅 `<prefix>/#`，数一下现有保留消息）。 */
  async function test() {
    setBusy('test'); setMsg(null); setTestResult(null);
    try {
      setTestResult(await devicesApi.test('ha'));
    } catch (e) {
      setMsg((e as Error)?.message || '测试失败');
    } finally { setBusy(null); }
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
        <button onClick={() => void save()} disabled={busy != null}
          className="text-[11px] px-2.5 py-1 rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50">
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button onClick={() => void test()} disabled={busy != null || broker == null}
          className="text-[11px] px-2.5 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          title={broker == null ? '请先在上方 MQTT 卡填写 broker' : '用共用 broker 连一次并订阅 HA 发现主题'}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
      </div>
      <TestResultLine r={testResult} />
      {msg && <div className="mt-1.5 text-[11px] text-emerald-800">{msg}</div>}
    </div>
  );
}

/**
 * zx_20261017_1 批八（庄子·物各有宜）: **三方云（涂鸦 Cloud 试点）**配置与同步。
 *
 * ⚠ 配置态**只读 main 的回包**（`devices:cloud_status`，不触网）；界面不自判"连没连上"。
 * ⚠ **Secret 只写不读**：输入框留空 = 不修改；保存后仅显示"已配置"，明文不回显。
 * ⚠ 同步属 Team `device_discovery` 能力——锁定即禁用（服务端闸是唯一判据，按钮只是提示）。
 * ⚠ 同步失败如实显示原因（空态 + 原因），不假装"已连上"。
 */
function CloudConfigBlock({ locked }: { locked: boolean }) {
  const [status, setStatus] = useState<CloudStatusPayload | null>(null);
  const [region, setRegion] = useState('cn');
  const [accessId, setAccessId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'save' | 'sync' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<DeviceTestResult | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await devicesApi.cloudStatus();
      setStatus(s);
      setRegion(s.region);
      setAccessId(s.accessId);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '读取三方云配置失败' });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy('save'); setMsg(null);
    try {
      const s = await devicesApi.tuyaConfig({ region, accessId, accessSecret: secret });
      setStatus(s);
      setRegion(s.region);
      setAccessId(s.accessId);
      setSecret('');
      setMsg({ ok: true, text: s.configured ? '已保存。可点「从涂鸦云同步」拉取设备。' : '已保存，但凭据仍未齐（Access ID 与 Secret 都须填写）。' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '保存失败' });
    } finally { setBusy(null); }
  }

  /** 用**已保存**的凭据测一次（取令牌 + 读账号设备总数；不写台账、不改设备）。 */
  async function test() {
    setBusy('test'); setMsg(null); setTestResult(null);
    try {
      setTestResult(await devicesApi.test('tuya'));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '测试失败' });
    } finally { setBusy(null); }
  }

  async function sync() {
    setBusy('sync'); setMsg(null);
    try {
      const r = await devicesApi.cloudSync();
      setMsg({ ok: true, text: `同步完成：新增 ${r.added} 台 / 刷新 ${r.updated} 台（台账内云设备共 ${r.total} 台见下方列表）。` });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '同步失败' });
    } finally { setBusy(null); }
  }

  return (
    <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Cloud className="w-4 h-4 text-sky-600" />
        <span className="text-sm font-medium text-gray-800">三方云 · 涂鸦（Tuya Cloud）</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-200 text-sky-800">试点</span>
        {status && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${status.configured ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
            {status.configured ? `已配置 · ${status.regionLabel}` : '未配置凭据'}
          </span>
        )}
        {status && status.deviceCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">台账内云设备 {status.deviceCount} 台</span>
        )}
      </div>
      <p className="text-[11px] text-sky-700 mb-2">
        用你自己的涂鸦开发者云凭据，把涂鸦账号下的设备同步到本机台账；控制仍走**本机授权闸**（K-6：未授权只读、门锁/安防不开放写）。
        请求只发往涂鸦**官方区域端点**（固定域名）。Secret **只写不读**，界面上只显示「已配置」。同步属团队版「设备发现」能力。
      </p>
      {!status?.configured && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
          尚未配置涂鸦云凭据——填写 Access ID / Access Secret 并保存后，方可从涂鸦云同步设备。本轮只接涂鸦云，其余厂商按 Provider 增量接入。
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={region} onChange={e => setRegion(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-gray-300 bg-white">
          {TUYA_REGIONS.map(r => <option key={r} value={r}>{TUYA_REGION_LABEL[r]}（{r}）</option>)}
        </select>
        <input value={accessId} onChange={e => setAccessId(e.target.value)} placeholder="Access ID / Client ID"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-56 font-mono" />
        <input type="password" value={secret} onChange={e => setSecret(e.target.value)}
          placeholder={status?.secretSet ? 'Secret 已配置（留空不修改）' : 'Access Secret'}
          className="text-xs px-2 py-1 rounded border border-gray-300 w-56 font-mono" autoComplete="off" />
        <button onClick={() => void save()} disabled={busy != null}
          className="text-[11px] px-2.5 py-1 rounded bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-50">
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button onClick={() => void sync()} disabled={busy != null || locked || !status?.configured}
          className="text-[11px] px-2.5 py-1 rounded border border-sky-300 text-sky-700 hover:bg-sky-100 disabled:opacity-50"
          title={locked ? '团队版能力：当前档位不可同步' : status?.configured ? '从涂鸦云拉取设备并幂等入账' : '请先配置凭据'}>
          {busy === 'sync' ? '同步中…' : '从涂鸦云同步'}
        </button>
        <button onClick={() => void test()} disabled={busy != null || !status?.configured}
          className="text-[11px] px-2.5 py-1 rounded border border-sky-300 text-sky-700 hover:bg-sky-100 disabled:opacity-50"
          title={status?.configured ? '用已保存的凭据取一次令牌并读账号设备总数（不写台账）' : '请先配置凭据'}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
      </div>
      <TestResultLine r={testResult} />
      {msg && <div className={`mt-1.5 text-[11px] ${msg.ok ? 'text-sky-800' : 'text-amber-700'}`}>{msg.text}</div>}
    </div>
  );
}

/**
 * zx_20261018_1 批五「落」（王阳明·知行合一 / 道德经·图难于其易）: **意图演练**——先说"哪个房间、什么感受"，
 * 看见**排好的下一步**（步骤 + 理由 + 被略过的设备及原因），再决定执不执行。
 *
 * ⚠ 预览**不碰设备**：只落一条计划（服务端 `devices:intent_preview`，零设备动作）。
 * ⚠ 执行**认领那份固定计划**（不重规划、只执行一次、120 秒内有效）——预览后被取消授权的设备
 *   仍会走到 K-6：该步如实失败并留 `denied` 审计行，而不是被悄悄滤掉。
 * ⚠ "能不能做"由服务端判据（K-6 + Team 闸）定；界面只呈现回包，不自写第二份判据。
 */
const FEELING_OPTIONS: Array<{ value: 'hot' | 'cold' | 'dark' | 'bright'; label: string }> = [
  { value: 'hot', label: '有点热' },
  { value: 'cold', label: '有点冷' },
  { value: 'dark', label: '太暗了' },
  { value: 'bright', label: '想更亮' },
];

function IntentComfortBlock({ devices, locked }: { devices: AnsDevice[]; locked: boolean }) {
  const [room, setRoom] = useState('');
  const [feeling, setFeeling] = useState<'hot' | 'cold' | 'dark' | 'bright'>('hot');
  const [busy, setBusy] = useState<'preview' | 'execute' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [plan, setPlan] = useState<{ planId: string; expiresIn: number; steps: Array<{ call_name: string; action: string; args?: Record<string, unknown>; reason?: string }>; skipped: Array<{ call_name: string; reason: string }> } | null>(null);
  const [results, setResults] = useState<Array<{ call_name: string; action: string; ok: boolean; result?: string; error?: string }> | null>(null);
  // 房间名从台账里**人指派的**房间去重取得（不是发现提示、也不猜别的房间）。
  const rooms = Array.from(new Set(devices.map(d => (d.room ?? '').trim()).filter(Boolean)));

  async function preview() {
    const r = room.trim();
    if (!r) { setMsg({ ok: false, text: '先填写或选择房间名' }); return; }
    setBusy('preview'); setMsg(null); setPlan(null); setResults(null);
    try {
      const p = await devicesApi.intentPreview(r, feeling);
      setPlan(p);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '预览失败' });
    } finally { setBusy(null); }
  }

  async function execute() {
    if (!plan) return;
    setBusy('execute'); setMsg(null);
    try {
      const r = await devicesApi.intentExecute(plan.planId);
      setResults(r.steps);
      const failed = r.steps.filter(s => !s.ok).length;
      setMsg(r.status === 'executed'
        ? { ok: true, text: '全部步骤执行成功。' }
        : { ok: false, text: `${failed} 步未成功——结果如实记录，已执行的步骤不回滚。` });
      // 计划只执行一次：跑完（无论成败）即清掉，重来须重新预览。
      setPlan(null);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error)?.message || '执行失败' });
      setPlan(null);
    } finally { setBusy(null); }
  }

  return (
    <div className="mb-4 rounded-lg border border-fuchsia-200 bg-fuchsia-50 px-4 py-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Home className="w-4 h-4 text-fuchsia-600" />
        <span className="text-sm font-medium text-gray-800">意图演练 · 居家舒适</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-200 text-fuchsia-800">home.comfort</span>
      </div>
      <p className="text-[11px] text-fuchsia-700 mb-2">
        说一句"哪个房间、什么感受"，先看**排好的步骤与理由**，再决定执行。
        只动**同房间**且**已授权**的设备；其余设备如实列在「已略过」里。预览不碰设备，计划 120 秒内有效、只执行一次。
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={room} onChange={e => setRoom(e.target.value)} list="intent-room-options"
          placeholder="房间（如 客厅）"
          className="text-xs px-2 py-1 rounded border border-gray-300 w-40" />
        <datalist id="intent-room-options">
          {rooms.map(r => <option key={r} value={r} />)}
        </datalist>
        <select value={feeling} onChange={e => setFeeling(e.target.value as typeof feeling)}
          className="text-xs px-2 py-1 rounded border border-gray-300 bg-white">
          {FEELING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button onClick={() => void preview()} disabled={busy != null}
          className="text-[11px] px-2.5 py-1 rounded bg-fuchsia-700 text-white hover:bg-fuchsia-800 disabled:opacity-50">
          {busy === 'preview' ? '规划中…' : '预览计划'}
        </button>
        <button onClick={() => void execute()} disabled={busy != null || locked || !plan}
          className="text-[11px] px-2.5 py-1 rounded border border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-100 disabled:opacity-50"
          title={locked ? '团队版能力：当前档位不可执行' : plan ? '执行这份计划（只执行一次）' : '先预览取得计划'}>
          {busy === 'execute' ? '执行中…' : '执行计划'}
        </button>
      </div>

      {plan && (
        <div className="mt-2 rounded border border-fuchsia-200 bg-white px-3 py-2">
          <div className="text-[11px] text-gray-500 mb-1">将按下列顺序执行（计划 {plan.expiresIn} 秒内有效）</div>
          <ol className="list-decimal pl-5 space-y-0.5">
            {plan.steps.map((s, i) => (
              <li key={`${s.call_name}-${i}`} className="text-[11px] text-gray-700">
                <span className="font-medium">{s.call_name}</span>
                <span className="font-mono text-gray-500 ml-1">{s.action}</span>
                {s.args && <span className="text-gray-400 ml-1">{JSON.stringify(s.args)}</span>}
                {s.reason && <div className="text-gray-400">{s.reason}</div>}
              </li>
            ))}
          </ol>
          {plan.skipped.length > 0 && (
            <div className="mt-1.5 text-[11px] text-amber-600">
              已略过：{plan.skipped.map((s, i) => <div key={`${s.call_name}-${i}`}>· {s.call_name}：{s.reason}</div>)}
            </div>
          )}
        </div>
      )}

      {results && (
        <div className="mt-2 rounded border border-gray-200 bg-white px-3 py-2">
          <div className="text-[11px] text-gray-500 mb-1">执行结果（逐步如实）</div>
          {results.map((r, i) => (
            <div key={`${r.call_name}-${i}`} className="text-[11px] flex items-center gap-2">
              <ResultBadge result={r.ok ? 'ok' : 'error'} />
              <span className="font-medium">{r.call_name}</span>
              <span className="font-mono text-gray-500">{r.action}</span>
              <span className="text-gray-400 truncate" title={r.result ?? r.error ?? ''}>{r.result ?? r.error ?? ''}</span>
            </div>
          ))}
        </div>
      )}

      {msg && <div className={`mt-1.5 text-[11px] ${msg.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{msg.text}</div>}
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
  // zx_20261022_3 批三: 发现回包里的 `mqttErrors` **不再丢弃**——条数如实、去重后逐条可展开。
  const [discoveryErrors, setDiscoveryErrors] = useState<string[]>([]);
  // zx_20261023_5 批三: 统一接入向导（显式打开；完成/关闭都让页面重读台账）。
  const [wizardOpen, setWizardOpen] = useState(false);

  async function toggleDiscovery() {
    if (!data) return;
    setDiscovering(true);
    try {
      if (data.discoveryRunning) {
        await devicesApi.stop();
        setDiscoveryErrors([]);
      } else {
        const r = await devicesApi.discover();
        setDiscoveryErrors(r.mqttErrors ?? []);
      }
      await q.reload();
    } finally { setDiscovering(false); }
  }

  const discoveryErr = aggregateDiscoveryErrors(discoveryErrors);

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
          {/* 向导对锁定档也开放：进去会如实说明「为什么没有可选渠道」，而不是给一个点不动的按钮。 */}
          <button onClick={() => setWizardOpen(true)}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-slate-700 text-white rounded-lg hover:bg-slate-800">
            <Plus className="w-3.5 h-3.5" />接入设备
          </button>
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
        「开始发现」才会在**局域网**内扫描（mDNS + SSDP + 米家 miIO + 已配置的 MQTT）；发现**不等于授权**——须逐设备打开「允许控制」才能真正下发命令。
        门锁/安防类高危设备本轮**不开放写操作**（只读状态）。
      </div>

      {/* zx_20261022_3 批三: 发现过程的 MQTT 告警——一条汇总 + 可展开的去重明细（不吞第一条也不刷屏）。 */}
      {discoveryErr.count > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <div>{discoveryErr.summary}</div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-amber-700">查看明细（{discoveryErr.unique.length} 类）</summary>
            <ul className="mt-1 space-y-0.5 pl-4 list-disc">
              {discoveryErr.unique.map((e, i) => <li key={i} className="font-mono break-all">{e}</li>)}
            </ul>
          </details>
          <div className="mt-1 text-[10px] text-amber-600">发现仍在进行；以上告警只说明某一路（MQTT/HA 订阅）没接上，mDNS/SSDP 结果照常。</div>
        </div>
      )}

      <MqttConfigBlock />

      <HaConfigBlock />

      <CloudConfigBlock locked={locked} />

      <IntentComfortBlock devices={devices} locked={locked} />

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

      {wizardOpen && (
        <DeviceOnboardingWizard
          devices={devices}
          onClose={() => setWizardOpen(false)}
          onDone={() => void q.reload()}
        />
      )}
    </div>
  );
}
