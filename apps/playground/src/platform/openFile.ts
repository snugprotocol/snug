// openFile.ts — the `.snug` open-with routing seam (TASK-20260812 Decision 8, P0
// amendment 12). The (bytes, path) pair arrives from OS argv / open events, so it is
// UNTRUSTED until proven to be a real user file: flag-shaped strings, URL-shaped
// strings, wrong extensions, and magic-less bytes are all inert — no dialog, no side
// effect. Only sqlite-magic bytes reach the confirm, and only a confirmed open
// reaches `importUserFile` (which arms the F15 endpoint re-confirmation). No silent
// import, ever.
//
// TWO KINDS OF `.snug` SINCE TASK-20260904 (ADR-0063 §2/§6). A `.snug` file is either a
// USER FILE (SQLite bytes, or a `SNUGENC1` container) or an APP BUNDLE (JSON). The
// platform seat delivers bytes+path for either; `dispatchOpenedSnugFile` sniffs the
// FIRST BYTES (`sniffSnugFile`, the one reader every importer shares) and routes: a user
// file to the unchanged confirm-then-replace flow below, a bundle to the "shared with
// you" shelf (an opened attachment IS the explicit act, so it is kept) and its preview.
// The two can never cross: a bundle has no SQLite magic, so `isUserFilePayload` refuses
// it before any confirm; a user file starts with a byte that is not `{`.

import { importUserFile } from '../state/sync.js';
import { isEncryptedContainer, sniffSnugFile } from '@snugprotocol/db';
import { receiveSharedBundle, sharedInboxNoteStore, sharedOpenRequestStore } from '../share/sharedInbox.js';

import { restoreUserDbFromBytes, userDbNeedsRestore, userDbStatusStore } from '../state/userdb.js';
import { createStore, type Store } from '../state/store.js';
import { getPlatform } from './platform.js';

// The import gate wants a real user file: plain SQLite bytes, or a protected
// `SNUGENC1` container (ADR-0043). Deliberately narrower than the db package's
// `looksComplete`, which also admits the sync-sidecar envelope.
const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0);

const hasSqliteMagic = (bytes: Uint8Array): boolean => {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
};

/**
 * Without this, double-clicking a PROTECTED `.snug` was silently inert: no dialog, no
 * error, nothing — the single worst way to fail, because the user cannot tell a broken
 * app from a broken file.
 */
const isUserFilePayload = (bytes: Uint8Array): boolean => hasSqliteMagic(bytes) || isEncryptedContainer(bytes);

/**
 * A plausible user-file path: not flag-shaped, not URL-shaped, and named `.snug`
 * (desktop convention) or `.sqlite` (the web export's name).
 */
const looksLikeUserFilePath = (path: string): boolean =>
  !path.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path) && /\.(snug|sqlite)$/i.test(path);

/**
 * Routes an opened file into the import flow — gates first, confirm second, F15 arms
 * via importUserFile.
 *
 * TWO FAILURE MODES MUST REACH THE USER (whole-surface review finding 5). A file that
 * passes the magic gate can still be rejected downstream (BAD_IMPORT for
 * magic-valid-but-unopenable bytes or a too-new schema version, TOO_LARGE past the
 * cap). Those used to be unhandled rejections with ZERO UI — the double-click did
 * nothing and said nothing.
 *
 * AND the database may not be open at all. `importUserFile` awaits `getUserDb()`,
 * which never resolves while the status is corrupt/load-failed — precisely the state
 * a user is in when they reach for a backup. So when the db needs rescuing, this
 * routes to `restoreUserDbFromBytes` (which writes the backup and re-runs the real
 * open) instead of parking forever on a promise that cannot settle.
 */
export async function handleOpenedUserFile(
  bytes: Uint8Array,
  path: string,
  confirm: (info: { path: string; needsRestore: boolean }) => Promise<boolean>,
): Promise<void> {
  if (!looksLikeUserFilePath(path)) return;
  if (!isUserFilePayload(bytes)) return;
  // A LOCKED database cannot import (importUserFile awaits getUserDb(), which never
  // resolves while locked) and must not be offered restore-from-backup either — that
  // would answer a forgotten passphrase by overwriting good data. Say so and stop.
  if (userDbStatusStore.get().state === 'locked') {
    openUserFileErrorStore.set('unlock this Snug file first, then open the one you want to import');
    return;
  }
  const needsRestore = userDbNeedsRestore();
  if (!(await confirm({ path, needsRestore }))) return;
  // Copy into a fresh ArrayBuffer-backed view — importUserFile wants an ArrayBuffer
  // and the incoming view may sit on a shared/offset buffer.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  // Re-read the state: the user may have sat on the confirm while a retry landed.
  if (userDbNeedsRestore()) {
    await restoreUserDbFromBytes(new Uint8Array(buffer));
    return;
  }
  await importUserFile({ arrayBuffer: () => Promise.resolve(buffer) });
}

export interface OpenUserFileConfirm {
  path: string;
  /** True when the db cannot open, so the dialog says "restore" rather than "replace". */
  needsRestore: boolean;
  resolve: (confirmed: boolean) => void;
}

/**
 * The failure of an open-file import, for the App-level banner; null when nothing
 * failed. Without this, BAD_IMPORT/TOO_LARGE rejections were unhandled promise
 * rejections and the double-click silently did nothing (finding 5).
 */
export const openUserFileErrorStore: Store<string | null> = createStore<string | null>(null);

/** Dismiss the banner. */
export function clearOpenUserFileError(): void {
  openUserFileErrorStore.set(null);
}

/** Pending replace-confirm the App-level dialog renders; null when nothing is parked. */
export const openUserFileConfirmStore: Store<OpenUserFileConfirm | null> = createStore<OpenUserFileConfirm | null>(
  null,
);

/** The dialog-backed confirm: parks until the user decides in OpenUserFileConfirmDialog. */
function confirmViaDialog(info: { path: string; needsRestore: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    // A second open while one is parked declines the first — never two stacked prompts.
    openUserFileConfirmStore.get()?.resolve(false);
    openUserFileConfirmStore.set({ path: info.path, needsRestore: info.needsRestore, resolve });
  });
}

/** The dialog's decision handler. No-op when nothing is pending. */
export function resolveOpenUserFileConfirm(confirmed: boolean): void {
  const pending = openUserFileConfirmStore.get();
  if (pending === null) return;
  openUserFileConfirmStore.set(null);
  pending.resolve(confirmed);
}

/**
 * An opened APP BUNDLE (ADR-0063 §6): parse at the boundary, keep it on the shelf (the
 * double-click is the explicit act), and ask App.tsx to open the preview. A refusal
 * (too large, not a bundle, invalid, shelf full) reaches the user through the same
 * banner store a refused user-file import uses — never a silent nothing.
 */
export async function handleOpenedBundle(bytes: Uint8Array, path: string): Promise<void> {
  if (!looksLikeUserFilePath(path)) return;
  const text = new TextDecoder().decode(bytes);
  const result = await receiveSharedBundle(text, { source: 'file', persist: true });
  if (!result.ok) {
    const reason =
      result.reason === 'shelf-full'
        ? (result.detail ?? 'your shared shelf is full')
        : result.reason === 'too-large'
          ? 'that shared app file is larger than Snug accepts'
          : result.reason === 'not-a-bundle' || result.reason === 'not-json'
            ? 'that file is not a Snug user file or a shared app'
            : `that shared app file is not valid: ${result.detail ?? 'unknown issue'}`;
    openUserFileErrorStore.set(reason);
    return;
  }
  sharedInboxNoteStore.set(null);
  sharedOpenRequestStore.set(result.entry.bundleId);
}

/** The kind-dispatcher above both handlers — the ONE place a `.snug` file is told apart. */
export function dispatchOpenedSnugFile(
  bytes: Uint8Array,
  path: string,
  confirm: (info: { path: string; needsRestore: boolean }) => Promise<boolean>,
): Promise<void> {
  return sniffSnugFile(bytes) === 'app-bundle'
    ? handleOpenedBundle(bytes, path)
    : handleOpenedUserFile(bytes, path, confirm);
}

/** App boot: route the platform's open-file events through the sniff, the gates and the confirm dialog. Web: no seam, no-op. */
export function registerPlatformOpenFile(): void {
  getPlatform().onOpenSnugFile?.((bytes, path) => {
    openUserFileErrorStore.set(null);
    // The catch is load-bearing (finding 5): a rejected import here used to be an
    // unhandled promise rejection with no UI whatsoever — the button did nothing.
    void dispatchOpenedSnugFile(bytes, path, confirmViaDialog).catch((err: unknown) => {
      openUserFileErrorStore.set(err instanceof Error ? err.message : String(err));
    });
  });
}
