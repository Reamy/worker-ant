/**
 * ai-task / resume-ai-task 作业处理器。
 * 从原工蚁服务端 index.ts 的 scheduler handler 移植。
 */
import type Database from 'better-sqlite3';
import { eventBus } from '../event-bus.js';
import { executeTask, detectArchetypeDeviation, persistAwaitingInput, taskFailedPayload } from '../agent-executor.js';
import { goalDeviationCapReached, GOAL_DEVIATION_MAX_RESTARTS, MAX_CHILD_BREADTH, resolveProjectConcurrency, decomposedBefore, warnDepsUnresolved, resolveMachineConcurrencyLimit, countMachineRunning } from '../task-accounting.js';
// zx_20261002 M5: 启动路「到点即拆」——门+拆+落行+留痕用**一处实现** `autoDecomposeForTask`（与引擎路共用）；
//   "复杂档"判据取**一处真源** `isComplexOrPlanish`（与执行前那条软建议同问一把尺）。
import { autoDecomposeForTask, createDeferredSubtasks, loadDecompositionPatterns, makeAnsDecomposeDeps, recordInferredDeps, type OptimalModelClient } from '../task-decompose.js';
import { assessComplexity, isComplexOrPlanish } from '../task-archetype.js';
// zx_20260915 P0-3(c): 「有失败子」这一问只在 children-gate.ts 一处回答（含回退开关），五处闸同取
import { failedChildren, childNames } from '../children-gate.js';
import { PAUSE_REASON_CHILDREN_INCOMPLETE, PAUSE_REASON_CHILDREN_FAILED, PAUSE_REASON_GOAL_DEVIATION, PAUSE_REASON_ABNORMAL_END, PAUSE_REASON_LABEL } from '../pause-reason.js';
import { pauseTask } from '../pause-task.js';
// zx_20260915 P0-4: 通知文案的**唯一**构造处——状态词现查 DB，调用方无从谎报
import { buildTaskNotice } from '../task-notice.js';
import type { MemoryManager } from '../memory-manager.js';
// zx_20260930 M5: 失败知识写侧——"这条记忆该说什么"由 `memory-write.ts` 的纯函数定（不在此处再拼一遍），
//   类型名与读侧（`exec-context.ts`）同引一处常量。
import { buildFailureKnowledge, buildSubagentExperience } from '../memory-write.js';
import type { FailureRecord } from '../memory-write.js';
import { MEM_TYPE_FAILURE_KNOWLEDGE, MEM_TYPE_SUBAGENT_EXPERIENCE } from '../memory-constants.js';
import { calibrateProjectThresholds } from '../feedback-engine.js';
import { triggerF3Notification } from '../../services/im-router.js';
import { boolSetting, readBoolSetting } from '../settings-bool.js';
import { buildUnansweredBanner, composeResumeInput } from '../pause-settlement.js';
import { markEngineDrafted } from '../turn-authorship.js';
import { bumpResumeLedger } from '../resume-ledger.js';
// zx_20260923 M1: 「AI 引擎故障」这一次事故的账（立旗带起始时刻；用户恢复即新事故）
import { closeSdkIncident } from '../sdk-incident.js';
import { markTaskFailed, grantDeliverableRetryQuota, isReviewableStatus } from '../task-terminal.js';
// zx_20261018_3 D6: 父恢复的前提是「本子任务刚走到终态」——判据与收口闸同取一处（completed/failed/archived）。
import { isTerminalTask } from '../task-jobs.js';
// zx_20261023_5 批一：本地任务到终态 ⇒ 依赖它的后继重新走一次派发决策（与远端回写处同一触发口）。
import { scheduleDependentDispatch } from '../collab-dispatch.js';
// zx_20260930 M4-1: 成果取数范围改为共享真源（此处范围=「本任务、排除退休与探针」）。
import { deliverableScopeSql } from '../deliverable-lifecycle.js';
// zx_20261011_1 M5（收口真源统一）：IM 通知的"取哪份内容"与 relay 回传**同引一处真源**。
import { completionNoticeFallback } from '../task-outcome.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
// zx_20260909 Y1(空性·如实): IM 完成回话"主要成果摘要化"纯逻辑(选 doc/验收徽标/摘要块), 供 rr 复跑同源
import { selectSummaryDoc, displayDocName, describeAcceptance, buildSummaryBlock, normalizeSnippet } from '../im-reply.js';
import type { AcceptanceInfo, SummaryDocRow } from '../im-reply.js';

// zx_20260904_5 D2/D4 (2026-09-04): goal 偏离自动恢复上限——达上限不再自动 resume，暂停待人工介入/拆分子任务
// zx_20260910_3 M2c: 上限改为引用 task-accounting 的唯一判据（此处原写 `>= 2`，与守卫 `<3`、达成 `<=2` 三处各一个界）
function goalRestartExceeded(db: Database.Database, taskId: string): boolean {
  try {
    const c = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
    return goalDeviationCapReached(c.goal_deviation_restarts);
  } catch { return false; }
}

/** 到顶暂停的原因文案——GUI 横幅与 IM 通知共用一句，避免两处各写一版（`awaiting_input.question` 与 IM 推送同源） */
const GOAL_DEVIATION_PAUSE_REASON = '目标已多次偏离，已停止自动恢复，需人工介入（可回复聚焦指令后恢复）';

/**
 * zx_20260922_1 M4（F2 撤回承诺）：`sdkFailed` 重试的**如实**话术——一处在册、两处引用。
 *
 * 原文案分别写"已降级到非 reasoning 模型重试"（首轮入队）与"已降级/切换模型重试"（resume 回队），
 * **两句都超出机器真正做过的事**：`sdk_failed` **无选型读点**（只有"自守/成功后清理"两处非选型读点；选型只读 `sdk_fallback`），
 * 且 `exec-model-select.ts` 里 2026-09-01 的 P2修③ 明写"失败重试**不再**排除 reasoning"
 * ⇒ 这条重试走的就是同一个模型。真正切了备用 provider 的情形，上游已另发
 * "已自动切换备用 provider（xxx）重试"，此处无须再承诺。
 *
 * ⚠ 本常量是这句话的**唯一**出处：两条路径分处两个 handler，各写一版就会再次分家
 * （承 `zx_20260915 P0-4` 通知文案单源的同一纪律）。
 *
 * 与 `agent-executor.ts` 那条同源订正合起来只有一句：**本次重试不换模型。**
 */
const SDK_RETRY_RESUME_MSG = '[系统] 上次 AI SDK 调用失败，已自动重试。请继续执行未完成的工作。';

/**
 * 到顶暂停时写进会话流的收口说明——**一处真源**（首跑 `ai-task` 与恢复 `resume-ai-task` 两处逐字相同，原为两份拷贝）。
 *
 * zx_20260916_3 M1（毛选·惩前毖后治病救人：纠偏要给**走得通**的路）：原文案是
 * 「…请人工介入：回复聚焦指令，或**用 create_task 按里程碑拆分后恢复**」——而 `create_task` 此刻
 * **正被自己的广度上限拒掉**。这不是推理：真库实测（2026-09-17，只读）**16 条** `当前任务已有N个子任务（最大5个）`
 * 拒绝记录，落在 **8 个不同父任务**上（最早 2026-09-03，最近 2026-09-16），其中 **6 条**出在本轮标本 `5126b303` 身上；
 * 另有 2 条写作「已有**6**个子任务（最大5个）」——**判据自己都说出了"超过上限"**，正是 `[Sub]` 路无闸逃逸的实证。
 * 引擎一边把门关上，一边建议你走那扇门。现改为给三条**当下可执行**的路（闸满与闸空都成立），
 * 并说明"已终态子任务不占位"这一事实——避免把"槽位其实空着"误读成"满"。
 */
const GOAL_DEVIATION_CONVERGENCE_NOTE =
  `[目标偏离收敛] 目标已多次偏离（≥${GOAL_DEVIATION_MAX_RESTARTS} 次），不再自动恢复。任务保持暂停，请人工介入：`
  + `① 回复聚焦指令后恢复（最直接）；`
  + `② 若需拆分推进：把剩余里程碑交给**某个在途子任务**（send_message 追加指令），或先在**本任务内**收口；`
  + `③ create_task 仅在有**空闲槽位**时可用（上限 ${MAX_CHILD_BREADTH} 个在途子任务；已 completed/failed/archived 的子任务不占位——`
  + `若子任务都已完成，槽位已自动空出，可直接重试）（zx_20260904_5 D2/D4 · zx_20260916_3 M1）。`;

/**
 * zx_20261002 M5（维特根斯坦·意义即用法 / 毛选·集中兵力）：**启动路的「到点即拆」**。
 *
 * 病根（方案 §1.2-1）：自动拆解此前只长在 `enter_plan_mode` 这个**工具**里——模型不主动调用，
 * 拆解就永不发生（真库 `auto_decomposed` 恒零行）；`exec-context` 里那句"建议先 enter_plan_mode"
 * 只是**软建议**，不是门禁。本处理器是三条创建路（IM / GUI / 自治）的**唯一派发汇聚点**，
 * 在真正开跑之前先问一次"这个任务该拆吗"——把软建议变成**在册的动作**。
 *
 * 三道免 HTTP 的闸（顺序刻意：越便宜的越靠前）+ 一处既有实现：
 *   ① `isComplexOrPlanish`（与执行前软建议**同一把尺**）——只在复杂/规划类上动手，
 *      寻常任务不白跑一次拆解 LLM；
 *   ② `depth >= 2` 不再自动拆——与 `enter_plan_mode` 的 `depth >= 2` 拒绝**同一上限**（不新造阈值）；
 *   ③ `decomposedBefore`（持久标记 `$.auto_decomposed`）——**防回环**：子任务全部完成后
 *      `checkParentTaskAfterChildDone` 会把父置回 `pending` 并重派发，若只看 `alreadyDecomposed`
 *      （在途子数）此刻读到 0 ⇒ 再拆一遍 ⇒ 子完又恢复 ⇒ **无限循环**。`autoDecomposeForTask`
 *      内部仍问 `alreadyDecomposed`（防覆盖**模型正在进行的**规划），两道各管一件事。
 *
 * 拆成后父 **`paused` 等子**（而非 `planning`）：`CHAIN_BUSY_STATUSES` 含 `planning`，
 * 父停在那儿会**永久挡住自己的子**（`chainBlockReason`），且 `checkParentTaskAfterChildDone`
 * 只在父为 `paused`/`pending` 时才恢复它 ⇒ 死锁。故复用 `exec-finalize` 那条既有"父等子"形状
 * （同一判据码 `children_incomplete`，子全成后自动恢复父）。
 *
 * **失败即如实**：拆不出/调用不通/一行未建 ⇒ 返回 false，本次按**单任务照跑**（这正是改前的全部行为），
 * 绝不空建子任务充数。
 *
 * @returns true = 本次已拆并挂起父任务（调用方**不得**再执行它）
 */
export async function tryAutoDecomposeAtStart(
  db: Database.Database,
  opts: { taskId: string; projectId: string; getAnsClient: () => Promise<OptimalModelClient> },
): Promise<boolean> {
  try {
    const row = db.prepare('SELECT title, description, context_json FROM wa_tasks WHERE id = ?').get(opts.taskId) as
      | { title?: string | null; description?: string | null; context_json?: string | null }
      | undefined;
    if (!row) return false;
    const title = row.title || '';
    const description = row.description || '';
    // 闸①（免 HTTP）：复杂/规划类之外不动手
    if (!isComplexOrPlanish(assessComplexity(description), title, description)) return false;
    // 闸②（免 HTTP）：**只对顶层任务动手**（`depth === 0`）。
    //   §1.2 的实测病灶正是顶层的（`parent_task_id = ''` ∧ `auto_decomposed` 零行）；
    //   而层级 ≥ 1 的子任务**本身已是某次规划的产物**（拆解器或模型 create_task 建的），
    //   该层的模型仍可自行调 `enter_plan_mode`（执行前那条软建议就是给它的）——不在此路强行再拆，
    //   既防**成本失控**（否则每层各跑一次拆解 LLM，最坏 1+5+25 个任务量级），
    //   也防引擎替模型**重排它已经开始的规划**。
    const depth = ((JSON.parse(row.context_json || '{}') as { depth?: unknown }).depth as number) || 0;
    if (depth !== 0) return false;
    // 闸③（免 HTTP）：历史上拆过就别再拆（防"子全完成 ⇒ 父恢复 ⇒ 再拆"的回环）
    if (decomposedBefore(db, opts.taskId)) return false;

    const r = await autoDecomposeForTask({
      db, taskId: opts.taskId, projectId: opts.projectId,
      goal: `${title}\n${description}`.trim(),
      depth,
      getDeps: async () => makeAnsDecomposeDeps(await opts.getAnsClient()),
      patterns: loadDecompositionPatterns(db, opts.projectId),
      label: '任务启动', noDepWhen: '立即启动',
    });
    if (!r) return false;
    // 标记写法与 IM 路 / 引擎路**逐字同一形状**（三路共有层 `$.auto_decomposed`）。
    // 位置在 `pauseTask` **之前**：后者会读一次 `context_json` 再合并 `pause_reason` 写回（不抹键），
    //   故两种顺序结果相同；先写标记是为让"已拆"这一事实在父翻成 paused 的同时就已落盘，
    //   任何下游读点（GUI 溯源 / 模板提炼 / 本路的重入闸）任一刻读到的都是自洽状态。
    db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.auto_decomposed', json('true')), updated_at = datetime('now') WHERE id = ?").run(opts.taskId);
    recordInferredDeps(db, opts.taskId, r.inferredDeps);
    pauseTask(db, {
      taskId: opts.taskId,
      reason: PAUSE_REASON_CHILDREN_INCOMPLETE,
      note: `已自动拆解为 ${r.created} 个子任务（其中 ${r.noDepCount} 个无前置、可立即动工），本任务暂停待其完成后自动恢复`,
    });
    return true;
  } catch (e) {
    // 拆解失败**不阻断执行**：本次按单任务照跑（改前的全部行为）。
    console.log(`[拆解] 启动路自动拆解失败，按单任务执行: ${(e as Error)?.message}`);
    return false;
  }
}

interface JobContext {
  db: Database.Database;
  getAnsClient: () => Promise<{ getOptimalModel: (params: Record<string, unknown>) => Promise<Record<string, unknown>> }>;
  dataDir: string;
  sendImNotification?: (taskId: string, projectId: string, message: string) => void;
  /**
   * zx_20260924 M5: 任务完成时把**登记的主成果文件**推回来源会话。
   *
   * 为什么另起一个回调而不是塞进 `sendImNotification`：后者在**完成/失败/暂停/超长在场**四条路上共引
   * （`recordExecutionFailure`、`markPauseNeeded` 也走它），把"推件"放进去等于任务一失败也甩个 20MB 文件。
   * 推件只属于"本次真的成了"这一格。
   */
  sendImPrimaryDeliverables?: (taskId: string, projectId: string) => void;
  sendImAskUser?: (args: { channel: string; toUser: string; question: string; taskId: string; options?: string[] }) => Promise<void>;
  memory?: MemoryManager;
}

/** 从任务 context_json.sdk_fatal 读取账户级故障原始信息（供失败通知展示具体原因） */
function getSdkFatalMsg(db: Database.Database, taskId: string): string {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}');
    const fatal = ctx.sdk_fatal as { errMsg?: string; statusCode?: number } | undefined;
    return fatal?.errMsg ? String(fatal.errMsg).slice(0, 120) : '';
  } catch { return ''; }
}

/**
 * zx_20260915 P0-3(b)（失败必带因·**两个 catch 一处真源**）: 执行异常落账。
 *
 * 病根：`ai-task` 与 `resume-ai-task` 两个 catch 各写一版——且 `ai-task` 那一路此前**一个字都不落库**
 * （只发 IM）。于是"IM 报失败、账上从头到尾没有 failed"成为可能：实测 `f07ad74a` 08:19:00 IM 报
 * 「执行失败: FOREIGN KEY constraint failed」，而该任务 `status_changed` 序列为
 * `executing → paused → pending → executing`——**没有 failed**（§3.1 病根 C）。
 *
 * 故两处 catch 都只调本函数（各写一遍＝本轮要治的分家），且：
 * ① **不翻已了结的账**——状态已是 `completed`/`failed`/`archived`/`paused` 时只如实通知、不改状态。
 *    若不加这一条，一次"收尾时的通知异常"会把**已完成**的任务伪造成失败（同一条病，方向相反）。
 *    依据：`resume-ai-task` 的终态守卫（`curStatus === 'completed' || 'failed' || 'archived'`）
 *    与 §B5「非正常结束一律落 paused 而非 failed」的既有裁决。
 * ② 状态词由 `buildTaskNotice` **现查 DB** 得出，调用方无从谎报（P0-4 同源）。
 * ③ `afterRecord` 钩子用于子任务失败时唤起 D1——使父任务的 `children_incomplete` 暂停因**如实升级**
 *    为 `children_failed`，且**不**被静默恢复（见 checkParentTaskAfterChildDone）。
 *
 * 返回值供受控回归做"**值从 0 变 1**"正面断言（被 try/catch 吞掉的写入只有正面断言抓得住）。
 */
export function recordExecutionFailure(
  db: Database.Database,
  taskId: string,
  projectId: string,
  err: unknown,
  hooks?: {
    /**
     * zx_20261012_2 批五 M5: 原 `notify?` 钩子**已删**——失败 IM 现由 `markTaskFailed` 一处发
     *   （本函数落 `failed` 时把 `msg` 当 `reason` 传进去）。留着它就是"同一条失败两个出口"，
     *   改造后必然一次事实发两遍（`recordExecutionFailure` 直发 + 事件投影器再发）。
     */
    afterRecord?: (taskId: string) => void;
    /**
     * zx_20260930 M5: 失败知识写侧。传了才写。
     *
     * ⚠ 判据是**终局状态**（`status === 'failed'`），**不是** `recorded === true`：`executeTask` 自己
     *   （`agent-executor.ts:2681`）先把任务标 `failed` 再 `throw`，本函数读回的状态已是 `failed`
     *   ⇒ `recorded === false`。若按 `recorded` 写，**最常走的那条异常失败路一条也写不出来**。
     *   "该不该写"由 `writeFailureKnowledge` 自己的按任务幂等回答，不在这里再推一遍。
     */
    memory?: MemoryManager;
  },
): { recorded: boolean; status: string | null } {
  const msg = ((err as Error)?.message || String(err)).slice(0, 200);
  let recorded = false;
  let status: string | null = null;
  try {
    status = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined)?.status ?? null;
    if (status && !['completed', 'failed', 'archived', 'paused'].includes(status)) {
      // 批五 M5: 因由**随翻状态一并交出去**——失败 IM 由 `markTaskFailed` 一处发（见其 `notifyFailure`）；
      //   本处随后 emit 的 `task.failed` 带同一 `msg` ⇒ 投影器再调一次时被聚并窗口吃掉，恰好一条。
      markTaskFailed(db, taskId, { reason: msg });
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), taskId, `[执行失败] ${msg}`);
      eventBus.emit('task.failed', taskFailedPayload(db, taskId, projectId, 'ai-task', msg)).catch(() => {});
      recorded = true;
      status = 'failed';
    }
  } catch { /* 落账失败不阻断：下面仍照实通知（并道出这一笔没记上） */ }
  // zx_20260930 M5: 失败知识落库（此前 `failure_knowledge` 有读点无写点 ⇒ `<failure-awareness>` 恒空）。
  //   判据是**终局状态**（见上 `hooks.memory` 的注）：状态已 `failed` 即写，不论这一笔是不是本次落的。
  //   异常照旧吞掉：记忆写失败不得阻断失败落账，也不得把这一笔失败变回"没记上"。
  if (status === 'failed') {
    try { writeFailureKnowledge(db, hooks?.memory, taskId, projectId, err); } catch { /* 断言在 rr，不在生产日志 */ }
  }
  // 批五 M5: 原此处 `hooks.notify(...)` 已删——失败通知现由 `markTaskFailed` 一处发（带同一个 `msg`）。
  if (recorded || status === 'failed') {
    try { hooks?.afterRecord?.(taskId); } catch { /* 父任务复核 best-effort */ }
  }
  return { recorded, status };
}

/**
 * zx_20260930 M5: `failure_knowledge` 的**写侧**——读侧（`exec-context.ts` 的 `<failure-awareness>`）
 * 早已在册、写侧为零，故那一块此前**恒空**。
 *
 * 「这条记忆该说什么」**不在此处拼**，由 `core/memory-write.ts` 的纯函数 `buildFailureKnowledge` 定：
 *   ① 受控回归可直接 `import` 真函数做两侧可分断言（在夹具里重写一份就是"判据的自我印证"）；
 *   ② 读侧要的形状（取 `content` 前 120 字）与写侧产出只此一处对齐。
 *
 * 证据取**既有真源**、不新造字段：`context_json.failure_record`（**只有"无产出物"路会写它**，其余路为 null
 *   ——缺就如实不写那一行）、`err.message`、`context_json.archetype`。
 *
 * ⚠ `err` **可缺**：`"无产出物"`这条最常走的失败路（`agent-executor.ts:2589`）`executeTask` 是**正常返回**的，
 *   调用方手上根本没有异常对象——它的因由全在 `failure_record.reason`，故此处传 `undefined` 即如实。
 *
 * ⚠ **按任务幂等**（同一 `task_id` 至多一条 `failure_knowledge`）：读侧 `exec-context.ts` 取的是
 *   **项目内**最新 3 条，同一个任务的重复失败会把别的任务的教训挤出窗口；且失败 → 恢复 → 再失败
 *   时第一条仍在，注入不丢。第二次失败若换了因由，则由 `background-review`（按终态细分幂等）另取教训。
 *
 * 返回 storeText 的记忆 id（未写/已写过则 null），供受控回归做"**行数从 0 变 1**"正面断言。
 */
export function writeFailureKnowledge(
  db: Database.Database,
  memory: MemoryManager | undefined,
  taskId: string,
  projectId: string,
  err?: unknown,
): string | null {
  if (!memory) return null;
  const already = db.prepare('SELECT id FROM wa_memories WHERE task_id = ? AND memory_type = ? LIMIT 1')
    .get(taskId, MEM_TYPE_FAILURE_KNOWLEDGE) as { id?: string } | undefined;
  if (already) return null;
  const row = db.prepare('SELECT title, context_json FROM wa_tasks WHERE id = ?').get(taskId) as
    { title?: string; context_json?: string } | undefined;
  let taskCtx: { failure_record?: FailureRecord; archetype?: unknown } = {};
  try { taskCtx = JSON.parse(row?.context_json || '{}') as typeof taskCtx; } catch { /* 坏 JSON 当空 */ }
  const content = buildFailureKnowledge({
    title: row?.title || '',
    errorMessage: err == null ? null : ((err as Error)?.message || String(err)),
    record: taskCtx.failure_record ?? null,
    archetype: typeof taskCtx.archetype === 'string' ? taskCtx.archetype : null,
  });
  return memory.storeText({
    project_id: projectId, task_id: taskId,
    type: MEM_TYPE_FAILURE_KNOWLEDGE, content, source: 'task_failure',
  });
}

/**
 * zx_20260930 M5: `subagent_experience` 的**写侧**——与失败知识同病（读侧在册、写侧为零，
 *   全仓只在统计里被数，恒 0）。
 *
 * 「什么算子 agent」**不在此定义**，取子任务行自己的既成事实：`context_json.type === 'subagent'`
 *   （`tools/resource.ts:69` 派活时写入）；角色取同处的 `subagentType`。非子任务一律不动库。
 *
 * 证据取**既有两个真源**：成功取 `completion_summary`（`finalize_task` 写），
 *   失败取 `failure_record.reason` / `awaiting_input.question`（与 `buildReviewActual` 同尺，都不编）；
 *   关键事实取本任务已登记成果的**名字**（`wa_deliverables`，按共享范围谓词取、排除退休与探针）。
 *
 * ⚠ 按任务幂等（同 `writeFailureKnowledge`）：一个子 agent 的一生只留一条经验，
 *   恢复多轮不会堆出多份"同一件事"。
 *
 * 返回 storeText 的记忆 id（未写/非子任务/已写过则 null），供受控回归做"**行数从 0 变 1**"正面断言。
 */
export function writeSubagentExperience(
  db: Database.Database,
  memory: MemoryManager | undefined,
  taskId: string,
  projectId: string,
): string | null {
  if (!memory) return null;
  const row = db.prepare('SELECT title, status, context_json FROM wa_tasks WHERE id = ?').get(taskId) as
    { title?: string; status?: string; context_json?: string } | undefined;
  let tc: {
    type?: unknown; subagentType?: unknown; completion_summary?: unknown;
    failure_record?: FailureRecord; awaiting_input?: { question?: unknown };
  } = {};
  try { tc = JSON.parse(row?.context_json || '{}') as typeof tc; } catch { return null; }
  if (tc.type !== 'subagent') return null;
  const already = db.prepare('SELECT id FROM wa_memories WHERE task_id = ? AND memory_type = ? LIMIT 1')
    .get(taskId, MEM_TYPE_SUBAGENT_EXPERIENCE) as { id?: string } | undefined;
  if (already) return null;

  const ok = row?.status === 'completed';
  const reason = ok
    ? (typeof tc.completion_summary === 'string' ? tc.completion_summary : null)
    : (tc.failure_record?.reason || (typeof tc.awaiting_input?.question === 'string' ? tc.awaiting_input!.question! : null));
  let keyFacts: string | null = null;
  try {
    // 范围谓词走**共享真源**（M4-1）：排除已退休件与探针件——与成果页/计数同一个"算不算一条成果"。
    const w = deliverableScopeSql({ taskIds: [taskId] });
    const docs = db.prepare(`SELECT name FROM wa_deliverables WHERE ${w.sql} LIMIT 5`).all(...w.params) as Array<{ name?: string }>;
    const names = docs.map((d) => (d.name || '').trim()).filter(Boolean);
    if (names.length > 0) keyFacts = `产出物=${names.join('、')}`;
  } catch { /* 无成果表/无列：如实不写这一行 */ }
  const content = buildSubagentExperience({
    role: typeof tc.subagentType === 'string' ? tc.subagentType : null,
    title: row?.title || '',
    ok,
    reason,
    keyFacts,
  });
  return memory.storeText({
    project_id: projectId, task_id: taskId,
    type: MEM_TYPE_SUBAGENT_EXPERIENCE, content, source: 'subagent_terminal',
  });
}

/**
 * M3-7: 汇总某父任务下每个子的"交付了什么"——每子一行，只读既有真源。
 * 摘要取 `context_json.completion_summary`（finalize_task 写入，`agent-executor.ts:1002`），
 * 缺失时回退该子最近一条 assistant 回合；产出取 `wa_deliverables`；验收取 `context_json.acceptance_check`。
 * **不新增表、不新增字段**（共激的载体就是既有真源）。
 */
export function buildChildBriefs(db: Database.Database, parentId: string): string[] {
  const kids = db.prepare(
    "SELECT id, title, status, context_json FROM wa_tasks WHERE parent_task_id = ? AND status != 'archived' ORDER BY created_at ASC",
  ).all(parentId) as Array<{ id: string; title: string; status: string; context_json: string | null }>;
  const out: string[] = [];
  for (const k of kids) {
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(k.context_json || '{}') as Record<string, unknown>; } catch { /* 坏 JSON 当空 */ }
    let summary = typeof ctx.completion_summary === 'string' && ctx.completion_summary.trim()
      ? normalizeSnippet(ctx.completion_summary.trim(), 80)
      : '';
    if (!summary) {
      try {
        const last = db.prepare(
          "SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
        ).get(k.id) as { content?: string } | undefined;
        if (last?.content?.trim()) summary = normalizeSnippet(last.content.trim(), 80);
      } catch { /* 会话缺失则下走占位 */ }
    }
    if (!summary) summary = '(无完成摘要)';

    let delivs: Array<{ id: string; name: string; type: string; status: string; file_path?: string | null }> = [];
    try {
      const dScope = deliverableScopeSql({ taskIds: [String(k.id)] });
      delivs = db.prepare(
        `SELECT id, name, type, status, file_path FROM wa_deliverables WHERE ${dScope.sql} ORDER BY created_at DESC`,
      ).all(...dScope.params) as Array<{ id: string; name: string; type: string; status: string; file_path?: string | null }>;
    } catch { /* 查询失败如实报 0 件 */ }
    const pick = delivs.length > 0 ? selectSummaryDoc(delivs as unknown as SummaryDocRow[]) : null;
    const pickRow = pick ? delivs.find((d) => d.id === pick.id) : undefined;
    const delivPart = delivs.length > 0
      ? `产出 ${delivs.length} 件（${displayDocName({ name: delivs[0]!.name }, (pickRow ?? delivs[0]!).file_path)}${delivs.length > 1 ? ' 等' : ''}）`
      : '产出 0 件';
    const accPart = describeAcceptance(ctx.acceptance_check as AcceptanceInfo | undefined, true) || '未验收';
    // zx_20261022_3 批十二：子任务**结局**（含暂停因）必须随摘要回传——父任务醒来后要据此决定
    //   「续跑/修复/换路」；旧摘要只说"完成"，暂停子与完成子长得一样（真标本 094a8b47 等父永不知情）。
    const pauseReason = typeof ctx.pause_reason === 'string' ? ctx.pause_reason : '';
    const statusPart = k.status === 'paused'
      ? `暂停·${pauseReason ? (PAUSE_REASON_LABEL[pauseReason as keyof typeof PAUSE_REASON_LABEL] ?? pauseReason) : '未注明原因'}`
      : k.status === 'completed' ? '完成'
      : k.status === 'failed' ? '失败'
      : k.status;
    out.push(`${k.title}｜${statusPart}｜${summary}｜${delivPart}｜${accPart}`);
  }
  return out;
}

/**
 * D1: 子任务完成后自动检查父任务——所有兄弟子任务完成→恢复父任务。
 *
 * zx_20260913 M3-7(赫布·共激 / 名实相符): 恢复消息此前是一句固定文本"所有子任务已完成，恢复父任务"——
 * 父任务醒来后**不知道每个子交付了什么**，只能自己逐个去翻（共激的载体缺失）。现改为**结构化逐子回传**：
 * 子标题 ｜ 摘要 ｜ 产出 N 件 ｜ 验收 p/t。**只取既有字段**（wa_deliverables / context_json.acceptance_check），不新增表。
 * 另：兄弟判据并入三值同尺（含 archived）——已归档的子任务不应让父任务永不恢复（M3-6 同一把尺）。
 *
 * zx_20260915 P0-3(c/d)：本函数由 `registerAiTaskHandlers` 内的**闭包**改为**导出于模块层**——
 * 为的是让受控回归能直引**真实现**跑通「失败子重试为 completed ⇒ 父自动恢复」这条**防死锁**判据，
 * 而不是去切源码字符串（切片只能证明"字在那儿"，证明不了"路走得通"）。
 * 恢复所需的副作用经 `opts.enqueue` 注入：生产传 `scheduler.enqueue`，回归传记录桩。
 */
export function checkParentTaskAfterChildDone(
  db: Database.Database,
  taskId: string,
  opts?: { enqueue?: (type: string, payload: Record<string, unknown>) => Promise<unknown>; enqueued?: (pid: string) => void },
): void {
  try {
    const me = db.prepare('SELECT parent_task_id, status FROM wa_tasks WHERE id = ?').get(taskId) as { parent_task_id: string; status: string } | undefined;
    if (!me?.parent_task_id) return;
    // zx_20261022_3 批十二（知止）：同一笔暂停**只唤醒父一次**——父醒来若未处置该子，不得无限唤醒
    //   （否则「父暂停等子 → 唤醒 → 父再暂停」会互相点火）。标记写在本函数成功放行处。
    if (me.status === 'paused') {
      try {
        const cctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json || '{}') as { parent_wake_at?: unknown };
        if (typeof cctx.parent_wake_at === 'string' && cctx.parent_wake_at) return;
      } catch { /* 账坏则照常放行：宁可多唤醒一次，不可让父永不知情 */ }
    }
    // zx_20261018_3 D6（组2 实机照出）: 下方兄弟计数把"自己"排除（`id != ?`）——独子被暂停时若把
    //   暂停读成"已完成"，父会被假恢复（醒来发现子未完成，转而把子归档）。
    // zx_20261022_3 批十二（信·名实）：**暂停 ≠ 完成，但暂停 = 已停**——子任务一旦不会再自行推进，
    //   父任务就**必须**被唤醒来复核（旧实现把暂停一律早退 ⇒ 父永远停在 `children_incomplete`，
    //   M2 依赖子任务从未被拉起：真标本 094a8b47 / e54532f9 / 1ec0a89a）。故本函数认"已定局"
    //   （终态或 paused），且恢复消息**如实分列**各子结局，绝不把暂停写成"已完成"。
    if (!isTerminalTask(db, taskId) && me.status !== 'paused') return;
    const pid = me.parent_task_id;
    // 先问父任务是否处于等子态——不在等子态则本函数无话可说（早退，不做任何写）
    const parent = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(pid) as { status: string } | undefined;
    if (!parent || (parent.status !== 'paused' && parent.status !== 'pending')) return;
    // zx_20260915 P0-3(c)（**先失败、后未完成**）: 有失败子 ⇒ 父**不得**恢复。
    // 若在此放行，父会被置回 pending、resume 又被收口闸拦回 paused：pause→resume→re-pause 空转，
    // 且"已暂停待复核"的通知成了假话（正是 P0-4 那条病在 D1 路的副本）。
    // 此处只把父的暂停因**如实升级**为 children_failed——原来的 children_incomplete 会让用户以为
    // "子任务跑完就自动好"，而事实是有一个子已经失败了。
    const failedKids = failedChildren(db, pid);
    if (failedKids.length > 0) {
      if (parent.status === 'paused') {
        db.prepare("UPDATE wa_tasks SET updated_at = datetime('now'), context_json = json_set(COALESCE(context_json, '{}'), '$.pause_reason', ?) WHERE id = ?").run(PAUSE_REASON_CHILDREN_FAILED, pid);
        console.log(`[D1] 父任务因有失败子保持暂停: ${pid.slice(0, 8)}（失败子 ${failedKids.length} 个：${childNames(failedKids)}）`);
      }
      return;
    }
    // 查仍在推进的兄弟子任务（排除自己）——与 finalize_task/收口闸同尺：completed/failed/archived 皆算终态；
    //   zx_20261022_3 批十二：paused 同为"已停"，只在还有 `pending/executing/...` 的兄弟时才不唤醒父。
    const pending = (db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE parent_task_id = ? AND id != ? AND status NOT IN ('completed','failed','archived') AND status != 'paused'").get(pid, taskId) as { c: number }).c;
    if (pending === 0) {
      // zx_20261023_2 批四（毛选·集中优势兵力，不是一次把兵全撒出去）：槽位释放 ⇒ **先续拆、再唤醒父**。
      //   此前超出广度上限的里程碑"未建、不排期"，M2.5/M3 永远等不到创建。续出新的 pending 子任务
      //   就直接往下跑（父仍停着，等下批回来再续）；一条都续不出才走原有的"唤醒父复核收口"。
      const roll = createDeferredSubtasks(db, { parentTaskId: pid, projectId: (db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(pid) as { project_id: string } | undefined)?.project_id ?? '' });
      if (roll.created > 0) {
        console.log(`[D1] 槽位释放，续建子任务 ${roll.created} 个（父任务 ${pid.slice(0, 8)} 仍待本批完成）`);
        return;
      }
      // zx_20261023_3 批五（知）：账要**数全**——此前此处排除了 `archived`，于是"归档两个无效子任务"
      //   会被读成"子任务已全部结束"甚至"所有子任务已完成"，父被当成"子跑完了"拉起。
      //   归档与真完成是两件事：都算"已停"，但都不能说成"完成"。
      const kids = db.prepare('SELECT status FROM wa_tasks WHERE parent_task_id = ?').all(pid) as Array<{ status: string }>;
      const pausedKids = kids.filter((k) => k.status === 'paused').length;
      const archivedKids = kids.filter((k) => k.status === 'archived').length;
      db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(pid);
      // zx_20260915 P0-3(d): 该转移此前**无事件**（事件溯源里不存在，界面停在 paused 需手刷）——
      // zx_20260910_1 M3「暂停点补发 status_changed」的同一条病，此处是唯一漏网的那一个转移。
      const projectId = (db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(pid) as { project_id: string })?.project_id;
      eventBus.emit('task.status_changed', { taskId: pid, task_id: pid, projectId, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
      const briefs = buildChildBriefs(db, pid);
      // 全完成 ⇒ 沿用既有文案（rr 与界面均按此句识别）；含暂停/归档 ⇒ 如实分列，不把"停了"说成"完成"。
      //   无归档时"其中暂停 N 个"逐字不变；归档为 0 不出现在文案里（既有识别句保持）。
      const allDone = pausedKids === 0 && archivedKids === 0 && kids.every((k) => k.status === 'completed');
      const stopDetail = [pausedKids > 0 ? `暂停 ${pausedKids} 个` : '', archivedKids > 0 ? `归档 ${archivedKids} 个` : ''].filter(Boolean).join('、');
      const header = allDone
        ? '所有子任务已完成，恢复父任务'
        : stopDetail
          ? `子任务已全部结束（其中${stopDetail}），请复核并续跑/修复后再收口`
          : '子任务已全部结束，请复核并续跑/修复后再收口';
      const message = briefs.length > 0
        ? `[系统] ${header}。各子交付如下：\n${briefs.map((b) => `- ${b}`).join('\n')}`
        : `[系统] ${header}`;
      opts?.enqueue?.('resume-ai-task', { taskId: pid, message, projectId }).catch(() => {});
      opts?.enqueued?.(pid);
      // zx_20261022_3 批十二：记一笔"这次暂停已唤醒过父"——供上方早退判据去重（终态子不记：
      //   终态只发生一次，不构成自点火环）。
      if (me.status === 'paused') {
        try {
          const cctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json || '{}') as Record<string, unknown>;
          cctx.parent_wake_at = new Date().toISOString();
          db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(cctx), taskId);
        } catch { /* 标记失败只是可能多唤醒一次 */ }
      }
      console.log(`[D1] 子任务完成，自动恢复父任务: ${pid.slice(0, 8)}（逐子交付摘要 ${briefs.length} 条）`);
    }
  } catch {}
}

/** 并发已满时的重试上限（30 次指数退避，封顶 60s/次 ⇒ 约半小时量级的总等待）。 */
const MAX_CONCURRENCY_RETRIES = 30;

/** 「并发已满」的重试计数键（存 `wa_tasks.context_json`，随任务走而非随进程走）。 */
const CONCURRENCY_RETRY_KEY = 'concurrency_retry';

/**
 * 项目并发已满 ⇒ 落计数 + 指数退避 + 重排队（zx_20260930 M11-1：抽为**一处**，两条路共用）。
 *
 * 两个调用点：
 *   ① `ai-task` 执行前的**预检**——便宜（不白建工作目录、不进执行体）；
 *   ② `executeTask` **认领时被原子闸拒**（`result.concurrencyFull`）——预检与认领之间的竞态窗口。
 *
 * 为什么②必须与①同形：拒因是"位子满了"、**不是"这任务不行"**。若被 `steps: 0` 顺路当失败收掉，
 * 就等于把一次合法的调度竞争记成了任务失败（账失实）。两处若各写一份退避/上限/文案，
 * "并发已满"迟早在一个地方重试 30 次、在另一个地方 1 次收尾。
 *
 * 退避期间把状态落回 `pending`，使软闸 `scanReadyTasks` 与本次 `setTimeout` 两条路都能再捞起它。
 */
function scheduleConcurrencyRetry(
  db: Database.Database,
  scheduler: { enqueue: (type: string, payload: Record<string, unknown>) => Promise<string> },
  taskId: string,
  projectId: string,
  detail: { runningCount: number; limit: number; scope?: 'project' | 'machine' },
): void {
  const retryCtx = (() => { try { return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}'); } catch { return {}; } })();
  const retryCount = (retryCtx[CONCURRENCY_RETRY_KEY] ?? 0) + 1;
  if (retryCount > MAX_CONCURRENCY_RETRIES) {
    // 批五 M5: 带因（与随后 emit 的 `task.failed.error` 同词，免两条不同说法）。
    markTaskFailed(db, taskId, { reason: '并发重试超限' });
    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
      .run(crypto.randomUUID(), taskId, `[并发超限] 超过${MAX_CONCURRENCY_RETRIES}次重试，${detail.scope === 'machine' ? '机器' : '项目'}并发资源不足，任务放弃。`);
    eventBus.emit('task.failed', { taskId, projectId, error: '并发重试超限' }).catch(() => {});
    return;
  }
  const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 60_000);
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify({ ...retryCtx, [CONCURRENCY_RETRY_KEY]: retryCount }), taskId);
  db.prepare("UPDATE wa_tasks SET status = 'pending' WHERE id = ?").run(taskId);
  setTimeout(() => { scheduler.enqueue('ai-task', { taskId, projectId, source: 'concurrency_retry' }).catch(() => {}); }, backoffMs);
  // zx_20261018_3 批四: 归因如实——整机满不许说成"项目满"（两把尺）。
  console.log(`[ai-task] ${detail.scope === 'machine' ? '机器' : '项目'}并发已满(${detail.runningCount}/${detail.limit})，退避${backoffMs}ms后重试(第${retryCount}次)`);
}

export function registerAiTaskHandlers(ctx: JobContext, scheduler: {
  register: (type: string, handler: (payload: Record<string, unknown>) => Promise<void>) => void;
  enqueue: (type: string, payload: Record<string, unknown>) => Promise<string>;
}): void {
  const { db, memory } = ctx;

  /** 构建智能完成通知内容：
   *  zx_20260909 Y1(空性·如实 / 少则得 / 维特根斯坦·可判定): im.completion_summary=true → 向 IM 报"主要成果摘要块"
   *  (📄 主成果名 vN（✓已验收 p/t）＋一句摘要), 不再向手机屏丢产出文件前 800 字半截 markdown; false → 回旧行为。
   *  zx_20261011_1 M5(维特根斯坦·同一把尺): 旧行为路的"产出物文件 > completion_summary"改由
   *  `task-outcome.resolveTaskOutcome` **一处判定**——与 relay 回传同引（此前本路只按 `task_id` 选、
   *  不认 `changed_by` ⇒ 改写既存件的果在 IM 路上丢失，两路两把尺）。
   */
  const buildCompletionNotice = (taskId: string, aiContent: string): string => {
    try {
      const sumCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'im.completion_summary'").get() as { value?: string } | undefined;
      if (boolSetting(sumCfg?.value)) {
        // zx_20260911_2 M4-G5(矛盾律): 候选补探针滤除——与列表/交付单/全景同一 docNotProbe 谓词，
        // 防"临时探针 doc 被选为主要成果"播到 IM(此前唯一漏网处)。
        // zx_20260930 M4-1: 范围声明走共享真源（范围=「本任务、排除退休与探针」）。
        const cScope = deliverableScopeSql({ taskIds: [String(taskId)] });
        const rows = db.prepare(
          `SELECT id, name, type, status, is_primary, created_at, file_path, description FROM wa_deliverables WHERE ${cScope.sql} ORDER BY created_at DESC`
        ).all(...cScope.params) as Array<Record<string, unknown>>;
        const pick = selectSummaryDoc(rows as unknown as SummaryDocRow[]);
        if (pick) {
          let version: number | null = null;
          try { const v = db.prepare('SELECT MAX(version) AS v FROM wa_deliverable_versions WHERE deliverable_id = ?').get(pick.id) as { v: number | null }; version = v?.v ? Number(v.v) : null; } catch { /* 版本缺失则不带 */ }
          const tctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
          // zx_20260911_2 M4-G5(矛盾律): 验收徽标同 GUI 受 deliverable.show_acceptance 门控(关则不播)。
          const showAccCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.show_acceptance'").get() as { value?: string } | undefined;
          const accDesc = describeAcceptance(tctx.acceptance_check as AcceptanceInfo | undefined, boolSetting(showAccCfg?.value));
          const pk = pick as unknown as { file_path?: string | null; description?: string | null };
          let snippet = '';
          if (pk.file_path) { try { if (fs.existsSync(pk.file_path)) snippet = fs.readFileSync(pk.file_path, 'utf-8'); } catch { /* 读盘失败以 description 兜底 */ } }
          if (!snippet.trim()) snippet = String(pk.description || '');
          const block = buildSummaryBlock({
            name: displayDocName({ name: pick.name }, pk.file_path),
            version,
            accDesc,
            inDraft: pick.status !== 'completed',
            snippet: snippet ? normalizeSnippet(snippet, 150) : undefined,
          });
          if (block) return block;
        }
      }
      // 旧行为(im.completion_summary=false 或本任务无可报 doc): 产出物文件前 800 字 > completion_summary > AI 输出
      return completionNoticeFallback(db, taskId, aiContent);
    } catch { return aiContent ? aiContent.slice(0, 600) : ''; }
  };

  /** D1 的出口：把"该恢复父任务"交给真调度器（`checkParentTaskAfterChildDone` 本身已与 `db` 解耦，回归直引真实现） */
  const d1Enqueue = (type: string, payload: Record<string, unknown>) => scheduler.enqueue(type, payload);

  /** A1: 自治工作循环——检查项目自治模式，自动创建后续任务（链深度上限3） */
  const checkAutonomousChain = (taskId: string, projectId: string) => {
    try {
      const projAutonomous = db.prepare('SELECT autonomous_mode, context_json FROM wa_projects WHERE id = ?').get(projectId) as { autonomous_mode: string; context_json: string } | undefined;
      const mode = projAutonomous?.autonomous_mode || 'off';
      if (mode === 'off') return;
      const ctx: Record<string, unknown> = (() => { try { return JSON.parse(projAutonomous?.context_json || '{}'); } catch { return {}; } })();
      const backlog = (ctx.backlog as string[]) || [];
      const chainDepth = (ctx.autonomous_chain_depth as number) || 0;
      if (chainDepth >= 3) {
        console.log(`[autonomous] 自治链深度已达上限(3)，停止自动创建任务`);
        ctx.autonomous_chain_depth = 0;
        db.prepare("UPDATE wa_projects SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctx), projectId);
        return;
      }
      if (backlog.length === 0) {
        if (chainDepth > 0) { ctx.autonomous_chain_depth = 0; db.prepare("UPDATE wa_projects SET context_json = ? WHERE id = ?").run(JSON.stringify(ctx), projectId); }
        return;
      }
      const nextTitle = backlog.shift()!;
      const newTaskId = crypto.randomUUID();
      db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, priority, source, context_json) VALUES (?, ?, ?, ?, ?, 0, 'autonomous', ?)")
        .run(newTaskId, projectId, nextTitle, '[自治创建] 来自项目backlog', 'pending', JSON.stringify({ autonomous_chain_depth: chainDepth + 1, triggered_by: taskId }));
      ctx.backlog = backlog;
      ctx.autonomous_chain_depth = chainDepth + 1;
      db.prepare("UPDATE wa_projects SET context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctx), projectId);
      console.log(`[autonomous] 自治模式→创建后续任务: ${nextTitle.slice(0, 30)} (深度${chainDepth + 1})`);
      if (mode === 'auto') {
        scheduler.enqueue('ai-task', { taskId: newTaskId, message: `[自治执行] ${nextTitle}`, projectId, source: 'autonomous' }).catch(() => {});
      }
    } catch (err) { console.warn('[autonomous] 自治循环检查失败:', (err as Error).message); }
  };

  /** ai-task: 新任务执行 */
  scheduler.register('ai-task', async (payload) => {
    const taskId = payload.taskId as string;
    const projectId = payload.projectId as string;
    const source = payload.source as string | undefined;
    const channel = payload.channel as string | undefined;
    const externalUser = payload.externalUser as string | undefined;
    if (!taskId) return;

    const task = db.prepare('SELECT title FROM wa_tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
    try {
      // zx_20261002 M5（维特根斯坦·意义即用法）：**到点即拆**——不依赖模型自觉调 `enter_plan_mode`。
      //   位置在并发预检**之前**：拆解决策与项目忙不忙无关；若先退避重试，同一任务会被反复问一遍"该拆吗"。
      //   真拆则父置 paused 等子、本次**不再执行**（子任务由各自的 ai-task 派发）。
      if (await tryAutoDecomposeAtStart(db, { taskId, projectId, getAnsClient: ctx.getAnsClient })) return;

      // zx_20261002 M8-①（裁定：计为「无前置」+ 留痕告警）：`unresolved` 前置照旧**不阻塞**（不动 M3-2 字节等价），
      //   但"这个前置根本不存在"要留痕——否则写错的 `depends_on` 会让 DAG 约束**静默失效**，用户零感知。
      //   位置与上面那句同理（与项目忙不忙无关，压在并发预检之前）：只在**真要开跑**时记，故排在拆解钩子**之后**
      //   （拆解成功则本任务转等子、不开跑，那笔账由子任务各自记）。实现与文案在 `task-accounting` 一处（rr 直跑）。
      const depWarn = warnDepsUnresolved(db, taskId);
      if (depWarn) {
        console.warn(`[依赖] 任务 ${taskId.slice(0, 8)} 存在库中查不到的前置（已按「无前置」放行）：${depWarn.unknownIds.join('、')}`);
      }

      // 硬并发控制：项目并发满→指数退避重试，超限→failed
      // zx_20260929 M5-d（管子·度量衡）：上限与计数改取唯一真源——此前此处写死 `3`，
      //   而软闸 `scanReadyTasks` 读 `rhythm.maxConcurrency ?? 2`、只数 executing ⇒ **两套表**：
      //   同一项目两处上限不同（真库 A股 rhythm=5 却仍被硬闸压在 3）、分母不同。
      //   现两处同读 `resolveProjectConcurrency`（limit=rhythm ?? 3，running=三态计数）。
      // zx_20260930 M11-1：本预检**只是便宜的快路**，不是判据——它与认领时的占位之间仍有竞态窗口，
      //   真正的闸已内联进 `claimTaskForExecution` 的那条 CAS（见下方 `result.concurrencyFull` 分支）。
      const conc = resolveProjectConcurrency(db, projectId);
      if (conc.running >= conc.limit) {
        scheduleConcurrencyRetry(db, scheduler, taskId, projectId, { runningCount: conc.running, limit: conc.limit });
        return;
      }

      const result = await executeTask({ ...ctx, sendImAskUser: ctx.sendImAskUser }, taskId);
      // zx_20260930 M11-1: 认领时被**原子并发闸**拒绝（预检通过后位子被别的执行体占走）。
      //   任务本身有效 ⇒ 与上面的预检同走一处退避重排，**不**当作失败收尾。
      //   判据从 `executeTask` 一路带上来（不是在这里重读并发数——重读又是一次 check-then-act）。
      if (result.concurrencyFull) {
        if (result.concurrencyScope === 'machine') {
          // 机器尺的读数**现取**（预检读的是项目尺，拿它当机器日志就是张冠李戴）。
          const machineLimit = resolveMachineConcurrencyLimit(db, {}).limit;
          scheduleConcurrencyRetry(db, scheduler, taskId, projectId, {
            runningCount: countMachineRunning(db),
            limit: machineLimit,
            scope: 'machine',
          });
        } else {
          scheduleConcurrencyRetry(db, scheduler, taskId, projectId, { runningCount: conc.running, limit: conc.limit, scope: 'project' });
        }
        return;
      }
      // A1 (2026-08-31): 目标偏离软重启——executeTask 已把偏离提醒作 user 消息写库并置 pending，这里重新入队 resume 继续（偏离提醒随对话历史注入下一轮）
      if (result.goalDeviationRestart) {
        if (goalRestartExceeded(db, taskId)) {
          db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
            .run(crypto.randomUUID(), taskId, GOAL_DEVIATION_CONVERGENCE_NOTE);
          // zx_20260909_1 M1(A1): 目标偏离收敛需人工介入→通知创建人（`note` 即该告知文案，逐字保留）。
          // zx_20260917 M1（第二只标本的入口）: 这条路此前"因"已算出、写进了 `awaiting_input.question`
          //   与通知正文，却**没有**落 `pause_reason`——账上读不出因，正是本轮要治的失明。现由唯一写入口一并落笔。
          pauseTask(db, { taskId, reason: PAUSE_REASON_GOAL_DEVIATION, note: GOAL_DEVIATION_PAUSE_REASON });
          // zx_20260910_3 M2d-b: 系统侧到顶暂停也写「等待输入」真源——此前只走 IM，GUI 横幅无据可显（同一暂停两处呈现不同真相）。
          // 复用 zx_20260910_1 的唯一真源（不新造字段）；副带收益：该暂停从此有 asked_at，重复提交判重对它同样生效。
          // zx_20260915 P0-5(d): asked_at 取 persistAwaitingInput 的返回值（四点同形，不自造时间戳）
          const devAskedAt = persistAwaitingInput(db, taskId, { question: GOAL_DEVIATION_PAUSE_REASON, options: [], decision_type: 'goal_deviation_pause' });
          eventBus.emit('task.awaiting_input', { taskId, task_id: taskId, projectId, question: GOAL_DEVIATION_PAUSE_REASON, decision_type: 'goal_deviation_pause', options: [], context: {}, asked_at: devAskedAt }).catch(() => {});
          return;
        }
        scheduler.enqueue('resume-ai-task', { taskId, projectId, message: '[系统] 继续执行（检测到目标偏离，已提示回正，请聚焦核心目标）' }).catch(() => {});
        return;
      }
      // A4 (2026-08-31): AI 供应商账户级故障（余额不足/鉴权失败，备用 provider 也不可用）——executeTask 已置 paused，通知用户后停止，不重试
      if (result.sdkFatal) {
        const fatalMsg = getSdkFatalMsg(db, taskId);
        if (ctx.sendImNotification && task) {
          // zx_20260915 P0-4(同源): 文案由 buildTaskNotice 构造——状态词现查 DB（此刻确为 paused ⇒ 说"已暂停"），
          //   不再由调用方手写；开关 im.notice_single_source 关则退回"调用方自述"语义（仍不复活字面量）。
          ctx.sendImNotification(taskId, projectId, buildTaskNotice(db, taskId, 'paused', { detail: `AI 引擎账户级故障：${fatalMsg || '余额不足或供应商不可用'}。请充值或切换 AI 供应商后恢复任务。` }).message);
        }
        return;
      }
      // zx_20260923 M1: 同一事故内**两次都失败** ⇒ executeTask 已置 `paused`（T1）。
      //   **不得**再入队 resume：那会与本次暂停构成 pause→resume→pause 死循环（旗仍在 ⇒ 下次直接再停）。
      //   告知已由 `pauseTask` 的 `note` 发出（与账户级故障同形），此处只收尾。
      if (result.sdkExhausted) return;
      // A3 (2026-08-31): AI SDK 失败重试——executeTask 已标记 sdk_failed，重新入队 resume。
      // zx_20260922_1 M4（F2 撤回承诺）：原注释写"（模型获取将排除 reasoning）"、文案写"已降级到非 reasoning 模型重试"，
      // **两句都不成立**——`sdk_failed` 无选型读点（选型只读 `sdk_fallback`），重试用的是同一个模型。
      // 此处如实化：只说"重试"，不承诺换模型。
      if (result.sdkFailed) {
        scheduler.enqueue('resume-ai-task', { taskId, projectId, message: SDK_RETRY_RESUME_MSG }).catch(() => {});
        return;
      }
      // Phase 1.2: 实践反馈强化——成功（A2 实事求是：仅 status==='completed' 才算成功，failed/executing/preparing 不误强化）
      const statusRow = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
      if (statusRow?.status === 'completed' && memory) {
        try {
          const ctxJson = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
          const qualityScore = ctxJson.completion_quality?.score as number | undefined;
          memory.reinforceMemories(taskId, projectId, true, qualityScore);
          // A1 (2026-09-02): 工作记忆→长期记忆巩固门——成功任务的关键笔记沉淀为长期记忆（供后续相似任务召回）
          try { memory.promoteWorkingMemory(taskId, projectId, true); } catch {}
        } catch {}
      }
      // zx_20260930 M5: 失败知识落库——**"无产出物"这条最常见的失败路走的正是这里**。
      //   `executeTask` 在 `agent-executor.ts:2589` 标了 `failed` 便**正常返回**（不抛），
      //   故本处理器的 `catch`（那里也写失败知识）根本不会执行；唯一能看见这次失败的就是这一行读回的终态。
      //   手上没有异常对象 ⇒ `err` 传 `undefined`（因由已由 `failure_record.reason='无产出物'` 提供）。
      if (statusRow?.status === 'failed') {
        try { writeFailureKnowledge(db, memory, taskId, projectId); } catch { /* 断言在 rr，不在生产日志 */ }
        // zx_20261018_3 实机 E2E（2026-10-19）: 本路是「无产出物」失败（正常返回、不进 catch）——
        //   它到不了 catch 里的 `reinforceMemories(false)`，注入账结局会永远停在 `pending`
        //   （实测记忆页"失败"恒 0）。终态是唯一能结账的时刻：此处只回填结局，不碰强化计数。
        if (memory) { try { memory.backfillInjectionOutcomes(taskId, 'failed'); } catch {} }
      }
      // zx_20260930 M5: 子 agent 经验落库——成败**两条路都写**（`writeSubagentExperience` 自己判是否子任务）。
      //   与上面的失败知识同刻同处：终态是唯一"这一生可以总结了"的时刻（非子任务则一字不写）。
      if (isReviewableStatus(statusRow?.status)) {
        try { writeSubagentExperience(db, memory, taskId, projectId); } catch { /* 断言在 rr，不在生产日志 */ }
      }
      // 任务成功后清除 sdk_failed/sdk_failed_at/sdk_fallback/sdk_fatal（降级/切备用是临时措施，成功后恢复正常模型，避免下次任务仍锁定备用 provider；事故旗同此结清）
      if (statusRow?.status === 'completed') {
        try {
          const clearCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
          // zx_20260923 M1: 事故的结账走 `closeSdkIncident`（连同 `sdk_failed_at` 一起清，不手抄键名）
          const hadIncident = closeSdkIncident(clearCtx);
          if (hadIncident || clearCtx.sdk_fallback || clearCtx.sdk_fatal) {
            delete clearCtx.sdk_fallback;
            delete clearCtx.sdk_fatal;
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(clearCtx), taskId);
          }
        } catch {}
      }
      // B2/C1 (2026-08-31): 识别偏差检测 + 纠错记忆（识别随实践校准——偏差沉淀为记忆供下次参考）
      if (statusRow?.status === 'completed' && memory) {
        try {
          const deviation = detectArchetypeDeviation(db, taskId);
          if (deviation) {
            const content = `任务「${task?.title || ''}」识别为 ${deviation.from} 但实际应 ${deviation.to}，依据：${deviation.evidence}`;
            // zx_20260929 M4: 同源替换优先（读者是 `retrieveByType('archetype_correction', …, 3)`，
            //   直写会让同一项目的偏差记录互相挤占 top3 名额）。与 `promoteWorkingMemory` 同一把尺。
            if (!memory.sameSourceReplace(projectId, 'archetype_deviation', content)) {
              memory.storeText({ project_id: projectId, task_id: taskId, type: 'archetype_correction', content, source: 'archetype_deviation' });
            }
          }
        } catch {}
      }
      // B5: 非正常结束（executeTask 返回但状态仍是 executing/preparing）→ 自动标记 paused
      if (statusRow && (statusRow.status === 'executing' || statusRow.status === 'preparing')) {
        // zx_20260917 M1: 因由 `abnormal_end`——"executeTask 已返回，任务却仍停在 executing/preparing"
        //   此前只落状态、不落因（现状也不告知创建人，故不传 `note`）。
        pauseTask(db, { taskId, reason: PAUSE_REASON_ABNORMAL_END });
        console.log(`[ai-task] 任务非正常结束，标记paused: ${taskId.slice(0, 8)}`);
      }
      // F2: 任务完成 IM 通知（智能内容：产出物文件 > 摘要 > AI输出，暂停任务不发）
      if (ctx.sendImNotification && task && statusRow?.status === 'completed') {
        const smartContent = buildCompletionNotice(taskId, result.content);
        ctx.sendImNotification(taskId, projectId, buildTaskNotice(db, taskId, 'completed', { detail: smartContent }).message);
      }
      // zx_20260924 M5: 完成通知之后再补**件本身**（文字说了"主成果是什么"，件得真到场才算交付）。
      //   独立于上一条的 `task` 前置（推件只用 taskId 查库，不依赖标题已读到）。
      if (ctx.sendImPrimaryDeliverables && statusRow?.status === 'completed') {
        try { ctx.sendImPrimaryDeliverables(taskId, projectId); } catch { /* 推件失败不阻断收尾 */ }
      }
      // Phase 7.3: 记忆提取——storeText(对话摘要) + embed-memory(向量) + background-review(LLM提取)
      try {
        if (memory && statusRow?.status !== 'paused') {
          memory.storeText({ project_id: projectId, task_id: taskId, content: `任务「${task?.title || ''}」执行结果: ${result.content.slice(0, 500)}`, source: 'task_execution' });
        }
        scheduler.enqueue('embed-memory', {}).catch(() => {});
        // zx_20260906 批2: background-review 仅在任务**终态**调度（fail/resume 多轮整批重复已在 handler 内 single-flight 去重 + 成本记账）
        // zx_20260930 M5: 守卫从写死的 `'completed'` 放宽到共享终态集（含 `failed`）——失败也复盘。
        //   判据取自 `task-terminal.ts` 一处，不在本行另写一份名单。
        if (isReviewableStatus(statusRow?.status)) scheduler.enqueue('background-review', { taskId, projectId }).catch(() => {});
      } catch {}
      // 2.4 遵守规则：每5个完成任务校准一次项目级自适应阈值
      try {
        const doneCount = (db.prepare("SELECT COUNT(*) as c FROM wa_tasks WHERE project_id = ? AND status = 'completed'").get(projectId) as { c: number }).c;
        if (doneCount > 0 && doneCount % 5 === 0) calibrateProjectThresholds(db, projectId);
      } catch {}
      // C3: 矛盾张力自动调节（每次任务完成后评估，开启 autoAdjust 的张力才调整）
      try {
        const { evaluateAutoTensions } = await import('../tension-engine.js');
        evaluateAutoTensions(db, projectId);
      } catch {}
      // F3: 任务完成后立即处理通知文件（原后端 L3384 行为）
      try { triggerF3Notification(); } catch {}
      // D1: 子任务完成后自动检查父任务（所有兄弟子任务完成→恢复父任务）
      try { checkParentTaskAfterChildDone(db, taskId, { enqueue: d1Enqueue }); } catch {}
      // zx_20261023_5 批一：本机完成任务 ⇒ 依赖它的后继重新走一次派发决策（有依赖也照样能跨机）。
      try { scheduleDependentDispatch(db, taskId); } catch { /* 后继外派失败不影响本任务收尾 */ }
      // A1: 自治工作循环——项目自治模式下，完成后自动创建后续 backlog 任务
      if (statusRow?.status === 'completed') {
        try { checkAutonomousChain(taskId, projectId); } catch {}
      }
    } catch (err) {
      console.error(`[ai-task] 执行失败: ${taskId.slice(0, 8)}`, (err as Error).message);
      // zx_20260915 P0-3(b)(失败必带因): 落账 + 如实通知 + 唤起父任务复核——两路 catch 共用同一处。
      // 此前本路**一个字都不落库**（只发 IM）⇒"IM 报失败、账上没有 failed"（f07ad74a）。
      // zx_20260930 M5: 失败也复盘——判据是**终局状态**（`rec.status === 'failed'`）而非 `rec.recorded`。
      //   `executeTask` 先自己标 `failed` 再 `throw`（`agent-executor.ts:2681`）⇒ 本 catch 里读回的状态已是
      //   `failed`、`recorded === false`；若按 `recorded` 判，这条最常走的异常失败路**永不复盘**。
      //   重复调度不靠"不调度"防，而靠 handler 的**按终态细分**幂等（同一种结局只复盘一次）。
      const rec = recordExecutionFailure(db, taskId, projectId, err, { afterRecord: (tid) => checkParentTaskAfterChildDone(db, tid, { enqueue: d1Enqueue }), memory });
      if (rec.status === 'failed') { try { scheduler.enqueue('background-review', { taskId, projectId }).catch(() => {}); } catch { /* 调度失败不阻断收尾 */ } }
      // zx_20260930 M5: 本路（异常失败）也要落子 agent 经验——上方成功路的那一处**走不到这里**
      //   （抛异常 ⇒ 从 `executeTask` 直接跳到本 catch）。成败两路都要被总结，故两处各写一次；
      //   幂等由 `writeSubagentExperience` 按任务自持，无重复之虞。
      if (rec.status === 'failed') {
        try { writeSubagentExperience(db, memory, taskId, projectId); } catch { /* 断言在 rr，不在生产日志 */ }
      }
      // Phase 1.2: 实践反馈强化——失败（真正的执行异常才强化）
      if (memory) {
        try { memory.reinforceMemories(taskId, projectId, false); } catch {}
        // A1 (2026-09-02): 工作记忆→长期记忆巩固门——失败任务的工作笔记也沉淀（失败要点供下次参考）
        try { memory.promoteWorkingMemory(taskId, projectId, false); } catch {}
      }
      // zx_20260930 M5 订正（承 zx_20260906 批2）: 本行原先写「失败不再调度 background-review」——
      //   本轮起**失败也复盘**（上方 `rec.status === 'failed'` 那一支）。防重复不靠"永不调度"，而靠 handler 里的
      //   **按终态细分**的持久化幂等（同一种结局只复盘一次）＋同任务 single-flight。
      //   失败要点的轻量沉淀（`reinforceMemories(false)` + `promoteWorkingMemory`）**照旧保留**：
      //   它们写的是既有记忆的强化/工作记忆，与复盘**提炼新记忆**是两件事，不是替代关系。
    }
  });

  /** resume-ai-task: 恢复暂停/失败任务 */
  scheduler.register('resume-ai-task', async (payload) => {
    const taskId = payload.taskId as string;
    let projectId = payload.projectId as string | undefined;
    const message = payload.message as string | undefined;
    if (!taskId) return;

    try {
      if (!projectId) {
        const t0 = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
        projectId = t0?.project_id || '';
      }

      // 防重入：任务已在执行中→跳过，防止重复恢复
      const curStatus = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status: string } | undefined)?.status;
      if (curStatus === 'executing' || curStatus === 'preparing' || curStatus === 'running') {
        console.log(`[resume-ai-task] 任务已在执行(${curStatus})，跳过重复恢复: ${taskId.slice(0, 8)}`);
        return;
      }
      // A1/A3 (2026-09-04): 终态任务不再复活（残留 resume 作业直接收尾，不产生"完成了还在跑"）
      if (curStatus === 'completed' || curStatus === 'failed' || curStatus === 'archived') {
        console.log(`[resume-ai-task] 任务已终态(${curStatus})，跳过恢复并收尾: ${taskId.slice(0, 8)}`);
        return;
      }

      // 6.5: 无对话历史的任务 → 转为全新执行（ai-task），不再直接拒绝
      const convCheck = (db.prepare('SELECT COUNT(*) as count FROM wa_task_conversations WHERE task_id = ?').get(taskId) as { count: number }).count;
      if (convCheck === 0) {
        const t1 = db.prepare('SELECT description, title FROM wa_tasks WHERE id = ?').get(taskId) as { description: string; title: string } | undefined;
        const firstMsg = t1?.description || t1?.title || message || '请开始执行任务';
        scheduler.enqueue('ai-task', { taskId, message: firstMsg, projectId, source: 'resume_no_history' }).catch(() => {});
        console.log(`[resume-ai-task] 任务无对话历史，转为全新执行: ${taskId.slice(0, 8)}`);
        return;
      }

      // 2.1.2: 根任务(source=user)所有子任务已完成→强制finalize
      let forceFinalize = false;
      try {
        const t2 = db.prepare('SELECT source, parent_task_id FROM wa_tasks WHERE id = ?').get(taskId) as { source: string; parent_task_id: string } | undefined;
        if (t2?.source === 'user') {
          const children = db.prepare('SELECT id, status FROM wa_tasks WHERE parent_task_id = ?').all(taskId) as Array<{ status: string }>;
          if (children.length > 0 && children.every(c => c.status === 'completed' || c.status === 'failed')) {
            forceFinalize = true;
          }
        }
      } catch {}

      // C1: 恢复账追踪（连续多次恢复无进展 → 提示拆分子任务）。
      // zx_20260916_1 M5 (#6): 自增点**就在这里**（不是 `ai-task`），且按入队者分流——用户介入计 `resume_count`，
      //   系统路（偏离/降级/子任务完成/重启/自动拉取，均不传 `initiator`）计 `auto_resume_count`。
      //   分流判据与两个键的真源在 `core/resume-ledger.ts`（纯函数，rr 直跑真实现）。提示看**总数**，行为不变。
      let resumeHint = '';
      try {
        const rctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        const { total } = bumpResumeLedger(rctx, payload.initiator as string | undefined);
        // zx_20260923 M1-b: **用户手动恢复 = 一次新事故** ⇒ 结掉旧旗（重新获得一次重试额度）。
        //   引擎自动重试不走此路（`initiator` 缺省 `'system'`，缺省值本身是契约）⇒ 旗保留，
        //   同一事故内第二次失败才停。标本 `a290ae2b` 的病正是缺这一笔：09-22 立的旗跨 20 小时
        //   斩了 09-23 那次**首次**失败的头。
        if (payload.initiator === 'user') closeSdkIncident(rctx);
        // zx_20260923 M6-a: **同一次介入，也要把产出闸的额度还给他**。旗（M1-b）与额度（本条）是两笔
        //   同类账——"这一次事故/这一次介入"该有它自己的额度，而不是记在"任务的一生"上。
        //   不还的后果见 `task-terminal.ts` 的 `grantDeliverableRetryQuota`：`retries < 1` 恒假 ⇒
        //   自动补一轮的通道永久关闭，用户只能手工动库（G16）。**同点同因**，与上一行一起翻。
        if (payload.initiator === 'user') grantDeliverableRetryQuota(rctx);
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(rctx), taskId);
        if (total >= 3) {
          resumeHint = `\n⚠️ 本任务已恢复 ${total} 次仍未完成。若当前任务过于复杂，可调用 create_task 工具拆分为多个子任务并行执行。`;
        }
      } catch {}

      // zx_20260915 P0-5(c): 非用户恢复**不得被当成「对悬置提问的同意」**——守卫本体是
      //   `pause-settlement.buildUnansweredBanner`（纯函数，回归直跑真实现，不在此复刻判据）；
      //   本节只负责"读 ctx + 认开关"。`initiator` 缺省 `'system'`（六条非用户路一条都不传，
      //   见方案 §5.2 病根 C）——故**缺省值本身是契约**，静态判据钉住其方向。
      let answerBanner = '';
      if (readBoolSetting(db, 'engine.answer_provenance')) {
        try {
          const g = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
          answerBanner = buildUnansweredBanner(g, payload.initiator as string | undefined);
        } catch { /* 读不到 ctx 则不拦——判不了就不拦（与 isDuplicatePauseResponse 同一纪律） */ }
      }

      // 构建恢复上下文消息（原后端 getTaskContext：项目信息 + 任务信息 + 验收标准 + 失败经验）
      const synthesized = !message;
      const synthBlock = message || (() => {
        try {
          const t = db.prepare('SELECT project_id, title, description, acceptance_criteria, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string; title: string; description: string; acceptance_criteria: string; context_json: string } | undefined;
          if (!t) return undefined;
          const p = db.prepare('SELECT name, description, working_dir FROM wa_projects WHERE id = ?').get(t.project_id) as { name: string; description: string; working_dir: string } | undefined;
          // C3: 失败经验注入
          let failureHint = '';
          try {
            const failCtx = JSON.parse(t.context_json || '{}');
            if (failCtx.failure_record) {
              const fr = failCtx.failure_record as { reason: string; toolCount: number; tools: string[] };
              failureHint = `\n⚠️ 注意：本轮之前曾因「${fr.reason}」失败（${fr.toolCount}次工具调用，主要工具：${(fr.tools || []).join(',')}）。请调整策略，避免重复相同的错误模式。`;
            }
          } catch {}
          // 进度摘要：统计之前会话的读/写/命令调用次数 + 已读清单 + 已搜词 + 已有产出物（避免重复探索）
          let progressSummary = '';
          try {
            const readCount = (db.prepare("SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' AND content LIKE '%read_file%'").get(taskId) as { c: number }).c;
            const writeCount = (db.prepare("SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' AND content LIKE '%write_file%'").get(taskId) as { c: number }).c;
            const cmdCount = (db.prepare("SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' AND content LIKE '%execute_command%'").get(taskId) as { c: number }).c;
            // zx_20260904_4 T4 (2026-09-04): 已读文件/已搜词清单——解析 `[工具调用] read_file/search_content` 行，
            // 供恢复时"命中即复用、勿整文重读/重复搜索"
            const readSet: string[] = [];
            const querySet: string[] = [];
            try {
              const toolRows = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' AND content LIKE '[工具调用] %'").all(taskId) as Array<{ content: string }>;
              for (const row of toolRows) {
                for (const m of row.content.matchAll(/read_file\(\{"filePath":"([^"]+)"\}/g)) {
                  const fp = (m[1] || '').split(/[\\/]/).pop() || m[1] || '';
                  if (fp && !readSet.includes(fp)) readSet.push(fp);
                }
                if (row.content.includes('search_content')) {
                  for (const m of row.content.matchAll(/"(?:query|keyword|q)"\s*:\s*"([^"]{2,80})"/g)) {
                    if (!querySet.includes(m[1]!)) querySet.push(m[1]!);
                  }
                }
              }
            } catch { /* 清单解析失败不阻塞 */ }
            const delivs = db.prepare("SELECT name, type, status FROM wa_deliverables WHERE task_id = ?").all(taskId) as Array<{ name: string; type: string; status: string }>;
            const delivSummary = delivs.length > 0 ? delivs.map(d => `${d.name}(${d.type}/${d.status})`).join(', ') : '无';
            const readList = readSet.length > 0 ? `\n- 已读文件(前12): ${readSet.slice(0, 12).join(', ')}` : '';
            const searchList = querySet.length > 0 ? `\n- 已搜索(前8): ${querySet.slice(0, 8).join('；')}` : '';
            progressSummary = `\n## 进度摘要\n- 之前已读 ${readCount} 个文件，写 ${writeCount} 次，执行命令 ${cmdCount} 次${readList}${searchList}\n- 已有产出物: ${delivSummary}\n⚠️ 已读文件/已搜词命中即复用已有理解，不要再整文重读或重复搜索同一目标；确需更新仅读差异。`;
          } catch {}
          return [
            `[系统恢复] 你之前的任务已恢复。以下是任务上下文：`,
            ``,
            `## 项目信息`,
            `- 项目名称：${p?.name || '未知'}`,
            `- 项目描述：${p?.description || '无'}`,
            `- 工作目录：${p?.working_dir || '未设置'}`,
            ``,
            `## 任务信息`,
            `- 任务标题：${t.title}`,
            `- 任务描述：${t.description || '无'}`,
            `- 验收标准：${t.acceptance_criteria || '无'}`,
            failureHint,
            resumeHint,
            progressSummary,
            ``,
            `请基于以上信息和之前对话历史，检查工作目录中已有文件的进度，继续完成未完成的工作，产出物写入工作目录后调用 finalize_task。`,
          ].join('\n');
        } catch { return undefined; }
      })();
      // forceFinalize：所有子任务已完成→强制整合产出并finalize
      // zx_20260916_3 M5（O-F）: 这句此前**没有任何首标**，落库成 `role='user'` 行后在对话流里跟人说的话一模一样
      //   （实测⑥：34 行 `role='user'` 命中里 18 行是它）。经 `markEngineDrafted` 加首标——role 仍是 'user'，
      //   故恢复回放照常送达（改成 system 会被逐字跳过，见 core/turn-authorship.ts 的头注释）。
      const forceFinalizeMsg = markEngineDrafted('你是工蚁系统的AI助手。你的所有子任务已经全部完成，请现在整合所有产出（特别是工作目录中的.md文件），生成最终报告，然后立即调用finalize_task完成任务。不要探索、不要创建新任务、不要搜索——只需要整合已有成果并finalize。');
      // P0-5(c) 注入三规则（①替掉自造块 ②前置不吞真实消息 ③forceFinalize 亦前置）由
      //   `composeResumeInput` 一处实现——回归直跑它，而非在此复刻一份判据。
      const { resumeMsg, finalMsg } = composeResumeInput({
        banner: answerBanner, synthesized, synthBlock, forceFinalize, forceFinalizeMsg,
      });
      // E1 (2026-09-03): 恢复上下文去重——同任务 60s 内已有同款 [系统恢复] 则跳过重复注入
      //（修复 ask_user 恢复与进程续跑并发时把完整任务上下文注入两次、成倍放大后续 token 成本）
      // ⚠ 去重只针对**自造块**：有 `[待回复]` 横幅时首行不再是 `[系统恢复]`，故不参与去重——
      //   这是有意的：横幅是对"这次恢复没在答复问题"的提醒，每次恢复都该在场，不该被 60s 窗口吃掉。
      const isResumeMsg = !forceFinalize && typeof resumeMsg === 'string' && resumeMsg.startsWith('[系统恢复]') && finalMsg === resumeMsg;
      if (isResumeMsg) {
        try {
          const recent = db.prepare(
            "SELECT content, created_at FROM wa_task_conversations WHERE task_id = ? AND content LIKE '[系统恢复]%' ORDER BY id DESC LIMIT 1"
          ).get(taskId) as { content: string; created_at: string } | undefined;
          if (recent && recent.content.startsWith('[系统恢复] 你之前的任务已恢复')) {
            const t = new Date((recent.created_at.includes('Z') ? recent.created_at : recent.created_at + 'Z')).getTime();
            if (!isNaN(t) && Date.now() - t < 60_000) return; // 已注入过，直接进入下一轮处理（由调用方继续）
          }
        } catch { /* 去重失败不阻塞 */ }
      }
      // zx_20260910_1 M4: 不再在此写 finalMsg——executeTask 本就持久化本轮消息（agent-executor 收口处），
      // 此处的重复 INSERT 使同一句回复落库 2 行（叠加 IPC 用户输入边界那行共 3 行，对话流现重复气泡）。
      const result = await executeTask(ctx, taskId, finalMsg);
      // A1 (2026-08-31): resume 后再次偏离 → 再次软重启（偏离提醒已作 user 消息写库）
      if (result.goalDeviationRestart) {
        if (goalRestartExceeded(db, taskId)) {
          db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
            .run(crypto.randomUUID(), taskId, GOAL_DEVIATION_CONVERGENCE_NOTE);
          // zx_20260909_1 M1(A1): 目标偏离收敛需人工介入→通知创建人（`note` 即该告知文案，逐字保留）。
          // zx_20260917 M1（第二只标本的入口）: 这条路此前"因"已算出、写进了 `awaiting_input.question`
          //   与通知正文，却**没有**落 `pause_reason`——账上读不出因，正是本轮要治的失明。现由唯一写入口一并落笔。
          pauseTask(db, { taskId, reason: PAUSE_REASON_GOAL_DEVIATION, note: GOAL_DEVIATION_PAUSE_REASON });
          // zx_20260910_3 M2d-b: 系统侧到顶暂停也写「等待输入」真源——此前只走 IM，GUI 横幅无据可显（同一暂停两处呈现不同真相）。
          // 复用 zx_20260910_1 的唯一真源（不新造字段）；副带收益：该暂停从此有 asked_at，重复提交判重对它同样生效。
          // zx_20260915 P0-5(d): asked_at 取 persistAwaitingInput 的返回值（四点同形，不自造时间戳）
          const devAskedAt = persistAwaitingInput(db, taskId, { question: GOAL_DEVIATION_PAUSE_REASON, options: [], decision_type: 'goal_deviation_pause' });
          eventBus.emit('task.awaiting_input', { taskId, task_id: taskId, projectId, question: GOAL_DEVIATION_PAUSE_REASON, decision_type: 'goal_deviation_pause', options: [], context: {}, asked_at: devAskedAt }).catch(() => {});
          return;
        }
        scheduler.enqueue('resume-ai-task', { taskId, projectId, message: '[系统] 继续执行（检测到目标偏离，已提示回正，请聚焦核心目标）' }).catch(() => {});
        return;
      }
      // A4 (2026-08-31): resume 后备用 provider 也失败（账户级故障）→ executeTask 已置 paused，通知用户后停止，不再重试
      if (result.sdkFatal) {
        const fatalMsg = getSdkFatalMsg(db, taskId);
        const tRow = db.prepare('SELECT title FROM wa_tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
        if (ctx.sendImNotification && tRow) {
          // zx_20260915 P0-4(同源): 同 ai-task 路——文案由 buildTaskNotice 构造（状态词现查 DB）
          ctx.sendImNotification(taskId, projectId, buildTaskNotice(db, taskId, 'paused', { detail: `AI 引擎账户级故障（备用供应商也调用失败）：${fatalMsg || '余额不足或供应商不可用'}。请充值或切换 AI 供应商后恢复任务。` }).message);
        }
        return;
      }
      // zx_20260923 M1: 同 ai-task 路——本次事故重试额度已用尽，executeTask 已置 `paused`；不得再入队。
      if (result.sdkExhausted) return;
      // A3 (2026-08-31): resume 后 SDK 失败 → 非终止，继续重试，重新入队 resume
      // zx_20260922_1 M4（F2 实施中查得的同族读点）：原文案"已降级/切换模型重试"同样超纲——
      // `executeTask` 返回 `sdkFailed:true` 有**两条**来路：切了备用 provider 的那条（已另发消息）、
      // 以及**没切**的那条（`sdk_failed` 首次置位）。后者根本没换模型 ⇒ 同一句文案在一半情形里是空话。
      // 统一改用 `SDK_RETRY_RESUME_MSG`（只说"已自动重试"），两条来路都成立。
      if (result.sdkFailed) {
        scheduler.enqueue('resume-ai-task', { taskId, projectId, message: SDK_RETRY_RESUME_MSG }).catch(() => {});
        return;
      }
      // Phase 1.2: 恢复执行成功后强化（A2 实事求是：仅 status==='completed' 才算成功）
      const taskRow = db.prepare('SELECT project_id, title, status FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string; title: string; status: string } | undefined;
      if (memory && taskRow && taskRow.status === 'completed') {
        try { memory.reinforceMemories(taskId, taskRow.project_id, true); } catch {}
      }
      // zx_20260930 M5: 恢复路同样补失败知识——与上方 `ai-task` 路**同形**（`executeTask` 标 `failed` 后正常返回
      //   的"无产出物"路在恢复途中一样会走到这里）。幂等由 `writeFailureKnowledge` 按任务自持，两条出口无重复之虞。
      if (memory && taskRow && taskRow.status === 'failed') {
        try { writeFailureKnowledge(db, memory, taskId, taskRow.project_id); } catch { /* 断言在 rr，不在生产日志 */ }
        // 同 ai-task 路：恢复途中以「无产出物」收口同样不进 catch ⇒ 注入账结局须在此结清。
        try { memory.backfillInjectionOutcomes(taskId, 'failed'); } catch {}
      }
      // zx_20260930 M5: 子 agent 经验（恢复路）——与上方 `ai-task` 路**同形**，两条终态出口一把尺。
      if (memory && taskRow && isReviewableStatus(taskRow.status)) {
        try { writeSubagentExperience(db, memory, taskId, taskRow.project_id); } catch { /* 断言在 rr，不在生产日志 */ }
      }
      // 降级重试/切备用成功后清除 sdk_failed/sdk_failed_at/sdk_fallback/sdk_fatal（恢复正常模型，避免下次任务仍锁定备用 provider；事故旗同此结清）
      if (taskRow && taskRow.status === 'completed') {
        try {
          const clearCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
          // zx_20260923 M1: 事故的结账走 `closeSdkIncident`（连同 `sdk_failed_at` 一起清，不手抄键名）
          const hadIncident = closeSdkIncident(clearCtx);
          if (hadIncident || clearCtx.sdk_fallback || clearCtx.sdk_fatal) {
            delete clearCtx.sdk_fallback;
            delete clearCtx.sdk_fatal;
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(clearCtx), taskId);
          }
        } catch {}
      }
      // B2/C1 (2026-08-31): 识别偏差检测 + 纠错记忆（resume 完成后同样检测，与 ai-task 处理器一致）
      if (memory && taskRow && taskRow.status === 'completed') {
        try {
          const deviation = detectArchetypeDeviation(db, taskId);
          if (deviation) {
            const content = `任务「${taskRow.title}」识别为 ${deviation.from} 但实际应 ${deviation.to}，依据：${deviation.evidence}`;
            // zx_20260929 M4: 同源替换优先（与上方 ai-task 路**同形**，两条完成出口一把尺）。
            if (!memory.sameSourceReplace(taskRow.project_id, 'archetype_deviation', content)) {
              memory.storeText({ project_id: taskRow.project_id, task_id: taskId, type: 'archetype_correction', content, source: 'archetype_deviation' });
            }
          }
        } catch {}
      }
      // F2: 恢复完成 IM 通知
      if (ctx.sendImNotification && taskRow?.status === 'completed') {
        const smartContent = buildCompletionNotice(taskId, result.content);
        ctx.sendImNotification(taskId, taskRow.project_id, buildTaskNotice(db, taskId, 'completed', { detail: smartContent }).message);
      }
      // zx_20260924 M5: 恢复路的完成同样推件（与 `ai-task` 路同形，两条完成出口一把尺）。
      if (ctx.sendImPrimaryDeliverables && taskRow?.status === 'completed') {
        try { ctx.sendImPrimaryDeliverables(taskId, taskRow.project_id); } catch { /* 推件失败不阻断收尾 */ }
      }
      // 后台记忆提取（zx_20260906 批2 终核补强: 与上方各步一致，仅**终态**才整批提；暂停/部分/未落盘走轻量沉淀，防整批重复读同一对话）
      // zx_20260930 M5: 守卫与 `ai-task` 路**同形**（含 `failed`）——两条出口一把尺，判据取自 `task-terminal.ts` 一处。
      if (taskRow && isReviewableStatus(taskRow.status)) { try { scheduler.enqueue('background-review', { taskId, projectId: taskRow.project_id }).catch(() => {}); } catch {} }
      // D1: 子任务完成后自动检查父任务
      try { checkParentTaskAfterChildDone(db, taskId, { enqueue: d1Enqueue }); } catch {}
      // zx_20261023_5 批一：恢复路完成同样放行依赖它的后继（两条完成出口一把尺）。
      try { scheduleDependentDispatch(db, taskId); } catch { /* 同上 */ }
    } catch (err) {
      console.error(`[resume-ai-task] 恢复失败: ${taskId.slice(0, 8)}`, (err as Error).message);
      // zx_20260915 P0-3(b): 与 ai-task 路**同一处**落账（实测 02adce34 走的正是本路）——
      // 此前本路只发 IM、不落库，于是"IM 报失败、账上没有 failed"。
      const failedRow = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
      recordExecutionFailure(db, taskId, failedRow?.project_id || projectId || '', err, { afterRecord: (tid) => checkParentTaskAfterChildDone(db, tid, { enqueue: d1Enqueue }), memory });
      // zx_20260930 M5: 恢复路的异常失败同样落子 agent 经验（与上方两条失败路同形）。
      try { writeSubagentExperience(db, memory, taskId, failedRow?.project_id || projectId || ''); } catch { /* 断言在 rr，不在生产日志 */ }
      if (memory) {
        try {
          const task = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
          if (task) memory.reinforceMemories(taskId, task.project_id, false);
        } catch {}
      }
    }
  });
}
