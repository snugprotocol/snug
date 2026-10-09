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

import type { UserDb } from '@snugprotocol/db';
import type { ScheduledTask } from '@snugprotocol/protocol';

import { bumpScheduleRevision } from '../platform/signals.js';
import { pauseForAppUpdate } from './protection.js';

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
 * The schedules an update of `appId` WILL pause: the enabled ones that recorded the app at
 * enable (an update always writes a higher version than any recorded one). What the
 * update-confirm card names before the user says yes (E8).
 */
export function schedulesNamingApp(tasks: readonly ScheduledTask[], appId: string): ScheduledTask[] {
  return tasks.filter((task) => task.enabled && task.appVersions[appId] !== undefined);
}

const NAMED_MAX = 3;

/** The confirm card's one sentence, or nothing when no schedule names the app. */
export function updatePausesSentence(titles: readonly string[]): string | undefined {
  if (titles.length === 0) return undefined;
  const named = titles.slice(0, NAMED_MAX).map((title) => `“${title}”`);
  const rest = titles.length - named.length;
  const list = rest > 0 ? `${named.join(', ')} and ${rest} more` : named.length === 1 ? named[0]! : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
  const what = titles.length === 1 ? 'the schedule that runs this app' : `${titles.length} schedules that run this app`;
  return `Updating pauses ${what} — ${list} — until you turn ${titles.length === 1 ? 'it' : 'them'} back on from the Schedule page.`;
}
