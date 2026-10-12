// schedule/taskShape.ts — the small facts about a task and its runs that the engine, the
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
//
// MAKING CHANGES ON ITS OWN (TASK-20261010-host-broker PR-4 Gate 5, A11/UI-12) — the arming rules
// the engine enforces and the editor offers by, written ONCE so the two can never disagree:
//  - `armableAppOf` — the ONE app a schedule may make changes to on its own (v2.1 N4), or none;
//  - `widens` — whether an edit widens what an armed schedule may do, so the consent is asked
//    again (D-PR4-8): its steps changed (each through its schema, then canonical JSON — key order
//    and a default spelled out are not a change), its owning app changed, or its occurrences came
//    closer together (the shortest gap got SHORTER; a one-off never comes closer than itself);
//  - `installedAfterArming` — the app under the armed id was installed AFTER the consent was
//    given: a reinstall under the same id never inherits it (A6).

import {
  canonicalJson,
  scheduleStepSchema,
  type RunStatus,
  type ScheduleRun,
  type ScheduleSpec,
  type ScheduleStep,
  type ScheduleWriteAuthority,
} from '@snugprotocol/protocol';

import { minIntervalMs } from './floors.js';

/** The statuses that are a RESULT the user may open — never a candidate, a claim or a skip. */
export const RESULT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['ok', 'failed', 'needs-you', 'interrupted', 'capped', 'no-handler']);

/** The distinct app ids a step list names, in step order. */
export const appIdsOf = (steps: readonly ScheduleStep[]): string[] => [...new Set(steps.flatMap((step) => (step.kind === 'notify' ? [] : [step.appId])))];

/** The row stands for the occurrence at `dueAt` — compared as instants, with the string compare as the fast path. */
export const sameOccurrence = (row: ScheduleRun, dueAt: string): boolean => row.dueAt === dueAt || Date.parse(row.dueAt) === Date.parse(dueAt);

/** The one line of an unknown thrown value. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------- making changes on its own

/**
 * The ONE app a schedule may make changes to on its own (v2.1 N4): it asks at least one app's AI,
 * and every step that names an app names that one — else none. The arming act admits by this rule,
 * the walk applies under it, and the editor offers the choice by it.
 */
export function armableAppOf(steps: readonly ScheduleStep[]): string | undefined {
  if (!steps.some((step) => step.kind === 'app-think')) return undefined;
  const apps = appIdsOf(steps);
  return apps.length === 1 ? apps[0] : undefined;
}

/** What `widens` compares: the schedule as it is, and an edit — every field absent from the edit is unchanged. */
export interface ArmedShape {
  steps: readonly ScheduleStep[];
  spec: ScheduleSpec;
  ownerAppId?: string | undefined;
}

/** Steps as the file compares them: each through its schema (defaults filled) and canonical JSON — key order is not a change. */
const canonicalSteps = (steps: readonly ScheduleStep[]): string => canonicalJson(steps.map((step) => scheduleStepSchema.safeParse(step).data ?? step));

/** The shortest gap between occurrences; a one-off (or a spec with no measurable period) never comes closer than itself. */
const shortestGapMs = (spec: ScheduleSpec, anchor: Date): number => minIntervalMs(spec, anchor) ?? Number.POSITIVE_INFINITY;

/**
 * Whether `after` WIDENS what an armed schedule may do (D-PR4-8) — see the header. A title, an alert
 * or a catch-up choice never does. `anchor` is the instant a custom spec's gaps are measured from.
 */
export function widens(before: ArmedShape, after: Partial<ArmedShape>, anchor: Date): boolean {
  if (after.steps !== undefined && canonicalSteps(after.steps) !== canonicalSteps(before.steps)) return true;
  if (after.ownerAppId !== undefined && after.ownerAppId !== before.ownerAppId) return true;
  return after.spec !== undefined && shortestGapMs(after.spec, anchor) < shortestGapMs(before.spec, anchor);
}

/** The app under this id was installed after the consent was given (A6) — compared as instants. */
export const installedAfterArming = (app: { readonly createdAt: string }, authority: Pick<ScheduleWriteAuthority, 'armedAt'>): boolean =>
  Date.parse(app.createdAt) > Date.parse(authority.armedAt);
