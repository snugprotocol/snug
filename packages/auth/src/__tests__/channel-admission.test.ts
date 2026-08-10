// Dynamic Auth v2 P0 — Gate 3 (RED). Channel admission + registry-borrow ban: AC5, AC9.
//
// Two independent guards that share one seat (the requirement admission boundary):
//
//   AC5 (fold T-M7) — `userLayer` is a REGISTRY-SYNTHESIZED seat only. Today
//   `buildUserLayerSpec` (params-to-auth-spec.ts:246-295) will happily synthesize a
//   userLayer from caller-supplied `userLayerEndpoints` overrides, and the LLM channel
//   is only accidentally blocked: `llmProposalSchema` omits `userLayerFields` but NOT
//   `userLayerEndpoints`/`userLayerScopes`/`userLayerPkce` (render-directive.ts:63-69).
//   So an LLM proposal can already steer the three-legged flow's authorize+token URLs.
//   The admission check must reject the seat per CHANNEL, not per field.
//
//   AC9 (fold S-M3) — registry borrow. A declaration that names a registry provider, OR
//   whose declaredApiHosts intersect a registry entry's apiHosts, gets the REGISTRY's
//   pinned values; the declared values for those seats are DISCARDED. Today this fires
//   for oauth2_auth_code only, and only on name (`params-to-auth-spec.ts:171-188`) —
//   the four static kinds never consult the registry at all, so `kind:'api_key'` +
//   `providerName:'Spotify'` borrows Spotify's legitimacy with attacker-chosen hosts.
//
// The admission module does not exist yet; imported dynamically so a missing module
// fails these tests readably rather than collapsing the file at load time.
import { describe, expect, it } from 'vitest';
import { WELL_KNOWN_PROVIDERS_REGISTRY, lookupWellKnownProvider } from '../well-known-providers.js';

type AdmissionModule = typeof import('../requirement-admission.js');

async function loadAdmission(): Promise<AdmissionModule> {
  return (await import('../requirement-admission.js')) as AdmissionModule;
}

/** The five declaration channels. Only `registry` may synthesize a userLayer (T-M7). */
const CHANNELS = ['registry', 'inference', 'user_docs', 'starter', 'user'] as const;

/** Everything except `registry` — the channels AC5 must reject the userLayer seat on. */
const UNTRUSTED_USER_LAYER_CHANNELS = ['inference', 'user_docs', 'starter', 'user'] as const;

const USER_LAYER_SEAT = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Spotify' },
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
  },
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ],
  declaredApiHosts: ['api.spotify.com'],
} as const;

// ---------------------------------------------------------------------------
// AC5 — userLayer is registry-synthesized ONLY
// ---------------------------------------------------------------------------

describe('AC5 — userLayer accepted registry-synthesized, REJECTED on LLM/manifest channels', () => {
  it('ACCEPTS a userLayer the REGISTRY synthesized', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: 'Spotify' },
        fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
        declaredApiHosts: ['api.spotify.com'],
        userLayer: USER_LAYER_SEAT,
      },
      { channel: 'registry' },
    );
    expect(result.ok, `registry-synthesized userLayer was rejected: ${JSON.stringify(result)}`).toBe(true);
  });

  it('REJECTS a userLayer on every non-registry channel (negative)', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    for (const channel of UNTRUSTED_USER_LAYER_CHANNELS) {
      const result = admitConnectionRequirement(
        {
          kind: 'api_key',
          provider: { name: 'Spotify' },
          fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
          declaredApiHosts: ['api.spotify.com'],
          userLayer: USER_LAYER_SEAT,
        },
        { channel },
      );
      expect(result.ok, `channel "${channel}" was allowed to carry a userLayer`).toBe(false);
      expect(JSON.stringify(result)).toMatch(/userLayer/);
    }
  });

  it('REJECTS the userLayer seat on the LLM channel even when it names a real registry provider', async () => {
    // The seat is rejected because of WHERE it came from, never because of what it says.
    // A userLayer pointing at genuine Spotify URLs is still an LLM-authored seat.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: 'Spotify' },
        fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
        declaredApiHosts: ['api.spotify.com'],
        userLayer: USER_LAYER_SEAT,
      },
      { channel: 'inference' },
    );
    expect(result.ok).toBe(false);
  });

  it('REJECTS an LLM-channel userLayer whose endpoints are attacker-chosen (the live hole)', async () => {
    // This is the concrete exploit T-M7 names: `llmProposalSchema` omits userLayerFields
    // but NOT userLayerEndpoints, so today an LLM proposal can point the three-legged
    // consent flow at a host it chose. The user sees a real-looking consent screen.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: 'Spotify' },
        fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
        declaredApiHosts: ['api.spotify.com'],
        userLayer: {
          ...USER_LAYER_SEAT,
          endpoints: {
            authorizeUrl: 'https://accounts.spotify.com.evil.example/authorize',
            tokenUrl: 'https://evil.example/token',
          },
        },
      },
      { channel: 'inference' },
    );
    expect(result.ok, 'an LLM-channel userLayer with attacker endpoints was admitted').toBe(false);
  });

  it('a requirement WITHOUT a userLayer is admitted on every channel (the guard is scoped to the seat)', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    for (const channel of CHANNELS) {
      const result = admitConnectionRequirement(
        {
          kind: 'api_key',
          provider: { name: 'Unaffiliated Widgets' },
          fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
          declaredApiHosts: ['api.widgets.example'],
        },
        { channel },
      );
      expect(result.ok, `channel "${channel}" rejected a plain requirement: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC9 — the registry-borrow ban
// ---------------------------------------------------------------------------

/** Every shipped kind — the ban is kind-agnostic (fold S-M3), so all of them are tested. */
const ALL_KINDS = ['api_key', 'bearer_token', 'basic_auth', 'oauth2_client_creds', 'oauth2_auth_code'] as const;

/** Minimal valid body per kind, so the ban is what fails — never a shape error. */
function requirementFor(kind: (typeof ALL_KINDS)[number], providerName: string, hosts: string[]): unknown {
  const base = { provider: { name: providerName }, declaredApiHosts: hosts };
  const creds = [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' },
  ];
  switch (kind) {
    case 'api_key':
      return { ...base, kind, fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }] };
    case 'bearer_token':
      return { ...base, kind, fields: [{ key: 'token', label: 'Bearer Token', type: 'secret' }] };
    case 'basic_auth':
      return {
        ...base,
        kind,
        fields: [
          { key: 'username', label: 'Username', type: 'text' },
          { key: 'password', label: 'Password', type: 'password' },
        ],
      };
    case 'oauth2_client_creds':
      return { ...base, kind, endpoints: { tokenUrl: 'https://evil.example/token' }, clientCreds: creds };
    case 'oauth2_auth_code':
      return {
        ...base,
        kind,
        endpoints: { authorizeUrl: 'https://evil.example/authorize', tokenUrl: 'https://evil.example/token' },
        pkce: true,
        clientCreds: creds,
      };
  }
}

describe('AC9 — registry-borrow ban fires on provider-NAME match, for ALL kinds (negative)', () => {
  it('fires for every kind when the declared name matches a registry provider', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    for (const kind of ALL_KINDS) {
      const result = admitConnectionRequirement(
        requirementFor(kind, 'Spotify', ['evil.example']),
        { channel: 'inference' },
      );
      expect(result.borrowed, `kind "${kind}" did not trigger the name-match borrow ban`).toBe(true);
    }
  });

  it('fires through the registry\'s OWN lookup normalization — not a stricter string compare', async () => {
    // `normalizeProviderKey` (well-known-providers.ts:134-136) lowercases and strips
    // non-alphanum, so "S P O T I F Y" and "spotify!" both RESOLVE to the Spotify entry.
    // If the ban used a plain equality check it would miss exactly the spellings the
    // registry itself accepts — the evasion is free and the borrow still lands.
    const { admitConnectionRequirement } = await loadAdmission();
    for (const spelling of ['spotify', 'SPOTIFY', 'Spotify!', 'S-p-o-t-i-f-y', 'Google Drive', 'Apple Music']) {
      expect(lookupWellKnownProvider(spelling), `test premise broken for ${spelling}`).toBeDefined();
      const result = admitConnectionRequirement(
        requirementFor('api_key', spelling, ['evil.example']),
        { channel: 'inference' },
      );
      expect(result.borrowed, `spelling "${spelling}" evaded the name-match ban`).toBe(true);
    }
  });

  it('does NOT fire for an unaffiliated provider (no false positive)', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      requirementFor('api_key', 'Unaffiliated Widgets', ['api.widgets.example']),
      { channel: 'inference' },
    );
    expect(result.borrowed ?? false, 'the ban fired on a provider with no registry entry').toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe('AC9 — registry-borrow ban fires on declaredApiHosts ∩ registry apiHosts, for ALL kinds (negative)', () => {
  it('fires for every kind when a declared host intersects a registry entry, even under a different NAME', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    // The name is deliberately unaffiliated: this trigger must be independent of the
    // name path, or an attacker just renames to evade it while still aiming the
    // credential at api.spotify.com.
    for (const kind of ALL_KINDS) {
      const result = admitConnectionRequirement(
        requirementFor(kind, 'Totally Unrelated App', ['api.spotify.com']),
        { channel: 'inference' },
      );
      expect(result.borrowed, `kind "${kind}" did not trigger the host-intersection borrow ban`).toBe(true);
    }
  });

  it('fires on a PARTIAL intersection (one borrowed host among several declared)', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      requirementFor('api_key', 'Totally Unrelated App', ['api.mine.example', 'api.github.com', 'cdn.mine.example']),
      { channel: 'inference' },
    );
    expect(result.borrowed, 'a single intersecting host did not trigger the ban').toBe(true);
  });

  it('fires for every registry entry\'s hosts, not just the ones the tests name', async () => {
    // Pins the ban to the registry DATA rather than to a hardcoded list, so a P4 entry
    // added later is covered on arrival instead of silently unguarded.
    const { admitConnectionRequirement } = await loadAdmission();
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      for (const host of entry.apiHosts) {
        const result = admitConnectionRequirement(
          requirementFor('api_key', 'Totally Unrelated App', [host]),
          { channel: 'inference' },
        );
        expect(result.borrowed, `registry host ${host} (entry "${key}") did not trigger the ban`).toBe(true);
      }
    }
  });

  it('does NOT fire on a host that merely SUFFIXES a registry host (no false positive)', async () => {
    // `api.spotify.com.evil.example` must not count as an intersection with
    // `api.spotify.com` — that is a DIFFERENT host and the ban is an exact host-set
    // intersection, not a substring test. It is caught by the frozen-host ceiling and
    // the review's provenance copy, not by pretending this guard reaches it.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      requirementFor('api_key', 'Totally Unrelated App', ['api.spotify.com.evil.example']),
      { channel: 'inference' },
    );
    expect(result.borrowed ?? false, 'a suffix host was treated as a registry intersection').toBe(false);
  });
});

describe('AC9 — on a borrow hit the registry\'s pinned values WIN and declared values are DISCARDED', () => {
  it('discards declared hosts and endpoints, substituting the registry\'s pinned values', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    const spotify = lookupWellKnownProvider('Spotify');
    expect(spotify, 'test premise broken — Spotify must be in the registry').toBeDefined();

    const result = admitConnectionRequirement(
      {
        kind: 'oauth2_auth_code',
        provider: { name: 'Spotify', homepageUrl: 'https://evil.example' },
        endpoints: {
          authorizeUrl: 'https://evil.example/authorize',
          tokenUrl: 'https://evil.example/token',
        },
        pkce: true,
        clientCreds: [
          { key: 'client_id', label: 'Client ID', type: 'text' },
          { key: 'client_secret', label: 'Client Secret', type: 'secret' },
        ],
        declaredApiHosts: ['evil.example', 'api.spotify.com'],
      },
      { channel: 'inference' },
    );

    expect(result.borrowed).toBe(true);
    expect(result.ok).toBe(true);
    const requirement = result.requirement as {
      declaredApiHosts: string[];
      endpoints: { authorizeUrl: string; tokenUrl: string };
    };
    // The registry's hosts REPLACE the declared list — evil.example is gone, not merged.
    expect(requirement.declaredApiHosts).toEqual(spotify!.apiHosts);
    expect(requirement.declaredApiHosts).not.toContain('evil.example');
    // `endpoints` became OPTIONAL on the registry type (fold T-M1: static-kind entries
    // have no OAuth flow). Narrowed with an explicit assertion rather than an optional
    // chain — `spotify?.endpoints?.authorizeUrl` would compare undefined-to-undefined and
    // pass VACUOUSLY if the Spotify entry ever lost its endpoints.
    expect(spotify!.endpoints, 'test premise broken — Spotify must carry OAuth endpoints').toBeDefined();
    expect(requirement.endpoints.authorizeUrl).toBe(spotify!.endpoints!.authorizeUrl);
    expect(requirement.endpoints.tokenUrl).toBe(spotify!.endpoints!.tokenUrl);
  });

  it('discards declared values for a STATIC kind too (the ban is not OAuth-only)', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    const github = lookupWellKnownProvider('GitHub');
    expect(github).toBeDefined();

    const result = admitConnectionRequirement(
      requirementFor('bearer_token', 'GitHub', ['evil.example']),
      { channel: 'inference' },
    );
    expect(result.borrowed).toBe(true);
    const requirement = result.requirement as { declaredApiHosts: string[] };
    expect(requirement.declaredApiHosts).toEqual(github!.apiHosts);
    expect(requirement.declaredApiHosts).not.toContain('evil.example');
  });

  it('pins the registry display name, so borrowed copy cannot rename the provider in review', async () => {
    // The review screen shows provider.name. If the declared name survived a borrow hit,
    // the user would read attacker copy next to registry-grade hosts.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      requirementFor('api_key', 'Spotify Premium Support', ['api.spotify.com']),
      { channel: 'inference' },
    );
    expect(result.borrowed).toBe(true);
    const requirement = result.requirement as { provider: { name: string } };
    expect(requirement.provider.name).toBe('Spotify');
  });
});

// ---------------------------------------------------------------------------
// AC9 (review MAJOR-1) — the CREDENTIAL-PROMPT seats on a borrow hit
// ---------------------------------------------------------------------------

describe('AC9 — a borrow hit from a non-registry channel must not carry attacker-authored credential-prompt copy', () => {
  /**
   * The gap this closes. Pinning `provider.name` and `declaredApiHosts` moved the borrow
   * from "attacker host under a real brand" to "REAL host under a real brand" — but the
   * seats the user actually READS AND TYPES INTO were still passed through verbatim:
   * `fields` (the prompt labels), `request.headerTemplate` (where the typed secret is
   * sent) and `testRequest` (the path it is first sent to).
   *
   * That is strictly worse than no substitution, because substitution ADDS legitimacy:
   * the review screen renders registry-grade hosts and the registry's own display name
   * beside a label reading "Paste your Spotify password". This is exactly the harm
   * `llmProposalSchema`'s omit-list exists to prevent, reintroduced one layer down.
   *
   * WHY REJECT RATHER THAN SUBSTITUTE. There is no registry value to substitute WITH: the
   * registry pins hosts, endpoints and registration copy, but it does not carry a field
   * list or a header template for a static kind (those are P4 data). Clearing the seats
   * instead would hand the wizard a registry-backed requirement with no way to collect
   * the credential — a shape that cannot be honestly rendered. Refusing is the only
   * fail-closed answer, and it costs nothing legitimate: a genuine Spotify integration
   * arrives through the `registry` channel, which is exempt.
   */
  const CREDENTIAL_PROMPT_PROBE = {
    slot: 'spotify',
    kind: 'api_key',
    provider: { name: 'Spotify' },
    fields: [{ key: 'api_key', label: 'Paste your Spotify password', type: 'secret', required: true }],
    request: { headerTemplate: { 'X-Exfil': '{{api_key}}' } },
    testRequest: { method: 'GET', pathAndQuery: '/steal' },
    declaredApiHosts: ['evil.example'],
  } as const;

  it('REJECTS the review MAJOR-1 probe outright instead of admitting it as registry-backed (negative)', async () => {
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(CREDENTIAL_PROMPT_PROBE, { channel: 'inference' });

    expect(result.ok, `attacker-authored credential prompt was admitted: ${JSON.stringify(result)}`).toBe(false);
    // The rejection must name a credential-prompt seat, so the wizard can say WHICH claim
    // it refused rather than rendering a bare "invalid requirement".
    expect(JSON.stringify(result.issues)).toMatch(/fields|headerTemplate|testRequest/);
  });

  it('never presents an attacker-authored field label under a registry provider name (the load-bearing claim)', async () => {
    // Stated as a property over the RESULT rather than over the reject path, so it keeps
    // holding if a later change decides to clear the seats instead of refusing: whatever
    // admission returns, this string must never ride along with a pinned registry name.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(CREDENTIAL_PROMPT_PROBE, { channel: 'inference' });
    const admitted = result.ok ? JSON.stringify(result.requirement) : '';

    expect(admitted).not.toMatch(/Paste your Spotify password/);
    expect(admitted).not.toMatch(/X-Exfil/);
    expect(admitted).not.toMatch(/\/steal/);
  });

  it('refuses each credential-prompt seat INDEPENDENTLY — no seat is a free rider (negative)', async () => {
    // One test per seat, because a fix that only checked `fields` would leave the header
    // template (where the secret actually GOES) admitted under a registry brand.
    const { admitConnectionRequirement } = await loadAdmission();
    const seats: Array<readonly [string, Record<string, unknown>]> = [
      ['fields', { fields: [{ key: 'api_key', label: 'Paste your Spotify password', type: 'secret' }] }],
      ['request.headerTemplate', { request: { headerTemplate: { 'X-Exfil': '{{api_key}}' } } }],
      ['testRequest', { testRequest: { method: 'GET', pathAndQuery: '/steal' } }],
    ];
    for (const [seat, patch] of seats) {
      const result = admitConnectionRequirement(
        { kind: 'api_key', provider: { name: 'Spotify' }, declaredApiHosts: ['evil.example'], ...patch },
        { channel: 'inference' },
      );
      expect(result.ok, `seat "${seat}" rode along on a borrow hit: ${JSON.stringify(result)}`).toBe(false);
    }
  });

  it('fires on the HOST trigger too, not just the name trigger (negative)', async () => {
    // The lookalike-name case: an unaffiliated brand aiming at a registry host. The borrow
    // still lands via host intersection, so the credential-prompt refusal must too.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: 'Spotlfy Premium' },
        fields: [{ key: 'api_key', label: 'Paste your Spotify password', type: 'secret' }],
        declaredApiHosts: ['api.spotify.com'],
      },
      { channel: 'inference' },
    );
    expect(result.ok, 'a host-triggered borrow admitted attacker-authored prompt copy').toBe(false);
  });

  it('the REGISTRY channel is exempt — a synthesized requirement still carries its own fields', async () => {
    // The registry channel is the one that legitimately AUTHORS these seats. If the
    // refusal fired here it would make the registry unable to describe its own providers,
    // which would be a self-inflicted outage rather than a security win.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: 'Spotify' },
        fields: [{ key: 'api_key', label: 'API Key', type: 'secret' }],
        request: { headerTemplate: { Authorization: 'Bearer {{api_key}}' } },
        declaredApiHosts: ['api.spotify.com'],
      },
      { channel: 'registry' },
    );
    expect(result.ok, `the registry channel was refused its own seats: ${JSON.stringify(result)}`).toBe(true);
  });

  it('leaves a NON-borrowing requirement\'s prompt seats completely alone (no false positive)', async () => {
    // The refusal is scoped to borrow hits. An unaffiliated provider declaring its own
    // fields and header template is the ordinary case and must pass through untouched.
    const { admitConnectionRequirement } = await loadAdmission();
    const result = admitConnectionRequirement(
      {
        kind: 'api_key',
        provider: { name: 'Unaffiliated Widgets' },
        fields: [{ key: 'api_key', label: 'Widget API Key', type: 'secret' }],
        request: { headerTemplate: { 'X-Widget-Key': '{{api_key}}' } },
        testRequest: { method: 'GET', pathAndQuery: '/v1/ping' },
        declaredApiHosts: ['api.widgets.example'],
      },
      { channel: 'inference' },
    );
    expect(result.ok).toBe(true);
    expect(result.borrowed ?? false).toBe(false);
    const requirement = result.requirement as { fields: Array<{ label: string }> };
    expect(requirement.fields[0]?.label).toBe('Widget API Key');
  });
});
