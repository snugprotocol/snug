// AL-02 (TASK-20260805-auth-core) AC1: the Dynamic Auth spec schema — INTERNAL protocol
// surface (plan D1). Ported from the OProject 5-kind union with the IProject `.strict()`
// ingest posture. These tests lock the kind literals (persisted discriminators shared
// with AL-03/04), the per-kind `declaredApiHosts` rules (plan D2), the status enum
// (N5), the derived-host union incl. refreshUrl (N2), and the fact that NONE of this
// reaches the published `schemas/` export set (the publishes-to-spec line).
import { describe, expect, it } from 'vitest';
import {
  AUTH_KINDS,
  AUTH_SECRET_PREFIX,
  AUTH_SPEC_STATUS,
  AUTH_SPEC_STATUSES,
  authSpecSchema,
  deriveAuthAllowedHosts,
  getAuthUserLayer,
  hostSetEquals,
  isAuthSpecUnknownKeysOnlyFailure,
  normalizeAuthHost,
  resolveAuthCodeLayer,
  type AuthSpec,
} from '../auth-schema.js';
import { buildJsonSchemas } from '../json-schemas.js';

// ------------------------------------------------------------------ fixtures

const apiKeySpec = {
  kind: 'api_key',
  provider: { name: 'Coinbase' },
  fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
  declaredApiHosts: ['api.coinbase.com'],
};

const bearerSpec = {
  kind: 'bearer_token',
  provider: { name: 'GitHub' },
  fields: [{ key: 'token', label: 'Personal Access Token', type: 'secret' }],
  declaredApiHosts: ['api.github.com'],
};

const basicSpec = {
  kind: 'basic_auth',
  provider: { name: 'Legacy' },
  fields: [
    { key: 'username', label: 'Username', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
  ],
  declaredApiHosts: ['legacy.example.com'],
};

const clientCredsSpec = {
  kind: 'oauth2_client_creds',
  provider: { name: 'B2B' },
  endpoints: { tokenUrl: 'https://b2b.example.com/oauth/token' },
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.b2b.example.com'],
};

const authCodeSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Spotify' },
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
  },
  scopes: ['user-read-private'],
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.spotify.com'],
};

// ------------------------------------------------------------------- kinds

describe('AC1 — the five kind literals, pinned verbatim (plan D2)', () => {
  it('AUTH_KINDS is exactly the six persisted discriminators', () => {
    // ORDER AND MEMBERSHIP ARE BOTH PINNED, and this test failing is the intended
    // tripwire for a kind addition — these are PERSISTED discriminators, so a change here
    // is a storage-compatibility event, never a refactor. `linked_device` was appended
    // (never inserted) by TASK-20260816/ADR-0032: appending keeps every existing literal
    // at its own index, so no stored row's kind can be re-read as a different kind.
    expect([...AUTH_KINDS]).toEqual([
      'api_key',
      'bearer_token',
      'basic_auth',
      'oauth2_client_creds',
      'oauth2_auth_code',
      'linked_device',
    ]);
  });

  it('accepts a valid spec of every kind', () => {
    for (const spec of [apiKeySpec, bearerSpec, basicSpec, clientCredsSpec, authCodeSpec]) {
      const parsed = authSpecSchema.safeParse(spec);
      expect(parsed.success, `${spec.kind} should parse`).toBe(true);
    }
  });

  it('rejects unknown kinds', () => {
    expect(authSpecSchema.safeParse({ ...bearerSpec, kind: 'bearer' }).success).toBe(false);
    expect(authSpecSchema.safeParse({ ...apiKeySpec, kind: 'apikey' }).success).toBe(false);
  });
});

describe('AC1 — .strict() ingest posture (IProject posture, plan D1/D2)', () => {
  it('rejects unknown keys at the top level', () => {
    expect(authSpecSchema.safeParse({ ...apiKeySpec, sneaky: true }).success).toBe(false);
  });

  it('rejects unknown keys in nested objects', () => {
    const withNested = {
      ...authCodeSpec,
      endpoints: { ...authCodeSpec.endpoints, adminUrl: 'https://evil.example.com' },
    };
    expect(authSpecSchema.safeParse(withNested).success).toBe(false);
  });

  it('classifies an unknown-keys-only failure distinctly from a structural one (import R2 seam)', () => {
    const additive = authSpecSchema.safeParse({ ...apiKeySpec, futureField: 'x' });
    expect(additive.success).toBe(false);
    if (!additive.success) expect(isAuthSpecUnknownKeysOnlyFailure(additive.error)).toBe(true);

    const broken = authSpecSchema.safeParse({ kind: 'api_key', provider: {} });
    expect(broken.success).toBe(false);
    if (!broken.success) expect(isAuthSpecUnknownKeysOnlyFailure(broken.error)).toBe(false);
  });
});

describe('AC1 — declaredApiHosts per-kind rules (plan D2)', () => {
  it('is REQUIRED non-empty for api_key / bearer_token / basic_auth / oauth2_client_creds', () => {
    for (const spec of [apiKeySpec, bearerSpec, basicSpec, clientCredsSpec]) {
      const { declaredApiHosts: _dropped, ...withoutHosts } = spec as Record<string, unknown> & {
        declaredApiHosts: string[];
      };
      expect(authSpecSchema.safeParse(withoutHosts).success, `${spec.kind} without hosts`).toBe(false);
      expect(
        authSpecSchema.safeParse({ ...spec, declaredApiHosts: [] }).success,
        `${spec.kind} with empty hosts`,
      ).toBe(false);
    }
  });

  it('is optional for oauth2_auth_code (the registry supplies apiHosts — enforced at transform time)', () => {
    const { declaredApiHosts: _dropped, ...withoutHosts } = authCodeSpec;
    expect(authSpecSchema.safeParse(withoutHosts).success).toBe(true);
  });
});

describe('AC1 — userLayer draft shape (TWO_LAYER_RESOLUTION_DEFERRED; publication gated at Beta exit)', () => {
  it('org-eligible kinds accept an embedded oauth2_auth_code userLayer', () => {
    const twoLayer = { ...clientCredsSpec, userLayer: authCodeSpec };
    const parsed = authSpecSchema.safeParse(twoLayer);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(getAuthUserLayer(parsed.data)?.kind).toBe('oauth2_auth_code');
  });

  it('oauth2_auth_code itself carries NO userLayer field (strict rejects it)', () => {
    expect(authSpecSchema.safeParse({ ...authCodeSpec, userLayer: authCodeSpec }).success).toBe(false);
  });

  it('resolveAuthCodeLayer returns the top level for auth_code and unwraps userLayer for two-layer specs (bug-1 seam)', () => {
    const direct = authSpecSchema.parse(authCodeSpec);
    expect(resolveAuthCodeLayer(direct)?.endpoints.tokenUrl).toBe(authCodeSpec.endpoints.tokenUrl);
    const twoLayer = authSpecSchema.parse({ ...bearerSpec, userLayer: authCodeSpec });
    expect(resolveAuthCodeLayer(twoLayer)?.endpoints.tokenUrl).toBe(authCodeSpec.endpoints.tokenUrl);
    expect(resolveAuthCodeLayer(authSpecSchema.parse(apiKeySpec))).toBeUndefined();
  });
});

describe('AC1 — status enum exported as protocol constants (N5, never prose-only literals)', () => {
  it('pins the snug_auth_specs.status values', () => {
    expect(AUTH_SPEC_STATUS.unapproved).toBe('unapproved');
    expect(AUTH_SPEC_STATUS.approved).toBe('approved');
    expect(AUTH_SPEC_STATUS.importedUnapproved).toBe('imported_unapproved');
    expect([...AUTH_SPEC_STATUSES].sort()).toEqual(['approved', 'imported_unapproved', 'unapproved']);
  });

  it('pins the auth secrets key namespace prefix', () => {
    expect(AUTH_SECRET_PREFIX).toBe('auth:');
  });
});

describe('AC1 — derived host union (plan D2/N2)', () => {
  it('merges declaredApiHosts with every OAuth endpoint host INCLUDING refreshUrl', () => {
    const spec = authSpecSchema.parse({
      ...authCodeSpec,
      endpoints: {
        authorizeUrl: 'https://accounts.spotify.com/authorize',
        tokenUrl: 'https://accounts.spotify.com/api/token',
        refreshUrl: 'https://refresh.spotify.example/api/token',
        revokeUrl: 'https://revoke.spotify.example/revoke',
      },
    }) as AuthSpec;
    expect(deriveAuthAllowedHosts(spec)).toEqual([
      'accounts.spotify.com',
      'api.spotify.com',
      'refresh.spotify.example',
      'revoke.spotify.example',
    ]);
  });

  it('includes the userLayer endpoints and declared hosts of a two-layer spec', () => {
    const spec = authSpecSchema.parse({ ...bearerSpec, userLayer: authCodeSpec }) as AuthSpec;
    expect(deriveAuthAllowedHosts(spec)).toEqual([
      'accounts.spotify.com',
      'api.github.com',
      'api.spotify.com',
    ]);
  });

  it('is canonical: sorted, unique, lowercased', () => {
    const spec = authSpecSchema.parse({
      ...apiKeySpec,
      declaredApiHosts: ['API.Coinbase.com', 'api.coinbase.com', 'a.example.com'],
    }) as AuthSpec;
    expect(deriveAuthAllowedHosts(spec)).toEqual(['a.example.com', 'api.coinbase.com']);
    expect(normalizeAuthHost('API.Example.COM')).toBe('api.example.com');
  });

  it('hostSetEquals compares case-insensitively and order-insensitively', () => {
    expect(hostSetEquals(['A.com', 'b.com'], ['b.COM', 'a.com'])).toBe(true);
    expect(hostSetEquals(['a.com'], ['a.com', 'b.com'])).toBe(false);
  });
});

describe('AC1 — auth schemas stay OUT of the published export set (plan D1; list updated to the v0.3 line, TASK-20260820-spec-v03-whitepaper)', () => {
  it('buildJsonSchemas() exports exactly the v0.3 wire set — no auth-* entry', () => {
    expect(Object.keys(buildJsonSchemas()).sort()).toEqual(
      [
        'app-announce.json',
        'app-cancel.json',
        'app-event.json',
        'app-message.json',
        'app-request-envelope.json',
        'app-response.json',
        'db-request.json',
        'db-response.json',
        'host-event.json',
        'host-ready.json',
        'net-request.json',
        'net-response.json',
        'open-url-request.json',
        'open-url-result.json',
      ].sort(),
    );
  });

  it('locks the internal shape with an in-package snapshot instead', () => {
    const shape = {
      kinds: [...AUTH_KINDS],
      statuses: [...AUTH_SPEC_STATUSES],
      samples: [apiKeySpec, bearerSpec, basicSpec, clientCredsSpec, authCodeSpec].map((s) => ({
        kind: s.kind,
        parses: authSpecSchema.safeParse(s).success,
      })),
    };
    expect(shape).toMatchSnapshot();
  });
});
