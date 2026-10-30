/**
 * zx_20261004 M8/M9（王阳明·知行合一 / 康德·自由以他人自由为界）: **设备类工具**——让设备"看得见、控得住"。
 *
 * 三件工具：
 *   · `list_devices`   （readonly）——列台账（发现来的设备都在这里）。
 *   · `device_status`  （readonly）——读一台设备的**授权态与状态快照**。
 *   · `device_control` （write）   ——**写**：能执行的判据**只问** `device-registry.deviceControlVerdict`
 *      （未授权只读、门锁/安防即便授权也拒），执行前后各留一行审计（"控制全量留痕"）。
 *
 * ⚠ **传动**（实际下发命令的那一跳）**可注入**（`deps.controlDevice`）：真机走默认派发
 *   （`defaultDeviceControl`：`mqtt` → MQTT 适配层 `../../../device-mqtt`；其余 → `httpDeviceControl`），
 *   受控回归喂假实现 ⇒ 不触网。承 §3「真网络只走注入」。
 * ⚠ 默认 HTTP 件**只发往局域网地址**（SSRF 收口）：设备地址来自发现，但 TXT/SSDP 可被伪造，
 *   故出站前再核一次"是不是私网/链路本地/`.local`"——不是即如实拒，不把控制面变成任意出站通道。
 */
import type { ToolDeps } from './deps.js';
import { jsonSchema } from 'ai';
import { eventBus } from '../event-bus.js';
import {
  deviceControlVerdict,
  deviceLiveStateOf,
  getDevice,
  listDevices,
  recordDeviceAction,
  resolveDeviceByName,
  setDeviceStatus,
  type AnsDevice,
  type DeviceActionActorKind,
  type DeviceControlOutcome,
  type DeviceDb,
} from '../device-registry.js';
// zx_20261014_1 批三: "我们叫它什么"（别名优先、回退自述名）——与面板/留痕**同一份**实现（零依赖可同引）。
import { deviceCallName } from '../device-name.js';
// zx_20261005 M22（Team 档软闸）: **设备控制**属 Team 档能力——工具入口经唯一判据（`core/team-gate.ts`）。
//   ⚠ 闸口**在此工具的 `execute`**，**不在** `runDeviceControl`：后者是 K-6 编排，rr_zx_20261004 M9
//     以无许可夹具**直跑它**验 K-6 判据（未授权/高危/不可控），在编排内加档位闸会把 K-6 断言弄红——
//     档位闸（本处 + `devices:control` IPC）与安全闸（`deviceControlVerdict`）**各就各位**，两件事。
import { teamFeatureRefusal } from '../team-gate.js';
import type { LicenseSettingDb } from '../license.js';
// zx_20261018_1 批五（王阳明·知行合一）: 意图 → 计划 → 执行。计划账与共享执行器在 `intent-plans.ts`；
//   确定性规则表在 `home-intent.ts`；词表/参数校验在 `intent-protocol.ts`——本文件只做"接线"，不另写一份。
import {
  claimIntentPlan,
  createIntentPlan,
  executeClaimedIntentPlan,
  type IntentPlanDb,
  type IntentStepResult,
} from '../intent-plans.js';
// zx_20261029_2 M2「通」: 门外/门内共用同一条解析链——规则优先，规则排不出且开关允许时才请模型补，
//   模型步骤再按台账与 K-6 校验一遍（`home-intent.resolveComfortIntent`）。
import { resolveComfortIntent } from '../home-intent.js';
import { runComfortModelPlan } from '../intent-model-plan.js';
import { readBoolSetting } from '../settings-bool.js';
import {
  HOME_COMFORT_INTENT,
  INTENT_CAPABILITY,
  validateIntent,
} from '../intent-protocol.js';
// zx_20261013_1 批五（适配层）: MQTT 传动与地址约定取自适配层真源——**只此一处**选路（`defaultDeviceControl`）。
import { mqttBrokerHost, mqttDeviceControl, type MqttIo } from '../device-mqtt.js';
// zx_20261017_1 批八: 三方云传动走 Provider 注册表（`cloud` 分支）——未注册即如实拒，不落 HTTP。
import { cloudDeviceState, cloudProviderIdOf, controlCloudDevice } from '../device-provider.js';
// zx_20261023_5 批三: 米家 miIO（私有 UDP 协议）的控制/状态——与 cloud 同法"选路一处、传动各件"。
import { miioDeviceControl, miioDeviceState } from '../providers/mijia-miio.js';
// zx_20261022_3 批三: 来源/采集时刻的话术取零依赖真源（与面板同一句，不各写一份）。
import { liveAbsentNote, liveSourceLabel } from '../device-diagnostics.js';

export interface DeviceControlResult {
  ok: boolean;
  result: string;
}

/** 控制传输的签名（真机 HTTP / 回归假实现同形）。 */
export type DeviceControlTransport = (
  dev: AnsDevice,
  action: string,
  args: Record<string, unknown>,
) => Promise<DeviceControlResult>;

/**
 * 云元数据地址黑名单（zx_20261022_3 批四）。
 * 病：`169.254.0.0/16` 整段放行是为了照顾真链路本地设备，但云厂商把**实例凭据服务**也放在这一段——
 *   设备面板里自述一个 `169.254.169.254` 就能让本机替它去取 IAM 凭据（SSRF 直达云身份）。
 * 治法：只拒**已知元数据端点**，其余链路本地保留（局域网设备可能合法使用）。
 */
const CLOUD_METADATA_ADDRS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure / OpenStack IMDS
  '169.254.170.2',   // AWS ECS task metadata
  'fd00:ec2::254',   // AWS IMDSv2 over IPv6
]);

/** 地址归一（去方括号/空白/大小写）——判黑名单用。 */
function normalizeAddr(raw: string): string {
  return String(raw ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

/** 是否云元数据端点（显式拒绝，因由单独说）。 */
export function isCloudMetadataAddress(addr: string): boolean {
  return CLOUD_METADATA_ADDRS.has(normalizeAddr(addr));
}

/**
 * 局域网地址收口（SSRF）：私有 IPv4 / 链路本地 / 回环 / IPv6 LL / `.local` 放行，其余拒。
 * **云元数据端点一律先拒**（因由由 `lanAddressRefusal` 给，调用方如实上屏）。
 */
export function isLanAddress(addr: string): boolean {
  return lanAddressRefusal(addr) == null;
}

/** 拒绝因由（放行回 `null`）：元数据端点单独一句，其余非局域网一句。 */
export function lanAddressRefusal(addr: string): string | null {
  if (!addr) return '地址为空';
  const norm = normalizeAddr(addr);
  if (isCloudMetadataAddress(norm)) {
    return `地址 ${norm} 是云元数据端点（实例凭据服务），出于安全**拒绝出站**（不替设备去取本机云身份）。`;
  }
  const m = norm.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127) return null;
    if (a === 192 && b === 168) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 169 && b === 254) return null;
    return `地址 ${addr} 非局域网地址（私网/链路本地/回环），出于安全**拒绝出站**。`;
  }
  if (/^fe80:/i.test(norm) || norm === '::1') return null;
  if (/\.local$/i.test(norm)) return null;
  return `地址 ${addr} 非局域网地址（私网/链路本地/.local），出于安全**拒绝出站**。`;
}

/**
 * 默认控制传输：**通用 HTTP**（K-3 协议无关的控制面其一）。
 * 向 `http://<address>:<port>/<action>` POST JSON 体，5s 超时，响应体截 2000 字符如实回传。
 */
export async function httpDeviceControl(
  dev: AnsDevice,
  action: string,
  args: Record<string, unknown>,
): Promise<DeviceControlResult> {
  const refusal = lanAddressRefusal(dev.address);
  if (refusal) return { ok: false, result: `${refusal}（控制只发往局域网。）` };
  if (!dev.port) {
    return { ok: false, result: '该设备未自述控制端口，无法经 HTTP 下发命令。' };
  }
  const url = `http://${dev.address}:${dev.port}/${encodeURIComponent(action)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5_000),
    });
    const text = (await res.text()).slice(0, 2000);
    return { ok: res.ok, result: `HTTP ${res.status}${text ? ` ${text}` : ''}` };
  } catch (e) {
    return { ok: false, result: `请求失败：${(e as Error)?.message || String(e)}` };
  }
}

/**
 * 默认传动的**派发**（zx_20261013_1 批五 · 适配层的**选路只此一处**）：`mqtt` → MQTT 适配层；
 * `cloud` → Provider 注册表（zx_20261017_1 批八）；其余 → 通用 HTTP。
 * 工具与面板共用它（"各取各的传动"是同一类漂移）。
 *
 * ⚠ SSRF 围栏在此统一施加：**MQTT 的出站对象是 broker 不是设备**，故核 `mqttBrokerHost(dev.address)`
 *   ——`httpDeviceControl` 核的是设备地址本身，两者对象不同，故各核各的（不是"两把尺"，是**两个对象**）。
 * ⚠ `cloud` 分支**先于** HTTP 回退：未注册 Provider ⇒ 如实拒（否则 `tuya:xxx` 会被当主机名发出站）。
 */
export async function defaultDeviceControl(
  dev: AnsDevice,
  action: string,
  args: Record<string, unknown>,
  mqttIo?: MqttIo,
): Promise<DeviceControlResult> {
  if (dev.protocol === 'mqtt') {
    const host = mqttBrokerHost(dev.address);
    const refusal = lanAddressRefusal(host);
    if (refusal) return { ok: false, result: `MQTT broker：${refusal}（控制只发往局域网 broker。）` };
    return mqttDeviceControl(dev, action, args, mqttIo);
  }
  if (dev.protocol === 'cloud') {
    return controlCloudDevice(dev, action, args);
  }
  // zx_20261023_5 批三：miIO 是私有二进制协议（UDP 54321）——**出站对象是设备本身**，
  //   故与 HTTP 同核设备地址（不是"两把尺"：mqtt 核 broker、cloud 由厂商 SDK 出站、miio 核设备）。
  if (dev.protocol === 'miio') {
    const refusal = lanAddressRefusal(dev.address);
    if (refusal) return { ok: false, result: `miIO 设备：${refusal}（控制只发往局域网。）` };
    return miioDeviceControl(dev, action, args);
  }
  return httpDeviceControl(dev, action, args);
}

/**
 * 控制一台设备的**唯一编排**：闸（K-6）→ 传动 → 审计 →（授权通过才）写状态 → 发事件。
 *
 * 工具（`device_control`）与设备面板（`devices:control`）两条入口**共用这一份次序**——
 * "判据一处、编排两处"是同一类漂移（罗尔斯·同一把尺），故编排也收成一函数。
 * 传动由调用方传入：工具走 `deps.controlDevice ?? httpDeviceControl`，面板走 `httpDeviceControl`；
 * 两条各有取法，但**次序**只有这一份。
 */
export async function runDeviceControl(
  ddb: DeviceDb,
  raw: {
    deviceId: string; action: string; args?: Record<string, unknown>; taskId?: string;
    /** zx_20261016_2: 发起者（见 `DeviceActionActorKind`）。缺省时由 `taskId` 派生（任务路），否则认不出。 */
    actor?: { kind: DeviceActionActorKind; ref?: string };
    /** zx_20261018_1 批五: 意图计划来路（审计行 ⇄ 计划一一对应）；非意图路不传。 */
    planId?: string;
  },
  transport: DeviceControlTransport,
): Promise<DeviceControlOutcome> {
  const actionArgs = raw.args ?? {};
  // 发起者一处派生：显式 `actor` 优先；无则"有 taskId 即任务路"，两样都无 ⇒ 空串（**如实认不出**，不猜）。
  const actor = raw.actor ?? (raw.taskId ? { kind: 'task' as const, ref: raw.taskId } : { kind: '' as const, ref: '' });
  const dev = getDevice(ddb, raw.deviceId);
  // 能执行的判据**只问这一处**（K-6 一处真源）——未授权不改设备状态、真发命令。
  const verdict = deviceControlVerdict(dev);
  if (!verdict.ok) {
    recordDeviceAction(ddb, { deviceId: raw.deviceId, action: raw.action, args: actionArgs, result: 'denied', taskId: raw.taskId, actor, planId: raw.planId });
    return {
      ok: false, denied: true, reason: verdict.reason,
      deviceId: raw.deviceId, action: raw.action,
      error: `控制被拒（${verdict.reason}）`, how_to_authorize: verdict.how,
    };
  }
  const r = await transport(dev!, raw.action, actionArgs);
  recordDeviceAction(ddb, { deviceId: raw.deviceId, action: raw.action, args: actionArgs, result: r.ok ? 'ok' : 'error', taskId: raw.taskId, actor, planId: raw.planId });
  // 授权通过才写状态（未授权那一支**不落**——"不改设备状态"是判据）。
  setDeviceStatus(ddb, raw.deviceId, { last_action: raw.action, last_ok: r.ok, last_result: r.result, at: new Date().toISOString() });
  // 状态流转事件（持久化）——面板据此实时刷新。未授权那一支不发（设备状态没变）。
  eventBus.emit('device.status_changed', { deviceId: raw.deviceId, device: getDevice(ddb, raw.deviceId) }).catch(() => {});
  return { ok: r.ok, deviceId: raw.deviceId, action: raw.action, result: r.result };
}

/**
 * 已认领意图计划的**执行一跳**（zx_20261018_1 批五；本地工具与面板 IPC 共用）：
 * 认领 → 逐步解析设备名 → `runDeviceControl`（K-6 闸/审计/状态/事件仍只有那一份）→ 收口。
 *
 * ⚠ **不重规划**：认领的是 `wa_intent_plans` 里那份固定计划——预览后设备被取消授权，
 *   执行仍会走到 K-6 并留下 `denied` 审计行（而不是被悄悄滤进 `skipped`）。
 * ⚠ 认领失败按行现状如实分因（`plan_not_found` / `plan_expired` / `plan_already_executed` / `plan_executing`）。
 */
export async function executeDeviceIntentPlan(
  ddb: DeviceDb,
  planId: string,
  opts: {
    actor: { kind: DeviceActionActorKind; ref?: string };
    taskId?: string;
    transport?: DeviceControlTransport;
  },
): Promise<
  | { ok: true; status: 'executed' | 'failed'; steps: IntentStepResult[] }
  | { ok: false; reason: string }
> {
  // 真库同时满足 `DeviceDb` 与 `IntentPlanDb`（同形最小接口，仅 run 的返回类型宽窄不同）。
  const planDb = ddb as unknown as IntentPlanDb;
  const claim = claimIntentPlan(planDb, planId);
  if (!claim.ok) return { ok: false, reason: claim.reason };
  const transport = opts.transport ?? defaultDeviceControl;
  const { status, steps } = await executeClaimedIntentPlan(planDb, claim.plan, async (step) => {
    const r = resolveDeviceByName(ddb, step.call_name);
    if (!r.ok) return { ok: false, reason: `设备不存在或名字有歧义：${step.call_name}（${r.reason}）` };
    const outcome = await runDeviceControl(ddb, {
      deviceId: r.device.id,
      action: step.action,
      args: step.args,
      taskId: opts.taskId,
      actor: opts.actor,
      planId,
    }, transport);
    if ('denied' in outcome) return { ok: false, denied: true, reason: outcome.reason };
    return { ok: outcome.ok, result: outcome.result };
  });
  return { ok: true, status, steps };
}

/**
 * `device_status` 的**载荷投影**（zx_20261018_1 批四；一处真源，rr 直跑）。
 * `status` 只留**上次控制快照**；订阅来的实时状态单独进 `live`——两者**分名**，不互相冒充。
 * 从未收到上行消息 ⇒ `live: null`（"没订阅到"≠"状态为空"）。
 *
 * zx_20261022_3 批三（维特根斯坦·意义即用法）：来源与采集时刻是 `live` 的**兄弟键**而非其成员——
 *   `live` 的形状被既有回归逐字段钉死，往里塞字段会让"同一台设备"在两处读法不同。
 *   无上行时给 `live_note` 一句人话（"只有最近一次控制快照"），不让模型把旧快照当实时态。
 */
export function deviceStatusPayload(dev: AnsDevice): Record<string, unknown> {
  const live = deviceLiveStateOf(dev.status);
  const status: Record<string, unknown> | null = dev.status == null
    ? null
    : Object.fromEntries(Object.entries(dev.status).filter(([k]) => k !== 'live'));
  return {
    id: dev.id, name: dev.name, alias: dev.alias, call_name: deviceCallName(dev),
    kind: dev.kind, protocol: dev.protocol,
    address: dev.address, port: dev.port, capabilities: dev.capabilities,
    controllable: dev.controllable, authorized: dev.authorized,
    status, live,
    ...(live ? { live_source_label: liveSourceLabel(live.source) } : {}),
    ...(live ? {} : { live_note: liveAbsentNote() }),
    first_seen: dev.first_seen, last_seen: dev.last_seen,
  };
}

export function deviceTools(deps: ToolDeps) {
  const { db, taskId } = deps;
  const ddb = db as unknown as DeviceDb;
  const licDb = db as unknown as LicenseSettingDb;
  const transport: DeviceControlTransport = deps.controlDevice ?? defaultDeviceControl;

  /**
   * zx_20261014_1 批三: 把 `deviceId`/`name`（二选一）解析为**一台**设备——按名使唤的唯一入口。
   * 解析失败**如实回**一句（含歧义时并列候选），**不猜**；此时**不落审计**——留痕是"对**某台设备**的
   * 控制尝试"，查无此名/歧义没有可挂靠的设备 id，硬写会把名字塞进 `device_id` 列（污染账）。
   * （`runDeviceControl` 的 `unknown_device` 拒件分支仍在——面板 IPC 传陈旧 id 时照落，非本处所辖。）
   */
  function resolveOrError(raw: { deviceId?: string; name?: string }): { dev: AnsDevice } | { err: string } {
    const key = (raw.deviceId ?? '').trim() || (raw.name ?? '').trim();
    if (!key) return { err: '须提供 deviceId 或 name（先用 list_devices 查；二者至少一个）' };
    const r = resolveDeviceByName(ddb, key);
    if (r.ok) return { dev: r.device };
    if (r.reason === 'ambiguous') {
      return { err: `「${key}」匹配到多台设备，无法确定是哪一台——请改用 deviceId：`
        + r.candidates.map((c) => `${deviceCallName(c)}（${c.id}）`).join('、') };
    }
    return { err: `设备不存在：${key}（先用 list_devices 查名/id）` };
  }

  return {
    list_devices: {
      description: '列出局域网设备**台账**（自动发现所得的设备；含名/类别/协议/地址/是否可控/是否已授权控制）。'
        + '`call_name` 是"我们叫它什么"（用户别名优先，无别名即设备自述名）——**device_control/device_status 可直接用它在 `name` 里使唤**。'
        + '若列表为空，可能尚未开始发现或局域网内无设备。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        try {
          const devices = listDevices(ddb).map((d) => ({
            id: d.id, name: d.name, alias: d.alias, call_name: deviceCallName(d), kind: d.kind, protocol: d.protocol,
            address: d.address, port: d.port, controllable: d.controllable, authorized: d.authorized,
            last_seen: d.last_seen,
          }));
          return JSON.stringify({ count: devices.length, devices });
        } catch (e) {
          return JSON.stringify({ error: `读设备台账失败：${(e as Error)?.message || String(e)}` });
        }
      },
    },

    device_status: {
      description: '读取一台设备的**授权态、上次控制快照（`status`）与实时状态（`live`）**。按 `deviceId`（推荐）或 `name`（设备名/别名，见 list_devices 的 `call_name`）二选一指定。'
        + '`live` 来自设备订阅消息，`live_source_label` 说明来源（MQTT 订阅的 state/jattr 主题），`live.at` 是采集时刻。'
        + '未收到过为 `null`，此时 `live_note` 如实说明"只有最近一次控制快照（若有）"——**不要把旧快照当实时状态**。'
        + '云设备的 `provider_state` 如实说明查询结果（含 `source`/`collected_at`；未实现即 `unsupported`）。授权态决定能否执行 device_control。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: '设备 id（见 list_devices；与 name 二选一）' },
          name: { type: 'string', description: '设备名或别名（见 list_devices 的 call_name；与 deviceId 二选一）' },
        },
        required: [],
      }),
      execute: async (raw: { deviceId?: string; name?: string }) => {
        const r = resolveOrError(raw);
        if ('err' in r) return JSON.stringify({ error: r.err });
        const dev = r.dev;
        const payload = deviceStatusPayload(dev);
        // 云设备另问 Provider 一次（不做则如实 `unsupported`；**不**拿缓存快照冒充实时状态）。
        if (dev.protocol === 'cloud') {
          payload.provider_state = await cloudDeviceState(dev);
          // 查到了就说清"谁答的、何时答的"；查不到（含 unsupported）原样透出，不加装饰。
          const ps = payload.provider_state as { ok?: boolean; source?: string; collected_at?: string };
          if (ps?.ok) {
            ps.source = `云 Provider · ${cloudProviderIdOf(dev.address) || '未知'}`;
            ps.collected_at = new Date().toISOString();
          }
        }
        // zx_20261023_5 批三：miIO 设备同样**实问一次**（不拿控制快照冒充状态）；无 token 如实回原因。
        if (dev.protocol === 'miio') {
          const st = await miioDeviceState(dev);
          payload.provider_state = {
            ...st,
            source: `米家 miIO · ${dev.address}`,
            collected_at: new Date().toISOString(),
          };
        }
        return JSON.stringify(payload);
      },
    },

    device_control: {
      description: '控制一台设备（下发动作，如 turn_on/turn_off/set）。'
        + '按 `deviceId`（推荐）或 `name`（设备名/别名，见 list_devices 的 `call_name`）二选一指定设备——'
        + '**用户给设备起的名字可以直接用来控制**。'
        + '⚠ **须先授权**：设备须在「设备」面板被显式打开「允许控制」才能执行；未授权只可读状态。'
        + '门锁/安防类高危设备本轮**不开放**写操作。每次对**在册设备**的调用（含被拒）都会留审计。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: '设备 id（见 list_devices；与 name 二选一）' },
          name: { type: 'string', description: '设备名或别名（见 list_devices 的 call_name；与 deviceId 二选一）' },
          action: { type: 'string', description: '动作名（如 turn_on / turn_off / set）' },
          args: { type: 'object', description: '动作参数（可选，JSON 对象）' },
        },
        required: ['action'],
      }),
      execute: async (raw: { deviceId?: string; name?: string; action: string; args?: Record<string, unknown> }) => {
        // zx_20261005 M22（Team 档软闸）：锁定即**如实拒**，走既有 `denied` 形状（`reason:'team_required'`），
        //   不谎称"操作失败"——`how_to_authorize` 取真源拒因字符串，与面板/工具同一句话。
        const refusal = teamFeatureRefusal(licDb, 'device_control');
        if (refusal) {
          const outcome: DeviceControlOutcome = {
            ok: false, denied: true, reason: 'team_required',
            deviceId: raw.deviceId ?? raw.name ?? '', action: raw.action, error: `控制被拒（team_required）`, how_to_authorize: refusal,
          };
          return JSON.stringify(outcome);
        }
        // zx_20261014_1 批三: 先把 `deviceId`/`name` 解析为**在册设备**（不猜、歧义即列候选），
        //   再交 `runDeviceControl`（编排一处）——审计与台账状态都挂**真 id**，不挂名字。
        const r = resolveOrError(raw);
        if ('err' in r) return JSON.stringify({ ok: false, error: r.err });
        // 编排（闸→传动→审计→状态→事件）在 `runDeviceControl` **一处**，此处只传 `taskId` 与传动。
        const outcome = await runDeviceControl(ddb, { deviceId: r.dev.id, action: raw.action, args: raw.args, taskId }, transport);
        return JSON.stringify(outcome);
      },
    },

    /**
     * zx_20261018_1 批五「落」: 说一句"客厅有点热"，本工具把它**落成计划并执行**。
     * 词表/参数只问 `intent-protocol`，设备匹配只问 `home-intent`（K-6 判据在其中），
     * 落计划→认领→逐步执行走 `intent-plans` 的共享账与执行器——三路（门外/本地/面板）同一份。
     */
    device_intent: {
      description: '按「房间 + 感受」执行一条家居舒适意图（当前只支持 home.comfort）。'
        + '感受取值：hot（有点热）/ cold（有点冷）/ dark（太暗）/ bright（想更亮）。'
        + '本工具按确定性规则表排出步骤并**立即执行**（关窗帘/调空调/开灯等），不是只给建议；'
        + '计划只含**同房间**且**已授权控制**的设备，其余会如实列在 skipped 里（附原因）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          room: { type: 'string', description: '房间名（与设备台账里的房间名精确匹配，如「客厅」）' },
          feeling: { type: 'string', enum: ['hot', 'cold', 'dark', 'bright'], description: '感受' },
        },
        required: ['room', 'feeling'],
      }),
      execute: async (raw: { room?: string; feeling?: string }) => {
        const refusal = teamFeatureRefusal(licDb, 'device_control');
        if (refusal) {
          return JSON.stringify({ ok: false, denied: true, reason: 'team_required', error: '控制被拒（team_required）', how_to_authorize: refusal });
        }
        // 词表/参数校验只问协议面（多余键不进计划）。
        const v = validateIntent({ intent: HOME_COMFORT_INTENT, params: raw });
        if (!v.ok) return JSON.stringify({ ok: false, error: v.body.error, errors: v.body.errors ?? [] });
        // 与门外 `/intent/resolve` 同一条解析链：规则 → 失败且开关开 ⇒ 模型 → 再校验。
        //   开关缺省即开；关掉即只走规则（`modelPlan` 不注入）。
        const modelFallback = readBoolSetting(db, 'device.intent_model_fallback');
        const plan = await resolveComfortIntent(
          { intent: HOME_COMFORT_INTENT, params: v.params },
          {
            listDevices: () => listDevices(ddb),
            ...(modelFallback
              ? { modelPlan: (input) => runComfortModelPlan(input, { getAnsClient: () => deps.ctx.getAnsClient() }) }
              : {}),
          },
        );
        if (!plan.ok) {
          return JSON.stringify({
            ok: false, error: plan.reason,
            skipped: plan.skipped ?? [],
            ...(plan.message ? { message: plan.message } : {}),
          });
        }
        const owner = taskId ? `local:${taskId}` : 'local:chat';
        const created = createIntentPlan(ddb as unknown as IntentPlanDb, {
          terminalId: owner, capability: INTENT_CAPABILITY,
          params: v.params, steps: plan.steps, skipped: plan.skipped,
          source: plan.source ?? 'rule',
        });
        const exec = await executeDeviceIntentPlan(ddb, created.id, {
          actor: taskId ? { kind: 'task', ref: taskId } : { kind: 'panel' },
          taskId, transport,
        });
        if (!exec.ok) return JSON.stringify({ ok: false, planId: created.id, error: exec.reason });
        return JSON.stringify({
          ok: exec.status === 'executed', planId: created.id, status: exec.status,
          steps: exec.steps, skipped: plan.skipped, source: plan.source ?? 'rule',
        });
      },
    },
  };
}
