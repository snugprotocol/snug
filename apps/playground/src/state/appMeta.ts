// appMeta.ts — announce-metadata overlay for the hub's gradient tiles.
//
// When an app runs and announces itself (snug:app-announce), we remember its
// display metadata (iconEmoji/iconColor/description) keyed by LIBRARY id — the
// host-assigned identity, never the app-claimed appId (display only, rule R4).
// Capability reveal: tiles upgrade once their app has self-described.

import { createStore, useStore } from './store.js';

export interface AppMeta {
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
  /** Set once the app has been observed making db requests — gates the export button. */
  usesDb?: boolean;
}

export type AppMetaMap = Readonly<Record<string, AppMeta>>;

const META_KEY = 'snug:app-meta';

function readAll(): AppMetaMap {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as AppMetaMap;
  } catch {
    return {};
  }
}

export const appMetaStore = createStore<AppMetaMap>(readAll());

/** Merge-record metadata for a library id and persist. */
export function recordAppMeta(libraryId: string, meta: Partial<AppMeta>): void {
  const current = appMetaStore.get();
  const existing: Partial<AppMeta> = current[libraryId] ?? {};
  const merged: AppMeta = {
    ...existing,
    ...meta,
    displayName: meta.displayName ?? existing.displayName ?? '',
  };
  const next: AppMetaMap = { ...current, [libraryId]: merged };
  appMetaStore.set(next);
  try {
    localStorage.setItem(META_KEY, JSON.stringify(next));
  } catch {
    /* persistence is best-effort — tiles still upgrade this session */
  }
}

export function getAppMeta(libraryId: string): AppMeta | undefined {
  return appMetaStore.get()[libraryId];
}

export function useAppMetaMap(): AppMetaMap {
  return useStore(appMetaStore);
}
