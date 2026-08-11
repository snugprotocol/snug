// registry-substitution.test.ts — TASK-20260810-p4-starters, P4-AC11 (RED-FIRST).
//
// THE DEFECT THIS FILE EXISTS TO CLOSE, and why it needed a NEW file rather than another
// assertion in `static-kind-registry.test.ts`.
//
// P4 added `fields` to the registry so a static-kind provider stops collapsing to one
// nameless box — the owner's founding report ("Coinbase needs key + secret + passphrase").
// The DATA landed. The SUBSTITUTION did not: `applyRegistryValues` copied provider,
// hosts, registration, authorizeParams — and never `fields`. So every registry-backed
// starter reached the credential step with ZERO input boxes, and the wizard then reported
// SUCCESS having stored no credential. The founding defect was not closed; it was made
// worse, from one generic box to none.
//
// The same conditional bug hit OAuth: `endpoints` and `pkce` were written only when the
// DECLARATION already carried the key. A bare registry-backed manifest carries neither, so
// Spotify's authorize/token URLs were dropped and the flow aimed at empty strings.
//
// WHY THE EXISTING SUITE COULD NOT CATCH EITHER. `static-kind-registry.test.ts` reads the
// registry OBJECT and asserts `entry.fields` exists. That is the "an entry that merely
// exists proves nothing" failure its own header warns about at lines 30-33 — it never runs
// a requirement THROUGH admission to see whether the fields ARRIVE. Every assertion there
// passed over the broken behavior.
//
// SO THIS FILE ASSERTS ARRIVAL, NOT EXISTENCE, and it does so against the REAL SHIPPED
// MANIFESTS read off disk (`examples/<app>/connection.json`) rather than fixtures. That
// choice is the whole point and it is inherited discipline: a fixture that hardcodes its
// own `fields` array cannot exhibit a dropped-`fields` bug, which is exactly why
// `starterInstallAct.test.ts`'s synthetic V4_MANIFEST went green over this defect while
// naming the very risk in its comment. A fixture cannot catch a typo in a manifest that
// actually ships.
//
// THE ASYMMETRY THIS PINS, which is the security shape of the fix:
//   - a borrowing channel that AUTHORS `fields` is REFUSED   (Guard 2b — unchanged)
//   - a borrowing channel that OMITS `fields` RECEIVES the registry's pinned list  (new)
// Both halves are asserted here. Only the second is new behavior; the first is pinned
// alongside it because the fix must not have relaxed it, and a fix that widened Guard 2b
// would be a strictly worse defect than the one being fixed.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { connectionRequirementSchema } from '@snugprotocol/protocol';

import { admitConnectionRequirement } from '../requirement-admission.js';
import { WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

/** packages/auth/src/__tests__ → repo root → examples/ */
const EXAMPLES = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../examples');

const readManifest = (app: string): unknown =>
  JSON.parse(readFileSync(path.join(EXAMPLES, app, 'connection.json'), 'utf8'));

/**
 * The REGISTRY-BACKED shipped starters, each named with the registry key it borrows and
 * the field keys the user must end up being asked for.
 *
 * `connection-demo` is deliberately absent: it declares `api.example.com` and authors its
 * own single field, borrowing nothing. It is the control, asserted separately below —
 * without it a green here could mean "substitution works" or "nothing borrows at all".
 */
const REGISTRY_BACKED = [
  { app: 'crypto-portfolio', registryKey: 'coingecko', kind: 'api_key', fieldKeys: ['api_key'] },
  { app: 'weather-planner', registryKey: 'openweather', kind: 'api_key', fieldKeys: ['api_key'] },
  { app: 'my-repos', registryKey: 'github', kind: 'bearer_token', fieldKeys: ['token'] },
  {
    app: 'spotify-party-dj',
    registryKey: 'spotify',
    kind: 'oauth2_auth_code',
    fieldKeys: ['client_id'],
  },
] as const;

/** The real install path: parse the manifest as a v4 requirement, then admit it. */
function admitShipped(app: string): ReturnType<typeof admitConnectionRequirement> {
  const parsed = connectionRequirementSchema.safeParse(readManifest(app));
  expect(parsed.success, `${app}: the shipped manifest must parse before admission means anything`).toBe(true);
  return admitConnectionRequirement(parsed.data, { channel: 'starter' });
}

describe('P4-AC11 — a registry-backed starter RECEIVES the registry credential fields', () => {
  for (const { app, registryKey, kind, fieldKeys } of REGISTRY_BACKED) {
    it(`${app}: borrows '${registryKey}' and arrives with a NON-EMPTY field list`, () => {
      const result = admitShipped(app);

      expect(result.ok, `${app} must be admissible — it authors no prompt copy`).toBe(true);
      expect(result.borrowed, `${app} declares a registry host, so the ban must fire`).toBe(true);
      expect(result.borrowedFrom).toBe(registryKey);

      // THE ASSERTION THE PHASE WAS MISSING. Zero fields renders zero CredentialInputs
      // (ConnectionWizardSheet: `fields.map`), and the `missing` filter over an empty
      // array is vacuously satisfied, so Save proceeds having collected nothing.
      const fields = (result.requirement as { fields?: Array<{ key: string }> }).fields;
      expect(fields, `${app} reaches the credential step with NO input boxes`).toBeDefined();
      expect(fields?.length ?? 0, `${app} must ask for at least one credential`).toBeGreaterThan(0);
    });

    it(`${app}: the arrived field keys are EXACTLY the registry's pinned list`, () => {
      // Exact-set, not `length > 0`. A `>0` guard cannot distinguish Coinbase's three
      // secrets from one, which is how the founding defect would silently return.
      const fields = (admitShipped(app).requirement as { fields?: Array<{ key: string }> }).fields;
      expect(fields?.map((field) => field.key)).toEqual([...fieldKeys]);
      expect(fields?.map((field) => field.key)).toEqual(
        WELL_KNOWN_PROVIDERS_REGISTRY[registryKey]?.fields?.map((field) => field.key),
      );
    });

    it(`${app}: every arrived field carries a human LABEL — the box must be named`, () => {
      // The defect was never "no data"; it was "no way to know which secret goes where".
      // An unnamed box is the founding report even when the field count is right.
      const fields = (admitShipped(app).requirement as { fields?: Array<{ label?: string }> }).fields ?? [];
      for (const field of fields) {
        expect(typeof field.label === 'string' && field.label.length > 0).toBe(true);
      }
    });

    it(`${app}: the substituted requirement still PARSES as a v4 requirement`, () => {
      // Substitution writes into a shape the wizard then persists. If the post-borrow
      // requirement fails its own schema, the failure lands mid-flow in front of a user.
      const result = admitShipped(app);
      const reparsed = connectionRequirementSchema.safeParse(result.requirement);
      expect(reparsed.success, `${app}: ${JSON.stringify(reparsed.error?.issues ?? [])}`).toBe(true);
      expect((result.requirement as { kind: string }).kind).toBe(kind);
    });

    it(`${app}: substitution DEEP-COPIES — a caller cannot mutate the shared registry`, () => {
      // The registry is a module-level singleton consulted by the borrow ban on every
      // admission. Handing out a live reference means one downstream caller editing a
      // label mutates the pinned truth for every future substitution, in-process.
      const fields = (admitShipped(app).requirement as { fields?: Array<{ label: string }> }).fields ?? [];
      const before = WELL_KNOWN_PROVIDERS_REGISTRY[registryKey]?.fields?.[0]?.label;
      if (fields[0] !== undefined) fields[0].label = 'MUTATED BY CALLER';
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[registryKey]?.fields?.[0]?.label).toBe(before);
    });
  }

  it('connection-demo (the control) borrows NOTHING and keeps its own single field', () => {
    // Without this, a green above could mean "substitution works" or "everything borrows
    // and gets overwritten". This pins that the non-registry starter is untouched.
    const result = admitShipped('connection-demo');
    expect(result.ok).toBe(true);
    expect(result.borrowed, 'api.example.com is in no registry entry').not.toBe(true);
    const fields = (result.requirement as { fields?: Array<{ key: string }> }).fields;
    expect(fields?.map((field) => field.key)).toEqual(['api_key']);
  });
});

describe('P4-AC11 — a registry-backed OAuth starter RECEIVES the registry endpoints', () => {
  it('spotify-party-dj: the authorize and token URLs come from the registry, not empty strings', () => {
    // The bare manifest declares no `endpoints`, and the old condition only overwrote a
    // seat the DECLARATION already carried. So the OAuth flow was aimed at
    // `requirement.endpoints?.authorizeUrl ?? ''` — an empty string.
    const requirement = admitShipped('spotify-party-dj').requirement as {
      endpoints?: { authorizeUrl?: string; tokenUrl?: string };
    };
    const registry = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']?.endpoints;

    expect(requirement.endpoints, 'a bare OAuth manifest must receive the pinned endpoints').toBeDefined();
    expect(requirement.endpoints?.authorizeUrl).toBe(registry?.authorizeUrl);
    expect(requirement.endpoints?.tokenUrl).toBe(registry?.tokenUrl);
    expect(requirement.endpoints?.authorizeUrl).toBe('https://accounts.spotify.com/authorize');
    expect(requirement.endpoints?.tokenUrl).toBe('https://accounts.spotify.com/api/token');
  });

  it('spotify-party-dj: PKCE is substituted — the registration walkthrough promises it', () => {
    // The harvested walkthrough tells the user "this hub signs in with PKCE and never
    // needs [a client secret]". Dropping `pkce` makes the registry's own copy describe a
    // flow the code cannot perform, and silently downgrades the flow the user was told
    // they were getting.
    const requirement = admitShipped('spotify-party-dj').requirement as { pkce?: boolean };
    expect(requirement.pkce).toBe(WELL_KNOWN_PROVIDERS_REGISTRY['spotify']?.pkce);
    expect(requirement.pkce).toBe(true);
  });

  it('a STATIC-kind borrower sprouts no OAuth endpoints it has no use for', () => {
    // The counterweight to the fix. Writing endpoints unconditionally must not mean
    // writing them when the registry HAS none: `deriveConnectionAllowedHosts` unions
    // endpoint hosts into the FROZEN ceiling, so an invented URL silently widens the wall
    // the user approved. coingecko/openweather/coinbase carry no endpoints by design.
    for (const app of ['crypto-portfolio', 'weather-planner']) {
      const requirement = admitShipped(app).requirement as { endpoints?: unknown; pkce?: unknown };
      expect(requirement.endpoints, `${app} must not sprout OAuth URLs`).toBeUndefined();
      expect(requirement.pkce, `${app} has no flow for PKCE to describe`).toBeUndefined();
    }
  });
});

describe('P4-AC11 — the asymmetry: omitting fields RECEIVES, authoring them is REFUSED', () => {
  // Guard 2b is unchanged by the fix and this is where that is pinned. The fix gives a
  // BARE borrower the registry's list; it must not have given an AUTHORING borrower a
  // path to render its own label beside registry-grade hosts.
  it('a starter that AUTHORS fields while borrowing is still refused (Guard 2b intact)', () => {
    const result = admitConnectionRequirement(
      {
        slot: 'coingecko',
        provider: { name: 'CoinGecko' },
        kind: 'api_key',
        fields: [{ key: 'api_key', label: 'Paste your CoinGecko password', type: 'secret' }],
        declaredApiHosts: ['api.coingecko.com'],
      },
      { channel: 'starter' },
    );

    expect(result.ok, 'attacker-authored prompt copy beside pinned hosts must be refused').toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('fields');
  });

  it('a starter that OMITS fields while borrowing receives the pinned list (the fix)', () => {
    const result = admitConnectionRequirement(
      { slot: 'coingecko', provider: { name: 'CoinGecko' }, kind: 'api_key', declaredApiHosts: ['api.coingecko.com'] },
      { channel: 'starter' },
    );

    expect(result.ok).toBe(true);
    const fields = (result.requirement as { fields?: Array<{ key: string }> }).fields;
    expect(fields?.map((field) => field.key)).toEqual(['api_key']);
  });

  it('a LOOKALIKE name borrowing the real host gets pinned fields, not its own', () => {
    // The host trigger is the load-bearing one. `C0inGecko` declaring api.coingecko.com
    // borrows the brand; after substitution the user sees CoinGecko's display name, hosts
    // AND CoinGecko's own field list — never a label the lookalike chose.
    const result = admitConnectionRequirement(
      { slot: 'x', provider: { name: 'C0inGecko' }, kind: 'api_key', declaredApiHosts: ['api.coingecko.com'] },
      { channel: 'starter' },
    );

    expect(result.borrowed).toBe(true);
    expect((result.requirement as { provider: { name: string } }).provider.name).toBe('CoinGecko');
    const fields = (result.requirement as { fields?: Array<{ key: string; label: string }> }).fields;
    expect(fields?.map((field) => field.key)).toEqual(['api_key']);
    expect(fields?.[0]?.label).toBe(WELL_KNOWN_PROVIDERS_REGISTRY['coingecko']?.fields?.[0]?.label);
  });

  it('substitution REPLACES a borrower-declared host even while granting fields', () => {
    // The two halves of the fix must hold together: gaining a field list must not come
    // with keeping `evil.example` in the ceiling.
    const result = admitConnectionRequirement(
      { slot: 'x', provider: { name: 'CoinGecko' }, kind: 'api_key', declaredApiHosts: ['evil.example'] },
      { channel: 'starter' },
    );

    const hosts = (result.requirement as { declaredApiHosts: string[] }).declaredApiHosts;
    expect(hosts).not.toContain('evil.example');
    expect(hosts).toContain('api.coingecko.com');
    expect((result.requirement as { fields?: unknown[] }).fields).toHaveLength(1);
  });
});
