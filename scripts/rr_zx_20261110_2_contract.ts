/**
 * zx_20261110_2 B0 契约复跑 —— 「恒」：**先能测，才谈得上修**。
 *
 * 三组判据：
 *   K「构建钉」：`checkBuildPins` P1–P6（真源单一、方案/复跑脚本在册、全量钉子同值、产物同值）；
 *   M「测量口径」：`scripts/measure-exec-health.ts` 在位且**只读**，六本账在夹具上口径正确
 *     （作业账 / 在队账 / 重复账 / 幽灵账 / 验收账 / 事件账），老库缺表不阻断；
 *   W「接线在册」：`core/exec-watchdog.ts` 被 `agent-executor.ts` **真 import 且真调用**
 *     （只建文件不接线 = 全绿而无用，承 auto-memory `feedback_equivalence_needs_wiring_criterion`）。
 *
 * 纪律：
 *   G-1 真源直 import（`measureExecHealth`/`percentile` 走真实现，改签名即编译期红；
 *       文案判据直接读源码，不抄字符串）；
 *   G-2 两只标本（该记的记 / 不该记的不记）；
 *   G-4 计数器断言必有 0→1 正面；
 *   G-6 无轮次字面量（轮次由 `path.basename(__filename)` 派生，只做**方向性**比较）；
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）；
 *   ⚠ 末尾 P6 读 `dist` ⇒ 本脚本须在 `tsup` 之后跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { measureExecHealth, formatLedger, type LedgerRow } from './measure-exec-health.js';

type AnyDb = import('better-sqlite3').Database;

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
/** G-6：轮次标识由**载体自身**派生——本文件不写任何轮次字面量。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

const ledgerOf = (rows: LedgerRow[]): Map<string, LedgerRow> => new Map(rows.map((r) => [r.key, r]));
const countOf = (rows: LedgerRow[], key: string): number => ledgerOf(rows).get(key)?.count ?? -1;

/** 夹具：与生产同形的六张表（只取本脚本触碰到的列）。 */
const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, status TEXT DEFAULT 'pending',
  context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), completed_at TEXT, error TEXT);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, title TEXT DEFAULT '',
  status TEXT DEFAULT 'registered', acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT,
  aggregate_id TEXT, payload TEXT, occurred_at TEXT DEFAULT (datetime('now')));
`;

function mkdb(withSchema = true): AnyDb {
  const d = new DatabaseSync(':memory:');
  if (withSchema) d.exec(SCHEMA);
  return d as unknown as AnyDb;
}

/** 夹具时钟：由夹具自身的时刻派生，不取真实墙钟。 */
const T0 = Date.parse('2026-11-10T06:00:00Z');
const NOW = T0 + 600_000; // 夹具"此刻"＝T0+10min
const utc = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function main(): void {
  // ═══ K｜构建钉 ═══════════════════════════════════════════════════════════
  console.log(`\n【K】构建钉与在册（${SELF_ROUND}）`);
  checkBuildPins(ok, { distDir: path.join(A, 'dist') });

  // ═══ M｜测量口径 ════════════════════════════════════════════════════════
  console.log('\n【M】measure-exec-health：只读、口径正确、老库不阻断');

  // M-0 脚本在位 + 只读（CLI 以 readOnly 打开；全脚本无写库语句）
  {
    const p = 'scripts/measure-exec-health.ts';
    ok(fs.existsSync(path.join(root, p)), `${p} 在场`);
    const code = CODE(p);
    ok(/new DatabaseSync\([^)]*readOnly:\s*true/.test(code), 'M-0a CLI 以 readOnly:true 打开库（不写生产库）');
    const writeHits = [...code.matchAll(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|CREATE\s+TABLE|ALTER\s+TABLE)\b/gi)]
      .map((m) => m[1]);
    ok(writeHits.length === 0, 'M-0b 全脚本无写库语句（测量只读，不建表不迁移）', writeHits.join(','));
    ok(/\-\-json/.test(RD(p)), 'M-0c 支持 --json 出口（机器可读，便于前后对比）');
  }

  // M-1 六本账在夹具上口径正确
  {
    const db = mkdb();
    // 作业账：done 2 / pending 2 / running 1
    const addJob = (id: string, type: string, status: string, taskId: string, createdAt: string): void => {
      db.prepare('INSERT INTO wa_jobs (id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, type, JSON.stringify({ taskId }), status, createdAt);
    };
    addJob('j1', 'ai-task', 'done', 'tA', utc(T0));
    addJob('j2', 'ai-task', 'done', 'tB', utc(T0));
    addJob('j3', 'ai-task', 'running', 'tC', utc(T0));
    // 两条同 (type,taskId) 的 pending ⇒ 重复账 1 组 / 1 条冗余
    addJob('j4', 'resume-ai-task', 'pending', 'tD', utc(NOW - 100_000));
    addJob('j5', 'resume-ai-task', 'pending', 'tD', utc(NOW - 200_000));

    const rows = measureExecHealth(db, NOW);
    eq(countOf(rows, 'jobs.done'), 2, 'M-1a 作业账按 status 分档（done=2）');
    eq(countOf(rows, 'jobs.pending'), 2, 'M-1b 作业账按 status 分档（pending=2）');
    eq(countOf(rows, 'jobs.running'), 1, 'M-1c 作业账按 status 分档（running=1）');
    eq(countOf(rows, 'jobs.total'), 5, 'M-1d 作业账合计与逐档相加一致（无漏档）');

    eq(countOf(rows, 'pending.age_p50'), 150, 'M-1e 在队账 p50＝150s（[100,200] 中点）');
    eq(countOf(rows, 'pending.age_p95'), 195, 'M-1f 在队账 p95＝195s（线性插值）');
    eq(countOf(rows, 'pending.oldest_sec'), 200, 'M-1g 在队账最老一条＝200s');

    eq(countOf(rows, 'pending.dup_groups'), 1, 'M-1h ★重复账：同 (type,taskId) 两条 pending ⇒ 1 组（事故直接因）');
    eq(countOf(rows, 'pending.dup_extra_jobs'), 1, 'M-1i 重复账：多出来 1 条');

    // 幽灵账：tC 处 running 但**有** running 作业 ⇒ 不算幽灵；tE 处 executing 且无作业 ⇒ 算幽灵
    //   ⚠ 产出物要按任务状态分档，故 `tA` 必须真有一行（无行的产出物会落到 `(no_task)` 档）。
    db.prepare("INSERT INTO wa_tasks (id, title, status, updated_at) VALUES ('tA', 'A', 'completed', ?)").run(utc(NOW));
    db.prepare("INSERT INTO wa_tasks (id, title, status, updated_at) VALUES ('tC', 'C', 'executing', ?)").run(utc(NOW - 30_000));
    db.prepare("INSERT INTO wa_tasks (id, title, status, updated_at) VALUES ('tE', 'E', 'executing', ?)").run(utc(NOW - 300_000));
    const rows2 = measureExecHealth(db, NOW);
    eq(countOf(rows2, 'tasks.running_family_no_job'), 1, 'M-1j ★幽灵账：只有"running 族且无在途作业"那条被计入（两侧标本）');
    eq(countOf(rows2, 'tasks.ghost_oldest_sec'), 300, 'M-1k 幽灵账：最老停滞 300s');

    // 验收账
    db.prepare("INSERT INTO wa_deliverables (id, task_id, status, acceptance_verified) VALUES ('d1','tA','completed',1)").run();
    db.prepare("INSERT INTO wa_deliverables (id, task_id, status, acceptance_verified) VALUES ('d2','tA','completed',0)").run();
    const rows3 = measureExecHealth(db, NOW);
    eq(countOf(rows3, 'deliverables.total'), 2, 'M-1l 验收账：总量 2');
    eq(countOf(rows3, 'deliverables.verified'), 1, 'M-1m 验收账：已核 1');
    eq(countOf(rows3, 'deliverables.unverified'), 1, 'M-1n 验收账：未核 1');
    eq(countOf(rows3, 'deliverables.unverified.completed'), 1, 'M-1o 验收账：未核按任务状态分档（completed=1）');

    // 事件账：0 → 1 正面断言
    eq(countOf(rows3, 'exec_events.run.abort_sent'), 0, 'M-1p 事件账：中止发出计数起始为 0');
    db.prepare("INSERT INTO wa_event_log (event_id, event_type) VALUES ('e1','run.abort_sent')").run();
    db.prepare("INSERT INTO wa_event_log (event_id, event_type) VALUES ('e2','run.orphaned')").run();
    const rows4 = measureExecHealth(db, NOW);
    eq(countOf(rows4, 'exec_events.run.abort_sent'), 1, 'M-1q ★事件账：abort_sent 0→1');
    eq(countOf(rows4, 'exec_events.run.orphaned'), 1, 'M-1r ★事件账：orphaned 0→1');
    eq(countOf(rows4, 'exec_events.run.abort_observed'), 0, 'M-1s 事件账：未发生的类型如实记 0（不猜）');

    // 输出形状固定 key|count|note
    const text = formatLedger(rows4);
    ok(text.split('\n').every((l) => l.split('|').length === 3), 'M-1t 输出固定 `key|count|note` 三栏（便于前后对比）',
      text.split('\n').find((l) => l.split('|').length !== 3) ?? '');
  }

  // M-2 老库（无表）不阻断：返回空账，不抛
  {
    const db = mkdb(false);
    let threw = '';
    let rows: LedgerRow[] = [];
    try { rows = measureExecHealth(db, NOW); } catch (e) { threw = String(e); }
    eq(threw, '', 'M-2a 空库（无任何表）不抛错');
    eq(countOf(rows, 'jobs.total'), 0, 'M-2b 空库如实记 0（不编数、不阻断）');
    ok(rows.length > 0, 'M-2c 空库仍出满额账行（缺表＝空账，不是缺行）', `实测 ${rows.length} 行`);
  }

  // ═══ W｜接线在册 ════════════════════════════════════════════════════════
  console.log('\n【W】新模块被真实 import 且真调用');
  {
    const wd = `${A}/src/main/core/exec-watchdog.ts`;
    ok(fs.existsSync(path.join(root, wd)), `${wd} 在场（看门狗状态机）`);
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/from\s+'\.\/exec-watchdog\.js'/.test(ex), 'W-1 exec-watchdog 被 agent-executor 真 import（非只建文件）');
    ok(/watchdogVerdict\s*\(/.test(ex), 'W-2 看门狗裁决被真调用（watchdogVerdict）');
    ok(/noteAbortObserved\s*\(/.test(ex), 'W-3 abort 被观测这笔账有真调用点（noteAbortObserved）');
    ok(/'run\.abort_sent'/.test(ex) && /'run\.abort_observed'/.test(ex),
      'W-4 中止发出/观测两笔事件在执行体里真发（不是只定义了事件名）');
    // 事件总线侧：只加 union 不加聚合映射 ⇒ 一行都不落库（静默）。
    const bus = CODE(`${A}/src/main/core/event-bus.ts`);
    for (const t of ['run.abort_sent', 'run.abort_observed', 'run.orphaned', 'run.watchdog_fired',
      'job.inflight_released', 'job.inflight_requeued', 'job.requeue_exhausted', 'task.released_by_user']) {
      const inUnion = bus.includes(`'${t}'`);
      const inMap = new RegExp(`'${t.replace(/\./g, '\\.')}'\\s*:\\s*\\{`).test(bus);
      ok(inUnion && inMap, `W-5 ${t} 既在 EventType 联合里、也在聚合映射表里（否则 emit 静默不落库）`,
        `union=${inUnion} map=${inMap}`);
    }
    // 调度侧：对账与去重必须被真调用（否则只是一对方法）
    const sch = CODE(`${A}/src/main/core/task-scheduler.ts`);
    ok(/reconcileInflight\(\)/.test(sch), 'W-6 周期对账被真调用（reconcileInflight）');
    ok(/dedupePendingJobs\(\)/.test(sch), 'W-7 启动去重被真调用（dedupePendingJobs）');
    ok(/hasTaskRun\(/.test(sch), 'W-8 `hasTaskRun` 有真调用方（此前零调用方，是"有键无实"的根因）');
    // 复现脚本在位
    ok(fs.existsSync(path.join(root, 'scripts/repro_zx_20261110_2_stall.ts')),
      'W-9 事故复现脚本在场（repro_zx_20261110_2_stall.ts）');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
