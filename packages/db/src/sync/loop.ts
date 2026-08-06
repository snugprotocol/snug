// The sync loop (ADR-0009): OPFS is authoritative, the origin is a replica. An interval
// pushes the exported image when — and only when — its SHA-256 differs from the last
// pushed payload (content-hash gate); pulls MERGE (local secrets always survive) and
// only happen automatically when local has no un-pushed changes; anything else is
// divergence, surfaced as an event and resolved exclusively by the explicit
// last-writer-wins actions applyRemote()/pushLocal().
//
// Deliberately absent: pagehide/visibility listeners. keepalive caps (~64 KiB) make a
// pagehide network push a lie for real images — pagehide flushes OPFS only (the UserDb
// does that itself); a local copy newer than the origin pushes via reconcileOnStart()
// on the next session.
import { USERDB_FILE } from '@snugprotocol/protocol';
import type { PersistenceBackend } from '../persistence.js';
import {
  SYNC_ERROR_CODES,
  SyncProviderError,
  type SyncProvider,
  type SyncPullResult,
} from './provider.js';
import { loadSidecar, saveSidecar, sha256Hex, type SyncSidecarState } from './sidecar.js';

/** The subset of UserDb the loop needs — structural, so tests can stub it. */
export interface SyncableUserDb {
  exportUserDb(opts?: { includeSecrets?: boolean }): Promise<Uint8Array>;
  /** Result (the import report) is deliberately ignored by the loop. */
  importUserDb(bytes: Uint8Array): Promise<unknown>;
  listSecretKeys(): string[];
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
}

export type SyncEvent =
  | { kind: 'pushed'; revision: string }
  | { kind: 'pulled'; revision: string }
  /**
   * The origin refused our conditional write. `remoteRevision` is absent when the origin
   * could not name one — in practice the origin holds no image (its row was wiped) while
   * our sidecar still remembers a revision. Either way: surface only, resolve explicitly.
   */
  | { kind: 'divergence'; remoteRevision?: string }
  | { kind: 'error'; code: string; message: string };

export interface CreateSyncLoopOptions {
  userDb: SyncableUserDb;
  provider: SyncProvider;
  /** Backend holding the push-state sidecar — the same one that stores the user DB. */
  backend: PersistenceBackend;
  /** User-DB file name the sidecar sits next to. Default: the spec constant. */
  file?: string;
  /** Interval-push cadence. Default: 30 s (decoupled from the OPFS write debounce). */
  intervalMs?: number;
  /**
   * Include `snug_secrets` in push payloads. Default false; honored ONLY when the
   * provider's info() allows secrets — a hub origin strips secrets regardless.
   */
  includeSecrets?: boolean;
  onEvent?: (event: SyncEvent) => void;
}

export interface SyncLoop {
  /** Starts the interval pushes. Idempotent. */
  start(): void;
  /** Clears the interval timer. Never fires a farewell network push. */
  stop(): void;
  /** One hash-gated push attempt now (what an interval tick runs). */
  syncNow(): Promise<void>;
  /** Session-start reconcile: provision-up, catch-up push, pull-merge, or divergence. */
  reconcileOnStart(): Promise<void>;
  /** Explicit LWW pull: replace local with the origin image, keeping local secrets. */
  applyRemote(): Promise<void>;
  /** Explicit LWW push: overwrite the origin with the local image. */
  pushLocal(): Promise<void>;
}

const DEFAULT_SYNC_INTERVAL_MS = 30_000;

export function createSyncLoop(options: CreateSyncLoopOptions): SyncLoop {
  const { userDb, provider, backend, onEvent } = options;
  const file = options.file ?? USERDB_FILE;
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;

  // ------------------------------------------------------------- events & failures

  const emit = (event: SyncEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // a broken listener must not take down the loop
    }
  };

  const emitError = (err: unknown): void => {
    if (err instanceof SyncProviderError) {
      emit({ kind: 'error', code: err.code, message: err.message });
      return;
    }
    emit({
      kind: 'error',
      code: SYNC_ERROR_CODES.INTERNAL,
      message: err instanceof Error ? err.message : String(err),
    });
  };

  // Serialize all operations: an interval tick can never interleave with an explicit
  // action mid-import. Failures become error events, so the chain itself never rejects.
  let chain: Promise<void> = Promise.resolve();
  const serialized = (op: () => Promise<void>): Promise<void> => {
    const run = chain.then(() => op().catch(emitError));
    chain = run;
    return run;
  };

  // ------------------------------------------------------------ sidecar & payload

  // Cached under the single-writer rule (F12): this loop is the only sidecar writer.
  let sidecar: SyncSidecarState | undefined;
  const state = async (): Promise<SyncSidecarState> => (sidecar ??= await loadSidecar(backend, file));

  const anchor = async (revision: string, hash: string): Promise<void> => {
    sidecar = { lastPushedRevision: revision, lastPushedHash: hash, lastSyncAt: new Date().toISOString() };
    await saveSidecar(backend, file, sidecar);
  };

  /** The exact bytes a push would send; secrets only for explicitly-allowing origins. */
  const exportPayload = (): Promise<Uint8Array> =>
    userDb.exportUserDb({ includeSecrets: options.includeSecrets === true && provider.info().secretsAllowed });

  // ----------------------------------------------------------------- primitives

  /** Pushes and anchors on success; a conflict becomes a divergence event, nothing more. */
  const push = async (bytes: Uint8Array, hash: string, baseRevision: string | undefined): Promise<void> => {
    const result = await provider.push(bytes, baseRevision);
    if (result.ok) {
      await anchor(result.revision, hash);
      emit({ kind: 'pushed', revision: result.revision });
      return;
    }
    // ADR-0009: a conflict is surfaced, never auto-retried and never auto-merged. The
    // sidecar is deliberately NOT re-anchored, so nothing here can become a silent write.
    emit({
      kind: 'divergence',
      ...(result.remoteRevision !== undefined ? { remoteRevision: result.remoteRevision } : {}),
    });
  };

  /** Pull is a merge, never a swap: local `snug_secrets` rows survive the import. */
  const pullMerge = async (remote: SyncPullResult): Promise<void> => {
    const kept = userDb.listSecretKeys().map((key) => [key, userDb.getSecret(key)] as const);
    await userDb.importUserDb(remote.bytes);
    for (const [key, value] of kept) {
      if (value !== undefined) userDb.setSecret(key, value); // local wins over any pulled row
    }
    // Anchor on the merged image so the next tick sees "unchanged" and stays quiet.
    await anchor(remote.revision, await sha256Hex(await exportPayload()));
    emit({ kind: 'pulled', revision: remote.revision });
  };

  // ------------------------------------------------------------------ operations

  const syncNow = (): Promise<void> =>
    serialized(async () => {
      const bytes = await exportPayload();
      const hash = await sha256Hex(bytes);
      const known = await state();
      if (hash === known.lastPushedHash) return; // content-hash gate: nothing changed
      await push(bytes, hash, known.lastPushedRevision);
    });

  const reconcileOnStart = (): Promise<void> =>
    serialized(async () => {
      const remote = await provider.pull();
      const bytes = await exportPayload();
      const hash = await sha256Hex(bytes);
      const known = await state();
      if (remote === undefined) {
        // F1: a freshly provisioned empty origin never clobbers local — local goes up.
        await push(bytes, hash, undefined);
        return;
      }
      const localChanged = hash !== known.lastPushedHash;
      const remoteMoved = remote.revision !== known.lastPushedRevision;
      if (!remoteMoved) {
        // Origin still where we left it; catch up anything OPFS accumulated offline.
        if (localChanged) await push(bytes, hash, known.lastPushedRevision);
        return;
      }
      if (!localChanged) {
        // Origin moved, local pristine since the last push — safe to pull-merge.
        await pullMerge(remote);
        return;
      }
      // Both sides moved: surface only. LWW is an explicit user action, never automatic.
      emit({ kind: 'divergence', remoteRevision: remote.revision });
    });

  const applyRemote = (): Promise<void> =>
    serialized(async () => {
      const remote = await provider.pull();
      if (remote === undefined) {
        emit({ kind: 'error', code: SYNC_ERROR_CODES.ORIGIN_EMPTY, message: 'origin holds no image to apply' });
        return;
      }
      await pullMerge(remote);
    });

  const pushLocal = (): Promise<void> =>
    serialized(async () => {
      // Explicit local-wins: rebase onto whatever revision the origin holds RIGHT NOW,
      // so the conditional write replaces it (or provisions an empty origin).
      const remote = await provider.pull();
      const bytes = await exportPayload();
      await push(bytes, await sha256Hex(bytes), remote?.revision);
    });

  return {
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void syncNow(); // serialized + self-catching: ticks never overlap or reject
      }, intervalMs);
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    syncNow,
    reconcileOnStart,
    applyRemote,
    pushLocal,
  };
}
