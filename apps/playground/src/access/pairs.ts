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
// EXCLUDED AFTER RANKING: a source already giving this reader LIVE access, and any (reader,
// source) the person was told *not offered* in this session — a memory `startUserAsk` writes when
// a pair's ask could not be offered (the copy cap, a WhatsApp fact, a table-less app). The memory
// is cleared on the LIBRARY revision, read lazily here — never a subscription, so no loop.
//
// Deterministic (relevance.ts's order); every surface shows the reader's best pair, Settings at
// most `PAIRS_MAX`.

import type { UserDb } from '@snugprotocol/db';
import { accessRequestHash } from '@snugprotocol/protocol';

import { libraryRevisionStore } from '../platform/signals.js';
import { appMayUseAccess } from '../run/appCapabilityRules.js';
import { appHasSidecarFact } from '../state/sidecarLive.js';
import { accessAsksOff } from './consent.js';
import { foundGrants, isLive } from './grants.js';
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

/**
 * Every pair the file suggests right now, best first (D-PR5-4). Reads the declarations, the
 * registry, the declines and the grants once each — never an export, never a describe.
 */
export function listPairSuggestions(db: UserDb, now: number): readonly PairSuggestion[] {
  if (accessAsksOff()) return [];
  const declared = db.listAccessWants();
  if (declared.size === 0) return [];
  const apps = db.listApps();

  const readers: PairReader[] = [];
  for (const app of apps) {
    const wants = declared.get(app.appId);
    if (wants === undefined || !appMayUseAccess(app.appId) || db.isAccessMuted(app.appId)) continue;
    const imported = importedMarkerOf(db, app.appId);
    const kind = readerProvenanceKind(app, imported !== undefined ? { imported } : {});
    if (kind === 'share' || kind === 'imported') continue;
    const declined = new Set(db.listAccessDeclines(app.appId).map((decline) => decline.hash));
    const open = wants.filter((want) => hasHints(want.hints) && !declined.has(accessRequestHash({ hints: want.hints ?? {} })));
    if (open.length > 0) readers.push({ appId: app.appId, displayName: app.displayName, wants: open });
  }
  if (readers.length === 0) return [];

  const sources: SourceApp[] = [];
  for (const app of apps) {
    if (appHasSidecarFact(db, app.appId)) continue;
    const tables = registryTables(schemaOf(db, app.appId));
    if (tables.length === 0) continue;
    sources.push({
      appId: app.appId,
      displayName: app.displayName,
      ...(app.description !== undefined ? { description: app.description } : {}),
      tables,
    });
  }

  const live = new Set(
    foundGrants(db)
      .filter((found) => isLive(found.grant, now, db))
      .map((found) => pairKey(found.grant.readerAppId, found.grant.sourceAppId)),
  );
  const memory = currentMemory();
  return rankPairs({ readers, sources }).filter((pair) => {
    const key = pairKey(pair.readerAppId, pair.sourceAppId);
    return !live.has(key) && !memory.has(key);
  });
}
