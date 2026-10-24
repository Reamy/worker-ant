/**
 * 「越界即拒」——变更类工具的**调用时**状态闸（zx_20261023_3 批二）。
 *
 * 实测事故：任务 `0ba7a0d4` 被暂停（16:14:08 本地；库内 UTC 08:14:08）之后，执行体仍能
 * 重启两个 M2 任务、把验收 3/6 的 `1ec0a89a` 标成完成、新建两个任务、改写方案文件、给任务发消息。
 * 根因不是"模型不听话"，而是**变更世界的工具根本不看任务状态**：`update_task_status` /
 * `create_task` / `edit_file` / `register_deliverable` / `send_message_to_task` … 都对 `paused` 一无所知。
 *
 * 两个刻意的边界（承既有裁定「守卫只拦会改变世界的动作，不拦表态」）：
 *  - 只拦**会改变世界**的 34 件（文件/交付物/任务树/记忆/项目/子代理/设备/MCP/shell）；
 *  - **不拦表态**：`ask_user`（请求用户）、`escalate_to_human`（请求人类）、`interrupt`（叫停）、
 *    `decide`（只读聚合）——把它们也拒掉，等于暂停中的任务连"我有问题要问/我要停"都说不出口。
 *  - 只读工具一律不受影响：暂停后仍可读盘、读库、看任务——**看**不是越界。
 *
 * 判据只认**任务状态**（起跑判据 `stop-signals.ts` 的同一组状态语义）：`executing/preparing/running`
 * 放行，`paused` / 终态 / 查不到行一律拒。闸在**调用时**读库（不是装配时快照）——同一 run 内
 * 前一步被暂停，后一步就进不来。
 */

/** 会改变世界的工具名——与 `tool-registry.ts` 的 `isReadOnly: false` 对账口径见 rr 套件 E 组。 */
export const WORLD_MUTATING_TOOLS = [
  // write —— 文件 / 交付物 / 项目 / 记忆
  'write_file',
  'edit_file',
  'update_project_terms',
  'update_memory',
  'save_memory',
  'merge_memories',
  'remember_preference',
  'forget_preference',
  'create_deliverable',
  'register_deliverable',
  'mark_exemplar',
  // control —— 任务树 / 收口 / 计划模式 / 跨任务消息
  'complete_investigation',
  'finalize_task',
  'create_task',
  'update_task_status',
  'enter_plan_mode',
  'exit_plan_mode',
  'send_message_to_task',
  // shell —— 命令即世界
  'execute_command',
  'bash',
  'git_clone',
  'run_privileged',
  // memory —— 前瞻 / 工作记忆 / 盲区 / 负空间 / 技能草案
  'remember_intent',
  'note_working_context',
  'register_unknown',
  'register_negative',
  'propose_skill',
  // resource —— 子代理 / 协作组 / MCP / 技能执行
  'call_mcp_tool',
  'skill',
  'spawn_subagent',
  'spawn_debate',
  'recruit_swarm',
  // device —— 控制与意图
  'device_control',
  'device_intent',
] as const;

/** 表态类：非只读，但**不改变世界**，暂停期间仍应放行（见本文件头注）。 */
export const NON_MUTATING_CONTROL_TOOLS = ['ask_user', 'escalate_to_human', 'interrupt', 'decide'] as const;

export interface MutationGateVerdict {
  ok: boolean;
  /** 拒绝因由（机器词，进日志/断言的稳定键）：`status_paused` / `status_terminal:<s>` / `status_missing`。 */
  reason?: string;
  /** 回给模型的说明（只在该工具被拒时非空）。 */
  message?: string;
}

/** 该工具是否受闸（不看状态，只看"是不是变更类"）。 */
export function isWorldMutatingTool(toolName: string): boolean {
  return (WORLD_MUTATING_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 调用时判据。`status` 由调用方**当场**从库里读（不得传装配时的快照）。
 * 非变更类工具一律放行——闸的覆盖面只在 `WORLD_MUTATING_TOOLS`。
 */
export function mutationGateVerdict(status: string | null | undefined, toolName: string): MutationGateVerdict {
  if (!isWorldMutatingTool(toolName)) return { ok: true };
  if (status === 'executing' || status === 'preparing' || status === 'running') return { ok: true };
  const reason =
    !status ? 'status_missing'
    : status === 'paused' ? 'status_paused'
    : status === 'completed' || status === 'failed' || status === 'archived' ? `status_terminal:${status}`
    : `status_${status}`;
  return {
    ok: false,
    reason,
    message: `任务当前状态为 ${status ?? '不存在'}，已暂停或结束：本工具会改变世界，本次调用被拒绝，未执行。请勿重试；等待恢复后由新一轮执行继续。`,
  };
}
