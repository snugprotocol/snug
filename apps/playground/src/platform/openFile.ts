// openFile.ts — the `.snug` open-with routing seam (TASK-20260812 Decision 8, P0
// amendment 12). The (bytes, path) pair arrives from OS argv / open events, so it is
// UNTRUSTED until proven to be a real user file: flag-shaped strings, URL-shaped
// strings, wrong extensions, and magic-less bytes are all inert — no dialog, no side
// effect. Only sqlite-magic bytes reach the confirm, and only a confirmed open
// reaches `importUserFile` (which arms the F15 endpoint re-confirmation). No silent
// import, ever.

import { importUserFile } from '../state/sync.js';
import { createStore, type Store } from '../state/store.js';
import { getPlatform } from './platform.js';

// The import gate wants EXACTLY the sqlite magic — deliberately narrower than the db
// package's `looksComplete`, which also admits the sync-sidecar envelope.
const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0);

const hasSqliteMagic = (bytes: Uint8Array): boolean => {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
};

/**
 * A plausible user-file path: not flag-shaped, not URL-shaped, and named `.snug`
 * (desktop convention) or `.sqlite` (the web export's name).
 */
const looksLikeUserFilePath = (path: string): boolean =>
  !path.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path) && /\.(snug|sqlite)$/i.test(path);

/** Routes an opened file into the import flow — gates first, confirm second, F15 arms via importUserFile. */
export async function handleOpenedUserFile(
  bytes: Uint8Array,
  path: string,
  confirm: (info: { path: string }) => Promise<boolean>,
): Promise<void> {
  if (!looksLikeUserFilePath(path)) return;
  if (!hasSqliteMagic(bytes)) return;
  if (!(await confirm({ path }))) return;
  // Copy into a fresh ArrayBuffer-backed view — importUserFile wants an ArrayBuffer
  // and the incoming view may sit on a shared/offset buffer.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  await importUserFile({ arrayBuffer: () => Promise.resolve(buffer) });
}

export interface OpenUserFileConfirm {
  path: string;
  resolve: (confirmed: boolean) => void;
}

/** Pending replace-confirm the App-level dialog renders; null when nothing is parked. */
export const openUserFileConfirmStore: Store<OpenUserFileConfirm | null> = createStore<OpenUserFileConfirm | null>(
  null,
);

/** The dialog-backed confirm: parks until the user decides in OpenUserFileConfirmDialog. */
function confirmViaDialog(info: { path: string }): Promise<boolean> {
  return new Promise((resolve) => {
    // A second open while one is parked declines the first — never two stacked prompts.
    openUserFileConfirmStore.get()?.resolve(false);
    openUserFileConfirmStore.set({ path: info.path, resolve });
  });
}

/** The dialog's decision handler. No-op when nothing is pending. */
export function resolveOpenUserFileConfirm(confirmed: boolean): void {
  const pending = openUserFileConfirmStore.get();
  if (pending === null) return;
  openUserFileConfirmStore.set(null);
  pending.resolve(confirmed);
}

/** App boot: route the platform's open-file events through the gates + confirm dialog. Web: no seam, no-op. */
export function registerPlatformOpenFile(): void {
  getPlatform().onOpenUserFile?.((bytes, path) => {
    void handleOpenedUserFile(bytes, path, confirmViaDialog);
  });
}
