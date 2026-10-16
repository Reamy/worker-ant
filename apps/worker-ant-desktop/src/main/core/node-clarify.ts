/**
 * zx_20261011_1 M4（维特根斯坦·意义即用法 / 毛选·没有调查就没有发言权 / 老子·知止）:
 * 中继执行体（B 端）**遇需澄清时向上游（派活方 A）提问**——一问一答，**有界等待**。
 *
 * 病根（M11 的另一面）：派来的活 `no_interaction=true` ⇒ `ask_user` 一律短路成"请自行决断"。
 *   这对"外部 AI 终端一次性派发、确实无人可答"是对的；但**对等派发**（工蚁↔工蚁，C2/M7）里
 *   派活方**是一台在线的工蚁**，它**答得上**。把"无人可答"与"有答者却不问"当成同一件事，
 *   就是让 B 端在能问清楚时被迫瞎猜（承"沉默不是一种"的反面）。
 *
 * 治法（**叠在 M11 之上，不替换**——M11 仍是答不到时的兜底）：
 *   ① 中继任务落库时把 `node_request_id` 写进 `context_json`（`node-request-runner.ts` 一处真源）；
 *   ② `ask_user` 若在 `context_json` 里读到该键、且**已注入 asker** ⇒ **先向上游问**（有界等待）：
 *      答到 ⇒ 把答案当工具结果回给模型；答不到（超时/无 asker/失败）⇒ **照旧退回 M11 的自决回执**。
 *
 * ⚠ 本模块**不触网**：`ClarifyIo` 是注入点（真机＝`node-request-io.ts` 的签名请求；回归喂假），
 *   时钟/睡眠亦可注入 ⇒ 受控回归不出网、不真等，直跑真逻辑（承 `node-request-worker.ts` 的纪律）。
 * ⚠ **永不抛**：`askRequester` 任何一步失败都折成 `null`——"没答到"是一个**正常结局**（退回自决），
 *   不是异常。调用方据 `null` 分流。
 */

import { type NodeQuestion } from '@worker-ant/shared-types';
// zx_20261011_2 M3: 等作答上限可配——设置读口**一处真源**（`node-identity.ts`），不在此手抄键名。
import { NODE_SETTING_KEYS, readNodeSetting, type NodeSettingDb } from './node-identity.js';

/**
 * 中继任务的 `context_json` 里存派单 id 的键——**一处真源**（写口＝`node-request-runner.ts`；
 *   读口＝`tools/control.ts` 的 `ask_user`）。键名散两处即"同一件事两个名字"，必有一处漂。
 */
export const NODE_REQUEST_ID_KEY = 'node_request_id';

/** 从任务 `context_json` 里取派单 id（非中继任务 ⇒ `null`，即"这不是派来的活、谈不上向上游问"）。 */
export function requestIdOf(contextJson: string | null | undefined): string | null {
  try {
    const c = JSON.parse(contextJson || '{}') as Record<string, unknown>;
    const id = c?.[NODE_REQUEST_ID_KEY];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch { return null; }
}

/**
 * 中继任务的 `context_json` 里存**派活方作答**的键——**一处真源**
 *   （写口＝`node-request-runner.ts` 建任务时从 `req.answer` 注入；读口＝`tools/control.ts` 的 `ask_user`）。
 *
 * 为什么要"注入"而不是"等"（zx_20261011_2 M2）——实机实测（ANS `6f98d04a`）坐实：
 *   B 端提问、A 端作答，答案却**没进过任何执行体**。因为"作答"落库的动作是**把请求置回 `assigned`**
 *   （`ans-server/routes/nodes.ts` 的 `/requests/:id/answer`），而 worker 只拉 `assigned` ⇒
 *   **重起一件全新任务**；新任务从头跑，既不带答案、又对同一模糊指令**再问一次**，而"再问"按设计
 *   会把上一轮的答案抹掉（`answer_json = NULL`）⇒ 作答失效。故答案须随重跑**注入**任务上下文。
 */
export const NODE_ANSWER_KEY = 'node_answer';

/** 从任务 `context_json` 里取**已注入的作答**（无 ⇒ `null`，即"派活方还没答过"——退回现问现等）。 */
export function answerOf(contextJson: string | null | undefined): string | null {
  try {
    const c = JSON.parse(contextJson || '{}') as Record<string, unknown>;
    const a = c?.[NODE_ANSWER_KEY];
    return typeof a === 'string' && a.length > 0 ? a : null;
  } catch { return null; }
}

/**
 * 等作答的缺省上限（秒）——**一处真源**。zx_20261011_2 M3: 60s 对**人**（读题→点选→提交）太短，
 *   实机 E2E 里人还没答完，执行体已超时自决、任务已停在 `abnormal_end`。取 180s：够人一次往返，
 *   又有界（且明显小于 relay runner 的 10 分钟上限，不会互相抢先超时）。
 *   ⚠ 这个窗口只是"省一次重跑"的便利；**真正的保证是 `NODE_ANSWER_KEY` 的注入**（答晚了也能续上）。
 */
export const CLARIFY_WAIT_SEC_DEFAULT = 180;

/**
 * 解析等作答上限（毫秒）——设置项 `node.clarify_wait_sec` 优先，非法/缺失回落 `CLARIFY_WAIT_SEC_DEFAULT`。
 * **一处真源**：`main/index.ts` 注册 asker 时读它，不在此手写 180 的副本（改值只改常量）。
 */
export function resolveClarifyWaitMs(db: NodeSettingDb): number {
  const raw = readNodeSetting(db, NODE_SETTING_KEYS.clarifyWaitSec);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) * 1000 : CLARIFY_WAIT_SEC_DEFAULT * 1000;
}

/**
 * 澄清问答的 IO（注入点）：真机＝`makeAnsRequestIo`（`node-request-io.ts`，唯一触网处）；回归喂假。
 * 与 `RequestIo`（拉待办/回传）**分开定义**：那是"干活的进出"，这是"问话的进出"——两件事。
 */
export interface ClarifyIo {
  /** `POST /api/v1/nodes/requests/:id/question` —— 提出一问（**抛**于失败）。 */
  ask(id: string, question: NodeQuestion): Promise<void>;
  /** `GET /api/v1/nodes/requests/:id` → 当前作答串（**未答**为 `null`）；**抛**于失败。 */
  readAnswer(id: string): Promise<string | null>;
}

/** 有界等待的参数与可注入件（时钟/睡眠可注入 ⇒ 回归不真等）。 */
export interface AskRequesterDeps {
  io: ClarifyIo;
  /** 等作答的上限（毫秒）；缺省由 `CLARIFY_WAIT_SEC_DEFAULT` 派生（zx_20261011_2 M3: 60s→180s）。超限 ⇒ 如实 `null`（退回自决，不假装答过）。 */
  timeoutMs?: number;
  /** 轮询间隔（毫秒）；缺省 3_000。 */
  pollMs?: number;
  /** 注入时钟（缺省 `Date.now`）。 */
  now?: () => number;
  /** 注入睡眠（缺省真实 `setTimeout`）。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 向上游提一问并**有界等**作答。**永不抛**。
 *  - 答到 ⇒ 答案串；
 *  - 提问失败 / 读答持续失败直到超时 / 无作答 ⇒ `null`（调用方退回 M11 自决——"问不到"是正常结局）。
 *
 * ⚠ 读答失败**不立即放弃**：网络抖动属常见，读失败仍继续轮询到 deadline（仍是有界）。这不改变
 *   最终"答不到 ⇒ null"的语义，只是给瞬时故障留一次机会。
 */
export async function askRequester(
  requestId: string,
  question: NodeQuestion,
  deps: AskRequesterDeps,
): Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? CLARIFY_WAIT_SEC_DEFAULT * 1000;
  const pollMs = deps.pollMs ?? 3_000;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  try {
    await deps.io.ask(requestId, question);
  } catch {
    return null; // 提问就没送出去 ⇒ 无从等答（如实退回自决）。
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const answer = await deps.io.readAnswer(requestId);
      if (answer !== null) return answer;
    } catch {
      /* 读答瞬时失败 → 继续轮询到 deadline（有界） */
    }
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

// ==================== asker 注册（启动期注入运行期可调模块的惯用法） ====================

/**
 * 提问器：给定（派单 id, 问题）⇒ 答串或 `null`。真机＝`askRequester` 绑上真 io；
 *   回归＝记录桩。与 `setNodeRuntimeStarter` / `setJobEnqueuer` 同一手法。
 */
export type RequestAsker = (requestId: string, question: NodeQuestion) => Promise<string | null>;

let _asker: RequestAsker | null = null;

/** 装配处（`main/index.ts`）注册；传 `null` 解除（回归/停用）。 */
export function setRequestAsker(fn: RequestAsker | null): void {
  _asker = fn;
}

/** 取当前 asker（未注册 ⇒ `null`——"没接线"≠"问了没人答"，调用方据此决定是否尝试提问）。 */
export function getRequestAsker(): RequestAsker | null {
  return _asker;
}
