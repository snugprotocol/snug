/**
 * THE ORPHAN WATCH (TASK-20260818-sidecar-orphan-reap).
 *
 * The bug this pins: two helpers holding ONE WhatsApp session. WhatsApp allows a single live
 * connection per linked device, so a helper orphaned by an unclean shell exit and a helper
 * spawned by the next launch replace each other's stream forever
 * (`stream:error … conflict type=replaced`, observed live 2026-08-19 with pids 60490/50057).
 *
 * `shutdown()` on the Rust side covers the CLEAN exit. This covers the other one: a crash, a
 * `kill -9`, or a `tauri dev` rebuild leaves the helper alive with a dead parent, and nothing
 * ever tells it to go. The watch is what tells it.
 *
 * Everything here is injected — `getPpid` and the clock — because a test that forked a real
 * parent and killed it would be slow, flaky, and would prove the operating system works
 * rather than that this decision is right.
 */

import { describe, expect, it, vi } from 'vitest';
import { watchParent } from '../parent-watch.js';

/** Drive the watch's timer without waiting real seconds. */
function withFakeTimers(body: () => void): void {
  vi.useFakeTimers();
  try {
    body();
  } finally {
    vi.useRealTimers();
  }
}

describe('watchParent', () => {
  it('stays quiet while the parent is alive', () => {
    withFakeTimers(() => {
      const onOrphaned = vi.fn();
      watchParent({ getPpid: () => 4242, intervalMs: 1000, onOrphaned });

      vi.advanceTimersByTime(10_000);

      expect(onOrphaned).not.toHaveBeenCalled();
    });
  });

  it('fires when the ppid changes — the shell died and we were reparented', () => {
    withFakeTimers(() => {
      const onOrphaned = vi.fn();
      let ppid = 4242;
      watchParent({ getPpid: () => ppid, intervalMs: 1000, onOrphaned });

      vi.advanceTimersByTime(3000);
      expect(onOrphaned).not.toHaveBeenCalled();

      // launchd (pid 1) adopts the orphan; on a system with a subreaper it could be any
      // other pid — CHANGED is the signal, not the specific value.
      ppid = 1;
      vi.advanceTimersByTime(1000);

      expect(onOrphaned).toHaveBeenCalledTimes(1);
    });
  });

  it('fires ONCE, however long the orphan lingers', () => {
    withFakeTimers(() => {
      const onOrphaned = vi.fn();
      let ppid = 4242;
      watchParent({ getPpid: () => ppid, intervalMs: 1000, onOrphaned });

      ppid = 1;
      vi.advanceTimersByTime(60_000);

      // The handler runs an async close-and-exit. A second call mid-shutdown would race
      // its own cleanup — closing a closing server, exiting an exiting process.
      expect(onOrphaned).toHaveBeenCalledTimes(1);
    });
  });

  it('stops watching once stopped', () => {
    withFakeTimers(() => {
      const onOrphaned = vi.fn();
      let ppid = 4242;
      const stop = watchParent({ getPpid: () => ppid, intervalMs: 1000, onOrphaned });

      stop();
      ppid = 1;
      vi.advanceTimersByTime(10_000);

      expect(onOrphaned).not.toHaveBeenCalled();
    });
  });

  it('survives a getPpid that throws, and still catches the change afterwards', () => {
    withFakeTimers(() => {
      const onOrphaned = vi.fn();
      let mode: 'ok' | 'throw' | 'orphaned' = 'ok';
      watchParent({
        getPpid: () => {
          if (mode === 'throw') throw new Error('no such process');
          return mode === 'orphaned' ? 1 : 4242;
        },
        intervalMs: 1000,
        onOrphaned,
      });

      // A throwing probe must not kill the helper (it holds the user's session) and must
      // not be read as "the parent died" — an unreadable ppid is unknown, not orphaned.
      mode = 'throw';
      vi.advanceTimersByTime(5000);
      expect(onOrphaned).not.toHaveBeenCalled();

      mode = 'orphaned';
      vi.advanceTimersByTime(1000);
      expect(onOrphaned).toHaveBeenCalledTimes(1);
    });
  });

  it('does not hold the process open on its own', () => {
    withFakeTimers(() => {
      const unref = vi.fn();
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValue({ unref } as any);

      watchParent({ getPpid: () => 4242, intervalMs: 1000, onOrphaned: vi.fn() });

      // An un-unref'd interval would keep node alive forever, turning a helper that
      // finished its work into the very orphan this file exists to prevent.
      expect(unref).toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });
  });
});
