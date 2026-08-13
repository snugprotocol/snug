// TASK-20260812-desktop-auth-awareness P5 (ADR-0023 Decision 1, P0 amendment 2
// "lan-schema-2"): the `lanHost` seat and the declaredApiHosts required-XOR-lanHost rule.
//
// THE DEFECT THIS CLOSES, reproduced by execution before the change (probe, 2026-08-13):
// `declaredApiHostsSchema` is `.min(1)` AND a REQUIRED seat, so a LAN-class requirement
// that has not yet collected the user's bridge IP is UNREPRESENTABLE — safeParse fails
// with "declaredApiHosts: Invalid input: expected array, received undefined". A Hue
// bridge lives at a user-specific private address that no registry entry can pin, so
// without this seat the whole LAN provider class cannot be declared at all. That is why
// ADR-0023 names this a PROTOCOL schema change rather than a registry-type change.
//
// THE RULE, decided here and stated once (the brief asks for the decision to be pinned
// both ways). `deriveConnectionAllowedHosts` unions `declaredApiHosts` into the FROZEN
// ceiling at approval (packages/db `putDeclaredConnection`/`approveConnection`), and the
// executor's runtime wall is that frozen ceiling. So a LAN row MUST be able to carry the
// collected bridge IP in `declaredApiHosts` — that is the ONLY way the ceiling freezes
// around the user's device. Hence EXACTLY ONE of:
//
//   (a) NO `lanHost`  ⇒ `declaredApiHosts` REQUIRED and non-empty  (today's rule, byte-
//       identical for every existing requirement — the negative tests below prove it).
//   (b) `lanHost` present ⇒ `declaredApiHosts` is EITHER ABSENT (pre-collection, the
//       shape a registry entry emits) OR EXACTLY ONE entry that is an RFC-1918 IPv4
//       LITERAL (post-collection, the shape the wizard writes after the user types the
//       address).
//
// WHY "exactly one private literal" and not "contains the literal": a LAN ceiling that
// also carried a public host would freeze a public host into the ceiling under a LAN
// declaration — credential injection against a host the user never named while the
// review screen shows a device on their own network. And a second private literal is a
// second device the user did not pair. One seat, one device, one ceiling entry.
//
// NEGATIVE TESTS ARE THE MAJORITY, per the High-tier rule: what proves the fork is what
// it REFUSES, not that the happy shape parses.

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_LAN_HOST_CLASSES,
  canonicalRequirementHash,
  connectionRequirementSchema,
  isRfc1918Ipv4Literal,
} from '../connection-requirement.js';

/** The Hue-shaped LAN requirement BEFORE the wizard has collected a bridge IP. */
const lanRequirementPreCollection = {
  slot: 'hue',
  provider: { name: 'Philips Hue' },
  kind: 'api_key',
  fields: [{ key: 'application_key', label: 'Application key', type: 'secret' }],
  lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
} as const;

/** The same requirement AFTER the user typed 192.168.1.50 — the ceiling-freezing shape. */
const lanRequirementCollected = {
  ...lanRequirementPreCollection,
  declaredApiHosts: ['192.168.1.50'],
} as const;

describe('P5/AC7 — the lanHost seat exists and is bounded', () => {
  it('a lanHost requirement with NO declaredApiHosts parses (the pre-collection shape)', () => {
    const parsed = connectionRequirementSchema.safeParse(lanRequirementPreCollection);
    expect(
      parsed.success,
      `pre-collection LAN row must parse: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`,
    ).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.lanHost).toEqual({ class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' });
    expect(parsed.data.declaredApiHosts).toBeUndefined();
  });

  it('a lanHost requirement carrying the USER-COLLECTED private literal parses (the ceiling freezes here)', () => {
    const parsed = connectionRequirementSchema.safeParse(lanRequirementCollected);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.declaredApiHosts).toEqual(['192.168.1.50']);
  });

  it('the class is a single-member union today — an unknown class is refused, future classes are ADDITIVE', () => {
    expect(CONNECTION_LAN_HOST_CLASSES).toEqual(['rfc1918-ipv4-literal']);
    const parsed = connectionRequirementSchema.safeParse({
      ...lanRequirementPreCollection,
      lanHost: { class: 'any-host-the-user-types', label: 'Device address' },
    });
    expect(parsed.success, 'an unpinned host class must not parse').toBe(false);
  });

  it('lanHost is a strictObject — an unknown sibling seat cannot ride in unreviewed', () => {
    const parsed = connectionRequirementSchema.safeParse({
      ...lanRequirementPreCollection,
      lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address', allowPublic: true },
    });
    expect(parsed.success).toBe(false);
  });

  it('lanHost.label is required and bounded — the wizard renders it above the address input', () => {
    expect(
      connectionRequirementSchema.safeParse({
        ...lanRequirementPreCollection,
        lanHost: { class: 'rfc1918-ipv4-literal' },
      }).success,
      'a label-less lanHost leaves the user at an unnamed box — the founding defect one seat over',
    ).toBe(false);
    expect(
      connectionRequirementSchema.safeParse({
        ...lanRequirementPreCollection,
        lanHost: { class: 'rfc1918-ipv4-literal', label: 'x'.repeat(81) },
      }).success,
      'the label reuses the field-label ceiling (80)',
    ).toBe(false);
  });
});

describe('P5/AC7 — the required-XOR rule, pinned in BOTH directions', () => {
  it('NEITHER seat: refused (a requirement with no host source at all has no ceiling)', () => {
    const { lanHost, ...noLan } = lanRequirementPreCollection;
    void lanHost;
    const parsed = connectionRequirementSchema.safeParse(noLan);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.includes('declaredApiHosts'))).toBe(true);
  });

  it('lanHost + a PUBLIC declared host: REFUSED — a LAN declaration may not freeze a public host into the ceiling', () => {
    const parsed = connectionRequirementSchema.safeParse({
      ...lanRequirementPreCollection,
      declaredApiHosts: ['api.meethue.com'],
    });
    expect(parsed.success, 'a public host beside lanHost is the smuggling shape amendment 10(c) refuses').toBe(false);
  });

  it('lanHost + private literal + a public host: REFUSED (the mixed form is the same smuggle with cover)', () => {
    expect(
      connectionRequirementSchema.safeParse({
        ...lanRequirementPreCollection,
        declaredApiHosts: ['192.168.1.50', 'evil.example'],
      }).success,
    ).toBe(false);
  });

  it('lanHost + TWO private literals: REFUSED — one seat, one device, one ceiling entry', () => {
    expect(
      connectionRequirementSchema.safeParse({
        ...lanRequirementPreCollection,
        declaredApiHosts: ['192.168.1.50', '192.168.1.51'],
      }).success,
    ).toBe(false);
  });

  it('lanHost + an EMPTY declaredApiHosts array: REFUSED (min(1) still bites; absence is the pre-collection shape)', () => {
    expect(
      connectionRequirementSchema.safeParse({ ...lanRequirementPreCollection, declaredApiHosts: [] }).success,
    ).toBe(false);
  });

  it('NON-lan requirements are byte-identical to today: declaredApiHosts still REQUIRED and non-empty', () => {
    const ordinary = {
      slot: 'weather',
      provider: { name: 'OpenWeather' },
      kind: 'api_key',
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
      declaredApiHosts: ['api.openweathermap.org'],
    };
    expect(connectionRequirementSchema.safeParse(ordinary).success).toBe(true);
    const { declaredApiHosts, ...noHosts } = ordinary;
    void declaredApiHosts;
    expect(connectionRequirementSchema.safeParse(noHosts).success, 'no lanHost ⇒ hosts stay required').toBe(false);
    expect(
      connectionRequirementSchema.safeParse({ ...ordinary, declaredApiHosts: [] }).success,
      'no lanHost ⇒ min(1) stays',
    ).toBe(false);
  });

  it('a NON-lan requirement may still declare a private literal (ADR-0021 rung 4 predates this seat)', () => {
    // Load-bearing NEGATIVE-of-a-negative: the XOR must not retroactively refuse the
    // authored private-IP api_key rows that amendment 15's consent copy exists for.
    // Refusing them here would be a silent behavior change to a shipped shape.
    expect(
      connectionRequirementSchema.safeParse({
        slot: 'printer',
        provider: { name: 'Some Device' },
        kind: 'api_key',
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
        declaredApiHosts: ['10.0.0.7'],
      }).success,
    ).toBe(true);
  });
});

describe('P5/AC7 — canonical identity sees the lanHost seat', () => {
  it('adding lanHost changes the canonical hash (so requirement_version bumps and the row is re-reviewed)', () => {
    const withLan = connectionRequirementSchema.parse(lanRequirementCollected);
    const withoutLan = connectionRequirementSchema.parse({
      slot: 'hue',
      provider: { name: 'Philips Hue' },
      kind: 'api_key',
      fields: [{ key: 'application_key', label: 'Application key', type: 'secret' }],
      declaredApiHosts: ['192.168.1.50'],
    });
    expect(canonicalRequirementHash(withLan)).not.toBe(canonicalRequirementHash(withoutLan));
    expect(canonicalRequirementHash(withLan)).toContain('lanHost');
  });

  it('the LABEL is part of the identity — relabelling the address input is a reviewable change', () => {
    const relabelled = connectionRequirementSchema.parse({
      ...lanRequirementCollected,
      lanHost: { class: 'rfc1918-ipv4-literal', label: 'Hub address' },
    });
    expect(canonicalRequirementHash(relabelled)).not.toBe(
      canonicalRequirementHash(connectionRequirementSchema.parse(lanRequirementCollected)),
    );
  });
});

describe('P5/AC7 — isRfc1918Ipv4Literal: protocol RESTATES the class, never imports packages/auth', () => {
  // WHY A RESTATEMENT AND NOT A REUSE: `packages/auth` depends on `@snugprotocol/protocol`,
  // so protocol importing auth's `isPrivateRfc1918Ipv4Literal` would be a dependency
  // CYCLE. The class is 12 lines of arithmetic with no shared state; a cycle to save
  // them would be the worse trade. The two implementations are pinned EQUIVALENT by a
  // cross-package test in packages/auth (net-guards ↔ protocol), so a drift fails
  // loudly rather than becoming two guards disagreeing about "private" — the
  // founding-defect shape of lesson 2026-08-10.
  it('accepts every RFC-1918 range and nothing else', () => {
    for (const host of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.1.50']) {
      expect(isRfc1918Ipv4Literal(host), host).toBe(true);
    }
  });

  it('refuses loopback, link-local, CGN, the 172 edges, names, and IPv6 in every form', () => {
    for (const host of [
      '127.0.0.1', // loopback — never a "device on your network" in this sense
      '169.254.1.1', // link-local: cloud metadata lives here
      '100.64.0.1', // RFC 6598 shared / CGN
      '172.15.0.1', // just below the 172.16/12 block
      '172.32.0.1', // just above it
      '8.8.8.8',
      'bridge.local',
      'api.meethue.com',
      '::1',
      '[fc00::1]',
      'fc00::1',
      '::ffff:192.168.1.50', // IPv4-mapped IPv6 is NOT an IPv4 literal
      '192.168.1', // malformed
      '192.168.1.50.60',
      '192.168.1.256',
      '',
    ]) {
      expect(isRfc1918Ipv4Literal(host), host).toBe(false);
    }
  });
});
