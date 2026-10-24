/**
 * thinking 模型的请求兼容 —— **唯一** provider 工厂（zx_20260923 M2-c / G1）。
 *
 * ## 病根：同一件兼容被拆成两半，各落一处、各补一半
 *
 * | 能力 | 此前谁在做 | 缺的那一半 |
 * |---|---|---|
 * | 删 `tool_choice`（thinking 模型不认它） | `createSafeProvider`（旁路 ~17 处） | —— |
 * | 提取 `reasoning_content` 上屏 | 主聊天路内联 `createReasoningAwareFetch` | —— |
 * | **回传** `reasoning_content` | **没人** | 两条路都缺 |
 *
 * 主聊天路**连旁路那一半都没有**（它绕过 `createSafeProvider` 自己内联 `createOpenAI`），
 * 于是一次 SDK 崩溃：`The \`reasoning_content\` in the thinking mode must be passed back to the API.`
 *
 * ## 归一处
 *
 * 三件事（`tool_choice` 删除 + `reasoning_content` 回传 + 展示提取）**只在 `ai-reasoning.ts` 里实现一遍**，
 * 本工厂只负责把它们接到 provider 上。`src/main` 里 `@ai-sdk/openai` **只此一处 import**——
 * "哪条路复用了哪一半兼容"从此有唯一答案，且可被 rr 静态钉死（内联一处即判红）。
 *
 * **响应侧一律包装**（M2-b 定稿时订正过初版的一条说法）：回填要读"这一回合产出了什么"，与"要不要给人看"是两件事，
 * 故包装**不敢挂在** `onReasoningDelta` 上 —— 挂了就成了"上屏关掉 ⇒ 回传静默失效"，恰是本轮的病形。
 * `onReasoningDelta` **只管上屏**：旁路那 ~17 处不给它 ⇒ 不展示，但照样累计回合、照样回填。
 * 多包一层对 SDK 透明（它只读 `body`/`status`/`statusText`/`headers`/`text()`/`arrayBuffer()`，从不读 `url`/`redirected`）；
 * 非 SSE 的 JSON 响应也走同一条路原样透传（`rr_zx_20260921` M5-4 拿 `application/json` 桩真跑钉过）。
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createReasoningAwareFetch, type ReasoningProbe } from './ai-reasoning.js';

export function createSafeProvider(options: {
  baseURL: string;
  apiKey: string;
  /** 需要把思考过程实时上屏时给（同时启用回合累计 ⇒ `reasoning_content` 回填） */
  onReasoningDelta?: (text: string) => void;
  /** M2-a 探针（不传 = 关） */
  probe?: ReasoningProbe;
}) {
  return createOpenAI({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    fetch: createReasoningAwareFetch({
      onReasoningDelta: options.onReasoningDelta,
      probe: options.probe,
    }),
  });
}
