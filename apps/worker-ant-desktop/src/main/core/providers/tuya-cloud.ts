/**
 * zx_20261017_1 批八（庄子·物各有宜／管子·度量衡）: **涂鸦云（Tuya Cloud）适配层**——三方云首切片。
 *
 * 三件纯事 + 一件可注入的网络事：
 *   ① **签名**（`tuyaSign` / `tuyaStringToSign`）——纯函数，固定输入 ⇒ 固定输出（rr 直测）。
 *   ② **配置**（`resolveTuyaConfig` / `tuyaConfigStatus`）——读设置，**Secret 只暴露"是否已配"**。
 *   ③ **命令映射**（`tuyaCommands`）——把通用 action 翻成涂鸦数据点命令；翻不出就如实拒。
 *   ④ **HTTP**（`createTuyaProvider`）——`TuyaHttp` **可注入**（回归喂假、不触网）；缺省实现用 `fetch`。
 *
 * ⚠ **只用涂鸦官方区域端点**（`TUYA_REGION_HOSTS` 固定域名）——调用方**不能**传任意 URL，
 *   适配层不成为任意出站通道。
 * ⚠ **token 失败不重试、不把旧 token 当成功**：拉不到令牌就把原因如实抛给同步层（"空态 + 原因"）。
 * ⚠ Provider 不碰台账/授权/审计——那些在 `device-registry` + `runDeviceControl`（语义不搬家）。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { DeviceTestResult } from '../device-diagnostics.js';
import { kindClassOf } from '../device-kind.js';
import {
  registerDeviceProvider,
  type DeviceProvider,
  type ProviderControlResult,
  type ProviderDevice,
  type ProviderStateResult,
} from '../device-provider.js';

// ==================== 设置键与区域（词表真源在 `tuya-regions.ts`） ====================

export {
  TUYA_REGIONS,
  TUYA_REGION_LABEL,
  TUYA_SETTING_ACCESS_ID,
  TUYA_SETTING_ACCESS_SECRET,
  TUYA_SETTING_REGION,
  type TuyaRegion,
} from './tuya-regions.js';
import {
  TUYA_REGIONS,
  TUYA_REGION_LABEL,
  TUYA_SETTING_ACCESS_ID,
  TUYA_SETTING_ACCESS_SECRET,
  TUYA_SETTING_REGION,
  type TuyaRegion,
} from './tuya-regions.js';

/** 涂鸦官方区域端点（**固定域名**；不要从设置里读 URL——那会让适配层变成任意出站通道）。 */
export const TUYA_REGION_HOSTS: Record<TuyaRegion, string> = {
  cn: 'https://openapi.tuyacn.com',
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  in: 'https://openapi.tuyain.com',
};

/** 项目设备列表分页（涂鸦上限 20/页；翻页上限防"无限 has_more"把同步拖死）。 */
export const TUYA_PAGE_SIZE = 20;
export const TUYA_MAX_PAGES = 25;
export const TUYA_TIMEOUT_MS = 10_000;

export const TUYA_PROVIDER_ID = 'tuya';

// ==================== 配置 ====================

/** 一份可用的涂鸦凭据（只在 main 进程内存中流转；**绝不**回渲染层）。 */
export interface TuyaConfig {
  region: TuyaRegion;
  accessId: string;
  accessSecret: string;
}

function parseRegion(raw: string | null): TuyaRegion {
  const v = (raw ?? '').trim();
  return (TUYA_REGIONS as readonly string[]).includes(v) ? (v as TuyaRegion) : 'cn';
}

/** 凭据齐 ⇒ 配置；缺任一项 ⇒ `null`（不拿半份凭据去触网）。 */
export function resolveTuyaConfig(settingsGet: (key: string) => string | null): TuyaConfig | null {
  const accessId = (settingsGet(TUYA_SETTING_ACCESS_ID) ?? '').trim();
  const accessSecret = (settingsGet(TUYA_SETTING_ACCESS_SECRET) ?? '').trim();
  if (!accessId || !accessSecret) return null;
  return { region: parseRegion(settingsGet(TUYA_SETTING_REGION)), accessId, accessSecret };
}

/** 回渲染层的配置态——**没有 Secret 字段**（只说配没配）。 */
export interface TuyaConfigStatus {
  configured: boolean;
  region: TuyaRegion;
  regionLabel: string;
  accessId: string;
  accessIdSet: boolean;
  secretSet: boolean;
}

export function tuyaConfigStatus(settingsGet: (key: string) => string | null): TuyaConfigStatus {
  const accessId = (settingsGet(TUYA_SETTING_ACCESS_ID) ?? '').trim();
  const secret = (settingsGet(TUYA_SETTING_ACCESS_SECRET) ?? '').trim();
  const region = parseRegion(settingsGet(TUYA_SETTING_REGION));
  return {
    configured: accessId !== '' && secret !== '',
    region,
    regionLabel: TUYA_REGION_LABEL[region],
    accessId,
    accessIdSet: accessId !== '',
    secretSet: secret !== '',
  };
}

// ==================== 签名（纯函数） ====================

/** 空体 sha256（涂鸦文档固定向量：`e3b0c442...`）。 */
export function tuyaBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** 待签串：`METHOD\n<bodySha256>\n\n<path?query>`（path 必须含前导 `/` 与已排好的查询串）。 */
export function tuyaStringToSign(method: string, path: string, body = ''): string {
  return `${method.toUpperCase()}\n${tuyaBodyHash(body)}\n\n${path}`;
}

export interface TuyaSignInput {
  accessId: string;
  accessSecret: string;
  /** 10/13 位时间戳（字符串或数字同义）。 */
  t: number | string;
  method: string;
  path: string;
  body?: string;
  accessToken?: string;
  nonce: string;
}

/**
 * 涂鸦 HMAC-SHA256 签名（大写十六进制）。
 * 待签消息 = `clientId + accessToken + t + nonce + stringToSign`（token 请求时 accessToken 为空）。
 */
export function tuyaSign(input: TuyaSignInput): string {
  const message = `${input.accessId}${input.accessToken ?? ''}${String(input.t)}${input.nonce}${tuyaStringToSign(input.method, input.path, input.body ?? '')}`;
  return createHmac('sha256', input.accessSecret).update(message, 'utf8').digest('hex').toUpperCase();
}

/** 一组合法 nonce（无连字符 uuid；调用方可注入以固定向量）。 */
export function newTuyaNonce(): string {
  return randomUUID().replace(/-/g, '');
}

/** 签名头（`t`/`nonce` 显式传入 ⇒ 受控回归可钉固定向量）。 */
export function tuyaSignedHeaders(input: {
  config: TuyaConfig;
  method: string;
  path: string;
  body?: string;
  accessToken?: string;
  t: number;
  nonce: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    client_id: input.config.accessId,
    sign: tuyaSign({
      accessId: input.config.accessId,
      accessSecret: input.config.accessSecret,
      t: input.t,
      method: input.method,
      path: input.path,
      body: input.body,
      accessToken: input.accessToken,
      nonce: input.nonce,
    }),
    sign_method: 'HMAC-SHA256',
    t: String(input.t),
    nonce: input.nonce,
    'Content-Type': 'application/json',
  };
  if (input.accessToken) headers.access_token = input.accessToken;
  return headers;
}

// ==================== HTTP（可注入） ====================

export interface TuyaHttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface TuyaHttpResponse {
  status: number;
  body: string;
}

/** 真网络唯一落点（回归注入假的 `TuyaHttp` ⇒ 不触网）。 */
export type TuyaHttp = (url: string, init: TuyaHttpInit) => Promise<TuyaHttpResponse>;

export async function defaultTuyaHttp(url: string, init: TuyaHttpInit): Promise<TuyaHttpResponse> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(TUYA_TIMEOUT_MS),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 200_000) };
}

interface TuyaEnvelope {
  success?: unknown;
  result?: unknown;
  code?: unknown;
  msg?: unknown;
}

type ParsedEnvelope = { ok: true; result: unknown } | { ok: false; error: string };

function parseEnvelope(raw: string): ParsedEnvelope {
  let json: TuyaEnvelope;
  try {
    json = JSON.parse(raw) as TuyaEnvelope;
  } catch {
    return { ok: false, error: `返回非 JSON：${raw.slice(0, 160) || '（空体）'}` };
  }
  if (json?.success !== true) {
    return { ok: false, error: `涂鸦云返回失败：code=${String(json?.code ?? '?')} msg=${String(json?.msg ?? '')}` };
  }
  return { ok: true, result: json.result };
}

// ==================== 令牌获取（Provider 与探活共用一段） ====================

interface TuyaToken {
  token: string;
  expiresAt: number;
}

/**
 * 取一次访问令牌（**不缓存**，缓存归调用方）。失败即抛，`error` 里如实带 HTTP 状态与响应片段。
 * ⚠ 签名时间戳与过期判断都走注入的 `now`（rr 不碰墙钟）。
 */
async function requestTuyaToken(
  config: TuyaConfig,
  http: TuyaHttp,
  now: () => Date,
): Promise<TuyaToken> {
  const host = TUYA_REGION_HOSTS[config.region];
  const t = now().getTime();
  const path = '/v1.0/token?grant_type=1';
  const headers = tuyaSignedHeaders({ config, method: 'GET', path, t, nonce: newTuyaNonce() });
  const res = await http(`${host}${path}`, { method: 'GET', headers });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`获取访问令牌失败：HTTP ${res.status} ${res.body.slice(0, 160)}`);
  }
  const env = parseEnvelope(res.body);
  if (!env.ok) throw new Error(`获取访问令牌失败：${env.error}`);
  const result = env.result as { access_token?: unknown; expire_time?: unknown };
  const token = typeof result?.access_token === 'string' ? result.access_token : '';
  if (!token) throw new Error('获取访问令牌失败：返回中无 access_token');
  const expire = Number(result?.expire_time);
  return {
    token,
    // 提前 60s 过期，避免"刚取到就失效"；缺 expire_time 时只当 60s（不假设很长的寿命）。
    expiresAt: now().getTime() + (Number.isFinite(expire) ? Math.max(expire - 60, 0) * 1000 : 60_000),
  };
}

// ==================== 探活（令牌 + 设备总数，一次有界往返） ====================

export interface TuyaProbeDeps {
  http?: TuyaHttp;
  now?: () => Date;
}

/**
 * 一次"测试连接"：取令牌 → 拉一页设备（`page_size=1`）读官方 `total`。
 * ⚠ 只说明"凭据有效、云答了、账号下有多少台"——**不**拉全量（探活不该把同步活干一遍）。
 * ⚠ 端点只报区域主域名，**永不**含 accessId/secret。
 */
export async function probeTuya(config: TuyaConfig, deps: TuyaProbeDeps = {}): Promise<DeviceTestResult> {
  const http = deps.http ?? defaultTuyaHttp;
  const now = deps.now ?? (() => new Date());
  const host = TUYA_REGION_HOSTS[config.region];
  const endpoint = host;
  const started = now().getTime();
  try {
    const token = await requestTuyaToken(config, http, now);
    const path = '/v1.0/devices?page_no=1&page_size=1';
    const headers = tuyaSignedHeaders({
      config, method: 'GET', path, accessToken: token.token, t: now().getTime(), nonce: newTuyaNonce(),
    });
    const res = await http(`${host}${path}`, { method: 'GET', headers });
    const latencyMs = Math.max(0, now().getTime() - started);
    if (res.status < 200 || res.status >= 300) {
      return {
        target: 'tuya', ok: false, endpoint, protocol: 'https', latencyMs,
        detail: `设备列表拉取失败：HTTP ${res.status} ${res.body.slice(0, 160)}`,
      };
    }
    const env = parseEnvelope(res.body);
    if (!env.ok) {
      return { target: 'tuya', ok: false, endpoint, protocol: 'https', latencyMs, detail: `设备列表拉取失败：${env.error}` };
    }
    const result = env.result as { total?: unknown; devices?: unknown };
    const total = Number(result?.total);
    const deviceCount = Number.isFinite(total)
      ? total
      : Array.isArray(result?.devices) ? result.devices.length : undefined;
    return {
      target: 'tuya', ok: true, endpoint, protocol: 'https', latencyMs,
      ...(deviceCount != null ? { deviceCount } : {}),
      detail: deviceCount != null
        ? `令牌获取成功 · 账号下 ${deviceCount} 台设备（${latencyMs}ms）`
        : `令牌获取成功（云未返回设备总数，${latencyMs}ms）`,
    };
  } catch (e) {
    const latencyMs = Math.max(0, now().getTime() - started);
    return {
      target: 'tuya', ok: false, endpoint, protocol: 'https', latencyMs,
      detail: `${(e as Error)?.message || String(e)}`,
    };
  }
}

// ==================== 状态查询（设备详情 → 数据点） ====================

/** 把设备详情的 `status`（`[{code,value}]` 或对象）摊成 `values`。 */
function tuyaStateValues(raw: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const code = typeof (item as { code?: unknown })?.code === 'string' ? String((item as { code: string }).code) : '';
      if (code) values[code] = (item as { value?: unknown }).value;
    }
  } else if (raw != null && typeof raw === 'object') {
    Object.assign(values, raw as Record<string, unknown>);
  }
  return values;
}

// ==================== 命令映射（纯函数） ====================

export interface TuyaCommand {
  code: string;
  value: unknown;
}

export type TuyaCommandPlan = { commands: TuyaCommand[] } | { error: string };

/**
 * 通用 action → 涂鸦数据点命令。
 *   · `turn_on` / `turn_off`：缺省数据点 `switch_1`（可用 `args.code` 覆盖，如灯用 `switch_led`）；
 *   · 其余动作视为"直接下数据点"：须给 `args.code` 且带 `value`——**翻不出就如实拒**，不猜。
 */
export function tuyaCommands(action: string, args: Record<string, unknown>): TuyaCommandPlan {
  const name = String(action ?? '').trim();
  const rawCode = typeof args.code === 'string' ? args.code.trim() : '';
  if (name === 'turn_on' || name === 'turn_off') {
    return { commands: [{ code: rawCode || 'switch_1', value: name === 'turn_on' }] };
  }
  if (!rawCode) {
    return { error: `动作「${name || '（空）'}」需在参数里给出涂鸦数据点 code（turn_on/turn_off 除外），拒绝猜测。` };
  }
  if (!('value' in args)) {
    return { error: `数据点「${rawCode}」缺少 value，拒绝下发。` };
  }
  return { commands: [{ code: rawCode, value: args.value }] };
}

// ==================== Provider ====================

/** 设备列表响应的一部分（只取本适配层认识的字段；其余如实留着不猜）。 */
interface TuyaDeviceRow {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  status?: unknown;
}

function mapTuyaDevice(raw: TuyaDeviceRow): ProviderDevice | null {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const kind = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'unknown';
  // 能力**取设备自述的数据点**（list 响应里的 `status` 条目）——没有数据点就不谎称可控。
  const caps = Array.isArray(raw.status)
    ? raw.status
      .map((s) => (typeof (s as { code?: unknown })?.code === 'string' ? String((s as { code: string }).code) : ''))
      .filter((c) => c !== '')
      .slice(0, 50)
    : [];
  // zx_20261029_2 M1: `kind` 保留涂鸦原始 category（设备自述），派生类目由唯一归一函数给出；
  //   表外 category ⇒ `unknown`（不拿设备名猜它是空调）。
  const kindClass = kindClassOf({ kind, protocol: 'cloud', provider: 'tuya', capabilities: caps });
  return { id, name, kind, kindClass, capabilities: caps, controllable: caps.length > 0 };
}

export interface TuyaProviderDeps {
  http?: TuyaHttp;
  /** `now` 可注入（token 缓存与签名时间戳都走它；rr 不碰真实墙钟）。 */
  now?: () => Date;
}

/**
 * 建一个涂鸦 Provider（每次调用独立 token 缓存）。
 * 失败一律以**异常**从 `listDevices` 冒泡（同步层收成"空态 + 原因"）；`control` 则回 `{ok:false}`。
 */
export function createTuyaProvider(config: TuyaConfig, deps: TuyaProviderDeps = {}): DeviceProvider {
  const http = deps.http ?? defaultTuyaHttp;
  const now = deps.now ?? (() => new Date());
  const host = TUYA_REGION_HOSTS[config.region];
  let cached: { token: string; expiresAt: number } | null = null;

  async function signedRequest(method: string, path: string, body?: string): Promise<{ accessToken: string } & TuyaHttpResponse> {
    const accessToken = await getToken();
    const t = now().getTime();
    const headers = tuyaSignedHeaders({ config, method, path, body, accessToken, t, nonce: newTuyaNonce() });
    const res = await http(`${host}${path}`, { method, headers, body });
    return { accessToken, ...res };
  }

  async function getToken(): Promise<string> {
    if (cached && cached.expiresAt > now().getTime()) return cached.token;
    const fresh = await requestTuyaToken(config, http, now);
    cached = { token: fresh.token, expiresAt: fresh.expiresAt };
    return fresh.token;
  }

  /**
   * zx_20261022_3 批三：设备详情 `/v1.0/devices/{id}` → `{values, online?}`。
   * ⚠ `values` 取设备自述数据点（`status`），**原样透传**；云没答 `online` 就不编一个。
   */
  async function getState(deviceId: string): Promise<ProviderStateResult> {
    try {
      const path = `/v1.0/devices/${encodeURIComponent(deviceId)}`;
      const res = await signedRequest('GET', path);
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `涂鸦云状态查询失败：HTTP ${res.status} ${res.body.slice(0, 160)}` };
      }
      const env = parseEnvelope(res.body);
      if (!env.ok) return { ok: false, error: `涂鸦云状态查询失败：${env.error}` };
      const detail = env.result as { online?: unknown; status?: unknown };
      const state: Record<string, unknown> = { values: tuyaStateValues(detail?.status) };
      if (typeof detail?.online === 'boolean') state.online = detail.online;
      return { ok: true, state };
    } catch (e) {
      return { ok: false, error: `涂鸦云状态查询失败：${(e as Error)?.message || String(e)}` };
    }
  }

  return {
    id: TUYA_PROVIDER_ID,
    label: '涂鸦云',

    async listDevices(): Promise<ProviderDevice[]> {
      // 先取令牌（失败即抛——**不重试、不拿旧 token 冒充成功**）。
      await getToken();
      const out: ProviderDevice[] = [];
      for (let page = 1; page <= TUYA_MAX_PAGES; page += 1) {
        const path = `/v1.0/devices?page_no=${page}&page_size=${TUYA_PAGE_SIZE}`;
        const res = await signedRequest('GET', path);
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`设备列表拉取失败：HTTP ${res.status} ${res.body.slice(0, 160)}`);
        }
        const env = parseEnvelope(res.body);
        if (!env.ok) throw new Error(`设备列表拉取失败：${env.error}`);
        const result = env.result as { devices?: unknown; has_more?: unknown };
        const rows = Array.isArray(result?.devices) ? (result.devices as TuyaDeviceRow[]) : [];
        for (const row of rows) {
          const dev = mapTuyaDevice(row);
          if (dev) out.push(dev);
        }
        if (result?.has_more !== true) break;
      }
      return out;
    },

    async control(deviceId: string, action: string, args: Record<string, unknown>): Promise<ProviderControlResult> {
      const plan = tuyaCommands(action, args);
      if ('error' in plan) return { ok: false, result: plan.error };
      const path = `/v1.0/devices/${encodeURIComponent(deviceId)}/commands`;
      try {
        const body = JSON.stringify(plan);
        const res = await signedRequest('POST', path, body);
        if (res.status < 200 || res.status >= 300) {
          return { ok: false, result: `涂鸦云下发失败：HTTP ${res.status} ${res.body.slice(0, 160)}` };
        }
        const env = parseEnvelope(res.body);
        if (!env.ok) return { ok: false, result: `涂鸦云下发失败：${env.error}` };
        return { ok: true, result: `涂鸦云已受理 ${action}` };
      } catch (e) {
        return { ok: false, result: `涂鸦云下发失败：${(e as Error)?.message || String(e)}` };
      }
    },

    getState,
  };
}

/**
 * 注册"从设置里现读凭据"的涂鸦 Provider（**启动时一次**，控制/同步时每次现读配置）。
 * 未配置时：`listDevices` 抛如实原因；`control` 回 `{ok:false}`（不静默成功）。
 */
export function registerTuyaCloudProvider(
  settingsGet: (key: string) => string | null,
  deps: TuyaProviderDeps = {},
): DeviceProvider {
  const provider: DeviceProvider = {
    id: TUYA_PROVIDER_ID,
    label: '涂鸦云',
    async listDevices(): Promise<ProviderDevice[]> {
      const config = resolveTuyaConfig(settingsGet);
      if (!config) throw new Error('涂鸦云凭据未配置（Access ID / Secret）');
      return createTuyaProvider(config, deps).listDevices();
    },
    async control(deviceId: string, action: string, args: Record<string, unknown>): Promise<ProviderControlResult> {
      const config = resolveTuyaConfig(settingsGet);
      if (!config) return { ok: false, result: '涂鸦云凭据未配置（Access ID / Secret），拒绝下发。' };
      return createTuyaProvider(config, deps).control(deviceId, action, args);
    },
    // 凭据未配 ⇒ 如实回 `unsupported` + 因由（不是"设备离线"，也不编状态）。
    async getState(deviceId: string): Promise<ProviderStateResult> {
      const config = resolveTuyaConfig(settingsGet);
      if (!config) {
        return { ok: false, unsupported: true, error: '涂鸦云凭据未配置（Access ID / Secret），无法查询状态。' };
      }
      return createTuyaProvider(config, deps).getState!(deviceId);
    },
  };
  registerDeviceProvider(provider);
  return provider;
}
