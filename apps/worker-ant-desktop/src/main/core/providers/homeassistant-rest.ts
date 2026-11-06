/**
 * zx_20261101_2 M1「接」（庄子·道在屎溺 / 维特根斯坦·意义即用法）: **Home Assistant REST 适配层**。
 *
 * 与涂鸦云同形：Provider 只答三问（列设备 / 下发 / 查状态），台账、授权、审计、事件全在既有层。
 *   · 接入方式：用户填 HA 的 base URL + **长期访问令牌**（Profile → Long-Lived Access Tokens）；
 *   · `GET  /api/states`            → 设备清单（**只取可控域**，传感器/自动化不当作"设备"）
 *   · `POST /api/services/<domain>/<service>` → 控制（`turn_on` / `turn_off` / `toggle`）
 *   · `GET  /api/states/<entity_id>` → 实况
 *
 * ⚠ **只认 http/https**、**URL 内嵌账号密码一律拒**（凭据走 Bearer 令牌，不混在地址里）；
 *   `entity_id` 与 `service` 都过白名单正则——它们会拼进 URL/路径，不能成为注入面。
 * ⚠ HTTP **可注入**：rr 喂假传输、不触网；缺省实现用 `fetch`，10s 超时。
 * ⚠ 传感器类实体**故意不列为设备**：HA 里一台灯可能挂十几个 sensor，全量入账会挤爆设备名额，
 *   而它们本来就不可控。界面上"接入了 HA"应看到能开关的东西，不是一堆读数。
 */
import { kindClassOf } from '../device-kind.js';
import type { DeviceTestResult } from '../device-diagnostics.js';
import {
  registerDeviceProvider,
  type DeviceProvider,
  type ProviderControlResult,
  type ProviderDevice,
  type ProviderStateResult,
} from '../device-provider.js';
import { normalizeCloudBaseUrl } from '../device-cloud-accounts.js';

export const HA_REST_PROVIDER_BASE = 'homeassistant';
/** 缺省超时（与涂鸦一致；rr 注入传输时不受此限）。 */
export const HA_REST_TIMEOUT_MS = 10_000;

export interface HaRestConfig {
  /** 已归一的 base URL（无尾斜杠）。 */
  baseUrl: string;
  /** 长期访问令牌（只存在 main 进程内存）。 */
  token: string;
}

export interface HaHttpResponse {
  status: number;
  body: string;
}

export type HaHttp = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HaHttpResponse>;

/** 缺省 HTTP：`fetch` + 超时；非 2xx 也返回响应体，由适配层统一判。 */
export const defaultHaHttp: HaHttp = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HA_REST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

export interface HaProviderDeps {
  http?: HaHttp;
}

/** HA 的实体 id：`<domain>.<object_id>`，两侧只允许小写字母/数字/下划线。 */
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
/** 服务名（拼进 URL 路径）——同一套白名单。 */
const SERVICE_RE = /^[a-z0-9_]+$/;

/**
 * 可控域（会出现在设备清单里的域）。
 * 传感器/二进制传感器/自动化/场景**不在**此列：它们不是"能开关的设备"，
 * 且 HA 家庭里这类实体数量远大于可控设备，全收会把设备名额挤爆。
 */
export const HA_CONTROLLABLE_DOMAINS = [
  'light',
  'switch',
  'fan',
  'climate',
  'cover',
  'media_player',
  'lock',
  'humidifier',
  'water_heater',
  'vacuum',
  'input_boolean',
] as const;

const CONTROLLABLE = new Set<string>(HA_CONTROLLABLE_DOMAINS);

interface HaStateRow {
  entity_id?: unknown;
  state?: unknown;
  attributes?: unknown;
}

function domainOf(entityId: string): string {
  const i = entityId.indexOf('.');
  return i > 0 ? entityId.slice(0, i) : '';
}

function attrOf(attributes: unknown, key: string): string {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return '';
  const v = (attributes as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/** 实体 → Provider 设备（域不可控/隐藏/名不合法 ⇒ `null`，不造行）。 */
export function mapHaEntity(row: HaStateRow): ProviderDevice | null {
  const entityId = typeof row.entity_id === 'string' ? row.entity_id.trim() : '';
  if (!ENTITY_ID_RE.test(entityId)) return null;
  const domain = domainOf(entityId);
  if (!CONTROLLABLE.has(domain)) return null;
  const attributes = row.attributes;
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    if ((attributes as Record<string, unknown>).hidden === true) return null;
  }
  const name = attrOf(attributes, 'friendly_name') || entityId;
  const capabilities = domain === 'cover' ? ['open', 'close'] : ['turn_on', 'turn_off', 'toggle'];
  // 设备自述的 device_class 交给唯一归一函数（HA cover 的车库门不是窗帘，见 device-kind.ts）。
  const kindClass = kindClassOf({
    kind: domain,
    protocol: 'cloud',
    provider: HA_REST_PROVIDER_BASE,
    deviceClass: attrOf(attributes, 'device_class'),
    capabilities,
  });
  return {
    id: entityId,
    name,
    kind: domain,
    kindClass,
    capabilities,
    controllable: true,
  };
}

/** 控制动作 → HA service（`turn_on` / `turn_off` / `toggle`；`args.service` 可显式覆盖）。 */
export function haServiceFor(
  entityId: string,
  action: string,
  args: Record<string, unknown>,
): { domain: string; service: string } | { error: string } {
  const domain = domainOf(entityId);
  if (!ENTITY_ID_RE.test(entityId) || !domain) return { error: `HA 实体 id 不合法：${entityId}` };
  const override = typeof args.service === 'string' ? args.service.trim() : '';
  const mapped: Record<string, string> = {
    turn_on: 'turn_on',
    on: 'turn_on',
    turn_off: 'turn_off',
    off: 'turn_off',
    toggle: 'toggle',
    open: 'open_cover',
    close: 'close_cover',
    stop: 'stop',
  };
  const service = override || mapped[String(action ?? '').trim().toLowerCase()] || '';
  if (!SERVICE_RE.test(service)) return { error: `HA 不支持的动作：${String(action)}（可传 args.service 覆盖）` };
  return { domain, service };
}

/** 去掉控制参数里的 `service`（它只用于选服务，不进 HA 载荷）。 */
export function haServiceData(args: Record<string, unknown>): Record<string, unknown> {
  const { service: _service, ...rest } = args ?? {};
  return rest;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function jsonOrNull(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * 建一个 HA REST Provider。`config` 由调用方从账号行 + 加密令牌现读；
 * 失败一律如实（list 冒泡成异常由同步层收成"空态 + 原因"；control/getState 回 `{ok:false}`）。
 */
export function createHaRestProvider(config: HaRestConfig, deps: HaProviderDeps = {}): DeviceProvider {
  const http = deps.http ?? defaultHaHttp;
  const base = normalizeCloudBaseUrl(config.baseUrl);

  async function request(method: string, path: string, body?: string): Promise<HaHttpResponse> {
    if (!base) throw new Error('Home Assistant 地址未配置或不是合法的 http/https 地址');
    return http(`${base}${path}`, { method, headers: authHeaders(config.token), ...(body === undefined ? {} : { body }) });
  }

  return {
    id: HA_REST_PROVIDER_BASE,
    label: 'Home Assistant',

    async listDevices(): Promise<ProviderDevice[]> {
      const res = await request('GET', '/api/states');
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Home Assistant 设备列表读取失败：HTTP ${res.status} ${res.body.slice(0, 160)}`);
      }
      const parsed = jsonOrNull(res.body);
      if (!Array.isArray(parsed)) throw new Error('Home Assistant 设备列表格式不符（期待数组）');
      const out: ProviderDevice[] = [];
      for (const row of parsed) {
        if (!row || typeof row !== 'object') continue;
        const dev = mapHaEntity(row as HaStateRow);
        if (dev) out.push(dev);
      }
      return out;
    },

    async control(deviceId: string, action: string, args: Record<string, unknown>): Promise<ProviderControlResult> {
      const target = haServiceFor(deviceId, action, args);
      if ('error' in target) return { ok: false, result: target.error };
      const payload = JSON.stringify({ entity_id: deviceId, ...haServiceData(args) });
      try {
        const res = await request('POST', `/api/services/${target.domain}/${target.service}`, payload);
        if (res.status < 200 || res.status >= 300) {
          return { ok: false, result: `Home Assistant 下发失败：HTTP ${res.status} ${res.body.slice(0, 160)}` };
        }
        return { ok: true, result: `Home Assistant 已受理 ${target.domain}.${target.service}` };
      } catch (e) {
        return { ok: false, result: `Home Assistant 下发失败：${(e as Error)?.message || String(e)}` };
      }
    },

    async getState(deviceId: string): Promise<ProviderStateResult> {
      if (!ENTITY_ID_RE.test(deviceId)) return { ok: false, error: `HA 实体 id 不合法：${deviceId}` };
      try {
        const res = await request('GET', `/api/states/${encodeURIComponent(deviceId)}`);
        if (res.status < 200 || res.status >= 300) {
          return { ok: false, error: `Home Assistant 状态查询失败：HTTP ${res.status} ${res.body.slice(0, 160)}` };
        }
        const parsed = jsonOrNull(res.body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, error: 'Home Assistant 状态响应格式不符' };
        }
        const row = parsed as Record<string, unknown>;
        const attributes = row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
          ? (row.attributes as Record<string, unknown>)
          : {};
        return {
          ok: true,
          state: {
            state: typeof row.state === 'string' ? row.state : '',
            attributes,
            last_changed: typeof row.last_changed === 'string' ? row.last_changed : null,
          },
        };
      } catch (e) {
        return { ok: false, error: `Home Assistant 状态查询失败：${(e as Error)?.message || String(e)}` };
      }
    },
  };
}

/**
 * 测试连接（账号「测试」按钮）：只读一枚状态列表，**不下发任何控制**。
 * `endpoint` **不含令牌**（只给 base URL）。
 */
export async function probeHaRest(config: HaRestConfig, deps: HaProviderDeps = {}): Promise<DeviceTestResult> {
  const http = deps.http ?? defaultHaHttp;
  const base = normalizeCloudBaseUrl(config.baseUrl);
  const started = Date.now();
  if (!base) {
    return { target: 'ha', ok: false, endpoint: '', protocol: 'https', latencyMs: 0, detail: 'Base URL 不是合法的 http/https 地址' };
  }
  try {
    const res = await http(`${base}/api/states`, { method: 'GET', headers: authHeaders(config.token) });
    const latencyMs = Date.now() - started;
    if (res.status < 200 || res.status >= 300) {
      return {
        target: 'ha', ok: false, endpoint: base, protocol: base.startsWith('https') ? 'https' : 'http', latencyMs,
        detail: `状态列表读取失败：HTTP ${res.status} ${res.body.slice(0, 160)}`,
      };
    }
    const parsed = jsonOrNull(res.body);
    const total = Array.isArray(parsed) ? parsed.length : 0;
    return {
      target: 'ha', ok: true, endpoint: base, protocol: base.startsWith('https') ? 'https' : 'http', latencyMs,
      detail: `已连通，读到 ${total} 个实体`,
      deviceCount: total,
    };
  } catch (e) {
    return {
      target: 'ha', ok: false, endpoint: base, protocol: base.startsWith('https') ? 'https' : 'http',
      latencyMs: Math.max(0, Date.now() - started), detail: `连接失败：${(e as Error)?.message || String(e)}`,
    };
  }
}

/** 注册一个 HA 账号的 Provider（`provider_id='homeassistant@<accountId>'`）。 */
export function registerHaAccountProvider(
  providerId: string,
  label: string,
  readConfig: () => HaRestConfig | null,
  deps: HaProviderDeps = {},
): DeviceProvider {
  const provider: DeviceProvider = {
    id: providerId,
    label,
    async listDevices(): Promise<ProviderDevice[]> {
      const config = readConfig();
      if (!config) throw new Error('Home Assistant 账号缺少地址或访问令牌');
      return createHaRestProvider(config, deps).listDevices();
    },
    async control(deviceId: string, action: string, args: Record<string, unknown>): Promise<ProviderControlResult> {
      const config = readConfig();
      if (!config) return { ok: false, result: 'Home Assistant 账号缺少地址或访问令牌，拒绝下发。' };
      return createHaRestProvider(config, deps).control(deviceId, action, args);
    },
    async getState(deviceId: string): Promise<ProviderStateResult> {
      const config = readConfig();
      if (!config) return { ok: false, unsupported: true, error: 'Home Assistant 账号缺少地址或访问令牌，无法查询状态。' };
      return createHaRestProvider(config, deps).getState!(deviceId);
    },
  };
  registerDeviceProvider(provider);
  return provider;
}
