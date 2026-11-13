/**
 * zx_20261004 M7（庄子·齐物论「不预设」/ 管子·度量衡）: 局域网设备**自动发现**——mDNS 浏览 + SSDP `M-SEARCH`。
 *
 * 分工（与 `device-registry.ts` 划清）：
 *   · 本文件只管 **发现与落账**；台账的幂等/授权/审计语义全在 `device-registry.ts`（此处不重写一份）。
 *   · **能力自述**（庄子·不预设）：设备的 `kind`/`capabilities`/`controllable` **一律取自它自报的**
 *     service type、TXT 记录与 SSDP 头部——不自造、不猜（猜错的"能力"比"未知"更坏：模型会照着做）。
 *
 * ⚠ **真网络不可入 rr**（承 §3）：一切 I/O 走**可注入**的 `DiscoveryIo`。
 *   真实现（`bonjour-service` / `node-ssdp`）只在 `defaultDiscoveryIo()` 里**惰性 `import`**——
 *   rr 注入假 IO 时既**不触网**，模块图也**不拉**这两个依赖。真网络只走实机 E2E。
 * ⚠ 发现**不等于授权**：落账的 `authorized` 恒为 false（K-6），用户须在面板显式开启（M9）。
 */
import type { AnsDevice, DeviceDb, DiscoveredDevice } from './device-registry.js';
import { findDeviceByIdentity, upsertDiscovered } from './device-registry.js';
import { lanAddressRefusal } from './device-address.js';
import type { SsdpHeaders } from 'node-ssdp';

/** 发现 IO 的**可注入**接口——真网络与受控回归跑的是同一个 `startDeviceDiscovery` 主体。 */
export interface DiscoveryIo {
  /** 开始监听；每发现一台设备调用一次 `onFound`（重复发现由落账侧幂等收束）。 */
  start(onFound: (dev: DiscoveredDevice) => void): void;
  /** 停止监听并释放 socket。 */
  stop(): void;
}

/**
 * 默认 mDNS 浏览的服务类型（bonjour-service 的 `type` 不带 `_tcp` 后缀）。
 * zx_20261107_1 B1：从单一 `http` 扩到常见局域网设备自述——仍只认**自述**，不按品牌猜。
 */
export const MDNS_SERVICE_TYPES: readonly string[] = ['http', 'hap', 'esphomelib', 'home-assistant'];

/** SSDP 描述文档里我们真正用得到的字段（不认识的一律不猜）。 */
export interface DeviceDescription {
  friendlyName?: string;
  modelName?: string;
  deviceType?: string;
  manufacturer?: string;
}

/** 从 UPnP 描述 XML 里取少量自述字段；解析失败/缺字段即缺省，不伪造。 */
export function parseDeviceDescription(xml: string): DeviceDescription {
  const pick = (tag: string): string | undefined => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
    const v = m?.[1]?.trim();
    return v ? v.slice(0, 200) : undefined;
  };
  return {
    friendlyName: pick('friendlyName'),
    modelName: pick('modelName'),
    deviceType: pick('deviceType'),
    manufacturer: pick('manufacturer'),
  };
}

export interface DiscoveryOpts {
  /** 发现器；缺省走真网络（mDNS + SSDP）。 */
  io?: DiscoveryIo;
  /** 落账后回调（接线据此发 `device.discovered` / `device.status_changed`）。 */
  onDiscovered?: (dev: AnsDevice, info: { isNew: boolean }) => void;
  /** 注入时钟（DB 格式 UTC 串）；缺省 `datetime('now')` 同基准。 */
  now?: () => string;
}

let active: DiscoveryIo | null = null;

/** 是否正在发现（面板据此显示"发现中/已停"）。 */
export function isDiscoveryRunning(): boolean {
  return active != null;
}

/**
 * 起发现。可重复调用（先停旧的，避免多份 socket 叠加）。
 * 单条设备落账失败**不影响其余**（一台烂广播不能拖垮整轮发现）。
 */
export function startDeviceDiscovery(db: DeviceDb, opts: DiscoveryOpts = {}): void {
  stopDeviceDiscovery();
  const io = opts.io ?? defaultDiscoveryIo();
  active = io;
  io.start((dev) => {
    try {
      const isNew = findDeviceByIdentity(db, dev.protocol, dev.address) == null;
      const row = upsertDiscovered(db, dev, opts.now ? opts.now() : undefined);
      // zx_20261030_1 M5：容量到顶 ⇒ 首次发现未落库（返回 null）；如实跳过这台，不回调"新发现"。
      if (row) opts.onDiscovered?.(row, { isNew });
    } catch {
      /* 单条落账失败：如实跳过（不静默吞整轮，也不因此崩掉发现器） */
    }
  });
}

/**
 * 并联多路发现（zx_20261013_1 批五）: 现 `startDeviceDiscovery` 只容**一路** io，
 * 而 MQTT 发现须与 mDNS/SSDP **并跑** ⇒ 此处把多路收成一个 io（单路起不来不影响其余）。
 */
export function composeDiscoveryIo(...ios: DiscoveryIo[]): DiscoveryIo {
  return {
    start(onFound) {
      for (const io of ios) {
        try { io.start(onFound); } catch { /* 单路起不来：其余照跑 */ }
      }
    },
    stop() {
      for (const io of ios) {
        try { io.stop(); } catch { /* 收摊噪声 */ }
      }
    },
  };
}

/** 停发现并释放资源（幂等）。 */
export function stopDeviceDiscovery(): void {
  if (!active) return;
  const io = active;
  active = null;
  try {
    io.stop();
  } catch {
    /* 释放失败属正常收摊噪声 */
  }
}

// ==================== 真实现（惰性 import；只在未注入 io 时走到） ====================

/** mDNS service 的**所用窄面**（bonjour-service 是 `export =` 类，取它的类型反而绕，故本地声明）。 */
interface MdnsService {
  name?: string;
  type?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  referer?: { address?: string };
  txt?: Record<string, unknown>;
}
interface MdnsBrowser {
  on(ev: 'up', cb: (svc: MdnsService) => void): void;
  stop(): void;
}
interface MdnsBonjourCtor {
  new (): { find(opts: { type: string }): MdnsBrowser; destroy(): void };
}

/** 自述里的"可控"线索（TXT 键 / service type 命中即认为设备自称可被命令）。 */
const CONTROL_HINT_RE = /(control|cmd|command|action|switch|state|set|toggle)/i;

function hasControlHint(texts: Array<string | undefined>): boolean {
  return texts.some((t) => typeof t === 'string' && CONTROL_HINT_RE.test(t));
}

/**
 * 由**自述文本**归一个粗类（认不出即 `unknown`——不硬塞）。
 * zx_20261029_2 M1: 补上舒适意图真正用得着的四类（窗帘/空调/风扇/扫地机）——
 *   此前 mDNS/SSDP 只认 light/switch/sensor 等，窗帘与空调一律落到 `unknown`，意图链走不通。
 * ⚠ 只读**自述** service type / TXT 键，不读设备名字（庄子·不预设）。
 */
export function deriveDeviceKind(text: string): string {
  const t = text.toLowerCase();
  if (/(lock|doorlock|\bdoor\b|garage|\bgate\b|\bsafe\b|alarm|security)/.test(t)) return 'lock';
  if (/(camera|\bcam\b|ipcam)/.test(t)) return 'camera';
  if (/(curtain|blind|shade|window.?cover|\bcover\b)/.test(t)) return 'curtain';
  if (/(aircon|air.?condition|climate|hvac)/.test(t)) return 'aircon';
  if (/(light|\blamp\b|bulb|dimmer)/.test(t)) return 'light';
  if (/(\bfan\b|ventilat)/.test(t)) return 'fan';
  if (/(switch|relay|socket|plug|outlet)/.test(t)) return 'switch';
  if (/(sensor|\btemp\b|humid|thermo|meter|probe)/.test(t)) return 'sensor';
  if (/(speaker|audio|\bmedia\b|music|sound)/.test(t)) return 'speaker';
  if (/(display|\bscreen\b|\btv\b|monitor)/.test(t)) return 'display';
  if (/(vacuum|robot.?clean|sweeper)/.test(t)) return 'vacuum';
  if (/(printer|scanner)/.test(t)) return 'printer';
  return 'unknown';
}

export function mdnsToDiscovered(svc: MdnsService): DiscoveredDevice | null {
  const address = svc.referer?.address || svc.addresses?.[0] || svc.host;
  if (!address) return null;
  const txtKeys = svc.txt && typeof svc.txt === 'object' ? Object.keys(svc.txt) : [];
  // zx_20261107_1 B1：TXT 的**值**也是设备自述（HA/HAP 常把型号放 md/mdl），归类别时一并读；
  //   仍只读自述，不按品牌猜。
  const txtValues = svc.txt && typeof svc.txt === 'object'
    ? Object.values(svc.txt).filter((v): v is string => typeof v === 'string')
    : [];
  const capabilities = [svc.type, ...txtKeys].filter((s): s is string => typeof s === 'string' && s.length > 0);
  return {
    name: svc.name || svc.host || address,
    kind: deriveDeviceKind(`${svc.type ?? ''} ${txtKeys.join(' ')} ${txtValues.join(' ')}`),
    protocol: 'mdns',
    address,
    port: typeof svc.port === 'number' ? svc.port : null,
    capabilities,
    controllable: hasControlHint([svc.type, ...txtKeys]),
  };
}

export function ssdpToDiscovered(
  headers: SsdpHeaders,
  address: string,
  description?: DeviceDescription | null,
): DiscoveredDevice | null {
  if (!address) return null;
  const st = typeof headers.ST === 'string' ? headers.ST : '';
  const nt = typeof headers.NT === 'string' ? headers.NT : '';
  const server = typeof headers.SERVER === 'string' ? headers.SERVER : '';
  let port: number | null = null;
  if (typeof headers.LOCATION === 'string') {
    try {
      const p = new URL(headers.LOCATION).port;
      port = p ? Number(p) : null;
    } catch {
      /* LOCATION 不是合法 URL：端口如实留 null */
    }
  }
  const descText = description
    ? [description.deviceType, description.modelName, description.manufacturer].filter(Boolean).join(' ')
    : '';
  const capabilities = [st, nt, server, descText].filter((s) => s.length > 0);
  const usn = typeof headers.USN === 'string' ? headers.USN : '';
  return {
    name: description?.friendlyName || server || st || usn || address,
    kind: deriveDeviceKind(`${st} ${nt} ${server} ${descText}`),
    protocol: 'ssdp',
    address,
    port,
    capabilities,
    controllable: hasControlHint([st, nt, server, descText]),
  };
}

/**
 * 有界取 SSDP 描述：只对**私网/链路本地**的 `LOCATION` 发一次请求，1.5s 超时、响应截 8192 字符。
 * 任何失败都回 `null`（发现仍可用头部信息），不把发现面变成任意出站通道。
 */
async function fetchDescription(
  location: string,
  fetchImpl: typeof fetch,
): Promise<DeviceDescription | null> {
  try {
    const url = new URL(location);
    if (lanAddressRefusal(url.hostname) != null) return null;
    const res = await fetchImpl(location, {
      method: 'GET',
      signal: AbortSignal.timeout(1_500),
      headers: { Accept: 'text/xml, application/xml' },
    });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 8_192);
    const desc = parseDeviceDescription(text);
    return Object.values(desc).some(Boolean) ? desc : null;
  } catch {
    return null;
  }
}

/** 真 IO 的可注入面（默认值即真网络；rr 不传 ⇒ 不触网）。 */
export interface DefaultDiscoveryIoOpts {
  /** mDNS 服务类型；缺省 `MDNS_SERVICE_TYPES`。 */
  mdnsServiceTypes?: readonly string[];
  /** 描述抓取的 fetch 实现（rr 可注入假实现）。 */
  fetchImpl?: typeof fetch;
}

/** 真 IO：mDNS（bonjour-service）+ SSDP（node-ssdp）。任一路不可用**如实降级**为只剩另一路。
 *  （zx_20261013_1 批五起对外导出——`devices:discover` 须把它与 MQTT 发现**并联**。）
 *  zx_20261107_1 B1：mDNS 多服务类型 + SSDP 描述解析（仍只读自述）。 */
export function defaultDiscoveryIo(opts: DefaultDiscoveryIoOpts = {}): DiscoveryIo {
  let stopped = false;
  const cleanups: Array<() => void> = [];
  const serviceTypes = opts.mdnsServiceTypes ?? MDNS_SERVICE_TYPES;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    start(onFound) {
      const emit = (dev: DiscoveredDevice | null): void => {
        if (!dev || stopped) return;
        try { onFound(dev); } catch { /* 单条上报失败：忽略 */ }
      };
      // mDNS：每个服务类型一个 browser（同一 bonjour 实例）
      void (async () => {
        try {
          const mod = (await import('bonjour-service')) as unknown as { default?: MdnsBonjourCtor } & MdnsBonjourCtor;
          const Bonjour = (mod.default ?? mod) as MdnsBonjourCtor;
          const bonjour = new Bonjour();
          for (const type of serviceTypes) {
            try {
              const browser = bonjour.find({ type });
              browser.on('up', (svc) => emit(mdnsToDiscovered(svc)));
              cleanups.push(() => {
                try { browser.stop(); } catch { /* 已停 */ }
              });
            } catch {
              /* 单个服务类型起不来：其余照跑 */
            }
          }
          cleanups.push(() => {
            try { bonjour.destroy(); } catch { /* 已销毁 */ }
          });
        } catch {
          /* 无 mDNS 能力（缺依赖/端口占用）：如实降级，SSDP 仍试 */
        }
      })();
      // SSDP：先按头部落一条，再异步补描述（失败不影响头部那条）
      void (async () => {
        try {
          const { Client } = await import('node-ssdp');
          const client = new Client();
          client.on('response', (headers, _statusCode, rinfo) => {
            const address = rinfo?.address ?? '';
            emit(ssdpToDiscovered(headers, address));
            const loc = typeof headers.LOCATION === 'string' ? headers.LOCATION : '';
            if (!loc) return;
            void fetchDescription(loc, fetchImpl).then((desc) => {
              if (desc) emit(ssdpToDiscovered(headers, address, desc));
            });
          });
          cleanups.push(() => {
            try { client.stop(); } catch { /* 已停 */ }
          });
          await client.start();
          await client.search('ssdp:all');
        } catch {
          /* 无 SSDP 能力：如实降级 */
        }
      })();
    },
    stop() {
      stopped = true;
      for (const c of cleanups.splice(0)) {
        try { c(); } catch { /* 收摊噪声 */ }
      }
    },
  };
}
