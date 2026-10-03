// safeStorage.test.ts — TASK-20261003 K4: the storage globals are read through ONE guarded
// accessor. At an opaque origin (a chat artifact's `about:srcdoc` frame) each of them is a
// getter that THROWS, and the kit's entry read `sessionStorage` bare.
import { describe, expect, it } from 'vitest';

import { safeIndexedDB, safeLocalStorage, safeNavigatorStorage, safeSessionStorage, type StorageHost } from '../safeStorage.js';

/** A window whose storage getters all throw — what an opaque-origin document has. */
function opaqueOrigin(): StorageHost {
  const deny = (name: string) => ({
    get(): never {
      throw new DOMException(`Failed to read the '${name}' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.`, 'SecurityError');
    },
    enumerable: true,
  });
  const host = {} as StorageHost;
  Object.defineProperty(host, 'sessionStorage', deny('sessionStorage'));
  Object.defineProperty(host, 'localStorage', deny('localStorage'));
  Object.defineProperty(host, 'indexedDB', deny('indexedDB'));
  const navigator = {};
  Object.defineProperty(navigator, 'storage', deny('storage'));
  Object.defineProperty(host, 'navigator', { value: navigator });
  return host;
}

describe('the guarded accessors', () => {
  it('answer undefined — never throw — where every storage getter throws (an opaque origin)', () => {
    const host = opaqueOrigin();
    // The fixture is real: a bare read does throw.
    expect(() => host.sessionStorage).toThrow(/sandboxed/);
    expect(safeSessionStorage(host)).toBeUndefined();
    expect(safeLocalStorage(host)).toBeUndefined();
    expect(safeIndexedDB(host)).toBeUndefined();
    expect(safeNavigatorStorage(host)).toBeUndefined();
  });

  it('answer undefined where the global is absent or null', () => {
    expect(safeSessionStorage({})).toBeUndefined();
    expect(safeLocalStorage({ localStorage: null as unknown as Storage })).toBeUndefined();
    expect(safeIndexedDB({})).toBeUndefined();
    expect(safeNavigatorStorage({})).toBeUndefined();
    expect(safeNavigatorStorage({ navigator: {} })).toBeUndefined();
  });

  it('hand back the very object where there is one — a method called on it keeps its `this`', () => {
    const storage = { getDirectory: () => 'root' };
    const session = {} as Storage;
    const local = {} as Storage;
    const idb = {} as IDBFactory;
    const host: StorageHost = { sessionStorage: session, localStorage: local, indexedDB: idb, navigator: { storage } };
    expect(safeSessionStorage(host)).toBe(session);
    expect(safeLocalStorage(host)).toBe(local);
    expect(safeIndexedDB(host)).toBe(idb);
    expect(safeNavigatorStorage(host)).toBe(storage);
  });

  it('default to the page’s own globals', () => {
    // jsdom has both; the default argument must find them without being handed a window.
    expect(safeSessionStorage()).toBe(window.sessionStorage);
    expect(safeLocalStorage()).toBe(window.localStorage);
  });
});
