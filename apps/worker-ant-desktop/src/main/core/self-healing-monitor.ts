/**
 * P1.7 反者道之动——自愈监控。
 * 周期性全系统健康扫描，检测异常时自动修复，记录自愈日志。
 * 同一异常24h内≥3次停止自愈并报警。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import { eventBus } from './event-bus.js';
import { setDeliverableStatus } from './deliverable-lifecycle.js';
import { PAUSE_REASON_EXEC_TIMEOUT, PAUSE_REASON_PLANNING_TIMEOUT, PAUSE_REASON_STALE_TIMEOUT, PAUSE_REASON_STARTUP_SWEEP, PAUSE_REASON_ABNORMAL_END, recordedPauseReason } from './pause-reason.js';
import { pauseTask } from './pause-task.js';
// zx_20260921 M7（D4 断点④）: 前置可解性判据与如实文案取**唯一真源**（不在此另写一份"前置是不是死了"）
import { classifyDep, depBlockInfo, depBlocksRun, hasUnrecoverableDep, parseDepIds } from './dep-graph.js';
import { markTaskFailed } from './task-terminal.js';
// zx_20260929 M5-b（D5 父子互锁）: 派发作业取**唯一入口**（写库 **并**入调度器内存队列，见该模块头注释）——
//   裸插 `wa_jobs` 在运行期不被消费，正是该模块已经修过三次的病根，此处不重犯。
import { enqueueJob } from './job-enqueuer.js';
// zx_20260921 M7（D4 断点④）: 收敛后父的因由升级走引擎那四处**同一个**判定（罗尔斯·同一把尺）
import { checkParentTaskAfterChildDone } from './jobs/ai-task.js';
// zx_20260930 M14-1: 结果态词表取**唯一真源**（`healing-outcome.ts`，零 import 故 renderer 也能引它取标签）
//   ——本文件只写不译，界面只译不写；两边共一份词，改词只改那一处。
import { outcomeIsSuccess, type HealOutcome } from './healing-outcome.js';
// zx_20261016_3 批二（M33-a）: 熔断产出的"对策"落到行为——项目级策略熔断（只降不升）取 `feedback-engine` 真源。
import { setStrategyBreaker, STRATEGY_BREAKER_HOURS } from './feedback-engine.js';
// zx_20261016_3 批二（M34 半边）: "能改变引擎行为的东西"一律先落 `pending` 提案，经人工闸才生效。
import { recordProposal, hasPendingProposalFor, ensureSelfEvolveTable, type SelfEvolveKind } from './self-evolve.js';

const logger = createLogger('healing');

/**
 * 读取面的一行（键名与 DB 列同名：id/anomaly/action/success/outcome/detail/created_at）。
 *
 * zx_20260930 M14-1: 多一列 `outcome`（五态）。`success` **保持二值原义**（只有 `healed` 为 1）——
 * 老读点（含 `rr_zx_20260924_1_b6` D-5/D-6）一字不改仍成立；新读点用 `healOutcomeOf(row)` 取五态，
 * 存量行（`outcome` 为 NULL）由它按 `success` 如实回退。
 */
export interface HealingRecord {
  id: string;
  anomaly: string;
  action: string;
  success: number;
  outcome: string | null;
  detail: string | null;
  created_at: string;
}

/**
 * zx_20260924_1 M6（F7）：`wa_self_healing_logs` 此前**只写不读**——建表在下方 `startSelfHealingMonitor`，
 * 全仓唯一"读"是 `tryHeal` 里那个 24h 熔断 COUNT（消费的是**计数**不是**记录**）。用户裁定把这本账
 * **接进诊断页**（"最近自愈记录"），故在此开一个**只读**出口，与写入方同处一文件（改表结构时两者一起看见）。
 *
 * 为什么不放在 `ipc/admin.ipc.ts`：那个文件顶层 `import { ipcMain } from 'electron'`，受控回归 import
 * 不起来 ⇒ 把读取写在那里等于"没有判据可写"（只能靠目视证明它接上了）。
 *
 * 空集是合法状态：表未建（监控从未启动）或尚无记录都返回 `[]`，**不抛**——界面自己说"暂无自愈记录"，
 * 不许拿空白冒充"一切正常"。`limit` 有界（1..200），缺省 10。
 */
export function readRecentHealingLogs(db: Database.Database, limit = 10): HealingRecord[] {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 10));
  try {
    return db.prepare(
      'SELECT id, anomaly, action, success, outcome, detail, created_at FROM wa_self_healing_logs ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(n) as HealingRecord[];
  } catch {
    return [];
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;
let _startupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 自愈日志建表语句（唯一真源）：生产建表与受控回归夹具**同引此处**——夹具自己手抄一份的话，
 * 一旦生产加了列，夹具会悄悄变"窄"（读语句抛错被 catch 吞成空数组）⇒ 断言假绿。
 */
export const SELF_HEALING_LOGS_DDL = `
  CREATE TABLE IF NOT EXISTS wa_self_healing_logs (
    id TEXT PRIMARY KEY,
    anomaly TEXT NOT NULL,
    action TEXT NOT NULL,
    success INTEGER DEFAULT 0,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    outcome TEXT
  );
`;

/**
 * 存量库补列（zx_20260930 M14-1）：`CREATE TABLE IF NOT EXISTS` 对**已存在**的表不生效，
 * 故新列另用 `ALTER` 补（与 `database.ts` 的迁移清单同一手法）。老库补上后，此前那些**只写不读**
 * 的行其 `outcome` 为 NULL ⇒ 由 `healOutcomeOf` 按 `success` 如实回退（不假装当时分得更细）。
 */
export const SELF_HEALING_LOGS_MIGRATIONS: readonly string[] = [
  'ALTER TABLE wa_self_healing_logs ADD COLUMN outcome TEXT',
];

/** 建表 + 补列（**唯一入口**：生产启动、`logHealing`、启动回归都走这里）。 */
export function ensureSelfHealingTable(db: Database.Database): void {
  try {
    db.exec(SELF_HEALING_LOGS_DDL);
  } catch (err) {
    // 账本建不出来不该把启动搞挂（读侧对缺表有 `[]` 兜底）。但不许静默：这是"新账可能记不上"。
    logger.warn({ err: String(err) }, '[自愈] 自愈账本建表失败（读侧仍有兜底，但新账可能记不上）');
    return;
  }
  for (const m of SELF_HEALING_LOGS_MIGRATIONS) {
    try {
      db.exec(m);
    } catch (err) {
      // 唯一该安静吞掉的情形是"这一列本来就在"（新库由 DDL 直接带出；老库补过一次后重跑）。
      //   其余（库只读 / 被锁 / 语法错）一律 warn——静默 `catch {}` 正是"以为补好了、其实没补"的来路。
      if (!/duplicate column name/i.test(String(err))) {
        logger.warn({ err: String(err) }, '[自愈] 自愈账本补列失败（新账可能记不上）');
      }
    }
  }
}

/**
 * 直写一笔自愈账（**不带 24h 熔断**）——给"每 10 分钟一跳的常驻清账"用（见 `reconcileStalledSubtasks`
 * 的"为什么不走 `tryHeal`"）。熔断是给**故障**设计的：同一批悬挂子任务天然会连续多轮出现，
 * 套上限等于三天后自己失灵。
 *
 * `success` 由 `outcomeIsSuccess` 派生（**一处真源**）——调用方给不出"仅记录却算成功"这种组合。
 * 本函数**不抛**：已执行的动作不该因为记不上账而回滚。
 */
export function logHealing(
  db: Database.Database,
  f: { anomaly: string; action: string; outcome: HealOutcome; detail?: string },
): void {
  try {
    ensureSelfHealingTable(db);
    db.prepare(
      'INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), f.anomaly, f.action, outcomeIsSuccess(f.outcome) ? 1 : 0, f.outcome, f.detail ?? null);
  } catch (err) {
    logger.warn({ err: String(err), anomaly: f.anomaly }, '[自愈] 记账失败（不影响已执行的动作）');
  }
}

/**
 * P1.7: 启动自愈监控（每10分钟扫描一次）
 */
export function startSelfHealingMonitor(db: Database.Database): void {
  // 确保日志表存在（含新列）
  ensureSelfHealingTable(db);
  // zx_20261016_3 批四：提案台账也在启动时建好——此前只有 `recordProposal` 懒建，
  //   于是"一次提案都没投过"的库里这张表**根本不存在**，面板列表只能靠 catch 兜底回空，
  //   分不清"没有提案"与"台账没建起来"。与自愈账本同一条纪律：启动即建，读侧的口径才作数。
  ensureSelfEvolveTable(db);

  // 每10分钟执行健康扫描
  _timer = setInterval(() => runHealthScan(db), 10 * 60 * 1000);

  // 启动后延迟30秒首次扫描
  _startupTimer = setTimeout(() => {
    runHealthScan(db);
    runStartupRegressionCheck(db);
  }, 30_000);

  logger.info('[自愈监控] 已启动，扫描间隔10分钟');
}

export function stopSelfHealingMonitor(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_startupTimer) { clearTimeout(_startupTimer); _startupTimer = null; }
}

/**
 * 主健康扫描：检查各项系统指标并尝试自动修复。
 *
 * 导出是为让受控回归**直引真实现**跑通（同 `reconcileStalledSubtasks` / `checkParentTaskAfterChildDone`
 * 的既有手法）：M14-1 的靶心是"四个 `tryHeal` 调用点各记哪个词"，而调用点就在本函数体内——
 * 抽一份等价物给 rr 用就只是自我印证，证不了生产真的这么记。
 */
export function runHealthScan(db: Database.Database): void {
  // zx_20260930 M14-1: 每项都带**结果态**（不再是一个 boolean）——收尾那句汇总才能如实分说
  //   "修复 N 项 / 仅记录 M 项 / 需人工 K 项"，而不是把它们一并叫"成功"。
  const findings: Array<{ anomaly: string; action: string; outcome: HealOutcome }> = [];

  try {
    // 1. 检查守护进程心跳 — 超过阈值无更新标记为stale
    // zx_20261016_3 批四：阈值从"写死在 SQL 里"改为**读设置**（缺省 10）——批二那条
    //   `self_healing.daemon_stale_minutes` 提案经人工闸 `applied` 后，**在这里真正生效**。
    //   写而不读＝提案是一纸空文（本仓"做了没用上"纪律），故这一步是那条提案的兑现点。
    const staleMinutes = readDaemonStaleMinutes(db);
    const staleDaemons = db.prepare(
      "SELECT d.id, d.name, COALESCE(d.updated_at, d.created_at) as updated_at FROM wa_deliverables d WHERE d.type = 'daemon' AND d.status = 'running' AND COALESCE(d.updated_at, d.created_at) < datetime('now', '-' || ? || ' minutes')"
    ).all(staleMinutes) as Array<{ id: string; name: string; updated_at: string }>;
    for (const sd of staleDaemons) {
      const outcome = tryHeal(db, sd.id, '守护进程无心跳', '标记为stale', () => {
        setDeliverableStatus(db, sd.id, 'stale', 'self_healing');
        return 'healed';
      }, `target: ${sd.id} · 守护进程「${sd.name}」最后更新 ${sd.updated_at}`);
      findings.push({ anomaly: `守护进程无心跳: ${sd.name}`, action: '标记stale', outcome });
    }

    // 2. 检查任务超时 — 执行态无心跳超10分钟 ⇒ 暂停（zx_20260930 M11-3：与 scheduler 共用一个裁定者）
    //    候选集与处置都取共享真源；本路只保留自己的**记账**（`tryHeal` 的 24h 熔断 + `wa_self_healing_logs`）——
    //    那是"自愈"这件事的账，scheduler 那条路没有也不该有。
    const staleTasks = findStaleExecutingTasks(db);
    for (const st of staleTasks) {
      const outcome = tryHeal(db, st.id, '任务执行超时', '自动暂停', () =>
        // 回读守卫拦下（找与动之间已被别路处置）⇒ 本路**什么都没做**：既不是"修好了"也不是"失败了"，
        //   如实记 `recorded`。（该路是同步的，实际几不可达；守卫仍在，故这一支必须有词可用。）
        reclaimStaleExecutingTask(db, st) ? 'healed' : 'recorded',
        `target: ${st.id} · 任务「${st.title}」执行超时>${EXEC_STALE_MS / 60000}min`);
      findings.push({ anomaly: `任务超时: ${st.title}`, action: '自动暂停', outcome });
    }

    // 3. 检查孤儿作业 — stuck在running但无对应活跃任务的作业标记为failed
    const orphanJobs = db.prepare(
      "SELECT j.id, j.type FROM wa_jobs j WHERE j.status = 'running' AND j.started_at < datetime('now', '-30 minutes')"
    ).all() as Array<{ id: string; type: string }>;
    for (const oj of orphanJobs) {
      const outcome = tryHeal(db, oj.id, '作业运行超时', '标记失败', () => {
        // zx_20261002 M16-②: `wa_jobs` **没有 `updated_at` 列**（真列：…completed_at/error/created_at），
        //   原句多写这一列 ⇒ UPDATE 每次抛 `no such column`，被 `tryHeal` 记为 `failed`
        //   ⇒ 孤儿作业**从未被真正标记失败**（账上还看得见一笔"失败"，像真跑过一样）。去掉即可。
        db.prepare("UPDATE wa_jobs SET status = 'failed', error = '超时自动标记' WHERE id = ?").run(oj.id);
        return 'healed';
      }, `target: ${oj.id} · 作业 ${oj.type} 运行超时>30min`);
      findings.push({ anomaly: `孤儿作业: ${oj.type}(${oj.id})`, action: '标记failed', outcome });
    }

    // 4. 悬挂 pending 子任务：前置已死 **或父已终态**、又无在途作业 ⇒ 永无出路的 pending
    //    （zx_20260921 M7 断点④；面于 zx_20260930 M11-2 扩到 `failed`/`archived` 父）
    //    zx_20260930 M14-2：**落库的那一笔在 `reconcileStalledSubtasks` 内**（`logHealing`）——
    //    本项只汇总播报。落点在函数内而非此处：rr 直调的正是那个生产导出，账目才可判（G-1）。
    {
      const rec = reconcileStalledSubtasks(db);
      for (const id of rec.reconciled) {
        findings.push({ anomaly: `悬挂子任务无出路: ${id}`, action: '标failed+真因', outcome: 'healed' });
      }
      for (const id of rec.dispatched) {
        findings.push({ anomaly: `父执行被打断的悬空子任务: ${id}`, action: '派发ai-task救起', outcome: 'healed' });
      }
    }

    // 5.（已删除，zx_20261002 M16-②）原先此处查 `ans_audit_logs.action = 'circuit_breaker_open'`——
    //   那条查询**本库永远跑不通、也不该跑**，理由写死在此，防下一轮当缺陷复述：
    //     · `ans_audit_logs` 是 **ANS 侧**的表（建表见 `apps/ans-server/src/db/schema.ts`），
    //       **不在**桌面主库 `worker-ant-server.db` 里；桌面与 ANS 之间是 HMAC HTTP，**没有**跨库 SQL 通道。
    //     · 更根本：全仓**没有任何代码**写 `action='circuit_breaker_open'`——"断路器"这一环是归档的
    //       `worker-ant-server` 的遗物（`apps/_archive/` 里那份还在，现行两 app 均无）。即令表在，也恒为 0。
    //   ⇒ 该检查**从来没执行过**（`db.prepare` 抛 `no such table`，被原来的 `catch { }` 吞成静默）。
    //   处置：**显式删除**，不改成别的表——"没有生产者的事实"不该由半条猜测的查询来占位。
    //   ⚠ 自愈的 `wa_self_healing_logs` 账、scheduler 的暂停/失败判定均**不依赖**此项（各自有真源）。

    // M12-1: 满期未复发的"待复验"转正 `healed`（复发的已在各 `tryHeal` 顶部降为 `failed`）。
    //   放在汇总**之前**：本轮转正的那几笔不属于"本轮发现的异常"，不该混进 findings。
    confirmPendingHeals(db);

    if (findings.length > 0) {
      // 六态分说（不再把它们一并叫"修复成功"）：`healed` 才是修好了，`pending_recheck` 待下轮复验，
      //   `recorded` 仅记录，`needs_human` 等您。
      const healed = findings.filter(f => f.outcome === 'healed').length;
      const pending = findings.filter(f => f.outcome === 'pending_recheck').length;
      const recorded = findings.filter(f => f.outcome === 'recorded').length;
      const needsHuman = findings.filter(f => f.outcome === 'needs_human').length;
      logger.info(
        { findings, healed, pending, recorded, needsHuman, total: findings.length },
        `[自愈] 健康扫描完成：发现${findings.length}项异常，修复${healed}项，待复验${pending}项，仅记录${recorded}项，需人工${needsHuman}项`,
      );
    }
  } catch (err) {
    logger.error({ err }, '[自愈] 健康扫描异常');
  }
}

/**
 * zx_20260930 M11-3（管子·度量衡 / 只留一个终局裁定者）：执行态「无心跳」判定窗口——**全系统唯一**定义。
 *
 * 病根（方案 §1.6 行3）：同一个"10 分钟没心跳"有**两个看门狗、两种终局**——
 *   · `task-scheduler.checkTimeouts`（30s 一跳）：`markTaskFailed` ⇒ `failed`（终态，不再自动恢复）
 *   · 自愈扫描（10 分钟一跳）：`pauseTask(exec_timeout)` ⇒ `paused`（可恢复）
 * 数值碰巧一样，口径与裁定者却各写各的 ⇒ 同一件事的结局取决于**哪个看门狗先扫到**（30s 的那个必然先到，
 * 于是 `failed` 实际赢了，而"自愈"这条路从不生效）。
 *
 * 归一为 `paused` + `exec_timeout`：心跳丢失压倒性地是**进程死了/卡住**，不是"任务干得不对"；
 * `failed` 是终态且会被 `failedChildren` 记成"有失败子"把父的因由升级为 `children_failed`（连坐），
 * 而 `paused`（`exec_timeout` 已在 `PARENT_INTERRUPTED_PAUSE_REASONS` 内）恰好表达"被打断 ⇒ 可救"。
 * 这也正是自愈路一直以来的语义——`failed` 那一路才是异类。
 */
export const EXEC_STALE_MS = 10 * 60 * 1000;

/**
 * 「无心跳执行态」的状态集——`stabilizing` **刻意不在内**（zx_20260930 M11-5）：
 * 它是「烹小鲜」的冷却暂态，本来就该等人确认；把它当超时回收等于把"等人工"判成"卡死了"。
 * 此前 scheduler 的 SQL 把 `stabilizing` 取出来再用 `continue` 剔掉——取而不判，判据与查询分家。
 */
export const EXEC_STALE_STATUSES: readonly string[] = ['executing', 'preparing', 'running'];

export interface StaleExecTask {
  id: string;
  title: string;
  project_id: string;
  status: string;
  updated_at: string;
}

/**
 * 找出「执行态且超过 `staleMs` 无心跳」的任务（**只找不动**）。
 *
 * 时间基准走 **SQLite 的 `datetime('now')`**（与 `updated_at` 的写入基准同源），不用 JS 墙钟——
 * 本仓真库 `updated_at` 由 `datetime('now')` 写（UTC），而 `new Date(str + 'Z')` 与 `Date.now()`
 * 比大小是把两套基准并排比（`zx_20260920 M5` 半衰期算歪过一次，同族）。
 */
export function findStaleExecutingTasks(db: Database.Database, staleMs: number = EXEC_STALE_MS): StaleExecTask[] {
  const minutes = Math.max(1, Math.floor(Number(staleMs) / 60_000));
  const placeholders = EXEC_STALE_STATUSES.map(() => '?').join(',');
  return db.prepare(
    `SELECT id, title, project_id, status, updated_at FROM wa_tasks
      WHERE status IN (${placeholders}) AND updated_at < datetime('now', ?)`
  ).all(...EXEC_STALE_STATUSES, `-${minutes} minutes`) as StaleExecTask[];
}

/**
 * 回收**一个**无心跳执行态任务——全系统执行态超时的**唯一裁定者**（两个看门狗共用）。
 *
 * ⚠ `pauseTask` 没有状态 CAS，故此处用一次**即时回读**当守卫（找与动之间可能已被别路处置：
 *   用户手动暂停 / 执行体认领后刷新了心跳 / 已终态）。这不是原子 CAS——两个原实现同样不是
 *   （scheduler 直接 `markTaskFailed`、自愈直接 `pauseTask`，都不看状态），此处至少有守卫。
 *   不可改用"直写 `status='paused'` 的 CAS"：那是绕过唯一写入口（`zx_20260917 M0` 的纪律）。
 */
export function reclaimStaleExecutingTask(db: Database.Database, task: StaleExecTask): boolean {
  const cur = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(task.id) as { status?: string } | undefined;
  if (!cur || !EXEC_STALE_STATUSES.includes(String(cur.status))) return false;
  // zx_20260917 M1: 因由 `exec_timeout`——执行中超时无心跳（自愈/调度双路判定）；执行者"自愈监视器"进 label，不占因名。
  pauseTask(db, { taskId: task.id, reason: PAUSE_REASON_EXEC_TIMEOUT });
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, 'system', ?)").run(
    randomUUID(), task.id,
    `[超时] 任务执行超过${EXEC_STALE_MS / 60000}分钟无心跳，已自动暂停（超时回收）。最后心跳: ${task.updated_at}。可手动恢复重试。`,
  );
  return true;
}

export interface StallReconcileResult {
  /** 本轮**进入审问**的悬挂子任务数（=满足"父已停/已死 + 无在途作业"的 pending 子任务）。 */
  candidates: number;
  /** 其中**确无出路**（有死前置，或父已终态）、已如实标 `failed` 的子任务 id。 */
  reconciled: string[];
  /** zx_20260929 M5-b：其中**父自身执行被打断、子无阻塞前置**、已派发 `ai-task` 救起的子任务 id。 */
  dispatched: string[];
}

/**
 * zx_20260929 M5-b（毛泽东·集中优势兵力 / 维特根斯坦·同一个词同一个用途）：
 * 「父**自身执行**被打断」的因由集——只有这一类，悬空 pending 子才该被救起。
 *
 * 病根（见 plans/improve/zx_20260929.md §1.6「父子互锁」）：父若在**执行途中**被打断（规划超时 /
 * 执行超时 / 陈旧超时 / 启动清扫 / 异常结束），它**不会**再自己醒来；而 `reconcileStalledSubtasks`
 * 此前只救"前置已死"的子 —— **无前置**（或前置都已 `met`）的悬空子既不被标 failed、也不被拉起，
 * 于是父停在 `paused`、子停在 `pending`，两边互等。且**自动拉起也救不了它**：
 * `scanReadyTasks` 的 `chainStalled` 见到祖先 `paused && !isChildrenIncompletePause` 即返回真 ⇒ 跳过。
 *
 * 而**另一类** `paused` **刻意不入集**——那是"系统在等外部输入/等用户"或"活干完了但没达标"，
 * 与"执行被打断"是两回事，处置路径也不同：
 *   ① `user_interrupt`（用户主动停 ⇒ 用户没说要继续，系统不得擅自接着干）；
 *   ② `awaiting_input` / `pending_confirmation`（父自己在等回复，回话即自愈）；
 *   ③ `children_incomplete`（父在等子 ⇒ **`scanReadyTasks` 本就会拉**这些子，此处再派即**双发**）；
 *   ④ 等子/等人工验收一族（`children_failed` / `no_output` / `acceptance_*` / `output_*` / `quality_below_bar`）。
 *
 * ⚠ **空因由**（存量老任务的 paused 行没写 `pause_reason`）**计入**本集：那是"无因之停"，
 *   既非用户中止也非等待输入，当被打断处理（见 `parentInterrupted`）。
 * ⚠ 本集**不得**出现「用户中止」那一项——有受控判据两侧同钉：集被改宽即红。
 */
export const PARENT_INTERRUPTED_PAUSE_REASONS: readonly string[] = [
  PAUSE_REASON_PLANNING_TIMEOUT,
  PAUSE_REASON_EXEC_TIMEOUT,
  PAUSE_REASON_STALE_TIMEOUT,
  PAUSE_REASON_STARTUP_SWEEP,
  PAUSE_REASON_ABNORMAL_END,
];

/** 父的暂停因由是否属"自身执行被打断"（空因由 = 存量无因之停，一并计入）。 */
function parentInterrupted(contextJson: string | null | undefined): boolean {
  const reason = recordedPauseReason(contextJson);
  if (reason === '') return true;
  return PARENT_INTERRUPTED_PAUSE_REASONS.includes(reason);
}

/**
 * zx_20260921 M7（D4 断点④）: 悬挂 pending 子任务的对账 —— 「前置已死，子任务永无出路」。
 *
 * 病根（D4）：`checkParentTaskAfterChildDone` 只在**有子任务走到终态**时才被触发。若某个子任务的
 * **前置**已经 `failed`/`archived`/`paused`（`classifyDep` 判 `dead`，永不自动解锁），它自己会**永远停在
 * `pending`** —— 既不会启动（`hasUnmetDependencies` 恒真），也就永远不会走到终态去触发父的放行。
 * 于是父停在 `paused`、因由写着"子一到终态即自动恢复"（假话），而**那个终态永远不会到**。
 *
 * 出路（方案 A，2026-09-21 已裁决）：**标 `failed` 并附真因**。
 *  - **复用既有语义**（黑格尔·扬弃：按已有名相记账，不新造第三种因由）：子一 `failed`，随后调引擎那四处
 *    **同一个** `checkParentTaskAfterChildDone` ⇒ 走 `failedChildren` 那条既有分支，父的因由**如实升级**
 *    为 `children_failed`（`PAUSE_REASON_CHILDREN_FAILED`）。用户看得见、可处置，且**不再被许诺会自动恢复**。
 *  - **有死前置**时因由文案取 `depBlockInfo` 的**唯一真源**（"前置已失败：X —— 须先处置它"），不在此手写第二版。
 *    （zx_20260930 M11-2：父已终态那一支没有既有文案可复用——"父已失败"不是"前置已失败"，
 *      `depBlockInfo` 的输入是**依赖**不是**父**，硬套会说出错的话，故那一支如实另写，见行内注释。）
 *  - **可撤销**：子任务只是被标 `failed`，GUI 照旧可以改回（同人工标失败的处置路径）。
 *
 * **为什么不走 `tryHeal`**：`tryHeal` 带"同一异常 24h 内 ≥3 次即停止自愈"的上限，那是为**故障**设计的熔断；
 * 本函数是**每 10 分钟的常驻清账**，同一批悬挂子任务天然会连续多轮出现，套上限等于三天后自己失灵。
 * 故直接执行 + `logHealing`——**记账照记，熔断不套**（那是两件事：`logHealing` 是"无熔断的那条写口"）。
 * zx_20260930 M14-2 补：此前本函数**只 `logger` 不落库**，诊断页「最近自愈记录」因此**看不见**这类
 * 救起/标失败（方案 §1.6 行「留痕空洞」）——现在每一种处置都留一笔，界面才不必靠日志文件去猜。
 *
 * **不误伤**（该不命中的必须不命中，三条）：
 *  - 前置仍在**正常推进**（`classifyDep` ≠ `dead`，如 `waiting`）⇒ 不动 —— 等待是对的，不是故障。
 *  - 该子任务**有在途作业**（`ai-task`/`resume-ai-task` 且 `pending`/`running`）⇒ 不动 —— **排队中**也是出路。
 *  - 前置 id 只是**查不到**（`unresolved`）⇒ `depBlocksRun` 为假，本就不阻塞调度，不是悬挂。
 *
 * **处理面 = 「父已停 或 父已死」**（zx_20260930 M11-2 扩面）：
 *  - 父 `paused`/`pending`（原有）——收益是"父的因由如实升级"或"把子救起来"。
 *  - 父 `failed`/`archived`（**本轮新增**）——父**再也不会**醒来，其 pending 子**结构性永无出路**：
 *    `scanReadyTasks` 的 `chainStalled` 见祖先 `failed/archived` 即拦（不放行），而本函数此前
 *    `p.status IN ('paused','pending')` 又把它们挡在候选之外 ⇒ **两边都不管**，子任务永久 `pending`
 *    （方案 §1.6 行2）。收益在此不是"升级父的因由"（父已终态），而是**把子如实标失败**——
 *    不再让它在界面上假装"排队中"。
 *  - 父 `completed` **仍不在面内**，且是**对的**：`chainStalled` 不拦 `completed`，`scanReadyTasks`
 *    本就会拉起这些子 ⇒ 它们有出路，不是悬挂（既有判据 C31 的 C4 标本正是此意，两侧同钉）。
 *
 * 导出是为让受控回归**直引真实现**跑通（同 `checkParentTaskAfterChildDone` 的既有手法）：
 * 抽一份等价物给 rr 用就只是自我印证，证不了这条自愈路真的接上了。
 */
export function reconcileStalledSubtasks(db: Database.Database): StallReconcileResult {
  const out: StallReconcileResult = { candidates: 0, reconciled: [], dispatched: [] };

  // zx_20260929 M5-b: 多取父的 `status`/`context_json` 供派发分支判"父是不是被打断了"。
  // zx_20260930 M11-2: 再取 `c.parent_task_id`（父已终态那一支的因由要**点名父**）；
  //   同时 `p.status` 集合扩到含 `failed`/`archived`（见上文"处理面"）——`candidates` 口径随之变宽，是本轮**有意**的。
  let rows: Array<{ id: string; title: string; depends_on: string | null; project_id: string; parent_task_id: string; parent_status: string; parent_context_json: string | null }>;
  try {
    rows = db.prepare(`
      SELECT c.id, c.title, c.depends_on, c.project_id, c.parent_task_id,
             p.status AS parent_status, p.context_json AS parent_context_json
        FROM wa_tasks c
        JOIN wa_tasks p ON p.id = c.parent_task_id
       WHERE c.status = 'pending'
         AND p.status IN ('paused','pending','failed','archived')
         AND NOT EXISTS (
           SELECT 1 FROM wa_jobs j
            WHERE j.type IN ('ai-task','resume-ai-task')
              AND j.status IN ('pending','running')
              AND json_extract(j.payload, '$.taskId') = c.id)
    `).all() as Array<{ id: string; title: string; depends_on: string | null; project_id: string; parent_task_id: string; parent_status: string; parent_context_json: string | null }>;
  } catch (err) {
    logger.warn({ err: String(err) }, '[自愈] 悬挂子任务扫描失败（跳过本轮，不误改）');
    return out;
  }
  out.candidates = rows.length;
  if (rows.length === 0) return out;

  const rowStmt = db.prepare('SELECT status, context_json, title FROM wa_tasks WHERE id = ?');
  const cache = new Map<string, { status?: string; context?: string | null; title?: string }>();
  const look = (id: string) => {
    if (!cache.has(id)) {
      const r = rowStmt.get(id) as { status?: string; context_json?: string | null; title?: string } | undefined;
      cache.set(id, { status: r?.status, context: r?.context_json, title: r?.title });
    }
    return cache.get(id) as { status?: string; context?: string | null; title?: string };
  };
  const statusOf = (id: string) => look(id).status;
  const contextOf = (id: string) => look(id).context;
  const nameOf = (id: string) => look(id).title ?? id;

  for (const row of rows) {
    const depIds = parseDepIds(row.depends_on);
    const depState = classifyDep(depIds, statusOf, contextOf);

    // ── zx_20260929 M5-b: 父自身执行被打断 + 子无阻塞前置 ⇒ 派发救起（父子互锁的出路）─────────
    //   判据三条，缺一不可：
    //     ① 父此刻是 `paused`（`pending` 父不需要救——它自己会被调度）；
    //     ② 父的因由属"被打断"（`parentInterrupted`，用户中止/等输入/等子/等验收**都不算**）；
    //     ③ 子无**阻塞**前置（`!depBlocksRun(state)` ⇒ state 为 `met` 或 `unresolved`）——
    //        `waiting`（还在等正常推进）与 `dead`（有出路：标 failed，见下方老支）都不在此列。
    //   与老支**互斥**：depState 为 `dead` ⇒ `depBlocksRun` 真 ⇒ 不进本支；为真纯"无出路"才标 failed。
    //   派发走 `enqueueJob`（唯一入口，写库 **并**入内存队列）——**不能**指望 `scanReadyTasks`：
    //   它的 `chainStalled` 见祖先 paused 即跳过，正是本互锁的死结所在。
    if (row.parent_status === 'paused'
      && parentInterrupted(row.parent_context_json)
      && !depBlocksRun(depState)) {
      try {
        // 子此时必是 `pending`（从未跑过）⇒ 首跑语义 `ai-task`，与 `scanReadyTasks` 对无痕迹任务的分流结果一致，
        // 不会合成"你之前的任务已恢复…"那句对首跑为假的话。
        enqueueJob(db, 'ai-task', { taskId: row.id, projectId: row.project_id, source: 'self_healing_paused_parent' });
        out.dispatched.push(row.id);
        // zx_20260930 M14-2: 留痕（诊断页看得见）。`enqueueJob` 成功返回 ⇒ 这一笔确实办了事 ⇒ `healed`。
        logHealing(db, {
          anomaly: `父执行被打断的悬空子任务: ${row.id}`, action: '派发ai-task救起', outcome: 'healed',
          detail: `target: ${row.id} · 父「${nameOf(row.parent_task_id)}」执行被打断且子无阻塞前置`,
        });
        logger.info({ taskId: row.id, title: row.title }, '[自愈] 父执行被打断且子无阻塞前置，已派发 ai-task 救起');
      } catch (err) {
        logger.warn({ err: String(err), taskId: row.id }, '[自愈] 悬空子任务派发失败（跳过该条）');
      }
      continue;
    }

    // ── zx_20260930 M11-2: 出路判定（两条互斥的"确无出路"）──────────────────────────────
    //   ① `depsNoWayOut`—— 有前置且前置**永不可恢复**（`hasUnrecoverableDep`：`failed`/`archived`）。
    //   ② `parentDead`  —— 父已 `failed`/`archived`（终态且不会自行恢复），且**没有**无出路前置可点名。
    //   两者皆非 ⇒ 不动：无前置的（父 paused 时已由上方派发支处理 / 父 pending 时会自己跑）、
    //   前置仍在推进的（`waiting`，等待是对的）、前置只是查不到的（`unresolved`，本就不阻塞调度）。
    //   ⚠ "父已死"这一支**不派发**：父是用户/系统**明确放弃**的分支，把子任务救起来跑等于擅自复活被放弃的工作。
    //
    //   zx_20261012_2 批三（「停 ≠ 死」）：① 判据由 `depState === 'dead'` 收窄为 `hasUnrecoverableDep`。
    //     病根：`dead` 把 `paused`（非等子所致）也算"死"，于是在此**把"停"错杀成"死"**——策略熔断暂停
    //     （`policy_paused`，等人工看一眼即恢复）的下游子任务被直接标 `failed`（本轮事故 9 连败的主要来源）。
    //     `paused` 前置的正确处置是**等**（人一恢复它就活了），不是"救"也不是"判死"。
    //     ⚠ 派发支（上方 `classifyDep`/`depBlocksRun`）**原地不动**：那把尺答的是"能不能自动解锁"，
    //       `paused` 在它眼里是 `dead`（挡住调度、文案喊"须人工"，都对）——两把尺各答各的问题（见 dep-graph 注释）。
    const depsNoWayOut = depIds.length > 0 && hasUnrecoverableDep(depIds, statusOf);
    const parentDead = row.parent_status === 'failed' || row.parent_status === 'archived';
    if (!depsNoWayOut && !parentDead) continue;
    // 因由取**唯一真源**：有无出路前置 ⇒ `depBlockInfo` 的既有文案（"前置已失败：X —— 须先处置它"）；
    //   否则是"父已死"⇒ 点名父与其终态（这是本轮新增的情形，没有既有文案可复用，故在此如实写出。
    //   文案只说**事实**：父是什么状态、因此子无法执行——不承诺"处置后会恢复"）。
    const reason = depsNoWayOut
      ? depBlockInfo(depIds, statusOf, nameOf, contextOf).text
      : `父任务「${nameOf(row.parent_task_id)}」已是 ${row.parent_status} 终态，不会再恢复`;
    try {
      // 只对**此刻仍是 pending** 的行动手（扫描与写入之间可能已被别的路放行/启动）——CAS 由 `expectStatus` 承担
      // 批五 M5: 带因——本路只发 `task.status_changed`（**不是** `task.failed`），事件投影器看不到它，
      //   故失败 IM 只能由此处的 `markTaskFailed` 带因发出（见 `notifyFailure` 头注的"带因的后一跳"）。
      const upd = markTaskFailed(db, row.id, { expectStatus: 'pending', reason });
      if (!upd.changed) continue;
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, 'system', ?)").run(
        randomUUID(), row.id, `[自愈] 本子任务已无出路，无法执行，已如实标记为失败。${reason}`,
      );
      // 事件在场（承 zx_20260915 P0-3(d)：状态转移必须有事件，否则界面停在旧态）
      eventBus.emit('task.status_changed', { taskId: row.id, task_id: row.id, projectId: row.project_id, newStatus: 'failed', new_status: 'failed' }).catch(() => {});
      out.reconciled.push(row.id);
      // zx_20260930 M14-2: 留痕。`markTaskFailed` 回报 `changed` 才走到这里 ⇒ 这一笔确实把状态改了 ⇒ `healed`；
      //   `detail` 记**真因**（与那条 system 回话同一句），诊断页据它就能说清"为什么这笔被判无出路"。
      logHealing(db, {
        anomaly: `悬挂子任务无出路: ${row.id}`, action: '标failed+真因', outcome: 'healed',
        detail: `target: ${row.id} · ${reason}`,
      });
      logger.info({ taskId: row.id, title: row.title, deps: depIds }, '[自愈] 悬挂子任务无出路，已标 failed 并附真因');
      // 父的因由如实升级：走引擎那四处**同一个**判定（有 failed 子 ⇒ 升级为 children_failed，且不放行）
      checkParentTaskAfterChildDone(db, row.id);
    } catch (err) {
      logger.warn({ err: String(err), taskId: row.id }, '[自愈] 悬挂子任务收敛失败（跳过该条）');
    }
  }
  return out;
}

/**
 * 尝试修复，检查24h内同类型异常是否已达上限。
 *
 * zx_20260930 M14-1（维特根斯坦·一个用途一个词）：返回值由 `boolean` 改为**结果态** `HealOutcome`。
 * 病根：`boolean` 把**三件不同的事**挤成一个 `false`——「熔断跳过（什么都没做）」「修复失败（动手了、没成）」
 * 「交人工（动手了、本就不该由机器修）」，于是界面只能照 `success` 列一律显示成"失败"，与"真的修好了"
 * 只差一个颜色。改名不如改**词表**（`healing-outcome.ts` 是唯一真源），故四条第路各记各的词：
 *   · 熔断（24h 内同异常 ≥3 次）⇒ `skipped_alarm`——只是这一路不再动手，**异常仍在**，须人看；
 *   · `healFn` 抛错            ⇒ `failed`；
 *   · `healFn` 返回什么        ⇒ 如实记那个（`healed` 真修好 / `recorded` 只记了一笔 / `needs_human` 交人工）。
 * `success` 列由 `outcomeIsSuccess` **派生**（只有 `healed` 为 1）⇒ 老读点（`rr_zx_20260924_1_b6` D-5/D-6、
 * 现存的"success?成功:失败"渲染）一字不改仍成立。
 */
/**
 * M12-1（复验窗口）：一笔"待复验"的处置，要**满这个时长**仍未见同类复发才转正 `healed`。
 * 取 5 分钟（< 10 分钟扫描间隔）：下一次扫描时上一轮的处置必然已满期，至少经过一个完整间隔的观察。
 */
export const PENDING_RECHECK_CONFIRM_MS = 5 * 60 * 1000;

/**
 * M12-1 复验的**降级**半边：同一 `anomaly` 又来了一次 ⇒ 上一笔"待复验"的处置**没站住**，
 * 如实降为 `failed`（"复发 ⇒ failed，非 healed"）。放在熔断计数**之前**：复发本身就是证据，
 * 不该被"已熔断 ⇒ 不再动手"这一支短路掉。
 *
 * 只降**最新那一笔**且只降 `pending_recheck`：`recorded` / `needs_human` 本就没声称"修好了"，
 * `healed` 已是转正结论（转正前必先经过 pending 期，其间任何复发都已在此降级）。
 */
function demoteRecurredPending(db: Database.Database, anomaly: string): void {
  try {
    const last = db.prepare(
      'SELECT id, outcome, detail FROM wa_self_healing_logs WHERE anomaly = ? ORDER BY rowid DESC LIMIT 1',
    ).get(anomaly) as { id: string; outcome: string | null; detail: string | null } | undefined;
    if (!last || last.outcome !== 'pending_recheck') return;
    db.prepare("UPDATE wa_self_healing_logs SET outcome = 'failed', success = 0, detail = ? WHERE id = ?")
      .run(`${last.detail ?? ''} · 复验复发：同类异常再次出现，上一笔处置未站住`.trim(), last.id);
  } catch { /* 复验是账上的事，不该阻塞真调用 */ }
}

/**
 * M12-1 复验的**转正**半边：满期（默认 5 分钟）仍未复发的"待复验"⇒ 记 `healed` / `success=1`。
 *
 * 复发的那半边由 `demoteRecurredPending` 在**每次同类异常到来时**就地处理 ⇒ 一条"待复验"若
 * 熬过整个窗口还留着，就**必定**期间没有同类再来过（"复发即降级"已经把另一条路堵死了）。
 * 故这里不必再查"有没有更新的一笔"，条件就是"旧 + 仍待复验"。
 *
 * 由 `runHealthScan` 每轮调用一次；表不存在/写不动一律吞（与 `logHealing` 同一条 best-effort 纪律）。
 */
export function confirmPendingHeals(db: Database.Database, staleMs: number = PENDING_RECHECK_CONFIRM_MS): void {
  try {
    const minutes = Math.max(1, Math.floor(Number(staleMs) / 60_000));
    db.prepare(
      `UPDATE wa_self_healing_logs
          SET outcome = 'healed', success = 1,
              detail = COALESCE(detail, '') || ' · 复验通过（满期未见同类复发）'
        WHERE outcome = 'pending_recheck' AND created_at <= datetime('now', ?)`,
    ).run(`-${minutes} minutes`);
  } catch { /* 复验留档 best-effort */ }
}

/**
 * 尝试修复，检查24h内同类型异常是否已达上限。
 *
 * ⚠ `anomaly` 必须是**异常类型**（如"守护进程无心跳"），**不得**含具体实例名——它是熔断键
 * （24h 计数）也是复验键（同类复发判定），掺进 `alert_dashboard`/`dsa-service` 这类实例名，
 * 同类不同名就各自计数、**永不触发 24h≥3**（zx_20261002 M12-2 的病根）。实例信息走 `detail` 形参。
 *
 * zx_20260930 M14-1（维特根斯坦·一个用途一个词）：返回值由 `boolean` 改为**结果态** `HealOutcome`。
 * 病根：`boolean` 把**三件不同的事**挤成一个 `false`——「熔断跳过（什么都没做）」「修复失败（动手了、没成）」
 * 「交人工（动手了、本就不该由机器修）」，于是界面只能照 `success` 列一律显示成"失败"，与"真的修好了"
 * 只差一个颜色。改名不如改**词表**（`healing-outcome.ts` 是唯一真源），故四条第路各记各的词：
 *   · 熔断（24h 内同异常 ≥3 次）⇒ `skipped_alarm`——只是这一路不再动手，**异常仍在**，须人看；
 *   · `healFn` 抛错            ⇒ `failed`；
 *   · `healFn` 返回什么        ⇒ 如实记那个（`recorded` 只记了一笔 / `needs_human` 交人工）。
 *
 * zx_20261002 M12-1（管子·复验）：`healFn` 返回 `healed` 时**不再当轮记 `healed`**，改记
 * `pending_recheck`——"这次修好了"与"病真的消了"是两件事，须由下一轮证实。复发 ⇒ 降 `failed`。
 *
 * `success` 列由 `outcomeIsSuccess` **派生**（只有 `healed` 为 1）⇒ 老读点（`rr_zx_20260924_1_b6`
 * D-5/D-6、现存的渲染）一字不改仍成立。
 */
export function tryHeal(db: Database.Database, targetId: string, anomaly: string, action: string, healFn: () => HealOutcome, detail?: string): HealOutcome {
  // M12-1：先复验——同类复发即把上一笔"待复验"降为 failed（在熔断判定之前，复发本身就是证据）
  demoteRecurredPending(db, anomaly);

  // 检查24h内同异常出现次数
  const count24h = db.prepare(
    "SELECT COUNT(*) as c FROM wa_self_healing_logs WHERE anomaly = ? AND created_at > datetime('now', '-24 hours')"
  ).get(anomaly) as { c: number };

  if (count24h.c >= 3) {
    // 超过阈值，停止自愈，记录报警（如实记 skipped_alarm：这一路没动手，异常未被处置）
    // zx_20261016_3 批二（M33-a）: **不只是停下来**——同异常反复出现必有结构性成因，
    //   故再产一条**具体对策**并把它落到实处（`applyCountermeasure`），落点如实写进 detail。
    //   对策本身**不改变这一行的结果态**：熔断仍是 `skipped_alarm`（这一路确实没动手），
    //   对策是"接下来该动哪里"，与"本次有没有动手"是两件事（一个用途一个词）。
    const cm = proposeCountermeasure({ anomaly, count: count24h.c });
    const landed = applyCountermeasure(db, { countermeasure: cm, targetId, anomaly, count: count24h.c });
    db.prepare(
      "INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome, detail) VALUES (?, ?, ?, 0, 'skipped_alarm', ?)"
    ).run(randomUUID(), anomaly, 'ALARM_SKIPPED', `24h内已发生${count24h.c}次，超过阈值3次，需人工排查；对策：${cm.text}（${landed}）`);
    logger.error({ anomaly, count: count24h.c, countermeasure: cm.kind, landed }, '[自愈·报警] 同异常24h内≥3次，停止自愈，需人工介入');
    return 'skipped_alarm';
  }

  try {
    const acted = healFn();
    // M12-1：`healed` 只是"当次动作做成了"，先记 `pending_recheck`（待下轮复验），其余结果态原样记。
    const stored: HealOutcome = acted === 'healed' ? 'pending_recheck' : acted;
    const detailText = detail ?? `target: ${targetId}`;
    db.prepare(
      "INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(randomUUID(), anomaly, action, outcomeIsSuccess(stored) ? 1 : 0, stored,
      stored === 'pending_recheck' ? `${detailText} · 待下轮复验` : detailText);
    if (stored === 'pending_recheck') logger.info({ anomaly, action }, '[自愈] 已处置（待下轮复验：同类未复发才转正为已修复）');
    else if (outcomeIsSuccess(stored)) logger.info({ anomaly, action }, '[自愈] 修复成功');
    else logger.info({ anomaly, action, outcome: stored }, '[自愈] 已处置（结果非"修复成功"，如实记账）');
    return stored;
  } catch (err) {
    db.prepare(
      "INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome, detail) VALUES (?, ?, ?, 0, 'failed', ?)"
    ).run(randomUUID(), anomaly, action, `error: ${String(err)}`);
    return 'failed';
  }
}

/**
 * zx_20261016_3 批二（M33-a · 王阳明「知行合一」）: 熔断之后**给一条具体对策**。
 *
 * 病根：24h ≥3 次的熔断此前只写一行"需人工排查"就结束了——**停下来了，但没告诉人该动哪里**
 * （感性认识停在"报警"）。同异常反复出现必有**结构性成因**，对策就是把成因写成一条**可执行的动作**。
 *
 * 三类形态（`kind`）——**只在此处一张表**，加一类异常就加一行：
 *   · `strategy_breaker` —— **本项目**的策略该冻结：对策直接作用到行为（`adjustProjectStrategy` 只降不升）；
 *   · `proposal`         —— 要改**引擎全局阈值/规则**：这是"能改变引擎行为的东西"，**不得自动生效**，
 *                            投 `pending` 进 M34 台账，等人工闸批准（红线见 `self-evolve.ts` 头注释）；
 *   · `none`             —— 无内置对策，如实说"转人工"，**不许**编一条看起来像对策的话。
 *
 * 纯函数（不碰 DB）：喂 `{anomaly, count}` 即可试出它给什么对策。
 */
export interface Countermeasure {
  kind: 'strategy_breaker' | 'proposal' | 'none';
  /** 给人看的一句话（进 `skipped_alarm` 的 `detail`，界面上看得见）。 */
  text: string;
  /** `kind='proposal'` 时投给 M34 台账的提案体。 */
  proposal?: { kind: SelfEvolveKind; target: string; payload: Record<string, unknown> };
  /** `kind='strategy_breaker'` 时的冻结时长（小时）。 */
  hours?: number;
}

/** 守护进程心跳陈旧阈值：**缺省** 10 分钟（批四起改由 `wa_settings` 承载，见 `readDaemonStaleMinutes`），对策建议放宽到 15。 */
export const DAEMON_STALE_MINUTES_CURRENT = 10;
export const DAEMON_STALE_MINUTES_SUGGESTED = 15;
/** 提出该阈值的提案目标键（`wa_settings` 的键名，批四人工批准后由 `decideProposal` 写入、由 `readDaemonStaleMinutes` 读出）。 */
export const DAEMON_STALE_MINUTES_SETTING_KEY = 'self_healing.daemon_stale_minutes';

/**
 * 守护进程心跳陈旧阈值**现读现取**（`runHealthScan` 第 1 项的取数口）。
 *
 * 缺省 = `DAEMON_STALE_MINUTES_CURRENT`；键在但值不是正数 ⇒ 也回缺省（坏值不该把扫描打成"永远不判失联"
 * 或"人人都失联"两极）。读不到（缺表/缺列）同样回缺省——扫描本身不该因为设置读不出来就停摆。
 */
export function readDaemonStaleMinutes(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(DAEMON_STALE_MINUTES_SETTING_KEY) as { value: string } | undefined;
    if (!row) return DAEMON_STALE_MINUTES_CURRENT;
    const n = Number(row.value);
    return Number.isFinite(n) && n > 0 ? n : DAEMON_STALE_MINUTES_CURRENT;
  } catch {
    return DAEMON_STALE_MINUTES_CURRENT;
  }
}

export function proposeCountermeasure(o: { anomaly: string; count: number }): Countermeasure {
  switch (o.anomaly) {
    case '任务执行超时':
      // 反复超时 ⇒ 该项目"越坏越升档"（失败升档 ⇒ 更贵的模型 ⇒ 更慢 ⇒ 更易超时）是正反馈。
      //   对策取**冻结升档 24h**（`strategy_breaker`）：直接作用到 `adjustProjectStrategy` 的行为上。
      return {
        kind: 'strategy_breaker',
        hours: STRATEGY_BREAKER_HOURS,
        text: `该项目 24h 内任务反复执行超时（${o.count} 次）⇒ 冻结项目策略升档 ${STRATEGY_BREAKER_HOURS}h（只降不升），待人工排查`,
      };
    case '守护进程无心跳':
      // 心跳陈旧阈值（10 分钟）写死在扫描 SQL 里；反复误判"失联"多是阈值过紧而非守护真死。
      //   改全局阈值 = 改引擎行为 ⇒ 必须走人工闸，故投 `pending` 提案而不是就地生效。
      return {
        kind: 'proposal',
        text: `守护进程反复被判定失联（${o.count} 次），疑阈值过紧；已投阈值调整提案（${DAEMON_STALE_MINUTES_CURRENT}→${DAEMON_STALE_MINUTES_SUGGESTED} 分钟）待人工批准`,
        proposal: {
          kind: 'threshold',
          target: DAEMON_STALE_MINUTES_SETTING_KEY,
          payload: { current: DAEMON_STALE_MINUTES_CURRENT, suggested: DAEMON_STALE_MINUTES_SUGGESTED },
        },
      };
    case '作业运行超时':
      // 孤儿作业多由上游任务超时**连带**产生（任务被暂停/失败后，其在途作业留在 running）。
      //   治上游即治它，故不另立对策——另立一件只会让人以为"还有第二处要改"。
      return { kind: 'none', text: '作业超时多由上游任务超时连带引起，随任务侧处置即可；不另立对策' };
    default:
      return { kind: 'none', text: `无内置对策（异常类型「${o.anomaly}」不在对策表内），转人工排查` };
  }
}

/**
 * 目标（任务/成果/项目 id）→ 其**所属项目** id。查不到一律 `null`（**不猜**、不落第一条项目）。
 *
 * 为什么按表逐个查而不写一条 `UNION`：三张表语义不同（任务是执行单元、成果是产出、项目是容器），
 * 合并查询会把"任务不存在"与"成果不存在"糊成一个 `NULL`，排查时分不清是哪张表没命中。
 */
export function resolveProjectIdForTarget(db: Database.Database, targetId: string): string | null {
  try {
    const t = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(targetId) as { project_id: string | null } | undefined;
    if (t) return t.project_id ?? null;
    const d = db.prepare('SELECT project_id FROM wa_deliverables WHERE id = ?').get(targetId) as { project_id: string | null } | undefined;
    if (d) return d.project_id ?? null;
    const p = db.prepare('SELECT id FROM wa_projects WHERE id = ?').get(targetId) as { id: string } | undefined;
    if (p) return p.id;
  } catch { /* 目标不在这些表里：如实回 null */ }
  return null;
}

/**
 * 把对策**落到实处**（`tryHeal` 熔断支调用；**best-effort**，失败只记日志不回滚）。
 *
 * 返回一句"落点说明"追加到 `skipped_alarm` 的 `detail` —— 让账上看得见**这条对策到底做成了什么**，
 * 而不是只留一句"已给对策"（那又是"说了等于没说"）。
 */
export function applyCountermeasure(
  db: Database.Database,
  o: { countermeasure: Countermeasure; targetId: string; anomaly: string; count: number },
): string {
  const cm = o.countermeasure;
  if (cm.kind === 'strategy_breaker') {
    const projectId = resolveProjectIdForTarget(db, o.targetId);
    if (!projectId) return '未落到行为：目标不属于任何项目';
    const b = setStrategyBreaker(db, { projectId, anomaly: o.anomaly, count: o.count, hours: cm.hours });
    return b ? `已作用到行为：项目 ${projectId} 策略冻结至 ${b.until}` : '未落到行为：写项目熔断失败';
  }
  if (cm.kind === 'proposal') {
    const p = cm.proposal;
    if (!p) return '未落到行为：对策缺提案体';
    if (hasPendingProposalFor(db, p.target)) return '已有同目标待批提案，不重复记账';
    const r = recordProposal(db, { kind: p.kind, target: p.target, payload: p.payload, source: `self_healing:${o.anomaly}`, note: cm.text });
    if (!r.ok) return `提案未落账：${r.reason}`;
    return `已投提案 ${r.id}（pending，待人工闸批准）`;
  }
  return '未落到行为：本类异常无内置对策';
}

/** 留档明细的上限——一次超长依据不该把账撑爆（截断而非丢弃，同 `service-call-ledger` 的手法）。 */
const MAX_TRANSITION_DETAIL = 500;

/**
 * zx_20261002 M12-3（管子·版法："凡将立国，制度不可不察也"）：**值未变就不写**——
 * 诊断页每开一次都会调一次健康检查/不变量，无条件落账会把账淹掉；要长期累计的是**变迁**
 * （"病是否变多变少"），故只在某一面/某一项**状态发生变化**时记一笔。
 *
 * 复用既有账本 `wa_self_healing_logs`（不新造表）：`outcome` 记 `recorded`（只记录、没动手，
 * 正是这个词的本义）；`action` 记 `留档:<新状态>`，故上一笔的 `action` 与新状态一比即知是否变迁。
 * 键按面/项归一（`健康检查: ans` / `架构不变量: xxx`），不带实例名——与本文件 `tryHeal` 的键同一条纪律。
 */
function logTransitionIfChanged(db: Database.Database, anomaly: string, action: string, detail: string): void {
  try {
    const last = db.prepare('SELECT action FROM wa_self_healing_logs WHERE anomaly = ? ORDER BY rowid DESC LIMIT 1')
      .get(anomaly) as { action: string } | undefined;
    if (last && last.action === action) return;
    logHealing(db, { anomaly, action, outcome: 'recorded', detail: detail.slice(0, MAX_TRANSITION_DETAIL) });
  } catch { /* 留档 best-effort：诊断不该因为记不上账而失败 */ }
}

/** M12-3：把一次真健康自检的**五面**状态留档（每面各自"变才写"）。结构式入参 ⇒ 不引 `health-check`。 */
export function logHealthTransitions(
  db: Database.Database,
  items: ReadonlyArray<{ key: string; level: string; evidence: string }>,
): void {
  for (const it of items) logTransitionIfChanged(db, `健康检查: ${it.key}`, `留档:${it.level}`, it.evidence || '');
}

/** M12-3：把一次架构不变量检查的**每一项**结论留档（每项各自"变才写"）。结构式入参 ⇒ 不引 `architectural-invariants`。 */
export function logInvariantTransitions(
  db: Database.Database,
  results: ReadonlyArray<{ name: string; passed: boolean; severity: string; description: string }>,
): void {
  for (const r of results) {
    logTransitionIfChanged(db, `架构不变量: ${r.name}`, `留档:${r.passed ? 'pass' : r.severity}`, r.description || '');
  }
}

/**
 * 启动时回归检查：验证关键路径可用性。
 *
 * zx_20260930 M14-2（毛选·不打无准备之仗）：结果**同走 `wa_self_healing_logs`**——此前它只 `logger.error`
 * 一句就完了，诊断页「最近自愈记录」看不见（方案 §1.6「留痕空洞」）。
 *
 * ⚠ **只记失败**：通过的检查不是"自愈事件"，写进去只会把账淹掉（10 分钟一跳的健康扫描已经够吵）。
 * 失败记 `needs_human`——启动回归不通过不是"能自动修好的故障"，是**叫人来看**。
 */
export function runStartupRegressionCheck(db: Database.Database): void {
  // 本检查的第一步就是往 `wa_self_healing_logs` 里试写一行（DB 可写性探针）⇒ 表必须先在场，
  //   否则探针自己把表不存在判成"库不可写"（假红）。`ensureSelfHealingTable` 是建表的唯一入口。
  ensureSelfHealingTable(db);
  const checks: Array<{ name: string; passed: boolean }> = [];

  // 1. DB可写性（探针行写完即删；`outcome` 一列也照写——"每一处 INSERT 都带结果态"是可判的不变式，
  //    这里留一个例外就得在判据里挖一个洞，不如让探针与别的写口同形）
  try {
    const testId = randomUUID();
    db.prepare("INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome) VALUES (?, 'startup_regression', 'db_write_test', 0, 'recorded')").run(testId);
    db.prepare("DELETE FROM wa_self_healing_logs WHERE id = ?").run(testId);
    checks.push({ name: 'DB可写性', passed: true });
  } catch { checks.push({ name: 'DB可写性', passed: false }); }

  // 2. 调度器心跳
  try {
    const jobs = db.prepare("SELECT COUNT(*) as c FROM wa_jobs").get() as { c: number };
    checks.push({ name: `调度器可用(${jobs.c}作业)`, passed: true });
  } catch { checks.push({ name: '调度器可用', passed: false }); }

  // 3. 记忆系统
  try {
    const mems = db.prepare("SELECT COUNT(*) as c FROM wa_memories").get() as { c: number };
    checks.push({ name: `记忆系统可用(${mems.c}条)`, passed: true });
  } catch { checks.push({ name: '记忆系统可用', passed: false }); }

  const failed = checks.filter(c => !c.passed);
  if (failed.length > 0) {
    logger.error({ failed }, '[自愈·回归] 启动回归检查发现失败项');
    for (const c of failed) {
      logHealing(db, {
        anomaly: `启动回归检查未通过: ${c.name}`, action: '启动回归检查', outcome: 'needs_human',
        detail: 'startup_regression',
      });
    }
  } else {
    logger.info({ checks }, '[自愈·回归] 启动回归检查全部通过');
  }
}
