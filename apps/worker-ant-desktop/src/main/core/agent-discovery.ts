/**
 * zx_20261106_3 B7「通」: **通用 AI 终端发现**——按 A2A agent card 约定去看门外有谁。
 *
 * 与既有两套发现的分工（刻意不合并）：
 *   - `lan-terminals.ts`：听 **自家约** 的 `_workerant-terminal._tcp` 广播（只认自家终端）；
 *   - `inbound-gate.ts`：本机**对外**挂门牌（别人怎么发现我们）；
 *   - 本模块：**我们主动**按通用约定（`/.well-known/agent-card.json` / `agent.json`）探测别人。
 *
 * 四条安全边界（罗尔斯·无知之幕 / 毛选·没有调查没有发言权）：
 *   ① **只认私网**：字面 IP 在 `parseProbeTarget` 就拦；域名由真 IO 的 DNS 解析结果再判一次
 *      （解析到公网地址即拒），不扫网段、不做端口扫描。
 *   ② **有界**：3 秒超时、64KB 响应体上限；超限即断，不把对端给的字节全收进来。
 *   ③ **不跟随重定向**：3xx 一律如实拒绝（跨域重定向是绕过私网围栏的常见口子）。
 *   ④ **发现 ≠ 授权**：结果只进内存「待接入」列表（10 分钟无再见即散），**绝不自动配对**；
 *      用户点「接入」才走既有 `createPairRequestGuarded` → 核对码 → 批准 → 钥匙只回一次。
 *
 * ⚠ 真网络只在 `defaultAgentDiscoveryIo()` / `defaultA2ABrowseIo()` 里**惰性**发生；
 *   rr 注入假 IO 时既不触网，模块图也不拉 `bonjour-service`。
 * ⚠ 本模块**零 electron / 零 better-sqlite3 / 零落库**：发现是"看见"，不是"进门"。
 */
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import {
  INBOUND_AGENT_CARD_PATH,
  INBOUND_WELL_KNOWN_PATH,
  isPrivateAddress,
} from './inbound-gate.js';
import { sanitizeDeclaredIntents } from './terminal-negotiation.js';

/** 门牌约定路径——与入站门**同一份常量**（不是第二套门牌）。顺序即探测顺序。 */
export const AGENT_CARD_PROBE_PATHS = [INBOUND_AGENT_CARD_PATH, INBOUND_WELL_KNOWN_PATH] as const;

export const DISCOVERY_TIMEOUT_MS = 3000;
export const DISCOVERY_MAX_BODY_BYTES = 64 * 1024;
/** 待接入列表的存活期：手工探测的结果也应是"此刻谁在"，不是账本。 */
export const DISCOVERY_PENDING_TTL_MS = 10 * 60_000;
/** A2A 的 mDNS 服务类型（`_a2a._tcp`）——标准约定，不是自家 `_workerant._tcp`。 */
export const A2A_MDNS_SERVICE = 'a2a';
export const A2A_SCAN_DEFAULT_MS = 4000;
/** 一次扫描最多探测几台（不扫网段，也别把广播风暴变成请求风暴）。 */
export const A2A_SCAN_MAX_TARGETS = 8;

// ── 门牌解析 ──────────────────────────────────────────────────────────────────

export interface DiscoveredAgentCard {
  name: string;
  description: string;
  version: string | null;
  protocol: string | null;
  /** 门牌自报能接的意图——双模协商的第一判据（`terminal-negotiation.ts`）。 */
  intents: string[];
  /** 技能条目（只留 id/name，最多 32 条；描述不占位）。 */
  skills: Array<{ id: string; name: string }>;
  /** A2A 标准 `capabilities` 里为 true 的键（streaming 等），只作展示。 */
  features: string[];
}

const NAME_MAX = 120;
const DESC_MAX = 500;
const VERSION_MAX = 40;
const SKILLS_MAX = 32;

function cleanStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

/**
 * 把任意 JSON 收敛成可识别的 agent card。**缺 `name` 即 null**——名字是"这是谁"的最小充分信息，
 * 没有名字的卡不可核对，宁可如实说"不是卡片"也不猜。
 */
export function parseAgentCard(raw: unknown): DiscoveredAgentCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = cleanStr(o.name, NAME_MAX);
  if (!name) return null;

  const skills: Array<{ id: string; name: string }> = [];
  if (Array.isArray(o.skills)) {
    for (const entry of o.skills) {
      let id = '';
      let sname = '';
      if (typeof entry === 'string') {
        id = cleanStr(entry, NAME_MAX);
        sname = id;
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        id = cleanStr(e.id, NAME_MAX);
        sname = cleanStr(e.name, NAME_MAX);
      }
      if (!id && !sname) continue;
      skills.push({ id: id || sname, name: sname || id });
      if (skills.length >= SKILLS_MAX) break;
    }
  }

  const features: string[] = [];
  const caps = o.capabilities;
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    for (const [key, value] of Object.entries(caps as Record<string, unknown>)) {
      if (value === true) features.push(cleanStr(key, 40));
      if (features.length >= 16) break;
    }
  }

  return {
    name,
    description: cleanStr(o.description, DESC_MAX),
    version: cleanStr(o.version, VERSION_MAX) || null,
    protocol: cleanStr(o.protocolVersion, VERSION_MAX) || cleanStr(o.protocol, VERSION_MAX) || null,
    intents: sanitizeDeclaredIntents(o.intents),
    skills,
    features,
  };
}

// ── 目标解析 ──────────────────────────────────────────────────────────────────

export interface ProbeTargetOk {
  ok: true;
  /** 按探测顺序排好的完整卡地址（两跳：agent-card.json → agent.json）。 */
  candidates: string[];
  /** `scheme://host[:port]`（待接入列表展示与配对地址的稳定形态）。 */
  endpoint: string;
  address: string;
  port: number | null;
  /** 域名目标需真 IO 解析后再判私网（字面 IP 已经在 `parseProbeTarget` 判过）。 */
  needsDns: boolean;
}
export interface ProbeTargetErr { ok: false; reason: string }
export type ProbeTarget = ProbeTargetOk | ProbeTargetErr;

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function candidatesFor(url: URL): string[] {
  const origin = url.origin;
  const path = url.pathname;
  // 用户直接给了卡地址：先试它，再试另一条约定路径（换过实现的终端两形都有）。
  const idx = (AGENT_CARD_PROBE_PATHS as readonly string[]).indexOf(path);
  if (idx >= 0) {
    const other = AGENT_CARD_PROBE_PATHS[(idx + 1) % AGENT_CARD_PROBE_PATHS.length]!;
    return [`${origin}${AGENT_CARD_PROBE_PATHS[idx]!}`, `${origin}${other}`];
  }
  return AGENT_CARD_PROBE_PATHS.map((p) => `${origin}${p}`);
}

/**
 * 解析用户输入的地址（`192.168.1.20:8080` / `http://kitchen.local:3000` / 完整卡地址）。
 * 字面 IP 必须是私网；域名留给真 IO 在 DNS 解析后判（见 `defaultAgentDiscoveryIo`）。
 */
export function parseProbeTarget(input: string): ProbeTarget {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: '请填写终端地址（例如 192.168.1.20:8080）。' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: `地址格式无法解析：${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只支持 http/https 地址（当前 ${url.protocol}）。` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: '地址里不能带账号密码——探测请求不应携带凭据。' };
  }
  const host = stripBrackets(url.hostname).toLowerCase();
  if (!host) return { ok: false, reason: '地址缺少主机名。' };
  const literal = isIP(host) !== 0;
  if (literal && !isPrivateAddress(host)) {
    return { ok: false, reason: `只允许私网地址（${host} 不是私网）——发现不扫公网、不扫网段。` };
  }
  const needsDns = !literal && host !== 'localhost';
  return {
    ok: true,
    candidates: candidatesFor(url),
    endpoint: url.origin,
    address: host,
    port: url.port ? Number(url.port) : null,
    needsDns,
  };
}

// ── 探测 IO ───────────────────────────────────────────────────────────────────

export interface AgentCardProbe {
  ok: boolean;
  card: DiscoveredAgentCard | null;
  cardUrl: string | null;
  status: number | null;
  reason: string;
  bodyBytes: number;
}

export interface AgentDiscoveryIo {
  probe(url: URL, opts: { timeoutMs: number; maxBytes: number }): Promise<AgentCardProbe>;
}

type PrivateLookup = (
  hostname: string,
  options: { family?: number; hints?: number; all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void,
) => void;

/**
 * 真 IO：GET 一次，**不跟随重定向**、**有界超时/体积**；DNS 解析结果必须是私网。
 * 只读，不发任何写请求；`accept: application/json` 不带凭据。
 */
export function defaultAgentDiscoveryIo(): AgentDiscoveryIo {
  const privateLookup: PrivateLookup = (hostname, options, callback) => {
    dns.lookup(hostname, { family: options.family, hints: options.hints, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0 || !list.every((a) => isPrivateAddress(a.address))) {
        return callback(new Error('目标域名解析到非私网地址'), '', 0);
      }
      const first = list[0]!;
      callback(null, first.address, first.family);
    });
  };

  return {
    probe(url, opts) {
      return new Promise<AgentCardProbe>((resolve) => {
        let settled = false;
        let timedOut = false;
        const done = (r: AgentCardProbe): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        const fail = (status: number | null, reason: string, bodyBytes = 0): void =>
          done({ ok: false, card: null, cardUrl: url.toString(), status, reason, bodyBytes });

        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(
          url,
          {
            method: 'GET',
            headers: { accept: 'application/json' },
            lookup: privateLookup as unknown as http.RequestOptions['lookup'],
          },
          (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.resume();
              fail(status, `目标返回重定向（HTTP ${status}），已按安全约定拒绝跟随——请直接填写最终地址`);
              return;
            }
            if (status !== 200) {
              res.resume();
              fail(status, `目标返回 HTTP ${status}`);
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > opts.maxBytes) {
                req.destroy();
                fail(status, `响应体超过上限（${opts.maxBytes} 字节），已断开`, bytes);
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              if (settled) return;
              let raw: unknown;
              try {
                raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              } catch {
                fail(status, '返回内容不是合法 JSON', bytes);
                return;
              }
              const card = parseAgentCard(raw);
              if (!card) {
                fail(status, '返回内容不是可识别的 agent 卡片（缺少 name）', bytes);
                return;
              }
              done({ ok: true, card, cardUrl: url.toString(), status, reason: '', bodyBytes: bytes });
            });
          },
        );
        req.setTimeout(opts.timeoutMs, () => {
          timedOut = true;
          req.destroy();
        });
        req.on('error', (e: NodeJS.ErrnoException) => {
          if (timedOut) return fail(null, `探测超时（>${opts.timeoutMs}ms）`);
          const msg = e?.message || String(e);
          return fail(null, msg.includes('非私网') ? `目标域名解析到非私网地址，已拒绝` : `请求失败：${msg}`);
        });
        req.end();
      });
    },
  };
}

// ── 发现编排 ──────────────────────────────────────────────────────────────────

export interface DiscoveredAgent {
  id: string;
  name: string;
  endpoint: string;
  address: string;
  port: number | null;
  /** 成功命中的门牌完整地址（两跳中的哪一跳——如实可查）。 */
  cardUrl: string;
  card: DiscoveredAgentCard;
  source: 'manual' | 'mdns';
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface DiscoverAttempt { url: string; reason: string }
export type DiscoverResult =
  | { ok: true; agent: DiscoveredAgent }
  | { ok: false; reason: string; attempts: DiscoverAttempt[] };

export interface DiscoverOpts {
  io?: AgentDiscoveryIo;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  source?: 'manual' | 'mdns';
}

export function discoveredAgentId(name: string, endpoint: string): string {
  return createHash('sha1').update(`${name}|${endpoint}`).digest('hex').slice(0, 12);
}

/** 内存待接入列表（发现≠授权：不落库、不铸凭据）。 */
const discovered = new Map<string, DiscoveredAgent>();

function recordDiscovered(agent: Omit<DiscoveredAgent, 'firstSeenMs' | 'lastSeenMs'>, nowMs: number): DiscoveredAgent {
  const prev = discovered.get(agent.id);
  const item: DiscoveredAgent = {
    ...agent,
    firstSeenMs: prev?.firstSeenMs ?? nowMs,
    lastSeenMs: nowMs,
  };
  discovered.set(item.id, item);
  return item;
}

/** 探测一台终端：两跳门牌依次试；结果只进内存待接入列表（调用方决定是否展示）。 */
export async function discoverAgent(input: string, opts: DiscoverOpts = {}): Promise<DiscoverResult> {
  const target = parseProbeTarget(input);
  if (!target.ok) return { ok: false, reason: target.reason, attempts: [] };
  const io = opts.io ?? defaultAgentDiscoveryIo();
  const nowMs = (opts.now ?? Date.now)();
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DISCOVERY_MAX_BODY_BYTES;
  const attempts: DiscoverAttempt[] = [];

  for (const candidate of target.candidates) {
    let probed: AgentCardProbe;
    try {
      probed = await io.probe(new URL(candidate), { timeoutMs, maxBytes });
    } catch (e) {
      attempts.push({ url: candidate, reason: (e as Error)?.message || String(e) });
      continue;
    }
    if (!probed.ok || !probed.card) {
      attempts.push({ url: candidate, reason: probed.reason || '未取到卡片' });
      continue;
    }
    const agent = recordDiscovered(
      {
        id: discoveredAgentId(probed.card.name, target.endpoint),
        name: probed.card.name,
        endpoint: target.endpoint,
        address: target.address,
        port: target.port,
        cardUrl: probed.cardUrl || candidate,
        card: probed.card,
        source: opts.source ?? 'manual',
      },
      nowMs,
    );
    return { ok: true, agent };
  }
  return {
    ok: false,
    reason: `未找到 agent 卡片：${attempts.map((a) => `${a.url} → ${a.reason}`).join('；')}`,
    attempts,
  };
}

/** 清掉超时的项；返回仍有效的列表（按最近看见排序）。 */
export function listDiscovered(nowMs: number = Date.now()): DiscoveredAgent[] {
  for (const [id, item] of discovered) {
    if (nowMs - item.lastSeenMs > DISCOVERY_PENDING_TTL_MS) discovered.delete(id);
  }
  return [...discovered.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs || a.id.localeCompare(b.id));
}

/** 取走一项（点「接入」后归配对流程管）。过期即 null。 */
export function takeDiscovered(id: string, nowMs: number = Date.now()): DiscoveredAgent | null {
  const item = discovered.get(id);
  if (!item) return null;
  if (nowMs - item.lastSeenMs > DISCOVERY_PENDING_TTL_MS) {
    discovered.delete(id);
    return null;
  }
  discovered.delete(id);
  return item;
}

export function forgetDiscovered(id: string): void {
  discovered.delete(id);
}

/** 仅供受控回归清场（模块级内存态）。 */
export function __resetDiscoveredForTest(): void {
  discovered.clear();
}

// ── mDNS `_a2a._tcp` 有界扫描 ────────────────────────────────────────────────

export interface A2AAnnouncement {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  referer?: { address?: string };
  txt?: Record<string, unknown>;
}

export interface A2ABrowseIo {
  start(onFound: (ann: A2AAnnouncement) => void, onError?: (reason: string) => void): void;
  stop(): void;
}

export interface A2ATarget { name: string; address: string; port: number | null }

/** 从一条广播里挑出**私网**目标；没有私网地址如实返回 null（不拿公网地址去探测）。 */
export function a2aAnnouncementTarget(ann: A2AAnnouncement): A2ATarget | null {
  const candidates = [
    ...(Array.isArray(ann.addresses) ? ann.addresses : []),
    ann.referer?.address,
    ann.host,
  ].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  const address = candidates.map((x) => stripBrackets(x.trim())).find((x) => isPrivateAddress(x));
  if (!address) return null;
  const port = typeof ann.port === 'number' && Number.isFinite(ann.port) ? ann.port : null;
  const txtName = ann.txt && typeof ann.txt.name === 'string' ? String(ann.txt.name).trim().slice(0, NAME_MAX) : '';
  const name = txtName || cleanStr(ann.name, NAME_MAX) || address;
  return { name, address, port };
}

export interface ScanOpts {
  browseIo?: A2ABrowseIo;
  io?: AgentDiscoveryIo;
  now?: () => number;
  scanMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  isSilenced?: (t: { name: string; address: string }) => boolean;
}

export interface DiscoveryScanResult {
  agents: DiscoveredAgent[];
  /** 听到的私网目标数（探测成功的不一定等于它——如实分开）。 */
  targets: number;
  /** mDNS 起不来/扫描失败的原因（`null` = 正常）。 */
  error: string | null;
}

/**
 * 有界扫描：起浏览 → 等 `scanMs` → 停 → 逐台探测（最多 `A2A_SCAN_MAX_TARGETS`）。
 * ⚠ 只探测广播**主动**报出且地址属私网的目标；不扫网段、不遍历端口。
 */
export async function scanA2ADiscovery(opts: ScanOpts = {}): Promise<DiscoveryScanResult> {
  const browse = opts.browseIo ?? defaultA2ABrowseIo();
  const now = opts.now ?? Date.now;
  const scanMs = opts.scanMs ?? A2A_SCAN_DEFAULT_MS;
  const found = new Map<string, A2ATarget>();
  let error: string | null = null;

  try {
    browse.start(
      (ann) => {
        const target = a2aAnnouncementTarget(ann);
        if (!target) return;
        if (opts.isSilenced?.({ name: target.name, address: target.address })) return;
        found.set(`${target.address}:${target.port ?? ''}`, target);
      },
      (reason) => { error = reason; },
    );
  } catch (e) {
    error = (e as Error)?.message || String(e);
  }

  await new Promise<void>((resolve) => setTimeout(resolve, scanMs));
  try { browse.stop(); } catch { /* 已停 */ }

  const targets = [...found.values()].slice(0, A2A_SCAN_MAX_TARGETS);
  const agents: DiscoveredAgent[] = [];
  for (const t of targets) {
    const input = t.port != null ? `${t.address}:${t.port}` : t.address;
    const r = await discoverAgent(input, {
      ...(opts.io ? { io: opts.io } : {}),
      now: () => now(),
      source: 'mdns',
      ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
    });
    if (r.ok) agents.push(r.agent);
  }
  return { agents, targets: targets.length, error };
}

interface MdnsBrowser {
  on(ev: 'up', cb: (svc: A2AAnnouncement) => void): void;
  stop(): void;
}
interface MdnsBonjourCtor {
  new (): { find(opts: { type: string }): MdnsBrowser; destroy(): void };
}

/** 真 IO：bonjour-service 浏览 `_a2a._tcp`（惰性 import，rr 不触网）。 */
export function defaultA2ABrowseIo(): A2ABrowseIo {
  let stopped = false;
  let browser: MdnsBrowser | null = null;
  let bonjour: { destroy: () => void } | null = null;
  return {
    start(onFound, onError) {
      void (async () => {
        try {
          const mod = (await import('bonjour-service')) as unknown as { default?: MdnsBonjourCtor } & MdnsBonjourCtor;
          const Bonjour = (mod.default ?? mod) as MdnsBonjourCtor;
          const b = new Bonjour();
          bonjour = b;
          const br = b.find({ type: A2A_MDNS_SERVICE });
          browser = br;
          br.on('up', (svc) => {
            if (stopped) return;
            try { onFound(svc); } catch { /* 单条上报失败：忽略 */ }
          });
        } catch (e) {
          onError?.((e as Error)?.message || 'mDNS 不可用');
        }
      })();
    },
    stop() {
      stopped = true;
      try { browser?.stop?.(); } catch { /* 已停 */ }
      try { bonjour?.destroy?.(); } catch { /* 已销毁 */ }
      browser = null;
      bonjour = null;
    },
  };
}
