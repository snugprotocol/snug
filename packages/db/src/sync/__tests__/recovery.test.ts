// Child-4 AC5 (TASK-20260803-sync-origins): fail-closed corruption recovery — a corrupt
// local user DB is quarantined by openUserDb (F6); restoreFromOrigin then pulls the
// origin image into the explicitly-opened fresh DB. It NEVER pushes: after a recovery
// the origin is the only good copy, and auto-pushing a half-restored image could
// destroy it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../../userdb/userdb.js';
import { encryptContainer, generateRecoveryKey } from '../../crypto/container.js';
import { restoreFromOrigin } from '../recovery.js';
import type { SyncProvider } from '../provider.js';

const providerWith = (image: { bytes: Uint8Array; revision: string } | undefined): SyncProvider & {
  push: ReturnType<typeof vi.fn>;
} => {
  const push = vi.fn(() => Promise.reject(new Error('restoreFromOrigin must never push')));
  return {
    info: () => ({ kind: 'fake', secretsAllowed: false }),
    pull: () => Promise.resolve(image === undefined ? undefined : { ...image, bytes: image.bytes.slice() }),
    push,
  };
};

/** Corrupts the stored user DB and returns the corrupt-open result's openFresh. */
async function corruptOpen(backend: MemoryBackend): Promise<() => Promise<UserDb>> {
  await backend.save(USERDB_FILE, new TextEncoder().encode('garbage-not-sqlite'));
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'corrupt') throw new Error(`expected corrupt open, got ${result.status}`);
  return result.openFresh;
}

let backend: MemoryBackend;
beforeEach(() => {
  backend = createMemoryBackend();
});

describe('restoreFromOrigin (AC5, F6)', () => {
  it('imports the origin image into the fresh DB and NEVER calls provider.push', async () => {
    const scratch = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (scratch.status !== 'ok') throw new Error('scratch open failed');
    scratch.userDb.setSetting('who', 'origin-copy');
    const image = await scratch.userDb.exportUserDb();
    await scratch.userDb.close();

    const provider = providerWith({ bytes: image, revision: 'r7' });
    const openFresh = await corruptOpen(backend);
    const result = await restoreFromOrigin({ provider, openFresh });

    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(result.revision).toBe('r7');
    expect(result.userDb.getSetting('who')).toBe('origin-copy');
    expect(provider.push).not.toHaveBeenCalled();
    expect([...backend.files.keys()].some((f) => /\.corrupt-[a-z0-9]+\.bak$/.test(f))).toBe(true); // quarantine retained
    await result.userDb.close();
  });

  it('reports an empty origin without opening a fresh DB (caller decides what happens next)', async () => {
    const provider = providerWith(undefined);
    const openFresh = vi.fn(() => Promise.reject(new Error('must not be called')));
    const result = await restoreFromOrigin({ provider, openFresh });
    expect(result).toEqual({ status: 'origin-empty' });
    expect(openFresh).not.toHaveBeenCalled();
    expect(provider.push).not.toHaveBeenCalled();
  });

  it('reports unusable origin bytes as failed (errors-as-data) and still never pushes', async () => {
    const provider = providerWith({ bytes: new TextEncoder().encode('also-garbage'), revision: 'r1' });
    const openFresh = await corruptOpen(backend);
    const result = await restoreFromOrigin({ provider, openFresh });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.message.length).toBeGreaterThan(0);
    expect(provider.push).not.toHaveBeenCalled();
  });
});

describe('restoring from a PROTECTED origin (diff review D-4)', () => {
  /** An origin image that is a container, as a personal origin now carries (ADR-0043 D5). */
  async function sealedOriginImage(passphrase: string, recoveryKey: string): Promise<Uint8Array> {
    const scratch = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (scratch.status !== 'ok') throw new Error('scratch open failed');
    scratch.userDb.installApp({ displayName: 'FromOrigin', html: '<!doctype html><title>o</title>' });
    const plain = await scratch.userDb.exportUserDb({ includeSecrets: true });
    await scratch.userDb.close();
    return encryptContainer(plain, { passphrase, recoveryKey });
  }

  it('restores when the secrets are supplied', async () => {
    const passphrase = 'the passphrase the user just typed to unlock';
    const bytes = await sealedOriginImage(passphrase, generateRecoveryKey());
    const openFresh = await corruptOpen(backend);

    const result = await restoreFromOrigin({
      provider: providerWith({ bytes, revision: 'r1' }),
      openFresh,
      secrets: { passphrase },
    });
    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    expect(result.userDb.listApps().map((a) => a.displayName)).toEqual(['FromOrigin']);
    await result.userDb.close();
  });

  it('fails HONESTLY when they are not — never silently, never as generic corruption', async () => {
    // Without secrets this path was simply dead: the user's local file is already
    // quarantined, so a mute failure here strands them at the exact moment recovery is
    // the only thing left. The message has to say what to do about it.
    const bytes = await sealedOriginImage('a passphrase', generateRecoveryKey());
    const openFresh = await corruptOpen(backend);

    const result = await restoreFromOrigin({ provider: providerWith({ bytes, revision: 'r1' }), openFresh });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.message).toMatch(/protected|passphrase|Recovery Key/i);
  });

  it('a PLAINTEXT origin still restores with no secrets at all', async () => {
    const scratch = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (scratch.status !== 'ok') throw new Error('x');
    scratch.userDb.installApp({ displayName: 'Plain', html: '<!doctype html><title>p</title>' });
    const bytes = await scratch.userDb.exportUserDb({ includeSecrets: true });
    await scratch.userDb.close();

    const openFresh = await corruptOpen(backend);
    const result = await restoreFromOrigin({ provider: providerWith({ bytes, revision: 'r1' }), openFresh });
    expect(result.status).toBe('restored');
    if (result.status !== 'restored') return;
    await result.userDb.close();
  });
});
