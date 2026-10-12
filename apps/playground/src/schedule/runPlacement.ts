// schedule/runPlacement.ts — where an unattended run executes, and the record of a run in flight
// on the LIVE frame (TASK-20261010-host-broker PR-1; ADR-0077 §1–§5; contract v2 D-PR1-1, D-PR1-3,
// D-PR1-5, D-PR1-9).
//
// ONE RULE. `placeRun`: the registry HAS the app (registered in this tab) → `live`, else `hidden`.
// Placement reads registration; readiness is awaited inside the live dispatch (`appRun.ts`).
//
// THE RECORD. A run delegated to the open app is a "delegated run": `beginDelegatedRun` writes ONE
// mutable record per app into `delegatedRunStore`, and every other piece reads it PER REQUEST —
// the run-scoped ask gate (does a run own this app right now? `runScopedGate.ts`), the counting
// seams (`noteDelegatedCall`, from `run/appRuntime.ts`'s decorators), the access handler (the door
// closes for the window, D-PR1-8) and the running chip (*running in <app>*). The store notifies on
// PRESENCE changes only (a begin, an end); a counted call mutates the record in place. It is
// in-memory only — D-PR1-1: no persisted row changes shape, and where a run executed is never
// written anywhere.
//
// THE STICKY POSTURE (security blocker 1, D-PR1-3). Once a delegated run has begun on a frame
// generation, every later mutating call from that generation stays ask-only — after the run too,
// so a handler cannot post its result first and POST afterwards into a remembered grant.
// `beginDelegatedRun` records the generation (with the app's display name, for the after-run
// dialog) and `endDelegatedRun` deliberately does NOT clear it. The record is matched
// STRUCTURALLY (contract v2.1): it captures the registration TOKEN beside the generation and
// `touchedGeneration` answers only while that token is still the live one — a retraction and
// re-registration mints a new token, so the posture dies by itself; a remount changes the
// generation, so the gate's `touched === live` comparison fails by itself. A remount DURING the
// run is the one case the comparison would miss (Gate-5 F-6): the new generation is the instance
// that could have read the run's kv input, so `endDelegatedRun` moves the posture to the
// generation live at the END of the run while the token still matches. The belt on top of the
// structural rule has ONE home, here (F-12): a module-load registry listener clears the record on
// a retraction through `clearTouchedGeneration`, which clears only the generation it names (a
// stale clear never lifts a newer posture).
//
// THE POSTURE (TASK-20261010-host-broker PR-3; ADR-0076 §6; contract v2 D-PR3-19). A run on the
// live frame is either a SCHEDULE's (`'schedule'`, the default — every PR-1 caller) or a REFRESH
// another app asked for (`'refresh'`: the source's own code run on a reader's act, `access/refresh.ts`).
// The record carries which, and the two readers that care decide by it: the run-scoped gate REFUSES
// every mutating call of a refresh window — nobody chose to run it, so there is nobody to ask —
// where a schedule's window asks the present user once (`ScheduledRefusal.why` gains `'refused'` for
// that record); the running chip shows a refresh in flight when the scheduler has nothing running.
// Everything else is one rule for both: one instance per app (a refresh is refused while a schedule's
// run is in flight and the reverse), the counting seams, the access door closed for the window
// (D-PR1-8), and the STICKY posture — `touched` is written for BOTH postures (S6): a refresh runs
// the source's app code, and a handler that answers `schedule-result` and POSTs afterwards must meet
// the same after-run dialog D-PR1-3 built. The cost (after a refresh, the source's *remember for
// this session* is unavailable on that frame until the user reopens it) is PR-1's, accepted.
//
// A CANCELLED REFRESH ON THE LIVE FRAME (TASK-20261010-host-broker PR-5; contract v2 D-PR5-17;
// security S2). Stopping a fetch from the chip cannot stop the source's handler: it is the open
// app's own code, and it may still be running. Ending the record then would turn the window's
// refusals into the sticky after-run ASK — a dialog for a change nobody chose. So the refresh engine
// HOLDS the record (`holdDelegatedRun`, `cancelled: true`): the attempt's `endDelegatedRun` answers
// the tally so far and leaves the record in place — still refusing every mutating call, the access
// door still closed, still counting — until the engine RELEASES it (`releaseDelegatedRun`) when the
// handler's result arrives or the dispatch's original deadline passes; only then does it end, and
// the sticky posture applies as after any run. The touched record keeps the run's POSTURE too, so
// the after-run dialog says what really ran in the frame (`touchedPosture`; D12(ii)).
//
// A LEAF. Imports `state/store.ts`, `state/appHosts.ts` and `schedule/copy.ts` (pure strings) only —
// `state/net.ts`, `state/openUrl.ts`, `run/appRuntime.ts`, `access/accessHandler.ts`,
// `access/refresh.ts` and `RunningChip.tsx` sit above it, so loading it can never enter the
// scheduler's import cycle.

import { liveAppHostGeneration, liveAppHostToken, subscribeAppHosts } from '../state/appHosts.js';
import { createStore, type Store } from '../state/store.js';
import { alreadyRunning } from './copy.js';

export type Placement = 'live' | 'hidden';

/** A run follows the app at most once (ADR-0077 §5). */
export const MAX_HANDOVERS = 1;

/**
 * What a scheduled run's gate refused — enough to say what the app tried, never the body or a
 * credential. The ONE refusal type (Gate-5 F-13): the run-scoped ask gate records WHY nothing was
 * sent — `refused` is a refresh window's answer (D-PR3-19: refused at once, no dialog); the hidden
 * frame's refusing gate (`scheduledConfirmGate.ts`, which re-exports this) has no dialog and records
 * no `why`.
 */
export interface ScheduledRefusal {
  host: string;
  method: string;
  why?: 'declined' | 'timed-out' | 'already-asked' | 'refused';
}

/** Whose act a delegated run is: a schedule's (every PR-1 caller), or a fetch another app asked for (D-PR3-19). */
export type DelegatedRunPosture = 'schedule' | 'refresh';

/** A run in flight on the live frame — a MUTABLE record; the store notifies on presence changes only. */
export interface DelegatedRun {
  appId: string;
  appName: string;
  runId: string;
  taskId: string;
  title: string;
  generation: number;
  /** A schedule's run asks the present user once per window; a refresh's refuses every mutating call (D-PR3-19). */
  posture: DelegatedRunPosture;
  calls: { ai: number; net: number };
  refused: ScheduledRefusal[];
  granted: number;
  /** The host of the latest ALLOWED mutating call — what `closedAfterChange` names when the app then closes. */
  grantedHost?: string;
  /** A scheduled dialog is parked for this run right now (one outstanding ask per run, D-PR1-9). */
  asking: boolean;
  /** Aborted by `endDelegatedRun` — every parked prompt for the run listens to it and withdraws. */
  readonly signal: AbortSignal;
  /**
   * A refresh stopped while its handler may still run in the open frame (D-PR5-17, S2; T-D Q7): the
   * record is HELD — refusing, counting — until `releaseDelegatedRun`. Absent on every other record.
   */
  cancelled?: true;
}

/** What a dispatch reads off the record when its attempt ends. */
export type DelegatedRunTally = Pick<DelegatedRun, 'calls' | 'refused' | 'granted'>;

/** appId → the run in flight on the LIVE frame. */
export const delegatedRunStore: Store<ReadonlyMap<string, DelegatedRun>> = createStore<ReadonlyMap<string, DelegatedRun>>(new Map());

const controllers = new WeakMap<DelegatedRun, AbortController>();

/** A held record's calls as its attempt reported them — what it counted AFTER that is the release's `late`. */
const reportedAtHold = new WeakMap<DelegatedRun, DelegatedRun['calls']>();

/** The generation a delegated run last began on, with the registration it began under, the app's name and what ran. */
interface Touched {
  generation: number;
  token: symbol | undefined;
  appName: string;
  posture: DelegatedRunPosture;
}
const touched = new Map<string, Touched>();

export function delegatedRunFor(appId: string): DelegatedRun | undefined {
  return delegatedRunStore.get().get(appId);
}

/** What `beginDelegatedRun` takes: the record's identity; `posture` defaults to `'schedule'` (every PR-1 caller). */
export type BeginDelegatedRunInput = Pick<DelegatedRun, 'appId' | 'appName' | 'runId' | 'taskId' | 'title' | 'generation'> & { posture?: DelegatedRunPosture };

/**
 * Begin a run on the live frame. Refuses a second run for the same app WHATEVER its posture (one
 * instance, §24.7 (28)) — never a throw; a refusal moves nothing. The sticky generation is recorded
 * for both postures (S6).
 */
export function beginDelegatedRun(input: BeginDelegatedRunInput): { ok: true; run: DelegatedRun } | { ok: false; reason: string } {
  const current = delegatedRunStore.get();
  if (current.has(input.appId)) return { ok: false, reason: alreadyRunning(input.appName) };
  const controller = new AbortController();
  const run: DelegatedRun = {
    appId: input.appId,
    appName: input.appName,
    runId: input.runId,
    taskId: input.taskId,
    title: input.title,
    generation: input.generation,
    posture: input.posture ?? 'schedule',
    calls: { ai: 0, net: 0 },
    refused: [],
    granted: 0,
    asking: false,
    signal: controller.signal,
  };
  controllers.set(run, controller);
  touched.set(input.appId, { generation: input.generation, token: liveAppHostToken(input.appId), appName: input.appName, posture: run.posture });
  const next = new Map(current);
  next.set(input.appId, run);
  delegatedRunStore.set(next);
  return { ok: true, run };
}

/**
 * End the run `runId` for `appId`: aborts its signal (every parked prompt withdraws), removes the
 * entry, returns the final record. Another run id is left alone. The sticky posture follows the
 * frame to the generation live at the END of the run (F-6) — a remount mid-run is the instance that
 * could have read the kv input — but only while the registration is still the one the run began
 * under (a retraction and re-registration is a different view, and the posture has died with the
 * token). With no registry (a unit suite) both tokens are `undefined` and nothing moves.
 *
 * A HELD record (`cancelled`, D-PR5-17) is not ended here: the attempt gets the tally so far and
 * the record stays, refusing, until `releaseDelegatedRun`.
 */
export function endDelegatedRun(appId: string, runId: string): DelegatedRunTally | undefined {
  const run = delegatedRunStore.get().get(appId);
  if (run === undefined || run.runId !== runId) return undefined;
  if (run.cancelled === true) {
    const reported = { ...run.calls };
    reportedAtHold.set(run, reported);
    return { calls: reported, refused: [...run.refused], granted: run.granted };
  }
  return finish(appId, run);
}

/** The end itself: the sticky generation moved (F-6), the entry removed, the signal aborted. */
function finish(appId: string, run: DelegatedRun): DelegatedRunTally {
  const record = touched.get(appId);
  if (record !== undefined && record.token === liveAppHostToken(appId)) {
    const generation = liveAppHostGeneration(appId);
    if (generation !== undefined) record.generation = generation;
  }
  const next = new Map(delegatedRunStore.get());
  next.delete(appId);
  delegatedRunStore.set(next);
  controllers.get(run)?.abort();
  return { calls: run.calls, refused: run.refused, granted: run.granted };
}

/**
 * Hold the run `runId` for `appId` (D-PR5-17, S2): a REFRESH whose dispatch was stopped while its
 * handler may still run in the open frame. Marks the record `cancelled`; `endDelegatedRun` then
 * leaves it in place. `false` — nothing held — for another run id, no record, or a schedule's run
 * (a schedule's window asks the person present; only a refresh's refuses, so only it is held).
 */
export function holdDelegatedRun(appId: string, runId: string): boolean {
  const run = delegatedRunFor(appId);
  if (run === undefined || run.runId !== runId || run.posture !== 'refresh') return false;
  run.cancelled = true;
  return true;
}

/**
 * End a held run at last — the handler's result arrived, the original deadline passed, or the frame
 * went away. Answers the final record and what it counted AFTER its attempt reported (`late` — the
 * engine folds it into the day); the sticky posture applies from here as after any run. A record
 * never held ends exactly as `endDelegatedRun` ends it, all of its calls `late`.
 */
export function releaseDelegatedRun(appId: string, runId: string): (DelegatedRunTally & { late: DelegatedRun['calls'] }) | undefined {
  const run = delegatedRunStore.get().get(appId);
  if (run === undefined || run.runId !== runId) return undefined;
  const reported = reportedAtHold.get(run) ?? { ai: 0, net: 0 };
  const tally = finish(appId, run);
  return { ...tally, late: { ai: Math.max(0, tally.calls.ai - reported.ai), net: Math.max(0, tally.calls.net - reported.net) } };
}

/** Count one call on the run in flight for `appId`; a no-op when there is none (never creates one, never throws). */
export function noteDelegatedCall(appId: string, kind: 'ai' | 'net'): void {
  const run = delegatedRunFor(appId);
  if (run === undefined) return;
  run.calls[kind] += 1;
}

/** The record is live only while the registration it began under is still the live one (both absent counts as equal). */
function liveTouched(appId: string): Touched | undefined {
  const record = touched.get(appId);
  if (record === undefined || record.token !== liveAppHostToken(appId)) return undefined;
  return record;
}

/** The generation a delegated run last began on, until the frame retracts (or the belt clears it). */
export function touchedGeneration(appId: string): number | undefined {
  return liveTouched(appId)?.generation;
}

/** The display name recorded beside the touched generation — the after-run dialog's subject. */
export function touchedAppName(appId: string): string | undefined {
  return liveTouched(appId)?.appName;
}

/** What last ran on the touched generation — a schedule, or a fetch another app asked for: the after-run dialog's words follow it (D-PR5-17; T-D Q14). */
export function touchedPosture(appId: string): DelegatedRunPosture | undefined {
  return liveTouched(appId)?.posture;
}

/** Clear the posture — only for the generation it names. Called on a retraction (the belt below) and by suites that end what they began. */
export function clearTouchedGeneration(appId: string, generation: number): void {
  if (touched.get(appId)?.generation === generation) touched.delete(appId);
}

/**
 * THE BELT ON THE STICKY POSTURE (D-PR1-3; its one home, F-12). The posture already dies
 * structurally when the frame retracts — the token the run captured is no longer the live one —
 * and this listener clears the record by name as well, so the rule "a retraction clears it" holds
 * even if the match were ever loosened. A module-load subscription: `__resetAppHostsForTest` drops
 * it with every other host listener, which is harmless (the token match does not depend on it).
 */
subscribeAppHosts((appId, live) => {
  if (live) return;
  const record = touched.get(appId);
  if (record !== undefined) clearTouchedGeneration(appId, record.generation);
});

/** The one rule: the registry has the app → `live`; otherwise → `hidden`. */
export function placeRun(live: { has(appId: string): boolean }, appId: string): Placement {
  return live.has(appId) ? 'live' : 'hidden';
}
