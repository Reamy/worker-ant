/**
 * zx_20261113_2 M8「名」——嵌入端点的「要不要 Key」判定（零依赖纯模块）。
 *
 * 病根：`embed-memory` 作业把 `api_key` 当硬条件（`!embModel?.api_key` 即跳过）。
 *   本机 Ollama（`http://localhost:11434/api/embed`）**不需要 Key**；用户若留空，
 *   嵌入作业会静默跳过，模型页却显示"可用"——两本账。
 *
 * 口径：只对**本机回环**端点放行空 Key；远端（含局域网 IP）仍要求 Key——
 *   不把"没配 Key"冒充成"可直连"，远端缺 Key 仍如实跳过并留日志。
 */
export function isLocalEndpointUrl(url: string): boolean {
  const u = (url || '').trim().toLowerCase();
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::|\/|$)/.test(u);
}

/** `true` = 这个端点需要 api_key；本机回环端点返回 `false`。 */
export function embeddingEndpointNeedsKey(url: string): boolean {
  return !isLocalEndpointUrl(url);
}
