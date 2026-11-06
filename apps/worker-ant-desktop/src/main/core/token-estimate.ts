/**
 * zx_20261012_3 批二（「算得真」）：**token 字符估算的唯一口径**。
 *
 * 病根（某项目 `7c39678e` 实机复盘，§1.3-G2）：主步进的 `stepPrompt/stepComp` 只读 `event.usage`，
 *   provider 不回 usage（本地端点常见）即 `0` ⇒ `totalTokensUsed` 恒 0 ⇒ 项目级 `max_tokens=4,000,000`
 *   的 **Token 闸永不触发**（而选型期系统消息仍宣称"仅 Token 闸生效"，名实不符）。
 *   治：usage 缺席时按字符估。**但估法不许各写一份**——此前仓内已有 6+ 处 `ceil(字/4)`，
 *   口径一旦分家（如某处 `round`、某处 `max 1`），同一段文本在不同账上会得不同的值，
 *   而"一个数只能有一个值"正是本轮的尺。故把**常量与函数**收在此一处。
 *
 * 纪律：
 *   · 本模块**不 import 任何东西**（保持零依赖，可被 exchange/exec 两侧自由引用）。
 *   · 沿用既有口径 `字 ÷ 4`（与 `prelude_usage`／旁路子 LLM／`output-validator` 一致），不改分度。
 *   · 空输入 ⇒ 0（**不是** 1）：`estTextTokens` 那类"空串也给 1"的旧语义由调用方自行 `max(1,…)` 叠加，
 *     本函数只回答"这段字值多少 token"。
 */

/** 字符 → token 的分度（唯一真源）。改这里即改全仓口径。 */
export const TOKEN_CHARS_PER_UNIT = 4;

/** `chars` 个字符 ≈ 多少 token。空/非正数 ⇒ 0。 */
export function estimateTokensFromChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / TOKEN_CHARS_PER_UNIT) : 0;
}

/** `onStepFinish` 的 usage 面（`ai` SDK 的 `StepResult` 结构上可赋给本型）。 */
export interface StepUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  outputTokens?: number;
}

export interface StepTokenDelta {
  /** 本步 prompt 增量（真值差分，或 usage 缺席时的字符估）。 */
  prompt: number;
  /** 本步 completion 增量。 */
  completion: number;
  total: number;
  /** true ⇒ 本步数字是**估**的（provider 没回 usage），下游须标注，不得冒充真值。 */
  estimated: boolean;
}

/**
 * 算**这一步**的 token 增量——主步进记账的真源（`exec-step.ts` 的 `onStepFinish` 调它）。
 *
 * · usage **在场**（`promptTokens` 或 `completionTokens/outputTokens` > 0）⇒ 逐字沿用既有口径：
 *   provider 可能回"累计"值 ⇒ 用 `prev` 差算逐步增量（zx_20260904_7）。
 * · usage **缺席** ⇒ `estimated:true`，按字符估：prompt 取本步送入上下文的字符数 `inChars`，
 *   completion 取本步产出字符数 `outChars`。
 */
export function stepTokenDelta(input: {
  usage?: StepUsageLike;
  prevPrompt: number;
  prevComp: number;
  inChars: number;
  outChars: number;
}): StepTokenDelta {
  const curPrompt = input.usage?.promptTokens ?? 0;
  const curComp = input.usage?.completionTokens ?? input.usage?.outputTokens ?? 0;
  if (curPrompt > 0 || curComp > 0) {
    const prompt = curPrompt > 0 ? Math.max(0, curPrompt - input.prevPrompt) : 0;
    const completion = curComp > 0 ? Math.max(0, curComp - input.prevComp) : 0;
    return { prompt, completion, total: prompt + completion, estimated: false };
  }
  const prompt = estimateTokensFromChars(input.inChars);
  const completion = estimateTokensFromChars(input.outChars);
  return { prompt, completion, total: prompt + completion, estimated: true };
}
