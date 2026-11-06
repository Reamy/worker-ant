/**
 * 暂停之「因」的一处真源——执行器落暂停时写，调度器判可解性时读。
 *
 * 为什么需要它：执行器在收口/收尾时若发现仍有未完成子任务，会把父任务置 `paused`
 * （agent-executor.ts 两处，`reason: 'children_incomplete'`）。而调度器 `scanReadyTasks`
 * 对祖先链含 `paused` 的后继一律不拉起（A2，防「用户暂停后依赖链又自动执行」）。
 * 二者相遇即互锁：**父因等子而暂停 ⇒ 子因父暂停而永不起 ⇒ 父等不到子完成而永不恢复**。
 *
 * 故「因等子任务而暂停」必须与「用户在停」区分开：前者不是停摆，其后继应当照常被拉起。
 * 判据只此一份——写点与读点都从这里取，勿在别处手抄字面量。
 */

/** 暂停原因：因尚有未完成子任务而暂停（引擎自置，非用户在停） */
export const PAUSE_REASON_CHILDREN_INCOMPLETE = 'children_incomplete';

/**
 * 暂停原因：收口时**无任何真实产出证据**（引擎自置，非用户在停）。
 *
 * 与上面的区别在"该不该被自动放行"：等子是**时序**问题，子任务一完成即自动恢复；
 * 无产出是**事实**问题——引擎按判据认定"没有东西可交付"，只能由人工核验后处置，
 * 故 `isChildrenIncompletePause` 对它必须返回 false（后继继续被拦）。
 */
export const PAUSE_REASON_NO_OUTPUT = 'no_output';

/**
 * 暂停原因：**有子任务失败且未处置**（zx_20260915 P0-3，引擎自置，非用户在停）。
 *
 * 此前 `failed` 被列入收口"终态白名单"，子任务失败**不阻塞**父任务完成——
 * 实测 `02adce34` 失败后 106 秒父任务照标 `completed`（父把子的失败静默吸收）。
 * 现改为：命中即置 `paused` + 本原因 + 逐个点名失败子。
 *
 * 与 `children_incomplete` 的区别在**该不该被自动放行**：等子是**时序**问题，子一到终态即自动恢复；
 * "有失败子"是**事实**问题——须人看一眼（重试或处置），故与 `no_output` 同档：
 * `isChildrenIncompletePause` 对它返回 **false**，其后继继续被拦（不当作可自愈的时序暂停）。
 * 后路（防死锁）：失败子被重试至 `completed`、或被人工 `archived`/标记完成后，
 * `checkParentTaskAfterChildDone` 再判即归零、父任务自动恢复（沿用既有 D1，不新增机制）。
 */
export const PAUSE_REASON_CHILDREN_FAILED = 'children_failed';

/**
 * 暂停原因：**验收已核验且未通过**（zx_20260917 M1 新增，引擎自置）。
 *
 * 与 `no_output` 的区别：`no_output` 是"根本没东西可交"，本因是"交了但判卷说不达标"。
 * 两者都不该被自动放行（`isChildrenIncompletePause` 均返回 false）。
 */
export const PAUSE_REASON_ACCEPTANCE_FAILED = 'acceptance_failed';

/**
 * 暂停原因：**有验收判据、本轮却没判成**（zx_20260923_1 M2 新增，引擎自置）。
 *
 * 与 `acceptance_failed` 的区别：那个是"判了，判卷说不达标"；本因是"**题在，没判成**"
 * （无可用模型 / 模型没吐可解析结论 / 核对异常）。两者都不该被自动放行
 * （`isChildrenIncompletePause` 均返回 false）。
 *
 * 与 `no_output`/`quality_below_bar` 的区别在**该做什么**：那两个要人核验产出；
 * 本因要人**恢复重跑**（模型恢复即可再判一次）或补处置——故不得记成"产出不行"。
 *
 * ⚠ 注意与 `not_checked`（**没有题目**：`no_criteria`/`no_user_criteria`）的分野：
 *   那一类**不**暂停（A4：不该拿"无人许诺判据"去罚规划类任务），本类**必须**暂停。
 *   判据的分野在 `acceptance-check.ts` 的 `acceptanceVerdictOf`/`UNJUDGED_REASONS`，本文件只管给因由一个名字。
 */
export const PAUSE_REASON_ACCEPTANCE_UNJUDGED = 'acceptance_unjudged';

/* ───────────────────────── zx_20260917 M1：其余 16 个因由 ─────────────────────────
 * 起因：全量 `src/main` 下 24 处「置 paused」直写点里 **20 处不写因**，而 `pause-reason.ts` 开篇自称
 * 「一处真源」——名实不符。本批把"置暂停"收成唯一入口 `pauseTask`（`pause-task.ts`），因由**必填**。
 * 命名取自「**为什么**停」：以执行者命名不算因（故 `stale_reaped`→`planning_timeout`、
 * `self_healed`→`exec_timeout`）；执行者信息进 label，不丢。
 */

/** 用户在中止/暂停（GUI「中止」「暂停」、IM、托盘）——**用户在停**，不是引擎判定 */
export const PAUSE_REASON_USER_INTERRUPT = 'user_interrupt';
/** 等用户输入/决策（`ask_user`、路径审批、特权审批三条路共用一个闭包；细分仍看 `awaiting_input.decision_type`） */
export const PAUSE_REASON_AWAITING_INPUT = 'awaiting_input';
/** 执行前的「待确认事项」门禁未过（`pending_confirmation`） */
export const PAUSE_REASON_PENDING_CONFIRMATION = 'pending_confirmation';
/** 策略引擎判定暂停（成本/错误率策略） */
export const PAUSE_REASON_POLICY_PAUSED = 'policy_paused';
/** AI 供应商账户级故障（无备用可用）——充值/换供应商后方可恢复 */
export const PAUSE_REASON_AI_PROVIDER_FAILED = 'ai_provider_failed';
/**
 * AI 引擎（SDK 层）**同一事故内连续失败两次**，自动重试额度已用尽（zx_20260923 M1）。
 *
 * 与上面的区别在**恢复条件**：账户级故障要人去充值/换供应商；本因是请求本身反复被拒
 * （如 thinking 模型的 `reasoning_content` 回传问题），**用户恢复即重新获得一次重试额度**。
 * 两者都不是任务内容的问题，故都不该记成 `failed`（把外部故障记在任务头上）。
 */
export const PAUSE_REASON_AI_SDK_UNAVAILABLE = 'ai_sdk_unavailable';
/** 产出文件多次未落盘（补写一轮后仍未落盘，不再自动重试） */
export const PAUSE_REASON_OUTPUT_MISSING = 'output_missing';
/** 声明产出已生成但充分性校验多次未通过 */
export const PAUSE_REASON_OUTPUT_INSUFFICIENT = 'output_insufficient';
/** 质量分未达交付标准（预算/步数到顶后的 `partial` 收尾、或过早结束且分<60） */
export const PAUSE_REASON_QUALITY_BELOW_BAR = 'quality_below_bar';
/** 连续 N 次调用同一工具（疑似工具循环） */
export const PAUSE_REASON_TOOL_LOOP = 'tool_loop';
/** 连续 N 步无任何输出与工具调用（空转） */
export const PAUSE_REASON_NO_PROGRESS = 'no_progress';
/** 目标多次偏离、已停止自动恢复（偏离提醒已作 user 消息写库） */
export const PAUSE_REASON_GOAL_DEVIATION = 'goal_deviation';
/** 计划模式停留超时（`MAX_PLANNING_MS`） */
export const PAUSE_REASON_PLANNING_TIMEOUT = 'planning_timeout';
/** 执行中超时无心跳（自愈监视器判定） */
export const PAUSE_REASON_EXEC_TIMEOUT = 'exec_timeout';
/** 滞留执行/准备态超 24 小时（架构不变量巡检批量置停） */
export const PAUSE_REASON_STALE_TIMEOUT = 'stale_timeout';
/** 应用**启动时**清理上一进程残留的执行/准备态（非运行时判定） */
export const PAUSE_REASON_STARTUP_SWEEP = 'startup_sweep';
/** 非正常结束：`executeTask` 已返回，任务却仍停在 executing/preparing */
export const PAUSE_REASON_ABNORMAL_END = 'abnormal_end';
/** 执行体（AI）经 `update_task_status` 工具主动置暂停 */
export const PAUSE_REASON_AGENT_PAUSED = 'agent_paused';

/**
 * 暂停之因的**取值域**——`pauseTask` 的 `reason` 取此类型，故"无因暂停"在类型层**不可表达**。
 *
 * 用 `typeof` 逐个引用上面的常量（而非另抄一份字面量）：改常量名漏改这里即**编译不过**，
 * 不给"类型说一套、写点写另一套"留缝。
 */
export type PauseReason =
  | typeof PAUSE_REASON_CHILDREN_INCOMPLETE
  | typeof PAUSE_REASON_CHILDREN_FAILED
  | typeof PAUSE_REASON_NO_OUTPUT
  | typeof PAUSE_REASON_ACCEPTANCE_FAILED
  | typeof PAUSE_REASON_ACCEPTANCE_UNJUDGED
  | typeof PAUSE_REASON_USER_INTERRUPT
  | typeof PAUSE_REASON_AWAITING_INPUT
  | typeof PAUSE_REASON_PENDING_CONFIRMATION
  | typeof PAUSE_REASON_POLICY_PAUSED
  | typeof PAUSE_REASON_AI_PROVIDER_FAILED
  | typeof PAUSE_REASON_AI_SDK_UNAVAILABLE
  | typeof PAUSE_REASON_OUTPUT_MISSING
  | typeof PAUSE_REASON_OUTPUT_INSUFFICIENT
  | typeof PAUSE_REASON_QUALITY_BELOW_BAR
  | typeof PAUSE_REASON_TOOL_LOOP
  | typeof PAUSE_REASON_NO_PROGRESS
  | typeof PAUSE_REASON_GOAL_DEVIATION
  | typeof PAUSE_REASON_PLANNING_TIMEOUT
  | typeof PAUSE_REASON_EXEC_TIMEOUT
  | typeof PAUSE_REASON_STALE_TIMEOUT
  | typeof PAUSE_REASON_STARTUP_SWEEP
  | typeof PAUSE_REASON_ABNORMAL_END
  | typeof PAUSE_REASON_AGENT_PAUSED;

/** 暂停原因 → 人话（GUI 横幅 / IM 通知 / 系统会话行共用；**词表只此一份**） */
export const PAUSE_REASON_LABEL: Record<string, string> = {
  [PAUSE_REASON_CHILDREN_INCOMPLETE]: '子任务尚未完成',
  [PAUSE_REASON_CHILDREN_FAILED]: '子任务失败未处置',
  [PAUSE_REASON_NO_OUTPUT]: '无产出',
  [PAUSE_REASON_ACCEPTANCE_FAILED]: '验收未通过',
  [PAUSE_REASON_ACCEPTANCE_UNJUDGED]: '验收未取得结论（有判据但本轮没判成）',
  [PAUSE_REASON_USER_INTERRUPT]: '用户中止/暂停',
  [PAUSE_REASON_AWAITING_INPUT]: '等待用户回复/决策',
  [PAUSE_REASON_PENDING_CONFIRMATION]: '执行前待用户确认',
  [PAUSE_REASON_POLICY_PAUSED]: '策略触发暂停',
  [PAUSE_REASON_AI_PROVIDER_FAILED]: 'AI 供应商不可用（账户级故障）',
  [PAUSE_REASON_AI_SDK_UNAVAILABLE]: 'AI 引擎连续失败，重试已用尽（恢复即重新获得一次重试）',
  [PAUSE_REASON_OUTPUT_MISSING]: '产出文件多次未落盘',
  [PAUSE_REASON_OUTPUT_INSUFFICIENT]: '产出内容多次不充分',
  [PAUSE_REASON_QUALITY_BELOW_BAR]: '质量分未达交付标准',
  [PAUSE_REASON_TOOL_LOOP]: '疑似工具循环',
  [PAUSE_REASON_NO_PROGRESS]: '连续多步无输出（空转）',
  [PAUSE_REASON_GOAL_DEVIATION]: '目标多次偏离',
  [PAUSE_REASON_PLANNING_TIMEOUT]: '计划模式超时',
  [PAUSE_REASON_EXEC_TIMEOUT]: '执行超时无心跳（自愈暂停）',
  [PAUSE_REASON_STALE_TIMEOUT]: '滞留执行超 24 小时（巡检暂停）',
  [PAUSE_REASON_STARTUP_SWEEP]: '应用启动时清理残留执行态',
  [PAUSE_REASON_ABNORMAL_END]: '执行未能正常收口',
  [PAUSE_REASON_AGENT_PAUSED]: '执行体主动暂停',
};

/** 取暂停原因的人话说法；未知原因**原文回显**（不吞、不编） */
export function pauseReasonLabel(reason: string | null | undefined): string {
  if (!reason) return '';
  return PAUSE_REASON_LABEL[reason] || reason;
}

/**
 * 账上记的暂停因由**原文**；无记录（M1 收口前的直写点不写因 / 坏 JSON）返回空串——**不编因**。
 *
 * zx_20260917 M3: 依赖判定要按因由细分 `paused`（等子的会自解、其余不会），故需要一个"读出因由原文"
 * 的读点与 `isChildrenIncompletePause` 共用同一次解析——解析只此一处，两个读点各写一遍就会漂。
 */
export function recordedPauseReason(contextJson: string | null | undefined): string {
  try {
    const r = (JSON.parse(contextJson || '{}') as { pause_reason?: unknown }).pause_reason;
    return typeof r === 'string' ? r.trim() : '';
  } catch {
    return '';
  }
}

/**
 * zx_20261028_1 M5：账上记的**暂停附注**（`$.pause_note`，`control.ts` 与 `pauseTask.extraContext` 写入）；
 * 无记录返回空串——**不编注**。与 `recordedPauseReason` 同形，是渲染层读这一格的**唯一读点**
 * （词表第二个落点不得手抄键名）。
 */
export function recordedPauseNote(contextJson: string | null | undefined): string {
  try {
    const n = (JSON.parse(contextJson || '{}') as { pause_note?: unknown }).pause_note;
    return typeof n === 'string' ? n.trim() : '';
  } catch {
    return '';
  }
}

/** 该任务的暂停是否属「等子任务」——调度器唯一读点 */
export function isChildrenIncompletePause(contextJson: string | null | undefined): boolean {
  return recordedPauseReason(contextJson) === PAUSE_REASON_CHILDREN_INCOMPLETE;
}

/**
 * zx_20261022_3 批十二（信·名实）：这次暂停是否意味着**该任务已不会再自行推进**——父任务据此被唤醒复核。
 *
 * 病根（真标本 `094a8b47`/`e54532f9`）：子任务验收未通过被置暂停后，父任务停在 `children_incomplete`
 * 等它"完成"，而它已停、永不再动 ⇒ 父永不被唤醒，M2 两个子任务从未被拉起。
 *
 * **排除三类"还会自己走"的停**，否则会把常态误当定局：
 *   · `children_incomplete`——在等自己的子，子一到站即恢复；
 *   · `awaiting_input`/`pending_confirmation`——在等用户答复，答复后原路续跑；
 *   · `user_interrupt`——用户在停，自动唤醒父等于替用户把任务重启起来。
 * 其余引擎判定的停（验收未过、低于标准、工具循环、供应商故障、超时巡检等）都是定局。
 */
export function pauseSettlesParent(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return ![
    PAUSE_REASON_CHILDREN_INCOMPLETE,
    PAUSE_REASON_USER_INTERRUPT,
    PAUSE_REASON_AWAITING_INPUT,
    PAUSE_REASON_PENDING_CONFIRMATION,
  ].includes(reason);
}

// ─────────────────────── 暂停告知的文案（zx_20260917 M2） ───────────────────────

/**
 * 一次暂停要告诉人的**全部事实**。调用方（`task-notice.ts`）**查好再传**——
 * 本模块零 `import`（渲染层跨 root 直引它，见 `dep-graph.ts` 的依赖闭包判据），不碰 DB。
 */
export interface PauseNoticeFacts {
  /** 任务名（调用方已从账上取，本函数不查库） */
  name: string;
  /** 状态词（由账上 `status` 派生，**不由本函数猜**——同 `buildTaskNotice` 的"不信任调用方"纪律） */
  word: string;
  /** 账上 `$.pause_reason` **原文**；空串 = 账上未记因由 */
  pauseReason: string;
  /**
   * 调用方附带的补充说明（如"AI 引擎账户级故障：余额不足…"）。
   *
   * ⚠ 与因由**并列**而非二选一：旧写法 `detail || pauseReasonLabel(pauseReason)` 会让
   * 一句补充说明**把账上的因由整条顶掉**——账是事实、补充是注解，注解不该吃掉事实。
   */
  note?: string;
  /** 本次暂停**拦住了几个下游**（非终态、`depends_on` 指向本任务）——0 则整句不出现 */
  blockedDownstream: number;
  /** 本任务占着父任务的在途槽位且**父已满**（父因此建不出后续子任务）；未满传 null */
  parentSlots?: { active: number; max: number } | null;
}

/**
 * 暂停告知正文的**唯一构造处**（`buildTaskNotice` 的 `paused` 分支调它，IM 与站内通知同源）。
 *
 * 为什么把文案**抽出来**而不是在 `task-notice.ts` 里就地拼：本模块零 `import` 且是词表所在，
 * 受控回归能**直调真实现**（承本仓既有手法："抽纯函数让 rr 跑真实现"）。抽出的目的**只是**这个，
 * 不是另立第二条链路——`buildTaskNotice` 仍是唯一调用方（判据 G-2 钉死）。
 *
 * 三件事**必须同时在场**，缺一件这通知就白发了：
 *   ① **因**：账上 `pause_reason` 的人话；账上确无 ⇒ 如实说"因未记录"，**不编、也不静默留空**
 *      （§1.4-Ⅳ 实测：用户最可能点开的那条"已暂停"通知里一个字的原因都读不到）；
 *   ② **拦住了谁**：不讲这一句，读者无从判断"值不值得现在管"；
 *   ③ **下一步能做什么**：引导恒在。
 */
export function buildPauseNotice(f: PauseNoticeFacts): string {
  const facts: string[] = [];
  const why = pauseReasonLabel(f.pauseReason);
  if (why) facts.push(why);
  const note = (f.note || '').trim();
  if (note) facts.push(note);
  // 账上无因 + 调用方也没话说 ⇒ 明说"因未记录"。**不得**静默留空（那正是 M0 冻死时那 3 条的形态）。
  if (facts.length === 0) facts.push('因未记录');
  if (f.blockedDownstream > 0) facts.push(`本次暂停拦住了 ${f.blockedDownstream} 个下游任务`);
  if (f.parentSlots) {
    facts.push(`它还占着父任务的槽位（${f.parentSlots.active}/${f.parentSlots.max} 已满），父因此建不出后续子任务`);
  }
  return `任务「${f.name}」${f.word}，待复核：${facts.join(' · ')}——可在桌面处理/恢复`;
}
