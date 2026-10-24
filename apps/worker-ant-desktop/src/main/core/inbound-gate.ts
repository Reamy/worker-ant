/**
 * zx_20261014_4 批一（道德经·善闭无关楗而不可开 / 罗尔斯·无知之幕 / 毛选·没有调查没有发言权）:
 * **入站门**——让别的 AI 终端**找得到**本机、**认得清**它是什么、**进得来**（而默认**关**着）。
 *
 * 病根（K-9 真缺口，实测）：工蚁只会**向外**找 ANS、找节点、找设备，从不向外**露面**——
 *   别的 AI 终端在同一局域网里没有任何办法知道"这里有一台工蚁、它能干什么"。
 *   一台只会敲别人门的机器，在协同网络里不是一个成员。
 *
 * 四条纪律（照 `ans-supervisor.ts` 的"有界/如实/可关"范式）：
 *   ① **默认关**——开关 `node.external_inbound` **显式** seed `'false'`（见 `database.ts`；
 *      `boolSetting` 判据是"只有明确说关才算关"⇒ 漏 seed 即"缺省即开"，把门敞在局域网上）。
 *   ② **门外先认街坊**——绑全网卡以达局域网，但**每请求**校验对端地址属私网（`isPrivateAddress`）；
 *      非私网一律 **403**（双保险：绑 lan ＋ 逐请求围栏）。
 *   ③ **类目公开、清单遮蔽**（罗尔斯·无知之幕；zx_20261021_3 批四收窄了"只说三句"）——
 *      `/.well-known/agent.json` **免凭据**，只含六键：`name` / `protocol` / `agent_version` /
 *      `offered_capabilities` / `intents` / `pairing.endpoint`。
 *      **公开**的是"能做什么类"（能力类目 + 意图目录，二者皆取自既有真源 `EXTERNAL_CAPABILITIES`
 *      与 `INTENTS`）；**遮蔽**的是"对谁做"——设备清单、设备 id/名字、地址端口、房间实例值、
 *      `node_id`、授权态，一律不出现。分界理由：不公开类目，别的终端无从判断"值不值得配对"；
 *      公开实例清单，则是把屋里的布置摊给街上的人看。
 *   ④ **起不来如实记因**——`listen` 失败即把状态复位并记因，**不假装在跑**（照 ANS 代起 M2 纪律）。
 *
 * ⚠ **零 electron 依赖**（只用 `node:http`）：路由处置抽为**纯函数** `handleInboundRequest`，
 *   受控回归**直引跑真实现**，不真开网卡（真 `listen` 只在实机 E2E 验）。
 * ⚠ 真网络（mDNS 广播 `_workerant._tcp`）**惰性 `import`**——rr 注入 `mdnsFactory: null` 时既**不触网**，
 *   模块图也不拉 `bonjour-service`。与 `device-discovery.ts` 的 browse 同库**不同用途**（那是"找设备"，
 *   这是"被找到"），**刻意不合并**。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { PairingPort } from './external-terminals.js';
// 批四：能力**类目**自述的唯一组装处（门牌与 rr 同引，不在门里另拼一份）。
import { offeredCapabilities } from './external-calls.js';
import type { ExternalCapabilityPort } from './external-calls.js';
import { publicIntents, type PublicIntentDescriptor } from './intent-protocol.js';

/** 入站端口**单源**（避开 27183/5173/19950-19999/3100）。可用 `WA_INBOUND_PORT` 逃生口（照 ANS `ANS_SERVER_PORT` 先例）。 */
export const INBOUND_DEFAULT_PORT = 27184;
/** 对外露面的**唯一**免凭据端点（"门牌"）。 */
export const INBOUND_WELL_KNOWN_PATH = '/.well-known/agent.json';
/** 对外协议标识（外部终端据此判"这是哪一族的东西"）。 */
export const INBOUND_PROTOCOL = 'worker-ant/1';
/** 配对入口（批二落地）——`POST {name}` ⇒ 建 `pending` 行，回 `{pairing_id, pair_code}`。 */
export const INBOUND_PAIR_ENDPOINT = '/api/v1/pair/request';
/** 配对**轮询**入口（批二落地）——终端凭 `pairing_id`+`pair_code` 取"批没批"，批了**只此一次**给凭据。 */
export const INBOUND_PAIR_STATUS_PATH = '/api/v1/pair/status';
/** 需凭据的 API 面**前缀**（批二起：先做"认证闸"；批三在其内续接 `capabilities`/`invoke`）。 */
export const INBOUND_API_PREFIX = '/api/v1/';
/** 批三：能力面——`GET`（需凭据）⇒ 脱敏设备清单 + 本终端获批的能力。 */
export const INBOUND_CAPABILITIES_PATH = '/api/v1/capabilities';
/** 批三：调用面——`POST {capability, args}`（需凭据）⇒ 白名单 ∩ 获批 → 执行 → 留痕。 */
export const INBOUND_INVOKE_PATH = '/api/v1/invoke';
/** zx_20261018_1 批二：意图**两跳**的第一跳——`POST {intent, params}` ⇒ 只落计划，**零副作用**。 */
export const INBOUND_INTENT_RESOLVE_PATH = '/api/v1/intent/resolve';
/** 第二跳——`POST {planId}` ⇒ 认领一次、按步执行、如实收口。 */
export const INBOUND_INTENT_EXECUTE_PATH = '/api/v1/intent/execute';
/** mDNS 广播的 service type（`_workerant._tcp`）。 */
export const INBOUND_MDNS_SERVICE = 'workerant';

/** 端口解析（单源 + 逃生口）。非法/缺省 ⇒ `INBOUND_DEFAULT_PORT`。 */
export function resolveInboundPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WA_INBOUND_PORT;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  return INBOUND_DEFAULT_PORT;
}

/**
 * 对端地址是否属**私网**——门先认"来的是不是街坊"（管子·度量衡：尺子只此一把）。
 *
 * 认：`127/8`、`::1`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（IPv4 链路本地）、
 *     `fe80::/10`（IPv6 链路本地）、`fc00::/7`（IPv6 唯一本地），以及 IPv4-mapped IPv6 形态
 *     （`::ffff:192.168.x.x`——node 双栈监听时对端 IPv4 常以此形到场）。
 * 其余（含空/未解析）一律 **false** ⇒ 403。**不抛**。
 */
export function isPrivateAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  let addr = ip.trim().toLowerCase();
  if (!addr) return false;
  // node 双栈监听时，IPv4 对端常以 `::ffff:192.168.1.5` 到场——先剥壳再按 IPv4 判。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) addr = mapped[1]!;
  if (addr === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const a = Number(v4[1]); const b = Number(v4[2]); const c = Number(v4[3]); const d = Number(v4[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 唯一本地
  return false;
}

/**
 * 门牌（罗尔斯·无知之幕：**类目公开、清单遮蔽**）。
 * ⚠ 六键**精确**——多一个键就是把门内之物提前摆到街上；泄漏判据按这六键做全等。
 */
export interface AgentCard {
  name: string;
  protocol: string;
  agent_version: string;
  /** 能力类目（取自 `EXTERNAL_CAPABILITIES`；`requires_approval` 恒 true）。 */
  offered_capabilities: Array<{ key: string; label: string; requires_approval: true }>;
  /** 意图目录（id / label / 参数**名**；`values` 只含固定枚举，不含任何房间/设备实例）。 */
  intents: PublicIntentDescriptor[];
  pairing: { endpoint: string };
}

export function buildAgentCard(nodeName: string, agentVersion: string): AgentCard {
  return {
    name: nodeName,
    protocol: INBOUND_PROTOCOL,
    agent_version: agentVersion,
    // 两项皆**派生**自既有真源（不在此手抄类目名/意图名）——新增一类能力或意图，门牌自动跟上。
    offered_capabilities: offeredCapabilities(),
    intents: publicIntents(),
    pairing: { endpoint: INBOUND_PAIR_ENDPOINT },
  };
}

/** 路由处置的**输入窄面**（纯数据，不含 `node:http` 对象 ⇒ rr 可直造标本）。 */
export interface InboundRequestLike {
  method: string;
  /** 只到 path（不含 query）。 */
  path: string;
  /** 已解析的查询串（`?a=b` ⇒ `{a:'b'}`）；缺省为空表。 */
  query?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  /** 已解析的请求体（POST；`node:http` 层读出并 JSON.parse）。 */
  body?: unknown;
}

export interface InboundResult {
  status: number;
  body: unknown;
}

export interface InboundDeps {
  nodeName: () => string;
  agentVersion: string;
  /**
   * 批二：配对/凭据端口。**缺省 ⇒ 一律 404**（保持批一的"纯门牌"语义——没接配对模块时，
   * 门只发门牌；`/api/v1/*` 一概不存在）。rr 注入真实现（内存库）或省略。
   */
  pairing?: PairingPort;
  /**
   * 批三：能力面端口（`capabilities` / `invoke`）。`pairing` 认下凭据后，能力面**仍可缺省** ⇒
   * 该两路 404（认证过但门内无端点）——保持"缺什么就如实说没有，不假装"的一贯做法。
   */
  capability?: ExternalCapabilityPort;
}

/** 从 `Authorization: Bearer <key>.<secret>` 拆出凭据（形状不符 ⇒ null）。 */
function parseBearer(header: string | string[] | undefined): { key: string; secret: string } | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const m = /^\s*Bearer\s+([^\s.]+)\.([^\s]+)\s*$/i.exec(raw);
  return m ? { key: m[1]! , secret: m[2]! } : null;
}

/**
 * 入站路由的**唯一处置处**（纯函数）。
 * 次序：① 私网围栏 → ② 门牌（免凭据）→ ③ 配对两跳（免凭据，靠 `pairing_id`+`pair_code` 自证）
 *      → ④ `/api/v1/*` 认证闸 → ⑤ 能力面（`capabilities` / `invoke`，需凭据）。
 * 围栏**先于**一切——免得靠 403/404/200 的差别泄露"有没有这条路由"。
 *
 * ⚠ 返回 `InboundResult | Promise<InboundResult>`：**除 `invoke` 外全是同步**（纯函数路径可直测），
 *   只有"真控设备"那一跳是异步（`capability.invoke`）。`serveInbound` 用 `await` 兜住两者
 *   （`await` 一个非 Promise 值即原值返回）——故同步断言（G/P 组）**不需**改写成 async。
 */
export function handleInboundRequest(req: InboundRequestLike, deps: InboundDeps): InboundResult | Promise<InboundResult> {
  // ① 围栏：非私网一律 403（"门先认街坊"）。
  if (!isPrivateAddress(req.remoteAddress)) return { status: 403, body: { error: 'forbidden' } };
  const method = (req.method || 'GET').toUpperCase();
  const path = req.path || '/';
  // ② 门牌：免凭据，只回三块。
  if (method === 'GET' && path === INBOUND_WELL_KNOWN_PATH) {
    return { status: 200, body: buildAgentCard(deps.nodeName(), deps.agentVersion) };
  }
  const port = deps.pairing;
  if (!port) return { status: 404, body: { error: 'not_found' } };

  // ③ 配对申请：`POST {name}` ⇒ 建 pending 行（免凭据——此刻终端还没凭据）。
  if (method === 'POST' && path === INBOUND_PAIR_ENDPOINT) {
    const name = typeof (req.body as { name?: unknown } | undefined)?.name === 'string'
      ? ((req.body as { name: string }).name).trim()
      : '';
    if (!name) return { status: 400, body: { error: 'name_required' } };
    const r = port.requestPair(name, req.remoteAddress);
    // zx_20261018_3 批三：超上限**如实拒**（429）——不回一个假 pairing_id 让终端空轮询。
    if (!r.ok) return { status: 429, body: { error: r.reason } };
    return { status: 200, body: { pairing_id: r.pairingId, pair_code: r.pairCode } };
  }

  // ③′ 配对轮询：`GET ?pairing_id&pair_code` ⇒ 四态；approved 首次回凭据。
  if (method === 'GET' && path === INBOUND_PAIR_STATUS_PATH) {
    const q = req.query ?? {};
    return { status: 200, body: port.pairStatus(q.pairing_id ?? '', q.pair_code ?? '') };
  }

  // ④ `/api/v1/*` 其余一律**先过认证闸**（批二），认下凭据之后才谈能力面（批三）。
  if (path.startsWith(INBOUND_API_PREFIX)) {
    const cred = parseBearer(req.headers['authorization']);
    if (!cred) return { status: 401, body: { error: 'missing_credentials' } };
    const v = port.verify(cred.key, cred.secret, req.remoteAddress);
    if (!v.ok) return { status: v.status, body: { error: v.reason } };
    // ④′ zx_20261018_1 批一 R-10（康德·自由以他人自由为界）: **零能力 = 零门内之物**——
    //   "只配对、不授予任何能力"是合法选择，那它就**看不了、也做不了**任何 `/api/v1/*`（含 capabilities 自省），
    //   一律 403。不写计划、不写设备动作（请求在能力端口之前就被挡下）。
    if (v.terminal.capabilities.length === 0) {
      return { status: 403, body: { error: 'capability_not_granted' } };
    }
    // ⑤ 能力面（批三）：凭据已被认下**且**装配了能力端口——否则仍 404（认证过但门内无端点）。
    const cap = deps.capability;
    if (!cap) return { status: 404, body: { error: 'not_found' } };
    if (method === 'GET' && path === INBOUND_CAPABILITIES_PATH) {
      return cap.capabilities(v.terminal.terminalId, v.terminal.capabilities);
    }
    if (method === 'POST' && path === INBOUND_INVOKE_PATH) {
      return cap.invoke(v.terminal.terminalId, v.terminal.capabilities, req.body, req.remoteAddress);
    }
    // ⑤′ 意图两跳（zx_20261018_1 批二）：resolve 只落计划（零副作用），execute 只执行一次。
    //   `intent_control` 闸在端口内按 `allowed` 再判一次（与 invoke 同一把尺，门面不重复）。
    if (method === 'POST' && path === INBOUND_INTENT_RESOLVE_PATH) {
      return cap.resolveIntent(v.terminal.terminalId, v.terminal.capabilities, req.body, req.remoteAddress);
    }
    if (method === 'POST' && path === INBOUND_INTENT_EXECUTE_PATH) {
      return cap.executeIntent(v.terminal.terminalId, v.terminal.capabilities, req.body, req.remoteAddress);
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  return { status: 404, body: { error: 'not_found' } };
}

/* ── 服务本体（可注入 ⇒ rr 不真开网卡）──────────────────────────────────────── */

/** 只用到的那一小面（令 `node:http` 可被受控回归替换为假 server）。 */
export interface InboundServer {
  listen(port: number, cb: () => void): void;
  close(cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
export type InboundServerFactory = (handler: (req: IncomingMessage, res: ServerResponse) => void) => InboundServer;

function defaultServerFactory(handler: (req: IncomingMessage, res: ServerResponse) => void): InboundServer {
  const server: Server = createServer(handler);
  return {
    // 不传 host ⇒ 绑全网卡（可达局域网）；逐请求围栏在 `handleInboundRequest` 里兜底。
    listen: (port, cb) => { server.listen(port, cb); },
    close: (cb) => { try { server.close(() => cb()); } catch { cb(); } },
    on: (ev, cb) => { server.on(ev, cb); },
  };
}

/** mDNS 广播（"被找到"）——只用到的那一小面。 */
export interface MdnsPublisher { stop(): void; }
export type MdnsPublishFactory = (nodeName: string, port: number) => MdnsPublisher;

interface MdnsInstance {
  publish(o: { name: string; type: string; protocol?: string; port: number; txt?: Record<string, unknown> }): { stop(cb?: () => void): void };
  destroy(): void;
}
interface MdnsBonjourCtor { new (): MdnsInstance; }

/** 真广播：惰性 `import('bonjour-service')`（同 `device-discovery.ts` 范式）。不可用即**如实降级**。 */
function defaultMdnsPublish(nodeName: string, port: number): MdnsPublisher {
  let stopped = false;
  let cleanup: (() => void) | null = null;
  void (async () => {
    try {
      const mod = (await import('bonjour-service')) as unknown as { default?: MdnsBonjourCtor } & MdnsBonjourCtor;
      const Bonjour = (mod.default ?? mod) as MdnsBonjourCtor;
      const bonjour = new Bonjour();
      const svc = bonjour.publish({ name: nodeName, type: INBOUND_MDNS_SERVICE, protocol: 'tcp', port, txt: { v: '1' } });
      cleanup = () => {
        try { svc.stop(); } catch { /* 已停 */ }
        try { bonjour.destroy(); } catch { /* 已销毁 */ }
      };
      if (stopped) cleanup();
    } catch {
      /* 无 mDNS 能力（缺依赖/端口占用）：如实降级——HTTP 直连仍可用 */
    }
  })();
  return { stop() { stopped = true; try { cleanup?.(); } catch { /* 收摊噪声 */ } } };
}

export type InboundStartReason = 'started' | 'disabled' | 'already-running' | 'listen-failed';

export interface StartInboundOpts {
  /** 开关（由调用方读 `readBoolSetting(db,'node.external_inbound')`）。`false` ⇒ **不起**（缺省关的真落点）。 */
  enabled: boolean;
  nodeName: () => string;
  agentVersion: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  /** 批二：配对/凭据端口（`createPairingPort(db)`）。**省略 ⇒ `/api/v1/*` 一律 404**（纯门牌模式）。 */
  pairing?: PairingPort;
  /** 批三：能力面端口（`createExternalCapabilityPort(db, …)`）。省略 ⇒ 认证过也 404（门内无端点）。 */
  capability?: ExternalCapabilityPort;
  /** 注入 server 工厂（rr 传假 server ⇒ 不真开网卡）。缺省 `node:http`。 */
  serverFactory?: InboundServerFactory;
  /** mDNS 广播工厂；`null` = 不广播（rr）。缺省真广播。 */
  mdnsFactory?: MdnsPublishFactory | null;
}

let activeServer: InboundServer | null = null;
let activeMdns: MdnsPublisher | null = null;
let activePort = 0;
let lastError = '';

/** 是否正在监听（面板据此显示"已开/已关"）。 */
export function isInboundRunning(): boolean { return activeServer !== null; }
/** 当前监听端口（未跑 ⇒ 0）。 */
export function inboundRunningPort(): number { return activePort; }
/** 最近一次起失败的原因（未失败 ⇒ 空串）——"如实记因"的落点。 */
export function inboundLastError(): string { return lastError; }

/**
 * 起入站门。`enabled:false` ⇒ 立即返回 `disabled`（**不**开任何 socket）。
 * 可重复调用（已在跑则 `already-running`）。`listen` 失败经 `error` 事件**异步**到达 ⇒
 * 该处理器把状态**复位**并记因，故 `isInboundRunning()` 永不说谎。
 */
export function startInboundGate(opts: StartInboundOpts): { started: boolean; port: number; reason: InboundStartReason } {
  if (!opts.enabled) return { started: false, port: 0, reason: 'disabled' };
  if (activeServer) return { started: true, port: activePort, reason: 'already-running' };
  const port = opts.port ?? resolveInboundPort(opts.env ?? process.env);
  const factory = opts.serverFactory ?? defaultServerFactory;
  const deps: InboundDeps = { nodeName: opts.nodeName, agentVersion: opts.agentVersion, pairing: opts.pairing, capability: opts.capability };
  const server = factory((req, res) => { void serveInbound(req, res, deps); });
  server.on('error', (e) => {
    lastError = e?.message || String(e);
    console.warn('[工蚁] 入站门起不来（如实记因）:', lastError);
    if (activeServer === server) { activeServer = null; activeMdns = null; activePort = 0; }
  });
  try {
    server.listen(port, () => { /* 已监听 */ });
  } catch (e) {
    lastError = (e as Error)?.message || String(e);
    console.warn('[工蚁] 入站门起不来（如实记因）:', lastError);
    return { started: false, port: 0, reason: 'listen-failed' };
  }
  activeServer = server;
  activePort = port;
  lastError = '';
  // mDNS 广播随开关起（"被找到"与"能应答"同时到位）。
  const mdnsFactory = opts.mdnsFactory === undefined ? defaultMdnsPublish : opts.mdnsFactory;
  if (mdnsFactory) {
    try { activeMdns = mdnsFactory(opts.nodeName(), port); } catch { activeMdns = null; }
  }
  return { started: true, port, reason: 'started' };
}

/** 关入站门（幂等；`server.close()` + mDNS 停）。未起即为空操作。 */
export function stopInboundGate(): void {
  const server = activeServer; activeServer = null; activePort = 0;
  if (server) { try { server.close(() => { /* 已关 */ }); } catch { /* 已关/未起 */ } }
  const mdns = activeMdns; activeMdns = null;
  if (mdns) { try { mdns.stop(); } catch { /* 收摊噪声 */ } }
}

/** 读请求体（有上限）并 JSON.parse；空体/超限/坏 JSON ⇒ `undefined`（不抛——坏请求不该崩服务）。 */
async function readJsonBody(req: IncomingMessage, cap = 64 * 1024): Promise<unknown> {
  try {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      const buf = c as Buffer;
      n += buf.length;
      if (n > cap) return undefined;
      chunks.push(buf);
    }
    if (!n) return undefined;
    try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return undefined; }
  } catch { return undefined; }
}

/** `node:http` 回调 → 纯处置。任何异常都归一为 500（不因一条烂请求崩掉服务）。 */
async function serveInbound(req: IncomingMessage, res: ServerResponse, deps: InboundDeps): Promise<void> {
  let result: InboundResult;
  try {
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const query: Record<string, string> = {};
    if (q >= 0) {
      try {
        for (const [k, v] of new URL(`http://localhost${raw}`).searchParams) query[k] = v;
      } catch { /* 坏查询串 ⇒ 空表 */ }
    }
    const parsedBody = await readJsonBody(req);
    // `await` 兜住同步与异步两路（`invoke` 那一跳是 Promise；其余为普通对象，await 即原值）。
    result = await handleInboundRequest({
      method: req.method ?? 'GET',
      path: q >= 0 ? raw.slice(0, q) : raw,
      query,
      headers: req.headers as Record<string, string | string[] | undefined>,
      remoteAddress: req.socket?.remoteAddress ?? undefined,
      body: parsedBody,
    }, deps);
  } catch {
    result = { status: 500, body: { error: 'internal' } };
  }
  const body = result.body == null ? '' : JSON.stringify(result.body);
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}
