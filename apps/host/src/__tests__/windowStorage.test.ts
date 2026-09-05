// windowStorage.test.ts — TASK-20260905-binding-a-artifacts AC4: the chat artifact's
// `window.storage` as a `PersistenceBackend`. The fake speaks the envelope shapes T1 S10
// measured verbatim (`set` echoes `{key, value}`, `list` answers `{keys, prefix, shared:false}`,
// `get` of a NEVER-written key THROWS a generic "Storage get failed: Unexpected response
// type"). Generation-numbered chunk sets with the manifest flipped LAST: a torn write leaves
// the previous file complete (lesson 2026-08-03); an unreadable manifest or a missing chunk
// is CORRUPT, never a pristine file (lesson 2026-08-22); absence is proven by `list()`.

import { openUserDb } from '@snugprotocol/db';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { WINDOW_STORAGE_KEY_PREFIX, WindowStorageTooLarge, createWindowStorageBackend, type WindowStorageLike } from '../storage/windowStorage.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

interface FakeStorage extends WindowStorageLike {
  data: Map<string, string>;
  calls: { op: string; key?: string }[];
  /** Throw on the n-th `set` (1-based) — a torn write. */
  failSetAt?: number;
}

function fakeStorage(): FakeStorage {
  const data = new Map<string, string>();
  const calls: FakeStorage['calls'] = [];
  let sets = 0;
  const storage: FakeStorage = {
    data,
    calls,
    async get(key) {
      calls.push({ op: 'get', key });
      if (!data.has(key)) throw new Error('Storage get failed: Unexpected response type');
      return { key, value: data.get(key) };
    },
    async set(key, value) {
      calls.push({ op: 'set', key });
      sets += 1;
      if (storage.failSetAt !== undefined && sets === storage.failSetAt) throw new Error('Storage set failed: quota');
      data.set(key, value);
      return { key, value };
    },
    async delete(key) {
      calls.push({ op: 'delete', key });
      data.delete(key);
      return { key };
    },
    async list(prefix) {
      calls.push({ op: 'list', key: prefix });
      return { keys: [...data.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)), prefix: prefix ?? '', shared: false };
    },
  };
  return storage;
}

const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * seed + 7) % 251);
const FILE = 'user.snug';

describe('createWindowStorageBackend', () => {
  it('reports its kind and answers `undefined` for a never-written file ONLY after list() proves the manifest absent', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage);
    expect(backend.kind).toBe('window-storage');
    expect(await backend.load(FILE)).toBeUndefined();
    expect(storage.calls.map((c) => c.op)).toEqual(['get', 'list']);
  });

  it('round-trips bytes through generation-numbered chunks and a manifest written LAST', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage, { chunkChars: 100 });
    const payload = bytes(500);
    await backend.save(FILE, payload);
    const keys = [...storage.data.keys()].sort();
    expect(keys[0]).toBe(`${WINDOW_STORAGE_KEY_PREFIX}${FILE}`);
    expect(keys.filter((k) => k.includes('/1/'))).toHaveLength(7); // 668 base64 chars / 100
    const sets = storage.calls.filter((c) => c.op === 'set').map((c) => c.key);
    expect(sets.at(-1)).toBe(`${WINDOW_STORAGE_KEY_PREFIX}${FILE}`);
    expect(await backend.load(FILE)).toEqual(payload);
  });

  it('a second save flips to the next generation and removes the old chunks afterwards', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage, { chunkChars: 100 });
    await backend.save(FILE, bytes(300, 1));
    await backend.save(FILE, bytes(300, 3));
    const keys = [...storage.data.keys()];
    expect(keys.some((k) => k.includes('/1/'))).toBe(false);
    expect(keys.filter((k) => k.includes('/2/')).length).toBeGreaterThan(0);
    expect(await backend.load(FILE)).toEqual(bytes(300, 3));
  });

  it('(N) a torn second save leaves the PREVIOUS file intact and readable', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage, { chunkChars: 100 });
    await backend.save(FILE, bytes(300, 1));
    const setsSoFar = storage.calls.filter((c) => c.op === 'set').length;
    storage.failSetAt = setsSoFar + 2; // the second chunk of generation 2
    await expect(backend.save(FILE, bytes(300, 3))).rejects.toThrow(/quota/);
    storage.failSetAt = undefined;
    expect(await createWindowStorageBackend(storage, { chunkChars: 100 }).load(FILE)).toEqual(bytes(300, 1));
  });

  it('(N) a manifest whose chunk is missing is CORRUPT — load throws, never a fresh file', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage, { chunkChars: 100 });
    await backend.save(FILE, bytes(300));
    const chunk = [...storage.data.keys()].find((k) => k.includes('/1/'))!;
    storage.data.delete(chunk);
    await expect(backend.load(FILE)).rejects.toThrow(/corrupt|missing/i);
  });

  it('(N) a manifest that exists but cannot be read (get throws, list still names it) is CORRUPT, never fresh', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage);
    await backend.save(FILE, bytes(10));
    const manifestKey = `${WINDOW_STORAGE_KEY_PREFIX}${FILE}`;
    const original = storage.get.bind(storage);
    storage.get = async (key) => {
      if (key === manifestKey) throw new Error('Storage get failed: Unexpected response type');
      return original(key);
    };
    await expect(backend.load(FILE)).rejects.toThrow(/corrupt|unreadable/i);
  });

  it('(N) a mismatched sha is CORRUPT', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage, { chunkChars: 100 });
    await backend.save(FILE, bytes(300));
    const chunk = [...storage.data.keys()].find((k) => k.includes('/1/'))!;
    storage.data.set(chunk, 'AAAA' + storage.data.get(chunk)!.slice(4));
    await expect(backend.load(FILE)).rejects.toThrow(/corrupt|sha/i);
  });

  it('(N) refuses a file over the text cap by name, writing nothing', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage, { maxTextChars: 1_000 });
    await expect(backend.save(FILE, bytes(2_000))).rejects.toBeInstanceOf(WindowStorageTooLarge);
    expect(storage.data.size).toBe(0);
  });

  it('accepts a bare value from get() as well as the {key, value} envelope', async () => {
    const storage = fakeStorage();
    const backend = createWindowStorageBackend(storage, { chunkChars: 100 });
    await backend.save(FILE, bytes(120));
    const original = storage.get.bind(storage);
    storage.get = async (key) => ((await original(key)) as { value: string }).value;
    expect(await backend.load(FILE)).toEqual(bytes(120));
  });

  it('survives a relaunch through the real user db: install, flush, reopen over the same storage (lesson 2026-08-19)', async () => {
    const storage = fakeStorage();
    const first = await openUserDb({ backend: createWindowStorageBackend(storage), locateWasm, persistDebounceMs: 1 });
    if (first.status !== 'ok') throw new Error(first.status);
    first.userDb.installApp({ displayName: 'Kept', html: '<!doctype html><html><body>kept</body></html>' });
    await first.userDb.flush();
    await first.userDb.close();
    const manifestSets = storage.calls.filter((c) => c.op === 'set' && c.key === `${WINDOW_STORAGE_KEY_PREFIX}${FILE}`).length;
    expect(manifestSets).toBeGreaterThanOrEqual(1);
    const second = await openUserDb({ backend: createWindowStorageBackend(storage), locateWasm, persistDebounceMs: 1 });
    if (second.status !== 'ok') throw new Error(second.status);
    expect(second.userDb.listApps().map((a) => a.displayName)).toEqual(['Kept']);
    expect(second.userDb.persistence).toBe('window-storage');
    await second.userDb.close();
  });
});
