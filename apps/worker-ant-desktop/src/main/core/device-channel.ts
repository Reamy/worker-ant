/**
 * zx_20261023_5 批三（维特根斯坦·意义即用法 / 管子·度量衡）: **设备渠道注册表**。
 *
 * 病（B8）：加一个品牌要改 UI、IPC、传输三层——"接一台设备"的**门槛知识**散落在页面里。
 * 本模块把"怎么接"收成一个可列、可查、可授权的**渠道**：
 *
 *   · `kind` 说的是**接入形态**：`lan`（同网段自动发现）/ `gateway`（填一次网关）/ `cloud`（厂商云）。
 *   · `requires` 说的是**还缺什么**：`none` / `address` / `credentials` / `token`——向导据此决定下一步问什么。
 *   · `requiredFeatures` 说的是**归哪档**：非空即按每项能力各自归口过闸（Pro 能力看 `pro-gate.ts`，
 *     Team 能力看 `team-gate.ts`——两处真源，不在本文件另写档位判断）。
 *
 * ⚠ zx_20261029_2 M6「阶梯」：`device_discovery` 归**专业版**（发现/只读台账），`device_control` 归**团队版**。
 *   故内置渠道只登记 `['device_discovery']`——**能用这个渠道接进来**是 Pro 的事；
 *   **接进来之后能不能动**由控制出口逐动作再判 `device_control`（Team），渠道级不重复圈走控制权。
 *
 * ⚠ 本模块**只描述、不执行**：真正的发现/控制仍在 `device-discovery.ts` / `tools/device.ts` 的既有选路里。
 *   旧接口（`DeviceProvider` 注册表）原样保留——渠道是"目录"，Provider 是"传动"，两者不是替代关系。
 * ⚠ 零 electron 依赖，rr 可直跑真判据。
 */
import type { DeviceProtocol } from './device-registry.js';
import type { CloudAccountProvider } from './device-cloud-accounts.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL, type ProFeature } from './pro-gate.js';
import { TEAM_FEATURES, TEAM_FEATURE_LABEL, type TeamFeature } from './team-gate.js';

/** 渠道可要求的能力：两侧词表并集（一个渠道可以同时要 Pro 的"接入"与 Team 的"控制"）。 */
export type DeviceFeature = ProFeature | TeamFeature;

/** 渠道级档位判据的入参（两档各一把尺；`tierLabel` 只用于把拒因说清楚）。 */
export interface ChannelGateInput {
  proUnlocked: boolean;
  teamUnlocked: boolean;
  /** 当前档位人话名；省略时拒因不写"当前为…"这一截。 */
  tierLabel?: string;
}

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
  /** 该渠道需要的能力（Pro/Team 各自归口）；空数组 = 免费可用。 */
  requiredFeatures: DeviceFeature[];
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
  /**
   * zx_20261107_1 B2：该渠道的凭据存放在**设备云账号表**（一账号一 Provider），
   * 而不是固定 settings 键。预检据此把"账号行已配置"也算作已就绪——
   * 否则用户在「设备云账号」里配好了，向导仍说"缺凭据"（说了点不到）。
   */
  accountProvider?: CloudAccountProvider;
  capabilities: ChannelCapabilities;
}

/**
 * 内置六渠道（**注册表的全部初始内容**）。
 * zx_20261107_1 B2：补 `homeassistant-rest`——HA 有两条真实接入路（MQTT 发现 / REST 账号），
 *   目录须如实列两条，不能只列其一让用户以为 REST 账号不可达。
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
    requiredFeatures: ['device_discovery'],
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
    requiredFeatures: ['device_discovery'],
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
    requiredFeatures: ['device_discovery'],
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
    requiredFeatures: ['device_discovery'],
    summary: '填 Access ID / Secret 授权后同步云端设备清单；控制经厂商云下发。',
    settingsKeys: ['device.tuya.region', 'device.tuya.access_id', 'device.tuya.access_secret'],
    credentialKeys: ['device.tuya.access_secret'],
    configKeys: ['device.tuya.access_id', 'device.tuya.access_secret'],
    accountProvider: 'tuya',
    capabilities: { discover: true, control: true, state: true },
  },
  {
    id: 'homeassistant-rest',
    label: 'Home Assistant（REST）',
    kind: 'cloud',
    requires: 'credentials',
    protocols: ['cloud'],
    requiredFeatures: ['device_discovery'],
    summary: '填你自己的 HA 地址与长期令牌；经 HA REST 同步可控实体，控制走服务调用（不经 MQTT）。',
    settingsKeys: [],
    credentialKeys: [],
    configKeys: [],
    accountProvider: 'homeassistant',
    capabilities: { discover: true, control: true, state: true },
  },
  {
    id: 'mijia-miio',
    label: '米家（miIO 局域网）',
    kind: 'lan',
    requires: 'token',
    protocols: ['miio'],
    requiredFeatures: ['device_discovery'],
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

/** 某项能力属于哪一侧词表（决定读哪把闸、拒因说"专业版"还是"团队版"）。 */
function isProFeature(feature: DeviceFeature): boolean {
  return (PRO_FEATURES as readonly string[]).includes(feature);
}

/** 能力项的人话名（两侧词表各取各的；都不认识就如实回键名）。 */
function featureLabel(feature: DeviceFeature): string {
  return (isProFeature(feature) ? (PRO_FEATURE_LABEL as Record<string, string>)[feature] : (TEAM_FEATURE_LABEL as Record<string, string>)[feature]) ?? feature;
}

/** 该项能力在入参下是否已解锁。 */
function featureUnlocked(feature: DeviceFeature, input: ChannelGateInput): boolean {
  return isProFeature(feature) ? input.proUnlocked === true : input.teamUnlocked === true;
}

/**
 * 渠道是否**对当前档位开放**：逐项能力**各读各的闸**（Pro 能力看 `proUnlocked`，Team 能力看 `teamUnlocked`）。
 * `requiredFeatures` 为空 ⇒ 恒开放。
 */
export function channelUnlocked(channel: DeviceChannel, input: ChannelGateInput): boolean {
  return channel.requiredFeatures.length === 0 || channel.requiredFeatures.every((f) => featureUnlocked(f, input));
}

/**
 * 向导可选渠道：**未解锁的渠道不出现在列表里**（不是灰着——是不出现，免得用户选了才发现被拒；
 * 锁定态由页面顶部的升级卡统一说明）。
 */
export function listOnboardingChannels(input: ChannelGateInput): DeviceChannel[] {
  return listChannels().filter((c) => channelUnlocked(c, input));
}

/**
 * 设置键 ⇒ 归属渠道（zx_20261104_3 M5「联」）。未归属任何渠道 ⇒ `null`（不猜、不影响其它设置）。
 * 一个键若被多个渠道登记，按注册顺序取首个（与 `channelForProtocol` 同一口径）。
 */
export function channelSettingOwner(key: string): DeviceChannel | null {
  const k = String(key ?? '');
  if (!k) return null;
  for (const channel of channels.values()) {
    if (channel.settingsKeys.includes(k)) return channel;
  }
  return null;
}

/** 设置键所属渠道要的是哪一档（静态判定，不看当前许可证）：`null` = 无归属或免费渠道。 */
export function channelSettingTier(key: string): 'pro' | 'team' | null {
  const channel = channelSettingOwner(key);
  if (!channel || channel.requiredFeatures.length === 0) return null;
  return channel.requiredFeatures.some((f) => !isProFeature(f)) ? 'team' : 'pro';
}

/**
 * 写渠道配置前的闸（zx_20261104_3 M5）：**没升级就别存一份假配置**。
 * - 值 trim 后为空 ⇒ `null`：清空/清理永远允许（历史残留必须清得掉）；
 * - 键不属任何渠道 ⇒ `null`：不拦其它设置；
 * - 渠道已解锁 ⇒ `null`；
 * - 未解锁 ⇒ 如实拒因（说清是哪档的哪项能力，并明确"清空不受影响"）。
 *
 * ⚠ 纯函数、零 electron 依赖：IPC 与 rr 同引这一份，不另写判据。
 */
export function channelSettingRefusal(
  key: string,
  input: ChannelGateInput,
  value: string | null | undefined,
): string | null {
  if (String(value ?? '').trim() === '') return null;
  const channel = channelSettingOwner(key);
  if (!channel) return null;
  if (channelUnlocked(channel, input)) return null;
  const locked = channel.requiredFeatures.filter((f) => !featureUnlocked(f, input));
  if (locked.length === 0) return null;
  const need = locked.some((f) => !isProFeature(f)) ? '团队版' : '专业版';
  const names = locked.map(featureLabel).join(' / ');
  const now = input.tierLabel ? `（当前为${input.tierLabel}）` : '';
  return `「${channel.label}」的配置需要${need}能力（${names}）${now}，未升级前不保存。清空不受影响；升级到${need}即可启用。`;
}

/** 渠道预检入参：除档位外，只问"该渠道还缺什么"是否已具备。 */
export interface ChannelAuthorizeInput extends ChannelGateInput {
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
    const locked = channel.requiredFeatures.filter((f) => !featureUnlocked(f, input));
    const need = isProFeature(locked[0]!) ? '专业版' : '团队版';
    const names = locked.map(featureLabel).join(' / ');
    const now = input.tierLabel ? `（当前为${input.tierLabel}）` : '';
    return { ok: false, reason: `「${channel.label}」需要${need}能力（${names}）${now}。升级到${need}即可启用。` };
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
