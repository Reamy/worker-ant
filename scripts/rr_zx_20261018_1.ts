/**
 * zx_20261018_1 受控复跑 —— 「达」：**意达于物**（批一「通」/ 批二「意」/ 批三「名」）。
 *
 * 批三「名」口径（维特根斯坦·意义即用法 / 庄子·不预设）：
 *   房间是**人指派的**显式数据——空串＝未分配（不猜"未知房间"）；发现自述的提示（HA `suggested_area`）
 *   **只在空串时**填入，绝不覆盖人设的值；房间匹配＝归一空白后**精确相等**（大小写不敏感），不做子串。
 *
 * 批一口径一句话（王阳明·知行合一 ／ 维特根斯坦·意义即用法 ／ 罗尔斯·无知之幕 ／ 毛选·没有调查没有发言权）：
 *   ① 门内授予的**词**要能落成**物**——IM 一句话批进来的终端，拿到的是"意图控制"（本机解析），
 *      而不是"原始动作"（它自己决定按哪台设备）；
 *   ② 派出去的任务要**原样抵达**——标题/描述/验收标准各归其位，远端判卷读的正是验收那一栏；
 *   ③ 说过的话要**到期作数**——授权不是终身制，到期即 `grant_expired`；
 *   ④ 零能力就是零门内之物——只配对、不授予，则 `/api/v1/*` 一概 403（不写计划、不写设备动作）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据静态导入生产导出（被删/改名即编译期失败）；能跑真实现的一律跑真实现。
 *   G-2 **两侧标本**：凡"该拒"的判据必有"该放"的正标本（R-4 到期/未到期、R-5 勾/不勾）。
 *   G-5 判"接线在册"读 `CODE()`（去注释）后的代码；注释**不能**替实现签字。
 *   G-6 **无轮次字面量**：本文件不写任何轮次值；S2/S3 由 `path.basename(__filename)` 派生。
 *   ⚠ 夹具用 `node:sqlite` 内存库，按**生产 DDL 同形**建表（`feedback_rr_fixture_production_order`）。
 *   ⚠ 计数器类断言须有 **0→1** 正面断言（R-1 的 `capabilities_json`、R-7 的 `acceptance_criteria`）。
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
// G-1：批一的四处真源——静态导入，改名/删除即编译期失败。
import {
  approveTerminal,
  createPairRequest,
  createPairingPort,
  pairStatus,
  verifyTerminal,
  __resetTerminalSecretsForTest,
  GRANT_TTL_DAYS_DEFAULT,
  type TerminalDb,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import {
  createExternalCapabilityPort,
  DEFAULT_TERMINAL_CAPABILITIES,
  EXTERNAL_CAPABILITIES,
  EXTERNAL_CAPABILITY_NOTE,
  INVOKE_CAPABILITIES,
  isInvocableCapability,
  type ExternalCapabilityDeps,
  type IntentResolveInput,
  type IntentResolveOutcome,
} from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import {
  handleInboundRequest,
  INBOUND_CAPABILITIES_PATH,
  INBOUND_INTENT_EXECUTE_PATH,
  INBOUND_INTENT_RESOLVE_PATH,
  INBOUND_INVOKE_PATH,
  INBOUND_WELL_KNOWN_PATH,
  type InboundDeps,
} from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
// zx_20261018_1 批二：意图协议（词表/校验）与计划账（resolve 与 execute 之间的那本账）。
import {
  COMFORT_FEELINGS,
  HOME_COMFORT_INTENT,
  INTENT_CAPABILITY,
  intentNames,
  publicIntents,
  validateIntent,
  type ComfortFeeling,
} from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
import {
  createIntentPlan,
  dbNowUtc,
  getIntentPlan,
  INTENT_PLAN_TTL_SEC,
  type IntentPlanDb,
  type IntentStep,
  type IntentSkip,
} from '../apps/worker-ant-desktop/src/main/core/intent-plans.js';
import {
  applyAutoDispatchOnboarding,
  AUTO_DISPATCH_PROMPTED_KEY,
  AUTO_DISPATCH_SETTING_KEY,
  buildDispatchPayload,
  isAutoDispatchOn,
  isAutoDispatchPrompted,
  shouldPromptAutoDispatch,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { relayTaskTitle, relayTaskFields } from '../apps/worker-ant-desktop/src/main/core/node-request-runner.js';
import { TaskManager } from '../apps/worker-ant-desktop/src/main/core/project-engine.js';
import {
  encodeLicense,
  LICENSE_SETTING_KEYS,
  type LicensePayload,
  type LicenseSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/license.js';
import { TIER_LABEL } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { TEAM_FEATURES, TEAM_FEATURE_LABEL, resolveTeamGate, teamFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
// zx_20261018_1 批八「档」：Pro 闸 / 导出编排 / 价目表（卖点须有闸兑现，一处真源各跑真实现）。
import { PRO_FEATURES, PRO_FEATURE_LABEL, resolveProGate, proFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { KNOWLEDGE_EXPORT_DIR, exportKnowledgeForProject } from '../apps/worker-ant-desktop/src/main/core/knowledge-export.js';
import { PRICING } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
// zx_20261018_1 批九「收」：执行策略/上下文预组装从执行体抽出成两个零依赖模块。
//   判据直引**新家**（编译期证明定义在那儿），再用静态反证旧名不悬空。
import {
  EMPTY_LOOP_RUN,
  USD_TO_CNY_RATE,
  advanceLoopRun,
  budgetBandOf,
  cnyFactor,
  toolCallFingerprint,
} from '../apps/worker-ant-desktop/src/main/core/exec-strategy.js';
import {
  buildUserDirectiveBlock,
  formatInsufficiencyReasons,
  mergePlanModeContext,
} from '../apps/worker-ant-desktop/src/main/core/exec-prelude.js';
// zx_20261018_1 批五：home.comfort 规则表/工具/执行器与工具面（判据一律跑生产实现）。
import {
  COMFORT_RULES,
  createHomeIntentResolver,
  homeComfortRoleOf,
  planHomeComfort,
} from '../apps/worker-ant-desktop/src/main/core/home-intent.js';
import { TOOL_METAS, toolRegistry } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { ARCHETYPE_TOOL_CATEGORIES, narrowToolFace } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import type { ToolDeps } from '../apps/worker-ant-desktop/src/main/core/tools/deps.js';
// zx_20261018_1 批三：房间语义（人指派/发现只填空/精确匹配）与 HA 自述提示。
import {
  devicesInRoom,
  getDevice,
  listDeviceActions,
  listDevices,
  listRooms,
  normalizeRoomName,
  setDeviceAuthorized,
  setDeviceRoom,
  upsertDiscovered,
  type AnsDevice,
  type DeviceControlOutcome,
  type DeviceDb,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { haConfigToDevice, haStateTopics } from '../apps/worker-ant-desktop/src/main/core/device-homeassistant.js';
// zx_20261018_1 批四：上行实时状态（订阅/落库）与 HA 细粒度命令（主题选路一处真源）。
import {
  createLiveSubscriptionManager,
  deviceCommandPayload,
  deviceStateTopics,
  haCommandTarget,
  mqttCommandTopic,
  mqttDeviceControl,
  type MqttIo,
  type MqttPublishResult,
  type MqttSubscribeIo,
} from '../apps/worker-ant-desktop/src/main/core/device-mqtt.js';
import {
  applyAvailability,
  deviceLiveStateOf,
  setDeviceLiveAttributes,
  setDeviceLiveState,
  setDeviceStatus,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  cloudDeviceState,
  registerDeviceProvider,
  unregisterDeviceProvider,
  type DeviceProvider,
} from '../apps/worker-ant-desktop/src/main/core/device-provider.js';
import {
  deviceStatusPayload,
  deviceTools,
  executeDeviceIntentPlan,
  type DeviceControlTransport,
} from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
// zx_20261018_1 批六：长音频分段转写（短路径逐字不变；超单段上限自动走长路径）。
import {
  AUDIO_IO,
  LONG_SEGMENT_SECONDS,
  MAX_AUDIO_SECONDS,
  WAV_BYTES_PER_SEC,
  makeAudioTranscriber,
  transcribeLongAudio,
  type AudioTranscribeIo,
  type FfmpegRun,
} from '../apps/worker-ant-desktop/src/main/core/audio-transcribe.js';
// zx_20261018_2 批二：时长探针搬到 `media-probe.ts`（音频与视频共用一处实现）——判据随真源重定向。
import { probeMediaDurationSec } from '../apps/worker-ant-desktop/src/main/core/media-probe.js';
// zx_20261018_1 批七「账」：七源分账 / 最小裁剪 / 唯一写口 / 注入账回流（判据跑生产实现）。
import {
  TOKEN_SOURCES,
  emptyTokenChars,
  ledgerFromChars,
  withSourceChars,
} from '../apps/worker-ant-desktop/src/main/core/token-ledger.js';
import {
  CONTEXT_NEVER_TRIM,
  CONTEXT_TRIM_ORDER,
  applyContextBudget,
} from '../apps/worker-ant-desktop/src/main/core/context-budget.js';
import {
  reconcileExecutionTokens,
  writeExecutionMetrics,
} from '../apps/worker-ant-desktop/src/main/core/exec-metrics.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { KNOWLEDGE_INJECT_MAX_TOKENS, knowledgeInjectionStats, previewProjectKnowledge } from '../apps/worker-ant-desktop/src/main/core/project-knowledge.js';
import { estimateTokensFromChars, TOKEN_CHARS_PER_UNIT } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';
import type { AnsNodeRequest } from '@worker-ant/shared-types';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const countOcc = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** 本轮标识由**载体自身**派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/** 轮次序号（`zx_YYYYMMDD[_n]` → 可比较数值）；后续轮次推进 build 不应弄红本套件。 */
const roundOrd = (tag: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(tag);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};

/** 终端表 DDL——与生产同形（P-0b 逐列钉住生产 DDL，改列即红 ⇒ 逼夹具同步）。 */
const TERMINAL_DDL = `CREATE TABLE wa_external_terminals (
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
    grant_expires_at TEXT
  )`;

/** 门内夹具库：设置 + 外部调用账 + 终端表 + 意图计划账 + 设备动作账（均按生产同形建成）。 */
function makeDoorDb(trial = true): DatabaseSync {
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
  d.exec(TERMINAL_DDL);
  // zx_20261018_1 批二：意图计划账（列形状照生产 DDL）。
  d.exec(`CREATE TABLE wa_intent_plans (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    plan_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    executed_at TEXT,
    result_json TEXT NOT NULL DEFAULT '{}'
  )`);
  d.exec(`CREATE INDEX idx_wa_intent_plans_status ON wa_intent_plans(status, expires_at)`);
  d.exec(`CREATE INDEX idx_wa_intent_plans_terminal ON wa_intent_plans(terminal_id, created_at DESC)`);
  // 设备动作账（R-17 以"行数＝执行步数"判真执行；列形状照生产 DDL）。
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
  if (trial) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}

/** R-7 的本地中转任务夹具：项目/任务两表（列形状照生产 `wa_tasks`）。 */
function makeTaskDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', working_dir TEXT DEFAULT '')`);
  d.exec(`CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
    title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
    context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
    priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '',
    parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
    acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);
  d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('p1', '中转项目');
  return d;
}

/**
 * 批七夹具：**token 分账 + 注入账**——`wa_context_injections` 逐列照生产 DDL（`database.ts`），
 * `wa_memories`/`wa_tasks`/`wa_task_conversations`/`wa_settings` 取 `MemoryManager` 真实现所需的最小同形列。
 * ⚠ 先 `new MemoryManager`（建 FTS 触发器）再插数据行——生产初始化顺序（`feedback_rr_fixture_production_order`）。
 */
function makeLedgerDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '')`);
  d.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '')`);
  d.exec(`CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '',
    title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 0, context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '',
    source TEXT DEFAULT 'test', acceptance_criteria TEXT DEFAULT '', quality_score REAL,
    aggregate_version INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  )`);
  d.exec(`CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
    content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_memories (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
    embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
    reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
    valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
    exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
    similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT ''
  )`);
  // 逐列照 `database.ts`（CREATE TABLE 段，非 migrations 段）。

  d.exec(`CREATE TABLE wa_context_injections (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    source TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    chars INTEGER NOT NULL DEFAULT 0,
    est_tokens INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  d.exec(`CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id)`);
  d.exec(`CREATE INDEX idx_wa_context_injections_ref ON wa_context_injections(source, ref_id, outcome)`);
  return d;
}

/**
 * 批八夹具：**许可设置 + 知识册**（两表逐列照生产 DDL）。
 * `trialStartedAt` 传了即落一行试用起算点（模拟"试用中/试用过期"两只标本）。
 */
function makeExportDb(opts: { trialStartedAt?: string } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_project_knowledge (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    section TEXT NOT NULL,
    content TEXT NOT NULL,
    source_ref TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // zx_20261022_3 批七: 读册 = 派生 ∪ 导入（生产同一句），夹具须同建。
  d.exec(`CREATE TABLE wa_project_knowledge_imports (
    project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
    precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
    imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section)
  )`);
  d.exec(`CREATE TABLE wa_knowledge_imports (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
    source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge',
    sections INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT DEFAULT (datetime('now'))
  )`);
  // zx_20261022_3 批八：导出包头会带**本项目画像**（随包走）⇒ 夹具须同建；缺表即 no such table。
  d.exec(`CREATE TABLE wa_project_profiles (
    project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
    source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
    generated_at TEXT DEFAULT (datetime('now')), enabled INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT ''
  )`);
  d.prepare(`INSERT INTO wa_project_knowledge (id, project_id, section, content, source_ref) VALUES (?,?,?,?,?)`)
    .run('kp1', 'p1', 'entities', '客厅 → 台灯', 'wa_knowledge_triples');
  if (opts.trialStartedAt) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, opts.trialStartedAt);
  }
  return d;
}

/**
 * 批三的台账夹具：`wa_devices` **照生产同形**（含 `room TEXT DEFAULT ''`）。
 * ⚠ 房间语义全靠这一列；夹具若少了它，`getDevice` 的 SELECT 会直接抛错（不是假绿）。
 */
function makeRoomDb(): DeviceDb {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_devices (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    alias TEXT DEFAULT '',
    room TEXT DEFAULT '',
    kind TEXT DEFAULT 'unknown',
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
  return d;
}

/** 批三的发现标本：只带自述字段（与真实发现器交上来的一致）。 */
const discovered = (over: Partial<Parameters<typeof upsertDiscovered>[1]> = {}) => ({
  name: '客厅灯', kind: 'light', protocol: 'mqtt' as const, address: 'b#light_1',
  capabilities: ['mqtt', 'ha:light'], controllable: true, ...over,
});

/**
 * 批四的 HA 设备标本：**走真发现映射** `haConfigToDevice`（不手写 capabilities）——
 * 若发现侧漏提某个主题，R-27..R-31 一并红（判据不自我印证）。
 */
function haDevice(component = 'light', over: Record<string, unknown> = {}): AnsDevice {
  const cfg = {
    uniq_id: `ha-full-${component}`,
    name: '全能力设备',
    cmd_t: 'base/cmd',
    stat_t: 'base/state',
    json_attr_t: 'base/attr',
    temp_cmd_t: 'base/temp',
    mode_cmd_t: 'base/mode',
    set_pos_t: 'base/pos',
    bri_cmd_t: 'base/bri',
    pl_on: '1',
    pl_off: '0',
    ...over,
  };
  const disc = haConfigToDevice(`homeassistant/${component}/full/config`, JSON.stringify(cfg), 'broker.local', 1883);
  if (!disc) throw new Error('HA 标本构造失败（发现映射未认出载荷）');
  return {
    id: `ha-${component}`, name: disc.name, alias: '', room: '', kind: disc.kind,
    protocol: 'mqtt', address: disc.address, port: disc.port ?? 1883,
    capabilities: disc.capabilities, controllable: disc.controllable === true,
    authorized: true, status: null, online: null, first_seen: '', last_seen: '',
  };
}

/** 批四的假订阅面：记录**实际**订阅条数、可投递消息、记收摊次数（不触网）。 */
function makeFakeSubscribeIo(): {
  io: MqttSubscribeIo;
  topics: () => string[];
  stopped: () => number;
  deliver: (topic: string, payload: string) => void;
} {
  const subs: Array<{ topic: string; cb: (t: string, p: string) => void }> = [];
  let stops = 0;
  return {
    io: {
      subscribe(topic, onMessage) { subs.push({ topic, cb: onMessage }); },
      stop() { stops += 1; },
    },
    topics: () => subs.map((s) => s.topic),
    stopped: () => stops,
    deliver(topic: string, payload: string) {
      for (const s of subs) if (s.topic === topic) s.cb(topic, payload);
    },
  };
}

/** 批四的假 MQTT 传输：记下发目标（topic/payload），按给的结果回执。 */
function makeFakeMqttIo(result: MqttPublishResult = { ok: true, ack: null }): {
  io: MqttIo;
  sent: Array<{ topic: string; payload: string }>;
} {
  const sent: Array<{ topic: string; payload: string }> = [];
  return {
    sent,
    io: {
      async publish(_dev, topic, payload) { sent.push({ topic, payload }); return result; },
    },
  };
}

/**
 * 设备传动探针：记录是否真被调用、传进来的身份是谁（G-1：跑真 capability 端口）。
 * 传 `db` 时**照生产装配层同形**写一行 `wa_device_actions`（R-17 的"账行数＝执行步数"）。
 */
function makeProbeDevice(db?: DatabaseSync): {
  calls: Array<{ deviceId?: string; name?: string; action: string; args?: Record<string, unknown>; terminalId?: string }>;
  deps: ExternalCapabilityDeps;
} {
  const calls: Array<{ deviceId?: string; name?: string; action: string; args?: Record<string, unknown>; terminalId?: string }> = [];
  const device: AnsDevice = {
    id: 'dev-1', name: '客厅台灯', alias: '', room: '', kind: 'light', protocol: 'mqtt',
    address: '192.168.1.50', port: 1883, capabilities: ['turn_on', 'turn_off'],
    controllable: true, authorized: true, status: { on: false }, first_seen: '', last_seen: '',
  };
  const next: DeviceControlOutcome = { ok: true, deviceId: 'dev-1', action: 'turn_on', result: 'turned on' };
  let seq = 0;
  return {
    calls,
    deps: {
      listDevices: () => [device],
      controlDevice: async (inner) => {
        calls.push(inner);
        if (db) {
          db.prepare(`INSERT INTO wa_device_actions (id, device_id, action, args_json, result, actor_kind, actor_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            `act-${++seq}`, 'dev-1', inner.action, JSON.stringify(inner.args ?? {}), 'ok', 'external', inner.terminalId ?? '',
          );
        }
        return next;
      },
    },
  };
}

/** 批五规则表的**标本**（此刻只为判 resolve/execute 的形状；规则真源在 `home-intent.ts`，批五落）。 */
const SPECIMEN_STEPS: IntentStep[] = [
  { call_name: '客厅窗帘', action: 'close', reason: 'hot' },
  { call_name: '客厅空调', action: 'set_temperature', args: { temperature: 26 }, reason: 'hot' },
];

/** 意图门夹具：真配对 + 真能力端口 + 可注入规划器/房间/时刻。 */
interface IntentEnv {
  db: DatabaseSync;
  cred: { key: string; secret: string };
  calls: ReturnType<typeof makeProbeDevice>['calls'];
  deps: InboundDeps;
  nowRef: { at: Date };
  plans: () => number;
  actions: () => number;
}

function makeIntentEnv(opts: {
  caps?: string[];
  planner?: ((input: IntentResolveInput) => IntentResolveOutcome) | null;
  rooms?: string[];
} = {}): IntentEnv {
  const db = makeDoorDb();
  __resetTerminalSecretsForTest();
  const cred = pairAndApprove(db, opts.caps ?? [INTENT_CAPABILITY]);
  const tdb = db as unknown as TerminalDb;
  const nowRef = { at: new Date('2026-10-18T00:00:00Z') };
  const probe = makeProbeDevice(db);
  const planner = opts.planner === undefined
    ? (): IntentResolveOutcome => ({ ok: true, steps: SPECIMEN_STEPS.map((s) => ({ ...s })), skipped: [] })
    : opts.planner;
  const deps: InboundDeps = {
    nodeName: () => '阳台的工蚁',
    agentVersion: '0.1.0',
    pairing: createPairingPort(tdb),
    capability: createExternalCapabilityPort(db as never, {
      ...probe.deps,
      listRooms: () => opts.rooms ?? ['客厅'],
      ...(planner ? { resolveIntentSteps: planner } : {}),
      now: () => nowRef.at,
    }),
  };
  return {
    db, cred, calls: probe.calls, deps, nowRef,
    plans: () => Number((db.prepare('SELECT COUNT(*) AS n FROM wa_intent_plans').get() as { n: number }).n),
    actions: () => Number((db.prepare('SELECT COUNT(*) AS n FROM wa_device_actions').get() as { n: number }).n),
  };
}

const intentBody = (over: Record<string, unknown> = {}) => ({
  intent: HOME_COMFORT_INTENT,
  params: { room: '客厅', feeling: 'hot' },
  ...over,
});

/** 走真配对：建申请 → 按给的能力批准 → 取回凭据（明文只从门端点回一次）。 */
function pairAndApprove(
  d: DatabaseSync,
  caps: string[],
  opts: { ttlDays?: number; now?: Date } = {},
): { pairingId: string; key: string; secret: string } {
  const tdb = d as unknown as TerminalDb;
  const { pairingId, pairCode } = createPairRequest(tdb, '隔壁的终端');
  const r = approveTerminal(tdb, pairingId, caps, opts);
  if (!r.ok) throw new Error(`批准失败：${r.reason}`);
  const st = pairStatus(tdb, pairingId, pairCode);
  if (st.status !== 'approved' || !st.credentials) throw new Error('凭据未取回');
  return { pairingId, key: st.credentials.key, secret: st.credentials.secret };
}

const bearer = (cred: { key: string; secret: string }) => ({ authorization: `Bearer ${cred.key}.${cred.secret}` });

/* ── 批五夹具（home.comfort 规划与执行）──────────────────────────────────────
 * 在批三的台账（`wa_devices`）上补三张表：设置（Team 闸读面）/ 意图计划账 / 设备动作账。
 * 列形状一律照生产 DDL；动作账含 `plan_id`（本批新增列）。
 */
function makeComfortDb(opts: { trial?: boolean } = {}): DatabaseSync {
  const d = makeRoomDb() as unknown as DatabaseSync;
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_intent_plans (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    plan_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'planned',
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
  if (opts.trial !== false) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}

/** 落一台设备（走真 `upsertDiscovered`，地址按「房间#名字」稳定派生）；缺省已授权。 */
function seedComfortDevice(
  d: DatabaseSync,
  s: { name: string; kind: string; room?: string; authorized?: boolean; controllable?: boolean },
): AnsDevice {
  const room = s.room ?? '客厅';
  const dev = upsertDiscovered(d as unknown as DeviceDb, discovered({
    name: s.name, kind: s.kind, roomHint: room,
    address: `b#${room}#${s.name}`,
    controllable: s.controllable ?? true,
  }));
  if (s.authorized !== false) setDeviceAuthorized(d as unknown as DeviceDb, dev.id, true);
  return getDevice(d as unknown as DeviceDb, dev.id)!;
}

/** 假传动：记收到的动作，按给的回执作答（不触网）。 */
function makeComfortTransport(
  decide: (dev: AnsDevice, action: string) => { ok: boolean; result: string } = () => ({ ok: true, result: 'done' }),
): { calls: Array<{ device: string; action: string }>; transport: DeviceControlTransport } {
  const calls: Array<{ device: string; action: string }> = [];
  const transport: DeviceControlTransport = async (dev, action) => {
    calls.push({ device: dev.name, action });
    return decide(dev, action);
  };
  return { calls, transport };
}

/** 一张表的行数（0 起点/0→1 正面断言用）。 */
function countRows(d: DatabaseSync, table: string): number {
  return Number((d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

/* ── 批六夹具（长音频分段转写）──────────────────────────────────────────────
 * 假 io 只冒充「ffmpeg 这个可执行」：`run` 按 argv 认三类调用——时长探针（`-i <源>`，无输出）、
 * 切段（含 `-segment_time`，真写段文件）、归一化（其余，写最后一位参数）。`mkdirp`/`remove` 仍
 * 是真文件系统 ⇒ ``用后即删``能被数出来（R-53）。
 */
function ffmpegDurationLine(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `  Duration: ${p(h)}:${p(m)}:${p(s)}.00, start: 0.000000, bitrate: 128 kb/s`;
}

function makeFakeAudioIo(opts: {
  durationSec: number | null;
  /** 归一化产物的"体积"（决定 truncated 与否；不给＝1 字节） */
  normalizedSize?: number;
}): { io: AudioTranscribeIo; runs: string[][]; created: string[] } {
  const runs: string[][] = [];
  const created: string[] = [];
  const io: AudioTranscribeIo = {
    ...AUDIO_IO,
    probe: () => true,
    async run(_bin: string, args: string[]): Promise<FfmpegRun> {
      runs.push([...args]);
      const isProbe = args.length === 3 && args[1] === '-i';
      if (isProbe) {
        return opts.durationSec === null
          ? { code: 1, timedOut: false, stderr: 'stub: no Duration line' }
          : { code: 1, timedOut: false, stderr: ffmpegDurationLine(opts.durationSec) };
      }
      if (args.includes('-segment_time')) {
        const pattern = args[args.length - 1]!;
        const count = Math.max(1, Math.ceil((opts.durationSec ?? 0) / LONG_SEGMENT_SECONDS));
        for (let i = 0; i < count; i++) {
          const p = pattern.replace('%03d', String(i).padStart(3, '0'));
          fs.writeFileSync(p, `SEG-${i}-BYTES`);
          created.push(p);
        }
        return { code: 0, timedOut: false, stderr: '' };
      }
      fs.writeFileSync(args[args.length - 1]!, 'NORMALIZED-WAV-BYTES');
      return { code: 0, timedOut: false, stderr: '' };
    },
    async mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); },
    async size() { return opts.normalizedSize ?? 1; },
    async remove(p) { fs.rmSync(p, { force: true }); },
  };
  return { io, runs, created };
}

/** 逐段转写替身：第 n 次 chat 按 `plan(n)` 作答（`n` 从 1 起）。 */
function longAudioDeps(plan: (n: number) => { ok: true; text: string } | { ok: false; detail: string }) {
  let calls = 0;
  const deps = {
    selectModel: async () => ({ url: 'https://example.test', api_key: 'k', model_name: 'm1' }),
    readFile: async (p: string) => fs.readFileSync(p),
    chat: async () => { calls += 1; return plan(calls); },
  };
  return { deps, chatCalls: () => calls };
}

/** 本地 HTTP 桩：给 `makeAudioTranscriber` 的真 `postChatCompletion` 一条可达端点。 */
async function audioHttpStub(text: string): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function main(): Promise<void> {
  // ═══ R-1｜IM 审批的默认授予词表（罗尔斯·无知之幕：看不见勾选框的人，拿到的是"最小的那把钥匙"）══
  console.log('\n【R-1】IM 审批默认只授予「意图控制」');
  {
    eq([...DEFAULT_TERMINAL_CAPABILITIES], ['intent_control'],
      'R-1a 默认授予词表**恰一项**：`intent_control`');
    ok(DEFAULT_TERMINAL_CAPABILITIES.includes('device_control') === false,
      'R-1b ★反证：默认**不含**原始动作 `device_control`');
    // 0→1 正面断言：批准前 `[]`，批准后恰 `["intent_control"]`。
    const d = makeDoorDb();
    const tdb = d as unknown as TerminalDb;
    __resetTerminalSecretsForTest();
    const { pairingId } = createPairRequest(tdb, 'IM 里批进来的终端');
    const before = d.prepare('SELECT capabilities_json FROM wa_external_terminals WHERE id = ?').get(pairingId) as { capabilities_json?: string };
    eq(before.capabilities_json, '[]', 'R-1c 批准前 `capabilities_json` 为空（0）');
    const r = approveTerminal(tdb, pairingId, [...DEFAULT_TERMINAL_CAPABILITIES]);
    ok(r.ok === true, 'R-1d 批准动作成功');
    const after = d.prepare('SELECT capabilities_json FROM wa_external_terminals WHERE id = ?').get(pairingId) as { capabilities_json?: string };
    eq(after.capabilities_json, '["intent_control"]', 'R-1e ★0→1：批准后恰 `["intent_control"]`');
    d.close();
  }
  {
    // 接线：IM 审批那一跳传的就是这份默认（不是另抄一份 `['device_control']`）。
    const src = CODE(`${A}/src/main/services/im-router.ts`);
    ok(/approveTerminal\(\s*ctx\.db\s*,\s*p\.id\s*,\s*\[\.\.\.DEFAULT_TERMINAL_CAPABILITIES\]\s*\)/.test(src),
      'R-1f ★★IM 审批那一跳传 `DEFAULT_TERMINAL_CAPABILITIES`（读去注释后的代码）');
    ok(src.includes('DEFAULT_TERMINAL_CAPABILITIES'),
      'R-1g `im-router.ts` 静态导入默认词表（未手抄字面量）');
  }
  {
    // 人话名/说明两侧齐备（GUI 卡片直接上屏）。
    eq(EXTERNAL_CAPABILITIES, ['device_control', 'intent_control'],
      'R-1h 授予词表**恰两项**（原始动作 + 意图）');
    eq(INVOKE_CAPABILITIES, ['device_control'],
      'R-1i `/invoke` 可直调面**恰一项**（意图控制不入直调面）');
    ok(isInvocableCapability('intent_control') === false,
      'R-1j ★意图控制**不可**经 `/invoke` 直调');
    for (const c of EXTERNAL_CAPABILITIES) {
      ok(typeof EXTERNAL_CAPABILITY_NOTE[c] === 'string' && EXTERNAL_CAPABILITY_NOTE[c].length > 0,
        `R-1k 风险说明非空：${c}`);
    }
  }

  // ═══ R-2｜意图终端的自省面：看得见"我被给了什么"，看不见"我没被给的" ══════════════
  console.log('\n【R-2】意图终端的 `GET /capabilities`');
  {
    const d = makeDoorDb();
    __resetTerminalSecretsForTest();
    const cred = pairAndApprove(d, ['intent_control']);
    const tdb = d as unknown as TerminalDb;
    const probe = makeProbeDevice();
    const deps = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: createPairingPort(tdb), capability: createExternalCapabilityPort(d as never, probe.deps) };
    const res = await handleInboundRequest({ method: 'GET', path: INBOUND_CAPABILITIES_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44' }, deps);
    eq(res.status, 200, 'R-2a 意图终端 `GET /capabilities` ⇒ 200');
    const body = res.body as { capabilities?: string[] };
    ok(Array.isArray(body.capabilities) && body.capabilities.length > 0,
      'R-2b ★能力面**非空**（它看得见自己被授予的意图控制）', JSON.stringify(body.capabilities));
    ok(body.capabilities?.includes('intent_control') === true, 'R-2c 含 `intent_control`');
    ok(body.capabilities?.includes('device_control') === false,
      'R-2d ★反证：**不含**未授予的 `device_control`');
    d.close();
  }

  // ═══ R-3｜意图终端不能借 `/invoke` 直发原始动作（意达于物，不越界）════════════════
  console.log('\n【R-3】意图终端 `POST /invoke` 原始动作 ⇒ 403 + 留痕');
  {
    const d = makeDoorDb();
    __resetTerminalSecretsForTest();
    const cred = pairAndApprove(d, ['intent_control']);
    const tdb = d as unknown as TerminalDb;
    const probe = makeProbeDevice();
    const deps = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: createPairingPort(tdb), capability: createExternalCapabilityPort(d as never, probe.deps) };
    const cnt = () => Number((d.prepare('SELECT COUNT(*) AS n FROM wa_external_calls').get() as { n: number }).n);
    eq(cnt(), 0, 'R-3a 基线：留痕账 0 行');
    const res = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } },
    }, deps);
    eq(res.status, 403, 'R-3b ★★意图终端直调 `device_control` ⇒ 403');
    eq((res.body as { error?: string }).error, 'capability_not_granted',
      'R-3c 回码＝`capability_not_granted`（未授予，不是白名单外）');
    eq(cnt(), 1, 'R-3d ★0→1：被拒也留痕（一行 `denied`）');
    const row = d.prepare('SELECT * FROM wa_external_calls ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown>;
    eq(row.result, 'denied', 'R-3e 留痕 `result=denied`');
    eq(row.reason, 'capability_not_granted', 'R-3f 留痕 `reason=capability_not_granted`');
    eq(probe.calls.length, 0, 'R-3g ★反证：传动**一次都没被调用**（请求在闸前就被挡下）');
    d.close();
  }

  // ═══ R-4｜授权到期：说过的话有期限（两只标本：过期拒 / 未过期放）══════════════════
  console.log('\n【R-4】授权有效期（90 天）与 `grant_expired`');
  {
    eq(GRANT_TTL_DAYS_DEFAULT, 90, 'R-4a 默认有效期＝90 天（一处真源）');
    const base = new Date('2026-10-18T00:00:00Z');
    const later = (days: number) => new Date(base.getTime() + days * 86_400_000);

    const d = makeDoorDb();
    __resetTerminalSecretsForTest();
    const cred = pairAndApprove(d, ['device_control'], { ttlDays: GRANT_TTL_DAYS_DEFAULT, now: base });
    const tdb = d as unknown as TerminalDb;
    const row = d.prepare('SELECT grant_expires_at FROM wa_external_terminals WHERE status = ?').get('approved') as { grant_expires_at?: string | null };
    ok(typeof row.grant_expires_at === 'string' && row.grant_expires_at.length > 0,
      'R-4b 批准即落 `grant_expires_at`（非长期）', String(row.grant_expires_at));

    // 标本①：到期后 ⇒ `grant_expired`。
    const expired = verifyTerminal(tdb, cred.key, cred.secret, '192.168.1.44', later(GRANT_TTL_DAYS_DEFAULT + 1));
    eq(expired.ok, false, 'R-4c ★标本①：90 天后校验**失败**');
    eq(!expired.ok ? expired.status : null, 403, 'R-4d 到期 ⇒ 403');
    eq(!expired.ok ? expired.reason : null, 'grant_expired', 'R-4e 回因＝`grant_expired`');

    // 到期终端走门端点 ⇒ `/invoke` 同样 403（认证闸先拦）。
    const pairingExpired = { ...createPairingPort(tdb), verify: (k: string, s: string, a?: string) => verifyTerminal(tdb, k, s, a, later(GRANT_TTL_DAYS_DEFAULT + 1)) };
    const probe = makeProbeDevice();
    const depsExpired = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: pairingExpired, capability: createExternalCapabilityPort(d as never, probe.deps) };
    const res = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } },
    }, depsExpired);
    eq(res.status, 403, 'R-4f ★门端点：到期后 `/invoke` ⇒ 403');
    eq((res.body as { error?: string }).error, 'grant_expired', 'R-4g 门端点回因＝`grant_expired`');
    eq(probe.calls.length, 0, 'R-4h 反证：到期终端**没有**碰到传动');

    // 标本②：未到期 ⇒ 照常放行。
    const valid = verifyTerminal(tdb, cred.key, cred.secret, '192.168.1.44', later(GRANT_TTL_DAYS_DEFAULT - 1));
    eq(valid.ok, true, 'R-4i ★标本②：第 89 天校验**通过**');
    d.close();
  }

  // ═══ R-5｜原始动作须桌面显式勾选（两只标本：勾了放 / 没勾拒）══════════════════════
  console.log('\n【R-5】`device_control` 须桌面显式勾选');
  {
    // 勾了：批准时 capabilities 显式含 `device_control` ⇒ 原始调用放行且真执行。
    const d1 = makeDoorDb();
    __resetTerminalSecretsForTest();
    const cred1 = pairAndApprove(d1, ['device_control']);
    const tdb1 = d1 as unknown as TerminalDb;
    const probe1 = makeProbeDevice();
    const deps1 = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: createPairingPort(tdb1), capability: createExternalCapabilityPort(d1 as never, probe1.deps) };
    const res1 = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred1), remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } },
    }, deps1);
    eq(res1.status, 200, 'R-5a ★标本①（勾了）：`/invoke` ⇒ 200');
    eq(probe1.calls.length, 1, 'R-5b 传动真被调用一次');
    eq(probe1.calls[0]?.terminalId, (d1.prepare('SELECT id FROM wa_external_terminals WHERE status = ?').get('approved') as { id: string }).id,
      'R-5c 传动收到发起者身份（`terminalId`）');
    d1.close();

    // 没勾：只有 `intent_control` ⇒ 原始调用被拒（同一请求体，只换授予集合）。
    const d2 = makeDoorDb();
    __resetTerminalSecretsForTest();
    const cred2 = pairAndApprove(d2, ['intent_control']);
    const tdb2 = d2 as unknown as TerminalDb;
    const probe2 = makeProbeDevice();
    const deps2 = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: createPairingPort(tdb2), capability: createExternalCapabilityPort(d2 as never, probe2.deps) };
    const res2 = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred2), remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } },
    }, deps2);
    eq(res2.status, 403, 'R-5d ★标本②（没勾）：同一请求 ⇒ 403');
    eq(probe2.calls.length, 0, 'R-5e 反证：传动一次都没被调用');
    d2.close();
  }
  {
    // 接线：IPC 只在**未传** capabilities 时取默认；显式（含 `[]`）原样落库。
    const src = CODE(`${A}/src/main/ipc/external.ipc.ts`);
    ok(/Array\.isArray\(capabilities\)\s*\?\s*capabilities\s*:\s*\[\.\.\.DEFAULT_TERMINAL_CAPABILITIES\]/.test(src),
      'R-5f ★审批 IPC：显式数组原样落库，未传才取默认（显式 `[]` 仍表示"只配对"）');
    ok(/defaultCapabilities\s*:\s*\[\.\.\.DEFAULT_TERMINAL_CAPABILITIES\]/.test(src),
      'R-5g `external:list` 回 `defaultCapabilities`（renderer 初值同源）');
    const page = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/defaultCapabilities/.test(page), 'R-5h ★对话框初值读 `defaultCapabilities`（前端与后端同一份）');
    ok(/GrantExpiry/.test(page) && /grant_expires_at/.test(page),
      'R-5i 终端卡片显示授权到期时刻（`GrantExpiry` / `grant_expires_at`）');
  }

  // ═══ R-6｜派单载荷：标题/描述/验收标准各归其位（维特根斯坦·意义即用法）════════════
  console.log('\n【R-6】结构化派单载荷 `buildDispatchPayload`');
  {
    const payload = buildDispatchPayload({ id: 't1', title: '实现登录模块', description: '写代码并跑通', acceptanceCriteria: '测试全绿' });
    eq(Object.keys(payload).sort(), ['acceptance_criteria', 'description', 'prompt', 'title'],
      'R-6a 载荷**恰四键**（prompt/title/description/acceptance_criteria）');
    eq(payload.title, '实现登录模块', 'R-6b `title` 原样（不拼接）');
    eq(payload.description, '写代码并跑通', 'R-6c `description` 原样（不拼接）');
    eq(payload.acceptance_criteria, '测试全绿', 'R-6d ★`acceptance_criteria` 原样（判卷读的就是它）');
    ok(payload.prompt.includes('实现登录模块') && payload.prompt.includes('测试全绿'),
      'R-6e `prompt` 仍为整句（旧对端兼容面不变）');
    // 接线：真派发那一跳用的就是它（zx_20261023_5 批一：改为带上游摘要的二元调用——钉更强形状，不放宽）。
    const src = CODE(`${A}/src/main/core/collab-dispatch.ts`);
    ok(/payload:\s*\{\s*\.\.\.buildDispatchPayload\(task,\s*upstream\)\s*\}/.test(src),
      'R-6f ★★真派发那一跳：`payload: { ...buildDispatchPayload(task, upstream) }`（读去注释后的代码）');
    ok(/const\s+upstream\s*=\s*collectUpstreamSummaries\(db,\s*task\.id\)/.test(src),
      'R-6f2 ★上游摘要由该任务真实的上游派生（取自同一函数体，不是占位空数组）');
  }

  // ═══ R-7｜远端任务落库带上验收标准（0→1，真跑 TaskManager.create）════════════════
  console.log('\n【R-7】远端 `wa_tasks.acceptance_criteria`');
  {
    const d = makeTaskDb();
    const req = {
      id: 'req-1', category: 'code',
      payload: {
        prompt: '实现登录模块\n写代码并跑通\n验收：测试全绿',
        title: '实现登录模块',
        description: '写代码并跑通',
        acceptance_criteria: '测试全绿',
      },
    } as unknown as AnsNodeRequest;
    const fields = relayTaskFields(req);
    eq(fields.acceptanceCriteria, '测试全绿', 'R-7a 字段读取：`acceptance_criteria` 原样取用');
    const live = () => Number((d.prepare("SELECT COUNT(*) AS n FROM wa_tasks WHERE acceptance_criteria != ''").get() as { n: number }).n);
    eq(live(), 0, 'R-7b 基线：带验收标准的任务 0 件');
    const created = new TaskManager(d as never).create({
      project_id: 'p1', title: relayTaskTitle(req), description: fields.description, acceptance_criteria: fields.acceptanceCriteria,
    }) as { id?: string } | undefined;
    eq(live(), 1, 'R-7c ★0→1：落库后带验收标准的任务 1 件');
    const row = d.prepare('SELECT acceptance_criteria FROM wa_tasks WHERE id = ?').get(String(created?.id ?? '')) as { acceptance_criteria?: string };
    eq(row.acceptance_criteria, '测试全绿', 'R-7d ★落库值＝派发值（非空且逐字相等）');
    d.close();
  }
  {
    // 接线：runner 真把 fields.acceptanceCriteria 传进 create（不是只在别处算一遍）。
    const src = CODE(`${A}/src/main/core/node-request-runner.ts`);
    ok(/const fields\s*=\s*relayTaskFields\(req\)/.test(src), 'R-7e runner 读结构化字段');
    ok(/acceptance_criteria:\s*fields\.acceptanceCriteria/.test(src),
      'R-7f ★★runner 把验收标准交给 `tasks.create`（读去注释后的代码）');
  }

  // ═══ R-8｜旧对端只发 `prompt` 也照常建单（不要求对方升级）════════════════════════
  console.log('\n【R-8】旧对端（仅 `prompt`）的回退路');
  {
    const req = { id: 'req-2', category: 'code', payload: { prompt: '写个周报' } } as unknown as AnsNodeRequest;
    eq(relayTaskTitle(req), '[AI 终端] 写个周报', 'R-8a 标题回退：取整句 `prompt`（原逻辑不变）');
    eq(relayTaskFields(req), { description: '写个周报', acceptanceCriteria: '' },
      'R-8b 描述回退 `prompt`；验收标准为空（不编造）');
    const d = makeTaskDb();
    const fields = relayTaskFields(req);
    const created = new TaskManager(d as never).create({
      project_id: 'p1', title: relayTaskTitle(req), description: fields.description, acceptance_criteria: fields.acceptanceCriteria,
    }) as { id?: string } | undefined;
    ok(!!created?.id, 'R-8c ★旧对端仍成功建单');
    const row = d.prepare('SELECT title, acceptance_criteria FROM wa_tasks WHERE id = ?').get(String(created?.id ?? '')) as { title?: string; acceptance_criteria?: string };
    eq(row.title, '[AI 终端] 写个周报', 'R-8d 落库标题同源');
    eq(row.acceptance_criteria, '', 'R-8e 未发验收标准 ⇒ 空串（如实，不编造）');
    d.close();
  }

  // ═══ R-9｜建单即派的一次性引导（Team 专属；三只标本）══════════════════════════════
  console.log('\n【R-9】Team 入网后的一次性引导');
  {
    const base = { teamUnlocked: true, enrolled: true, enabled: false, prompted: false };
    eq(shouldPromptAutoDispatch(base), true, 'R-9a ★标本①（Team + 已入网 + 未开 + 未问）⇒ 弹');
    eq(shouldPromptAutoDispatch({ ...base, teamUnlocked: false }), false, 'R-9b ★标本②（社区/Pro）⇒ **永不**弹');
    eq(shouldPromptAutoDispatch({ ...base, enabled: true }), false, 'R-9c 已开启 ⇒ 不打扰');
    eq(shouldPromptAutoDispatch({ ...base, prompted: true }), false, 'R-9d 问过 ⇒ 不再问');

    // 行为①：Team 里点"开启" ⇒ 开关真写 '1' + 记已问过（0→1 正面断言）。
    const team = makeDoorDb(true);
    eq(isAutoDispatchOn(team as never), false, 'R-9e 基线：开关关（0）');
    eq(isAutoDispatchPrompted(team as never), false, 'R-9f 基线：未问过（0）');
    const r1 = applyAutoDispatchOnboarding(team as never, true);
    eq(r1.ok, true, 'R-9g Team 点开启 ⇒ 成功');
    eq(isAutoDispatchOn(team as never), true, 'R-9h ★0→1：开关＝开');
    eq(isAutoDispatchPrompted(team as never), true, 'R-9i ★0→1：已问过');
    eq(team.prepare('SELECT value FROM wa_settings WHERE key = ?').get(AUTO_DISPATCH_SETTING_KEY), { value: '1' },
      'R-9j 落库值确为 `\'1\'`');
    eq(team.prepare('SELECT value FROM wa_settings WHERE key = ?').get(AUTO_DISPATCH_PROMPTED_KEY), { value: 'true' },
      'R-9k 引导标记确为 `\'true\'`');
    eq(shouldPromptAutoDispatch({
      teamUnlocked: true, enrolled: true,
      enabled: isAutoDispatchOn(team as never), prompted: isAutoDispatchPrompted(team as never),
    }), false, 'R-9l 点过之后不再弹');
    team.close();

    // 行为②：Team 里点"暂不开启" ⇒ 开关保持关 + 记已问过（拒绝也是一次回答）。
    const team2 = makeDoorDb(true);
    const r2 = applyAutoDispatchOnboarding(team2 as never, false);
    eq(r2.ok, true, 'R-9m Team 点暂不 ⇒ 成功');
    eq(isAutoDispatchOn(team2 as never), false, 'R-9n ★用户关掉就保持关');
    eq(isAutoDispatchPrompted(team2 as never), true, 'R-9o 但仍记已问过（不再打扰）');
    team2.close();

    // 行为③：社区档 ⇒ 如实拒（`team-locked`），一个字节都不写。
    const community = makeDoorDb(false);
    const r3 = applyAutoDispatchOnboarding(community as never, true);
    eq(r3.ok, false, 'R-9p ★社区档 ⇒ 拒');
    eq(r3.reason, 'team-locked', 'R-9q 拒因＝`team-locked`');
    eq(isAutoDispatchOn(community as never), false, 'R-9r 反证：开关仍关');
    eq(isAutoDispatchPrompted(community as never), false, 'R-9s 反证：引导标记未写（不假装问过）');
    community.close();
  }
  {
    // 接线：IPC 读写口与 renderer 引导卡在册。
    const ipc = CODE(`${A}/src/main/ipc/nodes.ipc.ts`);
    ok(/nodes:confirm-auto-dispatch/.test(ipc), 'R-9t IPC 写口 `nodes:confirm-auto-dispatch` 在册');
    ok(/applyAutoDispatchOnboarding/.test(ipc), 'R-9u 写口走一处真源 `applyAutoDispatchOnboarding`');
    ok(/prompted:\s*isAutoDispatchPrompted\(settingDb\)/.test(ipc), 'R-9v 读口回 `prompted`（GUI 据此决定弹不弹）');
    const page = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/confirmAutoDispatch/.test(page), 'R-9w renderer 引导卡调 `confirmAutoDispatch`');
    const lib = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(/confirmAutoDispatch/.test(lib) && /nodes:confirm-auto-dispatch/.test(lib),
      'R-9x IPC 客户端封装 `confirmAutoDispatch`（主/渲染同一通道名）');
  }

  // ═══ R-10｜零能力 = 零门内之物（反证：不写计划、不写设备动作）════════════════════
  console.log('\n【R-10】零能力终端的 `/api/v1/*` 一律 403');
  {
    const d = makeDoorDb();
    __resetTerminalSecretsForTest();
    const cred = pairAndApprove(d, []);
    const tdb = d as unknown as TerminalDb;
    const probe = makeProbeDevice();
    const deps = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: createPairingPort(tdb), capability: createExternalCapabilityPort(d as never, probe.deps) };

    const capRes = await handleInboundRequest({ method: 'GET', path: INBOUND_CAPABILITIES_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44' }, deps);
    eq(capRes.status, 403, 'R-10a ★零能力终端 `GET /capabilities` ⇒ 403');
    eq((capRes.body as { error?: string }).error, 'capability_not_granted', 'R-10b 回码＝`capability_not_granted`');

    const invRes = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } },
    }, deps);
    eq(invRes.status, 403, 'R-10c ★零能力终端 `/invoke` ⇒ 403');
    eq(probe.calls.length, 0, 'R-10d ★反证：设备动作**一次都没发生**');
    const calls = Number((d.prepare('SELECT COUNT(*) AS n FROM wa_external_calls').get() as { n: number }).n);
    eq(calls, 0, 'R-10e 反证：连能力调用账都无行（请求在能力端口之前就被挡下）');
    d.close();
  }
  {
    // 零能力闸在**能力端口之前**（读去注释后的代码，按处理体形状判）。
    const src = CODE(`${A}/src/main/core/inbound-gate.ts`);
    const iGate = src.indexOf('capabilities.length === 0');
    const iPort = src.indexOf('const cap = deps.capability');
    ok(iGate > 0 && iPort > iGate, 'R-10f ★零能力闸位于能力端口装配**之前**', `gate@${iGate} < port@${iPort}`);
    ok(/capability_not_granted/.test(src.slice(iGate, iGate + 200)), 'R-10g 该闸回码＝`capability_not_granted`');
  }

  // ═══ R-11｜配对前的门牌：只报"我会什么"，不报"我屋里有什么"（罗尔斯·无知之幕）══════
  //   zx_20261021_3 批四把门牌从四键扩为六键（增类目级能力/意图目录）——**重定向到更强的形状**：
  //   键集逐成员枚举 + 类目由真源派生 + 实例清单字段零出现（此前"不含 intent 字样"已不成立：
  //   意图目录本就是协议词汇；真正的边界是**实例**不出去）。
  console.log('\n【R-11】门牌 `GET /.well-known/agent.json` 六键、类目公开、清单遮蔽');
  {
    const res = await handleInboundRequest(
      { method: 'GET', path: INBOUND_WELL_KNOWN_PATH, headers: {}, remoteAddress: '192.168.1.44' },
      { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0' },
    );
    eq(res.status, 200, 'R-11a 免凭据取门牌 ⇒ 200');
    const body = res.body as Record<string, unknown>;
    eq(Object.keys(body).sort(),
      ['agent_version', 'intents', 'name', 'offered_capabilities', 'pairing', 'protocol'],
      'R-11b ★门牌**恰六键**（第七样仍然不许）');
    eq((body.offered_capabilities as Array<{ key: string }>).map((c) => c.key), [...EXTERNAL_CAPABILITIES],
      'R-11c ★能力类目＝`EXTERNAL_CAPABILITIES`（派生，不手抄）');
    eq((body.intents as Array<{ id: string }>).map((i) => i.id), publicIntents().map((i) => i.id),
      'R-11d ★意图目录＝`publicIntents()`（派生，不手抄）');
    const text = JSON.stringify(body);
    for (const leak of ['devices', 'rooms', 'room_id', 'device_id', 'node_id', 'alias', 'address', 'port', 'authorized']) {
      ok(!new RegExp(`"${leak}"`).test(text), `R-11e ★反证：门牌不含实例字段 \`${leak}\``);
    }
  }

  // ═══ R-12｜意图两跳先过认证与授权（两只标本：无凭据 401 / 没授予 403）════════════════
  console.log('\n【R-12】resolve 的凭据闸与授予闸');
  {
    const env = makeIntentEnv();
    const anon = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: {}, remoteAddress: '192.168.1.44', body: intentBody() },
      env.deps,
    );
    eq(anon.status, 401, 'R-12a ★标本①（无 bearer）：resolve ⇒ 401');
    eq((anon.body as { error?: string }).error, 'missing_credentials', 'R-12b 回码＝`missing_credentials`');
    eq(env.plans(), 0, 'R-12c 反证：未认证不落计划');

    const env2 = makeIntentEnv({ caps: ['device_control'] });
    eq(env2.plans(), 0, 'R-12d 基线：未授予意图控制的终端，计划 0 条');
    const res = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env2.cred), remoteAddress: '192.168.1.44', body: intentBody() },
      env2.deps,
    );
    eq(res.status, 403, 'R-12e ★标本②（只授予 device_control）：resolve ⇒ 403');
    eq((res.body as { error?: string }).error, 'capability_not_granted', 'R-12f 回码＝`capability_not_granted`');
    eq(env2.plans(), 0, 'R-12g ★反证：没授予就**不落计划**');
    eq(env2.calls.length, 0, 'R-12h ★反证：传动一次都没被调用');
    const row = env2.db.prepare('SELECT result, reason FROM wa_external_calls ORDER BY rowid DESC LIMIT 1').get() as { result?: string; reason?: string };
    eq([row.result, row.reason], ['denied', 'capability_not_granted'], 'R-12i 被拒也留痕（denied / capability_not_granted）');
    env.db.close(); env2.db.close();
  }

  // ═══ R-13｜词表与参数校验：门外报什么，先问认不认识（维特根斯坦·意义即用法）════════
  console.log('\n【R-13】未知意图 / 未知参数 ⇒ 400 + 允许的意图名');
  {
    eq(intentNames(), [HOME_COMFORT_INTENT], 'R-13a 本轮意图词表**恰一项**：`home.comfort`');
    eq(validateIntent({ intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'hot' } }),
      { ok: true, intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'hot' } },
      'R-13b 正标本：合法意图+参数 ⇒ 原样通过');

    const env = makeIntentEnv();
    const unknown = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44',
        body: { intent: 'home.launch_rocket', params: {} } },
      env.deps,
    );
    eq(unknown.status, 400, 'R-13c ★未知意图 ⇒ 400');
    const ub = unknown.body as { error?: string; allowed?: string[] };
    eq(ub.error, 'unknown_intent', 'R-13d 回码＝`unknown_intent`');
    ok(Array.isArray(ub.allowed) && ub.allowed.includes(HOME_COMFORT_INTENT),
      'R-13e ★回包列出允许的意图名（可行动的下一步）', JSON.stringify(ub.allowed));

    const badParam = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44',
        body: { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'hot', secret: 'x' } } },
      env.deps,
    );
    eq(badParam.status, 400, 'R-13f ★未知参数 ⇒ 400');
    const pb = badParam.body as { error?: string; errors?: string[]; allowed?: string[] };
    eq(pb.error, 'invalid_params', 'R-13g 回码＝`invalid_params`');
    ok(Array.isArray(pb.errors) && pb.errors.some((e) => e.includes('secret')),
      'R-13h ★逐条原因点名多余参数', JSON.stringify(pb.errors));
    ok(Array.isArray(pb.allowed) && pb.allowed.includes(HOME_COMFORT_INTENT),
      'R-13i 非法参数也回允许的意图名');

    const badFeeling = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44',
        body: { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'humid' } } },
      env.deps,
    );
    eq(badFeeling.status, 400, 'R-13j 枚举外取值 ⇒ 400');
    ok(((badFeeling.body as { errors?: string[] }).errors ?? []).some((e) => e.includes(COMFORT_FEELINGS.join('/'))),
      'R-13k 回包逐条列出允许的取值');

    eq(env.plans(), 0, 'R-13l ★反证：三条烂请求**一条计划都没落**');
    eq(env.calls.length, 0, 'R-13m ★反证：设备一次都没被碰');
    env.db.close();
  }

  // ═══ R-14｜resolve 零副作用：只落计划，不碰设备（王阳明·知行合一）══════════════════
  console.log('\n【R-14】resolve 只落 `wa_intent_plans`（status=planned）');
  {
    const env = makeIntentEnv();
    eq(env.plans(), 0, 'R-14a 基线：计划账 0 条');
    eq(env.actions(), 0, 'R-14b 基线：设备动作账 0 行');
    const res = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44',
        body: intentBody({ utterance: '我有点热' }) },
      env.deps,
    );
    eq(res.status, 200, 'R-14c resolve ⇒ 200');
    const body = res.body as { planId?: string; expiresIn?: number; steps?: IntentStep[]; skipped?: IntentSkip[] };
    ok(typeof body.planId === 'string' && body.planId.length > 0, 'R-14d 回包带 `planId`');
    eq(body.expiresIn, INTENT_PLAN_TTL_SEC, 'R-14e 回包 `expiresIn`＝计划寿命（一处真源）');
    eq(body.steps?.length, SPECIMEN_STEPS.length, 'R-14f 回包含计划步骤');
    eq(body.skipped, [], 'R-14g 回包含 `skipped`（本例为空）');
    eq(env.plans(), 1, 'R-14h ★0→1：计划账恰 1 条');
    eq(env.actions(), 0, 'R-14i ★反证：resolve **零设备动作**（设备动作账仍 0 行）');
    eq(env.calls.length, 0, 'R-14j ★反证：传动一次都没被调用');

    const row = getIntentPlan(env.db as never, String(body.planId));
    eq(row?.status, 'planned', 'R-14k 计划状态＝`planned`（尚未执行）');
    eq(row?.params_json, JSON.stringify({ room: '客厅', feeling: 'hot' }), 'R-14l 校验后的参数原样落库');
    const base = new Date('2026-10-18T00:00:00Z');
    eq(row?.expires_at, dbNowUtc(new Date(base.getTime() + INTENT_PLAN_TTL_SEC * 1000)),
      'R-14m `expires_at`＝注入时刻 + 寿命');

    const src = CODE(`${A}/src/main/core/inbound-gate.ts`);
    ok(/export const INBOUND_INTENT_RESOLVE_PATH = '\/api\/v1\/intent\/resolve'/.test(src)
      && /export const INBOUND_INTENT_EXECUTE_PATH = '\/api\/v1\/intent\/execute'/.test(src),
      'R-14n 门端点常量在册（resolve/execute 两路）');
    ok(/cap\.resolveIntent\(v\.terminal\.terminalId/.test(src) && /cap\.executeIntent\(v\.terminal\.terminalId/.test(src),
      'R-14o ★★两道意图路由真接到能力端口（读去注释后的代码）');
    ok(/CREATE TABLE IF NOT EXISTS wa_intent_plans/.test(CODE(`${A}/src/main/database.ts`)),
      'R-14p 生产库建 `wa_intent_plans` 表（语义真源在 intent-plans.ts）');
    env.db.close();
  }

  // ═══ R-15｜计划有寿命：过期即不执行（道德经·知止）════════════════════════════════
  console.log('\n【R-15】过期计划 execute ⇒ 409 `plan_expired`');
  {
    const env = makeIntentEnv();
    const r = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: intentBody() },
      env.deps,
    );
    const planId = String((r.body as { planId?: string }).planId ?? '');
    ok(planId.length > 0, 'R-15a 先落一条计划');
    env.nowRef.at = new Date(env.nowRef.at.getTime() + (INTENT_PLAN_TTL_SEC + 1) * 1000);
    const res = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_EXECUTE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: { planId } },
      env.deps,
    );
    eq(res.status, 409, 'R-15b ★过期后 execute ⇒ 409');
    eq((res.body as { error?: string }).error, 'plan_expired', 'R-15c 回码＝`plan_expired`');
    eq(env.calls.length, 0, 'R-15d ★★反证：一步都没执行');
    eq(env.actions(), 0, 'R-15e 反证：设备动作账 0 行');
    eq(getIntentPlan(env.db as never, planId)?.status, 'planned', 'R-15f 计划仍是 `planned`（没有被偷改成执行过）');
    eq(getIntentPlan(env.db as never, planId)?.executed_at, null, 'R-15g `executed_at` 仍为空');
    env.db.close();
  }

  // ═══ R-16｜只执行一次：认领用单条 UPDATE 决胜（毛选·不打无准备之仗）════════════════
  console.log('\n【R-16】同一计划第二次 execute ⇒ 409 `plan_already_executed`');
  {
    const env = makeIntentEnv();
    const r = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: intentBody() },
      env.deps,
    );
    const planId = String((r.body as { planId?: string }).planId ?? '');
    eq(env.calls.length, 0, 'R-16a 基线：执行前传动 0 次');
    const first = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_EXECUTE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: { planId } },
      env.deps,
    );
    eq(first.status, 200, 'R-16b ★标本①：首次 execute ⇒ 200');
    eq((first.body as { status?: string }).status, 'executed', 'R-16c 首次收口＝`executed`');
    eq(env.calls.length, SPECIMEN_STEPS.length, 'R-16d ★0→1：步骤真执行（每次一步）');
    const row = getIntentPlan(env.db as never, planId);
    eq(row?.status, 'executed', 'R-16e 计划状态＝`executed`');
    ok(typeof row?.executed_at === 'string' && row.executed_at.length > 0, 'R-16f `executed_at` 已落');

    const second = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_EXECUTE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: { planId } },
      env.deps,
    );
    eq(second.status, 409, 'R-16g ★标本②：第二次 execute ⇒ 409');
    eq((second.body as { error?: string }).error, 'plan_already_executed', 'R-16h 回码＝`plan_already_executed`');
    eq(env.calls.length, SPECIMEN_STEPS.length, 'R-16i ★★反证：步骤**没有被再执行一遍**');
    eq(env.actions(), SPECIMEN_STEPS.length, 'R-16j 设备动作账仍＝一次执行的行数');

    const unknown = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_EXECUTE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: { planId: 'no-such-plan' } },
      env.deps,
    );
    eq(unknown.status, 409, 'R-16k 不存在的计划 ⇒ 409');
    eq((unknown.body as { error?: string }).error, 'plan_not_found', 'R-16l 回码＝`plan_not_found`（按行现状分因）');
    env.db.close();
  }

  // ═══ R-17｜逐步结果与顺序：说的话与做的事逐条对得上（维特根斯坦·意义即用法）════════
  console.log('\n【R-17】execute 逐步结果＝计划顺序；动作账行数＝步数');
  {
    const env = makeIntentEnv();
    const r = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: intentBody() },
      env.deps,
    );
    const planId = String((r.body as { planId?: string }).planId ?? '');
    const res = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_EXECUTE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44', body: { planId } },
      env.deps,
    );
    eq(res.status, 200, 'R-17a execute ⇒ 200');
    const steps = (res.body as { steps?: Array<{ call_name: string; action: string; ok: boolean }> }).steps ?? [];
    eq(steps.map((s) => s.call_name), SPECIMEN_STEPS.map((s) => s.call_name),
      'R-17b ★结果顺序与计划**逐条一致**');
    eq(steps.map((s) => s.action), SPECIMEN_STEPS.map((s) => s.action), 'R-17c 动作顺序亦一致');
    ok(steps.every((s) => s.ok === true), 'R-17d 每步如实记 ok');
    eq(env.calls.map((c) => c.action), SPECIMEN_STEPS.map((s) => s.action),
      'R-17e ★传动实际调用顺序＝计划顺序');
    eq(env.calls[1]?.args, SPECIMEN_STEPS[1]?.args, 'R-17f 步骤参数原样传给传动');
    eq(env.actions(), SPECIMEN_STEPS.length, 'R-17g ★设备动作账行数＝执行步骤数');
    eq(getIntentPlan(env.db as never, planId)?.status, 'executed', 'R-17h 全部成功 ⇒ `executed`');
    env.db.close();
  }

  // ═══ R-18｜房间歧义：列候选、不猜、不落计划（罗尔斯·无知之幕）══════════════════════
  console.log('\n【R-18】`needs_clarification` ⇒ 409 + 候选列表');
  {
    const env = makeIntentEnv({
      planner: () => ({ ok: false, reason: 'needs_clarification', candidates: ['客厅', '主卧'] }),
    });
    const res = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44',
        body: intentBody({ params: { room: '卧室', feeling: 'hot' } }) },
      env.deps,
    );
    eq(res.status, 409, 'R-18a ★歧义 ⇒ 409');
    const b = res.body as { error?: string; candidates?: string[] };
    eq(b.error, 'needs_clarification', 'R-18b 回码＝`needs_clarification`');
    eq(b.candidates, ['客厅', '主卧'], 'R-18c ★候选列表原样回（不替它选）');
    eq(env.plans(), 0, 'R-18d ★反证：歧义**不落计划**');
    eq(env.calls.length, 0, 'R-18e ★反证：设备一次都没被碰');
    const row = env.db.prepare('SELECT result, reason FROM wa_external_calls ORDER BY rowid DESC LIMIT 1').get() as { result?: string; reason?: string };
    eq([row.result, row.reason], ['denied', 'needs_clarification'], 'R-18f 歧义也留痕（denied / needs_clarification）');
    env.db.close();
  }

  // ═══ R-19｜自省面：说得出词与房间，说不出坐标与授权态（管子·度量衡）════════════════
  console.log('\n【R-19】`/capabilities` 含 intents/rooms，不含坐标与授权态');
  {
    const env = makeIntentEnv({ rooms: ['客厅', ' 客厅 ', '主卧', ''] });
    const res = await handleInboundRequest(
      { method: 'GET', path: INBOUND_CAPABILITIES_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44' },
      env.deps,
    );
    eq(res.status, 200, 'R-19a 意图终端 `GET /capabilities` ⇒ 200');
    const body = res.body as {
      capabilities?: string[]; intents?: unknown; rooms?: string[];
      devices?: Array<Record<string, unknown>>;
    };
    eq(body.intents, publicIntents(), 'R-19b ★意图清单＝`publicIntents()`（词表一处真源）');
    ok(JSON.stringify(body.intents).includes(HOME_COMFORT_INTENT), 'R-19c 列出 `home.comfort`');
    eq(body.rooms, ['主卧', '客厅'], 'R-19d ★房间名去重、去空、排序');
    eq(body.devices?.[0] && Object.keys(body.devices[0]).sort(), ['actions', 'call_name', 'kind'],
      'R-19e ★设备只见 name/kind/actions（`redactedDevices` 唯一出口）');
    const text = JSON.stringify(body);
    for (const leak of ['192.168.1.50', '"address"', '"port"', '"protocol"', '"authorized"', '"controllable"', '"status"']) {
      ok(!text.includes(leak), `R-19f ★反证：能力面不含 \`${leak}\``);
    }
    // 反证：直调面同样不借机泄露（意图终端调 `/invoke` 仍被拒且无坐标）。
    const inv = await handleInboundRequest(
      { method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44',
        body: { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } } },
      env.deps,
    );
    eq(inv.status, 403, 'R-19g 反证：意图终端 `/invoke` 仍 403');
    ok(!JSON.stringify(inv.body).includes('192.168.1.50'), 'R-19h 反证：拒绝回包不含网络坐标');
    env.db.close();
  }

  // ═══ R-20｜`utterance` 只落账不参与解析（维特根斯坦·意义即用法）════════════════════
  console.log('\n【R-20】换任何 `utterance`，计划逐字相同');
  {
    const seen: IntentResolveInput[] = [];
    const env = makeIntentEnv({
      planner: (input) => {
        seen.push(input);
        return { ok: true, steps: SPECIMEN_STEPS.map((s) => ({ ...s })), skipped: [] };
      },
    });
    const call = async (utterance: string) => handleInboundRequest(
      { method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44',
        body: intentBody({ utterance }) },
      env.deps,
    );
    const a = await call('我有点热');
    const b = await call('好热啊，快帮我弄一下');
    eq(a.status, 200, 'R-20a 第一句 ⇒ 200');
    eq(b.status, 200, 'R-20b 第二句 ⇒ 200');
    const pa = String((a.body as { planId?: string }).planId ?? '');
    const pb = String((b.body as { planId?: string }).planId ?? '');
    eq(getIntentPlan(env.db as never, pa)?.plan_json, getIntentPlan(env.db as never, pb)?.plan_json,
      'R-20c ★★同样参数、不同 `utterance` ⇒ 计划逐字相同');
    eq(seen.length, 2, 'R-20d 规划器被调用两次');
    for (const input of seen) {
      eq(Object.keys(input).sort(), ['intent', 'params'], 'R-20e ★★规划器只收到 intent/params（utterance 不进解析）');
      eq(input.params, { room: '客厅', feeling: 'hot' }, 'R-20f 参数为校验后的词表内取值');
    }
    ok(!String(getIntentPlan(env.db as never, pa)?.plan_json).includes('我有点热'),
      'R-20g ★反证：计划里没有原话（原话只落账）');
    const audit = env.db.prepare('SELECT args_json FROM wa_external_calls ORDER BY rowid DESC LIMIT 1').get() as { args_json?: string };
    ok(String(audit.args_json).includes('好热啊，快帮我弄一下'),
      'R-20h ★原话如实落在外呼账（`utterance` 有据可查）');
    env.db.close();
  }

  // ═══ R-21｜房间列：新库建得出、旧库迁得进（旧行＝未分配，不编造）════════════════════
  console.log('\n【R-21】`wa_devices.room` 新库/旧库都在场');
  {
    const dbSrc = CODE(`${A}/src/main/database.ts`);
    const freshStart = dbSrc.indexOf('CREATE TABLE IF NOT EXISTS wa_devices');
    const freshEnd = dbSrc.indexOf('idx_wa_devices_ident');
    const fresh = dbSrc.slice(freshStart, freshEnd);
    ok(freshStart >= 0 && /^\s*room TEXT DEFAULT '',?\s*$/m.test(fresh),
      'R-21a ★新库 DDL 含 `room TEXT DEFAULT \'\'`');
    const alter = dbSrc.match(/"ALTER TABLE wa_devices ADD COLUMN room ([^"]+)"/)?.[1]?.trim();
    eq(alter, "TEXT DEFAULT ''", 'R-21b ★迁移数组含 room 列（与 DDL 同缺省）');

    // 行为标本：旧库（无 room 列）+ 已有行 ⇒ 跑生产那条 ALTER ⇒ 旧行读到 ''。
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE wa_devices (
      id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '',
      kind TEXT DEFAULT 'unknown', protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER,
      capabilities_json TEXT DEFAULT '[]', controllable INTEGER DEFAULT 0, authorized INTEGER DEFAULT 0,
      status_json TEXT, first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), online INTEGER
    )`);
    d.prepare('INSERT INTO wa_devices (id, name, protocol, address) VALUES (?, ?, ?, ?)')
      .run('old-1', '旧灯', 'mqtt', 'old#1');
    const cols = (d.prepare('PRAGMA table_info(wa_devices)').all() as Array<{ name?: string }>).map((c) => c.name);
    ok(!cols.includes('room'), 'R-21c 迁移前旧库**没有** room 列（0 起点）');
    d.exec(`ALTER TABLE wa_devices ADD COLUMN room ${alter}`);
    eq(getDevice(d as unknown as DeviceDb, 'old-1')?.room, '',
      'R-21d ★旧行迁移后 room＝空串（未分配，不编造房间）');
    d.close();
  }

  // ═══ R-22｜HA 自述提示：两种写法都认；无自述不猜（维特根斯坦·意义即用法）════════════
  console.log('\n【R-22】HA 房间提示两种写法都认；无自述不猜');
  {
    const top = haConfigToDevice('homeassistant/light/top/config',
      JSON.stringify({ uniq_id: 'ha-top', name: '顶灯', cmd_t: 'top/set', suggested_area: '客厅' }), 'b', 1883);
    eq(top?.roomHint, '客厅', 'R-22a 顶层 `suggested_area` ⇒ roomHint');
    const blk = haConfigToDevice('homeassistant/light/blk/config',
      JSON.stringify({ uniq_id: 'ha-blk', name: '落地灯', cmd_t: 'blk/set', device: { name: '落地灯', sa: '书房' } }), 'b', 1883);
    eq(blk?.roomHint, '书房', 'R-22b `device` 块缩写 `sa` ⇒ roomHint');
    const area = haConfigToDevice('homeassistant/light/area/config',
      JSON.stringify({ uniq_id: 'ha-area', name: '壁灯', cmd_t: 'area/set', area_id: '主卧' }), 'b', 1883);
    eq(area?.roomHint, '主卧', 'R-22c 回退 `area_id`');
    const none = haConfigToDevice('homeassistant/light/none/config',
      JSON.stringify({ uniq_id: 'ha-none', name: '台灯', cmd_t: 'none/set' }), 'b', 1883);
    ok(none != null && !('roomHint' in none),
      'R-22d ★反证：无自述提示 ⇒ **不带** roomHint 键（不猜房间）');

    // 落账：0→1 正面断言（发现带提示 ⇒ 房间里出现它）。
    const db = makeRoomDb();
    eq(listRooms(db), [], 'R-22e 落账前房间集合为空（0）');
    const row = upsertDiscovered(db, discovered({ roomHint: '客厅' }));
    eq(row.room, '客厅', 'R-22f ★0→1：发现提示落成房间');
    eq(listRooms(db), ['客厅'], 'R-22g 房间集合此刻恰一项');
    const bare = upsertDiscovered(db, discovered({ address: 'b#light_2', name: '走廊灯' }));
    eq(bare.room, '', 'R-22h ★反证：无提示的新设备 room＝空串（未分配，不是"未知"）');
  }

  // ═══ R-23｜人设的房间，发现永不覆盖（罗尔斯·同一把尺）══════════════════════════════
  console.log('\n【R-23】人设的房间，发现永不覆盖');
  {
    const db = makeRoomDb();
    const first = upsertDiscovered(db, discovered({ roomHint: '客厅' }));
    eq(first.room, '客厅', 'R-23a 首见依提示填空');
    eq(setDeviceRoom(db, first.id, '书房')?.room, '书房', 'R-23b 人在面板上指派「书房」');
    const again = upsertDiscovered(db, discovered({ roomHint: '客厅' }));
    eq(again.room, '书房', 'R-23c ★★再次发现（提示 客厅）⇒ 人设的「书房」**不被覆盖**');
    eq(setDeviceRoom(db, first.id, '')?.room, '', 'R-23d 清空 ⇒ 回到未分配（清除是合法操作）');
    const refill = upsertDiscovered(db, discovered({ roomHint: '客厅' }));
    eq(refill.room, '客厅', 'R-23e ★反证：空着时提示**可以**填（不是"发现永不写房间"）');
  }

  // ═══ R-24｜房间匹配＝精确相等（管子·度量衡：说「客厅」就是客厅）══════════════════════
  console.log('\n【R-24】房间匹配＝精确相等（不是子串/模糊）');
  {
    const db = makeRoomDb();
    const mk = (name: string, address: string, room: string, now: string) =>
      upsertDiscovered(db, discovered({ name, address, roomHint: room }), now);
    mk('客厅灯', 'b#a1', '客厅', '2026-10-18 00:00:01');
    mk('客厅1的灯', 'b#a2', '客厅1', '2026-10-18 00:00:02');
    mk('大客厅灯', 'b#a3', '大客厅', '2026-10-18 00:00:03');
    mk('客厅吊灯（未分配）', 'b#a4', '', '2026-10-18 00:00:04');
    mk('书房灯', 'b#a5', ' 书房 ', '2026-10-18 00:00:05');
    mk('Living A', 'b#a6', 'Living Room', '2026-10-18 00:00:06');
    mk('Living B', 'b#a7', 'living room', '2026-10-18 00:00:07');
    const names = (room: string) => devicesInRoom(db, room).map((x) => x.name).sort();
    eq(names('客厅'), ['客厅灯'], 'R-24a ★只有 room 恰为「客厅」的设备');
    eq(names(' 客厅 '), ['客厅灯'], 'R-24b 查询侧归一空白后仍精确命中');
    eq(names('书房'), ['书房灯'], 'R-24c 写入侧 ` 书房 ` 已归一（不是带空格的另一种房间）');
    eq(names('LIVING ROOM'), ['Living A', 'Living B'], 'R-24d 大小写不敏感（同一房间两台）');
    eq(names(''), [], 'R-24e ★反证：空查询 ⇒ 空数组（不把"没问"当"全部"）');
    eq(names('厅'), [], 'R-24f ★★反证：不做子串——「厅」命不中「客厅」/「大客厅」');
    eq(names('客厅吊灯（未分配）'), [], 'R-24g ★★反证：名字含「客厅」但房间为空的**不算**客厅设备');
  }

  // ═══ R-25｜`/capabilities.rooms` 与台账同源（不另数一遍）════════════════════════════
  console.log('\n【R-25】`/capabilities.rooms` 与台账同源');
  {
    const db = makeRoomDb();
    upsertDiscovered(db, discovered({ address: 'b#r1', roomHint: '客厅' }), '2026-10-18 00:00:01');
    upsertDiscovered(db, discovered({ address: 'b#r2', name: '客厅吸顶灯', roomHint: '客厅' }), '2026-10-18 00:00:02');
    upsertDiscovered(db, discovered({ address: 'b#r3', name: '主卧灯', roomHint: '主卧' }), '2026-10-18 00:00:03');
    upsertDiscovered(db, discovered({ address: 'b#r4', name: '未分配灯' }), '2026-10-18 00:00:04');
    const expected = listRooms(db);
    eq(expected, ['主卧', '客厅'], 'R-25a 台账房间去重、去空、排序（两台客厅只算一间）');
    const env = makeIntentEnv({ rooms: expected });
    const res = await handleInboundRequest(
      { method: 'GET', path: INBOUND_CAPABILITIES_PATH, headers: bearer(env.cred), remoteAddress: '192.168.1.44' },
      env.deps,
    );
    eq((res.body as { rooms?: string[] }).rooms, listRooms(db), 'R-25b ★能力面 rooms ≡ `listRooms(db)`');
    const src = CODE(`${A}/src/main/index.ts`);
    ok(/listRooms:\s*\(\)\s*=>\s*listRooms\(db!\)/.test(src),
      'R-25c ★★装配层那一跳直接调 `listRooms(db)` 真源（没有第二份计算）');
    env.db.close();
  }

  // ═══ R-26｜面板改房间 ⇒ 库内持久、归一、可清除（毛选·没有调查没有发言权）══════════════
  console.log('\n【R-26】面板改房间 ⇒ 库内持久、归一、可清除');
  {
    const db = makeRoomDb();
    const row = upsertDiscovered(db, discovered());
    eq(setDeviceRoom(db, row.id, '  儿童   房 ')?.room, '儿童 房',
      'R-26a 书写形态归一（首尾去空、内部连续空白压一个）');
    eq(normalizeRoomName('  A   B '), 'A B', 'R-26b `normalizeRoomName` 同形（一处真源）');
    eq(getDevice(db, row.id)?.room, '儿童 房', 'R-26c ★重新读库仍在（不是只改了返回值）');
    eq(setDeviceRoom(db, 'nope', '客厅'), null, 'R-26d 不存在的设备 ⇒ null（不假装成功）');
    const ipcSrc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(/ipcMain\.handle\(\s*'devices:set_room'/.test(ipcSrc) && /setDeviceRoom\(\s*ddb\s*,\s*deviceId/.test(ipcSrc),
      'R-26e ★IPC 写口在册且走 `setDeviceRoom`（唯一写点）');
    const lib = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(lib.includes("'devices:set_room'"), 'R-26f 渲染层 IPC 名与主进程一致');
    const page = CODE(`${A}/renderer/src/pages/DevicesPage.tsx`);
    ok(/devicesApi\.setRoom\(\s*dev\.id\s*,\s*roomDraft\s*\)/.test(page),
      'R-26g ★面板保存动作真的调 `setRoom`');
    ok(page.includes('未分配'), 'R-26h ★★空房间在面上说「未分配」（不是空白/“未知房间”）');
  }

  // ═══ R-27｜HA 自述的主题逐项进能力面（维特根斯坦·意义即用法：只说存一个字符串，发不出这些动作）══
  console.log('\n【R-27】HA 上行/细粒度主题逐项进能力面');
  {
    const dev = haDevice();
    const expected: Array<[string, string]> = [
      ['jattr:', 'base/attr'],
      ['tempcmd:', 'base/temp'],
      ['modecmd:', 'base/mode'],
      ['poscmd:', 'base/pos'],
      ['brightcmd:', 'base/bri'],
    ];
    for (const [prefix, topic] of expected) {
      ok(dev.capabilities.includes(`${prefix}${topic}`), `R-27 能力面含 \`${prefix}${topic}\``);
    }
    eq(deviceStateTopics(dev), { state: 'base/state', attributes: 'base/attr' },
      'R-27f ★上行主题＝state/jattr（一处投影）');
    eq(haStateTopics(dev), deviceStateTopics(dev), 'R-27g `haStateTopics` 委托同一真源（不另判一遍）');
    // `~` 基主题展开（HA 标准写法）：只留开关相关主题，其余撤销。
    const base = haDevice('switch', {
      '~': 'zigbee2mqtt/lamp', cmd_t: '~/set', stat_t: '~/state', json_attr_t: '~/attr',
      temp_cmd_t: undefined, mode_cmd_t: undefined, set_pos_t: undefined, bri_cmd_t: undefined,
    });
    eq(deviceStateTopics(base), { state: 'zigbee2mqtt/lamp/state', attributes: 'zigbee2mqtt/lamp/attr' },
      'R-27h ★`~` 基主题展开后取主题');
    ok(base.capabilities.includes('cmd:zigbee2mqtt/lamp/set'),
      'R-27i ★命令主题同样展开（不是字面 `~/set`）');
    const bare = haDevice('switch', { stat_t: undefined, json_attr_t: undefined });
    eq(deviceStateTopics(bare), { state: null, attributes: null },
      'R-27j ★反证：未自述 ⇒ 两项皆 null（不编主题）');
  }

  // ═══ R-28｜订阅去重：一台一次、共主题一次（0→N 正面断言）════════════════════════════
  console.log('\n【R-28】按设备去重订阅 state/attributes（重复发现不叠加）');
  {
    const fake = makeFakeSubscribeIo();
    const mgr = createLiveSubscriptionManager({ brokerHost: 'broker.local', io: fake.io, onUpdate: () => {} });
    const db = makeRoomDb();
    const a = upsertDiscovered(db, discovered({
      address: 'b#sub-a', name: 'A 灯',
      capabilities: ['mqtt', 'ha:light', 'state:b/a/state', 'jattr:b/a/attr'],
    }));
    const b = upsertDiscovered(db, discovered({
      address: 'b#sub-b', name: 'B 灯', capabilities: ['mqtt', 'ha:light', 'state:b/b/state'],
    }));
    eq(mgr.topics(), [], 'R-28a 起始订阅 0 条');
    ok(mgr.subscribe(a), 'R-28b 首台设备订阅成功');
    eq(fake.topics().sort(), ['b/a/attr', 'b/a/state'], 'R-28c ★0→2：底层真订阅两条');
    mgr.subscribe(a);
    eq(fake.topics().length, 2, 'R-28d ★★重复发现同一台 ⇒ 底层订阅**不叠加**');
    mgr.subscribe(b);
    eq(mgr.topics(), ['b/a/attr', 'b/a/state', 'b/b/state'], 'R-28e 第二台追加一条（共 3）');
    // 共主题：第三台自述 B 已订的 state 主题 ⇒ 仍只订一次。
    const c = upsertDiscovered(db, discovered({
      address: 'b#sub-c', name: 'C 灯', capabilities: ['mqtt', 'ha:light', 'state:b/b/state'],
    }));
    mgr.subscribe(c);
    eq(fake.topics().filter((t) => t === 'b/b/state').length, 1,
      'R-28f ★★两台共用一个主题 ⇒ 该主题只订一次');
    const d = upsertDiscovered(db, discovered({ address: 'b#sub-d', name: '无状态设备', capabilities: ['mqtt'] }));
    eq(mgr.subscribe(d), false, 'R-28g ★反证：无可订阅主题 ⇒ false（不发无谓订阅）');
    eq(fake.topics().length, 3, 'R-28h 反证：底层订阅数仍 3');
    mgr.stop();
  }

  // ═══ R-29｜上行落 live；控制快照与 last_seen 不被抹（两只标本 + 反向）══════════════
  console.log('\n【R-29】state 消息落 `status_json.live`，不改控制快照与 `last_seen`');
  {
    const db = makeRoomDb();
    const dev = upsertDiscovered(db, discovered({
      address: 'b#live', name: '卧室灯',
      capabilities: ['mqtt', 'ha:light', 'state:b/live/state', 'jattr:b/live/attr'],
    }), '2026-10-18 00:00:00');
    eq(deviceLiveStateOf(getDevice(db, dev.id)!.status), null,
      'R-29a 起始 live＝null（没收到过 ≠ 空状态）');
    setDeviceStatus(db, dev.id, { last_action: 'turn_off', last_ok: true, last_result: 'MQTT 已下发' }, '2026-10-18 00:00:01');
    const updates: string[] = [];
    const fake = makeFakeSubscribeIo();
    const mgr = createLiveSubscriptionManager({
      brokerHost: 'broker.local', io: fake.io,
      onUpdate: (u) => {
        updates.push(`${u.kind}:${u.payload}`);
        // 与生产装配层同形：state ⇒ `setDeviceLiveState`；attributes ⇒ `setDeviceLiveAttributes`。
        if (u.kind === 'state') setDeviceLiveState(db, u.deviceId, { source: 'state', state: u.payload });
        else setDeviceLiveAttributes(db, u.deviceId, u.payload);
      },
    });
    ok(mgr.subscribe(getDevice(db, dev.id)!), 'R-29b 订阅成功');
    fake.deliver('b/live/state', 'ON');
    const after = getDevice(db, dev.id)!;
    eq(deviceLiveStateOf(after.status)?.state, 'ON', 'R-29c ★0→1：live.state＝设备原文 `ON`');
    eq([after.status?.last_action, after.status?.last_ok, after.status?.last_result],
      ['turn_off', true, 'MQTT 已下发'], 'R-29d ★控制快照三键原样保留（上行不冒充控制）');
    eq(after.last_seen, '2026-10-18 00:00:01', 'R-29e ★`last_seen` 不动（收到状态 ≠ 见到设备）');
    eq(updates, ['state:ON'], 'R-29f onUpdate 收到一次 state');
    // 反向标本：写控制快照**不抹** live（一次命令不应让刚报的状态凭空消失）。
    setDeviceStatus(db, dev.id, { last_action: 'turn_on', last_ok: true, last_result: 'ok' }, '2026-10-18 00:00:02');
    eq(deviceLiveStateOf(getDevice(db, dev.id)!.status)?.state, 'ON',
      'R-29g ★★反向：写控制快照不抹 live');
    // 第二只标本：从未有过控制快照的设备 ⇒ live 独立成立。
    const fresh = upsertDiscovered(db, discovered({
      address: 'b#live2', name: '书房灯', capabilities: ['mqtt', 'ha:light', 'state:b/live2/state'],
    }), '2026-10-18 00:00:03');
    mgr.subscribe(fresh);
    fake.deliver('b/live2/state', '{"brightness":80}');
    const freshAfter = getDevice(db, fresh.id)!;
    eq(deviceLiveStateOf(freshAfter.status)?.state, '{"brightness":80}',
      'R-29h 第二标本：live 单独成立（原文透传）');
    ok(!('last_action' in (freshAfter.status ?? {})),
      'R-29i ★反证：没有控制就不编 last_action');
    mgr.stop();
  }

  // ═══ R-30｜`device_status` 两支标本：有上行 ⇒ live+at；无 ⇒ live:null ════════════════
  console.log('\n【R-30】`device_status` 的 live 投影（分名，不拿快照冒充）');
  {
    const db = makeRoomDb();
    const dev = upsertDiscovered(db, discovered({
      address: 'b#payload', name: '阳台灯', capabilities: ['mqtt', 'ha:light', 'state:b/p/state'],
    }), '2026-10-18 00:00:00');
    const before = deviceStatusPayload(getDevice(db, dev.id)!);
    eq(before.live, null, 'R-30a ★无上行 ⇒ live:null（不拿快照冒充）');
    eq(before.status, null, 'R-30b 也无控制快照 ⇒ status:null（不知道如实）');
    setDeviceLiveState(db, dev.id, { source: 'state', state: '22.5' }, '2026-10-18 00:00:05');
    setDeviceStatus(db, dev.id, { last_action: 'turn_on', last_ok: true, last_result: 'ok' }, '2026-10-18 00:00:06');
    const payload = deviceStatusPayload(getDevice(db, dev.id)!);
    eq(payload.live, { state: '22.5', attributes: {}, at: '2026-10-18 00:00:05', source: 'state' },
      'R-30c ★live 形状（state/attributes/at/source）');
    ok(payload.status != null && !('live' in (payload.status as Record<string, unknown>)),
      'R-30d ★★`status` 里**没有** live（两者分名）');
    eq(payload.status, { last_action: 'turn_on', last_ok: true, last_result: 'ok' },
      'R-30e `status` 仍是上次控制快照');
    const src = CODE(`${A}/src/main/core/tools/device.ts`);
    ok(/const payload = deviceStatusPayload\(dev\);/.test(src),
      'R-30f ★`device_status.execute` 走同一投影（不另拼一份）');
    ok(/payload\.provider_state = await cloudDeviceState\(dev\)/.test(src),
      'R-30g 云设备另问 Provider（不拿缓存冒充实时）');
  }

  // ═══ R-31｜HA 命令映射逐成员（管子·度量衡：一条动作只落一个主题）══════════════════════
  console.log('\n【R-31】HA 命令映射逐成员断言');
  {
    // 复合标本（light）：全部细粒度主题都自述——判"动作 → 专用主题"的选路本身。
    const composite = haDevice();
    const t = (action: string, args: Record<string, unknown> = {}) => haCommandTarget(composite, action, args);
    eq(t('turn_on'), { topic: 'base/cmd', payload: '1' }, 'R-31a turn_on ⇒ cmd + 自述 on 载荷');
    eq(t('turn_off'), { topic: 'base/cmd', payload: '0' }, 'R-31b turn_off ⇒ cmd + 自述 off 载荷');
    eq(t('set_temperature', { temperature: 26 }), { topic: 'base/temp', payload: '26' },
      'R-31c set_temperature ⇒ `temperature_command_topic`');
    eq(t('set_mode', { mode: 'heat' }), { topic: 'base/mode', payload: 'heat' },
      'R-31d set_mode ⇒ `mode_command_topic`');
    eq(t('set_brightness', { brightness: 128 }), { topic: 'base/bri', payload: '128' },
      'R-31e set_brightness ⇒ `brightness_command_topic`');
    eq(t('set_brightness', { brightness_pct: 50 }), { topic: 'base/bri', payload: '50' },
      'R-31f `brightness_pct` 同义');
    eq(t('select_option', { option: 'Scene A' }), { topic: 'base/cmd', payload: 'Scene A' },
      'R-31g select_option ⇒ command_topic');
    eq(t('set_value', { value: 42 }), { topic: 'base/cmd', payload: '42' }, 'R-31h set_value 数字⇒字符串');
    eq(t('set_value', { value: 'hello' }), { topic: 'base/cmd', payload: 'hello' }, 'R-31i set_value 字符串原样');
    // cover：开合与位置。
    const cover = haDevice('cover', { temp_cmd_t: undefined, mode_cmd_t: undefined, bri_cmd_t: undefined });
    ok(cover.capabilities.includes('poscmd:base/pos'), 'R-31j cover 标本含 set_position 主题');
    eq(haCommandTarget(cover, 'open', {}), { topic: 'base/cmd', payload: 'OPEN' }, 'R-31k open ⇒ OPEN');
    eq(haCommandTarget(cover, 'close', {}), { topic: 'base/cmd', payload: 'CLOSE' }, 'R-31l close ⇒ CLOSE');
    eq(haCommandTarget(cover, 'stop', {}), { topic: 'base/cmd', payload: 'STOP' }, 'R-31m stop ⇒ STOP');
    eq(haCommandTarget(cover, 'set_position', { position: 45 }), { topic: 'base/pos', payload: '45' },
      'R-31n set_position ⇒ `set_position_topic` + 数字');
    eq(haCommandTarget(cover, 'set_position', { position: '60' }), { topic: 'base/pos', payload: '60' },
      'R-31o set_position 认数字串');
    // scene：激活载荷取自设备自述 `payload_on`。
    const scene = haDevice('scene', { pl_on: 'SCENE_ON' });
    eq(haCommandTarget(scene, 'activate_scene', {}), { topic: 'base/cmd', payload: 'SCENE_ON' },
      'R-31p activate_scene ⇒ command_topic + 自述 on 载荷');
    // 缺参数 ⇒ 如实回退既有语言（不把 `undefined` 发出去）。
    eq(t('set_temperature', {}), { topic: 'base/cmd', payload: '{"action":"set_temperature"}' },
      'R-31q ★反证：缺 temperature ⇒ 回退 `{action,...args}`');
    // 集成：真 `mqttDeviceControl` 走同一选路（那一跳真发出去）。
    const fake = makeFakeMqttIo();
    const r = await mqttDeviceControl(composite, 'set_temperature', { temperature: 26 }, fake.io);
    ok(r.ok, 'R-31r `mqttDeviceControl` 成功（假 io）');
    eq(fake.sent, [{ topic: 'base/temp', payload: '26' }], 'R-31s ★★集成：真下发到专用温度主题');
    ok(r.result.includes('base/temp'), 'R-31t 回执人话带真主题');
  }

  // ═══ R-32｜非 HA 设备逐字不变（反证：HA 语言不外溢）════════════════════════════════
  console.log('\n【R-32】非 HA 设备仍走工蚁自有语言（逐字不变）');
  {
    const dev: AnsDevice = {
      id: 'raw-1', name: '自述灯', alias: '', room: '', kind: 'light', protocol: 'mqtt',
      address: 'broker.local#lamp', port: 1883, capabilities: ['mqtt', 'cmd:workerant/lamp/set'],
      controllable: true, authorized: true, status: null, online: null, first_seen: '', last_seen: '',
    };
    eq(haCommandTarget(dev, 'turn_on'), null, 'R-32a ★非 HA ⇒ null（不套 HA 语言）');
    eq(deviceCommandPayload(dev, 'turn_on', {}), '{"action":"turn_on"}', 'R-32b 载荷逐字：`{action}`');
    eq(deviceCommandPayload(dev, 'set', { b: 2, a: 1 }), '{"action":"set","b":2,"a":1}',
      'R-32c 参数原样并入（键序不变）');
    eq(mqttCommandTopic(dev), 'workerant/lamp/set', 'R-32d 命令主题取自 `cmd:`');
    const bare: AnsDevice = { ...dev, id: 'raw-2', address: 'broker.local#lamp2', capabilities: ['mqtt'] };
    eq(mqttCommandTopic(bare), 'lamp2/set', 'R-32e 无 `cmd:` ⇒ `<deviceId>/set`（既有回退不变）');
    const fake = makeFakeMqttIo();
    await mqttDeviceControl(dev, 'set', { level: 3 }, fake.io);
    eq(fake.sent, [{ topic: 'workerant/lamp/set', payload: '{"action":"set","level":3}' }],
      'R-32f ★集成：非 HA 下发逐字不变');
  }

  // ═══ R-33｜LWT offline ⇒ 在线态 false + live 清空（不拿旧 state 冒充在线）═════════════
  console.log('\n【R-33】可用性判「不在」⇒ live 清空，判「在」不复活旧值');
  {
    const db = makeRoomDb();
    const dev = upsertDiscovered(db, discovered({
      address: 'b#avty', name: '玄关灯',
      capabilities: ['mqtt', 'ha:light', 'state:b/avty/state', 'avty:b/avty/avty'],
    }), '2026-10-18 00:00:00');
    setDeviceStatus(db, dev.id, { last_action: 'turn_on', last_ok: true, last_result: 'ok' }, '2026-10-18 00:00:01');
    setDeviceLiveState(db, dev.id, { source: 'state', state: 'ON' }, '2026-10-18 00:00:02');
    eq(getDevice(db, dev.id)!.online, null, 'R-33a 起始在线态未知（null，不猜「在」）');
    const off = applyAvailability(db, dev.id, false, '2026-10-18 00:00:03')!;
    eq(off.online, false, 'R-33b ★offline ⇒ online=false');
    eq(deviceLiveStateOf(off.status), null, 'R-33c ★★live 清空：旧 state 不得继续冒充在线');
    eq(off.status?.last_action, 'turn_on', 'R-33d 控制快照保留（离线不是控制失败）');
    const on = applyAvailability(db, dev.id, true, '2026-10-18 00:00:04')!;
    eq(on.online, true, 'R-33e online=true ⇒ online=true');
    eq(deviceLiveStateOf(on.status), null, 'R-33f ★反证：判「在」**不**复活旧 state（等设备自己再报）');
    const ipc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(/applyDeviceAvailability\(ddb, dev\.id, online\)/.test(ipc),
      'R-33g ★IPC 可用性回调走注册表 `applyAvailability`（唯一落点）');
    const ha = CODE(`${A}/src/main/core/device-homeassistant.ts`);
    ok(/export function haAvailabilityOnline/.test(ha), 'R-33h 三态判据由 `haAvailabilityOnline` 定（认不出不写）');
  }

  // ═══ R-34｜Provider 无 `getState` ⇒ unsupported（不编状态）════════════════════════════
  console.log('\n【R-34】云 Provider 状态查询：无实现即 unsupported');
  {
    const cloudDev = (address: string): AnsDevice => ({
      id: 'cloud-1', name: '涂鸦灯', alias: '', room: '', kind: 'light', protocol: 'cloud',
      address, port: null, capabilities: [], controllable: true, authorized: true,
      status: null, online: null, first_seen: '', last_seen: '',
    });
    const noState: DeviceProvider = {
      id: 'acme', label: 'Acme 云',
      async listDevices() { return []; },
      async control() { return { ok: true, result: 'ok' }; },
    };
    registerDeviceProvider(noState);
    const r1 = await cloudDeviceState(cloudDev('acme:dev-9'));
    eq([r1.ok, r1.unsupported], [false, true], 'R-34a ★无 getState ⇒ ok:false + unsupported:true');
    ok((r1.error ?? '').includes('Acme 云'), 'R-34b 原因如实带 Provider 名');
    ok(r1.state === undefined, 'R-34c ★反证：不带伪造 state');
    const withState: DeviceProvider = {
      ...noState, id: 'acme2', label: 'Acme2 云',
      async getState(deviceId) { return { ok: true, state: { power: deviceId === 'dev-1' ? 'on' : 'off' } }; },
    };
    registerDeviceProvider(withState);
    eq(await cloudDeviceState(cloudDev('acme2:dev-1')), { ok: true, state: { power: 'on' } },
      'R-34d 正标本：有 getState ⇒ 原样透传');
    const r3 = await cloudDeviceState(cloudDev('ghost:dev-1'));
    eq([r3.ok, r3.unsupported], [false, undefined], 'R-34e 未注册 Provider ⇒ 如实错（不是 unsupported）');
    const thrower: DeviceProvider = {
      ...noState, id: 'boom', label: 'Boom 云',
      async getState() { throw new Error('网络断了'); },
    };
    registerDeviceProvider(thrower);
    const r4 = await cloudDeviceState(cloudDev('boom:dev-1'));
    eq([r4.ok, r4.unsupported], [false, undefined], 'R-34f Provider 抛错 ⇒ 收成 ok:false（不崩）');
    ok((r4.error ?? '').includes('网络断了'), 'R-34g 原因原样带上');
    unregisterDeviceProvider('acme');
    unregisterDeviceProvider('acme2');
    unregisterDeviceProvider('boom');
  }

  // ═══ R-35｜收摊：订阅计数归零 + 底层真收摊一次（清理正面断言）════════════════════════
  console.log('\n【R-35】停止桥接 ⇒ 订阅计数归零');
  {
    const fake = makeFakeSubscribeIo();
    const mgr = createLiveSubscriptionManager({ brokerHost: 'broker.local', io: fake.io, onUpdate: () => {} });
    const db = makeRoomDb();
    const dev = upsertDiscovered(db, discovered({
      address: 'b#stop', capabilities: ['mqtt', 'ha:light', 'state:b/stop/state', 'jattr:b/stop/attr'],
    }));
    mgr.subscribe(dev);
    eq(mgr.topics().length, 2, 'R-35a 停止前已订 2 条');
    eq(fake.stopped(), 0, 'R-35b 停止前收摊 0 次（0 起点）');
    mgr.stop();
    eq(mgr.topics(), [], 'R-35c ★订阅计数归零');
    eq(fake.stopped(), 1, 'R-35d ★0→1：底层订阅真收摊一次');
    eq(mgr.subscribe(dev), false, 'R-35e 停止后不再接受订阅（收摊幂等）');
    eq(fake.topics().length, 2, 'R-35f 反证：停止后没有新订阅');
    const ipc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(/ipcMain\.handle\(\s*'devices:stop'[\s\S]*?stopDeviceLiveSubscriptions\(\)/.test(ipc),
      'R-35g ★`devices:stop` 调 `stopDeviceLiveSubscriptions()`');
    const idx = CODE(`${A}/src/main/index.ts`);
    ok(/stopDeviceLiveSubscriptions/.test(idx) && /stopDeviceDiscovery/.test(idx),
      'R-35h ★退出时两处收摊都在册（发现 + 实时订阅）');
  }

  // ═══ R-36｜属性主题：JSON 并入；坏 JSON 保留旧值并记错（不崩、不抹）════════════════════
  console.log('\n【R-36】`json_attributes_topic` 的 JSON 对象并入 live.attributes');
  {
    const db = makeRoomDb();
    const dev = upsertDiscovered(db, discovered({
      address: 'b#attr', capabilities: ['mqtt', 'ha:light', 'state:b/attr/state', 'jattr:b/attr/attr'],
    }));
    setDeviceLiveState(db, dev.id, { source: 'state', state: 'ON' }, '2026-10-18 00:00:01');
    const good = setDeviceLiveAttributes(db, dev.id, '{"brightness":120,"color_mode":"rgb"}', '2026-10-18 00:00:02')!;
    eq(deviceLiveStateOf(good.status)?.attributes, { brightness: 120, color_mode: 'rgb' },
      'R-36a ★JSON 对象并入 live.attributes');
    eq(deviceLiveStateOf(good.status)?.state, 'ON', 'R-36b 属性消息不抹主状态（分名）');
    eq(deviceLiveStateOf(good.status)?.source, 'attributes', 'R-36c source 记 attributes');
    const bad = setDeviceLiveAttributes(db, dev.id, '{not json', '2026-10-18 00:00:03')!;
    eq(deviceLiveStateOf(bad.status)?.attributes, { brightness: 120, color_mode: 'rgb' },
      'R-36d ★★坏 JSON ⇒ 保留上一条属性（不拿空对象抹掉）');
    ok((deviceLiveStateOf(bad.status)?.attributes_error ?? '').includes('合法 JSON'),
      'R-36e ★如实记 attributes_error');
    const arr = setDeviceLiveAttributes(db, dev.id, '[1,2]', '2026-10-18 00:00:04')!;
    ok((deviceLiveStateOf(arr.status)?.attributes_error ?? '').includes('JSON 对象'),
      'R-36f 非对象 JSON 同样记错');
    eq(deviceLiveStateOf(arr.status)?.attributes, { brightness: 120, color_mode: 'rgb' },
      'R-36g 属性仍未被动');
    const fixed = setDeviceLiveAttributes(db, dev.id, '{"brightness":30}', '2026-10-18 00:00:05')!;
    eq(deviceLiveStateOf(fixed.status)?.attributes_error, undefined,
      'R-36h ★修好后错误清除（成功即清）');
    eq(deviceLiveStateOf(fixed.status)?.attributes, { brightness: 30 },
      'R-36i 属性主题语义＝整份上报（新对象整体替换）');
    const ipc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(/setDeviceLiveAttributes\(ddb, dev\.id, u\.payload\)/.test(ipc),
      'R-36j ★IPC 把 attributes 消息交 `setDeviceLiveAttributes`（解析落库一处）');
  }

  // ═══ R-37｜意图词表：只有 `home.comfort`（逐项枚举，未知意图如实拒）══════════════════════
  console.log('\n【R-37】意图词表只有 `home.comfort`');
  {
    eq(intentNames(), [HOME_COMFORT_INTENT], 'R-37a ★意图词表恰一条（逐项枚举，不用 >= 放宽）');
    eq(publicIntents().map((i) => i.id), [HOME_COMFORT_INTENT], 'R-37b 门外可见的意图清单读同一份词表');
    const feelings: ComfortFeeling[] = [...COMFORT_FEELINGS];
    eq(feelings, ['hot', 'cold', 'dark', 'bright'], 'R-37c 四种感受逐项枚举');
    const good = validateIntent({ intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'hot' } });
    ok(good.ok && good.params.room === '客厅' && good.params.feeling === 'hot',
      'R-37d 正标本：合法意图 + 合法参数 ⇒ 通过');
    for (const bad of ['home.light', 'home.comfort.v2', 'homeComfort', '']) {
      const r = validateIntent({ intent: bad, params: { room: '客厅', feeling: 'hot' } });
      const b = r.ok ? null : r.body;
      ok(b !== null && b.error === 'unknown_intent' && JSON.stringify(b.allowed) === JSON.stringify([HOME_COMFORT_INTENT]),
        `R-37e ★未知意图「${bad || '(空)'}」⇒ unknown_intent + 允许清单`, b ? JSON.stringify(b) : 'ok');
    }
    const resolve = createHomeIntentResolver(() => []);
    eq(resolve({ intent: 'home.light', params: {} }), { ok: false, reason: 'unknown_intent' },
      'R-37f ★解析器不认识的意图 ⇒ unknown_intent（不静默给空计划）');
    eq(resolve({ intent: HOME_COMFORT_INTENT, params: { room: '  ', feeling: 'hot' } }), { ok: false, reason: 'invalid_params' },
      'R-37g ★空白房间 ⇒ invalid_params（不猜"某个房间"）');
    eq(resolve({ intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'humid' } }), { ok: false, reason: 'invalid_params' },
      'R-37h ★词表外的感受 ⇒ invalid_params');
  }

  // ═══ R-38｜hot：先关窗帘、再空调 26（逐项有序 + 理由在场）════════════════════════════
  console.log('\n【R-38】`hot` 计划逐项：close 窗帘 → set_temperature 26 空调');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '客厅窗帘', kind: 'cover' });
    seedComfortDevice(db, { name: '客厅空调', kind: 'climate' });
    const plan = planHomeComfort(listDevices(ddb), '客厅', 'hot');
    ok(plan.ok, 'R-38a 正标本：同房间两件都在册且已授权 ⇒ 计划成立');
    eq(plan.ok ? plan.steps.map((s) => [s.call_name, s.action, s.args ?? null]) : [],
      [['客厅窗帘', 'close', null], ['客厅空调', 'set_temperature', { temperature: 26 }]],
      'R-38b ★★步骤逐项且有序：先关窗帘，再空调调 26');
    ok(plan.ok && plan.steps.every((s) => typeof s.reason === 'string' && s.reason.length > 0),
      'R-38c 每步都带理由（人看得懂为什么这么做）');
    ok(plan.ok && (plan.steps[1]?.reason ?? '').includes('26'), 'R-38d 调温那步的理由带目标温度');
    eq(countRows(db, 'wa_device_actions'), 0, 'R-38e ★解析期零设备动作（真正执行在共享执行器）');
  }

  // ═══ R-39｜cold：关窗帘 + 空调 24；不出现制冷模式（反证）════════════════════════════
  console.log('\n【R-39】`cold` 计划逐项：close 窗帘 + set_temperature 24；不得出现模式动词');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '客厅窗帘', kind: 'cover' });
    seedComfortDevice(db, { name: '客厅空调', kind: 'climate' });
    const plan = planHomeComfort(listDevices(ddb), '客厅', 'cold');
    eq(plan.ok ? plan.steps.map((s) => s.action) : [], ['close', 'set_temperature'],
      'R-39a ★冷 ⇒ 两步（关窗帘 + 调温）');
    eq(plan.ok ? (plan.steps.find((s) => s.action === 'set_temperature')?.args ?? {}) : {}, { temperature: 24 },
      'R-39b ★冷 ⇒ 24 度（不是热的 26）');
    ok(plan.ok && plan.steps.every((s) => s.action !== 'set_mode'),
      'R-39c ★反证：不出现 set_mode（冷/热只调温，不替用户选模式）');
    ok(COMFORT_RULES.cold.every((r) => r.action !== 'set_mode'), 'R-39d 规则表本身没有模式动词');
    ok(plan.ok && (plan.steps.find((s) => s.action === 'set_temperature')?.reason ?? '').includes('24'),
      'R-39e 理由里写的是 24（与参数同一来源）');
  }

  // ═══ R-40｜dark：只开同房间的灯（不助长空调/窗帘）════════════════════════════════
  console.log('\n【R-40】`dark` 只开灯');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '客厅窗帘', kind: 'cover' });
    seedComfortDevice(db, { name: '客厅空调', kind: 'climate' });
    seedComfortDevice(db, { name: '客厅灯', kind: 'light' });
    const plan = planHomeComfort(listDevices(ddb), '客厅', 'dark');
    eq(plan.ok ? plan.steps.map((s) => [s.call_name, s.action]) : [], [['客厅灯', 'turn_on']],
      'R-40a ★暗 ⇒ 恰一步开灯');
    ok(plan.ok && plan.steps.every((s) => s.call_name === '客厅灯'),
      'R-40b ★反证：不同时碰空调/窗帘（哪怕它们也在同房间）');
    eq(homeComfortRoleOf('light'), 'light', 'R-40c light 自述 ⇒ 灯角色');
    eq(homeComfortRoleOf('climate'), 'aircon', 'R-40d climate 自述 ⇒ 空调角色');
    eq(homeComfortRoleOf(' Cover '), 'curtain', 'R-40e cover（含空白/大小写）⇒ 窗帘角色');
    eq(homeComfortRoleOf('switch'), null, 'R-40f 认不出的 kind ⇒ null（不预设它是什么）');
  }

  // ═══ R-41｜bright：只开同房间窗帘（不开灯，反证）════════════════════════════════
  console.log('\n【R-41】`bright` 只开窗帘');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '客厅窗帘', kind: 'cover' });
    seedComfortDevice(db, { name: '客厅灯', kind: 'light' });
    const plan = planHomeComfort(listDevices(ddb), '客厅', 'bright');
    eq(plan.ok ? plan.steps.map((s) => [s.call_name, s.action]) : [], [['客厅窗帘', 'open']],
      'R-41a ★想更亮 ⇒ 恰一步开窗帘');
    ok(plan.ok && plan.steps.every((s) => s.action !== 'turn_on'), 'R-41b ★反证：不开灯');
  }

  // ═══ R-42｜房间边界：其他房间的同名设备不出现（两只标本）════════════════════════════
  console.log('\n【R-42】只纳入同房间设备（同名也按房间排除）');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '客厅窗帘', kind: 'cover' });
    seedComfortDevice(db, { name: '客厅空调', kind: 'climate' });
    seedComfortDevice(db, { name: '客厅灯', kind: 'light' });
    // 反面标本：卧室里故意摆**同名**的两件（若按名字匹配，就会多排步骤）。
    seedComfortDevice(db, { name: '客厅灯', kind: 'light', room: '卧室' });
    seedComfortDevice(db, { name: '客厅窗帘', kind: 'cover', room: '卧室' });
    eq(devicesInRoom(ddb, '卧室').length, 2, 'R-42a 反面标本在场：卧室确有两件同名列册');
    const hot = planHomeComfort(listDevices(ddb), '客厅', 'hot');
    eq(hot.ok ? hot.steps.map((s) => s.call_name) : [], ['客厅窗帘', '客厅空调'],
      'R-42b ★★其他房间的同名设备不出现');
    ok(hot.ok && hot.steps.filter((s) => s.action === 'close').length === 1,
      'R-42c 窗帘只排一次（卧室那件没被顺带纳入）');
    const dark = planHomeComfort(listDevices(ddb), '客厅', 'dark');
    eq(dark.ok ? dark.steps.length : -1, 1, 'R-42d 灯只排一盏（同名的卧室灯不进来）');
    const bedroomDark = planHomeComfort(listDevices(ddb), '卧室', 'dark');
    eq(bedroomDark.ok ? bedroomDark.steps.length : -1, 1, 'R-42e 反向：卧室里也只排它自己那一盏');
  }

  // ═══ R-43｜未授权/不可控 ⇒ skipped 带原因；零设备动作（0 起点正面断言）══════════════════
  console.log('\n【R-43】不可控设备如实进 skipped');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '客厅灯', kind: 'light' });
    seedComfortDevice(db, { name: '客厅灯二', kind: 'light', authorized: false });
    seedComfortDevice(db, { name: '客厅灯三', kind: 'light', controllable: false });
    const plan = planHomeComfort(listDevices(ddb), '客厅', 'dark');
    eq(plan.ok ? plan.steps.map((s) => s.call_name) : [], ['客厅灯'],
      'R-43a 只有过了 K-6 的那盏进计划');
    const skipped = plan.skipped ?? [];
    const byName = Object.fromEntries(skipped.map((s) => [s.call_name, s.reason]));
    eq(Object.keys(byName).sort(), ['客厅灯二', '客厅灯三'].sort(),
      'R-43b ★未授权/不可控两件都进 skipped（不静默丢）');
    ok((byName['客厅灯二'] ?? '').includes('尚未授权'), 'R-43c 未授权那件带「尚未授权」的下一步提示');
    ok((byName['客厅灯三'] ?? '').includes('可控能力'), 'R-43d 不可控那件带「不具备可控能力」的实话');
    eq(countRows(db, 'wa_device_actions'), 0, 'R-43e ★不产生设备动作行（正面断言动作数 0）');
  }

  // ═══ R-44｜房间内无可控设备 ⇒ no_controllable_device；不生成空计划 ═════════════════════
  console.log('\n【R-44】无可控设备时如实说不，不造空计划');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '卧室灯', kind: 'light', room: '卧室' });
    const empty = planHomeComfort(listDevices(ddb), '书房', 'hot');
    eq(empty, { ok: false, reason: 'no_controllable_device' }, 'R-44a ★房间里一台设备都没有 ⇒ 如实拒');
    ok(!('steps' in empty), 'R-44b ★不生成空计划（回包里没有 steps 键）');
    seedComfortDevice(db, { name: '书房灯', kind: 'light', room: '书房', authorized: false });
    const blocked = planHomeComfort(listDevices(ddb), '书房', 'dark');
    ok(!blocked.ok && blocked.reason === 'no_controllable_device' && (blocked.skipped ?? []).length === 1,
      'R-44c 同房间有设备但无一可控 ⇒ 仍不成立，且被略过的那件带原因');
    // 真跑工具：同一标本经 `device_intent` 走一遍，账上不得多出计划/动作。
    const t = makeComfortTransport();
    const tools = deviceTools({ db, taskId: '', controlDevice: t.transport } as unknown as ToolDeps);
    const out = JSON.parse(await tools.device_intent.execute({ room: '书房', feeling: 'dark' })) as Record<string, unknown>;
    eq([out.ok, out.error], [false, 'no_controllable_device'], 'R-44d ★工具回包如实：ok=false + 机器可读原因');
    eq((out.skipped as Array<{ call_name: string }>).map((s) => s.call_name), ['书房灯'],
      'R-44e 被略过的设备在工具回包里照实列名');
    eq(countRows(db, 'wa_intent_plans'), 0, 'R-44f ★不生成空计划（计划账 0 行）');
    eq(countRows(db, 'wa_device_actions'), 0, 'R-44g 零设备动作');
    eq(t.calls.length, 0, 'R-44h 传动 0 次');
    const ipc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    const previewSlice = ipc.slice(ipc.indexOf("'devices:intent_preview'"), ipc.indexOf("'devices:intent_execute'"));
    ok(previewSlice.includes('planHomeComfort(') && !previewSlice.includes('runDeviceControl('),
      'R-44i ★预览走 `planHomeComfort`（解析），不直接调控制编排');
    ok(previewSlice.includes("code: 'NO_CONTROLLABLE_DEVICE'"), 'R-44j ★面板预览对"没有可做的"如实回专用错误码');
  }

  // ═══ R-45｜执行仍过 K-6：预览后取消授权 ⇒ denied 动作行 0→1 ═══════════════════════════
  console.log('\n【R-45】执行不过第二次闸就被绕过——认领后仍问 K-6');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    const lamp = seedComfortDevice(db, { name: '客厅灯', kind: 'light' });
    const plan = planHomeComfort(listDevices(ddb), '客厅', 'dark');
    ok(plan.ok, 'R-45a 前置：计划成立');
    const created = createIntentPlan(db as unknown as IntentPlanDb, {
      terminalId: 'panel', capability: INTENT_CAPABILITY,
      params: { room: '客厅', feeling: 'dark' },
      steps: plan.ok ? plan.steps : [], skipped: plan.ok ? plan.skipped : [],
    });
    eq(countRows(db, 'wa_device_actions'), 0, 'R-45b 落计划本身零设备动作');
    setDeviceAuthorized(ddb, lamp.id, false);
    const t = makeComfortTransport();
    const exec = await executeDeviceIntentPlan(ddb, created.id, { actor: { kind: 'panel' }, transport: t.transport });
    eq(exec, { ok: true, status: 'failed', steps: [{ call_name: '客厅灯', action: 'turn_on', ok: false, error: 'not_authorized' }] },
      'R-45c ★★认领的是固定计划，但执行仍过 K-6 ⇒ 原计划那步如实 denied');
    eq(t.calls.length, 0, 'R-45d 未授权 ⇒ 一步都不真发（传动 0 次）');
    eq(countRows(db, 'wa_device_actions'), 1, 'R-45e ★denied 动作行 0→1（正面断言）');
    const rows = listDeviceActions(ddb);
    eq(rows[0]?.result, 'denied', 'R-45f 动作结果记 denied（不是 error）');
    eq(rows[0]?.plan_id, created.id, 'R-45g ★动作行挂回本计划 id（账 ⇄ 计划一一对应）');
    eq(rows[0]?.actor_kind, 'panel', 'R-45h 发起者按面板路记');
    eq(getIntentPlan(db as unknown as IntentPlanDb, created.id)?.status, 'failed', 'R-45i 计划如实收口为 failed');
    const ipc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    const execSlice = ipc.slice(ipc.indexOf("'devices:intent_execute'"));
    const gateAt = execSlice.indexOf('teamFeatureRefusal(');
    const runAt = execSlice.indexOf('executeDeviceIntentPlan(');
    ok(gateAt >= 0 && runAt > gateAt, 'R-45j ★Team 闸先于执行（先拦档位，再认领计划）');
    ok(/existing\.terminal_id !== 'panel'/.test(execSlice), 'R-45k ★认主：面板只能执行自己那本计划');
    const page = RD(`${A}/renderer/src/pages/DevicesPage.tsx`);
    ok(page.includes('function IntentComfortBlock(') && page.includes('devicesApi.intentPreview(') && page.includes('devicesApi.intentExecute('),
      'R-45l ★面板两跳真接上（预览 → 用户点执行）');
    const rIpc = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(/intentPreview:\s*\(room: string, feeling: string\)/.test(rIpc), 'R-45m renderer 侧预览签名在册');
    ok(/intentExecute:\s*\(planId: string\)/.test(rIpc), 'R-45n renderer 侧执行签名在册（只交计划 id，不重规划）');
  }

  // ═══ R-46｜档位：社区/Pro 拒、试用/Team 放（两只标本 + 真工具运行时）════════════════════
  console.log('\n【R-46】`device_intent` 照旧过 Team 闸');
  {
    // ── 真工具运行时：社区档 ⇒ 如实拒；账/动作/传动全 0（若漏闸，这台窗帘会被真执行）。 ──
    const community = makeComfortDb({ trial: false });
    seedComfortDevice(community, { name: '客厅窗帘', kind: 'cover' });
    const ct = makeComfortTransport();
    const ctools = deviceTools({ db: community, taskId: '', controlDevice: ct.transport } as unknown as ToolDeps);
    const cout = JSON.parse(await ctools.device_intent.execute({ room: '客厅', feeling: 'hot' })) as Record<string, unknown>;
    eq([cout.ok, cout.denied, cout.reason], [false, true, 'team_required'],
      'R-46a ★★社区档调 device_intent ⇒ 如实拒（denied + team_required）');
    ok(typeof cout.how_to_authorize === 'string' && cout.how_to_authorize.includes(TIER_LABEL.team),
      'R-46b 拒因带可行动的下一步（指向团队版）');
    eq(countRows(community, 'wa_intent_plans'), 0, 'R-46c ★被拒时零计划');
    eq(countRows(community, 'wa_device_actions'), 0, 'R-46d ★被拒时零动作行');
    eq(ct.calls.length, 0, 'R-46e ★被拒时传动 0 次');

    // ── 真工具运行时：试用期（tier 落 pro、kind=trial）⇒ 放行并真执行。 ──
    const trial = makeComfortDb();
    seedComfortDevice(trial, { name: '客厅窗帘', kind: 'cover' });
    const tt = makeComfortTransport();
    const ttools = deviceTools({ db: trial, taskId: '', controlDevice: tt.transport } as unknown as ToolDeps);
    const tout = JSON.parse(await ttools.device_intent.execute({ room: '客厅', feeling: 'hot' })) as Record<string, unknown>;
    eq([tout.ok, tout.status], [true, 'executed'], 'R-46f ★试用期放行（试用的 tier 是 pro，须按 kind 特判）');
    eq(tt.calls, [{ device: '客厅窗帘', action: 'close' }], 'R-46g 放行后真发一步');
    eq(countRows(trial, 'wa_device_actions'), 1, 'R-46h 动作行 0→1');
    eq(getIntentPlan(trial as unknown as IntentPlanDb, String(tout.planId))?.terminal_id, 'local:chat',
      'R-46i 聊天路的计划 owner 如实（local:chat）');

    // ── 档位软闸本体：pro/team 两只标本（注入测试公钥，不依赖真密钥）。 ──
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const licensedDb = (tier: 'pro' | 'team'): DatabaseSync => {
      const d = makeComfortDb({ trial: false });
      const payload: LicensePayload = {
        v: 1, tier, subject: 'rr@local', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, devices: [],
      };
      d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(LICENSE_SETTING_KEYS.key, encodeLicense(payload, privatePem));
      return d;
    };
    eq(resolveTeamGate(community as unknown as LicenseSettingDb).unlocked, false, 'R-46j 无许可无试用 ⇒ 社区档锁定');
    const pro = licensedDb('pro');
    const proGate = resolveTeamGate(pro as unknown as LicenseSettingDb, { publicKeyPem: publicPem });
    eq([proGate.tier, proGate.unlocked], ['pro', false], 'R-46k ★Pro 档仍锁（团队版能力不因专业版放开）');
    const proRefusal = teamFeatureRefusal(pro as unknown as LicenseSettingDb, 'device_control', { publicKeyPem: publicPem });
    ok(typeof proRefusal === 'string' && proRefusal.includes(TIER_LABEL.pro),
      'R-46l ★Pro 档拒因如实写出当前档位');
    const team = licensedDb('team');
    eq(resolveTeamGate(team as unknown as LicenseSettingDb, { publicKeyPem: publicPem }).unlocked, true, 'R-46m ★Team 档放行');
    eq(teamFeatureRefusal(team as unknown as LicenseSettingDb, 'device_control', { publicKeyPem: publicPem }), null,
      'R-46n Team 档无拒因');
    eq(countOcc(CODE(`${A}/src/main/core/tools/device.ts`), "teamFeatureRefusal(licDb, 'device_control')"), 2,
      'R-46o ★两个设备工具入口各过同一道闸（device_control + device_intent）');
  }

  // ═══ R-47｜工具面：进 device 类目；对话形态不被误放行（反证）════════════════════════
  console.log('\n【R-47】`device_intent` 在 device 类目；对话形态仍只给四类底线');
  {
    const meta = toolRegistry.getMeta('device_intent');
    eq(meta ? [meta.category, meta.isReadOnly, meta.permissionLevel] : null, ['device', false, 'normal'],
      'R-47a ★注册在 device 类目、有副作用、无需审批');
    const devNames = TOOL_METAS.filter((m) => m.category === 'device').map((m) => m.name);
    eq(devNames, ['list_devices', 'device_status', 'device_control', 'device_intent'],
      'R-47b ★device 类目逐项枚举（新增一件不改类目语义）');
    eq([...ARCHETYPE_TOOL_CATEGORIES.conversation], ['readonly', 'control', 'resource', 'device'],
      'R-47c ★对话形态仍是四类底线（device 自 zx_20261014_2 起即底线）');
    const face = narrowToolFace('conversation', {
      device_intent: {}, device_control: {}, view_image: {}, write_file: {}, execute_command: {},
    });
    eq(face.kept, ['device_intent', 'device_control'], 'R-47d ★kept 恰设备两件（新增工具随类目一起可达）');
    eq(face.removed, ['view_image', 'write_file', 'execute_command'],
      'R-47e ★反证：media/write/shell 仍被收窄掉（新增工具没有把档外一起放进来）');
    ok(!ARCHETYPE_TOOL_CATEGORIES.conversation.includes('media'), 'R-47f 对话形态不含 media（收窄面未被改宽）');
  }

  // ═══ R-48｜部分失败：第 1 步 ok、第 2 步 error ⇒ 两行如实，不回滚 ═════════════════════
  console.log('\n【R-48】部分失败如实逐行记，不回滚成功那步');
  {
    const db = makeComfortDb();
    const ddb = db as unknown as DeviceDb;
    seedComfortDevice(db, { name: '客厅窗帘', kind: 'cover' });
    seedComfortDevice(db, { name: '客厅空调', kind: 'climate' });
    const plan = planHomeComfort(listDevices(ddb), '客厅', 'hot');
    ok(plan.ok && plan.steps.length === 2, 'R-48a 前置：hot 两步计划');
    const created = createIntentPlan(db as unknown as IntentPlanDb, {
      terminalId: 'panel', capability: INTENT_CAPABILITY,
      params: { room: '客厅', feeling: 'hot' },
      steps: plan.ok ? plan.steps : [], skipped: plan.ok ? plan.skipped : [],
    });
    const t = makeComfortTransport((_dev, action) =>
      action === 'close' ? { ok: true, result: '客厅窗帘 ok' } : { ok: false, result: '空调无响应' });
    const exec = await executeDeviceIntentPlan(ddb, created.id, { actor: { kind: 'panel' }, transport: t.transport });
    eq(exec, {
      ok: true, status: 'failed',
      steps: [
        { call_name: '客厅窗帘', action: 'close', ok: true, result: '客厅窗帘 ok' },
        { call_name: '客厅空调', action: 'set_temperature', ok: false, error: '空调无响应' },
      ],
    }, 'R-48b ★★返回逐步结果两行（成/败各一，失败原因取传动原话）');
    eq(t.calls, [{ device: '客厅窗帘', action: 'close' }, { device: '客厅空调', action: 'set_temperature' }],
      'R-48c 两步都真发过（第 2 步失败不阻止收口）');
    eq(countRows(db, 'wa_device_actions'), 2, 'R-48d ★设备动作两行（成/败各一）');
    eq(listDeviceActions(ddb).map((r) => [r.action, r.result]).sort(),
      [['close', 'ok'], ['set_temperature', 'error']], 'R-48e ★动作账如实记成/败');
    ok(listDeviceActions(ddb).every((r) => r.plan_id === created.id), 'R-48f ★两行动作都挂同一计划 id');
    const row = getIntentPlan(db as unknown as IntentPlanDb, created.id);
    eq(row?.status, 'failed', 'R-48g 计划如实收口为 failed（不冒充 executed）');
    eq(row ? (JSON.parse(row.result_json) as { steps: unknown[] }).steps.length : -1, 2,
      'R-48h 计划结果里两步都在（失败不吞前一步的记录）');
  }

  // ═══ R-49｜25 分钟 ⇒ 按 600 秒切 3 段（假 io 记录 argv 与段数）══════════════════════
  console.log('\n【R-49】25 分钟音频 ⇒ 600 秒/段切出 3 段');
  const audioTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr18-audio-'));
  const audioSrc = path.join(audioTmp, 'meeting.m4a');
  fs.writeFileSync(audioSrc, Buffer.from('fake-m4a-bytes'));
  const audioDir = path.join(audioTmp, 'segments');
  try {
    {
      const { io, runs, created } = makeFakeAudioIo({ durationSec: 25 * 60 });
      const { deps } = longAudioDeps((n) => ({ ok: true, text: `第${n}段文字` }));
      eq(await probeMediaDurationSec(audioSrc, io), 25 * 60,
        'R-49a ★时长由 ffmpeg 的 `Duration:` 行读出（不对文件名/体积猜）');
      const r = await transcribeLongAudio(audioSrc, audioDir, deps, io);
      ok(r.ok === true && r.segments === 3, 'R-49b ★25 分钟 ⇒ 3 段（600 秒/段）',
        r.ok ? `segments=${r.segments}` : r.reason);
      const segArgs = runs.find((a) => a.includes('-segment_time')) ?? [];
      const fIdx = segArgs.indexOf('-f');
      const tIdx = segArgs.indexOf('-segment_time');
      ok(fIdx >= 0 && segArgs[fIdx + 1] === 'segment'
        && tIdx >= 0 && segArgs[tIdx + 1] === String(LONG_SEGMENT_SECONDS),
        'R-49c ★切段 argv 是 `-f segment -segment_time 600`（值由常量派生）',
        segArgs.length ? segArgs.join(' ') : '(没跑切段)');
      eq(created.length, 3, 'R-49d ★真写出 3 个段文件（段数是数出来的）');
      eq(fs.readdirSync(audioDir), [],
        'R-53 ★结束后临时段文件清零（正面断言：目录文件数 0，不是"没抛"）');
    }

    // ═══ R-50｜逐段顺序转写并合并，输出含 10 分钟边界标记 ═══════════════════════════════
    console.log('\n【R-50】段边界标记 [00:00]/[10:00]/[20:00]');
    {
      const { io } = makeFakeAudioIo({ durationSec: 25 * 60 });
      const { deps } = longAudioDeps((n) => ({ ok: true, text: `第${n}段文字` }));
      const r = await transcribeLongAudio(audioSrc, audioDir, deps, io);
      const lines = r.ok ? r.text.split('\n') : [];
      eq(lines.map((l) => l.slice(0, 7)), ['[00:00]', '[10:00]', '[20:00]'],
        'R-50a ★三段按 10 分钟边界标记合并（逐项，不是"含某个标记"）');
      eq(lines.map((l) => l.replace(/^\[[^\]]+\]\s*/, '')), ['第1段文字', '第2段文字', '第3段文字'],
        'R-50b ★段序不乱：逐段顺序转写，文字与边界一一对上');
    }

    // ═══ R-51｜第 2 段失败 ⇒ 如实报，不把前 1 段冒充全文 ═════════════════════════════
    console.log('\n【R-51】第 2 段失败 ⇒ 如实报「第 2 段失败」');
    {
      const { io, created } = makeFakeAudioIo({ durationSec: 25 * 60 });
      const { deps, chatCalls } = longAudioDeps((n) =>
        n === 2 ? { ok: false, detail: 'seg2-broken' } : { ok: true, text: `第${n}段文字` });
      const r = await transcribeLongAudio(audioSrc, audioDir, deps, io);
      ok(r.ok === false && r.reason === 'segment_failed'
        && String(r.detail).includes('第 2 段') && String(r.detail).includes('seg2-broken'),
        'R-51a ★第 2 段失败 ⇒ 点名"第 2 段"并带段内真错因（不挤成一句"转写失败"）',
        r.ok ? '(居然成功了)' : String(r.detail));
      ok(!('text' in r), 'R-51b ★不把前 1 段冒充全文成功（失败结果里没有 text）');
      eq(chatCalls(), 2, 'R-51c 第 2 段失败即停（不继续往后转写）');
      ok(created.every((p) => !fs.existsSync(p)), 'R-51d ★失败也把段文件清干净（不留半成品）');
    }

    // ═══ R-52｜短音频仍走单次转写；超限自动走长路径（两只标本）════════════════════════
    console.log('\n【R-52】5 分钟仍走单次转写；超限自动分段');
    {
      const srv = await audioHttpStub('SHORT-TRANSCRIPT');
      try {
        const shortSrc = path.join(audioTmp, 'short.mp3');
        fs.writeFileSync(shortSrc, Buffer.from('fake-mp3-bytes'));
        const shortIo = makeFakeAudioIo({ durationSec: 5 * 60, normalizedSize: 5 * 60 * WAV_BYTES_PER_SEC });
        const tr = makeAudioTranscriber(
          { getOptimalModel: async () => ({ url: srv.url, api_key: 'k', model_name: 'm1' }) },
          path.join(audioTmp, 'short-dst'),
          shortIo.io,
        );
        const r = await tr(shortSrc);
        eq(r, { ok: true, text: 'SHORT-TRANSCRIPT' },
          'R-52a ★5 分钟音频仍走单次转写（正文逐字＝模型原文，无边界标记）');
        eq(srv.hits(), 1, 'R-52b ★短路径转写调用恰 1 次');
        eq(shortIo.runs.filter((a) => a.includes('-segment_time')).length, 0,
          'R-52c ★短路径不触长路径（切段调用 0 次）');
      } finally {
        await srv.close();
      }
    }
    {
      const srv = await audioHttpStub('LONG-TRANSCRIPT');
      try {
        const longSrc = path.join(audioTmp, 'long.m4a');
        fs.writeFileSync(longSrc, Buffer.from('fake-long-m4a'));
        const longIo = makeFakeAudioIo({
          durationSec: 25 * 60,
          normalizedSize: MAX_AUDIO_SECONDS * WAV_BYTES_PER_SEC,
        });
        const tr = makeAudioTranscriber(
          { getOptimalModel: async () => ({ url: srv.url, api_key: 'k', model_name: 'm1' }) },
          path.join(audioTmp, 'long-dst'),
          longIo.io,
        );
        const r = await tr(longSrc);
        const lines = r.ok ? r.text.split('\n') : [];
        ok(r.ok === true && lines.length === 3
          && lines.every((l) => l.endsWith('LONG-TRANSCRIPT'))
          && lines[0]!.startsWith('[00:00]') && lines[1]!.startsWith('[10:00]') && lines[2]!.startsWith('[20:00]'),
          'R-52d ★超单段上限自动走长路径（归一化产物抵到上限 ⇒ 切段转写，三段齐全）',
          r.ok ? `${lines.length} 行` : r.reason);
        eq(srv.hits(), 3, 'R-52e ★长路径逐段转写 3 次（不是把前 13 分钟转一次了事）');
      } finally {
        await srv.close();
      }
    }

    // ═══ R-54｜超过 3 小时 ⇒ 如实拒并给上限（不无限切段吃盘）════════════════════════
    console.log('\n【R-54】超过 3 小时 ⇒ 如实拒');
    {
      const { io, runs, created } = makeFakeAudioIo({ durationSec: 4 * 60 * 60 });
      const { deps } = longAudioDeps(() => ({ ok: true, text: '不该被调用' }));
      const r = await transcribeLongAudio(audioSrc, path.join(audioTmp, 'too-long'), deps, io);
      ok(r.ok === false && r.reason === 'audio_too_long'
        && String(r.detail).includes('3 小时') && String(r.detail).includes('上限'),
        'R-54a ★超 3 小时 ⇒ 如实拒并写明上限', r.ok ? '(居然成功了)' : String(r.detail));
      eq(runs.filter((a) => a.includes('-segment_time')).length, 0,
        'R-54b ★拒在切段之前（不无限切段吃盘）');
      eq(created.length, 0, 'R-54c 一个段文件都没写');
    }
  } finally {
    fs.rmSync(audioTmp, { recursive: true, force: true });
  }

  // ═══ R-55｜七源分账之和 = 总量估算（整数、无负数；未知源记 0）════════════════════════
  console.log('\n【R-55】七源分账：逐项 token 之和 = 总量（同一把尺，不二次取整）');
  {
    eq([...TOKEN_SOURCES], ['system', 'memory', 'knowledge', 'history', 'tools', 'user', 'output'],
      'R-55a ★七源词表逐项枚举（顺序即报表顺序）');
    const chars = { system: 401, memory: 99, knowledge: 0, history: 12345, tools: 77, user: 5, output: 3 };
    const l = ledgerFromChars({ ...chars, foreign_source: 999 });
    eq(l.chars, chars, 'R-55b ★每源字符数原样落账（表外键 `foreign_source` 不混进分账）');
    eq(['foreign_source' in l.chars, 'foreign_source' in l.tokens], [false, false],
      'R-55c ★未知源不参与总和（分账只有七源，和数才对得上）');
    eq(TOKEN_SOURCES.map((s) => l.tokens[s]), TOKEN_SOURCES.map((s) => estimateTokensFromChars(chars[s])),
      'R-55d ★每源 token 由 `estimateTokensFromChars` 派生（值与尺同源，不手抄 ÷4）');
    eq(l.totalChars, Object.values(chars).reduce((a, b) => a + b, 0), 'R-55e 总量字符 = 七源逐项相加');
    eq(l.totalTokens, TOKEN_SOURCES.reduce((n, s) => n + l.tokens[s], 0),
      'R-55f ★★分账之和 = 总量估算（逐项取整后相加，不是总量再除一次）');
    ok(TOKEN_SOURCES.every((s) => Number.isInteger(l.tokens[s]) && Number.isInteger(l.chars[s]) && l.tokens[s] >= 0 && l.chars[s] >= 0),
      'R-55g 七源字符/token 全为非负整数（账里不出现负值）');
    const weird = ledgerFromChars({ system: -5, memory: Number.NaN, knowledge: 2.7, history: Number.POSITIVE_INFINITY });
    eq(weird.chars, { ...emptyTokenChars(), knowledge: 2 }, 'R-55h ★负数/NaN/Infinity 归 0、小数向下取整（不让脏输入污染账）');
    const withOut = withSourceChars(l, 'output', 40);
    eq([withOut.chars.output, withOut.chars.system, withOut.totalTokens],
      [40, 401, l.totalTokens - l.tokens.output + estimateTokensFromChars(40)],
      'R-55i 收口补 output 只换一源，其余六源与总量同步重算');
  }

  // ═══ R-56｜超预算按 knowledge→memory→history 裁；user/acceptance/system 一字不裁 ══════
  console.log('\n【R-56】裁剪只动三源，顺序 knowledge → memory → history；其余一个字符都不裁');
  {
    eq([...CONTEXT_TRIM_ORDER], ['knowledge', 'memory', 'history'], 'R-56a ★裁剪顺序唯一真源逐项枚举');
    eq([...CONTEXT_NEVER_TRIM], ['user', 'acceptance', 'system', 'tools', 'output'],
      'R-56b ★永不裁名单逐项枚举（离开名单即等于改任务本身）');

    // 标本一：每源 4000 字符（≈1000 token），总预算 3000 ⇒ 超 2025 token。
    const chars = { system: 4000, memory: 4000, knowledge: 4000, history: 4000, tools: 4000, user: 100, output: 0 };
    const over = applyContextBudget({ chars, budgetTokens: 3000 });
    eq(over.overBefore, true, 'R-56c 标本一：起算即超预算（overBefore）');
    eq([over.chars.system, over.chars.tools, over.chars.user, over.chars.output], [4000, 4000, 100, 0],
      'R-56d ★★system/tools/user/output 一个字符都没裁');
    eq([over.trimmedChars.system, over.trimmedChars.tools, over.trimmedChars.user, over.trimmedChars.output],
      [0, 0, 0, 0],
      'R-56e ★★永不裁名单的 trimmedChars 全 0（两只账一致）');
    ok(over.trimmedChars.knowledge > 0 && over.trimmedChars.memory > 0 && over.trimmedChars.history > 0,
      'R-56f ★三源按序都动过（知识先见底，再记忆，再历史）',
      JSON.stringify(over.trimmedChars));
    eq([over.chars.knowledge, over.chars.memory], [0, 4000 - over.trimmedChars.memory],
      'R-56g ★★知识先被裁空、记忆只裁差额（顺序即优先级）');
    eq(over.overAfter, false, 'R-56h 标本一裁完达标（overAfter=false，如实）');

    // 标本二：同一组字符，预算足够 ⇒ 一字不裁（反证：不是"凡调用必裁"）。
    const fits = applyContextBudget({ chars, budgetTokens: 6000 });
    eq(fits.trimmedChars, emptyTokenChars(), 'R-56i ★标本二：预算足够 ⇒ 七源 trimmedChars 全 0（反证）');
    eq(fits.chars, { ...emptyTokenChars(), ...chars }, 'R-56j 标本二原样返回（没超就不动）');
    eq([fits.overBefore, fits.overAfter], [false, false], 'R-56k 标本二两只旗都 false');
  }

  // ═══ R-57｜每源被裁字符数落账；裁剪后估算总量 ≤ 预算（正面断言）════════════════════
  console.log('\n【R-57】裁剪账逐源记录；裁后总量正面断言 ≤ 预算');
  {
    // 知识 400 字(100 token) + 记忆 400 字 + 历史 400 字 + 系统 100 字(25 token) = 325 token；
    // 预算 200 ⇒ 需减 125 token ⇒ 知识先整源裁空(100)，再记忆裁差额(25)。
    const part = applyContextBudget({
      chars: { system: 100, memory: 400, knowledge: 400, history: 400, tools: 0, user: 0, output: 0 },
      budgetTokens: 200,
    });
    eq(part.trimmedChars.knowledge, 400, 'R-57a ★知识先整源裁空（400 字 = 100 token）');
    eq(part.trimmedChars.memory, 100, 'R-57b ★记忆只裁差额 100 字（400-100=300 字留上下文）');
    eq(part.trimmedChars.history, 0, 'R-57c 历史没动（前两源已够减）');
    eq(part.chars.knowledge, 0, 'R-57d 知识源裁后为 0');
    eq(part.chars.memory, 300, 'R-57e 记忆源如实剩下 300 字');
    ok(part.totalTokensAfter <= part.budgetTokens, 'R-57f ★★裁剪后估算总量 ≤ 预算（正面断言）',
      `${part.totalTokensAfter} ≤ ${part.budgetTokens}`);
    eq(part.totalTokensBefore, 325, 'R-57g 裁前总量 = 七源逐项之和（25+100+100+100）');
    eq(part.trimmedTokens.knowledge, 100, 'R-57h 裁剪 token 与字符同一把尺（400 字 ≈ 100 token）');
    // 见底仍超：不可裁的源本身即超 ⇒ 如实返回 overAfter，不谎报达标。
    const hopeless = applyContextBudget({
      chars: { system: 8000, memory: 0, knowledge: 0, history: 0, tools: 0, user: 0, output: 0 },
      budgetTokens: 100,
    });
    eq([hopeless.trimmedChars.system, hopeless.overAfter], [0, true],
      'R-57i ★不可裁源自身超预算 ⇒ 不裁它、如实报 overAfter=true（不凑数）');
  }

  // ═══ R-58｜execution_metrics.token_breakdown 存在且七源齐备（0→1）══════════════════
  console.log('\n【R-58】唯一写口：token_breakdown 七源齐备、合并保留兄弟键');
  {
    const db = makeLedgerDb();
    const ledger = ledgerFromChars({ system: 100, memory: 200, knowledge: 30, history: 400, tools: 50, user: 60, output: 80 });
    // 生产形状：agent-executor 在进入收口前恒先写 `ctxJson.cost_estimate`（含 tokens/currency），
    //   exec-close 的 reconcile 读的正是这份——夹具照搬，否则并账分支恒不命中（假绿）。
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES ('t-metrics', 'p1', '指标', ?)`)
      .run(JSON.stringify({
        keep_me: 1,
        execution_metrics: { old_key: 'kept' },
        cost_estimate: { currency: 'CNY', tokens: ledger.totalTokens, inputTokens: 100, outputTokens: 50 },
      }));
    const before = (db.prepare("SELECT context_json FROM wa_tasks WHERE id = 't-metrics'").get() as { context_json: string }).context_json;
    eq((JSON.parse(before) as { execution_metrics?: unknown }).execution_metrics,
      { old_key: 'kept' }, 'R-58a 起跑：metrics 无 token_breakdown（0 基准）');
    writeExecutionMetrics(db, 't-metrics', {
      archetype: 'code', stepsUsed: 3, totalTokens: ledger.totalTokens, hasDeliverable: true,
      tokenBreakdown: {
        ...ledger,
        trimmedChars: { ...emptyTokenChars(), knowledge: 12 },
        budgetTokens: 50000,
        overBudget: false,
      },
    });
    const ctx = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id = 't-metrics'").get() as { context_json: string }).context_json) as {
      keep_me?: number;
      execution_metrics?: {
        old_key?: string; archetype?: string; stepsUsed?: number; totalTokens?: number; hasDeliverable?: boolean;
        token_breakdown?: { chars?: Record<string, number>; tokens?: Record<string, number>; totalTokens?: number; trimmedChars?: Record<string, number>; budgetTokens?: number; overBudget?: boolean };
      };
    };
    const tb = ctx.execution_metrics?.token_breakdown;
    ok(!!tb, 'R-58b ★★0→1：执行收口后 metrics.token_breakdown 存在');
    eq(tb ? Object.keys(tb.chars ?? {}).sort() : [], [...TOKEN_SOURCES].sort(),
      'R-58c ★七源齐备（chars 逐源枚举）');
    eq(tb ? Object.keys(tb.tokens ?? {}).sort() : [], [...TOKEN_SOURCES].sort(),
      'R-58d ★七源齐备（tokens 逐源枚举）');
    eq(tb ? TOKEN_SOURCES.reduce((n, s) => n + (tb.tokens?.[s] ?? 0), 0) : -1, tb?.totalTokens,
      'R-58e ★分账之和仍 = totalTokens（落库后同一把尺）');
    eq([ctx.keep_me, ctx.execution_metrics?.old_key], [1, 'kept'],
      'R-58f ★★合并写：未知兄弟键与旧 metrics 键都保留（不裸对象覆写 context_json）');
    eq([ctx.execution_metrics?.archetype, ctx.execution_metrics?.stepsUsed, ctx.execution_metrics?.hasDeliverable],
      ['code', 3, true], 'R-58g metrics 其余三键与 token_breakdown 同一次写入');
    eq(tb?.trimmedChars?.knowledge, 12, 'R-58h 裁剪字符数随账落库');
    // 并账：sideNow > sideAtFirstPersist 时 totalTokens 与 cost_estimate 同步改（同一处两个键）。
    const rec = reconcileExecutionTokens(db, 't-metrics', { fallbackTotal: ledger.totalTokens, sideNow: 500, sideAtFirstPersist: 200 });
    const after = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id = 't-metrics'").get() as { context_json: string }).context_json) as {
      execution_metrics?: { totalTokens?: number }; cost_estimate?: { tokens?: number; sideTokens?: number; currency?: string };
    };
    eq([rec.changed, after.execution_metrics?.totalTokens, after.cost_estimate?.tokens],
      [true, ledger.totalTokens + 300, ledger.totalTokens + 300],
      'R-58i ★旁路并账同一次写 metrics 与 cost_estimate（不再两段各改一半）');
    eq([after.cost_estimate?.sideTokens, after.cost_estimate?.currency], [500, 'CNY'],
      'R-58i2 并账只改 tokens/sideTokens，cost_estimate 其余键（currency）原样保留');

    const execCode = CODE(`${A}/src/main/core/agent-executor.ts`);
    eq(countOcc(execCode, 'writeExecutionMetrics(db, taskId'), 3,
      'R-58j ★★三个收口出口都走唯一写口（finalize_completed / finalize_paused / run_close 逐项在册）');
    eq(countOcc(execCode, 'tokenBreakdown: ctxTokenBreakdown()'), 3,
      'R-58k ★三个出口都带八源账（七源 + output 收口补齐）');
    eq(countOcc(execCode, 'recordContextInjections(taskId'), 1,
      'R-58l 注入账在装配后记一次（不重复记账）');
    eq(countOcc(CODE(`${A}/src/main/core/exec-close.ts`), 'reconcileExecutionTokens(db, taskId'), 1,
      'R-58m 旁路并账也收进唯一写口（exec-close 只调不抄）');
  }

  // ═══ R-59｜注入记忆产生行（source=memory，ref_id=记忆 id，0→1）══════════════════════
  console.log('\n【R-59】记忆注入 0→1：行带记忆 id 与字符/token');
  {
    const db = makeLedgerDb();
    const mm = new MemoryManager(db as never, null as never);
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title) VALUES ('t-mem', 'p1', '记忆注入')`).run();
    db.prepare(`INSERT INTO wa_memories (id, project_id, content, memory_type) VALUES ('m-long', 'p1', ?, 'procedural')`)
      .run('记'.repeat(400));
    eq(countRows(db, 'wa_context_injections'), 0, 'R-59a 起跑：注入账 0 行');
    const n = mm.recordContextInjections('t-mem', { memoryIds: ['m-long'] });
    eq(n, 1, 'R-59b ★★0→1：写入恰 1 行（返回新写入行数）');
    const row = db.prepare('SELECT source, ref_id, chars, est_tokens, outcome FROM wa_context_injections WHERE task_id = ?')
      .get('t-mem') as { source: string; ref_id: string; chars: number; est_tokens: number; outcome: string };
    eq([row.source, row.ref_id, row.outcome], ['memory', 'm-long', 'pending'],
      'R-59c ★行认得出是哪个记忆（source=memory、ref_id=记忆 id、结局待定）');
    eq([row.chars, row.est_tokens], [300, estimateTokensFromChars(300)],
      'R-59d 字符取正文长度且单条封顶 300；token 走同一把尺');
  }

  // ═══ R-60｜注入知识包分节产生行（source=knowledge，ref_id=节名，逐节 0→1）════════════
  console.log('\n【R-60】知识注入逐节 0→1：ref_id 是节名');
  {
    const db = makeLedgerDb();
    const mm = new MemoryManager(db as never, null as never);
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title) VALUES ('t-know', 'p1', '知识注入')`).run();
    const n = mm.recordContextInjections('t-know', {
      knowledge: [{ ref_id: 'entities', chars: 120 }, { ref_id: 'services', chars: 80 }],
    });
    eq(n, 2, 'R-60a ★★0→1：两节 ⇒ 两行（逐节记账，不合并成一行）');
    const rows = db.prepare('SELECT source, ref_id, chars, est_tokens FROM wa_context_injections WHERE task_id = ? ORDER BY ref_id')
      .all('t-know') as Array<{ source: string; ref_id: string; chars: number; est_tokens: number }>;
    eq(rows.map((r) => [r.source, r.ref_id]), [['knowledge', 'entities'], ['knowledge', 'services']],
      'R-60b ★source=knowledge、ref_id=节名（逐节可归因）');
    eq(rows.map((r) => [r.chars, r.est_tokens]),
      [[120, estimateTokensFromChars(120)], [80, estimateTokensFromChars(80)]],
      'R-60c 每节的字符/token 与注入量一致');
    eq(rows.map((r) => r.est_tokens).reduce((a, b) => a + b, 0), estimateTokensFromChars(120) + estimateTokensFromChars(80),
      'R-60d 分节 token 之和 = 两节各自估算之和（不二次取整）');
  }

  // ═══ R-61｜完成 ⇒ pending→completed；失败 ⇒ failed（两只标本，含只注入知识）════════
  console.log('\n【R-61】结局回填：完成/失败两只标本；只注入知识的任务也回填');
  {
    const db = makeLedgerDb();
    const mm = new MemoryManager(db as never, null as never);
    // 成功标本：知识 only（usedIds 为空也必须回填——旧实现在早退点前漏了这一步）。
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES ('t-ok', 'p1', '成功', '{}')`).run();
    // 失败标本：记忆注入 + per-run 使用证据。
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES ('t-bad', 'p1', '失败', ?)`)
      .run(JSON.stringify({ memory_used_ids_run: ['m-bad'] }));
    db.prepare(`INSERT INTO wa_memories (id, project_id, content, memory_type) VALUES ('m-bad', 'p1', '一条失败经验', 'procedural')`).run();
    mm.recordContextInjections('t-ok', { knowledge: [{ ref_id: 'entities', chars: 50 }] });
    mm.recordContextInjections('t-bad', { memoryIds: ['m-bad'] });
    eq(countRows(db, 'wa_context_injections'), 2, 'R-61a 前置：两任务各一行，结局均 pending');
    const returned = mm.reinforceMemories('t-ok', 'p1', true);
    eq(returned, 0, 'R-61b 只注入知识的任务没有记忆可强化（返回 0）');
    eq((db.prepare("SELECT outcome FROM wa_context_injections WHERE task_id = 't-ok'").get() as { outcome: string }).outcome,
      'completed', 'R-61c ★★知识注入行也回填 completed（早退之前先结账）');
    mm.reinforceMemories('t-bad', 'p1', false);
    eq((db.prepare("SELECT outcome FROM wa_context_injections WHERE task_id = 't-bad'").get() as { outcome: string }).outcome,
      'failed', 'R-61d ★★失败标本：pending→failed');
    // 只回填 pending：已结清的账不被后续回填改写。
    mm.backfillInjectionOutcomes('t-ok', 'failed');
    eq((db.prepare("SELECT outcome FROM wa_context_injections WHERE task_id = 't-ok'").get() as { outcome: string }).outcome,
      'completed', 'R-61e ★已结清的行不再被改写（同一结局只记一次）');
  }

  // ═══ R-62｜同一任务同一记忆重复注入只一行（0→1 而非 0→2）════════════════════════════
  console.log('\n【R-62】同任务同源同 ref 重复注入：唯一键只留一行');
  {
    const db = makeLedgerDb();
    const mm = new MemoryManager(db as never, null as never);
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title) VALUES ('t-dup', 'p1', '去重')`).run();
    db.prepare(`INSERT INTO wa_memories (id, project_id, content, memory_type) VALUES ('m-dup', 'p1', '重复注入', 'procedural')`).run();
    eq(mm.recordContextInjections('t-dup', { memoryIds: ['m-dup'], knowledge: [{ ref_id: 'entities', chars: 30 }] }), 2,
      'R-62a ★首批 0→2：记忆 + 知识各一行');
    eq(mm.recordContextInjections('t-dup', { memoryIds: ['m-dup'], knowledge: [{ ref_id: 'entities', chars: 99 }] }), 0,
      'R-62b ★★重复注入写入 0 行（resume/多次装配不重复记账）');
    eq(countRows(db, 'wa_context_injections'), 2, 'R-62c ★行数仍是 2（不是 0→4）');
    eq((db.prepare("SELECT chars FROM wa_context_injections WHERE task_id = 't-dup' AND source = 'knowledge'").get() as { chars: number }).chars,
      30, 'R-62d 重复注入不覆写首行（先记下的字符数保留）');
  }

  // ═══ R-63｜相关度相同、成功率不同 ⇒ 成功率高者靠前（两只标本）════════════════════
  console.log('\n【R-63】实践成败是小幅决胜因子：同相关度时成功率高者靠前');
  {
    const db = makeLedgerDb();
    const mm = new MemoryManager(db as never, null as never);
    const ins = (id: string, project: string, content: string, success: number, failure: number): void => {
      db.prepare(`INSERT INTO wa_memories (id, project_id, content, memory_type, importance, use_count, success_count, failure_count, created_at)
        VALUES (?, ?, ?, 'procedural', 0.5, 0, ?, ?, datetime('now', '-60 days'))`)
        .run(id, project, content, success, failure);
    };
    // 标本一：高成功率先插。
    ins('m-good-a', 'p-rank-1', '有效经验 A', 5, 0);
    ins('m-bad-a', 'p-rank-1', '失败经验 A', 0, 5);
    eq(mm.retrieveByType('procedural', 'p-rank-1', 5).map((m) => m.id), ['m-good-a', 'm-bad-a'],
      'R-63a ★★同重要度/同提取强度 ⇒ 成功率高者靠前');
    // 标本二：反插入顺序（低成功率先插）⇒ 结果仍按成功率，不按插入序/rowid。
    ins('m-bad-b', 'p-rank-2', '失败经验 B', 0, 5);
    ins('m-good-b', 'p-rank-2', '有效经验 B', 5, 0);
    eq(mm.retrieveByType('procedural', 'p-rank-2', 5).map((m) => m.id), ['m-good-b', 'm-bad-b'],
      'R-63b ★★反插入顺序仍成功率高者靠前（排除 rowid/插入序假象）');
  }

  // ═══ R-64｜没有注入任何记忆/知识 ⇒ 零行（反证）════════════════════════════════════
  console.log('\n【R-64】零注入 ⇒ 零行（反证：不是"凡执行必记"）');
  {
    const db = makeLedgerDb();
    const mm = new MemoryManager(db as never, null as never);
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title) VALUES ('t-none', 'p1', '无注入')`).run();
    eq(countRows(db, 'wa_context_injections'), 0, 'R-64a 起跑零行');
    eq(mm.recordContextInjections('t-none', {}), 0, 'R-64b 空注入 ⇒ 写入 0 行');
    eq(mm.recordContextInjections('t-none', { memoryIds: [], knowledge: [] }), 0, 'R-64c 空数组 ⇒ 写入 0 行');
    eq(countRows(db, 'wa_context_injections'), 0, 'R-64d ★反证：账上仍零行（没有凭空造行）');
  }

  // ═══ R-65｜TaskDetail 七源分账与裁剪数上屏（renderer 是词表第二落点）════════════════
  console.log('\n【R-65】TaskDetail 七源标签 + 知识包统计上屏（中文串）');
  {
    const td = RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    const labels = ['Token 分账', '系统', '记忆', '知识', '历史', '工具', '用户', '产出', '合计', '预算', '已裁剪', '裁剪后仍超预算'];
    eq(labels.filter((s) => !td.includes(s)), [], 'R-65a ★十二个用户可见标签逐个在场（中文串，不是标识符）');
    ok(td.includes('execution_metrics?.token_breakdown') && td.includes('context_watermark') && td.includes('tokenBreakdown'),
      'R-65b ★优先读收口账、运行中回退水位账（两个来源都认）');
    ok(td.includes('trimmedChars') && td.includes("['knowledge', 'memory', 'history']"),
      'R-65c 裁剪数按三源（知识/记忆/历史）加总，与 main 侧裁剪顺序同源');
    const ipc = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(ipc.includes("'knowledge:stats'") && ipc.includes('stats: (projectId'),
      'R-65d ★渲染层真接上 knowledge:stats（有界面调用口，不是只有 handler）');
    const handler = RD(`${A}/src/main/ipc/knowledge.ipc.ts`);
    ok(handler.includes("'knowledge:stats'"), 'R-65e main 侧注册 knowledge:stats');
    const card = RD(`${A}/renderer/src/components/KnowledgePackCard.tsx`);
    ok(['知识注入', '成功', '失败', '待结'].every((s) => card.includes(s)),
      'R-65f ★知识包卡显示“注入 N 次 / 成功 M / 失败 K”（待结如实另列）');
    // 产物核实：minify 后标识符会变，中文串不变（renderer 是词表第二落点）。
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf-8')).join('\n')
      : '';
    ok(chunks.includes('Token 分账') && chunks.includes('已裁剪'),
      'R-65g ★renderer 产物含中文标签（minify 改不了中文串）',
      chunks ? '' : 'renderer/dist/assets 不存在（须先 build）');
  }

  // ═══ R-66｜知识包统计可上屏；JSONL 导出仍 training:false ═══════════════════════════
  console.log('\n【R-66】知识注入统计按项目/结局计数；导出仍 training:false');
  {
    const db = makeLedgerDb();
    db.prepare(`INSERT INTO wa_projects (id, name) VALUES ('p1', '甲项目'), ('p2', '乙项目')`).run();
    db.prepare(`INSERT INTO wa_tasks (id, project_id, title) VALUES ('k1', 'p1', '甲一'), ('k2', 'p1', '甲二'), ('k3', 'p2', '乙一')`).run();
    const ins = (taskId: string, source: string, refId: string, outcome: string): void => {
      db.prepare(`INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome) VALUES (?, ?, ?, ?, 10, 3, ?)`)
        .run(`inj-${taskId}-${source}-${refId}`, taskId, source, refId, outcome);
    };
    ins('k1', 'knowledge', 'entities', 'completed');
    ins('k2', 'knowledge', 'services', 'pending');
    ins('k3', 'knowledge', 'entities', 'failed');
    ins('k1', 'memory', 'm-x', 'completed'); // 记忆注入不计入知识包统计
    eq(knowledgeInjectionStats(db as never, 'p1'), { injected: 2, completed: 1, failed: 0, pending: 1 },
      'R-66a ★甲项目按结局计数（注入 2 次 / 成功 1 / 失败 0 / 待结 1）');
    eq(knowledgeInjectionStats(db as never, 'p2'), { injected: 1, completed: 0, failed: 1, pending: 0 },
      'R-66b ★乙项目失败标本（只数 source=knowledge）');
    eq(knowledgeInjectionStats(db as never, 'nope'), { injected: 0, completed: 0, failed: 0, pending: 0 },
      'R-66c ★反证：没有注入的项目零计数（不编造）');
    const exporter = CODE(`${A}/src/main/core/knowledge-export.ts`);
    ok(exporter.includes('training: false'), 'R-66d ★JSONL 每行仍 `training: false`（仅导出，不训练）');
    ok(!RD(`${A}/src/main/core/knowledge-export.ts`).includes('已训练'),
      'R-66e ★导出面不含“已训练”字样（没有把导出冒充训练）');
  }

  // ═══ R-67｜知识包导出挂 Pro+ 闸（两只标本：社区拒且零文件 / Pro·Team 放行写一份）════
  console.log('\n【R-67】导出挂 Pro+ 闸：社区档 FEATURE_REQUIRED 且零文件；Pro/Team 0→1');
  {
    const gateSrc = CODE(`${A}/src/main/core/pro-gate.ts`);
    // zx_20261018_2 批一：词表新增 `image_vision`（旧断言"恰一项"按更强的新真源重定向——
    //   逐项在册 + 无重复 + 每项有人话名；**不写"恰 N 项"**，那是只对下一轮引爆的哑雷）。
    ok(PRO_FEATURES.includes('knowledge_export') && PRO_FEATURES.includes('image_vision')
      && new Set(PRO_FEATURES).size === PRO_FEATURES.length
      && PRO_FEATURES.every((f) => (PRO_FEATURE_LABEL[f] ?? '').trim().length > 0),
      'R-67a ★Pro 能力词表逐项在册（knowledge_export / image_vision）且每项有人话名（唯一定处 `pro-gate.ts`）',
      [...PRO_FEATURES].join(','));
    ok(PRO_FEATURE_LABEL.knowledge_export.includes('导出') && !PRO_FEATURE_LABEL.knowledge_export.includes('预览'),
      'R-67b ★人话名只写"导出"（预览/注入不挂闸——名实相符）', PRO_FEATURE_LABEL.knowledge_export);
    ok(/proFeatureRefusal\s*\(/.test(gateSrc) && /kind === 'trial'/.test(gateSrc),
      'R-67c 判据一处真源：试用期特判在册（与 team-gate 同一写法）');

    const now = new Date('2026-10-18T00:00:00.000Z');
    const fingerprint = 'RR-0000-0000-0000';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pro-export-'));

    // 标本①：社区档（无 key 无试用）⇒ 拒，且目标目录**零文件**（0→0）。
    const community = makeExportDb();
    const refused = exportKnowledgeForProject(community as never, 'p1', dir, { now, fingerprint });
    eq(refused.ok, false, 'R-67d ★标本①：社区档导出被拒');
    eq(refused.ok ? null : refused.code, 'FEATURE_REQUIRED', 'R-67e 回码＝`FEATURE_REQUIRED`');
    ok(refused.ok ? false : refused.message.includes('项目知识包导出') && refused.message.includes('专业版'),
      'R-67f 拒因含人话名与升级指引（不返回光秃秃的 false）', refused.ok ? '' : refused.message);
    const exportDir = path.join(dir, KNOWLEDGE_EXPORT_DIR);
    eq(fs.existsSync(exportDir) ? fs.readdirSync(exportDir).length : 0, 0,
      'R-67g ★★拒时零文件（先判后写：不建目录、不落盘）');
    eq(countRows(community, 'wa_project_knowledge'), 1, 'R-67h 反证：册本身没被删（软闸不毁数据）');
    community.close();

    // 标本②：Pro / Team 档（离线签名许可，本套件自建密钥对）⇒ 放行，文件 0→1。
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const licenseFor = (tier: 'pro' | 'team'): string => encodeLicense({
      v: 1, tier, subject: 'rr', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, devices: [],
    }, privateKeyPem);
    for (const tier of ['pro', 'team'] as const) {
      const db = makeExportDb();
      db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(LICENSE_SETTING_KEYS.key, licenseFor(tier));
      const sub = path.join(dir, tier);
      const out = exportKnowledgeForProject(db as never, 'p1', sub, { now, fingerprint, publicKeyPem });
      ok(out.ok, `R-67i ★标本②：${tier} 档导出放行`, out.ok ? '' : out.message);
      const files = fs.readdirSync(path.join(sub, KNOWLEDGE_EXPORT_DIR));
      eq(files.length, 1, `R-67j ${tier} 档导出 0→1（一份文件）`);
      ok(files[0]?.endsWith('.jsonl') === true, `R-67k ${tier} 档产物是 JSONL`, files[0] ?? '');
      db.close();
    }

    // 接线：IPC 只转发编排口，且把拒因**原样**映射成 error.code（不写死一个假码）。
    const kIpc = CODE(`${A}/src/main/ipc/knowledge.ipc.ts`);
    ok(/exportKnowledgeForProject\s*\(/.test(kIpc) && /outcome\.code/.test(kIpc),
      'R-67l ★IPC 真接闸：调编排口并把 `outcome.code` 原样映射（FEATURE_REQUIRED 不是壳子）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ═══ R-68｜闸只落导出：社区档预览/注入照常（反证：不误伤核心任务）════════════════
  console.log('\n【R-68】闸只落导出：社区档预览/注入照常可用');
  {
    const db = makeExportDb();
    const preview = previewProjectKnowledge(db as never, 'p1', null);
    ok(preview.selected.length > 0 && preview.selected[0].section === 'entities',
      'R-68a ★社区档预览照常（同一取数、同一择节）');
    eq(preview.budgetTokens, KNOWLEDGE_INJECT_MAX_TOKENS, 'R-68b 预算仍是注入侧同一常量（预览不另立分度）');
    ok(exportKnowledgeForProject(db as never, 'p1', path.join(os.tmpdir(), 'wa-pro-68'), {
      now: new Date('2026-10-18T00:00:00.000Z'), fingerprint: 'RR-0000-0000-0000',
    }).ok === false, 'R-68c 同一库导出被拒（对照：预览可用、导出不可用——闸只落一处）');
    db.close();

    // 结构证据：main 进程内引 `pro-gate` 的**动作层**逐项在册。
    //   zx_20261018_2 批一：`image_vision` 的接线在 `core/tools/media.ts`（旧断言"只有导出编排"已证伪）。
    //   zx_20261018_2 批二：`long_video` 的接线在 `core/agent-executor.ts`（装配附件时裁定）。
    //   重定向为**逐项枚举**（承「幻数计数 → 逐成员枚举」，不是放宽）。
    const mainSrc = path.join(root, A, 'src/main');
    const tsFiles = (fs.readdirSync(mainSrc, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    const importers = tsFiles
      .filter((f) => /from\s+['"][^'"]*pro-gate\.js['"]/.test(fs.readFileSync(path.join(mainSrc, f), 'utf-8')))
      .map((f) => f.split(path.sep).join('/'))
      .sort();
    //   zx_20261018_2 批五：`core/tier-catalog.ts` 是**读模型**（档位对照表），只取纯函数 `proUnlocked`；
    //   逐成员枚举 + 新增"它不得调用拒因/闸裁定"的反证（不是放宽，是给新增成员钉边界）。
    //   zx_20261021_3 批二：`core/domain-pack.ts` 也成动作层（生成/启用挂闸，撤销不挂）。
    //   zx_20261022_3 批七：`core/knowledge-import.ts` 成为导出之外的第二跳动作层（导入动作挂闸）。
    //   zx_20261023_5 批二：`core/knowledge-cards.ts` 是动作层（蒸馏/落候选卡两跳过闸）；
    //     `core/memory-manager.ts` 是**读口**（列表按当前档位拒绝注入，不删卡）。
    eq(importers, ['core/agent-executor.ts', 'core/domain-pack.ts', 'core/knowledge-cards.ts', 'core/knowledge-export.ts', 'core/knowledge-import.ts', 'core/memory-manager.ts', 'core/tier-catalog.ts', 'core/tools/media.ts'],
      'R-68d ★★引 pro-gate 的动作层/读模型逐成员枚举（导出编排 + 导入编排 + 领域包 + 知识卡蒸馏 + 知识卡读口 + view_image + long_video 装配 + 档位对照；IPC 壳与别处不另写档位判断）');
    const catalogSrc = CODE(`${A}/src/main/core/tier-catalog.ts`);
    ok(/import \{[^}]*proUnlocked[^}]*\} from '\.\/pro-gate\.js'/.test(catalogSrc)
      && !/proFeatureRefusal|resolveProGate/.test(catalogSrc),
      'R-68f ★档位对照只取纯谓词（不调拒因/闸裁定——读模型不越权做动作判定）');
    ok(!/proFeatureRefusal|resolveProGate/.test(CODE(`${A}/src/main/ipc/knowledge.ipc.ts`)),
      'R-68e IPC 壳零档位判断');
  }

  // ═══ R-69｜价目表只写有闸兑现的卖点（Pro 知识导出 / Team 意图与多机）══════════════
  console.log('\n【R-69】pricing.ts 的 benefits 与真实闸逐项对齐');
  {
    const proText = PRICING.pro.benefits.join(' / ');
    const teamText = PRICING.team.benefits.join(' / ');
    ok(/知识包/.test(proText) && /导出/.test(proText), 'R-69a ★Pro 卖点含"项目知识包导出"', proText);
    ok(!/高级模板/.test(proText), 'R-69b ★Pro 不再宣称未实现的「高级模板」');
    ok(/多机协同/.test(teamText) && /意图/.test(teamText), 'R-69c ★Team 卖点含多机协同与 AI 终端意图接入', teamText);
    ok(!/云同步|成员权限|高级模板/.test(`${proText} ${teamText}`),
      'R-69d 三处未实现卖点一个都不在（云同步/成员权限/高级模板）');
    // 双证：说 Pro 有 ⇒ 社区真被拒（卖点有闸兑现，不是自说自话）。
    const community = makeExportDb();
    ok(proFeatureRefusal(community as never, 'knowledge_export', {
      now: new Date('2026-10-18T00:00:00.000Z'), fingerprint: 'RR-0000-0000-0000',
    }) !== null, 'R-69e ★卖点有闸兑现：社区档真被拒');
    community.close();
  }

  // ═══ R-70｜Team 词表不擅自加项；外部终端人话名写明意图边界 ══════════════════════
  console.log('\n【R-70】TEAM_FEATURES 逐项枚举；external_terminal 名实相符');
  {
    // zx_20261018_3 批七：新增 `audit_export`（审计导出）⇒ 词表 6→7；逐成员枚举仍不放宽，
    //   新成员须同时在 `TEAM_FEATURE_LABEL` 补人话名并穷举接线（`audit:export` 第一跳）。
    // zx_20261022_3 批八：新增 `project_profile_share`（画像共享，只闸搬运）⇒ 7→8；同尺不放宽。
    eq([...TEAM_FEATURES],
      ['multi_node', 'device_discovery', 'device_control', 'external_terminal', 'audit_view', 'audit_export', 'team_library', 'project_profile_share'],
      'R-70a ★TEAM_FEATURES 逐项枚举（批七 `audit_export`、zx_20261022_3 批八 `project_profile_share` 入册后共 8 项，不顺手加枚举）');
    const label = TEAM_FEATURE_LABEL.external_terminal;
    ok(label.startsWith('外部终端接入') && label.includes('意图接入') && label.includes('显式勾选'),
      'R-70b ★人话名写明边界（意图接入默认授 / 原始控制须显式勾选）', label);
    const community = makeDoorDb(false);
    const refusal = teamFeatureRefusal(community as never, 'external_terminal');
    ok(typeof refusal === 'string' && refusal.includes('外部终端接入'),
      'R-70c 拒因仍带人话名（改标签没把拒因改丢）', refusal ?? 'null');
    community.close();
  }

  // ═══ R-71｜license-tiers.md 回填到新闸（文档与代码同一把尺）═══════════════════════
  console.log('\n【R-71】license-tiers.md 不再有"知识包未挂闸"的旧结论');
  {
    const doc = RD('business-plan/license-tiers.md');
    ok(!doc.includes('未挂档位闸'), 'R-71a ★旧结论"项目知识包未挂档位闸"已清除');
    // zx_20261018_2 批五：Pro 能力扩为三项 ⇒ 矩阵标题逐项由**词表派生**核对（短名去括号），
    //   不写死旧标题字面量（写死会在下一项 Pro 能力落地时变成哑雷）。
    const proShort = PRO_FEATURES.map((f) => PRO_FEATURE_LABEL[f].split('（')[0]);
    ok(doc.includes('Pro 能力（') && proShort.every((s) => doc.includes(s))
      && doc.includes('core/pro-gate.ts') && doc.includes('exportKnowledgeForProject'),
      'R-71b ★矩阵 / 真源清单 / 编排口三处都回填（Pro 能力逐项由词表派生核对）', proShort.join(' / '));
    ok(doc.includes('项目知识包**导出锁**') && doc.includes('预览与执行期注入仍常开'),
      'R-71c ★社区档口径如实：导出锁、预览注入常开');
    ok(Object.values(TIER_LABEL).every((l) => doc.includes(l)), 'R-71d 三档人话名齐（与代码词表同源）');
    ok(!/高级模板、优先支持/.test(doc), 'R-71e 价目旧行「高级模板、优先支持」已删');
  }

  // ═══ R-72｜biz_20261011 差异表与 pricing / 代码闸口径一致 ═════════════════════════
  console.log('\n【R-72】biz_20261011 差异表口径与代码闸一致');
  {
    const biz = RD('business-plan/plans/biz_20261011.md');
    ok(biz.includes('core/pro-gate.ts') && biz.includes('FEATURE_REQUIRED'),
      'R-72a ★§2.3 知识包行已接到真源（pro-gate + FEATURE_REQUIRED）');
    ok(!biz.includes('未挂档位闸'), 'R-72b ★旧"未挂档位闸"结论已订正');
    // 「云同步/成员权限」只许以"已删除"的留痕形式出现（§7 第 4 条），不得作为卖点宣称。
    ok(/删「高级模板」「云同步」「成员权限」/.test(biz) && countOcc(biz, '云同步') === 1,
      'R-72c 未实现卖点仅以"已删除"留痕（不作文宣称）');
    ok(biz.includes('意图层') && biz.includes('原始设备控制须显式勾选'),
      'R-72d §1.3 意图层边界与 `DEFAULT_TERMINAL_CAPABILITIES` 一致');
    ok(biz.includes('批八补 **Pro+ 闸**'), 'R-72e §6 差异表新增"批八补闸"一行（改动有据可查）');
  }

  // ═══ R-73｜投放素材只宣称已落地能力；意图文案有协议背书 ═════════════════════════
  console.log('\n【R-73】launch/landing 只宣称已落地能力');
  {
    const landing = RD('business-plan/materials/landing-page.md');
    const launch = RD('business-plan/materials/launch-post.md');
    ok(!/云同步|高级模板|成员权限/.test(landing), 'R-73a ★落地页价目表不含未实现卖点');
    ok(launch.includes('高级模板 / 云同步 / 成员权限'),
      'R-73b ★首帖把三处未实现卖点写进"不许说"清单（反向固证）');
    ok(landing.includes('意图接入') && launch.includes('意图接入'),
      'R-73c ★两份素材都写"意图接入"（不是含糊的"设备控制"）');
    ok(landing.includes('显式勾选') && launch.includes('显式勾选'),
      'R-73d 两份素材都写明"原始控制须显式勾选"');
    eq([...DEFAULT_TERMINAL_CAPABILITIES], ['intent_control'],
      'R-73e ★文案边界有协议背书：默认能力恰是意图控制');
  }

  // ═══ R-74｜试用期内视同 Pro 可导出；试用过期回社区即拒（两只标本）════════════════
  console.log('\n【R-74】试用期可导出；试用过期即拒');
  {
    const now = new Date('2026-10-18T00:00:00.000Z');
    const fingerprint = 'RR-0000-0000-0000';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pro-trial-'));

    // 标本①：起算点 3 天前 ⇒ 仍在 14 天试用期（视同 Pro）。
    const fresh = makeExportDb({ trialStartedAt: '2026-10-15T00:00:00.000Z' });
    eq(resolveProGate(fresh as never, { now, fingerprint }).unlocked, true, 'R-74a ★试用期内 Pro 闸放行');
    const out = exportKnowledgeForProject(fresh as never, 'p1', path.join(dir, 'fresh'), { now, fingerprint });
    ok(out.ok, 'R-74b ★试用期可导出', out.ok ? '' : out.message);
    eq(fs.readdirSync(path.join(dir, 'fresh', KNOWLEDGE_EXPORT_DIR)).length, 1, 'R-74c 试用期导出 0→1');
    fresh.close();

    // 标本②：起算点 15 天前 ⇒ 试用已过（回社区）。
    const stale = makeExportDb({ trialStartedAt: '2026-10-03T00:00:00.000Z' });
    eq(resolveProGate(stale as never, { now, fingerprint }).unlocked, false, 'R-74d ★试用过期 Pro 闸锁定');
    const denied = exportKnowledgeForProject(stale as never, 'p1', path.join(dir, 'stale'), { now, fingerprint });
    eq(denied.ok ? null : denied.code, 'FEATURE_REQUIRED', 'R-74e ★试用过期回社区即拒');
    ok(denied.ok ? false : denied.message.includes('社区版'),
      'R-74f 拒因如实报"当前为社区版"', denied.ok ? '' : denied.message);
    eq(fs.existsSync(path.join(dir, 'stale', KNOWLEDGE_EXPORT_DIR))
      ? fs.readdirSync(path.join(dir, 'stale', KNOWLEDGE_EXPORT_DIR)).length : 0, 0,
      'R-74g 过期后零文件（0→0）');
    stale.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ═══ R-75｜执行体瘦身为编排；抽出物在新家就地定义、旧导出名不悬空 ══════════════════
  console.log('\n【R-75】exec-strategy / exec-prelude 抽出（定义只在一处，旧调用点不裂）');
  {
    const execSrc = RD(`${A}/src/main/core/agent-executor.ts`);
    const execCode = CODE(`${A}/src/main/core/agent-executor.ts`);
    const strategy = CODE(`${A}/src/main/core/exec-strategy.ts`);
    const prelude = CODE(`${A}/src/main/core/exec-prelude.ts`);

    const execLines = execSrc.split('\n').length;
    ok(execLines < 4000, 'R-75a ★执行体只保留编排（行数 < 4000；抽出前逾 4100）', `${execLines} 行`);
    ok(strategy.split('\n').length > 200 && prelude.split('\n').length > 200,
      'R-75b 两个新模块都是实打实的实现（各 > 200 行，不是空壳转手）',
      `${strategy.split('\n').length} / ${prelude.split('\n').length} 行`);

    // 抽出面的**全部**旧导出名（`USD_TO_CNY_RATE`/`modelPriceInUsd` 原先不对外导出，故不在此列）。
    const STRATEGY_NAMES = [
      'cnyFactor', 'EXPLORATION_TOOLS', 'READ_ONLY_BASH_CMDS', 'isExplorationCall', 'isReadOnlyProbeCommand',
      'countsTowardToolQuota', 'EMPTY_LOOP_RUN', 'toolCallFingerprint', 'fingerprintToolName', 'describeToolCall',
      'advanceLoopRun', 'MIXED_SHELL_TOOLS', 'D3_GATE_TOOLS', 'isExplorationToolAlways',
      'makeNonExplorationCappedTool', 'budgetBandOf', 'BUDGET_HARD_STOP_TOOLS', 'BUDGET_WARN_TOOLS', 'resolveCostBudget',
    ];
    const PRELUDE_NAMES = [
      'buildBudgetContextBlock', 'buildDeviationContextBlock', 'formatInsufficiencyReasons', 'mergePlanModeContext',
      'truncateCtx', 'buildUpstreamRequirementBlock', 'COMPLETED_ITEMS_FILE_LIMIT', 'collectWrittenFiles',
      'buildCompletedItemsBlock', 'USER_DIRECTIVE_MAX_CHARS', 'readRecentUserDirectives', 'buildUserDirectiveBlock',
    ];
    const declared = (src: string, name: string) =>
      new RegExp(`export\\s+(?:function|const|interface|type)\\s+${name}\\b`).test(src);

    eq(STRATEGY_NAMES.filter((n) => !declared(strategy, n)), [],
      'R-75c ★策略族 19 个导出在新模块**就地定义**（逐个查声明形状）');
    eq(PRELUDE_NAMES.filter((n) => !declared(prelude, n)), [],
      'R-75d ★预组装族 12 个导出在新模块**就地定义**（逐个查声明形状）');
    eq([...STRATEGY_NAMES, ...PRELUDE_NAMES].filter((n) => declared(execCode, n)), [],
      'R-75e ★★反证：执行体内不再有同名声明（定义只在新区一处）');

    // 旧路径的再导出块：44 个既有调用点（rr/core 模块）走的仍是原路径。
    const reStart = execSrc.search(/export\s*\{\s*(?:\n\s*)?cnyFactor/);
    // 旧路径的再导出以最后一条类型导出收尾（`WrittenFileFact` 那一行也要算进来）。
    const reTail = "export type { WrittenFileFact } from './exec-prelude.js';";
    const reEnd = execSrc.indexOf(reTail, reStart) + reTail.length;
    const reBlock = reStart >= 0 && reEnd > reStart ? execSrc.slice(reStart, reEnd) : '';
    eq([...STRATEGY_NAMES, ...PRELUDE_NAMES].filter((n) => !reBlock.includes(n)), [],
      'R-75f ★旧路径再导出覆盖全部抽出名（旧调用点不裂）');
    ok(/export type \{[^}]*LoopRun[^}]*ToolStubLike[^}]*\}/.test(reBlock)
      && /export type \{[^}]*WrittenFileFact[^}]*\}/.test(reBlock),
      'R-75g 三个类型导出也在旧路径再导出');

    ok(/from '\.\/exec-strategy\.js'/.test(execCode) && /from '\.\/exec-prelude\.js'/.test(execCode),
      'R-75h ★执行体从新模块引入（拿出去了，也真接上了）');
    eq((strategy.match(/^\s*import\s/m) ?? []).length, 0, 'R-75i 策略模块零 import（纯函数可直跑）');
    const preludeImports = prelude.match(/^\s*import\s.*$/gm) ?? [];
    eq(preludeImports.length, 1, 'R-75j 预组装模块只有一条 import');
    ok(/^import type Database from 'better-sqlite3';$/m.test(prelude),
      'R-75k …且是纯类型（无运行期依赖）');

    // 行为不漂移（真实现直跑，不另抄判据）。
    eq(mergePlanModeContext({ a: 1 }, { b: 2 }), { a: 1, b: 2 }, 'R-75l 合并器行为不变（既有键不丢）');
    eq(formatInsufficiencyReasons([]), '', 'R-75m 无原因 ⇒ 空串（不编"什么都没缺"）');
    eq(buildUserDirectiveBlock([]), '', 'R-75n 无指令 ⇒ 空串');
    ok(buildUserDirectiveBlock(['先跑测试']).includes('用户指令优先'), 'R-75o 有指令 ⇒ 明写优先级');
    eq(advanceLoopRun(['a', 'a'], { fp: 'a', len: 1 }), { fp: 'a', len: 2 }, 'R-75p 游程推进行为不变');
    eq(advanceLoopRun(['a', 'b'], { fp: 'a', len: 1 }), EMPTY_LOOP_RUN, 'R-75q 混合步 ⇒ 归零');
    eq(cnyFactor('qwen-max'), 1, 'R-75r 国内厂商按 CNY（不加汇率）');
    eq(cnyFactor('gpt-4o'), USD_TO_CNY_RATE, 'R-75s 海外厂商按 USD × 汇率');
    ok(budgetBandOf(0.99) === 5 && budgetBandOf(0.1) === 1, 'R-75t 预算档位边界不变');
    ok(toolCallFingerprint('read_file', { path: 'a' }) === toolCallFingerprint('read_file', { path: 'a' }),
      'R-75u 调用指纹稳定（同入参同指纹）');
  }

  // ═══ R-76｜build 值源码与产物同轮（读产物里的值本身）═════════════════════════════
  console.log('\n【R-76】build 值：源码恰一处且与 dist 产物同值');
  {
    const src = deriveBuildTag(RD(`${A}/src/main/core/agent-executor.ts`));
    eq(src.count, 1, 'R-76a 源码内 build 轮次标识恰一处（防陈旧残留）');
    eq(roundOrd(src.tag) >= roundOrd(SELF_ROUND), true,
      'R-76b ★源码 build 值不早于本轮（脚本名派生；下一轮允许推进）', src.tag);

    const distDir = path.join(root, A, 'dist');
    const files = fs.existsSync(distDir)
      ? (fs.readdirSync(distDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.js'))
      : [];
    const blob = files.map((f) => fs.readFileSync(path.join(distDir, f), 'utf-8')).join('\n');
    const hits = [...blob.matchAll(/build\s*:\s*['"](zx_[0-9_]+)['"]/g)].map((m) => m[1]!);
    eq(hits.length, 1, `R-76c ★dist 产物内 build 值恰一处（${files.length} 个 .js；未构建请先 tsup）`);
    eq(roundOrd(hits[0] ?? '') >= roundOrd(SELF_ROUND), true,
      'R-76d ★产物内 build 值不早于本轮（读值本身，不用子串）');
  }

  // ═══ R-80｜renderer 产物含本轮功能词（词表第二个落点已核）════════════════════════
  console.log('\n【R-80】renderer 产物含本轮功能词（第二落点）');
  {
    const distDir = path.join(root, A, 'renderer/dist/assets');
    const files = fs.existsSync(distDir) ? (fs.readdirSync(distDir) as string[]).filter((f) => f.endsWith('.js')) : [];
    ok(files.length > 0, 'R-80a renderer 产物在位（renderer/dist/assets/*.js）', `${files.length} 个 chunk`);
    const blob = files.map((f) => fs.readFileSync(path.join(distDir, f), 'utf-8')).join('\n');
    // 判"上屏词"须查产物（minify 后中文串仍在）；「实时状态」在本产品里的上屏形态是「在线：/最近动作」，
    //   不发明一个 UI 里没有的词——R-80 要核的是"这一批功能真到得了界面"，不是词表对齐。
    for (const [word, note] of [
      ['意图演练', '批五：GUI 意图演练（预览/执行）'],
      ['最近动作', '批四：实时状态块（动作 + @时刻 + 结果）'],
      ['在线', '批四：可用性徽标（LWT/avty，非发现载荷推断）'],
      ['分账', '批七：token 分账上屏'],
      ['房间', '批三：人指派的房间'],
      ['未分配', '批三：空串＝未分配（不猜"未知房间"）'],
    ] as const) {
      ok(blob.includes(word), `R-80b ★产物含「${word}」（${note}）`);
    }
  }

  // ═══ R-81｜参考终端在合成设备上跑通 pair → capabilities → resolve → execute ══════════
  console.log('\n【R-81】参考终端整串往返（合成设备 + 注入审批）');
  {
    const env = makeIntentEnv();
    const tdb = env.db as unknown as TerminalDb;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const raw = req.url ?? '/';
          const qi = raw.indexOf('?');
          const query: Record<string, string> = {};
          if (qi >= 0) for (const [k, v] of new URL(`http://127.0.0.1${raw}`).searchParams) query[k] = v;
          let body: unknown;
          const text = Buffer.concat(chunks).toString('utf-8');
          if (text) { try { body = JSON.parse(text); } catch { body = undefined; } }
          const result = await handleInboundRequest({
            method: req.method ?? 'GET',
            path: qi >= 0 ? raw.slice(0, qi) : raw,
            query,
            headers: req.headers as Record<string, string | string[] | undefined>,
            remoteAddress: '127.0.0.1',
            body,
          }, env.deps);
          // 「注入审批」＝桌面端「协作 → AI 终端」里点批准这一个人动作（与 IM 回「同意接入」同义）。
          if (req.method === 'POST' && result.status === 200) {
            const id = (result.body as { pairing_id?: unknown } | null)?.pairing_id;
            if (typeof id === 'string') approveTerminal(tdb, id, [INTENT_CAPABILITY]);
          }
          const out = result.body == null ? '' : JSON.stringify(result.body);
          res.statusCode = result.status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(out));
          res.end(out);
        })();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const scriptPath = path.join(root, 'scripts/e2e-ai-terminal.mjs');
    ok(fs.existsSync(scriptPath), 'R-81a 参考终端脚本在场', 'scripts/e2e-ai-terminal.mjs');

    // 汇总里失败字形会被 `pnpm rr:all` 当失败计数 ⇒ 进断言详情前先洗掉。
    const scrub = (s: string) => s.replace(/[✗✓]/g, 'x').slice(0, 300);
    const runRef = (extra: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath,
        [scriptPath, '--base', `http://127.0.0.1:${port}`, '--json', '--timeout', '20', '--room', '客厅', '--feeling', 'hot', ...extra],
        { timeout: 40_000 },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
          resolve({ code, stdout, stderr });
        });
    });
    interface RefOut {
      capabilities?: { capabilities?: string[] };
      resolve?: { planId?: string; steps?: Array<{ call_name?: string; action?: string }> };
      execute?: { status?: string; steps?: Array<{ ok?: boolean }> };
    }
    const parseOut = (stdout: string): RefOut | null => {
      const last = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try { return JSON.parse(last) as RefOut; } catch { return null; }
    };

    // 第一跑：`--no-execute` ⇒ 计划**零副作用**（账只多一行计划，动作/传动均 0）。
    const dry = await runRef(['--no-execute']);
    eq(dry.code, 0, 'R-81b ★参考终端 `--no-execute` 整串成功（配对/轮询/能力/resolve）', scrub(dry.stderr));
    const dryOut = parseOut(dry.stdout);
    ok(dryOut !== null, 'R-81c `--json` 末尾给出机器可读汇总', scrub(dry.stdout).slice(0, 120));
    ok(dryOut?.capabilities?.capabilities?.includes('intent_control') === true,
      'R-81d ★能力面含 `intent_control`（门外看见自己被授予的意图）');
    ok(typeof dryOut?.resolve?.planId === 'string' && (dryOut.resolve.planId ?? '') !== '',
      'R-81e ★resolve 返回 planId');
    eq(dryOut?.resolve?.steps?.length, SPECIMEN_STEPS.length,
      'R-81f 计划步数＝规划器给的步数（逐项形状未漂移）');
    eq(env.calls.length, 0, 'R-81g ★★计划零副作用：传动一次都没发生');
    eq(env.plans(), 1, 'R-81h 计划账恰 1 行（resolve 落了，execute 没跑）');
    eq(env.actions(), 0, 'R-81i 设备动作账 0 行（预览不碰设备）');

    // 第二跑：完整 pair → capabilities → resolve → execute ⇒ 逐步留痕且账对得上。
    const full = await runRef([]);
    eq(full.code, 0, 'R-81j ★参考终端完整往返退出码 0', scrub(full.stderr));
    const out = parseOut(full.stdout);
    eq(out?.execute?.status, 'executed', 'R-81k ★execute 收口 `executed`');
    eq(out?.execute?.steps?.map((s) => s.ok), SPECIMEN_STEPS.map(() => true),
      'R-81l 逐步结果与规划顺序一致（每步 ok）');
    eq(env.calls.map((c) => `${c.name}:${c.action}`),
      SPECIMEN_STEPS.map((s) => `${s.call_name}:${s.action}`),
      'R-81m ★★执行账与计划逐步对齐（名字/动作/次序三件同）');
    eq(env.plans(), 2, 'R-81n 计划账 2 行（两跑各一）');
    eq(env.actions(), SPECIMEN_STEPS.length, 'R-81o ★设备动作账 0→2（与步数同）');

    await new Promise<void>((r) => server.close(() => r()));
    env.db.close();
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    let pinPass = 0;
    let pinFail = 0;
    checkBuildPins((cond, label, detail) => {
      ok(cond, label, detail);
      if (cond) pinPass += 1; else pinFail += 1;
    }, { distDir: path.join(root, A, 'dist') });
    eq(pinFail, 0, 'R-77 ★`checkBuildPins` P1–P6 全绿（0 红）', `绿 ${pinPass} / 红 ${pinFail}`);
    ok(pinPass >= 6, 'R-77b 至少六条判据真跑过（"没考"不算"考过"）', `实测 ${pinPass} 条`);
  }
}

main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_${SELF_ROUND} 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
