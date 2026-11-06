/**
 * 记忆**写侧**的内容装配 —— 一处真源（zx_20260930 M5「记忆的写侧补全」）。
 *
 * 病根：`failure_knowledge` / `subagent_experience` / `user_correction` 三类**读侧在册、写侧为零**——
 *   `exec-context.ts` 按 `memory_type = MEM_TYPE_FAILURE_KNOWLEDGE` 查 3 条去装 `<failure-awareness>`，
 *   而全仓无一处以该 type 写入 ⇒ 该块**恒空**；`subagent_experience` 只在统计里被数（恒 0）；
 *   `user_correction` 的 0.95 顶分 / 永不覆盖 / 衰减豁免三条**全部不可达**。
 *   本轮补写侧。**"这条记忆该说什么"由本文件的纯函数定**，而非在四个写点各拼一遍：
 *   ① 受控回归可直接 `import` 真函数做两侧可分断言（在夹具里重写一份就是"判据的自我印证"，本仓已复发两次）；
 *   ② 读侧要的形状（`exec-context.ts` 取 `content` 前 120 字）与写侧产出**只此一处对齐**。
 *
 * ⚠ 本模块**只装配文本，不落库**：落库仍走 `MemoryManager.storeText`（它负责 importance 夹取、
 *   编码语境与证据锚点的填充）。写点分居四路（任务失败终态 / 子 agent 终态 / IM 路由 / GUI IPC），
 *   各自落库入参不同，但"该说什么"应当同尺。
 * ⚠ 输出必须**确定**（同入参恒同串）：不得掺入墙钟、随机数、`Set` 迭代序——否则判据只能写成
 *   "包含某子串"这种抓不住回归的弱形态。
 */
import { MEM_TYPE_FAILURE_KNOWLEDGE, MEM_TYPE_SUBAGENT_EXPERIENCE } from './memory-constants.js';
// 「哪些终态可复盘 / 该总结成配方还是教训」由 `task-terminal.ts` 一处回答——此处只消费，不另立一份判据。
import { reviewFocus } from './task-terminal.js';

export { MEM_TYPE_FAILURE_KNOWLEDGE, MEM_TYPE_SUBAGENT_EXPERIENCE };

/** `wa_tasks.context_json.failure_record`——`agent-executor` 在"无产出物"路写入的既有真源（本模块不生产它，只消费）。 */
export interface FailureRecord {
  reason?: string;
  toolCount?: number;
  tools?: string[];
  stepsUsed?: number;
}

/**
 * 「本次失败该归因到哪几条被用过的记忆」——只认**硬锚点**，取不到就一条都不标（zx_20260930 M6-3）。
 *
 * 病根（夏克特·错误归因 / misattribution）：旧写法是"任务失败 ⟹ 本次注入过的记忆**全**打 `staleness`"，
 *   于是一次基础设施故障（DNS 不通 / 配额耗尽 / 平台抖动）会把**十几条与它毫无关系的记忆**标成
 *   "可能过时"，置信各 ×0.7 且要等下一次成功才清得掉。归因的对象根本不是失败的原因。
 *
 * 新口径承 M2-(c)「只在真知道时标」：锚点**只从失败自己留下的字据里取**——
 *   ① `failure_record.tools[]`（本次真调用过的工具名）
 *   ② `failure_record.reason` 的实词
 *   ③ 任务标题的实词
 * 取不到锚点（`failure_record === null`，即"非无产出物"的异常失败路）⇒ 返回空 ⇒ 调用方**只记计数**，
 *   不降权、不打 stale。宁可少标，不可乱标。
 *
 * ⚠ **后果如实**：本函数的收窄是设计所求，不是副作用——绝大多数失败将落进"只记计数"那一支。
 * 纯函数、零依赖、输出**确定**（`tools` 里可能重复，去重后按**出现序**保留；不掺墙钟/随机/`Set` 迭代序）。
 */
export function failureAnchors(record: FailureRecord | null | undefined, title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    const t = (raw || '').trim();
    if (t.length < 2) return; // 单字锚点（"的"/"了"/"A"）在几乎任何正文里都命中 ⇒ 等于没锚，只会白标
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  const WORDS = /[\s,，。、；：！？/\\·\-—()（）[\]【】"'"'`]+/;
  for (const t of record?.tools ?? []) push(t);
  for (const w of (record?.reason || '').split(WORDS)) push(w);
  for (const w of (title || '').split(WORDS)) push(w);
  return out;
}

/**
 * 该条记忆与本次失败**是否可指认关联**：正文或证据锚点（`context_json.evidence.file_path`）里
 * 出现任一硬锚点（大小写不敏感）。`anchors` 为空 ⇒ 恒 `false`。
 *
 * ⚠ 空锚点在此**刻意**不等于"标全部"：`false` 的意思是"指认不了"，而"指认不了"在本轮口径里
 *   就等于**不动它**（调用方据此只记计数）。这正是本函数与旧写法分道的地方。
 */
export function isAttributable(content: string, anchors: string[], evidenceFilePath?: string | null): boolean {
  if (anchors.length === 0) return false;
  const hay = `${content || ''}\n${evidenceFilePath || ''}`.toLowerCase();
  return anchors.some((a) => hay.includes(a.toLowerCase()));
}

export interface FailureKnowledgeInput {
  /** 任务标题（缺失时如实写"（未命名任务）"，不编造）。 */
  title: string;
  /** 失败消息（`err.message`）。可缺——"没记录到原因"与"原因是空"是两回事，缺就整行不写。 */
  errorMessage?: string | null;
  /** 既有真源 `context_json.failure_record`；**只有"无产出物"路会写它**，其余路为 null。 */
  record?: FailureRecord | null;
  /** 任务原型（`context_json.archetype`），可缺。 */
  archetype?: string | null;
}

/**
 * 失败知识的内容。三段：**类别**（必有一句——缺证据时如实写"执行异常"，不是编一个具体类别）、
 * **详情**（有则写）、**上下文**（有哪项写哪项，一项都没有就整行不写）。
 */
export function buildFailureKnowledge(input: FailureKnowledgeInput): string {
  const title = (input.title || '').trim() || '（未命名任务）';
  const category = (input.record?.reason || '').trim() || '执行异常';
  const lines = [`任务「${title}」失败——类别：${category}`];

  const detail = (input.errorMessage || '').trim();
  if (detail) lines.push(`失败详情：${detail}`);

  const ctx: string[] = [];
  if ((input.archetype || '').trim()) ctx.push(`原型=${input.archetype!.trim()}`);
  if (typeof input.record?.stepsUsed === 'number') ctx.push(`步数=${input.record.stepsUsed}`);
  if (typeof input.record?.toolCount === 'number') ctx.push(`工具调用=${input.record.toolCount}`);
  if (input.record?.tools && input.record.tools.length > 0) ctx.push(`最近工具=${input.record.tools.join('、')}`);
  if (ctx.length > 0) lines.push(`上下文：${ctx.join('，')}`);

  return lines.join('\n');
}

export interface SubagentExperienceInput {
  /** 角色（`context_json.subagentType`，由 `tools/resource.ts` 在派子 agent 时写入）。缺失时写"子agent"。 */
  role?: string | null;
  title: string;
  ok: boolean;
  /** 成败的一句话原因（成功取完成摘要；失败取失败原因/暂停因）。可缺。 */
  reason?: string | null;
  /** 关键事实（如产出物名、落点路径）。可缺。 */
  keyFacts?: string | null;
}

/** 子 agent 经验的内容：首行必是"角色「标题」完成/未完成"，其余按有无如实增减。 */
export function buildSubagentExperience(input: SubagentExperienceInput): string {
  const role = (input.role || '').trim() || '子agent';
  const title = (input.title || '').trim() || '（未命名子任务）';
  const lines = [`${role}「${title}」${input.ok ? '完成' : '未完成'}`];

  const reason = (input.reason || '').trim();
  if (reason) lines.push(`结果：${reason}`);

  const facts = (input.keyFacts || '').trim();
  if (facts) lines.push(`关键事实：${facts}`);

  return lines.join('\n');
}

export interface ImUserCorrectionInput {
  /** 用户原话（必填——空话不产生记忆，调用方须先判空）。 */
  text: string;
  /** 渠道（微信/钉钉/…）。可缺。 */
  channel?: string | null;
  /** 这句话归属的、当时挂起的那张任务标题。可缺。 */
  taskTitle?: string | null;
}

/**
 * IM 渠道的用户纠正内容。
 *
 * 语义：用户对一张**挂起任务**的自由回复——任务停下正是因为需要人，用户此刻说的话
 * **就是**对 agent 正在做的事的指引/更正，故按 `user_correction`（顶分、永不覆盖、衰减豁免）记录。
 * ⚠ 只加一句**出处前缀**，用户原话**逐字保留**——改写用户的话即等于伪造纠正。
 */
export function buildImUserCorrection(input: ImUserCorrectionInput): string {
  const text = (input.text || '').trim();
  const parts: string[] = [];
  const taskTitle = (input.taskTitle || '').trim();
  if (taskTitle) parts.push(`任务「${taskTitle}」`);
  const channel = (input.channel || '').trim();
  if (channel) parts.push(`渠道=${channel}`);
  const head = parts.length > 0 ? `用户纠正（${parts.join('，')}）：` : '用户纠正：';
  return `${head}${text}`;
}

// ==================== 复盘（`background-review`）——**按终态分叉** ====================

export interface TaskReviewInput {
  /** 任务终态（`wa_tasks.status`）——分叉的**唯一**依据（与 `task-terminal.ts` 的 `reviewFocus` 同尺）。 */
  status: string | null | undefined;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  /** 成功路的"实际"（`context_json.completion_summary`）。 */
  completionSummary?: string | null;
  /** 失败证据（`context_json.failure_record`）。 */
  failureRecord?: FailureRecord | null;
  /** 任务为何停下等人（`context_json.awaiting_input.question`）。 */
  awaitingQuestion?: string | null;
  /** 验收没判成的原因（`context_json.acceptance_check.reason`）。 */
  acceptanceReason?: string | null;
}

/**
 * 「实际发生了什么」那一段——**成功与失败各取各的真源，都不编**。
 *
 * - 成功取 `context_json.completion_summary`（`finalize_task` 成功收尾时写入）。
 * - 失败**没有** `completion_summary`（那条路根本不写它）⇒ 如实取失败证据：
 *   `failure_record`（**只有"无产出物"路写**）/ `awaiting_input.question`（任务为何停下等人）/
 *   `acceptance_check.reason`（验收为何没判成）。
 *
 * 返回 `null` = 手上一条可复述的事实都没有 ⇒ **不编**，调用方据此跳过复盘
 * （编一段"实际经过"喂给 LLM，复盘出来的教训就是无源之谈）。
 */
export function buildReviewActual(input: TaskReviewInput): string | null {
  const summary = (input.completionSummary || '').trim();
  if (summary) return summary.slice(0, 500);

  const parts: string[] = [];
  const rec = input.failureRecord;
  if (rec) {
    const bits: string[] = [];
    if ((rec.reason || '').trim()) bits.push(`原因=${rec.reason!.trim()}`);
    if (typeof rec.stepsUsed === 'number') bits.push(`步数=${rec.stepsUsed}`);
    if (typeof rec.toolCount === 'number') bits.push(`工具调用=${rec.toolCount}`);
    if (rec.tools && rec.tools.length > 0) bits.push(`最近工具=${rec.tools.join('、')}`);
    if (bits.length > 0) parts.push(`执行未产出成果（${bits.join('，')}）`);
  }
  const ask = (input.awaitingQuestion || '').trim();
  if (ask) parts.push(`任务停下等人工答复，问的是：${ask.slice(0, 200)}`);
  const acc = (input.acceptanceReason || '').trim();
  if (acc) parts.push(`验收未判成，原因：${acc.slice(0, 200)}`);
  if (parts.length === 0) return null;
  return parts.join('\n').slice(0, 500);
}

/**
 * 复盘的**整段提示词**——`focus` 分叉（成功=配方 / 失败=教训与阻塞条件），
 * 输出 JSON 键 `{delta, lesson, action}` **两路同形**（下游解析/落库只有一份）。
 *
 * `null` = 没有"实际"可讲（见 `buildReviewActual`）⇒ 调用方跳过，不产生复盘记忆。
 */
export function buildTaskReviewPrompt(input: TaskReviewInput): { focus: 'recipe' | 'lessons'; prompt: string } | null {
  const actual = buildReviewActual(input);
  if (!actual) return null;
  const focus = reviewFocus(input.status);
  const plan = `计划（标题/描述/验收标准）：\n${(input.title || '').slice(0, 200)}\n${(input.description || '').slice(0, 300)}\n${(input.acceptanceCriteria || '').trim() || '（无验收标准）'}`;
  const ask = focus === 'lessons'
    ? '以下是工蚁系统一个**未成功**任务的计划与中止情况。请复盘：为什么没做成？卡在什么条件上（缺什么才能继续）？下次遇到同类任务该怎么做？'
    : '以下是工蚁系统一个已完成任务的计划与完成情况。请复盘：计划与实际有何偏差？有什么可复用的教训？下次怎么做？';
  const tail = focus === 'lessons'
    ? '输出 JSON：{"delta":"失败/中止的直接原因","lesson":"教训与阻塞条件","action":"下次遇到同类任务应怎么做（一句话可行动建议）"}, 简洁中文，不要泛泛而谈，不要复述已发生的事。'
    : '输出 JSON：{"delta":"偏差说明","lesson":"可复用教训","action":"下次遇到类似任务应怎么做（一句话可行动建议）"}, 简洁中文，不要泛泛而谈。';
  return { focus, prompt: `${ask}\n\n${plan}\n\n实际经过：\n${actual}\n\n${tail}` };
}
