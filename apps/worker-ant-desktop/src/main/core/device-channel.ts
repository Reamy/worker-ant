/**
 * zx_20261023_5 批三（维特根斯坦·意义即用法 / 管子·度量衡）: **设备渠道注册表**。
 *
 * 病（B8）：加一个品牌要改 UI、IPC、传输三层——"接一台设备"的**门槛知识**散落在页面里。
 * 本模块把"怎么接"收成一个可列、可查、可授权的**渠道**：
 *
 *   · `kind` 说的是**接入形态**：`lan`（同网段自动发现）/ `gateway`（填一次网关）/ `cloud`（厂商云）。
 *   · `requires` 说的是**还缺什么**：`none` / `address` / `credentials` / `token`——向导据此决定下一步问什么。
 *   · `teamFeatures` 说的是**归哪档**：非空即受 Team 软闸（`team-gate.ts` 一处真源）。
 *
 * ⚠ 本模块**只描述、不执行**：真正的发现/控制仍在 `device-discovery.ts` / `tools/device.ts` 的既有选路里。
 *   旧接口（`DeviceProvider` 注册表）原样保留——渠道是"目录"，Provider 是"传动"，两者不是替代关系。
 * ⚠ 零 electron 依赖，rr 可直跑真判据。
 */
import type { DeviceProtocol } from './device-registry.js';
import type { TeamFeature } from './team-gate.js';

/** 接入形态：局域网自动发现 / 网关（填一次地址凭据）/ 厂商云。 */
export type DeviceChannelKind = 'lan' | 'gateway' | 'cloud';

/** 选择该渠道后**还缺什么**（向导按此决定下一屏）。 */
export type DeviceChannelRequires = 'none' | 'address' | 'credentials' | 'token';

/** 一个渠道的能力面（只描述"能做什么"，不承诺"此刻做得到"）。 */
export interface ChannelCapabilities {
  discover: boolean;
  control: boolean;
  state: boolean;
}

export interface DeviceChannel {
  /** 稳定 id（IPC/向导用它寻址；改它 = 换契约）。 */
  id: string;
  label: string;
  kind: DeviceChannelKind;
  requires: DeviceChannelRequires;
  /** 本渠道产出的台账协议（**用途是设备行归属**；`[]` = 不产出新协议）。 */
  protocols: DeviceProtocol[];
  /** 该渠道需要的 Team 能力；空数组 = 免费可用。 */
  teamFeatures: TeamFeature[];
  /** 一句人话（向导卡片上屏）。 */
  summary: string;
  /** 本渠道用到的设置键（向导/诊断列"还需配置什么"；不含每设备各自的键）。 */
  settingsKeys: string[];
  /** 其中**属于密钥**的键：写口须走 `writeSecret` 加密落库（`device-secrets.ts`）。 */
  credentialKeys: string[];
  /**
   * 判定"已配置"须**非空**的设置键（`[]` = 无前置配置；每设备凭据**不计入**——
   * 那是设备行的第二步，不是渠道层的前置条件）。
   */
  configKeys: string[];
  capabilities: ChannelCapabilities;
}

/**
 * 内置五渠道（**注册表的全部初始内容**）。
 *
 * ⚠ HA 与 MQTT 共用传输：HA 设备入账即 `protocol='mqtt'`，故 `protocols` 也写 `mqtt`
 *   （**用途是设备行归属**）。`channelForProtocol` 按注册顺序取首个命中——`mqtt` 在前，
 *   两者不会争"这个协议归谁"的解释权；HA 只是"同一条传输的另一种发现语言"。
 */
const BUILTIN_CHANNELS: DeviceChannel[] = [
  {
    id: 'lan',
    label: '局域网（自动发现）',
    kind: 'lan',
    requires: 'none',
    protocols: ['mdns', 'ssdp', 'http'],
    teamFeatures: ['device_discovery', 'device_control'],
    summary: '同一网段里的设备会自动出现，无需填任何东西；授权后可直接控制。',
    settingsKeys: [],
    credentialKeys: [],
    configKeys: [],
    capabilities: { discover: true, control: true, state: false },
  },
  {
    id: 'mqtt',
    label: 'MQTT 网关',
    kind: 'gateway',
    requires: 'credentials',
    protocols: ['mqtt'],
    teamFeatures: ['device_discovery', 'device_control'],
    summary: '填一次 broker 地址与账号；订阅到的设备按发现主题自动入账。',
    settingsKeys: [
      'device.mqtt.enabled',
      'device.mqtt.broker',
      'device.mqtt.discovery_topic',
      'device.mqtt.username',
      'device.mqtt.password',
      'device.mqtt.tls',
    ],
    credentialKeys: ['device.mqtt.password'],
    configKeys: ['device.mqtt.broker'],
    capabilities: { discover: true, control: true, state: true },
  },
  {
    id: 'homeassistant',
    label: 'Home Assistant',
    kind: 'gateway',
    requires: 'credentials',
    protocols: ['mqtt'],
    teamFeatures: ['device_discovery', 'device_control'],
    summary: '复用同一条 MQTT 连接，按 HA 发现前缀识别设备（不另配地址）。',
    settingsKeys: ['device.ha.enabled', 'device.ha.prefix'],
    credentialKeys: [],
    configKeys: ['device.mqtt.broker'],
    capabilities: { discover: true, control: true, state: true },
  },
  {
    id: 'tuya-cloud',
    label: '涂鸦云',
    kind: 'cloud',
    requires: 'credentials',
    protocols: ['cloud'],
    teamFeatures: ['device_discovery', 'device_control'],
    summary: '填 Access ID / Secret 授权后同步云端设备清单；控制经厂商云下发。',
    settingsKeys: ['device.tuya.region', 'device.tuya.access_id', 'device.tuya.access_secret'],
    credentialKeys: ['device.tuya.access_secret'],
    configKeys: ['device.tuya.access_id', 'device.tuya.access_secret'],
    capabilities: { discover: true, control: true, state: true },
  },
  {
    id: 'mijia-miio',
    label: '米家（miIO 局域网）',
    kind: 'lan',
    requires: 'token',
    protocols: ['miio'],
    teamFeatures: ['device_discovery', 'device_control'],
    summary: '发现局域网里的米家设备；每台设备需手动填入 32 位 token 才能控制（token 加密落库）。',
    settingsKeys: [],
    credentialKeys: [],
    configKeys: [],
    capabilities: { discover: true, control: true, state: true },
  },
];

const channels = new Map<string, DeviceChannel>(BUILTIN_CHANNELS.map((c) => [c.id, c]));

/** 注册/替换一个渠道（同 id 后注册者生效；厂商可在此基础上扩展，不必改本文件）。 */
export function registerChannel(channel: DeviceChannel): void {
  channels.set(channel.id, channel);
}

/** 注销（受控回归与"停用某渠道"用；内置渠道重启进程即恢复）。 */
export function unregisterChannel(id: string): void {
  channels.delete(id);
}

/** 按 id 取渠道；未注册 ⇒ `null`（不伪造）。 */
export function getChannel(id: string): DeviceChannel | null {
  return channels.get(String(id ?? '')) ?? null;
}

/** 已注册渠道（注册顺序；面板/诊断可列）。 */
export function listChannels(): DeviceChannel[] {
  return [...channels.values()];
}

/** 按 id 取渠道并给**如实拒因**（IPC 第一跳用，免得各处各写一句）。 */
export type ChannelResolution = { ok: true; channel: DeviceChannel } | { ok: false; reason: string };

export function resolveChannel(id: string): ChannelResolution {
  const channel = getChannel(id);
  if (!channel) return { ok: false, reason: `未注册的设备渠道「${String(id ?? '')}」。` };
  return { ok: true, channel };
}

/**
 * 台账协议 ⇒ 渠道（向导据此预选渠道）。
 * 一个协议**至多**归属一个渠道；无人认领 ⇒ `null`（如实不猜）。
 */
export function channelForProtocol(protocol: DeviceProtocol): DeviceChannel | null {
  for (const channel of channels.values()) {
    if (channel.protocols.includes(protocol)) return channel;
  }
  return null;
}

/**
 * 渠道是否**对当前档位开放**（Team 软闸）。
 * `teamFeatures` 为空 ⇒ 恒开放；否则须 `teamUnlocked`。
 */
export function channelUnlocked(channel: DeviceChannel, input: { teamUnlocked: boolean }): boolean {
  return channel.teamFeatures.length === 0 || input.teamUnlocked === true;
}

/**
 * 向导可选渠道：**未解锁的渠道不出现在列表里**（不是灰着——是不出现，免得用户选了才发现被拒；
 * 锁定态由页面顶部的升级卡统一说明）。
 */
export function listOnboardingChannels(input: { teamUnlocked: boolean }): DeviceChannel[] {
  return listChannels().filter((c) => channelUnlocked(c, input));
}

/** 渠道预检入参：除档位外，只问"该渠道还缺什么"是否已具备。 */
export interface ChannelAuthorizeInput {
  teamUnlocked: boolean;
  hasAddress?: boolean;
  hasCredentials?: boolean;
  hasToken?: boolean;
}

/** 预检结论：`ok:false` 的 `reason` 直接上屏（说清缺哪一样，不写"操作失败"）。 */
export type ChannelAuthorize = { ok: true } | { ok: false; reason: string };

/**
 * 渠道预检（**接入选渠道时**的第一跳）：档位 → 地址 → 凭据 → token，按 `requires` 逐项问。
 *
 * ⚠ 这是**渠道级**预检，不是设备级授权：设备能不能被控仍只看 `deviceControlVerdict`（K-6 一处真源）。
 */
export function authorizeChannel(channel: DeviceChannel, input: ChannelAuthorizeInput): ChannelAuthorize {
  if (!channelUnlocked(channel, input)) {
    return {
      ok: false,
      reason: `「${channel.label}」属于团队版能力（当前档位未解锁设备发现/控制）。升级到团队版即可启用。`,
    };
  }
  if (channel.requires === 'address' && input.hasAddress !== true) {
    return { ok: false, reason: `「${channel.label}」还需要先填写网关地址。` };
  }
  if (channel.requires === 'credentials' && input.hasCredentials !== true) {
    return { ok: false, reason: `「${channel.label}」还需要先填写连接凭据（地址/账号/密钥）。` };
  }
  if (channel.requires === 'token' && input.hasToken !== true) {
    return { ok: false, reason: `「${channel.label}」还需要先填写设备 token。` };
  }
  return { ok: true };
}
