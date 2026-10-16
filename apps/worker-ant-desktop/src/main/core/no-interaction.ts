/**
 * zx_20261011 M11（维特根斯坦·意义即用法 / 老子·知止）: **不可交互任务**——请求方无从应答。
 *
 * 真源：任务 `context_json` 的 `no_interaction` 键（由中继层 `node-request-runner.ts` 派单落任务时写入）。
 * 由来（E2E 第四轮）：派"用一句话介绍你自己"，B 端执行体却调 `ask_user` 问"输出形式的确认（A/B/C）"
 * ⇒ 任务 `paused`，而请求方是**外部 AI 终端**、无从应答 ⇒ 活卡死。
 * 桌面端的任务之所以顺，是因为**有人在 GUI 里答**；派来的活没人答，故不许等。
 *
 * ⚠ 全仓**同一份语义三个读点**，皆经本模块（键名与判法**一处真源**，不在别处手抄）：
 *   - `tools/control.ts` 的 `ask_user`：短路提问，把"请自行决断"当**工具结果**回给模型；
 *   - `exec-claim.ts` 的执行前门禁：直接放行，不暂停；
 *   - `agent-executor.ts` 的 `pauseForDecision`（zx_20261011_2 D9 补）：**置停之前**先问，命中即不置停（唯一咽喉）。
 * ⚠ 只认**显式 `true`**：键缺失 / 非布尔 / JSON 不可解析 ⇒ 一律按"可交互"处理——
 *   抑制只在**确知**时生效，绝不因读不到而误伤普通任务。
 *
 * 本模块**零依赖**（只碰 JSON 字符串）：故 rr 可直跑、无模块图代价。
 */

/** 任务上下文里标记"不可交互"的键——**一处真源**（写口与两个读口皆引此名）。 */
export const NO_INTERACTION_KEY = 'no_interaction';

/** 该任务是否"不可交互"（请求方无从应答）。只认显式 `true`。 */
export function isNoInteraction(contextJson: string | null | undefined): boolean {
  try {
    const c = JSON.parse(contextJson || '{}') as Record<string, unknown>;
    return c?.[NO_INTERACTION_KEY] === true;
  } catch { return false; }
}

/**
 * `ask_user` 对不可交互任务的**拒绝回执**（作工具结果回给模型）——能做完就做完（结论里写明默认假设），
 * 真做不了照常如实说明无法完成（不假装成功）。可交互任务 ⇒ `null`（按原语义提问）。
 */
export function noInteractionAskRefusal(contextJson: string | null | undefined): string | null {
  if (!isNoInteraction(contextJson)) return null;
  return JSON.stringify({
    status: 'cannot_ask',
    message: '本任务由外部终端一次性派发，请求方无法应答任何提问。请勿等待：就当前问题取最合理的默认并继续完成，并在最终结论中写明你做了哪些默认假设；若确实无法完成，则如实说明无法完成。',
  });
}

/**
 * **暂停闸**对不可交互任务的拒绝回执——与 `noInteractionAskRefusal` **同族**（M11 语义只在本模块，
 *   不在 `agent-executor` 手抄一份判断）。由 `pauseForDecision` 在**置停之前**调用。
 *
 * 为何需要（zx_20261011_2 D9，实机 E2E 格②坐实）：`pauseForDecision` 是唯一"置停等待人工"的咽喉
 *   （`approvePathWrite` / `shell.ts` 特权闸 / `ask_user` 皆经它），而"请求方无从应答"这条不变量
 *   此前只守着 `ask_user`（本模块的 `noInteractionAskRefusal`）与执行前门禁（`exec-claim`）——
 *   **暂停闸这第三处无门**。于是中继任务命中"工作目录外写入审批"即被瞬时置 `paused`，而 relay 轮询
 *   一见 `paused` 即按 D1 回 `error` ⇒ A 端恒显失败、B 端其实完成（名实不符）。
 *
 * 语义：不可交互 ⇒ **不置停、不落账**，返回本回执作**工具结果**回给模型，令其**自行决断续跑**
 *   （如改用工作目录内路径、或放弃该操作换可行路），并在结论里写明取舍。可交互任务 ⇒ `null`（照常暂停）。
 */
export function noInteractionPauseRefusal(contextJson: string | null | undefined, decisionType: string): string | null {
  if (!isNoInteraction(contextJson)) return null;
  return JSON.stringify({
    status: 'cannot_pause',
    decision_type: decisionType,
    message: '本任务由外部终端一次性派发（不可交互），请求方无从应答，无法暂停等待任何人工决策。请勿等待：就当前事项取最合理的可行做法继续（例如改用工作目录内的路径、或放弃该操作换一条可行路），并在最终结论中写明你做了哪些取舍；若确实无法完成，则如实说明无法完成。',
  });
}
