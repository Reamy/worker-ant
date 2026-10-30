/**
 * zx_20261004 受控复跑 —— 「同人于野」（从"独在于窗"到"共在于野"）。
 *
 * 本文件按**实施排期**逐批转绿（`RR_STAGE=Mn` 只要求 ≤Mn 的批次为绿，更晚的批次打 ⏳ 不计入失败；
 * `RR_STAGE` 为空 = 全部须绿，收口用）。批序见下方 `ORDER`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M1 判据（批一 · 地基）——「一节点一 key」登册与接线。
 *   病根（`plans/improve/zx_20261004.md` §1.1）：工蚁**对"另一个工蚁"没有概念**——无节点注册表、
 *   无身份、无令牌。M1 建 `ans_nodes` + `ans_enrollment_tokens` 两表与 `/api/v1/nodes/*` 端点；
 *   注册端点**不能**在 HMAC 组内（先有 key 才能签名的鸡生蛋）⇒ 拆两个构造器：注册走令牌闸（公开组），
 *   其余走 HMAC。判据钉**接线那一跳的形状**（公开组 vs hmacApi 组各挂哪一个），不只钉"文件存在"。
 *
 * §M2 判据（批一 · 地基）——「本机身份 + 环境如实上报」。
 *   身份幂等：`ensureNodeIdentity` 二调**同值**（否则"同一台机器"在 ANS 上增殖成幽灵节点）；
 *   环境采集字段齐备且忙闲分母取 `PROJECT_CONCURRENCY_DEFAULT` **一处真源**（不另抄 3）；
 *   忙闲比 **0→1 正面断言**（0 running ⇒ 0；满并发 running ⇒ 1；done 行**不**计入——两侧标本）。
 *   接线：自助注册排在 `resolveAnsCreds` **之前**（否则本 session 仍以缺省身份出场，K-5 名存实亡）；
 *   心跳排在 `registerAllJobs` 之后且 stop 时清定时器。
 *
 * §M3 判据（批一 · 地基）——「在线/离线同一把尺 + 如实上报」。
 *   `NODE_OFFLINE_SEC` **一处定义**（扫面自证 + 零重复硬编码）；`stale_since` **两侧标本**
 *   （停跳后出现 / 恢复后消失，且恢复那一跳把缺口起点捎进载荷）；失败**不静默**（`ansFailureNote` 形状留痕）。
 *
 * §M4…§M15 由后续批次补。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数、不自造等价实现**：身份/采集/心跳一律调生产导出，不照抄一份"等价物"。
 *   G-2 **两侧标本**：只测"该命中"⇒ 过宽变体全票通过；只测"该不命中"⇒ 过窄变体全票通过。
 *   G-3 **计数器用 0→1 正面断言**，不用"不抛"代替（被 `catch {}` 吞掉的写入只有正面断言抓得住）。
 *   G-4 **不依赖真实墙钟**：`now` 注入；不 sleep、不比真实时刻（G-4 承 `feedback_criteria_must_not_depend_on_wallclock`）。
 *   G-5 静态判据读**原文**（不去注释——去注释在本仓是静默毁伤）。
 *   G-6 **无轮次字面量**（不改 `build`；本文件不得出现前向 build 钉——末尾另有自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：本轮判据引用的生产符号**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import {
  NODE_SETTING_KEYS, ensureNodeIdentity, getNodeIdentity, readNodeSetting, writeNodeSetting, readNodeHeartbeatSec,
} from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import {
  collectNodeEnv, startNodeHeartbeat, ensureNodeEnrolled,
  type HeartbeatSend, type NodeEnvSnapshot,
} from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import { ansFailureNote } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';
import { PROJECT_CONCURRENCY_DEFAULT } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import {
  NODE_OFFLINE_SEC, NODE_HEARTBEAT_SEC_DEFAULT, DEFAULT_NODE_ROLE, NODE_ROLES,
  NODE_ROLE_LABEL, isDispatchable,
  NODE_CARD_CATEGORIES, NODE_CARD_CATEGORY_LABEL, isNodeCardCategory,
  NODE_REQUEST_STATUSES, isNodeRequestStatus,
  type NodeRole, type AnsNodeRequest,
} from '../packages/shared-types/src/nodes.js';
// 批三（M7/M8/M9/M10）：设备台账/发现/工具/闸——生产符号全部静态导入（G-1，被删/改名即编译期失败）。
import {
  upsertDiscovered, findDeviceByIdentity, listDevices, getDevice, setDeviceAuthorized,
  setDeviceStatus, recordDeviceAction, listDeviceActions, deviceControlVerdict, isHighRiskKind,
  type AnsDevice, type DeviceDb, type DiscoveredDevice,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  startDeviceDiscovery, stopDeviceDiscovery, isDiscoveryRunning, deriveDeviceKind,
  type DiscoveryIo,
} from '../apps/worker-ant-desktop/src/main/core/device-discovery.js';
import {
  deviceTools, runDeviceControl, isLanAddress, type DeviceControlTransport,
} from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
import { TOOL_METAS, toolRegistry } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { ARCHETYPE_TOOL_CATEGORIES, availableToolNames, narrowToolFace } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import type { ToolDeps } from '../apps/worker-ant-desktop/src/main/core/tools/deps.js';
// 批四（M11/M12/M13）：能力卡 / 中转队列 / 调用记录——生产符号静态导入（G-1，被删/改名即编译期失败）。
import {
  deriveNodeCategories, buildNodeCard, nodeCanDo,
} from '../apps/worker-ant-desktop/src/main/core/node-card.js';
import {
  CATEGORY_ARCHETYPE, categoryToolFace, startNodeRequestWorker,
  type RequestIo, type RequestRunner, type NodeRequestEvent,
} from '../apps/worker-ant-desktop/src/main/core/node-request-worker.js';
import { listNodeCallRecords, type CallLogDb } from '../apps/worker-ant-desktop/src/main/core/node-call-log.js';
import { pinnedArchetype } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import type { NodeIdentity } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
// 批五（M14/M15）：纯搬移减重的两个新载体——生产符号静态导入（G-1，被删/改名即编译期失败）。
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { searchKnowledgeGraph as kgSearchKnowledgeGraph } from '../apps/worker-ant-desktop/src/main/core/memory-kg.js';
import { scanDueProspective as prospScanDueProspective } from '../apps/worker-ant-desktop/src/main/core/memory-prospective.js';
import { runtimeProcesses, handleDaemonExit } from '../apps/worker-ant-desktop/src/main/core/daemon-supervisor.js';

// ── 批次门（排期序）────────────────────────────────────────────────────────
const ORDER = [
  'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15',
] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
/** STAGE 为空 ⇒ 全部须绿；否则**只要求 ≤STAGE 的批次**为绿（更晚的如实标"待实施"，不计入失败）。 */
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/** 登记一条**受批次门管辖**的判据；未实施批次的判据**仍求值**（要的是"红为什么红"），只是不计入失败。 */
function crit(b: Batch, cond: boolean, label: string, detail?: string): void {
  if (!required(b)) {
    pending++;
    console.log(`  ⏳ [${b}] ${label}${cond ? ' —— **已提前为真**' : ''}`);
    return;
  }
  if (cond) { pass++; console.log(`  ✓ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const S = 'apps/ans-server';
const root = path.join(__dirname, '..');
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 扫源码一律**去注释**（承 zx_20260921_1）："注释里写着有、代码里没被用上"正是要防的形态。 */
const strip = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

const NODES_ROUTE_SRC = `${S}/src/routes/nodes.ts`;
const SCHEMA_SRC = `${S}/src/db/schema.ts`;
const ANS_INDEX_SRC = `${S}/src/index.ts`;
const NODE_IDENTITY_SRC = `${A}/src/main/core/node-identity.ts`;
const NODE_HEARTBEAT_SRC = `${A}/src/main/core/node-heartbeat.ts`;
const MAIN_INDEX_SRC = `${A}/src/main/index.ts`;
const SHARED_NODES_SRC = `packages/shared-types/src/nodes.ts`;
// 批二（M4/M5/M6）：协同感知层的落点。
const EVENT_BUS_SRC = `${A}/src/main/core/event-bus.ts`;
const NODES_IPC_SRC = `${A}/src/main/ipc/nodes.ipc.ts`;
// zx_20261011_4 M3：取数口 `fetchNodes` 由 `ipc/nodes.ipc.ts` 上移 `core/node-list.ts`（electron-free，
//   面板与编排器读同一份台账）——M6-A' 的"台账唯一来源"判据随之**重定向到新载体**（非放宽）。
const NODE_LIST_SRC = `${A}/src/main/core/node-list.ts`;
const NODE_VIEW_TS = `${A}/renderer/src/lib/node-view.ts`;
const PEERS_PAGE = `${A}/renderer/src/pages/PeersPage.tsx`;
const APP_TSX = `${A}/renderer/src/App.tsx`;
const APP_LAYOUT_TSX = `${A}/renderer/src/components/AppLayout.tsx`;
// zx_20261013_1 批三：导航表提为**一处真源**——「导航项在册」的判据随载体搬到此处（非放宽：
//   仍钉分组名/路由串，另加"侧栏确从真源引入"一跳）。
const NAV_CONFIG_TS = `${A}/renderer/src/lib/navConfig.ts`;
const RENDERER_ACTIVITY_TSX = `${A}/renderer/src/lib/activity.tsx`;
const RENDERER_IPC_TS = `${A}/renderer/src/lib/ipc.ts`;
const ELECTRON_D_TS = `${A}/renderer/src/types/electron.d.ts`;
// 批三（M7–M10）：设备接入的落点。
const DEVICE_REGISTRY_SRC = `${A}/src/main/core/device-registry.ts`;
const DEVICE_DISCOVERY_SRC = `${A}/src/main/core/device-discovery.ts`;
const DEVICE_TOOLS_SRC = `${A}/src/main/core/tools/device.ts`;
const DEVICES_IPC_SRC = `${A}/src/main/ipc/devices.ipc.ts`;
const TOOL_REGISTRY_SRC = `${A}/src/main/core/tool-registry.ts`;
const TASK_ARCHETYPE_SRC = `${A}/src/main/core/task-archetype.ts`;
const DEVICES_PAGE = `${A}/renderer/src/pages/DevicesPage.tsx`;
// 批四（M11/M12/M13）：能力卡 / 中转队列 / 调用记录的落点。
const NODE_CARD_SRC = `${A}/src/main/core/node-card.ts`;
const NODE_REQUEST_WORKER_SRC = `${A}/src/main/core/node-request-worker.ts`;
const NODE_REQUEST_RUNNER_SRC = `${A}/src/main/core/node-request-runner.ts`;
const NODE_CALL_LOG_SRC = `${A}/src/main/core/node-call-log.ts`;
const A2A_PROXY_SRC = `${S}/src/routes/a2a-proxy.ts`;
const AGENT_EXECUTOR_SRC = `${A}/src/main/core/agent-executor.ts`;
// 批五（M14/M15）：纯搬移减重的两个新载体 + 旧载体。
const MEMORY_MANAGER_SRC = `${A}/src/main/core/memory-manager.ts`;
const MEMORY_KG_SRC = `${A}/src/main/core/memory-kg.ts`;
const MEMORY_PROSP_SRC = `${A}/src/main/core/memory-prospective.ts`;
const DAEMON_SUPERVISOR_SRC = `${A}/src/main/core/daemon-supervisor.ts`;
const PROJECT_IPC_SRC = `${A}/src/main/ipc/project.ipc.ts`;

// ── 夹具：逐列照抄 database.ts 的相关 DDL（G-7；先建表再插行）────────────────
/**
 * 设备两表的 DDL——**一处**（`fdb` 与 `devFdb` 共用）。
 *
 * 为何 `fdb()` 也要它：M11 起心跳 `tick()` 会 `buildNodeCard` ⇒ `listDevices(wa_devices)`——
 * 缺此表则**每次心跳**都抛 `no such table`（生产真库恒有该表，故是夹具该补齐，不是代码该吞异常）。
 * 这正是"夹具比生产宽松则断言只在自我印证"的反面：夹具**跟生产同形**，跨批依赖才照得出。
 */
const DEVICE_DDL = `
  CREATE TABLE wa_devices (
    id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '', room TEXT DEFAULT '', kind TEXT DEFAULT 'unknown',
    kind_class TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER,
    capabilities_json TEXT DEFAULT '[]', controllable INTEGER DEFAULT 0,
    authorized INTEGER DEFAULT 0, status_json TEXT,
    first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), online INTEGER);
  CREATE UNIQUE INDEX idx_wa_devices_ident ON wa_devices(protocol, address);
  CREATE INDEX idx_wa_devices_last_seen ON wa_devices(last_seen DESC);
  CREATE TABLE wa_device_actions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
    args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX idx_wa_device_actions_device ON wa_device_actions(device_id, created_at DESC);
`;
const FIXTURE_SCHEMA = `
  CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT DEFAULT 'pending', type TEXT DEFAULT '', payload TEXT DEFAULT '', started_at TEXT);
  -- zx_20261022_3 M1：机器槽位与执行闸同表（countMachineRunning/machineSlotGuard 读的就是它）。
  CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT DEFAULT 'pending');
` + DEVICE_DDL;
type AnyDb = import('better-sqlite3').Database;
function fdb(): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(FIXTURE_SCHEMA);
  return d as unknown as AnyDb;
}

/** 设备夹具：`wa_devices` / `wa_device_actions`（G-7；先建表再插行）。与 `fdb()` **同一份** DDL。 */
function devFdb(): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(DEVICE_DDL);
  return d as unknown as AnyDb;
}

/** 假发现器（G-1 的可注入面）：`start` 只记回调，由测试**手动** `emit`——不触网、时序可控。 */
function makeFakeIo() {
  let onFound: ((d: DiscoveredDevice) => void) | null = null;
  const stats = { started: 0, stopped: 0 };
  const io: DiscoveryIo = {
    start(cb) { stats.started++; onFound = cb; },
    stop() { stats.stopped++; onFound = null; },
  };
  return { io, emit: (d: DiscoveredDevice) => onFound?.(d), stats };
}
/** 假控制传动：记录调用、恒返回成功——供"授权后才真发命令"的 0→1 正面断言。 */
function makeFakeTransport() {
  const calls: string[] = [];
  const t: DeviceControlTransport = async (dev, action, _args) => { calls.push(`${dev.id}:${action}`); return { ok: true, result: `ok:${action}` }; };
  return { t, calls };
}

/** 递归列 `.ts`/`.tsx`（扫面规模自证用）。 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, acc); }
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1】批一 · 一节点一 key：登册与接线');
  {
    // M1-A 两个构造器在册（静态导入已使"被删即编译失败"；此处再钉形状与语义分家）。
    const routeSrc = strip(NODES_ROUTE_SRC);
    crit('M1', /export function nodeEnrollRoute\(/.test(routeSrc) && /export function nodesRoutes\(/.test(routeSrc),
      `M1-A **两个构造器**：注册走令牌闸（\`nodeEnrollRoute\`，公开组）、心跳/列表/改档/令牌台走 HMAC（\`nodesRoutes\`）。`,
      `enroll=${/export function nodeEnrollRoute\(/.test(routeSrc)} · hmac=${/export function nodesRoutes\(/.test(routeSrc)}`);

    // M1-B 两表在 schema（含索引）——并钉 ans_api_keys 的**建表归位**（早先只靠惰性 DDL：
    //   全新库上 ALTER 跑在建表之前 ⇒ resource_groups/secret_enc 静默缺列，createApiKey 直接 SQLITE_ERROR）。
    const schemaSrc = strip(SCHEMA_SRC);
    const hasNodes = /CREATE TABLE IF NOT EXISTS ans_nodes\b/.test(schemaSrc);
    const hasTokens = /CREATE TABLE IF NOT EXISTS ans_enrollment_tokens\b/.test(schemaSrc);
    const apiKeysBlock = /CREATE TABLE IF NOT EXISTS ans_api_keys\s*\(([\s\S]*?)\);/.exec(schemaSrc)?.[1] ?? '';
    crit('M1', hasNodes && hasTokens && /idx_ans_nodes_last_seen/.test(schemaSrc),
      `M1-B **两表 + 索引**：\`ans_nodes\`/\`ans_enrollment_tokens\` 与 \`idx_ans_nodes_last_seen\` 收进 schema。`,
      `nodes=${hasNodes} · tokens=${hasTokens}`);
    crit('M1', apiKeysBlock.includes('resource_groups') && apiKeysBlock.includes('secret_enc'),
      `M1-B' **建表归位（除根）**：\`ans_api_keys\` 由 schema 拥有全部列（含 \`resource_groups\`/\`secret_enc\`）——`
      + `否则全新库上"ALTER 跑在建表之前"静默缺列，注册签的 key 落不了库。`,
      `建表块含两列=${apiKeysBlock.includes('resource_groups') && apiKeysBlock.includes('secret_enc')}`);

    // M1-C **接线那一跳（语句形状切段）**：注册端点绝不进 hmacApi；HMAC 端点绝不进公开组。
    const idxSrc = strip(ANS_INDEX_SRC);
    const hmacApiSeg = idxSrc.slice(idxSrc.indexOf('const hmacApi'), idxSrc.indexOf('const hmacManagement'));
    const appSeg = idxSrc.slice(idxSrc.indexOf('const app = new Elysia'));
    crit('M1', hmacApiSeg.includes('.use(nodesRoutes(db))') && !hmacApiSeg.includes('nodeEnrollRoute')
      && appSeg.includes('.use(nodeEnrollRoute(db))') && !appSeg.includes('.use(nodesRoutes(db))'),
      `M1-C **接线形状**：\`nodesRoutes\` 挂 hmacApi 段、\`nodeEnrollRoute\` 挂公开 app 段，**互不越界**`
      + `（注册端点若误入 HMAC 组即鸡生蛋死锁）。`,
      `hmacApi 含 nodesRoutes=${hmacApiSeg.includes('.use(nodesRoutes(db))')} · app 含 enroll=${appSeg.includes('.use(nodeEnrollRoute(db))')}`);

    // M1-E 角色三档（K-11）**一处定义**：枚举与缺省同源，schema 行的缺省与之同值。
    crit('M1', NODE_ROLES.length === 3 && NODE_ROLES.includes(DEFAULT_NODE_ROLE) && DEFAULT_NODE_ROLE === 'worker'
      && /role TEXT DEFAULT 'worker'/.test(schemaSrc),
      `M1-E **三档角色一处定义**（K-11）：\`NODE_ROLES\` 恰三档、缺省 \`worker\` 在其中，且 schema 行缺省同值。`,
      `${NODE_ROLES.join('/')} · 缺省 ${DEFAULT_NODE_ROLE}`);

    // M1-D ans-client 四方法在册（register 走独立文件——无 key 不能签名）。
    const clientSrc = strip('packages/ans-client/src/client.ts');
    crit('M1', fs.existsSync(path.join(root, 'packages/ans-client/src/node-enroll.ts'))
      && /export async function enrollNode\(/.test(strip('packages/ans-client/src/node-enroll.ts'))
      && /async heartbeatNode\(/.test(clientSrc) && /async listNodes\(/.test(clientSrc) && /async updateNode\(/.test(clientSrc),
      `M1-D **客户端四面**：\`enrollNode\`（无签名路）+ \`heartbeatNode\`/\`listNodes\`/\`updateNode\`（HMAC 路）。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2】批一 · 本机身份 + 环境如实上报');
  {
    // M2-A 身份幂等（0→2 正面断言 + 二调同值）。
    const db = fdb();
    const before = getNodeIdentity(db);
    const first = ensureNodeIdentity(db, { hostname: 'unit-host' });
    const second = ensureNodeIdentity(db, { hostname: 'unit-host-2' }); // 二调即使换 hostname 也不得改 id/name
    const rowCount = (db.prepare('SELECT COUNT(*) AS c FROM wa_settings WHERE key IN (?, ?)').get(NODE_SETTING_KEYS.id, NODE_SETTING_KEYS.name) as { c: number }).c;
    crit('M2', before === null && rowCount === 2
      && second.id === first.id && second.name === first.name && first.name === 'unit-host',
      `M2-A **身份幂等（0→2）**：首调前无身份 ⇒ 生成 id/name 两行；**二调同值**（换 hostname 参数也不得漂）。`,
      `前=${before === null} · 行数 ${rowCount} · 幂等=${second.id === first.id && second.name === first.name}`);
    crit('M2', readNodeSetting(db, NODE_SETTING_KEYS.id) === first.id && /^[0-9a-f-]{36}$/.test(first.id),
      `M2-A' 落库值即返回值且是 UUID。`);

    // M2-B 采集字段齐备 + 忙闲分母 **一处真源**。
    const env0 = collectNodeEnv(db, { dataDir: root, now: Date.UTC(2026, 9, 4) });
    const keysNeeded: Array<keyof NodeEnvSnapshot> = [
      'platform', 'arch', 'hostname', 'cpu_count', 'cpu_usage_percent', 'load_avg1', 'total_mem', 'free_mem',
      'disk_free', 'disk_total', 'jobs_running', 'concurrency_default', 'dispatch_fill_ratio',
      // zx_20261022_3 M1：机器槽位口径四键（与执行闸同一把尺）。
      'machine_limit', 'running_tasks', 'free_slots', 'slot_fill_ratio',
      'capacity_free_ratio', 'collected_at',
    ];
    const missing = keysNeeded.filter((k) => !(k in env0));
    crit('M2', missing.length === 0 && env0.platform.length > 0 && env0.hostname.length > 0 && env0.cpu_count > 0
      && env0.collected_at === new Date(Date.UTC(2026, 9, 4)).toISOString(),
      `M2-B **采集字段齐备**（${keysNeeded.length} 项全在 + 非空 + 时钟按注入值成形，不碰真实墙钟）。`,
      `缺=${missing.join(',') || '无'} · cpu ${env0.cpu_count}`);
    crit('M2', env0.concurrency_default === PROJECT_CONCURRENCY_DEFAULT && env0.jobs_running === 0 && env0.dispatch_fill_ratio === 0,
      `M2-B' 派单填充分母取 **PROJECT_CONCURRENCY_DEFAULT**（不另抄字面量）；空库填充率 0。`,
      `分母 ${env0.concurrency_default} · running ${env0.jobs_running}`);

    // M2-C 派单填充率 0→1（两侧标本：running 计数，done 不计数）。
    const ins = db.prepare('INSERT INTO wa_jobs (id, status, type) VALUES (?, ?, ?)');
    for (let i = 0; i < PROJECT_CONCURRENCY_DEFAULT; i++) ins.run(`j${i}`, 'running', 'ai-task');
    ins.run('j-done', 'done', 'ai-task');
    const env1 = collectNodeEnv(db);
    crit('M2', env1.jobs_running === PROJECT_CONCURRENCY_DEFAULT && env1.dispatch_fill_ratio === 1,
      `M2-C **派单填充率 0→1 正面断言**：满并发 running ⇒ jobs_running=${PROJECT_CONCURRENCY_DEFAULT}、dispatch_fill_ratio=1；`
      + `另一条 done 行**不**计入（两侧标本）。`,
      `running ${env1.jobs_running} · ratio ${env1.dispatch_fill_ratio}`);
    crit('M2', /PROJECT_CONCURRENCY_DEFAULT/.test(strip(NODE_HEARTBEAT_SRC))
      && !/concurrency_default:\s*\d/.test(strip(NODE_HEARTBEAT_SRC)),
      `M2-C' **单源**：\`node-heartbeat.ts\` 用 \`PROJECT_CONCURRENCY_DEFAULT\`，**无** \`concurrency_default: <数字>\` 硬编码。`);

    // M2-E zx_20261022_3 M1：**两把尺**——派单作业满 ≠ 机器槽位满（病根反证）。
    //   夹具 `cpus: 4` ⇒ machine_limit=3（派生，不依赖真机核数）；此刻 jobs 已满、tasks 为 0。
    // 判据不得依赖真实主机瞬态：CPU 余量**注入**（否则同一台机忙时样本可达 100% ⇒ 余力 0 ⇒ 假红）。
    //   这里要证的是"派单满 ≠ 机器满"，CPU/内存源不是被测对象。
    const fixedCpu = { sample: () => ({ percent: 20, at: new Date(Date.UTC(2026, 9, 4)).toISOString() }) };
    const envTwoRulers = collectNodeEnv(db, { cpus: 4, cpuSampler: fixedCpu });
    crit('M2', envTwoRulers.machine_limit === 3 && envTwoRulers.running_tasks === 0
      && envTwoRulers.free_slots === 3 && envTwoRulers.slot_fill_ratio === 0
      && envTwoRulers.dispatch_fill_ratio === 1 && (envTwoRulers.capacity_free_ratio ?? 0) > 0,
      `M2-E **派单满 ≠ 机器满**：jobs 满（dispatch=1）而 tasks=0 ⇒ 槽位 0/3、余力仍 > 0（两件事不合并成一个数）。`,
      `dispatch=${envTwoRulers.dispatch_fill_ratio} · slot=${envTwoRulers.slot_fill_ratio} · capacity=${envTwoRulers.capacity_free_ratio}`);
    const insT = db.prepare('INSERT INTO wa_tasks (id, status) VALUES (?, ?)');
    for (let i = 0; i < envTwoRulers.machine_limit; i++) insT.run(`t${i}`, 'executing');
    const envSlotFull = collectNodeEnv(db, { cpus: 4, cpuSampler: fixedCpu });
    crit('M2', envSlotFull.running_tasks === 3 && envSlotFull.free_slots === 0
      && envSlotFull.slot_fill_ratio === 1 && envSlotFull.capacity_free_ratio === 0,
      `M2-E' **槽位占满即余力 0**：3 个 executing ⇒ running_tasks=3、free_slots=0、slot_fill=1（与执行闸同尺）。`,
      `tasks=${envSlotFull.running_tasks}/${envSlotFull.machine_limit} · capacity=${envSlotFull.capacity_free_ratio}`);

    // M2-D 心跳主体：真身份 + 真快照进发送；成功态。
    const sent: Array<{ nodeId: string; status: Record<string, unknown> }> = [];
    const sendOk: HeartbeatSend = async (nodeId, status) => { sent.push({ nodeId, status }); return { ok: true, note: '' }; };
    const hb = startNodeHeartbeat(db, { send: sendOk, autoStart: false, now: () => Date.UTC(2026, 9, 4, 8, 0, 0) });
    await hb.tick();
    const st = hb.getState();
    crit('M2', sent.length === 1 && sent[0]!.nodeId === first.id
      && sent[0]!.status.dispatch_fill_ratio === 1 && typeof sent[0]!.status.collected_at === 'string'
      && sent[0]!.status.stale_since === undefined,
      `M2-D **心跳那一跳**：以**本机身份**为 node_id、以**真快照**为 status 上报；健康跳**不带** stale_since。`,
      `node_id 相符=${sent[0]!.nodeId === first.id} · ratio ${sent[0]!.status.dispatch_fill_ratio}`);
    crit('M2', st.lastOkAt === new Date(Date.UTC(2026, 9, 4, 8, 0, 0)).toISOString()
      && st.consecutiveFailures === 0 && st.lastError === null && st.staleSince === null,
      `M2-D' 成功态如实：lastOkAt 按注入时钟成形、失败计数归零、无 stale_since。`);
    hb.stop();

    // M2-E 接线：注册排在 resolveAnsCreds 前；心跳排在作业注册后；停止时清定时器。
    const mainSrc = strip(MAIN_INDEX_SRC);
    const iEnroll = mainSrc.indexOf('ensureNodeEnrolled(db');
    const iCreds = mainSrc.indexOf('resolveAnsCreds(db)');
    const iJobs = mainSrc.indexOf('registerAllJobs(');
    const iHb = mainSrc.indexOf('startNodeHeartbeat(db');
    crit('M2', iEnroll >= 0 && iCreds >= 0 && iEnroll < iCreds,
      `M2-E **自助注册先于取身份**：注册写回 \`ans_api_key/ans_secret_key\`，故必须排在 \`resolveAnsCreds(db)\` 之前`
      + `（晚一步则本 session 仍以缺省身份出场，K-5 名存实亡）。`,
      `enroll@${iEnroll} < creds@${iCreds}=${iEnroll < iCreds}`);
    crit('M2', iHb > iJobs && iJobs >= 0 && /_nodeHeartbeat\.stop\(\)/.test(mainSrc),
      `M2-E' **心跳接线与停**：\`startNodeHeartbeat\` 排在作业注册后；\`stopCore\` 里 \`_nodeHeartbeat.stop()\` 清定时器。`,
      `hb@${iHb} > jobs@${iJobs}=${iHb > iJobs}`);

    // M2-F 设置键单源（不再有散落的 'node.id' 字面量）。
    const scanFiles = [
      ...walk(path.join(root, `${A}/src`)), ...walk(path.join(root, `${S}/src`)),
      ...walk(path.join(root, 'packages')), ...walk(path.join(root, 'scripts')),
    ].filter((p) => path.basename(p) !== 'rr_zx_20261004.ts');
    const identityDefs = scanFiles.filter((p) => /NODE_SETTING_KEYS\s*=/.test(fs.readFileSync(p, 'utf-8')));
    const literalHeartbeatSec = scanFiles.filter((p) => /'node\.heartbeat_sec'/.test(stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n')));
    crit('M2', identityDefs.length === 1 && path.relative(root, identityDefs[0]!) === NODE_IDENTITY_SRC
      && literalHeartbeatSec.length === 1,
      `M2-F **设置键单源**：\`NODE_SETTING_KEYS\` 全仓**一处**定义；\`'node.heartbeat_sec'\` 字面量**一处**`
      + `（散落即"同一件事两处各记各的"，任一处键名打错必静默回落缺省）。`,
      `定义处 ${identityDefs.map((p) => path.relative(root, p)).join(',')} · 字面量 ${literalHeartbeatSec.length} 处`);

    // M2-G 注册跳过条件**两侧标本**（无令牌 / 已注册），且都不触网。
    const db2 = fdb();
    const id2 = ensureNodeIdentity(db2, { hostname: 'h2' });
    const noTok = await ensureNodeEnrolled(db2, { serverUrl: 'http://127.0.0.1:1' });
    // zx_20261012：判据增②（非占位凭据）——"已注册"真形状须补非占位 `ans_api_key`（断言逐条原样）。
    writeNodeSetting(db2, NODE_SETTING_KEYS.ansApiKey, 'wa_rr_enrolled_key');
    writeNodeSetting(db2, NODE_SETTING_KEYS.resourceGroup, `node:${id2.id}`);
    const already = await ensureNodeEnrolled(db2, { serverUrl: 'http://127.0.0.1:1' });
    crit('M2', noTok.enrolled === false && noTok.reason === 'no-enrollment-token'
      && already.enrolled === false && already.reason === 'already-enrolled',
      `M2-G **注册两侧标本**：无令牌 ⇒ \`no-enrollment-token\`；\`node.resource_group\` 已绑定本 id ⇒ \`already-enrolled\``
      + `（误判"已注册"即永远不去换 key，心跳恒 401 且静默）。`,
      `${noTok.reason} / ${already.reason}`);
    crit('M2', readNodeHeartbeatSec(db2) === NODE_HEARTBEAT_SEC_DEFAULT
      && (writeNodeSetting(db2, NODE_SETTING_KEYS.heartbeatSec, '7'), readNodeHeartbeatSec(db2) === 7)
      && (writeNodeSetting(db2, NODE_SETTING_KEYS.heartbeatSec, 'abc'), readNodeHeartbeatSec(db2) === NODE_HEARTBEAT_SEC_DEFAULT),
      `M2-G' 周期读口：缺省/合法/非法三态（非法回落共享缺省，不把 NaN 当周期）。`);

    // M2-H 默认 key 已换的**一次性提示**接线（zx_20261004 §4 #7：防用户以为还在用共享默认 key）。
    const hbRaw = RD(NODE_HEARTBEAT_SRC);
    const iSetNotif = mainSrc.indexOf('setupTaskNativeNotifications({');
    const iKeyHint = mainSrc.indexOf("showSystemNotification('本机已启用独立节点 key'");
    crit('M2', /export interface EnrollResult\s*\{[^}]*keyUpgraded\??:\s*boolean/s.test(hbRaw)
      && /resource_group,\s*keyUpgraded:\s*true/.test(hbRaw)
      && /if \(enrollRes\.keyUpgraded\)/.test(mainSrc)
      && iSetNotif >= 0 && iKeyHint > iSetNotif,
      `M2-H **默认 key 已换的提示**（§4 #7）：注册成功回报 \`keyUpgraded:true\`；\`index.ts\` 据此提示一次，`
      + `且提示排在通知服务装配**之后**（早于则 \`_notifDb\` 未注入、\`showSystemNotification\` 静默失效——位置是钉）。`,
      `keyUpgraded 回报=${/resource_group,\s*keyUpgraded:\s*true/.test(hbRaw)} · 提示@${iKeyHint} > 装配@${iSetNotif}=${iKeyHint > iSetNotif}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3】批一 · 在线/离线同一把尺 + 如实上报');
  {
    // M3-A NODE_OFFLINE_SEC 一处定义 + 零重复硬编码 + 扫面自证。
    const scanFiles = [
      ...walk(path.join(root, `${A}/src`)), ...walk(path.join(root, `${A}/renderer/src`)),
      ...walk(path.join(root, `${S}/src`)), ...walk(path.join(root, 'packages')), ...walk(path.join(root, 'scripts')),
    ].filter((p) => path.basename(p) !== 'rr_zx_20261004.ts');
    const defs = scanFiles.filter((p) => /(?:export\s+)?const\s+NODE_OFFLINE_SEC\s*=/.test(fs.readFileSync(p, 'utf-8')));
    const reHardcoded = scanFiles.filter((p) => p !== path.join(root, SHARED_NODES_SRC)
      && /NODE_OFFLINE_SEC\s*[:=]\s*\d/.test(stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n')));
    crit('M3', scanFiles.length > 50 && defs.length === 1 && path.relative(root, defs[0]!) === SHARED_NODES_SRC,
      `M3-A **阈值一处定义**：\`NODE_OFFLINE_SEC\` 全仓恰好一处（` + SHARED_NODES_SRC + `）；扫面自证 ${scanFiles.length} 文件。`,
      `定义处 ${defs.map((p) => path.relative(root, p)).join(',') || '(无)'} · 扫面 ${scanFiles.length}`);
    crit('M3', reHardcoded.length === 0 && NODE_OFFLINE_SEC >= 2 * NODE_HEARTBEAT_SEC_DEFAULT,
      `M3-A' **零重复硬编码**（他处不得再写死一个离线秒数）+ 关系判据 \`OFFLINE ≥ 2×心跳\`（由载体自身派生，不写轮次/绝对值得字面量）。`,
      `重复处 ${reHardcoded.length} · ${NODE_OFFLINE_SEC} >= ${2 * NODE_HEARTBEAT_SEC_DEFAULT}`);

    // M3-B stale_since **两侧标本**（停跳后出现 → 恢复后消失，且恢复那一跳捎带缺口起点）。
    const db = fdb();
    let mode: 'fail' | 'ok' = 'fail';
    const seen: Array<Record<string, unknown>> = [];
    const send: HeartbeatSend = async (_id, status) => {
      seen.push(status as Record<string, unknown>);
      return mode === 'ok' ? { ok: true, note: '' } : { ok: false, note: ansFailureNote({ ok: false, status: 0, detail: '', attempts: 1 }) };
    };
    let t = Date.UTC(2026, 9, 4, 0, 0, 0);
    const hb = startNodeHeartbeat(db, { send, autoStart: false, now: () => (t += 1000) });
    await hb.tick();                       // 第 1 跳：失败
    const s1 = hb.getState();
    mode = 'ok';
    await hb.tick();                       // 第 2 跳：恢复（此跳载荷须带 stale_since）
    const s2 = hb.getState();
    await hb.tick();                       // 第 3 跳：已恢复（不再带 stale_since）
    crit('M3', s1.staleSince !== null && s1.lastOkAt === null && s1.consecutiveFailures === 1
      && s2.staleSince === null && s2.lastOkAt !== null && s2.consecutiveFailures === 0,
      `M3-B **stale_since 两侧标本**：停跳 ⇒ staleSince 出现（且 lastOkAt 仍空）；恢复 ⇒ 清空、lastOkAt 落位、计数归零。`,
      `s1=${s1.staleSince ? '有' : '无'} · s2=${s2.staleSince ? '有' : '无'}`);
    crit('M3', seen[1]!.stale_since === s1.staleSince && seen[2]!.stale_since === undefined,
      `M3-B' **缺口捎带**：恢复那一跳的载荷带 \`stale_since\`（= 缺口起点），已恢复的后续跳不再带——`
      + `ANS 侧据此可标注"这段数据是陈的"，而非把旧值说成此刻的。`,
      `跳2带=${seen[1]!.stale_since === s1.staleSince} · 跳3带=${seen[2]!.stale_since !== undefined}`);
    crit('M3', s1.lastError !== null && /无响应/.test(s1.lastError) && s1.lastError === ansFailureNote({ ok: false, status: 0, detail: '', attempts: 1 }),
      `M3-C **失败不静默**：失败原因按 \`ansFailureNote\` 形状原样留在 state.lastError（"无响应（尝试 N 次）"），`
      + `不是吞成 null。`,
      `note=${s1.lastError}`);

    // M3-D 身份跨多跳**不增殖**（幽灵节点防御：心跳反复调 ensureNodeIdentity 也不得新增身份）。
    const idRows = (db.prepare('SELECT COUNT(*) AS c FROM wa_settings WHERE key = ?').get(NODE_SETTING_KEYS.id) as { c: number }).c;
    crit('M3', idRows === 1,
      `M3-D **身份不增殖**：多跳心跳后 \`node.id\` 行仍为 1（每跳现编 UUID ⇒ 幽灵节点）。`, `行数 ${idRows}`);
    hb.stop();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4】批二 · 共在一屏 + 实时（海德格尔·共在）');
  // 批二三块（M4/M5/M6）同读这两份源码——提到块外，避免块作用域各读各的。
  const ipcSrc = strip(NODES_IPC_SRC);
  const pageSrc = strip(PEERS_PAGE);
  {
    // M4-A 两类节点事件**两处对待**（两侧标本）：档位变更持久化、心跳瞬态。
    //   只测"该持久化的进了映射"⇒ 过宽（把心跳也塞进去照样绿）；故**同时**钉心跳**不在**映射——
    //   心跳每 ~30s 一发，进不可变事件表即洪泛（同 channel.status_changed 的取舍）。
    const ebSrc = strip(EVENT_BUS_SRC);
    const unionSeg = ebSrc.slice(ebSrc.indexOf('export type EventType'), ebSrc.indexOf('export interface AppEvent'));
    const mapKeys = [...ebSrc.matchAll(/'([a-z_.]+)':\s*\{\s*aggregate_type/g)].map((m) => m[1]!);
    crit('M4', unionSeg.includes("'node.presence_changed'") && unionSeg.includes("'node.heartbeat'")
      && mapKeys.includes('node.presence_changed') && !mapKeys.includes('node.heartbeat'),
      `M4-A **两类事件两处对待**：\`node.presence_changed\` 入 union **且**入持久化映射；\`node.heartbeat\` 入 union`
      + `**但不在**映射（瞬态，走 \`emitTransient\`，不洪泛事件表）。`,
      `presence 在映射=${mapKeys.includes('node.presence_changed')} · heartbeat 在映射=${mapKeys.includes('node.heartbeat')}`);

    // M4-B 接线那一跳：主进程起心跳时每跳发瞬态 node.heartbeat（把 onTick 接到事件总线）。
    const mainSrc = strip(MAIN_INDEX_SRC);
    crit('M4', /onTick:\s*\(info\)\s*=>/.test(mainSrc) && /emitTransient\('node\.heartbeat'/.test(mainSrc),
      `M4-B **心跳即时刷的接线**：\`startNodeHeartbeat\` 的 \`onTick\` 转到 \`emitTransient('node.heartbeat', …)\`——`
      + `面板据它在本机忙闲/成败变化的当口即时刷，而非干等下一拍 ANS 台账。`,
      `onTick=${/onTick:\s*\(info\)\s*=>/.test(mainSrc)} · emitTransient=${/emitTransient\('node\.heartbeat'/.test(mainSrc)}`);
    crit('M4', /forwardToRenderer\('node\.presence_changed'/.test(mainSrc) && /forwardToRenderer\('node\.heartbeat'/.test(mainSrc),
      `M4-B' **转发两条**：持久化与瞬态事件各经 \`forwardToRenderer\` 送到 \`task:event\` 通道（否则订阅者收不到）。`);

    // M4-C IPC 三出口 + 接线（initNodesIpc 挂上）。
    const chans = ['nodes:list', 'nodes:update', 'nodes:card'].filter((c) => ipcSrc.includes(`'${c}'`));
    crit('M4', chans.length === 3 && /initNodesIpc\(db\)/.test(mainSrc),
      `M4-C **IPC 三出口 + 接线**：\`nodes:list\`/\`nodes:update\`/\`nodes:card\` 三通道在册，且 \`initNodesIpc(db)\` 已挂。`,
      `通道 ${chans.join('/')} · 接线=${/initNodesIpc\(db\)/.test(mainSrc)}`);

    // M4-D 路由 + 导航 + 页面在册。
    const appSrc = strip(APP_TSX);
    const layoutSrc = strip(APP_LAYOUT_TSX);
    const navCfgSrc = strip(NAV_CONFIG_TS);
    crit('M4', /path="\/peers"/.test(appSrc) && /'\/peers'/.test(navCfgSrc) && navCfgSrc.includes("'协同与设备'")
      && /import \{ NAV_GROUPS \} from '\.\.\/lib\/navConfig'/.test(layoutSrc)
      && fs.existsSync(path.join(root, PEERS_PAGE)),
      `M4-D **上屏可达**：\`App.tsx\` 注册 \`/peers\` 路由；导航真源 \`navConfig.ts\` 有分组「协同与设备」，且 \`AppLayout\` 从它引入（仍真上屏）。`,
      `路由=${/path="\/peers"/.test(appSrc)} · 导航=${navCfgSrc.includes("'协同与设备'")} · 引入=${/import \{ NAV_GROUPS \}/.test(layoutSrc)}`);

    // M4-E 页面实时刷新 + 按角色分组（米勒 7±2 的组块呈现，分组顺序由枚举派生而非手写）。
    crit('M4', /liveTypes:\s*\[[^\]]*'node\.presence_changed'/.test(pageSrc) && /NODE_ROLES\.map\(/.test(pageSrc),
      `M4-E **实时 + 组块呈现**：页面 \`useLiveQuery\` 订阅 \`node.presence_changed\`；分组顺序由 \`NODE_ROLES.map(\` **派生**`
      + `（加一档时自动多一组，不手写角色列表）。`,
      `liveTypes=${/liveTypes:\s*\[[^\]]*'node\.presence_changed'/.test(pageSrc)} · 派生分组=${/NODE_ROLES\.map\(/.test(pageSrc)}`);

    // M4-F 边界**如实上屏**（zx_20261011 订正，**强化非放宽**）：旧文案「暂不支持跨机派发」已随
    //   zx_20261011 把该能力**兑现成动作**而删除；此处改钉**新源**——「派活」卡在场、**真调** `nodes:dispatch`、
    //   且边界仍如实（"派发方须为本网节点（对等派发）"）。原判据只钉一句"没有这个能力"的静态声明，
    //   新判据钉"这个能力**已被接上** + 边界不失实"——面更宽、更严（卡片在而过期横幅仍在也会抓）。
    crit('M4', /function DispatchCard\(/.test(pageSrc) && /nodesApi\.dispatch\(/.test(pageSrc)
      && pageSrc.includes('对等派发'),
      `M4-F **边界如实上屏**（zx_20261011 订正）：面板不再写"暂不支持跨机派发"，而是给出「派活」卡`
      + `（真调 \`nodes:dispatch\`）并如实标"派发方须为本网节点（对等派发）"。`,
      `卡片=${/function DispatchCard\(/.test(pageSrc)} · 调 IPC=${/nodesApi\.dispatch\(/.test(pageSrc)} · 对等边界=${pageSrc.includes('对等派发')}`);

    // M4-G 渲染层词表第二个落点：TaskEvent 增节点字段；activity 把心跳列入"广播不刷屏"、档位变更给中文名。
    const dts = strip(ELECTRON_D_TS);
    const actSrc = strip(RENDERER_ACTIVITY_TSX);
    const bcastSeg = /const BROADCAST_ONLY_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(actSrc)?.[1] ?? '';
    const titleSeg = /const TITLE_MAP[\s\S]*?\n\};/.exec(actSrc)?.[0] ?? '';
    crit('M4', /\bnodeId\?:\s*string/.test(dts) && /\bdispatchFillRatio\?:\s*number/.test(dts),
      `M4-G **渲染层字段齐备**：\`electron.d.ts\` 的 \`TaskEvent\` 增 \`nodeId\`/\`dispatchFillRatio\` 等（IPC 边界结构化克隆后仍可见）。`);
    crit('M4', bcastSeg.includes("'node.heartbeat'") && titleSeg.includes("'node.presence_changed'"),
      `M4-G' **防刷屏与留痕各归其位**：心跳进 \`BROADCAST_ONLY_TYPES\`（到订阅者、不堆活动环缓冲）；`
      + `档位变更进 \`TITLE_MAP\`（活动页可见"谁何时改了档"）。`,
      `心跳广播=${bcastSeg.includes("'node.heartbeat'")} · 档位在 TITLE_MAP=${titleSeg.includes("'node.presence_changed'")}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5】批二 · 档位可配 + 一处真源（亚里士多德·潜能成现实）');
  {
    // M5-A 角色词表**一处真源**：全仓（含渲染层第二落点）**生产面**恰一处**同时**含三档引号字面量。
    //   zx_20261011_1 订正（承"扫面按病根形态定"）：病根是"**生产/渲染层**自抄一张角色表"。
    //   而**标本类文件**（`__tests__/*.test.ts`、`scripts/rr_*.ts`）本就要逐字写三档做**两侧标本**
    //   （真值表、边界用例）——它们不是"词表落点"，把它们算进来是**扫面错置**（M1–M3 加标本后误红）。
    //   故收窄到生产面：测试件与受控复跑脚本出局（不是放宽判据——判据仍钉"生产面恰一份"，且唯一落点必须=共享真源）。
    const isSpecimen = (p: string) => p.includes(`${path.sep}__tests__${path.sep}`) || /\.test\.ts$/.test(p) || /(^|\/)rr_.*\.ts$/.test(path.relative(root, p));
    const scanFiles = [
      ...walk(path.join(root, `${A}/src`)), ...walk(path.join(root, `${A}/renderer/src`)),
      ...walk(path.join(root, `${S}/src`)), ...walk(path.join(root, 'packages')), ...walk(path.join(root, 'scripts')),
    ].filter((p) => !isSpecimen(p));
    const roleFiles = scanFiles.filter((p) => {
      const s = stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');
      return s.includes("'primary'") && s.includes("'worker'") && s.includes("'observer'");
    });
    crit('M5', roleFiles.length === 1 && path.relative(root, roleFiles[0]!) === SHARED_NODES_SRC,
      `M5-A **角色词表一处**：全仓**生产面**（含渲染层）恰**一份**同时列出三档角色字面量（\`${SHARED_NODES_SRC}\`）——`
      + `渲染层若自抄一张角色表即"词表第二落点"，加第四档时必漏（标本类文件——测试件/rr 脚本——不计，它们逐字列三档是两侧标本所需）。`,
      `落点 ${roleFiles.map((p) => path.relative(root, p)).join(',') || '(无)'}`);

    // M5-B 人话名**覆盖全档**（由枚举派生，非抄字面量）：漏一档是编译期错，此处再正面钉一次。
    const missingLabel = NODE_ROLES.filter((r) => !(r in NODE_ROLE_LABEL));
    crit('M5', missingLabel.length === 0 && Object.keys(NODE_ROLE_LABEL).length === NODE_ROLES.length,
      `M5-B **人话名全覆盖**：\`NODE_ROLE_LABEL\` 键集 == \`NODE_ROLES\`（${NODE_ROLES.map((r) => NODE_ROLE_LABEL[r]).join('/')}）。`,
      `缺 ${missingLabel.join(',') || '无'}`);

    // M5-C 可派单判据**两侧标本 + 0→1**：观察者即便参与也不派；工作节点参与才派。
    const cases: Array<{ role: NodeRole; participate: boolean; want: boolean }> = [
      { role: 'observer', participate: true, want: false },   // 观察者：误把参与置真也不派
      { role: 'worker', participate: false, want: false },    // 工作节点但已退出派单
      { role: 'worker', participate: true, want: true },      // 工作节点参与 ⇒ 派
      { role: 'primary', participate: true, want: true },     // 主节点参与 ⇒ 派
    ];
    const got = cases.map((c) => isDispatchable({ role: c.role, participate: c.participate }));
    const bad = got.filter((g, i) => g !== cases[i]!.want).length;
    crit('M5', bad === 0 && got.includes(true) && got.includes(false),
      `M5-C **可派单判据两侧标本（0→1）**：参与且非观察者 ⇒ 真（2 例）；观察者或未参与 ⇒ 假（2 例）。`
      + `\`isDispatchable\` 是全仓**唯一**判据（面板角标、M12 选目标都读它）。`,
      `真 ${got.filter(Boolean).length} / 假 ${got.filter((g) => !g).length} · 错 ${bad}`);
    crit('M5', !/'observer'/.test(strip(RENDERER_IPC_TS)) && !/'observer'/.test(strip(APP_LAYOUT_TSX)),
      `M5-C' 渲染层接线处**不**另写角色字面量（判据/词表一律从共享真源引）。`);

    // M5-D 改档那一跳：先 PATCH 真源（ANS），本机再镜像进 settings + 广播。
    crit('M5', /method:\s*'PATCH'/.test(ipcSrc) && /nodeId === localNodeId/.test(ipcSrc)
      && /broadcastSetting\(NODE_SETTING_KEYS\.role/.test(ipcSrc),
      `M5-D **真源在 ANS、本机镜像**：\`nodes:update\` 先 \`method:'PATCH'\` 到 ANS（派单选目标读它）；`
      + `若改的是本机，再把收窄后的 \`node.role\` 写回本地 settings 并 \`broadcastSetting\` 热更（免重启）。`,
      `PATCH=${/method:\s*'PATCH'/.test(ipcSrc)} · 镜像=${/nodeId === localNodeId/.test(ipcSrc)}`);
    crit('M5', /nodesApi\.update\(node\.node_id/.test(pageSrc),
      `M5-D' 面板保存那一跳：以 \`node.node_id\`（**非** name）为目标调 \`nodesApi.update\`——同名主机不混淆。`);

    // M5-E 权威映射**收窄后再镜像**：非法角色不得写进本地（否则本地与 ANS 分家）。
    crit('M5', /isNodeRole\(node\.role\)/.test(ipcSrc),
      `M5-E **镜像取收窄后真值**：写本地前过 \`isNodeRole(node.role)\`——ANS 侧对非法角色不动，本机也就不动，两侧不分家。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M6】批二 · 自知者明：本机也照同一面镜子（老子·知人者智，自知者明）');
  {
    // M6-A **两把尺防御**：面板取数只读 ANS 台账，**不**在本地另采一份环境。
    crit('M6', !/collectNodeEnv/.test(ipcSrc) && !/collectNodeEnv/.test(strip(NODE_VIEW_TS)) && !/collectNodeEnv/.test(pageSrc),
      `M6-A **不在面板另算一份环境**：\`nodes.ipc.ts\`/\`node-view.ts\`/\`PeersPage.tsx\` 均**不**触碰 \`collectNodeEnv\`——`
      + `否则"报出去的忙"与"面板上看见的忙"就是两把尺。`,
      `ipc=${!/collectNodeEnv/.test(ipcSrc)} · view=${!/collectNodeEnv/.test(strip(NODE_VIEW_TS))} · page=${!/collectNodeEnv/.test(pageSrc)}`);
    // zx_20261011_4 M3：取数口上移 core/node-list.ts（面板与编排器读**同一份**）⇒ 判据**重定向到新载体**
    //   并反证旧处不再自留一份（非放宽：两处都钉，防"同一件事两个名字"）。
    crit('M6', /ansSignedRequest\(creds,\s*'\/api\/v1\/nodes'/.test(strip(NODE_LIST_SRC)) && /body\.data/.test(strip(NODE_LIST_SRC)),
      `M6-A' 台账唯一来源：\`fetchNodes\`（core/node-list.ts）经 \`ansSignedRequest(… '/api/v1/nodes')\` 取，返回 \`body.data\`（ANS 台账原样）。`);
    crit('M6', !/function fetchNodes/.test(ipcSrc),
      `M6-A'' ★反证：\`nodes.ipc.ts\` 不再自留一份 \`fetchNodes\`（取数只此一处真源，转调 core/node-list.ts）。`);

    // M6-B **同一份快照**：心跳送上去的载荷键集 == `collectNodeEnv` 的键集
    //   （只比键集、不比值——值里有 load/mem/时钟，两次采集本就该不同；键集差一即"送出去的不是这一份"）。
    const db = fdb();
    let captured: Record<string, unknown> | null = null;
    const send: HeartbeatSend = async (_id, status) => { captured = status as Record<string, unknown>; return { ok: true, note: '' }; };
    const hb = startNodeHeartbeat(db, { send, autoStart: false, now: () => Date.UTC(2026, 9, 4, 8, 0, 0) });
    await hb.tick();
    hb.stop();
    const envKeys = Object.keys(collectNodeEnv(db)).sort();
    const payKeys = captured ? Object.keys(captured).sort() : [];
    crit('M6', captured !== null && JSON.stringify(envKeys) === JSON.stringify(payKeys),
      `M6-B **报出去的即面板将渲染的**：心跳载荷键集 == \`collectNodeEnv\` 键集（${envKeys.length} 项）——`
      + `ANS 存的 \`status_json\` 就是面板 \`readNodeEnv\` 要投影的那一份，中间无第二份。`,
      `键集相符=${JSON.stringify(envKeys) === JSON.stringify(payKeys)} · ${envKeys.length} 项`);

    // M6-C 本机行**按 id 认**（不按 name 猜）+ 面板置顶。
    crit('M6', /\.find\(n => n\.node_id === localNodeId\)/.test(ipcSrc) && /nodes\.find\(n => n\.node_id === localId\)/.test(pageSrc),
      `M6-C **本机由 id 认**：\`nodes:card\` 与面板都用 \`node_id === localNodeId\` 认本机行——两台同名主机的 \`name\` 相同，`
      + `按 name 认会把别人的行当成自己的。`,
      `card=${/\.find\(n => n\.node_id === localNodeId\)/.test(ipcSrc)} · 面板=${/nodes\.find\(n => n\.node_id === localId\)/.test(pageSrc)}`);
    crit('M6', /readNodeEnv\(node\)/.test(pageSrc) && /dispatchFillView\(env\)/.test(pageSrc) && /capacityView\(env\)/.test(pageSrc),
      `M6-C' 本机与他机**同形呈现**：都走 \`readNodeEnv\`/\`dispatchFillView\`/\`capacityView\` 同一套展示换算（"自知者明"——同一面镜子照自己）。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M7】批三 · 纳物：设备台账 + 自动发现（庄子·不预设 / 管子·度量衡）');
  {
    // ── 台账幂等（0→1 正面 + 二次 upsert 不增殖 + 首见/授权不被冲）────────────
    const db = devFdb();
    const ddb = db as unknown as DeviceDb;
    ok(listDevices(ddb).length === 0, 'M7-A0 台账初为空（0→1 正面断言的"0"侧）');
    const dev = upsertDiscovered(ddb, { name: '客厅灯', kind: 'light', protocol: 'ssdp', address: '192.168.1.20', port: 80, capabilities: ['switch'], controllable: true }, '2026-10-04 08:00:00');
    crit('M7', listDevices(ddb).length === 1 && dev.authorized === false && dev.status === null,
      `M7-A **首见入账**：0→1 恰一行，且 \`authorized=false\`（发现≠授权·K-6）、\`status=null\`（"不知道"不等于"空对象"）。`,
      `行数=${listDevices(ddb).length} · authorized=${dev.authorized} · status=${dev.status}`);
    // 二次发现（同 protocol+address，可控为真）⇒ 刷新不自增，且**不**改 first_seen；用户意志不被冲。
    setDeviceAuthorized(ddb, dev.id, true, '2026-10-04 08:05:00');
    const dev2 = upsertDiscovered(ddb, { name: '客厅灯(改名)', kind: 'light', protocol: 'ssdp', address: '192.168.1.20', port: 80, capabilities: ['switch', 'dimmer'], controllable: true }, '2026-10-04 09:00:00');
    crit('M7', listDevices(ddb).length === 1 && dev2.id === dev.id
      && dev2.first_seen === '2026-10-04 08:00:00' && dev2.last_seen === '2026-10-04 09:00:00'
      && dev2.authorized === true && dev2.name === '客厅灯(改名)',
      `M7-B **幂等 upsert**：同 \`protocol+address\` 二次发现**仍是同一行**（不增殖）——自述字段（name）与 \`last_seen\` 刷新、`
      + `\`first_seen\` 与用户意志（\`authorized\`）**不被发现冲掉**。`,
      `行数=${listDevices(ddb).length} · 同id=${dev2.id === dev.id} · first_seen=${dev2.first_seen} · authorized=${dev2.authorized}`);

    // ── 假 IO 发现落台账 0→1 + isNew 两侧标本 ──────────────────────────────
    const dbD = devFdb();
    const ddbD = dbD as unknown as DeviceDb;
    const fio = makeFakeIo();
    const seen: Array<{ id: string; isNew: boolean }> = [];
    startDeviceDiscovery(ddbD, { io: fio.io, onDiscovered: (row, info) => seen.push({ id: row.id, isNew: info.isNew }), now: () => '2026-10-04 10:00:00' });
    const runningAfterStart = isDiscoveryRunning();
    crit('M7', runningAfterStart && fio.stats.started === 1 && listDevices(ddbD).length === 0,
      `M7-C **起发现**：\`isDiscoveryRunning()\` 为真、假 IO \`start\` 被调 1 次；此时台账尚空（还无设备上报）。`,
      `running=${runningAfterStart} · started=${fio.stats.started} · 台账=${listDevices(ddbD).length}`);
    fio.emit({ name: '卧室开关', kind: 'switch', protocol: 'mdns', address: '192.168.1.31', port: 8080, capabilities: ['relay'], controllable: true });
    crit('M7', listDevices(ddbD).length === 1 && seen.length === 1 && seen[0]!.isNew === true,
      `M7-D **上报即落账（0→1）**：一条发现 ⇒ 台账 0→1、\`onDiscovered\` 报 \`isNew=true\`（新设备）。`,
      `台账=${listDevices(ddbD).length} · 回调=${seen.length} · isNew=${seen[0]?.isNew}`);
    fio.emit({ name: '卧室开关', kind: 'switch', protocol: 'mdns', address: '192.168.1.31', port: 8080, capabilities: ['relay'], controllable: true });
    crit('M7', listDevices(ddbD).length === 1 && seen.length === 2 && seen[1]!.isNew === false,
      `M7-E **重复发现不增殖**（两侧标本的另一侧）：同设备再报 ⇒ 台账**仍 1 行**、\`isNew=false\`（刷新非新增）。`,
      `台账=${listDevices(ddbD).length} · isNew=${seen[1]?.isNew}`);
    stopDeviceDiscovery();
    ok(!isDiscoveryRunning() && fio.stats.stopped === 1, 'M7-F 停发现：`isDiscoveryRunning()` 转假、假 IO `stop` 被调 1 次');

    // ── 能力自述归类的两侧标本 ────────────────────────────────────────────
    crit('M7', deriveDeviceKind('_hap._tcp doorlock') === 'lock' && deriveDeviceKind('urn:schemas-upnp-org:device:LightBulb') === 'light'
      && deriveDeviceKind('x-sensor probe') === 'sensor',
      `M7-G **自述归类（该命中侧）**：含 lock/light/sensor 线索的自述文本归对应类。`,
      `lock=${deriveDeviceKind('_hap._tcp doorlock')} · light=${deriveDeviceKind('urn:schemas-upnp-org:device:LightBulb')} · sensor=${deriveDeviceKind('x-sensor probe')}`);
    crit('M7', deriveDeviceKind('acme-frobnicator-9000') === 'unknown' && deriveDeviceKind('') === 'unknown',
      `M7-H **自述归类（不该命中侧）**：认不出**不硬塞**——归 \`unknown\`（"猜错的类别比未知更坏：模型会照着做"）。`,
      `无特征=${deriveDeviceKind('acme-frobnicator-9000')} · 空串=${deriveDeviceKind('')}`);

    // ── 局域网地址收口（SSRF）两侧标本 ────────────────────────────────────
    crit('M7', isLanAddress('192.168.1.20') && isLanAddress('10.0.0.5') && isLanAddress('127.0.0.1')
      && isLanAddress('172.16.3.9') && isLanAddress('169.254.1.1') && isLanAddress('printer.local') && isLanAddress('fe80::1'),
      `M7-I **局域网收口（该放行侧）**：私有 IPv4 / 回环 / 链路本地 / \`.local\` / IPv6-LL 皆放行（控制只发往局域网）。`,
      `192.168 → ${isLanAddress('192.168.1.20')} · .local → ${isLanAddress('printer.local')}`);
    crit('M7', !isLanAddress('8.8.8.8') && !isLanAddress('172.15.0.1') && !isLanAddress('172.32.0.1')
      && !isLanAddress('example.com') && !isLanAddress('1.1.1.1'),
      `M7-J **局域网收口（该拒侧）**：公网 IP / 边界外私网段（172.15、172.32 不在 16–31）/ 域名**一律拒**——`
      + `TXT/SSDP 可被伪造，出站前再核一次，不把控制面变成任意出站通道。`,
      `8.8.8.8 → ${isLanAddress('8.8.8.8')} · 172.15 → ${isLanAddress('172.15.0.1')} · 172.32 → ${isLanAddress('172.32.0.1')}`);

    // 静态：真网络隔离（承 §3「真网络只走注入」）——发现层**不得**顶层 import 真实现（须惰性）。
    const discSrc = strip(DEVICE_DISCOVERY_SRC);
    // `import type { … } from 'node-ssdp'` 是**类型位**、打包期擦除，不拉运行期依赖——故只在**值**导入上判红线。
    crit('M7', !/^import\s+(?!type\b)[^\n]*from '(bonjour-service|node-ssdp)'/m.test(discSrc)
      && /await import\('bonjour-service'\)/.test(discSrc) && /await import\('node-ssdp'\)/.test(discSrc),
      `M7-K **真网络只走惰性 import**：\`device-discovery.ts\` 无顶层 \`bonjour-service\`/\`node-ssdp\` 引用，`
      + `真实现只在 \`defaultDiscoveryIo()\` 内 \`await import(...)\`——rr 注入假 IO 时模块图**不拉**重依赖。`);
    const regSrc = strip(DEVICE_REGISTRY_SRC);
    crit('M7', !/from 'electron'/.test(regSrc) && !/bonjour-service/.test(regSrc) && !/node-ssdp/.test(regSrc),
      `M7-L **台账语义零网络依赖**：\`device-registry.ts\` 不引 electron / bonjour-service / node-ssdp——纯 DB 语义，故 rr 可直引跑真实现。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M8】批三 · 设备类工具（新增 ToolCategory = \'device\'）');
  {
    const meta = (n: string) => TOOL_METAS.find((m) => m.name === n);
    crit('M8', meta('list_devices')?.category === 'device' && meta('list_devices')?.isReadOnly === true
      && meta('device_status')?.category === 'device' && meta('device_status')?.isReadOnly === true
      && meta('device_control')?.category === 'device' && meta('device_control')?.isReadOnly === false,
      `M8-A 三件在册且归类：\`list_devices\`/\`device_status\`（readonly）、\`device_control\`（write 语义但 \`category='device'\`）。`,
      `list=${meta('list_devices')?.category}/${meta('list_devices')?.isReadOnly} · status=${meta('device_status')?.category} · control=${meta('device_control')?.category}/${meta('device_control')?.isReadOnly}`);
    // 计数注释与运行期同真（表动注释不动即假）。
    // ⚠ 本条判的是**注释**，故须读**原文**（`strip` 会把块注释抹成空白 ⇒ 证据自毁、假绿见 -1）。
    const trRaw = RD(TOOL_REGISTRY_SRC);
    const declared = Number((trRaw.match(/^\s*\*\s*(\d+)\s*个工具的元数据表/m) || [])[1] ?? -1);
    crit('M8', declared === TOOL_METAS.length,
      `M8-B **计数注释 = 运行期**：注释里的 ${declared} 须等于 \`TOOL_METAS.length\`（${TOOL_METAS.length}）——表动注释不动即假。`,
      `注释=${declared} · 实际=${TOOL_METAS.length}`);

    // 类目落档两侧标本（该给的两档有、不该给的档无）。
    const cats = (a: keyof typeof ARCHETYPE_TOOL_CATEGORIES) => ARCHETYPE_TOOL_CATEGORIES[a];
    crit('M8', cats('code').includes('device') && cats('configuration').includes('device'),
      `M8-C **该给的两档有**：\`code\`/\`configuration\` 含 \`'device'\`（"配得上/AI 终端"场景）。`,
      `code=${cats('code').includes('device')} · configuration=${cats('configuration').includes('device')}`);
    // ★ zx_20261014_2 重定向（承 feedback_retarget_assertions_to_stronger_source：改钉更强的新真源，**不放宽、不删**）：
    //   原 M8-D 钉"**不该给的档无**"（research/document/analysis/conversation 皆不含 device），M8-E 钉
    //   "code 含、research 不含"。实机 E2E 证伪了 M8 的假设（"其余档不给"）——任务「打开客厅台灯」是短祈使句
    //   ⇒ 落 `conversation` ⇒ 设备三件被收走，模型看不见、任务假完成（详见 plans/improve/zx_20261014_2.md §0.2）。
    //   `device` 已升**第四类底线**（同 zx_20260930 M10 的 `resource`）⇒ 两条改为"**六档逐档全含**"——
    //   **更强**：由"点名四档不含"扩为"逐档枚举六档皆含"，覆盖面只增不减。
    const six = Object.keys(ARCHETYPE_TOOL_CATEGORIES) as Array<keyof typeof ARCHETYPE_TOOL_CATEGORIES>;
    const missing = six.filter((a) => !cats(a).includes('device'));
    crit('M8', six.length === 6 && missing.length === 0,
      `M8-D **六档逐档全含** \`'device'\`（zx_20261014_2 升底线：短祈使句落任一档都够得着设备三件）。`,
      missing.length ? `缺档：${missing.join(' · ')}` : `六档齐备（${six.join(' · ')}）`);
    // 派生覆盖：类目表动了 ⇒ availableToolNames 自动跟随（改的是表不是函数）。
    const noDevCtl = six.filter((a) => !availableToolNames(a).includes('device_control'));
    crit('M8', noDevCtl.length === 0,
      `M8-E **派生覆盖**：六档 \`availableToolNames(a)\` **逐档**含 \`device_control\`——`
      + `成员由类目**派生**（\`narrowToolFace\` 同理自动覆盖）。`,
      noDevCtl.length ? `缺 device_control 的档：${noDevCtl.join(' · ')}` : `六档皆含`);

    // 工具面实测：三件真在 build 出的工具集里（用最小 deps 投射，只走设备这一路）。
    const db = devFdb();
    const ddb = db as unknown as DeviceDb;
    const tools = deviceTools({ db: ddb, taskId: 'task-dev', controlDevice: makeFakeTransport().t } as unknown as ToolDeps);
    crit('M8', typeof tools.list_devices?.execute === 'function' && typeof tools.device_status?.execute === 'function' && typeof tools.device_control?.execute === 'function',
      `M8-F **三件实测在册**：\`deviceTools(deps)\` 产出 \`list_devices\`/\`device_status\`/\`device_control\` 三件可执行工具。`);
    // agent-executor 装配第 8 路（接线那一跳按语句形状钉）。
    const aeSrc = strip(`${A}/src/main/core/agent-executor.ts`);
    crit('M8', /\.\.\.deviceTools\(deps\)/.test(aeSrc) && /import \{ deviceTools \} from '\.\/tools\/device\.js'/.test(aeSrc),
      `M8-G **装配到位**：\`agent-executor.ts\` 引 \`deviceTools\` 且 \`buildTools()\` 有 \`...deviceTools(deps)\` 第 8 路。`);
    // deps.ts 声明了可注入传动（否则真网络无法在 rr 内被掐断）。
    const depsSrc = strip(`${A}/src/main/core/tools/deps.ts`);
    crit('M8', /controlDevice\?: DeviceControlTransport/.test(depsSrc),
      `M8-H **传动可注入**：\`ToolDeps\` 声明 \`controlDevice?: DeviceControlTransport\`——真机走默认 HTTP 件、受控回归喂假实现不触网。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M9】批三 · 显式授权白名单（K-6 · 王阳明·知行合一 / 康德·自由以他人自由为界）');
  {
    // ── 未授权：拒 + 不留状态 + 审计 0→1 + 传动未被调（两侧标本的"不该发"侧）────
    const db = devFdb();
    const ddb = db as unknown as DeviceDb;
    const dev = upsertDiscovered(ddb, { name: '次卧灯', kind: 'light', protocol: 'ssdp', address: '192.168.1.40', port: 80, capabilities: ['switch'], controllable: true }, '2026-10-04 08:00:00');
    const ft = makeFakeTransport();
    ok(listDeviceActions(ddb).length === 0, 'M9-A0 审计初为空（0→1 正面断言的"0"侧）');
    const denied = await runDeviceControl(ddb, { deviceId: dev.id, action: 'turn_on', taskId: 'task-x' }, ft.t);
    crit('M9', denied.ok === false && 'denied' in denied && denied.denied === true && denied.reason === 'not_authorized'
      && ft.calls.length === 0 && getDevice(ddb, dev.id)!.status === null && listDeviceActions(ddb).length === 1,
      `M9-A **未授权即拒**：返回 \`denied/not_authorized\`、**传动未被调**（没真发命令）、设备状态**未改**（仍 null），`
      + `但审计**留了一行**（拒绝件亦留痕）。`,
      `denied=${'denied' in denied && denied.denied} · 传动调用=${ft.calls.length} · 状态=${getDevice(ddb, dev.id)!.status} · 审计=${listDeviceActions(ddb).length}`);
    crit('M9', 'denied' in denied && typeof denied.how_to_authorize === 'string' && denied.how_to_authorize.length > 0,
      `M9-A' **拒不自闭**：带 \`how_to_authorize\` 可行动引导（照 \`run_privileged\` 的引导形状，不自造文案壳）。`,
      `how=${('denied' in denied ? denied.how_to_authorize.slice(0, 40) : '')}…`);

    // ── 授权后：真发命令（0→1 正面）+ 状态落库 + 审计记 ok ──────────────────
    setDeviceAuthorized(ddb, dev.id, true, '2026-10-04 08:05:00');
    const okOut = await runDeviceControl(ddb, { deviceId: dev.id, action: 'turn_on', taskId: 'task-x' }, ft.t);
    crit('M9', okOut.ok === true && ft.calls.length === 1 && ft.calls[0] === `${dev.id}:turn_on`
      && getDevice(ddb, dev.id)!.status != null && listDeviceActions(ddb).length === 2,
      `M9-B **授权后才真发命令（0→1 正面）**：传动被调 1 次、状态快照落库、审计第二行记 \`ok\`。`,
      `ok=${okOut.ok} · 传动=${ft.calls.join(',')} · 状态已落=${getDevice(ddb, dev.id)!.status != null} · 审计=${listDeviceActions(ddb).length}`);
    crit('M9', listDeviceActions(ddb).some((a) => a.result === 'denied') && listDeviceActions(ddb).some((a) => a.result === 'ok'),
      `M9-B' **全量留痕两侧**：审计里 \`denied\` 与 \`ok\` 各有其一（"含被拒"可证）。`,
      listDeviceActions(ddb).map((a) => a.result).join(','));

    // ── 高危：即便 authorized 也拒（§4 边界 #4）────────────────────────────
    const lock = upsertDiscovered(ddb, { name: '大门锁', kind: 'lock', protocol: 'mdns', address: '192.168.1.50', port: 80, capabilities: ['lock'], controllable: true }, '2026-10-04 08:00:00');
    setDeviceAuthorized(ddb, lock.id, true, '2026-10-04 08:05:00');
    const ft2 = makeFakeTransport();
    const hi = await runDeviceControl(ddb, { deviceId: lock.id, action: 'unlock' }, ft2.t);
    crit('M9', hi.ok === false && 'denied' in hi && hi.reason === 'high_risk' && ft2.calls.length === 0 && isHighRiskKind('lock'),
      `M9-C **高危即便授权也拒**：门锁类 \`authorized=true\` 仍拒（\`high_risk\`），传动未被调——把开锁交给一次点击，`
      + `代价与收益不对称（康德）。`,
      `reason=${'denied' in hi ? hi.reason : 'ok'} · 传动=${ft2.calls.length}`);
    // 不可控（自述只读）即便授权也拒。
    const ro = upsertDiscovered(ddb, { name: '温湿度计', kind: 'sensor', protocol: 'ssdp', address: '192.168.1.60', port: 80, capabilities: ['temp'], controllable: false }, '2026-10-04 08:00:00');
    setDeviceAuthorized(ddb, ro.id, true, '2026-10-04 08:05:00');
    const nc = await runDeviceControl(ddb, { deviceId: ro.id, action: 'set' }, makeFakeTransport().t);
    crit('M9', nc.ok === false && 'denied' in nc && nc.reason === 'not_controllable',
      `M9-D **自述不可控即拒**：\`controllable=false\`（只读设备）即便授权也拒（\`not_controllable\`）。`,
      `reason=${'denied' in nc ? nc.reason : 'ok'}`);

    // ── 闸函数：一处真源 + 四档各带下一步 ─────────────────────────────────
    const v = deviceControlVerdict(getDevice(ddb, dev.id));
    crit('M9', v.ok === true && deviceControlVerdict(null).ok === false && (deviceControlVerdict(null) as { reason: string }).reason === 'unknown_device',
      `M9-E **闸函数两侧**：已授权可控真设备 ⇒ \`ok:true\`；\`null\` ⇒ \`unknown_device\`。`,
      `真设备=${v.ok} · 空=${(deviceControlVerdict(null) as { reason?: string }).reason}`);
    // 判据面唯一：工具与面板**都**经 runDeviceControl（编排一处）——静态钉 "tool → runDeviceControl" 与 "ipc → runDeviceControl"。
    crit('M9', /runDeviceControl\(ddb/.test(strip(DEVICE_TOOLS_SRC)) && /runDeviceControl\(ddb/.test(strip(DEVICES_IPC_SRC)),
      `M9-F **判据/编排一处**：工具体与设备面板 IPC **都**调 \`runDeviceControl\`——不各写一份（罗尔斯·同一把尺）。`);
    const toolSrc = strip(DEVICE_TOOLS_SRC);
    crit('M9', (toolSrc.match(/deviceControlVerdict\(/g) || []).length === 1,
      `M9-G **闸只问一处**：\`tools/device.ts\` 内 \`deviceControlVerdict(\` **恰一次**（重写第二份即红）。`,
      `出现 ${(toolSrc.match(/deviceControlVerdict\(/g) || []).length} 次`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M10】批三 · 设备面板接线三层（周易·观卦 / 黑格尔·合理才存在）');
  {
    // 第一层：事件类型在 union **且**入聚合映射（只加 union 不加映射 ⇒ emit 静默不落库）。
    const evSrc = strip(EVENT_BUS_SRC);
    crit('M10', /'device\.discovered'/.test(evSrc) && /'device\.status_changed'/.test(evSrc),
      `M10-A **事件类型在 union**：\`device.discovered\`/\`device.status_changed\` 皆入 \`EventType\`。`);
    crit('M10', /'device\.discovered':\s*\{\s*aggregate_type:\s*'device'/.test(evSrc) && /'device\.status_changed':\s*\{\s*aggregate_type:\s*'device'/.test(evSrc),
      `M10-A' **入聚合映射（持久化）**：两事件皆 \`aggregate_type:'device'\`、\`idField:'deviceId'\`——`
      + `只加 union 不加此表 ⇒ emit 走"无聚合映射"分支、事件**一行都不落库**（静默）。`);

    // 第二层：index.ts 两条 forwardToRenderer 转发。
    const idxSrc = strip(MAIN_INDEX_SRC);
    crit('M10', /eventBus\.on\('device\.discovered',\s*async \(e\) => \{ forwardToRenderer\('device\.discovered'/.test(idxSrc)
      && /eventBus\.on\('device\.status_changed',\s*async \(e\) => \{ forwardToRenderer\('device\.status_changed'/.test(idxSrc),
      `M10-B **转发到位**：\`index.ts\` 两条 \`forwardToRenderer\`（不转发则面板收不到实时刷新）。`);
    // zx_20261029_2 M2：`initDevicesIpc` 现收第二个参数（模型兜底的取模型口）——本断言随之钉更强形状：
    //   **db 作第一实参**且**确有第二实参**（不是无参调用、不是把 getter 当第一参塞进去）。
    crit('M10', /initDevicesIpc\(db,\s*[A-Za-z_$][\w$]*\)/.test(idxSrc) && /import \{ initDevicesIpc \} from '\.\/ipc\/devices\.ipc\.js'/.test(idxSrc),
      `M10-B' **IPC 挂上**：\`index.ts\` 引并调 \`initDevicesIpc(db, <getAnsClient>)\`（db 第一参 + 取模型口第二参）。`);
    crit('M10', !/startDeviceDiscovery\(/.test(idxSrc),
      `M10-B'' **发现不自动起**：\`index.ts\` **不**在开机时调 \`startDeviceDiscovery\`——扫描局域网是用户显式动作（面板按钮）。`);

    // 第三层：electron.d.ts 声明（渲染层有字段可读）。
    const dts = RD(ELECTRON_D_TS);
    crit('M10', /deviceId\?: string;/.test(dts) && /device\?: Record<string, unknown>;/.test(dts) && /isNew\?: boolean;/.test(dts),
      `M10-C **类型声明齐**：\`electron.d.ts\` 的 \`TaskEvent\` 声明 \`deviceId\`/\`device\`/\`isNew\`。`);

    // IPC 五个出口齐 + renderer 侧 devices + 路由/导航 + 面板文件。
    const dipc = strip(DEVICES_IPC_SRC);
    crit('M10', ['devices:list', 'devices:discover', 'devices:stop', 'devices:authorize', 'devices:control']
      .every((c) => dipc.includes(`'${c}'`)),
      `M10-D **IPC 五出口齐**：list / discover / stop / authorize / control。`,
      ['devices:list', 'devices:discover', 'devices:stop', 'devices:authorize', 'devices:control'].filter((c) => !dipc.includes(`'${c}'`)).join(',') || '全在');
    const ripc = strip(RENDERER_IPC_TS);
    crit('M10', /export const devices = \{/.test(ripc) && /'devices:control'/.test(ripc) && /DevicesListPayload/.test(ripc),
      `M10-E **renderer 侧 devices**：\`renderer/lib/ipc.ts\` 导出 \`devices\`（list/discover/stop/authorize/control）+ 载荷类型。`);
    crit('M10', /path="\/devices"/.test(strip(APP_TSX)) && /to: '\/devices'/.test(strip(NAV_CONFIG_TS)),
      `M10-F **路由 + 导航**：\`App.tsx\` 有 \`/devices\` 路由、导航真源 \`navConfig.ts\` 有 \`to: '/devices'\` 项。`);
    crit('M10', fs.existsSync(path.join(root, DEVICES_PAGE)),
      `M10-G \`DevicesPage.tsx\` 在册（发现列表 / 台账 / 授权开关 / 实时状态 / 手动控制）。`);
    // 面板不自写第二份判据：不出现服务端闸的判据标识符。
    const dpage = strip(DEVICES_PAGE);
    crit('M10', !/deviceControlVerdict|isHighRiskKind|isLanAddress/.test(dpage),
      `M10-H **界面不自写判据**：\`DevicesPage\` 不引 \`deviceControlVerdict\`/\`isHighRiskKind\`/\`isLanAddress\`——`
      + `能否执行一律由服务端裁定，界面只如实呈现（被拒时原样上屏 reason + how）。`);

    // 词表第二落点：搜构建产物**中文串**（标识符被 minify，搜符号会假绿）。
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^DevicesPage-.*\.js$/.test(f)) : [];
    crit('M10', chunks.length === 1,
      `M10-I ★扫描面自证：renderer 产物恰 1 份 \`DevicesPage-*.js\`（本判据须 renderer 先 build）`,
      chunks.join(',') || 'renderer/dist/assets 不存在（未经 build ⇒ 本判据无法成立）');
    const pageJs = chunks.length === 1 ? fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8') : '';
    crit('M10', pageJs.includes('开始发现') && pageJs.includes('允许控制') && pageJs.includes('控制留痕'),
      `M10-J **上屏到产物**：构建产物内真含面板中文串（发现按钮 / 授权开关 / 留痕标题）——"只写在源码、没打进 GUI"在此必红。`,
      `开始发现=${pageJs.includes('开始发现')} · 允许控制=${pageJs.includes('允许控制')} · 控制留痕=${pageJs.includes('控制留痕')}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M11】批四 · 能力卡（K-10 类目级；王阳明·知行合一 / 维特根斯坦·意义即用法）');
  {
    // 类目词表 + 人话名**同处**（承 shared-types 的 NODE_ROLE_LABEL 理由）：键集与词表一一对应。
    const labelKeys = Object.keys(NODE_CARD_CATEGORY_LABEL);
    crit('M11', labelKeys.length === NODE_CARD_CATEGORIES.length
      && NODE_CARD_CATEGORIES.every((c) => typeof NODE_CARD_CATEGORY_LABEL[c] === 'string' && NODE_CARD_CATEGORY_LABEL[c].length > 0),
      `M11-A **词表与人话名同处**：\`NODE_CARD_CATEGORY_LABEL\` 覆盖 \`NODE_CARD_CATEGORIES\` 全 ${NODE_CARD_CATEGORIES.length} 格且无空格——`
      + `加一格而未回填人话名即红（本仓"词表第二落点"的病根）。`,
      `词表=${NODE_CARD_CATEGORIES.join(',')} · 名=${labelKeys.join(',')}`);

    // 派生两侧标本（G-2）：空设备台账 ⇒ **不**自称 device；台账有件 ⇒ 含 device；且只**增**一格。
    const emptyDb = devFdb();
    const emptyCats = deriveNodeCategories(emptyDb as unknown as DeviceDb);
    const withDb = devFdb();
    upsertDiscovered(withDb as unknown as DeviceDb, { name: '客厅灯', kind: 'light', protocol: 'mdns', address: '192.168.1.20', port: 80, capabilities: ['switch'], controllable: true }, '2026-10-04 08:00:00');
    const withCats = deriveNodeCategories(withDb as unknown as DeviceDb);
    crit('M11', !emptyCats.includes('device') && withCats.includes('device')
      && emptyCats.includes('text') && emptyCats.includes('project_task')
      && withCats.filter((c) => c !== 'device').join(',') === emptyCats.join(','),
      `M11-B **能力自述两侧标本（K-10 仅列本机实际可做者）**：空台账 ⇒ 不含 \`device\`；落一件设备 ⇒ 含 \`device\`；`
      + `内建 \`text\`/\`project_task\` 恒在。空台账的机器**不**冒充能控设备。`,
      `空=[${emptyCats.join(',')}] · 有=[${withCats.join(',')}]`);

    // 组卡：形状取自 shared-types 的 NodeCard，值只填不求（platform 由调用方给，不另采一次）。
    const card = buildNodeCard({ id: 'n-1', name: '工蚁一号' } as unknown as NodeIdentity, emptyDb as unknown as DeviceDb, 'darwin/arm64');
    crit('M11', card.node_id === 'n-1' && card.platform === 'darwin/arm64'
      && card.categories.join(',') === emptyCats.join(','),
      `M11-C **组卡一处**：\`buildNodeCard\` 填 \`{name,node_id,platform,categories}\`；\`platform\` 原样回传（与 status 同一次采集的同值）。`,
      `cats=[${card.categories.join(',')}] · platform=${card.platform}`);

    // 接线那一跳：卡随**既有心跳**出门（心跳第三参 card；ANS 的 `/nodes/heartbeat` 本已支持 body.card）。
    const hb = strip(NODE_HEARTBEAT_SRC);
    crit('M11', /buildNodeCard\(identity, db as unknown as DeviceDb, env\.platform\)/.test(hb)
      && /send\(identity\.id, payload, card\)/.test(hb),
      `M11-D **卡随心跳出门（接线那一跳的形状）**：\`node-heartbeat.ts\` 组卡后作**第三参**喂 \`send(id,payload,card)\`——`
      + `只建卡不上送，是他处"建了没用上"的病根形态。`);

    // 公开卡新增 ans_nodes 占位（只增不改）。
    const a2a = strip(A2A_PROXY_SRC);
    crit('M11', /id: 'ans_nodes'/.test(a2a) && /id: 'ans_chat'/.test(a2a) && /id: 'ans_discover'/.test(a2a) && /id: 'ans_task'/.test(a2a),
      `M11-E **公开卡只增不改**：\`a2a-proxy.ts\` 的四技能 \`ans_chat\`/\`ans_discover\`/\`ans_task\` **不动**，新增 \`ans_nodes\` 占位。`);

    // ANS 侧：心跳存 card_json、GET /nodes 原样曝光、提交端点收窄类目。
    const nr = strip(NODES_ROUTE_SRC);
    crit('M11', /card_json = \?/.test(nr) && /card: jsonObject\(row\.card_json\)/.test(nr) && /isNodeCardCategory\(body\.category\)/.test(nr),
      `M11-F **ANS 侧三处**：心跳把 \`card_json\` 落库、\`toNode\` 原样解出 \`card\`、提交端点以 \`isNodeCardCategory\` 收窄类目（非法类目 400）。`,
      `落库=${/card_json = \?/.test(nr)} · 曝光=${/card: jsonObject\(row\.card_json\)/.test(nr)} · 收窄=${/isNodeCardCategory\(body\.category\)/.test(nr)}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M12】批四 · 中转队列（管子·势 / 孙子·以逸待劳；AI 终端 → ANS → 工蚁 → 回传）');
  {
    // 状态机字面量在册（收窄函数与枚举同处）。
    // zx_20261011_1 M4：状态机增 `awaiting_answer`（可答中间态，非终态）；zx_20261030_1 M3 再增
    //   `cancelled`（叫停后真停的终态）——此断言的**钉点同步上移**到新全表（承"改旧断言＝改钉更强的
    //   新真源，不是放宽"：枚举面变大，钉的是更大的面，强度只增不减）。
    crit('M12', NODE_REQUEST_STATUSES.join(',') === 'pending,assigned,awaiting_answer,done,error,cancelled'
      && isNodeRequestStatus('assigned') && isNodeRequestStatus('awaiting_answer') && isNodeRequestStatus('cancelled')
      && !isNodeRequestStatus('__bogus__'),
      `M12-A **状态机在册**：\`pending → assigned ↔ awaiting_answer → done/error/cancelled\`（M4 增可答中间态，M3 增叫停终态）；`
      + `收窄函数两侧标本（'assigned'/'awaiting_answer'/'cancelled' 真 / '__bogus__' 假）。`,
      NODE_REQUEST_STATUSES.join(','));

    // 选目标唯一处 + pending→assigned 那一跳（死档之治）。
    const nr = strip(NODES_ROUTE_SRC);
    crit('M12', /function selectTargetNode\(/.test(nr) && /selectTargetNode\(db, body\.category\)/.test(nr)
      && /function claimPendingForNode\(/.test(nr) && /claimPendingForNode\(db, nodeId\)/.test(nr),
      `M12-B **选目标一处 + 认领那一跳**：\`selectTargetNode\`（提交时选）与 \`claimPendingForNode\`（拉取时认领积压）皆在册；`
      + `后者不可省——否则提交当刻无人在线所落的 pending 是**死档**（状态机名存实亡）。`);
    crit('M12', /json_each\(ans_nodes\.card_json, '\$\.categories'\)/.test(nr)
      && /card\.categories\.filter\(isNodeCardCategory\)/.test(nr),
      `M12-B' **类目读取两处同源**：选目标走 SQL \`json_each(card_json,'$.categories')\`；认领走 JS 侧 \`card.categories.filter(...)\`——`
      + `卡是**对象**非裸数组，裸 \`jsonArray(card_json)\` 会恒取 \`[]\`（M12-④ 判据正是照这个）。`);
    crit('M12', /groups\.includes\(`node:\$\{nodeId\}`\)/.test(nr) && /groups\.includes\(`node:\$\{body\.node_id\}`\)/.test(nr),
      `M12-B'' **越权防线双校验**：拉取与回传**都**要求调用方 key 的资源组含 \`node:<id>\`——`
      + `只查 target 字段（不含 key 资源组）则"猜中 id"即可读走他人待办。`);

    // 类目 → 原型档 唯一映射 + 两侧标本（未识别类目 ⇒ 拒办，不给默认档）。
    const catKeys = Object.keys(CATEGORY_ARCHETYPE).sort().join(',');
    crit('M12', catKeys === [...NODE_CARD_CATEGORIES].sort().join(','),
      `M12-C **映射覆盖全类目**：\`CATEGORY_ARCHETYPE\` 键集 == \`NODE_CARD_CATEGORIES\`（加一格而未映射 ⇒ 此处红）。`,
      `映射=${catKeys}`);
    const faceText = categoryToolFace('text');
    const faceBogus = categoryToolFace('__bogus__');
    crit('M12', faceText.archetype === 'conversation' && faceText.tools.length > 0
      && faceBogus.archetype === null && faceBogus.tools.length === 0,
      `M12-C' **工具面两侧标本**：'text' ⇒ 'conversation' 档且工具有名；未识别类目 ⇒ \`{archetype:null, tools:[]}\`——`
      + `**拒办**，不擅自给"默认档"（默认档即越权）。`,
      `text=${faceText.archetype}/${faceText.tools.length} · bogus=${faceBogus.archetype}/${faceBogus.tools.length}`);

    // 消费者三段落（拉→限面→跑+回传）+ 两侧标本（可办 vs 拒办）+ 回传失败不谎报。
    const mkReq = (id: string, category: string): AnsNodeRequest => ({
      id, category, payload: {}, requester_key_prefix: 'abcd1234', target_node_id: 'n-1',
      status: 'assigned', result: null, created_at: '2026-10-04 00:00:00', claimed_at: null, done_at: null,
    });
    const reported: Array<{ id: string; status: string }> = [];
    const runnerCalls: string[] = [];
    const events: NodeRequestEvent[] = [];
    const io: RequestIo = {
      async list() { return [mkReq('r1', 'text'), mkReq('r2', '__bogus__')]; },
      async report(id, report) { reported.push({ id, status: report.status }); return {}; },
    };
    const runner: RequestRunner = async (r, tools, archetype) => {
      runnerCalls.push(`${r.category}:${archetype}:${tools.length > 0}`);
      return { status: 'done', result: { summary: 'ok' } };
    };
    const handled = await startNodeRequestWorker({ nodeId: 'n-1', io, runner, onEvent: (e) => events.push(e) }).poll();
    crit('M12', handled === 2 && runnerCalls.length === 1 && runnerCalls[0] === 'text:conversation:true'
      && reported.length === 2
      && events.filter((e) => e.type === 'node.request_received').length === 2
      && events.filter((e) => e.type === 'node.request_completed').length === 2,
      `M12-D **三段落 + 拒办两侧**：拉回两件 ⇒ 可办的跑一次（runner 收到限定工具面）、未识别类目**不跑 runner** 直接回 error；`
      + `到场/收口各两事件（M13 据此聚账）。`,
      `handled=${handled} · runner=${runnerCalls.join('|')} · reported=${reported.map((r) => `${r.id}:${r.status}`).join(',')} · 事件=${events.length}`);

    const ev2: NodeRequestEvent[] = [];
    const ioFail: RequestIo = { async list() { return [mkReq('r9', 'text')]; }, async report() { throw new Error('net down'); } };
    await startNodeRequestWorker({ nodeId: 'n-1', io: ioFail, runner: async () => ({ status: 'done', result: {} }), onEvent: (e) => ev2.push(e) }).poll();
    const failDone = ev2.find((e) => e.type === 'node.request_completed');
    crit('M12', failDone?.status === 'error' && (failDone?.result as { error?: string } | undefined)?.error === 'result report failed',
      `M12-D' **回传失败不谎报**：\`io.report\` 抛错 ⇒ 收口事件记 \`status:'error'\`（该件仍 assigned，下轮重拉 ⇒ **至少一次**，不假装恰好一次）。`,
      `completed=${JSON.stringify(failDone?.result)}`);

    // 声明即意志：pinnedArchetype 两侧标本 + 接线（pinned 非空则分类/校准都不推翻）。
    crit('M12', pinnedArchetype(JSON.stringify({ node_archetype: 'conversation' })) === 'conversation'
      && pinnedArchetype('{}') === null && pinnedArchetype(JSON.stringify({ node_archetype: '__bogus__' })) === null
      && pinnedArchetype(null) === null && pinnedArchetype('not json') === null,
      `M12-E **声明锁原型两侧标本**：合法档 ⇒ 用；无 \`node_archetype\` / 非法档 / 非 JSON ⇒ \`null\`（回落原分类，既存任务零回归）。`);
    const ae = strip(AGENT_EXECUTOR_SRC);
    // zx_20261030_2 M1/M2（名随其实）：判定改为**带来源的决策对象**——钉更强的新载体：
    //   ① 判定入口是 `resolvePinnedArchetype`（`pinnedArchetype` 仅余包装）；
    //   ② 分类被 pinned 挡住（`pinnedDec ?? classifyArchetypeDetailed`）；
    //   ③ 校准结果被 pinned 覆盖（`pinnedDec?.archetype ?? calibrated`，且 `calibrated` 真调用）；
    //   ④ 最终收窄仍读 `archetype`。四条同钉，比原先"字面量 pinned ?? f()"更强。
    crit('M12', /const pinnedDec = resolvePinnedArchetype\(task\.context_json\)/.test(ae)
      && /pinnedDec \?\? classifyArchetypeDetailed\(/.test(ae)
      && /const calibrated = calibrateArchetype\(/.test(ae)
      && /pinnedDec\?\.archetype \?\? calibrated/.test(ae)
      && /narrowToolFace\(archetype, tools/.test(ae),
      `M12-E' **接线三处**：\`pinnedDec\` 同时挡住 \`classifyArchetypeDetailed\` 与 \`calibrateArchetype\`，最终 \`narrowToolFace(archetype,…)\` 真收窄——`
      + `只读一处则声明会在求值点被悄悄推翻（与没声明无异）。`);
    const allNames = toolRegistry.listNames();
    const toolsObj = Object.fromEntries(allNames.map((n) => [n, {}]));
    const convFace = narrowToolFace('conversation', toolsObj);
    const codeFace = narrowToolFace('code', toolsObj);
    crit('M12', convFace.kept.length < codeFace.kept.length && convFace.removed.length > 0,
      `M12-E'' **收窄非空**：\`conversation\` 保留的工具**少于** \`code\`（档不同则面不同，非"锁定了个空集"）。`,
      `conversation=${convFace.kept.length} · code=${codeFace.kept.length}`);

    // 接线：index.ts 起消费者（与心跳同拍）+ runner 只写 node_archetype（有读者）。
    const idx = strip(MAIN_INDEX_SRC);
    crit('M12', /startNodeRequestWorker\(\{/.test(idx) && /makeAnsRequestIo\(db\)/.test(idx) && /makeRelayRunner\(\{ db \}\)/.test(idx)
      && /void _nodeRequestWorker\?\.poll\(\)/.test(idx),
      `M12-F **消费者接线**：\`index.ts\` 以 \`makeAnsRequestIo(db)\`+\`makeRelayRunner({db})\` 起消费者，心跳 \`onTick\` 里 \`poll()\`——`
      + `与心跳同拍，不另开一条时钟。`);
    // zx_20261011 M11 订正（**钉更强的新真源，非放宽**）：runner 现落**两个皆有读者**的键——
    //   `node_archetype`（读者 `pinnedArchetype`）与 `no_interaction`（读者 `core/no-interaction.ts`：
    //   `ask_user` 短路提问 / 门禁放行）；键名经真源常量，不在此手抄字面量。
    // zx_20261011_2 M2 再订正（**仍非放宽**）：随答案注入新增第三键 `node_request_id`（读者 `node-clarify.ts`
    //   的 `requestIdOf`，供 `ask_user` 向上游提问）。原判据用 `[^}]*` 跨不过内联展开 `{...}` 选项里的 `}`——
    //   形态脆而非语义松。改**取整段调用体**（`[\s\S]*?` 至行首 `});`，内联展开的 `}` 不在行首故不误闭）
    //   后**逐成员枚举**三键，比原判据更强（钉住"三键同一次调用内落库"）。
    const ucCall = /tasks\.updateContext\(taskId, \{([\s\S]*?)\n\s*\}\);/.exec(strip(NODE_REQUEST_RUNNER_SRC));
    crit('M12', !!ucCall && ['node_archetype: archetype', '[NO_INTERACTION_KEY]: true', '[NODE_REQUEST_ID_KEY]: req.id'].every((k) => ucCall![1].includes(k)),
      `M12-F' **只写有读者的字段**：\`node-request-runner\` 落 \`context_json\` 的三键（\`node_archetype\`+M11 \`no_interaction\`+M2 \`node_request_id\`）**同一次调用内皆有读者**，无"没人读的 id"。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M13】批四 · 调用可见（维特根斯坦·意义即用法 / 黑格尔·合理才存在）');
  {
    // 事件入 union **且**入聚合映射（只加 union 不加映射 ⇒ 静默不落库，M13 聚合面就永远读不到）。
    const evSrc = strip(EVENT_BUS_SRC);
    crit('M13', /'node\.request_received'/.test(evSrc) && /'node\.request_completed'/.test(evSrc)
      && /'node\.request_received':\s*\{\s*aggregate_type:\s*'node_request'/.test(evSrc)
      && /'node\.request_completed':\s*\{\s*aggregate_type:\s*'node_request'/.test(evSrc),
      `M13-A **事件两层齐**：两事件皆入 \`EventType\` **且** \`aggregate_type:'node_request'\`（持久化）——`
      + `只加 union 不加映射 ⇒ emit 走"无聚合映射"分支、一行都不落库（静默）。`);

    // 转发到位 + IPC + renderer 出口 + 面板。
    const idx = strip(MAIN_INDEX_SRC);
    crit('M13', /forwardToRenderer\('node\.request_received'/.test(idx) && /forwardToRenderer\('node\.request_completed'/.test(idx),
      `M13-B **转发到位**：\`index.ts\` 两条 \`forwardToRenderer\`——不转发则面板收不到实时刷新。`);
    const nipc = strip(NODES_IPC_SRC);
    crit('M13', /'nodes:requests'/.test(nipc) && /listNodeCallRecords\(/.test(nipc),
      `M13-C **IPC 出口**：\`nodes.ipc.ts\` 的 \`nodes:requests\` 直调 \`listNodeCallRecords\`（纯本地读，不触网）。`);
    const ripc = strip(RENDERER_IPC_TS);
    crit('M13', /requests: \(\) => ipcCall<NodeRequestsPayload>\('nodes:requests'\)/.test(ripc) && /NodeRequestsPayload/.test(ripc),
      `M13-C' **renderer 出口**：\`renderer/lib/ipc.ts\` 的 \`nodes.requests()\` + \`NodeRequestsPayload\`。`);
    const pp = strip(PEERS_PAGE);
    crit('M13', /nodesApi\.requests\(\)/.test(pp) && /NodeCallRecord/.test(RD(PEERS_PAGE)),
      `M13-C'' **面板消费**：\`PeersPage\` 调 \`nodesApi.requests()\` 并以 \`NodeCallRecord\`（main 侧真源类型）取形——不手抄镜像。`);

    // 聚合面两侧标本（功能，读生产 listNodeCallRecords）：收口齐 ⇒ done+耗时；只到场 ⇒ pending+null（不编 0）。
    const ed = new DatabaseSync(':memory:');
    ed.exec('CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT, aggregate_id TEXT, event_type TEXT, payload TEXT, occurred_at TEXT);');
    const ins = ed.prepare('INSERT INTO wa_event_log (aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES (?,?,?,?,?)');
    ins.run('node_request', 'r1', 'node.request_received', JSON.stringify({ category: 'text', requesterKeyPrefix: 'abcd1234' }), '2026-10-04T00:00:00.000Z');
    ins.run('node_request', 'r1', 'node.request_completed', JSON.stringify({ category: 'text', requesterKeyPrefix: 'abcd1234', status: 'done', result: { summary: 'ok' } }), '2026-10-04T00:00:02.500Z');
    ins.run('node_request', 'r2', 'node.request_received', JSON.stringify({ category: 'code', requesterKeyPrefix: 'efgh5678' }), '2026-10-04T00:01:00.000Z');
    const recs = listNodeCallRecords(ed as unknown as CallLogDb);
    const r1 = recs.find((r) => r.requestId === 'r1');
    const r2 = recs.find((r) => r.requestId === 'r2');
    crit('M13', recs.length === 2 && r1?.status === 'done' && r1?.durationMs === 2500
      && r1?.requesterKeyPrefix === 'abcd1234' && (r1?.result as { summary?: string } | undefined)?.summary === 'ok'
      && r2?.status === 'pending' && r2?.completedAt === null && r2?.durationMs === null,
      `M13-D **聚合面两侧标本**：一条请求**一行**（两条事件归并）；收口齐 ⇒ \`done\`+耗时 2500ms；只到场 ⇒ \`pending\`+耗时 \`null\`——`
      + `两时刻缺一即"不知道"，**不补 0** 冒充瞬时完成。`,
      `条数=${recs.length} · r1=${r1?.status}/${r1?.durationMs} · r2=${r2?.status}/${r2?.durationMs}`);
    ed.close();

    // 词表第二落点：搜构建产物**中文串**（标识符被 minify）。
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^PeersPage-.*\.js$/.test(f)) : [];
    crit('M13', chunks.length === 1,
      `M13-E ★扫描面自证：renderer 产物恰 1 份 \`PeersPage-*.js\`（本判据须 renderer 先 build）`,
      chunks.join(',') || 'renderer/dist/assets 不存在（未经 build ⇒ 本判据无法成立）');
    // zx_20261011_4（本轮改钉更强的新真源）：协同域词表（`CALL_STATUS_LABEL` 的「待办中」等）定义在
    //   `lib/node-view.ts`——自 TaskDetailPage 也引它后，Rollup 把该模块抽成**独立共享 chunk**
    //   （此前只 PeersPage 引 ⇒ 被内联）。判据的**真意**是"这些串真进了 GUI 产物"（不是"钉死在某个文件名里"），
    //   而「待办中」的**真源**就是 `node-view.ts` ⇒ 它的落点取 **页面 chunk ∪ 词表 chunk**；
    //   页面自有串（调用记录/耗时/能做）**仍钉在页面 chunk**（不随词表搬走而放松）。
    const vocabChunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^node-view-.*\.js$/.test(f)) : [];
    const peersJs = chunks.length === 1 ? fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8') : '';
    const vocabJs = vocabChunks.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf-8')).join('\n');
    const hasTodo = (peersJs + vocabJs).includes('待办中');
    crit('M13', peersJs.includes('AI 终端调用记录') && hasTodo && peersJs.includes('耗时') && peersJs.includes('能做'),
      `M13-E' **上屏到产物**：构建产物内真含面板中文串（调用记录 / 待办中 / 耗时 / M11 能力"能做"）——"只写在源码、没打进 GUI"在此必红。`,
      `调用记录=${peersJs.includes('AI 终端调用记录')} · 待办中=${hasTodo} · 耗时=${peersJs.includes('耗时')} · 能做=${peersJs.includes('能做')}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M14】批五 · 轻得下（维特根斯坦·一个规则一处 / 老子·损之又损）');
  {
    const mm = strip(MEMORY_MANAGER_SRC);
    const kg = strip(MEMORY_KG_SRC);
    const prosp = strip(MEMORY_PROSP_SRC);

    // A 恰一份实现：旧载体去注释面**不再含**搬移集那两簇的 SQL 字面量（注释里的历史说明不算在场）。
    crit('M14', !/wa_knowledge_triples/.test(mm) && !/memory_type\s*=\s*'prospective'/.test(mm),
      `M14-A **恰一份实现**：\`memory-manager.ts\` 去注释面**零** \`wa_knowledge_triples\` / \`memory_type='prospective'\` (等式形)`
      + `——知识图谱簇与前瞻记忆簇的 SQL 已整体离场到新模块。`);
    crit('M14', /wa_knowledge_triples/.test(kg) && /memory_type\s*=\s*'prospective'/.test(prosp),
      `M14-B **新载体承接**：SQL 落点唯一——\`memory-kg.ts\` 含 \`wa_knowledge_triples\`、\`memory-prospective.ts\` 含 \`memory_type='prospective'\`。`);

    // C 接线那一跳按**语句形状**：类上保留同名薄委托（不是"另抄一份等价实现"，承 G-1 与
    //   `feedback_equivalence_needs_wiring_criterion`）。
    crit('M14', /return kgStoreTriple\(this,/.test(mm) && /return kgSearchKnowledgeGraph\(this,/.test(mm)
      && /return prospStoreProspective\(this,/.test(mm) && /return prospScanDueProspective\(this,/.test(mm),
      `M14-C **接线那一跳（按语句形状）**：\`memory-manager.ts\` 的十个同名方法体皆为 \`return kg*\/prosp*(this, …)\` 薄委托`
      + `——调用点（\`tools/memory.ts\`/\`jobs/index.ts\`/\`memory-context.ts\`/…）零改动，实现唯一在模块侧。`);
    crit('M14', /scheduleChanged\(projectId: string \| null \| undefined, memoryType: string\): void \{[\s\S]{0,220}?scheduleMemoryChanged\(projectId, memoryType\);/.test(mm),
      `M14-C' **宿主面接入**：类新增 \`scheduleChanged\` 薄面转模块级节流器（前瞻簇经此注入，避免反向 import 成 ESM 环）。`);

    // D 反证旧名：写入口唯一。
    crit('M14', (kg.match(/INSERT INTO wa_knowledge_triples/g) ?? []).length === 1,
      `M14-D **反证旧名**：\`INSERT INTO wa_knowledge_triples\` 在 \`memory-kg.ts\` **恰一处**（去重 UPSERT 的唯一写入口），不再散落。`);

    // E 功能：**真** MemoryManager 的薄委托真通（不是只"形状在场"）。0→1 正面断言（G-3）。
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_knowledge_triples (id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL,
  predicate TEXT NOT NULL, object TEXT NOT NULL, confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'agent_extraction', created_at TEXT DEFAULT (datetime('now')));`);
    // 夹具按生产初始化顺序：先 `new` 服务类（建 FTS 触发器）**再**插行（承 feedback_rr_fixture_production_order）。
    const mgr = new MemoryManager(db as never, null as never);
    const before = (db.prepare("SELECT COUNT(*) c FROM wa_memories WHERE memory_type='prospective'").get() as { c: number }).c;
    const pid = mgr.storeProspective({ projectId: 'p-m14', content: '到期提醒', dueAt: '2000-01-01T00:00:00Z' });
    const after = (db.prepare("SELECT COUNT(*) c FROM wa_memories WHERE memory_type='prospective'").get() as { c: number }).c;
    crit('M14', before === 0 && after === 1 && typeof pid === 'string' && pid.length > 0,
      `M14-E **0→1 正面断言（真委托）**：\`mgr.storeProspective\` 走薄委托真落库——\`prospective\` 行数 0→1`
      + `（只断言"不抛"抓不住被 \`catch {}\` 吞掉的写入；此处值真的从 0 变 1）。`,
      `${before} → ${after}`);
    // 簇内互通：模块侧自由函数读的是同一库、同一形状。
    const due = prospScanDueProspective(mgr as never, Date.now());
    crit('M14', due.length === 1 && due[0]!.content === '到期提醒',
      `M14-E' **簇内互通（真 free 函数）**：\`scanDueProspective\` 扫到刚登记的时间型前瞻（\`due_at\` 已过）并标记 triggered。`);
    // 知识图谱簇同类：真委托 storeTriple 真落一行，searchKnowledgeGraph 真读回（0→1 + 往返）。
    mgr.storeTriple({ projectId: 'p-m14', subject: '项目', predicate: 'uses', object: 'sqlite', confidence: 0.9 });
    const hit = mgr.searchKnowledgeGraph('sqlite', 'p-m14', 5);
    const miss = kgSearchKnowledgeGraph(mgr as never, '绝无此词XYZ', 'p-m14', 5);
    crit('M14', hit.length >= 1 && hit.every((t) => t.subject === '项目' && t.object === 'sqlite') && miss.length === 0,
      `M14-E'' **知识图谱往返（两标本）**：\`mgr.storeTriple\` 落三元组后 \`mgr.searchKnowledgeGraph\` 命回；不可达查询仍空`
      + `（模块侧 \`kgSearchKnowledgeGraph\` 与类侧委托同一实现）。`,
      `命中 ${hit.length} · 空 ${miss.length}`);
    db.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M15】批五 · 轻得下（庄子·名者实之宾也 / 维特根斯坦·一个规则一处）');
  {
    const ds = strip(DAEMON_SUPERVISOR_SRC);
    const ipc = strip(PROJECT_IPC_SRC);
    const idx = strip(MAIN_INDEX_SRC);

    // A 新载体承接：`export` 的 Map（供养约 20 处注册体读写）+ 监督整段符号。
    crit('M15', /export const runtimeProcesses = new Map/.test(ds)
      && /export function autoStartDaemons\(/.test(ds) && /export function handleDaemonExit\(/.test(ds)
      && /async function killOrphan\(/.test(ds)
      && /export function initDaemonSupervisor\(/.test(ds) && /export function startDaemonHealthCheck\(/.test(ds),
      `M15-A **新载体承接**：\`core/daemon-supervisor.ts\` 导出 \`runtimeProcesses\`（Map，project.ipc.ts 的 MCP/服务型 handler 仍读写）`
      + `与监督整段；状态经 \`initDaemonSupervisor\`/\`startDaemonHealthCheck\` 注入（不模块级持 electron 侧引用）。`);
    // B 恰一份实现：监督整段函数体已离 project.ipc.ts。
    crit('M15', !/function autoStartDaemons\(/.test(ipc) && !/function handleDaemonExit\(/.test(ipc) && !/function killOrphan\(/.test(ipc),
      `M15-B **恰一份实现**：\`project.ipc.ts\` 去注释面**零** \`function autoStartDaemons|handleDaemonExit|killOrphan\`——监督整段已整体离场。`);

    // C 接线那一跳按语句形状：入口点改调注入函数。
    crit('M15', /initDaemonSupervisor\(db\)/.test(ipc) && /startDaemonHealthCheck\(db\)/.test(ipc)
      && /autoStartDaemons\(db\)/.test(ipc) && /adoptMCPOrphans\(db\)/.test(ipc),
      `M15-C **接线那一跳（按语句形状）**：\`initProjectIpc\` 内改调 \`initDaemonSupervisor(db)\` / \`startDaemonHealthCheck(db)\`，`
      + `开机 \`autoStartDaemons(db)\`/\`adoptMCPOrphans(db)\` 原样。`);
    // C' 留驻者仍读写同一 Map（旧 groupC-a 切块锚不动）。
    crit('M15', /import \{[^}]*runtimeProcesses[^}]*\} from '\.\.\/core\/daemon-supervisor\.js'/.test(ipc) && /runtimeProcesses\.set\(id,/.test(ipc),
      `M15-C' **留驻者仍读写同一 Map**：MCP/服务型成果自身的 spawn/exit handler 仍在 \`project.ipc.ts\`、经 import 读写 \`runtimeProcesses\``
      + `（\`runtimeProcesses.set(id,\` 切块锚仍在原文件 ⇒ 旧 groupC-a 断言不语）。`);
    // D 公开面可达：index.ts 调用面不变（stopAllRuntimeProcesses 经 re-export 转出唯一实现）。
    crit('M15', /stopAllRuntimeProcesses/.test(idx) && /export \{ stopAllRuntimeProcesses \} from '\.\.\/core\/daemon-supervisor\.js'/.test(ipc),
      `M15-D **公开面可达**：\`index.ts\` 的退出清理调用面**不变**——\`project.ipc.ts\` 以 re-export 转出唯一实现（签名/名字不动 ⇒ 调用方零改动）。`);

    // E 功能：真 handleDaemonExit 的"启动失败"支路真落 failed（0→1），且 Map 中被清（G-1/G-3）。
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
      description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}');`);
    db.prepare("INSERT INTO wa_deliverables (id, type, name, file_path, status) VALUES ('dv-m15','daemon','d','/tmp/x.py','running')").run();
    runtimeProcesses.set('dv-m15', { process: null, startedAt: Date.now() });
    handleDaemonExit(db as never, 'dv-m15', 'd', 1, '/tmp/x.py'); // code≠0 且 runtime<5000 ⇒ 启动失败支路
    const st = (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get('dv-m15') as { status: string }).status;
    crit('M15', st === 'failed' && !runtimeProcesses.has('dv-m15'),
      `M15-E **0→1 正面断言（真监督函数）**：\`handleDaemonExit\` 对"启动确认窗内退出"真落 \`failed\`（\`running\`→\`failed\`）`
      + `并把该条自 \`runtimeProcesses\` 清出——\`failed\` 的真生产者在搬移后仍活着。`,
      `status=${st} · 在场=${runtimeProcesses.has('dv-m15')}`);
    db.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  {
    // S1 本文件**不得**含前向 build 钉（否则 P5"全量前向钉 == 真源"在未改 build 时即红，等于给下一轮埋雷）。
    const selfLines = stripKeepingLines(RD('scripts/rr_zx_20261004.ts')).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, '本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20261004 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261004: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
