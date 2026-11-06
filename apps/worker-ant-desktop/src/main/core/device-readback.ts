/**
 * zx_20261101_2 M2（王阳明·知行合一）: 控制后的**有界回读**——下发成功不等于生效。
 *
 * 只对**没有实时订阅**的协议回读（`cloud` / `miio`）：MQTT/HA 设备有上行订阅，
 * 设备自己会报，重复直查反而拿直查结果盖掉它刚报的状态（承 zx_20261027_3 M1b）。
 *
 * 三条纪律：
 *   ① **有界**：超过 `timeoutMs`（缺省 2500ms）即如实回"回读超时"，不无限等；
 *   ② **不改控制结果**：回读失败只影响影子的 `verify_error`，控制本身仍是 `ok`；
 *   ③ **可注入**：`reader` 缺省走真 Provider/miIO，受控回归喂慢/假实现（不触网）。
 */
import type { AnsDevice } from './device-registry.js';
import { cloudDeviceState } from './device-provider.js';
import { miioDeviceState } from './providers/mijia-miio.js';

/** 回读超时缺省值（计划：≤2.5s）。 */
export const DEVICE_READBACK_TIMEOUT_MS = 2500;

/** 回读结论（与 `ProviderStateResult` 同形，避免反向依赖）。 */
export interface ReadbackOutcome {
  ok: boolean;
  state?: Record<string, unknown>;
  unsupported?: boolean;
  error?: string;
}

/** 状态读取器签名（真机 / 回归假实现同形）。 */
export type DeviceStateReader = (dev: AnsDevice) => Promise<ReadbackOutcome>;

/** 该协议是否需要控制后回读（有实时订阅的不回读）。 */
export const STATE_READBACK_PROTOCOLS: ReadonlySet<string> = new Set(['cloud', 'miio']);

/** 缺省读取器：云走 Provider 注册表、米家走 miIO；其余协议如实说"没有这一问"。 */
export const defaultDeviceStateReader: DeviceStateReader = async (dev) => {
  if (dev.protocol === 'cloud') return cloudDeviceState(dev);
  if (dev.protocol === 'miio') return miioDeviceState(dev);
  return { ok: false, unsupported: true, error: `协议 ${dev.protocol || '未知'} 没有状态查询入口` };
};

/**
 * 控制后**有界回读**。超时/抛错都收成 `{ok:false, error}`（回读失败是结果，不是崩溃）。
 * ⚠ `reader` 抛出的异常也在这里收——绝不把异常冒进控制编排。
 */
export async function readbackAfterControl(
  dev: AnsDevice,
  opts: { timeoutMs?: number; reader?: DeviceStateReader } = {},
): Promise<ReadbackOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEVICE_READBACK_TIMEOUT_MS;
  const reader = opts.reader ?? defaultDeviceStateReader;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ReadbackOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `回读超时（>${timeoutMs}ms）` }), Math.max(1, timeoutMs));
  });
  try {
    const read = reader(dev).catch((e: unknown): ReadbackOutcome => ({
      ok: false,
      error: `回读失败：${(e as Error)?.message || String(e)}`,
    }));
    return await Promise.race([read, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
