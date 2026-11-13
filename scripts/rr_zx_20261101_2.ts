/**
 * zx_20261101_2 受控复跑 —— 「接·衡」：一账号一 Provider，接得上也数得清。
 *
 * 本轮 M1 口径一句话（庄子·道在屎溺 ／ 管子·度量衡 ／ 维特根斯坦·意义即用法）：
 *   设备云不该只有一个写死的涂鸦账号；每个账号各自凭据、各自注册表 id、各自可测可同步，
 *   而**容量与档位**说得出"这档能接几个"。
 *
 * 已覆盖 M1（账号底座 + 涂鸦多账号 + Home Assistant REST）与 M2（控制回读 + 设备影子）。
 * 后续批次在各自完成时追加段落。
 *
 * ── M1 判据 ──────────────────────────────────────────────────────────────────
 *   §A 模型与凭据键：账号表 DDL 在 `database.ts`；`device.cloud.` 走密钥前缀；
 *      `providerIdFor` 旧账号保持裸 `tuya`、其余 `provider@account`；`baseProviderOf` 反解。
 *   §B 容量：`maxCloudAccounts` 三档读数（社区 0 / Pro 2 / Team 0=不限）；
 *      Pro 满额拒、Team 零上限放行——均调生产 `cloudAccountCapacityVerdict`，不复刻阈值。
 *   §C 注册表：`:` 是地址分隔符（当场拒）；`@` 允许；未注册 Provider 如实 `null`。
 *   §D 账号 CRUD：HA 地址只认 http/https 且拒 URL 内嵌账号密码；`config_json` 白名单**只留非密字段**；
 *      旧涂鸦三键迁移**幂等**且写密文失败不建行。
 *   §E HA REST：可控域才入设备清单（sensor 洪水反证）；动作→service 映射；注入 HTTP 验 URL/体/头；
 *      非 2xx 如实失败；`getState` 形状；`probeHaRest` 不回令牌。
 *   §F 涂鸦多账号：`createTuyaAccountProvider` 同一凭据**复用实例**（token 缓存常驻），换凭据才重建。
 *   §G 接线（`feedback_equivalence_needs_wiring_criterion`）：IPC 五个新通道在册；保存/测试/同步的 Pro 闸
 *      先于写入与网络；删除**不挂 Pro 闸**且连带清旧三键（否则迁移复活）；renderer 五个 API 真被页面调用。
 *   §M M6 档位强化（追加批次）：设备云账号的**显示语义**（社区「需专业版」而非「不限」，两向标本）；
 *      卖点兑现双向（`BENEFIT_COVERAGE` ↔ `PRICING`）；用量/升级差异含第八维；pending 候选卡过容量闸
 *      （有限档两侧判据 + 团队档 0=不限正路径 + 「先查旧行再判容量」接线形状）。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 *   G-1 调生产导出，不复刻等价物；G-2 两侧标本；G-5 静态判据读原文（去注释仅判"代码是否真调"）；
 *   G-6 零轮次字面量：本轮标识与方案路径由 `path.basename(__filename)` 派生。
 *   ⚠ 断言文案不得含失败字形（全量汇总器按日志字形计数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  CLOUD_ACCOUNT_PROVIDERS,
  CLOUD_ACCOUNT_SECRET_PREFIX,
  LEGACY_TUYA_ACCOUNT_ID,
  accountConfigProblem,
  baseProviderOf,
  cloudAccountCapacityVerdict,
  createCloudAccount,
  deleteCloudAccount,
  ensureLegacyTuyaAccount,
  getCloudAccount,
  listCloudAccounts,
  markCloudAccountSync,
  normalizeCloudBaseUrl,
  providerIdFor,
  sanitizeAccountConfig,
  secretKeyFor,
  secretKindOf,
  updateCloudAccount,
} from '../apps/worker-ant-desktop/src/main/core/device-cloud-accounts.js';
import { isSecretSettingKey } from '../apps/worker-ant-desktop/src/main/core/secret-settings.js';
import { LICENSE_TIERS, TIER_LABEL, TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import {
  CAPACITY_LABEL,
  CLOUD_ACCOUNT_MIN_TIER,
  capacityAvailable,
  capacityDisplay,
  capacityRefusal,
  countCloudAccounts,
} from '../apps/worker-ant-desktop/src/main/core/tier-capacity.js';
// M6: 档位强化——用量/升级差异/对照表/价目表一律调生产导出（G-1）。
import { tierUsageCounts, upgradeDifferences } from '../apps/worker-ant-desktop/src/main/core/tier-usage.js';
import { benefitCoverageProblems, tierCatalog } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { PRICING, capacityBenefit, capacityLine } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { TEAM_FEATURE_LABEL } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
import { recordPitfallCandidate } from '../apps/worker-ant-desktop/src/main/core/knowledge-cards.js';
import {
  cloudAddress,
  getDeviceProvider,
  registerDeviceProvider,
  unregisterDeviceProvider,
  syncProviderDevices,
  type DeviceProvider,
} from '../apps/worker-ant-desktop/src/main/core/device-provider.js';
// M2: 影子投影/期望态读写取 main 侧**零依赖语义模块**真源；回读走可注入模块（不触网）。
import {
  clearDeviceDesired,
  deviceLiveStateOf,
  deviceShadow,
  expectedStateTokensFor,
  getDevice,
  getDeviceDesired,
  markDeviceDesiredVerify,
  reportedStateTokensOf,
  setDeviceDesired,
  setDeviceLiveState,
  type AnsDevice,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  DEVICE_READBACK_TIMEOUT_MS,
  STATE_READBACK_PROTOCOLS,
  defaultDeviceStateReader,
  readbackAfterControl,
} from '../apps/worker-ant-desktop/src/main/core/device-readback.js';
import { createTuyaAccountProvider } from '../apps/worker-ant-desktop/src/main/core/providers/tuya-cloud.js';
import {
  HA_CONTROLLABLE_DOMAINS,
  HA_REST_PROVIDER_BASE,
  createHaRestProvider,
  haServiceData,
  haServiceFor,
  mapHaEntity,
  probeHaRest,
  registerHaAccountProvider,
  type HaHttp,
  type HaHttpResponse,
} from '../apps/worker-ant-desktop/src/main/core/providers/homeassistant-rest.js';
// M3: 项目级节点分工——纯判据/读写字/策略组装与派发接线**一律调生产导出**（G-1）。
import {
  PROJECT_NODES_DDL,
  buildDispatchPolicy,
  clampProjectRole,
  clampProjectWeight,
  listProjectNodeSettings,
  projectHasNodePolicy,
  projectNodeRoleOptions,
  replaceProjectNodeSettings,
  toWireDispatchPolicy,
} from '../apps/worker-ant-desktop/src/main/core/project-node-policy.js';
import {
  buildExistingTaskDispatchFacts,
  decideCreateDispatch,
  dispatchCreatedTask,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { dispatchNodeRequest, type DispatchIo } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
// M4: 远端确认失败后的有界改派——记账/选人/驱动集成一律调生产导出（G-1）。
import {
  REMOTE_ATTEMPTS_KEY,
  REMOTE_ATTEMPT_RECORDS_MAX,
  REMOTE_CATEGORY_KEY,
  REMOTE_DISPATCH_MAX,
  appendRemoteAttempt,
  markRemoteAssigned,
  markRemoteAttemptResult,
  remoteAttemptsOf,
  remoteCategoryOf,
  remoteTaskView,
} from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import { NODE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { attemptRedispatch } from '../apps/worker-ant-desktop/src/main/core/redispatch.js';
import { driveRemoteSubtasks } from '../apps/worker-ant-desktop/src/main/core/node-remote-driver.js';
import { orchestrationLabel, remoteAttemptsLabel } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
// M5: 记忆预算自适应（纯函数）与注入效果账（真 SQL）——一律调生产导出（G-1）。
import {
  MEMORY_BUDGET_BASE_MAX_CHARS,
  MEMORY_BUDGET_BASE_MIN_CHARS,
  MEMORY_BUDGET_DEFAULT_CHARS,
  MEMORY_BUDGET_MIN_CHARS,
  memoryBudgetCharsFor,
} from '../apps/worker-ant-desktop/src/main/core/memory-budget.js';
import { memoryInjectionStats } from '../apps/worker-ant-desktop/src/main/core/memory-injection-stats.js';
// ANS 侧同一把尺：网络入参收窄 + 自动选目标（both 生产导出，行为直跑）。
import { sanitizeDispatchPolicy, selectTargetNode } from '../apps/ans-server/src/routes/nodes.js';
import { NODE_ROLES, type AnsNode, type AnsNodeRequest, type NodeDispatchPolicy, type NodeRequestSubmit } from '@worker-ant/shared-types';
import type { NodeLedger } from '../apps/worker-ant-desktop/src/main/core/node-list.js';

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
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/* ── 夹具 DDL：照 `database.ts` 的列形（只建本套件读到的表） ─────────────── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'unknown', kind_class TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'mdns',
  address TEXT NOT NULL DEFAULT '', port INTEGER, capabilities_json TEXT NOT NULL DEFAULT '[]',
  controllable INTEGER NOT NULL DEFAULT 0, authorized INTEGER NOT NULL DEFAULT 0, status_json TEXT,
  desired_json TEXT,
  online INTEGER, first_seen TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL DEFAULT ''
);
CREATE TABLE wa_device_cloud_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_sync_error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_wa_device_cloud_accounts_pid ON wa_device_cloud_accounts(provider_id);
`;

function makeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}

interface HttpCall { url: string; method: string; headers: Record<string, string>; body?: string }
function recorder(handler: (call: HttpCall) => HaHttpResponse): { http: HaHttp; calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  const http: HaHttp = async (url, init) => {
    const call: HttpCall = { url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) };
    calls.push(call);
    return handler(call);
  };
  return { http, calls };
}
function jsonResponse(status: number, value: unknown): HaHttpResponse {
  return { status, body: JSON.stringify(value) };
}

/* ── M3 夹具：项目节点分工（建表引生产同一份 `PROJECT_NODES_DDL`） ─────────── */
/**
 * 桌面库夹具。`wa_settings`（入网/角色）与 `wa_tasks`（项目归属 + context_json）列形照
 *   `database.ts`；`wa_project_nodes` **引生产 DDL 真源**——夹具的建表若比生产宽，断言就只是自我印证。
 */
function policyDb(settings: Record<string, string> = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime(\'now\')))');
  d.exec(`CREATE TABLE wa_audit_events (
    id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '',
    parent_task_id TEXT DEFAULT '', acceptance_criteria TEXT DEFAULT '', quality_score REAL,
    updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(PROJECT_NODES_DDL);
  const ins = d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(settings)) ins.run(k, v);
  return d;
}

/** 已入网本机：身份 + 资源组 + 非占位凭据（`isNodeEnrolled` 的三条件）。 */
function enrolledPolicyDb(): DatabaseSync {
  return policyDb({ 'node.id': 'n-self', 'node.resource_group': 'node:n-self', 'node.role': 'primary', ans_api_key: 'wa_rr_enrolled_key' });
}

/** M4 夹具：在已入网库上补驱动/改派要写的两张表（会话留痕 + 不可变事件日志），并显式开启自动外派。 */
function redispatchDb(settings: Record<string, string> = {}): DatabaseSync {
  const d = enrolledPolicyDb();
  d.exec(`CREATE TABLE wa_event_log (
    id TEXT PRIMARY KEY, aggregate_type TEXT, aggregate_id TEXT, event_type TEXT,
    payload TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_task_conversations (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
  const ins = d.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)');
  ins.run(NODE_SETTING_KEYS.autoDispatchOnCreate, '1');
  for (const [k, v] of Object.entries(settings)) ins.run(k, v);
  return d;
}

const ctxJsonOf = (d: DatabaseSync, taskId: string): string =>
  (d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string }).context_json;
const statusOf = (d: DatabaseSync, taskId: string): string =>
  (d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status: string }).status;

const asBetter = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;
/** UTC 秒串（`isNodeOnline` 按库内 UTC 解析；不写绝对时刻字面量，由注入的 nowMs 派生）。 */
const utcSec = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** 台账行**真形状**（`AnsNode` 字段齐备；只改要验的那几项）。 */
function ansNode(nodeId: string, over: Partial<AnsNode> = {}): AnsNode {
  return {
    node_id: nodeId,
    name: nodeId,
    api_key_prefix: '',
    resource_group: `node:${nodeId}`,
    platform: 'darwin/arm64',
    role: 'worker',
    weight: 1,
    participate: true,
    capabilities: [],
    card: { name: nodeId, node_id: nodeId, platform: 'darwin/arm64', categories: ['project_task'] },
    status: null,
    enrolled_at: '2026-10-01 00:00:00',
    last_seen_at: null,
    ...over,
  };
}

/** ANS 请求行真形状（提交回包/读回共用）。 */
function ansRequest(over: Partial<AnsNodeRequest> = {}): AnsNodeRequest {
  return {
    id: 'req-J1', category: 'project_task', payload: {}, requester_key_prefix: 'rr00',
    requester_node_id: 'n-self', target_node_id: 'n-a', status: 'assigned', result: null,
    question: null, answer: null, question_status: null, selection: null, progress: null,
    cancel_requested: false, created_at: '2026-11-01 00:00:00', claimed_at: null, done_at: null,
    ...over,
  };
}

/** 假派发 IO：只记录提交体，不触网。 */
function fakeDispatchIo(): { io: DispatchIo; submits: NodeRequestSubmit[] } {
  const submits: NodeRequestSubmit[] = [];
  const io: DispatchIo = {
    async submit(req) { submits.push(req); return ansRequest(); },
    async get() { return ansRequest(); },
    async answer() { return ansRequest(); },
    async cancel() { return ansRequest(); },
  };
  return { io, submits };
}

/** ANS 节点台账夹具（列形照 `db/schema.ts` 的 `ans_nodes`；不在线由 SQL 的 `datetime('now')` 判）。 */
function ansDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE ans_nodes (
    id TEXT PRIMARY KEY, node_id TEXT UNIQUE NOT NULL, name TEXT DEFAULT '', api_key_prefix TEXT DEFAULT '',
    resource_group TEXT DEFAULT '', platform TEXT DEFAULT '', role TEXT DEFAULT 'worker', weight REAL DEFAULT 1.0,
    participate INTEGER DEFAULT 1, capabilities_json TEXT DEFAULT '[]', card_json TEXT DEFAULT '{}',
    status_json TEXT DEFAULT '{}', enrolled_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT, status TEXT DEFAULT 'active')`);
  return d;
}

/** 插一台 ANS 节点；`ratio` 缺省 = `status_json` 不含余力（unknown 层）。 */
function addAnsNode(
  d: DatabaseSync,
  nodeId: string,
  o: { weight?: number; ratio?: number | null; participate?: number; role?: string; categories?: string[]; lastSeenMod?: string; status?: string } = {},
): void {
  d.prepare(`INSERT INTO ans_nodes (id, node_id, name, role, weight, participate, card_json, status_json, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?)`)
    .run(
      `row-${nodeId}`, nodeId, nodeId, o.role ?? 'worker', o.weight ?? 1, o.participate ?? 1,
      JSON.stringify({ name: nodeId, node_id: nodeId, platform: 'darwin/arm64', categories: o.categories ?? ['project_task'] }),
      JSON.stringify(o.ratio === undefined || o.ratio === null ? {} : { capacity_free_ratio: o.ratio }),
      o.lastSeenMod ?? '+0 seconds', o.status ?? 'active',
    );
}

async function main(): Promise<void> {
  // ═══ A 模型 / 凭据键 ═══════════════════════════════════════════════════════
  console.log('\n【A】账号模型与凭据键');
  {
    const dbSrc = RD('apps/worker-ant-desktop/src/main/database.ts');
    ok(dbSrc.includes('CREATE TABLE IF NOT EXISTS wa_device_cloud_accounts'), 'A1 账号表 DDL 在 database.ts');
    ok(dbSrc.includes('idx_wa_device_cloud_accounts_pid'), 'A2 provider_id 唯一索引在册');
    ok(dbSrc.includes("CREATE INDEX IF NOT EXISTS idx_wa_device_cloud_accounts_provider"), 'A3 provider 索引在册');

    eq(CLOUD_ACCOUNT_SECRET_PREFIX, 'device.cloud.', 'A4 凭据键前缀取单一真源');
    ok(isSecretSettingKey(secretKeyFor('acc-1', 'secret')), 'A5 账号 secret 键被判为密钥');
    ok(isSecretSettingKey(secretKeyFor('acc-1', 'token')), 'A6 账号 token 键被判为密钥');
    ok(!isSecretSettingKey('device.tuya.access_id'), 'A7 非密键不被误判（反证）');

    eq(secretKindOf('tuya'), 'secret', 'A8 涂鸦凭据种类=secret');
    eq(secretKindOf('homeassistant'), 'token', 'A9 HA 凭据种类=token');

    eq(providerIdFor('tuya', LEGACY_TUYA_ACCOUNT_ID), 'tuya', 'A10 旧涂鸦账号保持裸 id（存量地址兼容）');
    eq(providerIdFor('tuya', 'acc-2'), 'tuya@acc-2', 'A11 新涂鸦账号用复合 id');
    eq(providerIdFor('homeassistant', 'acc-3'), 'homeassistant@acc-3', 'A12 HA 账号用复合 id');
    eq(baseProviderOf('tuya@acc-2'), 'tuya', 'A13 复合 id 反解基名');
    eq(baseProviderOf('tuya'), 'tuya', 'A14 裸 id 反解仍是自身');
    eq([...CLOUD_ACCOUNT_PROVIDERS], ['tuya', 'homeassistant'], 'A15 已落地厂商词表（未落地的不冒充）');

    eq(CAPACITY_LABEL.maxCloudAccounts, '设备云账号', 'A16 容量维度有中文标签（可上屏）');
  }

  // ═══ B 容量（三档） ═══════════════════════════════════════════════════════
  console.log('\n【B】设备云账号容量');
  {
    eq(TIER_LIMITS.community.maxCloudAccounts, 0, 'B1 社区档上限 0（产品口径；动作口由 Pro 闸先拦）');
    ok(TIER_LIMITS.pro.maxCloudAccounts > 0, 'B2 专业档有正上限');
    eq(TIER_LIMITS.team.maxCloudAccounts, 0, 'B3 团队档 0=不限');

    const db = makeDb();
    const ins = db.prepare(`INSERT INTO wa_device_cloud_accounts (id, provider, provider_id, label, config_json, enabled)
      VALUES (?, 'homeassistant', ?, 'ha', '{"base_url":"http://ha.local:8123"}', 1)`);
    eq(cloudAccountCapacityVerdict('pro', db).ok, true, 'B4 Pro 空额放行');
    for (let i = 0; i < TIER_LIMITS.pro.maxCloudAccounts; i++) ins.run(`acc-${i}`, `homeassistant@acc-${i}`);
    eq(cloudAccountCapacityVerdict('pro', db).ok, false, 'B5 Pro 满额拒');
    eq(cloudAccountCapacityVerdict('team', db).ok, true, 'B6 Team 0=不限，满额仍放行');
  }

  // ═══ C Provider 注册表 ═════════════════════════════════════════════════════
  console.log('\n【C】注册表与地址约定');
  {
    const stub: DeviceProvider = {
      id: 'stub-provider',
      label: 'stub',
      async listDevices() { return []; },
      async control() { return { ok: true, result: 'ok' }; },
    };
    let threw = '';
    try { registerDeviceProvider({ ...stub, id: 'bad:id' }); } catch (e) { threw = (e as Error).message; }
    ok(threw.includes('不能包含'), 'C1 注册表当场拒含冒号的 id（地址分隔符）', threw);

    let attrThrew = '';
    try { registerDeviceProvider({ ...stub, id: 'tuya@acc-z' }); } catch (e) { attrThrew = (e as Error).message; }
    eq(attrThrew, '', 'C2 复合 id 用 @ 允许注册');
    ok(getDeviceProvider('tuya@acc-z') != null, 'C3 复合 id 可取回');
    unregisterDeviceProvider('tuya@acc-z');
    eq(getDeviceProvider('tuya@acc-z'), null, 'C4 注销后如实 null');

    ok(cloudAddress('tuya@a', 'd1') !== cloudAddress('tuya@b', 'd1'), 'C5 不同账号同设备 id 不撞地址');
    ok(cloudAddress('tuya', 'd1') !== cloudAddress('tuya@a', 'd1'), 'C6 旧地址与新账号地址不撞');
  }

  // ═══ D 账号 CRUD / 白名单 / 旧配置迁移 ════════════════════════════════════
  console.log('\n【D】账号 CRUD、配置白名单与迁移');
  {
    eq(normalizeCloudBaseUrl('http://ha.local:8123/'), 'http://ha.local:8123', 'D1 去尾斜杠');
    eq(normalizeCloudBaseUrl('ftp://ha.local'), '', 'D2 只认 http/https（ftp 拒）');
    eq(normalizeCloudBaseUrl('http://user:pass@ha.local:8123'), '', 'D3 URL 内嵌账号密码拒');
    eq(normalizeCloudBaseUrl('not a url'), '', 'D4 非法地址拒');
    eq(normalizeCloudBaseUrl('http://ha.local:8123/?a=1#x'), 'http://ha.local:8123', 'D5 去查询与片段');

    const tuyaCfg = sanitizeAccountConfig('tuya', { region: 'cn', access_id: 'ak', access_secret: 'LEAK', token: 'LEAK' });
    eq(tuyaCfg, { region: 'cn', access_id: 'ak' }, 'D6 涂鸦配置白名单只留 region/access_id');
    const haCfg = sanitizeAccountConfig('homeassistant', { base_url: 'http://ha.local:8123/', token: 'LEAK' });
    eq(haCfg, { base_url: 'http://ha.local:8123' }, 'D7 HA 配置白名单只留 base_url');

    const db = makeDb();
    const badHa = createCloudAccount(db, { provider: 'homeassistant', config: { base_url: 'ftp://x' } });
    eq(badHa.ok, false, 'D8 HA 非法地址不建账号');
    const noUrl = createCloudAccount(db, { provider: 'homeassistant', config: {} });
    eq(noUrl.ok, false, 'D9 HA 缺地址不建账号');

    const leaked = createCloudAccount(db, {
      provider: 'tuya',
      label: '  ',
      config: { region: 'cn', access_id: 'ak-1', access_secret: 'PLAINTEXT-SECRET' },
    });
    ok(leaked.ok, 'D10 合法涂鸦账号可建');
    if (leaked.ok) {
      eq(leaked.account.label, '涂鸦云', 'D11 空标签回落到厂商默认名');
      const raw = db.prepare('SELECT config_json FROM wa_device_cloud_accounts WHERE id = ?').get(leaked.account.id) as { config_json: string };
      ok(!raw.config_json.includes('PLAINTEXT-SECRET'), 'D12 config_json 不含明文凭据');
      eq(accountConfigProblem(leaked.account), null, 'D13 涂鸦配置齐（有 access_id/region）');
    }

    const ha = createCloudAccount(db, { provider: 'homeassistant', label: '客厅 HA', config: { base_url: 'http://ha.local:8123/' } });
    ok(ha.ok, 'D14 合法 HA 账号可建');
    if (ha.ok) {
      eq(ha.account.config.base_url, 'http://ha.local:8123', 'D15 账号行的地址已归一');
      eq(baseProviderOf(ha.account.providerId), 'homeassistant', 'D16 新账号注册表 id 是复合形态');
      const upd = updateCloudAccount(db, ha.account.id, { config: { base_url: 'ftp://bad' } });
      eq(upd.ok, false, 'D17 更新时非法 HA 地址同样拒');
      const upd2 = updateCloudAccount(db, ha.account.id, { label: '书房 HA', enabled: false });
      ok(upd2.ok && upd2.account.label === '书房 HA' && upd2.account.enabled === false, 'D18 标签/启用可更新');
      eq(updateCloudAccount(db, 'no-such-id', { label: 'x' }).ok, false, 'D19 不存在的账号更新如实拒');
    }
    eq(deleteCloudAccount(db, 'no-such-id'), null, 'D20 删除不存在的账号如实 null');

    // 旧涂鸦三键迁移：幂等 + 密文写入 + 失败不建行。
    const db2 = makeDb();
    let settings: Record<string, string> = {
      'device.tuya.access_id': 'legacy-ak',
      'device.tuya.access_secret': 'legacy-secret',
      'device.tuya.region': 'eu',
    };
    const writes: Array<{ key: string; value: string }> = [];
    const writeSecretOk = (_d: unknown, key: string, value: string) => { writes.push({ key, value }); return { ok: true }; };
    const first = ensureLegacyTuyaAccount(db2, (k) => settings[k] ?? null, writeSecretOk as never);
    ok(first.created && first.account?.providerId === 'tuya', 'D21 首次迁移建一行裸 tuya 账号');
    eq(first.account?.config, { region: 'eu', access_id: 'legacy-ak' }, 'D22 迁移保留旧区域与 Access ID');
    eq(writes.map((w) => w.key), [secretKeyFor(LEGACY_TUYA_ACCOUNT_ID, 'secret')], 'D23 旧 Secret 写成加密账号键');
    const second = ensureLegacyTuyaAccount(db2, (k) => settings[k] ?? null, writeSecretOk as never);
    ok(!second.created && writes.length === 1, 'D24 二次迁移幂等（不再写密文）');
    eq(settings['device.tuya.access_secret'], 'legacy-secret', 'D25 迁移不删旧键（可回退）');

    const db3 = makeDb();
    const failed = ensureLegacyTuyaAccount(db3, (k) => settings[k] ?? null, (() => ({ ok: false, error: 'no-keychain' })) as never);
    eq(failed.account, null, 'D26 密文写不进时不建账号行');
    ok(!!failed.warning && listCloudAccounts(db3).length === 0, 'D27 迁移失败如实告警且空表');

    // 同步观测：失败留着原因、成功清空。
    const db4 = makeDb();
    const acc = createCloudAccount(db4, { provider: 'homeassistant', config: { base_url: 'http://ha.local:8123' } });
    if (acc.ok) {
      markCloudAccountSync(db4, acc.account.id, 'boom');
      eq(getCloudAccount(db4, acc.account.id)?.lastSyncError, 'boom', 'D28 同步失败原因落库');
      markCloudAccountSync(db4, acc.account.id, null);
      eq(getCloudAccount(db4, acc.account.id)?.lastSyncError, '', 'D29 同步成功后清空原因');
    }
  }

  // ═══ E Home Assistant REST ════════════════════════════════════════════════
  console.log('\n【E】Home Assistant REST 适配层');
  {
    eq(HA_REST_PROVIDER_BASE, 'homeassistant', 'E1 Provider 基名固定');
    ok((HA_CONTROLLABLE_DOMAINS as readonly string[]).includes('light'), 'E2 可控域含 light');
    ok(!(HA_CONTROLLABLE_DOMAINS as readonly string[]).includes('sensor'), 'E3 传感器域不入设备清单（反证）');

    const light = mapHaEntity({
      entity_id: 'light.living',
      attributes: { friendly_name: '客厅灯', device_class: 'outlet' },
    });
    ok(light != null && light.id === 'light.living' && light.name === '客厅灯' && light.controllable === true,
      'E4 可控实体映射成设备（名取 friendly_name）');
    ok(!!light?.kindClass, 'E5 派生类目由唯一归一函数给出', light?.kindClass);
    eq(mapHaEntity({ entity_id: 'sensor.temp', attributes: { friendly_name: '温度' } }), null,
      'E6 传感器不当作设备');
    eq(mapHaEntity({ entity_id: 'binary_sensor.door', attributes: {} }), null, 'E7 二进制传感器不当作设备');
    eq(mapHaEntity({ entity_id: 'light.hidden', attributes: { hidden: true } }), null, 'E8 隐藏实体不入清单');
    eq(mapHaEntity({ entity_id: 'Light.Bad', attributes: {} }), null, 'E9 非法实体 id 不造行');
    const cover = mapHaEntity({ entity_id: 'cover.garage', attributes: { device_class: 'garage' } });
    eq(cover?.capabilities, ['open', 'close'], 'E10 cover 能力是开/关');

    eq(haServiceFor('light.living', 'turn_on', {}), { domain: 'light', service: 'turn_on' }, 'E11 turn_on 映射');
    eq(haServiceFor('cover.garage', 'open', {}), { domain: 'cover', service: 'open_cover' }, 'E12 open 映射 open_cover');
    eq(haServiceFor('light.living', 'dance', {}), { error: 'HA 不支持的动作：dance（可传 args.service 覆盖）' }, 'E13 未知动作如实拒');
    eq(haServiceFor('light.living', 'x', { service: 'turn_off' }), { domain: 'light', service: 'turn_off' }, 'E14 args.service 可覆盖');
    ok('error' in haServiceFor('light.living', 'x', { service: '../evil' }), 'E15 覆盖服务名过白名单');
    eq(haServiceData({ service: 'turn_on', brightness: 128 }), { brightness: 128 }, 'E16 控制载荷剥掉 service');

    const list = recorder(() => jsonResponse(200, [
      { entity_id: 'light.living', attributes: { friendly_name: '客厅灯' } },
      { entity_id: 'switch.kettle', attributes: { friendly_name: '水壶' } },
      { entity_id: 'sensor.temp', attributes: {} },
    ]));
    const provider = createHaRestProvider({ baseUrl: 'http://ha.local:8123/', token: 'tok-1' }, { http: list.http });
    const devices = await provider.listDevices();
    eq(devices.map((d) => d.id), ['light.living', 'switch.kettle'], 'E17 列表只收可控域');
    eq(list.calls[0]?.url, 'http://ha.local:8123/api/states', 'E18 列表 URL 归一（无尾斜杠）');
    eq(list.calls[0]?.headers.Authorization, 'Bearer tok-1', 'E19 令牌走 Bearer 头');

    const fail500 = recorder(() => jsonResponse(500, { message: 'boom' }));
    let listThrew = '';
    try { await createHaRestProvider({ baseUrl: 'http://ha.local:8123', token: 't' }, { http: fail500.http }).listDevices(); }
    catch (e) { listThrew = (e as Error).message; }
    ok(listThrew.includes('HTTP 500'), 'E20 列表非 2xx 如实抛（由同步层收成空态+原因）', listThrew);

    const ctl = recorder(() => jsonResponse(200, []));
    const ctlProvider = createHaRestProvider({ baseUrl: 'http://ha.local:8123', token: 'tok-1' }, { http: ctl.http });
    const ctlRes = await ctlProvider.control('light.living', 'turn_on', { service: 'turn_on', brightness: 200 });
    ok(ctlRes.ok, 'E21 控制成功');
    eq(ctl.calls[0]?.url, 'http://ha.local:8123/api/services/light/turn_on', 'E22 控制 URL 是 services/<domain>/<service>');
    eq(JSON.parse(ctl.calls[0]?.body ?? '{}'), { entity_id: 'light.living', brightness: 200 }, 'E23 控制体含 entity_id 且不含 service');

    const ctlBad = recorder(() => jsonResponse(503, ''));
    const badRes = await createHaRestProvider({ baseUrl: 'http://ha.local:8123', token: 't' }, { http: ctlBad.http })
      .control('light.living', 'turn_on', {});
    ok(!badRes.ok && badRes.result.includes('HTTP 503'), 'E24 控制非 2xx 回 ok:false（不抛）', badRes.result);

    const st = recorder(() => jsonResponse(200, { state: 'on', attributes: { brightness: 100 }, last_changed: '2026-11-01T00:00:00Z' }));
    const stRes = await createHaRestProvider({ baseUrl: 'http://ha.local:8123', token: 't' }, { http: st.http })
      .getState!('light.living');
    ok(stRes.ok && stRes.state?.state === 'on' && (stRes.state?.attributes as Record<string, unknown>)?.brightness === 100,
      'E25 状态查询原样透传 state/attributes');
    eq(st.calls[0]?.url, 'http://ha.local:8123/api/states/light.living', 'E26 状态 URL 含实体 id');

    const probe = recorder(() => jsonResponse(200, [{ entity_id: 'light.a' }, { entity_id: 'sensor.b' }]));
    const probeRes = await probeHaRest({ baseUrl: 'http://ha.local:8123/', token: 'SECRET-TOKEN' }, { http: probe.http });
    ok(probeRes.ok && probeRes.deviceCount === 2 && probeRes.detail.includes('2 个实体'), 'E27 探活读到实体数');
    ok(!JSON.stringify(probeRes).includes('SECRET-TOKEN'), 'E28 探活回包不含令牌');
    const probe401 = await probeHaRest({ baseUrl: 'http://ha.local:8123', token: 't' },
      { http: async () => jsonResponse(401, 'Unauthorized') });
    ok(!probe401.ok && probe401.detail.includes('401'), 'E29 探活 401 如实失败');
    const probeBad = await probeHaRest({ baseUrl: 'ftp://x', token: 't' });
    ok(!probeBad.ok && probeBad.detail.includes('http/https'), 'E30 非法地址探活如实拒');

    let reads = 0;
    const configured = recorder(() => { reads++; return jsonResponse(200, [{ entity_id: 'light.a', attributes: {} }]); });
    const lazy = registerHaAccountProvider('homeassistant@lazy', 'HA · lazy', () => {
      reads++;
      return { baseUrl: 'http://ha.local:8123', token: 't' };
    }, { http: configured.http });
    eq((await lazy.listDevices()).length, 1, 'E31 账号 Provider 每次现读配置并列表');
    ok(reads >= 2, 'E32 配置不是建实例时就固定（换凭据即时生效）');
    const noCfg = registerHaAccountProvider('homeassistant@none', 'HA · none', () => null, { http: configured.http });
    let noCfgThrew = '';
    try { await noCfg.listDevices(); } catch (e) { noCfgThrew = (e as Error).message; }
    ok(noCfgThrew.includes('缺少地址或访问令牌'), 'E33 无配置列表如实抛');
    const noCfgCtl = await noCfg.control('light.a', 'turn_on', {});
    ok(!noCfgCtl.ok && noCfgCtl.result.includes('缺少地址'), 'E34 无配置控制如实拒');
    const noCfgState = await noCfg.getState!('light.a');
    ok(!noCfgState.ok && noCfgState.unsupported === true, 'E35 无配置状态查询标 unsupported（不编状态）');
    unregisterDeviceProvider('homeassistant@lazy');
    unregisterDeviceProvider('homeassistant@none');
  }

  // ═══ F 涂鸦多账号：实例级 token 缓存常驻 ══════════════════════════════════
  console.log('\n【F】涂鸦账号 Provider 的 token 缓存');
  {
    let config = { region: 'cn' as const, accessId: 'ak-1', accessSecret: 'sk-1' };
    const tokenCalls: string[] = [];
    const http = async (url: string) => {
      if (url.includes('/v1.0/token')) {
        tokenCalls.push(url);
        return { status: 200, body: JSON.stringify({ success: true, result: { access_token: `tok-${tokenCalls.length}`, expire_time: 7200 } }) };
      }
      return { status: 200, body: JSON.stringify({ success: true, result: { devices: [{ id: 'd1', name: '灯', category: 'dj', status: [{ code: 'switch_1' }] }], has_more: false } }) };
    };
    const fixedNow = () => new Date('2026-11-01T00:00:00Z');
    const p = createTuyaAccountProvider('tuya@acc-f', '涂鸦 · 测试', () => config, { http, now: fixedNow });
    const first = await p.listDevices();
    eq(first.map((d) => d.id), ['d1'], 'F1 复合 id Provider 能列设备');
    await p.listDevices();
    eq(tokenCalls.length, 1, 'F2 同凭据两次列表只取一次令牌（缓存常驻）');
    config = { region: 'cn', accessId: 'ak-2', accessSecret: 'sk-2' };
    await p.listDevices();
    eq(tokenCalls.length, 2, 'F3 凭据变更才重建实例并重取令牌');
    unregisterDeviceProvider('tuya@acc-f');
  }

  // ═══ G 同步语义：skipped 如实计数 ═════════════════════════════════════════
  console.log('\n【G】同步入账（幂等 + skipped 字段）');
  {
    const db = makeDb();
    const stub: DeviceProvider = {
      id: 'stub-sync',
      label: 'stub',
      async listDevices() {
        return [
          { id: 'a', name: '甲', kind: 'light', capabilities: ['turn_on'], controllable: true },
          { id: 'b', name: '乙', kind: 'switch', capabilities: ['turn_on'], controllable: true },
        ];
      },
      async control() { return { ok: true, result: 'ok' }; },
    };
    const r1 = await syncProviderDevices(db, stub, '2026-11-01 00:00:00');
    ok(r1.ok && r1.added === 2 && r1.updated === 0 && r1.skipped === 0, 'G1 首次同步新增 2 台');
    const r2 = await syncProviderDevices(db, stub, '2026-11-01 00:01:00');
    ok(r2.ok && r2.added === 0 && r2.updated === 2 && r2.rows.every((row) => !row.isNew), 'G2 二次同步是刷新不是新增');
    eq(db.prepare("SELECT COUNT(*) AS c FROM wa_devices WHERE protocol='cloud'").get(), { c: 2 }, 'G3 台账只留两份（幂等）');
  }

  // ═══ H 接线（静态） ═══════════════════════════════════════════════════════
  console.log('\n【H】IPC / renderer 接线');
  {
    const ipc = CODE('apps/worker-ant-desktop/src/main/ipc/devices.ipc.ts');
    for (const ch of ['cloud_accounts', 'cloud_account_save', 'cloud_account_delete', 'cloud_account_test', 'cloud_account_sync']) {
      ok(ipc.includes(`'devices:${ch}'`), `H1 IPC 通道在册：${ch}`);
    }

    const blockOf = (start: string, src: string): string => {
      const at = src.indexOf(start);
      if (at < 0) return '';
      const next = src.indexOf('ipcMain.handle', at + start.length);
      return src.slice(at, next < 0 ? undefined : next);
    };

    const save = blockOf("'devices:cloud_account_save'", ipc);
    const saveGate = save.indexOf('proFeatureRefusal');
    ok(saveGate > 0 && saveGate < save.indexOf('createCloudAccount'), 'H2 保存：Pro 闸先于建行');
    ok(save.indexOf('cloudAccountCapacityVerdict') > saveGate, 'H3 保存：容量闸在 Pro 闸之后、建行之前');
    ok(save.indexOf('deleteCloudAccount(ddb, created') > 0, 'H4 保存：密文写失败回滚新建账号行');

    const del = blockOf("'devices:cloud_account_delete'", ipc);
    ok(del.length > 0 && !del.includes('proFeatureRefusal'), 'H5 删除不挂 Pro 闸（档位过期仍可清理）');
    ok(del.includes('unregisterDeviceProvider(account.providerId)'), 'H6 删除时注销 Provider');
    ok(['TUYA_SETTING_ACCESS_ID', 'TUYA_SETTING_ACCESS_SECRET', 'TUYA_SETTING_REGION'].every((k) => del.includes(k)),
      'H7 删除旧涂鸦账号连带清旧三键（防迁移复活）');
    ok(del.includes('substr(address, 1, ?)'), 'H8 删除按 provider 地址前缀清设备');

    const test = blockOf("'devices:cloud_account_test'", ipc);
    const testGate = test.indexOf('proFeatureRefusal');
    ok(testGate > 0 && testGate < test.indexOf('probeTuya') && testGate < test.indexOf('probeHaRest'),
      'H9 测试：Pro 闸先于任何网络调用');

    const sync = blockOf("'devices:cloud_account_sync'", ipc);
    const syncGate = sync.indexOf('proFeatureRefusal');
    ok(syncGate > 0 && syncGate < sync.indexOf('getDeviceProvider(account.providerId)'), 'H10 单账号同步：Pro 闸先于选路');
    ok(sync.includes('markCloudAccountSync(ddb, id, result.error)') && sync.includes('markCloudAccountSync(ddb, id, null)'),
      'H11 单账号同步成功/失败都记账');
    ok(sync.includes("eventBus.emit('device.discovered'"), 'H12 同步后发设备发现事件（面板实时刷新）');

    const allSync = blockOf("'devices:cloud_sync'", ipc);
    ok(allSync.includes('Promise.all') && allSync.includes('markCloudAccountSync'), 'H13 全部同步并发跑且逐账号记账');
    ok(allSync.indexOf('accounts.length === 0') > 0 && allSync.includes('resolveTuyaConfig'), 'H14 无账号行时保留旧单账号路径兼容');

    const view = ipc.slice(ipc.indexOf('const accountView'), ipc.indexOf('// zx_20261101_2 M1: 旧涂鸦三键'));
    ok(view.length > 0 && view.includes('secretSet') && !view.includes('access_secret') && !view.includes('token:'),
      'H15 账号回包只说配没配（不含凭据）');
    ok(view.includes('configProblem') && view.includes('deviceCount'), 'H16 账号回包含配置缺口与设备数');

    ok(ipc.includes('ensureLegacyTuyaAccount(ddb, settingsGet') && ipc.includes('for (const account of listCloudAccounts(ddb))'),
      'H17 启动时迁移旧账号并注册全部账号 Provider');

    const rIpc = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
    for (const m of ['cloudAccounts', 'cloudAccountSave', 'cloudAccountDelete', 'cloudAccountTest', 'cloudAccountSync']) {
      ok(rIpc.includes(`${m}:`), `H18 renderer API 在册：${m}`);
    }
    ok(rIpc.includes("'devices:cloud_account_save'") && rIpc.includes('CloudAccountView'), 'H19 renderer 通道与类型对齐');

    const page = CODE('apps/worker-ant-desktop/renderer/src/pages/DevicesPage.tsx');
    ok(page.includes('devicesApi.cloudAccounts()'), 'H20 设备页真读账号列表');
    ok(page.includes('devicesApi.cloudAccountSave(') && page.includes('devicesApi.cloudAccountSync('),
      'H21 设备页真调保存与同步');
    ok(page.includes('devicesApi.cloudAccountTest(') && page.includes('devicesApi.cloudAccountDelete('),
      'H22 设备页真调测试与删除');
    ok(page.includes('baseProviderIdOf('), 'H23 设备来源标签按基名识别复合 id');
    ok(page.includes('homeassistant'), 'H24 界面词表含 HA（新增入口可达）');
  }

  // ═══ I 设备影子 + 控制后有界回读 ══════════════════════════════════════════
  console.log('\n【I】设备影子（期望态 vs 实况）与有界回读');
  {
    // 影子是**纯投影**：期望态与实况各存各的列（`desired_json` / `status_json.live`），
    //   本段只用内存库喂两个方向（相符/不符/判不了），不触网。
    eq(expectedStateTokensFor('turn_on'), ['on', 'open', 'opening', 'true'], 'I1 开动作的期望词含 on');
    eq(expectedStateTokensFor('TURN_OFF'), ['off', 'closed', 'closing', 'false'], 'I2 关动作大小写归一');
    eq(expectedStateTokensFor('set_color'), null, 'I3 表外动作不猜（null=判不了）');

    eq(reportedStateTokensOf({ state: 'ON', attributes: {}, at: 'x', source: 'state' }), ['on'], 'I4 实况主状态归一');
    eq(reportedStateTokensOf({ state: '', attributes: { state: 'Closed' }, at: 'x', source: 'attributes' }), ['closed'],
      'I5 属性里的 state 键也算实况');
    eq(reportedStateTokensOf({ state: '', attributes: { values: { switch_1: true } }, at: 'x', source: 'attributes' }), null,
      'I6 多开关嵌套值不猜（反证：涂鸦 values 不被当单开关）');
    eq(reportedStateTokensOf(null), null, 'I7 无实况 ⇒ null');

    const db = makeDb();
    db.prepare(`INSERT INTO wa_devices (id, name, alias, room, kind, kind_class, protocol, address, port,
      capabilities_json, controllable, authorized, status_json, desired_json, online, first_seen, last_seen)
      VALUES ('m2-dev', '灯', '', '', 'light', 'light', 'cloud', 'tuya@acc-1:d1', NULL, '[]', 1, 1, NULL, NULL, 1,
        '2026-11-01 00:00:00', '2026-11-01 00:00:00')`).run();
    const base = getDevice(db, 'm2-dev');
    ok(base != null, 'I8 夹具设备在册');

    eq(deviceShadow(base!).desired, null, 'I9 没有期望态 ⇒ desired=null');
    eq(deviceShadow(base!).match, null, 'I10 没有期望态 ⇒ 不判（null，不是 false）');

    setDeviceDesired(db, 'm2-dev', {
      action: 'turn_on', args: {}, actor: { kind: 'panel', ref: 'p1' }, ok: true, result: 'ok', at: '2026-11-01 10:00:00',
    });
    setDeviceLiveState(db, 'm2-dev', { source: 'provider', state: 'on' }, '2026-11-01 10:00:05');
    let dev = getDevice(db, 'm2-dev')!;
    eq(deviceShadow(dev).match, true, 'I11 实况不早于下发且状态对上 ⇒ 相符');
    eq(deviceShadow(dev).reportedAt, '2026-11-01 10:00:05', 'I12 影子带实况时刻');

    setDeviceLiveState(db, 'm2-dev', { source: 'provider', state: 'off' }, '2026-11-01 10:00:06');
    eq(deviceShadow(getDevice(db, 'm2-dev')!).match, false, 'I13 实况明确相反 ⇒ 不符');

    // 旧实况：早于本次下发 ⇒ 判不了（拿旧状态判新命令就是冤案）。
    setDeviceLiveState(db, 'm2-dev', { source: 'provider', state: 'on' }, '2026-11-01 09:59:59');
    eq(deviceShadow(getDevice(db, 'm2-dev')!).match, null, 'I14 实况早于下发 ⇒ 不判');

    // 回读核验失败 ⇒ 即使状态碰巧对上也不冒充"相符"。
    setDeviceLiveState(db, 'm2-dev', { source: 'provider', state: 'on' }, '2026-11-01 10:00:07');
    markDeviceDesiredVerify(db, 'm2-dev', { verify_error: '回读超时（>2500ms）' });
    const failed = getDevice(db, 'm2-dev')!;
    eq(deviceShadow(failed).match, null, 'I15 核验失败 ⇒ 不判');
    eq(failed.desired?.verify_error, '回读超时（>2500ms）', 'I16 失败原因如实留在影子里');

    // 成功核验与失败原因互斥；新期望必须重新核验（旧结论不得漂到新指令上）。
    markDeviceDesiredVerify(db, 'm2-dev', { reported_at: '2026-11-01 10:00:08' });
    const verified = getDevice(db, 'm2-dev')!;
    eq(verified.desired?.reported_at, '2026-11-01 10:00:08', 'I17 成功核验写时刻');
    ok(verified.desired?.verify_error === undefined, 'I18 成功核验清掉旧错误（两键互斥）');
    eq(deviceShadow(verified).match, true, 'I19 核验成功后同帧可判相符');
    eq(verified.desired?.action, 'turn_on', 'I20 核验只动两键，动作/发起者等兄弟键原样保留');
    eq(verified.desired?.actor, { kind: 'panel', ref: 'p1' }, 'I21 发起者未被核验写口抹掉');

    setDeviceDesired(db, 'm2-dev', { action: 'turn_off', args: {}, actor: { kind: 'panel' }, ok: true, result: 'ok', at: '2026-11-01 10:00:09' });
    const renewed = getDevice(db, 'm2-dev')!;
    eq(renewed.desired?.reported_at, undefined, 'I22 新期望清掉旧核验时刻');
    eq(renewed.desired?.verify_error, undefined, 'I23 新期望清掉旧核验错误');

    // 下发未成功（ok:false）不判相符——期望态正常只在成功分支写，这里反证判据自身成立。
    setDeviceDesired(db, 'm2-dev', { action: 'turn_off', args: {}, ok: false, result: 'timeout', at: '2026-11-01 10:00:10' });
    eq(deviceShadow(getDevice(db, 'm2-dev')!).match, null, 'I24 下发未成功 ⇒ 不判');

    // 清除期望不影响实况（两列各存各的）。
    clearDeviceDesired(db, 'm2-dev');
    const cleared = getDevice(db, 'm2-dev')!;
    eq(cleared.desired, null, 'I25 清期望后 desired=null');
    ok(deviceLiveStateOf(cleared.status) != null, 'I26 清期望不动实况（status_json.live 仍在）');

    // ── 有界回读 ──
    eq(DEVICE_READBACK_TIMEOUT_MS, 2500, 'I27 回读缺省超时 2500ms（计划上限）');
    eq(['cloud', 'miio'].filter((p) => STATE_READBACK_PROTOCOLS.has(p)), ['cloud', 'miio'],
      'I28 仅无实时订阅的协议回读');
    eq(['mqtt', 'ha', 'mdns', 'ssdp', 'http'].filter((p) => STATE_READBACK_PROTOCOLS.has(p)), [],
      'I29 有上行订阅/无需直查的协议不回读（反证）');

    const devForRead = getDevice(db, 'm2-dev')!;
    const fast = await readbackAfterControl(devForRead, { reader: async () => ({ ok: true, state: { state: 'on' } }) });
    eq(fast.ok, true, 'I30 注入读取器可成功回读');
    eq(fast.state, { state: 'on' }, 'I31 回读状态原样带回');

    const t0 = Date.now();
    const slow = await readbackAfterControl(devForRead, {
      timeoutMs: 25,
      reader: () => new Promise(() => { /* 永不返回：验有界 */ }),
    });
    const elapsed = Date.now() - t0;
    eq(slow.ok, false, 'I32 超时 ⇒ ok:false');
    ok(String(slow.error ?? '').includes('回读超时'), 'I33 超时如实说"回读超时"', String(slow.error));
    ok(elapsed < 1000, 'I34 回读有界（25ms 预算，实测 <1s）', `${elapsed}ms`);

    const thrown = await readbackAfterControl(devForRead, { reader: async () => { throw new Error('socket hang up'); } });
    eq(thrown.ok, false, 'I35 读取器抛错不外溢');
    ok(String(thrown.error ?? '').includes('回读失败'), 'I36 抛错收成"回读失败"结果', String(thrown.error));

    const noState = await readbackAfterControl({ ...devForRead, protocol: 'mqtt' } as AnsDevice);
    eq(noState.unsupported, true, 'I37 缺省读取器对无入口协议如实 unsupported');
    ok(String(noState.error ?? '').length > 0, 'I38 unsupported 也带可读原因（不谎报"回读成功"）');

    // ── 接线（feedback_equivalence_needs_wiring_criterion）──
    const dbSrc = RD('apps/worker-ant-desktop/src/main/database.ts');
    const waDevicesDdl = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS wa_devices'), dbSrc.indexOf('CREATE TABLE IF NOT EXISTS wa_devices') + 4000);
    ok(waDevicesDdl.includes('desired_json TEXT'), 'I39 建表含 desired_json（独立于 status_json）');
    ok(dbSrc.includes('ALTER TABLE wa_devices ADD COLUMN desired_json TEXT'), 'I40 存量库有迁移');

    const regSrc = CODE('apps/worker-ant-desktop/src/main/core/device-registry.ts');
    ok(regSrc.includes('desired_json') && regSrc.includes('desired: row.desired_json == null'), 'I41 台账行投影读期望态');

    const toolSrc = CODE('apps/worker-ant-desktop/src/main/core/tools/device.ts');
    const controlBlock = toolSrc.slice(toolSrc.indexOf('if (r.ok && dev)'), toolSrc.indexOf('return { ok: r.ok'));
    ok(controlBlock.includes('setDeviceDesired('), 'I42 控制成功写期望态');
    ok(controlBlock.includes('STATE_READBACK_PROTOCOLS.has(dev.protocol)'), 'I43 仅对需回读协议回读');
    ok(controlBlock.includes('readbackAfterControl('), 'I44 回读真被调用');
    ok(!/r\s*=\s*/.test(controlBlock) && !/r\.ok\s*=/.test(controlBlock), 'I45 回读失败不改控制结果（r 未被改写）');
    ok(toolSrc.includes('shadow: updated ? deviceShadow(updated) : null'), 'I46 控制后事件带影子');

    const ipcSrc = CODE('apps/worker-ant-desktop/src/main/ipc/devices.ipc.ts');
    ok(ipcSrc.includes('devices: listDevices(ddb).map((d) => ({ ...d, shadow: deviceShadow(d) }))'),
      'I47 devices:list 逐行带影子');
    ok(ipcSrc.includes('shadow: DeviceShadow'), 'I48 IPC 回包类型含影子');

    const rIpcSrc = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
    ok(rIpcSrc.includes('DeviceShadow'), 'I49 renderer 类型取 main 真源（DeviceShadow）');
    ok(rIpcSrc.includes('Array<AnsDevice & { shadow: DeviceShadow }>'), 'I50 设备列表载荷带影子字段');

    const pageSrc = CODE('apps/worker-ant-desktop/renderer/src/pages/DevicesPage.tsx');
    ok(pageSrc.includes('dev.shadow?.desired'), 'I51 设备页读影子');
    ok(['实况相符', '实况未跟到', '已下发·实况未核验'].every((s) => pageSrc.includes(s)),
      'I52 面板三态各有专名（不把"判不了"写成"不符"）');
    ok(pageSrc.includes('JSON.stringify(dev.shadow.desired)'), 'I53 原始期望态可展开查看');
  }

  // ═══ J 项目级节点分工 + 加权派发（M3） ══════════════════════════════════════
  //   口径：意义即用法——登记了才算数；未登记跟随全局。桌面算候选/倍率，ANS 只收窄/缩放、不重排。
  console.log('\n【J】项目级节点分工与加权派发（M3）');
  {
    // ── 收窄（脏值不冒充权重/角色）──
    eq(clampProjectWeight(0), 1, 'J1 权重下限夹到 1');
    eq(clampProjectWeight(99), 10, 'J2 权重上限夹到 10');
    eq(clampProjectWeight(3.4), 3, 'J3 权重四舍五入');
    eq(clampProjectWeight('7'), 7, 'J4 数字串可收窄');
    eq(clampProjectWeight('abc'), 1, 'J5 非数回落 1（脏值不冒充权重）');
    eq(clampProjectRole('primary'), 'primary', 'J6 合法角色原样保留');
    eq(clampProjectRole('ghost'), '', 'J7 表外角色不冒充（空=跟随全局）');
    eq(clampProjectRole(undefined), '', 'J8 缺省角色=跟随全局');

    // ── 词表（渲染层不手抄第二份）──
    const roleOpts = projectNodeRoleOptions();
    eq(roleOpts[0], { value: '', label: '跟随全局' }, 'J9 项目角色首项=跟随全局');
    eq(roleOpts.slice(1).map((o) => o.value), [...NODE_ROLES], 'J10 角色下拉逐个来自共享词表');
    ok(roleOpts.slice(1).every((o) => o.label.length > 0), 'J11 每个角色都有上屏名');

    // ── 表读写：整体替换 / 去重 / 收窄 / 空表语义 ──
    const db = policyDb();
    eq(projectHasNodePolicy(asBetter(db), 'p1'), false, 'J12 未登记 ⇒ 无项目分工');
    const written = replaceProjectNodeSettings(asBetter(db), 'p1', [
      { nodeId: 'n-a', weight: 3, role: 'worker' },
      { nodeId: 'n-b', participate: false, role: 'observer', weight: 99 },
      { nodeId: 'n-a', weight: 5 },
      { nodeId: '   ', weight: 2 },
    ]);
    eq(written, 2, 'J13 整体替换：去重/空 id 后写 2 行');
    eq(
      listProjectNodeSettings(asBetter(db), 'p1'),
      [
        { nodeId: 'n-a', participate: true, role: '', weight: 5 },
        { nodeId: 'n-b', participate: false, role: 'observer', weight: 10 },
      ],
      'J14 读回：重复以后者为准、越界值收窄',
    );
    eq(projectHasNodePolicy(asBetter(db), 'p1'), true, 'J15 有登记 ⇒ 显式分工成立');
    eq(projectHasNodePolicy(asBetter(db), 'p-other'), false, 'J16 别的项目不受影响');
    eq(replaceProjectNodeSettings(asBetter(db), 'p1', []), 0, 'J17 空列表是合法写入（本项目没有分工）');
    eq(projectHasNodePolicy(asBetter(db), 'p1'), false, 'J18 清空后回到跟随全局');
    eq(projectHasNodePolicy(asBetter(new DatabaseSync(':memory:')), 'p1'), false, 'J19 旧库缺表 ⇒ false（不拦旧路径）');

    // ── 策略组装：候选三闸 + 权重倍率 ──
    const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
    const recent = utcSec(nowMs - 10_000);
    const stale = utcSec(nowMs - 3_600_000);
    const pd = policyDb();
    replaceProjectNodeSettings(asBetter(pd), 'p1', [
      { nodeId: 'n-a', weight: 3 },
      { nodeId: 'n-follow', role: 'worker', weight: 1 },
      { nodeId: 'n-projobs', role: 'observer', weight: 4 },
      { nodeId: 'n-off', weight: 5 },
      { nodeId: 'n-obs', weight: 1 },
      { nodeId: 'n-part0', participate: false, weight: 7 },
      { nodeId: 'n-miss', weight: 1 },
    ]);
    const ledger: NodeLedger = {
      localNodeId: 'n-self',
      nodes: [
        ansNode('n-self', { role: 'primary', last_seen_at: recent }),
        ansNode('n-a', { last_seen_at: recent }),
        ansNode('n-follow', { last_seen_at: recent }),
        ansNode('n-projobs', { last_seen_at: recent }),
        ansNode('n-off', { last_seen_at: stale }),
        ansNode('n-obs', { role: 'observer', last_seen_at: recent }),
        ansNode('n-part0', { participate: false, last_seen_at: recent }),
        ansNode('n-miss', { card: { name: 'n-miss', node_id: 'n-miss', platform: 'x', categories: ['text'] }, last_seen_at: recent }),
        ansNode('n-follow2', { last_seen_at: recent }),
      ],
    };
    const pol = buildDispatchPolicy(asBetter(pd), 'p1', 'project_task', ledger, nowMs);
    ok(pol !== null, 'J20 有登记 ⇒ 产出派发策略');
    eq(pol?.candidateNodeIds, ['n-a', 'n-follow', 'n-follow2'],
      'J21 候选=非本机 ∧ 可派 ∧ 在线 ∧ 卡含类目 ∧ 项目未退出；未登记的跟随全局');
    eq(pol?.weightScale, { 'n-a': 3, 'n-off': 5, 'n-part0': 7, 'n-projobs': 4 }, 'J22 权重倍率只记非 1 的登记行');
    eq(buildDispatchPolicy(asBetter(pd), 'p1', 'media', ledger, nowMs)?.candidateNodeIds, [],
      'J23 类目无一命中 ⇒ 空候选（不是退回全局）');
    eq(buildDispatchPolicy(asBetter(pd), '', 'project_task', ledger, nowMs), null, 'J24 无项目 id ⇒ null（不动旧自动选）');
    eq(buildDispatchPolicy(asBetter(policyDb()), 'p1', 'project_task', ledger, nowMs), null, 'J25 无任何登记 ⇒ null');

    // ── 线上形状：唯一转换点 ──
    const wire = toWireDispatchPolicy({ candidateNodeIds: ['n-a'], weightScale: { 'n-a': 3 } });
    eq(wire, { candidate_node_ids: ['n-a'], weight_scale: { 'n-a': 3 } }, 'J26 线上形状走唯一转换点（snake_case）');
    ok(!('candidateNodeIds' in wire), 'J27 本地驼峰键不外泄到线上契约');

    // ── 准入判据：显式分工不被“本机有余力”挡回 ──
    const facts = {
      settingOn: true, autoDispatchSource: 'default' as const, localHasFreeSlot: true,
      teamUnlocked: true, enrolled: true, hasDependencies: false,
      hasAttachments: false, hasWorkingDir: false, decomposed: false, category: 'project_task' as const,
    };
    eq(decideCreateDispatch(facts).reason, 'local-capacity', 'J28 缺省开+本机有余力 ⇒ 不外派（旧行为不动）');
    eq(decideCreateDispatch({ ...facts, projectTargeted: true }).reason, 'eligible', 'J29 项目登记了分工 ⇒ 不受本机余力拦截');
    eq(decideCreateDispatch({ ...facts, autoDispatchSource: 'explicit' }).reason, 'eligible',
      'J30 显式开本就不受该闸（反证：新判据只作用于缺省）');
    eq(decideCreateDispatch({ ...facts, autoDispatchSource: 'explicit', projectTargeted: false }).reason, 'eligible',
      'J31 反证：projectTargeted=false 不改变显式开');

    // ── 提交体：策略原样落 `dispatch_policy` ──
    const { io: jio, submits: jsubs } = fakeDispatchIo();
    const jr = await dispatchNodeRequest(
      asBetter(enrolledPolicyDb()),
      { category: 'project_task', policy: { candidate_node_ids: ['n-a'], weight_scale: { 'n-a': 3 } } },
      { io: jio, emit: () => {} },
    );
    eq(jr.ok, true, 'J32 带策略的派发仍照常成功');
    eq(jsubs[0].dispatch_policy, { candidate_node_ids: ['n-a'], weight_scale: { 'n-a': 3 } },
      'J33 策略原样进入提交体 dispatch_policy');
    const { io: jio2, submits: jsubs2 } = fakeDispatchIo();
    await dispatchNodeRequest(asBetter(enrolledPolicyDb()), { category: 'project_task' }, { io: jio2, emit: () => {} });
    ok(!('dispatch_policy' in jsubs2[0]), 'J34 不给策略 ⇒ 提交体不带该键（反证）');

    // ── 建单即派：策略由库现读并随单交出 ──
    const taskDb = enrolledPolicyDb();
    taskDb.prepare("INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES ('t1','p1','写一份说明','','{}')").run();
    replaceProjectNodeSettings(asBetter(taskDb), 'p1', [{ nodeId: 'n-a', weight: 3 }]);
    const ledger2: NodeLedger = {
      localNodeId: 'n-self',
      nodes: [ansNode('n-self', { role: 'primary', last_seen_at: recent }), ansNode('n-a', { last_seen_at: recent })],
    };
    const { io: cio, submits: csubs } = fakeDispatchIo();
    const outcome = await dispatchCreatedTask(
      asBetter(taskDb),
      { id: 't1', title: '写一份说明' },
      facts,
      { listLedger: async () => ledger2, io: cio, emit: () => {}, nowMs },
    );
    eq(outcome.ok, true, 'J35 显式分工下建单即派成功');
    eq(csubs.length, 1, 'J36 恰一次提交（0→1 正面计数）');
    eq(csubs[0].dispatch_policy, { candidate_node_ids: ['n-a'], weight_scale: { 'n-a': 3 } },
      'J37 项目分工由库现读并随单交给 ANS');
    eq(csubs[0].require_target, true, 'J38 自动外派仍要求确定目标');

    const plainDb = enrolledPolicyDb();
    plainDb.prepare("INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES ('t2','p2','写一份说明','','{}')").run();
    const { io: pio, submits: psubs } = fakeDispatchIo();
    const plain = await dispatchCreatedTask(
      asBetter(plainDb),
      { id: 't2', title: '写一份说明' },
      facts,
      { listLedger: async () => ledger2, io: pio, emit: () => {}, nowMs },
    );
    eq(plain.reason, 'local-capacity', 'J39 反证：项目未登记 ⇒ 缺省开仍守“本机有余力不外派”');
    eq(psubs.length, 0, 'J40 反证：该情形一次也没提交');

    eq(buildExistingTaskDispatchFacts(asBetter(taskDb), 't1').projectTargeted, true, 'J41 已存在任务读事实：项目有登记');
    eq(buildExistingTaskDispatchFacts(asBetter(plainDb), 't2').projectTargeted, false, 'J42 反证：项目无登记');

    // ── ANS 入参收窄（网络来的脏值不改变筛选/排序）──
    eq(sanitizeDispatchPolicy(undefined), null, 'J43 无策略 ⇒ null');
    eq(sanitizeDispatchPolicy('x'), null, 'J44 非对象 ⇒ null');
    eq(sanitizeDispatchPolicy([]), null, 'J45 数组不是策略 ⇒ null');
    eq(sanitizeDispatchPolicy({}), null, 'J46 两项皆无 ⇒ null');
    eq(sanitizeDispatchPolicy({ candidate_node_ids: [' n-a ', 'n-a', '', 3, 'n-b'] }), { candidate_node_ids: ['n-a', 'n-b'] },
      'J47 白名单：trim/去重/非字符串剔除');
    eq(sanitizeDispatchPolicy({ candidate_node_ids: [] }), { candidate_node_ids: [] },
      'J48 空白名单原样保留（语义=本项目一个也不派）');
    const many = Array.from({ length: 120 }, (_, i) => `n-${i}`);
    eq((sanitizeDispatchPolicy({ candidate_node_ids: many }) as { candidate_node_ids: string[] }).candidate_node_ids.length, 100,
      'J49 白名单封顶 100');
    eq(sanitizeDispatchPolicy({ weight_scale: { 'n-a': 0.05, 'n-b': 99, 'n-c': 0, 'n-d': Number.NaN, 'n-e': '5' } }),
      { weight_scale: { 'n-a': 0.1, 'n-b': 10 } }, 'J50 倍率：夹 0.1..10、非正/非数丢弃');
    eq(sanitizeDispatchPolicy({ candidate_node_ids: 'oops' }), null, 'J51 白名单非数组 ⇒ 当没给（脏值不当白名单）');

    // ── ANS 自动选：收窄 + 层内缩放，不越层 ──
    const ad = ansDb();
    addAnsNode(ad, 'n-free-hi', { ratio: 0.9 });
    addAnsNode(ad, 'n-free-lo', { ratio: 0.5 });
    addAnsNode(ad, 'n-full', { ratio: 0 });
    addAnsNode(ad, 'n-offline', { ratio: 0.9, lastSeenMod: '-3600 seconds' });
    addAnsNode(ad, 'n-cardmiss', { ratio: 0.9, categories: ['text'] });
    addAnsNode(ad, 'n-observer', { ratio: 0.9, role: 'observer' });
    const pick = (policy?: NodeDispatchPolicy | null) => selectTargetNode(asBetter(ad), 'project_task', policy)?.row.node_id ?? null;
    eq(pick(), 'n-free-hi', 'J52 无策略：既有三层排序（有闲优先）不变');
    eq(pick({ candidate_node_ids: ['n-free-lo', 'n-full'], weight_scale: { 'n-full': 10 } }), 'n-free-lo',
      'J53 白名单收窄后仍按三层选（满负荷 10 倍权重不越层）');
    eq(pick({ weight_scale: { 'n-free-lo': 10 } }), 'n-free-lo', 'J54 层内加权真生效（0.5×10 > 0.9×1）');
    eq(pick({ candidate_node_ids: [] }), null, 'J55 空白名单 ⇒ 无人可派（调用方 409）');
    eq(pick({ candidate_node_ids: ['n-offline'] }), null, 'J56 白名单不豁免在线闸');
    eq(pick({ candidate_node_ids: ['n-cardmiss'] }), null, 'J57 白名单不豁免能力卡闸');
    eq(pick({ candidate_node_ids: ['n-observer'] }), null, 'J58 白名单不豁免观察者闸');
    eq(pick({}), 'n-free-hi', 'J59 空策略对象等同没给（不误收窄）');

    // ── 接线（feedback_equivalence_needs_wiring_criterion：三层各钉一跳）──
    const dbSrc = RD('apps/worker-ant-desktop/src/main/database.ts');
    ok(dbSrc.includes('db.exec(PROJECT_NODES_DDL)'), 'J60 生产建表引同一份 DDL 真源');
    ok(PROJECT_NODES_DDL.includes('PRIMARY KEY (project_id, node_id)'), 'J61 一项目一节点一行');

    const ansNodesSrc = CODE('apps/ans-server/src/routes/nodes.ts');
    ok(ansNodesSrc.includes('const policy = sanitizeDispatchPolicy(body.dispatch_policy)'), 'J62 ANS 提交口先收窄策略');
    ok(ansNodesSrc.includes('selectTargetNode(db, body.category, policy)'), 'J63 收窄后的策略真被用于自动选');
    const candIdx = ansNodesSrc.indexOf('policy?.candidate_node_ids !== undefined');
    const reqIdx = ansNodesSrc.indexOf('body.require_target === true');
    ok(candIdx > 0 && reqIdx > candIdx, 'J64 空白名单 409 先于 require_target 分支（各说各的因）');
    ok(ansNodesSrc.includes('dispatch_policy: t.Optional(t.Any())'), 'J65 提交体放行 dispatch_policy 字段');
    ok(ansNodesSrc.includes('const pool = filterRankCandidates(rows, policy?.candidate_node_ids)'),
      'J66 候选收窄只做成员判定');

    const dispSrc = CODE('apps/worker-ant-desktop/src/main/core/node-dispatcher.ts');
    ok(dispSrc.includes('...(input.policy !== undefined ? { dispatch_policy: input.policy } : {})'),
      'J67 派发器把策略映射到提交体');

    const collabSrc = CODE('apps/worker-ant-desktop/src/main/core/collab-dispatch.ts');
    ok(collabSrc.includes('...(policy ? { policy: toWireDispatchPolicy(policy) } : {})'), 'J68 建单即派组装并传递策略');
    ok(collabSrc.includes('f.projectTargeted !== true'), 'J69 显式分工不被“本机有余力”挡回');

    const ipcSrc = CODE('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
    ok(ipcSrc.includes("ipcMain.handle('project:node_policy_get'"), 'J70 读口在册');
    ok(ipcSrc.includes("ipcMain.handle('project:node_policy_set'"), 'J71 写口在册');
    const setBlock = ipcSrc.slice(ipcSrc.indexOf("ipcMain.handle('project:node_policy_set'"));
    const gateAt = setBlock.indexOf("teamFeatureRefusal(db as unknown as LicenseSettingDb, 'multi_node')");
    ok(gateAt >= 0 && gateAt < setBlock.indexOf('replaceProjectNodeSettings('), 'J72 写口 Team 闸先于写入');

    const rIpcSrc = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
    ok(rIpcSrc.includes("'project:node_policy_get'") && rIpcSrc.includes("'project:node_policy_set'"),
      'J73 渲染层两个 API 真调这两个通道');
    const pageSrc = CODE('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx');
    ok(pageSrc.includes('<NodeDivisionCard projectId={id!} />'), 'J74 项目详情页挂载分工卡');
    const cardSrc = CODE('apps/worker-ant-desktop/renderer/src/components/NodeDivisionCard.tsx');
    ok(['节点分工', '保存分工', '清空（跟随全局）', '本机'].every((s) => cardSrc.includes(s)), 'J75 分工卡文案在册');
    ok(cardSrc.includes('projects.nodePolicy.set(projectId, [])'), 'J76 清空=写空列表（回到跟随全局）');
    ok(cardSrc.includes('role_options'), 'J77 角色词表随载荷下发（渲染层不手抄第二份）');
  }

  // ═══ K 远端确认失败后的有界改派（M4） ══════════════════════════════════════
  console.log('\n【K】M4 远端确认失败有界改派（只对已确认失败；超时不改派；不重试同一台）');
  {
    const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
    const recent = utcSec(nowMs - 10_000);
    const ledger: NodeLedger = {
      localNodeId: 'n-self',
      nodes: [
        ansNode('n-self', { role: 'primary', last_seen_at: recent }),
        ansNode('n-a', { last_seen_at: recent }),
        ansNode('n-b', { last_seen_at: recent }),
      ],
    };
    const addTask = (d: DatabaseSync, id: string, title = '写一份说明') => {
      d.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, acceptance_criteria, status, context_json)
        VALUES (?, 'p1', ?, '', '', 'pending', '{}')`).run(id, title);
    };
    /** 假 IO：`get` 固定回传一单；`submit` 记录提交体并回传新单（不触网）。 */
    const ioFor = (getReq: AnsNodeRequest, newReq?: { target: string; requestId: string }) => {
      const submits: NodeRequestSubmit[] = [];
      const io: DispatchIo = {
        async submit(req) {
          submits.push(req);
          if (!newReq) throw new Error('submit-unexpected');
          return ansRequest({ id: newReq.requestId, target_node_id: newReq.target, status: 'assigned' });
        },
        async get() { return getReq; },
        async answer() { throw new Error('unused-answer'); },
        async cancel() { throw new Error('unused-cancel'); },
      };
      return { io, submits };
    };

    // ── 账本读写：坏形状不伪造、首派即记、结局按 requestId 定位 ──
    eq(
      remoteAttemptsOf('{"remote_attempts":[{"nodeId":"n-a","requestId":"rq-1"},{"nodeId":3},{"bad":1}]}'),
      [{ nodeId: 'n-a', requestId: 'rq-1', at: '', result: 'dispatched' }],
      'K1 尝试账：字段不齐/坏形状一律丢弃；缺省 result=dispatched',
    );
    const dA = redispatchDb();
    addTask(dA, 'TA');
    dA.prepare("UPDATE wa_tasks SET context_json = ? WHERE id = 'TA'").run(JSON.stringify({ sibling: 'keep' }));
    markRemoteAssigned(asBetter(dA), 'TA', { nodeId: 'n-a', requestId: 'rq-1' }, undefined, { category: 'project_task' });
    eq(remoteCategoryOf(ctxJsonOf(dA, 'TA')), 'project_task', 'K2 首派即记类目（改派按同一把尺选人）');
    const ctxA = JSON.parse(ctxJsonOf(dA, 'TA')) as Record<string, unknown>;
    eq(ctxA.sibling, 'keep', 'K3 记账是读-改-写整份：兄弟键不被抹');
    eq(remoteAttemptsOf(ctxJsonOf(dA, 'TA'))[0]!.result, 'dispatched', 'K4 首派落一条 dispatched 尝试');
    for (let i = 2; i <= 7; i++) {
      appendRemoteAttempt(asBetter(dA), 'TA', { nodeId: `n-${i}`, requestId: `rq-${i}`, at: `t${i}`, result: 'dispatched' });
    }
    eq(remoteAttemptsOf(ctxJsonOf(dA, 'TA')).length, REMOTE_ATTEMPT_RECORDS_MAX, 'K5 尝试账封顶（丢最旧，避免 JSON 无限长）');
    eq(markRemoteAttemptResult(asBetter(dA), 'TA', 'rq-7', 'failed', '远端真失败'), true, 'K6 结局改到对应那一条');
    eq(remoteAttemptsOf(ctxJsonOf(dA, 'TA')).at(-1), { nodeId: 'n-7', requestId: 'rq-7', at: 't7', result: 'failed', reason: '远端真失败' },
      'K7 按 requestId 定位最后一条并带原因');
    eq(markRemoteAttemptResult(asBetter(dA), 'TA', 'rq-nope', 'failed'), false, 'K8 反证：没派过的单不新建假记录');

    // ── 有界改派：换一台、不重试同一台、上限封顶 ──
    const d1 = redispatchDb();
    addTask(d1, 'T1');
    markRemoteAssigned(asBetter(d1), 'T1', { nodeId: 'n-a', requestId: 'rq-1' }, undefined, { category: 'project_task' });
    const k1io = ioFor(ansRequest({ id: 'rq-1', status: 'error' }), { target: 'n-b', requestId: 'rq-2' });
    const k1 = await attemptRedispatch(
      asBetter(d1), 'T1', { nodeId: 'n-a', requestId: 'rq-1', reason: '远端真失败' },
      { listLedger: async () => ledger, io: k1io.io, emit: () => {}, nowMs },
    );
    eq([k1.ok, k1.toNode, k1.requestId, k1.attempt], [true, 'n-b', 'rq-2', 1], 'K9 确认失败 ⇒ 换一台再派（第 1 次改派）');
    eq(k1io.submits.length, 1, 'K10 恰一次重新提交（0→1 正面计数）');
    eq(k1io.submits[0]!.dispatch_policy, { candidate_node_ids: ['n-b'], weight_scale: {} },
      'K11 候选剔除已试节点（同一把尺：在线 + 能力卡含类目）');
    eq(k1io.submits[0]!.require_target, true, 'K12 改派同样要求确定目标（不落无人认领的单）');
    const ctx1 = JSON.parse(ctxJsonOf(d1, 'T1')) as Record<string, unknown>;
    eq([ctx1.assigned_node_id, ctx1.assigned_request_id], ['n-b', 'rq-2'], 'K13 新归属落三键，任务仍 pending（不改任务状态）');
    eq(remoteAttemptsOf(ctxJsonOf(d1, 'T1')).map((a) => [a.nodeId, a.result]),
      [['n-a', 'failed'], ['n-b', 'dispatched']], 'K14 尝试账如实记失败→改派');

    const d2 = redispatchDb();
    addTask(d2, 'T2');
    markRemoteAssigned(asBetter(d2), 'T2', { nodeId: 'n-a', requestId: 'rq-1' }, undefined, { category: 'project_task' });
    const k2io = ioFor(ansRequest({ id: 'rq-1', status: 'error' }), { target: 'n-b', requestId: 'rq-2' });
    const k2 = await attemptRedispatch(
      asBetter(d2), 'T2', { nodeId: 'n-a', requestId: 'rq-1', reason: 'x' },
      { listLedger: async () => ({ localNodeId: 'n-self', nodes: [ansNode('n-self', { role: 'primary', last_seen_at: recent }), ansNode('n-a', { last_seen_at: recent })] }), io: k2io.io, emit: () => {}, nowMs },
    );
    eq([k2.ok, k2.reason, k2io.submits.length], [false, 'no-candidate', 0], 'K15 只剩已试过的那台 ⇒ 不改派（不硬塞，零提交）');

    const d3 = redispatchDb();
    addTask(d3, 'T3');
    markRemoteAssigned(asBetter(d3), 'T3', { nodeId: 'n-a', requestId: 'rq-1' }, undefined, { category: 'project_task' });
    appendRemoteAttempt(asBetter(d3), 'T3', { nodeId: 'n-b', requestId: 'rq-2', at: 't', result: 'failed' });
    appendRemoteAttempt(asBetter(d3), 'T3', { nodeId: 'n-c', requestId: 'rq-3', at: 't', result: 'failed' });
    const k3io = ioFor(ansRequest({ id: 'rq-1', status: 'error' }), { target: 'n-b', requestId: 'rq-4' });
    const k3 = await attemptRedispatch(
      asBetter(d3), 'T3', { nodeId: 'n-a', requestId: 'rq-1', reason: 'x' },
      { listLedger: async () => ledger, io: k3io.io, emit: () => {}, nowMs },
    );
    eq([k3.ok, k3.reason, k3io.submits.length], [false, 'attempts-exhausted', 0],
      `K16 首派+改派满 ${REMOTE_DISPATCH_MAX} 次 ⇒ 如实交回原失败收口`);

    const d4 = redispatchDb({ [NODE_SETTING_KEYS.autoDispatchOnCreate]: '0' });
    addTask(d4, 'T4');
    markRemoteAssigned(asBetter(d4), 'T4', { nodeId: 'n-a', requestId: 'rq-1' }, undefined, { category: 'project_task' });
    const k4io = ioFor(ansRequest({ id: 'rq-1', status: 'error' }), { target: 'n-b', requestId: 'rq-2' });
    const k4 = await attemptRedispatch(
      asBetter(d4), 'T4', { nodeId: 'n-a', requestId: 'rq-1', reason: 'x' },
      { listLedger: async () => ledger, io: k4io.io, emit: () => {}, nowMs },
    );
    eq([k4.ok, k4.reason, k4io.submits.length], [false, 'auto-dispatch-off', 0], 'K17 自动外派关着 ⇒ 不再自动换人');

    // ── 驱动集成：error/回执不符改派；超时不改派；老调用方（无台账源）行为不变 ──
    const d5 = redispatchDb();
    addTask(d5, 'T5');
    markRemoteAssigned(asBetter(d5), 'T5', { nodeId: 'n-a', requestId: 'rq-5' }, undefined, { category: 'project_task' });
    const k5io = ioFor(ansRequest({ id: 'rq-5', status: 'error', result: { error: '远端真失败' } }), { target: 'n-b', requestId: 'rq-6' });
    const ev5: string[] = [];
    const r5 = await driveRemoteSubtasks(asBetter(d5), {
      io: k5io.io, listLedger: async () => ledger, emit: (t) => { ev5.push(t); return true; },
      enqueue: async () => '', now: () => nowMs,
    });
    eq([r5.redispatched, r5.failed, statusOf(d5, 'T5')], [1, 0, 'pending'], 'K18 远端 error ⇒ 驱动改派成功，本拍不置 failed');
    eq(JSON.parse(ctxJsonOf(d5, 'T5')).assigned_node_id, 'n-b', 'K19 端到端：新归属真落库（不是只记了账）');
    ok(ev5.includes('task.remote_redispatched') && !ev5.includes('task.failed'), 'K20 改派成功 emit 改派事件且不 emit 失败');

    const d6 = redispatchDb();
    addTask(d6, 'T6');
    markRemoteAssigned(asBetter(d6), 'T6', { nodeId: 'n-a', requestId: 'rq-7' }, undefined, { category: 'project_task' });
    const k6io = ioFor(ansRequest({ id: 'rq-7', status: 'done', result: { taskId: '别的任务', taskStatus: 'completed' } }), { target: 'n-b', requestId: 'rq-8' });
    const r6 = await driveRemoteSubtasks(asBetter(d6), { io: k6io.io, listLedger: async () => ledger, emit: () => true, enqueue: async () => '', now: () => nowMs });
    eq([r6.redispatched, r6.failed], [1, 0], 'K21 回执不符＝已确认失败 ⇒ 同样先试改派');

    const d7 = redispatchDb();
    addTask(d7, 'T7');
    const oldAt = new Date(nowMs - 60_000).toISOString();
    markRemoteAssigned(asBetter(d7), 'T7', { nodeId: 'n-a', requestId: 'rq-9' }, oldAt, { category: 'project_task' });
    const k7io = ioFor(ansRequest({ id: 'rq-9', status: 'assigned' }), { target: 'n-b', requestId: 'rq-10' });
    let ledgerRead = 0;
    const r7 = await driveRemoteSubtasks(asBetter(d7), {
      io: k7io.io, listLedger: async () => { ledgerRead++; return ledger; }, emit: () => true,
      enqueue: async () => '', now: () => nowMs, timeoutMs: 1000,
    });
    eq([r7.reclaimed, r7.redispatched, k7io.submits.length, ledgerRead], [1, 0, 0, 0],
      'K22 超时不改派（对端可能还在跑）——连台账都不读，只撤归属退回本机');
    eq(remoteAttemptsOf(ctxJsonOf(d7, 'T7'))[0]!.result, 'timeout', 'K23 超时如实记为 timeout 尝试结局');

    const d8 = redispatchDb();
    addTask(d8, 'T8');
    markRemoteAssigned(asBetter(d8), 'T8', { nodeId: 'n-a', requestId: 'rq-11' }, undefined, { category: 'project_task' });
    const k8io = ioFor(ansRequest({ id: 'rq-11', status: 'error', result: { error: 'boom' } }), { target: 'n-b', requestId: 'rq-12' });
    const r8 = await driveRemoteSubtasks(asBetter(d8), { io: k8io.io, emit: () => true, enqueue: async () => '', now: () => nowMs });
    eq([r8.redispatched, r8.failed, k8io.submits.length, statusOf(d8, 'T8')], [0, 1, 0, 'failed'],
      'K24 未注入台账源（老调用方）⇒ 不改派，行为与改派前一致');

    const d9 = redispatchDb();
    addTask(d9, 'T9');
    markRemoteAssigned(asBetter(d9), 'T9', { nodeId: 'n-a', requestId: 'rq-13' }, undefined, { category: 'project_task' });
    appendRemoteAttempt(asBetter(d9), 'T9', { nodeId: 'n-b', requestId: 'rq-14', at: 't', result: 'failed' });
    appendRemoteAttempt(asBetter(d9), 'T9', { nodeId: 'n-c', requestId: 'rq-15', at: 't', result: 'failed' });
    const k9io = ioFor(ansRequest({ id: 'rq-13', status: 'error', result: { error: 'boom' } }), { target: 'n-b', requestId: 'rq-16' });
    const r9 = await driveRemoteSubtasks(asBetter(d9), { io: k9io.io, listLedger: async () => ledger, emit: () => true, enqueue: async () => '', now: () => nowMs });
    eq([r9.redispatched, r9.failed, k9io.submits.length], [0, 1, 0], 'K25 改派上限用尽 ⇒ 如实 failed（不无限换人）');

    const d10 = redispatchDb();
    addTask(d10, 'T10');
    markRemoteAssigned(asBetter(d10), 'T10', { nodeId: 'n-a', requestId: 'rq-17' }, undefined, { category: 'project_task' });
    d10.prepare("INSERT INTO wa_event_log (id, aggregate_type, aggregate_id, event_type, payload) VALUES ('e1','task','T10','node.dispatch','{}')").run();
    const k10io = ioFor(ansRequest({ id: 'rq-17', status: 'done', result: { taskId: 'T10', taskStatus: 'completed', outputs: [{ name: 'a.md', type: 'document' }] } }));
    const r10 = await driveRemoteSubtasks(asBetter(d10), { io: k10io.io, listLedger: async () => ledger, emit: () => true, enqueue: async () => '', now: () => nowMs });
    eq([r10.completed, remoteAttemptsOf(ctxJsonOf(d10, 'T10'))[0]!.result], [1, 'done'], 'K26 远端 done ⇒ 尝试账如实收成 done');

    const d11 = redispatchDb();
    addTask(d11, 'T11');
    markRemoteAssigned(asBetter(d11), 'T11', { nodeId: 'n-a', requestId: 'rq-18' }, undefined, { category: 'project_task' });
    const k11io = ioFor(ansRequest({ id: 'rq-18', status: 'cancelled' }));
    const r11 = await driveRemoteSubtasks(asBetter(d11), { io: k11io.io, listLedger: async () => ledger, emit: () => true, enqueue: async () => '', now: () => nowMs });
    eq([r11.cancelled, remoteAttemptsOf(ctxJsonOf(d11, 'T11'))[0]!.result], [1, 'cancelled'], 'K27 远端 cancelled ⇒ 尝试账如实收成 cancelled');

    // ── 展示：旧行一字不改；有改派史才说"换过几台" ──
    const badgeOld = { nodeId: 'n-a', requestId: 'rq', assignedAt: 't', summary: '', resultAt: '' };
    eq(orchestrationLabel(badgeOld, 'pending', () => '甲机'), '已外派给 甲机 · 等待', 'K28 旧行无尝试账 ⇒ 徽标文案一字不改');
    eq(orchestrationLabel({ ...badgeOld, attempts: [
      { nodeId: 'n-a', requestId: 'rq1', at: 't', result: 'failed' },
      { nodeId: 'n-b', requestId: 'rq2', at: 't', result: 'dispatched' },
    ] }, 'pending', (id) => (id === 'n-b' ? '乙机' : '甲机')), '已改派 1 次 · 等待', 'K29 有改派史 ⇒ 徽标先说换过几台');
    eq(remoteAttemptsLabel([
      { nodeId: 'n-a', requestId: 'rq1', at: 't', result: 'failed', reason: 'x' },
      { nodeId: 'n-b', requestId: 'rq2', at: 't', result: 'dispatched' },
    ], (id) => (id === 'n-b' ? '乙机' : '甲机')), '甲机·失败 → 乙机·已派', 'K30 尝试链人话（节点名取不到时回落 id 前 8 位）');
    eq(remoteTaskView(JSON.stringify({ assigned_node_id: 'n-a', assigned_request_id: 'rq', assigned_at: 't' }))?.attempts, [],
      'K31 旧行（无尝试账）⇒ 空数组，不伪造记录');

    // ── 接线（feedback_equivalence_needs_wiring_criterion：生产装配那一跳按语句形状钉）──
    const drvSrc = CODE('apps/worker-ant-desktop/src/main/core/node-remote-driver.ts');
    eq((drvSrc.match(/if \(await tryRedispatch\(/g) ?? []).length, 2, 'K32 驱动只在两个"已确认失败"分支试改派');
    ok(drvSrc.includes("markRemoteAttemptResult(db as unknown as OrchestrateDb, taskId, assign.requestId, 'timeout')"),
      'K33 超时分支只记 timeout，不调用改派');
    const idxSrc = CODE('apps/worker-ant-desktop/src/main/index.ts');
    ok(idxSrc.includes('listLedger: () => fetchNodes(driverDb, ensureNodeIdentity(driverDb).id)'),
      'K34 真机心跳拍装配台账源（rr 不注入 ⇒ 老套件仍密封）');
    const busSrc = CODE('apps/worker-ant-desktop/src/main/core/event-bus.ts');
    ok(busSrc.includes("'task.remote_redispatched': { aggregate_type: 'task', idField: 'taskId' }"),
      'K35 改派事件进了聚合映射（只加 union 会静默不落库）');
    const collabSrc2 = CODE('apps/worker-ant-desktop/src/main/core/collab-dispatch.ts');
    // zx_20261104_3 M2：同一 meta 对象里再钉一份择机快照（比旧「只含 category」更紧：两键必须在同一对象）
    ok(/\{\s*category,\s*selection:\s*result\.selection\s*\}/.test(collabSrc2),
      'K36 首派把类目与择机快照一并写进尝试账（改派据此选人、详情有据可查）');
    const detailSrc = CODE('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
    ok(detailSrc.includes('remoteAttemptsLabel(c.remote.attempts, remoteNameOf)'), 'K37 任务详情下钻真显示外派记录');
  }

  // ═══ L 记忆自适应预算 + 注入效果账（M5） ═══════════════════════════════════
  console.log('\n【L】M5 记忆自适应预算（随窗口/体量）与注入效果账（字数/命中率/失败占比）');
  {
    // ── 预算边界：小窗口、小任务、超大窗口、非法输入 ──
    eq(memoryBudgetCharsFor({ contextWindowTokens: 128000, taskChars: 5000 }), MEMORY_BUDGET_BASE_MAX_CHARS,
      'L1 超大窗口 ⇒ 封顶 24000（不再随窗口无限涨）');
    eq(memoryBudgetCharsFor({ contextWindowTokens: 8192, taskChars: 5000 }), Math.round(8192 * 4 * 0.12),
      'L2 常规窗口 ⇒ 取窗口 12%');
    eq(memoryBudgetCharsFor({ contextWindowTokens: 8192, taskChars: 500 }), Math.round(Math.round(8192 * 4 * 0.12) * 0.6),
      'L3 小任务（<2000 字）⇒ 基准打 6 折');
    eq(memoryBudgetCharsFor({ contextWindowTokens: 4096, taskChars: 500 }), MEMORY_BUDGET_MIN_CHARS,
      'L4 小窗口 + 小任务 ⇒ 落到下限 2000（打折不得低于下限）');
    eq(memoryBudgetCharsFor({ contextWindowTokens: 1000, taskChars: 5000 }), MEMORY_BUDGET_MIN_CHARS,
      'L5 极小窗口 ⇒ 以下限 2000 为准（窗口 20% 不足下限时不反噬地板）');
    eq(memoryBudgetCharsFor({ contextWindowTokens: 0, taskChars: 5000 }), MEMORY_BUDGET_DEFAULT_CHARS,
      'L6 窗口非法（0）⇒ 回缺省 6000，不猜');
    eq(memoryBudgetCharsFor({ contextWindowTokens: Number.NaN, taskChars: 5000 }), MEMORY_BUDGET_DEFAULT_CHARS,
      'L7 窗口非法（NaN）⇒ 回缺省 6000');
    eq(memoryBudgetCharsFor({ contextWindowTokens: 8192, taskChars: Number.NaN }), Math.round(8192 * 4 * 0.12),
      'L8 任务体量量不出 ⇒ 不打折（量不出 ≠ 小任务）');
    ok(memoryBudgetCharsFor({ contextWindowTokens: 32000, taskChars: 5000 }) >= memoryBudgetCharsFor({ contextWindowTokens: 8000, taskChars: 5000 }),
      'L9 同条件下窗口越大预算不减（单调性）');
    ok(MEMORY_BUDGET_BASE_MIN_CHARS < MEMORY_BUDGET_BASE_MAX_CHARS && MEMORY_BUDGET_MIN_CHARS < MEMORY_BUDGET_BASE_MIN_CHARS,
      'L10 常量秩序：下限 < 基准下限 < 基准上限');

    // ── 接线：预算真被算出来、传下去、记进水位 ──
    const execCode = CODE('apps/worker-ant-desktop/src/main/core/agent-executor.ts');
    ok(execCode.includes('memoryBudgetCharsFor({') && execCode.includes('contextWindowTokens: ctxWindowForWater')
      && execCode.includes('taskChars:'), 'L11 预算按本次模型窗口与任务体量算（接线在册）');
    ok(execCode.includes('priorInjectedIds, memoryBudgetChars)'),
      'L12 `buildMemoryContext` 收到自适应预算（不再是常量）');
    ok(execCode.includes('memoryContext, memoryKnowledgeText, memoryBudgetChars,'),
      'L13 装配段收到同一预算（越界审计与真源同尺）');
    ok(execCode.includes('memory: estimateTokensFromChars(memoryBudgetChars)')
      && !execCode.includes('memory: estimateTokensFromChars(CTX_MEMORY_MAX_CHARS)'),
      'L14 七源账的记忆上限用实际预算（写死常量已撤）');
    ok(execCode.includes('memoryCtxSegmentChars, memoryBudgetChars,'),
      'L15 水位落 `memoryBudgetChars`（这次给了多少可核对）');
    ok(execCode.includes('export const CTX_MEMORY_MAX_CHARS = MEMORY_BUDGET_DEFAULT_CHARS;'),
      'L16 旧常量不再是第二份值：`CTX_MEMORY_MAX_CHARS` 由缺省常量派生');
    const execCtxCode = CODE('apps/worker-ant-desktop/src/main/core/exec-context.ts');
    ok(execCtxCode.includes('memoryBudgetChars?: number')
      && execCtxCode.includes('memoryBudgetChars = CTX_MEMORY_MAX_CHARS')
      && execCtxCode.includes('memoryContext.length > memoryBudgetChars'),
      'L17 装配越界审计用传入预算（缺省仍可取旧调用点）');

    // ── 注入效果账：真 SQL × 夹具三结局 ──
    type StatsDb = Parameters<typeof memoryInjectionStats>[0];
    const mkStatsDb = (withRows: boolean) => {
      const d = new DatabaseSync(':memory:');
      d.exec(`
        CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
        CREATE TABLE wa_memories (id TEXT PRIMARY KEY, use_count INTEGER DEFAULT 0);
        CREATE TABLE wa_context_injections (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
          chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
          outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT, updated_at TEXT);
      `);
      if (withRows) {
        d.exec(`
          INSERT INTO wa_tasks (id, project_id) VALUES ('t1','p-a'),('t2','p-a'),('t3','p-a'),('t4','p-b');
          INSERT INTO wa_memories (id, use_count) VALUES ('m1',2),('m2',0),('m3',5);
          INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, outcome) VALUES
            ('i1','t1','memory','m1',100,'completed'),
            ('i2','t2','memory','m2',50,'failed'),
            ('i3','t3','memory','m1',100,'pending'),
            ('i4','t4','memory','m3',300,'completed'),
            ('i5','t1','knowledge','k1',999,'completed');
        `);
      }
      return d;
    };
    const empty = memoryInjectionStats(mkStatsDb(false) as unknown as StatsDb);
    ok(empty.injected === 0 && empty.charsInjected === 0 && empty.hitRate === 0 && empty.failedShare === 0,
      'L18 空库：四值全 0 且不除零（无 NaN）');

    const statsDb = mkStatsDb(true);
    const all = memoryInjectionStats(statsDb as unknown as StatsDb);
    eq([all.injected, all.distinctMemories, all.usedTimes, all.completed, all.failed, all.pending],
      [4, 3, 7, 2, 1, 1], 'L19 全库：只认 source=memory（knowledge 行不计）');
    eq(all.charsInjected, 550, 'L20 charsInjected = 记忆注入字数和（0→550 正面计数）');
    eq(all.wasteChars, 50, 'L21 wasteChars = 仅失败结局的字符数');
    ok(Math.abs(all.hitRate - 7 / 3) < 1e-9, 'L22 hitRate = 主动引用/覆盖条数', String(all.hitRate));
    ok(Math.abs(all.failedShare - 1 / 4) < 1e-9, 'L23 failedShare = 失败任务注入行/总行', String(all.failedShare));

    const pa = memoryInjectionStats(statsDb as unknown as StatsDb, 'p-a');
    eq([pa.injected, pa.distinctMemories, pa.usedTimes, pa.charsInjected, pa.wasteChars, pa.failed],
      [3, 2, 2, 250, 50, 1], 'L24 按项目归集：p-a 三行（跨任务同记忆按唯一键各记一行）');
    ok(Math.abs(pa.hitRate - 1) < 1e-9 && Math.abs(pa.failedShare - 1 / 3) < 1e-9,
      'L25 p-a 命中率 2/2、失败占比 1/3（分母各是各的）');
    const pb = memoryInjectionStats(statsDb as unknown as StatsDb, 'p-b');
    eq([pb.injected, pb.charsInjected, pb.failed], [1, 300, 0], 'L26 p-b 只看自己的行');

    // ── 渲染接线：卡片真念这四个数、低命中给建议 ──
    const memPage = CODE('apps/worker-ant-desktop/renderer/src/pages/MemoriesPage.tsx');
    ok(['charsInjected', 'hitRate', 'failedShare', 'wasteChars'].every((k) => memPage.includes(k)),
      'L27 记忆页读四值（不是只改了后端）');
    ok(memPage.includes('命中偏低') && memPage.includes('降低记忆预算'),
      'L28 命中低时给出可执行建议');
    const rIpc = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
    ok(rIpc.includes('charsInjected') && rIpc.includes('hitRate'), 'L29 渲染层 IPC 类型与后端同形');
  }

  // ═══ M 档位强化（M6）：第八维容量 / 卖点兑现 / 用量与显示语义 ═══════════════
  console.log('\n【M】M6 档位强化：设备云账号第八维与卖点兑现');
  {
    // ── M-1 显示语义：唯一特判只属于设备云账号（两向标本） ──
    const cloudMin = TIER_LIMITS[CLOUD_ACCOUNT_MIN_TIER].maxCloudAccounts;
    ok(cloudMin > 0, 'M1 最低可用档由 TIER_LIMITS 派生（首个正上限档，不写死档名）', `${CLOUD_ACCOUNT_MIN_TIER} ${cloudMin}`);
    eq(capacityDisplay('community', 'maxCloudAccounts', '个'), `需${TIER_LABEL[CLOUD_ACCOUNT_MIN_TIER]}`,
      'M2 社区档上屏「需<档>」——0 是不可接入，不是不限');
    eq(capacityAvailable('community', 'maxCloudAccounts'), false, 'M3 社区档该维不可用');
    eq(capacityAvailable('pro', 'maxCloudAccounts'), true, 'M4 专业档可用');
    eq(capacityDisplay('pro', 'maxCloudAccounts', '个'), `${TIER_LIMITS.pro.maxCloudAccounts} 个`,
      'M5 专业档写具体数（由 TIER_LIMITS 派生，不写死）');
    eq(capacityDisplay('team', 'maxCloudAccounts', '个'), '不限', 'M6 团队档 0=不限');
    eq(capacityDisplay('community', 'maxDevices', '台'), `${TIER_LIMITS.community.maxDevices} 台`,
      'M7 ★反证：同一社区档其它维度照常写数（特判只属于设备云账号）');

    ok(LICENSE_TIERS.every((t) => capacityLine(t).includes('设备云账号')),
      'M8 价目表容量行八维齐备（逐档都含设备云账号）');
    ok(capacityLine('community').includes('设备云账号 需专业版') && !capacityLine('community').includes('设备云账号 不限'),
      'M9 ★社区档容量行不写「设备云账号 不限」（假话防线）');

    // ── M-2 卖点兑现：双向 + IM 授权台抬为一等卖点 ──
    for (const t of LICENSE_TIERS) {
      eq(benefitCoverageProblems(t, PRICING[t].benefits), [],
        `M10 ${t} 卖点逐条兑现（无未登记 / 未兑现 / 登记腐化）`);
    }
    const cloudProBenefit = capacityBenefit('设备云账号', TIER_LIMITS.pro.maxCloudAccounts, '个');
    const cloudTeamBenefit = capacityBenefit('设备云账号', TIER_LIMITS.team.maxCloudAccounts, '个');
    ok(PRICING.pro.benefits.includes(cloudProBenefit), 'M11 专业版价目表含设备云账号（句式与登记同引一处）');
    ok(PRICING.team.benefits.includes(cloudTeamBenefit), 'M12 团队版价目表含设备云账号（不限）');
    ok(PRICING.team.benefits.includes(TEAM_FEATURE_LABEL.approval_inbox), 'M13 IM 授权台抬为团队版一等卖点');
    const bad = [...PRICING.pro.benefits, '无限次魔法'];
    ok(benefitCoverageProblems('pro', bad).some((p) => p.includes('无限次魔法')),
      'M14 ★反面标本：无闸卖点被点名（登记不是免检）');
    const missing = PRICING.pro.benefits.filter((b) => b !== cloudProBenefit);
    ok(benefitCoverageProblems('pro', missing).some((p) => p.includes('设备云账号')),
      'M15 ★反面标本：卖点被删而登记仍在 ⇒ 点名（双向校验）');

    // ── M-3 用量读模型与升级差异（真 SQL） ──
    const TIER_USE_SCHEMA = `
      CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
      CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE wa_device_cloud_accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL, label TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT, last_sync_error TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_knowledge_cards (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5,
        tokens INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE UNIQUE INDEX idx_wa_knowledge_cards_key ON wa_knowledge_cards(project_id, kind, source, text);
    `;
    type UsageDb = Parameters<typeof tierUsageCounts>[0];
    const usageDb = new DatabaseSync(':memory:');
    usageDb.exec(TIER_USE_SCHEMA);
    const opts = { now: new Date('2026-11-01T02:00:00.000Z'), fingerprint: 'rr-fp' };
    const c0 = tierUsageCounts(usageDb as unknown as UsageDb, { ...opts, cpus: 4 });
    eq([c0.cloudAccounts.used, c0.cloudAccounts.limit, c0.cloudAccounts.minTierLabel],
      [0, TIER_LIMITS.community.maxCloudAccounts, TIER_LABEL[CLOUD_ACCOUNT_MIN_TIER]],
      'M16 社区档用量：0 且带「需<档>」标（不把不可接入写成 0/0 不限）');
    usageDb.prepare(`INSERT INTO wa_device_cloud_accounts (id, provider, provider_id, label)
      VALUES ('a1', 'homeassistant', 'homeassistant@a1', 'ha')`).run();
    eq(countCloudAccounts(usageDb as unknown as Parameters<typeof countCloudAccounts>[0]), 1,
      'M17 计数 0→1（正面值，不以不抛代替）');
    // 试用起算点用**相对当前时刻**：写死日期会在 14 天后到点引爆（本轮 2026-11-13 实测）。
    usageDb.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const c1 = tierUsageCounts(usageDb as unknown as UsageDb, { ...opts, cpus: 4 });
    eq([c1.tier, c1.cloudAccounts.used, c1.cloudAccounts.limit, c1.cloudAccounts.minTierLabel],
      [tierCatalog().trial.grantsTier, 1, TIER_LIMITS.team.maxCloudAccounts, null],
      'M18 试用（团队档）：用量 1 条、0=不限、无「需档」标');

    const toPro = upgradeDifferences('community', 'pro').quotas;
    ok(toPro.includes(`设备云账号 ${TIER_LIMITS.pro.maxCloudAccounts} 个`),
      'M19 社区→专业升级差异列第八维（数字由 TIER_LIMITS 派生）');
    const toTeam = upgradeDifferences('pro', 'team').quotas;
    ok(toTeam.includes(TIER_LIMITS.team.maxCloudAccounts === 0
      ? '不限设备云账号' : `设备云账号 ${TIER_LIMITS.team.maxCloudAccounts} 个`),
      'M20 专业→团队升级差异列「不限设备云账号」');

    // ── M-4 pending 候选卡过容量闸（试用＝团队档；有限档的拒/放由同一判据两向标本） ──
    const kdb = new DatabaseSync(':memory:');
    kdb.exec(TIER_USE_SCHEMA);
    kdb.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const cardCount = () => (kdb.prepare('SELECT COUNT(*) AS c FROM wa_knowledge_cards').get() as { c: number }).c;
    const kdbAny = kdb as unknown as Parameters<typeof recordPitfallCandidate>[0];
    const first = recordPitfallCandidate(kdbAny, 'p1', { taskTitle: '甲', failedItems: '未覆盖尾注' });
    ok(first && cardCount() === 1, 'M21 未满额：候选卡落库（0→1 正面计数）');
    const again = recordPitfallCandidate(kdbAny, 'p1', { taskTitle: '甲', failedItems: '未覆盖尾注' });
    ok(again && cardCount() === 1, 'M22 同文本重报走更新路径（ON CONFLICT 不再新增）');
    // 两向标本：填到 Pro 的有限上限之后，团队档（0=不限）照常落新卡——上限随档位走，不是写死 24。
    const fill = kdb.prepare(`INSERT INTO wa_knowledge_cards (id, project_id, kind, text, source, tokens, status)
      VALUES (?, 'p1', 'lesson', ?, 'distill', 1, 'active')`);
    for (let i = cardCount(); i < TIER_LIMITS.pro.maxKnowledgeCardsPerProject; i++) fill.run(`k${i}`, `条目 ${i}`);
    eq(cardCount(), TIER_LIMITS.pro.maxKnowledgeCardsPerProject, 'M23 填到 Pro 上限（由 TIER_LIMITS 派生，不写死张数）');
    const beyondProCap = recordPitfallCandidate(kdbAny, 'p1', { taskTitle: '乙', failedItems: '另一处失败' });
    ok(beyondProCap && cardCount() === TIER_LIMITS.pro.maxKnowledgeCardsPerProject + 1,
      'M24 团队档 0=不限：越过 Pro 上限仍落卡（同一判据随档位走）');
    // 有限档（Pro）的拒/放：直接调生产判据，两侧标本（已用 23 ⇒ 放、已用 24 ⇒ 拒）。
    const cap = TIER_LIMITS.pro.maxKnowledgeCardsPerProject;
    ok(capacityRefusal('pro', 'maxKnowledgeCardsPerProject', cap - 1).ok
      && !capacityRefusal('pro', 'maxKnowledgeCardsPerProject', cap).ok,
      'M25 ★Pro 容量判据两侧：已用 23 放行 / 已用 24 拒绝（上限是天花板，由 TIER_LIMITS 派生）');
    // 「只拦新行」的接线形状（行为面受许可验签所限，只能以团队档跑正路径 + 静态钉序补证）。
    const kcSrc = CODE('apps/worker-ant-desktop/src/main/core/knowledge-cards.ts');
    const existingAt = kcSrc.indexOf("SELECT 1 AS hit FROM wa_knowledge_cards");
    const capacityAt = kcSrc.indexOf("capacityRefusal(", existingAt);
    ok(existingAt > 0 && capacityAt > existingAt,
      'M26 同文本先查旧行、再判容量（重复上报不被满额挡掉）');

    // ── M-5 接线：前端真念、动作口闸序、用量同引一处 ──
    const settingsSrc = CODE('apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');
    ok(settingsSrc.includes('usage.cloudAccounts.minTierLabel') && settingsSrc.includes('设备云账号'),
      'M27 设置页用量条：社区档显示「需<档>」而非 0/0');
    ok(settingsSrc.includes('t.capacity'), 'M28 付费权益卡显示派生容量行（后端加了，前端真念）');
    const devicesSrc = CODE('apps/worker-ant-desktop/src/main/ipc/devices.ipc.ts');
    const proAt = devicesSrc.indexOf("proFeatureRefusal(licDb, 'device_discovery')");
    // 只认**调用处**：文件头的 `import { …, cloudAccountCapacityVerdict, … }` 也会命中裸名。
    const gateAt = devicesSrc.indexOf('cloudAccountCapacityVerdict(', proAt);
    const createAt = devicesSrc.indexOf('createCloudAccount(', gateAt);
    ok(proAt > 0 && gateAt > proAt && createAt > gateAt,
      'M29 动作口闸序：Pro 发现闸 → 容量闸 → 建行（社区档先被 Pro 闸拦）');
    const usageSrc = CODE('apps/worker-ant-desktop/src/main/core/tier-usage.ts');
    ok(usageSrc.includes("minTierLabel: capacityAvailable(tier, 'maxCloudAccounts')"),
      'M30 用量读模型用同一特判（显示语义不各写一句）');
  }

  // ═══ S 哑雷自检 + build 钉 ════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = CODE(`scripts/${path.basename(__filename)}`);
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });
  }
}

// ⚠ `catch` 不可省：抛异常时若只挂 `finally`，进程会被 unhandled rejection 带走 ⇒ 假绿。
(async () => {
  try {
    await main();
  } catch (e: unknown) {
    console.error(`\n💥 rr_zx_20261101_2 未捕获异常（复跑尚未跑完，不得读作通过）：`, e);
    fail++;
  } finally {
    console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261101_2: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
