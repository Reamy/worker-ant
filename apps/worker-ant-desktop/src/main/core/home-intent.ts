/**
 * zx_20261018_1 批五「落」（王阳明·知行合一 / 庄子·不预设）: `home.comfort` 的**确定性规则表**。
 * zx_20261029_2 M2「通」: 角色改按 `kind_class` 取（品类归一后同一套词），失败原因细分到可行动，
 *   并在规则排不出时提供**模型兜底**的装配挂点（`resolveComfortIntent`；模型实现见 `intent-model-plan.ts`）。
 *
 * 门外说一句"客厅有点热"，本模块把它落成**可执行的步骤**——规则路径不调模型、不做模糊匹配，
 * 只看台账里**同房间**设备的 `kind_class`，按固定规则逐条排出动作并附理由。
 *
 * 口径：
 *   · **房间**匹配＝`normalizeRoomName` 归一 + 大小写不敏感**精确相等**（与 `devicesInRoom` 同一把尺）；
 *     不做子串/模糊——`客厅1` 不是 `客厅`。
 *   · **角色**只由 `kind_class` 决定（窗帘/空调/灯/风扇）；`kind_class` 缺失时用 `kindClassOf` 现算，
 *     判据仍只有那一份（`core/device-kind.ts`）。认不出类目就不猜，不进计划。
 *   · **能不能控**只问 K-6 判据 `deviceControlVerdict`（未授权/不可控/高危一律进 `skipped` 并带原因），
 *     本模块**不另写第二份判据**。
 *   · 计划里**只有**通过判据的设备；解析期**零设备动作**（真正的执行在 `intent-plans` 的共享执行器）。
 */
import type { AnsDevice } from './device-registry.js';
import { deviceControlVerdict, normalizeRoomName } from './device-registry.js';
import { deviceCallName } from './device-name.js';
import {
  deviceKindClassOf,
  kindClassOf,
  type DeviceKindClass,
  type KindClassDeviceLike,
} from './device-kind.js';
import type { IntentSkip, IntentStep } from './intent-plans.js';
import type { IntentResolveOutcome } from './external-calls.js';
import {
  COMFORT_FEELINGS,
  HOME_COMFORT_INTENT,
  type ComfortFeeling,
} from './intent-protocol.js';

/** 规则表里的设备角色——只由归一后的 `kind_class` 映射，不做名字猜测。 */
export type HomeComfortRole = 'curtain' | 'aircon' | 'light' | 'fan';

/** 类目 → 角色。表外（开关/传感器/门锁/未知）一律 `null`（不预设它能做什么）。 */
const CLASS_ROLE: Partial<Record<DeviceKindClass, HomeComfortRole>> = {
  curtain: 'curtain',
  aircon: 'aircon',
  light: 'light',
  fan: 'fan',
};

/** 设备可判定品类的最小形状（`AnsDevice` 与 rr 夹具同形；真源在 `device-kind.ts`）。 */
export type ComfortDeviceLike = KindClassDeviceLike;

/** 品类：优先读台账派生列；旧行/夹具缺列时按 `kindClassOf` 现算——实现已下沉 `device-kind.ts`（一处真源）。 */
export { deviceKindClassOf } from './device-kind.js';

/**
 * 设备 → 规则角色。入参可以是设备对象，也可以是自述 `kind` 字符串（rr/调用点只看词时用）；
 * 两条路都先归一到 `kind_class`，**不维护第二份 kind 词表**。
 */
export function homeComfortRoleOf(device: ComfortDeviceLike | string): HomeComfortRole | null {
  const cls = typeof device === 'string'
    ? kindClassOf({ kind: device, protocol: '' })
    : deviceKindClassOf(device);
  return CLASS_ROLE[cls] ?? null;
}

interface RuleStep {
  role: HomeComfortRole;
  action: string;
  args?: Record<string, unknown>;
  reason: string;
}

/**
 * 规则表（**唯一真源**）：感受 → 有序步骤。
 * ⚠ 不含 `set_mode`——"冷/热"只调温，不替用户选模式（模式是另一件事，绝不顺带写）。
 * ⚠ `hot` 的「开风扇」排在空调之后：先关窗帘、再调温、最后用风扇帮助空气流通；
 *   房间里没有风扇时该步自然不落（规则表不带条件，按角色逐条匹配）。
 */
export const COMFORT_RULES: Record<ComfortFeeling, readonly RuleStep[]> = {
  hot: [
    { role: 'curtain', action: 'close', reason: '室温偏高：先关窗帘，减少阳光直射进来的热量。' },
    { role: 'aircon', action: 'set_temperature', args: { temperature: 26 }, reason: '室温偏高：空调设为 26°C。' },
    { role: 'fan', action: 'turn_on', reason: '室温偏高：开风扇帮助空气流通。' },
  ],
  cold: [
    { role: 'curtain', action: 'close', reason: '室温偏低：关窗帘，减少热量散失。' },
    { role: 'aircon', action: 'set_temperature', args: { temperature: 24 }, reason: '室温偏低：空调设为 24°C。' },
  ],
  dark: [
    { role: 'light', action: 'turn_on', reason: '光线不足：打开房间里的灯。' },
  ],
  bright: [
    { role: 'curtain', action: 'open', reason: '想要更亮：打开窗帘。' },
  ],
};

/** 同房间设备（房间归一后精确相等；空房间名不匹配任何房间）。 */
export function devicesInRoom(devices: AnsDevice[], room: string): AnsDevice[] {
  const roomKey = normalizeRoomName(room).toLowerCase();
  if (!roomKey) return [];
  return devices.filter((d) => normalizeRoomName(d.room).toLowerCase() === roomKey);
}

/** 失败原因 → 一句**可行动**的下一步（门外回包、面板、工具三处同一句）。 */
export function comfortFailureMessage(reason: string, skipped: IntentSkip[] = []): string {
  switch (reason) {
    case 'room_unassigned':
      return '这个房间还没有设备。先到「设备」页把设备指派到该房间，再试一次。';
    case 'no_recognized_kind':
      return '房间里的设备都没能识别出品类。先在「设备」页完成配对或补齐令牌/型号后重试。';
    case 'no_controllable_device':
      return skipped.length > 0
        ? '房间里有相关设备，但都没有通过控制闸——先在「设备」页为它们打开「允许控制」。'
        : '该房间还没有能实现这种感受的设备（如窗帘、空调、灯、风扇）。';
    case 'invalid_params':
      return '房间与感受都必须填写（感受取值：hot / cold / dark / bright）。';
    case 'unknown_intent':
      return '只支持 home.comfort：告诉我「哪个房间 + 什么感受」。';
    default:
      return '这次没能生成可执行的计划，请稍后重试。';
  }
}

/**
 * 把"某个房间、某种感受"落成计划。
 *
 * 失败原因**分细**（各带可行动下一步，见 `comfortFailureMessage`）：
 *   · `room_unassigned`      —— 该房间没有设备，但台账里确有**未分房间**的设备；
 *   · `no_recognized_kind`   —— 房间里有设备，但品类全是 `unknown`（不认识就不猜）；
 *   · `no_controllable_device` —— 有相关设备，但全被 K-6 拒（或没有能实现该感受的设备）。
 * 未通过判据的**相关**设备照实进 `skipped`（带判据给的原因），不静默丢。
 */
export function planHomeComfort(
  devices: AnsDevice[],
  room: string,
  feeling: ComfortFeeling,
): IntentResolveOutcome {
  const inRoom = devicesInRoom(devices, room);
  if (inRoom.length === 0) {
    const hasUnassigned = devices.some((d) => !normalizeRoomName(d.room));
    return { ok: false, reason: hasUnassigned ? 'room_unassigned' : 'no_controllable_device' };
  }
  if (inRoom.every((d) => deviceKindClassOf(d) === 'unknown')) {
    return { ok: false, reason: 'no_recognized_kind' };
  }

  const steps: IntentStep[] = [];
  const skipped: IntentSkip[] = [];
  for (const rule of COMFORT_RULES[feeling]) {
    for (const dev of inRoom) {
      if (homeComfortRoleOf(dev) !== rule.role) continue;
      // K-6 一处真源：能不能控只问它（未授权/不可控/高危都带回可行动的下一步）。
      const verdict = deviceControlVerdict(dev);
      if (!verdict.ok) {
        skipped.push({ call_name: deviceCallName(dev), reason: verdict.how });
        continue;
      }
      steps.push({
        call_name: deviceCallName(dev),
        action: rule.action,
        ...(rule.args ? { args: { ...rule.args } } : {}),
        reason: rule.reason,
      });
    }
  }
  if (steps.length === 0) return { ok: false, reason: 'no_controllable_device', skipped };
  return { ok: true, steps, skipped };
}

/** 门外解析器的注入面：台账读取由装配层给（本模块不触库）。 */
export function createHomeIntentResolver(getDevices: () => AnsDevice[]) {
  return (input: { intent: string; params: Record<string, unknown> }): IntentResolveOutcome => {
    if (input.intent !== HOME_COMFORT_INTENT) return { ok: false, reason: 'unknown_intent' };
    const room = typeof input.params.room === 'string' ? input.params.room : '';
    const feeling = typeof input.params.feeling === 'string' ? input.params.feeling : '';
    if (!room.trim()) return { ok: false, reason: 'invalid_params' };
    if (!(COMFORT_FEELINGS as readonly string[]).includes(feeling)) return { ok: false, reason: 'invalid_params' };
    return planHomeComfort(getDevices(), room, feeling as ComfortFeeling);
  };
}

/**
 * 模型兜底挂点（真实现由 `intent-model-plan.runComfortModelPlan` 装配；rr 可喂假规划器）。
 * 返回的步骤仍会被 `resolveComfortIntent` **再校验一遍**（设备在册 + K-6 通过），
 * 故模型无法绕过安全闸；本类型只约束形状，不在此处实现任何模型调用。
 */
export type ComfortModelPlanner = (input: {
  room: string;
  feeling: ComfortFeeling;
  devices: AnsDevice[];
}) => Promise<{ ok: true; steps: IntentStep[] } | { ok: false; reason: string }>;

export interface ComfortResolveDeps {
  listDevices(): AnsDevice[];
  /** 未给 ⇒ 只走规则（开关关掉 / ANS 不可用 / rr 未装配时即此形态）。 */
  modelPlan?: ComfortModelPlanner;
}

/**
 * **门外与门内共用的一条解析链**（zx_20261029_2 M2）：规则 → 失败且房里有可执行设备 → 模型 → 再校验。
 *
 * 口径：
 *   · 规则成功 ⇒ `source:'rule'`，不调模型（零额外延迟）；
 *   · 规则失败但**没有**「品类已识别且过了 K-6」的设备 ⇒ 不调模型（调了也无从落步，且别把安全拒当模型机会）；
 *   · 模型失败/超时/整份校验不过 ⇒ **原样回规则的失败原因**（不假装执行、不落半份计划）；
 *   · 模型步骤逐一按 `call_name` 映射回**当前台账**里同房间且 K-6 通过的设备，任一不在册即略过并记原因。
 */
export async function resolveComfortIntent(
  input: { intent: string; params: Record<string, unknown> },
  deps: ComfortResolveDeps,
): Promise<IntentResolveOutcome> {
  if (input.intent !== HOME_COMFORT_INTENT) return { ok: false, reason: 'unknown_intent' };
  const room = typeof input.params.room === 'string' ? input.params.room : '';
  const feeling = typeof input.params.feeling === 'string' ? input.params.feeling : '';
  if (!room.trim()) return { ok: false, reason: 'invalid_params' };
  if (!(COMFORT_FEELINGS as readonly string[]).includes(feeling)) return { ok: false, reason: 'invalid_params' };

  const devices = deps.listDevices();
  const rule = planHomeComfort(devices, room, feeling as ComfortFeeling);
  if (rule.ok) return { ...rule, source: 'rule' };

  const failed: IntentResolveOutcome = {
    ...rule,
    source: 'rule',
    message: comfortFailureMessage(rule.reason, rule.skipped ?? []),
  };
  if (!deps.modelPlan) return failed;

  const usable = devicesInRoom(devices, room)
    .filter((d) => deviceKindClassOf(d) !== 'unknown' && deviceControlVerdict(d).ok);
  if (usable.length === 0) return failed;

  let modeled: Awaited<ReturnType<ComfortModelPlanner>>;
  try {
    modeled = await deps.modelPlan({ room, feeling: feeling as ComfortFeeling, devices });
  } catch {
    return failed;
  }
  if (!modeled.ok || modeled.steps.length === 0) return failed;

  const byName = new Map(usable.map((d) => [deviceCallName(d), d]));
  const steps: IntentStep[] = [];
  const skipped = [...(rule.skipped ?? [])];
  for (const step of modeled.steps) {
    const dev = byName.get(step.call_name);
    if (!dev) {
      skipped.push({ call_name: step.call_name, reason: '模型给出的设备不在可执行清单里，已略过。' });
      continue;
    }
    const verdict = deviceControlVerdict(dev);
    if (!verdict.ok) {
      skipped.push({ call_name: step.call_name, reason: verdict.how });
      continue;
    }
    steps.push(step);
  }
  if (steps.length === 0) return { ...failed, skipped };
  return { ok: true, steps, skipped, source: 'model' };
}
