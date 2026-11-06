/**
 * 终态事件「果」的一处真源（zx_20260915 P0-3 A′：**成功也要带果**）。
 *
 * 病根：`task.completed` 长期只带 `{taskId, task_id, projectId}`——实测 `8a6f226a` 质量 80 分、
 * 3 个交付物、1 份报告、改了 1 个门禁脚本，**这些一个都不在事件里**（要读 `context_json` 才有）。
 * 而 `agent-executor.ts` 收口处**早已**把分数打到控制台（`console.log('…quality=${score}分')`）——
 * 值**算了、也念了**，只是念给了日志而不是念给了事件流。与本轮其余各条同形。
 *
 * 为什么必须抽出来、不能两处各写一遍：`task.completed` 有两个 emit 出口
 * （finalize 收口 / run_close 收口），而 `qualityScore` 这个局部量**只在 run_close 路存在**
 * （它在收口之后才声明）——若各写一遍，finalize 出口就会去取内存值、run_close 出口取落库值，
 * 同一事件类型两处形状/口径不同，正是本轮要治的分家。故一律**从落库载荷取**。
 *
 * 本模块只读，不写库、不发事件。
 *
 * zx_20260916_3 M3（O-C · 判据 C3）：另收 `ctx.completion_quality` 的**唯一构造点**（见文件末）。
 * 病根同形——`task.completed` 有两个出口，`completion_quality` 也有两个出口：finalize 出口写 `{score}` 单键，
 * run_close 出口写 `{score,feedback,goal_achieved}`，**同一份账两种形状**，于是 `5126b303` 出现
 * 「95 分 + 顶层 `goal_achieved:false`」而无人能解释：那个 `false` 是更早某道门禁留下的陈旧值，
 * finalize 路既不重算也不改写它。账的形状与「目标达成」的判据一并收在本模块一处。
 */
import fs from 'node:fs';
import { goalDeviationCapReached } from './task-accounting.js';
import type { GoalEvidence } from './acceptance-check.js';

/** 只需 prepare().get()/.all() 的最小库接口（同 settings-bool 范式：可脱 better-sqlite3 跑真实现） */
export interface TaskOutcomeDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

/** 交付物分类计数。`total` 为各分类之和（= 本任务 `wa_deliverables` 行数）。 */
export interface DeliverableCounts {
  doc: number;
  mcp: number;
  a2a: number;
  daemon: number;
  ui: number;
  total: number;
}

export interface TaskOutcome {
  /** 完成质量分与口径（取自落库的 `ctx.completion_quality`，**不重算**） */
  quality: {
    score: number | null;
    via?: string;
    goal_achieved?: boolean;
    /** zx_20261104_1 M1：达成判据的凭据来源（落库账同值带出，不在此重判） */
    goal_evidence?: GoalEvidence;
    /** zx_20261104_1 M1：被迫收尾（步数/预算触顶）标记 */
    premature?: true;
  } | null;
  /** 本任务交付物分类计数（实查 `wa_deliverables`） */
  deliverables: DeliverableCounts;
  /** 本轮写入类工具调用次数（P0-1 诊断计数，**非判据**；调用方有则传） */
  run_mutations?: number;
}

/** 交付物类型白名单——`wa_deliverables.type` 的已知取值；未知类型只进 `total`（不吞、不编） */
const DELIVERABLE_TYPES = ['doc', 'mcp', 'a2a', 'daemon', 'ui'] as const;

/**
 * 查本任务的交付物分类计数。**不做探针过滤、不做状态过滤**——这里要的是"账上有几件"，
 * 与 `realOutputEvidence`（判"算不算完成"）口径不同，勿混用。
 */
export function countDeliverables(db: TaskOutcomeDb, taskId: string): DeliverableCounts {
  const out: DeliverableCounts = { doc: 0, mcp: 0, a2a: 0, daemon: 0, ui: 0, total: 0 };
  try {
    const rows = db
      .prepare('SELECT type, COUNT(*) AS c FROM wa_deliverables WHERE task_id = ? GROUP BY type')
      .all(taskId) as Array<{ type?: string | null; c?: number }>;
    for (const r of rows) {
      const n = Number(r.c) || 0;
      out.total += n;
      const t = (r.type || '') as (typeof DELIVERABLE_TYPES)[number];
      if ((DELIVERABLE_TYPES as readonly string[]).includes(t)) out[t] += n;
    }
  } catch {
    /* 查不出如实报 0 件（与"没有交付物"同形，不编数） */
  }
  return out;
}

/**
 * 组装终态事件要带的「果」。两处 `task.completed` 出口与两处
 * `status_changed{completed}` 出口**共用本函数**——同一构造器出的同一形状。
 *
 * `runMutations` 由调用方传（它是本轮执行期的内存计数，库里只在"无产出暂停"时落盘）；
 * 不传即不带该键（"没这笔账"≠"账上是 0"）。
 */
export function buildTaskOutcome(db: TaskOutcomeDb, taskId: string, runMutations?: number): TaskOutcome {
  let quality: TaskOutcome['quality'] = null;
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string | null } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as {
      completion_quality?: { score?: number; via?: string; goal_achieved?: boolean; goal_evidence?: GoalEvidence; premature?: boolean };
    };
    const q = ctx.completion_quality;
    if (q && typeof q === 'object') {
      quality = {
        score: typeof q.score === 'number' ? q.score : null,
        ...(q.via ? { via: q.via } : {}),
        ...(typeof q.goal_achieved === 'boolean' ? { goal_achieved: q.goal_achieved } : {}),
        ...(typeof q.goal_evidence === 'string' ? { goal_evidence: q.goal_evidence } : {}),
        ...(q.premature === true ? { premature: true as const } : {}),
      };
    }
  } catch {
    /* 载荷坏 JSON ⇒ quality 保持 null（如实"没这笔账"） */
  }
  const outcome: TaskOutcome = { quality, deliverables: countDeliverables(db, taskId) };
  if (typeof runMutations === 'number') outcome.run_mutations = runMutations;
  return outcome;
}

/** 「目标达成」的分数线——**唯一一处**（此前三处各写一个 60：run_close / update_task_status / task:updateStatus） */
export const GOAL_ACHIEVED_MIN_SCORE = 60;

/**
 * 「目标达成」的**唯一判据**（zx_20261104_1 M1 起五参）：
 *
 *   1. 有显式目标且偏离触上限 ⇒ false（既有约束，原样保留）；
 *   2. **被迫收尾**（步数/预算触顶）⇒ false——哪怕验收通过也不宣告达成（§5.1「触顶且有产出 ⇒
 *      completed，但 `goal_achieved=false`」）。显式收尾优先于验收背书，正因为"是被截停的"；
 *   3. 验收**全过** ⇒ true（唯一可背书的凭据）；
 *   4. 验收**未过** ⇒ false；
 *   5. 其余（`score_only` / `none` / 无验收账）⇒ 分 ≥ 线（如实的推断，不冒充验收结论）。
 *
 * `evidence` 由 `acceptance-check.goalEvidenceOf` 一处派生；`premature` 由收口段按撞顶事实传入。
 */
export function goalAchievedOf(
  goalDefined: boolean,
  deviationRestarts: unknown,
  score: number,
  evidence: GoalEvidence,
  premature: boolean,
): boolean {
  if (goalDefined && goalDeviationCapReached(deviationRestarts)) return false;
  if (premature) return false;
  if (evidence === 'acceptance_passed') return true;
  if (evidence === 'acceptance_failed') return false;
  return score >= GOAL_ACHIEVED_MIN_SCORE;
}

/** `ctx.completion_quality` 的规范形状 */
export interface CompletionAccount {
  score: number;
  goal_achieved: boolean;
  /** 这笔账**由谁写的**（finalize_task / run_close / update_task_status / task:updateStatus 及其变体） */
  via: string;
  /** 分数怎么来的。空串即不写该键——"没这笔账"≠"账上是一句空话" */
  feedback?: string;
  /** zx_20261104_1 M1：达成判据的凭据来源（验收全过 / 验收未过 / 仅按质量分推断 / 无账） */
  goal_evidence: GoalEvidence;
  /** zx_20261104_1 M1：本次是**被迫收尾**（步数/预算触顶）——只在为真时出现 */
  premature?: true;
}

/**
 * 造一笔完成账。**凡写 `completion_quality` 处一律经此**，不许再手写对象字面量（判据 C3 的扫描面）。
 *
 * 形状固定为 `{score, goal_achieved, via, feedback?}`：`score` 与 `goal_achieved` **同处一份账**，
 * 顶层 `goal_achieved` 亦须取 `account.goal_achieved` 同值落笔（顶层那份是给 SQL 直读的，见方案 §1.4）——
 * 两处各拼一份正是 `5126b303` 那类"账上自相矛盾"的来路。
 */
export function buildCompletionAccount(a: {
  score: number;
  goalAchieved: boolean;
  via: string;
  feedback?: string;
  evidence: GoalEvidence;
  premature?: boolean;
}): CompletionAccount {
  return {
    score: a.score,
    goal_achieved: a.goalAchieved,
    via: a.via,
    // 调用方必须显式给凭据；运行时缺失（存量 rr 以三参调用）按"仅按质量分推断"归一，
    // 不让 `undefined` 进 JSON 被序列化丢掉而变成"没这笔账"。
    goal_evidence: a.evidence ?? 'score_only',
    ...(a.feedback ? { feedback: a.feedback } : {}),
    ...(a.premature ? { premature: true as const } : {}),
  };
}

/**
 * 本 run 新增交付物计数（zx_20261104_1 M1/M2）。
 *
 * `sinceMs` 由 `executeTask` 认领后记下的**本 run 起始时刻**给出——历史交付物不能替"这一轮什么都没做"背书。
 * 用 `julianday()` 比较而不是字符串比较：`created_at` 既有 `datetime('now')` 的
 * `YYYY-MM-DD HH:MM:SS`（UTC），也可能有带 `T`/`Z` 的 ISO 写入，字符串序会把同日 `T` 排在空格之后。
 */
export function countNewDeliverablesSince(db: TaskOutcomeDb, taskId: string, sinceMs: number): number {
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id = ? AND julianday(created_at) >= julianday(?)',
    ).get(taskId, new Date(sinceMs).toISOString()) as { c?: number } | undefined;
    return Number(row?.c) || 0;
  } catch {
    return 0;
  }
}

/**
 * 不变式：顶层 `goal_achieved` 与 `completion_quality.goal_achieved` **同值**。
 *
 * 这条不变式此前无人守——同一份 `context_json` 里两处各写一份，`5126b303` 的
 * 「95 分 + 顶层 false」即由此而来。凡是**只动其中一处**的地方，都得调下面两个方向之一。
 */

/** 方向①：资产已由构造器写好 ⇒ 顶层**取账上同值**（账上没这个键的老数据则不动顶层——"没这笔账"≠"账上是达成"） */
export function syncGoalAchievedFromAccount(ctx: Record<string, unknown>): void {
  const acct = ctx.completion_quality as { goal_achieved?: boolean } | undefined;
  if (typeof acct?.goal_achieved === 'boolean') ctx.goal_achieved = acct.goal_achieved;
}

/**
 * 方向②：**新的**未完成事实（产出未落盘 / 内容不充分两道门禁）⇒ 账与顶层**同置 false**。
 * 只改这一个判断，分数与成因留给账上原样保留——这是"同一笔账被新事实更新"，不是又起一版。
 */
export function markGoalNotAchieved(ctx: Record<string, unknown>): void {
  const acct = ctx.completion_quality as { goal_achieved?: boolean } | undefined;
  if (acct) acct.goal_achieved = false;
  ctx.goal_achieved = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 收口摘要「取哪份内容」的一处真源（zx_20261011_1 M5）

/** 产出物文件的**字数下限**——低于此视为"没写出东西"（与 relay/IM 既有 50 字口径同源）。 */
export const PRODUCED_FILE_MIN_CHARS = 50;

/** 本任务产出的文件（`filePath` 供调用方记名，`content` 为读盘全文——截断由调用方按各自版面决定）。 */
export interface ProducedFile {
  filePath: string;
  content: string;
}

/**
 * 本任务**产出的文件**——**一处真源**（zx_20261011_1 M5）。
 *
 * 病根（`zx_20261011` §9.6）：一件任务**改写了项目里既存的产出物**时，`write_file` 命中去重、
 * 更新的是**旧产出物**（`deliverableId` 仍是旧任务的），故 `wa_deliverables.task_id` 名下**无本任务行**。
 * 真源在 `wa_deliverable_versions.changed_by`——它记着**每个版本是谁写的**（`tools/write.ts` 写）。
 *
 * 取数（**有序两源**）：① `wa_deliverables.task_id=本任务` 的最近一行 → ② （名下无行时）
 * `wa_deliverable_versions.changed_by=本任务` 的最近版本所指产出物。读盘 > `PRODUCED_FILE_MIN_CHARS` 才认。
 *
 * ⚠ **只认本任务写的**版本——绝不回传"别人写的"产出物（否则等于泄漏同项目别的任务的成果）。
 * ⚠ relay 回传（`node-request-runner.readOutcome`）与 IM 通知（`jobs/ai-task.buildCompletionNotice`）
 *   **同引本函数**——这正是本轮要治的"两把尺"（IM 路径原只按 `task_id` 选，不认 `changed_by`）。
 */
export function resolveTaskProducedFile(db: TaskOutcomeDb, taskId: string): ProducedFile | null {
  try {
    const owned = db.prepare(
      'SELECT file_path AS fp FROM wa_deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(taskId) as { fp?: string } | undefined;
    const fp = owned?.fp ?? (db.prepare(
      `SELECT d.file_path AS fp FROM wa_deliverable_versions v
         JOIN wa_deliverables d ON d.id = v.deliverable_id
        WHERE v.changed_by = ? ORDER BY v.created_at DESC LIMIT 1`,
    ).get(taskId) as { fp?: string } | undefined)?.fp;
    if (!fp) return null;
    const content = fs.readFileSync(fp, 'utf-8');
    return content.length > PRODUCED_FILE_MIN_CHARS ? { filePath: fp, content } : null;
  } catch {
    /* 无产出物库 / 文件不可读 ⇒ 如实"无产出物文件"（退回结论自述，绝不编内容） */
    return null;
  }
}

/**
 * 本任务名下的**产出清单**（仅元数据：`name`/`type`，不读盘不搬文件）——zx_20261030_1 M4 起供
 * relay 完成回传携带（派活方据此做回执核对）。
 *
 * ⚠ 放在本模块与 `resolveTaskProducedFile` 同处：产出物的**取数只此一处**，
 *   `node-request-runner` 不再自带 `FROM wa_deliverables WHERE task_id` 的内联查询。
 * ⚠ 只列 `wa_deliverables.task_id=本任务` 的行（改写既存件的版本归属由 `resolveTaskProducedFile` 另判）；
 *   无库/无行 ⇒ `[]`（"没报"≠编一条）。
 */
export function readDeliveredOutputs(db: TaskOutcomeDb, taskId: string): Array<{ name: string; type: string }> {
  try {
    const rows = db.prepare(
      'SELECT name, type FROM wa_deliverables WHERE task_id = ? ORDER BY created_at ASC',
    ).all(taskId) as Array<{ name?: unknown; type?: unknown }>;
    return rows.map((r) => ({
      name: typeof r.name === 'string' ? r.name : '',
      type: typeof r.type === 'string' ? r.type : '',
    }));
  } catch { return []; }
}

/** 收口摘要的**前两级**命中结果（末级"末条回话"各调用方版面不同，见 `readOutcome` / `buildCompletionNotice`）。 */
export interface ResolvedOutcome {
  source: 'file' | 'summary';
  /** 命中文本（未截断）。 */
  text: string;
  /** `source==='file'` 时的文件路径。 */
  filePath?: string;
}

/**
 * 收口摘要的**有序口径一处真源**：产出物文件 > 结论自述（`context_json.completion_summary`）。
 * 两路（relay 回传 / IM 通知）**同引**——同一条判定，取到**同一份**内容。
 */
export function resolveTaskOutcome(db: TaskOutcomeDb, taskId: string): ResolvedOutcome | null {
  const file = resolveTaskProducedFile(db, taskId);
  if (file) return { source: 'file', text: file.content, filePath: file.filePath };
  try {
    const row = db.prepare(
      "SELECT json_extract(context_json, '$.completion_summary') AS cs FROM wa_tasks WHERE id = ?",
    ).get(taskId) as { cs?: unknown } | undefined;
    const cs = typeof row?.cs === 'string' ? row.cs.trim() : '';
    if (cs) return { source: 'summary', text: cs };
  } catch {
    /* 取不到结论 ⇒ 交给调用方的末级兜底 */
  }
  return null;
}

/**
 * IM 完成通知"旧行为"路的内容取法——**具名抽出**以便 rr 直跑真实现（zx_20261011_1 M5）。
 *
 * 与 relay 回传 `node-request-runner.readOutcome` **同引** `resolveTaskOutcome`（取哪份内容一条判定）；
 * 差异仅在**版面**：本路文件 800 / 结论 600，末级兜底＝执行体末次输出 `aiContent`；
 * relay 路文件 800 / 结论 2000，末级兜底＝库内末条 assistant 消息。
 *
 * ⚠ 只决定"取哪份内容"，不决定"发不发通知"——触发条件仍在 `jobs/ai-task.buildCompletionNotice` 里，未动。
 */
export function completionNoticeFallback(db: TaskOutcomeDb, taskId: string, aiContent: string): string {
  const o = resolveTaskOutcome(db, taskId);
  if (o) return o.text.slice(0, o.source === 'file' ? 800 : 600);
  return aiContent ? aiContent.slice(0, 600) : '';
}
