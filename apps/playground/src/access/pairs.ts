// access/pairs.ts — *apps that could work together* (TASK-20261010-host-broker PR-5; contract v2
// D-PR5-4; AC34; Q15 narrowed; S10, S11, F3, D3; v2.1 TB-Q7…Q9). ONE derivation for Settings, the
// Hub tile and the reader's ⋈ sheet.
//
// THE SIGNAL IS THE DECLARATION ONLY: what an app's own HTML says it would like to read (the
// `snug:access-wants` meta the db derives at every admission — `listAccessWants`). Two apps whose
// tables merely look alike pair with nothing: a file shows no pair until its apps declare (Q15).
//
// WHO MAY BE A READER. An app with a declaration that may use access here, is not muted, while
// asks are on in this browser, and whose origin the person can vouch for: never a share-link
// install, never an app an imported file brought in (S11 — its words reach host chrome only as a
// suggestion the person never asked for). Each of its wants WITH hints is ranked; a want the
// person already declined (its `accessRequestHash` on the declines) is not suggested again.
//
// THE SOURCES ARE THE REGISTERED SCHEMA (F3): `getAppSchema` → `registryTables` — no runtime is
// exported and nothing is described, so a Hub render never copies an app. An app that has never
// written its schema back is absent; a source holding a WhatsApp fact never pairs. The pure core
// (`rankPairs`, relevance.ts) admits a pair only on a TABLE-tier match (S10).
//
// EXCLUDED AFTER RANKING: a source already giving this reader access that is not STOPPED — live,
// paused or expired alike (Gate-5 G5-14: *allow again* on that row is the act; a new ask would
// leave a second access beside the paused one) — and any (reader, source) the person was told
// *not offered* in this session — a memory `startUserAsk` writes when a pair's ask could not be
// offered (the copy cap, a WhatsApp fact, a table-less app). The memory is cleared on the LIBRARY
// revision, read lazily here — never a subscription, so no loop.
//
// THE SOURCES ARE VOUCHED FOR TOO (G5-15, SA-7): an app a share link or an imported file brought
// in is never suggested as a source — the host would otherwise offer a look-alike's planted rows to
// a real reader. And ONE APP NEVER TAKES THE SURFACE DOWN (G5-13): each app is read on its own, so
// a row this file cannot read drops that app — never the ⋈ sheet's, Settings' or the Hub's read.
//
// Deterministic (relevance.ts's order); every surface shows the reader's best pair, Settings at
// most `PAIRS_MAX`. A surface that needs one reader's pairs says so (`readerAppId`), and one that
// already read the grants hands them in (`found`) — the Hub reads them once for its whole shelf.

import type { AppRecord, UserDb } from '@snugprotocol/db';
import { accessRequestHash, type AccessWants } from '@snugprotocol/protocol';

import { libraryRevisionStore } from '../platform/signals.js';
import { appMayUseAccess } from '../run/appCapabilityRules.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { accessAsksOff } from './consent.js';
import { foundGrants, type FoundAccessGrant } from './grants.js';
import { importedMarkerOf, readerProvenanceKind } from './provenance.js';
import { hasHints, rankPairs, registryTables, type PairReader, type PairSuggestion, type SourceApp } from './relevance.js';

export type { PairSuggestion } from './relevance.js';

/** At most this many pairs in Settings' *apps that could work together*. */
export const PAIRS_MAX = 5;

// ------------------------------------------------------------------- the not-offered memory

const pairKey = (readerAppId: string, sourceAppId: string): string => JSON.stringify([readerAppId, sourceAppId]);

const notOffered = new Set<string>();
/** The library revision the memory belongs to: any later revision (an install, a delete, a hand-in) forgets it. Read at the first use, never at load. */
let notOfferedRevision: number | undefined;

function currentMemory(): Set<string> {
  const revision = libraryRevisionStore.get();
  if (revision !== notOfferedRevision) {
    notOffered.clear();
    notOfferedRevision = revision;
  }
  return notOffered;
}

/** The person was told this source could not be offered to this reader: the pair is not suggested again this session (TB-Q9). */
export function rememberNotOffered(readerAppId: string, sourceAppId: string): void {
  currentMemory().add(pairKey(readerAppId, sourceAppId));
}

// ------------------------------------------------------------------------------- the derivation

/** The app's registered schema, or none when the registry row does not parse. */
function schemaOf(db: UserDb, appId: string): ReturnType<UserDb['getAppSchema']> {
  try {
    return db.getAppSchema(appId);
  } catch {
    return undefined;
  }
}

/** Whether the person can vouch for where an app came from: never a share-link install, never an app an imported file brought in (S11, SA-7). */
function vouchedFor(db: UserDb, app: AppRecord): boolean {
  const imported = importedMarkerOf(db, app.appId);
  const kind = readerProvenanceKind(app, imported !== undefined ? { imported } : {});
  return kind !== 'share' && kind !== 'imported';
}

/** One reader's wants still open to a suggestion: with hints, and not declined. `undefined`: no reader here. */
function readerOf(db: UserDb, app: AppRecord, wants: AccessWants | undefined): PairReader | undefined {
  if (wants === undefined || !appMayUseAccess(app.appId) || db.isAccessMuted(app.appId) || !vouchedFor(db, app)) return undefined;
  const declined = new Set(db.listAccessDeclines(app.appId).map((decline) => decline.hash));
  const open = wants.filter((want) => hasHints(want.hints) && !declined.has(accessRequestHash({ hints: want.hints ?? {} })));
  return open.length > 0 ? { appId: app.appId, displayName: app.displayName, wants: open } : undefined;
}

/** One app as a pair's source: its registered tables, unless it holds a WhatsApp fact or comes from somewhere the person cannot vouch for. `undefined`: never a source. */
function sourceOf(db: UserDb, app: AppRecord): SourceApp | undefined {
  if (appHasSidecarFact(db, app.appId) || !vouchedFor(db, app)) return undefined;
  const tables = registryTables(schemaOf(db, app.appId));
  if (tables.length === 0) return undefined;
  return {
    appId: app.appId,
    displayName: app.displayName,
    ...(app.description !== undefined ? { description: app.description } : {}),
    tables,
  };
}

/** `read` for one app — or nothing, when that app's rows cannot be read: one app never takes the derivation down (G5-13). */
function eachApp<T>(apps: readonly AppRecord[], read: (app: AppRecord) => T | undefined): T[] {
  return apps.flatMap((app) => {
    try {
      const value = read(app);
      return value === undefined ? [] : [value];
    } catch {
      return [];
    }
  });
}

export interface PairSuggestionOptions {
  /** Only this reader's pairs (the reader's ⋈ sheet). Absent: every reader's. */
  readerAppId?: string;
  /** The file's grants as the caller already read them (`foundGrants`) — believed, never read again (IB-7). */
  found?: readonly FoundAccessGrant[];
}

/**
 * Every pair the file suggests right now, best first (D-PR5-4). Reads the declarations, the
 * registry, the declines and the grants once each — never an export, never a describe. `_now`, the
 * caller's clock, no longer decides anything here: an access joins its pair whether or not it has
 * expired (G5-14).
 */
export function listPairSuggestions(db: UserDb, _now: number, opts: PairSuggestionOptions = {}): readonly PairSuggestion[] {
  if (accessAsksOff()) return [];
  const declared = db.listAccessWants();
  if (declared.size === 0) return [];
  const apps = db.listApps();

  const candidates = opts.readerAppId === undefined ? apps : apps.filter((app) => app.appId === opts.readerAppId);
  const readers = eachApp(candidates, (app) => readerOf(db, app, declared.get(app.appId)));
  if (readers.length === 0) return [];
  const sources = eachApp(apps, (app) => sourceOf(db, app));

  // G5-14: any access not stopped joins its pair — live, paused or expired.
  const joined = new Set(
    (opts.found ?? foundGrants(db))
      .filter((found) => found.grant.status !== 'revoked')
      .map((found) => pairKey(found.grant.readerAppId, found.grant.sourceAppId)),
  );
  const memory = currentMemory();
  return rankPairs({ readers, sources }).filter((pair) => {
    const key = pairKey(pair.readerAppId, pair.sourceAppId);
    return !joined.has(key) && !memory.has(key);
  });
}
