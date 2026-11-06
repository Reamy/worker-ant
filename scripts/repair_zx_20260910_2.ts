/**
 * zx_20260910_2 M3 一次性数据修复（**默认 dry-run**，`--apply` 才写库）。
 *
 * 修的是「任务记账失真」的存量后果（证据见 data/baseline_zx_20260910_2.json）：
 *   步0 备份（VACUUM INTO 一致性快照，含 WAL 内容）→ data/worker-ant-server.db.bak_zx_20260910_2
 *   步1 删重复板：实施锚父自建的第二块方案里程碑板（E8：两块各 9 行全 pending）
 *   步2 权威板 baeecc86 的 M0–M8 → done + implemented_by=锚父（D1：实施者是真干活的锚父）
 *   步3 5 个子任务补发 task.status_changed(completed)（E1：被 update_task_status 静默置终态，零事件）
 *   步4 父任务 paused → completed + 补发事件 + ctx.manual_close_reason（D4；E5 证明门禁为伪判）
 *   步5 孤儿作业 3ca06c5c → done/superseded_by_terminal（E10；与 task-scheduler 启动收口同形）
 *   步6 复跑不变量 task-completion-audit：违规数必须归零（用与生产**完全相同**的谓词）
 *
 * ⚠ 全程单事务；备份在事务外先行（VACUUM 不能入事务）。任一断言不成立即整体回滚。
 * ⚠ 桌面端在跑时会持有内存态（调度器/事件总线），故 --apply 前自检 Electron 进程，
 *   命中即拒绝执行（与 run.sh 自检拒跑同旨）——退出桌面端后重试，或确知风险时 --force。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data/worker-ant-server.db');
const BAK_PATH = path.join(ROOT, 'data/worker-ant-server.db.bak_zx_20260910_2');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

const IMPL = 'aac427c2-b8aa-4d5b-9ea8-1be886d2c929';   // 20260910方案实施（实施锚父）
const PLAN = 'baeecc86-87cb-45ac-9663-2f77ac658fe9';   // 20260910功能优化规划（权威方案板）
const ORPHAN_JOB = '3ca06c5c-121b-4d58-9e73-c36a9a935ec7';
const SOURCE = 'zx_20260910_2 记账修复';
const EXPECTED_MILESTONES = Array.from({ length: 9 }, (_, i) => `M${i}`);

/** 与 architectural-invariants.ts:227 完全同谓词——completed 任务必须有 task.completed|task.status_changed 事件 */
const VIOLATION_SQL =
  "SELECT id, title FROM wa_tasks WHERE status = 'completed' AND id NOT IN (SELECT DISTINCT aggregate_id FROM wa_event_log WHERE event_type IN ('task.completed','task.status_changed'))";

function die(msg: string): never { console.error(`\n✗ ${msg}`); process.exit(1); }
function step(n: number, title: string) { console.log(`\n── 步${n} ${title}`); }

function electronRunning(): boolean {
  try {
    const out = execFileSync('pgrep', ['-f', 'worker-ant-desktop.*electron'], { encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch { return false; }  // pgrep 无匹配时退出码 1
}

const hasTime = (s: string | null | undefined) => typeof s === 'string' && s.length > 0;

// ── 备份（含 WAL 的一致性快照）────────────────────────────────
function backup(): void {
  step(0, '备份');
  if (fs.existsSync(BAK_PATH)) {
    if (!FORCE) die(`备份已存在，拒绝覆盖：${path.relative(ROOT, BAK_PATH)}\n  确认无需保留后手动移走，或加 --force。`);
    console.log(`  ! 备份已存在，--force 覆盖：${path.relative(ROOT, BAK_PATH)}`);
  }
  const bak = new DatabaseSync(DB_PATH);
  try {
    // VACUUM INTO 产出与源库一致的快照（会把 WAL 中未 checkpoint 的内容一并落盘）
    bak.exec(`VACUUM INTO '${BAK_PATH.replace(/'/g, "''")}'`);
  } finally { bak.close(); }
  const size = fs.statSync(BAK_PATH).size;
  console.log(`  ✓ ${path.relative(ROOT, BAK_PATH)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// ── 勘察（dry-run 与 apply 共用的写前读数）────────────────────
interface Survey {
  implBoard: Array<{ milestone: string; status: string }>;
  planBoard: Array<{ milestone: string; status: string; implemented_by_task_id: string | null }>;
  children: Array<{ id: string; title: string; status: string; version: number }>;
  parent: { status: string; version: number } | undefined;
  parentCtx: Record<string, unknown>;
  job: { status: string } | undefined;
  violations: Array<{ id: string; title: string }>;
}

function survey(db: any): Survey {
  return {
    implBoard: db.prepare('SELECT milestone, status FROM wa_plan_milestones WHERE plan_task_id = ? ORDER BY milestone').all(IMPL) as any,
    planBoard: db.prepare('SELECT milestone, status, implemented_by_task_id FROM wa_plan_milestones WHERE plan_task_id = ? ORDER BY milestone').all(PLAN) as any,
    children: db.prepare('SELECT id, title, status, aggregate_version AS version FROM wa_tasks WHERE parent_task_id = ? ORDER BY title').all(IMPL) as any,
    parent: db.prepare('SELECT status, aggregate_version AS version FROM wa_tasks WHERE id = ?').get(IMPL) as any,
    parentCtx: JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(IMPL) as any)?.context_json || '{}'),
    job: db.prepare('SELECT status FROM wa_jobs WHERE id = ?').get(ORPHAN_JOB) as any,
    violations: db.prepare(VIOLATION_SQL).all() as any,
  };
}

/** 写前校验：任何一条不成立说明库已非基线态，拒绝继续（避免在漂移过的库上盲改） */
function preflight(s: Survey): void {
  const errs: string[] = [];
  if (s.implBoard.length !== 9) errs.push(`实施锚父板应为 9 行，实为 ${s.implBoard.length}`);
  if (s.planBoard.length !== 9) errs.push(`方案板应为 9 行，实为 ${s.planBoard.length}`);
  const planMs = s.planBoard.map(r => r.milestone).join(',');
  if (planMs !== EXPECTED_MILESTONES.join(',')) errs.push(`方案板里程碑应为 M0..M8，实为 [${planMs}]`);
  // 快照该锚父板确实是一块"全 pending 空壳"——否则删除会丢真实进度
  const implNonPending = s.implBoard.filter((r: any) => (r as any).status !== 'pending').length;
  if (implNonPending > 0) errs.push(`锚父板含 ${implNonPending} 行非 pending，疑似已有真实进度 ⇒ 拒删（请人工判断）`);
  if (!s.parent) errs.push('父任务不存在');
  else if (s.parent.status !== 'paused') errs.push(`父任务当前应 paused，实为 ${s.parent.status}`);
  if (s.children.length !== 5) errs.push(`子任务应为 5 个，实为 ${s.children.length}`);
  const childNotDone = s.children.filter(c => c.status !== 'completed').length;
  if (childNotDone > 0) errs.push(`${childNotDone} 个子任务非 completed，与基线不符`);
  if (!s.job) errs.push('孤儿作业不存在');
  else if (s.job.status !== 'pending') errs.push(`孤儿作业当前应 pending，实为 ${s.job.status}`);
  if (errs.length) die('写前校验未通过，库已偏离基线，拒绝执行：\n  - ' + errs.join('\n  - '));
}

function report(s: Survey, tag: string): void {
  console.log(`  [${tag}] 实施锚父板行数=${s.implBoard.length}（待删）；方案板=${s.planBoard.length} 行、`
    + `pending=${s.planBoard.filter(r => r.status !== 'done').length}；子任务=${s.children.length} 个；`
    + `父=${s.parent?.status}；孤儿作业=${s.job?.status}；当前不变量违规=${s.violations.length}`);
}

// ── 主流程 ───────────────────────────────────────────────────
console.log(`zx_20260910_2 M3 数据修复 — ${APPLY ? 'APPLY（写库）' : 'DRY-RUN（只读）'}`);
console.log(`  库: ${path.relative(ROOT, DB_PATH)}`);

if (!APPLY) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const s = survey(db);

  step(0, '备份'); console.log(`  (dry-run 跳过) 将写 ${path.relative(ROOT, BAK_PATH)}${fs.existsSync(BAK_PATH) ? ' —— 已存在，apply 时会拒绝覆盖' : ''}`);
  step(1, '删重复板'); preflight(s);
  console.log(`  将删除 wa_plan_milestones 中 plan_task_id=${IMPL} 的 ${s.implBoard.length} 行（${s.implBoard.map(r => r.milestone).join('/')}）`);
  step(2, '权威板落 done');
  console.log(`  将把 plan_task_id=${PLAN} 的 ${s.planBoard.length} 行置 status=done, implemented_by=${IMPL}`);
  console.log(`  当前 implemented_by 分布: ${JSON.stringify(s.planBoard.map(r => r.implemented_by_task_id))}`);
  step(3, '子任务补发事件');
  for (const c of s.children) console.log(`  ${c.id}  ${c.title}  status=${c.status}  aggver=${c.version} → 补发 task.status_changed(completed) @v${c.version + 1}`);
  step(4, '父任务收口');
  console.log(`  ${IMPL}  status=${s.parent?.status} aggver=${s.parent?.version} → completed @v${(s.parent?.version ?? 0) + 1}`);
  console.log(`  ctx.manual_close_reason = ${JSON.stringify(SOURCE)}（原有键 ${Object.keys(s.parentCtx).length} 个，追加不改写）`);
  step(5, '孤儿作业');
  console.log(`  ${ORPHAN_JOB} status=${s.job?.status} → done, error=superseded_by_terminal`);
  step(6, '不变量复跑');
  console.log(`  修复前 task-completion-audit 违规 ${s.violations.length} 例: ${s.violations.map(v => v.title).join(' / ') || '（无）'}`);
  console.log('  修复后预期 = 0（5 子任务 + 父各补一条 task.status_changed）');

  console.log('\nDRY-RUN 结束（未写任何数据）。加 --apply 执行。');
  console.log(JSON.stringify({ dryRun: true, ...reportSummary(s) }));
  db.close();
  process.exit(0);
}

// ── APPLY ────────────────────────────────────────────────────
if (electronRunning() && !FORCE) {
  die('检测到桌面端 Electron 进程在运行。它在内存里持有调度器/事件总线状态，'
    + '离线改库会造成内存态与真源不一致。请退出桌面端后重试；确知风险时加 --force。');
}

backup();

const db = new DatabaseSync(DB_PATH);
let before: Survey;
try {
  before = survey(db);
  preflight(before);
  report(before, '修复前');
} catch (e) { db.close(); throw e; }

const nowIso = new Date().toISOString();
const insEvent = db.prepare(
  'INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, metadata, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const bumpVersion = db.prepare('UPDATE wa_tasks SET aggregate_version = ? WHERE id = ?');

const summary = { deletedBoardRows: 0, milestonesDone: 0, childEvents: 0, parentFinalized: false, jobClosed: false, violationsAfter: -1 };

db.exec('BEGIN');
try {
  // 步1：删重复板（锚父自建的第二块空板；preflight 已确认其全 pending）
  step(1, '删重复板');
  const del = db.prepare('DELETE FROM wa_plan_milestones WHERE plan_task_id = ?').run(IMPL);
  summary.deletedBoardRows = del.changes ?? 0;
  console.log(`  ✓ 删除 ${summary.deletedBoardRows} 行`);

  // 步2：权威板 M0–M8 落 done + implemented_by=锚父
  step(2, '权威板落 done');
  const upd = db.prepare(
    "UPDATE wa_plan_milestones SET status = 'done', implemented_by_task_id = ?, updated_at = datetime('now') WHERE plan_task_id = ? AND status != 'done'",
  ).run(IMPL, PLAN);
  summary.milestonesDone = upd.changes ?? 0;
  console.log(`  ✓ ${summary.milestonesDone} 行置 done，implemented_by=${IMPL}`);

  // 步3：子任务补发完成事件（每个 aggregate 的首条事件 ⇒ aggver 1）
  step(3, '子任务补发事件');
  for (const c of before.children) {
    const v = (c.version ?? 0) + 1;
    insEvent.run(
      crypto.randomUUID(), 'task.status_changed', 'task', c.id, v,
      JSON.stringify({ taskId: c.id, task_id: c.id, projectId: before.parentCtx?.project_id ?? null, newStatus: 'completed', new_status: 'completed' }),
      JSON.stringify({ source: SOURCE }), nowIso, nowIso.slice(0, 19).replace('T', ' '),
    );
    bumpVersion.run(v, c.id);
    summary.childEvents++;
  }
  console.log(`  ✓ 补发 ${summary.childEvents} 条 task.status_changed(completed)`);

  // 步4：父任务收口为 completed（最后一条事件 ⇒ 投影回放亦得 completed）
  step(4, '父任务收口');
  const pv = (before.parent?.version ?? 0) + 1;
  const projId = (db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(IMPL) as any)?.project_id ?? null;
  const ctx = { ...before.parentCtx, manual_close_reason: SOURCE };
  db.prepare("UPDATE wa_tasks SET status = 'completed', context_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(ctx), IMPL);
  insEvent.run(
    crypto.randomUUID(), 'task.status_changed', 'task', IMPL, pv,
    JSON.stringify({ taskId: IMPL, task_id: IMPL, projectId: projId, newStatus: 'completed', new_status: 'completed' }),
    JSON.stringify({ source: SOURCE }), nowIso, nowIso.slice(0, 19).replace('T', ' '),
  );
  bumpVersion.run(pv, IMPL);
  summary.parentFinalized = true;
  console.log(`  ✓ paused → completed @v${pv}，ctx.manual_close_reason 已记`);

  // 步5：孤儿作业收口
  step(5, '孤儿作业');
  const jr = db.prepare("UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = 'superseded_by_terminal' WHERE id = ? AND status = 'pending'").run(ORPHAN_JOB);
  summary.jobClosed = (jr.changes ?? 0) > 0;
  console.log(`  ✓ ${summary.jobClosed ? '已收口' : '无需处理（非 pending）'}`);

  // 步6：不变量复跑
  step(6, '不变量复跑');
  const after = survey(db);
  summary.violationsAfter = after.violations.length;
  if (after.violations.length > 0) {
    throw new Error(`task-completion-audit 仍有 ${after.violations.length} 例违规: ${after.violations.map(v => v.title).join(' / ')}`);
  }
  console.log('  ✓ task-completion-audit 违规数 = 0');

  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  db.close();
  die(`执行失败已整体回滚：${(e as Error).message}`);
}

report(survey(db), '修复后');
db.close();
console.log('\nAPPLY 完成。');
console.log(JSON.stringify({ apply: true, ...summary, backup: path.relative(ROOT, BAK_PATH) }));

function reportSummary(s: Survey) {
  return {
    implBoardRows: s.implBoard.length, planBoardRows: s.planBoard.length,
    children: s.children.length, parentStatus: s.parent?.status,
    orphanJob: s.job?.status, violationsBefore: s.violations.length,
  };
}
