/**
 * The DI-pure OAuth service (AL-02 plan D6) — ported from OProject and re-seated on
 * Snug's local-first custody (ADR-0014): tokens and client creds live behind the
 * CredentialStore seam (the user's own `snug_secrets` file), dynamic connection state
 * at `auth:<appId>:_connection`, pending flows in memory (or spilled to
 * `auth:_flow:<flowId>` — plan N3). No server vault, no repos, no branded tenant/user
 * types; skill identity is an opaque `appId`.
 *
 * Async-first WebCrypto throughout (no node crypto or byte-buffer APIs — AC5). PKCE S256 is the
 * default (public-client posture). Every outbound token/refresh/revoke POST first
 * checks its target host against the caller-supplied FROZEN allowed-host ceiling
 * (plan N2b — defense in depth under the db-boundary freeze); there is no parameter
 * anywhere to relax that (C1/finding 4).
 *
 * Flow binding (audit bug 2, reshaped per finding 7): `generateAuthUrl` mints a
 * per-flow random `flowId`, stored in the flow row AND inside the signed state; it is
 * returned to the caller and becomes the popup/BroadcastChannel identity in AL-04.
 * `handleCallback` REQUIRES `expectedFlowId` from the caller's own held copy — never
 * parsed out of the callback payload — and rejects a mismatch with a typed error.
 *
 * Two-layer specs (audit bug 1): BOTH start and callback resolve the effective
 * oauth2_auth_code layer via `resolveAuthCodeLayer` — the source system unwrapped on
 * start only, so its two-layer OAuth loop could never complete.
 */

import {
  resolveAuthCodeLayer,
  type AuthSpec,
  type Oauth2AuthCodeSpec,
  type Oauth2ClientCredsSpec,
} from '@snugprotocol/protocol';
import { authFlowSecretKey, AUTH_FLOW_SECRET_PREFIX } from '@snugprotocol/db';
import { isUrlWithinHosts } from './app-host-freeze.js';
import { base64UrlToUtf8, bytesToBase64Url, bytesToHex, randomBase64Url, utf8ToBase64Url } from './base64url.js';
import type { CredentialStore, SecretsQuartet } from './credential-store.js';

// ---------------------------------------------------------------------------
// Constants & errors
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_SKEW_MS = 60 * 1000; // refresh when <60s of access-token life remains
const POST_TIMEOUT_MS = 15_000; // AbortSignal.timeout — browser-OK
const REVOKE_TIMEOUT_MS = 5_000;

export type SnugAuthErrorCode =
  | 'invalid_state'
  | 'state_expired'
  | 'state_replay'
  | 'flow_mismatch'
  | 'token_exchange_failed'
  | 'refresh_failed'
  | 'no_refresh_token'
  | 'no_connection'
  | 'unsupported_kind'
  | 'host_not_allowed'
  | 'missing_credential';

export class SnugAuthError extends Error {
  constructor(
    message: string,
    readonly code: SnugAuthErrorCode,
  ) {
    super(message);
    this.name = 'SnugAuthError';
  }
}

// ---------------------------------------------------------------------------
// State signing (exported for tests) — async WebCrypto
// ---------------------------------------------------------------------------

export interface SignedStatePayload {
  appId: string;
  flowId: string;
  nonce: string;
  exp: number;
}

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

/** Constant-time string compare — preserved across the WebCrypto rewrite (D6). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function signState(payload: SignedStatePayload, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const signature = await hmacSha256Hex(secret, json);
  return `${utf8ToBase64Url(json)}.${signature}`;
}

export async function verifyState(token: string, secret: string): Promise<SignedStatePayload> {
  const parts = token.split('.');
  if (parts.length !== 2) throw new SnugAuthError('State token has wrong shape', 'invalid_state');
  const [encoded, signature] = parts as [string, string];
  let json: string;
  try {
    json = base64UrlToUtf8(encoded);
  } catch {
    throw new SnugAuthError('State token not base64url', 'invalid_state');
  }
  const expected = await hmacSha256Hex(secret, json);
  if (!constantTimeEqual(signature, expected)) {
    throw new SnugAuthError('State signature mismatch', 'invalid_state');
  }
  const decoded = JSON.parse(json) as SignedStatePayload;
  if (Date.now() > decoded.exp) throw new SnugAuthError('State token expired', 'state_expired');
  return decoded;
}

// ---------------------------------------------------------------------------
// PKCE helpers (S256 default)
// ---------------------------------------------------------------------------

/** 48 random bytes → 64 base64url chars, inside RFC 7636's 43–128 range. */
export function generatePkceVerifier(): string {
  return randomBase64Url(48);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

// ---------------------------------------------------------------------------
// Flow state (plan N3): in-memory by default, secret-spill for cross-context
// ---------------------------------------------------------------------------

export interface FlowState {
  flowId: string;
  appId: string;
  /** Random nonce echoed inside the signed state — binds THIS state token to THIS row. */
  nonce: string;
  pkceVerifier: string | null;
  /** Epoch ms; expired rows read as absent. */
  expiresAt: number;
}

export interface FlowStateStore {
  put(flowId: string, flow: FlowState): Promise<void>;
  /** Single-use read: removes the row. Expired or unknown → undefined. */
  consume(flowId: string): Promise<FlowState | undefined>;
}

/** The default: pending flow state never leaves the initiating context's memory. */
export class InMemoryFlowStateStore implements FlowStateStore {
  private readonly flows = new Map<string, FlowState>();

  put(flowId: string, flow: FlowState): Promise<void> {
    this.sweep();
    this.flows.set(flowId, flow);
    return Promise.resolve();
  }

  consume(flowId: string): Promise<FlowState | undefined> {
    this.sweep();
    const flow = this.flows.get(flowId);
    this.flows.delete(flowId);
    return Promise.resolve(flow !== undefined && Date.now() <= flow.expiresAt ? flow : undefined);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, flow] of this.flows) {
      if (now > flow.expiresAt) this.flows.delete(key);
    }
  }
}

/**
 * Spill variant for flows that must survive a context hop (AL-04's popup return):
 * rows live at `auth:_flow:<flowId>` secret keys with TTL cleanup on every access.
 */
export class SecretSpillFlowStateStore implements FlowStateStore {
  constructor(private readonly db: SecretsQuartet) {}

  put(flowId: string, flow: FlowState): Promise<void> {
    this.sweep();
    this.db.setSecret(authFlowSecretKey(flowId), JSON.stringify(flow));
    return Promise.resolve();
  }

  consume(flowId: string): Promise<FlowState | undefined> {
    this.sweep();
    const key = authFlowSecretKey(flowId);
    const raw = this.db.getSecret(key);
    this.db.deleteSecret(key);
    if (raw === undefined) return Promise.resolve(undefined);
    try {
      const flow = JSON.parse(raw) as FlowState;
      return Promise.resolve(Date.now() <= flow.expiresAt ? flow : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const key of this.db.listSecretKeys()) {
      if (!key.startsWith(AUTH_FLOW_SECRET_PREFIX)) continue;
      const raw = this.db.getSecret(key);
      if (raw === undefined) continue;
      try {
        if (now > (JSON.parse(raw) as FlowState).expiresAt) this.db.deleteSecret(key);
      } catch {
        this.db.deleteSecret(key); // unreadable rows cannot be honored — clean them
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Transport seams (finding 8): decided by providers, not hardcoded
// ---------------------------------------------------------------------------

/**
 * Produces the `redirect_uri` used in BOTH the authorize URL and the token exchange —
 * the two MUST be identical, so both call sites go through this one seam. The URI's
 * shape is a launch-visible contract (BYO provider registration): hosted-origin route
 * or popup return in AL-04, localhost loopback when desktop returns.
 */
export interface RedirectUriProvider {
  redirectUri(appId: string): string | Promise<string>;
}

/** What a callback transport delivers back toward `handleCallback`. */
export interface CallbackDelivery {
  appId: string;
  flowId: string;
  code: string;
  state: string;
}

/**
 * Delivery seam for the returned `code`/`state`. AL-02 ships the interface + a
 * test-fake; AL-04 implements hosted-origin route + popup/BroadcastChannel. NOTE for
 * AL-04 (finding-7 residual): the caller's `expectedFlowId` comes from its OWN held
 * copy of the start result — never parsed out of the delivered payload, which would
 * make the flow binding tautological.
 */
export interface CallbackSink {
  deliver(delivery: CallbackDelivery): void | Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface OAuthServiceDeps {
  store: CredentialStore;
  redirectUriProvider: RedirectUriProvider;
  /** Default: a fresh in-memory store (flows die with the context — the safe default). */
  flowStore?: FlowStateStore;
  /** Injectable for tests; default global fetch. */
  fetch?: FetchLike;
}

export interface OAuthStartInput {
  appId: string;
  /** Any spec kind — the effective oauth2_auth_code layer is resolved (bug 1). */
  spec: AuthSpec;
  /** Pasted credential values (client_id required; client_secret optional for PKCE public clients). */
  clientCreds: Record<string, string>;
}

export interface OAuthStartResult {
  authorizeUrl: string;
  state: string;
  /** The per-flow binding the caller HOLDS and passes back as `expectedFlowId`. */
  flowId: string;
}

interface SpecScope {
  appId: string;
  spec: AuthSpec;
  /** The FROZEN host ceiling from the `snug_auth_specs` row. Required — no bypass. */
  allowedHosts: readonly string[];
}

export interface OAuthCallbackInput extends SpecScope {
  code: string;
  state: string;
  /** REQUIRED (bug 2): the caller's own copy of the start result's flowId. */
  expectedFlowId: string;
}

export interface OAuthCallbackResult {
  appId: string;
  flowId: string;
  scopesGranted?: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export class OAuthService {
  private readonly flows: FlowStateStore;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: OAuthServiceDeps) {
    this.flows = deps.flowStore ?? new InMemoryFlowStateStore();
    this.fetchImpl = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  // ------------------------------------------------------------------ start

  async generateAuthUrl(input: OAuthStartInput): Promise<OAuthStartResult> {
    const layer = requireAuthCodeLayer(input.spec);
    const { appId, clientCreds } = input;

    const flowId = randomBase64Url(16);
    const nonce = randomBase64Url(16);
    const exp = Date.now() + STATE_TTL_MS;
    const secret = await this.deps.store.getOrCreateStateHmacKey();
    const state = await signState({ appId, flowId, nonce, exp }, secret);

    const usePkce = layer.pkce !== false; // S256 default
    const verifier = usePkce ? generatePkceVerifier() : null;
    await this.flows.put(flowId, { flowId, appId, nonce, pkceVerifier: verifier, expiresAt: exp });

    // Persist the pasted creds + pending connection so the callback can exchange.
    for (const [field, value] of Object.entries(clientCreds)) {
      await this.deps.store.setCredential(appId, field, value);
    }
    await this.deps.store.setConnectionState(appId, { status: 'pending' });

    const redirectUri = await this.deps.redirectUriProvider.redirectUri(appId);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: requireValue(clientCreds['client_id'], 'client_id'),
      redirect_uri: redirectUri,
      state,
    });
    if (layer.scopes !== undefined && layer.scopes.length > 0) params.set('scope', layer.scopes.join(' '));
    if (verifier !== null) {
      params.set('code_challenge', await pkceChallenge(verifier));
      params.set('code_challenge_method', 'S256');
    }
    // Per-provider consent params come from the SPEC (registry-sourced) — never
    // hardcoded here (the source system stamped Google-isms on every provider).
    for (const [key, value] of Object.entries(layer.authorizeParams ?? {})) {
      params.set(key, value);
    }

    const separator = layer.endpoints.authorizeUrl.includes('?') ? '&' : '?';
    return { authorizeUrl: `${layer.endpoints.authorizeUrl}${separator}${params.toString()}`, state, flowId };
  }

  // --------------------------------------------------------------- callback

  async handleCallback(input: OAuthCallbackInput): Promise<OAuthCallbackResult> {
    const layer = requireAuthCodeLayer(input.spec); // bug 1: the callback unwraps too
    const { appId, code, state, expectedFlowId } = input;

    const secret = await this.deps.store.getOrCreateStateHmacKey();
    const payload = await verifyState(state, secret); // typed invalid_state / state_expired

    // Flow binding BEFORE any consumption side effect can be confused: the payload's
    // flowId is what the provider echoed; expectedFlowId is what the CALLER holds.
    if (payload.flowId !== expectedFlowId || payload.appId !== appId) {
      // Fail closed: burn the flow row so a mismatched delivery can't be retried
      // against the right expectation later.
      await this.flows.consume(payload.flowId);
      throw new SnugAuthError('Callback does not belong to the expected flow', 'flow_mismatch');
    }

    const flow = await this.flows.consume(payload.flowId);
    if (flow === undefined || flow.nonce !== payload.nonce) {
      throw new SnugAuthError('State already consumed, expired, or unknown', 'state_replay');
    }

    const clientId = await this.deps.store.getCredential(appId, 'client_id');
    if (clientId === undefined || clientId.length === 0) {
      throw new SnugAuthError('Client credentials missing — restart the connect flow', 'no_connection');
    }
    const clientSecret = await this.deps.store.getCredential(appId, 'client_secret');

    const redirectUri = await this.deps.redirectUriProvider.redirectUri(appId); // identical to start
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
    });
    if (clientSecret !== undefined && clientSecret.length > 0) body.set('client_secret', clientSecret);
    if (flow.pkceVerifier !== null) body.set('code_verifier', flow.pkceVerifier);

    let tokens: TokenResponse;
    try {
      tokens = await this.postForm(layer.endpoints.tokenUrl, body, input.allowedHosts, POST_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof SnugAuthError && err.code === 'host_not_allowed') throw err;
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.store.setConnectionState(appId, { status: 'error', lastError: `Token exchange failed: ${message}` });
      throw new SnugAuthError(`Token exchange failed: ${message}`, 'token_exchange_failed');
    }

    await this.persistTokens(appId, tokens, { keepPreviousRefresh: false });
    const scopesGranted = tokens.scope !== undefined ? tokens.scope.split(/\s+/) : undefined;
    return { appId, flowId: payload.flowId, ...(scopesGranted !== undefined ? { scopesGranted } : {}) };
  }

  // ----------------------------------------------------------------- tokens

  /** A usable access token, refreshed transparently inside the 60s skew window. */
  async getAccessToken(scope: SpecScope): Promise<string> {
    const layer = requireAuthCodeLayer(scope.spec);
    const connection = await this.deps.store.getConnectionState(scope.appId);
    if (connection === undefined || connection.status === 'pending') {
      throw new SnugAuthError('No OAuth connection — complete the connect flow first', 'no_connection');
    }
    const accessToken = await this.deps.store.getCredential(scope.appId, 'access_token');
    if (accessToken === undefined) {
      throw new SnugAuthError('OAuth connection is missing tokens — reconnect', 'no_connection');
    }
    if (!isExpiring(connection.obtainedAt, connection.expiresIn)) return accessToken;
    return this.refreshLayer(scope, layer);
  }

  /** Force a refresh (the 401-retry path in AL-03's connected fetch). */
  refresh(scope: SpecScope): Promise<string> {
    return this.refreshLayer(scope, requireAuthCodeLayer(scope.spec));
  }

  private async refreshLayer(scope: SpecScope, layer: Oauth2AuthCodeSpec): Promise<string> {
    const { appId } = scope;
    const refreshToken = await this.deps.store.getCredential(appId, 'refresh_token');
    if (refreshToken === undefined) {
      await this.deps.store.setConnectionState(appId, {
        status: 'expired',
        lastError: 'No refresh token — reconnect',
      });
      throw new SnugAuthError('No refresh token — reconnect', 'no_refresh_token');
    }
    const clientId = await this.deps.store.getCredential(appId, 'client_id');
    if (clientId === undefined) {
      throw new SnugAuthError('Missing client credentials — reconnect', 'no_connection');
    }
    const clientSecret = await this.deps.store.getCredential(appId, 'client_secret');

    // The refresh endpoint receives LONG-LIVED credentials — exactly why refreshUrl is
    // part of the frozen union (N2) and why the ceiling is re-checked here (N2b).
    const refreshEndpoint = layer.endpoints.refreshUrl ?? layer.endpoints.tokenUrl;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    if (clientSecret !== undefined && clientSecret.length > 0) body.set('client_secret', clientSecret);

    let tokens: TokenResponse;
    try {
      tokens = await this.postForm(refreshEndpoint, body, scope.allowedHosts, POST_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof SnugAuthError && err.code === 'host_not_allowed') throw err;
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.store.setConnectionState(appId, { status: 'expired', lastError: `Refresh failed: ${message}` });
      throw new SnugAuthError(`Refresh failed: ${message}`, 'refresh_failed');
    }

    // Rotation tolerance: some providers issue a new refresh token every time — keep
    // the previous one when they don't.
    await this.persistTokens(appId, tokens, { keepPreviousRefresh: true });
    return tokens.access_token;
  }

  /** Best-effort revoke at the provider (ceiling-gated), then wipe the app's auth slice. */
  async disconnect(scope: SpecScope): Promise<void> {
    const layer = resolveAuthCodeLayer(scope.spec);
    const revokeUrl = layer?.endpoints.revokeUrl;
    const accessToken = await this.deps.store.getCredential(scope.appId, 'access_token');
    if (revokeUrl !== undefined && accessToken !== undefined && isUrlWithinHosts(revokeUrl, scope.allowedHosts)) {
      try {
        await this.fetchImpl(revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: accessToken }),
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        });
      } catch {
        /* best-effort revoke */
      }
    }
    await this.deps.store.clearApp(scope.appId); // finding 10: nothing survives this
  }

  // ------------------------------------------------- client credentials grant

  /** Save + immediately mint, so invalid creds surface at save time, not first use. */
  async saveClientCreds(input: SpecScope & { clientCreds: Record<string, string> }): Promise<void> {
    const spec = requireClientCredsSpec(input.spec);
    for (const [field, value] of Object.entries(input.clientCreds)) {
      await this.deps.store.setCredential(input.appId, field, value);
    }
    await this.deps.store.setConnectionState(input.appId, { status: 'pending' });
    await this.mintClientCredsToken(input.appId, spec, input.allowedHosts);
  }

  async getClientCredsAccessToken(scope: SpecScope): Promise<string> {
    const spec = requireClientCredsSpec(scope.spec);
    const connection = await this.deps.store.getConnectionState(scope.appId);
    const accessToken = await this.deps.store.getCredential(scope.appId, 'access_token');
    if (connection !== undefined && accessToken !== undefined && !isExpiring(connection.obtainedAt, connection.expiresIn)) {
      return accessToken;
    }
    return this.mintClientCredsToken(scope.appId, spec, scope.allowedHosts);
  }

  /** Force a fresh mint (401-retry path — the token may have been revoked server-side). */
  refreshClientCreds(scope: SpecScope): Promise<string> {
    return this.mintClientCredsToken(scope.appId, requireClientCredsSpec(scope.spec), scope.allowedHosts);
  }

  private async mintClientCredsToken(
    appId: string,
    spec: Oauth2ClientCredsSpec,
    allowedHosts: readonly string[],
  ): Promise<string> {
    const clientId = await this.deps.store.getCredential(appId, 'client_id');
    const clientSecret = await this.deps.store.getCredential(appId, 'client_secret');
    if (clientId === undefined || clientSecret === undefined) {
      throw new SnugAuthError('Missing client credentials — save them first', 'no_connection');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (spec.scopes !== undefined && spec.scopes.length > 0) body.set('scope', spec.scopes.join(' '));

    let tokens: TokenResponse;
    try {
      tokens = await this.postForm(spec.endpoints.tokenUrl, body, allowedHosts, POST_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof SnugAuthError && err.code === 'host_not_allowed') throw err;
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.store.setConnectionState(appId, {
        status: 'expired',
        lastError: `Client credentials grant failed: ${message}`,
      });
      throw new SnugAuthError(`Client credentials grant failed: ${message}`, 'token_exchange_failed');
    }

    await this.persistTokens(appId, tokens, { keepPreviousRefresh: false });
    return tokens.access_token;
  }

  // ------------------------------------------------------------------ shared

  /** Persist tokens + connection state — always THROUGH the store, never cached here. */
  private async persistTokens(
    appId: string,
    tokens: TokenResponse,
    opts: { keepPreviousRefresh: boolean },
  ): Promise<void> {
    await this.deps.store.setCredential(appId, 'access_token', tokens.access_token);
    if (tokens.refresh_token !== undefined) {
      await this.deps.store.setCredential(appId, 'refresh_token', tokens.refresh_token);
    } else if (!opts.keepPreviousRefresh) {
      await this.deps.store.deleteCredential(appId, 'refresh_token');
    }
    await this.deps.store.setConnectionState(appId, {
      status: 'connected',
      obtainedAt: Date.now(),
      expiresIn: tokens.expires_in ?? 3600,
      ...(tokens.scope !== undefined ? { scopesGranted: tokens.scope.split(/\s+/) } : {}),
    });
  }

  /**
   * Every outbound credential-bearing POST funnels through here: the frozen-host
   * ceiling check (N2b) runs FIRST — a host outside the ceiling never sees a packet.
   */
  private async postForm(
    url: string,
    body: URLSearchParams,
    allowedHosts: readonly string[],
    timeoutMs: number,
  ): Promise<TokenResponse> {
    if (!isUrlWithinHosts(url, allowedHosts)) {
      throw new SnugAuthError(
        `endpoint host of ${new URL(url).hostname} is outside the approved host set`,
        'host_not_allowed',
      );
    }
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return (await response.json()) as TokenResponse;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAuthCodeLayer(spec: AuthSpec): Oauth2AuthCodeSpec {
  const layer = resolveAuthCodeLayer(spec);
  if (layer === undefined) {
    throw new SnugAuthError(`spec kind '${spec.kind}' has no oauth2_auth_code layer`, 'unsupported_kind');
  }
  return layer;
}

function requireClientCredsSpec(spec: AuthSpec): Oauth2ClientCredsSpec {
  if (spec.kind !== 'oauth2_client_creds') {
    throw new SnugAuthError(`expected oauth2_client_creds, got '${spec.kind}'`, 'unsupported_kind');
  }
  return spec;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new SnugAuthError(`Missing required client credential: ${name}`, 'missing_credential');
  }
  return value;
}

/** True when the access token is inside the refresh-skew window (or lifetimes unknown). */
function isExpiring(obtainedAt: number | undefined, expiresIn: number | undefined): boolean {
  if (obtainedAt === undefined || expiresIn === undefined) return true;
  const expiresAt = obtainedAt + (expiresIn - 60) * 1000;
  return Date.now() + REFRESH_SKEW_MS >= expiresAt;
}
