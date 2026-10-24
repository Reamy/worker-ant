/**
 * zx_20261022_2 受控复跑 —— 「行」：置 running 者真跑、时刻同尺、自愈不瞎、拆解不返工。
 *
 * 分组（与本轮方案 §2 一一对应）：
 *   A 工具置 running 即真入队　B 两种时刻写法同一把尺　C 孤立刻 running 的查找器
 *   D 拆解不返工的回话与提示
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引**生产函数 / 真工具**（被删/改名即编译期失败，不扫字符串冒充）。
 *   · 两侧标本同试；计数器类断言给 0→1 正面值，不以"不抛"代替。
 *   · 断言文案不含失败字形（`pnpm rr:all` 汇总器按字形计数）。
 *   · 不写"只为下一轮"的字面量：build 轮次由 `checkBuildPins` 从真源派生核对。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { findStaleExecutingTasks, EXEC_STALE_MS, EXEC_STALE_STATUSES } from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
import { utcSql } from '../apps/worker-ant-desktop/src/main/core/sql-time.js';
import { findOrphanRunningTasks } from '../apps/worker-ant-desktop/src/main/core/task-running-reconcile.js';
import { buildDecomposePrompt } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { childBreadthRefusalFor, MAX_CHILD_BREADTH } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { dbTimeMs } from '../apps/worker-ant-desktop/src/main/core/memory-decay.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261022-2-'));

/* ── 夹具 schema：逐列照抄 database.ts 中本套件触达的表（不缺列、不放宽 NOT NULL）── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`;

type AnyDb = import('better-sqlite3').Database;
const mkdb = (): AnyDb => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d as unknown as AnyDb;
};
const addTask = (db: AnyDb, id: string, status: string, extra: { parent?: string; depends?: string; updatedAt?: string; title?: string } = {}): void => {
  db.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, depends_on, updated_at) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime(\'now\')))')
    .run(id, 'p', extra.parent ?? '', extra.title ?? `任务${id}`, status, extra.depends ?? '', extra.updatedAt ?? null);
};
const jobCount = (db: AnyDb, taskId: string): number =>
  (db.prepare("SELECT COUNT(*) AS c FROM wa_jobs WHERE type IN ('ai-task','resume-ai-task') AND payload LIKE ?").get(`%"taskId":"${taskId}"%`) as { c: number }).c;

const mkTools = (db: AnyDb, caller = 'caller-task') =>
  buildTools({ db } as never, caller, 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;

// ───────────────────────── A 工具置 running 即真入队（批一）─────────────────────────
async function groupA(): Promise<void> {
  {
    const db = mkdb();
    addTask(db, 't-free', 'pending');
    const events: Array<{ taskId?: string; newStatus?: string }> = [];
    const h = (e: { data: Record<string, unknown> }) => { events.push(e.data as { taskId?: string; newStatus?: string }); };
    eventBus.on('task.status_changed', h);
    const r = JSON.parse(await mkTools(db).update_task_status!.execute({ targetTaskId: 't-free', status: 'running' })) as { status?: string; enqueued?: boolean };
    await new Promise((res) => setTimeout(res, 0));
    eventBus.off('task.status_changed', h);
    const row = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get('t-free') as { status: string };
    const job = db.prepare("SELECT type, payload FROM wa_jobs WHERE type = 'ai-task'").get() as { type: string; payload: string } | undefined;
    eq(row.status, 'running', 'A-1 工具置 running ⇒ 状态行确为 running');
    eq(jobCount(db, 't-free'), 1, 'A-2 ★作业 0→1：不只写状态，真入队 ai-task');
    ok(!!job && JSON.parse(job.payload).source === 'agent_start', 'A-3 载荷 source=agent_start（与启动对账的 periodic/startup 可区分）', job?.payload);
    eq([r.status, r.enqueued], ['running', true], 'A-4 回话如实：status=running 且 enqueued=true');
    eq(events.filter((e) => e.taskId === 't-free' && e.newStatus === 'running').length, 1, 'A-5 status_changed 恰 1 条（界面即时刷新，不重复发）');
  }
  {
    const db = mkdb();
    addTask(db, 'dep', 'pending');
    addTask(db, 'child', 'pending', { depends: 'dep' });
    const r = JSON.parse(await mkTools(db).update_task_status!.execute({ targetTaskId: 'child', status: 'running' })) as { error?: string };
    const row = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get('child') as { status: string };
    eq([row.status, jobCount(db, 'child'), typeof r.error], ['pending', 0, 'string'], 'A-6 前置未满足 ⇒ 拒：状态零变、作业零增（与 GUI/调度器同一把尺）');
  }
  {
    const db = mkdb();
    addTask(db, 'parent', 'executing');
    addTask(db, 'kid', 'pending', { parent: 'parent' });
    const r = JSON.parse(await mkTools(db).update_task_status!.execute({ targetTaskId: 'kid', status: 'running' })) as { error?: string };
    const row = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get('kid') as { status: string };
    eq([row.status, jobCount(db, 'kid'), typeof r.error], ['pending', 0, 'string'], 'A-7 链上父在跑 ⇒ 拒：不抢跑、不双开（真库 M1 的形态不再被放行）');
  }
  {
    const db = mkdb();
    addTask(db, 'p-pend', 'running');
    const events: Array<{ taskId?: string; newStatus?: string }> = [];
    const h = (e: { data: Record<string, unknown> }) => { events.push(e.data as { taskId?: string; newStatus?: string }); };
    eventBus.on('task.status_changed', h);
    await mkTools(db).update_task_status!.execute({ targetTaskId: 'p-pend', status: 'pending' });
    await new Promise((res) => setTimeout(res, 0));
    eventBus.off('task.status_changed', h);
    eq([jobCount(db, 'p-pend'), events.filter((e) => e.taskId === 'p-pend' && e.newStatus === 'pending').length], [0, 1],
      'A-8 pending 路：不建作业（交由调度器扫描），但事件照发（界面不悬空）');
  }
}

// ───────────────────────── B 两种时刻写法同一把尺（批二）─────────────────────────
function groupB(): void {
  eq(utcSql('updated_at'), 'datetime(updated_at)', 'B-1 utcSql 形状：归一列包一层 datetime(...)（一处真源）');
  {
    const db = mkdb();
    const isoOld = new Date(Date.now() - 20 * 60_000).toISOString();
    const spaceOld = isoOld.slice(0, 19).replace('T', ' ');
    const isoNow = new Date().toISOString();
    const spaceNow = isoNow.slice(0, 19).replace('T', ' ');
    addTask(db, 'iso-old', 'executing', { updatedAt: isoOld });
    addTask(db, 'space-old', 'executing', { updatedAt: spaceOld });
    addTask(db, 'iso-now', 'executing', { updatedAt: isoNow });
    addTask(db, 'space-now', 'executing', { updatedAt: spaceNow });
    addTask(db, 'iso-running-old', 'running', { updatedAt: isoOld });

    const hit = findStaleExecutingTasks(db, EXEC_STALE_MS).map((t) => t.id).sort();
    eq(hit, ['iso-old', 'iso-running-old', 'space-old'], 'B-2 ★两种写法 20 分钟前都命中（ISO 行不再被字符串比较漏掉）');
    ok(!hit.includes('iso-now') && !hit.includes('space-now'), 'B-3 反证：两种写法的"此刻"均不命中（不是一概命中）');

    const rawIso = (db.prepare("SELECT COUNT(*) AS c FROM wa_tasks WHERE id = 'iso-old' AND updated_at < datetime('now', ?)").get('-10 minutes') as { c: number }).c;
    const normIso = (db.prepare(`SELECT COUNT(*) AS c FROM wa_tasks WHERE id = 'iso-old' AND ${utcSql('updated_at')} < datetime('now', ?)`).get('-10 minutes') as { c: number }).c;
    eq([rawIso, normIso], [0, 1], 'B-4 红绿对照：裸字符串比较对 ISO 行判 0，归一后判 1——病根与治法同一处可见');
    eq(EXEC_STALE_STATUSES.includes('running'), true, 'B-5 判据覆盖 running（真库僵尸正是这个态）');
  }
  {
    const iso = '2026-10-22T05:37:42.109Z';
    const space = '2026-10-22 05:37:42';
    const a = dbTimeMs(iso);
    const b = dbTimeMs(space);
    ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1000,
      'B-6 计划超时读刻：ISO 与空格两种写法都解得出、且同刻（旧写法 new Date(iso+\'Z\') 为 Invalid Date）');
    ok(Number.isNaN(dbTimeMs('')) && Number.isNaN(dbTimeMs(null)), 'B-7 无时刻 ⇒ NaN（判不了就不暂停，不凭猜处置）');
  }
}

// ───────────────────────── C 孤立刻 running 的查找器（批三）─────────────────────────
function groupC(): void {
  {
    const db = mkdb();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const oldSpace = old.slice(0, 19).replace('T', ' ');
    addTask(db, 'orphan-iso', 'running', { updatedAt: old });
    addTask(db, 'orphan-space', 'running', { updatedAt: oldSpace });
    addTask(db, 'has-job', 'running', { updatedAt: old });
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status, created_at) VALUES (?, 'ai-task', ?, 'pending', datetime('now'))")
      .run(crypto.randomUUID(), JSON.stringify({ taskId: 'has-job' }));
    addTask(db, 'executing-old', 'executing', { updatedAt: old });
    addTask(db, 'fresh-running', 'running', { updatedAt: new Date().toISOString() });

    eq(findOrphanRunningTasks(db, 2).map((t) => t.id).sort(), ['orphan-iso', 'orphan-space'],
      'C-1 ★只找到"无执行作业 ∧ 已过宽限窗"的 running（两种时刻写法都认）');
    const zero = findOrphanRunningTasks(db, 0).map((t) => t.id).sort();
    ok(zero.includes('fresh-running') && zero.includes('orphan-iso'), 'C-2 启动路宽限 0 ⇒ 刚置 running 的也救（进程刚起，时间不是判据）');
    ok(!zero.includes('has-job') && !zero.includes('executing-old'), 'C-3 反证：有在途作业者不重排；executing 是执行体已认领的态，绝不碰（防双跑）');
  }
}

// ───────────────────────── D 拆解不返工（批四）─────────────────────────
async function groupD(): Promise<void> {
  const prompt = buildDecomposePrompt('把方案拆成里程碑');
  ok(prompt.includes('可判定') && prompt.includes('可机检') && prompt.includes('改哪些文件/端点'),
    'D-1 拆解提示词要求 description/acceptance **可判定**（不再只说"包含具体执行内容"）');
  ok(prompt.includes('禁止"完成即可"这类空话') && prompt.includes('10字以内'), 'D-2 空话被点名禁止，标题仍 ≤10 字（界面上限不变）');
  const refusal = childBreadthRefusalFor(MAX_CHILD_BREADTH);
  ok(refusal.includes('不得为绕过槽位而省略 depends_on') && refusal.includes('并行抢跑'),
    'D-3 槽位拒因补上"不得为绕槽位省略 depends_on"（与①②③并列，不改闸、不改数）');

  {
    const db = mkdb();
    db.prepare('INSERT INTO wa_projects (id, name, working_dir) VALUES (?, ?, ?)').run('p', '项目', tmpdir);
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
      .run('plan-parent', 'p', '父任务', 'executing', '{}');

    const SCRIPT = JSON.stringify([
      { title: '一契约', description: '改 src/a.ts 的 A 端点，产出 dist/a.js；完成证据：文件存在且含 export', acceptance_criteria: '文件存在且含 export', purpose: '服务于父目标的契约面' },
      { title: '二实现', description: '依赖契约后实现 B，产出 src/b.ts；完成证据：typecheck 通过', acceptance_criteria: 'typecheck 通过', dependsOn: [1], purpose: '服务于父目标的实现面' },
    ]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: SCRIPT } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    let resp: { instruction?: string; autoDecomposed?: { created?: number; childIds?: string[] } };
    try {
      const tools = buildTools({
        db,
        getAnsClient: async () => ({ getOptimalModel: async () => ({ url: 'http://stub.local/v1', api_key: 'k', model_name: 'm' }) }),
      } as never, 'plan-parent', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      resp = JSON.parse(await tools.enter_plan_mode!.execute({ goal_summary: '拆成两件' })) as typeof resp;
    } finally {
      globalThis.fetch = realFetch;
    }

    const ids = resp.autoDecomposed?.childIds ?? [];
    const rows = db.prepare('SELECT id, title FROM wa_tasks WHERE parent_task_id = ? ORDER BY priority DESC').all('plan-parent') as Array<{ id: string; title: string }>;
    eq([resp.autoDecomposed?.created, ids.length, rows.length], [2, 2, 2], 'D-4 ★拆解落行 0→2，且回话带出 childIds（此前只报数量）');
    const instruction = String(resp.instruction ?? '');
    ok(ids.length === 2 && ids.every((id) => instruction.includes(id.slice(0, 8))), 'D-5 回话逐个列出子任务 id 前 8 位（模型能**原地**找到它们）');
    ok(rows.every((r) => instruction.includes(r.title)), 'D-6 回话同时列出标题——id 与名字对得上，不是一串裸 id');
    ok(instruction.includes('不要归档后重建') && instruction.includes('send_message_to_task'),
      'D-7 补契约给正路：用 send_message_to_task 追加，**不要归档后重建**');
    ok(instruction.includes('请勿重复创建'), 'D-8 既有子串「请勿重复创建」保留（rr_zx_20260921 C26 不回归）');
  }
}

async function main(): Promise<void> {
  console.log('\n=== zx_20261022_2 A 工具置 running 即真入队 ===');
  await groupA();
  console.log('\n=== zx_20261022_2 B 两种时刻写法同一把尺 ===');
  groupB();
  console.log('\n=== zx_20261022_2 C 孤立刻 running 的查找器 ===');
  groupC();
  console.log('\n=== zx_20261022_2 D 拆解不返工 ===');
  await groupD();

  // build 钉（P1–P6 派生核对；P6 读 dist ⇒ tsup 须先于本套件）。
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

main().then(() => {
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} rr_zx_20261022_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('套件异常：', e);
  console.log(`\nFAIL rr_zx_20261022_2: ${pass} 通过 / ${fail + 1} 失败\n`);
  process.exit(1);
});
