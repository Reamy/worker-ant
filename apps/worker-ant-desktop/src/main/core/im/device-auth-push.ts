/**
 * zx_20261101_1 M2「授」（道德经·「君子以思患而豫防之」 / 维特根斯坦·意义即使用）:
 * **新设备一进门，问一声「允不允许用」**——把"发现"接到"授权"的 IM 闭环上。
 *
 * 病根：设备发现只落台账、只刷面板；用户不在电脑前就**不知道有东西在问**，
 *   而 `deviceControlVerdict` 的 `not_authorized` 只在**控制失败时**才教人怎么授权——顺序反了。
 *
 * 三条纪律：
 *  ① **只问该问的**：`isNew` ∧ 可控 ∧ 未授权 ∧ 非高危（门锁/安防永不入台，同 `approval-inbox.ts`）。
 *  ② **一次发现只问一条**：局域网/MQTT 两路可能先后报同一台，窗口内按 id 去重、聚合成一条
 *     （一次发现 20 台不发 20 条）；首个合格设备起 1.5 秒窗口，窗到即发。
 *  ③ **旁路不阻断**：推送失败如实打日志，不影响发现落库与面板刷新。
 *
 * ⚠ 零 electron 依赖；定时器可注入（rr 不依赖墙钟）。
 */
import type { AnsDevice } from '../device-registry.js';
import { isHighRiskKind } from '../device-registry.js';
import { buildDeviceAuthNotice } from './approval-inbox.js';

/** 聚合窗口：首个合格设备到达后等这么久，把同一次发现里的其余设备并进同一条消息。 */
export const DEVICE_AUTH_PUSH_WINDOW_MS = 1500;

/** 该设备是否值得问一声（判据只此一处；`approval-inbox.ts` 的入台条件与它同义）。 */
export function shouldAskDeviceAuth(dev: Pick<AnsDevice, 'controllable' | 'authorized' | 'kind'>): boolean {
  return dev.controllable && !dev.authorized && !isHighRiskKind(dev.kind);
}

export interface DeviceAuthPushDeps {
  /** 真发（生产＝`pushImOwnerNotice`）；失败由本模块记录，不抛给发现链路。 */
  push(message: string, kind: string): Promise<void>;
  /** 计时器（rr 注入同步假钟；返回句柄用于清除）。 */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void; cancel?: () => void };
  windowMs?: number;
  /** 一次最多列几台（透传 `buildDeviceAuthNotice`，其余引导查清单）。 */
  limit?: number;
  /** 出错留痕（缺省 console.error；rr 可收集）。 */
  onError?: (err: unknown) => void;
}

export interface DeviceAuthPusher {
  /** 一次发现落账后调用；`isNew=false` 或不合格设备一律忽略。 */
  onDiscovered(dev: AnsDevice | null | undefined, isNew: boolean): void;
  /** 立刻冲刷窗口（rr / 退出前用；生产通常让定时器自己到点）。 */
  flush(): void;
}

const defaultSetTimer = (fn: () => void, ms: number): { unref?: () => void; cancel: () => void } => {
  const t = setTimeout(fn, ms);
  // 不让一条待发通知拖住进程退出（与既有 unref 用法同口径）。
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export function createDeviceAuthPusher(deps: DeviceAuthPushDeps): DeviceAuthPusher {
  const windowMs = deps.windowMs ?? DEVICE_AUTH_PUSH_WINDOW_MS;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const onError = deps.onError ?? ((err: unknown) => console.error('[IM] 设备授权推送失败：', (err as Error)?.message || String(err)));
  let buffer: AnsDevice[] = [];
  let timer: { unref?: () => void; cancel?: () => void } | null = null;

  const flush = (): void => {
    if (timer?.cancel) timer.cancel();
    timer = null;
    const batch = buffer;
    buffer = [];
    if (batch.length === 0) return;
    void deps.push(buildDeviceAuthNotice(batch, deps.limit), 'device_authorize').catch(onError);
  };

  return {
    onDiscovered(dev, isNew) {
      if (!isNew || !dev || !shouldAskDeviceAuth(dev)) return;
      // 同一台被两路先后报到 ⇒ 只留最新一行（按 id 去重，不按名字——名字可能重）。
      const i = buffer.findIndex((d) => d.id === dev.id);
      if (i >= 0) buffer[i] = dev;
      else buffer.push(dev);
      if (!timer) timer = setTimer(flush, windowMs);
    },
    flush,
  };
}
