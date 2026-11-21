/**
 * zx_20261116_3 M1「限」：计费/质量账的**批量上报队列**。
 *
 * 病根（真事故 2026-11-16）：`exec-step` 每步两次 `AnsClient.post`（计费 + 质量账），
 * 均为 fire-and-forget；全局 60/min 限流一满就 429，而 429 又被当永久 4xx 不重试 ⇒
 * 当天 `ANS 记账上报失败` 137 次、`ANS 质量账上报失败` 142 次，这些步骤的费用/质量数据永久丢失。
 *
 * 治法：入队（带 `dedupeKey`，同一任务同一 run 同一步同一类只报一次）→ 按批（默认 10 条）或
 * 定时（默认 30s）flush；单条失败**留在队首**等下一轮，最多 `maxAttempts` 次后如实丢弃并 warn。
 * 队列满（默认 500）时丢**最旧**一条并 warn——不静默丢、也不无限涨内存。
 *
 * 零 electron 依赖，rr 可直跑真实现（`post` 由调用方注入）。
 */
import { createLogger } from './logger.js';

const logger = createLogger('billing-reporter');

export interface BillingQueuedItem {
  /** ANS 路径，如 `/api/v1/billing/records`。 */
  path: string;
  /** 请求体（计费记录 / 质量记录）。 */
  body: Record<string, unknown>;
  /** 去重键：`taskId:runId:stepIndex:kind`。 */
  key: string;
  /** 已绑定身份的 post 实现（生产 = `AnsClient.post.bind(client)`）。 */
  post: (path: string, body: unknown) => Promise<unknown>;
  /** 已尝试次数（内部维护）。 */
  attempts?: number;
}

export interface BillingReporterOptions {
  /** 攒够多少条立即 flush（默认 10）。 */
  batchSize?: number;
  /** 定时 flush 间隔（默认 30s）。 */
  flushEveryMs?: number;
  /** 队列硬上限（默认 500）；超出丢最旧。 */
  maxQueue?: number;
  /** 单条最多尝试次数（默认 5）；超出丢弃并 warn。 */
  maxAttempts?: number;
  /** 单条上报等待上限（默认 2000ms）；超时按失败处理并保留重试。 */
  postTimeoutMs?: number;
  /** 单次 flush 的总时间预算（默认 10000ms）；超预算即停，未发的留在队列。 */
  maxFlushMs?: number;
}

export class BillingReporter {
  private queue: BillingQueuedItem[] = [];
  private seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly batchSize: number;
  private readonly flushEveryMs: number;
  private readonly maxQueue: number;
  private readonly maxAttempts: number;
  private readonly postTimeoutMs: number;
  private readonly maxFlushMs: number;

  constructor(opts: BillingReporterOptions = {}) {
    this.batchSize = Math.max(1, Math.floor(opts.batchSize ?? 10));
    this.flushEveryMs = Math.max(100, Math.floor(opts.flushEveryMs ?? 30_000));
    this.maxQueue = Math.max(1, Math.floor(opts.maxQueue ?? 500));
    this.maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 5));
    this.postTimeoutMs = Math.max(100, Math.floor(opts.postTimeoutMs ?? 2_000));
    this.maxFlushMs = Math.max(100, Math.floor(opts.maxFlushMs ?? 10_000));
  }

  /** 入队；重复 key 直接忽略（同一步同一类只报一次）。 */
  enqueue(item: BillingQueuedItem): void {
    if (!item.key || this.seen.has(item.key)) return;
    this.seen.add(item.key);
    this.queue.push({ ...item, attempts: 0 });
    while (this.queue.length > this.maxQueue) {
      const dropped = this.queue.shift();
      if (dropped) this.seen.delete(dropped.key);
      logger.warn({ dropped: dropped?.key, size: this.queue.length }, '计费队列已满，丢弃最旧一条');
    }
    if (this.queue.length >= this.batchSize) void this.flush();
    else this.arm();
  }

  /**
   * 取出并上报。单条失败即停（保序，避免后进先出打乱账）；
   * 返回 `{sent, pending}` 供 rr 做“请求数 ≤ 步数/5”的正向断言。
   */
  async flush(): Promise<{ sent: number; pending: number }> {
    if (this.flushing) return { sent: 0, pending: this.queue.length };
    this.flushing = true;
    this.clearTimer();
    const startedAt = Date.now();
    let sent = 0;
    try {
      while (this.queue.length > 0) {
        // 总预算：ANS 不可达时不能让收口/主循环被一串 7s 的失败重试拖死。
        if (Date.now() - startedAt >= this.maxFlushMs) {
          logger.warn({ queued: this.queue.length, spentMs: Date.now() - startedAt }, '计费 flush 达到时间预算，余量留待下一轮');
          break;
        }
        const item = this.queue[0]!;
        try {
          await Promise.race([
            item.post(item.path, item.body),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('billing post timeout')), this.postTimeoutMs)),
          ]);
          this.queue.shift();
          this.seen.delete(item.key);
          sent++;
        } catch (err) {
          item.attempts = (item.attempts ?? 0) + 1;
          if (item.attempts >= this.maxAttempts) {
            this.queue.shift();
            this.seen.delete(item.key);
            logger.warn(
              { key: item.key, attempts: item.attempts, error: (err as Error)?.message },
              '计费上报连续失败，已达上限并丢弃（该步账未上报）',
            );
            continue;
          }
          logger.warn(
            {
              key: item.key, attempts: item.attempts, error: (err as Error)?.message,
              model: item.body.model_id,
              tokens: (Number(item.body.tokens_in) || 0) + (Number(item.body.tokens_out) || 0),
            },
            '计费上报失败，保留待下一轮重试',
          );
          break;
        }
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) this.arm();
    }
    return { sent, pending: this.queue.length };
  }

  /** 进程/任务收口时强制 flush 一次（best-effort）。 */
  dispose(): Promise<{ sent: number; pending: number }> {
    this.clearTimer();
    return this.flush();
  }

  stats(): { queued: number; seen: number } {
    return { queued: this.queue.length, seen: this.seen.size };
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushEveryMs);
    // Node 下不阻止进程退出；Electron 主进程本来常驻，unref 也让“没有其他句柄时”能退。
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** 生产共享队列（一个进程只该有一份；key 含 taskId/runId，不会串任务）。 */
const shared = new BillingReporter();

export function enqueueBilling(item: BillingQueuedItem): void {
  shared.enqueue(item);
}

export async function flushBilling(): Promise<{ sent: number; pending: number }> {
  return shared.flush();
}

export function billingReporterStats(): { queued: number; seen: number } {
  return shared.stats();
}
