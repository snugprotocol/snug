// TASK-20260816-whatsapp-twin Phase D (ADR-0032): the `linked_device` wizard flow.
//
// THE CONSTRAINT THIS FILE EXISTS TO ENFORCE, and the reason the flow is built as its own
// family rather than by widening the LAN one:
//
// `isLanRequirement` is `requirement?.lanHost !== undefined` and nothing more, with 13 call
// sites across the wizard state and sheet, several of which lead into `runLanPairingAttempt`
// — which HARD-REQUIRES a 64-hex TLS certificate fingerprint before it will record anything.
// A helper on a unix socket has no certificate and can never produce one, so a
// `linked_device` row that reached that path could only fail, and would fail deep inside
// pairing rather than at a boundary that could explain itself.
//
// The protocol schema already refuses `linked_device` + `lanHost` outright, so the two
// families are disjoint BY CONSTRUCTION. These tests pin that disjointness at the wizard
// altitude, where the routing decisions are actually made — a schema refusal upstream is not
// evidence about which branch this code takes.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionRequirement } from '@snugprotocol/protocol';
import type { SnugPlatform } from '../platform/platform.js';

/**
 * A desktop platform carrying only the seats a test cares about. `kind` and `capabilities`
 * are required by the seam's own type, so they are stated once here rather than in nine
 * places — and stating them keeps each test's literal about the SIDECAR seats alone.
 */
function desktopPlatform(seats: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    ...seats,
  };
}

const whatsappRequirement: ConnectionRequirement = {
  slot: 'whatsapp',
  provider: { name: 'WhatsApp' },
  kind: 'linked_device',
  fields: [{ key: 'sidecar_token', label: 'Helper access token', type: 'secret' }],
  request: { headerTemplate: { authorization: 'Bearer {{sidecar_token}}' } },
  declaredApiHosts: ['whatsapp.sidecar.localhost'],
};

const hueRequirement: ConnectionRequirement = {
  slot: 'hue',
  provider: { name: 'Philips Hue' },
  kind: 'api_key',
  fields: [{ key: 'application_key', label: 'Bridge application key', type: 'secret' }],
  request: { headerTemplate: { 'hue-application-key': '{{application_key}}' } },
  lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
  declaredApiHosts: ['192.168.1.50'],
};

const apiKeyRequirement: ConnectionRequirement = {
  slot: 'openweather',
  provider: { name: 'OpenWeather' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  declaredApiHosts: ['api.openweathermap.org'],
};

describe('the two families are disjoint at the wizard altitude', () => {
  it('a linked_device row is NOT a LAN requirement', async () => {
    // The load-bearing assertion of the whole phase. If this ever flips, the row starts
    // travelling a path that demands a TLS pin it cannot produce.
    const { isLanRequirement } = await import('../state/connectionWizard.js');
    expect(isLanRequirement(whatsappRequirement)).toBe(false);
  });

  it('a LAN row is NOT a linked-device requirement', async () => {
    const { isLinkedDeviceRequirement } = await import('../state/connectionWizard.js');
    expect(isLinkedDeviceRequirement(hueRequirement)).toBe(false);
  });

  it('recognises a linked_device row by its KIND, not by a seat it happens to carry', async () => {
    // Keyed on kind because kind is what the registry pins and the schema validates. A
    // predicate keyed on "has a pairing seat" or "has one host" would be true of rows this
    // flow must never claim.
    const { isLinkedDeviceRequirement } = await import('../state/connectionWizard.js');
    expect(isLinkedDeviceRequirement(whatsappRequirement)).toBe(true);
    expect(isLinkedDeviceRequirement(apiKeyRequirement)).toBe(false);
    expect(isLinkedDeviceRequirement(undefined)).toBe(false);
  });

  it('neither predicate claims an ordinary api_key row', async () => {
    const { isLanRequirement, isLinkedDeviceRequirement } = await import('../state/connectionWizard.js');
    expect(isLanRequirement(apiKeyRequirement)).toBe(false);
    expect(isLinkedDeviceRequirement(apiKeyRequirement)).toBe(false);
  });

  it('the LAN pairing resolver refuses a linked_device row by name', async () => {
    // Belt AND braces: `isLanRequirement` already excludes it, and the resolver narrows on
    // the pairing discriminant. Both are asserted because they fail independently.
    const { lanPairingExchangeFor } = await import('../state/connectionWizard.js');
    expect(lanPairingExchangeFor(whatsappRequirement)).toBeUndefined();
  });
});

describe('canLinkDevice — the honest capability test', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('is false on WEB, so the sheet discloses instead of dead-ending', async () => {
    // A browser tab cannot open a unix socket, so there is no flow to offer. Disclosure
    // keeps the ROW intact and readable (ADR-0023 D1's portability rule) rather than
    // presenting a wizard that silently cannot work.
    //
    // A REAL web platform, not a desktop one with the seats omitted: the claim in this
    // test's name is about the web profile, and asserting it against a desktop object
    // would prove only that the seats are optional — which the next test already covers.
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform({
      kind: 'web',
      capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false },
    });
    const { canLinkDevice } = await import('../state/connectionWizard.js');
    expect(canLinkDevice()).toBe(false);
  });

  it('is false on a DESKTOP shell that does not expose the seats', async () => {
    // The other half, kept distinct: an older shell, or one built without the helper, must
    // disclose rather than offer a flow whose transport is absent.
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(desktopPlatform());
    const { canLinkDevice } = await import('../state/connectionWizard.js');
    expect(canLinkDevice()).toBe(false);
  });

  it('is true only when the shell exposes the sidecar seam', async () => {
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async () => ({ running: true, nonce: 'n' }),
        sidecarFetch: async () => ({ status: 200, body: '{}' }),
      }),
    );
    const { canLinkDevice } = await import('../state/connectionWizard.js');
    expect(canLinkDevice()).toBe(true);
  });

  it('is false when only HALF the seam is present', async () => {
    // Both seats are needed: `sidecarCtl` starts the helper, `sidecarFetch` talks to it.
    // Reporting "capable" on a partial seam produces a flow that fails midway — the
    // asymmetry that the LAN seam's own tests pin for `lanFetch`/`lanPair`.
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(desktopPlatform({ sidecarCtl: async () => ({ running: true, nonce: 'n' }) }));
    const { canLinkDevice } = await import('../state/connectionWizard.js');
    expect(canLinkDevice()).toBe(false);
  });
});

describe('runDeviceLinkAttempt — start, poll, verify, then record', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  /** A scripted shell seam: the helper answers whatever the script says, in order. */
  function scriptedPlatform(script: Record<string, Array<{ status: number; body: unknown }>>) {
    const calls: string[] = [];
    return {
      calls,
      platform: desktopPlatform({
        sidecarCtl: async () => ({ running: true, nonce: 'spawn-nonce' }),
        sidecarFetch: async (method: string, pathAndQuery: string) => {
          const key = `${method} ${pathAndQuery}`;
          calls.push(key);
          const queue = script[key];
          const next = queue?.length === 1 ? queue[0] : queue?.shift();
          if (next === undefined) throw new Error(`unscripted call: ${key}`);
          return { status: next.status, body: JSON.stringify(next.body) };
        },
      }),
    };
  }

  it('starts the helper, renders the QR, and waits rather than claiming linked', async () => {
    const { platform } = scriptedPlatform({
      'POST /pair/start': [{ status: 200, body: { state: 'waiting' } }],
      'GET /pair/qr': [{ status: 200, body: { state: 'waiting', qr: 'QR-PAYLOAD' } }],
      'GET /pair/status': [{ status: 200, body: { state: 'waiting' } }],
    });
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(platform);
    const { beginDeviceLink } = await import('../state/connectionWizard.js');
    const started = await beginDeviceLink();
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.qr).toBe('QR-PAYLOAD');
  });

  it('surfaces an unreachable helper as a NAMED failure, never as "still waiting"', async () => {
    // "Waiting" on a helper that will never answer is the wizard hanging forever on the
    // commonest non-error outcome. The user needs to be told the helper is not there.
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async () => {
          throw new Error('could not start the WhatsApp helper: ENOENT');
        },
        sidecarFetch: async () => ({ status: 200, body: '{}' }),
      }),
    );
    const { beginDeviceLink } = await import('../state/connectionWizard.js');
    const started = await beginDeviceLink();
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.message).toMatch(/helper/i);
  });

  it('refuses to record anything when the VERIFY read fails (ADR-0025)', async () => {
    // The instant-connected defect this pattern exists to kill: a mint returning is not
    // proof the credential works. Nothing durable may land until the verify read passes.
    const { platform, calls } = scriptedPlatform({
      'POST /pair/start': [{ status: 200, body: { state: 'waiting' } }],
      'GET /pair/status': [{ status: 200, body: { state: 'linked', token: 'minted-token' } }],
      'GET /session/status': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(platform);
    const { completeDeviceLink } = await import('../state/connectionWizard.js');
    const result = await completeDeviceLink();
    expect(result.ok).toBe(false);
    expect(calls).toContain('GET /session/status');
  });

  it('returns the minted token only after the verify read passes', async () => {
    const { platform, calls } = scriptedPlatform({
      'POST /pair/start': [{ status: 200, body: { state: 'waiting' } }],
      'GET /pair/status': [{ status: 200, body: { state: 'linked', token: 'minted-token' } }],
      'GET /session/status': [{ status: 200, body: { state: 'linked' } }],
    });
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(platform);
    const { completeDeviceLink } = await import('../state/connectionWizard.js');
    const result = await completeDeviceLink();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token).toBe('minted-token');
    // THE ORDER IS THE PROPERTY: verify runs BEFORE the caller is handed a token to store.
    expect(calls.indexOf('GET /session/status')).toBeGreaterThan(calls.indexOf('GET /pair/status'));
  });

  it('treats a linked status with NO token as a failure, not a success', async () => {
    // A helper that reports linked but hands back nothing has failed in a way the wizard
    // must not paper over — recording an empty credential produces a connection that
    // fails on its first real use, far from here.
    //
    // THE FIXTURE IS THE TEST. A surviving mutant taught this: with only the two calls
    // above scripted, deleting the empty-token guard STILL produced `ok:false`, because
    // execution fell through to an UNSCRIPTED verify call that threw. The test passed for a
    // reason that had nothing to do with the guard it names. So `/session/status` is
    // scripted to SUCCEED here — the input now passes every sibling refusal and can fail
    // only on the one under test (lessons.md 2026-08-04).
    const { platform } = scriptedPlatform({
      'POST /pair/start': [{ status: 200, body: { state: 'waiting' } }],
      'GET /pair/status': [{ status: 200, body: { state: 'linked' } }],
      'GET /session/status': [{ status: 200, body: { state: 'linked' } }],
    });
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(platform);
    const { completeDeviceLink } = await import('../state/connectionWizard.js');
    const result = await completeDeviceLink();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/no key|link again/i);
  });

  it('treats an EMPTY-STRING token as no token', async () => {
    // The adjacent spelling: a helper that answers `token: ""` is the same failure wearing
    // a different type, and a truthiness check that only tested `undefined` would admit it.
    const { platform } = scriptedPlatform({
      'POST /pair/start': [{ status: 200, body: { state: 'waiting' } }],
      'GET /pair/status': [{ status: 200, body: { state: 'linked', token: '' } }],
      'GET /session/status': [{ status: 200, body: { state: 'linked' } }],
    });
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(platform);
    const { completeDeviceLink } = await import('../state/connectionWizard.js');
    expect((await completeDeviceLink()).ok).toBe(false);
  });
});
