/**
 * zx_20261023_5 批三（庄子·道在屎溺 / 管子·度量衡）: **米家 miIO 局域网渠道**——发现 + 控制。
 *
 * 为什么单列一个 Provider 而不复用 HTTP：miIO 是**私有二进制协议**（UDP 54321）——
 *   `0x2131` 魔数 + 16 字节头 + MD5 校验 + AES-128-CBC 密文 JSON。
 *   把它塞进 `httpDeviceControl` 只会得到"发出去、没回应"的假失败。
 *
 * 分层（承 `device-provider.ts` 的既有分法）：
 *   · **纯函数**：`normalizeMiioToken` / `miioKeyIv` / `encodeMiioPacket` / `decodeMiioPacket` / `readMiioHeader`
 *     —— rr 可直跑真实现（可注入 stamp/msgId，不碰墙钟、不触网）。
 *   · **传输**：`MiioTransport` 可注入；真 UDP 只在 `udpMiioTransport()` 里（rr 注入假传输）。
 *   · **控制/状态**：`miioDeviceControl` / `miioDeviceState`——**无 token 即如实拒**，绝不伪造成功/在线。
 *   · **发现**：`mijiaMiioDiscoveryIo()`（UDP 广播 hello + mDNS `_miio._udp`）。
 *
 * 诚实边界：不做小米账号云控（OAuth + 云签名）、不做 Matter。
 *   token 由用户手动填入（小米云端取 token 不在本轮范围），加密落库由 `device-secrets.ts` 负责。
 *
 * ⚠ **零循环依赖**：本文件**不** import `tools/device.ts`；SSRF 围栏由 `defaultDeviceControl` 的
 *   miio 分支在调用前核（与 mqtt broker 同法：核的是"出站对象"）。
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import type { AnsDevice, DiscoveredDevice } from '../device-registry.js';
import type { ProviderControlResult, ProviderStateResult } from '../device-provider.js';
import type { DiscoveryIo } from '../device-discovery.js';
import { kindClassOf } from '../device-kind.js';

/** miIO 固定端口（UDP）。 */
export const MIIO_PORT = 54321;
/** 包头魔数（LE）。 */
export const MIIO_MAGIC = 0x2131;
/** 包头（含校验）长度。 */
const MIIO_HEADER_LEN = 32;
/** 发现报文用的"全 F" token（只用于构造 hello 的校验；hello 无密文体）。 */
const MIIO_DISCOVERY_TOKEN = 'ffffffffffffffffffffffffffffffff';
/** 请求里 did 未知时的占位（部分设备接受；被拒会如实回错误）。 */
export const MIIO_UNKNOWN_DID = 0xffffffff;

/** 归一 token：去空白/转小写，必须恰为 32 位十六进制；否则 `null`（不猜、不补零）。 */
export function normalizeMiioToken(token: string | null | undefined): string | null {
  const t = String(token ?? '').replace(/\s+/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(t) ? t : null;
}

/** token ⇒ AES key/iv（key = MD5(tokenBytes)，iv = MD5(key ‖ tokenBytes)）。 */
export function miioKeyIv(token: string): { key: Buffer; iv: Buffer } {
  const tokenBytes = Buffer.from(token, 'hex');
  const key = createHash('md5').update(tokenBytes).digest();
  const iv = createHash('md5').update(Buffer.concat([key, tokenBytes])).digest();
  return { key, iv };
}

function zeroPad(buf: Buffer): Buffer {
  const rem = buf.length % 16;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(16 - rem)]);
}

/** 去掉尾部零填充（miIO 设备用 0x00 补块，不是 PKCS#7）。 */
function stripZeroPad(buf: Buffer): Buffer {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end -= 1;
  return end === buf.length ? buf : buf.subarray(0, end);
}

function encryptPayload(token: string, json: string): Buffer {
  const { key, iv } = miioKeyIv(token);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(zeroPad(Buffer.from(json, 'utf8'))), cipher.final()]);
}

function decryptPayload(token: string, data: Buffer): string {
  const { key, iv } = miioKeyIv(token);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return stripZeroPad(plain).toString('utf8');
}

export interface MiioEncodeInput {
  /** 目标设备 did；未知用 `MIIO_UNKNOWN_DID`。 */
  deviceId?: number;
  /** 报文时间戳（秒）；缺省取当前秒（rr 注入定值）。 */
  stamp?: number;
  /** 32 位 token（已归一）。 */
  token: string;
  /** 密文载荷；`null`/缺省 = 无载荷（发现 hello）。 */
  payload?: unknown;
}

/** 组一个 miIO 包：16B 头 + 16B MD5(头‖密文) + AES-CBC 密文。 */
export function encodeMiioPacket(input: MiioEncodeInput): Buffer {
  const body = input.payload == null ? Buffer.alloc(0) : encryptPayload(input.token, JSON.stringify(input.payload));
  const header = Buffer.alloc(16);
  header.writeUInt16LE(MIIO_MAGIC, 0);
  header.writeUInt16LE(MIIO_HEADER_LEN + body.length, 2);
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE((input.deviceId ?? MIIO_UNKNOWN_DID) >>> 0, 8);
  header.writeUInt32LE((input.stamp ?? Math.floor(Date.now() / 1000)) >>> 0, 12);
  const checksum = createHash('md5').update(Buffer.concat([header, body])).digest();
  return Buffer.concat([header, checksum, body]);
}

/** 只读包头（发现回包只认 did，不需要 token）。 */
export type MiioHeaderRead = { ok: true; deviceId: number; stamp: number } | { ok: false; error: string };

export function readMiioHeader(packet: Buffer): MiioHeaderRead {
  if (packet.length < MIIO_HEADER_LEN) return { ok: false, error: `包长 ${packet.length} 不足 32 字节。` };
  if (packet.readUInt16LE(0) !== MIIO_MAGIC) return { ok: false, error: '魔数不是 0x2131（不是 miIO 包）。' };
  return { ok: true, deviceId: packet.readUInt32LE(8), stamp: packet.readUInt32LE(12) };
}

export type MiioDecode =
  | { ok: true; deviceId: number; stamp: number; payload: unknown }
  | { ok: false; error: string };

/** 解一个 miIO 包：验魔数/长度/校验，再解密密文。任一不符即如实回原因。 */
export function decodeMiioPacket(packet: Buffer, token: string): MiioDecode {
  if (packet.length < MIIO_HEADER_LEN) return { ok: false, error: `包长 ${packet.length} 不足 32 字节。` };
  const head = readMiioHeader(packet);
  if (!head.ok) return head;
  const declared = packet.readUInt16LE(2);
  if (declared !== packet.length) {
    return { ok: false, error: `包头声明长度 ${declared} 与实收 ${packet.length} 不符。` };
  }
  const body = packet.subarray(MIIO_HEADER_LEN);
  const expected = createHash('md5').update(Buffer.concat([packet.subarray(0, 16), body])).digest();
  if (!expected.equals(packet.subarray(16, MIIO_HEADER_LEN))) {
    return { ok: false, error: '校验和不符（token 可能不对或包被改坏）。' };
  }
  if (body.length === 0) return { ok: true, deviceId: head.deviceId, stamp: head.stamp, payload: null };
  try {
    const text = decryptPayload(token, body);
    return { ok: true, deviceId: head.deviceId, stamp: head.stamp, payload: text === '' ? null : JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `解密失败：${(e as Error)?.message || String(e)}` };
  }
}

/** 发现 hello 包（无凭据、无载荷；did/stamp 全 F）。 */
export function miioHelloPacket(stamp = 1): Buffer {
  return encodeMiioPacket({ deviceId: MIIO_UNKNOWN_DID, stamp, token: MIIO_DISCOVERY_TOKEN });
}

// ==================== 动作映射 ====================

/** 一个 miIO 命令（method + params）。 */
export interface MiioCommand {
  method: string;
  params: unknown[];
}

function numberOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 台账动作 ⇒ miIO 命令。认不出即 `null`（调用方如实拒，**不**猜一个"差不多"的方法）。
 * 覆盖常见开关/亮度/温度/模式；厂商私有属性走 `set`（`args.method` + `args.params`）显式通道。
 */
export function miioCommandFor(action: string, args: Record<string, unknown> = {}): MiioCommand | null {
  switch (action) {
    case 'turn_on':
    case 'on':
      return { method: 'set_power', params: ['on'] };
    case 'turn_off':
    case 'off':
      return { method: 'set_power', params: ['off'] };
    case 'toggle':
      return { method: 'toggle', params: [] };
    case 'set_brightness': {
      const n = numberOf(args.brightness ?? args.value ?? args.level);
      if (n == null) return null;
      return { method: 'set_bright', params: [String(Math.max(1, Math.min(100, Math.round(n))))] };
    }
    case 'set_temperature': {
      const n = numberOf(args.temperature ?? args.value);
      if (n == null) return null;
      return { method: 'set_temperature', params: [Math.round(n)] };
    }
    case 'set_mode': {
      const mode = typeof args.mode === 'string' ? args.mode : String(args.value ?? '');
      return mode ? { method: 'set_mode', params: [mode] } : null;
    }
    case 'set_fan_speed': {
      const n = numberOf(args.level ?? args.value);
      if (n == null) return null;
      return { method: 'set_fan_level', params: [Math.round(n)] };
    }
    case 'set': {
      const method = typeof args.method === 'string' ? args.method.trim() : '';
      if (!method) return null;
      const params = Array.isArray(args.params) ? args.params : [];
      return { method, params };
    }
    default:
      return null;
  }
}

/** 支持的动作词表（拒因里如实列出来，别只说"失败"）。 */
export const MIIO_ACTIONS = [
  'turn_on', 'turn_off', 'toggle', 'set_brightness', 'set_temperature', 'set_mode', 'set_fan_speed', 'set',
] as const;

// ==================== 传输（可注入） ====================

export interface MiioRequest {
  address: string;
  port: number;
  packet: Buffer;
  timeoutMs: number;
}

/** UDP 收发窄面（rr 注入假传输，绝不触网）。 */
export interface MiioTransport {
  request(input: MiioRequest): Promise<Buffer>;
}

/** 真 UDP 传输：发一包、等一个回包（超时/错误如实 reject）。 */
export function udpMiioTransport(): MiioTransport {
  return {
    request({ address, port, packet, timeoutMs }) {
      return new Promise<Buffer>((resolve, reject) => {
        const sock: Socket = createSocket('udp4');
        let settled = false;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { sock.close(); } catch { /* 已关 */ }
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`等待 ${address}:${port} 响应超时（${timeoutMs}ms）`))), timeoutMs);
        sock.once('message', (msg) => finish(() => resolve(Buffer.from(msg))));
        sock.once('error', (e) => finish(() => reject(e)));
        sock.send(packet, port, address, (err) => {
          if (err) finish(() => reject(err));
        });
      });
    },
  };
}

// ==================== token 来源（IPC 注入） ====================

let tokenProvider: ((address: string) => string | null | undefined) | null = null;

/** 注入"按设备地址取 token"的读口（`devices.ipc.ts` 用 `readSecret` 解开后注入；`null` = 清场）。 */
export function setMiioTokenProvider(fn: ((address: string) => string | null | undefined) | null): void {
  tokenProvider = fn;
}

/** token 在 `wa_settings` 里的键（每设备一 key；地址里的 `#`/`:` 无碍——键是字符串）。 */
export function miioTokenSettingKey(address: string): string {
  return `device.miio.token.${address}`;
}

/** 取该设备的 token（优先注入的读口；未注入 ⇒ `null`）。 */
export function currentMiioToken(address: string): string | null {
  if (!tokenProvider) return null;
  try {
    return normalizeMiioToken(tokenProvider(address) ?? '');
  } catch {
    return null;
  }
}

// ==================== 控制 / 状态 ====================

export interface MiioControlDeps {
  /** 取 token（缺省走注入的读口）。 */
  tokenFor?: (address: string) => string | null;
  transport?: MiioTransport;
  /** 报文时间戳（rr 注入定值）。 */
  stamp?: number;
  /** 消息 id（rr 注入定值；缺省自增）。 */
  msgId?: number;
  timeoutMs?: number;
}

let msgSeq = 0;
function nextMsgId(): number {
  msgSeq = (msgSeq + 1) & 0x7fffffff;
  return msgSeq;
}

/** 设备地址 ⇒ did（发现时写在 capabilities 的 `miio:did:<n>`；未知用 `0xffffffff`）。 */
export function miioDidOf(dev: Pick<AnsDevice, 'capabilities'>): number {
  for (const cap of dev.capabilities ?? []) {
    const m = /^miio:did:(\d+)$/.exec(String(cap));
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n >>> 0;
    }
  }
  return MIIO_UNKNOWN_DID;
}

/** 发现结果 ⇒ 台账候选（did 存进 capabilities，供控制时填包头）。 */
export function miioDiscovered(input: { address: string; deviceId?: number; port?: number; name?: string; model?: string | null }): DiscoveredDevice {
  const did = typeof input.deviceId === 'number' && input.deviceId > 0 && input.deviceId !== MIIO_UNKNOWN_DID ? input.deviceId : null;
  const hex = did != null ? did.toString(16).padStart(8, '0') : null;
  const capabilities = ['miio', ...(did != null ? [`miio:did:${did}`] : [])];
  // zx_20261029_2 M1: 广播 hello 不含 model ⇒ 没 model 就是 `unknown`（如实"品类未识别"）；
  //   配了 token 的设备在状态刷新时经 `miio.info` 补 model 后再归一（见 `miioDeviceModel`）。
  const kindClass = kindClassOf({ kind: 'unknown', protocol: 'miio', model: input.model ?? null });
  return {
    name: String(input.name ?? '').trim() || (hex ? `米家设备 ${hex}` : `米家设备 ${input.address}`),
    kind: 'unknown',
    ...(kindClass !== 'unknown' ? { kindClass } : {}),
    protocol: 'miio',
    address: input.address,
    port: input.port ?? MIIO_PORT,
    capabilities,
    // 自述"能被命令"：miIO 设备都接受命令面，但**须 token 且经用户授权**才算数（K-6 在台账侧）。
    controllable: true,
  };
}

function tokenOf(address: string, deps: MiioControlDeps): string | null {
  const raw = deps.tokenFor ? deps.tokenFor(address) : currentMiioToken(address);
  return normalizeMiioToken(raw ?? '');
}

/**
 * 下发一条 miIO 命令。
 * ⚠ 无 token / token 非法 ⇒ **如实拒**（不伪造成功）；设备回 `error` ⇒ 原样带出 code/message。
 */
export async function miioDeviceControl(
  dev: AnsDevice,
  action: string,
  args: Record<string, unknown>,
  deps: MiioControlDeps = {},
): Promise<ProviderControlResult> {
  const token = tokenOf(dev.address, deps);
  if (!token) {
    return {
      ok: false,
      result: `设备「${dev.name || dev.address}」未配置有效的 miIO token（需 32 位十六进制），拒绝下发。请在设备行填入 token。`,
    };
  }
  const cmd = miioCommandFor(action, args ?? {});
  if (!cmd) {
    return {
      ok: false,
      result: `设备「${dev.name || dev.address}」不支持动作「${action}」。可用：${MIIO_ACTIONS.join(' / ')}（私有属性用 set + method/params）。`,
    };
  }
  const id = deps.msgId ?? nextMsgId();
  let reply: Buffer;
  try {
    const packet = encodeMiioPacket({
      deviceId: miioDidOf(dev),
      stamp: deps.stamp,
      token,
      payload: { id, method: cmd.method, params: cmd.params },
    });
    reply = await (deps.transport ?? udpMiioTransport()).request({
      address: dev.address,
      port: dev.port ?? MIIO_PORT,
      packet,
      timeoutMs: deps.timeoutMs ?? 5_000,
    });
  } catch (e) {
    return { ok: false, result: `miIO 请求失败：${(e as Error)?.message || String(e)}` };
  }
  const decoded = decodeMiioPacket(reply, token);
  if (!decoded.ok) return { ok: false, result: `miIO 回包无效：${decoded.error}` };
  const payload = decoded.payload as { id?: number; result?: unknown; error?: { code?: number; message?: string } } | null;
  if (payload && typeof payload === 'object' && payload.error) {
    const code = payload.error.code;
    const message = payload.error.message ?? '设备拒绝执行';
    return { ok: false, result: `设备拒绝（${code != null ? `code ${code}：` : ''}${message}）` };
  }
  const resultText = payload && typeof payload === 'object' && 'result' in payload
    ? JSON.stringify(payload.result)
    : '（无结果体）';
  return { ok: true, result: `${cmd.method} → ${resultText}` };
}

/** 常见属性（`get_prop` 兜底时问这几个；设备不认的会被它自己忽略）。 */
const COMMON_PROPS = ['power', 'bright', 'temp', 'mode', 'fan_level', 'status', 'humidity', 'temperature'];

/**
 * 查状态：先 `get_status`（一步拿到全量），失败再 `get_prop` 问常见属性。
 * ⚠ 两问都失败 ⇒ 如实 `{ok:false,error}`；**绝不**回一个编造的状态。
 */
export async function miioDeviceState(dev: AnsDevice, deps: MiioControlDeps = {}): Promise<ProviderStateResult> {
  const token = tokenOf(dev.address, deps);
  if (!token) {
    return { ok: false, error: `设备「${dev.name || dev.address}」未配置有效的 miIO token，无法查询状态。` };
  }
  const transport = deps.transport ?? udpMiioTransport();
  const ask = async (method: string, params: unknown[]): Promise<{ ok: boolean; state?: Record<string, unknown>; error?: string }> => {
    try {
      const packet = encodeMiioPacket({
        deviceId: miioDidOf(dev),
        stamp: deps.stamp,
        token,
        payload: { id: deps.msgId ?? nextMsgId(), method, params },
      });
      const reply = await transport.request({
        address: dev.address,
        port: dev.port ?? MIIO_PORT,
        packet,
        timeoutMs: deps.timeoutMs ?? 5_000,
      });
      const decoded = decodeMiioPacket(reply, token);
      if (!decoded.ok) return { ok: false, error: decoded.error };
      const payload = decoded.payload as { result?: unknown; error?: { code?: number; message?: string } } | null;
      if (payload?.error) {
        return { ok: false, error: `code ${payload.error.code ?? '?'}：${payload.error.message ?? '设备拒绝'}` };
      }
      return { ok: true, state: { method, result: payload?.result ?? null } };
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || String(e) };
    }
  };
  const first = await ask('get_status', []);
  if (first.ok) return { ok: true, state: first.state };
  const second = await ask('get_prop', COMMON_PROPS);
  if (second.ok) return { ok: true, state: second.state };
  return { ok: false, error: `状态查询失败（get_status：${first.error}；get_prop：${second.error}）` };
}

/**
 * 查设备型号（`miio.info`）——**只用于品类归一**（zx_20261029_2 M1）。
 * 无 token / 查询失败 / 回包无 model ⇒ `null`（不猜型号；品类保持 `unknown`）。
 * ⚠ 不改变 `miioDeviceState` 的结果形状：这是另一问，失败不外溢成"设备离线"。
 */
export async function miioDeviceModel(dev: AnsDevice, deps: MiioControlDeps = {}): Promise<string | null> {
  const token = tokenOf(dev.address, deps);
  if (!token) return null;
  try {
    const packet = encodeMiioPacket({
      deviceId: miioDidOf(dev),
      stamp: deps.stamp,
      token,
      payload: { id: deps.msgId ?? nextMsgId(), method: 'miio.info', params: [] },
    });
    const reply = await (deps.transport ?? udpMiioTransport()).request({
      address: dev.address,
      port: dev.port ?? MIIO_PORT,
      packet,
      timeoutMs: deps.timeoutMs ?? 5_000,
    });
    const decoded = decodeMiioPacket(reply, token);
    if (!decoded.ok) return null;
    const payload = decoded.payload as { result?: unknown } | null;
    const result = payload?.result;
    const model = result && typeof result === 'object' ? (result as { model?: unknown }).model : result;
    return typeof model === 'string' && model.trim() ? model.trim() : null;
  } catch {
    return null;
  }
}

// ==================== 发现 ====================

/** mDNS 服务的窄面（承 `device-discovery.ts` 的本地声明法）。 */
interface MiioMdnsService {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  referer?: { address?: string };
}

/** mDNS `_miio._udp` 服务 ⇒ 台账候选（name 用设备自述；did 未知，控制时用 0xffffffff）。 */
export function miioMdnsToDiscovered(svc: MiioMdnsService): DiscoveredDevice | null {
  const address = svc.referer?.address || svc.addresses?.[0] || svc.host;
  if (!address) return null;
  const dev = miioDiscovered({ address, port: typeof svc.port === 'number' ? svc.port : MIIO_PORT, name: svc.name });
  return { ...dev, capabilities: [...(dev.capabilities ?? []), 'mdns'] };
}

export interface MiioDiscoveryOpts {
  /** 广播目标（缺省全局广播 + 各组播发现地址）。rr 注入本机地址。 */
  targets?: Array<{ address: string; port?: number }>;
  /** 广播窗口（毫秒）：窗口内重复发 hello，收集回包。 */
  holdMs?: number;
  /** 重复发送间隔（毫秒）。 */
  intervalMs?: number;
  /** 是否同时浏览 mDNS `_miio._udp`（缺省 true；rr 关掉避免触网）。 */
  mdns?: boolean;
}

/**
 * miIO 发现 IO（与 LAN/MQTT 发现并联；`composeDiscoveryIo` 收拢）。
 * · UDP：向 `targets` 发 hello，回包按 `rinfo.address` + 包头 did 入账。
 * · mDNS：惰性 import `bonjour-service` 浏览 `_miio._udp`；不可用即如实降级（UDP 仍跑）。
 */
export function mijiaMiioDiscoveryIo(opts: MiioDiscoveryOpts = {}): DiscoveryIo {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const sockets: Socket[] = [];
  const cleanups: Array<() => void> = [];
  const holdMs = Math.max(500, opts.holdMs ?? 4_000);
  const intervalMs = Math.max(200, opts.intervalMs ?? 1_500);
  const targets = opts.targets ?? [
    { address: '255.255.255.255', port: MIIO_PORT },
    { address: '224.0.0.50', port: MIIO_PORT },
  ];

  return {
    start(onFound) {
      const emit = (dev: DiscoveredDevice | null): void => {
        if (!dev || stopped) return;
        try { onFound(dev); } catch { /* 单条上报失败：忽略 */ }
      };
      // UDP hello 广播
      for (const target of targets) {
        try {
          const sock = createSocket('udp4');
          sock.on('message', (msg, rinfo) => {
            const head = readMiioHeader(Buffer.from(msg));
            if (!head.ok) return;
            emit(miioDiscovered({ address: rinfo.address, deviceId: head.deviceId, port: rinfo.port || MIIO_PORT }));
          });
          sock.on('error', () => { /* 单个 socket 出错：其余目标照跑 */ });
          sock.bind(() => {
            try { sock.setBroadcast(true); } catch { /* 非广播目标不设 */ }
            const hello = miioHelloPacket();
            const send = (): void => {
              if (stopped) return;
              try { sock.send(hello, target.port ?? MIIO_PORT, target.address); } catch { /* 发送失败：下次再试 */ }
            };
            send();
            timer = setInterval(send, intervalMs);
          });
          sockets.push(sock);
        } catch {
          /* 建 socket 失败：如实降级 */
        }
      }
      const stopSockets = (): void => {
        if (timer) { clearInterval(timer); timer = null; }
        for (const s of sockets.splice(0)) {
          try { s.close(); } catch { /* 已关 */ }
        }
      };
      cleanups.push(stopSockets);
      // mDNS `_miio._udp`
      if (opts.mdns !== false) {
        void (async () => {
          try {
            const mod = (await import('bonjour-service')) as unknown as {
              default?: new () => { find(o: { type: string; protocol?: string }): { on(ev: 'up', cb: (svc: MiioMdnsService) => void): void; stop(): void }; destroy(): void };
            } & (new () => { find(o: { type: string; protocol?: string }): { on(ev: 'up', cb: (svc: MiioMdnsService) => void): void; stop(): void }; destroy(): void });
            const Bonjour = (mod.default ?? mod);
            const bonjour = new Bonjour();
            const browser = bonjour.find({ type: 'miio', protocol: 'udp' });
            browser.on('up', (svc) => emit(miioMdnsToDiscovered(svc)));
            cleanups.push(() => {
              try { browser.stop(); } catch { /* 已停 */ }
              try { bonjour.destroy(); } catch { /* 已销毁 */ }
            });
          } catch {
            /* 无 mDNS 能力：UDP 仍跑 */
          }
        })();
      }
    },
    stop() {
      stopped = true;
      for (const c of cleanups.splice(0)) {
        try { c(); } catch { /* 收摊噪声 */ }
      }
    },
  };
}
