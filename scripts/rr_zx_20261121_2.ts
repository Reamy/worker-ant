/**
 * zx_20261121_2 「授·联」受控复跑。
 *
 * 分组：
 *   A 授权字段与默认（scope/rate/linkage）
 *   B 范围纯判据（all/selected/room/kind）
 *   C 执行点（capabilities/invoke/intent/rate）
 *   D 规则纯引擎（状态/属性/时刻/冷却/试预）
 *   E 规则运行时（事件/时间轮/运行账/失败降级）
 *   F UI/IPC 接线
 *   G 反证与静态（actor_kind/Team 闸/门内无规则能力）
 *   H build 钉
 *
 * 纪律：断言文案不含失败字形；夹具按生产初始化顺序；不写“只为下一轮”的字面量；
 *       build 由 `checkBuildPins` 派生核对。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { checkBuildPins, buildNotOlderThan } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function skip(label: string): void { skipped++; console.log(`  · SKIP ${label}`); }

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SELF = path.basename(__filename).replace(/\.ts$/, '');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261121-2-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  return initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
}

// ==================== A：授权字段与默认 ====================
async function runA(): Promise<void> {
  console.log('\n[A] 授权字段与默认');
  let mod: typeof import('../apps/worker-ant-desktop/src/main/core/external-grant.js');
  try { mod = await import('../apps/worker-ant-desktop/src/main/core/external-grant.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const def = mod.defaultGrant();
  eq(def.scope, { mode: 'all', devices: [], rooms: [], kinds: [] }, '缺省范围=全部');
  eq(def.rate, {}, '缺省频率=不限');
  eq(def.linkageAllowed, true, '缺省允许联动（与现状一致）');

  eq(mod.parseGrant({ scope_json: null, rate_json: null, linkage_allowed: null }), def, '空行读回缺省');
  eq(mod.parseGrant({ scope_json: '{bad', rate_json: 'nope', linkage_allowed: 0 }).linkageAllowed, false, '坏 JSON 不把联动读成允许');
  eq(mod.parseGrant({ scope_json: '{"mode":"all"}', rate_json: '{}', linkage_allowed: 1 }).scope.mode, 'all', '合法 all');

  const v = mod.validateGrant({ scope: { mode: 'selected', devices: ['d1', 'd1'], rooms: [' 客厅   '], kinds: ['light'] }, rate: { perMinute: 3, perHour: 30, perDay: 0 }, linkageAllowed: false });
  ok(v.ok, '合法 grant 通过', JSON.stringify(v));
  if (v.ok) {
    eq(v.grant.scope.devices, ['d1'], '设备去重');
    eq(v.grant.scope.rooms, ['客厅'], '房间归一');
    eq(v.grant.rate.perDay, 0, '0 保留为不限');
  }
  eq(mod.validateGrant({ rate: { perMinute: -1 } }).ok, false, '负频率拒绝');
  eq(mod.validateGrant({ rate: { perMinute: 1.5 } }).ok, false, '小数频率拒绝');
  eq(mod.validateGrant({ scope: { mode: 'all', devices: ['d1'] } }).ok, false, 'all 模式不接受设备选择集');
}

// ==================== B：范围纯判据 ====================
async function runB(): Promise<void> {
  console.log('\n[B] 范围纯判据');
  let mod: typeof import('../apps/worker-ant-desktop/src/main/core/external-grant.js');
  try { mod = await import('../apps/worker-ant-desktop/src/main/core/external-grant.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const dev = (id: string, room: string, kindClass: string) => ({ id, room, kind_class: kindClass });
  eq(mod.scopeAllowsDevice({ mode: 'all', devices: [], rooms: [], kinds: [] }, dev('d1', '客厅', 'light')), true, 'all 全通过');
  eq(mod.scopeAllowsDevice({ mode: 'selected', devices: ['d1'], rooms: [], kinds: [] }, dev('d1', '客厅', 'light')), true, '按设备命中');
  eq(mod.scopeAllowsDevice({ mode: 'selected', devices: [], rooms: ['客厅'], kinds: [] }, dev('d2', ' 客厅 ', 'light')), true, '按房间命中（归一）');
  eq(mod.scopeAllowsDevice({ mode: 'selected', devices: [], rooms: [], kinds: ['light'] }, dev('d2', '卧室', 'light')), true, '按品类命中');
  eq(mod.scopeAllowsDevice({ mode: 'selected', devices: [], rooms: [], kinds: [] }, dev('d1', '客厅', 'light')), false, '空选择集=什么都不给');
  eq(mod.scopeAllowsDevice({ mode: 'selected', devices: ['d9'], rooms: ['厨房'], kinds: ['lock'] }, dev('d1', '客厅', 'light')), false, '不相交拒绝');

  const now = Date.parse('2026-11-21T12:00:00Z');
  const ts = [now - 10_000, now - 20_000, now - 2 * 60_000, now - 2 * 3_600_000, now - 2 * 86_400_000];
  eq(mod.rateLimitVerdict({}, ts, now).ok, true, '空频率=不限');
  eq(mod.rateLimitVerdict({ perMinute: 0 }, ts, now).ok, true, '0=不限');
  eq(mod.rateLimitVerdict({ perMinute: 3 }, ts, now).ok, true, '分钟未达上限');
  const overMin = mod.rateLimitVerdict({ perMinute: 2 }, ts, now);
  eq(overMin.ok, false, '分钟达上限拒绝');
  if (!overMin.ok) { eq(overMin.window, 'minute', '拒因窗口 minute'); eq(overMin.used, 2, '已用 2'); }
  const overHour = mod.rateLimitVerdict({ perHour: 3 }, ts, now);
  eq(overHour.ok, false, '小时达上限拒绝');
  if (!overHour.ok) { eq(overHour.window, 'hour', '拒因窗口 hour'); eq(overHour.used, 3, '已用 3'); }
  const overDay = mod.rateLimitVerdict({ perDay: 4 }, ts, now);
  eq(overDay.ok, false, '天达上限拒绝');
  if (!overDay.ok) { eq(overDay.window, 'day', '拒因窗口 day'); eq(overDay.used, 4, '已用 4（恰好 24h 前不计入）'); }
}

// ==================== C：执行点 ====================
async function runC(): Promise<void> {
  console.log('\n[C] 执行点');
  const { createExternalCapabilityPort } = await import('../apps/worker-ant-desktop/src/main/core/external-calls.js');
  const { parseGrant, validateGrant } = await import('../apps/worker-ant-desktop/src/main/core/external-grant.js');
  const { getDevice, listDevices, resolveDeviceByName } = await import('../apps/worker-ant-desktop/src/main/core/device-registry.js');
  const { writeTerminalGrant } = await import('../apps/worker-ant-desktop/src/main/core/external-terminals.js');
  const { LICENSE_SETTING_KEYS } = await import('../apps/worker-ant-desktop/src/main/core/license.js');

  const db = mkdb();
  try {
    db.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
    const insDev = db.prepare(`INSERT INTO wa_devices
      (id, name, kind, kind_class, protocol, address, capabilities_json, controllable, authorized, status_json, room)
      VALUES (?, ?, ?, ?, 'mqtt', ?, ?, 1, 1, ?, ?)`);
    insDev.run('d1', '客厅灯', 'light', 'light', 'mqtt://d1', JSON.stringify(['turn_on', 'turn_off']), '{}', '客厅');
    insDev.run('d2', '卧室灯', 'light', 'light', 'mqtt://d2', JSON.stringify(['turn_on', 'turn_off']), '{}', '卧室');
    const insTerm = db.prepare(`INSERT INTO wa_external_terminals
      (id, name, status, pair_code, capabilities_json, approved_at, scope_json, rate_json, linkage_allowed)
      VALUES (?, ?, 'approved', '123456', ?, datetime('now'), ?, ?, ?)`);
    const t1grant = validateGrant({ scope: { mode: 'selected', devices: ['d1'], rooms: [], kinds: [] }, rate: { perMinute: 2 }, linkageAllowed: false });
    const t2grant = validateGrant({ scope: { mode: 'selected', devices: ['d1'], rooms: [], kinds: [] }, rate: {}, linkageAllowed: false });
    const t3grant = validateGrant({ scope: { mode: 'all', devices: [], rooms: [], kinds: [] }, rate: {}, linkageAllowed: true });
    if (!t1grant.ok || !t2grant.ok || !t3grant.ok) throw new Error('grant fixture');
    insTerm.run('t1', '终端一', JSON.stringify(['device_control', 'intent_control']), JSON.stringify(t1grant.grant.scope), JSON.stringify(t1grant.grant.rate), 0);
    insTerm.run('t2', '终端二', JSON.stringify(['intent_control']), JSON.stringify(t2grant.grant.scope), JSON.stringify(t2grant.grant.rate), 0);
    insTerm.run('t3', '终端三', JSON.stringify(['intent_control']), JSON.stringify(t3grant.grant.scope), JSON.stringify(t3grant.grant.rate), 1);
    const t4grant = validateGrant({ scope: { mode: 'all', devices: [], rooms: [], kinds: [] }, rate: { perMinute: 1 }, linkageAllowed: true });
    if (!t4grant.ok) throw new Error('grant fixture 4');
    insTerm.run('t4', '终端四', JSON.stringify(['intent_control']), JSON.stringify(t4grant.grant.scope), JSON.stringify(t4grant.grant.rate), 1);

    const calls: Array<{ name?: string; deviceId?: string; action: string; terminalId?: string }> = [];
    let planner: any = () => ({ ok: true, steps: [{ call_name: '客厅灯', action: 'turn_on' }], skipped: [] });
    const port = createExternalCapabilityPort(db as never, {
      listDevices: () => listDevices(db),
      listRooms: () => ['客厅', '卧室'],
      getGrant: (id) => parseGrant(db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(id) as never),
      resolveDevice: ({ deviceId, name }) => {
        if (deviceId) return getDevice(db, deviceId);
        const r = resolveDeviceByName(db, String(name ?? ''));
        return r.ok ? r.device : null;
      },
      resolveIntentSteps: (input) => planner(input),
      controlDevice: async (inner) => {
        calls.push(inner);
        return { ok: true, deviceId: inner.deviceId ?? 'd1', action: inner.action, result: 'ok' };
      },
    });

    const caps = port.capabilities('t1', ['device_control', 'intent_control']);
    eq(caps.status, 200, 'capabilities 200');
    const capBody = caps.body as { devices: Array<{ call_name: string }>; rooms: string[]; scope: { mode: string } };
    eq(capBody.devices.map((d) => d.call_name), ['客厅灯'], 'capabilities 只回范围内设备');
    eq(capBody.rooms, ['客厅'], 'capabilities 只回范围内房间');
    eq(capBody.scope.mode, 'selected', 'capabilities 回 scope');

    const outScope = await port.invoke('t1', ['device_control'], { capability: 'device_control', args: { deviceId: 'd2', action: 'turn_on' } });
    eq(outScope.status, 403, 'invoke 范围外 403');
    eq((outScope.body as { error: string }).error, 'out_of_scope', 'invoke 范围外码 out_of_scope');
    const inScope = await port.invoke('t1', ['device_control'], { capability: 'device_control', args: { deviceId: 'd1', action: 'turn_on' } });
    eq(inScope.status, 200, 'invoke 范围内 200');
    const limited = await port.invoke('t1', ['device_control'], { capability: 'device_control', args: { deviceId: 'd1', action: 'turn_on' } });
    eq(limited.status, 429, 'invoke 频率超限 429');
    eq((limited.body as { error: string }).error, 'rate_limited', 'invoke 频率码 rate_limited');
    eq((db.prepare("SELECT COUNT(*) n FROM wa_external_calls WHERE terminal_id='t1' AND result='denied'").get() as { n: number }).n, 2, '被拒两笔留痕（范围+频率）');

    planner = () => ({ ok: true, steps: [{ call_name: '客厅灯', action: 'turn_on' }, { call_name: '卧室灯', action: 'turn_on' }], skipped: [] });
    const multi = await port.resolveIntent('t2', ['intent_control'], { intent: 'home.comfort', params: { room: '客厅', feeling: 'hot' } });
    eq(multi.status, 403, '多步联动未许可 403');
    eq((multi.body as { error: string }).error, 'linkage_not_allowed', '多步联动码');

    planner = () => ({ ok: true, steps: [{ call_name: '卧室灯', action: 'turn_on' }], skipped: [] });
    const outIntent = await port.resolveIntent('t2', ['intent_control'], { intent: 'home.comfort', params: { room: '卧室', feeling: 'hot' } });
    eq(outIntent.status, 403, '单步但范围外 403');
    eq((outIntent.body as { error: string }).error, 'out_of_scope', '单步范围外码');

    planner = () => ({ ok: true, steps: [{ call_name: '客厅灯', action: 'turn_on' }], skipped: [] });
    const okPlan = await port.resolveIntent('t3', ['intent_control'], { intent: 'home.comfort', params: { room: '客厅', feeling: 'hot' } });
    eq(okPlan.status, 200, '范围内单步意图 200');
    const planId = (okPlan.body as { planId: string }).planId;
    const exec = await port.executeIntent('t3', ['intent_control'], { planId });
    eq(exec.status, 200, '意图执行 200');
    eq(calls.some((c) => c.name === '客厅灯' || c.deviceId === 'd1'), true, '意图执行真调到控制');

    // 计划建后收窄边界 ⇒ 执行前复核拒绝
    planner = () => ({ ok: true, steps: [{ call_name: '客厅灯', action: 'turn_on' }], skipped: [] });
    const okPlan2 = await port.resolveIntent('t3', ['intent_control'], { intent: 'home.comfort', params: { room: '客厅', feeling: 'hot' } });
    const planId2 = (okPlan2.body as { planId: string }).planId;
    const narrowed = validateGrant({ scope: { mode: 'selected', devices: [], rooms: [], kinds: [] }, rate: {}, linkageAllowed: true });
    if (narrowed.ok) writeTerminalGrant(db as never, 't3', narrowed.grant);
    const afterNarrow = await port.executeIntent('t3', ['intent_control'], { planId: planId2 });
    eq(afterNarrow.status, 403, '收窄后旧计划执行被拒');
    eq((afterNarrow.body as { error: string }).error, 'out_of_scope', '收窄后拒因 out_of_scope');

    // resolve 不计频、execute 计频（t4 perMinute=1）
    const r1 = await port.resolveIntent('t4', ['intent_control'], { intent: 'home.comfort', params: { room: '客厅', feeling: 'hot' } });
    const r2 = await port.resolveIntent('t4', ['intent_control'], { intent: 'home.comfort', params: { room: '客厅', feeling: 'hot' } });
    const r3 = await port.resolveIntent('t4', ['intent_control'], { intent: 'home.comfort', params: { room: '客厅', feeling: 'hot' } });
    eq([r1.status, r2.status, r3.status], [200, 200, 200], 'resolve 连续三次不被频率闸拦');
    const e1 = await port.executeIntent('t4', ['intent_control'], { planId: (r1.body as { planId: string }).planId });
    eq(e1.status, 200, '首次 execute 通过（resolve 不计频）');
    const e2 = await port.executeIntent('t4', ['intent_control'], { planId: (r2.body as { planId: string }).planId });
    eq(e2.status, 429, '第二次 execute 频率超限');
    eq((e2.body as { error: string }).error, 'rate_limited', 'execute 频率码');
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ==================== D：规则纯引擎 ====================
async function runD(): Promise<void> {
  console.log('\n[D] 规则纯引擎');
  const mod = await import('../apps/worker-ant-desktop/src/main/core/device-automation.js');
  const db = mkdb();
  try {
    const putDev = (id: string, name: string, room: string, kind: string, state: string, attrs: Record<string, unknown>, authorized = 1) =>
      db.prepare(`INSERT INTO wa_devices
        (id, name, kind, kind_class, protocol, address, capabilities_json, controllable, authorized, status_json, room)
        VALUES (?, ?, ?, ?, 'mqtt', ?, '["turn_on","turn_off"]', 1, ?, ?, ?)`)
        .run(id, name, kind, kind, `mqtt://${id}`, authorized, JSON.stringify({ live: { state, attributes: attrs, at: 't', source: 'state' } }), room);
    putDev('sensor', '客厅温度计', '客厅', 'sensor', 'ON', { temperature: 29 });
    putDev('light', '客厅灯', '客厅', 'light', 'OFF', {});

    eq(mod.validateRuleInput({ name: '', trigger: { type: 'time', at: '08:00' }, action: { type: 'device', deviceId: 'light', action: 'turn_on' } }).ok, false, '空名拒绝');
    eq(mod.validateRuleInput({ name: 'x', trigger: { type: 'time', at: '8:0' }, action: { type: 'device', deviceId: 'light', action: 'turn_on' } }).ok, false, '坏时刻拒绝');
    eq(mod.validateRuleInput({ name: 'x', trigger: { type: 'time', at: '08:00' }, action: { type: 'device', deviceId: 'light', action: 'turn_on' }, cooldownSec: 10 }).ok, false, '冷却过小拒绝');

    const created = mod.createRule(db, {
      name: '温度高开灯',
      trigger: { type: 'device_state', deviceId: 'sensor', key: 'temperature', op: 'gt', value: '28' },
      action: { type: 'device', deviceId: 'light', action: 'turn_on' },
      cooldownSec: 60,
    });
    ok(created.ok, '建规则成功', JSON.stringify(created));
    if (!created.ok) return;
    const rule = created.rule;
    const sensor = db.prepare("SELECT * FROM wa_devices WHERE id='sensor'").get() as any;
    const ev = { type: 'device_state' as const, device: { ...sensor, status: JSON.parse(sensor.status_json) } };
    const now = new Date('2026-11-21T12:00:00+08:00');
    eq(mod.matchRule(rule, ev, now).matched, true, '属性 gt 命中');
    eq(mod.matchRule({ ...rule, trigger: { ...rule.trigger, op: 'lt' } }, ev, now).matched, false, '属性 lt 不命中');
    eq(mod.matchRule({ ...rule, trigger: { ...rule.trigger, value: '35' } }, ev, now).matched, false, '属性值未达不命中');

    const timeAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const timeRule = { ...rule, trigger: { type: 'time' as const, at: timeAt } };
    eq(mod.matchRule(timeRule, { type: 'time' }, now).matched, true, '每日时刻命中');
    eq(mod.matchRule(timeRule, { type: 'time' }, new Date(now.getTime() + 60_000)).matched, false, '下一分钟不命中');
    eq(mod.matchRule({ ...timeRule, trigger: { ...timeRule.trigger, days: [(now.getDay() + 1) % 7] } }, { type: 'time' }, now).matched, false, '指定星期不命中');

    eq(mod.cooldownVerdict(null, 60, now), true, '无上次运行可跑');
    eq(mod.cooldownVerdict(new Date(now.getTime() - 61_000).toISOString(), 60, now), true, '冷却已过可跑');
    eq(mod.cooldownVerdict(new Date(now.getTime() - 30_000).toISOString(), 60, now), false, '冷却内不可跑');

    const before = Number((db.prepare('SELECT COUNT(*) n FROM wa_device_rule_runs').get() as { n: number }).n);
    const preview = mod.previewRule(db, rule, ev, now);
    eq(preview.wouldRun, true, '试运行会跑');
    eq(preview.deviceName, '客厅灯', '试运行目标名');
    eq(preview.verdict, 'ok', '试运行目标可控制');
    eq(Number((db.prepare('SELECT COUNT(*) n FROM wa_device_rule_runs').get() as { n: number }).n), before, '试运行零写入');

    const unauth = mod.previewRule(db, { ...rule, action: { ...rule.action, deviceId: 'missing' } }, ev, now);
    eq(unauth.wouldRun, false, '目标缺失不跑');
    eq(unauth.reason, 'action_device_missing', '目标缺失原因');

    ok(mod.toggleRule(db, rule.id, false), '停用规则');
    eq(mod.getRule(db, rule.id)?.enabled, false, '停用落库');
    ok(mod.deleteRule(db, rule.id), '删除规则');
    eq(mod.getRule(db, rule.id), null, '删除后读不到');
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ==================== E：规则运行时 ====================
async function runE(): Promise<void> {
  console.log('\n[E] 规则运行时');
  const mod = await import('../apps/worker-ant-desktop/src/main/core/device-automation.js');
  const db = mkdb();
  try {
    db.prepare(`INSERT INTO wa_devices
      (id, name, kind, kind_class, protocol, address, capabilities_json, controllable, authorized, status_json, room)
      VALUES ('sensor','温度计','sensor','sensor','mqtt','mqtt://sensor','[]',1,1,?, '客厅')`)
      .run(JSON.stringify({ live: { state: 'ON', attributes: { temperature: 30 }, at: 't', source: 'state' } }));
    db.prepare(`INSERT INTO wa_devices
      (id, name, kind, kind_class, protocol, address, capabilities_json, controllable, authorized, status_json, room)
      VALUES ('light','客厅灯','light','light','mqtt','mqtt://light','["turn_on","turn_off"]',1,1,'{}', '客厅')`).run();
    const c = mod.createRule(db, {
      name: '热了开灯',
      trigger: { type: 'device_state', deviceId: 'sensor', key: 'temperature', op: 'gt', value: '28' },
      action: { type: 'device', deviceId: 'light', action: 'turn_on' },
      cooldownSec: 60,
    });
    if (!c.ok) throw new Error(c.message);
    const sensor = db.prepare("SELECT * FROM wa_devices WHERE id='sensor'").get() as any;
    const ev = { type: 'device_state' as const, device: { ...sensor, status: JSON.parse(sensor.status_json) } };
    const now = new Date('2026-11-21T12:00:00+08:00');
    const calls: Array<{ deviceId: string; action: string; ruleId: string }> = [];
    const control = async (input: { deviceId: string; action: string; ruleId: string }) => {
      calls.push(input);
      return { ok: true, result: 'turned on' };
    };
    const first = await mod.runDeviceRulesForEvent(db, ev, control, { now });
    eq(first.length, 1, '首次运行一条');
    eq(first[0]?.result, 'ok', '首次运行 ok');
    eq(calls.length, 1, '控制真调用 1 次');
    eq(Number((db.prepare('SELECT COUNT(*) n FROM wa_device_rule_runs').get() as { n: number }).n), 1, '运行账 0→1');
    const second = await mod.runDeviceRulesForEvent(db, ev, control, { now });
    eq(second[0]?.result, 'skipped', '冷却内第二次跳过');
    eq(second[0]?.reason, 'cooldown', '跳过原因 cooldown');
    eq(calls.length, 1, '冷却内不再调用');

    // 失败不抛、逐条记账
    const c2 = mod.createRule(db, {
      name: '被拒规则',
      trigger: { type: 'device_state', deviceId: 'sensor', key: 'temperature', op: 'gt', value: '28' },
      action: { type: 'device', deviceId: 'light', action: 'turn_on' },
      cooldownSec: 30,
    });
    if (!c2.ok) throw new Error(c2.message);
    const denied = await mod.runDeviceRulesForEvent(db, ev, async () => ({ ok: false, denied: true, reason: 'not_authorized' }), { now: new Date(now.getTime() + 120_000) });
    eq(denied.find((r) => r.ruleId === c2.rule.id)?.result, 'denied', '被拒记 denied');
    const errored = await mod.runDeviceRulesForEvent(db, ev, async () => { throw new Error('boom'); }, { now: new Date(now.getTime() + 240_000) });
    eq(errored.find((r) => r.name === '被拒规则')?.result, 'error', '抛错记 error 不冒泡');

    // 时间规则：同分钟只跑一次
    const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const t = mod.createRule(db, {
      name: '每天开灯',
      trigger: { type: 'time', at, days: [] },
      action: { type: 'device', deviceId: 'light', action: 'turn_on' },
      cooldownSec: 30,
    });
    if (!t.ok) throw new Error(t.message);
    const t1 = await mod.runTimeRules(db, control, { now });
    ok(t1.some((r) => r.ruleId === t.rule.id && r.result === 'ok'), '时间规则首次执行');
    const t2 = await mod.runTimeRules(db, control, { now });
    ok(t2.some((r) => r.ruleId === t.rule.id && r.result === 'skipped' && r.reason === 'same_minute'), '同分钟第二次跳过');
    eq(mod.listRuleRuns(db, t.rule.id, 10).length, 1, '时间规则运行账 1 行');
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ==================== F：UI/IPC 接线 ====================
function runF(): void {
  console.log('\n[F] UI/IPC 接线');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');
  const extIpc = read('src/main/ipc/external.ipc.ts');
  ok(extIpc.includes("ipcMain.handle('external:grantUpdate'"), 'external:grantUpdate 在册');
  ok(extIpc.includes('validateGrant') && extIpc.includes('writeTerminalGrant'), 'grant 写口先校验后落库');
  ok(extIpc.includes('devices: listDevices(db)'), 'external:list 带设备选择器');
  const peers = read('renderer/src/pages/PeersPage.tsx');
  ok(peers.includes('externalApi.grantUpdate') && peers.includes('TerminalGrantSection'), '协同页有授权边界编辑器');
  ok(peers.includes('scope.mode') && peers.includes('linkageAllowed'), '编辑器含范围/联动字段');

  const devIpc = read('src/main/ipc/devices.ipc.ts');
  for (const ch of ['devices:rulesList', 'devices:ruleCreate', 'devices:ruleUpdate', 'devices:ruleDelete', 'devices:ruleToggle', 'devices:rulePreview', 'devices:ruleRuns']) {
    ok(devIpc.includes(`ipcMain.handle('${ch}'`), `${ch} 在册`);
  }
  ok((devIpc.match(/teamFeatureRefusal\(licDb, 'device_control'\)/g) ?? []).length >= 4, '规则写口走 Team 闸');
  const devPage = read('renderer/src/pages/DevicesPage.tsx');
  ok(devPage.includes('DeviceRulesSection'), '设备页有联动规则区');
  ok(devPage.includes('devicesApi.rulesList') && devPage.includes('devicesApi.ruleCreate') && devPage.includes('devicesApi.rulePreview'), '设备页调规则三口');
  ok(devPage.includes('试运行'), '设备页有试运行入口');

  const ipc = read('renderer/src/lib/ipc.ts');
  ok(ipc.includes("'external:grantUpdate'") && ipc.includes("'devices:rulesList'") && ipc.includes("'devices:rulePreview'"), '渲染层 IPC 信封在册');
}

// ==================== G：反证与静态 ====================
function runG(): void {
  console.log('\n[G] 反证与静态');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');
  const reg = read('src/main/core/device-registry.ts');
  ok(/DeviceActionActorKind = .*'rule'/.test(reg), 'actor_kind 含 rule');
  const devPage = read('renderer/src/pages/DevicesPage.tsx');
  ok(devPage.includes("a.actor_kind === 'rule'") && devPage.includes('联动规则'), '读侧有「联动规则」来源标签');
  const mainSrc = read('src/main/index.ts');
  ok(mainSrc.includes("actor: { kind: 'rule', ref: ruleId }") && mainSrc.includes('startDeviceAutomation'), '运行时用 rule 身份 + 真启动');
  ok(mainSrc.includes("teamFeatureRefusal(db, 'device_control')") && mainSrc.includes('device.automation_on'), '启动走 Team 闸 + 开关');
  const extCalls = read('src/main/core/external-calls.ts');
  ok(!/ruleCreate|ruleDelete|ruleToggle|device:rules/i.test(extCalls), '门内无规则能力（外部终端不能改规则）');
  const tier = read('src/main/core/tier-catalog.ts') + read('src/main/core/pro-gate.ts');
  ok(!/device_rule|deviceRules|device-rules/.test(tier), '未新增档位能力键/价格项');
  const boolSrc = read('src/main/core/settings-bool.ts');
  ok(boolSrc.includes("'device.automation_on'"), '自动化开关进 BOOL_SETTING_KEYS');
  const ruleSrc = read('src/main/core/device-automation.ts');
  ok(!/from\s+'\.\/tools\/device\.js'/.test(ruleSrc) && ruleSrc.includes('RuleControl'), '规则模块不直连控制（控制由装配层注入）');
  ok(ruleSrc.includes('sameLocalMinute') && ruleSrc.includes('cooldownVerdict'), '同分钟/冷却判据在册');
}

(async () => {
  await runA();
  await runB();
  await runC();
  await runD();
  await runE();
  runF();
  runG();

  {
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
    const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
    const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
    const tag = m?.[1] ?? '';
    ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'build 不早于本套件轮次', `${tag} vs ${SELF}`);
    ok(fs.existsSync(path.join(root, 'plans/improve', `${SELF.replace(/^rr_/, '')}.md`)), '本轮方案文件在场');
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (fail > 0) process.exitCode = 1;
})();
