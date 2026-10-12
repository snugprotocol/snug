// schedule/applyArmed.ts — the WALK an armed schedule's run takes at the queue's pooling point
// (TASK-20261010-host-broker PR-4; contract v2 D-PR4-11, v2.1 Q9/Q10; ADR-0076 §9 — ADR-0033's shape,
// its first arming surface).
//
// A schedule the user let make its changes on its own (`writeAuthority`) does not leave its *Ask
// <App>'s AI* step's proposed changes waiting for an OK: after every step, BEFORE the run row is
// written, the queue hands this walk the run's ARMABLE items (only `ok` steps' — never an aborted
// run's; both rules are the queue's) and it makes what it may, through the Write Broker's own-write
// engine, under the authority's bounds. The order, every step observable:
//  1. `stillArmed()` — nothing is touched for a schedule that is no longer armed;
//  2. `inTransaction(app)` FIRST — the app mid-change holds every item `busy`: the re-dry-run below
//     is an export, and an export would discard the app's open transaction (D-PR4-5);
//  3. the items re-dry-run IN ORDER on ONE scratch copy (`db.scratchRun`, the chat card's rule) —
//     those FRESH sequential counts are the truth: the seat's `expectChanges` and the budget. The
//     step-time counts were each dry-run alone, and nobody saw them as a promise (F5);
//  4. the longest PREFIX whose sum ≤ `rowsPerRun` — an item past the budget ends it, and it and
//     everything after it wait, held `over-limit`;
//  5. ONE `applyOwnWrite` call for the prefix (`requireUndo: true`, the task's own bucket,
//     `authority: 'task'`, `via: 'schedule'`), its `stillArmed` evaluated after its last await,
//     immediately before the seat: the schedule present ∧ on ∧ unpaused ∧ the SAME `armedAt` (a
//     re-arming is a new consent, given after these changes were proposed) ∧ the app still at
//     `armedVersion` ∧ no global pause. It reads the FILE, never the copy captured at claim. A version
//     that moved disarms too, with the `app-updated` trace — the belt for a version that arrived by a
//     trusted pull, which reaches no fan-out (D-PR4-8);
//  6. on the commit, in the SAME synchronous tick as the undo entry, the claim row rewritten with the
//     `applied` group (`onCommitted`) — so a crash between the two can never leave a change made with
//     no row naming its undo (F20). The group carries each item's summary and its count, never SQL.
// A refusal holds the whole prefix with its reason; the held reasons are ONE table
// (`SCHEDULE_HELD_REASONS`), worded by the result page. A held item stays pending — it waits for the
// user's OK like any other. The authority covers the schedule's OWN app only (D-PR4-2): an item for
// another app is never armable here and waits, unheld.
//
// The model never sees its own changes made mid-turn: the walk runs after the steps answered.

import type { UserDb } from '@snugprotocol/db';
import { OWN_WRITE_AUTHORITIES, type ScheduleHeldReason, type ScheduleProposalItem, type ScheduleRun, type ScheduleRunApplied, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';

import { applyOwnWrite } from '../access/writeBroker.js';
import { disarmForAppUpdate } from './appDrift.js';
import { appIdsOf } from './taskShape.js';

/** What the walk made, and what still waits — each item it did not make carrying why (`held`), an item it could not touch as it was. */
export interface ArmedWalk {
  applied?: ScheduleRunApplied;
  items: ScheduleProposalItem[];
}

/**
 * The ONE app a schedule may make changes to on its own (v2.1 N4): it asks at least one app's AI,
 * and every step that names an app names that one — else none. The arming act offers the authority
 * by this rule and the walk applies under it.
 */
export function armableAppOf(steps: readonly ScheduleStep[]): string | undefined {
  if (!steps.some((step) => step.kind === 'app-think')) return undefined;
  const apps = appIdsOf(steps);
  return apps.length === 1 ? apps[0] : undefined;
}

/** A schedule's standing authority over its own app's data — spelled once, in the protocol (its order pinned there), never here (D-PR4-7). */
const [, SCHEDULE_AUTHORITY] = OWN_WRITE_AUTHORITIES;

const held = (item: ScheduleProposalItem, reason: ScheduleHeldReason): ScheduleProposalItem => ({ ...item, held: reason });

/**
 * The walk — see the header. `run` is the claim the queue wrote; `task` the copy captured at claim
 * (what the steps ran under); `items` the run's armable items, in the order the steps proposed them.
 * Answers the applied group, when anything was made, and every item not made, in order.
 */
export async function applyArmed(db: UserDb, run: ScheduleRun, task: ScheduledTask, items: readonly ScheduleProposalItem[], options: { now: () => Date }): Promise<ArmedWalk> {
  const authority = task.writeAuthority;
  const appId = armableAppOf(task.steps);
  if (authority === undefined || appId === undefined) return { items: [...items] };
  const own = items.filter((item) => item.appId === appId);
  if (own.length === 0) return { items: [...items] };

  /** Every item, the ones in `prefix` made and the other own ones held by `reasonOf` — another app's as it was. */
  const answer = (prefixLength: number, reasonOf: (index: number) => ScheduleHeldReason | undefined, applied?: ScheduleRunApplied): ArmedWalk => {
    let ownIndex = -1;
    const waiting = items.flatMap((item) => {
      if (item.appId !== appId) return [item];
      ownIndex += 1;
      if (applied !== undefined && ownIndex < prefixLength) return [];
      const reason = reasonOf(ownIndex);
      return [reason === undefined ? item : held(item, reason)];
    });
    return { ...(applied !== undefined ? { applied } : {}), items: waiting };
  };
  const holdAll = (reason: ScheduleHeldReason): ArmedWalk => answer(0, () => reason);

  // The authority as the FILE holds it now — never the copy captured at claim (S7).
  const stillArmed = (): boolean => {
    const current = db.getScheduledTask(task.id);
    const armed = current?.writeAuthority;
    if (current === undefined || armed === undefined || armed.armedAt !== authority.armedAt) return false;
    const version = db.getApp(appId)?.currentVersion;
    if (version !== undefined && version !== armed.armedVersion) {
      // The belt (D-PR4-8): new code never inherits the consent — and the row says why it stopped.
      db.putScheduledTask(disarmForAppUpdate(current, options.now().toISOString()));
      return false;
    }
    return version !== undefined && current.enabled && current.pausedReason === undefined && db.getSchedulerState()?.globalPause !== true;
  };

  const walk = async (): Promise<ArmedWalk> => {
    if (!stillArmed()) return holdAll('stopped');
    // FIRST — the driver's record: the re-dry-run is an export, which would discard the app's open transaction.
    if (await db.driver.inTransaction(appId)) return holdAll('busy');
    // The fresh counts, IN ORDER on one copy — each item measured after the ones before it (F5).
    const dryRun = await db.scratchRun(appId, own.map((item) => ({ sql: item.sql })));
    const counts: number[] = [];
    let budget = authority.rowsPerRun;
    let failedAt: number | undefined;
    for (const [index, statement] of dryRun.statements.entries()) {
      if (statement.error !== undefined) {
        failedAt = index;
        break;
      }
      const changes = statement.changes ?? 0;
      if (changes > budget) break;
      budget -= changes;
      counts.push(changes);
    }
    // Past the prefix: the item that would not run on the copy and those measured after it, `failed`; the rest past the budget, `over-limit`.
    const pastPrefix = (index: number): ScheduleHeldReason => (failedAt !== undefined && index >= failedAt ? 'failed' : 'over-limit');
    const prefix = own.slice(0, counts.length);
    if (prefix.length === 0) return answer(0, pastPrefix);

    /** The group the run row names: each made change's summary and fresh count — never SQL — and its undo, or that it has none. */
    const appliedOf = (outcome: { changes: readonly number[]; undoId?: string }): ScheduleRunApplied => ({
      appId: appId,
      ...(outcome.undoId !== undefined ? { undoId: outcome.undoId } : { undoable: false }),
      items: prefix.map((item, index) => ({ ...(item.summary !== undefined ? { summary: item.summary } : {}), changes: outcome.changes[index] ?? 0 })),
    });
    const made = await applyOwnWrite(db, {
      appId: appId,
      bucket: task.id,
      statements: prefix.map((item) => item.sql),
      params: prefix.map(() => []),
      expectChanges: counts,
      maxChanges: authority.rowsPerRun,
      requireUndo: true,
      authority: SCHEDULE_AUTHORITY,
      via: 'schedule',
      runId: run.id,
      taskId: task.id,
      stillArmed,
      // The same tick as the undo entry (F20): the claim row names what was made before anything else can run.
      onCommitted: (outcome) => {
        try {
          db.putScheduleRun({ ...run, applied: appliedOf(outcome) });
        } catch {
          // The claim row is refused (the schedule went away mid-run): the queue's final row carries the group all the same.
        }
      },
    });
    if (!made.ok) return answer(0, (index) => (index < prefix.length ? made.reason : pastPrefix(index)));
    return answer(prefix.length, pastPrefix, appliedOf(made));
  };

  try {
    return await walk();
  } catch {
    // The file or the app could not answer (an export that failed, a refused row): nothing was made — the seat never throws.
    return holdAll('failed');
  }
}
