/**
 * zx_20260911_4 M5-3（庄子·得鱼忘筌 / 管子·度量衡）：上下文压缩的**纯**规划与回退——单一真源，可测。
 *
 * 不变式：**被遮蔽的行 ⟺ 进入摘要输入的行**（即 `compacted_up_to_rowid` 之前的每一行，都必须真的被送去摘要过）。
 * 此前 `compressConversations` 只摘 `conversations.slice(-maxRows)`（尾部 40 条），
 * 而边界 `compacted_up_to_rowid` 却落在整块最后一行 ⇒ 中间行**被遮蔽却从未进入摘要**（静默丢失）。
 * 真库实测任务 `4fe7de46`：该次被遮蔽 881 行，旧实现至多 40 行能进摘要。
 *
 * 注意不变式说的是"进入了摘要**输入**"（谁被看到），不是"原文被逐字保留"——
 * 输出摘要仍受既有长度约束（每段 ≤500 字、合并后另有上限），故只保证"没有一行被跳过"。
 */
// zx_20261012_3 批二（「算得真」）：字÷4 的分度走**一处真源**（core/token-estimate.ts），不各写一份。
import { estimateTokensFromChars } from './token-estimate.js';

export interface ConvRow {
  role: string;
  content: string;
}

/**
 * 按 maxRows 分段：每段即一次 LLM 调用的输入上限（沿用原 maxRows 的"限制单次输入规模"语义），
 * 各段并集**覆盖全部输入**且保持原序。空输入返回空数组。
 */
export function planSummaryChunks<T extends ConvRow>(rows: T[], maxRows = 40): T[][] {
  const size = Math.max(1, Math.floor(Number(maxRows)) || 1);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * 规则回退摘要（LLM 不可用时）：逐条覆盖**全部**行，每行预算 = cap/n 字符，
 * 使回退分支同样满足不变式，且不再谎称"仅保留最近 N 轮"（那 N 轮同样落在被遮蔽区间内）。
 *
 * 若行数多到每行配额小于 minPerRow，返回 '' ——**宁可本轮不压缩**（边界不推进、历史留窗内），
 * 也不产生"看着像摘要、实则丢了大半"的假摘要。
 */
export function buildRuleDigest(rows: ConvRow[], cap = 6000, minPerRow = 30): string {
  const n = rows.length;
  if (n === 0) return '';
  // 每行扣掉 `[role] ` 与换行的固定开销后再算内容配额
  const budget = Math.floor(cap / n) - 12;
  if (budget < minPerRow) return '';
  const limit = Math.min(200, budget);
  const lines = rows.map(c => `[${c.role}] ${(c.content || '').replace(/\s+/g, ' ').trim().slice(0, limit)}`);
  return `（规则回退摘要：共${n}轮，逐条首句）\n${lines.join('\n')}`;
}

/**
 * zx_20260913 M4-4（道德经·知止 / 管子·度量衡）：把一段历史按**字符预算**裁剪为尾部。
 *
 * 病灶：无 LLM 摘要时，历史逐条原样回放**无任何上限**——长任务每次 resume 都整段重放，首部无界膨胀。
 * 现改用与其它上下文段相同的容量口径（`CTX_HISTORY_TAIL_MAX_CHARS`）：从**最早**那条起丢，保留尾部。
 *
 * 两条硬约束（皆可在本函数上直接断言）：
 * ① `dropped + kept.length === msgs.length`——只搬移、不改写，调用方据此如实交代"省略了几条"；
 * ② **至少保留 1 条**：单条自身即超预算时也不再切（宁可多留，不产生空历史）。
 */
export function truncateHistoryTail<T extends ConvRow>(msgs: T[], maxChars: number): { kept: T[]; dropped: number } {
  let total = msgs.reduce((a, m) => a + String(m.content || '').length, 0);
  let dropped = 0;
  while (dropped < msgs.length - 1 && total > maxChars) {
    total -= String(msgs[dropped]!.content || '').length;
    dropped++;
  }
  return { kept: msgs.slice(dropped), dropped };
}

/**
 * zx_20261018_3 批四「度」: 系统提示 token 超预算时的**截断规划**——纯函数，可被回归直跑真实现。
 *
 * 病根（方案 D-6）：原截断段在 `buildTaskContext` 返回后**立刻**执行，而验收标准 / 需求卡 / 上游要求
 *   是**之后**才追加的 system 消息。于是截断时看不见它们（预算按残缺集合算），等于"先删便宜的、
 *   再往已满的袋子里塞最贵的"；且 `sysEnd` 只数**连续 system 前缀**，历史段一夹 user/assistant 回放
 *   就停在第一条非 system 处，后面的系统块**根本没进测量面**。
 *
 * 现口径：
 *   ① 测量面 = **所有** `role === 'system'` 的消息（不是连续前缀）；
 *   ② 可删区间由调用方给 `[optionalStart, optionalEnd)`——只删低优先级层（尾部最不痛的先删），
 *      头部稳定前缀与核心提示不动；`optionalEnd` 取历史段起点 ⇒ 历史与关键注入天然不在可删面内；
 *   ③ **从区间尾部往前删**（`guidance/planning/task_line/current_date` 先走，memory/success 后走）。
 *
 * `overBudgetAfterTrim` 是"可删的都删了仍超"的诚实态——不声称已解决，由调用方如实告警。
 * 区间内**只应有 system 消息**（调用方保证）；本函数按 system 计数、按区间整段删除。
 */
export interface SystemCompactionPlan {
  /** 首个被删下标（含）。 */
  dropStart: number;
  /** 删除区间右端（不含）。== 调用方给的 `optionalEnd`。 */
  dropEnd: number;
  /** 实际删除条数（= `dropEnd - dropStart`）。 */
  removed: number;
  beforeTokens: number;
  afterTokens: number;
  overBudgetAfterTrim: boolean;
}

export function planSystemContextCompaction(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  opts: { budgetTokens: number; optionalStart: number; optionalEnd: number },
): SystemCompactionPlan {
  const len = messages.length;
  const end = Math.max(0, Math.min(len, Math.floor(opts.optionalEnd)));
  const start = Math.max(0, Math.min(end, Math.floor(opts.optionalStart)));
  const budget = Math.max(1, Math.floor(opts.budgetTokens));
  let beforeTokens = 0;
  for (let i = 0; i < len; i++) {
    if (messages[i]!.role === 'system') beforeTokens += estimateContentTokens(messages[i]!.content);
  }
  if (beforeTokens <= budget) {
    return { dropStart: end, dropEnd: end, removed: 0, beforeTokens, afterTokens: beforeTokens, overBudgetAfterTrim: false };
  }
  let afterTokens = beforeTokens;
  let dropStart = end;
  while (dropStart > start && afterTokens > budget) {
    dropStart--;
    if (messages[dropStart]!.role === 'system') afterTokens -= estimateContentTokens(messages[dropStart]!.content);
  }
  return {
    dropStart,
    dropEnd: end,
    removed: end - dropStart,
    beforeTokens,
    afterTokens,
    overBudgetAfterTrim: afterTokens > budget,
  };
}

/**
 * zx_20260921 M2（亚里士多德·潜能与现实）：**多模态 content 的字符量**——文本按字面，图片按经验值折算。
 *
 * 病灶：轮次内 token 估算此前一律 `String(m.content).length`。M2 起用户消息的 content 可能是
 * `Array<TextPart|ImagePart>`，`String([...])` 得到 `[object Object]`（恒定 15 字符）——
 * 一张 2MB 的图与一张 20KB 的图**估出来一样**，超限闸据此判定等于没有闸。
 *
 * ⚠ **这是估算，不是计量**：图像的"字符数"没有真值，`IMAGE_PART_TOKEN_ESTIMATE` 是经验折算
 * （≈1100 token，对齐 OpenAI/Anthropic 对 ~1024×1024 图的常见计费档），再 ×4 折成"字符"以与
 * 既有 `chars` 口径（`CTX_*_MAX_CHARS` 家族）同尺。**如实标注为估算**，不冒充精确 token 计数。
 */
export const IMAGE_PART_TOKEN_ESTIMATE = 1_100;

/** 把 `CoreMessage.content` 估成 token 数：`string` → `len/4`；数组 → 文本累加 + 每个非文本 part 计经验值。 */
export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokensFromChars(content.length);
  if (!Array.isArray(content)) return 0;
  let t = 0;
  for (const part of content) {
    const p = (part ?? {}) as { type?: unknown; text?: unknown };
    if (p.type === 'text' && typeof p.text === 'string') t += estimateTokensFromChars(p.text.length);
    else t += IMAGE_PART_TOKEN_ESTIMATE;
  }
  return t;
}

/** 同上，折算回**字符**口径（×4）——与 `CTX_*_MAX_CHARS` 同尺，供 `ctxAssembledChars` 这类现场记账用。 */
export function contentChars(content: unknown): number {
  return estimateContentTokens(content) * 4;
}
