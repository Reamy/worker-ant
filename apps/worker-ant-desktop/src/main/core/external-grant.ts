/**
 * zx_20261121_2 M1「授·界」：**外部终端授权边界**的纯判据（零 electron / 零网络 / 可 rr 直跑）。
 *
 * 病根：`wa_external_terminals` 只有 `capabilities_json` + `grant_expires_at`——
 *   brief 要的「设备范围 / 频率 / 是否允许联动」三项没有字段，也没有执行点。
 *
 * 三把尺各一处：
 *   ① `scopeAllowsDevice`：这台终端能不能碰这台设备（全部 / 设备 id / 房间 / 品类，取并集）；
 *   ② `rateLimitVerdict`：滚动分钟/小时/天窗口是否已到上限（0/缺省 = 不限）；
 *   ③ `linkageAllowedOf`：多步/多设备意图计划是否被允许（单设备意图不受影响）。
 *
 * 缺省（`defaultGrant`）：全部设备 / 不限频 / 允许联动——**与现状一致，不静默收紧存量授权**。
 */
import { normalizeRoomName } from './device-registry.js';

export interface TerminalScope {
  mode: 'all' | 'selected';
  /** 设备 id 白名单（`selected` 时取并集）。 */
  devices: string[];
  /** 房间名（归一后精确匹配，大小写不敏感）。 */
  rooms: string[];
  /** 派生类目 `kind_class`。 */
  kinds: string[];
}

export interface TerminalRate {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
}

export interface TerminalGrant {
  scope: TerminalScope;
  rate: TerminalRate;
  linkageAllowed: boolean;
}

export interface TerminalGrantRow {
  scope_json?: string | null;
  rate_json?: string | null;
  linkage_allowed?: number | null;
}

/** 缺省边界：与现状一致（全部已授权设备 / 不限频 / 允许联动）。 */
export function defaultGrant(): TerminalGrant {
  return { scope: { mode: 'all', devices: [], rooms: [], kinds: [] }, rate: {}, linkageAllowed: true };
}

function strArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function rateOf(raw: unknown): TerminalRate {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: TerminalRate = {};
  for (const k of ['perMinute', 'perHour', 'perDay'] as const) {
    const n = Number(obj[k]);
    if (Number.isInteger(n) && n >= 0) out[k] = n;
  }
  return out;
}

/** 读一行的 grant；坏 JSON/脏值**逐项**回落（不把整个授权读成“全禁”）。 */
export function parseGrant(row: TerminalGrantRow | null | undefined): TerminalGrant {
  if (!row) return defaultGrant();
  const scopeRaw = parseJson(row.scope_json);
  const scopeObj = scopeRaw && typeof scopeRaw === 'object' && !Array.isArray(scopeRaw) ? scopeRaw as Record<string, unknown> : {};
  const mode = scopeObj.mode === 'selected' ? 'selected' : 'all';
  const scope: TerminalScope = {
    mode,
    devices: mode === 'selected' ? strArray(scopeObj.devices) : [],
    rooms: mode === 'selected' ? strArray(scopeObj.rooms).map(normalizeRoomName) : [],
    kinds: mode === 'selected' ? strArray(scopeObj.kinds) : [],
  };
  const linkageAllowed = row.linkage_allowed == null ? true : Number(row.linkage_allowed) !== 0;
  return { scope, rate: rateOf(parseJson(row.rate_json)), linkageAllowed };
}

/** 这台设备是否在该终端范围内（并集：设备 id / 房间 / 品类）。 */
export function scopeAllowsDevice(
  scope: TerminalScope,
  dev: { id?: string; room?: string; kind_class?: string },
): boolean {
  if (!scope || scope.mode === 'all') return true;
  const id = String(dev.id ?? '');
  if (id && scope.devices.includes(id)) return true;
  const room = normalizeRoomName(String(dev.room ?? '')).toLowerCase();
  if (room && scope.rooms.some((r) => normalizeRoomName(r).toLowerCase() === room)) return true;
  const kind = String(dev.kind_class ?? '').trim();
  if (kind && scope.kinds.includes(kind)) return true;
  return false;
}

export type RateVerdict =
  | { ok: true; used: { minute: number; hour: number; day: number } }
  | { ok: false; window: 'minute' | 'hour' | 'day'; limit: number; used: number };

/**
 * 滚动窗口频率判据。`timestampsMs` 为该终端**已发生**调用时刻（毫秒）；
 * 0/缺省上限 = 不限。到上限即拒（第 limit+1 次被拒）。
 */
export function rateLimitVerdict(limits: TerminalRate, timestampsMs: readonly number[], nowMs: number): RateVerdict {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const valid = timestampsMs.filter((t) => Number.isFinite(t) && t <= now);
  const used = {
    minute: valid.filter((t) => t > now - 60_000).length,
    hour: valid.filter((t) => t > now - 3_600_000).length,
    day: valid.filter((t) => t > now - 86_400_000).length,
  };
  const checks: Array<{ window: 'minute' | 'hour' | 'day'; limit: number | undefined; used: number }> = [
    { window: 'minute', limit: limits.perMinute, used: used.minute },
    { window: 'hour', limit: limits.perHour, used: used.hour },
    { window: 'day', limit: limits.perDay, used: used.day },
  ];
  for (const c of checks) {
    if (typeof c.limit === 'number' && Number.isInteger(c.limit) && c.limit > 0 && c.used >= c.limit) {
      return { ok: false, window: c.window, limit: c.limit, used: c.used };
    }
  }
  return { ok: true, used };
}

export type GrantValidation =
  | { ok: true; grant: TerminalGrant }
  | { ok: false; code: 'BAD_INPUT'; message: string };

/** 校验用户输入；all 模式不接受选择集，selected 模式允许空集（= 什么都不给）。 */
export function validateGrant(input: unknown): GrantValidation {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const scopeRaw = obj.scope && typeof obj.scope === 'object' && !Array.isArray(obj.scope)
    ? obj.scope as Record<string, unknown> : {};
  const modeRaw = scopeRaw.mode;
  const mode = modeRaw === undefined ? 'all' : modeRaw;
  if (mode !== 'all' && mode !== 'selected') return { ok: false, code: 'BAD_INPUT', message: 'scope.mode 只能是 all/selected' };
  const devices = strArray(scopeRaw.devices);
  const rooms = strArray(scopeRaw.rooms).map(normalizeRoomName).filter((r) => r.length > 0);
  const kinds = strArray(scopeRaw.kinds);
  if (mode === 'all' && (devices.length > 0 || rooms.length > 0 || kinds.length > 0)) {
    return { ok: false, code: 'BAD_INPUT', message: 'all 模式不接受设备/房间/品类选择集' };
  }
  const rateRaw = obj.rate && typeof obj.rate === 'object' && !Array.isArray(obj.rate)
    ? obj.rate as Record<string, unknown> : {};
  const rate: TerminalRate = {};
  for (const k of ['perMinute', 'perHour', 'perDay'] as const) {
    const v = rateRaw[k];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
      return { ok: false, code: 'BAD_INPUT', message: `${k} 须为 0..1000000 的整数` };
    }
    rate[k] = n;
  }
  const linkageRaw = obj.linkageAllowed;
  if (linkageRaw !== undefined && typeof linkageRaw !== 'boolean') {
    return { ok: false, code: 'BAD_INPUT', message: 'linkageAllowed 须为布尔' };
  }
  return {
    ok: true,
    grant: {
      scope: { mode, devices: mode === 'selected' ? devices : [], rooms: mode === 'selected' ? rooms : [], kinds: mode === 'selected' ? kinds : [] },
      rate,
      linkageAllowed: linkageRaw === undefined ? true : linkageRaw,
    },
  };
}

/** 给 IPC/UI 的形状（原样；保留默认来源说明由调用方加）。 */
export function grantPatch(grant: TerminalGrant): TerminalGrant {
  return {
    scope: { mode: grant.scope.mode, devices: [...grant.scope.devices], rooms: [...grant.scope.rooms], kinds: [...grant.scope.kinds] },
    rate: { ...grant.rate },
    linkageAllowed: grant.linkageAllowed,
  };
}
