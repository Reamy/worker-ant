/**
 * zx_20261014_4 批三（罗尔斯·无知之幕 / 维特根斯坦·意义即用法 / 管子·度量衡）:
 * 「门」的**能力面 + 留痕 + 软闸**——外部 AI 终端**进门之后**，能看什么、能做什么、做过什么。
 *
 * 病根：批一开了门、批二发了凭据，但凭据到手之后门内是**空的**——`/api/v1/*` 认证过了也只会
 *   回 404。一台拿了凭据却什么也问不出、什么也做不了的终端，等于没有进门。
 *
 * 三条纪律：
 *   ① **门外看不全**（罗尔斯·无知之幕）：`capabilities` 只回**脱敏**设备行——`call_name` / `kind` /
 *      `actions` 三样，**不给** `address` / `port` / `protocol` / `status_json` / `authorized`。
 *      知道"这里有一台叫客厅台灯的灯、它支持 turn_on"就够用了；网络坐标与授权态是门内之物。
 *   ② **能力的双重许可**：一次 `invoke` 要同时满足「在门的能力白名单内」**且**「用户批准这台终端时勾了它」
 *      （`capabilities_json`）。两者各是一把尺——白名单是**我们能开什么**，批准是**我们准它用什么**。
 *   ③ **被拒也留痕**（管子·度量衡：量过就得记数）：白名单外、未获许可、执行失败——**每一类都落一行**
 *      `wa_external_calls`，`result` 记 `ok`/`denied`/`error`。留痕里**不写**"失败"两个字了事，`reason` 记判据档位。
 *
 * ⚠ **零 electron / 零 better-sqlite3 / 零网络**（只用 `node:crypto` + 最小库接口）⇒ rr 直引跑真实现。
 *   真正"控设备"那一跳**由调用方注入**（`ExternalCapabilityDeps.controlDevice`）——本模块不引
 *   `tools/device.ts`（那会拉进 `ai`/`eventBus`/`device-mqtt`）。接线在 `main/index.ts`（装配面）。
 * ⚠ 端口接口定义在此（**生产者侧**），门模块只按结构消费（`import type`），不反向依赖——同 `PairingPort` 范式。
 */
import { randomUUID } from 'node:crypto';
import type { AnsDevice, DeviceControlOutcome } from './device-registry.js';
import { deviceCallName } from './device-name.js';
import { teamFeatureRefusal } from './team-gate.js';
import type { LicenseSettingDb } from './license.js';

/** 读/写留痕表的最小库接口（与 `DeviceDb`/`TerminalDb` 同形）——使本模块可脱 better-sqlite3。 */
export interface ExternalCallDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/**
 * 能力白名单——**唯一定义处**。
 * 第一切片**只开一项** `device_control`（走既有 `device-registry` + `tools/device.ts`，复用"按名字使唤"）。
 * 新增一项须**穷举两侧读点**：白名单（这里）∩ 用户批准（`capabilities_json`）——二者都过才放行。
 */
export const EXTERNAL_CAPABILITIES = ['device_control'] as const;
export type ExternalCapability = (typeof EXTERNAL_CAPABILITIES)[number];

/** 人话能力名（面板/回执直接上屏用；键类型取 `ExternalCapability` ⇒ 漏一项是编译期错）。 */
export const EXTERNAL_CAPABILITY_LABEL: Record<ExternalCapability, string> = {
  device_control: '设备控制',
};

export function isExternalCapability(cap: string): cap is ExternalCapability {
  return (EXTERNAL_CAPABILITIES as readonly string[]).includes(cap);
}

/** 留痕结果三态——**被拒同样留痕**（`denied`），执行不成功记 `error`。 */
export type ExternalCallResult = 'ok' | 'denied' | 'error';

/** 一条外部调用留痕（`wa_external_calls` 的投影）。 */
export interface ExternalCallRow {
  id: string;
  terminal_id: string;
  capability: string;
  args: Record<string, unknown>;
  result: string;
  /** 机器可读的判据档位（`capability_not_allowed` / `not_authorized` / …）；成功为空串。 */
  reason: string;
  remote_addr: string;
  created_at: string;
}

/** 写库时刻（DB 格式 UTC 串）——与库内 `datetime('now')` 同基准同格式（同 `device-registry.ts`）。 */
function dbNowUtc(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** 落一条外部调用留痕，返回其 id。**被拒/出错也须经过这里**（"被拒也留痕"的唯一写口）。 */
export function recordExternalCall(
  db: ExternalCallDb,
  entry: {
    terminalId: string;
    capability: string;
    args?: Record<string, unknown>;
    result: ExternalCallResult;
    reason?: string;
    remoteAddr?: string;
  },
  now?: string,
): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO wa_external_calls (id, terminal_id, capability, args_json, result, reason, remote_addr, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    entry.terminalId,
    entry.capability,
    JSON.stringify(entry.args ?? {}),
    entry.result,
    entry.reason ?? '',
    entry.remoteAddr ?? '',
    now ?? dbNowUtc(),
  );
  return id;
}

/** 外部调用留痕（最近在前）。 */
export function listExternalCalls(db: ExternalCallDb, limit = 50): ExternalCallRow[] {
  const rows = db.prepare(
    'SELECT id, terminal_id, capability, args_json, result, reason, remote_addr, created_at FROM wa_external_calls ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    terminal_id: String(r.terminal_id),
    capability: String(r.capability),
    args: parseJson<Record<string, unknown>>(r.args_json, {}),
    result: String(r.result ?? ''),
    reason: String(r.reason ?? ''),
    remote_addr: String(r.remote_addr ?? ''),
    created_at: String(r.created_at ?? ''),
  }));
}

/* ── 能力面（门外看什么 / 门外能做什么）────────────────────────────────────── */

/** 脱敏设备行（罗尔斯·无知之幕）——**只此三样**：叫什么 / 是什么 / 能做什么。 */
export interface RedactedDevice {
  /** "我们叫它什么"（别名优先，回退自述名）——与面板/工具**同一把尺**（`device-name.ts`）。 */
  call_name: string;
  kind: string;
  /** 设备自述的能力清单（service type / TXT 键派生；不自造）。 */
  actions: string[];
}

/**
 * 台账 → 脱敏清单。⚠ 这里**刻意只挑三样**：`address` / `port` / `protocol` / `status_json` /
 *   `authorized` / `controllable` **一律不出门**（网络坐标与授权态是门内之物）。
 *   要新增对外字段，须先在**无知之幕**下问一句"门外的人真的需要它吗"，再改这里（唯一出入口）。
 */
export function redactedDevices(devices: AnsDevice[]): RedactedDevice[] {
  return devices.map((d) => ({ call_name: deviceCallName(d), kind: d.kind, actions: [...d.capabilities] }));
}

export interface ExternalCapabilitiesPayload {
  terminal_id: string;
  /** **白名单 ∩ 该终端获批**的能力（未被批准的不列——不提示"你可以申请更多"，那会变成推销面）。 */
  capabilities: ExternalCapability[];
  devices: RedactedDevice[];
}

/** 门端点回包（形状与 `inbound-gate.InboundResult` **同形**：`{status, body}`）。 */
export interface ExternalCapabilityResult { status: number; body: unknown }

/** "控一台设备"那一跳的注入面——真实现由 `main/index.ts` 装配（本模块不引 `tools/device.ts`）。 */
export interface ExternalCapabilityDeps {
  listDevices(): AnsDevice[];
  /**
   * 执行一次 `device_control`。返回体取 `device-registry.DeviceControlOutcome`（工具/面板/门**同形**）。
   * 传进来的已是终端报的**原始内层参数**（`{deviceId|name, action, args}`）——"按名解析成哪台设备"由装配层
   * 决定（复用 `resolveDeviceByName`），本模块不掺和台账语义。
   * `terminalId`（zx_20261016_2）＝**发起者身份**：装配层据此把控制审计的 `actor` 记成
   * `external:<terminalId>`（"这次是谁按的"）——本模块只**如实转交**，不解析。
   */
  controlDevice(inner: { deviceId?: string; name?: string; action: string; args?: Record<string, unknown>; terminalId?: string }): Promise<DeviceControlOutcome>;
}

/**
 * 能力面**端口**——`inbound-gate.handleInboundRequest` 消费的窄面（`PairingPort` 同范式）。
 * `invoke` 是**唯一异步跳**（真控设备），故返回 `T | Promise<T>`；`capabilities` 纯读，恒同步。
 */
export interface ExternalCapabilityPort {
  capabilities(terminalId: string, allowed: string[]): ExternalCapabilityResult;
  invoke(terminalId: string, allowed: string[], body: unknown, remoteAddr?: string): ExternalCapabilityResult | Promise<ExternalCapabilityResult>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 把能力面绑到某个 db + 装配好的设备传动上，供门模块注入（rr 传内存库 + 假传动，生产传主库 + 真编排）。
 *
 * 次序（每一步都**先问再动**，且**被拒也留痕**）：
 *   ① Team 软闸（"外部终端接入"属 Team 档）——锁定即 403 且留痕（`team_required`）；
 *   ② 能力白名单——不在 `EXTERNAL_CAPABILITIES` 内即 403 且留痕（`capability_not_allowed`）；
 *   ③ 该终端获批——用户批准时**没勾**这项即 403 且留痕（`capability_not_granted`）；
 *   ④ 执行 → 留痕（`ok` / `denied` / `error`）。
 * ⚠ 缺 `capability` 字段 ⇒ 400 且**不**留痕（那不是一次"能力调用尝试"，是一条烂请求——别污染账）。
 */
export function createExternalCapabilityPort(
  db: ExternalCallDb & LicenseSettingDb,
  deps: ExternalCapabilityDeps,
): ExternalCapabilityPort {
  const refusal = () => teamFeatureRefusal(db, 'external_terminal');

  return {
    capabilities(terminalId, allowed) {
      const locked = refusal();
      if (locked) return { status: 403, body: { error: 'team_required', message: locked } };
      const caps = EXTERNAL_CAPABILITIES.filter((c) => allowed.includes(c));
      const payload: ExternalCapabilitiesPayload = {
        terminal_id: terminalId,
        capabilities: caps,
        devices: redactedDevices(deps.listDevices()),
      };
      return { status: 200, body: payload };
    },

    async invoke(terminalId, allowed, body, remoteAddr) {
      const b = asRecord(body);
      const capability = typeof b.capability === 'string' ? b.capability : '';
      if (!capability) return { status: 400, body: { error: 'capability_required' } };
      const inner = asRecord(b.args);

      const locked = refusal();
      if (locked) {
        recordExternalCall(db, { terminalId, capability, args: inner, result: 'denied', reason: 'team_required', remoteAddr });
        return { status: 403, body: { error: 'team_required', message: locked } };
      }
      if (!isExternalCapability(capability)) {
        recordExternalCall(db, { terminalId, capability, args: inner, result: 'denied', reason: 'capability_not_allowed', remoteAddr });
        return { status: 403, body: { error: 'capability_not_allowed', capability } };
      }
      if (!allowed.includes(capability)) {
        recordExternalCall(db, { terminalId, capability, args: inner, result: 'denied', reason: 'capability_not_granted', remoteAddr });
        return { status: 403, body: { error: 'capability_not_granted', capability } };
      }

      const action = typeof inner.action === 'string' ? inner.action : '';
      const outcome = await deps.controlDevice({
        deviceId: typeof inner.deviceId === 'string' ? inner.deviceId : undefined,
        name: typeof inner.name === 'string' ? inner.name : undefined,
        action,
        args: asRecord(inner.args),
        // 发起者身份（zx_20261016_2）——装配层据此把控制审计记成 `external:<id>`。
        terminalId,
      });
      if (outcome.ok) {
        recordExternalCall(db, { terminalId, capability, args: inner, result: 'ok', remoteAddr });
        return { status: 200, body: { ok: true, capability, result: outcome.result } };
      }
      // 拒绝（安全闸 K-6：未授权/高危/不可控/查无此设备）⇒ 403 + `how_to_authorize`（可行动的下一步）。
      if ('denied' in outcome) {
        const reason = 'reason' in outcome ? String(outcome.reason) : 'denied';
        const how = 'how_to_authorize' in outcome ? String(outcome.how_to_authorize) : '';
        recordExternalCall(db, { terminalId, capability, args: inner, result: 'denied', reason, remoteAddr });
        return { status: 403, body: { ok: false, capability, error: reason, how_to_authorize: how } };
      }
      // 传动失败（设备没答理）——请求本身过了闸，是执行没成 ⇒ 200 + `ok:false`（与工具返回同形，不当成协议错误）。
      recordExternalCall(db, { terminalId, capability, args: inner, result: 'error', remoteAddr });
      return { status: 200, body: { ok: false, capability, result: 'result' in outcome ? String(outcome.result) : '' } };
    },
  };
}
