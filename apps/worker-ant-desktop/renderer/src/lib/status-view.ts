/**
 * 状态词表的**唯一真源**（zx_20260930 M4-4）。
 *
 * 为什么要这一份：两套状态词表此前都在渲染层**手抄多份**且互相漂移——
 *
 * - **任务状态**：`TaskDetailPage.STATUS_LABEL`／`TasksPage.STATUS_LABEL`／`CommandPalette.STATUS_TXT`
 *   三份，其中只有详情页有 `investigating`。同一张「调查中」的任务，在任务列表与命令面板里显示成
 *   **原始 key `investigating`**（词表漏一个取值，漏的那一处就漏网）。
 * - **项目状态**：`ProjectDetailPage` 内联一份 `{active:'运行中',…}`，而 `ProjectsPage` 项目卡直接把
 *   `p.status` 原样打给用户（显示成 `active`／`paused`），`CommandPalette` 更把它当成**任务**表去查
 *   （`active` 查不到 ⇒ 原样回显）。同一个项目，详情页说「运行中」、列表卡说「active」。
 *
 * 与 `lib/deliverable-view.ts`（产出物词表）同形：渲染层是词表的第二个落点，落成一处。
 *
 * ⚠ 任务/项目/产出物是**三套不同的取值域**，刻意不合并成一张表：任务有 `investigating`，
 * 项目有 `archived`，产出物有 `registered`/`stale`/`retired`。合并会把三套取值域糊成一套，
 * 再无法表达"这个词在这套取值域里不存在"（那正是本轮要修的病）。
 */

/** 任务状态词表。取值域：`wa_tasks.status`。 */
export const TASK_STATUS_LABEL: Record<string, string> = {
  pending: '待执行', planning: '规划中', preparing: '准备中', executing: '执行中',
  running: '运行中', completed: '已完成', failed: '失败', paused: '已暂停',
  // 此态原为详情页独有——收敛到一处后，任务列表/命令面板也认得它
  investigating: '调查中',
  // zx_20260930 M11-5: `stabilizing` 是 `project-engine` 的「烹小鲜」冷却暂态（窗口内状态变更超阈值即进入，
  //   自动操作停止、等人工确认）。原先**两处词表都没它有** ⇒ 任务列表/详情页直接回显 key `stabilizing`。
  //   它的出口不在引擎侧（自愈超时扫描**刻意不含**它，见 `self-healing-monitor.EXEC_STALE_STATUSES`），
  //   出口在 GUI：详情页横幅「确认并放回队列」→ `pending`。
  stabilizing: '稳定观察中',
  // zx_20261012_2 批二: 「归档（放弃）」自成一态。词语**刻意沿用** dep-graph 既有措辞「已归档」
  //   （`children-gate.ts` 注释即写「人工 archived」）——避免同一概念造第二个中文词。
  //   ⚠ 与**项目**级 `archived`（`PROJECT_STATUS_LABEL`）同词不同域：那是项目被归档，这是任务被弃；
  //     两套取值域（见本文件头注释），值相同但语义各主一事。
  archived: '已归档',
};

/** 项目状态词表。取值域：`wa_projects.status`（值域源头见 `project-engine.transitionStatus` 的 `validateTransition`）。 */
export const PROJECT_STATUS_LABEL: Record<string, string> = {
  active: '运行中', paused: '已暂停', completed: '已完成', archived: '已归档',
};

/**
 * 作业队列词表。取值域：`wa_jobs.status`（写入点见 `task-scheduler.ts`：`pending`→`running`→`done`/`failed`）。
 * ⚠ 与任务状态**不是同一取值域**：作业收 `done`（非 `completed`）、`running` 在此是"执行中"。
 * zx_20261003 M6：项目运行面卡（`KnowledgeFaceCard`）原自带一张，Dashboard 的调度面另带一张且**已漂移**
 * （`pending` 一处写"待处理"、一处写"待执行"）——收敛到此，两处消费者同引。
 */
export const JOB_STATUS_LABEL: Record<string, string> = {
  pending: '待执行', running: '执行中', done: '已完成', failed: '失败',
};

/**
 * 未知取值**如实回显原值**，不伪造成某个已知态——「不认识这个词」与「它是某某态」不是一回事。
 * 调用方一律用它，别再各自写 `TBL[k] || k`（那样"忠实回显"这件事就有了第二份实现）。
 */
export function statusText(table: Record<string, string>, status: unknown): string {
  const s = String(status ?? '');
  return table[s] || s;
}
