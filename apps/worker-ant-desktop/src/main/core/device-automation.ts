/**
 * zx_20261121_2 M4/M5「联·尺/联·跑」：**设备联动规则**的单一真源（零 LLM / 零 electron / 可 rr 直跑）。
 *
 * 病根：设备页只有 `home.comfort`/`home.away` 两个固定意图；用户要的“客厅温度 > 28 → 开空调”
 *   “每天 08:00 → 拉开窗帘”无处可写。本轮只做**确定性**触发与动作：
 *   · 触发：设备状态/属性（eq/ne/gt/lt/contains）+ 每日 HH:MM（本地时区）；
 *   · 动作：设备控制（仍走 `runDeviceControl` 的授权/可控/高风险闸）；
 *   · 冷却、同分钟只跑一次、进程内防重入、不补跑；失败逐条记账，不抛。
 *
 * ⚠ 规则属本机用户资产：外部终端只能按授权调用，**不能**创建/修改规则（门内白名单无此能力）。
 * ⚠ 规则不是“自动放行”：`runDeviceControl` 仍会拒未授权/高危/离线设备，规则账记 `denied`。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { deviceControlVerdict, deviceLiveStateOf, getDevice, type AnsDevice } from './device-registry.js';
import { eventBus } from './event-bus.js';

export const DEVICE_AUTOMATION_DDL = `
  CREATE TABLE IF NOT EXISTS wa_device_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_json TEXT NOT NULL DEFAULT '{}',
    action_json TEXT NOT NULL DEFAULT '{}',
    cooldown_sec INTEGER NOT NULL DEFAULT 60,
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS wa_device_rule_runs (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    trigger_json TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wa_device_rule_runs_rule ON wa_device_rule_runs(rule_id, created_at DESC);
`;

export interface RuleDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): { changes?: number };
  };
}

export type RuleTrigger =
  | { type: 'device_state'; deviceId: string; key?: string; op: 'eq' | 'ne' | 'gt' | 'lt' | 'contains'; value: string }
  | { type: 'time'; at: string; days?: number[] };

export type RuleAction = { type: 'device'; deviceId: string; action: string; args?: Record<string, unknown> };

export interface DeviceRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  action: RuleAction;
  cooldownSec: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RuleEvent =
  | { type: 'device_state'; device: AnsDevice }
  | { type: 'time' };

export interface RuleControlResult {
  ok: boolean;
  denied?: boolean;
  reason?: string;
  result?: string;
}

export type RuleControl = (input: {
  deviceId: string;
  action: string;
  args?: Record<string, unknown>;
  ruleId: string;
}) => Promise<RuleControlResult>;

export interface RuleRunResult {
  ruleId: string;
  name: string;
  result: 'ok' | 'denied' | 'error' | 'skipped';
  reason?: string;
  deviceId?: string;
  action?: string;
}

export interface RuleRunRow {
  id: string;
  ruleId: string;
  result: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type RuleValidation =
  | { ok: true; rule: Omit<DeviceRule, 'id' | 'lastRunAt' | 'createdAt' | 'updatedAt'> }
  | { ok: false; message: string };

const OPS = ['eq', 'ne', 'gt', 'lt', 'contains'] as const;

function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function rowToRule(raw: Record<string, unknown>): DeviceRule {
  const trigger = parseJson(raw.trigger_json) as RuleTrigger | null;
  const action = parseJson(raw.action_json) as RuleAction | null;
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    enabled: Number(raw.enabled) === 1,
    trigger: trigger ?? { type: 'time', at: '00:00' },
    action: action ?? { type: 'device', deviceId: '', action: '' },
    cooldownSec: Number(raw.cooldown_sec) || 60,
    lastRunAt: raw.last_run_at == null ? null : String(raw.last_run_at),
    createdAt: String(raw.created_at ?? ''),
    updatedAt: String(raw.updated_at ?? ''),
  };
}

function validTrigger(raw: unknown): raw is RuleTrigger {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!t) return false;
  if (t.type === 'time') {
    if (typeof t.at !== 'string' || !/^\d{1,2}:\d{2}$/.test(t.at)) return false;
    if (t.days !== undefined && (!Array.isArray(t.days) || t.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) return false;
    return true;
  }
  if (t.type === 'device_state') {
    return typeof t.deviceId === 'string' && t.deviceId.trim().length > 0
      && typeof t.op === 'string' && (OPS as readonly string[]).includes(t.op)
      && t.value !== undefined && t.value !== null;
  }
  return false;
}

function validAction(raw: unknown): raw is RuleAction {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  return !!a && a.type === 'device' && typeof a.deviceId === 'string' && a.deviceId.trim().length > 0
    && typeof a.action === 'string' && a.action.trim().length > 0;
}

/** 校验用户输入；冷却 30..86400 秒（缺省 60）。 */
export function validateRuleInput(input: unknown): RuleValidation {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const name = String(o.name ?? '').trim();
  if (!name) return { ok: false, message: '规则名不能为空' };
  if (name.length > 60) return { ok: false, message: '规则名最多 60 字' };
  if (!validTrigger(o.trigger)) return { ok: false, message: '触发条件不合法（设备状态/属性，或每日 HH:MM）' };
  if (!validAction(o.action)) return { ok: false, message: '动作不合法（须为目标设备 + 动作名）' };
  const cooldownSec = o.cooldownSec === undefined ? 60 : Number(o.cooldownSec);
  if (!Number.isInteger(cooldownSec) || cooldownSec < 30 || cooldownSec > 86_400) {
    return { ok: false, message: '冷却须为 30..86400 秒的整数' };
  }
  const trigger = o.trigger as RuleTrigger;
  const action = o.action as RuleAction;
  return {
    ok: true,
    rule: {
      name,
      enabled: o.enabled === undefined ? true : o.enabled === true,
      trigger,
      action: { type: 'device', deviceId: action.deviceId.trim(), action: action.action.trim(), ...(action.args ? { args: action.args } : {}) },
      cooldownSec,
    },
  };
}

export function listRules(db: RuleDb): DeviceRule[] {
  try {
    return (db.prepare('SELECT * FROM wa_device_rules ORDER BY created_at DESC').all() as Array<Record<string, unknown>>).map(rowToRule);
  } catch { return []; }
}

export function getRule(db: RuleDb, id: string): DeviceRule | null {
  try {
    const row = db.prepare('SELECT * FROM wa_device_rules WHERE id = ?').get(String(id ?? '').trim()) as Record<string, unknown> | undefined;
    return row ? rowToRule(row) : null;
  } catch { return null; }
}

export function createRule(db: RuleDb, input: unknown): { ok: true; rule: DeviceRule } | { ok: false; message: string } {
  const v = validateRuleInput(input);
  if (!v.ok) return v;
  try {
    const id = `rule_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO wa_device_rules (id, name, enabled, trigger_json, action_json, cooldown_sec)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, v.rule.name, v.rule.enabled ? 1 : 0, JSON.stringify(v.rule.trigger), JSON.stringify(v.rule.action), v.rule.cooldownSec);
    const rule = getRule(db, id);
    return rule ? { ok: true, rule } : { ok: false, message: '写入后读不回来' };
  } catch (e) { return { ok: false, message: (e as Error)?.message || String(e) }; }
}

export function updateRule(db: RuleDb, id: string, input: unknown): { ok: true; rule: DeviceRule } | { ok: false; message: string } {
  const v = validateRuleInput(input);
  if (!v.ok) return v;
  try {
    const r = db.prepare(
      `UPDATE wa_device_rules SET name = ?, enabled = ?, trigger_json = ?, action_json = ?, cooldown_sec = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(v.rule.name, v.rule.enabled ? 1 : 0, JSON.stringify(v.rule.trigger), JSON.stringify(v.rule.action), v.rule.cooldownSec, String(id ?? '').trim());
    if (!(r.changes ?? 0)) return { ok: false, message: '规则不存在' };
    const rule = getRule(db, id);
    return rule ? { ok: true, rule } : { ok: false, message: '更新后读不回来' };
  } catch (e) { return { ok: false, message: (e as Error)?.message || String(e) }; }
}

export function deleteRule(db: RuleDb, id: string): boolean {
  try { return ((db.prepare('DELETE FROM wa_device_rules WHERE id = ?').run(String(id ?? '').trim()).changes ?? 0) > 0); } catch { return false; }
}

export function toggleRule(db: RuleDb, id: string, enabled: boolean): boolean {
  try {
    return ((db.prepare("UPDATE wa_device_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, String(id ?? '').trim()).changes ?? 0) > 0);
  } catch { return false; }
}

function localHhMm(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function compareValue(raw: unknown, op: RuleTrigger extends infer _ ? string : never, value: string): boolean {
  if (raw == null) return false;
  if (op === 'eq') return String(raw).trim() === value.trim();
  if (op === 'ne') return String(raw).trim() !== value.trim();
  if (op === 'contains') return String(raw).includes(value);
  const a = Number(raw);
  const b = Number(value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return op === 'gt' ? a > b : a < b;
}

/** 触发判据（纯函数）。未知/坏形状一律不匹配，如实给原因。 */
export function matchRule(rule: DeviceRule, event: RuleEvent, now: Date): { matched: boolean; reason: string } {
  if (!rule.enabled) return { matched: false, reason: 'disabled' };
  if (rule.trigger.type === 'time') {
    if (event.type !== 'time') return { matched: false, reason: 'not_time_event' };
    const at = String(rule.trigger.at ?? '').trim();
    if (localHhMm(now) !== at.padStart(5, '0')) return { matched: false, reason: 'time_not_due' };
    const days = rule.trigger.days ?? [];
    if (days.length > 0 && !days.includes(now.getDay())) return { matched: false, reason: 'day_not_due' };
    return { matched: true, reason: 'time_due' };
  }
  if (event.type !== 'device_state') return { matched: false, reason: 'not_device_event' };
  if (rule.trigger.deviceId !== event.device.id) return { matched: false, reason: 'other_device' };
  const live = deviceLiveStateOf(event.device.status);
  if (!live) return { matched: false, reason: 'no_state' };
  const key = rule.trigger.key && rule.trigger.key !== 'state' ? rule.trigger.key : 'state';
  const raw = key === 'state' ? live.state : live.attributes?.[key];
  const op = rule.trigger.op;
  if (!compareValue(raw, op, String(rule.trigger.value ?? ''))) return { matched: false, reason: 'value_not_match' };
  return { matched: true, reason: 'device_state_match' };
}

/** 冷却判据：上次运行 + 冷却 <= now。 */
export function cooldownVerdict(lastRunAt: string | null, cooldownSec: number, now: Date): boolean {
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= Math.max(0, cooldownSec) * 1000;
}

function sameLocalMinute(a: string | null, now: Date): boolean {
  if (!a) return false;
  const d = new Date(a);
  if (!Number.isFinite(d.getTime())) return false;
  return localHhMm(d) === localHhMm(now) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export interface RulePreview {
  wouldRun: boolean;
  reason: string;
  deviceId?: string;
  deviceName?: string;
  action?: string;
  verdict?: string;
}

/** 试运行：只解析“会不会跑/为什么/对哪台设备做什么”，**零写入**。 */
export function previewRule(db: RuleDb, rule: DeviceRule, event: RuleEvent | undefined, now = new Date()): RulePreview {
  let ev = event;
  if (!ev) {
    ev = rule.trigger.type === 'time'
      ? { type: 'time' }
      : (() => {
          const dev = getDevice(db as never, rule.trigger.deviceId);
          return dev ? { type: 'device_state' as const, device: dev } : undefined;
        })();
  }
  if (!ev) return { wouldRun: false, reason: 'target_device_missing' };
  const m = matchRule(rule, ev, now);
  if (!m.matched) return { wouldRun: false, reason: m.reason };
  if (!cooldownVerdict(rule.lastRunAt, rule.cooldownSec, now)) return { wouldRun: false, reason: 'cooldown' };
  const target = getDevice(db as never, rule.action.deviceId);
  if (!target) return { wouldRun: false, reason: 'action_device_missing', deviceId: rule.action.deviceId, action: rule.action.action };
  const v = deviceControlVerdict(target);
  return {
    wouldRun: true,
    reason: m.reason,
    deviceId: target.id,
    deviceName: target.name,
    action: rule.action.action,
    verdict: v.ok ? 'ok' : v.reason,
  };
}

/** 运行账读口。 */
export function listRuleRuns(db: RuleDb, ruleId?: string, limit = 20): RuleRunRow[] {
  try {
    const rows = ruleId
      ? db.prepare('SELECT * FROM wa_device_rule_runs WHERE rule_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(String(ruleId), Math.max(1, limit))
      : db.prepare('SELECT * FROM wa_device_rule_runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.max(1, limit));
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id ?? ''),
      ruleId: String(r.rule_id ?? ''),
      result: String(r.result ?? ''),
      detail: (parseJson(r.detail_json) as Record<string, unknown> | null) ?? {},
      createdAt: String(r.created_at ?? ''),
    }));
  } catch { return []; }
}

function recordRuleRun(db: RuleDb, run: { ruleId: string; trigger: unknown; result: string; detail: Record<string, unknown> }): void {
  try {
    db.prepare(
      'INSERT INTO wa_device_rule_runs (id, rule_id, trigger_json, result, detail_json) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), run.ruleId, JSON.stringify(run.trigger ?? {}), run.result, JSON.stringify(run.detail ?? {}));
  } catch { /* 运行账失败不改变执行结局 */ }
}

const running = new Set<string>();

/**
 * 跑一次匹配事件：逐条规则 match → 冷却 → 控制 → 运行账 → 更新 last_run_at。
 * 失败逐条收，不抛；同规则并发在此进程内跳过。
 */
export async function runDeviceRulesForEvent(
  db: RuleDb,
  event: RuleEvent,
  control: RuleControl,
  opts: { now?: Date; onRun?: (r: RuleRunResult) => void } = {},
): Promise<RuleRunResult[]> {
  const now = opts.now ?? new Date();
  const out: RuleRunResult[] = [];
  for (const rule of listRules(db)) {
    if (!rule.enabled) continue;
    if (event.type === 'time' && rule.trigger.type === 'time' && sameLocalMinute(rule.lastRunAt, now)) {
      const r: RuleRunResult = { ruleId: rule.id, name: rule.name, result: 'skipped', reason: 'same_minute' };
      out.push(r); opts.onRun?.(r); continue;
    }
    const m = matchRule(rule, event, now);
    if (!m.matched) continue;
    if (!cooldownVerdict(rule.lastRunAt, rule.cooldownSec, now)) {
      const r: RuleRunResult = { ruleId: rule.id, name: rule.name, result: 'skipped', reason: 'cooldown' };
      out.push(r); opts.onRun?.(r); continue;
    }
    if (running.has(rule.id)) {
      const r: RuleRunResult = { ruleId: rule.id, name: rule.name, result: 'skipped', reason: 'running' };
      out.push(r); opts.onRun?.(r); continue;
    }
    running.add(rule.id);
    try {
      // 先落 last_run_at：即使控制失败，也避免同一事件风暴里反复重试。
      try { db.prepare('UPDATE wa_device_rules SET last_run_at = ? WHERE id = ?').run(now.toISOString(), rule.id); } catch { /* ignore */ }
      const res = await control({
        deviceId: rule.action.deviceId,
        action: rule.action.action,
        args: rule.action.args,
        ruleId: rule.id,
      });
      const result: RuleRunResult = {
        ruleId: rule.id,
        name: rule.name,
        result: res.ok ? 'ok' : (res.denied ? 'denied' : 'error'),
        ...(res.reason ? { reason: res.reason } : {}),
        deviceId: rule.action.deviceId,
        action: rule.action.action,
      };
      recordRuleRun(db, { ruleId: rule.id, trigger: event, result: result.result, detail: { deviceId: rule.action.deviceId, action: rule.action.action, reason: res.reason ?? '', result: res.result ?? '' } });
      out.push(result); opts.onRun?.(result);
    } catch (e) {
      const result: RuleRunResult = { ruleId: rule.id, name: rule.name, result: 'error', reason: (e as Error)?.message || String(e), deviceId: rule.action.deviceId, action: rule.action.action };
      recordRuleRun(db, { ruleId: rule.id, trigger: event, result: 'error', detail: { deviceId: rule.action.deviceId, action: rule.action.action, reason: result.reason } });
      out.push(result); opts.onRun?.(result);
    } finally { running.delete(rule.id); }
  }
  return out;
}

/** 时间轮：只跑 `time` 触发（设备事件由事件总线驱动）。 */
export async function runTimeRules(db: RuleDb, control: RuleControl, opts: { now?: Date; onRun?: (r: RuleRunResult) => void } = {}): Promise<RuleRunResult[]> {
  return runDeviceRulesForEvent(db, { type: 'time' }, control, opts);
}

/**
 * 启动联动：订阅 `device.status_changed` + 60s 时间轮；返回 stop()。
 * 不补跑：启动只从当前时刻开始；进程休眠期间错过的时刻不追。
 */
export function startDeviceAutomation(opts: {
  db: RuleDb;
  control: RuleControl;
  onRun?: (r: RuleRunResult) => void;
  intervalMs?: number;
  now?: () => Date;
}): { stop: () => void } {
  const handler = (e: { data?: { device?: AnsDevice } }) => {
    const dev = e.data?.device;
    if (!dev) return;
    void runDeviceRulesForEvent(opts.db, { type: 'device_state', device: dev }, opts.control, { now: opts.now?.() ?? new Date(), ...(opts.onRun ? { onRun: opts.onRun } : {}) })
      .catch(() => { /* runDeviceRulesForEvent 自身逐条收；此处兜底进程安全 */ });
  };
  eventBus.on('device.status_changed', handler);
  const timer = setInterval(() => {
    void runTimeRules(opts.db, opts.control, { now: opts.now?.() ?? new Date(), ...(opts.onRun ? { onRun: opts.onRun } : {}) })
      .catch(() => { /* 同上 */ });
  }, Math.max(30_000, opts.intervalMs ?? 60_000));
  return {
    stop: () => {
      eventBus.off('device.status_changed', handler);
      clearInterval(timer);
    },
  };
}
