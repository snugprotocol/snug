// engine-types.ts — the seam between the scheduler's queue and the step executors
// (TASK-20261009-scheduling-framework R1, ADR-0074 §5–§6).
//
// The queue decides WHEN and claims the run; an executor decides WHAT one step does. They
// meet on this file alone so each can be tested with the other faked: the queue's tests
// inject a recording executor, the executors' tests inject a fake transport and db.

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleProposalItem, ScheduleStep, ScheduledTask, StepResultStatus } from '@snugprotocol/protocol';

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
}

export type StepExecutor = (step: ScheduleStep, ctx: StepContext) => Promise<StepOutcome>;
