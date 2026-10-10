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
// generation, so the gate's `touched === live` comparison fails by itself. `clearTouchedGeneration`
// is the belt `state/net.ts` pulls from its registry listener, and it clears only the generation it
// names (a stale clear never lifts a newer posture).
//
// A LEAF. Imports `state/store.ts` and `state/appHosts.ts` only — `state/net.ts`, `run/appRuntime.ts`,
// `access/accessHandler.ts` and `RunningChip.tsx` sit above it, so loading it can never enter the
// scheduler's import cycle.

import { liveAppHostToken } from '../state/appHosts.js';
import { createStore, type Store } from '../state/store.js';

export type Placement = 'live' | 'hidden';

/** A run follows the app at most once (ADR-0077 §5). */
export const MAX_HANDOVERS = 1;

/** What the ask gate refused — enough to say what the app tried and WHY nothing was sent, never the body or a credential. */
export interface ScheduledRefusal {
  host: string;
  method: string;
  why: 'declined' | 'timed-out' | 'already-asked';
}

/** A run in flight on the live frame — a MUTABLE record; the store notifies on presence changes only. */
export interface DelegatedRun {
  appId: string;
  appName: string;
  runId: string;
  taskId: string;
  title: string;
  generation: number;
  calls: { ai: number; net: number };
  refused: ScheduledRefusal[];
  granted: number;
  /** The host of the latest ALLOWED mutating call — what `closedAfterChange` names when the app then closes. */
  grantedHost?: string;
  /** A scheduled dialog is parked for this run right now (one outstanding ask per run, D-PR1-9). */
  asking: boolean;
  /** Aborted by `endDelegatedRun` — every parked prompt for the run listens to it and withdraws. */
  readonly signal: AbortSignal;
}

/** appId → the run in flight on the LIVE frame. */
export const delegatedRunStore: Store<ReadonlyMap<string, DelegatedRun>> = createStore<ReadonlyMap<string, DelegatedRun>>(new Map());

const controllers = new WeakMap<DelegatedRun, AbortController>();

/** The generation a delegated run last began on, with the registration it began under and the app's name. */
interface Touched {
  generation: number;
  token: symbol | undefined;
  appName: string;
}
const touched = new Map<string, Touched>();

export function delegatedRunFor(appId: string): DelegatedRun | undefined {
  return delegatedRunStore.get().get(appId);
}

/** Begin a run on the live frame. Refuses a second run for the same app (never a throw); a refusal moves nothing. */
export function beginDelegatedRun(
  input: Pick<DelegatedRun, 'appId' | 'appName' | 'runId' | 'taskId' | 'title' | 'generation'>,
): { ok: true; run: DelegatedRun } | { ok: false; reason: string } {
  const current = delegatedRunStore.get();
  if (current.has(input.appId)) return { ok: false, reason: `${input.appName} is already running another schedule` };
  const controller = new AbortController();
  const run: DelegatedRun = {
    appId: input.appId,
    appName: input.appName,
    runId: input.runId,
    taskId: input.taskId,
    title: input.title,
    generation: input.generation,
    calls: { ai: 0, net: 0 },
    refused: [],
    granted: 0,
    asking: false,
    signal: controller.signal,
  };
  controllers.set(run, controller);
  touched.set(input.appId, { generation: input.generation, token: liveAppHostToken(input.appId), appName: input.appName });
  const next = new Map(current);
  next.set(input.appId, run);
  delegatedRunStore.set(next);
  return { ok: true, run };
}

/** End the run `runId` for `appId`: aborts its signal (every parked prompt withdraws), removes the entry, returns the final record. Another run id is left alone. */
export function endDelegatedRun(appId: string, runId: string): Pick<DelegatedRun, 'calls' | 'refused' | 'granted'> | undefined {
  const current = delegatedRunStore.get();
  const run = current.get(appId);
  if (run === undefined || run.runId !== runId) return undefined;
  const next = new Map(current);
  next.delete(appId);
  delegatedRunStore.set(next);
  controllers.get(run)?.abort();
  return { calls: run.calls, refused: run.refused, granted: run.granted };
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

/** Clear the posture — only for the generation it names. Called on a retraction (the `state/net.ts` belt). */
export function clearTouchedGeneration(appId: string, generation: number): void {
  if (touched.get(appId)?.generation === generation) touched.delete(appId);
}

/** The one rule: the registry has the app → `live`; otherwise → `hidden`. */
export function placeRun(live: { has(appId: string): boolean }, appId: string): Placement {
  return live.has(appId) ? 'live' : 'hidden';
}
