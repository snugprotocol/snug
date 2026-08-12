// Origin restore for the corrupt-open path (ADR-0009, F6): openUserDb quarantined the
// local bytes and the caller explicitly chose recovery; this pulls the origin image
// into the fresh DB. It NEVER pushes — after corruption the origin is the only good
// copy, and nothing auto-pushes post-recovery without user confirmation, so the
// provider's push is simply never invoked here (tests pin that).
import type { SyncProvider, SyncPullResult } from './provider.js';

/** The subset of UserDb recovery needs — matches what openFresh() hands back. */
export interface RestorableUserDb {
  importUserDb(bytes: Uint8Array, options?: { trustedOrigin?: boolean }): Promise<unknown>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type RestoreFromOriginResult<T extends RestorableUserDb> =
  | { status: 'restored'; userDb: T; revision: string }
  | {
      /** Nothing at the origin to restore from — the caller decides what happens next. */
      status: 'origin-empty';
    }
  | {
      /** Pull or import failed (errors-as-data); the quarantined `.bak` is untouched. */
      status: 'failed';
      message: string;
    };

export interface RestoreFromOriginOptions<T extends RestorableUserDb> {
  provider: SyncProvider;
  /** The corrupt open result's explicit-recovery constructor (OpenUserDbResult.openFresh). */
  openFresh(): Promise<T>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function restoreFromOrigin<T extends RestorableUserDb>(
  options: RestoreFromOriginOptions<T>,
): Promise<RestoreFromOriginResult<T>> {
  let remote: SyncPullResult | undefined;
  try {
    remote = await options.provider.pull();
  } catch (err) {
    return { status: 'failed', message: `origin pull failed: ${errorMessage(err)}` };
  }
  if (remote === undefined) return { status: 'origin-empty' };

  let fresh: T;
  try {
    fresh = await options.openFresh();
  } catch (err) {
    return { status: 'failed', message: `opening a fresh user DB failed: ${errorMessage(err)}` };
  }
  try {
    // The user's own origin image restored into a fresh hub — contracts survive (R-M2).
    await fresh.importUserDb(remote.bytes, { trustedOrigin: true });
    await fresh.flush(); // make the restore durable immediately
    return { status: 'restored', userDb: fresh, revision: remote.revision };
  } catch (err) {
    // The origin bytes were unusable: release the fresh handle; quarantine stays put.
    await fresh.close().catch(() => undefined);
    return { status: 'failed', message: `origin image could not be imported: ${errorMessage(err)}` };
  }
}
