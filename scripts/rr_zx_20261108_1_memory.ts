/**
 * zx_20261108_1 B4「忆」受控回归 —— 记忆可管可溯（维特根斯坦·意义即使用 / 管子·度量衡）。
 *
 * 钉住六件事：
 *   A 服务端筛选：关键词（FTS 优先 / 中文零命中回落 LIKE）、来源、时刻、项目、类型；`total` 与列表同一套 WHERE；
 *   B 反证：夹具**缺 FTS 表**时 LIKE 回落仍返回结果；LIKE 通配符被转义（`_` 不匹配任意单字）；
 *   C 单条详情：来源人话名 / 项目 / 证据 / 注入历史与 ROI / 改账历史；跨项目（无项目归属）如实标注；
 *   D 人工写口：新增可检索、修订后旧值不残留且来源转 `user_correction`、遗忘后默认列表不可见但审计有痕；
 *   E 容量：按类型/来源/项目计数、FTS 索引健康、重复候选（只读）；
 *   F 接线与构建钉：core 真源 ↔ IPC ↔ renderer ↔ 面板，且页面不再做「当前页客户端过滤」。
 *
 * 纪律：零 electron、零真网；时刻由 `nowMs` 注入；文案不含失败字形；
 *   rr 夹具**先 new MemoryManager（建 FTS 触发器）再插数据行**——顺序颠倒则索引不覆盖存量行，断言会假绿。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  listMemories,
  memoryCapacity,
  memoryDetail,
  mutateMemory,
  keywordTerms,
  normalizeDbTime,
  sanitizeFtsQuery,
} from '../apps/worker-ant-desktop/src/main/core/memory-admin.js';
import {
  MEM_SOURCE_LABEL,
  MEM_SOURCE_MANUAL,
  memSourceLabel,
  utcNowIso,
} from '../apps/worker-ant-desktop/src/main/core/memory-lifecycle.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);
const sorted = (xs: Array<string | null | undefined>) => [...xs].map((x) => String(x ?? '')).sort();

// ─────────────────────────────────────────────────────────────
// 夹具：照抄 database.ts 的记忆相关 DDL（列不齐即在生产能过的地方抛错）
// ─────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_users (id TEXT PRIMARY KEY, name TEXT DEFAULT '', role TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
  content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
  importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
  user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
  is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  use_count INTEGER DEFAULT 0, last_used_at TEXT, similar_to TEXT DEFAULT '',
  last_reinforced_at TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
  deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT '',
  injected_count INTEGER DEFAULT 0, last_injected_at TEXT);
CREATE TABLE wa_context_injections (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id);
CREATE TABLE wa_audit_events (
  id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
`;

type AnyDb = import('better-sqlite3').Database;

/** 生产初始化顺序：先建 `wa_memories_fts` 与三支同步触发器，**再**插数据行。 */
function mkDb(withFts = true): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  if (withFts) new MemoryManager(d as unknown as AnyDb, null as never);
  return d as unknown as AnyDb;
}

interface MemSeed {
  id: string;
  content: string;
  project_id?: string | null;
  task_id?: string | null;
  memory_type?: string;
  importance?: number;
  source?: string;
  valence?: string;
  context_json?: string;
  created_at: string;
  updated_at?: string | null;
  use_count?: number;
  success_count?: number;
  failure_count?: number;
  injected_count?: number;
  deleted_at?: string | null;
  deleted_reason?: string;
  deleted_fingerprint?: string;
}
function insMem(db: AnyDb, m: MemSeed): void {
  db.prepare(
    `INSERT INTO wa_memories
      (id, project_id, task_id, content, memory_type, importance, reasoning, source, user_id, valence,
       context_json, is_exemplar, updated_at, created_at, use_count, similar_to,
       success_count, failure_count, deleted_at, deleted_reason, deleted_fingerprint,
       injected_count, last_injected_at)
     VALUES (?,?,?,?,?,?, '', ?, '', ?, ?, 0, ?,?,?, '', ?,?,?,?,?,?,?)`,
  ).run(
    m.id, m.project_id ?? null, m.task_id ?? null, m.content, m.memory_type ?? 'episodic',
    m.importance ?? 0.5, m.source ?? 'agent_execution', m.valence ?? 'neutral',
    m.context_json ?? '{}', m.updated_at ?? null, m.created_at, m.use_count ?? 0,
    m.success_count ?? 0, m.failure_count ?? 0, m.deleted_at ?? null,
    m.deleted_reason ?? '', m.deleted_fingerprint ?? '', m.injected_count ?? 0, null,
  );
}

/** 共用主夹具：A/C/D/E 在同一库上按序推进（D 会改动部分行，E 的期望按当时实况量）。 */
function buildMainDb(): AnyDb {
  const db = mkDb();
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '项目甲')").run();
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p2', '项目乙')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title) VALUES ('t1', 'p1', '部署任务')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title) VALUES ('t2', 'p1', '排查任务')").run();

  insMem(db, {
    id: 'm1', project_id: 'p1', task_id: 't1',
    content: '部署流程：先跑迁移再启动服务', memory_type: 'procedural', source: 'agent_execution',
    importance: 0.8, context_json: '{"evidence":{"file_path":"src/a.ts","verified":true}}',
    created_at: '2026-11-01 10:00:00', updated_at: '2026-11-01 10:00:00',
  });
  insMem(db, {
    id: 'm2', project_id: 'p1', task_id: 't2',
    content: '部署时注意数据库连接池上限', memory_type: 'semantic', source: 'background_review',
    importance: 0.7, created_at: '2026-11-02 10:00:00',
  });
  insMem(db, {
    id: 'm3', project_id: 'p2',
    content: '周报模板：本周完成 下周计划', memory_type: 'procedural', source: 'user_correction',
    importance: 0.6, created_at: '2026-11-03 10:00:00',
  });
  insMem(db, {
    id: 'm4', project_id: null,
    content: '全局偏好：回复用中文', memory_type: 'preference', source: 'user_instruction',
    importance: 0.9, created_at: '2026-11-04 10:00:00',
  });
  insMem(db, {
    id: 'm5', project_id: 'p1', content: '', memory_type: 'deleted', source: 'agent_execution',
    created_at: '2026-10-01 09:00:00', deleted_at: '2026-10-02 09:00:00',
    deleted_reason: '用户删除（记忆页）', deleted_fingerprint: 'fp-abc',
  });
  insMem(db, {
    id: 'm6', project_id: 'p1', content: '旧部署笔记', memory_type: 'archived', source: 'agent_execution',
    created_at: '2026-10-05 09:00:00',
  });
  // 分页标本（9 月，避开 A 的时刻窗口）
  for (let i = 1; i <= 5; i++) {
    insMem(db, {
      id: `pg${i}`, project_id: 'p2', content: `分页词 第${i}条`, memory_type: 'episodic',
      source: 'auto_extract', created_at: `2026-09-0${i} 10:00:00`,
    });
  }
  // 一条英文正文，用于验证 FTS 路真的被走到（英文按空格切词）
  insMem(db, {
    id: 'en1', project_id: 'p1', content: 'deploy checklist: run migration first',
    memory_type: 'procedural', source: 'agent_execution', created_at: '2026-11-05 10:00:00',
  });

  // 注入账
  const insInj = (id: string, task: string, ref: string, chars: number, outcome: string, updated: string, source = 'memory') =>
    db.prepare(
      'INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id, task, source, ref, chars, Math.ceil(chars / 4), outcome, updated, updated);
  insInj('i1', 't1', 'm1', 120, 'completed', '2026-11-05 10:00:00');
  insInj('i2', 't2', 'm1', 80, 'failed', '2026-11-06 10:00:00');
  insInj('i3', 't1', 'm2', 50, 'pending', '2026-11-05 11:00:00');
  insInj('i4', 't1', 'm1', 999, 'completed', '2026-11-06 12:00:00', 'knowledge');

  db.prepare(
    "INSERT INTO wa_audit_events (id, actor_kind, actor_ref, action, target_type, target_id, detail_json, created_at) VALUES ('a1','local','','memory.update','memory','m1','{\"fields\":[\"content\"]}','2026-11-06 09:00:00')",
  ).run();
  return db;
}

// ═══ A｜服务端筛选与 total 一致性 ═════════════════════════════════════════════
function sectionA(db: AnyDb): void {
  console.log('\n【A】服务端筛选：关键词 / 来源 / 时刻 / 项目 / 类型 + total');

  const dflt = listMemories(db, {});
  const ids = sorted(dflt.list.map((r) => r.id));
  eq(sorted(['m1', 'm2', 'm3', 'm4', 'en1', 'pg1', 'pg2', 'pg3', 'pg4', 'pg5']), ids, 'A1 默认列表 = 全部活记忆（归档/墓碑被排除）');
  eq(dflt.total, dflt.list.length, 'A2 无筛选时 total 与行数一致');
  eq(dflt.keywordMode, 'none', 'A3 无关键词 ⇒ keywordMode=none');
  ok(dflt.list.every((r) => !!r.type_label && !!r.source_label), 'A4 每行都带类型/来源人话名');

  const en = listMemories(db, { keyword: 'deploy' });
  eq(en.keywordMode, 'fts', 'A5 英文关键词走 FTS（整词可命中）');
  eq(sorted(en.list.map((r) => r.id)), ['en1'], 'A6 FTS 命中英文正文');

  const zh = listMemories(db, { keyword: '部署' });
  eq(zh.keywordMode, 'like', 'A7 中文单搜（FTS 零命中）回落 LIKE 并如实回报');
  eq(sorted(zh.list.map((r) => r.id)), ['m1', 'm2'], 'A8 中文包含匹配命中两条；归档的「旧部署笔记」仍被 MEM_LIVE_SQL 排除');
  eq(zh.total, 2, 'A9 LIKE 路 total 与列表同源');

  const kwSrc = listMemories(db, { keyword: '部署', source: 'agent_execution' });
  eq(sorted(kwSrc.list.map((r) => r.id)), ['m1'], 'A10 关键词 + 来源 组合筛选');

  const proj = listMemories(db, { projectId: 'p1' });
  eq(sorted(proj.list.map((r) => r.id)), ['en1', 'm1', 'm2'], 'A11 项目筛选只回该项目活记忆');

  const srcOnly = listMemories(db, { source: 'user_correction' });
  eq(sorted(srcOnly.list.map((r) => r.id)), ['m3'], 'A12 来源筛选');

  const time = listMemories(db, { timeFrom: '2026-11-02', timeTo: '2026-11-03' });
  eq(sorted(time.list.map((r) => r.id)), ['m2', 'm3'], 'A13 日期（仅日期）按当日 00:00:00–23:59:59 闭区间筛');
  eq(time.total, 2, 'A14 时刻筛选 total 与列表同源');

  const proc = listMemories(db, { type: 'procedural' });
  eq(sorted(proc.list.map((r) => r.id)), ['en1', 'm1', 'm3'], 'A15 类型筛选（点名类型时不再追加 MEM_LIVE_SQL）');
  const tomb = listMemories(db, { type: 'deleted' });
  eq(sorted(tomb.list.map((r) => r.id)), ['m5'], 'A16 点名 deleted 即墓碑审计面');
  eq(tomb.list[0]?.deleted_reason, '用户删除（记忆页）', 'A17 墓碑行带删除缘由');
  ok(tomb.list[0]?.cross_project === false, 'A18 墓碑行的跨项目标注为假（它有项目归属）');

  const counts = Object.fromEntries(dflt.counts.map((c) => [c.memory_type, c.cnt]));
  eq(counts.episodic, 5, 'A19 counts 含全部类型（episodic=5）');
  eq([counts.deleted, counts.archived], [1, 1], 'A20 counts 保留墓碑/归档取值（筛选取值来源）');

  // 分页：不重不漏
  const p0 = listMemories(db, { keyword: '分页词', limit: 2, offset: 0 });
  const p1 = listMemories(db, { keyword: '分页词', limit: 2, offset: 2 });
  const p2 = listMemories(db, { keyword: '分页词', limit: 2, offset: 4 });
  eq([p0.total, p1.total, p2.total], [5, 5, 5], 'A21 每页 total 恒为筛选后的总数');
  eq(p0.list.length + p1.list.length + p2.list.length, 5, 'A22 三页行数相加 = 总数');
  const allPageIds = [...p0.list, ...p1.list, ...p2.list].map((r) => r.id);
  eq(new Set(allPageIds).size, 5, 'A23 分页不重（并集 5 个不同 id）');
  eq(sorted(allPageIds), ['pg1', 'pg2', 'pg3', 'pg4', 'pg5'], 'A24 分页不漏（并集 = 全部分页标本）');

  // 纯函数
  eq(keywordTerms('部署 " OR 1=1 --'), ['部署', 'OR', '1', '1'], 'A25 关键词白名单只留字母/数字/下划线');
  eq(sanitizeFtsQuery('a b'), '"a" "b"', 'A26 FTS 查询每词加引号（消掉语法元字符）');
  eq(normalizeDbTime('2026-11-03', true), '2026-11-03 23:59:59', 'A27 仅日期上界补 23:59:59');
  eq(normalizeDbTime('2026-11-03T08:30:00.000Z', false), '2026-11-03 08:30:00', 'A28 ISO 时刻归一为库内 UTC 串');
  eq(normalizeDbTime('不是时刻'), '', 'A29 认不出的时刻返回空串（调用方不追加条件）');
}

// ═══ B｜反证：FTS 表缺失时 LIKE 回落 ═════════════════════════════════════════
function sectionB(): void {
  console.log('\n【B】反证：夹具缺 FTS 表 ⇒ LIKE 回落；通配符被转义');
  const db = mkDb(false);
  insMem(db, { id: 'x1', content: '升级前的准备动作', source: 'agent_execution', created_at: '2026-11-01 10:00:00' });
  insMem(db, { id: 'x2', content: 'a_b 字面下划线', created_at: '2026-11-02 10:00:00' });
  insMem(db, { id: 'x3', content: 'axb 任意单字', created_at: '2026-11-03 10:00:00' });

  const r = listMemories(db, { keyword: '升级' });
  eq(r.keywordMode, 'like', 'B1 无 FTS 表 ⇒ 直接 LIKE 并如实回报');
  eq(sorted(r.list.map((x) => x.id)), ['x1'], 'B2 LIKE 回落仍返回结果（不因索引缺失而零结果）');

  const u = listMemories(db, { keyword: 'a_b' });
  eq(u.keywordMode, 'like', 'B3 含下划线的关键词走 LIKE');
  eq(sorted(u.list.map((x) => x.id)), ['x2'], 'B4 LIKE 通配符被转义（`_` 不匹配任意单字）');

  const cap = memoryCapacity(db);
  eq(cap.fts.available, false, 'B5 容量读口如实报告 FTS 不可用');
  ok(cap.fts.error.length > 0, 'B6 FTS 不可用时带真因', cap.fts.error);
}

// ═══ C｜单条详情 ═════════════════════════════════════════════════════════════
function sectionC(db: AnyDb): void {
  console.log('\n【C】详情：来源 / 项目 / 证据 / 注入历史与 ROI / 改账历史');

  const d = memoryDetail(db, 'm1');
  ok(!!d, 'C1 详情读得到');
  if (!d) return;
  eq(d.memory.source, 'agent_execution', 'C2 原始来源列如实给出');
  eq(d.memory.source_label, '代理执行', 'C3 来源人话名（词表真源）');
  eq(d.memory.project_name, '项目甲', 'C4 项目名');
  eq(d.memory.cross_project, false, 'C5 有项目归属 ⇒ 非跨项目');
  eq(d.memory.created_at, '2026-11-01 10:00:00', 'C6 创建时刻');
  eq(d.roi.injected, 2, 'C7 ROI 只数 source=memory 的注入（knowledge 那行不算）');
  eq([d.roi.chars, d.roi.completed, d.roi.failed, d.roi.pending], [200, 1, 1, 0], 'C8 ROI 字数/结局');
  eq(d.injections.length, 2, 'C9 注入历史只列 source=memory');
  ok(d.injections.every((r) => r.source_label.length > 0), 'C10 注入行也带来源人话名');
  ok(d.injections.some((r) => r.task_title === '部署任务') && d.injections.some((r) => r.task_title === '排查任务'), 'C11 注入行带任务标题');
  eq(d.evidence?.file_path, 'src/a.ts', 'C12 证据从 context_json.evidence 解析');
  eq(d.history.length, 1, 'C13 改账历史取 target_type=memory 的审计行');
  eq(d.history[0]?.action, 'memory.update', 'C14 改账动作名');
  eq(d.history[0]?.detail.fields, ['content'], 'C15 审计 detail 解析为对象');

  const cross = memoryDetail(db, 'm4');
  ok(!!cross, 'C16 跨项目记忆详情读得到');
  eq(cross?.memory.cross_project, true, 'C17 无项目归属 ⇒ cross_project=true');
  eq(cross?.memory.project_name, '', 'C18 跨项目时项目名为空串（不编名字）');

  eq(memoryDetail(db, 'not-exist'), null, 'C19 不存在的 id ⇒ null（调用方回 NOT_FOUND）');
}

// ═══ D｜人工写口 ═════════════════════════════════════════════════════════════
function sectionD(db: AnyDb): void {
  console.log('\n【D】人工写口：新增 / 修订 / 遗忘（审计有痕）');
  const NOW = Date.UTC(2026, 10, 8, 9, 0, 0); // 2026-11-08 09:00:00 UTC
  const nowStr = utcNowIso(NOW);
  const totalBefore = Number((db.prepare('SELECT COUNT(*) AS c FROM wa_memories').get() as { c: number }).c);

  const add = mutateMemory(db, {
    op: 'add', content: '手动新增的经验：升级前先备份数据库', projectId: 'p1',
    type: 'semantic', importance: 0.9,
  }, { nowMs: NOW });
  ok(add.ok && add.id.length > 0, 'D1 新增成功并回 id', add.error);
  eq(add.source, MEM_SOURCE_MANUAL, 'D2 新增来源记 manual');
  const row = db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(add.id) as Record<string, unknown>;
  eq([row.source, row.memory_type, row.project_id], ['manual', 'semantic', 'p1'], 'D3 落库列值与入参一致');
  eq(Number(row.importance), 0.9, 'D4 重要度落库');
  eq(row.updated_at, nowStr, 'D5 updated_at = 注入时刻（UTC 串）');
  eq(JSON.parse(String(row.context_json)).manual, true, 'D6 context_json 标记 manual');
  const createAudit = db.prepare("SELECT * FROM wa_audit_events WHERE action = 'memory.create' AND target_id = ?").get(add.id) as Record<string, unknown> | undefined;
  ok(!!createAudit, 'D7 新增写审计 memory.create');
  eq(JSON.parse(String(createAudit?.detail_json ?? '{}')).source, 'manual', 'D8 审计记来源 manual');

  const found = listMemories(db, { keyword: '新增的经验' });
  ok(found.list.some((r) => r.id === add.id), 'D9 手动新增后可被全库检索到', `mode=${found.keywordMode}`);

  const empty = mutateMemory(db, { op: 'add', content: '   ' }, { nowMs: NOW });
  ok(!empty.ok && empty.error.includes('不能为空'), 'D10 空正文被拒且给原因', empty.error);
  const totalAfterEmpty = Number((db.prepare('SELECT COUNT(*) AS c FROM wa_memories').get() as { c: number }).c);
  eq(totalAfterEmpty, totalBefore + 1, 'D11 被拒的新增不落行');

  const badProj = mutateMemory(db, { op: 'add', content: '孤儿项目记忆', projectId: 'p-missing' }, { nowMs: NOW });
  ok(!badProj.ok && badProj.error.includes('项目不存在'), 'D12 不存在的项目被拒（不写脏归属）', badProj.error);

  // 修订正文
  const oldContent = '手动新增的经验：升级前先备份数据库';
  const rev = mutateMemory(db, { op: 'revise', id: add.id, content: '新的修订文本：先灰度再全量' }, { nowMs: NOW });
  ok(rev.ok, 'D13 修订成功', rev.error);
  eq(rev.source, 'user_correction', 'D14 改正文 ⇒ 来源转 user_correction');
  const row2 = db.prepare('SELECT content, source, updated_at FROM wa_memories WHERE id = ?').get(add.id) as Record<string, unknown>;
  eq(row2.content, '新的修订文本：先灰度再全量', 'D15 新值已落库');
  ok(!String(row2.content).includes('升级前先备份数据库'), 'D16 旧值不残留');
  const oldHit = listMemories(db, { keyword: '升级前先备份数据库' });
  ok(!oldHit.list.some((r) => r.id === add.id), 'D17 用旧正文检索不到该条');
  const newHit = listMemories(db, { keyword: '先灰度再全量' });
  ok(newHit.list.some((r) => r.id === add.id), 'D18 用新正文检索得到该条');
  const upd = db.prepare("SELECT * FROM wa_audit_events WHERE action = 'memory.update' AND target_id = ? ORDER BY rowid DESC").get(add.id) as Record<string, unknown> | undefined;
  ok(!!upd, 'D19 修订写审计 memory.update');
  const updDetail = JSON.parse(String(upd?.detail_json ?? '{}'));
  eq([updDetail.previousSource, updDetail.source, updDetail.fields], ['manual', 'user_correction', ['content']], 'D20 审计记「改前来源 / 改后来源 / 改了哪些字段」');

  // 只改类型：来源不动
  const revType = mutateMemory(db, { op: 'revise', id: add.id, type: 'procedural' }, { nowMs: NOW });
  ok(revType.ok, 'D21 只改类型成功', revType.error);
  eq(revType.source, 'user_correction', 'D22 只改类型不动来源');
  const row3 = db.prepare('SELECT memory_type, source FROM wa_memories WHERE id = ?').get(add.id) as Record<string, unknown>;
  eq([row3.memory_type, row3.source], ['procedural', 'user_correction'], 'D23 类型已改、来源保持');

  const noop = mutateMemory(db, { op: 'revise', id: add.id }, { nowMs: NOW });
  ok(!noop.ok && noop.error.includes('没有要修改的字段'), 'D24 空修订被拒且给原因', noop.error);
  const missing = mutateMemory(db, { op: 'revise', id: 'nope', content: 'x' }, { nowMs: NOW });
  ok(!missing.ok && missing.error.includes('不存在'), 'D25 修订不存在的记忆被拒', missing.error);

  // 遗忘（墓碑）
  const forget = mutateMemory(db, { op: 'forget', id: 'm4', reason: '测试遗忘' }, { nowMs: NOW });
  ok(forget.ok, 'D26 遗忘成功', forget.error);
  const tombRow = db.prepare('SELECT * FROM wa_memories WHERE id = ?').get('m4') as Record<string, unknown>;
  eq(tombRow.memory_type, 'deleted', 'D27 落墓碑哨兵');
  eq(tombRow.content, '', 'D28 正文已清');
  eq(tombRow.deleted_reason, '测试遗忘', 'D29 缘由如实落库');
  eq(tombRow.deleted_at, nowStr, 'D30 删除时刻 = 注入时刻');
  ok(String(tombRow.deleted_fingerprint).length > 0, 'D31 内容指纹留有（机器提不回同一段）');
  ok(!listMemories(db, {}).list.some((r) => r.id === 'm4'), 'D32 遗忘后默认列表不可见');
  ok(listMemories(db, { type: 'deleted' }).list.some((r) => r.id === 'm4'), 'D33 墓碑审计面可见');
  const forgetAudit = db.prepare("SELECT * FROM wa_audit_events WHERE action = 'memory.forget' AND target_id = 'm4'").get() as Record<string, unknown> | undefined;
  ok(!!forgetAudit, 'D34 遗忘写审计 memory.forget');
  const again = mutateMemory(db, { op: 'forget', id: 'm4' }, { nowMs: NOW });
  ok(!again.ok, 'D35 二次遗忘如实失败（不谎报成功）', again.error);

  const unknown = mutateMemory(db, { op: 'nope' } as never, { nowMs: NOW });
  ok(!unknown.ok && unknown.error.includes('未知操作'), 'D36 未知操作被拒', unknown.error);
}

// ═══ E｜容量与索引健康 ═══════════════════════════════════════════════════════
function sectionE(db: AnyDb): void {
  console.log('\n【E】容量：按类型/来源/项目、FTS 健康、重复候选');

  // D 段把唯一一条 manual 来源的记忆改成了 user_correction，容量分布里就没有 manual 了 ⇒ 本段自备一条。
  db.prepare("INSERT INTO wa_memories (id, content, memory_type, source, created_at) VALUES ('man1','人工录入的容量标本：发布前先查变更日志','semantic','manual','2026-11-07 09:00:00')").run();
  db.prepare("INSERT INTO wa_memories (id, content, memory_type, source, created_at) VALUES ('dup1','重复内容标本：同一条经验写了两遍','semantic','auto_extract','2026-11-07 10:00:00')").run();
  db.prepare("INSERT INTO wa_memories (id, content, memory_type, source, created_at) VALUES ('dup2','重复内容标本：同一条经验写了两遍','semantic','auto_extract','2026-11-07 11:00:00')").run();

  const cap = memoryCapacity(db);
  const totalRows = Number((db.prepare('SELECT COUNT(*) AS c FROM wa_memories').get() as { c: number }).c);
  const liveRows = Number((db.prepare("SELECT COUNT(*) AS c FROM wa_memories WHERE memory_type NOT IN ('archived','deleted')").get() as { c: number }).c);
  eq(cap.total, totalRows, 'E1 total 覆盖全部行（含墓碑/归档）');
  eq(cap.live, liveRows, 'E2 live 只数活记忆');
  ok(cap.chars > 0, 'E3 正文字数合计为正', String(cap.chars));

  const byType = Object.fromEntries(cap.byType.map((t) => [t.type, t]));
  eq(byType.semantic?.label, '语义记忆', 'E4 类型带人话名');
  ok((byType.deleted?.count ?? 0) >= 2, 'E5 墓碑类型在容量里如实可见');

  const bySource = Object.fromEntries(cap.bySource.map((s) => [s.source, s]));
  eq(bySource.manual?.label, '手动新增', 'E6 来源带人话名（manual）');
  eq(bySource.agent_execution?.label, MEM_SOURCE_LABEL.agent_execution, 'E7 来源标签与词表真源一致');
  ok(cap.bySource.every((s) => s.source !== 'deleted'), 'E8 墓碑行不计入来源分布（bySource 只数活记忆）');

  ok(cap.byProject.some((p) => p.projectId === null), 'E9 无项目归属的记忆单列一组（projectId=null）');
  eq(cap.byProject.find((p) => p.projectId === 'p1')?.projectName, '项目甲', 'E10 项目名可读');

  eq(cap.fts.available, true, 'E11 FTS 可用');
  eq(cap.fts.missing, 0, 'E12 触发器顺序正确 ⇒ 没有未索引的活记忆');
  eq(cap.fts.orphaned, 0, 'E13 没有孤立索引行');
  eq(cap.fts.indexed, totalRows, 'E14 索引行数 = 记忆行数（每行都被索引）');

  const dup = cap.mergeCandidates.find((c) => c.count === 2 && c.preview.includes('重复内容标本'));
  ok(!!dup, 'E15 重复候选被识别（只读建议）');
  eq(sorted(dup?.ids ?? []), ['dup1', 'dup2'], 'E16 候选组包含两条同文 id');
  ok(cap.mergeCandidates.every((c) => c.count > 1 && c.preview.length > 0), 'E17 候选组至少两条且带预览');

  eq(memSourceLabel('agent_execution'), '代理执行', 'E18 memSourceLabel 命中词表');
  eq(memSourceLabel('a-source-from-future'), 'a-source-from-future', 'E19 词表外历史值如实以原键显示（不猜）');
  eq(memSourceLabel(''), '未知来源', 'E20 空来源如实标「未知来源」');
  // 真库实测存在的写口取值（2026-11-08 只读核对），逐个钉死：不译即上屏英文原键。
  const prodSources: Array<[string, string]> = [
    ['retrospective', '任务复盘'],
    ['outcome_exemplar', '验收成果配方'],
    ['acceptance_check', '验收核查'],
    ['task_failure', '任务失败'],
    ['synthesis', '全景综合'],
    ['abstraction', '规则抽象'],
  ];
  const untranslated = prodSources.filter(([k, v]) => memSourceLabel(k) !== v);
  ok(untranslated.length === 0, 'E21 真库既有来源取值逐个有中文名', untranslated.map(([k]) => k).join(','));
  eq(memSourceLabel('working_memory:bc48587c:1578692375'), '工作记忆（任务临时）', 'E22 动态来源键按前缀认');
  ok(MEM_SOURCE_LABEL.background_review === '后台复盘', 'E23 头部来源仍在词表（未因扩表丢失）');
}

// ═══ F｜接线与构建钉 ═════════════════════════════════════════════════════════
function sectionF(): void {
  console.log('\n【F】接线：core ↔ IPC ↔ renderer ↔ 面板 + 构建钉');

  const read = (rel: string) => fs.readFileSync(path.join(DESKTOP, rel), 'utf-8');
  const adminSrc = read('src/main/core/memory-admin.ts');
  ok(adminSrc.includes('export function listMemories('), 'F1 core 导出 listMemories');
  ok(adminSrc.includes('export function memoryDetail('), 'F2 core 导出 memoryDetail');
  ok(adminSrc.includes('export function mutateMemory('), 'F3 core 导出 mutateMemory');
  ok(adminSrc.includes('export function memoryCapacity('), 'F4 core 导出 memoryCapacity');
  ok(!/from 'electron'/.test(adminSrc), 'F5 core 零 electron 依赖（回归可直跑生产实现）');

  const lifeSrc = read('src/main/core/memory-lifecycle.ts');
  ok(lifeSrc.includes('export const MEM_SOURCE_MANUAL'), 'F6 来源哨兵 manual 在词表真源里');
  ok(lifeSrc.includes('export const MEM_SOURCE_LABEL'), 'F7 来源人话名词表唯一落点');
  ok(lifeSrc.includes('export function memSourceLabel('), 'F8 来源标签函数唯一落点');

  const ipcSrc = read('src/main/ipc/admin.ipc.ts');
  ok(/import \{[^}]*listMemories[^}]*\} from '\.\.\/core\/memory-admin\.js'/.test(ipcSrc), 'F9 IPC 直引 core 真源（不在 handler 里另写判断）');
  ok(ipcSrc.includes("ipcMain.handle('admin:memoryDetail'"), 'F10 IPC 注册 admin:memoryDetail');
  ok(ipcSrc.includes("ipcMain.handle('admin:memoryMutate'"), 'F11 IPC 注册 admin:memoryMutate');
  ok(ipcSrc.includes("ipcMain.handle('admin:memoryCapacity'"), 'F12 IPC 注册 admin:memoryCapacity');
  ok(ipcSrc.includes('const result = listMemories(db, input ?? {})'), 'F13 admin:memories 走服务端筛选实现');
  ok(ipcSrc.includes('rows: result.list'), 'F14 兼容别名 rows 与 list 同源同一数组');
  ok(ipcSrc.includes("mutateMemory(db, { op: 'forget'") || ipcSrc.includes("mutateMemory(db, { op: 'forget',"), 'F15 旧删除口改走人工写口（补审计）');

  const rIpc = read('renderer/src/lib/ipc.ts');
  ok(rIpc.includes('memories: (filters: MemoryListFilter') || rIpc.includes('memories: (filters: MemoryListFilter = {})'), 'F16 renderer 列表入参即 main 侧 filter 类型');
  ok(rIpc.includes("memoryDetail: (id: string) => ipcCall<MemoryDetail>('admin:memoryDetail'"), 'F17 renderer 暴露详情');
  ok(rIpc.includes("memoryMutate: (input: MemoryMutation) => ipcCall<MemoryMutateResult>('admin:memoryMutate'"), 'F18 renderer 暴露写口');
  ok(rIpc.includes("memoryCapacity: () => ipcCall<MemoryCapacity>('admin:memoryCapacity'"), 'F19 renderer 暴露容量');

  const page = read('renderer/src/pages/MemoriesPage.tsx');
  const pageCode = stripKeepingLines(page).join('\n');
  ok(page.includes('admin.memories({') && pageCode.includes('keyword: debouncedSearch'), 'F20 面板搜索走服务端参数（防抖）');
  ok(pageCode.includes('timeFrom:') && pageCode.includes('sourceFilter'), 'F21 面板传时刻/来源筛选');
  // 病根是「按关键词/筛选条件在当前页数组上 filter」；冲突批量处理对当前页取冲突项是另一回事。
  // 只认前者，且不靠变量名躲（任一 filter 行引用筛选状态即算复发）。
  const pageLines = stripKeepingLines(page);
  const filterLines = pageLines.filter((l) => l.includes('.filter('));
  const searchFiltered = filterLines.filter((l) => /search|keyword|projFilter|typeFilter|sourceFilter|timeFrom|timeTo/i.test(l));
  ok(searchFiltered.length === 0 && pageCode.includes('items.map('), 'F22 列表直接渲染服务端结果（客户端「当前页过滤」已删除，否则全库搜索仍是假的）', searchFiltered.join(' | ') || `filter 行 ${filterLines.length} 条均与筛选状态无关`);
  ok(pageCode.includes('m.source_label'), 'F23 卡片显示来源人话名（不再上屏英文原值）');
  ok(pageCode.includes('MEM_SOURCE_LABEL'), 'F24 来源词表直引 main 真源');
  ok(pageCode.includes('cross_project'), 'F25 跨项目记忆有标注');
  ok(pageCode.includes('admin.memoryDetail('), 'F26 面板真的调了详情接口');
  ok(pageCode.includes('admin.memoryMutate('), 'F27 面板真的调了人工写口');
  ok(pageCode.includes('admin.memoryCapacity('), 'F28 面板真的调了容量接口');
  ok(pageCode.includes('keywordMode'), 'F29 面板据实际取数路给回落提示');
  ok(pageCode.includes('<details'), 'F30 容量放在次级区域（可折叠）');
  ok(pageCode.includes('confirm('), 'F31 遗忘带二次确认');

  const { tag } = deriveBuildTag(read('src/main/core/agent-executor.ts'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'F32 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

function main(): void {
  const mainDb = buildMainDb();
  sectionA(mainDb);
  sectionB();
  sectionC(mainDb);
  sectionD(mainDb);
  sectionE(mainDb);
  sectionF();
  console.log(`\n[rr_${SELF_ROUND}_memory] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
