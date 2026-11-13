/**
 * 轻量任务调度器：内存队列 + SQLite持久化。
 * 重启后自动恢复pending/running状态的任务。
 */

/**
 * @layer infrastructure — 基础设施层 — 技术实现细节：SQLite、ANS Gateway、文件系统、MCP进程管理
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import cron, { type ScheduledTask } from 'node-cron';
import { createLogger } from './logger.js';
import { eventBus } from './event-bus.js';
import { analyzeProjectBottlenecks } from './bottleneck-analyzer.js';
import { criticalPathDepths, depBlocksRun, parseDepIds, type DepState } from './dep-graph.js';
import { boolSetting } from './settings-bool.js';
// zx_20261018_3 批二: 依赖现状的读点与三条人工入口**同一处**（`task-dep-gate`）——
//   调度器不再自带一份 SELECT/classify 组合，免得"自动调度一把尺、人工入口另一把尺"。
import { taskDepState } from './task-dep-gate.js';
import { isChildrenIncompletePause, PAUSE_REASON_PLANNING_TIMEOUT } from './pause-reason.js';
import { pauseTask } from './pause-task.js';
import { autoPullJobType, EXECUTION_TRACE_ROLES } from './resume-ledger.js';
import { isTerminalTask } from './task-jobs.js';
// zx_20261023_3 批四：作业来源归一化与 `enqueueJob` 共用一处（`withJobSource`）。
import { withJobSource } from './job-enqueuer.js';
import { shouldAutoResumeOnStepCap } from './step-budget.js';
import { chainBlockReason } from './task-chain.js';
// zx_20260929 M5-d（管子·度量衡）：项目并发口径取既有真源（`task-accounting.resolveProjectConcurrency`），
// 与硬闸 `jobs/ai-task.ts` 读**同一函数、同一数**——此前本处写 `rhythm.maxConcurrency ?? 2` 且只数 executing。
// zx_20260930 M11-7: 「该不该扫这个项目」同取真源（`projectScanVerdict`：项目状态 + 活跃时段窗口两条件合一）。
import { resolveProjectConcurrency, JOB_BATCH_SIZE, projectScanVerdict } from './task-accounting.js';
// zx_20260930 M11-3: 执行态无心跳的**唯一裁定者**（判据与处置同处，与自愈监视器共用）。
import { findStaleExecutingTasks, reclaimStaleExecutingTask } from './self-healing-monitor.js';
// zx_20261022_2 批三: 「孤立刻 running」查找器（只找不动）——启动/周期两条路共用。
import { findOrphanRunningTasks } from './task-running-reconcile.js';
// zx_20261011_4 M1（知止）：**已外派他机**的子任务须让位本机调度——判据/计数一律取 `node-orchestrate` 一处真源。
import { isRemoteBlocked, countRemoteAssignedPending, type OrchestrateDb } from './node-orchestrate.js';
// zx_20261022_2 批二: 计划超时读时刻走**既有唯一真源** `dbTimeMs`（带 Z 原样、空格补 Z）——
//   旧写法 `new Date(updated_at + 'Z')` 遇到 ISO 串（本身已带 Z）得到 `Invalid Date`，超时永不触发。
import { dbTimeMs } from './memory-decay.js';
// zx_20261110_2 B2（老子·功遂身退 / 帕累托·先治大头）：在途键是否**真有执行体**由这一处回答——
//   事故 339ef167 的 73 分钟里，55 分钟压在"键在、run 早没了"这件事上。
import { hasTaskRun } from './task-run-registry.js';

const logger = createLogger('scheduler');

type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * zx_20261110_2 B2：一条**在途键**的全部事实。
 *
 * 病根：`inflight` 原为 `Set<string>`，只在 handler 的 `finally` 删。
 * handler 不返回（abort 没兑现）⇒ 键永在 ⇒ 同任务后续作业在 `processPending` 被静默跳过（事故 55 分钟在队）。
 * 记账三件：`startedAt`（判龄）、`runToken`（旧 run 不得删新 run 的键）、`jobId/type/payload`（释放后能重排）。
 */
interface InflightEntry {
  taskId: string;
  jobId?: string;
  type: string;
  payload: Record<string, unknown>;
  startedAt: number;
  runToken: string;
  requeues: number;
}

/** 在途键超龄宽限（ms）：无真实 run 且超龄 ⇒ 可释放重排。 */
const DEFAULT_INFLIGHT_ORPHAN_MS = 60_000;
/**
 * zx_20261111_1 B3（治大国若烹小鲜）：**无 taskId** 作业的超龄宽限保守缺省 10 分钟。
 * 这类作业（`embed-memory` / `consolidate-memories` …）没有任务 run 可对账，60s 就翻面会
 * 把合法长作业反复重排。有 taskId 的作业仍走全局 60s（真挂死要能被发现）。
 */
const DEFAULT_NO_TASK_ORPHAN_MS = 600_000;
/** 同一键最多重排几次（无上界即成"卡死—重排"风暴）。 */
const INFLIGHT_MAX_REQUEUES = 2;

function inflightOrphanMs(): number {
  const n = Number(String(process.env.INFLIGHT_ORPHAN_SEC ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : DEFAULT_INFLIGHT_ORPHAN_MS;
}

// A1/A2/A3 (2026-09-04) 的四个"作业-任务一致性"helpers 已迁 `./task-jobs.js`
// （zx_20260917 M5：`task-chain` 也要用 `hasPendingExecutionJob`，留在本文件会与它互引成环）。
// 调用方（`ipc/project.ipc.ts`）同批改从新模块引——**不**在此留转发，免生第二处真源。

/**
 * zx_20261113_2 M18：**收口后**才该跑的作业类型（任务此时已是终态，恰恰是它们的运行前提）。
 * 启动恢复时不得按"任务已终态"把它们作废——那会把完成通知/复盘永久吞掉。
 */
export const POST_TERMINAL_JOB_TYPES = ['task-postlude', 'background-review'] as const;
export function isPostTerminalJobType(type: string): boolean {
  return (POST_TERMINAL_JOB_TYPES as readonly string[]).includes(type);
}

/**
 * zx_20261113_2 M18：内存 pending 队列的键。
 *
 * 病根（2026-11-13 真标本 `0396cfbc`）：此前所有作业一律以 `taskId` 为键。同一任务在收口后
 *   同时入队 `task-postlude` 与 `background-review`，后者的 `pending.set(taskId, …)` 把前者的条目
 *   **覆盖掉**；后者跑完删键，前者的 `wa_jobs` 行永远停在 `pending` ⇒ IM 完成通知从未发出。
 *
 * 口径：只有 `ai-task` / `resume-ai-task` 继续以 `taskId` 为键（`scanReadyTasks` 的
 *   `pending.has(taskId)` 与它同域）；其余类型一律 `type:taskId`，不同作业互不覆盖。
 */
export function jobPendingKey(type: string, jobId: string, payload: unknown): string {
  const tid = (payload as { taskId?: unknown } | null)?.taskId;
  if (typeof tid !== 'string' || tid === '') return jobId;
  if (type === 'ai-task' || type === 'resume-ai-task') return tid;
  return `${type}:${tid}`;
}

export class TaskScheduler {
  private db: Database.Database;
  private handlers = new Map<string, JobHandler>();
  private pending = new Map<string, { type: string; payload: Record<string, unknown>; jobId?: string }>();
  /**
   * zx_20261028_1 M1（图难于其易）：**在途键**——与 `pending` 同域（`pendingKey`）。
   * 此前 `processPending` 在 `await handler` **之前**就把条目从 `pending` 删掉，拆解那 ~5 秒里
   * `scanReadyTasks`（10s 一跳、只查 `pending.has`）以为"没在跑"，按软闸再入队一份 ⇒ 一次派发拆两遍。
   * 键在"取到 handler"那一刻加入、`finally` 里移除；在途期间任何再入队都会被本闸挡下。
   */
  /**
   * zx_20261110_2 B2：在途**账**（原为 `Set<string>`，见 `InflightEntry` 注记）。
   * 键域不变（同 `pendingKey`），值从"只是一个键"升级为"一条可对账的事实"。
   */
  private inflight = new Map<string, InflightEntry>();
  /**
   * zx_20261111_1 B3：**按作业类型登记的运行上界**（ms）。只影响"无真实执行体"的超龄判据，
   * 不改变作业自身超时，也不改变 `hasTaskRun` 判活。未登记的类型回落全局宽限。
   */
  private orphanGrace = new Map<string, number>();
  /** 时钟注入（rr 用假时钟；生产缺省真实墙钟）——对账判据不得依赖真实墙钟。 */
  private _now: () => number = Date.now;
  private running = false;
  /**
   * zx_20260930 M14-3：**调度器活体脉冲**——`processPending` 每秒被 `setInterval` 唤起，
   * 此处记下"最近一次真的转起来了"的时刻。`admin:health` 的「调度器存活」面据此判定
   * （**进程内脉冲优先**），`cron_heartbeat.json` 只在拿不到本对象时回落。
   * 记在**时间轮询的最外层**（早于 `pending.size === 0` 的提前返回）：空转也是一种活着。
   */
  private _lastTickAt = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private _timeoutTimer: ReturnType<typeof setInterval> | null = null;
  private _scheduledTimer: ReturnType<typeof setInterval> | null = null;
  private _scanTimer: ReturnType<typeof setInterval> | null = null;
  private _bottleneckTimer: ReturnType<typeof setInterval> | null = null;
  private _disposed = false;

  // A1: cron定时调度 —— projectId → ScheduledTask[]
  private cronJobs = new Map<string, ScheduledTask[]>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * zx_20260929 M5-d（维特根斯坦·同一把尺）：`pending` 的键**归一种**——凡带 `payload.taskId` 者
   * 一律以 **taskId** 为键（与 `scanReadyTasks` 的 `this.pending.has(taskId)` 同域），无 taskId 者回退 jobId。
   *
   * 病根：此前两套键并存且互不可见——`enqueue`/`checkScheduled` 用 **jobId**、`scanReadyTasks`
   * 用 **taskId**。于是同一任务"已有作业行在队"（jobId 键）时，`scanReadyTasks` 的 `has(taskId)` 查不到 ⇒
   * **自动拉起又入队一次**（一个任务两份作业，重复扣费/重复执行）。归键后两者互见。
   *
   * 真正的作业行 id 另存 `jobId` 字段（`processPending` 的 `wa_jobs` 更新只认它）——因为软闸那条路
   * **本就不写 `wa_jobs`**（只是内存 `pending`），对它做 `WHERE id = <taskId>` 的更新恒命中 0 行：
   * 不出错但也不做事，属"沉默的空转"，故显式区分而非继续假装有作业行。
   */
  private pendingKey(jobId: string, payload: unknown, type: string): string {
    return jobPendingKey(type, jobId, payload);
  }

  /** A1: 注册项目的cron定时作业（支持多个表达式，用换行或分号分隔） */
  registerCronJob(projectId: string, cronExpression: string, timezone: string, handler: () => Promise<void>): boolean {
    this.unregisterCronJob(projectId);
    if (!cronExpression) return false;

    // 支持多个cron表达式：换行符/分号分隔
    const expressions = cronExpression
      .split(/[\n;]+/)
      .map(e => e.trim())
      .filter(e => e.length > 0);

    if (expressions.length === 0) return false;

    const tasks: ScheduledTask[] = [];
    let allValid = true;

    for (const expr of expressions) {
      if (!cron.validate(expr)) {
        logger.warn({ projectId, cronExpression: expr }, 'cron表达式无效，跳过');
        allValid = false;
        continue;
      }
      try {
        const task = cron.schedule(expr, () => {
          void handler().catch(err => logger.error({ err, projectId }, 'cron作业执行失败'));
        }, { timezone });
        tasks.push(task);
        logger.info({ projectId, cronExpression: expr, timezone }, 'cron定时作业已注册');
      } catch (err) {
        logger.error({ err, projectId, cronExpression: expr }, 'cron作业注册失败');
        allValid = false;
      }
    }

    if (tasks.length > 0) {
      this.cronJobs.set(projectId, tasks);
      return allValid;
    }
    return false;
  }

  /** A1: 注销项目的所有cron定时作业 */
  unregisterCronJob(projectId: string): void {
    const existing = this.cronJobs.get(projectId);
    if (existing && existing.length > 0) {
      for (const task of existing) task.stop();
      this.cronJobs.delete(projectId);
      logger.info({ projectId, count: existing.length }, 'cron定时作业已全部注销');
    }
  }

  /** A1: 获取项目cron作业状态 */
  getCronJobStatus(projectId: string): boolean {
    return this.cronJobs.has(projectId);
  }

  /** zx_20260930 M14-3: 调度器活体——是否在跑（`start()` 之后、`stop()` 之前）。 */
  isRunning(): boolean {
    return this.running;
  }

  /** zx_20260930 M14-3: 最近一次 `processPending` 的时刻（epoch ms）。供 `admin:health` 判脉冲新鲜度。 */
  lastTickAt(): number {
    return this._lastTickAt;
  }

  /**
   * 注册作业处理器。
   *
   * zx_20261111_1 B3：`opts.orphanGraceMs` 声明该类型作业的合法运行上界——调度器在此之前
   * **不**把它当"无真实执行体"释放重排；与全局宽限取较大者。声明值应来自作业自身超时
   * （如 `project-init-brief` = `BRIEF_GENERATE_TIMEOUT_MS + 30s`），而非拍脑袋。
   */
  register(type: string, handler: JobHandler, opts: { orphanGraceMs?: number } = {}): void {
    this.handlers.set(type, handler);
    const grace = Number(opts.orphanGraceMs ?? 0);
    if (Number.isFinite(grace) && grace > 0) this.orphanGrace.set(type, Math.round(grace));
    else this.orphanGrace.delete(type);
  }

  /**
   * zx_20261111_1 B3：该作业类型的超龄宽限（ms）。
   * 声明值优先（与全局取较大者）；未声明且**无 taskId** 用保守缺省；其余走全局。
   */
  private orphanMsOf(type: string, hasTaskId: boolean): number {
    const global = inflightOrphanMs();
    const declared = this.orphanGrace.get(type) ?? 0;
    if (declared > 0) return Math.max(global, declared);
    if (!hasTaskId) return Math.max(global, DEFAULT_NO_TASK_ORPHAN_MS);
    return global;
  }

  /**
   * 添加即时作业。
   *
   * zx_20261023_3 批四（有据可查）：`ai-task` 作业**必须**带 `source`——实测 `28e6a12f` 载荷只有
   * `{taskId, projectId}`，事后无法从作业行判断"谁拉起来的"。漏网的这一发仍要能查：
   * 缺省补 `source:'unspecified'` 并告警——**兜底不是许可，是让漏网的那一发仍能被查到**。
   */
  async enqueue(type: string, payload: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    // 归一化唯一真源在 `job-enqueuer.ts`（与 `enqueueJob` 的裸插兜底共用一份，不各写一份）。
    const finalPayload = withJobSource(type, payload);
    this.db.prepare(
      'INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, ?, ?, ?)',
    ).run(id, type, JSON.stringify(finalPayload), 'pending');
    this.pending.set(this.pendingKey(id, finalPayload, type), { type, payload: finalPayload, jobId: id });
    return id;
  }

  // zx_20260930 M11-4（插头要插上 / 空性）：`batchEnqueue` 已**删除**——它自 D4 起就是"在册不在路"：
  //   全仓零调用方（`grep -rn 'batchEnqueue'` 在 src 下只剩它自己的定义），D4 想要的"同一层无依赖子任务并发"
  //   实际由 `scanReadyTasks` 每 10s 逐个入队承担。留着它的代价不是"没用"，而是**骗人**：
  //   读代码的人以为批量并发这条路存在、以为 `pendingKey` 有第二个维护点。
  //   若将来真需要批量入队，从 `enqueue` 抽一个循环即可——那时再写，而不是现在挂着。

  /** 添加定时作业 */
  async schedule(type: string, payload: Record<string, unknown>, runAt: Date): Promise<string> {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO wa_jobs (id, type, payload, status, scheduled_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, type, JSON.stringify(payload), 'pending', runAt.toISOString().replace('T', ' ').slice(0, 19));
    return id;
  }

  /** 启动调度器 */
  start(): void {
    this.running = true;
    // M14-3: 起手就给脉冲一个初值——否则"启动后头 1 秒内被问健康"会读出 1970 年那种陈旧。
    this._lastTickAt = Date.now();
    // zx_20261110_2 B2（损之又损）：**先合并重复**再谈恢复——同一 (type, taskId) 的多条 pending
    //   只留最新一条，其余置 done + `superseded_by_dedupe`（事故里三条 resume 同任务并存）。
    try { this.dedupePendingJobs(); } catch (e) { logger.warn({ err: e }, '启动去重失败（不阻断恢复）'); }
    // 恢复未完成作业：running状态的job转为resume处理
    const stale = this.db.prepare("SELECT * FROM wa_jobs WHERE status IN ('pending','running')").all() as Array<Record<string, unknown>>;
    for (const job of stale) {
      const payload = JSON.parse(job.payload as string || '{}') as { taskId?: string };
      // A3 (2026-09-04): 恢复时若任务已是终态（completed/failed/archived）则作业不复活、直接收尾。
      // zx_20261113_2 M18：收口后才该跑的 `task-postlude` / `background-review` **例外**——
      //   任务已终态正是它们的运行前提；不作废，否则完成通知/复盘在重启后被永久吞掉。
      if (payload.taskId && isTerminalTask(this.db, payload.taskId) && !isPostTerminalJobType(String(job.type))) {
        this.db.prepare("UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = 'superseded_by_terminal' WHERE id = ?").run(job.id as string);
        continue;
      }
      if (job.status === 'running' && job.type === 'ai-task') {
        // 运行时中断的AI任务，转为resume
        this.pending.set(this.pendingKey(job.id as string, payload, 'resume-ai-task'), { type: 'resume-ai-task', payload, jobId: job.id as string });
      } else {
        this.pending.set(this.pendingKey(job.id as string, payload, String(job.type)), { type: job.type as string, payload, jobId: job.id as string });
      }
    }
    logger.info({ recovered: stale.length, running: stale.filter(j => j.status === 'running').length }, '调度器已启动，恢复未完成作业');

    // zx_20260907 M5 修(2026-09-08): 恢复"孤立 running 任务"——上一进程遗留、无任何执行作业(pending/running ai-task)
    // 的 running 任务(如 GUI「执行」后进程重启、或裸插作业已被空转消费)在此重新入队 ai-task 真正执行。
    // 否则 running 既不被 scanReadyTasks(只扫 pending)拉、也无作业消费,成为永久僵尸"运行中"。
    // zx_20261022_2 批三: 启动对账与周期对账**共用一个查找器**（宽限期不同），逻辑不再各写一份。
    try {
      const n = this.reconcileOrphanRunningTasks(0, 'startup_reconcile_running');
      if (n > 0) logger.info({ orphanRunning: n }, '孤立的 running 任务已重新入队 ai-task');
    } catch (e) { logger.warn({ err: e }, '恢复孤立 running 任务失败'); }

    // 轮询间隔
    this.interval = setInterval(() => this.processPending(), 1000);
    this._scheduledTimer = setInterval(() => this.checkScheduled(), 5000);
    this._timeoutTimer = setInterval(() => this.checkTimeouts(), 30_000);
    // zx_20261022_2 批三: 运行期兜底——孤立刻 running 不再只等重启这一次偶然而被救起。
    this._scanTimer = setInterval(() => {
      // zx_20261022_3 批十二：撞顶续额自动续跑（先于 scanReadyTasks，使其见得到本任务已在队）。
      try { this.autoResumeStepCapPaused(); } catch (e) { logger.warn({ err: e }, '撞顶续额自动续跑失败'); }
      this.scanReadyTasks();
      this.reapGhostExecutionJobs();
      try {
        const n = this.reconcileOrphanRunningTasks(2, 'periodic_reconcile_running');
        if (n > 0) logger.info({ orphanRunning: n }, '周期对账：孤立的 running 任务已重新入队 ai-task');
      } catch (e) { logger.warn({ err: e }, '周期核对孤立 running 任务失败'); }
      // zx_20261110_2 B2：在途键对账——"键在、run 早没了"的键必须被释放并重排（事故那 55 分钟）。
      try { this.reconcileInflight(); } catch (e) { logger.warn({ err: e }, '在途键对账失败'); }
    }, 10_000);
    // P0.4 矛盾驱动优先级：每30分钟重新分析瓶颈
    this._bottleneckTimer = setInterval(() => this.runBottleneckAnalysis(), 30 * 60 * 1000);
    // 首次启动延迟5秒执行（等调度器恢复完成）
    setTimeout(() => this.runBottleneckAnalysis(), 5000);
    this._disposed = false;
  }

  /**
   * 把「孤立刻 running」的任务重新入队 ai-task（写库 + 入本调度器内存队列，两者同形）。
   * 启动路宽限 0（进程刚起，时间不是判据）；周期路宽限 2 分钟（刚置 running、作业在途者不动）。
   */
  private reconcileOrphanRunningTasks(graceMinutes: number, source: string): number {
    const orphans = findOrphanRunningTasks(this.db, graceMinutes);
    for (const t of orphans) {
      const payload = { taskId: t.id, projectId: t.project_id, source };
      const jid = randomUUID();
      this.db.prepare("INSERT INTO wa_jobs (id, type, payload, status, created_at) VALUES (?, 'ai-task', ?, 'pending', datetime('now'))")
        .run(jid, JSON.stringify(payload));
      this.pending.set(this.pendingKey(jid, payload, 'ai-task'), { type: 'ai-task', payload, jobId: jid });
    }
    return orphans.length;
  }

  stop(): void {
    this.running = false;
    this._disposed = true;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this._timeoutTimer) { clearInterval(this._timeoutTimer); this._timeoutTimer = null; }
    if (this._scheduledTimer) { clearInterval(this._scheduledTimer); this._scheduledTimer = null; }
    if (this._scanTimer) { clearInterval(this._scanTimer); this._scanTimer = null; }
    if (this._bottleneckTimer) { clearInterval(this._bottleneckTimer); this._bottleneckTimer = null; }
    // A1: 清理所有cron作业
    for (const [pid] of this.cronJobs) {
      this.unregisterCronJob(pid);
    }
  }

  /** 8.6: 检查executing任务是否超时（默认10分钟无心跳） */

  private checkTimeouts(): void {
    const MAX_PLANNING_MS = 30 * 60 * 1000;
    try {
      // zx_20260930 M11-3（只留一个终局裁定者）：执行态无心跳的**裁定**已归一处——
      //   `findStaleExecutingTasks`（判据）+ `reclaimStaleExecutingTask`（唯一处置：paused + exec_timeout）。
      //   此前本处自己写 SQL、自己 `markTaskFailed`，与自愈监视器的 `pauseTask` **同因两果**：
      //   同一件"10 分钟没心跳"，30s 一跳的这条路必然先扫到 ⇒ 实际结局恒为 `failed`，
      //   而"自愈"那条路从不生效（两套处置，只有一个真在跑）。
      //   `stabilizing` 不在共享状态集内（它是等人确认的冷却暂态，不是"卡死"）。
      const stale = findStaleExecutingTasks(this.db);
      for (const task of stale) {
        if (reclaimStaleExecutingTask(this.db, task)) {
          logger.warn({ taskId: task.id, title: task.title, lastHeartbeat: task.updated_at }, '任务超时已回收为暂停');
        }
      }

      // 检查planning状态超时（30分钟未退出计划模式→自动暂停）
      const planningTasks = this.db.prepare(
        "SELECT id, title, updated_at, project_id FROM wa_tasks WHERE status = 'planning'"
      ).all() as Array<{ id: string; title: string; updated_at: string; project_id: string }>;
      for (const pt of planningTasks) {
        const since = dbTimeMs(pt.updated_at);
        // 取不到时刻 ⇒ 判不了，不暂停（不凭猜处置活任务）。
        if (!Number.isNaN(since) && Date.now() - since > MAX_PLANNING_MS) {
          // zx_20260917 M1: 因由 `planning_timeout`——命名取自"**为什么**停"而非执行者
          //   （调度器是执行者，不算因；执行者信息在 label 与下方日志里，不丢）。
          pauseTask(this.db, { taskId: pt.id, reason: PAUSE_REASON_PLANNING_TIMEOUT });
          this.db.prepare(
            "INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?,?,?,?)"
          ).run(randomUUID(), pt.id, 'system',
            `[超时] 任务在计划模式停留超过${MAX_PLANNING_MS / 60000}分钟，已自动暂停。请手动恢复或重新启动。`);
          logger.warn({ taskId: pt.id, title: pt.title, stuckSince: pt.updated_at }, 'planning超时已暂停');
        }
      }
    } catch { /* timeout check best-effort */ }
  }

  /**
   * 检查任务的依赖是否可启动（"未满足"的唯一运行时判据）。
   *
   * zx_20260913 M3-2(名实相符 / 同一把尺): 判据细分归 `dep-graph.ts` 唯一真源——
   * 旧实现只有一把布尔尺（`status != 'completed'` 计数>0），把"还在跑"与"已失败永不满足"压成同一个 true，
   * 于是工具回话对两者一律许诺"依赖完成后自动启动"（假话）。现改由 `classifyDep` 分 `met/waiting/dead/unresolved`，
   * 本方法只取"是否因此不得启动"，**布尔值与旧实现逐情形等价**（查不到的依赖 id 本就不计数 ⇒ 不阻塞）。
   */
  hasUnmetDependencies(taskId: string): boolean {
    return depBlocksRun(this.depStateOf(taskId));
  }

  /**
   * 前置依赖的可解性状态（M3-2 新增读点；文案/展示由 `depBlockInfo` 生成，不自写第二份判据）。
   */
  depStateOf(taskId: string): DepState {
    // 判据与三条人工入口同取 `task-dep-gate`（一并取 `context_json`——`paused` 前置的可解性取决于因由）。
    return taskDepState(this.db, taskId);
  }

  /**
   * A2 (2026-09-03_3): 祖先链是否"已停摆"——存在 paused/failed/archived 的祖先任务则视为待决/放弃分支，
   * 其依赖就绪的后继子任务不应被自动拉起（须用户恢复父任务后才会因父完成再次触发）。
   *
   * zx_20260914(因等子而暂停不算停摆): 执行器收口时若子任务未完成会自置 paused 等子完成
   * （agent-executor.ts，pause_reason='children_incomplete'）。若把这种暂停也计入停摆，
   * 后继子任务就永不被拉起、父任务也就永等不到子完成 —— 互锁。故此类祖先**继续上溯**而不拦。
   * 判据取自 `pause-reason.ts` 唯一真源，勿在此另写一份。
   */
  private chainStalled(id: string): boolean {
    try {
      type AncRow = { id: string; parent_task_id: string | null; status: string; context_json?: string };
      const row = this.db.prepare('SELECT id, parent_task_id, status, context_json FROM wa_tasks WHERE id = ?').get(id) as AncRow | undefined;
      let cur: AncRow | undefined = row;
      while (cur?.parent_task_id) {
        cur = this.db.prepare('SELECT id, parent_task_id, status, context_json FROM wa_tasks WHERE id = ?').get(cur.parent_task_id) as AncRow | undefined;
        if (!cur) break;
        if (cur.status === 'failed' || cur.status === 'archived') return true;
        if (cur.status === 'paused' && !isChildrenIncompletePause(cur.context_json)) return true;
      }
    } catch { /* 查询失败不拦截 */ }
    return false;
  }

  /**
   * zx_20260909 Q2(幽灵作业)修：周期性收割两类"幽灵执行作业"，防堆积与 resume 静默死锁复发。
   * 1) 僵尸 running：作业已 running 很久(>30min)但其任务已不在执行/运行态(终态/暂停/等待) → 进程早已死，
   *    该 running 作业既不会被消费、又会让 hasPendingExecutionJob 恒 true 挡住后续 resume → 作废 done。
   * 2) 残留 pending：任务已 executing(真身已抢到 CAS 在跑)却还挂 >5min 的 pending 执行作业(并发/自动入队残留)
   *    → 作废(真身 CAS 已保证唯一，残留只会让后续 resume 误判"已有待执行作业")。
   * 保留 done 历史与 post 类 background-review，不触碰正常 executing 任务。
   */
  private reapGhostExecutionJobs(): void {
    try {
      const ghostRun = this.db.prepare(
        "SELECT j.id, j.payload FROM wa_jobs j WHERE j.status = 'running' AND j.type IN ('ai-task','resume-ai-task') AND j.started_at IS NOT NULL AND datetime(j.started_at) <= datetime('now', '-30 minutes')"
      ).all() as Array<{ id: string; payload: string }>;
      for (const j of ghostRun) {
        const m = /%"taskId":"([^"]+)"%/.exec(j.payload || '');
        const tid = m ? m[1] : ((j.payload || '').match(/"taskId":"([^"]+)"/)?.[1] ?? null);
        if (!tid) { this.db.prepare("UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = 'ghost_reaped' WHERE id = ?").run(j.id); continue; }
        const t = this.db.prepare("SELECT status FROM wa_tasks WHERE id = ?").get(tid) as { status?: string } | undefined;
        if (!t || !['executing', 'running'].includes(t.status as string)) {
          this.db.prepare("UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = 'ghost_reaped' WHERE id = ?").run(j.id);
        }
      }
      const pendResid = this.db.prepare(
        "SELECT j.id, j.payload FROM wa_jobs j WHERE j.status = 'pending' AND j.type IN ('ai-task','resume-ai-task') AND datetime(j.created_at) <= datetime('now', '-5 minutes')"
      ).all() as Array<{ id: string; payload: string }>;
      for (const j of pendResid) {
        const tid = (j.payload || '').match(/"taskId":"([^"]+)"/)?.[1];
        if (!tid) continue;
        const t = this.db.prepare("SELECT status FROM wa_tasks WHERE id = ?").get(tid) as { status?: string } | undefined;
        if (t && ['executing', 'running'].includes(t.status as string)) {
          this.db.prepare("UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = 'superseded_by_execution' WHERE id = ?").run(j.id);
        }
      }
    } catch { /* best-effort */ }
  }

  /**
   * zx_20261022_3 批十二（实事求是）：**撞顶续额自动续跑**。
   *
   * 判据唯一真源 `shouldAutoResumeOnStepCap`（step-budget.ts，rr 直跑）；本项目是否该被扫取
   * `projectScanVerdict`（与 `scanReadyTasks` 同一把尺）。标记 `step_cap_hit.auto_resumed`
   * 防同一笔续额被反复拉起——续额次数仍有界（`STEP_CAP_GRANT_LIMIT`），不构成无限火。
   */
  private autoResumeStepCapPaused(): void {
    const rows = this.db.prepare(
      "SELECT t.id, t.project_id, t.context_json, p.status AS pstatus, p.context_json AS pctx FROM wa_tasks t JOIN wa_projects p ON p.id = t.project_id WHERE t.status = 'paused'",
    ).all() as Array<{ id: string; project_id: string; context_json: string | null; pstatus: string; pctx: string | null }>;
    const now = new Date();
    for (const r of rows) {
      if (this.pending.has(r.id) || this.inflight.has(r.id)) continue;
      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(r.context_json || '{}') as Record<string, unknown>; } catch { continue; }
      const decision = shouldAutoResumeOnStepCap(ctx);
      if (!decision.due) {
        // zx_20261104_1 M9：被暂停因由闸挡下时留一笔 debug（仅当确有未消费的撞顶账，避免普通暂停刷屏）
        const hit = ctx.step_cap_hit as Record<string, unknown> | undefined;
        if (hit && typeof hit === 'object' && !hit.auto_resumed) {
          logger.debug({ taskId: r.id.slice(0, 8), pause_reason: ctx.pause_reason ?? '', reason: decision.reason }, '撞顶续额：闸挡下，不自动续跑');
        }
        continue;
      }
      if (!projectScanVerdict({ status: r.pstatus, context_json: r.pctx }, now).scan) continue;
      try {
        const hit = (ctx.step_cap_hit ?? {}) as Record<string, unknown>;
        hit.auto_resumed = new Date().toISOString();
        ctx.step_cap_hit = hit;
        this.db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now'), context_json = ? WHERE id = ? AND status = 'paused'")
          .run(JSON.stringify(ctx), r.id);
        const changed = (this.db.prepare("SELECT status FROM wa_tasks WHERE id = ?").get(r.id) as { status: string } | undefined)?.status;
        if (changed !== 'pending') continue; // CAS 落空（他路已处置）
        eventBus.emit('task.status_changed', { taskId: r.id, task_id: r.id, projectId: r.project_id, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
        const message = `[系统] ${decision.reason}——请按原目标继续推进；若确已收口请直接 finalize_task。`;
        this.pending.set(r.id, { type: 'resume-ai-task', payload: { taskId: r.id, projectId: r.project_id, message } });
        logger.info({ taskId: r.id.slice(0, 8), grants: decision.grants, limit: decision.limit }, '撞顶续额：已自动续跑');
      } catch (e) { logger.warn({ err: e, taskId: r.id.slice(0, 8) }, '撞顶续额自动续跑落库失败'); }
    }
  }

  /** 9.6: 扫描所有项目的就绪任务，自动入队并行执行（每项目上限见 `resolveProjectConcurrency`） */
  private scanReadyTasks(): void {
    const now = new Date();
    try {
      // zx_20260930 M11-7（如实·不留静默分叉）：候选集从 `WHERE status = 'active'` 改为**取全部项目**，
      //   逐个过 `projectScanVerdict`。此前两条件各写一段内联 `continue`——`WHERE status='active'`
      //   把非 active 项目**整个摘出结果集**（连"为什么不扫"都无从得知），窗口那处 `continue` 也不留痕。
      //   叠加后：项目一被暂停/完成/归档，其 `pending` 任务就**永久悬空且无人知晓**（界面照旧假装"排队中"）。
      //   现在不扫的一律带**显式理由**落日志，且该类待办会被 `healthViews.manager.parkedTaskCount` 计数上屏。
      const projects = this.db.prepare('SELECT id, status, context_json FROM wa_projects').all() as Array<{ id: string; status: string; context_json: string | null }>;
      for (const proj of projects) {
        try {
          const verdict = projectScanVerdict(proj, now);
          if (!verdict.scan) {
            // 只在**该项目名下真有 pending 待办**时才出声（否则每个已归档项目每 10s 刷一行噪声）
            const pendingCount = (this.db.prepare(
              "SELECT COUNT(*) AS c FROM wa_tasks WHERE project_id = ? AND status = 'pending'",
            ).get(proj.id) as { c: number }).c;
            if (pendingCount > 0) {
              logger.info({ projectId: proj.id, pendingCount, reason: verdict.reason }, '项目本轮不自动拉起（待办搁置）');
            }
            continue;
          }
          // zx_20260929 M5-d: 上限与占位改取唯一真源——此前此处写 `rhythm.maxConcurrency ?? 2` 且只数
          //   `executing`，与硬闸（`ai-task` 写死 3、数 executing+preparing+planning）**两套表**：
          //   同一项目两处给出不同上限、不同分母，谁先撞上取决于哪条路先到（软闸判"位子空着"而超发）。
          const conc = resolveProjectConcurrency(this.db, proj.id);
          if (conc.available === 0) continue;
          // zx_20260930 M11-6（先过滤、后切片）：原为 `getReadyTasks().slice(0, available)`——**先切后滤**，
          //   被切掉的那一段里若有本可入队的（链上已有在途、已在内存队列），本轮的位子就**白空着**：
          //   切出 3 条、滤掉 2 条 ⇒ 只入队 1 条，而项目其实还能再起 2 个（取决于待办里的排列顺序）。
          //   改为候选**全量**过筛选，就地计数到 `available` 为止；`getReadyTasks` 的排序仍是优先级来源。
          const ready = this.getReadyTasks(proj.id);
          // zx_20261011_4 M1（不留静默分叉）：本项目若有"已外派他机"的 pending 子任务，把"它为何没被拉起"
          //   说白（仿上 parked 的理由日志）。判据与 `getReadyTasks` 的排除**同源**（`isRemoteBlocked`：
          //   zx_20261018_3 批三起，已外派与派单在途（占位未过期）共用这一把尺）。
          const remotePending = countRemoteAssignedPending(this.db as unknown as OrchestrateDb, proj.id);
          if (remotePending > 0) {
            logger.debug({ projectId: proj.id, remotePending }, '本项目有子任务已外派他机，本机不抢跑（等远端回传）');
          }
          // 本批次已入队者——链上至多一个在跑（zx_20260917 M5-1）：现有循环一次可同时选中 pending 父与其 pending 子
          const selectedThisPass = new Set<string>();
          for (const task of ready) {
            if (selectedThisPass.size >= conc.available) break;
            const taskId = task.id as string;
            // zx_20261028_1 M1：「已排队」与「正在跑」同等对待——后者此前不在 `pending` 里，被当成空闲而二次入队。
            if (this.pending.has(taskId) || this.inflight.has(taskId)) continue;
            // A2 (2026-09-03_3): 祖先链有 paused/failed/archived 时不自动拉起（防"暂停后依赖链又自动执行"）
            if (this.chainStalled(taskId)) continue;
            // zx_20260917 M5-1: 「链上至多一个在跑」——直接父在跑 / 名下有后代在跑或已排作业 / 本批次已选中链上亲属
            // （一并取代 zx_20260909 #7b 的 `directParentBusy`；真源在 `core/task-chain.ts`，与 `create_task` 共用）
            const chainBlock = chainBlockReason(this.db, taskId, selectedThisPass);
            if (chainBlock) {
              logger.debug({ taskId, reason: chainBlock }, '链上已有在途任务，跳过本轮自动拉起');
              continue;
            }
            // zx_20260916_1 M5 (#6): 本路径**不写 `wa_jobs`**（只是内存 `pending`），故作业类型全由此定——
            //   此前一律标 `resume-ai-task`，于是**从没跑过**的任务首跑也被当"恢复"：处理器会合成
            //   "你之前的任务已恢复…检查已有文件的进度"（对没跑过的任务是假话），并把恢复账虚增一次。
            //   按有无执行痕迹（对话里出现过 assistant/tool 行）分流：跑过才恢复，没跑过走 `ai-task` 首跑。
            //   `projectId` 必须带上——`ai-task` 处理器用它算项目并发（`resume-ai-task` 缺省时自查库，故此前可不传）。
            const prevRunCount = (this.db.prepare(
              `SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ? AND role IN (${EXECUTION_TRACE_ROLES.map(() => '?').join(',')})`
            ).get(taskId, ...EXECUTION_TRACE_ROLES) as { c: number }).c;
            this.pending.set(taskId, { type: autoPullJobType(prevRunCount), payload: { taskId, projectId: proj.id } });
            selectedThisPass.add(taskId);
          }
        } catch { /* skip malformed project config */ }
      }
    } catch { /* best-effort */ }
  }

  /**
   * 获取项目中所有依赖已满足的待执行任务（含动态优先级）。
   *
   * zx_20260924_1 M3-a（J-6）：`ORDER BY priority DESC` 这一格对**拆解出来的子任务**读的是
   * **拆解序号**（模板序）——写侧由 `decomposePriority(planned, i)` 落成 `planned-i`（3 个 ⇒ 3/2/1），
   * 于是模板里的第 1 个在 DESC 下**最先起跑**（改前写裸 `i` ⇒ 最后一个反而最先跑）。
   * ⚠ `priority` 在 `task:create` / `create_subtask` / GUI 编辑那几条路上装的是**用户优先级（0–3）**，
   *   两种语义同列并存是既有事实；本读点**不区分来源**（同一列只能有一种排序口径）。
   * ⚠ 已有同样自洽的替代改法（"拆解一律写 0 + 此处加 `rowid ASC` 稳定序"）**已裁定不采用**（J-6）
   *   ⇒ 不并存，别再引入第二套序。
   */
  getReadyTasks(projectId: string): Array<Record<string, unknown>> {
    const tasks = this.db.prepare(
      "SELECT * FROM wa_tasks WHERE project_id = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC",
    ).all(projectId) as Array<Record<string, unknown>>;
    const ready = tasks
      .filter(t => !this.hasUnmetDependencies(t.id as string))
      // zx_20261011_4 M1（知止）：**已外派他机**的子任务让位——本机不抢跑（判据一处真源 `node-orchestrate`）。
      //   让位于此、理由日志在 `scanReadyTasks`（两处同一判据，不自写第二份）。
      // zx_20261018_3 批三：让位面从"三键齐备"扩到"三键 ∨ 派单在途占位"——ANS 回包前的那一小段，
      //   任务与"没派过"毫无区别，调度器与对端会双跑同一件活。占位过期（进程崩在回包前）即不再让位。
      .filter(t => !isRemoteBlocked(t.context_json as string | Buffer | null | undefined));

    // zx_20261023_5 批一（孙子·先为不可胜）：**关键路径优先**——同优先级下，依赖链更长的先启动。
    //   无依赖任务的深度为 0，原顺序逐字不变（只有"真有长链"的项目才会看到差别）。
    //   开关 `sched.critical_path` 缺省即开（`boolSetting` 判"只有明确说关才算关"）。
    let criticalPathOn = true;
    try {
      const sw = this.db.prepare("SELECT value FROM wa_settings WHERE key = 'sched.critical_path'").get() as { value?: string } | undefined;
      criticalPathOn = boolSetting(sw?.value);
    } catch { /* 库/表不可读 ⇒ 缺省开（承 boolSetting 的缺省语义） */ }
    let depth: Map<string, number> | null = null;
    if (criticalPathOn && ready.length > 1) {
      try {
        const all = this.db.prepare('SELECT id, depends_on FROM wa_tasks WHERE project_id = ?').all(projectId) as Array<{ id?: unknown; depends_on?: unknown }>;
        const depMap = new Map(all.map((r) => [String(r.id ?? ''), parseDepIds(r.depends_on)]));
        // ⚠ 必须喂**全项目** id：深度是"从该任务到链尾还剩几跳"，只喂就绪集则链首看不到后续依赖 ⇒ 恒为 0。
        depth = criticalPathDepths(all.map((r) => String(r.id ?? '')), (id) => depMap.get(id) ?? []);
      } catch { depth = null; /* 读不到依赖图 ⇒ 本次不按深度排，绝不因此漏掉就绪任务 */ }
    }

    // P0.4: 有动态优先级时按动态优先级二次排序
    const hasDynamic = ready.some(t => {
      try {
        const ctx = JSON.parse((t.context_json as string) || '{}');
        return typeof ctx.dynamic_priority === 'number';
      } catch { return false; }
    });
    if (hasDynamic) {
      ready.sort((a, b) => {
        const pa = (() => { try { return JSON.parse((a.context_json as string) || '{}').dynamic_priority || 0; } catch { return 0; } })();
        const pb = (() => { try { return JSON.parse((b.context_json as string) || '{}').dynamic_priority || 0; } catch { return 0; } })();
        if (pb !== pa) return pb - pa;
        const da = depth?.get(String(a.id ?? '')) ?? 0;
        const db2 = depth?.get(String(b.id ?? '')) ?? 0;
        if (db2 !== da) return db2 - da;
        return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
      });
    } else if (depth) {
      ready.sort((a, b) => {
        const pa = Number(a.priority ?? 0);
        const pb = Number(b.priority ?? 0);
        if (pb !== pa) return pb - pa;
        const da = depth!.get(String(a.id ?? '')) ?? 0;
        const db2 = depth!.get(String(b.id ?? '')) ?? 0;
        if (db2 !== da) return db2 - da;
        return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
      });
    }
    return ready;
  }

  /** P0.4 矛盾驱动优先级：对所有活跃项目运行瓶颈分析 */
  private runBottleneckAnalysis(): void {
    try {
      const projects = this.db.prepare("SELECT id FROM wa_projects WHERE status = 'active'").all() as Array<{ id: string }>;
      let totalPrincipals = 0;
      for (const proj of projects) {
        try {
          const { principalContradiction } = analyzeProjectBottlenecks(this.db, proj.id);
          if (principalContradiction) totalPrincipals++;
        } catch (e) { logger.warn({ err: e, projectId: proj.id }, '瓶颈分析单项目失败'); }
      }
      logger.info({ projectCount: projects.length, principalCount: totalPrincipals }, '[矛盾分析] 全项目瓶颈分析完成');
    } catch (e) { logger.warn({ err: e }, '瓶颈分析周期性任务失败'); }
  }

  /** P0.4: 手动触发单项目瓶颈分析 */
  analyzeProjectBottlenecks(projectId: string): ReturnType<typeof analyzeProjectBottlenecks> {
    return analyzeProjectBottlenecks(this.db, projectId);
  }

  private async processPending(): Promise<void> {
    // M14-3: 脉冲记在**提前返回之前**——空转（`pending` 为空）同样是"调度器还活着"的证据。
    this._lastTickAt = Date.now();
    if (this.pending.size === 0) return;
    // C6: 按任务优先级排序(高优先级先执行)，单轮取数批见 JOB_BATCH_SIZE（与项目并发上限是两个概念）
    const jobs = Array.from(this.pending.entries());
    // zx_20261028_1 M1：优先级**一次批量取**（原为比较器里逐条 `SELECT priority … WHERE id = ?`，
    //   10s 一跳、每条目两次查库——N+1，且比较器每轮被调多次）。查不到的按 0（与旧值同）。
    const prio = this.priorityByTaskId(jobs.map(([, j]) => (j.payload as { taskId?: string })?.taskId));
    jobs.sort(([, a], [, b]) => {
      const pidA = (a.payload as {taskId?:string})?.taskId;
      const pidB = (b.payload as {taskId?:string})?.taskId;
      if (!pidA || !pidB) return 0;
      return (prio.get(pidB) ?? 0) - (prio.get(pidA) ?? 0); // 降序：高优先级先执行
    });
    const batch = jobs.slice(0, JOB_BATCH_SIZE);
    const promises = batch.map(async ([key, job]) => {
      const handler = this.handlers.get(job.type);
      if (!handler) return;
      // zx_20261028_1 M1：同键已在跑 ⇒ 本轮不动，条目**留在 `pending`**（下一跳再看），不并发两份。
      // zx_20261110_2 B2（功遂身退）：**"键在"不再等于"在跑"**——必须有一个真实执行体兑现它。
      //   三者任一为真即让位：① 该任务有在途 run（`hasTaskRun`，真在跑）；② 键龄未超宽限（刚起跑）。
      //   否则（键在、run 早没了、还超了宽限）⇒ **释放该键并继续处理当前作业**，不再静默 return。
      //   这一条正是事故 339ef167 那 55 分钟的直接成因：三条恢复作业排在同一把"死钥匙"后面。
      const taskIdOfJob = (job.payload as { taskId?: string } | null | undefined)?.taskId;
      const existing = this.inflight.get(key);
      if (existing) {
        const stillLive = !!taskIdOfJob && hasTaskRun(taskIdOfJob);
        const age = this._now() - existing.startedAt;
        const graceMs = this.orphanMsOf(existing.type, !!taskIdOfJob);
        if (stillLive || age < graceMs) return;
        this.releaseInflight(key, 'inflight_orphan_released', { requeue: false });
        logger.warn({ key, ageMs: age, graceMs, taskId: String(taskIdOfJob ?? '').slice(0, 8) },
          '在途键无真实执行体且已超宽限——已释放该键，继续处理当前作业');
      }
      // zx_20260929 M5-d: `pending` 的键已归一（见 pendingKey），真实作业行 id 只在 `jobId` 里。
      //   软闸（scanReadyTasks）那条路**不写 wa_jobs**，其条目无 jobId ⇒ 下列三条 UPDATE 一律跳过，
      //   不再假装"有作业行可更新"（此前用 taskId 当 id 去更新，恒 0 行、沉默空转）。
      const jobId = (job as { jobId?: string }).jobId;
      // zx_20261110_2 B2：本次处理持有**自己的** runToken——`finally` 只删自己那一把（旧 run 不得删新键）。
      const runToken = randomUUID();
      this.inflight.set(key, {
        taskId: String(taskIdOfJob ?? ''),
        jobId,
        type: job.type,
        payload: job.payload,
        startedAt: this._now(),
        runToken,
        requeues: Math.max(existing?.requeues ?? 0, this._requeues.get(key) ?? 0),
      });
      this.pending.delete(key);
      if (jobId) this.db.prepare("UPDATE wa_jobs SET status = ?, started_at = datetime('now') WHERE id = ?").run('running', jobId);
      try {
        await handler(job.payload);
        if (jobId) this.db.prepare("UPDATE wa_jobs SET status = ?, completed_at = datetime('now') WHERE id = ?").run('done', jobId);
      } catch (err) {
        const rows = jobId
          ? this.db.prepare('SELECT retry_count, max_retries FROM wa_jobs WHERE id = ?').get(jobId) as { retry_count: number; max_retries: number } | undefined
          : undefined;
        const retries = (rows?.retry_count ?? 0) + 1;
        const maxRetries = rows?.max_retries ?? 3;
        // P1.1 烹小鲜：指数退避 1min→5min→15min→1h（最大1小时，避免60s过短）
        const backoffSteps = [60_000, 300_000, 900_000, 3_600_000];
        const backoffMs = backoffSteps[Math.min(retries - 1, backoffSteps.length - 1)] || 60_000;
        if (retries < maxRetries) {
          setTimeout(() => {
            if (this._disposed) return;
            if (jobId) this.db.prepare('UPDATE wa_jobs SET status = ?, retry_count = ?, error = ? WHERE id = ?').run('pending', retries, String(err), jobId);
            this.pending.set(key, job);
          }, backoffMs);
        } else if (jobId) {
          this.db.prepare('UPDATE wa_jobs SET status = ?, error = ? WHERE id = ?').run('failed', String(err), jobId);
        }
        logger.error({ id: jobId, key, type: job.type, retries, backoffMs, error: String(err) }, '作业执行失败');
      } finally {
        // 无论成败/重试，键在本次处理结束时归零——重试条目已由 catch 里的 setTimeout 重新入 `pending`。
        // zx_20261110_2 B2：**只删自己的那一把**（按 runToken 比对）——
        //   旧 run 收尾时新 run 可能已占住同一个键（resume/重试交叠），无脑 delete 会把新键删掉。
        this.releaseInflightToken(key, runToken, 'finished');
      }
    });
    await Promise.all(promises);
  }

  /** zx_20261110_2 B2: 仅在**仍是自己**时移除该键（按 runToken 比对）。 */
  private releaseInflightToken(key: string, runToken: string, reason: string): void {
    const cur = this.inflight.get(key);
    if (!cur || cur.runToken !== runToken) return;
    this.inflight.delete(key);
    if (reason !== 'finished') logger.info({ key }, '在途键已释放');
  }

  /**
   * zx_20261110_2 B2: 释放一条在途键（**唯一释放口**——守卫处与周期对账共用）。
   *
   * `requeue=true` ⇒ 把对应的 `wa_jobs` 行放回 `pending` 并塞回内存队列（周期对账用：没有新作业时自己重排）；
   * `requeue=false` ⇒ 该行如实收尾为 `done` 并带因由（守卫处用：马上就有新作业接手，旧行不该再跑一遍）。
   * 重排次数以 `INFLIGHT_MAX_REQUEUES` 封顶，超限 ⇒ 该行记 `failed` + `error='stalled_after_requeue'`，
   * 不再无限"卡死—重排"。
   */
  private releaseInflight(key: string, reason: string, opts: { requeue: boolean }): void {
    const entry = this.inflight.get(key);
    if (!entry) return;
    this.inflight.delete(key);
    const jobId = entry.jobId;
    if (!jobId) { logger.info({ key, reason }, '在途键已释放（无作业行）'); return; }
    if (opts.requeue) {
      const next = entry.requeues + 1;
      if (next > INFLIGHT_MAX_REQUEUES) {
        try {
          this.db.prepare("UPDATE wa_jobs SET status = 'failed', completed_at = datetime('now'), error = ? WHERE id = ?")
            .run('stalled_after_requeue', jobId);
        } catch { /* best-effort */ }
        logger.error({ key, jobId, requeues: entry.requeues, reason }, '在途作业重排次数到顶，如实置为失败（不再重排）');
        eventBus.emit('job.requeue_exhausted', { jobId, taskId: entry.taskId, type: entry.type, requeues: entry.requeues }).catch(() => {});
        return;
      }
      try {
        this.db.prepare("UPDATE wa_jobs SET status = 'pending', completed_at = NULL, error = ? WHERE id = ?").run(reason, jobId);
        this.pending.set(key, { type: entry.type, payload: entry.payload, jobId });
      } catch { /* best-effort */ }
      // 计数挂在**新条目**上（键已被删，故不能读旧值）——下次释放仍从这里继续累加。
      this._requeues.set(key, next);
      logger.warn({ key, jobId, requeues: next, reason }, '在途作业无真实执行体，已释放并重排');
      eventBus.emit('job.inflight_requeued', { jobId, taskId: entry.taskId, type: entry.type, requeues: next, reason }).catch(() => {});
      return;
    }
    try {
      this.db.prepare("UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = ? WHERE id = ? AND status = 'running'")
        .run(reason, jobId);
    } catch { /* best-effort */ }
    logger.warn({ key, jobId, reason }, '在途键如实收尾（无真实执行体）');
    eventBus.emit('job.inflight_released', { jobId, taskId: entry.taskId, type: entry.type, reason }).catch(() => {});
  }

  /** 各键累计重排次数（键被删后仍要记住——否则封顶形同虚设）。 */
  private _requeues = new Map<string, number>();

  /**
   * zx_20261110_2 B2: **周期对账**——把"键在、run 早没了、还超龄"的在途键释放并重排。
   * 返回本轮释放数（供日志与断言）。不碰有真实 run 的键（那是合法在跑）。
   */
  reconcileInflight(): number {
    const now = this._now();
    let released = 0;
    for (const [key, e] of Array.from(this.inflight.entries())) {
      if (e.taskId && hasTaskRun(e.taskId)) continue;
      if (now - e.startedAt < this.orphanMsOf(e.type, !!e.taskId)) continue;
      const requeues = Math.max(e.requeues, this._requeues.get(key) ?? 0);
      this.inflight.set(key, { ...e, requeues });
      this.releaseInflight(key, 'inflight_orphan_reconcile', { requeue: true });
      released++;
    }
    if (released > 0) logger.warn({ released }, '周期对账：在途键无真实执行体，已释放并重排');
    return released;
  }

  /**
   * zx_20261110_2 B7: **用户"释放并重排"的落点**——把该任务的全部在途键与残留执行作业一次性清掉。
   *
   * 与 `reconcileInflight` 同一把尺（都按 `hasTaskRun` 判），差别只在**由谁发起**：
   * 一个自己发现，一个由 GUI 的 `task:releaseAndRequeue` 点名。返回被清的作业 id（审计用）。
   */
  releaseTaskRun(taskId: string, reason = 'released_by_user'): string[] {
    const jobIds: string[] = [];
    for (const [key, e] of Array.from(this.inflight.entries())) {
      if (e.taskId !== taskId) continue;
      if (e.jobId) jobIds.push(e.jobId);
      this.inflight.delete(key);
    }
    // 残留的 pending/running 执行作业一并作废——否则 `hasPendingExecutionJob` 仍会挡住后续恢复。
    try {
      const rows = this.db.prepare(
        "SELECT id FROM wa_jobs WHERE status IN ('pending','running') AND type IN ('ai-task','resume-ai-task') AND payload LIKE ?",
      ).all(`%"taskId":"${taskId}"%`) as Array<{ id: string }>;
      for (const r of rows) jobIds.push(r.id);
      this.db.prepare(
        "UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = ? WHERE status IN ('pending','running') AND type IN ('ai-task','resume-ai-task') AND payload LIKE ?",
      ).run(reason, `%"taskId":"${taskId}"%`);
    } catch { /* best-effort */ }
    // 内存队列里同键的条目也一并清（否则下一秒又被取起来跑）
    this.pending.delete(taskId);
    // 去重后返回（同一条 running 作业会先经在途键、再经库查出，审计列表不该出现两遍）
    const unique = Array.from(new Set(jobIds));
    logger.warn({ taskId: taskId.slice(0, 8), jobIds: unique.length, reason }, '按任务释放了在途键与残留执行作业');
    return unique;
  }

  /** 仅供 rr：注入假时钟（生产不调用）。 */
  setClock(fn: () => number): void {
    this._now = fn;
  }

  /**
   * zx_20261110_2 B2（损之又损）：**启动去重**——同一 `(type, taskId)` 的多条 pending/running 只留最新一条。
   *
   * 病根：事故里同一任务三条 `resume-ai-task`（13:48:54 / 13:53:49 / 13:56:53）并存，
   * 前两条被 `superseded_by_*` 收尾、第三条在队 55 分钟；重复本身把"一次恢复"变成"三份排队"。
   * 只合并**带 taskId** 的作业（`embed-memory` 这类无归属作业不受影响）；保留**最新**一条，
   * 其余置 `done` + `error='superseded_by_dedupe'`（不物理删，事后可查）。
   * @returns 实际合并掉的条数
   */
  dedupePendingJobs(): number {
    let rows: Array<{ id: string; type: string; payload: string; created_at: string }>;
    try {
      rows = this.db.prepare(
        "SELECT id, type, payload, created_at FROM wa_jobs WHERE status IN ('pending','running') ORDER BY created_at DESC, rowid DESC",
      ).all() as Array<{ id: string; type: string; payload: string; created_at: string }>;
    } catch { return 0; }
    const seen = new Set<string>();
    let merged = 0;
    for (const r of rows) {
      let taskId = '';
      try { taskId = String((JSON.parse(r.payload || '{}') as { taskId?: unknown }).taskId ?? ''); } catch { /* 坏载荷不参与去重 */ }
      if (!taskId) continue;
      const gk = `${r.type}\u0000${taskId}`;
      if (!seen.has(gk)) { seen.add(gk); continue; }
      try {
        this.db.prepare("UPDATE wa_jobs SET status = 'done', completed_at = datetime('now'), error = 'superseded_by_dedupe' WHERE id = ?").run(r.id);
        merged++;
      } catch { /* best-effort */ }
    }
    if (merged > 0) logger.warn({ merged }, '启动去重：同 (type, taskId) 的重复待执行作业已合并（保留最新一条）');
    return merged;
  }

  /** zx_20261028_1 M1：`pending` 里各条目的优先级一次批量取（`SQLITE_MAX_VARIABLE_NUMBER` 友好，400 一批）。 */
  private priorityByTaskId(taskIds: Array<string | undefined>): Map<string, number> {
    const out = new Map<string, number>();
    const unique = Array.from(new Set(taskIds.filter((id): id is string => !!id)));
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400);
      if (chunk.length === 0) continue;
      try {
        const rows = this.db.prepare(
          `SELECT id, priority FROM wa_tasks WHERE id IN (${chunk.map(() => '?').join(',')})`,
        ).all(...chunk) as Array<{ id: string; priority: number | null }>;
        for (const r of rows) out.set(r.id, r.priority ?? 0);
      } catch (e) {
        logger.warn({ err: e, count: chunk.length }, '批量取优先级失败，本批按 0 排序');
      }
    }
    return out;
  }

  private checkScheduled(): void {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const due = this.db.prepare("SELECT * FROM wa_jobs WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= ?").all(now) as Array<Record<string, unknown>>;
    for (const job of due) {
      const payload = JSON.parse(job.payload as string || '{}');
      this.pending.set(this.pendingKey(job.id as string, payload, String(job.type)), { type: job.type as string, payload, jobId: job.id as string });
    }
  }
}
