/**
 * MCP资源预热服务 — 注册时自动连接MCP服务器并缓存工具列表和服务信息。
 * 使用 @modelcontextprotocol/sdk Client 进行标准化协议交互。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp-discovery');

export interface CachedMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface CachedServerInfo {
  name: string;
  version?: string;
}

export interface McpDiscoveryResult {
  success: boolean;
  serverInfo?: CachedServerInfo;
  tools: CachedMcpTool[];
  error?: string;
}

/**
 * 连接到MCP服务器，执行initialize + listTools，返回发现的工具列表。
 */
export async function discoverMcpServer(endpoint: string): Promise<McpDiscoveryResult> {
  let transport: StreamableHTTPClientTransport | null = null;
  let client: Client | null = null;

  try {
    transport = new StreamableHTTPClientTransport(new URL(endpoint));
    client = new Client({ name: 'ans-discovery', version: '0.1.0' }, { capabilities: {} });

    await client.connect(transport);

    const capabilities = client.getServerCapabilities();
    const serverInfo = client.getServerVersion();
    const toolsResult = await client.listTools();

    const tools: CachedMcpTool[] = (toolsResult?.tools ?? []).map(
      (t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }),
    );

    logger.info(
      { endpoint, serverInfo, toolCount: tools.length, tools: tools.map((t) => t.name) },
      'MCP discovery success',
    );

    return {
      success: true,
      serverInfo: { name: serverInfo?.name ?? 'unknown', version: serverInfo?.version },
      tools,
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ endpoint, err: msg }, 'MCP discovery failed');
    return { success: false, tools: [], error: msg };
  } finally {
    // 发现完成后断开，不保持长连接
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }
}
