// schedule/acts.ts — the user's acts on the scheduler (TASK-20261009-scheduling-framework E7,
// E8; ADR-0074 §4–§6; split out of `scheduler.ts` at Gate 5, M14). Every act here is something
// a PERSON did on a surface — create, edit, switch on or off, run now, answer the missed card,
// open a result, clear history, pause everything, cancel — plus the one host hook (`noteAppVersion`).
// The engine's own writes (claims, results, the watermark, `ranThrough`) live in `queue.ts` and
// `scheduler.ts`; nothing here runs a step.
//
// Every act validates through the protocol's strict schema, writes through the accessor and
// bumps `scheduleRevision`; the acts that EDIT a task (`createTask`, `updateTask`,
// `setTaskEnabled`, `noteAppVersion`) stamp `updatedAt` — the engine never does (Gate-5 M16).
// `createTask` compiles the spec, applies the frequency floor, derives the catch-up default and
// the freshness window, and records every named app's version — a missing app refuses by name;
// nothing here sets `enabled` but the user's own act (ADR-0074 §4).
//
// THE SWITCH AND THE FLOOR (Gate-5 S2/M2). `setTaskEnabled(true)` is a consent: it runs the
// frequency floor of the task's own provenance again (an imported 5-minute schedule is under
// the 15-minute floor it did not have where it was made) and refuses a `provenance:'imported'`
// task outright unless the caller says `reviewed` — the editor's save after the consent panel,
// the ONE surface that shows what will run. Both refusals carry `route: 'review'` so the row's
// switch can send the user to the editor instead of a dead error. `runNow`, `runPending` and
// `runAllPending` never run a schedule that is off — the user's *run now* on a paused or
// disabled schedule is refused by the schedule's name (its one act is to turn it on).
//
// SEEN (E7, Gate-5 M8). `markSeen` is a user gesture on ONE result — a row in
// `RESULT_STATUSES`; a skip or a candidate is never "seen" and never counted — so the task's
// `unseenResults` and the rows agree with `applyRunOutcome`'s fold.
//
// The two seams this module reads from `scheduler.ts` — `currentDeps()` (the db, the clock) and
// `engine()` (the queue) — are accessors, not consts, so the module cycle between the two files
// dereferences nothing at evaluation (Gate-5 M20).

import type { UserDb } from '@snugprotocol/db';
import {
  scheduledTaskSchema,
  type AlertKind,
  type MissedPolicy,
  type ScheduleRun,
  type ScheduleSpec,
  type ScheduleStep,
  type ScheduledTask,
  type TaskProvenance,
} from '@snugprotocol/protocol';

import { bumpScheduleRevision } from '../platform/signals.js';
import { globalPaused } from './copy.js';
import { compileSpec } from './cron.js';
import { defaultMissedPolicy, frequencyFloorRefusal, freshnessWindowMs } from './floors.js';
import { markSeen as markTaskSeen, pauseForAppUpdate, resumeTask } from './protection.js';
import { currentDeps, engine, freshSchedulerState, reconcile } from './scheduler.js';
import { RESULT_STATUSES, appIdsOf, messageOf, sameOccurrence } from './taskShape.js';

// ------------------------------------------------------------------------- types

export interface CreateTaskInput {
  title: string;
  steps: ScheduleStep[];
  spec: ScheduleSpec;
  missedPolicy?: MissedPolicy;
  alert?: AlertKind;
  provenance: TaskProvenance;
  ownerAppId?: string;
  startsAt?: string;
  endsAt?: string;
}

export type TaskPatch = Partial<Pick<CreateTaskInput, 'title' | 'steps' | 'spec' | 'missedPolicy' | 'alert' | 'startsAt' | 'endsAt'>>;

/**
 * A refused act, in one line. `route: 'review'` says the EDITOR is where this is answered —
 * an imported schedule's consent, a spec under the floor of its provenance — so the surface
 * that got the refusal can send the user there rather than show a dead error (S2).
 */
export type TaskRefusal = { ok: false; reason: string; route?: 'review' };
export type TaskResult = { ok: true; task: ScheduledTask } | TaskRefusal;
export type ActResult = { ok: true } | { ok: false; reason: string };

/** Who changed an app's version — only `shared` and `agent` updates pause the schedules that name it (E8). */
export type AppVersionSource = 'own' | 'shared' | 'agent';

export interface EnableOptions {
  /** The editor's save after the consent panel — the one caller that may enable an imported schedule (S2). */
  reviewed?: boolean;
}

// ----------------------------------------------------------------------- sentences

/** The refusal of a switch-on without the consent surface (S2). */
export const IMPORTED_NEEDS_REVIEW = 'this schedule arrived with an imported file — review it before turning it on';

/** The refusal of a *run now* (or a candidate) on a schedule that is off, by name (M2/S1). */
export const scheduleOff = (title: string): string => `“${title}” is off — turn it on to run it`;

// ------------------------------------------------------------------------- helpers

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Each named app's current version — or the refusal naming the first app the file does not hold. */
function appVersionsFor(db: UserDb, steps: readonly ScheduleStep[]): { ok: true; versions: ScheduledTask['appVersions'] } | { ok: false; reason: string } {
  const versions: ScheduledTask['appVersions'] = {};
  for (const appId of appIdsOf(steps)) {
    const app = db.getApp(appId);
    if (app === undefined) return refuse(`app "${appId}" is not installed in this file`);
    versions[appId] = app.currentVersion;
  }
  return { ok: true, versions };
}

function commitTask(db: UserDb, draft: ScheduledTask): TaskResult {
  const parsed = scheduledTaskSchema.safeParse(draft);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  try {
    db.putScheduledTask(parsed.data);
  } catch (err) {
    return refuse(messageOf(err));
  }
  bumpScheduleRevision();
  return { ok: true, task: parsed.data };
}

function pendingRow(db: UserDb, taskId: string, dueAt: string): ScheduleRun | undefined {
  return db.listScheduleRuns(taskId).find((row) => row.status === 'pending' && sameOccurrence(row, dueAt));
}

function enqueueOrRefuse(db: UserDb, task: ScheduledTask, dueAt: string, trigger: 'manual' | 'catch-up', collapsedCount: number): ActResult {
  const eng = engine();
  if (eng === undefined) return refuse('scheduling is not running here');
  if (!task.enabled) return refuse(scheduleOff(task.title));
  if (db.getSchedulerState()?.globalPause === true) return refuse(globalPaused);
  eng.queue.enqueue({ task, dueAt, trigger, collapsedCount });
  return { ok: true };
}

// --------------------------------------------------------------------- the acts

export async function createTask(input: CreateTaskInput): Promise<TaskResult> {
  const deps = currentDeps();
  const db = await deps.db();
  const now = deps.now();
  const nowIso = now.toISOString();
  const cron = compileSpec(input.spec, now);
  if (cron === undefined) return refuse('this schedule cannot be compiled — check the when');
  const floor = frequencyFloorRefusal(input.spec, input.provenance, now);
  if (floor !== undefined) return refuse(floor);
  const versions = appVersionsFor(db, input.steps);
  if (!versions.ok) return versions;
  const draft: ScheduledTask = {
    id: crypto.randomUUID(),
    title: input.title,
    enabled: true,
    enabledAt: nowIso,
    provenance: input.provenance,
    ...(input.ownerAppId !== undefined ? { ownerAppId: input.ownerAppId } : {}),
    steps: input.steps,
    spec: input.spec,
    cron,
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    missedPolicy: input.missedPolicy ?? defaultMissedPolicy(input.steps),
    staleAfterMs: freshnessWindowMs(input.spec, now),
    alert: input.alert ?? 'inbox',
    appVersions: versions.versions,
    createdAt: nowIso,
    updatedAt: nowIso,
    consecutiveFailures: 0,
    unseenResults: 0,
  };
  return commitTask(db, draft);
}

export async function updateTask(taskId: string, patch: TaskPatch): Promise<TaskResult> {
  const deps = currentDeps();
  const db = await deps.db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  const now = deps.now();
  const nowIso = now.toISOString();
  let { cron, staleAfterMs, appVersions } = task;
  const spec = patch.spec ?? task.spec;
  const steps = patch.steps ?? task.steps;
  if (patch.spec !== undefined) {
    const compiled = compileSpec(spec, now);
    if (compiled === undefined) return refuse('this schedule cannot be compiled — check the when');
    const floor = frequencyFloorRefusal(spec, task.provenance, now);
    if (floor !== undefined) return refuse(floor);
    cron = compiled;
    staleAfterMs = freshnessWindowMs(spec, now);
  }
  if (patch.steps !== undefined) {
    const versions = appVersionsFor(db, steps);
    if (!versions.ok) return versions;
    appVersions = versions.versions;
  }
  const next: ScheduledTask = {
    ...task,
    title: patch.title ?? task.title,
    steps,
    spec,
    cron,
    staleAfterMs,
    appVersions,
    missedPolicy: patch.missedPolicy ?? task.missedPolicy,
    alert: patch.alert ?? task.alert,
    ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
    ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
    updatedAt: nowIso,
  };
  return commitTask(db, next);
}

/**
 * Enable = the user's *Resume* or *on* (`resumeTask`: pause cleared, window from now, fresh app
 * versions) — under the floor of the task's provenance, and for an imported schedule only from
 * the editor's reviewed save (S2; see the header); disable = off, pause reason cleared.
 */
export async function setTaskEnabled(taskId: string, enabled: boolean, options: EnableOptions = {}): Promise<TaskResult> {
  const deps = currentDeps();
  const db = await deps.db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  const now = deps.now();
  const nowIso = now.toISOString();
  let next: ScheduledTask;
  if (enabled) {
    if (task.provenance === 'imported' && options.reviewed !== true) return { ok: false, reason: IMPORTED_NEEDS_REVIEW, route: 'review' };
    const floor = frequencyFloorRefusal(task.spec, task.provenance, now);
    if (floor !== undefined) return { ok: false, reason: floor, route: 'review' };
    const versions = appVersionsFor(db, task.steps);
    if (!versions.ok) return versions;
    next = resumeTask(task, nowIso, versions.versions);
  } else {
    next = { ...task, enabled: false };
    delete next.pausedReason;
  }
  return commitTask(db, { ...next, updatedAt: nowIso });
}

export async function deleteTask(taskId: string): Promise<void> {
  const db = await currentDeps().db();
  const eng = engine();
  if (eng?.queue.state.get().running?.taskId === taskId) eng.queue.cancelCurrent();
  db.deleteScheduledTask(taskId);
  bumpScheduleRevision();
}

/** The user's *run now*: one manual run, due this instant, for a schedule that is ON. Held by the global pause like every other. */
export async function runNow(taskId: string): Promise<ActResult> {
  const deps = currentDeps();
  const db = await deps.db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  return enqueueOrRefuse(db, task, deps.now().toISOString(), 'manual', 1);
}

/** The missed card's *run*: the pending candidate goes to the queue, which replaces the row with its claim. */
export async function runPending(taskId: string, dueAt: string): Promise<ActResult> {
  const db = await currentDeps().db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  const row = pendingRow(db, taskId, dueAt);
  if (row === undefined) return refuse('nothing is waiting for that time');
  return enqueueOrRefuse(db, task, row.dueAt, 'catch-up', row.collapsedCount);
}

/** The missed card's *skip*: the candidate is recorded `skipped` (reason `user`) — permanent, like any other skip. */
export async function skipPending(taskId: string, dueAt: string): Promise<ActResult> {
  const deps = currentDeps();
  const db = await deps.db();
  const row = pendingRow(db, taskId, dueAt);
  if (row === undefined) return refuse('nothing is waiting for that time');
  db.putScheduleRun({ ...row, status: 'skipped', reason: 'user', finishedAt: deps.now().toISOString() });
  bumpScheduleRevision();
  return { ok: true };
}

/** Every pending candidate of every schedule that is ON goes to the queue (S1: a schedule that is off keeps its rows unrun). */
export async function runAllPending(): Promise<number> {
  const db = await currentDeps().db();
  let queued = 0;
  for (const task of db.listScheduledTasks()) {
    if (!task.enabled) continue;
    for (const row of db.listScheduleRuns(task.id)) {
      if (row.status !== 'pending') continue;
      if (enqueueOrRefuse(db, task, row.dueAt, 'catch-up', row.collapsedCount).ok) queued += 1;
    }
  }
  return queued;
}

export async function skipAllPending(): Promise<number> {
  const deps = currentDeps();
  const db = await deps.db();
  const finishedAt = deps.now().toISOString();
  let skipped = 0;
  for (const [taskId, runs] of Object.entries(db.listAllScheduleRuns())) {
    if (db.getScheduledTask(taskId) === undefined) continue;
    for (const row of runs) {
      if (row.status !== 'pending') continue;
      db.putScheduleRun({ ...row, status: 'skipped', reason: 'user', finishedAt });
      skipped += 1;
    }
  }
  if (skipped > 0) bumpScheduleRevision();
  return skipped;
}

/** A user GESTURE on one RESULT (E7): stamps `seenAt` and takes one off the task's unseen count. Never app-derived; never a skip or a candidate (M8). */
export async function markSeen(taskId: string, dueAt: string): Promise<void> {
  const deps = currentDeps();
  const db = await deps.db();
  const row = db.listScheduleRuns(taskId).find((entry) => sameOccurrence(entry, dueAt));
  if (row === undefined || row.seenAt !== undefined || !RESULT_STATUSES.has(row.status)) return;
  const nowIso = deps.now().toISOString();
  db.markScheduleRunSeen(taskId, row.dueAt, nowIso);
  const task = db.getScheduledTask(taskId);
  if (task !== undefined) db.putScheduledTask({ ...markTaskSeen(task), updatedAt: nowIso });
  bumpScheduleRevision();
}

/** *Mark all read*: every unseen result, every schedule — one gesture. */
export async function markAllSeen(): Promise<number> {
  const deps = currentDeps();
  const db = await deps.db();
  const nowIso = deps.now().toISOString();
  let marked = 0;
  for (const task of db.listScheduledTasks()) {
    let seen = 0;
    for (const row of db.listScheduleRuns(task.id)) {
      if (!RESULT_STATUSES.has(row.status) || row.seenAt !== undefined) continue;
      db.markScheduleRunSeen(task.id, row.dueAt, nowIso);
      seen += 1;
    }
    if (seen > 0) {
      db.putScheduledTask({ ...markTaskSeen(task, seen), updatedAt: nowIso });
      marked += seen;
    }
  }
  if (marked > 0) bumpScheduleRevision();
  return marked;
}

/** Settings' *Clear history* (one schedule, or all): the accessor keeps what is not yet dealt with. */
export async function clearHistory(taskId?: string): Promise<void> {
  const db = await currentDeps().db();
  db.clearScheduleHistory(taskId);
  bumpScheduleRevision();
}

/**
 * The global pause (E7). On: nothing is planned (the planner holds the watermark, so held
 * occurrences come back `late`, then missed like any other), waiting items are dropped
 * unclaimed and a run in flight is recorded `interrupted` (reason `paused`). Off: reconcile now.
 */
export async function setGlobalPause(on: boolean): Promise<void> {
  const deps = currentDeps();
  const db = await deps.db();
  const state = db.getSchedulerState() ?? freshSchedulerState(deps.now().toISOString());
  db.setSchedulerState({ ...state, globalPause: on });
  if (on) engine()?.queue.abortAll('paused');
  bumpScheduleRevision();
  if (!on) await reconcile('manual');
}

/** The running chip's *cancel*: the run in flight is recorded `interrupted` (reason `cancelled`). */
export function cancelRunning(): void {
  engine()?.queue.cancelCurrent();
}

/**
 * The E8 hook. An app's version changed: for a SHARED or AGENT update, every schedule naming
 * the app at another version is paused `app-updated` (its recorded versions kept, so the
 * resume card can name the change); the user's OWN edits change nothing. Answers how many
 * schedules were paused. Its callers land in PR-B.
 */
export async function noteAppVersion(appId: string, version: number, source: AppVersionSource): Promise<number> {
  if (source === 'own') return 0;
  const deps = currentDeps();
  const db = await deps.db();
  const nowIso = deps.now().toISOString();
  let paused = 0;
  for (const task of db.listScheduledTasks()) {
    const next = pauseForAppUpdate(task, appId, version);
    if (next === task) continue;
    db.putScheduledTask({ ...next, updatedAt: nowIso });
    paused += 1;
  }
  if (paused > 0) bumpScheduleRevision();
  return paused;
}
