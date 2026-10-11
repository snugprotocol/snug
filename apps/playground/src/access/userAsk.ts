// access/userAsk.ts — the user's own ask from host chrome, in its four forms, with ONE recipe
// in the UI (TASK-20261010-cross-app-access AC19, AC21; D12, D34, D36; TASK-20261010-host-broker
// PR-2 AC12, D-PR2-3, D-PR2-11). A leaf: no React.
//
//   - the creation act (*let Budget read another app…*) — no options;
//   - *allow again* on a paused or ended row — a prefilled ask that RENEWS that access;
//   - *allow…* on a declined ask — the ask the user turned down, ranked by its own hints;
//   - *review* on the chat's ask card (PR-2) — the ask the chat's AI made, in its words.
//
// Every form is the user's act (`provenance: 'user'` — the host's fixed purpose for the first
// three, D34: the host's words, never the act's label, which would read as a sentence the app
// said; the AI's purpose for the fourth, which the sheet quotes as "asked in Budget's chat:"),
// parks ONE pending (or opens the one already waiting) and opens the review. Not an app ask: no
// ladder here — the chat's ask ran the ladder's rungs in its tool before the card was staged.
// This is the ONE recipe (W6 finding 14): every surface — Settings, either ⋈ sheet, *allow
// again*, *allow…*, the card — comes through `startUserAsk`, which answers what happened:
// `'opened'`, `'answer-other-first'` (the yield rule: a network or link confirm is up) or
// `'no-app'` (the app is not in the file).
//
// THE SHEET'S SEED. The sheet's default is the session (D13), except where an ask carries a
// seed (`seedSheet` / `sheetSeedOf`): an ask that RENEWS an access starts on that access's OWN
// duration and away box, so the prefilled *allow* puts it back as it was in ONE TAP (AC21 —
// D36 never re-activates a session grant in place); and the chat's ask reviewed while the
// reader is CLOSED starts on a day without the away box (D-PR2-3): a session grant made with
// the app closed binds to the NEXT frame and is readable by nobody until then — the chat could
// not use the default it just asked for. If the user picks another duration for a renewal, the
// new access for the same pair REPLACES the old one (stopped by the consent writer, on the app's
// path too — consent.ts `carryOut`), so a paused row never lingers beside its successor.
//
// THE CHAT'S ASK ALWAYS PARKS ANEW (D-PR2-11): an app's older pending for the same reader is
// dismissed by the park itself (answered not-now; the user's act wins), the new pending carries
// the ask's semantic hash and `askedIn: 'chat'`, and under the yield rule the just-parked ask
// is dismissed at once rather than left out of reach — the card keeps its acts and says so.
//
// A DECLINED ASK STAYS DECLINED until the user allows it: the decline is cleared only by an
// *allow*, never by opening the sheet — *not now* or Escape keeps the user's earlier no on record
// (D12: a refusal is never silently discarded).

import { accessRequestHash, type AccessDuration, type AccessHints } from '@snugprotocol/protocol';
import type { AccessDecline, UserDb } from '@snugprotocol/db';

import { collectSources, openReview, parkAccessRequest, pendingAccessStore, type ConsentOutcome, type PendingAccessRequest } from './consent.js';
import { ACCESS_SHEET } from './copy.js';
import { accessDeps, bumpAccessRevision, readerGeneration, type AnyAccessGrant } from './grants.js';
import { answerAccess } from './outcome.js';

/** What the sheet starts on when an ask carries a seed: a duration and the away box. */
export interface SheetSeed {
  duration: AccessDuration;
  unattended: boolean;
}

const seeds = new WeakMap<PendingAccessRequest, SheetSeed>();

/** The seed of a parked ask (`undefined` for an ask without one — the sheet's own defaults then). */
export function sheetSeedOf(pending: PendingAccessRequest): SheetSeed | undefined {
  return seeds.get(pending);
}

/** Give a parked ask its seed. A session access is never usable while away (D30), so its seed never ticks the box. */
export function seedSheet(pending: PendingAccessRequest, seed: SheetSeed): void {
  seeds.set(pending, { duration: seed.duration, unattended: seed.duration !== 'session' && seed.unattended });
}


/** The chat's ask, as the card hands it over: the AI's purpose and hints, and who hears the outcome. */
export interface ChatAsk {
  purpose: string;
  hints?: AccessHints;
  settle?: (outcome: ConsentOutcome) => void;
}

export interface UserAskOptions {
  /** *allow again*: the access to renew, with its duration (the engine's row carries both). */
  renew?: { grant: AnyAccessGrant; duration: AccessDuration };
  /** *allow…*: the declined ask to reconsider. */
  decline?: AccessDecline;
  /** *review* on the chat's card (PR-2): the ask the chat's AI made. */
  ask?: ChatAsk;
}

/** What `startUserAsk` came to: the sheet is up, another question is up first, or the app is not in the file. */
export type UserAskAnswer = 'opened' | 'answer-other-first' | 'no-app';

/** After the user's answer: a declined ask that was allowed is no longer declined. (A renewal under a new id is replaced by the consent writer itself.) */
function settleFor(db: UserDb, readerAppId: string, decline: AccessDecline): (outcome: ConsentOutcome) => void {
  return (outcome) => {
    if (outcome.kind !== 'allowed') return;
    try {
      db.clearAccessDecline(readerAppId, decline.hash);
      bumpAccessRevision();
    } catch {
      // the app went away under the answer: its decline rows went with it
    }
  };
}

/**
 * THE user's ask for `readerAppId`: parked as the user's (`provenance: 'user'`), then reviewed.
 * With no options it is the creation act; an ask already waiting for this app is opened instead
 * of replaced — except the chat's ask (`ask`), which ALWAYS parks anew.
 */
export async function startUserAsk(readerAppId: string, opts: UserAskOptions = {}): Promise<UserAskAnswer> {
  if (opts.ask !== undefined) return startChatAsk(readerAppId, opts.ask);
  if (pendingAccessStore.get()[readerAppId] !== undefined) {
    return openReview(readerAppId) ? 'opened' : 'answer-other-first';
  }
  const db = await accessDeps().getDb();
  const reader = db.getApp(readerAppId);
  if (reader === undefined) return 'no-app';
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
      ...(decline !== undefined ? { settle: settleFor(db, readerAppId, decline) } : {}),
    });
    if (renew !== undefined) seedSheet(pending, { duration: renew.duration, unattended: renew.grant.unattended });
  }
  return openReview(readerAppId) ? 'opened' : 'answer-other-first';
}

/**
 * The chat's ask (D-PR2-11): parked ANEW every time — with the AI's purpose, the semantic hash
 * of its hints (so *don't allow* records the decline the tool's rung then honours), the
 * candidates ranked by those hints, `askedIn: 'chat'` — seeded to a day while the reader is
 * closed (D-PR2-3), then reviewed. Under the yield rule the pending is dismissed at once.
 */
async function startChatAsk(readerAppId: string, ask: ChatAsk): Promise<UserAskAnswer> {
  const db = await accessDeps().getDb();
  const reader = db.getApp(readerAppId);
  if (reader === undefined) return 'no-app';
  const hints: AccessHints = ask.hints ?? {};
  const candidates = await collectSources(db, readerAppId, hints);
  const generation = readerGeneration(readerAppId);
  const pending = parkAccessRequest({
    db,
    reader,
    generation: generation ?? -1,
    purpose: ask.purpose,
    provenance: 'user',
    askedIn: 'chat',
    candidates,
    hints,
    hash: accessRequestHash({ hints }),
    ...(ask.settle !== undefined ? { settle: ask.settle } : {}),
  });
  if (generation === undefined) seedSheet(pending, { duration: 'day', unattended: false });
  if (openReview(readerAppId)) return 'opened';
  void answerAccess(pending, { kind: 'dismissed' });
  return 'answer-other-first';
}
