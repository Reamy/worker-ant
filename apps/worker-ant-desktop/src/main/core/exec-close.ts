/**
 * run_close **收尾段** —— 从 `agent-executor.ts` 的 `executeTask` 拆出（zx_20260929 M9，**只动形不动义**）。
 *
 * 是什么：两道产出闸（产出未落盘 / 内容不充分）之后、`finalizeRunClose` 之前的**判卷与评分段**——
 *   ① 内容充分性门禁（跑 `validateOutput`，结论落 `ctxJson.output_validations`；不充分 ⇒ 补全一轮或暂停待人工）；
 *   ② 省耗账实 reconcile（旁路 LLM 的 token 并回 `cost_estimate` / `execution_metrics`）；
 *   ③ 收口验收**前移** + 完成分**重算**（读新鲜账，不读上一轮的旧账）；
 *   ④ D1「过早结束」闸（预算/步数撞顶且质量 <60 ⇒ 置 paused，不冒充完成）；
 *   ⑤ 陈旧标记清理（`deliverable_unfulfilled` / `deliverable_missing_retries`）。
 *
 * 为什么单独成模块：整段的工作变量**全部自带**（`gateTargets`/`contentUnfulfilled`/`closeVerdict`/… 都在段内声明），
 *   对外的**唯一可变通道是 `ctxJson`**（按引用传入，段内就地改写并回写库）；`qualityScore` 在段内**先重算后使用**，
 *   故不必作入参。边界干净：只读外层 17 个值，出参就是 `executeTask` 该给调用方的 `{ content, steps }`。
 *
 * ⚠ 运行时 import 回 `./agent-executor.js`（`docValidationTargets` / `cachedOutputValidation` / `archetypeForFile` /
 *   `fileSig` / `assessCompletionQuality` / `addSideTokens` / `formatInsufficiencyReasons` 等）——真源**仍在执行体一处**，
 *   未复制第二份；这些绑定只在函数体内读，不在模块顶层求值 ⇒ ESM 循环引用不触发 TDZ（与 `exec-claim` /
 *   `exec-budget` / `exec-context` / `exec-finalize` 同形）。
 *
 * ⚠ 顺序纪律（搬迁前逐字一致，不得调整）：
 *   · 本段**不得**提到两道产出闸之前（那两道一旦命中，本 run 根本不收口，提前判卷既白付一次验收 LLM、
 *     又把"尚未成形的产出"记成账）；
 *   · 本段**不得**提到 `finalizeRunClose` 之后（它就是本段末尾的终点）。
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { eventBus } from './event-bus.js';
import { pauseTask } from './pause-task.js';
import { PAUSE_REASON_OUTPUT_INSUFFICIENT, PAUSE_REASON_QUALITY_BELOW_BAR } from './pause-reason.js';
import { enqueueJob } from './job-enqueuer.js';
import { readBoolSetting } from './settings-bool.js';
import { markGoalNotAchieved, goalAchievedOf, buildCompletionAccount, syncGoalAchievedFromAccount } from './task-outcome.js';
import { readTaskAcceptanceCriteria, acceptanceVerdictOf, toAcceptanceSummary, recordAcceptanceOutcome, type AcceptanceSummary, type AcceptanceVerdict } from './acceptance-check.js';
import { readAcceptanceCheck } from './deliverable-lifecycle.js';
import { budgetCapReached, stepCapContinuationOf, buildStepContinuationNote } from './step-budget.js';
import { childrenPendingAttention } from './children-gate.js';
import { createLogger } from './logger.js';
import { finalizeRunClose } from './exec-finalize.js';
// zx_20261018_1 批七：旁路 token 并账也收进唯一写口，不再在收尾段手改两处 JSON。
import { reconcileExecutionTokens } from './exec-metrics.js';
import type { AdaptiveStrategy, TaskArchetype } from './task-archetype.js';
import type { AgentContext } from './agent-executor.js';
import {
  docValidationTargets, cachedOutputValidation, fileSig, archetypeForFile,
  assessCompletionQuality, syncQualityColumn, addSideTokens, formatInsufficiencyReasons,
  checkAcceptanceCriteria,
} from './agent-executor.js';

const logger = createLogger('exec-close');

/**
 * 收尾段：判卷 + 评分 + 收口。返回的就是 `executeTask` 本该返回的 `{ content, steps }`
 * （三个早退口——内容不充分补全失败 / 内容不充分暂停 / D1 过早结束——与达标收尾同在本函数内）。
 */
export async function runCloseSection(o: {
  db: Database.Database;
  ctx: AgentContext;
  taskId: string;
  projectId: string;
  workingDir: string;
  archetype: TaskArchetype;
  adaptiveStrategy: AdaptiveStrategy;
  title: string;
  modelName: string;
  maxSteps: number;
  maxTokens: number;
  stepCount: number;
  totalTokensUsed: number;
  toolCallCount: number;
  fileMutationCount: number;
  finalContent: string;
  /** 本 run 的 provider 原币种费用（调用方在收尾前已算好，`finalizeRunClose` 要用）。 */
  rawCost: number;
  /** 首次并账时的旁路 token 水位——本段 reconcile 的基准（`ctx.sideTokens` 超出它才并账）。 */
  sideAtFirstPersist: number;
  /** `ctxJson.task_goal.goal` 是否在场（有显式目标时达成判据才看偏离）。 */
  goalDefined: boolean;
  /** 收尾时刻的整份 context（**按引用**：本段就地改写并回写库，调用方此后不再读它）。 */
  ctxJson: Record<string, unknown>;
}): Promise<{ content: string; steps: number }> {
  const {
    db, ctx, taskId, projectId, workingDir, archetype, adaptiveStrategy,
    title, modelName, maxSteps, maxTokens,
    stepCount, totalTokensUsed, toolCallCount, fileMutationCount, finalContent, rawCost,
    sideAtFirstPersist, goalDefined, ctxJson,
  } = o;

  // zx_20260904_3 批4 (2026-09-04): 内容充分性门禁——目标集(声明产出∪注册文档交付物)已落盘但校验不充分 → 不得标 completed
  //（产出物"存在"不等于"充分"；status==='unknown'(LLM不可用)不判不充分，仅记录，避免误卡）
  const gateTargets = docValidationTargets(db, taskId, workingDir);
  let contentUnfulfilled: string[] = [];
  const contentReasons: Array<{ file: string; reasons: string[] }> = [];
  if (gateTargets.length > 0) {
    try {
      const { validateOutputs, canReuseOutputValidation, VALIDATION_CRITERIA_VERSION } = await import('./output-validator.js');
      // 两条来路（缓存命中 / 本轮实判）落**同一个判据版本**——此处只读一次，两处写点共用（M3-C 钉形状）。
      const criteriaVersion = VALIDATION_CRITERIA_VERSION;
      const ansClient = await ctx.getAnsClient();
      // zx_20261028_2 M3：命中缓存的照旧逐条复用；**未命中的一次性有界并发问完**（原为逐个 `await`，
      //   单文件超时即整段串起来等）。`ov` 按目标原序落位，下游 `output_validations` 顺序不变。
      const ov: Array<Record<string, unknown>> = new Array(gateTargets.length);
      let reused = 0;
      const missAt: number[] = [];
      const missTargets: Array<{ file: string; archetype: string }> = [];
      gateTargets.forEach((abs, i) => {
        const sig = fileSig(abs);
        // zx_20260911_1 M1: 判型归位——按**产物本身**决定规则（原用任务原型，研究/文档类任务下 .py 被文档规则量）
        const arch = archetypeForFile(abs);
        // zx_20260906 批2: 若本 run 内该文件已被 finalize 门校验且内容未变 → 复用结论，不重复付校验 LLM
        // zx_20260911_1 M1: 复用还须**原型一致**——历史缓存里 .py 记的是 archetype:'document'，与当前判型不符则
        // 不复用、自动重判并落新结论（否则旧误判会被永久复用，自愈不了）。
        const hit = cachedOutputValidation(ctxJson, abs);
        // zx_20260923 M3（G8）：守卫从"签名 + 判型"扩为"签名 + 判型 + **判据版本**"——
        //   判据改了（如 M7 把问句从"任务+文件"改对成"只问文件"）而文件没动时，旧结论**不再被复用**。
        //   判据只此一处（`canReuseOutputValidation`），不在此手抄一遍四条与。
        if (canReuseOutputValidation(hit, arch)) {
          ov[i] = {
            file: abs, archetype: arch,
            status: String(hit.entry.status),
            sufficient: hit.entry.sufficient as boolean | undefined,
            confidence: hit.entry.confidence as number | undefined,
            issues: Array.isArray(hit.entry.issues) ? hit.entry.issues as string[] : [],
            missingAspects: Array.isArray(hit.entry.missingAspects) ? hit.entry.missingAspects as string[] : [],
            suggestion: String(hit.entry.suggestion ?? ''),
            reason: hit.entry.reason as string | undefined,
            size: sig?.size ?? null, mtimeMs: sig?.mtimeMs ?? null,
            criteriaVersion,
          };
          reused += 1;
        } else {
          // zx_20260922_1 M7（F9）：此处原先传 `${title} ${description}`（**任务题面**）当第三参 ⇒
          // 门禁问的是任务、答出来的记在**文件名**头上（`pom.xml` 被判"缺少 git 提交署名"）。
          // 该参数已从 `validateOutput` 整体删除：量文件，就问文件。
          missAt.push(i);
          missTargets.push({ file: abs, archetype: arch });
        }
      });
      const results = await validateOutputs(ansClient as never, missTargets);
      results.forEach((r, k) => {
        // 省耗账实(1a): 收口内容校验(未命中缓存)为旁路子 LLM——usage 记入执行期账本（逐条累加）
        addSideTokens(ctx, r.usage);
        const sig = fileSig(r.file);
        // zx_20260911_1 M2: 快检诊断(issues) 一并落库——此前唯一有用的判据被算出来却丢弃，拒收文案成了空话
        ov[missAt[k]!] = { file: r.file, archetype: r.archetype, status: r.status, sufficient: r.sufficient, confidence: r.confidence, issues: r.quickCheck?.issues ?? [], missingAspects: r.llmCheck?.missingAspects ?? [], suggestion: r.llmCheck?.suggestion ?? '', reason: r.reason, criteriaVersion, size: sig?.size ?? null, mtimeMs: sig?.mtimeMs ?? null };
      });
      for (const e of ov) {
        if (e.status !== 'insufficient') continue;
        const abs = String(e.file);
        const issues = Array.isArray(e.issues) ? e.issues as string[] : [];
        const missingAspects = Array.isArray(e.missingAspects) ? e.missingAspects as string[] : [];
        const suggestion = String(e.suggestion ?? '');
        contentUnfulfilled.push(abs);
        contentReasons.push({ file: abs, reasons: issues.length > 0 ? issues : (missingAspects.length > 0 ? missingAspects : [suggestion].filter(Boolean)) });
      }
      ctxJson.output_validations = ov;
      if (reused > 0) ctxJson.output_validations_reused = reused;
    } catch { /* 校验失败不阻塞（回退到存在性门禁） */ }
  }
  // zx_20260916_3 M4（O-D · 同病根的第二处落点）：本 run 刚算出的充分性校验结论，此前**只在"有不充分"时**
  //   才落库（写在下面那个分支里）。而收口验收的取证恰恰**只从库里读**这份 `output_validations`
  //   （见 `checkAcceptanceCriteria` 的 `[内容校验]` 段）——于是"全部充分"这条最正常的路上，验收 LLM
  //   读到的是**上一轮的结论**（或压根没有），正是本轮「判据读旧账」的形状。
  //   ⇒ 无论充分与否都落库（不充分时下面那个分支再写一次，同值，幂等）。
  //   ⚠ 此处 `ctxJson` 就是上文那次 UPDATE 落下的那一份（中间无其它整份写者），故整份回写不覆盖任何字段；
  //     随后刚落/将落的 `acceptance_check` 由 `persistAcceptanceCheck` 自己做读改写，不受此影响。
  if (gateTargets.length > 0 && Array.isArray(ctxJson.output_validations)) {
    try { db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), taskId); } catch { /* best-effort */ }
  }
  if (contentUnfulfilled.length > 0) {
    const retries = Number(ctxJson.deliverable_missing_retries) || 0;
    ctxJson.deliverable_missing_retries = retries + 1;
    // 刻意不把 contentReasons 落进本字段：另两处生产者同形只带 paths/note/retries，
    // 且具体原因已由 output_validations[].issues 与下面的会话消息承载——再存一份无人读的重复即「做了没用上」。
    ctxJson.deliverable_unfulfilled = { paths: contentUnfulfilled, note: '产出内容不充分(充分性校验)', retries: retries + 1 };
    // zx_20260916_3 M3（判据 C3）: 同上一道门禁——账与顶层同置（本路在完成账之后跑，理由见上）。
    markGoalNotAchieved(ctxJson);
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), taskId);
    // zx_20260923 M6-c（G16）：同上一道闸——原话"请人工复核产出内容"指不出按钮，出路只存在于库外。
    const guidance = retries >= 1
      ? '已多次校验仍未达标，本任务保持未完成（不标完成）。在任务管理点「恢复（保留对话）」即重新获得一次自动补跑额度；用「回复」可附一句说明要补什么；若确认现有内容已足够，可用「完成」人工收口（会如实标注未经成果门禁）。'
      : '请按上述原因补全产出内容后再结束任务。';
    const msg = `[产出内容不充分] 声明产出文件已生成但充分性校验未通过：${contentUnfulfilled.join('、')}。${formatInsufficiencyReasons(contentReasons)}${guidance}`;
    // zx_20260911_1 M2（知行合一）: 角色由 'system' 改 'user'——恢复回放时逐字跳过 system 行，
    // 通知送不到执行体（反馈不可达）。与 A1 偏离提醒同法同源。保留 [产出内容不充分] 前缀供人机双方识别。
    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))").run(crypto.randomUUID(), taskId, msg);
    if (retries < 1) {
      db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(taskId);
      enqueueJob(db, 'resume-ai-task', { taskId, projectId, message: msg });
      eventBus.emit('task.status_changed', { taskId, task_id: taskId, projectId, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
      logger.warn({ taskId: taskId.slice(0, 8), insufficient: contentUnfulfilled }, '声明产出内容不充分，自动恢复一轮补全');
    } else {
      // zx_20260909_1 M1(A1): 内容多次不充分需人工复核→通知创建人（zx_20260917 M1：同经 `pauseTask` 一次写全）
      pauseTask(db, { taskId, reason: PAUSE_REASON_OUTPUT_INSUFFICIENT, note: `产出内容多次未通过充分性校验：${contentUnfulfilled.join('、')}` });
      logger.warn({ taskId: taskId.slice(0, 8), insufficient: contentUnfulfilled }, '声明产出多次内容不充分，保持暂停待人工介入');
    }
    // zx_20260920_1 M3（面二 · 判据 C6）: 本 run 在验收判定**之前**就 return 了（下面的验收前移段在后面），
    //   于是账上留着的很可能是**上一轮**的判卷——真库标本 `9788ce4f` 把 09-17 的「0/5 未通过」挂在一个
    //   两天后才完成的任务上。此处**刻意不提前判卷**：对一份刚被判"要重做"的产出判卷，既白付一次验收 LLM、
    //   又把"尚未成形"记成账（方案 §6.1「前移不越过两道产出闸」，自破不得）。
    //   ⇒ 只落一笔**新鲜的 `not_checked` 账**：账上不许留别轮的结论。成因码 `output_insufficient` 是新码——
    //     既有五码（no_model/no_json/error/no_criteria/no_user_criteria）无一为真。
    try {
      recordAcceptanceOutcome(db, taskId, { outcome: { ran: false, reason: 'output_insufficient' }, checks: [] });
    } catch { /* 记账失败不阻断门禁处置 */ }
    return { content: finalContent, steps: stepCount };
  }

  // 省耗账实(1a): 收口内容门(未命中缓存)也可能付旁路 LLM——此处在首次并账后补充 reconcile，把新增旁路并入 cost_estimate/execution_metrics（防历史均值仍低估）
  try {
    reconcileExecutionTokens(db, taskId, {
      fallbackTotal: totalTokensUsed,
      sideNow: ctx.sideTokens || 0,
      sideAtFirstPersist,
    });
  } catch { /* 并账 reconcile best-effort */ }

  // ═══ zx_20260916_3 M4（O-D「判据要认得事物此刻的样子」）：收口验收前移 + 完成分重算 ═══
  // 病根（§1.2-④）：本函数在上面先按**库里的旧账**评分（`assessCompletionQuality` 的第 4 条压降读
  //   `readAcceptanceCheck`），验收却排到全部门禁之后才重跑 ⇒ 评分读的是"上一轮那件事的样子"。
  //   真库 3b6e2263：`score:45` +「验收未通过，评分压降<60」与 `acceptance_check` 3/3 全过同处一份
  //   `context_json`，终态却是 `completed`——一份账里两句话互相打脸。
  // 处置（两条，缺一不可）：
  //   ① **前移**：验收在**任何依赖完成分的闸门**之前跑完并落账（最早的即紧邻下面的过早结束闸）。
  //      ⚠ 位置仍满足既有约束——必须在 `promoteTaskFileDeliverables` 之前（promote 内的
  //        `markDocAcceptanceVerified` 读的正是这份账，只是更早，不违反）。
  //      ⚠ 前移**不越过**上面两道产出闸（产出未落盘 / 内容不充分）：那两道一旦命中，本 run 根本不收口
  //        （置 pending 等下一轮重跑），提前判卷既白付一次验收 LLM、又把"尚未成形的产出"记成账。
  //        方案 §6.1 的首选是"前移到 `assessCompletionQuality` 之前"，此处**据实收窄**到
  //        "越过两道产出闸、进入收口判定的第一处"，收窄方向是安全方向（更晚＝更少无谓判卷）。
  //   ② **重算**：完成分**重新算一遍**，不"加回 45"——`capScoreByAcceptanceVerdict` 是单向函数、
  //      不可逆推（承 `feedback_verify_roundtrip_at_production_input`：往返须在生产入参上成立）。
  //      重算即让评分读的是**新鲜账**——这是 O-D 的本体，不是附带。
  // 另（同一份账两个出口）：开关 `deliverable.acceptance_on_close` 关闭时本段不重跑验收，但**终态判据
  //   照读同一份账**（下面的 `closeAccNow`）。此前终态读的是"刚跑出来的 payload"，关开关即得
  //   `not_checked`，而评分读的却是账上的 `failed` ⇒ 同一份 `context_json` 里"账说未通过、终态 completed"。
  //   现在判据与评分**同源同刻**：评分经 `assessCompletionQuality` 自读该账，终态经 `closeAccNow` 读该账。
  try {
    if (readBoolSetting(db, 'deliverable.acceptance_on_close')) {
      const closeCriteria = readTaskAcceptanceCriteria(db, taskId);
      await checkAcceptanceCriteria(ctx, db, taskId, closeCriteria);
    }
  } catch { /* 验收记账失败不阻断收口 */ }
  const closeAccNow = readAcceptanceCheck(db, taskId);
  // 结论判据**唯一**在 `acceptanceVerdictOf`（承 M1c「一处真源」），且取的是**刚落账的新鲜载荷**。
  const closeVerdict: AcceptanceVerdict = acceptanceVerdictOf(closeAccNow);
  // 形状由 `toAcceptanceSummary` 单一说了算——与 finalize 路的 emit 同形（不各抄一遍四个键）。
  // 与从前的一处**如实差异**：开关关闭/无账时此处不再恒为 `undefined`，而是"账上是什么就报什么"
  //   （P0-2(d) 要的正是"完成事件带三态之一"；从前关开关即不带，等于三态少一态）。
  const closeAcceptance: AcceptanceSummary | undefined = toAcceptanceSummary(closeAccNow);
  const closeTotal = Number(closeAccNow?.criteria_total) || 0;
  const closeFailedN = closeAccNow?.failed?.length ?? 0;
  // ② 重算（读改写，**只动这两个键**，不覆盖刚落笔的 `acceptance_check`）
  let qualityScore = assessCompletionQuality(db, taskId, stepCount, totalTokensUsed, maxTokens, maxSteps, workingDir, archetype);
  try {
    const qRow = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const qCtx = JSON.parse(qRow?.context_json || '{}') as Record<string, unknown>;
    const goalNow = goalAchievedOf(goalDefined, qCtx.goal_deviation_restarts, qualityScore.score);
    qCtx.completion_quality = buildCompletionAccount({
      score: qualityScore.score,
      goalAchieved: goalNow,
      via: 'run_close',
      feedback: qualityScore.feedback,
    });
    qCtx.goal_achieved = goalNow;
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(qCtx), taskId);
    syncQualityColumn(db, taskId);
  } catch { /* 重算落库失败不阻断收口 */ }
  logger.info(
    { taskId: taskId.slice(0, 8), verdict: closeVerdict, total: closeTotal, failed: closeFailedN, score: qualityScore.score },
    'run_close 验收记账 + 完成分重算完毕',
  );

  // zx_20260904_6 D1 (2026-09-04): 过早结束(预算/步数到顶)且质量<60 → 不 completed，转 paused 待人工（partial 不冒充完成）
  // zx_20260922_1 M6（F8）: 预算侧与禁用侧**同源**——一律经 `budgetCapReached` 读 `budget_warn_band`
  //   （禁用侧正是在 band 4 这一档首次宣告"预算超限"），不再单独读 Token 尺的 `budget_usage_ratio`。
  // zx_20261013_2 批二（毛选·主要矛盾 / 管子·度量衡）: 「过早结束」的**前提**是"活已到头"。父任务此刻若
  //   **还在等子任务**（失败子未处置 / 非终态子仍在跑），它就不是"过早结束"而是"在等"——本闸不得抢在
  //   `finalizeRunClose` 那两道良性子任务闸之前把父判成"低分过早结束"（真库标本 `7c39678e`：整份 8 里程碑
  //   方案只做完 M0 ⇒ 拿整份方案判卷必得 45 分；而按良性闸本应落 `children_incomplete`"非故障，待子任务
  //   完成自动恢复"）。判据（含"先失败后未完成"）在 `children-gate.ts` 一处真源，与收口闸同尺。
  const childrenPending = childrenPendingAttention(db, taskId);
  const prematureEnd = (budgetCapReached(ctxJson) || (maxSteps > 0 && stepCount >= maxSteps - 2)) && !childrenPending;
  if (prematureEnd && qualityScore.score < 60) {
    // zx_20260916 M1(A1): 低分的**成因**须如实点名——第 4 条压降落账后，45 分可能是"验收未通过"压出来的，
    //   此时只写"质量 N 分<60"会让人以为是产出不足。判据仍取 `acceptanceVerdictOf` 那一处（不另判一遍）。
    const d1FailedBy = acceptanceVerdictOf(readAcceptanceCheck(db, taskId)) === 'failed' ? '（成因含「验收未通过」压降）' : '';
    // zx_20261021_4 批四：步数撞顶时如实点名"恢复后会得到什么"。旧文案只说"请恢复继续"，
    //   而恢复按同一公式重算 ⇒ 用户恢复一次、原样再撞一次（`03c71f39`）。续额要么真发了、要么真用尽，两说罢明。
    const capCont = stepCapContinuationOf(ctxJson);
    const capContMsg = capCont ? ` ${buildStepContinuationNote(capCont)}` : '';
    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
      .run(crypto.randomUUID(), taskId, `[未达交付·过早结束] 预算/步数已到顶但质量 ${qualityScore.score} 分<60${d1FailedBy}，任务未标完成，已暂停待人工：请核验产出（测试/提交/内容）后"恢复继续"或"标记完成"。${capContMsg}`);
    // zx_20260909_1 M1(A1): 过早结束未达交付需人工→通知创建人（zx_20260917 M1：同经 `pauseTask` 一次写全）
    pauseTask(db, { taskId, reason: PAUSE_REASON_QUALITY_BELOW_BAR, note: `预算/步数到顶但质量 ${qualityScore.score} 分未达交付标准${capContMsg}` });
    logger.warn({ taskId: taskId.slice(0, 8), score: qualityScore.score }, '过早结束且质量<60，任务暂停而非标完成');
    return { content: finalContent, steps: stepCount };
  }

  // M5 实机复核修⑤(空性·如实/知行合一): 门禁(存在+充分性)全过、即将标 completed 前, 清掉先前不充分/未落盘回合
  // 在 ctx 留存的 deliverable_unfulfilled / deliverable_missing_retries 陈旧标记——否则 promoteTaskFileDeliverables 见
  // deliverable_unfulfilled 仍置即跳过 → 已完成任务 doc 停在 draft(完成回话呈"在制", 与 completed 状态不一致)。实测 cab816bf 触发。
  try {
    const finCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
    if (finCtx.deliverable_unfulfilled || finCtx.deliverable_missing_retries) {
      delete finCtx.deliverable_unfulfilled;
      delete finCtx.deliverable_missing_retries;
      // zx_20260916_3 M3（判据 C3 · 先例复核）: 此处原为 `finCtx.goal_achieved = true` 硬写——
      //   它**只**清陈旧标记，却顺手把顶层目标达成一律改成 true，与上方针的账（`completion_quality`，
      //   已由 `buildCompletionAccount` 落笔）可能**相反**：账上说未达成、顶层说已达成，同一份 context_json
      //   自相矛盾，正是 `5126b303` 那类"两版账"的同形。改为取账上同值（`syncGoalAchievedFromAccount`）。
      syncGoalAchievedFromAccount(finCtx);
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(finCtx), taskId);
    }
  } catch { /* 清除失败不影响收口 */ }

  // zx_20260921 M8（重构·只动形不动义）: run_close 收口段（收口三闸 → 标完成 → 探针处置 → 完成事件 →
  //   成果提升 → 策略闭环记账）已整段搬至 `core/exec-finalize.ts`；此处只剩接线。
  //   ⚠ 返回的就是 `executeTask` 本该返回的 `{ content, steps }`——三个早退口（失败子未处置 / 仍有未完成子 /
  //     无产出证据 / 验收未通过）与达标收尾同在该函数内，故此处直接 `return`，不再回传中间量。
  //   ⚠ zx_20260929 M9: 本模块整体又是 `executeTask` 收尾段（两道产出闸之后 → `finalizeRunClose` 之前）的
  //     外移，`finalizeRunClose` 的调用点随之落到本文件末尾。上方 D1「过早结束」闸与陈旧标记清理**同在本段内**，
  //     按搬迁前的先后排在本调用之前——顺序与搬迁前逐字一致（不得把本调用提到它们之前）。
  return finalizeRunClose({
    db, ctx, taskId, projectId, archetype, adaptiveStrategy, fileMutationCount, finalContent,
    stepCount, qualityScore, closeVerdict, closeTotal, closeFailedN, closeAcceptance,
    title, modelName, maxSteps, totalTokensUsed, toolCallCount, rawCost,
  });
}
