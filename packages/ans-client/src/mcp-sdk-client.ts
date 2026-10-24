/**
 * ANS MCP SDK客户端 — 基于@modelcontextprotocol/sdk的即用型MCP客户端。
 * 自动发现最优MCP服务 → 连接初始化 → 缓存工具列表 → 返回可用实例。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpRequirements } from '@worker-ant/shared-types';
import type { AnsClient } from './client.js';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpClientInstance {
  /** 服务名称 */
  name: string;
  /** 服务端点URL */
  endpoint: string;
  /** 服务信息（来自initialize） */
  serverInfo: Record<string, unknown>;
  /** 已缓存的工具列表 */
  tools: McpToolInfo[];
  /** 调用MCP工具 */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 刷新工具列表 */
  listTools(): Promise<McpToolInfo[]>;
  /** 列出资源 */
  listResources(): Promise<unknown>;
  /** 关闭连接 */
  close(): Promise<void>;
}

/**
 * 通过ANS客户端获取最优MCP服务并建立SDK连接。
 * 返回即用型McpClientInstance，工具列表已预取缓存。
 */
export async function connectMcpClient(ansClient: AnsClient, req: McpRequirements): Promise<McpClientInstance> {
  const server = await ansClient.getOptimalMcp(req);

  const transport = new StreamableHTTPClientTransport(new URL(server.endpoint));
  const client = new Client({ name: 'ans-sdk-client', version: '0.1.0' }, { capabilities: {} });

  await client.connect(transport);

  const capabilities = client.getServerCapabilities();
  const serverInfo = client.getServerVersion();
  const toolsResult = await client.listTools();

  const tools: McpToolInfo[] = (toolsResult?.tools ?? []).map(
    (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }),
  );

  return {
    name: server.name,
    endpoint: server.endpoint,
    serverInfo: { ...serverInfo, capabilities },
    tools,
    callTool: async (name: string, args: Record<string, unknown>) => {
      return client.callTool({ name, arguments: args });
    },
    listTools: async () => {
      const result = await client.listTools();
      const freshTools: McpToolInfo[] = (result?.tools ?? []).map(
        (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }),
      );
      // 更新缓存
      (tools as McpToolInfo[]).length = 0;
      tools.push(...freshTools);
      return tools;
    },
    listResources: async () => {
      return client.listResources();
    },
    close: async () => {
      await client.close();
    },
  };
}
