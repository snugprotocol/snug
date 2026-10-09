// schedule/scheduleKey.ts — the kv handshake's names, and the one write the boot sweep makes
// (TASK-20261009-scheduling-framework A3; ADR-0074 §3; Gate-5 PR-B M8, S7).
//
// ONE HOME, OWNED BY NEITHER SIDE. The executor (`appRun.ts`) writes the key and rings the hint;
// the scheduler's boot sweep (`scheduler.ts`) clears the key of a claim a dead tab left behind.
// Before M8 the scheduler imported the executor for that one function — and with it the page
// runtime the executor composes (`run/appRuntime.ts` → `state/net.ts` → `state/userdb.ts` →
// back into `scheduler.ts`), the cycle `executors.ts` has to defer its composition around.
// The names live here so the scheduler never loads the executor.
//
// AN APP THE FILE DOES NOT HOLD IS NEVER ASKED (S7). A task can name an app the file has lost —
// the C3 cascade deleted it, or the task arrived with an import that did not carry the app. A
// kv write for such an app would OPEN its namespace: the driver creates the app-data store on
// first touch, and the next flush lands an app-data file in the user's file for an app that does
// not exist. So the sweep clears only where `db.getApp` answers a row; the user db's own facade
// refuses the rest (`NOT_FOUND`) as a second line.

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleRun, ScheduledTask } from '@snugprotocol/protocol';

import { appIdsOf } from './taskShape.js';

/** The host-event that tells the app a scheduled run is waiting in its kv. Ids only (R7). */
export const SCHEDULE_RUN_EVENT = 'schedule-run';
/** The app-event the app answers with. */
export const SCHEDULE_RESULT_EVENT = 'schedule-result';
/** The kv key family the handshake rides; one key per run. */
export const SCHEDULE_KV_KEY_PREFIX = 'snug:schedule:';
export const scheduleKvKey = (runId: string): string => `${SCHEDULE_KV_KEY_PREFIX}${runId}`;

/**
 * Clear the handshake key of a run that can no longer answer — the stale-claim sweep at boot and
 * on a late or visible wake. Only in apps the file holds (S7). Never throws.
 */
export async function clearScheduleKey(db: UserDb, run: Pick<ScheduleRun, 'id'>, task: Pick<ScheduledTask, 'steps'> | undefined): Promise<void> {
  if (task === undefined) return;
  const key = scheduleKvKey(run.id);
  for (const appId of appIdsOf(task.steps.filter((step) => step.kind === 'app-run'))) {
    if (db.getApp(appId) === undefined) continue; // a ghost: no namespace is opened for it
    try {
      await db.driver.kvSet(appId, key, null);
    } catch {
      // The driver answers errors as data; a throw here would be a closed driver — nothing to clear.
    }
  }
}
