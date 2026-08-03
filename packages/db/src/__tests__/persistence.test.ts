// Persistence behavior (task AC-5 + namespace sanitization): backend auto-detect
// (OPFS → IndexedDB → memory with persistence:'none' surfaced), debounced write-back
// with flush(), reload restore, and filename sanitization of host-assigned namespaces.
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDbDriver,
  createMemoryBackend,
  detectPersistenceBackend,
  namespaceToFileName,
  type PersistenceBackend,
} from '../index.js';
import { execFrame, hasSqliteMagic, kvGetFrame, kvSetFrame, locateWasm } from './helpers.js';
import { fakeOpfs } from './opfsFake.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubNavigator = (storage: unknown): void => {
  vi.stubGlobal('navigator', { storage });
};

describe('backend auto-detect (AC-5)', () => {
  it('uses OPFS when navigator.storage.getDirectory exists', async () => {
    const opfs = fakeOpfs();
    stubNavigator(opfs.storage);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const d = createDbDriver({ locateWasm, persistDebounceMs: 1 });
    expect(d.persistence).toBe('opfs');
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.flush();
    // A/B slot layout: one complete slot file + the one-byte pointer file.
    const slotPaths = [...opfs.files.keys()].filter((p) => p.includes('.slot-'));
    expect(slotPaths).toHaveLength(1);
    expect(hasSqliteMagic(opfs.files.get(slotPaths[0] as string) as Uint8Array)).toBe(true);
    expect([...opfs.files.keys()].some((p) => p.endsWith('.ptr'))).toBe(true);

    // reload: a NEW driver over the same (stubbed) OPFS restores the schema
    const reloaded = createDbDriver({ locateWasm });
    const probe = await reloaded.handle('app', execFrame('INSERT INTO t (x) VALUES (1)'));
    expect(probe.ok).toBe(true);
  });

  it('a crashed write leaves a partial slot — load falls back to the pointed complete slot', async () => {
    const opfs = fakeOpfs();
    stubNavigator(opfs.storage);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const d = createDbDriver({ locateWasm, persistDebounceMs: 1 });
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.flush();
    // Teardown killed the NEXT save mid-write: the other slot holds truncated garbage
    // and the pointer still names the last complete slot.
    const slotPath = [...opfs.files.keys()].find((p) => p.includes('.slot-')) as string;
    const otherSlot = slotPath.endsWith('.slot-a') ? slotPath.replace(/a$/, 'b') : slotPath.replace(/b$/, 'a');
    opfs.files.set(otherSlot, new Uint8Array(7));

    const reloaded = createDbDriver({ locateWasm });
    const probe = await reloaded.handle('app', execFrame('INSERT INTO t (x) VALUES (1)'));
    expect(probe.ok).toBe(true); // schema restored from the complete slot
  });

  it('a crashed pointer write degrades to newest-complete-slot by mtime', async () => {
    const opfs = fakeOpfs();
    stubNavigator(opfs.storage);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const d = createDbDriver({ locateWasm, persistDebounceMs: 1 });
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.flush();
    // Pointer bytes torn mid-write: garbage content, but the slot itself is complete.
    const ptrPath = [...opfs.files.keys()].find((p) => p.endsWith('.ptr')) as string;
    opfs.files.set(ptrPath, new Uint8Array([0x00, 0xff]));

    const reloaded = createDbDriver({ locateWasm });
    const probe = await reloaded.handle('app', execFrame('INSERT INTO t (x) VALUES (1)'));
    expect(probe.ok).toBe(true);
  });

  it('falls back to IndexedDB when OPFS is absent and restores across driver instances', async () => {
    stubNavigator(undefined);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const d = createDbDriver({ locateWasm, persistDebounceMs: 1 });
    expect(d.persistence).toBe('idb');
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.handle('app', execFrame('INSERT INTO t (x) VALUES (7)'));
    await d.handle('app', kvSetFrame('k', 'v'));
    await d.flush();

    const reloaded = createDbDriver({ locateWasm });
    expect(reloaded.persistence).toBe('idb');
    const rows = await reloaded.handle('app', execFrame('SELECT x FROM t'));
    expect(rows).toMatchObject({ ok: true, rows: [[7]] });
    const kv = await reloaded.handle('app', kvGetFrame('k'));
    expect(kv).toMatchObject({ ok: true, value: 'v' });
  });

  it('surfaces persistence:"none" when neither OPFS nor IndexedDB exists (memory only)', async () => {
    stubNavigator(undefined);
    vi.stubGlobal('indexedDB', undefined);
    const d = createDbDriver({ locateWasm });
    expect(d.persistence).toBe('none');
    expect(detectPersistenceBackend().kind).toBe('memory');
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.flush();
    // memory persistence is per-driver: a new driver starts empty
    const reloaded = createDbDriver({ locateWasm });
    const probe = await reloaded.handle('app', execFrame('SELECT * FROM t'));
    expect(probe.ok).toBe(false);
  });
});

describe('debounced write-back + flush()', () => {
  it('coalesces rapid mutations into one save and flush() forces the write', async () => {
    const backend = createMemoryBackend();
    const save = vi.spyOn(backend, 'save');
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 5_000 });
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.handle('app', execFrame('INSERT INTO t (x) VALUES (1)'));
    await d.handle('app', kvSetFrame('k', 1));
    expect(save).not.toHaveBeenCalled(); // still inside the debounce window
    await d.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await d.flush();
    expect(save).toHaveBeenCalledTimes(1); // nothing dirty — no extra write
  });

  it('persists on its own after the debounce interval elapses', async () => {
    const backend = createMemoryBackend();
    const save = vi.spyOn(backend, 'save');
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 10 });
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reload with the same injected backend restores state (AC-5 reload)', async () => {
    const backend = createMemoryBackend();
    const d = createDbDriver({ backend, locateWasm });
    await d.handle('app', kvSetFrame('resume', { level: 3 }));
    await d.flush();
    const reloaded = createDbDriver({ backend, locateWasm });
    const kv = await reloaded.handle('app', kvGetFrame('resume'));
    expect(kv).toMatchObject({ ok: true, value: { level: 3 } });
  });
});

describe('corrupt persisted bytes (Gate-5 finding 2)', () => {
  it('fails open with a fresh db AND surfaces the recovery via onRecoverableError', async () => {
    const backend = createMemoryBackend();
    backend.files.set(namespaceToFileName('app'), new TextEncoder().encode('definitely-not-sqlite-'.repeat(8)));
    const events: unknown[] = [];
    const d = createDbDriver({ backend, locateWasm, onRecoverableError: (event) => events.push(event) });

    const result = await d.handle('app', execFrame('CREATE TABLE t (x)'));
    expect(result.ok).toBe(true); // fresh db — the namespace is not bricked
    expect(events).toEqual([
      { namespace: 'app', kind: 'corrupt-persisted-bytes', message: expect.any(String) },
    ]);

    // one occurrence → one callback: further ops on the (cached) namespace stay silent
    await d.handle('app', execFrame('INSERT INTO t (x) VALUES (1)'));
    expect(events).toHaveLength(1);
  });

  it('pristine bytes never trigger onRecoverableError', async () => {
    const backend = createMemoryBackend();
    const events: unknown[] = [];
    const first = createDbDriver({ backend, locateWasm });
    await first.handle('app', kvSetFrame('k', 1));
    await first.flush();
    const second = createDbDriver({ backend, locateWasm, onRecoverableError: (event) => events.push(event) });
    expect(await second.handle('app', kvGetFrame('k'))).toMatchObject({ ok: true, value: 1 });
    expect(events).toEqual([]);
  });
});

describe('lifecycle auto-flush (Gate-5 finding 1: pagehide / visibilitychange:hidden)', () => {
  it('flushes pending debounced writes on pagehide', async () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
    const backend = createMemoryBackend();
    const save = vi.spyOn(backend, 'save');
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 60_000 });
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    expect(save).not.toHaveBeenCalled(); // still deep inside the debounce window

    fakeWindow.dispatchEvent(new Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save).toHaveBeenCalledTimes(1);
    await d.close();
  });

  it('flushes when the document becomes hidden — and only then', async () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
    const backend = createMemoryBackend();
    const save = vi.spyOn(backend, 'save');
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 60_000 });
    await d.handle('app', kvSetFrame('k', 1));

    fakeDocument.dispatchEvent(new Event('visibilitychange')); // still visible — no flush
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save).not.toHaveBeenCalled();

    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save).toHaveBeenCalledTimes(1);
    await d.close();
  });

  it('close() removes the lifecycle listeners', async () => {
    const fakeWindow = new EventTarget();
    const fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const removeWindow = vi.spyOn(fakeWindow, 'removeEventListener');
    const removeDocument = vi.spyOn(fakeDocument, 'removeEventListener');
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
    const backend = createMemoryBackend();
    const save = vi.spyOn(backend, 'save');
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 60_000 });
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.close();
    const savesAtClose = save.mock.calls.length;

    expect(removeWindow).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    fakeWindow.dispatchEvent(new Event('pagehide')); // must be inert after close
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save.mock.calls.length).toBe(savesAtClose);
  });
});

describe('namespace sanitization (host-assigned, but still filename-safe)', () => {
  it('keeps already-safe namespaces readable', () => {
    expect(namespaceToFileName('tenant-42.chess')).toBe('tenant-42.chess.sqlite');
  });

  it('replaces unsafe characters and disambiguates with a hash — no collisions', () => {
    const slash = namespaceToFileName('a/b');
    const question = namespaceToFileName('a?b');
    const plain = namespaceToFileName('a_b');
    expect(slash).toMatch(/^[A-Za-z0-9._-]+\.sqlite$/);
    expect(question).toMatch(/^[A-Za-z0-9._-]+\.sqlite$/);
    expect(new Set([slash, question, plain]).size).toBe(3);
  });

  it('caps length and never produces an empty stem', () => {
    const long = namespaceToFileName('x'.repeat(500));
    expect(long.length).toBeLessThan(100);
    expect(namespaceToFileName('///')).toMatch(/^[A-Za-z0-9._-]+\.sqlite$/);
  });

  it('distinct raw namespaces stay isolated even when they sanitize alike (AC-4 support)', async () => {
    const backend = createMemoryBackend();
    const d = createDbDriver({ backend, locateWasm });
    await d.handle('a/b', execFrame('CREATE TABLE t (x)'));
    const other = await d.handle('a?b', execFrame('SELECT * FROM t'));
    expect(other.ok).toBe(false); // isolation: a/b's table is invisible to a?b
    await d.handle('a?b', execFrame('CREATE TABLE u (y)'));
    await d.flush();
    expect(backend.files.size).toBe(2); // distinct files despite sanitizing alike
  });
});
