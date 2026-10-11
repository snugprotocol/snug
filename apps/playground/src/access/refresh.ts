// access/refresh.ts — a fetch another app asked for: the SOURCE's own code run on a reader's act
// (TASK-20261010-host-broker PR-3; ADR-0076 §6; contract v2 D-PR3-17, D-PR3-18, D-PR3-19; the
// spec's §24.6 (25)–(27) and §24.7 (28); AC22; contract v2.1 notes E2-Q1..Q9, E2-Q15, E1-Q11).
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
// the same after-run dialog D-PR1-3 built.
//
// THE ORDER, and what each step leaves behind (E2-Q2):
//   (1) the three gates — the platform's scheduler seat with `capabilities.schedule !== false`
//       (E2-Q1), the `schedulerState` row (the scheduler's boot writes it; E1-Q11) and
//       `globalPause === false` (the user's "pause everything unattended") — else
//       `ACCESS_REFRESH_FAILED` "schedules are off for this file", not retryable: NO line, NO stamp;
//   (2) the cooldown — one dispatch per source per `ACCESS_REFRESH_COOLDOWN_MS`, in memory: within
//       it `{ fresh: false, reason: 'recent' }`, nothing run, no line (a second ask while the first
//       is in flight reads the same, E2-Q6);
//   (3) the ceiling, asked BEFORE dispatch over the FILE's day (the one counter there is): no
//       headroom for one more AI or network call → `capped`, the `refreshed` line written, nothing
//       stamped;
//   (4) the stamp, AT DISPATCH — a dispatch that then ends in failure stamped it all the same; one
//       that ends `busy` (the one-instance rule: a delegated run already in flight, or the hidden
//       frame already holding another run) never ran anything, and the stamp is put back;
//   (5)–(6) the dispatch, live or hidden, with the handover loop and ONE deadline
//       (`now + deps.resultTimeoutMs`, E2-Q9);
//   (7) the attempt's calls folded into `schedulerState.daily` (`foldDailyCalls`, shared with the queue);
//   (8) the `refreshed` line on the SOURCE's history BEFORE the answer — `via` as given, the
//       reader's host-written library name, no `tables` (E2-Q15), and on failure a reason from the
//       fixed set `ACCESS_REFRESH_REASONS` (a handler's words never reach a line);
//   (9) the answer: `{ fresh: true }` after the source's read caches are dropped
//       (`clearSourceReadCaches`, the Write Broker's), else the code and the reader's sentence.
// The kv key is cleared in `finally`, whatever happened (a key stranded by a crash is ≤ 1 KiB of
// inert kv the SDK never reads without its hint).
//
// WHO LOADS THIS. The access service reaches this module and `defaultAppRunDeps` through ONE lazy
// edge (F8): `appRun.ts` imports `composeAppRuntime` → the access handler → the service, so a
// top-level import the other way would close a cycle. Tests pass their own `AppRunDeps`. No
// module under access/ is called at this module's top level (the load-order rule). The sentences
// a person reads are `access/copy.ts`'s and `schedule/copy.ts`'s; the strings here are machine
// tokens only (D-PR3-25).

import type { UserDb } from '@snugprotocol/db';
import { ACCESS_ERROR_CODES, ACCESS_REFRESH_COOLDOWN_MS, type AccessErrorCode, type AccessLogEntry, type AccessLogVia, type AccessRefreshReason } from '@snugprotocol/protocol';

import { oneLine } from '../agent/sharedDdl.js';
import { dispatchHidden, dispatchLive, type AppRunDeps, type Dispatch, type DispatchEnd } from '../schedule/appRun.js';
import { REFRESH_RUN, handedOverTwice } from '../schedule/copy.js';
import { countersSoFar, foldDailyCalls, wouldExceedCeiling, type Calls } from '../schedule/protection.js';
import { MAX_HANDOVERS, placeRun, type ScheduledRefusal } from '../schedule/runPlacement.js';
import { scheduleKvKey } from '../schedule/scheduleKey.js';
import { createScheduledConfirmGate } from '../schedule/scheduledConfirmGate.js';
import { ACCESS_APP_MESSAGES } from './copy.js';
import type { AnyAccessGrant } from './grantFacts.js';
import { accessDeps, iso, readerNameOf } from './grants.js';
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

/** `sourceAppId → the instant of its last dispatch` — the cooldown, in memory for this session. */
const lastDispatchAt = new Map<string, number>();

export function __resetRefreshForTests(): void {
  lastDispatchAt.clear();
}

const NONE: Calls = { ai: 0, net: 0 };

/** Every answer is a fresh object: the service hands it to the frame, and nothing here is shared between calls. */
const fresh = (): RefreshOutcome => ({ ok: true, op: 'refresh', fresh: true });
const recent = (): RefreshOutcome => ({ ok: true, op: 'refresh', fresh: false, reason: 'recent' });
const off = (): RefreshOutcome => ({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, message: ACCESS_APP_MESSAGES.refreshOff, retryable: false });
const busy = (): RefreshOutcome => ({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_BUSY, message: ACCESS_APP_MESSAGES.busy, retryable: true });
/** `ACCESS_REFRESH_FAILED` with the reader's sentence for the reason (E2-Q3) — never a source fact, never the handler's words. */
const failed = (reason: AccessRefreshReason): RefreshOutcome => ({
  ok: false,
  code: ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED,
  message: reason === 'no-handler' ? ACCESS_APP_MESSAGES.refreshNoHandler : ACCESS_APP_MESSAGES.refreshFailed(reason),
  retryable: false,
});

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

/**
 * The whole run of one refresh: where the source lives, at most one handover, one deadline; the
 * tally and every refusal summed across attempts. Each attempt is handed what the earlier ones
 * SPENT (Gate-5 ENG-3): the ceiling a hidden attempt asks after a handover counts the live
 * attempt's calls, as the executor's `Dispatch.spent` counts a step's earlier attempts.
 */
async function runRefresh(base: Omit<Dispatch, 'afterHandover' | 'spent'>): Promise<{ end: DispatchEnd; calls: Calls; refused: ScheduledRefusal[] }> {
  const source = base.step.appId;
  const calls: Calls = { ai: 0, net: 0 };
  const refused: ScheduledRefusal[] = [];
  let placement = placeRun(base.deps.live, source);
  let handovers = 0;
  for (;;) {
    const dispatch: Dispatch = { ...base, afterHandover: handovers > 0, spent: { ...calls } };
    const attempt = placement === 'live' ? await dispatchLive(dispatch) : await dispatchHidden(dispatch, createScheduledConfirmGate());
    calls.ai += attempt.calls.ai;
    calls.net += attempt.calls.net;
    refused.push(...attempt.refused);
    if (attempt.end.kind === 'handover') {
      if (handovers >= MAX_HANDOVERS) return { end: { kind: 'failed', message: handedOverTwice(base.app.displayName) }, calls, refused };
      handovers += 1;
      placement = attempt.end.to;
      continue;
    }
    return { end: attempt.end, calls, refused };
  }
}

/**
 * Ask the source to fetch new data on the reader's behalf — see the header for the order and what
 * each step leaves behind. `deps` are the caller's (`defaultAppRunDeps()` in production, through
 * the service's lazy edge; a fake in the suites); nothing here reads a page store at load.
 */
export async function refreshSource(db: UserDb, deps: AppRunDeps, input: RefreshInput): Promise<RefreshOutcome> {
  const { grant, via } = input;
  const source = grant.sourceAppId;

  // (1) The three gates — no line, no stamp.
  const platform = deps.platform();
  if (platform.scheduler === undefined || platform.capabilities.schedule === false) return off();
  const state = db.getSchedulerState();
  if (state === undefined || state.globalPause) return off();

  // (2) The cooldown — stamped at dispatch, so an ask inside the window reads `recent` whether the last dispatch is still in flight or long over.
  const askedAt = accessDeps().now();
  const previous = lastDispatchAt.get(source);
  if (previous !== undefined && askedAt - previous < ACCESS_REFRESH_COOLDOWN_MS) return recent();

  // The source is the app the access names; without its row there is nothing to run and no history to write on.
  const app = db.getApp(source);
  if (app === undefined) return failed('failed');

  // (3) The ceiling, over the FILE's day, before anything is stamped or dispatched.
  if (wouldExceedCeiling(countersSoFar(db, NONE, NONE, new Date(askedAt).toISOString()), { ai: 1, net: 1 }) !== undefined) {
    logQuietly(db, source, refreshedLine(db, grant, via, askedAt, 'capped'));
    return failed('capped');
  }

  // (4) The stamp, at dispatch.
  lastDispatchAt.set(source, askedAt);

  // (5) `requestedBy` folded to ONE line at the one place the input is built (S17); the record's title reads it too.
  const requestedBy = oneLine(input.requestedBy);
  const runId = crypto.randomUUID();
  const refreshInput = { kind: 'refresh', requestedBy } as const;
  const key = scheduleKvKey(runId);
  // (6) The dispatch — the posture, the ids-only hint, the one deadline on the dispatchers' clock (as the executor's).
  const base: Omit<Dispatch, 'afterHandover' | 'spent'> = {
    mode: 'unattended',
    posture: 'refresh',
    app,
    step: { kind: 'app-run', appId: source, input: refreshInput },
    deps,
    db,
    signal: new AbortController().signal,
    now: () => new Date(accessDeps().now()),
    taskId: REFRESH_TASK_ID,
    runId,
    title: REFRESH_RUN.title(requestedBy),
    key,
    payload: { taskId: REFRESH_TASK_ID, runId, input: refreshInput },
    deadline: Date.now() + deps.resultTimeoutMs,
  };

  let ran: Awaited<ReturnType<typeof runRefresh>>;
  try {
    ran = await runRefresh(base);
  } finally {
    await db.driver.kvSet(source, key, null);
  }

  // (7) The attempt's calls on the file's day.
  const endedAt = accessDeps().now();
  foldDailyCalls(db, ran.calls, new Date(endedAt).toISOString());

  const settled = settle(ran.end, ran.refused);
  if (settled.kind === 'busy') {
    // Nothing ran: the one-instance rule answered. The stamp is put back as it was (E2-Q2), no line.
    if (previous === undefined) lastDispatchAt.delete(source);
    else lastDispatchAt.set(source, previous);
    return busy();
  }
  // The source's code ran and reported success: whatever the record then outranks, its data may have changed, so the reader's caches go.
  if (ran.end.kind === 'result' && ran.end.result.ok) writeBroker.clearSourceReadCaches(db, source);
  // (8) The line before the answer; (9) the answer.
  if (settled.kind === 'failed') {
    logQuietly(db, source, refreshedLine(db, grant, via, endedAt, settled.reason));
    return failed(settled.reason);
  }
  logQuietly(db, source, refreshedLine(db, grant, via, endedAt));
  return fresh();
}
