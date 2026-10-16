/**
 * run_close 收口段 —— 从 `agent-executor.ts` 的 `executeTask` 拆出（zx_20260921 M8，**只动形不动义**）。
 *
 * 是什么：任务跑完主循环、两道产出闸（产出未落盘 / 内容不充分）都过了之后，**决定终态**的那一段——
 *   ① 收口三闸（有失败子未处置 / 仍有未完成子 / 无真实产出证据 / 验收已核验未通过 ⇒ 不标完成，置 paused 并如实告知）；
 *   ② 达标收尾（标 completed → 探针处置 → 完成事件 → 成果提升 → 策略闭环记账）。
 *
 * 为什么单独成模块：整段只**读**外层局部量、只**写**库，无一处就地改写跨段累加量；
 *   入参 = 收口时刻的那批账目量，出参 = `executeTask` 的最终返回 `{ content, steps }`。边界干净。
 *
 * ⚠ 运行时 import 回 `agent-executor.js`（`blockFailedChildrenCompletion` / `blockNoOutputCompletion` /
 *   `realOutputEvidence` / `logger`）——真源**仍在执行体一处**，未复制第二份；这些绑定只在函数体内读，
 *   不在模块顶层求值 ⇒ ESM 循环引用不触发 TDZ（与 `exec-claim` / `exec-budget` / `exec-context` 同形）。
 *
 * ⚠ 与 finalize 路（`finalize_task` 工具内那段）**同判据、同处置**，但**不能合并**：本路执行体不在场，
 *   没有 `probe_disposition:'keep'` 那个逐次逃生口——开关是唯一杠杆（下方注释里有如实登记）。
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { eventBus } from './event-bus.js';
import { pauseTask } from './pause-task.js';
import { PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_ACCEPTANCE_UNJUDGED, PAUSE_REASON_CHILDREN_INCOMPLETE } from './pause-reason.js';
import { readBoolSetting } from './settings-bool.js';
import { promoteTaskFileDeliverables, selectProbeDeliverables, disposeProbeDeliverables } from './deliverable-lifecycle.js';
import { unfinishedChildren } from './children-gate.js';
import { buildTaskOutcome } from './task-outcome.js';
import { adjustProjectStrategy, recordStrategyOutcome, type ExecutionMetrics } from './feedback-engine.js';
import { createLogger } from './logger.js';
import type { AdaptiveStrategy, TaskArchetype } from './task-archetype.js';
import { UNVERIFIED_REASON_LABEL } from './acceptance-check.js';
import type { AcceptanceSummary, AcceptanceUnverifiedReason, AcceptanceVerdict } from './acceptance-check.js';
import {
  blockFailedChildrenCompletion, blockNoOutputCompletion, realOutputEvidence,
} from './agent-executor.js';
import type { AgentContext } from './agent-executor.js';

const logger = createLogger('exec-finalize');

/** `executeTask` 的最终返回（本段是它的最后一段 ⇒ 直接产出它，不再回传中间量）。 */
export interface RunCloseFinalizeResult {
  content: string;
  steps: number;
}

/**
 * 收口：决定这个任务**标 completed 还是停**，并在标完成的同时走完达标收尾的全部动作。
 *
 * 三个早退口都返回 `executeTask` 该给调用方的 `{ content, steps }`——形状与搬迁前逐字一致
 * （搬迁前它们就是 `executeTask` 里的 `return { content: '…', steps: stepCount }`）。
 */
export function finalizeRunClose(o: {
  db: Database.Database;
  ctx: AgentContext;
  taskId: string;
  projectId: string;
  archetype: TaskArchetype;
  adaptiveStrategy: AdaptiveStrategy;
  /** 本 run 的写类工具命中次数——「无产出证据」闸的豁免判据之一（`runMutations`）。 */
  fileMutationCount: number;
  finalContent: string;
  stepCount: number;
  qualityScore: { score: number; feedback: string };
  closeVerdict: AcceptanceVerdict;
  closeTotal: number;
  closeFailedN: number;
  closeAcceptance: AcceptanceSummary | undefined;
  title: string;
  modelName: string;
  maxSteps: number;
  totalTokensUsed: number;
  toolCallCount: number;
  rawCost: number;
}): RunCloseFinalizeResult {
  const {
    db, ctx, taskId, projectId, archetype, adaptiveStrategy, fileMutationCount, finalContent,
    stepCount, qualityScore, closeVerdict, closeTotal, closeFailedN, closeAcceptance,
    title, modelName, maxSteps, totalTokensUsed, toolCallCount, rawCost,
  } = o;
  // zx_20260913 M3-6(名实相符 / 同一把尺): run_close 达标收尾此前**直标 completed**——哪怕子任务还在跑/未跑，
  // 父任务也会"先完成"，里程碑达成与成果汇总随之失真。现与 finalize_task 同尺查未完成子任务；
  // 有则置 paused 并如实记账，等既有 checkParentTaskAfterChildDone 在子任务完成后自动恢复（不新增机制）。
  // zx_20260915 P0-3(c): 同 finalize 收口闸——失败子先判（判据在 children-gate.ts，动作在 blockFailedChildrenCompletion）
  if (blockFailedChildrenCompletion(db, taskId)) return { content: '任务暂停：有失败子任务未处置', steps: stepCount };
  // zx_20261013_2 批二: 谓词收归 `children-gate.ts` 一处真源（`unfinishedChildren`）——与 `exec-close.ts` 的
  //   `prematureEnd` 闸同尺。此前此处内联 SQL、彼处各判一遍，"闸说没 pending、判卷说有过早"即从缝里来。
  const unfinishedAtClose = unfinishedChildren(db, taskId);
  if (unfinishedAtClose.length > 0) {
    const pendingNames = unfinishedAtClose.map(c => c.title).join('; ');
    // zx_20260914 M0.5-3: 同 finalize 收口闸——该暂停此前静默，与其余 6 个暂停点不同尺（见上）。
    pauseTask(db, { taskId, reason: PAUSE_REASON_CHILDREN_INCOMPLETE, note: `仍有 ${unfinishedAtClose.length} 个子任务未完成（${pendingNames}）——非故障，待其完成后自动恢复` });
    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
      .run(crypto.randomUUID(), taskId, `[未收口] 仍有 ${unfinishedAtClose.length} 个子任务未完成（${pendingNames}）——已暂停而非标完成；待子任务完成后自动恢复，或人工处置。`);
    logger.warn({ taskId: taskId.slice(0, 8), unfinished: unfinishedAtClose.length }, 'run_close 前有未完成子任务，改置 paused 不标完成');
    return { content: '任务暂停：仍有未完成子任务', steps: stepCount };
  }
  // zx_20260915 P0-1（完成闸·无产出不冒充完成）：质量自评早已把"无产出"压到 45 分（<60），
  // 此处此前却径直标 completed——真库 43 条 completed 任务 realOutputEvidence=false。
  // 判据（豁免/开关/副作用）全在 blockNoOutputCompletion 内，与 finalize 收口同尺。
  if (blockNoOutputCompletion(db, taskId, { archetype, runMutations: fileMutationCount })) {
    return { content: '任务暂停：未发现真实产出证据', steps: stepCount };
  }
  // zx_20260915 P0-2(b)（同一把尺·两个出口同一笔账）: run_close 此前**从不跑验收**——只有 finalize 路跑，
  //   于是"走 finalize 收口的任务"与"走 run_close 收口的任务"在验收账上不同尺：真库 66 个已完成 doc 仅 7 个已验收。
  //   （补跑那一段已由 zx_20260916_3 M4 **前移**到上面"验收前移 + 完成分重算"处——位置理由见该段注释。）
  // zx_20260916 M1（A1 ①②③ / 维特根斯坦「意义即用法」）: 验收**已核验且未通过** ⇒ 终态不得取 `completed`。
  //   本路此前"只记账不阻断"（P0-2(b) 的显式设计），于是**把关最弱的恰恰是最需要把关的收口方式**
  //   （步数/预算撞顶后的常规出口）——真库标本即走此路：账上 8 条未达、终态 completed（§1.1）。
  //   改动不是新增拦点，而是把 D1「未达交付·过早结束」那道闸**多接一条入口**（同一形态：
  //   压分 + paused + markPauseNeeded + 一条如实话术）。`not_checked` 一律放行（A4）。
  //   ⚠ 位置受既定约束：验收必须在 `promoteTaskFileDeliverables` **之前**跑（promote 读的正是这份账）；
  //     本分支置于其后、标完成之前，故该约束不变。
  // zx_20260916_3 M4: 本分支**不再压分、不再写第二版账**——压降已在上面"重算"那一步由
  //   `assessCompletionQuality` 的第 4 条压降**读新鲜账**时落下，账与顶层也已同值落笔。此处只负责
  //   "置暂停 + 如实告知"。同一约束写两处＝两本账（本轮 O-H 的同形），且重复压分会掩盖"账是新鲜的"这一事实。
  if (closeVerdict === 'failed') {
    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
      .run(crypto.randomUUID(), taskId, `[未达交付·验收未通过] 验收 ${closeTotal} 条判据中 ${closeFailedN} 条未达成，完成分 ${qualityScore.score} 分(<60)（读的是刚落账的新鲜验收账），任务未标完成，已暂停待人工：请核验产出（测试/提交/内容）后"恢复继续"或"标记完成"。`);
    // zx_20260917 M1（**本轮主要目标**之一）: 此处此前复用"未达交付"语义却**不写因**——账上
    //   `pause_reason` 为空，人与调度器都读不出"是判卷没过"还是"等子任务"。现落 `acceptance_failed`：
    //   与 `no_output`（根本没东西可交）的区别正在此——它是"交了但判卷说不达标"，
    //   故 `isChildrenIncompletePause` 对它返回 false（后继继续被拦，不当作可自愈的时序暂停）。
    pauseTask(db, { taskId, reason: PAUSE_REASON_ACCEPTANCE_FAILED, note: `验收 ${closeFailedN} 条未达成（共 ${closeTotal} 条判据），未达交付标准，已置暂停待人工` });
    logger.warn({ taskId: taskId.slice(0, 8), failed: closeFailedN, total: closeTotal, score: qualityScore.score }, 'run_close 验收未通过，任务暂停而非标完成');
    return { content: finalContent, steps: stepCount };
  }
  // zx_20260923_1 M2（维特根斯坦「意义即用法」/ 道德经·七十一章「知不知，上」）:
  //   **有判据、本轮却没判成**（无可用模型 / 模型没吐可解析结论 / 核对异常）⇒ **同样不得标完成**。
  //   与上面 `failed` 的区别：那边是"判了，判卷说不达标"；这边是"**题在，没判成**"。
  //   与 `not_checked` 的区别：那是"没有题目"（无人许诺判据）——A4 明文规定不阻断，**故不落此分支**。
  //   不压分是刻意的（`capScoreByAcceptanceVerdict` 只对 `failed` 动作，逐字未动）：
  //   「没判成」不是「没达成」；但「没判成」同样不是「判过了」，故终态必须停——
  //   真库标本 `a290ae2b` 正是在此处被放行标 completed（§1.1：题在 348 字、账上 `error`、90 分完成）。
  //   ⚠ 位置受同一条既定约束：本分支不写第二笔账、不再压分（同 zx_20260916_3 M4 对本函数的约束）。
  //   ⚠ 也不得排在 `promoteTaskFileDeliverables` 之后——停在 paused 就不该提升成果（本 return 天然早于它）。
  if (closeVerdict === 'unjudged') {
    const unjudgedWhy = UNVERIFIED_REASON_LABEL[closeAcceptance?.reason as AcceptanceUnverifiedReason] || '原因未记录';
    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
      .run(crypto.randomUUID(), taskId, `[未达交付·验收未判成] 本任务有验收判据，但本轮未取得核对结论（${unjudgedWhy}），完成分 ${qualityScore.score} 分（**未压分**——「没判成」不是「没达成」）。任务未标完成，已暂停待人工：请核验产出后"恢复继续"（模型恢复即会重新判卷）或"标记完成"。`);
    pauseTask(db, { taskId, reason: PAUSE_REASON_ACCEPTANCE_UNJUDGED, note: `有验收判据但本轮未取得核对结论（${unjudgedWhy}），未标完成` });
    logger.warn({ taskId: taskId.slice(0, 8), reason: closeAcceptance?.reason, score: qualityScore.score }, 'run_close 验收未判成，任务暂停而非标完成');
    return { content: finalContent, steps: stepCount };
  }
  db.prepare("UPDATE wa_tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(taskId);
  // zx_20260916_3 M2（O-E · 同一把尺·两个出口同一处置 / 毛选「抓而不紧等于不抓」）: 探针处置此前**只在 finalize 工具内**
  //   （见 `finalize_task` 内 :1466 那段），走 run_close 收口的任务**完全没有**处置——同一批产出物因"走哪条收口路"
  //   而命运不同：finalize 收口的会把文件移走，run_close 收口的原样留在用户工作树里。这正是 zx_20260915 P0-2(b)
  //   「两个出口同一笔账」修过的那类病，**在探针处置上原样复发**。
  //   此处与 finalize **同判据**（`selectProbeDeliverables` = `docNotProbe` 一把尺，不在本路复刻第二份正则）、
  //   **同处置**（移入 `quarantine/<taskId>/` 并回写 `file_path`，**绝不删**）。开关同 finalize：`deliverable.probe_disposition`。
  // ⚠ 必须排在 `promoteTaskFileDeliverables` **之前**：否则探针 doc 先被提升 `completed`、再被退休（顺序是前提，非天然咬合）。
  // ⚠ 与 finalize 的**唯一**差异（如实登记）：本路执行体不在场，故没有 `probe_disposition:'keep'` 这个逐次逃生口，
  //   开关是唯一杠杆；`keep` 只可能来自 finalize 路。
  try {
    if (readBoolSetting(db, 'deliverable.probe_disposition')) {
      const closeProbes = selectProbeDeliverables(db, taskId);
      if (closeProbes.length > 0) {
        const closeProbeNames = closeProbes.map((r) => (r.file_path || '').split(/[\\/]/).pop() || '').filter(Boolean);
        const closeProbeShown = closeProbeNames.slice(0, 5).join('、');
        const closeMore = closeProbeNames.length > 5 ? `等 ${closeProbeNames.length} 个` : '';
        const closeQuarantineDir = path.join(ctx.dataDir, 'quarantine', taskId);
        const { retired: closeRetired, moved: closeMoved, alreadyGone: closeGone, failed: closeFailed } = disposeProbeDeliverables(db, closeProbes, 'retire', closeQuarantineDir);
        // 告知走**会话记录**：finalize 的 `checks.push` 落 `ctxJson.finalize_checks`（详情页可见），
        //   本路没有自检字符串；而**移走的是用户工作树里的文件**，更不能静默（B5：须含"移去哪"）。
        const closeGoneLine = closeGone > 0 ? `（另 ${closeGone} 个源文件已不在，未动，亦不谎报已隔离）` : '';
        const closeFailedLine = closeFailed.length > 0 ? `隔离失败 ${closeFailed.length} 个（${closeFailed.map((f) => `${f.name}: ${f.reason}`).join('；')}）——文件仍在原处，登记已退休。` : '';
        db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
          .run(crypto.randomUUID(), taskId, `[临时产出物处置] 已退休 ${closeRetired} 个临时产出物（${closeProbeShown}${closeMore}），其中 ${closeMoved} 个文件已移入隔离目录 ${closeQuarantineDir}${closeGoneLine}。${closeFailedLine}判据为显式前缀 _tmp/_probe/_verify——未按这三个前缀命名的文件一律视为真实产出、不动。`);
      }
    }
  } catch { /* 处置 best-effort，不阻断收口 */ }
  // zx_20260915 P0-2(d): 完成事件带上验收三态之一（无标准/未通过/已验证）——此前事件里**完全没有**验收，
  //   下游只能各自去猜（或干脆不猜）。`criteria_total/passed_total` 取自落库载荷，不另算一份。
  eventBus.emit('task.completed', { taskId, task_id: taskId, projectId, ...buildTaskOutcome(db, taskId, fileMutationCount), acceptance: closeAcceptance ?? undefined }).catch(() => {});
  // zx_20260906 批1: 成果随任务交付——达标收尾把本任务 doc 草稿产出物推进 completed（未达标 forced 场景内部跳过）
  promoteTaskFileDeliverables(db, taskId, 'run_close');
  console.log(`[Agent] 任务完成: ${title.slice(0, 50)} steps=${stepCount} quality=${qualityScore.score}分`);

  // 道法自然：记录策略表现 + 调整项目策略（闭环反馈）
  try {
    const hasDeliverable = realOutputEvidence(db, taskId);
    const metrics: ExecutionMetrics = {
      taskId, projectId, archetype,
      stepsUsed: stepCount, maxSteps,
      toolCalls: toolCallCount,
      totalTokens: totalTokensUsed,
      estimatedCost: Math.round(rawCost * 1_000_000) / 1_000_000,
      hasDeliverable,
      // zx_20261016_3 M32: 质量分入闸——本 run 已算好的完成分（`assessCompletionQuality`）。缺它则
      //   "刚过线完成"与"高分完成"在闭环里无从分辨（`adjustProjectStrategy` 与 `naturalStrategySelection` 都读它）。
      qualityScore: qualityScore.score,
      status: 'completed',
      modelName,
      strategy: { modelStrategy: adaptiveStrategy.modelStrategy, temperature: adaptiveStrategy.temperature, maxSteps },
    };
    recordStrategyOutcome(db, projectId, metrics);
    adjustProjectStrategy(db, projectId, metrics);
    // zx_20260906_1 2d: 下线 observeBehavior/learnWorkflowPatterns 死写（behavior_pattern/workflow_pattern 无任何读；observed 阈值层本应由此产出却断链）——
    // 阈值自校准由 calibrateProjectThresholds(learned_thresholds) 真实生效覆盖
  } catch {}

  return { content: finalContent, steps: stepCount };
}
