/**
 * zx_20261004 M1：节点**自助注册**（令牌换 key）。
 *
 * 刻意**不**放进 `AnsClient`：`AnsClient.request` 对每个请求都签 HMAC，而这一步的病根恰恰是
 * **本机还没有 key**（签不出 HMAC）。故这里是一条纯 `fetch`，凭证是**注册令牌**本身。
 */
import type { NodeRegistrationRequest, NodeRegistrationResult } from '@worker-ant/shared-types';

export async function enrollNode(
  serverUrl: string,
  req: NodeRegistrationRequest,
  opts: { timeoutMs?: number } = {},
): Promise<NodeRegistrationResult> {
  const base = serverUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v1/nodes/register`, {
    method: 'POST',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ANS node enrollment failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<NodeRegistrationResult>;
}
