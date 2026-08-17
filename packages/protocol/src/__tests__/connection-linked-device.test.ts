// TASK-20260816-whatsapp-twin Phase A (ADR-0032): the `linked_device` auth kind.
//
// WHAT THIS KIND IS FOR. Some providers authenticate a DEVICE, not a request. Personal
// WhatsApp links a companion device by QR scan, after which the session lives in
// long-lived Signal/noise key material held by a local sidecar process — there is no key
// to type, no OAuth redirect, and the credential the HOST holds is not the provider
// credential at all. What lands in `snug_secrets` is a sidecar ACCESS TOKEN minted once at
// pairing; the WhatsApp session keys never leave the sidecar's own disk store (ADR-0032 §2,
// the C1 custody split). So the kind's shape is "api_key-like at the host boundary" even
// though the provider-side flow is nothing of the sort.
//
// WHY IT IS A KIND AND NOT A lanHost CLASS — the Gate-2 blocker, pinned here so it cannot
// be re-proposed. The first draft modeled the sidecar as a LAN-class device at
// `127.0.0.1:<port>`. That was wrong three ways, each independently fatal:
//
//   (1) UNSTORABLE. `CONNECTION_HOST_RULE` is LDH-only, so a colon cannot pass, and
//       `normalizeAuthHost` requires an empty port — `"127.0.0.1:8787"` can never equal a
//       URL-derived hostname and fails closed. Only bare `127.0.0.1` is representable.
//   (2) OVER-GRANTING. The frozen ceiling is HOST-granular (`isHostAllowed` compares
//       `new URL(url).hostname`), so a `127.0.0.1` ceiling admits EVERY loopback port —
//       the container runtime, the local model server, database admin surfaces, another
//       app's sidecar. `isForbiddenNetHost` refuses loopback precisely to stop this.
//   (3) MISROUTED. `isLanRequirement` is `lanHost !== undefined` and nothing more, with 13
//       call sites leading to a pairing path that HARD-REQUIRES a 64-hex TLS certificate
//       pin. A sidecar on a unix socket has no certificate and could never satisfy it.
//
// The sidecar is therefore a CAPABILITY, not a host: it is reached over a unix-domain
// socket by a purpose-built Rust command whose admission is method+path, and NO loopback
// host ever enters a frozen ceiling. These tests pin the kind; the absence of a lanHost
// class is pinned by the LAST test in this file, which is what stops the redesign from
// being quietly reverted later.

import { describe, expect, it } from 'vitest';
import { AUTH_KINDS } from '../auth-schema.js';
import {
  CONNECTION_KINDS,
  CONNECTION_LAN_HOST_CLASSES,
  connectionRequirementSchema,
} from '../connection-requirement.js';

/** The shape a `linked_device` registry entry emits: one pinned host, one minted-secret field. */
const linkedDeviceRequirement = {
  slot: 'whatsapp',
  provider: { name: 'WhatsApp' },
  kind: 'linked_device' as const,
  fields: [
    {
      key: 'sidecar_token',
      label: 'Sidecar access token',
      type: 'secret' as const,
      description: 'Minted for you when you scan the code — there is nothing to look up.',
    },
  ],
  request: { headerTemplate: { authorization: 'Bearer {{sidecar_token}}' } },
  declaredApiHosts: ['whatsapp.sidecar.localhost'],
};

describe('linked_device — the kind exists and is persisted-discriminator shaped', () => {
  it('is a member of AUTH_KINDS, so CONNECTION_KINDS derives it', () => {
    // CONNECTION_KINDS is `[...AUTH_KINDS, 'none']` — derived, never retyped. Adding the
    // literal here is what makes it a legal `kind` everywhere downstream; adding it to
    // CONNECTION_KINDS directly would split the persisted discriminator set in two.
    expect(AUTH_KINDS).toContain('linked_device');
    expect(CONNECTION_KINDS).toContain('linked_device');
  });

  it('parses a complete linked_device requirement', () => {
    const parsed = connectionRequirementSchema.safeParse(linkedDeviceRequirement);
    expect(parsed.success).toBe(true);
  });

  it('requires declaredApiHosts like every other kind — a device is still host-gated', () => {
    // The custody split does NOT buy an exemption from the host gate. The sidecar token is
    // a credential; a requirement that names no host derives an empty ceiling, and an empty
    // ceiling that still injects would be a credential aimed anywhere.
    const { declaredApiHosts: _omitted, ...hostless } = linkedDeviceRequirement;
    const parsed = connectionRequirementSchema.safeParse(hostless);
    expect(parsed.success).toBe(false);
  });
});

describe('linked_device — coherence (the seats it must and must not carry)', () => {
  it('refuses a linked_device requirement that declares no credential field', () => {
    // A linked_device row whose token has no named slot is the incoherent shape `none`'s
    // arm exists to refuse, mirrored: there would be nothing for pairing to fill and
    // nothing for the executor to inject, so the row would fail at the worst moment —
    // mid-send, after the user armed auto-reply. Fail closed at the schema instead.
    const { fields: _dropped, ...fieldless } = linkedDeviceRequirement;
    const parsed = connectionRequirementSchema.safeParse(fieldless);
    expect(parsed.success).toBe(false);
  });

  it('refuses a linked_device requirement carrying OAuth endpoints', () => {
    // A device link is not an authorization-code flow. Endpoints on this kind would widen
    // the derived ceiling (refreshUrl unions into it) for a flow that never redirects.
    const parsed = connectionRequirementSchema.safeParse({
      ...linkedDeviceRequirement,
      endpoints: {
        authorizeUrl: 'https://example.com/authorize',
        tokenUrl: 'https://example.com/token',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a linked_device requirement carrying a lanHost seat', () => {
    // THE REDESIGN, PINNED. This is the shape that would fall into the LAN pairing path
    // and its mandatory TLS pin. Refusing it at the schema means the misrouting defect is
    // unrepresentable rather than merely un-authored.
    const parsed = connectionRequirementSchema.safeParse({
      ...linkedDeviceRequirement,
      declaredApiHosts: ['192.168.1.50'],
      lanHost: { class: 'rfc1918-ipv4-literal', label: 'Sidecar address' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('linked_device — the other kinds are untouched', () => {
  it('leaves every pre-existing kind parsing exactly as before', () => {
    // A new discriminator must not perturb the five shipped ones. Each of these is a
    // minimal legal requirement of its kind; all five parsed before this task and must
    // parse identically after it.
    const base = { slot: 'x', provider: { name: 'X' }, declaredApiHosts: ['api.example.com'] };
    const shapes = [
      { ...base, kind: 'api_key' as const, fields: [{ key: 'k', label: 'K', type: 'secret' as const }] },
      { ...base, kind: 'bearer_token' as const, fields: [{ key: 't', label: 'T', type: 'secret' as const }] },
      {
        ...base,
        kind: 'basic_auth' as const,
        fields: [
          { key: 'u', label: 'U', type: 'text' as const },
          { key: 'p', label: 'P', type: 'password' as const },
        ],
      },
      { ...base, kind: 'none' as const },
    ];
    for (const shape of shapes) {
      expect(connectionRequirementSchema.safeParse(shape).success).toBe(true);
    }
  });

  it('adds NO new lanHost class — the sidecar is a capability, not a host', () => {
    // The load-bearing negative of the whole redesign (ADR-0032 §4). If someone later
    // "fixes" sidecar reachability by adding a loopback class here, this test fails and
    // sends them to the ADR — which is the entire point of pinning an ABSENCE.
    expect(CONNECTION_LAN_HOST_CLASSES).toEqual(['rfc1918-ipv4-literal']);
  });
});
