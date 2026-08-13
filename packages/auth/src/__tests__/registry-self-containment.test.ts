// registry-self-containment.test.ts — TASK-20260812-registry-authoritative-auth,
// P0 (AC1's kind table as DATA, AC3 self-containment, AC9 shape rule, D3 alias hygiene).
//
// THE DEFECT THIS PHASE CLOSES, reproduced by execution before any code was written
// (task file §"Spec"): the inferrer's registry rung hardcoded `kind:'oauth2_auth_code'`
// for EVERY hit and never read the entry's `fields`, so an authored Coinbase app got an
// OAuth requirement carrying none of the three credential fields the registry already
// holds. The persisted row then carried the WRONG KIND (admission substitutes fields but
// deliberately never kind — D6), routing an API-key provider to an OAuth connect step
// that cannot succeed.
//
// WHAT "SELF-CONTAINED" MEANS HERE (AC3, scoped to the INFERRER per D6): every registry
// entry must compose — through the ONE emitter the inferrer uses — into a requirement
// that parses against the real `connectionRequirementSchema` and carries EVERYTHING the
// entry holds. A new entry missing a required piece fails in this package, not in front
// of a user.

import { describe, expect, it } from 'vitest';

import { connectionFieldSchema, connectionRequirementSchema } from '@snugprotocol/protocol';

import { admitConnectionRequirement } from '../requirement-admission.js';
import {
  INFERRER_ALIASES,
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
  resolveInferrerAlias,
  WELL_KNOWN_PROVIDERS_REGISTRY,
} from '../well-known-providers.js';

/**
 * AC1 — THE KIND TABLE, owner-decided 2026-08-12 (interview Q1). Every entry, no
 * omissions: a table shorter than the registry is how the next entry ships kindless.
 *
 *  - GitHub is `bearer_token` deliberately: its registry comment argues a PAT IS a
 *    bearer token, and the OAuth `endpoints` stay for requirements that do run the app
 *    flow (D5 — the one entry where kind and endpoints disagree BY DESIGN).
 *  - Apple Music keeps `oauth2_auth_code` — the kind the old hardcode emitted for it —
 *    because its MusicKit token dance fits no v3 kind and its own entry comment says
 *    "authors override". Pinning the status quo is a decision, not an accident
 *    (journaled in the task file; a better kind is a follow-up with its own walkthrough).
 */
const KIND_TABLE = {
  spotify: 'oauth2_auth_code',
  google: 'oauth2_auth_code',
  gmail: 'oauth2_auth_code',
  googledrive: 'oauth2_auth_code',
  slack: 'oauth2_auth_code',
  applemusic: 'oauth2_auth_code',
  github: 'bearer_token',
  coinbase: 'api_key',
  openweather: 'api_key',
  coingecko: 'api_key',
  // MIGRATED 2026-08-13 (TASK-20260812-desktop-auth-awareness P5, ADR-0023): the 11th
  // entry, and the first LAN-class one. `api_key` is the honest kind — the bridge reads
  // a static key from a header; what is unusual about Hue is where the HOST comes from
  // (the user, not the registry) and how the key is MINTED (a pairing exchange), neither
  // of which is a kind.
  hue: 'api_key',
} as const;

describe('AC1 — every registry entry declares its OWN kind (the table is exhaustive)', () => {
  it('the kind table covers exactly the registry — no entry escapes it', () => {
    // Asserted set-equal in BOTH directions: a new entry added without a row here must
    // fail this test, because "the table in the test file" is where the next author
    // learns kinds are mandatory data, not inferrer defaults.
    expect(Object.keys(WELL_KNOWN_PROVIDERS_REGISTRY).sort()).toEqual(Object.keys(KIND_TABLE).sort());
  });

  for (const [key, expectedKind] of Object.entries(KIND_TABLE)) {
    it(`${key}: declares kind '${expectedKind}' on the entry itself`, () => {
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[key]?.kind, `${key} must carry its own kind`).toBe(expectedKind);
    });
  }
});

describe('AC3 — every entry composes through the ONE emitter into a parsing requirement', () => {
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    it(`${key}: requirementFromRegistryEntry output parses against the REAL schema`, () => {
      const built = requirementFromRegistryEntry(entry, key, key);
      const parsed = connectionRequirementSchema.safeParse(built);
      expect(parsed.success, `${key}: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`).toBe(true);
    });

    it(`${key}: the emitted requirement carries EVERYTHING the entry holds`, () => {
      // The founding defect was an emitter that THREW AWAY seats the registry already
      // held. Each seat is asserted present-iff-present, so neither a dropped seat nor
      // an invented one survives.
      const built = requirementFromRegistryEntry(entry, key, key);
      const parsed = connectionRequirementSchema.safeParse(built);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      const requirement = parsed.data;

      expect(requirement.kind, `${key}: the entry's kind, never a hardcode`).toBe(entry.kind);
      expect(requirement.slot).toBe(key);
      expect(requirement.provider.name).toBe(entry.displayName ?? key);
      // THE HOST FORK (MIGRATED 2026-08-13, P5 / ADR-0023 Decision 1). Pinned-host
      // entries are unchanged; a LAN entry emits NO declaredApiHosts (the honest
      // pre-collection shape — the address is the user's to supply) and instead carries
      // its `lanHost` declaration through. Both halves asserted so neither an emitter
      // that invents an address nor one that drops the LAN seat survives.
      if (entry.lanHost !== undefined) {
        expect(requirement.declaredApiHosts, `${key}: a LAN entry must invent no address`).toBeUndefined();
        expect(requirement.lanHost, `${key}: the LAN seat must ride through`).toEqual(entry.lanHost);
      } else {
        expect(requirement.declaredApiHosts).toEqual([...entry.apiHosts!]);
        expect(requirement.lanHost, `${key}: a pinned-host entry declares no LAN seat`).toBeUndefined();
      }

      if (entry.fields !== undefined) {
        expect(requirement.fields, `${key}: pinned fields must arrive verbatim (AC2)`).toEqual(entry.fields);
      } else {
        // No invented inputs: an entry with no field list emits none.
        expect(requirement.fields).toBeUndefined();
      }
      if (entry.endpoints !== undefined) {
        expect(requirement.endpoints).toEqual(entry.endpoints);
      } else {
        expect(requirement.endpoints).toBeUndefined();
      }
      if (entry.registration !== undefined) {
        expect(requirement.registration).toEqual(entry.registration);
      } else {
        expect(requirement.registration).toBeUndefined();
      }
      if (entry.authorizeParams !== undefined) {
        expect(requirement.authorizeParams).toEqual(entry.authorizeParams);
      } else {
        expect(requirement.authorizeParams).toBeUndefined();
      }
      // The ADR-0022 §1 seats ride through like every other flow seat — present iff
      // the entry pins them, never invented (TASK-20260812-desktop-auth-awareness P3).
      if (entry.request !== undefined) {
        expect(requirement.request, `${key}: the pinned request template must arrive verbatim`).toEqual(entry.request);
      } else {
        expect(requirement.request).toBeUndefined();
      }
      if (entry.testRequest !== undefined) {
        expect(requirement.testRequest, `${key}: the pinned probe must arrive verbatim`).toEqual(entry.testRequest);
      } else {
        expect(requirement.testRequest).toBeUndefined();
      }
      if (entry.pkce !== undefined) {
        expect(requirement.pkce).toBe(entry.pkce);
      } else {
        expect(requirement.pkce).toBeUndefined();
      }
      // Standing posture: scopes are never emitted (default scopes are silent privilege
      // widening), and no entry may carry them in the first place.
      expect(requirement.scopes).toBeUndefined();
    });

    it(`${key}: the emitter hands out COPIES, never live registry references`, () => {
      // The registry is a module singleton the borrow ban consults on every admission;
      // a caller mutating an emitted requirement must not repoint the pinned truth.
      const built = requirementFromRegistryEntry(entry, key, key) as Record<string, unknown>;
      if (entry.fields !== undefined) {
        expect(built['fields']).not.toBe(entry.fields);
        expect((built['fields'] as unknown[])[0]).not.toBe(entry.fields[0]);
      }
      // Same fork: a LAN entry has no host array to copy, so the copy fence moves to the
      // seat it DOES hand out (MIGRATED 2026-08-13, P5). Without this branch the whole
      // -registry copy fence would go vacuous on LAN entries — the exact way the
      // queryTemplate copy fence silently stopped covering the registry at P4.
      if (entry.lanHost !== undefined) {
        expect(built['lanHost'], `${key}: the LAN seat must be a COPY`).not.toBe(entry.lanHost);
        expect(built['lanHost']).toEqual(entry.lanHost);
      } else {
        expect(built['declaredApiHosts']).not.toBe(entry.apiHosts);
      }
      if (entry.endpoints !== undefined) expect(built['endpoints']).not.toBe(entry.endpoints);
      if (entry.registration !== undefined) expect(built['registration']).not.toBe(entry.registration);
      if (entry.request !== undefined) {
        expect(built['request']).not.toBe(entry.request);
        // BOTH template seats, not just the header one. P4 (2026-08-13): openweather and
        // coingecko are the first entries whose `request` carries ONLY a queryTemplate,
        // and this assertion previously skipped them entirely — a whole-registry copy
        // fence that stopped covering the whole registry the moment the data arrived.
        // A live query-template reference is the same defect as a live header one: the
        // caller repoints where a credential is sent, for every future admission.
        if (entry.request.headerTemplate !== undefined) {
          expect((built['request'] as { headerTemplate?: unknown }).headerTemplate).not.toBe(
            entry.request.headerTemplate,
          );
        }
        if (entry.request.queryTemplate !== undefined) {
          expect((built['request'] as { queryTemplate?: unknown }).queryTemplate).not.toBe(
            entry.request.queryTemplate,
          );
        }
      }
      if (entry.testRequest !== undefined) expect(built['testRequest']).not.toBe(entry.testRequest);
    });
  }
});

describe('AC9 — field definitions carry EXACTLY connectionFieldSchema seats (shape rule)', () => {
  // "No credential-shaped value" has no testable definition (review MINOR 9), so the
  // rule is structural: every field parses against the strict per-field schema, which
  // rejects any extra seat — including the `value` someone adds "to make the demo run".
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    if (entry.fields === undefined) continue;
    it(`${key}: every pinned field parses against connectionFieldSchema (strict)`, () => {
      for (const field of entry.fields ?? []) {
        const parsed = connectionFieldSchema.safeParse(field);
        expect(parsed.success, `${key}.${field.key}: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`).toBe(
          true,
        );
      }
    });
  }
});

/**
 * TASK-20260812-auth-kind-choice P0 — MULTI-OPTION entries (AC1/AC2).
 *
 * Some providers genuinely offer more than one way in (owner repro 2026-08-12:
 * Coinbase has an API-key surface AND retail OAuth). The TOP-LEVEL entry stays the
 * DEFAULT option (D1 — every existing consumer keeps reading it unchanged);
 * `authOptions` lists ALTERNATE options, each a COMPLETE credential flow. The card
 * renders `optionLabel` for the default and each option's `label`, so both seats are
 * required the moment an entry goes multi-option.
 */
const MULTI_OPTION_ENTRIES = {
  coinbase: { defaultKind: 'api_key', optionKinds: ['oauth2_auth_code'] },
  github: { defaultKind: 'bearer_token', optionKinds: ['oauth2_auth_code'] },
} as const;

describe('AC1 — multi-option entries: every option is a COMPLETE, parsing credential flow', () => {
  it('exactly coinbase and github carry authOptions in this task (AC2: everyone else is single-option)', () => {
    const multi = Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)
      .filter(([, entry]) => (entry.authOptions ?? []).length > 0)
      .map(([key]) => key)
      .sort();
    expect(multi).toEqual(Object.keys(MULTI_OPTION_ENTRIES).sort());
  });

  for (const [key, expected] of Object.entries(MULTI_OPTION_ENTRIES)) {
    it(`${key}: default kind stays '${expected.defaultKind}' and options carry ${JSON.stringify(expected.optionKinds)}`, () => {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry?.kind).toBe(expected.defaultKind);
      expect((entry?.authOptions ?? []).map((option) => option.kind)).toEqual([...expected.optionKinds]);
    });

    it(`${key}: the default and every option carry human labels for the card`, () => {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry?.optionLabel, `${key} needs a label for its DEFAULT option`).toBeTruthy();
      for (const option of entry?.authOptions ?? []) {
        expect(option.label.length, `${key}.${option.id} must be named for the user`).toBeGreaterThan(0);
      }
    });

    it(`${key}: option ids are unique and pre-normalized`, () => {
      const ids = (WELL_KNOWN_PROVIDERS_REGISTRY[key]?.authOptions ?? []).map((option) => option.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
    });

    it(`${key}: every OPTION composes through the emitter into a requirement that parses (AC1)`, () => {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key]!;
      for (const option of entry.authOptions ?? []) {
        const built = requirementFromRegistryEntry(entry, key, key, option);
        const parsed = connectionRequirementSchema.safeParse(built);
        expect(parsed.success, `${key}.${option.id}: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`).toBe(
          true,
        );
        if (!parsed.success) continue;
        // The option is COMPLETE: its credential-flow seats, the ENTRY's identity seats.
        expect(parsed.data.kind).toBe(option.kind);
        expect(parsed.data.provider.name).toBe(entry.displayName ?? key);
        // `!` since P5 widened the seat (apiHosts XOR lanHost). This loop only runs for
        // entries with authOptions, and a LAN entry declares none — pinned-host by
        // construction, premise stated rather than chained past.
        expect(entry.apiHosts, `${key}: an entry with authOptions pins hosts`).toBeDefined();
        expect(parsed.data.declaredApiHosts).toEqual([...entry.apiHosts!]);
        if (option.fields !== undefined) expect(parsed.data.fields).toEqual(option.fields);
        if (option.endpoints !== undefined) expect(parsed.data.endpoints).toEqual(option.endpoints);
        if (option.registration !== undefined) expect(parsed.data.registration).toEqual(option.registration);
      }
    });

    it(`${key}: option fields obey the shape rule (AC10/C1 — strict connectionFieldSchema, no values)`, () => {
      for (const option of WELL_KNOWN_PROVIDERS_REGISTRY[key]?.authOptions ?? []) {
        for (const field of option.fields ?? []) {
          const parsed = connectionFieldSchema.safeParse(field);
          expect(parsed.success, `${key}.${option.id}.${field.key}`).toBe(true);
        }
      }
    });

    it(`${key}: options never carry scopes (standing posture) or apiHosts (identity is the ENTRY's)`, () => {
      for (const option of WELL_KNOWN_PROVIDERS_REGISTRY[key]?.authOptions ?? []) {
        const raw = option as unknown as Record<string, unknown>;
        expect(raw['scopes']).toBeUndefined();
        expect(raw['apiHosts']).toBeUndefined();
      }
    });
  }

  it('AC2 — the emitter WITHOUT an option argument still emits the default, byte-identical', () => {
    // The parent suites above already pin the default emission per entry; this pins
    // that adding the option parameter changed nothing when it is absent.
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;
    expect(requirementFromRegistryEntry(entry, 'coinbase', 'coinbase')).toEqual(
      requirementFromRegistryEntry(entry, 'coinbase', 'coinbase', undefined),
    );
    const parsed = connectionRequirementSchema.safeParse(requirementFromRegistryEntry(entry, 'coinbase', 'coinbase'));
    expect(parsed.success && parsed.data.kind).toBe('api_key');
  });
});

describe('D3 — the inferrer alias map: human-authored, collision-free, and NOT resolution', () => {
  it('every alias resolves to an EXISTING registry key', () => {
    for (const [alias, key] of Object.entries(INFERRER_ALIASES)) {
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[key], `alias '${alias}' points at missing entry '${key}'`).toBeDefined();
    }
  });

  it('no alias shadows a registry key (a shadow would silently re-route an exact hit)', () => {
    for (const alias of Object.keys(INFERRER_ALIASES)) {
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[alias], `alias '${alias}' collides with a registry key`).toBeUndefined();
    }
  });

  it('aliases are stored pre-normalized, so authoring typos fail here and not at lookup', () => {
    for (const alias of Object.keys(INFERRER_ALIASES)) {
      expect(alias).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("the owner-named near-miss 'Coinbase Pro' resolves for AUTHORING", () => {
    expect(resolveInferrerAlias('Coinbase Pro')?.key).toBe('coinbase');
    expect(resolveInferrerAlias('coinbase pro')?.key).toBe('coinbase');
  });

  it('AC6 — unrecognized lookalikes do NOT match and will fall through to inference', () => {
    // Pins ADR-0017's accepted ASCII-lookalike posture rather than reopening it: alias
    // resolution is exact after normalization, never fuzzy.
    expect(resolveInferrerAlias('Cooinbase')).toBeUndefined();
    expect(resolveInferrerAlias('Sp0tify')).toBeUndefined();
  });

  it('AC10 / D6 — admission substitutes fields but NOT kind: the split-brain is PINNED, not latent', () => {
    // NAMED BEHAVIOR, deliberately kept (D6): the registry is kind-authoritative in the
    // INFERRER, while `applyRegistryValues` stays kind-AGNOSTIC — changing a security
    // guard's contract belongs in its own task with its own ADR. Consequence this test
    // documents: a borrowing declaration keeps its own `oauth2_auth_code` kind while
    // receiving Coinbase's api_key field set, so `generateAuthUrl` would demand a
    // client_id that no longer exists. QUEUED FOLLOW-UP in the task file; when admission
    // one day substitutes kind too, this test goes red ON PURPOSE so the change is made
    // knowingly.
    const result = admitConnectionRequirement(
      {
        slot: 'x',
        provider: { name: 'Coinbase' },
        kind: 'oauth2_auth_code',
        declaredApiHosts: ['evil.example'],
      },
      { channel: 'starter' },
    );
    expect(result.ok).toBe(true);
    expect(result.borrowed).toBe(true);
    const substituted = result.requirement as { kind: string; fields?: Array<{ key: string }> };
    expect(substituted.kind, 'admission leaves the borrower\'s kind alone (kind-agnostic ban)').toBe(
      'oauth2_auth_code',
    );
    // MIGRATED 2026-08-13 (P3 Coinbase CDP rewrite): the substituted list is the CDP
    // pair — the old api_secret/passphrase seats described expired HMAC keys.
    expect(substituted.fields?.map((field) => field.key), 'while the FIELD list is substituted').toEqual([
      'api_key',
      'private_key',
    ]);
  });

  it('D3 boundary — lookupWellKnownProvider is UNTOUCHED by aliases (the RESOLUTION path)', () => {
    // The reviewed BLOCKER 1: aliasing the resolution path would hand "Coinbase Pro" the
    // real Coinbase's pinned hosts AND its registration walkthrough with wizard-grade
    // legitimacy, at every one of that function's call sites. The alias map is consulted
    // by the inferrer's rung 1 ONLY.
    expect(lookupWellKnownProvider('Coinbase Pro')).toBeUndefined();
    expect(lookupWellKnownProvider('Google Mail')).toBeUndefined();
  });
});
