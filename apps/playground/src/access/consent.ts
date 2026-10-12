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
//
// THE DECISION v2 (TASK-20261010-host-broker PR-3; ADR-0076 §4; D-PR3-4/23; contract v2.1 E1-Q7,
// U-Q8, U-Q11). The sheet's *allow* now says, per table, the unticked columns and the write
// toggle, and for the source its settings & notes and fetch-first options; a bare table name is
// the 1.1 choice (every PR-2 fixture stays byte-identical). The outcome names the WRITTEN tables
// (`allowed.write`) so the strip and the card can say "read and change". An app's ask may carry
// `access: 'write'` (the handler threads it as `wantsWrite`): the strip's title and the sheet's
// say so, and the sheet opens its options at once — but the toggle is never pre-ticked by the
// ask. The ladder hashes `access` too (`accessRequestHash`), so a declined read ask does not
// decline a later write ask, nor the reverse. The chat's ask (`askedIn: 'chat'`) now writes
// `provenance: 'chat'` on the GRANT (the log admits it at 1.2; R-86 closes) while the pending
// stays the user's (`provenance: 'user'` drives the strip and the dismiss rules as before).
//
// PR-5 (TASK-20261010-host-broker; contract v2 D-PR5-3/5/9/15; v2.1 TB-Q10…Q16) — two new user
// asks, both parked by `userAsk.ts`. DECLARED (`askedIn: 'declared'`): started from what the app
// says it would like to read — the sheet quotes the app's purpose, while the access it writes
// persists the HOST's words (`grantPurpose`, S16c), and *don't allow* is offered only when the
// want had hints to record a no against (`declinable`). OFFERED (`offeredBy: 'source'`, memory
// only): a source offered itself from its own ⋈ sheet — the consent writer refuses ANY write on it,
// fail closed, whatever the decision claims. Both arrive pinned (`preselect` given, the candidates
// cut to the one source). The reader's provenance line reads the imported marker (D-PR5-9), and an
// allow that wanted write but changes nothing says so (`notChange`, D-PR5-15).
//
// Gate-5 fold (G5-15). A DECLARED ask is table-tier only wherever it is parked (IB-6): the pending
// carries `tableTierOnly` with the want's hints, so the sheet ticks only the TABLE tier of any
// source the person picks, and the park never falls back to the every-table rule for it. A PINNED
// ask describes only its source (`collectSource`, IB-5): the other apps were never on offer, and
// exporting each of them on the main thread to offer one froze the tap for seconds.

import { ACCESS_REQUEST_MIN_GAP_MS, ACCESS_SOURCE_MAX_BYTES, accessRequestHash, type AccessDuration, type AccessHints, type AccessRequestSemantics } from '@snugprotocol/protocol';
import type { AppRecord, UserDb } from '@snugprotocol/db';

import { createAppAsk, type AppAsk } from '../state/appAsk.js';
import { readFlag } from '../state/browserFlags.js';
import { netConfirmStore } from '../state/net.js';
import { openUrlConfirmStore } from '../state/openUrl.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { createStore, type Store } from '../state/store.js';
import { egressFor, type EgressLine, type EgressOptions } from './egress.js';
import { accessDeps, armAccessListeners, bumpAccessRevision, createGrantFromDecision, readerGeneration, revokeAccess, type AnyAccessGrant, type TableChoice } from './grants.js';
import { importedMarkerOf, nameCollides, provenanceLine } from './provenance.js';
import { preselectedTables, rankSources, tableTierTables, type RankedSource, type RankedSources, type SourceInput } from './relevance.js';

// ------------------------------------------------------------------------------------- types

/**
 * The user's act on the sheet (or the strip). An allow's `tables` are the per-table choices
 * (D-PR3-23) — or bare names, the 1.1 choice (E1-Q7); `kv` and `refresh` absent ≡ false, the
 * sheet always says both.
 */
export type ConsentDecision =
  | { kind: 'allow'; sourceAppId: string; tables: ReadonlyArray<string | TableChoice>; duration: AccessDuration; unattended: boolean; kv?: boolean; refresh?: boolean }
  | { kind: 'not-now' }
  | { kind: 'dont-allow' }
  | { kind: 'stop-asking' }
  | { kind: 'dismissed' };

/**
 * What the act came to — the strip's outcome line reads it (`allowed` carries the id its *stop*
 * undoes, and `write`, the tables the reader may change — empty for a read access; `notChange`
 * when the ask wanted to change rows and none was ticked, D-PR5-15).
 */
export type ConsentOutcome =
  | { kind: 'allowed'; grantId: string; sourceAppId: string; sourceName: string; tables: string[]; duration: AccessDuration; write: string[]; notChange?: true }
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
  /**
   * The user's ask, made by the chat's AI from its card (PR-2): the sheet quotes the purpose as the AI's and offers *don't allow*.
   * PR-5 (D-PR5-3): `declared` — started from what the app says it would like to read; the sheet quotes the app's purpose.
   */
  askedIn?: 'chat' | 'declared';
  /** PR-5 (D-PR5-5): a source offered itself from its own ⋈ sheet — the sheet is pinned to it and nothing it allows can change rows. Memory only. */
  offeredBy?: 'source';
  /** PR-5 (D-PR5-3): a declared ask whose want had hints — *don't allow* records its hash. Without hints there is nothing to record a no against, so the sheet does not offer it. */
  declinable?: true;
  /** G5-15 (IB-6, S10): a declared ask — whatever source the person picks, the sheet ticks only its TABLE-tier tables for `hints`, never a column match or every table. */
  tableTierOnly?: true;
  /** The want's hints, for `tableTierOnly` (declared asks only). */
  hints?: AccessHints;
  /** A grant this ask renews (one of THIS reader's). */
  renew?: string;
  /** The app's ask carried `access: 'write'` (D-PR3-4): the title says so and the sheet's options open at once — the toggle itself stays off until the person ticks it. */
  wantsWrite?: boolean;
  candidates: RankedSources;
  preselect?: { appId: string; tables: string[] };
  egressFor: (opts: EgressOptions) => EgressLine[];
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
export function mayOpenReview(): boolean {
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
 * One app as a candidate for `readerAppId`: described (`describeAppData` — tables, columns with
 * `sensitive`, row counts), or marked unusable — a WhatsApp fact (`appHasSidecarFact`) → `sidecar`,
 * a runtime over `ACCESS_SOURCE_MAX_BYTES` → `too-large`; the reader itself is listed with no tables
 * (`rankSources` puts it in `excluded` as `reader`). `undefined`: the file cannot describe it right
 * now (deleted under us) — never offered.
 */
async function sourceInput(db: UserDb, readerAppId: string, app: AppRecord): Promise<SourceInput | undefined> {
  if (app.appId === readerAppId) return { ...describedApp(app), tables: [] };
  if (appHasSidecarFact(db, app.appId)) return { appId: app.appId, displayName: app.displayName, excluded: 'sidecar' };
  try {
    const described = await db.describeAppData(app.appId);
    if (described.tables.length > 0 && (await db.exportAppRuntime(app.appId)).byteLength > ACCESS_SOURCE_MAX_BYTES) {
      return { appId: app.appId, displayName: app.displayName, excluded: 'too-large' };
    }
    return { ...describedApp(app), tables: described.tables };
  } catch {
    // gone, or unreadable this moment: never offered
    return undefined;
  }
}

/** Every app in the file as a candidate for `readerAppId` (`sourceInput`'s rules), ranked for the hints. */
export async function collectSources(db: UserDb, readerAppId: string, hints?: AccessHints): Promise<RankedSources> {
  const inputs: SourceInput[] = [];
  for (const app of db.listApps()) {
    const input = await sourceInput(db, readerAppId, app);
    if (input !== undefined) inputs.push(input);
  }
  return rankSources({ readerAppId, apps: inputs, ...(hints !== undefined ? { hints } : {}) });
}

/**
 * The candidates of an ask PINNED to `sourceAppId` (G5-15, IB-5): that one app, by the same rules
 * as `collectSources` — the reader itself still lands in `excluded` as `reader` — and no other app
 * described or exported. Not in the file: nothing.
 */
export async function collectSource(db: UserDb, readerAppId: string, sourceAppId: string, hints?: AccessHints): Promise<RankedSources> {
  const app = db.getApp(sourceAppId);
  const input = app === undefined ? undefined : await sourceInput(db, readerAppId, app);
  return rankSources({ readerAppId, apps: input === undefined ? [] : [input], ...(hints !== undefined ? { hints } : {}) });
}

// ---------------------------------------------------------------------------------- the pending

export interface ParkAccessRequestInput {
  db: UserDb;
  reader: AppRecord;
  generation: number;
  purpose: string;
  provenance: 'app' | 'user';
  /** The chat's AI asked, from its card (PR-2); PR-5: `declared` — the person started it from what the app would like to read. */
  askedIn?: 'chat' | 'declared';
  /** PR-5 (D-PR5-5): the source offered itself — the consent writer refuses any change toggle on it. */
  offeredBy?: 'source';
  /** PR-5 (D-PR5-3, S16c): the purpose the ACCESS persists when it is not the one the sheet quotes — a declared ask's host words, never the app's. */
  grantPurpose?: string;
  /** PR-5 (D-PR5-3/4/5): the choice the sheet starts on, decided by the caller — an offer's source with nothing ticked. Absent: the ranking's own (a declared ask's: the table tier only). */
  preselect?: { appId: string; tables: string[] };
  /** The frame's ask said `access: 'write'` (D-PR3-4) — threaded to the pending as `wantsWrite`. */
  wantsWrite?: boolean;
  candidates: RankedSources;
  hints?: AccessHints;
  /** The access being renewed: the preselection reads its table names; its whole scope reaches the sheet through `userAsk.ts`'s seed (U-Q12). */
  renew?: { grantId: string; sourceAppId: string; tables: string[] };
  /** The ask's semantic hash — what *don't allow* records (app asks, and the chat's asks). */
  hash?: string;
  /** Hears the outcome once, with the grant when one was written. */
  settle?: (outcome: ConsentOutcome, grant?: AnyAccessGrant) => void;
}

const offered = (candidates: RankedSources, appId: string): RankedSource | undefined =>
  [...candidates.matched, ...candidates.rest].find((candidate) => candidate.appId === appId);

/**
 * Where the sheet starts when the caller decided nothing: a renewal's own source and tables; else
 * the best-ranked source (or the only one) with the tables a hint matched — or every offerable
 * table. A DECLARED ask ticks only that source's TABLE tier, never the fallback (S10; G5-15 IB-6).
 */
function preselectionFor(input: ParkAccessRequestInput): PendingAccessRequest['preselect'] {
  const { candidates, renew } = input;
  if (renew !== undefined && offered(candidates, renew.sourceAppId) !== undefined) return { appId: renew.sourceAppId, tables: renew.tables };
  const first = candidates.matched[0] ?? (candidates.matched.length === 0 && candidates.rest.length === 1 ? candidates.rest[0] : undefined);
  if (first === undefined) return undefined;
  return { appId: first.appId, tables: input.askedIn === 'declared' ? tableTierTables(first, input.hints) : preselectedTables(first) };
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
      // D-PR5-5: an access a SOURCE offered is read-only by construction — the sheet shows no
      // write toggle, and a decision that claims one anyway writes nothing at all (fail closed).
      if (pending.offeredBy === 'source' && decision.tables.some((table) => typeof table !== 'string' && table.write)) {
        return { outcome: { kind: 'failed', message: 'an offer never lets an app change rows' } };
      }
      const generation = input.provenance === 'app' ? pending.generation : readerGeneration(pending.readerAppId);
      const grant = await createGrantFromDecision(db, {
        readerAppId: pending.readerAppId,
        source,
        tables: decision.tables,
        duration: decision.duration,
        unattended: decision.unattended,
        // S16c: a declared ask's access persists the host's words — the app's purpose was only quoted.
        purpose: input.grantPurpose ?? pending.purpose,
        // The GRANT says the chat asked (D-PR3-23; R-86); the pending stays the user's.
        provenance: pending.askedIn === 'chat' ? 'chat' : input.provenance,
        ...(generation !== undefined ? { generation } : {}),
        now: accessDeps().now(),
        ...(input.renew !== undefined ? { renew: input.renew.grantId } : {}),
        ...(decision.kv === true ? { kv: true } : {}),
        ...(decision.refresh === true ? { refresh: true } : {}),
      });
      // D36 on EVERY path (the app's ask and the user's alike): an allow that wrote a NEW access for
      // the renewed pair — the default *while it's open*, or another duration — REPLACES the old one,
      // so a paused row never lingers with *allow again* beside its successor (W6 finding 9).
      if (input.renew !== undefined && grant.id !== input.renew.grantId && grant.sourceAppId === input.renew.sourceAppId) {
        await revokeAccess(input.renew.grantId);
      }
      const write = grant.scope.tables.filter((table) => table.write === true).map((table) => table.name);
      return {
        outcome: {
          kind: 'allowed',
          grantId: grant.id,
          sourceAppId: source.appId,
          sourceName: source.displayName,
          tables: grant.scope.tables.map((table) => table.name),
          duration: decision.duration,
          write,
          // D-PR5-15: the ask wanted to change rows and the person let it change none — the line says so.
          ...(pending.wantsWrite === true && write.length === 0 ? { notChange: true as const } : {}),
        },
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
  const preselect = input.preselect ?? preselectionFor(input);
  // D-PR5-9: an app an imported file brought in reads as imported, whatever its install source claims.
  const imported = importedMarkerOf(db, reader.appId);
  const pending: PendingAccessRequest = {
    readerAppId: reader.appId,
    readerName: reader.displayName,
    ...(Object.keys(icon).length > 0 ? { readerIcon: icon } : {}),
    readerProvenance: provenanceLine(reader, {
      collides: nameCollides(db.listApps(), reader.appId),
      now: accessDeps().now(),
      ...(imported !== undefined ? { imported } : {}),
    }),
    generation: input.generation,
    purpose: input.purpose,
    provenance: input.provenance,
    ...(input.askedIn !== undefined ? { askedIn: input.askedIn } : {}),
    ...(input.offeredBy !== undefined ? { offeredBy: input.offeredBy } : {}),
    ...(input.askedIn === 'declared' && input.hash !== undefined ? { declinable: true as const } : {}),
    ...(input.askedIn === 'declared' ? { tableTierOnly: true as const, ...(input.hints !== undefined ? { hints: input.hints } : {}) } : {}),
    ...(input.renew !== undefined ? { renew: input.renew.grantId } : {}),
    ...(input.wantsWrite === true ? { wantsWrite: true } : {}),
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
