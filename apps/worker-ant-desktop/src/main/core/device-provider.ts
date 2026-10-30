/**
 * zx_20261017_1 批八（庄子·道在屎溺／维特根斯坦·意义即用法）:
 * **设备 Provider 框架**——让"厂商云"退成一种可插拔的传动实现，而不是又一条控制通路。
 *
 * 三件事：
 *   ① **接口**：`DeviceProvider` 只答两问——"你名下有哪些设备"（`listDevices`）与"下发一条命令"（`control`）。
 *      台账/授权/审计/事件**全不在** Provider 里（那些是 `device-registry` + `runDeviceControl` 的既有语义）。
 *   ② **注册表**：Provider 按 `id` 注册；`defaultDeviceControl` 是**唯一选路**，`protocol='cloud'` 时
 *      按地址前缀 `<providerId>:<deviceId>` 找 Provider——**未注册即如实拒，绝不退回 HTTP 误发**。
 *   ③ **同步**：`syncProviderDevices` 把 Provider 的设备列表按既有幂等 upsert 入账
 *      （去重键 `protocol+address`，发现不覆盖 `alias`/`authorized`）。
 *
 * ⚠ **零网络依赖**：本模块只编排，不认识任何厂商；真 HTTP 在 `providers/tuya-cloud.ts` 且**可注入**。
 * ⚠ 云端设备仍走既有 `runDeviceControl`（闸→传动→审计→状态→事件），**不绕过 K-6**。
 */
import {
  findDeviceByIdentity,
  upsertDiscovered,
  type AnsDevice,
  type DeviceDb,
  type DiscoveredDevice,
} from './device-registry.js';

/** 地址约定：`<providerId>:<providerDeviceId>`——云端设备的去重键是 `protocol + 这个整串`。 */
export const CLOUD_ADDRESS_SEP = ':';

/** Provider 交上来的设备候选——**只带自述字段**（授权/在线/别名是台账的事，Provider 不碰）。 */
export interface ProviderDevice {
  /** Provider 侧的稳定设备 id（入账时拼进 `address`）。 */
  id: string;
  name: string;
  kind: string;
  /**
   * 厂商自己的品类词汇（如涂鸦 `cl/kt/dj`）→ 归一后的派生类目（zx_20261029_2 M1）。
   * Provider 最懂自己的 category，故在这里算好；缺省 ⇒ 台账按 `kind` 现算。
   */
  kindClass?: string;
  capabilities?: string[];
  controllable?: boolean;
}

/** 一次控制的结果（与 `tools/device.ts` 的 `DeviceControlResult` 结构同形，避免反向依赖）。 */
export interface ProviderControlResult {
  ok: boolean;
  result: string;
}

/**
 * 一个厂商云的适配面。`control` 收的是 **Provider 侧设备 id**（不是台账 id）——
 * Provider 不需要知道本机台账怎么编号。
 */
/**
 * 一次**状态查询**的结果（zx_20261018_1 批四）。
 * ⚠ `unsupported:true` 是"该 Provider 没提供这一问"的**如实答复**，不是失败：
 *   调用方据此说"不支持查询"，**绝不**回一个编造的状态。
 */
export interface ProviderStateResult {
  ok: boolean;
  /** 设备自述状态（原样透传，不加工）；`ok:false` 时无此键。 */
  state?: Record<string, unknown>;
  unsupported?: boolean;
  error?: string;
}

export interface DeviceProvider {
  id: string;
  label: string;
  listDevices(): Promise<ProviderDevice[]>;
  control(deviceId: string, action: string, args: Record<string, unknown>): Promise<ProviderControlResult>;
  /** 可选：查设备状态。未实现 ⇒ `cloudDeviceState` 如实回 `unsupported`（不编状态）。 */
  getState?(deviceId: string): Promise<ProviderStateResult>;
}

/** 拼云设备地址（唯一拼法）。 */
export function cloudAddress(providerId: string, deviceId: string): string {
  return `${providerId}${CLOUD_ADDRESS_SEP}${deviceId}`;
}

/** 取地址里的 Provider id（无前缀 ⇒ 空串，调用方如实拒，不猜一个默认厂商）。 */
export function cloudProviderIdOf(address: string): string {
  const i = address.indexOf(CLOUD_ADDRESS_SEP);
  return i > 0 ? address.slice(0, i) : '';
}

/** 取地址里的 Provider 侧设备 id（无前缀 ⇒ 原样返回；空串由调用方拒）。 */
export function cloudDeviceIdOf(address: string): string {
  const i = address.indexOf(CLOUD_ADDRESS_SEP);
  return i >= 0 ? address.slice(i + 1) : address;
}

const registry = new Map<string, DeviceProvider>();

/** 注册/替换一个 Provider（同 id 后注册者生效——配置变更后重新注册即可）。 */
export function registerDeviceProvider(provider: DeviceProvider): void {
  registry.set(provider.id, provider);
}

/** 注销（主要给受控回归与将来的"断开厂商"用）。 */
export function unregisterDeviceProvider(id: string): void {
  registry.delete(id);
}

/** 按 id 取 Provider；未注册 ⇒ `null`（不伪造一个空实现）。 */
export function getDeviceProvider(id: string): DeviceProvider | null {
  return registry.get(id) ?? null;
}

/** 已注册的 Provider（面板/诊断可列）。 */
export function listDeviceProviders(): DeviceProvider[] {
  return [...registry.values()];
}

/** 同步结果：成功带逐行 `isNew`（供事件层如实标"新发现"），失败带原因（不抛给 IPC 壳）。 */
export interface ProviderSyncRow {
  device: AnsDevice;
  isNew: boolean;
}

export type ProviderSyncResult =
  | { ok: true; added: number; updated: number; rows: ProviderSyncRow[] }
  | { ok: false; error: string };

/**
 * 把 Provider 的设备列表**按既有幂等语义**入账。
 *
 * ⚠ 失败**不抛**：返回 `{ok:false, error}`，由 IPC 如实回给界面（"空态 + 原因"，不假装同步成功）。
 * ⚠ 无身份（`id` 空）的候选项**跳过**——不造行、不猜。
 * ⚠ `now` 可注入（rr 不碰真实墙钟）。
 */
export async function syncProviderDevices(
  db: DeviceDb,
  provider: DeviceProvider,
  now?: string,
): Promise<ProviderSyncResult> {
  let list: ProviderDevice[];
  try {
    list = await provider.listDevices();
  } catch (e) {
    return { ok: false, error: `${provider.label}（${provider.id}）设备列表拉取失败：${(e as Error)?.message || String(e)}` };
  }
  let added = 0;
  let updated = 0;
  const rows: ProviderSyncRow[] = [];
  for (const candidate of list) {
    const id = String(candidate?.id ?? '').trim();
    if (!id) continue;
    const address = cloudAddress(provider.id, id);
    const existed = findDeviceByIdentity(db, 'cloud', address) != null;
    const dev: DiscoveredDevice = {
      name: String(candidate.name ?? '').trim() || id,
      kind: String(candidate.kind ?? '').trim() || 'unknown',
      ...(candidate.kindClass ? { kindClass: String(candidate.kindClass) } : {}),
      protocol: 'cloud',
      address,
      port: null,
      capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities : [],
      controllable: candidate.controllable === true,
    };
    const device = upsertDiscovered(db, dev, now);
    // zx_20261030_1 M5：容量到顶 ⇒ 新设备未落库（`null`）——跳过它，不计 added/updated（如实不假装同步成功）。
    if (!device) continue;
    if (existed) updated += 1;
    else added += 1;
    rows.push({ device, isNew: !existed });
  }
  return { ok: true, added, updated, rows };
}

/**
 * `protocol='cloud'` 设备的传动（`defaultDeviceControl` 的唯一 cloud 分支）。
 *
 * ⚠ **未注册 Provider ⇒ 如实拒**，绝不落到 HTTP（否则 `tuya:xxx` 会被当主机名发出去）。
 * ⚠ Provider 抛异常也收成 `{ok:false}`——传动失败是结果，不是崩溃。
 */
export async function controlCloudDevice(
  dev: AnsDevice,
  action: string,
  args: Record<string, unknown>,
): Promise<ProviderControlResult> {
  const providerId = cloudProviderIdOf(dev.address);
  if (!providerId) {
    return {
      ok: false,
      result: `云设备地址「${dev.address}」缺少 Provider 前缀（约定 <provider>:<deviceId>），拒绝下发。`,
    };
  }
  const provider = getDeviceProvider(providerId);
  if (!provider) {
    return {
      ok: false,
      result: `云设备「${dev.name || dev.address}」的 Provider「${providerId}」未注册，拒绝下发（不会退回 HTTP 误发）。`,
    };
  }
  const deviceId = cloudDeviceIdOf(dev.address);
  if (!deviceId) {
    return { ok: false, result: `云设备地址「${dev.address}」缺少设备 id，拒绝下发。` };
  }
  try {
    return await provider.control(deviceId, action, args);
  } catch (e) {
    return { ok: false, result: `${provider.label}调用失败：${(e as Error)?.message || String(e)}` };
  }
}

/**
 * `protocol='cloud'` 设备的**状态查询**（zx_20261018_1 批四）——`device_status` 的唯一取数口。
 * ⚠ Provider 未注册 / 未实现 `getState` ⇒ 如实回原因或 `unsupported`，**绝不**返回伪造状态。
 */
export async function cloudDeviceState(dev: AnsDevice): Promise<ProviderStateResult> {
  const providerId = cloudProviderIdOf(dev.address);
  if (!providerId) {
    return { ok: false, error: `云设备地址「${dev.address}」缺少 Provider 前缀（约定 <provider>:<deviceId>），无法查询状态。` };
  }
  const provider = getDeviceProvider(providerId);
  if (!provider) {
    return { ok: false, error: `云设备「${dev.name || dev.address}」的 Provider「${providerId}」未注册，无法查询状态。` };
  }
  if (!provider.getState) {
    return { ok: false, unsupported: true, error: `${provider.label}（${providerId}）未提供状态查询（unsupported）` };
  }
  const deviceId = cloudDeviceIdOf(dev.address);
  if (!deviceId) {
    return { ok: false, error: `云设备地址「${dev.address}」缺少设备 id，无法查询状态。` };
  }
  try {
    return await provider.getState(deviceId);
  } catch (e) {
    return { ok: false, error: `${provider.label}查询失败：${(e as Error)?.message || String(e)}` };
  }
}
