// TASK-20260820 — a protected file arriving from somewhere else (AC16, AC18, AC19,
// AC24, AC30; plan review B4).
//
// WHY THIS IS THE SHARPEST CASE IN THE TASK. The owner's stated purpose for encrypting
// sync payloads is that the Dropbox copy is the one most likely to fall into the wrong
// hands. But ADR-0009 also promises the file is "restorable on a new device after
// login" — so the moment sync carries ciphertext, a SECOND device has to be able to
// open it, and it starts with no local file, no settings, and no key. Get this wrong
// and turning on protection quietly breaks cross-device portability, which is the
// exact "don't lock the user out" failure this feature is supposed to avoid.
//
// The property that makes it work is that the container is SELF-OPENING: header, salt,
// slots and wrapped file key all travel WITH the bytes, so the only inputs are the file
// and the secret. Nothing is stored outside it — which is also forced, since
// `snug_secrets` lives inside the very file being decrypted.
//
// Every path that admits foreign bytes goes through `importUserDb` (its own doc
// comment: "pull-merge, applyRemote, recovery restore, and UI import all inherit it
// through here"), so the decrypt seam lives there — one place, four callers.
import { describe, expect, it } from 'vitest';
import { USERDB_FILE, USERDB_LIMITS } from '@snugprotocol/protocol';

import { createMemoryBackend } from '../../persistence.js';
import { openUserDb } from '../../userdb/userdb.js';
import { encryptContainer, generateRecoveryKey } from '../container.js';
import { locateWasm } from '../../__tests__/helpers.js';

const PASS = 'the passphrase the user typed on device A';

/** Device A: build a real file, then hand back the sealed bytes as they would sync. */
async function sealedFromDeviceA(recoveryKey: string): Promise<Uint8Array> {
  const backend = createMemoryBackend();
  const a = await openUserDb({ backend, locateWasm });
  if (a.status !== 'ok') throw new Error('device A failed to open');
  a.userDb.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' });
  const plain = await a.userDb.exportUserDb({ includeSecrets: true });
  await a.userDb.close();
  return encryptContainer(plain, { passphrase: PASS, recoveryKey });
}

/** Device B: a brand-new install — empty backend, no settings, no key. */
async function deviceB() {
  const backend = createMemoryBackend();
  const b = await openUserDb({ backend, locateWasm });
  if (b.status !== 'ok') throw new Error('device B failed to open');
  return { backend, db: b.userDb };
}

describe('a protected file pulled onto a second device (AC18, AC24)', () => {
  it('imports when the passphrase is supplied — the container carries everything else', async () => {
    const sealed = await sealedFromDeviceA(generateRecoveryKey());
    const { db } = await deviceB();

    await db.importUserDb(sealed, { trustedOrigin: true, secrets: { passphrase: PASS } });
    expect(db.listApps().map((a) => a.displayName)).toEqual(['Ledger']);
    await db.close();
  });

  it('imports with the Recovery Key alone', async () => {
    const recoveryKey = generateRecoveryKey();
    const sealed = await sealedFromDeviceA(recoveryKey);
    const { db } = await deviceB();

    await db.importUserDb(sealed, { trustedOrigin: true, secrets: { recoveryKey } });
    expect(db.listApps().map((a) => a.displayName)).toEqual(['Ledger']);
    await db.close();
  });
});

describe('a protected file the device cannot open (AC19)', () => {
  it('fails with a LOCKED-shaped error and leaves local state untouched', async () => {
    const sealed = await sealedFromDeviceA(generateRecoveryKey());
    const { db } = await deviceB();
    db.installApp({ displayName: 'LocalWork', html: '<!doctype html><title>local</title>' });

    // No secret at all — the ordinary case for an automatic sync pull.
    await expect(db.importUserDb(sealed, { trustedOrigin: true })).rejects.toThrow(/protected|locked|passphrase/i);

    // ADR-0009: pull is a merge, never a swap. An unopenable remote image must never
    // become a reason to discard what is already here.
    expect(db.listApps().map((a) => a.displayName)).toEqual(['LocalWork']);
    await db.close();
  });

  it('fails the same way for a WRONG secret, still without clobbering local', async () => {
    const sealed = await sealedFromDeviceA(generateRecoveryKey());
    const { db } = await deviceB();
    db.installApp({ displayName: 'LocalWork', html: '<!doctype html><title>local</title>' });

    await expect(
      db.importUserDb(sealed, { trustedOrigin: true, secrets: { passphrase: 'wrong' } }),
    ).rejects.toThrow(/protected|locked|passphrase/i);
    expect(db.listApps().map((a) => a.displayName)).toEqual(['LocalWork']);
    await db.close();
  });

  it('a DAMAGED container reports damage, not a locked file (AC27)', async () => {
    const sealed = await sealedFromDeviceA(generateRecoveryKey());
    const { db } = await deviceB();
    const torn = sealed.slice(0, sealed.length - 32);

    await expect(db.importUserDb(torn, { trustedOrigin: true, secrets: { passphrase: PASS } })).rejects.toThrow(
      /damaged|corrupt|integrity/i,
    );
    await db.close();
  });
});

describe('plaintext imports are completely unaffected (D3 opt-in)', () => {
  it('an ordinary export still imports with no secrets argument', async () => {
    const backend = createMemoryBackend();
    const a = await openUserDb({ backend, locateWasm });
    if (a.status !== 'ok') throw new Error('x');
    a.userDb.installApp({ displayName: 'Plain', html: '<!doctype html><title>p</title>' });
    const plain = await a.userDb.exportUserDb({ includeSecrets: true });
    await a.userDb.close();

    const { db } = await deviceB();
    await db.importUserDb(plain, { trustedOrigin: true });
    expect(db.listApps().map((x) => x.displayName)).toEqual(['Plain']);
    await db.close();
  });
});

describe('the size cap counts CIPHERTEXT, which is bigger than plaintext (AC30 / review B9)', () => {
  it('a file near the cap is still importable once encrypted', async () => {
    // `importUserDb` checks `byteLength > maxBytes` BEFORE anything else, and a
    // container adds a header, two wrapped keys, an IV and a tag. Without accounting
    // for that expansion, a database that fits the cap becomes permanently
    // un-importable the moment its owner protects it — the file is fine, and Snug
    // simply refuses to open it. The cap must apply to the PLAINTEXT it protects.
    const sealed = await sealedFromDeviceA(generateRecoveryKey());
    const { db } = await deviceB();
    const plaintextSize = sealed.length - 300; // container overhead is ~284 bytes
    expect(sealed.length).toBeGreaterThan(plaintextSize);

    // Cap set just above the plaintext but BELOW the ciphertext: must still import.
    const tight = await openUserDb({
      backend: createMemoryBackend(),
      locateWasm,
      maxBytes: plaintextSize + 100,
    });
    if (tight.status !== 'ok') throw new Error('tight open failed');
    await expect(
      tight.userDb.importUserDb(sealed, { trustedOrigin: true, secrets: { passphrase: PASS } }),
    ).resolves.toBeDefined();
    await tight.userDb.close();
    await db.close();
  });

  it('still refuses a genuinely oversized payload', async () => {
    const { db } = await deviceB();
    const huge = new Uint8Array(USERDB_LIMITS.MAX_USERDB_BYTES + 1);
    await expect(db.importUserDb(huge, { trustedOrigin: true })).rejects.toThrow(/cap/i);
    await db.close();
  });
});
