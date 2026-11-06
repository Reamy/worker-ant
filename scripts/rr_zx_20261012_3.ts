/**
 * zx_20261012_3 受控复跑 —— 「明处」：**删得清 · 选得明 · 算得真**。
 *
 * 本轮口径一句话（维特根斯坦·不要藏在暗处·能说清的都要说清 / 道德经·知止 / 毛选·实事求是）：
 *   凡是系统替用户做了决定、或留下了残迹的地方，都要有一条**能事后查得到的账**。
 *   起因＝2026-10-12 某项目「20260924 规划方案实施」实机复盘：任务 3 步空转、8 条验收全未过、45 分暂停；
 *   追因时"为什么用 qwen3.5:9b 而不是 DeepSeek"**竟无任何日志可查**，全靠事后拼源码 + 库才拼出来。
 *
 *   · 批一「删得清」——`project:delete` 只删库、盘上 `data/projects/<id>/` 成孤儿（dev 库实测 7 个）。
 *     治法＝清盘走**一处真源** `removeProjectDataDir(dataDir, id)`，且**只**清工蚁自有数据目录、
 *     **绝不**碰 `working_dir`（那是**用户自己的代码仓**）；是否清盘由用户**复选框**选（默认勾选）。
 *   · 批二「算得真」（本套件续加）。
 *   · 批三「选得明」（本套件续加）。
 *   · 批四「重活不被降级为随机」（本套件续加）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/拒删/收窄"的判据，反面标本（不该命中）一并喂。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 夹具外键**逐条照搬生产 DDL** 且 `PRAGMA foreign_keys = ON`（承 rr_zx_20261012_1 教训：
 *     夹具省 `REFERENCES` 且 FK 关 ⇒ 外键族缺陷在 rr 里**必然全绿**）。
 *   ⚠ `node:sqlite` 无 `db.transaction()` ⇒ 真跑用事务的生产函数须补 `withTx` 垫片。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败。
import { deleteProjectCascade, removeProjectDataDir } from '../apps/worker-ant-desktop/src/main/core/project-engine.js';
import { installSampleProject, removeSampleProject, SAMPLE_PROJECT_ID } from '../apps/worker-ant-desktop/src/main/core/sample-project.js';
// G-1：批二判据引用 token 估算**唯一口径**（纯函数，可运行时直测）。
import { stepTokenDelta, estimateTokensFromChars, TOKEN_CHARS_PER_UNIT } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';
// G-1：批三判据跑**生产选型段**本体 + 引两个留痕标签纯函数。
import { selectModelForTask, endpointScope, capabilityMatchLabel } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
// 批三 C-1e：把「本函数与 `isLocalUrl` **刻意不是一把尺**」这条注释**断言**出来（否则它只是句话）。
import { isLocalUrl } from '../apps/worker-ant-desktop/src/main/core/ans-supervisor.js';
// G-1：批四判据引形态下限本体 + 三张表（重活形态 / 非确定性策略 / 各形态自带策略）。
import { applyArchetypeFloor, HEAVY_ARCHETYPES, NON_DETERMINISTIC_STRATEGIES, ADAPTIVE_STRATEGIES } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';

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

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261012_3

type AnyDb = import('better-sqlite3').Database;

/* ── 夹具：删项目那一路要碰的表（外键逐条照搬生产 `database.ts` 的 `REFERENCES`）──────── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_users (id TEXT PRIMARY KEY, username TEXT DEFAULT '', role TEXT DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', status TEXT DEFAULT 'active',
  cron_schedule TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai', working_dir TEXT DEFAULT '',
  owner_id TEXT REFERENCES wa_users(id), is_sample INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT REFERENCES wa_tasks(id), role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
-- ⚠ 逐列照搬生产：database.ts 建表列 + 三条迁移补列（deleted_at / deleted_reason / deleted_fingerprint，见 database.ts:261-263）。
--   省任一列 ⇒ TOMBSTONE_UPDATE_SQL 抛错被**吞掉** ⇒ 记忆不落墓碑且 project_id 不断开 ⇒ 父行 DELETE 撞外键
--   ⇒ 看着像生产缺陷，实为夹具失真（正是本套件要防的那类假红）。
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'semantic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
  source TEXT DEFAULT 'agent', user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
  is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT '');
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
-- zx_20261021_3 批一：删项目级联会删**启用映射**（资产留下）。生产无外键（见 database.ts 头注）。
CREATE TABLE wa_domain_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  pack_json TEXT NOT NULL, source_project_id TEXT, source_project_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_domain_packs (project_id TEXT NOT NULL, pack_id TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, pack_id));
-- zx_20261022_3 批七/批八：删项目级联会删这四张"本项目"的表（生产 database.ts 同 DDL）。
--   夹具缺表 ⇒ 级联在第一条 DELETE 就抛 no such table（ASSERT A 组全过之后才炸），不是生产缺陷。
CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
  content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
CREATE TABLE wa_project_knowledge_imports (project_id TEXT NOT NULL, section TEXT NOT NULL,
  content TEXT NOT NULL, precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
  imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
CREATE TABLE wa_knowledge_imports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge', sections INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_profiles (project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
  source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL, generated_at TEXT DEFAULT (datetime('now')),
  enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT '');
-- zx_20261027_3 M6b：画像旧版留痕也随项目级联删除（生产 database.ts 同一 DDL；夹具缺表 ⇒ A 段删项目当场抛）。
CREATE TABLE wa_project_profile_history (project_id TEXT NOT NULL, source_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, profile_json TEXT NOT NULL, generated_at TEXT DEFAULT '',
  replaced_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, source_hash));
-- zx_20261029_1「知」：项目须知随项目级联删除（生产 database.ts 同一 DDL；夹具缺表 ⇒ A 段删项目当场抛）。
CREATE TABLE wa_project_briefs (project_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
  brief_json TEXT NOT NULL DEFAULT '', source_hash TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

/** `node:sqlite` 无 `db.transaction()`，而 `deleteProjectCascade`/`installSampleProject` 是真实现（用事务）⇒ 补垫片。 */
const withTx = (d: AnyDb): AnyDb => {
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => {
    d.exec('BEGIN');
    try { fn(); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* 无活动事务 */ } throw e; }
  };
  return d;
};
const mkdb = (): AnyDb => withTx((() => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec('PRAGMA foreign_keys = ON'); // 与生产 `database.ts:24` 同 —— 否则 FK 类缺陷在此恒不引爆
  return d as unknown as AnyDb;
})());
const cntOf = (db: AnyDb, sql: string, ...args: unknown[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);

/* ── 磁盘小工具 ──────────────────────────────────────────────────────────── */
const putFile = (p: string, body = 'x'): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body, 'utf-8'); };
const exists = (p: string): boolean => fs.existsSync(p);

/** 递归收集 `src/` 下的 .ts/.tsx（批三的"第二处选型账"扫面用）。 */
function walkFiles(dirAbs: string, out: string[] = []): string[] {
  if (!fs.existsSync(dirAbs)) return out;
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const p = path.join(dirAbs, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/* ── 批三：选型留痕取账 ─────────────────────────────────────────────────── */
const convsOf = (db: AnyDb, taskId: string): string[] =>
  (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ content: string }>)
    .map((r) => r.content);

/** 一份合法的 ANS `getOptimalModel` 回包。端点用**环回未监听端口** ⇒ 探活确定性快速失败，不碰真网。 */
const selPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm-primary', model_name: 'qwen3.5:9b', url: 'http://127.0.0.1:1', api_key: 'k1',
  max_output_tokens: 4096, context_window: 128_000,
  input_price_per_1k: 0, output_price_per_1k: 0,
  capabilities: ['chat', 'function-calling'],
  capabilityMatch: 'full',
  sameProviderFallback: null, crossProviderFallback: null, fallback: null, ...o,
});

/** 跑一次**生产** `selectModelForTask`（连同它落下的会话行一并取回——"账"是本组主要取证）。 */
async function pickSel(db: AnyDb, taskId: string, opts: { strategySource?: string; payload?: Record<string, unknown> } = {}): Promise<{ thrown: string | null; conv: string[] }> {
  // ⚠ 会话行有 `task_id REFERENCES wa_tasks(id)`（生产 FK 开）⇒ 先补项目/任务父行，否则 INSERT 当场被拒、
  //   留痕**一行都落不下**——夹具不备父行而断言"账在"是自我印证（承 rr_zx_20261012_1 教训）。
  db.prepare("INSERT OR IGNORE INTO wa_projects (id, name) VALUES ('p-sel', '选型留痕')").run();
  db.prepare("INSERT OR IGNORE INTO wa_tasks (id, project_id, status) VALUES (?, 'p-sel', 'executing')").run(taskId);
  try {
    await selectModelForTask({
      db: db as never, taskId, projectId: 'p-sel', taskCtxJson: '{}',
      ansClient: { getOptimalModel: async () => selPayload(opts.payload) } as never,
      archetype: 'conversation' as never, modelStrategy: 'balanced',
      ...(opts.strategySource !== undefined ? { strategySource: opts.strategySource } : {}),
    });
    return { thrown: null, conv: convsOf(db, taskId) };
  } catch (e) {
    return { thrown: (e as Error).message, conv: convsOf(db, taskId) };
  }
}

// ══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {

  // ═══ A｜批一 · 删项目同时清盘（承 G1）═══════════════════════════════════════════
  console.log('\n【A】批一 · 删项目同时清盘（「删得清」）');
  {
    // ── A-0 夹具自检（承 rr_zx_20261012_1：夹具比生产宽松 ⇒ 断言只是自我印证）──────────────
    const probe = mkdb();
    eq((probe.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1,
      'A-0a ★夹具自检：`PRAGMA foreign_keys` 确为 1（否则外键族缺陷在此全绿）');
    let fkRejected = false;
    try {
      probe.prepare("INSERT INTO wa_tasks (id, project_id) VALUES ('t-bad', 'no-such-project')").run();
    } catch { fkRejected = true; }
    ok(fkRejected, 'A-0b ★夹具自检（该命中侧）：写一个**不存在的**外键值须**当场被拒**——外键真在生效，不是摆设');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx3-a-'));
    try {
      const pid = 'p-del-1';
      const projDir = path.join(tmp, 'projects', pid);
      const sibling = path.join(tmp, 'task_outputs', pid);
      // 用户**自己的代码仓**：绝不能被动（安全底线）。
      const userRepo = path.join(tmp, 'user-repo');
      putFile(path.join(userRepo, 'main.py'), 'print("用户代码，动一下都不行")');
      putFile(path.join(projDir, 'notes.txt'), '任务产出物');
      putFile(path.join(projDir, 'sub', 'deep.txt'), '深层文件');
      putFile(path.join(sibling, 'out.txt'), '隔壁任务的产出');

      // ── A-1 ★该命中：清 `projects/<id>/`（含深层文件）────────────────────────────
      const r1 = removeProjectDataDir(tmp, pid);
      eq([r1.ok, r1.dir], [true, projDir], 'A-1a ★该命中：`removeProjectDataDir` 返回 `{ok:true, dir=<dataDir>/projects/<id>}`');
      ok(!exists(projDir), 'A-1b ★该命中：项目数据目录**连深层一起清**（`projects/<id>/sub/deep.txt` 不残留）');

      // ── A-2 ★反证（不该命中）：用户代码仓原样健在 ────────────────────────────────
      ok(exists(path.join(userRepo, 'main.py'))
        && fs.readFileSync(path.join(userRepo, 'main.py'), 'utf-8').includes('用户代码'),
        'A-2 ★★反证（不该命中）：`working_dir` 指向的用户代码仓**原样健在**——清盘只认 `dataDir+id`，绝不碰 working_dir');

      // ── A-3 ★反证（不该命中）：兄弟目录不被越界清 ────────────────────────────────
      ok(exists(path.join(sibling, 'out.txt')),
        'A-3 ★反证（不该命中）：`task_outputs/<id>/`（兄弟）**不**被本项目清盘越界清掉');

      // ── A-4 幂等：目录本不存在 ⇒ 不抛、如实回 ok ─────────────────────────────────
      const r2 = removeProjectDataDir(tmp, 'p-never-existed');
      eq(r2.ok, true, 'A-4 幂等：目录本不存在 ⇒ `ok:true`（`rmSync(force)` 不抛，二次删除无害）');

      // ── A-5 ★路径穿越闸（两侧）：含分隔符/上跳/绝对路径的 id 一律拒，且不误删 ──────────
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx3-a2-'));
      try {
        const dataDir = path.join(parent, 'data');
        fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
        const victim = path.join(parent, 'victim');
        putFile(path.join(victim, 'keep.txt'), '不该被删');
        eq([
          removeProjectDataDir(dataDir, '../victim').ok,
          removeProjectDataDir(dataDir, '../../etc').ok,
          removeProjectDataDir(dataDir, '/etc').ok,
        ], [false, false, false],
          'A-5a ★反证（不该命中）：`../victim` / `../../etc` / 绝对路径 三种 id **一律拒**（`ok:false`）');
        ok(exists(path.join(victim, 'keep.txt')),
          'A-5b ★反证：拒删后目标目录**仍在**（不是"报 false 却已删掉"）——穿越闸真生效');
      } finally { try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* ignore */ } }
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }

    // ── A-6 行为：全链（库净 + 盘净 + 代码仓健在 + 记忆落墓碑）────────────────────────
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx3-a3-'));
      try {
        const db = mkdb();
        const pid = 'p-full';
        const userRepo = path.join(tmp, 'the-user-repo');
        putFile(path.join(userRepo, 'app.go'), 'package main');
        putFile(path.join(tmp, 'projects', pid, 'a.txt'), 'a');
        db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES (?, '真实项目', ?)").run(pid, userRepo);
        db.prepare("INSERT INTO wa_tasks (id, project_id, status) VALUES ('t1', ?, 'paused')").run(pid);
        db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES ('c1', 't1', 'system', 'hi')").run();
        db.prepare("INSERT INTO wa_memories (id, project_id, content) VALUES ('m1', ?, '记一条')").run(pid);
        db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name) VALUES ('d1', ?, 't1', 'code', 'x.py')").run(pid);
        db.prepare("INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size) VALUES ('v1', 'd1', 'x.py', 's', 1)").run();
        db.prepare("INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object) VALUES ('k1', ?, 's', 'p', 'o')").run(pid);
        db.prepare("INSERT INTO wa_notifications (id, type, title, project_id) VALUES ('n1', 't', 'x', ?)").run(pid);

        deleteProjectCascade(db, pid);
        const r = removeProjectDataDir(tmp, pid);
        eq(r.ok, true, 'A-6a 全链：删库之后清盘 ⇒ `ok:true`');
        eq([
          cntOf(db, 'SELECT COUNT(*) AS n FROM wa_projects WHERE id = ?', pid),
          cntOf(db, 'SELECT COUNT(*) AS n FROM wa_tasks WHERE project_id = ?', pid),
          cntOf(db, 'SELECT COUNT(*) AS n FROM wa_task_conversations WHERE task_id = ?', 't1'),
          cntOf(db, 'SELECT COUNT(*) AS n FROM wa_deliverables WHERE project_id = ?', pid),
          cntOf(db, 'SELECT COUNT(*) AS n FROM wa_deliverable_versions WHERE deliverable_id = ?', 'd1'),
          cntOf(db, 'SELECT COUNT(*) AS n FROM wa_knowledge_triples WHERE project_id = ?', pid),
          cntOf(db, 'SELECT COUNT(*) AS n FROM wa_notifications WHERE project_id = ?', pid),
        ], [0, 0, 0, 0, 0, 0, 0], 'A-6b ★库净：项目/任务/会话/成果/版本/KG/通知**全清**（走 `deleteProjectCascade` 一处真源）');
        eq(
          (db.prepare("SELECT memory_type, deleted_reason, project_id FROM wa_memories WHERE id = 'm1'").get() as Record<string, unknown>),
          { memory_type: 'deleted', deleted_reason: '随项目删除', project_id: null },
          'A-6c ★记忆**落墓碑非物理删**（正文清空在实现内；此处钉类型/缘由/父引用已断开——"账必有痕"）');
        ok(!exists(path.join(tmp, 'projects', pid)), 'A-6d ★盘净：项目数据目录已清');
        ok(exists(path.join(userRepo, 'app.go')), 'A-6e ★★安全底线：用户代码仓（`working_dir`）**仍在**——删项目不动用户代码');
      } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
    }

    // ── A-7 静态：一处真源 + 只认 dataDir（禁按 working_dir 删）──────────────────────
    const projIpc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/deleteProjectCascade\(db, id\)/.test(projIpc) && /removeProjectDataDir\(dataDir, id\)/.test(projIpc),
      'A-7a ★一处真源：`project:delete` = `deleteProjectCascade`（库）+ `removeProjectDataDir(dataDir, id)`（盘）');
    ok(!/rmSync\([^)]*working_dir/.test(projIpc) && !/working_dir[\s\S]{0,40}rmSync/.test(projIpc),
      'A-7b ★反证：IPC 处理器**不**按 `working_dir` 删盘（清错盘的入口被封死）');
    ok(/removeDataDir\s*!==\s*false/.test(projIpc),
      'A-7c 门控语义：`removeDataDir !== false` ⇒ **未传即清**（默认勾选）、显式 `false` 才保留');
    ok(/ipcMain\.handle\(\s*'project:projectsDir'/.test(projIpc),
      'A-7d 通道在册：`project:projectsDir`（删弹窗据此显示**真实**将清路径）');
    ok(/export function initProjectIpc\(db: Database\.Database, dataDir: string,/.test(projIpc),
      'A-7e `initProjectIpc` 收 `dataDir`（与 `initImIpc`/`initSetupIpc` 同形）');
    ok(/initProjectIpc\(db, dataDir, \(\) => memory\)/.test(RD(`${A}/src/main/index.ts`)),
      'A-7f 启动处**真传** `dataDir`（不传则清盘指向错处）');

    const sampleSrc = CODE(`${A}/src/main/core/sample-project.ts`);
    ok(/removeProjectDataDir\(dataDir, SAMPLE_PROJECT_ID\)/.test(sampleSrc),
      'A-8a ★同一把尺：示例项目删除也走 `removeProjectDataDir`（两条删除路共用一处真源）');
    ok(!/rmSync\(workingDir/.test(sampleSrc),
      'A-8b ★反证：示例删除**不再**按 `workingDir` 删（此前那是"清错盘"的第二入口）');
    ok(/row\.is_sample !== 1/.test(sampleSrc),
      'A-8c 双闸仍在源头（示例删除拒绝条件按 `is_sample` 判，非仅注释宣称）');

    const engine = CODE(`${A}/src/main/core/project-engine.ts`);
    ok(/export function removeProjectDataDir\(dataDir: string, projectId: string\)/.test(engine)
      && /path\.basename\(projectId\) !== projectId/.test(engine),
      'A-9 ★一处真源 + 穿越闸：`removeProjectDataDir` 在 `project-engine.ts`，且以"单段 id"闸挡路径穿越');

    // ── A-10 静态：GUI renderer 第二落点（词表/通道/文案）───────────────────────────
    const rid = CODE(`apps/worker-ant-desktop/renderer/src/lib/ipc.ts`);
    ok(/removeDataDir/.test(rid) && /'project:projectsDir'/.test(rid),
      'A-10a renderer 桥接在册：`projects.delete(id, { removeDataDir })` + `projectsDir()` 通道');
    const dlg = CODE(`apps/worker-ant-desktop/renderer/src/components/DeleteProjectDialog.tsx`);
    ok(/type="checkbox"/.test(dlg) && /useState\(true\)/.test(dlg),
      'A-10b 弹窗复选框**默认勾选**（`useState(true)`——"删得清"是同向默认）');
    ok(/不受影响/.test(dlg),
      'A-10c 弹窗**明示**"项目工作目录（你的代码仓）不受影响"——把安全底线说给用户听');
    ok(/DeleteProjectDialog/.test(CODE(`apps/worker-ant-desktop/renderer/src/pages/ProjectsPage.tsx`))
      && /DeleteProjectDialog/.test(CODE(`apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx`)),
      'A-10d 两个删除入口（项目列表 / 项目详情）**共用同一个**弹窗（一处真源）');
    ok(!/confirm\('确定删除此项目/.test(CODE(`apps/worker-ant-desktop/renderer/src/pages/ProjectsPage.tsx`))
      && !/confirm\('确定删除？/.test(CODE(`apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx`)),
      'A-10e ★反证：原生 `confirm()`（对"文件删不删"只字未提的那句）已**退役**');
  }

  // ═══ B｜批二 · 主步进 token 字符兜底（「算得真」）══════════════════════════════════
  console.log('\n【B】批二 · 主步进 token 字符兜底（「算得真」）');
  {
    // ── B-1 ★该命中：usage **在场** ⇒ 逐字沿用累计差分，且**不叠加**字符估 ─────────────
    //   喂一个巨大的 inChars/outChars 作诱饵：若实现"真值 + 估算"叠加，这里必露。
    eq(stepTokenDelta({ usage: { promptTokens: 1200, completionTokens: 300 }, prevPrompt: 1000, prevComp: 200, inChars: 999_999, outChars: 999_999 }),
      { prompt: 200, completion: 100, total: 300, estimated: false },
      'B-1a ★该命中：有 usage ⇒ 真值差分（1200-1000=200 / 300-200=100），`estimated:false`，**不掺**字符估');
    eq(stepTokenDelta({ usage: { promptTokens: 500, outputTokens: 80 }, prevPrompt: 0, prevComp: 0, inChars: 0, outChars: 0 }),
      { prompt: 500, completion: 80, total: 580, estimated: false },
      'B-1b ★该命中：`outputTokens` 形（另一字段名）同样按真值取，`estimated:false`');

    // ── B-2 ★该命中（本轮病根的反面）：usage **缺席** ⇒ 按字符估，> 0 ⇒ Token 闸 ratio 可动 ──
    eq(stepTokenDelta({ usage: undefined, prevPrompt: 0, prevComp: 0, inChars: 400, outChars: 10 }),
      { prompt: 100, completion: 3, total: 103, estimated: true },
      'B-2a ★该命中：无 usage ⇒ 估出 prompt=100(400÷4)/completion=3(10÷4)/total=103 **> 0**，`estimated:true`');
    eq(stepTokenDelta({ usage: { promptTokens: 0, completionTokens: 0 }, prevPrompt: 0, prevComp: 0, inChars: 80, outChars: 0 }),
      { prompt: 20, completion: 0, total: 20, estimated: true },
      'B-2b ★该命中：usage 字段在但**全 0**（等价于缺席）⇒ 仍走估算，不把 0 当真值');
    ok(stepTokenDelta({ usage: undefined, prevPrompt: 0, prevComp: 0, inChars: 400, outChars: 10 }).total > 0,
      'B-2c ★★病根反面：缺席也不再是 0 ⇒ `totalTokensUsed` 可累积、`budget_usage_ratio` 可动（此前恒 0 ⇒ Token 闸永不触发）');

    // ── B-3 边界：什么都没送、什么也没产出 ⇒ 如实 0（不是凭空的 1）────────────────────
    eq(stepTokenDelta({ usage: undefined, prevPrompt: 0, prevComp: 0, inChars: 0, outChars: 0 }),
      { prompt: 0, completion: 0, total: 0, estimated: true },
      'B-3 边界：空输入 ⇒ 0（估也要有"估的对象"，不凭空造 1 个 token）');

    // ── B-4 累计差分**下溢归零**（provider 偶回小于 prev 的值时不产生负数）──────────────
    eq(stepTokenDelta({ usage: { promptTokens: 30 }, prevPrompt: 100, prevComp: 500, inChars: 0, outChars: 0 }),
      { prompt: 0, completion: 0, total: 0, estimated: false },
      'B-4 差分下溢 ⇒ 归 0（不产生负 token），仍标 `estimated:false`（这是真值域的钳位，非估算）');

    // ── B-5 分度纯函数：唯一口径，边界逐点 ───────────────────────────────────────────
    ok(TOKEN_CHARS_PER_UNIT === 4,
      'B-5a 分度常量**一处真源** = 4（改这里即改全仓）', `实测 ${TOKEN_CHARS_PER_UNIT}`);
    eq([0, 1, 4, 5, 400, -3].map(estimateTokensFromChars), [0, 1, 1, 2, 100, 0],
      'B-5b `estimateTokensFromChars`：向上取整、空/非正 ⇒ 0');

    // ── B-6 ★一处真源（静态）：exec-step 引共享函数、自己不再手写 `/ 4` 分度 ─────────────
    const stepSrc = CODE(`${A}/src/main/core/exec-step.ts`);
    ok(/import \{[^}]*stepTokenDelta[^}]*\} from '\.\/token-estimate\.js'/.test(stepSrc)
      && /stepTokenDelta\(\{/.test(stepSrc),
      'B-6a exec-step 的真值/估算判定走 `stepTokenDelta`（一处真源），不在此重写一套');
    ok(!/Math\.ceil\(\s*[A-Za-z_.]+\s*\/\s*4\s*\)/.test(stepSrc),
      'B-6b ★反证：exec-step 内**不再**手写 `Math.ceil(x / 4)` 分度（口径不得各写一份）');

    // ── B-7 「估」须**标出来**（不冒充真值）：指标事件 + ctxJson 累计计数 ─────────────────
    ok(/tokensEstimated:\s*stepDelta\.estimated/.test(stepSrc),
      'B-7a 指标面标估：`task.step_finished` 载荷带 `tokensEstimated`（前端据此不把估算当真值显示）');
    ok(/ctxJson\.tokens_estimated_steps/.test(stepSrc),
      'B-7b 账本面标估：ctxJson 累计 `tokens_estimated_steps`（事后可辨 tokens_used 里有多少是推算）');

    // ── B-8 ★一处真源（静态）：其余 `ceil(字/4)` 站点改引共享函数，无残留手写分度 ──────────
    const singleSourceFiles: Array<[string, string]> = [
      ['exec-step.ts', `${A}/src/main/core/exec-step.ts`],
      ['context-compaction.ts', `${A}/src/main/core/context-compaction.ts`],
      ['memory-manager.ts', `${A}/src/main/core/memory-manager.ts`],
      ['output-validator.ts', `${A}/src/main/core/output-validator.ts`],
      ['agent-executor.ts', `${A}/src/main/core/agent-executor.ts`],
    ];
    const offenders = singleSourceFiles.filter(([, rel]) => {
      const src = CODE(rel);
      return !/estimateTokensFromChars/.test(src) || /Math\.ceil\(\s*\(?[^)]*?\/\s*4\s*\)/.test(src);
    }).map(([name]) => name);
    ok(offenders.length === 0,
      'B-8 ★一处真源：5 个估算站点均已引共享函数、且无残留手写 `ceil(…/4)`（口径不再分家）',
      offenders.length ? `残留：${offenders.join(', ')}` : '5/5 已归一处');
    ok(/Math\.max\(1,\s*estimateTokensFromChars\(/.test(CODE(`${A}/src/main/core/agent-executor.ts`)),
      'B-8b `estTextTokens` 保留"空串最小 1"旧语义（rr_zx_20260906_1_b1 钉着），但分度已引自真源');

    // ── B-9 ★反证（不该命中）：随步进推算的 token **不入 ANS 账单**为"真"——账单只在真值域记账 ──
    //   `stepTokens > 0` 才上报，估算也会 > 0 ⇒ 会上报；这里钉的是**上报的数值即记账用的数值**（同一把尺），
    //   不做"账单用真值、闸用估算"的两本账。
    ok(/if \(stepTokens > 0\) \{/.test(stepSrc) && /tokens_in: stepPrompt, tokens_out: stepComp/.test(stepSrc),
      'B-9 账单与闸**同一把尺**：上报的 `stepPrompt/stepComp` 即记账增量（估也照报，不另开一本账）');
  }

  // ═══ C｜批三 · 选型留痕（「选得明」）═══════════════════════════════════════════
  console.log('\n【C】批三 · 选型留痕（「选得明」）');
  {
    // ── C-1 端点归属纯函数（两侧：本机 / 局域网 / 云端 / 未知）──────────────────────
    eq(
      ['http://localhost:27183', 'http://127.0.0.1:1', 'http://[::1]:9', 'http://0.0.0.0:1'].map(endpointScope),
      ['本机', '本机', '本机', '本机'],
      'C-1a ★该命中：环回三形态 + `0.0.0.0` ⇒ `本机`',
    );
    eq(
      ['http://10.0.0.5:11434', 'http://192.168.1.9:11434', 'http://172.16.3.4:1', 'http://172.31.9.9:1', 'http://169.254.1.1:1', 'http://box.local:1'].map(endpointScope),
      ['局域网', '局域网', '局域网', '局域网', '局域网', '局域网'],
      'C-1b ★该命中：RFC1918 / 链路本地 / `.local` ⇒ `局域网`（自建端点最常见的几种形态）',
    );
    eq(
      ['https://api.deepseek.com', 'https://api.openai.com/v1', 'http://172.32.0.1:1', 'http://11.0.0.1:1'].map(endpointScope),
      ['云端', '云端', '云端', '云端'],
      'C-1c ★反证（不该判本地）：公网域名 ⇒ `云端`，且 `172.32.x`（出 RFC1918 上界）/ `11.x`（非 `10.`）**不被误判**为私网',
    );
    eq(['', 'not a url', '://x', 'http://'].map(endpointScope), ['未知', '未知', '未知', '未知'],
      'C-1d ★如实少说：非 URL / 缺 scheme ⇒ `未知`（**不**替它编一个 `云端`）');

    // ★ 与 `isLocalUrl` **刻意不是一把尺**——这条此前只写在注释里，现**断言**出来（否则注释会烂掉）。
    eq([endpointScope('http://10.0.0.5:11434'), isLocalUrl('http://10.0.0.5:11434')], ['局域网', false],
      'C-1e ★★两把尺不同（有意为之）：LAN 端点 本函数=局域网 / `isLocalUrl`=false（后者答的是"可否代起"）——谁把它俩"统一"了，这条立刻红');

    // ── C-2 能力匹配标签：ANS 自陈优先 → 现算 → 未知（不许默认成 full）─────────────────
    const demand = ['chat', 'function-calling'];
    eq(capabilityMatchLabel({ capabilityMatch: 'full' }, null), 'full', 'C-2a ANS 自陈 `full` ⇒ `full`（即便本侧算不出清单也不改口）');
    eq(capabilityMatchLabel({ capabilityMatch: 'partial' }, null), 'partial', 'C-2b ANS 自陈 `partial` ⇒ `partial`（环境所迫的降级如实转述）');
    eq(capabilityMatchLabel({}, { got: demand, missing: [] }), 'full', 'C-2c 自陈缺席 + 现算无缺 ⇒ `full`（与装配图片闸同一把尺）');
    eq(capabilityMatchLabel({}, { got: ['chat'], missing: ['function-calling'] }), '缺1项', 'C-2d 自陈缺席 + 现算缺 1 ⇒ `缺1项`（不四舍五入成 `partial`）');
    eq(capabilityMatchLabel({}, null), '未知', 'C-2e ★两处都取不到 ⇒ `未知`（**不**默认 `full`——那是替我们并不知道的事签字）');

    // ── C-3 ★该命中（端到端）：跑一次生产选型 ⇒ 落**一条** `[选型]` 行且五格齐 ────────────
    {
      const db = mkdb();
      const r = await pickSel(db, 't-sel-1', { strategySource: 'learned' });
      const sel = r.conv.filter((c) => c.startsWith('[选型] '));
      eq(sel, ['[选型] 策略来源=learned · 策略=balanced · 模型=qwen3.5:9b · 端点=本机 · 能力匹配=full'],
        'C-3a ★★该命中：四要素一次说全（策略来源 / 策略 / 模型 / 端点归属 / 能力匹配）——某项目那轮"为什么用 qwen3.5:9b"如今账上可查');
      eq(r.thrown, null, 'C-3b 该路不抛（探活未通过 ≠ 端点已死，按原端点继续）');

      // ★反证（不该命中）：同一次运行还落了 `[降级通知]`，但 `[选型]` **仍恰一条**——不产生第二份选型账。
      eq([sel.length, r.conv.filter((c) => c.startsWith('[降级通知]')).length], [1, 1],
        'C-3c ★反证：一次运行即便另落 `[降级通知]`，`[选型]` 仍**恰 1 条**（选型账只此一本）');
    }

    // ── C-3d 策略暂停时留痕**仍在**（选型已定稿 ≠ 任务被放行）────────────────────────
    {
      const db = mkdb();
      db.prepare("INSERT INTO wa_settings (key, value) VALUES ('policy.cascade_fail_threshold', '0')").run();
      const r = await pickSel(db, 't-sel-2', { strategySource: 'natural' });
      eq([r.conv.filter((c) => c.startsWith('[选型] ')).length, r.conv.filter((c) => c.startsWith('[策略] ')).length], [1, 1],
        'C-3d 选型账**先于**策略闸落（阈值 0 ⇒ 闸必触发暂停，两行仍各 1 条）——"选型收尾"这一刻已经发生，不该因后续闸拦而失账');
    }

    // ── C-4 缺省用法（四支既有 rr 套件不传 `strategySource`）⇒ 如实 `未知`，不默认 `default`─
    {
      const db = mkdb();
      const r = await pickSel(db, 't-sel-3');
      eq(r.conv.filter((c) => c.startsWith('[选型] ')), ['[选型] 策略来源=未知 · 策略=balanced · 模型=qwen3.5:9b · 端点=本机 · 能力匹配=full'],
        'C-4 ★缺席 ⇒ `策略来源=未知`（不默认 `default`——"不知道"就说不知道）');
    }

    // ── C-5 ★一处真源（静态）：全仓只此一处写 `[选型]` 前缀 ────────────────────────────
    const selSrc = CODE(`${A}/src/main/core/exec-model-select.ts`);
    eq((selSrc.match(/\[选型\]/g) ?? []).length, 1,
      'C-5a ★一处真源：`exec-model-select.ts`（去注释后）写 `[选型]` **恰 1 处**');
    const writers = walkFiles(path.join(root, `${A}/src/main`))
      .filter((p) => CODE(path.relative(root, p)).includes('[选型]'))
      .map((p) => path.relative(path.join(root, `${A}/src/main`), p));
    eq(writers, ['core/exec-model-select.ts'],
      'C-5b ★★反证（不该命中）：整个 `src/main` 里**只有它一个**写 `[选型]`——任何第二处即"两本账，迟早分家"');
    ok(!/isLocalUrl/.test(selSrc),
      'C-5c ★反证：留痕**不借** `isLocalUrl` 判端点归属（两问不同，混用会把 LAN 自建端点误报成 `云端`）');

    // ── C-6 接线（静态）：`strategySource` 声明为**可选** + 生产调用方**真传** ─────────────
    ok(/strategySource\?:\s*string/.test(selSrc),
      'C-6a ★声明为**可选**：既有四支 rr 调用方（rr_zx_20260929 / _20260921 / _20260921_1 / _20261012_2）不传也不破——不为过编译而逼它们编一个值');
    const execSrc = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/selectModelForTask\(\{[^}]*strategySource[^}]*\}\)/.test(execSrc),
      'C-6b ★生产调用方**真传** `strategySource`（只声明不接线＝"做了没用上"）');
    ok(/const strategySource = naturalStrategy \? 'natural' : learnedStrategy \? 'learned' : 'default'/.test(execSrc),
      'C-6c 策略来源三档取值的**唯一计算点**仍在 executor（留痕只是转述，不自立第二份口径）');
  }

  // ═══ D｜批四 · 重活形态不被随机挑中（「选得明」续）══════════════════════════════════
  console.log('\n【D】批四 · 重活形态的选型下限（重活不被随机挑中）');
  {
    eq([...HEAVY_ARCHETYPES], ['code', 'research', 'analysis'],
      'D-0 ★"重活"不是形容词而是一份**名单**（由生产导出逐一枚举——改名单必动此断言）');

    // ── D-1 ★该命中：重活形态 + 随机策略 ⇒ 回落形态自带策略 ───────────────────────────
    eq(
      (['code', 'research', 'analysis'] as const).map((a) => applyArchetypeFloor(a, 'balanced')),
      [
        { modelStrategy: 'capability-best', floored: true },
        { modelStrategy: 'cost-optimal', floored: true },
        { modelStrategy: 'capability-best', floored: true },
      ],
      'D-1a ★★该命中：`code`/`research`/`analysis` 遇 `balanced` 一律回落**各自**形态自带策略（不是一刀切成同一个值）',
    );
    ok(applyArchetypeFloor('code', 'balanced').floored,
      'D-1b ★判据是"非确定性"而非"rank 降级"：`code` 自带 `capability-best`，被 `balanced` 覆盖即抽签 ⇒ 拦');

    // ── D-2 ★反证（不该命中）：确定性策略一律放行（含**低于**自带的 `cost-optimal`）────────
    eq(
      [
        applyArchetypeFloor('code', 'capability-best'),
        applyArchetypeFloor('code', 'cost-optimal'),
        applyArchetypeFloor('research', 'cost-optimal'),
        applyArchetypeFloor('analysis', 'capability-best'),
      ].map((r) => r.floored),
      [false, false, false, false],
      'D-2a ★★反证：确定性策略**不拦**——包括 `code` 上**比自带更便宜**的 `cost-optimal`（要禁的是"抽签"，不是"省钱"）');

    // ── D-3 ★反证（不该命中）：非重活形态不受此闸管辖 ───────────────────────────────
    eq(
      (['document', 'configuration', 'conversation'] as const).map((a) => applyArchetypeFloor(a, 'balanced').floored),
      [false, false, false],
      'D-3a ★反证：`document`/`configuration`（自带就是 `balanced`）与 `conversation` **不**被本闸改口——闸只管重活，越界即"替用户做了他没要的决定"');

    // ── D-4 ★不变式（静态）：重活形态自带策略**自身必须是确定性的** ────────────────────
    //   否则"回落到自带策略"就是把抽签换个名字（下限形同虚设，且是**静默**的）。
    const heavyOwn = (['code', 'research', 'analysis'] as const).map((a) => ADAPTIVE_STRATEGIES[a].modelStrategy);
    eq(heavyOwn, ['capability-best', 'cost-optimal', 'capability-best'],
      'D-4a 重活形态自带策略的**实际值**（逐一枚举，不用幻数计数）');
    eq(heavyOwn.filter((s) => NON_DETERMINISTIC_STRATEGIES.includes(s)), [],
      'D-4b ★★不变式：重活形态自带策略**均在非确定性名单之外**——回落到它不是"换个名字抽签"');
    ok(NON_DETERMINISTIC_STRATEGIES.includes('balanced'),
      'D-4c 非确定性名单与 ANS `sortByStrategy` 同源：`balanced` = `weightedShuffle`（跨仓结论，只登记名不复制实现）');

    // ── D-5 接线（静态）：executor 在 **tilt 之前** 应用下限、且真留痕 ──────────────────
    const exSrc = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/applyArchetypeFloor\(archetype, baseStrategy\.modelStrategy\)/.test(exSrc),
      'D-5a ★生产调用方**真接线**：`applyArchetypeFloor(archetype, baseStrategy.modelStrategy)`（只定义不调＝"做了没用上"）');
    ok(/\[策略下限\]/.test(exSrc) && /INSERT INTO wa_task_conversations/.test(exSrc),
      'D-5b ★留痕：下限命中落一条 `[策略下限]` 会话行（用户可在详情页看到"为什么这次没按学来的策略走"）');
    // ★位置判据：下限块须在 `applyPriorityTilt` **之前**（用户显式信号不被系统越权覆盖）。
    const iFloor = exSrc.indexOf('applyArchetypeFloor(archetype, baseStrategy.modelStrategy)');
    const iTilt = exSrc.indexOf('applyPriorityTilt(baseStrategy, priority)');
    ok(iFloor >= 0 && iTilt >= 0 && iFloor < iTilt,
      'D-5c ★★位置：下限**先于** `applyPriorityTilt`——`task.priority` 是**用户显式**信号，系统学来的主意不越权替他改口');

    // ── D-6 ★一处真源（静态）：自带策略表只有一份，且下限**引**它不复制 ──────────────────
    const taSrc = CODE(`${A}/src/main/core/task-archetype.ts`);
    eq((taSrc.match(/^ {4}modelStrategy: 'capability-best',$/gm) ?? []).length, 2,
      'D-6a `ADAPTIVE_STRATEGIES` 表项里 `capability-best` **恰 2 处**（`code`/`analysis`；按缩进+逗号认表项，不把上方联合类型算进来）');
    ok(/const own = ADAPTIVE_STRATEGIES\[archetype\]\.modelStrategy/.test(taSrc),
      'D-6b ★下限**引** `ADAPTIVE_STRATEGIES` 取自带策略（改表即改闸，不散两份真源）');
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
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261012_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261012_3 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261012_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
