/**
 * 端点 base → `chat/completions` 全路径 —— **全仓唯一一处**知道这件事的地方。
 *
 * zx_20260921_1 M3：「我们把请求按**我们以为的形状**发出去，而不是按**对方读的形状**发出去」。
 * 改前全仓有 **7 处**各写一份拼接，其中两种写法**互相矛盾**（`audio-transcribe.ts` 会补 `/v1`，
 * `task-decompose.ts` 刻意逐字追加），而库里 `ans_model_endpoints.url` 的形态**不止一种**
 * （纯主机 / `/v1` / `/v1beta` / `/api/v3` / `/api/paas/v4` / 已含全路径）⇒ 同一份数据在不同
 * 出口被拼成不同 URL，其中一部分是 404。
 *
 * **规则顺着 url 自身的结构走，不按 host 打表**（《庄子·养生主》「依乎天理」——不换刀，换看的方式）：
 *
 * ```
 * 已以 /chat/completions 结尾                          ⇒ 原样（幂等）
 * pathname 非空（/v1、/v1beta、/api/v3、/api/paas/v4…） ⇒ 追加 /chat/completions
 * pathname 为空（纯主机，如 https://api.deepseek.com）  ⇒ 追加 /v1/chat/completions
 * ```
 *
 * ⚠ **管不着的地方（如实记，不装作管得住）**：桌面主聊天路走 `createSafeProvider`，把 baseURL
 * 交给 `@ai-sdk/openai`，由 **SDK 自己逐字追加** `/chat/completions` ⇒ 对"纯主机"端点主路给
 * `host/chat/completions`、本函数给 `host/v1/chat/completions`。两者不相等，且**本函数改不了它**。
 * 这是**端点该登记成什么**的问题（同族的还有 Google 的 OpenAI 兼容层实为 `…/v1beta/openai`），
 * 不是"怎么拼"的问题——不拿代码去猜。
 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (!raw) return raw;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // 解析不出（无 scheme 等）——原样返回，不猜一个更长的路径出来骗过调用方。
    return raw;
  }

  u.search = '';
  u.hash = '';

  const path = u.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    u.pathname = path;
  } else {
    u.pathname = path === '' ? '/v1/chat/completions' : `${path}/chat/completions`;
  }
  return u.toString();
}
