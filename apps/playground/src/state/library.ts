// library.ts — where built apps live. Server mode reads the reference server's
// artifact store (GET /artifacts, GET /artifacts/:id); BYOK mode keeps artifact
// records in IndexedDB so the whole flow works with zero backend. Both sit behind
// one LibraryStore interface so the views never care which mode is active.

export interface LibraryEntry {
  id: string;
  displayName: string;
  bytes: number;
  createdAt: string;
}

export interface LibraryStore {
  list(): Promise<LibraryEntry[]>;
  getHtml(id: string): Promise<string | undefined>;
  /** BYOK only — server-mode artifacts are written server-side by the artifact tool. */
  save?(html: string, displayName?: string): Promise<LibraryEntry>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- server mode

export function createServerLibrary(fetchImpl?: FetchLike): LibraryStore {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async list() {
      const response = await doFetch('/artifacts');
      if (!response.ok) throw new Error(`GET /artifacts failed (${response.status})`);
      const body = (await response.json()) as { artifacts?: LibraryEntry[] };
      return Array.isArray(body.artifacts) ? body.artifacts : [];
    },
    async getHtml(id) {
      const response = await doFetch(`/artifacts/${encodeURIComponent(id)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`GET /artifacts/${id} failed (${response.status})`);
      return response.text();
    },
  };
}

// ------------------------------------------------------------------ byok mode

const IDB_NAME = 'snug-playground';
const IDB_STORE = 'artifacts';

interface StoredArtifact extends LibraryEntry {
  html: string;
}

const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

/** Mirrors the server store's naming rule: explicit name → <title> → fallback. */
export function deriveDisplayName(html: string, displayName?: string): string {
  const explicit = displayName?.trim() ?? '';
  const fromTitle = TITLE_RE.exec(html)?.[1]?.trim() ?? '';
  const name = explicit !== '' ? explicit : fromTitle !== '' ? fromTitle : 'untitled app';
  return name.slice(0, 80);
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function mintId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createByokLibrary(factory?: IDBFactory): LibraryStore & Required<Pick<LibraryStore, 'save'>> {
  const idb = factory ?? globalThis.indexedDB;
  const dbPromise = openDb(idb);

  async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await dbPromise;
    return requestToPromise(run(db.transaction(IDB_STORE, mode).objectStore(IDB_STORE)));
  }

  return {
    async list() {
      const all = await withStore<StoredArtifact[]>('readonly', (store) => store.getAll() as IDBRequest<StoredArtifact[]>);
      return all
        .map(({ id, displayName, bytes, createdAt }) => ({ id, displayName, bytes, createdAt }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async getHtml(id) {
      const record = await withStore<StoredArtifact | undefined>(
        'readonly',
        (store) => store.get(id) as IDBRequest<StoredArtifact | undefined>,
      );
      return record?.html;
    },
    async save(html, displayName) {
      const entry: LibraryEntry = {
        id: mintId(),
        displayName: deriveDisplayName(html, displayName),
        bytes: new TextEncoder().encode(html).byteLength,
        createdAt: new Date().toISOString(),
      };
      await withStore('readwrite', (store) => store.put({ ...entry, html } satisfies StoredArtifact));
      return entry;
    },
  };
}

// ------------------------------------------------------------------ selection

type ByokLibrary = LibraryStore & Required<Pick<LibraryStore, 'save'>>;

let byokSingleton: ByokLibrary | undefined;

/** The page-wide BYOK library (IndexedDB) — one instance so views share records. */
export function byokLibrary(): ByokLibrary {
  byokSingleton ??= createByokLibrary();
  return byokSingleton;
}

/** The active library for a mode. */
export function libraryForMode(mode: 'server' | 'byok'): LibraryStore {
  return mode === 'server' ? createServerLibrary() : byokLibrary();
}
