// routes/auth.ts — Google OIDC login (Authorization Code + PKCE), session lifecycle.
// Login state (state + PKCE verifier + redirect URI) rides in a one-shot HMAC-signed
// httpOnly cookie scoped to /auth — the server stores nothing between redirect and
// callback. The callback upserts the user row ONLY (never a userdbs row: /userdb is
// 404 until the client's first PUT, ADR-0009). Logout is CSRF-protected: a cookie-
// authed mutating route, same double-submit rule as PUT /userdb.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { OidcClient } from '../auth/oidc.js';
import {
  checkCsrf,
  clearSessionCookies,
  isSecureRequest,
  LOGIN_TTL_MS,
  OIDC_COOKIE,
  readSession,
  setSessionCookies,
  signPayload,
  verifyPayload,
} from '../auth/session.js';
import type { UserStore } from '../stores/users.js';

export interface AuthRouteDeps {
  oidc: OidcClient;
  users: UserStore;
  sessionSecret: string;
}

const loginStatePayload = z.looseObject({
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  redirectUri: z.string().min(1),
});

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { oidc, users, sessionSecret } = deps;

  app.get('/auth/login', async (request, reply) => {
    const redirectUri = `${requestOrigin(request)}/auth/callback`;
    let start;
    try {
      start = await oidc.startLogin(redirectUri);
    } catch (err) {
      request.log.error({ err }, 'oidc discovery/authorization failed');
      return reply
        .status(502)
        .send({ code: 'OIDC_UNAVAILABLE', message: 'could not reach the identity provider', retryable: true });
    }
    const value = signPayload(
      { state: start.state, codeVerifier: start.codeVerifier, redirectUri, exp: Date.now() + LOGIN_TTL_MS },
      sessionSecret,
    );
    reply.setCookie(OIDC_COOKIE, value, {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(request),
      maxAge: Math.floor(LOGIN_TTL_MS / 1000),
    });
    return reply.redirect(start.url, 302);
  });

  app.get('/auth/callback', async (request, reply) => {
    const clearLoginCookie = (): void => {
      void reply.clearCookie(OIDC_COOKIE, {
        path: '/auth',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecureRequest(request),
      });
    };

    const verified = verifyPayload(request.cookies[OIDC_COOKIE], sessionSecret);
    const login = verified === undefined ? undefined : loginStatePayload.safeParse(verified);
    if (login === undefined || !login.success) {
      clearLoginCookie();
      return reply.status(400).send({
        code: 'LOGIN_STATE_MISSING',
        message: 'login state cookie missing or expired — start again at /auth/login',
        retryable: true,
      });
    }

    const currentUrl = new URL(request.url, requestOrigin(request));
    let identity;
    try {
      identity = await oidc.completeLogin(currentUrl, {
        state: login.data.state,
        codeVerifier: login.data.codeVerifier,
      });
    } catch (err) {
      request.log.warn({ err }, 'oidc code exchange failed');
      clearLoginCookie();
      return reply.status(400).send({
        code: 'OIDC_EXCHANGE_FAILED',
        message: 'the authorization response did not verify — start again at /auth/login',
        retryable: true,
      });
    }

    const user = users.upsertByGoogleSub({ googleSub: identity.sub, email: identity.email, name: identity.name });
    clearLoginCookie();
    setSessionCookies(reply, request, user.id, sessionSecret);
    return reply.redirect('/', 302);
  });

  app.post('/auth/logout', async (request, reply) => {
    if (!checkCsrf(request)) {
      return reply
        .status(403)
        .send({ code: 'CSRF_REJECTED', message: `logout requires the CSRF header`, retryable: false });
    }
    clearSessionCookies(reply, request);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const session = readSession(request, sessionSecret);
    const user = session === undefined ? undefined : users.get(session.userId);
    if (user === undefined) {
      return reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'no valid session', retryable: false });
    }
    return { userId: user.id, email: user.email, name: user.name };
  });
}
