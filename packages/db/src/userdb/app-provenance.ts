// app-provenance.ts — the imported marker (TASK-20261010-host-broker PR-5, contract v2 D-PR5-9;
// R-77): `appProvenance:<appId>` = `{imported: true, at}` says this app ARRIVED WITH A FILE THE
// USER IMPORTED, and Snug cannot tell who made it.
//
// Why a marker: an untrusted import carries `install_source` verbatim, so a file can forge
// `starter:`, `agent:` or `share:` — and the access provenance (the consent sheet's *who made
// this*) would believe it. The marker overrides every install source there.
//
// WHO WRITES IT. Only the UNTRUSTED import (a file the user picked off disk): it drops every
// incoming marker (a file never vouches for itself), then marks every incoming app whose IDENTITY
// differs from the local app of the same id. Identity is the app's `install_source` plus the
// ordered list of EVERY version row's `(version, pinned, sha256(html))` — a planted past or pinned
// version changes it as surely as a new current html does (S4). An identical app keeps the LOCAL
// marker state (marked stays marked with its first date; unmarked stays unmarked); a fresh device
// holds no local app, so every incoming app is marked; an app deleted here and revived by the file
// is marked. A TRUSTED pull (the user's own origin) keeps the markers as they are; no edit clears
// one; `deleteApp` sweeps it. Host-internal (named in spec §8.1 for transparency).
//
// HASH FIRST, MARK LATER (PR-5 Gate 5, G5-6). Hashing is the import's only await besides closing
// the driver, so it runs BEFORE the import's synchronous snapshots: `hashAppIdentities` reads both
// sides (the local apps only for ids the candidate holds) up front, and `markImportedApps` is a
// synchronous pass over those maps. A stop the user makes while the import hashes is then seen by
// the grant snapshot, never silently undone by the swap.

import { USERDB_TABLES, appProvenanceSchema } from '@snugprotocol/protocol';
import { sha256Hex } from '../sync/sidecar.js';
import { APP_PROVENANCE_SETTING_PREFIX, appProvenanceKey } from './app-settings-keys.js';
import type { SettingsSql } from './schedules.js';

/** The stored marker — strict (the protocol's internal schema): anything else present under the key reads as imported with no date (fail closed). */
export { appProvenanceSchema };

/**
 * The marker as the host reads it — FAIL CLOSED (F14): absent (`undefined`) → not imported; a valid
 * row → `{imported: true, at}`; ANY other present value — junk, a wrong shape, `null` — → imported
 * with no date. A row Snug cannot read never makes an app look like the user's own.
 */
export function readAppProvenance(value: unknown): { imported: true; at?: string } | undefined {
  if (value === undefined) return undefined;
  const parsed = appProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : { imported: true };
}

/** Both sides' app identities, by id, hashed before an untrusted import's snapshots: the candidate's apps, and this hub's apps that the candidate also holds. */
export interface AppIdentities {
  incoming: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, string>;
}

/** A version's html as bytes to hash — the storage class is part of the identity, so a BLOB twin of a TEXT cell differs. */
function htmlBytes(cell: unknown): Uint8Array {
  if (typeof cell === 'string') return new TextEncoder().encode(`t:${cell}`);
  if (cell instanceof Uint8Array) {
    const tagged = new Uint8Array(cell.byteLength + 2);
    tagged.set([0x62, 0x3a]); // "b:"
    tagged.set(cell, 2);
    return tagged;
  }
  return new TextEncoder().encode(`n:${String(cell)}`);
}

/** One app's identity in the handle `sql` reads: `install_source` + every `(version, pinned, sha256(html))`, in version order. */
async function identityOf(sql: SettingsSql, appId: string, installSource: unknown): Promise<string> {
  const versions: Array<[number, number, string]> = [];
  for (const row of sql.select(`SELECT version, pinned, html FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? ORDER BY version`, [appId])) {
    versions.push([Number(row[0]), Number(row[1]), await sha256Hex(htmlBytes(row[2]))]);
  }
  return JSON.stringify([installSource === null || installSource === undefined ? null : String(installSource), versions]);
}

function rawSetting(sql: SettingsSql, key: string): string | undefined {
  const raw = sql.select(`SELECT value FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key])[0]?.[0];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** The identity of every app the handle `sql` holds, by id — only the ids in `only`, when given. */
async function identitiesOf(sql: SettingsSql, only?: ReadonlySet<string>): Promise<Map<string, string>> {
  const identities = new Map<string, string>();
  for (const row of sql.select(`SELECT app_id, install_source FROM ${USERDB_TABLES.apps} ORDER BY app_id`)) {
    const appId = String(row[0]);
    if (only === undefined || only.has(appId)) identities.set(appId, await identityOf(sql, appId, row[1]));
  }
  return identities;
}

/**
 * Hash both sides of an untrusted import, BEFORE its synchronous snapshots (G5-6): the CANDIDATE's
 * apps, which no import pass changes the identity of, and the apps of the OPEN handle `local` that
 * the candidate also holds — an app it does not hold is never compared, so it is never hashed.
 */
export async function hashAppIdentities(local: SettingsSql, candidate: SettingsSql): Promise<AppIdentities> {
  const incoming = await identitiesOf(candidate);
  return { incoming, local: await identitiesOf(local, new Set(incoming.keys())) };
}

/**
 * The UNTRUSTED import's pass, on the CANDIDATE before it goes live — synchronous, over the
 * identities `hashAppIdentities` read: drop every incoming marker, then write `{imported: true, at}`
 * for each incoming app whose identity differs from (or is absent in) this hub's; an identical app
 * gets this hub's marker row back verbatim (read from the open handle `local` now), or none. An
 * incoming app the hashing did not see is marked (fail closed). Answers how many apps are marked now.
 */
export function markImportedApps(sql: SettingsSql, local: SettingsSql, identities: AppIdentities, at: string = new Date().toISOString()): number {
  const escaped = `${APP_PROVENANCE_SETTING_PREFIX.replace(/([!%_])/g, '!$1')}%`;
  sql.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key LIKE ? ESCAPE '!'`, [escaped]);
  const marker = JSON.stringify(appProvenanceSchema.parse({ imported: true, at }));
  let marked = 0;
  for (const row of sql.select(`SELECT app_id FROM ${USERDB_TABLES.apps} ORDER BY app_id`)) {
    const appId = String(row[0]);
    const incoming = identities.incoming.get(appId);
    const same = incoming !== undefined && identities.local.get(appId) === incoming;
    const value = same ? rawSetting(local, appProvenanceKey(appId)) : marker;
    if (value === undefined) continue;
    sql.run(`INSERT OR REPLACE INTO ${USERDB_TABLES.settings} (key, value) VALUES (?, ?)`, [appProvenanceKey(appId), value]);
    marked += 1;
  }
  return marked;
}
