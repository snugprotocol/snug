// library.ts — where built apps live: the USER DB, in every mode (ADR-0007, F4 —
// client-authoritative). The old split (server artifact store / IndexedDB) is gone;
// pre-launch local data in those stores is abandoned (plan F13). createServerLibrary
// survives only as the subscription-mode artifact FETCH path — on the SSE artifact
// event the client pulls the HTML and writes it into the user DB (child 3).

import type { UserDb } from '@snugprotocol/db';

import { getUserDb } from './userdb.js';

export interface LibraryEntry {
  id: string;
  displayName: string;
  bytes: number;
  createdAt: string;
  /** Dedup identity for marketplace/starter installs (`starter:<folder>`); absent for built apps. */
  installSource?: string;
}

export interface LibraryStore {
  list(): Promise<LibraryEntry[]>;
  getHtml(id: string): Promise<string | undefined>;
  /** With `installSource`, save is find-or-create on that identity — never a duplicate (AC8). */
  save(html: string, displayName?: string, installSource?: string): Promise<LibraryEntry>;
  findByInstallSource(source: string): Promise<LibraryEntry | undefined>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

/** Naming rule shared with the server store: explicit name → <title> → fallback. */
export function deriveDisplayName(html: string, displayName?: string): string {
  const explicit = displayName?.trim() ?? '';
  const fromTitle = TITLE_RE.exec(html)?.[1]?.trim() ?? '';
  const name = explicit !== '' ? explicit : fromTitle !== '' ? fromTitle : 'untitled app';
  return name.slice(0, 80);
}

// ------------------------------------------------------------------ user DB library

export function createUserDbLibrary(getDb: () => Promise<UserDb> = getUserDb): LibraryStore {
  return {
    async list() {
      const db = await getDb();
      return db.listApps().map((app) => ({
        id: app.appId,
        displayName: app.displayName,
        bytes: db.getAppHtml(app.appId)?.length ?? 0,
        createdAt: app.createdAt,
        ...(app.installSource !== undefined ? { installSource: app.installSource } : {}),
      }));
    },
    async getHtml(id) {
      const db = await getDb();
      return db.getAppHtml(id);
    },
    async save(html, displayName, installSource) {
      const db = await getDb();
      const app = db.installApp({
        displayName: deriveDisplayName(html, displayName),
        html,
        ...(installSource !== undefined ? { installSource } : {}),
      });
      return {
        id: app.appId,
        displayName: app.displayName,
        bytes: html.length,
        createdAt: app.createdAt,
        ...(app.installSource !== undefined ? { installSource: app.installSource } : {}),
      };
    },
    async findByInstallSource(source) {
      const db = await getDb();
      const app = db.getAppByInstallSource(source);
      if (app === undefined) return undefined;
      return {
        id: app.appId,
        displayName: app.displayName,
        bytes: db.getAppHtml(app.appId)?.length ?? 0,
        createdAt: app.createdAt,
        installSource: source,
      };
    },
  };
}

let singleton: LibraryStore | undefined;

/** The page-wide library over the shared user DB. */
export function userLibrary(): LibraryStore {
  singleton ??= createUserDbLibrary();
  return singleton;
}

/** Test seam. */
export function resetLibraryForTests(): void {
  singleton = undefined;
}

// -------------------------------------------------- subscription-mode artifact fetch

export interface RemoteArtifactStore {
  getHtml(id: string): Promise<string | undefined>;
}

/** Reads one artifact from the hub's transient cache (GET /artifacts/:id). */
export function createServerArtifactFetch(fetchImpl?: FetchLike): RemoteArtifactStore {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async getHtml(id) {
      const response = await doFetch(`/artifacts/${encodeURIComponent(id)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`GET /artifacts/${id} failed (${response.status})`);
      return response.text();
    },
  };
}
