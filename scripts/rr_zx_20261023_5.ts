/**
 * zx_20261023_5 受控复跑 —— 「序」：**依赖感知的跨机编排**（本套件随批次增量落册）。
 *
 * ── 批一判据（A 组；后续批次在同一文件继续追加 B–E 组）──────────────────────────
 *   A-1 关键路径排序：同优先级、同 created_at 下，**依赖链更长的先启动**（两只标本：
 *       开关开 ⇒ 长链在前；开关 `'false'` ⇒ 回到原顺序）。反证：无依赖项目顺序逐字不变。
 *   A-2 准入三态（`decideCreateDispatch`）：`waiting` 拒 / `dead` 拒且理由可读 / `met` 与
 *       `unresolved` 放行 / **未给 `depState` 的旧调用方行为不变**（仍是 `has-dependencies`）。
 *   A-3 实时事实（`buildExistingTaskDispatchFacts`）从真实行读依赖三态与类目。
 *   A-4 派单载荷随行上游摘要：`buildDispatchPayload` 恰 5 条上限；`collectUpstreamSummaries`
 *       的双守（条数 ≤5 ∧ 总字符 ≤1200），以及"已完成无摘要"的如实说明。
 *   A-5 上游到站 ⇒ 后继重新决策：`dispatchReadyDependents` 对 `met` 真派、对 `waiting` 不派且
 *       给出理由；重复调用幂等（`already-dispatched`）；**未完成的上游 ⇒ 不派**（反证）。
 *   A-6 派单理由视图与协同面板三分组（`dispatchReasonForTask` / `dispatchBoard`）与真派**同一把尺**。
 *   A-7 接线：`scheduleDependentDispatch` 恰在三处**完成出口**（远端 done / 主执行完成 / 恢复完成），
 *       失败分支无调用（反证）；角色/权重/依赖三行由视图给出（行序钉死）。
 *
 * ── 批三判据（C 组）──────────────────────────────────────────────────────────
 *   C-1 渠道注册表：五渠道在册、`channelForProtocol` 按注册顺序归属（mqtt 先于 HA）、
 *       `resolveChannel` 未知名如实拒、`listOnboardingChannels` **锁定渠道不出现在列表里**
 *       （两只标本：锁定档空 / 解锁档五条 / 免费渠道锁定档仍出现）。
 *   C-2 预检 `authorizeChannel`：档位 → 凭据 → token 逐项问（缺什么说什么）。
 *   C-3 miIO 包编解码：魔数/长度/校验三关各自可被篡改标本打红；错 token 解不开；
 *       hello 无密文体；零填充（非 PKCS#7）往返无损。
 *   C-4 miIO 控制：无 token/非法 token **如实拒**、不支持动作列词表、设备 error 原样带 code、
 *       回包无效/传输失败各有其词；`setMiioTokenProvider` 注入生效。
 *   C-5 miIO 状态：get_status 优先、失败回落 get_prop、两问皆失败如实报因。
 *   C-6 发现映射：`miioDiscovered` 的 did/端口/能力；`miioMdnsToDiscovered` 无地址即 null。
 *   C-7 凭据加密：旧明文**读一次即迁移**（同键改值）、二次读不再迁移、迁移失败**不丢数据**、
 *       后端不可用 ⇒ 写口拒且盘上不变、读到密文如实回"解不开"、清除即删行。
 *   C-8 密钥词表：每设备 token 键由**前缀规则**命中（后缀规则够不着 `.5` 这种结尾）。
 *   C-9 接线：三新 IPC 恰一处登记、发现并联 miIO、主进程装配在 IPC 之前、向导入口与四步在册、
 *       选路/状态分支各一处、渲染层通道名与 main 同名。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *   G-1 跑生产函数（静态导入真实现；不在本文件复刻等价物）。
 *   G-4 不硬编码本轮墙钟：需要"在线/试用"时用**相对此刻**的时刻，判据只依赖相对关系。
 *   G-5 静态判据读**去注释后的原文**；"代码含 X"类仍读原文。
 *   G-6 无轮次字面量：轮次由 `path.basename(__filename)` 派生。
 *   ⚠ 断言文案不含成功/失败字形（`pnpm rr:all` 汇总器按日志里的字形计数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  AUTO_DISPATCH_SETTING_KEY,
  CREATE_DISPATCH_REASON_LABEL,
  buildDispatchPayload,
  buildExistingTaskDispatchFacts,
  collectUpstreamSummaries,
  decideCreateDispatch,
  dispatchBoard,
  dispatchReadyDependents,
  dispatchReasonForTask,
  type CreateDispatchFacts,
  type DispatchUpstream,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
import { UPSTREAM_MAX_CHARS, UPSTREAM_MAX_ITEMS } from '../apps/worker-ant-desktop/src/main/core/exec-prelude.js';
import type { AnsNode, AnsNodeRequest, NodeRequestSubmit } from '@worker-ant/shared-types';
import type { NodeLedger } from '../apps/worker-ant-desktop/src/main/core/node-list.js';
import type { DispatchIo } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
import {
  CARD_INJECT_MAX_ITEMS,
  CARD_INJECT_MAX_TOKENS,
  CARD_MAX_PER_PROJECT,
  CARD_MAX_TOKENS,
  KNOWLEDGE_CARD_FEATURE,
  KNOWLEDGE_CARD_KINDS,
  deriveKnowledgeCardCandidates,
  distillKnowledgeCards,
  listActiveKnowledgeCards,
  planKnowledgeCards,
  recordPitfallCandidate,
  selectKnowledgeCardsForInject,
  type KnowledgeCard,
} from '../apps/worker-ant-desktop/src/main/core/knowledge-cards.js';
import { KNOWLEDGE_INJECT_MAX_TOKENS, listProjectKnowledge, selectKnowledgeForInject } from '../apps/worker-ant-desktop/src/main/core/project-knowledge.js';
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL, proFeatureRefusal, proUnlocked } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { estimateTokensFromChars, TOKEN_CHARS_PER_UNIT } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';
import {
  authorizeChannel,
  channelForProtocol,
  getChannel,
  listChannels,
  listOnboardingChannels,
  registerChannel,
  resolveChannel,
  unregisterChannel,
  type DeviceChannel,
} from '../apps/worker-ant-desktop/src/main/core/device-channel.js';
import {
  MIIO_ACTIONS,
  MIIO_MAGIC,
  MIIO_PORT,
  MIIO_UNKNOWN_DID,
  currentMiioToken,
  decodeMiioPacket,
  encodeMiioPacket,
  miioCommandFor,
  miioDeviceControl,
  miioDeviceState,
  miioDidOf,
  miioDiscovered,
  miioHelloPacket,
  miioMdnsToDiscovered,
  miioTokenSettingKey,
  normalizeMiioToken,
  readMiioHeader,
  setMiioTokenProvider,
  type MiioTransport,
} from '../apps/worker-ant-desktop/src/main/core/providers/mijia-miio.js';
import {
  SECRET_ENC_PREFIX,
  clearSecret,
  initDeviceSecrets,
  isEncryptedSecret,
  readSecret,
  secretCipherState,
  secretState,
  writeSecret,
  type SecretCipher,
} from '../apps/worker-ant-desktop/src/main/core/device-secrets.js';
import { isSecretSettingKey } from '../apps/worker-ant-desktop/src/main/core/secret-settings.js';
import { defaultDeviceControl, lanAddressRefusal } from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
import type { AnsDevice } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  LAN_PENDING_TTL_MS,
  LAN_SILENCE_MS,
  LAN_TERMINAL_SERVICE_TYPE,
  TERMINAL_TXT_ALLOWED_KEYS,
  __resetLanPendingForTest,
  ingestLanAnnouncement,
  isLanTerminalSilenced,
  isTerminalBrowseRunning,
  lanPendingId,
  listLanPending,
  pruneLanSilences,
  sanitizeTerminalTxt,
  silenceLanTerminal,
  startTerminalBrowse,
  stopTerminalBrowse,
  takeLanPending,
  type TerminalAnnouncement,
  type TerminalBrowseIo,
} from '../apps/worker-ant-desktop/src/main/core/lan-terminals.js';
import {
  approveTerminal,
  buildPairNotice,
  createPairRequestGuarded,
  getTerminalBrief,
  listPendingTerminals,
  pairStatus,
  verifyTerminal,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import { INBOUND_MDNS_SERVICE } from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
// ── 批五：能力绑档 + 云端权益契约 ────────────────────────────────────────────
import {
  CLOUD_ENTITLEMENT_SETTING_KEY,
  CLOUD_ENTITLEMENT_TIMEOUT_MS,
  ENTITLEMENT_TIER_ORDER,
  cloudActiveTier,
  isCloudEntitlementActive,
  mergeLicenseTier,
  parseCloudEntitlement,
  readCloudEntitlementCache,
  writeCloudEntitlementCache,
  type CloudEntitlementCache,
} from '../apps/worker-ant-desktop/src/main/core/cloud-entitlement.js';
import { CLOUD_ENTITLEMENT_PATH, pullCloudEntitlement } from '../apps/worker-ant-desktop/src/main/core/entitlement-client.js';
import { LICENSE_SETTING_KEYS, resolveLicenseState, resolveLicenseTier } from '../apps/worker-ant-desktop/src/main/core/license.js';
import { teamUnlocked } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { PRICING } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { BENEFIT_COVERAGE } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { issueEntitlement, resolveEntitlement } from '../apps/ans-server/src/routes/entitlements.js';
import { entitlementTierRank, isEntitlementTier, type AnsEntitlement } from '@worker-ant/shared-types';

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
const STRIPPED = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/** 生产同形的相关表（列取 `main/database.ts` 真 DDL；NOT NULL 照抄，防夹具比生产宽松）。 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
  title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
  context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_audit_events (
  id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
`;
function mkdb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // node:sqlite 缺省开外键（与 better-sqlite3 相反）⇒ 任务行必须先有项目行（夹具与生产同约束）。
  db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(PROJ, '演示项目');
  return db;
}
function set(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(key, value);
}
function getOne<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
function count(db: DatabaseSync, table: string): number {
  return (getOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)! as { n: number }).n;
}

/**
 * 批二（知识卡）夹具表：列形状照抄 `main/database.ts` 真 DDL（NOT NULL/唯一索引一并照抄，
 * 夹具不得比生产宽松——否则"唯一键去重"这类判据只会自我印证）。
 */
const CARD_SCHEMA = `
CREATE TABLE wa_project_knowledge (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
CREATE TABLE wa_project_knowledge_imports (
  project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
  imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section)
);
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT,
  type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '',
  file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_memories (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT,
  content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
  importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
  user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
  is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_knowledge_cards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5,
  tokens INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_wa_knowledge_cards_key ON wa_knowledge_cards(project_id, kind, source, text);
CREATE INDEX idx_wa_knowledge_cards_project ON wa_knowledge_cards(project_id, status, kind);
CREATE TABLE wa_context_injections (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id);
CREATE INDEX idx_wa_context_injections_ref ON wa_context_injections(source, ref_id, outcome);
`;

type CardDb = DatabaseSync & { transaction?: (fn: () => void) => () => void };

/** 批二夹具库：基础表 + 知识卡相关表 + `transaction` 垫片（node:sqlite 无此 API）。 */
function mkCardDb(): CardDb {
  const db = new DatabaseSync(':memory:') as CardDb;
  db.exec(SCHEMA);
  db.exec(CARD_SCHEMA);
  db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(PROJ, '演示项目');
  db.transaction = (fn: () => void) => () => fn();
  return db;
}

/** 试用期内（kind=trial ⇒ Pro 能力放行）；时刻**相对此刻**，不写死日历日。 */
function seedTrial(db: DatabaseSync): void {
  set(db, 'license.trial_started_at', new Date().toISOString());
}
/** 社区档：无任何许可/试用设置。 */
function seedCommunity(db: DatabaseSync): void {
  db.prepare('DELETE FROM wa_settings').run();
}

function addKnowledge(db: DatabaseSync, section: string, content: string): void {
  db.prepare('INSERT INTO wa_project_knowledge (id, project_id, section, content) VALUES (?, ?, ?, ?)')
    .run(`k-${section}`, PROJ, section, content);
}
function addDeliverable(db: DatabaseSync, id: string, name: string, status = 'registered', type = 'file'): void {
  db.prepare('INSERT INTO wa_deliverables (id, project_id, type, name, status) VALUES (?, ?, ?, ?, ?)')
    .run(id, PROJ, type, name, status);
}
function addMemory(db: DatabaseSync, id: string, memoryType: string, content: string, importance = 0.8): void {
  db.prepare('INSERT INTO wa_memories (id, project_id, content, memory_type, importance) VALUES (?, ?, ?, ?, ?)')
    .run(id, PROJ, content, memoryType, importance);
}
/** 五类卡各一只真源标本（B-1 的"该命中"侧）。 */
function seedAllFiveKinds(db: DatabaseSync): void {
  addKnowledge(db, 'domain', '- 订单域：订单号以 SO 开头\n- 对账日结每日 02:00 跑');
  addKnowledge(db, 'criteria', '- 新增接口须有集成测试\n- 金额一律用分表示');
  addKnowledge(db, 'recipes', '- 导出报表：先查模板再套数');
  addDeliverable(db, 'd1', '月度对账单', 'registered', 'xlsx');
  addDeliverable(db, 'd2', '草稿报表', 'draft', 'xlsx');
  addMemory(db, 'm1', 'retrospective', '先跑冒烟再全量，省下两轮返工');
  addMemory(db, 'm2', 'failure_knowledge', '时区混用导致跨日对账错账');
  addMemory(db, 'm3', 'acceptance_failure', '导出列名与模板不一致被拒收');
}

const PROJ = 'p1';
const LOCAL = 'n-local';

/**
 * 生产同形的"可派本机"：入网三条件（`nodeEnrollmentReason`）+ team 档解锁（试用期）+ 开关开 + hand 角色。
 * 时刻一律**相对此刻**——在线/试用判据只依赖相对关系，不写死某个日历时刻。
 */
function seedDispatchable(db: DatabaseSync, opts: { role?: string; weight?: string } = {}): void {
  db.prepare('INSERT OR IGNORE INTO wa_projects (id, name) VALUES (?, ?)').run(PROJ, '演示项目');
  set(db, 'node.id', LOCAL);
  set(db, 'node.resource_group', `node:${LOCAL}`);
  set(db, 'ans_api_key', 'abcdefgh12345678'); //gitleaks:allow（合成夹具，非凭据）
  set(db, 'node.enrolled_key_prefix', 'abcdefgh');
  set(db, 'node.role', opts.role ?? 'primary');
  if (opts.weight !== undefined) set(db, 'node.weight', opts.weight);
  set(db, AUTO_DISPATCH_SETTING_KEY, '1');
  set(db, 'license.trial_started_at', new Date(Date.now() - 86_400_000).toISOString());
}
function task(
  db: DatabaseSync,
  id: string,
  opts: {
    title?: string; status?: string; priority?: number; dependsOn?: string; parent?: string;
    context?: Record<string, unknown>; project?: string; createdAt?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO wa_tasks (id, project_id, title, description, status, priority, depends_on, parent_task_id, context_json, created_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.project ?? PROJ,
    opts.title ?? id,
    opts.status ?? 'pending',
    opts.priority ?? 0,
    opts.dependsOn ?? '',
    opts.parent ?? '',
    JSON.stringify(opts.context ?? {}),
    opts.createdAt ?? '2026-01-01 00:00:00',
  );
}

/** 准入事实的"该放行"标本（各条断言只改要看的那一格）。 */
function facts(over: Partial<CreateDispatchFacts> = {}): CreateDispatchFacts {
  return {
    settingOn: true, teamUnlocked: true, enrolled: true,
    hasParent: false, hasDependencies: false, hasAttachments: false,
    hasWorkingDir: false, decomposed: false, category: 'code',
    ...over,
  };
}

/** 批三 miIO 台账行夹具（字段取 `AnsDevice` 真形状；token 一律经 deps 注入，夹具里没有凭据）。 */
function miioDev(over: Partial<AnsDevice> = {}): AnsDevice {
  return {
    id: 'd-miio', name: '米家灯', alias: '', room: '', kind: 'unknown',
    protocol: 'miio', address: '192.168.1.50', port: MIIO_PORT,
    capabilities: ['miio', 'miio:did:6699'], controllable: true, authorized: true, status: null,
    ...over,
  } as unknown as AnsDevice;
}

const PEER: AnsNode = {
  node_id: 'n-peer', name: '对端', api_key_prefix: 'abcdefgh', resource_group: 'node:n-peer',
  platform: 'darwin', role: 'worker', weight: 50, participate: true, capabilities: [],
  card: { categories: ['code'] }, status: null,
  enrolled_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
};
function ledger(): NodeLedger {
  return { nodes: [PEER], localNodeId: LOCAL };
}
const NOW_MS = Date.now();
/** 假 IO：提交成功并把回包原样给出；requests 留档供断言"真带上了什么"。 */
function fakeIo(): DispatchIo & { submitted: NodeRequestSubmit[] } {
  const submitted: NodeRequestSubmit[] = [];
  return {
    submitted,
    async submit(req: NodeRequestSubmit): Promise<AnsNodeRequest> {
      submitted.push(req);
      return {
        id: `req-${submitted.length}`, category: req.category, payload: req.payload ?? {},
        requester_key_prefix: 'abcdefgh', requester_node_id: LOCAL,
        target_node_id: 'n-peer', status: 'pending', result: null,
        question: null, answer: null, question_status: null,
        created_at: new Date().toISOString(), claimed_at: null, done_at: null,
      };
    },
    async get(): Promise<AnsNodeRequest> { throw new Error('unused'); },
    async answer(): Promise<AnsNodeRequest> { throw new Error('unused'); },
  };
}

async function main(): Promise<void> {
  // ═══ A-1 关键路径排序 ═════════════════════════════════════════════════════
  console.log('\n【A-1】关键路径优先：同优先级下长链先启动（两只标本）');
  {
    // 插入序刻意把孤立任务放前：created_at 全同 ⇒ 旧序就是插入序。
    const mk = (): DatabaseSync => {
      const db = mkdb();
      task(db, 'solo', { title: '孤立任务' });
      task(db, 'c1', { title: '链首' });
      task(db, 'c2', { title: '链中', dependsOn: 'c1' });
      task(db, 'c3', { title: '链尾', dependsOn: 'c2' });
      return db;
    };
    const readyOf = (db: DatabaseSync) =>
      new TaskScheduler(db as unknown as import('better-sqlite3').Database)
        .getReadyTasks(PROJ).map((t) => String(t.id));

    const on = mk();
    eq(readyOf(on), ['c1', 'solo'], 'A-1a 开关缺省开：链首（深度 2）排在孤立任务（深度 0）之前');
    const off = mk();
    set(off, 'sched.critical_path', 'false');
    eq(readyOf(off), ['solo', 'c1'], 'A-1b 反证：开关关闭 ⇒ 回到原序（长链不再提前）');
    const flat = mkdb();
    task(flat, 'a'); task(flat, 'b');
    eq(readyOf(flat), ['a', 'b'], 'A-1c 反证：无依赖项目顺序逐字不变（深度全 0）');
  }

  // ═══ A-2 准入三态 ═════════════════════════════════════════════════════════
  console.log('\n【A-2】有依赖 ≠ 永不外派：waiting / dead / met / unresolved 四象 + 旧调用方不变');
  {
    const d = (over: Partial<CreateDispatchFacts>) => decideCreateDispatch(facts(over));
    const waiting = d({ hasDependencies: true, depState: 'waiting' });
    eq([waiting.eligible, waiting.reason], [false, 'dependencies-waiting'], 'A-2a 前置未完成 ⇒ 不派，理由可机读');
    ok(CREATE_DISPATCH_REASON_LABEL['dependencies-waiting'].includes('完成后自动派发'),
      'A-2b 理由人话点明"会自动满足"（不是永久拒）', CREATE_DISPATCH_REASON_LABEL['dependencies-waiting']);
    const dead = d({ hasDependencies: true, depState: 'dead' });
    eq([dead.eligible, dead.reason], [false, 'dependencies-dead'], 'A-2c 前置已死 ⇒ 不派且理由与 waiting 分开');
    const met = d({ hasDependencies: true, depState: 'met' });
    eq([met.eligible, met.reason], [true, 'eligible'], 'A-2d 前置已满足 ⇒ 可派（与孤儿任务同一把尺）');
    const unr = d({ hasDependencies: true, depState: 'unresolved' });
    eq([unr.eligible, unr.reason], [true, 'eligible'], 'A-2e 前置无法解析 ⇒ 同 met 放行（unresolved 不拦）');
    const legacy = d({ hasDependencies: true });
    eq([legacy.eligible, legacy.reason], [false, 'has-dependencies'], 'A-2f 反证：未给 depState 的旧调用方行为不变');
    eq(d({}).category, 'code', 'A-2g 放行时类目原样交出（供派单使用）');
  }

  // ═══ A-3 实时事实从真行读 ═════════════════════════════════════════════════
  console.log('\n【A-3】buildExistingTaskDispatchFacts：真行 → 三态事实');
  {
    const db = mkdb();
    seedDispatchable(db);
    task(db, 'up-done', { title: '修复登录 bug', status: 'completed' });
    task(db, 'up-run', { title: '准备数据' });
    task(db, 'up-fail', { title: '旧实现', status: 'failed' });
    task(db, 't-met', { title: '修复登录 bug', dependsOn: 'up-done' });
    task(db, 't-wait', { title: '修复登录 bug', dependsOn: 'up-run' });
    task(db, 't-dead', { title: '修复登录 bug', dependsOn: 'up-fail' });
    const f = (id: string) => buildExistingTaskDispatchFacts(db as unknown as import('better-sqlite3').Database, id);
    eq([f('t-met').depState, decideCreateDispatch(f('t-met')).eligible], ['met', true], 'A-3a 前置 completed ⇒ met 且可派');
    eq([f('t-wait').depState, f('t-wait').hasDependencies], ['waiting', true], 'A-3b 前置 pending ⇒ waiting');
    eq(f('t-dead').depState, 'dead', 'A-3c 前置 failed ⇒ dead');
    eq(f('t-met').category, 'code', 'A-3d 类目由同一路由真源推出（编码题面 ⇒ code）');
    eq([f('t-met').enrolled, f('t-met').teamUnlocked, f('t-met').settingOn], [true, true, true], 'A-3e 入网/档位/开关三格同源');
  }

  // ═══ A-4 上游摘要：双守与截断 ═════════════════════════════════════════════
  console.log('\n【A-4】派单载荷随行上游摘要：条数 ≤5 ∧ 字符 ≤1200');
  {
    const items = (n: number): DispatchUpstream[] =>
      Array.from({ length: n }, (_, i) => ({ id: `u${i}`, title: `前置${i}`, summary: '摘要' }));
    eq(buildDispatchPayload({ id: 't', title: 'T' }, items(7)).upstream?.length, UPSTREAM_MAX_ITEMS,
      'A-4a buildDispatchPayload：7 条 ⇒ 恰留 5 条');
    const bad = [...items(2), { id: '', title: 'x', summary: 'y' }] as DispatchUpstream[];
    eq(buildDispatchPayload({ id: 't', title: 'T' }, bad).upstream?.length, 2, 'A-4b 反证：空 id 被滤掉，不占名额');
    ok(!('upstream' in buildDispatchPayload({ id: 't', title: 'T' }, [])), 'A-4c 无上游 ⇒ 不出现该键（不伪造空数组）');
    eq(buildDispatchPayload({ id: 't', title: 'T', acceptanceCriteria: 'A' }, items(1)).prompt, 'T\n\n验收标准：A',
      'A-4d 兼容键 prompt 形状不变（旧对端照旧可建单）');

    const many = mkdb();
    const depIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      task(many, `d${i}`, { status: 'completed', context: { completion_summary: 'x' } });
      depIds.push(`d${i}`);
    }
    task(many, 't-many', { dependsOn: depIds.join(',') });
    eq(collectUpstreamSummaries(many as unknown as import('better-sqlite3').Database, 't-many').length, UPSTREAM_MAX_ITEMS,
      'A-4e collectUpstreamSummaries：先撞条数上限（5 条）');

    const heavy = mkdb();
    const heavyIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      task(heavy, `h${i}`, { status: 'completed', context: { completion_summary: '摘'.repeat(350) } });
      heavyIds.push(`h${i}`);
    }
    task(heavy, 't-heavy', { dependsOn: heavyIds.join(',') });
    const kept = collectUpstreamSummaries(heavy as unknown as import('better-sqlite3').Database, 't-heavy');
    const cost = kept.reduce((s, u) => s + u.title.length + u.summary.length + 8, 0);
    ok(kept.length === 3 && cost <= UPSTREAM_MAX_CHARS,
      'A-4f 字符上限先生效：4 条各 350 字 ⇒ 恰留 3 条且总代价不超 1200', `留 ${kept.length} 条 / 代价 ${cost}`);

    const plain = mkdb();
    task(plain, 'p1', { status: 'completed' });
    task(plain, 't-plain', { dependsOn: 'p1' });
    const su = collectUpstreamSummaries(plain as unknown as import('better-sqlite3').Database, 't-plain');
    eq(su[0]?.summary, '已完成（无登记摘要）', 'A-4g 已完成但无摘要 ⇒ 如实说明，不编内容');
    eq(collectUpstreamSummaries(plain as unknown as import('better-sqlite3').Database, 'p1'), [], 'A-4h 无依赖 ⇒ 空数组');
  }

  // ═══ A-5 上游到站 ⇒ 后继重新决策 ══════════════════════════════════════════
  console.log('\n【A-5】dispatchReadyDependents：met 真派 / waiting 不派 / 幂等 / 未完成反证');
  {
    const db = mkdb();
    seedDispatchable(db);
    task(db, 'up', { title: '修复登录 bug', status: 'completed', context: { completion_summary: '已修好并自测' } });
    task(db, 'up-pending', { title: '修复登录 bug' });
    task(db, 'down', { title: '修复登录 bug', dependsOn: 'up' });
    task(db, 'down-blocked', { title: '修复登录 bug', dependsOn: 'up,up-pending' });
    task(db, 'down-of-pending', { title: '修复登录 bug', dependsOn: 'up-pending' });
    const io = fakeIo();
    const before = count(db, 'wa_audit_events');

    const r1 = await dispatchReadyDependents(db as unknown as import('better-sqlite3').Database, 'up', {
      listLedger: async () => ledger(), io, emit: () => undefined, nowMs: NOW_MS,
    });
    const byId = new Map(r1.map((x) => [x.taskId, x.outcome]));
    eq([byId.get('down')?.attempted, byId.get('down')?.ok, byId.get('down')?.nodeId], [true, true, 'n-peer'],
      'A-5a 上游 completed ⇒ 后继 down 真派（三键落定）');
    eq(byId.get('down-blocked')?.reason, 'dependencies-waiting', 'A-5b 另一前置未完成 ⇒ down-blocked 不派且理由如实');
    eq(count(db, 'wa_audit_events') - before, 1, 'A-5c 计数器：审计台账 0→1（恰一条真派留痕）');
    eq(io.submitted.length, 1, 'A-5d 反证：只提交了一单（waiting 者不触网）');
    const payload = io.submitted[0]?.payload as { upstream?: Array<{ id: string; summary: string }> } | undefined;
    eq(payload?.upstream?.[0]?.id, 'up', 'A-5e 派单载荷真带上上游摘要（远端唯一的上游依据）');
    eq(payload?.upstream?.[0]?.summary, '已修好并自测', 'A-5f 摘要内容取 completion_summary 真源');

    const ctx = JSON.parse((getOne<{ context_json: string }>(db, 'SELECT context_json FROM wa_tasks WHERE id = ?', 'down')!).context_json);
    eq([ctx.assigned_node_id, ctx.assigned_request_id, typeof ctx.assigned_at], ['n-peer', 'req-1', 'string'],
      'A-5g 三键真落库（幂等与调度让位都读它）');

    const r2 = await dispatchReadyDependents(db as unknown as import('better-sqlite3').Database, 'up', {
      listLedger: async () => ledger(), io, emit: () => undefined, nowMs: NOW_MS,
    });
    eq(r2.find((x) => x.taskId === 'down')?.outcome.reason, 'already-dispatched', 'A-5h 重放幂等：同一件不再派第二次');
    eq(io.submitted.length, 1, 'A-5i 反证：重放零新增提交');

    const r3 = await dispatchReadyDependents(db as unknown as import('better-sqlite3').Database, 'up-pending', {
      listLedger: async () => ledger(), io, emit: () => undefined, nowMs: NOW_MS,
    });
    eq(r3.find((x) => x.taskId === 'down-of-pending')?.outcome.reason, 'dependencies-waiting',
      'A-5j 反证：上游未完成（pending）⇒ 后继不派');
    eq(io.submitted.length, 1, 'A-5k 反证：未完成的上游不产生任何新提交');
  }

  // ═══ A-6 视图与面板（与真派同一把尺）═════════════════════════════════════
  console.log('\n【A-6】派单理由三行 + 协同面板三分组');
  {
    const db = mkdb();
    seedDispatchable(db, { weight: '60' });
    task(db, 'ready', { title: '修复登录 bug' });
    task(db, 'waiter', { title: '修复登录 bug', dependsOn: 'dep-pending' });
    task(db, 'dep-pending', { title: '前置待办' });
    task(db, 'deader', { title: '修复登录 bug', dependsOn: 'dep-failed' });
    task(db, 'dep-failed', { title: '前置失败', status: 'failed' });
    task(db, 'child', { title: '修复登录 bug', parent: 'ready' });
    task(db, 'assigned', {
      title: '修复登录 bug',
      context: { assigned_node_id: 'n-peer', assigned_request_id: 'req-x', assigned_at: '2026-01-01T00:00:00.000Z' },
    });

    const v = (id: string) => dispatchReasonForTask(db as unknown as import('better-sqlite3').Database, id);
    const readyV = v('ready');
    eq(readyV.lines.map((l) => l.key), ['role', 'capacity', 'deps'], 'A-6a 三行行序钉死：角色/权重 → 机器余力 → 依赖状态');
    ok(readyV.lines[0]!.value.includes('主节点') && readyV.lines[0]!.value.includes('权重 60'),
      'A-6b 角色/权重取本机设置真值', readyV.lines[0]!.value);
    ok(/本机并发 \d+\/\d+/.test(readyV.lines[1]!.value), 'A-6c 机器余力取并发口径真值', readyV.lines[1]!.value);
    eq([readyV.eligible, readyV.reason], [true, 'eligible'], 'A-6d 可派任务判据与真派同源');

    const waitV = v('waiter');
    eq([waitV.eligible, waitV.label], [false, CREATE_DISPATCH_REASON_LABEL['dependencies-waiting']],
      'A-6e 等待依赖的任务如实说"完成后自动派发"');
    eq(waitV.lines[2]!.value, '前置未完成（完成后自动派发）', 'A-6f 依赖行说人话');
    eq(v('deader').reason, 'dependencies-dead', 'A-6g 上游已死 ⇒ 理由与等待分开');
    eq(v('assigned').reason, 'already-dispatched', 'A-6h 已外派 ⇒ 不再重复派（视图如实说）');

    const board = dispatchBoard(db as unknown as import('better-sqlite3').Database);
    ok(board.enabled, 'A-6i 面板读到开关为开');
    eq(board.eligible.map((x) => x.taskId), ['ready'], 'A-6j 可派组：只列判据说能派的');
    ok(board.waiting.some((x) => x.taskId === 'waiter'), 'A-6k 等待依赖组按依赖态归类');
    ok(board.dead.some((x) => x.taskId === 'deader'), 'A-6l 上游已死组按依赖态归类');
    ok(!board.eligible.some((x) => x.taskId === 'child'), 'A-6m 反证：有父任务不进"可派"（本机工作常态不冒充待办）');
    ok(![...board.eligible, ...board.waiting, ...board.dead].some((x) => x.taskId === 'assigned'),
      'A-6n 反证：已派定的任务不在候选面');
    eq(board.scanned, 6, 'A-6o 扫描计数如实（含不入组的行）');

    const off = mkdb();
    seedDispatchable(off);
    set(off, AUTO_DISPATCH_SETTING_KEY, '0');
    task(off, 'ready2', { title: '修复登录 bug' });
    const b2 = dispatchBoard(off as unknown as import('better-sqlite3').Database);
    eq([b2.enabled, b2.eligible.length], [false, 0], 'A-6p 开关关闭 ⇒ 可派组恒空（不假装能派）');
  }

  // ═══ A-7 接线：完成出口触发，失败分支不触发 ═══════════════════════════════
  console.log('\n【A-7】scheduleDependentDispatch：三处完成出口，失败分支零调用（反证）');
  {
    const files = ['core/node-remote-driver.ts', 'core/jobs/ai-task.ts'] as const;
    const src = Object.fromEntries(files.map((f) => [f, STRIPPED(`${A}/src/main/${f}`)])) as Record<string, string>;
    const callsOf = (s: string) => [...s.matchAll(/scheduleDependentDispatch\(/g)].length;

    eq(callsOf(src['core/node-remote-driver.ts']!), 1, 'A-7a 远端结果驱动：恰一处调用');
    eq(callsOf(src['core/jobs/ai-task.ts']!), 2, 'A-7b 执行/恢复两条完成出口：各一处');
    eq(callsOf(src['core/collab-dispatch.ts'] ?? STRIPPED(`${A}/src/main/core/collab-dispatch.ts`)), 1,
      'A-7c 定义处一处（共 4 处含定义，即 3 个调用点）');

    const driver = src['core/node-remote-driver.ts']!;
    const iDone = driver.indexOf("if (req.status === 'done')");
    const iCall = driver.indexOf('scheduleDependentDispatch(');
    const iErr = driver.indexOf("if (req.status === 'error'");
    ok(iDone > -1 && iDone < iCall && (iErr === -1 || iCall < iErr),
      'A-7d 远端调用落在 done 分支内（error 分支之后不再有它）', `done@${iDone} call@${iCall} err@${iErr}`);

    // 完成出口的 `checkParentTaskAfterChildDone` 之后紧随其后；失败路的 `afterRecord:` 之后 400 字符内**没有**它。
    const ai = src['core/jobs/ai-task.ts']!;
    const successCheck = [...ai.matchAll(/try \{ checkParentTaskAfterChildDone\([^\n]*\n?/g)].map((m) => m.index!);
    const failureCheck = [...ai.matchAll(/afterRecord: \(tid\) => checkParentTaskAfterChildDone/g)].map((m) => m.index!);
    ok(successCheck.length === 2 && failureCheck.length === 2, 'A-7e 两条成功出口 / 两条失败出口可定位',
      `成功 ${successCheck.length} 失败 ${failureCheck.length}`);
    ok(successCheck.every((i) => { const j = ai.indexOf('scheduleDependentDispatch(', i); return j > i && j - i < 400; }),
      'A-7f 两处成功出口：放行父任务后即放行依赖它的后继');
    ok(failureCheck.every((i) => { const j = ai.indexOf('scheduleDependentDispatch(', i); return j === -1 || j - i > 400; }),
      'A-7g 反证：两处失败出口之后 400 字符内无后继派发（失败不放行后继）');
  }

  // ═══ B-1 五类卡各一只真源标本 ═════════════════════════════════════════════
  console.log('\n【B-1】蒸馏来源 → 五类卡（术语/验收/配方/教训/坑）');
  {
    const db = mkCardDb();
    seedAllFiveKinds(db);
    const cands = deriveKnowledgeCardCandidates(db as never, PROJ);
    const kinds = new Set(cands.map((c) => c.kind));
    ok(KNOWLEDGE_CARD_KINDS.every((k) => kinds.has(k)),
      'B-1a 五类卡都能从既有事实派生（无空类）', [...kinds].join(','));
    const byKind = (k: string) => cands.filter((c) => c.kind === k);
    ok(byKind('term').some((c) => c.source === 'project_knowledge:domain') && byKind('term').some((c) => c.text.includes('SO')),
      'B-1b 术语取自知识册 domain 的真实行');
    ok(byKind('acceptance').some((c) => c.source === 'project_knowledge:criteria'),
      'B-1c 验收取自知识册 criteria');
    ok(byKind('recipe').some((c) => c.source === 'project_knowledge:recipes'),
      'B-1d 配方取自知识册 recipes');
    ok(byKind('recipe').some((c) => c.source === 'wa_deliverables' && c.text.startsWith('样板：月度对账单')),
      'B-1e 已归档产出物成为"样板"配方');
    ok(!cands.some((c) => c.text.includes('草稿报表')), 'B-1f 反证：draft 产出物不算"真的产出过"');
    const memSources = new Set(byKind('lesson').map((c) => c.source).concat(byKind('pitfall').map((c) => c.source)));
    ok(memSources.has('wa_memories:retrospective') && memSources.has('wa_memories:failure_knowledge'),
      'B-1g 教训/坑来自 retrospective / failure_knowledge 两类记忆', [...memSources].join(','));
    ok(byKind('pitfall').some((c) => c.text.includes('时区')), 'B-1h 坑的内容是记忆正文原句（不二次改写）');
  }

  // ═══ B-2 去重与排序 ══════════════════════════════════════════════════════
  console.log('\n【B-2】同输入必得同序；同键去重');
  {
    const db = mkCardDb();
    addMemory(db, 'm1', 'failure_knowledge', '同一句失败教训');
    addMemory(db, 'm2', 'failure_knowledge', '同一句失败教训');
    const cands = deriveKnowledgeCardCandidates(db as never, PROJ);
    eq(cands.length, 2, 'B-2a 派生层如实给两条候选（去重不是派生层的职责）');
    const planned = planKnowledgeCards(cands);
    eq(planned.length, 1, 'B-2b 计划层按 kind|source|text 去重为一张');
    const twice = planKnowledgeCards(deriveKnowledgeCardCandidates(db as never, PROJ));
    eq(twice, planned, 'B-2c 确定性：同输入两次计划逐字段相同（含顺序）');
  }

  // ═══ B-3 上限：单卡 60 / 每项目 24 / 单次 5 张 150 token ═════════════════
  console.log('\n【B-3】有界：单卡 ≤60 token、每项目 ≤24 张、单次 ≤5 张且 ≤150 token');
  {
    const db = mkCardDb();
    addMemory(db, 'long', 'failure_knowledge', '长'.repeat(CARD_MAX_TOKENS * TOKEN_CHARS_PER_UNIT * 2));
    const one = planKnowledgeCards(deriveKnowledgeCardCandidates(db as never, PROJ));
    ok(one.length === 1 && one[0]!.tokens <= CARD_MAX_TOKENS, 'B-3a 超长卡被截断到 ≤60 token', `tokens=${one[0]?.tokens}`);
    ok(one[0]!.text.endsWith('…'), 'B-3b 截断有痕（省略号），不静默丢字');
    ok(one[0]!.text.length <= CARD_MAX_TOKENS * TOKEN_CHARS_PER_UNIT, 'B-3c 截后字符数与同一分度自洽');

    const many = mkCardDb();
    for (let i = 0; i < 30; i++) addMemory(many, `m${i}`, 'failure_knowledge', `第 ${i} 条互不相同的失败教训`);
    eq(planKnowledgeCards(deriveKnowledgeCardCandidates(many as never, PROJ)).length, CARD_MAX_PER_PROJECT,
      'B-3d 每项目上限 24 张（截断而非无界堆积）');

    const card = (id: string, tokens: number): KnowledgeCard =>
      ({ id, projectId: PROJ, kind: 'term', text: id, source: 's', confidence: 0.5, tokens });
    eq(selectKnowledgeCardsForInject(Array.from({ length: 10 }, (_, i) => card(`c${i}`, 1)), null, '').length,
      CARD_INJECT_MAX_ITEMS, 'B-3e 单次最多 5 张');
    const heavy = Array.from({ length: 10 }, (_, i) => card(`h${i}`, 40));
    const picked = selectKnowledgeCardsForInject(heavy, null, '');
    eq([picked.length, picked.reduce((n, c) => n + c.tokens, 0)], [3, 120],
      'B-3f 装不下就跳过该张（3×40=120，第 4 张 160 越界）');
    ok(picked.reduce((n, c) => n + c.tokens, 0) <= CARD_INJECT_MAX_TOKENS, 'B-3g 入选总量不越 150 token');
  }

  // ═══ B-4 按任务形态/关键词选卡 ═══════════════════════════════════════════
  console.log('\n【B-4】选择器：形态亲和度 + 关键词重合（只调先后，不增不减）');
  {
    const mk = (id: string, kind: KnowledgeCard['kind'], text: string, confidence = 0.5): KnowledgeCard =>
      ({ id, projectId: PROJ, kind, text, source: 's', confidence, tokens: 4 });
    const recipe = mk('r1', 'recipe', '导出报表先查模板');
    const term = mk('t1', 'term', '订单域');
    eq(selectKnowledgeCardsForInject([term, recipe], 'code', '').map((c) => c.id), ['r1', 't1'],
      'B-4a 编码任务：配方优先于术语（与形态亲和表一致）');
    eq(selectKnowledgeCardsForInject([term, recipe], 'research', '').map((c) => c.id), ['t1', 'r1'],
      'B-4b 调研任务：术语优先（同一批卡换个顺序，不筛掉任何一张）');

    const plain = mk('x1', 'term', '报表口径说明');
    const hit = mk('x2', 'term', '对账时分单位换算');
    eq(selectKnowledgeCardsForInject([plain, hit], null, '对账 分单位').map((c) => c.id), ['x2', 'x1'],
      'B-4c 任务关键词重合者先入选（同一形态内加权重排）');
    eq(selectKnowledgeCardsForInject([plain, hit], null, '').length, 2, 'B-4d 无关键词时两卡仍在（不因没命中就丢）');
  }

  // ═══ B-5 Pro 闸：生成挂专业版，降档不回收、不再注入 ═════════════════════
  console.log('\n【B-5】Pro 闸：试用可蒸馏；社区零写入；降档卡仍在表里但不再注入');
  {
    ok((PRO_FEATURES as readonly string[]).includes(KNOWLEDGE_CARD_FEATURE)
      && PRO_FEATURE_LABEL[KNOWLEDGE_CARD_FEATURE].includes('知识卡'),
      'B-5a 能力已登记进 Pro 词表（唯一定义处，标签说人话）');
    ok(proFeatureRefusal(null, KNOWLEDGE_CARD_FEATURE) !== null, 'B-5b 无许可库 ⇒ 如实拒（fail-open 方向=锁能力不崩产品）');

    const pro = mkCardDb();
    // 生产初始化顺序：先 new MemoryManager（建 FTS 触发器）再插记忆行。
    const mm = new MemoryManager(pro as never, null as never);
    seedAllFiveKinds(pro);
    seedTrial(pro);
    eq(proFeatureRefusal(pro as never, KNOWLEDGE_CARD_FEATURE), null, 'B-5c 试用期内放行（试用＝专业版能力）');
    const r1 = distillKnowledgeCards(pro as never, PROJ);
    ok(r1.cards > 0, 'B-5d 试用蒸馏真写入', `cards=${r1.cards}`);
    const listed = listActiveKnowledgeCards(pro as never, PROJ);
    eq([listed.length, r1.cards], [r1.cards, listed.length], 'B-5e 落库张数与返回计数一致（账实相符）');
    eq(mm.listKnowledgeCards(PROJ).length, listed.length, 'B-5f 执行期读口在试用档如实给出卡');

    const r2 = distillKnowledgeCards(pro as never, PROJ);
    eq(r2.pruned, 0, 'B-5g 重蒸馏不误删（同输入同 key 走 upsert）');

    const before = count(pro, 'wa_knowledge_cards');
    seedCommunity(pro);
    const r3 = distillKnowledgeCards(pro as never, PROJ);
    eq([r3.cards, r3.promoted, r3.pruned], [0, 0, 0], 'B-5h 降档后蒸馏零写入零清理');
    eq(count(pro, 'wa_knowledge_cards'), before, 'B-5i ★降档不回收已生成的卡（表里一张不少）');
    eq(mm.listKnowledgeCards(PROJ), [], 'B-5j ★但读口按当前档拒绝注入（已带进来的知识不再进来）');

    const comm = mkCardDb();
    seedAllFiveKinds(comm);
    seedCommunity(comm);
    eq(distillKnowledgeCards(comm as never, PROJ), { cards: 0, promoted: 0, pruned: 0 }, 'B-5k 社区档蒸馏直接返零');
    eq(count(comm, 'wa_knowledge_cards'), 0, 'B-5l 社区档不写库（连一张也不落）');
  }

  // ═══ B-6 验收失败：只生成 pending，下次蒸馏并入 ═════════════════════════
  console.log('\n【B-6】失败教训只生成不自动生效：pending → 下次蒸馏才 active');
  {
    const db = mkCardDb();
    seedTrial(db);
    eq(recordPitfallCandidate(db as never, PROJ, { taskTitle: '导出对账单', failedItems: '列名不符' }), true,
      'B-6a 验收失败落一张候选卡');
    const row = getOne<{ status: string; kind: string; source: string }>(db,
      'SELECT status, kind, source FROM wa_knowledge_cards WHERE project_id = ?', PROJ);
    eq([row?.status, row?.kind, row?.source], ['pending', 'pitfall', 'acceptance_check'],
      'B-6b 状态机起点 pending（未检验的证据不当知识）');
    eq(listActiveKnowledgeCards(db as never, PROJ).length, 0, 'B-6c pending 不进注入面');
    eq(recordPitfallCandidate(db as never, PROJ, { taskTitle: '导出对账单', failedItems: '列名不符' }), true,
      'B-6d 同任务同因重犯仍报"写/更新了一行"');
    eq(count(db, 'wa_knowledge_cards'), 1, 'B-6e 唯一键去重：同文本同源不越积越多');

    const d = distillKnowledgeCards(db as never, PROJ);
    eq(d.promoted, 1, 'B-6f 下次蒸馏把 pending 并入 active');
    eq(listActiveKnowledgeCards(db as never, PROJ).map((c) => c.kind), ['pitfall'], 'B-6g 并入后真进入注入面');

    const comm = mkCardDb();
    seedCommunity(comm);
    eq(recordPitfallCandidate(comm as never, PROJ, { taskTitle: 't', failedItems: 'x' }), false,
      'B-6h 社区档不生成候选卡');
    eq(count(comm, 'wa_knowledge_cards'), 0, 'B-6i 反证：社区档零写入');
  }

  // ═══ B-7 注入装配：卡进上下文且总预算不增 ═════════════════════════════════
  console.log('\n【B-7】buildMemoryContext：卡入文、逐卡留账、卡+画像+知识书合计 ≤ 原预算');
  {
    const db = mkCardDb();
    seedAllFiveKinds(db);
    seedTrial(db);
    distillKnowledgeCards(db as never, PROJ);
    addKnowledge(db, 'usage', Array.from({ length: 8 }, (_, i) => `- 常用手法 ${i}：先查后改`).join('\n'));
    const book = listProjectKnowledge(db as never, PROJ);
    const cards = listActiveKnowledgeCards(db as never, PROJ);
    const expected = selectKnowledgeCardsForInject(cards, null, '', CARD_INJECT_MAX_TOKENS);

    type Mem = Parameters<typeof buildMemoryContext>[0];
    const base = {
      listKnowledgeCards: () => cards,
      listProjectProfile: () => null,
      listDomainKnowledge: () => book,
      listAppliedDomainPacks: () => [],
      buildMemoryEffectivenessStats: () => [],
      buildExecutionPlaybook: () => ({}),
      retrieveByType: () => [],
      getProjectKnowledge: () => [],
      retrieveKnowledgeGraphContext: () => [],
      getTriggeredProspective: () => [],
      getWorkingMemory: () => [],
      retrieveUnknownHits: () => [],
      retrieveNegativeHits: () => [],
      findSimilarTasks: () => [],
      getTaskArchetype: () => null,
      getTaskText: () => '',
      recordInjection: () => { /* 装配用例不落记忆账（B-8 单独量写口） */ },
    };
    const ctx = buildMemoryContext(base as unknown as Mem, PROJ, undefined, undefined, null, undefined, 20000);
    ok(ctx.cardText.startsWith('## 项目知识卡'), 'B-7a 卡段真入文（有段标题）');
    ok(ctx.context.includes(ctx.cardText) && ctx.cardText.length > 0, 'B-7b 卡段确实落在上下文正文里');
    eq(ctx.cardInjections.map((x) => x.ref_id), expected.map((c) => c.id),
      'B-7c 逐卡留账与选择器同一次构造（不是解析文本猜边界）');
    const cardTok = estimateTokensFromChars(ctx.cardText.length);
    // 知识书的计量与选择器**同一把尺**（节正文长度），否则"渲染骨架"会让账面虚高。
    const bookCost = selectKnowledgeForInject(book, null, Math.max(0, KNOWLEDGE_INJECT_MAX_TOKENS - cardTok))
      .reduce((n, e) => n + estimateTokensFromChars(e.content.length), 0);
    ok(cardTok <= CARD_INJECT_MAX_TOKENS, 'B-7d 卡段自身 ≤150 token', `${cardTok}`);
    ok(cardTok + bookCost <= KNOWLEDGE_INJECT_MAX_TOKENS,
      'B-7e ★卡 + 知识书合计不超原 400 预算（总预算不增）', `${cardTok}+${bookCost}`);
    ok(ctx.knowledgeText.length > 0, 'B-7f 对照：卡没把知识书挤空（两者共存）');

    const off = buildMemoryContext(
      { ...base, listKnowledgeCards: () => [] } as unknown as Mem,
      PROJ, undefined, undefined, null, undefined, 20000,
    );
    eq([off.cardText, off.cardInjections], ['', []], 'B-7g 反证：无卡 ⇒ 零入文零记账');
    ok(off.knowledgeText.length > 0, 'B-7h 反证：无卡时知识书照常注入（闸不误伤）');
    ok(selectKnowledgeForInject(book, null, KNOWLEDGE_INJECT_MAX_TOKENS)
      .reduce((n, e) => n + estimateTokensFromChars(e.content.length), 0) <= KNOWLEDGE_INJECT_MAX_TOKENS,
      'B-7i 对照侧本身不超预算（判据可被合法数据满足）');
  }

  // ═══ B-8 注入账 0→1（逐卡一行）═══════════════════════════════════════════
  console.log('\n【B-8】注入账：knowledge_card 逐卡一行，唯一键幂等');
  {
    const db = mkCardDb();
    const mm = new MemoryManager(db as never, null as never);
    const before = count(db, 'wa_context_injections');
    const n1 = mm.recordContextInjections('t-card', { cards: [{ ref_id: 'kc-00000001', chars: 24 }] });
    eq([n1, count(db, 'wa_context_injections') - before], [1, 1], 'B-8a 计数器 0→1：恰写一行');
    const row = getOne<{ source: string; ref_id: string; chars: number }>(db,
      'SELECT source, ref_id, chars FROM wa_context_injections WHERE task_id = ?', 't-card');
    eq([row?.source, row?.ref_id, row?.chars], ['knowledge_card', 'kc-00000001', 24],
      'B-8b 行形状：source/ref_id（卡 id）/chars 都对得上');
    eq(mm.recordContextInjections('t-card', { cards: [{ ref_id: 'kc-00000001', chars: 24 }] }), 0,
      'B-8c 重放同卡零新增（唯一键幂等，resume 不重复记账）');
    eq(count(db, 'wa_context_injections'), before + 1, 'B-8d 反证：表里仍只有那一行');
  }

  // ═══ B-9 接线（静态：读去注释后的代码）═══════════════════════════════════
  console.log('\n【B-9】接线：蒸馏进 consolidate、失败落候选卡、卡段记账、预算公式一处');
  {
    const jobsSrc = STRIPPED(`${A}/src/main/core/jobs/index.ts`);
    eq([...jobsSrc.matchAll(/distillKnowledgeCards\(/g)].length, 1,
      'B-9a 夜间整合：恰一处真调用（每项目循环内，不散落）');
    ok(/import \{ distillKnowledgeCards \} from '\.\.\/knowledge-cards\.js'/.test(jobsSrc),
      'B-9a2 真源经模块导入（不在整合器里另写一份蒸馏）');
    ok(/totalCards \+= distillKnowledgeCards\(db, project_id\)\.cards/.test(jobsSrc),
      'B-9b 计数取真返回值（不是"调了就算"）');

    const execSrc = STRIPPED(`${A}/src/main/core/agent-executor.ts`);
    ok(/recordPitfallCandidate\(db, taskRow\.project_id, \{ taskTitle: taskRow\.title, failedItems \}\)/.test(execSrc),
      'B-9c 验收失败块真调候选卡写口（同一 taskRow 真源）');
    ok(/cards: cardRows/.test(execSrc) && /memoryCardText && !memTextAfterTrim\.includes\(memoryCardText\)/.test(execSrc),
      'B-9d 注入账：裁剪后回读记忆块，卡段被丢 ⇒ 零行');
    ok(/memoryCardText = built\.cardText/.test(execSrc) && /memoryCardInjections = built\.cardInjections/.test(execSrc),
      'B-9e 执行体接管 `built.cardText/cardInjections`（不另起一份卡来源）');

    const ctxSrc = STRIPPED(`${A}/src/main/core/memory-context.ts`);
    ok(/KNOWLEDGE_INJECT_MAX_TOKENS - profileTokens - cardTokens/.test(ctxSrc),
      'B-9f 预算公式一处：知识书余量 = 400 − 画像 − 卡');
    ok(/cardText: cardKept \? cardText : ''/.test(ctxSrc),
      'B-9g 卡段被预算整段省略 ⇒ 返回空（不记"注入过"的空账）');

    const dbSrc = RD(`${A}/src/main/database.ts`);
    ok(/CREATE TABLE IF NOT EXISTS wa_knowledge_cards/.test(dbSrc)
      && /CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_knowledge_cards_key ON wa_knowledge_cards\(project_id, kind, source, text\)/.test(dbSrc),
      'B-9h 建表 + 唯一键在册（迁移面就这一处）');
  }

  // ═══ C-1 渠道注册表 ═══════════════════════════════════════════════════════
  console.log('\n【C-1】渠道注册表：五渠道在册、协议归属按注册顺序、锁定档不列出');
  {
    const ids = listChannels().map((c) => c.id);
    eq(ids, ['lan', 'mqtt', 'homeassistant', 'tuya-cloud', 'mijia-miio'],
      'C-1a 内置五渠道（注册顺序即协议归属的解释权顺序）');
    eq(channelForProtocol('mqtt')?.id, 'mqtt', 'C-1b mqtt 归属 MQTT 网关（HA 未抢解释权）');
    eq(channelForProtocol('miio')?.id, 'mijia-miio', 'C-1c miio 归属米家渠道');
    eq(channelForProtocol('mdns')?.id, 'lan', 'C-1d mDNS 归属局域网渠道');
    eq(channelForProtocol('no-such-protocol' as never), null, 'C-1e 无人认领的协议如实回 null（不猜）');

    const hit = resolveChannel('mijia-miio');
    ok(hit.ok && hit.channel.label.includes('米家'), 'C-1f resolveChannel 取到真渠道');
    const miss = resolveChannel('no-such-channel');
    ok(!miss.ok && miss.reason.includes('no-such-channel'), 'C-1g 未注册渠道如实拒且带名', miss.ok ? '' : miss.reason);

    eq(listOnboardingChannels({ teamUnlocked: true }).map((c) => c.id), ids, 'C-1h 解锁档五条全列');
    eq(listOnboardingChannels({ teamUnlocked: false }), [], 'C-1i 锁定档一条不列（不是灰着）');

    const free: DeviceChannel = {
      id: 'tmp-free', label: '免费演示渠道', kind: 'lan', requires: 'none',
      protocols: [], teamFeatures: [], summary: '演示', settingsKeys: [], credentialKeys: [],
      configKeys: [], capabilities: { discover: true, control: false, state: false },
    };
    registerChannel(free);
    eq(getChannel('tmp-free')?.id, 'tmp-free', 'C-1j 注册即生效（厂商可扩展，不必改注册表文件）');
    eq(listOnboardingChannels({ teamUnlocked: false }).map((c) => c.id), ['tmp-free'],
      'C-1k 免费渠道锁定档仍出现（反证：过滤的是档位不是"内置清单"）');
    unregisterChannel('tmp-free');
    eq(getChannel('tmp-free'), null, 'C-1l 注销后取不到（下次启动内置渠道自动恢复）');
    eq(listChannels().map((c) => c.id), ids, 'C-1m 反证：注销不误伤内置渠道');
  }

  // ═══ C-2 渠道预检 ═════════════════════════════════════════════════════════
  console.log('\n【C-2】渠道预检：档位 → 凭据 → token（缺什么说什么）');
  {
    const lan = getChannel('lan')!;
    const mqtt = getChannel('mqtt')!;
    const miio = getChannel('mijia-miio')!;
    eq(authorizeChannel(lan, { teamUnlocked: true }), { ok: true }, 'C-2a 无前置渠道直接放行');
    const noCred = authorizeChannel(mqtt, { teamUnlocked: true });
    ok(!noCred.ok && noCred.reason.includes('凭据'), 'C-2b 缺凭据 ⇒ 点名"凭据"', noCred.ok ? '' : noCred.reason);
    eq(authorizeChannel(mqtt, { teamUnlocked: true, hasCredentials: true }), { ok: true },
      'C-2c 凭据齐 ⇒ 放行（同一渠道的另一只标本）');
    const noToken = authorizeChannel(miio, { teamUnlocked: true });
    ok(!noToken.ok && noToken.reason.includes('token'), 'C-2d 缺 token ⇒ 点名 token', noToken.ok ? '' : noToken.reason);
    eq(authorizeChannel(miio, { teamUnlocked: true, hasToken: true }), { ok: true }, 'C-2e token 在 ⇒ 放行');
    const locked = authorizeChannel(mqtt, { teamUnlocked: false, hasCredentials: true });
    ok(!locked.ok && locked.reason.includes('团队版'),
      'C-2f 档位最先判：凭据齐也拒，且说清是"团队版"（不是"配置错误"）', locked.ok ? '' : locked.reason);
  }

  // ═══ C-3 miIO 包编解码 ════════════════════════════════════════════════════
  console.log('\n【C-3】miIO 包编解码：魔数/长度/校验三关 + 零填充往返');
  {
    const TOKEN = '0123456789abcdef0123456789abcdef'; //gitleaks:allow（合成夹具，非凭据）
    const packet = encodeMiioPacket({
      deviceId: 0x1234, stamp: 1_700_000_000, token: TOKEN,
      payload: { id: 7, method: 'get_status', params: [] },
    });
    eq([packet.readUInt16LE(0), packet.readUInt16LE(2), packet.readUInt32LE(8)],
      [MIIO_MAGIC, packet.length, 0x1234], 'C-3a 包头：魔数 0x2131 / 长度 = 实长 / did');
    const dec = decodeMiioPacket(packet, TOKEN);
    eq(dec.ok ? [dec.deviceId, dec.stamp, (dec.payload as { id?: number }).id, (dec.payload as { method?: string }).method] : null,
      [0x1234, 1_700_000_000, 7, 'get_status'], 'C-3b 同 token 往返：did/stamp/id/method 逐项相等');
    eq(encodeMiioPacket({ token: TOKEN, stamp: 1, payload: null }).length, 32,
      'C-3c 无载荷包恰 32 字节（16 头 + 16 校验）——hello 形态');
    const even = encodeMiioPacket({ token: TOKEN, stamp: 1, payload: { id: 1, m: 'abcdefghij' } });
    ok(even.length % 16 === 0, 'C-3d 密文体按 16 字节块对齐（零填充，非 PKCS#7）', `${even.length} 字节`);

    const tampered = Buffer.from(packet); tampered[tampered.length - 1] ^= 0xff;
    const badSum = decodeMiioPacket(tampered, TOKEN);
    ok(!badSum.ok && badSum.error.includes('校验'), 'C-3e 改一字节 ⇒ 校验关拒', badSum.ok ? '' : badSum.error);
    const badTok = decodeMiioPacket(packet, 'f'.repeat(32));
    ok(!badTok.ok, 'C-3f 错 token ⇒ 拒（不把解出的脏字节当明文）', badTok.ok ? '意外通过' : badTok.error);
    const short = decodeMiioPacket(Buffer.alloc(10), TOKEN);
    ok(!short.ok && short.error.includes('不足'), 'C-3g 过短包 ⇒ 长度关拒', short.ok ? '' : short.error);
    const wrongLen = Buffer.from(packet); wrongLen.writeUInt16LE(packet.length + 4, 2);
    const lenRes = decodeMiioPacket(wrongLen, TOKEN);
    ok(!lenRes.ok && lenRes.error.includes('不符'), 'C-3h 声明长度不符 ⇒ 拒', lenRes.ok ? '' : lenRes.error);
    const badMagic = Buffer.from(packet); badMagic.writeUInt16LE(0x1234, 0);
    ok(!readMiioHeader(badMagic).ok, 'C-3i 非 miIO 包 ⇒ 魔数关拒');

    const hello = miioHelloPacket(1_700_000_001);
    const hh = readMiioHeader(hello);
    eq([hello.length, hh.ok ? hh.deviceId : -1, hh.ok ? hh.stamp : -1], [32, MIIO_UNKNOWN_DID, 1_700_000_001],
      'C-3j hello：32 字节、did 全 F、stamp 如实');

    const tokenOk = normalizeMiioToken('  0123456789ABCDEF0123456789ABCDEF  ');
    eq(tokenOk, '0123456789abcdef0123456789abcdef', 'C-3k token 归一：去空白 + 小写'); //gitleaks:allow（合成夹具，非凭据）
    eq(normalizeMiioToken('0123456789abcdef0123456789abcde'), null, 'C-3l 31 位 ⇒ null（不补零）');
    eq(normalizeMiioToken('z'.repeat(32)), null, 'C-3m 非十六进制 ⇒ null（不猜）');
  }

  // ═══ C-4 miIO 控制 ════════════════════════════════════════════════════════
  console.log('\n【C-4】miIO 控制：无 token 如实拒、动作词表、设备错误原样带出');
  {
    const TOKEN = '0123456789abcdef0123456789abcdef'; //gitleaks:allow（合成夹具，非凭据）
    const dev = miioDev();
    const noTok = await miioDeviceControl(dev, 'turn_on', {}, { tokenFor: () => null });
    ok(!noTok.ok && noTok.result.includes('token'), 'C-4a 无 token ⇒ 拒且点名 token', noTok.result);
    const badTok = await miioDeviceControl(dev, 'turn_on', {}, { tokenFor: () => 'xyz' });
    ok(!badTok.ok && badTok.result.includes('token'), 'C-4b 非法 token ⇒ 同一判据拒');

    const echo: MiioTransport = {
      async request({ packet }) {
        const d = decodeMiioPacket(packet, TOKEN);
        const id = d.ok ? (d.payload as { id?: number } | null)?.id : 0;
        return encodeMiioPacket({ token: TOKEN, stamp: 2, payload: { id, result: ['ok'] } });
      },
    };
    const okRes = await miioDeviceControl(dev, 'turn_on', {}, { tokenFor: () => TOKEN, transport: echo, stamp: 1, msgId: 9 });
    ok(okRes.ok && okRes.result.includes('set_power'), 'C-4c 成功回执：方法名原样回显', okRes.result);

    const unsupported = await miioDeviceControl(dev, 'explode', {}, { tokenFor: () => TOKEN, transport: echo });
    ok(!unsupported.ok && unsupported.result.includes(MIIO_ACTIONS[0]) && unsupported.result.includes('set'),
      'C-4d 不支持的动作 ⇒ 词表如实列出（不只说"失败"）', unsupported.result);

    const denied: MiioTransport = {
      async request({ packet }) {
        const d = decodeMiioPacket(packet, TOKEN);
        const id = d.ok ? (d.payload as { id?: number } | null)?.id : 0;
        return encodeMiioPacket({ token: TOKEN, stamp: 2, payload: { id, error: { code: -5001, message: '设备忙' } } });
      },
    };
    const refused = await miioDeviceControl(dev, 'turn_off', {}, { tokenFor: () => TOKEN, transport: denied });
    ok(!refused.ok && refused.result.includes('-5001') && refused.result.includes('设备忙'),
      'C-4e 设备 error ⇒ code/message 原样带出', refused.result);

    const junk: MiioTransport = { async request() { return Buffer.from('not-a-miio-packet'); } };
    const badReply = await miioDeviceControl(dev, 'turn_on', {}, { tokenFor: () => TOKEN, transport: junk });
    ok(!badReply.ok && badReply.result.includes('回包无效'), 'C-4f 回包不合协议 ⇒ 如实报"回包无效"', badReply.result);

    const boom: MiioTransport = { async request() { throw new Error('ECONNREFUSED'); } };
    const netErr = await miioDeviceControl(dev, 'turn_on', {}, { tokenFor: () => TOKEN, transport: boom });
    ok(!netErr.ok && netErr.result.includes('ECONNREFUSED'), 'C-4g 传输失败 ⇒ 原因上屏', netErr.result);

    setMiioTokenProvider((address) => (address === dev.address ? TOKEN : null));
    eq(currentMiioToken(dev.address), TOKEN, 'C-4h 注入的读口生效（IPC 解密后注入同一形态）');
    eq(currentMiioToken('10.0.0.9'), null, 'C-4i 未配置的设备回 null（不串 token）');
    setMiioTokenProvider(null);
    eq(currentMiioToken(dev.address), null, 'C-4j 清场后回 null');

    const blocked = await defaultDeviceControl(miioDev({ address: '8.8.8.8' }), 'turn_on', {});
    ok(!blocked.ok && blocked.result.includes('拒绝出站'), 'C-4k 选路层 SSRF：公网地址不出站（核的是设备本身）',
      blocked.result);
    const lanOk = await defaultDeviceControl(miioDev(), 'turn_on', {});
    ok(!lanOk.ok && lanOk.result.includes('token'), 'C-4l 私网地址过围栏 ⇒ 到 token 判据才拒（分支真接上了）',
      lanOk.result);
  }

  // ═══ C-5 miIO 状态 ════════════════════════════════════════════════════════
  console.log('\n【C-5】miIO 状态：get_status 优先、回落 get_prop、两问皆失败报因');
  {
    const TOKEN = '0123456789abcdef0123456789abcdef'; //gitleaks:allow（合成夹具，非凭据）
    const dev = miioDev();
    const noTok = await miioDeviceState(dev, { tokenFor: () => null });
    ok(!noTok.ok && String(noTok.error).includes('token'), 'C-5a 无 token ⇒ 如实拒（不伪造在线）', String(noTok.error));

    const mk = (alwaysError: boolean): { t: MiioTransport; calls: () => number } => {
      let n = 0;
      const t: MiioTransport = {
        async request({ packet }) {
          n += 1;
          const d = decodeMiioPacket(packet, TOKEN);
          const payload = (d.ok ? d.payload : null) as { id?: number; method?: string } | null;
          const id = payload?.id;
          const body = alwaysError || payload?.method === 'get_status'
            ? { id, error: { code: -1, message: '不支持' } }
            : { id, result: ['on'] };
          return encodeMiioPacket({ token: TOKEN, stamp: 2, payload: body });
        },
      };
      return { t, calls: () => n };
    };

    const fail = mk(true);
    const both = await miioDeviceState(dev, { tokenFor: () => TOKEN, transport: fail.t });
    ok(!both.ok && String(both.error).includes('get_status') && String(both.error).includes('get_prop'),
      'C-5b 两问皆失败 ⇒ 报因含两问（不编造状态）', String(both.error));
    eq(fail.calls(), 2, 'C-5c 反证：确实问了两问');

    const fallback = mk(false);
    const st = await miioDeviceState(dev, { tokenFor: () => TOKEN, transport: fallback.t });
    ok(st.ok && (st.state as { method?: string } | undefined)?.method === 'get_prop' && fallback.calls() === 2,
      'C-5d get_status 被拒 ⇒ 回落 get_prop（另一种问法，不是放弃）');

    const firstWorks: MiioTransport = {
      async request({ packet }) {
        const d = decodeMiioPacket(packet, TOKEN);
        const id = d.ok ? (d.payload as { id?: number } | null)?.id : 0;
        return encodeMiioPacket({ token: TOKEN, stamp: 2, payload: { id, result: [{ power: 'on' }] } });
      },
    };
    const fast = await miioDeviceState(dev, { tokenFor: () => TOKEN, transport: firstWorks });
    ok(fast.ok && (fast.state as { method?: string } | undefined)?.method === 'get_status',
      'C-5e get_status 成功即止（不多问第二问）');
  }

  // ═══ C-6 发现映射 ═════════════════════════════════════════════════════════
  console.log('\n【C-6】发现映射：did 入能力、端口缺省 54321、mDNS 无地址即 null');
  {
    const d = miioDiscovered({ address: '192.168.1.7', deviceId: 6699 });
    eq([d.protocol, d.port, d.address, d.controllable], ['miio', MIIO_PORT, '192.168.1.7', true],
      'C-6a 台账行形状：protocol/port/address/controllable');
    eq(d.capabilities, ['miio', 'miio:did:6699'], 'C-6b did 写进 capabilities（控制时填包头）');
    eq(d.name, '米家设备 00001a2b', 'C-6c 无名时用 did 十六进制（不冒充型号）');
    eq(miioDidOf({ capabilities: d.capabilities } as unknown as AnsDevice), 6699, 'C-6d 从能力解析 did');
    eq(miioDidOf({ capabilities: [] } as unknown as AnsDevice), MIIO_UNKNOWN_DID, 'C-6e 无 did ⇒ 占位全 F（不猜）');
    const m = miioMdnsToDiscovered({ name: '米家台灯', referer: { address: '192.168.1.8' } });
    eq(m && [m.protocol, m.address, m.port, (m.capabilities ?? []).includes('mdns')],
      ['miio', '192.168.1.8', MIIO_PORT, true], 'C-6f mDNS 服务 ⇒ 台账候选（来源标记 mdns）');
    eq(miioMdnsToDiscovered({ name: '无地址服务' }), null, 'C-6g 无地址 ⇒ null（不编一个地址）');
  }

  // ═══ C-7 凭据加密 ═════════════════════════════════════════════════════════
  console.log('\n【C-7】凭据加密：旧明文读一次即迁移、失败不丢数据、后端不可用即拒写');
  {
    /** 假后端：base64('f:<plain>')；`available` 可按标本切换。 */
    const fakeCipher = (available: boolean): SecretCipher => ({
      backend: 'rr-fake',
      get available() { return available; },
      encrypt(plain: string) { return Buffer.from(`f:${plain}`, 'utf8').toString('base64'); },
      decrypt(data: string) {
        const s = Buffer.from(data, 'base64').toString('utf8');
        if (!s.startsWith('f:')) throw new Error('坏密文');
        return s.slice(2);
      },
    });
    const raw = (db: DatabaseSync, key: string): string | undefined =>
      getOne<{ value: string }>(db, 'SELECT value FROM wa_settings WHERE key = ?', key)?.value;

    const db = mkdb();
    const KEY = 'device.mqtt.password';
    set(db, KEY, 'plain-old');
    initDeviceSecrets(fakeCipher(true));
    eq(secretCipherState(), { available: true, backend: 'rr-fake' }, 'C-7a 后端态可自述（不含凭据内容）');

    const r1 = readSecret(db, KEY);
    eq([r1.ok, r1.ok ? r1.value : null, r1.ok ? r1.migrated : null, r1.ok ? r1.encrypted : null],
      [true, 'plain-old', true, true], 'C-7b 旧明文：读出真值 + 当次完成迁移');
    ok(isEncryptedSecret(raw(db, KEY)), 'C-7c 盘上已变密文（同键原地改值，键不变）', raw(db, KEY)?.slice(0, 7));
    const r2 = readSecret(db, KEY);
    eq([r2.ok ? r2.value : null, r2.ok ? r2.migrated : null], ['plain-old', false],
      'C-7d 二次读：解出真值且不再迁移（迁移只发生一次）');

    const K2 = 'device.tuya.access_secret';
    set(db, K2, 'plain-keep');
    initDeviceSecrets({ ...fakeCipher(true), encrypt() { throw new Error('钥匙串被锁'); } });
    const rf = readSecret(db, K2);
    ok(rf.ok && rf.value === 'plain-keep' && !rf.migrated && String(rf.warning).includes('迁移失败'),
      'C-7e 迁移失败：旧值照常读出 + 如实告警');
    eq(raw(db, K2), 'plain-keep', 'C-7f 反证：盘上仍是原值（不丢数据、不改坏）');

    const K3 = 'device.miio.token.10.0.0.5';
    set(db, K3, 'plain-token');
    initDeviceSecrets(fakeCipher(false));
    eq(secretCipherState().available, false, 'C-7g 后端不可用态如实为 false');
    const legacy = readSecret(db, K3);
    ok(legacy.ok && legacy.value === 'plain-token' && String(legacy.warning).includes('不可用'),
      'C-7h 后端不可用：旧明文照常可用 + 告警（不阻断读）');
    const denied = writeSecret(db, K3, 'new-token');
    ok(!denied.ok && denied.error.includes('拒绝'), 'C-7i 后端不可用 ⇒ 写口拒绝（不悄悄退回明文）', denied.ok ? '' : denied.error);
    eq(raw(db, K3), 'plain-token', 'C-7j 反证：盘上未变');
    const cipherRead = readSecret(db, KEY);
    ok(!cipherRead.ok && cipherRead.reason.includes('不可用'), 'C-7k 读到密文但解不开 ⇒ ok:false（不当空值/明文）',
      cipherRead.ok ? '意外解出' : cipherRead.reason);
    ok(isEncryptedSecret(raw(db, KEY)), 'C-7l 反证：密文原样保留');

    initDeviceSecrets(fakeCipher(true));
    const TK = miioTokenSettingKey('192.168.1.50');
    eq(secretState(db, TK).hasValue, false, 'C-7m 写前 hasValue=false（计数器起点）');
    ok(writeSecret(db, TK, '0123456789abcdef0123456789abcdef').ok, 'C-7n 后端可用：写入成功'); //gitleaks:allow（合成夹具，非凭据）
    eq(secretState(db, TK), { hasValue: true, encrypted: true, cipherAvailable: true },
      'C-7o 写后 hasValue=true（0→1）且为密文');
    const back = readSecret(db, TK);
    eq(back.ok ? back.value : null, '0123456789abcdef0123456789abcdef', 'C-7p 读回明文一致（透明解密）'); //gitleaks:allow（合成夹具，非凭据）
    clearSecret(db, TK);
    eq(secretState(db, TK), { hasValue: false, encrypted: false, cipherAvailable: true }, 'C-7q 清除即删行');
    eq(readSecret(db, TK), { ok: true, value: '', encrypted: false, migrated: false }, 'C-7r 清后读回空值（未配置）');
    initDeviceSecrets(null);
    eq(secretCipherState(), { available: false, backend: 'none' }, 'C-7s 卸载后端后态如实为 none');
  }

  // ═══ C-8 密钥词表 ═════════════════════════════════════════════════════════
  console.log('\n【C-8】密钥词表：每设备 token 键由前缀规则命中');
  {
    ok(isSecretSettingKey('device.miio.token.192.168.1.5'), 'C-8a 设备地址结尾 `.5` 靠前缀命中（后缀规则够不着）');
    ok(isSecretSettingKey('device.mqtt.password'), 'C-8b MQTT 密码显式名单仍在册');
    ok(isSecretSettingKey('device.tuya.access_secret'), 'C-8c 涂鸦 Secret 在册');
    ok(!isSecretSettingKey('device.mqtt.broker'), 'C-8d 非密钥键不误伤（broker 要回显给界面）');
    ok(!isSecretSettingKey('device.miio.did'), 'C-8e 同前缀族的非凭据键不误伤（did 可回显）');
    ok(isSecretSettingKey('device.miio.token'), 'C-8f 裸 `device.miio.token` 也按后缀规则算密钥（宁可多挡）');
  }

  // ═══ C-9 接线（静态：读去注释后的代码）════════════════════════════════════
  console.log('\n【C-9】接线：三新 IPC 各一处、发现并联、装配次序、向导入口与四步在册');
  {
    const dIpc = STRIPPED(`${A}/src/main/ipc/devices.ipc.ts`);
    for (const ch of ['devices:channels', 'devices:channel_auth', 'devices:miio_token']) {
      eq([...dIpc.matchAll(new RegExp(`ipcMain\\.handle\\('${ch}'`, 'g'))].length, 1, `C-9a ${ch} 恰一处登记`);
    }
    ok(/const parts: DiscoveryIo\[\] = \[defaultDiscoveryIo\(\), mijiaMiioDiscoveryIo\(\)\]/.test(dIpc),
      'C-9b 发现并联：miIO 与 mDNS/SSDP/MQTT 同一轮（不是另起一个"仅米家"按钮）');
    ok(/setMiioTokenProvider\(\(address\) => \{/.test(dIpc), 'C-9c token 读口注入（地址 → 解密后的 token）');
    eq([...dIpc.matchAll(/data: secretState\(ddb, key\)/g)].length, 3,
      'C-9d miio_token 三态（写/清/只读）都只回"有没有/是不是密文"');
    ok(!/data: \{[^}]*\btoken\s*:/.test(dIpc), 'C-9e 反证：回包里没有任何 token 字段');
    ok(/const r = readSecret\(ddb, key\);/.test(dIpc), 'C-9f 设备设置读口透明解密');

    const adminSrc = STRIPPED(`${A}/src/main/ipc/admin.ipc.ts`);
    ok(/if \(isSecretSettingKey\(key\)\) \{[\s\S]{0,400}?writeSecret\(/.test(adminSrc),
      'C-9g 通用 settings:set 的密钥键也走加密写口（不只堵设备那一处）');

    const mainSrc = STRIPPED(`${A}/src/main/index.ts`);
    const iInit = mainSrc.indexOf('initDeviceSecrets(electronSecretCipher())');
    const iIpc = mainSrc.indexOf('initDevicesIpc(');
    ok(iInit > 0 && iIpc > iInit, 'C-9h 加密后端装配在设备 IPC 之前（否则首个读口先跑、迁移无从谈起）');
    eq([...mainSrc.matchAll(/initDeviceSecrets\(/g)].length, 1, 'C-9i 装配恰一处');

    const toolSrc = STRIPPED(`${A}/src/main/core/tools/device.ts`);
    ok(/if \(dev\.protocol === 'miio'\) \{\s*const refusal = lanAddressRefusal\(dev\.address\);/.test(toolSrc),
      'C-9j 选路：miIO 先核设备地址（与 HTTP 同一对象口径）');
    ok(/return miioDeviceControl\(dev, action, args\);/.test(toolSrc), 'C-9k 传动选路指向 miIO 实现');
    ok(/if \(dev\.protocol === 'miio'\) \{\s*const st = await miioDeviceState\(dev\);/.test(toolSrc),
      'C-9l device_status 的 miIO 分支走同一状态实现');

    const rIpc = STRIPPED(`${A}/renderer/src/lib/ipc.ts`);
    ok(/channels: \(\) => ipcCall<DeviceChannelsPayload>\('devices:channels'\)/.test(rIpc),
      'C-9m 渲染层通道名与 main 同名（channels）');
    ok(/channelAuth: \(channelId: string\) => ipcCall<DeviceChannelAuthPayload>\('devices:channel_auth', \{ channelId \}\)/.test(rIpc),
      'C-9n 渲染层通道名与 main 同名（channel_auth）');
    ok(/miioToken: \(address: string, token\?: string\) =>[\s\S]{0,160}'devices:miio_token'/.test(rIpc),
      'C-9o 渲染层通道名与 main 同名（miio_token）');

    const pageSrc = STRIPPED(`${A}/renderer/src/pages/DevicesPage.tsx`);
    ok(/import \{ DeviceOnboardingWizard \} from '\.\.\/components\/DeviceOnboardingWizard'/.test(pageSrc),
      'C-9p 页面真接线（不是建了文件没人用）');
    ok(/<DeviceOnboardingWizard/.test(pageSrc) && /onDone=\{\(\) => void q\.reload\(\)\}/.test(pageSrc),
      'C-9q 完成即重读台账');
    ok(/miio: '米家 miIO'/.test(pageSrc), 'C-9r 协议词表有 miio（renderer 是词表第二落点）');
    ok(/接入设备/.test(pageSrc), 'C-9s 入门入口按钮在册');

    const wizSrc = STRIPPED(`${A}/renderer/src/components/DeviceOnboardingWizard.tsx`);
    eq([...new Set([...wizSrc.matchAll(/devicesApi\.(\w+)\(/g)].map((m) => m[1]))].sort(),
      ['authorize', 'channelAuth', 'channels', 'cloudSync', 'discover', 'miioToken'],
      'C-9t 向导只经 IPC 真口（六个动作各在册）');
    ok(!/ipcRenderer|ipcCall\(/.test(wizSrc), 'C-9u 反证：向导不绕过 IPC 封装自拼通道');
    ok(/channel\.protocols\.includes\(d\.protocol\)/.test(wizSrc),
      'C-9v 设备行归属按渠道自述协议（界面不另写一份归属表）');
    eq([...wizSrc.matchAll(/const STEP_LABEL = \[([^\]]*)\]/g)].length, 1, 'C-9w 四步进度一处真源');
    ok(/const STEP_LABEL = \['选渠道', '接入方式', '勾选设备', '完成'\]/.test(wizSrc),
      'C-9x 四步文案按方案（选渠道 → 接法 → 设备 → 完成）');
    ok(/setTokens\(\(m\) => \(\{ \.\.\.m, \[address\]: '' \}\)\)/.test(wizSrc),
      'C-9y token 保存后清空输入框（密文不回显，界面不留明文字符串）');

    const pkg = JSON.parse(RD(`${A}/package.json`)) as { dependencies?: Record<string, string> };
    ok(Boolean(pkg.dependencies?.['bonjour-service']), 'C-9z mDNS 依赖在册（发现 `_miio._udp` 要用）');

    ok(/export type DeviceProtocol = 'mdns' \| 'ssdp' \| 'http' \| 'mqtt' \| 'cloud' \| 'miio'/.test(
      STRIPPED(`${A}/src/main/core/device-registry.ts`)), 'C-9aa 协议枚举含 miio（台账写入口在册）');
  }

  // ═══ D｜批四「现」：局域网 AI 终端发现（发现 ≠ 授权）══════════════════════════
  console.log('\n【D-1】浏览回调 → 待接入列表（30 秒即散）');
  {
    __resetLanPendingForTest();
    let clock = 1_800_000_000_000;
    let onFound: ((a: TerminalAnnouncement) => void) | null = null;
    const emitted: TerminalAnnouncement[] = [];
    const io: TerminalBrowseIo = {
      start(cb) { onFound = cb; },
      stop() { /* 停浏览：内存项由 __reset 清 */ },
    };
    startTerminalBrowse({ io, now: () => clock, onDiscovered: (item) => emitted.push(item as unknown as TerminalAnnouncement) });
    ok(isTerminalBrowseRunning(), 'D-1a 注入 IO 已起（running 如实）');

    const ann: TerminalAnnouncement = {
      name: 'pi-station',
      host: 'pi-station.local',
      port: 8787,
      addresses: ['192.168.1.20'],
      txt: { name: '书房的派单机', version: '1.2.0', caps: 'device_control,intent_control', token: 'SUPER-SECRET-TOKEN' },
    };
    const emit = (a: TerminalAnnouncement): void => { if (onFound) onFound(a); };
    emit(ann);
    const items = listLanPending(clock);
    eq(items.length, 1, 'D-1b 一条广播 ⇒ 待接入列表一项');
    eq(items[0]?.name, '书房的派单机', 'D-1c 名字取 TXT（自述优先于 service 名）');
    eq(items[0]?.address, '192.168.1.20', 'D-1d 地址取 addresses[0]');
    eq(items[0]?.port, 8787, 'D-1e 端口如实');
    eq(items[0]?.version, '1.2.0', 'D-1f 版本如实');
    eq(items[0]?.capabilities, ['device_control', 'intent_control'], 'D-1g 能力摘要（类目名）');
    ok(!JSON.stringify(items[0]).includes('SUPER-SECRET'), 'D-1h ★反证：TXT 里的 secret 值没有进待接入项');
    eq(emitted.length, 1, 'D-1i 发现即回调（面板不等轮询）');

    // 同一台再广播：id 稳定、firstSeen 不变、lastSeen 前进。
    clock += 5_000;
    emit({ ...ann, port: 8788 });
    const again = listLanPending(clock);
    eq(again[0]?.id, items[0]?.id, 'D-1j 同一台重复广播 ⇒ 同一 id（不重复列）');
    eq(again[0]?.firstSeenMs, items[0]?.firstSeenMs, 'D-1k firstSeen 保持第一次');
    eq(again[0]?.lastSeenMs, clock, 'D-1l lastSeen 随广播前进');
    eq(again[0]?.port, 8788, 'D-1m 端口随最新广播更新');

    // 30 秒过期（两只标本：29 秒在、30 秒过即散）。
    clock += LAN_PENDING_TTL_MS - 5_000;
    eq(listLanPending(clock).length, 1, 'D-1n 未满 30 秒仍在列');
    clock += 5_001;
    eq(listLanPending(clock).length, 0, 'D-1o ★30 秒无广播自动移除');

    // 无地址 ⇒ 不列（看不见就不假装看见）。
    __resetLanPendingForTest();
    eq(ingestLanAnnouncement({ name: 'no-addr', txt: { name: 'x' } }, clock), null, 'D-1p 反证：无地址不列');
  }

  console.log('\n【D-2】TXT 白名单（只放名称/版本/能力类目，不进密钥）');
  {
    eq([...TERMINAL_TXT_ALLOWED_KEYS], ['name', 'version', 'caps'], 'D-2a TXT 白名单恰三键');
    const s = sanitizeTerminalTxt({
      name: '终端甲', version: '2.0', caps: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      token: 'T0KEN', secret: 'S3CRET', signature: 'SIG',
    });
    eq(s.name, '终端甲', 'D-2b name 收敛');
    eq(s.version, '2.0', 'D-2c version 收敛');
    eq(s.capabilities.length, 8, 'D-2d caps 上限 8 项');
    ok(s.stripped.includes('token(credential-like)') && s.stripped.includes('secret(credential-like)'),
      'D-2e ★凭据样键被丢弃且记名', s.stripped.join(','));
    ok(!JSON.stringify(s).includes('T0KEN') && !JSON.stringify(s).includes('S3CRET'),
      'D-2f ★反证：返回值里没有密钥值');
    eq(sanitizeTerminalTxt({ name: Buffer.from('x') }).name, null, 'D-2g 非字符串值不当名字');
    eq(sanitizeTerminalTxt(undefined).capabilities, [], 'D-2h 无 TXT ⇒ 空能力（不编）');
  }

  console.log('\n【D-3】24 小时静默（拒绝后不再出现；到期自动解除）');
  {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE wa_lan_terminal_silence (
      identity TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, silenced_until INTEGER NOT NULL
    )`);
    const now = 1_800_000_000_000;
    const t = { name: '吵闹终端', address: '192.168.1.33' };
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_lan_terminal_silence').get() as { c: number }).c, 0,
      'D-3a 触点前 0 行（0 起点）');
    silenceLanTerminal(db, t, now);
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_lan_terminal_silence').get() as { c: number }).c, 1,
      'D-3b ★0→1：拒绝写入一行静默');
    ok(isLanTerminalSilenced(db, t, now + LAN_SILENCE_MS - 1), 'D-3c 23:59:59.999 仍静默');
    eq(ingestLanAnnouncement({ name: 'x', addresses: ['192.168.1.33'], txt: { name: '吵闹终端' } }, now,
      { isSilenced: (it) => isLanTerminalSilenced(db, it, now) }), null, 'D-3d ★静默期广播不再进列表');
    ok(!isLanTerminalSilenced(db, t, now + LAN_SILENCE_MS + 1), 'D-3e 满 24 小时后解除');
    eq(pruneLanSilences(db, now + LAN_SILENCE_MS + 1), 1, 'D-3f 过期静默被清（表不只增不减）');
    eq((db.prepare('SELECT COUNT(*) AS c FROM wa_lan_terminal_silence').get() as { c: number }).c, 0,
      'D-3g ★1→0：清理后没有残留');
    db.close();
  }

  console.log('\n【D-4】接入即配对：source=lan、核对码、钥匙只回一次、未批准被拒');
  {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE wa_external_terminals (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      pair_code TEXT NOT NULL, key_prefix TEXT, secret_hash TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]', last_remote_addr TEXT, last_seen_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), approved_at TEXT, revoked_at TEXT,
      delivered_at TEXT, grant_expires_at TEXT, source TEXT DEFAULT 'remote'
    )`);
    const r = createPairRequestGuarded(db, '书房的派单机', '192.168.1.20', { source: 'lan' });
    ok(r.ok, 'D-4a 局域网发现可转成待批申请');
    if (r.ok) {
      eq(listPendingTerminals(db)[0]?.source, 'lan', 'D-4b ★来源如实记 lan（面板/IM 据此说明来由）');
      eq(getTerminalBrief(db, r.pairingId)?.source, 'lan', 'D-4c getTerminalBrief 读出来源');
      ok(/来自局域网发现/.test(buildPairNotice({ name: '书房的派单机', pairCode: r.pairCode, source: 'lan' })),
        'D-4d IM 通知写明"来自局域网发现"');
      ok(!/来自局域网发现/.test(buildPairNotice({ name: 'x', pairCode: '000000' })),
        'D-4e 反证：终端自己敲门的通知不冒充局域网');

      const st1 = pairStatus(db, r.pairingId, r.pairCode);
      ok(st1.status === 'pending' && !('credentials' in st1), 'D-4f 批准前无凭据');
      eq(approveTerminal(db, r.pairingId, ['device_control']).ok, true, 'D-4g 用户批准');
      const st2 = pairStatus(db, r.pairingId, r.pairCode);
      const cred = st2.status === 'approved' ? st2.credentials : undefined;
      ok(!!cred?.key && !!cred?.secret, 'D-4h 首次轮询拿到钥匙');
      const st3 = pairStatus(db, r.pairingId, r.pairCode);
      eq(st3.status === 'approved' ? ('credentials' in st3) : true, false, 'D-4i ★钥匙只回一次（第二次不再回）');
      if (cred) {
        const v = verifyTerminal(db, cred.key, cred.secret);
        ok(v.ok && v.terminal.capabilities.includes('device_control'), 'D-4j 凭据可用且能力面如实');
        // 未批准/已吊销 ⇒ 403（能力调不动）；不认识 key ⇒ 401（都不是 oracle）。
        const rev = db.prepare('UPDATE wa_external_terminals SET status = ? WHERE id = ?').run('revoked', r.pairingId);
        ok(Number(rev.changes) === 1, 'D-4k 夹具：改吊销 1 行');
        const v2 = verifyTerminal(db, cred.key, cred.secret);
        ok(!v2.ok && v2.status === 403, 'D-4l ★反证：已吊销终端调用被 403 拒');
      }
      const v3 = verifyTerminal(db, 'wt_00000000', 'x');
      ok(!v3.ok && v3.status === 401, 'D-4m 不认识的 key 401（未批准者连门都过不了）');
    }
    // 同一地址待批上限沿用既有闸（不因"局域网来的"放宽）。
    const many = [1, 2, 3].map((i) => createPairRequestGuarded(db, `t${i}`, '10.0.0.9', { source: 'lan' }));
    const over = createPairRequestGuarded(db, 't4', '10.0.0.9', { source: 'lan' });
    ok(many.every((x) => x.ok) && !over.ok && over.reason === 'too_many_pending',
      'D-4n 同址待批上限仍生效（发现来的不享受特权）');
    db.close();
  }

  console.log('\n【D-5】取走即出列（接入后归配对流程，不再留在发现列表）');
  {
    __resetLanPendingForTest();
    const now = 1_800_000_000_000;
    const item = ingestLanAnnouncement({ name: 's', addresses: ['192.168.9.9'], txt: { name: '终端乙' } }, now);
    ok(!!item, 'D-5a 先有一项');
    if (item) {
      eq(takeLanPending(item.id, now)?.name, '终端乙', 'D-5b 取走回原项');
      eq(listLanPending(now).length, 0, 'D-5c 取走后不在列表');
      eq(takeLanPending(item.id, now), null, 'D-5d 二次取走为 null（不重复接入）');
      const stale = ingestLanAnnouncement({ name: 's', addresses: ['192.168.9.9'], txt: { name: '终端乙' } }, now);
      eq(takeLanPending(stale?.id ?? '', now + LAN_PENDING_TTL_MS + 1), null, 'D-5e 过期项取不走');
    }
    stopTerminalBrowse();
    ok(!isTerminalBrowseRunning(), 'D-5f 停浏览后 running 如实转假');
  }

  console.log('\n【D-6】接线（静态：读去注释后的代码）');
  {
    const extIpc = STRIPPED(`${A}/src/main/ipc/external.ipc.ts`);
    for (const ch of ['external:lanList', 'external:lanRequest', 'external:lanIgnore']) {
      eq([...extIpc.matchAll(new RegExp(`ipcMain\\.handle\\('${ch}'`, 'g'))].length, 1, `D-6a ${ch} 恰一处登记`);
    }
    ok(/createPairRequestGuarded\(tdb, item\.name, item\.address, \{ source: 'lan' \}\)/.test(extIpc),
      'D-6b 接入走既有配对编排（不另写一份状态机）');
    ok(/silenceLanTerminal\(sdb, \{ name: brief\.name, address: brief\.address \}\)/.test(extIpc),
      'D-6c 拒绝局域网终端 ⇒ 写静默名单');
    ok(/teamFeatureRefusal\(licDb, 'external_terminal'\)/.test(extIpc), 'D-6d Team 闸在（发现/接入都是 Team）');
    ok(/LAN_SILENCE_MS/.test(extIpc), 'D-6e 静默时长由模块单源派生（不在 IPC 手抄数）');

    const mainSrc = STRIPPED(`${A}/src/main/index.ts`);
    ok(/stopTerminalBrowse\(\)/.test(mainSrc), 'D-6f 退出口收浏览器（与设备发现同生命周期）');

    const rIpc = STRIPPED(`${A}/renderer/src/lib/ipc.ts`);
    for (const ch of ['external:lanList', 'external:lanRequest', 'external:lanIgnore']) {
      ok(rIpc.includes(`'${ch}'`), `D-6g 渲染层通道名与 main 同名（${ch}）`);
    }
    const peers = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/externalApi\.lanList\(\)/.test(peers) && /externalApi\.lanRequest\(/.test(peers) && /externalApi\.lanIgnore\(/.test(peers),
      'D-6h 页面真接线（列表/接入/忽略三动作都可达）');
    ok(/liveTypes: \['external\.lan_changed'/.test(peers), 'D-6i 发现即上屏（订阅瞬态事件）');
    ok(/p\.source === 'lan'/.test(peers), 'D-6j 待批行标出来源（局域网发现）');

    const dbSrc = STRIPPED(`${A}/src/main/database.ts`);
    ok(/ALTER TABLE wa_external_terminals ADD COLUMN source TEXT DEFAULT 'remote'/.test(dbSrc),
      'D-6k 来路列有迁移（老库可升）');
    ok(/CREATE TABLE IF NOT EXISTS wa_lan_terminal_silence/.test(dbSrc), 'D-6l 静默表在建库脚本里');

    ok(LAN_TERMINAL_SERVICE_TYPE === 'workerant-terminal' && LAN_TERMINAL_SERVICE_TYPE !== INBOUND_MDNS_SERVICE,
      'D-6m 浏览的服务名与工蚁自身广播区分', `${LAN_TERMINAL_SERVICE_TYPE} vs ${INBOUND_MDNS_SERVICE}`);
    const lanSrc = STRIPPED(`${A}/src/main/core/lan-terminals.ts`);
    ok(/find\(\{ type: LAN_TERMINAL_SERVICE_TYPE \}\)/.test(lanSrc), 'D-6n 浏览用常量（服务名一处真源）');
    ok(/await import\('bonjour-service'\)/.test(lanSrc), 'D-6o 真网络惰性加载（rr 不触网）');
  }

  // ═══ E｜能力绑档 + 云端权益契约（批五）═══════════════════════════════════════
  console.log('\n【E-1】权益契约词表（shared-types：档位与序秩一处真源）');
  {
    eq([...ENTITLEMENT_TIER_ORDER], ['community', 'pro', 'team'], 'E-1a 权益档位恰三档（顺序派生自 LICENSE_TIERS）');
    ok(
      entitlementTierRank('community') < entitlementTierRank('pro')
        && entitlementTierRank('pro') < entitlementTierRank('team'),
      'E-1b 序秩严格递增（合并"只升不降"的判据本体）',
    );
    ok(isEntitlementTier('pro') && isEntitlementTier('team') && !isEntitlementTier('enterprise') && !isEntitlementTier(3),
      'E-1c 未知档位一律不收（反证：脏值不冒充合法档）');
  }

  console.log('\n【E-2】ANS 判据：resolveEntitlement 三态 + issueEntitlement 写口闸');
  {
    // 照抄 `apps/ans-server/src/db/schema.ts` 的 ans_entitlements 真 DDL（NOT NULL/唯一索引一并照抄）。
    const ENTITLEMENT_SCHEMA = `
      CREATE TABLE ans_entitlements (
        id TEXT PRIMARY KEY, key_prefix TEXT NOT NULL, tier TEXT NOT NULL,
        limits_json TEXT NOT NULL DEFAULT '{}', features_json TEXT NOT NULL DEFAULT '[]',
        seats INTEGER NOT NULL DEFAULT 1, expires_at TEXT, signature TEXT NOT NULL DEFAULT '',
        note TEXT DEFAULT '', status TEXT DEFAULT 'active',
        issued_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_ans_entitlements_key ON ans_entitlements(key_prefix);
    `;
    const edb = new DatabaseSync(':memory:');
    edb.exec(ENTITLEMENT_SCHEMA);
    const now = new Date('2026-10-23T12:00:00.000Z');
    const KEY = 'KEY-ABCDEFGH';

    const noneRow = resolveEntitlement(edb, KEY, now);
    eq(noneRow.source, 'none', 'E-2a 无行 ⇒ 未签发');
    eq(noneRow.tier, 'community', 'E-2b 未签发档位为社区（不是"猜一个"）');
    eq(resolveEntitlement(edb, 'SHORT', now).source, 'none', 'E-2c 前缀过短不当查询键（防误命中）');
    eq(resolveEntitlement(null, KEY, now).source, 'none', 'E-2d 无库 ⇒ 未签发（fail-open）');

    const issued = issueEntitlement(edb, {
      keyPrefix: KEY, tier: 'pro', signature: 'sig-1',
      limits: { maxProjectConcurrency: 8, maxProjects: 0, maxMembers: 1, maxNodes: 1 },
      features: ['knowledge_cards'], seats: 2,
      expiresAt: '2027-01-01T00:00:00.000Z', now,
    });
    ok(issued.ok, 'E-2e 合法签发成功', issued.detail);
    const cloud = resolveEntitlement(edb, KEY, now);
    eq(cloud.source, 'cloud', 'E-2f 有行且有效 ⇒ 云端生效');
    eq(cloud.tier, 'pro', 'E-2g 档位如实');
    eq(cloud.limits, { maxProjectConcurrency: 8, maxProjects: 0, maxMembers: 1, maxNodes: 1 }, 'E-2h 上限逐项解出');
    eq(cloud.features, ['knowledge_cards'], 'E-2i 能力清单解出');
    eq(cloud.seats, 2, 'E-2j 席位数解出');
    eq(cloud.signature, 'sig-1', 'E-2k 签名随回包（客户端不验签——边界见方案 §2.10）');
    eq(resolveEntitlement(edb, `  ${KEY}  `, now).tier, 'pro', 'E-2l 前缀两端空白被收窄（同一把尺）');

    const expired = resolveEntitlement(edb, KEY, new Date('2027-02-01T00:00:00.000Z'));
    eq(expired.source, 'expired', 'E-2m 到期 ⇒ 如实报 expired（不是 none）');
    eq(expired.tier, 'community', 'E-2n 到期后档位回落社区');
    eq(expired.expires_at, '2027-01-01T00:00:00.000Z', 'E-2o 到期时刻带回（界面上屏用）');

    // 脏值不撒谎：非法档位 ⇒ none；坏 limits JSON ⇒ 不据此缩权。
    edb.prepare(
      "INSERT INTO ans_entitlements (id,key_prefix,tier,limits_json,features_json,seats,signature,status) VALUES ('x1','KEY-DIRTY-1','enterprise','{}','[]',1,'s','active')",
    ).run();
    eq(resolveEntitlement(edb, 'KEY-DIRTY-1', now).source, 'none', 'E-2p 非法档位 ⇒ 未签发（脏值不冒充）');
    edb.prepare(
      "INSERT INTO ans_entitlements (id,key_prefix,tier,limits_json,features_json,seats,signature,status) VALUES ('x2','KEY-DIRTY-2','pro','{not json','[\"a\",2]',1,'s','active')",
    ).run();
    const dirtyLimits = resolveEntitlement(edb, 'KEY-DIRTY-2', now);
    eq(dirtyLimits.limits, {}, 'E-2q 坏上限 JSON ⇒ 不据此缩权');
    eq(dirtyLimits.features, ['a'], 'E-2r 能力清单里的非字符串被剔除');
    edb.prepare("UPDATE ans_entitlements SET status='disabled' WHERE key_prefix='KEY-DIRTY-2'").run();
    eq(resolveEntitlement(edb, 'KEY-DIRTY-2', now).source, 'none', 'E-2s 停用行 ⇒ 未签发');

    // 写口闸：三样缺一即拒（不是 HTTP 入口，运维直落库仍可能——那是边界，不是本闸的承诺）。
    const badTier = issueEntitlement(edb, { keyPrefix: 'KEY-BAD-01', tier: 'enterprise', signature: 's', now });
    ok(!badTier.ok && badTier.detail.includes('档位不合法'), 'E-2t 非法档位拒签');
    const shortKey = issueEntitlement(edb, { keyPrefix: 'SHORT', tier: 'pro', signature: 's', now });
    ok(!shortKey.ok && shortKey.detail.includes('至少 8 位'), 'E-2u 前缀过短拒签');
    const noSig = issueEntitlement(edb, { keyPrefix: 'KEY-NOSIG-1', tier: 'pro', signature: '', now });
    ok(!noSig.ok && noSig.detail.includes('签名'), 'E-2v 缺签名拒签（签发口不许"裸行"）');

    const up = issueEntitlement(edb, { keyPrefix: KEY, tier: 'team', signature: 'sig-2', seats: 3, now });
    ok(up.ok, 'E-2w 同前缀再签发成功', up.detail);
    eq(resolveEntitlement(edb, KEY, now).tier, 'team', 'E-2x 再签发为覆盖（升档生效）');
    eq(count(edb, 'ans_entitlements'), 3, 'E-2y 覆盖不增行（唯一键在前缀；被拒的三次签发不留行）');
  }

  console.log('\n【E-3】桌面缓存纯逻辑（收窄 / 读写 / 时效 / 只升不降）');
  {
    const db = mkdb();
    const ent: AnsEntitlement = {
      tier: 'team',
      limits: { maxProjectConcurrency: 16, maxProjects: 0, maxMembers: 1, maxNodes: 20 },
      features: ['audit_view'],
      seats: 2,
      expires_at: '2027-01-01T00:00:00.000Z',
      issued_at: '2026-10-01T00:00:00.000Z',
      signature: 'sig',
      source: 'cloud',
    };
    eq(parseCloudEntitlement(ent), ent, 'E-3a 合规回包逐字段收窄（不增不减）');
    eq(parseCloudEntitlement({ ...ent, tier: 'enterprise' }), null, 'E-3b 非法档位整包拒收');
    eq(parseCloudEntitlement({ ...ent, source: 'bogus' }), null, 'E-3c 非法来源整包拒收');
    eq(parseCloudEntitlement('not-object'), null, 'E-3d 非对象如实拒收');
    const cleaned = parseCloudEntitlement({
      tier: 'pro', source: 'cloud', seats: 0,
      limits: { maxProjects: -1, maxMembers: 2.9, junk: 5 },
      features: ['a', 2, 'b'],
    });
    eq(cleaned?.limits, { maxMembers: 2 }, 'E-3e 负数丢弃、小数取整、未列键丢弃');
    eq(cleaned?.features, ['a', 'b'], 'E-3f 能力清单只留字符串');
    eq(cleaned?.seats, 1, 'E-3g 席位下限 1');
    eq(cleaned?.expires_at, null, 'E-3h 缺到期时刻 ⇒ 永久（null）');

    const cache: CloudEntitlementCache = {
      fetchedAt: '2026-10-23T00:00:00.000Z', entitlement: ent, lastError: null, lastErrorAt: null,
    };
    ok(writeCloudEntitlementCache(db, cache), 'E-3i 缓存写入成功');
    eq(readCloudEntitlementCache(db), cache, 'E-3j 读回逐字段相同');

    set(db, CLOUD_ENTITLEMENT_SETTING_KEY, '{not json');
    eq(readCloudEntitlementCache(db), null, 'E-3k 坏 JSON ⇒ 当没有（fail-open）');

    const failOnly: CloudEntitlementCache = {
      fetchedAt: null, entitlement: null, lastError: '网络不可达', lastErrorAt: '2026-10-23T00:00:00.000Z',
    };
    writeCloudEntitlementCache(db, failOnly);
    eq(readCloudEntitlementCache(db), failOnly, 'E-3l 从未成功也留失败账（界面能说"不可达·原因"）');
    eq(cloudActiveTier(db), null, 'E-3m 只有失败账 ⇒ 无云端档位');

    set(db, CLOUD_ENTITLEMENT_SETTING_KEY, JSON.stringify({
      fetchedAt: null, entitlement: ent, lastError: null, lastErrorAt: null,
    }));
    eq(readCloudEntitlementCache(db), null, 'E-3n 有权益却无取得时刻 = 坏行');

    const later = new Date('2026-12-31T00:00:00.000Z');
    ok(isCloudEntitlementActive(ent, later), 'E-3o 未到期有效');
    ok(!isCloudEntitlementActive(ent, new Date('2027-01-02T00:00:00.000Z')), 'E-3p 过期即失效（读侧再判一次）');
    ok(!isCloudEntitlementActive({ ...ent, source: 'expired' }, later), 'E-3q 非 cloud 来源不生效');
    ok(!isCloudEntitlementActive({ ...ent, expires_at: '不是时刻' }, later), 'E-3r 到期字段非法 ⇒ 不生效（不猜）');
    ok(isCloudEntitlementActive({ ...ent, expires_at: null }, later), 'E-3s 永久权益有效');

    writeCloudEntitlementCache(db, {
      fetchedAt: '2026-01-01T00:00:00.000Z',
      entitlement: { ...ent, expires_at: '2026-06-01T00:00:00.000Z' },
      lastError: null, lastErrorAt: null,
    });
    eq(cloudActiveTier(db, later), null, 'E-3t 缓存 stale ⇒ 生效档位为 null（不是死读缓存）');

    eq(mergeLicenseTier('community', 'pro'), 'pro', 'E-3u 云端更高 ⇒ 采用云端');
    eq(mergeLicenseTier('team', 'pro'), 'team', 'E-3v ★反证：云端更低 ⇒ 本地为准（只升不降）');
    eq(mergeLicenseTier('community', null), 'community', 'E-3w 无云端 ⇒ 本地');
    eq(mergeLicenseTier('pro', 'team'), 'team', 'E-3x 云端 team 抬 pro');
  }

  console.log('\n【E-4】网络一跳：5 秒有界、失败 fail-open、旧权益不清空');
  {
    const creds = { baseUrl: 'http://ans.test/', apiKey: 'k-test', secretKey: 's-test' };
    const ent: AnsEntitlement = {
      tier: 'team', limits: {}, features: [], seats: 1,
      expires_at: null, issued_at: null, signature: 'sig', source: 'cloud',
    };
    const db = mkdb();
    let seen: { url: string; init: RequestInit } | null = null;
    const okFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify(ent), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const firstAt = new Date('2026-10-23T00:00:00.000Z');
    const r1 = await pullCloudEntitlement(db, { creds, fetchImpl: okFetch, now: firstAt });
    ok(r1.ok && r1.attempted, 'E-4a 成功拉取（attempted 如实）', r1.reason ?? '');
    eq(r1.cache?.entitlement, ent, 'E-4b 回包收窄后即缓存值');
    eq(readCloudEntitlementCache(db)?.fetchedAt, firstAt.toISOString(), 'E-4c 取得时刻落账');
    eq(r1.cache?.lastError, null, 'E-4d 成功清空失败账');
    ok(!!seen && (seen as { url: string }).url === `http://ans.test${CLOUD_ENTITLEMENT_PATH}`, 'E-4e 打到权益端点（baseUrl 末尾斜杠已剥）');
    {
      const headers = ((seen as { init: RequestInit } | null)?.init.headers ?? {}) as Record<string, string>;
      eq(headers['x-api-key'], 'k-test', 'E-4f 带身份头（唯一出路口径）');
      ok(/^\d+$/.test(headers['x-timestamp'] ?? ''), 'E-4g 时间戳头在场');
      ok((headers['x-signature'] ?? '').length > 0, 'E-4h 签名头在场');
      ok((seen as { init: RequestInit } | null)?.init.signal instanceof AbortSignal, 'E-4i 有超时信号（有界拉取）');
      eq((seen as { init: RequestInit } | null)?.init.method, 'GET', 'E-4j 只读方法');
    }

    const badFetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const r2 = await pullCloudEntitlement(db, { creds, fetchImpl: badFetch, now: new Date('2026-10-23T01:00:00.000Z') });
    ok(!r2.ok, 'E-4k 401 如实失败');
    ok((r2.reason ?? '').includes('HTTP 401'), 'E-4l 原因带状态码');
    eq(r2.cache?.entitlement, ent, 'E-4m ★失败不清空上次成功权益（fail-open）');
    ok(!!r2.cache?.lastError, 'E-4n 失败进账');
    eq(readCloudEntitlementCache(db)?.fetchedAt, firstAt.toISOString(), 'E-4o 成功时刻不被失败改写');

    const throwFetch = (async () => { throw new Error('ECONNREFUSED 127.0.0.1:27183'); }) as unknown as typeof fetch;
    const r3 = await pullCloudEntitlement(db, { creds, fetchImpl: throwFetch, now: firstAt });
    ok(!r3.ok && (r3.reason ?? '').includes('ECONNREFUSED'), 'E-4p 连不上如实报因（不是"无权益"）');
    eq(r3.cache?.entitlement, ent, 'E-4q 旧权益仍在');

    const htmlFetch = (async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch;
    const r4 = await pullCloudEntitlement(db, { creds, fetchImpl: htmlFetch, now: firstAt });
    ok(!r4.ok && (r4.reason ?? '').includes('不是合法 JSON'), 'E-4r 非 JSON 回包如实拒');

    const shapeFetch = (async () => new Response(JSON.stringify({ tier: 'enterprise' }), { status: 200 })) as unknown as typeof fetch;
    const r5 = await pullCloudEntitlement(db, { creds, fetchImpl: shapeFetch, now: firstAt });
    ok(!r5.ok && (r5.reason ?? '').includes('形状不符'), 'E-4s 形状不符按失败处理（不拿脏值合档）');
    eq(r5.cache?.entitlement?.tier, 'team', 'E-4t 脏回包不动旧权益');

    // 未配凭据：**没去**，与"去了没回"分开记账。
    let called = false;
    const spyFetch = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const bareDb = mkdb();
    const r6 = await pullCloudEntitlement(bareDb, {
      creds: { baseUrl: 'http://ans.test', apiKey: '', secretKey: '' }, fetchImpl: spyFetch, now: firstAt,
    });
    ok(!r6.ok && !r6.attempted, 'E-4u 未配凭据 ⇒ attempted=false');
    ok((r6.reason ?? '').includes('未配置 ANS 凭据'), 'E-4v 原因如实（引导去配凭据）');
    ok(!called, 'E-4w ★反证：未配凭据时一个请求都没发');
    eq(readCloudEntitlementCache(bareDb)?.entitlement, null, 'E-4x 失败账可读（界面能显示不可达）');
    eq(CLOUD_ENTITLEMENT_TIMEOUT_MS, 5000, 'E-4y 有界值由模块单源给出');
  }

  console.log('\n【E-5】许可合并：云端只升不降（软闸同源）');
  {
    const now = new Date('2026-10-23T00:00:00.000Z');
    const opts = { fingerprint: 'FP-TEST', now };
    const mkCloud = (tier: AnsEntitlement['tier'], expires_at: string | null = null): CloudEntitlementCache => ({
      fetchedAt: now.toISOString(),
      entitlement: { tier, limits: {}, features: [], seats: 1, expires_at, issued_at: null, signature: 's', source: 'cloud' },
      lastError: null, lastErrorAt: null,
    });

    const ldb = mkdb();
    eq(resolveLicenseState(ldb, opts).tier, 'community', 'E-5a 无云端基线为社区档');
    writeCloudEntitlementCache(ldb, mkCloud('pro'));
    const st = resolveLicenseState(ldb, opts);
    eq(st.tier, 'pro', 'E-5b 云端 Pro 抬升生效档位');
    eq(st.kind, 'none', 'E-5c 本地许可类型如实不变（未激活就是未激活）');
    ok(st.detail.includes('云端权益已提升至'), 'E-5d 说明里讲清档位为何高于本地状态');
    ok(proUnlocked(st), 'E-5e Pro 闸随之放行');
    ok(!teamUnlocked(st), 'E-5f Team 闸仍锁（只升到 Pro）');
    eq(resolveLicenseTier(ldb, opts), 'pro', 'E-5g 软闸取档与状态同源');

    const tdb = mkdb();
    set(tdb, LICENSE_SETTING_KEYS.trialStartedAt, now.toISOString());
    eq(resolveLicenseTier(tdb, opts), 'pro', 'E-5h 试用基线为 Pro');
    writeCloudEntitlementCache(tdb, mkCloud('pro'));
    const sameTier = resolveLicenseState(tdb, opts);
    eq(sameTier.tier, 'pro', 'E-5i 云端同为 Pro ⇒ 档位不变');
    ok(!sameTier.detail.includes('云端权益已提升至'), 'E-5j ★不虚假宣称"已提升"（同档不算抬高）');
    writeCloudEntitlementCache(tdb, mkCloud('team'));
    const raised = resolveLicenseState(tdb, opts);
    eq(raised.tier, 'team', 'E-5k 云端 Team 抬升试用期');
    ok(teamUnlocked(raised), 'E-5l Team 闸随之放行');

    writeCloudEntitlementCache(tdb, mkCloud('team', '2026-10-01T00:00:00.000Z'));
    eq(resolveLicenseTier(tdb, opts), 'pro', 'E-5m 云端权益过期 ⇒ 回落本地（不续命）');

    const junk = mkdb();
    set(junk, CLOUD_ENTITLEMENT_SETTING_KEY, '{"entitlement":{"tier":"team"},"fetchedAt":"x"}');
    eq(resolveLicenseState(junk, opts).tier, 'community', 'E-5n 坏缓存 ⇒ 本地照旧（fail-open 方向）');
  }

  console.log('\n【E-6】绑档与接线（静态读去注释后的代码）');
  {
    // 知识卡卖点：价目表有这句 ∧ 兑现登记指向真闸 `knowledge_cards` ∧ 该能力在 Pro 档 included。
    const cardBenefit = PRICING.pro.benefits.find((b) => b.includes('项目知识卡'));
    ok(!!cardBenefit, 'E-6a Pro 价目表含知识卡卖点');
    const cov = BENEFIT_COVERAGE.pro.find((e) => e.benefit === cardBenefit);
    ok(!!cov && cov.target.kind === 'capability' && cov.target.keys.includes('knowledge_cards'),
      'E-6b 卖点登记的兑现方式恰为 knowledge_cards 真闸');
    ok(PRO_FEATURES.includes('knowledge_cards'), 'E-6c knowledge_cards 在 Pro 能力词表内');

    const ansIndex = STRIPPED('apps/ans-server/src/index.ts');
    eq([...ansIndex.matchAll(/\.use\(entitlementsRoutes\(db\)\)/g)].length, 1, 'E-6d ANS 恰一处挂载权益路由');
    const hmacBlockAt = ansIndex.indexOf('hmacApi');
    ok(hmacBlockAt >= 0 && ansIndex.indexOf('entitlementsRoutes(db)') > hmacBlockAt,
      'E-6e 权益路由在 HMAC 保护组内（不是公开组）');
    const ansSchema = STRIPPED('apps/ans-server/src/db/schema.ts');
    ok(/CREATE TABLE IF NOT EXISTS ans_entitlements/.test(ansSchema), 'E-6f 权益表在建库脚本里');
    ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_ans_entitlements_key/.test(ansSchema), 'E-6g 前缀唯一索引在册');
    const routeSrc = STRIPPED('apps/ans-server/src/routes/entitlements.ts');
    ok(/get\('\/entitlements'/.test(routeSrc) && /resolveEntitlement\(db, apiKey\.slice\(0, 8\)\)/.test(routeSrc),
      'E-6h 路由壳只取前缀、判据一处（不在此复刻判定）');
    ok(!/ipcMain|listen\(/.test(routeSrc), 'E-6i 端点无写入口/不自起服务');

    ok(RD('packages/shared-types/src/index.ts').includes("'./entitlements.js'"), 'E-6j 契约由 shared-types 统一导出');

    const licSrc = STRIPPED(`${A}/src/main/core/license.ts`);
    eq([...licSrc.matchAll(/cloudActiveTier\(db, now\)/g)].length, 1, 'E-6k 许可热路径恰一处读云端档位');
    eq([...licSrc.matchAll(/mergeLicenseTier\(/g)].length, 1, 'E-6l 合并判据恰一处调用');
    ok(/kind: 'trial'/.test(licSrc) && /TRIAL_DAYS/.test(licSrc), 'E-6m 本地优先序仍在（云端只叠加、不重写）');

    const clientSrc = STRIPPED(`${A}/src/main/core/entitlement-client.ts`);
    ok(/ansSignedRequest\(creds, CLOUD_ENTITLEMENT_PATH/.test(clientSrc), 'E-6n 走唯一出路（不自造第二份请求）');
    ok(!/\bfetch\(/.test(clientSrc), 'E-6o ★反证: 网络层自己不直呼 fetch');
    ok(/retries: 0/.test(clientSrc), 'E-6p 不重试（启动路径有界）');
    ok(/timeoutMs: opts\.timeoutMs \?\? CLOUD_ENTITLEMENT_TIMEOUT_MS/.test(clientSrc), 'E-6q 超时由模块单源派生');

    const pureSrc = STRIPPED(`${A}/src/main/core/cloud-entitlement.ts`);
    ok(!/\bfetch\(|from 'electron'|better-sqlite3/.test(pureSrc), 'E-6r 纯逻辑与网络/electron 分家');

    const licIpc = STRIPPED(`${A}/src/main/ipc/license.ipc.ts`);
    for (const ch of ['license:cloud', 'license:cloud_refresh']) {
      eq([...licIpc.matchAll(new RegExp(`ipcMain\\.handle\\('${ch}'`, 'g'))].length, 1, `E-6s ${ch} 恰一处登记`);
    }
    ok(/pullCloudEntitlement\(db\)/.test(licIpc), 'E-6t 手动重拉走同一拉取函数');

    const rIpc = STRIPPED(`${A}/renderer/src/lib/ipc.ts`);
    for (const ch of ['license:cloud', 'license:cloud_refresh']) {
      ok(rIpc.includes(`'${ch}'`), `E-6u 渲染层通道名与 main 同名（${ch}）`);
    }
    const settings = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(/licenseApi\.cloud\(\)/.test(settings) && /licenseApi\.cloudRefresh\(\)/.test(settings),
      'E-6v 设置页真接线（读缓存 + 手动重拉都可达）');
    ok(/cloud\.active/.test(settings) && /cloud\.lastError/.test(settings),
      'E-6w 上屏区分"已同步"与"不可达"（不摆假绿）');

    const mainSrc = STRIPPED(`${A}/src/main/index.ts`);
    eq([...mainSrc.matchAll(/pullCloudEntitlement\(db\)/g)].length, 1, 'E-6x 启动恰一次拉取');
    ok(/'\.\/core\/entitlement-client\.js'/.test(mainSrc), 'E-6y 启动拉取真引网络层（动态加载不压启动）');
  }

  // ═══ S｜哑雷自检 + build 钉 ═══════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfPath = `scripts/${path.basename(__filename)}`;
    const selfLines = stripKeepingLines(RD(selfPath)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S3 本套件在册（脚本名由载体派生）');

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection 之前把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\nrr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
