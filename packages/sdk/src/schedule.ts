// The app side of a SCHEDULED RUN (TASK-20261009-scheduling-framework A7; ADR-0074 §3, §4, §6).
//
// WHY THIS EXISTS. An app never owns a timer: the host's scheduler is the one clock, and a
// schedule exists only because the user created or enabled it. When a *Run [app]* step is due
// the host wakes the app — in a hidden frame, or the live one — over the channels the app
// already has, as HINTS (R7: ids on the event channel, the content in the kv):
//
//   1. the host writes `snug:schedule:<runId>` = `{ taskId, runId, input }` into the app's own
//      key-value store (≤ 1 KiB, cleared with `null` once the result is in);
//   2. the host posts `host-event 'schedule-run' { taskId, runId }`;
//   3. the app answers ONE `app-event 'schedule-result' { ok, summary?, notify? }`.
//
// `useSnugSchedule(handler)` is that handshake, typed: the hint arrives, the input is read back
// through the same db frames `usePersistedState` uses, the handler runs ONCE per runId (a
// repeated hint — a host that crashed mid-run and asked again — is ignored, so a handler is
// safe to write naively), and the result is posted exactly once. A result is a SUMMARY a person
// reads on the Schedule page, never data; `notify` is a SUGGESTION the host may ignore.
//
// `proposeSchedule(proposal)` is the app's one way to ASK for a schedule (ADR-0074 §4, the
// suggest-only ladder): `app-event 'schedule-request'` carrying a `scheduleProposal` the host
// renders as a run-header strip the user accepts or declines. Nothing here sets `enabled`.
// One request per page: the host keeps one pending per frame generation and there is no
// acknowledgement to clear it, so a second call answers `false` and posts nothing.
//
// The EMBEDDED form has no hook (Q7: the copy-exactly block changes in the starter release
// wave); the knowledge base ships this same shape as a listener snippet beside the block.
import { useEffect, useRef } from 'react';
import {
  FRAME_TYPES,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
  scheduleProposalSchema,
  type ScheduleProposal,
} from '@snugprotocol/protocol';
import { bridge, dbRequest, ensureListener, onHostEvent, postToHost } from './bridge.js';

/** The host-event that hints a due run: `{ taskId, runId }`. */
export const SCHEDULE_RUN_EVENT = 'schedule-run';
/** The app-event that answers it: `{ ok, summary?, notify? }`. */
export const SCHEDULE_RESULT_EVENT = 'schedule-result';
/** The app-event that suggests a schedule: a `scheduleProposal`. */
export const SCHEDULE_REQUEST_EVENT = 'schedule-request';

/** The kv key the host wrote the run's input under — in the app's OWN namespace. */
export function scheduleInputKey(runId: string): string {
  return `snug:schedule:${runId}`;
}

/** What the handler is given: the ids from the hint, the input from the kv (absent when none was written). */
export interface SnugScheduledRun {
  runId: string;
  taskId: string;
  input?: unknown;
}

/** A notification the host MAY raise when the user asked to be told that way — a suggestion, never a promise. */
export interface SnugScheduleNotify {
  title: string;
  body: string;
}

/** What the handler answers: did it work, one or two sentences a person reads, an optional notification suggestion. */
export interface SnugScheduleResult {
  ok: boolean;
  summary?: string;
  notify?: SnugScheduleNotify;
}

export type SnugScheduleHandler = (run: SnugScheduledRun) => SnugScheduleResult | Promise<SnugScheduleResult>;

/** How many answered runIds the page remembers for the duplicate-hint guard before the oldest is forgotten. */
const REMEMBERED_RUNS = 128;

/** runIds answered (or in flight) on this page — insertion-ordered, so the oldest is the first entry. */
const answeredRuns = new Set<string>();
let proposalSent = false;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readHint(data: unknown): { runId: string; taskId: string } | undefined {
  if (!isRecord(data)) return undefined;
  const { runId, taskId } = data;
  if (typeof runId !== 'string' || runId === '' || typeof taskId !== 'string' || taskId === '') return undefined;
  return { runId, taskId };
}

function remember(runId: string): void {
  answeredRuns.add(runId);
  if (answeredRuns.size > REMEMBERED_RUNS) {
    const oldest = answeredRuns.values().next().value;
    if (oldest !== undefined) answeredRuns.delete(oldest);
  }
}

const messageOf = (err: unknown): string => (err instanceof Error && err.message !== '' ? err.message : 'the scheduled run failed');

/**
 * The result as the host will parse it: `ok` a boolean, `summary` a non-empty string capped
 * at the protocol's step-summary bound, `notify` only when both halves are non-empty strings
 * (each capped at its bound). Anything else the handler put on the object is dropped — a
 * result carries a summary, not data.
 */
export function normalizeScheduleResult(raw: unknown): SnugScheduleResult {
  if (!isRecord(raw)) return { ok: false, summary: 'the handler returned no result' };
  const out: SnugScheduleResult = { ok: raw.ok === true };
  if (typeof raw.summary === 'string' && raw.summary !== '') out.summary = raw.summary.slice(0, SCHEDULE_STEP_SUMMARY_MAX_CHARS);
  if (isRecord(raw.notify) && typeof raw.notify.title === 'string' && raw.notify.title !== '' && typeof raw.notify.body === 'string' && raw.notify.body !== '') {
    out.notify = { title: raw.notify.title.slice(0, SCHEDULE_TITLE_MAX_CHARS), body: raw.notify.body.slice(0, SCHEDULE_NOTIFY_BODY_MAX_CHARS) };
  }
  return out;
}

async function answerHint(data: unknown, handler: SnugScheduleHandler): Promise<void> {
  const hint = readHint(data);
  if (hint === undefined) return; // not the host's shape — ignore (the channel is additive)
  if (answeredRuns.has(hint.runId)) return; // a repeated hint: the first answer stands
  remember(hint.runId); // BEFORE the kv round trip, so a duplicate arriving meanwhile is ignored too
  const stored = await dbRequest('kvGet', { key: scheduleInputKey(hint.runId) });
  const input = stored.ok && isRecord(stored.value) ? stored.value.input : undefined;
  let result: SnugScheduleResult;
  try {
    result = normalizeScheduleResult(await handler({ ...hint, ...(input !== undefined ? { input } : {}) }));
  } catch (err) {
    result = { ok: false, summary: messageOf(err) };
  }
  postToHost({ type: FRAME_TYPES.appEvent, event: SCHEDULE_RESULT_EVENT, data: result });
}

/**
 * Answers the host's scheduled runs with `handler`. Mount it once, beside `useSnugApp`; the
 * latest render's handler is the one that runs. The handler does the app's work — read its own
 * data, call its approved API through `useConnectedFetch` (a mutating call is REFUSED while
 * nobody is present: the host records the run as *needs you*, so a scheduled handler reads
 * and summarises, and leaves writes for a visible session) — and answers `{ ok, summary?,
 * notify? }`. A throw becomes `{ ok: false, summary: <message> }`; nothing escapes.
 */
export function useSnugSchedule(handler: SnugScheduleHandler): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  // `onHostEvent` installs the bridge's listener itself, so this may be the first hook to mount.
  useEffect(
    () =>
      onHostEvent(SCHEDULE_RUN_EVENT, (data) => {
        void answerHint(data, (run) => handlerRef.current(run));
      }),
    [],
  );
}

/**
 * Suggests a schedule for THIS app — once per page, after a user act or a first successful
 * fetch, never on load. Posts `app-event 'schedule-request'` and answers `true`; answers
 * `false` and posts nothing before host-ready, for a proposal the protocol's shape refuses
 * (steps may name only this app — the host enforces the sender), or once a request has
 * already gone out on this page. The user decides on the host's strip; nothing runs until
 * they say so, and a declined suggestion is remembered by the host.
 * The steps name THIS app by the `appId` the app announced (`useSnugApp({ appId })`): the host
 * maps it to the id it holds the app under, so an app never needs to know that one.
 */
export function proposeSchedule(proposal: ScheduleProposal): boolean {
  ensureListener();
  if (!bridge.ready || proposalSent) return false;
  const parsed = scheduleProposalSchema.safeParse(proposal);
  if (!parsed.success) return false;
  proposalSent = true;
  postToHost({ type: FRAME_TYPES.appEvent, event: SCHEDULE_REQUEST_EVENT, data: parsed.data });
  return true;
}

/** TEST-ONLY: forgets the answered runIds and the one-per-page request, like a fresh page. */
export function __resetSnugScheduleForTests(): void {
  answeredRuns.clear();
  proposalSent = false;
}
