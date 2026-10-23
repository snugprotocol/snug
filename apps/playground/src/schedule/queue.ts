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
//  `cancelled` | the given one). The run's abort seat stays live until the run is SETTLED — through
//  an armed schedule's walk too (PR-4 Gate 5, A3): only the bound's timer stops with the steps, so
//  a cancel, a file swap or a pause that lands while the walk asks the app or builds its copy still
//  stops it, and a copy that never answers can never wedge the queue.
//
//  THE STEP RULES. A step whose app is gone from the file is `blocked` (`appMissing`) without
//  calling the executor. An *Ask the AI* step the day's ceiling would not admit — counting
//  what this run already spent — is `refused` and the run is `capped`; the steps after it still
//  run (a reminder costs nothing). An executor that throws is a `failed` step with its message.
//  Steps not reached after an abort are `skipped`.
//
//  THE FOLD. `interrupted` on abort; else `capped` when the ceiling refused; else `failed` when
//  any step failed; else `needs-you` when any step was refused or blocked (with its reason);
//  else `no-handler` when any step had none; else `ok` (every step ok or skipped). A capped step
//  that names WHICH ceiling (`capped: 'ai' | 'net'`, PR-4 Gate 5 J6/A10) gives the run the host's
//  sentence for that limit as its reason — never the step's prose, which may be the AI's answer.
//
//  AFTER THE STEPS. One final write replaces the claim: `finishedAt`, the step results (the
//  executor scrubbed and capped them; the row is shrunk to the run's byte cap if five of them
//  still overflow it), the summed `calls`, the *Ask the AI* proposals with one `expiresAt`
//  (`SCHEDULE_PROPOSAL_TTL_MS`) — each item naming the app its step asked (Gate-5 S4), pooled
//  as the steps answered them, the first `SCHEDULE_PROPOSALS_PER_RUN` kept. Each step is told how
//  many the run already holds (`proposalsSoFar`, PR-4 Gate 5 J7/A10), so one that proposes as it
//  goes refuses the one past that out loud; when a step still offered more than the run keeps, the
//  run SAYS so — the surplus note on that step's summary. Should that write be refused, a
//  MINIMAL row — the claim, the status, `finishedAt`, the bare step statuses, reason `result too
//  large` — replaces the claim instead (Gate-5 M17): the occurrence is on record either way. Then the day's
//  counters, then the task (`applyRunOutcome`, `ranThrough` = max(ranThrough, dueAt)) —
//  re-read fresh, because the user may have edited it while the run was in flight, and
//  WITHOUT touching `updatedAt`: that stamp is the user's edits', and a run must not change
//  what a backup compares by (Gate-5 M16). A notification is HOST-DECIDED (§6; Gate-5 PR-B
//  S3): the executor's `alert` is a suggestion the queue honours once per run — the FIRST
//  step that suggested one — only when the task's `alert` is `notification` and the seat has
//  `notify`. The TITLE is never the app's or the step's to set (`hostNotification`): for an
//  app step it is the app's display name and the body reads "App: title — body"; for a
//  reminder it is the schedule's title and the body is the reminder's, prefixed by that
//  title; both cut to the protocol's 120 characters. The seat is deliberately NOT handed to
//  the executor's context: one decider, one notification.
//
//  SIGNALS. `scheduleRevisionStore` is bumped after every write (and `onChange`, when given),
//  so every view that lists schedules or results re-reads the file.
//
//  A SCHEDULE THAT MAKES CHANGES ON ITS OWN (TASK-20261010-host-broker PR-4, D-PR4-11/17; ADR-0076
//  §9). At the pooling point — after every step, BEFORE the row is written — a run of a schedule
//  that was ARMED when it was claimed (the copy its steps ran under: an *Ask* step's model is told
//  whether its changes wait, so a change proposed under "it waits for your OK" is never made on its
//  own) hands its armable items to the walk (`applyArmed.ts`): only the items of steps that answered
//  `ok` (a failed, capped or refused step's wait, unheld), and only when the run ended with NO abort
//  — a cancelled, timed-out, paused or swapped-out run makes nothing, its armable items waiting held
//  `stopped`; the run's signal rides into the walk, so an abort DURING it does the same (A3). The walk
//  re-reads the authority from the file at its seat, rewrites the claim with the `applied` group in
//  the tick its undo entry lands, and answers ONE verdict per armable item — made, held, or untouched
//  — which the queue maps back onto its pool BY INDEX (A4): a made item never waits again, whatever
//  its place among the armed app's. The final row carries both. `fitRunRow` drops the waiting
//  changes BEFORE anything it says was made — `applied` and `approved` are never dropped (the
//  changes happened, and their undo is named there) — and the M17 row keeps them too.
//
//  THE STEP'S HOST FACTS (D-PR4-17) ride the row as the executor finalised them, each omitted when
//  it has nothing to say: `inOpenApp`, `saw` (only when non-empty — R-88's disclosure), `tools`,
//  `blockedBy` — and, since TASK-20261010-host-broker PR-5 (D-PR5-19), `fetched` (what an *ask*
//  step's *fetch new data first* came to; only when it asked). A step's context carries `boundAt`,
//  when the bound aborts the run, so a step that may look things up stops itself first and answers
//  WITH what it spent (D-PR4-15); a step that loses the race anyway has its calls folded into the
//  day when it finally settles — its answer is dropped, but what it spent is the user's budget all
//  the same.
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
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  scheduleRunSchema,
  type RunStatus,
  type RunTrigger,
  type ScheduleProposalItem,
  type ScheduleRun,
  type ScheduleRunApplied,
  type ScheduleStep,
  type ScheduledTask,
  type SchedulerState,
  type StepResult,
} from '@snugprotocol/protocol';

import type { SchedulerSeat } from '../platform/platform.js';
import { bumpScheduleRevision } from '../platform/signals.js';
import { createStore, type Store } from '../state/store.js';
import { applyArmed, type ArmedVerdict } from './applyArmed.js';
import { surplusNote } from './appThink.js';
import { capped as cappedSentence } from './copy.js';
import { resultFacts } from './copy.result.js';
import type { StepContext, StepExecutor, StepOutcome } from './engine-types.js';
import { ZERO_CALLS, applyRunOutcome, dailyCounters, foldDailyCalls, wouldExceedCeiling } from './protection.js';
import { armableAppOf, messageOf } from './taskShape.js';

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

/**
 * `StepOutcome.retryable` stays in memory (TASK-20261023-siwc-chatgpt-plan L4-7): the persisted
 * result's schema is strict (C3), so the day a field of that name is added to it this line stops
 * compiling and the decision is made again on purpose rather than by a spread.
 */
const retryableNeverPersisted: 'retryable' extends keyof StepResult ? never : true = true;
void retryableNeverPersisted;

/** The persisted step: its status, its summary and PR-4's host facts — each only when it has something to say (D-PR4-17). Never `retryable` (above) or `capped`. */
function toStepResult(outcome: StepOutcome): StepResult {
  return {
    status: outcome.status,
    ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
    ...(outcome.inOpenApp === true ? { inOpenApp: true } : {}),
    ...(outcome.saw !== undefined && outcome.saw.length > 0 ? { saw: outcome.saw } : {}),
    ...(outcome.tools !== undefined ? { tools: outcome.tools } : {}),
    // PR-5 (D-PR5-19): what its *fetch new data first* came to — a host fact beside `summary`.
    ...(outcome.fetched !== undefined && outcome.fetched.length > 0 ? { fetched: outcome.fetched } : {}),
    ...(outcome.blockedBy !== undefined ? { blockedBy: outcome.blockedBy } : {}),
  };
}

/** One pooled change, whether its step answered `ok` — only those are armable (D-PR4-11) — and which step it came from (the surplus note's seat). */
interface Pooled {
  item: ScheduleProposalItem;
  ok: boolean;
  step: number;
}

/**
 * The run's waiting changes after the walk, in the order the steps proposed them (A4): the walk
 * answered ONE verdict per armable item, in the order it was handed them — an `ok` step's item takes
 * the next verdict (made → gone; held → with its reason; untouched → as it was), any other step's
 * waits as it was. Never "the first N of the armed app".
 */
function afterWalk(pooled: readonly Pooled[], verdicts: readonly ArmedVerdict[]): ScheduleProposalItem[] {
  let next = 0;
  return pooled.flatMap(({ item, ok }) => {
    if (!ok) return [item];
    const verdict = verdicts[next];
    next += 1;
    if (verdict === undefined || 'untouched' in verdict) return [item];
    return 'made' in verdict ? [] : [{ ...item, held: verdict.held }];
  });
}

/** The words a capped step's KIND gives the run (J6/A10) — the host's sentence for that limit; a bare `true` keeps the step's own. */
function cappedReasonOf(outcome: StepOutcome): string | undefined {
  switch (outcome.capped) {
    case 'ai':
      return cappedSentence('AI call');
    case 'net':
      return cappedSentence('network call');
    default:
      return outcome.summary;
  }
}

/**
 * The step's summary with the run's surplus note after it (J7/A10): the run kept only the first
 * `SCHEDULE_PROPOSALS_PER_RUN` changes and this step offered some of the rest. Said once, and the
 * words cut to make room — the note is the host's, never what falls off the end.
 */
function withSurplusNote(step: StepResult): StepResult {
  const note = surplusNote(SCHEDULE_PROPOSALS_PER_RUN);
  if (step.summary?.includes(note) === true) return step;
  const words = step.summary ?? '';
  if (words === '') return { ...step, summary: note };
  const room = SCHEDULE_STEP_SUMMARY_MAX_CHARS - note.length - 2;
  return { ...step, summary: `${cut(words, Math.max(room, 0))}\n\n${note}` };
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

/** A step with its summary gone — its host facts kept (they are the host's own words, R-88). */
const withoutSummary = ({ summary: _cut, ...step }: StepResult): StepResult => step;
/** A step as the last resort keeps it: the status, and that its app is gone. */
const statusOnly = ({ status, appMissing }: StepResult): StepResult => ({ status, ...(appMissing === true ? { appMissing } : {}) });

/**
 * The row under the run's byte cap. Each step's summary arrives already capped by the
 * executor, but five capped summaries can still overflow one run row; the row is shrunk —
 * shorter summaries, then none, then no waiting changes, then the steps' facts — until the
 * strict schema admits it. What the run MADE (`applied`, `approved`) is never dropped: the
 * changes happened and their undo is named there (D-PR4-17). The schema also carries the
 * credential refusal, which no shrinking can satisfy: then the summaries go too (a scrubbed
 * summary never trips it; an unscrubbed one must not land).
 */
export function fitRunRow(row: ScheduleRun): ScheduleRun {
  if (scheduleRunSchema.safeParse(row).success) return row;
  const shorter: ScheduleRun = {
    ...row,
    steps: row.steps.map((step) => (step.summary === undefined ? step : { ...step, summary: cut(step.summary, 512) })),
  };
  if (scheduleRunSchema.safeParse(shorter).success) return shorter;
  const bare: ScheduleRun = { ...row, steps: row.steps.map(withoutSummary) };
  if (scheduleRunSchema.safeParse(bare).success) return bare;
  const { proposals: _dropped, ...withoutProposals } = bare;
  if (scheduleRunSchema.safeParse(withoutProposals).success) return withoutProposals;
  return { ...withoutProposals, steps: row.steps.map(statusOnly) };
}

/** The reason a minimal row carries when the full result could not be written (M17). */
export const RESULT_TOO_LARGE_REASON = 'result too large';

/**
 * The words, then the host's facts after them (PR-4, D-PR4-18: *· changed 12 rows in Ledger on its
 * own* · *· 1 change waiting for your OK*), under the protocol's cap — the words are cut to make
 * room, so what the host knows is never what falls off the end.
 */
function withFacts(words: string, facts: readonly string[]): string {
  if (facts.length === 0) return cut(words, SCHEDULE_NOTIFY_BODY_MAX_CHARS);
  const tail = ` · ${facts.join(' · ')}`;
  const room = SCHEDULE_NOTIFY_BODY_MAX_CHARS - tail.length;
  return room > 0 ? `${cut(words, room)}${tail}` : cut(`${words}${tail}`, SCHEDULE_NOTIFY_BODY_MAX_CHARS);
}

/**
 * The notification as the HOST shows it (§6, S3): the title is the host's — an app's display
 * name for an app step, the schedule's title for a reminder — never a line the app or the
 * step authored, so a result cannot impersonate Snug or another app in the system tray. The
 * body's words are the step's; `facts` (`resultFacts` over the run) follow them, the host's own.
 */
export function hostNotification(
  db: UserDb,
  schedule: ScheduledTask,
  step: ScheduleStep,
  alert: { title: string; body: string },
  facts: readonly string[] = [],
): { title: string; body: string } {
  const scheduleTitle = schedule.title;
  if (step.kind === 'notify') return { title: scheduleTitle, body: withFacts(`${scheduleTitle} · ${alert.body}`, facts) };
  const appName = db.getApp(step.appId)?.displayName ?? scheduleTitle;
  return { title: appName, body: withFacts(`${appName}: ${alert.title} — ${alert.body}`, facts) };
}

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
    const boundMs = runBoundMs(task.steps, bounds);
    const boundAt = deps.now().getTime() + boundMs;
    const timer = setTimeout(() => abort('timeout'), boundMs);
    const aborted = abortedPromise(controller.signal);

    const results: StepResult[] = [];
    const calls = { ...ZERO_CALLS };
    const pooled: Pooled[] = [];
    /** The first alert any step suggested, with the step that suggested it — the host composes the notification from both. */
    let alert: { step: ScheduleStep; alert: { title: string; body: string } } | undefined;
    let capped = false;
    /** The capped step's own sentence — the card says WHICH limit (D-PR1-6); the word is the fallback. */
    let cappedReason: string | undefined;
    const context: StepContext = {
      task,
      run: { id: claim.id, taskId: task.id, dueAt: claim.dueAt, trigger: item.trigger },
      db,
      signal: controller.signal,
      now: deps.now,
      // PR-B seams: a step may ask for THIS run to be interrupted with a reason (no shipped
      // executor does — an app opening or closing mid-run is a handover inside the *Run [app]*
      // executor, ADR-0077 §5, never an interruption), and may read what the run already spent.
      interrupt: abort,
      spent: () => ({ ...calls }),
      boundAt,
      // What the steps before this one already pooled — a step proposing as it goes refuses past the run's cap (J7).
      proposalsSoFar: () => pooled.length,
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
        // The race (M7): the signal's rejection wins over an executor that never answers; the loser's late answer is dropped.
        let attempt: Promise<StepOutcome>;
        try {
          attempt = Promise.resolve(deps.execute(step, context));
        } catch (err) {
          attempt = Promise.reject(err);
        }
        attempt.catch(() => undefined);
        try {
          outcome = await Promise.race([attempt, aborted]);
        } catch (err) {
          if (controller.signal.aborted) {
            // …but what it spends is the user's budget all the same: its calls fold into the day when it settles (D-PR4-15).
            attempt.then((late) => foldLate(db, late), () => undefined);
            results.push({ status: 'skipped' });
            continue;
          }
          outcome = { status: 'failed', summary: messageOf(err), calls: { ...ZERO_CALLS } };
        }
        results.push(toStepResult(outcome));
        // A step that met the ceiling itself (the *Run [app]* executor asks before a delegated dispatch
        // and marks a crossed ceiling inside the window — D-PR1-6) folds the run `capped` like the
        // queue's own pre-check above; the first such step gives the reason — its kind's sentence when
        // it named the limit (J6), else its summary.
        if (outcome.capped !== undefined && outcome.capped !== false) {
          capped = true;
          cappedReason ??= cappedReasonOf(outcome);
        }
        calls.ai += outcome.calls.ai;
        calls.net += outcome.calls.net;
        const stepIndex = results.length - 1;
        if (outcome.proposals !== undefined) pooled.push(...outcome.proposals.map((proposed) => ({ item: proposed, ok: outcome.status === 'ok', step: stepIndex })));
        if (alert === undefined && outcome.alert !== undefined) alert = { step, alert: outcome.alert };
      }
    } finally {
      // Only the bound stops with the steps: the abort seat stays live through the walk (A3).
      clearTimeout(timer);
    }

    // The pooling point: at most three waiting changes a run — the surplus said on the step that offered it (J7) —
    // and an armed schedule's walk first (D-PR4-11), under the run's own signal (A3).
    const surplusFrom = pooled[SCHEDULE_PROPOSALS_PER_RUN]?.step;
    if (surplusFrom !== undefined) {
      const step = results[surplusFrom];
      if (step !== undefined) results[surplusFrom] = withSurplusNote(step);
    }
    let settled: { applied?: ScheduleRunApplied; waiting: ScheduleProposalItem[] };
    try {
      settled = await settleChanges(db, claim, task, pooled.slice(0, SCHEDULE_PROPOSALS_PER_RUN), controller.signal, () => abortReason);
    } finally {
      current = undefined;
    }
    const { applied, waiting } = settled;
    const finishedAt = deps.now().toISOString();
    const folded = foldRunStatus(results, abortReason, capped);
    const fold: Fold = folded.status === 'capped' && cappedReason !== undefined ? { status: 'capped', reason: cappedReason } : folded;
    const made = applied !== undefined ? { applied } : {};
    const row = fitRunRow({
      ...claim,
      status: fold.status,
      finishedAt,
      steps: results,
      calls,
      ...(waiting.length > 0
        ? {
            proposals: {
              items: waiting,
              expiresAt: new Date(instant(finishedAt) + SCHEDULE_PROPOSAL_TTL_MS).toISOString(),
            },
          }
        : {}),
      ...made,
      ...(fold.reason !== undefined ? { reason: cut(fold.reason, SCHEDULE_RUN_REASON_MAX_CHARS) } : {}),
    });
    try {
      db.putScheduleRun(row);
    } catch {
      // The full result is refused (the byte cap, most likely): a minimal row that always parses replaces the claim (M17) — still naming what was made.
      try {
        db.putScheduleRun({ ...claim, status: fold.status, finishedAt, steps: results.map(({ status }) => ({ status })), calls, reason: RESULT_TOO_LARGE_REASON, ...made });
      } catch {
        // The schedule went away mid-run: there is nothing left to record it on.
      }
    }

    foldDailyCalls(db, calls, finishedAt);

    const fresh = db.getScheduledTask(task.id);
    if (fresh !== undefined) {
      const next = applyRunOutcome(fresh, row);
      db.putScheduledTask({ ...next, ranThrough: laterInstant(fresh.ranThrough, row.dueAt) }); // bookkeeping, never `updatedAt` (M16)
    }
    changed();

    if (fresh?.alert === 'notification' && alert !== undefined) {
      const notify = deps.notify?.();
      const facts = resultFacts(row, (appId) => db.getApp(appId)?.displayName ?? appId, new Date(finishedAt));
      if (notify !== undefined) void notify(hostNotification(db, fresh, alert.step, alert.alert, facts)).catch(() => undefined);
    }
  }

  /** A step left behind by the race settled after all: what it spent goes on the day (D-PR4-15; v2.1 Q20 — the day's counters only, never the row). */
  function foldLate(db: UserDb, late: StepOutcome | undefined): void {
    // An executor that answers late answers nothing the run can read — only what it spent.
    if (late?.calls === undefined) return;
    try {
      foldDailyCalls(db, late.calls, deps.now().toISOString());
    } catch {
      return; // the file refused the counters: nothing more can be said
    }
    changed();
  }

  /**
   * The run's waiting changes at the pooling point (D-PR4-11): a schedule armed when its run was
   * claimed walks its `ok` steps' items under the run's signal — unless the run was already aborted,
   * when they wait held `stopped` (and an abort DURING the walk ends it the same way, A3); any other
   * run's wait as the steps proposed them. `abortReason` is read when asked: the abort can land late.
   */
  async function settleChanges(
    db: UserDb,
    claim: ScheduleRun,
    task: ScheduledTask,
    pool: readonly Pooled[],
    signal: AbortSignal,
    abortReason: () => string | undefined,
  ): Promise<{ applied?: ScheduleRunApplied; waiting: ScheduleProposalItem[] }> {
    const asProposed = pool.map(({ item }) => item);
    const armable = pool.filter(({ ok }) => ok).map(({ item }) => item);
    if (task.writeAuthority === undefined || armable.length === 0) return { waiting: asProposed };
    if (abortReason() !== undefined) {
      const appId = armableAppOf(task.steps);
      return { waiting: pool.map(({ item, ok }) => (ok && item.appId === appId ? { ...item, held: 'stopped' } : item)) };
    }
    const walked = await applyArmed(db, claim, task, armable, { now: deps.now, signal });
    return { ...(walked.applied !== undefined ? { applied: walked.applied } : {}), waiting: afterWalk(pool, walked.verdicts) };
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
