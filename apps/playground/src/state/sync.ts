// sync.ts — the page's sync-origin lifecycle (child 4 playground half, ADR-0009).
// OPFS is authoritative; the chosen origin (hub / Dropbox) is a replica fed by the
// db package's serialized sync loop. Origin CONFIG lives in the user DB (snug_sync,
// self-describing when ported); push-state lives in the loop's OPFS sidecar.
// Divergence is surfaced here and resolved ONLY by explicit user action
// (applyRemote/pushLocal) — applyRemote also arms the F15 endpoint re-confirmation
// because pulled bytes are executable config.

import {
  createDropboxProvider,
  createHubOriginProvider,
  createSyncLoop,
  detectPersistenceBackend,
  type SyncEvent,
  type SyncLoop,
  type SyncProvider,
} from '@snugprotocol/db';
import { USERDB_OPFS_DIR } from '@snugprotocol/protocol';

import { getPlatform } from '../platform/platform.js';
import { refreshAppMeta } from './appMeta.js';
import { hydrateSettings, markEndpointsNeedConfirm } from './mode.js';
import { resetSidecarIdentitySession } from './sidecarIdentity.js';
import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';
import { logout, readCsrfToken } from './auth.js';

export type SyncOriginKind = 'none' | 'hub' | 'dropbox';

export interface SyncStatus {
  origin: SyncOriginKind;
  state: 'off' | 'idle' | 'syncing' | 'divergence' | 'error';
  detail?: string;
}

export const syncStatusStore = createStore<SyncStatus>({ origin: 'none', state: 'off' });

const SYNC_INTERVAL_MS = 30_000;
/** snug_secrets key for the Dropbox access token (stripped from hub sync + default export). */
export const DROPBOX_TOKEN_SECRET = 'dropbox:token';

let loop: SyncLoop | undefined;

/** Foreign bytes just became local state: arm F15 and re-mirror stores from the DB. */
async function afterForeignBytes(): Promise<void> {
  // The sidecar identity harvest is scoped to ONE user-file identity: without this
  // reset, the previous file's third-party contacts would be re-persisted into the
  // imported/pulled file on the next harvest (TASK-20260820, Gate-5 review).
  resetSidecarIdentitySession();
  markEndpointsNeedConfirm();
  const db = await getUserDb();
  hydrateSettings(db);
  // hydrateSettings re-reads needsEndpointConfirm from the (pulled) DB — the arm above
  // must win regardless of what the foreign image claimed about itself.
  markEndpointsNeedConfirm();
  await refreshAppMeta();
}

function onSyncEvent(event: SyncEvent): void {
  const current = syncStatusStore.get();
  if (event.kind === 'divergence') {
    // An unnamed remote revision means the origin could not identify what it holds — in
    // practice it holds nothing (its copy was reset) while this device still remembers
    // syncing to it. Same resolver, honest copy: "keep this device's copy" re-provisions.
    syncStatusStore.set({
      ...current,
      state: 'divergence',
      detail:
        event.remoteRevision === undefined
          ? 'the origin no longer has the copy this device synced to'
          : 'the origin has a different copy',
    });
  } else if (event.kind === 'error') {
    syncStatusStore.set({ ...current, state: 'error', detail: event.message });
  } else {
    if (event.kind === 'pulled') void afterForeignBytes(); // auto pull-merge (F15 + rehydrate)
    syncStatusStore.set({ ...current, state: 'idle', detail: undefined });
  }
}

async function buildProvider(kind: SyncOriginKind): Promise<SyncProvider | undefined> {
  if (kind === 'hub') {
    // csrfToken is captured at construction — the loop is rebuilt after login/logout,
    // which is exactly when the cookie changes.
    const csrf = readCsrfToken();
    return createHubOriginProvider({
      baseUrl: '',
      fetch: (input, init) => globalThis.fetch(input, init),
      ...(csrf !== undefined ? { csrfToken: csrf } : {}),
    });
  }
  if (kind === 'dropbox') {
    const db = await getUserDb();
    return createDropboxProvider({
      getToken: () => Promise.resolve(db.getSecret(DROPBOX_TOKEN_SECRET)),
      fetch: (input, init) => globalThis.fetch(input, init),
    });
  }
  return undefined;
}

async function startLoop(kind: SyncOriginKind): Promise<void> {
  loop?.stop();
  loop = undefined;
  if (kind === 'none') {
    syncStatusStore.set({ origin: 'none', state: 'off' });
    return;
  }
  if (kind === 'hub' && !getPlatform().capabilities.hubSyncOrigin) {
    // An imported config can name the hub origin on a platform that has none (relative
    // /userdb URLs mean nothing against tauri:// — P0 amendment 13). Say so honestly
    // instead of building a loop that would fail mid-sync.
    syncStatusStore.set({
      origin: 'hub',
      state: 'error',
      detail: 'hub sync is not available in the desktop app — choose this device only, or dropbox',
    });
    return;
  }
  const provider = await buildProvider(kind);
  if (provider === undefined) return;
  const userDb = await getUserDb();
  loop = createSyncLoop({
    userDb,
    provider,
    // The sidecar sits beside the user file — SAME backend as the userdb open
    // (Decision 7): platform-supplied on desktop, OPFS detection on web.
    backend: getPlatform().userdbBackend ?? detectPersistenceBackend(USERDB_OPFS_DIR),
    intervalMs: SYNC_INTERVAL_MS,
    // Secrets ride only to personal origins the user explicitly opted into.
    includeSecrets: kind === 'dropbox',
    onEvent: onSyncEvent,
  });
  syncStatusStore.set({ origin: kind, state: 'syncing' });
  await loop.reconcileOnStart();
  loop.start();
  if (syncStatusStore.get().state === 'syncing') {
    syncStatusStore.set({ origin: kind, state: 'idle' });
  }
}

/** Boot hook: resume the configured origin (config travels inside the user DB). */
export async function initSync(): Promise<void> {
  const db = await getUserDb();
  const config = db.getSyncConfig('origin') as { kind?: SyncOriginKind } | undefined;
  const kind = config?.kind ?? 'none';
  syncStatusStore.set({ origin: kind, state: kind === 'none' ? 'off' : 'idle' });
  if (kind !== 'none') await startLoop(kind);
}

/** User picked an origin. Persist the choice into the DB, then (re)start the loop. */
export async function setSyncOrigin(kind: SyncOriginKind): Promise<void> {
  const db = await getUserDb();
  db.setSyncConfig('origin', { kind });
  await startLoop(kind);
}

/**
 * Explicit LWW: take the origin copy. Pulled bytes are executable config (F15).
 *
 * ADVERSARIAL-REVIEW FIX (2026-08-04). This used to unconditionally set `idle`, which
 * ERASED a terminal error the loop had just emitted. `loop.applyRemote()` does not
 * throw when the origin holds no image — it emits `{kind:'error', ORIGIN_EMPTY}` and
 * returns (`packages/db/src/sync/loop.ts:195-202`), so the old code overwrote that
 * error one tick later and the banner vanished with nothing synced.
 *
 * The empty-origin case became REACHABLE in this task: before Phase B a revision-less
 * 412 threw SYNC_BAD_RESPONSE and never reached the resolver at all. Phase B correctly
 * routes it to the two-button resolver, and "use the origin copy" is the intuitive
 * click when the detail reads "the origin no longer has the copy this device synced
 * to" — so the dead-end button is now exactly what a user is invited to press.
 *
 * Two rules: never clobber a terminal state we did not clear, and never arm the F15
 * re-confirmation for bytes that were never imported.
 */
export async function applyRemote(): Promise<void> {
  if (loop === undefined) return;
  const before = syncStatusStore.get().state;
  await loop.applyRemote();
  // A pull that imported nothing leaves the loop's own error/divergence standing.
  const after = syncStatusStore.get();
  if (after.state === 'error' && before !== 'error') return;
  await afterForeignBytes();
  syncStatusStore.set({ ...syncStatusStore.get(), state: 'idle', detail: undefined });
}

/** Explicit LWW: overwrite the origin with the local copy. */
export async function pushLocal(): Promise<void> {
  if (loop === undefined) return;
  await loop.pushLocal();
  syncStatusStore.set({ ...syncStatusStore.get(), state: 'idle', detail: undefined });
}

export async function syncNow(): Promise<void> {
  await loop?.syncNow();
}

/**
 * Sign out AND rebuild the sync loop (review F14): the hub provider captures the CSRF
 * token at construction, so the rebuild must happen AFTER the logout cleared the
 * cookies — otherwise a hub-origin loop keeps pushing with stale credentials.
 */
export async function signOut(): Promise<void> {
  await logout();
  await initSync();
}

export function useSyncStatus(): SyncStatus {
  return useStore(syncStatusStore);
}

// ------------------------------------------------------------------ export/import

/** Mandatory hub behavior (ADR-0009): one-click canonical `.sqlite` download. */
export async function exportUserFile(includeSecrets: boolean): Promise<Blob> {
  const db = await getUserDb();
  const bytes = await db.exportUserDb({ includeSecrets });
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'application/x-sqlite3' });
}

/** Import replaces local state; imported settings are executable config (F15). */
export async function importUserFile(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<void> {
  const db = await getUserDb();
  const bytes = new Uint8Array(await file.arrayBuffer());
  await db.importUserDb(bytes);
  await afterForeignBytes();
}
