// Push-state sidecar (ADR-0009, F5): what the loop knows about the origin lives OUTSIDE
// the synced image, in `<file>.sync.json` next to the user DB in the same persistence
// backend. The image therefore never contains its own revision — persisting push-state
// cannot re-dirty the DB, which is what makes the content-hash gate converge.
//
// Loading is a total parser: absent, corrupt, or foreign bytes all collapse to `{}`
// (= "never pushed"), which fails safe — the loop then treats local state as having
// un-pushed changes and will surface divergence rather than auto-pull over it.
import { SYNC_SIDECAR_MAGIC, type PersistenceBackend } from '../persistence.js';

export interface SyncSidecarState {
  /** Origin revision our last successful push produced (the next push's baseRevision). */
  lastPushedRevision?: string;
  /** SHA-256 hex of the exact payload bytes last pushed — the content-hash gate. */
  lastPushedHash?: string;
  /** ISO timestamp of the last successful push or pull-merge (UI surface only). */
  lastSyncAt?: string;
}

export const sidecarFileFor = (file: string): string => `${file}.sync.json`;

const stringField = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export async function loadSidecar(backend: PersistenceBackend, file: string): Promise<SyncSidecarState> {
  let raw: Uint8Array | undefined;
  try {
    raw = await backend.load(sidecarFileFor(file));
  } catch {
    return {};
  }
  if (raw === undefined) return {};
  try {
    // Stored with the sidecar envelope (see saveSidecar); tolerate bare JSON too.
    const text = new TextDecoder().decode(raw);
    const json = text.startsWith(SYNC_SIDECAR_MAGIC) ? text.slice(SYNC_SIDECAR_MAGIC.length) : text;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const lastPushedRevision = stringField(parsed.lastPushedRevision);
    const lastPushedHash = stringField(parsed.lastPushedHash);
    const lastSyncAt = stringField(parsed.lastSyncAt);
    return {
      ...(lastPushedRevision !== undefined ? { lastPushedRevision } : {}),
      ...(lastPushedHash !== undefined ? { lastPushedHash } : {}),
      ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
    };
  } catch {
    return {};
  }
}

export async function saveSidecar(backend: PersistenceBackend, file: string, state: SyncSidecarState): Promise<void> {
  // The envelope magic is what lets the OPFS backend's completeness check recognize a
  // fully-written sidecar (its A/B-slot recovery treats first-bytes as the signal).
  await backend.save(sidecarFileFor(file), new TextEncoder().encode(SYNC_SIDECAR_MAGIC + JSON.stringify(state)));
}

/** SHA-256 hex of payload bytes via WebCrypto (browser and node ≥20 both provide it). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Carry a sync anchor across the `user.sqlite` → `user.snug` rename (AC21, ADR-0042).
 *
 * The sidecar name is derived from the db file name, so the rename orphans it — and
 * `loadSidecar` is a TOTAL parser that returns `{}` for a missing file, which the loop
 * cannot distinguish from "never pushed". The consequence is not cosmetic: with no
 * anchor, `reconcileOnStart` sees both sides as moved and emits a DIVERGENCE for every
 * existing sync user, on a file that never diverged. Resolving it the obvious way
 * ("use the origin copy") imports the remote image over local and discards anything
 * written since the last push.
 *
 * Deliberately best-effort and non-destructive:
 *   - the canonical anchor always wins, so re-running this (every boot does) can never
 *     replay a stale revision into a conditional write;
 *   - the legacy sidecar is left on disk, like the legacy db file;
 *   - a damaged legacy sidecar is skipped rather than propagated — an anchor is an
 *     optimisation, and the honest fallback is "we have not pushed yet", which costs
 *     one extra push and no correctness.
 */
export async function adoptLegacySidecar(
  backend: PersistenceBackend,
  canonicalFile: string,
  legacyFile: string,
): Promise<void> {
  const existing = await loadSidecar(backend, canonicalFile);
  if (existing.lastPushedRevision !== undefined || existing.lastPushedHash !== undefined) return;
  const legacy = await loadSidecar(backend, legacyFile);
  if (legacy.lastPushedRevision === undefined && legacy.lastPushedHash === undefined) return;
  await saveSidecar(backend, canonicalFile, legacy);
}
