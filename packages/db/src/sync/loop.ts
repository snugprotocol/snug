// The sync loop (ADR-0009): OPFS is authoritative, the origin is a replica. An interval
// pushes the exported image when — and only when — its SHA-256 differs from the last
// pushed payload (content-hash gate); pulls MERGE (local secrets always survive) and
// only happen automatically when local has no un-pushed changes; anything else is
// divergence, surfaced as an event and resolved exclusively by the explicit
// last-writer-wins actions applyRemote()/pushLocal().
//
// Amended by ADR-0076 (TASK-20261010-host-broker PR-5, D-PR5-8): the DATA stays a divergence
// the user resolves, but the ACCESS HISTORY survives either resolution and a STOP WINS on
// both sides. A pull carries this device's newer history lines into the origin's image and
// puts this device's revocations back over it (`importUserDb`'s `carryHistorySince`); a
// *keep this device's copy* first carries the origin's lines — every one this file lacks,
// whatever this device's last sync (G5-4) — and revocations into the local file
// (`carryFromImage`). A pull that moved anything holds a file the origin has not seen, so it
// anchors `SYNC_UNANCHORED_HASH` and the next tick pushes the merged history up.
//
// Deliberately absent: pagehide/visibility listeners. keepalive caps (~64 KiB) make a
// pagehide network push a lie for real images — pagehide flushes OPFS only (the UserDb
// does that itself); a local copy newer than the origin pushes via reconcileOnStart()
// on the next session.
import { USERDB_FILE, USERDB_LEGACY_FILE } from '@snugprotocol/protocol';
import type { PersistenceBackend } from '../persistence.js';
import {
  SYNC_ERROR_CODES,
  SyncProviderError,
  type SyncProvider,
  type SyncPullResult,
} from './provider.js';
import {
  SYNC_UNANCHORED_HASH,
  adoptLegacySidecar,
  loadSidecar,
  saveSidecar,
  sha256Hex,
  type SyncSidecarState,
} from './sidecar.js';

// The sentinel is sidecar state (a `lastPushedHash` value); the loop is what anchors it.
export { SYNC_UNANCHORED_HASH } from './sidecar.js';

/** The subset of UserDb the loop needs — structural, so tests can stub it. */
export interface SyncableUserDb {
  exportUserDb(opts?: { includeSecrets?: boolean }): Promise<Uint8Array>;
  /**
   * The loop reads ONE seat of the result, tolerantly: `history` (the carry's counts) decides
   * the anchor. Anything else in the import report — or no report at all — is ignored.
   */
  importUserDb(bytes: Uint8Array, options?: { trustedOrigin?: boolean; carryHistorySince?: string | null }): Promise<unknown>;
  /**
   * Carry a pulled image's access lines newer than `since` and its revocations into the live
   * file (PR-5, D-PR5-8) — *keep this device's copy* runs it before it pushes, with `since: null`
   * (G5-4). Never throws for an image it cannot open; the loop does not let it block the push
   * either way.
   */
  carryFromImage(bytes: Uint8Array, options: { since: string | null }): Promise<{ carried: number; restopped: number }>;
  listSecretKeys(): string[];
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
}

/**
 * Whether an import moved the history (D-PR5-8): its report's `history` seat names a line
 * carried, a stop put back, or a history row rewritten (G5-7 — a count-only merge leaves the
 * file holding a count the origin has not). Read tolerantly — a stub's report, an older report
 * with no seat, or none at all is "nothing moved", which keeps today's anchor.
 */
function historyMoved(report: unknown): boolean {
  if (typeof report !== 'object' || report === null) return false;
  const history: unknown = (report as { history?: unknown }).history;
  if (typeof history !== 'object' || history === null) return false;
  const { carried, restopped, rewritten } = history as { carried?: unknown; restopped?: unknown; rewritten?: unknown };
  const moved = (count: unknown): boolean => typeof count === 'number' && count > 0;
  return moved(carried) || moved(restopped) || moved(rewritten);
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
  /**
   * Seals the payload before it leaves the device (ADR-0043). Supplied only when the
   * user's file is protected; applied only to PERSONAL origins (D5) — a hub origin
   * keeps receiving the secrets-stripped plaintext it always did (D6), so the server
   * and the `/userdb` contract are untouched.
   *
   * Injected rather than derived here so the loop never holds a passphrase: it is the
   * same session sealer the write-back uses, closed over the already-unwrapped file
   * key. That also means it does NOT re-key, so a second device that learned the
   * secret once keeps opening every later copy (AC20).
   */
  sealForOrigin?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /**
   * Called right before a pull swaps the origin's image in (TASK-20261010-host-broker PR-5 Gate 5,
   * G5-11) — the auto pull and *use the origin copy* alike; a push swaps nothing and never calls it.
   * The host stops what would otherwise write into the file being replaced. It is the swap's
   * precondition: if it throws, nothing is swapped and the failure is an error event.
   */
  beforeSwap?: () => void;
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
  const state = async (): Promise<SyncSidecarState> => {
    if (sidecar !== undefined) return sidecar;
    // Carry an anchor across the user.sqlite -> user.snug rename BEFORE the first
    // read (AC21). Without it the loop sees "never pushed", concludes both sides
    // moved, and shows every existing sync user a divergence that never happened.
    if (file === USERDB_FILE) await adoptLegacySidecar(backend, file, USERDB_LEGACY_FILE);
    return (sidecar = await loadSidecar(backend, file));
  };

  /**
   * `lastSyncAt` is when this device and the origin last AGREED — the history carry's `since`
   * (D-PR5-8) — so it is the instant of the image they agreed on, `at`: a push's EXPORT instant,
   * a pull's instant before its import (G5-5), never the end of the network round trip (a line
   * written while a push was in flight is not in the image the origin took). An anchor on the
   * sentinel keeps the previous instant: the origin has not yet seen the lines that pull carried
   * in, and a divergence before the next push lands must still count them as new, or *use the
   * origin copy* would then lose them.
   */
  const anchor = async (revision: string, hash: string, at: string): Promise<void> => {
    const lastSyncAt = hash === SYNC_UNANCHORED_HASH ? (await state()).lastSyncAt : at;
    sidecar = { lastPushedRevision: revision, lastPushedHash: hash, ...(lastSyncAt !== undefined ? { lastSyncAt } : {}) };
    await saveSidecar(backend, file, sidecar);
  };

  /** The plaintext image a push is built from; secrets only for explicitly-allowing origins. */
  const exportPayload = (): Promise<Uint8Array> =>
    userDb.exportUserDb({ includeSecrets: options.includeSecrets === true && provider.info().secretsAllowed });

  /**
   * The ONE place that decides what actually crosses the wire, and what the change
   * gate is measured against. Four call sites used to build payloads independently;
   * with encryption in the mix, any one of them left unwrapped would either leak
   * plaintext to a personal origin or push ciphertext at a hub that rejects it. So
   * they all come through here (plan review S3).
   *
   * ORDER IS LOAD-BEARING:
   *   1. export  — strip + VACUUM happen on plaintext; they cannot run on ciphertext.
   *   2. hash    — over the PLAINTEXT. Ciphertext carries a fresh random IV every
   *                time, so hashing it would make every tick look changed and push
   *                the whole database forever.
   *   3. encrypt — personal origins only (D5). Hub origins keep receiving the
   *                secrets-stripped plaintext they always did (D6), so `apps/server`
   *                and the `/userdb` contract are untouched by this whole feature.
   *
   * `exportedAt` is taken BEFORE the export (G5-5): a push anchors it as `lastSyncAt`, so a line
   * written during the export or the upload is never counted as one the origin holds.
   */
  const payloadFor = async (): Promise<{ plaintextHash: string; wireBytes: Uint8Array; exportedAt: string }> => {
    const exportedAt = new Date().toISOString();
    const plain = await exportPayload();
    const plaintextHash = await sha256Hex(plain);
    const seal = options.sealForOrigin;
    if (seal === undefined || provider.info().kind === 'hub') {
      return { plaintextHash, wireBytes: plain, exportedAt };
    }
    return { plaintextHash, wireBytes: await seal(plain), exportedAt };
  };

  // ----------------------------------------------------------------- primitives

  /** Pushes and anchors on success (at the payload's export instant); a conflict becomes a divergence event, nothing more. */
  const push = async (bytes: Uint8Array, hash: string, baseRevision: string | undefined, exportedAt: string): Promise<void> => {
    const result = await provider.push(bytes, baseRevision);
    if (result.ok) {
      await anchor(result.revision, hash, exportedAt);
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

  /**
   * Pull is a merge, never a swap: local `snug_secrets` rows survive the import, and so do this
   * device's access-history lines newer than its last sync and its stops (D-PR5-8) — `null` on a
   * device that never synced, so every local line is a candidate. The host's `beforeSwap` runs
   * right before the import (G5-11), and the agreed instant is taken before both (G5-5).
   */
  const pullMerge = async (remote: SyncPullResult): Promise<void> => {
    const kept = userDb.listSecretKeys().map((key) => [key, userDb.getSecret(key)] as const);
    const since = (await state()).lastSyncAt ?? null;
    const importedAt = new Date().toISOString();
    options.beforeSwap?.();
    // Pulled from the user's OWN configured sync origin, so contracts survive (R-M2).
    const report = await userDb.importUserDb(remote.bytes, { trustedOrigin: true, carryHistorySince: since });
    for (const [key, value] of kept) {
      if (value !== undefined) userDb.setSecret(key, value); // local wins over any pulled row
    }
    // Anchor on the merged image so the next tick sees "unchanged" and stays quiet — unless the
    // pull carried history or put a stop back: then this file holds what the origin has not, and
    // the sentinel (never equal to a real hash) makes the next tick push it up.
    const hash = historyMoved(report) ? SYNC_UNANCHORED_HASH : (await payloadFor()).plaintextHash;
    await anchor(remote.revision, hash, importedAt);
    emit({ kind: 'pulled', revision: remote.revision });
  };

  // ------------------------------------------------------------------ operations

  const syncNow = (): Promise<void> =>
    serialized(async () => {
      const { plaintextHash, wireBytes, exportedAt } = await payloadFor();
      const known = await state();
      if (plaintextHash === known.lastPushedHash) return; // content-hash gate: nothing changed
      await push(wireBytes, plaintextHash, known.lastPushedRevision, exportedAt);
    });

  const reconcileOnStart = (): Promise<void> =>
    serialized(async () => {
      const remote = await provider.pull();
      const { plaintextHash: hash, wireBytes: bytes, exportedAt } = await payloadFor();
      const known = await state();
      if (remote === undefined) {
        // F1: a freshly provisioned empty origin never clobbers local — local goes up.
        await push(bytes, hash, undefined, exportedAt);
        return;
      }
      const localChanged = hash !== known.lastPushedHash;
      const remoteMoved = remote.revision !== known.lastPushedRevision;
      if (!remoteMoved) {
        // Origin still where we left it; catch up anything OPFS accumulated offline.
        if (localChanged) await push(bytes, hash, known.lastPushedRevision, exportedAt);
        return;
      }
      if (remote.migratedFromLegacy === true) {
        // The origin's bytes came from the PRE-RENAME path (ADR-0042). Its revision
        // belongs to that older object, so it must never be echoed back as a
        // conditional update — that targets an object the canonical path does not have
        // yet and 409s forever, wedging sync with no user-visible way out. Provision
        // the canonical path instead; the legacy copy stays where it is.
        await push(bytes, hash, undefined, exportedAt);
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
      if (remote !== undefined) {
        // This device's DATA wins, but the origin's access lines and its stops come along
        // (D-PR5-8) — carried into the local file BEFORE the payload is built, so they ride the
        // push. Never a reason not to push: the user's choice goes ahead whatever the carry does.
        // `since: null` (G5-4): an origin line older than THIS device's last sync may be one
        // another device wrote offline — filtering by this device's instant would delete it from
        // every copy. The natural-key match makes the carry idempotent; carried lines give way first.
        try {
          await userDb.carryFromImage(remote.bytes, { since: null });
        } catch {
          // an image the carry cannot use carries nothing
        }
      }
      const { plaintextHash, wireBytes, exportedAt } = await payloadFor();
      await push(wireBytes, plaintextHash, remote?.revision, exportedAt);
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
