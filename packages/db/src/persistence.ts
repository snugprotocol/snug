// Persistence backends behind one small interface (dependency injection via plain
// interfaces — no frameworks). Auto-detect order: OPFS → IndexedDB → in-memory.
// All backends store whole serialized SQLite files keyed by sanitized filename.
import { CONTAINER } from '@snugprotocol/protocol';

export type PersistenceKind = 'opfs' | 'idb' | 'file' | 'memory';

/**
 * Envelope prefix for non-SQLite files stored through a backend (the sync sidecar).
 * The OPFS backend's crash-window recovery treats first-bytes as the completeness
 * signal, so every stored format must declare one — sidecar.ts prefixes this.
 */
export const SYNC_SIDECAR_MAGIC = 'SNUGSYNC1\n';

// Everything a backend stores declares its completeness in its first bytes: serialized
// SQLite databases by their own header, and the sync sidecar by the SYNC_SIDECAR_MAGIC
// envelope (saveSidecar prefixes it for exactly this reason — a bare-JSON sidecar would
// read back as never-complete and break the sync loop's content-hash gate on the
// backends real users get). Shared by the OPFS crash-window recovery and the desktop
// file backend — one definition, not two.
const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0);
const startsWithAscii = (bytes: Uint8Array, prefix: string): boolean => {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
};
/**
 * The third magic (ADR-0043): a protected user file. THIS LINE IS LOAD-BEARING. Every
 * storage path here treats first-bytes as the completeness signal, so without the
 * container magic listed, an encrypted file reads as never-complete: the OPFS A/B
 * recovery retries eight times and throws "exists but stayed unreadable", and the
 * desktop file backend refuses the load outright. A user who turned on protection
 * would be told their data was corrupt. Adding a format here is not optional — it is
 * the price of storing anything through these backends.
 */
export const looksComplete = (bytes: Uint8Array | undefined): bytes is Uint8Array =>
  bytes !== undefined &&
  (startsWithAscii(bytes, SQLITE_MAGIC) ||
    startsWithAscii(bytes, SYNC_SIDECAR_MAGIC) ||
    startsWithAscii(bytes, CONTAINER.MAGIC));

export interface PersistenceBackend {
  readonly kind: PersistenceKind;
  /** Resolves undefined when the file does not exist yet. */
  load(file: string): Promise<Uint8Array | undefined>;
  save(file: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Default directory (OPFS) / database (IndexedDB) name shared by all per-app namespaces.
 * The per-USER database passes its own distinct directory (USERDB_OPFS_DIR, plan F13)
 * so the two stores can never collide.
 */
const STORE_NAME = 'snug-db';

// ---------------------------------------------------------------------------- OPFS

export function createOpfsBackend(dirName: string = STORE_NAME): PersistenceBackend {
  let dirPromise: Promise<FileSystemDirectoryHandle> | undefined;
  const dir = (): Promise<FileSystemDirectoryHandle> =>
    (dirPromise ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(dirName, { create: true })));

  const readFile = async (directory: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | undefined> => {
    try {
      const handle = await directory.getFileHandle(name);
      const blob = await handle.getFile();
      return new Uint8Array(await blob.arrayBuffer());
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === 'NotFoundError') return undefined;
      throw err;
    }
  };

  // ---- crash-safe A/B slots -----------------------------------------------------
  // A page being torn down mid-write (pagehide flush) must never destroy committed
  // state. Two things proved unreliable under Chromium teardown in real-browser e2e:
  // rename-with-overwrite (destination observed deleted with the rename pending) and
  // directory iteration (observed returning EMPTY while same-directory writes were in
  // flight). So this backend uses neither: saves alternate between two fixed slot
  // files and then update a one-byte pointer file; loads use only direct fixed-name
  // lookups — pointer's slot if its bytes are complete, else the newest complete slot
  // by modification time. Every crash window leaves at least one complete slot; the
  // only possible loss is the in-flight write itself (the documented debounce
  // trade-off).
  const SLOTS = ['a', 'b'] as const;
  type Slot = (typeof SLOTS)[0] | (typeof SLOTS)[1];
  const slotName = (file: string, slot: Slot): string => `${file}.slot-${slot}`;
  const ptrName = (file: string): string => `${file}.ptr`;
  const lastSlot = new Map<string, Slot>();

  type SlotRead =
    | { status: 'ok'; bytes: Uint8Array; mtime: number }
    | { status: 'absent' } // clean NotFound — genuinely no such file
    | { status: 'invalid' } // readable but incomplete (mid-write or torn)
    | { status: 'error' }; // transient failure (reads can fail while another page's writes settle)

  const isNotFound = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'NotFoundError';

  const readSlot = async (directory: FileSystemDirectoryHandle, file: string, slot: Slot): Promise<SlotRead> => {
    try {
      const handle = await directory.getFileHandle(slotName(file, slot));
      const blob = await handle.getFile();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return looksComplete(bytes) ? { status: 'ok', bytes, mtime: blob.lastModified } : { status: 'invalid' };
    } catch (err) {
      return isNotFound(err) ? { status: 'absent' } : { status: 'error' };
    }
  };

  type PtrRead = { status: 'ok'; slot: Slot } | { status: 'absent' } | { status: 'invalid' } | { status: 'error' };

  const readPtr = async (directory: FileSystemDirectoryHandle, file: string): Promise<PtrRead> => {
    try {
      const handle = await directory.getFileHandle(ptrName(file));
      const text = (await (await handle.getFile()).text()).trim();
      return text === 'a' || text === 'b' ? { status: 'ok', slot: text } : { status: 'invalid' };
    } catch (err) {
      return isNotFound(err) ? { status: 'absent' } : { status: 'error' };
    }
  };

  const writeAll = async (directory: FileSystemDirectoryHandle, name: string, data: Uint8Array): Promise<void> => {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data.slice());
    await writable.close();
  };

  const LOAD_ATTEMPTS = 8;
  const LOAD_RETRY_MS = 150;
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    kind: 'opfs',
    async load(file) {
      const directory = await dir();
      for (let attempt = 1; ; attempt++) {
        const ptr = await readPtr(directory, file);
        if (ptr.status === 'ok') {
          const hit = await readSlot(directory, file, ptr.slot);
          if (hit.status === 'ok') {
            lastSlot.set(file, ptr.slot);
            return hit.bytes;
          }
        }
        // Pointer missing/garbage/stale (crashed mid-save): newest complete slot wins.
        const a = await readSlot(directory, file, 'a');
        const b = await readSlot(directory, file, 'b');
        if (a.status === 'ok' && (b.status !== 'ok' || a.mtime >= b.mtime)) {
          lastSlot.set(file, 'a');
          return a.bytes;
        }
        if (b.status === 'ok') {
          lastSlot.set(file, 'b');
          return b.bytes;
        }
        // Nothing complete. Cleanly absent everywhere → genuinely fresh (or legacy).
        const cleanlyFresh = ptr.status === 'absent' && a.status === 'absent' && b.status === 'absent';
        if (cleanlyFresh) {
          // Legacy layouts (pre-slot): a complete temp beats the plain file.
          const temp = await readFile(directory, `${file}.tmp`);
          if (looksComplete(temp)) return temp;
          return readFile(directory, file);
        }
        // Evidence of prior state that is momentarily unreadable — reads fail
        // transiently while another (dying) page's writes settle. Retry briefly;
        // NEVER degrade to a silent fresh database.
        if (attempt >= LOAD_ATTEMPTS) {
          throw new Error(`persisted state for "${file}" exists but stayed unreadable after ${attempt} attempts`);
        }
        await wait(LOAD_RETRY_MS);
      }
    },
    async save(file, bytes) {
      const directory = await dir();
      let previous = lastSlot.get(file);
      if (previous === undefined) {
        const ptr = await readPtr(directory, file);
        previous = ptr.status === 'ok' ? ptr.slot : 'b'; // default target: slot a
      }
      const target: Slot = previous === 'a' ? 'b' : 'a';
      await writeAll(directory, slotName(file, target), bytes);
      // Commit point: flip the pointer only after the slot fully closed. A partial
      // pointer write degrades to the mtime fallback above, which picks this slot.
      await writeAll(directory, ptrName(file), new TextEncoder().encode(target));
      lastSlot.set(file, target);
    },
  };
}

// ------------------------------------------------------------------------ IndexedDB

export function createIdbBackend(dirName: string = STORE_NAME): PersistenceBackend {
  const OBJECT_STORE = 'files';
  let dbPromise: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> =>
    (dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(dirName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(OBJECT_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    }));

  const inTransaction = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
    });
  };

  return {
    kind: 'idb',
    async load(file) {
      const stored = await inTransaction<unknown>('readonly', (store) => store.get(file) as IDBRequest<unknown>);
      if (stored === undefined || stored === null) return undefined;
      if (stored instanceof Uint8Array) return stored;
      if (stored instanceof ArrayBuffer) return new Uint8Array(stored);
      return undefined; // foreign value under our key — treat as absent
    },
    async save(file, bytes) {
      await inTransaction('readwrite', (store) => store.put(bytes, file));
    },
  };
}

// -------------------------------------------------------------------------- memory

export interface MemoryBackend extends PersistenceBackend {
  readonly kind: 'memory';
  /** Exposed for tests: sanitized filename → stored bytes. */
  readonly files: Map<string, Uint8Array>;
}

export function createMemoryBackend(): MemoryBackend {
  const files = new Map<string, Uint8Array>();
  return {
    kind: 'memory',
    files,
    async load(file) {
      return files.get(file);
    },
    async save(file, bytes) {
      files.set(file, bytes.slice());
    },
  };
}

// -------------------------------------------------------------------------- detect

/**
 * Feature-detects the best available backend. Detection is synchronous and
 * presence-based (matching how the driver surfaces `persistence` immediately);
 * runtime failures of a detected backend surface as DbDriverResult errors.
 */
export function detectPersistenceBackend(dirName: string = STORE_NAME): PersistenceBackend {
  const nav = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator;
  if (typeof nav?.storage?.getDirectory === 'function') return createOpfsBackend(dirName);
  const idb = (globalThis as { indexedDB?: { open?: unknown } }).indexedDB;
  if (typeof idb?.open === 'function') return createIdbBackend(dirName);
  return createMemoryBackend();
}
