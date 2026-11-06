/**
 * 作业入队的**一处真源**——写库 **并**入调度器内存队列。
 *
 * 为什么需要它：调度器的内存队列 `TaskScheduler.pending` 只由两处填充——
 * `enqueue()`（写库 **+** 入内存，`task-scheduler.ts:144-151`）与启动恢复
 * `start()`（**只在进程启动时读一次库**，`:179-193`）。因此任何绕过 `enqueue`
 * 直接 `INSERT INTO wa_jobs` 的「裸插作业」，在**运行期一律不被消费**，只能等下次
 * 重启才被看见——表现为「IM 里回了『✅ 已启动任务』、作业却躺着不动」、
 * 「产出不充分后的自恢复一轮其实也跑不起来」。
 *
 * 该缺陷已被修过三次（zx_20260907 M5 / zx_20260908 实机复核 / zx_20260909 Z1），
 * 三次都只修了一处、余者仍在——故此处收成一处真源，调用点一律改调 `enqueueJob`；
 * 并由 `scripts/rr_zx_20260914.ts` 的防复发断言守住（白名单外的裸插即失败）。
 *
 * 注入方式同 `ipc/project.ipc.ts` 既有的两处 enqueuer（`setTaskRunEnqueuer` /
 * `setResumeEnqueuer`）：`index.ts` 建好 scheduler 后 `setJobEnqueuer(scheduler.enqueue)`；
 * 未注入时兜底裸插，保兼容（如单测/脚本环境下无调度器）。
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';

const logger = createLogger('job-enqueuer');

type JobEnqueuer = (type: string, payload: Record<string, unknown>) => Promise<string> | void;

let _enqueuer: JobEnqueuer | null = null;

/** 由 index.ts 在 scheduler 建好后注入；注入后所有 enqueueJob 都走内存队列（~1s 被消费）。 */
export function setJobEnqueuer(fn: JobEnqueuer | null): void { _enqueuer = fn; }

/**
 * 作业载荷的**唯一归一化**（zx_20261023_3 批四）：`ai-task` 必须带 `source`——
 * 实测 `28e6a12f` 只有 `{taskId, projectId}`，事后无从追溯"谁拉起来的"。
 * 漏网的一发仍要能查：补 `source:'unspecified'` 并告警。**兜底不是许可。**
 *
 * 两条入队路共用本函数：`scheduler.enqueue`（内存队列）与 `enqueueJob` 的裸插兜底。
 */
export function withJobSource(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (type !== 'ai-task' || payload.source) return payload;
  const tid = typeof payload.taskId === 'string' ? payload.taskId.slice(0, 8) : '?';
  logger.warn({ taskId: tid }, 'ai-task 入队缺 source——已记 unspecified，请补入队点');
  return { ...payload, source: 'unspecified' };
}

/**
 * 作业入队：优先走 `scheduler.enqueue`（写库 + 入内存队列，~1s 即被执行）；
 * 未注入时回退裸插 DB（等重启恢复，保兼容）。
 *
 * 注意：**只写库是不够的**——裸插的作业要等下次重启才会被 `start()` 读入内存队列。
 */
export function enqueueJob(db: Database.Database, type: string, payload: Record<string, unknown>): void {
  const finalPayload = withJobSource(type, payload);
  if (_enqueuer) {
    // 入队失败须留痕（本仓教训：被静默吞掉的写入只有正面断言能抓住），但不阻断调用方。
    try {
      void Promise.resolve(_enqueuer(type, finalPayload)).catch((err: unknown) => {
        logger.warn({ err, type }, '作业入队失败（scheduler.enqueue 拒绝）');
      });
    } catch (err) {
      logger.warn({ err, type }, '作业入队失败（scheduler.enqueue 抛出）');
    }
    return;
  }
  db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(crypto.randomUUID(), type, JSON.stringify(finalPayload));
}
