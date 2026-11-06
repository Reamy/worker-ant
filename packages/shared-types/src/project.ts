/** 项目状态 */
export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

/** 项目 */
export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  cron_schedule: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * 任务状态。取值域：`wa_tasks.status`。
 *
 * ⚠ 与渲染层词表 `status-view.ts` 的 `TASK_STATUS_LABEL` **键集必须一致**——两处都自称"取值域是
 *   `wa_tasks.status`"，任一漏一个取值，漏的那一处就漏网（zx_20260930 M4-4 的病根）。
 *
 * zx_20261012_2 批二（「放弃」自成一态）: 增 `archived`——"主动放弃"与"真失败"此前**同装 `failed`**，
 *   于是 `failedChildren`（收口闸）把用户主动弃掉的子任务当成"失败"挡住父任务，而 `failed` 的
 *   「可复盘为教训」语义又与"弃"不符。正名后：`failed` 只主"真失败"，`archived` 只主"已弃/已了结"。
 *
 * zx_20261012_2 批二（收类型补全）: 此前本类型只列了 6 个值，**漏掉**引擎实际会写的
 *   `planning`/`preparing`/`executing`/`investigating`/`stabilizing`（`project-engine.ts updateStatus`
 *   的 `stabilizing` 分支即活在类型之外）。一个"自称是真源"却漏一半取值的类型，与漏取值的词表同病；
 *   故补齐到全值域（与 `status-view.ts` 逐值对齐）。
 */
export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'preparing'
  | 'executing'
  | 'running'
  | 'paused'
  | 'investigating'
  | 'stabilizing'
  | 'completed'
  | 'failed'
  | 'archived';

/** 任务 */
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  context_json: Record<string, unknown> | null;
  workflow_config: Record<string, unknown> | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

/** 任务对话记录 */
export interface TaskConversation {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: unknown | null;
  token_count: number;
  created_at: string;
}

/** 用户角色 */
export type UserRole = 'super_admin' | 'admin' | 'developer' | 'viewer';

/** 用户 */
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: UserRole;
  auth_provider: string;
  created_at: string;
}

/** 产出物类型 */
export type DeliverableType = 'mcp' | 'a2a' | 'ui' | 'doc';

/** 产出物状态 */
export type DeliverableStatus = 'draft' | 'generated' | 'registered' | 'failed';

/** 项目产出物 */
export interface Deliverable {
  id: string;
  project_id: string;
  task_id: string | null;
  type: DeliverableType;
  name: string;
  description: string;
  file_path: string | null;
  registry_id: string | null;
  status: DeliverableStatus;
  created_at: string;
}
