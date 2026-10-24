/**
 * "Use my ChatGPT plan" — the wire as measured (TASK-20261023-siwc-chatgpt-plan, ADR-0078 §3).
 *
 * The constants the spike recorded against OpenAI's sign-in service and API, and the PURE
 * helpers over its answers: the discovery document's trust check, the token endpoint's replies
 * (a sign-in exchange and a refresh read differently — RFC 6749 §6 lets a refresh omit what a
 * first issue must carry), the model list, and the file-shape helpers the keeper derives its
 * status from. No I/O, no state: everything here is a function of its arguments, which is what
 * keeps the keeper in `chatgpt-plan.ts` readable and these rules testable on their own.
 */

import { isUrlWithinHosts } from './app-host-freeze.js';
import { bytesToHex } from './base64url.js';
import type { ChatgptModel, ChatgptPlanStatus, ChatgptSessionFile, ChatgptSessionTokens } from './chatgpt-plan-types.js';
import { isRecord } from './records.js';

// ------------------------------------------------------------------ the wire, as measured

/** OpenAI's issuer; every token's `iss`, the discovery document's `issuer` and every endpoint's host answer to it. */
export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const AUTH_HOST = 'auth.openai.com';
export const DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;
/** The API base is pinned (ADR-0078 §3): `backend-api` is never called. */
export const CHATGPT_API_RESOURCE = 'https://api.openai.com/v1';
export const MODELS_URL = `${CHATGPT_API_RESOURCE}/models`;
/** The sign-in's redirect path — exactly this, never `/callback` (AC2). */
export const CHATGPT_CALLBACK_PATH = '/auth/callback';
/** The reserved app id the signed state names; the loopback core peeks it to route the delivery (D10). */
export const CHATGPT_PLAN_APP_ID = 'chatgpt-plan';
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const AGENT_NAME_HINT = 'Snug';
/** The one scope that lets requests spend the plan; its absence is the named "plan not granted" state (AC3). */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', CHATGPT_PLAN_SCOPE, 'resource.invoke'] as const;

export const REFRESH_WINDOW_MS = 60_000;
export const REFRESH_TIMEOUT_MS = 15_000;
export const REVOKE_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRES_IN_S = 3600;

/**
 * Refresh answers that mean the session is gone for good: tokens cleared, registration kept,
 * sign-in needed. `invalid_grant` / `refresh_token_reused` were measured; `invalid_client` /
 * `unauthorized_client` are a ChatGPT-side deleted client (the remedy is "forget this
 * registration", AC9); `refresh_token_expired` / `refresh_token_invalidated` joined at Gate 5
 * (G5-C5) — the two spellings OpenAI's envelopes use for the same end.
 */
export const TERMINAL_REFRESH_CODES: ReadonlySet<string> = new Set([
  'invalid_grant',
  'refresh_token_reused',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'invalid_client',
  'unauthorized_client',
]);

export const NETWORK_MESSAGE = "Couldn't reach ChatGPT's sign-in service — check your connection and try again.";
export const SIGN_IN_NEEDED_MESSAGE = 'Sign in with ChatGPT to use your plan.';
export const ID_TOKEN_REFUSED_MESSAGE = "ChatGPT's identity token didn't check out — sign in again.";
export const REDIRECT_REFUSED_MESSAGE = "ChatGPT's token service answered with a redirect — refused.";
export const INCOMPLETE_REPLY_MESSAGE = "ChatGPT's token reply was incomplete — try again.";
export const OFF_HOST_MESSAGE = `ChatGPT's sign-in service named an endpoint outside https://${AUTH_HOST} — refused.`;
export const ISSUER_REFUSED_MESSAGE = "ChatGPT's sign-in service named another issuer — refused.";
export const PLAN_NOT_GRANTED_MESSAGE = "Your ChatGPT account didn't allow plan usage for Snug — allow it in Settings.";

// ----------------------------------------------------------------------------- discovery

export interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
}

/** A discovery endpoint Snug will talk to: a string, https, and exactly on `host`. Anything else is refused unseen. */
export function trustedEndpoint(value: unknown, host: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  return isUrlWithinHosts(value, [host]) ? value : undefined;
}

/**
 * The discovery document, trusted or refused by name: its `issuer` must be OpenAI's (a document
 * that names another issuer is another service, however the endpoints look — Gate 5 §6 gap),
 * and the three endpoints the keeper calls must be https on `auth.openai.com`. The revocation
 * endpoint is optional and simply dropped when it is not.
 */
export function parseDiscovery(body: unknown): { ok: true; doc: Discovery } | { ok: false; reason: 'shape' | 'issuer' | 'host' } {
  if (!isRecord(body)) return { ok: false, reason: 'shape' };
  if (body['issuer'] !== CHATGPT_ISSUER) return { ok: false, reason: 'issuer' };
  const authorizationEndpoint = trustedEndpoint(body['authorization_endpoint'], AUTH_HOST);
  const tokenEndpoint = trustedEndpoint(body['token_endpoint'], AUTH_HOST);
  const jwksUri = trustedEndpoint(body['jwks_uri'], AUTH_HOST);
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined || jwksUri === undefined) return { ok: false, reason: 'host' };
  const revocationEndpoint = trustedEndpoint(body['revocation_endpoint'], AUTH_HOST);
  return { ok: true, doc: { authorizationEndpoint, tokenEndpoint, jwksUri, ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}) } };
}

// ------------------------------------------------------------------------- token replies

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
  scopes: readonly string[];
  earliestRefreshAt?: number;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function splitScopes(scope: string): string[] {
  return scope.split(/\s+/).filter((s) => s.length > 0);
}

function expiresInOf(body: Record<string, unknown>): number {
  const value = body['expires_in'];
  return typeof value === 'number' && value > 0 ? value : DEFAULT_EXPIRES_IN_S;
}

/** `earliest_refresh_at` arrives in epoch SECONDS (measured) or ISO; the file keeps milliseconds like every other instant. */
function earliestRefreshAtOf(body: Record<string, unknown>): number | undefined {
  const floor = body['earliest_refresh_at'];
  if (typeof floor === 'number' && Number.isFinite(floor)) return floor * 1000;
  if (typeof floor === 'string') {
    const parsed = Date.parse(floor);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** A sign-in exchange's reply: every member required — a first issue without one of them is a failed sign-in, not a session. */
export function parseIssuedTokens(body: unknown, requestedScopes: readonly string[]): IssuedTokens | undefined {
  if (!isRecord(body)) return undefined;
  const accessToken = nonEmptyString(body['access_token']);
  const refreshToken = nonEmptyString(body['refresh_token']);
  const idToken = nonEmptyString(body['id_token']);
  if (accessToken === undefined || refreshToken === undefined || idToken === undefined) return undefined;
  const scope = body['scope'];
  const scopes = typeof scope === 'string' ? splitScopes(scope) : [...requestedScopes];
  const earliestRefreshAt = earliestRefreshAtOf(body);
  return { accessToken, refreshToken, idToken, expiresIn: expiresInOf(body), scopes, ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}) };
}

export function toSessionTokens(issued: IssuedTokens, now: number): ChatgptSessionTokens {
  return {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    idToken: issued.idToken,
    expiresAt: now + issued.expiresIn * 1000,
    ...(issued.earliestRefreshAt !== undefined ? { earliestRefreshAt: issued.earliestRefreshAt } : {}),
    scopes: [...issued.scopes],
  };
}

/** What a 2xx refresh reply asks the keeper to persist, and how much of a refresh it completes. */
export interface RefreshReply {
  /** The set to persist: every member the reply carried, the stored value where it did not. */
  tokens: ChatgptSessionTokens;
  /** `planGranted` as the reply's `scope` says; undefined when the reply named no scope (the stored flag stands) — S5. */
  planGranted: boolean | undefined;
  /** The reply carried an `id_token` to verify. Otherwise the stored one stands, marked unverified for the next use (G5-C7). */
  idTokenFresh: boolean;
  /** The reply carried a usable access token. Without one the rotation is still persisted, then the refresh fails as transient (S4). */
  complete: boolean;
}

/**
 * A refresh reply, read the way RFC 6749 §6 allows it to arrive: `refresh_token` may be omitted
 * (the stored one stays valid), `id_token` may be omitted (OIDC Core §12.2), and a reply that
 * rotated the refresh token while giving nothing else usable must still be persisted — the only
 * valid refresh token is the new one. A body that is not an object, or carries neither token,
 * is no reply at all: the caller keeps what it had. Pure: the caller decides what to write.
 */
export function parseRefreshReply(body: unknown, stored: ChatgptSessionTokens, now: number): RefreshReply | undefined {
  if (!isRecord(body)) return undefined;
  const accessToken = nonEmptyString(body['access_token']);
  const refreshToken = nonEmptyString(body['refresh_token']);
  if (accessToken === undefined && refreshToken === undefined) return undefined;
  if (accessToken === undefined) {
    return { tokens: { ...stored, refreshToken: refreshToken as string }, planGranted: undefined, idTokenFresh: false, complete: false };
  }
  const idToken = nonEmptyString(body['id_token']);
  const scope = body['scope'];
  const scopes = typeof scope === 'string' ? splitScopes(scope) : undefined;
  const earliestRefreshAt = earliestRefreshAtOf(body);
  const tokens: ChatgptSessionTokens = {
    accessToken,
    refreshToken: refreshToken ?? stored.refreshToken,
    idToken: idToken ?? stored.idToken,
    expiresAt: now + expiresInOf(body) * 1000,
    ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
    scopes: scopes ?? [...stored.scopes],
    ...(idToken === undefined ? { idTokenUnverified: true } : {}),
  };
  return {
    tokens,
    planGranted: scopes !== undefined ? scopes.includes(CHATGPT_PLAN_SCOPE) : undefined,
    idTokenFresh: idToken !== undefined,
    complete: true,
  };
}

export type RefreshFailureKind = 'not_ready' | 'terminal' | 'transient';

/**
 * How a non-2xx refresh answer ends (D4, G5-C5): `refresh_not_ready` asks for patience, tokens
 * kept; a terminal code — or a 401, whatever its body — means the session is gone; everything
 * else (an unknown 4xx, a 5xx) is transient and never erases a token. The code is whatever
 * `extractOauthErrorFromPost` read: RFC 6749's `error`, OpenAI's nested `error.code`, or a
 * top-level `code`.
 */
export function classifyRefreshFailure(httpStatus: number, code: string | undefined): RefreshFailureKind {
  if (code === 'refresh_not_ready') return 'not_ready';
  if (code !== undefined && TERMINAL_REFRESH_CODES.has(code)) return 'terminal';
  if (httpStatus === 401) return 'terminal';
  return 'transient';
}

// ------------------------------------------------------------------------------- the rest

export function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/** A v4 UUID URN from 16 random bytes — the host id's documented shape. */
export function uuidV4Urn(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(b);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** `/v1/models` as measured: `visibility:'list'` only, server order, OpenAI's own vocabulary (ADR-0070 §3/§4). */
export function parseModels(body: unknown): ChatgptModel[] | undefined {
  if (!isRecord(body) || !Array.isArray(body['models'])) return undefined;
  const out: ChatgptModel[] = [];
  for (const entry of body['models'] as unknown[]) {
    if (!isRecord(entry) || entry['visibility'] !== 'list') continue;
    const id = entry['slug'];
    const name = entry['display_name'];
    if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string') continue;
    const efforts: string[] = [];
    const levels = entry['supported_reasoning_levels'];
    for (const level of Array.isArray(levels) ? (levels as unknown[]) : []) {
      if (typeof level === 'string') efforts.push(level);
      else if (isRecord(level) && typeof level['effort'] === 'string') efforts.push(level['effort']);
    }
    const defaultEffort = entry['default_reasoning_level'];
    out.push({ id, name, efforts, ...(typeof defaultEffort === 'string' ? { defaultEffort } : {}) });
  }
  return out;
}

/** The registration-only file: what a sign-out, a terminal refresh failure or a refused ID token leave behind (D7). */
export function registrationOnly(file: ChatgptSessionFile): ChatgptSessionFile {
  return { v: 1, hostId: file.hostId, ...(file.clientId !== undefined ? { clientId: file.clientId } : {}), planGranted: false };
}

export function holdsSession(file: ChatgptSessionFile): boolean {
  return file.tokens !== undefined || file.account !== undefined || file.models !== undefined;
}

export function statusOf(file: ChatgptSessionFile | undefined): ChatgptPlanStatus {
  if (file === undefined) return { signedIn: false, registered: false };
  if (file.tokens === undefined) return { signedIn: false, registered: file.clientId !== undefined };
  return {
    signedIn: true,
    planGranted: file.planGranted,
    ...(file.account?.email !== undefined ? { email: file.account.email } : {}),
    ...(file.account?.name !== undefined ? { name: file.account.name } : {}),
    models: file.models?.list ?? [],
  };
}
