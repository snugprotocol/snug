// registry-query-credentials.test.ts — TASK-20260812-desktop-auth-awareness P4
// (AC6's registry-data half; ADR-0022 §3). Written RED-FIRST.
//
// THE DEFECT THIS CLOSES (owner repro 2026-08-12, spec item 5): OpenWeather and CoinGecko
// are QUERY-STRING credential providers. P3 built every seat they need — the protocol's
// `request.queryTemplate`, the executor's after-ceiling injection, the widened scrub, the
// admission substitution — but neither registry ENTRY carried the data, so the executor
// still fell to the `api_key` kind default and shipped a meaningless `X-Api-Key` header
// while the provider read a query parameter that was never there. The openweather entry's
// own comment PROMISED this placement ("host-side (the template engine)") for a mechanism
// that had no data behind it; this file makes the promise true and pins it.
//
// Why the pins live in their own file rather than beside Coinbase's in
// registry-request-seats.test.ts: those are the SIGNING seats (header + JWT helper); these
// are the QUERY seats, and the distinguishing property under test — the credential must
// NOT also travel as a header — is a different assertion shape.
//
// C1 — field keys and template SHAPES only; no credential value appears here.

import { describe, expect, it } from 'vitest';

import { connectionRequirementSchema } from '@snugprotocol/protocol';

import { admitConnectionRequirement } from '../requirement-admission.js';
import { lintAuthHeaderTemplate } from '../template-lint.js';
import { requirementFromRegistryEntry, WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

/** The PINNED literals from the task file's "Pinned shared literals" block. */
const OPENWEATHER_QUERY = { appid: '{{api_key}}' } as const;
const COINGECKO_QUERY = { x_cg_demo_api_key: '{{api_key}}' } as const;

/** The testRequest decisions journaled in the task file (P4 item 1). */
const OPENWEATHER_TEST_REQUEST = { method: 'GET', pathAndQuery: '/data/2.5/weather?q=London' } as const;

describe('P4 item 1 — the two query-credential entries pin WHERE the key travels', () => {
  it('openweather.request is EXACTLY the pinned `?appid=` query template', () => {
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['openweather']?.request).toEqual({ queryTemplate: OPENWEATHER_QUERY });
  });

  it('coingecko.request is EXACTLY the pinned `x_cg_demo_api_key` query template', () => {
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['coingecko']?.request).toEqual({ queryTemplate: COINGECKO_QUERY });
  });

  it('NEITHER entry carries a headerTemplate — a query credential must not also be a header', () => {
    // The distinguishing assertion. A `request` seat carrying EITHER template suppresses
    // the kind default (connected-fetch.ts), so a stray headerTemplate here would put the
    // same secret in two places on the wire — twice the exposure for zero benefit.
    for (const key of ['openweather', 'coingecko'] as const) {
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[key]?.request?.headerTemplate, `${key} must place its key in the query only`)
        .toBeUndefined();
    }
  });

  it('both templates LINT clean against their own declared field keys (one-resolution rule)', () => {
    // The same VALUE lint family as headerTemplate (ADR-0022 §3). A template naming an
    // undeclared key renders empty and the connection reports CONNECTED while every
    // request fails closed — the founding defect shape this lint exists for.
    for (const key of ['openweather', 'coingecko'] as const) {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key]!;
      const fieldKeys = entry.fields!.map((field) => field.key);
      const result = lintAuthHeaderTemplate({ ...entry.request!.queryTemplate! }, { fieldKeys });
      expect(result.ok, `${key}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('each entry declares the ONE field its template names — no unreferenced credential seats', () => {
    // Both directions, the parity shape ADR-0022 pins for coinbase: every declared field
    // is used by the template, and every token names a declared field. A field the
    // template never reads is a credential the user pastes for nothing.
    for (const [key, template] of [
      ['openweather', OPENWEATHER_QUERY],
      ['coingecko', COINGECKO_QUERY],
    ] as const) {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key]!;
      const declared = entry.fields!.map((field) => field.key);
      const referenced = [...new Set(Object.values(template).flatMap((value) => [...value.matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)].map((match) => match[1]!)))];
      expect(referenced.sort(), `${key}: tokens must name declared fields`).toEqual(declared.sort());
    }
  });
});

describe('P4 item 1 — the testRequest decisions (deliberate, journaled)', () => {
  it('openweather pins a CREDENTIALED probe — a keyless endpoint would light up on a bad key', () => {
    // /data/2.5/weather?q=London is the cheapest authenticated read OpenWeather offers:
    // one city, current conditions, and it 401s on a bad/inactive key rather than
    // answering. A probe that cannot fail is a probe that proves nothing (AC6).
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['openweather']?.testRequest).toEqual(OPENWEATHER_TEST_REQUEST);
  });

  it('coingecko pins NO testRequest — its demo host has no endpoint the key can fail', () => {
    // DELIBERATE OMISSION, verified live 2026-08-13 (P4 recon), and the honest outcome:
    //
    //   * `api.coingecko.com` is a documented "Keyless Public API"
    //     (https://docs.coingecko.com/docs/keyless-public-api) — /ping, /simple/price and
    //     the rest answer 200 with NO key. A demo key raises the rate-limit ceiling; it
    //     gates no endpoint. So every candidate probe on this host reports CONNECTED for
    //     a typo'd key, which is worse than no probe: it launders a broken connection
    //     into a green checkmark.
    //   * `/api/v3/key` (the usage endpoint) is Pro-plan-only and lives on
    //     `pro-api.coingecko.com`. Probed live on the demo host it returns 401
    //     error_code 10005 "This request is limited to PRO API subscribers" — a refusal
    //     about the PLAN, not the key, so it would fail for every correct demo key.
    //     It is also off this entry's apiHosts ceiling.
    //
    // A probe that cannot fail proves nothing (AC6); a probe that always fails is a lie.
    // Absent testRequest keeps the wizard honest: no "test this connection" button rather
    // than one whose result means nothing. Revisit if CoinGecko ever key-gates the demo host.
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['coingecko']?.testRequest).toBeUndefined();
  });

  it("every pinned testRequest path stays inside its entry's own apiHosts ceiling", () => {
    // The probe builds its URL from apiHosts[0]; a path is only meaningful on that host.
    for (const key of ['openweather', 'coingecko'] as const) {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key]!;
      expect(entry.apiHosts.length, `${key} needs a host to probe`).toBeGreaterThan(0);
      if (entry.testRequest === undefined) continue;
      expect(entry.testRequest.pathAndQuery.startsWith('/'), `${key}: probe path must be host-relative`).toBe(true);
    }
  });
});

describe('P4 item 1 — the seats reach a BARE borrower through substitution (the starters)', () => {
  // weather-planner and crypto-portfolio ship deliberately BARE manifests: slot, provider,
  // kind, declaredApiHosts and nothing else. Substitution is the ONLY source of their
  // request template, so these assertions are the starters' contract at registry altitude.
  const bare = (slot: string, name: string, host: string) => ({
    slot,
    provider: { name },
    kind: 'api_key' as const,
    declaredApiHosts: [host],
  });

  const STARTERS = [
    {
      slot: 'openweather',
      name: 'OpenWeather',
      host: 'api.openweathermap.org',
      query: OPENWEATHER_QUERY,
      probe: OPENWEATHER_TEST_REQUEST as { method: 'GET'; pathAndQuery: string } | undefined,
    },
    { slot: 'coingecko', name: 'CoinGecko', host: 'api.coingecko.com', query: COINGECKO_QUERY, probe: undefined },
  ] as const;

  for (const starter of STARTERS) {
    for (const channel of ['starter', 'inference', 'user'] as const) {
      it(`a bare ${starter.slot} borrower on '${channel}' RECEIVES the query template`, () => {
        const result = admitConnectionRequirement(bare(starter.slot, starter.name, starter.host), { channel });
        expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true);
        expect(result.borrowedFrom).toBe(starter.slot);
        const requirement = result.requirement as { request?: unknown; testRequest?: unknown };
        expect(requirement.request, 'the pinned query template must arrive').toEqual({ queryTemplate: starter.query });
        expect(requirement.testRequest, 'the pinned probe must arrive').toEqual(starter.probe);
      });
    }

    it(`the substituted ${starter.slot} requirement SURVIVES DOUBLE admission unchanged`, () => {
      // Amendment 1(b)'s byte-match exemption, exercised for the query seats. Admission
      // runs TWICE on the production path (pipeline + db admissionGate); without the
      // exemption pass 2 refuses exactly what pass 1 substituted, and the owner's
      // starters would break on install rather than on request.
      const first = admitConnectionRequirement(bare(starter.slot, starter.name, starter.host), { channel: 'starter' });
      expect(first.ok, 'pass 1 must admit the bare starter shape').toBe(true);

      const second = admitConnectionRequirement(first.requirement, { channel: 'starter' });
      expect(
        second.ok,
        `pass 2 refused pass 1's own output — ${second.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      ).toBe(true);
      expect(second.requirement, 'the persisted bytes must not depend on pass count').toEqual(first.requirement);
    });

    it(`the substituted ${starter.slot} requirement PARSES as a v4 requirement`, () => {
      const result = admitConnectionRequirement(bare(starter.slot, starter.name, starter.host), { channel: 'starter' });
      const parsed = connectionRequirementSchema.safeParse(result.requirement);
      expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    });

    it(`the registry-shaped FULL ${starter.slot} requirement is admitted on borrow channels`, () => {
      // What the P3 seat-drift migration submits for the owner's EXISTING installs: the
      // complete emitter output, seats and all. If this were refused, the migration that
      // repairs those rows could never land its result.
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[starter.slot]!;
      const shaped = requirementFromRegistryEntry(entry, starter.name, starter.slot);
      for (const channel of ['starter', 'inference'] as const) {
        const result = admitConnectionRequirement(shaped, { channel });
        expect(result.ok, `channel '${channel}' refused the registry's own shape`).toBe(true);
        expect((result.requirement as { request?: unknown }).request).toEqual({ queryTemplate: starter.query });
      }
    });

    it(`substitution DEEP-COPIES ${starter.slot}'s query template — a caller cannot repoint it`, () => {
      const result = admitConnectionRequirement(bare(starter.slot, starter.name, starter.host), { channel: 'starter' });
      const requirement = result.requirement as unknown as { request: { queryTemplate: Record<string, string> } };
      const [pinnedKey] = Object.keys(starter.query);
      requirement.request.queryTemplate[pinnedKey!] = 'MUTATED BY CALLER';
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[starter.slot]?.request?.queryTemplate?.[pinnedKey!]).toBe('{{api_key}}');
    });

    it(`an AUTHORED ${starter.slot} query template is still REFUSED on a borrow channel`, () => {
      // Guard 2b's whole point, re-proven per entry: pinning data for these brands must
      // not open an authoring channel. A prompt-injected requirement that re-aims where
      // the credential goes is the C1 attack this refusal exists for.
      const result = admitConnectionRequirement(
        {
          ...bare(starter.slot, starter.name, starter.host),
          request: { queryTemplate: { evil_key: '{{api_key}}' } },
        },
        { channel: 'inference' },
      );
      expect(result.ok, 'an authored query template beside a pinned brand must be refused').toBe(false);
      expect(result.issues.map((issue) => issue.path)).toContain('request.queryTemplate');
    });
  }
});
