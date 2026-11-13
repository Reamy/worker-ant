/**
 * zx_20261113_3 B2「名」——MCP 服务器名的**存在性前置**（零依赖纯逻辑 + 注入取数）。
 *
 * 病根（真标本 `045bdbcf`）：`call_mcp_tool` 给什么 serverName 就调什么；模型用占位名
 *   `nonexistent-probe` 自测，ANS 回 `MCP server not found`，失败还写进 `wa_service_calls`。
 *
 * 口径（三层，先本地后网络）：
 *   1. 占位/探针名（`nonexistent*` / `probe` / `test-probe` / `example` / `fake` / `placeholder` / `unknown`）
 *      ⇒ **直接拒绝**，不发网络请求、不写调用账；
 *   2. 非占位名：known-set = 本项目 `wa_deliverables(type='mcp')` ∪ ANS `/api/v1/mcp/`；
 *      注册表**可读**且名字不在集合 ⇒ 拒绝（带 `knownServers` 前 20）；
 *   3. 注册表**不可读** ⇒ **放行**（fail-open）：不拿“我没查成”冒充“它不存在”，真实调用仍由网关给结论。
 *
 * 缓存：60s（按 `cacheKey`，生产 = `projectId|ansUrl`）；**失败不缓存**（下一跳可立即重试）。
 * `readAns` 由调用方注入（生产 = `ansSignedRequest`），故本模块可被 rr 直跑、不触网。
 */

export interface McpRegistryServer {
  name: string;
  status?: string;
  endpoint?: string;
}

export type KnownMcpServers =
  | { ok: true; names: string[]; ansServers: McpRegistryServer[] }
  | { ok: false; reason: string; names: string[]; ansServers: [] };

export interface McpRegistryDeps {
  projectNames: string[];
  readAns: () => Promise<{ ok: true; servers: McpRegistryServer[] } | { ok: false; reason: string }>;
  /** 生产 = `${projectId}|${ansUrl}`；rr 可省。 */
  cacheKey?: string;
  /** 测试注入；生产缺省 `Date.now`。 */
  now?: () => number;
}

/** 窄口径：只认明确的占位声明；`probe-api` 这类正常名不误杀（与调用账的探针标记同一份）。 */
const PLACEHOLDER_RE = /^(?:nonexistent(?:[-_].*)?|probe|test-probe|example|fake|placeholder|unknown)$/i;

export function isPlaceholderMcpServerName(name: string): boolean {
  return PLACEHOLDER_RE.test(String(name || '').trim());
}

export const MCP_REGISTRY_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: KnownMcpServers }>();

/** 读 known-set。`readAns` 失败/抛错 ⇒ `ok:false`（调用方据此 fail-open）。 */
export async function resolveKnownMcpServers(deps: McpRegistryDeps): Promise<KnownMcpServers> {
  const projectNames = [...new Set((deps.projectNames || []).map((s) => String(s || '').trim()).filter(Boolean))];
  const now = deps.now ? deps.now() : Date.now();
  if (deps.cacheKey) {
    const hit = cache.get(deps.cacheKey);
    // 只复用成功结果；失败不缓存（ans 恢复后下一次调用应立即重试）。
    if (hit && hit.value.ok && now - hit.at < MCP_REGISTRY_CACHE_TTL_MS) return hit.value;
  }
  let ans: { ok: true; servers: McpRegistryServer[] } | { ok: false; reason: string };
  try {
    ans = await deps.readAns();
  } catch (e) {
    ans = { ok: false, reason: (e as Error)?.message || String(e) };
  }
  if (!ans.ok) {
    return { ok: false, reason: ans.reason || 'ANS 注册表不可读', names: projectNames, ansServers: [] };
  }
  const ansServers = (ans.servers || [])
    .map((s) => ({ ...s, name: String(s?.name || '').trim() }))
    .filter((s) => s.name.length > 0);
  const value: KnownMcpServers = {
    ok: true,
    names: [...new Set([...projectNames, ...ansServers.map((s) => s.name)])],
    ansServers,
  };
  if (deps.cacheKey) cache.set(deps.cacheKey, { at: now, value });
  return value;
}

export type McpPrecheck =
  | { ok: true }
  | { ok: false; error: string; hint: string; knownServers: string[] };

/** 调用前的本地判定；**不写任何账**（拒绝不是一次外部调用）。 */
export function precheckMcpServer(serverName: string, known: KnownMcpServers): McpPrecheck {
  const name = String(serverName || '').trim();
  const knownServers = known.names.slice(0, 20);
  if (!name) return reject('(empty)', knownServers, '服务器名为空');
  if (isPlaceholderMcpServerName(name)) return reject(name, knownServers, '服务器名是占位/探针名');
  if (known.ok && !known.names.includes(name)) return reject(name, knownServers, '服务器不在项目/ANS 的 known-set 中');
  return { ok: true };
}

function reject(name: string, knownServers: string[], why: string): McpPrecheck {
  return {
    ok: false,
    error: `MCP server not found: ${name}`,
    hint: `${why}——先用 find_mcp_service 查看可用服务（knownServers 前 20）`,
    knownServers,
  };
}
