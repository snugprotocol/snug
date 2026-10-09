// schedule/queue.ts — the run queue: ONE run at a time, claimed before it executes
// (TASK-20261009-scheduling-framework E5, E7; ADR-0074 §5–§6).
//
// The queue decides WHEN; an executor (`engine-types.ts`) decides WHAT one step does. This
// module owns the lifecycle of a run row in the user's file:
//
//  CLAIM BEFORE RUN (E5). Before any step executes, the row for `(taskId, dueAt)` is written
//  `running` with `startedAt`. An existing row for that occurrence in ANY status other than
//  `pending` means it is already recorded — claimed by another tab, finished here, skipped,
//  carried in by a sync pull — and the item is DROPPED without a call. A `pending` row (a
//  catch-up candidate the user answered with *run*) is replaced by the claim, under the row's
//  own `dueAt` string so the accessor's upsert replaces in place rather than beside it. The
//  task is read FRESH from the file: one that is off (`enabled: false` — the user's switch, an
//  engine pause, an untrusted import) is never claimed by a due or catch-up item, only by the
//  user's own `manual` run (Gate-5 S1). A claim the accessor REFUSES — a history full of
//  results waiting on the user, the schedule gone — is said (`lastError` on the queue's state,
//  `onChange`) and counted as one consecutive failure on the task, so the fifth refusal pauses
//  it like a fifth failure would (Gate-5 S5): nothing runs unrecorded, and nothing stays
//  silently stuck.
//
//  ONE AT A TIME, FIFO, UNDER A BOUND. Each run gets one `AbortController` and a timeout —
//  `thinkMs` when any step is *Ask the AI*, else `runMs` — so a stuck executor can never hold
//  the queue: every step is RACED against the signal (Gate-5 M7), so an executor that ignores
//  it is left behind (its late answer or rejection is dropped) rather than waited for. The
//  signal still reaches the executor through its context so a well-behaved one stops early.
//  `cancelCurrent()` (the user's cancel) and `abortAll(reason)` (a file swap, the global
//  pause) abort the same way; the run is recorded `interrupted` with the reason (`timeout` |
//  `cancelled` | the given one).
//
//  THE STEP RULES. A step whose app is gone from the file is `blocked` (`appMissing`) without
//  calling the executor. An *Ask the AI* step the day's ceiling would not admit — counting
//  what this run already spent — is `refused` and the run is `capped`; the steps after it still
//  run (a reminder costs nothing). An executor that throws is a `failed` step with its message.
//  Steps not reached after an abort are `skipped`.
//
//  THE FOLD. `interrupted` on abort; else `capped` when the ceiling refused; else `failed` when
//  any step failed; else `needs-you` when any step was refused or blocked (with its reason);
//  else `no-handler` when any step had none; else `ok` (every step ok or skipped).
//
//  AFTER THE STEPS. One final write replaces the claim: `finishedAt`, the step results (the
//  executor scrubbed and capped them; the row is shrunk to the run's byte cap if five of them
//  still overflow it), the summed `calls`, the *Ask the AI* proposals with one `expiresAt`
//  (`SCHEDULE_PROPOSAL_TTL_MS`) — each item naming the app its step asked (Gate-5 S4), pooled
//  as the steps answered them. Should that write be refused, a MINIMAL row — the claim, the
//  status, `finishedAt`, the bare step statuses, reason `result too large` — replaces the
//  claim instead (Gate-5 M17): the occurrence is on record either way. Then the day's
//  counters, then the task (`applyRunOutcome`, `ranThrough` = max(ranThrough, dueAt)) —
//  re-read fresh, because the user may have edited it while the run was in flight, and
//  WITHOUT touching `updatedAt`: that stamp is the user's edits', and a run must not change
//  what a backup compares by (Gate-5 M16). A notification is HOST-DECIDED (§6): the
//  executor's `alert` is a suggestion the queue honours once per run, only when the task's
//  `alert` is `notification` and the seat has `notify`, with the body prefixed by the
//  schedule's title and cut to the protocol's 120 characters. The seat is deliberately NOT
//  handed to the executor's context: one decider, one notification.
//
//  SIGNALS. `scheduleRevisionStore` is bumped after every write (and `onChange`, when given),
//  so every view that lists schedules or results re-reads the file.
//
// EVERYTHING IS INJECTED — the db, the executor, the clock, the host, the seat, the bounds —
// so the suite runs a recording executor against a REAL memory-backed user db and never a
// fake of the accessor it is proving (lesson 2026-10-02: fakes share production shape).

import type { UserDb } from '@snugprotocol/db';
import {
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_PROPOSALS_PER_RUN,
  SCHEDULE_PROPOSAL_TTL_MS,
  SCHEDULE_RUN_REASON_MAX_CHARS,
  scheduleRunSchema,
  type RunStatus,
  type RunTrigger,
  type ScheduleProposalItem,
  type ScheduleRun,
  type ScheduleStep,
  type ScheduledTask,
  type SchedulerState,
  type StepResult,
} from '@snugprotocol/protocol';

import type { SchedulerSeat } from '../platform/platform.js';
import { bumpScheduleRevision } from '../platform/signals.js';
import { createStore, type Store } from '../state/store.js';
import type { StepContext, StepExecutor, StepOutcome } from './engine-types.js';
import { applyRunOutcome, dailyCounters, wouldExceedCeiling } from './protection.js';
import { messageOf } from './taskShape.js';

/** The per-run bounds (E5): 120 s, or 300 s when a step asks the AI. */
export const DEFAULT_RUN_BOUNDS: RunBounds = { runMs: 120_000, thinkMs: 300_000 };

export interface RunBounds {
  runMs: number;
  thinkMs: number;
}

export type RunHost = ScheduleRun['host'];

export interface QueueItem {
  task: ScheduledTask;
  dueAt: string;
  trigger: RunTrigger;
  collapsedCount: number;
}

export interface RunningView {
  taskId: string;
  dueAt: string;
  startedAt: string;
  stepIndex: number;
}

export interface RunQueueState {
  running?: RunningView;
  /** Items waiting behind the running one. */
  queued: number;
  /** The last claim the file refused, in one line — cleared by the next claim that lands (S5). */
  lastError?: string;
}

export interface RunQueueDeps {
  db: () => Promise<UserDb>;
  execute: StepExecutor;
  now: () => Date;
  hostInfo: () => RunHost;
  /** The host's notification seat, read per run — a host may compose it after boot (web opt-in). */
  notify?: (() => SchedulerSeat['notify'] | undefined) | undefined;
  bounds?: RunBounds | undefined;
  /** Called after every write to the file, beside the revision bump. */
  onChange?: (() => void) | undefined;
}

export interface RunQueue {
  enqueue(item: QueueItem): void;
  /** Abort the running item; it is recorded `interrupted` (reason `cancelled`). */
  cancelCurrent(): void;
  /** Drop every waiting item (unclaimed, so nothing is recorded for them) and abort the running one with `reason`. */
  abortAll(reason: string): void;
  readonly state: Store<RunQueueState>;
  /** Resolves once nothing is running or waiting. */
  idle(): Promise<void>;
}

/** The bound a run of these steps gets. */
export function runBoundMs(steps: readonly ScheduleStep[], bounds: RunBounds = DEFAULT_RUN_BOUNDS): number {
  return steps.some((step) => step.kind === 'app-think') ? bounds.thinkMs : bounds.runMs;
}

const ZERO_CALLS = { ai: 0, net: 0 } as const;

const instant = (iso: string): number => Date.parse(iso);

/** The later of two instants, as the string that carried it; an absent or unreadable one loses. */
export function laterInstant(a: string | undefined, b: string): string {
  if (a === undefined) return b;
  const ams = instant(a);
  const bms = instant(b);
  if (Number.isNaN(ams)) return b;
  if (Number.isNaN(bms)) return a;
  return ams >= bms ? a : b;
}

const cut = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

/** The day's counters as the file holds them now — zeros on a new day or an absent row. */
function countersNow(state: SchedulerState | undefined, nowIso: string): SchedulerState['daily'] {
  if (state !== undefined) return dailyCounters(state, nowIso);
  return { date: nowIso.slice(0, 10), ai: 0, net: 0 };
}

function toStepResult(outcome: StepOutcome): StepResult {
  const result: StepResult = { status: outcome.status };
  if (outcome.summary !== undefined) result.summary = outcome.summary;
  return result;
}

interface Fold {
  status: RunStatus;
  reason?: string;
}

/** See the header: interrupted › capped › failed › needs-you › no-handler › ok. */
export function foldRunStatus(results: readonly StepResult[], abortReason: string | undefined, capped: boolean): Fold {
  if (abortReason !== undefined) return { status: 'interrupted', reason: abortReason };
  if (capped) return { status: 'capped', reason: 'capped' };
  const failed = results.find((result) => result.status === 'failed');
  if (failed !== undefined) return { status: 'failed', ...(failed.summary !== undefined ? { reason: failed.summary } : {}) };
  const refused = results.find((result) => result.status === 'refused');
  if (refused !== undefined) return { status: 'needs-you', reason: refused.summary ?? 'refused' };
  const blocked = results.find((result) => result.status === 'blocked');
  if (blocked !== undefined) return { status: 'needs-you', reason: blocked.appMissing === true ? 'app missing' : (blocked.summary ?? 'blocked') };
  if (results.some((result) => result.status === 'no-handler')) return { status: 'no-handler' };
  return { status: 'ok' };
}

/**
 * The row under the run's byte cap. Each step's summary arrives already capped by the
 * executor, but five capped summaries can still overflow one run row; the row is shrunk in
 * three steps — shorter summaries, then none, then no proposals — until the strict schema
 * admits it. The schema also carries the credential refusal, which no shrinking can satisfy:
 * then the summaries go too (a scrubbed summary never trips it; an unscrubbed one must not land).
 */
export function fitRunRow(row: ScheduleRun): ScheduleRun {
  if (scheduleRunSchema.safeParse(row).success) return row;
  const shorter: ScheduleRun = {
    ...row,
    steps: row.steps.map((step) => (step.summary === undefined ? step : { ...step, summary: cut(step.summary, 512) })),
  };
  if (scheduleRunSchema.safeParse(shorter).success) return shorter;
  const bare: ScheduleRun = { ...row, steps: row.steps.map(({ status, appMissing }) => ({ status, ...(appMissing === true ? { appMissing } : {}) })) };
  if (scheduleRunSchema.safeParse(bare).success) return bare;
  const { proposals: _dropped, ...withoutProposals } = bare;
  return withoutProposals;
}

/** The reason a minimal row carries when the full result could not be written (M17). */
export const RESULT_TOO_LARGE_REASON = 'result too large';

/** A promise that REJECTS when the signal aborts — the executor's opponent in the race (M7). Already handled: a late abort is never an unhandled rejection. */
function abortedPromise(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error('aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  promise.catch(() => undefined);
  return promise;
}

export function createRunQueue(deps: RunQueueDeps): RunQueue {
  const bounds = deps.bounds ?? DEFAULT_RUN_BOUNDS;
  const state = createStore<RunQueueState>({ queued: 0 });
  const waiting: QueueItem[] = [];
  let current: { abort: (reason: string) => void } | undefined;
  let draining: Promise<void> | undefined;
  let lastError: string | undefined;

  const changed = (): void => {
    bumpScheduleRevision();
    deps.onChange?.();
  };

  const publish = (running: RunningView | undefined): void => {
    state.set({
      ...(running !== undefined ? { running } : {}),
      queued: waiting.length,
      ...(lastError !== undefined ? { lastError } : {}),
    });
  };

  /** A claim the file refused (S5): say it, count it against the task, and move on — nothing runs unrecorded. */
  function refuseClaim(db: UserDb, task: ScheduledTask, claim: ScheduleRun, err: unknown): void {
    lastError = messageOf(err);
    const fresh = db.getScheduledTask(task.id);
    if (fresh !== undefined) {
      const counted = applyRunOutcome(fresh, { ...claim, status: 'failed' });
      try {
        db.putScheduledTask({ ...counted, unseenResults: fresh.unseenResults }); // a failure to record is not a result to open
      } catch {
        // The task row itself is refused: the error on the state is all that can be said.
      }
    }
    publish(state.get().running);
    changed();
  }

  async function runItem(item: QueueItem): Promise<void> {
    const db = await deps.db();
    const task = db.getScheduledTask(item.task.id);
    if (task === undefined) return; // deleted while it waited
    if (!task.enabled && item.trigger !== 'manual') return; // off is off (S1): only the user's own *run now* goes
    const dueMs = instant(item.dueAt);
    const existing = db.listScheduleRuns(task.id).find((row) => instant(row.dueAt) === dueMs);
    if (existing !== undefined && existing.status !== 'pending') return; // already recorded — never re-run

    const startedAt = deps.now().toISOString();
    const claim: ScheduleRun = {
      id: existing?.id ?? crypto.randomUUID(),
      taskId: task.id,
      dueAt: existing?.dueAt ?? item.dueAt,
      trigger: item.trigger,
      collapsedCount: item.collapsedCount,
      status: 'running',
      startedAt,
      host: deps.hostInfo(),
      steps: [],
      calls: { ...ZERO_CALLS },
    };
    try {
      db.putScheduleRun(claim);
    } catch (err) {
      refuseClaim(db, task, claim, err); // the history is full of rows waiting on the user, or the schedule went away
      return;
    }
    lastError = undefined;
    changed();

    const controller = new AbortController();
    let abortReason: string | undefined;
    const abort = (reason: string): void => {
      if (abortReason !== undefined) return;
      abortReason = reason;
      controller.abort();
    };
    current = { abort };
    const timer = setTimeout(() => abort('timeout'), runBoundMs(task.steps, bounds));
    const aborted = abortedPromise(controller.signal);

    const results: StepResult[] = [];
    const calls = { ...ZERO_CALLS };
    const proposals: ScheduleProposalItem[] = [];
    let alert: StepOutcome['alert'];
    let capped = false;
    const context: StepContext = {
      task,
      run: { id: claim.id, taskId: task.id, dueAt: claim.dueAt, trigger: item.trigger },
      db,
      signal: controller.signal,
      now: deps.now,
    };

    try {
      for (let index = 0; index < task.steps.length; index += 1) {
        const step = task.steps[index] as ScheduleStep;
        if (controller.signal.aborted) {
          results.push({ status: 'skipped' });
          continue;
        }
        publish({ taskId: task.id, dueAt: claim.dueAt, startedAt, stepIndex: index });
        if (step.kind !== 'notify' && db.getApp(step.appId) === undefined) {
          results.push({ status: 'blocked', appMissing: true });
          continue;
        }
        if (step.kind === 'app-think') {
          const daily = countersNow(db.getSchedulerState(), deps.now().toISOString());
          const ceiling = wouldExceedCeiling({ ...daily, ai: daily.ai + calls.ai, net: daily.net + calls.net }, { ai: 1 });
          if (ceiling !== undefined) {
            capped = true;
            results.push({ status: 'refused' });
            continue;
          }
        }
        let outcome: StepOutcome;
        try {
          // The race (M7): the signal's rejection wins over an executor that never answers; the loser's late answer is dropped.
          let attempt: Promise<StepOutcome>;
          try {
            attempt = Promise.resolve(deps.execute(step, context));
          } catch (err) {
            attempt = Promise.reject(err);
          }
          attempt.catch(() => undefined);
          outcome = await Promise.race([attempt, aborted]);
        } catch (err) {
          if (controller.signal.aborted) {
            results.push({ status: 'skipped' });
            continue;
          }
          outcome = { status: 'failed', summary: messageOf(err), calls: { ...ZERO_CALLS } };
        }
        results.push(toStepResult(outcome));
        calls.ai += outcome.calls.ai;
        calls.net += outcome.calls.net;
        if (outcome.proposals !== undefined) proposals.push(...outcome.proposals);
        alert ??= outcome.alert;
      }
    } finally {
      clearTimeout(timer);
      current = undefined;
    }

    const finishedAt = deps.now().toISOString();
    const fold = foldRunStatus(results, abortReason, capped);
    const row = fitRunRow({
      ...claim,
      status: fold.status,
      finishedAt,
      steps: results,
      calls,
      ...(proposals.length > 0
        ? {
            proposals: {
              items: proposals.slice(0, SCHEDULE_PROPOSALS_PER_RUN),
              expiresAt: new Date(instant(finishedAt) + SCHEDULE_PROPOSAL_TTL_MS).toISOString(),
            },
          }
        : {}),
      ...(fold.reason !== undefined ? { reason: cut(fold.reason, SCHEDULE_RUN_REASON_MAX_CHARS) } : {}),
    });
    try {
      db.putScheduleRun(row);
    } catch {
      // The full result is refused (the byte cap, most likely): a minimal row that always parses replaces the claim (M17).
      try {
        db.putScheduleRun({ ...claim, status: fold.status, finishedAt, steps: results.map(({ status }) => ({ status })), calls, reason: RESULT_TOO_LARGE_REASON });
      } catch {
        // The schedule went away mid-run: there is nothing left to record it on.
      }
    }

    if (calls.ai > 0 || calls.net > 0) {
      const latest = db.getSchedulerState();
      if (latest !== undefined) {
        const daily = dailyCounters(latest, finishedAt);
        db.setSchedulerState({ ...latest, daily: { date: daily.date, ai: daily.ai + calls.ai, net: daily.net + calls.net } });
      }
    }

    const fresh = db.getScheduledTask(task.id);
    if (fresh !== undefined) {
      const next = applyRunOutcome(fresh, row);
      db.putScheduledTask({ ...next, ranThrough: laterInstant(fresh.ranThrough, row.dueAt) }); // bookkeeping, never `updatedAt` (M16)
    }
    changed();

    if (fresh?.alert === 'notification' && alert !== undefined) {
      const notify = deps.notify?.();
      if (notify !== undefined) {
        const title = fresh.title;
        void notify({ title: alert.title, body: cut(`${title} · ${alert.body}`, SCHEDULE_NOTIFY_BODY_MAX_CHARS) }).catch(() => undefined);
      }
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      const next = waiting.shift();
      if (next === undefined) break;
      publish(undefined);
      try {
        await runItem(next);
      } catch {
        // A refused read or write on the file ends this item, never the queue.
      }
      publish(undefined);
    }
  }

  const pump = (): void => {
    if (draining !== undefined) return;
    draining = drain().finally(() => {
      draining = undefined;
      publish(undefined);
    });
  };

  return {
    state,
    enqueue(item) {
      waiting.push(item);
      publish(state.get().running);
      pump();
    },
    cancelCurrent() {
      current?.abort('cancelled');
    },
    abortAll(reason) {
      waiting.length = 0;
      current?.abort(reason);
      publish(state.get().running);
    },
    idle: () => draining ?? Promise.resolve(),
  };
}
