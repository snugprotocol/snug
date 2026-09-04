// installShared.ts — the recipient's write acts (TASK-20260904-app-sharing, ADR-0063 §1).
//
// Two acts, both ending in the user file and both leaving the shelf: INSTALL a shelf
// entry as a new app (the starter install, minus first-party trust — `installAppFromBundle`
// in packages/db does the work; the composition root's admission gate judges every
// connection on the `shared` channel), and UPDATE an installed lineage from a newer
// bundle on the shelf (ADR-0045's act with a bundle as source). The hub never writes;
// these are called from the run header, the same place the starter acts live.

import { installAppFromBundle, sharedBundleSettingKey, shareInstallSource, updateAppFromBundle } from '@snugprotocol/db';
import type { UserDb } from '@snugprotocol/db';

import { refreshAppMeta } from '../state/appMeta.js';
import { getUserDb } from '../state/userdb.js';
import { getSharedEntry, removeSharedEntry, sharedEntryForLineage, type SharedEntry } from './sharedInbox.js';

export interface SharedInstallOutcome {
  appId: string;
  status: 'installed' | 'already-installed';
  refusedSlots: { slot: string; reason: string }[];
}

export async function installSharedEntry(bundleId: string): Promise<SharedInstallOutcome> {
  const entry = getSharedEntry(bundleId);
  if (entry === undefined) throw new Error('that shared app is no longer on your shelf');
  const db = await getUserDb();
  const result = await installAppFromBundle(db, entry.bundle, { bundleId });
  await removeSharedEntry(bundleId);
  await refreshAppMeta();
  return { appId: result.appId, status: result.status, refusedSlots: result.refusedSlots };
}

export interface SharedUpdateStatus {
  /** The shelf entry that is newer than the installed copy. */
  entry: SharedEntry;
  /** The recipient re-authored their copy (current ≠ newest pinned) — confirm before replacing. */
  edited: boolean;
}

/**
 * Is there a newer bundle of THIS installed app's lineage on the shelf? Identity, never
 * html byte-equality (lesson 2026-08-21: docs-only re-shares hide behind bytes).
 */
export function sharedUpdateStatus(db: UserDb, appId: string): SharedUpdateStatus | undefined {
  const app = db.getApp(appId);
  const source = app?.installSource;
  if (app === undefined || source === undefined || !source.startsWith('share:')) return undefined;
  const lineage = source.slice('share:'.length);
  const entry = sharedEntryForLineage(lineage);
  if (entry === undefined) return undefined;
  if (db.getSetting(sharedBundleSettingKey(appId)) === entry.bundleId) return undefined;
  if (shareInstallSource(lineage) !== source) return undefined;
  const versions = db.listAppVersions(appId);
  const newestPinned = versions.filter((v) => v.pinned).sort((a, b) => b.version - a.version)[0];
  const edited = newestPinned !== undefined && newestPinned.version !== app.currentVersion
    ? db.getAppHtml(appId) !== db.getAppHtml(appId, newestPinned.version)
    : false;
  return { entry, edited };
}

export async function applySharedUpdate(appId: string, bundleId: string): Promise<{ version: number } | { status: 'already-current' }> {
  const entry = getSharedEntry(bundleId);
  if (entry === undefined) throw new Error('that shared app is no longer on your shelf');
  const db = await getUserDb();
  const result = await updateAppFromBundle(db, appId, entry.bundle, { bundleId });
  await removeSharedEntry(bundleId);
  await refreshAppMeta();
  return result.status === 'updated' ? { version: result.version } : { status: 'already-current' };
}
