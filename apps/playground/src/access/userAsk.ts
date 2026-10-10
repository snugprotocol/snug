// access/userAsk.ts — the user's own ask from host chrome, in its three forms, with ONE recipe
// in the UI (TASK-20261010-cross-app-access AC19, AC21; D12, D34, D36). A leaf: no React.
//
//   - the creation act (*let Budget read another app…*) — the engine's `requestAccessForUser`;
//   - *allow again* on a paused or ended row — a prefilled ask that RENEWS that access;
//   - *allow…* on a declined ask — the ask the user turned down, ranked by its own hints.
//
// Every form is the user's act (`provenance: 'user'`, the host's fixed purpose — D34), parks ONE
// pending (or opens the one already waiting) and opens the review.
//
// ALLOW AGAIN IS ONE TAP (AC21). The sheet starts on the renewed access's OWN duration and away
// box (`renewSeedOf` — the sheet's default would otherwise be the session, which D36 never
// re-activates in place), so the prefilled *allow* puts that access back as it was. If the user
// picks another duration instead, the new access for the same pair REPLACES the old one: the old
// one is stopped, so a paused row never lingers with *allow again* beside its successor.
//
// A DECLINED ASK STAYS DECLINED until the user allows it: the decline is cleared only by an
// *allow*, never by opening the sheet — *not now* or Escape keeps the user's earlier no on record
// (D12: a refusal is never silently discarded).

import type { AccessDuration } from '@snugprotocol/protocol';
import type { AccessDecline, UserDb } from '@snugprotocol/db';

import { collectSources, openReview, parkAccessRequest, pendingAccessStore, requestAccessForUser, type ConsentOutcome, type PendingAccessRequest } from './consent.js';
import { ACCESS_SHEET } from './copy.js';
import { accessDeps, bumpAccessRevision, readerGeneration, revokeAccess, type AnyAccessGrant } from './grants.js';

/** What the sheet starts on when it renews an access: that access's own duration and away box. */
export interface RenewSeed {
  duration: AccessDuration;
  unattended: boolean;
}

const seeds = new WeakMap<PendingAccessRequest, RenewSeed>();

/** The seed of a renewing ask (`undefined` for every other ask — the sheet's own defaults then). */
export function renewSeedOf(pending: PendingAccessRequest): RenewSeed | undefined {
  return seeds.get(pending);
}

/** Give a parked renewing ask its seed. A session access is never usable while away (D30), so its seed never ticks the box. */
export function seedRenewal(pending: PendingAccessRequest, seed: RenewSeed): void {
  seeds.set(pending, { duration: seed.duration, unattended: seed.duration !== 'session' && seed.unattended });
}

export interface UserAskOptions {
  /** *allow again*: the access to renew, with its duration (the engine's row carries both). */
  renew?: { grant: AnyAccessGrant; duration: AccessDuration };
  /** *allow…*: the declined ask to reconsider. */
  decline?: AccessDecline;
}

/** After the user's answer: a declined ask that was allowed is no longer declined; a renewal under a new id replaces the old access. */
function settleFor(db: UserDb, readerAppId: string, opts: UserAskOptions): (outcome: ConsentOutcome) => void {
  return (outcome) => {
    if (outcome.kind !== 'allowed') return;
    const { decline, renew } = opts;
    if (decline !== undefined) {
      try {
        db.clearAccessDecline(readerAppId, decline.hash);
        bumpAccessRevision();
      } catch {
        // the app went away under the answer: its decline rows went with it
      }
    }
    if (renew !== undefined && outcome.grantId !== renew.grant.id && outcome.sourceAppId === renew.grant.sourceAppId) {
      void revokeAccess(renew.grant.id);
    }
  };
}

/**
 * THE user's ask for `readerAppId`: parked as the user's (`provenance: 'user'`, the host purpose),
 * then reviewed. With no options it is the engine's creation act; an ask already waiting for this
 * app is opened instead of replaced.
 */
export async function startUserAsk(readerAppId: string, opts: UserAskOptions = {}): Promise<void> {
  if (opts.renew === undefined && opts.decline === undefined) {
    await requestAccessForUser(readerAppId);
    return;
  }
  if (pendingAccessStore.get()[readerAppId] !== undefined) {
    openReview(readerAppId);
    return;
  }
  const db = await accessDeps().getDb();
  const reader = db.getApp(readerAppId);
  if (reader === undefined) return;
  const hints = opts.decline?.hints;
  const candidates = await collectSources(db, readerAppId, hints);
  if (pendingAccessStore.get()[readerAppId] === undefined) {
    const { renew, decline } = opts;
    const pending = parkAccessRequest({
      db,
      reader,
      generation: readerGeneration(readerAppId) ?? -1,
      purpose: ACCESS_SHEET.userPurpose(reader.displayName),
      provenance: 'user',
      candidates,
      ...(decline !== undefined ? { hints: decline.hints, hash: decline.hash } : {}),
      ...(renew !== undefined
        ? { renew: { grantId: renew.grant.id, sourceAppId: renew.grant.sourceAppId, tables: renew.grant.scope.tables.map((table) => table.name) } }
        : {}),
      settle: settleFor(db, readerAppId, opts),
    });
    if (renew !== undefined) seedRenewal(pending, { duration: renew.duration, unattended: renew.grant.unattended });
  }
  openReview(readerAppId);
}
