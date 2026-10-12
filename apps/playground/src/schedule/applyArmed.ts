// schedule/applyArmed.ts — the WALK an armed schedule's run takes at the queue's pooling point
// (TASK-20261010-host-broker PR-4; contract v2 D-PR4-11, v2.1 Q9/Q10; Gate 5 A3/A4/A6/A8; ADR-0076
// §9 — ADR-0033's shape, its first arming surface).
//
// A schedule the user let make its changes on its own (`writeAuthority`) does not leave its *Ask
// <App>'s AI* step's proposed changes waiting for an OK: after every step, BEFORE the run row is
// written, the queue hands this walk the run's ARMABLE items (only `ok` steps' — never an aborted
// run's; both rules are the queue's) and it makes what it may, through the Write Broker's own-write
// engine, under the authority's bounds. The order, every step observable:
//  1. `stillArmed()` — nothing is touched for a schedule that is no longer armed, nor for a run the
//     user (or a file swap, a pause, the bound) has aborted since: the run's own signal is part of it;
//  2. the items PARTITIONED by `ownCapturable` (A4) — a change whose undo could not be built (a
//     function, arithmetic, a conflict clause, no WHERE) is held `cannot-undo` at once and is never
//     part of the batch below, so it can neither be made unundoable nor sink the changes beside it;
//  3. `inTransaction(app)` — the app mid-change holds the rest `busy`: the re-dry-run below is an
//     export, and an export would discard the app's open transaction (D-PR4-5);
//  4. the capturable items re-dry-run IN ORDER on ONE scratch copy (`db.scratchRun`, the chat card's
//     rule) — those FRESH sequential counts are the truth: the seat's `expectChanges` and the
//     budget. The step-time counts were each dry-run alone, and nobody saw them as a promise (F5);
//  5. the longest PREFIX whose sum ≤ `rowsPerRun` — an item past the budget ends it, and it and
//     everything after it wait, held `over-limit`; a prefix whose fresh counts are ALL zero has
//     nothing left to change and never reaches the seat — those items simply leave the waiting
//     list, and no `applied` group claims a change of nothing (A8);
//  6. ONE `applyOwnWrite` call for the prefix (`requireUndo: true`, the task's own bucket,
//     `authority: 'task'` by name, `via: 'schedule'`), its `stillArmed` evaluated after its last
//     await, immediately before the seat: the run not aborted ∧ the schedule present ∧ on ∧
//     unpaused ∧ the SAME `armedAt` (a re-arming is a new consent, given after these changes were
//     proposed) ∧ the app still at `armedVersion` and installed BEFORE the consent was given (A6 —
//     a reinstall under the same id never inherits it) ∧ no global pause. It reads the FILE, never
//     the copy captured at claim. A version that moved, or an app installed since, disarms too, with
//     the `app-updated` trace — the belt for a version that arrived by a trusted pull, which reaches
//     no fan-out (D-PR4-8);
//  7. on the commit, in the SAME synchronous tick as the undo entry, the claim row rewritten with the
//     `applied` group (`onCommitted`) — so a crash between the two can never leave a change made with
//     no row naming its undo (F20). The group carries each item's summary and its count, never SQL.
// The pre-seat awaits (3, 4) RACE the run's signal (A3): an abort that lands while the app answers
// or the copy is built ends the walk at once — every armed item held `stopped`, the queue folds the
// run `interrupted` — and a copy that never comes back can never wedge the queue. Once the seat is
// asked it is atomic: what it commits is the run's (the stop window the threat delta names).
//
// THE ANSWER is ONE verdict per input index (A4): `made` (it left the waiting list — made, or, past
// an all-zero prefix, nothing left to make), `held` with its reason, or `untouched` (another app's —
// the authority covers the schedule's OWN app only, D-PR4-2, so it waits unheld). The queue maps its
// pool by index, never by "the first N of the armed app". `items` is the same answer as the run's
// waiting list. A refusal of the seat holds the whole prefix with its reason; the held reasons are
// ONE table (`SCHEDULE_HELD_REASONS`), worded by the result page. A held item stays pending — it
// waits for the user's OK like any other.
//
// The model never sees its own changes made mid-turn: the walk runs after the steps answered.

import { ownCapturable, type UserDb } from '@snugprotocol/db';
import { TASK_WRITE_AUTHORITY, type ScheduleHeldReason, type ScheduleProposalItem, type ScheduleRun, type ScheduleRunApplied, type ScheduledTask } from '@snugprotocol/protocol';

import { applyOwnWrite } from '../access/writeBroker.js';
import { disarmForAppUpdate } from './appDrift.js';
import { armableAppOf, installedAfterArming } from './taskShape.js';

/** What the walk decided for ONE armable item, by its index in the input. */
export type ArmedVerdict = { made: true } | { held: ScheduleHeldReason } | { untouched: true };

/** What the walk made, and what still waits — each item it did not make carrying why (`held`), an item it could not touch as it was. */
export interface ArmedWalk {
  applied?: ScheduleRunApplied;
  /** The run's waiting list after the walk, in input order. */
  items: ScheduleProposalItem[];
  /** One verdict per input item, by index (A4). */
  verdicts: ArmedVerdict[];
}

/** The walk's options: the clock, and the run's own abort — the user's cancel, a file swap, a pause, the bound (A3). */
export interface ArmedWalkOptions {
  now: () => Date;
  signal?: AbortSignal | undefined;
}

const MADE: ArmedVerdict = { made: true };
const UNTOUCHED: ArmedVerdict = { untouched: true };

/** The answer that an abort raced a pre-seat await to. */
const ABORTED: unique symbol = Symbol('aborted');

/** `work`, or `ABORTED` the moment the signal fires — whichever comes first; the listener never outlives the race. */
async function raced<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    work.catch(() => undefined); // left behind: its rejection is nobody's
    return ABORTED;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The walk — see the header. `run` is the claim the queue wrote; `task` the copy captured at claim
 * (what the steps ran under); `items` the run's armable items, in the order the steps proposed them.
 * Never throws: the file or the app that cannot answer holds what was not made, `failed`.
 */
export async function applyArmed(db: UserDb, run: ScheduleRun, task: ScheduledTask, items: readonly ScheduleProposalItem[], options: ArmedWalkOptions): Promise<ArmedWalk> {
  const authority = task.writeAuthority;
  const appId = armableAppOf(task.steps);
  const asIs = (): ArmedWalk => ({ items: [...items], verdicts: items.map(() => UNTOUCHED) });
  if (authority === undefined || appId === undefined) return asIs();
  /** The input indexes of this app's items — the only ones the authority covers. */
  const own = items.flatMap((item, index) => (item.appId === appId ? [index] : []));
  if (own.length === 0) return asIs();
  const { signal } = options;

  /** The answer from one verdict per OWN item (by its input index) — another app's untouched. */
  const answer = (verdictOf: ReadonlyMap<number, ArmedVerdict>, applied?: ScheduleRunApplied): ArmedWalk => {
    const verdicts = items.map((_item, index) => verdictOf.get(index) ?? UNTOUCHED);
    const waiting = items.flatMap((item, index) => {
      const verdict = verdicts[index] ?? UNTOUCHED;
      if ('made' in verdict) return [];
      return ['held' in verdict ? { ...item, held: verdict.held } : item];
    });
    return { ...(applied !== undefined ? { applied } : {}), items: waiting, verdicts };
  };
  /** Every own item held for the one reason — nothing was made. */
  const holdAll = (reason: ScheduleHeldReason): ArmedWalk => answer(new Map(own.map((index) => [index, { held: reason }])));

  // The authority as the FILE holds it now — never the copy captured at claim (S7) — and the run not aborted (A3).
  const stillArmed = (): boolean => {
    if (signal?.aborted === true) return false;
    const current = db.getScheduledTask(task.id);
    const armed = current?.writeAuthority;
    if (current === undefined || armed === undefined || armed.armedAt !== authority.armedAt) return false;
    const app = db.getApp(appId);
    if (app === undefined) return false;
    if (app.currentVersion !== armed.armedVersion || installedAfterArming(app, armed)) {
      // The belt (D-PR4-8, A6): new code — or a new app under the same id — never inherits the consent, and the row says why it stopped.
      db.putScheduledTask(disarmForAppUpdate(current, options.now().toISOString()));
      return false;
    }
    return current.enabled && current.pausedReason === undefined && db.getSchedulerState()?.globalPause !== true;
  };

  const walk = async (): Promise<ArmedWalk> => {
    if (!stillArmed()) return holdAll('stopped');
    // The partition FIRST (A4): a change whose undo could not be built never joins the batch.
    const verdictOf = new Map<number, ArmedVerdict>();
    const capturable: number[] = [];
    for (const index of own) {
      const item = items[index];
      if (item !== undefined && ownCapturable(item.sql).ok) capturable.push(index);
      else verdictOf.set(index, { held: 'cannot-undo' });
    }
    const holdRest = (reason: ScheduleHeldReason): ArmedWalk => {
      for (const index of capturable) verdictOf.set(index, { held: reason });
      return answer(verdictOf);
    };
    if (capturable.length === 0) return answer(verdictOf);
    const batch = capturable.map((index) => items[index] as ScheduleProposalItem);

    // FIRST of the awaits — the driver's record: the re-dry-run is an export, which would discard the app's open transaction.
    const busy = await raced(db.driver.inTransaction(appId), signal);
    if (busy === ABORTED) return holdAll('stopped');
    if (busy) return holdRest('busy');
    // The fresh counts, IN ORDER on one copy — each item measured after the ones before it (F5).
    const dryRun = await raced(
      db.scratchRun(
        appId,
        batch.map((item) => ({ sql: item.sql })),
      ),
      signal,
    );
    if (dryRun === ABORTED) return holdAll('stopped');
    const counts: number[] = [];
    let budget = authority.rowsPerRun;
    let failedAt: number | undefined;
    for (const [position, statement] of dryRun.statements.entries()) {
      if (statement.error !== undefined) {
        failedAt = position;
        break;
      }
      const changes = statement.changes ?? 0;
      if (changes > budget) break;
      budget -= changes;
      counts.push(changes);
    }
    // Past the prefix: the item that would not run on the copy and those measured after it, `failed`; the rest past the budget, `over-limit`.
    for (const [position, index] of capturable.entries()) {
      if (position >= counts.length) verdictOf.set(index, { held: failedAt !== undefined && position >= failedAt ? 'failed' : 'over-limit' });
    }
    const prefix = capturable.slice(0, counts.length);
    if (prefix.length === 0) return answer(verdictOf);
    // Nothing left to change (A8): the prefix leaves the waiting list without a seat, an entry or a group.
    if (counts.every((count) => count === 0)) {
      for (const index of prefix) verdictOf.set(index, MADE);
      return answer(verdictOf);
    }
    const making = batch.slice(0, prefix.length);

    /** The group the run row names: each made change's summary and fresh count — never SQL — and its undo, or that it has none. */
    const appliedOf = (outcome: { changes: readonly number[]; undoId?: string }): ScheduleRunApplied => ({
      appId,
      ...(outcome.undoId !== undefined ? { undoId: outcome.undoId } : { undoable: false }),
      items: making.map((item, position) => ({ ...(item.summary !== undefined ? { summary: item.summary } : {}), changes: outcome.changes[position] ?? 0 })),
    });
    const outcome = await applyOwnWrite(db, {
      appId,
      bucket: task.id,
      statements: making.map((item) => item.sql),
      params: making.map(() => []),
      expectChanges: counts,
      maxChanges: authority.rowsPerRun,
      requireUndo: true,
      authority: TASK_WRITE_AUTHORITY,
      via: 'schedule',
      runId: run.id,
      taskId: task.id,
      stillArmed,
      // The same tick as the undo entry (F20): the claim row names what was made before anything else can run.
      onCommitted: (committed) => {
        try {
          db.putScheduleRun({ ...run, applied: appliedOf(committed) });
        } catch {
          // The claim row is refused (the schedule went away mid-run): the queue's final row carries the group all the same.
        }
      },
    });
    // An abort the seat's last look saw: nothing was made, and every armed item says it was stopped (A3).
    if (!outcome.ok && signal?.aborted === true) return holdAll('stopped');
    for (const index of prefix) verdictOf.set(index, outcome.ok ? MADE : { held: outcome.reason });
    return answer(verdictOf, outcome.ok ? appliedOf(outcome) : undefined);
  };

  try {
    return await walk();
  } catch {
    // The file or the app could not answer (an export that failed, a refused row): nothing was made — the seat never throws.
    return holdAll('failed');
  }
}
