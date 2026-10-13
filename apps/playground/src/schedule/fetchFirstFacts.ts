// schedule/fetchFirstFacts.ts — which apps an *ask* step would ask to fetch new data first, NOW
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-19 and its v2.1 answer T-D Q8; F8).
//
// ONE derivation for every surface that says it: the editor offers the tick only when the step's
// app has at least one, its hint names them, its stale form says none does; the consent's row
// names them. A source counts when the step's app holds LIVE, PERSISTED access to it carrying both
// `refresh` and `unattended` — a schedule runs while the person is away, and a session's access
// never outlives the tab. That is exactly what the access policy admits for a SCHEDULE caller's
// `refresh` (`refreshableReads`), so the fetch at run time asks exactly the apps named here. The
// mount site calls this and hands the result down (`EnableConsent.fetchFirstByApp`); no surface
// derives it twice.

import type { UserDb } from '@snugprotocol/db';

import { refreshableReads } from '../access/service.js';

/** The library names of the sources `appId` may ask for new data while the person is away — one per source, in the order the fetch asks them. */
export function fetchFirstSources(db: UserDb, appId: string, now: number): readonly string[] {
  // A schedule's caller: the policy reads its app and its absence of anyone present, never the ids of a run that has not happened.
  const rows = refreshableReads(db, { kind: 'schedule', appId, taskId: '', runId: '' }, now);
  const names = new Map<string, string>();
  for (const row of rows) if (!names.has(row.grant.sourceAppId)) names.set(row.grant.sourceAppId, row.sourceName);
  return [...names.values()];
}

/** The same, for each of `appIds` — the map the consent and the editor are handed. */
export function fetchFirstSourcesByApp(db: UserDb, appIds: readonly string[], now: number): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const appId of new Set(appIds)) out[appId] = fetchFirstSources(db, appId, now);
  return out;
}
