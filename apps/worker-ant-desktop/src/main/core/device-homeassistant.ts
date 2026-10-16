/**
 * zx_20261015_3 批一（道德经·不出户知天下 / 维特根斯坦·意义即用法 / 庄子·不预设 / 毛选·集中优势兵力）:
 * **Home Assistant 标准桥——上行**：把 HA 的 **MQTT Discovery 标准载荷**读成工蚁的
 * `DiscoveredDevice`（落账后再进既有台账/闸/审计，**语义全在** `device-registry.ts`，此处不重写）。
 *
 * 为何是这一条缝（§1）：
 *   · HA 把每台设备的 `command_topic`/`state_topic`/`availability_topic`/`device_class` 按**标准协议**
 *     发布在 `<prefix>/<component>/[<node_id>/]<object_id>/config`（缺省 prefix `homeassistant`）。
 *   · **认这台 HA 的语言** ⇒ 一家 HA 覆盖米家/涂鸦/美的/海尔…**数百品牌**，**零厂商对接**，且**全部合规**
 *     （对接的是**用户自己的** HA 实例）。这就是"不出户知天下"——不逐家登门。
 *
 * 三个"不"（承既有判法，勿改）：
 *   · **不预设**（庄子）：`kind`/`capabilities`/`controllable` 一律取自 **HA 自述**（`component`/`cmd_t`/…），
 *     不自造、不猜（猜错的"能力"比"未知"更坏——模型会照着做）。
 *   · **认不出即退**：非 `config` 末段 / 段数不合 / 非 JSON / 非对象 ⇒ `null`（与 `mqttDiscoveryToDevice` 同尺）。
 *   · **两语言不混**：本模块只读 **HA 语言**（`cmd_t`/`ON`/`~`）；工蚁自有语言（`{id,name,cmd}`）在
 *     `device-mqtt.ts` 的 `mqttDiscoveryToDevice`——**互不代劳**（维特根斯坦·意义即用法）。
 *
 * ⚠ **能力前缀沿用既有语言**（`cmd:`/`state:`）⇒ 传动路（`mqttCommandTopic`/`publishAndAwaitState`）**零改**；
 *   离线态另用 `avty:` 前缀（批三消费）。
 * ⚠ 本模块**零网络依赖**（静态只 `import type` + 复用既有两个纯助手）⇒ 受控回归**直引跑真实现**。
 */
import type { DiscoveredDevice } from './device-registry.js';
import { deriveDeviceKind, type DiscoveryIo } from './device-discovery.js';
import { mqttAddress, mqttTopicSegment, parseMqttBroker, openSubscriber, type MqttSubscribeIo, type MqttSubscriber } from './device-mqtt.js';

/** HA discovery 缺省前缀（HA 标准；可在面板改——`device.ha.prefix`）。 */
export const HA_DEFAULT_PREFIX = 'homeassistant';

/**
 * HA 标准**缩写**表（discovery 载荷的键可缩写以省字节）。
 * 语料：<https://www.home-assistant.io/integrations/mqtt/#configuration-variables>。
 * ⚠ 全称与缩写**并存**时**全称优先**（HA 允许两种写法，实现须都认，见 `normalizeHaKeys`）。
 */
export const HA_ABBREV: Readonly<Record<string, string>> = {
  uniq_id: 'unique_id',
  cmd_t: 'command_topic',
  stat_t: 'state_topic',
  avty_t: 'availability_topic',
  pl_avail: 'payload_available',
  pl_not_avail: 'payload_not_available',
  dev_cla: 'device_class',
  dev: 'device',
  // ⚠ 订正（第三方载荷回放照出）：`stat_on`/`stat_off` 是 HA 的**状态**语义（`state_on`/`state_off`），
  //   **不是**命令载荷。命令载荷的缩写是 `pl_on`/`pl_off`（→`payload_on`/`payload_off`）。
  //   旧表把 `stat_on→payload_on` ⇒ ①丢 Tasmota 等真实设备的 `pl_on`/`pl_off` 自述载荷
  //   （下行退回缺省 `ON`/`OFF`，自述非 ON/OFF 者发错）；②把状态判别值误当命令载荷。
  stat_on: 'state_on',
  stat_off: 'state_off',
  pl_on: 'payload_on',
  pl_off: 'payload_off',
  stat_cla: 'state_class',
  unit_of_meas: 'unit_of_measurement',
  val_tpl: 'value_template',
  json_attr_t: 'json_attributes_topic',
  pos_t: 'position_topic',
  set_pos_t: 'set_position_topic',
  stat_val_tpl: 'state_value_template',
  cmd_on_tpl: 'command_on_template',
  cmd_off_tpl: 'command_off_template',
};

/** HA 标准 component（设备自述的类别）；**非白名单**——认不出仍入账（庄子·不预设），只用它决定 `kind`。 */
export const HA_COMPONENTS: ReadonlySet<string> = new Set([
  'light', 'switch', 'sensor', 'binary_sensor', 'cover', 'climate', 'fan', 'lock',
  'scene', 'button', 'number', 'select', 'vacuum', 'humidifier', 'water_heater',
  'media_player', 'camera', 'siren', 'valve', 'device_tracker', 'update', 'text',
]);

/** 一个 discovery 主题的解析结果（`<prefix>/<component>/[<node_id>/]<object_id>/config`）。 */
export interface HaDiscoveryRef {
  component: string;
  /** 有则取自 HA 的 node_id 段；无则 `null`（3 段式）。 */
  nodeId: string | null;
  objectId: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析 HA discovery 主题。**认不出即 `null`**——不硬塞（承 `mqttDiscoveryToDevice` 同判法）。
 * 形态：`<prefix>/<component>/[<node_id>/]<object_id>/config` ⇒ 共 4 段（无 node_id）或 5 段（有）。
 * ⚠ 前缀**逐段**匹配（`homeassistant` 不会误吞 `homeassistantX`）；末段**必须**是 `config`
 *   （同前缀下的 `homeassistant/status` 等**非配置**主题不认——那是 HA 自身的出生/遗嘱，见 §四）。
 */
export function parseHaDiscoveryTopic(topic: string, prefix: string = HA_DEFAULT_PREFIX): HaDiscoveryRef | null {
  const p = (prefix || HA_DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '');
  if (!p) return null;
  const segs = String(topic ?? '').split('/').filter((s) => s.length > 0);
  if (segs.length < 4 || segs.length > 5) return null;
  const pSegs = p.split('/').filter(Boolean);
  if (segs.length < pSegs.length + 3) return null;
  for (let i = 0; i < pSegs.length; i++) if (segs[i] !== pSegs[i]) return null;
  const rest = segs.slice(pSegs.length);
  if (rest[rest.length - 1] !== 'config') return null;
  const body = rest.slice(0, -1); // [component, objectId] 或 [component, nodeId, objectId]
  if (body.length === 2) return { component: body[0], nodeId: null, objectId: body[1] };
  if (body.length === 3) return { component: body[0], nodeId: body[1], objectId: body[2] };
  return null;
}

/**
 * `~` 基主题替换（HA 标准）：`base` 非空 ⇒ 把值中 `~` **全替换**为它；`base` 空 ⇒ **原样返回**。
 * ⚠ "没有基主题"**不等于**"要删 `~`"——故无基时**不**动值（如实，不猜作者意图）。
 */
export function expandHaTopic(value: string, base: string | null | undefined): string {
  const v = String(value ?? '');
  const b = (base ?? '').trim();
  if (!b || !v.includes('~')) return v;
  return v.split('~').join(b);
}

/** 展开缩写键（全称优先；非字符串键原样保留）。 */
function normalizeHaKeys(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  for (const [abbr, full] of Object.entries(HA_ABBREV)) {
    if (abbr in cfg && !(full in out)) {
      out[full] = cfg[abbr];
    }
    delete out[abbr];
  }
  return out;
}

/** 由 `device` 块取设备级自述名（`dev.name`，HA `device` 块的名称）。 */
function deviceBlockName(cfg: Record<string, unknown>): string | null {
  const dev = cfg.device;
  if (!isPlainObject(dev)) return null;
  const n = dev.name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** 取字符串字段（空串视同缺）。 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * HA discovery 载荷 → `DiscoveredDevice`。**认不出即 `null`**（非 JSON / 非对象 / 主题不合规）。
 *
 * - **话题展开**：`~` 基主题（`cfg['~']`）+ **缩写键**展开（全称优先）。
 * - **身份**：`unique_id` 优先，回退 `<component>/<object_id>`（经 `mqttTopicSegment` 洗安全），
 *   台账地址 = `mqttAddress(brokerHost, id)`——**复用** `device-mqtt.ts` 的地址约定（不另立一份）。
 * - **`kind`**：HA `component` **逐字**（设备自述的类别，庄子·不预设）。⚠ `lock` 逐字即命中
 *   `HIGH_RISK_DEVICE_KINDS` ⇒ 高危写操作**自动**被既有闸拒（同一把尺，不另立判据）。
 * - **能力**：`['mqtt','ha:<component>', 'cmd:<…>', 'state:<…>', 'avty:<…>']`（后三者有条件才加）。
 * - **`controllable`**：有 `command_topic` ⇒ true；纯 `sensor`/`binary_sensor` 无命令主题 ⇒ false。
 */
export function haConfigToDevice(
  topic: string,
  raw: string,
  brokerHost: string,
  brokerPort: number | null,
  prefix: string = HA_DEFAULT_PREFIX,
): DiscoveredDevice | null {
  const ref = parseHaDiscoveryTopic(topic, prefix);
  if (!ref) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const cfg = normalizeHaKeys(parsed);
  const base = str(cfg['~']);
  const topicOf = (key: string): string | null => {
    const v = str(cfg[key]);
    return v ? expandHaTopic(v, base) : null;
  };

  const commandTopic = topicOf('command_topic');
  const stateTopic = topicOf('state_topic');
  const availabilityTopic = topicOf('availability_topic');

  const uniqueId = str(cfg.unique_id);
  const identityRaw = uniqueId ?? `${ref.component}/${ref.objectId}`;
  const id = mqttTopicSegment(identityRaw);

  const component = ref.component.trim().toLowerCase();
  const name = str(cfg.name) ?? deviceBlockName(cfg) ?? ref.objectId;

  const capabilities = ['mqtt', `ha:${component}`];
  if (commandTopic) capabilities.push(`cmd:${commandTopic}`);
  if (stateTopic) capabilities.push(`state:${stateTopic}`);
  if (availabilityTopic) capabilities.push(`avty:${availabilityTopic}`);
  // 设备**自述**的开/关载荷（HA 标准字段；未自述则下行取 HA 缺省 ON/OFF）——不读即失真（自述优先）。
  const onPayload = str(cfg.payload_on);
  const offPayload = str(cfg.payload_off);
  if (onPayload) capabilities.push(`on:${onPayload}`);
  if (offPayload) capabilities.push(`off:${offPayload}`);

  return {
    name,
    // HA component 是设备自述的类别——逐字采用；认不出（不在 HA 标准集）则回退与 mDNS/SSDP 同一把尺。
    kind: HA_COMPONENTS.has(component) ? component : deriveDeviceKind(`${component} ${name} ${id}`),
    protocol: 'mqtt',
    address: mqttAddress(brokerHost, id),
    port: brokerPort,
    capabilities,
    // 有命令主题 ⇒ 自述可被命令（与 mDNS/SSDP 的"自述线索"同一判法）。
    controllable: commandTopic != null,
  };
}

/**
 * HA 桥配置的**只读**上屏形状。`enabled` **缺省关**（连 broker 是可被察觉的网络行为，须人显式开）。
 * broker **与 MQTT 卡共用**（HA 的 Mosquitto add-on 就是那个 broker——一处配置，两种发现语言）。
 */
export interface HaConfig {
  enabled: boolean;
  broker: { host: string; port: number | null } | null;
  prefix: string;
}

/**
 * 由取数函数解析 HA 配置（**不碰 DB** ⇒ rr 直跑真判据）。
 * ⚠ 键 `device.ha.enabled` **刻意不进** `BOOL_SETTING_KEYS`——那一族是"缺省即开"（`boolSetting` 判"只有明确说关才算关"），
 *   混入即制造 `zx_20261014_4` 批一那条"新机器默认敞口"的病。此处取 `device.mqtt.enabled` **同一范式**：
 *   **读不到 = 关**（"关"就是缺省，无需 seed）。
 */
export function resolveHaConfig(get: (key: string) => string | null | undefined): HaConfig {
  const rawEnabled = String(get('device.ha.enabled') ?? '').trim().toLowerCase();
  const broker = parseMqttBroker(get('device.mqtt.broker'));
  const prefix = String(get('device.ha.prefix') ?? '').trim() || HA_DEFAULT_PREFIX;
  return {
    enabled: (rawEnabled === '1' || rawEnabled === 'true' || rawEnabled === 'on') && broker != null,
    broker,
    prefix,
  };
}

/** HA 桥的发现订阅主题（`<prefix>/#`——HA 把**所有** discovery config 发在这棵树下）。 */
export function haDiscoveryTopic(prefix: string = HA_DEFAULT_PREFIX): string {
  const p = (prefix || HA_DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '') || HA_DEFAULT_PREFIX;
  return `${p}/#`;
}

/** 一台 HA 设备的**可用性约定**（取自 discovery config；批三消费）。 */
export interface HaAvailability {
  /** 台账地址（`mqttAddress(brokerHost, id)`，与 `haConfigToDevice` **同一算法**）——可用性事件据此回到哪台设备。 */
  address: string;
  /** 可用性主题（已展开 `~`）。 */
  topic: string;
  /** 视为"在线"的载荷（缺省 HA 标准 `online`）。 */
  payloadAvailable: string;
  /** 视为"离线"的载荷（缺省 HA 标准 `offline`）。 */
  payloadNotAvailable: string;
}

/**
 * 由 discovery 载荷取**可用性约定**：`availability_topic`（缩写 `avty_t`）**或** `availability[0].topic`。
 * **认不出即 `null`**（无可用性自述 ⇒ 该设备在线态留 `null`，不猜）。地址算法与 `haConfigToDevice` **逐字同**。
 */
export function haAvailabilityOf(
  topic: string,
  raw: string,
  brokerHost: string,
  prefix: string = HA_DEFAULT_PREFIX,
): HaAvailability | null {
  const ref = parseHaDiscoveryTopic(topic, prefix);
  if (!ref) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const cfg = normalizeHaKeys(parsed);
  const base = str(cfg['~']);
  const avail = Array.isArray(cfg.availability) ? cfg.availability : null;
  const block = avail && isPlainObject(avail[0]) ? (avail[0] as Record<string, unknown>) : null;
  // 本轮取**首个**可用性源（`availability_topic` 优先，其次 `availability[0].topic`）——多源聚合登记待判（§四.5）。
  const rawTopic = str(cfg.availability_topic) ?? (block ? str(block.topic) : null);
  if (!rawTopic) return null;
  const payloadAvailable = str(cfg.payload_available) ?? (block ? str(block.payload_available) : null) ?? 'online';
  const payloadNotAvailable = str(cfg.payload_not_available) ?? (block ? str(block.payload_not_available) : null) ?? 'offline';
  const uniqueId = str(cfg.unique_id);
  const id = mqttTopicSegment(uniqueId ?? `${ref.component}/${ref.objectId}`);
  return { address: mqttAddress(brokerHost, id), topic: expandHaTopic(rawTopic, base), payloadAvailable, payloadNotAvailable };
}

/**
 * 可用性载荷 → **三态**：`payloadAvailable` ⇒ `true` / `payloadNotAvailable` ⇒ `false` / 其余 ⇒ `null`。
 * ⚠ 认不出的载荷回 `null`（调用方**据此不写**——留旧值，不猜"在线/离线"）。
 */
export function haAvailabilityOnline(
  payload: string,
  av: Pick<HaAvailability, 'payloadAvailable' | 'payloadNotAvailable'>,
): boolean | null {
  const p = String(payload ?? '').trim();
  if (p === av.payloadAvailable) return true;
  if (p === av.payloadNotAvailable) return false;
  return null;
}

export interface HaDiscoveryIoOpts {
  /** broker 主机（成为台账地址前缀）；**与 MQTT 卡共用**（HA 的 Mosquitto add-on 就是那个 broker）。 */
  brokerHost: string;
  brokerPort?: number | null;
  /** HA discovery 前缀（缺省 `homeassistant`）。 */
  prefix?: string;
  /** 可注入订阅面；缺省惰性 `import('mqtt')` 真订阅。 */
  io?: MqttSubscribeIo;
  /** 连接/订阅失败**如实上报**；缺省静默降级为"无 HA 发现"。 */
  onError?: (msg: string) => void;
  /**
   * 可用性状态（批三；道德经·知止不殆）：传了才跟踪。**只由可用性事件驱动**，认不出载荷**不回调**。
   * `address` = 台账地址（调用方据此 `findDeviceByIdentity` → `setDeviceOnline`）。
   */
  onAvailability?: (address: string, online: boolean) => void;
}

/**
 * **HA 发现 io**：订阅 `<prefix>/#`，把标准 discovery 载荷经 `haConfigToDevice` 读成设备 → 交 `onFound`
 * （再进既有 `upsertDiscovered` 落账；幂等/授权/闸语义全在 `device-registry.ts`）。
 * 传了 `onAvailability` 则**顺带**：对自述了可用性主题的设备**动态订阅**其 `avty` 主题，把载荷经
 *   `haAvailabilityOnline` 读成三态 → 回 `onAvailability`（**只看可用性事件**，绝不从 discovery 载荷推在线）。
 * ⚠ 与 `mqttDiscoveryIo` **共用同一条订阅骨**（`openSubscriber`）——差别只在「语言」这一个参数。
 * ⚠ **两语言不混靠主题范围**：本 io 只订 `<prefix>/#`（+ 各设备自述的 `avty` 主题），工蚁自有发现只订
 *   `workerant/discovery/#`——**互不代劳**（维特根斯坦·意义即用法）；认不出的载荷 `haConfigToDevice` 回 `null` ⇒ 跳过。
 */
export function haDiscoveryIo(opts: HaDiscoveryIoOpts): DiscoveryIo {
  const brokerHost = opts.brokerHost;
  const brokerPort = opts.brokerPort ?? null;
  const prefix = (opts.prefix || HA_DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '') || HA_DEFAULT_PREFIX;
  let stopped = false;
  let sub: MqttSubscriber | null = null;
  const availSubscribed = new Set<string>(); // 已订阅的可用性主题（去重，防同一设备多条 config 重复订阅）

  return {
    start(onFound) {
      const handle = openSubscriber({ brokerHost, brokerPort, io: opts.io, onError: opts.onError });
      sub = handle;
      const emit = (topic: string, payload: string): void => {
        if (stopped) return;
        const dev = haConfigToDevice(topic, payload, brokerHost, brokerPort, prefix);
        if (!dev) return; // 认不出 ⇒ 跳过（不硬塞）
        // 批三：config 自述可用性 ⇒ **动态订阅**其主题（主题须待发现后才知）。**不**从此载荷推"在线"。
        if (opts.onAvailability) {
          const av = haAvailabilityOf(topic, payload, brokerHost, prefix);
          if (av && !availSubscribed.has(av.topic)) {
            availSubscribed.add(av.topic);
            handle.subscribe(av.topic, (t, p) => {
              if (stopped || t !== av.topic) return; // 各消费者**各认各的主题**（此骨全量分发）
              const online = haAvailabilityOnline(p, av);
              if (online === null) return; // 认不出 ⇒ 不写（留旧值）
              try { opts.onAvailability!(av.address, online); } catch { /* 回调失败：忽略 */ }
            });
          }
        }
        try { onFound(dev); } catch { /* 单条上报失败：忽略 */ }
      };
      handle.subscribe(haDiscoveryTopic(prefix), emit);
    },
    stop() {
      stopped = true;
      try { sub?.stop(); } catch { /* 收摊噪声 */ }
      sub = null;
    },
  };
}
