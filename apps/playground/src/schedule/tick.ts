// schedule/tick.ts — the minute ticker (ADR-0074 §5, TASK-20261009 E3).
//
// A timer re-armed to the next minute boundary FROM THE WALL CLOCK after every fire. Ticks are
// hints; the clock is the truth. A hidden tab throttles timers to about one a minute and a
// suspended one runs none at all, so the ticker never counts fires and never arms from the
// boundary it was waiting for — after a long gap it reports ONE `late` tick and arms a minute
// from now, and `reconcile()` derives what is due from the clock. `visibilitychange` (when the
// page became visible), `focus` and `online` each report their own kind, because each is a
// moment the clock may have jumped while the timer slept.
//
// Everything is injected: the clock, the timer pair and the listener pair — so a test moves
// the clock and the timers apart on purpose, and the composer routes `visibilitychange` to
// `document` and the other two to `window`.

export const MINUTE_MS = 60_000;
/** A fire this far past its boundary is reported as `late` rather than `minute`. */
export const DEFAULT_LATE_MS = 120_000;

export type TickKind = 'minute' | 'late' | 'visible' | 'focus' | 'online';
/** The wake events the ticker listens for, by their DOM names. */
export type TickEventType = 'visibilitychange' | 'focus' | 'online';

export interface Tick {
  kind: TickKind;
  /** The clock when the tick fired. */
  at: number;
  /** The minute boundary the timer was armed for — `minute` and `late` ticks only. */
  expectedAt?: number;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface TickerOptions {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  addEventListener?: ((type: TickEventType, listener: () => void) => void) | undefined;
  removeEventListener?: ((type: TickEventType, listener: () => void) => void) | undefined;
  /** Read on `visibilitychange`; the tick is emitted only when it answers true. Absent: every change counts. */
  isVisible?: (() => boolean) | undefined;
  lateMs?: number | undefined;
  onTick: (tick: Tick) => void;
}

export interface Ticker {
  /** Arm the timer and attach the listeners. Idempotent. */
  start(): void;
  /** Clear the timer and detach the listeners. Idempotent. */
  stop(): void;
  /** The boundary the timer is armed for; `undefined` when stopped. */
  nextFireAt(): number | undefined;
}

/** The first minute boundary strictly after `at` — an instant on a boundary maps to the next one. */
export const nextMinuteBoundary = (at: number): number => Math.floor(at / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

const WAKE_EVENTS: ReadonlyArray<readonly [TickEventType, 'visible' | 'focus' | 'online']> = [
  ['visibilitychange', 'visible'],
  ['focus', 'focus'],
  ['online', 'online'],
];

export function createTicker(options: TickerOptions): Ticker {
  const {
    now,
    setTimeout: arm,
    clearTimeout: disarm,
    addEventListener,
    removeEventListener,
    isVisible = () => true,
    lateMs = DEFAULT_LATE_MS,
    onTick,
  } = options;

  let running = false;
  let timer: TimerHandle | undefined;
  let expectedAt: number | undefined;
  const attached: Array<readonly [TickEventType, () => void]> = [];

  const clearTimer = (): void => {
    if (timer !== undefined) disarm(timer);
    timer = undefined;
    expectedAt = undefined;
  };

  /** Always from the clock as it reads NOW — never from the boundary just missed. */
  const armNext = (): void => {
    clearTimer();
    const at = now();
    const boundary = nextMinuteBoundary(at);
    expectedAt = boundary;
    timer = arm(fire, Math.max(1, boundary - at));
  };

  /** Emit, then re-arm — even when the handler throws; not when it stopped the ticker. */
  const emit = (tick: Tick): void => {
    try {
      onTick(tick);
    } finally {
      if (running) armNext();
    }
  };

  function fire(): void {
    const boundary = expectedAt;
    timer = undefined;
    expectedAt = undefined;
    if (!running || boundary === undefined) return;
    const at = now();
    emit({ kind: at - boundary >= lateMs ? 'late' : 'minute', at, expectedAt: boundary });
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (addEventListener !== undefined) {
        for (const [type, kind] of WAKE_EVENTS) {
          const listener = (): void => {
            if (!running) return;
            if (type === 'visibilitychange' && !isVisible()) return;
            emit({ kind, at: now() });
          };
          addEventListener(type, listener);
          attached.push([type, listener]);
        }
      }
      armNext();
    },
    stop() {
      if (!running) return;
      running = false;
      clearTimer();
      if (removeEventListener !== undefined) {
        for (const [type, listener] of attached) removeEventListener(type, listener);
      }
      attached.length = 0;
    },
    nextFireAt: () => expectedAt,
  };
}
