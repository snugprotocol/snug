// TASK-20260812-desktop-auth-awareness P5 (ADR-0023, P0 round-2 amendment 10
// "lan-admission-clobber"): the LAN-class registry fork — the `hue` entry, and the three
// admission behaviors an apiHosts-less entry demands.
//
// ALL THREE PARTS WERE PROBE-VERIFIED AS BLOCKING BEFORE ANY CODE MOVED (2026-08-13,
// against the built dist with a hue-shaped entry injected at runtime):
//
//   (a) `registryHostIndex` iterates EVERY entry's `apiHosts` unconditionally, so ONE
//       apiHosts-less entry makes EVERY admission of ANY requirement throw
//       `TypeError: entry.apiHosts is not iterable` — on the path whose entire job is to
//       fail CLOSED. Probe output: "PROBE-A: THREW -> TypeError". Not a Hue bug: the
//       first LAN entry breaks Spotify, Coinbase and every starter in the product.
//
//   (b) With (a) patched in the probe, `applyRegistryValues` REPLACED the user's
//       declared `['192.168.1.50']` with `[...entry.apiHosts]` — i.e. `[]`. Probe output:
//       "PROBE-B: ok= true hosts= []". The user types their bridge address, the borrow
//       ban silently deletes it, and the ceiling freezes around nothing. This is the
//       exact AC7 chain, and it fails SILENTLY (ok:true) — the worst shape.
//
//   (c) Nothing re-validated the host class at admission, so `192.168.1.50` and
//       `evil.example` were equally acceptable under the hue brand once (b) preserved
//       declared hosts. The schema refuses that shape, but admission reads DEFENSIVELY
//       at the envelope boundary (C5) and must never assume it ran.
//
// ADR-0020's "hosts are ALWAYS the entry's on every option path" invariant gains a
// carve-out here, and it is scoped to lanHost entries ONLY — pinned below by a test that
// a NORMAL entry still substitutes its pinned hosts over a declared one.

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_LAN_HOST_CLASSES,
  connectionRequirementSchema,
  isRfc1918Ipv4Literal,
} from '@snugprotocol/protocol';

import { isPrivateRfc1918Ipv4Literal } from '../net-guards.js';
import { admitConnectionRequirement } from '../requirement-admission.js';
import {
  INFERRER_ALIASES,
  WELL_KNOWN_PROVIDERS_REGISTRY,
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
  resolveInferrerAlias,
} from '../well-known-providers.js';

const BRIDGE_IP = '192.168.1.50';

/** A bare LAN borrower: names the brand, declares the user's address, authors nothing. */
const hueBorrower = (declaredApiHosts?: string[]): Record<string, unknown> => ({
  slot: 'lights',
  provider: { name: 'Philips Hue' },
  kind: 'api_key',
  ...(declaredApiHosts !== undefined ? { declaredApiHosts } : {}),
});

describe('P5/AC7 — the `hue` registry entry (the 11th, and the first LAN-class one)', () => {
  it('exists under its own key and is api_key', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['hue'];
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe('Philips Hue');
    expect(entry?.kind).toBe('api_key');
    // EXACT-key resolution, per `lookupWellKnownProvider`'s own contract. The registry
    // key is `hue` (the pinned literal), so `Hue` resolves and `Philips Hue` does NOT —
    // which is deliberate: resolution must not hand a brand-adjacent declaration this
    // entry's pinned values as if it had asked for them. The next two tests pin the two
    // paths that DO reach the entry from the human spelling.
    expect(lookupWellKnownProvider('Hue')?.displayName).toBe('Philips Hue');
    expect(lookupWellKnownProvider('Philips Hue')).toBeUndefined();
  });

  it('the human spellings reach the entry through the BAN path (brand-adjacency), not through resolution', () => {
    // This is the path that matters for safety: a requirement naming "Philips Hue" or
    // "Hue Bridge" must be caught by the borrow ban even though exact-key lookup misses.
    for (const name of ['Philips Hue', 'Hue Bridge', 'PhilipsHue', 'Hue Lights']) {
      const result = admitConnectionRequirement(
        { slot: 'lights', provider: { name }, kind: 'api_key', declaredApiHosts: [BRIDGE_IP] },
        { channel: 'inference' },
      );
      expect(result.borrowed, `"${name}" evaded the borrow ban`).toBe(true);
      expect(result.borrowedFrom, name).toBe('hue');
    }
  });

  it('the ALIASES route the human spellings to this entry for the INFERRER (authoring scope only)', () => {
    for (const name of ['Philips Hue', 'Hue Bridge']) {
      expect(resolveInferrerAlias(name)?.key, name).toBe('hue');
    }
    // The alias map may never shadow a registry key (a shadow silently re-routes an
    // exact hit) — the whole-registry rule lives in registry-self-containment; asserted
    // here for the two aliases this entry adds.
    expect(Object.keys(INFERRER_ALIASES)).toEqual(expect.arrayContaining(['philipshue', 'huebridge']));
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['philipshue']).toBeUndefined();
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['huebridge']).toBeUndefined();
  });

  it('declares lanHost and NO apiHosts — the XOR, on the registry side', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['hue'];
    expect(entry?.lanHost).toEqual({ class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' });
    expect(entry?.apiHosts, 'a bridge address is the USER\'s — no entry can pin it').toBeUndefined();
  });

  it('pins EXACTLY its one credential field, and it is a SECRET', () => {
    const fields = WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.fields;
    expect(fields?.map((field) => field.key)).toEqual(['application_key']);
    expect(fields?.[0]?.type).toBe('secret');
  });

  it("the application_key field copy is HONEST: the key is MINTED by pairing, never typed", () => {
    // The field exists so the wizard has a named secret slot and the template has a key
    // to reference — NOT so the user pastes something. Copy that said "paste your
    // application key" would send the user hunting for a value no Hue surface displays.
    const field = WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.fields?.[0];
    const copy = `${field?.label ?? ''} ${field?.description ?? ''}`.toLowerCase();
    expect(copy).toMatch(/link button|pairing|created for you|minted|automatically/);
    expect(copy, 'nothing here may instruct the user to paste or type this value').not.toMatch(
      /\bpaste\b|\btype (it|this)\b|\benter (it|this)\b|copy the (application )?key/,
    );
  });

  it('pins the CLIP v2 header template referencing its own declared field key', () => {
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.request).toEqual({
      headerTemplate: { 'hue-application-key': '{{application_key}}' },
    });
  });

  it('carries a provider-AGNOSTIC pairing seat describing the exchange (ADR-0023 D2)', () => {
    const pairing = WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.pairing;
    expect(pairing).toBeDefined();
    // The seat is a DISCRIMINATED union since ADR-0032 (`device-link` joined it). Hue is
    // the `exchange` member; narrowing here is what makes the exchange-only reads below
    // legal, and it states which variant this test is about instead of assuming.
    if (pairing?.kind !== 'exchange') throw new Error('hue must remain an exchange pairing');
    expect(pairing?.method).toBe('POST');
    expect(pairing?.pathAndQuery).toBe('/api');
    expect(pairing?.body).toEqual({ devicetype: 'snug#hub', generateclientkey: true });
    expect(pairing?.secretField).toBe('application_key');
    // The precondition copy is what the wizard renders BEFORE it fires the request.
    expect(pairing?.preconditionInstruction.toLowerCase()).toContain('link button');
    expect(pairing?.preconditionInstruction).toMatch(/30|thirty/);
  });

  /**
   * THE SECRET PATH, ASSERTED BY WALKING IT (MIGRATED from a value pin — lesson
   * 2026-08-04, and the reason the migration was needed rather than a preference).
   *
   * The old form was `expect(pairing?.secretPath).toEqual(['success', 0, 'username'])`:
   * a value pin that compared the registry's array to a retyped copy of itself. It
   * was GREEN against a path that resolves to `undefined` on every real bridge
   * response, because it never walked one. A CLIP v1 pairing answer is an ARRAY of
   * result objects, outermost, so the index comes first — the P5-flow lane found
   * this when the wizard's pairing step, driven end to end, produced no key against
   * a response shaped exactly like the desktop lane's own fixture.
   *
   * The claim the old test MEANT to make survives verbatim ("the seat names where
   * the minted key lives"); it is now made against a real response body, so a path
   * that cannot find the key fails here instead of in front of a user standing at
   * their bridge with the button pressed.
   */
  it('the pairing secretPath actually FINDS the key in a real CLIP v1 response', () => {
    const pairing = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!.pairing!;
    if (pairing.kind !== 'exchange') throw new Error('hue must remain an exchange pairing');
    // The bridge's real answer shape (developers.meethue.com getting-started).
    const response: unknown = [{ success: { username: 'MINTED-KEY-VALUE', clientkey: 'ENTERTAINMENT' } }];
    let cursor: unknown = response;
    for (const step of pairing.secretPath) {
      if (typeof step === 'number') {
        expect(Array.isArray(cursor), `step ${String(step)} indexes something that is not an array`).toBe(true);
        cursor = (cursor as unknown[])[step];
        continue;
      }
      expect(typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor)).toBe(true);
      cursor = (cursor as Record<string, unknown>)[step];
    }
    expect(cursor).toBe('MINTED-KEY-VALUE');
  });

  it('the pairing secretPath does NOT find the Entertainment clientkey (unused at v1)', () => {
    // A path that landed one level up would hand the wizard the whole `success`
    // object and, through it, a second secret the design deliberately does not keep.
    const pairing = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!.pairing!;
    if (pairing.kind !== 'exchange') throw new Error('hue must remain an exchange pairing');
    expect(pairing.secretPath[pairing.secretPath.length - 1]).toBe('username');
  });

  it('the pairing seat names a field the entry actually declares (no dangling secret slot)', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!;
    const keys = (entry.fields ?? []).map((field) => field.key);
    // Narrow before reading: `secretField` belongs to the exchange/device-link members,
    // not the whole (now three-member) union.
    if (entry.pairing?.kind !== 'exchange') throw new Error('hue must remain an exchange pairing');
    expect(keys).toContain(entry.pairing.secretField);
  });

  it('browserCallable:false — a bridge cert and a private IP are not browser-reachable', () => {
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.browserCallable).toBe(false);
  });

  it('carries a grandma-grade registration walkthrough naming the address, the button and the window', () => {
    const registration = WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.registration;
    expect(registration?.instructions?.length ?? 0).toBeGreaterThanOrEqual(3);
    const all = (registration?.instructions ?? []).join(' ').toLowerCase();
    expect(all, 'the user must be told how to find the bridge address').toMatch(/ip address|bridge address/);
    expect(all, 'the link button is the whole precondition').toContain('link button');
    expect(all, 'the 30-second window is why the order of steps matters').toMatch(/30 seconds|thirty seconds/);
  });

  it('NO desktopRedirectPosture — a static kind runs no OAuth redirect at all', () => {
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.desktopRedirectPosture).toBeUndefined();
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.endpoints).toBeUndefined();
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.scopes).toBeUndefined();
  });

  it('composes through the ONE emitter into a PRE-COLLECTION requirement that parses', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!;
    const built = requirementFromRegistryEntry(entry, 'hue', 'lights');
    const parsed = connectionRequirementSchema.safeParse(built);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.lanHost).toEqual({ class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' });
    expect(parsed.data.declaredApiHosts, 'the emitter invents no address').toBeUndefined();
    expect(parsed.data.request).toEqual({ headerTemplate: { 'hue-application-key': '{{application_key}}' } });
  });

  it('the emitter DEEP-COPIES lanHost — the registry singleton stays unrepointable', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!;
    const built = requirementFromRegistryEntry(entry, 'hue', 'lights');
    expect(built.lanHost).not.toBe(entry.lanHost);
    expect(built.lanHost).toEqual(entry.lanHost);
  });

  it('NO testRequest — every CLIP v2 read needs the key the PAIRING step mints, so a probe before pairing is meaningless', () => {
    // Same discipline as coingecko's deliberate omission (P4): no button beats a
    // meaningless one. No PRE-pair probe can succeed, and no user-facing test button is
    // offered. Verification itself moved INSIDE the pairing act as its mandatory final
    // step (ADR-0025 — the `verify` seat below); this omission is about the seats it
    // was always about.
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.testRequest).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The verify seat (ADR-0025) — pairing must PROVE the key it minted
  // -------------------------------------------------------------------------

  it('carries a REQUIRED verify seat: a credentialed read the wizard fires before claiming connected (ADR-0025)', () => {
    const verify = WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.pairing?.verify;
    expect(verify, 'a pairing exchange that cannot be verified post-mint re-creates the instant-connected defect').toBeDefined();
    // GET only: the verify read must be side-effect-free on the device — it proves the
    // key, it never exercises it.
    expect(verify?.method).toBe('GET');
    // CLIP v2's bridge resource: the one read every bridge serves, and it requires the
    // `hue-application-key` header — an unauthenticated 200 cannot fake it.
    expect(verify?.pathAndQuery).toBe('/clip/v2/resource/bridge');
  });

  it('the verify path is a PATH on the ceiling host — leading slash, never a URL, never a host', () => {
    const verify = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!.pairing!.verify;
    expect(verify.pathAndQuery.startsWith('/')).toBe(true);
    expect(verify.pathAndQuery).not.toMatch(/^[a-z]+:\/\//i);
    expect(verify.pathAndQuery).not.toContain('://');
  });

  it('the verify credential rides the entry\'s OWN header template — no second injection vocabulary', () => {
    // The wizard renders `request.headerTemplate` with only the pairing secretField's
    // just-minted value; this pins that the template actually references that field, so
    // the verify read is credentialed by construction rather than by a parallel seat.
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!;
    const template = JSON.stringify(entry.request?.headerTemplate ?? {});
    if (entry.pairing?.kind !== 'exchange') throw new Error('hue must remain an exchange pairing');
    expect(template).toContain(`{{${entry.pairing.secretField}}}`);
  });
});

describe('P5 amendment 10(a) — one apiHosts-less entry must not break EVERY admission (probe: TypeError)', () => {
  it('a NON-hue requirement is admitted normally with the hue entry present — the crash case', () => {
    // THE PROBE THIS PINS: before the fix, this exact call threw
    // `TypeError: entry.apiHosts is not iterable` from `registryHostIndex`, for a
    // requirement that has nothing to do with Hue. The guard's fail-closed path became
    // an availability bug for the whole product.
    expect(() =>
      admitConnectionRequirement(
        { slot: 'x', provider: { name: 'Some Obscure SaaS' }, kind: 'api_key', declaredApiHosts: ['example.com'] },
        { channel: 'inference' },
      ),
    ).not.toThrow();
    const result = admitConnectionRequirement(
      { slot: 'x', provider: { name: 'Some Obscure SaaS' }, kind: 'api_key', declaredApiHosts: ['example.com'] },
      { channel: 'inference' },
    );
    expect(result.ok).toBe(true);
    expect(result.borrowed).toBeUndefined();
  });

  it('every registry brand still borrows normally with the hue entry present (the whole registry, not a sample)', () => {
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      if (entry.lanHost !== undefined) continue; // LAN entries have their own suite below
      const result = admitConnectionRequirement(
        { slot: 's', provider: { name: entry.displayName ?? key }, kind: entry.kind, declaredApiHosts: ['evil.example'] },
        { channel: 'inference' },
      );
      expect(result.borrowed, `${key}: the ban must still fire`).toBe(true);
      expect(result.borrowedFrom, key).toBe(key);
    }
  });

  it('the HOST trigger never resolves to a LAN entry — a private IP is not a registry brand', () => {
    // A LAN entry pins no hosts, so it contributes nothing to the host index. An
    // unrelated declaration of a private IP must therefore NOT be pulled under the hue
    // brand: the user's own printer at 192.168.1.50 is not a Hue bridge.
    const result = admitConnectionRequirement(
      { slot: 'printer', provider: { name: 'Some Device' }, kind: 'api_key', declaredApiHosts: [BRIDGE_IP] },
      { channel: 'inference' },
    );
    expect(result.borrowed, 'a private literal must not borrow the hue brand by host').toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('the lanHost SKIP is what enforces that, not merely the absence of hosts — proven by mutating the registry', () => {
    // MUTATION-DRIVEN, and it exists because of what the mutation run actually showed:
    // deleting `if (entry.lanHost !== undefined) continue;` from `registryHostIndex`
    // killed NOTHING, because the null-safe `?? []` beside it already handled today's
    // hue entry (which happens to carry no hosts at all). A guard that survives its own
    // deletion is decoration (lesson 2026-08-04: assert the OUTCOME), so this drives the
    // skip DIRECTLY: a LAN entry that ALSO carried apiHosts — the shape the structural
    // XOR rule forbids, and therefore the shape a future data edit could introduce by
    // mistake — must still contribute NO host trigger, because a collected LAN address
    // identifies one device on one network and never a provider.
    const registry = WELL_KNOWN_PROVIDERS_REGISTRY as Record<string, unknown>;
    const original = registry['hue'];
    try {
      registry['hue'] = { ...(original as object), apiHosts: ['device.example'] };
      const result = admitConnectionRequirement(
        {
          slot: 'x',
          provider: { name: 'Totally Unrelated App' },
          kind: 'api_key',
          declaredApiHosts: ['device.example'],
        },
        { channel: 'inference' },
      );
      expect(
        result.borrowed,
        'a LAN entry must contribute NO host trigger even when it carries apiHosts — the skip, not the absence, is the guard',
      ).toBeUndefined();
    } finally {
      registry['hue'] = original;
    }
  });
});

describe('P5 amendment 10(b) — a hue borrow PRESERVES the user-collected bridge IP (probe: wiped to [])', () => {
  it("keeps the user's declared bridge address instead of substituting the entry's (absent) hosts", () => {
    // THE PROBE THIS PINS: before the fix, `applyRegistryValues` wrote
    // `declaredApiHosts: [...entry.apiHosts]` unconditionally — `[]` for a LAN entry —
    // so the address the user typed was silently deleted and the ceiling froze around
    // nothing, with ok:true. The silent shape is the dangerous one.
    const result = admitConnectionRequirement(hueBorrower([BRIDGE_IP]), { channel: 'starter' });
    expect(result.ok).toBe(true);
    expect(result.borrowed).toBe(true);
    expect(result.borrowedFrom).toBe('hue');
    const admitted = result.requirement as Record<string, unknown>;
    expect(admitted['declaredApiHosts']).toEqual([BRIDGE_IP]);
  });

  it('substitutes everything ELSE the entry pins — the carve-out is hosts, and only hosts', () => {
    const result = admitConnectionRequirement(hueBorrower([BRIDGE_IP]), { channel: 'starter' });
    const admitted = result.requirement as Record<string, unknown>;
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['hue']!;
    expect((admitted['provider'] as Record<string, unknown>)['name']).toBe('Philips Hue');
    expect(admitted['fields']).toEqual(entry.fields);
    expect(admitted['request']).toEqual(entry.request);
    expect(admitted['registration']).toEqual(entry.registration);
    expect(admitted['lanHost'], 'the LAN seat itself is pinned registry data too').toEqual(entry.lanHost);
  });

  it('a PRE-COLLECTION hue borrow (no declared host) stays hostless — no address is invented', () => {
    const result = admitConnectionRequirement(hueBorrower(), { channel: 'starter' });
    expect(result.ok).toBe(true);
    const admitted = result.requirement as Record<string, unknown>;
    expect(admitted['declaredApiHosts'], 'admission must not conjure a bridge address').toBeUndefined();
  });

  it('the admitted post-collection shape PARSES — the fork survives its own schema', () => {
    const result = admitConnectionRequirement(
      { ...hueBorrower([BRIDGE_IP]), slot: 'lights' },
      { channel: 'starter' },
    );
    const parsed = connectionRequirementSchema.safeParse(result.requirement);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
  });

  it('ADR-0020 CARVE-OUT IS SCOPED: a NORMAL entry still substitutes its pinned hosts over the declared ones', () => {
    // The load-bearing negative. If the fork were written as "preserve declared hosts"
    // rather than "preserve declared hosts FOR LAN ENTRIES", the borrow ban's core
    // property — evil.example is GONE, not appended — would be dead for every provider.
    const result = admitConnectionRequirement(
      { slot: 's', provider: { name: 'Spotify' }, kind: 'api_key', declaredApiHosts: ['evil.example'] },
      { channel: 'inference' },
    );
    const admitted = result.requirement as Record<string, unknown>;
    expect(admitted['declaredApiHosts']).toEqual(['api.spotify.com']);
    expect(admitted['declaredApiHosts']).not.toContain('evil.example');
  });
});

describe('P5 amendment 10(c) — admission RE-VALIDATES the host class (a borrower may not smuggle a public host under the hue brand)', () => {
  it('REFUSES hue + a public declared host', () => {
    const result = admitConnectionRequirement(hueBorrower(['api.meethue.com']), { channel: 'starter' });
    expect(result.ok, 'a public host under a LAN brand is the smuggle this refuses').toBe(false);
    expect(result.issues.some((issue) => issue.path === 'declaredApiHosts')).toBe(true);
  });

  it('REFUSES hue + an attacker host, on EVERY borrowing channel', () => {
    for (const channel of ['inference', 'user_docs', 'starter', 'user'] as const) {
      const result = admitConnectionRequirement(hueBorrower(['evil.example']), { channel });
      expect(result.ok, `channel '${channel}' admitted a public host under the hue brand`).toBe(false);
    }
  });

  it('REFUSES the off-class literals the class deliberately excludes (loopback, link-local, CGN, IPv6)', () => {
    for (const host of ['127.0.0.1', '169.254.1.1', '100.64.0.1', '172.15.0.1', '::1', 'fc00::1']) {
      const result = admitConnectionRequirement(hueBorrower([host]), { channel: 'starter' });
      expect(result.ok, `${host} is not in the rfc1918-ipv4-literal class`).toBe(false);
    }
  });

  it('REFUSES a private literal PLUS a public host — the mixed form with cover', () => {
    const result = admitConnectionRequirement(hueBorrower([BRIDGE_IP, 'evil.example']), { channel: 'starter' });
    expect(result.ok).toBe(false);
  });

  it('REFUSES two private literals — one seat, one device', () => {
    expect(admitConnectionRequirement(hueBorrower([BRIDGE_IP, '192.168.1.51']), { channel: 'starter' }).ok).toBe(false);
  });

  it('ACCEPTS every in-class range (the guard is not accidentally 192.168-only)', () => {
    for (const host of ['10.0.0.7', '172.16.5.9', '172.31.255.254', '192.168.1.50']) {
      const result = admitConnectionRequirement(hueBorrower([host]), { channel: 'starter' });
      expect(result.ok, `${host} is a legitimate bridge address`).toBe(true);
      expect((result.requirement as Record<string, unknown>)['declaredApiHosts']).toEqual([host]);
    }
  });

  it('the REGISTRY channel is NOT exempt from the class check — this is a host rule, not prompt copy', () => {
    // Guard 2b exempts `registry` because that channel is the legitimate AUTHOR of
    // credential-prompt copy. The host class is a different question: a public host
    // inside a LAN ceiling is wrong no matter who wrote it, and the registry channel is
    // exactly where a re-substitution pass lands (the P3 seat-drift migration).
    expect(admitConnectionRequirement(hueBorrower(['evil.example']), { channel: 'registry' }).ok).toBe(false);
  });

  it('REFUSES a brand-ADJACENT LAN borrow with a public host ("Philips Hue Bridge" + evil.example)', () => {
    const result = admitConnectionRequirement(
      { slot: 'lights', provider: { name: 'Philips Hue Bridge' }, kind: 'api_key', declaredApiHosts: ['evil.example'] },
      { channel: 'inference' },
    );
    expect(result.borrowed, 'the brand-adjacent trigger must reach the LAN entry too').toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe('P5 — the two RFC-1918 validators are pinned EQUIVALENT across the package boundary', () => {
  it('protocol.isRfc1918Ipv4Literal and auth.isPrivateRfc1918Ipv4Literal agree on every case', () => {
    // WHY THIS TEST EXISTS: protocol cannot import packages/auth (auth depends on
    // protocol — it would be a cycle), so the class is RESTATED there. Two guards that
    // disagree about the same word is the founding-defect shape (lesson 2026-08-10), so
    // the equivalence is asserted rather than assumed.
    const cases = [
      '10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.1.50',
      '127.0.0.1', '169.254.1.1', '100.64.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '0.0.0.0',
      '255.255.255.255', '192.168.1', '192.168.1.256', '192.168.1.50.60', '192.168.1.50.',
      'bridge.local', 'api.meethue.com', 'localhost', '', ' 192.168.1.50 ', '::1', 'fc00::1',
      '[fc00::1]', '::ffff:192.168.1.50', '0x7f000001',
    ];
    for (const host of cases) {
      expect(isRfc1918Ipv4Literal(host), `disagreement on "${host}"`).toBe(isPrivateRfc1918Ipv4Literal(host));
    }
  });

  it('the class name the registry declares is the one protocol pins', () => {
    expect(CONNECTION_LAN_HOST_CLASSES).toContain(WELL_KNOWN_PROVIDERS_REGISTRY['hue']!.lanHost!.class);
  });
});
