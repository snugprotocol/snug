// Fake OIDC issuer fixture — a REAL listening HTTP server implementing just enough
// of OpenID Connect for the auth-flow tests: discovery document, JWKS, an authorize
// endpoint that mints codes (recording the PKCE challenge), and a token endpoint that
// verifies the S256 code_verifier and returns a properly RS256-signed ID token.
// openid-client talks to it over the network exactly as it would talk to Google.

import { createSign, generateKeyPairSync, randomUUID, createHash, type KeyObject } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

export interface FakeIdentity {
  sub: string;
  email: string;
  name: string;
}

interface PendingCode {
  codeChallenge: string | undefined;
  redirectUri: string;
  identity: FakeIdentity;
  nonce: string | undefined;
}

export interface FakeOidcIssuer {
  /** Issuer identifier (http://127.0.0.1:<port>) — pass as SNUG_OIDC_ISSUER / config.oidcIssuer. */
  url: string;
  /** Identity the next authorization will assert; mutable between logins. */
  identity: FakeIdentity;
  /**
   * Simulate the user's browser visiting the authorization URL: validates the query,
   * mints a code, and returns the redirect Location (redirect_uri?code&state).
   */
  authorize(authorizationUrl: string): Promise<string>;
  /** Number of token-endpoint exchanges performed (PKCE-verified). */
  tokenExchanges(): number;
  close(): Promise<void>;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export async function startFakeOidcIssuer(identity?: Partial<FakeIdentity>): Promise<FakeOidcIssuer> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const codes = new Map<string, PendingCode>();
  let exchanges = 0;

  const state: { url: string; identity: FakeIdentity } = {
    url: '',
    identity: { sub: 'google-sub-1', email: 'jeetu@example.com', name: 'Jeetu Maker', ...identity },
  };

  const app: FastifyInstance = Fastify({ logger: false });

  // openid-client posts the token request as application/x-www-form-urlencoded.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: state.url,
    authorization_endpoint: `${state.url}/authorize`,
    token_endpoint: `${state.url}/token`,
    jwks_uri: `${state.url}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'email', 'profile'],
  }));

  app.get('/jwks', async () => {
    const jwk = publicKey.export({ format: 'jwk' });
    return { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
  });

  app.get('/authorize', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (q.response_type !== 'code' || q.client_id === undefined || q.redirect_uri === undefined) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const code = randomUUID();
    codes.set(code, {
      codeChallenge: q.code_challenge,
      redirectUri: q.redirect_uri,
      identity: { ...state.identity },
      nonce: q.nonce,
    });
    const location = new URL(q.redirect_uri);
    location.searchParams.set('code', code);
    if (q.state !== undefined) location.searchParams.set('state', q.state);
    return reply.status(302).header('location', location.href).send();
  });

  app.post('/token', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const pending = body.grant_type === 'authorization_code' ? codes.get(body.code ?? '') : undefined;
    if (pending === undefined) {
      return reply.status(400).send({ error: 'invalid_grant' });
    }
    codes.delete(body.code!);
    // PKCE S256 verification — the whole point of the flow.
    const challenge = b64url(createHash('sha256').update(body.code_verifier ?? '').digest());
    if (pending.codeChallenge !== undefined && challenge !== pending.codeChallenge) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    exchanges += 1;
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt(privateKey, kid, {
      iss: state.url,
      aud: body.client_id ?? 'unknown',
      sub: pending.identity.sub,
      email: pending.identity.email,
      name: pending.identity.name,
      iat: now,
      exp: now + 3600,
      ...(pending.nonce !== undefined ? { nonce: pending.nonce } : {}),
    });
    return reply.send({
      access_token: randomUUID(),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
      id_token: idToken,
    });
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('fake issuer failed to bind');
  state.url = `http://127.0.0.1:${address.port}`;

  return {
    get url() {
      return state.url;
    },
    get identity() {
      return state.identity;
    },
    set identity(value: FakeIdentity) {
      state.identity = value;
    },
    async authorize(authorizationUrl: string) {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status !== 302 || location === null) {
        throw new Error(`fake issuer refused the authorization request (${response.status})`);
      }
      return location;
    },
    tokenExchanges() {
      return exchanges;
    },
    async close() {
      await app.close();
    },
  };
}

function signJwt(privateKey: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');
  return `${data}.${signature}`;
}
