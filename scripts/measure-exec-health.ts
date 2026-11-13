/**
 * zx_20261110_2 B0「恒」：执行健康——**只读**测量脚本。
 *
 * 目的：把"卡不卡"从感觉变成可前后对比的账。六本账（输出固定 `key|count|note`）：
 *   1. 作业账      —— `wa_jobs` 按 status；
 *   2. 在队账      —— pending 作业**排队时长**的 p50/p95/max（秒）与最老一条；
 *   3. 重复账      —— 同一 (type, taskId) 的多条 pending（重复入队＝事故 55 分钟在队的直接因）；
 *   4. 幽灵账      —— 处于 running 族（executing/preparing/running）但**无在途执行作业**的任务，及其停滞时长；
 *   5. 验收账      —— `wa_deliverables` 已核 / 未核，按任务状态分档；`verified_via` 覆盖率；
 *   6. 事件账      —— `run.abort_sent` / `run.abort_observed` / `run.orphaned` / `run.watchdog_fired` 计数。
 *
 * 只读：CLI 以 `readOnly: true` 打开生产库；不写任何文件、不建表、不迁移。
 * 每一段都包 try——**老库缺表/缺列一律空账**，测量不得因老库阻断（也不得撒谎说 0）。
 *
 * 用法：
 *   npx tsx scripts/measure-exec-health.ts            # data/worker-ant-server.db
 *   npx tsx scripts/measure-exec-health.ts <db 路径>
 *   npx tsx scripts/measure-exec-health.ts --json     # 同一份 rows 的机器可读出口
 *
 * rr 侧（`rr_zx_20261110_2_contract.ts`）直接调用导出的 `measureExecHealth(db)`，
 * 用内存库夹具验证口径，不碰生产库。
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface LedgerRow {
  key: string;
  count: number;
  note: string;
}

type AnyDb = { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown } };

function safeAll(db: AnyDb, sql: string, ...args: unknown[]): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function safeGet(db: AnyDb, sql: string, ...args: unknown[]): Record<string, unknown> {
  try {
    return (db.prepare(sql).get(...args) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** 分位（线性插值，样本为零返回 0）。纯函数，供 rr 直测。 */
export function percentile(values: readonly number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0]!;
  const pos = (xs.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo]!;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

/** 执行类作业类型（与 `core/task-jobs.ts` 的 `EXEC_JOB_TYPES` 同值：执行作业才代表"有活儿在排"）。 */
const EXEC_JOB_TYPES = ['ai-task', 'resume-ai-task'] as const;
/** running 族状态（与 `self-healing-monitor.ts` 的 `EXEC_STALE_STATUSES` 同族）。 */
const RUNNING_FAMILY = ['executing', 'preparing', 'running'] as const;

/**
 * 产出六本账（纯读取）。缺表/缺列一律返回空账而不抛——测量不得因老库阻断。
 * `nowMs` 可注入（rr 用假时钟）；缺省取真实墙钟。
 */
export function measureExecHealth(db: AnyDb, nowMs: number = Date.now()): LedgerRow[] {
  const out: LedgerRow[] = [];

  // ── 1. 作业账 ────────────────────────────────────────────────────────
  const byStatus = safeAll(db, 'SELECT status, COUNT(*) AS n FROM wa_jobs GROUP BY status ORDER BY status');
  let jobTotal = 0;
  for (const r of byStatus) {
    const n = num(r.n);
    jobTotal += n;
    out.push({ key: `jobs.${String(r.status ?? '(unknown)')}`, count: n, note: '' });
  }
  out.push({ key: 'jobs.total', count: jobTotal, note: `statuses=${byStatus.length}` });

  // ── 2. 在队账（pending 作业年龄，秒）──────────────────────────────────
  {
    const rows = safeAll(db, "SELECT created_at FROM wa_jobs WHERE status = 'pending'");
    const ages: number[] = [];
    for (const r of rows) {
      const ms = utcMs(r.created_at);
      if (ms !== null) ages.push(Math.max(0, Math.round((nowMs - ms) / 1000)));
    }
    const oldest = ages.length ? Math.max(...ages) : 0;
    out.push({
      key: 'pending.age_p50',
      count: Math.round(percentile(ages, 0.5)),
      note: `n=${ages.length}(秒)`,
    });
    out.push({
      key: 'pending.age_p95',
      count: Math.round(percentile(ages, 0.95)),
      note: `n=${ages.length}(秒)`,
    });
    out.push({ key: 'pending.oldest_sec', count: oldest, note: `n=${ages.length}(秒)` });
  }

  // ── 3. 重复账（同一 type+taskId 多条 pending）────────────────────────
  {
    const groups = safeAll(
      db,
      `SELECT type, json_extract(payload, '$.taskId') AS task_id, COUNT(*) AS n
         FROM wa_jobs WHERE status = 'pending'
          AND type IN (${EXEC_JOB_TYPES.map(() => '?').join(',')})
        GROUP BY type, task_id HAVING COUNT(*) > 1`,
      ...EXEC_JOB_TYPES,
    );
    const dupJobs = groups.reduce((s, g) => s + num(g.n) - 1, 0);
    out.push({
      key: 'pending.dup_groups',
      count: groups.length,
      note: `同 (type,taskId) 的 pending 组数`,
    });
    out.push({
      key: 'pending.dup_extra_jobs',
      count: dupJobs,
      note: `多出来的重复作业条数（组数×冗余）`,
    });
  }

  // ── 4. 幽灵账（running 族且无在途执行作业）──────────────────────────
  {
    const rows = safeAll(
      db,
      `SELECT t.id, t.status, t.updated_at
         FROM wa_tasks t
        WHERE t.status IN (${RUNNING_FAMILY.map(() => '?').join(',')})
          AND NOT EXISTS (
            SELECT 1 FROM wa_jobs j
             WHERE j.status IN ('pending','running')
               AND j.type IN (${EXEC_JOB_TYPES.map(() => '?').join(',')})
               AND j.payload LIKE '%"taskId":"' || t.id || '"%'
          )`,
      ...RUNNING_FAMILY,
      ...EXEC_JOB_TYPES,
    );
    let oldestStuck = 0;
    for (const r of rows) {
      const ms = utcMs(r.updated_at);
      if (ms !== null) oldestStuck = Math.max(oldestStuck, Math.round((nowMs - ms) / 1000));
    }
    out.push({
      key: 'tasks.running_family_no_job',
      count: rows.length,
      note: 'running 族但无在途执行作业（幽灵候选）',
    });
    out.push({ key: 'tasks.ghost_oldest_sec', count: oldestStuck, note: `n=${rows.length}(秒)` });
  }

  // ── 5. 验收账 ────────────────────────────────────────────────────────
  {
    const verified = num(safeGet(db, 'SELECT COUNT(*) AS n FROM wa_deliverables WHERE COALESCE(acceptance_verified,0) = 1').n);
    const total = num(safeGet(db, 'SELECT COUNT(*) AS n FROM wa_deliverables').n);
    out.push({ key: 'deliverables.total', count: total, note: '' });
    out.push({ key: 'deliverables.verified', count: verified, note: `占比 ${total > 0 ? `${((verified / total) * 100).toFixed(1)}%` : 'n/a'}` });
    out.push({ key: 'deliverables.unverified', count: Math.max(0, total - verified), note: '' });
    const byStatus = safeAll(
      db,
      `SELECT t.status AS st, COUNT(*) AS n
         FROM wa_deliverables d LEFT JOIN wa_tasks t ON t.id = d.task_id
        WHERE COALESCE(d.acceptance_verified,0) = 0
        GROUP BY t.status ORDER BY t.status`,
    );
    for (const r of byStatus) {
      out.push({ key: `deliverables.unverified.${String(r.st ?? '(no_task)')}`, count: num(r.n), note: '未核产出物按任务状态' });
    }
    // verified_via 覆盖率（zx_20261110_2 B6 新增列；老库缺列 ⇒ 记 0 并说明，不抛）
    const vv = safeGet(db, "SELECT COUNT(*) AS n FROM wa_deliverables WHERE verified_via IS NOT NULL AND verified_via != ''");
    out.push({
      key: 'deliverables.verified_via',
      count: num(vv.n),
      note: Object.keys(vv).length ? '带跨任务来源留证的产出物数' : '(列不存在或为空)',
    });
  }

  // ── 6. 事件账（中止发出 / 中止观测 / 孤儿 / 看门狗触发）───────────────
  {
    const types = ['run.abort_sent', 'run.abort_observed', 'run.orphaned', 'run.watchdog_fired'];
    for (const t of types) {
      const n = num(safeGet(db, 'SELECT COUNT(*) AS n FROM wa_event_log WHERE event_type = ?', t).n);
      out.push({ key: `exec_events.${t}`, count: n, note: '' });
    }
  }

  return out;
}

/** 库内 UTC 秒级时刻 → epoch ms；形状不认 ⇒ null（不猜）。 */
function utcMs(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /T|Z$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function formatLedger(rows: LedgerRow[]): string {
  return rows.map((r) => `${r.key}|${r.count}|${r.note}`).join('\n');
}

function main(): void {
  const root = path.join(__dirname, '..');
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const dbArg = args.find((a) => !a.startsWith('--'));
  const dbPath = dbArg ? path.resolve(dbArg) : path.join(root, 'data/worker-ant-server.db');
  const db = new DatabaseSync(dbPath, { readOnly: true } as never);
  try {
    const rows = measureExecHealth(db as unknown as AnyDb);
    if (wantJson) {
      // 同一份 rows 的机器可读出口；`measured_at` 用 UTC，与库内 `datetime('now')` 同基准。
      console.log(JSON.stringify({ db: dbPath, measured_at: new Date().toISOString(), rows }, null, 2));
    } else {
      console.log(`# db=${dbPath} (read-only)`);
      console.log(formatLedger(rows));
    }
  } finally {
    try { (db as unknown as { close: () => void }).close(); } catch { /* ignore */ }
  }
}

if (require.main === module) main();
