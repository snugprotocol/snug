/**
 * starterUpdate — the update channel for installed starters (TASK-20260820-starter-updates,
 * ADR-0045). Detection answers "is the bundled starter ahead of this user's copy?" for
 * the hub badge and the run header; the act lands the new bundle as a NEW PINNED version
 * of the user's own copy through `saveAppVersion`, which is what makes it non-destructive:
 * app data, credentials, connections, chat and docs are all keyed by `app_id` (never by
 * version), and the pre-update version stays in the versions panel, revertable.
 *
 * WHAT THE ACT REFRESHES (owner decision, task file): the HTML, the starter's runtime
 * contract for the new version (landed in the SAME `saveAppVersion` call — a factory
 * update ships factory contract, and atomicity closes the window where new HTML durably
 * runs under the old contract), the declared-only connection refresh, and the absent-only
 * docs seed. An `approved` or `revoked` connection row is never touched — the AC4 lock.
 *
 * VERSION KNOWLEDGE. `starterVersion:<appId>` (settings row, ADR-0045 §6) is written by
 * the install and update acts. A copy that predates versioning has no row and derives:
 * newest-pinned bytes equal to the bundle ⇒ it IS the current release; anything else ⇒
 * treat as v1, which can only over-offer (a no-op update), never hide one.
 */

import type { UserDb } from '@snugprotocol/db';
import { starterVersionSettingKey } from '@snugprotocol/db';
import { runtimeContractSchema, type RuntimeContract } from '@snugprotocol/protocol';

import { STARTER_PREFIX, loadStarterHtml } from './starterApps.js';
import { installStarterConnections, normalizeStarterHtml } from './starterDeclaration.js';
import { installStarterDocs } from './starterDocs.js';
import { bundledStarterContracts } from './starterRuntimeContract.js';
import { starterMetaFor, type StarterMeta } from './starterMeta.js';

const STARTER_SOURCE_PREFIX = 'starter:';

export interface StarterUpdateStatus {
  folder: string;
  /** Best knowledge of the version the user's copy is on (recorded, or derived). */
  installedVersion: number;
  latestVersion: number;
  updateAvailable: boolean;
  /** The running version has diverged from the newest factory pin — the user re-authored. */
  edited: boolean;
  /** The bundle's release metadata, for the header chip and the release-notes sheet. */
  meta: StarterMeta;
}

export type StarterUpdateResult =
  | { status: 'updated'; version: number }
  | { status: 'already-current'; version: number }
  | { status: 'unavailable' };

/** Test seam: starter folder → bundled app.html (production reads the shelf glob). */
let htmlFixtures: Record<string, string> | undefined;

export function __setStarterUpdateFixturesForTests(next: Record<string, string>): void {
  htmlFixtures = next;
}

export function __resetStarterUpdateFixturesForTests(): void {
  htmlFixtures = undefined;
}

function starterFolderOf(db: UserDb, appId: string): string | undefined {
  const source = db.getApp(appId)?.installSource;
  if (source === undefined || !source.startsWith(STARTER_SOURCE_PREFIX)) return undefined;
  const folder = source.slice(STARTER_SOURCE_PREFIX.length);
  return folder === '' ? undefined : folder;
}

async function bundledHtml(folder: string): Promise<string | undefined> {
  if (htmlFixtures !== undefined) return htmlFixtures[folder];
  return loadStarterHtml(`${STARTER_PREFIX}${folder}`);
}

/** The newest factory pin's html — fact 1's subject, shared with the vouch's semantics. */
function newestPinnedHtml(db: UserDb, appId: string): string | undefined {
  const pinned = db.listAppVersions(appId).find((version) => version.pinned); // DESC ⇒ newest pin
  return pinned === undefined ? undefined : db.getAppHtml(appId, pinned.version);
}

function recordedVersion(db: UserDb, appId: string): number | undefined {
  const stored = db.getSetting(starterVersionSettingKey(appId));
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 ? stored : undefined;
}

/**
 * The update status for an installed starter copy, or `undefined` when the question does
 * not apply (not a starter install, starter no longer bundled, or unversioned).
 */
export async function starterUpdateStatus(db: UserDb, appId: string): Promise<StarterUpdateStatus | undefined> {
  const folder = starterFolderOf(db, appId);
  if (folder === undefined) return undefined;
  const meta = await starterMetaFor(folder);
  if (meta === undefined) return undefined;
  const bundle = await bundledHtml(folder);
  if (bundle === undefined) return undefined;

  const factory = newestPinnedHtml(db, appId);
  const running = db.getAppHtml(appId);
  if (factory === undefined || running === undefined) return undefined;

  const factoryIsCurrentRelease = normalizeStarterHtml(factory) === normalizeStarterHtml(bundle);
  const installedVersion = recordedVersion(db, appId) ?? (factoryIsCurrentRelease ? meta.version : 1);

  return {
    folder,
    installedVersion,
    latestVersion: meta.version,
    updateAvailable: meta.version > installedVersion,
    edited: normalizeStarterHtml(running) !== normalizeStarterHtml(factory),
    meta,
  };
}

/** The starter's bundled contract for this release, or `undefined` (LLM-free / none). */
async function bundledContract(folder: string): Promise<RuntimeContract | undefined> {
  try {
    const raw = (await bundledStarterContracts())[folder];
    if (raw === undefined) return undefined;
    const parsed = runtimeContractSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE UPDATE ACT — the second host write act of the install-act class (ADR-0045 §3; the
 * first is `installThisStarter` in RunView). Idempotent: bytes already at the bundle ⇒
 * nothing is written except healing a missing `starterVersion:` row, so a retry after a
 * partial failure converges instead of accumulating pinned versions.
 *
 * Throws only from the version write itself (the caller renders the failure); the
 * connection/docs refreshes keep their own never-throw posture, exactly as at install.
 */
export async function applyStarterUpdate(db: UserDb, appId: string): Promise<StarterUpdateResult> {
  const folder = starterFolderOf(db, appId);
  if (folder === undefined) return { status: 'unavailable' };
  const meta = await starterMetaFor(folder);
  const bundle = folder === undefined ? undefined : await bundledHtml(folder);
  if (meta === undefined || bundle === undefined) return { status: 'unavailable' };

  const running = db.getAppHtml(appId);
  if (running !== undefined && normalizeStarterHtml(running) === normalizeStarterHtml(bundle)) {
    // Already on this release's bytes — heal the version row if a prior attempt died
    // before writing it, and change nothing else.
    if (recordedVersion(db, appId) !== meta.version) {
      db.setSetting(starterVersionSettingKey(appId), meta.version);
    }
    return { status: 'already-current', version: meta.version };
  }

  const contract = await bundledContract(folder);
  db.saveAppVersion(appId, bundle, `starter update to v${meta.version}`, undefined, {
    pinned: true,
    ...(contract === undefined ? {} : { contract }),
  });
  // Same order and same posture as the install act: the declared-only connection refresh
  // runs against the freshly-vouchable copy (newest pin = current = bundle), and the docs
  // seed stays absent-only. Both decline quietly rather than fail the update.
  await installStarterConnections(db, appId);
  await installStarterDocs(db, appId);
  // The version row last: a failure anywhere above leaves it stale, so the update stays
  // OFFERED and the retry converges through the idempotence branch.
  db.setSetting(starterVersionSettingKey(appId), meta.version);
  return { status: 'updated', version: meta.version };
}
