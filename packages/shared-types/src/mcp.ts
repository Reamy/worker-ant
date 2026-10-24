/** MCP传输模式 */
export type McpTransport = 'stdio' | 'streamable-http';

/** MCP认证配置 */
export interface McpAuthConfig {
  type: 'bearer' | 'none';
  token?: string;
}

/** MCP服务 */
export interface McpServer {
  id: string;
  name: string;
  endpoint: string;
  transport: McpTransport;
  auth_config: McpAuthConfig | null;
  status: 'active' | 'disabled';
  health_check_at: string | null;
  created_at: string;
}

/** 创建MCP服务的输入 */
export interface CreateMcpServerInput {
  name: string;
  endpoint: string;
  transport?: McpTransport;
  auth_config?: McpAuthConfig;
}

/** MCP服务匹配请求 */
export interface McpRequirements {
  tags?: string[];
  name?: string;
}

/** MCP服务端点（匹配结果） */
export interface McpServerEndpoint {
  id: string;
  name: string;
  endpoint: string;
  transport: McpTransport;
  auth_config: McpAuthConfig | null;
}
