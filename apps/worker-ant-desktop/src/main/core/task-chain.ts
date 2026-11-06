/**
 * zx_20260917 M5-1：「链上至多一个在跑」——父子双跑的唯一真源。
 *
 * ## 两条入径（真库回放，标本 `2255cd37 → 9788ce4f → 9eb927bf → 8d2a8db6`）
 *
 * **(a) 创建路**：`05:37:17` 父 `create_task` 建 M0 ⇒ 子**同一秒** `executing`，而父自己的 loop 还在跑
 *   （`created_and_queued`）。旧代码**完全不看父状态**。⇒ 由 `childDispatchHint` 在 `create_task` 处拦。
 *
 * **(b) 自动拉起路**：`exit_plan_mode` 把父置 `pending`（**而父的 loop 还在飞**）⇒ 父重新"可被拉起"，
 *   6 秒后（合 10 秒扫描节拍）父再度 `executing`，而 M0 一直在跑 ⇒ **同一任务两条 loop 并发**，
 *   二者随后改同一工作树（父 `05:40:13` 写文件、M0 `05:40:25–05:41:05` 改同一文件）。
 *   旧闸 `directParentBusy` 只问**上一级**（父自己无父 ⇒ 对父恒不拦），`chainStalled` 只上溯祖先，
 *   **无人问后代**。⇒ 由 `chainBlockReason` 在 `scanReadyTasks` 处拦。
 *
 * ## 与既有两闸的关系（同一处真源，不抄第二份）
 *
 * - `directParentBusy`：原为 `task-scheduler` 的 **private 方法**，`agent-executor` 用不了。提来本模块，
 *   两侧共用；原方法删除。
 * - `chainStalled`（祖先链有 failed/archived/非等子暂停 ⇒ 不拉起）留在调度器：它问的是"祖先**死了**"，
 *   与本模块问的"链上**有人在跑**"是两件事，不合并。
 * - 忙态集合**并入 `planning`**（父在规划中时子任务也不该被拉起）——这是本轮的收窄。
 */

import { collectAncestorIds, collectSubtreeIds } from './task-accounting.js';
import { hasPendingExecutionJob, type TaskJobDb } from './task-jobs.js';

/**
 * "在跑"的状态集合——**唯一真源**（`task-scheduler` 的拉起闸、`create_task` 的派发闸共用）。
 *
 * `planning` 纳入的理由：plan 模式下任务仍是**活着的 loop**，此时代码在跑、上下文没释放，
 * 被它"派出去"的子任务与它同刻动手 = 同一棵树两处改（标本 (a) 路即发生在 `planning` 态）。
 */
export const CHAIN_BUSY_STATUSES = ['executing', 'running', 'preparing', 'planning'] as const;

export function isChainBusyStatus(status: string | null | undefined): boolean {
  return !!status && (CHAIN_BUSY_STATUSES as readonly string[]).includes(status);
}

/** 任务状态（读不到 ⇒ null） */
export function taskStatusOf(db: TaskJobDb, taskId: string): string | null {
  try {
    const r = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined;
    return r?.status ?? null;
  } catch { return null; }
}

/** 任务的直接父 id（无父/读不到 ⇒ null） */
export function taskParentOf(db: TaskJobDb, taskId: string): string | null {
  try {
    const r = db.prepare('SELECT parent_task_id FROM wa_tasks WHERE id = ?').get(taskId) as { parent_task_id?: string | null } | undefined;
    return r?.parent_task_id ?? null;
  } catch { return null; }
}

/**
 * zx_20260909 #7b 修：直接父任务正在执行/运行/准备时，不自动拉起其 pending 子任务。
 * 反模式：父 agent 认领了某里程碑在 inline 做（status=executing），scanReadyTasks 又把同里程碑的
 * pending 子任务自动入队 → 父子双跑、同批文件被两个 agent 并行改（实测 A_20260907 顶层 inline M2 与
 * M2 子 executeTask 同时改 test_m2/daily_action_guide → 目标偏离/编辑冲突）。
 * 语义：父 active 时其子任务归父调度（父 inline 或 spawn_subagent 显式派发），不归 scanReadyTasks；
 *   父空闲(pending，未在跑) 时子任务仍可并行自动拉起；独立顶层任务间并行不受影响；
 *   显式 resume/respond/inject（enqueue）不经本路径，用户意图优先。
 */
export function directParentBusy(db: TaskJobDb, taskId: string): boolean {
  const pid = taskParentOf(db, taskId);
  if (!pid) return false;
  return isChainBusyStatus(taskStatusOf(db, pid));
}

/**
 * 探测"名下 pending 后代是否已排入执行作业"时的上限——超过则不再逐个探（如实登记该边界，不假装全覆盖）。
 * 现实规模：广度上限 `MAX_CHILD_BREADTH=5`、深度上限 `MAX_TASK_DEPTH=5`，子树远小于此。
 */
export const CHAIN_DESC_JOB_PROBE_LIMIT = 200;

/**
 * 该任务此刻**是否不该被自动拉起**：返回原因（无则 `null` = 放行）。
 *
 * 返回原因而非裸布尔，是为了让这台闸**可判**（受控回归可直接断言文案）且**可追**
 * （调度器日志里能看出是哪一条挡的，而不是"没动静"）。
 *
 * 三条（任一命中即拦）：
 * 1. **本批次已选中链上亲属**：现有扫描一次可同时选中 pending 父与其 pending 子（`running` 计数只数
 *    `executing`，且计数上限只在进入循环前取过一次）⇒ 同一批次内按链去重。
 * 2. **直接父任务在跑**（`directParentBusy`，沿用既有语义）。
 * 3. **名下有后代在跑 / 已排入执行作业**（本批新增的对称半边，治 (b) 路）：
 *    后代 `executing` 时父被再拉起 = 链上两条 loop；后代 `pending` 却已挂作业时同理（`exit_plan_mode`
 *    正是先置父 `pending`、再给无前置子任务入队——这 6 秒窗口就是标本 (b) 路）。
 */
export function chainBlockReason(db: TaskJobDb, taskId: string, selectedSamePass?: Iterable<string>): string | null {
  const selected = selectedSamePass ? [...selectedSamePass] : [];
  if (selected.length > 0) {
    const anc = collectAncestorIds(db, taskId);
    const desc = collectSubtreeIds(db, taskId);
    const mate = selected.find(s => s !== taskId && (anc.includes(s) || desc.includes(s)));
    if (mate) return `同一批次已选中链上亲属（${mate.slice(0, 8)}）`;
    if (selected.includes(taskId)) return '本任务已在本批次入队';
  }

  const pid = taskParentOf(db, taskId);
  if (pid) {
    const ps = taskStatusOf(db, pid);
    if (isChainBusyStatus(ps)) return `直接父任务正在执行（${ps}）`;
  }

  const descIds = collectSubtreeIds(db, taskId);
  if (descIds.length > 0) {
    const ph = descIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, status FROM wa_tasks WHERE id IN (${ph})`).all(...descIds) as Array<{ id: string; status: string }>;
    const busy = rows.find(r => isChainBusyStatus(r.status));
    if (busy) return `名下后代任务正在执行（${busy.id.slice(0, 8)} / ${busy.status}）`;
    // 只探 `pending` 后代：在跑者上面已拦；终态者不可能再起跑；paused 者的残留作业在暂停时已被作废。
    const pend = rows.filter(r => r.status === 'pending').slice(0, CHAIN_DESC_JOB_PROBE_LIMIT).map(r => r.id);
    const queued = pend.find(id => hasPendingExecutionJob(db, id));
    if (queued) return `名下后代任务已排入执行作业（${queued.slice(0, 8)}）`;
  }

  return null;
}

/**
 * `create_task` 建子前的派发闸：返回给 agent 看的**如实提示**（父空闲 ⇒ `null` = 放行、即刻入队）。
 *
 * 语义（zx_20260917 M5-1，用户裁定 A）：`create_task` 是"**拆解里程碑**——我本不打算自己做"，
 * 故父在跑时**不即刻入队**，交调度器（`getReadyTasks` 一条解锁路），待父本轮结束、链上无在途任务后自动拉起。
 *
 * ⚠ 本闸**只挂 `create_task`**，不挂 `spawn_subagent`：后者是"我派你去做、我等你"，其全部用途就是
 * **运行中并行派发**（`hint`：「子Agent将独立执行，完成后父任务自动恢复」）——若同样按"父忙即改派"，
 * 它**永远**改派（工具只在父的 loop 内被调用 ⇒ 调用那刻父必然在跑），等于取消该工具。
 * 它可能引发的链上双跑由 `chainBlockReason` 的对称半边（后代在跑则不拉起父）收口。
 */
export function childDispatchHint(db: TaskJobDb, parentTaskId: string): string | null {
  const st = taskStatusOf(db, parentTaskId);
  if (!isChainBusyStatus(st)) return null;
  const what = st === 'planning' ? '父任务正在规划中' : '父任务正在执行';
  return `${what}（${st}）——子任务已创建但**未**即刻入队：待父任务本轮结束、链上无在途任务后由调度器自动拉起（也可在计划模式下用 exit_plan_mode 显式派发）。`;
}
