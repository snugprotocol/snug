// safeStorage.ts — the ONE guarded accessor for the browser's storage globals (K4).
//
// `window.sessionStorage`, `window.localStorage`, `window.indexedDB` and `navigator.storage`
// are GETTERS, and where a page has no storage they do not answer `undefined` — they THROW.
// That is every document at an opaque origin (a chat artifact is an `about:srcdoc` frame,
// origin `null`: reading `sessionStorage` there is a SecurityError) and Safari with
// third-party storage denied. The kit's entry read `sessionStorage` bare while building an
// argument list, so at a chat origin the page would have died before its probe ran (found
// 2026-10-03). Three modules had each grown their own try/catch around one global and a
// fourth had none.
//
// Reading the global is the only thing guarded here. What a caller then DOES with a storage
// it was handed can still throw (a quota, a private window) — those calls keep their own
// guards, because only the caller knows what "could not remember" should mean for it.

/** The slice of `window` these read. Every seat optional: a fake window names only what it has. */
export interface StorageHost {
  sessionStorage?: Storage | undefined;
  localStorage?: Storage | undefined;
  indexedDB?: IDBFactory | undefined;
  navigator?: { storage?: { getDirectory?: unknown } | undefined } | undefined;
}

const guarded = <T>(read: () => T | null | undefined): T | undefined => {
  try {
    return read() ?? undefined;
  } catch {
    return undefined;
  }
};

/** `globalThis` where there is one to read (the page), nothing under a bare Node import. */
const page = (): StorageHost => globalThis as unknown as StorageHost;

export const safeSessionStorage = (host: StorageHost = page()): Storage | undefined => guarded(() => host.sessionStorage);
export const safeLocalStorage = (host: StorageHost = page()): Storage | undefined => guarded(() => host.localStorage);
export const safeIndexedDB = (host: StorageHost = page()): IDBFactory | undefined => guarded(() => host.indexedDB);
/** `navigator.storage` — the OPFS door. Handed back whole: `getDirectory` must be called AS ITS METHOD. */
export const safeNavigatorStorage = (host: StorageHost = page()): { getDirectory?: unknown } | undefined => guarded(() => host.navigator?.storage);
