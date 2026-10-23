// engine-types.ts — the seam between the scheduler's queue and the step executors
// (TASK-20261009-scheduling-framework R1, ADR-0074 §5–§6).
//
// The queue decides WHEN and claims the run; an executor decides WHAT one step does. They
// meet on this file alone so each can be tested with the other faked: the queue's tests
// inject a recording executor, the executors' tests inject a fake transport and db.

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleProposalItem, ScheduleStep, ScheduledTask, StepFetched, StepResult, StepResultStatus, StepSaw, StepTools } from '@snugprotocol/protocol';

import type { SchedulerSeat } from '../platform/platform.js';

/** What a step may read while it runs. Nothing here reaches a credential. */
export interface StepContext {
  task: ScheduledTask;
  run: { id: string; taskId: string; dueAt: string; trigger: 'due' | 'late' | 'catch-up' | 'manual' };
  db: UserDb;
  /** Aborted by the queue's bound, by a file swap and by the user's cancel. */
  signal: AbortSignal;
  now: () => Date;
  /** The host's notification seat, when it carries one — the executor SUGGESTS, the queue decides. */
  notify?: SchedulerSeat['notify'] | undefined;
  /**
   * Ask the queue to record THIS run `interrupted` with `reason` and abort it. The executor
   * still answers its outcome once the signal fires; the queue folds the run. No shipped executor
   * calls it: an app opening or closing mid-run is a HANDOVER inside the *Run [app]* executor
   * (ADR-0077 §5 — the same `runId` re-dispatched to where the app now lives, at most once), never
   * an interruption. The seam stays for an executor that must stop its own run.
   */
  interrupt?: ((reason: string) => void) | undefined;
  /** What the steps before this one already spent on this run — the ceiling counts it (PR-B A4/A5). */
  spent?: (() => { ai: number; net: number }) | undefined;
  /**
   * When the queue's bound aborts this run, in epoch milliseconds (TASK-20261010-host-broker PR-4,
   * D-PR4-15): a step that may look things up stops itself `APP_AGENT_DEADLINE_MARGIN_MS` before it,
   * so it answers WITH the calls it spent instead of losing them to the race.
   */
  boundAt?: number | undefined;
  /**
   * How many changes the steps before this one already left for the run (TASK-20261010-host-broker
   * PR-4 Gate 5, J7): a run keeps at most `SCHEDULE_PROPOSALS_PER_RUN`, so a step that proposes as
   * it goes refuses the one past that — out loud — instead of hearing it was kept and losing it.
   */
  proposalsSoFar?: (() => number) | undefined;
}

/** One step's outcome — data, never a throw (a throw is a `failed` outcome with its message). */
export interface StepOutcome {
  status: StepResultStatus;
  /** What the user reads in the result. Scrubbed before it is stored. */
  summary?: string | undefined;
  /** What this step spent, charged to the day's ceilings. */
  calls: { ai: number; net: number };
  /** Pending data changes an *Ask the AI* step produced — dry-run on the scratch copy, never executed here. */
  proposals?: ScheduleProposalItem[] | undefined;
  /** A louder notice the executor suggests; the queue honours it only when the task's `alert` allows. */
  alert?: { title: string; body: string } | undefined;
  /**
   * The step met the day's ceiling (TASK-20261010-host-broker PR-1, D-PR1-6): refused BEFORE a
   * delegated dispatch when a counter had no headroom, or marked after the fact when a run on the
   * open app crossed a ceiling inside its window (app code is not stopped). The queue folds the run
   * `capped`. WHICH ceiling, when the step knows it (PR-4 Gate 5, J6): `'ai'` or `'net'` — the
   * run's reason then names that limit in the host's words; a bare `true` keeps the step's summary
   * as the reason. In-memory only — the persisted step result keeps its shape (D-PR1-1).
   */
  capped?: boolean | 'ai' | 'net' | undefined;
  // PR-4's host facts (TASK-20261010-host-broker D-PR4-17), carried onto the persisted step result
  // as they are; each absent when it has nothing to say (omit-defaults).
  /** An *app-run* step ran in the app the user had open. */
  inOpenApp?: StepResult['inOpenApp'];
  /** The shared tables this step read — only when it read any. */
  saw?: StepSaw[] | undefined;
  /** What a step that may look things up did with its tools, or why it answered without them. */
  tools?: StepTools | undefined;
  /** What an *ask* step's *fetch new data first* came to, per source (TASK-20261010-host-broker PR-5, D-PR5-19) — only when it asked. */
  fetched?: StepFetched[] | undefined;
  /** No brain may answer this step here (the demo override or a keyless BYOK) — the page offers *open Settings*. */
  blockedBy?: StepResult['blockedBy'];
  /**
   * A `failed` step whose brain said "try again shortly" (TASK-20261023-siwc-chatgpt-plan L4-7:
   * the ChatGPT plan's `CHATGPT_USAGE_UNAVAILABLE` after its one retry). IN MEMORY ONLY: the
   * persisted `StepResult` is strict (C3) and never carries it — `queue.ts`'s `toStepResult` is the
   * one place an outcome becomes a result, and it builds the result field by field.
   */
  retryable?: boolean | undefined;
}

export type StepExecutor = (step: ScheduleStep, ctx: StepContext) => Promise<StepOutcome>;
