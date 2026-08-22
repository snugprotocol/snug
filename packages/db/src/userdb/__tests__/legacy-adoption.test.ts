// TASK-20260820 — adopting `user.sqlite` forward to `user.snug` (AC1, AC2, AC21, AC22).
//
// WHY THIS IS THE MOST IMPORTANT TEST FILE IN THE TASK.
//
// Renaming the file a product looks for is the single easiest way to destroy a user's
// data without a single crash or error message: the new name is absent, so the open
// path takes its "no file yet" branch, hands back a pristine empty database, and the
// first write persists that emptiness. The user's real data is still on disk, intact
// and unreferenced, while the app cheerfully shows them nothing. Nobody gets an
// exception. `docs/lessons.md` already carries the 2026-08-03 version of this lesson
// ("a transient read error silently opens a fresh database over real data").
//
// So these tests assert the CONTENTS survive, never merely that a file exists.
import { describe, expect, it } from 'vitest';
import { USERDB_FILE, USERDB_LEGACY_FILE } from '@snugprotocol/protocol';

import { createMemoryBackend, type PersistenceBackend } from '../../persistence.js';
import { encryptContainer, generateRecoveryKey } from '../../crypto/container.js';
import { openUserDb } from '../userdb.js';
import { locateWasm } from '../../__tests__/helpers.js';

const PASS = 'the passphrase on a file protected before the rename';

/** A backend that records every load, so we can prove HOW the legacy file was found. */
function watched(): { backend: PersistenceBackend; loads: string[]; files: Map<string, Uint8Array> } {
  const inner = createMemoryBackend();
  const loads: string[] = [];
  const files = new Map<string, Uint8Array>();
  const backend: PersistenceBackend = {
    kind: 'memory',
    async load(file) {
      loads.push(file);
      return files.get(file)?.slice();
    },
    async save(file, bytes) {
      files.set(file, bytes.slice());
    },
  };
  void inner;
  return { backend, loads, files };
}

const open = (backend: PersistenceBackend) => openUserDb({ backend, locateWasm });

/** Seed a legacy-named file that genuinely holds an app, the way a real user's would. */
async function seedLegacy(backend: PersistenceBackend, files: Map<string, Uint8Array>, appName: string): Promise<void> {
  const first = await open(backend);
  expect(first.status).toBe('ok');
  if (first.status !== 'ok') return;
  first.userDb.installApp({ displayName: appName, html: '<!doctype html><title>x</title>' });
  await first.userDb.flush();
  await first.userDb.close();
  // Move what was just written to the LEGACY name and clear the canonical one, which
  // is precisely the on-disk shape of a user upgrading from a pre-rename build.
  const written = files.get(USERDB_FILE);
  expect(written).toBeDefined();
  files.set(USERDB_LEGACY_FILE, written!);
  files.delete(USERDB_FILE);
}

describe('legacy `user.sqlite` adoption (AC1)', () => {
  it('opens the LEGACY file and returns its real contents when the canonical one is absent', async () => {
    const { backend, files } = watched();
    await seedLegacy(backend, files, 'Ledger');

    const reopened = await open(backend);
    expect(reopened.status).toBe('ok');
    if (reopened.status !== 'ok') return;
    // The whole point: the user's app is STILL THERE. A fresh empty DB would also
    // report status 'ok', which is exactly why this asserts contents, not status.
    expect(reopened.userDb.listApps().map((a) => a.displayName)).toEqual(['Ledger']);
    await reopened.userDb.close();
  });

  it('finds the legacy file through the BACKEND (slot-aware), never a bare filename probe (AC22)', async () => {
    // On OPFS the bytes never live under a bare `user.sqlite` — they live in
    // `user.sqlite.slot-a`/`.slot-b` behind a `.ptr`. Only PersistenceBackend.load
    // knows that. An implementation that "cheaply checks whether the canonical file
    // exists" with a direct filename probe is silently wrong on the web path, which
    // is where every existing user is (plan review B1).
    const { backend, files, loads } = watched();
    await seedLegacy(backend, files, 'Moodboard');
    loads.length = 0;

    const reopened = await open(backend);
    expect(reopened.status).toBe('ok');
    if (reopened.status !== 'ok') return;
    expect(loads).toContain(USERDB_FILE); // canonical tried first
    expect(loads).toContain(USERDB_LEGACY_FILE); // then the legacy name, via load()
    expect(loads.indexOf(USERDB_FILE)).toBeLessThan(loads.indexOf(USERDB_LEGACY_FILE));
    await reopened.userDb.close();
  });

  it('adopts forward: the next persist writes the CANONICAL name', async () => {
    const { backend, files } = watched();
    await seedLegacy(backend, files, 'Rewind');

    const reopened = await open(backend);
    expect(reopened.status).toBe('ok');
    if (reopened.status !== 'ok') return;
    reopened.userDb.installApp({ displayName: 'Second', html: '<!doctype html><title>y</title>' });
    await reopened.userDb.flush();
    expect(files.has(USERDB_FILE)).toBe(true);
    await reopened.userDb.close();
  });

  it('NEVER deletes the legacy file — it stays as the user’s own backup', async () => {
    const { backend, files } = watched();
    await seedLegacy(backend, files, 'Keepsake');

    const reopened = await open(backend);
    expect(reopened.status).toBe('ok');
    if (reopened.status !== 'ok') return;
    await reopened.userDb.flush();
    expect(files.has(USERDB_LEGACY_FILE)).toBe(true);
    await reopened.userDb.close();
  });
});

describe('the two migrations compose (rename × protection)', () => {
  it('a PROTECTED legacy file locks, unlocks, and adopts forward STILL protected', async () => {
    // Both migrations can be in flight for the same user: they protected their file on
    // an older build, then upgraded into the rename. If adopt-forward treated the
    // container as unreadable they would be told their data was corrupt; if it adopted
    // forward as PLAINTEXT it would silently strip the protection they asked for —
    // arguably the worse of the two, because nothing would look wrong.
    const { backend, files } = watched();
    const scratch = watched();
    const seed = await open(scratch.backend);
    expect(seed.status).toBe('ok');
    if (seed.status !== 'ok') return;
    seed.userDb.installApp({ displayName: 'Protected', html: '<!doctype html><title>p</title>' });
    const plain = await seed.userDb.exportUserDb({ includeSecrets: true });
    await seed.userDb.close();
    files.set(USERDB_LEGACY_FILE, await encryptContainer(plain, { passphrase: PASS, recoveryKey: generateRecoveryKey() }));

    // No secret: locked, and NOT reported as corrupt or opened fresh.
    expect((await open(backend)).status).toBe('locked');

    const opened = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    expect(opened.userDb.listApps().map((a) => a.displayName)).toEqual(['Protected']);
    // Adoption happens on the next WRITE (§10) — a clean unlock alone persists nothing.
    // This test previously flushed with no write and still adopted, because the self-heal
    // guard spuriously dirtied every open (fixed in this task); the compose claim under
    // test is "protection survives adoption", so give adoption its write.
    opened.userDb.setSetting('theme', 'dark');
    await opened.userDb.flush();
    await opened.userDb.close();

    const adopted = files.get(USERDB_FILE);
    expect(adopted).toBeDefined();
    expect(new TextDecoder().decode(adopted!.slice(0, 8))).toBe('SNUGENC1');
  });
});

describe('canonical wins once it exists (AC2)', () => {
  it('ignores a stale legacy file when the canonical file is present', async () => {
    const { backend, files } = watched();
    await seedLegacy(backend, files, 'OldData');

    // Adopt forward, then add something only the canonical copy knows about.
    const adopted = await open(backend);
    expect(adopted.status).toBe('ok');
    if (adopted.status !== 'ok') return;
    adopted.userDb.installApp({ displayName: 'NewData', html: '<!doctype html><title>z</title>' });
    await adopted.userDb.flush();
    await adopted.userDb.close();

    // A third boot must read the CANONICAL file. Reading the stale legacy one here
    // would silently roll the user back to yesterday — a subtler data loss than an
    // empty database, and far harder to notice.
    const third = await open(backend);
    expect(third.status).toBe('ok');
    if (third.status !== 'ok') return;
    expect(third.userDb.listApps().map((a) => a.displayName).sort()).toEqual(['NewData', 'OldData']);
    await third.userDb.close();
  });

  it('a genuinely fresh install (neither file present) still starts empty', async () => {
    const { backend } = watched();
    const fresh = await open(backend);
    expect(fresh.status).toBe('ok');
    if (fresh.status !== 'ok') return;
    expect(fresh.userDb.listApps()).toEqual([]);
    await fresh.userDb.close();
  });
});
