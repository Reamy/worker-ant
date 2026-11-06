/**
 * A1 事件溯源：状态投影器。
 * 监听EventBus事件，将事件流投影到状态表（wa_tasks/wa_projects等）。
 * 状态表是事件的物化视图，非真相源。
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type Database from 'better-sqlite3';
import type { EventBus, AppEvent } from './event-bus.js';
import { markTaskFailed } from './task-terminal.js';

/**
 * 投影器接口：每个投影器负责一种聚合类型的状态同步。
 */
interface Projector {
  /** 聚合类型标识 */
  aggregateType: string;
  /** 处理事件并更新状态表 */
  handle(event: AppEvent): void;
}

/**
 * 任务状态投影器。
 * 将 task.* 事件投影到 wa_tasks 表。
 */
class TaskProjector implements Projector {
  aggregateType = 'task';
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  handle(event: AppEvent): void {
    const { type, data } = event;
    const taskId = data.task_id as string | undefined;
    if (!taskId) return;

    switch (type) {
      case 'task.status_changed': {
        const newStatus = data.new_status as string | undefined;
        if (newStatus) {
          this.db.prepare(
            'UPDATE wa_tasks SET status = ?, updated_at = ? WHERE id = ?'
          ).run(newStatus, event.timestamp, taskId);
        }
        break;
      }
      case 'task.completed': {
        this.db.prepare(
          "UPDATE wa_tasks SET status = 'completed', updated_at = ? WHERE id = ?"
        ).run(event.timestamp, taskId);
        break;
      }
      case 'task.failed': {
        // zx_20260923 M6-b: 本路是 `failed` 的**第二个在线写点**（事件溯源侧，非重建路——本仓无回放重建）。
        // 谁最后落笔决定账的形状 ⇒ 翻页也须在此成立；`at` 保住事件时刻（本路刻意不取库钟）。
        // zx_20261012_2 批五 M5: 因由**从事件带上**（`taskFailedPayload` 恒带 `error`；两条裸 emit 亦带）。
        //   本路是"带因的后一跳"——`agent-executor` 那两条路（本轮边界冻结、不能改）先裸翻状态再发事件，
        //   其失败通知**只能**由这里带因发出（`markTaskFailed` 对无因呼叫不发，见其 `notifyFailure` 头注）。
        markTaskFailed(this.db, taskId, { at: event.timestamp, reason: String((data.error as string) || '') });
        break;
      }
      case 'task.awaiting_input': {
        this.db.prepare(
          "UPDATE wa_tasks SET status = 'paused', updated_at = ? WHERE id = ?"
        ).run(event.timestamp, taskId);
        break;
      }
    }
  }
}

/**
 * 项目状态投影器。
 * 将 project.* 事件投影到 wa_projects 表。
 */
class ProjectProjector implements Projector {
  aggregateType = 'project';
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  handle(event: AppEvent): void {
    const { type, data } = event;
    const projectId = data.project_id as string | undefined;
    if (!projectId) return;

    switch (type) {
      case 'project.status_changed': {
        const newStatus = data.new_status as string | undefined;
        if (newStatus) {
          this.db.prepare(
            'UPDATE wa_projects SET status = ?, updated_at = ? WHERE id = ?'
          ).run(newStatus, event.timestamp, projectId);
        }
        break;
      }
    }
  }
}

/**
 * 注册所有投影器到EventBus。
 * 在应用启动时调用一次。
 */
export function registerProjectors(db: Database.Database, bus: EventBus): void {
  const taskProjector = new TaskProjector(db);
  const projectProjector = new ProjectProjector(db);

  // 注册任务相关事件
  bus.on('task.status_changed', (e) => taskProjector.handle(e));
  bus.on('task.completed', (e) => taskProjector.handle(e));
  bus.on('task.failed', (e) => taskProjector.handle(e));
  bus.on('task.awaiting_input', (e) => taskProjector.handle(e));

  // 注册项目相关事件
  bus.on('project.status_changed', (e) => projectProjector.handle(e));
}
