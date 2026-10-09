// schedule/plan.ts — the PURE reconcile planner (TASK-20261009-scheduling-framework E4, E5;
// ADR-0074 §5). `plan()` takes the tasks, their run rows, the scheduler state and `now` as
// VALUES and answers the actions a store must apply and the watermark it may write once every
// row is written. No clock, no I/O, no React: "due" is derived from the `now` it is handed, and
// the occurrence engine is injectable so a test can place an instant to the second.
//
// THE WINDOW. Each enabled, unpaused task is considered over `(windowStart, now]` where
// `windowStart = max(state.watermark, enabledAt ?? createdAt, startsAt, ranThrough)` — the
// watermark so nothing is planned twice across reconciles; `enabledAt` so a task created after
// a three-day closure does not inherit three days of misses (scope F2); `ranThrough` so a file
// another device already reconciled (a sync) is not re-planned here (E5: `ranThrough` is the
// dedupe record that survives pruning). An occurrence is DEDUPED when a run row for
// `(taskId, dueAt)` exists in ANY status — a claimed, finished, pending or skipped row all mean
// "recorded" — compared as instants, not strings.
//
// DUE, LATE, MISSED. An occurrence inside the minute it fires in (age < 60 s) is `due`; the
// ticker re-arms to the minute boundary from the wall clock, so a due occurrence is normally a
// few ms old — zero age is the ideal, not the norm. Older but within the grace (≤ 15 min,
// `SCHEDULE_GRACE_MS`) it is `late`. Everything in the grace window collapses to ONE run for the
// LATEST of them (its `collapsedCount` says how many it stands for, and its trigger is `due`
// when that latest one is in the current minute): a throttled hidden tab that wakes twelve
// minutes late with a per-minute schedule runs once, not twelve times. Older than the grace is
// MISSED, and the missed occurrences collapse per task to ONE candidate (`dueAt` = the latest,
// `collapsedCount` = how many). A candidate older than the task's `staleAfterMs` is skipped
// `stale` — no card, whatever the policy. A fresh candidate follows `missedPolicy`: `ask` → a
// `pending` row the missed card reads; `run-once` → a run with trigger `catch-up`; `skip` → a
// `skip{policy}` history line. A ONE-OFF is always asked: it will never come around again.
// A missed candidate and a late run in the same window are BOTH emitted (E4 says so; a run-once
// catch-up beside a late run is two reminder-class runs, since spending steps default to `ask`).
//
// SUPERSEDE. When a newer missed candidate is planned and an older `pending` row exists (an
// earlier catch-up the user never answered), the new candidate stands for it too: its
// `collapsedCount` absorbs the old row's and a `supersede{dueAt: <old>}` action names the row the
// store must delete — one card per schedule, never a stack. A stale candidate supersedes as well
// (the older pending is older still, so it is stale too). A late or due run never supersedes.
//
// THE END. Occurrences past `endsAt` collapse to one `skip{ended}` for the latest; once the task's
// `ranThrough` has passed `endsAt` the end is on record and the task plans nothing more (the
// engine keeps generating occurrences after `endsAt`; this is what stops a skip row per
// reconcile). A spec's `until` is honoured by the engine itself.
//
// ADVANCE. `advance{ranThrough}` carries the latest occurrence CONSIDERED — planned, deduped or
// ended — so the store can move the task's `ranThrough`; it is emitted only when that is newer
// than the recorded one. The watermark answered is `now`; under `globalPause` nothing is planned
// and the watermark stays where it was, so the held occurrences are seen again when the pause
// lifts — within the grace as `late`, beyond it as missed like any other (E7).
//
// THE STORE'S HALF. Actions are applied in order; `advance` and the watermark are written only
// after every row before them — "the watermark never passes an unwritten miss".

import { SCHEDULE_GRACE_MS, type ScheduleRun, type ScheduledTask, type SchedulerState } from '@snugprotocol/protocol';

import { occurrencesBetween } from './cron.js';

export type PlanInput = {
  tasks: readonly ScheduledTask[];
  /** Every run row per task id — any status; a pending row is the one an older catch-up left. */
  runsByTask: Readonly<Record<string, readonly ScheduleRun[]>>;
  state: SchedulerState;
  now: Date;
  /** Within this age an occurrence is merely late (default `SCHEDULE_GRACE_MS`). */
  graceMs?: number;
  /** The occurrence engine (default the cron's `occurrencesBetween`) — injectable for tests. */
  occurrences?: typeof occurrencesBetween;
};

export type PlannedTrigger = 'due' | 'late' | 'catch-up';
export type SkipReason = 'stale' | 'policy' | 'ended';

export type PlanAction =
  | { kind: 'run'; taskId: string; dueAt: string; trigger: PlannedTrigger; collapsedCount: number }
  | { kind: 'pending'; taskId: string; dueAt: string; collapsedCount: number }
  | { kind: 'skip'; taskId: string; dueAt: string; collapsedCount: number; reason: SkipReason }
  | { kind: 'supersede'; taskId: string; dueAt: string }
  | { kind: 'advance'; taskId: string; ranThrough: string };

export type PlanResult = { actions: PlanAction[]; watermark: string };

export type MissedCandidate = { dueAt: Date; collapsedCount: number };

const MINUTE_MS = 60_000;

/**
 * The most occurrences one task may contribute per reconcile. The planner must see the LATEST
 * occurrence, so it never truncates in practice: the 5-minute floor across the engine's 400-day
 * search bound is ~115 000 instants.
 */
export const PLAN_OCCURRENCE_LIMIT = 120_000;

/** An ISO instant as ms; an absent or unreadable one is −∞ so it never wins a `max`. */
const msOf = (iso: string | undefined): number => {
  if (iso === undefined) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** The exclusive start of a task's reconcile window — the max of the four bounds (see the header). */
export function windowStart(task: ScheduledTask, state: SchedulerState): Date {
  return new Date(Math.max(msOf(state.watermark), msOf(task.enabledAt ?? task.createdAt), msOf(task.startsAt), msOf(task.ranThrough)));
}

/** The LATEST of the instants and how many there were; `undefined` for none. Order of input does not matter. */
export function collapseMissed(occurrences: readonly Date[]): MissedCandidate | undefined {
  let latest: Date | undefined;
  for (const occurrence of occurrences) {
    if (latest === undefined || occurrence.getTime() > latest.getTime()) latest = occurrence;
  }
  return latest === undefined ? undefined : { dueAt: latest, collapsedCount: occurrences.length };
}

function planTask(
  task: ScheduledTask,
  runs: readonly ScheduleRun[],
  state: SchedulerState,
  now: Date,
  graceMs: number,
  occurrences: typeof occurrencesBetween,
  out: PlanAction[],
): void {
  if (!task.enabled || task.pausedReason !== undefined) return;
  const endsAtMs = task.endsAt === undefined ? undefined : msOf(task.endsAt);
  if (endsAtMs !== undefined && msOf(task.ranThrough) >= endsAtMs) return;

  const from = windowStart(task, state);
  const nowMs = now.getTime();
  if (!(from.getTime() < nowMs)) return;

  const found = occurrences(task.spec, from, now, { limit: PLAN_OCCURRENCE_LIMIT, anchor: new Date(task.startsAt ?? task.createdAt) });
  if (found.length === 0) return;
  const inOrder = [...found].sort((a, b) => a.getTime() - b.getTime());
  const latestConsidered = inOrder[inOrder.length - 1] as Date;

  const recorded = new Set<number>();
  const pendingRows: ScheduleRun[] = [];
  for (const row of runs) {
    const ms = Date.parse(row.dueAt);
    if (Number.isNaN(ms)) continue;
    recorded.add(ms);
    if (row.status === 'pending') pendingRows.push(row);
  }

  const ended: Date[] = [];
  const inGrace: Date[] = [];
  const missed: Date[] = [];
  for (const occurrence of inOrder) {
    const ms = occurrence.getTime();
    if (recorded.has(ms)) continue;
    if (endsAtMs !== undefined && ms > endsAtMs) {
      ended.push(occurrence);
      continue;
    }
    if (nowMs - ms <= graceMs) inGrace.push(occurrence);
    else missed.push(occurrence);
  }

  const candidate = collapseMissed(missed);
  if (candidate) {
    let collapsedCount = candidate.collapsedCount;
    for (const row of pendingRows) {
      if (Date.parse(row.dueAt) < candidate.dueAt.getTime()) {
        out.push({ kind: 'supersede', taskId: task.id, dueAt: row.dueAt });
        collapsedCount += row.collapsedCount;
      }
    }
    const dueAt = candidate.dueAt.toISOString();
    if (nowMs - candidate.dueAt.getTime() > task.staleAfterMs) {
      out.push({ kind: 'skip', taskId: task.id, dueAt, collapsedCount, reason: 'stale' });
    } else if (task.spec.kind === 'once' || task.missedPolicy === 'ask') {
      out.push({ kind: 'pending', taskId: task.id, dueAt, collapsedCount });
    } else if (task.missedPolicy === 'run-once') {
      out.push({ kind: 'run', taskId: task.id, dueAt, trigger: 'catch-up', collapsedCount });
    } else {
      out.push({ kind: 'skip', taskId: task.id, dueAt, collapsedCount, reason: 'policy' });
    }
  }

  const live = collapseMissed(inGrace);
  if (live) {
    const trigger: PlannedTrigger = nowMs - live.dueAt.getTime() < MINUTE_MS ? 'due' : 'late';
    out.push({ kind: 'run', taskId: task.id, dueAt: live.dueAt.toISOString(), trigger, collapsedCount: live.collapsedCount });
  }

  const past = collapseMissed(ended);
  if (past) out.push({ kind: 'skip', taskId: task.id, dueAt: past.dueAt.toISOString(), collapsedCount: past.collapsedCount, reason: 'ended' });

  if (latestConsidered.getTime() > msOf(task.ranThrough)) out.push({ kind: 'advance', taskId: task.id, ranThrough: latestConsidered.toISOString() });
}

/** The reconcile plan for every task (see the header). Never mutates its input. */
export function plan(input: PlanInput): PlanResult {
  const { tasks, runsByTask, state, now } = input;
  if (state.globalPause) return { actions: [], watermark: state.watermark };
  const graceMs = input.graceMs ?? SCHEDULE_GRACE_MS;
  const occurrences = input.occurrences ?? occurrencesBetween;
  const actions: PlanAction[] = [];
  for (const task of tasks) planTask(task, runsByTask[task.id] ?? [], state, now, graceMs, occurrences, actions);
  return { actions, watermark: now.toISOString() };
}
