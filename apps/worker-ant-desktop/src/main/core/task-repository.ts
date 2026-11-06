/**
 * B3: TaskRepository SQLite适配器。
 * 封装TaskManager/ProjectEngine的数据库操作，提供显式接口。
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { TaskInfo, ConversationEntry, TaskRepository } from './agent-contracts.js';
import { analyzeBlockers as analyzeBlockersFn } from './project-analytics.js';

/** SQLite实现的TaskRepository */
export class SqliteTaskRepository implements TaskRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  getTask(taskId: string): TaskInfo | null {
    const row = this.db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(taskId) as TaskInfo | undefined;
    return row ?? null;
  }

  getProjectId(taskId: string): string | null {
    const row = this.db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
    return row?.project_id ?? null;
  }

  updateStatus(taskId: string, status: string): void {
    this.db.prepare("UPDATE wa_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, taskId);
  }

  updateContext(taskId: string, context: Record<string, unknown>): void {
    this.db.prepare("UPDATE wa_tasks SET context_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(context), taskId);
  }

  addConversation(taskId: string, role: string, content: string, toolCalls?: unknown, tokenCount = 0): { id: string; task_id: string; role: string; content: string } {
    const id = randomUUID();
    // 自动估算token数（约4字符/token），确保失败任务也能显示消耗
    const estimatedTokens = tokenCount > 0 ? tokenCount : Math.max(1, Math.round((content?.length || 0) / 4));
    this.db.prepare(
      'INSERT INTO wa_task_conversations (id, task_id, role, content, tool_calls, token_count) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, taskId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, estimatedTokens);
    return { id, task_id: taskId, role, content };
  }

  getConversations(taskId: string, limit = 100): ConversationEntry[] {
    return this.db.prepare(
      'SELECT * FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid ASC LIMIT ?'
    ).all(taskId, limit) as ConversationEntry[];
  }

  countTokens(taskId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(token_count), 0) as total FROM wa_task_conversations WHERE task_id = ?'
    ).get(taskId) as { total: number };
    return row.total;
  }

  getSubTasks(projectId: string, parentTaskId?: string): TaskInfo[] {
    if (parentTaskId) {
      return this.db.prepare(
        "SELECT * FROM wa_tasks WHERE project_id = ? AND parent_task_id = ? AND status != 'archived' ORDER BY created_at ASC"
      ).all(projectId, parentTaskId) as TaskInfo[];
    }
    return this.db.prepare(
      "SELECT * FROM wa_tasks WHERE project_id = ? AND (parent_task_id IS NULL OR parent_task_id = '') AND status != 'archived' ORDER BY created_at ASC"
    ).all(projectId) as TaskInfo[];
  }

  /** AgentEngine兼容：getById别名（TaskManager接口） */
  getById(taskId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    return row;
  }

  /** AgentEngine兼容：阻塞分析（TaskManager接口） */
  analyzeBlockers(projectId: string): Array<{ taskId: string; title: string; status: string; blockedCount: number; impactScore: number }> {
    return analyzeBlockersFn(this.db, projectId);
  }
}
