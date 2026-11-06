/**
 * zx_20260928 受控复跑 —— 「写下的，机器要认」（续）· **完成出口同一把尺**。
 *
 * 五条病根（全部有真库标本，见方案 §Context 表）：
 *   D1 `finalize_task` 出口**绕过全部四道 45 分封顶**（自评表直记）——标本 `a5dfdb48`：95 分 /
 *      `via:'finalize_task'` / 同一份 `context_json` 里验收账 `verified:false`。
 *   D2 产出物重复登记：去重口径**按路分家**（写口 project 级 / 注册口 task 级 / IPC 无去重）。
 *   D3 `register_deliverable` 的版本行 INSERT **漏 NOT NULL `file_path`**，异常被空 `catch {}` 吞。
 *   D4 `execution_metrics` **只有 run_close 一处写**，另三个出口不写 ⇒ 三个读方误判。
 *   D5 去重命中时**回请求的 type**，行里是另一个 type（名实不符）。
 *
 * §判据纪律（逐条对上本仓 auto-memory）：
 *   G-1 **真源在位**：直调生产符号（`completionCapFloors` / `buildTools` 造真工具跑真 `execute`
 *       / `findDeliverableByPath`（经 `register_deliverable` 的生产面）/ `evaluateAutoTensions`
 *       / `diagnosePrincipalContradiction` / `finalizeTaskByHuman`）——被删/改名即**编译期失败**，
 *       不是"扫了个空"。
 *   G-2 **两只标本**：每一道封顶的**该压**与**该不压**两侧各有一只真标本（封顶的豁免侧只在
 *       `completionCapFloors` 的返回值里可见——落库 feedback 只在真压降时带注记，故豁免侧**直调真函数**验）。
 *   G-3 **计数器正面断言**：版本行断言"0 → 1"而非"不抛"（D3 的病根正是被空 `catch` 吞掉后**永远 0 行**）。
 *   G-4 **生产入参**：工具行喂**当前生产真形状**（单行 `[name] {"ok":true,"path":…}`）；产出物路径喂
 *       **真实落盘的绝对路径**（`register_deliverable` 的 `fp` 就是这么算的）。
 *   G-5 无轮次字面量：不改 `build`，钉由 `checkBuildPins` 从真源派生（§G）。
 *   G-6 不依赖真实墙钟：无 `now` 注入面；时间列一律让 SQLite 默认值填。
 *
 * ⚠ 承 `feedback_rr_fixture_production_order`：夹具 DDL 逐列照抄 `database.ts`（含 `wa_deliverable_versions`
 *   的 `file_path TEXT NOT NULL` 与 `wa_projects`）；`deliverable-lifecycle.ts` 用 `db.transaction(...)`
 *   而 `node:sqlite` 没有 ⇒ 补 `withTx` 驱动垫片（只补驱动能力，被测逻辑一行未替）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';
import {
  buildTools, completionCapFloors, realOutputEvidence,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { finalizeTaskByHuman } from '../apps/worker-ant-desktop/src/main/core/finalize-by-human.js';
import { PAUSE_REASON_QUALITY_BELOW_BAR } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import {
  evaluateAutoTensions, diagnosePrincipalContradiction, getTensions,
} from '../apps/worker-ant-desktop/src/main/core/tension-engine.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string): void =>
  ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
// ⚠ 静态判据一律读**原文**（`engineSrc()` 与 `rr_zx_20260909_1_b1` 的台账同面）。
//   刻意**不**做「去注释」：正则式去块注释在本仓是**静默毁伤**——源码里 `'**/*'` 这类 glob 字符串
//   含裸 `/*`，非贪婪匹配会一路吞到很远处的 `*/`，把中间的代码整段删掉再拿去 includes，
//   于是「符号在场」判据假红/假绿且**没有任何报错**。判据要「钉在符号上」，靠的是锚点形状，
//   不是靠先把源码改成另一个样子。
type AnyDb = import('better-sqlite3').Database;

// ── 夹具 schema：逐列照抄 database.ts DDL（既不缺列也不放宽 NOT NULL） ──
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace', owner_id TEXT,
  cron_timezone TEXT DEFAULT 'Asia/Shanghai', autonomous_mode TEXT DEFAULT 'off',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT,
  status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, file_path TEXT NOT NULL,
  content_snapshot TEXT NOT NULL, size INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  changed_by TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT NOT NULL,
  milestone TEXT NOT NULL, status TEXT DEFAULT 'pending', implemented_by_task_id TEXT,
  updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_plan_milestones_uniq ON wa_plan_milestones(plan_task_id, milestone);
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); initProject(d); return withTx(d as unknown as AnyDb); };

/**
 * `node:sqlite` 没有 better-sqlite3 的 `db.transaction()`，而 `deliverable-lifecycle` 的
 * `applyPrimary` 是**真实现**。故只补这一枚驱动方法（语义照 better-sqlite3，抛错即 ROLLBACK 后原样抛出）。
 */
const withTx = (d: AnyDb): AnyDb => {
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => {
    d.exec('BEGIN');
    try { fn(); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* 无活动事务 */ } throw e; }
  };
  return d;
};

/** 每个夹具库都建工程行（`getTensions`/`evaluateAutoTensions` 读它；后者那条 SELECT **不在** try/catch 内） */
const PID = 'p';
const initProject = (d: AnyDb): void => {
  d.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES (?, 'rr28', ?)")
    .run(PID, JSON.stringify({ tensions: { 'speed-vs-quality': { position: 50, autoAdjust: true, updatedAt: '2026-01-01T00:00:00Z' } } }));
};

const addTask = (db: AnyDb, id: string, status: string, opts: { parent?: string; ctx?: Record<string, unknown>; criteria?: string; title?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, status, depends_on, source, acceptance_criteria, context_json)
              VALUES (?, '${PID}', ?, ?, '', ?, '', 'test', ?, ?)`)
    .run(id, opts.parent ?? '', opts.title ?? id, status, opts.criteria ?? '', JSON.stringify(opts.ctx ?? {}));
};
const addDeliv = (db: AnyDb, id: string, taskId: string, over: { type?: string; name?: string; status?: string; file_path?: string | null } = {}): void => {
  db.prepare(`INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status, is_primary, acceptance_verified)
              VALUES (?, '${PID}', ?, ?, ?, '', ?, ?, 0, 0)`)
    .run(id, taskId, over.type ?? 'doc', over.name ?? id, over.file_path ?? null, over.status ?? 'draft');
};
const addToolRow = (db: AnyDb, taskId: string, content: string): void => {
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (?, ?, 'tool', ?, 0)")
    .run(crypto.randomUUID(), taskId, content);
};
/** n 条 assistant 对话（低于 2 条会撞"无产出物且无对话 → 10 分"硬规则，故夹具按生产常态给 3 条） */
const addChat = (db: AnyDb, taskId: string, n: number): void => {
  for (let i = 0; i < n; i++) addToolRow2(db, taskId, 'assistant', `第 ${i + 1} 轮结论`);
};
const addToolRow2 = (db: AnyDb, taskId: string, role: string, content: string): void => {
  db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content, token_count) VALUES (?, ?, ?, ?, 0)')
    .run(crypto.randomUUID(), taskId, role, content);
};
const ctxObj = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const statusOf = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;

const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx28-'));
// `checkMCPRegistrationIntegrity` 只扫 `.py`；空目录 ⇒ 0 缺失（不用 emoji，免跨端换行意外）
fs.writeFileSync(path.join(wdir, 'notes.txt'), 'fixture working dir', 'utf-8');

/** 真调生产 `finalize_task`（不切片、不复刻判据）——同 `rr_zx_20260915` §S10 范式 */
const fin = async (db: AnyDb, taskId: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const tools = buildTools({ db } as never, taskId, PID, wdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
  return tools.finalize_task!.execute({ summary: '按方案分步实施完成', quality: 'good', ...extra });
};
const toolExec = (db: AnyDb, taskId: string, name: string) => {
  const tools = buildTools({ db } as never, taskId, PID, wdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
  return tools[name]!;
};

const aeSrc = engineSrc();
const writeSrc = RD(`${A}/src/main/core/tools/write.ts`);
const humanSrc = RD(`${A}/src/main/core/finalize-by-human.ts`);

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【A】D1 封顶不可绕 · 同一件事同一把尺 —— 真工具 `finalize_task` · 真 execute');

  // ── A-1 该压侧：`document` 类 + 0 产出物 + 查无产出性写入 + 自评 excellent ──
  {
    const db = mkdb();
    addTask(db, 'low', 'executing', { ctx: { archetype: 'document' } });
    addChat(db, 'low', 3);
    const caps = completionCapFloors(db, { taskId: 'low', workingDir: wdir, archetype: 'document', hasDeliverables: false });
    eq(caps.cap, 45, 'A-1 封顶真源：document 类 + 0 产出物 + 无产出性写入 ⇒ cap = 45（不是 95）');
    ok(caps.typeNote.includes('document类无产出物'), 'A-2 注记如实点名那一类', caps.typeNote);

    const res = await fin(db, 'low', { quality: 'excellent' });
    ok(res.includes('paused_partial'), 'A-3 工具串含 `paused_partial`（低分收口走**暂停**出口，不是 finalized）', res.slice(0, 140));
    ok(!res.includes('finalized'), 'A-4 ★且**不含** `finalized`（两个 marker 互斥——否则 onStepFinish 会把暂停读成完成）');
    const cq = ctxObj(db, 'low').completion_quality as { score?: number; via?: string; feedback?: string } | undefined;
    eq(cq?.score, 45, 'A-5 ★落库分 **45**（不是自评的 95——四道封顶在记账前生效）');
    eq(cq?.via, 'finalize_task', 'A-6 via 如实记 `finalize_task`（自评分不得冒充引擎六维分）');
    ok(!!cq?.feedback && cq.feedback.includes('document类无产出物'), 'A-7 feedback 如实写「哪道封顶压的」（不是沉默地给低分）', cq?.feedback);
    eq(statusOf(db, 'low'), 'paused', 'A-8 ★终态 `paused`（与 run_close 同尺：分不够就停，不是记成完成）');
    eq(ctxObj(db, 'low').pause_reason, PAUSE_REASON_QUALITY_BELOW_BAR, 'A-9 暂停因由落 `quality_below_bar`（因由落库，不靠事件旁证）');
  }

  // ── A-10 该不压侧：同一夹具 + 真实产出性写入 ⇒ **不压降**（豁免侧只在真函数返回值里可见） ──
  {
    const db = mkdb();
    addTask(db, 'high', 'executing', { ctx: { archetype: 'document' } });
    addChat(db, 'high', 3);
    // 生产真形状：单行 `[edit_file] {"ok":true,"path":"…","replaced":…,"size":…}`
    addToolRow(db, 'high', '[edit_file] ' + JSON.stringify({ ok: true, path: '报告.md', replaced: 1, size: 10 }));
    const caps = completionCapFloors(db, { taskId: 'high', workingDir: wdir, archetype: 'document', hasDeliverables: false });
    eq(caps.cap, 95, 'A-10 ★豁免侧：document 标签**但有产出性写入行为** ⇒ cap 仍 95（封顶不被过度触发）');
    ok(caps.typeNote.includes('不压降'), 'A-11 注记说明"为何不压"（不是静默放行）', caps.typeNote);

    const res = await fin(db, 'high', { quality: 'excellent' });
    ok(res.includes('finalized') && !res.includes('paused_partial'), 'A-12 该不压侧照旧 `finalized`（没有把封顶放宽成"一律停"）', res.slice(0, 140));
    const cq = ctxObj(db, 'high').completion_quality as { score?: number } | undefined;
    eq(cq?.score, 95, 'A-13 落库分 95（自评 excellent 且未命中任何封顶）');
    eq(statusOf(db, 'high'), 'executing', 'A-14 工具本身**不**改状态（`completed` 由执行体 catch 那支落笔——本工具串只能触发它）');
  }

  // ── A-15 隔离 CAP3：验收未通过 ⇒ 45，且注记**只能**出自验收那条 ──
  {
    const db = mkdb();
    addTask(db, 'acc', 'executing', {
      ctx: {
        archetype: 'code',
        acceptance_check: { checked_at: '2026-01-01T00:00:00Z', verified: true, criteria_total: 2, passed_total: 0 },
      },
    });
    addChat(db, 'acc', 3);
    // `code` 类不受 CAP1；一行写入 ⇒ `realOutputEvidence` 真 ⇒ CAP2 不触发 ⇒ 只剩 CAP3 可能压分
    addToolRow(db, 'acc', '[edit_file] ' + JSON.stringify({ ok: true, path: 'x.py', replaced: 1 }));
    ok(realOutputEvidence(db, 'acc'), 'A-15 前置：该行足以让 CAP2 **不**触发（`realOutputEvidence` 只看工具名）');
    const caps = completionCapFloors(db, { taskId: 'acc', workingDir: wdir, archetype: 'code', hasDeliverables: false });
    eq(caps.cap, 45, 'A-16 隔离：`code` 类 + 有写入 ⇒ 45 分**只能**出自 CAP3（验收未通过）');
    eq(caps.typeNote, ' [验收未通过，评分压降<60]', 'A-17 且注记恰为 CAP3 那条（不是 CAP1/CAP2 的措辞）');

    const res = await fin(db, 'acc', { quality: 'excellent' });
    ok(res.includes('paused_partial'), 'A-18 验收未通过 + 自评高分 ⇒ 同样走暂停出口');
    const cq = ctxObj(db, 'acc').completion_quality as { score?: number; feedback?: string } | undefined;
    eq(cq?.score, 45, 'A-19 落库分 45');
    ok(!!cq?.feedback && cq.feedback.includes('验收未通过'), 'A-20 feedback 点名成因', cq?.feedback);
    eq(statusOf(db, 'acc'), 'paused', 'A-21 终态 paused');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【B】D1 前提机制：两个 marker 的**优先序**即判据（静态，锚在符号上）');
  {
    const iPaused = aeSrc.indexOf("fres.includes('paused_partial')");
    const iFin = aeSrc.indexOf("fres.includes('finalized')");
    ok(iPaused > 0 && iFin > 0 && iPaused < iFin,
      'B-1 ★onStepFinish 内 `paused_partial` 判定**在** `finalized` **之前**（`checks` 明细理论上可能含 finalized 子串）',
      `idx ${iPaused} < ${iFin}`);
    const cFin = aeSrc.indexOf("reasonMsg.includes('finalize_completed')");
    const cPaused = aeSrc.indexOf("reasonMsg.includes('finalize_paused')");
    const cIntr = aeSrc.indexOf("reasonMsg.includes('interrupt')");
    ok(cFin > 0 && cPaused > 0 && cIntr > 0, 'B-2 三个 catch 分支的判据符号都在场（被删/改名即红）',
      `${cFin} / ${cPaused} / ${cIntr}`);
    ok(cFin < cPaused && cPaused < cIntr,
      'B-3 ★catch 分发次序：`finalize_completed` → `finalize_paused` → `interrupt`（顺序即优先级）');
    ok(aeSrc.includes("pauseTask(db, { taskId, reason: PAUSE_REASON_QUALITY_BELOW_BAR, note: finNote })"),
      'B-4 低分收口复用**既有**那条暂停口（刻意不新增调用点——`rr_zx_20260909_1_b1` 的 engineSrc 台账钉着总数）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】D2 去重口径归一处 · **不夺归属** —— 经真 `register_deliverable`');
  {
    const db = mkdb();
    const shared = path.join(wdir, 'rr28_shared_api.py');
    addTask(db, 'parent', 'completed');
    addTask(db, 'child', 'executing');
    addDeliv(db, 'd-parent', 'parent', { type: 'doc', name: '父名下成果', file_path: shared });

    const reg = toolExec(db, 'child', 'register_deliverable');
    const raw = await reg.execute({ name: '子想登记的同一文件', type: 'daemon', filePath: shared });
    const p = JSON.parse(raw) as { ok?: boolean; id?: string; type?: string; deduplicated?: boolean };
    eq(p.deduplicated, true, 'C-1 跨任务同路径 ⇒ `deduplicated: true`（project 级口径，与 `write_file` 路同尺）');
    eq(p.id, 'd-parent', 'C-2 回的是**既有行**的 id（没有新建第二行）');
    eq(p.type, 'doc', 'C-3 ★D5 名实相符：`type` 回**行里真实的值** `doc`，不回本次请求的 `daemon`');
    const rows = db.prepare('SELECT id, task_id FROM wa_deliverables WHERE project_id = ? AND file_path = ?').all(PID, shared) as Array<{ id: string; task_id: string }>;
    eq(rows.length, 1, 'C-4 该 (project, file_path) 下仍**恰 1 行**（不新增）');
    eq(rows[0]!.task_id, 'parent', 'C-5 ★**不夺归属**：既有行的 `task_id` 一字未改');
    eq(db.prepare('SELECT COUNT(*) c FROM wa_deliverables').get() as { c: number } | undefined,
      { c: 1 }, 'C-6 全表仍 1 行（对照：若按 task 级口径会落成 2 行）');

    // ── C-7 反证：换一个**没有既有行**的路径 ⇒ 正常落新行、归属本任务 ──
    const fresh = path.join(wdir, 'rr28_fresh_api.py');
    const raw2 = await reg.execute({ name: '新文件', type: 'daemon', filePath: fresh });
    const p2 = JSON.parse(raw2) as { id?: string; type?: string; deduplicated?: boolean };
    ok(p2.deduplicated === undefined, 'C-7 反证：无既有行 ⇒ **不**带 `deduplicated`（两只标本结论必须不同）', raw2);
    eq(p2.type, 'daemon', 'C-8 反证：新行照记请求的 type');
    const rowNew = db.prepare('SELECT task_id, file_path FROM wa_deliverables WHERE id = ?').get(p2.id) as { task_id: string; file_path: string };
    eq(rowNew.task_id, 'child', 'C-9 反证：新行归属**本任务**（`child`），与 C-5 的"不夺归属"两侧合起来才完整');
    eq(rowNew.file_path, fresh, 'C-10 反证：新行 `file_path` 即请求的绝对路径');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【D】D3 版本行形状对齐 · 正面断言（不是「不抛」）');
  {
    const db = mkdb();
    addTask(db, 'd3', 'executing');
    const rel = 'rr28_报告.md';
    const abs = path.join(wdir, rel);
    const body = '# 报告\n\n' + '汉字汉字'.repeat(300) + '\n';
    fs.writeFileSync(abs, body, 'utf-8');
    eq(db.prepare('SELECT COUNT(*) c FROM wa_deliverable_versions').get() as { c: number } | undefined,
      { c: 0 }, 'D-1 前置：版本表 0 行（D3 的病根形状——**永远** 0 行）');

    const reg = toolExec(db, 'd3', 'register_deliverable');
    const p = JSON.parse(await reg.execute({ name: '报告', type: 'doc', filePath: abs })) as { ok?: boolean; id?: string };
    eq(p.ok, true, 'D-2 `register_deliverable` 正常返回 ok');
    const vs = db.prepare('SELECT file_path, content_snapshot, size, version, changed_by FROM wa_deliverable_versions WHERE deliverable_id = ?').all(p.id) as Array<{ file_path: string; content_snapshot: string; size: number; version: number; changed_by: string }>;
    eq(vs.length, 1, 'D-3 ★计数器正面断言：该 `deliverable_id` 下**恰 1 行**版本（0 → 1；D3 修复前此处恒 0）');
    eq(vs[0]?.file_path, abs, 'D-4 ★NOT NULL 列 `file_path` 落值非空且 = 注册路径（D3 病根列）');
    eq(vs[0]?.content_snapshot, body, 'D-5 快照即文件内容');
    eq(vs[0]?.size, body.length, 'D-6 ★`size` = **字符数**（与 `database.ts` 的「character count, not bytes」同尺）');
    ok((vs[0]?.size ?? 0) !== Buffer.byteLength(body, 'utf-8'),
      'D-7 ★且**不等于**字节数（多字节内容下两者可分辨——单靠 D-6 无法排除"恰好相等"的假绿）',
      `字符 ${vs[0]?.size} / 字节 ${Buffer.byteLength(body, 'utf-8')}`);
    eq(vs[0]?.version, 1, 'D-8 版本号 1');
    eq(vs[0]?.changed_by, 'd3', 'D-9 `changed_by` = 本任务 id');
  }
  ok(writeSrc.includes('type: ex.type, filePath: fp, deduplicated: true'),
    'D-10 去重回值形状锚在**符号**上（`type` 取行、不取请求值）');
  ok(/INSERT INTO wa_deliverable_versions \([^)]*file_path[^)]*\)/.test(writeSrc),
    'D-11 版本行 INSERT 的列清单**含 `file_path`**（D3 的直接防线）');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【E】D4 写入端：三个收尾口都补 `execution_metrics`，人工口**不编造**');
  {
    // zx_20261018_1 批七：四个收口出口的 `execution_metrics` 写入**收成一处**（`core/exec-metrics.ts`
    //   的 `writeExecutionMetrics`）。故判据从「三处各写一段 JSON」改为「唯一写口 + 三个出口都调它」：
    //   写口数目由真源（引擎扫描面）派生，三处调用按**各支自己的锚点**切片核对——不写死本轮常量。
    const nWrites = aeSrc.split('execution_metrics = {').length - 1;
    ok(aeSrc.includes('export function writeExecutionMetrics('), 'E-0 唯一写口 `writeExecutionMetrics` 在引擎扫描面内');
    ok(nWrites === 1, 'E-4 ★写入点恰 1 处（唯一写口；"各出口各写一段"的旧形态已收）', `${nWrites} 处`);
    const exeSrc = RD(`${A}/src/main/core/agent-executor.ts`);
    /** 从锚点 A 切到锚点 B（B 必须在 A 之后；否则返回空串——判据自然红）。 */
    const between = (src: string, a: string, b: string): string => {
      const i = src.indexOf(a); const j = src.indexOf(b, i + a.length);
      return i >= 0 && j > i ? src.slice(i, j) : '';
    };
    const finBody = between(exeSrc, 'fctx.cost_estimate = fce;', 'blockFailedChildrenCompletion(db, taskId)');
    const pausedBody = between(exeSrc, "'任务 finalize 低分收口，已置 paused 待人工'", "'[未达交付] finalize_task 收口分未达交付标准");
    const closeBody = between(exeSrc, 'ctxJson.cost_estimate = ce;', 'syncQualityColumn(db, taskId);');
    ok(finBody.includes('writeExecutionMetrics(db, taskId, {'), 'E-1 `finalize_completed` 支经唯一写口补写');
    ok(pausedBody.includes('writeExecutionMetrics(db, taskId, {'), 'E-2 `finalize_paused` 支经唯一写口补写（本轮的暂停出口）');
    ok(closeBody.includes('writeExecutionMetrics(db, taskId, {'), 'E-3 run_close 支经唯一写口补写（既有）');
    const nCalls = exeSrc.split('writeExecutionMetrics(db, taskId, {').length - 1;
    ok(nCalls >= 3, 'E-4b 执行体三处调用齐（用 `>=` 而非 `=== 3`：不写死本轮值）', `${nCalls} 处`);
    const nEv = aeSrc.split('hasDeliverable: realOutputEvidence(db, taskId)').length - 1;
    ok(nEv >= 3, 'E-5 三处**同形**（同一个 `realOutputEvidence` 真源，不各写一份判据）', `${nEv} 处`);
    ok(!humanSrc.includes('execution_metrics'),
      'E-6 ★反证（静态）：人工收口 `finalize-by-human.ts` 内**无** `execution_metrics`（它不执行任务 ⇒ 不得编造）');

    // ── E-7 反证（行为）：真调 `finalizeTaskByHuman` ⇒ 该键**仍不在** ──
    const db = mkdb();
    addTask(db, 'human', 'executing', { ctx: { archetype: 'code', pause_reason: 'quality_below_bar' } });
    const r = finalizeTaskByHuman(db, { taskId: 'human', via: 'task:updateStatus' });
    ok(r.cleared.includes('pause_reason'), 'E-7 前置：人工收口确实跑了（清掉了陈旧暂停键）', JSON.stringify(r));
    ok(!('execution_metrics' in ctxObj(db, 'human')),
      'E-8 ★行为反证：人工收口后 `execution_metrics` **仍不在**（"没跑任务"就该没这笔账）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【F】D4 读出端：**未知** ≠ **没有** —— 真调 `evaluateAutoTensions` / `diagnosePrincipalContradiction`');
  /** 造 N 条窗口内的 completed 任务，逐条喂同一份 `execution_metrics` */
  const completedWith = (n: number, mk: (i: number) => Record<string, unknown> | undefined): AnyDb => {
    const d = mkdb();
    for (let i = 0; i < n; i++) {
      const m = mk(i);
      addTask(d, `c${i}`, 'completed', { ctx: m ? { archetype: 'document', execution_metrics: m } : { archetype: 'document' } });
    }
    return d;
  };

  // ── F-1 全无 metrics ⇒ 一律弃权（`!undefined === true` 的旧缺陷所在） ──
  {
    const db = completedWith(5, () => undefined);
    const adj = evaluateAutoTensions(db, PID);
    eq(adj, [], 'F-1 ★只放**无 metrics** 的 completed 任务 ⇒ 自动调节**零**次（旧码把"没记过账"读成"没产出"并右调 +10）');
    eq(getTensions(db, PID)['speed-vs-quality']?.position, 50, 'F-2 且张力位置原样 50（没有被误调）');
    const diag = diagnosePrincipalContradiction(db, PID);
    ok(!!diag, 'F-3 诊断跑得起来（≥5 条窗口内任务）');
  }

  // ── F-4 有 metrics 但**缺 `hasDeliverable` 键**（历史行/未记全）⇒ 仍是"未知"，不参战、不打成 0% ──
  {
    const db = completedWith(5, () => ({ archetype: 'document', stepsUsed: 22, totalTokens: 1000 }));
    eq(evaluateAutoTensions(db, PID), [], 'F-4 缺键 ⇒ 同样弃权（`m != null && m.hasDeliverable === false` 才成立）');
    eq(getTensions(db, PID)['speed-vs-quality']?.position, 50, 'F-5 位置仍 50');
    const diag = diagnosePrincipalContradiction(db, PID);
    const text = JSON.stringify(diag);
    ok(text.includes('产出率未知'), 'F-6 ★账上如实说「产出率**未知**」', diag?.diagnosis);
    ok(!text.includes('产出率0%'), 'F-7 ★且**绝不**把未知打成「产出率0%」（把"没记过账"说成"一笔都没成"正是本轮要治的病）');
  }

  // ── F-8 三条**明确记着** `hasDeliverable:false` ⇒ 才真右调（与 F-1/F-4 两支结论必须不同） ──
  {
    const db = completedWith(5, () => ({ archetype: 'document', stepsUsed: 22, totalTokens: 1000, hasDeliverable: false }));
    eq(evaluateAutoTensions(db, PID),
      [{ tensionId: 'speed-vs-quality', from: 50, to: 60, reason: 'no_deliverable_streak' }],
      'F-8 ★明确记着"没产出" ⇒ 恰好一次右调 50 → 60（"事实"才参战）');
    eq(getTensions(db, PID)['speed-vs-quality']?.position, 60, 'F-9 位置落 60');
    const diag = diagnosePrincipalContradiction(db, PID);
    const text = JSON.stringify(diag);
    ok(text.includes('产出率0%'), 'F-10 ★此支**才**打「产出率0%」（与 F-6 的「未知」两支可分辨）', diag?.diagnosis);
    ok(!text.includes('产出率未知'), 'F-11 且此支不说「未知」');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】哑雷专项 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfSrc = fs.readFileSync(__filename, 'utf-8');
    ok(selfSrc.length > 2000, 'G-1 扫描面自证：本文件源码非空（否则下面的"零命中"是空转假绿）', `${selfSrc.length} 字节`);
    const pat = new RegExp(`'zx_\\d{8}(?:_\\d+)?'`, 'g');
    const hits = (selfSrc.match(pat) ?? []).filter((s) => {
      const y = Number(s.slice(4, 8));
      return y >= 2020 && y <= 2030;
    });
    eq(hits, [], 'G-2 ★本文件内**零**处「只为下一轮为真」的轮次字面量（轮次一律由载体自身派生）');
    const THIS = path.basename(__filename).replace(/\.ts$/, '');
    const relPlan = path.join('plans/improve', `${THIS.slice(3)}.md`);
    ok(fs.existsSync(path.join(root, relPlan)),
      'G-3 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', relPlan);
  }
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  try { fs.rmSync(wdir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }

  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260928: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error(e); process.exit(1); });
