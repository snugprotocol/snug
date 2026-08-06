// AL-02 AC1/D2: the deterministic params→spec transformer, REWRITTEN (not lifted):
// OProject's five-kind shapes + userLayer synthesis, IProject's fail-closed posture —
// declaredApiHosts REQUIRED non-empty for the four static/CC kinds; for
// oauth2_auth_code it may be omitted ONLY when the well-known registry supplies
// apiHosts (the branch points at data that exists). Never calls an LLM.
import { describe, expect, it } from 'vitest';
import { authSpecSchema } from '@snugprotocol/protocol';
import { paramsToAuthSpec } from '../params-to-auth-spec.js';

describe('static kinds', () => {
  it('builds bearer_token with default fields and requires declaredApiHosts', () => {
    const ok = paramsToAuthSpec({
      kindHint: 'bearer_token',
      providerName: 'GitHub',
      declaredApiHosts: ['api.github.com'],
    });
    expect(ok.spec).not.toBeNull();
    expect(ok.spec!.kind).toBe('bearer_token');
    if (ok.spec!.kind === 'bearer_token') {
      expect(ok.spec!.fields[0]!.key).toBe('token');
      expect(ok.spec!.declaredApiHosts).toEqual(['api.github.com']);
    }

    const missing = paramsToAuthSpec({ kindHint: 'bearer_token', providerName: 'GitHub' });
    expect(missing.spec).toBeNull();
    expect(missing.reason).toMatch(/declaredApiHosts/);
    const empty = paramsToAuthSpec({ kindHint: 'bearer_token', providerName: 'GitHub', declaredApiHosts: [] });
    expect(empty.spec).toBeNull();
  });

  it('builds api_key with a headerTemplate request block', () => {
    const result = paramsToAuthSpec({
      kindHint: 'api_key',
      providerName: 'Coinbase',
      declaredApiHosts: ['api.coinbase.com'],
      headerTemplate: { 'CB-ACCESS-KEY': '{{api_key}}' },
    });
    expect(result.spec).not.toBeNull();
    if (result.spec!.kind === 'api_key') {
      expect(result.spec!.request?.headerTemplate).toEqual({ 'CB-ACCESS-KEY': '{{api_key}}' });
    }
  });

  it('builds basic_auth with default username/password fields', () => {
    const result = paramsToAuthSpec({
      kindHint: 'basic_auth',
      providerName: 'Legacy',
      declaredApiHosts: ['legacy.example.com'],
    });
    expect(result.spec).not.toBeNull();
    if (result.spec!.kind === 'basic_auth') {
      expect(result.spec!.fields.map((f) => f.key)).toEqual(['username', 'password']);
    }
  });

  it('oauth2_client_creds requires endpoints.tokenUrl AND declaredApiHosts', () => {
    const noEndpoint = paramsToAuthSpec({
      kindHint: 'oauth2_client_creds',
      providerName: 'B2B',
      declaredApiHosts: ['api.b2b.example.com'],
    });
    expect(noEndpoint.spec).toBeNull();
    const ok = paramsToAuthSpec({
      kindHint: 'oauth2_client_creds',
      providerName: 'B2B',
      declaredApiHosts: ['api.b2b.example.com'],
      endpoints: { tokenUrl: 'https://b2b.example.com/oauth/token' },
    });
    expect(ok.spec?.kind).toBe('oauth2_client_creds');
  });
});

describe('oauth2_auth_code and the registry (plan D2)', () => {
  it('a well-known provider supplies endpoints, apiHosts, and pkce', () => {
    const result = paramsToAuthSpec({ kindHint: 'oauth2_auth_code', providerName: 'Spotify' });
    expect(result.spec).not.toBeNull();
    if (result.spec!.kind === 'oauth2_auth_code') {
      expect(result.spec!.endpoints.authorizeUrl).toBe('https://accounts.spotify.com/authorize');
      expect(result.spec!.declaredApiHosts).toEqual(['api.spotify.com']);
      expect(result.spec!.pkce).toBe(true);
      expect(result.spec!.authorizeParams).toBeUndefined();
    }
  });

  it('Google entries carry their per-provider consent params into the spec (never hardcoded downstream)', () => {
    const result = paramsToAuthSpec({ kindHint: 'oauth2_auth_code', providerName: 'Google' });
    if (result.spec!.kind === 'oauth2_auth_code') {
      expect(result.spec!.authorizeParams).toEqual({ access_type: 'offline', prompt: 'consent' });
    }
  });

  it('an unknown provider fails without explicit endpoints, and still fails without declaredApiHosts', () => {
    const noEndpoints = paramsToAuthSpec({ kindHint: 'oauth2_auth_code', providerName: 'Obscure SaaS' });
    expect(noEndpoints.spec).toBeNull();

    const endpointsOnly = paramsToAuthSpec({
      kindHint: 'oauth2_auth_code',
      providerName: 'Obscure SaaS',
      endpoints: { authorizeUrl: 'https://o.example/auth', tokenUrl: 'https://o.example/token' },
    });
    expect(endpointsOnly.spec).toBeNull();
    expect(endpointsOnly.reason).toMatch(/declaredApiHosts/);

    const complete = paramsToAuthSpec({
      kindHint: 'oauth2_auth_code',
      providerName: 'Obscure SaaS',
      endpoints: { authorizeUrl: 'https://o.example/auth', tokenUrl: 'https://o.example/token' },
      declaredApiHosts: ['api.o.example'],
    });
    expect(complete.spec?.kind).toBe('oauth2_auth_code');
  });

  it('explicit inputs override registry defaults', () => {
    const result = paramsToAuthSpec({
      kindHint: 'oauth2_auth_code',
      providerName: 'Spotify',
      declaredApiHosts: ['api.spotify.com', 'cdn.spotify.example'],
      scopes: ['user-read-private'],
      pkce: false,
    });
    if (result.spec!.kind === 'oauth2_auth_code') {
      expect(result.spec!.declaredApiHosts).toEqual(['api.spotify.com', 'cdn.spotify.example']);
      expect(result.spec!.scopes).toEqual(['user-read-private']);
      expect(result.spec!.pkce).toBe(false);
    }
  });
});

describe('two_layer synthesis (@draft — runtime deferred)', () => {
  it('embeds a registry-derived userLayer (endpoints + apiHosts) inside an org-eligible kind', () => {
    const result = paramsToAuthSpec({
      kindHint: 'oauth2_client_creds',
      providerName: 'Spotify',
      declaredApiHosts: ['api.spotify.com'],
      endpoints: { tokenUrl: 'https://accounts.spotify.com/api/token' },
      authMode: 'two_layer',
    });
    expect(result.spec).not.toBeNull();
    if (result.spec!.kind === 'oauth2_client_creds') {
      const layer = result.spec!.userLayer!;
      expect(layer.kind).toBe('oauth2_auth_code');
      expect(layer.endpoints.authorizeUrl).toBe('https://accounts.spotify.com/authorize');
      expect(layer.declaredApiHosts).toEqual(['api.spotify.com']);
      expect(layer.clientCreds.map((f) => f.key)).toEqual(['client_id', 'client_secret']);
    }
  });

  it('rejects oauth2_auth_code as the org layer of a two_layer skill', () => {
    const result = paramsToAuthSpec({
      kindHint: 'oauth2_auth_code',
      providerName: 'Spotify',
      authMode: 'two_layer',
    });
    expect(result.spec).toBeNull();
  });

  it('fails (never fabricates) when the provider is unknown and no userLayer endpoints are given', () => {
    const result = paramsToAuthSpec({
      kindHint: 'api_key',
      providerName: 'Obscure SaaS',
      declaredApiHosts: ['api.o.example'],
      authMode: 'two_layer',
    });
    expect(result.spec).toBeNull();
  });
});

describe('output contract', () => {
  it('every produced spec revalidates under the strict protocol schema', () => {
    const results = [
      paramsToAuthSpec({ kindHint: 'bearer_token', providerName: 'GitHub', declaredApiHosts: ['api.github.com'] }),
      paramsToAuthSpec({ kindHint: 'oauth2_auth_code', providerName: 'Google' }),
      paramsToAuthSpec({
        kindHint: 'oauth2_client_creds',
        providerName: 'Spotify',
        declaredApiHosts: ['api.spotify.com'],
        endpoints: { tokenUrl: 'https://accounts.spotify.com/api/token' },
        authMode: 'two_layer',
      }),
    ];
    for (const result of results) {
      expect(result.spec).not.toBeNull();
      expect(authSpecSchema.safeParse(result.spec).success).toBe(true);
    }
  });

  it('rejects unknown or missing kindHint with an actionable reason', () => {
    expect(paramsToAuthSpec({ kindHint: 'saml', providerName: 'X' }).spec).toBeNull();
    expect(paramsToAuthSpec({ providerName: 'X' }).spec).toBeNull();
    expect(paramsToAuthSpec({ kindHint: 'api_key', providerName: '  ' }).spec).toBeNull();
  });
});

describe('AL-04 D5 — the transformer copies registry registration through (registry/user-entry only, M5)', () => {
  it('a registry provider with no explicit registration input gets the registry walkthrough', () => {
    const { spec } = paramsToAuthSpec({ kindHint: 'oauth2_auth_code', providerName: 'Spotify' });
    expect(spec?.registration?.consoleUrl).toBe('https://developer.spotify.com/dashboard');
    expect(spec?.registration?.instructions?.length ?? 0).toBeGreaterThan(0);
  });

  it('explicit user-entered registration input wins over the registry copy', () => {
    const { spec } = paramsToAuthSpec({
      kindHint: 'oauth2_auth_code',
      providerName: 'Spotify',
      registrationConsoleUrl: 'https://developer.spotify.com/my-team-dashboard',
    });
    expect(spec?.registration?.consoleUrl).toBe('https://developer.spotify.com/my-team-dashboard');
  });

  it('an unknown provider without registration input builds a spec with no registration block', () => {
    const { spec } = paramsToAuthSpec({
      kindHint: 'api_key',
      providerName: 'Acme Weather',
      declaredApiHosts: ['api.acme-weather.example'],
    });
    expect(spec?.registration).toBeUndefined();
  });
});
