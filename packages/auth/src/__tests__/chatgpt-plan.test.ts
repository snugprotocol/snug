// TASK-20261023-siwc-chatgpt-plan — Gate 3 tests for L1: the ChatGPT-plan session keeper
// (`createChatgptPlanSession`, ADR-0078 §2/§4/§7/§10, plan D2/D4/D7/D10). Written FIRST; the
// implementation lane makes them green. Grouped by acceptance criterion (AC2, AC3, AC5, AC6,
// AC8, AC9, AC10, F9).
//
// SEAMS THIS FILE FIXES (the implementation follows them):
//   - RANDOMNESS: the deps take `randomBytes(n: number): Uint8Array` — the ONE source of
//     randomness for the PKCE verifier, the state's flowId, the per-flow state secret, the
//     nonce and the minted host id (`urn:uuid:` v4 built from 16 of its bytes). Default:
//     `crypto.getRandomValues`. Pinned by the determinism test (two keepers on the same seed
//     send the same nonce / challenge / flowId / host id).
//   - CLOCK: `clock(): number` (epoch ms) drives every expiry decision (refresh window, the
//     `earliest_refresh_at` floor, ID-token `exp` with a 120 s skew). The tests run at
//     T0 = 2030-01-01 so that `verifyState` (which reads the real `Date.now`) still accepts a
//     state whose `exp` the keeper derived from its clock.
//   - TIMEOUTS: the refresh's own 15 s timeout and the revocation's 5 s timeout must be armed
//     with `setTimeout` + an `AbortController` (vitest's fake timers drive those; they do NOT
//     drive `AbortSignal.timeout` — measured). The fetch receives that controller's signal.
//   - "NOT READY": a token endpoint answering HTTP 400 `{"error":"refresh_not_ready"}` is the
//     server's not-ready answer → `ChatgptPlanError('refresh_not_ready', retryable: true)`,
//     tokens kept. (Chosen: an OAuth error code the spike never saw; a 429 is NOT pinned.)
//   - `earliest_refresh_at` arrives as epoch SECONDS (measured: a number, ~3239 s after the
//     grant); the file stores epoch MILLISECONDS like every other instant.
//
// Fakes: an in-memory `ChatgptSessionStore` recording every write; a URL-routed fetch
// (discovery, token, jwks, models, revocation) recording bodies/headers, per-route handlers a
// test can replace (fail, defer, hang); a fake `ChatgptLoopbackSeat` with `deliver(delivery)`;
// a capturing `openExternal`; a fake clock.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { base64UrlToUtf8 } from '../base64url.js';
import {
  CHATGPT_PLAN_ERROR_CODES,
  ChatgptPlanError,
  createChatgptPlanSession,
  type ChatgptLoopbackSeat,
  type ChatgptPlanSession,
  type ChatgptSessionFile,
  type ChatgptSessionStore,
  type SignInResult,
} from '../chatgpt-plan.js';
import * as indexExports from '../index.js';
import { pkceChallenge, type CallbackDelivery, type CallbackErrorDelivery } from '../oauth-service.js';
import {
  decodeJwtPayload,
  hs256IdToken,
  jwksDocument,
  makeRsaKey,
  signIdToken,
  unsignedIdToken,
  type IdTokenClaims,
  type RsaFixtureKey,
} from './fixtures/chatgpt-plan-jwt.js';

// ------------------------------------------------------------------ constants (measured)

const ISSUER = 'https://auth.openai.com';
const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';
const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';
const MODELS_URL = 'https://api.openai.com/v1/models';
const RESOURCE = 'https://api.openai.com/v1';
const SIX_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'chatgpt.tokens.use.direct', 'resource.invoke'];
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const ISSUED_CLIENT = 'oaiapp_issued_1';
const SEEDED_HOST = 'urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e';
const SUB = 'user-A';
const EMAIL = 'ada@example.com';
const NAME = 'Ada';
const T0 = Date.UTC(2030, 0, 1);
const UUID_V4_URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EARLIEST_OFFSET_S = 3239;

const DEFAULT_DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE_URL,
  token_endpoint: TOKEN_URL,
  jwks_uri: JWKS_URL,
  revocation_endpoint: REVOKE_URL,
};

/** `/v1/models` as measured: Codex-style entries; only `visibility:'list'` is offered, in server order. */
const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-6.1-sol',
      display_name: 'GPT-6.1-Sol',
      visibility: 'list',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'medium', description: 'Balanced' },
        { effort: 'ultra', description: 'Deepest' },
      ],
      context_window: 500000,
    },
    { slug: 'internal-hidden', display_name: 'Hidden', visibility: 'hide', default_reasoning_level: 'low' },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      visibility: 'list',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium'],
    },
    { slug: 'gpt-6-mini', display_name: 'GPT-6-Mini', visibility: 'list' },
    { slug: 'gpt-none', display_name: 'None', visibility: 'none' },
  ],
};
const EXPECTED_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'low' },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', efforts: ['low', 'medium'], defaultEffort: 'medium' },
  { id: 'gpt-6-mini', name: 'GPT-6-Mini', efforts: [] },
];

// ---------------------------------------------------------------------------- helpers

let KEY: RsaFixtureKey;
let OTHER_KEY: RsaFixtureKey;

beforeAll(async () => {
  KEY = await makeRsaKey();
  // Same kid, different key: a token it signs names the trusted kid but cannot verify.
  OTHER_KEY = await makeRsaKey();
}, 30_000);

afterEach(() => {
  vi.useRealTimers();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Event-loop turns WITHOUT setTimeout (some tests fake it): WebCrypto settles off-thread. */
async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

async function waitFor(pred: () => boolean, label: string, turns = 600): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (pred()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** The deterministic randomness seam: an LCG, so two keepers on one seed draw the same bytes. */
function seededRandom(seed = 7): (n: number) => Uint8Array {
  let s = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      out[i] = s >>> 24;
    }
    return out;
  };
}

function peekState(state: string): { appId: string; flowId: string } & Record<string, unknown> {
  return JSON.parse(base64UrlToUtf8(state.split('.')[0] ?? '')) as { appId: string; flowId: string };
}

class MemoryStore implements ChatgptSessionStore {
  file: ChatgptSessionFile | undefined;
  readonly writes: ChatgptSessionFile[] = [];
  clears = 0;
  reads = 0;
  readGate: Promise<void> | undefined;

  constructor(
    private readonly log: string[],
    initial?: ChatgptSessionFile,
  ) {
    this.file = initial === undefined ? undefined : structuredClone(initial);
  }

  async read(): Promise<ChatgptSessionFile | undefined> {
    this.reads++;
    if (this.readGate !== undefined) await this.readGate;
    return this.file === undefined ? undefined : structuredClone(this.file);
  }

  async write(file: ChatgptSessionFile): Promise<void> {
    const copy = structuredClone(file);
    this.writes.push(copy);
    this.file = structuredClone(copy);
    this.log.push(`write:${copy.tokens?.refreshToken ?? '-'}`);
  }

  async clear(): Promise<void> {
    this.clears++;
    this.file = undefined;
    this.log.push('clear');
  }
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  form: URLSearchParams | undefined;
  formEncoded: boolean;
  init: RequestInit | undefined;
}
type Handler = (call: Call) => Response | Promise<Response>;

/** A request that never answers unless its signal aborts — the shape a timeout must end. */
function hang(call: Call): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = call.init?.signal;
    if (signal === undefined || signal === null) return; // never settles: the test asserts a signal first
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')));
  });
}

interface Issued {
  access: string;
  refresh: string;
  id: string;
}

interface Harness {
  now: number;
  store: MemoryStore;
  log: string[];
  calls: Call[];
  opened: string[];
  issued: Issued[];
  loopback: ReturnType<typeof makeLoopback>;
  discovery: Record<string, unknown>;
  jwksKeys: Array<Record<string, unknown>>;
  grantedScope: string;
  /** Builds the ID token the token endpoint returns; tests replace it to plant one defect. */
  idTokenFor: (claims: IdTokenClaims, grant: string) => Promise<string>;
  on: { discovery: Handler; token: Handler; jwks: Handler; models: Handler; revoke: Handler };
  session: ChatgptPlanSession;
  defaultToken: Handler;
  calls_to(url: string): Call[];
  tokenPosts(): Call[];
  authorizeParams(index?: number): URLSearchParams;
}

function makeLoopback(firstPort = 51234) {
  let port = firstPort;
  let cancels = 0;
  const begins: string[] = [];
  const uris: string[] = [];
  const subs = new Set<(d: CallbackDelivery | CallbackErrorDelivery) => void>();
  const seat: ChatgptLoopbackSeat = {
    async begin(path: string) {
      begins.push(path);
      const uri = `http://127.0.0.1:${port++}${path}`;
      uris.push(uri);
      return { redirectUri: uri };
    },
    onCallback(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    async cancel() {
      cancels++;
    },
  };
  return {
    seat,
    begins,
    uris,
    get cancels() {
      return cancels;
    },
    deliver(d: CallbackDelivery | CallbackErrorDelivery) {
      for (const sub of [...subs]) sub(d);
    },
  };
}

function baseClaims(now: number): IdTokenClaims {
  const s = Math.floor(now / 1000);
  return {
    iss: ISSUER,
    sub: SUB,
    aud: [ISSUED_CLIENT],
    email: EMAIL,
    email_verified: true,
    name: NAME,
    iat: s,
    auth_time: s,
    exp: s + 3600,
    jti: 'jti-1',
    sid: 'sid-1',
    at_hash: 'at-hash',
  };
}

function makeHarness(
  opts: {
    file?: ChatgptSessionFile;
    store?: MemoryStore;
    log?: string[];
    readGate?: Promise<void>;
    seed?: number;
    port?: number;
  } = {},
): Harness {
  const log = opts.log ?? [];
  const store = opts.store ?? new MemoryStore(log, opts.file);
  if (opts.readGate !== undefined) store.readGate = opts.readGate;
  const loopback = makeLoopback(opts.port);
  const counters = { signin: 0, rotated: 0 };

  const h = {
    now: T0,
    store,
    log,
    calls: [] as Call[],
    opened: [] as string[],
    issued: [] as Issued[],
    loopback,
    discovery: { ...DEFAULT_DISCOVERY } as Record<string, unknown>,
    jwksKeys: [] as Array<Record<string, unknown>>,
    grantedScope: SIX_SCOPES.join(' '),
    idTokenFor: (claims: IdTokenClaims) => signIdToken(claims, KEY),
  } as unknown as Harness;
  h.jwksKeys = [KEY.publicJwk];

  h.defaultToken = async (call) => {
    const grant = call.form?.get('grant_type') ?? '';
    const clientId = call.form?.get('client_id') ?? '';
    const tag = grant === 'authorization_code' ? 'signin' : 'rotated';
    const n = ++counters[tag];
    const claims: IdTokenClaims = { ...baseClaims(h.now), aud: [clientId] };
    if (grant === 'authorization_code') claims['nonce'] = h.authorizeParams().get('nonce');
    const id = await h.idTokenFor(claims, grant);
    const issued = { access: `at-${tag}-${n}`, refresh: `rt-${tag}-${n}`, id };
    h.issued.push(issued);
    return json({
      access_token: issued.access,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: h.grantedScope,
      refresh_token: issued.refresh,
      id_token: issued.id,
      earliest_refresh_at: Math.floor(h.now / 1000) + EARLIEST_OFFSET_S,
    });
  };

  h.on = {
    discovery: () => json(h.discovery),
    token: (call) => h.defaultToken(call),
    jwks: () => json(jwksDocument(h.jwksKeys)),
    models: () => json(MODELS_BODY),
    revoke: () => new Response(null, { status: 200 }),
  };

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    let form: URLSearchParams | undefined;
    let formEncoded = false;
    if (init?.body instanceof URLSearchParams) {
      form = new URLSearchParams(init.body);
      formEncoded = true;
    } else if (typeof init?.body === 'string') {
      form = new URLSearchParams(init.body);
      formEncoded = (headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
    }
    const call: Call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, form, formEncoded, init };
    h.calls.push(call);
    h.log.push(`fetch:${url}`);
    const path = url.split('?')[0];
    if (path === DISCOVERY_URL) return h.on.discovery(call);
    if (path === h.discovery['token_endpoint']) return h.on.token(call);
    if (path === h.discovery['jwks_uri']) return h.on.jwks(call);
    if (path === h.discovery['revocation_endpoint']) return h.on.revoke(call);
    if (path === MODELS_URL) return h.on.models(call);
    throw new TypeError(`unrouted fetch in test: ${url}`);
  };

  h.calls_to = (url: string) => h.calls.filter((c) => c.url.split('?')[0] === url);
  h.tokenPosts = () => h.calls.filter((c) => c.url.split('?')[0] === h.discovery['token_endpoint']);
  h.authorizeParams = (index = -1) => {
    const raw = h.opened.at(index);
    if (raw === undefined) throw new Error('no authorize URL opened yet');
    return new URL(raw).searchParams;
  };

  h.session = createChatgptPlanSession({
    store,
    fetch: fetchImpl,
    loopback: loopback.seat,
    openExternal: async (url: string) => {
      h.opened.push(url);
    },
    clock: () => h.now,
    randomBytes: seededRandom(opts.seed),
  });
  return h;
}

/** A signed-in file as the keeper would have written it. The stored ID token is validly signed. */
async function signedInFile(
  over: { tokens?: Partial<ChatgptSessionFile['tokens'] & object>; planGranted?: boolean } = {},
): Promise<ChatgptSessionFile> {
  const idToken = await signIdToken({ ...baseClaims(T0), nonce: 'seed-nonce' }, KEY);
  return {
    v: 1,
    hostId: SEEDED_HOST,
    clientId: ISSUED_CLIENT,
    planGranted: over.planGranted ?? true,
    account: { sub: SUB, email: EMAIL, name: NAME },
    tokens: {
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      idToken,
      expiresAt: T0 + 3600_000,
      earliestRefreshAt: T0 + EARLIEST_OFFSET_S * 1000,
      scopes: SIX_SCOPES,
      ...over.tokens,
    },
  };
}

function registeredFile(): ChatgptSessionFile {
  return { v: 1, hostId: SEEDED_HOST, clientId: ISSUED_CLIENT, planGranted: false };
}

/** Inside the proactive window of `signedInFile()` and past its `earliestRefreshAt`. */
const IN_WINDOW = T0 + 3600_000 - 30_000;

function codeDelivery(
  params: URLSearchParams,
  opts: { code?: string; clientId?: string | null; state?: string } = {},
): CallbackDelivery {
  const state = opts.state ?? params.get('state') ?? '';
  const peek = peekState(state);
  const delivery: CallbackDelivery = { appId: peek.appId, flowId: peek.flowId, code: opts.code ?? 'auth-code-1', state };
  const clientId = opts.clientId === undefined ? ISSUED_CLIENT : opts.clientId;
  if (clientId !== null) delivery.clientId = clientId;
  return delivery;
}

interface Attempt {
  result: Promise<SignInResult>;
  settled(): boolean;
  opened: boolean;
  params: URLSearchParams | undefined;
}

/** Starts a sign-in and waits until the browser was opened OR the attempt already ended. */
async function startSignIn(h: Harness, opts?: { prompt?: 'consent' }): Promise<Attempt> {
  const before = h.opened.length;
  let done = false;
  const result = h.session.signIn(opts);
  result.then(
    () => (done = true),
    () => (done = true),
  );
  await waitFor(() => h.opened.length > before || done, 'signIn opened the browser or ended');
  const opened = h.opened.length > before;
  return { result, settled: () => done, opened, params: opened ? h.authorizeParams() : undefined };
}

/** A whole first sign-in: open, deliver the code (with the issued client id), await the result. */
async function completeSignIn(
  h: Harness,
  opts: { clientId?: string | null; prompt?: 'consent' } = {},
): Promise<{ result: SignInResult; params: URLSearchParams | undefined }> {
  const attempt = await startSignIn(h, opts.prompt === undefined ? undefined : { prompt: opts.prompt });
  if (attempt.opened && attempt.params !== undefined && !attempt.settled()) {
    h.loopback.deliver(codeDelivery(attempt.params, { clientId: opts.clientId }));
  }
  return { result: await attempt.result, params: attempt.params };
}

async function expectPlanError(p: Promise<unknown>, code: string, retryable?: boolean): Promise<ChatgptPlanError> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected a ChatgptPlanError(${code})`).toBeInstanceOf(ChatgptPlanError);
  const err = caught as ChatgptPlanError;
  expect(err.code).toBe(code);
  if (retryable !== undefined) expect(err.retryable).toBe(retryable);
  return err;
}

/** After the first write carrying the rotated refresh token, no write may carry another one. */
function expectNoStaleWriteAfterRotation(store: MemoryStore, rotated: string): void {
  const first = store.writes.findIndex((w) => w.tokens?.refreshToken === rotated);
  expect(first, 'the rotated refresh token was persisted').toBeGreaterThanOrEqual(0);
  for (const later of store.writes.slice(first)) {
    if (later.tokens !== undefined) expect(later.tokens.refreshToken).toBe(rotated);
  }
}

// ===================================================================== exports & shape

describe('L1 exports', () => {
  it('createChatgptPlanSession is exported from the module and from the package index', () => {
    expect(typeof createChatgptPlanSession).toBe('function');
    expect(typeof (indexExports as Record<string, unknown>)['createChatgptPlanSession']).toBe('function');
  });
});

// ===================================================================== F9 — 'unknown' means wait

describe("F9 — status 'unknown' until the first store read answers; callers wait, never refuse", () => {
  it("status() is 'unknown' before the first read resolves and getAccessToken AWAITS the read", async () => {
    const gate = deferred();
    const h = makeHarness({ file: await signedInFile(), readGate: gate.promise });
    expect(h.session.status()).toBe('unknown');

    let settled = false;
    const token = h.session.getAccessToken().finally(() => (settled = true));
    await flush();
    expect(settled, 'a valid session must not be refused while the read is pending').toBe(false);
    expect(h.session.status()).toBe('unknown');

    gate.resolve();
    await expect(token).resolves.toBe('at-old');
  });

  it('the keeper reads the store on construction: status leaves unknown without any call, and subscribers hear it', async () => {
    const gate = deferred();
    const h = makeHarness({ file: await signedInFile(), readGate: gate.promise });
    const heard = vi.fn();
    h.session.subscribe(heard);
    gate.resolve();
    await waitFor(() => h.session.status() !== 'unknown', 'status left unknown');
    expect(h.session.status()).toMatchObject({ signedIn: true, planGranted: true, email: EMAIL, name: NAME });
    expect(heard).toHaveBeenCalled();
  });

  it('no file → signed out, not registered', async () => {
    const h = makeHarness();
    await waitFor(() => h.session.status() !== 'unknown', 'status left unknown');
    expect(h.session.status()).toEqual({ signedIn: false, registered: false });
  });

  it('a registration without tokens → signed out, registered', async () => {
    const h = makeHarness({ file: registeredFile() });
    await waitFor(() => h.session.status() !== 'unknown', 'status left unknown');
    expect(h.session.status()).toEqual({ signedIn: false, registered: true });
  });

  it('getAccessToken with no session throws sign_in_needed by name, not retryable', async () => {
    const h = makeHarness({ file: registeredFile() });
    await expectPlanError(h.session.getAccessToken(), 'sign_in_needed', false);
    const h2 = makeHarness();
    await expectPlanError(h2.session.getAccessToken(), 'sign_in_needed', false);
  });

  it('every use READS the file — no long-lived token is held in memory (D2)', async () => {
    const h = makeHarness({ file: await signedInFile() });
    await expect(h.session.getAccessToken()).resolves.toBe('at-old');
    // Another writer (the shell, a second keeper call) replaced the token on disk.
    h.store.file!.tokens = { ...h.store.file!.tokens!, accessToken: 'at-on-disk' };
    await expect(h.session.getAccessToken()).resolves.toBe('at-on-disk');
  });
});

// ===================================================================== AC2 — sign-in

describe('AC2 — sign-in on the loopback with dynamic registration', () => {
  it('asks the loopback seat for /auth/callback and opens the authorize URL in the system browser', async () => {
    const h = makeHarness();
    const attempt = await startSignIn(h);
    expect(h.loopback.begins).toEqual(['/auth/callback']);
    expect(h.opened).toHaveLength(1);
    const url = new URL(h.opened[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(attempt.params!.get('redirect_uri')).toBe('http://127.0.0.1:51234/auth/callback');
    await h.session.cancelSignIn();
  });

  it('a first sign-in sends exactly the documented parameters', async () => {
    const h = makeHarness();
    const { params } = await startSignIn(h);
    const p = params!;
    expect([...new Set(p.keys())].sort()).toEqual(
      [
        'agent_name_hint',
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'ext_agent_host_id',
        'nonce',
        'redirect_uri',
        'resource',
        'response_type',
        'scope',
        'state',
      ].sort(),
    );
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(DYNAMIC_CLIENT);
    expect(p.get('agent_name_hint')).toBe('Snug');
    expect(p.get('resource')).toBe(RESOURCE);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('scope')!.split(' ').sort()).toEqual([...SIX_SCOPES].sort());
    expect(p.get('ext_agent_host_id')).toMatch(UUID_V4_URN);
    expect(p.get('nonce')!.length).toBeGreaterThanOrEqual(16);
    expect(p.has('prompt')).toBe(false);
    await h.session.cancelSignIn();
  });

  it('the state is signState-shaped: base64url {appId:"chatgpt-plan", flowId} + an HMAC signature', async () => {
    const h = makeHarness();
    const { params } = await startSignIn(h);
    const state = params!.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const payload = peekState(state);
    expect(payload.appId).toBe('chatgpt-plan');
    expect(typeof payload.flowId).toBe('string');
    expect(payload.flowId.length).toBeGreaterThan(0);
    await h.session.cancelSignIn();
  });

  it('state, nonce and PKCE challenge are fresh per attempt; the host id is the same on every attempt', async () => {
    const h = makeHarness();
    const first = (await startSignIn(h)).params!;
    await h.session.cancelSignIn();
    const second = (await startSignIn(h)).params!;
    expect(second.get('state')).not.toBe(first.get('state'));
    expect(second.get('nonce')).not.toBe(first.get('nonce'));
    expect(second.get('code_challenge')).not.toBe(first.get('code_challenge'));
    expect(second.get('ext_agent_host_id')).toBe(first.get('ext_agent_host_id'));
    await h.session.cancelSignIn();
  });

  it('the host id is minted once per machine and PERSISTED before the callback — a restarted keeper reuses it', async () => {
    const log: string[] = [];
    const store = new MemoryStore(log);
    const h1 = makeHarness({ store, log });
    const hostId = (await startSignIn(h1)).params!.get('ext_agent_host_id');
    expect(store.file?.hostId).toBe(hostId);
    expect(store.file?.clientId, 'no client id before an exchange succeeded').toBeUndefined();
    await h1.session.cancelSignIn();

    const h2 = makeHarness({ store, log, seed: 99 });
    const again = (await startSignIn(h2)).params!;
    expect(again.get('ext_agent_host_id')).toBe(hostId);
    expect(again.get('client_id'), 'still a first sign-in: no registration was completed').toBe(DYNAMIC_CLIENT);
    expect(again.get('agent_name_hint')).toBe('Snug');
    await h2.session.cancelSignIn();
  });

  it('a stored host id is sent verbatim', async () => {
    const h = makeHarness({ file: registeredFile() });
    const { params } = await startSignIn(h);
    expect(params!.get('ext_agent_host_id')).toBe(SEEDED_HOST);
    await h.session.cancelSignIn();
  });

  it('randomness comes ONLY from the randomBytes seam (two keepers on one seed draw the same values)', async () => {
    const a = makeHarness({ seed: 42 });
    const b = makeHarness({ seed: 42 });
    const pa = (await startSignIn(a)).params!;
    const pb = (await startSignIn(b)).params!;
    expect(pb.get('nonce')).toBe(pa.get('nonce'));
    expect(pb.get('code_challenge')).toBe(pa.get('code_challenge'));
    expect(pb.get('ext_agent_host_id')).toBe(pa.get('ext_agent_host_id'));
    expect(peekState(pb.get('state')!).flowId).toBe(peekState(pa.get('state')!).flowId);
    await a.session.cancelSignIn();
    await b.session.cancelSignIn();
  });

  it('prompt=consent is sent only when signIn({ prompt: "consent" })', async () => {
    const h = makeHarness({ file: registeredFile() });
    const { params } = await startSignIn(h, { prompt: 'consent' });
    expect(params!.get('prompt')).toBe('consent');
    await h.session.cancelSignIn();
  });

  it('a first sign-in completes: the issued client id drives the exchange, and the session is persisted', async () => {
    const h = makeHarness();
    const { result, params } = await completeSignIn(h);
    expect(result.ok).toBe(true);

    const posts = h.tokenPosts();
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.method).toBe('POST');
    expect(post.formEncoded, 'the exchange is form-encoded').toBe(true);
    expect(post.init?.redirect).toBe('manual');
    const body = post.form!;
    expect([...new Set(body.keys())].sort()).toEqual(
      ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource'].sort(),
    );
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('client_id')).toBe(ISSUED_CLIENT);
    expect(body.get('redirect_uri'), 'byte-identical to the authorize request').toBe(params!.get('redirect_uri'));
    expect(body.get('redirect_uri')).toBe(h.loopback.uris[0]);
    expect(body.get('resource')).toBe(RESOURCE);
    expect(body.has('client_secret')).toBe(false);
    const verifier = body.get('code_verifier')!;
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(await pkceChallenge(verifier)).toBe(params!.get('code_challenge'));

    const issued = h.issued[0]!;
    const file = h.store.file!;
    expect(file.clientId).toBe(ISSUED_CLIENT);
    expect(file.hostId).toBe(params!.get('ext_agent_host_id'));
    expect(file.planGranted).toBe(true);
    expect(file.account).toEqual({ sub: SUB, email: EMAIL, name: NAME });
    expect(file.tokens).toEqual({
      accessToken: issued.access,
      refreshToken: issued.refresh,
      idToken: issued.id,
      expiresAt: T0 + 3600_000,
      earliestRefreshAt: (Math.floor(T0 / 1000) + EARLIEST_OFFSET_S) * 1000,
      scopes: SIX_SCOPES,
    });
  });

  it('after a sign-in the plan models are fetched with the bearer and the status carries them', async () => {
    const h = makeHarness();
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(true);
    await waitFor(() => {
      const s = h.session.status();
      return s !== 'unknown' && s.signedIn && s.models.length > 0;
    }, 'the model list reached the status');
    const modelCalls = h.calls_to(MODELS_URL);
    expect(modelCalls.length).toBeGreaterThanOrEqual(1);
    expect(modelCalls[0]!.method).toBe('GET');
    expect(modelCalls[0]!.headers.get('authorization')).toBe(`Bearer ${h.issued[0]!.access}`);
    expect(h.session.status()).toEqual({
      signedIn: true,
      planGranted: true,
      email: EMAIL,
      name: NAME,
      models: EXPECTED_MODELS,
    });
    if (result.ok) expect(result.status).toMatchObject({ signedIn: true, planGranted: true });
  });

  it('a failing model list never fails the sign-in (soft)', async () => {
    const h = makeHarness();
    h.on.models = () => Promise.reject(new TypeError('Failed to fetch'));
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(true);
    expect(h.store.file?.tokens?.refreshToken).toBe(h.issued[0]!.refresh);
  });

  it('a first callback WITHOUT a client id is registration_incomplete — nothing is exchanged', async () => {
    const h = makeHarness();
    const { result } = await completeSignIn(h, { clientId: null });
    expect(result).toMatchObject({ ok: false, code: 'registration_incomplete' });
    expect(h.tokenPosts()).toHaveLength(0);
    expect(h.store.file?.clientId).toBeUndefined();
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('a re-auth sends the kept client id, OMITS agent_name_hint, and accepts a callback without client_id', async () => {
    const h = makeHarness({ file: registeredFile() });
    const { result, params } = await completeSignIn(h, { clientId: null });
    expect(params!.get('client_id')).toBe(ISSUED_CLIENT);
    expect(params!.has('agent_name_hint')).toBe(false);
    expect(result.ok).toBe(true);
    expect(h.tokenPosts()[0]!.form!.get('client_id')).toBe(ISSUED_CLIENT);
    expect(h.store.file?.clientId).toBe(ISSUED_CLIENT);
  });

  it('a re-auth works on a different port than the registration (measured: 1455 → 1456)', async () => {
    const h = makeHarness({ file: registeredFile(), port: 1456 });
    const { result, params } = await completeSignIn(h, { clientId: null });
    expect(result.ok).toBe(true);
    expect(params!.get('redirect_uri')).toBe('http://127.0.0.1:1456/auth/callback');
    expect(h.tokenPosts()[0]!.form!.get('redirect_uri')).toBe('http://127.0.0.1:1456/auth/callback');
  });

  it('a re-auth callback echoing the SAME client id is accepted', async () => {
    const h = makeHarness({ file: registeredFile() });
    const { result } = await completeSignIn(h, { clientId: ISSUED_CLIENT });
    expect(result.ok).toBe(true);
  });

  it('a callback naming a DIFFERENT client than the stored one is client_mismatch — nothing exchanged, registration untouched', async () => {
    const h = makeHarness({ file: registeredFile() });
    const { result } = await completeSignIn(h, { clientId: 'oaiapp_someone_else' });
    expect(result).toMatchObject({ ok: false, code: 'client_mismatch' });
    expect(h.tokenPosts()).toHaveLength(0);
    expect(h.store.file?.clientId).toBe(ISSUED_CLIENT);
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('a forged state (bad signature) is refused before any exchange', async () => {
    const h = makeHarness();
    const attempt = await startSignIn(h);
    const real = attempt.params!.get('state')!;
    const forged = `${real.split('.')[0]}.${'0'.repeat(64)}`;
    h.loopback.deliver(codeDelivery(attempt.params!, { state: forged }));
    await flush();
    expect(h.tokenPosts()).toHaveLength(0);
    if (!attempt.settled()) await h.session.cancelSignIn();
    const result = await attempt.result;
    expect(result.ok).toBe(false);
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it("an earlier attempt's state does not verify for the next attempt (per-flow secret)", async () => {
    const h = makeHarness();
    const first = (await startSignIn(h)).params!;
    await h.session.cancelSignIn();
    const second = await startSignIn(h);
    h.loopback.deliver(codeDelivery(second.params!, { state: first.get('state')! }));
    await flush();
    expect(h.tokenPosts()).toHaveLength(0);
    if (!second.settled()) await h.session.cancelSignIn();
    expect((await second.result).ok).toBe(false);
  });

  it('a declined consent (error delivery) ends the sign-in by name, cancels the listener, exchanges nothing', async () => {
    const h = makeHarness();
    const attempt = await startSignIn(h);
    const state = attempt.params!.get('state')!;
    const peek = peekState(state);
    const declined: CallbackErrorDelivery = {
      appId: peek.appId,
      flowId: peek.flowId,
      state,
      error: 'access_denied',
      errorDescription: 'The user declined.',
    };
    const cancelsBefore = h.loopback.cancels;
    h.loopback.deliver(declined);
    const result = await attempt.result;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(CHATGPT_PLAN_ERROR_CODES).toContain(result.code);
      expect(result.message.length).toBeGreaterThan(0);
    }
    expect(h.loopback.cancels).toBeGreaterThan(cancelsBefore);
    // A late code for the ended flow is never exchanged.
    h.loopback.deliver(codeDelivery(attempt.params!));
    await flush();
    expect(h.tokenPosts()).toHaveLength(0);
  });

  it('cancelSignIn() cancels the loopback and settles the pending signIn; a late code is ignored', async () => {
    const h = makeHarness();
    const attempt = await startSignIn(h);
    const cancelsBefore = h.loopback.cancels;
    await h.session.cancelSignIn();
    expect(h.loopback.cancels).toBeGreaterThan(cancelsBefore);
    const result = await attempt.result;
    expect(result.ok).toBe(false);
    h.loopback.deliver(codeDelivery(attempt.params!));
    await flush();
    expect(h.tokenPosts()).toHaveLength(0);
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('the issued client id is NOT persisted when the exchange fails', async () => {
    const h = makeHarness();
    h.on.token = () => json({ error: 'invalid_grant', error_description: 'bad code' }, 400);
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(false);
    expect(h.store.file?.clientId).toBeUndefined();
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it("the issued client id is NOT persisted when the ID token's aud does not contain it", async () => {
    const h = makeHarness();
    h.idTokenFor = (claims) => signIdToken({ ...claims, aud: ['oaiapp_other'] }, KEY);
    const { result } = await completeSignIn(h);
    expect(result).toMatchObject({ ok: false, code: 'id_token_invalid' });
    expect(h.store.file?.clientId).toBeUndefined();
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('an exchange error that echoes the code and verifier never carries them into the result message (C1)', async () => {
    const h = makeHarness();
    h.on.token = (call) =>
      json(
        {
          error: 'invalid_grant',
          error_description: `bad code ${call.form!.get('code')} verifier ${call.form!.get('code_verifier')}`,
        },
        400,
      );
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(false);
    const verifier = h.tokenPosts()[0]!.form!.get('code_verifier')!;
    if (!result.ok) {
      expect(result.message).not.toContain('auth-code-1');
      expect(result.message).not.toContain(verifier);
    }
  });
});

// ===================================================================== discovery & ceilings

describe('discovery — endpoints come from the document and every one is host-ceilinged to auth.openai.com', () => {
  it('uses the discovery document’s token endpoint, not a built-in one', async () => {
    const h = makeHarness();
    h.discovery['token_endpoint'] = 'https://auth.openai.com/v2/oauth/token';
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(true);
    expect(h.calls_to('https://auth.openai.com/v2/oauth/token')).toHaveLength(1);
  });

  it('fetches the discovery document from the fixed well-known URL', async () => {
    const h = makeHarness();
    await completeSignIn(h);
    expect(h.calls_to(DISCOVERY_URL).length).toBeGreaterThanOrEqual(1);
  });

  for (const [field, evil] of [
    ['authorization_endpoint', 'https://auth.openai.com.evil.example/authorize'],
    ['token_endpoint', 'https://evil.example/oauth/token'],
    ['jwks_uri', 'https://evil.example/jwks.json'],
  ] as const) {
    it(`a ${field} on another host is refused — no request reaches it and nothing is persisted`, async () => {
      const h = makeHarness();
      h.discovery[field] = evil;
      const attempt = await startSignIn(h);
      if (field === 'authorization_endpoint') {
        expect(attempt.opened, 'the browser is never sent to another host').toBe(false);
      }
      if (attempt.opened && !attempt.settled()) h.loopback.deliver(codeDelivery(attempt.params!));
      await flush();
      if (!attempt.settled()) await h.session.cancelSignIn();
      const result = await attempt.result;
      expect(result.ok).toBe(false);
      expect(h.calls.filter((c) => c.url.startsWith(new URL(evil).origin))).toHaveLength(0);
      expect(h.store.file?.tokens).toBeUndefined();
      expect(h.store.file?.clientId).toBeUndefined();
    });
  }

  it('a plain-http token endpoint on the right host is refused (the verifier never travels in clear)', async () => {
    const h = makeHarness();
    h.discovery['token_endpoint'] = 'http://auth.openai.com/oauth/token';
    const attempt = await startSignIn(h);
    if (attempt.opened && !attempt.settled()) h.loopback.deliver(codeDelivery(attempt.params!));
    await flush();
    if (!attempt.settled()) await h.session.cancelSignIn();
    expect((await attempt.result).ok).toBe(false);
    expect(h.tokenPosts()).toHaveLength(0);
  });
});

// ===================================================================== AC3 — the ID token

describe('AC3 — the sign-in ID token: every check can fail alone', () => {
  async function signInWith(mutate: (claims: IdTokenClaims) => Promise<string>): Promise<{ h: Harness; result: SignInResult }> {
    const h = makeHarness();
    h.idTokenFor = (claims) => mutate(claims);
    const { result } = await completeSignIn(h);
    return { h, result };
  }

  async function expectRefused(mutate: (claims: IdTokenClaims) => Promise<string>, code = 'id_token_invalid'): Promise<Harness> {
    const { h, result } = await signInWith(mutate);
    expect(result).toMatchObject({ ok: false, code });
    expect(h.store.file?.tokens, 'no token from a refused ID token is ever persisted').toBeUndefined();
    expect(h.store.file?.clientId).toBeUndefined();
    return h;
  }

  it('control: the unmodified RS256 token is accepted (so every refusal below is about its one defect)', async () => {
    const { result } = await signInWith((claims) => signIdToken(claims, KEY));
    expect(result.ok).toBe(true);
  });

  it('a signature by a key the JWKS does not hold is refused (same kid)', async () => {
    await expectRefused((claims) => signIdToken(claims, OTHER_KEY));
  });

  it('a payload altered after signing is refused', async () => {
    await expectRefused(async (claims) => {
      const token = await signIdToken(claims, KEY);
      const [head, , sig] = token.split('.');
      const altered = btoa(JSON.stringify({ ...claims, email: 'mallory@example.com' }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return `${head}.${altered}.${sig}`;
    });
  });

  it('alg: none is refused', async () => {
    await expectRefused(async (claims) => unsignedIdToken(claims));
  });

  it('HS256 keyed with the public modulus (algorithm confusion) is refused', async () => {
    await expectRefused((claims) => hs256IdToken(claims, String(KEY.publicJwk.n)));
  });

  it('a header naming any alg but RS256 is refused, even over a valid RS256 signature', async () => {
    await expectRefused((claims) => signIdToken(claims, KEY, { alg: 'RS512' }));
  });

  it('a wrong iss is refused', async () => {
    await expectRefused((claims) => signIdToken({ ...claims, iss: 'https://auth.openai.com.evil.example' }, KEY));
  });

  it('an aud that does not contain the client id is refused', async () => {
    await expectRefused((claims) => signIdToken({ ...claims, aud: ['oaiapp_other', 'another'] }, KEY));
  });

  it('a string aud equal to the client id is accepted', async () => {
    const { result } = await signInWith((claims) => signIdToken({ ...claims, aud: ISSUED_CLIENT }, KEY));
    expect(result.ok).toBe(true);
  });

  it('with more than one aud, an azp naming another client is refused', async () => {
    await expectRefused((claims) =>
      signIdToken({ ...claims, aud: [ISSUED_CLIENT, 'https://api.openai.com/v1'], azp: 'oaiapp_other' }, KEY),
    );
  });

  it('with more than one aud, an azp equal to the client id is accepted', async () => {
    const { result } = await signInWith((claims) =>
      signIdToken({ ...claims, aud: [ISSUED_CLIENT, 'https://api.openai.com/v1'], azp: ISSUED_CLIENT }, KEY),
    );
    expect(result.ok).toBe(true);
  });

  it('exp more than 120 s in the past is refused (the keeper’s clock, not the wall clock)', async () => {
    await expectRefused((claims) => signIdToken({ ...claims, exp: Math.floor(T0 / 1000) - 121 }, KEY));
  });

  it('exp within the 120 s skew is accepted', async () => {
    const { result } = await signInWith((claims) => signIdToken({ ...claims, exp: Math.floor(T0 / 1000) - 119 }, KEY));
    expect(result.ok).toBe(true);
  });

  it("a nonce other than the attempt's is refused", async () => {
    await expectRefused((claims) => signIdToken({ ...claims, nonce: 'not-the-attempt-nonce' }, KEY));
  });

  it('a missing nonce on a sign-in token is refused', async () => {
    await expectRefused((claims) => {
      const { nonce: _nonce, ...rest } = claims;
      return signIdToken(rest, KEY);
    });
  });

  it('JWKS entries are filtered to kty:RSA + use:sig — a use:enc key under the right kid does not verify', async () => {
    const h = makeHarness();
    h.jwksKeys = [{ ...KEY.publicJwk, use: 'enc' }];
    const { result } = await completeSignIn(h);
    expect(result).toMatchObject({ ok: false, code: 'id_token_invalid' });
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('a non-RSA key sharing the kid is skipped, the RSA key verifies', async () => {
    const h = makeHarness();
    h.jwksKeys = [
      { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', kid: KEY.kid, use: 'sig' },
      KEY.publicJwk,
    ];
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(true);
  });

  it('a kid miss refetches the JWKS ONCE and then verifies', async () => {
    const h = makeHarness();
    let served = 0;
    h.on.jwks = () => {
      served++;
      return json(jwksDocument(served === 1 ? [{ ...OTHER_KEY.publicJwk, kid: 'rotated-away' }] : [KEY.publicJwk]));
    };
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(true);
    expect(h.calls_to(JWKS_URL)).toHaveLength(2);
  });

  it('a kid that is never found is refused after at most one refetch', async () => {
    const h = makeHarness();
    h.jwksKeys = [{ ...KEY.publicJwk, kid: 'some-other-kid' }];
    const { result } = await completeSignIn(h);
    expect(result).toMatchObject({ ok: false, code: 'id_token_invalid' });
    expect(h.calls_to(JWKS_URL).length).toBeLessThanOrEqual(2);
  });

  it("a returning account whose sub differs is subject_mismatch and the stored tokens are NOT replaced", async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.idTokenFor = (claims) => signIdToken({ ...claims, sub: 'user-B' }, KEY);
    const { result } = await completeSignIn(h, { clientId: null, prompt: 'consent' });
    expect(result).toMatchObject({ ok: false, code: 'subject_mismatch' });
    expect(h.store.file?.tokens?.refreshToken).toBe('rt-old');
    expect(h.store.file?.account?.sub).toBe(SUB);
  });

  it('a returning account with the same sub replaces the tokens', async () => {
    const h = makeHarness({ file: await signedInFile() });
    const { result } = await completeSignIn(h, { clientId: null, prompt: 'consent' });
    expect(result.ok).toBe(true);
    expect(h.store.file?.tokens?.refreshToken).toBe(h.issued[0]!.refresh);
  });
});

describe('AC3 — a grant without chatgpt.tokens.use.direct is signed in, plan NOT granted', () => {
  it('signs in with planGranted:false; getAccessToken throws plan_not_granted by name', async () => {
    const h = makeHarness();
    h.grantedScope = SIX_SCOPES.filter((s) => s !== PLAN_SCOPE).join(' ');
    const { result } = await completeSignIn(h);
    expect(result.ok).toBe(true);
    expect(h.store.file?.planGranted).toBe(false);
    expect(h.store.file?.tokens).toBeDefined();
    expect(h.session.status()).toMatchObject({ signedIn: true, planGranted: false });
    await expectPlanError(h.session.getAccessToken(), 'plan_not_granted', false);
  });

  it('re-consent that grants the scope flips planGranted to true', async () => {
    const h = makeHarness({ file: await signedInFile({ planGranted: false, tokens: { scopes: ['openid', 'email'] } }) });
    const { result, params } = await completeSignIn(h, { clientId: null, prompt: 'consent' });
    expect(params!.get('prompt')).toBe('consent');
    expect(result.ok).toBe(true);
    expect(h.store.file?.planGranted).toBe(true);
    await expect(h.session.getAccessToken()).resolves.toBe(h.issued[0]!.access);
  });
});

// ===================================================================== AC5 — refresh

describe('AC5 — proactive and forced refresh, single-flight, rotation-safe', () => {
  it('a fresh token is answered from the file with no refresh POST', async () => {
    const h = makeHarness({ file: await signedInFile() });
    await expect(h.session.getAccessToken()).resolves.toBe('at-old');
    expect(h.tokenPosts()).toHaveLength(0);
  });

  it('just outside the 60 s window (expiresAt − 60 001 ms) → no refresh', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = T0 + 3600_000 - 60_001;
    await expect(h.session.getAccessToken()).resolves.toBe('at-old');
    expect(h.tokenPosts()).toHaveLength(0);
  });

  it('at expiresAt − 60 s and past earliest_refresh_at → exactly one refresh, the rotated token answered', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = T0 + 3600_000 - 60_000;
    await expect(h.session.getAccessToken()).resolves.toBe('at-rotated-1');
    expect(h.tokenPosts()).toHaveLength(1);
  });

  it('inside the window but BEFORE earliest_refresh_at, a still-valid token is NOT refreshed (proactive floor)', async () => {
    const h = makeHarness({ file: await signedInFile({ tokens: { earliestRefreshAt: T0 + 3600_000 - 30_000 } }) });
    h.now = T0 + 3600_000 - 45_000;
    await expect(h.session.getAccessToken()).resolves.toBe('at-old');
    expect(h.tokenPosts()).toHaveLength(0);
  });

  it('an EXPIRED token is refreshed even before earliest_refresh_at (the floor is advisory when forced)', async () => {
    const h = makeHarness({ file: await signedInFile({ tokens: { earliestRefreshAt: T0 + 3700_000 } }) });
    h.now = T0 + 3600_000 + 1_000;
    await expect(h.session.getAccessToken()).resolves.toBe('at-rotated-1');
    expect(h.tokenPosts()).toHaveLength(1);
  });

  it('refreshNow(current) forces a refresh before earliest_refresh_at', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = T0 + 1_000;
    await expect(h.session.refreshNow('at-old')).resolves.toBe('at-rotated-1');
    expect(h.tokenPosts()).toHaveLength(1);
  });

  it('refreshNow(previous) where previous is no longer current answers the current token with no POST', async () => {
    const h = makeHarness({ file: await signedInFile() });
    await expect(h.session.refreshNow('at-some-older-token')).resolves.toBe('at-old');
    expect(h.tokenPosts()).toHaveLength(0);
  });

  it('the refresh POST: form body grant_type, refresh_token, client_id, resource — no scope, no secret; redirect manual; a signal', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = IN_WINDOW;
    await h.session.getAccessToken();
    const post = h.tokenPosts()[0]!;
    expect(post.url).toBe(TOKEN_URL);
    expect(post.method).toBe('POST');
    expect(post.formEncoded).toBe(true);
    expect(post.init?.redirect).toBe('manual');
    expect(post.init?.signal, 'the refresh runs on its own timeout signal').toBeInstanceOf(AbortSignal);
    const body = post.form!;
    expect([...new Set(body.keys())].sort()).toEqual(['client_id', 'grant_type', 'refresh_token', 'resource']);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-old');
    expect(body.get('client_id')).toBe(ISSUED_CLIENT);
    expect(body.get('resource')).toBe(RESOURCE);
  });

  it('single-flight: 8 concurrent getAccessToken + a refreshNow on an expiring token → ONE refresh POST, all get the rotated token', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = IN_WINDOW;
    const gate = deferred();
    h.on.token = async (call) => {
      await gate.promise;
      return h.defaultToken(call);
    };
    const callers = Array.from({ length: 8 }, () => h.session.getAccessToken());
    const forced = h.session.refreshNow('at-old');
    await waitFor(() => h.tokenPosts().length >= 1, 'the refresh POST went out');
    await flush();
    gate.resolve();
    const results = await Promise.all([...callers, forced]);
    expect(h.tokenPosts()).toHaveLength(1);
    expect(new Set(results)).toEqual(new Set(['at-rotated-1']));
    // And the rotated token is fresh: no second refresh afterwards.
    await expect(h.session.getAccessToken()).resolves.toBe('at-rotated-1');
    expect(h.tokenPosts()).toHaveLength(1);
  });

  it('the rotated set is written TOGETHER: one write carries all six new values; no write mixes old and new', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = IN_WINDOW;
    await h.session.getAccessToken();
    const issued = h.issued[0]!;
    const rotatedWrites = h.store.writes.filter((w) => w.tokens?.refreshToken === issued.refresh);
    expect(rotatedWrites.length).toBeGreaterThanOrEqual(1);
    expect(rotatedWrites[0]!.tokens).toEqual({
      accessToken: issued.access,
      refreshToken: issued.refresh,
      idToken: issued.id,
      expiresAt: IN_WINDOW + 3600_000,
      earliestRefreshAt: (Math.floor(IN_WINDOW / 1000) + EARLIEST_OFFSET_S) * 1000,
      scopes: SIX_SCOPES,
    });
    for (const w of h.store.writes) {
      if (w.tokens === undefined) continue;
      const isNew = w.tokens.refreshToken === issued.refresh;
      expect(w.tokens.accessToken === issued.access, 'access token travels with its refresh token').toBe(isNew);
    }
    expect(h.store.file?.clientId).toBe(ISSUED_CLIENT);
    expect(h.store.file?.hostId).toBe(SEEDED_HOST);
    expectNoStaleWriteAfterRotation(h.store, issued.refresh);
  });

  it('persist BEFORE verify: a JWKS outage after the refresh POST keeps the rotated tokens and the session usable', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = IN_WINDOW;
    h.on.jwks = () => Promise.reject(new TypeError('Failed to fetch'));
    await h.session.refreshNow('at-old').catch(() => undefined);
    const rotated = h.issued[0]!;
    expect(h.store.file?.tokens?.refreshToken, 'the only valid refresh token is on disk').toBe(rotated.refresh);
    const tokenPostIndex = h.log.findIndex((e) => e === `fetch:${TOKEN_URL}`);
    const persistIndex = h.log.findIndex((e) => e === `write:${rotated.refresh}`);
    expect(persistIndex).toBeGreaterThan(tokenPostIndex);
    const jwksAfterPost = h.log.findIndex((e, i) => i > tokenPostIndex && e === `fetch:${JWKS_URL}`);
    if (jwksAfterPost >= 0) expect(persistIndex, 'persisted before the JWKS was consulted').toBeLessThan(jwksAfterPost);
    await expect(h.session.getAccessToken()).resolves.toBe(rotated.access);
    expect(h.session.status()).toMatchObject({ signedIn: true });
    expect(h.tokenPosts()).toHaveLength(1);
  });

  it('a refresh ID token carries no nonce and is accepted', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = IN_WINDOW;
    await expect(h.session.getAccessToken()).resolves.toBe('at-rotated-1');
    expect(decodeJwtPayload(h.issued[0]!.id)['nonce']).toBeUndefined();
    expect(h.session.status()).toMatchObject({ signedIn: true });
  });

  for (const [label, mutate] of [
    ['a bad signature', (c: IdTokenClaims) => signIdToken(c, OTHER_KEY)],
    ['a different sub', (c: IdTokenClaims) => signIdToken({ ...c, sub: 'user-B' }, KEY)],
    ['a different iss', (c: IdTokenClaims) => signIdToken({ ...c, iss: 'https://evil.example' }, KEY)],
    ['an aud without the stored client', (c: IdTokenClaims) => signIdToken({ ...c, aud: ['oaiapp_other'] }, KEY)],
  ] as const) {
    it(`a refresh ID token with ${label} clears the tokens, keeps the registration, and names sign_in_needed`, async () => {
      const h = makeHarness({ file: await signedInFile() });
      h.now = IN_WINDOW;
      h.idTokenFor = (claims) => mutate(claims);
      await expectPlanError(h.session.getAccessToken(), 'sign_in_needed');
      const file = h.store.file;
      expect(file?.tokens).toBeUndefined();
      expect(file?.account).toBeUndefined();
      expect(file?.clientId).toBe(ISSUED_CLIENT);
      expect(file?.hostId).toBe(SEEDED_HOST);
      expect(h.session.status()).toEqual({ signedIn: false, registered: true });
    });
  }
});

// ===================================================================== AC6 — refresh failures

describe('AC6 — terminal vs transient refresh failures', () => {
  for (const error of ['invalid_grant', 'refresh_token_reused']) {
    it(`${error} clears the tokens, KEEPS the registration, and names sign_in_needed`, async () => {
      const h = makeHarness({ file: await signedInFile() });
      h.now = IN_WINDOW;
      h.on.token = () => json({ error, error_description: 'refresh token no longer valid' }, 400);
      await expectPlanError(h.session.refreshNow('at-old'), 'sign_in_needed', false);
      const file = h.store.file;
      expect(file?.tokens).toBeUndefined();
      expect(file?.account).toBeUndefined();
      expect(file?.clientId).toBe(ISSUED_CLIENT);
      expect(file?.hostId).toBe(SEEDED_HOST);
      expect(h.session.status()).toEqual({ signedIn: false, registered: true });
      await expectPlanError(h.session.getAccessToken(), 'sign_in_needed');
    });
  }

  it('a "not ready" answer (400 {"error":"refresh_not_ready"}) is refresh_not_ready, retryable, tokens kept', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.on.token = () => json({ error: 'refresh_not_ready' }, 400);
    await expectPlanError(h.session.refreshNow('at-old'), 'refresh_not_ready', true);
    expect(h.store.file?.tokens?.refreshToken).toBe('rt-old');
    expect(h.store.file?.tokens?.accessToken).toBe('at-old');
    expect(h.session.status()).toMatchObject({ signedIn: true });
  });

  it('a network failure is network, retryable, tokens kept', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.on.token = () => Promise.reject(new TypeError('Failed to fetch'));
    await expectPlanError(h.session.refreshNow('at-old'), 'network', true);
    expect(h.store.file?.tokens?.refreshToken).toBe('rt-old');
    expect(h.session.status()).toMatchObject({ signedIn: true });
  });

  it('a refresh error that echoes the refresh token never carries it in the thrown message (C1)', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.on.token = () => json({ error: 'refresh_not_ready', error_description: 'not yet for rt-old' }, 400);
    const err = await expectPlanError(h.session.refreshNow('at-old'), 'refresh_not_ready');
    expect(err.message).not.toContain('rt-old');
  });

  it('the refresh runs on its own 15 s timeout: one timeout earns ONE retry, which can succeed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = makeHarness({ file: await signedInFile() });
    let posts = 0;
    h.on.token = (call) => (++posts === 1 ? hang(call) : h.defaultToken(call));
    const outcome = h.session.refreshNow('at-old').then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await waitFor(() => h.tokenPosts().length === 1, 'first refresh POST');
    expect(h.tokenPosts()[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => h.tokenPosts().length === 2, 'the one retry');
    await flush();
    expect(await outcome).toEqual({ ok: true, v: 'at-rotated-1' });
    expect(h.tokenPosts()).toHaveLength(2);
  });

  it('a second timeout is sign_in_needed — at most one retry, never a refresh storm', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = makeHarness({ file: await signedInFile() });
    h.on.token = (call) => hang(call);
    const outcome = h.session.refreshNow('at-old').then(
      () => undefined,
      (e: unknown) => e,
    );
    await waitFor(() => h.tokenPosts().length === 1, 'first refresh POST');
    expect(h.tokenPosts()[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => h.tokenPosts().length === 2, 'the one retry');
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    const err = await outcome;
    expect(err).toBeInstanceOf(ChatgptPlanError);
    expect((err as ChatgptPlanError).code).toBe('sign_in_needed');
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(h.tokenPosts()).toHaveLength(2);
  });
});

// ===================================================================== D2/D4 — races

describe('D2/D4 — the serial queue + epoch: no resurrection, no stale write-back', () => {
  it('(a) sign-out during an in-flight refresh: no token survives, and the late-rotated refresh token is REVOKED', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.now = IN_WINDOW;
    const gate = deferred();
    h.on.token = async (call) => {
      await gate.promise;
      return h.defaultToken(call);
    };
    const refresh = h.session.refreshNow('at-old').then(
      () => undefined,
      () => undefined,
    );
    await waitFor(() => h.tokenPosts().length === 1, 'refresh POST in flight');
    const signOut = h.session.signOut();
    await flush();
    gate.resolve();
    await Promise.all([refresh, signOut]);
    await flush();

    expect(h.store.file?.tokens).toBeUndefined();
    expect(h.store.file?.account).toBeUndefined();
    expect(h.session.status()).toEqual({ signedIn: false, registered: true });
    const revoked = h.calls_to(REVOKE_URL).map((c) => c.form?.get('token'));
    expect(revoked, 'the rotated refresh token the server just issued is revoked').toContain(h.issued[0]!.refresh);
    await expectPlanError(h.session.getAccessToken(), 'sign_in_needed');
  });

  it('(b1) a model-cache write landing mid-refresh never writes the old refresh token back', async () => {
    const h = makeHarness({ file: await signedInFile() });
    const gate = deferred();
    h.on.token = async (call) => {
      await gate.promise;
      return h.defaultToken(call);
    };
    const refresh = h.session.refreshNow('at-old');
    await waitFor(() => h.tokenPosts().length === 1, 'refresh POST in flight');
    const models = h.session.listModels(true);
    await flush();
    gate.resolve();
    await Promise.all([refresh, models]);
    await flush();
    expect(h.store.file?.tokens?.refreshToken).toBe('rt-rotated-1');
    expect(h.store.file?.models?.list).toEqual(EXPECTED_MODELS);
    expectNoStaleWriteAfterRotation(h.store, 'rt-rotated-1');
  });

  it('(b2) a model fetch started BEFORE the refresh and answered after the rotation never writes the old refresh token back', async () => {
    const h = makeHarness({ file: await signedInFile() });
    const modelsGate = deferred();
    const tokenGate = deferred();
    h.on.models = async () => {
      await modelsGate.promise;
      return json(MODELS_BODY);
    };
    h.on.token = async (call) => {
      await tokenGate.promise;
      return h.defaultToken(call);
    };
    const models = h.session.listModels(true);
    await flush();
    const refresh = h.session.refreshNow('at-old');
    await flush();
    tokenGate.resolve();
    await flush();
    modelsGate.resolve();
    await Promise.all([refresh, models]);
    await flush();
    expect(h.store.file?.tokens?.refreshToken).toBe('rt-rotated-1');
    expect(h.store.file?.models?.list).toEqual(EXPECTED_MODELS);
    expectNoStaleWriteAfterRotation(h.store, 'rt-rotated-1');
  });
});

// ===================================================================== AC8 — models

describe('AC8 — the plan’s models, in OpenAI’s vocabulary, from the account', () => {
  it('listModels(true) GETs /v1/models with the bearer; keeps visibility:list only, in server order; maps the fields', async () => {
    const h = makeHarness({ file: await signedInFile() });
    await expect(h.session.listModels(true)).resolves.toEqual(EXPECTED_MODELS);
    const call = h.calls_to(MODELS_URL)[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(MODELS_URL);
    expect(call.headers.get('authorization')).toBe('Bearer at-old');
    expect(h.store.file?.models?.list).toEqual(EXPECTED_MODELS);
    expect(h.store.file?.models?.fetchedAt).toBe(T0);
    expect(h.store.file?.tokens?.refreshToken, 'a model-cache write keeps the tokens').toBe('rt-old');
    expect(h.session.status()).toMatchObject({ signedIn: true, models: EXPECTED_MODELS });
  });

  it('listModels() answers the cache without a request', async () => {
    const file = await signedInFile();
    file.models = { fetchedAt: T0 - 1000, list: [{ id: 'cached', name: 'Cached', efforts: [] }] };
    const h = makeHarness({ file });
    await expect(h.session.listModels()).resolves.toEqual([{ id: 'cached', name: 'Cached', efforts: [] }]);
    expect(h.calls_to(MODELS_URL)).toHaveLength(0);
  });

  it('listModels(true) fails soft to the last list on a network error', async () => {
    const file = await signedInFile();
    file.models = { fetchedAt: T0 - 1000, list: [{ id: 'cached', name: 'Cached', efforts: [] }] };
    const h = makeHarness({ file });
    h.on.models = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(h.session.listModels(true)).resolves.toEqual([{ id: 'cached', name: 'Cached', efforts: [] }]);
    expect(h.store.file?.models?.list).toEqual([{ id: 'cached', name: 'Cached', efforts: [] }]);
  });
});

// ===================================================================== AC9 — sign-out

describe('AC9 — sign-out revokes best-effort, deletes tokens, keeps the registration', () => {
  it('POSTs token, token_type_hint=refresh_token, client_id to the revocation endpoint; empty 200 → confirmed', async () => {
    const h = makeHarness({ file: await signedInFile() });
    await expect(h.session.signOut()).resolves.toEqual({ revocation: 'confirmed' });
    const calls = h.calls_to(REVOKE_URL);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.formEncoded).toBe(true);
    expect(call.init?.redirect).toBe('manual');
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect([...new Set(call.form!.keys())].sort()).toEqual(['client_id', 'token', 'token_type_hint']);
    expect(call.form!.get('token')).toBe('rt-old');
    expect(call.form!.get('token_type_hint')).toBe('refresh_token');
    expect(call.form!.get('client_id')).toBe(ISSUED_CLIENT);
  });

  it('after sign-out the file keeps only the registration and the status says registered', async () => {
    const file = await signedInFile();
    file.models = { fetchedAt: T0, list: EXPECTED_MODELS };
    const h = makeHarness({ file });
    await h.session.signOut();
    const after = h.store.file!;
    expect(after.tokens).toBeUndefined();
    expect(after.account).toBeUndefined();
    expect(after.models).toBeUndefined();
    expect(after.clientId).toBe(ISSUED_CLIENT);
    expect(after.hostId).toBe(SEEDED_HOST);
    expect(h.session.status()).toEqual({ signedIn: false, registered: true });
    await expectPlanError(h.session.getAccessToken(), 'sign_in_needed');
  });

  it('a 5xx revocation is unconfirmed — and the tokens are STILL deleted locally', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.on.revoke = () => new Response('upstream down', { status: 503 });
    await expect(h.session.signOut()).resolves.toEqual({ revocation: 'unconfirmed' });
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('a network failure on revocation is unconfirmed — tokens still deleted', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.on.revoke = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(h.session.signOut()).resolves.toEqual({ revocation: 'unconfirmed' });
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('a redirect from the revocation endpoint is never followed and never counts as confirmed', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.on.revoke = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } });
    await expect(h.session.signOut()).resolves.toEqual({ revocation: 'unconfirmed' });
    expect(h.calls.filter((c) => c.url.startsWith('https://evil.example'))).toHaveLength(0);
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('the revocation has its own 5 s timeout → unconfirmed, tokens deleted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = makeHarness({ file: await signedInFile() });
    h.on.revoke = (call) => hang(call);
    const result = h.session.signOut();
    await waitFor(() => h.calls_to(REVOKE_URL).length === 1, 'revocation POST');
    expect(h.calls_to(REVOKE_URL)[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await expect(result).resolves.toEqual({ revocation: 'unconfirmed' });
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it('a revocation_endpoint on another host is never called; tokens are still deleted', async () => {
    const h = makeHarness({ file: await signedInFile() });
    h.discovery['revocation_endpoint'] = 'https://evil.example/revoke';
    const result = await h.session.signOut();
    expect(result.revocation).not.toBe('confirmed');
    expect(h.calls.filter((c) => c.url.startsWith('https://evil.example'))).toHaveLength(0);
    expect(h.store.file?.tokens).toBeUndefined();
  });

  it("with no tokens there is nothing to revoke: 'none', no request", async () => {
    const h = makeHarness({ file: registeredFile() });
    await expect(h.session.signOut()).resolves.toEqual({ revocation: 'none' });
    expect(h.calls_to(REVOKE_URL)).toHaveLength(0);
  });

  it('the next sign-in after a sign-out reuses the kept client id and omits agent_name_hint', async () => {
    const h = makeHarness({ file: await signedInFile() });
    await h.session.signOut();
    const { params } = await startSignIn(h);
    expect(params!.get('client_id')).toBe(ISSUED_CLIENT);
    expect(params!.has('agent_name_hint')).toBe(false);
    expect(params!.get('ext_agent_host_id')).toBe(SEEDED_HOST);
    await h.session.cancelSignIn();
  });

  it('subscribers hear the sign-out', async () => {
    const h = makeHarness({ file: await signedInFile() });
    await waitFor(() => h.session.status() !== 'unknown', 'loaded');
    const heard = vi.fn();
    h.session.subscribe(heard);
    await h.session.signOut();
    expect(heard).toHaveBeenCalled();
  });

  it('forgetRegistration() clears the whole file; the next sign-in is a first sign-in with a NEW host id', async () => {
    const h = makeHarness({ file: registeredFile() });
    await h.session.forgetRegistration();
    expect(h.store.clears).toBeGreaterThanOrEqual(1);
    expect(h.store.file).toBeUndefined();
    expect(h.session.status()).toEqual({ signedIn: false, registered: false });
    const { params } = await startSignIn(h);
    expect(params!.get('client_id')).toBe(DYNAMIC_CLIENT);
    expect(params!.get('agent_name_hint')).toBe('Snug');
    expect(params!.get('ext_agent_host_id')).toMatch(UUID_V4_URN);
    expect(params!.get('ext_agent_host_id')).not.toBe(SEEDED_HOST);
    await h.session.cancelSignIn();
  });
});

// ===================================================================== AC10 — no logging

describe('AC10 — no console.* on the auth path (source lint)', () => {
  const NO_CONSOLE = /\bconsole\s*\./;

  it('the lint can fail (fed a planted line)', () => {
    expect(NO_CONSOLE.test('const t = await read(); console.debug(t);')).toBe(true);
    expect(NO_CONSOLE.test('const consoleLike = 1;')).toBe(false);
  });

  for (const file of ['chatgpt-plan.ts', 'jwks.ts']) {
    it(`src/${file} exists and contains no console.*`, () => {
      const path = join(__dirname, '..', file);
      expect(existsSync(path), `${file} exists`).toBe(true);
      expect(NO_CONSOLE.exec(readFileSync(path, 'utf8'))?.[0]).toBeUndefined();
    });
  }
});
