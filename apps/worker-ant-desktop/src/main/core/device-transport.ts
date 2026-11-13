/**
 * zx_20261112_2 B3「安」：设备**传动分档**（零依赖纯模块）。
 *
 * 为什么单独成文件：渲染层要显示「这台设备本机用什么方式控」，而 `device-registry.ts` 牵入
 *   许可/容量等 main 依赖（渲染层不得引 main 链）。纯映射放这里，main 与 renderer 同引一份，
 *   不在两边各写一套（那正是「发现得到、控不了」被说成「可控」的温床）。
 *
 * 口径：只看 `protocol`——`controllable`/`authorized`/`online` 是另外三件事，不在这里判。
 *   `mdns`/`ssdp` 只能回退通用 HTTP，成功率取决于设备；文案如实写，不承诺。
 */
export type DeviceControlChannel = 'mqtt' | 'miio' | 'http' | 'cloud' | 'none';

export function deviceControlChannel(dev: { protocol?: unknown } | null): DeviceControlChannel {
  const p = String(dev?.protocol ?? '').trim().toLowerCase();
  if (p === 'mqtt') return 'mqtt';
  if (p === 'miio') return 'miio';
  if (p === 'cloud') return 'cloud';
  if (p === 'http' || p === 'https' || p === 'mdns' || p === 'ssdp') return 'http';
  return 'none';
}

export const DEVICE_CONTROL_CHANNEL_LABEL: Record<DeviceControlChannel, string> = {
  mqtt: 'MQTT（有设备回执）',
  miio: '米家 miIO',
  http: '通用 HTTP（成功率取决于设备）',
  cloud: '三方云平台',
  none: '仅发现，本机无可用控制通道',
};
