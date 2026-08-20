// TASK-20260820 — what crosses the wire when the file is protected (AC15, AC20,
// AC32; owner decisions D5 and D6).
//
// TWO RULES, AND THEY PULL IN OPPOSITE DIRECTIONS.
//
// D5: a PERSONAL origin (the user's own Dropbox) receives ciphertext. That copy is the
// one most likely to fall into the wrong hands, which is the whole reason encryption
// was asked for.
//
// D6: a HUB origin keeps receiving secrets-stripped PLAINTEXT. ADR-0014 already
// guarantees hub copies carry no credentials, so it is the least sensitive copy, and
// teaching the server a new body format would change the /userdb contract and the spec
// for no privacy gain. `apps/server` stays untouched.
//
// The ordering rule underneath both: hash the PLAINTEXT for the change gate, then
// encrypt. Encrypting first would make every 30-second tick see fresh random bytes,
// conclude "changed", and push the entire database forever.
import { describe, expect, it, vi } from 'vitest';

import { createMemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../../userdb/userdb.js';
import { encryptContainer, generateRecoveryKey, isEncryptedContainer } from '../../crypto/container.js';
import { createSyncLoop } from '../loop.js';
import type { SyncProvider } from '../provider.js';
import { locateWasm } from '../../__tests__/helpers.js';

const PASS = 'the protecting passphrase';

/** A provider that records exactly what bytes it was handed. */
function recorder(kind: 'dropbox' | 'hub', secretsAllowed: boolean) {
  const pushes: Uint8Array[] = [];
  let revision = 0;
  const provider: SyncProvider = {
    info: () => ({ kind, secretsAllowed }),
    pull: () => Promise.resolve(undefined),
    push: (bytes) => {
      pushes.push(bytes.slice());
      return Promise.resolve({ ok: true as const, revision: `r${++revision}` });
    },
  };
  return { provider, pushes };
}

async function protectedDb(): Promise<{
  db: UserDb;
  backend: ReturnType<typeof createMemoryBackend>;
  seal: (bytes: Uint8Array) => Promise<Uint8Array>;
}> {
  const scratch = createMemoryBackend();
  const a = await openUserDb({ backend: scratch, locateWasm });
  if (a.status !== 'ok') throw new Error('seed');
  a.userDb.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' });
  const plain = await a.userDb.exportUserDb({ includeSecrets: true });
  await a.userDb.close();

  const backend = createMemoryBackend();
  await backend.save('user.snug', await encryptContainer(plain, { passphrase: PASS, recoveryKey: generateRecoveryKey() }));
  const opened = await openUserDb({ backend, locateWasm, secrets: { passphrase: PASS } });
  if (opened.status !== 'ok') throw new Error('open');
  // The composition root hands the loop the SAME session sealer the write-back uses.
  return { db: opened.userDb, backend, seal: opened.userDb.sealForOrigin! };
}

describe('a personal origin receives CIPHERTEXT (D5, AC15)', () => {
  it('pushes a container, not a readable database', async () => {
    const { db, backend, seal } = await protectedDb();
    const { provider, pushes } = recorder('dropbox', true);
    const loop = createSyncLoop({ userDb: db, provider, backend, includeSecrets: true, sealForOrigin: seal });

    await loop.syncNow();
    expect(pushes).toHaveLength(1);
    // The bytes sitting in the user's Dropbox must not be an openable SQLite file.
    expect(isEncryptedContainer(pushes[0]!)).toBe(true);
    expect(new TextDecoder().decode(pushes[0]!.slice(0, 6))).not.toBe('SQLite');
    await db.close();
  });

  it('the change gate still short-circuits an unchanged database (AC15, AC20)', async () => {
    // THE TRAP: encryption uses a fresh random IV every time, so ciphertext differs on
    // every call even when nothing changed. Hashing the ciphertext would make every
    // tick look dirty and push the whole file forever — burning the user's bandwidth
    // and Dropbox quota on identical data. The hash must be taken over the PLAINTEXT.
    const { db, backend, seal } = await protectedDb();
    const { provider, pushes } = recorder('dropbox', true);
    const loop = createSyncLoop({ userDb: db, provider, backend, includeSecrets: true, sealForOrigin: seal });

    await loop.syncNow();
    await loop.syncNow();
    await loop.syncNow();
    expect(pushes).toHaveLength(1);
    await db.close();
  });

  it('re-pushes once the database actually changes', async () => {
    const { db, backend, seal } = await protectedDb();
    const { provider, pushes } = recorder('dropbox', true);
    const loop = createSyncLoop({ userDb: db, provider, backend, includeSecrets: true, sealForOrigin: seal });

    await loop.syncNow();
    db.installApp({ displayName: 'Second', html: '<!doctype html><title>s</title>' });
    await db.flush();
    await loop.syncNow();
    expect(pushes).toHaveLength(2);
    await db.close();
  });

  it('does not re-key between pushes — yesterday’s secret still opens today’s copy (AC20)', async () => {
    const { db, backend, seal } = await protectedDb();
    const { provider, pushes } = recorder('dropbox', true);
    const loop = createSyncLoop({ userDb: db, provider, backend, includeSecrets: true, sealForOrigin: seal });

    await loop.syncNow();
    db.installApp({ displayName: 'Second', html: '<!doctype html><title>s</title>' });
    await db.flush();
    await loop.syncNow();

    // A second device that learned the passphrase once must keep working. Rotating the
    // file key on every push would silently strand it.
    const fresh = await openUserDb({ backend: createMemoryBackend(), locateWasm });
    if (fresh.status !== 'ok') throw new Error('x');
    await expect(
      fresh.userDb.importUserDb(pushes[1]!, { trustedOrigin: true, secrets: { passphrase: PASS } }),
    ).resolves.toBeDefined();
    await fresh.userDb.close();
    await db.close();
  });
});

describe('a hub origin keeps receiving PLAINTEXT (D6)', () => {
  it('pushes an ordinary SQLite image, so apps/server and the /userdb contract are untouched', async () => {
    const { db, backend, seal } = await protectedDb();
    const { provider, pushes } = recorder('hub', false);
    const loop = createSyncLoop({ userDb: db, provider, backend, sealForOrigin: seal });

    await loop.syncNow();
    expect(pushes).toHaveLength(1);
    // The server validates the SQLite magic and would 400 on a container. ADR-0014
    // already keeps credentials out of hub copies, so this is the least sensitive one.
    expect(isEncryptedContainer(pushes[0]!)).toBe(false);
    expect(new TextDecoder().decode(pushes[0]!.slice(0, 6))).toBe('SQLite');
    await db.close();
  });
});

describe('an unprotected file is unchanged everywhere (D3 opt-in)', () => {
  it('pushes plaintext to a personal origin exactly as before', async () => {
    const backend = createMemoryBackend();
    const opened = await openUserDb({ backend, locateWasm });
    if (opened.status !== 'ok') throw new Error('x');
    opened.userDb.installApp({ displayName: 'Plain', html: '<!doctype html><title>p</title>' });
    const { provider, pushes } = recorder('dropbox', true);
    const loop = createSyncLoop({ userDb: opened.userDb, provider, backend, includeSecrets: true });

    await loop.syncNow();
    expect(isEncryptedContainer(pushes[0]!)).toBe(false);
    await opened.userDb.close();
  });
});
