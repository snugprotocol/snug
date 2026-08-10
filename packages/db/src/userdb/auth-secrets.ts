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

// ------------------------------------------------- v4 slot-keyed builders (Dynamic Auth v2)
//
// v4 puts a SLOT between the app and the field (`auth:<appId>:<slot>:<fieldKey>`) because
// v3's shape had no room for one — `snug_auth_specs.app_id` was the whole primary key, so
// one app could hold exactly one connection and "Dropbox + OneDrive in one app" (R6) was
// structurally unrepresentable, not merely discouraged.
//
// ADDITIVE, per the P0 cutover rule (fold B1): the non-slot builders above KEEP SHIPPING
// — packages/auth and the playground still write through them against `snug_auth_specs`
// until P3 rewires the last consumer. The two shapes therefore coexist in one namespace,
// which is exactly why `isLegacyAppSecretKey` below has to distinguish them by
// SEGMENT COUNT rather than by prefix.

/** `auth:<appId>:<slot>:` — the per-slot slice (the revoke wipe's exact scope). */
export function authConnectionSlotPrefix(appId: string, slot: string): string {
  return `${authAppSecretPrefix(appId)}${requireNonEmpty(slot, 'slot')}:`;
}

/** `auth:<appId>:<slot>:<fieldKey>` — one v4 credential value (api_key, api_secret, …). */
export function authConnectionCredentialSecretKey(appId: string, slot: string, field: string): string {
  return `${authConnectionSlotPrefix(appId, slot)}${requireNonEmpty(field, 'field')}`;
}

/** `auth:<appId>:<slot>:_connection` — v4 dynamic connection state for one slot. */
export function authConnectionStateSecretKey(appId: string, slot: string): string {
  return authConnectionCredentialSecretKey(appId, slot, AUTH_CONNECTION_FIELD);
}

/**
 * Matches ONLY the v3-era non-slot app keys — `auth:<appId>:<field>`, exactly THREE
 * colon-separated segments — and never the v4 four-segment slot keys (fold T-M4).
 *
 * Segment count is the discriminator because prefix matching cannot work here: both
 * shapes start with `auth:<appId>:`, so the naive prefix delete that the wipe is written
 * as would also take every LIVE v4 credential and disconnect every connected app on the
 * next hub start. It is also why the wipe is a JS-side filter rather than a SQL
 * `LIKE 'auth:<appId>:%'` — that pattern cannot count segments.
 *
 * The app-agnostic keys (`auth:_state_hmac`, `auth:_flow:<flowId>`) survive by
 * construction: the first is two segments, and the second's second segment is the
 * reserved `_flow` marker, which is excluded explicitly rather than by luck.
 */
export function isLegacyAppSecretKey(key: string): boolean {
  if (!isAuthSecretKey(key)) return false;
  const segments = key.split(':');
  // ['auth', '<appId>', '<field>'] — a fourth segment means this is a v4 slot key.
  if (segments.length !== 3) return false;
  // `auth:_flow:<flowId>` is also three segments; it is per-USER state, not per-app.
  return segments[1] !== '_flow';
}

/** `auth:_flow:<flowId>` — a pending OAuth flow spilled out of memory. */
export function authFlowSecretKey(flowId: string): string {
  return `${AUTH_FLOW_SECRET_PREFIX}${requireNonEmpty(flowId, 'flowId')}`;
}

/** True for any key in the Dynamic Auth namespace. */
export function isAuthSecretKey(key: string): boolean {
  return key.startsWith(AUTH_SECRET_PREFIX);
}
