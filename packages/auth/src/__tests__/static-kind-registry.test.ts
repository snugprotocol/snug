// static-kind-registry.test.ts — TASK-20260810-p4-starters, P4-AC1 (RED).
//
// THE REGISTRY DATA ENTRIES for the three static kinds: `coinbase`, `openweather`,
// `coingecko`. P0 already widened the TYPE (`WellKnownOauthProvider.endpoints` became
// optional so an entry with no OAuth flow at all is representable — see the long comment
// at that field). This file is the DATA half, and it is the half that carries the
// security weight, because a registry entry is not reference material: it is the pinned
// truth the registry-borrow ban substitutes over an attacker's declaration.
//
// WHY EACH ASSERTION EXISTS, rather than "the entry looks right":
//
//  1. WELL-FORMED AGAINST THE PROTOCOL. Each entry must be able to BECOME a
//     `connectionRequirement` that parses. The registry's `apiHosts` become
//     `declaredApiHosts` and its `registration` becomes `registration` under
//     substitution (`applyRegistryValues`), so an entry carrying a host or an
//     instruction the protocol schema rejects is a latent runtime failure at the worst
//     moment — mid-substitution, on a rejected requirement, in front of a user.
//
//  2. `fields` AND `registration` ARE PRESENT. The whole reason static kinds needed
//     registry entries is the owner's founding defect: "Coinbase needs key + secret +
//     passphrase" collapsed to the transformer's one generic field. An entry without a
//     field list re-creates that defect; an entry without a walkthrough leaves the user
//     at a console they cannot navigate, which is where they paste the wrong secret.
//
//  3. THE BORROW BAN TREATS THEM AS PINNED. This is the assertion that matters most and
//     the one that cannot be inferred from the data alone. `requirement-admission.ts`
//     builds its host index from `WELL_KNOWN_PROVIDERS_REGISTRY` at call time, so ADDING
//     an entry silently EXTENDS the ban's reach. That is the intended effect — and it
//     is also a behavior change to a security guard that must be pinned by a test, not
//     assumed from a data edit.
//
// NEGATIVE TESTS ARE THE MAJORITY HERE (High tier). A registry entry that merely exists
// proves nothing; what proves the entry is pinned is what the guard REFUSES once it
// exists.

import { describe, expect, it } from 'vitest';

import { connectionRequirementSchema } from '@snugprotocol/protocol';

import { admitConnectionRequirement } from '../requirement-admission.js';
import { lookupWellKnownProvider, WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

/**
 * The three static-kind providers this phase adds, with the display name each must
 * resolve to and the API host each must pin.
 *
 * Hosts are the REAL ones: an entry pinning a fictional host would substitute a ceiling
 * no real app could use, and the borrow ban would never fire on a genuine declaration.
 */
const STATIC_KIND_ENTRIES = [
  {
    key: 'coinbase',
    displayName: 'Coinbase',
    apiHost: 'api.coinbase.com',
    // EXACT, ORDERED field keys — never a count, and never `length > 0`.
    //
    // A `>0` assertion cannot distinguish the pinned credential set from a partial one,
    // which is the founding defect itself. Mutation-proven on the original list:
    // deleting a whole field block from the registry passed the entire suite before
    // this exact-set pin existed.
    //
    // MIGRATED 2026-08-13 (TASK-20260812-desktop-auth-awareness P3, ADR-0022 §5): the
    // old `['api_key', 'api_secret', 'passphrase']` set described retail HMAC keys that
    // Coinbase EXPIRED provider-side on 2025-02-05 — an entry that was never
    // connectable. Current CDP credentials are a key NAME plus an Ed25519 private key
    // signing a per-request EdDSA JWT (`{{cdp_jwt(api_key, ed25519_private_key)}}` — see
    // `registry-request-seats.test.ts` for the pinned template and
    // `registry-template-parity.test.ts` for the token↔field-key parity).
    fieldKeys: ['api_key', 'ed25519_private_key'],
  },
  { key: 'openweather', displayName: 'OpenWeather', apiHost: 'api.openweathermap.org', fieldKeys: ['api_key'] },
  { key: 'coingecko', displayName: 'CoinGecko', apiHost: 'api.coingecko.com', fieldKeys: ['api_key'] },
] as const;

describe('P4-AC1 — the three static-kind registry entries exist and are complete', () => {
  for (const { key, displayName, apiHost, fieldKeys } of STATIC_KIND_ENTRIES) {
    it(`${key}: is in the registry under its own key`, () => {
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[key]).toBeDefined();
    });

    it(`${key}: resolves by DISPLAY NAME through the registry's own normalization`, () => {
      // Resolution by name is what the borrow ban's name trigger uses
      // (`findBorrowedEntry` → `lookupWellKnownProvider`). An entry reachable only by
      // its raw key would be invisible to the guard on every requirement that names the
      // provider the way a human writes it.
      expect(lookupWellKnownProvider(displayName)?.displayName).toBe(displayName);
    });

    it(`${key}: pins its real API host`, () => {
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[key]?.apiHosts).toContain(apiHost);
    });

    it(`${key}: carries EXACTLY its pinned credential field keys — the owner's founding defect`, () => {
      // The defect this phase closes: without a field list, every static-kind provider
      // collapses to one generic input. Coinbase needs three distinct secrets and the
      // user must be told which is which BEFORE pasting.
      //
      // ASSERTED AS AN EXACT SET, not `length > 0`. The weaker form was mutation-proven
      // useless: deleting Coinbase's entire `passphrase` field block — the third secret
      // whose absence IS the founding defect — passed all 307 tests in this package and
      // all 19 root tasks. A guard that survives the removal of the thing it guards is
      // decoration.
      const fields = WELL_KNOWN_PROVIDERS_REGISTRY[key]?.fields;
      expect(fields, `${key} must declare its credential fields`).toBeDefined();
      expect(fields?.map((field) => field.key), `${key}: the pinned field set drives the credential prompt`).toEqual([
        ...fieldKeys,
      ]);
    });

    it(`${key}: every field carries a LABEL and a type — an unnamed box is the defect`, () => {
      // The founding report was never "no data"; it was "no way to know which of three
      // secrets goes in which box". Three fields with blank labels reproduce it exactly.
      for (const field of WELL_KNOWN_PROVIDERS_REGISTRY[key]?.fields ?? []) {
        expect(field.label.length, `${key}.${field.key} must be named for the user`).toBeGreaterThan(0);
        expect(['text', 'secret', 'password', 'url']).toContain(field.type);
      }
    });

    it(`${key}: declares field DEFINITIONS only — never a credential VALUE (C1)`, () => {
      // This registry ships in a public repo. A `value` seat on a field is a published
      // secret, and it is exactly the shape someone adds "to make the demo run".
      for (const field of WELL_KNOWN_PROVIDERS_REGISTRY[key]?.fields ?? []) {
        expect(field).not.toHaveProperty('value');
      }
    });

    it(`${key}: carries a registration WALKTHROUGH with a console URL and steps`, () => {
      const registration = WELL_KNOWN_PROVIDERS_REGISTRY[key]?.registration;
      expect(registration?.consoleUrl, `${key} must name where to get the key`).toBeDefined();
      expect((registration?.instructions ?? []).length, `${key} must walk the user there`).toBeGreaterThan(0);
    });

    it(`${key}: declares NO OAuth endpoints — a static kind has no flow to point at`, () => {
      // The reason P0 widened the type. A placeholder endpoint URL would be UNIONED
      // into the frozen ceiling by `deriveConnectionAllowedHosts`, silently widening
      // the wall the user approved to a host that does not exist. Absent is correct;
      // invented is a security defect.
      //
      // The existence guard is NOT redundant: `undefined?.endpoints` is `undefined`, so
      // without it this assertion would pass on a MISSING entry — a vacuous green over
      // exactly the state the phase exists to change (verified red-first: it was one of
      // nine passing assertions before the guard was added).
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry, `${key} must exist before its posture can be asserted`).toBeDefined();
      expect(entry?.endpoints).toBeUndefined();
    });

    it(`${key}: NEVER carries default scopes (standing registry posture)`, () => {
      // Ported posture, restated per entry because a new entry is exactly where it gets
      // forgotten: default scopes are silent privilege widening. Same existence guard,
      // same reason.
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry, `${key} must exist before its posture can be asserted`).toBeDefined();
      expect(entry?.scopes).toBeUndefined();
    });
  }
});

describe('P4-AC1 — each entry is WELL-FORMED against connectionRequirementSchema', () => {
  for (const { key, displayName, apiHost } of STATIC_KIND_ENTRIES) {
    it(`${key}: its pinned values compose into a requirement that parses`, () => {
      // Builds the requirement the way SUBSTITUTION builds it (`applyRegistryValues`):
      // registry apiHosts → declaredApiHosts, registry registration → registration,
      // registry display name → provider.name. If this shape cannot parse, then a
      // borrow hit produces a requirement that fails its own schema downstream.
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry, `${key} must exist before it can be well-formed`).toBeDefined();

      const parsed = connectionRequirementSchema.safeParse({
        slot: key,
        provider: { name: entry?.displayName ?? displayName },
        kind: 'api_key',
        fields: entry?.fields,
        registration: entry?.registration,
        declaredApiHosts: entry?.apiHosts ?? [apiHost],
      });

      expect(parsed.success, `${key}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    });
  }
});

describe('P4-AC1 — the borrow ban treats the new entries as PINNED (the security half)', () => {
  for (const { key, displayName, apiHost } of STATIC_KIND_ENTRIES) {
    it(`${key}: a starter borrowing the NAME has its declared host replaced, not merged`, () => {
      const result = admitConnectionRequirement(
        {
          slot: 'x',
          provider: { name: displayName },
          kind: 'api_key',
          declaredApiHosts: ['evil.example'],
        },
        { channel: 'starter' },
      );

      expect(result.borrowed, `naming ${displayName} must trigger the ban`).toBe(true);
      expect(result.borrowedFrom).toBe(key);
      const hosts = (result.requirement as { declaredApiHosts: string[] }).declaredApiHosts;
      expect(hosts, 'substitution REPLACES — evil.example must be gone, not appended').not.toContain('evil.example');
      expect(hosts).toContain(apiHost);
    });

    it(`${key}: a lookalike NAME borrowing the real HOST is still caught`, () => {
      // The host trigger is the load-bearing one: the protocol's confusable guard
      // deliberately does not claim to stop pure-ASCII lookalikes (`C0inbase`), so what
      // catches them is that a useful requirement must still name the REAL host.
      const result = admitConnectionRequirement(
        {
          slot: 'x',
          provider: { name: `${displayName.slice(0, 2)}0${displayName.slice(3)}` },
          kind: 'api_key',
          declaredApiHosts: [apiHost],
        },
        { channel: 'starter' },
      );

      expect(result.borrowed, 'the host intersection must fire even under a lookalike name').toBe(true);
      expect(result.borrowedFrom).toBe(key);
      expect((result.requirement as { provider: { name: string } }).provider.name).toBe(displayName);
    });

    it(`${key}: a borrowing starter may NOT author credential-prompt copy — REFUSED`, () => {
      // Guard 2b. Substitution CONFERS legitimacy, so any seat it cannot correct must
      // be refused rather than admitted beside registry-grade hosts. Adding these
      // entries extends that refusal to three new brands — assert it, do not assume it.
      const result = admitConnectionRequirement(
        {
          slot: 'x',
          provider: { name: displayName },
          kind: 'api_key',
          fields: [{ key: 'api_key', label: `Paste your ${displayName} password`, type: 'secret' }],
          declaredApiHosts: [apiHost],
        },
        { channel: 'starter' },
      );

      expect(result.ok, 'attacker-authored field labels beside pinned hosts must be refused').toBe(false);
      expect(result.issues.map((issue) => issue.path)).toContain('fields');
    });

    it(`${key}: the REGISTRY channel itself is exempt — it is the author, not a borrower`, () => {
      // Guarded for the same vacuity reason as the posture assertions above: with no
      // entry, `fields` is undefined, nothing is borrowed, and admission trivially
      // returns ok — a green that says nothing about the exemption.
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry, `${key} must exist before the exemption means anything`).toBeDefined();
      expect(entry?.fields, 'the exemption is only meaningful for an entry that HAS fields').toBeDefined();

      const result = admitConnectionRequirement(
        {
          slot: key,
          provider: { name: displayName },
          kind: 'api_key',
          fields: entry?.fields,
          declaredApiHosts: [apiHost],
        },
        { channel: 'registry' },
      );

      expect(result.ok, 'the registry may author its own field list').toBe(true);
    });
  }
});
