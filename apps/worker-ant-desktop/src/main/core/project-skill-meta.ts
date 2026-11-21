/**
 * zx_20261121_1 M1「属·表」：项目可调用技能的**纯词表**（零依赖）。
 *
 * 与岗位技能同一把尺（状态/上限），不另抄一份数字：直接复用
 * `position-skill-meta.ts` 的常量与状态词表。单列本文件是为了让渲染层
 * 可安全 import（`project-skills.ts` 链上有 `skill-registry` 的 fs/os/ANS，
 * 渲染层不得引入主进程链，承 `feedback_renderer_must_not_import_main_chain`）。
 */

import {
  POSITION_SKILL_DESCRIPTION_MAX,
  POSITION_SKILL_NAME_MAX,
  POSITION_SKILL_STATUSES,
  POSITION_SKILL_STATUS_LABEL,
  POSITION_SKILL_STEP_MAX,
  POSITION_SKILL_STEPS_MAX,
  type PositionSkillStatus,
} from './position-skill-meta.js';

export const PROJECT_SKILL_STATUSES = POSITION_SKILL_STATUSES;
export type ProjectSkillStatus = PositionSkillStatus;
export const PROJECT_SKILL_STATUS_LABEL = POSITION_SKILL_STATUS_LABEL;

export const PROJECT_SKILL_NAME_MAX = POSITION_SKILL_NAME_MAX;
export const PROJECT_SKILL_DESCRIPTION_MAX = POSITION_SKILL_DESCRIPTION_MAX;
export const PROJECT_SKILL_STEPS_MAX = POSITION_SKILL_STEPS_MAX;
export const PROJECT_SKILL_STEP_MAX = POSITION_SKILL_STEP_MAX;

/** 技能来源：`memory`（程序性记忆提炼）/ `legacy`（旧 wa_skills 迁移）/ `manual`（人工）。 */
export const PROJECT_SKILL_SOURCES = ['memory', 'legacy', 'manual'] as const;
export type ProjectSkillSource = (typeof PROJECT_SKILL_SOURCES)[number];

export interface ProjectSkill {
  id: string;
  projectId: string;
  name: string;
  description: string;
  steps: string[];
  status: ProjectSkillStatus;
  source: string;
  useCount: number;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string;
}
