/**
 * zx_20261029_3 M3（道德经·善行无辙迹 / 毛选·不打无准备之仗）：**后台进程看得见、停得掉、退出带走**。
 *
 * 病根（M0 实测）：工具用 `runShellCommand` 起命令时 `detached: true` 让每条命令自成进程组——
 *   超时杀组因此杀得干净，但命令**正常返回**后留下的孙进程（`npm run dev &`、`tsx watch` 之类）
 *   既不在任何账上，也没有出口可停。用户只能从系统监视器里猜哪个是工蚁起的。
 *
 * 三件事、三处落点，互不越界：
 *   ① **记**：`register/settle/probe` 只写 `wa_background_jobs`（一张表、一份 DDL 真源）；
 *   ② **停**：`stopBackgroundJob` 只认登记表里的 id，杀前复核进程组是否仍在、命令行是否仍对得上；
 *   ③ **带走**：`stopTrackedBackgroundJobs` 在退出口上按登记表收（有界，失败不阻断）。
 *
 * 边界如实：
 *   - 只认 `pgid = pid`（POSIX `detached` 自成一组）；Windows 无进程组语义 ⇒ 登记照记，停止**如实回
 *     `unsupported`**，不假装杀得了。
 *   - 孤儿识别（`scanOrphanServiceChains`）**只报不杀**，且永不自动执行；用户点停才动手，动手前再核一次。
 *   - 本模块零 electron 依赖、可整库注入时钟/探活/ps（同 `settings-bool` / `pause-settlement` 范式），
 *     使受控回归能跑真实现。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** 表 DDL 唯一真源：`database.ts` 与 rr 夹具同引这一份（夹具比生产宽松或乱序，断言就只是自我印证）。 */
export const BACKGROUND_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS wa_background_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '',
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT DEFAULT '',
  pgid INTEGER,
  pid INTEGER,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  exit_code INTEGER,
  status TEXT DEFAULT 'running',
  leftover_probe_at TEXT,
  stopped_at TEXT,
  stop_signal TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_background_jobs_started ON wa_background_jobs(started_at DESC);
`;

/** `running` = 命令在途；`leftover` = 命令已落幕但进程组仍活；`exited` = 组已不在；
 *  `stopped` = 用户/退出路径停掉；`unsupported` = 未曾起得来（spawn 失败），如实登记不假装在跑。 */
export type BackgroundJobStatus = 'running' | 'leftover' | 'exited' | 'stopped' | 'unsupported';

export interface BackgroundJobRow {
  id: string;
  project_id: string;
  task_id: string;
  tool: string;
  command: string;
  cwd: string;
  pgid: number | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  status: BackgroundJobStatus;
  leftover_probe_at: string | null;
  stopped_at: string | null;
  stop_signal: string | null;
}

/** 仅需 prepare().run()/.get()/.all() 的最小库接口——使本模块可脱 better-sqlite3 跑真逻辑。 */
export interface BackgroundDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export interface GroupAliveDeps {
  /** 进程组是否仍活（负 pgid 发 0 号信号）。可注入以便受控回归。 */
  isAlive?: (pgid: number) => boolean;
  /** 该进程组的命令行（复核用）；取不到返回 null（不猜）。 */
  groupCommand?: (pgid: number) => string | null;
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  /** SIGTERM 之后的宽限（ms），再 SIGKILL。 */
  graceMs?: number;
}

const POSIX = process.platform !== 'win32';

/**
 * 负 pgid 发 0 号信号：进程组里只要还有一个活口就不抛。EPERM 说明「活着但不归我」——仍算活。
 *
 * ⚠ 红线：`0` / 负数 / 非数在 POSIX 语义里不是"某个组"——`kill(0, sig)` 广播给**调用者自己的**进程组，
 *   负数除 -1 外不可移植。账上一旦出现这种值（解析缺陷、外部写入），探活会恒真、停止会带走
 *   工蚁自己或整台机器。故非正整数一律按"不是活组"处置，**不发任何信号**。
 */
export function defaultIsAlive(pgid: number): boolean {
  if (!Number.isFinite(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultKillGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isFinite(pgid) || pgid <= 0) return;
  try { process.kill(-pgid, signal); } catch { /* 已退出 */ }
}

/** 命令行取「该组内第一个进程的 command」；解析失败返回 null（不猜）。 */
function defaultGroupCommand(pgid: number): string | null {
  try {
    const out = execFileSync('ps', ['-eo', 'pgid=,command='], { encoding: 'utf-8', timeout: 3000 });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m && Number(m[1]) === pgid) return m[2].trim();
    }
    return null;
  } catch { return null; }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toInt(v: unknown): number | null {
  // ⚠ `Number(null) === 0`、`Number('') === 0`：裸 cast 会把"没有值"变成"进程组 0"，
  //   而 pgid 0 在 POSIX 里正是**本进程组**——探活恒真、停止会把自己带走（实测踩中，见方案 M3）。
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function viewRow(raw: Record<string, unknown>): BackgroundJobRow {
  return {
    id: String(raw.id ?? ''),
    project_id: String(raw.project_id ?? ''),
    task_id: String(raw.task_id ?? ''),
    tool: String(raw.tool ?? ''),
    command: String(raw.command ?? ''),
    cwd: String(raw.cwd ?? ''),
    pgid: toInt(raw.pgid),
    pid: toInt(raw.pid),
    started_at: String(raw.started_at ?? ''),
    ended_at: raw.ended_at == null ? null : String(raw.ended_at),
    exit_code: toInt(raw.exit_code),
    status: (raw.status as BackgroundJobStatus) ?? 'running',
    leftover_probe_at: raw.leftover_probe_at == null ? null : String(raw.leftover_probe_at),
    stopped_at: raw.stopped_at == null ? null : String(raw.stopped_at),
    stop_signal: raw.stop_signal == null ? null : String(raw.stop_signal),
  };
}

/** 登记一行（命令**启动前**调用：id 先定，spawn 成功后再补 pid/pgid）。 */
export function registerBackgroundJob(
  db: BackgroundDb,
  job: {
    id?: string;
    projectId?: string;
    taskId?: string;
    tool: string;
    command: string;
    cwd?: string;
    pid?: number | null;
    pgid?: number | null;
  },
): string {
  const id = job.id || randomUUID();
  db.prepare(
    `INSERT INTO wa_background_jobs (id, project_id, task_id, tool, command, cwd, pgid, pid, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
  ).run(
    id,
    job.projectId ?? '',
    job.taskId ?? '',
    job.tool,
    job.command,
    job.cwd ?? '',
    job.pgid ?? null,
    job.pid ?? null,
  );
  return id;
}

/** spawn 成功后补进程号（POSIX 下 `detached` 使 `pgid = pid`）。 */
export function attachBackgroundPid(db: BackgroundDb, id: string, pid: number | undefined): void {
  if (pid == null) return;
  db.prepare('UPDATE wa_background_jobs SET pid = ?, pgid = ? WHERE id = ?').run(pid, POSIX ? pid : null, id);
}

/**
 * 命令落幕：判进程组是否仍在。
 *   - 组已散 ⇒ `exited`；
 *   - 组仍活 ⇒ `leftover`（这正是"命令返回了、后台还活着"的病态，用户此前看不见）；
 *   - 没拿到 pid（spawn 失败）⇒ `unsupported`，如实登记"没跑起来"。
 */
export function settleBackgroundJob(
  db: BackgroundDb,
  id: string,
  result: { exitCode: number | null },
  deps: GroupAliveDeps = {},
): void {
  const row = db.prepare('SELECT * FROM wa_background_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return;
  const status = (row.status as BackgroundJobStatus) ?? 'running';
  if (status !== 'running') return;
  const pgid = toInt(row.pgid);
  const pid = toInt(row.pid);
  if (pid == null) {
    db.prepare(
      `UPDATE wa_background_jobs SET status = 'unsupported', ended_at = datetime('now'), exit_code = ? WHERE id = ?`,
    ).run(result.exitCode, id);
    return;
  }
  if (pgid == null) {
    // Windows：无进程组语义 ⇒ 只能如实说"子进程已退出"，不冒充已核对遗留
    db.prepare(
      `UPDATE wa_background_jobs SET status = 'exited', ended_at = datetime('now'), exit_code = ? WHERE id = ?`,
    ).run(result.exitCode, id);
    return;
  }
  const alive = (deps.isAlive ?? defaultIsAlive)(pgid);
  if (alive) {
    db.prepare(
      `UPDATE wa_background_jobs SET status = 'leftover', ended_at = datetime('now'), exit_code = ?,
         leftover_probe_at = datetime('now') WHERE id = ?`,
    ).run(result.exitCode, id);
  } else {
    db.prepare(
      `UPDATE wa_background_jobs SET status = 'exited', ended_at = datetime('now'), exit_code = ? WHERE id = ?`,
    ).run(result.exitCode, id);
  }
}

/**
 * 对账一遍未终结的行（启动时/打开面板时跑）：
 *   running ∧ 组已散 ⇒ exited（进程已随上次会话退出，结束时刻未知，`ended_at` 保持 NULL 不编）。
 *   任何态 ∧ 组仍活 ∧ 非 leftover ⇒ leftover（`leftover_probe_at` 记检出时刻）。
 *   leftover ∧ 组已散 ⇒ exited（`leftover_probe_at` 保留——它曾遗留过，这是账上的事实）。
 * 返回状态发生变化的行数（计数器类断言据此判 0→N，不只看"不抛"）。
 */
export function probeLeftovers(db: BackgroundDb, deps: GroupAliveDeps = {}): number {
  if ((deps.platform ?? process.platform) === 'win32') return 0;
  const rows = db.prepare(
    `SELECT * FROM wa_background_jobs WHERE status IN ('running','leftover') AND pgid IS NOT NULL`,
  ).all() as Array<Record<string, unknown>>;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  let changed = 0;
  for (const raw of rows) {
    const row = viewRow(raw);
    const pgid = row.pgid as number;
    const alive = isAlive(pgid);
    if (alive && row.status !== 'leftover') {
      db.prepare(
        `UPDATE wa_background_jobs SET status = 'leftover', leftover_probe_at = datetime('now') WHERE id = ?`,
      ).run(row.id);
      changed++;
    } else if (!alive && row.status === 'running') {
      db.prepare(`UPDATE wa_background_jobs SET status = 'exited' WHERE id = ?`).run(row.id);
      changed++;
    } else if (!alive && row.status === 'leftover') {
      db.prepare(`UPDATE wa_background_jobs SET status = 'exited' WHERE id = ?`).run(row.id);
      changed++;
    }
  }
  return changed;
}

export interface BackgroundJobView extends BackgroundJobRow {
  /** 能否整组归属/停止：POSIX 且拿到 pgid。win32 / spawn 失败 ⇒ false，界面据此如实标注。 */
  group_attributable: boolean;
}

export function listBackgroundJobs(
  db: BackgroundDb,
  opts: { limit?: number; projectId?: string; taskId?: string } = {},
): BackgroundJobView[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
  if (opts.taskId) { where.push('task_id = ?'); params.push(opts.taskId); }
  const wsql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM wa_background_jobs ${wsql} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const row = viewRow(r);
    return { ...row, group_attributable: row.pgid != null && row.pgid > 0 && row.pid != null };
  });
}

/** 某行的遗留尾巴（供工具回话如实补一句）；无遗留返回空串。 */
export function leftoverNote(db: BackgroundDb, id: string): string {
  try {
    const row = db.prepare('SELECT status FROM wa_background_jobs WHERE id = ?').get(id) as { status?: string } | undefined;
    if (row?.status === 'leftover') return '\n（后台进程仍在运行，已登记：可在「活动中心 → 后台进程」查看/停止）';
  } catch { /* 读不到就不添话，不阻断工具回话 */ }
  return '';
}

export interface StopResult {
  ok: boolean;
  status: BackgroundJobStatus | 'unsupported';
  message: string;
  signal?: string;
}

/** 复核"这组还是不是当初那组"：命令行含原命令首 token 才算。（取不到命令行时按登记表信任，但如实记在消息里） */
function commandStillMatches(pgid: number, original: string, groupCommand: (pgid: number) => string | null): { ok: boolean; note: string } {
  const line = groupCommand(pgid);
  if (line == null) return { ok: true, note: '（未能取到该组命令行，按登记表处置）' };
  const first = original.trim().split(/\s+/)[0] ?? '';
  if (!first) return { ok: true, note: '' };
  const base = first.split('/').pop() ?? first;
  if (line.includes(first) || line.includes(base)) return { ok: true, note: '' };
  return { ok: false, note: '' };
}

/** 停一行**登记表内**的进程。只接受 leftover/running；其余态如实回"无需停止"。 */
export async function stopBackgroundJob(
  db: BackgroundDb,
  id: string,
  deps: GroupAliveDeps = {},
): Promise<StopResult> {
  const raw = db.prepare('SELECT * FROM wa_background_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!raw) return { ok: false, status: 'exited', message: '未登记的进程 id（只停登记表内的进程）' };
  const row = viewRow(raw);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return { ok: false, status: 'unsupported', message: 'Windows 下无法整组停止（未执行任何杀动作）' };
  if (row.pgid == null || row.pgid <= 0) return { ok: false, status: row.status, message: '该行未记录有效进程组，无法整组停止' };
  if (row.status !== 'leftover' && row.status !== 'running') {
    return { ok: false, status: row.status, message: `当前状态为 ${row.status}，无需停止` };
  }
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const groupCommand = deps.groupCommand ?? defaultGroupCommand;
  const sleep = deps.sleep ?? realSleep;
  const graceMs = deps.graceMs ?? 2000;
  if (!isAlive(row.pgid)) {
    db.prepare(`UPDATE wa_background_jobs SET status = 'exited' WHERE id = ?`).run(row.id);
    return { ok: false, status: 'exited', message: '进程组已不存在（无需动手）' };
  }
  const check = commandStillMatches(row.pgid, row.command, groupCommand);
  if (!check.ok) {
    return { ok: false, status: row.status, message: '命令行已变化，疑非同一进程组，未执行杀动作' };
  }
  killGroup(row.pgid, 'SIGTERM');
  await sleep(graceMs);
  let signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM';
  if (isAlive(row.pgid)) {
    killGroup(row.pgid, 'SIGKILL');
    signal = 'SIGKILL';
    await sleep(200);
  }
  if (isAlive(row.pgid)) {
    return { ok: false, status: 'leftover', message: '已发送 SIGKILL 但仍存活，请到系统监视器处理', signal };
  }
  db.prepare(
    `UPDATE wa_background_jobs SET status = 'stopped', stopped_at = datetime('now'), stop_signal = ?,
       ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?`,
  ).run(signal, row.id);
  return { ok: true, status: 'stopped', message: `已停止进程组 ${row.pgid}${check.note}`, signal };
}

/**
 * 退出口：把登记表里**仍在跑/仍遗留**的组一并带走（有界：SIGTERM 一次宽限后统一 SIGKILL）。
 * 失败不阻断退出（调用方 catch 后照常 `hardExit`）。返回处置行数。
 */
export async function stopTrackedBackgroundJobs(
  db: BackgroundDb,
  deps: GroupAliveDeps = {},
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return 0;
  // `pgid > 0` 与 `defaultIsAlive` 的守卫同源：账上即使混进 0/负数也绝不进杀名单。
  const rows = (db.prepare(
    `SELECT * FROM wa_background_jobs WHERE status IN ('running','leftover') AND pgid IS NOT NULL AND pgid > 0`,
  ).all() as Array<Record<string, unknown>>).map(viewRow);
  if (rows.length === 0) return 0;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const sleep = deps.sleep ?? realSleep;
  const graceMs = deps.graceMs ?? 2000;

  const targets = rows.filter((r) => isAlive(r.pgid as number));
  for (const r of targets) killGroup(r.pgid as number, 'SIGTERM');
  if (targets.length > 0) await sleep(graceMs);
  const survivors = targets.filter((r) => isAlive(r.pgid as number));
  for (const r of survivors) killGroup(r.pgid as number, 'SIGKILL');
  if (survivors.length > 0) await sleep(200);

  let n = 0;
  for (const r of targets) {
    const pgid = r.pgid as number;
    if (isAlive(pgid)) continue; // 仍活着就如实留在账上，不谎报已停
    const signal = survivors.includes(r) ? 'SIGKILL' : 'SIGTERM';
    db.prepare(
      `UPDATE wa_background_jobs SET status = 'stopped', stopped_at = datetime('now'), stop_signal = ?,
         ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?`,
    ).run(signal, r.id);
    n++;
  }
  return n;
}

/** 清理已终结的旧行（保留期同既有日志套路）；**不删未结束行**（running/leftover 一律留着）。 */
export function pruneBackgroundJobs(db: BackgroundDb, keepDays = 7): number {
  const r = db.prepare(
    `DELETE FROM wa_background_jobs WHERE status IN ('exited','stopped','unsupported')
       AND started_at < datetime('now', ?)`,
  ).run(`-${Math.max(1, Math.floor(keepDays))} days`) as { changes?: number } | undefined;
  return Number(r?.changes ?? 0);
}

// ══════════════════════════════════════════════════════════════════════
// 孤儿服务链：只报不杀（用户点击才动手，动手前再核命令行）
// ══════════════════════════════════════════════════════════════════════

export interface OrphanServiceChain {
  pid: number;
  pgid: number;
  started_at: string;
  command: string;
  reason: string;
}

/** `ps -eo pid=,pgid=,lstart=,command=` 的解析（lstart 固定五段，命令取余下全文）。 */
export function parsePsLines(out: string): Array<{ pid: number; pgid: number; started_at: string; command: string }> {
  const rows: Array<{ pid: number; pgid: number; started_at: string; command: string }> = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), started_at: m[3].replace(/\s+/g, ' '), command: m[4].trim() });
  }
  return rows;
}

export interface ScanOrphanDeps {
  repoRoot?: string | null;
  platform?: NodeJS.Platform;
  /** 注入 ps 输出（受控回归用；缺省真跑 ps）。 */
  psOutput?: string;
  /** 登记表内的 pgid（这些不算孤儿）。 */
  trackedPgids?: ReadonlySet<number>;
  /** 本进程自己的 pgid（不算孤儿）。缺省自 ps 里找。 */
  selfPgid?: number;
}

function readPs(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-eo', 'pid=,pgid=,lstart=,command='], { encoding: 'utf-8', timeout: 3000 });
  } catch { return null; }
}

/**
 * 「命令行含本仓路径 ∧ 含 ans-server / tsx watch ∧ 不在登记表」⇒ 疑似此前遗留。
 * **本函数不执行任何杀动作**——返回数据供界面展示（F 组断言据此钉"只报不杀"）。
 */
export function scanOrphanServiceChains(deps: ScanOrphanDeps = {}): OrphanServiceChain[] {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return [];
  const repoRoot = deps.repoRoot ?? null;
  if (!repoRoot) return [];
  const out = deps.psOutput ?? readPs(platform);
  if (out == null) return [];
  const tracked = deps.trackedPgids ?? new Set<number>();
  const rows = parsePsLines(out);
  const selfPgid = deps.selfPgid ?? rows.find((r) => r.pid === process.pid)?.pgid;
  const marker = /ans-server|tsx\s+watch/;
  return rows
    // `pgid/pid > 0`：内核线程一类的 ps 行带 0，不能进"可疑可停"名单（同 defaultIsAlive 的红线）。
    .filter((r) => r.pgid > 0 && r.pid > 0)
    .filter((r) => r.command.includes(repoRoot) && marker.test(r.command))
    .filter((r) => !tracked.has(r.pgid))
    .filter((r) => r.pgid !== selfPgid)
    .map((r) => ({ ...r, reason: '登记表外 · 疑似此前遗留（点停止才会动手）' }));
}

/** 停一条**孤儿链**：先按同样规则重扫，pid/pgid 与命令行都对得上才动手。 */
export async function stopOrphanServiceChain(
  db: BackgroundDb,
  target: { pid: number; pgid: number },
  deps: ScanOrphanDeps & GroupAliveDeps = {},
): Promise<StopResult> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return { ok: false, status: 'unsupported', message: 'Windows 下无法整组停止（未执行任何杀动作）' };
  const tracked = deps.trackedPgids ?? trackedPgidsOf(db);
  const current = scanOrphanServiceChains({ ...deps, trackedPgids: tracked });
  const hit = current.find((r) => r.pid === target.pid && r.pgid === target.pgid);
  if (!hit) return { ok: false, status: 'exited', message: '复核未命中（进程已退出或命令行已变化），未执行杀动作' };
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const sleep = deps.sleep ?? realSleep;
  const graceMs = deps.graceMs ?? 2000;
  if (!isAlive(hit.pgid)) return { ok: false, status: 'exited', message: '进程组已不存在（无需动手）' };
  killGroup(hit.pgid, 'SIGTERM');
  await sleep(graceMs);
  let signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM';
  if (isAlive(hit.pgid)) { killGroup(hit.pgid, 'SIGKILL'); signal = 'SIGKILL'; await sleep(200); }
  if (isAlive(hit.pgid)) return { ok: false, status: 'leftover', message: '已发送 SIGKILL 但仍存活，请到系统监视器处理', signal };
  return { ok: true, status: 'stopped', message: `已停止疑似遗留进程组 ${hit.pgid}`, signal };
}

/** 登记表里未终结行的 pgid 集合（孤儿识别的排除集）。 */
export function trackedPgidsOf(db: BackgroundDb): Set<number> {
  const rows = db.prepare(
    `SELECT DISTINCT pgid FROM wa_background_jobs WHERE status IN ('running','leftover') AND pgid IS NOT NULL`,
  ).all() as Array<{ pgid?: unknown }>;
  const out = new Set<number>();
  for (const r of rows) {
    const n = toInt(r.pgid);
    if (n != null && n > 0) out.add(n);
  }
  return out;
}

/**
 * 工具侧 hooks 工厂（`shell.ts` 四个工具共用）：
 * 先登记（命令尚未起，`pid` 空），spawn 成功后补 `pid/pgid`，落幕时 settle。
 * 任一步失败都**不阻断命令本身**——登记是账，不是闸。
 */
export function makeShellHooks(
  db: BackgroundDb,
  ctx: { projectId: string; taskId: string; tool: string; command: string; cwd: string },
): { jobId: string; hooks: { onSpawn: (info: { pid: number | undefined }) => void; onSettle: (info: { exitCode: number | null }) => void } } {
  const jobId = randomUUID();
  try {
    registerBackgroundJob(db, { id: jobId, ...ctx });
  } catch { /* 建表缺失等 ⇒ 退化为不登记，命令照跑 */ }
  return {
    jobId,
    hooks: {
      onSpawn: ({ pid }) => { try { attachBackgroundPid(db, jobId, pid); } catch { /* 不阻断 */ } },
      onSettle: ({ exitCode }) => { try { settleBackgroundJob(db, jobId, { exitCode }); } catch { /* 不阻断 */ } },
    },
  };
}
