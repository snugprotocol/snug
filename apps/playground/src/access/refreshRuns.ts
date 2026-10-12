// access/refreshRuns.ts — the fetches another app asked for that are in flight, and the ONE way
// to stop each (TASK-20261010-host-broker PR-5; ADR-0076 §6; contract v2 D-PR5-17, D-PR5-18 and
// its v2.1 answers T-D Q1/Q2; S2, S6, S14, F19).
//
// A LEAF. It imports nothing from the refresh engine, the run path or the service: the engine
// writes here, the running chip and the doors read here, and nothing here reaches back — so the
// chip can sit in the kit's eager graph while the engine stays behind its lazy edge.
//
// ONE ENTRY PER REFRESH, across its handovers (F19): `beginRefreshRun` at dispatch, then
// `setRefreshPlacement` when the run follows the source between its live frame and the hidden
// one (the SAME run id, the SAME controller — the chip never flickers into a second fetch), then
// `endRefreshRun` when the engine settles it. The entry carries the dispatch's OWN controller.
//
// WHO MAY ABORT THAT CONTROLLER (S14). A door that waits on a refresh — the frame's op, the chat's
// *fetch new data first*, a schedule's — joins it (`joinRefreshRun`) and leaves when its own
// signal fires: leaving abandons ONLY that door's wait. The dispatch itself is aborted by exactly
// three things: the person's act on the chip (`cancelRefresh`), a file swap (`abortAllRefreshes`)
// or an app delete (`abortRefreshesFor`) — and by the LAST waiter leaving, since then nobody is
// waiting on what it would bring. So every door that waits joins, the one that started it too.
//
// THE REASON travels on the signal (`signal.reason`, read through `refreshAbortReason`): a reset
// writes NOTHING (the old file is gone — S6), while a cancel, an abandoned run or a deleted app's
// run is the engine's to word. Each of the four verbs takes the entry away at once, so the chip
// drops it in the same tick; the engine's own end is then a no-op here.
//
// THE RESET EPOCH AND THE SWAP LATCH (Gate-5 fold G5-18; P3-1, SB-3). A file swap is not only the
// flights in the air: the cooldowns, the remembered outcomes and a held record's late calls belong
// to the old file too. Most resets find NOTHING in flight, so no flight's abort could carry them —
// the epoch lives HERE, moved by every `abortAllRefreshes('reset')` before anything else (an empty
// store included), and the engine reads it at the top of every ask and after every await. A swap
// that takes awaits — a pull's import, a file's import — LATCHES first (`latchRefreshSwap`: the same
// reset, then the latch): until the file that replaces this one is there (`unlatchRefreshSwap`, in
// `afterForeignBytes`), every refresh asked answers stopped and nothing is dispatched or written.

import { createStore, useStore } from '../state/store.js';

/** Where the source's code runs for this refresh: its open frame, or the one hidden frame. */
export type RefreshPlacement = 'live' | 'headless';

/** Why a refresh's own controller was aborted — `signal.reason` (see `refreshAbortReason`). */
export type RefreshAbortReason = 'cancel' | 'reset' | 'deleted' | 'abandoned';

/** One refresh in flight. Replaced, never mutated, on every change (the chip reads it through `useRefreshRuns`). */
export interface RefreshRun {
  readonly runId: string;
  readonly sourceAppId: string;
  /** The source's library name — what the chip says ("fetching in Ledger"). */
  readonly sourceName: string;
  /** The REQUESTING app's id (T-D Q2) — what `abortRefreshesFor` matches beside the source. */
  readonly requestedBy: string;
  readonly placement: RefreshPlacement;
  /** The dispatch's own controller — aborted only by the verbs above, never by a door's signal. */
  readonly controller: AbortController;
  /** How many doors are waiting on it. */
  readonly waiters: number;
}

export interface BeginRefreshRunInput {
  runId: string;
  sourceAppId: string;
  sourceName: string;
  requestedBy: string;
  placement: RefreshPlacement;
}

/** Oldest first: the order the refreshes began in. */
const runs = createStore<readonly RefreshRun[]>([]);
/** Moves at every reset — what the engine compares to know the file it remembers is still the one there (G5-18). */
let resetEpoch = 0;
/** A swap is under way: nothing may start until the file that replaces this one is there (SB-3). */
let swapLatched = false;

const replace = (runId: string, next: (run: RefreshRun) => RefreshRun): void => {
  runs.set(runs.get().map((run) => (run.runId === runId ? next(run) : run)));
};

const without = (gone: ReadonlySet<RefreshRun>): void => {
  runs.set(runs.get().filter((run) => !gone.has(run)));
};

/** Abort the given runs with `reason` and take them away — one store write, so the chip drops them together. */
function abortRuns(targets: readonly RefreshRun[], reason: RefreshAbortReason): void {
  if (targets.length === 0) return;
  without(new Set(targets));
  for (const run of targets) run.controller.abort(reason);
}

/** A refresh is dispatched: its entry, with a fresh controller and no waiter yet. */
export function beginRefreshRun(input: BeginRefreshRunInput): RefreshRun {
  const run: RefreshRun = { ...input, controller: new AbortController(), waiters: 0 };
  runs.set([...runs.get(), run]);
  return run;
}

/** The run followed the source to its other frame: the same entry, placed anew. */
export function setRefreshPlacement(runId: string, placement: RefreshPlacement): void {
  replace(runId, (run) => (run.placement === placement ? run : { ...run, placement }));
}

/**
 * A door waits on the run. The answer is that door's ONE way out: idempotent, a no-op once the
 * run has ended, and when it is the last waiter leaving, the dispatch is abandoned.
 */
export function joinRefreshRun(runId: string): () => void {
  const joined = runs.get().find((run) => run.runId === runId);
  if (joined === undefined) return () => undefined;
  const { controller } = joined;
  replace(runId, (run) => ({ ...run, waiters: run.waiters + 1 }));
  let left = false;
  return () => {
    if (left) return;
    left = true;
    // The same run (its controller), still in flight — a later run under the same id is not ours to count down.
    const current = runs.get().find((run) => run.runId === runId && run.controller === controller);
    if (current === undefined) return;
    if (current.waiters <= 1) abortRuns([current], 'abandoned');
    else replace(runId, (run) => ({ ...run, waiters: run.waiters - 1 }));
  };
}

/** The engine settled the run: the entry goes, nothing is aborted. */
export function endRefreshRun(runId: string): void {
  const ended = runs.get().filter((run) => run.runId === runId);
  if (ended.length > 0) without(new Set(ended));
}

/** Every refresh in flight, oldest first — the non-hook read. */
export function listRefreshRuns(): readonly RefreshRun[] {
  return runs.get();
}

/** The chip's act: the dispatch's own controller aborts and the entry goes. `false` when no such run is in flight. */
export function cancelRefresh(runId: string): boolean {
  const target = runs.get().filter((run) => run.runId === runId);
  abortRuns(target, 'cancel');
  return target.length > 0;
}

/**
 * A file swap: the epoch moves FIRST — with nothing in flight too, so the engine forgets the old
 * file's cooldowns and outcomes on its next read (P3-1) — then every refresh aborts (the engine
 * writes nothing for it, and an abort listener already reads the new epoch) and the store empties.
 */
export function abortAllRefreshes(reason: 'reset'): void {
  resetEpoch += 1;
  abortRuns(runs.get(), reason);
}

/** The reset epoch: moved by every `abortAllRefreshes('reset')` (and so every latch), never by a cancel, a delete or an abandoned wait. */
export function refreshResetEpoch(): number {
  return resetEpoch;
}

/**
 * A swap begins (a pull's `beforeSwap`, a file's import): the reset, then the latch — every refresh
 * asked from here answers stopped until `unlatchRefreshSwap`, so none starts against the file being
 * replaced and lands in the one replacing it (SB-3).
 */
export function latchRefreshSwap(): void {
  swapLatched = true;
  abortAllRefreshes('reset');
}

/** The file that replaced the old one is there (`afterForeignBytes`), or the swap swapped nothing: refreshes may start again. */
export function unlatchRefreshSwap(): void {
  swapLatched = false;
}

/** Whether a swap is under way — the engine answers every ask `stopped` while it is. */
export function refreshSwapLatched(): boolean {
  return swapLatched;
}

/** An app delete: only the refreshes whose source OR requester is that app (S6). */
export function abortRefreshesFor(appId: string): void {
  abortRuns(
    runs.get().filter((run) => run.sourceAppId === appId || run.requestedBy === appId),
    'deleted',
  );
}

const ABORT_REASONS: ReadonlySet<unknown> = new Set<RefreshAbortReason>(['cancel', 'reset', 'deleted', 'abandoned']);

/** Why `signal` was aborted by one of the verbs here — `undefined` for a signal that is live, or was aborted elsewhere. */
export function refreshAbortReason(signal: AbortSignal): RefreshAbortReason | undefined {
  return signal.aborted && ABORT_REASONS.has(signal.reason) ? (signal.reason as RefreshAbortReason) : undefined;
}

/** The refreshes in flight, for a surface (the running chip). */
export function useRefreshRuns(): readonly RefreshRun[] {
  return useStore(runs);
}
