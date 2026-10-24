/**
 * zx_20261012_1 受控复跑 —— 「知返」：**出了问题要看得见、去得了、回得来**。
 *
 * 本轮口径一句话（道德经·知人者智自知者明 / 维特根斯坦·一个规则一处 / 夏克特·记忆七宗罪）：
 *   · 批一（M29）**静默失败清零**——记忆子系统的十余处 `catch {}` 既不计数也不留痕 ⇒
 *     "记忆这一路有没有在坏、坏在哪一环"无从回答（夏克特·错误归因：把失败读成"本来就没有"）。
 *     治法＝**一处真源计数器**（`MEM_FAIL` 具名枚举 + `recordMemoryFailure`），降级不变、留痕。
 *     同时把 `consolidateMemories` 的被并入方由**物理删**改**落墓碑**（承"账必有痕"）。
 *   · 批二（M26-a/b）embedding 缓存失效 + 共现强化（本套件续加）。
 *   · 批三（M28）夏克特七宗罪**验收套件**——每宗配"该命中/不该命中"两只标本（本套件续加）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/放行/收窄"的判据，反面标本（不命中）一并喂。
 *   G-4 **不碰真实网络/墙钟**：到 ANS 的探活一概打 `127.0.0.1:1`（确定性快速失败）。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 计数器类断言一律**正面**（"值从 0 变 1"），不只断言"不抛"（被空吞的写入只有正面断言抓得住）。
 *   ⚠ 夹具按**生产初始化顺序**搭：先 `new MemoryManager`（建 FTS 触发器）**再**插行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败。
import { MemoryManager, embeddingCacheKey, CO_OCCUR_BOOST } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import {
  recordMemoryFailure, memoryFailureSnapshot, resetMemoryFailureCounters, MEM_FAIL,
} from '../apps/worker-ant-desktop/src/main/core/memory-failure.js';
import {
  MEM_TYPE_DELETED, consolidatedIntoReason, tombstoneMemory,
} from '../apps/worker-ant-desktop/src/main/core/memory-lifecycle.js';
import { retrieveKnowledgeGraphContext } from '../apps/worker-ant-desktop/src/main/core/memory-kg.js';
import { listProspective, scanDueProspective } from '../apps/worker-ant-desktop/src/main/core/memory-prospective.js';
import { WM_POOL_CAP, applySchemaRecall, extractKeywords } from '../apps/worker-ant-desktop/src/main/core/memory-select.js';
import { decayFactor, memoryAgeDays } from '../apps/worker-ant-desktop/src/main/core/memory-decay.js';
import { deleteProjectCascade } from '../apps/worker-ant-desktop/src/main/core/project-engine.js';
import {
  installSampleProject, removeSampleProject, SAMPLE_PROJECT_ID, SAMPLE_TASK_IDS,
} from '../apps/worker-ant-desktop/src/main/core/sample-project.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**；判"用户可见文案还在不在"用 `CODE()`（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

type AnyDb = import('better-sqlite3').Database;

/* ── 空吞识别（三读文件收口判据）──────────────────────────────────────────── */
/** 空 catch 体（body 仅空白或注释，或无 body）——裸空块与仅含注释两种形态都算"静默吞"。 */
const EMPTY_CATCH_BODY = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\n]*))\s*\}/g;
const EMPTY_CATCH_BARE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
function emptyCatchCount(rel: string): number {
  const code = CODE(rel);
  return (code.match(EMPTY_CATCH_BODY) ?? []).length + (code.match(EMPTY_CATCH_BARE) ?? []).length;
}
/** `recordMemoryFailure(` 后**不是** `MEM_FAIL.` 的调用数（手写裸串 = 第二处词表）。 */
function bareKindCalls(rel: string): number {
  return (CODE(rel).match(/recordMemoryFailure\(\s*(?!MEM_FAIL\.)/g) ?? []).length;
}
/** 从源码收集 `MEM_FAIL.<key>` 用到的 key（判"无拼错、无越界"）。 */
function usedFailKeys(rel: string): string[] {
  return [...CODE(rel).matchAll(/\bMEM_FAIL\.(\w+)/g)].map((m) => m[1]!);
}

/* ── 夹具（照 `database.ts` DDL 摘取，含 M8 三列）──────────────────────────── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT '');
CREATE INDEX idx_wa_memories_tombstone ON wa_memories(memory_type, deleted_fingerprint);
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };
const mkEmptyDb = (): AnyDb => new DatabaseSync(':memory:') as unknown as AnyDb;

const insMem = (db: AnyDb, id: string, project: string, content: string, emb: number[] | null, ageMin = 0): void => {
  db.prepare(`INSERT INTO wa_memories (id, project_id, content, embedding, memory_type, importance, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'episodic', 0.5, datetime('now', ?), datetime('now', ?))`)
    .run(id, project, content, emb ? JSON.stringify(emb) : null, `-${ageMin} minutes`, `-${ageMin} minutes`);
};
const memRow = (db: AnyDb, id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(id) as Record<string, unknown>;
/** 插一条任务（`context_json` 携带 per-run 入文台账 / 失败字据，供 `reinforceMemories` 读）。 */
const insTask = (db: AnyDb, id: string, project: string, ctx: Record<string, unknown>, status = 'completed'): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, context_json, status) VALUES (?, ?, ?, ?)')
    .run(id, project, JSON.stringify(ctx), status);
};
/** 缓存私有面（rr 直取，判"项在不在"）——生产无公开读口，这正是本轮要治的内存结构。 */
const cacheOf = (mm: MemoryManager): Map<string, number[]> =>
  (mm as unknown as { _embeddingCache: Map<string, number[]> })._embeddingCache;
const impOf = (db: AnyDb, id: string): number => Number(memRow(db, id).importance);
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/* ── 批四夹具：示例项目要落的那几张表 + `is_sample` 列（照 `database.ts` DDL 摘取）────────
 * 与上面的 SCHEMA **刻意分开**——只在 K 段用，不影响既有 A–J 各段的夹具（改动面最小化）。
 *
 * ⚠ **外键逐条照搬生产**（`database.ts` 的 `REFERENCES`），并在 `mkSampleDb` 里 `PRAGMA foreign_keys = ON`。
 *   起因（zx_20261012_1 实机 E2E 照出）：本夹具初版**只有裸列、无 FK、FK 亦关**，于是两条真缺陷在
 *   `pnpm rr:all` 里**全绿**——`installSampleProject` 写 `owner_id='sample'`（无此用户）与
 *   `deleteProjectCascade` 落墓碑后仍留着 `wa_memories.project_id → wa_projects` 的父引用，实机双双
 *   `FOREIGN KEY constraint failed`。**夹具比生产宽松 ⇒ 断言只是自我印证**（K-0a/K-0b 即为此设的正面闸）。 */
const SCHEMA_SAMPLE = SCHEMA
  .replace(
    "CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');",
    `CREATE TABLE wa_users (id TEXT PRIMARY KEY, username TEXT DEFAULT '', role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', status TEXT DEFAULT 'active',
      cron_schedule TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai', working_dir TEXT DEFAULT '',
      owner_id TEXT REFERENCES wa_users(id), is_sample INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));`,
  )
  .replace(
    "CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p',",
    'CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),',
  )
  .replace(
    'CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,',
    'CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT REFERENCES wa_tasks(id), role TEXT NOT NULL,',
  )
  .replace(
    'CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,',
    'CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT, content TEXT NOT NULL,',
  ) + `
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
  description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT REFERENCES wa_deliverables(id), file_path TEXT NOT NULL,
  content_snapshot TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  changed_by TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_notifications (id TEXT PRIMARY KEY, event_id TEXT, type TEXT NOT NULL, task_id TEXT, project_id TEXT,
  title TEXT NOT NULL, body TEXT, read_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_knowledge_triples (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), subject TEXT NOT NULL, predicate TEXT NOT NULL,
  object TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'agent_extraction',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_members (project_id TEXT REFERENCES wa_projects(id), user_id TEXT REFERENCES wa_users(id),
  role TEXT DEFAULT 'developer', PRIMARY KEY (project_id, user_id));
-- zx_20261021_3 批一：删项目级联会删**启用映射**（资产留下）。生产无外键（头注写明），此处同形。
CREATE TABLE wa_domain_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  pack_json TEXT NOT NULL, source_project_id TEXT, source_project_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_domain_packs (project_id TEXT NOT NULL, pack_id TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, pack_id));
-- zx_20261022_3 批七：级联删除现在也清**项目知识册**（派生/导入/导入账三张）。生产同样无外键、走显式 DELETE；
--   夹具缺表会让 K-4 段直接抛「no such table」——照生产同形补齐（不是放宽）。
CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
  content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
CREATE TABLE wa_project_knowledge_imports (project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
  imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
CREATE TABLE wa_knowledge_imports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge',
  sections INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT DEFAULT (datetime('now')));
-- zx_20261022_3 批八：级联删除也清**项目画像**（生产 database.ts 同 DDL）。夹具缺表 ⇒ K-4 段抛 no such table。
CREATE TABLE wa_project_profiles (project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
  source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL, generated_at TEXT DEFAULT (datetime('now')),
  enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT '');
`;
/** `node:sqlite` 无 `db.transaction()`，而 `installSampleProject`/`deleteProjectCascade` 是真实现（用事务）——
 *  故补这一枚驱动方法（语义照 better-sqlite3：抛错即 ROLLBACK 后原样抛出）。 */
const withTx = (d: AnyDb): AnyDb => {
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => {
    d.exec('BEGIN');
    try { fn(); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* 无活动事务 */ } throw e; }
  };
  return d;
};
const mkSampleDb = (): AnyDb => withTx((() => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA_SAMPLE);
  d.exec('PRAGMA foreign_keys = ON'); // 与生产 `database.ts:24` 同 —— 否则 FK 类缺陷在此恒不引爆
  return d as unknown as AnyDb;
})());
const cntOf = (db: AnyDb, sql: string, ...args: unknown[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);

// ══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {

  // ═══ A｜三读文件零空吞（静态扫面，plan 收口判据）════════════════════════════════
  console.log('\n【A】三读文件零空吞（静默失败清零的静态收口）');
  {
    const files = [
      `${A}/src/main/core/memory-context.ts`,
      `${A}/src/main/core/memory-prospective.ts`,
      `${A}/src/main/core/memory-kg.ts`,
    ];
    eq(files.map(emptyCatchCount), [0, 0, 0],
      'A-1 ★★三读文件（装配/前瞻/图）**零空吞**（空 body 或仅注释 body 皆计）——"静默"这一形态消失');
    const cnts = files.map((f) => (CODE(f).match(/recordMemoryFailure\(/g) ?? []).length);
    eq(cnts.map((c) => c > 0), [true, true, true],
      'A-2 三文件都真接上了 `recordMemoryFailure`（不是"删了空吞、忘了补痕"）');
    // zx_20261021_3 批一：装配面新增「领域包」段，其吞点同形补痕 ⇒ 26 → 27。
    // zx_20261022_3 批八：再添「项目画像」段 ⇒ 27 → 28。
    // zx_20261023_5 批二：再添「项目知识卡」段 ⇒ 28 → 29。
    //   计数是**历史累加**的，单独一个数说不清"新段真接上了"——故逐段按名钉到成员。
    eq(cnts, [29, 6, 2],
      'A-3 ★逐成员枚举：装配 29 段 / 前瞻 6 处 / 图 2 处（读侧吞点逐条改，无遗漏）');
    eq(CODE(files[0]!).match(/recordMemoryFailure\(MEM_FAIL\.contextSection, err, \{ section: '领域包' \}\)/g)?.length,
      1, 'A-3b ★新段「领域包」的吞点**按段名**钉在成员上（计数涨了不等于新段接上了）');
    eq(CODE(files[0]!).match(/recordMemoryFailure\(MEM_FAIL\.contextSection, err, \{ section: '项目画像' \}\)/g)?.length,
      1, 'A-3c ★新段「项目画像」的吞点**按段名**钉在成员上（计数涨了不等于新段接上了）');
    eq(CODE(files[0]!).match(/recordMemoryFailure\(MEM_FAIL\.contextSection, err, \{ section: '项目知识卡' \}\)/g)?.length,
      1, 'A-3d ★新段「项目知识卡」的吞点**按段名**钉在成员上（计数涨了不等于新段接上了）');
    // 反证：`memory-failure.ts` 自身不得有吞点（它就是"留痕"那一跳）。
    eq(emptyCatchCount(`${A}/src/main/core/memory-failure.ts`), 0,
      'A-4 反证：计数器模块自身零空吞（否则"记一笔"这一步自己会静默失败）');
  }

  // ═══ B｜MEM_FAIL 一处真源 + 调用面不手写裸串 ════════════════════════════════════
  console.log('\n【B】失败环节具名枚举一处真源');
  {
    const keys = Object.keys(MEM_FAIL);
    ok(keys.length >= 20, 'B-1 `MEM_FAIL` 枚举具名且完备（≥20 个环节）', `${keys.length} 个`);
    eq(keys.filter((k) => typeof (MEM_FAIL as Record<string, unknown>)[k] !== 'string'), [],
      'B-2 枚举值全为字符串（`as const` 具名，非数字/符号）');
    eq([...new Set(Object.values(MEM_FAIL))].length, keys.length, 'B-3 枚举值两两不同（无别名撞车）');
    const consumers = [
      `${A}/src/main/core/memory-context.ts`,
      `${A}/src/main/core/memory-prospective.ts`,
      `${A}/src/main/core/memory-kg.ts`,
      `${A}/src/main/core/memory-manager.ts`,
    ];
    eq(consumers.map(bareKindCalls), [0, 0, 0, 0],
      'B-4 ★★消费侧**零**手写裸字符串 kind（`recordMemoryFailure(MEM_FAIL.…)` 一处真源——禁"同一件事两个名字"）');
    const used = new Set(consumers.flatMap(usedFailKeys));
    const valid = new Set(keys);
    eq([...used].filter((k) => !valid.has(k)), [],
      'B-5 引用到的每个 `MEM_FAIL.<key>` 都真实存在（无拼错/无越界）');
    ok(used.size >= 20, 'B-6 枚举**确有**被用（不是登记了却没人引的空词表）', `${used.size}/${keys.length} 在用`);
  }

  // ═══ C｜计数器 0→1（行为：生产函数直引）═══════════════════════════════════════
  console.log('\n【C】计数器 0→1 正面断言（夏克特·心不在焉：编码/检索失败须可见）');
  {
    // C-1 读侧：图检索在缺表库上必抛 ⇒ 被吞，但**计一次数**（退化为 []，可用性不变）。
    resetMemoryFailureCounters();
    eq(memoryFailureSnapshot(), {}, 'C-1 起跑：快照为空（0 基准）');
    const badDb = mkEmptyDb();
    const mgr = { db: badDb, ansClient: null } as never;
    eq(retrieveKnowledgeGraphContext(mgr, 't1', 'p1'), [], 'C-2 图检索降级返回 `[]`（回退语义**不变**）');
    eq(memoryFailureSnapshot()['kg.query'], 1, 'C-3 ★★计数 0→1：`kg.query` 记了一笔（静默失败现形）');

    // C-4 读侧：列举前瞻记忆在缺表库上必抛 ⇒ 计数，返回 []。
    resetMemoryFailureCounters();
    eq(listProspective(mgr, 'p1'), [], 'C-4 前瞻列举降级返回 `[]`');
    eq(memoryFailureSnapshot()['prospective.list'], 1, 'C-5 ★★计数 0→1：`prospective.list` 记了一笔');

    // C-6 写侧：工作记忆入池在缺表库上必抛 ⇒ 计数（void 返回，可用性不变）。
    resetMemoryFailureCounters();
    const wdb = mkdb();
    const wmm = new MemoryManager(wdb, null as never); // ← FTS 触发器在此建成（生产顺序）
    wdb.exec('DROP TABLE wa_tasks'); // 制造写入失败面
    wmm.addWorkingMemory('t1', '一段工作笔记');
    eq(memoryFailureSnapshot()['workingMemory.add'], 1, 'C-6 ★★写侧计数 0→1：`workingMemory.add` 记了一笔（吞写入者不得再空吞）');

    // C-7 反证（不该命中）：正常写入 ⇒ 计数为 0。
    resetMemoryFailureCounters();
    const gdb = mkdb();
    const gmm = new MemoryManager(gdb, null as never);
    gdb.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t1','{}')").run();
    gmm.addWorkingMemory('t1', '正常笔记');
    eq(memoryFailureSnapshot(), {}, 'C-7 ★反证：正常写入 ⇒ **零计数**（C-6 不是"凡调用必计数"）');

    // C-8 计数只增不改语义：多次失败累加。
    resetMemoryFailureCounters();
    retrieveKnowledgeGraphContext(mgr, 't2', 'p2');
    retrieveKnowledgeGraphContext(mgr, 't3', 'p3');
    eq(memoryFailureSnapshot()['kg.query'], 2, 'C-8 同一环节失败**累加**（不是覆盖成 1）');
    resetMemoryFailureCounters();
    eq(memoryFailureSnapshot(), {}, 'C-9 `resetMemoryFailureCounters` 真清零（供 rr/测试隔离）');
  }

  // ═══ D｜墓碑纪律：整合的被并入方落墓碑 ══════════════════════════════════════════
  console.log('\n【D】墓碑纪律（承"账必有痕"：被合并的记忆留一条痕）');
  {
    resetMemoryFailureCounters();
    const db = mkdb();
    const mm = new MemoryManager(db, null as never);
    // 两条**同嵌入**记忆（sim=1>0.92）——较新者当容器，较旧者被并入。
    insMem(db, 'm-new', 'p', '新记忆正文', [1, 0, 0], 0);
    insMem(db, 'm-old', 'p', '旧记忆正文', [1, 0, 0], 5);
    const n = mm.consolidateMemories('p');
    eq(n, 1, 'D-1 同嵌入两条 ⇒ 恰合并一次');
    const survivor = memRow(db, 'm-new');
    eq((survivor.content as string).includes('合并记忆') && (survivor.content as string).includes('旧记忆正文'), true,
      'D-2 承接方（较新）正文含两段内容（合并语义不变）');
    const gone = memRow(db, 'm-old');
    eq([gone.memory_type, gone.content], [MEM_TYPE_DELETED, ''],
      'D-3 ★★被并入方**落墓碑**（`memory_type=deleted` + 正文清空）——原为**物理删**（去向不可查）');
    eq(gone.deleted_reason, consolidatedIntoReason('m-new'),
      'D-4 ★★`deleted_reason` 指向**承接方**（`consolidated-into:m-new`）——"这条并进了谁"可答');
    ok(typeof gone.deleted_at === 'string' && (gone.deleted_at as string).length > 0, 'D-5 墓碑带 `deleted_at` 时刻');
    ok(typeof gone.deleted_fingerprint === 'string' && (gone.deleted_fingerprint as string).length > 0,
      'D-6 墓碑带原正文**指纹**（据此可拦"删掉的内容被机器重新提取回来"）');
    eq(memoryFailureSnapshot(), {}, 'D-7 ★反证：整合成功 ⇒ **零计数**（正常路径不产生失败痕）');

    // D-8 单源：缘由构造只此一处（消费侧不手写 `consolidated-into:` 前缀）。
    // zx_20261018_2 批七「见简」：整合簇已机械搬入 `memory-consolidation.ts`（只搬不改义）——
    //   判据按符号重定向到新载体，语句形状一字未动（接收者由 `this.db` 改为宿主形参 `mgr.db`）。
    const mgrSrc = CODE(`${A}/src/main/core/memory-manager.ts`);
    const consSrc = CODE(`${A}/src/main/core/memory-consolidation.ts`);
    eq(((mgrSrc + consSrc).match(/consolidated-into/g) ?? []).length, 0,
      'D-8 管理器+巩固模块**零**手写 `consolidated-into` 前缀（缘由串只由 `consolidatedIntoReason` 构造）');
    ok(/tombstoneMemory\(mgr\.db, b\.id, consolidatedIntoReason\(a\.id\)\)/.test(consSrc),
      'D-9 ★整合走**既有墓碑写口**（复用 `tombstoneMemory`，不自造第二份 UPDATE 语句形状）');

    // D-10 `consumed` 守卫（防"被合并走的 b 又当容器去删 c"的静默丢内容）。
    ok(/const consumed = new Set<string>\(\)/.test(consSrc) && /consumed\.has\(b\.id\)/.test(consSrc),
      'D-10 ★整合补齐 `consumed` 守卫（与 `reconsolidateMemories` 同形）');
    // 反证（行为）：三条同嵌入，合并后不得静默丢内容——至多 1 条存活、2 条墓碑，正文皆可追。
    const db2 = mkdb();
    const mm2 = new MemoryManager(db2, null as never);
    insMem(db2, 'c1', 'p', 'AAA', [1, 0, 0], 0);
    insMem(db2, 'c2', 'p', 'BBB', [1, 0, 0], 3);
    insMem(db2, 'c3', 'p', 'CCC', [1, 0, 0], 6);
    mm2.consolidateMemories('p');
    const alive = db2.prepare("SELECT id FROM wa_memories WHERE memory_type NOT IN ('deleted','archived')").all() as Array<{ id: string }>;
    const stones = db2.prepare('SELECT id, deleted_reason FROM wa_memories WHERE memory_type = ?').all(MEM_TYPE_DELETED) as Array<{ id: string; deleted_reason: string }>;
    eq(alive.length, 1, 'D-11 ★★三条同嵌入 ⇒ 存活**恰 1** 条（其余两条落墓碑，不物理消失）');
    eq(stones.length, 2, 'D-12 两条墓碑在场（"这条并进了谁"逐条可答）');
    ok(stones.every((s) => s.deleted_reason.startsWith('consolidated-into:')), 'D-13 墓碑缘由皆指向承接方');
  }

  // ═══ E｜豁免三处如实登记 ═══════════════════════════════════════════════════════
  console.log('\n【E】物理删豁免（如实登记：三处各有其存续理由）');
  {
    // 批七拆分后：豁免#1/#3 留在管理器，豁免#2（冲突消解的较旧行）随整合簇搬入巩固模块。
    //   判据按**两者之和**重定向（总数仍恰 3、登记仍逐条三处——不放宽）。
    const mgr = RD(`${A}/src/main/core/memory-manager.ts`);
    const cons = RD(`${A}/src/main/core/memory-consolidation.ts`);
    const delCount = (mgr.match(/DELETE FROM wa_memories/g) ?? []).length + (cons.match(/DELETE FROM wa_memories/g) ?? []).length;
    eq(delCount, 3, 'E-1 ★管理器+巩固模块里**恰 3 处**物理删（原 4 处，整合那处已改落墓碑）');
    eq(((mgr + cons).match(/墓碑纪律\*\*豁免#\d/g) ?? []).length, 3,
      'E-2 ★★三处豁免**逐条如实登记**（`豁免#1/#2/#3`）——改一处须动此处，防"悄悄多删一处没人知道"');
  }

  // ═══ F｜上屏（如实）：`memory:failures` 端到端可达 ══════════════════════════════
  console.log('\n【F】失败计数上屏（IPC 一处发）');
  {
    const admin = CODE(`${A}/src/main/ipc/admin.ipc.ts`);
    const rend = RD(`${A}/renderer/src/lib/ipc.ts`);
    const preload = RD(`${A}/src/preload/index.ts`);
    ok(/ipcMain\.handle\('memory:failures'/.test(admin), 'F-1 main 侧注册 `memory:failures` handler');
    ok(/memoryFailureSnapshot\(\)/.test(admin), 'F-2 handler 返回**真快照**（不是自造对象）');
    ok(/memoryFailures:\s*\(\)\s*=>\s*ipcCall<[\s\S]*?>\('memory:failures'\)/.test(rend),
      'F-3 ★renderer 侧薄封装 `admin.memoryFailures()` 在场（端到端可达，无 GUI 卡片亦能排障）');
    ok(/invoke:\s*\(channel[^)]*\)[^=]*=>\s*ipcRenderer\.invoke/.test(preload),
      'F-4 preload 走**通用 `invoke`**（无频道白名单 ⇒ 新 handler 自动可达，无须改 preload）');
  }

  // ═══ G｜批二（M26-a）：向量索引缓存**键含正文指纹** ════════════════════════════════
  console.log('\n【G】向量缓存：改正文必失效 / 不改必留（G-2 纯函数 + 行为正反标本）');
  {
    // G-1..G-3 纯函数（`embeddingCacheKey` = id + 正文指纹）
    eq(embeddingCacheKey('a', '甲 乙') === embeddingCacheKey('a', '甲   乙'), true,
      'G-1 仅排版（空白）差异 ⇒ **同键**（指纹先折叠空白 + 小写 ⇒ 排版变不算"另一份内容"）');
    ok(embeddingCacheKey('a', '甲') !== embeddingCacheKey('a', '乙'),
      'G-2 ★反证：正文不同 ⇒ 键不同（旧正文的向量**不可能**被当成新正文的）');
    ok(embeddingCacheKey('a', '甲') !== embeddingCacheKey('b', '甲'),
      'G-3 两条同正文不同 id ⇒ 键不同（互不串味）');

    // G-4..G-7 行为：改正文必失效；改甲的正文不得误伤乙（两侧标本）
    const db = mkdb();
    const mm = new MemoryManager(db, null as never);
    const cache = cacheOf(mm);
    insMem(db, 'm1', 'p', '第一条正文', null);
    insMem(db, 'm2', 'p', '第二条正文', null);
    mm.updateEmbedding('m1', [1, 0, 0]);
    const k1 = embeddingCacheKey('m1', '第一条正文');
    eq([cache.has(k1), cache.has(embeddingCacheKey('m2', '第二条正文'))], [true, false],
      'G-4 前置：`updateEmbedding` 后按 **id+当前正文** 建项（未算向量的那条不在）');
    mm.updateMemory('m1', '第一条正文（改过）');
    eq(cache.has(k1), false,
      'G-5 ★★改正文（`updateMemory`）⇒ 旧缓存项**失效**（不再拿旧正文的向量算新正文的相关度）');
    mm.updateEmbedding('m2', [0, 0, 1]);
    mm.updateMemory('m1', '又一次改动');
    eq(cache.has(embeddingCacheKey('m2', '第二条正文')), true,
      'G-6 ★反证：改 m1 **不**波及 m2 的缓存项（不误伤）');

    // G-7..G-8 另两处改内容的口子（同源覆盖 / 合并）——同一把尺
    const db2 = mkdb();
    const mm2 = new MemoryManager(db2, null as never);
    const cache2 = cacheOf(mm2);
    const sid = mm2.storeText({ project_id: 'p', content: '初始搜索结果', type: 'procedural', source: 'web_search' });
    mm2.updateEmbedding(sid, [1, 0, 0]);
    const kS = embeddingCacheKey(sid, '初始搜索结果');
    eq(cache2.has(kS), true, 'G-7 前置：同源那条已有缓存项');
    eq(mm2.sameSourceReplace('p', 'web_search', '新的搜索结果'), sid, 'G-8 同源覆盖命中同一条');
    eq(cache2.has(kS), false, 'G-9 ★★同源覆盖改正文 ⇒ 旧缓存项失效（第二个落点，同一把尺）');

    const db3 = mkdb();
    const mm3 = new MemoryManager(db3, null as never);
    const cache3 = cacheOf(mm3);
    insMem(db3, 'A', 'p', '甲正文', null);
    insMem(db3, 'B', 'p', '乙正文', null);
    mm3.updateEmbedding('A', [1, 0, 0]);
    mm3.updateEmbedding('B', [1, 0, 0]);
    const kA = embeddingCacheKey('A', '甲正文'); const kB = embeddingCacheKey('B', '乙正文');
    eq([cache3.has(kA), cache3.has(kB)], [true, true], 'G-10 前置：A/B 各有缓存项');
    mm3.mergeMemories('A', 'B');
    eq([cache3.has(kA), cache3.has(kB)], [false, false],
      'G-11 ★★合并 ⇒ 承接方（正文已变）与被并方（行已删）两侧缓存项**双双失效**（第三个落点）');
  }

  // ═══ H｜批二（M26-b）：共现强化（赫布）═════════════════════════════════════════
  console.log('\n【H】共现强化：同期入文者互相加权（单条不加 / 失败不加 两侧反证）');
  {
    // 对照：**单条**入文（success）⇒ 只有它升，且**不含**共现加权。
    const d1 = mkdb(); const m1 = new MemoryManager(d1, null as never);
    const only = m1.storeText({ project_id: 'p', content: '单条经验：先建索引再灌数据', type: 'procedural' });
    insTask(d1, 't1', 'p', { memory_used_ids_run: [only] });
    eq(m1.reinforceMemories('t1', 'p', true), 1, 'H-1 单条入文：处理 1 条');
    const impOnly = impOf(d1, only);

    // 该命中：**两条同期**入文（success）⇒ 二者**都**升，且各比单条情形**多** CO_OCCUR_BOOST。
    const d2 = mkdb(); const m2 = new MemoryManager(d2, null as never);
    const a = m2.storeText({ project_id: 'p', content: '单条经验：先建索引再灌数据', type: 'procedural' });
    const b = m2.storeText({ project_id: 'p', content: '共现经验乙：灰度发布分三批', type: 'procedural' });
    insTask(d2, 't1', 'p', { memory_used_ids_run: [a, b] });
    eq(m2.reinforceMemories('t1', 'p', true), 2, 'H-2 两条同期入文：两条都被处理');
    const dA = round4(impOf(d2, a) - impOnly); const dB = round4(impOf(d2, b) - impOnly);
    eq([dA, dB], [CO_OCCUR_BOOST, CO_OCCUR_BOOST],
      'H-3 ★★两条同期入文 ⇒ 二者 importance **都比单条情形多涨 CO_OCCUR_BOOST**（共现加权确实发生，两侧同幅）');

    // 反证①：库里有两条，**只一条入文** ⇒ 只它升，另一条 importance **不动**（不误伤旁观者）。
    const d3 = mkdb(); const m3 = new MemoryManager(d3, null as never);
    const x = m3.storeText({ project_id: 'p', content: '被用上的那条经验', type: 'procedural' });
    const y = m3.storeText({ project_id: 'p', content: '旁观者的那条经验', type: 'procedural' });
    const impX0 = impOf(d3, x); const impY0 = impOf(d3, y);
    insTask(d3, 't1', 'p', { memory_used_ids_run: [x] });
    eq(m3.reinforceMemories('t1', 'p', true), 1, 'H-4 只一条入文：只处理 1 条');
    eq([impOf(d3, x) > impX0, impOf(d3, y) === impY0], [true, true],
      'H-5 ★反证：只它升；**旁观者 importance 分毫不动**（共现不拉无辜者下水）');

    // 反证②：**失败路**（两条同期入文）⇒ 无共现加权（与奖罚方向一致：不奖）。
    const d4 = mkdb(); const m4 = new MemoryManager(d4, null as never);
    const p = m4.storeText({ project_id: 'p', content: '失败路经验甲：先确认端口', type: 'procedural' });
    const q = m4.storeText({ project_id: 'p', content: '失败路经验乙：先看日志', type: 'procedural' });
    const impP0 = impOf(d4, p); const impQ0 = impOf(d4, q);
    insTask(d4, 't1', 'p', { memory_used_ids_run: [p, q] }); // 无 failure_record ⇒ 只记计数、不降权
    m4.reinforceMemories('t1', 'p', false);
    eq([impOf(d4, p) === impP0, impOf(d4, q) === impQ0], [true, true],
      'H-6 ★反证：**失败路**不作共现加权（importance 不动——共现是"一起被想起"，不是"一起挨罚"）');

    // H-7 单源：共现加权只在 reinforceMemories 内被调用一处，且带两道闸（perRun + ≥2）。
    const mgrCode = CODE(`${A}/src/main/core/memory-manager.ts`);
    eq((mgrCode.match(/_reinforceCooccurrence\(/g) ?? []).length, 2,
      'H-7 共现加权**只此一处接线**（定义 1 处 + 调用 1 处，无第二处旁路）');
    ok(/success && perRun !== null && usedIds\.length >= 2/.test(mgrCode),
      'H-8 ★两道闸缺一不可：**只认同期（perRun）**且**≥2 条**（union 是跨 run 累计，拿它当"同期"即错误归因）');
  }

  // ═══ I｜批二：工作记忆池淘汰留痕（本轮不消费，为 M27 预埋）════════════════════════
  console.log('\n【I】工作记忆池淘汰：挤出的是哪条要看得见');
  {
    const mgrRaw = RD(`${A}/src/main/core/memory-manager.ts`);
    ok(/const evicted = wm\.filter\(\(w\) => !keep\.has\(w\)\)/.test(mgrRaw)
      && /'工作记忆池淘汰（挤出最低分者）'/.test(mgrRaw),
      'I-1 ★静态：淘汰分支**算出被挤出者并如实记一行**（静默淘汰 = "没发生过"）');
    // 行为：池满（> WM_POOL_CAP）后**恰** WM_POOL_CAP 条——淘汰确实发生（不是"记了日志但没淘"）。
    const db = mkdb();
    const mm = new MemoryManager(db, null as never);
    db.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t1','{}')").run();
    for (let i = 0; i < WM_POOL_CAP + 3; i++) mm.addWorkingMemory('t1', `工作笔记第 ${i} 条（内容各不相同）`);
    const ctx = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id = ?").get('t1') as { context_json: string }).context_json) as { working_memory?: unknown[] };
    eq((ctx.working_memory ?? []).length, WM_POOL_CAP,
      'I-2 ★行为：入池 15 条（> 池上界）后**恰余 WM_POOL_CAP 条** ⇒ 淘汰真的发生了（该留痕的那一步真跑过）');
  }

  // ═══ J｜批三（M28）夏克特七宗罪验收：七宗 × (该命中/不该命中) 两只标本 ═══════════
  //   ⚠ 七宗罪是**验收清单**，不是新增机制——每宗钉住"本仓已具备"的一条性质及其反面。
  console.log('\n【J】夏克特七宗罪验收套件（每宗两只标本，缺一不可）');
  {
    // ── 罪①短暂性：久未用 ⇒ 强度降；刚用过 ⇒ 不降（由**真实戳**派生，不写绝对时刻）──────
    eq(decayFactor({ memory_type: 'episodic' }, 30) < 1, true,
      'J-1a ①短暂性·该命中：久未用（30 天）⇒ 衰减因子 < 1（情景半衰期 7 天）');
    eq(decayFactor({ memory_type: 'episodic' }, 0), 1,
      'J-1b ①短暂性·不该命中：刚编码（0 天）⇒ 衰减因子 = 1（不降）');
    const justUsed = { memory_type: 'episodic' as const, last_used_at: new Date().toISOString(), created_at: new Date(Date.now() - 30 * 864e5).toISOString() };
    ok(memoryAgeDays(justUsed) < 1 && decayFactor(justUsed) > 0.999,
      'J-1c ①短暂性：年龄取**最近一次使用戳**（刚用过 ⇒ 年龄≈0 ⇒ 不降）——"刚用过"由戳派生，非字面量');

    // ── 罪②心不在焉：编码/检索失败 ⇒ 计数可见；正常 ⇒ 计数为 0 ────────────────────────
    resetMemoryFailureCounters();
    const badDb2 = mkEmptyDb();
    eq(scanDueProspective({ db: badDb2, ansClient: null } as never, Date.now()),
      [], 'J-2a ②心不在焉·该命中：到期前瞻扫描在缺表库上降级返回 `[]`');
    eq(memoryFailureSnapshot()['prospective.scan'], 1,
      'J-2a′ ②心不在焉·该命中：**编码/检索失败计了一笔**（静默失败现形——"读成没发生"被治）');
    resetMemoryFailureCounters();
    const okDb2 = mkdb(); const okM2 = new MemoryManager(okDb2, null as never);
    okM2.storeText({ project_id: 'p', content: '正常写入的一条经验' });
    okM2.retrieveByCue('正常写入', 'p');
    eq(memoryFailureSnapshot(), {},
      'J-2b ②心不在焉·不该命中：正常编码/检索 ⇒ **零计数**（不是"凡调用必计数"）');

    // ── 罪③阻塞：检索 A ⇒ 不因同项目/同型邻居而错给 B；各归各 ──────────────────────────
    const db3 = mkdb(); const m3 = new MemoryManager(db3, null as never);
    m3.storeText({ project_id: 'p', content: '缓存失效必须删掉旧键，否则命中旧向量' });
    m3.storeText({ project_id: 'p', content: '给花浇水施肥的日常记录，与内存无关' });
    const byCache = m3.retrieveByCue('缓存失效', 'p');
    const byWater = m3.retrieveByCue('浇水施肥', 'p');
    ok(byCache.length > 0 && byCache[0]!.content.includes('缓存失效') && !byCache[0]!.content.includes('浇水'),
      'J-3a ③阻塞·该命中：问"缓存失效" ⇒ 首条是缓存那条，**不被同项目的浇水邻居顶替**');
    ok(byWater.length > 0 && byWater[0]!.content.includes('浇水') && !byWater[0]!.content.includes('缓存'),
      'J-3b ③阻塞·不该命中：问"浇水施肥" ⇒ 首条是浇水那条（不同名 ⇒ 各归各）');

    // ── 罪④错误归因：来源 `source` 须如实是它自己；不把 A 的来源安给 B ──────────────────
    const db4 = mkdb(); const m4 = new MemoryManager(db4, null as never);
    const srcA = m4.storeText({ project_id: 'p', content: '用户纠正过的经验甲', source: 'user_correction' });
    const srcB = m4.storeText({ project_id: 'p', content: '机器自省的经验乙', source: 'agent_execution' });
    eq(memRow(db4, srcA).source, 'user_correction',
      'J-4a ④错误归因·该命中：以 `user_correction` 写入 ⇒ 读回来源**如实是它自己**');
    eq(memRow(db4, srcB).source, 'agent_execution',
      'J-4b ④错误归因·不该命中：两条来源各归各，**不把 A 的来源安给 B**');

    // ── 罪⑤暗示：换措辞 ⇒ 真写入的仍一致命中、未写入的绝不当"已写入" ────────────────────
    const db5 = mkdb(); const m5 = new MemoryManager(db5, null as never);
    const trueId = m5.storeText({ project_id: 'p', content: '数据库连接池耗尽要先查慢查询' });
    const hit1 = m5.retrieveByCue('数据库连接池', 'p');
    const hit2 = m5.retrieveByCue('连接池耗尽了怎么排查', 'p');
    ok(hit1.length > 0 && hit2.length > 0 && hit1[0]!.id === trueId && hit2[0]!.id === trueId,
      'J-5a ⑤暗示·该命中：**两种措辞**都一致命中同一条真写入的记忆（措辞不改变事实）');
    const storedIds = new Set([trueId]);
    const fabricated = m5.retrieveByCue('量子纠缠退相干实验装置', 'p')
      .filter((r) => !storedIds.has(r.id) || /量子|纠缠|退相干/.test(r.content));
    eq(fabricated.map((r) => r.id), [],
      'J-5b ⑤暗示·不该命中：问一件**从未写入**的事 ⇒ 检索**不凭空造记忆**、也不把他人内容当它');

    // ── 罪⑥偏颇：当前图式**影响排序但不可伪造事实**；无图式亲和 ⇒ 不偏（保原序）──────────
    const memOf = (id: string, content: string) => ({ id, content } as never);
    const cands = [memOf('b', '浇水 施肥 日常'), memOf('a', '缓存 缓存 索引')];
    const biased = applySchemaRecall(cands, '缓存索引', { keywordsOf: extractKeywords });
    eq([biased.map((m) => (m as { id: string }).id),
      [...biased.map((m) => (m as { id: string }).id)].sort()], [['a', 'b'], ['a', 'b']],
      'J-6a ⑥偏颇·该命中：图式"缓存索引"把 a 排前——**只重排，不增不删**（事实集合不变）');
    const unbiased = applySchemaRecall(cands, '无关的词汇xyz', { keywordsOf: extractKeywords });
    eq(unbiased.map((m) => (m as { id: string }).id), ['b', 'a'],
      'J-6b ⑥偏颇·不该命中：图式与任一候选**无共同词** ⇒ 保持入参原序（无亲和 ⇒ 不偏）');

    // ── 罪⑦持久：已扬弃/已墓碑 ⇒ 不被注入；未墓碑 ⇒ 正常注入 ──────────────────────────
    const db7 = mkdb(); const m7 = new MemoryManager(db7, null as never);
    const liveId = m7.storeText({ project_id: 'p', content: '活着的经验：先建索引再灌数据' });
    const deadId = m7.storeText({ project_id: 'p', content: '已被删除的经验：临时调试开关' });
    eq(tombstoneMemory(db7, deadId, 'user-deleted'), true, 'J-7a′ ⑦持久·前置：墓碑写入成功');
    const afterTomb = m7.retrieveByCue('临时调试开关', 'p');
    eq(afterTomb.some((r) => r.id === deadId), false,
      'J-7a ⑦持久·该命中：**已墓碑**的记忆**不被注入**（"删了又回来"被治）');
    eq(m7.retrieveByCue('先建索引', 'p').some((r) => r.id === liveId), true,
      'J-7b ⑦持久·不该命中：**未墓碑**的记忆正常注入（不是"凡删除相关就不给"）');

    // ── 元判据：七宗**每宗都配了两只标本**（删掉任一侧即红）——承
    //    `feedback_predicate_needs_both_sides_specimen`：只用"该命中"样本 ⇒ 过宽变体全票通过。
    const jCode = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const sins = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];
    eq(sins.map((s) => new RegExp(`${s}[^\\n]*该命中`).test(jCode)), sins.map(() => true),
      'J-8a 七宗**每宗都有"该命中"标本**');
    eq(sins.map((s) => new RegExp(`${s}[^\\n]*不该命中`).test(jCode)), sins.map(() => true),
      'J-8b ★七宗**每宗都有"不该命中"反面标本**（缺反面 ⇒ 过宽变体全票通过）');
  }

  // ═══ K｜批四（示例项目）载入 → 可见 → 删除 → **库与盘均净** + 双闸反证 ═════════════
  //   ⚠ 端到端口径：一键载入后项目/任务/记忆/产出物**四页都能看到**，一键删除后**库行与盘目录均净**。
  //     反证（不该命中）：**id 撞上但 `is_sample≠1` 的行，一律不删**——用户数据的最后一道保险。
  console.log('\n【K】示例项目：载入 → 可见 → 删除 → 库与盘均净（双闸反证）');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sample-rr-'));
    const db = mkSampleDb();
    try {
      // ── 夹具自检（两侧标本）：本夹具**真开外键**，否则下面一切"库净/Loaded"只是自我印证 ──────
      eq(Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys), 1,
        'K-0a ★夹具自检：`PRAGMA foreign_keys` 确为 ON（关着 ⇒ 下面的 FK 缺陷全部假绿）');
      let fkRefused = false;
      try { db.prepare("INSERT INTO wa_projects (id, name, owner_id, is_sample) VALUES ('fk-probe', 'x', 'sample', 0)").run(); }
      catch { fkRefused = true; }
      ok(fkRefused,
        'K-0b ★夹具自检（该命中侧）：写**不存在**的 owner（`owner_id=\'sample\'`）必被外键当场拒');

      // ── 载入（幂等）─────────────────────────────────────────────────────────────
      const r1 = installSampleProject(db, tmp);
      eq({ created: r1.created, id: r1.projectId }, { created: true, id: SAMPLE_PROJECT_ID },
        'K-1a 载入：首跑 `created:true` 且 id 命中固定值');
      eq(cntOf(db, 'SELECT COUNT(*) AS n FROM wa_projects WHERE id = ? AND is_sample = 1', SAMPLE_PROJECT_ID), 1,
        'K-1b ★隔离：示例项目行 `is_sample = 1`（渲染层据它打「示例」徽标；真实项目恒 0）');
      eq(cntOf(db, "SELECT COUNT(*) AS n FROM wa_tasks WHERE project_id = ? AND status = 'completed'", SAMPLE_PROJECT_ID),
        SAMPLE_TASK_IDS.length,
        'K-1c 可见：两条**已完成**任务（任务页/项目卡有"干过活"的样子）');
      eq(cntOf(db, "SELECT COUNT(*) AS n FROM wa_memories WHERE project_id = ? AND source = 'user_correction'", SAMPLE_PROJECT_ID), 3,
        'K-1d 可见：三条示例记忆，来源 `user_correction`（人工写好的示例，非机器重提取）');
      eq(cntOf(db, "SELECT COUNT(*) AS n FROM wa_deliverables WHERE project_id = ? AND status = 'draft'", SAMPLE_PROJECT_ID), 1,
        'K-1e 可见：产出物行经 `createDeliverable` 落库（status=draft，与手工登记同一把尺）');
      eq((db.prepare('SELECT owner_id FROM wa_projects WHERE id = ?').get(SAMPLE_PROJECT_ID) as { owner_id: string | null }),
        { owner_id: null },
        'K-1g ★全新库无用户 ⇒ owner 取 **NULL**（不是 `\'sample\'`；外键对 NULL 子键不作要求）——"如实无主"');
      const repPath = path.join(tmp, 'task_outputs', SAMPLE_TASK_IDS[1], '调研报告.md');
      ok(fs.existsSync(repPath), 'K-1f 端到端：报告**真落盘**', repPath.replace(tmp, '<tmp>'));

      // ── 幂等：再载入 ⇒ 不重复种（不"修复"、不覆盖）────────────────────────────────
      const r2 = installSampleProject(db, tmp);
      eq(r2.created, false, 'K-2a 幂等：示例已在 ⇒ 二次载入 `created:false`');
      eq([
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_tasks WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_memories WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_deliverables WHERE project_id = ?', SAMPLE_PROJECT_ID),
      ], [SAMPLE_TASK_IDS.length, 3, 1],
        'K-2b ★幂等：二次载入**不新增任何行**（任务/记忆/产出物计数不变，无重复种）');

      // ── 隔离反向：真实项目不被卷入 ─────────────────────────────────────────────────
      db.prepare("INSERT INTO wa_projects (id, name, is_sample) VALUES ('real-p', '真实项目', 0)").run();
      eq((db.prepare('SELECT id FROM wa_projects WHERE is_sample = 1').all() as Array<{ id: string }>).map((x) => x.id),
        [SAMPLE_PROJECT_ID],
        'K-3 ★隔离：`is_sample=1` 的**只有示例**——真实项目恒 0，徽标不会误挂到用户数据上');

      // ── 领域包：删项目清**启用映射**，但**资产留下**（zx_20261021_3 批一）─────────────
      //   "已经带走的东西不该随源消失"——映射是关系，包是本机资产，二者在级联里各归其位。
      db.prepare("INSERT INTO wa_domain_packs (id, name, pack_json) VALUES ('dp-s', '示例包', '{}')").run();
      db.prepare("INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES (?, 'dp-s')").run(SAMPLE_PROJECT_ID);
      eq(cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_domain_packs WHERE project_id = ?', SAMPLE_PROJECT_ID), 1,
        'K-3c ★前置自证：启用映射 0→1（否则下面的"删干净"是全空转）');

      // ── 项目知识册：派生/导入/导入账三张都随项目清（zx_20261022_3 批七）────────
      //   前置自证 0→1：不做这一步，"删干净"在三张空表上全是空转（承"计数器须有正面断言"）。
      db.prepare("INSERT INTO wa_project_knowledge (id, project_id, section, content) VALUES ('pk-s', ?, 'entities', '甲→乙')").run(SAMPLE_PROJECT_ID);
      db.prepare("INSERT INTO wa_project_knowledge_imports (project_id, section, content) VALUES (?, 'entities', '丙→丁')").run(SAMPLE_PROJECT_ID);
      db.prepare("INSERT INTO wa_knowledge_imports (id, project_id, source_hash) VALUES ('ki-s', ?, 'h')").run(SAMPLE_PROJECT_ID);
      // zx_20261022_3 批八：画像随项目清（同属"本项目的"，不是可携带资产）。
      db.prepare("INSERT INTO wa_project_profiles (project_id, profile_json) VALUES (?, '{}')").run(SAMPLE_PROJECT_ID);
      eq([
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_knowledge WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_knowledge_imports WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_knowledge_imports WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_profiles WHERE project_id = ?', SAMPLE_PROJECT_ID),
      ], [1, 1, 1, 1], 'K-3d ★前置自证：知识册三表 + 画像各 0→1（否则下面的"随项目清空"是全空转）');

      // ── 删除：库净 + 盘净 ────────────────────────────────────────────────────────
      const rm = removeSampleProject(db, tmp);
      eq(rm.removed, true, 'K-4a 删除：命中双闸 ⇒ `removed:true`');
      eq([
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_projects WHERE id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_tasks WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_deliverables WHERE project_id = ?', SAMPLE_PROJECT_ID),
      ], [0, 0, 0], 'K-4b ★库净：项目/任务/产出物行**全清**（走 `deleteProjectCascade` 同一份 SQL）');
      eq([
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_domain_packs WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_domain_packs'),
      ], [0, 1],
        'K-4f ★启用映射随项目清空，**领域包资产留下**（关系可断，带走的经验不随源消失）');
      eq([
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_knowledge WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_knowledge_imports WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_knowledge_imports WHERE project_id = ?', SAMPLE_PROJECT_ID),
        cntOf(db, 'SELECT COUNT(*) AS n FROM wa_project_profiles WHERE project_id = ?', SAMPLE_PROJECT_ID),
      ], [0, 0, 0, 0],
        'K-4g ★项目知识册三表（派生/导入/导入账）+ 画像随项目清空——不留孤儿行，重建同 id 项目不"继承"旧知识/旧画像');
      // K-4c 由 `project_id` 改按 **id** 断：墓碑行的 `project_id` 已被**置 NULL**（断开父引用，外键所迫），
      //   再按 project_id 数就是数了个空——正是"移动基线"式判据（钉住一个刚被本机制改掉的列）。
      eq((db.prepare(
        'SELECT id, memory_type, content, deleted_reason, project_id FROM wa_memories ORDER BY id',
      ).all() as Array<Record<string, unknown>>).map((r) => [r.id, r.memory_type, r.content, r.deleted_reason, r.project_id]),
        ['sample-mem-1', 'sample-mem-2', 'sample-mem-3'].map((id) => [id, 'deleted', '', '随项目删除', null]),
        'K-4c ★记忆**落墓碑非物理删**（按 id 断言：正文清空、缘由「随项目删除」、父引用已断开——"账必有痕"）');
      ok(!fs.existsSync(path.join(tmp, 'projects', SAMPLE_PROJECT_ID))
        && !fs.existsSync(path.join(tmp, 'task_outputs', SAMPLE_TASK_IDS[0]))
        && !fs.existsSync(path.join(tmp, 'task_outputs', SAMPLE_TASK_IDS[1])),
        'K-4d ★盘净：项目工作目录 + 两条任务产出物目录**均清**（`project:delete` 不清盘，示例随删随净）');
      eq(removeSampleProject(db, tmp).removed, false, 'K-4e 幂等：项目不在 ⇒ 二次删除 `removed:false`（不报错）');

      // ── 双闸反证（不该命中）：id 撞上但**不是示例行** ⇒ 一律不删 ──────────────────────
      db.prepare(`INSERT INTO wa_projects (id, name, is_sample, working_dir) VALUES (?, '用户自建（撞 id）', 0, ?)`)
        .run(SAMPLE_PROJECT_ID, path.join(tmp, 'projects', SAMPLE_PROJECT_ID));
      eq(removeSampleProject(db, tmp).removed, false,
        'K-5a ★反证（不该命中）：id 恰撞固定值但 `is_sample≠1` ⇒ **拒删**（双闸生效，用户数据不动）');
      eq(cntOf(db, 'SELECT COUNT(*) AS n FROM wa_projects WHERE id = ?', SAMPLE_PROJECT_ID), 1,
        'K-5b ★反证：拒删后**行仍在**（不是"报 removed:false 却已删掉"）');

      // ── owner 解析（该命中侧）：有 super_admin ⇒ owner 取**真用户**，且删除仍成功 ────────────
      //   两侧标本：K-1g 是"无用户⇒NULL"侧，本段是"有用户⇒真 id"侧（缺任一侧，`'sample'` 这类
      //   字面量仍可能蒙混过关——只有"真用户"侧能照出"写死占位"）。
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sample-rr2-'));
      try {
        const db2 = mkSampleDb();
        db2.prepare("INSERT INTO wa_users (id, username, role) VALUES ('u-admin', 'admin', 'super_admin')").run();
        installSampleProject(db2, tmp2);
        eq(db2.prepare('SELECT owner_id FROM wa_projects WHERE id = ?').get(SAMPLE_PROJECT_ID),
          { owner_id: 'u-admin' },
          'K-5c ★owner 解析：有 super_admin ⇒ 示例项目 owner = **真用户 id**（非 `\'sample\'`）');
        eq(removeSampleProject(db2, tmp2).removed, true,
          'K-5d ★删除在外键开启下**成功**（父引用已断开——正是 `deleteProjectCascade` 此前恒失败的根因位）');
      } finally {
        try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // ── 静态：接线一处真源（搬移/改名即红）───────────────────────────────────────────
    const setupIpc = CODE(`${A}/src/main/ipc/setup.ipc.ts`);
    ok(/ipcMain\.handle\(\s*'sample:install'/.test(setupIpc) && /ipcMain\.handle\(\s*'sample:remove'/.test(setupIpc),
      'K-6 IPC 两个通道在册（`sample:install` / `sample:remove`）');
    const projIpc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/deleteProjectCascade\(db, id\)/.test(projIpc) && !/DELETE FROM wa_projects/.test(projIpc),
      'K-7 ★一处真源：`project:delete` 改用 `deleteProjectCascade`——**自己不再内联**级联 SQL');
    const sampleSrc = CODE(`${A}/src/main/core/sample-project.ts`);
    ok(/deleteProjectCascade\(db, SAMPLE_PROJECT_ID\)/.test(sampleSrc),
      'K-8 ★同一份：示例删除也走 `deleteProjectCascade`（两条删除路**共用一把尺**）');
    ok(/row\.is_sample !== 1/.test(sampleSrc),
      'K-9 ★双闸在源头代码里（拒绝条件按 `is_sample` 判，非仅注释宣称）');
    const rid = CODE(`apps/worker-ant-desktop/renderer/src/lib/ipc.ts`);
    ok(/'sample:install'/.test(rid) && /'sample:remove'/.test(rid),
      'K-10 renderer 桥接在册（前端可达 `sample:install` / `sample:remove`）');
    // ── 缺陷修（实机 E2E 照出的 owner 外键族）静态反证：禁占位复辟 + 钉一处真源 ────────────
    const imRouterSrc = CODE(`${A}/src/main/services/im-router.ts`);
    ok(!/'active',\s*'default'\)/.test(imRouterSrc),
      'K-11 ★反证：IM 两条「自动建项目」**不再写死 `\'default\'` owner**（占位复辟即红）');
    ok(/resolveProjectOwnerId\(/.test(CODE(`${A}/src/main/core/sample-project.ts`))
      && /owner_id:\s*resolveProjectOwnerId\(db\)/.test(projIpc)
      && /export function resolveProjectOwnerId\(/.test(CODE(`${A}/src/main/core/project-engine.ts`)),
      'K-12 ★一处真源：示例载入 / `project:create` / IM 三条 owner 取数同引 `resolveProjectOwnerId`');
    const writeSrc = CODE(`${A}/src/main/core/tools/write.ts`);
    eq((writeSrc.match(/const uid = proj\?\.owner_id \|\| '';/g) ?? []).length, 2,
      'K-13 ★偏好读写同一 uid 真源（`save_preference` 与 `forget_preference` 均取 `proj.owner_id`；'
      + '原表达式因运算符优先级**恒取占位** ⇒ 记了等于没记)');
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

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261012_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261012_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261012_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
