/**
 * zx_20261120_1 M9「运·一页」：运维概览的**读模型**（只读，永不抛）。
 *
 * 八块：调度队列 / 任务态 / 构建锁 / 数据库文件 / IM 补发 / cron 心跳 / ANS 探活 / 磁盘。
 * 每块 `{ ok, value?, reason? }`——**读不到写原因，不伪装 0**。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { findStaleExecutingTasks } from './self-healing-monitor.js';
import { outboxStats } from './im/im-outbox.js';

export interface OpsBlock<T> { ok: boolean; value?: T; reason?: string }

export interface OpsJobsValue {
  pending: number;
  running: number;
  failed24h: number;
  oldestPendingMs: number | null;
  byType: Record<string, number>;
}
export interface OpsTasksValue {
  executing: number;
  running: number;
  paused: number;
  stale: number;
  staleOldest: string | null;
}
export interface OpsLocksValue {
  total: number;
  active: number;
  expired: number;
  bad: number;
  items: Array<{ repoRoot: string; taskId: string; command: string; expiresAt: string; expired: boolean }>;
}
export interface OpsDbValue { dbBytes: number | null; walBytes: number | null; shmBytes: number | null }
export interface OpsImValue { pending: number; dead: number; blocked_quota: number; other: number }
export interface OpsCronValue { registeredProjects: number; heartbeatAgeMs: number | null; heartbeatOk: boolean | null; lastSuccess: boolean | null }
export interface OpsAnsValue { baseUrl: string; reachable: boolean | null; latencyMs: number | null; reason: string }
export interface OpsDiskValue { freeBytes: number | null; totalBytes: number | null }

export interface OpsOverview {
  generatedAt: string;
  jobs: OpsBlock<OpsJobsValue>;
  tasks: OpsBlock<OpsTasksValue>;
  locks: OpsBlock<OpsLocksValue>;
  db: OpsBlock<OpsDbValue>;
  im: OpsBlock<OpsImValue>;
  cron: OpsBlock<OpsCronValue>;
  ans: OpsBlock<OpsAnsValue>;
  disk: OpsBlock<OpsDiskValue>;
}

export interface OpsDeps {
  db: Database.Database;
  dataDir: string;
  dbPath?: string;
  /** ANS 基础地址（缺省读不到 ⇒ `ans` 块 ok:false）。 */
  ansBaseUrl?: string;
  /** 探活（缺省真 fetch，2s 有界）。 */
  probeAns?: (baseUrl: string) => Promise<{ ok: boolean; latencyMs: number | null; reason: string }>;
  now?: () => number;
}

const CRON_HEARTBEAT_FILE = 'cron_heartbeat.json';

export async function buildOpsOverview(deps: OpsDeps): Promise<OpsOverview> {
  const now = deps.now ?? (() => Date.now());
  return {
    generatedAt: new Date(now()).toISOString(),
    jobs: safeBlock(() => jobsBlock(deps.db, now())),
    tasks: safeBlock(() => tasksBlock(deps.db)),
    locks: safeBlock(() => locksBlock(deps.dataDir, now())),
    db: safeBlock(() => dbBlock(deps.dataDir, deps.dbPath)),
    im: safeBlock(() => imBlock(deps.db)),
    cron: safeBlock(() => cronBlock(deps.db, deps.dataDir, now())),
    ans: await ansBlock(deps.ansBaseUrl, deps.probeAns),
    disk: await diskBlock(deps.dataDir),
  };
}

function safeBlock<T>(fn: () => T): OpsBlock<T> {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, reason: (e instanceof Error ? e.message : String(e)) || 'read_failed' }; }
}

function jobsBlock(db: Database.Database, nowMs: number): OpsJobsValue {
  const rows = db.prepare('SELECT type, status, COUNT(*) AS n, MIN(created_at) AS oldest FROM wa_jobs GROUP BY type, status').all() as Array<{ type: string; status: string; n: number; oldest: string | null }>;
  const byType: Record<string, number> = {};
  let pending = 0, running = 0, failed24h = 0;
  let oldestPending: string | null = null;
  for (const r of rows) {
    byType[r.type] = (byType[r.type] ?? 0) + Number(r.n);
    if (r.status === 'pending') { pending += Number(r.n); if (!oldestPending && r.oldest) oldestPending = r.oldest; }
    if (r.status === 'running') running += Number(r.n);
  }
  const f = db.prepare("SELECT COUNT(*) AS n FROM wa_jobs WHERE status = 'failed' AND completed_at >= datetime('now','-1 day')").get() as { n?: number } | undefined;
  failed24h = Number(f?.n) || 0;
  const oldestMs = oldestPending ? Math.max(0, nowMs - parseDbUtc(oldestPending)) : null;
  return { pending, running, failed24h, oldestPendingMs: oldestMs, byType };
}

function tasksBlock(db: Database.Database): OpsTasksValue {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM wa_tasks WHERE status IN ('executing','running','preparing','paused') GROUP BY status").all() as Array<{ status: string; n: number }>;
  const m = new Map(rows.map((r) => [r.status, Number(r.n) || 0]));
  const stale = findStaleExecutingTasks(db);
  return {
    executing: (m.get('executing') ?? 0) + (m.get('preparing') ?? 0),
    running: m.get('running') ?? 0,
    paused: m.get('paused') ?? 0,
    stale: stale.length,
    staleOldest: stale.length > 0 ? String(stale[0]?.updated_at ?? '') || null : null,
  };
}

function locksBlock(dataDir: string, nowMs: number): OpsLocksValue {
  const root = path.join(dataDir, 'locks');
  const out: OpsLocksValue = { total: 0, active: 0, expired: 0, bad: 0, items: [] };
  if (!fs.existsSync(root)) return out;
  let files: string[] = [];
  try { files = fs.readdirSync(root).filter((f) => f.startsWith('build_') && f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    out.total++;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(root, f), 'utf-8')) as Record<string, unknown>;
      const expiresAt = String(o.expiresAt ?? '');
      const expired = expiresAt ? parseDbUtc(expiresAt) <= nowMs : false;
      if (expired) out.expired++; else out.active++;
      out.items.push({
        repoRoot: String(o.repoRoot ?? ''),
        taskId: String(o.taskId ?? ''),
        command: String(o.command ?? ''),
        expiresAt,
        expired,
      });
    } catch { out.bad++; }
  }
  return out;
}

function dbBlock(dataDir: string, dbPath?: string): OpsDbValue {
  const base = dbPath || path.join(dataDir, 'worker-ant-server.db');
  const size = (p: string): number | null => { try { return fs.statSync(p).size; } catch { return null; } };
  return { dbBytes: size(base), walBytes: size(`${base}-wal`), shmBytes: size(`${base}-shm`) };
}

function imBlock(db: Database.Database): OpsImValue {
  const s = outboxStats(db);
  return { pending: s.pending, dead: s.dead, blocked_quota: s.blocked_quota, other: s.other };
}

function cronBlock(db: Database.Database, dataDir: string, nowMs: number): OpsCronValue {
  const r = db.prepare("SELECT COUNT(*) AS n FROM wa_projects WHERE status = 'active' AND cron_schedule IS NOT NULL AND cron_schedule != ''").get() as { n?: number } | undefined;
  const registeredProjects = Number(r?.n) || 0;
  let heartbeatAgeMs: number | null = null;
  let lastSuccess: boolean | null = null;
  try {
    const file = path.join(dataDir, CRON_HEARTBEAT_FILE);
    if (fs.existsSync(file)) {
      const o = JSON.parse(fs.readFileSync(file, 'utf-8')) as { last_fire?: string; success?: boolean };
      const t = String(o.last_fire ?? '');
      if (t) heartbeatAgeMs = Math.max(0, nowMs - parseDbUtc(t));
      lastSuccess = typeof o.success === 'boolean' ? o.success : null;
    }
  } catch { /* 读不到 ⇒ null */ }
  // 与 health-check 同阈值（30 分钟）：超过即视为不新鲜。
  const heartbeatOk = heartbeatAgeMs == null ? null : heartbeatAgeMs <= 30 * 60 * 1000;
  return { registeredProjects, heartbeatAgeMs, heartbeatOk, lastSuccess };
}

async function ansBlock(baseUrl: string | undefined, probe?: OpsDeps['probeAns']): Promise<OpsBlock<OpsAnsValue>> {
  if (!baseUrl) return { ok: false, reason: '未配置 ANS 地址' };
  const p = probe ?? defaultProbe;
  try {
    const r = await p(baseUrl);
    return { ok: true, value: { baseUrl, reachable: r.ok, latencyMs: r.latencyMs, reason: r.reason } };
  } catch (e) {
    return { ok: true, value: { baseUrl, reachable: false, latencyMs: null, reason: (e instanceof Error ? e.message : String(e)) || 'probe_failed' } };
  }
}

async function defaultProbe(baseUrl: string): Promise<{ ok: boolean; latencyMs: number | null; reason: string }> {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { signal: ctrl.signal });
      return { ok: res.ok, latencyMs: Date.now() - started, reason: res.ok ? '' : `http_${res.status}` };
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, latencyMs: null, reason: (e instanceof Error ? e.message : String(e)) || 'probe_failed' };
  }
}

async function diskBlock(dataDir: string): Promise<OpsBlock<OpsDiskValue>> {
  try {
    const s = await fs.promises.statfs(dataDir);
    return { ok: true, value: { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) } };
  } catch (e) {
    return { ok: false, reason: (e instanceof Error ? e.message : String(e)) || 'statfs_failed' };
  }
}

/** SQLite `'YYYY-MM-DD HH:MM:SS'`（UTC）或 ISO → epoch ms；不可解析 ⇒ `NaN`。 */
function parseDbUtc(s: string): number {
  const t = String(s ?? '').trim();
  if (!t) return NaN;
  return new Date(t.includes('T') ? t : `${t.replace(' ', 'T')}Z`).getTime();
}
