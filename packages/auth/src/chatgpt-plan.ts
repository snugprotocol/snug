/**
 * "Use my ChatGPT plan" — the session keeper (TASK-20261023-siwc-chatgpt-plan, ADR-0078).
 *
 * `createChatgptPlanSession`, behind the contracts in `chatgpt-plan-types.ts` and over the
 * measured wire in `chatgpt-plan-wire.ts`: PKCE sign-in with dynamic registration on the
 * sign-in's own loopback (D10), ID-token checks against OpenAI's JWKS (AC3), one serial queue
 * and a session epoch over the per-machine file (D2), the single-flight rotation-safe refresh
 * (D4), best-effort revocation (D7), the plan's model list (AC8). This module re-exports every
 * public name of the other two, so the package index — and every `./chatgpt-plan.js` import —
 * has one door.
 *
 * Custody in one sentence (ADR-0078 §2): the tokens are a rotating, per-host credential, so
 * they live beside the user file in a `0600` file the shell owns — never in `snug_secrets`,
 * never in an export, a sync push, a share or a URL — and the keeper holds no long-lived token
 * in memory: every use reads the file inside one serial queue.
 *
 * DI-pure and browser-safe like the rest of this package: no tauri, no node, WebCrypto only.
 */

import { jwtShapeInText } from '@snugprotocol/protocol';

import { bytesToBase64Url, bytesToHex } from './base64url.js';
import {
  ChatgptPlanError,
  parseChatgptSessionFile,
  type ChatgptLoopbackSeat,
  type ChatgptModel,
  type ChatgptPlanErrorCode,
  type ChatgptPlanSession,
  type ChatgptPlanStatus,
  type ChatgptSessionAccount,
  type ChatgptSessionFile,
  type ChatgptSessionStore,
  type ChatgptSessionTokens,
  type SignInResult,
} from './chatgpt-plan-types.js';
import {
  AGENT_NAME_HINT,
  CHATGPT_API_RESOURCE,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_ISSUER,
  CHATGPT_PLAN_APP_ID,
  CHATGPT_PLAN_SCOPE,
  DISCOVERY_TTL_MS,
  DISCOVERY_URL,
  DYNAMIC_CLIENT_ID,
  ID_TOKEN_REFUSED_MESSAGE,
  INCOMPLETE_REPLY_MESSAGE,
  ISSUER_REFUSED_MESSAGE,
  MODELS_URL,
  NETWORK_MESSAGE,
  OFF_HOST_MESSAGE,
  PLAN_NOT_GRANTED_MESSAGE,
  REDIRECT_REFUSED_MESSAGE,
  REFRESH_TIMEOUT_MS,
  REFRESH_WINDOW_MS,
  REQUEST_TIMEOUT_MS,
  REVOKE_TIMEOUT_MS,
  SCOPES,
  SIGN_IN_NEEDED_MESSAGE,
  classifyRefreshFailure,
  holdsSession,
  isRedirect,
  parseDiscovery,
  parseIssuedTokens,
  parseModels,
  parseRefreshReply,
  registrationOnly,
  statusOf,
  toSessionTokens,
  uuidV4Urn,
  type Discovery,
} from './chatgpt-plan-wire.js';
import { DESKTOP_FLOW_TTL_MS } from './desktop-transport.js';
import { createIdTokenVerifier, type IdTokenVerdict, type IdTokenVerifier } from './jwks.js';
import {
  OAUTH_ERROR_CODE_SHAPE,
  extractOauthErrorFromPost,
  pkceChallenge,
  signState,
  verifyState,
  type CallbackDelivery,
  type CallbackErrorDelivery,
  type FetchLike,
  type SignedStatePayload,
} from './oauth-service.js';

// The one door: every public name of the contracts and the wire, as before the split.
export {
  CHATGPT_PLAN_ERROR_CODES,
  ChatgptPlanError,
  parseChatgptSessionFile,
  type ChatgptLoopbackSeat,
  type ChatgptModel,
  type ChatgptPlanErrorCode,
  type ChatgptPlanSession,
  type ChatgptPlanStatus,
  type ChatgptSessionAccount,
  type ChatgptSessionFile,
  type ChatgptSessionStore,
  type ChatgptSessionTokens,
  type SignInResult,
} from './chatgpt-plan-types.js';
export { CHATGPT_API_RESOURCE, CHATGPT_CALLBACK_PATH, CHATGPT_ISSUER, CHATGPT_PLAN_APP_ID, CHATGPT_PLAN_SCOPE } from './chatgpt-plan-wire.js';

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
  /** The tokens are on disk: the attempt is no longer cancellable (G5-C9). */
  persisted: boolean;
  /** The listener, the timer and the loopback are torn down — once. */
  released: boolean;
  planGranted: boolean;
  unsubscribe: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (result: SignInResult) => void;
  result: Promise<SignInResult>;
}

/** How a sign-in's exchange ended, before the models: persisted, or a named failure to end the flow with. */
type Exchange = 'persisted' | SignInResult;

function failure(code: ChatgptPlanErrorCode, message: string): SignInResult {
  return { ok: false, code, message };
}

function signInNeeded(message: string): ChatgptPlanError {
  return new ChatgptPlanError(message, 'sign_in_needed', false);
}

function networkError(message: string, retryable = true): ChatgptPlanError {
  return new ChatgptPlanError(message, 'network', retryable);
}

/** A store failure's reason as a message may carry it: one line, token shapes masked, bounded (G5-C1). */
function scrubReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const line = raw.replace(/\s+/g, ' ').trim();
  return (line.length > 0 ? line : 'unknown error').replace(jwtShapeInText(), '***').slice(0, 160);
}

function subjectOf(account: ChatgptSessionAccount | undefined): { subject?: string } {
  return account !== undefined ? { subject: account.sub } : {};
}

// --------------------------------------------------------------------------------- the keeper

/**
 * The one session keeper per page (ADR-0078 §2/§4/§7/§10, plan D2/D4/D7/D10).
 *
 * Custody discipline: no long-lived token lives in memory — every use reads the file, and
 * every write is a read-modify-write of the WHOLE file inside one serial queue. A session
 * EPOCH, bumped by sign-out and forget, lets a refresh that resolves after a sign-out discard
 * (and revoke) its result instead of resurrecting the session; and every write or clear that
 * follows a token POST compares-and-swaps on the refresh token it was about, so a loser's
 * terminal answer — another keeper's, or an older POST's in this page — never wipes a set that
 * landed meanwhile (S5, G5-A7). Memory holds only the status, the epoch and the in-flight work.
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
  /** A sign-in whose code arrived and whose exchange has not yet persisted or failed (G5-C2). */
  let inflightExchange: Promise<void> | undefined;
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

  /**
   * The store read every queue job starts with (D2): parsed totally (ST4), the status following
   * the file. A read that REJECTS settles the status as signed out rather than leaving `'unknown'`
   * for good (G5-C1 — a non-UTF-8 file or EACCES must never hang every caller of the keeper),
   * and surfaces as a `network` failure naming the reason, so a later sign-in says what is wrong
   * instead of minting a host id over a file it cannot read.
   */
  async function readStore(): Promise<ChatgptSessionFile | undefined> {
    let raw: unknown;
    try {
      raw = await deps.store.read();
    } catch (err) {
      publish(undefined);
      throw networkError(`couldn't read the ChatGPT session file — ${scrubReason(err)}`, false);
    }
    const file = parseChatgptSessionFile(raw);
    publish(file);
    return file;
  }

  function readFile(): Promise<ChatgptSessionFile | undefined> {
    return enqueue(readStore);
  }

  /**
   * Drop the session (tokens, account, cached models), keep the registration — but only while the
   * stored token set is still the one the caller is talking about (`stillCurrent`): a terminal
   * answer to an OLDER refresh token must not erase the set that replaced it (G5-A7), and a
   * rejected bearer another caller already rotated past is nobody's news (G5-C4). Answers the file
   * as it stands afterwards.
   */
  function clearSessionIf(stillCurrent: (tokens: ChatgptSessionTokens) => boolean): Promise<ChatgptSessionFile | undefined> {
    return enqueue(async () => {
      const file = await readStore();
      if (file?.tokens === undefined || !stillCurrent(file.tokens)) return file;
      const next = registrationOnly(file);
      await deps.store.write(next);
      publish(next);
      return next;
    });
  }

  /**
   * The session built on `refreshToken` is gone (a terminal refresh answer, a refused ID token):
   * clear it by compare-and-swap. When a DIFFERENT set stands afterwards — a sign-in or another
   * keeper's refresh landed meanwhile — that set is the session, and its bearer is the answer;
   * otherwise the caller hears sign-in-needed with `message`.
   */
  async function dropSession(refreshToken: string, message: string): Promise<string> {
    const after = await clearSessionIf((tokens) => tokens.refreshToken === refreshToken);
    if (after?.tokens !== undefined) return after.tokens.accessToken;
    throw signInNeeded(message);
  }

  /** Mark or clear the stored set's "ID token unverified" flag — by compare-and-swap on its refresh token (S10). */
  function setIdTokenUnverified(refreshToken: string, unverified: boolean): Promise<void> {
    return enqueue(async () => {
      const file = await readStore();
      if (file?.tokens === undefined || file.tokens.refreshToken !== refreshToken) return;
      if ((file.tokens.idTokenUnverified === true) === unverified) return;
      const { idTokenUnverified: _flag, ...rest } = file.tokens;
      const next: ChatgptSessionFile = { ...file, tokens: unverified ? { ...rest, idTokenUnverified: true } : rest };
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

  /** The body as JSON, or undefined when it is not — the one place a token reply is read off the wire. */
  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  /** The JWKS fetch the verifier sees: timed, manual-redirect, a throw for anything but an answer. */
  const verifier: IdTokenVerifier = createIdTokenVerifier({
    fetch: async (url, init) => {
      const result = await timedFetch(url, init ?? {}, REQUEST_TIMEOUT_MS);
      if (result.kind !== 'ok') throw new Error(result.kind);
      return result.response;
    },
  });

  /** The ID-token check, written once: OpenAI's issuer, the client the token was issued to, and what binds it to this use. */
  function verifyIdTokenFor(
    idToken: string,
    clientId: string,
    jwksUri: string,
    bind: { nonce?: string; subject?: string },
    expiry?: 'ignored',
  ): Promise<IdTokenVerdict> {
    return verifier.verifyIdToken(idToken, { issuer: CHATGPT_ISSUER, clientId, ...bind }, { jwksUri, nowMs: clock(), ...(expiry !== undefined ? { expiry } : {}) });
  }

  async function fetchDiscovery(): Promise<Discovery> {
    const result = await timedFetch(DISCOVERY_URL, { method: 'GET', headers: { Accept: 'application/json' } }, REQUEST_TIMEOUT_MS);
    if (result.kind !== 'ok' || !result.response.ok) throw networkError(NETWORK_MESSAGE);
    const parsed = parseDiscovery(await readJson(result.response));
    if (parsed.ok) return parsed.doc;
    if (parsed.reason === 'shape') throw networkError(NETWORK_MESSAGE);
    throw networkError(parsed.reason === 'issuer' ? ISSUER_REFUSED_MESSAGE : OFF_HOST_MESSAGE, false);
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
   * Re-verify a stored ID token the keeper could not check when it was persisted (a JWKS outage
   * mid-refresh, a refresh reply without one). Its `exp` is not asked: that claim is about the
   * login event, and the refresh token's validity is what keeps the session alive — a sleep
   * longer than an hour must not sign the user out (G5-C6). `ok` clears the flag in the file;
   * `deferred` (no JWKS yet) keeps going; `refused` is the caller's to act on.
   */
  async function reverifyStored(tokens: ChatgptSessionTokens, clientId: string, account: ChatgptSessionAccount | undefined): Promise<'ok' | 'deferred' | 'refused'> {
    let jwksUri: string;
    try {
      jwksUri = (await discovery()).jwksUri;
    } catch {
      return 'deferred';
    }
    const verdict = await verifyIdTokenFor(tokens.idToken, clientId, jwksUri, subjectOf(account), 'ignored');
    if (verdict.ok) {
      await setIdTokenUnverified(tokens.refreshToken, false);
      return 'ok';
    }
    return verdict.kind === 'network' ? 'deferred' : 'refused';
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
    const { file, epochAtStart } = await enqueue(async () => ({ file: await readStore(), epochAtStart: epoch }));
    if (file?.tokens === undefined || file.clientId === undefined) throw signInNeeded(SIGN_IN_NEEDED_MESSAGE);
    const { tokens, clientId } = file;
    const spent = tokens.refreshToken;
    const doc = await discovery();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: spent,
      client_id: clientId,
      resource: CHATGPT_API_RESOURCE,
    });
    const response = await postRefresh(doc.tokenEndpoint, body);
    if (isRedirect(response)) throw networkError(REDIRECT_REFUSED_MESSAGE, false);
    if (!response.ok) {
      const { status: httpStatus, code } = await extractOauthErrorFromPost(response, body);
      switch (classifyRefreshFailure(httpStatus, code)) {
        case 'not_ready':
          throw new ChatgptPlanError('ChatGPT is not ready to refresh this session yet — try again shortly.', 'refresh_not_ready', true);
        case 'terminal':
          return dropSession(spent, `ChatGPT no longer accepts this session (${code ?? `HTTP ${httpStatus}`}) — sign in again.`);
        case 'transient':
          throw networkError(`ChatGPT's token service answered HTTP ${httpStatus}${code !== undefined ? ` (${code})` : ''} — try again.`);
      }
    }
    const reply = parseRefreshReply(await readJson(response), tokens, clock());
    if (reply === undefined) throw networkError(INCOMPLETE_REPLY_MESSAGE);
    const { tokens: rotated, planGranted, idTokenFresh, complete } = reply;

    // Persist the rotated set TOGETHER and BEFORE verifying its ID token (crash-safe rotation):
    // the only valid refresh token is the new one, and a JWKS outage must not lose it. The write
    // compares-and-swaps on the refresh token this POST spent (S5): if the stored one changed
    // meanwhile — a sign-out, a re-consent sign-in, another keeper's refresh — this rotation lost.
    const persisted = await enqueue(async (): Promise<{ kind: 'persisted' } | { kind: 'lost'; current: ChatgptSessionFile | undefined }> => {
      const current = await readStore();
      if (epoch !== epochAtStart || current?.tokens === undefined || current.tokens.refreshToken !== spent) return { kind: 'lost', current };
      const next: ChatgptSessionFile = { ...current, tokens: rotated, planGranted: planGranted ?? current.planGranted };
      await deps.store.write(next);
      publish(next);
      return { kind: 'persisted' };
    });
    if (persisted.kind === 'lost') {
      // The server rotated for nothing: revoke what it issued. A set that stands is the session.
      if (rotated.refreshToken !== spent) await revoke(rotated.refreshToken, clientId);
      if (persisted.current?.tokens !== undefined) return persisted.current.tokens.accessToken;
      throw signInNeeded('Signed out while refreshing — sign in with ChatGPT to use your plan.');
    }
    if (!complete) throw networkError(INCOMPLETE_REPLY_MESSAGE); // the rotation is safe on disk (S4); the access token comes next time
    if (!idTokenFresh) return rotated.accessToken; // the stored ID token stands, marked for re-verification (G5-C7)

    const verdict = await verifyIdTokenFor(rotated.idToken, clientId, doc.jwksUri, subjectOf(file.account));
    if (verdict.ok) return rotated.accessToken;
    if (verdict.kind === 'network') {
      await setIdTokenUnverified(rotated.refreshToken, true);
      return rotated.accessToken;
    }
    return dropSession(rotated.refreshToken, ID_TOKEN_REFUSED_MESSAGE);
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
    return parseModels(await readJson(result.response));
  }

  /** The model-cache write: a read-modify-write of the whole file, only while still signed in (never resurrects). */
  function persistModels(list: ChatgptModel[]): Promise<void> {
    return enqueue(async () => {
      const current = await readStore();
      if (current?.tokens === undefined) return;
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
    if (!file.planGranted) throw new ChatgptPlanError(PLAN_NOT_GRANTED_MESSAGE, 'plan_not_granted', false);
    const { tokens } = file;
    if (tokens.idTokenUnverified === true && file.clientId !== undefined) {
      const outcome = await reverifyStored(tokens, file.clientId, file.account);
      if (outcome === 'refused') return dropSession(tokens.refreshToken, ID_TOKEN_REFUSED_MESSAGE);
    }
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

  async function reportRejected(token: string): Promise<void> {
    await clearSessionIf((tokens) => tokens.accessToken === token);
  }

  // ---- sign-in (AC2, D10) ----------------------------------------------------------------

  /** Tear the attempt's listener, timer and loopback down — once; the callback is spent or the attempt is over. */
  async function releaseListener(flow: ActiveSignIn): Promise<void> {
    if (flow.released) return;
    flow.released = true;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    flow.unsubscribe?.();
    await deps.loopback.cancel().catch(() => undefined);
  }

  async function endFlow(flow: ActiveSignIn, result: SignInResult): Promise<void> {
    if (flow.done) return;
    flow.done = true;
    if (active === flow) active = undefined;
    await releaseListener(flow);
    flow.resolve(result);
  }

  /** The host id, minted once per machine and PERSISTED before any callback can arrive (AC2). */
  function ensureHostId(): Promise<{ hostId: string; clientId: string | undefined }> {
    return enqueue(async () => {
      const file = await readStore();
      if (file !== undefined) return { hostId: file.hostId, clientId: file.clientId };
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
    if (flow.done) {
      // Cancelled while the port was binding: the cancel that ended the flow ran before the
      // bind existed, so this one releases it (G5-C8).
      await deps.loopback.cancel().catch(() => undefined);
      return;
    }
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
    const exchange = exchangeDelivery(flow, delivery);
    // Visible to `flush()` from this instant until the tokens are on disk or the exchange failed.
    const tracked: Promise<void> = exchange.then(
      () => undefined,
      () => undefined,
    );
    inflightExchange = tracked;
    void tracked.then(() => {
      if (inflightExchange === tracked) inflightExchange = undefined;
    });
    try {
      const outcome = await exchange;
      if (outcome !== 'persisted') {
        await endFlow(flow, outcome);
        return;
      }
      // The models are fetched soft, after the session is saved: a failing list — or a failing
      // cache write — never fails a sign-in that already happened (AC8, G5-A8).
      if (flow.planGranted) await listModels(true).catch(() => undefined);
      await endFlow(flow, { ok: true, status });
    } catch (err) {
      await endFlow(flow, toSignInFailure(err));
    }
  }

  /** The callback → the exchange → the verified, persisted session; or the named failure that ends the attempt. */
  async function exchangeDelivery(flow: ActiveSignIn, delivery: CallbackDelivery | CallbackErrorDelivery): Promise<Exchange> {
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
      const code = OAUTH_ERROR_CODE_SHAPE.test(delivery.error) ? delivery.error : 'error';
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
    if (isRedirect(posted.response)) return failure('network', REDIRECT_REFUSED_MESSAGE);
    if (!posted.response.ok) {
      const { status: httpStatus, code } = await extractOauthErrorFromPost(posted.response, body);
      return failure('sign_in_needed', `ChatGPT didn't complete the sign-in (${code ?? `HTTP ${httpStatus}`}) — try again.`);
    }
    const issued = parseIssuedTokens(await readJson(posted.response), SCOPES);
    if (issued === undefined) return failure('sign_in_needed', INCOMPLETE_REPLY_MESSAGE);

    const verdict = await verifyIdTokenFor(issued.idToken, clientId, doc.jwksUri, { nonce: flow.nonce });
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
      const current = await readStore();
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
      flow.persisted = true;
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
    flow.planGranted = planGranted;
    // The callback is spent and the session saved: the port, the timer and the listener have done
    // their work, and from here the attempt cannot be cancelled (G5-C9).
    await releaseListener(flow);
    return 'persisted';
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
      persisted: false,
      released: false,
      planGranted: false,
      unsubscribe: undefined,
      timer: undefined,
      resolve,
      result,
    };
    active = flow;
    // The attempt's promise is the caller's at once: a cancel settles it even while the port is
    // still binding (G5-C8), and a failure to prepare or open ends the flow by name.
    void prepareAndOpen(flow, opts).catch((err: unknown) => endFlow(flow, toSignInFailure(err)));
    return result;
  }

  async function cancelSignIn(): Promise<void> {
    const flow = active;
    if (flow === undefined) {
      await deps.loopback.cancel().catch(() => undefined);
      return;
    }
    if (flow.persisted) return; // the session is saved; only the model list is still in flight (G5-C9)
    await endFlow(flow, failure('sign_in_needed', 'Sign-in cancelled.'));
  }

  // ---- sign-out, forget (AC9, D7) --------------------------------------------------------

  async function signOut(): Promise<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }> {
    await cancelSignIn();
    const held = await enqueue(async () => {
      const file = await readStore();
      epoch++;
      if (file === undefined) return undefined;
      const tokens = file.tokens;
      const toRevoke = tokens !== undefined && file.clientId !== undefined ? { refreshToken: tokens.refreshToken, clientId: file.clientId } : undefined;
      if (holdsSession(file)) {
        const next = registrationOnly(file);
        await deps.store.write(next);
        publish(next);
      }
      return toRevoke;
    });
    if (held === undefined) return { revocation: 'none' };
    return { revocation: await revoke(held.refreshToken, held.clientId) };
  }

  async function forgetRegistration(): Promise<void> {
    await cancelSignIn();
    const held = await enqueue(async () => {
      // A file that cannot be read is still one to forget (G5-C1): the clear is the remedy.
      const file = await readStore().catch(() => undefined);
      epoch++;
      await deps.store.clear();
      publish(undefined);
      const tokens = file?.tokens;
      return tokens !== undefined && file?.clientId !== undefined ? { refreshToken: tokens.refreshToken, clientId: file.clientId } : undefined;
    });
    if (held !== undefined) await revoke(held.refreshToken, held.clientId);
  }

  // ---- flush (G5-C2) ---------------------------------------------------------------------

  /**
   * Each pass settles what is in flight — the refresh promise, a sign-in's exchange — and then
   * the queue behind it, where their writes land; a job that started meanwhile is caught by the
   * next pass. Bounded, and never a rejection: whatever those jobs threw was theirs to report.
   */
  async function flush(): Promise<void> {
    for (let pass = 0; pass < 4; pass++) {
      const inflight: Promise<unknown>[] = [];
      if (inflightRefresh !== undefined) inflight.push(inflightRefresh);
      if (inflightExchange !== undefined) inflight.push(inflightExchange);
      if (inflight.length > 0) await Promise.allSettled(inflight);
      await tail;
      if (inflightRefresh === undefined && inflightExchange === undefined) return;
    }
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
    reportRejected,
    flush,
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
