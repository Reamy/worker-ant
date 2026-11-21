/**
 * zx_20261118_2 M3「名」一次性存量清理（**默认 dry-run**，`--apply` 才写库）。
 *
 * 病根（方案 §0.2 S2）：`write_file`/`edit_file` 的自动登记此前**不判根**，`/tmp/commit-msg-*.txt`、
 *   `/tmp/wa-*.py` 这类一次性临时件被写成 `wa_deliverables` 行（怡寿里项目 29 条，其中 3 条还是
 *   `is_primary=1` 的主成果）。代码侧围栏已由本轮补上（`core/tools/write.ts` 的 `isInsideAnyRoot`），
 *   本脚本只处理**已经落库的**存量脏行。
 *
 * 进清单须**同时**满足两条（缺一不删）：
 *   ① `file_path` 不在该项目的任何根内（根 = 项目 `working_dir` + 数据目录；真实路径语义同写侧）；
 *   ② 盘上文件**已不存在**。
 * 只满足①（根外但文件仍在）的**不删**：那可能是用户手工移走的成果，删不删得人来定。
 *
 * 删除动作与 GUI `deliverable:delete` 同形：先经既有状态写口 `setDeliverableStatus(...,'deleted')`
 *   发 `deliverable.status_changed`，再删 `wa_deliverable_versions` 与该行，并落一条
 *   `wa_audit_events`（`recordAudit`，动作 `deliverable.cleanup_foreign`）。全程单行事务——
 *   "状态已 deleted 但行还在"是清单里看得见的假结果，不能留。
 *
 * 用法（桌面包的 tsx，可跑 .ts 入口；仓根 `npx tsx` 不存在）：
 *   apps/worker-ant-desktop/node_modules/.bin/tsx scripts/cleanup-foreign-deliverables.ts
 *   apps/worker-ant-desktop/node_modules/.bin/tsx scripts/cleanup-foreign-deliverables.ts --apply
 *   可加 `--db <path>` / `--data-dir <path>`；桌面端正在跑时 `--apply` 拒绝写库（`--force` 强写）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
// 只引零依赖的判据模块：dry-run 不加载 pino（`deliverable-lifecycle` → `event-bus` → `logger`），
//   否则"只读清单"也会在盘上起日志目录——与"默认 dry-run"的承诺不符。
import { isInsideAnyRoot } from '../apps/worker-ant-desktop/src/main/core/path-fence.js';
import { realOrResolved } from '../apps/worker-ant-desktop/src/main/core/real-path.js';

const ROOT = path.join(__dirname, '..');
const VIA = 'cleanup_foreign_deliverables';

interface Args {
  dbPath: string;
  dataDir: string;
  apply: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  let dbPath = path.join(ROOT, 'data', 'worker-ant-server.db');
  let apply = false;
  let force = false;
  let dataDir = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') apply = true;
    else if (a === '--force') force = true;
    else if (a === '--db') dbPath = path.resolve(ROOT, argv[++i] ?? dbPath);
    else if (a === '--data-dir') dataDir = path.resolve(ROOT, argv[++i] ?? '');
  }
  // 数据目录缺省 = 库所在的目录（dev 下即仓库 `data/`；单机脚本按"库与数据同处"取，不猜 userData）。
  if (!dataDir) dataDir = path.dirname(dbPath);
  return { dbPath, dataDir, apply, force };
}

function die(msg: string): never {
  console.error(`\nERROR ${msg}`);
  process.exit(1);
}

function electronRunning(): boolean {
  try { return execFileSync('pgrep', ['-f', 'worker-ant-desktop'], { encoding: 'utf-8' }).trim().length > 0; }
  catch { return false; } // pgrep 无匹配时退出码 1
}

type Skip = 'in_root' | 'file_exists' | 'non_absolute';

interface Row {
  id: string;
  project_id: string | null;
  task_id: string | null;
  name: string | null;
  file_path: string;
  status: string;
}

interface Candidate extends Row {
  projectWd: string;
}

interface Tally {
  candidates: Candidate[];
  skip: Record<Skip, number>;
  scanned: number;
}

/** 判一条行是否进清单。判根走 `path-fence` 的同一口径；真实路径取 `real-path` 的同一语义。 */
function classify(row: Row, projectWd: string, dataDir: string): Skip | 'candidate' {
  const raw = String(row.file_path ?? '').trim();
  if (!path.isAbsolute(raw)) return 'non_absolute';
  const roots = [projectWd, dataDir]
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map(realOrResolved);
  if (roots.length > 0 && isInsideAnyRoot(realOrResolved(raw), roots)) return 'in_root';
  return fs.existsSync(raw) ? 'file_exists' : 'candidate';
}

function scan(db: DatabaseSync, dataDir: string): Tally {
  const projectWd = new Map<string, string>();
  for (const p of db.prepare("SELECT id, COALESCE(working_dir, '') AS working_dir FROM wa_projects").all() as Array<{ id: string; working_dir: string }>) {
    projectWd.set(String(p.id), String(p.working_dir ?? '').trim());
  }
  const rows = db.prepare(
    "SELECT id, project_id, task_id, name, file_path, status FROM wa_deliverables WHERE COALESCE(file_path, '') <> '' ORDER BY project_id, file_path",
  ).all() as unknown as Row[];

  const tally: Tally = { candidates: [], skip: { in_root: 0, file_exists: 0, non_absolute: 0 }, scanned: rows.length };
  for (const row of rows) {
    const wd = row.project_id ? projectWd.get(String(row.project_id)) ?? '' : '';
    const cls = classify(row, wd, dataDir);
    if (cls === 'candidate') tally.candidates.push({ ...row, projectWd: wd });
    else tally.skip[cls]++;
  }
  return tally;
}

function printCandidates(tally: Tally, mode: string, dbPath: string, dataDir: string): void {
  console.log(`[cleanup-foreign-deliverables] db=${dbPath}`);
  console.log(`[cleanup-foreign-deliverables] dataDir=${dataDir}`);
  console.log(`[cleanup-foreign-deliverables] mode=${mode}  扫描成果行 ${tally.scanned} 条`);
  console.log(`\n候选（根外 ∧ 文件已不存在）：${tally.candidates.length} 条`);
  tally.candidates.forEach((c, i) => {
    console.log(`  #${i + 1} ${c.id}`);
    console.log(`      file_path: ${c.file_path}`);
    console.log(`      project:   ${c.project_id ?? '(无项目)'}${c.projectWd ? `  working_dir=${c.projectWd}` : ''}`);
    console.log(`      task:      ${c.task_id ?? '(无任务)'}  status=${c.status}  name=${c.name ?? ''}`);
  });
  console.log(`\n跳过：根内 ${tally.skip.in_root} 条；根外但文件仍存在 ${tally.skip.file_exists} 条；非绝对路径 ${tally.skip.non_absolute} 条`);
  console.log(`合计：候选 ${tally.candidates.length} / 扫描 ${tally.scanned}`);
}

async function apply(db: DatabaseSync, tally: Tally): Promise<void> {
  // 写口与审计账都是既有真源，apply 时才加载（dry-run 不碰 pino / 不建日志目录）。
  const { setDeliverableStatus } = await import('../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js');
  const { recordAudit } = await import('../apps/worker-ant-desktop/src/main/core/audit-log.js');
  type AnyDb = Parameters<typeof setDeliverableStatus>[0];
  type AuditDb = Parameters<typeof recordAudit>[0];
  const wired = db as unknown as AnyDb & AuditDb;

  let deleted = 0;
  for (const c of tally.candidates) {
    db.exec('BEGIN');
    try {
      // 先发事件、后删行：删完再取行就只剩一句"不知道原来是什么"（与 GUI `deliverable:delete` 同序）。
      setDeliverableStatus(wired, c.id, 'deleted', VIA);
      db.prepare('DELETE FROM wa_deliverable_versions WHERE deliverable_id = ?').run(c.id);
      db.prepare('DELETE FROM wa_deliverables WHERE id = ?').run(c.id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败时保留原始错误 */ }
      die(`删除 ${c.id} 失败（已回滚）：${(e as Error).message}`);
    }
    // 审计行在提交之后写：`recordAudit` 永不抛，写失败只留 warn，不让旁账改变"已删除"的结局。
    recordAudit(wired, {
      actorKind: 'system',
      action: 'deliverable.cleanup_foreign',
      targetType: 'deliverable',
      targetId: c.id,
      detail: {
        file_path: c.file_path,
        project_id: c.project_id,
        task_id: c.task_id,
        name: c.name,
        old_status: c.status,
        reason: 'out_of_root_and_missing',
      },
    });
    deleted++;
    console.log(`  DELETED ${c.id}  ${c.file_path}`);
  }
  console.log(`\n已删除 ${deleted} 条；审计动作 ${'deliverable.cleanup_foreign'}（wa_audit_events）`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dbPath)) die(`库不存在：${args.dbPath}`);
  if (args.apply && electronRunning() && !args.force) {
    die('桌面端正在运行（内存态与库会分叉）——请先退出桌面端；确需强写加 --force');
  }

  const db = new DatabaseSync(args.dbPath);
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本不支持则维持默认 */ }

  const tally = scan(db, args.dataDir);
  printCandidates(tally, args.apply ? 'APPLY' : 'DRY-RUN', args.dbPath, args.dataDir);

  if (!args.apply) {
    if (tally.candidates.length > 0) {
      console.log('\n(DRY-RUN) 未写库。核对清单确认后加 --apply 执行删除。');
    }
    return;
  }
  if (tally.candidates.length === 0) {
    console.log('\n没有待清理的行（已是干净状态）。');
    return;
  }
  await apply(db, tally);
}

void main();
