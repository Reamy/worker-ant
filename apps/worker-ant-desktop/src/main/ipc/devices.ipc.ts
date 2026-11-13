/**
 * zx_20261004 M9/M10（王阳明·知行合一 / 康德·自由以他人自由为界）: 设备面板的 IPC。
 *
 * 六个出口，各自**只做一件事**：
 *   - `devices:list`      —— 台账 + 最近审计 + 是否正在发现（面板首屏一屏读全）。
 *   - `devices:discover`  —— **起**发现（mDNS + SSDP，用户显式动作）。
 *   - `devices:stop`      —— 停发现（与起成对；面板按钮据此翻"发现中/已停"）。
 *   - `devices:authorize` —— 逐设备"允许控制"开关（M9 的唯一写点，写 `wa_devices.authorized`）。
 *   - `devices:rename`    —— 逐设备**改名**（zx_20261014_1 批二；写 `wa_devices.alias`，
 *                            发现不覆写）。**不经** Team 档闸（本地元数据，非动作）。
 *   - `devices:set_room`  —— 逐设备**指派房间**（zx_20261018_1 批三；写 `wa_devices.room`，
 *                            发现提示只填空、不覆写）。同不经 Team 闸（本地元数据）。
 *   - `devices:control`   —— 面板**手动**控制。⚠ 与工具体 `device_control` **共用同一编排**
 *                            `runDeviceControl`（闸→传动→审计→状态→事件），不另写一份——
 *                            "判据一处、编排两处"是同一类漂移（罗尔斯·同一把尺）。
 *   - `devices:intent_preview` / `devices:intent_execute`（zx_20261018_1 批五）——
 *     意图演练两跳：预览**零设备动作**只落计划（owner `'panel'`）；执行**认领那份固定计划**
 *     （Team `device_control` 闸；认主 `terminal_id==='panel'`），不重规划（R-45：预览后被取消
 *     授权的设备仍会走到 K-6 并留 `denied` 审计行，而不是被悄悄滤掉）。
 *   - `devices:cloud_status` / `devices:tuya_config` / `devices:cloud_sync`（zx_20261017_1 批八）——
 *     三方云（涂鸦试点）：只读配置态（**不触网**）/ 凭据读写（Secret 只回显"是否已配"）/
 *     拉取设备入台账（Team `device_discovery` 闸；入账走既有幂等 upsert）。
 *   - `devices:channels` / `devices:channel_auth` / `devices:miio_token`（zx_20261023_5 批三）——
 *     渠道目录（**锁定的渠道不列举**）/ 渠道预检（"还缺什么"）/ 米家 token 读写（**token 永不回包**）。
 *
 * ⚠ **发现不自动跑**：起发现是**用户显式动作**（面板按钮），不在开机时静默扫局域网
 *   ——扫描网内他机是**可被察觉的网络行为**，须由人发起（康德·自由以他人自由为界）。
 * ⚠ 发现的实时接线（`onDiscovered` → `device.discovered` 事件）落在此处：`startDeviceDiscovery`
 *   的 `onDiscovered` 回调是唯一入口，起一次发现即接一次线。
 * ⚠ 真网络只在用户点了"开始发现"时经 `device-discovery.ts` 的惰性 `import` 触达；本文件不直接触网。
 *
 * zx_20261005 M22（Team 档软闸）: **设备发现 / 设备控制**属 Team 档能力——
 *   三个**动作**出口（`devices:discover` / `devices:authorize` / `devices:control`）各经**同一判据**
 *   （`core/team-gate.ts`），锁定即如实回 `TEAM_REQUIRED`（不触发现/不写授权/不下发命令）；
 *   `devices:list`（只读台账）**照常**回，另带 `gate` 供面板显示升级提示。
 *
 * zx_20261029_2 M6「阶梯」: **发现/渠道接入归 Pro**（`core/pro-gate.ts` 的 `device_discovery`），
 *   **控制归 Team**（`device_control`）——两档各读各的闸，不并成一句"设备能力"：
 *   · `devices:discover` / `devices:cloud_sync` / `devices:channels` / `devices:channel_auth` ⇒ Pro 闸，
 *     锁定如实回 `PRO_REQUIRED`；`cloud_sync` 的闸**先于**任何配置读取/网络调用。
 *   · `devices:authorize` / `devices:control` / `devices:intent_execute` / `devices:miio_token` 写口 ⇒ Team 闸。
 *   · `devices:list` 照常回，**另带 `discoveryGate`（Pro）与 `gate`（Team）**——面板分别显示"看不了/动不了"。
 *   · `devices:intent_preview` 仍**不挂闸**（这是"看"，排好的步骤先给人看）。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  applyAvailability as applyDeviceAvailability,
  findDeviceByIdentity,
  deviceShadow,
  getDevice,
  getDeviceCapacityRefusals,
  listDeviceActions,
  listDevices,
  setDeviceAlias,
  setDeviceAuthorized,
  setDeviceLiveAttributes,
  setDeviceLiveState,
  setDeviceRoom,
  taskRefsOf,
  upsertDiscovered,
  type AnsDevice,
  type DeviceActionRow,
  type DeviceDb,
  type DeviceShadow,
  type TaskRef,
} from '../core/device-registry.js';
import { kindClassOf } from '../core/device-kind.js';
import {
  composeDiscoveryIo,
  defaultDiscoveryIo,
  isDiscoveryRunning,
  startDeviceDiscovery,
  stopDeviceDiscovery,
  type DiscoveryIo,
} from '../core/device-discovery.js';
import { defaultDeviceControl, executeDeviceIntentPlan, lanAddressRefusal, runDeviceControl } from '../core/tools/device.js';
// zx_20261018_1 批五: 意图演练两跳——规则表/词表/计划账各取各自真源（本文件只接线）。
// zx_20261029_2 M2：预览与门外/工具走**同一条**解析链（规则 → 模型兜底 → 再校验）。
// zx_20261104_3 M4：解析链入口升为 `resolveHomeIntent`——`home.comfort` 可走模型，`home.away` 只走规则。
import { resolveHomeIntent } from '../core/home-intent.js';
import { runComfortModelPlan, type IntentModelClient } from '../core/intent-model-plan.js';
import { readBoolSetting } from '../core/settings-bool.js';
import { createIntentPlan, intentPlanSourceLabel, getIntentPlan } from '../core/intent-plans.js';
import {
  HOME_COMFORT_INTENT,
  INTENT_CAPABILITY,
  validateIntent,
} from '../core/intent-protocol.js';
// zx_20261017_1 批八: 三方云（涂鸦）Provider——启动时注册，同步/控制时现读配置。
import {
  cloudDeviceState,
  cloudProviderIdOf,
  getDeviceProvider,
  registerDeviceProvider,
  syncProviderDevices,
  unregisterDeviceProvider,
} from '../core/device-provider.js';
// zx_20261101_2 M1「接」: 设备云账号（一组账号，而非单个涂鸦账号）与 Home Assistant REST。
import {
  LEGACY_TUYA_ACCOUNT_ID,
  accountConfigProblem,
  baseProviderOf,
  cloudAccountCapacityVerdict,
  createCloudAccount,
  deleteCloudAccount,
  ensureLegacyTuyaAccount,
  getCloudAccount,
  isCloudAccountProvider,
  listCloudAccounts,
  markCloudAccountSync,
  secretKindOf,
  secretKeyFor,
  updateCloudAccount,
  type CloudAccount,
} from '../core/device-cloud-accounts.js';
import { probeHaRest, registerHaAccountProvider, type HaRestConfig } from '../core/providers/homeassistant-rest.js';
// zx_20261027_3 M1b: 设备状态直查（只对无实时订阅的 cloud/miIO 协议）——选路/写回补丁是纯函数。
import { livePatchFromProviderState, selectStateRefreshTargets } from '../core/device-state-refresh.js';
import {
  createTuyaAccountProvider,
  registerTuyaCloudProvider,
  resolveTuyaConfig,
  tuyaConfigStatus,
  TUYA_PROVIDER_ID,
  TUYA_REGIONS,
  TUYA_SETTING_ACCESS_ID,
  TUYA_SETTING_ACCESS_SECRET,
  TUYA_SETTING_REGION,
  type TuyaConfig,
  type TuyaRegion,
} from '../core/providers/tuya-cloud.js';
import {
  createLiveSubscriptionManager,
  mqttClientAvailable,
  mqttDiscoveryIo,
  mqttStatusPayload,
  probeMqttBroker,
  resolveMqttConfig,
  setMqttSettingsProvider,
  type LiveSubscriptionManager,
  type MqttConfig,
  type MqttStatusPayload,
} from '../core/device-mqtt.js';
import { haDiscoveryIo, resolveHaConfig } from '../core/device-homeassistant.js';
// zx_20261023_5 批三: 渠道目录（向导第一步）与 miIO 渠道（发现/控制/每设备 token）。
import { authorizeChannel, listOnboardingChannels, resolveChannel } from '../core/device-channel.js';
import {
  currentMiioToken,
  mijiaMiioDiscoveryIo,
  miioDeviceModel,
  miioDeviceState,
  miioTokenSettingKey,
  normalizeMiioToken,
  setMiioTokenProvider,
} from '../core/providers/mijia-miio.js';
// zx_20261023_5 批三: 凭据**盘上加密、读时透明**——settings 读写口经此处，不各写一份加解密。
import { clearSecret, readSecret, secretState, writeSecret } from '../core/device-secrets.js';
import { isSecretSettingKey } from '../core/secret-settings.js';
// zx_20261022_3 批三: 诊断的两个真源——HTTP 探活（零依赖、可注入）与涂鸦探活（凭据只在 main 内存）。
import { probeHttpEndpoint } from '../core/device-diagnostics.js';
import { probeTuya } from '../core/providers/tuya-cloud.js';
// zx_20261016_2 批三: 留痕要认得出来"是哪台外部终端按的"——读时现查终端名（与 `taskRefsOf` 同一把尺）。
import { terminalNamesOf, type TerminalDb } from '../core/external-terminals.js';
import { eventBus } from '../core/event-bus.js';
import { resolveTeamGate, teamFeatureRefusal, type TeamGate } from '../core/team-gate.js';
// zx_20261029_2 M6: 发现/渠道接入归 Pro（`device_discovery`）；控制仍归 Team——两档各读各的闸。
import { resolveProGate, proFeatureRefusal, type ProGate } from '../core/pro-gate.js';
import { refusalWithContext } from '../core/tier-usage.js';
import { resolveLicenseTier, type LicenseSettingDb } from '../core/license.js';
// zx_20261030_1 M5「限」：设备登记容量的**读数**（上限由 `TIER_LIMITS[tier].maxDevices` 派生，0=不限）。
import { capacityLimit, countCloudAccounts, countDevices, type CapacityDb } from '../core/tier-capacity.js';
// zx_20261112_2 B3：GUI 授权与 IM 授权台同一把尺——都留审计。
import { recordAudit } from '../core/audit-log.js';

/** 首屏一屏读全：台账 + 最近审计 + 发现是否在跑。 */
/** zx_20261101_2 M2：台账行 + 影子投影（期望/实况/相符判定），面板一处读全。 */
export type DeviceWithShadow = AnsDevice & { shadow: DeviceShadow };

export interface DevicesListPayload {
  devices: DeviceWithShadow[];
  actions: DeviceActionRow[];
  /**
   * zx_20261014_3 批一: 留痕行的「任务引用」——`task_id` ⇒ 标题 + 所属项目名（**读时现查**，非快照）。
   *   map 而非逐行字段：同一任务的多条留痕只查一次；**查无的 id 不在 map 里**（面板据此如实回退 id 前缀）。
   */
  taskRefs: Record<string, TaskRef>;
  /**
   * zx_20261016_2 批三: 留痕行的「外部终端引用」——`actor_ref` ⇒ 终端名（**读时现查**，同 `taskRefs`）。
   *   只有 `actor_kind==='external'` 的行才进来；**查无的终端不在 map 里**（面板据此如实回退 id 前缀）。
   */
  terminalRefs: Record<string, string>;
  discoveryRunning: boolean;
  /** zx_20261005 M22: Team 档软闸（**控制**）——面板据此禁用授权/控制/意图执行。 */
  gate: TeamGate;
  /** zx_20261029_2 M6: Pro 档软闸（**发现/渠道接入**）——面板据此禁用"开始发现"与渠道向导。 */
  discoveryGate: ProGate;
  /**
   * zx_20261030_1 M5「限」：设备登记容量（`limit === 0` ⇒ 不限）。
   * 只拦**新登记**：已有台账行不受影响（面板据此解释"为什么新发现的没进来"）。
   */
  capacity?: { used: number; limit: number };
  /** 本进程内因容量上限被挡下的首次发现数（不是史实；重启归零，`lastAt` 为 UTC 时刻）。 */
  capacityRefusals?: { count: number; lastAt: string | null };
}

/**
 * 实时状态订阅的**当前那一份**（zx_20261018_1 批四）。
 * 模块级而非 `initDevicesIpc` 内局部：退出收尾（`main/index.ts` 的 `stopCore`）也够得着——
 * 与发现同生命周期（起发现时重建，停发现/退出时归零）。
 */
let liveSub: LiveSubscriptionManager | null = null;

/** 停掉实时状态订阅（幂等；退出与 `devices:stop` 共用）。 */
export function stopDeviceLiveSubscriptions(): void {
  try { liveSub?.stop(); } catch { /* 收摊噪声 */ }
  liveSub = null;
}

/**
 * 模型兜底的取模型口（zx_20261029_2 M2）——装配层注入；未给 ⇒ 预览只走规则（如实不 pretend）。
 * 与门外门/任务工具共用 `runComfortModelPlan`，三处同一份模型调用与校验。
 */
export type DevicesAnsClientGetter = () => Promise<IntentModelClient>;

export function initDevicesIpc(db: Database.Database, getAnsClient?: DevicesAnsClientGetter): void {
  const ddb = db as unknown as DeviceDb;
  const licDb = db as unknown as LicenseSettingDb;
  const tdb = db as unknown as TerminalDb;

  /** 读一条 setting（取数这一半；**判据/解析**在 `device-mqtt.resolveMqttConfig`——纯函数，rr 直跑真实现）。 */
  const settingsGet = (key: string): string | null => {
    try {
      // zx_20261023_5 批三: 密钥键**读时解密**（旧明文在此顺手迁移）——调用方拿到的仍是明文。
      if (isSecretSettingKey(key)) {
        const r = readSecret(ddb, key);
        if (!r.ok) {
          console.warn(`[devices] ${r.reason}`);
          return null;
        }
        if (r.warning) console.warn(`[devices] ${r.warning}`);
        return r.value === '' ? null : r.value;
      }
      const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  };
  const settingsSet = (key: string, value: string): void => {
    // zx_20261023_5 批三: 密钥键只写密文；后端不可用即抛（由各 handler 收成如实回包）。
    if (isSecretSettingKey(key)) {
      const w = writeSecret(ddb, key, value);
      if (!w.ok) throw new Error(w.error);
      return;
    }
    db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
  };
  const mqttConfig = (): MqttConfig => resolveMqttConfig(settingsGet);

  // ===== zx_20261101_2 M1「接」: 设备云账号的接线（凭据只在 main 内存，Provider 一账号一实例） =====
  /** 账号凭据（经 `settingsGet` 解密；读不到/解不开 ⇒ null，**不猜**）。 */
  const accountSecret = (account: CloudAccount): string | null => {
    const value = settingsGet(secretKeyFor(account.id, secretKindOf(account.provider)));
    return value && value.trim() ? value.trim() : null;
  };

  const tuyaConfigOf = (account: CloudAccount): TuyaConfig | null => {
    const accessId = String(account.config.access_id ?? '').trim();
    const accessSecret = accountSecret(account);
    if (!accessId || !accessSecret) return null;
    const rawRegion = String(account.config.region ?? '').trim();
    const region = (TUYA_REGIONS as readonly string[]).includes(rawRegion) ? (rawRegion as TuyaRegion) : 'cn';
    return { region, accessId, accessSecret };
  };

  const haConfigOf = (account: CloudAccount): HaRestConfig | null => {
    const baseUrl = String(account.config.base_url ?? '').trim();
    const token = accountSecret(account);
    if (!baseUrl || !token) return null;
    return { baseUrl, token };
  };

  /** 注册/换绑一个账号的 Provider；停用即注销（遗留地址会走到"Provider 未注册"的如实拒，不误发别家云）。 */
  const syncAccountProvider = (account: CloudAccount): void => {
    if (!account.enabled) {
      unregisterDeviceProvider(account.providerId);
      return;
    }
    if (account.provider === 'tuya') {
      const label = `涂鸦云 · ${account.label}`;
      registerDeviceProvider(createTuyaAccountProvider(account.providerId, label, () => tuyaConfigOf(account)));
    } else {
      const label = `Home Assistant · ${account.label}`;
      registerHaAccountProvider(account.providerId, label, () => haConfigOf(account));
    }
  };

  /** 该 Provider 名下的设备数（地址前缀 `<providerId>:`——与 `cloudAddress` 同一拼法）。 */
  const deviceCountOfProvider = (providerId: string): number => {
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS c FROM wa_devices WHERE protocol = 'cloud' AND substr(address, 1, ?) = ?")
        .get(providerId.length + 1, `${providerId}:`) as { c?: number } | undefined;
      return Number(row?.c) || 0;
    } catch {
      return 0;
    }
  };

  /** 回渲染层的账号形状：**永不含凭据**，只说配没配。 */
  const accountView = (account: CloudAccount) => ({
    id: account.id,
    provider: account.provider,
    providerId: account.providerId,
    label: account.label,
    config: account.config,
    enabled: account.enabled,
    lastSyncAt: account.lastSyncAt,
    lastSyncError: account.lastSyncError,
    secretSet: secretState(ddb, secretKeyFor(account.id, secretKindOf(account.provider))).hasValue,
    deviceCount: deviceCountOfProvider(account.providerId),
    registered: getDeviceProvider(account.providerId) != null,
    configProblem: accountConfigProblem(account),
  });

  // zx_20261101_2 M1: 旧涂鸦三键**首次调用迁成一行**（幂等；旧键不删）。迁不动就走旧 Provider，不阻断启动。
  const legacyMigration = ensureLegacyTuyaAccount(ddb, settingsGet, (d, k, v) => writeSecret(d, k, v));
  if (legacyMigration.warning) console.warn(`[devices] ${legacyMigration.warning}`);
  if (legacyMigration.account) {
    syncAccountProvider(legacyMigration.account);
  } else {
    // zx_20261017_1 批八: 旧涂鸦 Provider（配置在设置里现读）——存量 `tuya:<deviceId>` 地址的兜底。
    registerTuyaCloudProvider(settingsGet);
  }
  for (const account of listCloudAccounts(ddb)) {
    if (account.providerId === TUYA_PROVIDER_ID) continue; // 旧账号已在上面注册
    syncAccountProvider(account);
  }

  // zx_20261022_3 批三: MQTT 凭据的**取数口**交给适配层——控制路（`defaultMqttIo`）没有 settings 句柄，
  //   由此注入后与发现路同一份判据（`resolveMqttAuth`），不各读一遍、不各猜一次。
  setMqttSettingsProvider(settingsGet);

  // zx_20261023_5 批三: miIO 控制的 token 取数口——每设备一 key（`device.miio.token.<address>`），
  //   经 `readSecret` 解密；解不开 ⇒ 如实回 null（控制会如实拒"未配置有效 token"，不伪造成功）。
  setMiioTokenProvider((address) => {
    const r = readSecret(ddb, miioTokenSettingKey(address));
    if (!r.ok) {
      console.warn(`[devices] ${r.reason}`);
      return null;
    }
    return r.value;
  });

  // zx_20261023_5 批三: 渠道目录（向导第一步）。**锁定的渠道不出现**——不是灰着，是不列。
  // zx_20261029_2 M6: 渠道接入归 **Pro**（`device_discovery`）；控制另在动作出口判 Team，不在此圈走。
  ipcMain.handle('devices:channels', async () => {
    try {
      const gate = resolveTeamGate(licDb);
      const discoveryGate = resolveProGate(licDb);
      return {
        data: {
          channels: listOnboardingChannels({ proUnlocked: discoveryGate.unlocked, teamUnlocked: gate.unlocked, tierLabel: discoveryGate.tierLabel }),
          gate,
          discoveryGate,
        },
      };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261023_5 批三: 渠道预检（选中某渠道后"还缺什么"）——按 `requires` 如实答，不猜。
  ipcMain.handle('devices:channel_auth', async (_event, { channelId }: { channelId?: string } = {}) => {
    try {
      const r = resolveChannel(String(channelId ?? ''));
      if (!r.ok) return { error: { code: 'NOT_FOUND', message: r.reason } };
      const gate = resolveTeamGate(licDb);
      const discoveryGate = resolveProGate(licDb);
      const channel = r.channel;
      // "已配置"只问渠道级前置条件（每设备凭据是下一步的事，不在此拦）。
      // zx_20261107_1 B2：云渠道的凭据在**账号表**（一账号一 Provider），不再只认旧 settings 键——
      //   否则用户在「设备云账号」里配好了，向导仍说"缺凭据"（说了点不到）。
      const hasAccount = channel.accountProvider != null
        && listCloudAccounts(ddb).some((a) => a.enabled && baseProviderOf(a.providerId) === channel.accountProvider);
      const hasCredentials = hasAccount
        || (channel.configKeys.length > 0 && channel.configKeys.every((k) => (settingsGet(k) ?? '') !== ''));
      const verdict = authorizeChannel(channel, {
        proUnlocked: discoveryGate.unlocked,
        teamUnlocked: gate.unlocked,
        tierLabel: discoveryGate.tierLabel,
        hasCredentials,
        // token 渠道的 token 在设备行逐台填——渠道层不拦（不然用户连列表都看不到）。
        hasToken: true,
      });
      return { data: { channelId: channel.id, verdict, hasCredentials, gate, discoveryGate } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261023_5 批三: miIO token 读写（**token 永不回包**，只回"有没有/是否密文"）。
  //   写：设备须在册（不凭地址乱写设置）；空串 = 清除。
  ipcMain.handle('devices:miio_token', async (_event, payload: { address?: string; token?: string } = {}) => {
    try {
      const address = String(payload?.address ?? '').trim();
      if (!address) return { error: { code: 'INVALID_REQUEST', message: '缺少设备地址（address）' } };
      const key = miioTokenSettingKey(address);
      if (typeof payload.token === 'string') {
        const refusal = teamFeatureRefusal(licDb, 'device_control');
        if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
        const dev = findDeviceByIdentity(ddb, 'miio', address);
        if (!dev) return { error: { code: 'NOT_FOUND', message: `台账里没有地址为 ${address} 的 miIO 设备（请先发现一次）。` } };
        if (payload.token.trim() === '') {
          clearSecret(ddb, key);
          return { data: secretState(ddb, key) };
        }
        const token = normalizeMiioToken(payload.token);
        if (!token) {
          return { error: { code: 'INVALID_TOKEN', message: 'miIO token 须为 32 位十六进制（不含空格/连字符）。' } };
        }
        const w = writeSecret(ddb, key, token);
        if (!w.ok) return { error: { code: 'SECRET_WRITE_FAILED', message: w.error } };
        return { data: secretState(ddb, key) };
      }
      return { data: secretState(ddb, key) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 台账 + 最近审计 + 发现态（只读，照常回；`gate` 供面板显示升级提示）。
  ipcMain.handle('devices:list', async (_event, { auditLimit }: { auditLimit?: number } = {}) => {
    try {
      const actions = listDeviceActions(ddb, undefined, auditLimit ?? 50);
      const payload: DevicesListPayload = {
        // zx_20261101_2 M2: 逐行带影子——期望/实况与相符判定由 main 侧纯函数算好（面板不另算一份）。
        devices: listDevices(ddb).map((d) => ({ ...d, shadow: deviceShadow(d) })),
        actions,
        // zx_20261014_3 批一: 留痕要认得出来是谁在做的——读时现查标题/项目名（map 供面板现查，非快照）。
        taskRefs: Object.fromEntries(taskRefsOf(ddb, actions.map((a) => a.task_id))),
        // zx_20261016_2 批三: 外部终端路来的留痕，读时现查终端名（只查 external 行的 actor_ref）。
        terminalRefs: Object.fromEntries(terminalNamesOf(tdb, actions.filter((a) => a.actor_kind === 'external').map((a) => a.actor_ref))),
        discoveryRunning: isDiscoveryRunning(),
        gate: resolveTeamGate(licDb),
        discoveryGate: resolveProGate(licDb),
        // zx_20261030_1 M5「限」：容量读数与"因上限未登记"计数（读不到按 0，不拦只读页）。
        capacity: {
          used: countDevices(db as unknown as CapacityDb),
          limit: capacityLimit(resolveLicenseTier(licDb), 'maxDevices'),
        },
        capacityRefusals: getDeviceCapacityRefusals(),
      };
      return { data: payload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261027_3 M1b（维特根斯坦·意义即用法）: **状态直查**——只对 `cloud` / `miio`，
  //   因为它们没有实时订阅（MQTT/HA 走上行订阅，重复查会拿直查结果覆盖设备自报的状态）。
  //   结果按 `source='provider'` 写回既有 `live`（面板如实标"直查"，不冒充上行）；
  //   查不到/未配置 token 逐条如实返回，**不写**、不抹旧快照。这是"看"，与 `devices:list` 同一先例，不经 Team 闸。
  ipcMain.handle('devices:refresh_states', async () => {
    try {
      const { targets, skipped } = selectStateRefreshTargets(listDevices(ddb));
      const refreshed: Array<Record<string, unknown>> = [];
      for (const dev of targets) {
        let result: { ok: boolean; state?: Record<string, unknown>; unsupported?: boolean; error?: string };
        let sourceLabel: string;
        if (dev.protocol === 'cloud') {
          sourceLabel = `云 Provider · ${cloudProviderIdOf(dev.address) || '未知'}`;
          result = await cloudDeviceState(dev);
        } else {
          const token = currentMiioToken(dev.address);
          if (!token) {
            refreshed.push({
              deviceId: dev.id, name: dev.name, protocol: dev.protocol, ok: false,
              error: '未配置 miIO token（先在设备行填入 token）',
            });
            continue;
          }
          sourceLabel = '米家 miIO';
          result = await miioDeviceState(dev);
          // zx_20261029_2 M1: 品类还没认出来的米家设备，状态刷新时顺带查 `miio.info` 补 model——
          //   只补派生类目，不改 `kind`（设备自述仍是 unknown）；查不到就保持"未识别"。
          if (dev.kind_class === 'unknown') {
            const model = await miioDeviceModel(dev);
            const cls = model ? kindClassOf({ kind: dev.kind, protocol: 'miio', model }) : 'unknown';
            if (cls !== 'unknown') {
              upsertDiscovered(ddb, {
                name: dev.name,
                kind: dev.kind,
                kindClass: cls,
                protocol: dev.protocol,
                address: dev.address,
                port: dev.port,
                capabilities: dev.capabilities,
                controllable: dev.controllable,
              });
            }
          }
        }
        const patch = livePatchFromProviderState(result);
        if (patch) {
          const updated = setDeviceLiveState(ddb, dev.id, patch);
          if (updated) void eventBus.emit('device.status_changed', { deviceId: updated.id, device: updated });
        }
        refreshed.push({
          deviceId: dev.id,
          name: dev.name,
          protocol: dev.protocol,
          ok: result.ok === true,
          ...(result.unsupported === true ? { unsupported: true } : {}),
          ...(result.error ? { error: result.error } : {}),
          state: result.state ?? null,
          source: sourceLabel,
          written: patch != null,
        });
      }
      return { data: { refreshed, skipped } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // MQTT 配置真源态（只读，照常回；**不触网**——连 broker 只在"开始发现"/控制时发生）。
  ipcMain.handle('devices:mqtt_status', async () => {
    try {
      const cfg = mqttConfig();
      const haCfg = resolveHaConfig(settingsGet);
      // 上屏形状只此一份（`mqttStatusPayload` 白名单逐字段抄——密码明文永不进渲染层）。
      const payload: MqttStatusPayload = mqttStatusPayload(
        cfg,
        await mqttClientAvailable(),
        { enabled: haCfg.enabled, prefix: haCfg.prefix },
      );
      return { data: payload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  /**
   * zx_20261022_3 批三（道德经·知之为知之）: **测试连接**——用户显式点了才触网，一次有界往返。
   *   · `mqtt` / `ha`：连 broker → CONNACK → 订发现主题收一小段 → 断开（报耗时/条数/失败原因）；
   *   · `tuya`：取令牌 + 拉一页设备读官方 `total`（报耗时/台数/原因）；
   *   · `http`：对**在册 http 设备**发一次有界 GET（报状态码/超时）。
   * ⚠ 探活失败**也是结果**（`ok:false` + `detail`），照样以 `data` 回——界面要显示"答了什么"，
   *   不是只弹一句"出错了"。只有"没配置/不是 http 设备/地址不属局域网"这类**前置拒**才回 `error`。
   * ⚠ 凭据永不回包：MQTT 的 endpoint/detail 只有 host:port 与失败原因；涂鸦只有区域主域名。
   * ⚠ HTTP 探活守 SSRF 围栏：地址须过 `lanAddressRefusal`（与 `device_control` 同一判据、同一处；
   *   云元数据端点另给专句）。
   */
  ipcMain.handle('devices:test', async (_event, payload: { target?: string; deviceId?: string } = {}) => {
    try {
      const target = String(payload?.target ?? '').trim();
      if (target === 'mqtt' || target === 'ha') {
        const cfg = mqttConfig();
        if (!cfg.broker) {
          return { error: { code: 'NOT_CONFIGURED', message: 'MQTT broker 未配置——请先在「MQTT 接入」区填写地址并保存。' } };
        }
        const haCfg = resolveHaConfig(settingsGet);
        const topic = target === 'ha' ? `${haCfg.prefix}/#` : cfg.discoveryTopic;
        const r = await probeMqttBroker({
          host: cfg.broker.host, port: cfg.broker.port, topic,
          auth: cfg,
        });
        return {
          data: {
            target, ok: r.ok, endpoint: r.endpoint, protocol: r.protocol,
            latencyMs: r.latencyMs, discoveryTopics: r.topics, detail: r.detail,
          },
        };
      }
      if (target === 'tuya') {
        const config = resolveTuyaConfig(settingsGet);
        if (!config) {
          return { error: { code: 'NOT_CONFIGURED', message: '涂鸦云凭据未配置（Access ID / Secret）——请先在「三方云」区填写并保存。' } };
        }
        return { data: await probeTuya(config) };
      }
      if (target === 'http') {
        const id = String(payload?.deviceId ?? '').trim();
        if (!id) return { error: { code: 'INVALID_REQUEST', message: 'HTTP 探活须提供 deviceId（在册 http 设备）' } };
        const dev = getDevice(ddb, id);
        if (!dev) return { error: { code: 'NOT_FOUND', message: `设备不存在：${id}` } };
        if (dev.protocol !== 'http') {
          return { error: { code: 'INVALID_REQUEST', message: `设备「${dev.name || dev.address}」的协议是 ${dev.protocol}，只有 http 设备可做 HTTP 探活。` } };
        }
        const refusal = lanAddressRefusal(dev.address);
        if (refusal) return { error: { code: 'UNSAFE_ADDRESS', message: refusal } };
        return { data: await probeHttpEndpoint(dev.address, dev.port) };
      }
      return { error: { code: 'INVALID_REQUEST', message: `未知测试目标：${target || '（空）'}（可选 mqtt / ha / tuya / http）` } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261017_1 批八 / zx_20261101_2 M1: 设备云配置态（**只读、不触网**）。
  //   保留旧涂鸦字段（兼容旧断言/旧面板），另带**账号列表**与容量读数。
  ipcMain.handle('devices:cloud_status', async () => {
    try {
      const status = tuyaConfigStatus(settingsGet);
      const accounts = listCloudAccounts(ddb).map(accountView);
      return {
        data: {
          ...status,
          providerRegistered: getDeviceProvider(TUYA_PROVIDER_ID) != null,
          deviceCount: listDevices(ddb).filter((d) => d.protocol === 'cloud').length,
          accounts,
          capacity: { used: countCloudAccounts(ddb), limit: capacityLimit(resolveLicenseTier(licDb), 'maxCloudAccounts') },
        },
      };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261101_2 M1: 设备云账号列表（**凭据不回包**，只回"配没配"）。
  ipcMain.handle('devices:cloud_accounts', async () => {
    try {
      return {
        data: {
          accounts: listCloudAccounts(ddb).map(accountView),
          capacity: { used: countCloudAccounts(ddb), limit: capacityLimit(resolveLicenseTier(licDb), 'maxCloudAccounts') },
          gate: resolveProGate(licDb),
        },
      };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261101_2 M1: 新建 / 修改云账号。
  //   闸序：Pro `device_discovery` → 容量（仅新建）→ 写行 → 写密文（失败回滚新建行）→ 注册 Provider。
  ipcMain.handle('devices:cloud_account_save', async (_event, payload: {
    id?: string; provider?: string; label?: string; config?: unknown; secret?: string; enabled?: boolean;
  } = {}) => {
    try {
      const refusal = proFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'PRO_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'pro' }) } };
      const p = payload ?? {};
      const id = typeof p.id === 'string' ? p.id.trim() : '';
      const secret = typeof p.secret === 'string' ? p.secret.trim() : '';

      if (id) {
        const saved = updateCloudAccount(ddb, id, { label: p.label, config: p.config, enabled: p.enabled });
        if (!saved.ok) return { error: { code: saved.code, message: saved.note } };
        if (secret) {
          const w = writeSecret(ddb, secretKeyFor(saved.account.id, secretKindOf(saved.account.provider)), secret);
          if (!w.ok) return { error: { code: 'SECRET_WRITE_FAILED', message: w.error } };
        }
        syncAccountProvider(saved.account);
        return { data: { account: accountView(saved.account) } };
      }

      if (!isCloudAccountProvider(p.provider)) {
        return { error: { code: 'INVALID_REQUEST', message: `未知的设备云厂商：${String(p.provider)}` } };
      }
      const verdict = cloudAccountCapacityVerdict(resolveLicenseTier(licDb), ddb);
      if (!verdict.ok) return { error: { code: 'CAPACITY_REACHED', message: verdict.note } };
      const created = createCloudAccount(ddb, { provider: p.provider, label: p.label, config: p.config, enabled: p.enabled });
      if (!created.ok) return { error: { code: created.code, message: created.note } };
      if (secret) {
        const w = writeSecret(ddb, secretKeyFor(created.account.id, secretKindOf(created.account.provider)), secret);
        if (!w.ok) {
          // 凭据写不进 ⇒ 账号行也不留（不留一个"看着有、其实用不了"的半截账号）。
          deleteCloudAccount(ddb, created.account.id);
          return { error: { code: 'SECRET_WRITE_FAILED', message: w.error } };
        }
      }
      const fresh = getCloudAccount(ddb, created.account.id) ?? created.account;
      syncAccountProvider(fresh);
      return { data: { account: accountView(fresh) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261101_2 M1: 删除云账号（**不挂 Pro 闸**——档位过期后仍须能移除；移除本身只减不增）。
  //   连带删该 Provider 名下的设备行与设备审计；旧涂鸦账号删除时**同时清旧设置键**，
  //   否则下次启动的迁移会把已删账号重新变出来（删除须真的删掉）。
  ipcMain.handle('devices:cloud_account_delete', async (_event, payload: { id?: string } = {}) => {
    try {
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      if (!id) return { error: { code: 'INVALID_REQUEST', message: '缺少账号 id' } };
      const account = getCloudAccount(ddb, id);
      if (!account) return { error: { code: 'NOT_FOUND', message: `设备云账号不存在：${id}` } };
      const prefix = `${account.providerId}:`;
      let removedDevices = 0;
      let removedActions = 0;
      try {
        const rows = db
          .prepare("SELECT id FROM wa_devices WHERE protocol = 'cloud' AND substr(address, 1, ?) = ?")
          .all(prefix.length, prefix) as Array<{ id: string }>;
        for (const row of rows) {
          removedActions += Number(db.prepare('DELETE FROM wa_device_actions WHERE device_id = ?').run(row.id).changes) || 0;
        }
        removedDevices = Number(db.prepare("DELETE FROM wa_devices WHERE protocol = 'cloud' AND substr(address, 1, ?) = ?").run(prefix.length, prefix).changes) || 0;
      } catch (e) {
        console.warn(`[devices] 删除账号设备失败：${(e as Error)?.message || String(e)}`);
      }
      unregisterDeviceProvider(account.providerId);
      deleteCloudAccount(ddb, id);
      clearSecret(ddb, secretKeyFor(account.id, secretKindOf(account.provider)));
      if (id === LEGACY_TUYA_ACCOUNT_ID) {
        // 旧键不删，迁移会在下次启动复活该账号——显式删除即连旧键一起清。
        for (const key of [TUYA_SETTING_ACCESS_ID, TUYA_SETTING_ACCESS_SECRET, TUYA_SETTING_REGION]) {
          try { db.prepare('DELETE FROM wa_settings WHERE key = ?').run(key); } catch { /* 旧库无键 */ }
        }
      }
      return { data: { id, removedDevices, removedActions } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261101_2 M1: 单账号"测试连接"（涂鸦取官方 total；HA 读实体数）。**只读，不下发控制**。
  ipcMain.handle('devices:cloud_account_test', async (_event, payload: { id?: string } = {}) => {
    try {
      const refusal = proFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'PRO_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'pro' }) } };
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      const account = getCloudAccount(ddb, id);
      if (!account) return { error: { code: 'NOT_FOUND', message: `设备云账号不存在：${id}` } };
      if (account.provider === 'tuya') {
        const config = tuyaConfigOf(account);
        if (!config) return { error: { code: 'NOT_CONFIGURED', message: '该账号缺少 Access ID 或 Secret' } };
        return { data: await probeTuya(config) };
      }
      const config = haConfigOf(account);
      if (!config) return { error: { code: 'NOT_CONFIGURED', message: '该账号缺少 Base URL 或访问令牌' } };
      return { data: await probeHaRest(config) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261101_2 M1: 单账号同步（Pro 闸先于任何网络调用）。
  ipcMain.handle('devices:cloud_account_sync', async (_event, payload: { id?: string } = {}) => {
    try {
      const refusal = proFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'PRO_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'pro' }) } };
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      const account = getCloudAccount(ddb, id);
      if (!account) return { error: { code: 'NOT_FOUND', message: `设备云账号不存在：${id}` } };
      if (!account.enabled) return { error: { code: 'DISABLED', message: '该账号已停用——启用后再同步。' } };
      const provider = getDeviceProvider(account.providerId);
      if (!provider) {
        markCloudAccountSync(ddb, id, 'Provider 未注册（启动接线缺失）');
        return { error: { code: 'PROVIDER_MISSING', message: '该账号的 Provider 未注册（启动接线缺失）。' } };
      }
      const result = await syncProviderDevices(ddb, provider);
      if (!result.ok) {
        markCloudAccountSync(ddb, id, result.error);
        return { error: { code: 'CLOUD_SYNC_FAILED', message: result.error } };
      }
      markCloudAccountSync(ddb, id, null);
      for (const row of result.rows) {
        void eventBus.emit('device.discovered', { deviceId: row.device.id, device: row.device, isNew: row.isNew });
      }
      return { data: { added: result.added, updated: result.updated, skipped: result.skipped, total: result.rows.length } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261017_1 批八: 涂鸦凭据读写。**Secret 只写不读**（空串=保持原值；回包永不含 Secret）。
  ipcMain.handle('devices:tuya_config', async (_event, payload: { region?: string; accessId?: string; accessSecret?: string } = {}) => {
    try {
      const p = payload ?? {};
      if (p.region !== undefined) {
        if (!(TUYA_REGIONS as readonly string[]).includes(p.region)) {
          return { error: { code: 'INVALID_REQUEST', message: `未知区域：${p.region}（可选 ${TUYA_REGIONS.join(' / ')}）` } };
        }
        settingsSet(TUYA_SETTING_REGION, p.region);
      }
      if (p.accessId !== undefined) settingsSet(TUYA_SETTING_ACCESS_ID, String(p.accessId).trim());
      if (typeof p.accessSecret === 'string' && p.accessSecret.trim() !== '') {
        settingsSet(TUYA_SETTING_ACCESS_SECRET, p.accessSecret.trim());
      }
      // zx_20261101_2 M1: 旧入口写完同步到**旧账号行**（若已迁出）——旧面板与新账号列表说的是同一份配置。
      const migrated = ensureLegacyTuyaAccount(ddb, settingsGet, (d, k, v) => writeSecret(d, k, v));
      if (migrated.warning) console.warn(`[devices] ${migrated.warning}`);
      if (migrated.account) {
        const patched = updateCloudAccount(ddb, migrated.account.id, {
          config: {
            region: settingsGet(TUYA_SETTING_REGION) ?? 'cn',
            access_id: String(settingsGet(TUYA_SETTING_ACCESS_ID) ?? ''),
          },
        });
        if (patched.ok && typeof p.accessSecret === 'string' && p.accessSecret.trim() !== '') {
          writeSecret(ddb, secretKeyFor(migrated.account.id, 'secret'), p.accessSecret.trim());
        }
        const fresh = getCloudAccount(ddb, migrated.account.id);
        if (fresh) syncAccountProvider(fresh);
      }
      return { data: { ...tuyaConfigStatus(settingsGet), accounts: listCloudAccounts(ddb).map(accountView) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261017_1 批八: 从涂鸦云同步设备入台账。
  //   ⚠ **Pro** 闸（`device_discovery`，zx_20261029_2 M6 起归专业版）**先于**任何配置读取/网络调用；未配置⇒如实拒，不触网。
  //   ⚠ 入账走 `syncProviderDevices`（既有幂等 upsert）——发现不覆盖 `alias`/`authorized`。
  ipcMain.handle('devices:cloud_sync', async () => {
    try {
      const refusal = proFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'PRO_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'pro' }) } };

      const emitRows = (result: { rows: Array<{ device: AnsDevice; isNew: boolean }> }) => {
        for (const row of result.rows) {
          void eventBus.emit('device.discovered', { deviceId: row.device.id, device: row.device, isNew: row.isNew });
        }
      };

      const accounts = listCloudAccounts(ddb).filter((a) => a.enabled);
      // 旧路径兼容：没有任何账号行（迁移失败/旧夹具）时仍按旧单账号逻辑跑。
      if (accounts.length === 0) {
        if (!resolveTuyaConfig(settingsGet)) {
          return { error: { code: 'NOT_CONFIGURED', message: '涂鸦云凭据未配置（Access ID / Secret）——请先在「三方云」区填写并保存。' } };
        }
        const provider = getDeviceProvider(TUYA_PROVIDER_ID);
        if (!provider) return { error: { code: 'PROVIDER_MISSING', message: '涂鸦云 Provider 未注册（启动接线缺失）。' } };
        const result = await syncProviderDevices(ddb, provider);
        if (!result.ok) return { error: { code: 'CLOUD_SYNC_FAILED', message: result.error } };
        emitRows(result);
        return { data: { added: result.added, updated: result.updated, skipped: result.skipped, total: result.rows.length, accounts: [] } };
      }

      // 多账号**并发**同步（网络并行、库写入同步）；每个账号各自记账，失败不连坐。
      const summaries = await Promise.all(accounts.map(async (account) => {
        const provider = getDeviceProvider(account.providerId);
        if (!provider) {
          markCloudAccountSync(ddb, account.id, 'Provider 未注册（账号停用或启动接线缺失）');
          return { id: account.id, label: account.label, ok: false as const, error: 'Provider 未注册' };
        }
        const result = await syncProviderDevices(ddb, provider);
        if (!result.ok) {
          markCloudAccountSync(ddb, account.id, result.error);
          return { id: account.id, label: account.label, ok: false as const, error: result.error };
        }
        markCloudAccountSync(ddb, account.id, null);
        emitRows(result);
        return {
          id: account.id, label: account.label, ok: true as const,
          added: result.added, updated: result.updated, skipped: result.skipped, total: result.rows.length,
        };
      }));
      const sum = (k: 'added' | 'updated' | 'skipped') =>
        summaries.reduce((n, s) => n + (s.ok ? s[k] : 0), 0);
      return { data: { added: sum('added'), updated: sum('updated'), skipped: sum('skipped'), accounts: summaries } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 起发现：落账后发 `device.discovered`（持久化）——面板据此实时刷新台账。**Pro** 档软闸（M6）：锁定即不触发现。
  // zx_20261013_1 批五: 配了 MQTT broker（且开关开）时**并联** MQTT 发现——两路各自自述、共用同一落账面。
  ipcMain.handle('devices:discover', async () => {
    try {
      const refusal = proFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'PRO_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'pro' }) } };
      const cfg = mqttConfig();
      const haCfg = resolveHaConfig(settingsGet);
      const mqttErrors: string[] = [];
      // 本入口与 `startDeviceDiscovery` 一样可重复调用：先收旧一轮的实时订阅，再按本轮配置重建。
      stopDeviceLiveSubscriptions();
      // zx_20261023_5 批三: 米家 miIO（UDP 54321 hello + mDNS `_miio._udp`）与 mDNS/SSDP **并联**。
      //   只在用户点了"开始发现"时才起（同一道显式动作闸），不额外自动扫网。
      const parts: DiscoveryIo[] = [defaultDiscoveryIo(), mijiaMiioDiscoveryIo()];
      if (cfg.enabled && cfg.broker) {
        parts.push(mqttDiscoveryIo({
          brokerHost: cfg.broker.host,
          brokerPort: cfg.broker.port,
          discoveryTopic: cfg.discoveryTopic,
          // 凭据随配置进连接选项（TLS 端口/校验也在此生效）；**绝不**落到日志或回包。
          auth: cfg,
          // 连不上/没装客户端 ⇒ 如实留一句（随响应回；不谎称"发现中"）。
          onError: (msg) => { mqttErrors.push(msg); },
        }));
      }
      // zx_20261015_3 批二: HA 标准桥**并联**——同一 broker，另一种发现语言（`<prefix>/#`）。
      //   两语言互不代劳：各自只订各自的主题树；共用同一落账面（`upsertDiscovered`）。
      // 批三: 顺带跟踪可用性——**只由可用性事件**回填 `online`（**不**从发现载荷推在线）。
      // zx_20261018_1 批四: 可用性事件的**唯一落点**改走注册表 `applyAvailability`——
      //   判"不在"时**同时清掉 live**（旧 state 不得继续冒充在线）；在线态仍是三态如实写。
      const onAvailabilityEvent = (address: string, online: boolean): void => {
        const dev = findDeviceByIdentity(ddb, 'mqtt', address);
        if (!dev) return; // 尚未入账 ⇒ 无从回填（不造行——发现与可用性是两件事）
        const updated = applyDeviceAvailability(ddb, dev.id, online);
        if (updated) void eventBus.emit('device.status_changed', { deviceId: updated.id, device: updated });
      };
      if (haCfg.enabled && haCfg.broker) {
        parts.push(haDiscoveryIo({
          brokerHost: haCfg.broker.host,
          brokerPort: haCfg.broker.port,
          prefix: haCfg.prefix,
          auth: cfg,
          onError: (msg) => { mqttErrors.push(msg); },
          onAvailability: onAvailabilityEvent,
        }));
      }
      // zx_20261018_1 批四: 实时状态订阅——与发现共用同一个 broker；按设备自述的 `state:`/`jattr:`
      //   去重订阅（重复发现不叠加）。消息落 `status_json.live`（读-改-写，不抹上次控制快照）。
      const liveBroker = cfg.enabled && cfg.broker ? cfg.broker : haCfg.enabled && haCfg.broker ? haCfg.broker : null;
      if (liveBroker) {
        const manager = createLiveSubscriptionManager({
          brokerHost: liveBroker.host,
          brokerPort: liveBroker.port,
          auth: cfg,
          onError: (msg) => { mqttErrors.push(msg); },
          onUpdate: (u) => {
            const dev = getDevice(ddb, u.deviceId);
            if (!dev) return; // 设备已被删：不再落状态（不造行）
            const updated = u.kind === 'state'
              ? setDeviceLiveState(ddb, dev.id, { source: 'state', state: u.payload })
              : setDeviceLiveAttributes(ddb, dev.id, u.payload);
            if (updated) void eventBus.emit('device.status_changed', { deviceId: updated.id, device: updated });
          },
        });
        liveSub = manager;
        // 已在册的设备也订上（保留发现会重放，但已入账而本轮未重放的设备不应漏订）。
        for (const dev of listDevices(ddb)) {
          try { manager.subscribe(dev); } catch { /* 单台订阅失败：其余照订 */ }
        }
      }
      startDeviceDiscovery(ddb, {
        io: composeDiscoveryIo(...parts),
        onDiscovered: (device, info) => {
          // 新入账的设备随手订上它的上行主题（管理器按主题去重，重复发现不叠加）。
          try { liveSub?.subscribe(device); } catch { /* 单台订阅失败：不拖垮发现 */ }
          // `device` 已是落账后的行（含 id/authorized）。`isNew` 供界面标"新发现"。
          void eventBus.emit('device.discovered', { deviceId: device.id, device, isNew: info.isNew });
        },
      });
      return { data: { discoveryRunning: isDiscoveryRunning(), mqttEnabled: cfg.enabled, haEnabled: haCfg.enabled, mqttErrors } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('devices:stop', async () => {
    try {
      // 实时状态订阅与发现**同生共死**：停了发现，上行订阅也一并归零（broker 侧不残留）。
      stopDeviceLiveSubscriptions();
      stopDeviceDiscovery();
      return { data: { discoveryRunning: isDiscoveryRunning() } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 授权开关（M9 唯一写点）：写 `wa_devices.authorized` 后发 `device.status_changed` 供面板刷。Team 档软闸：锁定即不写。
  ipcMain.handle('devices:authorize', async (_event, { deviceId, authorized }: { deviceId: string; authorized: boolean }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'device_control');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const dev = setDeviceAuthorized(ddb, deviceId, !!authorized);
      if (!dev) return { error: { code: 'NOT_FOUND', message: `设备不存在：${deviceId}` } };
      // zx_20261112_2 B3：GUI 授权与 IM 授权台**同一把尺**——都留审计（此前只有 IM 那条留）。
      recordAudit(ddb as never, {
        actorKind: 'local', actorRef: 'gui',
        action: authorized ? 'device.authorize' : 'device.revoke',
        targetType: 'device', targetId: dev.id,
        detail: { via: 'gui', deviceKind: dev.kind, name: dev.name },
      });
      void eventBus.emit('device.status_changed', { deviceId: dev.id, device: dev });
      return { data: dev };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261014_1 批二（道德经·名可名非常名）: **改名**——写"我叫它什么"（`wa_devices.alias`），
  //   发现**不会**回头覆写它。⚠ **刻意不经 Team 档软闸**：改名是**本地元数据**，不触网、不下发命令、
  //   不改设备状态——M22 的软闸只管**动作**出口（discover/authorize/control），`devices:list` 照常回即先例。
  //   `alias` 空串=**清除别名**（回到设备自述名），是合法操作、不是错误。
  ipcMain.handle('devices:rename', async (_event, { deviceId, alias }: { deviceId: string; alias: string }) => {
    try {
      const dev = setDeviceAlias(ddb, deviceId, String(alias ?? ''));
      if (!dev) return { error: { code: 'NOT_FOUND', message: `设备不存在：${deviceId}` } };
      void eventBus.emit('device.status_changed', { deviceId: dev.id, device: dev });
      return { data: dev };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261018_1 批三（维特根斯坦·意义即用法）: **指派房间**——写 `wa_devices.room`（显式数据）。
  //   发现带来的提示只在空房间时采用，绝不覆盖这里写下的值（同 `alias` 待遇）。
  //   ⚠ 与 `devices:rename` 同一先例：本地元数据，**不经** Team 档软闸。
  //   `room` 空串=**清除房间**（回到"未分配"），是合法操作、不是错误。
  ipcMain.handle('devices:set_room', async (_event, { deviceId, room }: { deviceId: string; room: string }) => {
    try {
      const dev = setDeviceRoom(ddb, deviceId, String(room ?? ''));
      if (!dev) return { error: { code: 'NOT_FOUND', message: `设备不存在：${deviceId}` } };
      void eventBus.emit('device.status_changed', { deviceId: dev.id, device: dev });
      return { data: dev };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 面板手动控制：走 `runDeviceControl`（与工具体同一编排），传动用默认派发（`defaultDeviceControl`，
  //   MQTT → 适配层 / 其余 → HTTP，选路一处）。Team 档软闸：锁定即不下发。
  ipcMain.handle('devices:control', async (_event, { deviceId, action, args }: { deviceId: string; action: string; args?: Record<string, unknown> }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'device_control');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      // zx_20261016_2 批二: 面板手动控制**如实标成 `panel`**——留痕行据此显出"谁按的"
      //   （此前只有工具路带 `taskId`，面板/外部两路留痕认不出发起者）。
      const outcome = await runDeviceControl(ddb, { deviceId, action, args, actor: { kind: 'panel' } }, defaultDeviceControl);
      return { data: outcome };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  /**
   * zx_20261018_1 批五「落」· 第一跳：预览。"客厅有点热" → **排好的步骤与理由**（人先看见再决定做不做）。
   * **零设备动作**：只读台账 + 落一条 `status='planned'` 的计划（owner `'panel'`）。
   * 不经 Team 闸——这是"看"，不是"动"（与 `devices:list` 同一先例）。
   */
  ipcMain.handle('devices:intent_preview', async (_event, payload: {
    intent?: string; params?: Record<string, unknown>; room?: string; feeling?: string;
  } = {}) => {
    try {
      const p = payload ?? {};
      // zx_20261104_3 M4：入参升级为 `{intent, params}`；**老形状**（只有 room/feeling）按 `home.comfort` 兼容。
      const requested = typeof p.intent === 'string' ? p.intent.trim() : '';
      const intent = requested || HOME_COMFORT_INTENT;
      const params = requested === ''
        ? { room: p.room, feeling: p.feeling }
        : typeof p.params === 'object' && p.params !== null && !Array.isArray(p.params)
          ? p.params
          : { room: p.room };
      const v = validateIntent({ intent, params });
      if (!v.ok) {
        return { error: { code: 'INVALID_REQUEST', message: (v.body.errors ?? []).join('；') || v.body.error } };
      }
      // 与门外/工具同一条解析链：舒适走规则 → 规则排不出且开关开 ⇒ 模型 → 再校验；离家**只走规则**。
      const modelFallback = getAnsClient && readBoolSetting(db, 'device.intent_model_fallback');
      const plan = await resolveHomeIntent(
        { intent: v.intent, params: v.params },
        {
          listDevices: () => listDevices(ddb),
          ...(modelFallback
            ? { modelPlan: (input) => runComfortModelPlan(input, { getAnsClient: getAnsClient! }) }
            : {}),
        },
      );
      if (!plan.ok) {
        // 不生成空计划——如实回"这房间里没有能做的"（被略过的设备照实带原因）。
        // zx_20261029_2 M2：失败原因**细分到可行动**——`message` 是给用户看的下一步，
        //   渲染层的 IpcError 只透传 message，故把原因前缀并进同一句。
        const skipped = plan.skipped ?? [];
        const detail = skipped.length > 0
          ? `已略过：${skipped.map((s) => `${s.call_name}（${s.reason}）`).join('；')}`
          : '';
        const next = plan.message ?? '该房间里没有可执行的步骤。';
        const code = plan.reason === 'room_unassigned' ? 'ROOM_UNASSIGNED'
          : plan.reason === 'no_recognized_kind' ? 'NO_RECOGNIZED_KIND'
            : plan.reason === 'no_controllable_device' ? 'NO_CONTROLLABLE_DEVICE'
              : plan.reason === 'no_devices' ? 'NO_DEVICES'
                : plan.reason === 'invalid_params' ? 'INVALID_REQUEST'
                  : plan.reason === 'unknown_intent' ? 'UNKNOWN_INTENT'
                    : 'INTENT_PLAN_FAILED';
        return { error: { code, message: detail ? `${next}${detail}` : next } };
      }
      const created = createIntentPlan(db, {
        terminalId: 'panel', capability: INTENT_CAPABILITY,
        params: v.params, steps: plan.steps, skipped: plan.skipped,
        source: plan.source ?? 'rule',
      });
      return {
        data: {
          planId: created.id, expiresIn: created.expiresIn,
          steps: plan.steps, skipped: plan.skipped,
          source: plan.source ?? 'rule',
          sourceLabel: intentPlanSourceLabel(plan.source ?? 'rule'),
        },
      };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  /**
   * 第二跳：执行**预览时那份固定计划**（不重规划、只执行一次、过期即拒）。
   * Team 闸 `device_control` 先于认领；认主 `terminal_id==='panel'`（别人的/门外的计划拿不走）。
   */
  ipcMain.handle('devices:intent_execute', async (_event, { planId }: { planId?: string } = {}) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'device_control');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const pid = String(planId ?? '').trim();
      if (!pid) return { error: { code: 'INVALID_REQUEST', message: '须提供 planId（先调用 devices:intent_preview 取得）' } };
      const existing = getIntentPlan(db, pid);
      if (!existing) return { error: { code: 'PLAN_NOT_FOUND', message: `计划不存在：${pid}` } };
      if (existing.terminal_id !== 'panel') {
        return { error: { code: 'PLAN_NOT_YOURS', message: '这不是面板生成的计划，不能在面板执行。' } };
      }
      const exec = await executeDeviceIntentPlan(ddb, pid, {
        actor: { kind: 'panel' },
        transport: defaultDeviceControl,
      });
      if (!exec.ok) return { error: { code: `PLAN_${exec.reason.toUpperCase()}`, message: `计划不能执行：${exec.reason}` } };
      return { data: { planId: pid, status: exec.status, steps: exec.steps } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });
}
