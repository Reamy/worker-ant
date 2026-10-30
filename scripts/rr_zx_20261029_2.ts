/**
 * zx_20261029_2 「通」受控回归 —— 一句话进得来，一台设备动得了，一张卡说得清。
 *
 * 八组判据（照方案 §4）：
 *   A 品类归一：协议自述 → 同一套类目；不按设备名字猜；旧行读时兜底。
 *   B 意图规则与失败细分：四个感受 + 三类可行动失败原因。
 *   C 模型兜底：整份校验、整份拒绝、失败回规则原因、K-6 仍拦。
 *   D 能力卡不泄密：门牌键集合全等、无实例；节点卡类目级；配对能力面五键。
 *   E 终端端到端：广播 → 配对 → 批准 → 能力面 → 意图两跳 → 设备动作 0→1；撤销即拒；拒绝 24h 静默。
 *   F 档位阶梯：九格矩阵 + 五个空档反证 + 插件闸先闸后发。
 *   G 自动派发：三态默认、满负荷才溢出、派单不阻断建单。
 *   H 产界面与构建：renderer 产物含新文案且独立 chunk 在位；build 钉；无前向字面量。
 *
 * 纪律：零网络 / 零 electron；夹具按生产 DDL 同形建表、先建表后插行；计数器带 0→1 正面断言；
 *   断言文案不含失败字形（全量汇总器按日志字形计数）；不以墙钟为判据。
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEVICE_KIND_CLASSES,
  DEVICE_KIND_CLASS_LABELS,
  isDeviceKindClass,
  kindClassOf,
  kindClassLabel,
  kindClassSource,
  deviceKindClassOf,
  type KindClassInput,
} from '../apps/worker-ant-desktop/src/main/core/device-kind.js';
import {
  COMFORT_RULES,
  comfortFailureMessage,
  devicesInRoom,
  planHomeComfort,
  resolveComfortIntent,
} from '../apps/worker-ant-desktop/src/main/core/home-intent.js';
import {
  INTENT_MODEL_MAX_OUTPUT_TOKENS,
  INTENT_MODEL_TIMEOUT_MS,
  MODEL_FORBIDDEN_ACTIONS,
  MODEL_ACTION_WHITELIST,
  modelPlanDevices,
  parseModelPlan,
  runComfortModelPlan,
  buildModelPlanPrompt,
} from '../apps/worker-ant-desktop/src/main/core/intent-model-plan.js';
import {
  agentSkillsFromCapabilities,
  deviceCategoryInventory,
  peerCapabilitySummary,
} from '../apps/worker-ant-desktop/src/main/core/capability-vocabulary.js';
import {
  AGENT_CARD_FIELDS,
  buildAgentCard,
  handleInboundRequest,
  INBOUND_CAPABILITIES_PATH,
  INBOUND_INTENT_EXECUTE_PATH,
  INBOUND_INTENT_RESOLVE_PATH,
  type InboundDeps,
  type InboundRequestLike,
  type InboundResult,
} from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
import {
  DEFAULT_TERMINAL_CAPABILITIES,
  EXTERNAL_CAPABILITY_LABEL,
  createExternalCapabilityPort,
  offeredCapabilities,
  redactedDevices,
} from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import {
  __resetTerminalSecretsForTest,
  approveTerminal,
  buildPairNotice,
  createPairRequestGuarded,
  createPairingPort,
  pairStatus,
  type TerminalDb,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import {
  LAN_BROWSE_FEATURE,
  LAN_SILENCE_MS,
  __resetLanPendingForTest,
  createTerminalBrowseLifecycle,
  ingestLanAnnouncement,
  isLanTerminalSilenced,
  listLanPending,
  pruneLanSilences,
  sanitizeTerminalTxt,
  silenceLanTerminal,
  takeLanPending,
  type LanIdentity,
  type TerminalAnnouncement,
  type TerminalBrowseIo,
} from '../apps/worker-ant-desktop/src/main/core/lan-terminals.js';
import {
  deviceControlVerdict,
  getDevice,
  listDevices,
  listRooms,
  recordDeviceAction,
  resolveDeviceByName,
  setDeviceAuthorized,
  upsertDiscovered,
  type AnsDevice,
  type DeviceControlOutcome,
  type DeviceDb,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { HOME_COMFORT_INTENT } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
import { publicIntents } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
import { buildNodeCard } from '../apps/worker-ant-desktop/src/main/core/node-card.js';
import {
  PRO_FEATURE_LABEL,
  PRO_FEATURES,
  proFeatureRefusal,
  proUnlocked,
} from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { TEAM_FEATURES, teamFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import {
  LICENSE_SETTING_KEYS,
  MAX_LICENSE_DEVICES,
  encodeLicense,
  licenseDeviceCap,
  resolveLicenseState,
  verifyLicense,
  type LicensePayload,
} from '../apps/worker-ant-desktop/src/main/core/license.js';
import { assertSeatAvailable, SeatLimitError } from '../apps/worker-ant-desktop/src/main/core/seat-quota.js';
import { SampleQuotaError, installSampleProject } from '../apps/worker-ant-desktop/src/main/core/sample-project.js';
import { countRedemptions, earlyBirdRefusal, earlyBirdRemaining } from '../apps/worker-ant-desktop/src/main/core/early-bird.js';
import { EARLY_BIRD } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import {
  CREATE_DISPATCH_REASON_LABEL,
  decideAutoDispatchPolicy,
  decideCreateDispatch,
  type CreateDispatchFacts,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import type { NodeCardCategory } from '@worker-ant/shared-types';
import { ROUND_RE, checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const MAIN = 'apps/worker-ant-desktop/src/main';
/** 本轮标识**由载体自身派生**（不写「只为下一轮」的字面量）。 */
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function countRows(d: DatabaseSync, table: string): number {
  return Number((d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function readCode(rel: string): string {
  return stripKeepingLines(readText(rel)).join('\n');
}

// ── 夹具 ──────────────────────────────────────────────────────────────────────

/** 门内夹具库——各表逐列照生产 DDL（`database.ts`，含迁移后的 `source` / `kind_class` 列）。 */
function makeDb(opts: { trial?: boolean } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_external_calls (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    args_json TEXT DEFAULT '{}',
    result TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    remote_addr TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  d.exec(`CREATE TABLE wa_external_terminals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pair_code TEXT NOT NULL,
    key_prefix TEXT,
    secret_hash TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    last_remote_addr TEXT,
    last_seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    approved_at TEXT,
    revoked_at TEXT,
    delivered_at TEXT,
    grant_expires_at TEXT,
    source TEXT DEFAULT 'remote'
  )`);
  d.exec(`CREATE TABLE wa_intent_plans (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    plan_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'planned',
    source TEXT NOT NULL DEFAULT 'rule',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    executed_at TEXT,
    result_json TEXT NOT NULL DEFAULT '{}'
  )`);
  d.exec(`CREATE INDEX idx_wa_intent_plans_status ON wa_intent_plans(status, expires_at)`);
  d.exec(`CREATE TABLE wa_device_actions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    args_json TEXT DEFAULT '{}',
    result TEXT DEFAULT '',
    task_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT '',
    actor_ref TEXT DEFAULT '',
    plan_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  d.exec(`CREATE TABLE wa_devices (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    alias TEXT DEFAULT '',
    room TEXT DEFAULT '',
    kind TEXT DEFAULT 'unknown',
    kind_class TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL,
    address TEXT NOT NULL,
    port INTEGER,
    capabilities_json TEXT DEFAULT '[]',
    controllable INTEGER DEFAULT 0,
    authorized INTEGER DEFAULT 0,
    status_json TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    online INTEGER
  )`);
  d.exec(`CREATE UNIQUE INDEX idx_wa_devices_ident ON wa_devices(protocol, address)`);
  d.exec(`CREATE TABLE wa_lan_terminal_silence (
    identity TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, silenced_until INTEGER NOT NULL
  )`);
  if (opts.trial !== false) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}

function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(key, value);
}

/** 台账设备的最小夹具（意图/能力卡判据读到的字段）。 */
function mkDev(
  id: string,
  name: string,
  kind: string,
  o: { room?: string; kind_class?: string; protocol?: string; capabilities?: string[]; controllable?: boolean; authorized?: boolean } = {},
): AnsDevice {
  return {
    id,
    name,
    alias: '',
    room: o.room ?? '',
    kind,
    kind_class: o.kind_class ?? '',
    protocol: o.protocol ?? 'mqtt',
    address: `fixture#${id}`,
    capabilities: o.capabilities ?? [],
    controllable: o.controllable ?? true,
    authorized: o.authorized ?? true,
  } as unknown as AnsDevice;
}

/** 假浏览 IO：记录起停次数，可手动投递广播/错误（不触网、不拉 bonjour-service）。 */
function makeFakeBrowseIo(): {
  io: TerminalBrowseIo;
  emit: (ann: TerminalAnnouncement) => void;
  starts: () => number;
} {
  let found: ((ann: TerminalAnnouncement) => void) | null = null;
  let starts = 0;
  return {
    io: {
      start(onFound) { starts++; found = onFound; },
      stop() { found = null; },
    },
    emit(ann) { found?.(ann); },
    starts: () => starts,
  };
}

const ann = (over: Partial<TerminalAnnouncement> = {}): TerminalAnnouncement => ({
  name: '隔壁的派单机',
  addresses: ['192.168.1.44'],
  port: 8765,
  txt: { version: '1.0.0', caps: 'intent_control' },
  ...over,
});

// 许可夹具：自签密钥对（rr 从不用产品私钥，验签公钥注入）。
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIV_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const FP = 'AAAA-BBBB-CCCC-DDDD';
const LICENSE_NOW = new Date('2026-10-29T00:00:00.000Z');
const LIC_OPTS = { now: LICENSE_NOW, fingerprint: FP, publicKeyPem: PUB_PEM };

function signedDb(tier: 'pro' | 'team', o: { expiresAt?: string | null; devices?: string[] } = {}): DatabaseSync {
  const d = makeDb({ trial: false });
  const payload: LicensePayload = {
    v: 1,
    tier,
    subject: 'rr-zx-20261029-2',
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: o.expiresAt !== undefined ? o.expiresAt : (tier === 'team' ? '2099-01-01T00:00:00.000Z' : null),
    devices: o.devices ?? [FP],
  };
  setSetting(d, LICENSE_SETTING_KEYS.key, encodeLicense(payload, PRIV_PEM));
  return d;
}
function trialDb(): DatabaseSync {
  const d = makeDb({ trial: false });
  setSetting(d, LICENSE_SETTING_KEYS.trialStartedAt, LICENSE_NOW.toISOString());
  return d;
}

async function main(): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【A】品类归一（协议自述 → 同一套类目；不按名字猜）');

  eq(kindClassOf({ kind: 'cover', protocol: 'mqtt', deviceClass: 'window' }), 'curtain', 'A-1 HA cover+window ⇒ curtain');
  eq(kindClassOf({ kind: 'cover', protocol: 'mqtt', deviceClass: 'garage' }), 'other', 'A-2 HA cover+garage ⇒ other（院门不是窗帘）');
  eq(kindClassOf({ kind: 'cover', protocol: 'mqtt' }), 'curtain', 'A-3 HA cover 无 device_class ⇒ curtain');
  eq(kindClassOf({ kind: 'climate', protocol: 'mqtt' }), 'aircon', 'A-4 HA climate ⇒ aircon');
  eq(kindClassOf({ kind: 'light', protocol: 'mqtt' }), 'light', 'A-5 HA light ⇒ light');
  eq(kindClassOf({ kind: 'fan', protocol: 'mqtt' }), 'fan', 'A-6 HA fan ⇒ fan');
  eq(kindClassOf({ kind: 'switch', protocol: 'mqtt' }), 'switch', 'A-7 HA switch ⇒ switch');

  const tuyaCells: Array<[string, string]> = [
    ['cl', 'curtain'], ['kt', 'aircon'], ['dj', 'light'],
    ['kg', 'switch'], ['wsq', 'sensor'], ['sb', 'vacuum'],
  ];
  for (const [cat, cls] of tuyaCells) {
    eq(kindClassOf({ kind: cat, protocol: 'cloud', provider: 'tuya' }), cls, `A-8 涂鸦 ${cat} ⇒ ${cls}`);
  }
  eq(kindClassOf({ kind: 'zzz', protocol: 'cloud', provider: 'tuya' }), 'unknown', 'A-9 涂鸦表外 ⇒ unknown（不猜）');

  const miioCells: Array<[string, string]> = [
    ['zhimi.aircondition.v1', 'aircon'],
    ['lumi.curtain.hagl05', 'curtain'],
    ['yeelink.light.color1', 'light'],
    ['chuangmi.plug.m1', 'switch'],
    ['roborock.vacuum.s5', 'vacuum'],
  ];
  for (const [model, cls] of miioCells) {
    eq(kindClassOf({ kind: 'unknown', protocol: 'miio', model }), cls, `A-10 米家 ${model} ⇒ ${cls}`);
  }
  eq(kindClassOf({ kind: 'unknown', protocol: 'miio', model: null }), 'unknown', 'A-11 米家无 model ⇒ unknown（无 token 不假装识别）');

  eq(kindClassOf({ kind: 'vendor-service', protocol: 'mdns', capabilities: ['urn:lamp'] }), 'light', 'A-12 mDNS 能力词兜底 ⇒ light');
  eq(kindClassOf({ kind: 'vendor-service', protocol: 'ssdp', capabilities: ['curtain-control'] }), 'curtain', 'A-13 SSDP 能力词兜底 ⇒ curtain');

  // 反证：设备名含「空调」而自述 switch ⇒ 不得归 aircon（判据根本不读名字）。
  const namedAircon = { kind: 'switch', protocol: 'mqtt', name: '客厅空调' } as unknown as KindClassInput;
  eq(kindClassOf(namedAircon), 'switch', 'A-14 反证：名字含「空调」但自述 switch ⇒ switch（不按名字猜）');

  // 台账侧：派生列优先；空串旧行读时兜底；脏值按 unknown（不拿脏值冒充）。
  eq(deviceKindClassOf({ kind: 'cover', kind_class: '', protocol: 'mqtt' }), 'curtain', 'A-15 旧行 kind_class 空 ⇒ 读时现算');
  eq(deviceKindClassOf({ kind: 'cover', kind_class: 'light', protocol: 'mqtt' }), 'light', 'A-16 派生列非空 ⇒ 以列为准');
  eq(deviceKindClassOf({ kind: 'cover', kind_class: 'bogus', protocol: 'mqtt' }), 'unknown', 'A-17 派生列脏值 ⇒ unknown（不回落猜测）');

  eq(kindClassLabel('unknown'), '品类未识别', 'A-18 unknown 人话');
  eq(kindClassLabel('not-a-class'), '品类未识别', 'A-19 表外人话按未识别');
  eq(kindClassLabel('curtain'), '窗帘', 'A-20 curtain 人话');
  ok(DEVICE_KIND_CLASSES.every((c) => DEVICE_KIND_CLASS_LABELS[c].length > 0), 'A-21 人话标签表逐项齐（漏项即编译期错）');
  eq(DEVICE_KIND_CLASSES.length, 13, 'A-22 类目表恰 13 项');
  ok(isDeviceKindClass('unknown') && !isDeviceKindClass('bogus'), 'A-23 类目校验器只认表内值');

  eq(kindClassSource('mqtt'), 'Home Assistant / MQTT 自述', 'A-24 来源：MQTT');
  eq(kindClassSource('cloud'), '厂商云品类', 'A-25 来源：厂商云');
  eq(kindClassSource('miio'), '米家设备型号', 'A-26 来源：米家');
  eq(kindClassSource('mdns'), '局域网 mDNS 自述', 'A-27 来源：mDNS');
  eq(kindClassSource('ssdp'), '局域网 SSDP 自述', 'A-28 来源：SSDP');
  eq(kindClassSource('http'), 'HTTP 自述', 'A-29 来源：HTTP');
  eq(kindClassSource('whatever'), '来源未知', 'A-30 表外协议如实说未知');

  // 写点：upsert 时算派生列（唯一写点），显式 kindClass 优先。
  {
    const d = makeDb();
    const devDb = d as unknown as DeviceDb;
    const c1 = upsertDiscovered(devDb, { name: '客厅窗帘', kind: 'cover', protocol: 'mqtt', address: 'a#1', capabilities: ['cover'], controllable: true, roomHint: '客厅' });
    eq(c1.kind_class, 'curtain', 'A-31 upsert 写入派生列（HA cover ⇒ curtain）');
    const raw = d.prepare('SELECT kind, kind_class FROM wa_devices WHERE id = ?').get(c1.id) as { kind?: string; kind_class?: string };
    eq({ kind: raw.kind, kind_class: raw.kind_class }, { kind: 'cover', kind_class: 'curtain' }, 'A-32 自述 kind 原样保留、派生列另存');
    const c2 = upsertDiscovered(devDb, { name: '涂鸦灯', kind: 'dj', protocol: 'cloud', address: 'tuya#1', capabilities: [] });
    eq(c2.kind_class, 'light', 'A-33 涂鸦 dj 经映射表 ⇒ light');
    const c3 = upsertDiscovered(devDb, { name: '院门', kind: 'cover', kindClass: 'other', protocol: 'mqtt', address: 'a#2', capabilities: ['cover'] });
    eq(c3.kind_class, 'other', 'A-34 协议入口给的显式 kindClass 优先');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【B】意图规则与失败细分（每个失败都带下一步）');

  const ruleShape = (f: 'hot' | 'cold' | 'dark' | 'bright') =>
    COMFORT_RULES[f].map((s) => s.action + (typeof s.args?.temperature === 'number' ? `:${s.args.temperature}` : ''));
  eq(ruleShape('hot'), ['close', 'set_temperature:26', 'turn_on'], 'B-1 hot 规则序列（关窗帘 / 26°C / 开风扇）');
  eq(ruleShape('cold'), ['close', 'set_temperature:24'], 'B-2 cold 规则序列（关窗帘 / 24°C）');
  eq(ruleShape('dark'), ['turn_on'], 'B-3 dark 规则序列（开灯）');
  eq(ruleShape('bright'), ['open'], 'B-4 bright 规则序列（开窗帘）');

  const curtain = mkDev('curtain-1', '客厅窗帘', 'cover', { room: '客厅', kind_class: 'curtain', capabilities: ['cover'] });
  const aircon = mkDev('aircon-1', '客厅空调', 'climate', { room: '客厅', kind_class: 'aircon', capabilities: [] });
  const fan = mkDev('fan-1', '客厅风扇', 'fan', { room: '客厅', kind_class: 'fan', capabilities: [] });
  const light = mkDev('light-1', '客厅灯', 'light', { room: '客厅', kind_class: 'light', capabilities: ['turn_on'] });

  eq(devicesInRoom([curtain, mkDev('x', '卧室灯', 'light', { room: '卧室' })], ' 客厅 ').map((d) => d.id), ['curtain-1'], 'B-5 房间名归一后精确匹配');

  const hot = planHomeComfort([curtain, aircon, fan], '客厅', 'hot');
  eq(hot.ok, true, 'B-6 hot 排出计划');
  if (hot.ok) {
    eq(hot.steps.map((s) => `${s.call_name}:${s.action}`), ['客厅窗帘:close', '客厅空调:set_temperature', '客厅风扇:turn_on'], 'B-7 hot 三步按规则序');
    eq(hot.steps[1]?.args, { temperature: 26 }, 'B-8 hot 空调参数 26°C');
    ok(hot.steps.every((s) => typeof s.reason === 'string' && s.reason.length > 0), 'B-9 每步带可解释 reason');
  }
  const cold = planHomeComfort([curtain, aircon], '客厅', 'cold');
  eq(cold.ok && cold.steps.map((s) => `${s.call_name}:${s.action}`), ['客厅窗帘:close', '客厅空调:set_temperature'], 'B-10 cold 两步');
  eq(cold.ok ? cold.steps[1]?.args : null, { temperature: 24 }, 'B-11 cold 空调参数 24°C');
  eq(planHomeComfort([light], '客厅', 'dark').ok, true, 'B-12 dark 开灯');
  const bright = planHomeComfort([curtain], '客厅', 'bright');
  eq(bright.ok && bright.steps.map((s) => `${s.call_name}:${s.action}`), ['客厅窗帘:open'], 'B-13 bright 开窗帘');

  const roomUnassigned = planHomeComfort([mkDev('u1', '窗帘', 'cover', { kind_class: 'curtain' })], '客厅', 'hot');
  eq(roomUnassigned, { ok: false, reason: 'room_unassigned' }, 'B-14 房里有未分房间设备 ⇒ room_unassigned');
  eq(planHomeComfort([mkDev('u2', '窗帘', 'cover', { room: '主卧', kind_class: 'curtain' })], '客厅', 'hot'),
    { ok: false, reason: 'no_controllable_device' }, 'B-15 房间空且无未分房间设备 ⇒ no_controllable_device');
  eq(planHomeComfort([mkDev('u3', '怪设备', 'mystery', { room: '客厅', kind_class: '' })], '客厅', 'hot'),
    { ok: false, reason: 'no_recognized_kind' }, 'B-16 有设备但品类全 unknown ⇒ no_recognized_kind');

  const unauthorizedLight = mkDev('light-2', '客厅灯', 'light', { room: '客厅', kind_class: 'light', authorized: false });
  const denied = planHomeComfort([unauthorizedLight], '客厅', 'dark');
  eq(denied.ok, false, 'B-17 未授权 ⇒ 不排计划');
  eq(denied.ok ? null : denied.reason, 'no_controllable_device', 'B-18 未授权归 no_controllable_device');
  const deniedSkip = denied.ok ? [] : (denied.skipped ?? []);
  eq(deniedSkip.length, 1, 'B-19 未授权设备如实进 skipped');
  ok(deniedSkip.length === 1 && /允许控制|尚未授权/.test(deniedSkip[0]!.reason), 'B-20 skipped 带可行动原因', deniedSkip[0]?.reason);

  ok(comfortFailureMessage('room_unassigned').includes('「设备」页'), 'B-21 room_unassigned 下一步指向设备页');
  ok(comfortFailureMessage('no_recognized_kind').includes('品类'), 'B-22 no_recognized_kind 下一步指向品类识别');
  ok(comfortFailureMessage('no_controllable_device').includes('窗帘'), 'B-23 no_controllable_device 说明缺哪类设备');
  ok(comfortFailureMessage('no_controllable_device', [{ call_name: 'x', reason: 'y' }]).includes('允许控制'), 'B-24 有 skipped 时指向授权开关');
  ok(comfortFailureMessage('invalid_params').includes('hot / cold / dark / bright'), 'B-25 invalid_params 给出合法取值');
  ok(comfortFailureMessage('unknown_intent').includes('home.comfort'), 'B-26 unknown_intent 指出唯一意图');
  ok(comfortFailureMessage('whatever').includes('稍后重试'), 'B-27 未知原因不静默');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【C】模型兜底（整份校验、整份拒绝、失败回规则原因、K-6 仍拦）');

  eq(INTENT_MODEL_TIMEOUT_MS, 20_000, 'C-1 模型调用超时 20s');
  eq(INTENT_MODEL_MAX_OUTPUT_TOKENS, 1024, 'C-2 模型输出 ≤1024 token');
  ok(MODEL_FORBIDDEN_ACTIONS.includes('set_mode'), 'C-3 set_mode 一律禁用');
  ok((MODEL_ACTION_WHITELIST.curtain ?? []).includes('stop'), 'C-4 窗帘白名单含 stop');

  const modelDevices = modelPlanDevices([curtain, aircon, unauthorizedLight, mkDev('u4', '未知', 'mystery', { room: '客厅' })], '客厅');
  eq(modelDevices.map((d) => d.call_name), ['客厅窗帘', '客厅空调'], 'C-5 模型清单只含同房间、品类已知、过 K-6 的设备');
  eq(Object.keys(modelDevices[0]!), ['call_name', 'kind_class', 'room', 'actions'], 'C-6 模型清单恰四键（脱敏）');
  eq(modelDevices[0]!.actions, ['open', 'close', 'stop', 'cover'], 'C-7 动作 = 类目白名单 ∪ 设备自述（去重）');
  ok(!JSON.stringify(modelDevices).includes('fixture#'), 'C-8 模型清单不带地址');
  const prompt = buildModelPlanPrompt({ room: '客厅', feeling: 'hot', devices: modelDevices });
  ok(prompt.includes('客厅') && !prompt.includes('fixture#'), 'C-9 提示词含房间与感受、不含设备地址');

  const legal = '{"steps":[{"call_name":"客厅空调","action":"turn_on","reason":"降温"}]}';
  const legalParsed = parseModelPlan(legal, modelDevices);
  eq(legalParsed, { ok: true, steps: [{ call_name: '客厅空调', action: 'turn_on', reason: '降温' }] }, 'C-10 合法回包通过');
  eq(parseModelPlan('```json\n' + legal + '\n```', modelDevices), legalParsed, 'C-11 带围栏仍能抠出 JSON');
  eq(parseModelPlan('not json', modelDevices), { ok: false, reason: 'model_not_json' }, 'C-12 非 JSON');
  eq(parseModelPlan('[]', modelDevices), { ok: false, reason: 'model_not_object' }, 'C-13 非对象');
  eq(parseModelPlan('{"steps":null}', modelDevices), { ok: false, reason: 'model_steps_missing' }, 'C-14 缺 steps');
  eq(parseModelPlan('{"steps":[]}', modelDevices), { ok: false, reason: 'model_steps_empty' }, 'C-15 空 steps');
  eq(parseModelPlan(JSON.stringify({ steps: [
    { call_name: '客厅窗帘', action: 'open' },
    { call_name: '客厅窗帘', action: 'close' },
    { call_name: '客厅窗帘', action: 'stop' },
  ] }), modelDevices), { ok: false, reason: 'model_steps_too_many' }, 'C-16 步数 > 设备数');
  eq(parseModelPlan('{"steps":[1]}', modelDevices), { ok: false, reason: 'model_step_not_object' }, 'C-17 步不是对象');
  eq(parseModelPlan('{"steps":[{"action":"turn_on"}]}', modelDevices), { ok: false, reason: 'model_step_call_name_missing' }, 'C-18 缺 call_name');
  eq(parseModelPlan('{"steps":[{"call_name":"客厅空调"}]}', modelDevices), { ok: false, reason: 'model_step_action_missing' }, 'C-19 缺 action');
  eq(parseModelPlan('{"steps":[{"call_name":"客厅空调","action":"set_mode"}]}', modelDevices), { ok: false, reason: 'model_forbidden_action' }, 'C-20 set_mode 整份拒绝');
  eq(parseModelPlan('{"steps":[{"call_name":"不存在的设备","action":"turn_on"}]}', modelDevices), { ok: false, reason: 'model_unknown_device' }, 'C-21 清单外设备整份拒绝');
  eq(parseModelPlan('{"steps":[{"call_name":"客厅空调","action":"set_speed"}]}', modelDevices), { ok: false, reason: 'model_action_not_allowed' }, 'C-22 白名单外动作整份拒绝');
  eq(parseModelPlan('{"steps":[{"call_name":"客厅空调","action":"turn_on","args":"x"}]}', modelDevices), { ok: false, reason: 'model_args_not_object' }, 'C-23 args 非对象');
  eq(parseModelPlan('{"steps":[{"call_name":"客厅空调","action":"set_temperature","args":{"temperature":35}}]}', modelDevices), { ok: false, reason: 'model_temperature_out_of_range' }, 'C-24 温度越界');
  eq(parseModelPlan('{"steps":[{"call_name":"客厅空调","action":"set_temperature","args":{"temperature":26}}]}', modelDevices).ok, true, 'C-25 温度 26 合法');
  eq(parseModelPlan('{"steps":[{"call_name":"客厅窗帘","action":"set_brightness","args":{"brightness":0}}]}', modelDevices).ok, false, 'C-26 亮度 0 越界');

  // 规则成功 ⇒ 不调模型（零额外延迟）。
  let modelCalls = 0;
  const ruleWin = await resolveComfortIntent(
    { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'hot' } },
    { listDevices: () => [curtain, aircon], modelPlan: async () => { modelCalls++; return { ok: false, reason: 'x' }; } },
  );
  eq(ruleWin.ok && ruleWin.source, 'rule', 'C-27 规则成功 source=rule');
  eq(modelCalls, 0, 'C-28 规则成功不调模型');

  // 规则失败 + 合法模型 ⇒ source=model。
  const onlyAircon = [aircon];
  let fallbackCalls = 0;
  const modeled = await resolveComfortIntent(
    { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'dark' } },
    {
      listDevices: () => onlyAircon,
      modelPlan: async () => { fallbackCalls++; return { ok: true, steps: [{ call_name: '客厅空调', action: 'turn_on' }] }; },
    },
  );
  eq(fallbackCalls, 1, 'C-29 规则失败才调模型（一次）');
  eq(modeled.ok && modeled.source, 'model', 'C-30 模型兜底 source=model');
  eq(modeled.ok ? modeled.steps.map((s) => `${s.call_name}:${s.action}`) : null, ['客厅空调:turn_on'], 'C-31 模型步骤原样落地');

  // 模型抛异常 ⇒ 原样回规则失败原因。
  const thrown = await resolveComfortIntent(
    { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'dark' } },
    { listDevices: () => onlyAircon, modelPlan: async () => { throw new Error('down'); } },
  );
  eq(thrown.ok, false, 'C-32 模型异常不假装执行');
  eq(thrown.ok ? null : thrown.reason, 'no_controllable_device', 'C-33 回规则失败原因');
  ok(!thrown.ok && typeof thrown.message === 'string' && thrown.message.includes('窗帘'), 'C-34 失败仍带可行动 message');

  // 模型指错设备 ⇒ 略过并记账，不悄悄滤掉。
  const misrouted = await resolveComfortIntent(
    { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'dark' } },
    { listDevices: () => onlyAircon, modelPlan: async () => ({ ok: true, steps: [{ call_name: '厨房灯', action: 'turn_on' }] }) },
  );
  eq(misrouted.ok, false, 'C-35 模型步骤全映射不上 ⇒ 不执行');
  const misSkip = misrouted.ok ? [] : (misrouted.skipped ?? []);
  ok(misSkip.some((s) => s.call_name === '厨房灯' && s.reason.includes('不在可执行清单')), 'C-36 映射不上进 skipped 并带原因');

  // K-6 反证：模型点名未授权设备也落不了地。
  const k6 = await resolveComfortIntent(
    { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'dark' } },
    {
      listDevices: () => [aircon, unauthorizedLight],
      modelPlan: async () => ({ ok: true, steps: [{ call_name: '客厅灯', action: 'turn_on' }] }),
    },
  );
  eq(k6.ok, false, 'C-37 模型无法绕过 K-6（未授权灯不执行）');
  ok(k6.ok ? false : (k6.skipped ?? []).some((s) => s.call_name === '客厅灯'), 'C-38 未授权设备在 skipped 中可见');

  const noModel = await resolveComfortIntent(
    { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'dark' } },
    { listDevices: () => onlyAircon },
  );
  eq(noModel.ok, false, 'C-39 未装配模型 ⇒ 只走规则');

  // runComfortModelPlan 的失败分层（永不抛）。
  const clientOk = { getOptimalModel: async () => ({ url: 'http://ans.local/v1', api_key: 'k', model_name: 'm' }) };
  const genOk = async () => ({ text: legal });
  eq((await runComfortModelPlan({ room: '主卧', feeling: 'hot', devices: onlyAircon }, { getAnsClient: async () => clientOk, generate: genOk })), { ok: false, reason: 'no_usable_device' }, 'C-40 无可执行设备 ⇒ no_usable_device');
  eq((await runComfortModelPlan({ room: '客厅', feeling: 'hot', devices: onlyAircon }, { getAnsClient: async () => { throw new Error('offline'); } })), { ok: false, reason: 'ans_unavailable' }, 'C-41 ANS 不可用 ⇒ ans_unavailable');
  eq((await runComfortModelPlan({ room: '客厅', feeling: 'hot', devices: onlyAircon }, { getAnsClient: async () => ({ getOptimalModel: async () => ({}) }) })), { ok: false, reason: 'no_model' }, 'C-42 未配置模型 ⇒ no_model');
  const failedRun = await runComfortModelPlan(
    { room: '客厅', feeling: 'hot', devices: onlyAircon },
    { getAnsClient: async () => clientOk, generate: async () => { throw new Error('boom'); } },
  );
  ok(!failedRun.ok && failedRun.reason.startsWith('model_call_failed'), 'C-43 生成失败如实回因');
  const runOk = await runComfortModelPlan({ room: '客厅', feeling: 'hot', devices: onlyAircon }, { getAnsClient: async () => clientOk, generate: genOk });
  eq(runOk.ok, true, 'C-44 模型回包合规 ⇒ 出步骤');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【D】能力卡不泄密（类目公开，清单遮蔽）');

  const cardDevices = [
    { kind: 'light', kind_class: 'light', protocol: 'mqtt', capabilities: ['turn_on'], room: '主卧', name: '主卧吸顶灯', address: 'mqtt#secret' },
    { kind: 'mystery', kind_class: '', protocol: 'mqtt', capabilities: [], room: '主卧', name: '无名设备' },
  ];
  const card = buildAgentCard('本机的工蚁', '0.1.0', null, cardDevices);
  eq(Object.keys(card), [...AGENT_CARD_FIELDS], 'D-1 门牌键集合与 AGENT_CARD_FIELDS 全等');
  eq(card.device_categories, [{ class: 'light', label: '灯', count: 1 }], 'D-2 device_categories 只有类目+数量（unknown 不列）');
  eq(card.skills, agentSkillsFromCapabilities(offeredCapabilities()), 'D-3 skills 同源于 capability-vocabulary');
  eq(card.intents, publicIntents(), 'D-4 意图目录取 intent-protocol 真源');
  const cardJson = JSON.stringify(card);
  ok(!cardJson.includes('主卧吸顶灯') && !cardJson.includes('主卧') && !cardJson.includes('mqtt#secret'), 'D-5 门牌不含设备名/房间/地址');
  ok(!/"(authorized|controllable|address|port|protocol_)"/.test(cardJson), 'D-6 门牌不含授权态/网络坐标字段');

  const inv = deviceCategoryInventory(cardDevices as never);
  eq(inv, [{ class: 'light', label: '灯', count: 1 }], 'D-7 类目清单算法只数已知类目');
  eq(peerCapabilitySummary(cardDevices as never).intents, publicIntents().map((i) => ({ id: i.id, label: i.label })), 'D-8 节点摘要的意图只留 id/label');

  {
    const d = makeDb();
    const devDb = d as unknown as DeviceDb;
    upsertDiscovered(devDb, { name: '主卧吸顶灯', kind: 'light', protocol: 'mqtt', address: 'mqtt#secret', capabilities: ['turn_on'], controllable: true, roomHint: '主卧' });
    const node = buildNodeCard({ id: 'node-1', name: '本机的工蚁' } as never, devDb, 'darwin');
    ok(node.categories.includes('device'), 'D-9 节点卡按真台账派生 device 类目');
    eq(node.device_categories, [{ class: 'light', label: '灯', count: 1 }], 'D-10 节点卡带类目+数量');
    eq(node.intents, publicIntents().map((i) => ({ id: i.id, label: i.label })), 'D-11 节点卡带意图 id/label');
    const nodeJson = JSON.stringify(node);
    ok(!nodeJson.includes('主卧吸顶灯') && !nodeJson.includes('主卧') && !nodeJson.includes('mqtt#secret'), 'D-12 节点卡无设备实例/房间/地址');
  }

  {
    const dev = mkDev('red-1', '主卧吸顶灯', 'light', { room: '主卧', kind_class: 'light', capabilities: ['turn_on'] });
    const red = redactedDevices([dev]);
    eq(Object.keys(red[0]!), ['call_name', 'kind', 'kind_class', 'room', 'actions'], 'D-13 配对能力面恰五键');
    eq({ room: red[0]!.room, kind_class: red[0]!.kind_class }, { room: '主卧', kind_class: 'light' }, 'D-14 配对后可见房间与类目');
    const redJson = JSON.stringify(red);
    ok(!redJson.includes('fixture#') && !redJson.includes('"authorized"') && !redJson.includes('"controllable"'), 'D-15 配对能力面仍无地址/授权态');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【E】终端端到端（发现 → 配对 → 批准 → 能力面 → 两跳 → 动作 0→1）');

  __resetLanPendingForTest();
  __resetTerminalSecretsForTest();
  const db = makeDb();
  const tdb = db as unknown as TerminalDb;
  const devDb = db as unknown as DeviceDb;

  let doorOpen = true;
  const fake = makeFakeBrowseIo();
  const seen: Array<{ id: string; name: string }> = [];
  const lc = createTerminalBrowseLifecycle(db as never, {
    io: fake.io,
    isDoorRunning: () => doorOpen,
    onDiscovered: (item) => seen.push({ id: item.id, name: item.name }),
  });
  eq(LAN_BROWSE_FEATURE, 'multi_node', 'E-1a 常驻发现归 multi_node（与团队闸同词表）');
  eq(lc.start(), true, 'E-1b 门在监听且 Team 解锁 ⇒ 起浏览');
  eq(fake.starts(), 1, 'E-1c 假 IO 恰被起一次');
  eq(lc.status().running, true, 'E-1d status.running 如实为真');
  eq(lc.status().door_open, true, 'E-1e status.door_open 如实为真');
  eq(lc.status().locked, false, 'E-1f status.locked 如实为假');
  ok(/在运行/.test(lc.status().detail), 'E-1g 运行中的说明说人话');
  eq(lc.start(), true, 'E-1h 重复 start 幂等');
  eq(fake.starts(), 1, 'E-1i 幂等不重起（不丢已听到的列表）');

  lc.stop();
  eq(lc.status().running, false, 'E-1j stop 后 running 如实转假');
  const doorOffFake = makeFakeBrowseIo();
  doorOpen = false;
  const lcDoorOff = createTerminalBrowseLifecycle(db as never, { io: doorOffFake.io, isDoorRunning: () => doorOpen });
  eq(lcDoorOff.start(), false, 'E-1k 门未开 ⇒ 不起浏览');
  eq(doorOffFake.starts(), 0, 'E-1l 假 IO 一次也没起');
  ok(/入站门未开/.test(lcDoorOff.status().detail), 'E-1m 未跑的因如实说出（门未开）');

  const lockedDb = makeDb({ trial: false });
  const lockedFake = makeFakeBrowseIo();
  const lcLocked = createTerminalBrowseLifecycle(lockedDb as never, { io: lockedFake.io, isDoorRunning: () => true });
  eq(lcLocked.start(), false, 'E-1n Team 未解锁 ⇒ 不起浏览');
  eq(lockedFake.starts(), 0, 'E-1o 锁定时假 IO 一次也没起');
  eq(lcLocked.status().locked, true, 'E-1p status.locked 如实为真');
  ok(/团队版/.test(lcLocked.status().detail), 'E-1q 锁定的因如实说出（团队版）');

  console.log('\n【E-2】广播 → 待接入（发现 ≠ 授权）');
  doorOpen = true;
  eq(lc.start(), true, 'E-2a 门回来 ⇒ 重新起浏览');
  fake.emit(ann());
  const pending = listLanPending();
  eq(pending.length, 1, 'E-2b 广播进待接入列表（恰 1 条）');
  eq(pending[0]?.name, '隔壁的派单机', 'E-2c 名字如实沿用自述名');
  eq(pending[0]?.address, '192.168.1.44', 'E-2d 地址如实（私网）');
  eq(pending[0]?.version, '1.0.0', 'E-2e TXT 白名单内 version 被收下');
  eq(pending[0]?.capabilities, ['intent_control'], 'E-2f 能力类目如实（来自 TXT caps）');
  eq(seen.length, 1, 'E-2g onDiscovered 恰回调一次');
  eq(countRows(db, 'wa_external_terminals'), 0, 'E-2h 发现不落终端台账（发现 ≠ 授权）');
  const clean = sanitizeTerminalTxt({ version: '1.0.0', caps: 'intent_control', token: 'abc', secret_key: 'x' });
  ok(clean.stripped.includes('token(credential-like)'), 'E-2i 像凭据的 TXT 键被点名丢弃');
  ok(clean.stripped.includes('secret_key(credential-like)'), 'E-2j 名字含 secret/key 的键同样点名');

  console.log('\n【E-3】接入 → 配对申请（走既有配对编排）');
  const item = pending[0]!;
  const pair = createPairRequestGuarded(tdb, item.name, item.address, { source: 'lan' });
  ok(pair.ok, 'E-3a 接入成功建待批申请');
  if (!pair.ok) throw new Error('配对申请失败');
  takeLanPending(item.id);
  eq(listLanPending().length, 0, 'E-3b 接入后从待接入列表移除');
  const sourceRow = db.prepare('SELECT source, status FROM wa_external_terminals WHERE id = ?').get(pair.pairingId) as
    { source?: string; status?: string } | undefined;
  eq(sourceRow?.source, 'lan', 'E-3c 来路列如实记 lan');
  eq(sourceRow?.status, 'pending', 'E-3d 申请落 pending（批准前无凭据）');
  const notice = buildPairNotice({ name: item.name, pairCode: pair.pairCode, source: 'lan' });
  ok(notice.includes(EXTERNAL_CAPABILITY_LABEL.intent_control), 'E-3e IM 回执写明授予的能力类目');
  ok(!notice.includes(EXTERNAL_CAPABILITY_LABEL.device_control), 'E-3f 反证：默认不授予原始设备控制');
  ok(notice.includes('批准后可在「协同面板」页撤销'), 'E-3g IM 回执写明撤销去处');
  ok(notice.includes('来自局域网发现'), 'E-3h IM 回执仍写明来路');
  ok(notice.includes(`同意接入 ${pair.pairCode}`) && notice.includes(`拒绝接入 ${pair.pairCode}`), 'E-3i 两条可照抄的命令都在');

  console.log('\n【E-4】批准 → 凭据只回一次');
  const ap = approveTerminal(tdb, pair.pairingId, [...DEFAULT_TERMINAL_CAPABILITIES]);
  eq(ap, { ok: true }, 'E-4a 批准落库 + 铸凭据');
  const first = pairStatus(tdb, pair.pairingId, pair.pairCode);
  eq(first.status, 'approved', 'E-4b 首次轮询 approved');
  ok(first.status === 'approved' && !!first.credentials, 'E-4c 首次轮询带凭据');
  const cred = first.status === 'approved' && first.credentials ? first.credentials : null;
  if (!cred) throw new Error('凭据未取回');
  eq(pairStatus(tdb, pair.pairingId, pair.pairCode), { status: 'approved' }, 'E-4d 再次轮询不再回凭据');

  console.log('\n【E-5】能力面 → 意图两跳 → 设备动作 0→1');
  const curtain0 = upsertDiscovered(devDb, {
    name: '客厅窗帘', kind: 'cover', protocol: 'mqtt', address: 'b#客厅#窗帘',
    capabilities: ['cover'], controllable: true, roomHint: '客厅',
  });
  setDeviceAuthorized(devDb, curtain0.id, true);
  const curtainDev: AnsDevice = getDevice(devDb, curtain0.id)!;
  eq(curtainDev.room, '客厅', 'E-5a 设备落客厅（房间靠显式数据）');

  const port = createExternalCapabilityPort(db as never, {
    listDevices: () => listDevices(devDb),
    listRooms: () => listRooms(devDb),
    resolveIntentSteps: (input) => resolveComfortIntent(input, { listDevices: () => listDevices(devDb) }),
    controlDevice: async (inner): Promise<DeviceControlOutcome> => {
      const key = (inner.name ?? inner.deviceId ?? '').trim();
      const r = resolveDeviceByName(devDb, key);
      if (!r.ok) {
        return {
          ok: false, denied: true, reason: r.reason, deviceId: '', action: inner.action,
          error: `控制被拒（${r.reason}）`, how_to_authorize: '先用 capabilities 取设备清单，再按 call_name 指定一台。',
        };
      }
      recordDeviceAction(devDb, {
        deviceId: r.device.id, action: inner.action, args: inner.args, result: 'ok',
        actor: { kind: 'external', ref: inner.terminalId ?? '' }, planId: inner.planId,
      });
      return { ok: true, deviceId: r.device.id, action: inner.action, result: 'closed' };
    },
    now: () => new Date('2026-10-29T00:00:00Z'),
  });
  const deps: InboundDeps = {
    nodeName: () => '客厅的工蚁',
    agentVersion: '0.1.0',
    pairing: createPairingPort(tdb),
    capability: port,
  };
  const call = async (method: string, p: string, body?: unknown): Promise<InboundResult> => {
    const req: InboundRequestLike = {
      method, path: p, remoteAddress: '192.168.1.44',
      headers: { authorization: `Bearer ${cred.key}.${cred.secret}` },
      ...(body === undefined ? {} : { body }),
    };
    return await handleInboundRequest(req, deps);
  };

  const caps = await call('GET', INBOUND_CAPABILITIES_PATH);
  eq(caps.status, 200, 'E-5b /capabilities 200');
  const capsBody = caps.body as { rooms?: string[]; devices?: Array<{ call_name?: string; room?: string; kind_class?: string }> };
  ok((capsBody.rooms ?? []).includes('客厅'), 'E-5c 已登记房间在场');
  const devRow = (capsBody.devices ?? []).find((d) => d.call_name === '客厅窗帘');
  ok(!!devRow, 'E-5d 设备按 call_name 出现在能力面');
  eq(devRow?.room, '客厅', 'E-5e 设备行带 room');
  eq(devRow?.kind_class, 'curtain', 'E-5f 设备行带 kind_class');

  eq(countRows(db, 'wa_device_actions'), 0, 'E-5g 解析前设备动作账恰 0 行');
  eq(countRows(db, 'wa_external_calls'), 0, 'E-5h 解析前外部调用账恰 0 行');
  const resolved = await call('POST', INBOUND_INTENT_RESOLVE_PATH, {
    intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'hot' },
  });
  eq(resolved.status, 200, 'E-5i 意图解析 200');
  const rb = resolved.body as { planId?: string; steps?: Array<{ call_name?: string; action?: string }>; skipped?: unknown[]; source?: string };
  ok(typeof rb.planId === 'string' && rb.planId.length > 0, 'E-5j 回 planId');
  eq(rb.steps?.map((s) => `${s.call_name}:${s.action}`), ['客厅窗帘:close'], 'E-5k hot ⇒ 恰一步（关窗帘）');
  eq(rb.skipped, [], 'E-5l 没有该略过的设备');
  eq(rb.source, 'rule', 'E-5m 规则路径排出的计划');
  eq(countRows(db, 'wa_intent_plans'), 1, 'E-5n 计划账 0→1');
  eq(countRows(db, 'wa_device_actions'), 0, 'E-5o 解析期零设备动作');
  eq(countRows(db, 'wa_external_calls'), 1, 'E-5p 解析留痕 0→1');
  const planId = rb.planId!;

  const executed = await call('POST', INBOUND_INTENT_EXECUTE_PATH, { planId });
  eq(executed.status, 200, 'E-5q 意图执行 200');
  const eb = executed.body as { planId?: string; status?: string; steps?: Array<{ ok?: boolean }> };
  eq(eb.status, 'executed', 'E-5r 计划收口 executed');
  eq(eb.steps?.map((s) => s.ok), [true], 'E-5s 逐步结果恰一步成功');
  eq(countRows(db, 'wa_device_actions'), 1, 'E-5t 设备动作账 0→1（正面计数）');
  const act = db.prepare('SELECT device_id, action, result, actor_kind, actor_ref, plan_id FROM wa_device_actions').get() as
    { device_id?: string; action?: string; result?: string; actor_kind?: string; actor_ref?: string; plan_id?: string };
  eq(act.device_id, curtainDev.id, 'E-5u 动作挂在真设备 id 上');
  eq(act.action, 'close', 'E-5v 动作如实为 close');
  eq(act.result, 'ok', 'E-5w 动作结果 ok');
  eq(act.actor_kind, 'external', 'E-5x 审计记发起者类别 external');
  eq(act.actor_ref, pair.pairingId, 'E-5y 审计记发起终端 id');
  eq(act.plan_id, planId, 'E-5z 审计行与计划一一对应');
  eq(countRows(db, 'wa_external_calls'), 2, 'E-5aa 执行留痕 1→2');

  console.log('\n【E-6】撤销后凭据立即失效');
  db.prepare(`UPDATE wa_external_terminals SET status='revoked', revoked_at=datetime('now') WHERE id=?`).run(pair.pairingId);
  const afterRevoke = await call('GET', INBOUND_CAPABILITIES_PATH);
  eq(afterRevoke.status, 403, 'E-6a 撤销后调用被拒（403）');
  ok(/revoked/.test(JSON.stringify(afterRevoke.body)), 'E-6b 拒因如实（revoked）');

  console.log('\n【E-7】拒绝路径 24h 静默');
  const SIL0 = 1_800_000_000_000;
  const identity: LanIdentity = { name: '隔壁的派单机', address: '192.168.1.44' };
  silenceLanTerminal(db as never, identity, SIL0);
  eq(isLanTerminalSilenced(db as never, identity, SIL0 + 3600_000), true, 'E-7a 拒绝后 1h 内仍静默');
  eq(isLanTerminalSilenced(db as never, identity, SIL0 + LAN_SILENCE_MS + 1), false, 'E-7b 超过 24h 自动失效');
  __resetLanPendingForTest();
  eq(ingestLanAnnouncement(ann(), SIL0 + 1000, { isSilenced: (t) => isLanTerminalSilenced(db as never, t, SIL0 + 1000) }), null, 'E-7c 静默期内广播不进待接入');
  silenceLanTerminal(db as never, identity, SIL0);
  eq(pruneLanSilences(db as never, SIL0 + LAN_SILENCE_MS + 1), 1, 'E-7d 过期静默行被清掉（表不只增不减）');
  __resetLanPendingForTest();
  const afterSilence = ingestLanAnnouncement(ann(), SIL0 + LAN_SILENCE_MS + 2, { isSilenced: (t) => isLanTerminalSilenced(db as never, t, SIL0 + LAN_SILENCE_MS + 2) });
  ok(afterSilence !== null, 'E-7e 静默期满后同一台可再次被发现');

  lc.stop();
  __resetLanPendingForTest();
  __resetTerminalSecretsForTest();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【F】档位阶梯（九格矩阵 + 五个空档）');

  const communityDb = makeDb({ trial: false });
  const proDb = signedDb('pro');
  const teamDb = signedDb('team');
  const trial = trialDb();

  eq(resolveLicenseState(communityDb, LIC_OPTS).tier, 'community', 'F-1 无许可 ⇒ 社区版');
  eq(resolveLicenseState(proDb, LIC_OPTS).tier, 'pro', 'F-2 自签 Pro 件 ⇒ 专业版');
  eq(resolveLicenseState(teamDb, LIC_OPTS).tier, 'team', 'F-3 自签 Team 件 ⇒ 团队版');
  const trialState = resolveLicenseState(trial, LIC_OPTS);
  eq({ tier: trialState.tier, kind: trialState.kind }, { tier: 'team', kind: 'trial' }, 'F-4 试用 = 团队版（14 天）');
  ok(proUnlocked({ tier: 'community', kind: 'none' }) === false, 'F-5 社区档 Pro 未解锁');
  ok(proUnlocked({ tier: 'team', kind: 'licensed' }) === true, 'F-6 团队档 Pro 已解锁');

  ok(proFeatureRefusal(communityDb, 'device_discovery', LIC_OPTS) !== null, 'F-7a 社区：设备发现锁');
  ok(teamFeatureRefusal(communityDb, 'device_control', LIC_OPTS) !== null, 'F-7b 社区：设备控制锁');
  ok(proFeatureRefusal(communityDb, 'plugin_install', LIC_OPTS) !== null, 'F-7c 社区：插件安装锁');
  ok(proFeatureRefusal(proDb, 'device_discovery', LIC_OPTS) === null, 'F-8a Pro：设备发现开');
  ok(teamFeatureRefusal(proDb, 'device_control', LIC_OPTS) !== null, 'F-8b Pro：设备控制仍锁');
  ok(proFeatureRefusal(proDb, 'plugin_install', LIC_OPTS) === null, 'F-8c Pro：插件安装开');
  ok(proFeatureRefusal(teamDb, 'device_discovery', LIC_OPTS) === null, 'F-9a Team：设备发现开');
  ok(teamFeatureRefusal(teamDb, 'device_control', LIC_OPTS) === null, 'F-9b Team：设备控制开');
  ok(proFeatureRefusal(teamDb, 'plugin_install', LIC_OPTS) === null, 'F-9c Team：插件安装开');
  ok(proFeatureRefusal(trial, 'device_discovery', LIC_OPTS) === null && teamFeatureRefusal(trial, 'device_control', LIC_OPTS) === null && proFeatureRefusal(trial, 'plugin_install', LIC_OPTS) === null, 'F-10 试用九格全开（同 Team）');

  ok(PRO_FEATURES.includes('device_discovery') && PRO_FEATURES.includes('plugin_install'), 'F-11 Pro 能力表含发现与插件安装');
  ok(!TEAM_FEATURES.includes('device_discovery' as never), 'F-12 设备发现已移出 Team 能力表（不重复一只闸）');
  eq(PRO_FEATURE_LABEL.device_discovery, '设备发现（只读台账）', 'F-13 发现卖点名实相符（只读台账）');
  eq(PRO_FEATURE_LABEL.plugin_install, '市场插件安装', 'F-14 插件卖点只说安装');
  const refusalText = proFeatureRefusal(communityDb, 'plugin_install', LIC_OPTS) ?? '';
  ok(refusalText.includes('专业版') && refusalText.includes('市场插件安装'), 'F-15 拒因带能力名与升级方向', refusalText);

  // 插件闸：先闸后发（不把请求递给 ANS，故不会远端落行）。
  {
    const ih = readCode(`${MAIN}/ipc-handlers.ts`);
    const reLiteral = String.raw`/^\/api\/v1\/plugins\/[^/?#]+\/install(?:\?.*)?$/`;
    ok(ih.includes(reLiteral), 'F-16 安装路径形状写死为正则（不误伤 uninstall）');
    const gateIdx = ih.indexOf("proFeatureRefusal(_dbForAns as LicenseSettingDb | null, 'plugin_install')");
    const ansIdx = ih.indexOf('await getAnsClient()');
    ok(gateIdx > 0 && ansIdx > gateIdx, 'F-17 闸先于任何 ANS 调用（社区档不落远端行）');
    ok(ih.includes("code: 'PRO_REQUIRED'"), 'F-18 拒因回 PRO_REQUIRED（界面可读）');
    const installRe = /^\/api\/v1\/plugins\/[^/?#]+\/install(?:\?.*)?$/;
    ok(installRe.test('/api/v1/plugins/x/install') && installRe.test('/api/v1/plugins/x/install?force=1'), 'F-19 安装路径命中');
    ok(!installRe.test('/api/v1/plugins/x/uninstall') && !installRe.test('/api/v1/plugins/x/install/extra'), 'F-20 反证：卸载/子路径不误伤');
  }

  // 空档①：种子管理员过本机账号闸。
  {
    const seatDb = new DatabaseSync(':memory:');
    seatDb.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    seatDb.exec(`CREATE TABLE wa_users (id TEXT PRIMARY KEY, email TEXT)`);
    seatDb.prepare('INSERT INTO wa_users (id, email) VALUES (?, ?)').run('u1', 'a@b.c');
    let seatErr: unknown = null;
    try { assertSeatAvailable(seatDb as never, 'community'); } catch (e) { seatErr = e; }
    ok(seatErr instanceof SeatLimitError, 'F-21 社区档坐满 1 人 ⇒ 新增被拦');
    ok(seatErr instanceof SeatLimitError && seatErr.code === 'SEAT_LIMIT' && /1\/1/.test(seatErr.message), 'F-22 拒因带已用/上限（1/1）', seatErr instanceof Error ? seatErr.message : '');
    let seatThrew = false;
    const emptySeat = new DatabaseSync(':memory:');
    emptySeat.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    emptySeat.exec(`CREATE TABLE wa_users (id TEXT PRIMARY KEY, email TEXT)`);
    try { assertSeatAvailable(emptySeat as never, 'community'); } catch { seatThrew = true; }
    ok(!seatThrew, 'F-23 首次安装（0 人）必过闸');
    const dbs = readCode(`${MAIN}/database.ts`);
    const seatIdx = dbs.indexOf('assertSeatAvailable(db, resolveLicenseTier(db));');
    const seedInsert = dbs.indexOf('INSERT INTO wa_users (id, email, name, role)');
    ok(seatIdx > 0 && seedInsert > seatIdx, 'F-24 种子管理员插入前过同一道闸');
  }

  // 空档②：示例项目计入项目配额（先闸后写）。
  {
    const pdb = new DatabaseSync(':memory:');
    pdb.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    pdb.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '')`);
    pdb.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('real-1', '真实项目');
    let sampleErr: unknown = null;
    try { installSampleProject(pdb as never, path.join(ROOT, 'data')); } catch (e) { sampleErr = e; }
    ok(sampleErr instanceof SampleQuotaError, 'F-25 社区档已有 1 项目 ⇒ 示例载入被拦');
    ok(sampleErr instanceof SampleQuotaError && sampleErr.code === 'PROJECT_QUOTA', 'F-26 拒因码 PROJECT_QUOTA（与手工建项同一判据）');
    eq(countRows(pdb, 'wa_projects'), 1, 'F-27 被拦时一行也没多写（先闸后写）');
  }

  // 空档③：运行时拒永久 Team 许可（与签发工具同一把尺）。
  {
    const permanent = encodeLicense({ v: 1, tier: 'team', subject: 't', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, devices: [FP] }, PRIV_PEM);
    const r = verifyLicense(permanent, { now: LICENSE_NOW, fingerprint: FP, publicKeyPem: PUB_PEM });
    eq(r.status, 'bad_payload', 'F-28 永久 Team 件被运行时拒');
    ok(r.detail.includes('团队授权包必须有到期日'), 'F-29 拒因说明为何拒（按包销售）');
    const okTeam = verifyLicense(encodeLicense({ v: 1, tier: 'team', subject: 't', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', devices: [FP] }, PRIV_PEM), { now: LICENSE_NOW, fingerprint: FP, publicKeyPem: PUB_PEM });
    eq(okTeam.status, 'valid', 'F-30 带到期日的 Team 件合法');
    const okPro = verifyLicense(encodeLicense({ v: 1, tier: 'pro', subject: 't', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, devices: [FP] }, PRIV_PEM), { now: LICENSE_NOW, fingerprint: FP, publicKeyPem: PUB_PEM });
    eq(okPro.status, 'valid', 'F-31 永久 Pro 件仍合法（两向标本）');
    const tool = readCode('scripts/issue-license.ts');
    ok(tool.includes('团队授权包须带 --devices') && tool.includes('--any-device'), 'F-32 签发工具缺省要求绑定设备（任意机器须显式 opt-in）');
    ok(tool.indexOf('verifyLicense(lic') > 0 && tool.indexOf('fs.appendFileSync(EARLY_BIRD_LEDGER') > tool.indexOf('verifyLicense(lic'), 'F-33 早鸟核销只在签前自证通过后落账');
  }

  // 空档④：设备绑定额度随档位（与协同节点上限同源）；不绑定=任意机器（如实登记的软空档）。
  eq(licenseDeviceCap('team'), TIER_LIMITS.team.maxNodes, 'F-34 Team 设备绑定额 = 协同节点上限（同源）');
  eq(licenseDeviceCap('pro'), MAX_LICENSE_DEVICES, 'F-35 Pro/社区 绑定上限 = 3');
  {
    const many = Array.from({ length: TIER_LIMITS.team.maxNodes + 1 }, (_, i) => `FP-${i}`);
    const over = verifyLicense(encodeLicense({ v: 1, tier: 'team', subject: 't', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', devices: many }, PRIV_PEM), { now: LICENSE_NOW, fingerprint: FP, publicKeyPem: PUB_PEM });
    eq(over.status, 'too_many_devices', 'F-36 超出绑定台数被拒');
    const unbound = verifyLicense(encodeLicense({ v: 1, tier: 'team', subject: 't', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', devices: [] }, PRIV_PEM), { now: LICENSE_NOW, fingerprint: FP, publicKeyPem: PUB_PEM });
    eq(unbound.status, 'valid', 'F-37 已知软空档：空绑定 = 任意机器（签发工具侧要求 opt-in）');
  }

  // 空档⑤：早鸟名额闸。
  eq(earlyBirdRemaining(0), EARLY_BIRD.seats, 'F-38 未核销时余量 = 总席位');
  eq(earlyBirdRemaining(EARLY_BIRD.seats), 0, 'F-39 售罄余量为 0');
  eq(earlyBirdRemaining(EARLY_BIRD.seats + 50), 0, 'F-40 超额登记不出现负余量');
  eq(earlyBirdRefusal(0), null, 'F-41 有余量可售');
  const fullRefusal = earlyBirdRefusal(EARLY_BIRD.seats) ?? '';
  ok(fullRefusal.includes('已售罄') && fullRefusal.includes(`${EARLY_BIRD.seats} 席`), 'F-42 售罄拒因带总数', fullRefusal);
  eq(countRedemptions('{"a":1}\n\nnot-json\n[1]\n{"b":2}\n'), 2, 'F-43 台账计数只认合法 JSON 对象行');
  eq(EARLY_BIRD.appliesTier, 'pro', 'F-44 早鸟档位 = Pro（价目表一处真源）');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【G】自动派发（三态默认 + 满负荷才溢出）');

  const defOn = decideAutoDispatchPolicy({ raw: '', teamUnlocked: true, enrolled: true });
  eq({ enabled: defOn.enabled, source: defOn.source }, { enabled: true, source: 'default' }, 'G-1 未配置 + Team + 入网 ⇒ 缺省开');
  ok(defOn.reason.includes('满负荷'), 'G-2 理由写明「仅满负荷才溢出」');
  const explicitOn = decideAutoDispatchPolicy({ raw: ' 1 ', teamUnlocked: false, enrolled: false });
  eq({ enabled: explicitOn.enabled, source: explicitOn.source }, { enabled: true, source: 'explicit' }, 'G-3 显式 1 ⇒ 开（首尾空白归一）');
  eq(decideAutoDispatchPolicy({ raw: '0', teamUnlocked: true, enrolled: true }).enabled, false, 'G-4 显式 0 ⇒ 关');
  const garbled = decideAutoDispatchPolicy({ raw: 'yes', teamUnlocked: true, enrolled: true });
  ok(!garbled.enabled && garbled.reason.includes('无法识别'), 'G-5 近似真值一律关且如实说因');
  const noTeam = decideAutoDispatchPolicy({ raw: '', teamUnlocked: false, enrolled: true });
  ok(!noTeam.enabled && noTeam.source === 'default' && noTeam.reason.includes('团队版'), 'G-6 社区/Pro 永不默认开');
  const noNet = decideAutoDispatchPolicy({ raw: '', teamUnlocked: true, enrolled: false });
  ok(!noNet.enabled && noNet.reason.includes('入网'), 'G-7 未入网不默认开');

  const baseFacts: CreateDispatchFacts = {
    settingOn: true, teamUnlocked: true, enrolled: true,
    hasParent: false, hasDependencies: false, hasAttachments: false,
    hasWorkingDir: false, decomposed: false, category: 'code' as NodeCardCategory,
  };
  eq(decideCreateDispatch(baseFacts), { eligible: true, reason: 'eligible', category: 'code' }, 'G-8 其余事实齐备 ⇒ 可派');
  eq(decideCreateDispatch({ ...baseFacts, settingOn: false }).reason, 'setting-off', 'G-9 开关关 ⇒ setting-off');
  eq(decideCreateDispatch({ ...baseFacts, teamUnlocked: false }).reason, 'team-locked', 'G-10 档位锁 ⇒ team-locked');
  eq(decideCreateDispatch({ ...baseFacts, enrolled: false }).reason, 'not-enrolled', 'G-11 未入网 ⇒ not-enrolled');
  eq(decideCreateDispatch({ ...baseFacts, hasParent: true }).reason, 'has-parent', 'G-12 子任务留本机');
  eq(decideCreateDispatch({ ...baseFacts, hasDependencies: true }).reason, 'has-dependencies', 'G-13 有依赖（旧调用方）⇒ 拒');
  eq(decideCreateDispatch({ ...baseFacts, hasDependencies: true, depState: 'waiting' }).reason, 'dependencies-waiting', 'G-14 依赖未完成 ⇒ 等');
  eq(decideCreateDispatch({ ...baseFacts, hasDependencies: true, depState: 'dead' }).reason, 'dependencies-dead', 'G-15 依赖已死 ⇒ 不派');
  eq(decideCreateDispatch({ ...baseFacts, hasDependencies: true, depState: 'met' }).reason, 'eligible', 'G-16 依赖已满足 ⇒ 可派');
  eq(decideCreateDispatch({ ...baseFacts, hasAttachments: true }).reason, 'has-attachments', 'G-17 带附件留本机');
  eq(decideCreateDispatch({ ...baseFacts, hasWorkingDir: true }).reason, 'has-working-dir', 'G-18 有本机工作目录留本机');
  eq(decideCreateDispatch({ ...baseFacts, decomposed: true }).reason, 'decomposed', 'G-19 已拆解 ⇒ 工作单元是子任务');
  eq(decideCreateDispatch({ ...baseFacts, category: null }).reason, 'no-category', 'G-20 形态不明留本机');

  eq(decideCreateDispatch({ ...baseFacts, autoDispatchSource: 'default', localHasFreeSlot: true }).reason, 'local-capacity', 'G-21 缺省开 + 本机有余力 ⇒ 不外派');
  eq(decideCreateDispatch({ ...baseFacts, autoDispatchSource: 'default', localHasFreeSlot: false }).reason, 'eligible', 'G-22 缺省开 + 满负荷 ⇒ 才溢出');
  eq(decideCreateDispatch({ ...baseFacts, autoDispatchSource: 'explicit', localHasFreeSlot: true }).reason, 'eligible', 'G-23 显式开不受余力闸（用户自己的选择）');
  eq(decideCreateDispatch({ ...baseFacts, localHasFreeSlot: true }).reason, 'eligible', 'G-24 未给来由（旧调用方）行为不变');
  ok(CREATE_DISPATCH_REASON_LABEL['local-capacity'].includes('余力'), 'G-25 local-capacity 人话写明余力');
  const allReasons = ['eligible', 'setting-off', 'team-locked', 'not-enrolled', 'has-parent', 'has-dependencies', 'dependencies-waiting', 'dependencies-dead', 'has-attachments', 'has-working-dir', 'decomposed', 'local-capacity', 'no-category'] as const;
  ok(allReasons.every((r) => typeof CREATE_DISPATCH_REASON_LABEL[r] === 'string' && CREATE_DISPATCH_REASON_LABEL[r].length > 0), 'G-26 每个理由都有上屏人话');

  {
    const pj = readCode(`${MAIN}/ipc/project.ipc.ts`);
    ok(pj.includes('autoDispatchPolicy(db as unknown as NodeSettingDb & LicenseSettingDb)'), 'G-27 建单取三态策略一次');
    ok(pj.includes('autoDispatchSource: autoPolicy.source'), 'G-28 来由随准入事实传入');
    ok(pj.includes('localHasFreeSlot: localHasFreeSlot(db)'), 'G-29 余力取与心跳/Peers 同一真源');
    const i1 = pj.indexOf('const dispatchOutcome = await dispatchCreatedTask(');
    const i2 = pj.indexOf('task.dispatch = dispatchOutcome;');
    ok(i1 > 0 && i2 > i1, 'G-30 派单结局如实附在回执（失败不阻断建单）');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n【H】产界面与构建');

  const distAssets = path.join(ROOT, 'apps/worker-ant-desktop/renderer/dist/assets');
  function findChunk(prefix: string): string | null {
    try {
      const f = fs.readdirSync(distAssets).find((n) => n.startsWith(prefix) && n.endsWith('.js'));
      return f ? fs.readFileSync(path.join(distAssets, f), 'utf-8') : null;
    } catch { return null; }
  }
  const devicesChunk = findChunk('DevicesPage-');
  ok(devicesChunk !== null, 'H-1 DevicesPage 独立 chunk 在位');
  for (const s of ['品类：', '未分配房间', '模型辅助解析', '来源：']) {
    ok(devicesChunk?.includes(s) ?? false, `H-2 设备页产物含「${s}」`);
  }
  const pluginsChunk = findChunk('PluginsPage-');
  ok(pluginsChunk !== null, 'H-3 PluginsPage 独立 chunk 在位');
  ok(pluginsChunk?.includes('浏览、搜索、详情不限档位') ?? false, 'H-4 插件页产物写明浏览不限档位');
  ok(findChunk('SettingsPage-') !== null, 'H-5 SettingsPage 独立 chunk 在位（档位对照在此页）');
  ok(findChunk('PeersPage-') !== null, 'H-6 PeersPage 独立 chunk 在位（常驻发现状态在此页）');

  const rendererSrc = readText('apps/worker-ant-desktop/renderer/src/pages/DevicesPage.tsx');
  ok(rendererSrc.includes('deviceKindClassOf') && rendererSrc.includes('kindClassLabel') && rendererSrc.includes('kindClassSource'),
    'H-7 设备页取 main 侧品类真源（渲染层不另抄词表）');
  const pluginsSrc = readText('apps/worker-ant-desktop/renderer/src/pages/PluginsPage.tsx');
  ok(pluginsSrc.includes("license.proFeature('plugin_install')"), 'H-8 插件页先取 Pro 裁定再禁用');
  ok(readCode(`${MAIN}/ipc/license.ipc.ts`).includes("ipcMain.handle('license:pro_feature'"), 'H-9 main 侧有只读裁定出口');
  ok(readText('apps/worker-ant-desktop/renderer/src/lib/ipc.ts').includes("'license:pro_feature'"), 'H-10 渲染层调同一通道');

  const devIpc = readCode(`${MAIN}/ipc/devices.ipc.ts`);
  eq((devIpc.match(/proFeatureRefusal\(licDb, 'device_discovery'\)/g) ?? []).length, 2, 'H-11 发现闸读点逐处穷举（2 处）');
  eq((devIpc.match(/teamFeatureRefusal\(licDb, 'device_control'\)/g) ?? []).length, 4, 'H-12 控制闸读点逐处穷举（4 处）');
  ok(devIpc.includes('discoveryGate: resolveProGate(licDb)'), 'H-13 列表回包同时带 Pro 发现闸与 Team 控制闸');

  // ── S 构建钉与自检 ────────────────────────────────────────────────────────
  console.log('\n【S】构建钉与「只为下一轮」字面量自检');
  ok(ROUND_RE.test(SELF_ROUND), 'S-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);
  const selfLines = stripKeepingLines(fs.readFileSync(__filename, 'utf-8'));
  const dud = selfLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'zx_\d{8}(?:_\d+)?'/.test(line));
  ok(dud.length === 0, 'S-2 本套件无「只为下一轮」字面量', dud.map((x) => `${x.i + 1}:${x.line.trim()}`).join(' | '));
  checkBuildPins(ok, { distDir: path.join(ROOT, 'apps/worker-ant-desktop/dist') });

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

main().then(() => {
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error('rr_zx_20261029_2 未捕获异常（复跑未跑完，不得读作通过）：', e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
