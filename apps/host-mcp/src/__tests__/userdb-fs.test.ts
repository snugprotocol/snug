// AC7 / D-B27 — the user file on disk, and the HTTP shape the page's FileBackendFs speaks.
//
// This is the seam Snug Desktop fills with `read_user_file`/`write_user_file`. Its rules are
// the desktop's `userfile.rs` rules, in Node, because `createFileBackend` delegates
// atomicity entirely to the fs implementation ("one atomicity contract, enforced where the
// bytes actually hit the disk").
//
// The rule that matters most: ABSENCE IS ENOENT AND NOTHING ELSE. A reader that maps any
// failure to "not found" opens a pristine empty database over the user's real file, and the
// next save destroys it (lesson 2026-08-03, quoted in file-backend.ts's own header). Over
// HTTP that becomes: 404 is absence; every other status and every transport failure MUST
// reject.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUserFileStore, statusToLoadResult, validUserFileName } from '../userdb-fs.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'snug-host-fs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('valid_name — the desktop charset, copied verbatim', () => {
  it('admits both userdb names', () => {
    // `openUserDb` reads the legacy name when the canonical is absent (adopt-forward), so
    // refusing it would hide a real file behind a fresh empty database.
    expect(validUserFileName('user.snug')).toBe(true);
    expect(validUserFileName('user.sqlite')).toBe(true);
  });

  it('admits the quarantine and sidecar names the db actually writes', () => {
    // `userdb.ts` saves `${file}.corrupt-<base36>.bak` on the quarantine path. A
    // hand-narrowed two-name allowlist would throw INSIDE the corruption handler and turn
    // a recoverable quarantine into an unrecoverable crash.
    expect(validUserFileName('user.snug.corrupt-m1a2b3c.bak')).toBe(true);
    expect(validUserFileName('user.snug.sync')).toBe(true);
  });

  it('refuses a path separator, a parent traversal and a dotfile', () => {
    expect(validUserFileName('../etc/passwd')).toBe(false);
    expect(validUserFileName('a/b')).toBe(false);
    expect(validUserFileName('.hidden')).toBe(false);
    expect(validUserFileName('')).toBe(false);
  });

  it('refuses an over-long name', () => {
    expect(validUserFileName(`${'a'.repeat(129)}.snug`)).toBe(false);
  });
});

describe('the write is atomic', () => {
  it('publishes through a temp file and a rename, leaving no temp behind', async () => {
    const store = createUserFileStore(dir);
    await store.write('user.snug', new Uint8Array([1, 2, 3]));
    expect([...readFileSync(path.join(dir, 'user.snug'))]).toEqual([1, 2, 3]);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('leaves the previous bytes untouched when the write fails midway', async () => {
    const store = createUserFileStore(dir);
    await store.write('user.snug', new Uint8Array([9]));
    await expect(store.write('user.snug', new Uint8Array([1]), { failBeforeRename: true })).rejects.toThrow();
    expect([...readFileSync(path.join(dir, 'user.snug'))]).toEqual([9]);
  });

  it('sweeps a stale temp file but never a fresh one from a concurrent write', async () => {
    const store = createUserFileStore(dir);
    const stale = path.join(dir, 'user.snug.tmp-deadbeef');
    writeFileSync(stale, 'x');
    const old = Date.now() - 3_600_000;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { utimesSync } = await import('node:fs');
    utimesSync(stale, old / 1000, old / 1000);
    const fresh = path.join(dir, 'user.snug.tmp-feedface');
    writeFileSync(fresh, 'y');
    await store.write('user.snug', new Uint8Array([1]));
    expect(readdirSync(dir)).not.toContain('user.snug.tmp-deadbeef');
    expect(readdirSync(dir)).toContain('user.snug.tmp-feedface');
  });

  it('creates the directory when it does not exist yet', async () => {
    const nested = path.join(dir, 'Snug');
    const store = createUserFileStore(nested);
    await store.write('user.snug', new Uint8Array([7]));
    expect([...readFileSync(path.join(nested, 'user.snug'))]).toEqual([7]);
  });
});

describe('the read distinguishes absence from failure', () => {
  it('reports absence only for a file that is not there', async () => {
    const store = createUserFileStore(dir);
    expect(await store.read('user.snug')).toBeUndefined();
  });

  it('returns an EMPTY file as present-and-empty, never as absent', async () => {
    // The desktop encodes this with a one-byte discriminant because Tauri cannot express
    // "no value"; over HTTP a 200 with zero bytes says it directly. Either way an empty
    // file is corruption for the db to quarantine, not a fresh start.
    const store = createUserFileStore(dir);
    writeFileSync(path.join(dir, 'user.snug'), '');
    const bytes = await store.read('user.snug');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes?.length).toBe(0);
  });

  it('propagates an unreadable file as an error rather than absence', async () => {
    const store = createUserFileStore(dir);
    mkdirSync(path.join(dir, 'user.snug')); // a directory where a file should be: EISDIR
    await expect(store.read('user.snug')).rejects.toThrow();
  });
});

describe('the HTTP mapping the page’s FileBackendFs relies on', () => {
  it('maps 404 — and ONLY 404 — to absence', () => {
    expect(statusToLoadResult(404)).toEqual({ kind: 'absent' });
  });

  it.each([[423], [500], [502], [401], [403], [413]])('rejects on %i rather than reporting absence', (status) => {
    // A client that mapped these to `undefined` would open an empty database over the
    // user's real file — the exact shape of the 2026-08-03 lesson.
    expect(statusToLoadResult(status)).toEqual({ kind: 'error' });
  });

  it('maps 200 to bytes', () => {
    expect(statusToLoadResult(200)).toEqual({ kind: 'bytes' });
  });
});
