// AL-02 AC4/D4: the CredentialStore seam — the ONLY reader of `auth:` values — and its
// UserDb-backed implementation over the secrets quartet. Key shapes come from
// @snugprotocol/db's auth-secrets helpers (one definition, never retyped).
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_STATE_HMAC_SECRET_KEY,
  authConnectionSecretKey,
  authCredentialSecretKey,
  createMemoryBackend,
  openUserDb,
  type MemoryBackend,
  type UserDb,
} from '@snugprotocol/db';
import { UserDbCredentialStore, type AuthConnectionState } from '../credential-store.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

let backend: MemoryBackend;
let db: UserDb;
let store: UserDbCredentialStore;

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
  store = new UserDbCredentialStore(db);
});

describe('UserDbCredentialStore — credential values', () => {
  it('writes under auth:<appId>:<field> and reads back', async () => {
    await store.setCredential('app-1', 'api_key', 'K-123');
    expect(await store.getCredential('app-1', 'api_key')).toBe('K-123');
    expect(db.getSecret(authCredentialSecretKey('app-1', 'api_key'))).toBe('K-123');
  });

  it('lists only the app credential fields (connection state excluded)', async () => {
    await store.setCredential('app-1', 'client_id', 'CID');
    await store.setCredential('app-1', 'access_token', 'AT');
    await store.setConnectionState('app-1', { status: 'connected', obtainedAt: 1, expiresIn: 60 });
    await store.setCredential('other-app', 'token', 'T');
    expect((await store.listCredentialFields('app-1')).sort()).toEqual(['access_token', 'client_id']);
  });

  it('deleteCredential removes exactly one field', async () => {
    await store.setCredential('app-1', 'a', '1');
    await store.setCredential('app-1', 'b', '2');
    await store.deleteCredential('app-1', 'a');
    expect(await store.getCredential('app-1', 'a')).toBeUndefined();
    expect(await store.getCredential('app-1', 'b')).toBe('2');
  });

  it('clearApp wipes the whole auth:<appId>:* slice but not other apps or the hmac key', async () => {
    await store.setCredential('app-1', 'access_token', 'AT');
    await store.setConnectionState('app-1', { status: 'connected', obtainedAt: 1, expiresIn: 60 });
    await store.setCredential('other-app', 'token', 'T');
    await store.getOrCreateStateHmacKey();
    await store.clearApp('app-1');
    expect(await store.getCredential('app-1', 'access_token')).toBeUndefined();
    expect(await store.getConnectionState('app-1')).toBeUndefined();
    expect(await store.getCredential('other-app', 'token')).toBe('T');
    expect(db.getSecret(AUTH_STATE_HMAC_SECRET_KEY)).toBeDefined();
  });
});

describe('UserDbCredentialStore — connection state (plan N3: a secret, never a table row)', () => {
  it('round-trips typed connection state at auth:<appId>:_connection', async () => {
    const state: AuthConnectionState = {
      status: 'connected',
      obtainedAt: 1720000000000,
      expiresIn: 3600,
      scopesGranted: ['user-read-private'],
    };
    await store.setConnectionState('app-1', state);
    expect(await store.getConnectionState('app-1')).toEqual(state);
    expect(db.getSecret(authConnectionSecretKey('app-1'))).toBeDefined();
  });

  it('returns undefined for corrupt state instead of throwing (fail-safe read)', async () => {
    db.setSecret(authConnectionSecretKey('app-1'), 'not json');
    expect(await store.getConnectionState('app-1')).toBeUndefined();
  });
});

describe('UserDbCredentialStore — the per-user state HMAC key (finding 11)', () => {
  it('generates once, then reuses (stable across store instances over the same db)', async () => {
    const first = await store.getOrCreateStateHmacKey();
    const second = await store.getOrCreateStateHmacKey();
    expect(second).toBe(first);
    const other = new UserDbCredentialStore(db);
    expect(await other.getOrCreateStateHmacKey()).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
  });

  it('stores it at auth:_state_hmac — which the default export strips (custody test in packages/db)', async () => {
    const key = await store.getOrCreateStateHmacKey();
    expect(db.getSecret(AUTH_STATE_HMAC_SECRET_KEY)).toBe(key);
  });
});
