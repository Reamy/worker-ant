/**
 * zx_20261027_3 M1b「实况」：设备状态的**直查**——纯函数部分（零网络、可脱 electron 回归）。
 *
 * 病：MQTT/HA 设备有持续订阅（`devices.ipc.ts` 的 live subscription），但云 Provider 与 miIO
 * 只有在 `device_status` 工具被调用时才查一次 ⇒ 设备面板上的 miIO/涂鸦设备可能长时间停在旧快照。
 *
 * 治法：**只对没有实时订阅的协议**发起直查（MQTT/HA 已有上行，重复查会双写、且会拿直查结果
 * 覆盖设备自己刚报的状态）；直查结果按诚实的来源标记（`source='provider'`）写回既有 `live` 字段，
 * 不新造状态字段，也不冒充上行。失败逐条如实返回，不伪造在线/状态。
 */

/** 直查所需的最小设备形状（`AnsDevice` 的超集兼容）。 */
export interface RefreshableDevice {
  id: string;
  name: string;
  protocol: string;
  address: string;
}

export type StatePollProtocol = 'cloud' | 'miio';

export interface SkippedDevice {
  id: string;
  name: string;
  protocol: string;
  reason: string;
}

export interface StateRefreshSelection<T> {
  targets: T[];
  skipped: SkippedDevice[];
}

function skipReason(protocol: string): string {
  if (protocol === 'mqtt') return '已有实时订阅（MQTT/HA），不重复轮询';
  if (protocol === 'mdns' || protocol === 'ssdp') return '局域网发现设备未提供状态查询';
  return `协议 ${protocol || '未知'} 无状态查询`;
}

/**
 * 选出本轮该直查的设备：**只收** `cloud` / `miio`；其余逐条给出跳过原因（面板可解释"为什么没刷"）。
 * 顺序保持台账顺序（模板不必排序；调用方按需再筛 token）。
 */
export function selectStateRefreshTargets<T extends RefreshableDevice>(
  devices: readonly T[],
): StateRefreshSelection<T> {
  const targets: T[] = [];
  const skipped: SkippedDevice[] = [];
  for (const dev of devices) {
    if (dev.protocol === 'cloud' || dev.protocol === 'miio') {
      targets.push(dev);
    } else {
      skipped.push({ id: dev.id, name: dev.name, protocol: dev.protocol, reason: skipReason(dev.protocol) });
    }
  }
  return { targets, skipped };
}

/** `setDeviceLiveState` 的写回补丁（`provider` 来源）。查不到状态 ⇒ `null`（不写、不抹旧值）。 */
export interface ProviderLivePatch {
  source: 'provider';
  state: string;
  attributes: Record<string, unknown>;
  attributes_error: string;
}

/**
 * Provider 直查结果 → live 补丁。
 * `ok:false`（含 `unsupported`）⇒ `null`：**不写**——旧快照保持原样，失败原因由调用方逐条回给界面，
 * 而不是把一个空状态写成"设备没状态"。
 */
export function livePatchFromProviderState(result: {
  ok: boolean;
  state?: Record<string, unknown>;
  unsupported?: boolean;
  error?: string;
}): ProviderLivePatch | null {
  if (!result.ok || result.state == null || typeof result.state !== 'object' || Array.isArray(result.state)) return null;
  return { source: 'provider', state: '', attributes: result.state, attributes_error: '' };
}
