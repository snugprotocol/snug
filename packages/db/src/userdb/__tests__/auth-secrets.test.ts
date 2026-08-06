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
  authConnectionSecretKey,
  authCredentialSecretKey,
  authFlowSecretKey,
  isAuthSecretKey,
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
