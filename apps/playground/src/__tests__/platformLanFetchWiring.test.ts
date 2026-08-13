// The LAN pinned-TLS transport, wired through the platform seam (ADR-0023 D3;
// P0 amendment 6).
//
// `connectedFetchDepsFor` is the ONE assembly both connected-fetch call paths
// share — the RunView net handler and the wizard's probe — and it is where
// `fetchImpl` and `transportPolicy` are already threaded from the platform. The
// pinned LAN transport joins them there, for the same reason: a second wiring
// site would be a second configuration that could drift, and the two surfaces
// must never disagree about which transport carries a connected request.
//
// WHAT'S ACTUALLY UNDER TEST HERE. The routing decision itself lives in the
// executor (packages/auth `lan-pinned-transport.test.ts` owns it in full,
// including every negative). This file owns the WIRING claim on both sides of
// the platform seam:
//
//   * desktop: the platform's `lanFetch` reaches the executor, so a LAN request
//     takes it and carries the connection's recorded pin;
//   * web: NO `lanFetch` is present in the deps AT ALL — not undefined-but-
//     spelled, absent — so the web assembly is byte-identical to today (AC10)
//     and a LAN request fails honestly rather than riding page fetch.
//
// The platform is set-once/set-before-first-read, so every case takes a FRESH
// module registry (the platform.test.ts pattern).

import { describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

const APP = 'app-lan-fetch';
const SLOT = 'hue';
const BRIDGE = '192.168.1.50';
const PIN = 'a'.repeat(64);

/**
 * A BARE hue requirement — no `fields`, no `request` — and that is not an
 * economy, it is the only shape the admission gate accepts.
 *
 * Guard 2b refuses credential-prompt copy authored on the `inference` channel
 * while borrowing a registry brand: an inferred requirement that supplies its
 * own field labels and header template is a prompt-injection surface with the
 * provider's name on it. Omitting both is what makes the registry's PINNED
 * values get substituted at admission instead — which is also what makes this
 * fixture exercise the production path rather than a hand-built one.
 *
 * (Lesson 2026-08-06: a security guard blocking your fixture means the fixture
 * is wrong. The first draft of this file authored both seats and was refused;
 * the fix was the fixture, never the guard.)
 *
 * The bridge address stays in `declaredApiHosts` because it is the USER's, not
 * the registry's — amendment 10(b) makes admission preserve it for lanHost
 * entries rather than clobbering it with the entry's (absent) pinned hosts.
 */
const hueRequirement = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Philips Hue' },
  declaredApiHosts: [BRIDGE],
  lanHost: { class: 'rfc1918-ipv4-literal' as const, label: 'Bridge IP address' },
};

interface Harness {
  db: UserDb;
  net: typeof import('../state/net.js');
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const net = await import('../state/net.js');
  return { db, net };
}

interface Recorder {
  calls: Array<{ url: string; init: RequestInit; pin?: string }>;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  lanFetch: (url: string, init: RequestInit, pin: string) => Promise<Response>;
}

function recorder(): Recorder {
  const calls: Recorder['calls'] = [];
  const ok = (): Response =>
    new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return ok();
    },
    lanFetch: async (url, init, pin) => {
      calls.push({ url, init, pin });
      return ok();
    },
  };
}

function desktopPlatform(rec: Recorder): SnugPlatform {
  return {
    kind: 'desktop',
    fetchImpl: rec.fetchImpl,
    lanFetch: rec.lanFetch,
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}

function seedPairedBridge(db: UserDb): void {
  db.installApp({ appId: APP, displayName: 'Lights', html: '<p>lights</p>' });
  db.setSecret(`auth:${APP}:${SLOT}:application_key`, 'minted-bridge-key');
  // The TOFU pin, in the connection's dynamic-state KV (ADR-0014 custody).
  db.setSecret(
    `auth:${APP}:${SLOT}:_connection`,
    JSON.stringify({ status: 'connected', lanPin: { fingerprint: PIN, cn: 'ECB5FAFFFE123456' } }),
  );
  db.putDeclaredConnection(APP, SLOT, hueRequirement, 'inference');
  db.approveConnection(APP, SLOT);
}

const lanFrame = {
  v: 1,
  type: 'snug:net-request',
  requestId: 'r1',
  instanceId: 'ins-1',
  url: `https://${BRIDGE}/clip/v2/resource/light`,
  method: 'GET',
} as const;

describe('desktop — the platform lanFetch reaches the executor', () => {
  it('a LAN request takes the pinned transport, carrying the connection pin and the injected key', async () => {
    const rec = recorder();
    const { db, net } = await fresh(desktopPlatform(rec));
    seedPairedBridge(db);
    const pageFetch = vi.spyOn(globalThis, 'fetch');

    const result = await net.createNetHandlerFor().handle(APP, lanFrame);

    expect(result.ok).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.pin, 'the pinned transport must receive the recorded pin').toBe(PIN);
    expect(rec.calls[0]?.url).toBe(`https://${BRIDGE}/clip/v2/resource/light`);
    const headers = (rec.calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers['hue-application-key']).toBe('minted-bridge-key');
    expect(pageFetch, 'page fetch is never a LAN transport').not.toHaveBeenCalled();
    pageFetch.mockRestore();
  });

  it('a PUBLIC request from the same desktop platform still takes the ordinary fetch, pinless', async () => {
    const rec = recorder();
    const { db, net } = await fresh(desktopPlatform(rec));
    db.installApp({ appId: APP, displayName: 'Lights', html: '<p>lights</p>' });
    db.setSecret(`auth:${APP}:public:api_key`, 'public-key');
    db.putDeclaredConnection(
      APP,
      'public',
      {
        slot: 'public',
        kind: 'api_key',
        provider: { name: 'Example' },
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
        request: { headerTemplate: { 'x-api-key': '{{api_key}}' } },
        declaredApiHosts: ['api.example.com'],
      },
      'inference',
    );
    db.approveConnection(APP, 'public');

    await net.createNetHandlerFor().handle(APP, { ...lanFrame, url: 'https://api.example.com/v1/data' });

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.pin, 'a public host never touches the pinned transport').toBeUndefined();
  });
});

describe('web — the seam is ABSENT, not undefined (AC10 byte-identical)', () => {
  it('the web deps carry NO lanFetch key at all', async () => {
    // `lanFetch: undefined` and "no lanFetch" are the same to a `?.` call but
    // NOT the same to a reader auditing the assembly, and not the same to a
    // future `'lanFetch' in deps` check. The web profile must not mention it.
    const { db, net } = await fresh();
    seedPairedBridge(db);
    const deps = net.connectedFetchDepsFor(db);
    expect(Object.prototype.hasOwnProperty.call(deps, 'lanFetch')).toBe(false);
  });

  it('a LAN request on web fails honestly — it never falls back to page fetch', async () => {
    const { db, net } = await fresh();
    seedPairedBridge(db);
    const pageFetch = vi.spyOn(globalThis, 'fetch');

    const result = await net.createNetHandlerFor().handle(APP, lanFrame);

    expect(result.ok).toBe(false);
    expect(pageFetch, 'the browser must never dial a bridge').not.toHaveBeenCalled();
    pageFetch.mockRestore();
  });
});

describe('the deps assembly — one wiring site, shared by both call paths', () => {
  it('desktop deps carry lanFetch AND the transport policy together', async () => {
    // The two are what make the LAN rung real, and they come from the same
    // platform read. Wiring one without the other is a half-on state: a policy
    // with no transport refuses every bridge, a transport with no policy is
    // never routed to.
    const rec = recorder();
    const { db, net } = await fresh(desktopPlatform(rec));
    const deps = net.connectedFetchDepsFor(db);
    expect(typeof deps.lanFetch).toBe('function');
    expect(deps.transportPolicy).toEqual({ allowHttpForPrivateHosts: true });
  });

  it('the wizard probe path gets the SAME lanFetch instance as the app runtime path', async () => {
    const rec = recorder();
    const { db, net } = await fresh(desktopPlatform(rec));
    const runtimeDeps = net.connectedFetchDepsFor(db, undefined, () => {});
    const probeDeps = net.connectedFetchDepsFor(db);
    expect(runtimeDeps.lanFetch).toBe(probeDeps.lanFetch);
    expect(runtimeDeps.lanFetch).toBe(rec.lanFetch);
  });
});
