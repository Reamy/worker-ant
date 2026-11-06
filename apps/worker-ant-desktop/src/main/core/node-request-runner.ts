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
import { readDeliveredOutputs, resolveTaskOutcome } from './task-outcome.js';
// zx_20261011_1 M4（双向澄清）：派单 id 写进任务上下文——`ask_user` 据此找到"上游是谁、问哪一单"。
import { NODE_ANSWER_KEY, NODE_REQUEST_ID_KEY } from './node-clarify.js';
import type { RequestRunner, RequestRunResult } from './node-request-worker.js';
// zx_20261030_1 M3「止」：真停＝**归档**（`archiveTask` 会 `abortTaskRun` 通知在途执行体并落终态），
//   而非只 `pauseTask`——后者会给叫停的活留一个"暂停幽灵"，等一个永远不会来的恢复。
import { archiveTask } from './task-archive.js';
import type { AnsNodeRequest } from '@worker-ant/shared-types';
// zx_20261023_5 批一：上游摘要的写入口径与读口（`exec-prelude`）同源——键名/上限/裁剪只此一处。
import { UPSTREAM_SUMMARIES_KEY, sanitizeUpstreamSummaries, type UpstreamSummaryItem } from './exec-prelude.js';
// zx_20261027_3 M2「一单一跑」：同一 req.id 的执行账（回传失败后重拉不重建任务）。
import {
  beginNodeRequestRun,
  ensureNodeRequestRunsTable,
  findNodeRequestRun,
  finishNodeRequestRun,
  markNodeRequestRunLost,
  type NodeRequestLedgerDb,
  type NodeRequestRunRow,
} from './node-request-ledger.js';

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
  /**
   * zx_20261030_1 M2：两条进度上报之间的最小间隔（毫秒）；缺省 2000。
   * 注入而非写死：受控回归用 0 直验"步进即报"，不靠真实墙钟（承 `feedback_criteria_must_not_depend_on_wallclock`）。
   */
  progressMinIntervalMs?: number;
}

/** 一条进度（与 `ProgressReporter` 同形；抽出来供 rr 直引）。 */
export interface RelayProgress {
  step: number;
  total: number | null;
  note: string;
}

/**
 * zx_20261030_1 M2（毛选·没有调查，没有发言权）: 中转任务的**进度**——从事件日志的**既有行**派生。
 *
 * 两个真数：
 *   · `step`  = 该任务 `task.step_finished` 事件的条数（执行体每走完一步发一条，跨恢复累计）；
 *   · `total` = 最近一条 `task.estimated` 的 `steps`（相似历史任务的加权步数；**无样本则没有该事件** ⇒ `null`）。
 * `note` 取最近一步的 `toolCalls` 摘要——**它是"刚做完的那步"，不是"正在做"**（事件在步末发），
 *   故界面文案一律写「最近一步」，不写「正在」，不让一个事后快照冒充进行时。
 * 事件表缺失/列不可解析 ⇒ `null`（如实"没进度"，不编 0）。纯读，不写库。
 */
export function relayProgressOf(db: Database.Database, taskId: string): RelayProgress | null {
  try {
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM wa_event_log
             WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type = 'task.step_finished') AS steps,
           (SELECT json_extract(payload, '$.steps') FROM wa_event_log
             WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type = 'task.estimated'
             ORDER BY id DESC LIMIT 1) AS total,
           (SELECT json_extract(payload, '$.toolCalls') FROM wa_event_log
             WHERE aggregate_type = 'task' AND aggregate_id = ? AND event_type = 'task.step_finished'
             ORDER BY id DESC LIMIT 1) AS tools`,
      )
      .get(taskId, taskId, taskId) as { steps?: unknown; total?: unknown; tools?: unknown } | undefined;
    const step = Number(row?.steps);
    if (!Number.isInteger(step) || step < 0) return null;
    const totalRaw = Number(row?.total);
    const total = Number.isInteger(totalRaw) && totalRaw > 0 ? totalRaw : null;
    const note = typeof row?.tools === 'string' ? row.tools.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return { step, total, note };
  } catch {
    return null;
  }
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
/** 重放账上已收口的结果（坏 JSON ⇒ 空对象，不抛——重放的是"当时的结局"，不是重算）。 */
export function readStoredRunResult(row: NodeRequestRunRow): Record<string, unknown> {
  if (typeof row.result_json !== 'string' || row.result_json.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(row.result_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function makeRelayRunner(deps: RelayRunnerDeps): RequestRunner {
  const { db } = deps;
  const ledgerDb = db as unknown as NodeRequestLedgerDb;
  const pollMs = deps.pollMs ?? 2000;
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const progressMinIntervalMs = deps.progressMinIntervalMs ?? 2000;

  return async (req, _tools, archetype, progress, cancelled): Promise<RequestRunResult> => {
    // M2：进度**节流**（每单一份状态）——步数没变不重复说（同一件事第二次说没有信息量）；
    //   两次上报至少隔 `progressMinIntervalMs`（默认 2s，防写放大）。
    let lastStep = -1;
    let lastReportAt = Number.NEGATIVE_INFINITY;
    const maybeReport = (p: RelayProgress, force = false): void => {
      if (!progress) return;
      if (!force && p.step === lastStep) return;
      if (!force && now() - lastReportAt < progressMinIntervalMs) return;
      lastStep = p.step;
      lastReportAt = now();
      try { progress(p); } catch { /* 上报失败不改这一件的结局 */ }
    };
    // M3：叫停探针——**探不清按未叫停**（查询故障 ≠ 已停；不能凭一次拉取失败把在跑的活判停）。
    const isCancelled = async (): Promise<boolean> => {
      if (!cancelled) return false;
      try { return await cancelled(); } catch { return false; }
    };
    /** 真停这件中转任务：归档（abort 在途执行体）→ 账记 `cancelled` → 如实回传。 */
    const stopNow = (taskId: string): RequestRunResult => {
      let archived = { changed: false, pageTurned: false };
      try { archived = archiveTask(db, { taskId, reason: 'node_request_cancelled' }); } catch { /* 落到下面的如实报错 */ }
      if (archived.changed) {
        const result = { taskId, taskStatus: 'archived', cancelled: true, ...readOutcome(db, taskId) };
        finishNodeRequestRun(ledgerDb, req.id, 'cancelled', result);
        return { status: 'cancelled', result };
      }
      // 归档没落笔（任务行已不在 / DB 错误）⇒ **不谎称已停**：如实报 error，说明叫停未能生效。
      const result = { taskId, cancelled: true, error: 'cancel requested but relay task could not be archived' };
      finishNodeRequestRun(ledgerDb, req.id, 'error', result);
      return { status: 'error', result };
    };
    ensureNodeRequestRunsTable(ledgerDb);
    const prior = findNodeRequestRun(ledgerDb, req.id);
    // ① 已收口 ⇒ **原样重放**（回传失败后重拉走此路：同一 req.id 永远返回同一 taskId，不建新任务）。
    //    M3：`cancelled` 同属已收口——重放"已停"，不趁重拉把叫停的活再跑一遍。
    if (prior && (prior.status === 'done' || prior.status === 'error' || prior.status === 'cancelled')) {
      return { status: prior.status, result: readStoredRunResult(prior) };
    }

    // ② 账说在跑：任务行还在 ⇒ **续等**它；行没了（崩溃/手删）⇒ 记 `run_lost`，允许重建一次。
    let resumed: NodeRequestRunRow | null = null;
    if (prior?.status === 'running') {
      const alive = db.prepare('SELECT 1 AS x FROM wa_tasks WHERE id = ?').get(prior.task_id) as { x?: number } | undefined;
      if (alive) resumed = prior;
      else markNodeRequestRunLost(ledgerDb, req.id);
    }

    // M3：起手先问一句——派活方已叫停 ⇒ **不建任务**（建了再归档是白耗一次执行机会）。
    //   续等的件留给下面的轮询检查点处置（它已有任务，须走归档真停）。
    if (!resumed && (await isCancelled())) {
      return { status: 'cancelled', result: { cancelled: true, note: 'cancelled before start' } };
    }

    let taskId = '';
    if (resumed) {
      taskId = resumed.task_id;
    } else {
      const projectId = ensureRelayProject(db);
      if (!projectId) return { status: 'error', result: { error: 'relay project unavailable' } };
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
        // 建单成功即记账（此后本 req.id 只认这一件；setup 半途失败也不留"无账任务"）。
        beginNodeRequestRun(ledgerDb, req.id, taskId);
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
        // zx_20261023_3 批四：作业来源如实落账（跨机中继拉起的执行）。
        enqueueJob(db, 'ai-task', { taskId, projectId, source: 'node_relay' });
      } catch (e) {
        const error = `relay task setup failed: ${(e as Error)?.message || String(e)}`;
        if (taskId) finishNodeRequestRun(ledgerDb, req.id, 'error', { taskId, error });
        return { status: 'error', result: { error } };
      }
    }

    // 起手先报一次：续等（`resumed`）的件报**账上的真实步数**，不从 0 倒退着报。
    maybeReport(relayProgressOf(db, taskId) ?? { step: 0, total: null, note: '已接手，准备执行' }, true);

    const deadline = now() + timeoutMs;
    for (;;) {
      const row = db.prepare('SELECT status, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string; context_json?: string | null } | undefined;
      const status = String(row?.status ?? '');
      if ((RELAY_TERMINAL_STATUSES as readonly string[]).includes(status)) {
        const outcome = readOutcome(db, taskId);
        const result =
          status === 'completed'
            // M4：完成回传附**产出清单**（元数据）——派活方据此做回执核对（缺清单只能算"自报"）。
            ? { taskId, taskStatus: status, outputs: readDeliveredOutputs(db, taskId), ...outcome }
            : { taskId, taskStatus: status, error: `relay task ended as ${status}`, ...outcome };
        const finalStatus = status === 'completed' ? 'done' : 'error';
        // 收口即入账：回传失败后重拉时原样重放这一份（同一 taskId，不重建任务）。
        finishNodeRequestRun(ledgerDb, req.id, finalStatus, result);
        return { status: finalStatus, result };
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
        const result = {
          taskId,
          taskStatus: status,
          ...(pauseReason ? { pauseReason } : {}),
          error: `relay task paused: ${label || status}`,
          ...readOutcome(db, taskId),
        };
        // 非终态收口也入账：请求方已被告知失败，重拉不得再建第二件。
        finishNodeRequestRun(ledgerDb, req.id, 'error', result);
        return { status: 'error', result };
      }
      if (now() >= deadline) {
        const result = { taskId, taskStatus: status, error: `relay task timed out after ${timeoutMs}ms` };
        finishNodeRequestRun(ledgerDb, req.id, 'error', result);
        return { status: 'error', result };
      }
      // M3：检查点——派活方叫停 ⇒ **真停**（归档在途任务，abort 执行体）并如实回传 `cancelled`。
      //   放在终态判定**之后**：若这件恰在这两跳之间已收口，如实回它的真实结局，不把"完成"改写成"停止"。
      if (await isCancelled()) return stopNow(taskId);
      // M2：每一步后把"已完成几步"如实带给派活方（节流在 `maybeReport` 里；未知即不报）。
      const p = relayProgressOf(db, taskId);
      if (p) maybeReport(p);
      await sleep(pollMs);
    }
  };
}
