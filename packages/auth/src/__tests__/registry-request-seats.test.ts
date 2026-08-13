// registry-request-seats.test.ts — TASK-20260812-desktop-auth-awareness P3-registry
// (ADR-0022 §1 + P0 amendment 1, all three parts binding). Written RED-FIRST.
//
// THE DEFECT CLASS THIS CLOSES (ADR-0022 context, owner repro 2026-08-12): the registry
// could pin a provider's identity, hosts, fields and walkthrough — but never WHERE a
// typed credential is sent (`request`) nor HOW a connection is verified (`testRequest`).
// Guard 2b refuses authored versions of those seats beside a pinned brand (correctly),
// so a pinned provider could NEVER carry a signing template: the executor fell to the
// `api_key` kind default (`X-Api-Key`) and the credential was silently useless.
//
// Three halves, in the order the amendments bind them:
//
//   1(a) `occupiedPromptSeats` counts a `request` carrying headerTemplate OR
//        queryTemplate. Before this file, a queryTemplate-only request SAILED PAST
//        Guard 2b — a real hole the new protocol seat would have widened: an authored
//        `queryTemplate: { key: '{{api_key}}' }` beside a registry brand was admitted,
//        and rendered query values are credentials in a URL.
//   1(b) request/testRequest values byte-matching the MATCHED option's pinned values
//        are exempt, derived from the SAME `matchAuthOption` handle as the fields
//        exemption — ONE resolution drives refusal AND substitution (lesson 2026-08-12:
//        never audit half a two-half guard). Admission runs TWICE on the production
//        path, so without the exemption pass 2 refuses what pass 1 substituted.
//   1(c) `applyRegistryValues` substitutes pinned request/testRequest on every borrow
//        hit — channel-agnostic, because that is what serves bare starter and
//        inference rows (ADR-0022 D1 as amended).
//
// C1 — field keys and template SHAPES only; no credential value appears here.

import { describe, expect, it } from 'vitest';

import { connectionRequirementSchema } from '@snugprotocol/protocol';

import { admitConnectionRequirement } from '../requirement-admission.js';
import {
  requirementFromRegistryEntry,
  WELL_KNOWN_PROVIDERS_REGISTRY,
  type WellKnownAuthOption,
  type WellKnownOauthProvider,
} from '../well-known-providers.js';

// ---------------------------------------------------------------------------
// §1 — the TYPE seats + the ONE emitter (synthetic entry: the seats must exist
// and ride through independent of any particular data entry)
// ---------------------------------------------------------------------------

/**
 * Synthetic entry carrying BOTH new seats. Typed against `WellKnownOauthProvider` so
 * the missing type seat is a tsc-gate failure, not just an assertion failure — the
 * red-first proof has two layers on purpose.
 */
const SEATED_ENTRY: WellKnownOauthProvider = {
  displayName: 'Seated Provider',
  kind: 'api_key',
  apiHosts: ['api.seated.example'],
  fields: [
    { key: 'api_key', label: 'API key', type: 'text' },
    { key: 'private_key', label: 'Private key', type: 'secret' },
  ],
  request: {
    headerTemplate: { Authorization: 'Bearer {{api_key}}' },
    queryTemplate: { appid: '{{api_key}}' },
  },
  testRequest: { method: 'GET', pathAndQuery: '/v1/ping' },
};

/** An alternate option that carries its OWN request and testRequest. */
const SEATED_OPTION: WellKnownAuthOption = {
  id: 'alt',
  label: 'Alternate way in',
  kind: 'bearer_token',
  fields: [{ key: 'token', label: 'Token', type: 'secret' }],
  request: { headerTemplate: { Authorization: 'Bearer {{token}}' } },
  testRequest: { method: 'GET', pathAndQuery: '/v1/me' },
};

/** An option that carries NEITHER seat — the override must remove, never inherit. */
const BARE_OPTION: WellKnownAuthOption = {
  id: 'bare',
  label: 'Bare option',
  kind: 'bearer_token',
  fields: [{ key: 'token', label: 'Token', type: 'secret' }],
};

describe('ADR-0022 §1 — request/testRequest are registry seats the ONE emitter carries', () => {
  it('the emitter emits BOTH seats, and the result parses against the real schema', () => {
    const built = requirementFromRegistryEntry(SEATED_ENTRY, 'Seated Provider', 'seated');
    const parsed = connectionRequirementSchema.safeParse(built);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.request).toEqual({
      headerTemplate: { Authorization: 'Bearer {{api_key}}' },
      queryTemplate: { appid: '{{api_key}}' },
    });
    expect(parsed.data.testRequest).toEqual({ method: 'GET', pathAndQuery: '/v1/ping' });
  });

  it('the emitter hands out COPIES of the new seats, never live registry references', () => {
    const built = requirementFromRegistryEntry(SEATED_ENTRY, 'Seated Provider', 'seated') as unknown as Record<
      string,
      unknown
    >;
    expect(built['request']).not.toBe(SEATED_ENTRY.request);
    expect((built['request'] as { headerTemplate?: unknown }).headerTemplate).not.toBe(
      SEATED_ENTRY.request?.headerTemplate,
    );
    expect((built['request'] as { queryTemplate?: unknown }).queryTemplate).not.toBe(
      SEATED_ENTRY.request?.queryTemplate,
    );
    expect(built['testRequest']).not.toBe(SEATED_ENTRY.testRequest);
  });

  it('an OPTION with its own seats overrides the entry (flow seats per ADR-0020)', () => {
    const built = requirementFromRegistryEntry(SEATED_ENTRY, 'Seated Provider', 'seated', SEATED_OPTION);
    expect(built.request).toEqual({ headerTemplate: { Authorization: 'Bearer {{token}}' } });
    expect(built.testRequest).toEqual({ method: 'GET', pathAndQuery: '/v1/me' });
  });

  it('an OPTION without the seats REMOVES them — a different flow never inherits a signing template', () => {
    // The concrete harm the override rule prevents: an OAuth option inheriting the
    // api_key flow's header template would inject a template whose field keys the
    // option does not even declare.
    const built = requirementFromRegistryEntry(SEATED_ENTRY, 'Seated Provider', 'seated', BARE_OPTION);
    expect(built.request).toBeUndefined();
    expect(built.testRequest).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 — amendment 1(a): Guard 2b counts a queryTemplate-carrying request
// ---------------------------------------------------------------------------

describe('amendment 1(a) — a queryTemplate-carrying request is an OCCUPIED prompt seat', () => {
  const BORROW_CHANNELS = ['inference', 'user_docs', 'starter', 'user'] as const;

  it('REFUSES an authored queryTemplate-only request on every borrowing channel (the hole, closed)', () => {
    // RED-FIRST EVIDENCE: before amendment 1(a), `occupiedPromptSeats` looked ONLY at
    // `headerTemplate`, so this exact shape was ADMITTED — attacker-chosen query
    // placement (credentials in a URL) beside a registry brand.
    for (const channel of BORROW_CHANNELS) {
      const result = admitConnectionRequirement(
        {
          slot: 'spotify',
          provider: { name: 'Spotify' },
          kind: 'api_key',
          request: { queryTemplate: { api_key: '{{api_key}}' } },
          declaredApiHosts: ['api.spotify.com'],
        },
        { channel },
      );
      expect(result.ok, `channel '${channel}': a queryTemplate-only request sailed past Guard 2b`).toBe(false);
      expect(result.issues.map((issue) => issue.path)).toContain('request.queryTemplate');
    }
  });

  it('names BOTH sub-seats when a request carries both templates', () => {
    const result = admitConnectionRequirement(
      {
        slot: 'spotify',
        provider: { name: 'Spotify' },
        kind: 'api_key',
        request: {
          headerTemplate: { 'X-Exfil': '{{api_key}}' },
          queryTemplate: { key: '{{api_key}}' },
        },
        declaredApiHosts: ['api.spotify.com'],
      },
      { channel: 'starter' },
    );
    expect(result.ok).toBe(false);
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain('request.headerTemplate');
    expect(paths).toContain('request.queryTemplate');
  });

  it('an EMPTY request object still does not count (no false positive)', () => {
    const result = admitConnectionRequirement(
      {
        slot: 'spotify',
        provider: { name: 'Spotify' },
        kind: 'api_key',
        request: {},
        declaredApiHosts: ['api.spotify.com'],
      },
      { channel: 'starter' },
    );
    expect(result.ok, 'an empty request says nothing about where a secret goes').toBe(true);
  });

  it('a NON-borrowing requirement keeps its authored queryTemplate untouched (scope pin)', () => {
    const result = admitConnectionRequirement(
      {
        slot: 'widgets',
        provider: { name: 'Unaffiliated Widgets' },
        kind: 'api_key',
        fields: [{ key: 'api_key', label: 'Widget API Key', type: 'secret' }],
        request: { queryTemplate: { appid: '{{api_key}}' } },
        declaredApiHosts: ['api.widgets.example'],
      },
      { channel: 'inference' },
    );
    expect(result.ok).toBe(true);
    expect(result.borrowed ?? false).toBe(false);
    expect((result.requirement as { request?: { queryTemplate?: Record<string, string> } }).request?.queryTemplate)
      .toEqual({ appid: '{{api_key}}' });
  });

  it('the REGISTRY channel may author a queryTemplate — it is the author, not a borrower', () => {
    const result = admitConnectionRequirement(
      {
        slot: 'openweather',
        provider: { name: 'OpenWeather' },
        kind: 'api_key',
        request: { queryTemplate: { appid: '{{api_key}}' } },
        declaredApiHosts: ['api.openweathermap.org'],
      },
      { channel: 'registry' },
    );
    expect(result.ok, `the registry channel was refused its own seat: ${JSON.stringify(result.issues)}`).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// §3 — amendments 1(b)/1(c) against the REAL Coinbase CDP entry (the first data
// entry to pin the new seats; P3 item 3)
// ---------------------------------------------------------------------------

const CDP_REQUEST = { headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, private_key)}}' } } as const;
const CDP_TEST_REQUEST = { method: 'GET', pathAndQuery: '/api/v3/brokerage/accounts' } as const;

describe('P3 item 3 — the Coinbase entry pins the CDP request/testRequest seats', () => {
  it('coinbase.request is EXACTLY the pinned cdp_jwt bearer template', () => {
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.request).toEqual(CDP_REQUEST);
  });

  it('coinbase.testRequest is EXACTLY GET /api/v3/brokerage/accounts', () => {
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.testRequest).toEqual(CDP_TEST_REQUEST);
  });

  it('the OAuth option carries NEITHER seat — a sign-in flow injects no api_key template', () => {
    const option = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.authOptions?.find((candidate) => candidate.id === 'oauth');
    expect(option).toBeDefined();
    expect(option?.request).toBeUndefined();
    expect(option?.testRequest).toBeUndefined();
  });
});

describe('amendment 1(c) — substitution serves the pinned seats to every borrowing channel', () => {
  const BARE_COINBASE = {
    slot: 'coinbase',
    provider: { name: 'Coinbase' },
    kind: 'api_key',
    declaredApiHosts: ['api.coinbase.com'],
  } as const;

  for (const channel of ['starter', 'inference', 'user'] as const) {
    it(`a bare borrower on '${channel}' RECEIVES request + testRequest (channel-agnostic)`, () => {
      const result = admitConnectionRequirement({ ...BARE_COINBASE }, { channel });
      expect(result.ok).toBe(true);
      expect(result.borrowedFrom).toBe('coinbase');
      const requirement = result.requirement as {
        request?: unknown;
        testRequest?: unknown;
        fields?: Array<{ key: string }>;
      };
      expect(requirement.request, 'the pinned signing template must arrive').toEqual(CDP_REQUEST);
      expect(requirement.testRequest, 'the pinned probe must arrive').toEqual(CDP_TEST_REQUEST);
      expect(requirement.fields?.map((field) => field.key)).toEqual(['api_key', 'private_key']);
    });
  }

  it('substitution DEEP-COPIES the seats — a caller cannot repoint the pinned truth', () => {
    const result = admitConnectionRequirement({ ...BARE_COINBASE }, { channel: 'starter' });
    const requirement = result.requirement as unknown as { request: { headerTemplate: Record<string, string> } };
    requirement.request.headerTemplate['Authorization'] = 'MUTATED BY CALLER';
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.request?.headerTemplate?.['Authorization']).toBe(
      'Bearer {{cdp_jwt(api_key, private_key)}}',
    );
  });

  it('the substituted requirement PARSES — the seats ride within schema bounds', () => {
    const result = admitConnectionRequirement({ ...BARE_COINBASE }, { channel: 'starter' });
    const parsed = connectionRequirementSchema.safeParse(result.requirement);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
  });
});

describe('amendment 1(b) — the byte-match exemption: ONE resolution, all three seats', () => {
  const bareCoinbase = () => ({
    slot: 'coinbase',
    provider: { name: 'Coinbase' },
    kind: 'api_key',
    declaredApiHosts: ['api.coinbase.com'],
  });

  it('a bare starter-channel requirement SURVIVES DOUBLE admission with the seats intact', () => {
    // THE P5-BLOCKER SHAPE, per seat (amendment 1's probe-reproduced finding):
    // admission runs twice on the production path (pipeline + db admissionGate), so a
    // request/testRequest written on pass 1 must not be refused on pass 2.
    const first = admitConnectionRequirement(bareCoinbase(), { channel: 'starter' });
    expect(first.ok, 'pass 1 must admit the bare starter shape').toBe(true);

    const second = admitConnectionRequirement(first.requirement, { channel: 'starter' });
    expect(
      second.ok,
      `pass 2 refused pass 1's own output — ${second.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    ).toBe(true);

    // Idempotent in VALUE too: the persisted bytes must not depend on pass count.
    expect(second.requirement).toEqual(first.requirement);
    const requirement = second.requirement as { request?: unknown; testRequest?: unknown };
    expect(requirement.request, 'the substituted request survived both passes').toEqual(CDP_REQUEST);
    expect(requirement.testRequest, 'the substituted testRequest survived both passes').toEqual(CDP_TEST_REQUEST);
  });

  it('a request differing from the pinned value BY ONE BYTE is still an authoring act — refused', () => {
    const result = admitConnectionRequirement(
      {
        ...bareCoinbase(),
        fields: WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!.fields!.map((field) => ({ ...field })),
        request: { headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, private_key)}} ' } }, // trailing space
      },
      { channel: 'starter' },
    );
    expect(result.ok, 'a near-miss template is authored, not pinned').toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('request.headerTemplate');
  });

  it('a testRequest differing from the pinned value is refused (per-seat, no free rider)', () => {
    const result = admitConnectionRequirement(
      {
        ...bareCoinbase(),
        fields: WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!.fields!.map((field) => ({ ...field })),
        testRequest: { method: 'GET', pathAndQuery: '/api/v3/brokerage/portfolios' },
      },
      { channel: 'starter' },
    );
    expect(result.ok, 'a re-aimed probe path is authored, not pinned').toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('testRequest');
  });

  it('the exemption needs the MATCHED handle: pinned request beside NO matching fields is refused', () => {
    // The one-resolution rule's negative: without a matched option (fields absent),
    // there is no pinned flow to byte-match against, so a carried request is authored.
    // This is exactly the fail-closed half — the exemption never outruns its handle.
    const result = admitConnectionRequirement(
      {
        ...bareCoinbase(),
        request: {
          headerTemplate: { ...WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!.request!.headerTemplate! },
        },
      },
      { channel: 'starter' },
    );
    expect(result.ok, 'no matched fields ⇒ no exemption, even for pinned-looking bytes').toBe(false);
  });

  it("the OAUTH option's matched fields do NOT bless the api_key flow's request (cross-option negative)", () => {
    // Mixing option A's fields with option B's request is an authored composite; the
    // single handle must refuse it rather than let each half bless the other.
    const option = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!.authOptions![0]!;
    const result = admitConnectionRequirement(
      {
        ...bareCoinbase(),
        kind: 'oauth2_auth_code',
        fields: option.fields!.map((field) => ({ ...field })),
        request: { headerTemplate: { ...WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!.request!.headerTemplate! } },
      },
      { channel: 'user' },
    );
    expect(result.ok, "option fields + the DEFAULT's request is a mixed authored shape").toBe(false);
  });

  it('the registry-shaped FULL requirement (the emitter output) is admitted on borrow channels', () => {
    // What the seat-drift migration and the choice card actually submit: the complete
    // emitter output, seats and all. It must pass both admission passes.
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;
    const shaped = requirementFromRegistryEntry(entry, 'Coinbase', 'coinbase');
    for (const channel of ['starter', 'inference'] as const) {
      const result = admitConnectionRequirement(shaped, { channel });
      expect(result.ok, `channel '${channel}' refused the registry's own shape`).toBe(true);
      expect((result.requirement as { request?: unknown }).request).toEqual(CDP_REQUEST);
    }
  });
});
