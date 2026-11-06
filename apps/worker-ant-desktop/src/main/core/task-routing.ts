/**
 * zx_20261017_1 批一（孙子·谋攻「知彼知己」/ 管子·各尽所能）: **任务形态 → 节点能力卡类目**的唯一真源。
 *
 * 病根：ANS 派单按 `ans_nodes.card_json.categories` 过滤目标节点，而编排器此前**恒派**
 *   `project_task`（每台工蚁卡恒含）——"按能力接活"名存实亡：擅长调研的轻节点与能跑 shell 的重节点
 *   在派单眼里没有区别。任务形态在 `task-archetype.ts` 已有唯一分类（关键词规则，零 LLM、确定性），
 *   本模块只做**形态 → 类目**的映射，不另写一套分类。
 *
 * ⚠ **只用关键词分类**（`classifyArchetypeKeyword`），不用家族相似性/长度兜底：外派是"把任务发给别的机器"，
 *   不确定就该留在本机。`conversation` 与无法归类一律 `null`（不外派）——设备祈使句、即时问答落这些档，
 *   外派会丢上下文与设备面。
 * ⚠ 本模块**只输出类目名**，不判断某台节点是否具备该类目——那是 `node-card.ts` 与 ANS
 *   `DISPATCHABLE_WHERE` 的事（能力判据仍一处）。
 */
import type { NodeCardCategory } from '@worker-ant/shared-types';
import { classifyArchetypeKeyword, type TaskArchetype } from './task-archetype.js';

/**
 * 形态 → 能力卡类目。
 *   - `code`/`configuration`/`analysis` 都需要写盘或跑命令 ⇒ `code`
 *   - `research` 需要搜索/读资料 ⇒ `research`
 *   - `document` 只需读写文本 ⇒ `text`（每台工蚁卡恒含）
 *   - `conversation` **不外派**（`null`）
 */
export const ARCHETYPE_NODE_CATEGORY: Record<TaskArchetype, NodeCardCategory | null> = {
  code: 'code',
  configuration: 'code',
  analysis: 'code',
  research: 'research',
  document: 'text',
  conversation: null,
};

/** 形态 → 类目（纯函数；`conversation` ⇒ `null`）。 */
export function routeCategoryForArchetype(archetype: TaskArchetype): NodeCardCategory | null {
  return ARCHETYPE_NODE_CATEGORY[archetype];
}

/**
 * 由任务标题/描述推外派类目。**关键词分类不出结果 ⇒ `null`**（不确定不外派，不退化成猜测）。
 * `title`/`description` 任一为空都可（拼接后整体判）。
 */
export function routeCategoryForTask(title: unknown, description: unknown): NodeCardCategory | null {
  const text = `${String(title ?? '')} ${String(description ?? '')}`.trim();
  if (!text) return null;
  const archetype = classifyArchetypeKeyword(text);
  return archetype ? routeCategoryForArchetype(archetype) : null;
}
