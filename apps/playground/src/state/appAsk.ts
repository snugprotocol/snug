// state/appAsk.ts — the app-ask intake ladder (ADR-0074 §4; ADR-0075 §4): the ONE place a
// running app's ask to the user is rate-limited, held to one pending per frame generation, and
// silenced by the user's earlier answers. EXTRACTED from `schedule/scheduleRequest.ts`
// (TASK-20261010-cross-app-access W3) so the schedule suggestion and the access ask run the same
// rungs — two copies of a guard drift apart, and the drift is where an app slips through.
//
// THE RUNGS, in the order `consume` runs them (each also callable alone, because the schedule
// intake interleaves its own parse, sender and cap checks between them):
//   - the RATE LIMIT, keyed on the HOST-assigned app id (never anything the app rolls): one
//     entry per app (`{ generation, at }` — bounded by the apps a page shows, however many
//     generations come and go). By `generation` a new frame generation is a new instance with
//     its own window (the schedule's rule); by `app` it is not — a remount, like a re-announce,
//     cannot mint a fresh slot (the access ask's rule). Every ask that REACHES the rung counts;
//     a limited ask does not slide the window;
//   - the MUTES — the per-browser switch first, then the app's own row;
//   - the recorded DECLINES, matched by the ask's semantic hash (rewording is the same ask);
//   - ONE PENDING per frame generation — the same generation is blocked; another generation is
//     not (the caller decides what replacing the older pending means).
//
// The ladder decides; it never parks. The caller owns the pending's shape and the moment it is
// parked, and passes the clock reading (`at`) so its own test seam holds the time. The store is
// the `suggestionStore` shape the strips subscribe to: app id → the one pending.

import type { UserDb } from '@snugprotocol/db';

import { createStore, type Store } from './store.js';

export type AppAskDecision = 'accepted' | 'rate-limited' | 'muted' | 'declined' | 'pending';

export interface AppAskOptions<T> {
  /** At most one ask per app (or per app + generation) inside this window. */
  minGapMs: number;
  /** The ask's semantic identity — what a decline is recorded under. */
  hash: (ask: T) => string;
  /** The app's own mute row. */
  isMuted(db: UserDb, appId: string): boolean;
  /** Whether the user declined this exact ask (by hash) before. */
  isDeclined(db: UserDb, appId: string, hash: string): boolean;
  /** The per-browser switch: every app muted. */
  globalMute(): boolean;
  /** `generation` (default): a new frame generation has its own window. `app`: one window per app. */
  rateBy?: 'generation' | 'app';
  /** The clock `consume` reads when the caller passes no `at`. */
  now?: () => number;
}

export interface AppAsk<T, P extends { generation: number }> {
  /** App id → the one pending ask. */
  readonly store: Store<Readonly<Record<string, P>>>;
  /** True when this ask falls inside the app's window; otherwise records it and answers false. */
  rateLimited(appId: string, generation: number, at: number): boolean;
  /** The per-browser switch, or the app's own mute. */
  muted(db: UserDb, appId: string): boolean;
  declined(db: UserDb, appId: string, hash: string): boolean;
  /** A pending ask from the SAME generation blocks a second. */
  pendingBlocks(appId: string, generation: number): boolean;
  /** The rungs in order: rate → muted → declined → pending → accepted. Decides only. */
  consume(input: { appId: string; generation: number; ask: T; db: UserDb; at?: number }): AppAskDecision;
  pendingFor(appId: string): P | undefined;
  setPending(appId: string, pending: P | undefined): void;
  /** Forget one app's window and pending — or every app's. */
  clear(appId?: string): void;
  /** How many apps the rate limit remembers (the bound the suites pin). */
  rateMemorySize(): number;
}

export function createAppAsk<T, P extends { generation: number }>(options: AppAskOptions<T>): AppAsk<T, P> {
  const store = createStore<Readonly<Record<string, P>>>({});
  const lastAsk = new Map<string, { generation: number; at: number }>();
  const perGeneration = (options.rateBy ?? 'generation') === 'generation';
  const now = options.now ?? Date.now;

  const pendingFor = (appId: string): P | undefined => store.get()[appId];

  const setPending = (appId: string, pending: P | undefined): void => {
    const current = store.get();
    if (pending === undefined) {
      if (!(appId in current)) return;
      const { [appId]: _gone, ...rest } = current;
      store.set(rest);
      return;
    }
    store.set({ ...current, [appId]: pending });
  };

  const rateLimited = (appId: string, generation: number, at: number): boolean => {
    const last = lastAsk.get(appId);
    const sameWindow = last !== undefined && (!perGeneration || last.generation === generation);
    if (sameWindow && at - last.at < options.minGapMs) return true;
    lastAsk.set(appId, { generation, at });
    return false;
  };

  const muted = (db: UserDb, appId: string): boolean => options.globalMute() || options.isMuted(db, appId);
  const declined = (db: UserDb, appId: string, hash: string): boolean => options.isDeclined(db, appId, hash);
  const pendingBlocks = (appId: string, generation: number): boolean => pendingFor(appId)?.generation === generation;

  return {
    store,
    rateLimited,
    muted,
    declined,
    pendingBlocks,
    consume({ appId, generation, ask, db, at }) {
      if (rateLimited(appId, generation, at ?? now())) return 'rate-limited';
      if (muted(db, appId)) return 'muted';
      if (declined(db, appId, options.hash(ask))) return 'declined';
      if (pendingBlocks(appId, generation)) return 'pending';
      return 'accepted';
    },
    pendingFor,
    setPending,
    clear(appId) {
      if (appId === undefined) {
        lastAsk.clear();
        store.set({});
        return;
      }
      lastAsk.delete(appId);
      setPending(appId, undefined);
    },
    rateMemorySize: () => lastAsk.size,
  };
}
