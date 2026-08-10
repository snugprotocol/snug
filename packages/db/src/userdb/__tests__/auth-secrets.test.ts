// AL-02: the `auth:` secrets-namespace helpers — the ONE definition of the key shapes
// shared with packages/auth (lesson 2026-08-03: shared literals live in a constants
// module one side imports, never retyped).
import { describe, expect, it } from 'vitest';
import { AUTH_SECRET_PREFIX } from '@snugprotocol/protocol';
import {
  AUTH_CONNECTION_FIELD,
  AUTH_FLOW_SECRET_PREFIX,
  AUTH_STATE_HMAC_SECRET_KEY,
  authAppSecretPrefix,
  authConnectionCredentialSecretKey,
  authConnectionSecretKey,
  authConnectionSlotPrefix,
  authConnectionStateSecretKey,
  authCredentialSecretKey,
  authFlowSecretKey,
  isAuthSecretKey,
  isLegacyAppSecretKey,
} from '../auth-secrets.js';

describe('auth secrets namespace (plan D3/N3)', () => {
  it('builds credential keys as auth:<appId>:<field>', () => {
    expect(authCredentialSecretKey('app-1', 'access_token')).toBe('auth:app-1:access_token');
    expect(authCredentialSecretKey('app-1', 'client_id')).toBe('auth:app-1:client_id');
  });

  it('builds the connection-state key as auth:<appId>:_connection (never a table column)', () => {
    expect(AUTH_CONNECTION_FIELD).toBe('_connection');
    expect(authConnectionSecretKey('app-1')).toBe('auth:app-1:_connection');
    expect(authConnectionSecretKey('app-1')).toBe(authCredentialSecretKey('app-1', AUTH_CONNECTION_FIELD));
  });

  it('builds flow-spill keys as auth:_flow:<flowId> and pins the state-HMAC key', () => {
    expect(AUTH_FLOW_SECRET_PREFIX).toBe('auth:_flow:');
    expect(authFlowSecretKey('f-abc')).toBe('auth:_flow:f-abc');
    expect(AUTH_STATE_HMAC_SECRET_KEY).toBe('auth:_state_hmac');
  });

  it('every helper output sits under the protocol AUTH_SECRET_PREFIX (one definition)', () => {
    for (const key of [
      authCredentialSecretKey('a', 'f'),
      authConnectionSecretKey('a'),
      authFlowSecretKey('x'),
      AUTH_STATE_HMAC_SECRET_KEY,
      authAppSecretPrefix('a'),
    ]) {
      expect(key.startsWith(AUTH_SECRET_PREFIX)).toBe(true);
      expect(isAuthSecretKey(key)).toBe(true);
    }
    expect(isAuthSecretKey('byok:anthropic')).toBe(false);
  });

  it('rejects empty parts (a malformed key must fail loudly, not collide)', () => {
    expect(() => authCredentialSecretKey('', 'f')).toThrow();
    expect(() => authCredentialSecretKey('a', '')).toThrow();
    expect(() => authFlowSecretKey('')).toThrow();
  });
});

// TASK-20260810 P0 (Dynamic Auth v2): the SLOT-KEYED builders. Additive — every v3
// assertion above keeps shipping unchanged, because packages/auth still writes through
// the non-slot builders until P3 rewires its last consumer (cutover rule, fold B1).
describe('auth secrets namespace — v4 slot-keyed shape (TASK-20260810 P0)', () => {
  it('builds credential keys as auth:<appId>:<slot>:<fieldKey>', () => {
    expect(authConnectionCredentialSecretKey('app-1', 'coinbase', 'api_secret')).toBe(
      'auth:app-1:coinbase:api_secret',
    );
    expect(authConnectionSlotPrefix('app-1', 'coinbase')).toBe('auth:app-1:coinbase:');
    expect(authConnectionStateSecretKey('app-1', 'coinbase')).toBe('auth:app-1:coinbase:_connection');
    expect(authConnectionStateSecretKey('app-1', 'coinbase')).toBe(
      authConnectionCredentialSecretKey('app-1', 'coinbase', AUTH_CONNECTION_FIELD),
    );
  });

  it('keeps the two shapes distinct — one app, two slots, no key collides with the v3 key', () => {
    // R6's motivating shape: several providers in one app. Under v3 these were
    // structurally impossible (app_id was the whole PK); the slot segment is what makes
    // them addressable, so a collision here would silently cross two providers' secrets.
    const dropbox = authConnectionCredentialSecretKey('app-1', 'dropbox', 'token');
    const onedrive = authConnectionCredentialSecretKey('app-1', 'onedrive', 'token');
    expect(dropbox).not.toBe(onedrive);
    expect(dropbox).not.toBe(authCredentialSecretKey('app-1', 'token'));
    expect(dropbox.startsWith(authAppSecretPrefix('app-1'))).toBe(true);
    expect(isAuthSecretKey(dropbox)).toBe(true);
  });

  it('rejects an empty slot (a missing slot must not silently produce the v3 key shape)', () => {
    // Without this guard `slot === ''` would build `auth:app-1::token`, which is neither
    // shape and which `isLegacyAppSecretKey` would not classify as legacy — a key that
    // nothing lists, reads, or wipes. Exactly the orphan class T-M4 exists to end.
    expect(() => authConnectionSlotPrefix('app-1', '')).toThrow();
    expect(() => authConnectionCredentialSecretKey('app-1', 'coinbase', '')).toThrow();
    expect(() => authConnectionCredentialSecretKey('', 'coinbase', 'token')).toThrow();
  });

  it('isLegacyAppSecretKey matches ONLY the v3 non-slot app keys (fold T-M4 scoping)', () => {
    // The wipe's whole safety rests on this discriminator. A prefix test cannot work —
    // both shapes start `auth:<appId>:` — so it counts SEGMENTS, and these cases are the
    // ones that would each turn the cleanup into a live-credential deletion.
    expect(isLegacyAppSecretKey(authCredentialSecretKey('app-1', 'api_key'))).toBe(true);
    expect(isLegacyAppSecretKey(authConnectionSecretKey('app-1'))).toBe(true);

    // v4 slot keys are FOUR segments — never legacy, or the wipe disconnects every
    // connected app on the next hub start.
    expect(isLegacyAppSecretKey(authConnectionCredentialSecretKey('app-1', 'coinbase', 'api_key'))).toBe(false);
    expect(isLegacyAppSecretKey(authConnectionStateSecretKey('app-1', 'coinbase'))).toBe(false);

    // App-agnostic per-user keys survive: `_state_hmac` is two segments, and `_flow` is
    // three but is excluded explicitly rather than by luck.
    expect(isLegacyAppSecretKey(AUTH_STATE_HMAC_SECRET_KEY)).toBe(false);
    expect(isLegacyAppSecretKey(authFlowSecretKey('flow-123'))).toBe(false);
    expect(isLegacyAppSecretKey(`${AUTH_FLOW_SECRET_PREFIX}f-abc`)).toBe(false);

    // Other namespaces are outside the rule entirely.
    expect(isLegacyAppSecretKey('byok:anthropic')).toBe(false);
    expect(isLegacyAppSecretKey('sync:dropbox:token')).toBe(false);
  });
});
