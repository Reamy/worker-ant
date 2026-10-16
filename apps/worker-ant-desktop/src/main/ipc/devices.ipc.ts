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
 *   - `devices:control`   —— 面板**手动**控制。⚠ 与工具体 `device_control` **共用同一编排**
 *                            `runDeviceControl`（闸→传动→审计→状态→事件），不另写一份——
 *                            "判据一处、编排两处"是同一类漂移（罗尔斯·同一把尺）。
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
  findDeviceByIdentity,
  listDeviceActions,
  listDevices,
  setDeviceAlias,
  setDeviceAuthorized,
  setDeviceOnline,
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
import { defaultDeviceControl, runDeviceControl } from '../core/tools/device.js';
import {
  mqttClientAvailable,
  mqttDiscoveryIo,
  resolveMqttConfig,
  type MqttConfig,
  type MqttStatusPayload,
} from '../core/device-mqtt.js';
import { haDiscoveryIo, resolveHaConfig } from '../core/device-homeassistant.js';
// zx_20261016_2 批三: 留痕要认得出来"是哪台外部终端按的"——读时现查终端名（与 `taskRefsOf` 同一把尺）。
import { terminalNamesOf, type TerminalDb } from '../core/external-terminals.js';
import { eventBus } from '../core/event-bus.js';
import { resolveTeamGate, teamFeatureRefusal, type TeamGate } from '../core/team-gate.js';
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

export function initDevicesIpc(db: Database.Database): void {
  const ddb = db as unknown as DeviceDb;
  const licDb = db as unknown as LicenseSettingDb;
  const tdb = db as unknown as TerminalDb;

  /** 读一条 setting（取数这一半；**判据/解析**在 `device-mqtt.resolveMqttConfig`——纯函数，rr 直跑真实现）。 */
  const settingsGet = (key: string): string | null => {
    try {
      const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  };
  const mqttConfig = (): MqttConfig => resolveMqttConfig(settingsGet);

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
      const payload: MqttStatusPayload = {
        enabled: cfg.enabled,
        broker: cfg.broker ? `${cfg.broker.host}:${cfg.broker.port}` : null,
        discoveryTopic: cfg.discoveryTopic,
        clientAvailable: await mqttClientAvailable(),
        ha: { enabled: haCfg.enabled, prefix: haCfg.prefix },
      };
      return { data: payload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 起发现：落账后发 `device.discovered`（持久化）——面板据此实时刷新台账。Team 档软闸：锁定即不触发现。
  // zx_20261013_1 批五: 配了 MQTT broker（且开关开）时**并联** MQTT 发现——两路各自自述、共用同一落账面。
  ipcMain.handle('devices:discover', async () => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'device_discovery');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusal } };
      const cfg = mqttConfig();
      const haCfg = resolveHaConfig(settingsGet);
      const mqttErrors: string[] = [];
      const parts: DiscoveryIo[] = [defaultDiscoveryIo()];
      if (cfg.enabled && cfg.broker) {
        parts.push(mqttDiscoveryIo({
          brokerHost: cfg.broker.host,
          brokerPort: cfg.broker.port,
          discoveryTopic: cfg.discoveryTopic,
          // 连不上/没装客户端 ⇒ 如实留一句（随响应回；不谎称"发现中"）。
          onError: (msg) => { mqttErrors.push(msg); },
        }));
      }
      // zx_20261015_3 批二: HA 标准桥**并联**——同一 broker，另一种发现语言（`<prefix>/#`）。
      //   两语言互不代劳：各自只订各自的主题树；共用同一落账面（`upsertDiscovered`）。
      // 批三: 顺带跟踪可用性——**只由可用性事件**回填 `online`（**不**从发现载荷推在线）。
      const applyAvailability = (address: string, online: boolean): void => {
        const dev = findDeviceByIdentity(ddb, 'mqtt', address);
        if (!dev) return; // 尚未入账 ⇒ 无从回填（不造行——发现与可用性是两件事）
        const updated = setDeviceOnline(ddb, dev.id, online);
        if (updated) void eventBus.emit('device.status_changed', { deviceId: updated.id, device: updated });
      };
      if (haCfg.enabled && haCfg.broker) {
        parts.push(haDiscoveryIo({
          brokerHost: haCfg.broker.host,
          brokerPort: haCfg.broker.port,
          prefix: haCfg.prefix,
          onError: (msg) => { mqttErrors.push(msg); },
          onAvailability: applyAvailability,
        }));
      }
      startDeviceDiscovery(ddb, {
        io: composeDiscoveryIo(...parts),
        onDiscovered: (device, info) => {
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
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusal } };
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

  // 面板手动控制：走 `runDeviceControl`（与工具体同一编排），传动用默认派发（`defaultDeviceControl`，
  //   MQTT → 适配层 / 其余 → HTTP，选路一处）。Team 档软闸：锁定即不下发。
  ipcMain.handle('devices:control', async (_event, { deviceId, action, args }: { deviceId: string; action: string; args?: Record<string, unknown> }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'device_control');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusal } };
      // zx_20261016_2 批二: 面板手动控制**如实标成 `panel`**——留痕行据此显出"谁按的"
      //   （此前只有工具路带 `taskId`，面板/外部两路留痕认不出发起者）。
      const outcome = await runDeviceControl(ddb, { deviceId, action, args, actor: { kind: 'panel' } }, defaultDeviceControl);
      return { data: outcome };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });
}
