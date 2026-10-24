import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../utils/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows requests within limit', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
    for (let i = 0; i < 5; i++) {
      expect(() => limiter.check('test-key')).not.toThrow();
    }
  });

  it('blocks requests exceeding limit', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    limiter.check('key');
    limiter.check('key');
    expect(() => limiter.check('key')).toThrow('Rate limit exceeded');
  });

  it('uses API key as priority key', () => {
    const limiter = new RateLimiter();
    expect(limiter.getKey('api-key-123', '10.0.0.1')).toBe('api-key-123');
  });

  it('falls back to IP when no API key', () => {
    const limiter = new RateLimiter();
    expect(limiter.getKey(null, '10.0.0.1')).toBe('10.0.0.1');
  });
});
