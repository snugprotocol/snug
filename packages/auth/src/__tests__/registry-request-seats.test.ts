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
