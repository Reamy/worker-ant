/**
 * zx_20261027_2 受控复跑 —— 「净」：弃得掉，删得净。
 *
 * 由来（2026-10-27 桌面端实机反馈）：
 *   1. 已归档任务**删不掉**——归档后既无动作、也无清走入口；
 *   2. 删任务**不级联**——子任务成孤儿（`parent_task_id` 无外键，旧 handler 只认根 id）；
 *   3. 设备页三块旧配置是否冗余（已用代码证据回答：不删，见方案 §1.3）。
 *
 * 纪律（承 auto-memory）：
 *   G-1 用生产函数：B 组全部走真 `deleteTaskSubtree` / `collectTaskSubtree` + 内存真库真 SQL；
 *   G-2 两侧标本：子树 vs 兄弟子树 / 终态 vs 执行中 / 有环 vs 无环 / 存在 vs 不存在；
 *   G-6 零轮次字面量：本轮标识由 `path.basename(__filename)` 派生；
 *   ⚠ 夹具 DDL 逐列照抄 `database.ts`（含外键与墓碑列），开启 `foreign_keys = ON`——
 *     比生产宽松的夹具只会自我印证（`project:delete` 的外键事故即前车之鉴）。
 *   ⚠ 断言文案不含失败字形（`pnpm rr:all` 按日志字形计数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { collectTaskSubtree, deleteTaskSubtree } from '../apps/worker-ant-desktop/src/main/core/task-delete.js';
import type { TaskJobDb } from '../apps/worker-ant-desktop/src/main/core/task-jobs.js';

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

/** 本轮标识由载体自身派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/**
 * 夹具：逐列照抄 `database.ts` 中被本组 SQL 触及的表（含外键与墓碑列）。
 * `deleted_at/deleted_reason/deleted_fingerprint` 由 ALTER 补列，见 database.ts 迁移段。
 */
const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace', owner_id TEXT,
  cron_timezone TEXT DEFAULT 'Asia/Shanghai', autonomous_mode TEXT DEFAULT 'off',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
  title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
  context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT REFERENCES wa_tasks(id),
  role TEXT NOT NULL, content TEXT DEFAULT '', tool_calls TEXT,
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT,
  type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '',
  file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT REFERENCES wa_deliverables(id),
  file_path TEXT NOT NULL, content_snapshot TEXT NOT NULL, size INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, changed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT,
  content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
  importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
  user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
  is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT '');
CREATE TABLE wa_notifications (id TEXT PRIMARY KEY, event_id TEXT, type TEXT NOT NULL, task_id TEXT,
  project_id TEXT, title TEXT NOT NULL, body TEXT, read_at TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
`;

function fresh(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  d.exec(SCHEMA);
  d.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', 'proj')").run();
  return d;
}
/** `DatabaseSync` 的 `run()` 返回 `number | bigint`，与最小接口 `{ changes?: number }` 不同形——仅类型层面转一次。 */
const asDb = (d: DatabaseSync): TaskJobDb => d as unknown as TaskJobDb;
const count = (d: DatabaseSync, sql: string, ...p: unknown[]): number =>
  Number((d.prepare(sql).get(...(p as never[])) as { c: number }).c);

function mkTask(d: DatabaseSync, id: string, parent: string, status = 'completed', title = id): void {
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'p1', title, status, parent);
}

function seedLedger(d: DatabaseSync, taskId: string, tag: string): void {
  d.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)')
    .run(`c_${tag}`, taskId, 'user', 'hi');
  d.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name) VALUES (?, 'p1', ?, 'doc', ?)")
    .run(`d_${tag}`, taskId, `deliv-${tag}`);
  d.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size) VALUES (?, ?, ?, ?, ?)')
    .run(`v_${tag}`, `d_${tag}`, '/tmp/x', 'snap', 4);
  d.prepare("INSERT INTO wa_notifications (id, type, task_id, project_id, title) VALUES (?, 'task_done', ?, 'p1', ?)")
    .run(`n_${tag}`, taskId, `done-${tag}`);
  d.prepare("INSERT INTO wa_jobs (id, type, payload) VALUES (?, 'background-review', ?)")
    .run(`j_${tag}`, JSON.stringify({ taskId }));
  d.prepare("INSERT INTO wa_memories (id, project_id, task_id, content) VALUES (?, 'p1', ?, ?)")
    .run(`m_${tag}`, taskId, `mem-${tag}`);
}

function main(): void {
  // ═══ A｜归档可删 + 闸门/文案（静态接线）═══════════════════════════════════════════════════
  console.log('\n【A】M1 归档可删（两处闸门 + 文案）');
  {
    const list = CODE(`${A}/renderer/src/pages/TasksPage.tsx`);
    const detail = CODE(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    ok(list.includes("(t.status==='completed'||t.status==='failed'||t.status==='archived')&&<button onClick={()=>handleDelete(t.id)}"),
      'A-1 ★列表删除钮闸门含 archived');
    ok(detail.includes("(task.status==='completed'||task.status==='failed'||task.status==='archived') && <button onClick={() => handleDelete(task.id)}"),
      'A-2 ★详情删除钮闸门含 archived');
    ok(list.includes('其全部子任务') && detail.includes('其全部子任务'),
      'A-3 两处确认文案先说明"子任务一并清除"');
  }

  // ═══ B｜删除级联子树（生产函数 + 内存真库）═══════════════════════════════════════════════
  console.log('\n【B】M2 删除级联子树（真 SQL）');
  {
    // B-1 三层子树整棵删净；兄弟子树原封不动
    const d = fresh();
    mkTask(d, 'r1', '');
    mkTask(d, 'c1', 'r1', 'failed');
    mkTask(d, 'g1', 'c1');
    mkTask(d, 's1', '');          // 兄弟根
    mkTask(d, 's1c', 's1');       // 兄弟的子
    for (const t of ['r1', 'c1', 'g1', 's1', 's1c']) seedLedger(d, t, t);

    const before = {
      liveMem: count(d, "SELECT COUNT(*) AS c FROM wa_memories WHERE memory_type != 'deleted'"),
      tomb: count(d, "SELECT COUNT(*) AS c FROM wa_memories WHERE memory_type = 'deleted'"),
    };
    eq([before.liveMem, before.tomb], [5, 0], 'B-0 先验：删除前 5 条活记忆、0 条墓碑（0→1 的起点）');

    const r = deleteTaskSubtree(asDb(d), 'r1');
    ok(r.ok === true, 'B-1 终态子树删除成功');
    const ids = r.ok ? [...r.deletedIds].sort() : [];
    eq(ids, ['c1', 'g1', 'r1'], 'B-2 ★返回整棵子树的 id（含孙辈），一个不多一个不少');
    eq((d.prepare('SELECT id FROM wa_tasks ORDER BY id').all() as Array<{ id: string }>).map((x) => x.id),
      ['s1', 's1c'], 'B-3 ★兄弟子树原封不动（反证：级联不是"清库"）');

    eq(count(d, "SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id IN ('r1','c1','g1')"), 0, 'B-4 子树对话清净');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = 's1c'"), 1, 'B-5 兄弟对话仍在');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id IN ('r1','c1','g1')"), 0, 'B-6 子树产出物清净');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id = 's1'"), 1, 'B-7 兄弟产出物仍在');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_deliverable_versions WHERE deliverable_id IN ('d_r1','d_c1','d_g1')"), 0,
      'B-8 子树产出物版本清净（外键子表）');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_deliverable_versions WHERE id = 'v_s1c'"), 1, 'B-9 兄弟版本仍在');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_notifications WHERE task_id IN ('r1','c1','g1')"), 0, 'B-10 子树通知清净');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_jobs WHERE id IN ('j_r1','j_c1','j_g1')"), 0, 'B-11 子树作业清净');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_jobs WHERE id = 'j_s1'"), 1, 'B-12 兄弟作业仍在');

    const tomb = d.prepare(
      "SELECT task_id, deleted_reason, content FROM wa_memories WHERE memory_type = 'deleted' ORDER BY id",
    ).all() as Array<{ task_id: string | null; deleted_reason: string; content: string }>;
    eq(tomb.length, 3, 'B-13 ★子树 3 条记忆落墓碑（0→3）');
    ok(tomb.every((m) => m.deleted_reason === '随任务删除'), 'B-14 ★墓碑原因=「随任务删除」');
    ok(tomb.every((m) => m.task_id === null && m.content === ''), 'B-15 ★墓碑已断开父引用且正文回收');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_memories WHERE memory_type != 'deleted' AND task_id IN ('r1','c1','g1')"), 0,
      'B-16 子树活记忆 0 条（3→0）');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_memories WHERE memory_type != 'deleted' AND task_id = 's1c'"), 1,
      'B-17 兄弟活记忆仍在');
  }

  {
    // B-18 子树含执行中成员 ⇒ 整棵拒绝，且一行未删
    const d = fresh();
    mkTask(d, 'r2', '');
    mkTask(d, 'c2', 'r2', 'executing');
    seedLedger(d, 'r2', 'r2');
    seedLedger(d, 'c2', 'c2');
    const r = deleteTaskSubtree(asDb(d), 'r2');
    ok(r.ok === false && r.reason === 'has-unsettled', 'B-18 ★含执行中子任务 ⇒ has-unsettled');
    const blockers = !r.ok && r.reason === 'has-unsettled' ? r.blockers : [];
    eq(blockers.map((b) => [b.id, b.status]), [['c2', 'executing']], 'B-19 ★阻断名单点名执行中的那个，且只点名它');
    eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 2, 'B-20 ★整棵不删（不做半截删除）');
    eq(count(d, 'SELECT COUNT(*) AS c FROM wa_task_conversations'), 2, 'B-21 对话未被提前清掉');
    eq(count(d, 'SELECT COUNT(*) AS c FROM wa_deliverables'), 2, 'B-22 产出物未被提前清掉');
    eq(count(d, "SELECT COUNT(*) AS c FROM wa_memories WHERE memory_type != 'deleted'"), 2, 'B-23 记忆未落墓碑');
  }

  {
    // B-24 孙辈未结束同样阻断（阻断面是整棵，不是只看直接子任务）
    const d = fresh();
    mkTask(d, 'r3', '');
    mkTask(d, 'c3', 'r3');
    mkTask(d, 'g3', 'c3', 'paused');
    const r = deleteTaskSubtree(asDb(d), 'r3');
    ok(r.ok === false && r.reason === 'has-unsettled', 'B-24 ★孙辈未结束也阻断');
    const blockers = !r.ok && r.reason === 'has-unsettled' ? r.blockers : [];
    eq(blockers.map((b) => b.id), ['g3'], 'B-25 阻断名单含孙辈');
  }

  {
    // B-26 归档态可删（问题一的引擎侧证明）
    const d = fresh();
    mkTask(d, 'ar', '', 'archived');
    mkTask(d, 'ac', 'ar', 'archived');
    const r = deleteTaskSubtree(asDb(d), 'ar');
    ok(r.ok === true && r.deletedIds.length === 2, 'B-26 ★归档父 + 归档子整棵可删（后端本就不拦终态）');
    eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 0, 'B-27 删净');
  }

  {
    // B-28 不存在的 id
    const d = fresh();
    const r = deleteTaskSubtree(asDb(d), 'nope');
    ok(r.ok === false && r.reason === 'not-found', 'B-28 不存在 id ⇒ not-found');
  }

  {
    // B-29 环保护：parent 互指时不转死
    const d = fresh();
    mkTask(d, 'x', 'y');
    mkTask(d, 'y', 'x');
    const sub = collectTaskSubtree(asDb(d), 'x');
    eq(sub.map((t) => t.id).sort(), ['x', 'y'], 'B-29 ★相互成环时子树收敛为两行（UNION 去重兼作环保护）');
    const r = deleteTaskSubtree(asDb(d), 'x');
    ok(r.ok === true && r.deletedIds.length === 2, 'B-30 环内终态任务仍可整棵删除');
    eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 0, 'B-31 环内两行删净');
  }

  // ═══ C｜接线（一处真源）═══════════════════════════════════════════════════════════════════
  console.log('\n【C】M2 接线：IPC 事务 + 唯一删除真源');
  {
    const ipc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    const del = CODE(`${A}/src/main/core/task-delete.ts`);
    ok(ipc.includes("import { deleteTaskSubtree } from '../core/task-delete.js';"), 'C-1 IPC 导入删除真源');
    ok(ipc.includes('db.transaction(() => deleteTaskSubtree(db, id))()'), 'C-2 ★task:delete 在事务内调用子树删除');
    ok(!ipc.includes('DELETE FROM wa_tasks'), 'C-3 ★IPC 不再自写任务行删除（真源只有 task-delete.ts）');
    eq(del.split('DELETE FROM wa_tasks WHERE id = ?').length - 1, 1, 'C-4 任务行删除语句在真源中恰一处');
    ok(ipc.includes("code: 'NOT_FOUND'") && ipc.includes("code: 'INVALID_STATUS'"),
      'C-5 两种拒绝各自有明确 code');
    ok(ipc.includes('尚未结束，无法删除') && ipc.includes('请先中止或归档它们'),
      'C-6 ★阻断消息点名未结束任务并给出处置办法');
    ok(ipc.includes('deletedIds: result.deletedIds'), 'C-7 返回实际删净的 id 清单');
    const rIpc = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(rIpc.includes('deletedIds?: string[]'), 'C-8 renderer 类型与返回同形');
  }

  // ═══ G｜构建钉（P1–P6）═══════════════════════════════════════════════════════════════════
  console.log('\n【G】M3 构建钉（P1–P6）');
  {
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }

  // ═══ S｜自指（G-6 派生核对）═══════════════════════════════════════════════════════════════
  console.log('\n【S】自指');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S-1 本文件零 build 轮次字面量（不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-2 ★方向性自指：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S-3 本套件在册（脚本名由载体派生）');
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行通过假象。
try {
  main();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
} catch (e: unknown) {
  console.error(`\n💥 ${SELF_ROUND} 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ ${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
}
