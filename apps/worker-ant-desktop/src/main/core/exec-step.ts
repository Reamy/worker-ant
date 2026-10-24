/**
 * zx_20260929 M9（重构·只动形不动义）: `executeTask` 的**步回调**——`streamText({ onStepFinish })` 的箭头体，整段外移。
 *
 * 搬迁来源：`core/agent-executor.ts` 的 `onStepFinish: async (event) => { … }`（原 `:2132`–`:2728`），**逐字搬运**。
 *   唯一的机械改写：段内对 `executeTask` 的 53 个绑定统一前置 `d.`（原名与 `d.<名>` 一一对应）。
 *   改名按**符号身份**作（`checker.getSymbolAtLocation`），不按字面——同名的全局名（`Array`/`Math`）、
 *   属性名、局部名一概不受影响（实测同名不同符号冲突 0 处）。
 *
 * 为什么单独成模块：这段回调占 `executeTask` 约三分之一，且是**每步都走一遍**的热路径。它对外层
 *   没有"工作变量"式的依赖——唯一的局部量（`ctxJson`/`stepTokens`/`toolCalls` 等）都在段内自声明；
 *   对外的通道全在 53 个既有绑定上。
 *
 * ⚠ 接口成员**刻意用访问器**（`get`/`set`），**不用值快照**：本段对其中 23 个绑定是**写回**语义
 *   （`d.stepCount++`、`d.degradationLevel = …`、`d.loopRun = …`）。值快照会把每步的计数/水位/降级档
 *   丢在模块内层，执行体此后读到的还是旧值——**静默的行为改变**。访问器让读写仍是**同一处绑定**，
 *   语义与搬迁前逐字相同。只读的其余成员只给 `get`：**写不进去由类型层拦下**（比注释可靠）。
 *
 * ⚠ 运行时 `import` 回 `./agent-executor.js`（上述诸函数的真源**仍在执行体一处**，此处**未复制第二份**）——
 *   与 `exec-claim` / `exec-close` / `exec-budget` / `exec-context` / `exec-finalize` 同形：这些绑定
 *   只在函数体内读，不在模块顶层求值 ⇒ ESM 循环引用不触发 TDZ。
 *   跨文件的（`eventBus`/`pauseTask`/…）一律从**各自真源模块**取，不经执行体转手。
 *
 * ⚠ 本模块**运行时**在 `streamText` 的每步被调用；rr 回归无模型 ⇒ 跑不到这里。等价性由三条静态证据兜：
 *   ① 搬迁前后**归一化逐字节相等**（去 `d.` + 统一缩进后 diff 为空）；
 *   ② `tsc --strict` ——漏改一个名字即 "Cannot find name"，写错的成员即类型不匹配；
 *   ③ `tsup` + 全量 rr 无回归（覆盖所有**从执行体读这段**的静态判据）。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { eventBus } from './event-bus.js';
import { toolRegistry, type ExploreQuotaLedger } from './tool-registry.js';
import { pauseTask } from './pause-task.js';
import { PAUSE_REASON_NO_PROGRESS, PAUSE_REASON_TOOL_LOOP } from './pause-reason.js';
import { stepStopVerdict } from './stop-signals.js';
import { recordToolUsage, type ProjectThresholds } from './feedback-engine.js';
import { logStepExecution, stepEventToolLabel } from './observability.js';
import { reassessComplexityDuringExecution, type ComplexityLevel, type TaskArchetype } from './task-archetype.js';
import { readBoolSetting } from './settings-bool.js';
import { countActiveChildren, MAX_CHILD_BREADTH, goalDeviationCapReached } from './task-accounting.js';
// zx_20260930 M9: 记账上报**本就走签名路**（`AnsClient.post`），但失败被 `.catch(() => {})` 咽掉；
//   留痕需要有 logger（本文件此前没有——同族 exec-*.ts 都是这个形状）。
import { createLogger } from './logger.js';
// zx_20261012_3 批二（「算得真」）：本步 token 增量的**唯一**口径（真值差分 or usage 缺席时的字符估）。
import { stepTokenDelta, estimateTokensFromChars } from './token-estimate.js';
import {
  BUDGET_HARD_STOP_TOOLS,
  BUDGET_WARN_TOOLS,
  CONVERGE_CMD_HARD,
  D3_GATE_TOOLS,
  MIXED_SHELL_TOOLS,
  advanceLoopRun,
  assessFailureRisk,
  budgetBandOf,
  buildCompletedItemsBlock,
  buildDeviationContextBlock,
  buildUserDirectiveBlock,
  checkGoalDeviation,
  checkSufficiency,
  cnyFactor,
  collectWrittenFiles,
  countsTowardToolQuota,
  describeToolCall,
  evaluateFlowMode,
  generateSufficiencyHint,
  goalDeviationExempt,
  hasRealDeliverable,
  isExplorationCall,
  isExplorationToolAlways,
  makeNonExplorationCappedTool,
  readRecentToolNames,
  readRecentUserDirectives,
  realDeliverables,
  realOutputEvidence,
  toolCallFingerprint,
  type AgentContext,
  type FlowModeState,
  type LoopRun,
  type ToolStubLike,
} from './agent-executor.js';

const logger = createLogger('exec-step');

/**
 * `onStepFinish` 载荷的**最小结构面**——本段只读 `text` 与 `usage` 两个字段，其余一概不用。
 * 刻意不引 `ai` 的内部类型（`StepResult` 未导出）：结构上 `ai` 的 `StepResult` 可赋给本型，
 * 而本模块不必随 SDK 类型改名而改。
 */
interface StepFinishEvent {
  readonly text?: string;
  readonly usage?: { promptTokens?: number; completionTokens?: number; outputTokens?: number };
}

/**
 * 步回调对 `executeTask` 全部依赖的**显式面**（照 `exec-claim`/`exec-close` 的 `deps` 对象先例）。
 * 改名语义见文件头"访问器"一条。
 */
export interface StepScope {
  get ctx(): AgentContext;
  get taskId(): string;
  get db(): Database.Database;
  get projectId(): string;
  get archetype(): TaskArchetype;
  get complexityLevel(): ComplexityLevel;
  get ansClient(): { getOptimalModel: (params: Record<string, unknown>) => Promise<Record<string, unknown>>; };
  get modelName(): string;
  get inputPricePer1k(): number;
  get outputPricePer1k(): number;
  get ctxWindowForWater(): number;
  get taskGoal(): { goal: string; success_criteria: string; investigate: string[]; } | null;
  get maxTokens(): number;
  get costGateActive(): boolean;
  get maxCost(): number;
  get costSrc(): "task" | "project" | "none";
  get ctxAssembledChars(): number;
  get estTokens(): number;
  get toolMap(): Record<string, unknown>;
  get savedTools(): Record<string, unknown>;
  get maxSteps(): number;
  get stepCount(): number;
  set stepCount(v: number);
  get totalTokensUsed(): number;
  set totalTokensUsed(v: number);
  get totalCostUsed(): number;
  set totalCostUsed(v: number);
  get askUserCalled(): boolean;
  set askUserCalled(v: boolean);
  get finalizeCompleted(): boolean;
  set finalizeCompleted(v: boolean);
  get consecutiveErrors(): number;
  set consecutiveErrors(v: number);
  get noProgressSteps(): number;
  set noProgressSteps(v: number);
  get toolErrorCount(): number;
  set toolErrorCount(v: number);
  get toolCallCount(): number;
  set toolCallCount(v: number);
  get writeTools(): Set<string>;
  get writeToolCount(): number;
  set writeToolCount(v: number);
  get fileMutationCount(): number;
  set fileMutationCount(v: number);
  get recentToolNames(): string[];
  get quotaLedger(): ExploreQuotaLedger;
  get exploreCmdN(): number;
  set exploreCmdN(v: number);
  get loopRun(): LoopRun;
  set loopRun(v: LoopRun);
  get degradationLevel(): number;
  set degradationLevel(v: number);
  get complexityUpgraded(): boolean;
  set complexityUpgraded(v: boolean);
  get sufficiencyHintFired(): boolean;
  set sufficiencyHintFired(v: boolean);
  get flowState(): FlowModeState;
  get projectThresholds(): ProjectThresholds;
  get disabledTools(): Set<string>;
  get cappedTools(): Set<string>;
  get disableToolGracefully(): (toolName: string, reason: string) => void;
  get lastReadFileKey(): string;
  set lastReadFileKey(v: string);
  get sameFileReads(): string[];
  set sameFileReads(v: string[]);
  get totalPromptTokens(): number;
  set totalPromptTokens(v: number);
  get totalCompletionTokens(): number;
  set totalCompletionTokens(v: number);
  get prevPrompt(): number;
  set prevPrompt(v: number);
  get prevComp(): number;
  set prevComp(v: number);
  get controller(): AbortController;
  get lastStepTs(): number;
  set lastStepTs(v: number);
}

/**
 * 造步回调。执行体在 `streamText({ onStepFinish: … })` 处以 `createStepHandler(stepScope)` 接入；
 * `stepScope` 是一组**活访问器**（读写落到 `executeTask` 的那些绑定本身），不是快照。
 */
/** 载荷的字符量（估算 token 用）；非串/循环引用 ⇒ 退回 0，**不抛**（估算不该弄崩执行）。 */
function safeJsonLen(v: unknown): number {
  if (v == null) return 0;
  try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; }
}

export function createStepHandler(d: StepScope) {
  return async (event: StepFinishEvent): Promise<void> => {
    // zx_20261012_3 批二：本步 token 是否含"估"——写进 ctxJson 指标，供事后辨明账里有多少推算。
    let estimatedStep = false;
    d.stepCount++;
    // 配置任务Step1完成后→恢复完整工具集
    if (d.stepCount === 1 && d.archetype === 'configuration' && Object.keys(d.savedTools).length > 0) {
      for (const key of Object.keys(d.savedTools)) { if (!(key in d.toolMap)) d.toolMap[key] = d.savedTools[key]!; delete d.savedTools[key]; }
      d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), d.taskId, '[Step 1完成] ask_user已执行，完整工具集已恢复。请继续按流程执行任务。');
    }
    // R3: 心跳——每步刷新 updated_at，防止长任务被超时检测误杀
    try { d.db.prepare("UPDATE wa_tasks SET updated_at = datetime('now') WHERE id = ?").run(d.taskId); } catch {}
    // zx_20260904_7 统计修复 (2026-09-04): provider 可能返回"累计" usage → 用 prev 差算逐步增量，
    // 避免每步把运行累计重复计入（预算 ratio / 运维趋势 token 曾虚高，如 53M/日 vs ANS 记账 5M/30天）
    // zx_20261012_3 批二（「算得真」）：本步增量改由 `stepTokenDelta`（一处真源，见 core/token-estimate.ts）
    //   算——usage **在场** ⇒ 逐字沿用上面的累计差分（口径分毫不动）；usage **缺席** ⇒ 按字符估
    //   （字÷4，与 prelude_usage／旁路／output-validator 同一分度）。此前缺席即 0 ⇒ `totalTokensUsed`
    //   恒 0 ⇒ Token 闸（`max_tokens`）永不触发——某项目 4,000,000 预算的闸形同虚设。
    //   估出来的数**标"估"**（`estimated`）：不冒充真值，事后可辨这一笔是测量还是推算。
    const curPrompt = (event.usage as { promptTokens?: number } | undefined)?.promptTokens ?? 0;
    const curComp = (event.usage as { completionTokens?: number; outputTokens?: number } | undefined)?.completionTokens ?? (event.usage as { outputTokens?: number } | undefined)?.outputTokens ?? 0;
    const evLoad = event as { text?: string; toolCalls?: unknown[]; toolResults?: unknown[] };
    const outChars = (evLoad.text?.length ?? 0)
      + safeJsonLen(evLoad.toolCalls) + safeJsonLen(evLoad.toolResults);
    const stepDelta = stepTokenDelta({
      usage: event.usage, prevPrompt: d.prevPrompt, prevComp: d.prevComp,
      inChars: d.ctxAssembledChars, outChars,
    });
    d.prevPrompt = curPrompt; d.prevComp = curComp;
    const stepPrompt = stepDelta.prompt;
    const stepComp = stepDelta.completion;
    const stepTokens = stepDelta.total;
    if (stepDelta.estimated) estimatedStep = true;
    d.totalTokensUsed += stepTokens;
    d.totalPromptTokens += stepPrompt;
    d.totalCompletionTokens += stepComp;
    const hasToolsNow = ((event as { toolCalls?: Array<unknown> }).toolCalls?.length || 0) > 0;
    // zx_20260904_7 统一记账 (2026-09-04): 每步调用增量写入 ANS billing（与"按模型/趋势"同源；异步失败不阻塞）
    if (stepTokens > 0) {
      try {
        const stepCost = (stepPrompt / 1000) * d.inputPricePer1k + (stepComp / 1000) * d.outputPricePer1k;
        // zx_20260910_5 M1: 费用闸累计——复用与 ANS 记账完全相同的折算与舍入，保证闸内累计与账单账实相符
        const stepCostCny = Math.round(stepCost * cnyFactor(d.modelName) * 1_000_000) / 1_000_000;
        d.totalCostUsed += stepCostCny;
        const rec = { endpoint_id: 'agent-step', model_id: d.modelName, project_id: d.projectId, tokens_in: stepPrompt, tokens_out: stepComp, cost: stepCostCny, currency: 'CNY' };
        const ac = (await d.ctx.getAnsClient()) as { post?: (p: string, b: unknown) => Promise<unknown> };
        // zx_20260930 M9: 这一路**本就走签名路**（`AnsClient.post` → `requestWithRetry` 签三头，与
        //   `ans-signed-request` 同一把尺 `createHmacSignature`）——本轮的改动只在这里：
        //   原先 `.catch(() => {})` 把失败咽成一声不响 ⇒ 记账恒失败也无人知。**不阻塞执行**的口径不变。
        ac.post?.('/api/v1/billing/records', rec).catch((e: unknown) => {
          logger.warn({ error: (e as Error)?.message, model: d.modelName, tokens: stepTokens }, '[exec-step] ANS 记账上报失败');
        });
      } catch { /* ANS 记账失败不阻塞执行 */ }
    }
    if (event.text) {
      d.db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'assistant', ?, ?, datetime('now'))"
      ).run(crypto.randomUUID(), d.taskId, event.text.slice(0, 50_000), hasToolsNow ? 0 : stepTokens); // 归一到一行：纯文本步记 assistant，工具步记工具行
    }
    // 工具调用日志（诊断用：记录每步调用哪些工具）
    const toolCalls = (event as { toolCalls?: Array<{ toolName: string; args?: unknown }> }).toolCalls || [];
    const toolResults = (event as { toolResults?: Array<{ error?: unknown; result?: unknown }> }).toolResults || [];
    // Phase F (2026-08-28 zx_4): finalize 成功 → 立即终止循环（功成身退，避免恋栈空转导致超时误判失败）
    const finalizeIdx = toolCalls.findIndex(tc => tc.toolName === 'finalize_task');
    if (finalizeIdx >= 0) {
      const fr = toolResults[finalizeIdx];
      const fres = fr?.error == null ? String(fr?.result ?? '') : '';
      // zx_20260928 M2（「完成出口同一把尺」）: 低分收口（工具串含 `paused_partial`，工具内已 `pauseTask`
      //   落因+告知）→ **同样 abort**，只是理由可辨识（`finalize_paused`），由 catch 干净返回、不标完成。
      //   放在 `finalized` 判定**之前**：工具的 `checks` 明细里理论上可能含 `finalized` 子串。
      //   顺带关掉一个存量洞：`控制.ts` 那处「预算强制收尾 + partial」暂停此前只置状态、**不 abort**，
      //   循环继续后会被 run_close 段改写回 completed（"停"被静默撤销）；本 marker 让两支同走 abort。
      if (fres.includes('paused_partial')) {
        try { d.controller.abort(new Error('finalize_paused')); } catch {}
      } else if (fres.includes('finalized')) {
        d.finalizeCompleted = true;
        try { d.controller.abort(new Error('finalize_completed')); } catch {}
      }
    }
    if (toolCalls.length > 0) {
      const toolSummary = toolCalls.map(tc => `${tc.toolName}(${JSON.stringify(tc.args ?? {}).slice(0, 200)})`).join('; ');
      d.db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, ?, datetime('now'))"
      ).run(crypto.randomUUID(), d.taskId, `[工具调用] ${toolSummary.slice(0, 500)}`, stepTokens);
      // 工具结果落库（resume 时模型可见之前工具返回了什么）
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        const tr = toolResults[i];
        let rawResult = tr?.error != null ? `[错误] ${String(tr.error)}` : String(tr?.result ?? '');
        let resultStr = rawResult.slice(0, 500);
        // 工具结果超长落盘：>4096 字写入磁盘，DB 只存路径引用（防上下文溢出）
        if (rawResult.length > 4096) {
          try {
            const outDir = path.join(d.ctx.dataDir, 'task_outputs', d.taskId);
            // zx_20260916_2 M2: 这一步**每步都可能走到**（工具结果 >4096 字即落盘，read_file/bash 的大回话几乎必然命中），
            //   同步写盘等于把"最大的一笔回话"钉在事件循环上。落盘失败仍走同一 `catch` 降级（行为不变）。
            await fsp.mkdir(outDir, { recursive: true });
            const fname = `${tc.toolName}_${Date.now()}.json`;
            const fpath = path.join(outDir, fname);
            await fsp.writeFile(fpath, rawResult);
            resultStr = JSON.stringify({ stream: rawResult.length > 100_000, path: fpath, size: rawResult.length, preview: rawResult.slice(0, 500) });
          } catch { resultStr = rawResult.slice(0, 800); }
        }
        if (resultStr) {
          d.db.prepare(
            "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'tool', ?, 0, datetime('now'))"
          ).run(crypto.randomUUID(), d.taskId, `[${tc.toolName}] ${resultStr.slice(0, 800)}`);
        }
      }
    }
    // Phase A (2026-08-28) 意义即使用：逐步执行流实时推送（让执行过程公开可验证，摆脱黑盒）
    // D2: 步骤详情扩展——耗时/本步token增量/工具成败，供前端「思考中」指示与步骤流展示
    try {
      const now = Date.now();
      const stepToolSummary = toolCalls.map(tc => `${tc.toolName}(${JSON.stringify(tc.args ?? {}).slice(0, 120)})`).join('; ');
      const toolOk = toolResults.length === 0 || toolResults.every(tr => tr?.error == null);
      // E1 (2026-09-04_2): 附累计预算 band（跨 resume 累计口径）——前端预算带随步进实时判 band，band 越界即"质变点"脉冲
      // zx_20260910_5 M1b (X5): 单计数器（totalTokensUsed 恢复时已含历史），band 改用单一真源 budgetBandOf
      const budgetRatioCum = d.maxTokens > 0 ? d.totalTokensUsed / d.maxTokens : 0;
      const budgetBandNow = budgetBandOf(budgetRatioCum);
      // zx_20260904_4 T5 (2026-09-04): 水位随步骤实时刷新（近似=首部字符/4 + 已用 token）——零新事件
      // zx_20261012_3 批二：分度走一处真源 `estimateTokensFromChars`（值不变，只是不再手写 `/4`）。
      const liveApproxTokens = estimateTokensFromChars(d.ctxAssembledChars) + d.totalTokensUsed;
      const contextWaterPct = Math.min(100, Math.round((liveApproxTokens / d.ctxWindowForWater) * 100));
      eventBus.emit('task.step_finished', {
        taskId: d.taskId, task_id: d.taskId, projectId: d.projectId,
        step: d.stepCount,
        duration_ms: now - d.lastStepTs,
        text: (event.text ?? '').slice(0, 2000),
        toolCalls: stepToolSummary.slice(0, 500),
        tokens: stepTokens,
        token_delta: stepTokens,
        // zx_20261012_3 批二（「算得真」）：本步数字是否为"估"——前端/账本据此标注，不把推算当真值显示。
        tokensEstimated: stepDelta.estimated,
        toolOk,
        totalTokens: d.totalTokensUsed,
        budgetRatio: Number(budgetRatioCum.toFixed(4)),
        budgetBand: budgetBandNow,
        budgetMaxTokens: d.maxTokens,
        contextWaterPct,
        // zx_20260904_7 I1 (2026-09-04): 实际 vs 预估 token 偏差%（跨 resume 累计，与预算 ratio 同源；无预估则空）
        estBiasPct: d.estTokens > 0 ? Math.round((d.totalTokensUsed / d.estTokens - 1) * 100) : undefined,
      }).catch(() => {});
      d.lastStepTs = now;
    } catch { /* 实时推送失败不影响执行主流程 */ }

    // 「令」的每步判据（zx_20261023_3 批一）：`ask_user` 软收尾；`paused` / 终态 ⇒ **真中止**。
    //   zx_20261021_2 D1 只认终态；`paused` 此前仅置 `askUserCalled` 旗标，要等整个多步循环结束才消费——
    //   实测暂停后仍跑 23 步。判据收在 `stop-signals.ts` 一处（与起跑前判据同源）。
    const curStatus = (d.db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(d.taskId) as { status: string } | undefined)?.status;
    const stop = stepStopVerdict(toolCalls.map((tc: { toolName: string }) => tc.toolName), curStatus);
    if (stop.askUser) d.askUserCalled = true;
    if (stop.abortReason) {
      try { d.controller.abort(new Error(stop.abortReason)); } catch {}
    }

    // 知足者富：追踪写入类工具调用
    for (const tc of toolCalls) {
      if (d.writeTools.has(tc.toolName)) d.writeToolCount++;
    }
    // zx_20260915 P0-1(d)：**本轮**文件改动次数（只数 write_file/edit_file，不含 finalize_task——
    // 后者是收口动作而非产出）。**非判据**，判据只有 realOutputEvidence 一把尺；
    // 记它只为复盘时区分"本轮全只读"与"本轮写了但文件被删"（`1113e215` 事后无法区分）。
    for (const tc of toolCalls) {
      if (tc.toolName === 'write_file' || tc.toolName === 'edit_file') d.fileMutationCount++;
    }

    // A1/A4: 工具循环检测 + A3 渐进降级
    let pushedThisStep = false;
    // zx_20260922 M2: **本步**非探索调用的指纹（去重交给 `advanceLoopRun`，此处不预判）。
    const stepFps: string[] = [];
    for (const tc of toolCalls) {
      if (d.disabledTools.has(tc.toolName)) continue;
      // 只读探索工具(含只读型 bash)不参与"同工具循环"检测（连续读不同文件属正常探索）
      if (!isExplorationCall(tc.toolName, tc.args)) {
        // zx_20260922 M1: 旧账记**工具名**（供 `failure_record`，含窗口/复位语义**逐字保留**）；
        //   新账记**完整调用身份**（供循环判据）。两本账问的不是同一件事，见声明处注释。
        d.recentToolNames.push(tc.toolName);
        pushedThisStep = true;
        if (d.recentToolNames.length > 8) d.recentToolNames.shift();
        stepFps.push(toolCallFingerprint(tc.toolName, tc.args));
      }
      // zx_20260909 #7a: D3 闸的输入（判据 `isExplorationCall`，与上面配额账的尺同向不同源，见声明处注释）
      // zx_20260917 M5b·病根④: 工具的"混合类"由 `MIXED_SHELL_TOOLS` 出——**不再手写字面量**。
      //   本行是【尺一：计数】，`D3_GATE_TOOLS` 处是【尺二：处置】；两尺自此读同一份常量，不会再分家。
      if (MIXED_SHELL_TOOLS.has(tc.toolName) && isExplorationCall(tc.toolName, tc.args)) d.exploreCmdN++;
      // zx_20260916_1 M2: **A3 配额账**——收尾命令不吃额度，只读探索才吃（判据见 `countsTowardToolQuota`）。
      // 原 D2 (2026-09-03_1) 的"只读 bash 软配额"已删除：它在**同一个**计数点（`bcount>=20`）上另写
      //   一句"不会被硬禁用"，而 A3 在该点上**真硬禁用**——同一件事两处落点、其中一处文案是假的。
      //   文案现只在 `tool-registry.ts` 的 `quota.softMsg/hardMsg` 一处定义，且只描述闸门会做什么。
      // zx_20260916_3 M5（O-H）：计入的是**该工具所属的那本账**（`quotaKey`），不是工具自己——
      //   `bash` 与 `execute_command` 因此落到同一个计数器上。
      if (countsTowardToolQuota(tc.toolName, tc.args)) {
        d.quotaLedger.add(toolRegistry.quotaKeyOf(tc.toolName));
      }

      // zx_20260922 M3: 原 A1 的「同参数去重」段已删——它在此处（每次调用）另算一本账，与下方
      //   A3 阶梯（每步一本账）判同一件事。合并后**唯一出闸口**在阶梯，文案取 A1 那句更可操作的。

      // A4: 重复读文件检测（连续读同一文件同一位置未写入→提示停止读取；不同 offset 分块读大文件属正常探索，不计数）
      if (tc.toolName === 'read_file') {
        const ra = tc.args as { filePath?: string; offset?: number };
        const fp2 = ra.filePath || '';
        const readKey = `${fp2}#${ra.offset ?? 0}`;
        if (readKey === d.lastReadFileKey) {
          d.sameFileReads.push(fp2);
          if (d.sameFileReads.length >= 3) {
            d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
              .run(crypto.randomUUID(), d.taskId, `[重复读取警告] 已连续${d.sameFileReads.length}次读取同一文件"${fp2.split('/').pop()}"的同一位置但尚未写入。请停止读取，用 write_file 将分析结论写入产出文件。`);
          }
        } else { d.lastReadFileKey = readKey; d.sameFileReads = [fp2]; }
      }
      // 写入类工具重置重复读计数
      if (d.writeTools.has(tc.toolName)) { d.sameFileReads = []; d.lastReadFileKey = ''; }
    }
    // 当前步未产生非探索调用（纯只读探索/写文件等）→ 连续性被打断，重置序列，避免旧序列残留反复触发降级告警
    if (!pushedThisStep) d.recentToolNames.length = 0;
    // zx_20260922 M2: 游程按**步**推进——一步一次，本步内并行了几条都只算一步；窗口由阈值派生，
    //   此处**无上限**（旧实现硬编码 8，见 `advanceLoopRun` 的 ⚠）。
    d.loopRun = advanceLoopRun(stepFps, d.loopRun);
    const continuousSame = d.loopRun.len;
    const toolLoopWarn = d.projectThresholds.toolLoopWarn;
    const toolLoopHard = d.projectThresholds.toolLoopHard;
    if (continuousSame >= toolLoopWarn) {
      // zx_20260922 M4: 三处文案一律带**命中的那个指纹**（`describeToolCall` 出可读形）——
      //   旧文案只有工具名（"连续6次调用bash"），误报时判读者无从复核；带上指纹后可一眼证伪。
      const hitCall = describeToolCall(d.loopRun.fp);
      // 级别1: 软警告（warn~hard之间）——流模式下跳过软干预
      // zx_20260922 M3: 文案取原 A1 那句（"结果不会改变…"比"请改变策略"更能让模型立刻换个做法）；
      //   计量单位随之由「次（调用）」改为「步」——与梯子同源（一步一次，见 `advanceLoopRun`）。
      if (continuousSame < toolLoopHard) {
        if (!d.flowState.inFlow) {
          d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
            .run(crypto.randomUUID(), d.taskId, `[A3降级·级别1] 已连续${continuousSame}步重复同一调用(${hitCall})。结果不会改变，请改用其他策略或直接产出。`);
        }
      }
      // 级别2: 安全暂停（≥hard）——硬暂停不受流模式影响
      else {
        d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
          .run(crypto.randomUUID(), d.taskId, `[A3降级·级别2] 连续${continuousSame}步重复同一调用(${hitCall})，任务已暂停等待人工介入。`);
        d.degradationLevel = 3;
        // zx_20260909_1 M1(A1 空性·如实/王阳明·该说必说到): 需人工介入暂停→通知创建人(im.notify_pause_needed 门控; 用户主动暂停不经此)。
        //   zx_20260917 M1: 状态/因/事件/告知由 `pauseTask` 一次写全，`note` 即原告知文案。
        pauseTask(d.db, { taskId: d.taskId, reason: PAUSE_REASON_TOOL_LOOP, note: `连续${continuousSame}步重复同一调用(${hitCall})，疑似工具循环` });
        // 真正中止运行中的 generateText（复用 interrupt 的 AbortController 链路）
        try { d.controller.abort(new Error('工具循环硬暂停')); } catch {}
      }
    } else if (continuousSame === 0) {
      d.degradationLevel = 0;
    }

    // A3: 工具配额限制（软警告 + 硬限制禁用）
    // zx_20260916_3 M5（O-H · D4）: 判定（软只响一次 / 到硬线）由真账本 `ExploreQuotaLedger.gate` 出——
    //   本处只落动作。到硬线时按**同账工具一并禁用**（`quotaKeyPeers`）：只禁被调用的那一个，
    //   同账的另一半（bash ↔ execute_command）仍能继续吃这本账 ⇒ 账没归成一本。
    for (const tc of toolCalls) {
      const limit = toolRegistry.getQuota(tc.toolName);
      if (!limit) continue;
      const action = d.quotaLedger.gate(toolRegistry.quotaKeyOf(tc.toolName), limit);
      if (action.softMsg) {
        d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
          .run(crypto.randomUUID(), d.taskId, action.softMsg);
      }
      if (action.hard) {
        // zx_20260922_1 M1（F3）: 处置**按 D3 的同一把尺分流**——混合类 shell（`MIXED_SHELL_TOOLS`）
        //   同一工具既能探索也能收尾，整工具拉黑会把跑测试/构建/`git commit` 一并弹回（第二只标本的
        //   6 次收尾命令正是这样被误伤的）；只有"每一次调用都是探索"的工具才整工具拉黑。
        //   至此 A3 与 D3 对**同一本账**说同一句话（此前 A3 说"两者一并禁用"、D3 说"收尾照常放行"）。
        const peers = toolRegistry.quotaKeyPeers(tc.toolName).filter((k) => d.toolMap[k] && !d.disabledTools.has(k) && !d.cappedTools.has(k));
        if (peers.length > 0) {
          const purePeers = peers.filter((k) => !MIXED_SHELL_TOOLS.has(k));
          const mixedPeers = peers.filter((k) => MIXED_SHELL_TOOLS.has(k));
          for (const k of purePeers) {
            d.disabledTools.add(k);
            // 替换为"已禁用"桩而非删除，避免模型继续调用时 AI SDK 抛 "unavailable tool" 硬错误
            d.disableToolGracefully(k, `工具 ${k} 已因配额耗尽被禁用，请改用其他可用工具或直接产出结果。`);
          }
          for (const k of mixedPeers) {
            // ⚠ 记进 `cappedTools` 而**非** `disabledTools`：该工具仍然可用（见其声明处注释）
            d.cappedTools.add(k);
            d.toolMap[k] = makeNonExplorationCappedTool(k, d.toolMap[k] as ToolStubLike,
              `本次调用属**探索类**（目录/文件枚举、只读探测），已因探索配额耗尽(${limit.hard}次)拒绝。`
              + `⚠ 这是对**该次调用**的拒绝，**不是**${k} 被禁用——${k} 仍可用，跑测试/构建/git 提交等**收尾命令照常放行**，请直接调用。`);
          }
          const parts: string[] = [];
          if (purePeers.length > 0) parts.push(`已禁用 ${purePeers.join('、')}`);
          if (mixedPeers.length > 0) parts.push(`${mixedPeers.join('、')} 收窄为「只拒探索类调用（ls/cat/find 等），收尾命令照常」`);
          if (parts.length > 0) {
            d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
              .run(crypto.randomUUID(), d.taskId, `${limit.hardMsg}\n${parts.join('；')}`);
          }
        }
      }
    }

    // zx_20260904_5 D3 (2026-09-04): 命令/搜索高频探索 → 硬禁用 search/execute/bash（保留 read_file 与产出/收尾；消息与硬行为一致）
    // zx_20260909 #7a 修: 阈值只计"探索类"命令——跑测试/py_compile/git 提交等合法收尾命令此前也累计
    //   把 execute_command/bash 一起硬停, 致 M2 子 agent 在收尾需 git add/commit 时被误伤卡住。现跑测试/git 不再触发。
    // zx_20260916_1 M2: 闸值口径不变（`isExplorationCall`，zx_20260909 #7a 已定的尺），本轮不动 D3。
    // zx_20260917 M5b·病根④: **处置按同类分两路**（原为整片 `killKeys` 拉黑——两把尺正是在此分家）：
    //   纯探索工具（`search_content`/`search_web`）——每一次调用都是探索 ⇒ 整工具禁用与逐调用拒**同义**，保持拉黑；
    //   混合类 shell 工具（`bash`/`execute_command`）——同一工具既能探索也能收尾 ⇒ **只能逐调用拒**。
    //   原写法把两者一起拉黑，收尾命令（跑测试/`git commit`）也一并弹回：第二只标本上 6 次收尾命令全被拒，
    //   只能 `ask_user` 请"特权执行"——38 秒往返，且须人在电脑前（§1.4-Ⅱ）。
    const cmdN = d.exploreCmdN;
    if (cmdN >= CONVERGE_CMD_HARD) {
      const pureKeys = D3_GATE_TOOLS.filter((k) => d.toolMap[k] && isExplorationToolAlways(k) && !d.disabledTools.has(k));
      const cappedKeys = D3_GATE_TOOLS.filter((k) => d.toolMap[k] && !isExplorationToolAlways(k) && !d.cappedTools.has(k));
      for (const k of pureKeys) {
        d.disabledTools.add(k);
        d.disableToolGracefully(k, `工具 ${k} 已因命令高频探索(≥${CONVERGE_CMD_HARD}次)硬禁用；请聚焦产出（write_file/finalize），确需读取用 read_file。`);
      }
      for (const k of cappedKeys) {
        d.cappedTools.add(k);
        d.toolMap[k] = makeNonExplorationCappedTool(k, d.toolMap[k] as ToolStubLike,
          `本次调用属**探索类**（目录/文件枚举、只读探测），已因高频探索(≥${CONVERGE_CMD_HARD}次)拒绝。`
          + `⚠ 这是对**该次调用**的拒绝，**不是**${k} 被禁用——${k} 仍可用，跑测试/构建/git 提交等**收尾命令照常放行**，请直接调用。`);
      }
      const parts: string[] = [];
      if (pureKeys.length > 0) parts.push(`已禁用 ${pureKeys.join('、')}`);
      if (cappedKeys.length > 0) parts.push(`${cappedKeys.join('、')} 收窄为「只拒探索类调用（ls/cat/find 等），收尾命令照常」`);
      if (parts.length > 0) {
        d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
          .run(crypto.randomUUID(), d.taskId, `[探索收敛] 探索类调用已 ≥${CONVERGE_CMD_HARD} 次：${parts.join('；')}。请立即聚焦 write_file 产出并 finalize。`);
      }
    }

    // 失败风险追踪（为之于未有）：连续错误/无进展/工具错误率
    const hasOutput = !!event.text || toolCalls.length > 0;
    if (!hasOutput) d.noProgressSteps++;
    else d.noProgressSteps = 0;

    // 无为而治：流模式进展评估（每步结束后，进展=有文本输出或写入类工具）
    d.flowState.hadProgressThisStep = !!event.text || toolCalls.some(tc => d.writeTools.has(tc.toolName));
    evaluateFlowMode(d.flowState);

    // A4: 无进展硬暂停——连续 N 步无任何输出/工具调用→暂停止损（项目级自适应阈值 noProgressHard）
    if (d.noProgressSteps >= d.projectThresholds.noProgressHard) {
      d.db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), d.taskId, `[无进展暂停] 连续${d.noProgressSteps}步无任何输出或工具调用，任务已暂停。请在恢复后检查执行策略，避免继续空转。`);
      d.degradationLevel = 3;
      // zx_20260909_1 M1(A1): 无进展硬暂停→通知创建人（zx_20260917 M1：同经 `pauseTask` 一次写全）
      pauseTask(d.db, { taskId: d.taskId, reason: PAUSE_REASON_NO_PROGRESS, note: `连续${d.noProgressSteps}步无任何输出或工具调用，疑似空转` });
      try { d.controller.abort(new Error('无进展硬暂停')); } catch {}
    }

    const stepErrors = toolResults.filter(r => r.error != null).length;
    d.toolErrorCount += stepErrors;
    d.toolCallCount += toolCalls.length;
    if (stepErrors > 0) d.consecutiveErrors++;
    else d.consecutiveErrors = 0;

    // 意义即使用：记录每个工具调用的成功/失败（供自适应描述）——这一层**仍是逐调用**
    const stepToolNames: Array<{ toolName: string }> = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      const hasError = toolResults[i]?.error != null;
      stepToolNames.push({ toolName: tc.toolName });
      try { recordToolUsage(d.db, d.projectId, d.archetype, tc.toolName, !hasError); } catch {}
    }
    // C2.1 · zx_20261021_4 批六：执行追踪事件**每步一条**。旧写法在工具循环里逐调用写，
    //   且每次都带**整步** `stepTokens` ⇒ 一个 5 工具步聚合后 token 虚高 5 倍，追踪里"步"也退化成"工具调用"。
    //   工具名经 `stepEventToolLabel` 去重合并（纯文本步如实标「（无工具）」），token 只记一次。
    try { logStepExecution(d.db, d.taskId, d.projectId, { toolName: stepEventToolLabel(stepToolNames), tokens: stepTokens }); } catch {}

    // 每5步评估失败风险，中高风险注入预警
    if (d.stepCount % 5 === 0 && d.stepCount > 0) {
      const risk = assessFailureRisk({
        consecutiveErrors: d.consecutiveErrors, noProgressSteps: d.noProgressSteps,
        tokenBurnRate: stepTokens,
        toolErrorRate: d.toolCallCount > 0 ? d.toolErrorCount / d.toolCallCount : 0,
        stepsRemaining: d.maxSteps - d.stepCount,
      });
      if (risk.level === 'high') {
        d.db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), d.taskId, `[失败风险: ${risk.level}] ${risk.factors.join('; ')}。请检查执行策略，避免继续无效尝试。`);
        // Phase B (2026-08-28 zx_1): 失败风险实时透出（为之于未有——风险萌芽即提示）
        try { eventBus.emit('task.execution_signal', { taskId: d.taskId, task_id: d.taskId, projectId: d.projectId, signalType: 'risk', level: risk.level, message: risk.factors.join('; ') }).catch(() => {}); } catch {}
      } else if (risk.level === 'medium' && !d.flowState.inFlow) {
        d.db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), d.taskId, `[风险提示: ${risk.level}] ${risk.factors.join('; ')}`);
        // Phase B (2026-08-28 zx_1): 失败风险实时透出（为之于未有——风险萌芽即提示）
        try { eventBus.emit('task.execution_signal', { taskId: d.taskId, task_id: d.taskId, projectId: d.projectId, signalType: 'risk', level: risk.level, message: risk.factors.join('; ') }).catch(() => {}); } catch {}
      }
    }

    // 合抱之木：动态复杂度升级（任务比预期难时提示，只提示一次）
    if (!d.complexityUpgraded && d.stepCount % 5 === 0 && d.stepCount > 0) {
      const upgrade = reassessComplexityDuringExecution({
        originalLevel: d.complexityLevel,
        currentSteps: d.stepCount,
        cumulativeTokens: d.totalTokensUsed,
        envErrors: d.toolErrorCount,
      });
      if (upgrade) {
        d.complexityUpgraded = true;
        d.db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), d.taskId, `[复杂度升级] ${upgrade.reason}，升级为${upgrade.newLevel}任务(建议${upgrade.suggestedMaxSteps}步)。可继续深入执行。`);
        // Phase B (2026-08-28 zx_1): 复杂度升级实时透出（合抱之木——任务比预期难时提示）
        try { eventBus.emit('task.execution_signal', { taskId: d.taskId, task_id: d.taskId, projectId: d.projectId, signalType: 'complexity', message: `${upgrade.reason}，升级为${upgrade.newLevel}任务(建议${upgrade.suggestedMaxSteps}步)` }).catch(() => {}); } catch {}
      }
    }

    // 省察克治：每5步检测目标偏离（王阳明·省察克治——时时反省，偏离即纠）
    if (d.taskGoal?.goal && d.stepCount % 5 === 0 && d.stepCount > 0 && d.stepCount < d.maxSteps) {
      try {
        // zx_20260915 M4/P0-6(e): 开关 `engine.deviation_full_input` **在调用侧读**（关 ⇒ 三个新事实全空，
        // 逐字回到本轮前行为：只喂 goal、3×200、无写豁免）。函数内读 setting 就是判据的第二份实现。
        const fullDeviationInput = readBoolSetting(d.db, 'engine.deviation_full_input');
        const recentConvs = d.db.prepare(
          "SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 3"
        ).all(d.taskId) as Array<{ content: string }>;
        const recentText = recentConvs.map(c => (c.content || '').slice(0, fullDeviationInput ? 400 : 200)).join('\n');
        if (recentText.length > 20) {
          // zx_20260911_1 M3: 让判定器看见"被闸卡着"这一事实（原输入只有最近 3 条 assistant 消息，
          // 门禁把模型逼进"修门禁"循环后自然读作"围绕门禁打转"）。读当前 ctxJson 的未满足产出明细——
          // finalize 门禁刚写入的 output_validations 在此已落库，取的是最新事实。
          const gateCtx = JSON.parse((d.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(d.taskId) as { context_json: string } | undefined)?.context_json || '{}');
          // zx_20260916_3 M1: 槽位事实由**调用方**查好注入（buildDeviationContextBlock 保持纯函数，可被 rr 直跑真实现）。
          // 不注入则判定器看不见"是引擎拦的"——把执行体反复尝试建子任务读作偏离并加码（同 zx_20260911_1 M3 的病）。
          gateCtx.child_slots = { active: countActiveChildren(d.db, d.taskId), max: MAX_CHILD_BREADTH };
          // zx_20260915 M4/P0-6(e): 同一次查询取最近 5 次工具调用名——**一次取数喂两用**
          // （加宽输入 + 写豁免），输入与判据因此不可能分家。
          const recentToolNames = readRecentToolNames(d.db, d.taskId, 5);
          // zx_20260917 M5c（失明⑥⑦）: **两路**新事实，同受 `fullDeviationInput` 门控、同在调用侧读
          // （关 ⇒ 两路皆空 ⇒ 判定器输入逐字回到本轮前）。
          //  ⑥ 已完成项账本：落盘文件+**时刻序**（"顺序"的证据本身）+ 已登记且真在的产出物
          //     ——治「未提及被读作未做」；⚠ 与下面第 6 参（门禁事实）同法：**查库由调用方做**
          //     （`buildCompletedItemsBlock` 保持纯函数，rr 才能直跑这份真实现）。
          //  ⑦ 用户/系统最近指令——治「取数硬编码 role='assistant' ⇒ 用户改了重点判分器看不见」。
          //     ⚠ **新增一路**，不是放宽原 assistant 查询（那 3 条 400 字是既有裁定，不得被挤掉）。
          const completedItems = fullDeviationInput
            ? buildCompletedItemsBlock({ files: collectWrittenFiles(d.db, d.taskId), deliverables: realDeliverables(d.db, d.taskId) })
            : '';
          const userDirective = fullDeviationInput
            ? buildUserDirectiveBlock(readRecentUserDirectives(d.db, d.taskId))
            : '';
          const dev = await checkGoalDeviation(
            d.ansClient, d.taskGoal.goal,
            fullDeviationInput ? (d.taskGoal.success_criteria || '') : '',
            recentText, d.ctx, buildDeviationContextBlock(gateCtx),
            fullDeviationInput ? recentToolNames : [],
            completedItems, userDirective,
          );
          if (dev?.deviated && dev.reason) {
            // zx_20260917 M5b·病根⑤: **判定侧**收窄——"已经交出过东西"的任务不再被判为偏离。
            // 四处后果（①会话行 ②事件⇒通知 ③自增 ④abort）**同一判据**，缺一处即是半修：
            //   zx_20260915 只免了"不打断"（④），提醒/通知/自增照旧 ⇒ 用户照样收到"任务偏离目标"，
            //   且计数爬到上限后由 `ai-task.goalRestartExceeded` **照样硬停**——豁免被削弱成"只是没立刻打断"。
            // 理由：落产出是"在干活"的强信号；而判定器的输入面（近 3 条 assistant + 近 5 次工具名）在
            //   目标达成后必然把**自证动作**（跑测试/回填/提交/复核）读作"偏离"——第二只标本即如此被误报。
            const deviationExempt = goalDeviationExempt({
              fullDeviationInput,
              recentToolNames,
              hasRealDeliverable: hasRealDeliverable(d.db, d.taskId),
            });
            // ⚠ 与下面「abort 恒发」的既有裁定**不冲突**：那条裁定的目的是"使『到上限必交人工』不依赖 8 个恢复入口的完整性"，
            //    改的是**判定侧**（这次到底算不算偏离）而非**中断侧**；一旦判为偏离，abort 的恒发规则一字未改。
            if (!deviationExempt) {
              // A1 (2026-08-31): 偏离提醒作 user 消息写入（规避恢复时 system 行跳过），并软中断重启回流纠偏
              d.db.prepare(
                "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))"
              ).run(crypto.randomUUID(), d.taskId, `[目标偏离提醒] ${dev.reason}。核心目标是「${d.taskGoal.goal}」，请回正聚焦。`);
              // Phase B (2026-08-28 zx_1): 目标偏离实时透出（省察克治——偏离即纠，界面实时可见）
              try { eventBus.emit('task.goal_deviation', { taskId: d.taskId, task_id: d.taskId, projectId: d.projectId, goal: d.taskGoal.goal, reason: dev.reason }).catch(() => {}); } catch { /* 推送失败不影响执行 */ }
              // A1 (2026-08-31): 软中断重启回流（防持续偏离导致的死循环）
              // zx_20260910_3 M2c: 自增受 GOAL_DEVIATION_MAX_RESTARTS 约束（不再有"递增了却注定暂停"的增量）；
              // abort 恒发——由 ai-task 用**同一个**判据决定"重启(未达上限)还是交人工(已达上限)"。
              // 若把 abort 也关在守卫里，则"到上限必交人工"这条不变量就只押在"每个恢复入口都返还了额度"上，
              // 而恢复入口有 8 处（GUI 2 + IM 6）；恒发 abort 使该不变量不依赖入口的完整性。
              try {
                const gctx = JSON.parse((d.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(d.taskId) as { context_json: string } | undefined)?.context_json || '{}');
                const restarts = Number(gctx.goal_deviation_restarts) || 0;
                if (!goalDeviationCapReached(restarts)) {
                  gctx.goal_deviation_restarts = restarts + 1;
                  d.db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(gctx), d.taskId);
                }
                d.controller.abort(new Error('goal_deviation_restart'));
              } catch {}
            }
          }
        }
      } catch {}
    }

    // 知足者富：每3步检查是否已充分完成，引导早停（每任务只提示一次）
    if (!d.sufficiencyHintFired && d.stepCount % 3 === 0 && d.stepCount > 0 && d.writeToolCount > 0) {
      const delivCount = (d.db.prepare('SELECT COUNT(*) as c FROM wa_deliverables WHERE task_id = ?').get(d.taskId) as { c: number }).c;
      const hasDeliverable = realOutputEvidence(d.db, d.taskId);
      const sufficiency = checkSufficiency({
        stepIndex: d.stepCount,
        maxSteps: d.maxSteps,
        hasDeliverable,
        writeToolCount: d.writeToolCount,
      });
      if (sufficiency.isSufficient) {
        d.sufficiencyHintFired = true;
        d.db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), d.taskId, generateSufficiencyHint(sufficiency));
        // Phase B (2026-08-28 zx_1): 充分性早停实时透出（知足者富——已充分完成时提示收尾）
        try { eventBus.emit('task.execution_signal', { taskId: d.taskId, task_id: d.taskId, projectId: d.projectId, signalType: 'sufficiency', message: generateSufficiencyHint(sufficiency) }).catch(() => {}); } catch {}
      }
    }
    // A7: 末步强制产出——剩余步数≤3且无产出物时，真正移除探索类工具，强制产出
    if (d.maxSteps - d.stepCount <= 3 && d.stepCount > 0) {
      const delivCount = (d.db.prepare('SELECT COUNT(*) as c FROM wa_deliverables WHERE task_id = ?').get(d.taskId) as { c: number }).c;
      if (delivCount === 0 && d.writeToolCount === 0) {
        const OUTPUT_ONLY_TOOLS = new Set(['write_file', 'edit_file', 'create_deliverable', 'register_deliverable', 'finalize_task', 'ask_user', 'execute_command', 'read_file']);
        const removed: string[] = [];
        for (const key of Object.keys(d.toolMap)) {
          if (!OUTPUT_ONLY_TOOLS.has(key) && !d.disabledTools.has(key)) {
            d.disabledTools.add(key);
            d.disableToolGracefully(key, `工具 ${key} 已禁用，请立即用 write_file 产出文件并 finalize_task 结束任务。`);
            removed.push(key);
          }
        }
        d.db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        // zx_20260916_1 M4 (#5): 撞顶须如实告知。原文案只说"剩余步数不足3步"（事实），
        //   却不说"没做完"这一后果——模型据此收尾时会把半成品当交付，用户也从交付文本里看不出来。
        //   措辞为**条件式**：此刻尚未被截（可能还剩 1-3 步就完成），写死"已被截"即预言；
        //   真正"已被截"的断言在收口处按实际步数判定（step-budget.stepsCapReached）后进交付文本。
        ).run(crypto.randomUUID(), d.taskId, `[末步强制产出] 剩余步数不足3步（步数上限 ${d.maxSteps}，已用 ${d.stepCount}）且尚未产出。已禁用: ${removed.join(', ') || '无'}。保留: ${[...OUTPUT_ONLY_TOOLS].join(', ')}。请立即用 write_file 写入产出文件，然后 finalize_task 结束任务。**若目标未能全部完成，本次执行即是被上限所截**——须在收尾回复中如实说明未完成部分，勿视为交付完成。${d.taskGoal?.goal ? `剩余工作：${d.taskGoal.goal.slice(0, 80)}` : ''}`);
      }
    }
    // 预算追踪 + 强制执行
    try {
      const ctxJson = JSON.parse((d.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(d.taskId) as { context_json: string })?.context_json || '{}');
      ctxJson.tokens_used = d.totalTokensUsed;
      // zx_20261012_3 批二（「算得真」）：若本步数字是"估"的（provider 未回 usage），累计一步计数——
      //   事后据 `tokens_estimated_steps` 即可辨"这笔 tokens_used 里有多少是推算，而非测量"（只增，不覆盖）。
      if (estimatedStep) ctxJson.tokens_estimated_steps = (Number(ctxJson.tokens_estimated_steps) || 0) + 1;
      // Phase (2026-08-28 zx_4 修复): 每步写回 input/output token，跨执行累计正确（避免超时失败后 cost_estimate 丢失 input/output token 导致成本低估）
      if (!ctxJson.cost_estimate) ctxJson.cost_estimate = {};
      ctxJson.cost_estimate.inputTokens = d.totalPromptTokens;
      ctxJson.cost_estimate.outputTokens = d.totalCompletionTokens;
      // D1 (2026-09-04) → zx_20260910_5 M1b (X5) 订正：累计口径改为**单计数器**。
      // 原实现 `budgetAccumStart(← budget_accum 历史) + totalTokensUsed(恢复时已含历史)` 跨 resume 双计，
      // 真库实测 budget_usage_ratio 最高 20.96（2096%），令恢复过的任务开头即可能落 band 5 被禁工具
      // （疑为「反复恢复反复暂停」的成因之一）。现 totalTokensUsed 即唯一累计源，与费用侧同口径。
      const cumUsed = d.totalTokensUsed;
      const ratio = d.maxTokens > 0 ? (cumUsed / d.maxTokens) : 0;
      ctxJson.budget_usage_ratio = ratio;
      // budget_accum 保留写回（下游 legacy 版本探测 2861 行仍在读），但语义订正为「本次执行累计」
      ctxJson.budget_accum = cumUsed;
      // zx_20260910_5 M1: 费用累计——同为**单计数器**（totalCostUsed 从 cost_used 恢复为跨 resume 累计），
      // 与 token 侧同口径，不引入第二套累计语义。
      const cumCost = d.totalCostUsed;
      const costRatio = d.costGateActive && d.maxCost > 0 ? (cumCost / d.maxCost) : 0;
      ctxJson.cost_usage_ratio = costRatio;
      ctxJson.cost_used = d.totalCostUsed;
      ctxJson.cost_gate_active = d.costGateActive;
      // zx_20260910_6 M1: 来源随步进一并回写（M1 起 GUI 三分支判据之一）
      ctxJson.cost_budget_src = d.costSrc;
      d.db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), d.taskId);

      // E3 (2026-09-03): 成本闸前置 + 预算策略收敛（知止不殆）
      //  - 60%/75% 两档提前收敛（每档只提示一次，band 变化才触发，避免每步刷屏）
      //  - 95% 不禁 edit_file 一刀切：允许完成「当前进行中的原子改动」再收尾（防中途实现被卡）
      //  - 98% 硬上限：真正禁用 edit_file 并强制产出
      // zx_20260910_5 M1: Token 与费用双闸——各算各的 band，取较严者（任一先到即触发），共用同一 band/gate；
      // 触发源(bandSrc)如实标注，防消息把费用触发说成 Token 触发（名实相符）
      const prevBand = Number(ctxJson.budget_warn_band) || 1;
      const tokenBand = budgetBandOf(ratio);
      const costBand = budgetBandOf(costRatio);
      const band = Math.max(tokenBand, costBand);
      const bandSrc = costBand > tokenBand ? '费用' : costBand < tokenBand ? 'Token' : 'Token/费用';
      const bandPct = band >= 5 ? '98%以上' : band >= 4 ? '95%' : band >= 3 ? '75%' : '60%';
      // zx_20260922_1 M6（F8）: `budget_warn_band` 是**「预算到没到顶」的唯一真源**——
      //   禁用侧（下方 band>=4/band>=5 分支）与放行侧（`tools/control.ts` 的 `forcedByBudget`、
      //   本文件收口段的 `prematureEnd`）**读的都是这一个值**，谁都不许拿 `budget_usage_ratio`
      //   或 `cost_usage_ratio` 单独再判一次。病根：此前放行侧只读 Token 尺，而禁用侧读双尺取严
      //   ⇒ 费用尺爆表把工具禁光的同时，闸门判"没到顶"照常拦收口 = 夹死（真库标本 `a290ae2b`）。
      //   语义：band 4 = 95% 档（系统首次宣告"预算超限"），band 5 = 98% 档（硬上限）。
      ctxJson.budget_warn_band = band;
      const insertBudgetMsg = (text: string) => {
        d.db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), d.taskId, text);
      };
      if (band >= 5 && prevBand < 5) {
        // B2 (2026-09-03_3): 硬上限仅保留产出/收尾工具——禁 read/execute(避免大输出回传继续膨胀 context)，强制 write_file+finalize
        // zx_20260922_1 M6（F10）: 名单见 `BUDGET_HARD_STOP_TOOLS`（`escalate_to_human` 已补入）。
        const OUTPUT_ONLY_TOOLS = new Set<string>(BUDGET_HARD_STOP_TOOLS);
        const removed: string[] = [];
        for (const key of Object.keys(d.toolMap)) {
          if (!OUTPUT_ONLY_TOOLS.has(key) && !d.disabledTools.has(key)) {
            d.disabledTools.add(key);
            d.disableToolGracefully(key, `工具 ${key} 已禁用，请立即 finalize_task 结束任务。`);
            removed.push(key);
          }
        }
        // zx_20260922_1 M6（挂账 G）: `edit_file` 不在白名单，上面的通用循环已把它加进 `removed`——
        //   原写法再手工补一次 `'edit_file'` 拼文案，于是同一名字出现两次（真库标本原文可见）。
        //   此处若 `edit_file` 因**其它**闸已禁而不在 `removed`，才补进名单（只补名单、不重复拼）。
        if (d.toolMap['edit_file'] && !removed.includes('edit_file')) removed.push('edit_file');
        insertBudgetMsg(`[预算超限] ${bandSrc}已用${bandPct}(硬上限)。已禁用: ${removed.join(', ') || '无'}。保留仅: ${[...OUTPUT_ONLY_TOOLS].join(', ')}。请立即 write_file 产出结果并 finalize_task 收尾（不再允许读取/执行回传大上下文）。`);
      } else if (band >= 4 && prevBand < 4) {
        const OUTPUT_ONLY_TOOLS = new Set<string>(BUDGET_WARN_TOOLS);
        const removed: string[] = [];
        for (const key of Object.keys(d.toolMap)) {
          if (!OUTPUT_ONLY_TOOLS.has(key) && !d.disabledTools.has(key)) {
            d.disabledTools.add(key);
            d.disableToolGracefully(key, `工具 ${key} 已禁用，请收尾。`);
            removed.push(key);
          }
        }
        // zx_20260923 M4-b: 文案与名单同源——`edit_file` 之外 `create_task` 也仍在册
        //   （"把剩下的活派给子任务"是这一档仍该允许的动作），一并说给用户听。
        insertBudgetMsg(`[预算超限] ${bandSrc}已用${bandPct}。已禁用探索/改造类工具: ${removed.join(', ') || '无'}。edit_file 与 create_task 仍可用——请仅完成当前进行中的原子改动，完成后立即 write_file/finalize 收尾（如需把剩余工作拆给子任务，用 create_task）。`);
      } else if (band >= 3 && prevBand < 3) {
        // zx_20260904_6 D3 (2026-09-04): research/文档类 75% 档即禁搜索，强制"先 write_file 落产出再探索"（避免 98% 才被迫 partial）
        if (d.archetype === 'research' || d.archetype === 'document' || d.archetype === 'analysis') {
          const killKeys = ['search_content', 'search_web'].filter((k) => d.toolMap[k] && !d.disabledTools.has(k));
          for (const k of killKeys) { d.disabledTools.add(k); d.disableToolGracefully(k, `工具 ${k} 已因 75% 档(研究/文档类)硬禁用——请先用 write_file 落当前产出再收尾。`); }
          insertBudgetMsg(`[预算预警] ${bandSrc}已用${bandPct}（研究/文档类）：已禁用搜索${killKeys.length ? ': ' + killKeys.join(', ') : ''}。请立即用 write_file 落当前产出文件后再考虑是否继续；完成后 finalize。`);
        } else {
          insertBudgetMsg(`[预算预警] ${bandSrc}已用${bandPct}。请停止无关探索与反复改造，聚焦完成核心目标；进行中的文件改动完成当前原子改动后即收尾。`);
        }
      } else if (band >= 2 && prevBand < 2) {
        insertBudgetMsg(`[预算预警] ${bandSrc}已用${bandPct}。请压缩对既有步骤的理解、聚焦核心产出，避免继续无界探索。`);
      }
      d.db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), d.taskId);
    } catch {}
  };
}
