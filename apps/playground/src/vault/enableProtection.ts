// enableProtection.ts — turning protection ON for an existing file (TASK-20260820, AC13).
//
// The conversion itself is deliberately boring: export the current database, seal it,
// write it back through the SAME atomic write every ordinary save uses. There is no
// bespoke second atomicity mechanism here — the desktop path is temp+fsync+rename in
// Rust and the OPFS path is the A/B slot commit, and both already guarantee that a
// crash mid-write leaves the PREVIOUS complete file in place. Re-implementing that
// here would mean two contracts to keep true instead of one (file-backend.ts:14).
//
// So a crash during conversion leaves the user with their unprotected file, intact.
// That is the right failure: annoying, recoverable, and never a lost database.
import { generateRecoveryKey } from '@snugprotocol/db';

import { resyncAfterProtectionChange } from '../state/sync.js';
import { getUserDb } from '../state/userdb.js';

export interface ProtectionResult {
  /** Shown ONCE. Never stored, never recoverable — see ProtectSetupFlow. */
  recoveryKey: string;
}

export async function enableProtection(passphrase: string): Promise<ProtectionResult> {
  const db = await getUserDb();
  const recoveryKey = generateRecoveryKey();
  // The UserDb owns the conversion: it already holds the backend and the atomic-write
  // contract, and keeping it there means there is no public "overwrite the whole file"
  // seam for some future caller to point at a user's database.
  await db.protect({ passphrase, recoveryKey });
  // The sync loop captured its sealer when it started, so a loop already running would
  // keep pushing PLAINTEXT to the user's own Dropbox after they turned protection on
  // (diff review D-2). Rebuild it.
  await resyncAfterProtectionChange();
  return { recoveryKey };
}

/** Turn protection OFF. Re-wires sync for the same reason `enableProtection` does. */
export async function disableProtection(): Promise<void> {
  const db = await getUserDb();
  await db.protect(undefined);
  await resyncAfterProtectionChange();
}
