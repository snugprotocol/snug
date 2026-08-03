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
