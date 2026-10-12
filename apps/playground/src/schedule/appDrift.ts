// schedule/appDrift.ts — the app-drift pause at the db altitude (TASK-20261009 E8, ADR-0074 §6).
//
// A schedule records each named app's version at enable (`appVersions`). When an app is
// replaced UNDER the schedule by someone other than the user — a shared bundle taken from
// the shelf, an agent hand-in applied silently to an unedited copy or taken from the run
// header's offer — the schedule may no longer mean what the user enabled, so it is paused
// `app-updated` until they look (the resume card names the change). The user's OWN edit is
// not drift: they are the one who changed the app, so `source: 'own'` pauses nothing.
//
// This lives at the db altitude, not behind the scheduler's installed deps: the hand-in path
// runs in the host kit at boot, before or without an engine, holding the db it wrote to. The
// engine learns of the pause through the schedule revision like every other writer.
//
// THE AUTHORITY IS NOT THE PAUSE (TASK-20261010-host-broker PR-4, D-PR4-8). A schedule the user
// let make its changes on its own was armed for the app's code AS IT WAS (`armedVersion`). New
// code — from ANY source, the user's own edit and a starter update included — never inherits that
// consent: `disarmSchedulesForAppVersion` takes it away, with the `app-updated` trace so the row
// can say why, independently of the pause and of every early return the pause rule has (an own
// edit pauses nothing; an already-paused task is not paused twice; neither keeps its authority).
// The armed walk's `armedVersion` belt (`applyArmed.ts`) catches a version that arrives by a
// trusted pull, which reaches no fan-out at all — through the same `disarmForAppUpdate`.

import type { UserDb } from '@snugprotocol/db';
import type { ScheduledTask } from '@snugprotocol/protocol';

import { bumpScheduleRevision } from '../platform/signals.js';
import { pauseForAppUpdate } from './protection.js';
import { appIdsOf } from './taskShape.js';

/** Who changed the app: the user (`own`), a shared bundle, or the agent's hand-in. */
export type AppVersionSource = 'own' | 'shared' | 'agent';

/**
 * Pause every enabled schedule that recorded `appId` at another version. Answers how many
 * were paused; bumps the schedule revision once when any was.
 */
export function pauseSchedulesForAppVersion(db: UserDb, appId: string, version: number, source: AppVersionSource, nowIso: string): number {
  if (source === 'own') return 0;
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

/**
 * The task without its write authority, carrying the `app-updated` trace — a disarm the user did
 * not perform, so the row says why until the next arming or save clears it (D-PR4-7). The same
 * object when there is no authority to take. `updatedAt` is the caller's: the fan-out stamps it like
 * the pause does; the walk, being the engine, never does (Gate-5 M16).
 */
export function disarmForAppUpdate(task: ScheduledTask, nowIso: string): ScheduledTask {
  if (task.writeAuthority === undefined) return task;
  const { writeAuthority: _taken, ...rest } = task;
  return { ...rest, disarmed: { reason: 'app-updated', at: nowIso } };
}

/**
 * Disarm every schedule that may change `appId`'s data on its own and was armed for another
 * version of it — whoever changed the app, enabled or not, paused or not. Answers how many; bumps
 * the schedule revision once when any was.
 */
export function disarmSchedulesForAppVersion(db: UserDb, appId: string, version: number, nowIso: string): number {
  let disarmed = 0;
  for (const task of db.listScheduledTasks()) {
    if (task.writeAuthority === undefined || task.writeAuthority.armedVersion === version || !appIdsOf(task.steps).includes(appId)) continue;
    db.putScheduledTask({ ...disarmForAppUpdate(task, nowIso), updatedAt: nowIso });
    disarmed += 1;
  }
  if (disarmed > 0) bumpScheduleRevision();
  return disarmed;
}

/**
 * The schedules an update of `appId` WILL pause: the enabled ones that recorded the app at
 * enable (an update always writes a higher version than any recorded one). What the
 * update-confirm card names before the user says yes (E8).
 */
export function schedulesNamingApp(tasks: readonly ScheduledTask[], appId: string): ScheduledTask[] {
  return tasks.filter((task) => task.enabled && task.appVersions[appId] !== undefined);
}

const NAMED_MAX = 3;

/**
 * The confirm card's one sentence, or nothing when no schedule names the app. `armed` — some named
 * schedule makes changes on its own (PR-4, D-PR4-8; v2.1 N5) — adds that the update stops it, in
 * the authority's one phrase, the number agreeing with the count.
 */
export function updatePausesSentence(titles: readonly string[], options: { armed?: boolean } = {}): string | undefined {
  if (titles.length === 0) return undefined;
  const one = titles.length === 1;
  const named = titles.slice(0, NAMED_MAX).map((title) => `“${title}”`);
  const rest = titles.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} and ${rest} more` : one ? named[0]! : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
  const what = one ? 'the schedule that runs this app' : `${titles.length} schedules that run this app`;
  const stops = options.armed !== true ? '' : one ? ' and stops it making changes on its own' : ' and stops them making changes on their own';
  return `Updating pauses ${what} — ${list} —${stops} until you turn ${one ? 'it' : 'them'} back on from the Schedule page.`;
}
