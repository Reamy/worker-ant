/**
 * zx_20261110_2 B8 一次性数据修复（**默认 dry-run**，`--apply` 才写库）。
 *
 * 修的是一条**既存**缺陷留下的存量后果（病根与判据见 `plans/improve/zx_20261110_2.md` §9.1 B8 与
 * `scripts/rr_zx_20261110_2_close.ts` §C）：
 *
 *   `finalizeRunClose` 进门即 `isTerminalStatus(...) ⇒ return`——而 `finalize_task` 会先把任务标 completed
 *   并归位成果；同一 run 若在**那之后**再写几个文件，`ensureDocDeliverable` 会把这几行回调成 `draft`。
 *   随后 run_close 见"已终态"直接返回 ⇒ 再没有第二处归位 ⇒ 这几件永久草稿。
 *   代码已修（终态口补一笔 `promoteTaskFileDeliverables(…, 'run_close_terminal')`）；本脚本补**存量**。
 *
 * 判据与动作**同尺不手抄**：候选由生产 `promoteTaskFileDeliverables` 自己判（doc∪code / `draft` /
 *   `docNotProbe` / 非 `deliverable_unfulfilled.forced`），本脚本只负责"把范围交给它"——与
 *   `backfillCompletedTaskDeliverables` 同形，不写第二套谓词。
 *
 * ⚠ 刻意不动的那一件：`…/.probe_retired_20260918/…/backend.log`（手工造的隔离目录里的残留日志）。
 *   "隔离目录里的日志算不算成果"是产品判断，前轮已裁定 doc 行一律不碰；它在 C8 里属「隔离目录遗留」类，
 *   本脚本以"该行 status 逐字不变"作反证标本。
 *
 * ⚠ 全程单事务；`--apply` 前先 `VACUUM INTO` 备份；桌面端在跑时拒绝写库（内存态与库会分叉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  docNotProbe, typeIn, promoteTaskFileDeliverables,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { FILE_DELIVERABLE_TYPES } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';

type AnyDb = import('better-sqlite3').Database;

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data/worker-ant-server.db');
const BAK_PATH = path.join(ROOT, 'data/worker-ant-server.db.bak_zx_20261110_2_B8');
const VIA = 'backfill_late_writes';
const QUARANTINE_MARK = '/.probe_retired_';

const APPLY = process.argv.includes('--apply');

function die(msg: string): never { console.error(`\nERROR ${msg}`); process.exit(1); }
function step(n: number, title: string): void { console.log(`\n-- 步${n} ${title}`); }
function eq(a: unknown, b: unknown, label: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) die(`${label}\n  实际：${JSON.stringify(a)}\n  期望：${JSON.stringify(b)}`);
  console.log(`  OK ${label} — ${JSON.stringify(a)}`);
}

function electronRunning(): boolean {
  try { return execFileSync('pgrep', ['-f', 'worker-ant-desktop'], { encoding: 'utf-8' }).trim().length > 0; }
  catch { return false; }   // pgrep 无匹配时退出码 1
}

interface Cand { id: string; task_id: string; type: string; name: string; file_path: string | null }

function main(): void {
  if (!fs.existsSync(DB_PATH)) die(`库不存在：${DB_PATH}`);
  if (APPLY && electronRunning() && !process.argv.includes('--force')) {
    die('桌面端正在运行（内存态与库会分叉）——请先退出桌面端；确需强写加 --force');
  }

  step(1, '只读取候选（范围 SQL 与生产同尺：doc∪code / draft / 非探针 / 非 forced）');
  const db = new DatabaseSync(DB_PATH, { readOnly: true }) as unknown as AnyDb;
  const ft = typeIn('', FILE_DELIVERABLE_TYPES);
  const cands = db.prepare(
    `SELECT d.id, d.task_id, d.type, d.name, d.file_path FROM wa_deliverables d
       JOIN wa_tasks t ON t.id = d.task_id
      WHERE d.status = 'draft' AND t.status = 'completed' AND ${ft.sql} AND ${docNotProbe('d')}
        AND json_extract(COALESCE(t.context_json, '{}'), '$.deliverable_unfulfilled.forced') IS NOT 1`,
  ).all(...ft.params) as Cand[];
  const quarantine = cands.filter((c) => String(c.file_path ?? '').includes(QUARANTINE_MARK));
  const todo = cands.filter((c) => !String(c.file_path ?? '').includes(QUARANTINE_MARK));
  const byTask = new Map<string, Cand[]>();
  for (const c of todo) { const a = byTask.get(c.task_id) ?? []; a.push(c); byTask.set(c.task_id, a); }
  console.log(`  候选 ${cands.length} 件（其中隔离目录遗留 ${quarantine.length} 件——裁定不碰）`);
  for (const [tid, rows] of byTask) {
    console.log(`  · 任务 ${tid.slice(0, 8)}：${rows.length} 件 —— ${rows.map((r) => `[${r.type}] ${r.name}`).join(' / ')}`);
  }

  step(2, '反证标本：隔离目录遗留件的 status 记下（修复前后须逐字不变）');
  const qBefore = quarantine.map((q) => ({ id: q.id, status: (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(q.id) as { status: string }).status }));
  console.log(`  ${qBefore.length} 件：${qBefore.map((q) => q.status).join(',') || '(无)'}`);
  (db as unknown as { close: () => void }).close();

  if (todo.length === 0) { console.log('\n无事可做（存量已归位）。'); return; }
  if (!APPLY) {
    console.log(`\nDRY-RUN：将提升 ${todo.length} 件（${byTask.size} 个任务）。确认后加 --apply 写库。`);
    return;
  }

  step(3, '备份（VACUUM INTO，事务外）');
  if (fs.existsSync(BAK_PATH)) fs.rmSync(BAK_PATH);
  {
    const ro = new DatabaseSync(DB_PATH, { readOnly: true });
    ro.exec(`VACUUM INTO '${BAK_PATH.replace(/'/g, "''")}'`);
    ro.close();
  }
  console.log(`  ${path.relative(ROOT, BAK_PATH)}（${(fs.statSync(BAK_PATH).size / 1048576).toFixed(1)} MB）`);

  step(4, '提升（生产同一函数、同一判据，只多一个 via 便于倒查）');
  const w = new DatabaseSync(DB_PATH) as unknown as AnyDb;
  let promoted = 0;
  w.exec('BEGIN');
  try {
    for (const tid of byTask.keys()) {
      const r = promoteTaskFileDeliverables(w, tid, VIA);
      if (r.error) throw new Error(`${tid.slice(0, 8)}: ${r.error}`);
      promoted += r.promoted;
      console.log(`  · ${tid.slice(0, 8)} promoted=${r.promoted}${r.skipped ? ` skipped=${r.skipped}` : ''}`);
    }
    w.exec('COMMIT');
  } catch (e) {
    w.exec('ROLLBACK'); die(String((e as Error).message));
  }
  eq(promoted, todo.length, `提升件数与候选一致（${promoted}）`);

  step(5, '自检：目标行全 completed，隔离目录遗留件逐字未动');
  const remaining = w.prepare(
    `SELECT COUNT(*) AS c FROM wa_deliverables d JOIN wa_tasks t ON t.id = d.task_id
      WHERE d.status = 'draft' AND t.status = 'completed' AND ${ft.sql} AND ${docNotProbe('d')}
        AND json_extract(COALESCE(t.context_json, '{}'), '$.deliverable_unfulfilled.forced') IS NOT 1`,
  ).get(...ft.params) as { c: number };
  eq(Number(remaining.c), quarantine.length, '可达集内草稿只剩「隔离目录遗留」那一类');
  for (const q of qBefore) {
    const now = (w.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(q.id) as { status: string }).status;
    eq(now, q.status, `反证标本未动：${q.id.slice(0, 8)}`);
  }
  (w as unknown as { close: () => void }).close();
  console.log(`\n完成：提升 ${promoted} 件。备份在 ${path.relative(ROOT, BAK_PATH)}`);
}

main();
