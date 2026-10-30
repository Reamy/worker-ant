/**
 * zx_20261017_1 受控复跑 —— 「任」（协同 + 档位：能力路由 / 审计视图；后续批次同此在册）。
 *
 * 本套件随批次**增量落册**：批一（能力路由 + require_target）与批二（审计基座 + 审计视图）
 * 的判据在这里跑真实现；后续批次的判据继续追加，不另立脚本。
 *
 * ── 判据（R-1..R-30 本批已落；R-20..R-22 在 ans-server vitest）────────────────────
 *   批一：R-1 六形态逐项映射 / R-2 无命中⇒null（不确定不外派）/ R-3 旧常量从派单调用体消失 /
 *         R-6 类目只输出名、不另算节点能力。
 *   批二：R-7 Team 词表逐项枚举（含 audit_view）/ R-8 三账合并恰 3 行且来源可辨 /
 *         R-9 新账正面断言 0→1 且字段逐项核对 / R-10 锁定不查库（毒库反证）+ 解锁两侧标本 /
 *         R-11 投影不复制明细（读不写、detail 来自原行）/ R-12 wa_audit_trail 仍零写入。
 *   批三：R-13 开关三态（zx_20261029_2 M7）/ R-14 逐项独立理由 + 次序（含 M7 余力闸）/
 *         R-15 成功路径：require_target 提交 + 三键齐落 + 审计投影 /
 *         R-16 预查无果（六种对端标本）⇒ 不触网不写键 /
 *         R-17 失败面三态：提交失败 / 重放幂等（同一建单只派一次）/ 回执不全，一律不写键 /
 *         R-18 依赖 / 工作目录 / 载荷拼接两侧标本。
 *   批四：R-23 改档留痕（0→1，明细只记字段/self）；R-24 `canEditNode` 两侧标本。
 *         R-20..R-22（ANS 改档权限矩阵 / 非节点 403 / 伪造 body）在 `ans-server` 的
 *         `src/__tests__/nodes-routes.test.ts`——那边才有真 HMAC + 生产建表。
 *   批五：R-25..R-30 席位闸（上限取 TIER_LIMITS / 只拦新增 / 邀请两跳先过闸 /
 *         OAuth 只拦新建 / `license:status.seats` 与 `countSeats` 同一个数）。
 *   批六：R-31..R-33（ANS 团队共享库：来源由凭据派生 / 只能删本节点条目 / 三道上限）
 *         在 `ans-server` 的 `src/__tests__/team-routes.test.ts`——真 HMAC + 生产建表。
 *         R-34 本地组装与导入映射（模板/记忆/成果三表真落点，成果不带 file_path）/
 *         R-35 Team 闸锁定 ⇒ 拒因且**先于任何网络调用**（静态次序 + 两只标本）/
 *         R-36 分享是显式动作（列表加载零写调用）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *   G-1 用生产函数（静态导入真实现；不在本文件复刻等价物）。
 *   G-4 不依赖真实墙钟：许可闸 `now` 注入。
 *   G-5 静态判据读**去注释后的原文**（`stripKeepingLines`）；"代码含 X"类仍读原文。
 *   G-6 无轮次字面量：轮次由 `path.basename(__filename)` 派生。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  ARCHETYPE_NODE_CATEGORY, routeCategoryForArchetype, routeCategoryForTask,
} from '../apps/worker-ant-desktop/src/main/core/task-routing.js';
import {
  TEAM_FEATURES, TEAM_FEATURE_LABEL, teamFeatureRefusal,
} from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
// zx_20261029_2 M6：云同步/发现改读 Pro 闸（`device_discovery` 已移出 Team）。
import { proFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import {
  listAuditEvents, listAuditEventsGated, recordAudit, recordNodeUpdate, type AuditDb,
} from '../apps/worker-ant-desktop/src/main/core/audit-log.js';
import {
  assertSeatAvailable, countSeats, seatUsage, SeatLimitError, type SeatDb,
} from '../apps/worker-ant-desktop/src/main/core/seat-quota.js';
import {
  claimInviteToken, issueInviteToken, markInviteUsed, type InviteDb,
} from '../apps/worker-ant-desktop/src/main/core/invite.js';
import { AuthService } from '../apps/worker-ant-desktop/src/main/core/auth.js';
import { canEditNode } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
import {
  AUDIT_SOURCES, AUDIT_SOURCE_LABEL, auditActionLabel, isAuditSource,
} from '../apps/worker-ant-desktop/src/main/core/audit-labels.js';
import type { TaskArchetype } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import {
  AUTO_DISPATCH_SETTING_KEY, CREATE_DISPATCH_REASON_LABEL, buildDispatchPrompt,
  decideAutoDispatchPolicy, decideCreateDispatch, dispatchCreatedTask, isAutoDispatchOn, lastAutoDispatch,
  peersSupportingCategory, projectHasWorkingDir, taskHasDependencies,
  type CreateDispatchFacts,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import type { DispatchIo } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
import { remoteAssignOf } from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import {
  importItem, listLocalItems, shareItem, TeamLibraryError,
} from '../apps/worker-ant-desktop/src/main/core/team-library.js';
import {
  isTeamItemKind, TEAM_ITEM_KINDS, TEAM_ITEM_KIND_LABEL, TEAM_ITEM_MAX_BODY_BYTES,
  TEAM_ITEM_MAX_PER_NODE, TEAM_ITEM_MAX_TITLE, type TeamItem,
} from '@worker-ant/shared-types';
import {
  KNOWLEDGE_INJECT_MAX_TOKENS, PROJECT_KNOWLEDGE_SECTIONS, deriveProjectKnowledge,
  listProjectKnowledge, orderKnowledgeSections, previewProjectKnowledge,
  selectKnowledgeForInject, upsertProjectKnowledge,
} from '../apps/worker-ant-desktop/src/main/core/project-knowledge.js';
import {
  KNOWLEDGE_EXPORT_DIR, KNOWLEDGE_PACK_SOURCE, knowledgeExportFileName,
  writeKnowledgeExport,
} from '../apps/worker-ant-desktop/src/main/core/knowledge-export.js';
import { estimateTokensFromChars } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';
import {
  CLOUD_ADDRESS_SEP, cloudAddress, cloudDeviceIdOf, cloudProviderIdOf, controlCloudDevice,
  getDeviceProvider, registerDeviceProvider, syncProviderDevices, unregisterDeviceProvider,
  type DeviceProvider,
} from '../apps/worker-ant-desktop/src/main/core/device-provider.js';
import {
  findDeviceByIdentity, setDeviceAlias, setDeviceAuthorized, upsertDiscovered,
  type AnsDevice, type DeviceDb,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  TUYA_PROVIDER_ID, TUYA_REGION_HOSTS, TUYA_SETTING_ACCESS_ID, TUYA_SETTING_ACCESS_SECRET,
  TUYA_SETTING_REGION, TUYA_REGIONS, createTuyaProvider, registerTuyaCloudProvider,
  resolveTuyaConfig, tuyaBodyHash, tuyaCommands, tuyaConfigStatus, tuyaSign, tuyaStringToSign,
  tuyaSignedHeaders, type TuyaConfig, type TuyaHttp, type TuyaHttpInit, type TuyaHttpResponse,
} from '../apps/worker-ant-desktop/src/main/core/providers/tuya-cloud.js';
import { defaultDeviceControl, runDeviceControl } from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
import type { AnsNode, AnsNodeRequest, NodeRequestSubmit } from '@worker-ant/shared-types';

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

const NOW = new Date('2026-10-17T00:00:00.000Z');
const FP = 'AAAA-BBBB-CCCC-DDDD';

/** 建一份与生产同形的审计三账 + 设置表（DDL 形状取 `database.ts`，不比生产宽松）。 */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE wa_audit_events (
      id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_device_actions (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL, args_json TEXT DEFAULT '{}',
      result TEXT DEFAULT '', task_id TEXT DEFAULT '', actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '',
      plan_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_external_calls (
      id TEXT PRIMARY KEY, terminal_id TEXT NOT NULL, capability TEXT NOT NULL, args_json TEXT DEFAULT '{}',
      result TEXT DEFAULT '', reason TEXT DEFAULT '', remote_addr TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_audit_trail (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT, event_type TEXT NOT NULL,
      event_data TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, working_dir TEXT DEFAULT ''
    );
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
      title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
      context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
      priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '',
      parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
      acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/**
 * 批八设备夹具：`wa_devices` / `wa_device_actions` 按生产同形建表（DDL 取 `database.ts`，不比生产宽松）。
 * ⚠ `upsertDiscovered` 的 INSERT 显式列 `alias`/`online`——少一列即当场报错（夹具宽松会假绿）。
 */
function makeDeviceDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
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
  `);
  return db;
}

/**
 * 批七知识册夹具：七节各自读一张既有表 ⇒ 全部按生产同形建表
 * （列名/默认值照搬 `database.ts`；不比生产宽松，否则派生 SQL 照不出缺列）。
 * ⚠ `node:sqlite` 无 `transaction()`，而 `upsertProjectKnowledge` 是真实现 ⇒ 补垫片。
 */
function makeKnowledgeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_knowledge_triples (
      id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL, predicate TEXT NOT NULL,
      object TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'x',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, status TEXT, name TEXT, file_path TEXT);
    CREATE TABLE wa_service_calls (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, kind TEXT, target TEXT, operation TEXT,
      ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT, payload TEXT);
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, status TEXT DEFAULT 'pending',
      context_json TEXT DEFAULT '{}', acceptance_criteria TEXT DEFAULT '');
    CREATE TABLE wa_task_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
      description TEXT DEFAULT '', status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0);
    CREATE TABLE wa_memories (
      id TEXT PRIMARY KEY, project_id TEXT, content TEXT NOT NULL,
      memory_type TEXT DEFAULT 'episodic', is_exemplar INTEGER DEFAULT 0);
    -- zx_20261018_2 批四: domain 读项目行、usage 读设备动作 ⇒ 按生产同形补齐。
    CREATE TABLE wa_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
    CREATE TABLE wa_device_actions (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
      args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
      actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_project_knowledge (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
      content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
    -- zx_20261022_3 批七: 读册 = 派生 ∪ 导入（生产同一句），夹具须同建。
    CREATE TABLE wa_project_knowledge_imports (
      project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
      precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
      imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
    CREATE TABLE wa_knowledge_imports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
      source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge',
      sections INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT DEFAULT (datetime('now')));
  `);
  (db as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => fn();
  return db;
}

/** 已入网本机（三条件齐：id / resource_group=node:<id> / 非占位 key）+ 可派角色。 */
function seedEnrolled(db: DatabaseSync, id = 'self-node'): void {
  const put = db.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)');
  put.run('node.id', id);
  put.run('node.resource_group', `node:${id}`);
  put.run('ans_api_key', 'real-key-0123456789abcdef');
  put.run('node.role', 'primary');
}

/** 台账行标本（`AnsNode` 同形；`card.categories` 是能力路由的唯一判据落点）。 */
function peerNode(over: Partial<AnsNode> = {}): AnsNode {
  return {
    node_id: 'peer-1', name: '对端一', api_key_prefix: 'abcd1234',
    resource_group: 'node:peer-1', platform: 'darwin/arm64', role: 'primary', weight: 1,
    participate: true, capabilities: [], card: { categories: ['code'] }, status: null,
    enrolled_at: '2026-10-17 00:00:00', last_seen_at: '2026-10-17 00:00:00',
    ...over,
  };
}

/** 派发假 IO（**不出网**）：记下每次提交的入参，回一单可配的 ANS 形状。 */
function fakeDispatchIo(reply: Partial<AnsNodeRequest> = {}): { io: DispatchIo; submits: NodeRequestSubmit[] } {
  const submits: NodeRequestSubmit[] = [];
  return {
    submits,
    io: {
      async submit(req) {
        submits.push(req);
        return {
          id: 'req-1', category: req.category, payload: req.payload ?? {},
          requester_key_prefix: '', requester_node_id: null, target_node_id: 'peer-1',
          status: 'pending', result: null, question: null, question_status: null,
          answer: null, created_at: '', updated_at: '', ...reply,
        } as unknown as AnsNodeRequest;
      },
      async get() { throw new Error('fake-io: get 不该被自动外派调用'); },
      async answer() { throw new Error('fake-io: answer 不该被自动外派调用'); },
    },
  };
}

function seedTask(db: DatabaseSync, id = 't1', ctx: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO wa_tasks (id, title, context_json) VALUES (?, ?, ?)')
    .run(id, '实现登录模块', JSON.stringify(ctx));
}

function taskContext(db: DatabaseSync, id = 't1'): Record<string, unknown> {
  const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json?: string } | undefined;
  const v = JSON.parse(String(row?.context_json ?? '{}')) as unknown;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 全部准入通过的基线事实（逐项覆盖时只翻一项——保证"拒绝理由"确实是那一项给的）。 */
function eligibleFacts(over: Partial<CreateDispatchFacts> = {}): CreateDispatchFacts {
  return {
    settingOn: true, teamUnlocked: true, enrolled: true,
    hasParent: false, hasDependencies: false, hasAttachments: false,
    hasWorkingDir: false, decomposed: false, category: 'code',
    ...over,
  };
}

/** 有/无试用的设置库——Team 软闸的两只标本（`now` 注入，不碰真实墙钟）。 */
function settingsDb(trial: boolean): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
  if (trial) {
    db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run('license.trial_started_at', new Date(NOW.getTime() - 86_400_000).toISOString());
  }
  return db;
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** 递归列 `src/main` 下的 .ts（R-12 的"全仓零写入"反证用）。 */
function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTs(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  // ═══ R-1 / R-2 / R-6 能力路由（批一）═══════════════════════════════════════
  console.log('\n【R-1/R-2/R-6】能力路由：形态 → 类目（唯一真源，零猜测）');
  {
    const six: Array<[TaskArchetype, string | null]> = [
      ['code', 'code'], ['configuration', 'code'], ['analysis', 'code'],
      ['research', 'research'], ['document', 'text'], ['conversation', null],
    ];
    for (const [archetype, category] of six) {
      eq(routeCategoryForArchetype(archetype), category, `R-1 形态 ${archetype} ⇒ ${String(category)}`);
    }
    eq(Object.keys(ARCHETYPE_NODE_CATEGORY).sort(), six.map(([a]) => a).sort(),
      'R-1b 映射表恰六形态（逐成员枚举，不多不少）');

    eq(routeCategoryForTask('实现登录模块', '写代码并跑通测试'), 'code', 'R-2a 代码任务 ⇒ code');
    eq(routeCategoryForTask('调研技术方案', ''), 'research', 'R-2b 调研任务 ⇒ research');
    eq(routeCategoryForTask('撰写项目报告', ''), 'text', 'R-2c 文档任务 ⇒ text');
    eq(routeCategoryForTask('你好', ''), null, 'R-2d ★无关键词命中 ⇒ null（不确定不外派）');
    eq(routeCategoryForTask('', ''), null, 'R-2e 空标题/空描述 ⇒ null');
    eq(routeCategoryForTask('？？！……', '!!!'), null, 'R-2f 纯标点 ⇒ null（不因长度/标点猜成某档）');

    const routing = STRIPPED(`${A}/src/main/core/task-routing.ts`);
    ok(!/nodeQualifies|DISPATCHABLE_WHERE|node-card/.test(routing),
      'R-6 路由模块**只输出类目名**，不另算某台节点是否具备该类目（能力判据仍一处）');
  }

  // ═══ R-3 派单调用体不再出现旧常量（批一）════════════════════════════════════
  console.log('\n【R-3】编排器：旧派单类目常量已从生产路径消失');
  {
    const orch = STRIPPED(`${A}/src/main/core/orchestrator.ts`);
    ok(!/ORCHESTRATE_CATEGORY/.test(orch),
      'R-3 ★去注释后源码**零** `ORCHESTRATE_CATEGORY`（旧"恒派 project_task"的来路已断）');
    ok(/routeCategoryForTask\s*\(/.test(orch),
      'R-3b 溢出件按任务形态取类目（`routeCategoryForTask` 在派单体里真被调用）');
  }

  // ═══ R-7 Team 词表（批二）═══════════════════════════════════════════════════
  console.log('\n【R-7】Team 能力词表逐项枚举（含 audit_view）');
  {
    // zx_20261029_2 M6：`device_discovery` 移出（归 Pro）⇒ 逐成员枚举 8→7。
    eq([...TEAM_FEATURES],
      ['multi_node', 'device_control', 'external_terminal', 'audit_view', 'audit_export', 'team_library', 'project_profile_share'],
      'R-7a ★能力词表逐成员枚举（唯一定义处；M6 起发现归 Pro，本表只管控制面）');
    for (const f of TEAM_FEATURES) {
      ok(typeof TEAM_FEATURE_LABEL[f] === 'string' && TEAM_FEATURE_LABEL[f].length > 0,
        `R-7b 人话名非空：${f} ⇒ 「${TEAM_FEATURE_LABEL[f]}」`);
    }
    eq(TEAM_FEATURE_LABEL.audit_view, '审计视图', 'R-7c `audit_view` 的人话名如实（界面/拒因直接上屏）');
    eq([...AUDIT_SOURCES].sort(), ['device', 'local', 'node', 'system', 'terminal'],
      'R-7d 审计来源词表逐项枚举');
    for (const s of AUDIT_SOURCES) {
      ok(typeof AUDIT_SOURCE_LABEL[s] === 'string' && AUDIT_SOURCE_LABEL[s].length > 0,
        `R-7e 来源人话名非空：${s} ⇒ 「${AUDIT_SOURCE_LABEL[s]}」`);
      ok(isAuditSource(s), `R-7f isAuditSource 认 ${s}（枚举与判据同源）`);
    }
    eq([isAuditSource('bogus'), isAuditSource('')], [false, false], 'R-7g 词表外值 ⇒ 不认（不放过假来源）');
    eq(auditActionLabel('node.dispatch'), '派活', 'R-7h 动作人话名可查');
    eq(auditActionLabel('custom.unknown'), 'custom.unknown', 'R-7i 未登记动作**原样显示**（不编假描述）');
  }

  // ═══ R-9 新账正面断言（批二）════════════════════════════════════════════════
  console.log('\n【R-9】recordAudit：计数 0→1 + 字段逐项核对');
  {
    const db = makeDb();
    eq(count(db, 'wa_audit_events'), 0, 'R-9a 写前恰 0 行（正面断言的起点）');
    const wrote = recordAudit(db as unknown as AuditDb, {
      actorKind: 'local', actorRef: 'node-self', action: 'node.dispatch',
      targetType: 'node', targetId: 'node-peer', detail: { requestId: 'req-1', category: 'code' },
    });
    eq([wrote, count(db, 'wa_audit_events')], [true, 1], 'R-9b ★调用后**恰 1 行**（不是"不抛即算过"）');
    const row = db.prepare('SELECT actor_kind, actor_ref, action, target_type, target_id, detail_json FROM wa_audit_events').get() as Record<string, unknown>;
    eq([row.actor_kind, row.actor_ref, row.action, row.target_type, row.target_id],
      ['local', 'node-self', 'node.dispatch', 'node', 'node-peer'],
      'R-9c 字段逐项核对（发起者/动作/对象）');
    eq(JSON.parse(String(row.detail_json)), { requestId: 'req-1', category: 'code' }, 'R-9d 明细原样落库');
    db.close();
  }

  // ═══ R-8 三账合并读模型（批二）══════════════════════════════════════════════
  console.log('\n【R-8】读模型：同一时间窗三表各 1 行 ⇒ 合并恰 3 行且来源可辨');
  {
    const db = makeDb();
    const ts = '2026-10-17 00:00:00';
    recordAudit(db as unknown as AuditDb, {
      actorKind: 'local', actorRef: 'node-self', action: 'node.dispatch',
      targetType: 'node', targetId: 'node-peer', detail: { requestId: 'req-1' },
    });
    db.prepare("UPDATE wa_audit_events SET created_at = ?").run(ts);
    db.prepare(`INSERT INTO wa_device_actions (id, device_id, action, args_json, result, actor_kind, actor_ref, created_at)
                VALUES ('d1', 'dev-1', 'turn_on', '{"brightness":80}', 'ok', 'task', 'task-9', ?)`).run(ts);
    db.prepare(`INSERT INTO wa_external_calls (id, terminal_id, capability, args_json, result, reason, remote_addr, created_at)
                VALUES ('e1', 'term-1', 'device_control', '{"name":"客厅台灯"}', 'denied', 'capability_not_allowed', '10.0.0.2', ?)`).run(ts);

    const rows = listAuditEvents(db as unknown as AuditDb);
    eq(rows.length, 3, 'R-8a ★三本账合成**恰 3 行**（不重不漏）');
    eq(rows.map((r) => r.source).sort(), ['device', 'local', 'terminal'],
      'R-8b 来源可区分：本机（新账）/ 设备 / 外部终端');
    const device = rows.find((r) => r.source === 'device')!;
    eq([device.action, device.result, device.targetId], ['device.control', 'ok', 'dev-1'],
      'R-8c 设备账投影成 `device.control`，result/对象取自原行');
    const ext = rows.find((r) => r.source === 'terminal')!;
    eq([ext.action, ext.result, ext.note], ['external.call', 'denied', 'capability_not_allowed'],
      'R-8d 外部账投影成 `external.call`，拒因（reason）进 note');

    eq(listAuditEvents(db as unknown as AuditDb, { source: 'device' }).map((r) => r.id), ['d1'],
      'R-8e 来源筛选生效');
    eq(listAuditEvents(db as unknown as AuditDb, { action: 'external.call' }).map((r) => r.id), ['e1'],
      'R-8f 动作筛选生效');
    eq(listAuditEvents(db as unknown as AuditDb, { limit: 2 }).length, 2, 'R-8g 分页 limit 生效');
    db.close();
  }

  // ═══ R-11 投影不复制明细（批二）═════════════════════════════════════════════
  console.log('\n【R-11】设备/外部两账的投影只读原行，不另写一份事实');
  {
    const db = makeDb();
    db.prepare(`INSERT INTO wa_device_actions (id, device_id, action, args_json, result, actor_kind, actor_ref)
                VALUES ('d1', 'dev-1', 'turn_on', '{"brightness":80}', 'ok', 'panel', '')`).run();
    db.prepare(`INSERT INTO wa_external_calls (id, terminal_id, capability, args_json, result, reason)
                VALUES ('e1', 'term-1', 'device_control', '{"name":"客厅台灯"}', 'ok', '')`).run();
    const before = [count(db, 'wa_device_actions'), count(db, 'wa_external_calls'), count(db, 'wa_audit_events')];
    const rows = listAuditEvents(db as unknown as AuditDb);
    const after = [count(db, 'wa_device_actions'), count(db, 'wa_external_calls'), count(db, 'wa_audit_events')];
    eq(after, before, 'R-11a ★读模型**只读不写**（三表行数读前读后全等）');
    eq(rows.find((r) => r.source === 'device')?.detail, { brightness: 80 },
      'R-11b 设备明细即原行 `args_json`（不加工、不复制）');
    eq(rows.find((r) => r.source === 'terminal')?.detail, { name: '客厅台灯' },
      'R-11c 外部调用明细即原行 `args_json`');
    db.close();
  }

  // ═══ R-10 Team 闸：锁定不查库（批二）════════════════════════════════════════
  console.log('\n【R-10】audit 读口：锁定 ⇒ TEAM_REQUIRED 且**不查库**；解锁两侧标本');
  {
    const lockedDb = settingsDb(false);
    const poison = {
      prepare() { throw new Error('锁定态不得查库'); },
    } as unknown as AuditDb;
    const locked = listAuditEventsGated(poison, lockedDb, {}, { now: NOW, fingerprint: FP });
    eq([locked.unlocked, locked.events.length], [false, 0],
      'R-10a ★★锁定态：毒库（prepare 即抛）**未被碰过** ⇒ 零读，回空');
    ok(locked.refusal.includes('审计视图') && locked.refusal.includes('团队版'),
      'R-10b 拒因含人话名与升级指引（不返回光秃秃 false）', locked.refusal);

    const openDb = settingsDb(true);
    const real = makeDb();
    recordAudit(real as unknown as AuditDb, {
      actorKind: 'local', action: 'license.activate', targetType: 'license', targetId: 'pro',
    });
    const open = listAuditEventsGated(real as unknown as AuditDb, openDb, {}, { now: NOW, fingerprint: FP });
    eq([open.unlocked, open.events.length], [true, 1], 'R-10c ★另一侧标本：试用期 ⇒ 放行且**真取到** 1 行');
    eq(teamFeatureRefusal(lockedDb, 'audit_view', { now: NOW, fingerprint: FP }) !== null, true,
      'R-10d 拒因判据与 Team 词表同源（`teamFeatureRefusal` 一处）');
    lockedDb.close(); openDb.close(); real.close();
  }

  // ═══ R-12 wa_audit_trail 仍零写入（批二）════════════════════════════════════
  console.log('\n【R-12】`wa_audit_trail` 不复活（防两张审计表双真源）');
  {
    const db = makeDb();
    recordAudit(db as unknown as AuditDb, { actorKind: 'local', action: 'node.update', targetType: 'node', targetId: 'n1' });
    listAuditEvents(db as unknown as AuditDb);
    eq(count(db, 'wa_audit_trail'), 0, 'R-12a 新账写入 + 读模型之后，旧表仍 0 行');
    const writers = listTs(path.join(root, A, 'src/main'))
      .filter((f) => /INSERT\s+(OR\s+\w+\s+)?INTO\s+wa_audit_trail/i.test(fs.readFileSync(f, 'utf-8')));
    eq(writers.map((f) => path.relative(root, f)), [], 'R-12b ★全仓 `src/main` 无一处写旧表（静态穷举）');
    db.close();
  }

  // ═══ R-13 建单即派开关（批三；zx_20261029_2 M7 起为三态）════════════════════
  console.log("\n【R-13】建单即派开关：三态——显式 `'1'`/`'0'`，未配置跟 Team+入网");
  {
    const db = makeDb();
    eq([AUTO_DISPATCH_SETTING_KEY, isAutoDispatchOn(db)], ['node.auto_dispatch_on_create', false],
      'R-13a ★未配置且无团队许可/未入网 ⇒ 关（键名一处真源 + 缺省支）');
    const put = db.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)');
    // `''` 视同未配置（历史写入口可能落空串）；本库无许可/入网 ⇒ 缺省支仍关。
    for (const [raw, expect] of [['0', false], ['true', false], ['on', false], ['', false], ['1', true]] as const) {
      put.run(AUTO_DISPATCH_SETTING_KEY, raw);
      eq(isAutoDispatchOn(db), expect, `R-13b 值「${raw}」⇒ ${expect ? '开' : '关'}（不放过近似真值）`);
    }
    db.close();

    // zx_20261029_2 M7：缺省三态的纯判据逐支枚举——未配置时**跟 Team 许可 + 入网**，而不是一律关。
    const def = decideAutoDispatchPolicy({ raw: null, teamUnlocked: true, enrolled: true });
    eq([def.enabled, def.source], [true, 'default'],
      'R-13c ★未配置 + Team 已解锁 + 已入网 ⇒ **开**（缺省支）');
    ok(def.reason.length > 0, 'R-13d 缺省开的理由有非空人话（界面直接上屏）');
    eq(decideAutoDispatchPolicy({ raw: null, teamUnlocked: false, enrolled: true }).enabled, false,
      'R-13e ★未配置 + 社区/Pro ⇒ 关（没有多机能力，永不默认开）');
    eq(decideAutoDispatchPolicy({ raw: null, teamUnlocked: true, enrolled: false }).enabled, false,
      'R-13f ★未配置 + 未入网 ⇒ 关（没有协同对象）');
    const off = decideAutoDispatchPolicy({ raw: '0', teamUnlocked: true, enrolled: true });
    eq([off.enabled, off.source], [false, 'explicit'],
      'R-13g ★显式关压过缺省开（用户设过的就是用户的）');
    eq(decideAutoDispatchPolicy({ raw: '1', teamUnlocked: false, enrolled: false }).enabled, true,
      'R-13h 显式开的读取不看许可（实际外派仍由 team-locked 闸拦）');
    const junk = decideAutoDispatchPolicy({ raw: ' true ', teamUnlocked: true, enrolled: true });
    eq([junk.enabled, junk.source], [false, 'explicit'],
      'R-13i 近似真值（含首尾空白）一律当关——写坏的值不该悄悄改变行为');
  }

  // ═══ R-14 准入判据逐项拒绝（批三）══════════════════════════════════════════
  console.log('\n【R-14】准入：逐项独立理由（不合并成一个布尔）');
  {
    const allowed = decideCreateDispatch(eligibleFacts());
    eq([allowed.eligible, allowed.reason, allowed.category], [true, 'eligible', 'code'],
      'R-14a 基线事实全真 ⇒ 放行且带出类目');

    const denies: Array<[Partial<CreateDispatchFacts>, string]> = [
      [{ settingOn: false }, 'setting-off'],
      [{ teamUnlocked: false }, 'team-locked'],
      [{ enrolled: false }, 'not-enrolled'],
      [{ hasParent: true }, 'has-parent'],
      [{ hasDependencies: true }, 'has-dependencies'],
      [{ hasAttachments: true }, 'has-attachments'],
      [{ hasWorkingDir: true }, 'has-working-dir'],
      [{ decomposed: true }, 'decomposed'],
      [{ category: null }, 'no-category'],
    ];
    for (const [over, reason] of denies) {
      const d = decideCreateDispatch(eligibleFacts(over));
      eq([d.eligible, d.reason], [false, reason], `R-14b ${Object.keys(over)[0]} ⇒ ${reason}（只翻这一项）`);
    }
    // 次序：开关是**最上游**那道闸——即便后面的项也"可外派"，未开就是 setting-off。
    eq(decideCreateDispatch(eligibleFacts({ settingOn: false, hasParent: true, category: null })).reason,
      'setting-off', 'R-14c ★判定次序固定：首个不满足者即理由（用户看到的是最上游那道闸）');

    // zx_20261029_2 M7：「缺省开」只在满负荷时溢出——本机有余力就先留在本机；显式开启是用户的选择，不受此限。
    eq(decideCreateDispatch(eligibleFacts({ autoDispatchSource: 'default', localHasFreeSlot: true })).reason,
      'local-capacity', 'R-14f ★缺省开 + 本机有余力 ⇒ local-capacity（本机跑得动就先在本机跑）');
    eq(decideCreateDispatch(eligibleFacts({ autoDispatchSource: 'default', localHasFreeSlot: false })).reason,
      'eligible', 'R-14g 缺省开 + 本机已满负荷 ⇒ 放行（溢出）');
    eq(decideCreateDispatch(eligibleFacts({ autoDispatchSource: 'explicit', localHasFreeSlot: true })).reason,
      'eligible', 'R-14h 显式开 + 本机有余力 ⇒ 仍放行（用户自己的选择，不被余力闸拦）');
    eq(decideCreateDispatch(eligibleFacts({ localHasFreeSlot: true })).reason,
      'eligible', 'R-14i 旧调用方不给来由 ⇒ 不因新判据改变行为');

    // zx_20261023_5 批一：依赖准入由"一刀切 has-dependencies"细分三态，词表新增两员（逐成员枚举，旧项不删）。
    const reasons = ['eligible', 'setting-off', 'team-locked', 'not-enrolled', 'has-parent',
      'has-dependencies', 'dependencies-waiting', 'dependencies-dead',
      'has-attachments', 'has-working-dir', 'decomposed', 'local-capacity', 'no-category'];
    eq(Object.keys(CREATE_DISPATCH_REASON_LABEL).sort(), [...reasons].sort(),
      'R-14d 理由词表逐成员枚举（机器码与上屏文案成对，漏一项是编译期错）');
    for (const r of reasons) {
      ok(typeof CREATE_DISPATCH_REASON_LABEL[r as keyof typeof CREATE_DISPATCH_REASON_LABEL] === 'string'
        && CREATE_DISPATCH_REASON_LABEL[r as keyof typeof CREATE_DISPATCH_REASON_LABEL].length > 0,
        `R-14e 理由「${r}」有非空人话`);
    }
  }

  // ═══ R-15 预查 + 提交 + 记三键（批三）══════════════════════════════════════
  console.log('\n【R-15】外派成功：预查在线对端 → require_target 提交 → 三键齐落');
  {
    const db = makeDb(); seedEnrolled(db); seedTask(db);
    const { io, submits } = fakeDispatchIo();
    const out = await dispatchCreatedTask(
      db, { id: 't1', title: '实现登录模块', description: '写代码并跑通', acceptanceCriteria: '测试全绿' },
      eligibleFacts(),
      {
        listLedger: async () => ({ nodes: [peerNode()], localNodeId: 'self-node' }),
        io, emit: () => {}, nowMs: NOW.getTime(),
      },
    );
    eq([out.attempted, out.ok, out.reason, out.nodeId], [true, true, '', 'peer-1'],
      'R-15a 成功结局如实（attempted/ok/nodeId）');
    eq(submits.length, 1, 'R-15b 恰提交一单（不重不漏）');
    eq(submits[0]!.require_target, true, 'R-15c ★`require_target: true`（无合格目标时 ANS 不落无人认领的单）');
    eq(submits[0]!.category, 'code', 'R-15d 类目由任务形态路由而来');
    const prompt = String((submits[0]!.payload as Record<string, unknown>)?.prompt ?? '');
    ok(prompt.includes('实现登录模块') && prompt.includes('写代码并跑通') && prompt.includes('验收标准：测试全绿'),
      'R-15e 载荷 `prompt` 含标题/描述/验收标准（接收侧 `relayTaskTitle` 读的就是它）', prompt.slice(0, 60));

    const ctx = taskContext(db);
    eq([ctx.assigned_node_id, ctx.assigned_request_id], ['peer-1', 'req-1'],
      'R-15f ★三键中的两键真落 `context_json`（node_id / request_id）');
    ok(typeof ctx.assigned_at === 'string' && String(ctx.assigned_at).length > 0,
      'R-15g 第三键 `assigned_at` 非空（`remoteAssignOf` 的判据三键之一）');
    ok(remoteAssignOf(JSON.stringify(ctx)) !== null, 'R-15h 单一判据 `remoteAssignOf` 认这单为"已外派"');

    const last = lastAutoDispatch(db);
    eq([last?.nodeId, last?.requestId, last?.category], ['peer-1', 'req-1', 'code'],
      'R-15i 审计账可投影出「最近一次自动外派」（面板横幅的数据源）');
    ok((last?.at ?? '').length > 0, 'R-15j 投影带时刻（非空串）');
    db.close();
  }

  // ═══ R-16 预查无果 ⇒ 不提交（批三）════════════════════════════════════════
  console.log('\n【R-16】预查：没有在线且能力卡含该类目的对端 ⇒ 不提交、不写三键');
  {
    const cases: Array<[AnsNode[], string]> = [
      [[], '空台账'],
      [[peerNode({ role: 'observer' })], '观察者不接活'],
      [[peerNode({ participate: false })], '未参与'],
      [[peerNode({ last_seen_at: '2026-10-16 00:00:00' })], '离线'],
      [[peerNode({ card: { categories: ['text'] } })], '能力卡不含 code'],
      [[peerNode({ card: null })], '无能力卡'],
    ];
    for (const [nodes, label] of cases) {
      const db = makeDb(); seedEnrolled(db); seedTask(db);
      const { io, submits } = fakeDispatchIo();
      const out = await dispatchCreatedTask(db, { id: 't1', title: '实现登录模块' }, eligibleFacts(), {
        listLedger: async () => ({ nodes, localNodeId: 'self-node' }),
        io, emit: () => {}, nowMs: NOW.getTime(),
      });
      eq([out.attempted, out.ok, out.reason, submits.length], [false, false, 'no-peer', 0],
        `R-16 对端标本「${label}」⇒ 不触网 + no-peer`);
      eq(remoteAssignOf(JSON.stringify(taskContext(db))), null, `R-16b 「${label}」⇒ 三键未写`);
      db.close();
    }
    eq(peersSupportingCategory({ nodes: [peerNode(), peerNode({ node_id: 'peer-2', card: { categories: ['text'] } })], localNodeId: 'self-node' }, 'code', NOW.getTime()),
      ['peer-1'], 'R-16c 预查只挑**卡内确含该类目**的对端');
  }

  // ═══ R-17 失败面与幂等（批三）═════════════════════════════════════════════
  console.log('\n【R-17】提交失败 / 重放幂等 / ANS 回执不全 ⇒ 一律不写三键');
  {
    // R-17 提交抛错
    const db17 = makeDb(); seedEnrolled(db17); seedTask(db17);
    const out17 = await dispatchCreatedTask(db17, { id: 't1', title: '实现登录模块' }, eligibleFacts(), {
      listLedger: async () => ({ nodes: [peerNode()], localNodeId: 'self-node' }),
      io: {
        async submit() { throw new Error('ANS 502 bad gateway'); },
        async get() { throw new Error('unused'); }, async answer() { throw new Error('unused'); },
      },
      emit: () => {}, nowMs: NOW.getTime(),
    });
    eq([out17.attempted, out17.ok], [true, false], 'R-17a 提交失败：attempted=true / ok=false（真提交过 ≠ 成功）');
    ok(out17.reason.includes('502'), 'R-17b 失败原因原样带出', out17.reason);
    eq(remoteAssignOf(JSON.stringify(taskContext(db17))), null, 'R-17c ★失败不写三键（任务保持本地可跑）');
    db17.close();

    // R-17 重放幂等
    const db18 = makeDb(); seedEnrolled(db18); seedTask(db18);
    const first = fakeDispatchIo();
    const ledger = async () => ({ nodes: [peerNode()], localNodeId: 'self-node' });
    const out18a = await dispatchCreatedTask(db18, { id: 't1', title: '实现登录模块' }, eligibleFacts(), {
      listLedger: ledger, io: first.io, emit: () => {}, nowMs: NOW.getTime(),
    });
    const secondIo = fakeDispatchIo();
    const out18b = await dispatchCreatedTask(db18, { id: 't1', title: '实现登录模块' }, eligibleFacts(), {
      listLedger: ledger, io: secondIo.io, emit: () => {}, nowMs: NOW.getTime(),
    });
    eq([out18a.ok, first.submits.length], [true, 1], 'R-17d 首次真派一单');
    eq([out18b.attempted, out18b.ok, out18b.reason, secondIo.submits.length], [false, false, 'already-dispatched', 0],
      'R-17e ★同一建单重放：**不再派第二次**（三键齐备即视为已外派）');
    db18.close();

    // R-17 ANS 回执缺目标/单号
    const db19 = makeDb(); seedEnrolled(db19); seedTask(db19);
    const out19 = await dispatchCreatedTask(db19, { id: 't1', title: '实现登录模块' }, eligibleFacts(), {
      listLedger: async () => ({ nodes: [peerNode()], localNodeId: 'self-node' }),
      io: fakeDispatchIo({ target_node_id: null }).io,
      emit: () => {}, nowMs: NOW.getTime(),
    });
    eq([out19.attempted, out19.ok, out19.reason], [true, false, 'ans-returned-incomplete'],
      'R-17f 回执缺目标 ⇒ 如实报"回执不全"（不把半截回执当成功）');
    eq(remoteAssignOf(JSON.stringify(taskContext(db19))), null, 'R-17g 回执不全 ⇒ 三键未写');
    db19.close();
  }

  // ═══ R-18 事实读取的纯函数（批三）══════════════════════════════════════════
  console.log('\n【R-18】事实读取：依赖/工作目录/载荷拼接三只小判据两侧标本');
  {
    eq([taskHasDependencies(''), taskHasDependencies('  '), taskHasDependencies('[]'), taskHasDependencies('["a"]')],
      [false, false, false, true], 'R-18a 依赖判据两侧标本（空/空白/空数组 vs 真依赖）');

    const db = makeDb();
    db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p1', '项目一', '')").run();
    db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p2', '项目二', '/tmp/本地目录')").run();
    eq([projectHasWorkingDir(db, 'p1'), projectHasWorkingDir(db, 'p2'), projectHasWorkingDir(db, 'nope')],
      [false, true, false], 'R-18b 工作目录判据两侧标本（空串/有目录/项目不存在）');
    db.close();

    eq(buildDispatchPrompt({ id: 'x', title: '标题', description: '描述', acceptanceCriteria: '标准' }),
      '标题\n\n描述\n\n验收标准：标准', 'R-18c 载荷拼接：标题/描述/验收标准各就各位');
    eq(buildDispatchPrompt({ id: 'y', title: '只有标题' }), '只有标题', 'R-18d 空描述/空验收不留空行');
  }

  // ═══ R-23 改档留痕（批四）══════════════════════════════════════════════════
  console.log('\n【R-23】改档留痕：成功恰 1 行 node.update；明细只记字段与 self，不复制档位值');
  {
    const db = makeDb();
    eq(count(db, 'wa_audit_events'), 0, 'R-23a 写前恰 0 行（正面断言的起点）');
    const wrote = recordNodeUpdate(db as unknown as AuditDb, {
      nodeId: 'peer-1', localNodeId: 'self-node', patch: { role: 'observer', weight: 2 },
    });
    eq([wrote, count(db, 'wa_audit_events')], [true, 1], 'R-23b ★调用后恰 1 行（0→1）');
    const row = db.prepare(
      'SELECT actor_kind, actor_ref, action, target_type, target_id, detail_json FROM wa_audit_events',
    ).get() as Record<string, unknown>;
    eq(
      [row.actor_kind, row.actor_ref, row.action, row.target_type, row.target_id],
      ['local', 'self-node', 'node.update', 'node', 'peer-1'],
      'R-23c 字段逐项核对（发起者 / 动作 / 对象）',
    );
    eq(JSON.parse(String(row.detail_json)), { fields: ['role', 'weight'], self: false },
      'R-23d 明细：改了哪几项 + 是否改自己（**不含档位值**——真源在 ANS 台账）');
    recordNodeUpdate(db as unknown as AuditDb, {
      nodeId: 'self-node', localNodeId: 'self-node', patch: { participate: false },
    });
    const selfRow = db.prepare('SELECT detail_json FROM wa_audit_events ORDER BY rowid DESC LIMIT 1').get() as {
      detail_json: string;
    };
    eq(JSON.parse(selfRow.detail_json), { fields: ['participate'], self: true }, 'R-23e 本机改自己：self=true');
    db.close();
  }

  // ═══ R-24 改档入口的界面判据（批四）════════════════════════════════════════
  console.log('\n【R-24】canEditNode 两侧标本：worker 本机可编 / worker 他机不可 / primary·observer 他机可编');
  {
    const self = { node_id: 'me' };
    const peer = { node_id: 'peer-1' };
    eq(
      [
        canEditNode('worker', self, 'me'),
        canEditNode('worker', peer, 'me'),
        canEditNode('primary', peer, 'me'),
        canEditNode('observer', peer, 'me'),
        canEditNode(null, peer, 'me'),
        canEditNode(undefined, self, 'me'),
      ],
      [true, false, true, true, false, true],
      'R-24 六格穷举（含"本机角色未知 ⇒ 不猜、不放行他机"）',
    );
  }

  // ═══ R-25..R-30 席位闸（批五）════════════════════════════════════════════════
  console.log('\n【R-25..R-30】席位闸：上限取 TIER_LIMITS / 只拦新增 / 邀请两跳先过闸 / 计数一处');
  {
    /** 生产同形夹具（列取 `database.ts` 的真 DDL；席位闸只看 `wa_users`）。 */
    const seatFixture = (): DatabaseSync => {
      const d = new DatabaseSync(':memory:');
      d.exec(`
        CREATE TABLE wa_users (
          id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
          avatar_url TEXT, role TEXT DEFAULT 'viewer', auth_provider TEXT DEFAULT 'authjs',
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_invite_tokens (
          id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, created_by TEXT,
          created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
          used_by TEXT, used_at TEXT
        );
        CREATE TABLE wa_oauth_accounts (
          user_id TEXT, provider TEXT NOT NULL, provider_account_id TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (provider, provider_account_id)
        );
      `);
      return d;
    };
    const addUsers = (d: DatabaseSync, n: number, prefix: string): void => {
      for (let i = 1; i <= n; i++) {
        d.prepare('INSERT INTO wa_users (id, email) VALUES (?, ?)').run(`${prefix}${i}`, `${prefix}${i}@x.test`);
      }
    };
    const tokenCount = (d: DatabaseSync): number =>
      (d.prepare('SELECT COUNT(*) AS c FROM wa_invite_tokens').get() as { c: number }).c;
    const thrown = (fn: () => void): unknown => {
      try { fn(); return null; } catch (e) { return e; }
    };
    const thrownAsync = async (fn: () => Promise<unknown>): Promise<unknown> => {
      try { await fn(); return null; } catch (e) { return e; }
    };

    // R-25：community / pro 都是 1 席（上限真源 = TIER_LIMITS，不是界面猜测）
    const d25 = seatFixture();
    addUsers(d25, 1, 'c');
    const e25 = thrown(() => assertSeatAvailable(d25 as unknown as SeatDb, 'community'));
    ok(e25 instanceof SeatLimitError, 'R-25a community 已有 1 人 ⇒ 第 2 人被拒（SeatLimitError）');
    ok(/1\/1/.test((e25 as Error).message), 'R-25b 拒绝理由含 `1/1`（不吞具体数）');
    eq(countSeats(d25 as unknown as SeatDb), 1, 'R-25c 既有成员原样在册（满员不删不降）');
    eq(seatUsage(d25 as unknown as SeatDb, 'pro').max, 1, 'R-25d Pro 同样 1 席（TIER_LIMITS 真源）');

    // R-26：team 20 席，满员拦第 21 人；去掉一人后放行
    const d26 = seatFixture();
    addUsers(d26, 20, 't');
    const e26 = thrown(() => assertSeatAvailable(d26 as unknown as SeatDb, 'team'));
    ok(e26 instanceof SeatLimitError && /20\/20/.test((e26 as Error).message),
      'R-26a team 已 20 人 ⇒ 第 21 人被拒，理由含 `20/20`');
    eq(countSeats(d26 as unknown as SeatDb), 20, 'R-26b 既有 20 人一个不少（满员不因降档被删/禁用）');
    d26.prepare('DELETE FROM wa_users WHERE id = ?').run('t20');
    const e26b = thrown(() => assertSeatAvailable(d26 as unknown as SeatDb, 'team'));
    ok(e26b === null, 'R-26c 去掉一人后同一判据放行（闸是"还能不能进"，不是"已进的算不算"）');

    // R-27/R-28：邀请两跳——发前过闸、接时先验后核销
    const d27 = seatFixture();
    addUsers(d27, 20, 'i');
    const e27 = thrown(() =>
      issueInviteToken(d27 as unknown as InviteDb, 'team', { id: 'inv1', token: 'tok1', expiresAt: '2099-01-01T00:00:00Z' }),
    );
    ok(e27 instanceof SeatLimitError && tokenCount(d27) === 0,
      'R-27a 满员时 `auth:invite` 的写口 ⇒ 令牌表 0→0（不签发接不进来的链接）');
    d27.prepare('DELETE FROM wa_users WHERE id = ?').run('i20');
    issueInviteToken(d27 as unknown as InviteDb, 'team', { id: 'inv2', token: 'tok2', expiresAt: '2099-01-01T00:00:00Z' });
    eq(tokenCount(d27), 1, 'R-27b 未满员照常 0→1');

    addUsers(d27, 1, 'j'); // 回到 20 席
    const e28 = thrown(() => claimInviteToken(d27 as unknown as InviteDb, 'team', 'tok2'));
    const usedAt28 = d27.prepare("SELECT used_at FROM wa_invite_tokens WHERE token = 'tok2'").get() as {
      used_at: string | null;
    };
    ok(e28 instanceof SeatLimitError && usedAt28.used_at === null,
      'R-28a 接邀请时满员 ⇒ 拒绝且**不核销**令牌（`used_at` 仍空）');
    d27.prepare("DELETE FROM wa_users WHERE id = 'j1'").run();
    const claim28 = claimInviteToken(d27 as unknown as InviteDb, 'team', 'tok2');
    ok(claim28.ok, 'R-28b 去掉一人后同一令牌仍可用（不是一次性烧掉）');
    ok(markInviteUsed(d27 as unknown as InviteDb, 'tok2'), 'R-28c 建用户成功后才核销');
    const after28 = d27.prepare("SELECT used_at FROM wa_invite_tokens WHERE token = 'tok2'").get() as {
      used_at: string | null;
    };
    ok(after28.used_at !== null && claimInviteToken(d27 as unknown as InviteDb, 'team', 'tok2').ok === false,
      'R-28d 核销后令牌失效（同链接不能再用）');

    // R-29：OAuth 只拦新建，既有账号在满员时照常登录
    const d29 = seatFixture();
    addUsers(d29, 1, 'owner');
    const svc = new AuthService(d29 as unknown as ConstructorParameters<typeof AuthService>[0]);
    const e29 = await thrownAsync(() =>
      svc.findOrCreateOAuth({ email: 'new@x.test', name: 'New', provider: 'github', providerAccountId: 'p-new' }),
    );
    ok(e29 instanceof SeatLimitError, 'R-29a OAuth 新建用户：满员被拒');
    eq(countSeats(d29 as unknown as SeatDb), 1, 'R-29b 被拒后用户表不动（0 新增）');
    eq((d29.prepare('SELECT COUNT(*) AS c FROM wa_oauth_accounts').get() as { c: number }).c, 0,
      'R-29c 被拒后 oauth 绑定也不落（不留下半个账号）');
    d29.prepare('INSERT INTO wa_oauth_accounts (user_id, provider, provider_account_id) VALUES (?, ?, ?)').run(
      'owner1', 'github', 'p-existing',
    );
    const existing29 = await svc.findOrCreateOAuth({
      email: 'owner1@x.test', name: 'Owner', provider: 'github', providerAccountId: 'p-existing',
    });
    ok(typeof existing29.accessToken === 'string' && existing29.accessToken.length > 0 && countSeats(d29 as unknown as SeatDb) === 1,
      'R-29d 既有用户满员仍可登录（令牌正面断言；不因满员被挡）');

    // R-30：`license:status.seats.used` 与 `countSeats` 同一个数（不另算一份）
    const usage30 = seatUsage(d29 as unknown as SeatDb, 'community');
    eq(usage30.used, countSeats(d29 as unknown as SeatDb), 'R-30a seats.used === countSeats（一处计数）');
    eq(seatUsage(d29 as unknown as SeatDb, 'team').max, 20, 'R-30b team 上限 20 由 TIER_LIMITS 取（界面不手抄）');

    d25.close(); d26.close(); d27.close(); d29.close();
  }

  // ═══ R-34 团队共享库本地侧（批六）══════════════════════════════════════════
  console.log('\n【R-34】团队共享库本地侧：候选 / 组装 / 导入映射（三表真落点）');
  {
    // 生产同形夹具（列取 `database.ts` 真 DDL；不比生产宽松）。
    const teamFixture = (): DatabaseSync => {
      const d = new DatabaseSync(':memory:');
      d.exec(`
        CREATE TABLE wa_task_templates (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
          description TEXT DEFAULT '', subtasks TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]',
          status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
          source TEXT DEFAULT 'user', match_count INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE wa_memories (
          id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
          content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
          importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
          user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
          is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE wa_deliverables (
          id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
          type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '',
          file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
        );
        -- zx_20261021_3 批三：共享库第四类 domain_pack 的资产表与启用映射（逐列照抄 database.ts）
        CREATE TABLE wa_domain_packs (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
          pack_json TEXT NOT NULL, source_project_id TEXT, source_project_name TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE wa_project_domain_packs (
          project_id TEXT NOT NULL, pack_id TEXT NOT NULL,
          applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, pack_id)
        );
        -- 画像候选按 project_id LEFT JOIN 项目名（生产同句）⇒ 夹具须有 projects 表。
        CREATE TABLE wa_projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
          status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
        );
        -- zx_20261022_3 批八：共享库第五类 project_profile 的资产表（逐列照抄 database.ts）。
        --   ⚠ 夹具缺此表 ⇒ listLocalItems 的画像读语句在运行时抛 no such table（本套件实测踩中）。
        CREATE TABLE wa_project_profiles (
          project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
          source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
          generated_at TEXT DEFAULT (datetime('now')), enabled INTEGER NOT NULL DEFAULT 1,
          origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT ''
        );
      `);
      return d;
    };
    const thrownOf = (fn: () => unknown): unknown => {
      try { fn(); return null; } catch (e) { return e; }
    };

    // 词表与上限：唯一真源在 shared-types（ANS 与桌面同引）
    // zx_20261022_3 批八：`project_profile` 入册（4→5；逐成员枚举仍不放宽）。
    eq([...TEAM_ITEM_KINDS], ['template', 'memory', 'deliverable', 'domain_pack', 'project_profile'],
      'R-34a 共享类型词表**逐成员枚举**（唯一定处 `packages/shared-types/src/team.ts`）');
    for (const k of TEAM_ITEM_KINDS) {
      ok(isTeamItemKind(k) && TEAM_ITEM_KIND_LABEL[k].length > 0,
        `R-34b 人话名非空：${k} ⇒ 「${TEAM_ITEM_KIND_LABEL[k]}」`);
    }
    eq([isTeamItemKind('bogus'), isTeamItemKind('')], [false, false], 'R-34c 词表外值 ⇒ 不认');
    eq([TEAM_ITEM_MAX_TITLE, TEAM_ITEM_MAX_BODY_BYTES, TEAM_ITEM_MAX_PER_NODE], [200, 65536, 500],
      'R-34d 三道上限值同源（标题字符 / 载荷字节 / 单节点条数——改上限只改一处）');

    const d = teamFixture();
    d.prepare(`INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords)
               VALUES ('tpl-1', '周报模板', 'report', '每周固定产出', '["写进展","写风险"]', '["周报","汇报"]')`).run();
    d.prepare(`INSERT INTO wa_memories (id, content, memory_type, importance, reasoning)
               VALUES ('mem-1', '用户偏好中文回复', 'semantic', 0.8, '多次对话确认')`).run();
    d.prepare(`INSERT INTO wa_deliverables (id, type, name, description, file_path, status)
               VALUES ('del-1', 'doc', '项目报告', '报告正文', '/secret/path/report.md', 'ready')`).run();
    // zx_20261021_3 批三：第四类候选（资产行即可，是否启用是另一张表的事）。
    const localPack = {
      version: 1,
      name: '客厅自动化经验',
      description: '可携带的三节',
      sections: [{ section: 'domain', content: '术语：场景＝一组设备联动' }],
      source: { project_id: 'proj-1', project_name: '智能家居' },
      derived_at: '2026-10-21T00:00:00.000Z',
      training: false,
      omitted_sections: [],
    };
    d.prepare(`INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name)
               VALUES ('dp-1', '客厅自动化经验', '可携带的三节', ?, 'proj-1', '智能家居')`)
      .run(JSON.stringify(localPack));
    // zx_20261022_3 批八：第五类候选（画像一项目一份；`localId` = project_id）。
    d.prepare(`INSERT INTO wa_project_profiles (project_id, version, source_hash, profile_json, origin, source_project_name, enabled)
               VALUES ('prof-1', 1, 'h-1', '{}', 'imported', '远端项目', 0)`).run();

    // 本地候选：五类各一列（纯本地读）
    const local = listLocalItems(d as unknown as Parameters<typeof listLocalItems>[0]);
    const candidateLists = [local.templates, local.memories, local.deliverables, local.domainPacks, local.profiles];
    eq(candidateLists.map((l) => l.length), [1, 1, 1, 1, 1], 'R-34e 候选五列各 1 条');
    ok(!local.truncated, 'R-34e2 未截断');
    // 类目集合**由词表派生**（不写死 3/4）：下次再加一维时，此判据只问"实现是否覆盖词表"。
    eq([...new Set(candidateLists.flat().map((x) => x.kind))].sort(), [...TEAM_ITEM_KINDS].sort(),
      'R-34e3 ★候选列覆盖词表全部类目（由 `TEAM_ITEM_KINDS` 派生）');
    eq([local.templates[0]!.kind, local.templates[0]!.localId, local.templates[0]!.title, local.templates[0]!.subtitle],
      ['template', 'tpl-1', '周报模板', 'report'], 'R-34f 模板候选形状（kind/localId/title/subtitle）');
    eq([local.memories[0]!.title, local.memories[0]!.subtitle], ['用户偏好中文回复', 'semantic'],
      'R-34g 记忆候选：标题取内容、副标题取类型');
    eq([local.deliverables[0]!.title, local.deliverables[0]!.subtitle], ['项目报告', 'doc · ready'],
      'R-34h 成果候选：名称优先、副标题「类型 · 状态」');
    eq([local.domainPacks[0]!.kind, local.domainPacks[0]!.localId, local.domainPacks[0]!.title, local.domainPacks[0]!.subtitle],
      ['domain_pack', 'dp-1', '客厅自动化经验', '可携带的三节 · 源自 智能家居'],
      'R-34h2 领域包候选：名称/描述/出处（出处只留项目名）');

    // 组装载荷
    const lib = d as unknown as Parameters<typeof shareItem>[0];
    const tpl = shareItem(lib, 'template', 'tpl-1');
    eq([tpl.kind, tpl.title, tpl.body.name, tpl.body.category],
      ['template', '周报模板', '周报模板', 'report'], 'R-34i 模板载荷：标题/名称/类目就位');
    eq([tpl.body.subtasks, tpl.body.keywords], [['写进展', '写风险'], ['周报', '汇报']],
      'R-34j JSON 列解成真数组（不是把字符串原样塞出去）');

    const mem = shareItem(lib, 'memory', 'mem-1');
    eq([mem.kind, mem.title, mem.body.content, mem.body.memory_type, mem.body.importance],
      ['memory', '用户偏好中文回复', '用户偏好中文回复', 'semantic', 0.8],
      'R-34k 记忆载荷：内容/类型/重要度随行');

    const del = shareItem(lib, 'deliverable', 'del-1');
    eq([del.kind, del.title, del.body.type, del.body.status], ['deliverable', '项目报告', 'doc', 'ready'],
      'R-34l 成果载荷只带元数据');
    ok(!('file_path' in del.body), 'R-34m ★成果载荷**无 file_path** 键（不传文件）');
    ok(!JSON.stringify(del).includes('/secret/path'),
      'R-34n ★★路径字面量在整条载荷里**不出现**（不是"键删了值还在"）');

    const pack = shareItem(lib, 'domain_pack', 'dp-1');
    eq([pack.kind, pack.title, pack.body.sections.length, pack.body.training],
      ['domain_pack', '客厅自动化经验', 1, false],
      'R-34n2 领域包载荷：包体三节随行、`training:false` 写死（不用于训练）');
    eq([pack.body.version, pack.body.source.project_name], [1, '智能家居'],
      'R-34n3 版本与出处随包里走；本机项目 id 由**导入侧**置空（见 R-34z6）');

    // 导入映射：三表各 0→1（正面断言），id 新发不覆盖本地行
    const remoteTpl: TeamItem = {
      id: 'remote-tpl', kind: 'template', title: '远端模板',
      body: { name: '远端模板', description: '说明', subtasks: ['a'], keywords: ['k'] },
      source_node_id: 'peer-9', created_at: '2026-10-17 00:00:00', updated_at: '2026-10-17 00:00:00',
    };
    const rTpl = importItem(d as unknown as Parameters<typeof importItem>[0], remoteTpl);
    eq([rTpl.kind, rTpl.target], ['template', 'wa_task_templates'], 'R-34o 模板落到 `wa_task_templates`');
    eq(count(d, 'wa_task_templates'), 2, 'R-34p 计数 1→2（正面断言）');
    const tplRow = d.prepare('SELECT name, category, source, status, subtasks FROM wa_task_templates WHERE id = ?')
      .get(rTpl.id) as Record<string, unknown>;
    eq([tplRow.name, tplRow.category, tplRow.source, tplRow.status],
      ['远端模板', 'shared', 'team_library', 'active'], 'R-34q 类目缺省 `shared` / 来源 `team_library`');
    eq(JSON.parse(String(tplRow.subtasks)), ['a'], 'R-34r 子任务数组原样落库');
    ok(rTpl.id !== remoteTpl.id, 'R-34s ★导入新发 id（不覆盖本地行）');

    const remoteMem: TeamItem = {
      id: 'remote-mem', kind: 'memory', title: '远端记忆',
      body: { content: '共享经验', importance: 0.9, reasoning: '来源一句' },
      source_node_id: 'peer-9', created_at: '2026-10-17 00:00:00', updated_at: '2026-10-17 00:00:00',
    };
    const rMem = importItem(d as unknown as Parameters<typeof importItem>[0], remoteMem);
    eq([rMem.target, count(d, 'wa_memories')], ['wa_memories', 2], 'R-34t 记忆落 `wa_memories`（1→2）');
    const memRow = d.prepare('SELECT content, memory_type, source, importance FROM wa_memories WHERE id = ?')
      .get(rMem.id) as Record<string, unknown>;
    eq([memRow.content, memRow.memory_type, memRow.source, memRow.importance],
      ['共享经验', 'semantic', 'team_library', 0.9], 'R-34u 类型归 `semantic` / 来源可辨 / 重要度随行');

    const remoteDel: TeamItem = {
      id: 'remote-del', kind: 'deliverable', title: '远端报告',
      body: { type: 'doc', name: '远端报告', description: '只元数据', status: 'ready' },
      source_node_id: 'peer-9', created_at: '2026-10-17 00:00:00', updated_at: '2026-10-17 00:00:00',
    };
    const rDel = importItem(d as unknown as Parameters<typeof importItem>[0], remoteDel);
    eq([rDel.target, count(d, 'wa_deliverables')], ['wa_deliverables', 2], 'R-34v 成果落 `wa_deliverables`（1→2）');
    const delRow = d.prepare('SELECT file_path, status, name FROM wa_deliverables WHERE id = ?')
      .get(rDel.id) as Record<string, unknown>;
    eq([delRow.file_path, delRow.status, delRow.name], [null, 'draft', '远端报告'],
      'R-34w ★★导入成果 file_path=NULL、状态 draft（只元数据；不假装有文件）');

    const remotePack: TeamItem = {
      id: 'remote-pack', kind: 'domain_pack', title: '远端经验',
      body: {
        version: 1,
        name: '远端经验',
        description: '对端整理的三节',
        sections: [{ section: 'criteria', content: '验收：并发不超过 4' }],
        source: { project_id: 'peer-proj-7', project_name: '远端项目' },
        derived_at: '2026-10-17T00:00:00.000Z',
        training: false,
        omitted_sections: [],
      },
      source_node_id: 'peer-9', created_at: '2026-10-17 00:00:00', updated_at: '2026-10-17 00:00:00',
    };
    const projectsBefore = count(d, 'wa_project_domain_packs');
    const rPack = importItem(d as unknown as Parameters<typeof importItem>[0], remotePack);
    eq([rPack.kind, rPack.target], ['domain_pack', 'wa_domain_packs'], 'R-34z 领域包落到 `wa_domain_packs`');
    eq(count(d, 'wa_domain_packs'), 2, 'R-34z2 资产计数 1→2（正面断言：真的落了一行）');
    eq([projectsBefore, count(d, 'wa_project_domain_packs')], [0, 0],
      'R-34z3 ★★导入≠启用：启用映射表**始终 0 行**（导入只入库，不替用户做决定）');
    const packRow = d.prepare('SELECT name, description, pack_json, source_project_id, source_project_name FROM wa_domain_packs WHERE id = ?')
      .get(rPack.id) as Record<string, unknown>;
    eq([packRow.name, packRow.description, packRow.source_project_id, packRow.source_project_name],
      ['远端经验', '对端整理的三节', null, '远端项目'],
      'R-34z4 名称/描述/出处随行；**本机项目 id 置 NULL**（跨机无意义）');
    const importedPack = JSON.parse(String(packRow.pack_json)) as {
      training: boolean; sections: unknown[]; source: { project_id: string; project_name: string };
    };
    eq([importedPack.training, importedPack.sections.length, importedPack.source.project_id, importedPack.source.project_name],
      [false, 1, '', '远端项目'],
      'R-34z5 ★包体内 `training:false` 保真、节数与出处可读；内层 project_id 亦置空串');
    ok(rPack.id !== remotePack.id, 'R-34z6 导入新发 id（不覆盖本机同名包）');

    const e1 = thrownOf(() => shareItem(lib, 'template', 'nope'));
    ok(e1 instanceof TeamLibraryError && /模板不存在/.test(e1.message),
      'R-34x 本地行不存在 ⇒ 如实抛（不冒充分享成功）');
    const e2 = thrownOf(() =>
      importItem(d as unknown as Parameters<typeof importItem>[0], { ...remoteTpl, kind: 'bogus' as never }));
    ok(e2 instanceof TeamLibraryError && /未知的共享类型/.test(e2.message),
      'R-34y 未知类型 ⇒ 拒绝（词表外不落库）');
    const e3 = thrownOf(() =>
      importItem(d as unknown as Parameters<typeof importItem>[0], {
        ...remotePack, body: { name: '空壳' } as never,
      }));
    ok(e3 instanceof TeamLibraryError && /不是合法的领域包/.test(e3.message),
      'R-34y2 ★坏包（无 sections）⇒ 拒绝且不落库');
    eq(count(d, 'wa_domain_packs'), 2, 'R-34y3 坏包被拒后资产计数不变（不是"先写再回滚"）');
    d.close();
  }

  // ═══ R-35 Team 闸先于网络（批六）════════════════════════════════════════════
  console.log('\n【R-35】团队共享库闸：锁定 ⇒ 拒因；任何网络调用之前先过闸');
  {
    const shut = settingsDb(false);
    const refuse = teamFeatureRefusal(shut, 'team_library', { now: NOW, fingerprint: FP });
    ok(typeof refuse === 'string' && refuse.includes('团队共享库') && refuse.includes('团队版'),
      'R-35a ★社区档 ⇒ 如实拒因（含人话名与升级指引）', refuse ?? '');
    const open = settingsDb(true);
    eq(teamFeatureRefusal(open, 'team_library', { now: NOW, fingerprint: FP }), null,
      'R-35b ★另一侧标本：试用期 ⇒ 放行');
    shut.close(); open.close();

    const ipc = STRIPPED(`${A}/src/main/ipc/team.ipc.ts`);
    const handlers = ipc.split('ipcMain.handle(').slice(1);
    eq(handlers.length, 4, 'R-35c 四个通道在册（items / share / import / delete）');
    let networkBlocks = 0;
    for (const h of handlers) {
      const name = (h.match(/'([^']+)'/) ?? [])[1] ?? '?';
      ok(h.includes('gateError(db)') && h.includes('if (gate) return gate;'),
        `R-35d ${name}：先过 Team 闸（壳里不另写档位判断）`);
      if (h.includes('ansSignedRequest(')) {
        networkBlocks++;
        ok(h.indexOf('if (gate) return gate;') < h.indexOf('ansSignedRequest('),
          `R-35e ★${name}：闸门判据在**网络调用之前**（锁定不触 ANS）`);
      }
    }
    eq(networkBlocks, 3, 'R-35f 恰三个通道触网（import 纯本地），逐块次序钉死');
  }

  // ═══ R-36 显式分享（批六）══════════════════════════════════════════════════
  console.log('\n【R-36】分享是显式动作：列表加载零写调用');
  {
    const page = RD(`${A}/renderer/src/pages/TeamLibraryPage.tsx`);
    eq((page.match(/teamApi\.share\(/g) ?? []).length, 1,
      'R-36a ★全页恰一处 `teamApi.share(`（不存在"渲染即上传"的第二通路）');
    const loaderStart = page.indexOf('useLiveQuery<LoadState>');
    const loaderEnd = page.indexOf('}, []);', loaderStart);
    const loaderBody = loaderStart >= 0 && loaderEnd > loaderStart ? page.slice(loaderStart, loaderEnd) : '';
    ok(loaderBody.includes('teamApi.items(') && !/teamApi\.(share|importItem|remove)\(/.test(loaderBody),
      'R-36b ★★取数区（`useLiveQuery<LoadState>` 体内）只读 `items`，零写调用（打开页面不上传）');
    const shareAt = page.indexOf('teamApi.share(');
    const handlerAt = page.indexOf('function handleShare(');
    ok(handlerAt >= 0 && handlerAt < shareAt && shareAt < page.indexOf('function handleImport('),
      'R-36c 唯一的 share 调用落在 `handleShare` 内（用户点击才走到）');
    ok(/onShare=\{handleShare\}/.test(page) && /onImport=\{handleImport\}/.test(page) && /onDelete=\{handleDelete\}/.test(page),
      'R-36d 三动作各由显式点击入口驱动');
    ok(/item\.source_node_id === payload\.localNodeId/.test(page),
      'R-36e 删除按钮只出现在本机分享的行上（他机条目删不掉）');
  }

  // ═══ 批七｜项目知识包：三节派生 / 预算 / 导出 / 预览同源 ═══════════════════════
  console.log('\n【R-37】知识包三节：从既有行派生（0→1 正反证）');
  {
    const db = makeKnowledgeDb();
    const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
    const secs = () => deriveProjectKnowledge(db as never, 'p1');
    eq(secs(), [], 'R-37a ★空项目 ⇒ 空册（"没发生"不伪造壳）');

    ins(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
      'k1', 'p1', '布置客厅', 'pending', '{}', '灯亮且门锁上');
    ins(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
      'k2', 'p1', '开灯', 'failed', JSON.stringify({ pause_reason: 'acceptance_failed' }), '');
    eq(secs().map((s) => s.section), ['criteria', 'index'],
      'R-37b ★★1 条判据 + 1 条失败 ⇒ `criteria` 由 0 变 1（失败任务同时是终态 ⇒ 进 `index`）');
    const crit = secs().find((s) => s.section === 'criteria')!;
    ok(crit.content.includes('验收 灯亮且门锁上') && crit.content.includes('失败 1 项：验收未通过 ×1'),
      'R-37c ★判据原文 + 失败因由（经 `pause-reason.ts` 说人话）都在场');

    ins(`INSERT INTO wa_task_templates (id, name, category, description, status, priority) VALUES (?,?,?,?,?,?)`,
      'tpl1', '布置客厅', 'home', '先清点后摆放', 'active', 5);
    eq(secs().map((s) => s.section), ['criteria', 'recipes', 'index'],
      'R-37d ★★1 个 active 模板 ⇒ `recipes` 由 0 变 1');

    ins(`INSERT INTO wa_memories (id, project_id, content, memory_type, is_exemplar) VALUES (?,?,?,?,?)`,
      'm1', 'p1', '先清点再摆放，避免返工', 'semantic', 1);
    const rec = secs().find((s) => s.section === 'recipes')!;
    ok(rec.content.includes('模板（home）：布置客厅') && rec.content.includes('已验证：先清点再摆放'),
      'R-37e ★模板 + 本项目已验证样板同节（全局模板库如实照它的形状读）');

    ins(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
      'd1', 'p1', 'code', 'active', 'main.ts', 'src/main.ts');
    eq(secs().map((s) => s.section), ['artifacts', 'usage', 'criteria', 'recipes', 'index'],
      'R-37f ★★1 条交付物 ⇒ `index` 由 0 变 1（交付物/活记忆/终态任务三源之一）；'
      + 'zx_20261018_2 批四起交付量同时点亮 `usage`（同一次派生、不同尺）');
    ok(secs().find((s) => s.section === 'index')!.content.includes('交付物[code/active] main.ts'),
      'R-37g index 行文如实带类型/状态/名字');

    // 反证：源撤掉 ⇒ 节如实消失（不留陈旧壳）。
    ins('DELETE FROM wa_task_templates');
    ins('DELETE FROM wa_memories WHERE is_exemplar = 1');
    eq(secs().map((s) => s.section), ['artifacts', 'usage', 'criteria', 'index'],
      'R-37h ★★反证：配方源撤掉 ⇒ `recipes` 消失（`usage` 因交付物仍在而保留）');
    ins('DELETE FROM wa_tasks');
    ins('DELETE FROM wa_deliverables');
    eq(secs(), [], 'R-37i ★★反证：全部源撤掉 ⇒ 空册（此刻可派生者才在册）');
    db.close();
  }

  console.log('\n【R-38】预算一把尺：超预算整节被挡、绝不截字');
  {
    const db = makeKnowledgeDb();
    const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
    ins(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
      't1', 'p1', '甲', 'uses', '乙'.repeat(2000), 0.9);
    ins(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
      'k1', 'p1', '布置客厅', 'pending', '{}', '灯亮且门锁上');
    ins(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
      'd1', 'p1', 'code', 'active', 'main.ts', 'src/main.ts');
    upsertProjectKnowledge(db as never, 'p1', deriveProjectKnowledge(db as never, 'p1'));
    const prev = previewProjectKnowledge(db as never, 'p1', null);
    eq(prev.budgetTokens, KNOWLEDGE_INJECT_MAX_TOKENS, 'R-38a ★预览预算 = 注入常量（不是第二份预算）');
    ok(!prev.selected.some((s) => s.section === 'entities'), 'R-38b ★★超预算的节整节被挡在门外');
    ok(prev.omitted.some((s) => s.section === 'entities'), 'R-38c ★被挡的节在 `omitted` 里如实列出（不假装"没有"）');
    const used = prev.selected.reduce((n, s) => n + s.tokens, 0);
    ok(used <= prev.budgetTokens, 'R-38d ★选中节 token 合计 ≤ 预算', `${used}/${prev.budgetTokens}`);
    const ents = listProjectKnowledge(db as never, 'p1').find((e) => e.section === 'entities')!;
    ok(prev.omitted.find((s) => s.section === 'entities')!.content === ents.content,
      'R-38e ★★整节原文在场（**绝不截字**——结构不破）');

    const pk = STRIPPED(`${A}/src/main/core/project-knowledge.ts`);
    const mc = STRIPPED(`${A}/src/main/core/memory-context.ts`);
    ok(/selectKnowledgeForInject\s*\(/.test(mc) && /KNOWLEDGE_INJECT_MAX_TOKENS/.test(mc),
      'R-38f ★注入侧与预览侧同引 `selectKnowledgeForInject` + `KNOWLEDGE_INJECT_MAX_TOKENS`（同一把尺）');
    ok(/selectKnowledgeForInject\(\s*book,\s*archetype,\s*KNOWLEDGE_INJECT_MAX_TOKENS\s*\)/.test(pk),
      'R-38g ★预览真调同一个择节函数并吃同一常量（静态钉形状）');
    db.close();
  }

  console.log('\n【R-39】导出 JSONL：每行 training:false（仅导出，不训练）');
  {
    const db = makeKnowledgeDb();
    const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
    ins(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
      'k1', 'p1', '布置客厅', 'pending', '{}', '灯亮且门锁上');
    ins(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
      'd1', 'p1', 'code', 'active', 'main.ts', 'src/main.ts');
    upsertProjectKnowledge(db as never, 'p1', deriveProjectKnowledge(db as never, 'p1'));
    const entries = listProjectKnowledge(db as never, 'p1');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kp-export-'));
    const now = new Date('2026-10-17T08:00:00.000Z');
    const res = writeKnowledgeExport('p1', entries, dir, now);
    const text = fs.readFileSync(res.filePath, 'utf-8');
    const lines = text.trim().split('\n');
    // zx_20261022_3 批七（钉更强形状）: 文件 = **包头 1 行 + 每节 1 行**；`res.rows` 仍只数节行。
    //   旧断言"行数 = 节数"在新形状下为零信息（包头也算一行就错）；改为"节行恰 res.rows 行，且首行是自描述包头"。
    eq(lines.length, res.rows + 1, 'R-39a 文件行数 = 包头 1 行 + 册的节数（整册导出，不是注入子集）');
    eq(res.rows, entries.length, 'R-39b 导出的是**整册**（不截内容、不按预算裁节）');
    const header = JSON.parse(lines[0]!) as { kind?: unknown; version?: unknown; sections?: unknown; project_id?: unknown };
    ok(header.kind === 'wa-knowledge' && header.version === 1 && header.sections === res.rows && header.project_id === 'p1',
      'R-39a2 ★★首行是自描述包头（kind/version/sections/project_id）——导入侧凭它认包与自校验');
    const dataLines = lines.slice(1);
    eq(dataLines.length, res.rows, 'R-39a3 包头之外恰为节行数（不多不少）');
    const missing = dataLines.filter((l) => {
      try { return (JSON.parse(l) as { training?: unknown }).training !== false; } catch { return true; }
    });
    eq(missing.length, 0, 'R-39c ★★每节行解析出的 `training` 恒为 false（缺键/坏 JSON 即计数）');
    ok(lines.every((l) => l.includes('"training":false')), 'R-39d ★含包头在内每行都带 `"training":false`（形状本身即声明）');
    const metas = dataLines.map((l) => (JSON.parse(l) as { meta: { source: string; project_id: string; generated_at: string } }).meta);
    ok(metas.every((m) => m.source === KNOWLEDGE_PACK_SOURCE && m.project_id === 'p1'
      && typeof m.generated_at === 'string' && m.generated_at.length > 0),
      'R-39e 每行 meta 带来源/项目/生成时刻（下游据此认"这不是训练集"）');
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }

  console.log('\n【R-40】导出文件名与按日覆盖（UTC 基准、now 可注入）');
  {
    eq(knowledgeExportFileName('p1', new Date('2026-10-17T16:30:00.000Z')), 'p1-20261017.jsonl',
      'R-40a ★★日期取 **UTC**（本地已是 18 日，文件名仍 17 日——与库内 `datetime(\'now\')` 同基准）');
    eq(knowledgeExportFileName('a/b ..c', new Date('2026-10-17T08:00:00.000Z')), 'a_b_..c-20261017.jsonl',
      'R-40b 路径分隔符洗成 `_`（不许越出导出目录）');
    eq(knowledgeExportFileName('', new Date('2026-10-17T08:00:00.000Z')), 'project-20261017.jsonl',
      'R-40c 空项目 id 回退为 `project`（不产生以 `-` 开头的文件名）');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kp-overwrite-'));
    const now = new Date('2026-10-17T08:00:00.000Z');
    const two = [
      { section: 'entities' as const, content: '甲 → 乙', sourceRef: 'wa_knowledge_triples' },
      { section: 'artifacts' as const, content: 'code:1', sourceRef: 'wa_deliverables' },
    ];
    const r1 = writeKnowledgeExport('p1', two, dir, now);
    const r2 = writeKnowledgeExport('p1', two.slice(0, 1), dir, now);
    eq(r1.filePath, r2.filePath, 'R-40d 同日重复导出 ⇒ 同一路径（覆盖，不是追加）');
    eq(fs.readdirSync(path.join(dir, KNOWLEDGE_EXPORT_DIR)).length, 1, 'R-40e 导出目录内仍只一份');
    // zx_20261022_3 批七（钉更强形状）: 后一份 = 包头 + 1 节 = 2 行，且包头自报 sections:1。
    const r2Lines = fs.readFileSync(r2.filePath, 'utf-8').trim().split('\n');
    eq(r2Lines.length, 2, 'R-40f ★后一份即全部（包头 + 1 节；不留上一份的残行）');
    eq((JSON.parse(r2Lines[0]!) as { sections?: unknown }).sections, 1,
      'R-40f2 覆盖后包头自报的节数同步为 1（与实际节行一致，不自相矛盾）');
    ok(r1.filePath.includes(`${KNOWLEDGE_EXPORT_DIR}${path.sep}`), 'R-40g 落在 `<dataDir>/knowledge_exports/` 下');
    eq(r2.generated_at, now.toISOString(), 'R-40h `generated_at` 由 `now` 注入（rr 不碰真实墙钟）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【R-41】预览与注入同一取数（看到的 = 真会用的）');
  {
    const db = makeKnowledgeDb();
    const ins = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
    ins(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
      't1', 'p1', '客厅台灯', 'controlled_by', 'worker-ant', 0.9);
    ins(`INSERT INTO wa_deliverables (id, project_id, type, status, name, file_path) VALUES (?,?,?,?,?,?)`,
      'd1', 'p1', 'code', 'active', 'main.ts', 'src/main.ts');
    ins(`INSERT INTO wa_service_calls (id, project_id, kind, target, operation, ok, duration_ms) VALUES (?,?,?,?,?,?,?)`,
      'sc1', 'p1', 'mcp', 'filesystem', 'read', 1, 12);
    ins(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
      'k1', 'p1', '布置客厅', 'completed', '{}', '灯亮且门锁上');
    ins(`INSERT INTO wa_task_templates (id, name, category, description, status, priority) VALUES (?,?,?,?,?,?)`,
      'tpl1', '布置客厅', 'home', '先清点后摆放', 'active', 5);
    ins(`INSERT INTO wa_memories (id, project_id, content, memory_type, is_exemplar) VALUES (?,?,?,?,?)`,
      'm1', 'p1', '先清点再摆放', 'semantic', 1);
    upsertProjectKnowledge(db as never, 'p1', deriveProjectKnowledge(db as never, 'p1'));
    const book = listProjectKnowledge(db as never, 'p1');

    for (const archetype of [null, 'code'] as const) {
      const expect = selectKnowledgeForInject(book, archetype, KNOWLEDGE_INJECT_MAX_TOKENS);
      const prev = previewProjectKnowledge(db as never, 'p1', archetype);
      eq(prev.selected.map((s) => s.section), expect.map((e) => e.section),
        `R-41a ★★形态=${archetype ?? 'null'}：预览选中节 = 注入选中节`);
      eq(prev.selected.map((s) => s.content), expect.map((e) => e.content),
        `R-41b ★形态=${archetype ?? 'null'}：逐节原文全等（没有第二份取数）`);
      ok(prev.selected.every((s, i) => s.tokens === estimateTokensFromChars(expect[i]!.content.length)),
        'R-41c 逐节 token = `token-estimate.ts` 同一口径');
      ok(prev.selected.every((s) => s.lines === s.content.split(/\r?\n/).filter((l) => l.trim().length > 0).length),
        'R-41d 逐节行数如实（非空行数）');
      eq(prev.selected.length + prev.omitted.length, book.length,
        'R-41e 选中 + 被挡 = 整册（没有哪一节既不注入也不说明）');
    }

    const all = PROJECT_KNOWLEDGE_SECTIONS.map((section) => ({ section, content: section, sourceRef: 'x' }));
    eq(orderKnowledgeSections(all as never, null).map((e) => e.section), [...PROJECT_KNOWLEDGE_SECTIONS],
      'R-41f 未列形态 ⇒ 词表序（新增节不必回改偏好表）');
    eq(orderKnowledgeSections(all as never, 'code').at(-1)?.section, 'runtime',
      'R-41g ★★`runtime` 恒末位（显式最后，不靠词表碰巧排在末尾）');

    const pk = STRIPPED(`${A}/src/main/core/project-knowledge.ts`);
    const previewBody = pk.slice(pk.indexOf('export function previewProjectKnowledge'));
    ok(previewBody.includes('listProjectKnowledge(') && previewBody.includes('selectKnowledgeForInject(')
      && previewBody.includes('KNOWLEDGE_INJECT_MAX_TOKENS'),
      'R-41h ★★预览体内：读同一本册 + 调同一择节函数 + 吃同一常量');
    const mc = STRIPPED(`${A}/src/main/core/memory-context.ts`);
    ok(/from '\.\/project-knowledge\.js'/.test(mc) && /selectKnowledgeForInject\s*\(/.test(mc),
      'R-41i ★注入侧（`memory-context.ts`）与预览同源引入');
    db.close();
  }

  // ═══ 接线（批二）════════════════════════════════════════════════════════════
  console.log('\n【W】批二接线：库表 / IPC 注册 / 写点 / 渲染面');
  {
    const dbSrc = RD(`${A}/src/main/database.ts`);
    ok(/CREATE TABLE IF NOT EXISTS wa_audit_events/.test(dbSrc), 'W-1 建表在 `database.ts`（与生产同处）');
    ok(/idx_audit_events_time/.test(dbSrc) && /idx_audit_events_action/.test(dbSrc),
      'W-2 两个索引齐（时间倒序分页 / 动作筛选）');

    const idx = STRIPPED(`${A}/src/main/index.ts`);
    ok(/initAuditIpc\(db,\s*dataDir\)/.test(idx),
      'W-3 启动接线：`initAuditIpc(db, dataDir)` 真被调用（导出落点随 dataDir，非壳内另造）');

    const auditIpc = STRIPPED(`${A}/src/main/ipc/audit.ipc.ts`);
    ok(/listAuditEventsGated\s*\(/.test(auditIpc), 'W-4 IPC 走 core 的"先闸后读"（不在壳里另写一份判据）');
    ok(/TEAM_REQUIRED/.test(auditIpc), 'W-5 锁定如实回 `TEAM_REQUIRED`（不返回空表冒充无记录）');

    const dispatcher = STRIPPED(`${A}/src/main/core/node-dispatcher.ts`);
    ok(/recordAudit\s*\(/.test(dispatcher) && /'node\.dispatch'/.test(dispatcher),
      'W-6 派活写点：成功派发后写 `node.dispatch`');
    const licIpc = STRIPPED(`${A}/src/main/ipc/license.ipc.ts`);
    ok(/recordAudit\s*\(/.test(licIpc) && /'license\.activate'/.test(licIpc),
      'W-7 许可写点：激活成功后写 `license.activate`');
    ok(!/licenseText/.test(licIpc.split("'license.activate'")[1] ?? ''),
      'W-8 ★审计明细**不含许可原文**（只记档位/类型/到期）');

    const nav = RD(`${A}/renderer/src/lib/navConfig.ts`);
    ok(/to:\s*'\/audit'/.test(nav), 'W-9 导航新增「审计视图」入口（renderer 是词表第二落点）');
    const app = RD(`${A}/renderer/src/App.tsx`);
    ok(/lazy\(\(\)\s*=>\s*import\('\.\/pages\/AuditPage'\)\)/.test(app) && /path="\/audit"/.test(app),
      'W-10 路由与懒加载齐（页面点得到）');
    const page = RD(`${A}/renderer/src/pages/AuditPage.tsx`);
    ok(/core\/audit-labels\.js/.test(page) && !/const\s+AUDIT_SOURCE_LABEL/.test(page),
      'W-11 页面**引**词表真源而**不自抄**一份（第二落点已防）');

    // ── 批三：建单即派的接线（一侧真源 + 两跳出口 + 渲染面）──────────────────────
    const proj = STRIPPED(`${A}/src/main/ipc/project.ipc.ts`);
    const replayAt = proj.indexOf('if (hit) return { data: hit };');
    const dispatchAt = proj.indexOf('dispatchCreatedTask(');
    ok(replayAt >= 0 && dispatchAt > replayAt,
      'W-12 ★建单即派在 `client_request_id` 重放**早返回之后**（重放不再派一次）');
    for (const key of ['settingOn', 'teamUnlocked', 'enrolled', 'hasParent', 'hasDependencies',
      'hasAttachments', 'hasWorkingDir', 'decomposed', 'category']) {
      // 键形或简写皆可（`decomposed,` 是简写）；只看事实对象里确有这么一格。
      ok(new RegExp(`\\b${key}\\b\\s*[:,}]`).test(proj), `W-13 准入事实逐项组齐：${key}`);
    }
    ok(/teamFeatureRefusal\([^)]*'multi_node'/.test(proj), 'W-14 档位闸取 Team 词表真源（不另写档位判断）');
    ok(/decomposed\s*=\s*decomposedCount\s*>\s*0/.test(proj), 'W-15 拆解事实取**真实写入行数**（不是"命中模板"就算）');
    ok(/task\.dispatch\s*=\s*dispatchOutcome/.test(proj), 'W-16 外派结局如实回执（`dispatch` 键，机器可读理由）');

    const nIpc = STRIPPED(`${A}/src/main/ipc/nodes.ipc.ts`);
    ok(/'nodes:auto-dispatch'/.test(nIpc) && /'nodes:set-auto-dispatch'/.test(nIpc),
      'W-17 开关读/写 IPC 均在册（面板点得到、也能显示最近一次）');
    ok(/set-auto-dispatch[\s\S]{0,800}typeof enabled !== 'boolean'/.test(nIpc),
      'W-18 写口只认显式布尔（近似真值不落库）');

    const rIpc = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(/autoDispatch:\s*\(\)/.test(rIpc) && /setAutoDispatch:\s*\(/.test(rIpc),
      'W-19 渲染层 IPC 出口齐（autoDispatch / setAutoDispatch）');
    const settingsPage = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(/nodesApi\.autoDispatch\(\)/.test(settingsPage) && /nodesApi\.setAutoDispatch\(/.test(settingsPage),
      'W-20 设置页开关真读真写（不是只摆一个 `useState`）');
    const peersPage = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/nodesApi\.autoDispatch\(\)/.test(peersPage) && /auto\.data\.last/.test(peersPage),
      'W-21 协同面板显示开/关与最近一次自动外派（读的是审计投影）');

    // ── 批四：改档权限 / 留痕 / 界面判据的接线 ──────────────────────────────────
    const ansNodes = STRIPPED('apps/ans-server/src/routes/nodes.ts');
    // 扫描面**收到 PATCH 处理器体内**：心跳 handler 也有同一句 `UPDATE ans_nodes SET ${sets.join`
    //   且更靠前——在整文件里比位次会把"心跳写库"当成"改档落库"（次序判据失真）。
    const patchAt = ansNodes.indexOf("'/:nodeId',");
    const patchEnd = ansNodes.indexOf(".delete('/:nodeId'", patchAt);
    const patchBody = patchAt >= 0 && patchEnd > patchAt ? ansNodes.slice(patchAt, patchEnd) : '';
    const permAt = patchBody.indexOf('deriveRequesterNodeId(db, request)');
    const updateAt = patchBody.indexOf('UPDATE ans_nodes SET ${sets.join');
    ok(patchAt >= 0 && permAt >= 0 && updateAt > permAt,
      'W-22 ★ANS 改档先判调用方身份（凭据派生）再落库（次序即判据）');
    ok(/Only enrolled nodes can modify node settings/.test(ansNodes),
      'W-23 非节点终端（外部终端 / dev key）改档 ⇒ 403 如实拒（不静默放行）');
    ok(/canDispatch\(\{\s*role:\s*requester\.role\s*\}\)/.test(ansNodes) && /cannot modify peer/.test(ansNodes),
      'W-24 改他机须 `canDispatch`（worker ⇒ 403）——与派单侧同一把尺');
    const ansTests = RD('apps/ans-server/src/__tests__/nodes-routes.test.ts');
    ok(/cannot modify peer/.test(ansTests) && /Only enrolled nodes/.test(ansTests),
      'W-25 权限矩阵判据在 ANS vitest 在册（R-20..R-22，真 HMAC + 生产建表）');

    const updateCallAt = nIpc.indexOf('recordNodeUpdate(');
    const okGateAt = nIpc.indexOf('if (!r.ok) return');
    const badResponseAt = nIpc.indexOf('ANS_BAD_RESPONSE');
    ok(updateCallAt > okGateAt && updateCallAt > badResponseAt && okGateAt >= 0 && badResponseAt >= 0,
      'W-26 ★改档留痕位于成功分支（两处早退之后——失败 / 回执坏不落账）');
    const nodeView = RD(`${A}/renderer/src/lib/node-view.ts`);
    ok(/export function canEditNode\(/.test(nodeView), 'W-27 `canEditNode` 一处（界面不内联 role 判断）');
    ok(/canEditNode\(localRole,\s*node,\s*localNodeId\)/.test(peersPage), 'W-28 协同面板真调用该判据');
    ok(/localRole=\{localNode\.role\}/.test(peersPage) && /localRole=\{localNode\?\.role \?\? null\}/.test(peersPage),
      'W-29 两处 NodeRow 都带本机角色（本机行与他机行同一把尺）');

    // ── 批五：席位闸的接线 ────────────────────────────────────────────────────
    const authCore = STRIPPED(`${A}/src/main/core/auth.ts`);
    const authFns = ['async register(', 'async findOrCreateOAuth(', 'async createUser('];
    for (const fn of authFns) {
      const from = authCore.indexOf(fn);
      const next = from >= 0 ? authCore.indexOf('async ', from + fn.length) : -1;
      const body = from >= 0 ? authCore.slice(from, next > from ? next : undefined) : '';
      ok(body.includes('assertSeatAvailable('),
        `W-30 建用户入口过同一扇席位门：${fn.replace('async ', '').replace('(', '')}`);
    }
    const seatAt = authCore.indexOf('assertSeatAvailable(');
    const insertAt = authCore.indexOf('INSERT INTO wa_users');
    ok(seatAt >= 0 && insertAt > seatAt, 'W-31 ★席位闸在**用户插入之前**（先问能不能进，再插）');

    const authIpc = STRIPPED(`${A}/src/main/ipc/auth.ipc.ts`);
    ok(/issueInviteToken\(db, resolveLicenseTier\(db\)/.test(authIpc),
      'W-32 发邀请走 `core/invite.ts`（先过闸再落行）');
    ok(!/INSERT INTO wa_invite_tokens/.test(authIpc),
      'W-33 邀请 SQL 收在 core（IPC 壳不另写一份真列用法）');
    const acceptAt = authIpc.indexOf("'auth:acceptInvite'");
    const acceptBody = acceptAt >= 0 ? authIpc.slice(acceptAt) : '';
    const claimAt = acceptBody.indexOf('claimInviteToken(');
    const createAt = acceptBody.indexOf('createUser(');
    const markAt = acceptBody.indexOf('markInviteUsed(');
    ok(claimAt >= 0 && createAt > claimAt && markAt > createAt,
      'W-34 ★接邀请次序：验令牌+过闸 → 建用户 → 核销（满员/重名失败不烧令牌）');
    ok(/instanceof SeatLimitError/.test(authIpc) && /'SEAT_LIMIT'/.test(authIpc),
      'W-35 满员如实回 `SEAT_LIMIT`（不冒充 INTERNAL）');

    ok(/seats:\s*seatUsage\(db,\s*resolveLicenseTier\(db\)\)/.test(licIpc),
      'W-36 `license:status.seats` 与闸门同引 `seatUsage`（计数不在壳里另算）');

    const usersPage = RD(`${A}/renderer/src/pages/UsersPage.tsx`);
    const seatView = RD(`${A}/renderer/src/lib/seat-view.ts`);
    ok(/export function seatText\(/.test(seatView) && /export function seatsFull\(/.test(seatView),
      'W-37 席位展示词表一处（`lib/seat-view.ts`）');
    ok(/from '\.\.\/lib\/seat-view'/.test(usersPage) && /seatText\(seats\)/.test(usersPage) && /seatsFull\(seats\)/.test(usersPage),
      'W-38 用户页真调用该词表（不在页面里内联格式化/满员判断）');
    ok(/disabled=\{seatsFull\(seats\)\}/.test(usersPage),
      'W-39 满员时添加/邀请按钮禁用（点不到，也有一行说明为什么）');
    ok(/seatText\(lic\?\.seats\)/.test(settingsPage),
      'W-40 设置页档位卡同源显示席位用量');

    // ── 批六：团队共享库的接线（ANS 写口 + 桌面出口 + 渲染面）──────────────────
    const ansSchema = RD('apps/ans-server/src/db/schema.ts');
    ok(/CREATE TABLE IF NOT EXISTS ans_team_items/.test(ansSchema)
      && /idx_ans_team_items_kind/.test(ansSchema) && /idx_ans_team_items_source/.test(ansSchema),
      'W-41 ANS 建表 + 两个索引齐（类型筛选 / 来源节点）');
    const ansIndex = STRIPPED('apps/ans-server/src/index.ts');
    const mountAt = ansIndex.indexOf('.use(teamRoutes(db))');
    ok(mountAt >= 0 && ansIndex.indexOf('.use(hmacAuth(db))') < mountAt
      && mountAt < ansIndex.indexOf('const hmacManagement'),
      'W-42 ★teamRoutes 挂在首个 HMAC 组内（鉴权先于路由；不是裸路由）');
    const ansTeam = STRIPPED('apps/ans-server/src/routes/team.ts');
    ok(/deriveRequesterNodeId\(db,\s*request\)/.test(ansTeam)
      && !/body\.source_node_id|payload\.source_node_id/.test(ansTeam),
      'W-43 ★★来源节点由凭据派生（`deriveRequesterNodeId`），从不读 body 的 source_node_id');
    ok(/from '@worker-ant\/shared-types'/.test(ansTeam) && /TEAM_ITEM_MAX_TITLE/.test(ansTeam)
      && /TEAM_ITEM_MAX_BODY_BYTES/.test(ansTeam) && /TEAM_ITEM_MAX_PER_NODE/.test(ansTeam),
      'W-44 三道上限同引 shared-types 真源（ANS 不手抄刻度）');
    ok(!/65536/.test(ansTeam) && !/\b500\b/.test(ansTeam),
      'W-45 ★ANS 路由内无上限幻数（改上限只改一处）');
    const ansNodes2 = RD('apps/ans-server/src/routes/nodes.ts');
    ok(/export function deriveRequesterNodeId/.test(ansNodes2),
      'W-46 `deriveRequesterNodeId` 由 nodes.ts 导出（一处实现，team 复用）');
    const teamLib = STRIPPED(`${A}/src/main/core/team-library.ts`);
    const shareRegion = teamLib.slice(teamLib.indexOf('export function shareItem'), teamLib.indexOf('function requireBody'));
    ok(shareRegion.length > 0 && !/file_path/.test(shareRegion),
      'W-47 ★成果分享载荷区零 `file_path`（不查、不带、不过网）');
    ok(!/65536|TEAM_ITEM_MAX_/.test(teamLib),
      'W-48 桌面本地侧不判上限（唯一写入口在 ANS；本模块只组装）');
    ok(/initTeamIpc\(db\)/.test(idx), 'W-49 启动接线：`initTeamIpc(db)` 真被调用');
    ok(/team:items/.test(rIpc) && /team:share/.test(rIpc) && /team:import/.test(rIpc) && /team:delete/.test(rIpc),
      'W-50 渲染层四个通道齐（页面点得到）');
    ok(/to:\s*'\/team-library'/.test(nav) && /import\('\.\/pages\/TeamLibraryPage'\)/.test(app)
      && /path="\/team-library"/.test(app),
      'W-51 导航 + 懒加载 + 路由三处齐（renderer 是词表第二落点）');
    const ansTeamTests = RD('apps/ans-server/src/__tests__/team-routes.test.ts');
    ok(/上限 200/.test(ansTeamTests) && /上限 65536/.test(ansTeamTests) && /上限 500/.test(ansTeamTests),
      'W-52 R-31..R-33 在 ANS vitest 在册（三道上限 + 来源派生 + 删除权限）');

    // ── 批七：项目知识包的接线（main 注册 / IPC 两通道 / 渲染面 / 卡片）──────────
    ok(/initKnowledgeIpc\(db,\s*dataDir\)/.test(idx), 'W-53 启动接线：`initKnowledgeIpc(db, dataDir)` 真被调用');
    const kIpc = STRIPPED(`${A}/src/main/ipc/knowledge.ipc.ts`);
    ok(/'knowledge:preview'/.test(kIpc) && /'knowledge:export'/.test(kIpc), 'W-54 两个通道在册');
    ok(/previewProjectKnowledge\s*\(/.test(kIpc), 'W-55 ★预览走 core 的同一取数（IPC 壳不另算预算）');
    // zx_20261018_1 批八：导出出口收进 core 的 `exportKnowledgeForProject`（先判 Pro 闸、再读整册落盘），
    //   IPC 只转发 ⇒ 判据按符号重定向到编排口（不放宽）：通道壳调它，且它内部两件事都在。
    const expSrc = STRIPPED(`${A}/src/main/core/knowledge-export.ts`);
    ok(/exportKnowledgeForProject\s*\(/.test(kIpc)
      && /listProjectKnowledge\s*\(/.test(expSrc) && /writeKnowledgeExport\s*\(/.test(expSrc),
      'W-56 ★导出读整册并落盘（写口收在 core：IPC 只调编排口，取数与写盘都在 core）');
    ok(/knowledge:preview/.test(rIpc) && /knowledge:export/.test(rIpc), 'W-57 渲染层两通道齐（页面点得到）');
    const pdPage = RD(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
    ok(/import KnowledgePackCard from/.test(pdPage) && /<KnowledgePackCard projectId=\{id!\}\s*\/>/.test(pdPage),
      'W-58 项目详情页真挂载知识包卡（不止建了组件）');
    const kCard = RD(`${A}/renderer/src/components/KnowledgePackCard.tsx`);
    ok(/knowledge\.preview\(/.test(kCard) && /knowledge\.export\(/.test(kCard), 'W-59 卡片真调两个出口');
    ok(/仅导出，不训练/.test(kCard), 'W-60 ★★卡上如实写明「仅导出，不训练」（K-4 形态守则）');
    ok(/注入预算/.test(kCard) && /omitted\.map/.test(kCard),
      'W-61 卡片显示预算与被挡的节（不假装全部注入）');
    ok(/预览的节 = 执行期真注入的节/.test(kCard), 'W-62 卡上说明预览与注入同一把尺');
    ok(/export const KNOWLEDGE_EXPORT_DIR = 'knowledge_exports'/.test(expSrc),
      'W-63 导出目录名一处真源（IPC/界面不另写字符串）');
  }

  // ═══ 批八：设备 Provider 框架 + Tuya Cloud 试点 ══════════════════════════════════
  console.log('\n【R-42】涂鸦签名：固定向量 + 同输入同输出（纯函数）');
  {
    const config: TuyaConfig = { region: 'cn', accessId: 'test-client-id', accessSecret: 'test-secret-key' };
    const signInput = {
      accessId: config.accessId, accessSecret: config.accessSecret, t: 1_600_000_000_000,
      method: 'GET', path: '/v1.0/token?grant_type=1', nonce: 'abc123',
    };
    eq(tuyaBodyHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'R-42a 空体 sha256 = 涂鸦文档固定向量');
    eq(tuyaStringToSign('GET', '/v1.0/token?grant_type=1'),
      'GET\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\n/v1.0/token?grant_type=1',
      'R-42b 待签串：METHOD\\n<bodySha>\\n\\n<path>（次序与空行逐字符钉死）');
    eq(tuyaSign(signInput), '216AA74CEDDFC0F067482549DCD1567254D303C338390EA479BB86B4A157A49F',
      'R-42c ★固定输入 ⇒ 固定签名（HMAC-SHA256 大写 hex）');
    eq(tuyaSign(signInput), tuyaSign(signInput), 'R-42d 同输入两次调用结果相同（纯函数）');
    const headers = tuyaSignedHeaders({
      config, method: 'GET', path: '/v1.0/devices?page_no=1&page_size=20', t: 1_600_000_000_000, nonce: 'abc123',
    });
    eq([headers.client_id, headers.sign_method, headers.t, headers.nonce],
      ['test-client-id', 'HMAC-SHA256', '1600000000000', 'abc123'], 'R-42e 签名头四件齐');
    ok(headers.access_token === undefined, 'R-42f token 请求不带 access_token（未取到令牌时不伪造）');
    ok(/^[0-9A-F]{64}$/.test(headers.sign ?? ''), 'R-42g sign 恒为大写 64 位 hex');
    const withToken = tuyaSignedHeaders({
      config, method: 'POST', path: '/v1.0/devices/x/commands', body: '{"commands":[]}',
      accessToken: 'tok-1', t: 1_600_000_000_000, nonce: 'abc123',
    });
    eq(withToken.access_token, 'tok-1', 'R-42h 有令牌时带上 access_token');
    eq(tuyaCommands('turn_on', {}), { commands: [{ code: 'switch_1', value: true }] }, 'R-42i turn_on 缺省 switch_1');
    eq(tuyaCommands('turn_off', { code: 'switch_led' }), { commands: [{ code: 'switch_led', value: false }] },
      'R-42j turn_off 可用 code 覆盖');
    ok('error' in tuyaCommands('set_bright', {}), 'R-42k ★翻不出数据点 ⇒ 如实拒（不猜）');
    ok('error' in tuyaCommands('set_bright', { code: 'bright_value' }), 'R-42l 有 code 无 value ⇒ 拒（缺 value 不下发）');
    eq(tuyaCommands('set_bright', { code: 'bright_value', value: 50 }),
      { commands: [{ code: 'bright_value', value: 50 }] }, 'R-42m 显式 code+value 直下');
    eq(TUYA_REGION_HOSTS, {
      cn: 'https://openapi.tuyacn.com', us: 'https://openapi.tuyaus.com',
      eu: 'https://openapi.tuyaeu.com', in: 'https://openapi.tuyain.com',
    }, 'R-42n ★区域端点恰为涂鸦官方固定域名（设置里不存 URL）');
    eq(cloudAddress('tuya', 'dev1'), 'tuya:dev1', 'R-42o 云地址唯一拼法 <providerId>:<deviceId>');
    eq([cloudProviderIdOf('tuya:dev1'), cloudDeviceIdOf('tuya:dev1')], ['tuya', 'dev1'], 'R-42p 地址前缀解析');
    eq([cloudProviderIdOf('no-prefix'), cloudDeviceIdOf('no-prefix')], ['', 'no-prefix'],
      'R-42q 无前缀 ⇒ Provider id 空串（调用方如实拒，不猜默认厂商）');
  }

  console.log('\n【R-43】假 HTTP：失败如实回因，不重试、不冒充成功');
  {
    const config: TuyaConfig = { region: 'cn', accessId: 'id-1', accessSecret: 'sec-1' };
    type Call = { url: string; init: TuyaHttpInit };
    const tokenOk = JSON.stringify({ success: true, result: { access_token: 'tok-1', expire_time: 3600 } });
    const now = () => new Date('2026-10-17T00:00:00.000Z');

    // token 失败：只发一次，不重试
    {
      const calls: Call[] = [];
      const http: TuyaHttp = async (url, init) => { calls.push({ url, init }); return { status: 500, body: 'boom' }; };
      const provider = createTuyaProvider(config, { http, now });
      let msg = '';
      try { await provider.listDevices(); } catch (e) { msg = (e as Error)?.message || String(e); }
      ok(msg.includes('获取访问令牌失败'), 'R-43a token 失败 ⇒ 如实抛因（不当成"已连接"）', msg);
      eq(calls.length, 1, 'R-43b ★token 失败不重试（HTTP 调用恰 1 次）');
      eq(calls[0]?.url, 'https://openapi.tuyacn.com/v1.0/token?grant_type=1',
        'R-43c token 请求只发往官方区域端点');
    }

    // 列表失败：token OK → 列表失败 ⇒ sync 收成"空态 + 原因"，0 行
    {
      const calls: Call[] = [];
      const http: TuyaHttp = async (url, init) => {
        calls.push({ url, init });
        if (url.includes('/v1.0/token')) return { status: 200, body: tokenOk };
        return { status: 200, body: JSON.stringify({ success: false, code: 1004, msg: 'sign invalid' }) };
      };
      const provider = createTuyaProvider(config, { http, now });
      const db = makeDeviceDb();
      const r = await syncProviderDevices(db as unknown as DeviceDb, provider);
      eq(r.ok, false, 'R-43d 列表失败 ⇒ 同步不报成功');
      ok(!r.ok && r.error.includes('设备列表拉取失败'), 'R-43e 原因如实回给调用方（空态 + 原因）', r.ok ? '' : r.error);
      eq(count(db, 'wa_devices'), 0, 'R-43f 失败不入账（台账 0 行）');
      eq(calls.length, 2, 'R-43g 列表失败不重试（token + 1 次列表）');
    }

    // 列表成功：只取自述字段，能力取数据点
    {
      const http: TuyaHttp = async (url) => {
        if (url.includes('/v1.0/token')) return { status: 200, body: tokenOk };
        return {
          status: 200,
          body: JSON.stringify({ success: true, result: { has_more: false, devices: [
            { id: 'dev1', name: '客厅灯', category: 'dj', status: [{ code: 'switch_led' }, { code: 'bright_value' }] },
            { id: 'dev2', name: '', category: '', status: [] },
          ] } }),
        } satisfies TuyaHttpResponse;
      };
      const provider = createTuyaProvider(config, { http, now });
      const list = await provider.listDevices();
      eq(list.length, 2, 'R-43h 列表成功 ⇒ 逐台映射');
      eq(list[0], { id: 'dev1', name: '客厅灯', kind: 'dj', kindClass: 'light', capabilities: ['switch_led', 'bright_value'], controllable: true },
        'R-43i 能力取设备自述数据点（不谎称可控）');
      eq(list[1], { id: 'dev2', name: 'dev2', kind: 'unknown', kindClass: 'unknown', capabilities: [], controllable: false },
        'R-43j 无自述名/类别/数据点 ⇒ 如实回退（不猜）');
      eq(list[0].kindClass, 'light', 'R-43i2 ★品类类目由厂商自述 category 派生（dj ⇒ light，不按设备名猜）');
    }
  }

  console.log('\n【R-44】Provider 同步：幂等入账，两台不重复');
  {
    const db = makeDeviceDb();
    const ddb = db as unknown as DeviceDb;
    let version = 1;
    const provider: DeviceProvider = {
      id: 'fakecloud',
      label: '假云',
      async listDevices() {
        return [
          { id: 'dev1', name: version === 1 ? '灯一' : '灯一（改名）', kind: 'light', capabilities: ['switch'], controllable: true },
          { id: 'dev2', name: '插座二', kind: 'socket', capabilities: [], controllable: false },
        ];
      },
      async control() { return { ok: true, result: 'ok' }; },
    };
    const first = await syncProviderDevices(ddb, provider, NOW.toISOString());
    ok(first.ok, 'R-44a 首次同步成功');
    eq(first.ok ? first.added : -1, 2, 'R-44b 新增 2 台');
    eq(first.ok ? first.updated : -1, 0, 'R-44c 首次无刷新');
    eq(count(db, 'wa_devices'), 2, 'R-44d 台账 2 行');
    eq((db.prepare("SELECT COUNT(*) AS n FROM wa_devices WHERE protocol = 'cloud'").get() as { n: number }).n, 2,
      'R-44e 两行 protocol=cloud');
    eq((db.prepare('SELECT address FROM wa_devices ORDER BY address').all() as Array<{ address: string }>).map((r) => r.address),
      ['fakecloud:dev1', 'fakecloud:dev2'], 'R-44f ★地址按 <providerId>:<deviceId> 拼（唯一拼法）');

    // 用户意志不被云同步冲掉
    const row1 = findDeviceByIdentity(ddb, 'cloud', 'fakecloud:dev1');
    ok(row1 != null, 'R-44g 按 (protocol,address) 找得回入账行');
    setDeviceAlias(ddb, row1!.id, '客厅主灯');
    setDeviceAuthorized(ddb, row1!.id, true);
    version = 2;
    const second = await syncProviderDevices(ddb, provider, NOW.toISOString());
    eq(second.ok ? second.added : -1, 0, 'R-44h ★重复同步不重复入账（新增 0）');
    eq(second.ok ? second.updated : -1, 2, 'R-44i 重复同步按唯一键刷新 2 台');
    eq(count(db, 'wa_devices'), 2, 'R-44j 台账仍 2 行（唯一键生效）');
    const again = findDeviceByIdentity(ddb, 'cloud', 'fakecloud:dev1')!;
    eq(again.name, '灯一（改名）', 'R-44k 自述名随发现刷新');
    eq([again.alias, again.authorized], ['客厅主灯', true], 'R-44l ★同步不覆盖 alias/authorized（用户意志不被云冲掉）');
  }

  console.log('\n【R-45】控制选路：cloud ⇒ Provider 注册表；未注册如实拒，绝不落 HTTP');
  {
    const mk = (address: string): AnsDevice => ({
      id: 'd1', name: '云灯', alias: '', kind: 'light', protocol: 'cloud', address, port: null,
      capabilities: ['switch'], controllable: true, authorized: true, status: null, online: null,
      first_seen: '', last_seen: '',
    });
    unregisterDeviceProvider('fakecloud');
    const un = await defaultDeviceControl(mk('fakecloud:dev1'), 'turn_on', {});
    eq(un.ok, false, 'R-45a 未注册 Provider ⇒ 拒');
    ok(un.result.includes('未注册'), 'R-45b 拒因如实（点名 Provider）', un.result);
    ok(!un.result.includes('非局域网') && !un.result.includes('请求失败'),
      'R-45c ★未退回 HTTP 误发（不出现 HTTP 拒因/请求失败）');

    const seen: Array<{ id: string; action: string; args: Record<string, unknown> }> = [];
    const fakeProvider: DeviceProvider = {
      id: 'fakecloud',
      label: '假云',
      async listDevices() { return []; },
      async control(deviceId, action, args) {
        seen.push({ id: deviceId, action, args });
        return { ok: true, result: 'fake-ok' };
      },
    };
    registerDeviceProvider(fakeProvider);
    const r = await defaultDeviceControl(mk('fakecloud:dev1'), 'set_bright', { code: 'bright_value', value: 30 });
    eq(r, { ok: true, result: 'fake-ok' }, 'R-45d 已注册 ⇒ 走 Provider');
    eq(seen, [{ id: 'dev1', action: 'set_bright', args: { code: 'bright_value', value: 30 } }],
      'R-45e Provider 收到 Provider 侧 id/action/args（地址前缀不误传）');

    // K-6 仍先于传动：未授权云设备不触 Provider（不绕过授权闸）
    const db = makeDeviceDb();
    const ddb = db as unknown as DeviceDb;
    const ins = upsertDiscovered(ddb, {
      name: '云灯', kind: 'light', protocol: 'cloud', address: 'fakecloud:dev9',
      capabilities: ['switch'], controllable: true,
    }, NOW.toISOString());
    seen.length = 0;
    const denied = await runDeviceControl(ddb, { deviceId: ins.id, action: 'turn_on', args: {} }, defaultDeviceControl);
    eq(denied.ok, false, 'R-45f ★未授权云设备仍被 K-6 拦下（不绕过授权闸）');
    eq(seen.length, 0, 'R-45g 被拦时 Provider 零调用');
    eq(count(db, 'wa_device_actions'), 1, 'R-45h 被拒也留痕（控制全量留痕）');

    setDeviceAuthorized(ddb, ins.id, true);
    const okOut = await runDeviceControl(ddb, { deviceId: ins.id, action: 'turn_on', args: {} }, defaultDeviceControl);
    eq(okOut.ok, true, 'R-45i 授权后经同一编排下发成功');
    eq(seen.length, 1, 'R-45j 授权后 Provider 恰收到一次');
    eq(count(db, 'wa_device_actions'), 2, 'R-45k 成功一次亦留痕');
    ok(getDeviceProvider('fakecloud') === fakeProvider, 'R-45l 注册表按 id 取回同一 Provider（不另建）');
    unregisterDeviceProvider('fakecloud');
  }

  console.log('\n【R-46】无凭据：如实 configured:false，且不触网');
  {
    const asked: string[] = [];
    const get = (k: string): string | null => { asked.push(k); return null; };
    const st = tuyaConfigStatus(get);
    eq({ configured: st.configured, accessIdSet: st.accessIdSet, secretSet: st.secretSet },
      { configured: false, accessIdSet: false, secretSet: false }, 'R-46a 无凭据 ⇒ configured:false（三格如实）');
    ok(asked.length > 0 && asked.every((k) => k.startsWith('device.tuya.')),
      'R-46b 只读三个涂鸦设置键（无别处取数）', asked.join(','));

    let net = 0;
    const provider = registerTuyaCloudProvider(() => null, {
      http: async () => { net += 1; return { status: 200, body: '{}' }; },
      now: () => NOW,
    });
    let listMsg = '';
    try { await provider.listDevices(); } catch (e) { listMsg = (e as Error)?.message || String(e); }
    ok(listMsg.includes('凭据未配置'), 'R-46c 未配置 ⇒ listDevices 如实抛因', listMsg);
    const c = await provider.control('dev1', 'turn_on', {});
    ok(!c.ok && c.result.includes('未配置'), 'R-46d 未配置 ⇒ control 如实拒（不静默成功）', c.result);
    eq(net, 0, 'R-46e ★假 HTTP 调用数 0（无凭据全程不触网）');
    unregisterDeviceProvider(TUYA_PROVIDER_ID);

    // 静态：cloud_status 出口只读配置态、零网络
    const ipcSrc = STRIPPED(`${A}/src/main/ipc/devices.ipc.ts`);
    const stAt = ipcSrc.indexOf("'devices:cloud_status'");
    const stEnd = ipcSrc.indexOf('ipcMain.handle(', stAt + 10);
    const stBody = stAt >= 0 ? ipcSrc.slice(stAt, stEnd > stAt ? stEnd : undefined) : '';
    ok(stBody.includes('tuyaConfigStatus('), 'R-46f cloud_status 走同一配置判据');
    ok(!/syncProviderDevices\(|createTuyaProvider\(|defaultTuyaHttp\(|fetch\(/.test(stBody),
      'R-46g ★cloud_status 处理体内零网络调用（只读配置态）');
    ok(/'devices:cloud_status'/.test(ipcSrc) && /'devices:tuya_config'/.test(ipcSrc) && /'devices:cloud_sync'/.test(ipcSrc),
      'R-46h 三个通道在册');
  }

  // zx_20261029_2 M6「阶梯」：云同步/发现归 **Pro**（`device_discovery`）——闸仍先于拉取与入账，只是回码换 `PRO_REQUIRED`。
  console.log('\n【R-47】Pro 闸（发现）：锁定 ⇒ PRO_REQUIRED，先于拉取与入账');
  {
    // ★时钟须注入：试用期是相对 now 判的（`TRIAL_DAYS=14`），夹具把起点钉在 `NOW`；
    //   本条原先真跑墙钟 ⇒ 14 天一到自己引爆（判据不得依赖真实墙钟）。
    ok(proFeatureRefusal(settingsDb(false), 'device_discovery', { now: NOW }) != null, 'R-47a 未解锁 ⇒ 有如实拒因');
    eq(proFeatureRefusal(settingsDb(true), 'device_discovery', { now: NOW }), null, 'R-47b 试用期 ⇒ 放行（与 Pro 闸同一判据）');
    const ipcSrc = STRIPPED(`${A}/src/main/ipc/devices.ipc.ts`);
    const at = ipcSrc.indexOf("'devices:cloud_sync'");
    const end = ipcSrc.indexOf('ipcMain.handle(', at + 10);
    const body = at >= 0 ? ipcSrc.slice(at, end > at ? end : undefined) : '';
    const gateAt = body.indexOf("proFeatureRefusal(licDb, 'device_discovery')");
    const reqAt = body.indexOf('resolveTuyaConfig(');
    const syncAt = body.indexOf('syncProviderDevices(');
    ok(gateAt >= 0 && reqAt > gateAt && syncAt > reqAt,
      'R-47c ★次序：闸 → 读配置 → 拉取（次序即判据）', `gate=${gateAt} cfg=${reqAt} sync=${syncAt}`);
    ok(/if\s*\(refusal\)\s*return\s*\{[^}]*PRO_REQUIRED/s.test(body),
      'R-47d 锁定即早退 PRO_REQUIRED（不拉取、不入账）');
  }

  console.log('\n【W】批八接线：协议枚举 / 注册表 / 三通道 / 渲染面 / 密钥不回显');
  {
    const reg = STRIPPED(`${A}/src/main/core/device-registry.ts`);
    ok(/export type DeviceProtocol =[^;]*'cloud'/.test(reg), 'W-64 协议枚举增 cloud（一处真源）');
    const devPage = RD(`${A}/renderer/src/pages/DevicesPage.tsx`);
    ok(/cloud:\s*'三方云'/.test(devPage), 'W-65 面板协议标签增「三方云」（第二落点）');

    const tool = STRIPPED(`${A}/src/main/core/tools/device.ts`);
    const cloudAt = tool.indexOf("dev.protocol === 'cloud'");
    const httpAt = tool.indexOf('return httpDeviceControl(', cloudAt);
    ok(cloudAt >= 0 && httpAt > cloudAt, 'W-66 ★cloud 分支先于 HTTP 回退（唯一选路）');
    // zx_20261018_1 批四：`device_status` 另有"云设备问 Provider 状态"的分支（不是控制选路）——
    //   判据收窄到**控制派发**这一函数体内（放错地方/多一处仍红，不是放宽）。
    const routeStart = tool.indexOf('export async function defaultDeviceControl(');
    const routeEnd = tool.indexOf('export async function runDeviceControl(', routeStart);
    const routeBody = routeStart >= 0 ? tool.slice(routeStart, routeEnd > routeStart ? routeEnd : undefined) : '';
    eq((routeBody.match(/dev\.protocol === 'cloud'/g) ?? []).length, 1,
      'W-67 控制派发里 cloud 分支恰一处（状态查询分支不计）');
    const cloudBranch = cloudAt >= 0 ? tool.slice(cloudAt, httpAt > cloudAt ? httpAt : undefined) : '';
    ok(!/httpDeviceControl\s*\(/.test(cloudBranch), 'W-68 ★cloud 分支内零 HTTP 调用（未注册即拒，不误发）');

    const dIpc = STRIPPED(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(/registerTuyaCloudProvider\(settingsGet\)/.test(dIpc), 'W-69 启动接线：涂鸦 Provider 真被注册（现读设置）');
    ok(/getDeviceProvider\(TUYA_PROVIDER_ID\)/.test(dIpc), 'W-70 同步取的是注册表里的 Provider（不另新建）');

    const cfgAt = dIpc.indexOf("'devices:tuya_config'");
    const cfgEnd = dIpc.indexOf('ipcMain.handle(', cfgAt + 10);
    const cfgBody = cfgAt >= 0 ? dIpc.slice(cfgAt, cfgEnd > cfgAt ? cfgEnd : undefined) : '';
    ok(/typeof p\.accessSecret === 'string'[\s\S]{0,80}p\.accessSecret\.trim\(\) !== ''/.test(cfgBody),
      'W-71 ★Secret 空串=保持原值（留空不修改）');
    ok(/return \{ data: tuyaConfigStatus\(settingsGet\) \}/.test(cfgBody), 'W-72 回包只回配置态（不夹带 Secret）');

    const cloudSrc = STRIPPED(`${A}/src/main/core/providers/tuya-cloud.ts`);
    const statusAt = cloudSrc.indexOf('export function tuyaConfigStatus');
    const statusEnd = cloudSrc.indexOf('export function', statusAt + 10);
    const statusBody = statusAt >= 0 ? cloudSrc.slice(statusAt, statusEnd > statusAt ? statusEnd : undefined) : '';
    ok(/secretSet/.test(statusBody) && !/\baccessSecret\s*:/.test(statusBody) && !/\bsecret\s*:/.test(statusBody),
      'W-73 ★配置态无 Secret 字段（只说配没配）');

    const rIpcSrc = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(/devices:cloud_status/.test(rIpcSrc) && /devices:tuya_config/.test(rIpcSrc) && /devices:cloud_sync/.test(rIpcSrc),
      'W-74 渲染层三出口齐（页面点得到）');
    const payloadAt = rIpcSrc.indexOf('export interface CloudStatusPayload');
    const payloadEnd = rIpcSrc.indexOf('}', payloadAt);
    const payloadBody = payloadAt >= 0 ? rIpcSrc.slice(payloadAt, payloadEnd > payloadAt ? payloadEnd : undefined) : '';
    ok(/secretSet/.test(payloadBody) && !/\bsecret\s*:/.test(payloadBody) && !/accessSecret/.test(payloadBody),
      'W-75 ★渲染层配置态载荷无 Secret（只回显"是否已配"）');

    ok(/devicesApi\.cloudStatus\(\)/.test(devPage) && /devicesApi\.tuyaConfig\(/.test(devPage) && /devicesApi\.cloudSync\(\)/.test(devPage),
      'W-76 设备页真调三个出口（不是只摆 UI）');
    ok(/<CloudConfigBlock locked=\{discoveryLocked\} \/>/.test(devPage),
      'W-77 ★三方云区块真挂载，锁随 `discoveryLocked`（M6 起云同步归专业版，与设备发现同闸）');
    ok(/type="password"[\s\S]{0,220}Secret 已配置（留空不修改）/.test(devPage),
      'W-78 ★Secret 输入框只回显"已配置"提示（不把存储值填进输入框）');
    ok(/官方区域端点/.test(devPage), 'W-79 界面如实写明"只发官方区域端点"');
    ok(/K-6/.test(devPage), 'W-80 界面如实写明控制仍走本机授权闸（不绕过）');
  }

  // ═══ S 哑雷自检 + build 钉（派生核对，不写轮次字面量）═══════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20261017_1 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261017_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
