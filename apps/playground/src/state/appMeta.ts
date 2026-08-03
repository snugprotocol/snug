// appMeta.ts — announce-metadata overlay for the hub's gradient tiles, stored on the
// app row in the USER DB (was a localStorage map pre-portable-hub; abandoned per F13).
//
// When an app runs and announces itself (snug:app-announce), we remember its display
// metadata keyed by LIBRARY id — the host-assigned identity, never the app-claimed
// appId (display only, rule R4). Capability reveal: tiles upgrade once their app has
// self-described. The in-memory store mirrors the DB so views stay synchronous.

import { createStore, useStore } from './store.js';
import { getUserDb } from './userdb.js';

export interface AppMeta {
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
  /** Set once the app has been observed making db requests — gates the export button. */
  usesDb?: boolean;
}

export type AppMetaMap = Readonly<Record<string, AppMeta>>;

export const appMetaStore = createStore<AppMetaMap>({});

/** Boot/refresh hook: mirror app rows from the user DB into the synchronous store. */
export async function refreshAppMeta(): Promise<void> {
  const db = await getUserDb();
  const next: Record<string, AppMeta> = {};
  for (const app of db.listApps()) {
    next[app.appId] = {
      displayName: app.displayName,
      ...(app.description !== undefined ? { description: app.description } : {}),
      ...(app.iconEmoji !== undefined ? { iconEmoji: app.iconEmoji } : {}),
      ...(app.iconColor !== undefined ? { iconColor: app.iconColor } : {}),
      ...(app.usesDb ? { usesDb: true } : {}),
    };
  }
  appMetaStore.set(next);
}

/** Merge-record metadata for a library id: update the store now, the DB row async. */
export function recordAppMeta(libraryId: string, meta: Partial<AppMeta>): void {
  const current = appMetaStore.get();
  const existing: Partial<AppMeta> = current[libraryId] ?? {};
  const merged: AppMeta = {
    ...existing,
    ...meta,
    displayName: meta.displayName ?? existing.displayName ?? '',
  };
  appMetaStore.set({ ...current, [libraryId]: merged });
  void getUserDb().then((db) => {
    try {
      db.updateAppMeta(libraryId, merged);
    } catch {
      // Row may not exist yet (e.g. announce racing install) — the overlay still works.
    }
  });
}

export function getAppMeta(libraryId: string): AppMeta | undefined {
  return appMetaStore.get()[libraryId];
}

export function useAppMetaMap(): AppMetaMap {
  return useStore(appMetaStore);
}
