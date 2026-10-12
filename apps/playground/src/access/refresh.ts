// access/refresh.ts — a fetch another app asked for: the SOURCE's own code run on a reader's act
// (TASK-20261010-host-broker PR-3; ADR-0076 §6; contract v2 D-PR3-17, D-PR3-18, D-PR3-19; the
// spec's §24.6 (25)–(27) and §24.7 (28); AC22; contract v2.1 notes E2-Q1..Q9, E2-Q15, E1-Q11.
// PR-5: the host doors' form, the join and the abort seam — contract v2 D-PR5-17, D-PR5-18 and its
// v2.1 answers T-D Q1–Q7, Q18; S2, S6, S14, F6, F19).
//
// WHAT A REFRESH IS. A reader holding an access with `refresh: true` may ask the source to fetch
// new data before reading it. Nothing of the reader's reaches the source but its display name,
// folded to one line (`requestedBy`, S17) — and nothing of the source's reaches the reader but
// `fresh` (S10): the handler's own summary and notification go nowhere. The host runs the source
// WHERE IT LIVES, one instance (§24.7 (28)): the live frame when the source is open, else the ONE
// hidden frame — over the schedule handshake (`schedule-run { taskId: 'access-refresh', runId }`,
// the kv input `{ kind: 'refresh', requestedBy }`; `taskId` names no schedule, and NO run row is
// written) through the dispatchers `schedule/appRun.ts` exports (D-PR3-18): the same placement, the
// same handover loop (`MAX_HANDOVERS`), the same counting, the same bounds.
//
// THE POSTURE. The delegated record is begun with `posture: 'refresh'` (D-PR3-19): the run-scoped
// gate then REFUSES every mutating connected call of the window — nobody chose to run this, so
// there is nobody to ask — and records it `refused`; the hidden frame's standalone gate refuses as
// it always has. A record holding any refusal outranks the app's own `ok` (the scheduler's rule,
// E2-Q4): the answer is `ACCESS_REFRESH_FAILED` and the line's reason `refused` — the source tried
// to send a change on a reader's act, and the person should see it. The sticky generation is
// recorded for a refresh as for a schedule (S6): a handler that answers and POSTs afterwards meets
// the same after-run dialog D-PR1-3 built — worded for a fetch (`touchedPosture`, D-PR5-17).
//
// THE ORDER, and what each step leaves behind (E2-Q2):
//   (1) the three gates — the platform's scheduler seat with `capabilities.schedule !== false`
//       (E2-Q1), the `schedulerState` row (the scheduler's boot writes it; E1-Q11) and
//       `globalPause === false` (the user's "pause everything unattended") — else
//       `ACCESS_REFRESH_FAILED` "schedules are off for this file", not retryable: NO line, NO stamp;
//   (2) the cooldown — one dispatch per source per `ACCESS_REFRESH_COOLDOWN_MS`, in memory: within
//       it `{ fresh: false, reason: 'recent' }`, nothing run, no line (a FRAME asking while the
//       first is still in flight reads the same, E2-Q6 — a host door joins it instead, below);
//   (3) the ceiling, asked BEFORE dispatch over the FILE's day (the one counter there is) plus what
//       a schedule's run already spent (a host door's `spent`): no headroom for one more AI or
//       network call → `capped`, the `refreshed` line written, nothing stamped;
//   (4) the stamp, AT DISPATCH — a dispatch that then ends in failure stamped it all the same; one
//       that ends `busy` (the one-instance rule: a delegated run already in flight, or the hidden
//       frame already holding another run) never ran anything, and the stamp is put back;
//   (5)–(6) the dispatch, live or hidden, with the handover loop and ONE deadline
//       (`now + deps.resultTimeoutMs`, E2-Q9 — or a schedule's own sooner bound);
//   (7) the attempt's calls folded into `schedulerState.daily` (`foldDailyCalls`, shared with the
//       queue) — unless a schedule's run that asked is still waiting and carries them itself;
//   (8) the `refreshed` line on the SOURCE's history BEFORE the answer — `via` as given, the
//       reader's host-written library name, no `tables` (E2-Q15), and on failure a reason from the
//       fixed set `ACCESS_REFRESH_REASONS` (a handler's words never reach a line);
//   (9) the answer: `{ fresh: true }` after the source's read caches are dropped
//       (`clearSourceReadCaches`, the Write Broker's), else the code and the reader's sentence.
// The kv key is cleared once the dispatch ends, whatever happened (a key stranded by a crash is
// ≤ 1 KiB of inert kv the SDK never reads without its hint).
//
// ONE FLIGHT PER SOURCE, MANY WAITERS (D-PR5-17, D-PR5-18; F19, S14). A dispatch is a FLIGHT: one
// `refreshRuns` entry from its start to its end, spanning its handovers (the chip follows it), with
// the dispatch's OWN controller. Every door that waits on it joins it (`joinRefreshRun`) — the one
// that started it too, the frame's op included — and leaves when its own signal fires: a door's
// stop abandons ONLY its wait, and only the last one leaving abandons the dispatch. A HOST door (a
// fourth argument — the chat's or a schedule's *fetch new data first*) asking while a flight is up
// JOINS it before the cooldown is asked; a joiner also leaves at its own deadline, and hears `calls`
// of nothing (the flight is counted once, by whoever started it).
//
// THE FOUR WAYS A FLIGHT IS STOPPED, each the dispatch's controller aborted with its reason
// (`refreshAbortReason`): the person's act on the chip (`cancel`), the last waiter leaving
// (`abandoned`), an app delete (`deleted`) and a file swap (`reset`). Every waiter still there is
// answered `ACCESS_REFRESH_FAILED` with `ACCESS_APP_MESSAGES.refreshStopped`, not retryable. A
// cancel or an abandon keeps the cooldown stamp, clears no cache and writes its line with the
// reason `failed` (*the fetch didn't finish*; `refused` if the window refused a change) before the
// answer (T-D Q18); a delete writes no line (its history is going, or names an app that is gone). A
// RESET writes NOTHING — no line, no fold, no kv clear in the file that is now there (S6): the
// engine captures a file epoch when a flight starts and re-checks it after every await, and the
// reset clears the cooldowns and the remembered outcomes with it. The epoch is the LEAF's
// (`refreshResetEpoch`, Gate-5 fold G5-18): most resets find nothing in flight, so the engine reads
// it at the top of every ask (and of `lastRefreshOf`) as well as after every await. While a swap is
// LATCHED (`refreshSwapLatched`, SB-3) every ask answers stopped at once — nothing dispatched, no
// line, no fold. A flight stopped while the source's LIVE frame held it does not end its delegated
// record (S2): the handler may still be running, so the record is HELD — refusing every mutating
// call, counting — until the handler's result arrives, the dispatch's original deadline passes or
// the frame goes away (`keepRefusing`); a change refused under the hold is written as one more line,
// `refused`, when it ends (SB-7a). A stop that lands before the source was rung holds nothing: no
// handler of that run can be running (P3-7).
//
// WHO LOADS THIS. The access service reaches this module and `defaultAppRunDeps` through ONE lazy
// edge (F8): `appRun.ts` imports `composeAppRuntime` → the access handler → the service, so a
// top-level import the other way would close a cycle. Tests pass their own `AppRunDeps`. No
// module under access/ is called at this module's top level (the load-order rule) — `refreshRuns.ts`
// is a leaf store. The sentences a person reads are `access/copy.ts`'s and `schedule/copy.ts`'s;
// the strings here are machine tokens only (D-PR3-25, D-PR5-24).

import type { AppRecord, UserDb } from '@snugprotocol/db';
import { ACCESS_ERROR_CODES, ACCESS_REFRESH_COOLDOWN_MS, type AccessErrorCode, type AccessLogEntry, type AccessLogVia, type AccessRefreshReason } from '@snugprotocol/protocol';

import { oneLine } from '../agent/sharedDdl.js';
import { dispatchHidden, dispatchLive, parseScheduleResult, type AppRunDeps, type Dispatch, type DispatchEnd } from '../schedule/appRun.js';
import { REFRESH_RUN, handedOverTwice } from '../schedule/copy.js';
import { countersSoFar, foldDailyCalls, wouldExceedCeiling, type Calls } from '../schedule/protection.js';
import { MAX_HANDOVERS, delegatedRunFor, holdDelegatedRun, placeRun, releaseDelegatedRun, type Placement, type ScheduledRefusal } from '../schedule/runPlacement.js';
import { SCHEDULE_RESULT_EVENT, scheduleKvKey } from '../schedule/scheduleKey.js';
import { createScheduledConfirmGate } from '../schedule/scheduledConfirmGate.js';
import { ACCESS_APP_MESSAGES } from './copy.js';
import type { AnyAccessGrant } from './grantFacts.js';
import { accessDeps, iso, readerNameOf } from './grants.js';
import {
  beginRefreshRun,
  endRefreshRun,
  joinRefreshRun,
  refreshAbortReason,
  refreshResetEpoch,
  refreshSwapLatched,
  setRefreshPlacement,
  type RefreshPlacement,
  type RefreshRun,
} from './refreshRuns.js';
import * as writeBroker from './writeBroker.js';

/** The `taskId` a refresh rides the handshake under — the ONE signal beside `input.kind` that this is no schedule (D-PR3-17). */
export const REFRESH_TASK_ID = 'access-refresh';

/** Which door asked for the fetch — carried onto the `refreshed` line as given. */
export type RefreshVia = AccessLogVia;

export interface RefreshInput {
  /** The access the reader holds on the source — the policy admitted it (`refresh: true`) before this engine is reached. */
  grant: AnyAccessGrant;
  /** The reader's RAW library name (E2-Q7); folded to one line ONCE, here, where the kv input is built. */
  requestedBy: string;
  via: RefreshVia;
}

/** What the service answers the frame from (D-PR3-14): `fresh`, `recent`, or the code and the reader's sentence. */
export type RefreshOutcome =
  | { ok: true; op: 'refresh'; fresh: true }
  | { ok: true; op: 'refresh'; fresh: false; reason: 'recent' }
  | { ok: false; code: AccessErrorCode; message: string; retryable: boolean };

/**
 * A HOST DOOR's call — the chat's or a schedule's *fetch new data first* (TASK-20261010-host-broker
 * PR-5, D-PR5-18; T-D Q3/Q4): a fourth argument marks it. It answers `{ outcome, calls }`, joins a
 * refresh already in flight for the source before the cooldown is asked, and honours `signal`
 * (abandoning only its own wait), `fold: false` (a schedule's run folds its day itself), `spent`
 * (what the run spent before, counted by the ceiling) and `deadline` (on `Date.now()`'s clock: a
 * schedule's bound — a joiner stops waiting then; a dispatch it starts is bounded by it). The
 * frame's three-argument call is unchanged — its answer is the outcome alone, the wire's bytes.
 */
export interface RefreshDoorOptions {
  signal?: AbortSignal;
  fold?: false;
  spent?: Calls;
  deadline?: number;
}

/** What a host door hears: the frame's outcome and what the attempt spent. */
export interface RefreshDoorAnswer {
  outcome: RefreshOutcome;
  calls: Calls;
}

/** When a source was last dispatched and, once that dispatch settled, whether it delivered — what a host door says of a `recent` answer. */
export interface LastRefresh {
  /** The dispatch's instant (ISO) — the cooldown's stamp. */
  at: string;
  /** Absent while that dispatch is still in flight, or when it was another session's. */
  ok?: boolean;
}

const NONE: Readonly<Calls> = { ai: 0, net: 0 };
/** Nothing spent, as an answer's own object — a door may add to what it is handed. */
const nothing = (): Calls => ({ ...NONE });

/** Every answer is a fresh object: the service hands it to the frame, and nothing here is shared between calls. */
const fresh = (): RefreshOutcome => ({ ok: true, op: 'refresh', fresh: true });
const recent = (): RefreshOutcome => ({ ok: true, op: 'refresh', fresh: false, reason: 'recent' });
const off = (): RefreshOutcome => ({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, message: ACCESS_APP_MESSAGES.refreshOff, retryable: false });
const busy = (): RefreshOutcome => ({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_BUSY, message: ACCESS_APP_MESSAGES.busy, retryable: true });
/** A stop — the chip's act, a reset, a delete, or the door's own signal: the fetch did not finish, and asking again now would not help. */
const stopped = (): RefreshOutcome => ({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, message: ACCESS_APP_MESSAGES.refreshStopped, retryable: false });
/** `ACCESS_REFRESH_FAILED` with the reader's sentence for the reason (E2-Q3) — never a source fact, never the handler's words. */
const failed = (reason: AccessRefreshReason): RefreshOutcome => ({
  ok: false,
  code: ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED,
  message: reason === 'no-handler' ? ACCESS_APP_MESSAGES.refreshNoHandler : ACCESS_APP_MESSAGES.refreshFailed(reason),
  retryable: false,
});

/** What a flight came to: the outcome its waiters are answered with, and what the dispatch spent. */
interface Settlement {
  outcome: RefreshOutcome;
  calls: Calls;
}

/** The door that started a flight: whether its calls fold into the day, and whether it is still waiting to carry them itself. */
interface Starter {
  readonly fold: boolean;
  waiting: boolean;
}

/** One dispatch in flight for one source — its `refreshRuns` entry, who started it, and what it will come to. */
interface Flight {
  readonly run: RefreshRun;
  readonly starter: Starter;
  readonly settled: Promise<Settlement>;
}

/** `sourceAppId → the instant of its last dispatch` — the cooldown, in memory for this session. */
const lastDispatchAt = new Map<string, number>();
/** `sourceAppId → whether its last SETTLED dispatch delivered` (D-PR5-18) — read back by a host door's `recent`. */
const lastDelivered = new Map<string, boolean>();
/** `sourceAppId → the flight up for it` — what a host door joins. */
const inFlight = new Map<string, Flight>();
/** The held delegated records of stopped LIVE flights (S2), each with its release. */
const holds = new Set<() => void>();
/**
 * Moves at every reset (S6): a flight captures it when it starts and re-checks it after every await —
 * a mismatch means the file it was writing to is gone, and nothing more is written. Read through
 * `currentFileEpoch`, which follows the leaf's reset epoch first.
 */
let fileEpoch = 0;
/** The leaf's reset epoch as this engine last read it (G5-18) — the leaf's starts at 0 too. */
let seenResetEpoch = 0;

/** A file swap: the old file's cooldowns, outcomes and flights go with it. */
function forgetFile(): void {
  fileEpoch += 1;
  lastDispatchAt.clear();
  lastDelivered.clear();
  inFlight.clear();
}

/**
 * The file this engine writes to, the leaf read FIRST (G5-18, P3-1): a reset since the last read —
 * one that found nothing in flight too — forgets the old file here, before anything is answered from it.
 */
function currentFileEpoch(): number {
  const reset = refreshResetEpoch();
  if (reset !== seenResetEpoch) {
    seenResetEpoch = reset;
    forgetFile();
  }
  return fileEpoch;
}

export function __resetRefreshForTests(): void {
  for (const release of [...holds]) release();
  forgetFile();
}

/** When `sourceAppId` was last dispatched and how that went — `undefined` when it was not, this session (nor since the file was swapped). */
export function lastRefreshOf(sourceAppId: string): LastRefresh | undefined {
  currentFileEpoch();
  const at = lastDispatchAt.get(sourceAppId);
  if (at === undefined) return undefined;
  const ok = lastDelivered.get(sourceAppId);
  return { at: iso(at), ...(ok !== undefined ? { ok } : {}) };
}

/** How a dispatch settled for the reader: new data, the one-instance rule, or a reason from the fixed set. */
type Settled = { kind: 'fresh' } | { kind: 'busy' } | { kind: 'failed'; reason: AccessRefreshReason };

/**
 * The record outranks the app's own answer (E2-Q4): any refusal → `refused`. Then the end itself:
 * the app's `ok` → fresh, its `{ ok: false }` → `failed` (E2-Q5); never announced → `no-handler`;
 * the bound → `timeout`; the one-instance rule → busy; everything else that stopped the run — a
 * cut frame, a second handover, a kv write that failed — is `failed` to the reader.
 */
function settle(end: DispatchEnd, refused: readonly ScheduledRefusal[]): Settled {
  if (refused.length > 0) return { kind: 'failed', reason: 'refused' };
  switch (end.kind) {
    case 'result':
      return end.result.ok ? { kind: 'fresh' } : { kind: 'failed', reason: 'failed' };
    case 'no-handler':
      return { kind: 'failed', reason: 'no-handler' };
    case 'timeout':
      return { kind: 'failed', reason: 'timeout' };
    case 'busy':
      return { kind: 'busy' };
    case 'aborted':
    case 'failed':
    case 'blocked':
    case 'handover':
      return { kind: 'failed', reason: 'failed' };
    default: {
      const never: never = end;
      return never;
    }
  }
}

/** The `refreshed` line (D-PR3-6): host-written throughout — the reader's library name, `via` as given, a reason only on failure, no `tables` (E2-Q15). */
function refreshedLine(db: UserDb, grant: AnyAccessGrant, via: RefreshVia, at: number, reason?: AccessRefreshReason): AccessLogEntry {
  return {
    at: iso(at),
    kind: 'refreshed',
    grantId: grant.id,
    readerAppId: grant.readerAppId,
    readerName: readerNameOf(db, grant.readerAppId),
    via,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** Best effort, as every lifecycle line: the fetch happened (or was refused) whether or not the history had room for the line. */
function logQuietly(db: UserDb, sourceAppId: string, entry: AccessLogEntry): void {
  try {
    db.appendAccessLog(sourceAppId, entry);
  } catch {
    // the history refused the line (its caps, or a source swept meanwhile) — never a reason to change the answer
  }
}

/** Where the chip says the source's code runs. */
const placementOf = (placement: Placement): RefreshPlacement => (placement === 'live' ? 'live' : 'headless');

/**
 * The whole run of one refresh: where the source lives, at most one handover, one deadline; the
 * tally and every refusal summed across attempts. Each attempt is handed what the earlier ones
 * SPENT (Gate-5 ENG-3) on top of what the door's run spent before (`spent`, D-PR5-18): the ceiling
 * a hidden attempt asks after a handover counts the live attempt's calls, as the executor's
 * `Dispatch.spent` counts a step's earlier attempts. `moved` hears every handover's destination.
 */
async function runRefresh(
  base: Omit<Dispatch, 'afterHandover' | 'spent'>,
  first: Placement,
  spent: Calls,
  moved: (to: Placement) => void,
): Promise<{ end: DispatchEnd; calls: Calls; refused: ScheduledRefusal[] }> {
  const calls: Calls = { ai: 0, net: 0 };
  const refused: ScheduledRefusal[] = [];
  let placement = first;
  let handovers = 0;
  for (;;) {
    const dispatch: Dispatch = { ...base, afterHandover: handovers > 0, spent: { ai: spent.ai + calls.ai, net: spent.net + calls.net } };
    const attempt = placement === 'live' ? await dispatchLive(dispatch) : await dispatchHidden(dispatch, createScheduledConfirmGate());
    calls.ai += attempt.calls.ai;
    calls.net += attempt.calls.net;
    refused.push(...attempt.refused);
    if (attempt.end.kind === 'handover') {
      if (handovers >= MAX_HANDOVERS) return { end: { kind: 'failed', message: handedOverTwice(base.app.displayName) }, calls, refused };
      handovers += 1;
      placement = attempt.end.to;
      moved(placement);
      continue;
    }
    return { end: attempt.end, calls, refused };
  }
}

/** What a held record needs to end as its flight would have: the run, its bounds, and what its line names. */
interface HeldRun {
  sourceAppId: string;
  runId: string;
  /** The dispatch's ORIGINAL deadline. */
  deadline: number;
  /** The file epoch the flight started in. */
  epoch: number;
  grant: AnyAccessGrant;
  via: RefreshVia;
}

/**
 * S2: a flight stopped while the source's OPEN frame held it. Its handler may still be running, so
 * the delegated record is held — refusing every mutating call, the access door closed, counting —
 * until the handler's result arrives (from the generation that was hinted, bound to this run), the
 * dispatch's ORIGINAL deadline passes or the frame goes away. Then the record ends, the sticky
 * after-run ask applies, and what it counted after its attempt reported is folded into the day —
 * and a change it REFUSED after the stop is written as one more `refreshed` line, `refused` (SB-7a:
 * a record holding a refusal outranks the app's own `ok`, so the person sees it) — unless the file
 * was swapped meanwhile (S6). Answers the release, or `undefined` when nothing was held.
 */
function keepRefusing(db: UserDb, deps: AppRunDeps, held: HeldRun): (() => void) | undefined {
  const { sourceAppId, runId, deadline, epoch, grant, via } = held;
  const record = delegatedRunFor(sourceAppId);
  if (record === undefined || record.runId !== runId || !holdDelegatedRun(sourceAppId, runId)) return undefined;
  const { generation } = record;
  // What the record had refused when the stop landed — what the stop's own line already says (its
  // attempt reads this same record within the same task).
  const refusedAtHold = record.refused.length;
  let stopEvents: () => void = () => undefined;
  let stopHosts: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    if (!holds.delete(release)) return;
    if (timer !== undefined) clearTimeout(timer);
    stopEvents();
    stopHosts();
    const ended = releaseDelegatedRun(sourceAppId, runId);
    // The record ended by its attempt (never rung), or a file swapped in since: nothing is folded or written.
    if (ended === undefined || epoch !== currentFileEpoch()) return;
    const at = accessDeps().now();
    foldDailyCalls(db, ended.late, iso(at));
    if (ended.refused.length > refusedAtHold) logQuietly(db, sourceAppId, refreshedLine(db, grant, via, at, 'refused'));
  };
  holds.add(release);
  stopEvents = deps.live.subscribeEvents(sourceAppId, (event, data, from) => {
    if (event === SCHEDULE_RESULT_EVENT && from === generation && parseScheduleResult(data, runId) !== undefined) release();
  });
  stopHosts = deps.live.subscribe((appId, live) => {
    if (appId === sourceAppId && !live) release();
  });
  timer = setTimeout(release, Math.max(0, deadline - Date.now()));
  return release;
}

/** Everything a flight needs to fly. */
interface FlightInput {
  db: UserDb;
  deps: AppRunDeps;
  input: RefreshInput;
  app: AppRecord;
  /** The stamp this dispatch replaced, and how that one went — put back when the one-instance rule answers (nothing ran). */
  previous: { at: number | undefined; delivered: boolean | undefined };
  opts: RefreshDoorOptions | undefined;
}

/**
 * Start a flight: its `refreshRuns` entry (the chip's), the dispatch under that entry's controller,
 * and what each of the four stops does the moment it lands. Registered in `inFlight` before the
 * dispatch's first await, so a host door asking in the same tick joins it.
 */
function startFlight({ db, deps, input, app, previous, opts }: FlightInput): Flight {
  const { grant, via } = input;
  const source = app.appId;
  const runId = crypto.randomUUID();
  const placement = placeRun(deps.live, source);
  const run = beginRefreshRun({ runId, sourceAppId: source, sourceName: app.displayName, requestedBy: grant.readerAppId, placement: placementOf(placement) });
  const starter: Starter = { fold: opts?.fold !== false, waiting: true };
  const epoch = currentFileEpoch();
  const { signal } = run.controller;
  // (5) `requestedBy` folded to ONE line at the one place the input is built (S17); the record's title reads it too.
  const requestedBy = oneLine(input.requestedBy);
  const refreshInput = { kind: 'refresh', requestedBy } as const;
  const key = scheduleKvKey(runId);
  // (6) The dispatch — the posture, the ids-only hint, the one deadline on the dispatchers' clock (as the executor's).
  const deadline = Math.min(Date.now() + deps.resultTimeoutMs, opts?.deadline ?? Number.POSITIVE_INFINITY);
  const base: Omit<Dispatch, 'afterHandover' | 'spent'> = {
    mode: 'unattended',
    posture: 'refresh',
    app,
    step: { kind: 'app-run', appId: source, input: refreshInput },
    deps,
    db,
    signal,
    now: () => new Date(accessDeps().now()),
    taskId: REFRESH_TASK_ID,
    runId,
    title: REFRESH_RUN.title(requestedBy),
    key,
    payload: { taskId: REFRESH_TASK_ID, runId, input: refreshInput },
    deadline,
  };

  let flight: Flight | undefined;
  /** The held record's release (S2), once a stop held one. */
  let hold: (() => void) | undefined;
  // What each stop does AT ONCE, before the dispatch even hears it: a reset forgets the file (the
  // leaf moved its epoch before aborting); any other stop takes the flight out of reach (a later door
  // reads the kept stamp, never a stopped run); and a stop on the open frame holds its record (S2).
  signal.addEventListener(
    'abort',
    () => {
      if (refreshAbortReason(signal) === 'reset') currentFileEpoch();
      else if (flight !== undefined && inFlight.get(source) === flight) inFlight.delete(source);
      hold = keepRefusing(db, deps, { sourceAppId: source, runId, deadline, epoch, grant, via });
    },
    { once: true },
  );

  const fly = async (): Promise<Settlement> => {
    let ran: Awaited<ReturnType<typeof runRefresh>>;
    try {
      ran = await runRefresh(base, placement, opts?.spent ?? NONE, (to) => setRefreshPlacement(runId, placementOf(to)));
    } finally {
      // A stop that landed before the source was rung (P3-7): the attempt ended the record itself — no
      // handler of this run can be running, so the hold has nothing left to wait for.
      if (hold !== undefined && delegatedRunFor(source)?.runId !== runId) hold();
      // The kv input, cleared — in the file it was written to only (S6), and only while its app is there.
      if (epoch === currentFileEpoch() && db.getApp(source) !== undefined) await db.driver.kvSet(source, key, null);
    }
    // A reset landed somewhere above: the file this flight wrote to is gone — nothing more is written.
    if (epoch !== currentFileEpoch()) return { outcome: stopped(), calls: nothing() };

    // (7) The attempt's calls on the file's day — unless the run that started this is still waiting to carry them.
    const endedAt = accessDeps().now();
    if (starter.fold || !starter.waiting) foldDailyCalls(db, ran.calls, iso(endedAt));

    // A stop that ended the dispatch: the chip's act, the last waiter leaving, or an app delete.
    const stop = ran.end.kind === 'aborted' ? refreshAbortReason(signal) : undefined;
    if (stop !== undefined) {
      lastDelivered.set(source, false);
      if (stop !== 'deleted') logQuietly(db, source, refreshedLine(db, grant, via, endedAt, ran.refused.length > 0 ? 'refused' : 'failed'));
      return { outcome: stopped(), calls: ran.calls };
    }

    const settled = settle(ran.end, ran.refused);
    if (settled.kind === 'busy') {
      // Nothing ran: the one-instance rule answered. The stamp is put back as it was (E2-Q2), no line.
      if (previous.at === undefined) lastDispatchAt.delete(source);
      else lastDispatchAt.set(source, previous.at);
      if (previous.delivered === undefined) lastDelivered.delete(source);
      else lastDelivered.set(source, previous.delivered);
      return { outcome: busy(), calls: ran.calls };
    }
    lastDelivered.set(source, settled.kind === 'fresh');
    // The source's code ran and reported success: whatever the record then outranks, its data may have changed, so the reader's caches go.
    if (ran.end.kind === 'result' && ran.end.result.ok) writeBroker.clearSourceReadCaches(db, source);
    // (8) The line before the answer; (9) the answer.
    if (settled.kind === 'failed') {
      logQuietly(db, source, refreshedLine(db, grant, via, endedAt, settled.reason));
      return { outcome: failed(settled.reason), calls: ran.calls };
    }
    logQuietly(db, source, refreshedLine(db, grant, via, endedAt));
    return { outcome: fresh(), calls: ran.calls };
  };

  let resolveSettled!: (settlement: Settlement) => void;
  let rejectSettled!: (err: unknown) => void;
  const settled = new Promise<Settlement>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  // Nobody may be left to hear a flight that fails (its last door stopped waiting): the rejection is still theirs to see, never an unhandled one.
  settled.catch(() => undefined);
  flight = { run, starter, settled };
  inFlight.set(source, flight);
  const own = flight;
  void fly()
    .finally(() => {
      // The flight is over: its entry goes (a no-op after a stop took it), and it is out of reach.
      endRefreshRun(runId);
      if (inFlight.get(source) === own) inFlight.delete(source);
    })
    .then(resolveSettled, rejectSettled);
  return flight;
}

/**
 * A door's wait on a flight: the flight's settlement — or, first, the door's own stop or its
 * deadline, which answer that door alone and leave the flight to its other waiters (S14). The
 * door that started the flight hears what it spent; a joiner hears `calls` of nothing.
 */
async function waitOn(flight: Flight, opts: RefreshDoorOptions | undefined, starter: boolean): Promise<Settlement> {
  const leave = joinRefreshRun(flight.run.runId);
  const { signal, deadline } = opts ?? {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  type Left = { left: 'stopped' | 'timeout' };
  const gaveUp = new Promise<Left>((resolve) => {
    if (signal !== undefined) {
      onAbort = () => resolve({ left: 'stopped' });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    // A joiner's own bound; a flight its door started is bounded by that door's deadline already.
    if (deadline !== undefined && !starter) timer = setTimeout(() => resolve({ left: 'timeout' }), Math.max(0, deadline - Date.now()));
  });
  try {
    const first = await Promise.race<Settlement | Left>([flight.settled, gaveUp]);
    if (!('left' in first)) return starter ? first : { outcome: first.outcome, calls: nothing() };
    if (starter) flight.starter.waiting = false;
    leave();
    return { outcome: first.left === 'stopped' ? stopped() : failed('timeout'), calls: nothing() };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Ask the source to fetch new data on the reader's behalf — see the header for the order and what
 * each step leaves behind. `deps` are the caller's (`defaultAppRunDeps()` in production, through
 * the service's lazy edge; a fake in the suites); nothing here reads a page store at load. The
 * host door's form (`opts`, PR-5) is declared first so the frame's stays the LAST overload — the
 * one `ReturnType` of the engine names.
 */
export function refreshSource(db: UserDb, deps: AppRunDeps, input: RefreshInput, opts: RefreshDoorOptions): Promise<RefreshDoorAnswer>;
export function refreshSource(db: UserDb, deps: AppRunDeps, input: RefreshInput): Promise<RefreshOutcome>;
export async function refreshSource(db: UserDb, deps: AppRunDeps, input: RefreshInput, opts?: RefreshDoorOptions): Promise<RefreshOutcome | RefreshDoorAnswer> {
  const door = opts !== undefined;
  const answer = (settlement: Settlement): RefreshOutcome | RefreshDoorAnswer => (door ? settlement : settlement.outcome);
  const now = (outcome: RefreshOutcome): RefreshOutcome | RefreshDoorAnswer => answer({ outcome, calls: nothing() });
  const { grant, via } = input;
  const source = grant.sourceAppId;

  // A reset since the last ask forgets the old file first (P3-1); while a swap is under way nothing starts (SB-3).
  currentFileEpoch();
  if (refreshSwapLatched()) return now(stopped());
  // A door that stopped before it asked asks nothing; one with no time left, likewise.
  if (opts?.signal?.aborted === true) return now(stopped());
  if (opts?.deadline !== undefined && opts.deadline <= Date.now()) return now(failed('timeout'));

  // (1) The three gates — no line, no stamp.
  const platform = deps.platform();
  if (platform.scheduler === undefined || platform.capabilities.schedule === false) return now(off());
  const state = db.getSchedulerState();
  if (state === undefined || state.globalPause) return now(off());

  // (2′) A host door JOINS a refresh already in flight for the source, before the cooldown (D-PR5-18); the frame never does (E2-Q6).
  if (door) {
    const flight = inFlight.get(source);
    if (flight !== undefined) return waitOn(flight, opts, false);
  }

  // (2) The cooldown — stamped at dispatch, so an ask inside the window reads `recent` whether the last dispatch is still in flight or long over.
  const askedAt = accessDeps().now();
  const previous = lastDispatchAt.get(source);
  if (previous !== undefined && askedAt - previous < ACCESS_REFRESH_COOLDOWN_MS) return now(recent());

  // The source is the app the access names; without its row there is nothing to run and no history to write on.
  const app = db.getApp(source);
  if (app === undefined) return now(failed('failed'));

  // (3) The ceiling, over the FILE's day plus what a schedule's run already spent, before anything is stamped or dispatched.
  if (wouldExceedCeiling(countersSoFar(db, opts?.spent ?? NONE, NONE, iso(askedAt)), { ai: 1, net: 1 }) !== undefined) {
    logQuietly(db, source, refreshedLine(db, grant, via, askedAt, 'capped'));
    return now(failed('capped'));
  }

  // (4) The stamp, at dispatch; (5)–(9) the flight, which this door waits on like any other.
  const delivered = lastDelivered.get(source);
  lastDispatchAt.set(source, askedAt);
  lastDelivered.delete(source);
  const flight = startFlight({ db, deps, input, app, previous: { at: previous, delivered }, opts });
  return answer(await waitOn(flight, opts, true));
}
