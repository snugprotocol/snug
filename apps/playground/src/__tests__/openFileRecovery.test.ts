// The `.snug` recovery path (whole-surface review finding 5) — "the button does
// nothing" class of defect, plus the one that made it worse.
//
// TWO DEFECTS UNDER TEST.
//
// 1. `registerPlatformOpenFile` did `void handleOpenedUserFile(...)` with no catch,
//    and `handleOpenedUserFile` awaited `importUserFile` with no catch. So a
//    BAD_IMPORT (magic-valid but unopenable, or a schema version from the future) or
//    a TOO_LARGE rejection became an unhandled promise rejection with ZERO UI: the
//    user double-clicks their file and nothing whatsoever happens.
//
// 2. Worse: `importUserFile` first awaits `getUserDb()`, whose promise NEVER resolves
//    while the status is load-failed/corrupt. So in EXACTLY the state where a user
//    reaches for a backup — a torn user file, and a `.snug` they saved last month —
//    the confirmed import parked forever. The grandma case: torn file, good backup,
//    double-click, nothing.
//
// The fix must make recovery WORK, not merely fail loudly, so the last test drives
// the whole rescue through the real boot open.

import { describe, expect, it, vi } from 'vitest';

import { createMemoryBackend, openUserDb, type PersistenceBackend } from '@snugprotocol/db';
import { USERDB_FILE } from '@snugprotocol/protocol';

import type { SnugPlatform } from '../platform/platform.js';
import { locateWasm } from './userdbTestHelper.js';

const SQLITE_MAGIC = new TextEncoder().encode('SQLite format 3\0');

function desktopPlatform(backend: PersistenceBackend): SnugPlatform {
  return {
    kind: 'desktop',
    userdbBackend: backend,
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}

/** Real, openable user-file bytes produced through the production export path. */
async function goodBackupBytes(appName: string): Promise<Uint8Array> {
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`fixture open failed: ${result.status}`);
  result.userDb.installApp({ displayName: appName, html: '<html>backup</html>' });
  return result.userDb.exportUserDb({ includeSecrets: false });
}

/**
 * Bytes that PASS the open-file magic gate but cannot actually be opened — the
 * BAD_IMPORT case the routing seam let through into a silent rejection.
 */
function magicValidButUnopenable(): Uint8Array {
  const bytes = new Uint8Array(200);
  bytes.set(SQLITE_MAGIC);
  bytes.fill(0xff, SQLITE_MAGIC.length);
  return bytes;
}

interface Harness {
  openFile: typeof import('../platform/openFile.js');
  userdb: typeof import('../state/userdb.js');
  capturedOpen?: (bytes: Uint8Array, path: string) => void;
}

/** A fresh module graph with a desktop platform over the given backend. */
async function fresh(backend: PersistenceBackend): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  const harness: Harness = {} as Harness;
  platformModule.setPlatform({
    ...desktopPlatform(backend),
    onOpenSnugFile: (cb) => {
      harness.capturedOpen = cb;
    },
  });
  harness.openFile = await import('../platform/openFile.js');
  harness.userdb = await import('../state/userdb.js');
  // Point the boot open at the node wasm locator (the browser path is unavailable here).
  vi.doMock('../run/wasm.js', () => ({ locateWasm }));
  return harness;
}

/** Drive the real boot open and wait for it to leave 'opening'. */
async function bootAndSettle(harness: Harness): Promise<string> {
  void harness.userdb.bootUserDb();
  await vi.waitFor(() => {
    expect(harness.userdb.userDbStatusStore.get().state).not.toBe('opening');
  }, 15_000);
  return harness.userdb.userDbStatusStore.get().state;
}

describe('finding 5 — import failures on the open-file path surface something', () => {
  it('a magic-valid but UNOPENABLE file reports an error instead of rejecting into nothing', async () => {
    const backend = createMemoryBackend();
    await backend.save(USERDB_FILE, await goodBackupBytes('Live App'));
    const harness = await fresh(backend);
    expect(await bootAndSettle(harness)).toBe('ready');

    harness.openFile.registerPlatformOpenFile();
    expect(harness.capturedOpen).toBeDefined();
    harness.capturedOpen!(magicValidButUnopenable(), '/Users/g/backup.snug');

    await vi.waitFor(() => {
      expect(harness.openFile.openUserFileConfirmStore.get()).not.toBeNull();
    });
    harness.openFile.resolveOpenUserFileConfirm(true);

    await vi.waitFor(() => {
      expect(
        harness.openFile.openUserFileErrorStore.get(),
        'a failed import MUST produce a user-visible message, not an unhandled rejection',
      ).not.toBeNull();
    }, 15_000);
  });

  it('an oversized file reports an error too', async () => {
    const backend = createMemoryBackend();
    await backend.save(USERDB_FILE, await goodBackupBytes('Live App'));
    const harness = await fresh(backend);
    expect(await bootAndSettle(harness)).toBe('ready');

    // Past the 5 MiB import cap, with a valid header so it clears the magic gate.
    const huge = new Uint8Array(6 * 1024 * 1024);
    huge.set(SQLITE_MAGIC);

    harness.openFile.registerPlatformOpenFile();
    harness.capturedOpen!(huge, '/Users/g/huge.snug');
    await vi.waitFor(() => {
      expect(harness.openFile.openUserFileConfirmStore.get()).not.toBeNull();
    });
    harness.openFile.resolveOpenUserFileConfirm(true);

    await vi.waitFor(() => {
      expect(harness.openFile.openUserFileErrorStore.get()).not.toBeNull();
    }, 15_000);
  });
});

describe('finding 5 — the torn-file + backup recovery actually completes', () => {
  it('a torn user file leaves the db unusable, and double-clicking a backup RESTORES it', async () => {
    // A user file that the boot open refuses: right magic, unopenable content.
    const backend = createMemoryBackend();
    await backend.save(USERDB_FILE, magicValidButUnopenable());
    const harness = await fresh(backend);

    const state = await bootAndSettle(harness);
    expect(
      ['load-failed', 'corrupt'],
      'the torn file must NOT open — this is the state the user is rescuing from',
    ).toContain(state);
    expect(harness.userdb.userDbNeedsRestore()).toBe(true);

    // The confirm must say "restore", not "your current data will be overwritten":
    // there is nothing of theirs left to overwrite.
    harness.openFile.registerPlatformOpenFile();
    harness.capturedOpen!(await goodBackupBytes('Rescued App'), '/Users/g/backup.snug');
    await vi.waitFor(() => {
      expect(harness.openFile.openUserFileConfirmStore.get()?.needsRestore).toBe(true);
    });

    harness.openFile.resolveOpenUserFileConfirm(true);

    // THE POINT: this used to park forever on a promise that could not settle.
    await vi.waitFor(() => {
      expect(
        harness.userdb.userDbStatusStore.get().state,
        'the restore must bring the database back to ready',
      ).toBe('ready');
    }, 20_000);

    const db = await harness.userdb.getUserDb();
    expect(db.listApps().map((a) => a.displayName)).toContain('Rescued App');
    expect(harness.openFile.openUserFileErrorStore.get()).toBeNull();
  });

  it('a restore whose backup is ALSO bad reports the failure and stays unusable', async () => {
    const backend = createMemoryBackend();
    await backend.save(USERDB_FILE, magicValidButUnopenable());
    const harness = await fresh(backend);
    expect(harness.userdb.userDbNeedsRestore() || (await bootAndSettle(harness)) !== 'ready').toBe(true);

    harness.openFile.registerPlatformOpenFile();
    harness.capturedOpen!(magicValidButUnopenable(), '/Users/g/also-torn.snug');
    await vi.waitFor(() => {
      expect(harness.openFile.openUserFileConfirmStore.get()).not.toBeNull();
    });
    harness.openFile.resolveOpenUserFileConfirm(true);

    await vi.waitFor(() => {
      expect(harness.openFile.openUserFileErrorStore.get()).not.toBeNull();
    }, 20_000);
    expect(harness.userdb.userDbStatusStore.get().state).not.toBe('ready');
  });

  it('restoreUserDbFromBytes refuses to run while the database is healthy', async () => {
    const backend = createMemoryBackend();
    await backend.save(USERDB_FILE, await goodBackupBytes('Live App'));
    const harness = await fresh(backend);
    expect(await bootAndSettle(harness)).toBe('ready');

    // A healthy db must import through importUserFile, which arms F15.
    await expect(harness.userdb.restoreUserDbFromBytes(await goodBackupBytes('X'))).rejects.toThrow(
      /not in a failed state/,
    );
  });
});
