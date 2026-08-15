// TASK-20260812-desktop-auth-awareness P3-executor (ADR-0022 §3/§4) — RED-FIRST at
// Gate 3 against an executor that neither renders queryTemplate nor carries the
// auth-shaped-failure observer seat yet.
//
// TWO SURFACES UNDER TEST, both C1-adjacent:
//
// 1. QUERY-PARAM CREDENTIAL PLACEMENT (AC6). `request.queryTemplate` renders into the
//    OUTBOUND URL only, AFTER the ceiling/host gates — the confirm store keeps
//    capturing the PRE-injection URL (pinned below), the app-visible result never
//    echoes the credentialed URL, and rendered query VALUES join the scrub candidate
//    set at every site that scrubs injected header values TODAY plus the
//    NET_FETCH_FAILED message that shipped unscrubbed (P0 security amendment 14 — a
//    fetch error routinely embeds the full URL, query string included).
//
// 2. THE onAuthShapedFailure OBSERVER (AC5, amendment 8). Host-only, (slot, status) at
//    this seam — the playground layer adds appId (pin adaptation journaled in the task
//    file). Fires ONLY on the FINAL delivered result of execute() when credentials were
//    injected AND the status is 401/403; a 401 cured by the OAuth refresh retry fires
//    NOTHING; executeConnectionTestRequest SUPPRESSES it; the app-visible result is
//    byte-identical either way (the app contract is unbroken — ok:true, status as-is).
//
// POSTURE: executor altitude, fake fetch, REAL credential-shaped values (a theft test
// probing for 'x' proves nothing), assertions on the OUTBOUND bytes.
import {
  CONNECTION_STATUS,
  NET_ERROR_CODES,
  type ConnectionRequirement,
} from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authConnectionCredentialSecretKey, authConnectionStateSecretKey } from '@snugprotocol/db';
import {
  createConnectedFetch,
  executeConnectionTestRequest,
  type ConnectedFetch,
  type ConnectedFetchDeps,
  type NetConnectionRow,
} from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

// ---------------------------------------------------------------------- fixtures

const APP = 'app-query-observer';

/** OpenWeather-shaped: query-ONLY credential placement — no headerTemplate at all. */
const querySpec: ConnectionRequirement = {
  slot: 'openweather',
  kind: 'api_key',
  provider: { name: 'OpenWeather' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  request: { queryTemplate: { appid: '{{api_key}}' } },
  declaredApiHosts: ['api.openweathermap.org'],
};

/** Header-template sibling (the shipped shape) for the widened-scrub negatives. */
const headerSpec: ConnectionRequirement = {
  slot: 'example',
  kind: 'api_key',
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
};

/** Keyless kind — the observer's "no credentials were injected" negative. */
const noneSpec: ConnectionRequirement = {
  slot: 'public',
  kind: 'none',
  provider: { name: 'Public API' },
  declaredApiHosts: ['api.public.example'],
};

// DELIBERATELY ENCODE-FORCING (P6 whole-surface finding F1). This fixture was
// `ow-live-7f3a21b4…` — pure hex and dashes, so `URLSearchParams.set` encoded NOTHING
// and the four C1 scrub assertions below passed against a mechanism that did not hold:
// the scrub candidates carried the RAW rendered value while the outbound URL carried the
// PERCENT-ENCODED one, so any credential containing `+`, `/`, `=` or a space leaked
// verbatim into the app-visible NET_FETCH_FAILED message and into echoed bodies.
// Real API keys are routinely base64. The value below contains one of each encode-forcing
// character, so these tests now EXERCISE the scrub instead of restating it (the P5
// journal's own rule: a fence that restates the data cannot test the data).
const QUERY_KEY_VALUE = 'ow+live/7f3a21b4=05d68a1 f2c3b4d5e6f70899aabbcc';
const HEADER_KEY_VALUE = 'ex-live-4417ZmNoPqRsTuVwXyZ01234567aBcDeF98';

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

function row(requirement: ConnectionRequirement, allowedHosts?: string[]): NetConnectionRow {
  return {
    appId: APP,
    slot: requirement.slot,
    requirement,
    status: CONNECTION_STATUS.approved,
    // `?? []` since ADR-0023 made `declaredApiHosts` required-XOR-`lanHost`. Every
    // requirement in this suite declares hosts, so the fallback never fires here.
    allowedHosts: allowedHosts ?? [...(requirement.declaredApiHosts ?? [])],
  };
}

type FetchCall = { url: string; init: RequestInit };

interface Harness {
  executor: ConnectedFetch;
  deps: ConnectedFetchDeps;
  calls: FetchCall[];
  quartet: ReturnType<typeof memoryQuartet>;
  confirm: ReturnType<typeof vi.fn>;
  observer: ReturnType<typeof vi.fn>;
}

function harness(
  opts: {
    rows?: NetConnectionRow[];
    respond?: (url: string, init: RequestInit) => Response;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    confirmResult?: boolean;
  } = {},
): Harness {
  const quartet = memoryQuartet();
  quartet.setSecret(authConnectionCredentialSecretKey(APP, 'openweather', 'api_key'), QUERY_KEY_VALUE);
  quartet.setSecret(authConnectionCredentialSecretKey(APP, 'example', 'api_key'), HEADER_KEY_VALUE);
  const rows = opts.rows ?? [row(querySpec), row(headerSpec), row(noneSpec)];
  const calls: FetchCall[] = [];
  const respond =
    opts.respond ??
    (() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const confirm = vi.fn(async () => opts.confirmResult ?? true);
  const observer = vi.fn();
  const deps: ConnectedFetchDeps = {
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: (appId) => (appId === APP ? rows : []) },
    fetchImpl:
      opts.fetchImpl ??
      (async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return respond(url, init ?? {});
      }),
    confirmGate: { confirm },
    onAuthShapedFailure: observer,
  };
  return { executor: createConnectedFetch(deps), deps, calls, quartet, confirm, observer };
}

const WEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather?q=london';

const headerOf = (call: FetchCall, name: string): string | undefined => {
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC6 — queryTemplate renders into the OUTBOUND URL, after the gates
// ---------------------------------------------------------------------------

describe('AC6 — query-param credential placement', () => {
  it('renders the credential into the outbound query — NOT as X-Api-Key, app params preserved', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    const outbound = new URL(calls[0]!.url);
    expect(outbound.searchParams.get('appid'), 'credential arrives in the query').toBe(QUERY_KEY_VALUE);
    expect(outbound.searchParams.get('q'), 'the app’s own params survive injection').toBe('london');
    expect(headerOf(calls[0]!, 'x-api-key'), 'the api_key kind default must NOT also fire').toBeUndefined();
  });

  it('the confirm gate captures the PRE-injection URL (mutating method)', async () => {
    const { executor, calls, confirm } = harness();
    const postUrl = 'https://api.openweathermap.org/data/2.5/alerts?q=london';
    const result = await executor.execute(APP, { url: postUrl, method: 'POST', body: '{}' });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(confirm).toHaveBeenCalledTimes(1);
    const confirmed = confirm.mock.calls[0]![0] as { url: string };
    expect(confirmed.url, 'the user confirms the URL the APP asked for').toBe(postUrl);
    expect(confirmed.url).not.toContain(QUERY_KEY_VALUE);
    expect(new URL(calls[0]!.url).searchParams.get('appid'), 'the wire still carries the credential').toBe(
      QUERY_KEY_VALUE,
    );
  });

  it('an off-ceiling host refuses BEFORE injection — no fetch, no credential motion', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, { url: 'https://evil.example/steal?q=1', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(calls).toHaveLength(0);
  });

  it('header and query templates render in ONE pass — a timestamp in both agrees byte-for-byte', async () => {
    const spec: ConnectionRequirement = {
      ...querySpec,
      request: {
        headerTemplate: { 'X-Ts': '{{timestamp()}}' },
        queryTemplate: { appid: '{{api_key}}', ts: '{{request.timestamp}}' },
      },
    };
    const { executor, calls } = harness({ rows: [row(spec)] });
    expect((await executor.execute(APP, { url: WEATHER_URL, method: 'GET' })).ok).toBe(true);
    const sentHeader = headerOf(calls[0]!, 'x-ts');
    const sentQuery = new URL(calls[0]!.url).searchParams.get('ts');
    expect(sentHeader).toMatch(/^\d{10}$/);
    expect(sentQuery, 'two render states would straddle second boundaries intermittently').toBe(sentHeader);
  });

  it('a queryTemplate naming an UNDECLARED field is NET_AUTH_FAILED with no fetch (one lint resolution)', async () => {
    const spec: ConnectionRequirement = {
      ...querySpec,
      request: { queryTemplate: { appid: '{{api_kye}}' } },
    };
    const { executor, calls } = harness({ rows: [row(spec)] });
    const result = await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(calls).toHaveLength(0);
  });

  it('the app-visible result never echoes the credential or the credentialed URL', async () => {
    const { executor } = harness();
    const result = await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(QUERY_KEY_VALUE);
    expect(serialized).not.toContain('appid=');
  });
});

// ---------------------------------------------------------------------------
// Amendment 14 (C1) — the scrub candidate set widens to rendered query values,
// and NET_FETCH_FAILED is scrubbed with the FULL candidate set
// ---------------------------------------------------------------------------

describe('amendment 14 — enumerated scrub sites cover query credentials', () => {
  it('C1 NEGATIVE: a fetch error embedding the credentialed URL returns a REDACTED message', async () => {
    const { executor } = harness({
      fetchImpl: async (url) => {
        throw new Error(`connect ETIMEDOUT for ${url}`);
      },
    });
    const result = await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_FETCH_FAILED });
    const message = (result as { message: string }).message;
    expect(message, 'the thrown URL carries the rendered query credential').not.toContain(QUERY_KEY_VALUE);
    expect(message).toContain('***');
  });

  it('a fetch error embedding an injected HEADER value is redacted too (full candidate set)', async () => {
    const { executor } = harness({
      fetchImpl: async () => {
        throw new Error(`proxy rejected header X-Api-Key: ${HEADER_KEY_VALUE}`);
      },
    });
    const result = await executor.execute(APP, { url: 'https://api.example.com/v1/data', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_FETCH_FAILED });
    expect((result as { message: string }).message).not.toContain(HEADER_KEY_VALUE);
  });

  it('a response BODY echoing the query credential is scrubbed', async () => {
    const { executor } = harness({
      respond: (url) => new Response(`debug echo: ${url}`, { status: 200 }),
    });
    const result = await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(result.ok).toBe(true);
    const body = (result as { body: string }).body;
    expect(body).not.toContain(QUERY_KEY_VALUE);
    expect(body).toContain('***');
  });

  it('a whitelisted response HEADER echoing the query credential is scrubbed', async () => {
    const { executor } = harness({
      respond: () => new Response('{}', { status: 200, headers: { etag: `"${QUERY_KEY_VALUE}"` } }),
    });
    const result = await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(result.ok).toBe(true);
    const headers = (result as { headers: Record<string, string> }).headers;
    expect(headers['etag']).not.toContain(QUERY_KEY_VALUE);
    expect(headers['etag']).toContain('***');
  });
});

// ---------------------------------------------------------------------------
// AC5 / amendment 8 — the onAuthShapedFailure observer seat
// ---------------------------------------------------------------------------

describe('AC5 — onAuthShapedFailure fires only on the FINAL credentialed 401/403', () => {
  it('fires (slot, 401) once on a credentialed 401 — the app result is UNCHANGED (ok:true, status as-is)', async () => {
    const { executor, observer } = harness({ respond: () => new Response('unauthorized', { status: 401 }) });
    const result = await executor.execute(APP, { url: 'https://api.example.com/v1/data', method: 'GET' });
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(observer).toHaveBeenCalledTimes(1);
    // MIGRATED 2026-08-15 (TASK-20260815 AC4): a text body becomes the detail arg.
    expect(observer).toHaveBeenCalledWith('example', 401, 'unauthorized');
  });

  it('fires on 403 too', async () => {
    const { executor, observer } = harness({ respond: () => new Response('forbidden', { status: 403 }) });
    expect((await executor.execute(APP, { url: WEATHER_URL, method: 'GET' })).ok).toBe(true);
    expect(observer).toHaveBeenCalledWith('openweather', 403, 'forbidden');
  });

  it('a QUERY-injected credential counts as injected — the observer fires for the query slot', async () => {
    const { executor, observer } = harness({ respond: () => new Response('unauthorized', { status: 401 }) });
    await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(observer).toHaveBeenCalledWith('openweather', 401, 'unauthorized');
  });

  it('NEGATIVE: does not fire on a 200', async () => {
    const { executor, observer } = harness();
    await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(observer).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a 401 with NO injected credentials (kind none) fires NOTHING', async () => {
    const { executor, observer } = harness({ respond: () => new Response('unauthorized', { status: 401 }) });
    const result = await executor.execute(APP, { url: 'https://api.public.example/v1/things', method: 'GET' });
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(observer).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a 401 CURED by the OAuth refresh retry fires NOTHING (final result rule)', async () => {
    const oauthSpec: ConnectionRequirement = {
      slot: 'spotify',
      kind: 'oauth2_auth_code',
      provider: { name: 'Spotify' },
      endpoints: {
        authorizeUrl: 'https://accounts.example.com/authorize',
        tokenUrl: 'https://accounts.example.com/token',
        refreshUrl: 'https://accounts.example.com/token',
      },
      fields: [{ key: 'client_id', label: 'Client ID', type: 'text' }],
      declaredApiHosts: ['api.spotify.example'],
    };
    let apiCalls = 0;
    const { executor, observer, quartet } = harness({
      rows: [row(oauthSpec, ['api.spotify.example', 'accounts.example.com'])],
      respond: (url) => {
        if (url.startsWith('https://accounts.example.com/token')) {
          return new Response(JSON.stringify({ access_token: 'refreshed-token-2', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        apiCalls += 1;
        return apiCalls === 1
          ? new Response('unauthorized', { status: 401 })
          : new Response('{"fine":true}', { status: 200 });
      },
    });
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'spotify', 'access_token'), 'stale-token-1');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'spotify', 'refresh_token'), 'refresh-token-1');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'spotify', 'client_id'), 'client-1');
    quartet.setSecret(
      authConnectionStateSecretKey(APP, 'spotify'),
      JSON.stringify({ status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 }),
    );
    const result = await executor.execute(APP, { url: 'https://api.spotify.example/v1/me', method: 'GET' });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(observer, 'the retry CURED the 401 — the delivered result is a 200').not.toHaveBeenCalled();
  });

  it('an UNCURED OAuth 401 (retry also 401) fires exactly ONCE with the final status', async () => {
    const oauthSpec: ConnectionRequirement = {
      slot: 'spotify',
      kind: 'oauth2_auth_code',
      provider: { name: 'Spotify' },
      endpoints: {
        authorizeUrl: 'https://accounts.example.com/authorize',
        tokenUrl: 'https://accounts.example.com/token',
        refreshUrl: 'https://accounts.example.com/token',
      },
      fields: [{ key: 'client_id', label: 'Client ID', type: 'text' }],
      declaredApiHosts: ['api.spotify.example'],
    };
    const { executor, observer, quartet } = harness({
      rows: [row(oauthSpec, ['api.spotify.example', 'accounts.example.com'])],
      respond: (url) =>
        url.startsWith('https://accounts.example.com/token')
          ? new Response(JSON.stringify({ access_token: 'refreshed-token-2', expires_in: 3600 }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('unauthorized', { status: 401 }),
    });
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'spotify', 'access_token'), 'stale-token-1');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'spotify', 'refresh_token'), 'refresh-token-1');
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'spotify', 'client_id'), 'client-1');
    quartet.setSecret(
      authConnectionStateSecretKey(APP, 'spotify'),
      JSON.stringify({ status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 }),
    );
    const result = await executor.execute(APP, { url: 'https://api.spotify.example/v1/me', method: 'GET' });
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith('spotify', 401, 'unauthorized');
  });

  it('NEGATIVE: executeConnectionTestRequest SUPPRESSES the observer (probe outcomes render in the wizard)', async () => {
    const probeSpec: ConnectionRequirement = {
      ...headerSpec,
      testRequest: { method: 'GET', pathAndQuery: '/v3/probe' },
    };
    const { deps, observer } = harness({
      rows: [row(probeSpec)],
      respond: () => new Response('unauthorized', { status: 401 }),
    });
    const result = await executeConnectionTestRequest(deps, APP, 'example');
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(observer, 'the wizard translates probe failures itself — no banner').not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TASK-20260815 AC4 — the observer carries the provider's own reason (scrubbed, bounded)
// ---------------------------------------------------------------------------
//
// RED-FIRST at Gate 3 against the 2-arg observer. The detail is extracted from
// `result.body` — the ALREADY-SCRUBBED, 1 MiB-capped delivered body — never from the
// raw Response (`scrubCandidates` is function-local to performFetch and deliberately
// out of scope at the delivery seat). Recognized JSON shapes first (Spotify's
// {"error":{"message"}}, RFC 6749 error_description, bare message/error strings), text
// head as fallback; HTML and unrecognized JSON yield NO detail (a markup blob in a
// banner is noise, not diagnosis); hard cap 160 chars. When there is no detail the
// observer fires with TWO args, so empty-body behavior is byte-identical to before.

describe('AC4 — auth-failure detail extraction', () => {
  const fire = async (body: string, headers?: Record<string, string>) => {
    const { executor, observer } = harness({
      respond: () => new Response(body, { status: 403, headers: headers ?? {} }),
    });
    await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    return observer;
  };

  it("extracts Spotify's error.message shape", async () => {
    const observer = await fire('{"error":{"status":403,"message":"Insufficient client scope"}}');
    expect(observer).toHaveBeenCalledWith('openweather', 403, 'Insufficient client scope');
  });

  it('extracts RFC 6749 error_description', async () => {
    const observer = await fire('{"error":"invalid_scope","error_description":"The token lacks playlist access"}');
    expect(observer).toHaveBeenCalledWith('openweather', 403, 'The token lacks playlist access');
  });

  it('extracts a bare message field, then a bare string error field', async () => {
    expect(await fire('{"message":"User not registered in the Developer Dashboard"}')).toHaveBeenCalledWith(
      'openweather',
      403,
      'User not registered in the Developer Dashboard',
    );
    expect(await fire('{"error":"forbidden_by_policy"}')).toHaveBeenCalledWith(
      'openweather',
      403,
      'forbidden_by_policy',
    );
  });

  it('falls back to the text head for a plain-text body', async () => {
    const observer = await fire('quota exceeded for this key');
    expect(observer).toHaveBeenCalledWith('openweather', 403, 'quota exceeded for this key');
  });

  it('yields NO detail for an HTML error page (2-arg call, exact arity)', async () => {
    const observer = await fire('<!DOCTYPE html><html><body>403 Forbidden</body></html>');
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith('openweather', 403);
  });

  it('yields NO detail for an empty body or unrecognized JSON (2-arg call)', async () => {
    expect(await fire('')).toHaveBeenCalledWith('openweather', 403);
    expect(await fire('{"code":40301,"retriable":false}')).toHaveBeenCalledWith('openweather', 403);
  });

  it('caps the detail at 160 chars', async () => {
    const long = 'x'.repeat(400);
    const observer = await fire(`{"error":{"message":"${long}"}}`);
    const detail = observer.mock.calls[0]![2] as string;
    expect(detail.length).toBe(160);
  });

  it('C1 NEGATIVE: a body echoing the credentialed URL never leaks the credential into the detail', async () => {
    // The query credential is injected into the outbound URL; a provider error that
    // echoes the request URL therefore embeds the credential. The delivered body is
    // scrubbed at gate 10, and the detail must inherit that scrub — both the raw and
    // the percent-encoded form (the P6 lesson: the two forms must not drift).
    const { executor, observer, calls } = harness({
      respond: () => {
        const echoed = calls[0]?.url ?? '';
        return new Response(JSON.stringify({ error: { message: `denied for ${echoed}` } }), { status: 403 });
      },
    });
    await executor.execute(APP, { url: WEATHER_URL, method: 'GET' });
    expect(observer).toHaveBeenCalledTimes(1);
    const detail = (observer.mock.calls[0]![2] as string | undefined) ?? '';
    expect(detail).not.toContain(QUERY_KEY_VALUE);
    expect(detail).not.toContain(encodeURIComponent(QUERY_KEY_VALUE));
  });
});
