// AL-02 AC4: the DI-pure OAuth service (plan D6), ported from an ancestor system with its source
// tests ADAPTED to the Snug seats: async WebCrypto state/PKCE, CredentialStore instead
// of a vault/repo pair, per-flow `flowId` binding instead of the fake session (bug 2),
// userLayer unwrap on start AND callback (bug 1), the RedirectUriProvider/CallbackSink
// transport seam, per-provider consent params from the SPEC, and the frozen-host
// outbound ceiling before every token/refresh/revoke POST (N2b).
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthSpec, Oauth2AuthCodeSpec, Oauth2ClientCredsSpec } from '@snugprotocol/protocol';
import { UserDbCredentialStore, type CredentialStore } from '../credential-store.js';
import {
  InMemoryFlowStateStore,
  OAuthService,
  SecretSpillFlowStateStore,
  SnugAuthError,
  constantTimeEqual,
  generatePkceVerifier,
  pkceChallenge,
  signState,
  verifyState,
  type CallbackDelivery,
  type CallbackSink,
} from '../oauth-service.js';

// ------------------------------------------------------------------- fixtures

const APP = 'app-spotify';

const spec: Oauth2AuthCodeSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Spotify' },
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    refreshUrl: 'https://accounts.spotify.com/api/token',
  },
  scopes: ['user-read-private'],
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.spotify.com'],
};

const ALLOWED = ['accounts.spotify.com', 'api.spotify.com'];

const ccSpec: Oauth2ClientCredsSpec = {
  kind: 'oauth2_client_creds',
  provider: { name: 'B2BProvider' },
  endpoints: { tokenUrl: 'https://b2b.example.com/oauth/token' },
  scopes: ['read:reports'],
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.b2b.example.com'],
};
const CC_ALLOWED = ['b2b.example.com', 'api.b2b.example.com'];

/** In-memory secrets quartet — the same shape UserDb exposes. */
function memoryQuartet(): {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
} {
  const map = new Map<string, string>();
  return {
    getSecret: (key) => map.get(key),
    setSecret: (key, value) => void map.set(key, value),
    deleteSecret: (key) => void map.delete(key),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

/** Response factory per call — a one-shot body must never be shared (lesson 2026-08-04). */
type FetchCall = { url: string; body: URLSearchParams };
function fakeFetch(
  responder: (url: string, body: URLSearchParams) => { status?: number; json?: unknown; text?: string },
): { fetch: (input: string, init?: RequestInit) => Promise<Response>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ url: input, body });
      const reply = responder(input, body);
      if (reply.text !== undefined) {
        return Promise.resolve(new Response(reply.text, { status: reply.status ?? 400 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(reply.json ?? {}), {
          status: reply.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    },
  };
}

const tokenJson = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: 'ACCESS_1',
  refresh_token: 'REFRESH_1',
  expires_in: 3600,
  scope: 'user-read-private',
  token_type: 'Bearer',
  ...overrides,
});

interface Harness {
  service: OAuthService;
  store: CredentialStore;
  calls: FetchCall[];
  redirectUris: string[];
}

function buildService(
  responder?: (url: string, body: URLSearchParams) => { status?: number; json?: unknown; text?: string },
): Harness {
  const store = new UserDbCredentialStore(memoryQuartet());
  const { fetch, calls } = fakeFetch(responder ?? (() => ({ json: tokenJson() })));
  const redirectUris: string[] = [];
  const service = new OAuthService({
    store,
    redirectUriProvider: {
      redirectUri: (appId) => {
        const uri = `http://127.0.0.1:8787/auth/callback/${appId}`;
        redirectUris.push(uri);
        return uri;
      },
    },
    fetch,
  });
  return { service, store, calls, redirectUris };
}

const start = (harness: Harness, forSpec: AuthSpec = spec) =>
  harness.service.generateAuthUrl({
    appId: APP,
    spec: forSpec,
    clientCreds: { client_id: 'CID', client_secret: 'CSECRET' },
  });

// -------------------------------------------------------------- state signing

describe('signState / verifyState (async WebCrypto)', () => {
  const payload = { appId: APP, flowId: 'flow-1', nonce: 'abc', exp: 0 };

  it('round-trips a valid payload', async () => {
    const token = await signState({ ...payload, exp: Date.now() + 60_000 }, 'secret-key');
    const decoded = await verifyState(token, 'secret-key');
    expect(decoded.appId).toBe(APP);
    expect(decoded.flowId).toBe('flow-1');
  });

  it('rejects tampered tokens', async () => {
    const token = await signState({ ...payload, exp: Date.now() + 60_000 }, 'secret-key');
    const tampered = token.slice(0, -1) + (token.slice(-1) === '0' ? '1' : '0');
    await expect(verifyState(tampered, 'secret-key')).rejects.toThrow(SnugAuthError);
  });

  it('a state forged under ANY other key fails verification (finding 11)', async () => {
    const forged = await signState({ ...payload, exp: Date.now() + 60_000 }, 'attacker-key');
    await expect(verifyState(forged, 'secret-key')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('rejects expired tokens with the typed code', async () => {
    const token = await signState({ ...payload, exp: Date.now() - 1 }, 'secret-key');
    await expect(verifyState(token, 'secret-key')).rejects.toMatchObject({ code: 'state_expired' });
  });

  it('constant-time compare is preserved across the rewrite (dedicated test)', () => {
    expect(constantTimeEqual('abcd', 'abcd')).toBe(true);
    expect(constantTimeEqual('abcd', 'abce')).toBe(false);
    expect(constantTimeEqual('abcd', 'abc')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('PKCE (S256 default)', () => {
  it('matches the RFC 7636 appendix B vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates verifiers in the RFC 7636 43–128 char range', () => {
    const verifier = generatePkceVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generatePkceVerifier()).not.toBe(verifier);
  });
});

// ------------------------------------------------------------ generateAuthUrl

describe('generateAuthUrl', () => {
  it('mints state + flowId, persists creds via the store, builds the authorize URL with PKCE', async () => {
    const harness = buildService();
    const result = await start(harness);
    const url = new URL(result.authorizeUrl);
    expect(url.origin + url.pathname).toBe(spec.endpoints.authorizeUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('CID');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('user-read-private');
    expect(result.flowId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await harness.store.getCredential(APP, 'client_id')).toBe('CID');
    expect((await harness.store.getConnectionState(APP))?.status).toBe('pending');
  });

  it('consent params come from the SPEC, never hardcoded: no access_type/prompt unless authorizeParams says so', async () => {
    const harness = buildService();
    const plain = new URL((await start(harness)).authorizeUrl);
    expect(plain.searchParams.get('access_type')).toBeNull();
    expect(plain.searchParams.get('prompt')).toBeNull();

    const google = { ...spec, authorizeParams: { access_type: 'offline', prompt: 'consent' } };
    const withParams = new URL((await start(harness, google)).authorizeUrl);
    expect(withParams.searchParams.get('access_type')).toBe('offline');
    expect(withParams.searchParams.get('prompt')).toBe('consent');
  });

  it('omits PKCE when spec.pkce === false', async () => {
    const harness = buildService();
    const result = await start(harness, { ...spec, pkce: false });
    expect(new URL(result.authorizeUrl).searchParams.get('code_challenge')).toBeNull();
  });

  it('two concurrent flows mint distinct flowIds and states', async () => {
    const harness = buildService();
    const a = await start(harness);
    const b = await start(harness);
    expect(a.flowId).not.toBe(b.flowId);
    expect(a.state).not.toBe(b.state);
  });

  it('unwraps the userLayer of a two-layer spec (bug 1 start side)', async () => {
    const harness = buildService();
    const twoLayer: AuthSpec = {
      kind: 'bearer_token',
      provider: { name: 'Wrapper' },
      fields: [{ key: 'token', label: 'T', type: 'secret' }],
      declaredApiHosts: ['api.wrapper.example'],
      userLayer: spec,
    };
    const result = await start(harness, twoLayer);
    expect(new URL(result.authorizeUrl).origin + new URL(result.authorizeUrl).pathname).toBe(
      spec.endpoints.authorizeUrl,
    );
  });

  it('rejects a spec with no auth-code layer at all', async () => {
    const harness = buildService();
    const staticSpec: AuthSpec = {
      kind: 'api_key',
      provider: { name: 'X' },
      fields: [{ key: 'api_key', label: 'K', type: 'secret' }],
      declaredApiHosts: ['api.x.example'],
    };
    await expect(start(harness, staticSpec)).rejects.toMatchObject({ code: 'unsupported_kind' });
  });
});

// -------------------------------------------------------------- handleCallback

describe('handleCallback (flow binding — bug 2 reshaped)', () => {
  it('exchanges the code, persists tokens + connection state through the store', async () => {
    const harness = buildService();
    const started = await start(harness);
    const result = await harness.service.handleCallback({
      appId: APP,
      spec,
      allowedHosts: ALLOWED,
      code: 'AUTH_CODE',
      state: started.state,
      expectedFlowId: started.flowId,
    });
    expect(result.appId).toBe(APP);
    expect(result.flowId).toBe(started.flowId);
    expect(await harness.store.getCredential(APP, 'access_token')).toBe('ACCESS_1');
    expect(await harness.store.getCredential(APP, 'refresh_token')).toBe('REFRESH_1');
    const connection = await harness.store.getConnectionState(APP);
    expect(connection?.status).toBe('connected');
    expect(connection?.scopesGranted).toEqual(['user-read-private']);
    // PKCE bound start↔exchange:
    expect(harness.calls[0]!.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(harness.calls[0]!.body.get('grant_type')).toBe('authorization_code');
  });

  it('bug-2: flow A\'s callback cannot complete against flow B\'s expectation (two concurrent flows)', async () => {
    const harness = buildService();
    const flowA = await start(harness);
    const flowB = await start(harness);
    await expect(
      harness.service.handleCallback({
        appId: APP,
        spec,
        allowedHosts: ALLOWED,
        code: 'C',
        state: flowA.state, // provider redirect for A…
        expectedFlowId: flowB.flowId, // …delivered to a caller holding B
      }),
    ).rejects.toMatchObject({ code: 'flow_mismatch' });
    expect(harness.calls).toHaveLength(0); // no token exchange happened

    // Flow B still completes against its own state.
    const done = await harness.service.handleCallback({
      appId: APP,
      spec,
      allowedHosts: ALLOWED,
      code: 'C',
      state: flowB.state,
      expectedFlowId: flowB.flowId,
    });
    expect(done.flowId).toBe(flowB.flowId);
  });

  it('state is single-use: a replayed callback fails with state_replay', async () => {
    const harness = buildService();
    const started = await start(harness);
    const input = {
      appId: APP,
      spec,
      allowedHosts: ALLOWED,
      code: 'C',
      state: started.state,
      expectedFlowId: started.flowId,
    };
    await harness.service.handleCallback(input);
    await expect(harness.service.handleCallback(input)).rejects.toMatchObject({ code: 'state_replay' });
  });

  it('bug-1: a TWO-LAYER spec completes start→callback through the userLayer', async () => {
    const harness = buildService();
    const twoLayer: AuthSpec = {
      kind: 'oauth2_client_creds',
      provider: { name: 'Wrapper' },
      endpoints: { tokenUrl: 'https://org.example/token' },
      clientCreds: [
        { key: 'client_id', label: 'ID', type: 'text' },
        { key: 'client_secret', label: 'S', type: 'secret' },
      ],
      declaredApiHosts: ['api.wrapper.example'],
      userLayer: spec,
    };
    const started = await start(harness, twoLayer);
    const result = await harness.service.handleCallback({
      appId: APP,
      spec: twoLayer,
      allowedHosts: [...ALLOWED, 'org.example', 'api.wrapper.example'],
      code: 'C',
      state: started.state,
      expectedFlowId: started.flowId,
    });
    expect(result.appId).toBe(APP);
    // The exchange went to the USER layer's token endpoint, not the org layer's.
    expect(harness.calls[0]!.url).toBe(spec.endpoints.tokenUrl);
  });

  it('redirect_uri is IDENTICAL in the authorize URL and the token exchange (RedirectUriProvider seam)', async () => {
    const harness = buildService();
    const started = await start(harness);
    const authorizeRedirect = new URL(started.authorizeUrl).searchParams.get('redirect_uri');
    await harness.service.handleCallback({
      appId: APP,
      spec,
      allowedHosts: ALLOWED,
      code: 'C',
      state: started.state,
      expectedFlowId: started.flowId,
    });
    expect(authorizeRedirect).toBe(`http://127.0.0.1:8787/auth/callback/${APP}`);
    expect(harness.calls[0]!.body.get('redirect_uri')).toBe(authorizeRedirect);
  });

  it('the CallbackSink seam delivers code+state back into handleCallback (test-fake transport)', async () => {
    const harness = buildService();
    const delivered: CallbackDelivery[] = [];
    const sink: CallbackSink = { deliver: (delivery) => void delivered.push(delivery) };

    const started = await start(harness);
    // Simulate the provider redirect landing wherever AL-04 hosts the callback route:
    await sink.deliver({ appId: APP, flowId: started.flowId, code: 'C', state: started.state });

    const [delivery] = delivered;
    const result = await harness.service.handleCallback({
      appId: delivery!.appId,
      spec,
      allowedHosts: ALLOWED,
      code: delivery!.code,
      state: delivery!.state,
      // AL-04 constraint: expectedFlowId comes from the CALLER'S held copy (the start
      // result), never parsed out of the delivered callback payload.
      expectedFlowId: started.flowId,
    });
    expect(result.flowId).toBe(started.flowId);
  });

  it('marks the connection errored when the token exchange fails', async () => {
    const harness = buildService(() => ({ status: 401, text: 'bad client_secret' }));
    const started = await start(harness);
    await expect(
      harness.service.handleCallback({
        appId: APP,
        spec,
        allowedHosts: ALLOWED,
        code: 'C',
        state: started.state,
        expectedFlowId: started.flowId,
      }),
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
    expect((await harness.store.getConnectionState(APP))?.status).toBe('error');
  });

  it('refuses a token exchange whose endpoint host is outside the frozen ceiling (N2b)', async () => {
    const harness = buildService();
    const started = await start(harness);
    await expect(
      harness.service.handleCallback({
        appId: APP,
        spec,
        allowedHosts: ['somewhere-else.example'],
        code: 'C',
        state: started.state,
        expectedFlowId: started.flowId,
      }),
    ).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(harness.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------- tokens and refresh

async function connect(harness: Harness): Promise<void> {
  const started = await start(harness);
  await harness.service.handleCallback({
    appId: APP,
    spec,
    allowedHosts: ALLOWED,
    code: 'C',
    state: started.state,
    expectedFlowId: started.flowId,
  });
}

describe('getAccessToken / refresh (per-use store reads — finding 10)', () => {
  it('returns the stored token when fresh — read from the store PER USE, never a cache', async () => {
    const harness = buildService();
    await connect(harness);
    expect(await harness.service.getAccessToken({ appId: APP, spec, allowedHosts: ALLOWED })).toBe('ACCESS_1');
    // Mutate the store directly: the next call must see the NEW value (no retained copy).
    await harness.store.setCredential(APP, 'access_token', 'ROTATED_ELSEWHERE');
    expect(await harness.service.getAccessToken({ appId: APP, spec, allowedHosts: ALLOWED })).toBe(
      'ROTATED_ELSEWHERE',
    );
  });

  it('refreshes near expiry with 60s skew and persists the rotated tokens', async () => {
    const harness = buildService((url, body) =>
      body.get('grant_type') === 'refresh_token'
        ? { json: tokenJson({ access_token: 'ACCESS_2', refresh_token: 'REFRESH_2' }) }
        : { json: tokenJson() },
    );
    await connect(harness);
    await harness.store.setConnectionState(APP, {
      status: 'connected',
      obtainedAt: Date.now() - 3590_000, // 10s of life left — inside the skew window
      expiresIn: 3600,
    });
    expect(await harness.service.getAccessToken({ appId: APP, spec, allowedHosts: ALLOWED })).toBe('ACCESS_2');
    expect(await harness.store.getCredential(APP, 'refresh_token')).toBe('REFRESH_2');
  });

  it('rotation tolerance: keeps the previous refresh token when the provider does not issue a new one', async () => {
    const harness = buildService((url, body) =>
      body.get('grant_type') === 'refresh_token'
        ? { json: { access_token: 'ACCESS_2', expires_in: 3600 } }
        : { json: tokenJson() },
    );
    await connect(harness);
    await harness.service.refresh({ appId: APP, spec, allowedHosts: ALLOWED });
    expect(await harness.store.getCredential(APP, 'refresh_token')).toBe('REFRESH_1');
  });

  it('refresh POSTs to refreshUrl ?? tokenUrl and REFUSES a refresh host outside the ceiling (N2b)', async () => {
    const harness = buildService();
    await connect(harness);
    const escaped: Oauth2AuthCodeSpec = {
      ...spec,
      endpoints: { ...spec.endpoints, refreshUrl: 'https://exfil.example.com/refresh' },
    };
    const before = harness.calls.length;
    await expect(
      harness.service.refresh({ appId: APP, spec: escaped, allowedHosts: ALLOWED }),
    ).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(harness.calls.length).toBe(before); // the POST never left
  });

  it('marks the connection expired and throws typed errors on refresh failure / missing refresh token', async () => {
    const harness = buildService((url, body) =>
      body.get('grant_type') === 'refresh_token' ? { status: 400, text: 'invalid_grant' } : { json: tokenJson() },
    );
    await connect(harness);
    await expect(harness.service.refresh({ appId: APP, spec, allowedHosts: ALLOWED })).rejects.toMatchObject({
      code: 'refresh_failed',
    });
    expect((await harness.store.getConnectionState(APP))?.status).toBe('expired');

    await harness.store.deleteCredential(APP, 'refresh_token');
    await expect(harness.service.refresh({ appId: APP, spec, allowedHosts: ALLOWED })).rejects.toMatchObject({
      code: 'no_refresh_token',
    });
  });

  it('throws no_connection when nothing is connected', async () => {
    const harness = buildService();
    await expect(
      harness.service.getAccessToken({ appId: APP, spec, allowedHosts: ALLOWED }),
    ).rejects.toMatchObject({ code: 'no_connection' });
  });
});

// ---------------------------------------------------------------- disconnect

describe('disconnect (lifecycle — D4/finding 10)', () => {
  it('connect→use→disconnect: revoke is best-effort, the store slice is wiped, and NO retained copy serves a post-disconnect call', async () => {
    const revoked: string[] = [];
    const harness = buildService((url, body) => {
      if (url.includes('revoke')) {
        revoked.push(body.get('token') ?? '');
        return { status: 200, json: {} };
      }
      return { json: tokenJson() };
    });
    const withRevoke: Oauth2AuthCodeSpec = {
      ...spec,
      endpoints: { ...spec.endpoints, revokeUrl: 'https://accounts.spotify.com/revoke' },
    };
    await connect(harness);
    expect(await harness.service.getAccessToken({ appId: APP, spec, allowedHosts: ALLOWED })).toBe('ACCESS_1');

    await harness.service.disconnect({ appId: APP, spec: withRevoke, allowedHosts: ALLOWED });
    expect(revoked).toEqual(['ACCESS_1']);
    expect(await harness.store.getCredential(APP, 'access_token')).toBeUndefined();
    expect(await harness.store.getConnectionState(APP)).toBeUndefined();
    await expect(
      harness.service.getAccessToken({ appId: APP, spec, allowedHosts: ALLOWED }),
    ).rejects.toMatchObject({ code: 'no_connection' });
  });

  it('still wipes local state when the revoke endpoint errors, and skips revoke outside the ceiling', async () => {
    const harness = buildService((url) =>
      url.includes('revoke') ? { status: 500, text: 'down' } : { json: tokenJson() },
    );
    await connect(harness);
    await harness.service.disconnect({
      appId: APP,
      spec: { ...spec, endpoints: { ...spec.endpoints, revokeUrl: 'https://accounts.spotify.com/revoke' } },
      allowedHosts: ALLOWED,
    });
    expect(await harness.store.getCredential(APP, 'access_token')).toBeUndefined();

    // Outside-ceiling revoke URL: no POST is attempted, the wipe still happens.
    const harness2 = buildService();
    await connect(harness2);
    const before = harness2.calls.length;
    await harness2.service.disconnect({
      appId: APP,
      spec: { ...spec, endpoints: { ...spec.endpoints, revokeUrl: 'https://exfil.example.com/revoke' } },
      allowedHosts: ALLOWED,
    });
    expect(harness2.calls.length).toBe(before);
    expect(await harness2.store.getCredential(APP, 'access_token')).toBeUndefined();
  });
});

// --------------------------------------------------------- client credentials

describe('client-credentials grant', () => {
  it('saveClientCreds mints immediately so bad creds surface at save time', async () => {
    const harness = buildService(() => ({ json: { access_token: 'CC_ACCESS', expires_in: 3600, scope: 'read:reports' } }));
    await harness.service.saveClientCreds({
      appId: 'app-cc',
      spec: ccSpec,
      allowedHosts: CC_ALLOWED,
      clientCreds: { client_id: 'CID', client_secret: 'SECRET' },
    });
    expect(harness.calls[0]!.body.get('grant_type')).toBe('client_credentials');
    expect(harness.calls[0]!.body.get('scope')).toBe('read:reports');
    expect(await harness.store.getCredential('app-cc', 'access_token')).toBe('CC_ACCESS');
    expect((await harness.store.getConnectionState('app-cc'))?.status).toBe('connected');
  });

  it('rejects and marks expired when the provider refuses the creds', async () => {
    const harness = buildService(() => ({ status: 401, text: 'invalid_client' }));
    await expect(
      harness.service.saveClientCreds({
        appId: 'app-cc',
        spec: ccSpec,
        allowedHosts: CC_ALLOWED,
        clientCreds: { client_id: 'BAD', client_secret: 'WRONG' },
      }),
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
    expect((await harness.store.getConnectionState('app-cc'))?.status).toBe('expired');
  });

  it('getClientCredsAccessToken serves the stored token while fresh (no fetch) and re-mints on expiry', async () => {
    let minted = 0;
    const harness = buildService(() => ({ json: { access_token: `CC_${++minted}`, expires_in: 3600 } }));
    await harness.service.saveClientCreds({
      appId: 'app-cc',
      spec: ccSpec,
      allowedHosts: CC_ALLOWED,
      clientCreds: { client_id: 'CID', client_secret: 'SECRET' },
    });
    expect(await harness.service.getClientCredsAccessToken({ appId: 'app-cc', spec: ccSpec, allowedHosts: CC_ALLOWED })).toBe('CC_1');
    expect(minted).toBe(1); // no re-mint while fresh
    await harness.store.setConnectionState('app-cc', { status: 'connected', obtainedAt: 0, expiresIn: 60 });
    expect(await harness.service.getClientCredsAccessToken({ appId: 'app-cc', spec: ccSpec, allowedHosts: CC_ALLOWED })).toBe('CC_2');
  });

  it('the mint refuses a token endpoint outside the frozen ceiling (N2b)', async () => {
    const harness = buildService();
    await expect(
      harness.service.saveClientCreds({
        appId: 'app-cc',
        spec: ccSpec,
        allowedHosts: ['api.b2b.example.com'], // token host b2b.example.com NOT included
        clientCreds: { client_id: 'CID', client_secret: 'SECRET' },
      }),
    ).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(harness.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------- flow stores

describe('flow state stores (plan N3)', () => {
  it('InMemoryFlowStateStore: single-use consume with TTL', async () => {
    const flows = new InMemoryFlowStateStore();
    await flows.put('f1', { flowId: 'f1', appId: APP, nonce: 'n', pkceVerifier: 'v', expiresAt: Date.now() + 1000 });
    expect((await flows.consume('f1'))?.pkceVerifier).toBe('v');
    expect(await flows.consume('f1')).toBeUndefined(); // consumed
    await flows.put('f2', { flowId: 'f2', appId: APP, nonce: 'n', pkceVerifier: null, expiresAt: Date.now() - 1 });
    expect(await flows.consume('f2')).toBeUndefined(); // expired
  });

  it('SecretSpillFlowStateStore: spills to auth:_flow:<flowId>, consume deletes, expired rows are swept', async () => {
    const quartet = memoryQuartet();
    const flows = new SecretSpillFlowStateStore(quartet);
    await flows.put('f1', { flowId: 'f1', appId: APP, nonce: 'n', pkceVerifier: 'v', expiresAt: Date.now() + 60_000 });
    expect(quartet.getSecret('auth:_flow:f1')).toBeDefined();
    await flows.put('dead', { flowId: 'dead', appId: APP, nonce: 'n', pkceVerifier: null, expiresAt: Date.now() - 1 });
    expect((await flows.consume('f1'))?.appId).toBe(APP);
    expect(quartet.getSecret('auth:_flow:f1')).toBeUndefined(); // deleted on consume
    expect(quartet.getSecret('auth:_flow:dead')).toBeUndefined(); // TTL sweep ran
  });
});
