// copy.ts — platform-dependent DISCLOSURE copy (TASK-20260905-host-kit AC2/AC5). Pure, so
// every arm is pinned byte-for-byte. The host kit names where the working copy of the
// user's file actually lives — the rung the boot probe found WORKING, not the one that
// was present — because inside a foreign host that is the one fact the user cannot see.

import type { PersistenceKind } from '@snugprotocol/db';

/** One sentence naming the storage in use; `undefined` when the platform did not say. */
export function storageDisclosure(kind: PersistenceKind | undefined): string | undefined {
  switch (kind) {
    case 'opfs':
      return 'this copy of your file lives in this browser’s private storage for this page.';
    case 'idb':
      return 'this copy of your file lives in this browser’s IndexedDB for this page.';
    case 'memory':
      return 'this copy of your file lives in memory only — it is gone when the page closes, so export it to keep it.';
    case 'file':
      return 'this copy of your file lives on this computer’s disk.';
    default:
      return undefined;
  }
}
