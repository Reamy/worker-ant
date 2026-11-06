/**
 * 「令」的判据——**一次跑与一步一步，各自只有一个判据**（zx_20261023_3 批一）。
 *
 * 实测事故：父任务 `0ba7a0d4` 16:14:08（本地 UTC+08:00，库内 UTC 08:14:08）按暂停，
 * 界面显示"已暂停"，执行体仍跑了 23 步（08:14:16–08:16:06）并实质改写了任务树与方案文件。
 * 三处缺口：
 *
 * ① 起跑前：`AbortController` 在 `executeTask` 的 prelude（原型识别/选型/记忆检索，约千行）**之后**
 *    才登记 ⇒ 用户在这段时间按暂停，`abortTaskRun` 找不到句柄，abort 静默失败。
 * ② 每一步：`exec-step.ts` 见到 `paused` 只把 `askUserCalled` 置真，要等**整个多步循环**结束才消费。
 * ③ 状态判据散落在两处（起跑 / 逐步），措辞与覆盖面各写一份，改一处漏一处。
 *
 * 本模块把两处判据收到一处：`runStartRefusal`（能不能起跑）与 `stepStopVerdict`（这一步之后停不停）。
 * 纯函数、零副作用；终态表仍取 `task-jobs.ts` 的唯一真源（该模块零 import，不会成环）。
 */
import { isTerminalStatus } from './task-jobs.js';

/** 允许执行体继续跑的状态——与 `interruptTask` 认定的"在途"同一把尺。 */
export const RUNNABLE_STATUSES = ['executing', 'preparing', 'running'] as const;

export function isRunnableStatus(status: string | null | undefined): boolean {
  return !!status && (RUNNABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * 起跑前判据：`null` ⇒ 放行；否则返回**凭什么拒**（原样进日志与返回值，不改写成一句模糊话）。
 * `aborted` 优先于状态——句柄一旦被中止，即便状态还没落成 paused，也不得再起跑。
 */
export function runStartRefusal(status: string | null | undefined, aborted: boolean): string | null {
  if (aborted) return 'aborted';
  if (!status) return 'status_missing';
  if (isRunnableStatus(status)) return null;
  if (isTerminalStatus(status)) return `status_terminal:${status}`;
  return `status_${status}`;
}

export interface StepStopVerdict {
  /** `ask_user`：软收尾——等用户回复，不是"别跑了"。 */
  askUser: boolean;
  /** 非空即以该因由 `controller.abort(...)`；执行体 catch 按关键字分派。 */
  abortReason: string | null;
}

/**
 * 每步判据（一步之末调用一次）：
 * - 本步调用了 `ask_user` ⇒ 软收尾（优先于状态——ask_user 自身也会置 paused）；
 * - 库内 `paused` ⇒ 中止（`status_paused`），不再"记个旗继续跑"；
 * - 终态 ⇒ 中止（`status_terminal:<s>`）；
 * - 其余（含查不到行）⇒ 不动作；查不到行的兜底在工具闸（批二）——此处 abort 会落进
 *   "非暂停非中断 ⇒ 按 SDK 失败记账"的错误分支，把一个不该记在任务头上的事记成失败。
 */
export function stepStopVerdict(toolNames: readonly string[], status: string | null | undefined): StepStopVerdict {
  if (toolNames.includes('ask_user')) return { askUser: true, abortReason: null };
  if (status === 'paused') return { askUser: false, abortReason: 'status_paused' };
  if (isTerminalStatus(status)) return { askUser: false, abortReason: `status_terminal:${status}` };
  return { askUser: false, abortReason: null };
}
