// schedule/leader.ts — one ticker per origin and file (ADR-0074 §5, TASK-20261009 E2).
//
// Several tabs of one origin may hold the same `.snug` file open; only ONE of them schedules.
// The election rides the Web Locks API: a bounded probe (`ifAvailable`) says whether the name
// is free, and a follower parks a BLOCKING request behind the holder so it is promoted the
// moment the leader tab closes — the browser releases a tab's locks when it goes.
//
// Written fresh rather than on `packages/db/src/userdb/locks.ts` (feasibility F4): at an opaque
// origin (`about:srcdoc`, `file://`) `navigator.locks.request()` REJECTS with a SecurityError
// and never invokes the callback, and that module resolves only from inside the callback, so
// it hangs forever there. Here every answer the manager can give — a grant, a `null`, a
// rejection, a synchronous throw, or no answer at all — lands on the store, the last one by
// a `probeMs` race. Where locks are absent or refuse, THIS context leads and `canSeeSiblings`
// is false, so `hostHonesty()` can say that sibling tabs cannot be seen.
//
// The lock name is the caller's: `snug-scheduler:<file db uuid>`, so two files open in one
// origin elect independently and a file swap means a new election (an election is one-shot:
// `stop()` releases, and `start()` after it does nothing).

import { createStore, type Store } from '../state/store.js';

/** Why this context is (or is not) the leader. */
export type LeaderReason =
  /** The lock manager answered: leadership follows the lock. */
  | 'locks'
  /** No lock manager at all (node, a very old browser): single context by definition. */
  | 'no-locks'
  /** The manager rejected, threw, or never answered within the bound (opaque origin, `file://`). */
  | 'locks-refused';

export interface LeaderState {
  /** This context runs the scheduler. */
  leader: boolean;
  /** The lock manager works here, so a sibling tab would have been seen. */
  canSeeSiblings: boolean;
  reason: LeaderReason;
}

/** The one method of `navigator.locks` the election uses. */
export type LeaderLocks = Pick<LockManager, 'request'>;

export interface LeaderElectionOptions {
  /** The lock name — `snug-scheduler:<file db uuid>`. */
  name: string;
  /** The page's lock manager (`pageLocks()`); `undefined` means there is none. */
  locks?: LeaderLocks | undefined;
  /** How long the probe may stay unanswered before this context leads anyway. */
  probeMs?: number | undefined;
}

export interface LeaderElection {
  /** Probe, then hold or queue. Idempotent: the same promise every call; resolves once the state is known. */
  start(): Promise<void>;
  /** Release every held or queued lock and step down. Final — the election does not restart. */
  stop(): void;
  readonly state: Store<LeaderState>;
}

export const DEFAULT_PROBE_MS = 2_000;

/** The slice of `window` the guarded read looks at. */
export interface LocksHost {
  navigator?: { locks?: LeaderLocks | undefined } | undefined;
}

/**
 * `navigator.locks` where the page has one, else `undefined` — never a throw, in the manner of
 * `apps/host/src/safeStorage.ts`: hostile hosts answer storage reads with a SecurityError.
 */
export const pageLocks = (host: LocksHost = globalThis as unknown as LocksHost): LeaderLocks | undefined => {
  try {
    return host.navigator?.locks ?? undefined;
  } catch {
    return undefined;
  }
};

const LEADER_NO_LOCKS: LeaderState = { leader: true, canSeeSiblings: false, reason: 'no-locks' };
const LEADER_REFUSED: LeaderState = { leader: true, canSeeSiblings: false, reason: 'locks-refused' };
const LEADER_UNDER_LOCKS: LeaderState = { leader: true, canSeeSiblings: true, reason: 'locks' };
const FOLLOWER: LeaderState = { leader: false, canSeeSiblings: true, reason: 'locks' };

export function createLeaderElection(options: LeaderElectionOptions): LeaderElection {
  const { name, locks, probeMs = DEFAULT_PROBE_MS } = options;
  const state = createStore<LeaderState>({
    leader: false,
    canSeeSiblings: false,
    reason: locks === undefined ? 'no-locks' : 'locks',
  });

  /** Resolvers of the promises handed back from lock callbacks: resolving one releases that lock. */
  const holds = new Set<() => void>();
  let stopped = false;
  let started: Promise<void> | undefined;
  let settleStart: () => void = () => undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;

  const hold = (): Promise<void> =>
    new Promise<void>((release) => {
      holds.add(release);
    });

  /** A stopped election never changes its mind, whatever the manager says afterwards. */
  const become = (next: LeaderState): void => {
    if (!stopped) state.set(next);
  };

  const clearProbeTimer = (): void => {
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    probeTimer = undefined;
  };

  /** Held elsewhere: park a blocking request behind the holder — the promotion when it closes. */
  const follow = (manager: LeaderLocks): void => {
    become(FOLLOWER);
    let queued: Promise<unknown>;
    try {
      queued = manager.request(name, (lock) => {
        if (stopped || lock === null) return undefined; // our turn came too late: let it pass at once
        become(LEADER_UNDER_LOCKS);
        return hold();
      });
    } catch {
      become(LEADER_REFUSED);
      return;
    }
    // A manager that worked a moment ago and refuses now: the rule for refusal applies.
    Promise.resolve(queued).catch(() => {
      if (!state.get().leader) become(LEADER_REFUSED);
    });
  };

  /** `ifAvailable` under a `probeMs` race; an answer after the bound is still adopted. */
  const probe = (manager: LeaderLocks): void => {
    let answered = false;
    const answer = (next: LeaderState): void => {
      answered = true;
      clearProbeTimer();
      become(next);
      settleStart();
    };
    probeTimer = setTimeout(() => answer(LEADER_REFUSED), probeMs);
    let request: Promise<unknown>;
    try {
      request = manager.request(name, { ifAvailable: true }, (lock) => {
        if (stopped) return undefined;
        if (lock === null) {
          answered = true;
          clearProbeTimer();
          follow(manager);
          settleStart();
          return undefined;
        }
        answer(LEADER_UNDER_LOCKS);
        return hold(); // held until stop()
      });
    } catch {
      answer(LEADER_REFUSED);
      return;
    }
    Promise.resolve(request).catch(() => {
      if (!answered) answer(LEADER_REFUSED);
    });
  };

  return {
    state,
    start() {
      if (started !== undefined) return started;
      started = new Promise<void>((resolve) => {
        settleStart = resolve;
        if (stopped) {
          resolve();
          return;
        }
        if (locks === undefined) {
          state.set(LEADER_NO_LOCKS);
          resolve();
          return;
        }
        probe(locks);
      });
      return started;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearProbeTimer();
      for (const release of holds) release();
      holds.clear();
      settleStart();
      state.set({ ...state.get(), leader: false });
    },
  };
}
