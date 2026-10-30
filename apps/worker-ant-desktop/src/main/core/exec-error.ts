/**
 * zx_20261028_1 M4（王阳明·知行合一）：**失败要说清怎么办**。
 *
 * 真实标本：ANS 没起 ⇒ 执行器原样透出 `fetch failed`，用户在界面上只看到
 * 「执行失败: fetch failed」——知道"失败了"，不知道"去启动 ANS"。
 *
 * 本模块零 import（rr 与渲染层都能直引）。`describeExecutionError` 只做一件事：
 * 把已知的几类基础设施故障翻成**可执行的一句话**；**原文以子串形式保留在句末**
 * （既有断言与日志检索不丢），非已知故障则逐字返回。
 */

const ANS_HINT = 'AI 服务（ANS）未连接或不可达——请先启动 ANS（终端运行 pnpm dev:ans），再重试本任务。';

function rawMessageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (m !== undefined && m !== null && String(m).trim()) return String(m).trim();
  }
  const s = String(err ?? '').trim();
  return s || '未知错误';
}

export function describeExecutionError(err: unknown): string {
  const raw = rawMessageOf(err);
  const lower = raw.toLowerCase();
  if (/econnrefused|fetch failed|socket hang up|enotfound|econnreset|eai_again/.test(lower)) {
    return `${ANS_HINT}原始错误：${raw}`;
  }
  if (/\b401\b|unauthorized/.test(lower)) {
    return `模型端点鉴权失败（API Key 无效或已过期）——请在「模型」页检查该端点的密钥后重试。原始错误：${raw}`;
  }
  if (/\b429\b|rate limit|too many requests/.test(lower)) {
    return `模型端点限流（请求过于频繁）——请稍后重试，或在「模型」页调整并发。原始错误：${raw}`;
  }
  return raw;
}
