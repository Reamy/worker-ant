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
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  applyAvailability as applyDeviceAvailability,
  findDeviceByIdentity,
  getDevice,
  listDeviceActions,
  listDevices,
  setDeviceAlias,
  setDeviceAuthorized,
  setDeviceLiveAttributes,
  setDeviceLiveState,
  setDeviceRoom,
  taskRefsOf,
  type AnsDevice,
  type DeviceActionRow,
  type DeviceDb,
  type TaskRef,
} from '../core/device-registry.js';
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
import { planHomeComfort } from '../core/home-intent.js';
import { createIntentPlan, getIntentPlan } from '../core/intent-plans.js';
import {
  HOME_COMFORT_INTENT,
  INTENT_CAPABILITY,
  validateIntent,
  type ComfortFeeling,
} from '../core/intent-protocol.js';
// zx_20261017_1 批八: 三方云（涂鸦）Provider——启动时注册，同步/控制时现读配置。
import { getDeviceProvider, syncProviderDevices } from '../core/device-provider.js';
import {
  registerTuyaCloudProvider,
  resolveTuyaConfig,
  tuyaConfigStatus,
  TUYA_PROVIDER_ID,
  TUYA_REGIONS,
  TUYA_SETTING_ACCESS_ID,
  TUYA_SETTING_ACCESS_SECRET,
  TUYA_SETTING_REGION,
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
  mijiaMiioDiscoveryIo,
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
import { refusalWithContext } from '../core/tier-usage.js';
import type { LicenseSettingDb } from '../core/license.js';

/** 首屏一屏读全：台账 + 最近审计 + 发现是否在跑。 */
export interface DevicesListPayload {
  devices: AnsDevice[];
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
  /** zx_20261005 M22: Team 档软闸——面板据此显示升级提示并禁用动作按钮。 */
  gate: TeamGate;
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

export function initDevicesIpc(db: Database.Database): void {
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

  // zx_20261017_1 批八: 涂鸦 Provider **启动时注册一次**（配置在设置里现读，控制/同步时再生效）。
  registerTuyaCloudProvider(settingsGet);

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
  ipcMain.handle('devices:channels', async () => {
    try {
      const gate = resolveTeamGate(licDb);
      return { data: { channels: listOnboardingChannels({ teamUnlocked: gate.unlocked }), gate } };
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
      const channel = r.channel;
      // "已配置"只问渠道级前置键（每设备凭据是下一步的事，不在此拦）。
      const hasCredentials = channel.configKeys.length > 0
        && channel.configKeys.every((k) => (settingsGet(k) ?? '') !== '');
      const verdict = authorizeChannel(channel, {
        teamUnlocked: gate.unlocked,
        hasCredentials,
        // token 渠道的 token 在设备行逐台填——渠道层不拦（不然用户连列表都看不到）。
        hasToken: true,
      });
      return { data: { channelId: channel.id, verdict, hasCredentials, gate } };
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
        devices: listDevices(ddb),
        actions,
        // zx_20261014_3 批一: 留痕要认得出来是谁在做的——读时现查标题/项目名（map 供面板现查，非快照）。
        taskRefs: Object.fromEntries(taskRefsOf(ddb, actions.map((a) => a.task_id))),
        // zx_20261016_2 批三: 外部终端路来的留痕，读时现查终端名（只查 external 行的 actor_ref）。
        terminalRefs: Object.fromEntries(terminalNamesOf(tdb, actions.filter((a) => a.actor_kind === 'external').map((a) => a.actor_ref))),
        discoveryRunning: isDiscoveryRunning(),
        gate: resolveTeamGate(licDb),
      };
      return { data: payload };
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

  // zx_20261017_1 批八: 三方云配置态（**只读、不触网**——不发 token 请求；无凭据如实 configured:false）。
  ipcMain.handle('devices:cloud_status', async () => {
    try {
      const status = tuyaConfigStatus(settingsGet);
      return {
        data: {
          ...status,
          providerRegistered: getDeviceProvider(TUYA_PROVIDER_ID) != null,
          deviceCount: listDevices(ddb).filter((d) => d.protocol === 'cloud').length,
        },
      };
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
      return { data: tuyaConfigStatus(settingsGet) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261017_1 批八: 从涂鸦云同步设备入台账。
  //   ⚠ Team 闸（`device_discovery`）**先于**任何配置读取/网络调用；未配置⇒如实拒，不触网。
  //   ⚠ 入账走 `syncProviderDevices`（既有幂等 upsert）——发现不覆盖 `alias`/`authorized`。
  ipcMain.handle('devices:cloud_sync', async () => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      if (!resolveTuyaConfig(settingsGet)) {
        return { error: { code: 'NOT_CONFIGURED', message: '涂鸦云凭据未配置（Access ID / Secret）——请先在「三方云」区填写并保存。' } };
      }
      const provider = getDeviceProvider(TUYA_PROVIDER_ID);
      if (!provider) {
        return { error: { code: 'PROVIDER_MISSING', message: '涂鸦云 Provider 未注册（启动接线缺失）。' } };
      }
      const result = await syncProviderDevices(ddb, provider);
      if (!result.ok) return { error: { code: 'CLOUD_SYNC_FAILED', message: result.error } };
      // 与发现路同一事件语义（面板据此实时刷新；`isNew` 供"新发现"标记）。
      for (const row of result.rows) {
        void eventBus.emit('device.discovered', { deviceId: row.device.id, device: row.device, isNew: row.isNew });
      }
      return { data: { added: result.added, updated: result.updated, total: result.rows.length } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 起发现：落账后发 `device.discovered`（持久化）——面板据此实时刷新台账。Team 档软闸：锁定即不触发现。
  // zx_20261013_1 批五: 配了 MQTT broker（且开关开）时**并联** MQTT 发现——两路各自自述、共用同一落账面。
  ipcMain.handle('devices:discover', async () => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
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
  ipcMain.handle('devices:intent_preview', async (_event, payload: { room?: string; feeling?: string } = {}) => {
    try {
      const p = payload ?? {};
      const v = validateIntent({ intent: HOME_COMFORT_INTENT, params: { room: p.room, feeling: p.feeling } });
      if (!v.ok) {
        return { error: { code: 'INVALID_REQUEST', message: (v.body.errors ?? []).join('；') || v.body.error } };
      }
      const plan = planHomeComfort(listDevices(ddb), String(v.params.room), v.params.feeling as ComfortFeeling);
      if (!plan.ok) {
        // 不生成空计划——如实回"这房间里没有能做的"（被略过的设备照实带原因，写进人看的那句话：
        //   渲染层的 IpcError 只透传 message，旁挂字段到不了界面）。
        const skipped = plan.skipped ?? [];
        const detail = skipped.length > 0
          ? `已略过：${skipped.map((s) => `${s.call_name}（${s.reason}）`).join('；')}`
          : '该房间没有相关设备。';
        return { error: { code: 'NO_CONTROLLABLE_DEVICE', message: `该房间里没有可执行的步骤——${detail}` } };
      }
      const created = createIntentPlan(db, {
        terminalId: 'panel', capability: INTENT_CAPABILITY,
        params: v.params, steps: plan.steps, skipped: plan.skipped,
      });
      return { data: { planId: created.id, expiresIn: created.expiresIn, steps: plan.steps, skipped: plan.skipped } };
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
