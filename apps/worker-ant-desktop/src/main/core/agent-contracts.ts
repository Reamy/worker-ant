/**
 * B3: 显式架构契约。
 * AgentEngine与外部组件的接口定义。
 * "凡是可以说的，都可以说清楚"（逻辑哲学论·前言）
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type { Tool } from 'ai';

// ==================== 工具契约 ====================

/** Agent可用的工具集 */
export interface AIToolSet {
  /** 工具名→工具定义映射 */
  readonly tools: Record<string, Tool>;

  /** 按分类获取只读工具（可并行调用） */
  getReadonlyTools(): Record<string, Tool>;

  /** 按分类获取写入工具（每次只调一个） */
  getWriteTools(): Record<string, Tool>;

  /** 按分类获取控制工具 */
  getControlTools(): Record<string, Tool>;

  /** 工具名列表（用于系统提示） */
  getToolNames(): string[];

  /** 按分类列出工具名（用于系统提示分组展示） */
  getToolNamesByCategory(): Record<string, string[]>;
}

// ==================== 任务仓储契约 ====================

/** 任务基本信息 */
export interface TaskInfo {
  id: string;
  project_id: string;
  title: string;
  status: string;
  description: string;
  context_json: string;
  priority: number;
  source: string;
  parent_task_id: string;
  depends_on: string;
  created_at: string;
  updated_at: string;
}

/** 对话记录 */
export interface ConversationEntry {
  id: string;
  task_id: string;
  role: string;
  content: string;
  tool_calls?: string;
  token_count: number;
  created_at: string;
}

/** 任务持久化操作 */
export interface TaskRepository {
  /** 获取任务详情 */
  getTask(taskId: string): TaskInfo | null;

  /** 获取任务所属项目ID */
  getProjectId(taskId: string): string | null;

  /** 更新任务状态 */
  updateStatus(taskId: string, status: string): void;

  /** 更新任务上下文JSON */
  updateContext(taskId: string, context: Record<string, unknown>): void;

  /** 添加对话记录 */
  addConversation(taskId: string, role: string, content: string, toolCalls?: unknown, tokenCount?: number): { id: string; task_id: string; role: string; content: string };

  /** 获取对话记录 */
  getConversations(taskId: string, limit?: number): ConversationEntry[];

  /** 统计对话token数 */
  countTokens(taskId: string): number;

  /** 获取项目的子任务 */
  getSubTasks(projectId: string, parentTaskId?: string): TaskInfo[];
}

// ==================== 记忆契约 ====================

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  project_id: string;
  task_id: string | null;
  content: string;
  embedding: string | null;
  memory_type: string;
  importance: number;
  reasoning: string;
  source: string;
}

/** 记忆管理操作 */
export interface MemoryRepository {
  /** 存储文本记忆 */
  storeText(params: {
    project_id: string; task_id?: string; content: string;
    type?: string; source?: string; reasoning?: string;
    // zx_20260920_1 M7: 契约与实现对齐（`memory-manager.storeText` 落库刻度取自 `MEM_IMPORTANCE_DEFAULT`，
    //   调用方可传模型自评值；缺省即用基线）。
    importance?: number;
  }): string;

  /** 相似记忆检索 */
  retrieveSimilar(query: string, projectId: string, limit?: number): MemoryEntry[];

  /** 按类型检索记忆 */
  retrieveByType(memoryType: string, projectId: string, limit?: number): MemoryEntry[];

  /** 获取最近记忆 */
  getRecent(projectId: string, limit?: number): MemoryEntry[];

  /** 获取未嵌入的记忆 */
  getUnembedded(limit?: number): MemoryEntry[];

  /** 更新记忆embedding */
  updateEmbedding(id: string, embedding: number[]): void;
}
