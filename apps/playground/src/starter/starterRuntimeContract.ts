/**
 * starterRuntimeContract — copies a starter's authored runtime contract onto the app at
 * install time (ADR-0018, AC-F1-2).
 *
 * WHY THIS EXISTS. A starter is INSTALLED, not built: no authoring turn runs, so neither
 * `runtime_contract_write` nor the post-turn synthesis fallback ever fires for one. Without
 * this copy the reference apps — the ones a new user meets first — would be precisely the
 * apps with no contract, running on generic layers while the KB holds them up as exemplars.
 *
 * SAME SHAPE AS `installStarterConnections`, deliberately (its `?raw` glob, its
 * degrade-quietly posture, its "never overwrite what the user has" rule). Two differences,
 * both because a contract is a smaller claim than a connection:
 *  - there is no two-fact vouch. A connection declaration can lead to a credential prompt,
 *    so it must prove the installed HTML still matches the starter. A contract only shapes
 *    how the app talks to the model; the worst case of a stale one is a worse answer, and
 *    the app's own re-authoring path fixes it.
 *  - it is validated with the REAL schema and dropped on failure, so a malformed starter
 *    file can never install a contract the runtime would then refuse to parse.
 */

import type { UserDb } from '@snugprotocol/db';
import { STARTER_INSTALL_SOURCE_PREFIX } from '@snugprotocol/db';
import { canonicalRuntimeContract, runtimeContractSchema, type RuntimeContract } from '@snugprotocol/protocol';

import { starterSource } from './starterSource.js';

/**
 * `starterContract:<appId>` — the contract a starter install or update last WROTE onto this
 * copy, as canonical bytes (`null`: it wrote none). Gate 5 seams/F2: the builder's
 * `runtime_contract_write` re-authors a contract IN PLACE on the current version, and on an
 * unedited copy that version IS the starter's pin — so the pin cannot witness what the
 * starter wrote, and "has the user re-authored it?" needs the fact recorded when it is true.
 *
 * Defined here rather than beside `starterVersion:` in packages/db's settings-key module,
 * which the Gate 5 fix could not touch — so that module's obligation is still OWED for this
 * key: `deleteApp`'s cascade removes it. Until then a deleted app leaves this row behind; it
 * is read only for a starter install of the SAME app id, whose install act writes it afresh.
 */
export function starterContractSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `starterContract:${appId}`;
}

/** Record what the starter just wrote (`undefined`: no contract). Never throws — a missing record only means the copy is judged as before. */
export function recordStarterContract(db: UserDb, appId: string, contract: RuntimeContract | undefined): void {
  try {
    db.setSetting(starterContractSettingKey(appId), contract === undefined ? null : canonicalRuntimeContract(contract));
  } catch {
    /* the copy keeps its contract; the edit check falls back to the newest pin */
  }
}

/** What the starter last wrote: canonical bytes, `null` for none, `undefined` for no record (a copy older than the record). */
export function starterWrittenContract(db: UserDb, appId: string): string | null | undefined {
  const stored = db.getSetting(starterContractSettingKey(appId));
  return typeof stored === 'string' || stored === null ? stored : undefined;
}

/** Test seam: starter folder → raw contract JSON. */
let fixtures: Record<string, string> | undefined;

export function __setRuntimeContractFixturesForTests(next: Record<string, string>): void {
  fixtures = next;
}

export function __resetRuntimeContractFixturesForTests(): void {
  fixtures = undefined;
}

/** Every bundled starter contract, keyed by starter folder (read through the one source). */
export async function bundledStarterContracts(): Promise<Record<string, string>> {
  if (fixtures !== undefined) return fixtures;
  const source = starterSource();
  const out: Record<string, string> = {};
  for (const folder of source.appFolders()) {
    const raw = await source.contract(folder);
    if (raw !== undefined) out[folder] = raw;
  }
  return out;
}

/**
 * Copy the starter's contract onto `appId`, when there is one to copy.
 *
 * Every failure path is a silent no-op by design: an install must not fail because a
 * bonus artifact was malformed, and contract-less is a fully supported state (AC-F1-4).
 */
export async function installStarterRuntimeContract(db: UserDb, appId: string): Promise<void> {
  const app = db.getApp(appId);
  if (app === undefined) return;

  const source = app.installSource;
  if (source === undefined || !source.startsWith(STARTER_INSTALL_SOURCE_PREFIX)) return;
  const folder = source.slice(STARTER_INSTALL_SOURCE_PREFIX.length);
  if (folder === '') return;

  // Never clobber an existing contract: a user who re-authored theirs must not lose it to
  // a re-run of the install act.
  if (db.getRuntimeContract(appId) !== undefined) return;

  try {
    const raw = (await bundledStarterContracts())[folder];
    if (raw === undefined) {
      // LLM-free starter — nothing to copy. Recorded all the same: a contract that appears
      // on this copy later was written by someone else (seams/F2).
      recordStarterContract(db, appId, undefined);
      return;
    }
    const parsed = runtimeContractSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return; // a starter contract the runtime would reject is worse than none
    db.putRuntimeContract(appId, app.currentVersion, parsed.data);
    // AFTER the write it describes: a failed write records nothing.
    recordStarterContract(db, appId, parsed.data);
  } catch {
    // Malformed JSON, a write refusal, a glob miss — all the same outcome: no contract.
  }
}
