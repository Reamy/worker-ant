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
// zx_20261018_1 批二「意」：意图协议（词表/校验）+ 计划账（resolve 与 execute 之间的那本账）。
import { INTENT_CAPABILITY, publicIntents, validateIntent } from './intent-protocol.js';
import {
  claimIntentPlan,
  createIntentPlan,
  executeClaimedIntentPlan,
  getIntentPlan,
  INTENT_PLAN_TTL_SEC,
  type IntentStep,
  type IntentSkip,
  type IntentPlanDb,
} from './intent-plans.js';

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
 * 两项，**安全语义不同**（zx_20261018_1 批一「通」）：
 *   · `device_control` ——**原始动作**（turn_on/set…），由终端自己决定按哪个动作、哪台设备。
 *   · `intent_control` ——**自然语言意图**（"把客厅灯打开"），由本机解析成计划再执行。
 * 故 **IM 审批默认只给 `intent_control`**（见 `DEFAULT_TERMINAL_CAPABILITIES`）：一句话的意图经过本机解析，
 * 比让终端直发原始动作更可控；原始动作须用户在桌面闸里**显式勾选**（承 zx_20261018_1 D-2）。
 * 新增一项须**穷举两侧读点**：白名单（这里）∩ 用户批准（`capabilities_json`）——二者都过才放行。
 */
export const EXTERNAL_CAPABILITIES = ['device_control', 'intent_control'] as const;
export type ExternalCapability = (typeof EXTERNAL_CAPABILITIES)[number];

/** 人话能力名（面板/回执直接上屏用；键类型取 `ExternalCapability` ⇒ 漏一项是编译期错）。 */
export const EXTERNAL_CAPABILITY_LABEL: Record<ExternalCapability, string> = {
  device_control: '设备控制',
  intent_control: '意图控制',
};

/** 人话风险说明（审批面板逐项上屏；**与 label 同源同表**，不另立一份词表）。 */
export const EXTERNAL_CAPABILITY_NOTE: Record<ExternalCapability, string> = {
  device_control: '原始动作：终端自己决定对哪台设备下发什么动作。默认不给，须在此显式勾选。',
  intent_control: '自然语言意图：终端说一句要做什么，由本机解析成计划再执行。默认授予。',
};

export function isExternalCapability(cap: string): cap is ExternalCapability {
  return (EXTERNAL_CAPABILITIES as readonly string[]).includes(cap);
}

/** 门牌上对外自述的一条能力（zx_20261021_3 批四）——**类目级**，不含"批给谁/用了哪台设备"。 */
export interface OfferedCapability {
  key: ExternalCapability;
  label: string;
  /** 恒为 true：两类能力都必须经**配对 + 用户勾选**才生效（不是一见面就能用）。 */
  requires_approval: true;
}

/**
 * 门牌的能力自述（**唯一组装处**）。门牌与 rr 判据同引此函数，不在门里另拼一份。
 * ⚠ 这里答的是"本机**能开**什么类的能力"，不是"**已批**给谁"——后者在凭据里，门内 `/capabilities` 才看得到。
 */
export function offeredCapabilities(): OfferedCapability[] {
  return EXTERNAL_CAPABILITIES.map((key) => ({
    key,
    label: EXTERNAL_CAPABILITY_LABEL[key],
    requires_approval: true as const,
  }));
}

/**
 * **`/invoke` 可原始调用的能力**（zx_20261018_1 批一 D-2）——刻意**窄于** `EXTERNAL_CAPABILITIES`：
 * `intent_control` 是"把一句话交给本机解析"，不是"让终端直接下命令"；它**不可**经 `/invoke` 直调，
 * 否则"默认授予的意图能力"就成了绕过原始动作显式授权（`device_control` 须桌面勾选）的后门。
 * 本项须与 `EXTERNAL_CAPABILITIES` 分开，不靠注释约定（维特根斯坦·意义即用法：词怎么被用，才是它的意思）。
 */
export const INVOKE_CAPABILITIES = ['device_control'] as const;
export type InvokeCapability = (typeof INVOKE_CAPABILITIES)[number];

export function isInvocableCapability(cap: string): cap is InvokeCapability {
  return (INVOKE_CAPABILITIES as readonly string[]).includes(cap);
}

/**
 * **批准时默认授予**的能力面——IM 审批（用户只回一句话，看不到勾选框）走这一份；
 * 桌面闸的勾选框初值也取这一份（`external.ipc.ts` 回给渲染层）。
 * 只含 `intent_control`：意图受本机解析与安全闸约束，原始动作须显式勾选（见上）。
 */
export const DEFAULT_TERMINAL_CAPABILITIES: readonly ExternalCapability[] = ['intent_control'];

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
  /** 可用的意图协议（id/label/参数名——**只有词**，没有任何设备坐标）。 */
  intents: ReturnType<typeof publicIntents>;
  /** 已登记的房间名（非空、去重；批三接真源，此前由装配层给空表）。 */
  rooms: string[];
  devices: RedactedDevice[];
}

/** 意图规划结果——解析器（`home-intent.ts`，批五接上）与本模块之间的**唯一形状**。 */
export type IntentResolveOutcome =
  | { ok: true; steps: IntentStep[]; skipped: IntentSkip[] }
  | { ok: false; reason: 'needs_clarification'; candidates: string[]; skipped?: IntentSkip[] }
  | { ok: false; reason: string; skipped?: IntentSkip[] };

export interface IntentResolveInput {
  intent: string;
  params: Record<string, unknown>;
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
  controlDevice(inner: { deviceId?: string; name?: string; action: string; args?: Record<string, unknown>; terminalId?: string; planId?: string }): Promise<DeviceControlOutcome>;
  /** 已登记房间（`/capabilities.rooms` 的唯一来源）；未装配 ⇒ 空表（如实，不猜）。 */
  listRooms?(): string[];
  /**
   * 意图 → 计划步骤（确定性规则表在 `home-intent.ts`，批五接上）。
   * 未装配 ⇒ resolve 如实回 503 `intent_resolver_unavailable`（不编空计划）。
   * ⚠ 入参**只有** `intent` 与校验后的 `params`——`utterance` 不进来（R-20）。
   */
  resolveIntentSteps?(input: IntentResolveInput): IntentResolveOutcome;
  /** 注入时刻（rr 用；生产不传 ⇒ 真实时刻）。 */
  now?(): Date;
  /**
   * zx_20261018_2 批六：「一次调用落账」的**观察面**——本模块保持零 electron/零 eventBus，
   * 由装配层（`main/index.ts`）把它接到瞬态事件 `external.call_recorded`。
   * 观察者异常**不打断**调用（留痕已落库，广播只是让 GUI 不必再猜）。
   */
  onCallRecorded?(entry: { terminalId: string; capability: string; result: ExternalCallResult; reason?: string }): void;
}

/**
 * 能力面**端口**——`inbound-gate.handleInboundRequest` 消费的窄面（`PairingPort` 同范式）。
 * `invoke` 是**唯一异步跳**（真控设备），故返回 `T | Promise<T>`；`capabilities` 纯读，恒同步。
 */
export interface ExternalCapabilityPort {
  capabilities(terminalId: string, allowed: string[]): ExternalCapabilityResult;
  invoke(terminalId: string, allowed: string[], body: unknown, remoteAddr?: string): ExternalCapabilityResult | Promise<ExternalCapabilityResult>;
  /** 意图两跳（zx_20261018_1 批二）：resolve 零副作用落计划；execute 取计划逐步执行（单次）。 */
  resolveIntent(terminalId: string, allowed: string[], body: unknown, remoteAddr?: string): ExternalCapabilityResult | Promise<ExternalCapabilityResult>;
  executeIntent(terminalId: string, allowed: string[], body: unknown, remoteAddr?: string): ExternalCapabilityResult | Promise<ExternalCapabilityResult>;
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
 *   ③ **可原始调用**——`intent_control` 只受"意图协议"路径服务，**不可**经 `/invoke` 直调 ⇒
 *      403 且留痕（`capability_not_invocable`）；
 *   ④ 该终端获批——用户批准时**没勾**这项即 403 且留痕（`capability_not_granted`）；
 *   ⑤ 执行 → 留痕（`ok` / `denied` / `error`）。
 * ⚠ 缺 `capability` 字段 ⇒ 400 且**不**留痕（那不是一次"能力调用尝试"，是一条烂请求——别污染账）。
 */
export function createExternalCapabilityPort(
  db: ExternalCallDb & LicenseSettingDb & IntentPlanDb,
  deps: ExternalCapabilityDeps,
): ExternalCapabilityPort {
  const refusal = () => teamFeatureRefusal(db, 'external_terminal');
  /** 留痕唯一写口的**旁挂观察**（zx_20261018_2 批六）——先落库，再通知；观察者异常不打断调用。 */
  const record = (entry: Parameters<typeof recordExternalCall>[1]): string => {
    const id = recordExternalCall(db, entry);
    try {
      deps.onCallRecorded?.({
        terminalId: entry.terminalId,
        capability: entry.capability,
        result: entry.result,
        reason: entry.reason,
      });
    } catch { /* 观察者异常不打断调用（真相已落库） */ }
    return id;
  };

  return {
    capabilities(terminalId, allowed) {
      const locked = refusal();
      if (locked) return { status: 403, body: { error: 'team_required', message: locked } };
      const caps = EXTERNAL_CAPABILITIES.filter((c) => allowed.includes(c));
      const rooms = [...new Set((deps.listRooms?.() ?? []).map((r) => r.trim()).filter((r) => r.length > 0))].sort();
      const payload: ExternalCapabilitiesPayload = {
        terminal_id: terminalId,
        capabilities: caps,
        intents: publicIntents(),
        rooms,
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
        record({ terminalId, capability, args: inner, result: 'denied', reason: 'team_required', remoteAddr });
        return { status: 403, body: { error: 'team_required', message: locked } };
      }
      if (!isExternalCapability(capability)) {
        record({ terminalId, capability, args: inner, result: 'denied', reason: 'capability_not_allowed', remoteAddr });
        return { status: 403, body: { error: 'capability_not_allowed', capability } };
      }
      if (!isInvocableCapability(capability)) {
        record({ terminalId, capability, args: inner, result: 'denied', reason: 'capability_not_invocable', remoteAddr });
        return { status: 403, body: { error: 'capability_not_invocable', capability } };
      }
      if (!allowed.includes(capability)) {
        record({ terminalId, capability, args: inner, result: 'denied', reason: 'capability_not_granted', remoteAddr });
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
        record({ terminalId, capability, args: inner, result: 'ok', remoteAddr });
        return { status: 200, body: { ok: true, capability, result: outcome.result } };
      }
      // 拒绝（安全闸 K-6：未授权/高危/不可控/查无此设备）⇒ 403 + `how_to_authorize`（可行动的下一步）。
      if ('denied' in outcome) {
        const reason = 'reason' in outcome ? String(outcome.reason) : 'denied';
        const how = 'how_to_authorize' in outcome ? String(outcome.how_to_authorize) : '';
        record({ terminalId, capability, args: inner, result: 'denied', reason, remoteAddr });
        return { status: 403, body: { ok: false, capability, error: reason, how_to_authorize: how } };
      }
      // 传动失败（设备没答理）——请求本身过了闸，是执行没成 ⇒ 200 + `ok:false`（与工具返回同形，不当成协议错误）。
      record({ terminalId, capability, args: inner, result: 'error', remoteAddr });
      return { status: 200, body: { ok: false, capability, result: 'result' in outcome ? String(outcome.result) : '' } };
    },

    /**
     * 第一跳：把一句意图落成**计划**（R-14：零副作用——不碰设备，只写 `wa_intent_plans`）。
     * 闸序与 `/invoke` 同族：① Team ② 该终端获批 `intent_control`；随后校验词表/参数（R-13）。
     * `utterance` 只落留痕账，**不进**解析器（R-20）。
     */
    async resolveIntent(terminalId, allowed, body, remoteAddr) {
      const capability = INTENT_CAPABILITY;
      const locked = refusal();
      if (locked) {
        record({ terminalId, capability, args: asRecord(body), result: 'denied', reason: 'team_required', remoteAddr });
        return { status: 403, body: { error: 'team_required', message: locked } };
      }
      if (!allowed.includes(capability)) {
        record({ terminalId, capability, args: asRecord(body), result: 'denied', reason: 'capability_not_granted', remoteAddr });
        return { status: 403, body: { error: 'capability_not_granted', capability } };
      }
      const b = asRecord(body);
      const v = validateIntent({ intent: b.intent, params: b.params });
      if (!v.ok) {
        record({
          terminalId, capability, args: asRecord(body), result: 'denied',
          reason: v.body.error, remoteAddr,
        });
        return { status: v.status, body: v.body };
      }
      const planner = deps.resolveIntentSteps;
      if (!planner) {
        record({ terminalId, capability, args: asRecord(body), result: 'error', reason: 'intent_resolver_unavailable', remoteAddr });
        return { status: 503, body: { error: 'intent_resolver_unavailable' } };
      }
      let outcome: IntentResolveOutcome;
      try {
        // ⚠ 只传 intent + 校验后的 params；`utterance` 不进来（R-20）。
        outcome = planner({ intent: v.intent, params: v.params });
      } catch (e) {
        record({ terminalId, capability, args: asRecord(body), result: 'error', reason: 'intent_resolver_failed', remoteAddr });
        return { status: 500, body: { error: 'intent_resolver_failed', message: (e as Error)?.message || String(e) } };
      }
      if (!outcome.ok) {
        const reason = outcome.reason;
        record({
          terminalId, capability, args: asRecord(body), result: 'denied', reason, remoteAddr,
        });
        // 被略过的设备照实带回（"为什么没做它"——与成功回包同一字段名，不静默丢）。
        const skipped = outcome.skipped ?? [];
        if (reason === 'needs_clarification' && 'candidates' in outcome) {
          return { status: 409, body: { error: 'needs_clarification', candidates: outcome.candidates, skipped } };
        }
        return { status: 409, body: { error: reason, skipped } };
      }
      const now = deps.now?.() ?? new Date();
      const plan = createIntentPlan(db, {
        terminalId, capability, params: v.params,
        steps: outcome.steps, skipped: outcome.skipped, now,
      });
      record({
        terminalId, capability,
        args: { intent: v.intent, params: v.params, utterance: typeof b.utterance === 'string' ? b.utterance.slice(0, 500) : '', planId: plan.id },
        result: 'ok', remoteAddr,
      });
      return {
        status: 200,
        body: { planId: plan.id, expiresIn: INTENT_PLAN_TTL_SEC, steps: outcome.steps, skipped: outcome.skipped },
      };
    },

    /**
     * 第二跳：认领并执行计划（R-15 过期 409 / R-16 只执行一次 / R-17 逐步结果与顺序）。
     * 步骤只经 `deps.controlDevice`（生产＝`runDeviceControl`，审计与 K-6 同一把尺）。
     */
    async executeIntent(terminalId, allowed, body, remoteAddr) {
      const capability = INTENT_CAPABILITY;
      const b = asRecord(body);
      const planId = typeof b.planId === 'string' ? b.planId.trim() : '';
      if (!planId) return { status: 400, body: { error: 'plan_id_required' } };
      const locked = refusal();
      if (locked) {
        record({ terminalId, capability, args: { planId }, result: 'denied', reason: 'team_required', remoteAddr });
        return { status: 403, body: { error: 'team_required', message: locked } };
      }
      if (!allowed.includes(capability)) {
        record({ terminalId, capability, args: { planId }, result: 'denied', reason: 'capability_not_granted', remoteAddr });
        return { status: 403, body: { error: 'capability_not_granted', capability } };
      }
      const existing = getIntentPlan(db, planId);
      if (!existing) {
        record({ terminalId, capability, args: { planId }, result: 'denied', reason: 'plan_not_found', remoteAddr });
        return { status: 409, body: { error: 'plan_not_found' } };
      }
      // **别人的计划不能拿**——认领之前先认主（不猜、不代执行）。
      if (existing.terminal_id !== terminalId) {
        record({ terminalId, capability, args: { planId }, result: 'denied', reason: 'plan_not_yours', remoteAddr });
        return { status: 403, body: { error: 'plan_not_yours' } };
      }
      const now = deps.now?.() ?? new Date();
      const claim = claimIntentPlan(db, planId, now);
      if (!claim.ok) {
        record({ terminalId, capability, args: { planId }, result: 'denied', reason: claim.reason, remoteAddr });
        return { status: 409, body: { error: claim.reason } };
      }
      // 逐步执行与收口走**共享执行器**（门外/本地工具/面板三路同一份次序；see `intent-plans.ts`）。
      const { status, steps: results } = await executeClaimedIntentPlan(db, claim.plan, async (step) => {
        const outcome = await deps.controlDevice({
          name: step.call_name,
          action: step.action,
          args: asRecord(step.args),
          terminalId,
          planId,
        });
        if ('denied' in outcome) return { ok: false, denied: true, reason: outcome.reason };
        return { ok: outcome.ok, result: outcome.result, reason: outcome.ok ? undefined : outcome.result };
      }, now);
      const allOk = status === 'executed';
      record({
        terminalId, capability, args: { planId },
        result: allOk ? 'ok' : 'error', remoteAddr,
      });
      return { status: 200, body: { planId, status, steps: results } };
    },
  };
}
