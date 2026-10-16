/**
 * MCP Client连接池（从原工蚁 mcp-client-pool.ts 移植，fetch-based 适配桌面端无SDK）。
 * 按serverName缓存工具列表，提供 listMcpTools/callMcpTool 统一入口。
 */
import { createLogger } from './logger.js';
// zx_20261005 M21: 池内兜底端点取 ANS 地址**单一真源**（此前后两处各写 localhost:3001，改端口即失配）。
import { ANS_DEFAULT_BASE_URL } from '@worker-ant/shared-types';

const logger = createLogger('mcp-client-pool');

interface CachedMcpClient {
  serverName: string;
  endpoint: string;
  tools: Array<{ name: string; description: string; params: string[] }>;
  /** MCP 服务自报信息（诊断/展示用；由 `listMcpTools` 返回给 `find_mcp_service`）。 */
  serverInfo: Record<string, unknown>;
  createdAt: number;
  /** 连续失败计数（诊断用；由 `listMcpTools` 返回）。HTTP 往返成功即归零。 */
  failures: number;
}

/** 连接池按 **(serverName, endpoint)** 复合键缓存（zx_20260929 M2）：只按 serverName 缓存时，
 *  同名服务在不同端点下会互相取到对方的连接（端点是**按调用**解析的，可能不同）。 */
const clientPool = new Map<string, CachedMcpClient>();
const CACHE_TTL = 10 * 60 * 1000;

type EndpointResolver = (serverName: string) => Promise<{ name: string; endpoint: string } | null>;

/** 按调用传入的端点解析器（zx_20260929 M2）。此前是**进程级全局** `setEndpointResolver`——
 *  并发任务各调一次即互相覆盖：后来者改掉先来者仍在用的解析器。 */
export interface McpCallOptions {
  endpointResolver?: EndpointResolver;
}

function defaultEndpoint(serverName: string): string {
  return `${ANS_DEFAULT_BASE_URL}/mcp/${encodeURIComponent(serverName)}`;
}

/** 复合键用 `JSON.stringify` 拼装：服务名与端点都可能含空格等字符，任何手写分隔符都可能被内容撞上。 */
function keyOf(serverName: string, endpoint: string): string {
  return JSON.stringify([serverName, endpoint]);
}

async function resolveEndpointFor(serverName: string, resolver?: EndpointResolver): Promise<string> {
  if (!resolver) return defaultEndpoint(serverName);
  try {
    const resolved = await resolver(serverName);
    return resolved?.endpoint || defaultEndpoint(serverName);
  } catch {
    return defaultEndpoint(serverName);
  }
}

export async function listMcpTools(serverName: string, opts: McpCallOptions = {}): Promise<{ name: string; endpoint: string; tools: Array<{ name: string; description: string; params: string[] }>; serverInfo: Record<string, unknown>; failures: number }> {
  const entry = await getOrConnect(serverName, opts.endpointResolver);
  return { name: entry.serverName, endpoint: entry.endpoint, tools: entry.tools, serverInfo: entry.serverInfo, failures: entry.failures };
}

export async function callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>, opts: McpCallOptions = {}): Promise<unknown> {
  const entry = await getOrConnect(serverName, opts.endpointResolver);
  try {
    return await postToolCall(entry, toolName, args);
  } catch (err) {
    entry.failures++;
    if (isToolNotFound(err)) {
      // 「工具不在册」⇒ 刷新一次（这正是本函数存在的理由：TTL 缓存的失效点）再重试一次；仍失败则如实抛出。
      await refreshMcpTools(serverName, opts);
      return await postToolCall(await getOrConnect(serverName, opts.endpointResolver), toolName, args);
    }
    const msg = (err as Error).message || '';
    if (msg.includes('fetch') || msg.includes('ECONN') || msg.includes('connection')) disconnect(serverName);
    throw err;
  }
}

async function postToolCall(entry: CachedMcpClient, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${entry.endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await resp.json() as { result?: unknown; error?: { code?: number; message?: string } };
  // HTTP 往返成功 ⇒ 服务可达：健康计数归零（与随后那个错是「工具级」还是「传输级」无关）
  entry.failures = 0;
  if (result.error) {
    const e = new Error(result.error.message || 'MCP调用失败') as Error & { rpcCode?: number };
    e.rpcCode = result.error.code;
    throw e;
  }
  return result.result;
}

/** JSON-RPC 的「工具不在册」类错误：`-32601` = Method not found。 */
function isToolNotFound(err: unknown): boolean {
  const e = err as Error & { rpcCode?: number };
  if (e?.rpcCode === -32601) return true;
  return /not found|no such tool|unknown tool|未找到|不存在/i.test(e?.message || '');
}

/** 刷新某服务的工具缓存（zx_20260929 M2：由 `callMcpTool` 在「工具不在册」时调用——
 *  此前是本文件里**无调用方**的导出）。 */
export async function refreshMcpTools(serverName: string, opts: McpCallOptions = {}): Promise<void> {
  disconnect(serverName);
  await getOrConnect(serverName, opts.endpointResolver);
}

/** 断开某服务的**全部**端点连接（按池内条目自带的 `serverName` 字段精确匹配，不做键字符串解析）。 */
export function disconnect(serverName: string): void {
  for (const [key, entry] of [...clientPool]) {
    if (entry.serverName === serverName) clientPool.delete(key);
  }
}

export async function disconnectAll(): Promise<void> {
  const count = clientPool.size;
  clientPool.clear();
  logger.info(`[mcp-client-pool] All ${count} connections closed`);
}

/**
 * 清掉**过期的工具清单**。
 *
 * zx_20260930 M10: 判据由 `lastSuccessAt` 改为 **`createdAt`（条目年龄）**。
 *   TTL 管的是"这份 `tools` 清单有多旧"，不是"这个服务最近有没有被用过"——
 *   此前拿 `lastSuccessAt` 判，而它在**每次成功调用**（`postToolCall`）都被刷新，
 *   于是**越活跃的服务越不会过期**：一个天天在调的服务，工具清单可以几十天不刷新。
 *   服务端新加的工具因此**结构性看不见**——而这正是本函数唯一的存在理由。
 *   （唯一的补救原是 `callMcpTool` 撞上 `-32601` 后刷新一次，可那要求调用方先**知道名字**去调
 *   一个它看不见的工具，闭环不成立。）
 *
 * `lastSuccessAt` 字段**已随之删除**：改以 `createdAt` 判失效后它就成了只写不读的死状态，
 * 留着就是"看起来在记账、其实没人看"（本仓对"虚账"的老毛病）。
 * 活跃服务也在一个 TTL 后失效：下次 `getOrConnect` 会重连并重取 `tools/list`。
 */
function cleanExpired(): void {
  const now = Date.now();
  for (const [key, entry] of clientPool) {
    if (now - entry.createdAt > CACHE_TTL) clientPool.delete(key);
  }
}

async function getOrConnect(serverName: string, resolver?: EndpointResolver): Promise<CachedMcpClient> {
  cleanExpired();
  const endpoint = await resolveEndpointFor(serverName, resolver);
  const key = keyOf(serverName, endpoint);
  const cached = clientPool.get(key);
  if (cached) return cached;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json() as { result?: { tools?: Array<{ name: string; description: string; inputSchema?: { properties?: Record<string, unknown> } }>; serverInfo?: Record<string, unknown> } };
  const tools = (data.result?.tools || []).map(t => ({ name: t.name, description: t.description || '', params: Object.keys(t.inputSchema?.properties || {}) }));
  const entry: CachedMcpClient = { serverName, endpoint, tools, serverInfo: data.result?.serverInfo || {}, createdAt: Date.now(), failures: 0 };
  clientPool.set(key, entry);
  return entry;
}
