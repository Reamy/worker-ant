/**
 * zx_20260910_1 M2/M4: 暂停应答的落账/处置与「本轮消息单写」。
 * 抽为不依赖 electron 的模块（只需一个最小的 db 接口），使 project.ipc / agent-executor 与受控回归
 * 共用同一份逻辑——回归直接跑真实现 + 真 SQL，而非在测试里复刻一份（复刻的断言只是自我印证）。
 */
import crypto from 'node:crypto';

/** 同一次暂停的重复提交判定时窗（毫秒） */
export const REPEAT_SUBMIT_WINDOW_MS = 15_000;

/** ctxJson.pause_response 的形状（每次应答由 applyAnswerTo 整体覆盖写入） */
export interface PauseResponse {
  at: number;
  decision: string;
  value: string | null;
  asked_at: string | null;
}

/**
 * zx_20260915 P0-5(a): 答复来源的词汇表——**与 `resume-ai-task` payload 的 `initiator` 不是同一张表**。
 * 那张表只有 `'user' | 'system'`（回答"是不是人发起的"，守卫据此开关）；
 * 这张表回答"**从哪个面**答复的"（GUI / IM / 系统），用于溯源。
 */
export type AnswerSource = 'gui' | 'im' | 'system';

/** 一次答复的记账形状（asked_at 一律取自 `ctx.awaiting_input.asked_at`，**不重算**） */
export interface AnswerRecord {
  source: AnswerSource;
  decision: string;
  value?: string | null;
  asked_at?: string | null;
}

export type AnswerEmitter = (type: 'task.answer_recorded', data: Record<string, unknown>) => unknown;

/**
 * 事件发射器由**装配处**注入（`main/index.ts` 传 `eventBus.emit`），本模块因此仍零依赖 electron，
 * 受控回归可直接跑真实现并以记录桩取事件——与 `project.ipc.setResumeEnqueuer` 同一范式。
 * 未注入时**不 emit**（不静默吞错：回归里"没收到事件"正是缺注入的可观测信号）。
 */
let _answerEmitter: AnswerEmitter | null = null;
export function setAnswerEmitter(fn: AnswerEmitter | null): void {
  _answerEmitter = fn;
}

/** 「这次答复落进 ctx」的**唯一实现**——纯函数（不改库、不发事件），供两条写路共用 */
function applyAnswerTo(ctx: Record<string, unknown>, a: AnswerRecord): string | null {
  const askedAt = a.asked_at ?? (ctx.awaiting_input as { asked_at?: string } | undefined)?.asked_at ?? null;
  ctx.answer_source = a.source;
  ctx.pause_response = { at: Date.now(), decision: a.decision, value: a.value ?? null, asked_at: askedAt } satisfies PauseResponse;
  return askedAt;
}

function emitAnswer(taskId: string, projectId: string | undefined, a: AnswerRecord, askedAt: string | null): void {
  try {
    _answerEmitter?.('task.answer_recorded', {
      taskId, task_id: taskId, projectId,
      source: a.source, decision: a.decision, value: a.value ?? null, asked_at: askedAt,
    });
  } catch { /* 事件失败不阻断恢复 */ }
}

/**
 * 判断本次提交是否是对「同一次暂停」的重复操作。四条同时成立才算重复：
 * 1) 同 decision；2) 同 value；3) 距上次应答 < 15s；4) 两次应答落在同一次暂停（asked_at 相同且非空）。
 * asked_at 由 persistAwaitingInput 每次暂停重写，故「恢复后又暂停出新问题」不会被误判（新 asked_at 不等）。
 * 无 awaiting_input（系统侧自动暂停点未持久化等待输入）时严格返回 false——判不了就不拦。
 */
export function isDuplicatePauseResponse(
  ctx: Record<string, unknown>, decision: string, value?: string, now: number = Date.now(),
): boolean {
  const prev = ctx.pause_response as Partial<PauseResponse> | undefined;
  if (!prev) return false;
  if (prev.decision !== decision) return false;
  if ((prev.value ?? null) !== (value ?? null)) return false;
  if (typeof prev.at !== 'number' || now - prev.at >= REPEAT_SUBMIT_WINDOW_MS) return false;
  const askedAt = prev.asked_at;
  if (!askedAt) return false;
  const cur = (ctx.awaiting_input as { asked_at?: string } | undefined)?.asked_at;
  return !!cur && cur === askedAt;
}

/** 仅需 prepare().run()/.get() 的最小库接口——使本模块可脱 electron，在受控回归里用内存库跑真逻辑 */
export interface PauseDb {
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown };
}

/**
 * zx_20260910_1 M4: 本轮 user 消息单写（执行器收口处调用）。
 * 1) 先清该任务全部历史 [系统恢复] 行——恢复上下文单份化，多次 resume 不累积整段项目上下文（zx_20260904_3 D2）。
 * 2) 再判「最新一行已是同一句用户消息」则不重写：用户回复的权威写入点在用户输入边界
 *    （project.ipc 的 task:resume/task:respond），执行器只负责合成消息（[系统恢复]/默认「请执行任务：…」/
 *    forceFinalize 整合指令）。此前 IPC + jobs/ai-task + 此处三处各写一遍，同句回复落库 3 行、对话流现重复气泡。
 * rowid 才是真实插入序（created_at 仅秒级，分辨不了同秒多行）。
 */
export function persistTurnMessage(db: PauseDb, taskId: string, taskMessage: string): void {
  db.prepare("DELETE FROM wa_task_conversations WHERE task_id = ? AND content LIKE '[系统恢复]%'").run(taskId);
  const last = db.prepare(
    'SELECT role, content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid DESC LIMIT 1',
  ).get(taskId) as { role: string; content: string } | undefined;
  if (last && last.role === 'user' && last.content === taskMessage) return;
  db.prepare(
    "INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'user', ?, 0, datetime('now'))",
  ).run(globalThis.crypto.randomUUID(), taskId, taskMessage);
}

/**
 * zx_20260910_1 M2/M4: 应答落账 + 恢复即处置（一次 ctxJson 读改写，调用方传入已解析的 ctx）。
 * - 恒记 ctx.pause_response{at,decision,value,asked_at}：下次提交据此判重（M4）。
 * - clear=true：同时清 ctxJson.awaiting_input 与本次等待的会话标记——横幅真源与兼容回落一并收口，
 *   与 IM 通路（im-router.ts 的回复唤醒）对齐。此前 GUI 只置 pending 不清理，标记只增不减。
 *   zx_20261014_6 M4：**并清 `pending_approval`**（审批辅助字段，`agent-executor.ts`/`shell.ts` 紧随
 *   `pauseForDecision` 写入；只此一处清口会漏删）——否则 Dashboard 误报 + 迟到的 respond 误写批准。
 * - clear=false：保持暂停分支（连续拒绝）保留 awaiting_input（**及 `pending_approval`**），故重复点击仍被判为同一轮（M4 拦得住）。
 *
 * zx_20260915 P0-5(a): 第 7 参 `source` —— 本函数是 **GUI 侧**的答复真源，故缺省 `'gui'`；
 *   落账与发事件改经 `applyAnswerTo` / `emitAnswer`，与 IM 侧 `resumeWithQuota` 共用同一份实现
 *   （此前 `pause_response` 的内联写是本条唯一的"规则第二份"，已收归）。
 *
 * ⚠ 门禁标记（含「任务执行前需确认」）**不删**：resume 后下一次执行的门禁分支要读它回填 confirmations
 * （agent-executor.ts 的 C1 回填），且受 gate_triggered 幂等保护，每任务至多 1 条，不构成堆积。
 * 安全性：其余标记消费者（task:actionNeeded / im-router 启动重建 / admin.ipc / 启动恢复）均已限定
 * paused|failed，恢复后任务为 pending，故清理不会造成「需处理」漏报。
 */
export function settlePause(
  db: PauseDb, taskId: string, ctx: Record<string, unknown>,
  decision: string, value: string | undefined, clear: boolean, source: AnswerSource = 'gui',
): void {
  try {
    const a: AnswerRecord = { source, decision, value };
    const askedAt = applyAnswerTo(ctx, a);
    // zx_20261014_6 M4（毛选·实事求是）: `clear=true`（应答/恢复即处置）时与真源 `awaiting_input` **同收口**
    //   一并删 `pending_approval`。此前 resume 只删 `awaiting_input` 而**漏删**它 ⇒ 该辅助字段一旦写下即**永不清理**，
    //   两重后果：① 恢复过的任务此后**任何一次因别的原因暂停**都被 Dashboard 误报「⚠ 此刻最需你介入」
    //   （`project.ipc.ts:775` 判 `ctx.pending_approval`，`DashboardPage.tsx:260` 渲染）；
    //   ② 一次**迟到的** `task:respond` 会拿这个早已过期的 `pending_approval` 去写 `wa_approvals` 持久化批准。
    //   ⚠ `clear=false`（连续拒绝、保持暂停）**逐字不变**——`awaiting_input` 与 `pending_approval` 都保留（既有套件所钉）。
    if (clear) {
      delete ctx.awaiting_input;
      delete ctx.pending_approval;
    }
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
    if (clear) {
      db.prepare(
        "DELETE FROM wa_task_conversations WHERE task_id = ? AND role = 'system' AND content LIKE '[等待用户输入]%' AND content NOT LIKE '%任务执行前需确认%'",
      ).run(taskId);
    }
    const projectId = (db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id?: string } | undefined)?.project_id;
    emitAnswer(taskId, projectId, a, askedAt);
  } catch { /* 落账/清理失败不阻断恢复 */ }
}

/**
 * zx_20260910_3 M2d-a: 用户介入恢复 → **返还目标偏离额度**（叫 resume 就必须真的 resume）。
 *
 * 人工介入意味着"我已知情并要求继续"，应重新获得完整额度；不返还则出现 E20 的死锁/空转：
 * 计数停在 ≥上限后，① 旧法下每次偏离都被 abort 却又注定被闸拦下（恢复→立刻再暂停，用户实报"恢复后又暂停"）；
 * ② 新法（M2c 自增受上限约束）下连 abort 都不再发，任务只剩提醒、永不交人工。两种都不是"恢复"。
 *
 * 与恢复账分开记账：后者记的是"恢复次数"（用户介入计 `resume_count`、系统自动计 `auto_resume_count`，
 * 二者不清零，用于提示拆分子任务与判定"老重任务"），前者是"自动重启**剩余额度**"的账（此处归零）。
 * 二者混为一谈会让"介入越多额度越多"这类胡话成立。
 *
 * **本轮订正（zx_20260916_1 M5 / #6）**：此处原写"后者是用户介入次数的账（ai-task 独立自增）"，三条均不成立——
 * 自增点在 `resume-ai-task` 处理器（`jobs/ai-task.ts`），且走到那里的绝大多数是**系统路**（全库 304 笔执行作业中
 * 302 笔不带 `initiator`）。真正的拆分提示用的是**总数**。查证锚点与改动见 `plans/improve/zx_20260916_1.md` §七；
 * 账的分流真源见 `core/resume-ledger.ts`（存量值混计、不回填，该模块头注释已如实标注）。
 */
export function grantGoalDeviationQuota(ctx: Record<string, unknown>): void {
  ctx.goal_deviation_restarts = 0;
}

/**
 * zx_20260910_3 M2d-a: 无 ctx 的恢复入口（IM 各通路）统一用这一句：自读 ctx → 返还额度 → 置 pending（**一次** ctxJson 写）。
 *
 * 为什么不写成 `UPDATE ... json_set(context_json, '$.goal_deviation_restarts', 0)`：那会把"返还额度"这条规则
 * 变成第二份实现（SQL 版 vs JS 版）——判据分家正是本轮 G2 的病根（同一条规则写在两处就必然分家）。
 * 为什么不让 IM 通路也调 settlePause：那要连带改它们的 waiting 标记/判重语义，超出本轮范围；
 * 本函数只解决"恢复必须真的恢复"，与各自的等待语义解耦。
 *
 * zx_20260915 P0-5(b): 第 3 参 `opts.answer` —— IM 侧**确为答复**的入口（审批确认/选项批准/直接回复）
 * 传它，同一次 ctxJson 写里落 `answer_source`/`pause_response` 并发 `task.answer_recorded`；
 * **"启动"类恢复**（编号启动、启动指令）**不传**——启动不是对某个提问的答复，记成 answer 即名实不符。
 * 不改返回类型、不加必填参数，故 6 个既有调用点零改动（只有确为答复的 3 处补参）。
 */
export function resumeWithQuota(
  db: PauseDb, taskId: string,
  opts?: { answer?: AnswerRecord },
): void {
  let ctx: Record<string, unknown> = {};
  let projectId: string | undefined;
  try {
    const row = db.prepare('SELECT context_json, project_id FROM wa_tasks WHERE id = ?').get(taskId) as
      { context_json?: string; project_id?: string } | undefined;
    ctx = JSON.parse(row?.context_json || '{}') as Record<string, unknown>;
    projectId = row?.project_id;
  } catch { /* 脏值按空 ctx——不因解析失败而拒绝恢复 */ }
  grantGoalDeviationQuota(ctx);
  // 答复记账**先于**状态写：两者都在同一次 ctxJson 写里落库（不新增第二条 UPDATE）
  const a = opts?.answer;
  const askedAt = a ? applyAnswerTo(ctx, a) : null;
  const up = db.prepare("UPDATE wa_tasks SET status = 'pending', context_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(ctx), taskId) as { changes?: number } | undefined;
  // 一行都没改（任务不存在）时不冒充"答复已落账"——宁可不发事件，也不发一条读不到底的账
  if (a && ((up?.changes ?? 0) > 0)) emitAnswer(taskId, projectId, a, askedAt);
}

/**
 * zx_20260915 P0-5(c): 非用户恢复守卫的**唯一实现**——纯函数（不改库、不发事件、不读 setting）。
 *
 * 病根：「继续」是一句动作指令，不是对某个悬置提问的答复。而调度器/cron/D1/重试这些**非用户**恢复
 * 此前会让 `resume-ai-task` 处理器自造 `[系统恢复]` 上下文块并直接当成本轮输入 ⇒ 悬置的问题被无声吞掉，
 * 用户以为"它接着干了"，其实那个提问从未被回答。
 *
 * 条件三条同时成立才拦：**有 `awaiting_input`** ∧ **`pause_response` 未写**（还没人答过）∧ **本次恢复非人发起**。
 * `initiator` 缺省 `'system'`——六条非用户路一条都不传（方案 §5.2 病根 C），故**缺省值本身是契约**。
 *
 * ⚠ 键名**不是** `source`：`source` 在本仓作业载荷里是"哪个渠道/触发器"（`'im'`/`'cron'`），
 *   且 `im-router` 的编号启动**早已在 `resume-ai-task` 载荷上用过 `source:'im'`**——
 *   同键三义会让合法的人工启动被读成"系统自恢复"而误拦。故本轮另起 `initiator`。
 *
 * 抽为纯函数而非内联在处理器里：受控回归能**直跑真实现**（不是复刻一份判据来自我印证）。
 */
export function buildUnansweredBanner(
  ctx: Record<string, unknown> | null | undefined, initiator: string | undefined,
): string {
  const ai = ctx?.awaiting_input as { asked_at?: string; question?: string } | undefined;
  const init = initiator ?? 'system';
  if (!ai || ctx?.pause_response || init === 'user') return '';
  return `[待回复] 本任务有未答复的提问（问于 ${ai.asked_at ?? '未知时刻'}）：${ai.question ?? ''}\n`
    + `请勿把「继续」当作对该提问的同意；需要用户明确答复后再继续。`;
}

/**
 * zx_20260915 P0-5(c): 本轮输入的**合成规则**——纯函数。三条注入规则，逐条都有反面代价：
 * ① 调用方**没给**真实 message（调度器/cron 路）⇒ 横幅**替掉**自造 `[系统恢复]` 块。
 *    若两者并注入，`[系统恢复]` 仍在场 ⇒ "不被当成同意"的提醒会被淹没（判据：含横幅且不含自造块）。
 * ② 调用方**给了**真实 message（D1 逐子交付摘要、IM 回复）⇒ 横幅**前置**、真实内容**一字不丢**
 *    ——守卫的职责是补一句提醒，不是替调用方删信息。
 * ③ `forceFinalize`（子任务全完）时横幅同样前置到整合指令。
 */
export function composeResumeInput(o: {
  banner: string; synthesized: boolean; synthBlock: string | undefined;
  forceFinalize: boolean; forceFinalizeMsg: string;
}): { resumeMsg: string | undefined; finalMsg: string | undefined } {
  const resumeMsg = !o.banner
    ? o.synthBlock
    : (o.synthesized || !o.synthBlock ? o.banner : `${o.banner}\n\n${o.synthBlock}`);
  const finalMsg = !o.forceFinalize
    ? resumeMsg
    : (o.banner ? `${o.banner}\n\n${o.forceFinalizeMsg}` : o.forceFinalizeMsg);
  return { resumeMsg, finalMsg };
}
