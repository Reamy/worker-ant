/**
 * zx_20260920_1 M1（庄子·无用之用 / 金刚经·不住相）: 由 `agent-executor.ts` 的 `buildTools()`
 * **机械搬迁**而来——工具体**逐字节未改**，只把原来靠外层闭包取到的名字，改为从 `deps` 解构。
 * 搬迁纪律：**工具名 / 参数 schema / execute 行为 / 返回形状一律不动**；此处不新增、不删除任何工具。
 * 依赖面（20 项）由 `ToolDeps` 声明式给出，不再依赖隐式闭包。
 */
import { runFinalizeTask } from './control-finalize.js';
import type { ToolDeps } from './deps.js';
import fs from 'node:fs';
import path from 'node:path';
import { PAUSE_REASON_CHILDREN_INCOMPLETE, PAUSE_REASON_CHILDREN_FAILED, PAUSE_REASON_NO_OUTPUT, PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_USER_INTERRUPT, PAUSE_REASON_AWAITING_INPUT, PAUSE_REASON_PENDING_CONFIRMATION, PAUSE_REASON_POLICY_PAUSED, PAUSE_REASON_AI_PROVIDER_FAILED, PAUSE_REASON_OUTPUT_MISSING, PAUSE_REASON_OUTPUT_INSUFFICIENT, PAUSE_REASON_TOOL_LOOP, PAUSE_REASON_NO_PROGRESS, PAUSE_REASON_AGENT_PAUSED } from '../pause-reason.js';
import { buildTaskOutcome, buildCompletionAccount, goalAchievedOf, syncGoalAchievedFromAccount, markGoalNotAchieved } from '../task-outcome.js';
import { childDispatchHint, chainBlockReason } from '../task-chain.js';
import { decideAcceptanceOutcome, recordAcceptanceOutcome, recordProposedCheck, proposeAcceptanceCriteria, toAcceptanceSummary, acceptanceVerdictOf, capScoreByAcceptanceVerdict, type AcceptanceOutcome, type AcceptanceCheckPayload, type AcceptanceSummary, type AcceptanceVerdict, type ProposedCriteria } from '../acceptance-check.js';
import { enqueueJob } from '../job-enqueuer.js';
// zx_20261023_3 批三（名实）：跨任务消息的唯一投递实现。
import { deliverPeerMessage } from '../peer-message.js';
import { eventBus } from '../event-bus.js';
import { failedChildren, childNames } from '../children-gate.js';
import { generateTensionContext, generateContradictionContext } from '../tension-engine.js';
import { jsonSchema } from 'ai';
import { pauseTask } from '../pause-task.js';
import { archiveTask } from '../task-archive.js';
// zx_20261015_2 D2: 终态与暂停因由不可共存——陈旧暂停键表复用人工收口路的一处真源（不另抄键名）。
import { STALE_PAUSE_KEYS } from '../finalize-by-human.js';
// zx_20261012_2 批五 M5: `failed` 走唯一写手（不再裸 UPDATE）。
import { markTaskFailed } from '../task-terminal.js';
import { hasPendingExecutionJob, isTerminalStatus } from '../task-jobs.js';
// zx_20261022_2 批一（维特根斯坦·意义即用法）: 置 running 的**意义**只由它之后真的发生什么决定——
//   只写状态行、不建作业 ⇒ "开跑了"只在字面上成立。与 GUI/调度器同一把尺：前置闸、链闸、真入队。
import { dependencyRefusal } from '../task-dep-gate.js';
// zx_20261011 M11: 不可交互任务的判法与拒绝回执——**一处真源**（`core/no-interaction.ts`，门禁侧同用）。
import { noInteractionAskRefusal } from '../no-interaction.js';
// zx_20261011_1 M4（双向澄清）: 中继任务（派来的活）的提问器——先问上游（有界等待），答不到才退回 M11 自决。
import { answerOf, getRequestAsker, requestIdOf } from '../node-clarify.js';
import { resolveTaskMilestoneLink, writeMilestoneDone, selfCompleteBan, buildChildContext, resolveAncestorSchemeRef, goalDeviationCapReached, MAX_CHILD_BREADTH, MAX_TASK_DEPTH, childBreadthRefusal, collectAncestorIds, collectSubtreeIds } from '../task-accounting.js';
import { truncationNote } from '../shell-exec.js';
import { makeAnsDecomposeDeps, autoDecomposeForTask, loadDecompositionPatterns, recordInferredDeps } from '../task-decompose.js';
// zx_20260921 M7（D4 断点③）: 判"前置是否指向自己的祖先"要解析 id 串——用**既有真源**，不在此手抄 split/trim
import { parseDepIds } from '../dep-graph.js';

import { setDeliverableStatus, promoteTaskFileDeliverables, autoAssignPrimary, readAcceptanceCheck, docNotProbe } from '../deliverable-lifecycle.js';

/**
 * zx_20261012_2 批四（拆解随本相）: 计划嵌套上限——**计划模式的层数**，与 `MAX_TASK_DEPTH`
 * （任务树深度，5）**不是一回事**：一个管"还能不能再 enter_plan_mode"，一个管"任务树能有多深"。
 * 原先此处写裸字面量 `2`。
 */
export const MAX_PLAN_DEPTH = 2;

/**
 * zx_20260923 M7-a（G13）: 「工作树脏不脏」的**仓根归位** —— 从起始目录**向上**（含自身）找最近的含 `.git` 的祖先。
 *
 * 病根：旧判据只问 `fs.existsSync(path.join(workingDir, '.git'))`。真库标本（项目 `31f6b443`）的
 * `working_dir` 是 `…/代码`，**该目录下无 `.git`**；而 25 份交付物的 `file_path` 全落在
 * `…/代码/参考项目/example-suite/…`，实测那里 `.git` **在**、`git status --porcelain` 报 **28 项**未提交。
 * 任务却已 `completed` —— 这道闸**一次都没运行过**（`existsSync` 为假即整段跳过）。
 *
 * 为什么按**交付物**锚定而非遍历工作目录树找子仓：交付物 `file_path` 是**绝对路径**，是"这次改动落在哪"
 * 的**已登记证据**；无界遍历在该目录下 `maxdepth 3` 就有 10+ 个子仓，会牵连与本任务无关的仓 ⇒ 误拦。
 *
 * 为什么起始目录取 `workingDir ∪ 各交付物 dirname`（并集、非替换）：`workingDir` 自身是仓时，
 * 向上第一步就命中它 ⇒ 与旧判据**逐字同等**；故并集**不可能产生新的误拦**，只在旧判据失效处
 * （workdir 非仓、真仓在子目录）补上覆盖。这同时挡住"改了 workdir 里的文件却没登记成交付物"这条盲区。
 *
 * 找不到任何可归属的仓 ⇒ 返回空数组 ⇒ 调用方**静默跳过**（维持"没有仓就无所谓提交"的原语义）。
 */
export function gitRootsOfDirs(dirs: string[]): string[] {
  const roots = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    let cur = path.resolve(dir);
    for (;;) {
      if (fs.existsSync(path.join(cur, '.git'))) { roots.add(cur); break; }
      const parent = path.dirname(cur);
      if (parent === cur) break; // 到根了（macOS `/` 的 dirname 是它自己）
      cur = parent;
    }
  }
  return [...roots].sort();
}

export function controlTools(deps: ToolDeps) {
  const { ctx, db, taskId, projectId, workingDir, pauseForDecision, checkAcceptanceCriteria, mergePlanModeContext, syncQualityColumn, interruptTask, logger, archetypeForFile, formatInsufficiencyReasons, realOutputEvidence, fileSig, addSideTokens, checkMCPRegistrationIntegrity, expectedOutputMiss, docValidationTargets, assessCompletionQuality, completionCapFloors } = deps;
  return {
    ask_user: {
      description: '询问用户问题（任务会暂停等待用户回复）。遇到待确认事项/需用户决策的关键参数/费率/目标/口径时必须调用，严禁自行假设确认或跳过。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          question: { type: 'string', description: '要询问的问题' },
          options: { type: 'string', description: '可选项，逗号分隔（可选）' },
          header: { type: 'string', description: '决策类型短标签（可选，如"费率确认"/"目标口径"）' },
          multiSelect: { type: 'boolean', description: '是否允许多选（可选，默认false）' },
        },
        required: ['question'],
      }),
      execute: async (args: { question: string; options?: string; header?: string; multiSelect?: boolean }) => {
        const ctxJson = (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json;
        // Phase 2: 结构化选项数组下发（原逗号分隔字符串→数组），复用统一暂停助手
        const opts = args.options ? args.options.split(',').map(s => s.trim()).filter(Boolean) : null;
        // M4（双向澄清，**叠在 M11 之上**）: 若这是派来的活（`context_json` 有 `node_request_id`）且已注入提问器
        //   ⇒ **先问上游（派活方）**，有界等待作答。答到即回给模型；答不到（超时/失败/无 asker）**照旧退回 M11 自决**。
        //   ⚠ 次序即判据：**先问能答的人，再退到自决**——把"无人可答"与"有答者却不问"分开（承庄子·知止）。
        // zx_20261011_2 M2（次序即判据）: 派活方**已作答**（随重跑注入 `node_answer`）⇒ **先取它**——
        //   已给的答案是最直接的"答到了"，优先于现问现等。实机实测（ANS `6f98d04a`）：只靠现问现等，
        //   人来不及答（窗口 60s）⇒ 执行体自决；而"补答"走的是"置回 assigned ⇒ 重跑"，重跑的新任务
        //   既不带答案、又重问、还把答案抹掉 ⇒ 作答**从未进过执行体**。注入即补上这一跳。
        //   ⚠ **一答一用**：取到即从上下文**删除**该键。否则模型在同一任务里再问一个**不同**的问题时，
        //     会拿旧答案当新答案用（张冠李戴）。删掉后若仍存疑，就走下面的现问现等（多轮问答由此成立）。
        const injected = answerOf(ctxJson);
        if (injected !== null) {
          try {
            db.prepare("UPDATE wa_tasks SET context_json = json_remove(context_json, '$.node_answer') WHERE id = ?").run(taskId);
          } catch { /* 删键失败不阻断：这一次仍如实把答案给模型 */ }
          return JSON.stringify({ status: 'answered', source: 'requester', answer: injected });
        }
        const requestId = requestIdOf(ctxJson);
        if (requestId) {
          const asker = getRequestAsker();
          if (asker) {
            const answer = await asker(requestId, { question: args.question, ...(opts ? { options: opts } : {}) });
            if (answer !== null) {
              return JSON.stringify({ status: 'answered', source: 'requester', answer });
            }
          }
        }
        // M11: 外部一次性请求（no_interaction）不许暂停——短路提问，把"请自行决断"回给模型（次序即判据：**先**判可否问，**再**问）。
        const refusal = noInteractionAskRefusal(ctxJson);
        if (refusal) return refusal;
        return pauseForDecision(args.header || 'ask_user', args.question, opts, { multiSelect: args.multiSelect ?? false });
      },
    },
    escalate_to_human: {
      description: '遇到无法解决的问题时，向人类请求帮助。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          issue: { type: 'string', description: '遇到的问题描述' },
          options: { type: 'string', description: '建议的解决方案选项，逗号分隔（可选）' },
        },
        required: ['issue'],
      }),
      execute: async (args: { issue: string; options?: string }) => {
        logger.warn({ taskId, issue: args.issue }, 'Agent请求人类介入');
        // zx_20261014_2 批二（王阳明·知行合一 / 罗尔斯·同一把尺）: "请求人类介入"这一件事**只准一个咽喉**。
        //   原实现只回一句 `{status:'escalated'}` 而**不置停** ⇒ 模型对用户说"任务暂停等待你的答复"，
        //   台账却把任务标成 `completed`（实机 E2E 标本 `b369cf73`：无产出 ∧ 不置停 ∧ `no_criteria` 不压分
        //   ⇒ 80 分"完成"，灯一次没动）。与 `ask_user` 同走 `pauseForDecision`（唯一咽喉：写系统行 →
        //   落 `awaiting_input` → 置 paused → 发事件 → IM 补通知）。`no_interaction` 中继任务由咽喉内
        //   `noInteractionPauseRefusal` **照旧短路**（返 `cannot_pause`，不置停）——M11 语义不变。
        const opts = args.options ? args.options.split(',').map((s) => s.trim()).filter(Boolean) : null;
        return pauseForDecision('escalation', args.issue, opts, {});
      },
    },
    complete_investigation: {
      description: '完成调查阶段。提交调查摘要，系统将自动切换至执行阶段。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { summary: { type: 'string', description: '调查摘要' } },
        required: ['summary'],
      }),
      execute: async (args: { summary: string }) => {
        const ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        ctx.investigation_summary = args.summary;
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
        return JSON.stringify({ status: 'completed', summary: args.summary });
      },
    },
    finalize_task: {
      description: '完成任务并记录结果。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          summary: { type: 'string', description: '完成摘要（中文，2-3句）' },
          quality: { type: 'string', description: '质量自评: excellent/good/acceptable/partial' },
          probe_disposition: { type: 'string', description: '收尾临时产出物处置: retire(默认，登记状态置 retired，并把文件移入隔离目录——不删除、可找回) / keep(保留，须给理由)' },
          probe_keep_reason: { type: 'string', description: 'probe_disposition=keep 时必填：为什么这些临时产出物应保留（会如实入完成自检）' },
          // zx_20260915 P0-9(c)：把「引用」与「待实施」分开——此前二者同名，核验类任务因而把既有方案
          // 的 M 项登记成"待实施"（真库 8a6f226a）。默认 implement 保持既有语义不变。
          scheme_ref_mode: { type: 'string', description: '方案里程碑处置: implement(默认，登记本任务的方案里程碑) / reference(仅引用既有方案里程碑，不登记、不置"待实施")' },
        },
        required: ['summary'],
      }),
      execute: async (args: { summary: string; quality?: string; probe_disposition?: string; probe_keep_reason?: string; scheme_ref_mode?: string }) => { return runFinalizeTask(deps, args); },
    },
    create_task: {
      description: '创建子任务（任务较大时拆解）。可设置 depends_on 指定依赖（填写**兄弟**子任务ID；⚠ **不得填写父任务或任何祖先任务**——父要等所有子任务结束后才被放行，那样两者会互相等待、永不启动，工具会直接拒绝）；有依赖的子任务在**全部前置完成**后自动启动。注意：若某前置已 failed/归档（永不可满足），或已暂停（暂停的前置不会自动解锁，因等子任务而暂停者除外），或该 id 不存在，本任务不会自动启动，请先处置前置。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: '子任务标题' },
          description: { type: 'string', description: '子任务描述' },
          priority: { type: 'number', description: '优先级 0-3（可选）' },
          depends_on: { type: 'string', description: '依赖的任务ID，该任务完成后子任务才启动（可选）' },
          acceptance_criteria: { type: 'string', description: '该子任务的验收标准（逐条写，可判定为准）；留空则收口时如实记为「未设验收标准」而非默认通过（可选）' },
        },
        required: ['title', 'description'],
      }),
      execute: async (args: { title: string; description: string; priority?: number; depends_on?: string; acceptance_criteria?: string }) => {
        // 深度限制：子任务深度=父任务深度+1
        const parentCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        const childDepth = (parentCtx.depth as number || 0) + 1;
        if (childDepth > MAX_TASK_DEPTH) return JSON.stringify({ error: `已达最大嵌套深度(${MAX_TASK_DEPTH}层)，请直接完成而非创建子任务。当前深度=${childDepth - 1}` });
        // 广度限制：只数**在途**（zx_20260916_3 M1，真源在 task-accounting.countActiveChildren）——
        // 旧写法 `COUNT(*)` 不筛 status，已终态的子任务永久占位（真库 9/9 父任务如此）。
        const breadthRefusal = childBreadthRefusal(db, taskId);
        if (breadthRefusal) return JSON.stringify({ error: breadthRefusal });
        // zx_20260921 M7（D4 断点③）: 前置**不得指向自己的祖先**——否则父子互锁，双双永不启动。
        //
        // 这条闸拦的**不是** `depends_on` 图上的环（那在 `task:updateDeps` 那条编辑路上才可能成，
        // 由 `introducesCycle` 管；本工具建的是**全新 UUID** 任务，库中无人以它为前置 ⇒ 图上的环在此
        // **恒不成立**，实测该函数对本路恒返回 null）。真正会咬人的环走**父子关系**：
        // 子 `depends_on = 父` ⇒ 父在等子到终态（`checkParentTaskAfterChildDone`）而子在等父完成
        // （`getReadyTasks`→`depBlockRun('waiting')=true`）⇒ 子永不执行、父永不放行。
        // 而本工具的描述**恰恰邀请**模型填父任务 id（"填写父任务或兄弟任务ID"），故此路真会走到。
        const depIds = parseDepIds(args.depends_on);
        if (depIds.length > 0) {
          const ancestorSet = new Set([taskId, ...collectAncestorIds(db, taskId)]);
          const locked = depIds.filter((d) => ancestorSet.has(d));
          if (locked.length > 0) {
            return JSON.stringify({
              error: `前置依赖不得指向本任务的祖先（父/祖父）任务：${locked.map((x) => x.slice(0, 8)).join('、')}。`
                + '父任务要等**所有**子任务到终态才会被放行，若本子任务又等父完成，两者会互相等待、永不启动（死锁）。'
                + '请改为依赖**兄弟**子任务ID，或不填 depends_on。',
            });
          }
        }
        // zx_20260911_3 M2a(知行合一): 关联事实源在祖先链上——直接父无 scheme_ref 不等于整棵树无关联（E2: 11/0）
        const ancestorSr = resolveAncestorSchemeRef(db, taskId);
        if (ancestorSr) parentCtx.scheme_ref = ancestorSr;
        const id = crypto.randomUUID();
        // zx_20260913 M3-1(王阳明·知行合一 / 名实相符): 旧代码带依赖者落 `paused`——而全库**无任何**路径
        // 把"依赖满足"的 paused 转 pending ⇒ 该子任务永不启动，与 tool hint「依赖完成后自动启动」正好相反。
        // 现一律落 `pending`：`getReadyTasks` 里的 `hasUnmetDependencies` 会天然挡住未满足者，
        // 前置完成后**下一次扫描自动入队**——不新增枚举值、不新增机制。
        const status = 'pending';
        db.prepare(
          "INSERT INTO wa_tasks (id, project_id, title, description, status, priority, parent_task_id, depends_on, source, acceptance_criteria, context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)"
        ).run(id, projectId, args.title, args.description, status, args.priority ?? 0, taskId, args.depends_on || '', (args.acceptance_criteria || '').trim(), JSON.stringify(buildChildContext(parentCtx, childDepth)));
        // zx_20260917 M5-1（链上至多一个在跑）: 父自己在跑时**不**即刻入队。
        // 标本 9788ce4f：父 05:37:17 建 M0 时自己还在 planning ⇒ 子同一秒起跑，父子随后改同一工作树
        //（父 05:40:13 写文件、M0 05:40:25–05:41:05 改同一文件）。父 active 时子任务归父调度，
        // 交调度器按"父本轮结束 + 链上无在途"自动拉起——真源 `core/task-chain.ts`（与调度器共用，不抄第二份）。
        const parentBusyHint = childDispatchHint(db, taskId);
        // 无依赖的子任务即刻入队；有依赖者交给调度器按前置解锁（避免"两把尺"：解锁只经 getReadyTasks 一条路）
        if (!args.depends_on && !parentBusyHint) {
          enqueueJob(db, 'ai-task', { taskId: id, projectId, source: 'subtask' });
        }
        const createTaskStatus = args.depends_on
          ? 'created_and_pending'
          : (parentBusyHint ? 'created_deferred_parent_busy' : 'created_and_queued');
        return JSON.stringify({ taskId: id, status: createTaskStatus, depth: childDepth, hint: args.depends_on ? '已创建（pending）——前置完成前不会启动；前置完成后调度器自动入队。注意：若某前置已 failed/归档或已暂停（暂停的前置不会自动解锁，因等子任务而暂停者除外），本任务**不会**自动启动，须人工处置。' : (parentBusyHint ?? '此任务已自动入队') });
      },
    },
    update_task_status: {
      description: '更新任务状态（用于编排子任务/依赖任务）。⚠ 把「当前正在执行的任务」置为 completed 请改用 finalize_task——本工具会拒绝。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          targetTaskId: { type: 'string', description: '目标任务ID' },
          // zx_20261012_2 批二: 由裸 string 收为 **enum**——此前 `status` 是自由字符串，模型可写任何值
          //   （含错拼/编造），`archived`（放弃）也无从表达；收成枚举后"能写的值"与 `TaskStatus` 一致。
          status: { type: 'string', enum: ['pending', 'running', 'paused', 'completed', 'failed', 'archived'], description: '状态: pending/running/paused/completed/failed/archived（archived=放弃/归档）' },
          // zx_20261012_2 批五 M5: 描述改**实话**——此前写「会如实进事件与通知」，而 `paused` 一路
          //   的 `reason` 只落 `$.pause_note`（**不**发通知），`failed` 一路只进事件（**也**不发通知）。
          //   维特根斯坦：说成它真做的样子。现 `failed` 一路真进 IM（经 `markTaskFailed`）。
          reason: { type: 'string', description: '可选：置 failed 的失败原因（会如实进事件、会话消息与 IM 通知）；置 paused 时作为暂停附注留痕（进事件与 $.pause_note，不据此发通知）' },
        },
        required: ['targetTaskId', 'status'],
      }),
      execute: async (args: { targetTaskId: string; status: string; reason?: string }) => {
        // zx_20260910_2 M1: 自完成禁令——完成的唯一合法出口是 finalize_task（过三道门禁且会正常运行收口）。
        // 此前允许 targetTaskId === 当前任务，AI 用它绕过门禁自我宣告完成：不留事件(不变量违规) +
        // run 收口随即翻回 paused ⇒ 界面闪现「已完成」又变执行中（现象1 死因）。
        const ban = selfCompleteBan(taskId, args.targetTaskId, args.status);
        if (ban) return JSON.stringify({ error: ban });
        // 目标不存在此前静默"成功"（UPDATE 命中 0 行也返回 status）——补存在性校验，并取目标任务自己的 project_id
        const trow = db.prepare('SELECT project_id, status FROM wa_tasks WHERE id = ?').get(args.targetTaskId) as
          | { project_id: string | null; status: string }
          | undefined;
        if (!trow) return JSON.stringify({ error: '任务不存在' });
        // zx_20261021_2 D3（知止）：**编排工具不得改写终态**。
        //   真库事故：两个"修复核实…"任务被归档后，后续流程（收尾段/暂停写口）又把它们改成 paused/completed；
        //   本工具此前只挡"自己标自己完成"（`selfCompleteBan`），对**已终态的他人任务**照写任意状态。
        //   ⚠ 同值幂等仍放行（`completed→completed`）：`rr_zx_20260915` 的"不硬拦"裁定与
        //     `rr_zx_20261015_2` C-3 正踩这条路，若一并拒掉就是把既有契约当回归。
        if (isTerminalStatus(trow.status) && trow.status !== args.status) {
          return JSON.stringify({
            error: `目标任务已是终态（${trow.status}），不再改写为 ${args.status}——归档/完成/失败都是了结；确需重开请人工在桌面端处置`,
            taskId: args.targetTaskId,
            currentStatus: trow.status,
          });
        }
        let enqueued = false;
        if (args.status === 'paused') {
          // zx_20260917 M1（订正④：状态由**变量**写入，字面扫描看不见的那一处在别处是同一形状）:
          //   置暂停走唯一写入口——落因（`agent_paused`）+ 发 status_changed。此前这条路两者皆无：
          //   状态改完界面不刷（只改库不发事件），且工具自己的 `reason` 入参**整条丢弃**。
          //   现把该入参落进 `$.pause_note` 留痕（"告"面归 M2 裁定，本批只治"录"面，故不据此发通知）。
          pauseTask(db, {
            taskId: args.targetTaskId,
            reason: PAUSE_REASON_AGENT_PAUSED,
            extraContext: args.reason ? { pause_note: args.reason } : undefined,
          });
        } else if (args.status === 'archived') {
          // zx_20261012_2 批二: 归档（放弃）走**唯一写入口** `archiveTask`——落因（`archive_reason`）+
          //   翻账页 + 发 status_changed。此前此处裸 `UPDATE … SET status='archived'`：因不落、账页不翻，
          //   与 `pauseTask` 收口前那条旧病同形（本工具 `reason` 此前只进事件，不进账）。
          archiveTask(db, { taskId: args.targetTaskId, reason: args.reason });
        } else if (args.status === 'failed') {
          // zx_20261012_2 批五 M5: `failed` 走**唯一写手** `markTaskFailed`——不再裸 `UPDATE`。
          //   裸写三缺：① 账不翻页（上一次 run 的判卷留在账上 ⇒ 一次失败被读成"质量 90 分"，G12 同病）；
          //   ② 失败 IM 无人发（本事故 9 连败一条通知没有的一支）；③ 与事故里那 5 条规划产物不同路归口。
          //   会话行在此**补**（`markTaskFailed` 只管状态行 + 账 + 通知；会话消息各写点形状不同，仍归调用方）。
          markTaskFailed(db, args.targetTaskId, { reason: args.reason });
          db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
            .run(crypto.randomUUID(), args.targetTaskId, `[标记失败] ${args.reason || '由 agent 经 update_task_status 置为失败'}`);
        } else if (args.status === 'running') {
          // zx_20261022_2 批一（毛选·实践论）: 此前 `running` 与 `pending` 同走一条**裸 UPDATE**——
          //   状态行写"在跑"，但调度器只扫 `pending`、`wa_jobs` 零行、会话零行，直到应用重启的启动对账
          //   才被偶然救起（真库 `0ba7a0d4` 的两个 M1 子任务即此形态）。
          //   现与 GUI `task:updateStatus` 同一把尺：前置闸 → 链闸 → 写状态 → 真入队。
          const depBlocked = dependencyRefusal(db, args.targetTaskId);
          if (depBlocked) {
            return JSON.stringify({ error: depBlocked.error.message, code: depBlocked.error.code, taskId: args.targetTaskId, currentStatus: trow.status });
          }
          const chainBlocked = chainBlockReason(db, args.targetTaskId);
          if (chainBlocked) {
            return JSON.stringify({ error: `链上至多一个在跑：${chainBlocked}——本次未置 running、未入队。`, taskId: args.targetTaskId, currentStatus: trow.status });
          }
          db.prepare("UPDATE wa_tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(args.targetTaskId);
          if (!hasPendingExecutionJob(db, args.targetTaskId)) {
            enqueueJob(db, 'ai-task', { taskId: args.targetTaskId, projectId: trow.project_id, source: 'agent_start' });
            enqueued = true;
          }
        } else {
          db.prepare("UPDATE wa_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(args.status, args.targetTaskId);
        }
        // zx_20260904_6 D1 (2026-09-04): 标记 completed 时若无质量分 → 补审计分（防 M1/M2 类"完成但不可审计"）
        if (args.status === 'completed') {
          // zx_20260909 Z2(空性·如实 / 维特根斯坦·可判定): 自标 completed 亦把该任务 draft doc promote 为 completed——
          // 此前此路直写绕 finalize 且不 promote(仅 finalize/run_close promote), 致"完成态与产出 draft 不一致"; 复用之防完成态与产出一致(仍保留绕门既有设计, 只补 promote 一致)
          try { promoteTaskFileDeliverables(db, args.targetTaskId, 'update_task_status'); } catch { /* promote 失败不阻断 */ }
          try {
            const tctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(args.targetTaskId) as { context_json: string })?.context_json || '{}');
            const hasOut = realOutputEvidence(db, args.targetTaskId);
            // zx_20261015_2 D2（罗尔斯·同一把尺）: 该任务此前带**暂停因由** ⇒ 那笔账是"未完成"记录
            //   （「终态与暂停因由不可共存」，见 `finalize-by-human.ts` 的 `STALE_PAUSE_KEYS`）。
            //   人工/父任务改判 completed 时须**重算并覆盖**，不让 completed 与 score=45/goal_achieved=false 并存。
            //   ⚠ 只取 `pause_reason` 这一条**无歧义**信号——不取 `goal_achieved===false`（全库有合法的 forced 收口）。
            const wasPaused = typeof tctx.pause_reason === 'string' && tctx.pause_reason !== '';
            if (!tctx.completion_quality || wasPaused) {
              // zx_20260928 M2: 传**目标任务的持久化 archetype**——此前省略该参 ⇒ CAP1（研究/文档/分析类零产出物压 45）
            //   对编排出口整条不生效，是"同一判据在不同出口上不是一个判据"的第三处。取值口与 `finalize_task` 同源
            //   （`ctxJson.archetype`，由 `agent-executor.ts` 的 `taskCtx.archetype = archetype` 落库）。
            const auditQ = assessCompletionQuality(db, args.targetTaskId, 0, 0, 0, 0, workingDir, typeof tctx.archetype === 'string' ? tctx.archetype : undefined);
              // zx_20260916_3 M3（判据 C3）: 同一构造器造账；目标达成取**共享判据**（原先此处内联 `score >= 60`，
              //   与 run_close 的「偏离未触上限 且 ≥60」两把尺——同一概念两处各判一遍即是分叉之源）。
              const utGoalAchieved = goalAchievedOf(
                !!(tctx.task_goal as { goal?: string } | undefined)?.goal,
                tctx.goal_deviation_restarts,
                auditQ.score,
              );
              tctx.completion_quality = buildCompletionAccount({
                score: auditQ.score,
                goalAchieved: utGoalAchieved,
                via: 'update_task_status',
                feedback: auditQ.feedback,
              });
              tctx.goal_achieved = utGoalAchieved;
              syncQualityColumn(db, args.targetTaskId);
            }
            // zx_20260906 批2(终核补强): 完成真实性诚实标记——置 completed 但无真实产出证据 → 透出"未经成果门禁"（不硬拦，保留编排逃生通道）。
            // 仅在质量源为 update_task_status 工具自身审计时打标/改写 via；已有 finalize 成果门审计(via 非本工具)的不覆盖不标（防把真实收口伪标成无产出）
            // zx_20261014_6 M2（毛选·实事求是）: `neverRan`（全生命周期零 step 事件）是**独立事实**，
            //   不该被嵌在 `if (!hasOut)` 里——此前它继承到祖先的产出证据（hasOut=true）便**连算都没算**，
            //   于是"一次没跑却标完成"与"跑了但没产出"两种不同的账被并成一笔、甚至还无声（真库 §0.1）。
            //   现**无条件算出**：`!hasOut || neverRan` 都上屏；打标仍只在 `!hasOut`（`neverRan ∧ hasOut` 只落提示、不误标"无产出"）。
            let neverRan = false;
            try {
              neverRan = (db.prepare("SELECT COUNT(*) c FROM wa_event_log WHERE event_type = 'task.step_finished' AND aggregate_id = ?").get(args.targetTaskId) as { c: number }).c === 0;
            } catch { /* 事件表读不出则按"执行过"论，不误报 */ }
            if (!hasOut || neverRan) {
              const q = tctx.completion_quality as { via?: string; goal_achieved?: boolean } | undefined;
              const qVia = q?.via;
              if (!qVia || qVia === 'update_task_status' || qVia.startsWith('update_task_status')) {
                // 打标（含 via 改写与 goal 压分）**只在 `!hasOut`**：无产出才叫"未经成果门禁"；
                //   `neverRan ∧ hasOut`（有产出却零 step）只如实上屏，不替它改记账。
                if (!hasOut) {
                  tctx.auto_completed_without_output = true;
                  if (q) { q.via = 'update_task_status:no_output'; markGoalNotAchieved(tctx); }
                }
                // zx_20260915 P0-1(b): 诚实标记此前**只落 ctx JSON**（用户看不见）——提升到用户可见面：
                // 落一条系统会话行（与各暂停点同形）。仍**不硬拦**（守 :1399 裁定），只如实上屏。
                // 两态之分：`1113e215` 那类"跑了 22 步全只读"与"一次都没跑就关闭"是**不同的账**——
                // 前者是产出问题，后者是压根没执行（`bdf28220` 等 4 个，全生命周期仅 1 条 status_changed 事件）。
                if (!tctx.no_output_notice_at) {
                  const notice = neverRan
                    ? '[未过成果门禁] 该任务全生命周期**未执行过任何一步**（无 step 事件）却被标记完成——未经成果门禁，请核实是否确已完成。'
                    : '[未过成果门禁] 无任何真实产出证据（无落盘成果物、无交付物登记、无写入类工具调用）却被标记完成——未经成果门禁，请核实。';
                  try {
                    db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
                      .run(crypto.randomUUID(), args.targetTaskId, notice);
                    const now = (db.prepare("SELECT datetime('now') AS t").get() as { t: string } | undefined)?.t;
                    if (now) tctx.no_output_notice_at = now;
                  } catch { /* 上屏失败不阻断：ctx 标记仍要落 */ }
                }
              }
            }
            // zx_20261015_2 D2: 清陈旧暂停键——「终态与暂停因由不可共存」（第三条完成路同守此不变量）。
            //   键表复用 `finalize-by-human.ts` 的 `STALE_PAUSE_KEYS` 一处真源，不另抄键名。
            for (const k of STALE_PAUSE_KEYS) delete tctx[k];
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(tctx), args.targetTaskId);
          } catch { /* 审计分写入失败不阻断 */ }
          // zx_20260910_2 M1: 经本工具完成亦须落地方案里程碑——此前只有 finalize_task 做这一步，
          // 于是被"完成"的子任务永远不写 implemented_by_task_id，方案板上对应 M{n} 恒 pending（现象3 后半）。
          // 独立 try + 重新取 ctx：上面那段是"审计分写入失败不阻断"，不该把里程碑也一起吞掉。
          try {
            const wctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(args.targetTaskId) as { context_json: string })?.context_json || '{}');
            writeMilestoneDone(db, args.targetTaskId, wctx, (e) => { eventBus.emit('project.milestone_changed', e).catch(() => {}); });
          } catch { /* 里程碑回写 best-effort */ }
          // zx_20260911_2 M4-G2(罗尔斯·同一规则): 经本工具"完成"亦须自动置 ★——此前只有 finalize 做这一步，
          // 于是此处完成的任务交付单★段恒空(第二出口无 primary)。判据/实现与 finalize 共用 autoAssignPrimary。
          autoAssignPrimary(db, args.targetTaskId);
        }
        // zx_20260910_2 M1: 记账必留痕——此前直写 status 不发事件，被本工具"完成"的任务在事件溯源里不存在，
        // 不变量 task-completion-audit 报违规（本次实库 5 例），完成态与事件流不一致。
        // zx_20260915 P0-3(a)/(a′): 事件**从 UPDATE 之后移到状态与"果"都已落库之后**——原位置在 completed
        //   分支的审计/里程碑之前，会让事件带的 `quality` 是审计前的 null、而库里随即有分：同一事实两个说法
        //   （正是本轮要治的分家）。失败带 `error`（取工具入参的可选 reason，缺省为空串——键在、值如实为空）；
        //   完成带"果"，与两处 `task.completed` 出口**同一构造器**（同一形状，不各写一版）。
        // zx_20260917 M1: `paused` 一路的事件已由 `pauseTask` 发出（且**带因**）——此处不得再发一条，
        //   否则同一次置停两条 `status_changed`（一条有因、一条无因），下游"一次停只发一条"的判据随即失守。
        // zx_20261012_2 批二: `archived` 同理——事件已由 `archiveTask` 发出（带 `reason`），此处不再补发。
        if (args.status !== 'paused' && args.status !== 'archived') {
          eventBus.emit('task.status_changed', { taskId: args.targetTaskId, task_id: args.targetTaskId, newStatus: args.status, new_status: args.status, projectId: trow.project_id, ...(args.status === 'failed' ? { error: args.reason || '' } : {}), ...(args.status === 'completed' ? buildTaskOutcome(db, args.targetTaskId) : {}) }).catch(() => {});
        }
        // zx_20261022_2 批一: 置 running 的回话须如实带"是否真入了队"——`enqueued:false` 表示已有在途作业
        //   （幂等重入，不重复排队），不是"没开跑"；两者对模型是可区分的事实。
        return JSON.stringify(args.status === 'running'
          ? { taskId: args.targetTaskId, status: args.status, enqueued }
          : { taskId: args.targetTaskId, status: args.status });
      },
    },
    enter_plan_mode: {
      description: '进入计划模式。复杂任务先调用此工具，然后用create_task分解为子任务（含depends_on依赖），规划完成后调用exit_plan_mode确认。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { goal_summary: { type: 'string', description: '任务目标的简要概括' } },
        required: ['goal_summary'],
      }),
      execute: async (args: { goal_summary: string }) => {
        const taskCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        const depth = (taskCtx.depth as number) || 0;
        if (depth >= MAX_PLAN_DEPTH) return JSON.stringify({ error: `计划嵌套已达最大深度(${MAX_PLAN_DEPTH}层)，请直接执行子任务而非再次分解。` });
        // zx_20260921 M6（D3「拆解器在册、真库零产出」）: 引擎自己的 planning 出口**自己拆**。
        //   此前这里只回一句"请用 create_task 分解"——把拆解**指望模型**；而拆解器在真库里零产出
        //   （`source` 分布无 auto-decompose / 无 template）。本段把已在册的那把拆解器接到这条路上。
        // zx_20261002 M5/M6（「意义即用法」/「同一件事才叫重复」）：**门 + 拆 + 落行 + 留痕**抽成
        //   `autoDecomposeForTask` 一处实现——启动路（`ai-task` 处理器"到点即拆"）与本路共用同一份，
        //   免得同一件事两处各说各话。本路仍只在此处**补传 `patterns`**（历史拆解模式，与 IM 路同源取法）。
        //   三件如实性由该实现承担：① 开关关 ⇒ 逐字回旧行为（门未过时连取模型都不取）；
        //   ② 已有在途子任务 ⇒ 不拆（不覆盖模型已经开始的规划）；③ 拆不出/调用不通 ⇒ 不建、不编造。
        //   史注（供判据区分"注释不算实现"）：防重判据原在本块内联写成裸的
        //   `countActiveChildren(db, taskId) > 0`，与 IM 路各一份；zx_20260924_1 收成 `alreadyDecomposed`。
        const autoDecompose = await autoDecomposeForTask({
          db, taskId, projectId, goal: args.goal_summary, depth,
          getDeps: async () => makeAnsDecomposeDeps(await ctx.getAnsClient()),
          patterns: loadDecompositionPatterns(db, projectId),
          label: '计划模式', noDepWhen: '退出计划模式后立即启动',
        });
        // zx_20260911_3 M1(奥卡姆·只补写不重建): 原以全新对象整体覆写 context_json，抹掉 scheme_ref 等既有键
        //  ⇒ 计划模式入口只合并本工具自有四键，既有上下文一律保留
        db.prepare("UPDATE wa_tasks SET status = 'planning', context_json = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(mergePlanModeContext(taskCtx, { mode: 'planning', goal: args.goal_summary, depth, enteredAt: new Date().toISOString() })), taskId);
        // zx_20260924_1 M3-b（J-7）: 引擎/计划路的"我拆过了"标记——三路共有层 `$.auto_decomposed`。
        //   本路**确实真拆了**子任务（上面 `planSubtasksFromTemplate` 落了行），却一个字都不写 ⇒ 换条路
        //   再进来时，"父任务是否已拆解"在库里查无实据（模板路/IM 路都写，本轮把这一路补齐）。
        //   ⚠ 只写**这一层**：`$.template` / `$.matched_*` 是**模板路专有**（本路没有模板），不写进本路。
        //   ⚠ 位置必须压在**上面那条 context_json 覆写之后**：`taskCtx` 是进入本工具时读下的快照，
        //     先写标记再被它覆写 ⇒ 标记当场丢失（同族教训："非结论不得抹掉结论"）。
        // zx_20261022_2 批四（维特根斯坦·意义即用法）: 回话得给出**子任务 id**——只说"已拆出 5 个"，
        //   模型无从**原地**补契约，只能把粗颗粒任务归档后重建（真库 `0ba7a0d4` 的 5 条归档即此形态）。
        let childListing = '';
        if (autoDecompose) {
          db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.auto_decomposed', json('true')), updated_at = datetime('now') WHERE id = ?").run(taskId);
          // zx_20261021_4 批一：推断的前置边如实留痕（压在 `mergePlanModeContext` 快照覆写之后，否则被冲掉）。
          recordInferredDeps(db, taskId, autoDecompose.inferredDeps);
          const ids = autoDecompose.childIds;
          if (ids.length > 0) {
            const rows = db.prepare(`SELECT id, title FROM wa_tasks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string; title: string }>;
            const titleById = new Map(rows.map(r => [r.id, r.title]));
            childListing = ids.map(id => `${id.slice(0, 8)}「${titleById.get(id) || '（标题缺失）'}」`).join('、');
          }
        }
        eventBus.emit('task.status_changed', { taskId, task_id: taskId, status: 'planning', newStatus: 'planning', new_status: 'planning', projectId }).catch(() => {});
        const base = '请使用create_task工具将目标分解为具体子任务，设置优先级和依赖关系，完成后调用exit_plan_mode确认计划。';
        const instruction = autoDecompose
          ? `已自动拆解出 ${autoDecompose.created} 个子任务${childListing ? `：${childListing}` : ''}（详见会话中的 [智能拆解] 记录）：${autoDecompose.noDepCount} 个无前置、其余按 depends_on 串成流水线。`
            + `**请勿重复创建**这些子任务。若需补充 description 或验收判据，用 send_message_to_task 给对应子任务（按上面的 id）追加即可；`
            + `**不要归档后重建**——归档会丢序、占槽位，还要重跑一轮。确需补建确实缺失的子任务时才用 create_task。核对无误后调用 exit_plan_mode 确认计划。`
          : base;
        return JSON.stringify({
          status: 'planning', depth, instruction,
          ...(autoDecompose ? { autoDecomposed: autoDecompose } : {}),
        });
      },
    },
    exit_plan_mode: {
      description: '退出计划模式，确认子任务规划。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { plan_summary: { type: 'string', description: '规划总结：子任务数量、关键路径、预估工作量' } },
        required: ['plan_summary'],
      }),
      execute: async (args: { plan_summary: string }) => {
        // zx_20260929 M5-a（维特根斯坦·意义即用法）：这道门的判据要认**当下存在的子**，而不是"恰好停在
        //   某两个状态里的子"。旧判据 `status IN ('pending','paused')` 在子已 `executing`/`completed` 时
        //   数出 0 ⇒ 子确实存在，却回「请先用 create_task 创建至少一个子任务」（误判）。
        //   **未坐实实发**（方案 §1.6：正常流程下 planning 期的子确为 pending；本洞在「父重入 planning
        //   而子已跑完」时才可达），本轮按上一轮既有口径（`countActiveChildren` 的教训：问的是"有没有子"）
        //   改为**任一状态**。
        //   ⚠ 「是否有**待派发**的子」是**另一个问题**，由下方 `noDep` 那条查询独立回答——两个问题两个数，
        //     不合并（合并了就会像旧判据那样，把"子都干完了"读成"没有子"）。
        const subtasks = db.prepare('SELECT COUNT(*) as count FROM wa_tasks WHERE parent_task_id = ?').get(taskId) as { count: number };
        if (subtasks.count === 0) return JSON.stringify({ error: '请先用create_task创建至少一个子任务后再退出计划模式' });
        // zx_20260911_3 M1(奥卡姆·只补写不重建): 原以全新对象整体覆写 context_json（指纹：前三键恒为 mode/plan/subtaskCount）
        //  ⇒ 事后关联写入的 scheme_ref 在此被抹掉，整棵子树自此与方案板失联。改为只合并本工具自有三键。
        const exCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        db.prepare("UPDATE wa_tasks SET status = 'pending', context_json = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(mergePlanModeContext(exCtx, { mode: 'execution', plan: args.plan_summary, subtaskCount: subtasks.count })), taskId);
        // 启动无依赖的子任务
        // zx_20260924_1 M3-a（J-6）：与 `getReadyTasks` **同一口径的第二处读点**——`ORDER BY priority DESC`
        //   对拆解出的子任务读的是**拆解序号**（写侧 `decomposePriority(planned, i)` = `planned-i`）⇒ 模板序启动。
        //   同一批无前置子任务此前写裸 `i` ⇒ 这里**最后一个最先起跑**（`created_at` 同一条 INSERT 循环，秒级同值，兜底救不了）。
        const noDep = db.prepare("SELECT id, title, description FROM wa_tasks WHERE parent_task_id = ? AND status = 'pending' AND (depends_on IS NULL OR depends_on = '') ORDER BY priority DESC").all(taskId) as Array<{ id: string; title: string; description: string }>;
        for (const t of noDep) {
          enqueueJob(db, 'ai-task', { taskId: t.id, projectId, source: 'subtask', message: t.description || t.title });
        }
        return JSON.stringify({ status: 'pending', plan: args.plan_summary, subtaskCount: subtasks.count, startedCount: noDep.length });
      },
    },
    interrupt: {
      description: '停止/取消指定任务的当前执行（仅对 executing/preparing 状态有效），中断后任务标记为 paused。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { targetTaskId: { type: 'string', description: '要中断的任务ID' } },
        required: ['targetTaskId'],
      }),
      execute: async (args: { targetTaskId: string }) => {
        // zx_20260917 M1: 本处原有一份补发 status_changed（zx_20260910_1 M3 逐个调用方补的那批之一）。
        //   事件现由 `interruptTask` 内的唯一写入口发出——停一处即自动停四处，`SELECT project_id` 随之下岗
        //   （转述值不再被使用：`pauseTask` 从任务行自取）。
        const result = interruptTask(db, args.targetTaskId);
        return JSON.stringify(result);
      },
    },
    send_message_to_task: {
      description: '向另一个Agent任务发送消息（Peer-to-Peer协作）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          toTaskId: { type: 'string', description: '目标任务ID' },
          content: { type: 'string', description: '消息内容' },
        },
        required: ['toTaskId', 'content'],
      }),
      execute: async (args: { toTaskId: string; content: string }) => {
        // zx_20261023_3 批三：投递语义归 `peer-message.ts` 一处——**消息只落会话、不改状态**；
        //   目标不存在时不插孤儿行。此处只做接线。
        const result = deliverPeerMessage(db, { fromTaskId: taskId, toTaskId: args.toTaskId, content: args.content });
        return JSON.stringify(result.ok ? { status: 'sent', ...result } : result);
      },
    },
    decide: {
      description: '汇总投票/辩论结果，从多个子任务产出中选择最优答案。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { taskIds: { type: 'string', description: '要汇总的子任务ID列表，逗号分隔' } },
        required: ['taskIds'],
      }),
      execute: async (args: { taskIds: string }) => {
        const ids = args.taskIds.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const results: string[] = [];
        for (const tid of ids) {
          const convs = db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 3").all(tid) as Array<{ content: string }>;
          if (convs.length > 0) results.push(convs.map(c => c.content.slice(0, 300)).join('\n'));
        }
        return results.length > 0 ? `[辩论结果汇总]\n${results.map((r, i) => `视角${i + 1}:\n${r}`).join('\n\n---\n\n')}` : '[辩论] 子任务尚未产出结果';
      },
    },
  };
}
