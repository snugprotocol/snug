// access/consent.ts — the pending ask and the user's answer to it (TASK-20261010-cross-app-access
// AC11, AC18; ADR-0075 §4, §5; D11, D12, D19).
//
// THE FLOW. A reader's `request` (or the user's own *let Budget read another app…*) becomes ONE
// pending ask per reader — the `suggestionStore` shape: app id → the pending — which the strip
// renders above the reader's frame (ADR-0074 §4: a strip, never a modal). The strip's *review*, a
// user act on host chrome, calls `openReview`; the consent sheet renders `reviewStore`'s reader
// and ends with ONE `resolve(decision)`. Nothing here writes a grant on its own: only `allow` —
// the user's act — reaches the writer (`createGrantFromDecision`).
//
// WHAT THE SHEET IS GIVEN, AND WHERE IT COMES FROM. The reader's NAME and tile from its LIBRARY
// row, and a provenance line the host derives from `installSource` (D11 — the announce never
// names anyone; a name collision is said); the purpose, quoted, never trusted; the user's apps
// ranked for the purpose (`collectSources` → `rankSources`: tables with their columns, sensitive
// ones flagged, row counts; the reader itself, apps with nothing to read, apps over the copy cap
// and apps holding a WhatsApp fact collapsed into the footer); the egress disclosure, DERIVED at
// the call.
//
// THE THREE NEGATIVE ACTS ARE DISTINCT (D12): *not now* records nothing; *don't allow* records
// the ask's semantic hash; *stop asking* mutes the reader. A pending that is DISMISSED — the
// reader's view closed, a newer frame generation, a session reset, a newer ask replacing it —
// records nothing either.
//
// AN ASK THE CHAT'S AI MADE (TASK-20261010-host-broker PR-2; D-PR2-11; ADR-0076 §2) is parked by
// `userAsk.ts` as the USER's ask (`provenance: 'user'` — the log admits no third provenance until
// PR-3) carrying the AI's purpose, the ask's semantic hash (so *don't allow* records it) and
// `askedIn: 'chat'`, which is what the sheet reads to say where the words came from. The pending
// shape is otherwise unchanged; nothing persisted gains a key (D-PR2-16).
//
// THE YIELD RULE. The sheet never opens over a network or open-url confirm (`mayOpenReview`):
// those are the app's own pending asks to the user too, and two host sheets stacked is a sheet
// the user did not mean to answer.
//
// THE LADDER. The access ask's rate limit, mutes, declines and one-pending rule are the shared
// rungs of `state/appAsk.ts`, keyed on the HOST-assigned id; the window is per APP (`rateBy:
// 'app'`), so neither a re-announce nor a remount mints a fresh slot.

import { ACCESS_REQUEST_MIN_GAP_MS, ACCESS_SOURCE_MAX_BYTES, accessRequestHash, type AccessDuration, type AccessHints, type AccessRequestSemantics } from '@snugprotocol/protocol';
import type { AppRecord, UserDb } from '@snugprotocol/db';

import { createAppAsk, type AppAsk } from '../state/appAsk.js';
import { readFlag } from '../state/browserFlags.js';
import { netConfirmStore } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { createStore, type Store } from '../state/store.js';
import { egressFor, type EgressLine } from './egress.js';
import { accessDeps, armAccessListeners, bumpAccessRevision, createGrantFromDecision, readerGeneration, revokeAccess, type AnyAccessGrant } from './grants.js';
import { nameCollides, provenanceLine } from './provenance.js';
import { preselectedTables, rankSources, type RankedSource, type RankedSources, type SourceInput } from './relevance.js';

// ------------------------------------------------------------------------------------- types

/** The user's act on the sheet (or the strip). */
export type ConsentDecision =
  | { kind: 'allow'; sourceAppId: string; tables: string[]; duration: AccessDuration; unattended: boolean }
  | { kind: 'not-now' }
  | { kind: 'dont-allow' }
  | { kind: 'stop-asking' }
  | { kind: 'dismissed' };

/** What the act came to — the strip's outcome line reads it (`allowed` carries the id its *stop* undoes). */
export type ConsentOutcome =
  | { kind: 'allowed'; grantId: string; sourceAppId: string; sourceName: string; tables: string[]; duration: AccessDuration }
  | { kind: 'not-now' }
  | { kind: 'declined' }
  | { kind: 'muted' }
  | { kind: 'dismissed' }
  | { kind: 'failed'; message: string };

export interface PendingAccessRequest {
  readerAppId: string;
  /** The reader's LIBRARY name — never the announce. */
  readerName: string;
  readerIcon?: { emoji?: string; color?: string };
  /** *built here · v12* / *installed from a share link on 3 Oct · not built by you* / … (+ the collision note). */
  readerProvenance: string;
  /** The reader's frame generation the ask came from (`-1`: asked from host chrome with the app closed). */
  generation: number;
  /** Shown quoted under "Budget says:", never trusted. */
  purpose: string;
  provenance: 'app' | 'user';
  /** The user's ask, made by the chat's AI from its card (PR-2): the sheet quotes the purpose as the AI's and offers *don't allow*. */
  askedIn?: 'chat';
  /** A grant this ask renews (one of THIS reader's). */
  renew?: string;
  candidates: RankedSources;
  preselect?: { appId: string; tables: string[] };
  egressFor: (opts: { unattended: boolean; sourceName: string }) => EgressLine[];
  /** The ONE answer. Later calls answer `dismissed` and change nothing. */
  resolve(decision: ConsentDecision): Promise<ConsentOutcome>;
}

// ------------------------------------------------------------------------------------ stores

/**
 * The per-browser *never let apps ask to read other apps' data* switch (Q15 — like the schedule's:
 * the ONE `'1'`/absent convention of the leaf `state/browserFlags.ts`, which the Settings card
 * writes it with and this reads it with).
 */
export const NO_ACCESS_ASKS_KEY = 'snug:access-no-asks';

export function accessAsksOff(): boolean {
  return readFlag(NO_ACCESS_ASKS_KEY);
}

/** The shared intake ladder, keyed on the host-assigned id; one window per APP. */
export const accessAskLadder: AppAsk<AccessRequestSemantics, PendingAccessRequest> = createAppAsk<AccessRequestSemantics, PendingAccessRequest>({
  minGapMs: ACCESS_REQUEST_MIN_GAP_MS,
  hash: accessRequestHash,
  isMuted: (db, appId) => db.isAccessMuted(appId),
  isDeclined: (db, appId, hash) => db.listAccessDeclines(appId).some((decline) => decline.hash === hash),
  globalMute: accessAsksOff,
  rateBy: 'app',
});

/** Reader app id → its one pending ask (the strip subscribes by id). */
export const pendingAccessStore: Store<Readonly<Record<string, PendingAccessRequest>>> = accessAskLadder.store;

/** The reader whose consent sheet is OPEN — set by `openReview`, cleared by `resolve` and `dismissReview`. */
export const reviewStore: Store<string | undefined> = createStore<string | undefined>(undefined);

/** The yield rule: no sheet while a network or open-url confirm is waiting for the user. */
function mayOpenReview(): boolean {
  return netConfirmStore.get() === null && openUrlConfirmStore.get() === null;
}

/** *review* on the strip. Answers whether the sheet opened (nothing pending, or a confirm open → no). */
export function openReview(readerAppId: string): boolean {
  if (pendingAccessStore.get()[readerAppId] === undefined || !mayOpenReview()) return false;
  reviewStore.set(readerAppId);
  return true;
}

/** Close the sheet without answering — the strip still holds the ask. */
export function dismissReview(): void {
  reviewStore.set(undefined);
}

// ----------------------------------------------------------------------------------- sources

const describedApp = (app: AppRecord) => ({
  appId: app.appId,
  displayName: app.displayName,
  ...(app.description !== undefined ? { description: app.description } : {}),
  ...(app.iconEmoji !== undefined ? { iconEmoji: app.iconEmoji } : {}),
  ...(app.iconColor !== undefined ? { iconColor: app.iconColor } : {}),
});

/**
 * Every app in the file as a candidate for `readerAppId`, ranked for the hints: described
 * (`describeAppData` — tables, columns with `sensitive`, row counts), or marked unusable — a
 * WhatsApp fact (`appHasSidecarFact`) → `sidecar`, a runtime over `ACCESS_SOURCE_MAX_BYTES` →
 * `too-large`; the reader itself lands in `excluded` as `reader`. An app the file cannot
 * describe right now (deleted under us) is left out.
 */
export async function collectSources(db: UserDb, readerAppId: string, hints?: AccessHints): Promise<RankedSources> {
  const inputs: SourceInput[] = [];
  for (const app of db.listApps()) {
    if (app.appId === readerAppId) {
      inputs.push({ ...describedApp(app), tables: [] });
      continue;
    }
    if (appHasSidecarFact(db, app.appId)) {
      inputs.push({ appId: app.appId, displayName: app.displayName, excluded: 'sidecar' });
      continue;
    }
    try {
      const described = await db.describeAppData(app.appId);
      if (described.tables.length > 0 && (await db.exportAppRuntime(app.appId)).byteLength > ACCESS_SOURCE_MAX_BYTES) {
        inputs.push({ appId: app.appId, displayName: app.displayName, excluded: 'too-large' });
        continue;
      }
      inputs.push({ ...describedApp(app), tables: described.tables });
    } catch {
      // gone, or unreadable this moment: never offered
    }
  }
  return rankSources({ readerAppId, apps: inputs, ...(hints !== undefined ? { hints } : {}) });
}

// ---------------------------------------------------------------------------------- the pending

export interface ParkAccessRequestInput {
  db: UserDb;
  reader: AppRecord;
  generation: number;
  purpose: string;
  provenance: 'app' | 'user';
  /** The chat's AI asked, from its card (PR-2). */
  askedIn?: 'chat';
  candidates: RankedSources;
  hints?: AccessHints;
  renew?: { grantId: string; sourceAppId: string; tables: string[] };
  /** The ask's semantic hash — what *don't allow* records (app asks, and the chat's asks). */
  hash?: string;
  /** Hears the outcome once, with the grant when one was written. */
  settle?: (outcome: ConsentOutcome, grant?: AnyAccessGrant) => void;
}

const offered = (candidates: RankedSources, appId: string): RankedSource | undefined =>
  [...candidates.matched, ...candidates.rest].find((candidate) => candidate.appId === appId);

function preselectionFor(candidates: RankedSources, renew: ParkAccessRequestInput['renew']): PendingAccessRequest['preselect'] {
  if (renew !== undefined && offered(candidates, renew.sourceAppId) !== undefined) return { appId: renew.sourceAppId, tables: renew.tables };
  const first = candidates.matched[0] ?? (candidates.matched.length === 0 && candidates.rest.length === 1 ? candidates.rest[0] : undefined);
  return first === undefined ? undefined : { appId: first.appId, tables: preselectedTables(first) };
}

/** Clear `pending` from the store (only if it is still the one there) and close its sheet. */
function unpark(pending: PendingAccessRequest): void {
  if (accessAskLadder.pendingFor(pending.readerAppId) === pending) accessAskLadder.setPending(pending.readerAppId, undefined);
  if (reviewStore.get() === pending.readerAppId) reviewStore.set(undefined);
}

async function carryOut(input: ParkAccessRequestInput, pending: PendingAccessRequest, decision: ConsentDecision): Promise<{ outcome: ConsentOutcome; grant?: AnyAccessGrant }> {
  const db = await accessDeps().getDb();
  const at = new Date(accessDeps().now()).toISOString();
  switch (decision.kind) {
    case 'allow': {
      const source = offered(pending.candidates, decision.sourceAppId);
      if (source === undefined) return { outcome: { kind: 'failed', message: 'that app was not offered' } };
      const generation = input.provenance === 'app' ? pending.generation : readerGeneration(pending.readerAppId);
      const grant = await createGrantFromDecision(db, {
        readerAppId: pending.readerAppId,
        source,
        tables: decision.tables,
        duration: decision.duration,
        unattended: decision.unattended,
        purpose: pending.purpose,
        provenance: input.provenance,
        ...(generation !== undefined ? { generation } : {}),
        now: accessDeps().now(),
        ...(input.renew !== undefined ? { renew: input.renew.grantId } : {}),
      });
      // D36 on EVERY path (the app's ask and the user's alike): an allow that wrote a NEW access for
      // the renewed pair — the default *while it's open*, or another duration — REPLACES the old one,
      // so a paused row never lingers with *allow again* beside its successor (W6 finding 9).
      if (input.renew !== undefined && grant.id !== input.renew.grantId && grant.sourceAppId === input.renew.sourceAppId) {
        await revokeAccess(input.renew.grantId);
      }
      return {
        outcome: { kind: 'allowed', grantId: grant.id, sourceAppId: source.appId, sourceName: source.displayName, tables: grant.scope.tables.map((table) => table.name), duration: decision.duration },
        grant,
      };
    }
    case 'not-now':
      return { outcome: { kind: 'not-now' } };
    case 'dont-allow':
      if (input.hash !== undefined) {
        db.addAccessDecline(pending.readerAppId, input.hash, { purpose: pending.purpose, hints: input.hints ?? {}, at });
        bumpAccessRevision();
      }
      return { outcome: { kind: 'declined' } };
    case 'stop-asking':
      db.setAccessMuted(pending.readerAppId, true);
      bumpAccessRevision();
      return { outcome: { kind: 'muted' } };
    case 'dismissed':
      return { outcome: { kind: 'dismissed' } };
  }
}

/**
 * Park ONE pending ask for the reader — replacing (and DISMISSING) any older one — with the
 * sheet's inputs read from the library row and the file. The caller has run the ladder.
 */
export function parkAccessRequest(input: ParkAccessRequestInput): PendingAccessRequest {
  // The reader's view closing dismisses an app ask (grants.ts's one retract listener) — armed here, on use.
  armAccessListeners();
  const { db, reader } = input;
  let settled = false;
  const icon = {
    ...(reader.iconEmoji !== undefined ? { emoji: reader.iconEmoji } : {}),
    ...(reader.iconColor !== undefined ? { color: reader.iconColor } : {}),
  };
  const preselect = preselectionFor(input.candidates, input.renew);
  const pending: PendingAccessRequest = {
    readerAppId: reader.appId,
    readerName: reader.displayName,
    ...(Object.keys(icon).length > 0 ? { readerIcon: icon } : {}),
    readerProvenance: provenanceLine(reader, { collides: nameCollides(db.listApps(), reader.appId), now: accessDeps().now() }),
    generation: input.generation,
    purpose: input.purpose,
    provenance: input.provenance,
    ...(input.askedIn !== undefined ? { askedIn: input.askedIn } : {}),
    ...(input.renew !== undefined ? { renew: input.renew.grantId } : {}),
    candidates: input.candidates,
    ...(preselect !== undefined ? { preselect } : {}),
    egressFor: (opts) => egressFor(db, reader.appId, opts),
    async resolve(decision) {
      if (settled) return { kind: 'dismissed' };
      settled = true;
      unpark(pending);
      let result: { outcome: ConsentOutcome; grant?: AnyAccessGrant };
      try {
        result = await carryOut(input, pending, decision);
      } catch (err) {
        result = { outcome: { kind: 'failed', message: err instanceof Error ? err.message : String(err) } };
      }
      input.settle?.(result.outcome, result.grant);
      return result.outcome;
    },
  };
  const older = accessAskLadder.pendingFor(reader.appId);
  if (older !== undefined) void older.resolve({ kind: 'dismissed' });
  accessAskLadder.setPending(reader.appId, pending);
  return pending;
}

/** Dismiss the reader's pending ask — nothing recorded. `onlyApp`: leave an ask the USER started alone. */
export function dismissPendingAccess(readerAppId: string, opts: { onlyApp?: boolean } = {}): void {
  const pending = accessAskLadder.pendingFor(readerAppId);
  if (pending === undefined || (opts.onlyApp === true && pending.provenance !== 'app')) return;
  void pending.resolve({ kind: 'dismissed' });
}

/** A newer frame generation of the reader: an app ask from any other generation died with its frame. */
export function dismissStaleAccessAsk(readerAppId: string, generation: number): void {
  const pending = accessAskLadder.pendingFor(readerAppId);
  if (pending !== undefined && pending.provenance === 'app' && pending.generation !== generation) void pending.resolve({ kind: 'dismissed' });
}

/**
 * The session seam's share (`resetAccessSession` calls it): every pending ask — or one app's —
 * dismissed with nothing recorded, the ladder's memory with it, the sheet closed.
 */
export function resetConsentSession(appId?: string): void {
  const readers = appId === undefined ? Object.keys(pendingAccessStore.get()) : [appId];
  for (const reader of readers) dismissPendingAccess(reader);
  accessAskLadder.clear(appId);
  if (appId === undefined || reviewStore.get() === appId) reviewStore.set(undefined);
}
