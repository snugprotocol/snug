// auth/oidc.ts — Google OIDC via openid-client v6 (Authorization Code + PKCE).
// The issuer is injectable (SNUG_OIDC_ISSUER) so tests run the FULL flow against a
// local fake issuer over http; http issuers get openid-client's allowInsecureRequests
// (dev/test only — the default issuer is Google over https). Discovery is lazy and
// cached: boot never depends on issuer reachability, and a failed discovery retries
// on the next login instead of poisoning the cache.

import * as oidc from 'openid-client';

export interface OidcLoginStart {
  /** Authorization URL to redirect the browser to. */
  url: string;
  state: string;
  codeVerifier: string;
}

export interface OidcIdentity {
  sub: string;
  email: string;
  name: string;
  /**
   * Google's avatar URL, from the `picture` claim of the `profile` scope (already
   * requested). Optional rather than '' because "no avatar" must stay distinguishable
   * from "empty avatar" all the way out to /auth/me, which omits the field entirely.
   */
  picture?: string;
}

export interface OidcClient {
  startLogin(redirectUri: string): Promise<OidcLoginStart>;
  /** Exchanges the callback's code (PKCE + state checked); throws on any validation failure. */
  completeLogin(currentUrl: URL, checks: { state: string; codeVerifier: string }): Promise<OidcIdentity>;
}

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export function createOidcClient(options: OidcClientOptions): OidcClient {
  let cached: Promise<oidc.Configuration> | undefined;

  const configuration = (): Promise<oidc.Configuration> => {
    cached ??= discover().catch((err: unknown) => {
      cached = undefined; // do not cache a failed discovery
      throw err;
    });
    return cached;
  };

  const discover = (): Promise<oidc.Configuration> => {
    const server = new URL(options.issuer);
    const insecure = server.protocol === 'http:';
    return oidc.discovery(
      server,
      options.clientId,
      options.clientSecret,
      undefined,
      insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
  };

  return {
    async startLogin(redirectUri) {
      const config = await configuration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      });
      return { url: url.href, state, codeVerifier };
    },

    async completeLogin(currentUrl, checks) {
      const config = await configuration();
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
      });
      const claims = tokens.claims();
      if (claims === undefined || typeof claims.sub !== 'string' || claims.sub === '') {
        throw new Error('OIDC token response carried no usable ID token subject');
      }
      return {
        sub: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : '',
        name: typeof claims.name === 'string' ? claims.name : '',
        // Key omitted (not '') when the claim is missing or empty, so downstream can
        // tell "no avatar" from "avatar at an empty URL".
        ...(typeof claims.picture === 'string' && claims.picture !== ''
          ? { picture: claims.picture }
          : {}),
      };
    },
  };
}
