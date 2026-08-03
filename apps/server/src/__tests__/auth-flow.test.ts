// AC1 (hub-sso): full OIDC Authorization Code + PKCE flow against a real fake issuer —
// login redirect → issuer authorize → callback code exchange (network, PKCE-verified)
// → session + CSRF cookies with correct flags → /auth/me → logout. Plus the server
// half of AC2: first login provisions the USER row only — /userdb stays 404 until the
// client's first PUT (an empty provisioned DB must never clobber local state, ADR-0009).

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CSRF_COOKIE, CSRF_HEADER, OIDC_COOKIE, SESSION_COOKIE } from '../auth/session.js';
import { authTestConfig, buildTestApp } from './helpers.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from './fake-oidc-issuer.js';

let issuer: FakeOidcIssuer;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  issuer = await startFakeOidcIssuer();
});
afterAll(async () => {
  await issuer.close();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface InjectedCookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  expires?: Date;
}

function cookieOf(response: { cookies: unknown }, name: string): InjectedCookie | undefined {
  return (response.cookies as InjectedCookie[]).find((c) => c.name === name);
}

const REMOTE_HOST = 'hub.example.com';

/** Drive the whole browser dance via inject + real fetches to the fake issuer. */
async function login(appInstance: FastifyInstance, host: string = REMOTE_HOST) {
  const loginResponse = await appInstance.inject({ method: 'GET', url: '/auth/login', headers: { host } });
  expect(loginResponse.statusCode).toBe(302);
  const authorizationUrl = loginResponse.headers.location as string;
  expect(authorizationUrl.startsWith(`${issuer.url}/authorize`)).toBe(true);
  const oidcCookie = cookieOf(loginResponse, OIDC_COOKIE);
  expect(oidcCookie).toBeDefined();
  expect(oidcCookie!.httpOnly).toBe(true);

  const redirect = await issuer.authorize(authorizationUrl);
  const redirectUrl = new URL(redirect);
  expect(redirectUrl.pathname).toBe('/auth/callback');

  const callbackResponse = await appInstance.inject({
    method: 'GET',
    url: `/auth/callback${redirectUrl.search}`,
    headers: { host, cookie: `${OIDC_COOKIE}=${oidcCookie!.value}` },
  });
  return { loginResponse, oidcCookie: oidcCookie!, callbackResponse };
}

describe('OIDC login flow (fake issuer)', () => {
  it('completes login: PKCE-verified exchange, session + CSRF cookies with correct flags, redirect to /', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    const before = issuer.tokenExchanges();
    const { callbackResponse } = await login(app);

    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers.location).toBe('/');
    expect(issuer.tokenExchanges()).toBe(before + 1); // fake issuer 400s on a bad code_verifier

    const session = cookieOf(callbackResponse, SESSION_COOKIE);
    expect(session).toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.secure).toBe(true); // non-localhost host → Secure
    expect(session!.sameSite?.toLowerCase()).toBe('lax');
    expect(session!.path).toBe('/');

    const csrf = cookieOf(callbackResponse, CSRF_COOKIE);
    expect(csrf).toBeDefined();
    expect(csrf!.httpOnly).not.toBe(true); // double-submit token must be JS-readable
    expect(csrf!.secure).toBe(true);
    expect(csrf!.sameSite?.toLowerCase()).toBe('lax');

    // The one-shot login state cookie is cleared by the callback.
    const clearedOidc = cookieOf(callbackResponse, OIDC_COOKIE);
    expect(clearedOidc).toBeDefined();
    expect(clearedOidc!.value).toBe('');
  });

  it('omits the Secure flag only for plain-http localhost dev', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    const { callbackResponse } = await login(app, '127.0.0.1:8787');
    const session = cookieOf(callbackResponse, SESSION_COOKIE);
    expect(session).toBeDefined();
    expect(session!.secure).not.toBe(true);
    expect(session!.httpOnly).toBe(true); // never relaxed, even in dev
  });

  it('GET /auth/me returns the logged-in identity; 401 without a session', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    issuer.identity = { sub: 'google-sub-me', email: 'me@example.com', name: 'Me Test' };
    const { callbackResponse } = await login(app);
    const session = cookieOf(callbackResponse, SESSION_COOKIE)!;

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { userId: string; email: string; name: string };
    expect(body.email).toBe('me@example.com');
    expect(body.name).toBe('Me Test');
    expect(typeof body.userId).toBe('string');
    expect(body.userId).not.toBe('google-sub-me'); // internal id, not the raw Google sub

    const anonymous = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('logging in twice with the same Google sub upserts one user (same userId)', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    issuer.identity = { sub: 'google-sub-stable', email: 'first@example.com', name: 'First' };
    const first = await login(app);
    issuer.identity = { sub: 'google-sub-stable', email: 'renamed@example.com', name: 'Renamed' };
    const second = await login(app);

    const meFor = async (sessionValue: string) => {
      const response = await app!.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: `${SESSION_COOKIE}=${sessionValue}` },
      });
      return response.json() as { userId: string; email: string };
    };
    const a = await meFor(cookieOf(first.callbackResponse, SESSION_COOKIE)!.value);
    const b = await meFor(cookieOf(second.callbackResponse, SESSION_COOKIE)!.value);
    expect(a.userId).toBe(b.userId);
    expect(b.email).toBe('renamed@example.com'); // profile fields refreshed on upsert
  });

  it('first login provisions the user row only — /userdb is 404 until the first PUT', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    const { callbackResponse } = await login(app);
    const session = cookieOf(callbackResponse, SESSION_COOKIE)!;
    const response = await app.inject({
      method: 'GET',
      url: '/userdb',
      headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a callback with a tampered state (400)', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    const loginResponse = await app.inject({ method: 'GET', url: '/auth/login', headers: { host: REMOTE_HOST } });
    const oidcCookie = cookieOf(loginResponse, OIDC_COOKIE)!;
    const redirect = await issuer.authorize(loginResponse.headers.location as string);
    const redirectUrl = new URL(redirect);
    redirectUrl.searchParams.set('state', 'tampered-state');
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/auth/callback${redirectUrl.search}`,
      headers: { host: REMOTE_HOST, cookie: `${OIDC_COOKIE}=${oidcCookie.value}` },
    });
    expect(callbackResponse.statusCode).toBe(400);
    expect(cookieOf(callbackResponse, SESSION_COOKIE)).toBeUndefined();
  });

  it('rejects a callback without the login state cookie (400)', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    const loginResponse = await app.inject({ method: 'GET', url: '/auth/login', headers: { host: REMOTE_HOST } });
    const redirect = await issuer.authorize(loginResponse.headers.location as string);
    const callbackResponse = await app.inject({
      method: 'GET',
      url: `/auth/callback${new URL(redirect).search}`,
      headers: { host: REMOTE_HOST },
    });
    expect(callbackResponse.statusCode).toBe(400);
  });
});

describe('POST /auth/logout', () => {
  it('clears the session and CSRF cookies (CSRF-protected)', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    const { callbackResponse } = await login(app);
    const session = cookieOf(callbackResponse, SESSION_COOKIE)!;
    const csrf = cookieOf(callbackResponse, CSRF_COOKIE)!;

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        host: REMOTE_HOST,
        cookie: `${SESSION_COOKIE}=${session.value}; ${CSRF_COOKIE}=${csrf.value}`,
        [CSRF_HEADER]: csrf.value,
      },
    });
    expect(logout.statusCode).toBe(204);
    const clearedSession = cookieOf(logout, SESSION_COOKIE);
    expect(clearedSession).toBeDefined();
    expect(clearedSession!.value).toBe('');
    const clearedCsrf = cookieOf(logout, CSRF_COOKIE);
    expect(clearedCsrf).toBeDefined();
    expect(clearedCsrf!.value).toBe('');
  });

  it('refuses logout without the CSRF header (403)', async () => {
    app = await buildTestApp({ config: authTestConfig({ oidcIssuer: issuer.url }) });
    const { callbackResponse } = await login(app);
    const session = cookieOf(callbackResponse, SESSION_COOKIE)!;
    const csrf = cookieOf(callbackResponse, CSRF_COOKIE)!;
    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `${SESSION_COOKIE}=${session.value}; ${CSRF_COOKIE}=${csrf.value}` },
    });
    expect(logout.statusCode).toBe(403);
  });
});
