// TASK-20260812 AC2 (file persistence backend, amendment 9): the desktop 'file'
// PersistenceKind. save delegates to the injected fs's ATOMIC write (temp+rename is the
// fs implementation's contract — Tauri side), load distinguishes genuine absence
// (undefined) from I/O failure (rejection propagates as a throw) and from incomplete
// bytes (corrupt-signal throw, NEVER a silent fresh DB — lesson 2026-08-03), the
// completeness check accepts BOTH magics (sqlite header OR the sync-sidecar envelope),
// and openUserDb runs unchanged on top including the quarantine path.
import { describe, expect, it, vi } from 'vitest';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { createDbDriver } from '../driver.js';
import { createFileBackend, type FileBackendFs } from '../file-backend.js';
import { SYNC_SIDECAR_MAGIC } from '../persistence.js';
import { openUserDb } from '../userdb/userdb.js';
import { execFrame, locateWasm, SQLITE_MAGIC } from './helpers.js';

const DIR = '/home/grandma/Snug';

/** In-memory FileBackendFs fake: path → bytes; absence resolves undefined. */
function memFs(): { files: Map<string, Uint8Array>; fs: FileBackendFs } {
  const files = new Map<string, Uint8Array>();
  const fs: FileBackendFs = {
    readFile: (path) => Promise.resolve(files.get(path)?.slice()),
    writeFileAtomic: (path, bytes) => {
      files.set(path, bytes.slice());
      return Promise.resolve();
    },
  };
  return { files, fs };
}

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('createFileBackend contract', () => {
  it('has kind "file" and the driver surfaces persistence:"file"', () => {
    const { fs } = memFs();
    const backend = createFileBackend(fs, DIR);
    expect(backend.kind).toBe('file');
    const driver = createDbDriver({ backend, locateWasm });
    expect(driver.persistence).toBe('file');
  });

  it('save delegates to writeFileAtomic under the backend directory', async () => {
    const { fs } = memFs();
    const write = vi.spyOn(fs, 'writeFileAtomic');
    const backend = createFileBackend(fs, DIR);
    const bytes = ascii(SQLITE_MAGIC + 'payload');
    await backend.save('user.sqlite', bytes);
    expect(write).toHaveBeenCalledWith(`${DIR}/user.sqlite`, bytes);
  });

  it('load resolves undefined ONLY for genuine absence (readFile resolved undefined)', async () => {
    const { fs } = memFs();
    const backend = createFileBackend(fs, DIR);
    await expect(backend.load('user.sqlite')).resolves.toBeUndefined();
  });

  it('a readFile REJECTION propagates as a throw — never undefined (no silent fresh DB)', async () => {
    const fs: FileBackendFs = {
      readFile: () => Promise.reject(new Error('EACCES: permission denied')),
      writeFileAtomic: () => Promise.resolve(),
    };
    const backend = createFileBackend(fs, DIR);
    await expect(backend.load('user.sqlite')).rejects.toThrow('EACCES');
  });

  it('sqlite-magic bytes round-trip unchanged', async () => {
    const { fs } = memFs();
    const backend = createFileBackend(fs, DIR);
    const bytes = ascii(SQLITE_MAGIC + 'rest-of-the-database');
    await backend.save('user.sqlite', bytes);
    await expect(backend.load('user.sqlite')).resolves.toEqual(bytes);
  });

  it('sidecar (SNUGSYNC1) bytes round-trip unchanged', async () => {
    const { fs } = memFs();
    const backend = createFileBackend(fs, DIR);
    const bytes = ascii(SYNC_SIDECAR_MAGIC + '{"v":1,"hash":"abc"}');
    await backend.save('sync.sidecar', bytes);
    await expect(backend.load('sync.sidecar')).resolves.toEqual(bytes);
  });

  it('bytes lacking BOTH magics (zeroed buffer) throw a corrupt-signal error', async () => {
    const { files, fs } = memFs();
    files.set(`${DIR}/user.sqlite`, new Uint8Array(512));
    const backend = createFileBackend(fs, DIR);
    await expect(backend.load('user.sqlite')).rejects.toThrow(/fresh/);
  });

  it('a zero-length read throws the same corrupt signal — never undefined, never bytes', async () => {
    const { files, fs } = memFs();
    files.set(`${DIR}/user.sqlite`, new Uint8Array(0));
    const backend = createFileBackend(fs, DIR);
    await expect(backend.load('user.sqlite')).rejects.toThrow(/fresh/);
  });
});

describe('openUserDb over the file backend', () => {
  it('open → write rows → persist → reopen → rows intact', async () => {
    const { files, fs } = memFs();
    const first = await openUserDb({ backend: createFileBackend(fs, DIR), locateWasm, persistDebounceMs: 1 });
    if (first.status !== 'ok') throw new Error(`expected ok open, got ${first.status}`);
    const app = first.userDb.installApp({ displayName: 'Chess', html: '<html>v1</html>' });
    first.userDb.setSetting('mode', 'byok');
    await first.userDb.close();
    expect(files.has(`${DIR}/${USERDB_FILE}`)).toBe(true);

    const second = await openUserDb({ backend: createFileBackend(fs, DIR), locateWasm, persistDebounceMs: 1 });
    if (second.status !== 'ok') throw new Error(`expected ok reopen, got ${second.status}`);
    expect(second.userDb.getAppHtml(app.appId)).toBe('<html>v1</html>');
    expect(second.userDb.getSetting('mode')).toBe('byok');
    await second.userDb.close();
  });

  it('corrupt stored bytes (magic present, body garbage) → status "corrupt" with the quarantine written through the backend', async () => {
    const { files, fs } = memFs();
    const corrupt = ascii(SQLITE_MAGIC + 'z'.repeat(200));
    files.set(`${DIR}/${USERDB_FILE}`, corrupt);
    const result = await openUserDb({ backend: createFileBackend(fs, DIR), locateWasm });
    if (result.status !== 'corrupt') throw new Error(`expected corrupt open, got ${result.status}`);
    expect(files.get(`${DIR}/${result.quarantinedFile}`)).toEqual(corrupt);
  });

  it('a magic-less stored file makes open REJECT — evidence of prior state never degrades to a fresh DB', async () => {
    const { files, fs } = memFs();
    files.set(`${DIR}/${USERDB_FILE}`, ascii('torn-write-garbage-without-any-magic'));
    await expect(openUserDb({ backend: createFileBackend(fs, DIR), locateWasm })).rejects.toThrow(/fresh/);
  });
});

describe('per-app driver over the file backend (regression: same PersistenceBackend seam)', () => {
  it('persists and restores a namespace across driver instances', async () => {
    const { fs } = memFs();
    const backend = createFileBackend(fs, DIR);
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 1 });
    await d.handle('app', execFrame('CREATE TABLE t (x)'));
    await d.handle('app', execFrame('INSERT INTO t (x) VALUES (7)'));
    await d.flush();

    const reloaded = createDbDriver({ backend: createFileBackend(fs, DIR), locateWasm });
    const rows = await reloaded.handle('app', execFrame('SELECT x FROM t'));
    expect(rows).toMatchObject({ ok: true, rows: [[7]] });
  });
});
