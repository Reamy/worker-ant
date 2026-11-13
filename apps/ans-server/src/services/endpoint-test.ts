/**
 * zx_20261113_2 M6「名」——端点测试请求的**协议自适应**（一处真源，纯函数）。
 *
 * 病根（2026-11-13 真标本）：`POST /api/v1/models/endpoints/:id/test` 固定请求
 *   `GET {url}/models`。对 Ollama 原生嵌入端点 `http://localhost:11434/api/embed`，
 *   实际请求的是 `.../api/embed/models` —— 实测 **404**，而 `POST /api/embed` 是通的。
 *
 * 判据：
 *   - `/api/embeddings`（Ollama 旧版）⇒ POST 原 URL，body `{model, prompt:'ping'}`
 *   - `/api/embed` 或其它以 `/embeddings` 结尾的 OpenAI 兼容嵌入端点 ⇒ POST 原 URL，body `{model, input:'ping'}`
 *   - 其余视为 OpenAI 兼容基址 ⇒ GET `{base}/models`（沿用原行为）
 */
export interface EndpointTestRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
}

export function buildEndpointTestRequest(url: string, modelName = ''): EndpointTestRequest {
  const clean = (url || '').replace(/\/$/, '');
  if (/\/api\/embeddings$/i.test(clean)) {
    return { method: 'POST', url: clean, body: { model: modelName, prompt: 'ping' } };
  }
  if (/\/api\/embed$/i.test(clean) || /\/embeddings$/i.test(clean)) {
    return { method: 'POST', url: clean, body: { model: modelName, input: 'ping' } };
  }
  return { method: 'GET', url: `${clean}/models` };
}
