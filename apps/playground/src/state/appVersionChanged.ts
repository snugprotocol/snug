// state/appVersionChanged.ts — THE one fan-out when an app's version changes under the user
// (TASK-20261010-cross-app-access AC14/AC21, D18; TASK-20261009 E8, ADR-0074 §6; ADR-0075 §9).
//
// Two things trusted the app's old code: the schedules that recorded its version at enable, and
// the access the user allowed it as a reader. Both pause on E8's one rule — a `shared` or `agent`
// update pauses, the user's `own` edit and a `starter` update do not — and both used to be one
// call each at every place an app is replaced. Two separate calls drift one call site at a time
// (a new update path that remembers the schedules and forgets the access is a grant the user
// never re-read), so every such place calls THIS, and nothing else calls either pause function:
// `share/installShared.ts applySharedUpdate`, both call expressions in `apps/host/src/handin.ts`,
// and `schedule/acts.ts noteAppVersion` (a source scan in accessDrift.test.ts pins it).
//
// At the db altitude, synchronous, holding the db the caller wrote to — the hand-in runs in the
// kit at boot, before or without an engine.

import type { UserDb } from '@snugprotocol/db';

import { suspendAccessForAppVersion, type ReaderVersionSource } from '../access/appDrift.js';
import { pauseSchedulesForAppVersion } from '../schedule/appDrift.js';

/** Who changed the app: the user (`own`), a shared bundle, the agent's hand-in, or a starter update. */
export type AppChangeSource = ReaderVersionSource;

export interface AppVersionChangeOutcome {
  /** Enabled schedules paused `app-updated`. */
  schedulesPaused: number;
  /** Live access the app held as a reader, paused `reader-updated`. */
  accessSuspended: number;
}

/** `appId` is now at `version` because of `source`: pause what trusted the old code. */
export function onAppVersionChanged(db: UserDb, appId: string, version: number, source: AppChangeSource, nowIso: string): AppVersionChangeOutcome {
  // The schedules' rule predates the starter source; a starter update pauses nothing there either.
  const schedulesPaused = source === 'starter' ? 0 : pauseSchedulesForAppVersion(db, appId, version, source, nowIso);
  const accessSuspended = suspendAccessForAppVersion(db, appId, version, source, nowIso);
  return { schedulesPaused, accessSuspended };
}
