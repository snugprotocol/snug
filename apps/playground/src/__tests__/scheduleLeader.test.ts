// scheduleLeader.test.ts — TASK-20261009 E2 (ADR-0074 §5): one ticker per origin and file.
//
// The election is driven through a hand-written Web Locks fake that behaves like the browser's
// manager: it decides order at request time, invokes the callback on a microtask, answers
// `null` to an `ifAvailable` request for a held name, queues a blocking request, and releases
// when what the callback returned settles. Three hostile managers stand in for the places
// feasibility F4 measured: one that REJECTS without ever invoking the callback (an opaque
// origin — the shape `packages/db/src/userdb/locks.ts` hangs on), one that throws on the call,
// and one that never settles at all. Every case runs under fake timers so the probe bound is
// proven, not assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROBE_MS,
  createLeaderElection,
  pageLocks,
  type LeaderLocks,
  type LeaderState,
} from '../schedule/leader.js';

type Callback<T> = (lock: Lock | null) => T;

interface FakeLocks extends LeaderLocks {
  isHeld(name: string): boolean;
  /** Blocking requests waiting on the name, in grant order. */
  queued(name: string): number;
  /** Every name ever requested, in order — the lock name must be the caller's verbatim. */
  readonly requested: string[];
}

/** A LockManager the way the browser runs one: order decided synchronously, callbacks on a microtask. */
function createFakeLocks(): FakeLocks {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const requested: string[] = [];

  const release = (name: string): void => {
    held.delete(name);
    const next = waiting.get(name)?.shift();
    if (next) next();
  };

  const grant = <T>(name: string, callback: Callback<T>): Promise<T> => {
    held.add(name);
    return Promise.resolve().then(() => {
      const settle = (): void => release(name);
      let result: T;
      try {
        result = callback({ name, mode: 'exclusive' });
      } catch (error) {
        settle();
        throw error;
      }
      Promise.resolve(result).then(settle, settle);
      return result;
    });
  };

  function request<T>(name: string, callback: Callback<T>): Promise<T>;
  function request<T>(name: string, options: LockOptions, callback: Callback<T>): Promise<T>;
  function request<T>(name: string, first: LockOptions | Callback<T>, second?: Callback<T>): Promise<T> {
    requested.push(name);
    const options = typeof first === 'function' ? {} : first;
    const callback = typeof first === 'function' ? first : second;
    if (callback === undefined) throw new TypeError('request() needs a callback');
    if (!held.has(name)) return grant(name, callback);
    if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
    return new Promise<T>((resolve, reject) => {
      const queue = waiting.get(name) ?? [];
      queue.push(() => {
        grant(name, callback).then(resolve, reject);
      });
      waiting.set(name, queue);
    });
  }

  return {
    request,
    requested,
    isHeld: (name) => held.has(name),
    queued: (name) => waiting.get(name)?.length ?? 0,
  };
}

/** A manager whose `request` REJECTS without invoking the callback — the opaque-origin shape. */
const rejectingLocks = (): LeaderLocks & { calls: number } => {
  const manager = {
    calls: 0,
    request: (): Promise<never> => {
      manager.calls += 1;
      return Promise.reject(new DOMException('The request is not allowed', 'SecurityError'));
    },
  };
  return manager as unknown as LeaderLocks & { calls: number };
};

/** A manager whose `request` throws synchronously. */
const throwingLocks = (): LeaderLocks =>
  ({
    request: (): Promise<never> => {
      throw new DOMException('The request is not allowed', 'SecurityError');
    },
  }) as unknown as LeaderLocks;

/** A manager whose `request` never settles and never invokes the callback. */
const hangingLocks = (): LeaderLocks =>
  ({ request: (): Promise<never> => new Promise<never>(() => undefined) }) as unknown as LeaderLocks;

/** A manager the test answers by hand, so a reply — a grant, a null or a rejection — can arrive AFTER the probe bound. */
function deferredLocks(): LeaderLocks & { answer(lock: Lock | null): void; reject(): void } {
  let pending: Callback<unknown> | undefined;
  let rejectRequest: ((reason: unknown) => void) | undefined;
  const manager = {
    request: (_name: string, _options: unknown, callback?: Callback<unknown>): Promise<unknown> => {
      pending = typeof _options === 'function' ? (_options as Callback<unknown>) : callback;
      return new Promise<unknown>((_resolve, reject) => {
        rejectRequest = reject;
      });
    },
    answer: (lock: Lock | null): void => {
      if (pending === undefined) throw new Error('nothing to answer');
      pending(lock);
    },
    reject: (): void => {
      if (rejectRequest === undefined) throw new Error('nothing to reject');
      rejectRequest(new DOMException('The request is not allowed', 'SecurityError'));
    },
  };
  return manager as unknown as LeaderLocks & { answer(lock: Lock | null): void; reject(): void };
}

/**
 * A manager whose name is HELD elsewhere (the probe answers null) and whose parked blocking
 * requests REJECT asynchronously `rejections` times before one parks for real — granted by
 * `release()`. A `throwOnPark` manager throws synchronously on the blocking request instead.
 */
function flakyHeldLocks(rejections: number, throwOnPark = false): LeaderLocks & { release(): void; blocking: number } {
  let grant: (() => void) | undefined;
  const manager = {
    blocking: 0,
    release: (): void => grant?.(),
    request: (name: string, first: unknown, second?: unknown): Promise<unknown> => {
      const options = (typeof first === 'function' ? {} : first) as LockOptions;
      const callback = (typeof first === 'function' ? first : second) as Callback<unknown>;
      if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
      manager.blocking += 1;
      if (throwOnPark) throw new DOMException('The request is not allowed', 'SecurityError');
      if (manager.blocking <= rejections) return Promise.reject(new DOMException('The request is not allowed', 'SecurityError'));
      return new Promise((resolve) => {
        grant = () => resolve(callback({ name, mode: 'exclusive' }));
      });
    },
  };
  return manager as unknown as LeaderLocks & { release(): void; blocking: number };
}

/** Wait on a condition across microtasks — never on a fixed delay (vitest.config.ts). */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`never happened: ${what}`);
}

const NAME = 'snug-scheduler:1f0b8a12-7c3d-4e2a-9f11-0a2b3c4d5e6f';
const LEADER_UNDER_LOCKS: LeaderState = { leader: true, canSeeSiblings: true, reason: 'locks' };
const FOLLOWER: LeaderState = { leader: false, canSeeSiblings: true, reason: 'locks' };
/** The probe is still out past its bound: not leading, siblings unknown (S9). */
const UNANSWERED: LeaderState = { leader: false, canSeeSiblings: false, reason: 'locks-pending' };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pageLocks — the guarded read of navigator.locks', () => {
  it('answers undefined where there is no navigator, no locks seat, or a throwing getter', () => {
    expect(pageLocks({})).toBeUndefined();
    expect(pageLocks({ navigator: {} })).toBeUndefined();
    expect(pageLocks({ navigator: { locks: undefined } })).toBeUndefined();
    const hostile = {
      get navigator(): never {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(pageLocks(hostile)).toBeUndefined();
  });

  it('hands back the page manager itself where one exists', () => {
    const locks = createFakeLocks();
    expect(pageLocks({ navigator: { locks } })).toBe(locks);
  });
});

describe('createLeaderElection — no lock manager', () => {
  it('is the leader at once, cannot see siblings, reason no-locks — without arming any timer', async () => {
    const election = createLeaderElection({ name: NAME, locks: undefined });
    expect(election.state.get()).toEqual({ leader: false, canSeeSiblings: false, reason: 'no-locks' });
    await election.start();
    expect(election.state.get()).toEqual({ leader: true, canSeeSiblings: false, reason: 'no-locks' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createLeaderElection — a manager that refuses', () => {
  it('leads with reason locks-refused when request() rejects, settling before the probe bound', async () => {
    const locks = rejectingLocks();
    const election = createLeaderElection({ name: NAME, locks });
    await election.start(); // no timer advanced: the rejection alone settles it
    expect(election.state.get()).toEqual({ leader: true, canSeeSiblings: false, reason: 'locks-refused' });
    expect(locks.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0); // the probe timer was cleared, not left to fire
  });

  it('leads with reason locks-refused when request() throws synchronously', async () => {
    const election = createLeaderElection({ name: NAME, locks: throwingLocks() });
    await election.start();
    expect(election.state.get()).toEqual({ leader: true, canSeeSiblings: false, reason: 'locks-refused' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a probe unanswered at probeMs settles start() as a FOLLOWER (locks-pending) — a mere timeout never makes a second leader (S9)', async () => {
    const election = createLeaderElection({ name: NAME, locks: hangingLocks(), probeMs: 2_000 });
    let settled = false;
    void election.start().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    expect(election.state.get().leader).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(election.state.get()).toEqual(UNANSWERED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(election.state.get()).toEqual(UNANSWERED); // and stays so until the manager speaks
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults the probe bound to 2 s', async () => {
    const election = createLeaderElection({ name: NAME, locks: hangingLocks() });
    void election.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_PROBE_MS - 1);
    expect(election.state.get()).toEqual({ leader: false, canSeeSiblings: false, reason: 'locks' });
    await vi.advanceTimersByTimeAsync(1);
    expect(election.state.get()).toEqual(UNANSWERED);
    expect(DEFAULT_PROBE_MS).toBe(2_000);
  });

  it('stop() during a hanging probe settles start(), clears the timer and never leads', async () => {
    const election = createLeaderElection({ name: NAME, locks: hangingLocks() });
    const started = election.start();
    election.stop();
    await started;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_PROBE_MS);
    expect(election.state.get().leader).toBe(false);
  });

  it('adopts a probe answer that arrives after the bound: a late grant leads under locks', async () => {
    const locks = deferredLocks();
    const election = createLeaderElection({ name: NAME, locks, probeMs: 100 });
    void election.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(election.state.get()).toEqual(UNANSWERED);
    locks.answer({ name: NAME, mode: 'exclusive' });
    await until(() => election.state.get().leader, 'late grant adopted');
    expect(election.state.get()).toEqual(LEADER_UNDER_LOCKS);
  });

  it('adopts a probe answer that arrives after the bound: a late null follows (and parks the promotion request)', async () => {
    const locks = deferredLocks();
    const election = createLeaderElection({ name: NAME, locks, probeMs: 100 });
    void election.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(election.state.get()).toEqual(UNANSWERED);
    locks.answer(null);
    await until(() => election.state.get().reason === 'locks', 'late null adopted');
    expect(election.state.get()).toEqual(FOLLOWER);
  });

  it('adopts a probe answer that arrives after the bound: a late REJECTION leads with locks-refused — the manager, not the clock, said no', async () => {
    const locks = deferredLocks();
    const election = createLeaderElection({ name: NAME, locks, probeMs: 100 });
    void election.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(election.state.get()).toEqual(UNANSWERED);
    locks.reject();
    await until(() => election.state.get().leader, 'late rejection adopted');
    expect(election.state.get()).toEqual({ leader: true, canSeeSiblings: false, reason: 'locks-refused' });
  });
});

describe('createLeaderElection — a parked promotion request that fails (S9)', () => {
  it('a parked request rejected asynchronously keeps this context a FOLLOWER and parks again after probeMs — never a second leader', async () => {
    const locks = flakyHeldLocks(2);
    const election = createLeaderElection({ name: NAME, locks, probeMs: 500 });
    await election.start();
    expect(election.state.get()).toEqual(FOLLOWER);
    expect(locks.blocking).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(election.state.get()).toEqual(FOLLOWER); // the first rejection landed: still a follower
    await vi.advanceTimersByTimeAsync(500);
    expect(locks.blocking).toBe(2); // parked again, after the bound
    await vi.advanceTimersByTimeAsync(500);
    expect(locks.blocking).toBe(3); // the third one holds
    expect(election.state.get()).toEqual(FOLLOWER);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(locks.blocking).toBe(3); // a request that parks is not retried
    locks.release();
    await until(() => election.state.get().leader, 'promoted when the holder released');
    expect(election.state.get()).toEqual(LEADER_UNDER_LOCKS);
  });

  it('stop() while a retry is pending clears the timer and never parks again', async () => {
    const locks = flakyHeldLocks(5);
    const election = createLeaderElection({ name: NAME, locks, probeMs: 500 });
    await election.start();
    await vi.advanceTimersByTimeAsync(0);
    election.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(locks.blocking).toBe(1);
    expect(election.state.get().leader).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a parked request that THROWS synchronously still leads with locks-refused — a manager that worked a moment ago and refuses now', async () => {
    const locks = flakyHeldLocks(0, true);
    const election = createLeaderElection({ name: NAME, locks });
    await election.start();
    expect(election.state.get()).toEqual({ leader: true, canSeeSiblings: false, reason: 'locks-refused' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createLeaderElection — a working manager', () => {
  it('takes a free lock: leader, can see siblings, reason locks — and keeps holding it', async () => {
    const locks = createFakeLocks();
    const election = createLeaderElection({ name: NAME, locks });
    expect(election.state.get()).toEqual({ leader: false, canSeeSiblings: false, reason: 'locks' });
    await election.start();
    expect(election.state.get()).toEqual(LEADER_UNDER_LOCKS);
    expect(locks.isHeld(NAME)).toBe(true);
    expect(locks.requested).toEqual([NAME]); // the probe is one request, under the caller's name verbatim
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_PROBE_MS);
    expect(locks.isHeld(NAME)).toBe(true); // still held: the callback's promise resolves only on stop()
  });

  it('follows when the name is held elsewhere and queues ONE blocking request for promotion', async () => {
    const locks = createFakeLocks();
    const other = createLeaderElection({ name: NAME, locks });
    await other.start();
    const election = createLeaderElection({ name: NAME, locks });
    await election.start();
    expect(election.state.get()).toEqual(FOLLOWER);
    expect(locks.queued(NAME)).toBe(1);
    expect(locks.requested).toEqual([NAME, NAME, NAME]); // other's probe, our probe, our blocking request
    expect(vi.getTimerCount()).toBe(0);
  });

  it('promotes the follower when the holder releases', async () => {
    const locks = createFakeLocks();
    const holder = createLeaderElection({ name: NAME, locks });
    await holder.start();
    const follower = createLeaderElection({ name: NAME, locks });
    await follower.start();
    expect(follower.state.get().leader).toBe(false);

    holder.stop();
    await until(() => follower.state.get().leader, 'promotion after release');
    expect(follower.state.get()).toEqual(LEADER_UNDER_LOCKS);
    expect(holder.state.get().leader).toBe(false);
    expect(locks.isHeld(NAME)).toBe(true);
    expect(locks.queued(NAME)).toBe(0);
  });

  it('stop() releases the lock so a fresh instance can win it', async () => {
    const locks = createFakeLocks();
    const first = createLeaderElection({ name: NAME, locks });
    await first.start();
    first.stop();
    expect(first.state.get()).toEqual({ leader: false, canSeeSiblings: true, reason: 'locks' });
    await until(() => !locks.isHeld(NAME), 'release on stop');

    const second = createLeaderElection({ name: NAME, locks });
    await second.start();
    expect(second.state.get()).toEqual(LEADER_UNDER_LOCKS);
  });

  it('a follower stopped while queued never takes the lock when its turn comes', async () => {
    const locks = createFakeLocks();
    const holder = createLeaderElection({ name: NAME, locks });
    await holder.start();
    const quitter = createLeaderElection({ name: NAME, locks });
    await quitter.start();
    const next = createLeaderElection({ name: NAME, locks });
    await next.start();
    expect(locks.queued(NAME)).toBe(2);

    quitter.stop();
    holder.stop();
    await until(() => next.state.get().leader, 'the queue skips the stopped follower');
    expect(quitter.state.get().leader).toBe(false);
    expect(next.state.get()).toEqual(LEADER_UNDER_LOCKS);
  });

  it('start() is idempotent: a second call issues no second request and returns the same promise', async () => {
    const locks = createFakeLocks();
    const election = createLeaderElection({ name: NAME, locks });
    const a = election.start();
    const b = election.start();
    expect(b).toBe(a);
    await a;
    expect(election.state.get()).toEqual(LEADER_UNDER_LOCKS);
    expect(locks.requested).toEqual([NAME]);
    await election.start();
    expect(locks.requested).toEqual([NAME]);
  });

  it('start() after stop() does nothing — an election is one-shot', async () => {
    const locks = createFakeLocks();
    const election = createLeaderElection({ name: NAME, locks });
    await election.start();
    election.stop();
    await until(() => !locks.isHeld(NAME), 'release on stop');
    await election.start();
    expect(election.state.get().leader).toBe(false);
    expect(locks.isHeld(NAME)).toBe(false);
    expect(locks.requested).toEqual([NAME]);
  });

  it('two instances on one manager: exactly one leader at every moment, through a hand-over', async () => {
    const locks = createFakeLocks();
    const a = createLeaderElection({ name: NAME, locks });
    const b = createLeaderElection({ name: NAME, locks });
    const leaders = (): number => Number(a.state.get().leader) + Number(b.state.get().leader);
    let maxLeaders = 0;
    const observe = (): void => {
      maxLeaders = Math.max(maxLeaders, leaders());
    };
    a.state.subscribe(observe);
    b.state.subscribe(observe);

    await Promise.all([a.start(), b.start()]);
    expect(leaders()).toBe(1);
    expect(a.state.get().leader).toBe(true);
    expect(b.state.get()).toEqual(FOLLOWER);

    a.stop();
    await until(() => b.state.get().leader, 'b promoted');
    expect(leaders()).toBe(1);

    b.stop();
    await until(() => !locks.isHeld(NAME), 'released');
    expect(leaders()).toBe(0);
    expect(maxLeaders).toBe(1);
  });

  it('the stopped state keeps what it learned: leader false, siblings still visible', async () => {
    const locks = createFakeLocks();
    const election = createLeaderElection({ name: NAME, locks });
    await election.start();
    election.stop();
    election.stop(); // twice is fine
    expect(election.state.get()).toEqual({ ...LEADER_UNDER_LOCKS, leader: false });
  });
});
