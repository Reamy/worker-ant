/**
 * zx_20260930 M14-3（观卦「观国之光」/ 康德「概念无直观则空」）：**真健康自检**——
 * 「系统健康」不再是一个由"有没有跑着的任务"猜出来的词，而是**五面各出一份依据**的实测。
 *
 * 病根：此前的 `admin:health` 只数四张表的行数，再用 `runningTasks > 0 ? 'healthy' : …`
 * **猜**一个 `status`。它的名字叫「健康检查」，看的却是**业务量**——一台 ANS 连不上、
 * 库损坏、调度器死掉、渠道全挂的机器，只要有项目在跑就报 `healthy`。**这不是漏检，是名实不符。**
 *
 * 本模块把「健康」拆成**五面**，每面给**三态**（`ok` / `degraded` / `unavailable`）与**一句依据**：
 *   ① `ans`       ANS 连通性——**真发一次受保护请求**（不是打 ANS 那个公开的健康路由：
 *                 那只能证明"进程在监听"，证明不了"这台机器的身份还认得"；探的哪条路由调用方
 *                 `probeAns` 定，本模块只认它返回的三态）
 *   ② `db`        DB 完整性——`PRAGMA integrity_check` + 必要表在场
 *   ③ `scheduler` 调度器存活——**进程内脉冲优先**，无调度器时回落 `cron_heartbeat.json`（30 分钟阈值）
 *   ④ `im`        IM 通道——「启用中」的口径引 `imChannelEnabledSql()` 真源，再分健康/不健康
 *   ⑤ `resources` 磁盘与内存水位
 * 整体态 = 五面取**最差**（一面不可用即不可用；这是"链"的语义，不是"平均分"）。
 *
 * **一切外部世界都从形参进来**（`probeAns` / `readTextFile` / `diskFree` / `memory` / `now`）：
 * 本模块因此**不碰 electron、不碰真实墙钟、不碰真实磁盘**，可被受控回归直引跑真实现（G-1、G-4）。
 * 这与 `deliverable-lifecycle.ts` 的 `quarantineDir` 注入、`ai-reasoning.ts` 的 `dir` 注入同款纪律。
 */
import type Database from 'better-sqlite3';
import { imChannelEnabledSql } from './im/im-channel-status.js';

/** 三态词表（**唯一真源**）。 */
export const HEALTH_LEVELS = ['ok', 'degraded', 'unavailable'] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

/** 语义强弱序：整体取**最差**。数值越大越差。 */
export const HEALTH_LEVEL_RANK: Record<HealthLevel, number> = { ok: 0, degraded: 1, unavailable: 2 };

/** 唯一标签表（界面与日志共用）。 */
export const HEALTH_LEVEL_LABEL: Record<HealthLevel, string> = {
  ok: '正常',
  degraded: '降级',
  unavailable: '不可用',
};

/** 五面取最差。空集 ⇒ `ok`（没有依据就没有坏消息；调用方保证五面齐出）。 */
export function worstHealthLevel(levels: readonly HealthLevel[]): HealthLevel {
  let worst: HealthLevel = 'ok';
  for (const l of levels) if (HEALTH_LEVEL_RANK[l] > HEALTH_LEVEL_RANK[worst]) worst = l;
  return worst;
}

export function isHealthLevel(v: unknown): v is HealthLevel {
  return typeof v === 'string' && (HEALTH_LEVELS as readonly string[]).includes(v);
}

/** 进程内调度器脉冲超过这个龄期即视为陈旧（`processPending` 每秒一次，留 60 倍余量）。 */
export const SCHEDULER_PULSE_STALE_MS = 60_000;
/** `cron_heartbeat.json` 的存活阈值——与 `main/index.ts` 头注释「心跳 30 分钟内=存活」**同数**。 */
export const CRON_HEARTBEAT_STALE_MS = 30 * 60_000;

/** 主进程堆警戒/危险线。 */
export const HEAP_WARN_BYTES = 1_500 * 1024 * 1024;
export const HEAP_DANGER_BYTES = 3_000 * 1024 * 1024;
/** 磁盘**剩余占比**警戒/危险线。 */
export const DISK_FREE_WARN_RATIO = 0.1;
export const DISK_FREE_DANGER_RATIO = 0.03;

/**
 * 「必要表」——引擎少了任何一张就跑不起来（不是"锦上添花"的表）。
 * 判定用 `sqlite_master` 查名，**不**用 `SELECT ... LIMIT 0`（后者在空表上也过，查不出表在不在）。
 */
export const NEEDED_TABLES = [
  'wa_projects',
  'wa_tasks',
  'wa_jobs',
  'wa_memories',
  'wa_deliverables',
  'wa_event_log',
  'wa_settings',
  'wa_im_channels',
  'wa_self_healing_logs',
] as const;

/** `wa_im_channels.status` 里**不健康**的取值（`error` 失败 / `degraded` 降级 / `pending` 待登录）。 */
export const IM_UNHEALTHY_STATUSES = ['error', 'degraded', 'pending'] as const;

export type HealthItemKey = 'ans' | 'db' | 'scheduler' | 'im' | 'resources';

export interface HealthItem {
  key: HealthItemKey;
  /** 用户可见的中文名。 */
  label: string;
  level: HealthLevel;
  /** **依据**——一句话说清"凭什么这么判"（含实测值），不猜。 */
  evidence: string;
}

export interface HealthReport {
  level: HealthLevel;
  items: HealthItem[];
  /** ISO 时刻（来自注入的 `now`，不是真实墙钟）。 */
  checkedAt: string;
}

/** ANS 探针的结果——刻意与 `ansSignedRequest` 的返回**结构同形**（`ok`/`status`/`detail`）。 */
export interface AnsProbeResult {
  ok: boolean;
  /** 有 HTTP 响应时为真实状态码；传输层失败（超时/连不上）时为 `0`。 */
  status: number;
  detail?: string;
}

export interface HealthDeps {
  db: Database.Database;
  /** 真发一次受保护请求。缺省 ⇒ 该项如实标「未配置探针，无法判定」（`degraded`，不是"正常"）。 */
  probeAns?: (() => Promise<AnsProbeResult>) | null;
  /** 进程内调度器活体（优先）。缺省 ⇒ 回落 `heartbeatFile`。 */
  scheduler?: { isRunning(): boolean; lastTickAt(): number } | null;
  /** `cron_heartbeat.json` 的绝对路径（**由调用方注入**，本模块不解析 dataDir）。 */
  heartbeatFile?: string | null;
  readTextFile?: ((p: string) => string) | null;
  /** 磁盘余量。缺省 ⇒ 该项如实标「磁盘水位未注入」。 */
  diskFree?: (() => { free: number; total: number }) | null;
  memory?: (() => { heapUsed: number; rss: number }) | null;
  /** 时刻源（G-4：判据不得依赖真实墙钟）。 */
  now?: (() => number) | null;
}

async function checkAns(deps: HealthDeps, now: () => number): Promise<HealthItem> {
  const label = 'ANS 连通性';
  if (!deps.probeAns) {
    return { key: 'ans', label, level: 'degraded', evidence: '未配置探针，无法判定（不当作正常）' };
  }
  const t0 = now();
  let r: AnsProbeResult;
  try {
    r = await deps.probeAns();
  } catch (e) {
    return { key: 'ans', label, level: 'unavailable', evidence: `探针抛出：${(e as Error)?.message ?? String(e)}` };
  }
  const ms = Math.max(0, now() - t0);
  if (r.ok) return { key: 'ans', label, level: 'ok', evidence: `受保护请求 ${r.status}（${ms}ms）` };
  if (Number(r.status) === 0) {
    return { key: 'ans', label, level: 'unavailable', evidence: `连不上（${r.detail || '无响应'}）（${ms}ms）` };
  }
  // 有 HTTP 响应但不是 2xx：**能连通、身份/契约不对**——两件事，分开说。
  return { key: 'ans', label, level: 'degraded', evidence: `有响应但 ${r.status}（${r.detail || '非 2xx'}）（${ms}ms）` };
}

function checkDb(deps: HealthDeps): HealthItem {
  const label = 'DB 完整性';
  let integrity = '';
  try {
    const rows = deps.db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    integrity = String((rows[0] as { integrity_check?: unknown } | undefined)?.integrity_check ?? '');
  } catch (e) {
    return { key: 'db', label, level: 'unavailable', evidence: `完整性检查无法执行：${(e as Error)?.message ?? String(e)}` };
  }
  if (integrity !== 'ok') {
    return { key: 'db', label, level: 'unavailable', evidence: `integrity_check 返回「${integrity || '(空)'}」` };
  }
  const missing: string[] = [];
  for (const t of NEEDED_TABLES) {
    try {
      const row = deps.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t) as
        | { name?: string }
        | undefined;
      if (!row?.name) missing.push(t);
    } catch (e) {
      return { key: 'db', label, level: 'unavailable', evidence: `必要表检查无法执行：${(e as Error)?.message ?? String(e)}` };
    }
  }
  if (missing.length > 0) {
    return { key: 'db', label, level: 'degraded', evidence: `缺 ${missing.length} 张必要表：${missing.join('、')}` };
  }
  return { key: 'db', label, level: 'ok', evidence: `integrity_check=ok，${NEEDED_TABLES.length} 张必要表齐备` };
}

function checkScheduler(deps: HealthDeps, now: () => number): HealthItem {
  const label = '调度器存活';
  const s = deps.scheduler;
  if (s) {
    if (!s.isRunning()) {
      return { key: 'scheduler', label, level: 'degraded', evidence: '进程内调度器未在运行（已 stop）' };
    }
    const age = now() - Number(s.lastTickAt() ?? 0);
    const sec = Math.round(age / 1000);
    if (age <= SCHEDULER_PULSE_STALE_MS) {
      return { key: 'scheduler', label, level: 'ok', evidence: `进程内脉冲 ${sec} 秒前` };
    }
    return {
      key: 'scheduler',
      label,
      level: 'degraded',
      evidence: `进程内脉冲陈旧：${sec} 秒前（阈值 ${SCHEDULER_PULSE_STALE_MS / 1000} 秒）`,
    };
  }
  const f = deps.heartbeatFile;
  const read = deps.readTextFile;
  if (!f || !read) {
    return {
      key: 'scheduler',
      label,
      level: 'degraded',
      evidence: `无进程内调度器，且${!f ? '未配置心跳文件路径' : '未注入心跳读取'}，无法判定`,
    };
  }
  let last: unknown;
  try {
    last = (JSON.parse(read(f)) as { last_fire?: unknown })?.last_fire;
  } catch (e) {
    return { key: 'scheduler', label, level: 'unavailable', evidence: `无进程内调度器，心跳文件读不到：${(e as Error)?.message ?? String(e)}` };
  }
  const t = typeof last === 'string' ? Date.parse(last) : NaN;
  if (!Number.isFinite(t)) {
    return { key: 'scheduler', label, level: 'unavailable', evidence: '无进程内调度器，心跳文件里没有可解析的 last_fire' };
  }
  const age = now() - t;
  const min = Math.round(age / 60_000);
  if (age <= CRON_HEARTBEAT_STALE_MS) {
    return { key: 'scheduler', label, level: 'ok', evidence: `cron 心跳 ${min} 分钟前` };
  }
  return {
    key: 'scheduler',
    label,
    level: 'unavailable',
    evidence: `cron 心跳陈旧：${min} 分钟前（阈值 ${CRON_HEARTBEAT_STALE_MS / 60_000} 分钟）`,
  };
}

function checkIm(deps: HealthDeps): HealthItem {
  const label = 'IM 通道';
  let rows: Array<{ status: string | null; c: number }>;
  try {
    rows = deps.db
      .prepare(`SELECT status, COUNT(*) as c FROM wa_im_channels WHERE ${imChannelEnabledSql()} GROUP BY status`)
      .all() as Array<{ status: string | null; c: number }>;
  } catch (e) {
    return { key: 'im', label, level: 'degraded', evidence: `读渠道表失败：${(e as Error)?.message ?? String(e)}` };
  }
  const enabled = rows.reduce((a, r) => a + Number(r.c || 0), 0);
  if (enabled === 0) {
    return { key: 'im', label, level: 'unavailable', evidence: '零启用渠道（全部 inactive 或表为空）' };
  }
  const unhealthy = rows.filter((r) => (IM_UNHEALTHY_STATUSES as readonly string[]).includes(String(r.status)));
  const badCount = unhealthy.reduce((a, r) => a + Number(r.c || 0), 0);
  const tally = rows.map((r) => `${r.status ?? '(空)'} ${r.c}`).join(' · ');
  if (badCount > 0) {
    return {
      key: 'im',
      label,
      level: 'degraded',
      evidence: `${enabled} 个启用渠道中 ${badCount} 个不健康（${unhealthy.map((r) => `${r.status} ${r.c}`).join('、')}）`,
    };
  }
  return { key: 'im', label, level: 'ok', evidence: `${enabled} 个启用渠道全部健康（${tally}）` };
}

function checkResources(deps: HealthDeps): HealthItem {
  const label = '资源水位';
  const mem = (deps.memory ?? (() => process.memoryUsage()))();
  const heap = Number(mem?.heapUsed) || 0;
  const parts: string[] = [`堆 ${(heap / 1024 ** 3).toFixed(2)}GB`];
  let level: HealthLevel = 'ok';
  const bump = (l: HealthLevel) => {
    if (HEALTH_LEVEL_RANK[l] > HEALTH_LEVEL_RANK[level]) level = l;
  };
  if (heap >= HEAP_DANGER_BYTES) {
    bump('unavailable');
    parts.push(`内存超危险线 ${HEAP_DANGER_BYTES / 1024 ** 3}GB`);
  } else if (heap >= HEAP_WARN_BYTES) {
    bump('degraded');
    parts.push(`内存超警戒线 ${HEAP_WARN_BYTES / 1024 ** 3}GB`);
  }
  if (deps.diskFree) {
    try {
      const d = deps.diskFree();
      const total = Number(d?.total) || 0;
      const free = Number(d?.free) || 0;
      const ratio = total > 0 ? free / total : 1;
      parts.push(`磁盘余 ${(ratio * 100).toFixed(1)}%（${(free / 1024 ** 3).toFixed(1)}GB/${(total / 1024 ** 3).toFixed(1)}GB）`);
      if (ratio <= DISK_FREE_DANGER_RATIO) {
        bump('unavailable');
        parts.push(`低于危险线 ${DISK_FREE_DANGER_RATIO * 100}%`);
      } else if (ratio <= DISK_FREE_WARN_RATIO) {
        bump('degraded');
        parts.push(`低于警戒线 ${DISK_FREE_WARN_RATIO * 100}%`);
      }
    } catch (e) {
      parts.push(`磁盘水位读不到：${(e as Error)?.message ?? String(e)}`);
    }
  } else {
    parts.push('磁盘水位未注入');
  }
  return { key: 'resources', label, level, evidence: parts.join('，') };
}

/**
 * 跑一次真健康自检。**永不抛**——每一面自己兜住自己的异常，失败如实变成那一面的 `evidence`。
 * 整体态取五面**最差**。
 */
export async function runHealthCheck(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now ?? (() => Date.now());
  const items: HealthItem[] = [
    await checkAns(deps, now),
    checkDb(deps),
    checkScheduler(deps, now),
    checkIm(deps),
    checkResources(deps),
  ];
  return {
    level: worstHealthLevel(items.map((i) => i.level)),
    items,
    checkedAt: new Date(now()).toISOString(),
  };
}
