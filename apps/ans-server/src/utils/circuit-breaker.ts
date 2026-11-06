/**
 * 基于内存的断路器。
 * 当连续失败次数达到阈值时打开，经过冷却时间后进入半开状态。
 */

import { AppError, ErrorCode } from './errors.js';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitEntry {
  failures: number;
  lastFailureTime: number;
  state: CircuitState;
}

export class CircuitBreaker {
  private circuits = new Map<string, CircuitEntry>();
  private failureThreshold: number;
  private cooldownMs: number;

  constructor(failureThreshold = 5, cooldownMs = 30_000) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
  }

  /**
   * 在执行操作前检查断路器状态。打开则抛出AppError。
   */
  beforeCall(key: string): void {
    const entry = this.getOrCreate(key);
    if (entry.state === 'open') {
      if (Date.now() - entry.lastFailureTime > this.cooldownMs) {
        entry.state = 'half-open';
      } else {
        throw new AppError(ErrorCode.CIRCUIT_OPEN, `Circuit breaker open for ${key}`, 503);
      }
    }
  }

  /** 记录成功调用，关闭断路器 */
  onSuccess(key: string): void {
    const entry = this.getOrCreate(key);
    entry.failures = 0;
    entry.state = 'closed';
  }

  /** 记录失败调用，达阈值则打开断路器 */
  onFailure(key: string): void {
    const entry = this.getOrCreate(key);
    entry.failures++;
    entry.lastFailureTime = Date.now();
    if (entry.failures >= this.failureThreshold) {
      entry.state = 'open';
    }
  }

  getState(key: string): CircuitState {
    return this.getOrCreate(key).state;
  }

  private getOrCreate(key: string): CircuitEntry {
    let entry = this.circuits.get(key);
    if (!entry) {
      entry = { failures: 0, lastFailureTime: 0, state: 'closed' };
      this.circuits.set(key, entry);
    }
    return entry;
  }
}
