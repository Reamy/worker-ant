/**
 * zx_20261112_1 B4「诊」——单模型**可用性说清**的唯一真源（零依赖纯模块）。
 *
 * 病根：模型页的徽标只有三段（已禁用 / 待配置端点 / 可用），把"看不见的原因"都压成最后一段：
 *   供应商被禁用、模型没有 chat 能力、服务端没返回 Key 状态——三种情况在界面上**都说成"可用"或
 *   什么都不说**，用户只能去翻日志。`available` 缺失（旧 ANS 未返回）时更被当成"可用"。
 *
 * 口径（与 `core/model-availability.ts` 的四数派生同一把尺，不另算一份）：
 *   原因枚举 `disabled / provider_disabled / no_endpoint / no_chat_capability / unknown`，按此优先级取第一个成立的。
 *   `unknown` 再分两句：**没返回钥匙状态**（`available` 缺失）与**可用性未知**（服务端明确 false）——
 *   前者是"不知道"，后者是"知道它现在不可用但不知道为什么"，都不是"可用"。
 */
import { parseModelCapabilities } from '../../../src/main/core/model-availability.js';

export type ModelUnavailableReason =
  | 'disabled'
  | 'provider_disabled'
  | 'no_endpoint'
  | 'no_chat_capability'
  | 'unknown';

export interface ModelAvailabilityInput {
  /** 0/false = 已禁用；1/true = 启用；缺省按启用论（旧数据没有该列）。 */
  enabled?: number | boolean | null;
  /** ANS 派生的"有可用端点与 Key"；`undefined/null` = **服务端未返回**（不猜可用）。 */
  available?: boolean | null;
  has_endpoint?: boolean | null;
  capabilities?: unknown;
  /** 所属供应商是否启用；缺省/查不到 ⇒ 不参与判定。 */
  providerEnabled?: number | boolean | null;
  /** 本页问的是"能不能跑任务"：要求 chat 能力。默认 false（只看通用可用性）。 */
  requireChat?: boolean;
}

export interface ModelAvailabilityView {
  usable: boolean;
  reason: ModelUnavailableReason | null;
  label: string;
  title: string;
  cls: string;
}

const CLS = {
  ok: 'bg-green-100 text-green-700',
  warn: 'bg-orange-100 text-orange-700',
  off: 'bg-gray-100 text-gray-500',
  danger: 'bg-red-100 text-red-600',
  unknown: 'bg-amber-50 text-amber-700',
};

const isOff = (v: number | boolean | null | undefined): boolean => v === 0 || v === false;

export function describeModelAvailability(input: ModelAvailabilityInput): ModelAvailabilityView {
  if (isOff(input.enabled)) {
    return { usable: false, reason: 'disabled', label: '已禁用', title: '该模型已被禁用（启用后才会被选型考虑）', cls: CLS.off };
  }
  if (isOff(input.providerEnabled)) {
    return { usable: false, reason: 'provider_disabled', label: '供应商已禁用', title: '所属供应商已禁用，本模型不会被选中；启用供应商后再试', cls: CLS.off };
  }
  if (input.has_endpoint === false) {
    return { usable: false, reason: 'no_endpoint', label: '待配置端点', title: '该模型没有可用端点（缺 URL/Key），执行侧选不中它', cls: CLS.warn };
  }
  if (input.requireChat && !parseModelCapabilities(input.capabilities).includes('chat')) {
    return { usable: false, reason: 'no_chat_capability', label: '缺 chat 能力', title: '该模型未声明 chat 能力：跑不出任务成果（其他能力不受影响）', cls: CLS.warn };
  }
  if (input.available === true) {
    return { usable: true, reason: null, label: '可用', title: '服务端确认该模型有可用端点与 Key', cls: CLS.ok };
  }
  if (input.available === false) {
    return { usable: false, reason: 'unknown', label: '可用性未知', title: '服务端标记为未确认可用（可能缺 Key 或端点不健康）；点「测试连接」实测', cls: CLS.unknown };
  }
  return { usable: false, reason: 'unknown', label: '未返回钥匙状态', title: '服务端未返回该模型是否有可用 Key 的状态——本页不猜；先配端点或点「测试连接」实测', cls: CLS.unknown };
}
