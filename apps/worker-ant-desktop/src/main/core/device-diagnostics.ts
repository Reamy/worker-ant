/**
 * zx_20261022_3 批三（维特根斯坦·意义即用法／道德经·知之为知之）:
 * **设备显态与诊断**的零依赖真源——面板、工具体与 IPC 取同一份判据/话术。
 *
 * 三事：
 *   ① 上行状态的投影与描述（`liveStateOf` / `liveSourceLabel` / `liveStateSummary`）——
 *      面板与 `device_status` 工具**同一句话**说"它此刻说自己是什么状态、什么时候采集的"。
 *   ② 发现错误聚合（`aggregateDiscoveryErrors`）——条数如实、去重后逐条可展开，不吞第一条也不刷屏。
 *   ③ HTTP 探活（`probeHttpEndpoint`）——**可注入 fetch** ⇒ rr 不触网；只发一次、有界超时、不 follow 重定向。
 *
 * ⚠ 本模块**零运行期依赖**（只 `import type`）——渲染层可直接引（不拉 `node:crypto` / DB / 网络库）。
 * ⚠ `probeHttpEndpoint` 的**地址围栏不在此处**：出站对象与判据的单一真源仍是 `tools/device.ts`
 *   的 `isLanAddress`（调用方先核再调），此处只做"发一次有界请求"。
 */
import type { DeviceLiveState } from './device-registry.js';

// ==================== 实时状态投影 ====================

/**
 * 从 `status_json` 投影出实时状态；没有 `live` ⇒ `null`（"没收到过"≠"空状态"）。
 * ⚠ 与 `device-registry.deviceLiveStateOf` **同一实现**（那边委托到这里）——面板与 main 不各猜一遍。
 */
export function liveStateOf(status: Record<string, unknown> | null | undefined): DeviceLiveState | null {
  const raw = status?.live;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const live = raw as Record<string, unknown>;
  const attrs = live.attributes;
  return {
    state: typeof live.state === 'string' ? live.state : '',
    attributes: attrs != null && typeof attrs === 'object' && !Array.isArray(attrs) ? (attrs as Record<string, unknown>) : {},
    at: typeof live.at === 'string' ? live.at : '',
    source: live.source === 'attributes' ? 'attributes' : 'state',
    ...(typeof live.attributes_error === 'string' && live.attributes_error ? { attributes_error: live.attributes_error } : {}),
  };
}

/** 上行消息的**来源人话**（工具与面板同一句；不写"设备在线"——那是可用性主题的事）。 */
export function liveSourceLabel(source: DeviceLiveState['source']): string {
  return source === 'attributes' ? 'MQTT 订阅 · 属性主题（jattr）' : 'MQTT 订阅 · 状态主题（state）';
}

/** 实时状态的**摘要人话**（原文透传；属性只列前几项，空内容也如实说）。 */
export function liveStateSummary(live: DeviceLiveState): string {
  const parts: string[] = [];
  if (live.state) parts.push(live.state);
  const attrs = Object.entries(live.attributes);
  if (attrs.length > 0) {
    const shown = attrs.slice(0, 4).map(([k, v]) => `${k}=${fmtAttr(v)}`);
    parts.push(shown.join(' ') + (attrs.length > 4 ? ` …（共 ${attrs.length} 项）` : ''));
  }
  if (live.attributes_error) parts.push(`属性解析失败：${live.attributes_error}`);
  return parts.join(' · ') || '（设备已上报，但内容为空）';
}

function fmtAttr(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  } catch {
    return '（无法序列化的值）';
  }
}

/** 无上行状态时的如实说明（**不**拿控制快照冒充实时态）。 */
export function liveAbsentNote(): string {
  return '未收到设备上行状态——只有最近一次控制快照（若有）。';
}

// ==================== 发现错误聚合 ====================

export interface DiscoveryErrorSummary {
  /** 上报的**原始条数**（同一句话重复十次就是十条——不粉饰）。 */
  count: number;
  /** 去重后的可展开明细（保持首见次序）。 */
  unique: string[];
  /** 一句话告警（无错误 ⇒ 空串）。 */
  summary: string;
}

/** 把 `devices:discover` 回的 `mqttErrors` 聚成"一条告警 + 可展开明细"。 */
export function aggregateDiscoveryErrors(errors: readonly string[]): DiscoveryErrorSummary {
  const cleaned = errors.map((e) => String(e ?? '').trim()).filter((e) => e !== '');
  const unique = [...new Set(cleaned)];
  const count = cleaned.length;
  const summary = count === 0
    ? ''
    : `发现过程有 ${count} 条 MQTT 告警${unique.length > 1 ? `（${unique.length} 类）` : ''}：${unique[0]}`;
  return { count, unique, summary };
}

// ==================== 连接诊断（结果形状一处真源） ====================

export type DeviceTestTarget = 'mqtt' | 'ha' | 'tuya' | 'http';

/**
 * 一次"测试连接"的如实结果。
 * ⚠ `endpoint` **永不含凭据**（用户名可留，密码绝不回）。
 * ⚠ `ok:false` 必有 `detail`；`ok:true` 也说清**测到了什么**（主题条数/设备台数/HTTP 状态码），不空报"成功"。
 */
export interface DeviceTestResult {
  target: DeviceTestTarget;
  ok: boolean;
  endpoint: string;
  protocol: string;
  latencyMs: number;
  detail: string;
  /** MQTT/HA：测试窗口内收到的保留消息条数。 */
  discoveryTopics?: number;
  /** Tuya：账号下设备台数（官方 total）。 */
  deviceCount?: number;
  /** HTTP：响应状态码（拿到响应即有）。 */
  statusCode?: number;
}

// ==================== HTTP 探活（可注入） ====================

export interface HttpFetchResponseLike {
  status: number;
}

export type HttpFetchLike = (
  url: string,
  init: { method: 'GET'; redirect: 'manual'; signal: AbortSignal },
) => Promise<HttpFetchResponseLike>;

export interface HttpProbeDeps {
  /** 可注入（rr 不触网）；缺省全局 `fetch`。 */
  fetchFn?: HttpFetchLike;
  /** 可注入毫秒时钟（rr 不碰墙钟）。 */
  now?: () => number;
  timeoutMs?: number;
}

const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 3000;

/**
 * 对 `http://<address>:<port>/` 做**一次有界 GET**：报状态码与耗时；超时/连不上如实回因。
 * ⚠ `redirect:'manual'`：不让一次探活被重定向带出局域网（诊断不成为跳板）。
 * ⚠ 不读响应体（探活只需"答没答、答了什么状态"）。
 */
export async function probeHttpEndpoint(
  address: string,
  port: number | null,
  deps: HttpProbeDeps = {},
): Promise<DeviceTestResult> {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_PROBE_TIMEOUT_MS;
  const target: DeviceTestTarget = 'http';
  let url: string;
  try {
    const u = new URL(`http://${String(address ?? '').trim()}${port ? `:${port}` : ''}/`);
    if (u.protocol !== 'http:' || !u.hostname) throw new Error('非 http 地址');
    url = u.toString();
  } catch {
    return {
      target, ok: false, endpoint: String(address ?? ''), protocol: 'http', latencyMs: 0,
      detail: `地址无法组成 http URL：${address || '（空）'}`,
    };
  }
  const started = now();
  try {
    const doFetch = deps.fetchFn ?? (fetch as unknown as HttpFetchLike);
    const res = await doFetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Math.max(0, now() - started);
    return {
      target, ok: true, endpoint: url, protocol: 'http', latencyMs, statusCode: res.status,
      detail: `HTTP ${res.status}（${latencyMs}ms）`,
    };
  } catch (e) {
    const latencyMs = Math.max(0, now() - started);
    const name = (e as { name?: string })?.name;
    const msg = name === 'TimeoutError' ? `超时（>${timeoutMs}ms）` : ((e as Error)?.message || String(e));
    return { target, ok: false, endpoint: url, protocol: 'http', latencyMs, detail: `请求失败：${msg}` };
  }
}
