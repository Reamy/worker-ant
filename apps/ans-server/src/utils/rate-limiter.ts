/**
 * 基于内存的速率限制器。
 * 基于滑动窗口计数，支持按IP和API Key独立限流。
 */

import { AppError, ErrorCode } from './errors.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  windowMs?: number; // 时间窗口（毫秒）
  maxRequests?: number; // 窗口内最大请求数
}

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private windowMs: number;
  private maxRequests: number;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
  }

  /**
   * 检查是否超出速率限制。未超出返回void，超出抛出AppError。
   */
  check(key: string): void {
    this.cleanup();
    const entry = this.store.get(key);
    const now = Date.now();

    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw new AppError(ErrorCode.RATE_LIMITED, `Rate limit exceeded. Retry after ${retryAfter}s`, 429, {
        retryAfter,
      });
    }
  }

  /** 获取限流key，优先使用X-Api-Key，其次使用IP */
  getKey(apiKey: string | null, ip: string): string {
    return apiKey ?? ip;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) {
        this.store.delete(key);
      }
    }
  }
}
