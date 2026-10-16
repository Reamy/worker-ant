/**
 * zx_20261013_1 批五（庄子·物各有宜 / 维特根斯坦·意义即用法 / 管子·度量衡）:
 * **MQTT 设备适配层**——首个纵切片：用 MQTT 实现**既有两个接缝**（发现 `DiscoveryIo` /
 * 控制 `DeviceControlTransport`），以证"设备适配层"这一刀切得动（方案 §2 批五）。
 *
 * 三件事：
 *   ① **纯映射**（零 I/O ⇒ rr 直跑真实现）：台账地址约定、保留载荷 → 自述设备、命令主题/载荷、回执人话。
 *   ② **控制**：`mqttDeviceControl(dev, action, args, io?)`——编排仍复用既有 `runDeviceControl`（命令段只此一份），
 *      本模块只管"把命令变成一次 MQTT 发布 + 等回执"。
 *   ③ **发现**：`mqttDiscoveryIo(opts)` 订阅发现主题，把保留载荷交给上面的纯映射，再喂既有
 *      `startDeviceDiscovery(db, { io })` 落账（落账/幂等/授权语义**全在** `device-registry.ts`，此处不重写）。
 *
 * ⚠ **真网络只走惰性 import**（承 `device-discovery.ts` 范式）：真客户端 `mqtt` 只在 `defaultMqttIo()` /
 *   发现 io 内 `await import('mqtt')`——受控回归注入假 IO 时**不触网**、模块图**不拉** `mqtt`。
 *   **缺客户端 ⇒ 如实回"未安装"**，不假装成功。
 * ⚠ 本模块**零运行期依赖**（静态只有 `import type` + 复用 discovery 的 `deriveDeviceKind`）。
 * ⚠ **出站对象是 broker 不是设备** ⇒ SSRF 围栏由调用方核 `mqttBrokerHost(dev.address)`（`tools/device.ts`），
 *   本模块**不另设**围栏（一处真源，防两把尺）。
 * ⚠ 设备自述（保留载荷）**可被伪造**——与 SSDP/TXT 同等对待：只如实呈现、不预设（P7 庄子·不预设）。
 */
import type { AnsDevice, DiscoveredDevice } from './device-registry.js';
import type { DeviceControlResult } from './tools/device.js';
import { deriveDeviceKind, type DiscoveryIo } from './device-discovery.js';

/** 台账地址分隔符：`<brokerHost>#<deviceId>`——去重键 `protocol + address` **须含设备身份**，
 *  否则同一 broker 上的多台设备会在台账里撞成一行。 */
export const MQTT_ADDR_SEP = '#';

/** 发现主题缺省值（设备在此**保留发布**自述 JSON；可在设备页改）。 */
export const DEFAULT_DISCOVERY_TOPIC = 'workerant/discovery/#';

export const DEFAULT_MQTT_PORT = 1883;

/** 等设备回状态/回执的窗口；超时即以 broker PUBACK 为准（如实说明"设备未回状态"）。 */
const STATE_WAIT_MS = 3000;
const CONNECT_TIMEOUT_MS = 5000;

// ==================== 纯映射（零 I/O） ====================

/** 台账地址：`broker#deviceId`（broker 供连接，deviceId 供区分）。 */
export function mqttAddress(brokerHost: string, deviceId: string): string {
  return `${brokerHost}${MQTT_ADDR_SEP}${deviceId}`;
}

/** 由台账地址取 broker 主机（非 MQTT 约定地址则原样返回——"没找到分隔符"不等于"没有主机"）。 */
export function mqttBrokerHost(address: string): string {
  const i = address.indexOf(MQTT_ADDR_SEP);
  return i >= 0 ? address.slice(0, i) : address;
}

/** 由台账地址取设备标识。 */
export function mqttDeviceId(address: string): string {
  const i = address.indexOf(MQTT_ADDR_SEP);
  return i >= 0 ? address.slice(i + 1) : address;
}

/** 主题段归一：`/`、`+`、`#`（通配符）与控制字符一律换 `_`，防设备自述把命令发到别人的主题上。 */
export function mqttTopicSegment(raw: string): string {
  const t = String(raw ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return t || 'device';
}

/** MQTT 设备在发现主题上**保留发布**的自述文档（设备自己写，本机不预设）。 */
export interface MqttDiscoveryDoc {
  id?: string;
  name?: string;
  kind?: string;
  /** 命令主题（设备自述）；缺省由 id 派生 `<id>/set`。 */
  cmd?: string;
  /** 状态/回执主题（设备自述，可选）——有则在控制后等它回一条。 */
  state?: string;
  model?: string;
}

/**
 * 保留载荷 → `DiscoveredDevice`。**认不出即 `null`**（非 JSON / 非对象 ⇒ 不入账，不硬塞）。
 * 能力一律取自**自述**：`capabilities` 记 `cmd:<主题>` / `state:<主题>`，`kind` 经既有
 * `deriveDeviceKind` 归粗类（与 mDNS/SSDP **同一把尺**——认不出的自述归 `unknown`，不猜）。
 */
export function mqttDiscoveryToDevice(
  topic: string,
  raw: string,
  brokerHost: string,
  brokerPort: number | null,
): DiscoveredDevice | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as MqttDiscoveryDoc;
  const lastSegment = topic.split('/').filter(Boolean).pop() ?? '';
  const id = mqttTopicSegment(String(d.id ?? lastSegment));
  const cmd = typeof d.cmd === 'string' && d.cmd.trim() ? d.cmd.trim() : `${id}/set`;
  const capabilities = ['mqtt', `cmd:${cmd}`];
  if (typeof d.state === 'string' && d.state.trim()) capabilities.push(`state:${d.state.trim()}`);
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : id;
  return {
    name,
    kind: deriveDeviceKind(`${d.kind ?? ''} ${d.model ?? ''} ${id}`),
    protocol: 'mqtt',
    address: mqttAddress(brokerHost, id),
    port: brokerPort,
    capabilities,
    // 自述带命令主题 ⇒ 设备自称可被命令（与 mDNS/SSDP 的"自述线索"同一判法）。
    controllable: true,
  };
}

/** 命令主题：优先取自述 `cmd:` 能力；缺省 `<deviceId>/set`。 */
export function mqttCommandTopic(dev: AnsDevice): string {
  const declared = dev.capabilities.find((c) => c.startsWith('cmd:'));
  return declared ? declared.slice('cmd:'.length) : `${mqttTopicSegment(mqttDeviceId(dev.address))}/set`;
}

/** 命令载荷：`{action, ...args}` 的 JSON（动作名与参数一体，设备侧只读一个 topic）。 */
export function mqttCommandPayload(action: string, args: Record<string, unknown>): string {
  return JSON.stringify({ action, ...args });
}

// ==================== HA 语言的下行载荷（zx_20261015_3 批二 · 维特根斯坦·意义即用法） ====================
//
// ⚠ 此处只放**下行**（命令载荷）；HA 的**上行**（discovery 配置 → 设备）在 `device-homeassistant.ts`。
//   两者同属"MQTT 载荷/主题"这一层，故载荷不另设文件——且这样 `device-mqtt.ts` **不** import `ha` 模块
//   （依赖**单向** ha → mqtt，无 `mqtt ⇄ ha` 环）。

/** ON/OFF 型 component（HA 标准下行：`ON`/`OFF`）。 */
const HA_TOGGLE_COMPONENTS: ReadonlySet<string> = new Set([
  'light', 'switch', 'fan', 'input_boolean', 'siren', 'automation', 'humidifier', 'media_player', 'water_heater',
]);

/** 由 `capabilities` 取 `ha:<component>`（非 HA 设备 ⇒ `null`）。 */
export function haComponentOf(dev: { capabilities: string[] }): string | null {
  const c = dev.capabilities.find((x) => x.startsWith('ha:'));
  return c ? c.slice('ha:'.length) : null;
}

/** 由 `capabilities` 取某前缀的自述值（`on:`/`off:` 载荷覆盖等）。 */
function capValue(dev: { capabilities: string[] }, prefix: string): string | null {
  const c = dev.capabilities.find((x) => x.startsWith(prefix));
  return c ? c.slice(prefix.length) : null;
}

/**
 * HA 语言的**下行载荷**（维特根斯坦·意义即用法）：必须按 **HA 的约定**回话——
 *   · ON/OFF 型（light/switch/fan/…）：`turn_on`→`ON`、`turn_off`→`OFF`、`toggle`→`TOGGLE`
 *     （载荷取设备自述 `on:`/`off:`，缺省 `ON`/`OFF`）；带参数 ⇒ JSON `{"state":"ON", …args}`。
 *   · cover：`open`→`OPEN`、`close`→`CLOSE`、`stop`→`STOP`（带参数 ⇒ JSON `{"state":…, …args}`）。
 *   · 其余/认不出 ⇒ **逐字回退**工蚁自有形 `{action, …args}`（如实降级，不阻命令）。
 * 非 HA 设备（无 `ha:` 能力）⇒ `null`（由 `deviceCommandPayload` 回退工蚁语言）。
 */
export function haCommandPayload(dev: { capabilities: string[] }, action: string, args: Record<string, unknown>): string | null {
  const component = haComponentOf(dev);
  if (!component) return null;
  const withArgs = (state: string): string => (Object.keys(args).length ? JSON.stringify({ state, ...args }) : state);
  if (HA_TOGGLE_COMPONENTS.has(component)) {
    const on = capValue(dev, 'on:') ?? 'ON';
    const off = capValue(dev, 'off:') ?? 'OFF';
    if (action === 'turn_on' || action === 'on') return withArgs(on);
    if (action === 'turn_off' || action === 'off') return withArgs(off);
    if (action === 'toggle') return withArgs('TOGGLE');
  }
  if (component === 'cover') {
    if (action === 'open') return withArgs('OPEN');
    if (action === 'close') return withArgs('CLOSE');
    if (action === 'stop') return withArgs('STOP');
  }
  // 认不出该 component 的动作 ⇒ 逐字回退工蚁自有形（如实，不猜 HA 的意图）。
  return mqttCommandPayload(action, args);
}

/**
 * 下行载荷的**唯一选路**（一处真源）：HA 设备走 HA 语言，其余走工蚁自有语言。
 * ⚠ 与 `tools/device.ts` 的 `defaultDeviceControl`（**传动**选路）**对象不同**：那里选"哪条**传输**"，
 *   这里选"哪种**语言**"——不是两把尺（**两个对象**）。
 */
export function deviceCommandPayload(dev: { capabilities: string[] }, action: string, args: Record<string, unknown>): string {
  return haCommandPayload(dev, action, args) ?? mqttCommandPayload(action, args);
}

/** broker URL（端口缺省 1883）。 */
export function mqttBrokerUrl(dev: AnsDevice): string {
  return `mqtt://${mqttBrokerHost(dev.address)}:${dev.port ?? DEFAULT_MQTT_PORT}`;
}

/** 成功回执的人话（**独立具名** ⇒ rr 逐字钉，防措辞悄漂）。 */
export function mqttResultText(topic: string, ack: string | null): string {
  return ack
    ? `MQTT 已下发 ${topic}；设备回执：${ack.slice(0, 500)}`
    : `MQTT 已下发 ${topic}（broker 已回执 PUBACK，设备未在 ${Math.round(STATE_WAIT_MS / 1000)}s 内回状态）`;
}

/** 客户端缺席的人话（**如实**：说"没装"，不说"操作失败"）。 */
export function mqttAbsentText(): string {
  return '本机未安装 MQTT 客户端（`mqtt`）——该设备暂不可经本机控制（如实告知，不假装成功）。';
}

/** 失败人话（原因原样带上，不吞）。 */
export function mqttFailureText(reason: string): string {
  return `MQTT 下发失败：${reason}`;
}

// ==================== 配置解析（纯函数，取数由调用方注入） ====================

export interface MqttConfig {
  /** **开且配了 broker** 才算启用（缺 broker 的"开"没有意义）。 */
  enabled: boolean;
  broker: { host: string; port: number | null } | null;
  discoveryTopic: string;
}

/** MQTT 配置的**只读**上屏形状（面板如实显示"装了没/配了没"；勿在 IPC 层另立一份）。 */
export interface MqttStatusPayload {
  enabled: boolean;
  broker: string | null;
  discoveryTopic: string;
  /** `mqtt` 客户端模块是否可用（未安装 ⇒ 面板如实说"MQTT 客户端未安装"）。 */
  clientAvailable: boolean;
  /**
   * zx_20261015_3 批四: **HA 标准桥**态（只读上屏）。
   * ⚠ broker **与 MQTT 卡共用**（HA 的 Mosquitto add-on 就是那个 broker）——故此处不重复回 broker，只回开关与前缀。
   * ⚠ 形状就地声明（**不** import `device-homeassistant.ts`——那会造 `mqtt ⇄ ha` 环；依赖单向 ha → mqtt）。
   */
  ha: { enabled: boolean; prefix: string };
}

/**
 * `host[:port]`（可带 `mqtt://` 前缀）→ `{host, port}`。认不出 ⇒ `null`。
 * IPv6 字面量按 `[::1]:1883` 写法支持（方括号去掉）。
 */
export function parseMqttBroker(raw: unknown): { host: string; port: number | null } | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let rest = s;
  let scheme: string | null = null;
  const m = /^(mqtts?|wss?):\/\//i.exec(rest);
  if (m) {
    scheme = m[1].toLowerCase();
    rest = rest.slice(m[0].length);
  }
  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(0, slash);
  let host = rest;
  let port: number | null = null;
  const c = rest.lastIndexOf(':');
  if (c > 0) {
    const p = Number(rest.slice(c + 1));
    if (Number.isInteger(p) && p > 0 && p <= 65535) {
      host = rest.slice(0, c);
      port = p;
    }
  }
  host = host.replace(/^\[|\]$/g, '').trim();
  if (!host) return null;
  if (port == null) port = scheme === 'mqtts' || scheme === 'wss' ? 8883 : DEFAULT_MQTT_PORT;
  return { host, port };
}

/**
 * 由取数函数解析 MQTT 配置（**不碰 DB** ⇒ rr 直跑真判据）。
 * `device.mqtt.enabled` 是**缺省关**的键（连 broker 是可被察觉的网络行为，须人显式开）——
 * 故**刻意不用** `boolSetting`（那族是"缺省即开"，`settings-bool.ts` 已明言两族不并）。
 */
export function resolveMqttConfig(get: (key: string) => string | null | undefined): MqttConfig {
  const rawEnabled = String(get('device.mqtt.enabled') ?? '').trim().toLowerCase();
  const broker = parseMqttBroker(get('device.mqtt.broker'));
  const discoveryTopic = String(get('device.mqtt.discovery_topic') ?? '').trim() || DEFAULT_DISCOVERY_TOPIC;
  return {
    enabled: (rawEnabled === '1' || rawEnabled === 'true' || rawEnabled === 'on') && broker != null,
    broker,
    discoveryTopic,
  };
}

// ==================== 控制（可注入 IO） ====================

export interface MqttPublishResult {
  ok: boolean;
  /** `ok:false` 时的原因（必填，不吞）。 */
  error?: string;
  /** 设备自述 `state` 主题在窗口内回的第一条原文；未回 / 未自述 ⇒ `null`。 */
  ack?: string | null;
}

/** MQTT 传输的**可注入**接口（真客户端 vs 受控回归假实现同形）。 */
export interface MqttIo {
  publish(dev: AnsDevice, topic: string, payload: string): Promise<MqttPublishResult>;
}

/** 真客户端的**所用窄面**（本地声明，不引 `mqtt` 类型——同 `device-discovery.ts` 的 `MdnsService` 手法）。
 *  ⚠ **导出仅为受控回归**能装一台同形假客户端来跑下面那条真控制路径（不触网、不依赖 `mqtt` 装没装）。 */
export interface MqttClientLike {
  connected: boolean;
  on(ev: string, cb: (...args: unknown[]) => void): void;
  removeListener?(ev: string, cb: (...args: unknown[]) => void): void;
  publish(topic: string, payload: string, opts: Record<string, unknown>, cb: (err?: Error) => void): void;
  subscribe(topic: string, opts: Record<string, unknown>): void;
  /** 退订（真 `mqtt` 客户端本就有；**可选** ⇒ 假客户端不实现也不编译错，退化为只卸本地监听）。 */
  unsubscribe?(topic: string, opts?: Record<string, unknown>): unknown;
  end(force?: boolean): void;
}
type MqttConnectFn = (url: string, opts?: Record<string, unknown>) => MqttClientLike;

const clients = new Map<string, MqttClientLike>();

/**
 * 关停**控制路径**的连接并清表（zx_20261016_1 批一 · D3）。
 * 病：`clients` 里的连接**从不关停**（进程退出后 broker 侧 `clients/connected` 不回落）。
 * ⚠ 与**发现路径**无关：`openSubscriber` 用独立连接、其 `stop()` 已自行 `end(true)`——本函数不碰。
 */
export function closeMqttClients(): void {
  for (const c of clients.values()) { try { c.end(true); } catch { /* 已断/已关 */ } }
  clients.clear();
}

/**
 * 复用连接表的**本体**——**仅受控回归**可读写（生产代码只经 `clientFor` / `closeMqttClients` 访问）。
 * 导出的理由：K-5 要真装一台假客户端进表、再真跑 `closeMqttClients()` 看它有没有被 `end` 掉。
 */
export const __mqttClientsForTest = clients;

/**
 * 惰性取 `mqtt` 的 `connect`。**未安装 ⇒ `null`**（如实缺席——不 throw 到调用面，
 * 那会让"没装客户端"看起来像"控制失败"）。
 */
async function loadConnect(): Promise<MqttConnectFn | null> {
  try {
    const mod = (await import('mqtt')) as unknown as { connect?: MqttConnectFn; default?: { connect?: MqttConnectFn } };
    return mod.connect ?? mod.default?.connect ?? null;
  } catch {
    return null;
  }
}

/** `mqtt` 客户端是否可用（面板如实显示"未安装"用）。**不触网**——只看模块在不在。 */
export async function mqttClientAvailable(): Promise<boolean> {
  return (await loadConnect()) != null;
}

async function connectOnce(connect: MqttConnectFn, url: string): Promise<MqttClientLike> {
  const client = connect(url, {
    connectTimeout: CONNECT_TIMEOUT_MS,
    reconnectPeriod: 0,
    clientId: `worker-ant-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  });
  await new Promise<void>((resolve, reject) => {
    if (client.connected) return resolve();
    const t = setTimeout(() => reject(new Error(`连接 broker 超时（${CONNECT_TIMEOUT_MS}ms）`)), CONNECT_TIMEOUT_MS);
    client.on('connect', () => { clearTimeout(t); resolve(); });
    client.on('error', (e) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
  return client;
}

/** 按 broker URL 复用连接（断了即摘掉重建——不留半死的 client 在表里）。 */
async function clientFor(url: string): Promise<MqttClientLike | null> {
  const cached = clients.get(url);
  if (cached) {
    if (cached.connected) return cached;
    try { cached.end(true); } catch { /* 已断 */ }
    clients.delete(url);
  }
  const connect = await loadConnect();
  if (!connect) return null;
  const client = await connectOnce(connect, url);
  clients.set(url, client);
  return client;
}

/**
 * 控制路径的 `state` 订阅**引用计数**（zx_20261016_1 批一 · D2）。
 *
 * 病：一条控制命令订一个 `state` 主题，命令结束后只卸本地监听、**从不退订** ⇒ broker 侧订阅**只增不减**
 *   （`zx_20261015_3` §四.8 实测：桌面留下 1 条残留，`$SYS/broker/subscriptions/count` 随控制次数涨）。
 * 治：**同主题并发共享一次订阅**，计数归零才真退订——计数恒等于"此刻在等这条主题的调用数"。
 * ⚠ `WeakMap` 而非普通 `Map`：键是活连接，连接没了账自然消失（不另留一份要手动清的账）。
 * ⚠ 订阅**只在计数 0→1 时**发（幂等）；退订只在 1→0 时发 ⇒ 同主题两条并发是 `acq,acq,rel,rel`，零竞态。
 */
const stateSubRefs = new WeakMap<MqttClientLike, Map<string, number>>();

function acquireStateSub(client: MqttClientLike, topic: string): void {
  let per = stateSubRefs.get(client);
  if (!per) { per = new Map<string, number>(); stateSubRefs.set(client, per); }
  const n = per.get(topic) ?? 0;
  per.set(topic, n + 1);
  if (n === 0) { try { client.subscribe(topic, { qos: 1 }); } catch { /* 订阅失败 ⇒ 退化为只等 broker 回执 */ } }
}

function releaseStateSub(client: MqttClientLike, topic: string): void {
  const per = stateSubRefs.get(client);
  const n = per?.get(topic) ?? 0;
  if (!per || n <= 0) return;
  if (n > 1) { per.set(topic, n - 1); return; }
  per.delete(topic);
  try { client.unsubscribe?.(topic); } catch { /* 已退订/客户端不支持，忽略 */ }
}

/**
 * 发布并等回执：QoS 1 ⇒ broker PUBACK 即**最小回执**；若设备自述了 `state` 主题，再等它一条
 * （窗口 `STATE_WAIT_MS`，超时以 broker 回执为准并**如实说明**设备没回）。
 * ⚠ 导出仅为受控回归能喂同形假客户端直跑本函数（真实现只此一份，不另写一条判据版）。
 */
export function publishAndAwaitState(client: MqttClientLike, dev: AnsDevice, topic: string, payload: string): Promise<MqttPublishResult> {
  return new Promise<MqttPublishResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stateTopic = dev.capabilities.find((c) => c.startsWith('state:'))?.slice('state:'.length) ?? null;

    function finish(r: MqttPublishResult): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stateTopic) {
        try { client.removeListener?.('message', onMessage); } catch { /* 已卸 */ }
        // 卸本地监听与退 broker 订阅是**两件事**（前者管"别再叫我"，后者管"别再送来"）——两者都要。
        releaseStateSub(client, stateTopic);
      }
      resolve(r);
    }
    function onMessage(t: unknown, buf: unknown): void {
      // 「同声相应」（周易·乾·文言）：复用的连接上会流过**别的**主题（他设备的 `state`、上一轮的残留订阅）——
      // 只有**本次订阅的那个主题**才算这次的回执；否则隔壁一响就把这次判成"设备已回执"（假回执）。
      if (String(t) !== stateTopic) return;
      finish({ ok: true, ack: String(buf ?? '').slice(0, 2000) });
    }

    if (stateTopic) {
      client.on('message', onMessage);
      acquireStateSub(client, stateTopic);
      timer = setTimeout(() => finish({ ok: true, ack: null }), STATE_WAIT_MS);
    }
    client.publish(topic, payload, { qos: 1 }, (err?: Error) => {
      if (err) { finish({ ok: false, error: `broker 拒收：${err.message}` }); return; }
      if (!stateTopic) finish({ ok: true, ack: null });
    });
  });
}

/** 真 MQTT IO；**未安装客户端 ⇒ `null`**（`mqttDeviceControl` 据此如实回"未安装"）。 */
export async function defaultMqttIo(): Promise<MqttIo | null> {
  const connect = await loadConnect();
  if (!connect) return null;
  return {
    async publish(dev, topic, payload) {
      const url = mqttBrokerUrl(dev);
      let client: MqttClientLike | null;
      try {
        client = await clientFor(url);
      } catch (e) {
        return { ok: false, error: `连接 broker ${url} 失败：${(e as Error)?.message || String(e)}` };
      }
      if (!client) return { ok: false, error: '本机未安装 MQTT 客户端（`mqtt`）' };
      return publishAndAwaitState(client, dev, topic, payload);
    },
  };
}

/**
 * MQTT 命令下发。**编排不在此**——闸/审计/状态/事件仍在 `runDeviceControl`（一处真源）；
 * 本函数只做"命令 → 一次发布 → 结果人话"。
 */
export async function mqttDeviceControl(
  dev: AnsDevice,
  action: string,
  args: Record<string, unknown>,
  io?: MqttIo,
): Promise<DeviceControlResult> {
  const topic = mqttCommandTopic(dev);
  // 下行**语言**选路（一处真源）：HA 设备回 HA 约定载荷，其余回工蚁自有形——`haCommandPayload` 认不出即回退。
  const payload = deviceCommandPayload(dev, action, args);
  let client: MqttIo | null;
  try {
    client = io ?? (await defaultMqttIo());
  } catch {
    client = null;
  }
  if (!client) return { ok: false, result: mqttAbsentText() };
  let r: MqttPublishResult;
  try {
    r = await client.publish(dev, topic, payload);
  } catch (e) {
    return { ok: false, result: mqttFailureText((e as Error)?.message || String(e)) };
  }
  if (!r.ok) return { ok: false, result: mqttFailureText(r.error || '未知原因') };
  return { ok: true, result: mqttResultText(topic, r.ack ?? null) };
}

// ==================== 发现（可注入订阅面） ====================

/** 订阅面的**可注入**接口（受控回归喂假实现 ⇒ 不触网）。 */
export interface MqttSubscribeIo {
  subscribe(topic: string, onMessage: (topic: string, payload: string) => void): void;
  stop(): void;
}

export interface MqttDiscoveryOpts {
  /** broker 主机（成为台账地址前缀）。 */
  brokerHost: string;
  brokerPort?: number | null;
  discoveryTopic?: string;
  /** 可注入订阅面；缺省惰性 `import('mqtt')` 真订阅。 */
  io?: MqttSubscribeIo;
  /** 连接/订阅失败**如实上报**（面板可显示）；缺省静默降级为"无 MQTT 发现"。 */
  onError?: (msg: string) => void;
}

/**
 * `subscribeIo` 的入参：发现订阅中**与"语言"无关**的那部分。
 * 「语言」= 载荷→设备的映射（工蚁自有 JSON vs HA 标准 discovery）；连接/订阅/收摊**同此一处**。
 */
export interface SubscribeIoOpts {
  /** 订阅主题（可含 `#` 通配）。 */
  topic: string;
  /** 载荷 → 设备（**认不出即 `null`**）；各发现语言各供各的（`mqttDiscoveryToDevice` / `haConfigToDevice`）。 */
  map: (topic: string, payload: string, brokerHost: string, brokerPort: number | null) => DiscoveredDevice | null;
  brokerHost: string;
  brokerPort?: number | null;
  /** 可注入订阅面；缺省惰性 `import('mqtt')` 真订阅。 */
  io?: MqttSubscribeIo;
  /** 连接/订阅失败**如实上报**（面板可显示）；缺省静默降级。 */
  onError?: (msg: string) => void;
}

/** 可**多次订阅**的订阅面（动态主题用：HA 可用性主题须待发现后才知）；`stop()` 幂等收摊。 */
export interface MqttSubscriber {
  subscribe(topic: string, onMessage: (topic: string, payload: string) => void): void;
  stop(): void;
}

export interface MqttSubscriberOpts {
  brokerHost: string;
  brokerPort?: number | null;
  /** 可注入订阅面；缺省惰性 `import('mqtt')` 真订阅。 */
  io?: MqttSubscribeIo;
  /** 连接/订阅失败**如实上报**（面板可显示）；缺省静默降级。 */
  onError?: (msg: string) => void;
}

/**
 * **订阅的共用骨**（DRY）：惰性连 broker（或注入假 io）/ 多次订阅 / `stop` 收摊**只此一份**——
 * 工蚁自有发现与 HA 标准发现**同走这一路**，防"同一段连接代码两处"日后各修各的。
 * ⚠ 真路径**异步连上前的订阅缓冲**在 `subs`，连上后一次性补订；此后新订阅即时补订。
 * ⚠ 消息**全量分发**给所有订阅者，**各消费者各认各的主题**（此骨不代筛——HA 的通配与工蚁自有主题同走一路）。
 */
export function openSubscriber(opts: MqttSubscriberOpts): MqttSubscriber {
  const brokerHost = opts.brokerHost;
  const brokerPort = opts.brokerPort ?? null;
  const subs: Array<{ topic: string; cb: (t: string, p: string) => void }> = [];
  let stopped = false;
  let client: MqttClientLike | null = null;
  let realReady = false;

  // 注入假 io：订阅**即时**生效（同步），不触网。
  if (opts.io) {
    const fake = opts.io;
    return {
      subscribe(topic, onMessage) {
        if (stopped) return;
        subs.push({ topic, cb: onMessage });
        try {
          fake.subscribe(topic, onMessage);
        } catch (e) {
          opts.onError?.(`MQTT 发现订阅失败：${(e as Error)?.message || String(e)}`);
        }
      },
      stop() {
        stopped = true;
        try { fake.stop(); } catch { /* 已停 */ }
      },
    };
  }

  // 真路径：惰性连接；连上的订阅一次补订，其后新订阅即时补订。
  void (async () => {
    try {
      const connect = await loadConnect();
      if (!connect) {
        opts.onError?.('本机未安装 MQTT 客户端（`mqtt`）——MQTT 发现不可用。');
        return;
      }
      if (stopped) return;
      const c = await connectOnce(connect, `mqtt://${brokerHost}:${brokerPort ?? DEFAULT_MQTT_PORT}`);
      if (stopped) { try { c.end(true); } catch { /* 收摊噪声 */ } return; }
      client = c;
      c.on('message', (t, buf) => {
        if (stopped) return;
        const ts = String(t ?? '');
        const ps = String(buf ?? '');
        for (const s of subs) {
          try { s.cb(ts, ps); } catch { /* 单个消费者失败：不拖垮其他 */ }
        }
      });
      for (const s of subs) { try { c.subscribe(s.topic, { qos: 1 }); } catch { /* 单主题订阅失败：其余照订 */ } }
      realReady = true;
    } catch (e) {
      opts.onError?.(`连接 MQTT broker 失败：${(e as Error)?.message || String(e)}`);
    }
  })();

  return {
    subscribe(topic, onMessage) {
      if (stopped) return;
      subs.push({ topic, cb: onMessage });
      if (realReady && client) { try { client.subscribe(topic, { qos: 1 }); } catch { /* 补订失败：如实由 onError 之外沉默 */ } }
    },
    stop() {
      stopped = true;
      try { client?.end(true); } catch { /* 收摊噪声 */ }
      client = null;
    },
  };
}

/**
 * **发现订阅的薄壳**（承 `openSubscriber`）：单一主题 + 载荷→设备映射 → 交 `onFound`。
 * 差别只在 `map`（上行载荷→设备）；连接/订阅/收摊在 `openSubscriber`（一处真源）。
 */
export function subscribeIo(opts: SubscribeIoOpts): DiscoveryIo {
  const brokerHost = opts.brokerHost;
  const brokerPort = opts.brokerPort ?? null;
  let stopped = false;
  let sub: MqttSubscriber | null = null;

  return {
    start(onFound) {
      const emit = (t: string, payload: string): void => {
        if (stopped) return;
        const dev = opts.map(t, payload, brokerHost, brokerPort);
        if (!dev) return; // 认不出 ⇒ 跳过（不硬塞）
        try { onFound(dev); } catch { /* 单条上报失败：忽略 */ }
      };
      sub = openSubscriber({ brokerHost, brokerPort, io: opts.io, onError: opts.onError });
      sub.subscribe(opts.topic, emit);
    },
    stop() {
      stopped = true;
      try { sub?.stop(); } catch { /* 收摊噪声 */ }
      sub = null;
    },
  };
}

/**
 * MQTT 发现 io：订阅发现主题 → 保留载荷经纯映射 → 交 `onFound`（再进 `upsertDiscovered` 落账）。
 * 一切**自述**，本 io 不预判；单条载荷认不出**跳过**，不拖垮整轮。
 * ⚠ 本函数 = `subscribeIo` + **工蚁自有语言**映射的薄壳——**签名与行为逐字不变**（HA 桥走 `subscribeIo` + `haConfigToDevice`）。
 */
export function mqttDiscoveryIo(opts: MqttDiscoveryOpts): DiscoveryIo {
  return subscribeIo({
    topic: opts.discoveryTopic || DEFAULT_DISCOVERY_TOPIC,
    map: mqttDiscoveryToDevice,
    brokerHost: opts.brokerHost,
    brokerPort: opts.brokerPort ?? null,
    io: opts.io,
    onError: opts.onError,
  });
}
