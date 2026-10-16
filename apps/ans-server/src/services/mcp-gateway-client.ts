/**
 * SDK-based MCP client for proxying requests to registered MCP servers.
 * Uses @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mcp-gateway-client');

interface CachedClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  createdAt: number;
}

const clientCache = new Map<string, CachedClient>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cleanExpiredCache() {
  const now = Date.now();
  for (const [key, entry] of clientCache) {
    if (now - entry.createdAt > CACHE_TTL) {
      entry.client.close().catch(() => {
        /* cleanup — connection already closed */
      });
      clientCache.delete(key);
    }
  }
}

async function getOrCreateClient(endpoint: string): Promise<Client> {
  cleanExpiredCache();

  const cached = clientCache.get(endpoint);
  if (cached) return cached.client;

  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: 'ans-gateway', version: '0.1.0' }, { capabilities: {} });

  await client.connect(transport);
  clientCache.set(endpoint, { client, transport, createdAt: Date.now() });

  logger.info({ endpoint }, 'MCP gateway client connected');
  return client;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Forward a JSON-RPC request to a registered MCP server and return the response.
 */
export async function forwardToMcpServer(endpoint: string, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  try {
    const client = await getOrCreateClient(endpoint);

    switch (request.method) {
      case 'initialize': {
        const result = {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: client.getServerCapabilities(),
          serverInfo: client.getServerVersion(),
        };
        return { jsonrpc: '2.0', id: request.id, result };
      }
      case 'tools/list': {
        const result = await client.listTools();
        return { jsonrpc: '2.0', id: request.id, result };
      }
      case 'tools/call': {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> };
        if (!params?.name) {
          return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Missing tool name' } };
        }
        const result = await client.callTool({
          name: params.name,
          arguments: params.arguments ?? {},
        });
        return { jsonrpc: '2.0', id: request.id, result };
      }
      case 'resources/list': {
        const result = await client.listResources();
        return { jsonrpc: '2.0', id: request.id, result };
      }
      case 'ping': {
        return { jsonrpc: '2.0', id: request.id, result: {} };
      }
      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  } catch (err) {
    logger.warn({ endpoint, method: request.method, err }, 'MCP forward failed');
    // Clean up failed client from cache
    const cached = clientCache.get(endpoint);
    if (cached) {
      cached.client.close().catch(() => {
        /* cleanup — connection already closed */
      });
      clientCache.delete(endpoint);
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: `MCP server error: ${(err as Error).message}` },
    };
  }
}

/**
 * Clean up all cached clients (for graceful shutdown).
 */
export async function closeAllMcpClients(): Promise<void> {
  for (const [endpoint, entry] of clientCache) {
    try {
      await entry.client.close();
      logger.info({ endpoint }, 'MCP gateway client closed');
    } catch {
      // ignore close errors
    }
  }
  clientCache.clear();
}
