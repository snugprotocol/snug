// scheduleTick.test.ts — TASK-20261009 E3 (ADR-0074 §5): the minute ticker.
//
// The clock is INJECTED and moved by hand beside vitest's fake timers, so the two can be pulled
// apart on purpose: a timer that fires with the clock hours ahead is exactly what a throttled
// or suspended tab looks like. Every assertion reads `at`/`expectedAt` off the clock — the
// mutation this suite exists to red is a ticker that counts fires (expectedAt = start + n
// minutes) or re-arms from the previous boundary (a burst after a long gap); the "jump the
// clock 3 hours" case fails either one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LATE_MS,
  MINUTE_MS,
  createTicker,
  nextMinuteBoundary,
  type Tick,
  type TickEventType,
  type Ticker,
  type TickerOptions,
} from '../schedule/tick.js';

/** 2026-10-09T15:42:30.500Z — well off any minute boundary. */
const T0 = Date.UTC(2026, 9, 9, 15, 42, 30, 500);
/** The boundary after T0. */
const B1 = Date.UTC(2026, 9, 9, 15, 43, 0, 0);
const HOUR_MS = 60 * MINUTE_MS;

interface Harness {
  ticker: Ticker;
  ticks: Tick[];
  /** Move the clock AND the fake timers together, like real time passing. */
  elapse(ms: number): void;
  /** Move only the clock — a suspended tab whose timers did not run. */
  jump(ms: number): void;
  dispatch(type: TickEventType): void;
  /** Listener registrations still live (added minus removed by the same reference). */
  live(): TickEventType[];
  setVisible(visible: boolean): void;
}

function harness(overrides: Partial<TickerOptions> = {}, withListeners = true): Harness {
  let clock = T0;
  let visible = true;
  const ticks: Tick[] = [];
  const listeners = new Map<TickEventType, Set<() => void>>();
  const removed: Array<readonly [TickEventType, () => void]> = [];
  const ticker = createTicker({
    now: () => clock,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    ...(withListeners
      ? {
          addEventListener: (type: TickEventType, listener: () => void): void => {
            const set = listeners.get(type) ?? new Set<() => void>();
            set.add(listener);
            listeners.set(type, set);
          },
          removeEventListener: (type: TickEventType, listener: () => void): void => {
            removed.push([type, listener]);
            listeners.get(type)?.delete(listener);
          },
          isVisible: () => visible,
        }
      : {}),
    onTick: (tick) => {
      ticks.push(tick);
    },
    ...overrides,
  });
  return {
    ticker,
    ticks,
    elapse(ms) {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    jump(ms) {
      clock += ms;
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    live: () => [...listeners.entries()].flatMap(([type, set]) => Array.from(set, () => type)),
    setVisible(next) {
      visible = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('nextMinuteBoundary', () => {
  it('is the first boundary strictly after the instant — a boundary itself maps to the next one', () => {
    expect(nextMinuteBoundary(T0)).toBe(B1);
    expect(nextMinuteBoundary(B1 - 1)).toBe(B1);
    expect(nextMinuteBoundary(B1)).toBe(B1 + MINUTE_MS);
  });
});

describe('createTicker — the minute timer', () => {
  it('fires once at the next boundary, with at and expectedAt read off the clock', () => {
    const h = harness();
    h.ticker.start();
    expect(h.ticker.nextFireAt()).toBe(B1);
    h.elapse(B1 - T0 - 1);
    expect(h.ticks).toEqual([]);
    h.elapse(1);
    expect(h.ticks).toEqual([{ kind: 'minute', at: B1, expectedAt: B1 }]);
  });

  it('re-arms from now(): a fire landing exactly on the boundary arms the NEXT one, never 1 ms later', () => {
    const h = harness();
    h.ticker.start();
    h.elapse(B1 - T0);
    expect(h.ticks).toHaveLength(1);
    expect(h.ticker.nextFireAt()).toBe(B1 + MINUTE_MS);
    h.elapse(1);
    expect(h.ticks).toHaveLength(1); // no 1 ms echo of the same boundary
    h.elapse(MINUTE_MS - 2);
    expect(h.ticks).toHaveLength(1);
    h.elapse(1);
    expect(h.ticks).toHaveLength(2);
    expect(h.ticks[1]).toEqual({ kind: 'minute', at: B1 + MINUTE_MS, expectedAt: B1 + MINUTE_MS });
  });

  it('runs on the timer alone when no listener seats are given', () => {
    const h = harness({}, false);
    h.ticker.start();
    h.elapse(B1 - T0);
    expect(h.ticks).toEqual([{ kind: 'minute', at: B1, expectedAt: B1 }]);
    expect(vi.getTimerCount()).toBe(1);
    h.ticker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fire delayed by at least lateMs is kind late and still names the boundary it was armed for', () => {
    const h = harness();
    h.ticker.start();
    h.jump(DEFAULT_LATE_MS); // the tab slept; the clock ran on while the timer waited
    h.elapse(B1 - T0); // the timer finally fires
    expect(h.ticks).toEqual([{ kind: 'late', at: B1 + DEFAULT_LATE_MS, expectedAt: B1 }]);
    expect(DEFAULT_LATE_MS).toBe(120_000);
  });

  it('one millisecond under lateMs is still an ordinary minute', () => {
    const h = harness({ lateMs: 5_000 });
    h.ticker.start();
    h.jump(4_999);
    h.elapse(B1 - T0);
    expect(h.ticks).toEqual([{ kind: 'minute', at: B1 + 4_999, expectedAt: B1 }]);
    h.jump(5_000);
    h.elapse(MINUTE_MS - 4_999);
    expect(h.ticks[1]?.kind).toBe('late');
  });

  it('jump the clock 3 hours between fires: exactly ONE fire, kind late, then the next boundary from now — no burst', () => {
    const h = harness();
    h.ticker.start();
    h.elapse(B1 - T0);
    expect(h.ticks).toEqual([{ kind: 'minute', at: B1, expectedAt: B1 }]);

    // The next timer is armed for B1 + 1 min. Before it runs, the clock moves three hours.
    h.jump(3 * HOUR_MS);
    h.elapse(MINUTE_MS);
    expect(h.ticks).toHaveLength(2);
    expect(h.ticks[1]).toEqual({ kind: 'late', at: B1 + 3 * HOUR_MS + MINUTE_MS, expectedAt: B1 + MINUTE_MS });

    // A ticker that counted fires, or re-armed from the missed boundary, would now catch up
    // through ~180 boundaries. The clock is the truth: the next fire is one minute from now.
    const resumedAt = B1 + 3 * HOUR_MS + MINUTE_MS;
    expect(h.ticker.nextFireAt()).toBe(resumedAt + MINUTE_MS);
    h.elapse(MINUTE_MS - 1);
    expect(h.ticks).toHaveLength(2);
    h.elapse(1);
    expect(h.ticks).toHaveLength(3);
    expect(h.ticks[2]).toEqual({ kind: 'minute', at: resumedAt + MINUTE_MS, expectedAt: resumedAt + MINUTE_MS });
  });

  it('an onTick that throws still leaves the ticker armed for the next boundary', () => {
    const h = harness({
      onTick: () => {
        throw new Error('reconcile exploded');
      },
    });
    h.ticker.start();
    expect(() => h.elapse(B1 - T0)).toThrow('reconcile exploded');
    expect(h.ticker.nextFireAt()).toBe(B1 + MINUTE_MS);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stop() called from inside onTick does not re-arm', () => {
    let ticker: Ticker | undefined;
    let fires = 0;
    const h = harness({
      onTick: () => {
        fires += 1;
        ticker?.stop();
      },
    });
    ticker = h.ticker;
    h.ticker.start();
    h.elapse(B1 - T0);
    expect(fires).toBe(1);
    expect(h.ticker.nextFireAt()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createTicker — wake events', () => {
  it('visibilitychange emits visible only when isVisible() answers true, and re-arms from now', () => {
    const h = harness();
    h.ticker.start();
    h.setVisible(false);
    h.dispatch('visibilitychange');
    expect(h.ticks).toEqual([]);
    expect(h.ticker.nextFireAt()).toBe(B1);

    h.jump(2 * HOUR_MS); // hidden for two hours; the timer for B1 never ran
    h.setVisible(true);
    h.dispatch('visibilitychange');
    expect(h.ticks).toEqual([{ kind: 'visible', at: T0 + 2 * HOUR_MS }]);
    expect(h.ticker.nextFireAt()).toBe(nextMinuteBoundary(T0 + 2 * HOUR_MS));
    expect(vi.getTimerCount()).toBe(1); // the stale timer was cancelled, not stacked
  });

  it('focus and online each emit their own kind with no expectedAt', () => {
    const h = harness();
    h.ticker.start();
    h.jump(10);
    h.dispatch('focus');
    h.jump(10);
    h.dispatch('online');
    expect(h.ticks).toEqual([
      { kind: 'focus', at: T0 + 10 },
      { kind: 'online', at: T0 + 20 },
    ]);
    expect(h.ticks.every((tick) => !('expectedAt' in tick))).toBe(true);
  });

  it('treats every visibilitychange as visible when no isVisible reader is given', () => {
    const h = harness({ isVisible: undefined });
    h.ticker.start();
    h.dispatch('visibilitychange');
    expect(h.ticks).toEqual([{ kind: 'visible', at: T0 }]);
  });

  it('stop() clears the timer and removes exactly the listeners it added', () => {
    const h = harness();
    h.ticker.start();
    expect(h.live().sort()).toEqual(['focus', 'online', 'visibilitychange']);
    h.ticker.stop();
    expect(h.live()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ticker.nextFireAt()).toBeUndefined();

    h.elapse(10 * MINUTE_MS);
    h.dispatch('focus');
    h.dispatch('online');
    h.dispatch('visibilitychange');
    expect(h.ticks).toEqual([]);
    h.ticker.stop(); // twice is fine
  });

  it('start() is idempotent: one timer, one listener per event, one fire per boundary', () => {
    const h = harness();
    h.ticker.start();
    h.ticker.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(h.live()).toHaveLength(3);
    h.elapse(B1 - T0);
    expect(h.ticks).toHaveLength(1);
    h.dispatch('focus');
    expect(h.ticks).toHaveLength(2);
  });

  it('events before start() or after stop() emit nothing', () => {
    const h = harness();
    h.dispatch('focus');
    expect(h.ticks).toEqual([]);
    h.ticker.start();
    h.ticker.stop();
    h.dispatch('online');
    expect(h.ticks).toEqual([]);
  });
});
