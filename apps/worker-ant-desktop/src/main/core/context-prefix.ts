/**
 * zx_20261018_2 批三「见省」: **稳定前缀指纹**——只回答一个问题：
 *   「这次 run 的前缀，和上次是不是同一段字节？」（`run_features.ctx_prefix_hash/chars/end`）
 *
 * 为什么只记这些、**不记"缓存命中"**：命不命中发生在供应商侧（各家前缀缓存的最小粒度、TTL、
 *   计费口径都不同），本机看不到。把"hash 相同"写成"缓存命中"就是拿内部记账词冒充事物本身
 *   （承 zx_20261015_2 的病根）。hash 相同只是**可复用**的必要条件，不是命中事实。
 *
 * 口径：
 *   · 只算 `[0, end)`——即 `buildTaskContext` 的稳定前缀（系统骨架/工具简报/用户偏好/项目稳定上下文/沙箱）。
 *   · 角色与内容一起入哈希（同内容放成 user 或 system 不是同一段前缀）；内容按 `JSON.stringify` 取，
 *     字符串消息即其字面量（`JSON.stringify('x') === '"x"'`，长度差 2，故 `chars` 另按原文长度计）。
 *   · `end` 越界按 `messages.length` 截（调用方给的是装配时的下标；保险而非猜测）。
 */
import { createHash } from 'node:crypto';
import type { CoreMessage } from 'ai';

export interface PrefixFingerprint {
  /** sha256（hex）——角色 + 内容逐条入哈希 */
  hash: string;
  /** 前缀消息的**内容字符数**合计（不含角色/分隔符，与 tokens 无换算关系） */
  chars: number;
  /** 实际计入的前缀消息条数（`[0, end)`，已钳位） */
  end: number;
}

export function fingerprintMessages(
  messages: readonly CoreMessage[],
  end: number,
): PrefixFingerprint {
  const n = Math.max(0, Math.min(end, messages.length));
  const h = createHash('sha256');
  let chars = 0;
  for (let i = 0; i < n; i++) {
    const m = messages[i]!;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    h.update(m.role);
    h.update('\u0000');
    h.update(text);
    h.update('\u0001');
    chars += text.length;
  }
  return { hash: h.digest('hex'), chars, end: n };
}
