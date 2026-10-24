/**
 * Agent 执行器 — 从原工蚁 agent-engine.ts + index.ts 工具集移植。
 * 包含：模型获取 → 系统提示构建 → AI SDK + 工具集调用 → 对话记录 → 完成/失败。
 */
import type Database from 'better-sqlite3';
import { eventBus } from './event-bus.js';
import { persistTurnMessage } from './pause-settlement.js';
// zx_20260929 M9: `MAX_CHILD_BREADTH`/`countActiveChildren` 随步回调外移到 `exec-step.ts` 后此处不再引用
//   —— 但**真源仍在 `task-accounting.ts` 一处**，`exec-step.ts` 直接从那里取（不经执行体转手）。
import { writeMilestoneDone, backfillBoardRemainderToSelf, selfCompleteBan, buildChildContext, resolveAncestorSchemeRef, classifyChildCompletion, childCompletionCheckLabel, milestoneBoardOwner, goalDeviationCapReached, isPlanOrImplTask, milestoneSubjectVerdict, MAX_TASK_DEPTH, childBreadthRefusal, collectSubtreeIds, taskTreeIds } from './task-accounting.js';
import { validateReadonlyBashCommand, sanitizeLoneSurrogates, searchPathForPattern, paginateReadFile, shellRejectPayload, shellRejectPayloadForChar, buildToolConstraintBrief } from './tool-guards.js';
import { setDeliverableStatus, promoteTaskFileDeliverables, autoAssignPrimary, selectProbeDeliverables, disposeProbeDeliverables, readAcceptanceCheck, docNotProbe, findDeliverableByPath } from './deliverable-lifecycle.js';
import { parseDepIds } from './dep-graph.js';
// zx_20260917 M5-1: 「链上至多一个在跑」的唯一真源（`create_task` 与 `task-scheduler` 共用，不抄第二份）
import { childDispatchHint } from './task-chain.js';
import { readBoolSetting } from './settings-bool.js';
import { auxModelRequest, buildModelRequest, deriveModelCapabilities, readMaxCostPer1k, taskHasMedia, taskBodyChars, attachmentsNeedVision } from './model-request.js';
// zx_20260929 M9: `PAUSE_REASON_TOOL_LOOP`/`PAUSE_REASON_NO_PROGRESS` 只被步回调用 ⇒ 随之外移，真源仍在 `pause-reason.ts`。
import { PAUSE_REASON_CHILDREN_INCOMPLETE, PAUSE_REASON_CHILDREN_FAILED, PAUSE_REASON_NO_OUTPUT, PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_USER_INTERRUPT, PAUSE_REASON_AWAITING_INPUT, PAUSE_REASON_POLICY_PAUSED, PAUSE_REASON_AI_PROVIDER_FAILED, PAUSE_REASON_AI_SDK_UNAVAILABLE, PAUSE_REASON_OUTPUT_MISSING, PAUSE_REASON_AGENT_PAUSED } from './pause-reason.js';
// zx_20260923 M1：`sdk_failed` 的作用域由"任务一生"收到"**这一次事故**"（见 sdk-incident.ts 头注释）
import { hasOpenSdkIncident, openSdkIncident } from './sdk-incident.js';
// zx_20260923 M6-b：`failed` 的**唯一写手**（状态行 + 翻掉上一次 run 的判卷，见 task-terminal.ts 头注释）
import { markTaskFailed } from './task-terminal.js';
import { pauseTask } from './pause-task.js';
import { abortTaskRun, registerTaskRun, unregisterTaskRun } from './task-run-registry.js';
import { isTerminalStatus } from './task-jobs.js';
// zx_20261023_3 批一：起跑前 / 每步的停止判据收在一处（`stop-signals.ts`，零副作用）。
import { runStartRefusal } from './stop-signals.js';
import { failedChildren, childNames } from './children-gate.js';
import { buildTaskOutcome, buildCompletionAccount, goalAchievedOf, markGoalNotAchieved } from './task-outcome.js';
import { enqueueJob } from './job-enqueuer.js';
import { planSummaryChunks, buildRuleDigest, truncateHistoryTail, planSystemContextCompaction, estimateContentTokens, contentChars } from './context-compaction.js';
// zx_20260921 M8: `executeTask` 入口段（认领 / 确认门禁 / 执行前快照）已搬至 `core/exec-claim.ts`
import { claimTaskForExecution, preExecutionConfirmGate, captureSnapshotBeforeRun } from './exec-claim.js';
// zx_20261011_2 D9: 「不可交互任务不得暂停等待人工」——判据真源在零依赖的 `no-interaction.ts`（M11 语义一处）。
import { noInteractionPauseRefusal } from './no-interaction.js';
// zx_20260921 M8: `executeTask` 选型段（能力派生 / ANS 选型 / 三级降级 / 策略闸）已搬至 `core/exec-model-select.ts`
import { selectModelForTask } from './exec-model-select.js';
// zx_20260921 M8: `executeTask` 预算段（上限解析 / 保底 / 费用闸两态告知）已搬至 `core/exec-budget.ts`
import { resolveTaskBudget } from './exec-budget.js';
// zx_20260921 M8: `executeTask` 上下文装配段（系统提示骨架 / 各类感知注入 / 项目上下文 / 历史回放）已搬至 `core/exec-context.ts`
import { buildTaskContext } from './exec-context.js';
// zx_20261022_3 批十一：判卷证据面（取数/择文/渲染）移至 `exec-evidence.ts`，行为零变化。
import { collectEvidence, renderEvidence } from './exec-evidence.js';
// zx_20261018_2 批三：稳定前缀指纹（只记"可复用"，不写"缓存命中"——命中在供应商侧，本机看不到）。
import { fingerprintMessages } from './context-prefix.js';
// zx_20260921 M8: `executeTask` 的 run_close 收口段（收口三闸 + 达标收尾）已搬至 `core/exec-finalize.ts`
// zx_20260929 M9: `executeTask` 收尾段（产出充分性门禁 → 省耗并账 → 收口验收前移+完成分重算 → D1 过早结束闸
//   → 陈旧标记清理 → `finalizeRunClose` 接线）已搬至 `core/exec-close.ts`；`finalizeRunClose` 的调用点
//   随之落到该模块末尾，本文件不再直接引用它。
import { runCloseSection } from './exec-close.js';
import { createStepHandler } from './exec-step.js';
import { buildAttachmentParts } from './attachment-inline.js';
// zx_20261003 M1: 音视频产出的族判据复用附件层**同一把尺**（`familyOf`），不另抄一张扩展名表。
import { familyOf } from './attachment-kinds.js';
// zx_20260924 M7: 去向视图的映射与字段名归 `attachment-outcome.ts` 一处（renderer 引同一份，防第二份词表）。
import { toAttachmentOutcomeViews } from './attachment-outcome.js';
import { makeAudioTranscriber, transcribeTmpDirFor, cleanTranscribeTmp } from './audio-transcribe.js';
// zx_20260930 M13-4: 视频的画面那一半。落点与音轨**同一个** taskId 子目录 ⇒ `cleanTranscribeTmp`
//   一次收掉 wav 与帧（不新养一处收尾，承 `zx_20260929` M3「用完就收」）。
import { makeFrameExtractor } from './video-frames.js';
// zx_20261018_2 批二：视频全片覆盖属 Pro（`long_video`）；档位判断只此一处判完再交装配层。
import { proFeatureRefusal } from './pro-gate.js';
// zx_20261018_2 批一：`view_image` 的视觉子调用（盘上图 → 视觉模型 → 文字观察）。
//   住独立模块（零 electron 静态依赖、生成走动态 import）⇒ rr 注入桩可直跑真实现。
import { makeImageDescriber } from './image-describe.js';
import { decideAcceptanceOutcome, recordAcceptanceOutcome, recordProposedCheck, proposeAcceptanceCriteria, criteriaSourceOf, toAcceptanceSummary, acceptanceVerdictOf, capScoreByAcceptanceVerdict, UNVERIFIED_REASON_LABEL, type AcceptanceOutcome, type AcceptanceCheckPayload, type AcceptanceSummary, type AcceptanceVerdict, type ProposedCriteria } from './acceptance-check.js';
import { formatOptions, formatAwaitingInputMessage } from './im/options.js';
import type { MemoryManager, MemoryEntry } from './memory-manager.js';
import { buildMemoryContext, memoryConfTag, dropMemorySections } from './memory-context.js';
import { createLogger } from './logger.js';
// zx_20261018_1 批七「账」：七源分账 / 上下文预算 / `execution_metrics` 唯一写口。
import { ledgerFromChars, withSourceChars, type TokenLedger, type TokenChars } from './token-ledger.js';
import { applyContextBudget } from './context-budget.js';
import { writeExecutionMetrics, type TokenBreakdownRecord } from './exec-metrics.js';
import { KNOWLEDGE_INJECT_MAX_TOKENS } from './project-knowledge.js';
// zx_20261023_5 批二「省」：验收失败只**生成**不生效的 pitfall 卡（Pro 闸与状态机在模块内）。
import { recordPitfallCandidate } from './knowledge-cards.js';
// zx_20261012_3 批二（「算得真」）：字÷4 的分度走**一处真源**（core/token-estimate.ts），不各写一份。
import { estimateTokensFromChars, TOKEN_CHARS_PER_UNIT } from './token-estimate.js';
import { jsonSchema, NoSuchToolError, type CoreMessage, type ImagePart, type TextPart } from 'ai';
import { toolRegistry, ExploreQuotaLedger } from './tool-registry.js';
// zx_20261023_3 批二（越界即拒）：变更类工具清单与调用时判据的**唯一真源**。
import { WORLD_MUTATING_TOOLS, mutationGateVerdict } from './tools/mutation-gate.js';
import type { ToolDeps } from './tools/deps.js';
import { readonlyTools } from './tools/readonly.js';
import { mediaTools } from './tools/media.js';
import { writeTools, EDIT_FILE_READ_FIRST } from './tools/write.js';
import { controlTools } from './tools/control.js';
import { shellTools } from './tools/shell.js';
import { memoryTools } from './tools/memory.js';
import { resourceTools } from './tools/resource.js';
import { deviceTools } from './tools/device.js';
import { classifyArchetype, classifyArchetypeKeyword, classifyByFamilyResemblance, FAMILY_REPRESENTATIVES, getAdaptiveStrategy, ARCHETYPE_BUDGETS, applyPriorityTilt, determineExecutionMode, applyExecutionMode, assessComplexity, narrowToolFace, buildToolFaceBrief, buildUnavailableNotice, applyArchetypeFloor, type TaskArchetype } from './task-archetype.js';
import { getLearnedStrategy, naturalStrategySelection, adjustProjectStrategy, recordStrategyOutcome, getToolUsageHint, getProjectThresholds, type ExecutionMetrics } from './feedback-engine.js';
import { auditWorldConsistency, generateFactSnapshot, listFilesWrittenSince } from './world-snapshot.js';
import { resolveMaxSteps, stepsCapReached, buildStepCapNote, budgetCapReached, grantStepBudgetOnCapHit, stepCapContinuationOf, buildStepContinuationNote } from './step-budget.js';
import { resumeLedgerTotal } from './resume-ledger.js';
import { computeDiff } from './file-diff.js';
// zx_20261021_4 批一: 产出路径解析与拆解器同取一份（`output-paths.ts` 零依赖）。
import { extractExpectedOutputPaths } from './output-paths.js';
import { renderOwnedRepoEvidence } from './task-file-ledger.js';
// zx_20260929 M9: `logStepExecution` 的唯一调用点在步回调内 ⇒ 随之外移；`exec-step.ts` 直接从 `observability.js` 取。
import { evaluatePolicies } from './policy-engine.js';
import { generateTensionContext, generateContradictionContext, getTensions } from './tension-engine.js';
// zx_20260923 M2-c: 主聊天路此前**内联** `createOpenAI`（于是 `tool_choice` 删除那半兼容它没有），
// 现与旁路共用同一座工厂（`ai-provider.ts` 是 `@ai-sdk/openai` 在全仓 `src/main` 的唯一落点）。
import { createSafeProvider } from './ai-provider.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
// zx_20260916_2 M1: execSync 已从本文件清除——工具执行改走异步外壳（否则命令跑多久、主进程事件循环就被占多久）
import { runShellCommand, truncationNote } from './shell-exec.js';
// zx_20261018_1 批九「收」：策略纯函数搬至 `core/exec-strategy.ts`、上下文预组装块搬至 `core/exec-prelude.ts`。
//   定义只在新模块一处；**本文件保留同名导出**（旧调用点——受控回归脚本与既有 core 模块——不裂，
//   同 `acceptance-check` 范式）。⚠ 新代码请直接从新模块引入，别再经执行体转手。
import { EMPTY_LOOP_RUN, USD_TO_CNY_RATE, modelPriceInUsd, type LoopRun } from './exec-strategy.js';
import { buildUpstreamRequirementBlock, formatInsufficiencyReasons, mergePlanModeContext } from './exec-prelude.js';
export {
  cnyFactor, EXPLORATION_TOOLS, READ_ONLY_BASH_CMDS, isExplorationCall, isReadOnlyProbeCommand,
  countsTowardToolQuota, EMPTY_LOOP_RUN, toolCallFingerprint, fingerprintToolName, describeToolCall,
  advanceLoopRun, MIXED_SHELL_TOOLS, D3_GATE_TOOLS, isExplorationToolAlways,
  makeNonExplorationCappedTool, budgetBandOf, BUDGET_HARD_STOP_TOOLS, BUDGET_WARN_TOOLS, resolveCostBudget,
} from './exec-strategy.js';
export type { LoopRun, ToolStubLike } from './exec-strategy.js';
export {
  buildBudgetContextBlock, buildDeviationContextBlock, formatInsufficiencyReasons, mergePlanModeContext,
  truncateCtx, buildUpstreamRequirementBlock, COMPLETED_ITEMS_FILE_LIMIT, collectWrittenFiles,
  buildCompletedItemsBlock, USER_DIRECTIVE_MAX_CHARS, readRecentUserDirectives, buildUserDirectiveBlock,
} from './exec-prelude.js';
export type { WrittenFileFact } from './exec-prelude.js';

export const logger = createLogger('agent-executor');

// zx_20260910_2 M1: resolveTaskMilestoneAutoLink 已迁至 core/task-accounting.ts
// （与 writeMilestoneDone / selfCompleteBan / buildChildContext / milestoneBoardOwner 同处一份真实现，
//   使 finalize_task 与 update_task_status 共用、且受控回归可脱 electron 跑真 SQL）。

// zx_20260904_4 T2 (2026-09-04): 上下文预算水位——保守默认，受控复跑实测校准（单源常量）
// zx_20260921 M8: 三个阈值常量加了 `export`——`core/exec-context.ts` 要用它们。
//   真源**仍是本处一处**（搬迁的是调用点，不是定义），数值**一格未动**（rr_zx_20260911_5/_12 钉着 6000）。
// zx_20261018_1 批九：`truncateCtx` 已随上下文预组装块搬至 `core/exec-prelude.ts`（本文件再导出，旧调用不裂）。
export const CTX_PROJECT_MAX_CHARS = 7000;   // <project-context> 内容上限
export const CTX_MEMORY_MAX_CHARS = 6000;    // 记忆上下文块上限
export const CTX_HISTORY_TAIL_MAX_CHARS = 9000; // 有 LLM 摘要且历史尾超此值 → 仅用摘要不回放整条
const CTX_WINDOW_EST_TOKENS = 64000;  // 估算窗口（字符/4 近似 tokens）
const CTX_WARN_PCT = 0.85;            // 高水位预警线
// zx_20260904_5 D3 (2026-09-04): 命令/搜索高频探索硬停阈值（与 _3 98% 硬上限同风格；说了停就真停）
export const CONVERGE_CMD_HARD = 15;   // zx_20260929 M9：`exec-step.ts`（步回调）要读 ⇒ 加 export（真源仍在原处，不复制第二份）

/**
 * ⚠ 2026-09-21 实测：ANS 模型目录里有 `audio` 能力标记的模型（`gemini-3.1-pro/flash`）**均
 *   `enabled=0`、且 `ans_model_endpoints` 无对应行**（31 个 enabled 模型里带 audio 的 = 0）
 *   ⇒ 生产将如实落 `transcribe_failed('无 audio 能力模型可给')`。这是**能力目录的宣称没有端点兑现**，
 *   已在方案 §5 B-4 记实，**不在此处用别的模型顶替**（顶替＝假装能听）。
 *
 * 组合体 `makeAudioTranscriber` 住在 `audio-transcribe.ts`（原长在本文件，2026-09-21 就地订正搬走）：
 * 长在这里，受控回归只能照抄一份等价物来试——那证的是夹具自己。
 */



// zx_20260911_1 M1（语言游戏 / 不要想而要看）：内容门禁的判型必须由**产物本身**决定。
// 此前两条门禁各自"自选规则"——finalize 硬编码 'document'（:923），收口用任务原型（:3916）；
// 而"是不是文档"是产物的属性：看扩展名即可，不问登记标签（`type='doc'` 一词两义，见 PLAN_zx_20260911_1 §0.2）。
// 非代码扩展名回落 'document'（沿用既有默认，零削弱）——**唯配置文件除外**，见下方 M3 补的第三档。
const CODE_ARTIFACT_EXTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.kt', '.kts',
  '.sh', '.bash', '.zsh', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift',
  '.sql', '.lua', '.pl', '.r', '.scala', '.ps1', '.vue', '.svelte',
]);
// zx_20260922_1 M3（F6b）：判型此前只有「代码 / 其它」两档，凡非代码扩展名一律落 'document'——
// 于是 `pom.xml`/`application.properties`/`*.json.example` 被按**文档**量：要 ≥500 字节、要 `# 标题`、
// 要"结论/总结"。活标本（任务 `a290ae2b`）：四个真 `pom.xml` 全靠 `<description>` 里 `support` 的
// `port` 四个字母撞上 configuration 判据的 `/port/i` 才"通过"——尺子看不见真配置，只看得见一个词。
// 补第三档：配置文件既不是文档、也不是代码，按**声明式结构**量（规则见 output-validator.ts）。
const CONFIG_ARTIFACT_EXTS = new Set([
  '.xml', '.json', '.yaml', '.yml', '.toml', '.properties', '.ini', '.conf', '.cfg', '.env', '.example',
]);
/**
 * 内容门禁的**判型（怎么量）**——与"进不进集"（`isGateArtifact`）**各归各的尺**。
 *   代码扩展名 → 'code'（快检）；配置文件扩展名 → 'configuration'（快检）；
 *   `.pdf` → 'pdf'（`extractPdfText` 抽正文后走**文档** LLM 腿，见 output-validator）；
 *   音视频族 → 'media'（只做**形态核验**、如实标"未做语义校验"、永不 block）；其余 → 'document'。
 *
 * zx_20261003 M1（维特根斯坦「意义即用法」/ 管子·度量衡）: 原实现只有三档（document/code/configuration），
 *   凡非代码/配置的产出（含 PDF、音视频）一律落 `document` ⇒ 一份 PDF 会被拿**文档规则**（要 `# 标题`、
 *   要"结论/总结"）去量——但 PDF 产出**从不进内容门禁**（旧成员资格只收 `.md`），所以这档从没暴露过。
 *   M1 把成员资格放开后，PDF/音视频**必须**有各自的"怎么量"：否则放进来就是用错尺量（正是 T3 的病根换族复发）。
 *   ⚠ `.md` 仍落 'document'（`familyOf('.md')` 也是 'document'，两侧一致，不入下面的 media 支）。
 */
export function archetypeForFile(filePath: string): 'document' | 'code' | 'configuration' | 'pdf' | 'media' {
  const p = filePath || '';
  const ext = path.extname(p).toLowerCase();
  if (CODE_ARTIFACT_EXTS.has(ext)) return 'code';
  // `.env` 这类**整名即扩展名**的文件 `path.extname('.env')` 返回 ''，故须另按 basename 认。
  const base = path.basename(p).toLowerCase();
  if (CONFIG_ARTIFACT_EXTS.has(ext) || base === '.env') return 'configuration';
  if (ext === '.pdf') return 'pdf';
  // M1: 音视频族由附件层同一把尺（`familyOf`）判——`document`/`image`/`binary` 都不算 media。
  const fam = familyOf(ext);
  if (fam === 'audio' || fam === 'video') return 'media';
  return 'document';
}

/**
 * zx_20261004 M12（维特根斯坦「意义即用法」/ 管子·度量衡）: 中转请求**声明的类目**须真的锁住工具面。
 *
 * 病根（若无本函数）：M12 让 AI 终端经 ANS 派来的每件请求**按 `category` 限定工具面**（§2.9 的允诺），
 *   但任务引擎的原型是执行时**从 `title`+`description` 现算**的（`classifyArchetype`）——请求声明的类目
 *   一路丢掉，一件 `text` 请求完全可能被分类成 `code` 档跑 shell。那样"类目级限定"就是**名实不符**
 *   （声明的类目没有在求值点起作用）。
 *
 * 治法：类目 → 原型档的映射在派单侧（`node-request-worker.CATEGORY_ARCHETYPE`）算定后，写进
 *   `task.context_json.node_archetype`；此处**只读不改**——有值且是合法档位即以此为准，否则回落到
 *   原来的 `classifyArchetype`。**默认路径（无 `node_archetype`）与从前逐字同形**，故既存任务零回归。
 *
 * ⚠ 只认 `ARCHETYPE_BUDGETS` 的键（**一处真源**）——写死一张档位名单会与 `TaskArchetype` 漂开，
 *   新增档位时这里静默读不出，回落路径悄悄生效而无人知（正是"契约散两处"的病根）。
 */
export function pinnedArchetype(contextJson: unknown): TaskArchetype | null {
  if (typeof contextJson !== 'string' || contextJson.length === 0) return null;
  try {
    const ctx: unknown = JSON.parse(contextJson);
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return null;
    const v = (ctx as Record<string, unknown>).node_archetype;
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ARCHETYPE_BUDGETS, v) ? (v as TaskArchetype) : null;
  } catch { return null; }
}


// zx_20260906_2 批2 (2026-09-06): 验收证据 payload 纯函数——逐条 {criterion,passed,reason} → ctxJson.acceptance_check
// （通过项也保留 criterion 文本；拒收项带 reason），供 TaskDetail「验收标准核对」面板逐条复盘。
// zx_20260910_3 M1: 定义已迁至 core/acceptance-check.ts，与"未核验载荷"成对存放（防只改一半）；此处保留导出以免旧调用点断裂。
export { buildAcceptanceCheckPayload } from './acceptance-check.js';

// zx_20260905 批5 (2026-09-05): 质量可聚合口径——把 ctxJson.completion_quality.score 双写到 wa_tasks.quality_score 列（供 SQL 聚合均质/趋势）
export function syncQualityColumn(db: Database.Database, taskId: string): void {
  try {
    const ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as { completion_quality?: { score?: number } };
    const sc = ctx.completion_quality?.score;
    if (typeof sc === 'number' && Number.isFinite(sc)) db.prepare('UPDATE wa_tasks SET quality_score = ? WHERE id = ?').run(sc, taskId);
  } catch { /* 同步失败不阻塞 */ }
}

/**
 * zx_20260915 M4/P0-6(e): 「产出性写入」的工具名——**唯一一份**。
 *
 * 两个消费者必须读同一常量，否则"同一个概念两处各写一份"必然分家（本仓 G2 病根）：
 * ① `realOutputEvidence`（收口时"有无产出"的口径）；
 * ② 目标偏离的**写豁免**（近 5 次工具调用里有它 ⇒ 不得**仅**因此判为偏离）。
 *
 * 为什么用**工具名**而不是 `file.edited`/`file.created` **事件**做写豁免的判据：
 * ① 同一次查询既喂"加宽输入"又喂"写豁免"，输入与判据**不可能分家**；
 * ② `file.*` 是 `emit` 而非落表，emit 失败被 `.catch(()=>{})` 吞——以它为判据＝以"事件恰好没丢"为判据；
 * ③ 工具名取自**结果行**（`[write_file] {"ok":true,…}`），比"准备写"更强。
 */
export const ARTIFACT_WRITE_TOOLS: readonly string[] = ['write_file', 'edit_file', 'register_deliverable'];

/** 由上式拼出的 LIKE 链——`realOutputEvidence` 与同源判定共用，不手抄第二份 */
const ARTIFACT_WRITE_LIKES = ARTIFACT_WRITE_TOOLS.map((t) => `content LIKE '%${t}%'`).join(' OR ');

/**
 * zx_20260924_1 M9-a（循名责实）: 「产出性写入按**文件名**认得的那几类」——**唯一一份**扩展名名单。
 *
 * 它只服务一处：`assessCompletionQuality` 的**逃生门**（`research`/`document`/`analysis` 且本任务登记
 * 产出物为 0 时，问"执行体到底写没写过东西"）。此前这串名单是**内联字面量**且只认代码类，
 * 于是 `document` 类任务**天然产出 `.md`**（白名单里没有）⇒ 该分支对文档类任务几乎恒真：
 * 一份合规文档反被判"无产出物"压到 45（真库标本 `a5dfdb48`）。名单上提为命名常量，
 * 一是让它可被受控回归**按符号**引用（不按行号），二是补文档类时**一处可改**。
 *
 * ⚠ **只补文档类**（用户已裁：§4.2 V-6 取 (a)）——原九类代码扩展名**逐字未动**，
 *   新增 `md|markdown|mdx|txt|yaml|yml|json|csv|html`。评分口径（weights / cap / 45 分 / 生效的三种
 *   archetype）**一律不动**：本项只回答"写没写过东西"，不回答"写得好不好"。
 * ⚠ 刻意**不**并到 `CODE_ARTIFACT_EXTS`（`:378`）：那是**产物判型**（驱动内容门禁），成员更宽
 *   （含 `.mjs`/`.kt`/`.vue` 等）。合并等于**顺手放宽**逃生门——属 §B-11 划为"不动"的那一类。
 *   两个集合问的不是同一个问题，故各留各的。
 */
export const ARTIFACT_EDIT_EXTS: readonly string[] = [
  // 代码类（原内联字面量，逐字保留）
  'py', 'ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'java', 'sql',
  // 文档/数据类（M9-a 补；`document` 类任务的正常产出就是这些）
  'md', 'markdown', 'mdx', 'txt', 'yaml', 'yml', 'json', 'csv', 'html',
];

/**
 * **调用实参**形状：`write_file({"filePath":"…md"}`。
 * 与改造前的内联正则**逐字等价**（含"`filePath` 之后紧跟 `"}`"这条收窄），只换了扩展名集合。
 * 保留它是因为这是**历史/夹具**里出现过的形状（把实参 JSON 直接写进行内的行）。
 * ⚠ 它**不是**生产 `role='tool'` 行的形状（现形状是单行 `[edit_file] {"ok":true,"path":"…"}`，
 *   键为 `path`）——见 `toolRowShowsArtifactEdit`：单靠本正则，逃生门恒不触发。
 */
export const ARTIFACT_EDIT_EXT_RE = new RegExp(
  `(?:write_file|edit_file)\\(\\{"filePath":"[^"]+\\.(?:${ARTIFACT_EDIT_EXTS.join('|')})"\\}`,
);

/** 路径以在册扩展名**收尾**（同原判据：大小写敏感，不做顺带放宽） */
export const ARTIFACT_EDIT_EXT_END_RE = new RegExp(`\\.(?:${ARTIFACT_EDIT_EXTS.join('|')})$`);

/**
 * zx_20260924_1 M9-a **就地订正（第二次，2026-09-24 核验中照出）**：
 * 「这条工具结果行，看得出它写过一个在册扩展名的文件吗？」
 *
 * ⚠ **上一版的形状假设是错的**：本注释曾以真库"411 行"断言生产形状是
 *   `[write_file]\n{"filePath":"…md",…}`。那 411 行是用 `content LIKE '%write_file%'` 取来的，
 *   其中**两行 `filePath` 形状只占 121 行**（**2026-08-06 前**的老形状），其余是现形状（见下）。
 *   按老形状写的判据**只认得那 121 条里的 118 条**（以真函数跑真库全量 **1871** 行写入类行实测），
 *   对**现形状一行都认不出**；本项自点名的标本 `a5dfdb48` 名下 23 行**一条都不认** ⇒ 仍被压 45
 *   ⇒ **M9-a 在该标本上零效果**（老形状那 118 条全属 2026-08-06 前的存量任务，与它无关）。
 *   （该轮 b9 的 A-3/A-5 夹具照抄了这个老形状 ⇒ 套件全绿而生产零效果；本版连同夹具一并订正。）
 *
 * 生产行的**三种**形状，判据须**都**认（真库实测计数）：
 *   ① 单行 `[edit_file] {"ok":true,"path":"…api.md","replaced":1,"size":16886}` —— **1019 行**；
 *   ② 单行 `[write_file] {"ok":true,"path":"…md","size":4726,"deliverableId":…,"updated":false}` —— **291 行**；
 *      ⚠ ①②的键是 **`path`** 而不是 `filePath`——写手见 `core/tools/write.ts` 两处
 *      `return JSON.stringify({ ok: true, path: fp, … })`；故 `filePath` 在**当前**行里结构性不可能出现。
 *   ③ 两行 `[write_file]\n{"filePath":"…md","size":…,"written":true,…}` —— 历史形状，**106 + 15 行**
 *      （`write_file` 106 + `edit_file` 15；全在 2026-08-06 之前）。
 * 另认**调用实参**形状（`ARTIFACT_EDIT_EXT_RE`）——历史/夹具里出现过的第四种写法。
 *
 * ⚠ **工具名先决**（这一层不能省）：真库里 `[read_file]` 3650 行、`[search_content]` 1147 行同样带 `path` 键，
 *   `[register_deliverable]` 192 行里 154 行更是直接带 **`filePath`**（`{ok,id,name,type,filePath,deduplicated}`）；
 *   少了这一层，**读**一个 `.md` 或**注册**一件成果都会被当成"写过文件"——逃生门变成恒真。
 * ⚠ 失败行天然不认：`[edit_file] {"error":"…","hint":"…"}`（真库 69 行）不含路径键 ⇒ 无需另判 `ok`。
 *
 * 只读 `filePath`/`path` 一个键、只问扩展名——不解析路径语义、不查盘，与改造前的口径面**完全一样**。
 */
export function toolRowShowsArtifactEdit(content: string): boolean {
  if (ARTIFACT_EDIT_EXT_RE.test(content)) return true;
  // 工具名先决：整行须以写入类工具名**起头**（单行形状则其后紧接结果 JSON，两行形状则次行是 JSON）。
  const m = content.match(/^\s*\[?(?:write_file|edit_file)\]?\s*([\s\S]*)$/);
  if (!m) return false;
  try {
    const o = JSON.parse(m[1]!) as { filePath?: unknown; path?: unknown };
    const fp = typeof o.filePath === 'string' ? o.filePath : o.path;
    return typeof fp === 'string' && ARTIFACT_EDIT_EXT_END_RE.test(fp);
  } catch { return false; }
}

/** 已登记产出物的一行（`realDeliverables` 的取数形状，供调用方按需渲染） */
export interface RegisteredDeliverable { name: string; type: string; status: string; file_path: string | null }

/**
 * 本任务**自己做过的范围**的 id 集合（自身 ∪ 后代子树，**不含祖先**）——与 `taskTreeIds` 只差一支。
 *
 * zx_20261014_6 M1（道德经·自知者明 / 维特根斯坦·意义即用法）：**完成闸**问的是
 * 「**这个任务自己**交出过东西吗」，而 `taskTreeIds` 把**祖先**并进来答的却是
 * 「**这棵树**（含父辈）交出过东西吗」——两个不同的问题。
 *
 * 病根（真库实测，见 zx_20261014_6 §0.1/0.2）：某项目 `7c39678e` 下三个**一次都没跑过**的子任务
 * （0 step 事件 / 0 自有产出物 / 0 自有会话）被标 completed，却因**父**名下那 69 条产出物
 * 替它们答了「有产出」⇒ `update_task_status` 的诚实提示（`[未过成果门禁]…`）整段被跳过。
 *
 * ⚠ 与 `taskTreeIds` 的分工**不可合一**：判卷/偏离三消费者（`collectEvidence` 等）**要**看得见祖先
 * 名下的落盘文件（真标本 `9eb927bf`：子名下 0 行、文件登记在父名下——纯下行子树看不见它，
 * 见 `zx_20260917` §6.0bis-a）。故两者各留其所，**此处收窄只作用于完成闸**。
 */
export function taskOwnTreeIds(db: Database.Database, taskId: string): string[] {
  try {
    return [taskId, ...collectSubtreeIds(db, taskId)];
  } catch {
    return [taskId];
  }
}

/**
 * **「什么算交付物」的唯一一处判据**（doc 且文件此刻确在 ／ 服务类且状态在活态）。
 *
 * 三个消费者都读它，不得各写一份（本仓"同一概念两处各一把尺"的病根）：
 * ① `hasRealDeliverable`（M5b 偏离豁免的**门槛**）；
 * ② M5c 偏离判定器的**已完成项账本**（§7ter.2-1：账本第二路＝"已登记且真实落盘的产出物"）；
 * ③ **M4 判卷读面**（§6.1）——⚠ 只有一个函数，不得另建第二份"读产出物"。
 *
 * zx_20260917 M4：取数面由"本任务"扩为**整棵树**（`taskTreeIds`）。⚠ 这使 ①② 的口径**同步变宽**
 * （方案 §6.1-3-⚠⚠ 早已点名），M4 批须复跑判据 **J5 / V13c** 确认仍绿——本批**不**在此处加任何探针过滤
 * （J5 钉的正是"不得按文件名长相判"，见 §6.0bis-e/f），故 J5 的结论方向不变。
 * ⚠ 扩宽的方向是对的：父任务把活派给子任务、子任务交出了东西，那么"这棵树交出过东西"为真——
 * 从前那句"本任务没交"只在"把它与自己的树切开来问"时才成立。
 *
 * ⚠⚠ zx_20261014_6 M1 订正：**上句只对判卷/偏离三消费者成立**。取数面由**调用方**用 `scope` 声明——
 *   `'tree'`（缺省，含祖先）＝上面那三处；`'own'`（自身∪后代）＝**完成闸**。
 *   首轮把整棵树一把尺地用下去，让**祖先的产出**替子任务答了「有产出」⇒ 假完成无声通过（真库实测见方案 §0.1）。
 *   「这棵树交出过东西」与「**这个任务自己**交出过东西」是**两个问题**——同一函数不得被借去答两遍。
 */
export function realDeliverables(
  db: Database.Database,
  taskId: string,
  scope: 'tree' | 'own' = 'tree',
): RegisteredDeliverable[] {
  try {
    // zx_20261014_6 M1：**取数面由调用方声明**——`'tree'`（缺省，含祖先）＝判卷/偏离三消费者沿用；
    //   `'own'`（自身∪后代，**不含祖先**）＝完成闸（「这个任务自己交出过东西吗」）。
    //   缺省值保证既有三个消费者**逐字不变**（不写字面量的另一条路）。理由见 `taskOwnTreeIds`。
    const ids = scope === 'own' ? taskOwnTreeIds(db, taskId) : taskTreeIds(db, taskId);
    const rows = db.prepare(
      `SELECT name, type, status, file_path FROM wa_deliverables WHERE task_id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as RegisteredDeliverable[];
    return rows.filter((r) => isRealDeliverableRow(r));
  } catch { return []; }
}

function isRealDeliverableRow(r: RegisteredDeliverable): boolean {
  if (r.type === 'doc') return !!(r.file_path && fs.existsSync(r.file_path));
  if (['mcp', 'a2a', 'daemon', 'ui'].includes(r.type)) {
    return ['running', 'registered', 'stopped', 'completed'].includes(r.status);
  }
  return false;
}

/**
 * **「登记一个 doc 产出物」的唯一写口**（zx_20260917 M4·§6.1-4）。
 *
 * 三个入口共用它，**不得各写一套**——`ARTIFACT_WRITE_TOOLS` 早已把 `write_file`/`edit_file` 并列，
 * 登记口径却长期只认前者（活标本 `4870dd0b`：`alert_dashboard.py` 9 次 `edit_file`、+233 行、**零登记**）。
 * 本函数体内的两分支**逐字搬自** `write_file` 原实现（含"不夺归属"与 `forceEmit` 的差别），行为不变。
 *
 * 语义（承 zx_20260913 M2-2；zx_20260918 M1 加**类型守卫**；zx_20260923 M9 加**属主守卫**）：
 * - 该文件在**本工程**下已有 **`doc`** 登记行 ⇒ **不夺归属**（不动 `task_id`）；
 *   且**只有属主就是本次写入任务（或该行无属主）时**才把它**重写**为 `draft`——
 *   属主是**别的任务**时**不动它的状态**（详见函数体内 M9 注释；否则"已终态任务的成果"会被永久打回 draft）；
 * - 该文件已有**别种产出物**行（`daemon`/`mcp`/`a2a`/`ui`）⇒ **止**：不动它的状态、不新建第二行，只把它的 `id` 还回去；
 * - 无登记行 ⇒ 新建一行 `type='doc'`、`status='draft'` 并**发事件**（`forceEmit`）。
 *   ⚠ **不**在登记时按文件名滤探针：`write_file` 今天不滤，临时件由其**既有主人**（`selectProbeDeliverables`
 *   → `disposeProbeDeliverables`，见收口处）按同一把尺处置；这里若多滤一道，`edit_file` 就比 `write_file` 窄了
 *   ——与"二者同尺"（§6.1-4）相抵。理由详见 §6.0bis-e/f。
 */
export function ensureDocDeliverable(
  db: Database.Database,
  o: { projectId: string; taskId: string; absPath: string; displayPath: string; via: string },
): { id: string; created: boolean; ownerTaskId: string | null } {
  // zx_20260918 M1：认领前**先问它是什么**——`status` 这一列在两类行上用法不同，
  // `draft` 是 **doc 的生命周期名**，写到 `daemon`/`mcp`/`a2a`/`ui` 行上等于把运行态行改成"草稿"：
  // 既会被 `autoStartDaemons` 的复起集漏掉（从此不被拉起），又被 `isRealDeliverableRow` 除名（成果面查无此物）。
  // zx_20260928 M3: 查重语句收一处——本处口径（project 级）是**正确**的那一档，故由它迁入
  //   `deliverable-lifecycle.findDeliverableByPath` 成为全仓唯一实现，另三处（task 级/无去重）改为调它。
  const existing = findDeliverableByPath(db, { projectId: o.projectId, filePath: o.absPath });
  if (existing) {
    if (existing.type === 'doc') {
      // zx_20260923 M9（就地追加；与 G12/G16 同族：账要能自己翻篇）：
      // 本支原为**无条件**重写为 draft——任何写入都把自己碰到的 doc 翻回生命周期起点。
      // 这在两种情形下是对的：①本任务自己的产出（改了就还没交付完）；②无主的手工成果。
      // 在第三种下是**错的**：**别的任务**编辑了本任务的成果，尤其当那个属主任务**已终态**时，
      // 它再也不会跑 ⇒「已交付的成果」被**永久**打回 draft，而没有任何一条路能把它翻回来。
      // 真库标本：`2ded6c81`（completed）的 `plans/backend/20260916.md`，被 `a290ae2b`
      // 于 2026-09-23T02:30:22Z 经 edit_file 打成 draft（事件 `deliverable.status_changed`），
      // 此后既无人翻回、又恰好命中"父已 completed 而成果仍 draft"的存量核对口径。
      // "内容确实变了"这件事另有留痕（`wa_deliverable_versions` 快照 + `updated_at`），
      // 不必靠篡改属主的生命周期来表达。归属仍**不夺**（承 zx_20260913 M2-2）。
      const owner = existing.task_id;
      if (owner == null || owner === o.taskId) setDeliverableStatus(db, existing.id, 'draft', o.via);
      // zx_20261022_1 批五：**归属如实回传**。跨任务命中时不改归属（承 zx_20260913 M2-2），
      //   但调用方必须知道"这一行不是本任务的"——否则子任务名下 0 行而没有任何人晓得。
      return { id: existing.id, created: false, ownerTaskId: owner ?? null };
    }
    return { id: existing.id, created: false, ownerTaskId: existing.task_id ?? null };
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status) VALUES (?, ?, ?, 'doc', ?, ?, ?, 'draft')")
    .run(id, o.projectId, o.taskId, o.displayPath.replace(/\.\w+$/, ''), `文件: ${o.displayPath}`, o.absPath);
  setDeliverableStatus(db, id, 'draft', o.via, { forceEmit: true });
  return { id, created: true, ownerTaskId: o.taskId };
}

/** 一条 shell 命令最多补登记几个文件（**显示/落库**上限，非取数上限；超出时如实记日志） */
export const SHELL_WRITTEN_REGISTER_LIMIT = 20;

/**
 * zx_20260917 M4·§6.1-3 写面①：把**这一条 shell 命令窗口内**写出的文件补登记为 `doc` 产出物。
 *
 * 判据与边界见 `world-snapshot.ts` 的 `listFilesWrittenSince`（含"为何不截断""为何前后只采一次"）。
 * 调用方在**命令启动前**取 `sinceMs`、命令返回后调本函数——归因窗口因此是**该条命令自身**，
 * 而不是"最近 N 分钟"（§6.1-3 红线）。
 *
 * ⚠ `§6.0bis-b` 自纠：方案原文把本项挂在"`bash`/`execute_command`"两处，但 **`bash` 是只读白名单且
 * 显式拒重定向**（`validateReadonlyBashCommand`）⇒ 给它挂登记是**永不触发的死代码**。
 * 真能写的 shell 工具是 `execute_command`（不拒 `>`）与 `run_privileged`。
 */
export async function registerFilesWrittenByCommand(
  db: Database.Database,
  o: { projectId: string; taskId: string; workingDir: string; sinceMs: number; via: string },
): Promise<void> {
  try {
    const files = await listFilesWrittenSince(o.workingDir, o.sinceMs);
    if (files.length === 0) return;
    const shown = files.slice(0, SHELL_WRITTEN_REGISTER_LIMIT);
    for (const fp of shown) {
      // 单条失败只跳该条：一条坏登记不该让整轮盘点作废
      try {
        ensureDocDeliverable(db, {
          projectId: o.projectId, taskId: o.taskId, absPath: fp,
          displayPath: path.relative(o.workingDir, fp) || fp, via: o.via,
        });
      } catch { /* 单条登记失败跳过 */ }
    }
    if (files.length > shown.length) {
      // 如实记：截断了就说截断了（不冒充"就这些"）
      logger.warn(
        { taskId: o.taskId.slice(0, 8), via: o.via, found: files.length, registered: shown.length },
        '子进程落盘补登记触发上限，只登记了前若干项',
      );
    }
  } catch { /* 盘点失败不阻断命令主流程 */ }
}

/**
 * 「**交出过东西**」——原 `realOutputEvidence` 体内第一段，zx_20260917 M5b·病根⑤ **抽出**（未加新判据）。
 *
 * 抽出的理由：它与下面那半句（「**曾经拿起过笔**」）**语义强度差一个量级**——
 * 「拿起过笔」在任务**全量历史**上写过一次即定格，目标达成后它恒真（拿它当偏离豁免 ⇒ 豁免面 91.1%，
 * 等于把偏离检测关掉）；本函数要求**产出物此刻确在**（`fs.existsSync`），终身面 46/157 = 29.3%（§1.4-Ⅲ）。
 *
 * zx_20260917 M5c: 体内那段取数**上移**为 `realDeliverables`（唯一判据），本函数改为问它"有没有"
 * ——真值表逐字不变（同一谓词，原本"遇真即返"现改为"先收集再判空"）。
 *
 * ⚠ zx_20261014_6 M1：本函数**刻意**取 `realDeliverables` 的缺省 `'tree'`（含祖先）面——
 *   它是 M5b 偏离豁免的**门槛**（"这棵树交出过东西吗"），与完成闸（`realOutputEvidence`，`'own'` 面）
 *   **问的不是同一个问题**。两把尺各答各的，**不得合并**。
 */
export function hasRealDeliverable(db: Database.Database, taskId: string): boolean {
  return realDeliverables(db, taskId).length > 0;
}

// zx_20260906 批2 (2026-09-06): 真实产出证据——统一"有无产出"口径（替换此前 hasDeliverable 三处打架：
// onStepFinish 用 delivCount||writeToolCount、收口两处用 score≥60 → 空手高分被记为"有产出"污染画像）。
// 判据：doc 产出物文件已落盘 / 服务类有生命周期状态 / 代码任务有 write|edit|register_deliverable 工具调用。
// zx_20260906 批2: 导出供受控复跑断言（确定性函数，无外部副作用）
// zx_20260917 M5b·病根⑤: 改为两个子判据的**并集**（产出物 ∥ 曾调用写出工具），**对外行为逐字不变**
//   （完成闸与充分性都在消费它，收窄它即"顺手改了完成语义"，属越界）。
// zx_20261014_6 M1（自知者明）: 第一子判据的**取数面**由整棵树（含祖先）收为 `'own'`（自身∪后代）。
//   病根：完成闸问的是「**这个任务自己**交出过东西吗」，而祖先的产出**不是**它的产出——
//   真库实测：三个一次没跑的子任务因**父**名下 69 条产出物被判"有产出"，诚实提示整段被跳过（方案 §0.1）。
//   ⚠ 判卷/偏离三消费者仍走整棵树（`realDeliverables` 缺省 `'tree'`）——**两边问的不是同一个问题**。
//   ⚠ **本函数与偏离豁免（`goalDeviationExempt`）自此故意不再同尺**，理由写在这里免得后来者又合一：
//     本函数答「**这个任务自己**有没有过产出」——完成闸的**下限**，宁松勿枉（宁可让边缘情形算"有过产出"）；
//     豁免答「**够不够格免掉偏离上报**」——**门槛**，宁严勿纵。**问的不是同一个问题，故尺可以不同。**
//     （⚠ 这不构成 §1.2 那条病根（同一概念两处各一把尺）的例外：那条说的是**同一个问题**被两处各判一次。）
export function realOutputEvidence(db: Database.Database, taskId: string): boolean {
  if (realDeliverables(db, taskId, 'own').length > 0) return true;
  try {
    const t = db.prepare(`SELECT COUNT(*) c FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' AND (${ARTIFACT_WRITE_LIKES})`).get(taskId) as { c: number };
    return (t?.c ?? 0) > 0;
  } catch { return false; }
}

/**
 * zx_20260915 M4/P0-6(e): 最近 N 次**工具调用**的工具名。
 *
 * 取数面按**实测格式**写：`role='tool'` 行的正文是 `[工具名]\n{json}`，首段即工具名，
 * 首 token 为小写标识符（`[read_file]` / `[bash]` / `[edit_file]`…）。真库 8943 行。
 *
 * ⚠ 不要读成 `role='tool' AND content LIKE '[工具调用] %'`——那种行（`[工具调用] name(args)`）
 * 的 `role` 实为 `'system'`，该组合**恒 0 行**（`jobs/ai-task.ts` 的"已读文件/已搜词清单"即因此恒空，
 * 见方案 §十一 挂账 13）。此处按实测格式取，不重复那个错。
 *
 * 排序用 `rowid`（真实插入序）——`created_at` 仅秒级，分辨不了同秒多行。
 */
export function readRecentToolNames(db: Database.Database, taskId: string, limit = 5): string[] {
  try {
    const rows = db.prepare(
      "SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' ORDER BY rowid DESC LIMIT ?",
    ).all(taskId, limit) as Array<{ content?: string | null }>;
    const out: string[] = [];
    for (const r of rows) {
      const m = /^\[([a-z_][a-z0-9_]*)\]/.exec((r.content || '').trim());
      if (m) out.push(m[1]!);
    }
    return out;
  } catch { return []; }
}

/** 窗口内是否有产出性写入（写豁免判据，读同一份 `ARTIFACT_WRITE_TOOLS`） */
export function hasArtifactWrite(toolNames: readonly string[]): boolean {
  return toolNames.some((n) => ARTIFACT_WRITE_TOOLS.includes(n));
}

/**
 * 这次"目标偏离"是否**免于上报**（zx_20260917 M5b·病根⑤）——纯函数，供 rr 直跑真实现。
 *
 * 病根：判定器**不认得"活已经干完了"**。输入面是「最近 3 条 assistant 消息 + 最近 5 次工具名」，
 * 目标一旦达成并提交，其后所有**自证动作**（跑测试、回填、提交、复核）在这个输入面上都必然读作"偏离"
 * ——第二只标本交付并提交后即被两条误报送进硬停（§1.4-Ⅱ）。
 *
 * 两条豁免，各有其理：
 *  - **窗口**（`hasArtifactWrite`，近 5 次工具调用内有产出性写入）：zx_20260915 的既有行为，属**时刻性**豁免
 *    ——窗口一滑过去就失效，故"越认真收口越容易被判偏离"（收尾尾迹天然长于 5 次调用：第二只标本的
 *    `edit_file` 恰是第 6 位）；
 *  - **终身**（`hasRealDeliverable`，交出过真产出物）：本批新增。已经交出过东西的任务，不应被判为"什么都没干"。
 *    ⚠ **只此一支**——`realOutputEvidence` 的另一半（曾调用写出工具）**不采信**：它在全量历史上恒真，
 *    采信它等于把豁免面放大到 91.1%（§1.4-Ⅲ 的实测收窄，勿按旧裁定用 `realOutputEvidence` 全量）。
 *
 * ⚠ `fullDeviationInput`（回退开关 `engine.deviation_full_input`）为假时一律**不豁免**——开关关即逐字回到
 * 本轮前行为（只喂 goal、3×200、无写豁免），这是回退方案的一部分，不是又一个放水口。
 */
export function goalDeviationExempt(input: {
  fullDeviationInput: boolean;
  recentToolNames: readonly string[];
  hasRealDeliverable: boolean;
}): boolean {
  if (!input.fullDeviationInput) return false;
  return hasArtifactWrite(input.recentToolNames) || input.hasRealDeliverable;
}


/**
 * zx_20260915 P0-1（完成闸·无产出不冒充完成）：收口时若无任何真实产出证据，**不标 completed**。
 *
 * 病在"判据有、闸门没有"：assessCompletionQuality 早已把无产出压到 45 分（<60，见本文件 :5083），
 * run_close **算了出来**却径直 `UPDATE ... status='completed'`——真库 43 条 completed 任务
 * `realOutputEvidence === false`（M0 基线 §1.2）。本函数把那笔已算出的账接到"标完成"这一句之前。
 *
 * 三类豁免，各有其理而非放水：
 *  - `conversation` 原型：交付物本就是一段回话，无文件是**常态**；
 *    ⚠ zx_20261014_2 复核结论：**保留本豁免**。纯问答无产出确是常态，本条不移除；
 *      实机 E2E 照出的那处（模型明确请求人类介入却无人置停）**不在本豁免**——`escalate_to_human`
 *      已改为自身走唯一咽喉 `pauseForDecision` 置停（见 `tools/control.ts`），不再落进这条缝里。
 *  - 有子任务：父任务的产出即子任务的产出，自身无文件是**分工**；
 *  - 开关 `engine.completion_gate_no_output` 关：一键回退本轮前行为（见方案 §十二）。
 *
 * 判据与 `update_task_status` 的「不硬拦」裁定不冲突——本函数只作用于 **run_close 自动收口**，
 * 人工/编排经 `update_task_status` 的主张一律不推翻。
 *
 * 返回 true = 已拦下（调用方**必须立即 return**，不得继续标 completed）。导出供受控回归直跑真分支。
 */
export function blockNoOutputCompletion(
  db: Database.Database,
  taskId: string,
  opts: { archetype: string; runMutations?: number },
): boolean {
  let childCount = 0;
  try {
    if (!readBoolSetting(db, 'engine.completion_gate_no_output')) return false;
    if (opts.archetype === 'conversation') return false;
    childCount = (db.prepare('SELECT COUNT(*) c FROM wa_tasks WHERE parent_task_id = ?').get(taskId) as { c: number }).c;
    if (childCount > 0) return false;
    if (realOutputEvidence(db, taskId)) return false;
  } catch {
    // 判据自身读不出（库异常）时放行：闸门不得因自身故障把正常收口变成暂停
    return false;
  }
  // $.run_mutations 仅为复盘材料（区分"本轮全只读"与"写了却被删"），**不是判据**——上面已判完。
  pauseTask(db, {
    taskId,
    reason: PAUSE_REASON_NO_OUTPUT,
    note: '收口时未发现任何真实产出证据——非故障，请核验产出后处置',
    extraContext: { run_mutations: Math.max(0, Math.trunc(opts.runMutations ?? 0)) },
  });
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
    .run(crypto.randomUUID(), taskId, '[未达交付·无产出] 收口时未发现任何真实产出证据（无落盘成果物、无交付物登记、无写入类工具调用）——已暂停而非标完成。若确有产出，请核验后"恢复继续"；若确认无需产出，可"标记完成"。');
  logger.warn({ taskId: taskId.slice(0, 8), archetype: opts.archetype, childCount }, 'run_close 无真实产出证据，改置 paused 不标完成');
  return true;
}

/**
 * P0-3(c)「有失败子未处置 ⇒ 父不得收口」的**唯一动作处**（finalize / run_close 两个收口出口共用）。
 *
 * 与 `blockNoOutputCompletion` 同形：**判据**在 `children-gate.ts` 一处（含回退开关），
 * 本函数只承担"命中即置 paused + 留痕 + 告知"这一**动作**——两处出口各抄一遍动作，
 * 正是本轮要治的那种分家（且改一处忘一处时，断言会以为两处同尺）。
 *
 * 返回 true ⇒ 调用方**必须立即 return**，不得再走标完成的路。
 * 调用顺序是判据的一部分：**先失败、后未完成**——失败子同时"不在未完成集里"（failed 在终态白名单内），
 * 先问未完成就会把它静默略过（实测 02adce34 失败后 106 秒父任务照标 completed）。
 */
export function blockFailedChildrenCompletion(db: Database.Database, taskId: string): boolean {
  const failed = failedChildren(db, taskId);
  if (failed.length === 0) return false;
  const names = childNames(failed);
  pauseTask(db, {
    taskId,
    reason: PAUSE_REASON_CHILDREN_FAILED,
    note: `有 ${failed.length} 个子任务失败未处置（${names}）——须重试或人工处置后自动恢复`,
  });
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
    .run(crypto.randomUUID(), taskId, `[未收口] 有 ${failed.length} 个子任务失败未处置（${names}）——已暂停而非标完成；待其重试至完成或人工处置后自动恢复。`);
  logger.warn({ taskId: taskId.slice(0, 8), failed: failed.length }, '收口前有失败子任务未处置，改置 paused 不标完成');
  return true;
}

// zx_20260906 批2 (2026-09-06): 产出内容校验同 run 缓存——finalize 门与 run 收口两处会对同一批文件各验一遍（每文件双份校验 LLM）。
// 记录文件 size/mtimeMs，第二处命中"同文件且内容未变"即复用，不再重复付 LLM。
export function fileSig(abs: string): { size: number; mtimeMs: number } | null {
  try { const st = fs.statSync(abs); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; }
}
// zx_20260906 批2: 导出供受控复跑断言（确定性函数，无外部副作用）
export function cachedOutputValidation(ctxJson: Record<string, unknown>, abs: string): { entry: Record<string, unknown>; sigOk: boolean } | null {
  const ov = Array.isArray(ctxJson.output_validations) ? (ctxJson.output_validations as Array<Record<string, unknown>>) : [];
  const entry = ov.find(x => x.file === abs);
  if (!entry) return null;
  const sig = fileSig(abs);
  if (!sig) return { entry, sigOk: false };
  return { entry, sigOk: entry.mtimeMs === sig.mtimeMs && entry.size === sig.size };
}

// Phase 3.1: 运行中任务的中断控制器（interrupt 工具据此停止子代理/任务）
// zx_20261021_2 D1: 表已抽到零依赖模块 `task-run-registry.ts`——`task-archive.ts` 也要能按 taskId
//   中止在途执行（归档即停），而它 import 本文件即成静态环。

/**
 * zx_20260910_1 M2: 持久化「当前悬置的等待输入」到 ctxJson.awaiting_input —— 桌面任务详情页横幅的唯一真源。
 * ask_user 与门禁两条暂停路径共用（两条路径的真源必须同形，此前门禁只写会话标记、不写此字段，刷新后即丢）。
 * 每次**整体覆盖**不做字段合并，故 asked_at 恒为该次暂停的时间戳（M4 重复提交判据依赖此语义）；
 * 恢复时由 task:resume / task:respond 清除。
 *
 * zx_20260915 P0-5(d): 返回值 = 它写下的 `asked_at`（异常时 `null`）。姊妹事件 `task.awaiting_input`
 * 的 payload 从此**不自造时间戳**——自造就与库里的值分家，而 P0-5 的溯源判据正是
 * "事件的 asked_at **等于** ctx.awaiting_input.asked_at（同源，不重算）"。
 * 返回值是**纯增量**：既有调用方此前全部忽略返回值，零破坏。
 */
export function persistAwaitingInput(
  db: Database.Database,
  taskId: string,
  payload: { question: string; options: string[]; decision_type: string },
): string | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
    const actx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
    const askedAt = new Date().toISOString();
    actx.awaiting_input = { ...payload, asked_at: askedAt };
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(actx), taskId);
    return askedAt;
  } catch { /* 持久化失败不阻断暂停 */ return null; }
}

/**
 * Phase C (2026-08-28) 实时控制：中止运行中任务（真正 abort，区别于「暂停」只改状态）。
 * UI「中止」按钮与 interrupt 工具共用此函数。仅对 executing/preparing 状态有效。
 */
export function interruptTask(db: Database.Database, taskId: string): Record<string, unknown> {
  const target = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
  if (!target) return { error: '目标任务不存在' };
  if (target.status !== 'executing' && target.status !== 'preparing' && target.status !== 'running') {
    return { status: 'not_running', taskId, currentStatus: target.status };
  }
  // 先标记 paused（供 executeTask catch 识别"中断"而非"失败"），再 abort 运行中的 generateText。
  // zx_20260917 M1: 状态与事件**一并**由 `pauseTask` 落笔（因由 `user_interrupt`）。此前"事件补发由调用方负责"
  // （IPC task:pause/task:interrupt、托盘、中断工具各自 emit status_changed）——同一暂停四处各自补、
  // 漏一处即界面滞留 executing，正是 zx_20260910_1 M3 连补四个点才补齐的那种分家；现调用方**一律不再 emit**。
  pauseTask(db, { taskId, reason: PAUSE_REASON_USER_INTERRUPT });
  // zx_20261023_3 批一：**如实回报**——没有在途句柄时 abortTaskRun 返 false，此前返回值被丢弃，
  //   调用方（GUI/托盘/工具）一律以为"断了"，而执行体照跑。现在把真值带出去，并附一句"没断"的说明。
  const aborted = abortTaskRun(taskId, '被 interrupt 中断');
  return aborted
    ? { status: 'interrupted', taskId, aborted: true }
    : { status: 'interrupted', taskId, aborted: false, note: '任务已置为暂停，但此刻没有可中止的在途执行体（可能尚未起跑或已收尾）' };
}

// 技能加载/同步的记账**不在此处**：zx_20260929 M1 起归 `core/skill-registry.ts`
//（`loadAgentSkills` 按 workingDir 幂等、`syncSkillsFromAnsOnce` 只在成功时置位且失败可重试）。
// 此前这里是两枚**进程级布尔**——`_agentSkillsLoaded` 使第二个项目永远轮不上项目级 `.agents/skills`，
// `_ansSkillsSynced` 使 ANS 同步失败也永久置位（网络抖一次即本进程永不重试）。

export interface AgentContext {
  db: Database.Database;
  getAnsClient: () => Promise<{ getOptimalModel: (params: Record<string, unknown>) => Promise<Record<string, unknown>> }>;
  dataDir: string;
  /** IM 通知回调（ask_user 暂停任务时发送IM消息并登记审批）。options 为结构化选项数组——
   *  登记用真源是它，不是从展示文案反推（见 zx_20260911_2 M1 修订）。 */
  sendImAskUser?: (args: { channel: string; toUser: string; question: string; taskId: string; options?: string[] }) => Promise<void>;
  /** Phase 2.1: 记忆管理器（用于注入项目记忆到Agent上下文） */
  memory?: MemoryManager;
  /** 省耗账实(2026-09-06 zx_1 1a): 本次执行内旁路子调用(验收/内容校验/目标偏离核对)累计 token——瞬态不入库，收口并入 cost_estimate/execution_metrics */
  sideTokens?: number;
}

/** 省耗账实：把旁路子 LLM 的 token 记入执行期瞬态账本(不入库，收口统一并账，避免双计) */
export function addSideTokens(acc: { sideTokens?: number } | null | undefined, tokens: number | null | undefined): void {
  if (!acc || !tokens || tokens <= 0) return;
  acc.sideTokens = (acc.sideTokens || 0) + Math.round(tokens);
}
/** 旁路子 LLM 取不到 usage 时的字符估算(与 prelude_usage 口径一致：字÷4) */
export function estTextTokens(...texts: Array<string | null | undefined>): number {
  const len = texts.reduce((s, t) => s + (t?.length || 0), 0);
  // zx_20261012_3 批二：分度走一处真源（core/token-estimate.ts）；本处保留"空串最小 1"的旧语义
  //   （rr_zx_20260906_1_b1 的 S1 钉着 `estTextTokens('') === 1`，不可降为 0）。
  return Math.max(1, estimateTokensFromChars(len));
}
/** 读取 generateText/streamText 结果的 usage 总数（缺省回退字符估算） */
export function usageTokensOf(r: { usage?: unknown; text?: string }, promptText?: string): number {
  const u = (r as { usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }).usage;
  if (u) {
    const t = u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
    if (t > 0) return t;
  }
  return estTextTokens(promptText, r.text);
}

// zx_20260921 M8: 加 `export` 供 `core/exec-context.ts` 用（真源仍在此处）。
export const SYSTEM_PROMPT_BASE = `你是工蚁（Worker Ant），一个AI任务执行助手。高效、准确地完成用户任务。

## 核心规则
1. 先理解任务，再制定计划，最后逐步执行
2. 使用工具：write_file 写新文件、edit_file 改已有文件、read_file 读文件、execute_command 执行命令
3. 每次工具调用后分析结果再决定下一步
4. 任务完成后调用 finalize_task 并简短总结
5. 遇到不确定的情况调用 ask_user 询问
6. 不要用 execute_command 做文件操作（cat/echo/find/grep用对应工具替代）

## 代码保护铁律（违反将导致任务失败）
- 创建新文件 → write_file
- 修改已有文件 → edit_file（强制，精确替换old_string，不覆盖整个文件）
- ${EDIT_FILE_READ_FIRST}（未读过的文件会被 edit_file 拒绝，照提示先 read_file 即可）
- 永远不要用 write_file 覆盖已有文件——会删除你不理解的代码
- edit_file 的 old_string 必须在文件中唯一，匹配多处时扩大上下文
- 不确定某段代码是否该保留 → 保留它

## 待确认事项铁律（违反将导致任务失败）
- 方案/任务描述中的「待确认事项」（含"待确认/需用户确认/需决策/待答复/需核实"标记）必须通过 ask_user 向用户确认，等待用户回复后再继续
- 严禁在未获用户明确确认的情况下，自行填写"已确认"、假设用户意图、或据此修改关键参数（费率/目标/口径/阈值等）
- 遇到需要用户决策的关键参数/费率/目标/口径，先 ask_user 提问，严禁跳过

## 核实任务铁律（违反将导致任务失败）
- 核实/核查/检查类任务发现的问题（尤其是一行可修的：如 symbol 格式不匹配、配置值未更新、字段名不对齐），必须**当场主动修复**（用 edit_file/write_file），而非只写报告
- 核实发现的问题只报告不修复 = 光说不练 = 任务失败
- 复杂问题（需多步改造、需用户决策的）可写入报告并给出修复建议，但一行可修的问题必须当场修复，不得留到报告里

## 工具策略
- 目录探索用 list_files，内容搜索用 search_content，不要用命令替代
- 命令执行配额20次，浪费在cat/find/grep上会导致无法完成写入

## 完成验证规则
- 完成前必须验证产出物：Python代码用 execute_command "python3 -c 'import py_compile; py_compile.compile(...)'" 验证语法
- 文档/报告用 read_file 或 list_files 确认文件已写入且非空
- 产出物必须实际存在且非空，验证通过后再 finalize_task

## 认知边界（epistemic-rules）
你的知识截止于训练数据。遇到以下情况必须明确标注：
1. 时间敏感信息（当前日期之后的事件/版本/API状态）→ 标注 [时间敏感·需验证]
2. 需要实时验证的断言（文件是否存在、服务是否运行）→ 用工具验证后再回答
3. 基于推理而非事实的结论 → 标注 [基于推理]
4. 你完全不确定的内容 → 明确说"我不确定"并建议验证方式`;

// ====== 无为而治：流模式（连续进展→减少干预） ======
export interface FlowModeState { consecutiveProgressSteps: number; consecutiveNoProgressSteps: number; inFlow: boolean; flowStartedAt: number; hadProgressThisStep: boolean; }
const FLOW_ENTER_THRESHOLD = 3;
const FLOW_EXIT_THRESHOLD = 2;
function createFlowState(): FlowModeState {
  return { consecutiveProgressSteps: 0, consecutiveNoProgressSteps: 0, inFlow: false, flowStartedAt: 0, hadProgressThisStep: false };
}
export function evaluateFlowMode(state: FlowModeState): void {
  if (state.hadProgressThisStep) {
    state.consecutiveProgressSteps++;
    state.consecutiveNoProgressSteps = 0;
    if (!state.inFlow && state.consecutiveProgressSteps >= FLOW_ENTER_THRESHOLD) { state.inFlow = true; state.flowStartedAt = Date.now(); }
  } else {
    state.consecutiveProgressSteps = 0;
    state.consecutiveNoProgressSteps++;
    if (state.inFlow && state.consecutiveNoProgressSteps >= FLOW_EXIT_THRESHOLD) { state.inFlow = false; }
  }
  state.hadProgressThisStep = false;
}

/** 构建 AI SDK 工具集 */
export function buildTools(ctx: AgentContext, taskId: string, projectId: string, workingDir: string) {
  const { db } = ctx;

  // zx_20260930 M3-c: 「文件是否为工具模块/库而非服务入口」的真源已挪到零依赖的
  //   `core/deliverable-types.ts` 的 `isModuleFilePath`（正则一字未改），由 `core/tools/write.ts`
  //   与 `ipc/project.ipc.ts` **直接引用**。此处不再保有一份本地副本，也不再经 `ToolDeps` 注入转发。

  // Phase 2: 统一「暂停等待用户决策」——置 paused + 写系统消息 + emit 结构化 task.awaiting_input（含 decision_type/options/context）
  const pauseForDecision = (decisionType: string, question: string, options: string[] | null, context: Record<string, unknown>): string => {
    // zx_20261011_2 D9（咽喉把守·一处真源）: 不可交互任务（`no_interaction`——请求方是外部 AI 终端，无从应答）
    //   **绝不置停**。本函数是全仓**唯一**"置停等待人工"的咽喉（`approvePathWrite` / `shell.ts` 特权闸 / `ask_user` 皆经它），
    //   而这处此前**从未读** `no_interaction` ⇒ 中继任务命中路径审批即被瞬时置 `paused`，relay 轮询一见 `paused`
    //   即回 `error`（D1）⇒ A 端恒显失败、B 端其实完成（实机格②）。判据真源＝`noInteractionPauseRefusal`（M11 语义
    //   只在 `no-interaction.ts`）；命中 ⇒ 不落账、不置停，把"请自行决断"回给模型（工具结果）令其续跑。
    const pauseRefusal = noInteractionPauseRefusal(
      (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json,
      decisionType,
    );
    if (pauseRefusal) return pauseRefusal;
    // zx_20260917 M1（顺序是判据的一部分）: 三步次序为 **先落账 → 再置停（含发 status_changed）→ 后发 awaiting_input**。
    //   原序是「先置停、后落账」，置停那一步如今由 `pauseTask` 连状态事件一起发——若仍照原序，
    //   两个事件的到达次序会翻成「已暂停 → 横幅」，GUI 先见空状态的暂停卡片、后见问题横幅。
    //   新序下两事件各时刻读库都自洽（status_changed 发出时账已在库），仍守"先落库、后发事件"。
    const sysMsg = options && options.length > 0
      ? formatAwaitingInputMessage(question, options)
      : `[等待用户输入] ${question}`;
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
    ).run(crypto.randomUUID(), taskId, sysMsg);
    // zx_20260915 P0-5(d): 先落库、后发事件，事件的 asked_at 取 persistAwaitingInput 的返回值（同源，不自造）
    const askedAt = persistAwaitingInput(db, taskId, { question, options: options ?? [], decision_type: decisionType });
    // zx_20260904_5 收尾发现(2026-09-04): 持久化等待输入内容到 ctxJson——桌面"等待你的回复"横幅需展示真实问题/选项
    // zx_20260910_1 M2: 抽为 persistAwaitingInput，与门禁路径共用（两条暂停路径的真源必须同形，横幅才只认一处）
    pauseTask(db, { taskId, reason: PAUSE_REASON_AWAITING_INPUT });
    eventBus.emit('task.awaiting_input', { taskId, task_id: taskId, projectId, question, decision_type: decisionType, options: options ?? [], context, asked_at: askedAt }).catch(() => {});
    if (ctx.sendImAskUser) {
      try {
        const ctxJson = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
        if (ctxJson.channel && ctxJson.externalUser) {
          const msg = `[待回复] ${question}${options && options.length ? `\n选项: ${formatOptions(options)}` : ''}`;
          ctx.sendImAskUser({ channel: ctxJson.channel, toUser: ctxJson.externalUser, question: msg, taskId, options: options ?? undefined }).catch(() => {});
        }
      } catch { /* IM 通知失败不阻断暂停 */ }
    }
    return JSON.stringify({ status: 'paused', message: '已暂停等待用户决策', decision_type: decisionType, question, options: options ?? [] });
  };

  // 软边界文件写入审批：工作目录外普通路径经用户批准后放行，并持久化批准目录（后续同目录免询问）
  const approvePathWrite = async (resolvedPath: string): Promise<{ allowed: boolean; reason?: string; response?: string }> => {
    const dir = path.dirname(resolvedPath);
    try {
      const hit = db.prepare("SELECT 1 FROM wa_approvals WHERE project_id = ? AND kind = 'path' AND command_fingerprint = ?").get(projectId, dir);
      if (hit) return { allowed: true };
    } catch {}
    // 未持久化批准 → 实时暂停等待用户决策（Phase 2，替代「最近10条对话含"是"」文本匹配）
    try {
      const taskCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as Record<string, unknown>;
      taskCtx.pending_approval = { type: 'path', path: dir, fingerprint: dir };
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(taskCtx), taskId);
    } catch { /* 记录待审批失败不阻断暂停 */ }
    const response = pauseForDecision('path_approval', `是否允许 Agent 写入工作目录外路径「${dir}」？`, null, { path: dir });
    return { allowed: false, reason: '等待用户批准写入路径', response };
  };

  // zx_20260914 M3-1: 技能懒加载抽为**一处**（`skill` 与 `list_skills` 共用）——漏调的一方会看到空清单，
  //   而"清单为空"与"确实没技能"在返回值上不可区分；`db`/`workingDir` 已在本作用域，故用闭包不带形参。
  // zx_20260929 M1: 记账归 `skill-registry`——**按 workingDir**（不是进程级布尔），**失败不置位**。
  const ensureSkillsLoaded = async (): Promise<void> => {
    const { loadAgentSkills, syncSkillsFromAnsOnce } = await import('./skill-registry.js');
    // .agents 技能：按目录幂等（同目录不重扫、**换目录必扫**）
    try { loadAgentSkills(workingDir); } catch (e) { logger.warn(`[技能] 加载 .agents 技能失败（${workingDir}）：${(e as Error).message}`); }
    // ANS 技能：只在成功时置位；失败留痕（由 skill-registry 落笔）且**下次调用可重试**
    try {
      // zx_20260930 M9: 身份取 `resolveAnsCreds` **一处真源**（DB `wa_settings` → env → 缺省）。
      //   此前这里只读 url+key 两行 ⇒ `syncSkillsFromAns` 无从签名（secret 缺席）⇒ 恒 401。
      const { resolveAnsCreds } = await import('./ans-signed-request.js');
      await syncSkillsFromAnsOnce(resolveAnsCreds(db));
    } catch (e) { logger.warn(`[技能] 同步 ANS 技能异常（将重试）：${(e as Error).message}`); }
  };

  // zx_20260920_1 M1（管子·度量衡）: 工具定义已按 ToolCategory 机械搬迁至 `core/tools/*.ts`，
  // 本函数退化为**装配点**。依赖面由 `ToolDeps` 显式声明（原先靠隐式闭包）。
  // 键序由"按类别分片"决定，与搬迁前不同——已查证全仓无一处按序消费 `tools`（仅本文件 Object.keys(tools).length）。
  // zx_20261002 M17-①「先读后改」：本任务内模型已知内容的文件集——`read_file` 读过的、`write_file`
  //   自建的。**每次 `buildTools` 新建一份**（一次任务执行 = 一份）；`read_file`/`write_file` 入册，
  //   `edit_file` 据此设门禁。见 `tools/deps.ts` 的字段注。
  const readFiles = new Set<string>();
  const deps: ToolDeps = {
    ctx, db, taskId, projectId, workingDir, readFiles,
    pauseForDecision, approvePathWrite, ensureSkillsLoaded,
    ensureDocDeliverable, checkAcceptanceCriteria, mergePlanModeContext, syncQualityColumn,
    registerFilesWrittenByCommand, interruptTask, logger, archetypeForFile,
    formatInsufficiencyReasons, ARTIFACT_WRITE_TOOLS, realOutputEvidence, fileSig,
    addSideTokens, checkMCPRegistrationIntegrity, expectedOutputMiss, docValidationTargets,
    assessCompletionQuality, completionCapFloors,
    // zx_20261018_2 批一：视图片子调用。**懒取** ansClient——`ctx.getAnsClient()` 只在真要
    //   看图时调（对话档没有 `view_image`，多数任务一次也不会走到这里）。
    describeImage: makeImageDescriber({
      selectModel: async (req) => (await ctx.getAnsClient()).getOptimalModel(req),
    }),
  };
  return {
    ...readonlyTools(deps),
    ...mediaTools(deps),
    ...writeTools(deps),
    ...controlTools(deps),
    ...shellTools(deps),
    ...memoryTools(deps),
    ...resourceTools(deps),
    // zx_20261004 M8：第 8 路——设备类（`list_devices`/`device_status`/`device_control`；
    //   zx_20261018_1 批五另加 `device_intent`）。
    //   缺省传动在 `tools/device.ts` 内（`httpDeviceControl`），故此处不注入 `controlDevice`；
    //   受控回归直跑 `deviceTools({...deps, controlDevice: 假实现})` ⇒ 不触网。
    ...deviceTools(deps),
  };
}

/** 从 Vercel AI SDK 错误中提取 HTTP 状态码（APICallError 携带 statusCode，兼容 cause 嵌套） */
function getSdkErrorStatus(err: unknown): number {
  const e = err as { statusCode?: number; cause?: { statusCode?: number } };
  return e?.statusCode ?? e?.cause?.statusCode ?? 0;
}

/** 账户级故障判定：余额不足/鉴权失败/权限拒绝（401/402/403 或错误文案匹配）——与模型能力无关，降级重试无用，须切 provider 或暂停 */
function isAccountFatalError(err: unknown, msg: string): boolean {
  const sc = getSdkErrorStatus(err);
  if (sc === 401 || sc === 402 || sc === 403) return true;
  return /insufficient balance|insufficient_quota|invalid api key|invalid_api_key|authentication|unauthorized|forbidden|access denied|quota exceeded|credit balance|余额不足|账户余额|鉴权失败/i.test(msg);
}

/**
 * zx_20260915 P0-3(a)（**失败必带因**）: `task.failed` 载荷的一处真源——全仓三处 emit 共用
 * （本文件两处 + `jobs/ai-task` 一处）。
 *
 * 病根：失败事件长期只有 `{taskId, task_id, projectId}`，**因由一个字都不在事件里**
 * （要读 `wa_task_conversations` 的 `[执行失败]` 行才有），下游无从判定"为什么失败"。
 * 各 emit 各带一版即「同一事件类型多个形状」——正是本轮要治的分家，故收在此一处。
 *
 * `phase` 是**机器可辨的失败相**（各 emit 点自己知道、且只有它知道）：
 * `'no_output'` 质量 <20 无产出 / `'execute_error'` executeTask 收尾 catch
 * / `'ai-task'` 作业处理器 catch（执行体抛错、账上却无 failed——P0-3(b) 那一路）。
 *
 * zx_20260923 M1（T1 裁定）: 原 `'sdk'` 相位**已退场**——SDK 二次失败不再记 `failed`
 * （把外部故障记在任务头上名实不符），改由 `pauseTask(reason: ai_sdk_unavailable)` 落 `paused`，
 * 并**不再 throw**（原先抛出去会冒到收尾 catch 再发一条 `execute_error`，一次失败两条噩耗）。
 * 故从相位联合里删掉它：谁再把 `'sdk'` 传回来，**编译期就拦下**——比"数 emit 条数"更强的钉。
 *
 * 开关 `engine.failed_with_reason`（默认 true）关 ⇒ 回旧形状仅 `{taskId,…}`。
 */
export function taskFailedPayload(
  db: Database.Database,
  taskId: string,
  projectId: string,
  phase: 'no_output' | 'execute_error' | 'ai-task',
  error: string,
): Record<string, unknown> {
  return readBoolSetting(db, 'engine.failed_with_reason')
    ? { taskId, task_id: taskId, projectId, error, phase }
    : { taskId, task_id: taskId, projectId };
}

/** `task_estimate` 的**唯一形状**（两种态共用：真估 / 无样本的如实痕迹）。 */
export interface TaskEstimateTrace {
  /** 真估 = 加权平均 token；无样本 = 0（"没估"如实记 0，不冒充"估了 0"） */
  tokens: number;
  /** 同上：真估 = 加权平均步数（`resolveMaxSteps` 的右项）；无样本 = 0（退回原公式） */
  steps: number;
  /** 依据的**可用样本数**。0 = 无样本（`hasUsableTaskEstimate` 据此区分"真估过"与"没估成"） */
  basedOn: number;
  /** 无样本时那句如实说明；真估时不存在（有数据就不靠文案解释） */
  note?: string;
}

/** 无样本时的留痕文案——**唯一一处**（判据与界面都读它，不各写一句） */
export const NO_SAMPLE_ESTIMATE_NOTE = '无相似任务样本，未估时';

/**
 * zx_20260924_1 M9-b（老子「知不知，上」）: 「**这个任务到底有没有估时**」——唯一一处判据。
 *
 * 只认 `basedOn > 0`。`{steps:0, basedOn:0}` 是 M9-b 新写的**"没估成"痕迹**，
 * 它**不算**"已有估时"——否则一次性任务（建时无相似样本、后来才有）会被这条痕**永久**挡住重估，
 * 把"静默"换成"钉死"。故：有真估 ⇒ 不重估；只有空痕 ⇒ 允许再算（再算不出仍是同一条空痕）。
 */
export function hasUsableTaskEstimate(ctxJson: unknown): boolean {
  const te = (ctxJson as { task_estimate?: { basedOn?: unknown } } | null | undefined)?.task_estimate;
  return Number(te?.basedOn) > 0;
}

/**
 * zx_20260924_1 M9-b: 任务估时（相似历史任务加权平均）**唯一实现**——从 `executeTask` 体内原样抽出，
 * 抽出的唯一理由是让它可被受控回归**喂真实入参直跑**（本仓纪律：复刻一份等价逻辑来断言自己＝自我印证）。
 *
 * 治两个病（都在"静默"这一族）：
 * 1. **无样本不留痕**：从前 `weightSum === 0` 时整段什么都不写 ⇒ 用户看到任务没估时，
 *    在数据里**查不出为什么**（真库标本 `a5dfdb48`：父任务完成之后手工建的子任务，无相似样本）。
 *    现在写 `{tokens:0, steps:0, basedOn:0, note:…}` —— "没估成"与"还没跑"从此可区分。
 * 2. **反复重估**：从前无守卫，父任务跨多次 resume 重复 emit `task.estimated` **6 次**。
 *    现在 `hasUsableTaskEstimate` 为真即**整段跳过**（不写、不 emit）。
 *
 * ⚠ 权重公式与样本过滤**一字未动**（`w = similarity`；`tokens <= 0 || steps <= 0` 的样本仍被跳过；
 *   只有 `weightSum > 0` 才算得出）。本项只治"静默"与"重估"，不动估时口径。
 *
 * 返回 `status` 供调用方决定**发不发事件**（只有真估才发——`task.estimated` 的语义是"估出来了"）。
 * 失败（如库坏了）由调用方 try/catch 兜住并**记因**，本函数不自吞。
 */
export function estimateTaskBudget(
  db: Database.Database,
  o: { taskId: string; similar: ReadonlyArray<{ id: string; similarity: number }> },
): { status: 'estimated' | 'skipped_existing' | 'no_samples'; basedOn: number; tokens: number; steps: number } {
  const readCtx = (): Record<string, unknown> => {
    try {
      return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(o.taskId) as { context_json?: string } | undefined)?.context_json || '{}');
    } catch { return {}; }
  };
  const ctx = readCtx();
  if (hasUsableTaskEstimate(ctx)) {
    const prev = (ctx.task_estimate as { basedOn?: unknown }).basedOn;
    return { status: 'skipped_existing', basedOn: Number(prev) || 0, tokens: 0, steps: 0 };
  }
  /** 写痕（读改写：只动 `task_estimate` 一个键，不碰同期其他字段） */
  const writeTrace = (trace: TaskEstimateTrace): void => {
    const c = readCtx();
    c.task_estimate = trace;
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(c), o.taskId);
  };
  let weightedTokens = 0, weightedSteps = 0, weightSum = 0, validCount = 0;
  if (o.similar.length > 0) {
    const placeholders = o.similar.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, context_json FROM wa_tasks WHERE id IN (${placeholders})`).all(...o.similar.map((s) => s.id)) as Array<{ id: string; context_json: string }>;
    // 按 id 建立映射，避免 IN 查询返回顺序（按 rowid）与 similarity 排序不一致导致张冠李戴
    const ctxMap = new Map(rows.map((r) => [r.id, r.context_json]));
    for (const s of o.similar) {
      let sCtx: Record<string, unknown> = {};
      try { sCtx = JSON.parse(ctxMap.get(s.id) || '{}'); } catch { /* 忽略 */ }
      const tokens = Number(sCtx.tokens_used) || 0;
      const steps = Number((sCtx.execution_metrics as { stepsUsed?: number } | undefined)?.stepsUsed) || 0;
      if (tokens <= 0 || steps <= 0) continue;
      const w = s.similarity;
      weightedTokens += tokens * w;
      weightedSteps += steps * w;
      weightSum += w;
      validCount++;
    }
  }
  if (weightSum <= 0) {
    writeTrace({ tokens: 0, steps: 0, basedOn: 0, note: NO_SAMPLE_ESTIMATE_NOTE });
    return { status: 'no_samples', basedOn: 0, tokens: 0, steps: 0 };
  }
  const estTokens = Math.round(weightedTokens / weightSum);
  const estSteps = Math.round(weightedSteps / weightSum);
  writeTrace({ tokens: estTokens, steps: estSteps, basedOn: validCount });
  return { status: 'estimated', basedOn: validCount, tokens: estTokens, steps: estSteps };
}

export async function executeTask(
  ctx: AgentContext,
  taskId: string,
  userMessage?: string,
  options?: { maxSteps?: number; temperature?: number },
): Promise<{ content: string; steps: number; goalDeviationRestart?: boolean; sdkFailed?: boolean; sdkFatal?: boolean; sdkExhausted?: boolean; concurrencyFull?: boolean; concurrencyScope?: 'project' | 'machine' }> {
  const { db } = ctx;
  // zx_20260921 M8（重构·只动形不动义）: 入口三段（认领 / 确认门禁 / 执行前快照）已整段搬至 `core/exec-claim.ts`。
  //   行为、返回形状、事件载荷与 SQL 逐字未改；此处只剩"调它、按它的结果早退"这一层接线。
  const claim = claimTaskForExecution(db, taskId, ctx.dataDir);
  // zx_20260930 M11-1: 拒因**必须原样带出去**——`concurrency_full` 的处置是"退避重排队"，
  //   `cas_conflict` 的处置是"认账收尾"。此处若把两者都压成一句 content 就再也分不开了
  //   （调用方只能看见 `steps: 0`），任务会被当失败收掉。
  // zx_20261018_3 批四: 机器级满与项目级满同属"位子满了"（任务有效，须退避重排队），
  //   但**归因不同**——`concurrencyScope` 让调度层的日志/账如实说是哪把尺满的。
  if (!claim.claimed) {
    const concurrencyScope =
      claim.reason === 'machine_concurrency_full' ? 'machine'
      : claim.reason === 'concurrency_full' ? 'project'
      : undefined;
    return { content: claim.content, steps: 0, concurrencyFull: concurrencyScope !== undefined, concurrencyScope };
  }
  const { task, projectId, project, workingDir, title, description } = claim;

  // zx_20261023_3 批一（令下即止）：中断句柄**在认领成功之后、任何 await 之前**登记。
  //   此前它挂在 prelude 之后（原 :2093），用户在这段（原型识别/选型/记忆检索，约千行）按暂停时
  //   `abortTaskRun` 找不到句柄 ⇒ abort 静默失败、状态已 paused 而执行体照跑。实测 23 步即此。
  const controller = new AbortController();
  registerTaskRun(taskId, controller);
  const claimedStatus = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined)?.status;
  const startRefusal = runStartRefusal(claimedStatus, controller.signal.aborted);
  if (startRefusal) {
    unregisterTaskRun(taskId, controller);
    logger.info({ taskId: taskId.slice(0, 8), reason: startRefusal }, '认领后复核未通过，本次不起跑');
    return { content: `任务未起跑（${startRefusal}）`, steps: 0 };
  }

  const gateStop = await preExecutionConfirmGate({ db, taskId, projectId, title, description, workingDir, sendImAskUser: ctx.sendImAskUser });
  if (gateStop) { unregisterTaskRun(taskId, controller); return { content: gateStop.content, steps: 0 }; }

  try {
    await captureSnapshotBeforeRun(db, projectId, taskId);
  } catch (snapErr) {
    // 句柄在此已登记 ⇒ 抛错前须注销，否则 runs 表里留一条没有执行体的死句柄。
    unregisterTaskRun(taskId, controller);
    throw snapErr;
  }

  // zx_20260929 M3（用完就收）：归一化产物按**本次运行**分目录落，收口时整目录清掉。
  //   在 `try` 之前算出（`finally` 里要用同一个值，不能重算——重算就成了两处派生）。
  const transcribeTmp = transcribeTmpDirFor(taskId);

  try {
    // 0. 任务类型识别（6种原型）+ 三层策略选择（道法自然）
    // zx_20261004 M12: 中转请求声明类目 ⇒ 以此锁住原型（否则"类目级限定工具面"名实不符，见 `pinnedArchetype` 头注释）。
    //   **声明即意志**：pinned 非空时，语义修正与成功率校准**都不再推翻它**——否则声明会在求值点被悄悄改掉，
    //   与"没声明"无异。无声明 ⇒ `pinned === null`，下面三处逐字回落原路径，既存任务零回归。
    const pinned = pinnedArchetype(task.context_json);
    let rawArchetype = pinned ?? classifyArchetype(`${title} ${description}`);
    // B1 (2026-08-31): 关键词命中不覆盖，未命中才语义识别（embedding 相似度 > 阈值），失败回退词袋
    if (!pinned && ctx.memory && !classifyArchetypeKeyword(`${title} ${description}`)) {
      try {
        const semantic = await ctx.memory.classifyArchetypeByEmbedding(`${title} ${description}`, FAMILY_REPRESENTATIVES);
        if (semantic && semantic.score > 0.4) {
          rawArchetype = semantic.archetype as TaskArchetype;
          logger.info({ archetype: rawArchetype, score: semantic.score.toFixed(3) }, '任务类型(语义修正)');
        }
      } catch { /* 语义识别失败回退词袋 */ }
    }
    // Phase C: 分类模糊时用历史成功率校准（家族相似→实践论）
    const archetype = pinned ?? calibrateArchetype(db, projectId, `${title} ${description}`, rawArchetype);
    const hardcodedStrategy = getAdaptiveStrategy(archetype);

    // 三层优先级：自然涌现(历史表现) > 已学习策略 > 硬编码默认
    // 注意：maxSteps 取 max(原型默认, 学到的步数)——历史平均步数不代表上限，复杂任务不能因历史简单任务而被截断
    const naturalStrategy = naturalStrategySelection(db, projectId, archetype);
    const learnedStrategy = getLearnedStrategy(db, projectId);
    let baseStrategy = hardcodedStrategy;
    if (learnedStrategy) {
      baseStrategy = { ...hardcodedStrategy, modelStrategy: learnedStrategy.modelStrategy as typeof hardcodedStrategy.modelStrategy, temperature: learnedStrategy.temperature, maxSteps: Math.max(hardcodedStrategy.maxSteps, learnedStrategy.maxSteps) };
    }
    if (naturalStrategy) {
      baseStrategy = { ...hardcodedStrategy, modelStrategy: naturalStrategy.modelStrategy as typeof hardcodedStrategy.modelStrategy, temperature: naturalStrategy.temperature, maxSteps: Math.max(hardcodedStrategy.maxSteps, naturalStrategy.maxSteps) };
    }

    // zx_20261012_3 批四（「重活不被随机挑中」）: 形态下限——学来/涌现出来的策略若让**重活形态**
    //   落到**非确定性**（`balanced` = ANS 侧加权随机）选型上，回落到形态自带策略并**留痕**。
    //   位置刻意在 `applyPriorityTilt` **之前**：`task.priority` 是**用户显式**信号，系统不越权替他改口；
    //   这里治的是"系统自己学来的主意"（起因见 §1.2④：某项目 code 任务被 learned `balanced` 抽到弱本地模型）。
    const floor = applyArchetypeFloor(archetype, baseStrategy.modelStrategy);
    if (floor.floored) {
      const floorLine = `[策略下限] 学来的策略 ${baseStrategy.modelStrategy} 会令重活形态「${hardcodedStrategy.label}」走**随机**选型，`
        + `已回落形态自带 ${floor.modelStrategy}（非确定性策略在池子里按权重抽签，同一任务跑两次可能换模型）`;
      try {
        db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), taskId, floorLine);
      } catch { /* 记不上不阻断执行 */ }
      logger.warn({ taskId: taskId.slice(0, 8), archetype, learned: baseStrategy.modelStrategy, flooredTo: floor.modelStrategy }, floorLine);
      baseStrategy = { ...baseStrategy, modelStrategy: floor.modelStrategy as typeof baseStrategy.modelStrategy };
    }

    // 0.1 集中兵力：按任务优先级倾斜资源
    const priority = (task.priority as number) || 0;
    const tiltedStrategy = applyPriorityTilt(baseStrategy, priority);

    // 0.2 战略藐视：小任务+低优先级走快速模式
    const mode = determineExecutionMode(description, priority);
    const modeApplied = applyExecutionMode(mode, tiltedStrategy, ARCHETYPE_BUDGETS[archetype]);
    const adaptiveStrategy = modeApplied.strategy;

    // C1 (2026-09-03_1): 记录策略来源（natural 自然涌现 > learned 已学习 > default 硬编码默认）——系统自知可视
    const strategySource = naturalStrategy ? 'natural' : learnedStrategy ? 'learned' : 'default';
    try {
      const ectx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
      ectx.strategy_source = strategySource;
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ectx), taskId);
    } catch { /* 来源记录失败不影响执行 */ }

    // 0.3 合抱之木：初始复杂度评估（执行中动态升级）
    const complexityLevel = assessComplexity(description);

    // 1. 获取模型（按任务原型+优先级选择匹配策略）
    const ansClient = await ctx.getAnsClient();
    // zx_20260921 M8（重构·只动形不动义）: 选型段（能力派生 → ANS 选型 → 三级降级 → context 兜底 → 策略闸）
    //   已整段搬至 `core/exec-model-select.ts`；此处只剩接线。`hasMedia` 仍回传（下游装配附件内联要用）。
    // zx_20261012_3 批三: 把 `strategySource`（上一段 0.2 前算出的 natural/learned/default）一并送进选型段，
    //   供其落一条 `[选型]` 留痕行——此前该值只写进 `context_json`，任务详情页的会话流里看不到。
    // zx_20261018_3 批四「度」: 本任务体量 → 请求侧最小上下文窗口（标题+描述+验收+附件折算）。
    //   此前选型只按**能力类别**下限（32K）要模型，一个 60K 的活与一个 3K 的活要到的门槛一样宽。
    let taskCtxForChars: Record<string, unknown> = {};
    try { taskCtxForChars = JSON.parse((task.context_json as string) || '{}'); } catch { /* 解析失败按无附件算 */ }
    const taskChars = taskBodyChars({
      title,
      description,
      acceptance: task.acceptance_criteria,
      attachments: taskCtxForChars.attachments,
    });
    const modelPick = await selectModelForTask({ db, taskId, projectId, taskCtxJson: (task.context_json as string) || '', ansClient, archetype, modelStrategy: adaptiveStrategy.modelStrategy, strategySource, taskChars });
    if ('stopped' in modelPick) return { content: modelPick.stopped.content, steps: 0 };
    const modelResult = modelPick.modelResult;
    const hasMedia = modelPick.hasMedia;
    // 原段内的两个局部量凡下游仍要读的，一律随结果回来（形状变了、值没变）：
    // `sdkRetryCtx.attachments` 供装配附件内联，`mr.fallback` 供 SDK 失败降级。
    const sdkRetryCtx = modelPick.sdkRetryCtx;
    // zx_20260930 M10: 最终在用的模型自陈能力清单（`null` = 回包没带）——装配附件时据此拦下
    //   非视觉模型不该收的图片（`buildAttachmentParts` 的第三个参数）。
    const modelCapabilities = modelPick.modelCapabilities;
    const mr = modelResult;

    const apiKey = (modelResult.api_key as string) || 'dev-key';
    const modelName = (modelResult.model_name as string) || 'gpt-4o';
    const baseUrl = (modelResult.url as string) || 'https://api.openai.com/v1';
    const inputPricePer1k = (modelResult.input_price_per_1k as number) ?? 0;
    const outputPricePer1k = (modelResult.output_price_per_1k as number) ?? 0;
    // 单步输出上限取自 ANS 最优模型端点的 max_output_tokens（原工蚁行为），未配置回退 8192
    const maxOutputTokens = Number(modelResult.max_output_tokens) || 8192;
    // zx_20260905 批2 (2026-09-05): 上下文水位口径对齐真实模型窗口——与压缩(compactTaskConversations 用 context_window)同源，未知窗口兜底 64k
    const ctxWindowForWater = Number(modelResult.context_window) > 0 ? Number(modelResult.context_window) : CTX_WINDOW_EST_TOKENS;
    // zx_20261018_1 批七「账」：本 run 的上下文分账与裁剪账——四个收口出口都从这里取，落 `token_breakdown`。
    let ctxTokenLedger: TokenLedger | null = null;
    let ctxTokenTrim: { trimmedChars: TokenChars; budgetTokens: number; overBudget: boolean } | null = null;

    // 2. 读取用户偏好（从 wa_memories）
    let userPrefs = '';
    try {
      const proj = db.prepare('SELECT owner_id FROM wa_projects WHERE id = ?').get(projectId) as { owner_id: string } | undefined;
      const uid = proj?.owner_id || '';
      if (uid) {
        const prefs = db.prepare("SELECT content FROM wa_memories WHERE user_id = ? AND memory_type = 'semantic' AND source IN ('user_instruction','user_onboarding','user_manual') ORDER BY importance DESC LIMIT 10").all(uid) as Array<{ content: string }>;
        if (prefs.length > 0) {
          userPrefs = '\n## 用户偏好\n' + prefs.map((p, i) => `${i + 1}. ${p.content}`).join('\n');
        }
      }
    } catch {}

    // Phase B (2026-08-27 zx_2) 任务立志：供执行循环做目标偏离检测（省察克治）
    let taskGoal: { goal: string; success_criteria: string; investigate: string[] } | null = null;
    // Phase 2.1: 注入项目记忆到Agent上下文
    let memoryContext = '';
    // zx_20260911_5 M4-4（管子·度量衡）: 记忆块实际字符数 + 段数/省略段数如实记账（供界面与本轮复跑查）
    let memoryCtxMeta: { sections: number; kept: number; omitted: number; chars: number } | null = null;
    // zx_20261002 M9-③: 逐段字节账（段名:字节，仅**入文**段）——与 `memoryCtxChars` 同落水位，
    //   使"注入多、命中差"可下钻到段。空则空串（不印"0 段"占地方）。
    let memoryCtxSegmentChars = '';
    // zx_20261018_1 批七：`built` 声明在 `if (ctx.memory)` 块内，块外装配/记账要用这三项，故提到外层。
    let memoryKnowledgeText = '';
    let memoryKnowledgeInjections: Array<{ ref_id: string; chars: number }> = [];
    // zx_20261021_3 批一: 领域包段与逐包注入行（同 `built` 块内产出，块外记账要用，故提到外层）。
    let memoryDomainPackText = '';
    let memoryDomainPackInjections: Array<{ ref_id: string; chars: number }> = [];
    // zx_20261022_3 批八: 画像段与注入行（同 `built` 块内产出；块外记账/裁剪判定要用）。
    let memoryProfileText = '';
    let memoryProfileInjections: Array<{ ref_id: string; chars: number }> = [];
    // zx_20261023_5 批二: 蒸馏卡段与逐卡注入行（同上；裁剪判定亦要用它）。
    let memoryCardText = '';
    let memoryCardInjections: Array<{ ref_id: string; chars: number }> = [];
    let memoryAccessedIds: string[] = [];
    if (ctx.memory) {
      try {
        // Phase 1.1: 任务启动时生成 embedding（作为相似历史任务检索的查询向量）
        await ctx.memory.generateTaskEmbedding(taskId, projectId);
        // Phase B (2026-08-28 zx_5): 任务执行预估——基于相似历史任务加权平均 token/步骤（不打无准备之仗，实事求是：依据真实历史数据）
        // zx_20260924_1 M9-b: 判据/写痕/守卫全在 `estimateTaskBudget`（唯一实现，可被 rr 直跑）；
        //   此处只做三件"调用方才知道"的事：取样本、发事件、**如实记因**。
        try {
          const similar = ctx.memory.findSimilarTasks(projectId, taskId, 3);
          const est = estimateTaskBudget(db, { taskId, similar });
          if (est.status === 'estimated') {
            // Phase (2026-08-28 zx_5 时序修复): 预估写入后立即 emit，前端实时显示（避免 status_changed 竞态导致预估不可见）
            eventBus.emit('task.estimated', { taskId, task_id: taskId, projectId, tokens: est.tokens, steps: est.steps, basedOn: est.basedOn }).catch(() => {});
          } else if (est.status === 'no_samples') {
            // 无样本**不发** `task.estimated`（该事件的语义是"估出来了"）；但"没估成"这件事实已落
            // `task_estimate.note`（数据里可读），此处再留一行日志，使"查不到"与"没跑"可区分。
            logger.info({ taskId: taskId.slice(0, 8), projectId }, '无相似任务样本，未估时（已如实留痕）');
          } else {
            logger.info({ taskId: taskId.slice(0, 8), basedOn: est.basedOn }, '已有估时，跳过重估（跨恢复不重复预估）');
          }
        } catch (e) {
          // M9-b: **仍是 best-effort，但失败必须留痕**。为何 best-effort：估时只是"预算参考"
          //   （影响 `resolveMaxSteps` 的右项与界面上的预估徽标），它坏掉**不得顶掉整轮执行**。
          //   为何要留痕：从前这里是裸 `catch { /* 预估 best-effort */ }`，一个字不留 ——
          //   "估时抛错"与"压根没走到这一步"在数据/日志里完全无法区分（本仓「沉默不是一种」的老病）。
          logger.warn(
            { taskId: taskId.slice(0, 8), err: (e as Error)?.message },
            '任务估时失败（best-effort，不阻断执行；已如实记因）',
          );
        }
        // zx_20260905 批1 (2026-09-05): 理解预跑「三调合一」——一次 cost-optimal 预读同时产出 主要矛盾 + 立志 + 需求卡 refine（原 3 次独立预读→1 次；resume 缓存命中不再重发）
        const prelude = await ctx.memory.runTaskPrelude(taskId, projectId).catch(() => null);
        const principalContradiction = prelude?.contradiction ?? null;
        taskGoal = prelude?.goal ?? null;
        // zx_20260904_4 T3 (2026-09-04): 跨 run 去重——本次注入排除先前已注入记忆，避免多次 resume 重复整批注入
        const priorInjectedIds = new Set<string>();
        try {
          const preCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
          const arr = preCtx.injected_memory_ids as string[] | undefined;
          if (Array.isArray(arr)) for (const id of arr) priorInjectedIds.add(String(id));
        } catch { /* 忽略 */ }
        const built = buildMemoryContext(ctx.memory, projectId, taskId, principalContradiction ?? undefined, taskGoal, priorInjectedIds, CTX_MEMORY_MAX_CHARS);
        memoryContext = built.context;
        memoryCtxMeta = built.meta;
        memoryProfileText = built.profileText;
        memoryProfileInjections = built.profileInjections;
        memoryCardText = built.cardText;
        memoryCardInjections = built.cardInjections;
        memoryKnowledgeText = built.knowledgeText;
        memoryKnowledgeInjections = built.knowledgeInjections;
        memoryDomainPackText = built.domainPackText;
        memoryDomainPackInjections = built.domainPackInjections;
        memoryAccessedIds = [...built.accessedIds];
        memoryCtxSegmentChars = built.segmentChars.filter(s => s.kept).map(s => `${s.name}:${s.chars}`).join('|');
        // Phase A (2026-08-28 zx_1): 任务目标显性化——持久化目标/主要矛盾到 context_json + 透出到界面（立志可见，刷新仍可见）
        try {
          if (principalContradiction || taskGoal) {
            const goalCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
            if (principalContradiction) goalCtx.principal_contradiction = principalContradiction;
            if (taskGoal) goalCtx.task_goal = taskGoal;
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(goalCtx), taskId);
            eventBus.emit('task.goal_identified', {
              taskId, task_id: taskId, projectId,
              goal: taskGoal?.goal ?? '',
              success_criteria: taskGoal?.success_criteria ?? '',
              investigate: taskGoal?.investigate ?? [],
              principalContradiction: principalContradiction ?? '',
            }).catch(() => {});
          }
        } catch { /* 目标透出失败不影响执行主流程 */ }
        // Phase 1.1: 持久化注入的记忆 ID，供任务完成后精确反馈（从实践中来到实践中去）
        if (built.accessedIds.length > 0) {
          try {
            const tctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
            // zx_20260904_4 T3 (2026-09-04): 注入集合累计（union 先前+本次），供后续 run 排除
            const prevInjected = Array.isArray(tctx.injected_memory_ids) ? (tctx.injected_memory_ids as unknown[]).map(String) : [];
            tctx.injected_memory_ids = [...new Set([...prevInjected, ...built.accessedIds])];
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(tctx), taskId);
          } catch {}
        }
        // zx_20260930 M6: 本 run 的**真入文**集合（`memory_used_ids_run`）——「这一次用了哪几条」的唯一凭据。
        //   ⚠ 与上面那行 union **刻意分开**：union 回答"这个任务累计注入过什么"（供跨 run 排重），
        //   本键回答"**本次** run 用的是什么"（供成败归因）。拿 union 当"本次用过"正是错误归因的病根。
        //   ⚠ **每 run 覆盖、含空集**：所以不能放进上面那个 `length > 0` 的闸里——本次一条没用上就必须
        //   写成 `[]`，否则会拿上一次 run 的名单去领本次的成败（"没用的记忆"照样被强化/降权）。
        try {
          const rctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
          rctx.memory_used_ids_run = [...new Set(built.accessedIds)];
          db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(rctx), taskId);
        } catch {}
        // Phase B (2026-08-28) 缘起性空：把「任务识别依据」透出到界面（记忆注入可视化，可纠偏）
        try {
          if (built.accessedIds.length > 0) {
            const memory = ctx.memory;
            const placeholders = built.accessedIds.map(() => '?').join(',');
            const mems = db.prepare(`SELECT * FROM wa_memories WHERE id IN (${placeholders})`).all(...built.accessedIds) as MemoryEntry[];
            const taskText = memory.getTaskText(taskId);
            const memories = mems.map(m => ({
              id: m.id,
              type: m.memory_type,
              content: (m.content || '').slice(0, 120),
              confidence: Math.round(memory.confidenceOf(m) * 100),
              tag: memoryConfTag(memory, m, taskText),
              // E1 (2026-09-03_1): 召回理由（为什么注入这条）
              reason: deriveMemoryReason({ memory_type: m.memory_type, context_json: (m as unknown as { context_json?: string }).context_json }, taskText),
            }));
            eventBus.emit('task.memory_injected', { taskId, task_id: taskId, projectId, memories }).catch(() => {});
            // zx_20260906 批3 (3a): 持久化注入明细快照（沿用 context_json）——完成/刷新后前端复水注入面板，
            // 不从 live 事件丢失"本次理解用了哪些记忆/依据"（去重按 id，cap 40 防无限膨胀）
            try {
              const ic = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}') as { injected_memories?: Array<Record<string, unknown>> };
              const prev = Array.isArray(ic.injected_memories) ? ic.injected_memories : [];
              const merged = [...memories, ...prev.filter((p) => !memories.some((n) => n.id === p.id))];
              ic.injected_memories = merged.slice(0, 40);
              db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ic), taskId);
            } catch { /* 快照持久化失败不影响执行 */ }
          }
        } catch { /* 透出失败不影响执行主流程 */ }
      } catch {}
    }

    // 星星之火：注入项目成功模式（历史高效执行模式）
    let successContext = '';
    try {
      successContext = generateSuccessContext(db, projectId);
    } catch {}

    // 3. 构建对话上下文（派生：压缩边界之前行被遮蔽，摘要替代；双阈值+30%尾部+持久化）
    const { summary: historySummary, recentConversations } = await compactTaskConversations(
      db, taskId, apiKey, baseUrl, modelName, (mr.context_window as number) || 0,
    );

    // Token 预算：任务级覆盖 > 项目配置 > 任务原型默认预算(含快速模式缩减)
    // zx_20260921 M8（重构·只动形不动义）: 预算解析段（保底默认 / 费用闸两态如实告知 / 项目预算过低提示）
    //   已整段搬至 `core/exec-budget.ts`。`projCtxJson` 仍留在本地——下游 `language_game` 还要读它。
    const projCtxJson = JSON.parse((project?.context_json as string) || '{}');
    const budget = projCtxJson.budget || {};
    const { maxTokens, maxCost, costSrc, costGateActive } = resolveTaskBudget({
      db, taskId, projectBudget: budget, modeBudget: modeApplied.budget, archetype, inputPricePer1k, outputPricePer1k,
    });

    // 存储任务类型到 context_json（供前端展示 + 后续诊断）
    try {
      const taskCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
      taskCtx.archetype = archetype;
      taskCtx.archetype_label = adaptiveStrategy.label;
      taskCtx.budget_max_tokens = maxTokens;
      // zx_20260910_5 M1: 费用上限同步落 ctx（与 token 侧 budget_max_tokens 对称），供 GUI 费用水位读数
      // zx_20260910_6 M1: 未设时写 0（与"无上限"同义）；另落 cost_budget_src（'task'/'project'/'none'），
      // 供 GUI 区分「未设金额闸」与「设了但模型未定价」——两种假信息长得很像（都没有水位条），须能分辨。
      taskCtx.budget_max_cost = maxCost;
      taskCtx.cost_budget_src = costSrc;
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(taskCtx), taskId);
    } catch {}

    // 子Agent类型配置（从 context_json 读取 maxSteps/systemPrompt，由 spawn_subagent 写入）
    const subagentCtxJson = (() => { try { return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}'); } catch { return {}; } })();
    const subagentMaxSteps = (subagentCtxJson.maxSteps as number) || undefined;
    const subagentSystemPrompt = subagentCtxJson.systemPrompt as string | undefined;
    const subagentAllowTools = subagentCtxJson.allowTools as string[] | undefined;
    const subagentDenyTools = subagentCtxJson.denyTools as string[] | undefined;

    // zx_20260921 M8（重构·只动形不动义）: 上下文装配段（系统提示骨架 / 各类感知注入 / 预算说明书 /
    //   项目上下文 / 历史摘要与尾部回放）已整段搬至 `core/exec-context.ts`；此处只剩接线。
    //   ⚠ `summaryOnly` 也随结果回来——下游 `context_watermark` 要把它落库（水位分项之一）；
    //     计划表原写回传 `{ messages, projectCtx }`，实测**少一个就不够**，如实订正为三项。
    //     zx_20260930 M7-c 再添一项 `lessonsIds`（`<lessons-learned>` 真入文者，回执见下）——**如实订正为四项**。
    const { messages, projectCtx, summaryOnly, lessonsIds, sections, historyRange, stablePrefixEnd } = await buildTaskContext({
      ctx, db, taskId, projectId, project, workingDir, title, description, archetype, adaptiveStrategy,
      complexityLevel, userPrefs, memoryContext, memoryKnowledgeText,
      successContext, subagentSystemPrompt, projCtxJson,
      maxTokens, maxCost, costSrc, costGateActive, historySummary, recentConversations,
    });

    // zx_20260930 M7-c（赫布·一起激发的神经元连在一起）: `<lessons-learned>` 真入文者的**回执**。
    //   zx_20261018_3 批一: 这是**注入**（写进系统提示被模型读到），只记 `injected_count`——
    //   与 `memoryContext` 的 `accessedIds` 同路，不再冒充 `use_count`。两处记账都是**加**不是**设**，
    //   空集时本就提前返回（`recordInjection` 首行守卫），此处仍显式判空以省一次 JSON 读改写。
    //   两个 union 都必须**读现状再并**、不得整体覆写：
    //     · `injected_memory_ids` 是**跨 run 的 union**（1592 那处已写本 run 的 accessedIds，此处在其上再并）；
    //     · `memory_used_ids_run` 是**本 run 的**集（M6 语义：每 run 覆写、**含空集**）——
    //       这里并进去的正是"本 run 另有一条路真入文"，故并集才是真值；两条都空 ⇒ 仍是空集，语义未变。
    if (lessonsIds.length > 0) {
      const lessonSet = [...new Set(lessonsIds)];
      try { ctx.memory?.recordInjection(lessonSet); } catch { /* 回执 best-effort，不阻塞执行 */ }
      try {
        const rctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
        const prevInjected = Array.isArray(rctx.injected_memory_ids) ? rctx.injected_memory_ids : [];
        rctx.injected_memory_ids = [...new Set([...prevInjected, ...lessonSet])];
        const prevRun = Array.isArray(rctx.memory_used_ids_run) ? rctx.memory_used_ids_run : [];
        rctx.memory_used_ids_run = [...new Set([...prevRun, ...lessonSet])];
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(rctx), taskId);
      } catch { /* best-effort */ }
    }

    const acceptance = (task.acceptance_criteria as string) || '';
    // Phase A: 验收标准作为独立 system 消息注入（无论 userMessage 是否提供都生效）
    if (acceptance.trim()) {
      messages.push({ role: 'system', content: `[验收标准] 本任务验收标准（完成后须逐条满足，finalize 前会核对）：\n${acceptance}` });
    }
    // zx_20260904_4 T1 (2026-09-04): 需求理解卡——规则预卡 + 一次轻量提炼（ctxJson 缓存/resume 复用/失败回退规则卡）。
    // 先让模型"读懂极简卡再细读长原文"，少复述长文、少误读；"仅歧义才提示 ask_user"。
    const reqCard = await buildRequirementCard(db, taskId, title, description, acceptance, taskGoal, ctx).catch(() => null);
    if (reqCard && reqCard.content) {
      messages.push({ role: 'system', content: reqCard.content });
      if (reqCard.ambiguous) {
        messages.push({ role: 'system', content: '[需求确认] 若任务目标/产出/验收存在歧义，请第一步调用 ask_user 一次确认方向后再执行；若无歧义则直接开始。' });
      }
      logger.info({ taskId: taskId.slice(0, 8), cached: reqCard.cached, refined: reqCard.refined, ambiguous: reqCard.ambiguous }, '需求理解卡已注入');
    }
    // zx_20260906_2 批1 (2026-09-06): 层级要求入链——子任务/依赖任务在开跑前看见父级/上游要求（黑格尔"部分是整体的环节"→见全局，准→省）
    const upstreamReq = buildUpstreamRequirementBlock(db, task);
    if (upstreamReq) messages.push({ role: 'system', content: upstreamReq });

    // ═══ zx_20261018_3 批四「度」（道德经·知止 / 管子·度量衡）: 系统提示 64K 预算闸 ═══
    // 病灶（§D-6）：截断段原先在 `buildTaskContext` 返回后**立刻**执行，而验收标准 / 需求卡 / 上游要求
    //   是**之后**才注入的 system 消息 ⇒ 截断时看不见它们（按残缺集合算预算），等于"先删便宜的、
    //   再往已满的袋子里塞最贵的"；且旧实现只数**连续 system 前缀**，历史段一夹回放就停在第一条非 system 处，
    //   后面的系统块根本没进测量面。
    // 现口径：测量面 = **所有** system 消息；可删区间 = `[稳定前缀末尾, 历史段起点)`——历史与关键尾部
    //   （验收/需求卡/上游）天然在可删面外；**从区间尾部往前删**（guidance/planning/task_line 先走）。
    {
      const compactPlan = planSystemContextCompaction(messages, {
        budgetTokens: 64_000,
        optionalStart: Math.max(3, stablePrefixEnd),
        optionalEnd: historyRange.start,
      });
      if (compactPlan.removed > 0) {
        messages.splice(compactPlan.dropStart, compactPlan.removed);
        // 删的是历史段**之前**的系统块 ⇒ 历史区间与注记下标整体前移（注记仍指同一行）。
        historyRange.start -= compactPlan.removed;
        historyRange.end -= compactPlan.removed;
        if (historyRange.noteIndex >= compactPlan.dropStart) historyRange.noteIndex -= compactPlan.removed;
        logger.warn(
          { taskId: taskId.slice(0, 8), beforeTokens: compactPlan.beforeTokens, afterTokens: compactPlan.afterTokens, removed: compactPlan.removed },
          '系统提示token超预算→截断低优先级层',
        );
      }
      if (compactPlan.overBudgetAfterTrim) {
        // 可删的都删了仍超——如实告警，不声称已解决。
        logger.warn({ taskId: taskId.slice(0, 8), afterTokens: compactPlan.afterTokens }, '系统提示截断后仍超预算（可删层已尽）');
      }
    }

    const taskMessage = userMessage || `请执行任务：${title}${description ? '\n描述：' + description : ''}`;
    // zx_20260921 M2（亚里士多德·潜能与现实）: **盘上的件在此刻变成模型真能看见的内容**。
    // 此前 `context_json.attachments` 记了路径却无人读——图片进上下文只是一行文件名（病根 D2）。
    // 现在把它装配成 image/text parts，与本轮文字合成**一条** user 消息（分两条会被模型读成两轮）。
    let userContent: string | Array<TextPart | ImagePart> = taskMessage;
    // 落库用的**占位文本**：在 taskMessage 之上补每条件的去向（`[已内联图片 a.png]` 这类），
    // 但**不含 base64**。`marker` 取自 `buildAttachmentParts` 的同一份字面量，此处不重抄措辞。
    const inlineNotes: string[] = [];
    const persistNotes: string[] = [];
    if (hasMedia) {
      try {
        const items = Array.isArray(sdkRetryCtx.attachments) ? (sdkRetryCtx.attachments as unknown[]) : [];
        if (items.length > 0) {
          const { parts, outcomes } = await buildAttachmentParts(
            items,
            {
              transcribeAudio: makeAudioTranscriber(ansClient, transcribeTmp),
              // zx_20260930 M13-4: 视频的画面那一半。这里**无条件**交下去——"抽不抽"的闸在装配层
              //   （`!visionOk` ⇒ 连抽都不抽，方案 §2-M13-4 要求"依赖 M10 的按能力配图"），
              //   两处各设一道闸就会漂（"谁在读它"的老病）。
              extractFrames: makeFrameExtractor(transcribeTmp),
            },
            // zx_20260930 M10: 把**在用的模型**的能力清单交下去。缺 `vision` ⇒ 图片族一律不送进模型，
            //   逐件记 `omitted(model_lacks_vision)` 并如实告知（"已跳过 N 张，原件在哪"）。
            //   `null`（回包没带清单）转 `undefined` ⇒ **不设闸**："无从比对"不等于"不具备"。
            {
              modelCapabilities: modelCapabilities ?? undefined,
              // zx_20261018_2 批二：`long_video` 软闸——社区档仍抽 8 帧、仍覆盖前 720s，
              //   只是不把采样点摊到全片；文案由装配层按"探到的时长"如实分叉。
              longVideo: proFeatureRefusal(db, 'long_video') === null,
            },
          );
          if (parts.length > 0) userContent = [{ type: 'text', text: taskMessage }, ...parts];
          // 失败/未内联的件**逐条如实播报**（`buildAttachmentParts` 已把说明写进 markers，这里只记日志备查）。
          for (const o of outcomes) {
            if (o.status === 'failed') logger.warn({ taskId: taskId.slice(0, 8), fileName: o.fileName, family: o.family, reason: o.reason }, '附件未能内联');
            else if (o.status === 'omitted') logger.info({ taskId: taskId.slice(0, 8), fileName: o.fileName, family: o.family, reason: o.reason }, '附件未内联');
          }
          inlineNotes.push(...outcomes.filter((o) => o.status === 'inlined').map((o) => o.fileName ?? o.path));
          // 每条件的去向都落库（内联 / 省略 / 失败）——只落"成功"那些，resume 时历史里就看不出
          // "当时有一件没进去"，正是本轮病根换个地方复发。
          persistNotes.push(...outcomes.map((o) => o.marker));
          if (inlineNotes.length > 0) logger.info({ taskId: taskId.slice(0, 8), inlined: inlineNotes }, '附件已内联进上下文');
          // zx_20260924 M7: 去向**结构化落库**（`context_json.attachments_outcomes`，新键、纯追加）——
          //   上面那些 marker 只活在会话文本里，渲染层 grep 不到，用户便看不见"这次带了什么件、每件去了哪"。
          //   **只落一次、只写一个新键**：既有 `attachments` 的形状一字不动（那是入站落盘的登记，不是去向）。
          //   与 M6-a 的"如实落账"是两个出口（那条走会话/日志），此处专供 GUI 上屏。
          try {
            const views = toAttachmentOutcomeViews(outcomes);
            // 单次 json_set + 单组 path/value ⇒ 层数恒为 1，不随键值对数漂（本仓 2026-09-24 刚因
            //   "手工套娃少一层"吞过一次语法错，见 project.ipc.ts 缺陷B）。数组必须 `json(?)` 包一层。
            db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.attachments_outcomes', json(?)) WHERE id = ?")
              .run(JSON.stringify(views), taskId);
            // **写后回读**：不验就等于没写（同上那条病根——报错被 catch 吞掉，热热闹闹跑二十天没落过库）。
            const readBack = db.prepare("SELECT json_array_length(json_extract(COALESCE(context_json,'{}'), '$.attachments_outcomes')) AS n FROM wa_tasks WHERE id = ?")
              .get(taskId) as { n: number | null } | undefined;
            if ((readBack?.n ?? 0) !== views.length) {
              logger.warn({ taskId: taskId.slice(0, 8), wrote: views.length, readBack: readBack?.n ?? null }, '附件去向落库回读不符（GUI 可能看不到本次附件）');
            }
          } catch (e) {
            // 落库失败**不拖垮任务**：会话文本里那几行 marker 仍在（那才是模型看的），这里只影响 GUI 展示。
            logger.warn({ taskId: taskId.slice(0, 8), err: e instanceof Error ? e.message : String(e) }, '附件去向落库失败（仅影响 GUI 展示）');
          }
        }
      } catch (e) {
        // 装配失败**不该拖垮整条任务**（见 `buildAttachmentParts` 的"永不抛"契约，这里是兜底）。
        logger.warn({ taskId: taskId.slice(0, 8), err: e instanceof Error ? e.message : String(e) }, '附件装配异常，按纯文本继续');
        userContent = taskMessage;
      }
    }
    messages.push({ role: 'user', content: userContent });
    // zx_20260904_3 D2 + zx_20260910_1 M4: 恢复上下文单份化 + 本轮消息单写（详见 core/pause-settlement.ts）
    // ⚠ **落库只落文本**：DB 里不存 base64（否则每轮 resume 重放会把库撑爆）——
    //   图片以 `[已内联图片 <件名>]` 占位，见 `persistNotes`。
    persistTurnMessage(db, taskId, persistNotes.length > 0 ? `${taskMessage}\n${persistNotes.join('\n')}` : taskMessage);

    // 3. 构建工具集
    // zx_20260914 M3-3: 前移至此——水位要落**工具 schema 的体积分项**（toolsChars/toolsCount），
    //   而它原本在下面几步之后才构造。本函数构造期无副作用（仅闭包定义 + return 字面量），故前移不改行为。
    const tools = buildTools(ctx, taskId, projectId, workingDir);

    // zx_20260920_1 M2（管子·度量衡）: 本档工具面（**纯计算**，真删在下面 `toolMap` 处）。
    //   放这里而非水位 try 块内，是因为它同时要被"水位计量"和"装配点删除"两处用。
    // zx_20261023_2 批一: 子代理的显式 allow-list 参与收窄——否则形态表先删掉 `execute_command`，
    //   后面的白名单无物可留（`restored` 即被这一步救回来的工具名）。
    const toolFace = narrowToolFace(archetype, tools as unknown as Record<string, unknown>,
      subagentAllowTools ? { allowTools: subagentAllowTools } : undefined);
    const toolsCharsAfter = JSON.stringify(Object.fromEntries(toolFace.kept.map((k) => [k, (tools as unknown as Record<string, unknown>)[k]]))).length;

    // ═══ zx_20261018_1 批七「账」（道德经·知止 / 管子·度量衡）：七源分账 + 最小 token 的裁法 ═══
    // 七源：system/memory/knowledge/history/tools/user/output。装配段已回传前四源，此处补 tools/user，
    //   output 在执行结束后由收口出口填（见 `ctxTokenBreakdown`）。超预算按 knowledge → memory → history 裁，
    //   user/acceptance/system/tools/output **一个字符都不裁**（R-56）；每源裁掉的字符落账（R-57）。
    {
      // 装配之后追加的 system 消息（验收标准 / 需求卡 / 上游要求）计入 system 源；user 消息单列。
      let systemExtraChars = 0;
      for (let i = historyRange.end; i < messages.length; i++) {
        if (messages[i]!.role === 'system') systemExtraChars += contentChars(messages[i]!.content);
      }
      const userChars = contentChars(userContent);
      const preTrimChars = {
        system: sections.system + systemExtraChars,
        memory: sections.memory,
        knowledge: sections.knowledge,
        history: sections.history,
        tools: toolsCharsAfter,
        user: userChars,
        output: 0,
      };
      // 预算 = 模型真实窗口 × 既有高水位线（与 `waterPct` 同一把尺）；七源上限用既有常量派生，不另立阈值。
      const budgetTokens = Math.max(1, Math.floor(ctxWindowForWater * CTX_WARN_PCT));
      const capsTokens = {
        knowledge: KNOWLEDGE_INJECT_MAX_TOKENS,
        memory: estimateTokensFromChars(CTX_MEMORY_MAX_CHARS),
        history: estimateTokensFromChars(CTX_HISTORY_TAIL_MAX_CHARS),
        system: estimateTokensFromChars(CTX_PROJECT_MAX_CHARS),
      };
      const budget = applyContextBudget({ chars: preTrimChars, budgetTokens, capsTokens });

      // 裁知识：整节移除（`knowledgeText` 是记忆块里的一整段），实裁字符如实记。
      let knowledgeRemoved = 0;
      const memoryMsgIndex = memoryContext
        ? messages.findIndex((m) => m.role === 'system' && m.content === memoryContext)
        : -1;
      if (budget.trimmedChars.knowledge > 0 && memoryMsgIndex >= 0 && memoryKnowledgeText) {
        const before = String(messages[memoryMsgIndex]!.content ?? '');
        const after = before.replace(memoryKnowledgeText, '').replace(/\n{3,}/g, '\n\n').trim();
        knowledgeRemoved = Math.max(0, before.length - after.length);
        messages[memoryMsgIndex] = { role: 'system', content: after };
      }
      // 裁记忆：按段优先级整段丢（high 永不丢，至少留一段），实裁字符由真源回传。
      let memoryRemoved = 0;
      if (budget.trimmedChars.memory > 0 && memoryMsgIndex >= 0) {
        const before = String(messages[memoryMsgIndex]!.content ?? '');
        const dropped = dropMemorySections(before, budget.trimmedChars.memory);
        memoryRemoved = dropped.trimmedChars;
        if (memoryRemoved > 0) messages[memoryMsgIndex] = { role: 'system', content: dropped.context };
      }
      // 裁历史：从最早一条起丢（先丢回放行、再丢注记行；`noteIndex` 那行留着如实交代）。
      let historyRemoved = 0;
      if (budget.trimmedChars.history > 0 && historyRange.end > historyRange.start) {
        const need = budget.trimmedChars.history;
        const drop = new Set<number>();
        const eligible: number[] = [];
        for (let i = historyRange.start; i < historyRange.end; i++) {
          if (i !== historyRange.noteIndex && messages[i]!.role !== 'system') eligible.push(i);
        }
        for (let i = historyRange.start; i < historyRange.end; i++) {
          if (i !== historyRange.noteIndex && messages[i]!.role === 'system') eligible.push(i);
        }
        for (const i of eligible) {
          if (historyRemoved >= need) break;
          historyRemoved += contentChars(messages[i]!.content);
          drop.add(i);
        }
        if (drop.size > 0) {
          const kept: CoreMessage[] = [];
          for (let i = 0; i < messages.length; i++) if (!drop.has(i)) kept.push(messages[i]!);
          messages.length = 0;
          messages.push(...kept);
        }
      }

      const finalChars = {
        system: sections.system + systemExtraChars,
        memory: Math.max(0, sections.memory - memoryRemoved),
        knowledge: Math.max(0, sections.knowledge - knowledgeRemoved),
        history: Math.max(0, sections.history - historyRemoved),
        tools: toolsCharsAfter,
        user: userChars,
        output: 0,
      };
      ctxTokenLedger = ledgerFromChars(finalChars);
      ctxTokenTrim = {
        trimmedChars: { ...budget.trimmedChars, knowledge: knowledgeRemoved, memory: memoryRemoved, history: historyRemoved },
        budgetTokens,
        overBudget: ctxTokenLedger.totalTokens > budgetTokens,
      };
      if (ctxTokenTrim.overBudget) {
        logger.warn({ taskId: taskId.slice(0, 8), totalTokens: ctxTokenLedger.totalTokens, budgetTokens }, '上下文裁剪后仍超预算（不可裁的源本身即超）');
      }

      // 注入账：只有真留在上下文里的才记账（被预算整节裁掉的知识不写"注入"）。
      try {
        if (ctx.memory) {
          const memoryIds = [...new Set([...memoryAccessedIds, ...lessonsIds])];
          const knowledgeRows = knowledgeRemoved > 0 ? [] : memoryKnowledgeInjections;
          // zx_20261021_3 批一: 领域包同理——只有**真留在上下文里**的包才记账。
          //   裁剪后回读记忆块：整段被 `dropMemorySections` 丢掉 ⇒ 零行（不写"注入过"的空账）。
          const memTextAfterTrim = memoryMsgIndex >= 0 ? String(messages[memoryMsgIndex]!.content ?? '') : '';
          const domainPackRows = memoryDomainPackText && !memTextAfterTrim.includes(memoryDomainPackText)
            ? []
            : memoryDomainPackInjections;
          // zx_20261022_3 批八: 画像同理——裁剪后回读，整段被丢 ⇒ 零行。
          const profileRows = memoryProfileText && !memTextAfterTrim.includes(memoryProfileText)
            ? []
            : memoryProfileInjections;
          // zx_20261023_5 批二: 蒸馏卡同理——逐卡一行，整段被裁掉 ⇒ 零行。
          const cardRows = memoryCardText && !memTextAfterTrim.includes(memoryCardText)
            ? []
            : memoryCardInjections;
          ctx.memory.recordContextInjections(taskId, {
            knowledge: knowledgeRows,
            memoryIds,
            domainPacks: domainPackRows,
            profiles: profileRows,
            cards: cardRows,
          });
        }
      } catch { /* 注入账 best-effort，不阻塞执行 */ }
    }

    // zx_20260904_4 T2 (2026-09-04): 上下文预算水位估算与落库（供 T5 实时可见与高水位预警）
    let ctxAssembledChars = 0;
    let estTokens = 0; // zx_20260904_7 I1: 预估 token（task.estimated），供 estBiasPct
    try {
      // zx_20260921 M2: 用 `contentChars` 而非 `String(m.content).length`——数组 content 后者恒得 15（`[object Object]`）。
      ctxAssembledChars = messages.reduce((a, m) => a + contentChars(m.content), 0);
      const approxTokens = estimateTokensFromChars(ctxAssembledChars);
      const waterPct = Math.min(100, Math.round((approxTokens / ctxWindowForWater) * 100));
      const latestCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
      estTokens = Number((latestCtx.task_estimate as { tokens?: number } | undefined)?.tokens) || 0;
      // zx_20260914 M3-3: 工具 schema 分项计量（JSON.stringify 丢弃函数 ⇒ 恰是随请求下发的 schema 体积）。
      //   口径 = **子代理 allow/deny 过滤前**的完整工具集，故与 TOOL_METAS 同尺、可跨轮比较
      //   （记过滤后的子集则与元数据表不可比，作为"裁剪基数"反而失真）。
      //   **不入 approxTokens/waterPct**——纳入会改变高水位预警触发点，属改语义（D4 裁定：本轮不纳入）。
      //   用途如实：它是下一轮"按任务原型裁剪工具集"的基数，本轮由 rr/baseline 消费，不上屏。
      const toolsCount = Object.keys(tools).length;
      const toolsChars = JSON.stringify(tools).length;
      // zx_20260920_1 M2（管子·度量衡）: 工具面按形态分档的**收窄后**计量。
      //   上面 `toolsCount`/`toolsChars` 是"子代理过滤前的完整集"口径（跨轮可比，**不动**）；
      //   这一对（函数顶部算出）才是本轮的收窄证据——上一轮那句注释写的就是"它是下一轮『按任务原型
      //   裁剪工具集』的基数"，本轮正是那个下一轮：不补计量，收窄在生产里就**不可观测**。
      // zx_20260930 M7-b（管子·度量衡）: `meta.chars` 此前**算完即扔**——`buildMemoryContext` 为它
      //   改了账（把省略注记也计入），却没有任何读点（"修了但没人用"= 上轮 M4 的账白改）。此处补它的消费者：
      //   `memoryCtxCharsAccounted` 直接落 `meta.chars`。**与 `memoryCtxChars` 并列而不替换**——
      //   后者是**真入上下文**的字符数（waterPct 那套水位语义要的是真体积，不能缩），前者是**产者自记的账**。
      //   两者之差恰为包裹开销（`<memory-context>` 标签 + 引言）⇒ 这个"账实差"从此可查：
      //   M7-a 撤掉装配层那道按位闸之前，它可能是个大数（按位截断的长度不计入账）；此后恒为定值。
      latestCtx.context_watermark ={ approxTokens, waterPct, toolsCount, toolsChars, toolsCountAfter: toolFace.kept.length, toolsCharsAfter, toolFace: archetype, summaryOnly, projectCtxChars: projectCtx.length, memoryCtxChars: (memoryContext || '').length, memoryCtxCharsAccounted: memoryCtxMeta?.chars ?? 0, memoryCtxSections: memoryCtxMeta?.sections ?? 0, memoryCtxKept: memoryCtxMeta?.kept ?? 0, memoryCtxOmitted: memoryCtxMeta?.omitted ?? 0, memoryCtxSegmentChars,
        // zx_20261018_1 批七：七源分账 + 裁剪账（与 `execution_metrics.token_breakdown` 同一形状的源头）。
        tokenBreakdown: ctxTokenLedger && ctxTokenTrim ? { ...ctxTokenLedger, trimmedChars: ctxTokenTrim.trimmedChars, budgetTokens: ctxTokenTrim.budgetTokens, overBudget: ctxTokenTrim.overBudget } : undefined };
      // zx_20260904_5 D5 (2026-09-04): 运行特性记录 + 旧构建启发式提示（防"新代码未生效仍空转"难定位）
      // zx_20260909 桌面修复③: build 标识随发版刷新为当前轮次（曾硬编码 zx_20260904_5 长期未动，DB run_features.build
      //   无法关联真实二进制版本）。**发版/改 run 循环特性与收口逻辑后须把此处刷新为最新轮次标识**（zx_YYYYMMDD[_x]）。
      // zx_20260910_3 M6: 按上句约定刷新为 zx_20260910_3；并由 rr_zx_20260910_3_b5 钉住此值，防再次"长期未动"。
      // zx_20260910_5 M5: 按同约定刷新为 zx_20260910_5（本轮改引擎核心：费用真闸 + X5 单计数）；断言已同步。
      // zx_20260911_2 M6: 按同约定刷新为 zx_20260911_2（本轮改引擎核心：成果判据/★互斥/IM 出站可靠性）；断言已同步。
      // zx_20260911_3 M6: 按同约定刷新为 zx_20260911_3（本轮改引擎核心：里程碑关联在整棵树上成立 + 完成计数如实分类）；断言已同步。
      // zx_20260911_4 M6: 按同约定刷新为 zx_20260911_4（本轮改引擎核心：审批判定单一真源 + 记忆检索同尺 + 压缩不遮蔽）；断言已同步。
      // zx_20260911_5 M5: 按同约定刷新为 zx_20260911_5（本轮改引擎核心：IM 出站补发账可翻开/失败不静默 + 成果可翻开 + 记忆择要注入）；断言已同步。
      // zx_20260912 M5: 按同约定刷新为 zx_20260912（本轮改引擎核心：IM 运行态须是活的/事件须到场/未送达须记因 + 记忆记账即事实）。
      //   ⚠ 自此起，rr 侧**不再手抄本行值**：由 `scripts/lib/rr-pins.ts` 从本行派生，再核对各产物/各脚本是否同值（见该文件与方案 §M5）。
      // zx_20260913 M5: 按同约定刷新为 zx_20260913（本轮改引擎核心：IM 到得了/成果归得对/子任务跑得起来 + Token 低风险降本）。
      // zx_20260914 M4: 按同约定刷新为 zx_20260914（本轮改引擎核心：作业入队一处真源/自暂停须告知/双击只建一个/IM 回得了话/成果看得见读得动/技能用得上·全景不自毁·水位补分项）。
      // zx_20260915 M7: 按同约定刷新为 zx_20260915（本轮改引擎核心：无产出不算完成/验收三态/失败必带因/子失败不静默/答有痕/事态到了通知面也到/规矩告诉模型/板挂对主体）。
      // zx_20260916 M4: 按同约定刷新为 zx_20260916（本轮改引擎核心：代拟判据≠验收/探针收口移入隔离目录/IM 播报豁免探针名）。
      // zx_20260916_1 M6: 按同约定刷新为 zx_20260916_1（本轮改引擎核心：验收结论进完成判定/配额与实际同源/B2 告警可复核/步数上限由估时参与并撞顶如实/恢复账名实）。
      // zx_20260916_3 M6: 按同约定刷新为 zx_20260916_3（本轮改引擎核心：槽位只数在途/探针认标记不认长相/完成账一处构造/账本新鲜度/代拟消息可辨识/探索配额一本账）。
      //   ⚠ 上一轮（_2）未留同款注释行——值本身正确（P1 仍成立），仅注释台账缺一行，如实记在方案 §八。
      // zx_20260917 M6: 按同约定刷新为 zx_20260917（本轮改引擎核心：停必录因/停必告因/前置之因不得谎报/判卷看得见东西/链上至多一个在跑/判分器看得见已完成与用户指令）。
      //   ⚠ 下一轮（zx_20260918）刷新时未留同款注释行——值本身正确（P1 仍成立），仅注释台账缺一行，如实记在 zx_20260920 方案 §六。
      // zx_20260920 M6: 按同约定刷新为 zx_20260920（本轮改引擎核心：风暴丢弃移到落库之后/回话失败必上账/一个消息一行/记忆逐轮自毁已止）。
      // zx_20260920_1 M8: 按同约定刷新为 zx_20260920_1（本轮改引擎核心，按方案 §1 的六条病根 D1–D6：
      //   D1 工具面按档收窄 / D2 成果收口三面 / D3 模型能力按形态派生 / D4 入站媒体落盘 /
      //   D5 IM 问答下钻一层 / D6 记忆写读刻度同源——**只改这一处**，其余由 `rr-pins` 派生核对。
      //   ⚠ M9-fix 订正：此行原写"质检按档收窄/验收缺口须有人应"——那两个短语**方案里一次都没出现**，
      //     且**漏了 D2/D4/D5 三批**。台账是"开新轮只改一处"的索引，写虚即等于没有索引。）
      // zx_20260921 M9: 按同约定刷新为 zx_20260921（本轮改引擎核心，按方案 §1 的**五**条病根 D1–D5：
      //   D1 入站媒体落了盘却无人写 `wa_tasks.context_json.attachments`——`taskHasMedia` 读的键**全仓零写入者**/
      //   D2 `deriveModelCapabilities` 的 `hasMedia` 那把尺**恒为 false** ⇒ `vision` 从未参与过一次选型/
      //   D3 两个自动拆解器在册，真库 `source='auto-decompose'|'template'` **零产出**/
      //   D4 子任务**建得出来**，但放行回路**四处断点** ⇒ 跑完也放不出父/
      //   D5 引擎手里只有**盘上路径**、全仓无解析能力 ⇒ 内容读不出来交给模型；
      //   另 M8 把 `executeTask` 外围五段机械拆出 `core/exec-*.ts`——**只动形不动义**）
      //   ——**只改这一处**，其余由 `rr-pins` 派生核对。
      // zx_20260921_1 M5: 按同约定刷新为 zx_20260921_1（本轮改引擎核心，按方案 §1 的四条病根 E1–E4：
      //   E1 选中了模型、解出了 Key、URL 也拼对了，`input_audio.data` 塞的却是**音频字节的裸 base64**，
      //      而接收方把 `data` 当 **URL** 解析 ⇒ 要 `data:;base64,<b64>`；生产真入参上实测 HTTP 400 /
      //   E2 「端点 base → chat/completions 全路径」按"是不是 /v1"判，而库里 url 有**五种形态**
      //      （纯主机 / `/v1` / `/v1beta` / `/api/v3` / `/api/paas/v4` / 全路径）⇒ **7 处**落点收敛到
      //      `@worker-ant/ans-client` 的 `resolveChatCompletionsUrl` **一处真源**（按 url 自身形态，不按 host 打表）/
      //   E3 选型零命中的**四重门槛**（没端点 / 没启用 / 供应商没启用 / 缺能力标）被读成同一句话
      //      "无 audio 能力模型可给" ⇒ 四种成因各自说得出为什么 /
      //   E4 能力标签 `audio` **没有定义就上架**（12 个带标者里只有 1 个真能被选中）⇒ 定死为
      //      "能在 chat/completions 请求里接收音频输入"——**只改这一处**，其余由 `rr-pins` 派生核对。
      // zx_20260922 M5: 按同约定刷新为 zx_20260922（本轮改引擎核心，按方案 §1 的六条病根 D1–D6：
      //   D1 循环判据的"同一性"只看工具名、参数被丢 / D2 "连续 N 次"实为窗口内全同、窗口硬编码 8 /
      //   D3 被 guard 拒绝、从未执行的调用也照样计数 / D4 项目阈值 warn=10 硬过窗口 8 ⇒ 硬暂停静默失效 /
      //   D5 A1 同参数去重与 A3 循环阶梯各判各的 / D6 一本账被两问共用——**只改这一处**，其余由 `rr-pins` 派生核对。
      //   ⚠ 本轮**未留同款注释行**；此行系 zx_20260923 收口时**追溯补注**（值本身正确，P1 始终成立）。
      // zx_20260922_1 M8: 按同约定刷新为 zx_20260922_1（本轮改引擎核心：凡"说明书里的一句承诺"须在机器里
      //   找得到一个兑现它的读点——只读探测与 `bash` 同白名单 / 真文档扩展名尺 / 判型补 `configuration` /
      //   撤回"降级重试用非 reasoning 模型"这句不成立的承诺 / 内容门禁采样面 / 预算闸两档名单同源 /
      //   偏离核对问句限定在文件上——**只改这一处**，其余由 `rr-pins` 派生核对。
      //   ⚠ 本轮同样**未留同款注释行**；此行系 zx_20260923 收口时**追溯补注**（值本身正确，P1 始终成立）。
      // zx_20260923 M8: 按同约定刷新为 zx_20260923（本轮改引擎核心，按方案 §2 的十六张对照表 G1–G16，四组：
      //   A 停：G1 thinking 请求兼容（`tool_choice` 删除 + `reasoning_content` 回传 + 展示提取）三合一归一处 /
      //      G2 `sdk_failed` 毒旗带事故标识 / G3 文案改为机器真做的事 / G4 同一次失败只发一条 `task.failed`；
      //   B 建：G5 里程碑缺口在"无子任务"时报出 / G6 `create_task` 入 WARN 档 / G7 登记≠已执行如实写；
      //   C 跑：G8 复用缓存加"判据版本" / G9 门禁成员资格按真文档扩展名 / G10 采样面补 `target` /
      //      G11 恢复时重试额度归位 / G16 给用户可达的自愈出口；
      //   D 账：G12 `failed` 终态清陈旧判卷 / G13 git 闸按"改动落在哪个仓"判 / G14 预算放行必须留痕 /
      //      G15 恢复附言可从 GUI 传——**只改这一处**，其余由 `rr-pins` 派生核对。
      // zx_20260924 M8: 按同约定刷新为 zx_20260924（本轮改引擎核心，附件/多模态全链贯通，七批：
      //   M1 文档族内联（txt/md/json/csv/docx 走 `doc-text.ts`，非文档族如实拒绝并指回 `read_file`）/
      //   M2 视频支→音轨转写（video 上限不再为 0）/
      //   M3 入站媒体四家补齐 /
      //   M4 出站发件通道（`sendMedia` 能力探测，未实现的适配器不声明）/
      //   M5 完成时自动推主成果（超限改文本说明，失败落同一本账）/
      //   M6 模型选型（辅助路能力档一处 `auxModelRequest` + 能力回验 `compareModelCapabilities` +
      //      成本上限 `readMaxCostPer1k` 写端 + ANS `/optimal` 归一处 `resolveOptimalModel`）/
      //   M7 附件去向 GUI 可见（词表一处 `attachment-outcome.ts`，落库/上屏同一形状，老任务不编事实）
      //   ——**只改这一处**，其余由 `rr-pins` 派生核对。
      // zx_20260928 M7: 按同约定刷新为 zx_20260928（本轮改引擎核心，按方案 §1 的五条病根 D1–D5，
      //   **主题=「完成」这个结论在不同出口上必须是同一个值、过同一批闸、落同一笔账**：
      //   D1 `finalize_task` 出口**绕过全部四道 45 分封顶**（自评表直记，标本 a5dfdb48 记 95 分）⇒
      //      CAP0–CAP3 抽成唯一真源 `completionCapFloors`（一处判、两处用），低分改走**既有**那条
      //      `quality_below_bar` 暂停口（与 run_close 同尺，非拒绝、非静默完成）——故本文件新增
      //      `paused_partial` 工具串 marker 与 catch 的 `finalize_paused` 支（必须排在 `finalized` **之前**，
      //      否则 `checks` 明细里的字面量会把暂停读成完成）/
      //   D2 产出物去重口径**按路分家**（写口 project 级、注册口 task 级、IPC 无去重）⇒ 归一处
      //      `findDeliverableByPath`（`deliverable-lifecycle.ts`），**跨任务命中只回既有行、绝不改它的
      //      `task_id`**（不夺归属）/
      //   D3 `register_deliverable` 的版本行 INSERT **漏 NOT NULL `file_path`**、异常被**空 `catch {}`** 吞 ⇒
      //      「注册产出物」长期**没有版本基线行**而无人知晓；
      //   D4 `execution_metrics` 全仓**只有 run_close 一处写**、另三个出口不写 ⇒ 三个读方把「没记过账」读成
      //      「一笔都没成」⇒ 三个收尾出口**同形补写**（步数/Token 是 `executeTask` 函数局部量，故只能写在这里，
      //      **不得**下沉进工具；人工收口不执行任务 ⇒ **不编造**，保持不写）；读出端区分「未知」与「没有」/
      //   D5 去重命中时回的是**请求的 type**、行里是另一个 type ⇒ 回行里真实的值
      //   ——**只改这一处**，其余由 `rr-pins` 派生核对。
      //   ⚠ 前两轮（zx_20260923_1、zx_20260924_1）均**未留同款注释行**——值本身正确（P1 始终成立），
      //     仅注释台账缺两行，如实记在 zx_20260928 方案 §5。
      // zx_20260929 M9: 按同约定刷新为 zx_20260929。本轮**主体是重构、不改行为**（方案 §M9）：
      //   `executeTask` 的步回调整段外移到 `core/exec-step.ts`（`createStepHandler`）、收尾段外移到
      //   `core/exec-close.ts`（`runCloseSection`），执行体 4428→3703 行。**两处均由执行体真实
      //   import 且在原调用点接入**（只建文件不接 = 本轮主题「在册≠在路」的反面）。
      //   ★步回调交出的是 `StepScope` **活访问器**（53 个 `get`／23 个 `set`，读写落在执行体原绑定上），
      //     **刻意不取快照**——快照会把每步的步数/水位/降级档静默冻住（无报错，只是数字不再动）。
      //   行为等价的唯一验收 = 全量 rr 零回归 + `tsc`；判据侧的扫描面扩宽与剥离规则见
      //   `scripts/lib/rr-engine-src.ts`（`engineExecSideFiles` / `stripStepScopePrefix`）。
      // zx_20261002 「看得见、拆得动、学得会、配得上」: 按同约定刷新为 zx_20261002。
      //   批一 看得见（M1–M4：IM 跨页提醒可达 / 未读按会话归零 / 回话对象显式 / 会话区可读）
      //   批二 拆得动（M5–M8：主动拆解 / 三路同源 / 拆解溯源可见 / 依赖账实）
      //   批三 学得会（M9–M12：记忆原料+三闸可达 / 拆解成功→模板真产出 / 项目调用记账 / 自优化闭环）
      //   批四 配得上（M13–M15：tier 回验裁定 / ANS 硬过滤→排序降级 / 附件按族派生能力需求）
      //   批五 清障（M16–M17：两处死查询+列存在性判据 / 工具规则对齐 ClaudeCode）
      // zx_20261003 「验得了、汇得拢、轻得下」: 按同约定刷新为 zx_20261003。
      //   批一 收得住（M1–M3：产出校验按族分派 / 无 vision 显式降级留痕 / 判族一把尺）
      //   批二 汇得拢（M4–M6：项目知识聚合面补全 / panorama 纳入非记忆原料 / 知识面上屏）
      //   批三 轻得下（M7–M10：守护块搬移 / finalize 搬移 / F3 推送搬移 / 记忆簇搬移）
      //   批四 看得见（M11–M13：会话流长文截断展开 / 逐渠道未读红点 / 入站视频播放器）
      //   ——**只改这一处**，其余由 `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261005 「开源节流」——从"自用之器"到"可售之物": 按同约定刷新为 zx_20261005。
      //   批一 立得住（M1–M4：打包配置修正·package.json 规范化·本机打包 PoC·签名挂账）
      //   批二 卖得动（M5–M9：能力上限真源·离线签名许可·软闸接线·激活界面·签发工具）
      //   批三/批四 上手快（M10–M16：支付与官网·安装向导·缺省身份治理）
      //   批五 交得出（M17–M20：开源发布）
      //   M21 上手第一跳（ANS 端口单源 / 绑定失败如实 / 桌面托管拉起——K-11）
      //   ——**只改这一处**，其余由 `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261015_2 「实」——判卷读事物本身，账目名实相符（六缺陷批）: 按同约定刷新为 zx_20261015_2。
      //   批一 判卷读事物本身（D1：判卷证据面不再混入 draft 产出物）
      //   批二 账目名实（D2 完成即清暂停因 / D5 子任务完成账不复述伪计数 / D6 判卷未取到结论如实降级）
      //   批三 拆解与快照（D3 里程碑提示带方案里的名字 / D4 写新 before 即清陈旧 after）
      //   ——**只改这一处**，其余由 `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261015_3 「桥」——认 HA 标准协议（MQTT Discovery），一条缝见数百品牌；在场只认设备自述。
      //   批一 HA 语言纯映射（主题/缩写/`~`/能力/下行载荷，零 I/O）
      //   批二 发现接上 + 传动分语言（`subscribeIo`/`openSubscriber` 共用骨；`haCommandPayload` 选语言）
      //   批三 设备在线态（`online` 三态 + 可用性 LWT 订阅——**不从发现载荷推在线**）
      //   批四 GUI（HA 桥开关 + 在线三态徽章）
      //   ——**只改这一处**，其余由 `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261016_1 「应」——门里得有人应声（IM 审批），回音得是本尊（控制回执认主题）。
      //   批一 控制面止血（D1 回执只认本次订阅主题 / D2 订阅收支平衡 / D3 停机收摊关连接）
      //   批二 配对申请推得到人（`buildPairNotice` + `pushImOwnerNotice`，旁路不阻断配对）
      //   批三 IM 回复即审批（`parsePairReply`/`resolvePairTarget` + 路由新臂；真调 approve/reject）
      //   批四 面板提示一行 + 文档口径（Team 闸四块 + 创始人动作清单刷新）
      //   ——**只改这一处**，其余由 `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261016_2 「源」——留痕要说得出发起者是谁（实机 E2E 格③照出：控制留痕认不出人）。
      //   批一 台账加两列 `actor_kind`/`actor_ref` + 旧行**事实回填**（`task_id != ''` ⟺ 任务发起）
      //   批二 三入口各报身份（工具 `task` / 面板 `panel` / 外部终端 `external`，经 `terminalId` 透传）
      //   批三 面板行首前置来源标签（`SourceChip`：名字读时现查，认不出即整段不渲染）
      //   批四 本套件 + 旧断言重定向 + 夹具补列
      //   ——**只改这一处**，其余由 `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261016_4 「闭」——试用起算点不可重置（两处锚点 · 取早者 · 缺一侧自愈）。
      //   批一 新 `core/license-anchor.ts`（纯函数裁决）+ `database.ts` 取两处/回写两处 + `license.ts` 读侧钳位
      //   ——**只改这一处**，其余由 `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261017_1 「任」——协同 + 档位（能力路由 / 席位闸 / 团队库 / 审计视图 / 知识包 / 三方云试点）。
      // zx_20261018_2 批三「见省」：稳定前缀指纹落 `run_features`。**只记"可复用"**：
      //   hash 相同 ⇔ 同一项目、同一配置下前缀逐字节一致；命中与否在供应商侧，本机不写"缓存命中"。
      // zx_20261021_2 「止」——归档即停 / 终态不可覆写 / 派生任务须成话。**只改这一处**，其余由
      //   `scripts/lib/rr-pins.ts` 派生核对（P1–P6）。
      // zx_20261021_3 「传」——领域包可携带 / 能力卡可自述 / 档位卖点可兑现。**只改这一处**。
      // zx_20261021_4 「实」——拆解不编人 / 验收不误读 / 撞顶不白跑。**只改这一处**。
      // zx_20261022_1 「名实」——占位符判据见字 / 探针识别数字前缀 / 跨任务去重说清归属 / 验收路径落地。**只改这一处**。
      // zx_20261022_2 「行」——置 running 即真入队 / 时刻同尺 / 孤立 running 周期对账 / 拆解不返工。**只改这一处**。
      // zx_20261022_3 「信」——协同与设备可信：容量一把尺 / 两机真通路 / 设备显态与安全 / 档位可见。**只改这一处**。
      // zx_20261023_1 「称」——价目表所称的节点上限须真能拦（席位降为本机账号口径）/ 文档名实对齐。**只改这一处**。
      // zx_20261023_2 「诚」——验证者能编译 / 判卷看得见中段 / 暂停即未达成 / 槽位不饿死规划。**只改这一处**。
      // zx_20261023_3 「令」——令下即止（起跑/每步同一判据·句柄前置）/ 越界即拒（变更类工具调用时状态闸）/ 名实（跨任务消息不复活）。**只改这一处**。
      // zx_20261023_5 「序」——依赖感知跨机编排：关键路径优先 / 依赖三态准入 / 上游摘要随行 / 上游到站重决策 / 作业来源。**只改这一处**。
      const prefixFp = fingerprintMessages(messages, stablePrefixEnd);
      const feats ={ requirementCard: true, contextWatermark: true, historySummaryOnly: true, readListOnResume: true, goalRestartCap: true, build: 'zx_20261023_5',
        ctx_prefix_hash: prefixFp.hash, ctx_prefix_chars: prefixFp.chars, ctx_prefix_end: prefixFp.end };
      // zx_20260916_1 M5 (#6): 读**恢复账总数**（用户介入 + 系统自动），不再单读 `resume_count`——
      //   该键自本轮起只记用户介入，单读它会把"系统反复重启"的重任务漏判成轻任务。真源见 `core/resume-ledger.ts`。
      const oldHeavy = !latestCtx.run_features && (Number(latestCtx.budget_accum) > 1_000_000 || resumeLedgerTotal(latestCtx) >= 2);
      latestCtx.run_features = feats;
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(latestCtx), taskId);
      logger.info({ taskId: taskId.slice(0, 8), run_features: feats }, '运行特性已记录(run_features)');
      if (oldHeavy) {
        messages.push({ role: 'system', content: '[特性提示] 本任务早前由旧版本运行（无 Token 收敛特性）；当前已加载新特性（需求卡/水位/摘要/已读清单）。请聚焦当前目标产出，勿复读早前探索。' });
        logger.info({ taskId: taskId.slice(0, 8) }, '检测到任务由旧版本早前运行，已提示新特性生效');
      }
      if (waterPct >= Math.round(CTX_WARN_PCT * 100)) {
        logger.warn({ taskId: taskId.slice(0, 8), waterPct, approxTokens }, '上下文高水位，建议聚焦产出减少探索');
      }
    } catch { /* 水位记录失败不阻塞 */ }

    // 工具集可变引用：onStepFinish 中真正移除禁用工具（delete key 后 AI SDK 每步重读）
    const toolMap = tools as unknown as Record<string, unknown>;

    // zx_20260920_1 M2（管子·度量衡 / 庄周·无用之用）: 装配点**只注入本档工具**——按形态删掉档外 key。
    //   §1.1 D1 的病根是"只写进提示词、不过滤"：`priorityTools` 只影响一句 system 提示，57 件 schema
    //   照旧全量下发（实测 16683 chars/步）。此处才是"收窄真发生"的落点。
    //   ⚠ 在 `streamText` **之前**删是安全的（模型从未见过它们的 schema）。这与 `disableToolGracefully`
    //   的"循环中禁用"是**不同场景**：循环里删会让 AI SDK 抛 unavailable tool 硬错误，故那里用桩；
    //   而档外调用有**专门的如实告知支**（见下方 catch 内的 NoSuchToolError）。
    for (const k of toolFace.removed) delete toolMap[k];
    logger.info({ taskId: taskId.slice(0, 8), toolFace: archetype, kept: toolFace.kept.length, removed: toolFace.removed.length, restored: toolFace.restored, toolsCharsAfter }, '工具面按形态收窄已应用');
    // 如实告知（正向·开工即知）: 本档可用哪些工具。本档零收窄时只说一句"未收窄"（无"档外"可告知）。
    messages.push({ role: 'system', content: buildToolFaceBrief(archetype, adaptiveStrategy.label, toolFace.kept, toolFace.removed.length) });

    // 2.3 每作用域工具限制：子代理 allowTools/denyTools 白名单/黑名单（deny 优先，可见即权限）
    if (subagentAllowTools || subagentDenyTools) {
      for (const key of Object.keys(toolMap)) {
        if (subagentDenyTools?.includes(key) || (subagentAllowTools && !subagentAllowTools.includes(key))) {
          delete toolMap[key];
        }
      }
      logger.info({ taskId: taskId.slice(0, 8), allowed: subagentAllowTools?.length ?? 0, denied: subagentDenyTools?.length ?? 0, remaining: Object.keys(toolMap).length }, '子代理工具限制已应用');
    }

    // zx_20261023_3 批二（令下即止 / 越界即拒）：给变更类工具的 `execute` 包一层**调用时**状态闸。
    //   装配时只包壳、不读库；壳里每次调用当场读库 ⇒ 同一 run 内前一步被暂停，后一步即进不来。
    //   只包变更类（`WORLD_MUTATING_TOOLS`）；只读与表态类（ask_user/escalate/interrupt/decide）不碰。
    //   ⚠ 必须在校验前的「Step1 只读限制」**之前**包——那一步会把工具移入 `savedTools` 再于后续步还原，
    //     若包里晚于它，还原回来的就是未包壳的原件，闸被绕开。
    for (const name of WORLD_MUTATING_TOOLS) {
      const gateTool = toolMap[name] as { execute?: (...a: unknown[]) => unknown } | undefined;
      if (!gateTool || typeof gateTool.execute !== 'function') continue;
      const originalExecute = gateTool.execute.bind(gateTool);
      gateTool.execute = async (...a: unknown[]) => {
        const nowStatus = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined)?.status;
        const verdict = mutationGateVerdict(nowStatus, name);
        if (!verdict.ok) {
          logger.warn({ taskId: taskId.slice(0, 8), tool: name, status: nowStatus, reason: verdict.reason }, '变更类工具调用被拒绝（任务已暂停/结束）');
          return JSON.stringify({ error: verdict.message, refused: verdict.reason, tool: name });
        }
        return originalExecute(...a);
      };
    }

    // 配置任务Step1限制：configuration 原型首步强制 ask_user + 只读工具（从 toolRegistry.isReadOnly 派生，排除网络搜索/子代理列表）
    const READONLY_STEP1_TOOLS = new Set([
      ...toolRegistry.listReadOnlyNames().filter(n => !['search_web', 'read_web', 'list_agents'].includes(n)),
      'ask_user',
    ]);
    const savedTools: Record<string, unknown> = {};
    const convCount = (db.prepare('SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ?').get(taskId) as { c: number }).c || 0;
    // zx_20260904_7 硬映射① (2026-09-04): 张力 autonomy-vs-control ≥70 且无显式目标/验收的自由任务 → 首步硬限"只读+ask_user"（必须 ask_user 解锁才能写/执行，控制优先）
    let controlStrong = false;
    try {
      const t5 = getTensions(db, projectId)['autonomy-vs-control']?.position ?? 30;
      const hasGoal = !!taskGoal?.goal || !!((task.acceptance_criteria as string) || '').trim();
      controlStrong = t5 >= 70 && !hasGoal && convCount === 0;
    } catch { controlStrong = false; }
    if ((archetype === 'configuration' || controlStrong) && convCount === 0) {
      for (const key of Object.keys(toolMap)) {
        if (!READONLY_STEP1_TOOLS.has(key)) { savedTools[key] = toolMap[key]; delete toolMap[key]; }
      }
      logger.info({ taskId: taskId.slice(0, 8), savedCount: Object.keys(savedTools).length, keptCount: Object.keys(toolMap).length }, '配置任务Step1: 保留ask_user+只读工具');
    }

    // 4. 调用 AI SDK（步数/温度按任务原型自适应，options可覆盖；子Agent类型可覆盖 maxSteps）
    const baseMaxSteps = options?.maxSteps || subagentMaxSteps || adaptiveStrategy.maxSteps;
    // 项目规模自适应：大型项目(文件多)探索成本高，需更多步数；中小型项目保持原步数
    let projectFileCount = 0;
    let estSteps = 0;
    // zx_20261021_4 批四：恢复续额——上一次撞顶时已计入 `step_budget_bonus`，本次上限在公式结果上叠加。
    let stepBudgetBonus = 0;
    try {
      const snapCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
      projectFileCount = Number((snapCtx.world_snapshot_before as { fileCount?: number } | undefined)?.fileCount) || 0;
      // zx_20260916_1 M4 (#5): 估时步数参与上限——`task_estimate.steps` 是同类历史样本的加权平均步数
      //   （`:3014` 写入；无历史样本时该键不存在 ⇒ 0 ⇒ 退回原公式）。原实现只消费了 `task_estimate.tokens`(`:3431`)，
      //   `steps` 算出后**从无消费者**——估了却不用，正是"做了没用上"。
      estSteps = Number((snapCtx.task_estimate as { steps?: number } | undefined)?.steps) || 0;
      stepBudgetBonus = Number((snapCtx as { step_budget_bonus?: unknown }).step_budget_bonus) || 0;
    } catch { projectFileCount = 0; estSteps = 0; stepBudgetBonus = 0; }
    const sizeMultiplier = projectFileCount >= 200 ? 1.5 : projectFileCount >= 50 ? 1.25 : 1.0;
    const maxSteps = resolveMaxSteps(baseMaxSteps, sizeMultiplier, estSteps, stepBudgetBonus);
    let finalContent = '';
    let stepCount = 0;
    let totalTokensUsed = 0;
    // zx_20260910_5 M1: 费用累计（CNY），本次执行局部变量，跨 resume 从 cost_used 恢复（与 token 侧同一口径）
    let totalCostUsed = 0;
    // 恢复/重试时累积历史 token：totalTokensUsed 是本次执行的局部变量，需从 context_json 恢复上次累计值，避免清零
    try {
      const prevCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}') as { tokens_used?: number; cost_used?: number };
      totalTokensUsed = Number(prevCtx.tokens_used) || 0;
      totalCostUsed = Number(prevCtx.cost_used) || 0;
    } catch { totalTokensUsed = 0; totalCostUsed = 0; }
    let askUserCalled = false;
    // Phase F (2026-08-28 zx_4): finalize 成功标志（功成身退——finalize 后立即终止循环，避免恋栈空转超时）
    let finalizeCompleted = false;
    // 失败风险追踪（为之于未有）
    let consecutiveErrors = 0;
    let noProgressSteps = 0;
    let toolErrorCount = 0;
    let toolCallCount = 0;
    // 知足者富：写入类工具调用追踪（用于早停判断）
    const writeTools = new Set(['write_file', 'edit_file', 'register_deliverable', 'finalize_task']);
    let writeToolCount = 0;
    // zx_20260915 P0-1(d)：本轮 write_file/edit_file 次数（诊断材料，非判据）
    let fileMutationCount = 0;
    // A1/A4: 工具循环检测 + A3 降级（追踪最近工具调用 + 每工具配额）
    // zx_20260922 M1: **两本账刻意拆开**（方案 §1.6-a）——它们问的是**两个不同的问题**：
    //   `recentToolNames` 喂 `failure_record.tools`（要**工具名**：经 `jobs/ai-task.ts` 渲染成
    //     「主要工具：bash,read_file」给模型与用户看）；`loopRun` 喂循环判据（要**调用身份**）。
    //   合并会让那行**用户可见**文案变成 `bash:{"command":"git status --short"}`——故**不得**合并。
    const recentToolNames: string[] = [];
    // zx_20260916_1 M2: **配额账**（只计该工具"吃额度"的调用，判据见 countsTowardToolQuota）。
    // 全量调用统计是另一本账——单数 `toolCallCount`（下方按步累加，供失败风险/收口记账 4 个读点），
    // 本账不兼作统计（原 `toolCallCounts` 兼两用，D2 删除后其"全量"那份将零读点，故不保留）。
    // zx_20260916_3 M5（O-H · D4）：由"每工具一本 Map"改为**按 `quotaKey` 一本账**——`bash` 与
    //   `execute_command` 共用 `shell_explore` 这一本（此前各 12/20，合计 32 次探索额度、实测翻倍）。
    //   ⚠ 账是**本 run 内存态**：跨恢复/重启重置。D4 归一并未改变这一点，如实登记，不谎称已解决。
    const quotaLedger = new ExploreQuotaLedger();
    // zx_20260909 #7a: 探索命令运行级累计（只计 bash 只读探测/py_compile 类；跑测试/git 提交不触发硬停，避免误伤收尾）
    // zx_20260916_1 M2: **刻意不与上面那本配额账合并**——D3 的判据是 `isExplorationCall`（其 execute_command 分支
    //   只认 py_compile/--version，答的是"循环检测可否豁免"），与本轮的配额尺答的不是同一个问题；
    //   合并会顺带改掉 D3 的触发集合（丢掉 py_compile、多算 ls），超出本轮"只改 A3 计数口径"的范围。
    let exploreCmdN = 0;
    // zx_20260922 M2: 循环**游程**账（判据 `advanceLoopRun`，模块作用域）。旧账 `recentToolCalls`
    //   一本兼两用（工具名 + 循环身份）已按 M1 拆为 `recentToolNames` / 本变量。游程**跨步**延续，
    //   但每步只推进**一次**（一步内并行调用不累加）。
    let loopRun: LoopRun = EMPTY_LOOP_RUN;
    let degradationLevel = 0;
    // 复杂度升级只提示一次，避免 token 持续增长导致每 5 步重复刷屏
    let complexityUpgraded = false;
    // 知足提示只提示一次，避免每 3 步重复催 finalize 与"工具已禁用"叠加逼提前收尾
    let sufficiencyHintFired = false;
    // 无为而治：流模式状态（连续进展→减少软干预）
    const flowState = createFlowState();
    // 遵守规则：项目级自适应阈值（getProjectThresholds，供工具循环/无进展检测使用）
    const projectThresholds = getProjectThresholds(db, projectId);
    // A3: 工具配额（软警告+硬限制）
    // 工具配额（软/硬限制）统一由 tool-registry 元数据提供，此处不再硬编码
    const disabledTools = new Set<string>();
    // zx_20260917 M5b·病根④: 「**逐调用收窄**」的记账本——与 `disabledTools` **刻意分列**：
    //   `disabledTools` 的语义是「**这个工具不能用了**」（桩恒返回错误），而本集合里的工具**仍然可用**，
    //   只是**探索类调用**被拒。并入 `disabledTools` 会把"收尾照常"谎报成"整个工具没了"，
    //   且 `:4026`（A3 配额按同账工具禁用）、预算档位诸处都按它分支，一处谎报会连累一串判断。
    const cappedTools = new Set<string>();
    // 工具禁用：不删除工具(删除会让模型继续调用时 AI SDK 抛 "Model tried to call unavailable tool" 硬错误 → 任务失败)，
    // 而是替换为"已禁用"桩，让模型获得明确反馈并改用其他工具。
    const disableToolGracefully = (toolName: string, reason: string): void => {
      const original = toolMap[toolName] as { description?: string; parameters?: unknown } | undefined;
      toolMap[toolName] = {
        description: original?.description ?? toolName,
        parameters: original?.parameters ?? { type: 'object', properties: {} },
        execute: async () => JSON.stringify({ error: reason }),
      };
    };
    // A1 的同参数去重账已按 zx_20260922 M3 **并入**下方的循环阶梯（`loopRun` + 阈值一处出闸）——
    //   原先它与 A3 各算各的计数器（`dedupCount` vs `continuousSame`），判的却是同一件事。
    let lastFailedToolName = '';
    let consecutiveErrorCount = 0;
    // 重复读文件检测（连续读同一文件同一位置未写入；不同 offset 分块读大文件属正常探索）
    let lastReadFileKey = '';
    let sameFileReads: string[] = [];
    // 成本估算追踪（输入/输出token分开统计）
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let prevPrompt = 0;    // zx_20260904_7 统计修复: provider 可能返回累计 usage，用于逐步增量
    let prevComp = 0;
    // 恢复/重试时同样累积历史输入/输出 token（从上次 cost_estimate 恢复）
    try {
      const prevCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}') as { cost_estimate?: { inputTokens?: number; outputTokens?: number } };
      totalPromptTokens = Number(prevCtx.cost_estimate?.inputTokens) || 0;
      totalCompletionTokens = Number(prevCtx.cost_estimate?.outputTokens) || 0;
    } catch { /* 忽略 */ }
    // zx_20261018_1 批七：四个收口出口共用的一份分账——`output` 源按本次 provider 实报的输出 token 换算字符。
    const ctxTokenBreakdown = (): TokenBreakdownRecord | undefined => {
      if (!ctxTokenLedger || !ctxTokenTrim) return undefined;
      const outputChars = Math.max(0, Math.round(totalCompletionTokens)) * TOKEN_CHARS_PER_UNIT;
      return {
        ...withSourceChars(ctxTokenLedger, 'output', outputChars),
        trimmedChars: ctxTokenTrim.trimmedChars,
        budgetTokens: ctxTokenTrim.budgetTokens,
        overBudget: ctxTokenTrim.overBudget,
      };
    };

    // Phase 3.1: 中断控制器在认领后即已登记（zx_20261023_3 批一前移）；此处只管超时——
    //   超时与 interrupt 走**同一**控制器，中止因由由 catch 侧按关键字分派。
    const timeoutTimer = setTimeout(() => controller.abort(new Error('任务执行超时')), maxSteps <= 5 ? 120_000 : 600_000);

    // D2: 步骤耗时统计（onStepFinish 计算本步骤耗时，供前端逐步展示）
    let lastStepTs = Date.now();

    try {
      const { streamText } = await import('ai');

      // CoT (2026-09-03): 推理模型思考过程(reasoning_content)流式——fetch 旁路提取 + 节流发射 reasoningDelta
      let reasonBuf = '';
      let reasonTimer: ReturnType<typeof setTimeout> | null = null;
      const flushReason = () => {
        if (reasonBuf) {
          const r = reasonBuf;
          reasonBuf = '';
          eventBus.emitTransient('task.step_streaming', { taskId, task_id: taskId, projectId, step: stepCount, reasoningDelta: r }).catch(() => {});
        }
      };
      const pushReason = (text: string) => {
        reasonBuf += text;
        if (!reasonTimer) reasonTimer = setTimeout(() => { reasonTimer = null; flushReason(); }, 80);
      };
      // zx_20260923 M2-c: 走**生产那座唯一工厂**（`tool_choice` 删除 + `reasoning_content` 回传 + 展示提取三合一）。
      // 传 `onReasoningDelta` ⇒ 同时启用回合累计 ⇒ 下一条请求会把本回合的思考回传（G1 靶心）。
      // `probe`（M2-a）：落一份脱敏形状指纹到 `data/reasoning-probe/<taskId>.jsonl`，供真机坐实触发点。
      const provider = createSafeProvider({
        apiKey,
        baseURL: baseUrl,
        onReasoningDelta: pushReason,
        probe: { dir: path.join(ctx.dataDir, 'reasoning-probe'), tag: taskId },
      });

      // D2 (2026-09-02): generateText → streamText 实现 token 级流式。
      // generateText 在 AI SDK 4.3 不支持 onChunk/流式；streamText 同样支持 maxSteps 工具循环 + onStepFinish，
      // 下方 onStepFinish 逻辑原样保留，仅在调用后消费 fullStream 捕获 text-delta 实时推送。
      // zx_20260929 M9：步回调已外移到 `core/exec-step.ts`——此处交出的是**活访问器**（读写落在下列绑定本身），
      //   不是取值快照；23 个可变绑定在每步被写回，快照会让执行体此后读到旧值。
      const stepScope = {
        get ctx() { return ctx; },
        get taskId() { return taskId; },
        get db() { return db; },
        get projectId() { return projectId; },
        get archetype() { return archetype; },
        get complexityLevel() { return complexityLevel; },
        get ansClient() { return ansClient; },
        get modelName() { return modelName; },
        get inputPricePer1k() { return inputPricePer1k; },
        get outputPricePer1k() { return outputPricePer1k; },
        get ctxWindowForWater() { return ctxWindowForWater; },
        get taskGoal() { return taskGoal; },
        get maxTokens() { return maxTokens; },
        get costGateActive() { return costGateActive; },
        get maxCost() { return maxCost; },
        get costSrc() { return costSrc; },
        get ctxAssembledChars() { return ctxAssembledChars; },
        get estTokens() { return estTokens; },
        get toolMap() { return toolMap; },
        get savedTools() { return savedTools; },
        get maxSteps() { return maxSteps; },
        get stepCount() { return stepCount; },
        set stepCount(v) { stepCount = v; },
        get totalTokensUsed() { return totalTokensUsed; },
        set totalTokensUsed(v) { totalTokensUsed = v; },
        get totalCostUsed() { return totalCostUsed; },
        set totalCostUsed(v) { totalCostUsed = v; },
        get askUserCalled() { return askUserCalled; },
        set askUserCalled(v) { askUserCalled = v; },
        get finalizeCompleted() { return finalizeCompleted; },
        set finalizeCompleted(v) { finalizeCompleted = v; },
        get consecutiveErrors() { return consecutiveErrors; },
        set consecutiveErrors(v) { consecutiveErrors = v; },
        get noProgressSteps() { return noProgressSteps; },
        set noProgressSteps(v) { noProgressSteps = v; },
        get toolErrorCount() { return toolErrorCount; },
        set toolErrorCount(v) { toolErrorCount = v; },
        get toolCallCount() { return toolCallCount; },
        set toolCallCount(v) { toolCallCount = v; },
        get writeTools() { return writeTools; },
        get writeToolCount() { return writeToolCount; },
        set writeToolCount(v) { writeToolCount = v; },
        get fileMutationCount() { return fileMutationCount; },
        set fileMutationCount(v) { fileMutationCount = v; },
        get recentToolNames() { return recentToolNames; },
        get quotaLedger() { return quotaLedger; },
        get exploreCmdN() { return exploreCmdN; },
        set exploreCmdN(v) { exploreCmdN = v; },
        get loopRun() { return loopRun; },
        set loopRun(v) { loopRun = v; },
        get degradationLevel() { return degradationLevel; },
        set degradationLevel(v) { degradationLevel = v; },
        get complexityUpgraded() { return complexityUpgraded; },
        set complexityUpgraded(v) { complexityUpgraded = v; },
        get sufficiencyHintFired() { return sufficiencyHintFired; },
        set sufficiencyHintFired(v) { sufficiencyHintFired = v; },
        get flowState() { return flowState; },
        get projectThresholds() { return projectThresholds; },
        get disabledTools() { return disabledTools; },
        get cappedTools() { return cappedTools; },
        get disableToolGracefully() { return disableToolGracefully; },
        get lastReadFileKey() { return lastReadFileKey; },
        set lastReadFileKey(v) { lastReadFileKey = v; },
        get sameFileReads() { return sameFileReads; },
        set sameFileReads(v) { sameFileReads = v; },
        get totalPromptTokens() { return totalPromptTokens; },
        set totalPromptTokens(v) { totalPromptTokens = v; },
        get totalCompletionTokens() { return totalCompletionTokens; },
        set totalCompletionTokens(v) { totalCompletionTokens = v; },
        get prevPrompt() { return prevPrompt; },
        set prevPrompt(v) { prevPrompt = v; },
        get prevComp() { return prevComp; },
        set prevComp(v) { prevComp = v; },
        get controller() { return controller; },
        get lastStepTs() { return lastStepTs; },
        set lastStepTs(v) { lastStepTs = v; },
      };

      // zx_20261023_3 批一：**起跑前最后一次复核**——认领至此隔了整个 prelude（含 await 的选型/记忆检索），
      //   暂停可能正好落在这段里。不跑就不调用模型：返回 `steps: 0`，不写任何结局。
      const preStartStatus = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined)?.status;
      const preStartRefusal = runStartRefusal(preStartStatus, controller.signal.aborted);
      if (preStartRefusal) {
        logger.info({ taskId: taskId.slice(0, 8), reason: preStartRefusal }, '起跑前复核未通过，本次不调用模型');
        return { content: `任务未起跑（${preStartRefusal}）`, steps: 0 };
      }

      const result = await streamText({
        model: provider.chat(modelName),
        messages,
        tools,
        maxSteps,
        temperature: options?.temperature ?? adaptiveStrategy.temperature,
        maxTokens: maxOutputTokens,
        maxRetries: 3,
        abortSignal: controller.signal,
        onStepFinish: createStepHandler(stepScope),
      });

      // D2 (2026-09-02): 消费 fullStream 驱动多步循环 + 捕获 text-delta 逐 token 实时推送。
      // 节流 ~80ms 合并为一帧 task.step_streaming（transient，不持久化），避免 IPC/事件洪泛。
      let stepStreamBuf = '';
      let stepStreamTimer: ReturnType<typeof setTimeout> | null = null;
      const flushStepStream = () => {
        if (stepStreamBuf) {
          const delta = stepStreamBuf;
          stepStreamBuf = '';
          eventBus.emitTransient('task.step_streaming', { taskId, task_id: taskId, projectId, step: stepCount, textDelta: delta }).catch(() => {});
        }
      };
      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta' && chunk.textDelta) {
          stepStreamBuf += chunk.textDelta;
          if (!stepStreamTimer) stepStreamTimer = setTimeout(() => { stepStreamTimer = null; flushStepStream(); }, 80);
        }
      }
      if (stepStreamTimer) { clearTimeout(stepStreamTimer); stepStreamTimer = null; }
      flushStepStream();
      // CoT: 主循环结束，flush 残留 reasoning（思考通常先于答案结束，此处兜底清尾）
      if (reasonTimer) { clearTimeout(reasonTimer); reasonTimer = null; }
      flushReason();
      // 安全网：onStepFinish 内 controller.abort（finalize_completed/interrupt/硬暂停/偏离重启）在 streamText 下
      // fullStream 可能静默结束或抛错，统一在此按 controller.signal.reason 主动抛回既有 catch，保证与 generateText 逃逸语义一致。
      if (controller.signal.aborted) {
        const abortReason = (controller.signal as unknown as { reason?: unknown }).reason;
        throw abortReason instanceof Error ? abortReason : new Error('aborted');
      }

      finalContent = await result.text;
    } catch (aiErr) {
      // 硬暂停/中断（已置 paused 并 abort）→ 标记暂停而非失败/完成
      if (controller.signal.aborted) {
        const abortReason = (controller.signal as unknown as { reason?: unknown }).reason;
        const reasonMsg = abortReason instanceof Error ? abortReason.message : '';
        // Phase F (2026-08-28 zx_4): finalize 成功 → 正常完成（功成身退，不走 failed）
        if (reasonMsg.includes('finalize_completed')) {
          // zx_20261021_2 D1（知止）：库已到终态（归档/失败/他人完成）⇒ **不得**再写 `completed`。
          //   此前本支无条件 `UPDATE … status='completed'`，实测把 `archived` 的 58c60680 覆写成 completed。
          const stAtFinalize = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined)?.status;
          if (isTerminalStatus(stAtFinalize)) {
            logger.info({ taskId: taskId.slice(0, 8), status: stAtFinalize }, '任务已处于终态，finalize 收口不改写状态');
            return { content: `任务已处于终态（${stAtFinalize}），本次执行停止`, steps: stepCount };
          }
          logger.info({ taskId: taskId.slice(0, 8), steps: stepCount }, '任务 finalize 完成，立即终止循环');
          // 补成本估算（finalize 提前终止，跳过正常收尾的成本估算）
          try {
            const fctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
            const rawCost = (totalPromptTokens / 1000) * inputPricePer1k + (totalCompletionTokens / 1000) * outputPricePer1k;
            const finUsd = modelPriceInUsd(modelName);
            const finRate = finUsd ? USD_TO_CNY_RATE : 1;
            const finCostCny = rawCost * finRate;
            const fce: Record<string, unknown> = {
              cost: Math.round(finCostCny * 1_000_000) / 1_000_000,
              currency: 'CNY',
              tokens: totalTokensUsed,
              inputTokens: totalPromptTokens,
              outputTokens: totalCompletionTokens,
              model: modelName,
            };
            if (finUsd) { fce.cost_usd = Math.round(rawCost * 1_000_000) / 1_000_000; fce.cny_rate = USD_TO_CNY_RATE; }
            fctx.cost_estimate = fce;
            fctx.last_model = modelName;
            // zx_20260928 M5（D4）: 补写 `execution_metrics`——此前**只有 run_close 一处写**（`:3009`），
            //   本路与 M2 新增的低分路都不写 ⇒ 下游三个读方（`tension-engine` 的产出率 / 相似任务步数估计 /
            //   archetype 统计）把这些任务一律读成「没有产出物」（`!undefined === true`）。形状与 run_close
            //   **逐字同构**：值全在本作用域内（`stepCount`/`totalTokensUsed` 是 `executeTask` 的函数局部量，
            //   工具够不到 ⇒ 写入端**必须在执行体**）。
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(fctx), taskId);
            // zx_20261018_1 批七：`execution_metrics` 统一经 `writeExecutionMetrics` 合并写（唯一写口）。
            writeExecutionMetrics(db, taskId, {
              archetype,
              stepsUsed: stepCount,
              totalTokens: (ctx.sideTokens || 0) > 0 ? totalTokensUsed + (ctx.sideTokens || 0) : totalTokensUsed,
              hasDeliverable: realOutputEvidence(db, taskId),
              tokenBreakdown: ctxTokenBreakdown(),
            });
          } catch { /* 成本估算 best-effort */ }
          // zx_20260913 M3-6(名实相符 / 同一把尺): 标 completed 前先查未完成子任务。
          // finalize_task 工具本身已有此闸（:827），但**收口路径**（自动完成）此前无闸——子任务仍在跑也照标完成。
          // 判据与 finalize_task 同一把尺（completed/failed/archived 之外皆未完成）；有则置 paused 待子完成，不 abort。
          // zx_20260915 P0-3(c)(同一把尺·**先失败后未完成**): 失败子须先判——一个子任务失败时它
          // 同时"不在未完成集里"（failed 在终态白名单内）⇒ 若先问未完成，失败子被静默略过、
          // 父把子的失败**静默吸收**（实测 02adce34 失败后 106 秒父 M0 照标 completed）。
          // 判据只在 children-gate.ts 一处（开关亦在其内），五处闸同取。
          if (blockFailedChildrenCompletion(db, taskId)) return { content: '任务暂停：有失败子任务未处置', steps: stepCount };
          const unfinishedForFinalize = db.prepare("SELECT id, title FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed','archived')").all(taskId) as Array<{ id: string; title: string }>;
          if (unfinishedForFinalize.length > 0) {
            // zx_20260914: 暂停原因须落库——只发事件则调度器无从区分「等子而暂停」与「用户在停」，
            // 继而把后继子任务一并挡死（见 pause-reason.ts 头注释的互锁）。
            const pendingNames = unfinishedForFinalize.map(c => c.title).join('; ');
            // zx_20260914 M0.5-3: 该暂停此前**静默**——其余 6 个暂停点都告知创建人，独此一路不告知，
            // 用户只能自己去 GUI 翻（f07ad74a 实机即如此）。措辞须如实：这不是故障，子任务完成后会自动恢复。
            pauseTask(db, { taskId, reason: PAUSE_REASON_CHILDREN_INCOMPLETE, note: `仍有 ${unfinishedForFinalize.length} 个子任务未完成（${pendingNames}）——非故障，待其完成后自动恢复` });
            db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
              .run(crypto.randomUUID(), taskId, `[未收口] 仍有 ${unfinishedForFinalize.length} 个子任务未完成（${pendingNames}）——已暂停而非标完成；待子任务完成后自动恢复，或人工处置。`);
            logger.warn({ taskId: taskId.slice(0, 8), unfinished: unfinishedForFinalize.length }, 'finalize 收口前有未完成子任务，改置 paused 不标完成');
            return { content: '任务暂停：仍有未完成子任务', steps: stepCount };
          }
          db.prepare("UPDATE wa_tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(taskId);
          // zx_20260915 P0-2(d)(同一把尺·两个出口同一形状): finalize 路此前**不带**验收，只有 run_close 带——
          //   同一事件类型在两个出口上形状不同，下游分不清「走 finalize、账上就是 no_criteria」与
          //   「老生产者没这个字段」，正是 §2.1 病根的同形复发。账取**落库载荷**（finalize_task 收口时已记），
          //   不在此另算一份；无账则 undefined（"没这笔账"≠"账上是未通过"）。
          // zx_20260915 P0-3 A′(成功必带果): 与 run_close 出口**同一构造器**——`quality`/`deliverables`/`run_mutations`
          //   一律取落库载荷（本路 `qualityScore` 局部量此刻尚未声明，取内存值会两处口径不同，见 task-outcome.ts 头注释）。
          eventBus.emit('task.completed', { taskId, task_id: taskId, projectId, ...buildTaskOutcome(db, taskId, fileMutationCount), acceptance: toAcceptanceSummary(readAcceptanceCheck(db, taskId)) }).catch(() => {});
          promoteTaskFileDeliverables(db, taskId, 'finalize_task');
          // zx_20261016_3 M32（「完成出口同一把尺」· 实测照出的**第二处两出口不同尺**）:
          //   finalize_task **工具路**此前**不进策略闭环**——全仓 `adjustProjectStrategy` 只有 run_close
          //   一处调用（`exec-finalize.ts`），于是"经工具收口的任务"与"撞步数上限走 run_close 收口的任务"
          //   在策略学习账上不同尺。此处补上，与 run_close 出口**同一把尺**。
          //   ⚠ 质量分取**封顶后的记账分**（`completion_quality.score`，工具刚按四道封顶写的 `scoreWithCap`）——
          //   本路**不跑**引擎六维评估，故不替它伪造；两把自评各名其尺（见 `control-finalize.ts` 头注释）。
          //   ⚠ metrics 形状与 run_close **同构**，值全在本作用域内（`stepCount`/`totalTokensUsed` 是执行体局部量，
          //   工具够不到 ⇒ 写入端必须在执行体）。
          try {
            const clCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as { completion_quality?: { score?: number } };
            const rawCostCl = (totalPromptTokens / 1000) * inputPricePer1k + (totalCompletionTokens / 1000) * outputPricePer1k;
            const clMetrics: ExecutionMetrics = {
              taskId, projectId, archetype,
              stepsUsed: stepCount, maxSteps,
              toolCalls: toolCallCount,
              totalTokens: (ctx.sideTokens || 0) > 0 ? totalTokensUsed + (ctx.sideTokens || 0) : totalTokensUsed,
              estimatedCost: Math.round(rawCostCl * 1_000_000) / 1_000_000,
              hasDeliverable: realOutputEvidence(db, taskId),
              qualityScore: typeof clCtx.completion_quality?.score === 'number' ? clCtx.completion_quality.score : 70,
              status: 'completed',
              modelName,
              strategy: { modelStrategy: adaptiveStrategy.modelStrategy, temperature: adaptiveStrategy.temperature, maxSteps },
            };
            recordStrategyOutcome(db, projectId, clMetrics);
            adjustProjectStrategy(db, projectId, clMetrics);
          } catch { /* 闭环记账 best-effort */ }
          return { content: '任务已完成', steps: stepCount };
        }
        // zx_20260928 M2: 低分收口（工具串含 `paused_partial`）→ 工具已置 paused（`pauseTask` 落因 + 告知创建人），
        //   此处**只如实补一条会话行并干净返回**，绝不 `UPDATE status='completed'`。与 `finalize_completed` 是
        //   同一段代码的**两个出口**——"完成出口同一把尺"：分不够就停，不是换条路把它记成完成。
        //   放在 `finalize_completed` 之后、`interrupt` 之前（顺序即优先级）。
        if (reasonMsg.includes('finalize_paused')) {
          logger.info({ taskId: taskId.slice(0, 8), steps: stepCount }, '任务 finalize 低分收口，已置 paused 待人工');
          // zx_20260928 M5（D4）: 本路同样补写 `execution_metrics`（与 `finalize_completed` 支、run_close 三处同构）。
          //   ⚠ 人工收口（`finalizeTaskByHuman`）不执行任务 ⇒ 那里**不得**编造 metrics（保持不写）。
          try {
            writeExecutionMetrics(db, taskId, {
              archetype,
              stepsUsed: stepCount,
              totalTokens: (ctx.sideTokens || 0) > 0 ? totalTokensUsed + (ctx.sideTokens || 0) : totalTokensUsed,
              hasDeliverable: realOutputEvidence(db, taskId),
              tokenBreakdown: ctxTokenBreakdown(),
            });
          } catch { /* 指标补写 best-effort */ }
          db.prepare(
            "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
          ).run(crypto.randomUUID(), taskId, '[未达交付] finalize_task 收口分未达交付标准（<60），任务已暂停待人工核验产出——**不是**已完成；请核验后决定"恢复继续"或"标记完成"。');
          return { content: '任务暂停：质量未达交付标准', steps: stepCount };
        }
        // interrupt（工具 / UI 中止 / task:inject 软中断）→ 干净返回，不标记 failed。
        // 注意：task:inject 在 interruptTask 后立即把状态改为 pending，故不能仅凭 status==='paused' 判断中断。
        if (reasonMsg.includes('interrupt')) {
          // interrupt 工具未在 onStepFinish 写会话消息，需补写
          db.prepare(
            "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
          ).run(crypto.randomUUID(), taskId, '[中断] 任务被外部 interrupt 指令停止');
          logger.info({ taskId: taskId.slice(0, 8), reason: reasonMsg }, '任务被 interrupt 中断');
          return { content: reasonMsg, steps: stepCount };
        }
        // A1 (2026-08-31): 目标偏离软重启——置 pending 等 resume-ai-task 重新执行（偏离提醒已作 user 消息写库，恢复时注入），不标记 failed
        if (reasonMsg.includes('goal_deviation_restart')) {
          db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(taskId);
          logger.info({ taskId: taskId.slice(0, 8) }, '目标偏离，软重启纠偏');
          return { content: '[目标偏离重启]', steps: stepCount, goalDeviationRestart: true };
        }
        const curStatus = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status: string } | undefined)?.status;
        if (curStatus === 'paused') {
          // 工具循环/无进展硬暂停（非 interrupt）已在 onStepFinish 写过会话消息
          logger.info({ taskId: taskId.slice(0, 8), reason: reasonMsg }, '任务被硬暂停');
          // zx_20261023_3 批一：每步判据的中止因由是机器词（`status_paused`），回给用户的话须是中文。
          const pausedContent = reasonMsg === 'status_paused' ? '任务已暂停（执行中检测到暂停令，已在当前步后停止）' : (reasonMsg || '任务被暂停');
          return { content: pausedContent, steps: stepCount };
        }
        // zx_20261021_2 D1（知止）：库里已是终态 ⇒ 本 run 不得再写任何结局。
        //   实测事故：`archived` 被 run_close 覆写成 `paused`（9cc5bb81）、又被 finalize 收口覆写成
        //   `completed`（58c60680）。归档路现在会主动 abort（reason 含 `status_terminal:`），
        //   但即便那一拍没赶上，这里也以**库**为准——终态是事实，执行体的推断不是。
        if (isTerminalStatus(curStatus)) {
          logger.info({ taskId: taskId.slice(0, 8), status: curStatus, reason: reasonMsg }, '任务已处于终态，本次执行停止且不改写状态');
          return { content: `任务已处于终态（${curStatus}），本次执行停止`, steps: stepCount };
        }
        // 超时（非暂停、非中断）→ 继续走下方 failed 逻辑
      }
      // zx_20260920_1 M2（维特根斯坦·意义即用法 / 如实告知）: **档外工具调用**的兜底。
      //   模型从旧上下文（收窄前跑过、恢复后重入）或训练先验里叫一个**本档不可用**的工具时，
      //   AI SDK 抛 `NoSuchToolError`。默认会落到下面的 `sdk_failed` 降级重试——而**降级只换模型、
      //   不换工具面**，第二次照旧叫同一个名字 ⇒ 任务 failed。那等于把"工具面是我们收的"谎报成"模型不行"。
      //   ⇒ 落一条**如实**会话消息（点名形态 + 真名 + 本档可用工具）+ **软重启一次**（承 `goal_deviation_restart`
      //   形状），使模型带着这句话重跑；`tool_face_notice_at` 一次性守卫，复发则不再重启、落回既有错误处理。
      //   **不谎报成功，也不无限重启。**
      // ⚠ 先排除已 abort 的情形（finalize 完成 / interrupt / 硬暂停）：那些路径已各自处置过状态，
      //   在它们之后再置 `pending` 会把"用户叫停"改写成"自己重跑"。
      if (NoSuchToolError.isInstance(aiErr) && !controller.signal.aborted) {
        const asked = (aiErr as unknown as { toolName?: string }).toolName || '';
        const notice = buildUnavailableNotice(archetype, asked, toolFace.kept);
        let alreadyNoticed = true;
        if (notice) {
          try {
            const nctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
            if (!nctx.tool_face_notice_at) {
              nctx.tool_face_notice_at = new Date().toISOString();
              db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(nctx), taskId);
              alreadyNoticed = false;
            }
          } catch {
            // 守卫写不成 ⇒ 按"已告知"处理（宁可落回既有错误处理，也不冒无限重启的风险）
            alreadyNoticed = true;
          }
          if (!alreadyNoticed) {
            db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
              .run(crypto.randomUUID(), taskId, `[工具面如实告知] ${notice}`);
            db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(taskId);
            logger.warn({ taskId: taskId.slice(0, 8), toolFace: archetype, asked }, '档外工具调用：已如实告知并软重启一次');
            return { content: `[工具面告知] ${notice}`, steps: stepCount };
          }
          logger.warn({ taskId: taskId.slice(0, 8), toolFace: archetype, asked }, '档外工具调用复发：不再重启，落回既有错误处理');
        }
      }
      const errMsg = (aiErr as Error).message || String(aiErr);
      const fatal = isAccountFatalError(aiErr, errMsg);
      logger.error({ taskId: taskId.slice(0, 8), projectId: projectId.slice(0, 8), modelName, baseUrl, errMsg, statusCode: getSdkErrorStatus(aiErr), fatal }, 'AI SDK 调用失败');
      // A2 (2026-08-31): 首次 SDK 失败 → 标记 sdk_failed 返回（ai-task 重新入队重试一次）；二次失败 → ~~标记 failed~~
      // zx_20260923 M1（T1 裁定）: 二次失败改落 **`paused`**（见下）；且"这一次要不要重试"的判据已由
      //   `sdk-incident.ts` 承担，不再是裸的 `if (!retryCtx.sdk_failed)`。
      // zx_20260922_1 M4（F2 撤回承诺）：原文写"降级重试用非 reasoning 模型"——**不成立**。模型选型只读
      // `sdk_fallback`（`exec-model-select.ts`），`sdk_failed` **无选型读点**（只有"自守事故判据"
      // 与"成功后清理 `delete`"两处非选型读点），`exec-model-select.ts` 里那条
      // "失败重试不再排除 reasoning"（2026-09-01 P2修③）更是明说反话 ⇒ 重试走的还是同一个 reasoning 模型。
      // 承诺已撤，此处与 `[AI引擎失败]` 文案、`jobs/ai-task.ts` 两处注释同步订正为同一句话：**本次重试不换模型。**
      let retryCtx: Record<string, unknown> = {};
      try {
        // 从数据库重读最新 context_json（而非 task 快照），避免覆盖执行中写入的 task_goal/tokens_used/budget 等修改
        const latestRow = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
        retryCtx = JSON.parse(latestRow?.context_json || '{}');
      } catch { /* 忽略 */ }
      // A4 (2026-08-31): 账户级故障（余额/鉴权/权限，401/402/403）——与模型能力无关，降级到非 reasoning 无用。
      // 首次 → 记录 ANS 已算好的跨 provider 备用（fallback），复用降级重试切过去；备用不存在或备用也失败 → 暂停并通知用户。
      const sdkFallbackCfg = (mr.fallback as { url?: string; api_key?: string; model_name?: string; capabilities?: string[] } | undefined);
      const hasFreshFallback = !retryCtx.sdk_fallback && sdkFallbackCfg?.url && sdkFallbackCfg.model_name && sdkFallbackCfg.url !== baseUrl;
      if (fatal || retryCtx.sdk_fallback) {
        if (fatal && hasFreshFallback) {
          // zx_20260929 M6-1b: 备用 provider 的**能力清单**随它一起落库，供恢复后重跑回验
          //   （`exec-model-select.ts` 的「换完再回验」）。此前只落 url/key/model_name ⇒ 恢复后读回
          //   这一格**没有任何字段可比对**，"已回验"这句账实际不成立。
          //   ⚠ 值是 `undefined`（旧 ANS 未带 capabilities）时 `JSON.stringify` **丢弃该键**——
          //     这正是想要的编码：**键缺席 = 无从比对**（不编"不符"），与"实得空清单"区别开。
          retryCtx.sdk_fallback = { url: sdkFallbackCfg!.url, api_key: sdkFallbackCfg!.api_key || '', model_name: sdkFallbackCfg!.model_name, capabilities: sdkFallbackCfg!.capabilities };
          openSdkIncident(retryCtx, new Date().toISOString());
          retryCtx.sdk_fatal = { statusCode: getSdkErrorStatus(aiErr), provider: baseUrl, model: modelName, errMsg, occurredAt: new Date().toISOString() };
          db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(retryCtx), taskId);
          db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(taskId);
          db.prepare(
            "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
          ).run(crypto.randomUUID(), taskId, `[AI账户级故障] ${errMsg}。已自动切换备用 provider（${sdkFallbackCfg!.model_name}）重试。`);
          logger.warn({ taskId: taskId.slice(0, 8), errMsg, fallback: sdkFallbackCfg!.model_name }, 'AI账户级故障，切换备用 provider');
          return { content: '', steps: stepCount, sdkFailed: true };
        }
        // 无备用 或 备用也失败 → 暂停（可恢复），交由 handler 推送失败通知，不再无限重试
        // 若为备用也失败，清除 sdk_fallback——用户充值/处理后手动恢复时将回到主 provider（而非继续锁定已故障的备用）
        delete retryCtx.sdk_fallback;
        retryCtx.sdk_fatal = { statusCode: getSdkErrorStatus(aiErr), provider: baseUrl, model: modelName, errMsg, occurredAt: new Date().toISOString() };
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(retryCtx), taskId);
        // A4 修② (2026-08-31): 补发状态事件，否则桌面任务列表（只监听 status_changed 事件、不轮询）停留在 executing 旧状态。
        //   zx_20260917 M1: 事件随 `pauseTask` 一起发。**不传 `note`**——故障通知已由 handler 另发，
        //   此处再发一条即"一次停两条通知"（属 M2「告」面裁定范围，本批不动既有告知行为）。
        pauseTask(db, { taskId, reason: PAUSE_REASON_AI_PROVIDER_FAILED });
        db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), taskId, `[AI账户级故障] ${errMsg}。任务已暂停，请充值或切换 AI 供应商后恢复。`);
        logger.warn({ taskId: taskId.slice(0, 8), errMsg }, 'AI账户级故障，任务暂停等待人工处理');
        return { content: '', steps: stepCount, sdkFailed: true, sdkFatal: true };
      }
      // zx_20260923 M1-a/G2：判据从"旗在不在"改为"**这一面旗是不是这一次立起来的**"。
      //   旗由 `sdk-incident.ts` 记账（立旗带起始时刻）；**用户手动恢复即新事故**（`jobs/ai-task.ts`
      //   的 resume 路按 `initiator==='user'` 清旗）⇒ 引擎自动重试这条链上旗保留，用户恢复后重新获得额度。
      if (!hasOpenSdkIncident(retryCtx)) {
        openSdkIncident(retryCtx, new Date().toISOString());
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(retryCtx), taskId);
        // 置 pending（类似偏离软重启），避免 resume 处理器防重入检查（status='executing'）跳过这次重试
        db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(taskId);
        db.prepare(
          "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
        ).run(crypto.randomUUID(), taskId, `[AI引擎失败] ${errMsg}。已自动重试一次；若再次失败将暂停任务，等待人工恢复（恢复后重新获得一次重试）。`);
        logger.warn({ taskId: taskId.slice(0, 8), errMsg }, 'AI SDK 失败，重新入队重试一次');
        return { content: '', steps: stepCount, sdkFailed: true };
      }
      // 二次失败 → **落 `paused`**（T1 裁定：SDK 故障与任务内容无关，记成 `failed` 是把外部故障记在任务头上）。
      //   ⚠ 此处**不再 `throw`**（G4）：原先抛出去会冒到外层 catch 再发一条 `execute_error` 的
      //   `task.failed`，一次失败两条事件（标本 31086 `sdk` / 31087 `execute_error`）。
      //   也不发 `task.failed`——状态是 `paused`，告知由 `pauseTask` 的 `note` 走（与账户级故障同形）。
      //   ⚠ 返回 `sdkExhausted` 供 handler 与"自动重试"区分：否则 handler 见 `sdkFailed` 又入队 resume，
      //   与本次暂停构成 pause→resume→pause 死循环。
      pauseTask(db, { taskId, reason: PAUSE_REASON_AI_SDK_UNAVAILABLE, note: `AI 引擎连续失败两次，自动重试已用尽：${errMsg}` });
      db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
      ).run(crypto.randomUUID(), taskId, `[AI引擎不可用] ${errMsg}。已连续失败两次，任务已暂停，等待人工处理后恢复（恢复后重新获得一次重试）。`);
      logger.warn({ taskId: taskId.slice(0, 8), errMsg }, 'AI SDK 连续失败，任务暂停等待人工恢复');
      return { content: '', steps: stepCount, sdkFailed: true, sdkExhausted: true };
    } finally {
      clearTimeout(timeoutTimer);
      // 注销**不在此处**：收口段（审计/质检/收口闸）仍在跑，期间按暂停也应能真断；
      // 统一由最外层 finally 注销（zx_20261023_3 批一）。
    }

    // 5. ask_user 调用后不标记完成（等待用户回复）
    if (askUserCalled) {
      console.log(`[Agent] 任务等待用户输入: ${title.slice(0, 50)}`);
      return { content: finalContent || '等待用户输入...', steps: stepCount };
    }

    // B2: 执行后审计世界模型一致性（对比执行前快照）
    // zx_20260916_1 M3: 传入 dataDir——大批变更的完整清单要落 data/world-snapshot-diffs/<taskId>.json
    //   （caller 注入而非模块内解析：world-snapshot 零 electron，与 quarantine 目录同一口径）
    try {
      await auditWorldConsistency(db, taskId, projectId, (tid, role, content) => {
        db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, ?, ?, 0, datetime('now'))")
          .run(crypto.randomUUID(), tid, role, content);
      }, { dataDir: ctx.dataDir });
    } catch {}

    // 6. 完成质量评估（产出物大小 + 过早finalize检测）+ 成本估算
    // zx_20260916_3 M4（O-D）: 此处是**首次**评估，供电闸（`<20`）与首次落账用；收口验收跑完后本值会被
    //   **重算并覆盖**（`let` 之由）——见下方"收口验收前移 + 完成分重算"那段。先评一次而非只评一次，
    //   是因为两道产出闸与"无产出"判定必须先有分才能决定去留；而验收锚定的那部分事实（`acceptance_check`）
    //   要等验收跑完才是新鲜的。
    let qualityScore = assessCompletionQuality(db, taskId, stepCount, totalTokensUsed, maxTokens, maxSteps, workingDir, archetype);
    const ctxJson = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
    // B3 (2026-09-03): 目标达成维度——有显式目标时以「偏离未到上限 且 质量分 ≥60」判达成；无显式目标以质量分为准
    // zx_20260910_3 M2c: 上限改由 goalDeviationCapReached 判定（原 `deviationRestarts <= 2` 与守卫 `<3`、闸 `>=2` 三处各写一个界）
    // zx_20260916_3 M3（判据 C3）: 判据与形状一并收到 `task-outcome.ts`——本路不再自己拼对象，
    //   与 finalize / update_task_status / task:updateStatus 三路**同一构造器**（原先各拼一份，正是 O-C 的病根）。
    const goalDefined = !!(ctxJson.task_goal as { goal?: string } | undefined)?.goal;
    const goalAchieved = goalAchievedOf(goalDefined, ctxJson.goal_deviation_restarts, qualityScore.score);
    ctxJson.goal_achieved = goalAchieved;
    ctxJson.completion_quality = buildCompletionAccount({
      score: qualityScore.score,
      goalAchieved,
      via: 'run_close',
      feedback: qualityScore.feedback,
    });
    // 成本估算（基于ANS模型真实定价 + 输入/输出token）——zx_20260904_7: 统一按人民币(CNY)展示，按模型 provider 币种换算
    const rawCost = (totalPromptTokens / 1000) * inputPricePer1k + (totalCompletionTokens / 1000) * outputPricePer1k; // provider 原币种价
    const inUsd = modelPriceInUsd(modelName);
    const cnyRate = inUsd ? USD_TO_CNY_RATE : 1;
    const estimatedCostCny = rawCost * cnyRate;
    const ce: Record<string, unknown> = {
      cost: Math.round(estimatedCostCny * 1_000_000) / 1_000_000,
      currency: 'CNY',
      tokens: totalTokensUsed,
      inputTokens: totalPromptTokens,
      outputTokens: totalCompletionTokens,
      inputPricePer1k,
      outputPricePer1k,
      model: modelName,
    };
    if (inUsd) { ce.cost_usd = Math.round(rawCost * 1_000_000) / 1_000_000; ce.cny_rate = USD_TO_CNY_RATE; }
    // 省耗账实(2026-09-06 zx_1 1a): 旁路子 LLM(验收/内容校验/目标偏离核对) token 并账——token 数/历史均值如实(预算档位据此不低估真实花费)
    const sideAtFirstPersist = ctx.sideTokens || 0;
    if (sideAtFirstPersist > 0) {
      ce.tokens = totalTokensUsed + sideAtFirstPersist;
      ce.sideTokens = sideAtFirstPersist;
    }
    ctxJson.cost_estimate = ce;
    ctxJson.last_model = modelName;
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), taskId);
    // 星星之火：执行指标（供成功模式识别）——zx_20261018_1 批七起经唯一写口合并写。
    writeExecutionMetrics(db, taskId, {
      archetype,
      stepsUsed: stepCount,
      totalTokens: sideAtFirstPersist > 0 ? totalTokensUsed + sideAtFirstPersist : totalTokensUsed,
      // zx_20260906 批2: 有无产出以真实成果为据（doc 落盘/服务生命周期/代码 write|edit），不再用 score≥60 代理
      hasDeliverable: realOutputEvidence(db, taskId),
      tokenBreakdown: ctxTokenBreakdown(),
    });
    syncQualityColumn(db, taskId);

    // 7. 存储最终响应 + 完成任务
    // zx_20260916_1 M4 (#5): 撞顶事实进交付文本。位置刻意选在此处（而非 `finalContent = await result.text`）：
    //   那里在 try 块内、`ctxJson` 尚不可达（拿不到 `task_goal.goal`）；此处 `ctxJson` 已在手，
    //   且此后**所有** `return { content: finalContent }` 的非完成出口（无产出 failed / 硬暂停 / 产出未落盘 /
    //   内容不充分 / 过早结束 paused）一律带上该事实——"没做完"不能被任何一条出口吞掉。
    //   判据取 `stepsCapReached`（用满 `maxSteps` 才算被截，断言必须为真）；闸门侧的 `maxSteps - 2` 是另一把尺。
    //   若末步无文本（`result.text` 为空）而撞顶，注入后 `finalContent` 非空 ⇒ "无回话"变为"一条说明被上限截断的回话"，
    //   这正是本设计所求（§1.5 的病根就是用户无从判断）。
    // zx_20261021_4 批四（毛选·反对本本主义「没有调查，没有发言权」）：用户点「恢复」时，引擎必须真的
    //   多给预算——旧实现恢复后按同一公式重算 ⇒ 原样再撞（`03c71f39` 恢复两次撞两次）。故撞顶当刻就把
    //   本次上限记进 `step_budget_bonus`，下一轮 `resolveMaxSteps` 叠加；次数有界（3），到顶后如实说"不再加"。
    //   未撞顶则清掉旧撞顶账——上一轮的续额事实不属于本轮，留着会让后续暂停说明引用不存在的许诺。
    if (stepsCapReached(maxSteps, stepCount)) {
      const grant = grantStepBudgetOnCapHit(ctxJson, maxSteps);
      ctxJson.step_cap_hit = {
        count: grant.grants,
        steps: stepCount,
        max_steps: maxSteps,
        resume_bonus: grant.granted ? grant.grantedSteps : null,
        at: new Date().toISOString(),
      };
      const continuation = stepCapContinuationOf(ctxJson);
      // 撞顶账须当场落库：`ctxJson` 在 2581 已写过一次，此后 exec-close 会另读一份 ctx 落账，
      //   不在这里写回则续额只活在本次内存里——恢复后原样再撞（正是本轮要修的病）。
      try { db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), taskId); } catch { /* 落库失败不阻断收口 */ }
      finalContent = `${finalContent ? `${finalContent}\n\n` : ''}${buildStepCapNote(maxSteps, String((ctxJson.task_goal as { goal?: string } | undefined)?.goal || ''))}${continuation ? `\n\n${buildStepContinuationNote(continuation)}` : ''}`;
    } else if (ctxJson.step_cap_hit) {
      delete ctxJson.step_cap_hit;
      try { db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), taskId); } catch { /* 清账失败不阻断收口 */ }
    }
    if (finalContent) {
      db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'assistant', ?, 0, datetime('now'))"
      ).run(crypto.randomUUID(), taskId, finalContent.slice(0, 50_000));
    }

    // 无产出物且无对话 → 任务实际未达成目标，标记为 failed（而非误导性的 completed）
    if (qualityScore.score < 20) {
      db.prepare(
        "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
      ).run(crypto.randomUUID(), taskId, '[执行未达标] 任务未产生产出物或有效对话，判定为失败');
      markTaskFailed(db, taskId);
      eventBus.emit('task.failed', taskFailedPayload(db, taskId, projectId, 'no_output', `未产生产出物或有效对话（质量 ${qualityScore.score} 分）`)).catch(() => {});
      logger.warn({ taskId: taskId.slice(0, 8), steps: stepCount, score: qualityScore.score }, '任务无产出物，标记为failed');
      // C3: 记录失败经验（供 resume 注入，避免重复相同错误）
      try {
        const failCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        failCtx.failure_record = {
          reason: '无产出物',
          toolCount: toolCallCount,
          tools: [...new Set(recentToolNames)].slice(-5),
          stepsUsed: stepCount,
        };
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(failCtx), taskId);
      } catch {}
      // 道法自然：无产出物失败 → 调整项目策略
      try {
        adjustProjectStrategy(db, projectId, {
          taskId, projectId, archetype,
          stepsUsed: stepCount, maxSteps,
          toolCalls: toolCallCount,
          totalTokens: totalTokensUsed,
          estimatedCost: Math.round(rawCost * 1_000_000) / 1_000_000,
          hasDeliverable: false,
          // zx_20261016_3 M32: 质量分入闸（本路必 <20，必落低带）。
          qualityScore: qualityScore.score,
          status: 'failed',
          modelName,
        });
      } catch {}
      return { content: finalContent, steps: stepCount };
    }

    // 硬暂停（工具循环/无进展）时不覆盖为 completed，保持 paused 等待人工介入
    if (degradationLevel === 3) {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
        .run(crypto.randomUUID(), taskId, '[硬暂停] 任务因工具循环/无进展被硬暂停，保持暂停状态等待人工介入，未自动完成。');
      logger.warn({ taskId: taskId.slice(0, 8) }, '任务被硬暂停，不标记完成');
      return { content: '任务被硬暂停，未自动完成', steps: stepCount };
    }

    // zx_20260904_3 D1/D4 (2026-09-04): 交付物"实践检验"门禁——要求产出指定文件却未落盘 → 不得标 completed。
    // 模型把"我将写文档"当终答属"知而不行"：完成须以交付动作被执行为据，LLM 自评不作完成依据。
    const missOutputs = expectedOutputMiss(db, taskId, workingDir);
    if (missOutputs.length > 0) {
      const retries = Number(ctxJson.deliverable_missing_retries) || 0;
      ctxJson.deliverable_missing_retries = retries + 1;
      ctxJson.deliverable_unfulfilled = { paths: missOutputs, note: '产出文件未落盘或为空', retries: retries + 1 };
      // zx_20260916_3 M3（判据 C3）: 账必与顶层同值——本道门禁在完成账**之后**跑（同一次收口内），
      //   只改顶层会让"账上说达成、顶层说未达成"在同一份 context_json 里并存（`5126b303` 的同形）。
      markGoalNotAchieved(ctxJson);
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), taskId);
      // zx_20260923 M6-c（G16）：额度耗尽这一支原写"请人工介入核实产出内容"——**说不出按哪儿**，
      //   而当时唯一的出路确实是手工动库（G16 记的正是那次手工）。现点名**当刻就存在**的出口：
      //   任务管理的「恢复（保留对话）」（M6-a 之后它**真的**再给一次自动补跑额度 ⇒ 承诺有人兑现）、
      //   「回复」（`TaskDetailPage.tsx` 弹框附言后 `tasks.resume(id, text)` ⇒ `reply` 落会话并随恢复注入）、
      //   以及路径确不需要该产出时的「完成」（人工收口会经 `update_task_status` 如实标注未经成果门禁）。
      const guidance = retries >= 1
        ? '已多次尝试仍未落盘，本任务保持未完成（不标完成）。在任务管理点「恢复（保留对话）」即重新获得一次自动补跑额度；用「回复」可附一句说明如何补齐；若确认本任务无需该产出，可用「完成」人工收口（会如实标注未经成果门禁）。'
        : '请使用 write_file 或输出命令实际写入该文件（写入后再结束），勿仅以文字说明完成。';
      const msg = `[产出未落盘] 任务要求产出文件但未检测到实际文件：${missOutputs.join('、')}。${guidance}`;
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))").run(crypto.randomUUID(), taskId, msg);
      if (retries < 1) {
        // D4：再给一轮补写（恢复 + 携带"产出未落盘"纠正提示）
        db.prepare("UPDATE wa_tasks SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(taskId);
        enqueueJob(db, 'resume-ai-task', { taskId, projectId, message: msg });
        eventBus.emit('task.status_changed', { taskId, task_id: taskId, projectId, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
        logger.warn({ taskId: taskId.slice(0, 8), missing: missOutputs }, '产出未落盘，自动恢复一轮补写');
      } else {
        // 多次未落盘 → 保持暂停待人工介入，绝不误标 completed
        // zx_20260909_1 M1(A1): 产出多次未落盘需人工→通知创建人（zx_20260917 M1：同经 `pauseTask` 一次写全）
        pauseTask(db, { taskId, reason: PAUSE_REASON_OUTPUT_MISSING, note: `产出文件多次未落盘：${missOutputs.join('、')}` });
        logger.warn({ taskId: taskId.slice(0, 8), missing: missOutputs }, '产出多次未落盘，任务保持暂停待人工介入');
      }
      return { content: finalContent, steps: stepCount };
    }

    // zx_20260929 M9（重构·只动形不动义）: 收尾段（产出充分性门禁 → 省耗账实并账 → 收口验收前移 + 完成分重算
    //   → D1「过早结束」闸 → 陈旧标记清理 → `finalizeRunClose` 接线）已整段搬至 `core/exec-close.ts`；
    //   `executeTask` 退为编排者，此处只剩接线。
    //   ⚠ 返回的就是 `executeTask` 本该返回的 `{ content, steps }`——三个早退口（内容不充分补全失败 /
    //     内容不充分暂停 / D1 过早结束）与达标收尾同在该函数内，故此处直接 `return`，不再回传中间量。
    //   ⚠ 顺序与搬迁前逐字一致：不得把本调用提到上方两道产出闸（产出未落盘 / 内容不充分）之前。
    return runCloseSection({
      db, ctx, taskId, projectId, workingDir, archetype, adaptiveStrategy,
      title, modelName, maxSteps, maxTokens,
      stepCount, totalTokensUsed, toolCallCount, fileMutationCount, finalContent, rawCost,
      sideAtFirstPersist, goalDefined, ctxJson,
    });
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error(`[Agent] 任务失败: ${title.slice(0, 50)}`, errorMsg);
    db.prepare(
      "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))"
    ).run(crypto.randomUUID(), taskId, `[执行失败] ${errorMsg}`);
    markTaskFailed(db, taskId);
    eventBus.emit('task.failed', taskFailedPayload(db, taskId, projectId, 'execute_error', errorMsg)).catch(() => {});
    throw err;
  } finally {
    // zx_20260929 M3（用完就收）：无论走哪个出口（达标收尾 / 三个早退口 / 抛错），
    //   本次运行的归一化 WAV 都收掉。**永不抛**（见 `cleanTranscribeTmp`），故它不会改变任何返回值，
    //   也不会把"任务跑完了"变成"任务失败了"。
    await cleanTranscribeTmp(transcribeTmp);
    // zx_20261023_3 批一：认领后登记的中断句柄，在**所有**出口统一注销（幂等：只删自己那一个）。
    unregisterTaskRun(taskId, controller);
  }
}

/**
 * Phase A (2026-08-26) 慎终如始：LLM 逐条核对验收标准。
 *
 * zx_20260910_3 M1（维特根斯坦·意义即用法／道德经·七十一章「知不知，上」）：
 * 返回**可判定的结局**而非同一个 `null`——无模型／未吐 JSON／异常／真通过四种结局分列，
 * 且**四个出口都落 ctxJson.acceptance_check**（带 verified 标记）。
 * 此前四种结局共用一个无名 `null`、且只有"真通过"才落库 ⇒ 真库 `acceptance_check` 写入数 0、
 * 而调用方一律记 `[PASS]`（冒名）。**不阻断语义不变**：只有"真拒收"才返回拦截串。
 */
/**
 * 规划/实施类任务、且任务上没有用户许诺的判据 ⇒ 从**任务自身**代拟可机检判据（zx_20260916 M1）。
 * 非规划类、或一条依据都找不到 ⇒ 返回 `null` ⇒ 调用方回落 `no_criteria`（不得为凑数编判据）。
 *
 * 判据清单取**已滤探针**的产出物（`docNotProbe` —— 同一把唯一的尺，不在此复刻第二份探针正则）。
 * 只读、零副作用；导出供受控回归直跑真实现。
 */
export function proposeAcceptanceForTask(db: Database.Database, taskId: string): ProposedCriteria | null {
  try {
    const t = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title?: string; description?: string } | undefined;
    if (!t) return null;
    if (!isPlanOrImplTask(`${t.title ?? ''} ${t.description ?? ''}`)) return null;
    const deliverables = db.prepare(
      `SELECT name, type, status, file_path FROM wa_deliverables WHERE task_id = ? AND ${docNotProbe('')}`,
    ).all(taskId) as Array<{ name: string; type: string; status: string; file_path: string | null }>;
    // zx_20261022_1 批三：相对路径字面量按**本项目工作目录**解析（不再按进程 cwd、也不只剩在册行一条路）。
    //   读不到 working_dir ⇒ 不注入 ⇒ 代拟②照旧如实记"相对路径无法解析"，不猜。
    let workingDir = '';
    try {
      const p = db.prepare('SELECT working_dir FROM wa_projects WHERE id = (SELECT project_id FROM wa_tasks WHERE id = ?)')
        .get(taskId) as { working_dir?: string | null } | undefined;
      workingDir = String(p?.working_dir ?? '').trim();
    } catch { /* 读不到项目行 ⇒ 只少这一条解析基准，不阻断代拟 */ }
    const proposed = proposeAcceptanceCriteria({
      title: t.title, description: t.description, deliverables,
      pathExists: (p) => fs.existsSync(p),
      resolveRelative: workingDir ? (p) => (path.isAbsolute(p) ? p : path.join(workingDir, p)) : undefined,
    });
    return proposed.proposed.length > 0 ? proposed : null;
  } catch {
    return null; // 取数失败 ⇒ 回落 no_criteria（如实"无人许诺"，不编判据）
  }
}

/**
 * zx_20260917 M5-4：目标偏离理由的字符上限——**唯一真源**（判据与文案同处取名，防两处各写一个数）。
 * 超限时**不静默截断**：尾部追加「…（理由已截断，共 N 字）」，≤上限者一字不加。
 */
export const GOAL_DEVIATION_REASON_LIMIT = 100;

/**
 * 按上述上限裁理由，**真截断时**才在尾部如实标注（≤上限一字不加）。
 *
 * 抽成纯函数只为让受控回归能对**实现本尊**跑正反两只标本（长含标记 / 短不含）：
 * 留在 `checkGoalDeviation` 体内的话，唯一入口要先过 LLM，判据就只能退化成"源码里有没有那行字"——
 * 那种断言扫的是文本不是行为，改名/挪位都骗得过它。
 */
export function truncateGoalDeviationReason(rawReason: string): string {
  return rawReason.length > GOAL_DEVIATION_REASON_LIMIT
    ? `${rawReason.slice(0, GOAL_DEVIATION_REASON_LIMIT)}…（理由已截断，共 ${rawReason.length} 字）`
    : rawReason;
}

export async function checkAcceptanceCriteria(
  ctx: AgentContext,
  db: Database.Database,
  taskId: string,
  criteria: string,
): Promise<{ outcome: AcceptanceOutcome; block: string | null; payload: AcceptanceCheckPayload }> {
  // zx_20260915 P0-2(a)（维特根斯坦·意义即用法）: 「没设验收标准」也是一种**可判定结局**——
  //   此前调用方用 `if (criteria.trim())` 直接跳过，于是"没标准"与"验收通过"在库里同名（都无痕）。
  //   现进入即落一笔 `reason:'no_criteria'`，且 `verified:false` ⇒ `isAcceptanceVerified` 必返回 false
  //   （核心不变量：**没标准 ≠ 通过**）。不调 LLM、不耗 token。
  if (!criteria.trim()) {
    // zx_20260916 M1（维特根斯坦·家族相似 / 道德经·七十一章「知不知，上」）：「无人许诺」有两种——
    //   「无人许诺、也无从代拟」与「无人许诺、但引擎已代拟并逐条自核」，两者**不得混名**。
    //   规划类任务本职即产出方案，"方案写入指定路径"这类判据客观存在且可机检，缺的只是"有人写下来"。
    //   ⚠ 同时**仍不是"验过"**：引擎拟题 + 引擎判卷 = 自证 ⇒ 载荷 `verified:false`，下游绝不打 ✓。
    const proposed = proposeAcceptanceForTask(db, taskId);
    if (proposed) {
      const payload = recordProposedCheck(db, taskId, proposed);
      return { outcome: { ran: false, reason: 'no_user_criteria' }, block: null, payload };
    }
    const decided = { outcome: { ran: false, reason: 'no_criteria' } as AcceptanceOutcome, checks: [] as [] };
    const payload = recordAcceptanceOutcome(db, taskId, decided);
    return { outcome: decided.outcome, block: null, payload };
  }
  let kind: 'ok' | 'no_model' | 'exception' = 'ok';
  let text: string | null = null;
  try {
    // zx_20260917 M4（§6.1/6.2）: 取数与渲染收口到 `collectEvidence`/`renderEvidence`——
    //   从前这里**自己**以 `task_id = 本任务` 为界问四处（`convs`/`deliverables`/`docFiles`/`validationSummary`），
    //   于是「父持方案、子干活」的子任务只能看见自己那点自述 ⇒ 盲判。
    //   两处改动：产出物两路改走**整棵树**；渲染仍是这一段（提示词形状逐字节不变）。
    const evidenceBase = renderEvidence(
      collectEvidence(db, taskId),
      (p) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; } catch { return null; } },
    );
    // zx_20261022_3 批十二：DoD 里"编译通过 / 行数 / 未提交"这类条目要**执行面证据**——
    //   判卷器是纯文本 LLM，故由引擎只读跑 git（范围限本任务自有文件）后并入证据。
    let repoEvidence = '';
    try { repoEvidence = await renderOwnedRepoEvidence(db, taskId); } catch { /* 取证失败不改判卷输入 */ }
    const evidence = repoEvidence
      ? `${evidenceBase}\n\n【本任务自有文件的仓库状态（引擎只读执行，非模型自述）】\n${repoEvidence}`
      : evidenceBase;

    const ansClient = await ctx.getAnsClient();
    const m = await ansClient.getOptimalModel(auxModelRequest()) as Record<string, unknown>;
    if (!m?.url || !m?.api_key || !m?.model_name) {
      kind = 'no_model'; // 出口①：无可用模型（如实记，不冒名通过）
    } else {
      const { generateText } = await import('ai');
      const provider = createSafeProvider({ apiKey: m.api_key as string, baseURL: m.url as string });
      const result = await generateText({
        model: provider.chat(m.model_name as string),
        temperature: 0.1,
        maxTokens: (m.max_output_tokens as number | undefined) || 4096,
        // zx_20260910_3 M1b: 补超时——本函数此前**无** abortSignal（可无限挂起），而 checkGoalDeviation 有 15s。
        // 取 30s（对照压缩路径 :30s）：验收提示词含 4 份产出摘录 + 内容校验 + 5 条会话，体量大于 goal-deviation；
        // 截断过短会把"真通过"记成 error ＝另一种失实。超时→catch→如实落 verified:false/reason:'error'，不冒名。
        abortSignal: AbortSignal.timeout(30_000),
        // zx_20261021_4 批三（道德经·六十四章「慎终如始」）：**只按下列证据判卷**。此前判卷把任务树里
        //   同名旧版文档也读进来，遂对着已废止的方案判新交付（`f79b1abb` 假阴性）：旧地图判新路。
        prompt: `以下是工蚁系统一个任务的验收标准与已完成工作内容。请逐条判断验收标准是否已达成。\n\n验收标准：\n${criteria}\n\n已完成工作：\n${evidence || '（无产出记录）'}\n\n只按下所列文件与记录判卷；未列出的旧版本不是本轮交付，不得据其判定未达成。\n\n输出 JSON 数组：[{"criterion":"...","passed":true/false,"reason":"..."}]，每条验收标准对应一项。只输出 JSON，不要其他文字。`,
      });
      text = result.text || '';
      // 省耗账实(1a): 验收为旁路子 LLM——usage 记入执行期账本，收口并账(不入步进，防双计)
      addSideTokens(ctx, usageTokensOf(result as unknown as { usage?: unknown; text?: string }, criteria + evidence));
    }
  } catch (err) {
    kind = 'exception'; // 出口③：核对异常（同样落账，避免 LLM 故障卡死 finalize）
    // zx_20260923_1 M2: 此处此前是**裸 catch**——异常原因一个字都不落，真库标本 `a290ae2b` 的
    //   `reason:'error'` 事后无从追溯（是超时？是 401？）。存量纪律：失败要留得下可追的痕。
    logger.warn({ taskId: taskId.slice(0, 8), err: err instanceof Error ? err.message : String(err) }, '验收核对异常——如实落 error，不冒名通过');
  }

  const decided = decideAcceptanceOutcome({ kind, text });
  // 四出口归一：无模型/未吐 JSON/异常/真通过**都**在这里落一笔（此前只有真通过才落库 ⇒ 台账恒 0）
  // zx_20260923_1 M1: 返回值是**账上生效的那一笔**——若本条是"非结论"而账上已有真结论，
  //   守卫会保留旧账（`maySupersedeLedger`），此时 `payload.verified === true` 表明"我这笔没落上"。
  //   如实留痕：不得让"这次没判成"悄悄把旧结论顶掉（真库标本 §1.1 正是这样被洗成"没证据"的）。
  const payload = recordAcceptanceOutcome(db, taskId, decided);
  if (!decided.outcome.ran && payload.verified === true) {
    logger.warn({ taskId: taskId.slice(0, 8), reason: decided.outcome.reason, kept: payload.checked_at }, '本次验收未取得结论，账上既有结论未被覆盖（账本守卫保留旧账）');
  }
  const block = decided.outcome.ran && !decided.outcome.passed ? decided.outcome.block : null;

  // B1 (2026-08-31): 验收失败 → storeText 记忆（毛选实践论——验收失败沉淀为记忆，供下次执行预警）
  if (block) {
    try {
      if (ctx.memory) {
        const taskRow = db.prepare('SELECT project_id, title FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string; title: string } | undefined;
        if (taskRow) {
          const failedItems = payload.failed.map(f => f.criterion).join('、');
          const content = `任务「${taskRow.title}」验收未达：${failedItems}`;
          // zx_20260929 M4（维特根斯坦·同一个降权三处是三个意思 / 管子·度量衡）：**同源替换优先**。
          //   本条的读者只有一处——`memory-context.ts` 的 `retrieveByType('acceptance_failure', …, 3)`，
          //   而旧写法直写 ⇒ 同一项目每失败一次追加一行，**自家副本挤占自家 top3 名额**：
          //   连续失败两次后，那一格只剩"同一个任务的两条流水"，真正的历史教训被顶出去。
          //   同源键是 `source`（'acceptance_check' 每项目恒一）⇒ 命中即"内容追加"，去重与
          //   `promoteWorkingMemory` 用**同一把尺**（`sameSourceReplace`），不另立阈值。
          //   未命中（首次）才落新行——返回 null 即"这一源还没有过"，不是失败。
          const replaced = ctx.memory.sameSourceReplace(taskRow.project_id, 'acceptance_check', content);
          if (!replaced) {
            ctx.memory.storeText({ project_id: taskRow.project_id, task_id: taskId, type: 'acceptance_failure', content, source: 'acceptance_check' });
          }
          // zx_20261023_5 批二（「只生成不自动生效」）：同一次失败**另**落一张 pending pitfall 卡，
          //   下一次蒸馏才并入 active——本次失败的原因还没被任何后续证据检验过，不能立刻当"知识"注入。
          recordPitfallCandidate(db, taskRow.project_id, { taskTitle: taskRow.title, failedItems });
        }
      }
    } catch { /* 验收失败记忆 best-effort */ }
  }
  return { outcome: decided.outcome, block, payload };
}

/**
 * zx_20260915 M4/P0-6(e): 偏离判定器的**提示词构造**——纯函数导出，故 rr 可直跑真实现。
 *
 * 两条注入规则，都是"别让判定器只看半句话"：
 * ① `successCriteria`（成功标准）：只说"核心目标"时，判定器看到的是一句抽象的意图；
 *    `success_criteria` 是同一份立志里**共同定义"要做什么"**的另一半，漏掉它＝判据自身残缺。
 *    词用「**成功标准**」而非「验收标准」——`acceptance_criteria` 在本仓已是**另一个概念**的专名
 *    （交付物验收），沿用即一个词指两件事。
 * ② `toolNames` 里有产出性写入时，补一条**与既有 blockerNote 同形**的免责：
 *    落产出是"在干活"的廉价而强的信号，此时"偏离"几乎必是误判。
 *
 * ⚠ 出口**不再二次裁剪**（旧版 prompt 里有 `recentText.slice(0, 600)`）——上界由调用侧构造保证
 * （3×400 + 工具名行）；再截一刀等于输入面加宽了而出口仍只有 600，白加一场。
 *
 * ③④ zx_20260917 M5c：两路**又**加宽（各自独立、各有其失明，§7ter.1）——
 *    `completedItems`（已完成项账本：落盘文件+时刻序、已登记产出物）治**无知论证**（"未提及"被读成"未做"）；
 *    `userDirective`（用户/系统最近的指令）治**证据被排除在外**（只取 `role='assistant'`）。
 *    两个尾参**可选且缺省即不出现**（K4：不传时输出与改前**逐字相同**）。
 */
export function buildDeviationPrompt(o: {
  goal: string;
  successCriteria?: string;
  recentText: string;
  toolNames?: readonly string[];
  blockers?: string;
  completedItems?: string;
  userDirective?: string;
}): string {
  const blockerNote = o.blockers && o.blockers.trim()
    ? `\n注意：当前存在硬门禁拦截（${o.blockers.trim()}）。执行体正在处理门禁属正常，不得仅因此判为偏离核心目标；只有确实转去做与目标无关的事才判偏离。\n`
    : '';
  const writes = (o.toolNames ?? []).filter((n) => ARTIFACT_WRITE_TOOLS.includes(n));
  const writeNote = writes.length > 0
    ? `\n注意：最近的工具调用中存在产出性写入（${writes.join('、')}）。执行体正在落产出属正常，不得仅因此判为偏离核心目标；只有确实转去做与目标无关的事才判偏离。\n`
    : '';
  const successNote = o.successCriteria && o.successCriteria.trim()
    ? `\n**成功标准**：${o.successCriteria.trim()}`
    : '';
  // 两段落由调用侧渲染好（纯函数、可被 rr 直跑），此处只负责"有则插、无则略"——与上方两段同形。
  const completedNote = o.completedItems && o.completedItems.trim() ? o.completedItems : '';
  const directiveNote = o.userDirective && o.userDirective.trim() ? o.userDirective : '';
  return `以下是工蚁系统一个任务的「核心目标」与「最近执行进展」。请判断进展是否明显偏离核心目标。\n${blockerNote}${writeNote}${completedNote}${directiveNote}\n核心目标：${o.goal}${successNote}\n\n最近进展：\n${o.recentText}\n\n输出 JSON：{"deviated": true/false, "reason": "偏离说明，未偏离则为空字符串"}。简洁中文。`;
}

/** Phase C (2026-08-27 zx_2) 省察克治：LLM 比对「核心目标 vs 最近进展」，判断是否明显偏离。 */
// zx_20260911_1 M3: 增可选 blockers（硬门禁事实，签名向后兼容，旧切片边界断言不受影响）。
// 目的只在"让判定器看见事实"——cap/节流/abort 语义一字不动（知止不殆）。
// zx_20260915 M4/P0-6(e): 增 `successCriteria`（第 3 参，紧邻 goal——两者共同定义"要做什么"）
// 与 `toolNames`（尾参，写豁免的事实来源）。三个新事实同受开关 `engine.deviation_full_input`，
// **在调用侧读**——函数内读 setting 就是判据的第二份实现。
// zx_20260917 M5c: 再增两可选**尾参** `completedItems`（已完成项账本，治失明⑥）与 `userDirective`
// （用户/系统最近指令，治失明⑦）。同受同一开关、同在调用侧读；不传 ⇒ 与改前逐字相同。
export async function checkGoalDeviation(ansClient: unknown, goal: string, successCriteria: string, recentText: string, acc?: { sideTokens?: number }, blockers?: string, toolNames?: readonly string[], completedItems?: string, userDirective?: string): Promise<{ deviated: boolean; reason: string } | null> {
  try {
    // ⚠ 这里的 `excludeCapabilities?: string[]` 是**在被说明的那个口长什么样**（`ansClient` 形参是 `unknown`），
    //   不是"辅助路要什么"的第二份定义——请求本身由 `auxModelRequest()` 一处给（zx_20260924 M6-d）。
    const m = await (ansClient as { getOptimalModel: (o: { capabilities: string[]; strategy: string; excludeCapabilities?: string[] }) => Promise<{ url?: string; api_key?: string; model_name?: string; max_output_tokens?: number }> }).getOptimalModel(auxModelRequest());
    if (!m?.url || !m?.api_key || !m?.model_name) return null;
    const { generateText } = await import('ai');
    const provider = createSafeProvider({ apiKey: m.api_key, baseURL: m.url });
    const prompt = buildDeviationPrompt({ goal, successCriteria, recentText, toolNames, blockers, completedItems, userDirective });
    const result = await generateText({
      model: provider.chat(m.model_name),
      temperature: 0.1,
      maxTokens: m.max_output_tokens || 4096,
      abortSignal: AbortSignal.timeout(15_000),
      prompt,
    });
    const text = result.text || '';
    // 省耗账实(1a): 目标偏离核对为旁路子 LLM——usage 记入执行期账本，收口并账
    // （无 usage 时的估算文本取**实发 prompt**：M4 加宽了输入，仍按旧的两段拼会在缺 usage 时少记）
    addSideTokens(acc, usageTokensOf(result as unknown as { usage?: unknown; text?: string }, prompt));
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { deviated?: boolean; reason?: string };
    // zx_20260917 M5-4（不许静默截断）: 上限保留（防超长污染会话），但**断在半句**要如实说出来——
    // 这段文本是"为什么被停"的唯一解释（会话行 `[目标偏离提醒] …`、`task.goal_deviation` 载荷、
    // IM 通知正文三处同源），实测标本两条理由都断在句中被当成完整句读。
    // ⚠ 仅**真截断**时加标记：≤上限者一字不加（否则"理由已截断"本身成了假话）。
    const reason = truncateGoalDeviationReason(parsed.reason || '');
    return { deviated: !!parsed.deviated, reason };
  } catch { return null; }
}

/** Phase A (2026-08-27 zx_3) 待确认事项门禁：从任务描述关联的方案文档中提取「待确认事项」，过滤已确认后返回未确认列表。 */
export function detectPendingConfirmations(db: Database.Database, projectId: string, taskText: string, taskId: string, workingDir: string): string[] {
  try {
    // 1. 提取任务描述中的 .md 文档路径（方案/计划/排期文档）
    const mdPaths = taskText.match(/[a-zA-Z0-9_\-/]+\.md/g) || [];
    // 2. 读已确认记录（同项目所有任务的 context_json.confirmations，实现跨任务复用）
    let confirmed: string[] = [];
    try {
      const rows = db.prepare("SELECT context_json FROM wa_tasks WHERE project_id = ? AND context_json LIKE '%\"confirmations\"%'").all(projectId) as Array<{ context_json: string }>;
      for (const r of rows) {
        const ctx = JSON.parse(r.context_json || '{}');
        const confs = ctx.confirmations as unknown;
        if (Array.isArray(confs)) {
          confirmed.push(...confs.map((c) => (typeof c === 'string' ? c : (c as { item?: string }).item)).filter((x): x is string => !!x));
        }
      }
      confirmed = [...new Set(confirmed)];
    } catch {}
    // 3. 逐个读方案文档，提取待确认事项（区分「待确认」章节 vs「关键决策记录/已确认」章节）
    const pending: string[] = [];
    const extractItems = (text: string): string[] => {
      const items: string[] = [];
      const re = /\*\*【([^】]+)】\*\*/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const label = m[1]!.trim();
        if (/确认|澄清|决策|答复|核实|核对|待定/.test(label)) items.push(label);
      }
      return items;
    };
    for (const rel of mdPaths) {
      if (!/plan|方案|计划|排期|improve/i.test(rel)) continue; // 只关注方案类文档
      let content = '';
      try { content = fs.readFileSync(path.resolve(workingDir, rel), 'utf-8'); } catch { continue; }
      if (!/待确认|需用户确认|需确认|待决策|待答复|待核实/.test(content)) continue;
      // 文档级已确认：出现在「关键决策记录/已确认」章节下的已确认事项（表格第一列「| 事项名 |」或 **【xxx】** 标记）
      const confirmedInDoc: string[] = [];
      const sections = content.split(/\n##\s*/);
      for (const sec of sections) {
        const heading = sec.split('\n')[0] || '';
        if (!/关键决策记录|已确认/.test(heading)) continue;
        for (const line of sec.split('\n')) {
          const cell = line.match(/^\s*\|\s*([^|]+?)\s*\|/);
          if (cell && !/^[-:\s]+$/.test(cell[1]!)) confirmedInDoc.push(cell[1]!.trim());
        }
        confirmedInDoc.push(...extractItems(sec));
      }
      for (const item of extractItems(content)) {
        if (pending.includes(item)) continue;
        if (confirmed.some((c) => c.includes(item) || item.includes(c))) continue;
        if (confirmedInDoc.some((c) => c.includes(item) || item.includes(c))) continue;
        pending.push(item);
      }
    }
    return pending;
  } catch { return []; }
}

// E1 (2026-09-03_1): 记忆召回理由（记忆类型 + 存储时 encoding 关键词与任务文本命中）——维特根斯坦私人语言论证：召回可公共检验
const MEMORY_TYPE_LABEL: Record<string, string> = { semantic: '项目知识·语义', procedural: '项目知识·程序', episodic: '近期经验·情景', panorama: '项目知识全景', retrospective: '任务复盘', negative: '反面教训', exemplar: '范例经验', prospective: '前瞻待办' };
function deriveMemoryReason(m: { memory_type?: string; context_json?: string }, taskText: string): string {
  const label = MEMORY_TYPE_LABEL[m.memory_type ?? ''] ?? (m.memory_type || '记忆');
  let kw: string[] = [];
  try {
    const c = JSON.parse(m.context_json || '{}') as { encoding_context?: { keywords?: unknown } };
    if (Array.isArray(c.encoding_context?.keywords)) kw = c.encoding_context.keywords as string[];
  } catch { /* ignore */ }
  const hits = kw.filter((k) => taskText.includes(String(k))).slice(0, 3);
  return hits.length > 0 ? `${label} · 命中:${hits.join('/')}` : label;
}

/** 任务类型引导 */
// zx_20260921 M8: 加 `export` 供 `core/exec-context.ts` 用（真源仍在此处）。
export function classifyTaskGuidance(text: string): string | null {
  const t = text.toLowerCase();
  // zx_20260904_3 D3 (2026-09-04): 规划/调研+产出方案文档 → research 引导（先于 code 分支，
  // 避免描述含"实现…功能/接口"的优化规划任务被 code 引导——实际要的是走查后写 .md 方案）
  if (/(功能优化规划|优化方案|排期方案|升级方案|优化规划|实施规划|改进方案|方案设计|调研报告|完成情况核实|复核报告)/.test(t)
    && /(写入|写到|产出|生成|落盘|写出|保存到|交付)/.test(t)
    && /(\.md|文档|报告|方案文件)/.test(t)) {
    return '[任务类型: 规划/调研报告] 本任务为规划/调研类：先 read_file/search_content 走查真实代码与数据、定位主要矛盾，再以 write_file 写入 .md 方案文档（含走查证据锚点/逐项详设含验收/排期），勿做代码实现；完成后 finalize_task。';
  }
  if (/代码|code|编程|实现|修复|bug|fix|refactor|重构|写.*函数|写.*类|api|接口/.test(t)) {
    return '[任务类型: 编码实现] 请按需求编写/修改代码。先read_file读取目标文件定位插入点，再write_file重写。使用search_content搜索相关引用，确保改动完整。完成后finalize_task。';
  }
  if (/调查|调研|研究|分析|research|analysis|review|评估|evaluate/.test(t)) {
    return '[任务类型: 调查研究] 先分析调研，产出结论后用write_file写入.md报告文件并finalize_task。';
  }
  if (/文档|doc|readme|写.*文档|生成.*文档|总结/.test(t)) {
    return '[任务类型: 文档生成] 直接撰写内容，使用write_file写入.md文件并finalize_task。';
  }
  if (/创建|新建|搭建|build|create|scaffold|初始化|init/.test(t)) {
    return '[任务类型: 项目搭建] 先规划目录结构→创建配置文件→编写核心代码→验证可运行→finalize_task。';
  }
  return null;
}

/** 5维度完成质量评估 */
/**
 * MCP 工具注册完整性检查：init_xxx_tools 是否既被 import 又被调用。
 * 防止"只 import 但忘记在 lifespan 中注册调用"导致工具实际不可用的隐性未完成。
 * 返回缺失调用的 init_xxx_tools 函数名列表。
 */
export function checkMCPRegistrationIntegrity(workingDir: string): string[] {
  const missing: string[] = [];
  try {
    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'target' || e.name === 'dist' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.name.endsWith('.py')) {
          try {
            const content = fs.readFileSync(full, 'utf-8');
            // 每个文件内 import 与调用必须成对；调用排除 def 定义（负向零宽断言）
            const imports = new Set<string>();
            const calls = new Set<string>();
            for (const m of content.matchAll(/from tools\.\w+ import (init_\w+_tools)/g)) imports.add(m[1]!);
            for (const m of content.matchAll(/(?<!def\s)(init_\w+_tools)\s*\(/g)) calls.add(m[1]!);
            for (const imp of imports) if (!calls.has(imp)) missing.push(imp);
          } catch { /* 单文件读取失败忽略 */ }
        }
      }
    };
    walk(workingDir, 0);
  } catch { /* 忽略 */ }
  return missing;
}

function isFileDelivered(absPath: string): boolean {
  try {
    const st = fs.statSync(absPath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** 任务要求产出但磁盘上缺失/为空的文件（相对路径按 workingDir 解析）；无显式产出要求返回 [] */
export function expectedOutputMiss(db: Database.Database, taskId: string, workingDir: string): string[] {
  let row: { title: string; description: string; acceptance_criteria: string } | undefined;
  try {
    row = db.prepare('SELECT title, description, acceptance_criteria FROM wa_tasks WHERE id = ?').get(taskId) as typeof row | undefined;
  } catch { /* ignore */ }
  const declared = extractExpectedOutputPaths(`${row?.title || ''} ${row?.description || ''} ${row?.acceptance_criteria || ''}`);
  if (declared.length === 0) return [];
  return declared.filter((p) => !isFileDelivered(path.isAbsolute(p) ? p : path.join(workingDir, p)));
}

/** 声明产出中已真实落盘(存在且非空)的文件绝对路径——用于内容充分性门禁的定向校验目标 */
function declaredExistingOutputs(db: Database.Database, taskId: string, workingDir: string): string[] {
  let row: { title: string; description: string; acceptance_criteria: string } | undefined;
  try {
    row = db.prepare('SELECT title, description, acceptance_criteria FROM wa_tasks WHERE id = ?').get(taskId) as typeof row | undefined;
  } catch { /* ignore */ }
  const declared = extractExpectedOutputPaths(`${row?.title || ''} ${row?.description || ''} ${row?.acceptance_criteria || ''}`);
  if (declared.length === 0) return [];
  return declared
    .map((p) => (path.isAbsolute(p) ? p : path.join(workingDir, p)))
    .filter((abs) => isFileDelivered(abs));
}

/**
 * 内容门禁**可判型**的文档扩展名 —— `.md`/`.markdown`（文档 LLM 腿）+ `.pdf`（`extractPdfText` 抽正文后
 * 走**同一把**文档腿）。**只此一处**；不得在别处再抄一张"哪些扩展名算文档"的表（G8/G9 老病）。
 *
 * 沿革（防复述）：zx_20260922_1 M2 曾把成员资格从 `type='doc'` 收到"按扩展名"，尺为 `DOC_TARGET_EXT_RE`；
 * zx_20260923 M5-a（裁定 T3）因机器写的构建报告 `.txt` 被误收而**收窄到 `.md`**；zx_20261003 M1（裁定 K-6）
 * 改为**结构性判据** `isGateArtifact`（族可判型），PDF/代码/配置/音视频按各自的"怎么量"进门——
 * 旧符号 `DOC_TARGET_EXT_RE` 已随之撤除（改钉见 `rr_zx_20260922_1` M2 组）。
 */
const DOC_GATE_EXTS = new Set(['.md', '.markdown', '.pdf']);

/**
 * zx_20261003 M1（K-6 裁定 / 管子·度量衡）: **一件产出进不进内容门禁**（成员资格）——**唯一尺**。
 *
 * 判据 = 「**族可判型**」：`archetypeForFile` 为该扩展名给得出**一条可实行的校验路**（不是"扩展名长得像文档"）——
 *   · code / configuration → 快检路
 *   · pdf                 → 抽正文后走文档 LLM 腿
 *   · media               → 形态核验路（如实标"未做语义校验"）
 * 判型若落到 `archetypeForFile` 的**兜底档 `'document'`**，即"族不可判型" ⇒ 不进集。
 *
 * ⚠ **委派判型函数，不另列清单**：`archetypeForFile` 即"族 → 可实行的路"的**唯一真源**；本函数把"有没有
 *   可实行的路"这一问题**委派给它**（故此处**不再**各抄一份 `CODE_ARTIFACT_EXTS`/`CONFIG_ARTIFACT_EXTS`/
 *   `familyOf` ——那正是"同一批族两处枚举"的老病）。唯一**不由判型函数说了算**的一档是文档：`'document'`
 *   是 `archetypeForFile` 的**取补集兜底**（凡非代码/配置/PDF/音视频的扩展名皆落此，含 `.txt`/`.png`）⇒
 *   须按**显式文档扩展名**（`DOC_GATE_EXTS`）收窄，其余兜底族一律不收。
 *
 * ⚠ **与"怎么量"分家**：本函数只答"进不进集"；进门之后**用什么规则量**由 `archetypeForFile` 定。
 *   这正是 T3 的病根所在——`pom.xml`/`*.json.example` 曾因"非代码即文档"的补集尺被当**文档**量而误判
 *   "内容不足"。M1 让它们按**真族（configuration/code）**进门，走快检腿（`validateOutput` 立即放行），
 *   于是"验得了"与"不误判"同时成立。
 *
 * ⚠ **`.txt` 仍刻意出局**（承 `zx_20260923 M5-a` 裁定 T3）：扩展名**分不开**"人写的说明"与"机器写的
 *   构建报告"，在无"写入者维度"前，宁可少收。待 T3 病根有解（见方案 §4-9）再议。
 */
export function isGateArtifact(filePath: string): boolean {
  const p = filePath || '';
  const ext = path.extname(p).toLowerCase();
  // 文档这一档按显式扩展名收（含 `.pdf`）——只因 `archetypeForFile` 的 `'document'` 兜底分不开真假文档。
  if (DOC_GATE_EXTS.has(ext)) return true;
  // 其余（code/configuration/media）判型函数自会给出可实行的路；落 'document' 兜底者即不可判型。
  return archetypeForFile(p) !== 'document';
}

/**
 * 内容门禁目标集 = 声明产出(已落盘) ∪ 已注册交付物中「**族可判型 且 非探针噪声**」者
 * （zx_20261003 M1 / K-6；只验证与任务相关的产出，杜绝全目录扫描噪音）。
 *
 * 两处**刻意不同**的取舍（不是笔误）：
 *   · **声明产出**（`declaredExistingOutputs`）**不问族**——它是"任务文本里点名的产出"，即便落成 `.txt`
 *     也应收（承既有行为，T3 只收窄了"已注册交付物"这一支，未动声明支）。
 *   · **已注册交付物**这一支按 K-6 加双闸：`isGateArtifact`（族可判型）+ `docNotProbe`（非探针噪声）。
 *     `docNotProbe` 与 `wa_deliverables` 取数面的其它读点**同一函数**（`deliverable-lifecycle.ts`），
 *     不在此手写一遍 LIKE。
 */
export function docValidationTargets(db: Database.Database, taskId: string, workingDir: string): string[] {
  const set: string[] = [];
  const push = (abs: string): void => { if (abs && isFileDelivered(abs) && !set.includes(abs)) set.push(abs); };
  for (const p of declaredExistingOutputs(db, taskId, workingDir)) push(p);
  try {
    const rows = db.prepare(
      `SELECT file_path FROM wa_deliverables WHERE task_id = ? AND file_path IS NOT NULL AND file_path != '' AND ${docNotProbe()}`,
    ).all(taskId) as Array<{ file_path: string }>;
    for (const r of rows) {
      if (!isGateArtifact(r.file_path || '')) continue;
      push(path.isAbsolute(r.file_path) ? r.file_path : path.join(workingDir, r.file_path));
    }
  } catch { /* ignore */ }
  return set;
}

// zx_20260904_4 T1 (2026-09-04): 需求理解卡——规则预卡 + 一次轻量 LLM 提炼。
// 目标：让执行模型"先读懂极简卡再细读长原文"，避免反复复述/误读长需求，同时用最省 token 的方式
// 达成"准确理解要求"。结果缓存 ctxJson.requirement_card（resume 复用不再提炼）；提炼失败回退规则卡。
interface ReqCardCtx {
  getAnsClient: () => Promise<{ getOptimalModel: (o: Record<string, unknown>) => Promise<Record<string, unknown>> }>;
}
async function refineRequirementCard(
  getAns: () => Promise<{ getOptimalModel: (o: Record<string, unknown>) => Promise<Record<string, unknown>> }>,
  title: string, description: string, acceptance: string,
): Promise<string | null> {
  try {
    const ansClient = await getAns();
    const m = await ansClient.getOptimalModel(auxModelRequest()) as Record<string, unknown>;
    if (!m?.url || !m?.api_key || !m?.model_name) return null;
    const { generateText } = await import('ai');
    const provider = createSafeProvider({ baseURL: m.url as string, apiKey: m.api_key as string });
    const res = await generateText({
      model: provider(m.model_name as string),
      system: '你是需求理解助手。把用户的长任务要求提炼成极简“需求卡”，供执行模型首步快速对齐、减少复述与误读。只输出中文卡片（≤约200字），用 markdown 行：- 目标:…\n- 边界/约束:…\n- 产出文件:…\n- 验收要点:…\n- 勿做:…。信息不足写“待确认：…”；不要编造。',
      prompt: `任务标题：${title.slice(0, 200)}\n任务描述：${description.slice(0, 3000)}\n${acceptance ? `验收标准：${acceptance.slice(0, 1500)}` : ''}`,
      temperature: 0,
      maxTokens: 500,
      abortSignal: AbortSignal.timeout(25_000),
    });
    const out = (res.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return out ? `[需求卡(提炼)]\n${out}` : null;
  } catch { return null; }
}

async function buildRequirementCard(
  db: Database.Database, taskId: string, title: string, description: string, acceptance: string,
  taskGoal: { goal: string; success_criteria: string; investigate: string[] } | null,
  ctx: ReqCardCtx,
): Promise<{ content: string; cached: boolean; refined: boolean; ambiguous: boolean }> {
  const noop = { content: '', cached: false, refined: false, ambiguous: false };
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}'); } catch { return noop; }
  // 子代理/下钻任务已有明确 prompt，跳过（避免每次 spawn 都做提炼开销）
  if (cur.type === 'subagent' || Number(cur.depth) >= 1) return noop;
  const goal = ((cur.task_goal as { goal?: string } | undefined)?.goal) || taskGoal?.goal || '';
  const cached = typeof cur.requirement_card === 'string' && !!(cur.requirement_card as string).trim();
  if (cached) {
    return { content: cur.requirement_card as string, cached: true, refined: true, ambiguous: !goal && !acceptance.trim() && extractExpectedOutputPaths(`${title} ${description}`).length === 0 };
  }
  const declared = extractExpectedOutputPaths(`${title} ${description}`);
  const guideMatch = /\[任务类型:\s*([^\]]+)\]/.exec(classifyTaskGuidance(`${title} ${description}`) || '');
  const goalLine = goal ? `- 目标：${goal.slice(0, 200)}` : (declared.length ? `- 产出：${declared[0]}` : '- 目标：按描述执行（未显式给定）');
  const rule = [
    '<requirement-card>',
    goalLine,
    `- 产出文件：${declared.length ? declared.join('、') : '未显式声明（若产出报告/方案请 write_file 落盘并 register_deliverable）'}`,
    acceptance.trim() ? `- 关键约束/验收：${acceptance.slice(0, 300)}` : '',
    guideMatch ? `- 任务类型：${guideMatch[1]}` : '',
    '- 勿做：勿整段复述任务原文；勿重读/重复搜索已读文件（见进度摘要/已读清单）。',
    '</requirement-card>',
  ].filter(Boolean).join('\n');
  const ambiguous = !goal && !acceptance.trim() && declared.length === 0;
  const text = `${title}\n${description}\n${acceptance}`;
  const refined = text.length >= 300 ? await refineRequirementCard(() => ctx.getAnsClient(), title, description, acceptance) : null;
  const final = refined || rule;
  try {
    const latest = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
    latest.requirement_card = final;
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(latest), taskId);
  } catch { /* 缓存失败不阻塞 */ }
  return { content: final, cached: false, refined: !!refined, ambiguous };
}

/**
 * 完成分**四道封顶**的一处真源（zx_20260928 M1）。
 *
 * 抽出前这四段（CAP0–CAP3）内联在 `assessCompletionQuality` 体内，而只有 `run_close` 那一条收尾路会跑它；
 * 其余三个完成出口（agent 工具 `finalize_task`、`update_task_status`、人工 GUI 标记完成）各走各的尺
 * ——"完成"这件事在不同出口上不是一个判据（题面标本 `a5dfdb48`：`completion_quality.score=95`、
 * `via:'finalize_task'`，而同处一份 `context_json` 的验收账是 `verified:false, reason:no_criteria`）。
 * 抽成导出纯函数，就是让**谁记完成分，谁就跑这四道闸**——同尺，而不是各写一个 `Math.min(…, 45)`。
 *
 * 返回值刻意是 `cap` + **两段注记分开**，而不是拼好的 feedback：`assessCompletionQuality` 的
 * feedback 字符串须**逐字节不变**（本项是纯重构，只搬位置不改判据），故由它按原位自行拼接。
 *
 * @param o.hasDeliverables 「本任务名下登记条数 > 0」（等价于原先内联的 `delivs.c > 0`）；
 *   由调用方查一次 `wa_deliverables` 传入，免得本函数再查一遍。
 */
export function completionCapFloors(
  db: Database.Database,
  o: { taskId: string; workingDir: string; archetype?: string; hasDeliverables: boolean },
): { cap: number; typeNote: string; registerNote: string } {
  const { taskId, workingDir, archetype, hasDeliverables } = o;
  let cap = 95; // 无封顶
  let typeNote = '';
  // MCP 工具注册完整性：init_xxx_tools 只 import 未在 lifespan 调用 → 关键步骤缺失，工具实际不可用
  const missingRegistrations = checkMCPRegistrationIntegrity(workingDir);
  if (missingRegistrations.length > 0) {
    cap = Math.min(cap, 45);
  }
  // zx_20260904_3 D3 (2026-09-04): 研究/文档/分析类任务以"产出物(报告/文档)"为主评分——仅凭对话/步数不可自证 ≥60
  // zx_20260904_6 D4 (2026-09-04): "按行为定型"——实际写过 .py/.ts 等代码的工具调用 → 视为代码型任务，不做 research/doc 无产出压降
  // zx_20260924_1 M9-a: 逃生门的扩展名名单上提为模块级常量 `ARTIFACT_EDIT_EXTS`（并补文档类），
  //   识别面改走 `toolRowShowsArtifactEdit`（原先那条调用实参正则在生产上恒不触发；形状假设已在
  //   2026-09-24 核验中按真库实际分布订正为「单行 `[name] {"ok":true,"path":…}` + 老两行形状」）；
  //   判据本身（三种 archetype / 零产出物 / 压到 45 / 文案）一个字未动。变量名 `hasCodeEdits`
  //   随之改叫 `hasArtifactEdits`——它现在答的是"写过产出性文件"而不是"写过代码"（名实相符）。
  //   ⚠ 旧名 `hasCodeEdits` 被 `scripts/rr_zx_20260915.ts:1126` 的一行注释按名字+行号点名（那条注释的
  //     用意是"此处与 `realOutputEvidence` 刻意不同尺、勿合并"，与本次改名无关）⇒ 照旧名搜不到时，
  //     本处即它要找的那一点；下次谁动那条注释，按**符号**改，别照抄行号。
  if ((archetype === 'research' || archetype === 'document' || archetype === 'analysis') && !hasDeliverables) {
    let hasArtifactEdits = false;
    try {
      const trows = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' AND (content LIKE '%write_file%' OR content LIKE '%edit_file%') ORDER BY id DESC LIMIT 40").all(taskId) as Array<{ content: string }>;
      hasArtifactEdits = trows.some((r) => toolRowShowsArtifactEdit(r.content));
    } catch { /* 行为探测失败则按类型处理 */ }
    if (!hasArtifactEdits) {
      cap = Math.min(cap, 45);
      typeNote = ` [${archetype}类无产出物，评分压降<60]`;
    } else {
      typeNote = ` [${archetype}标签但有产出性写入行为，不压降]`;
    }
  }
  // zx_20260909 桌面修复②: 无真实产出证据 → 任何收口路径(finalize/步数强制收口/update_task_status/IPC标记完成)
  //  都不得仅靠"对话+步数"自证达成目标(score≥60)。根治假通过——实证 T1 子任务 产出0 却记 good/60 + goal_achieved=true；
  //  以及 auto_completed_without_output 任务记 completed 却带高分 的自相矛盾（真实产出证据=deliverable 落盘或 write/edit/register 工具记录）。
  //  conversation 型以对话本身为交付物，不受此压降；完全无产出无对话的上面已返回 score:10 硬规则。
  if (archetype !== 'conversation' && !realOutputEvidence(db, taskId)) {
    cap = Math.min(cap, 45);
    if (!typeNote) typeNote = ' [无真实产出证据，评分压降<60]';
  }
  // zx_20260916 M1（维特根斯坦「意义即用法」/ 道德经·七十一章「知不知，上」）: 第 4 条压降——
  //   账上**已核验且未通过**（`verified:true && passed_total < criteria_total`）⇒ 完成分不得 ≥60。
  //   此前三条压降都只读结构指标（产出物/产出证据/MCP 注册），验收账**不在其中**，于是真库出现
  //   `completion_quality.score=90` 与 `acceptance_check.passed_total=0/8` 同处一份 context_json 而结论相反（§1.1）。
  //   判据**唯一**在 `acceptanceVerdictOf`（承 M1c「一处真源」）；`not_checked` 一律不压降——
  //   「未核验 ≠ 未通过」（A4）：若把未核验也算未通过，`no_criteria`/`no_user_criteria` 的规划类任务
  //   会被**整类**压到 45 分，那是另一种失实。
  const accVerdict = acceptanceVerdictOf(readAcceptanceCheck(db, taskId));
  if (accVerdict === 'failed') {
    cap = capScoreByAcceptanceVerdict(cap, accVerdict);
    // 与上两条不同：**追加**而非"仅当无备注时填"——验收未通过是独立事实，
    // 不得因前面已有一条压降说明（如"无真实产出证据"）就被吞掉（两因并存时读者须两因都看见）。
    typeNote += ' [验收未通过，评分压降<60]';
  } else if (accVerdict === 'unjudged') {
    // zx_20260923_1 M2: 「有题未判成」**不压分**（承 A4「没判成 ≠ 没达成」），但**必须点名**——
    //   否则同屏又是"90 分 excellent"与"验收未判成、任务已停"两种口径并存而无人解释
    //   （承 zx_20260916 M1(A1)「低分的成因须如实点名」的同一精神：此处分不低，成因照样须在场）。
    typeNote += ' [验收未判成，未压分]';
  }
  const registerNote = missingRegistrations.length > 0 ? ` [注册缺失: ${missingRegistrations.join(', ')}]` : '';
  return { cap, typeNote, registerNote };
}

export function assessCompletionQuality(
  db: Database.Database, taskId: string, stepCount: number,
  tokensUsed: number, budgetTokens: number, maxSteps: number, workingDir: string,
  archetype?: string,
): { score: number; feedback: string } {
  try {
    const delivs = db.prepare('SELECT COUNT(*) as c FROM wa_deliverables WHERE task_id = ?').get(taskId) as { c: number };
    const convs = db.prepare('SELECT COUNT(*) as c FROM wa_task_conversations WHERE task_id = ? AND role = \'assistant\'').get(taskId) as { c: number };

    // 产出物大小（取最新产出物的文件字节数）
    let deliverableSize = 0;
    try {
      const latestDeliv = db.prepare('SELECT file_path FROM wa_deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) as { file_path: string } | undefined;
      if (latestDeliv?.file_path) {
        try { deliverableSize = fs.statSync(latestDeliv.file_path).size; } catch { /* 文件可能已被删除 */ }
      }
    } catch {}

    // 过早finalize检测：预算耗尽或步数接近上限时才finalize，说明是被迫结束而非自然完成
    // zx_20260922_1 M6（F8）: 预算侧与**禁用侧/放行侧同源**——读同一个 `budget_warn_band`，
    //   不再单独拿 Token 尺（`tokensUsed >= budgetTokens * 0.95`）判一次。病根同上：费用尺爆表
    //   被迫收尾的回合（真库标本 `a290ae2b`：费用 109% / Token 14%）原先照拿"非过早结束"的 10 分。
    //   本函数本就自读库（deliverables/conversations），故一并自读该账，调用方签名不动。
    let ctxAtAssess: unknown = null;
    try {
      ctxAtAssess = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json || 'null');
    } catch { /* 无账 ⇒ band 读作 0，退回步数尺（与旧式在无账时的取值一致） */ }
    const wasPremature = budgetCapReached(ctxAtAssess) || (maxSteps > 0 && stepCount >= maxSteps - 2);

    // 硬规则：无产出物且无对话 → 任务实际未做任何有效工作，判定为失败级质量
    if (delivs.c === 0 && convs.c === 0) {
      return { score: 10, feedback: `质量: partial (无产出物且无对话, ${stepCount}步, ${Math.round(tokensUsed/1000)}K tokens，任务未达成目标)` };
    }

    // 6维度: 产出物(40) + 产出物大小(10) + 步骤效率(10) + Token效率(10) + 对话(10) + 非过早结束(10)
    let score = 20; // 基础分
    if (delivs.c > 0) score += 40; // 有产出物是最重要指标
    else if (convs.c >= 2) score += 20; // 至少有对话

    if (deliverableSize > 800) score += 10; // 产出物有实质内容
    else if (deliverableSize > 0) score += 5;

    if (stepCount <= 5) score += 10; // 高效
    else if (stepCount <= 15) score += 5;

    if (budgetTokens > 0 && tokensUsed < budgetTokens * 0.5) score += 10;
    else if (budgetTokens > 0 && tokensUsed < budgetTokens) score += 5;

    if (convs.c >= 3) score += 10; // 充分对话
    if (!wasPremature) score += 10; // 自然完成而非被迫结束

    // zx_20260928 M1: 四道封顶（MCP 注册缺失 / 类型无产出物 / 无真实产出证据 / 验收未通过）搬去
    //   `completionCapFloors` 一处真源——各完成出口同尺；本函数只保留上面的"六维打分"。封顶值与两段注记
    //   的取值、次序**逐字同旧**（纯重构：搬位置、不搬判据）。
    let scoreFinal = Math.min(95, score);
    const caps = completionCapFloors(db, { taskId, workingDir, archetype, hasDeliverables: delivs.c > 0 });
    scoreFinal = Math.min(scoreFinal, caps.cap);
    const typeNote = caps.typeNote;
    const level = scoreFinal >= 80 ? 'excellent' : scoreFinal >= 60 ? 'good' : scoreFinal >= 40 ? 'acceptable' : 'partial';
    // zx_20260917 M5-2（名实相符）: 原写 `产出${delivs.c}个`，而同一份 context_json 里的
    // `execution_metrics.hasDeliverable` 也自称"产出"——**同名不同义**：前者数的是 `wa_deliverables` 里
    // **本任务名下已登记的条数**（含探针/已退休件），后者是**整棵树的真实产出证据**。
    // 归一处不可行（键名被 `tension-engine` 以 `!hasDeliverable` 读**存量行**，改名即让老行误报"无产出物"），
    // 故按方案 §7.0bis-g 改**用户可见名词**：让前者说出自己的口径。
    const sizeNote = deliverableSize > 0 ? `本任务登记${delivs.c}条(${Math.round(deliverableSize/1024)}KB)` : `本任务登记${delivs.c}条`;
    const prematureNote = wasPremature ? ' [过早结束]' : '';
    return { score: scoreFinal, feedback: `质量: ${level} (${sizeNote}, ${stepCount}步, ${Math.round(tokensUsed/1000)}K tokens${prematureNote}${caps.registerNote}${typeNote})` };
  } catch { return { score: 50, feedback: '评估失败' }; }
}

/** 为之于未有：失败风险预警（5因素评估） */
export function assessFailureRisk(ctx: {
  consecutiveErrors: number; noProgressSteps: number;
  tokenBurnRate: number; toolErrorRate: number; stepsRemaining: number;
}): { level: 'low' | 'medium' | 'high'; score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 0;
  if (ctx.consecutiveErrors >= 3) { score += 30; factors.push('连续工具错误'); }
  if (ctx.noProgressSteps >= 5) { score += 25; factors.push('长时间无进展'); }
  if (ctx.tokenBurnRate > 50_000) { score += 20; factors.push('Token消耗过快'); }
  if (ctx.toolErrorRate > 0.5) { score += 20; factors.push('工具错误率>50%'); }
  if (ctx.stepsRemaining <= 3 && ctx.noProgressSteps >= 2) { score += 15; factors.push('接近步数限制且无进展'); }
  return { level: score >= 50 ? 'high' : score >= 30 ? 'medium' : 'low', score, factors };
}

/** 知足者富：判断任务是否已充分完成（引导早停） */
export function checkSufficiency(context: {
  stepIndex: number;
  maxSteps: number;
  hasDeliverable: boolean;
  writeToolCount: number;
}): { isSufficient: boolean; confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  let confidence = 0;

  if (!context.hasDeliverable) {
    return { isSufficient: false, confidence: 0, reasons: ['尚未创建产出物'] };
  }

  if (context.writeToolCount >= 2) {
    confidence += 0.5;
    reasons.push('已完成多步写入/注册操作');
  }

  const stepUtilization = context.stepIndex / context.maxSteps;
  if (stepUtilization < 0.5) {
    confidence += 0.25;
    reasons.push(`步骤利用率低(${(stepUtilization * 100).toFixed(0)}%)但已有产出物`);
  }

  const isSufficient = confidence >= 0.8;
  return { isSufficient, confidence: Math.min(confidence, 0.95), reasons };
}

/** 知足者富：生成早停提示 */
export function generateSufficiencyHint(signal: { confidence: number; reasons: string[] }): string {
  return `<sufficiency-hint>\n【知足提示】当前任务可能已充分完成：\n${signal.reasons.map(r => `  - ${r}`).join('\n')}\n置信度: ${(signal.confidence * 100).toFixed(0)}%\n\n建议：如果你认同任务已基本完成，请调用 finalize_task 结束任务，不必耗尽所有步骤。\n如果你认为还有关键工作未完成（非打磨类），请忽略此提示并继续执行。\n</sufficiency-hint>`;
}

/** Phase B (2026-08-26) 实践论：构建 per-archetype 任务成败画像（成功率/步数/失败模式）。 */
export function buildTaskOutcomeProfile(db: Database.Database, projectId: string): Array<{ archetype: string; successCount: number; failCount: number; successRate: number; avgSteps: number; avgTokens: number; failReasons: string[] }> {
  try {
    const tasks = db.prepare(
      "SELECT context_json, status FROM wa_tasks WHERE project_id=? AND status IN ('completed','failed') AND context_json LIKE '%execution_metrics%' ORDER BY updated_at DESC LIMIT 60",
    ).all(projectId) as Array<{ context_json: string; status: string }>;
    if (tasks.length < 3) return [];
    const byArchetype = new Map<string, { success: number; fail: number; steps: number[]; tokens: number[]; failReasons: string[] }>();
    for (const t of tasks) {
      try {
        const ctx = JSON.parse(t.context_json || '{}');
        const m = ctx.execution_metrics as { archetype?: string; stepsUsed?: number; totalTokens?: number } | undefined;
        if (!m?.archetype) continue;
        const entry = byArchetype.get(m.archetype) || { success: 0, fail: 0, steps: [], tokens: [], failReasons: [] };
        if (t.status === 'failed') {
          entry.fail++;
          const fr = ctx.failure_record as { reason?: string } | undefined;
          if (fr?.reason) entry.failReasons.push(fr.reason);
        } else {
          entry.success++;
        }
        entry.steps.push(m.stepsUsed || 0);
        entry.tokens.push(m.totalTokens || 0);
        byArchetype.set(m.archetype, entry);
      } catch { /* skip */ }
    }
    const profiles: Array<{ archetype: string; successCount: number; failCount: number; successRate: number; avgSteps: number; avgTokens: number; failReasons: string[] }> = [];
    for (const [archetype, e] of byArchetype) {
      const total = e.success + e.fail;
      if (total < 2) continue;
      const avgSteps = Math.round(e.steps.reduce((s, x) => s + x, 0) / e.steps.length);
      const avgTokens = Math.round(e.tokens.reduce((s, x) => s + x, 0) / e.tokens.length);
      const reasonCount = new Map<string, number>();
      for (const r of e.failReasons) reasonCount.set(r, (reasonCount.get(r) || 0) + 1);
      const topFailReasons = [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r);
      profiles.push({ archetype, successCount: e.success, failCount: e.fail, successRate: e.success / total, avgSteps, avgTokens, failReasons: topFailReasons });
    }
    profiles.sort((a, b) => b.successRate - a.successRate || b.successCount - a.successCount);
    return profiles;
  } catch { return []; }
}

/** B2 (2026-08-31) 识别偏差检测：识别 archetype vs 实际执行特征（工具序列），返回偏差（毛选实践论——识别随实践校准） */
export function detectArchetypeDeviation(db: Database.Database, taskId: string): { from: string; to: string; evidence: string } | null {
  try {
    const task = db.prepare('SELECT title, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; context_json: string } | undefined;
    if (!task) return null;
    const ctx = JSON.parse(task.context_json || '{}');
    const archetype = ctx.archetype as string | undefined;
    if (!archetype) return null;
    const toolRows = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'tool'").all(taskId) as Array<{ content: string }>;
    let searchCount = 0, writeCount = 0;
    for (const r of toolRows) {
      const c = r.content || '';
      if (/search_web|search_content|search_web_search/.test(c)) searchCount++;
      if (/write_file|edit_file/.test(c)) writeCount++;
    }
    if (archetype === 'code' && searchCount >= 5 && writeCount === 0) {
      return { from: 'code', to: 'research', evidence: `搜索×${searchCount} 无代码产出` };
    }
    if (archetype === 'research' && writeCount >= 3 && searchCount === 0) {
      return { from: 'research', to: 'code', evidence: `写文件×${writeCount} 实际写代码` };
    }
    return null;
  } catch { return null; }
}

/** Phase C (2026-08-26) 家族相似：分类模糊时用历史成功率破 tie，识别随实践校准。 */
export function calibrateArchetype(db: Database.Database, projectId: string, text: string, current: TaskArchetype): TaskArchetype {
  try {
    // 关键词命中=明确分类，不校准（避免家族相似 tie-break 覆盖关键词的确定判断）
    if (classifyArchetypeKeyword(text)) return current;
    const family = classifyByFamilyResemblance(text);
    if (family.length < 2) return current;
    const [top1, top2] = family;
    if (Math.abs(top1.score - top2.score) >= 0.02) return current; // 分类不模糊，不干预
    const profiles = buildTaskOutcomeProfile(db, projectId);
    const rateOf = (a: string) => profiles.find(p => p.archetype === a)?.successRate;
    const r1 = rateOf(top1.archetype);
    const r2 = rateOf(top2.archetype);
    if (r1 === undefined || r2 === undefined) return current; // 无画像不校准
    if (Math.abs(r1 - r2) <= 0.2) return current; // 成功率差异不显著
    const calibrated = r1 > r2 ? top1.archetype : top2.archetype;
    if (calibrated !== current) {
      logger.info({ taskText: text.slice(0, 40), from: current, to: calibrated, r1: r1.toFixed(2), r2: r2.toFixed(2) }, '任务识别校准（家族相似模糊→成功率破tie）');
    }
    return calibrated;
  } catch { return current; }
}

/** Phase B: 生成任务成败画像上下文（注入系统提示）。 */
function generateSuccessContext(db: Database.Database, projectId: string): string {
  const profiles = buildTaskOutcomeProfile(db, projectId);
  if (profiles.length === 0) return '';
  return `<task-outcome-profile>\n本项目历史任务成败画像（实践论——用成败经验指导执行）：\n${profiles.slice(0, 3).map(p => {
    const failStr = p.failReasons.length > 0 ? ` · 常见失败：${p.failReasons.join('、')}` : '';
    return `• ${p.archetype}类 成功率 ${Math.round(p.successRate * 100)}%（${p.successCount}/${p.successCount + p.failCount}）· 平均 ${p.avgSteps} 步${failStr}`;
  }).join('\n')}\n参考画像可预判难度与风险。\n</task-outcome-profile>`;
}

/** A5: 上下文压缩——用 LLM 将对话压缩为结构化摘要（maxRows 限制**单次**压缩输入规模）。
 *
 *  zx_20260911_4 M5-3（庄子·得鱼忘筌）: 此前 `slice(-maxRows)` 只摘**尾部** maxRows 条，
 *  而边界 compacted_up_to_rowid 落在整块最后一行 ⇒ 中间行被遮蔽却从未进入摘要（静默丢失）。
 *  改为按 maxRows 分段、逐段摘要后合并（`planSummaryChunks`）——"被遮蔽 ⟺ 进入摘要输入"成立；
 *  任一段未产出摘要即整体失败（fail-closed，返回 ''），边界不推进——宁可本轮不压缩，也不静默丢历史。
 *  规则回退分支同样如实（`buildRuleDigest` 逐条覆盖全部行，不再虚报省略行数）。 */
async function compressConversations(
  apiKey: string, baseUrl: string, modelName: string,
  conversations: Array<{ role: string; content: string }>,
  maxRows: number = 40,
): Promise<string> {
  try {
    const { generateText } = await import('ai');
    const provider = createSafeProvider({ apiKey, baseURL: baseUrl });

    const parts: string[] = [];
    for (const chunk of planSummaryChunks(conversations, maxRows)) {
      // zx_20260911_3 M3-5: 落单半代理会让 JSON.stringify 产出非法转义 ⇒ 请求体 400（E13）。
      // 仅在**发送前**净化，落库原文不动。
      const convText = sanitizeLoneSurrogates(chunk.map(c => `[${c.role}] ${(c.content || '').slice(0, 500)}`).join('\n'));

      const compactPrompt = `你是一个上下文压缩助手。请将以下任务对话压缩为结构化摘要。

要求：
1. 保留关键推理理由、决策依据、放弃的方案及原因
2. 结构化事实——目标、已完成操作、关键发现、约束条件、待解决问题
3. 摘要总长度不超过500字
4. 直接输出摘要，不要其他内容

对话记录：
${convText}

请输出压缩结果：`;

      const result = await generateText({
        model: provider.chat(modelName),
        messages: [{ role: 'user', content: compactPrompt }],
        maxTokens: 2000,
        temperature: 0.3,
        abortSignal: AbortSignal.timeout(30_000),
      });
      const part = (result.text || '').trim();
      if (part.length < 20) return '';
      parts.push(part);
    }
    const summary = parts.join('\n').trim();
    if (!summary) return '';
    logger.info({ convCount: conversations.length, chunks: parts.length, summaryLen: summary.length }, '上下文压缩完成');
    return summary;
  } catch (err) {
    logger.warn({ err }, '上下文压缩失败，回退到规则压缩');
    return buildRuleDigest(conversations);
  }
}

// ====== Phase 1.2: 会话派生上下文（模型可见即落库） ======

/** 读取任务可见对话行（rowid 有序），压缩边界之前的旧历史被遮蔽、以摘要替代。 */
function deriveConversationRows(db: Database.Database, taskId: string): {
  summary: string;
  rows: Array<{ rid: number; role: string; content: string }>;
} {
  const taskCtx = (() => { try { return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}'); } catch { return {}; } })();
  const compactedUpTo = (taskCtx.compacted_up_to_rowid as number) || 0;
  const summary = (taskCtx.history_summary as string) || '';
  const rows = db.prepare(
    'SELECT rowid AS rid, role, content FROM wa_task_conversations WHERE task_id = ? AND rowid > ? ORDER BY rowid ASC',
  ).all(taskId, compactedUpTo) as Array<{ rid: number; role: string; content: string }>;
  return { summary, rows };
}

/** 估算上下文 token 数（按 4 字符/token 粗略估算，与系统提示预算一致）。 */
function estimateContextTokens(rows: Array<{ content?: string }>): number {
  return rows.reduce((s, c) => s + estimateTokensFromChars((c.content || '').length), 0);
}

/** Phase 1.1: 上下文压缩——双阈值触发，保留最近30%尾部，摘要+边界持久化（resume 不再重压）。 */
async function compactTaskConversations(
  db: Database.Database, taskId: string,
  apiKey: string, baseUrl: string, modelName: string,
  contextWindow: number,
): Promise<{ summary: string; recentConversations: Array<{ role: string; content: string }> }> {
  const { summary: existingSummary, rows } = deriveConversationRows(db, taskId);
  const cw = Number(contextWindow) > 0 ? Number(contextWindow) : 128_000;
  const estimatedTokens = estimateContextTokens(rows);

  // 触发判断：软阈值60% + 硬阈值85% + 轮数>40 + 递减收益检测
  let shouldCompact = rows.length > 40 || estimatedTokens > cw * 0.6;
  if (!shouldCompact) {
    const recentAssist = rows.filter(c => c.role === 'assistant').slice(-5);
    if (recentAssist.length >= 3 && Math.max(...recentAssist.map(c => c.content.length)) < 500) shouldCompact = true;
  }
  if (!shouldCompact || rows.length <= 15) {
    return { summary: existingSummary, recentConversations: rows.map(r => ({ role: r.role, content: r.content })) };
  }

  // 尾部保留：软阈值60%保留30%；硬阈值85%更激进保留10%（最少5条）
  const isHard = estimatedTokens > cw * 0.85;
  const tailCount = Math.max(5, Math.ceil(rows.length * (isHard ? 0.1 : 0.3)));
  // tool 调用/结果成对：边界不得落在 tool 结果行上（否则拆开 [工具调用] 与其结果）
  let boundary = rows.length - tailCount;
  while (boundary > 0 && rows[boundary]?.role === 'tool') boundary--;
  const older = rows.slice(0, boundary);
  const newSummary = await compressConversations(apiKey, baseUrl, modelName, older);
  if (!newSummary) {
    return { summary: existingSummary, recentConversations: rows.map(r => ({ role: r.role, content: r.content })) };
  }

  // 持久化：边界（最后被遮蔽行 rowid）+ 摘要（context_json）+ [压缩] 会话行（UI/审计可见）
  const lastShadowedRid = older[older.length - 1]!.rid;
  const taskCtx = (() => { try { return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}'); } catch { return {}; } })();
  // 省察克治/反者道之动 (zx_20260906_1 2a): 多次 resume 再压缩不再"覆盖旧摘要"——旧摘要(早期意图/关键决策)与本次新摘要**拼接**，
  // 避免多次 resume 后最早期意图逐轮塌缩丢失；超长时截旧保新并标注（早期首段仍优先保留）。
  const mergedSummary = (() => {
    const prev = (existingSummary || '').trim();
    const next = (newSummary || '').trim();
    if (!prev) return next;
    if (!next) return prev;
    const joined = `${prev}\n[续]${next}`;
    return joined.length > 12_000 ? `${prev.slice(0, 4000)}\n…[早期记忆保留至此]…\n[续]${next.slice(0, 7800)}` : joined;
  })();
  taskCtx.history_summary = mergedSummary;
  taskCtx.compacted_up_to_rowid = lastShadowedRid;
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(taskCtx), taskId);
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
    .run(crypto.randomUUID(), taskId, `[压缩] ${mergedSummary}`);
  logger.info({ taskId: taskId.slice(0, 8), shadowed: older.length, kept: rows.length - boundary, summaryLen: mergedSummary.length, merged: !!existingSummary?.trim() }, '上下文压缩完成并持久化');

  return { summary: mergedSummary, recentConversations: rows.slice(boundary).map(r => ({ role: r.role, content: r.content })) };
}
