// schedule/protection.ts — the pure self-protection rules (TASK-20261009-scheduling-framework
// E7, E8; ADR-0074 §6; Q5). Token spend without a reader is the one way this feature can quietly
// cost money, so every rule here is a value over a task, a run and the scheduler's state —
// no React, no store, no I/O — and every function answers a NEW object, never touching its input.
//
// THE DAY. `dailyCounters` keys the counters on the UTC date of the instant it is given. The
// counters live in the user's FILE (`schedulerState.daily`), and a file roams between devices
// and zones; a per-file day must not reset at some device's local midnight, or two devices in
// different zones would each see a fresh day and together spend twice the ceiling. A UTC day is
// the same day everywhere the file goes.
//
// THE CEILINGS. `wouldExceedCeiling` is the queue's question before a run (reaching the
// ceiling exactly is allowed; one past it is `capped`); `ceilingWarning` is the editor's 80 %
// line. `ai` is answered before `net` when both apply.
//
// THE OUTCOME FOLD. Every RESULT — a status in `RESULT_STATUSES` (`taskShape.ts`: ok, failed,
// needs-you, interrupted, capped, no-handler — the one set the view's unseen count and the
// user's `markSeen` read too; Gate-5 M8) — adds an unseen result. `ok` resets the failure
// streak; `failed` and `no-handler` lengthen it — the fifth pauses the task (`failures`);
// `needs-you`, `interrupted` and `capped` leave the streak alone (the gate's refusal, a cancel
// or a ceiling, not the app's failure); `skipped`, `pending` and `running` change nothing.
// Thirty unseen results pause the task (`ignored`); `seenAt` — and so `markSeen` — is a USER
// gesture only, never an app-derived signal. A task that is already paused keeps its first
// reason: a late outcome never rewrites why the user was told it stopped.
//
// APP DRIFT (E8). `pauseForAppUpdate` pauses a task that names the app at another version and
// leaves `appVersions` AS RECORDED, so the resume card can name the change (recorded → current);
// `resumeTask` takes the fresh versions from that card and records them. `appDrift` reports only
// an app that is present at a different version — an app missing from the library is not drift,
// it is `appMissing` on the step that needs it.
//
// `updatedAt` is never touched here: the one writer that persists a task stamps it.

import { SCHEDULE_DAILY_CEILINGS, type ScheduleRun, type ScheduledTask, type SchedulerState } from '@snugprotocol/protocol';

import { RESULT_STATUSES } from './taskShape.js';

/** The fifth consecutive failure pauses the task (`failures`). */
export const PAUSE_AFTER_FAILURES = 5;
/** The thirtieth result nobody opened pauses the task (`ignored`). */
export const PAUSE_AFTER_UNSEEN = 30;
/** The editor and the Schedule page warn at this share of a daily ceiling. */
export const CEILING_WARN_SHARE = 0.8;

export type DailyCounters = SchedulerState['daily'];
export type CeilingKind = keyof typeof SCHEDULE_DAILY_CEILINGS;

/** The counters for the UTC day of `nowIso` — the same object while the day holds, zeros on a new day. */
export function dailyCounters(state: SchedulerState, nowIso: string): DailyCounters {
  const ms = Date.parse(nowIso);
  if (Number.isNaN(ms)) return state.daily;
  const date = new Date(ms).toISOString().slice(0, 10);
  return state.daily.date === date ? state.daily : { date, ai: 0, net: 0 };
}

/** Which ceiling `add` would push past — `undefined` when the run fits. */
export function wouldExceedCeiling(daily: DailyCounters, add: { ai?: number; net?: number }): CeilingKind | undefined {
  if (daily.ai + (add.ai ?? 0) > SCHEDULE_DAILY_CEILINGS.ai) return 'ai';
  if (daily.net + (add.net ?? 0) > SCHEDULE_DAILY_CEILINGS.net) return 'net';
  return undefined;
}

/** Which ceiling is at 80 % or more — `undefined` below the line. */
export function ceilingWarning(daily: DailyCounters): CeilingKind | undefined {
  if (daily.ai >= SCHEDULE_DAILY_CEILINGS.ai * CEILING_WARN_SHARE) return 'ai';
  if (daily.net >= SCHEDULE_DAILY_CEILINGS.net * CEILING_WARN_SHARE) return 'net';
  return undefined;
}

/** The task after one run's outcome (see the header for the fold); a new object. */
export function applyRunOutcome(task: ScheduledTask, run: ScheduleRun): ScheduledTask {
  let consecutiveFailures = task.consecutiveFailures;
  const unseenResults = task.unseenResults + (RESULT_STATUSES.has(run.status) ? 1 : 0);
  switch (run.status) {
    case 'ok':
      consecutiveFailures = 0;
      break;
    case 'failed':
    case 'no-handler':
      consecutiveFailures += 1;
      break;
    case 'needs-you':
    case 'interrupted':
    case 'capped':
    case 'skipped':
    case 'pending':
    case 'running':
      break;
    default: {
      const never: never = run.status;
      return never;
    }
  }
  const next: ScheduledTask = { ...task, consecutiveFailures, unseenResults };
  if (task.pausedReason !== undefined) return next;
  if (consecutiveFailures >= PAUSE_AFTER_FAILURES) return { ...next, pausedReason: 'failures', enabled: false };
  if (unseenResults >= PAUSE_AFTER_UNSEEN) return { ...next, pausedReason: 'ignored', enabled: false };
  return next;
}

/** The user opened `n` results (a gesture — never an app-derived signal). Never below zero. */
export function markSeen(task: ScheduledTask, n = 1): ScheduledTask {
  return { ...task, unseenResults: Math.max(0, task.unseenResults - Math.max(0, n)) };
}

/**
 * The user's *Resume*: the pause is cleared, the task is enabled from `nowIso` (the reconcile
 * window starts there — scope F2) and both counters start over. `appVersions`, when the card
 * carries them (the `app-updated` case), are recorded afresh.
 */
export function resumeTask(task: ScheduledTask, nowIso: string, appVersions?: ScheduledTask['appVersions']): ScheduledTask {
  const next: ScheduledTask = { ...task, enabled: true, enabledAt: nowIso, consecutiveFailures: 0, unseenResults: 0 };
  delete next.pausedReason;
  if (appVersions !== undefined) next.appVersions = appVersions;
  return next;
}

/**
 * A SHARED or AGENT update of `appId` to `newVersion` (E8): a task that names the app at another
 * version is paused `app-updated`, its recorded versions untouched so the card can name the
 * change. A task that does not name the app, already has this version, or is already paused for
 * this reason is answered unchanged (the same object).
 */
export function pauseForAppUpdate(task: ScheduledTask, appId: string, newVersion: number): ScheduledTask {
  const recorded = task.appVersions[appId];
  if (recorded === undefined || recorded === newVersion) return task;
  if (task.pausedReason === 'app-updated' && !task.enabled) return task;
  return { ...task, enabled: false, pausedReason: 'app-updated' };
}

/** The app ids whose current version differs from the one recorded at enable; a missing app is not drift. */
export function appDrift(task: ScheduledTask, currentVersions: Record<string, number>): string[] {
  const drifted: string[] = [];
  for (const [appId, recorded] of Object.entries(task.appVersions)) {
    const current = currentVersions[appId];
    if (current !== undefined && current !== recorded) drifted.push(appId);
  }
  return drifted;
}
