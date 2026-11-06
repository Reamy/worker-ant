import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('allows calls in closed state', () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(() => cb.beforeCall('svc')).not.toThrow();
  });

  it('opens after threshold failures', () => {
    const cb = new CircuitBreaker(2, 60_000);
    cb.onFailure('svc');
    cb.onFailure('svc');
    expect(() => cb.beforeCall('svc')).toThrow('Circuit breaker open');
  });

  it('closes after success', () => {
    const cb = new CircuitBreaker(2, 60_000);
    cb.onFailure('svc');
    cb.onSuccess('svc');
    expect(() => cb.beforeCall('svc')).not.toThrow();
  });
});
