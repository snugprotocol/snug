// schedule/scheduleRequest.ts — an app's schedule SUGGESTION, from the frame to the strip
// (TASK-20261009 P3; ADR-0074 §3–§4; Q3). Running app code may propose a schedule for itself
// with `app-event 'schedule-request'` (the module SDK's `proposeSchedule`, or `SnugBridge.post`
// by hand); the runner is untouched — `SnugAppFrame`'s existing `onAppEvent` seam hands the
// event here, and this module decides whether it becomes a pending suggestion the run header's
// strip renders. Nothing here enables anything: *schedule it* on the strip opens the one
// consent surface and the user's act there calls the one writer (`enableProposedTask`).
//
// THE GUARDS, in the order they run — each a silent drop for the app (an app is never told why,
// so a refusal cannot be probed) and a named decision for the tests:
//   - not our event → `ignored` (apps post other events over the same seam);
//   - ≤ 1 request a minute per INSTANCE (the frame generation) — counted on every request that
//     reaches this point, readable or not, so a chatty app cannot spam its way to the one that
//     fits → `rate-limited`;
//   - length-capped, then STRICT-parsed against `scheduleProposalSchema` → `unreadable`;
//   - the app must be in this file (a read-only starter or a shared preview has no row a
//     schedule could attach to) → `unknown-app`;
//   - every app step names the SENDER — an app may suggest only for itself → `other-app`;
//   - the app is muted (two declines, or *stop suggestions*), or the Settings switch mutes
//     every app (`NO_SUGGESTIONS_KEY`) → `muted`;
//   - the proposal's hash is among the app's recorded declines — a declined suggestion never
//     re-prompts, however it is reworded (the hash covers the semantic fields only) → `declined`;
//   - the app already has five app-proposed schedules → `capped`;
//   - ONE pending per frame generation — a second from the same instance is dropped; a new
//     generation (the frame was remounted) replaces an older pending → `pending`;
//   - otherwise `accepted`: the strip renders it.
//
// A module store (the `appHosts` registry's shape): `RunView` wires the consumer in one line
// (`useAppEventConsumer`) and mounts the strip in one; the strip subscribes by app id. The
// decline and mute acts write the file's own rows (`addScheduleDecline`, `setScheduleMuted`),
// which the `deleteApp` cascade sweeps and an untrusted import drops (C3/C4).

import { useCallback } from 'react';

import { SCHEDULED_TASK_MAX_BYTES, proposalHash, scheduleProposalSchema, type ScheduleProposal } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { createStore, type Store } from '../state/store.js';
import { getUserDb } from '../state/userdb.js';
import { enableProposedTask, namesOnly } from './enableProposedTask.js';
import type { TaskResult } from './scheduler.js';
import { NO_SUGGESTIONS_KEY, readFlag } from './ScheduleSettingsCard.js';

/** The app-event name an app posts to suggest a schedule for itself (ADR-0074 §3). */
export const SCHEDULE_REQUEST_EVENT = 'schedule-request';
/** At most one request a minute per app instance. */
export const SCHEDULE_REQUEST_MIN_GAP_MS = 60_000;
/** At most this many app-proposed schedules per app (Q3). */
export const APP_PROPOSED_TASK_CAP = 5;
/** The serialised request is cut off here BEFORE the strict parse — a task's own bound. */
export const SCHEDULE_REQUEST_MAX_BYTES = SCHEDULED_TASK_MAX_BYTES;

export interface PendingSuggestion {
  appId: string;
  /** The shelf's name for the app at the time — what the strip prints. */
  appName: string;
  /** The frame generation the request came from (`RunView`'s `frameEpoch`). */
  generation: number;
  proposal: ScheduleProposal;
  hash: string;
  receivedAt: number;
}

export type RequestDecision = 'accepted' | 'ignored' | 'rate-limited' | 'unreadable' | 'unknown-app' | 'other-app' | 'muted' | 'declined' | 'capped' | 'pending';

export interface ScheduleRequestInput {
  appId: string;
  generation: number;
  event: string;
  data: unknown;
}

/** The pending suggestion per app — at most one each. */
export const suggestionStore: Store<Readonly<Record<string, PendingSuggestion>>> = createStore<Readonly<Record<string, PendingSuggestion>>>({});

export function pendingSuggestionFor(appId: string): PendingSuggestion | undefined {
  return suggestionStore.get()[appId];
}

interface Deps {
  getDb: () => Promise<UserDb>;
  now: () => number;
  /** The Settings switch — every app muted. */
  noSuggestions: () => boolean;
}

const defaultDeps = (): Deps => ({ getDb: getUserDb, now: Date.now, noSuggestions: () => readFlag(NO_SUGGESTIONS_KEY) });
let deps: Deps = defaultDeps();

/** Last request time per instance (`appId:generation`) — the rate limit's memory. */
const lastRequestAt = new Map<string, number>();

const instanceKey = (appId: string, generation: number): string => `${appId}:${generation}`;

function setPending(appId: string, next: PendingSuggestion | undefined): void {
  const current = suggestionStore.get();
  if (next === undefined) {
    if (!(appId in current)) return;
    const { [appId]: _gone, ...rest } = current;
    suggestionStore.set(rest);
    return;
  }
  suggestionStore.set({ ...current, [appId]: next });
}

/** How many of the file's schedules this app proposed for itself. */
export function appProposedCount(db: UserDb, appId: string): number {
  return db.listScheduledTasks().filter((task) => task.provenance === 'app' && task.ownerAppId === appId).length;
}

/**
 * Consume one app event. Answers the decision so a test can see WHY a request was dropped;
 * the app never does. Never throws — a bad event from the frame must not reach the run view.
 */
export async function consumeScheduleRequest(input: ScheduleRequestInput): Promise<RequestDecision> {
  if (input.event !== SCHEDULE_REQUEST_EVENT) return 'ignored';
  const at = deps.now();
  const key = instanceKey(input.appId, input.generation);
  const last = lastRequestAt.get(key);
  if (last !== undefined && at - last < SCHEDULE_REQUEST_MIN_GAP_MS) return 'rate-limited';
  lastRequestAt.set(key, at);

  let serialised: string;
  try {
    serialised = JSON.stringify(input.data);
  } catch {
    return 'unreadable';
  }
  if (typeof serialised !== 'string' || serialised.length > SCHEDULE_REQUEST_MAX_BYTES) return 'unreadable';
  const parsed = scheduleProposalSchema.safeParse(input.data);
  if (!parsed.success) return 'unreadable';
  const proposal = parsed.data;

  let db: UserDb;
  try {
    db = await deps.getDb();
  } catch {
    return 'unknown-app';
  }
  const app = db.getApp(input.appId);
  if (app === undefined) return 'unknown-app';
  if (!namesOnly(proposal, input.appId)) return 'other-app';
  if (deps.noSuggestions() || db.isScheduleMuted(input.appId)) return 'muted';
  const hash = proposalHash(proposal);
  if (db.listScheduleDeclines(input.appId).includes(hash)) return 'declined';
  if (appProposedCount(db, input.appId) >= APP_PROPOSED_TASK_CAP) return 'capped';
  const current = pendingSuggestionFor(input.appId);
  if (current !== undefined && current.generation === input.generation) return 'pending';

  setPending(input.appId, { appId: input.appId, appName: app.displayName, generation: input.generation, proposal, hash, receivedAt: at });
  return 'accepted';
}

/**
 * The run view's one line: a stable `onAppEvent` for the mounted frame. The frame generation
 * is the instance the rate limit and the one-pending rule count by; a remount is a new instance.
 */
export function useAppEventConsumer(appId: string, generation: number): (event: string, data: unknown) => void {
  return useCallback(
    (event: string, data: unknown) => {
      void consumeScheduleRequest({ appId, generation, event, data });
    },
    [appId, generation],
  );
}

/** *Schedule it*, after the consent surface: the one writer, with the sender as owner. The pending clears on success. */
export async function acceptSuggestion(appId: string): Promise<TaskResult> {
  const pending = pendingSuggestionFor(appId);
  if (pending === undefined) return { ok: false, reason: 'nothing is waiting for an answer' };
  const result = await enableProposedTask({ proposal: pending.proposal, provenance: 'app', ownerAppId: appId });
  if (result.ok) setPending(appId, undefined);
  return result;
}

/**
 * *Not now*: the hash is recorded against the app so the same suggestion never re-prompts;
 * the second decline mutes the app altogether (security F17). Answers which happened.
 */
export async function declineSuggestion(appId: string): Promise<'declined' | 'muted'> {
  const pending = pendingSuggestionFor(appId);
  setPending(appId, undefined);
  if (pending === undefined) return 'declined';
  const db = await deps.getDb();
  db.addScheduleDecline(appId, pending.hash);
  if (db.listScheduleDeclines(appId).length >= 2) {
    db.setScheduleMuted(appId, true);
    return 'muted';
  }
  return 'declined';
}

/** *Stop suggestions from this app*: muted until Settings (or a reinstall) says otherwise. */
export async function muteSuggestions(appId: string): Promise<void> {
  setPending(appId, undefined);
  const db = await deps.getDb();
  db.setScheduleMuted(appId, true);
}

/** Test seams: the module holds state, so suites must be able to clear it and hold its clock. */
export function __setScheduleRequestDepsForTests(over?: Partial<Deps>): void {
  deps = { ...defaultDeps(), ...over };
}

export function __resetScheduleRequestsForTests(): void {
  deps = defaultDeps();
  lastRequestAt.clear();
  suggestionStore.set({});
}
