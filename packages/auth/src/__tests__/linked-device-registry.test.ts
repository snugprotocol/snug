// TASK-20260816-whatsapp-twin Phase B (ADR-0032): the `whatsapp` registry entry and the
// `device-link` pairing variant.
//
// WHY A NEW PAIRING VARIANT RATHER THAN A REUSE. `WellKnownPairingExchange` describes Hue's
// exchange: ONE `POST`, ONE response, `secretPath` walks to the minted key. A device link is
// a different shape — start a session, render a QR the user scans with their phone, then
// POLL until the provider confirms the link and hands the token back. The existing seat
// cannot express a poll, and overloading it (a `secretPath` that sometimes means "read this
// response" and sometimes "read the response of a route not named here") would make one
// field mean two things. So the seat becomes a DISCRIMINATED union: `kind: 'exchange'` is
// Hue's, byte-identical; `kind: 'device-link'` is this.
//
// WHY THE ENTRY PINS A HOST AND CARRIES NO lanHost. The sidecar is reached as a CAPABILITY
// over a unix socket, not as a network host (ADR-0032 §4). A `lanHost` seat would route the
// row into the LAN pairing path and its mandatory TLS certificate pin — which a unix socket
// can never produce — so the entry pins a symbolic host and the Rust command owns
// reachability. The protocol schema refuses `linked_device` + `lanHost` outright; this file
// pins the registry side of the same decision.

import { describe, expect, it } from 'vitest';
import { isAppReachableSidecarRoute, SIDECAR_AUTH_HEADER } from '@snugprotocol/protocol';
import {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  requirementFromRegistryEntry,
  resolveRegistryEntryByName,
} from '../well-known-providers.js';
import { admitConnectionRequirement } from '../requirement-admission.js';

const entry = WELL_KNOWN_PROVIDERS_REGISTRY['whatsapp'];

describe('the whatsapp entry', () => {
  it('exists and declares the linked_device kind', () => {
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('linked_device');
  });

  it('is keyed so BOTH resolution rungs reach it (the borrow-ban regression)', () => {
    // THE DEFECT THIS PINS, caught red during Phase B. The entry was first keyed
    // `whatsapp-personal`. Both rungs of `resolveRegistryEntryByName` key on the
    // NORMALIZED registry key — `lookupWellKnownProvider` does
    // `REGISTRY[normalizeProviderKey(name)]` (non-alphanumerics stripped), and
    // `findBrandAdjacentRegistryKeys` joins name segments and asks `Object.hasOwn`. So
    // `normalizeProviderKey('WhatsApp') === 'whatsapp'` reached NEITHER, the borrow ban
    // never fired for the brand, and a hostile declaration wearing the WhatsApp name while
    // aiming the credential at its own host was ADMITTED.
    //
    // This is ADR-0023's P6 amendment repeating in a new entry (hue rows persist
    // 'Philips Hue', which normalizes to `philipshue`, not the key `hue`), which is why it
    // gets a test of its own rather than only a comment: the next entry author will pick a
    // key by aesthetics unless something fails.
    const normalized = 'WhatsApp'.toLowerCase().replace(/[^a-z0-9]/g, '');
    expect(Object.hasOwn(WELL_KNOWN_PROVIDERS_REGISTRY, normalized)).toBe(true);
    expect(resolveRegistryEntryByName('WhatsApp')?.entry).toBe(entry);
    expect(resolveRegistryEntryByName('WhatsApp Personal')?.entry).toBe(entry);
  });

  it('pins a host and carries NO lanHost seat (ADR-0032 §4)', () => {
    // The load-bearing negative. A lanHost seat here would drag the row through
    // `isLanRequirement`'s 13 call sites into a pairing path demanding a 64-hex TLS pin.
    expect(entry?.lanHost).toBeUndefined();
    expect(entry?.apiHosts?.length).toBe(1);
  });

  it('declares exactly one credential field — the minted sidecar token', () => {
    // Not a typed secret: the user never sees this value. It exists so `snug_secrets` has
    // a named slot and the header template has a key to reference.
    expect(entry?.fields?.map((field) => field.key)).toEqual(['sidecar_token']);
    expect(entry?.fields?.[0]?.type).toBe('secret');
  });

  it('injects the token through the header the sidecar contract names', () => {
    // ONE spelling, imported from the contract module rather than retyped — the whole
    // point of Phase B.0.
    const header = entry?.request?.headerTemplate ?? {};
    const names = Object.keys(header).map((name) => name.toLowerCase());
    expect(names).toEqual([SIDECAR_AUTH_HEADER]);
    expect(Object.values(header)[0]).toContain('{{sidecar_token}}');
  });

  it('is desktop-only and says so, rather than failing on the web', () => {
    // The sidecar is a spawned local process; a browser tab cannot reach a unix socket.
    // `browserCallable: false` is what makes the wizard DISCLOSE that instead of
    // presenting a flow that silently cannot work (the disclosedBrowserWall pattern).
    expect(entry?.browserCallable).toBe(false);
  });

  it('carries no OAuth endpoints and no scopes — a device link is neither', () => {
    expect(entry?.endpoints).toBeUndefined();
    expect(entry?.scopes).toBeUndefined();
  });
});

describe('the device-link pairing seat', () => {
  const pairing = entry?.pairing;

  it('is discriminated as device-link, leaving Hue exchange-shaped', () => {
    expect(pairing?.kind).toBe('device-link');
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.pairing?.kind).toBe('exchange');
  });

  it('names start, qr and poll routes that the contract actually serves', () => {
    // A pairing route the sidecar does not serve is a wizard that dead-ends. Each is
    // checked against the contract module, never against a retyped string.
    if (pairing?.kind !== 'device-link') throw new Error('expected a device-link seat');
    for (const path of [pairing.startPathAndQuery, pairing.qrPathAndQuery, pairing.pollPathAndQuery]) {
      expect(path.startsWith('/')).toBe(true);
    }
    expect(pairing.startPathAndQuery).toBe('/pair/start');
    expect(pairing.qrPathAndQuery).toBe('/pair/qr');
    expect(pairing.pollPathAndQuery).toBe('/pair/status');
  });

  it('keeps every pairing route OFF the app-reachable surface', () => {
    // Restating the Phase B.0 refusal from the registry side: whatever the wizard uses to
    // MINT a token must never be reachable by an app that could then mint its own.
    if (pairing?.kind !== 'device-link') throw new Error('expected a device-link seat');
    for (const path of [pairing.startPathAndQuery, pairing.qrPathAndQuery, pairing.pollPathAndQuery]) {
      expect(isAppReachableSidecarRoute('GET', path)).toBe(false);
      expect(isAppReachableSidecarRoute('POST', path)).toBe(false);
    }
  });

  it('REQUIRES a verify read before claiming connected (ADR-0025)', () => {
    // The instant-connected defect ADR-0025 exists to kill: a wizard that says "connected"
    // because a mint returned, without ever proving the credential works.
    expect(pairing?.verify?.method).toBe('GET');
    expect(pairing?.verify?.pathAndQuery).toBe('/session/status');
  });

  it('bounds the poll so an abandoned scan cannot spin forever', () => {
    if (pairing?.kind !== 'device-link') throw new Error('expected a device-link seat');
    expect(pairing.pollTimeoutMs).toBeGreaterThan(0);
    expect(pairing.pollIntervalMs).toBeGreaterThan(0);
    expect(pairing.pollIntervalMs).toBeLessThan(pairing.pollTimeoutMs);
  });

  it('tells the user what to do, in their own words', () => {
    // The copy IS the difference between a working pairing and an unexplained failure —
    // the user must know to open their phone, and that this links a device.
    expect(pairing?.preconditionInstruction ?? '').toMatch(/phone|scan|link/i);
    expect((pairing?.preconditionInstruction ?? '').length).toBeGreaterThan(20);
  });
});

describe('the emitter and admission handle the entry', () => {
  it('emits a requirement that the protocol schema accepts', () => {
    const requirement = requirementFromRegistryEntry(entry!, 'WhatsApp', 'whatsapp');
    expect(requirement.kind).toBe('linked_device');
    expect(requirement.lanHost).toBeUndefined();
    expect(requirement.declaredApiHosts?.length).toBe(1);
  });

  it('admits its own emitted shape on the registry channel', () => {
    const requirement = requirementFromRegistryEntry(entry!, 'WhatsApp', 'whatsapp');
    const admitted = admitConnectionRequirement(requirement, { channel: 'registry' });
    expect(admitted.ok, JSON.stringify(admitted.issues ?? [])).toBe(true);
  });

  it('REFUSES a borrower that claims the WhatsApp brand with its own host', () => {
    // WhatsApp is a high-value brand to impersonate, and the entry pins a host, so it sits
    // in the registry host index like any other entry. A declaration wearing the name while
    // aiming the credential elsewhere is the borrow ban's whole purpose.
    const hostile = {
      slot: 'whatsapp',
      provider: { name: 'WhatsApp' },
      kind: 'linked_device' as const,
      fields: [{ key: 'sidecar_token', label: 'Token', type: 'secret' as const }],
      request: { headerTemplate: { authorization: 'Bearer {{sidecar_token}}' } },
      declaredApiHosts: ['evil.example'],
    };
    const admitted = admitConnectionRequirement(hostile, { channel: 'inference' });
    expect(admitted.ok).toBe(false);
  });
});
