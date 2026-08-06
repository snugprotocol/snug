// The `auth:` secrets namespace (AL-02, ADR-0014 clause 6 / plan D3+N3): every Dynamic
// Auth VALUE lives in `snug_secrets` under these keys — credential fields, dynamic
// connection state, spilled pending-flow state, and the per-user state-HMAC key. Spec
// METADATA lives in `snug_auth_specs`; nothing here ever touches that table.
//
// This module is the ONE definition of the key shapes. packages/auth imports these
// builders — the literals are never retyped (lesson 2026-08-03: shared contracts fork
// when "roughly specified").
import { AUTH_SECRET_PREFIX } from '@snugprotocol/protocol';

/** The per-user state-signing HMAC key (32 random bytes, base64url). Reused for NOTHING else. */
export const AUTH_STATE_HMAC_SECRET_KEY = `${AUTH_SECRET_PREFIX}_state_hmac`;

/** Prefix for spilled pending-flow state rows (`auth:_flow:<flowId>`), TTL-cleaned. */
export const AUTH_FLOW_SECRET_PREFIX = `${AUTH_SECRET_PREFIX}_flow:`;

/** The reserved field name holding dynamic connection state (JSON) for an app. */
export const AUTH_CONNECTION_FIELD = '_connection';

function requireNonEmpty(value: string, what: string): string {
  if (value.length === 0) throw new Error(`${what} must be non-empty`);
  return value;
}

/** `auth:<appId>:` — the per-app slice of the namespace (prefix deletes, custody probes). */
export function authAppSecretPrefix(appId: string): string {
  return `${AUTH_SECRET_PREFIX}${requireNonEmpty(appId, 'appId')}:`;
}

/** `auth:<appId>:<field>` — one credential value (access_token, client_secret, api_key, …). */
export function authCredentialSecretKey(appId: string, field: string): string {
  return `${authAppSecretPrefix(appId)}${requireNonEmpty(field, 'field')}`;
}

/** `auth:<appId>:_connection` — dynamic connection state (obtained_at/expires_in/status/lastError/scopesGranted). */
export function authConnectionSecretKey(appId: string): string {
  return authCredentialSecretKey(appId, AUTH_CONNECTION_FIELD);
}

/** `auth:_flow:<flowId>` — a pending OAuth flow spilled out of memory. */
export function authFlowSecretKey(flowId: string): string {
  return `${AUTH_FLOW_SECRET_PREFIX}${requireNonEmpty(flowId, 'flowId')}`;
}

/** True for any key in the Dynamic Auth namespace. */
export function isAuthSecretKey(key: string): boolean {
  return key.startsWith(AUTH_SECRET_PREFIX);
}
