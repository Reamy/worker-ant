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

/** zx_20261116_3 M1「限」：路由桶。全局单桶会把记账/模型/管理/协议挤在一起（真事故 317 次 429）。 */
export type RateLimitClass = 'billing' | 'model' | 'mgmt' | 'a2a' | 'default';

/** 路径 → 桶。纯函数，rr 直跑；未知路径回落 `default`（不与管理桶混）。 */
export function rateLimitClassOf(pathname: string): RateLimitClass {
  const p = String(pathname || '/');
  if (p.startsWith('/api/v1/billing')) return 'billing';
  if (p.startsWith('/api/v1/models') || p.startsWith('/api/v1/gateway') || p.startsWith('/api/v1/optimal')) return 'model';
  if (p.startsWith('/api/v1/a2a') || p.startsWith('/api/v1/mcp') || p.startsWith('/mcp') || p.startsWith('/.well-known/agent.json')) return 'a2a';
  if (p.startsWith('/api/v1/')) return 'mgmt';
  return 'default';
}

export interface RateLimitEnvConfig {
  windowMs: number;
  limits: Record<RateLimitClass, number>;
}

/**
 * zx_20261116_3 M1：限流阈值从 env 读，非法值回落默认（不抛）。
 * `ANS_RATE_LIMIT_MAX` 是全局兜底；`ANS_RATE_LIMIT_<CLASS>` 可逐桶覆盖。
 */
export function readRateLimitEnv(env: NodeJS.ProcessEnv = process.env): RateLimitEnvConfig {
  const num = (key: string, dflt: number): number => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  };
  const globalMax = num('ANS_RATE_LIMIT_MAX', 240);
  return {
    windowMs: num('ANS_RATE_LIMIT_WINDOW_MS', 60_000),
    limits: {
      billing: num('ANS_RATE_LIMIT_BILLING', globalMax),
      model: num('ANS_RATE_LIMIT_MODEL', globalMax),
      mgmt: num('ANS_RATE_LIMIT_MGMT', 120),
      a2a: num('ANS_RATE_LIMIT_A2A', 60),
      default: num('ANS_RATE_LIMIT_DEFAULT', globalMax),
    },
  };
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
