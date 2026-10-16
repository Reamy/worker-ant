/**
 * zx_20260930 M15-⑥：MCP 网关 `POST /mcp/:name` 的**保留名**唯一真源。
 *
 * 病根：`mcp-gateway.ts` 的 `POST /:name`（动态段）与 `mcp-proxy.ts` 的 `POST /message`（静态段）
 *   **同为 `/mcp/message`**。Elysia 1.2 实测：**静态路径恒胜动态段，与注册顺序无关**
 *   ⇒ 动态段那支永远收不到 `name === 'message'`，里面那句「Reserved endpoint」是**够不着的死码**。
 * 真正的病不是那行死码，而是**「谁接 `/mcp/message`」这件事此前要读注册顺序才能答**：
 *   名字叫 `message` 的 MCP 服务器能落库、能出现在列表里、`/mcp/optimal` 也照选它，
 *   但它**永远代理不到**（请求被静态段截走）——一种静默的「在册而不可达」。
 *
 * 收口方式：把「`message` 是保留名」从**事实**升成**入口处判死的不变量**——
 *   建/改 MCP 服务器时撞上保留名即 400（`routes/mcp.ts`），
 *   网关那支死码删掉、注释指向本模块。这样「谁在跑」由白名单回答，不再由注册顺序回答。
 *
 * 保留名的判定域就是**本前缀下静态路由的路径段**：改 `mcp-proxy.ts` 的静态路由须同步本表。
 */
export const MCP_GATEWAY_RESERVED_NAMES: readonly string[] = ['message'];

/** 保留名的**理由**（回给用户看：要说清"为什么不行"，不能只说"不行"）。 */
export const MCP_GATEWAY_RESERVED_REASON = `以下名字被网关的静态路由占用，用作 MCP 服务器名会永久不可达（请求会被静态段截走）：${MCP_GATEWAY_RESERVED_NAMES.join(' / ')}`;

export function isReservedMcpServerName(v: unknown): boolean {
  return typeof v === 'string' && MCP_GATEWAY_RESERVED_NAMES.includes(v);
}
