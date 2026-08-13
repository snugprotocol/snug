// Close-requested flush (ADR-0021 §5; whole-surface review finding 4).
//
// ADR-0021 promised this and it was never built: desktop persistence rested on a
// 250ms debounce whose final write could not survive a window close. The invariant
// under test is the one that makes the feature safe to ship — `done()` is called on
// EVERY path, so a slow, broken, or wedged flush can never leave the user with a
// window that will not close.

import { describe, expect, it, vi } from 'vitest';

import { runCloseFlush } from '../close-flush.js';

describe('runCloseFlush', () => {
  it('flushes, then signals done — the happy path preserves the last write', async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push('flush');
    });
    const done = vi.fn(async () => {
      order.push('done');
    });

    const outcome = await runCloseFlush({ flush, done });

    expect(outcome).toBe('flushed');
    expect(order, 'the flush must complete BEFORE the window is allowed to close').toEqual([
      'flush',
      'done',
    ]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a REJECTED flush still closes the window', async () => {
    const done = vi.fn(async () => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await runCloseFlush({
      flush: () => Promise.reject(new Error('disk full')),
      done,
    });

    expect(outcome).toBe('failed');
    expect(done, 'a failed flush must never trap the user in an unclosable window').toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('a HUNG flush closes the window once the budget expires', async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn(async () => {});
      // Never settles — the wedged-sql.js case.
      const pending = runCloseFlush({ flush: () => new Promise<void>(() => {}), done, budgetMs: 2_000 });

      expect(done, 'nothing closes before the budget').not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await pending).toBe('timeout');
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a flush that finishes inside the budget does not wait it out', async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn(async () => {});
      const pending = runCloseFlush({
        flush: () => new Promise<void>((r) => setTimeout(r, 50)),
        done,
        budgetMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(50);

      expect(await pending, 'the close must not linger for the full budget').toBe('flushed');
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls done exactly once even when the flush settles right at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn(async () => {});
      const pending = runCloseFlush({
        flush: () => new Promise<void>((r) => setTimeout(r, 1_000)),
        done,
        budgetMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      await pending;

      expect(done, 'a double close_flush_done would destroy an already-gone window').toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
