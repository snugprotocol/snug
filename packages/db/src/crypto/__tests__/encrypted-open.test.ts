// TASK-20260820 — opening a PROTECTED user file (AC9, AC10, AC13, AC14, AC27).
//
// THE INVARIANT THIS FILE DEFENDS: the user DB never fails open (F6), and it never
// fails MISLEADINGLY. Three outcomes must stay distinct forever, because each sends
// the user somewhere completely different:
//
//   'locked'   -> ask for the secret. The file is fine.
//   'corrupt'  -> the bytes are damaged; quarantine and offer recovery.
//   'ok' fresh -> there was genuinely nothing here.
//
// Collapsing any pair is a disaster in a distinct way. locked-as-corrupt quarantines
// a perfectly good file and tells the user it was unreadable. locked-as-fresh silently
// hands them an empty hub over their real data. corrupt-as-locked has them retyping a
// correct passphrase forever against a file that was damaged (plan review S2).
import { describe, expect, it } from 'vitest';
import { USERDB_FILE } from '@snugprotocol/protocol';

import { createMemoryBackend, looksComplete } from '../../persistence.js';
import { openUserDb } from '../../userdb/userdb.js';
import { decryptContainer, encryptContainer, generateRecoveryKey } from '../container.js';
import { locateWasm } from '../../__tests__/helpers.js';

const PASS = 'the passphrase from the setup flow';

/** Build a real protected file: make a db, export it, seal it, store it. */
async function seedProtected(recoveryKey: string): Promise<ReturnType<typeof createMemoryBackend>> {
  // The seeding db gets its OWN scratch backend, and only the sealed BYTES cross over
  // to the backend under test. Sharing one backend leaves the seeding UserDb alive as
  // a second writer whose debounced write-back lands after the sealed file and
  // silently replaces it with stale plaintext — which is a real hazard worth knowing
  // about (see the two-writers test below), but not the thing these cases are for.
  const scratch = createMemoryBackend();
  const first = await openUserDb({ backend: scratch, locateWasm });
  if (first.status !== 'ok') throw new Error('seed failed');
  first.userDb.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' });
  const bytes = await first.userDb.exportUserDb({ includeSecrets: true });
  await first.userDb.close();

  const backend = createMemoryBackend();
  await backend.save(USERDB_FILE, await encryptContainer(bytes, { passphrase: PASS, recoveryKey }));
  return backend;
}

describe('an encrypted file is COMPLETE, not corruption (AC9)', () => {
  it('looksComplete accepts the container magic', async () => {
    const sealed = await encryptContainer(new Uint8Array([1, 2, 3]), {
      passphrase: PASS,
      recoveryKey: generateRecoveryKey(),
    });
    // Without this, the OPFS A/B recovery reads every protected slot as invalid and
    // eventually throws "exists but stayed unreadable", and the desktop file backend
    // refuses to load at all. The single most important line in the whole task.
    expect(looksComplete(sealed)).toBe(true);
  });
});

describe('opening a protected file (AC10)', () => {
  it('reports LOCKED — never corrupt, never a fresh empty database', async () => {
    const backend = await seedProtected(generateRecoveryKey());
    const result = await openUserDb({ backend, locateWasm });
    expect(result.status).toBe('locked');
  });

  it('does NOT quarantine the file — nothing is moved or rewritten', async () => {
    const backend = await seedProtected(generateRecoveryKey());
    const before = (await backend.load(USERDB_FILE))!.slice();
    await openUserDb({ backend, locateWasm });
    // Quarantining a protected file would look, to the user, exactly like data loss.
    expect(Array.from((await backend.load(USERDB_FILE))!)).toEqual(Array.from(before));
  });

  it('opens for real when the passphrase is supplied', async () => {
    const backend = await seedProtected(generateRecoveryKey());
    const result = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.userDb.listApps().map((a) => a.displayName)).toEqual(['Ledger']);
    await result.userDb.close();
  });

  it('opens with the Recovery Key when the passphrase is forgotten (AC11)', async () => {
    const recoveryKey = generateRecoveryKey();
    const backend = await seedProtected(recoveryKey);
    const result = await openUserDb({ backend, locateWasm, secrets: { recoveryKey } });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.userDb.listApps().map((a) => a.displayName)).toEqual(['Ledger']);
    await result.userDb.close();
  });

  it('stays LOCKED for a wrong passphrase — and still does not quarantine', async () => {
    const backend = await seedProtected(generateRecoveryKey());
    const before = (await backend.load(USERDB_FILE))!.slice();
    const result = await openUserDb({ backend, locateWasm, secrets: { passphrase: 'nope' } });
    expect(result.status).toBe('locked');
    expect(Array.from((await backend.load(USERDB_FILE))!)).toEqual(Array.from(before));
  });

  it('a DAMAGED container is corrupt, not locked (AC27)', async () => {
    const backend = await seedProtected(generateRecoveryKey());
    const sealed = (await backend.load(USERDB_FILE))!;
    await backend.save(USERDB_FILE, sealed.slice(0, sealed.length - 16)); // truncated
    const result = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
    // Telling this user "wrong passphrase" would send them hunting for a secret that
    // was never the problem — and they have no way to ever discover otherwise.
    expect(result.status).toBe('corrupt');
  });
});

describe('writes stay protected once the file is (AC13)', () => {
  it('re-persists as a container, not as plaintext', async () => {
    const backend = await seedProtected(generateRecoveryKey());
    const opened = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    opened.userDb.installApp({ displayName: 'Second', html: '<!doctype html><title>s</title>' });
    await opened.userDb.flush();
    await opened.userDb.close();

    const onDisk = (await backend.load(USERDB_FILE))!;
    // eslint-disable-next-line no-console

    // A protected file that silently reverts to plaintext on the next save is the
    // worst possible outcome: the user believes they are protected and are not.
    expect(new TextDecoder().decode(onDisk.slice(0, 8))).toBe('SNUGENC1');

    const reopened = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
    expect(reopened.status).toBe('ok');
    if (reopened.status !== 'ok') return;
    expect(reopened.userDb.listApps().map((a) => a.displayName).sort()).toEqual(['Ledger', 'Second']);
    await reopened.userDb.close();
  });
});

describe('re-sealing preserves the OTHER slot (regression, found during implementation)', () => {
  it('a passphrase-only session keeps the Recovery Key working across writes', async () => {
    // THE BUG THIS PINS. The first implementation rebuilt the container from "the
    // secrets this session holds" on every save. A session that unlocked with the
    // passphrase alone does not hold the Recovery Key and cannot derive it, so every
    // write silently dropped the recovery slot. The user would have discovered it at
    // the single worst moment: the day they forgot their passphrase and reached for
    // the key we told them to keep safe. (It surfaced as a persist that threw and
    // retried forever — nothing reached disk at all — which is how it was caught.)
    const recoveryKey = generateRecoveryKey();
    const backend = await seedProtected(recoveryKey);

    const opened = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    opened.userDb.installApp({ displayName: 'Written', html: '<!doctype html><title>w</title>' });
    await opened.userDb.flush();
    await opened.userDb.close();

    // The Recovery Key must still open the file, and see the new write.
    const viaRecovery = await openUserDb({ backend, locateWasm, secrets: { recoveryKey } });
    expect(viaRecovery.status).toBe('ok');
    if (viaRecovery.status !== 'ok') return;
    expect(viaRecovery.userDb.listApps().map((a) => a.displayName).sort()).toEqual(['Ledger', 'Written']);
    await viaRecovery.userDb.close();
  });

  it('a write actually REACHES the backend when protected (the failure was silent)', async () => {
    // The original defect threw inside persist's catch-all, which sets dirty=true and
    // retries — so the app looked healthy while nothing was ever written. Counting
    // saves is the only way to see that from outside.
    const saves: number[] = [];
    const store = new Map<string, Uint8Array>();
    const seeded = await seedProtected(generateRecoveryKey());
    const sealedBytes = (await seeded.load(USERDB_FILE))!;
    store.set(USERDB_FILE, sealedBytes);
    const counting = {
      kind: 'memory' as const,
      load: (f: string) => Promise.resolve(store.get(f)?.slice()),
      save: (f: string, b: Uint8Array) => {
        saves.push(b.length);
        store.set(f, b.slice());
        return Promise.resolve();
      },
    };

    const opened = await openUserDb({ backend: counting, locateWasm, secrets: { passphrase: PASS } });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    opened.userDb.setSetting('probe', 'v');
    await opened.userDb.flush();
    expect(saves.length).toBeGreaterThan(0);
    await opened.userDb.close();
  });
});

describe('turning protection on and off (AC13, AC14)', () => {
  it('converts a plaintext file in place, and it opens only with the secret afterwards', async () => {
    const backend = createMemoryBackend();
    const first = await openUserDb({ backend, locateWasm });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    first.userDb.installApp({ displayName: 'Before', html: '<!doctype html><title>b</title>' });
    const recoveryKey = generateRecoveryKey();
    await first.userDb.protect({ passphrase: PASS, recoveryKey });
    await first.userDb.close();

    expect(new TextDecoder().decode((await backend.load(USERDB_FILE))!.slice(0, 8))).toBe('SNUGENC1');
    expect((await openUserDb({ backend, locateWasm })).status).toBe('locked');

    const opened = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') return;
    // Conversion must not lose anything that was already there.
    expect(opened.userDb.listApps().map((a) => a.displayName)).toEqual(['Before']);
    await opened.userDb.close();
  });

  it('keeps writing sealed after conversion, with the recovery slot intact', async () => {
    const backend = createMemoryBackend();
    const first = await openUserDb({ backend, locateWasm });
    if (first.status !== 'ok') return;
    const recoveryKey = generateRecoveryKey();
    await first.userDb.protect({ passphrase: PASS, recoveryKey });
    first.userDb.installApp({ displayName: 'After', html: '<!doctype html><title>a</title>' });
    await first.userDb.flush();
    await first.userDb.close();

    // Same class of bug as the reseal regression: a session that converted with both
    // secrets must not lose the recovery slot on its very next write.
    const viaRecovery = await openUserDb({ backend, locateWasm, secrets: { recoveryKey } });
    expect(viaRecovery.status).toBe('ok');
    if (viaRecovery.status !== 'ok') return;
    expect(viaRecovery.userDb.listApps().map((a) => a.displayName)).toEqual(['After']);
    await viaRecovery.userDb.close();
  });

  it('removes protection and writes plaintext back (AC14)', async () => {
    const backend = createMemoryBackend();
    const first = await openUserDb({ backend, locateWasm });
    if (first.status !== 'ok') return;
    first.userDb.installApp({ displayName: 'Kept', html: '<!doctype html><title>k</title>' });
    await first.userDb.protect({ passphrase: PASS, recoveryKey: generateRecoveryKey() });
    await first.userDb.protect(undefined);
    await first.userDb.close();

    expect(new TextDecoder().decode((await backend.load(USERDB_FILE))!.slice(0, 6))).toBe('SQLite');
    const plain = await openUserDb({ backend, locateWasm });
    expect(plain.status).toBe('ok');
    if (plain.status !== 'ok') return;
    expect(plain.userDb.listApps().map((a) => a.displayName)).toEqual(['Kept']);
    await plain.userDb.close();
  });
});

describe('a plaintext file still opens with no secret (AC-D3 opt-in)', () => {
  it('unprotected files are untouched by any of this', async () => {
    const backend = createMemoryBackend();
    const first = await openUserDb({ backend, locateWasm });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    first.userDb.installApp({ displayName: 'Plain', html: '<!doctype html><title>p</title>' });
    await first.userDb.flush();
    await first.userDb.close();

    const again = await openUserDb({ backend, locateWasm });
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(again.userDb.listApps().map((a) => a.displayName)).toEqual(['Plain']);
    await again.userDb.close();
  });
});
