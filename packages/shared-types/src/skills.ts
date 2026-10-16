/** 技能 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown> | null;
  mcp_server_id: string | null;
  tags: string[];
  status: 'active' | 'disabled';
  created_at: string;
}

/** 创建技能的输入 */
export interface CreateSkillInput {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
  mcp_server_id?: string;
  tags?: string[];
}

/** 技能匹配请求 */
export interface SkillRequirements {
  tags?: string[];
  name?: string;
}

/** 技能端点（匹配结果） */
export interface SkillEndpoint {
  id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown> | null;
  tags: string[];
}
