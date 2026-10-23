// TASK-20261023-siwc-chatgpt-plan D2 / L1 — `postForm`'s redirect guard + echo scrub become a
// free function, `extractOauthErrorFromPost(response, submitted)`, that ALSO returns the parsed
// OAuth `error` code (the ChatGPT-plan keeper needs `invalid_grant` / `refresh_token_reused` /
// `refresh_not_ready` by name). That is a refactor of a reviewed security seat, so per TDD rule
// 6 this file pins TODAY's observable `postForm` behaviour first (part 1 — green before and
// after the refactor; `oauth-error-echo.test.ts` and `postform-redirect.test.ts` already pin the
// scrub variants and the redirect posture, so part 1 adds what they leave loose: the exact
// message formats, the stored `lastError`, the 160-char cap applied AFTER the scrub, the host
// ceiling, the request shape), then the new function's return shape (part 2 — red until L1).
import type { Oauth2AuthCodeSpec, Oauth2ClientCredsSpec } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { UserDbCredentialStore } from '../credential-store.js';
import * as indexExports from '../index.js';
import { OAuthService, extractOauthErrorFromPost } from '../oauth-service.js';
import { MAX_AUTH_FAILURE_DETAIL_CHARS } from '../provider-error-detail.js';

const APP = 'app-char';
const REFRESH_TOKEN = 'rt-CHARACTERIZE-refresh-secret';
const CLIENT_SECRET = 'cs-CHARACTERIZE-client-secret';

const spec: Oauth2AuthCodeSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'CharProvider' },
  endpoints: {
    authorizeUrl: 'https://auth.char.example/authorize',
    tokenUrl: 'https://auth.char.example/token',
    refreshUrl: 'https://auth.char.example/token',
  },
  scopes: ['read'],
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.char.example'],
};
const ALLOWED = ['auth.char.example', 'api.char.example'];

const ccSpec: Oauth2ClientCredsSpec = {
  kind: 'oauth2_client_creds',
  provider: { name: 'CharB2B' },
  endpoints: { tokenUrl: 'https://b2b.char.example/oauth/token' },
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.b2b.char.example'],
};
const CC_ALLOWED = ['b2b.char.example', 'api.b2b.char.example'];

function memoryQuartet() {
  const map = new Map<string, string>();
  return {
    getSecret: (key: string) => map.get(key),
    setSecret: (key: string, value: string) => void map.set(key, value),
    deleteSecret: (key: string) => void map.delete(key),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

async function connected(respond: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const store = new UserDbCredentialStore(memoryQuartet());
  const service = new OAuthService({
    store,
    redirectUriProvider: { redirectUri: () => 'http://127.0.0.1:41420/callback' },
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond();
    },
  });
  await store.setCredential(APP, 'client_id', 'client-char');
  await store.setCredential(APP, 'client_secret', CLIENT_SECRET);
  await store.setCredential(APP, 'refresh_token', REFRESH_TOKEN);
  await store.setCredential(APP, 'access_token', 'stale');
  await store.setConnectionState(APP, { status: 'connected', obtainedAt: 0, expiresIn: 1 });
  return { service, store, calls };
}

async function refreshError(respond: () => Response | Promise<Response>) {
  const h = await connected(respond);
  let caught: unknown;
  try {
    await h.service.refresh({ appId: APP, spec, allowedHosts: ALLOWED });
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof Error)) throw new Error('expected the refresh to throw');
  return { err: caught as Error & { code?: string }, ...h };
}

// =========================================================== part 1 — characterization

describe('characterization — postForm as it is today (green before AND after the extraction)', () => {
  it('an RFC 6749 error body becomes "Refresh failed: HTTP <status>: <error_description>", code refresh_failed', async () => {
    const { err, store } = await refreshError(() =>
      Response.json({ error: 'invalid_grant', error_description: 'The refresh token is expired.' }, { status: 400 }),
    );
    expect(err.message).toBe('Refresh failed: HTTP 400: The refresh token is expired.');
    expect(err.code).toBe('refresh_failed');
    // The same scrubbed string is what the connection row stores.
    expect((await store.getConnectionState(APP))?.lastError).toBe('Refresh failed: HTTP 400: The refresh token is expired.');
    expect((await store.getConnectionState(APP))?.status).toBe('expired');
  });

  it('a bare {"error": code} body forwards the code as the reason', async () => {
    const { err } = await refreshError(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    expect(err.message).toBe('Refresh failed: HTTP 400: invalid_grant');
  });

  it('an empty body is just the status', async () => {
    const { err } = await refreshError(() => new Response('', { status: 503 }));
    expect(err.message).toBe('Refresh failed: HTTP 503');
  });

  it('an HTML body is just the status', async () => {
    const { err } = await refreshError(() => new Response(`<html>${REFRESH_TOKEN}</html>`, { status: 502 }));
    expect(err.message).toBe('Refresh failed: HTTP 502');
  });

  it('the detail is capped at 160 chars', async () => {
    const { err } = await refreshError(() => Response.json({ error_description: 'a'.repeat(400) }, { status: 400 }));
    expect(MAX_AUTH_FAILURE_DETAIL_CHARS).toBe(160);
    expect(err.message).toBe(`Refresh failed: HTTP 400: ${'a'.repeat(160)}`);
  });

  it('the cap runs AFTER the scrub: a secret straddling the cut is redacted whole, never half-forwarded', async () => {
    const { err } = await refreshError(() =>
      Response.json({ error_description: `${'x'.repeat(150)}${REFRESH_TOKEN}` }, { status: 400 }),
    );
    expect(err.message).toBe(`Refresh failed: HTTP 400: ${'x'.repeat(150)}***`);
    expect(err.message).not.toContain(REFRESH_TOKEN.slice(0, 8));
  });

  it('an OpenAI-API-shaped {"error":{"message"}} echo is scrubbed', async () => {
    const { err } = await refreshError(() =>
      Response.json({ error: { message: `Incorrect token provided: ${REFRESH_TOKEN}.`, code: 'invalid_api_key' } }, { status: 401 }),
    );
    expect(err.message).toBe('Refresh failed: HTTP 401: Incorrect token provided: ***.');
  });

  it('a 302 is redirect_blocked with its message, untranslated, and nothing is followed', async () => {
    const { err, calls } = await refreshError(
      () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/x' } }),
    );
    expect(err.message).toBe('endpoint answered with a redirect (302) — credential POSTs are never redirected');
    expect(err.code).toBe('redirect_blocked');
    expect(calls).toHaveLength(1);
  });

  it('a token endpoint outside the host ceiling is host_not_allowed and no request is made', async () => {
    const h = await connected(() => Response.json({}));
    await expect(
      h.service.refresh({ appId: APP, spec, allowedHosts: ['api.char.example'] }),
    ).rejects.toMatchObject({ code: 'host_not_allowed', message: 'endpoint host of auth.char.example is outside the approved host set' });
    expect(h.calls).toHaveLength(0);
  });

  it('the credential POST shape: POST, form + JSON accept headers, redirect manual, a timeout signal, the form body', async () => {
    const { calls } = await refreshError(() => new Response('', { status: 500 }));
    const init = calls[0]!.init!;
    expect(calls[0]!.url).toBe('https://auth.char.example/token');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(headers.get('accept')).toBe('application/json');
    expect(init.body).toBeInstanceOf(URLSearchParams);
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('the client-credentials path formats and scrubs the same way', async () => {
    const calls: Recorded[] = [];
    const store = new UserDbCredentialStore(memoryQuartet());
    const service = new OAuthService({
      store,
      redirectUriProvider: { redirectUri: () => 'http://127.0.0.1:41420/callback' },
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ error: 'invalid_client', error_description: `client ${CLIENT_SECRET} rejected` }, { status: 401 });
      },
    });
    let message = '';
    try {
      await service.saveClientCreds({
        appId: APP,
        spec: ccSpec,
        allowedHosts: CC_ALLOWED,
        clientCreds: { client_id: 'cc-id', client_secret: CLIENT_SECRET },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('Client credentials grant failed: HTTP 401: client *** rejected');
  });
});

// =========================================================== part 2 — the extracted function

/** The body a credential POST submitted — the scrub's exact candidate set. */
function submitted(extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id: 'oaiapp_issued_1',
    resource: 'https://api.openai.com/v1',
    ...extra,
  });
}

describe('extractOauthErrorFromPost — the free function (L1)', () => {
  it('is exported from oauth-service and from the package index', () => {
    expect(typeof extractOauthErrorFromPost).toBe('function');
    expect(typeof (indexExports as Record<string, unknown>)['extractOauthErrorFromPost']).toBe('function');
  });

  it('returns the status, the parsed OAuth error code and the bounded detail', async () => {
    const res = Response.json({ error: 'invalid_grant', error_description: 'The refresh token is expired.' }, { status: 400 });
    await expect(extractOauthErrorFromPost(res, submitted())).resolves.toEqual({
      status: 400,
      code: 'invalid_grant',
      detail: 'The refresh token is expired.',
    });
  });

  for (const code of ['refresh_token_reused', 'refresh_not_ready', 'invalid_client']) {
    it(`parses a bare {"error":"${code}"} as code ${code}`, async () => {
      const res = Response.json({ error: code }, { status: 400 });
      await expect(extractOauthErrorFromPost(res, submitted())).resolves.toMatchObject({ status: 400, code });
    });
  }

  it('an empty body yields only the status', async () => {
    const out = await extractOauthErrorFromPost(new Response('', { status: 503 }), submitted());
    expect(out.status).toBe(503);
    expect(out.code).toBeUndefined();
    expect(out.detail).toBeUndefined();
  });

  it('an HTML body yields only the status — markup is never a code or a detail', async () => {
    const out = await extractOauthErrorFromPost(new Response(`<html>${REFRESH_TOKEN}</html>`, { status: 502 }), submitted());
    expect(out).toMatchObject({ status: 502 });
    expect(out.code).toBeUndefined();
    expect(out.detail).toBeUndefined();
  });

  it('an echo inside error_description is scrubbed out of the detail; the reason survives', async () => {
    const res = Response.json({ error: 'invalid_grant', error_description: `bad token ${REFRESH_TOKEN}` }, { status: 400 });
    const out = await extractOauthErrorFromPost(res, submitted());
    expect(out.code).toBe('invalid_grant');
    expect(out.detail).toBe('bad token ***');
  });

  it('a secret planted IN the error code itself never comes back as the code', async () => {
    const res = Response.json({ error: `invalid_grant ${REFRESH_TOKEN}` }, { status: 400 });
    const out = await extractOauthErrorFromPost(res, submitted());
    expect(out.code ?? '').not.toContain(REFRESH_TOKEN);
    expect(out.detail ?? '').not.toContain(REFRESH_TOKEN);
  });

  it('a \\u-escaped echo (decoded by JSON.parse, after the raw-text scrub) is scrubbed from detail and code', async () => {
    const escaped = [...REFRESH_TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const res = new Response(`{"error":"invalid_grant","error_description":"bad token ${escaped}"}`, { status: 400 });
    const out = await extractOauthErrorFromPost(res, submitted());
    expect(out.detail).toBe('bad token ***');
    expect(out.code).toBe('invalid_grant');
  });

  it('the URL-encoded spelling of a base64-shaped secret is scrubbed too', async () => {
    const b64 = 'AQD+xk9/vZ8ePlusSlashEquals==';
    const wire = new URLSearchParams({ v: b64 }).toString().slice(2);
    expect(wire).not.toBe(b64);
    const res = Response.json({ error: 'invalid_grant', error_description: `got ${wire} and ${b64}` }, { status: 400 });
    const out = await extractOauthErrorFromPost(res, submitted({ refresh_token: b64 }));
    expect(out.detail).not.toContain(wire);
    expect(out.detail).not.toContain(b64);
  });

  it('the authorization code and the PKCE verifier are scrubbed (an exchange is a credential POST too)', async () => {
    const res = Response.json({ error: 'invalid_grant', error_description: 'code auth-code-123 verifier vfr-abcdef0123456789' }, { status: 400 });
    const out = await extractOauthErrorFromPost(
      res,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'auth-code-123',
        code_verifier: 'vfr-abcdef0123456789',
        client_id: 'oaiapp_issued_1',
      }),
    );
    expect(out.detail).toBe('code *** verifier ***');
  });

  it('a plain-text or form-encoded echo is scrubbed', async () => {
    const plain = await extractOauthErrorFromPost(new Response(`invalid_grant for ${REFRESH_TOKEN}`, { status: 400 }), submitted());
    expect(plain.detail).toBe('invalid_grant for ***');
    const form = await extractOauthErrorFromPost(
      new Response(`error=invalid_grant&refresh_token=${REFRESH_TOKEN}`, { status: 400 }),
      submitted(),
    );
    expect(form.detail ?? '').not.toContain(REFRESH_TOKEN);
  });

  it('the detail is capped at 160 chars AFTER the scrub (a straddling secret is redacted whole)', async () => {
    const long = await extractOauthErrorFromPost(Response.json({ error_description: 'a'.repeat(400) }, { status: 400 }), submitted());
    expect(long.detail).toBe('a'.repeat(160));
    const straddle = await extractOauthErrorFromPost(
      Response.json({ error_description: `${'x'.repeat(150)}${REFRESH_TOKEN}` }, { status: 400 }),
      submitted(),
    );
    expect(straddle.detail).toBe(`${'x'.repeat(150)}***`);
  });

  it('non-secret submitted values (grant_type, client_id) stay readable', async () => {
    const res = Response.json({ error: 'unauthorized_client', error_description: 'client oaiapp_issued_1 may not use grant_type refresh_token' }, { status: 400 });
    const out = await extractOauthErrorFromPost(res, submitted());
    expect(out.detail).toBe('client oaiapp_issued_1 may not use grant_type refresh_token');
  });
});
