/**
 * zx_20261004 M12（管子·度量衡 / 维特根斯坦·意义即用法 / 老子·无为）:
 * 中转请求的**真执行器**——把一件"AI 终端经 ANS 派来的类目级请求"交给**本机既有任务引擎**跑，
 * 等它到终态，如实回传结局。
 *
 * 为什么"落成本机内建任务"而不是另起一条执行路（§批四·细化规划）：
 *   一行执行要有的东西——模型选型、工具面收窄、预算、步数上限、事件留痕、成果登记、失败处置——
 *   **本机任务引擎已经全有**。再写一条"专供中转"的执行路，就是把这些各重做一遍，且从此两处各修各的
 *   （承本轮反复出现的"同一件事两处各记各的"病根）。故此处只做**翻译**：一件请求 → 一件任务。
 *
 * 类目 → 工具面怎么真的生效（否则"类目级限定"名实不符）：
 *   把 `category` 映射出的**原型档**写进 `task.context_json.node_archetype`；执行体在
 *   `agent-executor.pinnedArchetype` 处读出它并**锁住**原型 ⇒ 下游 `narrowToolFace(archetype, …)`
 *   真的按档收窄工具面。声明即意志：语义相似度与历史成功率都不会再推翻它。
 *
 * ⚠ 中转任务落在一个**专用项目**里（`RELAY_PROJECT_NAME`）——不借用用户任何一个项目，
 *   免得"外客的调用"混进用户项目的任务列表/统计里。该项目照常可见（M13「合理才存在」：
 *   看不见的机制等于没有），面板上叫得明白它就是中转用的。
 * ⚠ 本模块**只碰本机 DB 与调度投递**（`enqueueJob` 一处真源）——不触网；网络的进出全在
 *   `node-request-worker.ts` 的注入接口 `RequestIo` 里。
 */
import type Database from 'better-sqlite3';
import { ProjectEngine, TaskManager } from './project-engine.js';
import { enqueueJob } from './job-enqueuer.js';
import { NO_INTERACTION_KEY } from './no-interaction.js';
// zx_20261011_2 M1（道德经·名可名非常名）: 「暂停」与「有人在等输入」是**两件事**——分因的读点与词表
//   一律取 `pause-reason.ts` 的既有真源（`recordedPauseReason` / `pauseReasonLabel`），不在此手抄第二份。
import { pauseReasonLabel, recordedPauseReason } from './pause-reason.js';
// zx_20261011_1 M5（收口真源统一）：本任务产出的文件/completion_summary 由 task-outcome 一处判定，IM 通知同引。
import { resolveTaskOutcome } from './task-outcome.js';
// zx_20261011_1 M4（双向澄清）：派单 id 写进任务上下文——`ask_user` 据此找到"上游是谁、问哪一单"。
import { NODE_ANSWER_KEY, NODE_REQUEST_ID_KEY } from './node-clarify.js';
import type { RequestRunner, RequestRunResult } from './node-request-worker.js';
import type { AnsNodeRequest } from '@worker-ant/shared-types';
// zx_20261023_5 批一：上游摘要的写入口径与读口（`exec-prelude`）同源——键名/上限/裁剪只此一处。
import { UPSTREAM_SUMMARIES_KEY, sanitizeUpstreamSummaries, type UpstreamSummaryItem } from './exec-prelude.js';

/** 中转任务落地的项目名——**一处真源**（按名字查已有者，不重复建）。 */
export const RELAY_PROJECT_NAME = 'AI 终端中转（工蚁内建）';

/** 中转任务已到终态、无需再等（与 `task-jobs.isTerminalTask` 同值；此处只关心"还等不等"）。 */
export const RELAY_TERMINAL_STATUSES = ['completed', 'failed', 'archived'] as const;

export interface RelayRunnerDeps {
  db: Database.Database;
  /** 轮询任务终态的间隔（毫秒）；缺省 2000。 */
  pollMs?: number;
  /** 等一个任务到终态的上限（毫秒）；缺省 10 分钟。超限**如实报超时**，不冒充成功。 */
  timeoutMs?: number;
  /** 注入睡眠（受控回归可直跑）；缺省真实 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（受控回归用）；缺省 `Date.now`。 */
  now?: () => number;
}

/**
 * 找到（或新建）中转项目，返回其 id。**永不抛**——建不出来返回 `''`，由调用方如实报错。
 *
 * 建项目须有 `owner_id`（`wa_projects.owner_id REFERENCES wa_users(id)` 且 FK 已开），
 * 故取种子管理员；取不到就不建（本机没管理员是异常形态，此时不假装建成功）。
 */
export function ensureRelayProject(db: Database.Database): string {
  try {
    const row = db.prepare('SELECT id FROM wa_projects WHERE name = ? ORDER BY created_at ASC LIMIT 1').get(RELAY_PROJECT_NAME) as { id?: string } | undefined;
    if (row?.id) return row.id;
    const admin = db.prepare("SELECT id FROM wa_users WHERE role = 'super_admin' LIMIT 1").get() as { id?: string } | undefined;
    if (!admin?.id) return '';
    const created = new ProjectEngine(db).create({
      name: RELAY_PROJECT_NAME,
      description: 'AI 终端经 ANS 派来的类目级请求在此落成本机内建任务（M12 中转队列）。',
      owner_id: admin.id,
    }) as Record<string, unknown> | undefined;
    return String(created?.id ?? '');
  } catch { return ''; }
}

/**
 * 中转任务的标题——**一处真源**（zx_20261011 M10 修）。
 *
 * 取**派来的那句话**：用户能从标题认出的就是"这件活是什么"。
 *   原用 `类目 + requestId 前 8 位`——requestId 对人无义（E2E 实测用户读作"无法友好的理解"）。
 * 可追溯性**不靠标题**：出站台账有 requestId↔payload，回传结果里有 taskId。
 *
 * zx_20261018_1 批一（R-6/R-8）：新对端随 `payload.title` 发**结构化标题**，优先用它；
 *   旧对端只发 `payload.prompt` ⇒ **原逻辑不变**（取整句作标题）——两条路都如实，不要求对方升级。
 * 无 title/prompt 才退回 `[AI 终端·类目]`（不编一句摘要冒充"派来的内容"）。
 * 抽成**具名纯函数**便于 rr 直跑真实现（M10-2），且标题文案**只此一份**。
 */
export function relayTaskTitle(req: AnsNodeRequest): string {
  const structured = typeof req.payload?.title === 'string' ? req.payload.title.trim().replace(/\s+/g, ' ') : '';
  const prompt = typeof req.payload?.prompt === 'string' ? req.payload.prompt.trim().replace(/\s+/g, ' ') : '';
  const source = structured || prompt;
  return source ? `[AI 终端] ${source.slice(0, 40)}${source.length > 40 ? '…' : ''}` : `[AI 终端·${req.category}]`;
}

/**
 * 派单载荷的**结构化字段读取**——`payload.title/description/acceptance_criteria` 只在**非空字符串**时取用，
 * 否则逐级回退（description → prompt → 整份 JSON）。纯函数，rr 直引。
 */
export function relayTaskFields(req: AnsNodeRequest): { description: string; acceptanceCriteria: string } {
  const p = req.payload ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const description = str(p.description) || str(p.prompt) || JSON.stringify(p);
  const acceptanceCriteria = str(p.acceptance_criteria);
  return { description, acceptanceCriteria };
}

/**
 * zx_20261023_5 批一：派单随行的**上游摘要**（接收端校验，**不信任发送端**）。
 * 只收 `{id,title,summary}` 里的字符串字段；条数与总字符按读口同一上限再收一次。
 * 无 `payload.upstream`（旧对端）⇒ 空数组（不编造上游）。
 */
export function relayUpstream(req: AnsNodeRequest): UpstreamSummaryItem[] {
  const raw = (req.payload as Record<string, unknown> | undefined)?.upstream;
  return sanitizeUpstreamSummaries(raw);
}

/**
 * 一件任务收口后的可回传摘要——**取"答得到的东西"**（zx_20261011 M10 修，**有界截断**）。
 *
 * 优先级（承引擎既有口径：**产出物文件 > 结论自述 > 末条回话**）：
 *
 * ①② 由 `task-outcome.resolveTaskOutcome`（**一处真源**，zx_20261011_1 M5 起 IM 通知同引）判定：
 *   **产出物文件**（含"本任务改写了既存件"的 `changed_by` 路） > `context_json.completion_summary`。
 *   病根与反证见该函数头注释（E2E `9e43726a` 实测：改写既存 `self_introduction.md` ⇒ 本任务名下无产出物行）。
 * ③ 连结论也没有（如失败收口，那条路不写 summary）⇒ 退回末条 assistant 消息（**本路版面的兜底**——
 *   IM 通知那条路的末级兜底是执行体末次输出，见 `buildCompletionNotice`，故末级不并入共享函数）。
 */
export function readOutcome(db: Database.Database, taskId: string): { summary: string } {
  // ① 产出物文件 / ② completion_summary —— 有序口径**一处真源**（与 IM 通知同引）。
  const o = resolveTaskOutcome(db, taskId);
  if (o) return { summary: o.text.slice(0, o.source === 'file' ? 800 : 2000) };
  // ③ 末条 assistant 消息（兜底）。
  try {
    const row = db.prepare(
      "SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant' AND content != '' ORDER BY created_at DESC LIMIT 1",
    ).get(taskId) as { content?: string } | undefined;
    return { summary: (row?.content ?? '').slice(0, 2000) };
  } catch { return { summary: '' }; }
}

/**
 * 造一个 `RequestRunner`：真机接法见 `main/index.ts`。
 *
 * 时序：建任务（带 `node_archetype`）→ `enqueueJob('ai-task')` 投进调度器内存队列（~1s 被消费）
 * → 轮询到终态（`completed`/`failed`/`archived`）。`paused` 是**非终态**：请求方（外部终端）无从答复
 * ⇒ 立即如实报错，且**按账上的因由分因**（"真在等人"≠"跑完未收口"，见下 M1）。
 */
export function makeRelayRunner(deps: RelayRunnerDeps): RequestRunner {
  const { db } = deps;
  const pollMs = deps.pollMs ?? 2000;
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async (req, _tools, archetype): Promise<RequestRunResult> => {
    const projectId = ensureRelayProject(db);
    if (!projectId) return { status: 'error', result: { error: 'relay project unavailable' } };

    let taskId: string;
    try {
      const tasks = new TaskManager(db);
      // zx_20261018_1 批一 R-7：验收标准**随单落库**（远端判卷读的就是这个字段）——
      //   旧对端不发该键 ⇒ 空串（与建单默认一致），不编造。
      const fields = relayTaskFields(req);
      const created = tasks.create({
        project_id: projectId,
        title: relayTaskTitle(req),
        description: fields.description,
        acceptance_criteria: fields.acceptanceCriteria,
      }) as Record<string, unknown> | undefined;
      taskId = String(created?.id ?? '');
      if (!taskId) return { status: 'error', result: { error: 'relay task not created' } };
      // ⚠ 只写**有读者**的键（做了没用上即在骗下一位读者）：
      //   - `node_archetype`：读者 `agent-executor.pinnedArchetype`（锁原型，收窄工具面）。
      //   - `no_interaction`（M11）：**外部一次性请求不可交互**——请求方是外部 AI 终端、无从应答任何提问。
      //     读者：`tools/control.ts` 的 `ask_user`（短路提问、交执行体自决）与 `exec-claim.ts` 的门禁（不暂停）。
      //   - `node_request_id`（M4 双向澄清）：**读者**＝`tools/control.ts` 的 `ask_user`——据它向上游（派活方）
      //     提问（有界等待）。M11 的"自决"从此是**答不到时的兜底**，而非唯一出路。
      //     ⚠ zx_20261011_2 D6：**仅对等派发时写**（见下 `peerDispatch`）——外部 AI 终端**无上游作答者**。
      //   - `node_answer`（zx_20261011_2 M2）：**读者**＝同上 `ask_user`——派活方**已作答**时随重跑**注入**，
      //     使"作答 ⇒ 重跑"这条路真能续上（否则新任务失忆重问、还把上一轮的答案抹掉，见 `node-clarify.ts` 注释）。
      //   请求↔任务的可追溯性另由 M13 的事件（`node.request_*` 的 `requestId`）与回传结果里的 `taskId`
      //   承担；这里的 id 是**功能所需**（ask_user 要拿它去问），不是又存一份"没人读的 id"。
      //   zx_20261011_2 D6（毛选·集中优势兵力）：**只对有人可答的件开口问**。判据＝`requester_node_id`
      //     非空 ⇒ 对等派发（有上游节点可作答）；为空 ⇒ 外部 AI 终端（**无**上游作答者）。若对后者也写
      //     `node_request_id`，`ask_user` 会对着空气问满一整个窗口（假 `awaiting_answer` + 白等 180s）才自决；
      //     不写 ⇒ 直落 `no_interaction` 自决（M11 原义）。答案注入同受此闸（外部终端本就无答案）。
      const peerDispatch = req.requester_node_id != null;
      const injectedAnswer = peerDispatch && typeof req.answer?.answer === 'string' && req.answer.answer.length > 0 ? req.answer.answer : null;
      // zx_20261023_5 批一：上游摘要随单落在任务上下文里，**读者**＝`exec-prelude.buildUpstreamRequirementBlock`
      //   （远端任务没有本机 depends_on，这是它唯一的上游依据）。无该键 ⇒ 不写（不编造上游）。
      const upstream = relayUpstream(req);
      tasks.updateContext(taskId, {
        node_archetype: archetype,
        [NO_INTERACTION_KEY]: true,
        ...(peerDispatch ? { [NODE_REQUEST_ID_KEY]: req.id } : {}),
        ...(injectedAnswer ? { [NODE_ANSWER_KEY]: injectedAnswer } : {}),
        ...(upstream.length > 0 ? { [UPSTREAM_SUMMARIES_KEY]: upstream } : {}),
      });
    } catch (e) {
      return { status: 'error', result: { error: `relay task setup failed: ${(e as Error)?.message || String(e)}` } };
    }

    // zx_20261023_3 批四：作业来源如实落账（跨机中继拉起的执行）。
    enqueueJob(db, 'ai-task', { taskId, projectId, source: 'node_relay' });

    const deadline = now() + timeoutMs;
    for (;;) {
      const row = db.prepare('SELECT status, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string; context_json?: string | null } | undefined;
      const status = String(row?.status ?? '');
      if ((RELAY_TERMINAL_STATUSES as readonly string[]).includes(status)) {
        const outcome = readOutcome(db, taskId);
        return status === 'completed'
          ? { status: 'done', result: { taskId, taskStatus: status, ...outcome } }
          : { status: 'error', result: { taskId, taskStatus: status, error: `relay task ended as ${status}`, ...outcome } };
      }
      // `paused` = 任务停在一个**非终态**上。请求方（外部终端）无从答复 ⇒ 不等它，立即如实报错。
      // ⚠ 但**因由要如实分**（zx_20261011_2 M1）：`paused` 至少含两类——"真在等人输入"与
      //   "跑完了却没正常收口/没过质量闸"。旧写法一律写死 `awaiting input`，实机把 `abnormal_end`
      //   （`ai-task.ts` 的"executeTask 返回了、状态仍停在 executing/preparing"）也说成"有人在等"，
      //   于是 A 端台账同时挂「待作答」+「失败」而无人能读。现按账上落的因由取人话（一处真源），
      //   并把 `pauseReason` 原样带进结果（机器可读），供台账/面板如实上屏。
      if (status === 'paused') {
        const pauseReason = recordedPauseReason(row?.context_json);
        const label = pauseReasonLabel(pauseReason);
        return {
          status: 'error',
          result: {
            taskId,
            taskStatus: status,
            ...(pauseReason ? { pauseReason } : {}),
            error: `relay task paused: ${label || status}`,
            ...readOutcome(db, taskId),
          },
        };
      }
      if (now() >= deadline) {
        return { status: 'error', result: { taskId, taskStatus: status, error: `relay task timed out after ${timeoutMs}ms` } };
      }
      await sleep(pollMs);
    }
  };
}
