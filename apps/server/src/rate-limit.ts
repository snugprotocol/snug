// rate-limit.ts — simple per-key (per-IP) in-memory token bucket for /invoke.
// A generous cap, not auth: single-user OSS reference (hub auth is out of v1 scope).
// Buckets refilled back to full capacity are idle and carry no state worth keeping,
// so each take() sweeps them out — the IP map cannot grow unbounded.

import type { RateLimitConfig } from './config.js';

export interface RateLimiter {
  /** True if the caller may proceed; false when the bucket for `key` is empty. */
  take(key: string): boolean;
  /** Number of live (non-idle) buckets — observability/test seam. */
  size(): number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export function createRateLimiter(config: RateLimitConfig, now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>();

  const refill = (bucket: Bucket, at: number): void => {
    const elapsedSeconds = Math.max(0, (at - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(config.capacity, bucket.tokens + elapsedSeconds * config.refillPerSecond);
    bucket.lastRefillMs = at;
  };

  /** Evict every bucket refilled to full capacity (idle — indistinguishable from absent). */
  const sweep = (at: number): void => {
    for (const [key, bucket] of buckets) {
      refill(bucket, at);
      if (bucket.tokens >= config.capacity) buckets.delete(key);
    }
  };

  return {
    take(key) {
      const at = now();
      sweep(at);
      const bucket = buckets.get(key) ?? { tokens: config.capacity, lastRefillMs: at };
      refill(bucket, at);
      if (bucket.tokens < 1) {
        buckets.set(key, bucket);
        return false;
      }
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return true;
    },
    size() {
      return buckets.size;
    },
  };
}
