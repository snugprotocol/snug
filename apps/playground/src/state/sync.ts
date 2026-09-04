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
import { resetThreadSessions } from '../agent/threadSessions.js';
import { resetSidecarIdentitySession } from './sidecarIdentity.js';
import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';

/**
 * The hub sync origin needs BOTH capability seats (Gate-5, TASK-20260822): a
 * platform that can reach a hub (`hubSyncOrigin` — relative /userdb URLs mean
 * nothing against tauri://) AND a build whose sign-in surface exists (`hubAuth`,
 * ADR-0052 §5) — hub sync authenticates by session cookie, so offering the origin
 * where sign-in is structurally hidden is either a dead 401 loop or, with a stale
 * cookie, silent egress under an account the UI denies exists.
 */
export function hubOriginAvailable(): boolean {
  const caps = getPlatform().capabilities;
  return caps.hubSyncOrigin && caps.hubAuth === true;
}
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
  // Same seam for the per-thread build sessions (ADR-0062): they mirror rows of the
  // file that was just replaced, and any in-flight turn would write into the new one.
  resetThreadSessions();
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
  if (kind === 'hub' && !hubOriginAvailable()) {
    // An imported config can name the hub origin on a platform that has none (relative
    // /userdb URLs mean nothing against tauri:// — P0 amendment 13), or on a build
    // whose sign-in surface is flag-hidden (ADR-0052 §5) — where resuming the loop
    // would silently keep pushing the file under a session the UI cannot even show,
    // let alone sign out of (Gate-5 finding). Say so honestly instead of building a
    // loop that would fail — or worse, succeed invisibly — mid-sync.
    syncStatusStore.set({
      origin: 'hub',
      state: 'error',
      detail: getPlatform().capabilities.hubSyncOrigin
        ? 'hub sync needs the sign-in surface, which this build hides — choose this device only, or dropbox (self-hosters: build with VITE_SNUG_HUB_AUTH=1)'
        : 'hub sync is not available in the desktop app — choose this device only, or dropbox',
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
    // ADR-0043 D5 lives or dies HERE. The loop seals personal-origin payloads only if
    // the composition root hands it a sealer; without this line a protected file syncs
    // to the user's own Dropbox as a readable database, and every package-level test
    // still passes because they wire the sealer themselves (diff review D-2).
    // Read through the getter at loop-construction time, and `resyncAfterProtection`
    // rebuilds the loop when protection is toggled — a captured value would go stale.
    ...(userDb.sealForOrigin !== undefined ? { sealForOrigin: userDb.sealForOrigin } : {}),
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

/**
 * Rebuild the sync loop after protection is turned on or off.
 *
 * The loop captures its sealer when it is constructed, so a loop started before
 * `protect()` would keep pushing plaintext to a personal origin (or, after
 * un-protecting, keep pushing ciphertext). Cheap and idempotent: it re-reads the
 * configured origin and starts a fresh loop, or does nothing when sync is off.
 */
export async function resyncAfterProtectionChange(): Promise<void> {
  const current = syncStatusStore.get().origin;
  if (current === 'none') return;
  await initSync();
}

export function useSyncStatus(): SyncStatus {
  return useStore(syncStatusStore);
}

// ------------------------------------------------------------------ export/import

/**
 * Mandatory hub behavior (ADR-0009): one-click canonical `.snug` download.
 *
 * A PROTECTED file exports protected (D5): the artifact a user hands around, mails to
 * themselves, or drops in cloud storage is the one most likely to end up somewhere they
 * did not intend, so it carries the same protection the file on disk has.
 *
 * The MIME type follows the bytes (review S4). Labelling a container
 * `application/x-sqlite3` would tell every tool on the user's machine it is an
 * openable database, which it is not.
 */
export async function exportUserFile(includeSecrets: boolean): Promise<Blob> {
  const db = await getUserDb();
  // Strip + VACUUM run on plaintext; sealing happens after, never before.
  const plain = await db.exportUserDb({ includeSecrets });
  const seal = db.sealForOrigin;
  const bytes = seal === undefined ? plain : await seal(plain);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], {
    type: seal === undefined ? 'application/x-sqlite3' : 'application/octet-stream',
  });
}

/** Import replaces local state; imported settings are executable config (F15). */
export async function importUserFile(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<void> {
  const db = await getUserDb();
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Abort BEFORE the swap (Gate-5 review): a turn still holding `db` could otherwise
  // land a row inside the freshly imported file during the import's own awaits.
  // `afterForeignBytes` resets again afterwards — that call also serves the pull path.
  resetThreadSessions();
  await db.importUserDb(bytes);
  await afterForeignBytes();
}
