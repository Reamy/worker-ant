/**
 * zx_20261029_2 M3「通」（罗尔斯·无知之幕 / 维特根斯坦·意义即用法）: **能力词汇的唯一来源**。
 *
 * 问题：同一台机器的"能干什么"此前有三份措辞——门牌 `skills`（节点卡组装处手拼）、
 * 配对后的 `/capabilities`（另一处手拼）、A2A 卡的 `skills` 模板（第三处形状）。三份各自演进 ⇒
 * 「节点卡说能做、门牌没说、A2A 又换了一套词」。
 *
 * 本模块只答三件事，**一律类目级、不出现任何实例**（设备名/房间/地址/授权态都不在这里）：
 *   ① `deviceCategoryInventory` —— 屋里有哪几类设备、各几台（只有类目与数量）；
 *   ② `agentSkillsFromCapabilities` —— 一条能力类目 → 一条技能条目（门牌与 A2A 卡共用）；
 *   ③ `peerCapabilitySummary` —— 节点卡随心跳上送的那一小面（意图 + 设备类目）。
 *
 * ⚠ 本模块**零依赖**（不引 electron / 库 / 网络 / 时钟）：门牌、节点卡、rr 都可直接跑真实现。
 * ⚠ `publicIntents` **直接从 `intent-protocol` 转出**，不在此另写一份意图词表——词表两处即是漂移。
 */
import {
  DEVICE_KIND_CLASSES,
  deviceKindClassOf,
  kindClassLabel,
  type DeviceKindClass,
  type KindClassDeviceLike,
} from './device-kind.js';
import { publicIntents, type PublicIntentDescriptor } from './intent-protocol.js';

export { publicIntents };
export type { PublicIntentDescriptor };

/** 类目桶（**只有类目与数量**——门外看得到"屋里有灯"，看不到"哪盏灯"）。 */
export interface DeviceCategorySummary {
  class: DeviceKindClass;
  label: string;
  count: number;
}

/**
 * 台账 → 类目清单。序＝`DEVICE_KIND_CLASSES` 序（与词表同序，不另排一套）；
 * **`unknown` 不入清单**——"品类未识别"不是一类能力，列出来等于承诺了一个做不到的类目。
 */
export function deviceCategoryInventory(
  devices: readonly KindClassDeviceLike[],
): DeviceCategorySummary[] {
  const counts = new Map<DeviceKindClass, number>();
  for (const d of devices) {
    const cls = deviceKindClassOf(d);
    if (cls === 'unknown') continue;
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return DEVICE_KIND_CLASSES
    .filter((cls) => cls !== 'unknown' && (counts.get(cls) ?? 0) > 0)
    .map((cls) => ({ class: cls, label: kindClassLabel(cls), count: counts.get(cls)! }));
}

/**
 * 技能条目（门牌 `skills` 与 A2A 卡 `skills` 的**同一形状**）。
 * `AgentCardSkill` 与 `a2a-runtime.AgentCardTemplate['skills'][number]` 都与它结构相容——
 * 三处共享这一份映射，不各拼一遍 `id/name/description/tags`。
 */
export interface CapabilitySkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/** 能力类目 → 技能条目（`id` 用能力键；`tags` 第二项取键首段，便于按域归类）。 */
export function agentSkillsFromCapabilities(
  caps: ReadonlyArray<{ key: string; label: string }>,
): CapabilitySkill[] {
  return caps.map((c) => ({
    id: c.key,
    name: c.label,
    description: `${c.label}（经配对与本机用户批准后可用）`,
    tags: ['worker-ant', c.key.split('_')[0] ?? c.key],
  }));
}

/** 节点卡上送的那一小面：意图 **id/label**（不含参数——节点卡是能力自述，不是协议文档）+ 设备类目。 */
export interface PeerCapabilitySummary {
  intents: Array<{ id: string; label: string }>;
  device_categories: DeviceCategorySummary[];
}

/** 节点卡用的能力摘要（`intents` 只留 id/label；`device_categories` 同门牌同一算法）。 */
export function peerCapabilitySummary(devices: readonly KindClassDeviceLike[]): PeerCapabilitySummary {
  return {
    intents: publicIntents().map((i) => ({ id: i.id, label: i.label })),
    device_categories: deviceCategoryInventory(devices),
  };
}
