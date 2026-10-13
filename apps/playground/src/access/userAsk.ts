// access/userAsk.ts — the user's own ask from host chrome, in its forms, with ONE recipe
// in the UI (TASK-20261010-cross-app-access AC19, AC21; D12, D34, D36; TASK-20261010-host-broker
// PR-2 AC12, D-PR2-3, D-PR2-11). A leaf: no React.
//
//   - the creation act (*let Budget read another app…*) — no options;
//   - *allow again* on a paused or ended row — a prefilled ask that RENEWS that access;
//   - *allow…* on a declined ask — the ask the user turned down, ranked by its own hints;
//   - *review* on the chat's ask card (PR-2) — the ask the chat's AI made, in its words;
//   - and PR-5's three — declared, pair and offer — below.
//
// Every form is the user's act (`provenance: 'user'` — the host's fixed purpose for the first
// three, D34: the host's words, never the act's label, which would read as a sentence the app
// said; the AI's purpose for the fourth, which the sheet quotes as "asked in Budget's chat:"),
// parks ONE pending (or opens the one already waiting) and opens the review. Not an app ask: no
// ladder here — the chat's ask ran the ladder's rungs in its tool before the card was staged.
// This is the ONE recipe (W6 finding 14): every surface — Settings, either ⋈ sheet, *allow
// again*, *allow…*, the card, the Hub tile — comes through `startUserAsk`, which answers what
// happened: `'opened'`, `'answer-other-first'` (the yield rule: a network or link confirm is up)
// or `'no-app'` (the app is not in the file) — and, for the PR-5 forms, why the sheet could not
// offer the source.
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
//
// A RENEWAL SEEDS THE WHOLE SCOPE (TASK-20261010-host-broker PR-3; D-PR3-23; contract v2.1
// U-Q12). *allow again* on a write + fetch-first access must put it back as it was in ONE TAP, so
// its seed carries the old access's tables — each with its allowed columns, its withheld ones and
// its write toggle — and its `kv` / `refresh` beside the duration and the away box; the sheet
// starts with those ticked and its *more options…* open. The preselection stays the table
// NAMES (consent.ts's `renew`); the scope travels here, through `renewalSeedOf` — the ONE rule
// (Gate-5 ENG-1): the app's own renewal ask (`accessHandler.ts`) seeds the same scope over the
// sheet's session/away defaults, so an app that asks again for the access it had is not shown a
// narrower one than the person allowed.
//
// TASK-20261010-host-broker PR-5 (contract v2 D-PR5-3, D-PR5-4, D-PR5-5, D-PR5-15; v2.1 TB-Q9…Q16)
// adds three forms and two fixes. DECLARED (`declared`, with `source` for a pair): what the app
// says it would like to read, re-read from the file before anything parks — the sheet quotes the
// app's purpose, the access persists the host's words. OFFER (`source` + `offer`): a source's
// offer from its own ⋈ sheet, pinned to it, read-only. The fixes: an ask carrying any of the three
// dismisses an older pending for that reader and parks anew (the person's act wins), and under the
// yield rule it parks nothing at all. The chat's ask now carries `access`: an ask to change rows
// wants write and hashes as the tool does.
//
// EVERYTHING THAT CAN SAY NO SAYS IT BEFORE ANYTHING PARKS (D-PR5-6a): the reader is gone →
// `'no-app'`; the want is no longer declared word for word → `gone` (S16a — a pair listed a moment
// ago is re-read, never trusted); the pinned source is not in the file → `gone`, or one the sheet
// would not offer → that reason (and the pair is not suggested again this session — pairs.ts);
// another question is up → `answer-other-first`. Only then does `beforeOpen` run (the ⋈ sheet
// closes there, so a refusal leaves it up with its act line), the ask park and the review open.
// `settle` hears the person's answer, for the act line that started it.
//
// Gate-5 fold (G5-15). A pinned ask describes ONLY its source (`collectSource`, IB-5 — exporting
// every app to offer one froze the tap); a declared ask's preselection is consent.ts's one rule (the
// TABLE tier of the pinned or best-ranked source, IB-6/SA-5); and an offer is an offer on every
// branch (SA-8): `{declared, source, offer}` parks with `offeredBy: 'source'` too, so the sheet draws
// no write toggle and the consent writer refuses one.

import { accessRequestHash, canonicalJson, type AccessDuration, type AccessHints, type AccessScope, type AccessWants } from '@snugprotocol/protocol';
import type { AccessDecline, AppRecord, UserDb } from '@snugprotocol/db';

import {
  collectSource,
  collectSources,
  mayOpenReview,
  openReview,
  parkAccessRequest,
  pendingAccessStore,
  type ConsentOutcome,
  type ParkAccessRequestInput,
  type PendingAccessRequest,
} from './consent.js';
import { ACCESS_SHEET } from './copy.js';
import { accessDeps, bumpAccessRevision, readerGeneration, type AnyAccessGrant } from './grants.js';
import { answerAccess } from './outcome.js';
import { rememberNotOffered } from './pairs.js';
import { hasHints, type ExcludedReason, type RankedSource, type RankedSources } from './relevance.js';

/**
 * What the sheet starts on when an ask carries a seed: a duration and the away box — and, for a
 * renewal, the old access's scope (PR-3): its tables as the record holds them (allowed `columns`,
 * `withheld`, `write`), and `kv` / `refresh` when it carried them.
 */
export interface SheetSeed {
  duration: AccessDuration;
  unattended: boolean;
  tables?: AccessScope['tables'];
  kv?: boolean;
  refresh?: boolean;
}

const seeds = new WeakMap<PendingAccessRequest, SheetSeed>();

/** The seed of a parked ask (`undefined` for an ask without one — the sheet's own defaults then). */
export function sheetSeedOf(pending: PendingAccessRequest): SheetSeed | undefined {
  return seeds.get(pending);
}

/**
 * The seed a renewal of `grant` starts the sheet on (ENG-1 — one rule for the user's *allow
 * again* and the app's own renewal ask): the duration and away box the caller chose, and the old
 * scope with its defaults omitted, as on the record — a plain read access (nothing withheld,
 * nothing writable) seeds no tables, because the sheet's own defaults over the preselected names
 * reproduce that scope exactly; a widened one travels whole; `kv` / `refresh` only when true.
 */
export function renewalSeedOf(grant: AnyAccessGrant, duration: AccessDuration, unattended: boolean): SheetSeed {
  const widened = grant.scope.tables.some((table) => table.write === true || (table.withheld !== undefined && table.withheld.length > 0));
  return {
    duration,
    unattended,
    ...(widened ? { tables: grant.scope.tables } : {}),
    ...(grant.kv === true ? { kv: true } : {}),
    ...(grant.refresh === true ? { refresh: true } : {}),
  };
}

/** Give a parked ask its seed. A session access is never usable while away (D30), so its seed never ticks the box; the scope seats are kept only when given (`kv` / `refresh` only when true). */
export function seedSheet(pending: PendingAccessRequest, seed: SheetSeed): void {
  seeds.set(pending, {
    duration: seed.duration,
    unattended: seed.duration !== 'session' && seed.unattended,
    ...(seed.tables !== undefined ? { tables: seed.tables } : {}),
    ...(seed.kv === true ? { kv: true } : {}),
    ...(seed.refresh === true ? { refresh: true } : {}),
  });
}


/** The chat's ask, as the card hands it over: the AI's purpose and hints, and who hears the outcome. */
export interface ChatAsk {
  purpose: string;
  hints?: AccessHints;
  /** PR-5 (D-PR5-15): `write` when the chat wants to change rows — the pending wants write, and the hash is the tool's. */
  access?: 'read' | 'write';
  settle?: (outcome: ConsentOutcome) => void;
}

/** One thing an app says it would like to read — an entry of its access-wants meta. */
export type AccessWant = AccessWants[number];

export interface UserAskOptions {
  /** *allow again*: the access to renew, with its duration (the engine's row carries both). */
  renew?: { grant: AnyAccessGrant; duration: AccessDuration };
  /** *allow…*: the declined ask to reconsider. */
  decline?: AccessDecline;
  /** *review* on the chat's card (PR-2): the ask the chat's AI made. */
  ask?: ChatAsk;
  /** PR-5 (D-PR5-3): what the app says it would like to read — re-read before anything parks (S16a). */
  declared?: AccessWant;
  /** PR-5 (D-PR5-4, D-PR5-5): the source the sheet is PINNED to — a pair's, or the source that offers itself. */
  source?: string;
  /** PR-5 (D-PR5-5): the source's offer from its own ⋈ sheet — read-only, the reader's ask still. */
  offer?: true;
  /** PR-5 forms only: runs once every check has passed, just before the ask parks and the review opens — where a ⋈ sheet closes itself. */
  beforeOpen?: () => void;
  /** PR-5 forms only: hears the person's answer once (the act line, D-PR5-6a). */
  settle?: (outcome: ConsentOutcome) => void;
}

/**
 * What `startUserAsk` came to: the sheet is up, another question is up first, or the app is not
 * in the file. PR-5 (D-PR5-5, D-PR5-6a; TB-Q12): a source the sheet could not offer — or a want
 * the app no longer declares (`gone`) — answers before anything parks; a call carrying any of
 * `declared` / `source` / `offer` answers the yield rule as `{kind: 'answer-other-first'}` having
 * parked nothing. The bare forms keep their strings.
 */
export type UserAskAnswer =
  | 'opened'
  | 'answer-other-first'
  | 'no-app'
  | { kind: 'not-offered'; reason: ExcludedReason | 'gone' }
  | { kind: 'answer-other-first' };

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
 * of replaced — except the chat's ask (`ask`) and the PR-5 forms (`declared` / `source` /
 * `offer`), which ALWAYS park anew.
 */
export async function startUserAsk(readerAppId: string, opts: UserAskOptions = {}): Promise<UserAskAnswer> {
  if (opts.ask !== undefined) return startChatAsk(readerAppId, opts.ask);
  if (opts.declared !== undefined || opts.source !== undefined || opts.offer !== undefined) return startPinnedAsk(readerAppId, opts);
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
    if (renew !== undefined) seedSheet(pending, renewalSeedOf(renew.grant, renew.duration, renew.grant.unattended));
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
  // D-PR5-15: an ask to change rows wants write, and *don't allow* records the hash the tool's rung honours.
  const wantsWrite = ask.access === 'write';
  const pending = parkAccessRequest({
    db,
    reader,
    generation: generation ?? -1,
    purpose: ask.purpose,
    provenance: 'user',
    askedIn: 'chat',
    ...(wantsWrite ? { wantsWrite: true } : {}),
    candidates,
    hints,
    hash: accessRequestHash({ hints, ...(wantsWrite ? { access: 'write' as const } : {}) }),
    ...(ask.settle !== undefined ? { settle: ask.settle } : {}),
  });
  if (generation === undefined) seedSheet(pending, { duration: 'day', unattended: false });
  if (openReview(readerAppId)) return 'opened';
  void answerAccess(pending, { kind: 'dismissed' });
  return 'answer-other-first';
}

// ------------------------------------------------------------------------------ the PR-5 forms

/** Whether the reader STILL declares `want`, word for word (S16a) — a forged purpose or a widened hint is not it. */
function stillDeclared(db: UserDb, readerAppId: string, want: AccessWant): boolean {
  let wants: AccessWants | undefined;
  try {
    wants = db.getAccessWants(readerAppId);
  } catch {
    return false;
  }
  const asked = canonicalJson(want);
  return (wants ?? []).some((declared) => canonicalJson(declared) === asked);
}

/**
 * The candidates cut to ONE source — the sheet is pinned to it (TB-Q10) — or why the sheet could not
 * offer it: not in the file (`gone`), or the reason `collectSource` put it in the footer. The
 * footer is dropped: no other app was ever on offer.
 */
function pinTo(db: UserDb, ranked: RankedSources, sourceAppId: string): { candidates: RankedSources; source: RankedSource } | { reason: ExcludedReason | 'gone' } {
  if (db.getApp(sourceAppId) === undefined) return { reason: 'gone' };
  const excluded = ranked.excluded.find((app) => app.appId === sourceAppId);
  if (excluded !== undefined) return { reason: excluded.reason };
  const matched = ranked.matched.find((app) => app.appId === sourceAppId);
  const source = matched ?? ranked.rest.find((app) => app.appId === sourceAppId);
  // Described a moment ago and not now (deleted under us, unreadable): nothing to offer.
  if (source === undefined) return { reason: 'gone' };
  return { candidates: { matched: matched !== undefined ? [source] : [], rest: matched !== undefined ? [] : [source], excluded: [] }, source };
}

/**
 * The declared, pair and offer forms (D-PR5-3/4/5): every refusal answered before anything parks;
 * then ONE user ask, parked anew — an older pending for the reader is dismissed by the park (T1)
 * — and reviewed.
 */
async function startPinnedAsk(readerAppId: string, opts: UserAskOptions): Promise<UserAskAnswer> {
  const db = await accessDeps().getDb();
  const reader = db.getApp(readerAppId);
  if (reader === undefined) return 'no-app';
  const want = opts.declared;
  if (want !== undefined && !stillDeclared(db, readerAppId, want)) return { kind: 'not-offered', reason: 'gone' };
  const hints = want?.hints;
  // IB-5: pinned, only the source is described — the other apps were never on offer.
  let candidates = opts.source !== undefined ? await collectSource(db, readerAppId, opts.source, hints) : await collectSources(db, readerAppId, hints);
  let pinned: RankedSource | undefined;
  if (opts.source !== undefined) {
    const pin = pinTo(db, candidates, opts.source);
    if ('reason' in pin) {
      if (want !== undefined) rememberNotOffered(readerAppId, opts.source);
      return { kind: 'not-offered', reason: pin.reason };
    }
    candidates = pin.candidates;
    pinned = pin.source;
  }
  // T2: nothing parks under the yield rule — the act that asked says so, and the person asks again.
  if (!mayOpenReview()) return { kind: 'answer-other-first' };
  opts.beforeOpen?.();
  const pending = parkAccessRequest(pinnedParkInput(db, reader, opts, candidates, pinned));
  if (openReview(readerAppId)) return 'opened';
  void answerAccess(pending, { kind: 'dismissed' });
  return { kind: 'answer-other-first' };
}

/**
 * The park for a PR-5 form: always the person's ask, in the host's words unless the app's are
 * quoted (declared), and an offer on every branch that carries one (SA-8). A declared ask starts
 * where consent.ts's one rule puts it — the TABLE tier of the pinned (or best-ranked) source, none
 * matched → the source chosen, nothing ticked (S10).
 */
function pinnedParkInput(
  db: UserDb,
  reader: AppRecord,
  opts: UserAskOptions,
  candidates: RankedSources,
  pinned: RankedSource | undefined,
): ParkAccessRequestInput {
  const want = opts.declared;
  const base = {
    db,
    reader,
    generation: readerGeneration(reader.appId) ?? -1,
    provenance: 'user' as const,
    candidates,
    ...(opts.offer === true ? { offeredBy: 'source' as const } : {}),
    ...(opts.settle !== undefined ? { settle: opts.settle } : {}),
  };
  if (want !== undefined) {
    return {
      ...base,
      askedIn: 'declared',
      // The sheet quotes the app's purpose; the access persists the host's words (S16c).
      purpose: want.purpose,
      grantPurpose: ACCESS_SHEET.declaredPurpose(reader.displayName),
      ...(want.hints !== undefined ? { hints: want.hints } : {}),
      // *don't allow* records the want's own hash — the app's identical runtime ask then answers declined.
      ...(hasHints(want.hints) ? { hash: accessRequestHash({ hints: want.hints ?? {} }) } : {}),
    };
  }
  return {
    ...base,
    purpose: ACCESS_SHEET.userPurpose(reader.displayName),
    // Nothing named, nothing ticked: the person picks the tables of the source they came from.
    ...(pinned !== undefined ? { preselect: { appId: pinned.appId, tables: [] } } : {}),
  };
}
