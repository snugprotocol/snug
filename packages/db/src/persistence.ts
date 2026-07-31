// Persistence backends behind one small interface (dependency injection via plain
// interfaces — no frameworks). Auto-detect order: OPFS → IndexedDB → in-memory.
// All backends store whole serialized SQLite files keyed by sanitized filename.

export type PersistenceKind = 'opfs' | 'idb' | 'memory';

export interface PersistenceBackend {
  readonly kind: PersistenceKind;
  /** Resolves undefined when the file does not exist yet. */
  load(file: string): Promise<Uint8Array | undefined>;
  save(file: string, bytes: Uint8Array): Promise<void>;
}

/** Directory (OPFS) / database (IndexedDB) name shared by all Snug namespaces. */
const STORE_NAME = 'snug-db';

// ---------------------------------------------------------------------------- OPFS

export function createOpfsBackend(): PersistenceBackend {
  let dirPromise: Promise<FileSystemDirectoryHandle> | undefined;
  const dir = (): Promise<FileSystemDirectoryHandle> =>
    (dirPromise ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(STORE_NAME, { create: true })));

  return {
    kind: 'opfs',
    async load(file) {
      try {
        const handle = await (await dir()).getFileHandle(file);
        const blob = await handle.getFile();
        return new Uint8Array(await blob.arrayBuffer());
      } catch (err) {
        if ((err as { name?: unknown } | null)?.name === 'NotFoundError') return undefined;
        throw err;
      }
    },
    async save(file, bytes) {
      const handle = await (await dir()).getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      // .slice() also pins the TS type to Uint8Array<ArrayBuffer> (write rejects SharedArrayBuffer views)
      await writable.write(bytes.slice());
      await writable.close();
    },
  };
}

// ------------------------------------------------------------------------ IndexedDB

export function createIdbBackend(): PersistenceBackend {
  const OBJECT_STORE = 'files';
  let dbPromise: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> =>
    (dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(STORE_NAME, 1);
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
export function detectPersistenceBackend(): PersistenceBackend {
  const nav = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator;
  if (typeof nav?.storage?.getDirectory === 'function') return createOpfsBackend();
  const idb = (globalThis as { indexedDB?: { open?: unknown } }).indexedDB;
  if (typeof idb?.open === 'function') return createIdbBackend();
  return createMemoryBackend();
}
