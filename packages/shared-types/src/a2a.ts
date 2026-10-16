/** A2A认证配置 */
export interface A2AAuthConfig {
  type: 'bearer' | 'none';
  token?: string;
}

/** A2A服务 */
export interface A2AServer {
  id: string;
  name: string;
  agent_card_url: string;
  capabilities: string[];
  auth_config: A2AAuthConfig | null;
  status: 'active' | 'disabled';
  health_check_at: string | null;
  created_at: string;
}

/** 创建A2A服务的输入 */
export interface CreateA2AServerInput {
  name: string;
  agent_card_url: string;
  capabilities?: string[];
  auth_config?: A2AAuthConfig;
}

/** A2A服务匹配请求 */
export interface A2ARequirements {
  capabilities?: string[];
}

/** A2A服务端点（匹配结果） */
export interface A2AServerEndpoint {
  id: string;
  name: string;
  agent_card_url: string;
  capabilities: string[];
  auth_config: A2AAuthConfig | null;
}
