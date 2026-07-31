import { describe, expect, it } from 'vitest';

import { createRateLimiter } from '../rate-limit.js';

describe('createRateLimiter', () => {
  it('allows up to capacity, then refuses, then refills over time', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1 }, () => t);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
    t = 1000; // one token refilled
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
  });

  it('evicts idle buckets once refilled to full capacity, so the IP map cannot grow unbounded', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1 }, () => t);
    limiter.take('a');
    limiter.take('b');
    expect(limiter.size()).toBe(2);
    t = 10_000; // both fully refilled — idle
    limiter.take('c'); // sweep on access
    expect(limiter.size()).toBe(1); // only 'c' remains
  });

  it('never evicts depleted buckets prematurely (a rate-limited caller stays limited)', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0 }, () => t);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    t = 60_000; // refillPerSecond 0 — no refill, no eviction
    expect(limiter.take('a')).toBe(false);
    expect(limiter.size()).toBe(2);
  });
});
