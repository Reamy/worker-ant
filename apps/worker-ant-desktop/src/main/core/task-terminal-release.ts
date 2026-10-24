/**
 * zx_20260921 M7（D4 断点①）: 任务被置**终态**（completed / failed / archived）之后的收尾一跳 —— 放行父任务。
 *
 * 病根：引擎**四处**（`jobs/ai-task.ts` 的子任务跑完/跑败点）在子任务到终态后都会问一句"父能不能放行了"，
 * 而 GUI 这条"人工把子任务标完成 / 标失败 / 归档"的路**从来没问过**。标本 `9788ce4f`：全子都人工标完了、
 * 父仍停在 `paused`，因由还写着 `children_incomplete` /"子一到终态即自动恢复，无需人工"——一句写在
 * 界面上的假话（承 `zx_20260917` §12.4 的"全链走完但账名实不符"）。
 *
 * **不新写第二套判定**（罗尔斯·同一把尺）：直接调引擎那四处用的**同一个** `checkParentTaskAfterChildDone`
 * ——它自带"父不在 `paused`/`pending` 即早退"的前提，故本函数对**无父**、**父已终态**、**还有兄弟没跑完**
 * 三种情形天然无写。
 *
 * **入队也不新写第二份**：走 `enqueueJob`（`core/job-enqueuer.ts` 的**一处真源**，由 index.ts 注入
 * `scheduler.enqueue`；未注入时它自己兜底裸插）。此处**刻意不复用** `ipc/project.ipc.ts` 里那个
 * `enqueueResumeJob`——它硬打 `initiator:'user'`，而本笔是"子任务到终态 ⇒ 放行父"，不是用户点出来的；
 * `initiator` 缺省即 `'system'`（`core/resume-ledger.ts` 明写这是契约），恰好记进 `auto_resume_count`，
 * 不给用户的"介入次数"灌水。
 *
 * **为什么单独一个模块**（而不是内联在 `ipc/project.ipc.ts` 里）：`project.ipc.ts` 顶层
 * `import { ipcMain } from 'electron'`，在 node（受控回归）环境下**根本 import 不进来** ⇒ 内联在那里的
 * 薄函数 rr 够不着，只能靠"复刻一份等价物"来测，而那正是本轮 §7 头号风险「判据的自我印证」。
 * 抽到本模块后：handler 调它、rr 也调它——**跑的是同一份实现**。
 */
import type Database from 'better-sqlite3';
import { checkParentTaskAfterChildDone } from './jobs/ai-task.js';
import { enqueueJob } from './job-enqueuer.js';
import { createLogger } from './logger.js';

const logger = createLogger('task-terminal-release');

export function afterTaskTerminalStatus(db: Database.Database, taskId: string): void {
  afterTaskSettled(db, taskId);
}

/**
 * zx_20261022_3 批十二（信·名实）：任务**已定局**（终态**或暂停**）之后放行父任务。
 *
 * 暂停与终态在本函数眼里同义——"它不会再自己往前走了"。此前只有终态这一跳，于是子任务验收未过
 * 被置暂停后，父任务**永远停在等子态**（真标本 `094a8b47`/`e54532f9`：M2 两个子任务从未被拉起）。
 * 判"哪些暂停算定局"在 `pause-reason.ts` 的 `pauseSettlesParent`（用户暂停、等答复不算）。
 */
export function afterTaskSettled(db: Database.Database, taskId: string): void {
  try {
    checkParentTaskAfterChildDone(db, taskId, {
      // `checkParentTaskAfterChildDone` 的 `enqueue` 是 Promise 形；`enqueueJob` 是同步动作，
      // 故包一层 resolved promise —— 形状对齐，语义不变。
      enqueue: (type, payload) => { enqueueJob(db, type, payload); return Promise.resolve(''); },
    });
  } catch (err) {
    // 放行父是**收尾的收尾**：它失败不该把"用户刚点的那个状态转移"一起推翻（用户看到的是自己的操作失败）。
    logger.warn({ err: (err as Error).message, taskId }, '定局后放行父任务失败(不阻断状态转移)');
  }
}

/**
 * zx_20261022_3 批十二（信·名实）：**父任务自己因等子而暂停时，立即复核一次自身**。
 *
 * 治的是唤醒竞态：子任务暂停的那一刻，父任务还在执行 ⇒ 子收尾那次 `checkParentTaskAfterChildDone`
 * 因"父不在等子态"早退；父跑完自己的这一步、发现子未完成，于是自己也暂停 `children_incomplete`——
 * 此后**再没有任何一跳会唤醒它**（子已经停完了）。
 *
 * 判据：该任务的未完成子**全部处于 paused**（还有 executing/pending 的，等它们各自到站再唤醒）；
 * 逐个交给同一份 `checkParentTaskAfterChildDone`（不另写第二套判定），一旦父被放行即停。
 * 有界：每笔暂停子只唤醒父一次（`parent_wake_at` 标记写在 `checkParentTaskAfterChildDone` 内），
 * 父若醒来又不处置这些子，不会陷入「暂停→唤醒→再暂停」的热环。
 */
export function reevaluateSelfWhenWaitingOnChildren(db: Database.Database, taskId: string): void {
  try {
    const unfinished = db.prepare(
      "SELECT id, status FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed','archived')",
    ).all(taskId) as Array<{ id: string; status: string }>;
    if (unfinished.length === 0) return;
    if (unfinished.some((k) => k.status !== 'paused')) return;
    for (const k of unfinished) {
      checkParentTaskAfterChildDone(db, k.id, {
        enqueue: (type, payload) => { enqueueJob(db, type, payload); return Promise.resolve(''); },
      });
      const st = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined)?.status;
      if (st !== 'paused') return; // 已被放行（pending）⇒ 本次唤醒到此为止
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, taskId }, '等子暂停后复核自身失败(不阻断)');
  }
}
