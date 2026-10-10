// access/appDrift.ts — a reader replaced under its access pauses it (TASK-20261010-cross-app-access
// AC21; ADR-0075 §9; ADR-0074 E8; D18).
//
// The user allowed access to the app as it WAS: its code at that version, asking for that
// purpose. When someone other than the user replaces that code — a shared bundle taken from the
// shelf, an agent hand-in — the app that now holds the access is not the one the user allowed,
// so every live access it holds as a READER is paused `reader-updated` until the user looks
// (*allow again* is one tap on a prefilled consent). E8's rule exactly, not a wider one: the
// user's own builder edit is not drift (they are the one who changed it — R-7's class, disclosed),
// and a starter update from Snug changes nothing either. The access an app GIVES is untouched by
// its own update: what a reader may read is guarded at every query by the column-drift check.
//
// Every pause goes through the engine's one suspender (`grants.ts suspendAccess`), so each keeps
// D25's invariants, writes its `suspended` line on the SOURCE's history, drops the cached bytes,
// rings the reader's live frame `access-changed { grantId }` and bumps the revision.
//
// Called ONLY from `state/appVersionChanged.ts` — the one fan-out beside the schedules' pause (a
// source scan in accessDrift.test.ts pins it). Synchronous at the db altitude like its sibling:
// the hand-in path runs in the kit at boot, holding the db it wrote to.

import type { UserDb } from '@snugprotocol/db';

import type { AppVersionSource } from '../schedule/appDrift.js';
import { findAccessGrant, grantsForApp, suspendAccess } from './grants.js';

/** Who replaced the app: the schedules' three sources, plus a starter update from Snug. */
export type ReaderVersionSource = AppVersionSource | 'starter';

/** E8's rule: only a change the user did not make themselves, from someone other than Snug, is drift. */
export function readerUpdateSuspends(source: ReaderVersionSource): boolean {
  return source === 'shared' || source === 'agent';
}

/**
 * Pause every LIVE access `appId` holds as a reader that was allowed at another version — a
 * `shared` or `agent` update only. Answers how many were paused (0 for `own` and `starter`, and
 * for an app that reads nothing).
 */
export function suspendAccessForAppVersion(db: UserDb, appId: string, version: number, source: ReaderVersionSource, nowIso: string): number {
  if (!readerUpdateSuspends(source)) return 0;
  const at = Date.parse(nowIso);
  const drifted = grantsForApp(db, appId, at)
    .reads.filter((row) => row.grant.status === 'active' && !row.expired && row.grant.readerVersion !== version)
    .map((row) => row.grant.id);
  for (const grantId of drifted) {
    // The suspender does its work before it settles; a refusal it meets is reported, never thrown at the update.
    void suspendAccess(db, grantId, 'reader-updated', nowIso).catch((err: unknown) => {
      console.warn('access: an update could not pause the access the app held', err);
    });
  }
  // Counted from the grants as they now stand, so a pause that did not land is never claimed.
  return drifted.filter((grantId) => {
    const now = findAccessGrant(db, grantId)?.grant;
    return now?.status === 'suspended' && now.suspendedReason === 'reader-updated';
  }).length;
}
