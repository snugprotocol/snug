// Child-1 AC8 (TASK-20260803-userdb-core): single-writer Web Lock + BroadcastChannel
// invalidation seams, unit-tested via injected fakes (F12). Browser integration lands
// with the playground wiring (child 2).
import { describe, expect, it, vi } from 'vitest';
import { acquireUserDbWriterLock, createUserDbChannel, USERDB_LOCK_NAME } from '../locks.js';

type LockGrantedCallback = (lock: unknown) => Promise<unknown>;

/** Minimal navigator.locks fake: first requester holds; ifAvailable requesters get null. */
function fakeLocks() {
  let held = false;
  return {
    request: (_name: string, opts: { ifAvailable?: boolean }, cb: LockGrantedCallback): Promise<unknown> => {
      if (held && opts.ifAvailable === true) return cb(null);
      held = true;
      return cb({ name: _name });
    },
  };
}

describe('acquireUserDbWriterLock', () => {
  it('acquires when free and reports acquired=false when contended', async () => {
    const locks = fakeLocks();
    const first = await acquireUserDbWriterLock({ locks });
    expect(first.acquired).toBe(true);
    const second = await acquireUserDbWriterLock({ locks });
    expect(second.acquired).toBe(false);
    first.release();
  });

  it('falls back to acquired=true when no lock manager exists (single-context env)', async () => {
    const result = await acquireUserDbWriterLock({ locks: undefined });
    expect(result.acquired).toBe(true);
    result.release();
  });

  it('uses a stable lock name (spec of the single-writer rule)', () => {
    expect(USERDB_LOCK_NAME).toBe('snug-userdb');
  });
});

describe('createUserDbChannel', () => {
  it('posts invalidations to subscribers and unsubscribes cleanly', () => {
    const listeners = new Set<(ev: { data: unknown }) => void>();
    const factory = () => ({
      postMessage: (data: unknown) => listeners.forEach((l) => l({ data })),
      addEventListener: (_: string, l: (ev: { data: unknown }) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (ev: { data: unknown }) => void) => listeners.delete(l),
      close: () => listeners.clear(),
    });
    const channel = createUserDbChannel({ factory });
    const seen = vi.fn();
    const off = channel.onInvalidate(seen);
    channel.postInvalidate();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    channel.postInvalidate();
    expect(seen).toHaveBeenCalledTimes(1);
    channel.close();
  });

  it('degrades to a no-op when BroadcastChannel is unavailable', () => {
    const channel = createUserDbChannel({ factory: undefined });
    expect(() => {
      channel.postInvalidate();
      const off = channel.onInvalidate(() => undefined);
      off();
      channel.close();
    }).not.toThrow();
  });
});
