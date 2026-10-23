/**
 * "Use my ChatGPT plan" — the session contracts (TASK-20261023-siwc-chatgpt-plan, ADR-0078).
 *
 * L0 of the task: the TYPES every lane builds against — the per-machine session file the Rust
 * side keeps (D2), the store seat the shell implements over `chatgpt_session_read|write|clear`,
 * the sign-in's own loopback seat (D10), the keeper's API and its named failures (D5). The
 * keeper itself (`createChatgptPlanSession`: PKCE sign-in with dynamic registration, the ID
 * token checks, the single-flight rotation-safe refresh, revocation, the model list) is L1 and
 * lands in this file behind these types, tests first.
 *
 * Custody in one sentence (ADR-0078 §2): the tokens are a rotating, per-host credential, so
 * they live beside the user file in a `0600` file the shell owns — never in `snug_secrets`,
 * never in an export, a sync push, a share or a URL — and the keeper holds no long-lived token
 * in memory: every use reads the file inside one serial queue.
 *
 * DI-pure and browser-safe like the rest of this package: no tauri, no node, WebCrypto only.
 */

import { isUrlWithinHosts } from './app-host-freeze.js';
import { bytesToBase64Url, bytesToHex } from './base64url.js';
import { DESKTOP_FLOW_TTL_MS } from './desktop-transport.js';
import { createIdTokenVerifier, type IdTokenVerifier } from './jwks.js';
import {
  extractOauthErrorFromPost,
  pkceChallenge,
  signState,
  verifyState,
  type CallbackDelivery,
  type CallbackErrorDelivery,
  type FetchLike,
  type SignedStatePayload,
} from './oauth-service.js';

// ------------------------------------------------------------------ the session file (D2)

/**
 * One model the plan offers, in OpenAI's own vocabulary (ADR-0070 §3/§4 — never a mapping,
 * never a hardcoded list): `slug` → `id`, `display_name` → `name`,
 * `supported_reasoning_levels` → `efforts` (empty = no level axis, so no control is offered —
 * the Haiku rule), `default_reasoning_level` → `defaultEffort` (what an unattended step runs on).
 * Mirrors the platform's `BrainModelOption` shape on purpose.
 */
export interface ChatgptModel {
  id: string;
  name: string;
  efforts: readonly string[];
  defaultEffort?: string;
}

/**
 * The token set, replaced TOGETHER and atomically on every refresh (AC5): the refresh token
 * rotates, so a partial write would lose the only valid one. Instants are epoch milliseconds.
 * `earliestRefreshAt` is OpenAI's undocumented floor — respected for a proactive refresh,
 * advisory for a forced one (D4).
 */
export interface ChatgptSessionTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: readonly string[];
}

/** The verified account identity from the ID token — what the chip shows (R-131: the email is the user's check). */
export interface ChatgptSessionAccount {
  sub: string;
  email?: string;
  name?: string;
}

/**
 * The whole per-machine file. `hostId` is minted once per machine (`urn:uuid:…`) and
 * `clientId` is the `oaiapp_…` client OpenAI issued against it — the REGISTRATION, kept across
 * sign-outs so the next sign-in reuses it (AC9), dropped only by "forget this registration".
 * `tokens` and `account` exist only while signed in. `planGranted` is REQUIRED because a grant
 * without `chatgpt.tokens.use.direct` is a real, named state (signed in, plan not granted — AC3),
 * not an absence. `models` is the cached list (per machine, like ADR-0070 §5 brain facts).
 */
export interface ChatgptSessionFile {
  v: 1;
  hostId: string;
  clientId?: string;
  tokens?: ChatgptSessionTokens;
  account?: ChatgptSessionAccount;
  planGranted: boolean;
  models?: { fetchedAt: number; list: ChatgptModel[] };
}

/**
 * The custody seat the shell implements (D2): whole-file read / write / clear over the three
 * Rust commands. No field-level API on purpose — every mutation is a read-modify-write of the
 * whole file inside the keeper's serial queue, so a model-cache update can never write a stale
 * refresh token back. `read` answers `undefined` when no file exists.
 */
export interface ChatgptSessionStore {
  read(): Promise<ChatgptSessionFile | undefined>;
  write(file: ChatgptSessionFile): Promise<void>;
  clear(): Promise<void>;
}

// ------------------------------------------------------------- the loopback seat (D10)

/**
 * The sign-in's OWN loopback (D10): a second `createDesktopOAuthTransport` instance behind a
 * port-filtered listener, so a ChatGPT sign-in never cancels or consumes a connection wizard's
 * flow. `begin(path)` binds an ephemeral port and answers the redirect URI
 * (`http://127.0.0.1:<port>/auth/callback` — the IP literal, never `localhost`); `onCallback`
 * receives the code delivery, or — this instance opted in — an error delivery so a declined
 * consent ends by name instead of waiting out the TTL; `cancel()` is the visible cancel while
 * the browser is open (AC2).
 */
export interface ChatgptLoopbackSeat {
  begin(path: string): Promise<{ redirectUri: string }>;
  onCallback(cb: (d: CallbackDelivery | CallbackErrorDelivery) => void): () => void;
  cancel(): Promise<void>;
}

// --------------------------------------------------------------- the keeper's API (§2, D5)

/**
 * Every failure the keeper names (plan §2). Each maps to one sentence a person can act on;
 * none ever reroutes a turn (D5).
 */
export const CHATGPT_PLAN_ERROR_CODES = [
  'sign_in_needed',
  'plan_not_granted',
  'usage_limit',
  'usage_unavailable',
  'client_mismatch',
  'registration_incomplete',
  'id_token_invalid',
  'subject_mismatch',
  'refresh_not_ready',
  'revocation_unconfirmed',
  'network',
] as const;

export type ChatgptPlanErrorCode = (typeof CHATGPT_PLAN_ERROR_CODES)[number];

/** What `getAccessToken` / `refreshNow` throw — a code a caller acts on by name, never prose alone. */
export class ChatgptPlanError extends Error {
  readonly code: ChatgptPlanErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: ChatgptPlanErrorCode, retryable = false) {
    super(message);
    this.name = 'ChatgptPlanError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * The keeper's state as every surface reads it. `'unknown'` means WAIT — the first store read
 * has not answered yet (Gate-2 finding F9: a launch catch-up step must wait, not refuse a valid
 * session); signed out carries whether a registration is kept (the next sign-in reuses it);
 * signed in carries the plan flag, the account display data, the cached models and the last
 * usage-limit refusal while it stands.
 */
export type ChatgptPlanStatus =
  | 'unknown'
  | { signedIn: false; registered: boolean }
  | {
      signedIn: true;
      planGranted: boolean;
      email?: string;
      name?: string;
      models: readonly ChatgptModel[];
      limit?: { at: number; code: 'usage_limit' | 'usage_unavailable' };
    };

export type SignInResult = { ok: true; status: ChatgptPlanStatus } | { ok: false; code: ChatgptPlanErrorCode; message: string };

/**
 * The one session instance per page (L4 builds it from the platform seat at boot). Implemented
 * by `createChatgptPlanSession` (L1).
 */
export interface ChatgptPlanSession {
  /** Continue with ChatGPT: first sign-in registers the client; `prompt: 'consent'` re-asks for the plan scope (AC3). */
  signIn(opts?: { prompt?: 'consent' }): Promise<SignInResult>;
  /** The visible cancel while the browser is open — tears the listener down, ends the flow by name. */
  cancelSignIn(): Promise<void>;
  /**
   * Best-effort revocation, local delete of tokens + cached models, registration KEPT (D7).
   * `unconfirmed` is told to the user; `none` = there was nothing to revoke.
   */
  signOut(): Promise<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }>;
  /** Drop the client id and host id too — for a ChatGPT-side disconnect that deleted the client (AC9). */
  forgetRegistration(): Promise<void>;
  /** A bearer for one send, refreshed proactively; throws `ChatgptPlanError` by name. The token lives only for that send. */
  getAccessToken(): Promise<string>;
  /** A forced refresh after a 401 on `previousToken` (single-flight, rotation-safe — D4); answers the new token. */
  refreshNow(previousToken: string): Promise<string>;
  status(): ChatgptPlanStatus;
  subscribe(listener: () => void): () => void;
  /** The plan's models (`visibility:'list'`, server order), from the cache unless `force`; fails soft to the last list (AC8). */
  listModels(force?: boolean): Promise<readonly ChatgptModel[]>;
}

// =============================================================================================
// The keeper (L1) — `createChatgptPlanSession`
// =============================================================================================

// ------------------------------------------------------------------ the wire, as measured

/** OpenAI's issuer; every token's `iss` and every endpoint's host answer to it. */
export const CHATGPT_ISSUER = 'https://auth.openai.com';
const AUTH_HOST = 'auth.openai.com';
const DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;
/** The API base is pinned (ADR-0078 §3): `backend-api` is never called. */
export const CHATGPT_API_RESOURCE = 'https://api.openai.com/v1';
const MODELS_URL = `${CHATGPT_API_RESOURCE}/models`;
/** The sign-in's redirect path — exactly this, never `/callback` (AC2). */
export const CHATGPT_CALLBACK_PATH = '/auth/callback';
/** The reserved app id the signed state names; the loopback core peeks it to route the delivery (D10). */
export const CHATGPT_PLAN_APP_ID = 'chatgpt-plan';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME_HINT = 'Snug';
/** The one scope that lets requests spend the plan; its absence is the named "plan not granted" state (AC3). */
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', CHATGPT_PLAN_SCOPE, 'resource.invoke'] as const;

const REFRESH_WINDOW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** Refresh answers that mean the session is gone for good: tokens cleared, registration kept, sign-in needed. */
const TERMINAL_REFRESH_CODES: ReadonlySet<string> = new Set([
  'invalid_grant',
  'refresh_token_reused',
  'invalid_client',
  'unauthorized_client',
]);
const OAUTH_CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NETWORK_MESSAGE = "Couldn't reach ChatGPT's sign-in service — check your connection and try again.";
const SIGN_IN_NEEDED_MESSAGE = 'Sign in with ChatGPT to use your plan.';
const ID_TOKEN_REFUSED_MESSAGE = "ChatGPT's identity token didn't check out — sign in again.";

// ------------------------------------------------------------------------------------ deps

export interface ChatgptPlanSessionDeps {
  store: ChatgptSessionStore;
  fetch: FetchLike;
  loopback: ChatgptLoopbackSeat;
  /** Opens the authorize URL in the system browser (the https-guarded primitive — lesson L190). */
  openExternal(url: string): Promise<void>;
  /** Epoch ms; drives every expiry decision. Default `Date.now`. */
  clock?: () => number;
  /** The ONE randomness source: PKCE verifier, flow id, state secret, nonce, host id. Default WebCrypto. */
  randomBytes?: (n: number) => Uint8Array;
}

// -------------------------------------------------------------------------------- internals

interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
  scopes: readonly string[];
  earliestRefreshAt?: number;
}

type TimedFetch = { kind: 'ok'; response: Response } | { kind: 'timeout' } | { kind: 'network' };

interface ActiveSignIn {
  epoch: number;
  hostId: string;
  storedClientId: string | undefined;
  flowId: string;
  secret: string;
  stateNonce: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  done: boolean;
  delivered: boolean;
  unsubscribe: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (result: SignInResult) => void;
  result: Promise<SignInResult>;
}

function failure(code: ChatgptPlanErrorCode, message: string): SignInResult {
  return { ok: false, code, message };
}

function signInNeeded(message: string): ChatgptPlanError {
  return new ChatgptPlanError(message, 'sign_in_needed', false);
}

function networkError(message: string, retryable = true): ChatgptPlanError {
  return new ChatgptPlanError(message, 'network', retryable);
}

/** A discovery endpoint Snug will talk to: a string, https, and exactly on `host`. Anything else is refused unseen. */
function trustedEndpoint(value: unknown, host: string): string | undefined {
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

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A v4 UUID URN from 16 random bytes — the host id's documented shape. */
function uuidV4Urn(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(b);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The token endpoint's JSON, as measured; `earliest_refresh_at` arrives in epoch SECONDS (or ISO) and is kept in ms. */
function parseIssuedTokens(body: unknown, requestedScopes: readonly string[]): IssuedTokens | undefined {
  if (!isRecord(body)) return undefined;
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  const idToken = body['id_token'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof idToken !== 'string') return undefined;
  if (accessToken.length === 0 || refreshToken.length === 0 || idToken.length === 0) return undefined;
  const expiresIn = typeof body['expires_in'] === 'number' && body['expires_in'] > 0 ? body['expires_in'] : 3600;
  const scope = body['scope'];
  const scopes = typeof scope === 'string' ? scope.split(/\s+/).filter((s) => s.length > 0) : [...requestedScopes];
  const floor = body['earliest_refresh_at'];
  let earliestRefreshAt: number | undefined;
  if (typeof floor === 'number' && Number.isFinite(floor)) earliestRefreshAt = floor * 1000;
  else if (typeof floor === 'string') {
    const parsed = Date.parse(floor);
    if (Number.isFinite(parsed)) earliestRefreshAt = parsed;
  }
  return { accessToken, refreshToken, idToken, expiresIn, scopes, ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}) };
}

function toSessionTokens(issued: IssuedTokens, now: number): ChatgptSessionTokens {
  return {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    idToken: issued.idToken,
    expiresAt: now + issued.expiresIn * 1000,
    ...(issued.earliestRefreshAt !== undefined ? { earliestRefreshAt: issued.earliestRefreshAt } : {}),
    scopes: [...issued.scopes],
  };
}

/** `/v1/models` as measured: `visibility:'list'` only, server order, OpenAI's own vocabulary (ADR-0070 §3/§4). */
function parseModels(body: unknown): ChatgptModel[] | undefined {
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
function registrationOnly(file: ChatgptSessionFile): ChatgptSessionFile {
  return { v: 1, hostId: file.hostId, ...(file.clientId !== undefined ? { clientId: file.clientId } : {}), planGranted: false };
}

function holdsSession(file: ChatgptSessionFile): boolean {
  return file.tokens !== undefined || file.account !== undefined || file.models !== undefined;
}

function statusOf(file: ChatgptSessionFile | undefined): ChatgptPlanStatus {
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

// --------------------------------------------------------------------------------- the keeper

/**
 * The one session keeper per page (ADR-0078 §2/§4/§7/§10, plan D2/D4/D7/D10).
 *
 * Custody discipline: no long-lived token lives in memory — every use reads the file, and
 * every write is a read-modify-write of the WHOLE file inside one serial queue. A session
 * EPOCH, bumped by sign-out and forget, lets a refresh that resolves after a sign-out discard
 * (and revoke) its result instead of resurrecting the session. Memory holds only the status,
 * the epoch, the in-flight refresh and whether the stored ID token still awaits verification.
 */
export function createChatgptPlanSession(deps: ChatgptPlanSessionDeps): ChatgptPlanSession {
  const clock = deps.clock ?? (() => Date.now());
  const randomBytes = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const randomToken = (n: number): string => bytesToBase64Url(randomBytes(n));

  let status: ChatgptPlanStatus = 'unknown';
  let statusKey = JSON.stringify(status);
  const listeners = new Set<() => void>();
  let epoch = 0;
  let tail: Promise<void> = Promise.resolve();
  let inflightRefresh: Promise<string> | undefined;
  /** A refresh persisted its rotated set while the JWKS was unreachable: re-verify on the next use. */
  let idTokenUnverified = false;
  let discoveryCache: { loadedAt: number; doc: Discovery } | undefined;
  let discoveryInflight: Promise<Discovery> | undefined;
  let active: ActiveSignIn | undefined;

  // ---- the serial queue + status --------------------------------------------------------

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function publish(file: ChatgptSessionFile | undefined): void {
    const next = statusOf(file);
    const key = JSON.stringify(next);
    if (key === statusKey) return;
    status = next;
    statusKey = key;
    for (const listener of [...listeners]) listener();
  }

  /** The per-use read (D2): inside the queue so it never races a write; the status follows the file. */
  function readFile(): Promise<ChatgptSessionFile | undefined> {
    return enqueue(async () => {
      const file = await deps.store.read();
      publish(file);
      return file;
    });
  }

  /** Drop the tokens, account and cached models; keep the registration. A no-op when nothing is signed in. */
  function clearTokens(): Promise<void> {
    return enqueue(async () => {
      const file = await deps.store.read();
      if (file === undefined || !holdsSession(file)) {
        publish(file);
        return;
      }
      const next = registrationOnly(file);
      await deps.store.write(next);
      publish(next);
    });
  }

  // ---- the wire ---------------------------------------------------------------------------

  /** Every request here: its own timeout via `setTimeout` + `AbortController`, `redirect: 'manual'`. */
  async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<TimedFetch> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await deps.fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
      return { kind: 'ok', response };
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  function postForm(url: string, body: URLSearchParams, timeoutMs: number): Promise<TimedFetch> {
    return timedFetch(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body },
      timeoutMs,
    );
  }

  /** The JWKS fetch the verifier sees: timed, manual-redirect, a throw for anything but an answer. */
  const verifier: IdTokenVerifier = createIdTokenVerifier({
    fetch: async (url, init) => {
      const result = await timedFetch(url, init ?? {}, REQUEST_TIMEOUT_MS);
      if (result.kind !== 'ok') throw new Error(result.kind);
      return result.response;
    },
  });

  async function fetchDiscovery(): Promise<Discovery> {
    const result = await timedFetch(DISCOVERY_URL, { method: 'GET', headers: { Accept: 'application/json' } }, REQUEST_TIMEOUT_MS);
    if (result.kind !== 'ok' || !result.response.ok) throw networkError(NETWORK_MESSAGE);
    let body: unknown;
    try {
      body = await result.response.json();
    } catch {
      throw networkError(NETWORK_MESSAGE);
    }
    if (!isRecord(body)) throw networkError(NETWORK_MESSAGE);
    const authorizationEndpoint = trustedEndpoint(body['authorization_endpoint'], AUTH_HOST);
    const tokenEndpoint = trustedEndpoint(body['token_endpoint'], AUTH_HOST);
    const jwksUri = trustedEndpoint(body['jwks_uri'], AUTH_HOST);
    if (authorizationEndpoint === undefined || tokenEndpoint === undefined || jwksUri === undefined) {
      throw networkError(`ChatGPT's sign-in service named an endpoint outside https://${AUTH_HOST} — refused.`, false);
    }
    const revocationEndpoint = trustedEndpoint(body['revocation_endpoint'], AUTH_HOST);
    return { authorizationEndpoint, tokenEndpoint, jwksUri, ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}) };
  }

  /** The discovery document, cached for a day and fetched single-flight. Throws `ChatgptPlanError('network')`. */
  function discovery(): Promise<Discovery> {
    if (discoveryCache !== undefined && clock() - discoveryCache.loadedAt < DISCOVERY_TTL_MS) {
      return Promise.resolve(discoveryCache.doc);
    }
    if (discoveryInflight === undefined) {
      discoveryInflight = fetchDiscovery()
        .then((doc) => {
          discoveryCache = { loadedAt: clock(), doc };
          return doc;
        })
        .finally(() => {
          discoveryInflight = undefined;
        });
    }
    return discoveryInflight;
  }

  /** Best-effort revocation (D7): host-ceilinged, manual redirect, 5 s. The outcome is told, never thrown. */
  async function revoke(refreshToken: string, clientId: string): Promise<'confirmed' | 'unconfirmed'> {
    try {
      const doc = await discovery();
      if (doc.revocationEndpoint === undefined) return 'unconfirmed';
      const body = new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId });
      const result = await postForm(doc.revocationEndpoint, body, REVOKE_TIMEOUT_MS);
      return result.kind === 'ok' && result.response.ok && !isRedirect(result.response) ? 'confirmed' : 'unconfirmed';
    } catch {
      return 'unconfirmed';
    }
  }

  // ---- the ID token ----------------------------------------------------------------------

  /**
   * Re-verify a stored ID token the keeper could not check when it was persisted (a JWKS
   * outage mid-refresh). `ok` or another network failure keep going; a bad token clears the
   * session by name.
   */
  async function reverifyStored(file: ChatgptSessionFile): Promise<void> {
    if (file.tokens === undefined || file.clientId === undefined) {
      idTokenUnverified = false;
      return;
    }
    let jwksUri: string;
    try {
      jwksUri = (await discovery()).jwksUri;
    } catch {
      return;
    }
    const verdict = await verifier.verifyIdToken(
      file.tokens.idToken,
      { issuer: CHATGPT_ISSUER, clientId: file.clientId, ...(file.account !== undefined ? { subject: file.account.sub } : {}) },
      { jwksUri, nowMs: clock() },
    );
    if (verdict.ok) {
      idTokenUnverified = false;
      return;
    }
    if (verdict.kind === 'network') return;
    idTokenUnverified = false;
    await clearTokens();
    throw signInNeeded(ID_TOKEN_REFUSED_MESSAGE);
  }

  // ---- refresh (D4) ----------------------------------------------------------------------

  /** One refresh POST with its own 15 s timeout; a timeout earns exactly one retry. */
  async function postRefresh(tokenEndpoint: string, body: URLSearchParams): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await postForm(tokenEndpoint, body, REFRESH_TIMEOUT_MS);
      if (result.kind === 'ok') return result.response;
      if (result.kind === 'network') throw networkError(NETWORK_MESSAGE);
    }
    // Two timeouts: the server may or may not have rotated. Keeping the tokens costs nothing
    // if it did not; if it did, the next attempt's `invalid_grant` clears them by name.
    throw signInNeeded("ChatGPT's token service didn't answer in time — try again.");
  }

  async function doRefresh(): Promise<string> {
    const { file, epochAtStart } = await enqueue(async () => {
      const current = await deps.store.read();
      publish(current);
      return { file: current, epochAtStart: epoch };
    });
    const tokens = file?.tokens;
    const clientId = file?.clientId;
    if (file === undefined || tokens === undefined || clientId === undefined) throw signInNeeded(SIGN_IN_NEEDED_MESSAGE);
    const doc = await discovery();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: clientId,
      resource: CHATGPT_API_RESOURCE,
    });
    const response = await postRefresh(doc.tokenEndpoint, body);
    if (isRedirect(response)) throw networkError("ChatGPT's token service answered with a redirect — refused.", false);
    if (!response.ok) {
      const { status: httpStatus, code } = await extractOauthErrorFromPost(response, body);
      if (code === 'refresh_not_ready') {
        throw new ChatgptPlanError('ChatGPT is not ready to refresh this session yet — try again shortly.', 'refresh_not_ready', true);
      }
      if (code !== undefined && TERMINAL_REFRESH_CODES.has(code)) {
        await clearTokens();
        throw signInNeeded(`ChatGPT no longer accepts this session (${code}) — sign in again.`);
      }
      throw networkError(`ChatGPT's token service answered HTTP ${httpStatus}${code !== undefined ? ` (${code})` : ''} — try again.`);
    }
    let issued: IssuedTokens | undefined;
    try {
      issued = parseIssuedTokens(await response.json(), tokens.scopes);
    } catch {
      issued = undefined;
    }
    if (issued === undefined) throw networkError("ChatGPT's token reply was incomplete — try again.");
    const rotated = toSessionTokens(issued, clock());

    // Persist the rotated set TOGETHER and BEFORE verifying its ID token (crash-safe rotation):
    // the only valid refresh token is the new one, and a JWKS outage must not lose it.
    const persisted = await enqueue(async () => {
      const current = await deps.store.read();
      if (epoch !== epochAtStart || current === undefined || current.tokens === undefined) return false;
      const next: ChatgptSessionFile = { ...current, tokens: rotated };
      await deps.store.write(next);
      publish(next);
      return true;
    });
    if (!persisted) {
      // Lost to a sign-out: the server rotated for nothing — revoke what it issued.
      await revoke(rotated.refreshToken, clientId);
      throw signInNeeded('Signed out while refreshing — sign in with ChatGPT to use your plan.');
    }

    const verdict = await verifier.verifyIdToken(
      rotated.idToken,
      { issuer: CHATGPT_ISSUER, clientId, ...(file.account !== undefined ? { subject: file.account.sub } : {}) },
      { jwksUri: doc.jwksUri, nowMs: clock() },
    );
    if (verdict.ok) {
      idTokenUnverified = false;
      return rotated.accessToken;
    }
    if (verdict.kind === 'network') {
      idTokenUnverified = true;
      return rotated.accessToken;
    }
    await clearTokens();
    throw signInNeeded(ID_TOKEN_REFUSED_MESSAGE);
  }

  /** Single-flight: every caller inside the window, and every forced refresh, shares the one in-flight promise. */
  function sharedRefresh(): Promise<string> {
    if (inflightRefresh === undefined) {
      inflightRefresh = doRefresh().finally(() => {
        inflightRefresh = undefined;
      });
    }
    return inflightRefresh;
  }

  // ---- models (AC8) ----------------------------------------------------------------------

  async function fetchModels(bearer: string): Promise<ChatgptModel[] | undefined> {
    const result = await timedFetch(
      MODELS_URL,
      { method: 'GET', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } },
      REQUEST_TIMEOUT_MS,
    );
    if (result.kind !== 'ok' || !result.response.ok) return undefined;
    try {
      return parseModels(await result.response.json());
    } catch {
      return undefined;
    }
  }

  /** The model-cache write: a read-modify-write of the whole file, only while still signed in (never resurrects). */
  function persistModels(list: ChatgptModel[]): Promise<void> {
    return enqueue(async () => {
      const current = await deps.store.read();
      if (current === undefined || current.tokens === undefined) {
        publish(current);
        return;
      }
      const next: ChatgptSessionFile = { ...current, models: { fetchedAt: clock(), list } };
      await deps.store.write(next);
      publish(next);
    });
  }

  async function listModels(force?: boolean): Promise<readonly ChatgptModel[]> {
    const file = await readFile();
    const cached = file?.models?.list ?? [];
    if (force !== true && file?.models !== undefined) return cached;
    if (file?.tokens === undefined || !file.planGranted) return cached;
    let bearer: string;
    try {
      bearer = await getAccessToken();
    } catch {
      return cached;
    }
    const list = await fetchModels(bearer);
    if (list === undefined) return cached;
    await persistModels(list);
    return list;
  }

  // ---- the bearer (D4) -------------------------------------------------------------------

  async function getAccessToken(): Promise<string> {
    const file = await readFile();
    if (file?.tokens === undefined) throw signInNeeded(SIGN_IN_NEEDED_MESSAGE);
    if (!file.planGranted) {
      throw new ChatgptPlanError("Your ChatGPT account didn't allow plan usage for Snug — allow it in Settings.", 'plan_not_granted', false);
    }
    if (idTokenUnverified) await reverifyStored(file);
    const tokens = file.tokens;
    const now = clock();
    const expired = now >= tokens.expiresAt;
    const inWindow = now >= tokens.expiresAt - REFRESH_WINDOW_MS;
    const pastFloor = tokens.earliestRefreshAt === undefined || now >= tokens.earliestRefreshAt;
    if (!expired && !(inWindow && pastFloor)) return tokens.accessToken;
    try {
      return await sharedRefresh();
    } catch (err) {
      // A proactive refresh that failed transiently leaves a token still good for up to a
      // minute — answer it rather than fail the send; an expired one has nothing to offer.
      if (!expired && err instanceof ChatgptPlanError && err.retryable) return tokens.accessToken;
      throw err;
    }
  }

  async function refreshNow(previousToken: string): Promise<string> {
    const file = await readFile();
    if (file?.tokens === undefined) throw signInNeeded(SIGN_IN_NEEDED_MESSAGE);
    // Another caller may already have rotated the token the 401 was about: answer the current one.
    if (file.tokens.accessToken !== previousToken) return file.tokens.accessToken;
    return sharedRefresh();
  }

  // ---- sign-in (AC2, D10) ----------------------------------------------------------------

  async function endFlow(flow: ActiveSignIn, result: SignInResult): Promise<void> {
    if (flow.done) return;
    flow.done = true;
    if (active === flow) active = undefined;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    flow.unsubscribe?.();
    await deps.loopback.cancel().catch(() => undefined);
    flow.resolve(result);
  }

  /** The host id, minted once per machine and PERSISTED before any callback can arrive (AC2). */
  function ensureHostId(): Promise<{ hostId: string; clientId: string | undefined }> {
    return enqueue(async () => {
      const file = await deps.store.read();
      if (file !== undefined) {
        publish(file);
        return { hostId: file.hostId, clientId: file.clientId };
      }
      const next: ChatgptSessionFile = { v: 1, hostId: uuidV4Urn(randomBytes(16)), planGranted: false };
      await deps.store.write(next);
      publish(next);
      return { hostId: next.hostId, clientId: undefined };
    });
  }

  function toSignInFailure(err: unknown): SignInResult {
    if (err instanceof ChatgptPlanError) return failure(err.code, err.message);
    return failure('sign_in_needed', 'The sign-in failed — try again.');
  }

  async function prepareAndOpen(flow: ActiveSignIn, opts: { prompt?: 'consent' } | undefined): Promise<void> {
    const doc = await discovery();
    if (flow.done) return;
    const { redirectUri } = await deps.loopback.begin(CHATGPT_CALLBACK_PATH);
    if (flow.done) return;
    flow.redirectUri = redirectUri;
    flow.unsubscribe = deps.loopback.onCallback((delivery) => {
      void onDelivery(flow, delivery);
    });
    const state = await signState(
      { appId: CHATGPT_PLAN_APP_ID, flowId: flow.flowId, nonce: flow.stateNonce, exp: clock() + DESKTOP_FLOW_TTL_MS },
      flow.secret,
    );
    const challenge = await pkceChallenge(flow.verifier);
    if (flow.done) return;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: flow.storedClientId ?? DYNAMIC_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      nonce: flow.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: CHATGPT_API_RESOURCE,
      ext_agent_host_id: flow.hostId,
    });
    if (flow.storedClientId === undefined) params.set('agent_name_hint', AGENT_NAME_HINT);
    if (opts?.prompt === 'consent') params.set('prompt', 'consent');
    const separator = doc.authorizationEndpoint.includes('?') ? '&' : '?';
    flow.timer = setTimeout(() => {
      void endFlow(flow, failure('sign_in_needed', 'The sign-in timed out — try again.'));
    }, DESKTOP_FLOW_TTL_MS);
    try {
      await deps.openExternal(`${doc.authorizationEndpoint}${separator}${params.toString()}`);
    } catch {
      throw signInNeeded("Couldn't open your browser for the ChatGPT sign-in — try again.");
    }
  }

  async function onDelivery(flow: ActiveSignIn, delivery: CallbackDelivery | CallbackErrorDelivery): Promise<void> {
    if (flow.done || flow.delivered) return;
    flow.delivered = true;
    try {
      await endFlow(flow, await completeDelivery(flow, delivery));
    } catch (err) {
      await endFlow(flow, toSignInFailure(err));
    }
  }

  async function completeDelivery(flow: ActiveSignIn, delivery: CallbackDelivery | CallbackErrorDelivery): Promise<SignInResult> {
    // The state must be THIS attempt's: signed with its per-flow secret, naming its flow and
    // nonce. The listener is one-shot, so a mismatch ends the flow rather than waiting.
    const mismatch = failure('sign_in_needed', "The sign-in reply didn't match this attempt — try again.");
    let payload: SignedStatePayload;
    try {
      payload = await verifyState(delivery.state, flow.secret);
    } catch {
      return mismatch;
    }
    if (payload.appId !== CHATGPT_PLAN_APP_ID || payload.flowId !== flow.flowId || payload.nonce !== flow.stateNonce) return mismatch;

    if ('error' in delivery) {
      if (delivery.error === 'access_denied') return failure('sign_in_needed', 'You declined the ChatGPT sign-in.');
      const code = OAUTH_CODE_SHAPE.test(delivery.error) ? delivery.error : 'error';
      return failure('sign_in_needed', `ChatGPT didn't complete the sign-in (${code}) — try again.`);
    }

    // The client the exchange runs under: the issued one on a first sign-in (registration
    // incomplete without it); the stored one on re-auth, which a callback may echo but never change.
    let clientId: string;
    if (flow.storedClientId === undefined) {
      if (delivery.clientId === undefined) {
        return failure('registration_incomplete', "ChatGPT didn't return a client registration for Snug — try again.");
      }
      clientId = delivery.clientId;
    } else {
      if (delivery.clientId !== undefined && delivery.clientId !== flow.storedClientId) {
        return failure(
          'client_mismatch',
          'ChatGPT answered for a different client than the one registered on this computer — forget this registration in Settings to start over.',
        );
      }
      clientId = flow.storedClientId;
    }

    const doc = await discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: delivery.code,
      redirect_uri: flow.redirectUri,
      client_id: clientId,
      code_verifier: flow.verifier,
      resource: CHATGPT_API_RESOURCE,
    });
    const posted = await postForm(doc.tokenEndpoint, body, REQUEST_TIMEOUT_MS);
    if (posted.kind !== 'ok') return failure('network', NETWORK_MESSAGE);
    if (isRedirect(posted.response)) return failure('network', "ChatGPT's token service answered with a redirect — refused.");
    if (!posted.response.ok) {
      const { status: httpStatus, code } = await extractOauthErrorFromPost(posted.response, body);
      return failure('sign_in_needed', `ChatGPT didn't complete the sign-in (${code ?? `HTTP ${httpStatus}`}) — try again.`);
    }
    let issued: IssuedTokens | undefined;
    try {
      issued = parseIssuedTokens(await posted.response.json(), SCOPES);
    } catch {
      issued = undefined;
    }
    if (issued === undefined) return failure('sign_in_needed', "ChatGPT's token reply was incomplete — try again.");

    const verdict = await verifier.verifyIdToken(
      issued.idToken,
      { issuer: CHATGPT_ISSUER, clientId, nonce: flow.nonce },
      { jwksUri: doc.jwksUri, nowMs: clock() },
    );
    if (!verdict.ok) {
      if (verdict.kind === 'network') return failure('network', NETWORK_MESSAGE);
      return failure('id_token_invalid', "ChatGPT's identity token didn't check out — try again.");
    }
    const tokens = toSessionTokens(issued, clock());
    const planGranted = issued.scopes.includes(CHATGPT_PLAN_SCOPE);

    // Persist (registration + session together) inside the queue; a returning account must be
    // the same person, and a flow that was cancelled or signed out meanwhile persists nothing.
    const outcome = await enqueue(async (): Promise<'persisted' | 'discarded' | 'subject_mismatch'> => {
      if (flow.done || epoch !== flow.epoch) return 'discarded';
      const current = await deps.store.read();
      const base: ChatgptSessionFile = current ?? { v: 1, hostId: flow.hostId, planGranted: false };
      if (base.account !== undefined && base.account.sub !== verdict.claims.sub) return 'subject_mismatch';
      const next: ChatgptSessionFile = {
        v: 1,
        hostId: base.hostId,
        clientId,
        tokens,
        account: verdict.claims,
        planGranted,
        ...(base.models !== undefined ? { models: base.models } : {}),
      };
      await deps.store.write(next);
      idTokenUnverified = false;
      publish(next);
      return 'persisted';
    });
    if (outcome !== 'persisted') {
      await revoke(tokens.refreshToken, clientId);
      if (outcome === 'subject_mismatch') {
        return failure('subject_mismatch', "That's a different ChatGPT account than the one signed in here — sign out first to switch accounts.");
      }
      return failure('sign_in_needed', 'Sign-in cancelled.');
    }
    if (planGranted) await listModels(true); // soft: a failing list never fails the sign-in
    return { ok: true, status };
  }

  async function signIn(opts?: { prompt?: 'consent' }): Promise<SignInResult> {
    await cancelSignIn(); // cancel-old: the newest intent wins
    let registration: { hostId: string; clientId: string | undefined };
    try {
      registration = await ensureHostId();
    } catch (err) {
      return toSignInFailure(err);
    }
    let resolve: (result: SignInResult) => void = () => undefined;
    const result = new Promise<SignInResult>((res) => {
      resolve = res;
    });
    const flow: ActiveSignIn = {
      epoch,
      hostId: registration.hostId,
      storedClientId: registration.clientId,
      verifier: randomToken(48),
      flowId: randomToken(16),
      secret: bytesToHex(randomBytes(32)),
      stateNonce: randomToken(16),
      nonce: randomToken(16),
      redirectUri: '',
      done: false,
      delivered: false,
      unsubscribe: undefined,
      timer: undefined,
      resolve,
      result,
    };
    active = flow;
    try {
      await prepareAndOpen(flow, opts);
    } catch (err) {
      await endFlow(flow, toSignInFailure(err));
    }
    return result;
  }

  async function cancelSignIn(): Promise<void> {
    const flow = active;
    if (flow !== undefined) {
      await endFlow(flow, failure('sign_in_needed', 'Sign-in cancelled.'));
      return;
    }
    await deps.loopback.cancel().catch(() => undefined);
  }

  // ---- sign-out, forget (AC9, D7) --------------------------------------------------------

  async function signOut(): Promise<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }> {
    await cancelSignIn();
    const held = await enqueue(async () => {
      const file = await deps.store.read();
      epoch++;
      idTokenUnverified = false;
      if (file === undefined) {
        publish(undefined);
        return undefined;
      }
      const tokens = file.tokens;
      const toRevoke = tokens !== undefined && file.clientId !== undefined ? { refreshToken: tokens.refreshToken, clientId: file.clientId } : undefined;
      if (holdsSession(file)) {
        const next = registrationOnly(file);
        await deps.store.write(next);
        publish(next);
      } else {
        publish(file);
      }
      return toRevoke;
    });
    if (held === undefined) return { revocation: 'none' };
    return { revocation: await revoke(held.refreshToken, held.clientId) };
  }

  async function forgetRegistration(): Promise<void> {
    await cancelSignIn();
    const held = await enqueue(async () => {
      const file = await deps.store.read();
      epoch++;
      idTokenUnverified = false;
      await deps.store.clear();
      publish(undefined);
      const tokens = file?.tokens;
      return tokens !== undefined && file?.clientId !== undefined ? { refreshToken: tokens.refreshToken, clientId: file.clientId } : undefined;
    });
    if (held !== undefined) await revoke(held.refreshToken, held.clientId);
  }

  // ---- boot: read once so 'unknown' resolves without a call (F9) -------------------------

  void readFile().catch(() => undefined);

  return {
    signIn,
    cancelSignIn,
    signOut,
    forgetRegistration,
    getAccessToken,
    refreshNow,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listModels,
  };
}
