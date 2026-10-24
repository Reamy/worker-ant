/**
 * zx_20261018_1 批五「落」（王阳明·知行合一 / 庄子·不预设）: `home.comfort` 的**确定性规则表**。
 *
 * 门外说一句"客厅有点热"，本模块把它落成**可执行的步骤**——不调模型、不做模糊匹配，
 * 只看台账里**同房间**设备的自述 `kind`，按固定规则逐条排出动作并附理由。
 *
 * 口径：
 *   · **房间**匹配＝`normalizeRoomName` 归一 + 大小写不敏感**精确相等**（与 `devicesInRoom` 同一把尺）；
 *     不做子串/模糊——`客厅1` 不是 `客厅`。
 *   · **角色**只由设备**自述 kind** 决定（`cover` → 窗帘、`climate` → 空调、`light` → 灯）。
 *     认不出 `kind` 就不猜，不进计划。
 *   · **能不能控**只问 K-6 判据 `deviceControlVerdict`（未授权/不可控/高危一律进 `skipped` 并带原因），
 *     本模块**不另写第二份判据**。
 *   · 计划里**只有**通过判据的设备；解析期**零设备动作**（真正的执行在 `intent-plans` 的共享执行器）。
 */
import type { AnsDevice } from './device-registry.js';
import { deviceControlVerdict, normalizeRoomName } from './device-registry.js';
import { deviceCallName } from './device-name.js';
import type { IntentSkip, IntentStep } from './intent-plans.js';
import type { IntentResolveOutcome } from './external-calls.js';
import {
  COMFORT_FEELINGS,
  HOME_COMFORT_INTENT,
  type ComfortFeeling,
} from './intent-protocol.js';

/** 规则表里的设备角色——只由自述 `kind` 映射，不做名字猜测。 */
export type HomeComfortRole = 'curtain' | 'aircon' | 'light';

/** 自述 kind → 角色。表外的一律 `null`（不预设它是什么）。 */
const KIND_ROLE: Record<string, HomeComfortRole> = {
  cover: 'curtain',
  curtain: 'curtain',
  climate: 'aircon',
  air_conditioner: 'aircon',
  light: 'light',
};

export function homeComfortRoleOf(kind: string): HomeComfortRole | null {
  return KIND_ROLE[kind.trim().toLowerCase()] ?? null;
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
 */
export const COMFORT_RULES: Record<ComfortFeeling, readonly RuleStep[]> = {
  hot: [
    { role: 'curtain', action: 'close', reason: '室温偏高：先关窗帘，减少阳光直射进来的热量。' },
    { role: 'aircon', action: 'set_temperature', args: { temperature: 26 }, reason: '室温偏高：空调设为 26°C。' },
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

/**
 * 把"某个房间、某种感受"落成计划。
 * 失败时：房间里没有任何设备 / 没有任何一台通过 K-6 ⇒ `no_controllable_device`（不生成空计划）；
 * 未通过判据的**相关**设备照实进 `skipped`（带判据给的原因），不静默丢。
 */
export function planHomeComfort(
  devices: AnsDevice[],
  room: string,
  feeling: ComfortFeeling,
): IntentResolveOutcome {
  const roomKey = normalizeRoomName(room).toLowerCase();
  const inRoom = roomKey ? devices.filter((d) => normalizeRoomName(d.room).toLowerCase() === roomKey) : [];
  if (inRoom.length === 0) {
    return { ok: false, reason: 'no_controllable_device' };
  }

  const steps: IntentStep[] = [];
  const skipped: IntentSkip[] = [];
  for (const rule of COMFORT_RULES[feeling]) {
    for (const dev of inRoom) {
      if (homeComfortRoleOf(dev.kind) !== rule.role) continue;
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
