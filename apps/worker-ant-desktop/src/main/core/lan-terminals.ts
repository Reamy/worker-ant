/**
 * zx_20261023_5 批四「现」——**工蚁看得见终端**。
 *
 * 病根（B10）：本机广播 `_workerant._tcp` 让**终端发现工蚁**，但工蚁自己**从不浏览** `_workerant-terminal._tcp`
 *   ——门外站着一台 AI 终端，主人得等它自己敲门才知道。
 *
 * 三条纪律：
 *   ① **发现 ≠ 授权**：浏览到的终端只进**内存待接入列表**（`lanPending`），**不落台账、不铸凭据**；
 *      用户点「接入」才走既有配对（`createPairRequestGuarded` → 核对码 → 批准 → 钥匙只回一次）。
 *   ② **30 秒无广播即消失**（`LAN_PENDING_TTL_MS`）：列表是"此刻谁在"，不是账本；过期就是不在。
 *   ③ **TXT 不进密钥**（罗尔斯·无知之幕）：只认 `name` / `version` / `caps` 三个键，其余**一律丢弃**；
 *      名字像凭据的键（token/secret/key/…）额外记入 `stripped`，供 UI/回归如实说"我丢了什么"。
 *
 * ⚠ **零 electron / 零 better-sqlite3 / 零网络**（同 `external-terminals.ts` / `device-registry.ts` 范式）：
 *   浏览 IO 走可注入 `TerminalBrowseIo`，真实现（`bonjour-service`）只在 `defaultTerminalBrowseIo()`
 *   里**惰性 import**——rr 注入假 IO 时既不触网、模块图也不拉依赖。
 * ⚠ 静默名单（24h）**落库**（`wa_lan_terminal_silence`）：只放内存的话，重启即忘，被拒的终端又能接着骚扰。
 *   `SilenceDb` 是最小库接口，rr 传内存库即可跑真实现。
 */
import { createHash } from 'node:crypto';
import { teamFeatureRefusal } from './team-gate.js';
import type { LicenseSettingDb } from './license.js';

/** 浏览的服务类型——与工蚁自己的 `_workerant._tcp` **区分**（谁发现谁，看服务名）。 */
export const LAN_TERMINAL_SERVICE_TYPE = 'workerant-terminal';

/** 30 秒无广播即从待接入列表移除。 */
export const LAN_PENDING_TTL_MS = 30_000;

/** 拒绝后的静默时长（24 小时）。 */
export const LAN_SILENCE_MS = 24 * 60 * 60 * 1000;

/** 只用到的库接口（同 `TerminalDb` 范式）——使本模块可在受控回归里跑真逻辑。 */
export interface SilenceDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** mDNS 回调收敛后的窄面（bonjour-service 的 service 对象按结构消费）。 */
export interface TerminalAnnouncement {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  referer?: { address?: string };
  txt?: Record<string, unknown>;
}

/** 待接入列表里的一项（**无凭据、无授权态**——只够人认出它是谁）。 */
export interface LanPendingTerminal {
  /** 稳定身份（`name|address` 的 sha1 前 12 位）；同一台重复广播 ⇒ 同一 id。 */
  id: string;
  name: string;
  address: string;
  port: number | null;
  version: string | null;
  /** 自述能力类目（来自 TXT `caps`；类目名，**不是**密钥）。 */
  capabilities: string[];
  /** 首次/最近一次听到广播的毫秒时刻（注入 `now` 便于回归）。 */
  firstSeenMs: number;
  lastSeenMs: number;
}

/** 浏览 IO 的可注入接口。`onError` 如实报"起不来的因"（不假装列表为空＝没人）。 */
export interface TerminalBrowseIo {
  start(onFound: (ann: TerminalAnnouncement) => void, onError?: (reason: string) => void): void;
  stop(): void;
}

// ── TXT 白名单 ────────────────────────────────────────────────────────────────

/** 只认这三个键；其余丢弃。`caps` 是**能力类目**（如 `device_control`），不是凭据。 */
export const TERMINAL_TXT_ALLOWED_KEYS = ['name', 'version', 'caps'] as const;

/** 名字/值里像凭据的键——即便不在白名单，也单独列出（"我丢了什么"要能说清）。 */
const CREDENTIAL_KEY_RE = /(secret|token|key|pass|pwd|credential|signature|\bsig\b|auth)/i;

const TXT_VALUE_MAX = 64;
const TXT_CAPS_MAX = 8;

export interface SanitizedTerminalTxt {
  name: string | null;
  version: string | null;
  capabilities: string[];
  /** 被丢弃的键名（含凭据样键）；UI/回归据此如实说明。 */
  stripped: string[];
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, TXT_VALUE_MAX);
  return s.length ? s : null;
}

/**
 * TXT 收敛：白名单外的键一律丢弃；`caps` 收成字符串数组（逗号分隔或数组两形都认）。
 * ⚠ 永不把 TXT 原值带出去——返回值里只有上面三种。
 */
export function sanitizeTerminalTxt(txt: Record<string, unknown> | undefined | null): SanitizedTerminalTxt {
  const out: SanitizedTerminalTxt = { name: null, version: null, capabilities: [], stripped: [] };
  if (!txt || typeof txt !== 'object') return out;
  for (const [key, value] of Object.entries(txt)) {
    const allowed = (TERMINAL_TXT_ALLOWED_KEYS as readonly string[]).includes(key);
    // Buffer 形态（bonjour-service 有时给 Buffer）不是本约定的一部分——当作不可用值丢掉。
    if (!allowed || Buffer.isBuffer(value)) {
      out.stripped.push(CREDENTIAL_KEY_RE.test(key) ? `${key}(credential-like)` : key);
      continue;
    }
    if (key === 'name') out.name = cleanText(value);
    else if (key === 'version') out.version = cleanText(value);
    else if (key === 'caps') {
      const raw = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value.split(',')
          : [];
      out.capabilities = raw
        .map((v) => cleanText(typeof v === 'string' ? v : null))
        .filter((v): v is string => !!v)
        .slice(0, TXT_CAPS_MAX);
    }
  }
  return out;
}

// ── 内存待接入列表 ────────────────────────────────────────────────────────────

const lanPending = new Map<string, LanPendingTerminal>();

/** 稳定 id（同 `name|address` ⇒ 同一台；名字变化即视为另一台，如实并列而非合并猜测）。 */
export function lanPendingId(name: string, address: string): string {
  return createHash('sha1').update(`${name}|${address}`).digest('hex').slice(0, 12);
}

/** 静默判据的输入窄面（`name`/`address` 任一命中即静默）。 */
export interface LanIdentity { name: string; address: string }

function announcementAddress(ann: TerminalAnnouncement): string | null {
  const a = ann.referer?.address || ann.addresses?.find((x) => typeof x === 'string' && x.length > 0) || ann.host;
  return typeof a === 'string' && a.trim() ? a.trim() : null;
}

/**
 * 收一条广播。返回 `null` 的情形都**如实**：无地址 / 已静默（拒过的别再来）。
 * 同一 id 重复广播只更新 `lastSeenMs`（`firstSeenMs` 保持第一次）。
 */
export function ingestLanAnnouncement(
  ann: TerminalAnnouncement,
  nowMs: number = Date.now(),
  opts: { isSilenced?: (t: LanIdentity) => boolean } = {},
): LanPendingTerminal | null {
  const address = announcementAddress(ann);
  if (!address) return null;
  const clean = sanitizeTerminalTxt(ann.txt);
  const name = clean.name || cleanText(ann.name) || cleanText(ann.host) || address;
  if (!name) return null;
  const identity: LanIdentity = { name, address };
  if (opts.isSilenced?.(identity)) return null;
  const id = lanPendingId(name, address);
  const prev = lanPending.get(id);
  const item: LanPendingTerminal = {
    id,
    name,
    address,
    port: typeof ann.port === 'number' && Number.isFinite(ann.port) ? ann.port : null,
    version: clean.version,
    capabilities: clean.capabilities,
    firstSeenMs: prev?.firstSeenMs ?? nowMs,
    lastSeenMs: nowMs,
  };
  lanPending.set(id, item);
  return item;
}

/** 清掉 30 秒没再听到的项；返回仍有效的列表（按最近听到排序）。 */
export function listLanPending(nowMs: number = Date.now()): LanPendingTerminal[] {
  for (const [id, item] of lanPending) {
    if (nowMs - item.lastSeenMs > LAN_PENDING_TTL_MS) lanPending.delete(id);
  }
  return [...lanPending.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs || a.id.localeCompare(b.id));
}

/** 取走一项（点「接入」后它归配对流程管，不再留在发现列表里）。过期即 null。 */
export function takeLanPending(id: string, nowMs: number = Date.now()): LanPendingTerminal | null {
  const item = lanPending.get(id);
  if (!item) return null;
  if (nowMs - item.lastSeenMs > LAN_PENDING_TTL_MS) {
    lanPending.delete(id);
    return null;
  }
  lanPending.delete(id);
  return item;
}

/** 仅供受控回归清场（模块级内存态）。 */
export function __resetLanPendingForTest(): void {
  lanPending.clear();
  stopTerminalBrowse();
  browseError = null;
}

// ── 静默名单（24h，落库） ─────────────────────────────────────────────────────

function silenceIdentityKey(t: LanIdentity): string {
  return `${t.name}|${t.address}`.toLowerCase();
}

/** 是否仍在静默期（`silenced_until` 存 epoch ms）。读库失败按"未静默"处理（不因读不出来就永拒）。 */
export function isLanTerminalSilenced(db: SilenceDb, t: LanIdentity, nowMs: number = Date.now()): boolean {
  try {
    const row = db
      .prepare('SELECT silenced_until FROM wa_lan_terminal_silence WHERE identity = ?')
      .get(silenceIdentityKey(t)) as { silenced_until?: unknown } | undefined;
    const until = Number(row?.silenced_until ?? 0);
    return Number.isFinite(until) && until > nowMs;
  } catch {
    return false;
  }
}

/** 拒绝一台发现到的终端：写/续 24 小时静默（同一台再拒即从此刻重新计时）。 */
export function silenceLanTerminal(db: SilenceDb, t: LanIdentity, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO wa_lan_terminal_silence (identity, name, address, silenced_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(identity) DO UPDATE SET
       name = excluded.name, address = excluded.address, silenced_until = excluded.silenced_until`,
  ).run(silenceIdentityKey(t), t.name, t.address, nowMs + LAN_SILENCE_MS);
  lanPending.delete(lanPendingId(t.name, t.address));
}

/** 清掉已过期的静默行（启动/拒绝时顺手做，表不会只增不减）。 */
export function pruneLanSilences(db: SilenceDb, nowMs: number = Date.now()): number {
  try {
    const r = db.prepare('DELETE FROM wa_lan_terminal_silence WHERE silenced_until <= ?').run(nowMs) as { changes?: unknown };
    return Number(r?.changes ?? 0);
  } catch {
    return 0;
  }
}

// ── 浏览起停 ──────────────────────────────────────────────────────────────────

let active: TerminalBrowseIo | null = null;
let browseError: string | null = null;

export interface StartBrowseOpts {
  io?: TerminalBrowseIo;
  now?: () => number;
  isSilenced?: (t: LanIdentity) => boolean;
  /** 每收一条新广播回调（接线据此发 `external.lan_changed`，面板不等轮询）。 */
  onDiscovered?: (item: LanPendingTerminal) => void;
}

/** 起浏览（可重复调用：先停旧的，避免多份 browser 叠着）。 */
export function startTerminalBrowse(opts: StartBrowseOpts = {}): void {
  stopTerminalBrowse();
  const io = opts.io ?? defaultTerminalBrowseIo();
  const now = opts.now ?? Date.now;
  active = io;
  browseError = null;
  try {
    io.start(
      (ann) => {
        const item = ingestLanAnnouncement(ann, now(), { isSilenced: opts.isSilenced });
        if (item) opts.onDiscovered?.(item);
      },
      (reason) => { browseError = reason; },
    );
  } catch (e) {
    browseError = (e as Error)?.message || String(e);
    active = null;
  }
}

export function stopTerminalBrowse(): void {
  if (!active) return;
  const io = active;
  active = null;
  try { io.stop(); } catch { /* 收摊噪声 */ }
}

export function isTerminalBrowseRunning(): boolean {
  return active != null;
}

/** 起不来的**因**（`null` = 正常）；UI 据此如实说明"列表空"是没人还是看不见。 */
export function terminalBrowseError(): string | null {
  return browseError;
}

// ── 常驻发现：随入站门起停（zx_20261029_2 M4）────────────────────────────────
//
// 病根：浏览此前只在「协同面板」打开时由 `external:lanList` 惰性拉起（`ensureLanBrowse`）——
//   用户不打开那一页，门外广播的终端就**永远看不见**。M4 改为**常驻**：入站门开启且 Team 解锁即起，
//   关门即停；面板只读状态，不再兼任"开关"。

/** 常驻发现归属的 Team 能力（M4 明确用 `multi_node`；所有 Team 能力同闸同解）。 */
export const LAN_BROWSE_FEATURE = 'multi_node' as const;

/**
 * 常驻发现的**实况**（只读）：`running` 是浏览真在跑；未跑的原因分开如实说——
 * `locked`（Team 未解锁）/ `door_open=false`（入站门没开）/ `error`（起了但 mDNS 报错）。
 */
export interface TerminalBrowseStatusPayload {
  running: boolean;
  error: string | null;
  locked: boolean;
  door_open: boolean;
  detail: string;
}

/** 起停面：`main/index.ts` 在入站门开/关的**同一条路**上调用（不另写一份起停次序）。 */
export interface TerminalBrowseLifecycle {
  /** 满足「Team 解锁 ∧ 入站门在监听」才起；返回是否已在跑。 */
  start(): boolean;
  stop(): void;
  status(): TerminalBrowseStatusPayload;
}

export interface TerminalBrowseLifecycleOpts {
  io?: TerminalBrowseIo;
  /** 入站门是否**真在监听**（由装配层注入 `isInboundRunning`；缺省视为已开，便于单测）。 */
  isDoorRunning?: () => boolean;
  /** 每收一条新广播回调（面板据此即时刷新；本模块不触 event-bus）。 */
  onDiscovered?: (item: LanPendingTerminal) => void;
}

/**
 * 绑定一个库与门态，产出常驻发现的起停控制器（**唯一编排**）。
 * 幂等：已在跑时 `start()` 不再重起（重复 start 会丢掉已听到的列表）；`stop()` 未起即空操作。
 */
export function createTerminalBrowseLifecycle(
  db: SilenceDb & LicenseSettingDb,
  opts: TerminalBrowseLifecycleOpts = {},
): TerminalBrowseLifecycle {
  const isDoorRunning = opts.isDoorRunning ?? (() => true);

  const status = (): TerminalBrowseStatusPayload => {
    const locked = teamFeatureRefusal(db, LAN_BROWSE_FEATURE) != null;
    const doorOpen = isDoorRunning();
    const running = isTerminalBrowseRunning();
    const error = terminalBrowseError();
    let detail: string;
    if (locked) {
      detail = '局域网常驻发现属团队版能力（本机当前档位未解锁）。';
    } else if (!doorOpen) {
      detail = '入站门未开——常驻发现随入站门起停，先在「协同面板」页开启入站门。';
    } else if (error) {
      detail = `局域网常驻发现未能启动：${error}`;
    } else if (running) {
      detail = '局域网常驻发现在运行（广播中的 AI 终端会进入待接入列表，30 秒无广播即消失）。';
    } else {
      detail = '入站门已开，但局域网常驻发现尚未启动。';
    }
    return { running, error, locked, door_open: doorOpen, detail };
  };

  const start = (): boolean => {
    if (teamFeatureRefusal(db, LAN_BROWSE_FEATURE)) return false;
    if (!isDoorRunning()) return false;
    if (isTerminalBrowseRunning()) return true;
    try { pruneLanSilences(db); } catch { /* 清过期静默失败不拦浏览 */ }
    startTerminalBrowse({
      ...(opts.io ? { io: opts.io } : {}),
      isSilenced: (t: LanIdentity) => isLanTerminalSilenced(db, t),
      ...(opts.onDiscovered ? { onDiscovered: opts.onDiscovered } : {}),
    });
    return isTerminalBrowseRunning();
  };

  return { start, stop: stopTerminalBrowse, status };
}

/**
 * 真 IO：bonjour-service 浏览 `_workerant-terminal._tcp`。
 * ⚠ 只**听**不连、不鉴权、不落盘——发现是"看见"，不是"进门"。
 */
interface MdnsTerminalBrowser {
  on(ev: 'up', cb: (svc: TerminalAnnouncement) => void): void;
  stop(): void;
}
interface MdnsBonjourCtor {
  new (): { find(opts: { type: string }): MdnsTerminalBrowser; destroy(): void };
}

export function defaultTerminalBrowseIo(): TerminalBrowseIo {
  let stopped = false;
  let browser: MdnsTerminalBrowser | null = null;
  let bonjour: { destroy: () => void } | null = null;
  return {
    start(onFound, onError) {
      void (async () => {
        try {
          const mod = (await import('bonjour-service')) as unknown as { default?: MdnsBonjourCtor } & MdnsBonjourCtor;
          const Bonjour = (mod.default ?? mod) as MdnsBonjourCtor;
          const b = new Bonjour();
          bonjour = b;
          const br = b.find({ type: LAN_TERMINAL_SERVICE_TYPE });
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
