/**
 * zx_20261110_2 B8 复跑 —— 「恒」收口（日志实例分离 + 终态收口不再漏掉成果归位）。
 *
 * 两件事、两套判据：
 *
 * 【L】日志实例分离（§9 G11）
 *   病根：rr 全量与桌面生产共写 `data/logs/worker-ant.<date>.log` ⇒ 一场回归把几百套件的噪声灌进
 *   用户当天的生产日志。判据落在**纯函数** `logFilePrefix()` 上（不再靠读源码里的 IIFE 字符串猜）：
 *   缺省 `worker-ant`、`rr` 原样、**清洗后为空回落缺省**（不造 `.2026-11-11.log` 这种隐身文件）、
 *   路径分隔符不得逃出日志目录；且 `run-rr-all.mjs` 为子进程**真注入** `WA_LOG_FILE_PREFIX=rr`。
 *
 * 【C】终态收口口的**成果归位**（回归实测发现的既存缺陷，见方案 §9.1 B8）
 *   病根：`finalizeRunClose` 一进门即 `isTerminalStatus(statusAtClose) ⇒ return`——而 `finalize_task`
 *   会先把任务标 completed 并归位成果；同一 run 若在**那之后**再写几个文件，`ensureDocDeliverable`
 *   会把这几行的 status 回调成 `draft`。run_close 走到门口见"已终态"直接返回 ⇒ **再没有第二处归位**
 *   ⇒ 这几件永久草稿（真库实测 2026-11-10 四个 ERP 任务、8 件 doc）。
 *   判据（两只标本，答"什么该提升/什么不该"）：
 *     · 终态=`completed` ⇒ 草稿件**真被提升**（0→N 正面断言），探针件**不动**；
 *     · 终态=`archived`/`failed` ⇒ 草稿件**一件不动**（终态不等于"交付"）。
 *   反证：正常收口路仍只有一处 `promoteTaskFileDeliverables(db, taskId, 'run_close')`。
 *
 * 纪律：真源直 import；判据文案不含失败字形；无"只本轮为真"的字面量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { logFilePrefix } from '../apps/worker-ant-desktop/src/main/core/logger.js';
import { finalizeRunClose } from '../apps/worker-ant-desktop/src/main/core/exec-finalize.js';

type AnyDb = import('better-sqlite3').Database;

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string, detail?: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, detail ?? `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

const SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT NOT NULL,
  type TEXT DEFAULT 'doc', description TEXT DEFAULT '', file_path TEXT, is_primary INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft', acceptance_verified INTEGER DEFAULT 0, verified_via TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
`;

function mkdb(): AnyDb {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db as unknown as AnyDb;
}

function addTask(db: AnyDb, id: string, status: string): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'p1', '任务', status, '{}');
}

function addDeliverable(db: AnyDb, id: string, taskId: string, name: string, filePath: string, type = 'doc'): void {
  db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, name, type, file_path, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'p1', taskId, name, type, filePath, 'draft');
}

function statusOf(db: AnyDb, id: string): string {
  return (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(id) as { status: string }).status;
}

/** `finalizeRunClose` 的最小入参——终态早退口只读 db/ctx/taskId/stepCount（其余字段形状齐备即可）。 */
function closeArgs(db: AnyDb, taskId: string): Parameters<typeof finalizeRunClose>[0] {
  return {
    db, ctx: { dataDir: '/tmp/rr-close' } as never, taskId, projectId: 'p1',
    archetype: 'general' as never, adaptiveStrategy: {} as never, fileMutationCount: 0,
    finalContent: '完成', stepCount: 3, qualityScore: { score: 80, feedback: '' },
    closeVerdict: 'not_checked' as never, closeTotal: 0, closeFailedN: 0,
    closeAcceptance: undefined, title: '任务', modelName: 'm', maxSteps: 20,
    totalTokensUsed: 0, toolCallCount: 3, rawCost: 0,
  };
}

async function main(): Promise<void> {
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  // ── L 日志文件名前缀：纯函数，四只标本 ─────────────────────────────
  console.log('\n[L 日志实例分离]');
  {
    // ⚠ 本套件在 `pnpm rr:all` 里跑时，进程**自己**就带着 `WA_LOG_FILE_PREFIX=rr`（B8 给子进程注入的）。
    //   故"未设 ⇒ 缺省"只能靠**显式传 `undefined`** 证，不能靠"读环境"——否则判据读到自己的注入而假红。
    eq(logFilePrefix(undefined), 'worker-ant', 'L-1 未设（显式 undefined）⇒ `worker-ant`（桌面生产行为不变）');
    eq(logFilePrefix(''), 'worker-ant', 'L-2 空串 ⇒ 回落缺省（不造 `.2026-11-11.log` 这种隐身文件）');
    eq(logFilePrefix('   '), 'worker-ant', 'L-3 纯空白 ⇒ 回落缺省');
    eq(logFilePrefix('rr'), 'rr', 'L-4 `rr` 原样（回归写 `rr.<date>.log`，与生产分开）');
    eq(logFilePrefix('../../etc/passwd'), '....etcpasswd', 'L-5 路径被清洗成文件名安全字符（逃不出日志目录）');
    eq(logFilePrefix('a/b\\c d'), 'abcd', 'L-6 分隔符与空白一律剔除');

    const lg = CODE(`${A}/src/main/core/logger.ts`);
    // "不再有第二份清洗逻辑"须按**清洗正则的出现次数**钉（恰 1 份）：只写"不许出现 env+replace"会被
    //   纯函数自己的默认参数（`= process.env.WA_LOG_FILE_PREFIX`）误伤——判据要的是"几份"，不是"哪个近"。
    ok(/const LOG_FILE_PREFIX = logFilePrefix\(process\.env\.WA_LOG_FILE_PREFIX\)/.test(lg)
      && (lg.match(/A-Za-z0-9\._-\]/g) || []).length === 1,
      'L-7 pino 文件目标的前缀由**同一个纯函数**定案（清洗正则全文件恰 1 份）',
      `清洗正则 ${(lg.match(/A-Za-z0-9\._-\]/g) || []).length} 份`);
    ok(/file: path\.join\(getLogDir\(\), LOG_FILE_PREFIX\)/.test(lg), 'L-8 日志目录不变，只换文件名前缀（`getLogDir` 未动）');

    const runner = fs.readFileSync(path.join(root, 'scripts/run-rr-all.mjs'), 'utf-8');
    ok(/WA_LOG_FILE_PREFIX:\s*'rr'/.test(runner), 'L-9 `run-rr-all.mjs` 为子进程**真注入** `WA_LOG_FILE_PREFIX=rr`');
    ok(/\.\.\.process\.env/.test(runner), 'L-10 注入是**覆盖**而非清空环境（其余变量照常继承）');
  }

  // ── C 终态收口口：成果归位 ────────────────────────────────────────
  console.log('\n[C 终态收口不再漏归位]');
  {
    // 标本一：completed ⇒ 草稿件被提升，探针件不动。
    const db = mkdb();
    addTask(db, 'T1', 'completed');
    addDeliverable(db, 'd1', 'T1', 'reports/交付说明', '/w/reports/交付说明.md');
    addDeliverable(db, 'd2', 'T1', 'scripts/verify_erp_family_management_20261110',
      '/w/scripts/verify_erp_family_management_20261110.py');
    addDeliverable(db, 'd3', 'T1', 'scripts/_tmp_probe', '/w/scripts/_tmp_probe.py');
    addDeliverable(db, 'd4', 'T1', 'src/模块', '/w/src/模块.ts', 'code');
    eq([statusOf(db, 'd1'), statusOf(db, 'd2'), statusOf(db, 'd4')], ['draft', 'draft', 'draft'],
      'C-0 前置：三件非探针成果都在草稿（0→N 的起点）');
    const before = { d1: statusOf(db, 'd1'), d2: statusOf(db, 'd2'), d3: statusOf(db, 'd3'), d4: statusOf(db, 'd4') };
    const r1 = finalizeRunClose(closeArgs(db, 'T1'));
    ok(typeof r1.content === 'string' && r1.content.includes('completed'), 'C-1 终态早退口照旧生效（状态不被改写）', r1.content);
    eq([statusOf(db, 'd1'), statusOf(db, 'd2'), statusOf(db, 'd4')], ['completed', 'completed', 'completed'],
      'C-2 终态=`completed` ⇒ 三件草稿成果**真被提升**（正面断言，不是"不抛"）',
      `before=${JSON.stringify(before)}`);
    eq(statusOf(db, 'd3'), 'draft', 'C-3 探针件**不被提升**（判据仍是 docNotProbe 那把尺，没有"顺手全提升"）');

    // 标本二：archived / failed ⇒ 一件都不动（终态不等于交付）。
    for (const [tid, st] of [['T2', 'archived'], ['T3', 'failed']] as const) {
      addTask(db, tid, st);
      addDeliverable(db, `${tid}-d1`, tid, 'reports/交付说明', `/w/${tid}/reports/交付说明.md`);
      const before2 = statusOf(db, `${tid}-d1`);
      const r = finalizeRunClose(closeArgs(db, tid));
      eq(statusOf(db, `${tid}-d1`), before2, `C-4 终态=\`${st}\` ⇒ 草稿成果**一件不动**（不把"归档/失败"当交付）`);
      ok(r.content.includes(st), `C-5 终态=\`${st}\` 的早退回话照旧点名该终态`, r.content);
    }

    // 反证：正常收口路只有一处归位调用，且 via 与终态口不同（两条路可倒查）。
    const fin = CODE(`${A}/src/main/core/exec-finalize.ts`);
    eq((fin.match(/promoteTaskFileDeliverables\(db, taskId,/g) || []).length, 2,
      'C-6 归位调用**恰 2 处**：正常收口一处 + 终态早退口一处（不是"处处补一刀"）');
    ok(/promoteTaskFileDeliverables\(db, taskId, 'run_close'\)/.test(fin), 'C-7 正常收口路的 via 仍是 `run_close`（未改）');
    ok(/promoteTaskFileDeliverables\(db, taskId, 'run_close_terminal'\)/.test(fin),
      'C-8 终态口的 via 是 `run_close_terminal`——两路各留身份，账上可倒查是谁补的位');
    ok(/isTerminalStatus\(statusAtClose\)[\s\S]{0,700}promoteTaskFileDeliverables\(db, taskId, 'run_close_terminal'\)/.test(fin),
      'C-9 终态归位就落在**那个**早退口内（按语句形状钉住，不是"全文有这个词"）');
    ok(/statusAtClose === 'completed'[\s\S]{0,200}promoteTaskFileDeliverables\(db, taskId, 'run_close_terminal'\)/.test(fin),
      'C-10 只有 `completed` 才归位——archived/failed 等终态不得提升成果');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
