/**
 * zx_20261014_4 受控复跑 —— 「门」与「知」。
 *
 * 本脚本**分批长大**（承 CLAUDE.md 开发约定 3：每批落本轮新套件 + 受影响旧套件）：
 *   批一 → **G 组**（入站门地基：默认关 / 私网围栏 / 门牌只有三块 / 开关关即不起）
 *   批二 → P 组（配对与凭据）　批三 → C 组（能力面 + 留痕 + 软闸）
 *   批四 → D 组（域知识沉淀）　批五 → M 组（预算内选节注入）　批六 → S 组 + build 钉
 *
 * 批一口径一句话（道德经·善闭无关楗而不可开 ／ 罗尔斯·无知之幕 ／ 毛选·没有调查没有发言权）：
 *   工蚁此前只会**向外**找（ANS / 节点 / 设备），从不向外**露面** ⇒ 别的 AI 终端在局域网里
 *   没有任何办法知道"这里有一台工蚁"。本轮开一扇**有闸的门**：默认**关**、门外先认**街坊**（私网）、
 *   见面**只说三句**（不泄露设备/能力/node_id）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：本组直引生产导出（被删/改名即编译期失败，而非"扫个空、静默假绿"）。
 *   G-2 **两侧标本**：`isPrivateAddress` 私网/公网两组标本**都喂**（只用一侧 ⇒ 任何过宽变体全票通过）。
 *   G-4 **不依赖真实墙钟/真网络**：不真开网卡、不真广播——`serverFactory` 传假 server、`mdnsFactory: null`。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾 S 组自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：门的三处真源**静态导入**（被删/改名即编译期失败）。
import {
  INBOUND_DEFAULT_PORT,
  INBOUND_WELL_KNOWN_PATH,
  INBOUND_PROTOCOL,
  INBOUND_PAIR_ENDPOINT,
  INBOUND_PAIR_STATUS_PATH,
  INBOUND_CAPABILITIES_PATH,
  INBOUND_INVOKE_PATH,
  resolveInboundPort,
  isPrivateAddress,
  AGENT_CARD_FIELDS,
  buildAgentCard,
  handleInboundRequest,
  startInboundGate,
  stopInboundGate,
  isInboundRunning,
  inboundRunningPort,
  type InboundServer,
} from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
import { BOOL_SETTING_KEYS, boolSetting, readBoolSetting } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
// zx_20261021_3 批四：门牌扩到六键——能力类目与意图目录**派生**自这两处既有真源。
import { EXTERNAL_CAPABILITIES, EXTERNAL_CAPABILITY_LABEL, EXTERNAL_CAPABILITY_NOTE } from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import { publicIntents } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
// P-1：配对/凭据真源**静态导入**（被删/改名即编译期失败）。
import {
  approveTerminal,
  createPairRequest,
  createPairingPort,
  hashTerminalSecret,
  listTerminals,
  pairStatus,
  rejectTerminal,
  revokeTerminal,
  verifyTerminal,
  __resetTerminalSecretsForTest,
  type TerminalDb,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
// C-1/C-2/C-3/C-5：能力面 + 留痕真源**静态导入**（被删/改名即编译期失败）。
import {
  createExternalCapabilityPort,
  redactedDevices,
  isExternalCapability,
  isInvocableCapability,
  EXTERNAL_CAPABILITIES,
  EXTERNAL_CAPABILITY_LABEL,
  INVOKE_CAPABILITIES,
  type ExternalCapabilityDeps,
} from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import { deviceCallName } from '../apps/worker-ant-desktop/src/main/core/device-name.js';
import { TEAM_FEATURES, TEAM_FEATURE_LABEL, teamFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
import type { AnsDevice, DeviceControlOutcome } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  PROJECT_KNOWLEDGE_SECTIONS,
  PROJECT_KNOWLEDGE_SECTION_LABEL,
  deriveProjectKnowledge,
  upsertProjectKnowledge,
  listProjectKnowledge,
  orderKnowledgeSections,
  selectKnowledgeForInject,
  KNOWLEDGE_INJECT_MAX_TOKENS,
} from '../apps/worker-ant-desktop/src/main/core/project-knowledge.js';
// M-1：消费侧注入真源**静态导入**（被删/改名即编译期失败）。
import { buildMemoryContext, MEM_SECTION_PRIORITY } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红时立刻看得出差在哪）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 判"用户可见文案/调用形状"读**去注释后**的代码；判"接线在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

const GATE_SRC = `${A}/src/main/core/inbound-gate.ts`;
const INDEX_SRC = `${A}/src/main/index.ts`;
const DB_SRC = `${A}/src/main/database.ts`;
const PK_SRC = `${A}/src/main/core/project-knowledge.ts`;
const JOBS_SRC = `${A}/src/main/core/jobs/index.ts`;
const MC_SRC = `${A}/src/main/core/memory-context.ts`;
const MM_SRC = `${A}/src/main/core/memory-manager.ts`;

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261014_4

/** 假 server：记录 `listen` 是否被调用（G-4 的"开关关 ⇒ 不起服务"据此判）。 */
function fakeServerFactory(): { factory: () => InboundServer; state: { listenCalls: number; closed: number; port: number } } {
  const state = { listenCalls: 0, closed: 0, port: 0 };
  const factory = (): InboundServer => ({
    listen(port: number, cb: () => void) { state.listenCalls++; state.port = port; cb(); },
    close(cb: () => void) { state.closed++; cb(); },
    on() { /* 假 server 不上报 error */ },
  });
  return { factory, state };
}

/**
 * 终端表 DDL（P 组与 C 组**同一份**——夹具只有一处，免得两处 DDL 悄悄漂开）。
 * ⚠ 列形状须与生产 DDL **同形**（`P-0` 静态钉住生产 DDL 的列，改列名即红 ⇒ 逼夹具同步）。
 */
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

/** P 组夹具库：只有 `wa_external_terminals` 的内存库。 */
function makeTerminalDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(TERMINAL_DDL);
  return d;
}

/**
 * C 组夹具库：`wa_settings`（许可档位）+ `wa_external_calls`（留痕）+ 终端表（端口端到端用）。
 * `unlocked=true` ⇒ seed 试用起始时刻 ⇒ `kind==='trial'` ⇒ Team 软闸解锁——**与生产同一条判据链**
 *   （不是给软闸打桩，是喂它真输入）。`unlocked=false` ⇒ 无许可无试用 ⇒ `kind==='none'` ⇒ 锁定（真锁）。
 */
function makeDoorDb(unlocked = true): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
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
  if (unlocked) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}

/**
 * 域知识册表 DDL——列形状须与生产 **同形**（`D-0` 静态钉住生产 DDL 的列，改列名即红 ⇒ 逼夹具同步）。
 * ⚠ 生产的**唯一键**是另建的 `CREATE UNIQUE INDEX`（不是表内 `UNIQUE(...)`）——夹具**必须一并建**，
 *   否则 `ON CONFLICT(project_id, section)` 无约束可匹配（真跑即 `ERR_SQLITE_ERROR`）。
 *   索引名/列由 `D-0c` 钉住生产那一句 ⇒ 生产改索引必红，逼夹具同步。
 */
const KNOWLEDGE_DDL = `CREATE TABLE wa_project_knowledge (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    section TEXT NOT NULL,
    content TEXT NOT NULL,
    source_ref TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )`;
const KNOWLEDGE_IDX = `CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section)`;
// zx_20261022_3 批七: `listProjectKnowledge` 现在**必读**导入表（派生 ∪ 导入合并成一本册）——
//   夹具若漏建它，读取即抛错。生产建表见 `database.ts`（同样 `CREATE TABLE IF NOT EXISTS`）。
const KNOWLEDGE_IMPORTS_DDL = `CREATE TABLE wa_project_knowledge_imports (
    project_id TEXT NOT NULL,
    section TEXT NOT NULL,
    content TEXT NOT NULL,
    precedence INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT NOT NULL DEFAULT '',
    imported_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, section)
  )`;

/**
 * D 组夹具库：四类真源（三元组/交付物/调用账/运行面）+ 知识册表。
 * ⚠ `node:sqlite` 无 `db.transaction()` 而 `upsertProjectKnowledge` 是真实现（内含一支事务）⇒ 补 `withTx` 垫片。
 */
function withTx(d: DatabaseSync): DatabaseSync {
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => fn();
  return d;
}
function makeKnowledgeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_knowledge_triples (
    id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL, predicate TEXT NOT NULL,
    object TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'x',
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_deliverables (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, status TEXT, name TEXT, file_path TEXT)`);
  d.exec(`CREATE TABLE wa_service_calls (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, kind TEXT, target TEXT, operation TEXT,
    ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT, payload TEXT)`);
  // zx_20261017_1 批七: 册新增 criteria/recipes/index 三节，各读一张既有表——
  //   夹具须照生产同形建表（列名/默认值照搬 `database.ts`），否则派生 SQL 抛 "no such table"。
  d.exec(`CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, status TEXT DEFAULT 'pending',
    context_json TEXT DEFAULT '{}', acceptance_criteria TEXT DEFAULT '')`);
  d.exec(`CREATE TABLE wa_task_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
    description TEXT DEFAULT '', status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0)`);
  d.exec(`CREATE TABLE wa_memories (
    id TEXT PRIMARY KEY, project_id TEXT, content TEXT NOT NULL,
    memory_type TEXT DEFAULT 'episodic', is_exemplar INTEGER DEFAULT 0)`);
  // zx_20261018_2 批四: `domain` 读项目行、`usage` 读设备动作 ⇒ 夹具按生产同形补齐两表
  //   （缺表会让派生 SQL 抛 "no such table"，比生产宽松就是假绿）。
  d.exec(`CREATE TABLE wa_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}')`);
  d.exec(`CREATE TABLE wa_device_actions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
    args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(KNOWLEDGE_DDL);
  d.exec(KNOWLEDGE_IDX);
  d.exec(KNOWLEDGE_IMPORTS_DDL);
  return withTx(d);
}
/** 灌入 `p1` 的四类真源；另灌 `p2` 的三元组/作业作**不串味**反证。 */
function seedKnowledge(d: DatabaseSync): void {
  const p = (sql: string, ...a: unknown[]) => d.prepare(sql).run(...a);
  p(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
    't1', 'p1', '客厅台灯', 'controlled_by', 'worker-ant', 0.9);
  p(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
    't2', 'p1', 'worker-ant', 'uses', 'mqtt', 0.7);
  p(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
    'tx', 'p2', '别家的东西', 'belongs_to', '别的项目', 0.99);
  p(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
    'd1', 'p1', 'code', 'active', 'main.ts', 'src/main.ts');
  p(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
    'd2', 'p1', 'code', 'active', 'util.ts', 'src/util.ts');
  p(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
    'd3', 'p1', 'report', 'active', '报告', 'out/report.md');
  p(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
    'd4', 'p1', 'daemon', 'running', '守护', 'bin/daemon.js');
  p(`INSERT INTO wa_service_calls (id, project_id, kind, target, operation, ok, duration_ms) VALUES (?,?,?,?,?,?,?)`,
    'sc1', 'p1', 'mcp', 'filesystem', 'read', 1, 12);
  p(`INSERT INTO wa_service_calls (id, project_id, kind, target, operation, ok, duration_ms) VALUES (?,?,?,?,?,?,?)`,
    'sc2', 'p1', 'mcp', 'filesystem', 'read', 0, 30);
  p(`INSERT INTO wa_service_calls (id, project_id, kind, target, operation, ok, duration_ms) VALUES (?,?,?,?,?,?,?)`,
    'sc3', 'p1', 'a2a', 'peer', 'send', 1, 5);
  p(`INSERT INTO wa_jobs (id, status, payload) VALUES (?,?,?)`, 'j1', 'pending', JSON.stringify({ projectId: 'p1' }));
  p(`INSERT INTO wa_jobs (id, status, payload) VALUES (?,?,?)`, 'j2', 'done', JSON.stringify({ projectId: 'p1' }));
  p(`INSERT INTO wa_jobs (id, status, payload) VALUES (?,?,?)`, 'jx', 'pending', JSON.stringify({ projectId: 'p2' }));
  // 批七三节的源：1 条带验收判据的任务 + 1 条失败任务（因由走 context_json.pause_reason）
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'k1', 'p1', '开灯与关门', 'pending', '{}', '灯亮且门锁上');
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'k2', 'p1', '布置客厅', 'failed', JSON.stringify({ pause_reason: 'acceptance_failed' }), '');
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'kx', 'p2', '别家的任务', 'failed', JSON.stringify({ pause_reason: 'no_output' }), '别家判据');
  p(`INSERT INTO wa_task_templates (id, name, category, description, status, priority) VALUES (?,?,?,?,?,?)`,
    'tpl1', '布置客厅', 'home', '先清点后摆放', 'active', 5);
  p(`INSERT INTO wa_memories (id, project_id, content, memory_type, is_exemplar) VALUES (?,?,?,?,?)`,
    'm1', 'p1', '先清点再摆放，避免返工', 'semantic', 1);
  p(`INSERT INTO wa_memories (id, project_id, content, memory_type, is_exemplar) VALUES (?,?,?,?,?)`,
    'mx', 'p2', '别家的样板', 'semantic', 1);
}

/** 递归列出目录下全部 `.ts` 文件（绝对路径）——供 C-5「**恰一份实现**」扫面。 */
function scanFiles(dirAbs: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const p = path.join(dirAbs, e.name);
    if (e.isDirectory()) scanFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * C-3 的**注入探针**：记下"执行那一跳"是否真被调用、传的什么。
 * ⚠ 复用 `devices` 组的范式（`controlTools({…deps, …})`）——门的编排闭包不导出，但**经 `deps` 注入**，
 *   故"真调用"这一跳可被外部看见（否则只能靠"没抛异常"这种弱证据）。
 */
function makeProbeDevice(): {
  calls: Array<{ deviceId?: string; name?: string; action: string; args?: Record<string, unknown> }>;
  deps: ExternalCapabilityDeps;
  device: AnsDevice;
  setNext(o: DeviceControlOutcome): void;
} {
  const calls: Array<{ deviceId?: string; name?: string; action: string; args?: Record<string, unknown> }> = [];
  let next: DeviceControlOutcome = { ok: true, deviceId: 'dev-1', action: 'turn_on', result: 'turned on' };
  const device: AnsDevice = {
    id: 'dev-1', name: '客厅台灯', alias: '', kind: 'light', protocol: 'mqtt',
    address: '192.168.1.50', port: 1883, capabilities: ['turn_on', 'turn_off'],
    controllable: true, authorized: true, status: { on: false }, first_seen: '', last_seen: '',
  };
  const deps: ExternalCapabilityDeps = {
    listDevices: () => [device],
    controlDevice: async (inner) => { calls.push(inner); return next; },
  };
  return { calls, deps, device, setNext: (o) => { next = o; } };
}

async function main(): Promise<void> {
  // ═══ G-1｜默认关：显式 seed 是**必需**的（陷阱钉死）══════════════════════════════
  console.log('\n【G-1】默认关 —— 缺省即开的 traps 与"显式 seed 不可省"');
  {
    const seedDb = new DatabaseSync(':memory:');
    seedDb.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
    seedDb.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run('node.external_inbound', 'false');
    eq(readBoolSetting(seedDb as never, 'node.external_inbound'), false,
      'G-1a ★★seed `false` ⇒ `readBoolSetting` 为**假**（真默认关）');
    ok(BOOL_SETTING_KEYS.includes('node.external_inbound'),
      'G-1a2 ★该键在 `BOOL_SETTING_KEYS` 白名单内（面板与引擎读同一把尺）');
    eq(boolSetting('false'), false, 'G-1a3 判据本体：`boolSetting("false") === false`');

    // ★★ 反证：`boolSetting` 的判据是"只有明确说关才算关" ⇒ **未 seed 即等于开**。
    //   这一条证明 `database.ts` 那行显式 seed 不是"顺手登记"，而是"门是否敞在局域网上"的唯一开关。
    const bareDb = new DatabaseSync(':memory:');
    bareDb.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
    eq(readBoolSetting(bareDb as never, 'node.external_inbound'), true,
      'G-1b ★★反证：**未 seed** ⇒ 缺省即开（`readBoolSetting` 为真）⇒ 显式 seed 不可省');

    // 静态：那一行确实写在生产初始化里（读**原文**——判"在册"）。
    ok(/ensureSetting\(\s*'node\.external_inbound'\s*,\s*'false'\s*\)/.test(RD(DB_SRC)),
      'G-1c ★`database.ts` **显式** `ensureSetting("node.external_inbound","false")` 在册（默认关的真落点）');

    seedDb.close(); bareDb.close();
  }

  // ═══ G-2｜私网围栏：两侧标本都喂 ══════════════════════════════════════════════
  console.log('\n【G-2】私网围栏 `isPrivateAddress`（两只标本）');
  {
    const priv = ['127.0.0.1', '10.0.0.7', '172.16.0.1', '172.31.255.254', '192.168.1.5', '169.254.3.9',
      '::1', 'fe80::1', 'fd00::abcd', '::ffff:192.168.0.9'];
    for (const ip of priv) ok(isPrivateAddress(ip) === true, `G-2a 私网命中：${ip}`);
    const pub = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.0.1', '11.0.0.1',
      '2001:db8::1', '2606:4700::1111', '', '   ', undefined, null];
    for (const ip of pub) ok(isPrivateAddress(ip) === false, `G-2b 公网/空不命中：${JSON.stringify(ip)}`);
    // 边界明确：172.16/12 的两端内为真、外为假（宽/窄变体都能被这两条钉住）
    ok(isPrivateAddress('172.16.0.0') && isPrivateAddress('172.31.255.255'), 'G-2c 172.16/12 两端皆真');
    ok(!isPrivateAddress('172.15.255.255') && !isPrivateAddress('172.32.0.0'), 'G-2d 172.16/12 界外皆假');
  }

  // ═══ G-3｜门牌：类目公开、清单遮蔽（无知之幕）══════════════════════════════════
  console.log('\n【G-3】门牌 `agent.json` —— 免凭据：说**类**不说**实例**');
  {
    const card = buildAgentCard('阳台的工蚁', '0.1.0');
    // zx_20261027_3 M5a：六键 → 标准门牌形状。判据**重定向到单源** `AGENT_CARD_FIELDS`（逐成员、不放宽）。
    eq(Object.keys(card).sort(), [...AGENT_CARD_FIELDS].sort(),
      'G-3a ★门牌顶层字段＝`AGENT_CARD_FIELDS` 单源（逐成员；无第七样、也不少一员）');
    eq(card.protocol, INBOUND_PROTOCOL, 'G-3a2 协议标识取真源常量');
    eq(card.pairing.endpoint, INBOUND_PAIR_ENDPOINT, 'G-3a3 配对入口只在门牌上**指路**');
    eq([card.version, card.agent_version], ['0.1.0', '0.1.0'],
      'G-3a6 标准字段 `version` 与 `agent_version` 同值（不两说）');
    eq([card.url, card.capabilities],
      [null, { streaming: false, pushNotifications: false }],
      'G-3a7 未给入口地址 ⇒ `url:null`（不编地址）；推流/推送如实报 false');
    eq(card.skills.map((s) => s.id), card.offered_capabilities.map((c) => c.key),
      'G-3a8 ★技能条目由能力类目派生（id 逐成员对齐，不手抄）');
    // 类目与意图目录**派生**自既有真源：加一类能力/一个意图，门牌自动跟上（不在此手抄）。
    eq(card.offered_capabilities,
      EXTERNAL_CAPABILITIES.map((k) => ({ key: k, label: EXTERNAL_CAPABILITY_LABEL[k], requires_approval: true })),
      'G-3a4 ★能力类目由 `EXTERNAL_CAPABILITIES` 派生（逐成员、且一律 require_approval）');
    eq(card.intents, publicIntents(), 'G-3a5 意图目录＝`publicIntents()` 同值（无第二份拼装）');
    // 遮蔽面：不含设备清单/实例值与网络坐标；参数只给**名**与固定枚举。
    const json = JSON.stringify(card);
    ok(!/"(devices|rooms|room_id|device_id|node_id|alias|address|port|status_json|authorized)"/.test(json),
      'G-3b ★★反证：门牌**不含** 设备清单 / 房间或设备实例 / node_id / 地址端口 / 授权态（泄露即红）', json);
    for (const cap of card.offered_capabilities) {
      eq(Object.keys(cap).sort(), ['key', 'label', 'requires_approval'],
        `G-3b2 能力项只三字段：${cap.key}`);
    }
    for (const it of card.intents) {
      eq(Object.keys(it).sort(), ['id', 'label', 'params'], `G-3b3 意图项只三字段：${it.id}`);
      ok(it.params.every((p) => Object.keys(p).every((k) => ['key', 'label', 'required', 'values'].includes(k))),
        `G-3b4 意图参数只给名/标签/必填/固定枚举：${it.id}`);
    }
    // 负面标本：房间参数**没有** values ⇒ 说不出屋里有哪几间（实例值不上门牌）。
    const roomParam = card.intents.flatMap((i) => i.params).find((p) => p.key === 'room');
    eq(roomParam, { key: 'room', label: '房间', required: true },
      'G-3b5 ★★房间参数**无枚举可选**（协议词汇可以公开，房间实例不行）');
    // 结构性反证：门牌纯函数只吃 (nodeName, agentVersion)，不读库 ⇒ 往库里插设备也改不动门牌。
    const cardBody = CODE(GATE_SRC).slice(CODE(GATE_SRC).indexOf('export function buildAgentCard'))
      .slice(0, CODE(GATE_SRC).slice(CODE(GATE_SRC).indexOf('export function buildAgentCard')).indexOf('\n}\n'));
    ok(!/wa_devices|listDevices|\bdb\b/.test(cardBody),
      'G-3b6 ★★门牌组装体不触库（没有设备行 ⇒ 也就无从泄露设备行）');

    // 路由：私网 ⇒ 200 且与纯函数同值；公网 ⇒ 403；未知路由 ⇒ 404。
    const deps = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0' };
    const r200 = handleInboundRequest({ method: 'GET', path: INBOUND_WELL_KNOWN_PATH, headers: {}, remoteAddress: '192.168.1.20' }, deps);
    eq(r200.status, 200, 'G-3c 私网取门牌 ⇒ 200');
    eq(r200.body, card, 'G-3c2 200 的体＝`buildAgentCard` 同值（无第二份拼装）');
    const r403 = handleInboundRequest({ method: 'GET', path: INBOUND_WELL_KNOWN_PATH, headers: {}, remoteAddress: '203.0.113.7' }, deps);
    eq(r403.status, 403, 'G-3d ★公网取门牌 ⇒ 403（围栏先于路由）');
    const r404 = handleInboundRequest({ method: 'GET', path: '/', headers: {}, remoteAddress: '10.0.0.1' }, deps);
    eq(r404.status, 404, 'G-3e 私网但未知路由 ⇒ 404');
  }

  // ═══ G-4｜开关关 ⇒ 不起服务（listen 未被调用）═════════════════════════════════
  console.log('\n【G-4】开关是**唯一**的起停判据');
  {
    const { factory, state } = fakeServerFactory();
    const off = startInboundGate({ enabled: false, nodeName: () => 'x', agentVersion: '0.1.0', serverFactory: factory, mdnsFactory: null });
    eq(off.started, false, 'G-4a ★开关关 ⇒ 不起');
    eq(off.reason, 'disabled', 'G-4a2 因由如实＝`disabled`');
    eq(state.listenCalls, 0, 'G-4a3 ★★`listen` **未被调用**（关即真的关，不是起了再忽略）');

    const on = startInboundGate({ enabled: true, nodeName: () => 'x', agentVersion: '0.1.0', serverFactory: factory, mdnsFactory: null, port: 27199 });
    eq(on.started, true, 'G-4b ★反证：开关开 ⇒ 起');
    eq(state.listenCalls, 1, 'G-4b2 `listen` 恰被调用 1 次');
    eq(inboundRunningPort(), 27199, 'G-4b3 运行端口＝请求端口');
    ok(isInboundRunning(), 'G-4b4 `isInboundRunning()` 为真');
    stopInboundGate();
    ok(!isInboundRunning(), 'G-4c ★停后 `isInboundRunning()` 为假（幂等收摊）');
    stopInboundGate();
    ok(!isInboundRunning(), 'G-4c2 再停一次仍是假（幂等，不抛）');
  }

  // ═══ G-5｜端口单源 + 逃生口 + 零 electron + 接线那一跳 ══════════════════════════
  console.log('\n【G-5】端口单源 / 零 electron / 启动接线');
  {
    eq(INBOUND_DEFAULT_PORT, 27184, 'G-5a 入站端口单源＝27184');
    ok(INBOUND_DEFAULT_PORT !== 27183, 'G-5a2 与 ANS 端口(27183)不撞');
    ok(!(INBOUND_DEFAULT_PORT >= 19950 && INBOUND_DEFAULT_PORT <= 19999), 'G-5a3 与 A2A 子进程端口段(19950-19999)不撞');
    eq(resolveInboundPort({}), 27184, 'G-5b 无逃生口 ⇒ 缺省端口');
    eq(resolveInboundPort({ WA_INBOUND_PORT: '28123' } as NodeJS.ProcessEnv), 28123, 'G-5b2 `WA_INBOUND_PORT` 逃生口生效（照 ANS 先例）');
    eq(resolveInboundPort({ WA_INBOUND_PORT: 'abc' } as NodeJS.ProcessEnv), 27184, 'G-5b3 非法逃生口 ⇒ 如实回落缺省（不抛）');

    ok(!/from\s+'electron'/.test(CODE(GATE_SRC)), 'G-5c ★门模块**零 electron 依赖**（rr 可直引跑真实现）');
    const idx = CODE(INDEX_SRC);
    ok(/startInboundGate\s*\(/.test(idx), 'G-5d ★★启动接线那一跳真接上：`index.ts` 调 `startInboundGate(`');
    ok(/stopInboundGate\s*\(/.test(idx), 'G-5e ★★收摊接线那一跳真接上：`index.ts` 调 `stopInboundGate(`（before-quit 路径）');
    ok(/readBoolSetting\(db!,\s*'node\.external_inbound'\)/.test(idx), 'G-5f 起停判据读的正是 `node.external_inbound`（不是别的键）');
  }

  // ═══ P｜配对与凭据（罗尔斯·无知之幕：不经用户手 / 只存 hash / 只回一次）══════════════
  console.log('\n【P】配对与凭据 —— 申请→批→取凭据→吊销');
  {
    // P-0：生产 DDL 与夹具同形（静态钉住列名，改一处即红）。
    const m = /CREATE TABLE IF NOT EXISTS wa_external_terminals\s*\(([\s\S]*?)\n\s*\)/.exec(RD(DB_SRC));
    const ddl = m?.[1] ?? '';
    ok(ddl.length > 0, 'P-0a ★生产 DDL：`wa_external_terminals` 在册');
    for (const col of ['id', 'name', 'status', 'pair_code', 'key_prefix', 'secret_hash', 'capabilities_json',
      'last_remote_addr', 'last_seen_at', 'created_at', 'approved_at', 'revoked_at', 'delivered_at', 'grant_expires_at']) {
      ok(new RegExp(`(^|\\s)${col}\\s`).test(ddl), `P-0b DDL 列 ${col}`);
    }
  }
  {
    const db = makeTerminalDb();
    const tdb = db as unknown as TerminalDb;
    __resetTerminalSecretsForTest();

    // P-1：申请 ⇒ 建 `pending` 行（短码给人核对；此刻**无**凭据）。
    const { pairingId, pairCode } = createPairRequest(tdb, '客厅的 Claude', '192.168.1.30');
    const row = db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(pairingId) as Record<string, unknown>;
    ok(!!row, 'P-1a ★申请即建行');
    eq(row.status, 'pending', 'P-1a2 新申请是 `pending`');
    ok(/^\d{6}$/.test(pairCode), 'P-1b ★短码是 6 位数字（给人核对，**非**凭据）', pairCode);
    eq(row.key_prefix, null, 'P-1c 未批准 ⇒ 无 `key_prefix`（还没铸凭据）');
    eq(row.secret_hash, null, 'P-1c2 未批准 ⇒ 无 `secret_hash`');
    eq(row.last_remote_addr, '192.168.1.30', 'P-1d 如实记来源地址');
    eq(listTerminals(tdb).length, 1, 'P-1e 全量表含这 1 台');

    // P-2：未批准 ⇒ **不发凭据**（反证：无 credentials）。
    const s0 = pairStatus(tdb, pairingId, pairCode);
    eq(s0, { status: 'pending' }, 'P-2 ★★未批准 ⇒ 只回 `pending`，**不发凭据**');
    ok(!('credentials' in s0), 'P-2b ★`pending` 态无 `credentials` 键');

    // P-3：批准 ⇒ 凭据**只回一次**。
    eq(approveTerminal(tdb, pairingId, ['device_control']), { ok: true }, 'P-3a ★批准成功（**不回明文**——凭据不经用户手）');
    const s1 = pairStatus(tdb, pairingId, pairCode) as { status: string; credentials?: { key: string; secret: string } };
    ok(s1.status === 'approved' && !!s1.credentials, 'P-3b ★★批准后**首次**轮询 ⇒ 回凭据');
    const cred = s1.credentials!;
    ok(typeof cred.key === 'string' && cred.key.startsWith('wt_'), 'P-3b2 key 形状 `wt_…`', cred.key);
    ok(typeof cred.secret === 'string' && cred.secret.length === 64, 'P-3b3 secret 是 32 字节 hex');
    eq(pairStatus(tdb, pairingId, pairCode), { status: 'approved' }, 'P-3c ★★第二次轮询 ⇒ **不再回凭据**（只此一次）');

    // P-5：库中**只存 hash**（反证明文/完整 key 落库即红）。
    const after = db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(pairingId) as Record<string, unknown>;
    eq(after.secret_hash, hashTerminalSecret(cred.secret), 'P-5a ★库中存的是**该 secret 的 sha256**');
    ok(!JSON.stringify(after).includes(cred.secret), 'P-5b ★★反证：库中**不出现明文 secret**（泄露即红）');
    ok(!JSON.stringify(after).includes(cred.key), 'P-5b2 ★反证：库中不出现**完整 key**（只有 `key_prefix` 前 8 位）');
    eq(after.key_prefix, cred.key.slice(0, 8), 'P-5c `key_prefix` = key 前 8 位');
    ok(!!after.delivered_at, 'P-5d 送达即落地 `delivered_at`（"只回一次"的依据）');

    // P-4：吊销 ⇒ 凭据**立即**失效（403，非删库式静默）。
    const v0 = verifyTerminal(tdb, cred.key, cred.secret, '10.0.0.9') as { ok: boolean; terminal?: { capabilities: string[] } };
    ok(v0.ok === true, 'P-4a ★有效凭据 ⇒ 校验通过');
    eq(v0.terminal?.capabilities, ['device_control'], 'P-4a2 能力面如实带出（批准时记的那一份）');
    const seen = db.prepare('SELECT last_remote_addr FROM wa_external_terminals WHERE id = ?').get(pairingId) as Record<string, unknown>;
    eq(seen.last_remote_addr, '10.0.0.9', 'P-4a3 校验成功即如实记 `last_remote_addr`');
    eq(revokeTerminal(tdb, pairingId), { ok: true }, 'P-4b ★吊销成功');
    eq(verifyTerminal(tdb, cred.key, cred.secret), { ok: false, status: 403, reason: 'not_approved:revoked' },
      'P-4c ★★吊销后**立即**失效（403）');

    db.close();
  }
  {
    // P-6：短码核对 / 坏凭据 / 拒绝 / 非 pending 不再铸。
    const db = makeTerminalDb();
    const tdb = db as unknown as TerminalDb;
    __resetTerminalSecretsForTest();
    const { pairingId, pairCode } = createPairRequest(tdb, '书房的 GPT');
    eq(pairStatus(tdb, pairingId, '000000'), { status: 'unknown' }, 'P-6a ★短码不符 ⇒ `unknown`（不泄露"这单存在"）');
    approveTerminal(tdb, pairingId, []);
    const st = pairStatus(tdb, pairingId, pairCode) as { credentials: { key: string; secret: string } };
    const k = st.credentials.key; const sec = st.credentials.secret;
    eq(verifyTerminal(tdb, k, 'wrong'), { ok: false, status: 401, reason: 'bad_secret' }, 'P-6b ★secret 不符 ⇒ 401');
    eq(verifyTerminal(tdb, 'wt_deadbeef', sec), { ok: false, status: 401, reason: 'unknown_key' }, 'P-6c ★key 不认得 ⇒ 401');
    eq(verifyTerminal(tdb, '', ''), { ok: false, status: 401, reason: 'missing_credentials' }, 'P-6d 缺凭据 ⇒ 401');

    const p3 = createPairRequest(tdb, '路过的终端');
    eq(rejectTerminal(tdb, p3.pairingId), { ok: true }, 'P-6e 拒绝成功');
    eq(pairStatus(tdb, p3.pairingId, p3.pairCode), { status: 'rejected' }, 'P-6f 拒绝后轮询 ⇒ `rejected`');
    eq(approveTerminal(tdb, p3.pairingId, []), { ok: false, reason: 'not_pending:rejected' },
      'P-6g ★★反证：非 `pending` 行**不得**再铸凭据（不静默改状态）');
    db.close();
  }
  {
    // P-7：门内接线——`handleInboundRequest` 走真路由（申请/轮询/围栏/认证闸）。
    const db = makeTerminalDb();
    const tdb = db as unknown as TerminalDb;
    __resetTerminalSecretsForTest();
    const deps = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: createPairingPort(tdb) };
    const post = (b: unknown, addr = '192.168.1.44') =>
      handleInboundRequest({ method: 'POST', path: INBOUND_PAIR_ENDPOINT, headers: {}, remoteAddress: addr, body: b }, deps);
    const poll = (pid: string, code: string, addr = '192.168.1.44') =>
      handleInboundRequest({ method: 'GET', path: INBOUND_PAIR_STATUS_PATH, query: { pairing_id: pid, pair_code: code }, headers: {}, remoteAddress: addr }, deps);

    const r = post({ name: '隔壁的终端' });
    eq(r.status, 200, 'P-7a ★门端点 `POST /pair/request` ⇒ 200');
    const rb = r.body as { pairing_id: string; pair_code: string };
    ok(typeof rb.pairing_id === 'string' && /^\d{6}$/.test(rb.pair_code), 'P-7a2 回 `{pairing_id, pair_code}`');
    eq(post({}).status, 400, 'P-7b 无 `name` ⇒ 400');
    eq(poll(rb.pairing_id, rb.pair_code).body, { status: 'pending' }, 'P-7c ★轮询：待批 ⇒ `pending`');
    eq(post({ name: 'x' }, '203.0.113.9').status, 403, 'P-7d ★公网申请 ⇒ 403（围栏**先于**路由）');

    approveTerminal(tdb, rb.pairing_id, ['device_control']);
    const st = poll(rb.pairing_id, rb.pair_code).body as { credentials?: { key: string; secret: string } };
    ok(!!st.credentials, 'P-7e ★批准后门端点回凭据');
    const cred = st.credentials!;

    const authGet = (h: Record<string, string>) =>
      handleInboundRequest({ method: 'GET', path: '/api/v1/capabilities', headers: h, remoteAddress: '192.168.1.44' }, deps);
    eq(authGet({}).status, 401, 'P-7f ★★`/api/v1/*` 无凭据 ⇒ 401');
    eq(authGet({ authorization: `Bearer ${cred.key}.wrong` }).status, 401, 'P-7g 坏 secret ⇒ 401');
    const okAuth = authGet({ authorization: `Bearer ${cred.key}.${cred.secret}` });
    ok(okAuth.status !== 401 && okAuth.status !== 403,
      'P-7h ★★好凭据**过得去认证闸**（非 401/403；本批 404，批三续接能力面）', String(okAuth.status));

    // 省略 pairing ⇒ 纯门牌模式：`/api/v1/*` 一律 404。
    const pure = { nodeName: () => 'x', agentVersion: '0.1.0' };
    eq(handleInboundRequest({ method: 'GET', path: '/api/v1/capabilities', headers: {}, remoteAddress: '192.168.1.44' }, pure).status,
      404, 'P-7i 未接配对模块 ⇒ `/api/v1/*` 一律 404（纯门牌）');
    eq(handleInboundRequest({ method: 'GET', path: INBOUND_PAIR_STATUS_PATH, headers: {}, remoteAddress: '192.168.1.44' }, pure).status,
      404, 'P-7j 同上：配对端点也 404');
    db.close();
  }

  // ═══ C｜能力面 + 留痕 + 软闸（罗尔斯·无知之幕 / 管子·度量衡 / 毛选·没有调查没有发言权）══════
  console.log('\n【C】能力面 —— 三重闸 / 脱敏 / 留痕 / 真执行那一跳');
  {
    // C-0：生产 DDL 与夹具同形（静态钉住列名，改一处即红）。
    const m = /CREATE TABLE IF NOT EXISTS wa_external_calls\s*\(([\s\S]*?)\n\s*\)/.exec(RD(DB_SRC));
    const ddl = m?.[1] ?? '';
    ok(ddl.length > 0, 'C-0a ★生产 DDL：`wa_external_calls` 在册');
    for (const col of ['id', 'terminal_id', 'capability', 'args_json', 'result', 'reason', 'remote_addr', 'created_at']) {
      ok(new RegExp(`(^|\\s)${col}\\s`).test(ddl), `C-0b DDL 列 ${col}`);
    }
  }
  {
    // C-1：三重闸（Team → 白名单 → 该终端获批）**每一步都先问再动**，且**被拒也留痕**。
    const db = makeDoorDb();
    const probe = makeProbeDevice();
    const port = createExternalCapabilityPort(db as never, probe.deps);
    const cnt = () => Number((db.prepare('SELECT COUNT(*) AS n FROM wa_external_calls').get() as { n: number }).n);
    const last = () => db.prepare('SELECT * FROM wa_external_calls ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    const allowed = ['device_control'];

    // 白名单是"唯一定处的词表"——两侧标本（在册 / 不在册）。
    ok(isExternalCapability('device_control') === true, 'C-1a0 `device_control` 在词表内');
    ok(isExternalCapability('memory_write') === false, 'C-1a0b ★门外能力名**不在**词表');
    // zx_20261018_1 批一: 白名单增 `intent_control`（授权面），`/invoke` 可原始调用面**窄于**它；
    //   zx_20261027_3 M5b 再增 `task_request`——判据**重定向到边界本身**（不再钉固定长度/固定枚举）：
    //   授予词表逐成员人话名/说明齐备、直调面 ⊆ 授予面、意图控制**永不**入直调面。
    for (const c of EXTERNAL_CAPABILITIES) {
      ok(isExternalCapability(c) && EXTERNAL_CAPABILITY_LABEL[c].length > 0 && EXTERNAL_CAPABILITY_NOTE[c].length > 0,
        `C-1a0c 授予词表成员人话名/说明齐备：${c}`);
    }
    ok(['device_control', 'intent_control', 'task_request'].every((c) => isExternalCapability(c)),
      'C-1a0c1 ★授予词表三类俱在（原始动作 / 意图 / 任务请求）');
    eq(INVOKE_CAPABILITIES.filter((c) => !isExternalCapability(c)), [],
      'C-1a0c2 ★★直调面 ⊆ 授予面（不留"能调不能授"的野路）');
    ok((INVOKE_CAPABILITIES as readonly string[]).includes('device_control')
      && (INVOKE_CAPABILITIES as readonly string[]).includes('task_request'),
      'C-1a0c3 直调面含原始动作与任务请求');
    ok(isInvocableCapability('intent_control') === false, 'C-1a0c4 ★意图控制**不可**经 `/invoke` 直调');
    eq(EXTERNAL_CAPABILITY_LABEL.device_control, '设备控制', 'C-1a0d 人话能力名如实（键类型穷举 ⇒ 漏一项编译期错）');

    // ① 白名单外 ⇒ 403 且**留痕**（0→1 正面断言），且**没走到执行那一跳**。
    const b1 = cnt();
    const r1 = await port.invoke('t1', allowed, { capability: 'memory_write', args: {} }, '192.168.1.9');
    eq(r1.status, 403, 'C-1a ★白名单外的能力 ⇒ 403');
    eq((r1.body as { error: string }).error, 'capability_not_allowed', 'C-1a2 回码如实＝`capability_not_allowed`');
    eq(cnt(), b1 + 1, 'C-1a3 ★★被拒也留痕（0→1，不靠"没抛异常"）');
    eq(last()?.result, 'denied', 'C-1a4 留痕 `result`＝`denied`');
    eq(last()?.reason, 'capability_not_allowed', 'C-1a5 留痕 `reason` 记判据档位');
    eq(probe.calls.length, 0, 'C-1a6 ★反证：**未**走到执行那一跳（探针零调用）');

    // ② 缺 `capability` 字段 ⇒ 400 且**不**留痕（那不是一次"能力调用尝试"，别污染账）。
    const b2 = cnt();
    const r2 = await port.invoke('t1', allowed, { args: {} }, '192.168.1.9');
    eq(r2.status, 400, 'C-1b 缺 `capability` ⇒ 400');
    eq((r2.body as { error: string }).error, 'capability_required', 'C-1b2 回码＝`capability_required`');
    eq(cnt(), b2, 'C-1b3 ★★反证：烂请求**不**落留痕（计数不变）');

    // ③ 在册但**该终端未获批** ⇒ 403 且留痕（第二把尺：批准是"我们准它用什么"）。
    const b3 = cnt();
    const r3 = await port.invoke('t1', [], { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } }, '192.168.1.9');
    eq(r3.status, 403, 'C-1c ★★能力双重许可：在册但**未获批** ⇒ 403');
    eq((r3.body as { error: string }).error, 'capability_not_granted', 'C-1c2 回码＝`capability_not_granted`');
    eq(cnt(), b3 + 1, 'C-1c3 留痕 +1');
    eq(last()?.reason, 'capability_not_granted', 'C-1c4 `reason` 记该档');
    eq(probe.calls.length, 0, 'C-1c5 同样**未**走到执行那一跳');

    // ④ 三重闸皆过 ⇒ 200，探针**真被调用**（"接线那一跳"的正面证据）。
    const b4 = cnt();
    const r4 = await port.invoke('t1', allowed, { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } }, '192.168.1.9');
    eq(r4.status, 200, 'C-1d ★三重闸皆过 ⇒ 200');
    eq((r4.body as { ok: boolean }).ok, true, 'C-1d2 回 `ok:true`');
    eq(probe.calls.length, 1, 'C-1d3 ★★执行那一跳**真被调用**（且恰一次）');
    //   ⚠ zx_20261016_2 批二**重定向**（承 feedback_retarget_assertions_to_stronger_source）：
    //     装配层新收 `terminalId`（留痕据此记「哪台终端按的」）⇒ 旧"逐字只有原始内层参数"作废。
    //     **不删不放宽**：改为同时钉 ① 原始内层参数仍**逐字透传**（按名解析仍留给装配层）② `terminalId` 一并到位。
    eq(probe.calls[0], { deviceId: undefined, name: '客厅台灯', action: 'turn_on', args: {}, terminalId: 't1' },
      'C-1d4 ★★原始内层参数**逐字透传**（按名解析仍留给装配层）**且**新带 `terminalId`（装配层据此把留痕记到该终端名下）');
    eq(cnt(), b4 + 1, 'C-1d5 成功也留痕 +1');
    eq(last()?.result, 'ok', 'C-1d6 留痕 `result`＝`ok`');
    eq(last()?.remote_addr, '192.168.1.9', 'C-1d7 如实记来源地址');
    eq(last()?.terminal_id, 't1', 'C-1d8 留痕认得"是谁在做的"');

    // ⑤ 执行被拒（K-6 安全闸）⇒ 403 + `how_to_authorize` 透传，留痕 `denied`。
    probe.setNext({ ok: false, denied: true, reason: 'not_authorized', deviceId: 'dev-1', action: 'turn_on',
      error: '未授权', how_to_authorize: '请在设备面板打开「允许控制」' });
    const b5 = cnt();
    const r5 = await port.invoke('t1', allowed, { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } }, '192.168.1.9');
    eq(r5.status, 403, 'C-1e ★执行被拒（K-6）⇒ 403');
    eq((r5.body as { how_to_authorize: string }).how_to_authorize, '请在设备面板打开「允许控制」',
      'C-1e2 `how_to_authorize` 如实透传（可行动的下一步，不返回光秃秃的 false）');
    eq(cnt(), b5 + 1, 'C-1e3 留痕 +1');
    eq(last()?.result, 'denied', 'C-1e4 `result`＝`denied`');
    eq(last()?.reason, 'not_authorized', 'C-1e5 `reason` 取设备侧判据');

    // ⑥ 传动失败（设备没答理）⇒ 200 + `ok:false`（请求已过闸、是执行没成），留痕 `error`（与 `denied` 分账）。
    probe.setNext({ ok: false, deviceId: 'dev-1', action: 'turn_on', result: 'timeout' });
    const b6 = cnt();
    const r6 = await port.invoke('t1', allowed, { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } }, '192.168.1.9');
    eq(r6.status, 200, 'C-1f 传动失败 ⇒ 200（非协议错误，与工具返回同形）');
    eq((r6.body as { ok: boolean }).ok, false, 'C-1f2 回 `ok:false`');
    eq(cnt(), b6 + 1, 'C-1f3 留痕 +1');
    eq(last()?.result, 'error', 'C-1f4 `result`＝`error`（与 `denied` **分账**）');

    db.close();
  }
  {
    // C-1 续：Team 软闸**先于**白名单被拦（且留痕 `team_required`）；读侧**不**留痕。
    const db = makeDoorDb(false); // 无许可无试用 ⇒ community ⇒ 锁定（真锁，不是打桩）
    const probe = makeProbeDevice();
    const port = createExternalCapabilityPort(db as never, probe.deps);
    const cnt = () => Number((db.prepare('SELECT COUNT(*) AS n FROM wa_external_calls').get() as { n: number }).n);

    const c0 = port.capabilities('t1', ['device_control']);
    eq(c0.status, 403, 'C-1g ★档位锁定 ⇒ `capabilities` 403');
    eq((c0.body as { error: string }).error, 'team_required', 'C-1g2 回码＝`team_required`');
    eq(cnt(), 0, 'C-1g3 ★★反证：**读**侧不落留痕（只量"调用"，不量"看"）');

    const before = cnt();
    const r = await port.invoke('t1', ['device_control'], { capability: 'device_control', args: { name: 'x', action: 'turn_on' } }, '192.168.1.9');
    eq(r.status, 403, 'C-1h ★锁定态 `invoke` ⇒ 403（门未解锁，白名单都不必谈）');
    eq((r.body as { error: string }).error, 'team_required', 'C-1h2 回码＝`team_required`');
    eq(cnt(), before + 1, 'C-1h3 留痕 +1（软闸也记账）');
    eq(probe.calls.length, 0, 'C-1h4 **未**走到执行那一跳');
    db.close();
  }
  {
    // C-2：脱敏（罗尔斯·无知之幕）——门外只见三样；网络坐标与授权态**一律不出门**。
    const probe = makeProbeDevice();
    const rows = redactedDevices([probe.device]);
    eq(rows.length, 1, 'C-2a 一台设备 ⇒ 一行');
    // zx_20261029_2 M3：门外设备行增两样（`kind_class` 品类归一、`room` 房间名）——仍**无实例/坐标/授权态**。
    //   钉**恰五键**（不是"含三键"）：多出任何一列（尤其地址/端口/授权）即红。
    eq(Object.keys(rows[0]).sort(), ['actions', 'call_name', 'kind', 'kind_class', 'room'], 'C-2b ★★门外只见**五样**：call_name / kind / kind_class / actions / room');
    eq(rows[0].call_name, deviceCallName(probe.device), 'C-2b2 `call_name` 取**同一把尺**（`deviceCallName`：别名优先、回退自述名）');
    eq(rows[0].kind, 'light', 'C-2b3 `kind` 是设备自述');
    eq(rows[0].actions, ['turn_on', 'turn_off'], 'C-2b4 `actions` 是设备自述能力（不自造）');
    eq(rows[0].kind_class, 'light', 'C-2b5 `kind_class` 由 `deviceKindClassOf` 派生（归一词表：light→light，非另抄一份）');
    eq(rows[0].room, '', 'C-2b6 ★`room` 只给房间名（未指派即空串）——**不给**地址/端口/授权态');

    const raw = JSON.stringify(rows);
    for (const leak of ['192.168.1.50', '1883', 'dev-1', 'mqtt', 'authorized', 'controllable']) {
      ok(!raw.includes(leak), `C-2c ★★反证：对外清单**不含** ${leak}（网络坐标/内部 id/授权态是门内之物）`);
    }
    eq(raw.includes('客厅台灯'), true, 'C-2c2 正面：该给的（门外唯一认得出的那个名）**给到**');

    const aliased: AnsDevice = { ...probe.device, alias: '书房的灯' };
    eq(redactedDevices([aliased])[0].call_name, '书房的灯', 'C-2d ★有别名 ⇒ 取别名（"我们叫它什么"，与面板/工具同一把尺）');
  }
  {
    // C-3：门端点端到端——认证闸 → 能力面 → 执行那一跳，**全链贯通**（在生产入参形状上证）。
    const db = makeDoorDb();
    const tdb = db as unknown as TerminalDb;
    __resetTerminalSecretsForTest();
    const probe = makeProbeDevice();
    const capability = createExternalCapabilityPort(db as never, probe.deps);
    const deps = { nodeName: () => '阳台的工蚁', agentVersion: '0.1.0', pairing: createPairingPort(tdb), capability };

    const { pairingId, pairCode } = createPairRequest(tdb, '隔壁的 AI 终端', '192.168.1.44');
    approveTerminal(tdb, pairingId, ['device_control']);
    const st = pairStatus(tdb, pairingId, pairCode) as { credentials?: { key: string; secret: string } };
    const cred = st.credentials!;
    const auth = { authorization: `Bearer ${cred.key}.${cred.secret}` };

    const capRes = await handleInboundRequest({ method: 'GET', path: INBOUND_CAPABILITIES_PATH, headers: auth, remoteAddress: '192.168.1.44' }, deps);
    eq(capRes.status, 200, 'C-3a ★★门端点 `GET /capabilities`（带凭据）⇒ 200');
    const capBody = capRes.body as { terminal_id: string; capabilities: string[]; devices: Array<Record<string, unknown>> };
    eq(capBody.terminal_id, pairingId, 'C-3a2 `terminal_id` 由**凭据**派生（不是请求里报的）');
    eq(capBody.capabilities, ['device_control'], 'C-3a3 能力＝**白名单 ∩ 该终端获批**');
    eq(Object.keys(capBody.devices[0]).sort(), ['actions', 'call_name', 'kind', 'kind_class', 'room'], 'C-3a4 门外看的设备行是**脱敏**那一份（恰五键，与 C-2b 同形）');

    const inv = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: auth, remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅台灯', action: 'turn_on' } },
    }, deps);
    eq(inv.status, 200, 'C-3b ★★门端点 `POST /invoke` ⇒ 200（认证→能力→执行 全链贯通）');
    eq((inv.body as { ok: boolean }).ok, true, 'C-3b2 回 `ok:true`');
    eq(probe.calls.length, 1, 'C-3b3 执行那一跳经门端点**真被调用**');

    // 该终端"认证过了"但请求的是**白名单外**的能力 ⇒ 仍被能力闸拦（认证过 ≠ 能力开，两把尺各管一段）。
    const b3 = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: auth, remoteAddress: '192.168.1.44',
      body: { capability: 'memory_write', args: {} },
    }, deps);
    eq(b3.status, 403, 'C-3c ★★门端点内白名单外的能力 ⇒ 403');
    eq((b3.body as { error: string }).error, 'capability_not_allowed', 'C-3c2 回码＝`capability_not_allowed`');
    db.close();
  }
  {
    // C-4：词表**两侧**——成员齐备（逐成员枚举）+ 人话名非空 + 软闸两只标本（试用放行 / 社区拒）。
    // zx_20261017_1 批二：新增 `audit_view` ⇒ 由"恰四项"重定向为逐成员枚举；
    //   批六再增 `team_library` ⇒ 恰六项；zx_20261018_3 批七再增 `audit_export` ⇒ 恰七项；
    //   zx_20261022_3 批八再增 `project_profile_share` ⇒ 恰八项
    //   （逐成员枚举，不放宽成 >=；新增一员即须补人话名与接线）。
    // zx_20261029_2 M6：`device_discovery` 移往 Pro 闸 ⇒ 八项→七项（逐成员枚举，不放宽成 >=）。
    eq([...TEAM_FEATURES],
      ['multi_node', 'device_control', 'external_terminal', 'audit_view', 'audit_export', 'team_library', 'project_profile_share'],
      'C-4a ★能力词表**恰七项**（唯一定处 `team-gate.ts`；M6 起发现归 Pro，本表只管控制面）');
    for (const f of TEAM_FEATURES) {
      ok(typeof TEAM_FEATURE_LABEL[f] === 'string' && TEAM_FEATURE_LABEL[f].length > 0,
        `C-4b 人话名非空：${f} ⇒ 「${TEAM_FEATURE_LABEL[f]}」`);
    }
    // zx_20261018_1 批八：人话名**增补边界**（意图接入默认授、原始控制须显式勾选）⇒ 由"恰等于旧串"
    //   重定向为**逐含义在册**（不放宽：旧串仍须是前缀，且两条边界词都须出现）。
    ok(TEAM_FEATURE_LABEL.external_terminal.startsWith('外部终端接入')
      && TEAM_FEATURE_LABEL.external_terminal.includes('意图接入')
      && TEAM_FEATURE_LABEL.external_terminal.includes('显式勾选'),
      'C-4c ★`external_terminal` 的人话名如实且写明边界（意图接入默认授 / 原始控制须显式勾选）',
      TEAM_FEATURE_LABEL.external_terminal);

    const open = makeDoorDb(true);
    const shut = makeDoorDb(false);
    eq(teamFeatureRefusal(open as never, 'external_terminal'), null,
      'C-4d ★标本①：试用/团队档 ⇒ `external_terminal` **不拒**（null）');
    const refusal = teamFeatureRefusal(shut as never, 'external_terminal');
    ok(typeof refusal === 'string' && refusal.includes('外部终端接入') && refusal.includes('团队版'),
      'C-4e ★标本②：社区档 ⇒ 拒因含人话名与升级指引（不返回光秃秃的 false）', refusal ?? 'null');
    open.close(); shut.close();
  }
  {
    // C-5：接线穷举（三处 main 接线 + 人侧出口在册）+「**恰一份实现**」扫面。
    const idx = CODE(INDEX_SRC);
    ok(/createExternalCapabilityPort\s*\(/.test(idx), 'C-5a ★★装配那一跳真接上：`index.ts` 建 `createExternalCapabilityPort(`');
    ok(/capability,/.test(idx) && /createPairingPort\(db!\)/.test(idx), 'C-5b 门启动时**同时**注入 `pairing` 与 `capability`');
    ok(/resolveDeviceByName\s*\(/.test(idx), 'C-5c 「按名使唤」的解析在**装配层**（复用 `resolveDeviceByName`，能力面不掺和台账语义）');
    ok(/runDeviceControl\s*\(/.test(idx), 'C-5d 控制编排复用**唯一**的 `runDeviceControl`（门不另写次序）');
    ok(/teamGate\?\.unlocked/.test(idx), 'C-5e 启动起门接在 `teamGate?.unlocked` 上（与心跳/中转同一把尺，M22-11 一处真源）');

    // 「恰一份实现」扫面：留痕写口 / 白名单定义在整个 `src/main` 里**都只此一处**。
    const files = scanFiles(path.join(root, `${A}/src/main`));
    const writers = files.filter((f) => RD(path.relative(root, f)).includes('INSERT INTO wa_external_calls'));
    eq(writers.map((f) => path.relative(root, f)), [`${A}/src/main/core/external-calls.ts`],
      'C-5f ★★反证：留痕写口**恰此一处**（别处再写一份即红）');
    const definers = files.filter((f) => /export const EXTERNAL_CAPABILITIES\b/.test(RD(path.relative(root, f))));
    eq(definers.map((f) => path.relative(root, f)), [`${A}/src/main/core/external-calls.ts`],
      'C-5g ★能力白名单**唯一定处**');

    // 人侧出口在册（五个人侧 + 三个门侧）——renderer 的 `ipc.ts` 只是调它们。
    const ipc = RD(`${A}/src/main/ipc/external.ipc.ts`);
    for (const ch of ['external:listPending', 'external:list', 'external:approve', 'external:reject', 'external:revoke',
      'external:status', 'external:setInbound', 'external:listCalls']) {
      ok(ipc.includes(`'${ch}'`), `C-5h IPC 出口在册：${ch}`);
    }
    // 词表**不经 renderer 手抄**：审批面板的可授予项由 main 侧派生后随 `external:list` 下发。
    ok(/EXTERNAL_CAPABILITIES\.map\(/.test(ipc), 'C-5i ★★可授予能力词表由 main **派生**下发（renderer 不手抄第二份）');
  }

  // ═══ D｜域知识册（零 LLM 派生 / 四节真源 / 幂等）══════════════════════════════════
  console.log('\n【D】域知识册 —— 零 LLM 派生 / 四节真源 / 幂等');
  {
    // D-0：生产 DDL 与节词表**静态钉住**（改列名 / 删节 / 丢唯一键即红）。
    const dbSrc = RD(DB_SRC);
    const ddl = (dbSrc.match(/CREATE TABLE IF NOT EXISTS wa_project_knowledge \(([\s\S]*?)\)/) ?? [])[1] ?? '';
    ok(ddl.length > 0, 'D-0a 生产建 `wa_project_knowledge` 表');
    for (const col of ['id', 'project_id', 'section', 'content', 'source_ref', 'updated_at']) {
      ok(new RegExp(`\\b${col}\\b`).test(ddl), `D-0b 生产表含列 ${col}`);
    }
    ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_project_knowledge_sec ON wa_project_knowledge\(project_id, section\)/.test(dbSrc),
      'D-0c ★唯一键 `(project_id, section)`（幂等 upsert 的落点）');
    const colsOf = (block: string) => block.split('\n').map((l) => l.replace(/,\s*$/, '').trim())
      .filter((l) => l.length > 0 && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(l)).map((l) => l.split(/\s+/)[0]);
    eq(colsOf(ddl), colsOf((KNOWLEDGE_DDL.match(/\(([\s\S]*?)\)/) ?? [])[1] ?? ''),
      'D-0d 夹具 DDL 与生产**同形**（列序 / 列名一致 ⇒ 改生产列名必红）');
  }
  {
    // D-1：**零 LLM**（模块内不得有综合/请求那一跳）+ **不另抄 SQL**（四样各复用既有取数口）。
    const pk = CODE(PK_SRC);
    ok(!/generateText|createSafeProvider|getOptimalModel|ansClient|fetch\s*\(/.test(pk),
      'D-1a ★★零 LLM / 零网络：册由真源**派生**，模块内无任何综合或请求调用');
    ok(/collectProjectKnowledgeMaterials\s*\(/.test(pk),
      'D-1b ★三元组/交付物/调用账复用 `collectProjectKnowledgeMaterials`（不另抄 SQL）');
    ok(/describeProjectRuntime\s*\(/.test(pk), 'D-1c ★运行面复用 `describeProjectRuntime`');
    ok(!/FROM\s+wa_knowledge_triples/i.test(pk),
      'D-1d ★★反证：本模块**不自写**三元组取数 SQL（走共享真源，免得第二份口径）');
  }
  {
    // D-2：七节**各自取自真源**（逐节验证 content 非空且含真源值）+ 空则不出节。
    const db = makeKnowledgeDb();
    seedKnowledge(db);
    const secs = deriveProjectKnowledge(db as never, 'p1');
    eq(secs.map((s) => s.section),
      ['entities', 'artifacts', 'services', 'domain', 'usage', 'criteria', 'recipes', 'index', 'runtime'],
      'D-2a ★九节齐备且按词表序（批七三节 + zx_20261018_2 批四的 `domain`/`usage` 各从既有行派生）');
    const byS = new Map(secs.map((s) => [s.section, s]));
    ok(byS.get('entities')!.content.includes('客厅台灯 ─[controlled_by]→ worker-ant'),
      'D-2b ★`entities` 取自 `wa_knowledge_triples`（按 confidence）');
    ok(!byS.get('entities')!.content.includes('别家的东西'),
      'D-2c ★★反证：**他项目**的三元组不串味');
    ok(byS.get('artifacts')!.content.includes('code:2') && byS.get('artifacts')!.content.includes('report:1'),
      'D-2d ★`artifacts` 取自交付物按类型计数');
    ok(byS.get('services')!.content.includes('合计 3') && byS.get('services')!.content.includes('mcp: 2 次'),
      'D-2e ★`services` 取自调用账聚合');
    ok(byS.get('criteria')!.content.includes('[pending] 开灯与关门') &&
      byS.get('criteria')!.content.includes('失败 1 项：验收未通过 ×1'),
      'D-2f ★`criteria` 取自任务验收判据 + 失败因由（因由经 `pause-reason.ts` 说人话）');
    ok(!byS.get('criteria')!.content.includes('别家判据'), 'D-2f2 ★★反证：他项目的判据/失败不串味');
    ok(byS.get('recipes')!.content.includes('模板（home）：布置客厅——先清点后摆放') &&
      byS.get('recipes')!.content.includes('已验证：先清点再摆放，避免返工'),
      'D-2f3 ★`recipes` 取自 active 模板 + 本项目已验证样板');
    ok(byS.get('recipes')!.content.includes('布置客厅') && !byS.get('recipes')!.content.includes('别家的样板'),
      'D-2f4 ★★反证：他项目的样板不进本项目的配方节');
    ok(byS.get('index')!.content.includes('交付物[code/active] main.ts') &&
      byS.get('index')!.content.includes('记忆[semantic] 先清点再摆放') &&
      byS.get('index')!.content.includes('任务[failed] 布置客厅'),
      'D-2f5 ★`index` 取自交付物 / 活记忆 / 终态任务');
    ok(!byS.get('index')!.content.includes('别家的'), 'D-2f6 ★★反证：他项目的记忆/任务不进索引');
    ok(byS.get('runtime')!.content.includes('守护 1 个') && byS.get('runtime')!.content.includes('作业 2 条'),
      'D-2f7 ★`runtime` 取自守护/作业**存量**（他项目作业不计）');
    ok(byS.get('domain')!.content.includes('高频实体：') && byS.get('domain')!.content.includes('worker-ant×2'),
      'D-2f8 ★`domain` 取三元组的**频度**（worker-ant 出现 2 次：主语一次、宾语一次）');
    ok(byS.get('usage')!.content.includes('服务调用 3 次') && byS.get('usage')!.content.includes('交付物 4 件'),
      'D-2f9 ★`usage` 取调用账成败与交付总量（类型分布仍只在 `artifacts`，不抄两遍）');
    eq(secs.map((s) => s.sourceRef), ['wa_knowledge_triples', 'wa_deliverables', 'wa_service_calls',
      'wa_projects.context_json.language_game+wa_knowledge_triples',
      'wa_service_calls+wa_device_actions+wa_tasks.context_json.assigned_request_id+wa_deliverables',
      'wa_tasks+context_json.pause_reason', 'wa_task_templates+wa_memories(is_exemplar)',
      'wa_deliverables+wa_memories+wa_tasks', 'wa_deliverables+wa_jobs'],
      'D-2g 每节留**真源出处**（人可复核 / 机器可判陈旧）');
    const bare = makeKnowledgeDb();
    eq(deriveProjectKnowledge(bare as never, 'p-empty'), [],
      'D-2h ★无任何源 ⇒ 空册（"没发生"不伪造空壳）');
    bare.close();
    eq(deriveProjectKnowledge(db as never, 'p-empty').map((s) => s.section), ['recipes'],
      'D-2h2 ★全局模板不按项目过滤（模板表本无 project_id——如实照它的形状读）');
    db.close();
  }
  {
    // D-3：**幂等**——连跑两次不膨胀、内容更新；源整节消失 ⇒ 该节如实消失。
    const db = makeKnowledgeDb();
    seedKnowledge(db);
    const cnt = () => (db.prepare('SELECT COUNT(*) AS c FROM wa_project_knowledge WHERE project_id = ?').get('p1') as { c: number }).c;
    eq(upsertProjectKnowledge(db as never, 'p1', deriveProjectKnowledge(db as never, 'p1')), 9, 'D-3a 写入 9 节');
    eq(cnt(), 9, 'D-3b ★★初次落库 9 行');
    db.prepare(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`)
      .run('t3', 'p1', '新关系', 'points_to', '某处', 0.8);
    upsertProjectKnowledge(db as never, 'p1', deriveProjectKnowledge(db as never, 'p1'));
    eq(cnt(), 9, 'D-3c ★★重复跑**不膨胀**（仍 9 行，非新插）');
    const ent = (db.prepare("SELECT content FROM wa_project_knowledge WHERE project_id = ? AND section = 'entities'").get('p1') as { content: string }).content;
    ok(ent.includes('新关系 ─[points_to]→ 某处'), 'D-3d ★同一行被**覆写为最新**');
    db.prepare('DELETE FROM wa_knowledge_triples WHERE project_id = ?').run('p1');
    upsertProjectKnowledge(db as never, 'p1', deriveProjectKnowledge(db as never, 'p1'));
    eq(cnt(), 7, 'D-3e ★源已空 ⇒ entities/domain 两节按"此刻可派生"**消失**（不留陈旧壳）');
    eq(listProjectKnowledge(db as never, 'p1').map((s) => s.section),
      ['artifacts', 'services', 'usage', 'criteria', 'recipes', 'index', 'runtime'],
      'D-3f 读回按词表序、缺节即缺');
    db.close();
  }
  {
    // D-5：接线（consolidate 作业真派生真落册）+ 词表**唯一定处** + 「恰一份实现」扫面。
    ok(/from '\.\.\/project-knowledge\.js'/.test(RD(JOBS_SRC)), 'D-5a `jobs/index.ts` 引入域知识册模块');
    const jobsCode = CODE(JOBS_SRC);
    ok(/deriveProjectKnowledge\s*\(/.test(jobsCode) && /upsertProjectKnowledge\s*\(/.test(jobsCode),
      'D-5b ★★consolidate 作业**真派生、真落册**（不止建了文件）');
    const files = scanFiles(path.join(root, `${A}/src/main`));
    // zx_20261022_3 批七：导入内容住在**另一张表** `wa_project_knowledge_imports`（表名前缀相同）。
    //   裸子串判据会把那张表的写口误认成"册的第二个写口"——故改钉**写派生表本身**的 SQL 形状
    //   （表名后接空白+括号）。这比子串更强：真正写派生表的语句反而躲不过。
    const writers = files.filter((f) => /INSERT INTO wa_project_knowledge\s*\(/.test(RD(path.relative(root, f))));
    eq(writers.map((f) => path.relative(root, f)), [PK_SRC], 'D-5c ★★反证：册的写口**恰此一处**（别处再写一份即红）');
    const definers = files.filter((f) => /export const PROJECT_KNOWLEDGE_SECTIONS\b/.test(RD(path.relative(root, f))));
    eq(definers.map((f) => path.relative(root, f)), [PK_SRC], 'D-5d ★节词表**唯一定处**');
    eq([...PROJECT_KNOWLEDGE_SECTIONS],
      ['entities', 'artifacts', 'services', 'domain', 'usage', 'criteria', 'recipes', 'index', 'runtime'],
      'D-5e ★节词表**逐成员枚举**（含第二进程词表落点；zx_20261018_2 批四按新增值补全）');
    for (const s of PROJECT_KNOWLEDGE_SECTIONS) {
      ok(typeof PROJECT_KNOWLEDGE_SECTION_LABEL[s] === 'string' && PROJECT_KNOWLEDGE_SECTION_LABEL[s].length > 0,
        `D-5f 人话名非空：${s} ⇒ 「${PROJECT_KNOWLEDGE_SECTION_LABEL[s]}」`);
    }
  }

  // ═══ M｜预算内选节注入（§K 取代 panorama / 整节取舍 / 缺方法不记失败）════════════════
  console.log('\n【M】域知识注入 —— 按形态选节 / 整节取舍 / 零 panorama');
  {
    // M-0：静默接线钉——§K 真的接上（引真源 + 优先级表换名），且 panorama 消费已除名。
    const mc = CODE(MC_SRC);
    ok(/from '\.\/project-knowledge\.js'/.test(mc), 'M-0a `memory-context.ts` 引入域知识册模块（注入侧的尺与词表同处一源）');
    ok(/selectKnowledgeForInject\s*\(/.test(mc), 'M-0b ★★§K 真调 `selectKnowledgeForInject`（不止 import）');
    ok(/listDomainKnowledge\s*\(/.test(mc), 'M-0c ★★§K 真调 `memory.listDomainKnowledge`（消费侧读口）');
    // zx_20261018_3 批一：由 low 升为 mid——它是**本项目的事实**（实体/约定/坑），不是跨项目泛化背景；
    //   预算仍由 `selectMemorySections` 整段取舍，不越界。
    eq(MEM_SECTION_PRIORITY['项目域知识'], 'mid', 'M-0d ★优先级表：`项目域知识` 为 mid（本项目事实，不先舍）');
    ok(!('项目知识全景' in MEM_SECTION_PRIORITY), 'M-0e ★★反证：`项目知识全景` 已退役（优先级表里无此键）');
    ok(!/retrieveByType\(\s*'panorama'/.test(mc), "M-0f ★★反证：`memory-context.ts` 不再 `retrieveByType('panorama')`");
    ok(!/项目知识全景/.test(mc), 'M-0g ★★反证：去注释后无 `项目知识全景` 残留（词表换名彻底）');
  }
  {
    // M-1：`MemoryManager.listDomainKnowledge` 是**薄委托**（管理器不另抄那份取数 SQL）。
    const mm = CODE(MM_SRC);
    ok(/listDomainKnowledge\s*\(/.test(mm), 'M-1a ★`MemoryManager` 新增读口 `listDomainKnowledge`');
    ok(/return\s+listProjectKnowledge\s*\(/.test(mm), 'M-1b ★薄委托 `listProjectKnowledge`（"一个数只有一个来源"）');
    ok(!/FROM\s+wa_project_knowledge/i.test(mm), 'M-1c ★★反证：管理器**不自写**册取数 SQL（走真源，免得第二份口径）');
  }
  {
    // M-2：注入真行为——§K 段**存在且内容取自册**；无该读口（老桩）⇒ 无此段、不抛、不伪造空壳。
    const book = [{ section: 'entities', content: '甲 ─[uses]→ 乙', sourceRef: 'wa_knowledge_triples' }];
    // 代理桩：未列出的方法一律返回 `[]`（buildMemoryContext 的其它段据此空转，不干扰 §K 判读）。
    const mkStub = (over: Record<string, unknown>) => new Proxy(
      { generateExemplarContext: () => null, ...over },
      { get(t: Record<string, unknown>, p: string | symbol) { return p in t ? t[p as string] : () => []; } },
    );
    const r = buildMemoryContext(mkStub({ listDomainKnowledge: () => book }) as never, 'p1', undefined, '这一跳的成败关键', null, undefined, 6000);
    const sec = r.segmentChars.find((s) => s.name === '项目域知识');
    ok(!!sec && sec.kept, 'M-2a ★§K 段真入文（segmentChars 点名且 `kept:true`）');
    ok(r.context.includes('## 项目域知识') && r.context.includes(`### ${PROJECT_KNOWLEDGE_SECTION_LABEL.entities}`),
      'M-2b ★★段标题取自 `PROJECT_KNOWLEDGE_SECTION_LABEL`（人话名一源，不手抄）');
    ok(r.context.includes('甲 ─[uses]→ 乙'), 'M-2c ★段文本=册内容（注入的是**派生事实**，非 LLM 重综合）');
    const r2 = buildMemoryContext(mkStub({ listDomainKnowledge: undefined }) as never, 'p1', undefined, '这一跳的成败关键', null, undefined, 6000);
    ok(!r2.context.includes('## 项目域知识'), 'M-2d ★反证：桩无该读口 ⇒ 无 §K 段（不伪造空壳）');
    ok(r2.segmentChars.every((s) => s.name !== '项目域知识'), 'M-2e ★无该读口时段账里也不出现（老桩不受累）');
  }
  {
    // M-3：择节两把尺的**单元行为**（形态序 / 整节取舍 / 空预算）。
    const four = [
      { section: 'entities', content: 'e'.repeat(40), sourceRef: 'wa_knowledge_triples' },
      { section: 'artifacts', content: 'a'.repeat(40), sourceRef: 'wa_deliverables' },
      { section: 'services', content: 's'.repeat(40), sourceRef: 'wa_service_calls' },
      { section: 'runtime', content: 'r'.repeat(40), sourceRef: 'wa_deliverables+wa_jobs' },
    ];
    const codeOrder = orderKnowledgeSections(four as never, 'code').map((e) => e.section);
    eq(codeOrder[0], 'artifacts', 'M-3a ★`code` 形态：`artifacts` 打头（先看"已产出什么"）');
    eq(codeOrder[codeOrder.length - 1], 'runtime', 'M-3b ★★`runtime` **恒末位**（形态序的边界）');
    eq(orderKnowledgeSections(four as never, 'document').map((e) => e.section), ['entities', 'artifacts', 'services', 'runtime'],
      'M-3c ★未列形态（`document`）取**词表序**（缺谁补谁，不静默丢；`conversation` 自批四起已有偏好序）');
    const picked2 = selectKnowledgeForInject(four as never, 'code', 20);
    eq(picked2.map((e) => e.section), ['artifacts', 'services'], 'M-3d ★预算内按形态序取节（装不下即跳过、不截字）');
    ok(picked2.every((e) => e.content.length === 40), 'M-3e ★★整节完整（**绝不截字**——结构不破）');
    eq(selectKnowledgeForInject(four as never, 'code', 0), [], 'M-3f ★预算 0 ⇒ 空（"没得注入"是如实值）');
    eq(selectKnowledgeForInject([], 'code', KNOWLEDGE_INJECT_MAX_TOKENS), [], 'M-3g ★空册 ⇒ 空');
    eq(KNOWLEDGE_INJECT_MAX_TOKENS, 400, 'M-3h `KNOWLEDGE_INJECT_MAX_TOKENS` = 400（本段上界，非全局预算的第二份）');
  }

  // ═══ S｜哑雷自检 + build 钉（S1–S3 自指；`checkBuildPins` P1–P6 派生核对）════════════
  console.log('\n【S】哑雷自检 + build 钉（不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);
    // S4：build 钉 P1–P6（P6 读 dist 产物内 build 值本身——故 `tsup` 必须先于 rr）。
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
//   ⚠ 批三起 `main` 是 `async`（门端点 `invoke` 那一跳是真 Promise）——`.then/.catch` 与 try/catch **等价**，
//     catch 一侧照旧把 `fail` 加一后再报失败（不得因改成 Promise 而丢掉这道闸）。
main()
  .then(() => {
    console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261014_4: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e: unknown) => {
    console.error(`\n💥 rr_zx_20261014_4 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
    fail++;
    console.log(`\n❌ rr_zx_20261014_4: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  });
