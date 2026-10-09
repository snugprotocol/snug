// schedule/taskShape.ts — the four small facts about a task and its runs that the engine, the
// page model and the views all need (TASK-20261009-scheduling-framework Gate-5 M12: one home,
// not three private copies that drift). Pure: no React, no store, no I/O.
//
//  - `RESULT_STATUSES` — which run statuses are a RESULT a person may open. ONE set, read by
//    `applyRunOutcome` (the task's `unseenResults` moves for exactly these — M8), by the user's
//    `markSeen` (it takes one off the counter only for a row in this set), by the view's unseen
//    count and by the results list. A candidate (`pending`), a claim (`running`) and a skip are
//    never results.
//  - `appIdsOf` — the distinct apps a step list names, in step order; a reminder names none.
//  - `sameOccurrence` — a run row and a due instant are the same occurrence when their instants
//    agree, not only their spellings (the schema admits `…:00Z` beside `…:00.000Z`).
//  - `messageOf` — an error's one line, for a refusal that must never throw.

import type { RunStatus, ScheduleRun, ScheduleStep } from '@snugprotocol/protocol';

/** The statuses that are a RESULT the user may open — never a candidate, a claim or a skip. */
export const RESULT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['ok', 'failed', 'needs-you', 'interrupted', 'capped', 'no-handler']);

/** The distinct app ids a step list names, in step order. */
export const appIdsOf = (steps: readonly ScheduleStep[]): string[] => [...new Set(steps.flatMap((step) => (step.kind === 'notify' ? [] : [step.appId])))];

/** The row stands for the occurrence at `dueAt` — compared as instants, with the string compare as the fast path. */
export const sameOccurrence = (row: ScheduleRun, dueAt: string): boolean => row.dueAt === dueAt || Date.parse(row.dueAt) === Date.parse(dueAt);

/** The one line of an unknown thrown value. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
