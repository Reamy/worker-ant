/**
 * zx_20261120_3 M4「积·技」：岗位可调用技能的**纯词表**（零依赖）。
 *
 * 为什么单独一份：渲染层（岗位页「能力」页签）需要状态词与上限，
 * 但 `position-skills.ts` 链上有 `skill-registry`（fs/os/ANS）——渲染层不得引入主进程链
 * （承 auto-memory `feedback_renderer_must_not_import_main_chain`）。故词表/类型留在这里。
 */

export const POSITION_SKILL_STATUSES = ['draft', 'approved', 'rejected'] as const;
export type PositionSkillStatus = (typeof POSITION_SKILL_STATUSES)[number];

export const POSITION_SKILL_STATUS_LABEL: Record<PositionSkillStatus, string> = {
  draft: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
};

export const POSITION_SKILL_NAME_MAX = 40;
export const POSITION_SKILL_DESCRIPTION_MAX = 200;
export const POSITION_SKILL_STEPS_MAX = 20;
export const POSITION_SKILL_STEP_MAX = 300;

export interface PositionSkill {
  id: string;
  positionId: string;
  name: string;
  description: string;
  steps: string[];
  status: PositionSkillStatus;
  sourceLessonId: string;
  useCount: number;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string;
}
