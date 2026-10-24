/**
 * 恢复账：谁把任务拉起来的、各记谁头上——**一处真源**（zx_20260916_1 M5 / #6）。
 *
 * ## 治的病：`resume_count` 名实不符
 *
 * 原注释称它是"用户介入次数"、"ai-task 独立自增"。查真库（2026-09-16，`data/worker-ant-server.db`）三条都不成立：
 * 自增点在 **`resume-ai-task` 处理器**里（`jobs/ai-task.ts`，无条件执行），而走到该处理器的**绝大多数是系统路**——
 * 全库 304 笔执行作业里 **302 笔不带 `initiator`**（缺省即 `'system'`），只有 **2 笔**是用户点的"恢复"。
 * 标本任务 `5126b303…`（02:44:23 UTC 建、02:44:40 UTC 起跑）**根本没有作业行**：它是 `scanReadyTasks`
 * 的**内存自动拉取**（`task-scheduler.ts`，只有 `pending.set`、不写 `wa_jobs`），却被标成了一次"恢复"、
 * 还收到了"你之前的任务已恢复…检查已有文件的进度"这句**当时为假**的话。
 *
 * ## 故两件事分开治
 *
 * 1. **账分两键**：`resume_count` = 用户介入（`initiator === 'user'`），`auto_resume_count` = 系统自动
 *    （目标偏离 / 模型降级 / 子任务完成 / 重启恢复 / 自动拉取）。消费点只看**总数**（`resumeLedgerTotal`），
 *    故分键**不改变**任何既有行为。
 * 2. **首跑不叫恢复**：自动拉取时按"有没有执行痕迹"选作业类型（`autoPullJobType`）——跑过才恢复，
 *    没跑过就是首跑（走 `ai-task`，其处理器不注入 `[系统恢复]` 合成消息）。
 *
 * ## 存量混计（**不回填**，如实标注）
 *
 * 2026-09-16 之前的行只有一个 `resume_count`，其值混着系统与用户的次数，**无法事后拆清**——谁点的没落库。
 * 故 `resumeLedgerTotal` **照单全收**存量值（当它是"已发生的恢复总次数"，这仍然为真），只对新发生的那笔分流。
 */

/** 一个任务"真跑过"的证据：对话里出现过助手回复或工具调用行。有此痕迹才谈得上"恢复"，否则是首跑。 */
export const EXECUTION_TRACE_ROLES = ['assistant', 'tool'] as const;

/** 恢复账的两个键。`resume_count` 早于本轮存在（含存量混计值），`auto_resume_count` 本轮新增。 */
export type ResumeLedgerKey = 'resume_count' | 'auto_resume_count';

/** 按入队者把这一次恢复记到对应键上，返回**分流后的键**与**账上总数**。
 *
 * `initiator` 缺省即 `'system'`（承 zx_20260915 P0-5(c)：六条非用户路一条都不传，**缺省值本身是契约**）。 */
export function bumpResumeLedger(
  ctx: Record<string, unknown>,
  initiator: string | undefined,
): { key: ResumeLedgerKey; total: number; count: number } {
  const key: ResumeLedgerKey = initiator === 'user' ? 'resume_count' : 'auto_resume_count';
  const count = Number(ctx[key] || 0) + 1;
  ctx[key] = count;
  return { key, total: resumeLedgerTotal(ctx), count };
}

/** 账上恢复总次数 = 用户介入 + 系统自动。**存量行只有 `resume_count`，混计值如实计入总数**（见模块头注释）。 */
export function resumeLedgerTotal(ctx: Record<string, unknown> | null | undefined): number {
  return Number(ctx?.resume_count || 0) + Number(ctx?.auto_resume_count || 0);
}

/** 内存自动拉取（无作业行）该走哪个作业类型：有执行痕迹 ⇒ 恢复；从没跑过 ⇒ 首跑。
 *
 * 首跑若错走 `resume-ai-task`，处理器会合成"你之前的任务已恢复…"——对没跑过的任务，那句话是假的。 */
export function autoPullJobType(prevRunCount: number): 'ai-task' | 'resume-ai-task' {
  return prevRunCount > 0 ? 'resume-ai-task' : 'ai-task';
}
