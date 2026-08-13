// Platform fetch seam (TASK-20260812 W2a; P0 amendment 5). `connectedFetchDepsFor`'s
// DEFAULT fetch is THE single assembly both connected-fetch call paths share — the
// RunView net handler and the wizard's `testConnection` probe — so a desktop platform
// that installs `fetchImpl` reroutes BOTH with zero per-call-site wiring, and a hub
// with no platform set keeps today's page fetch byte-for-byte (AC10 no-regression).
//
// The platform is set-once/set-before-first-read, so every case takes a FRESH module
// registry (the platform.test.ts pattern) and imports its consumers dynamically from
// that same generation.
import { describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

const APP = 'app-platform-fetch';
const SLOT = 'example';

const apiKeyRequirement = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
  testRequest: { method: 'GET' as const, pathAndQuery: '/v1/ping' },
};

interface Harness {
  db: UserDb;
  net: typeof import('../state/net.js');
  wizard: typeof import('../state/connectionWizard.js');
}

/** Fresh module registry; the platform (when given) is set BEFORE any consumer import. */
async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const net = await import('../state/net.js');
  const wizard = await import('../state/connectionWizard.js');
  wizard.__resetConnectionWizardForTests();
  return { db, net, wizard };
}

interface RecordingFetch {
  calls: Array<{ url: string; init: RequestInit }>;
  impl: (input: string, init?: RequestInit) => Promise<Response>;
}

function recordingFetch(): RecordingFetch {
  const calls: RecordingFetch['calls'] = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

function desktopPlatform(fetchImpl: RecordingFetch['impl']): SnugPlatform {
  return {
    kind: 'desktop',
    fetchImpl,
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}

function seedApproved(db: UserDb): void {
  db.installApp({ appId: APP, displayName: 'Net App', html: '<p>net</p>' });
  db.setSecret(`auth:${APP}:${SLOT}:api_key`, 'stored-key-abc123');
  db.putDeclaredConnection(APP, SLOT, apiKeyRequirement, 'inference');
  db.approveConnection(APP, SLOT);
}

const netFrame = {
  v: 1,
  type: 'snug:net-request',
  requestId: 'r1',
  instanceId: 'ins-1',
  url: 'https://api.example.com/v1/data',
  method: 'GET',
} as const;

describe('platform fetch — the net handler path (AC1 half 1)', () => {
  it('createNetHandlerFor with NO fetch option routes through the platform fetch, never page fetch', async () => {
    const platform = recordingFetch();
    const { db, net } = await fresh(desktopPlatform(platform.impl));
    seedApproved(db);
    const pageFetch = vi.spyOn(globalThis, 'fetch');

    const handler = net.createNetHandlerFor();
    const result = await handler.handle(APP, netFrame);

    expect(result.ok).toBe(true);
    expect(platform.calls, 'the desktop fetch must carry the request').toHaveLength(1);
    expect(platform.calls[0]!.url).toBe('https://api.example.com/v1/data');
    // The executor's injection still ran ABOVE the transport — the seam swaps transports,
    // never gates: the stored key rode the platform fetch exactly as it rides page fetch.
    const headers = (platform.calls[0]!.init.headers ?? {}) as Record<string, string>;
    const key = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-api-key')?.[1];
    expect(key).toBe('stored-key-abc123');
    expect(pageFetch, 'page fetch must not be touched when the platform supplies one').not.toHaveBeenCalled();
    pageFetch.mockRestore();
  });

  it('an explicit fetchImpl option still wins over the platform fetch (the e2e-stub seam survives)', async () => {
    const platform = recordingFetch();
    const injected = recordingFetch();
    const { db, net } = await fresh(desktopPlatform(platform.impl));
    seedApproved(db);

    const handler = net.createNetHandlerFor({ fetchImpl: injected.impl });
    await handler.handle(APP, netFrame);

    expect(injected.calls).toHaveLength(1);
    expect(platform.calls).toHaveLength(0);
  });

  it('web default unchanged: with NO platform set, page fetch carries the request (AC10)', async () => {
    const { db, net } = await fresh();
    seedApproved(db);
    const pageFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const handler = net.createNetHandlerFor();
    const result = await handler.handle(APP, netFrame);

    expect(result.ok).toBe(true);
    expect(pageFetch).toHaveBeenCalledTimes(1);
    pageFetch.mockRestore();
  });
});

describe('platform fetch — the wizard probe path (AC1 half 2)', () => {
  it('testConnection() with no args reaches the platform fetch through the SAME deps assembly', async () => {
    const platform = recordingFetch();
    const { db, net, wizard } = await fresh(desktopPlatform(platform.impl));
    seedApproved(db);
    void net; // the shared assembly is what is under test — reached via the wizard

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    const outcome = await wizard.testConnection();

    expect(outcome.ok).toBe(true);
    expect(platform.calls, 'the probe must ride the platform fetch when one is set').toHaveLength(1);
    expect(platform.calls[0]!.url).toBe('https://api.example.com/v1/ping');
  });
});

describe('platform transport policy — Decision 6 threading', () => {
  it('threads lanHttpPrivate=true into the executor deps as the transportPolicy seat', async () => {
    const platform = recordingFetch();
    const { db, net } = await fresh(desktopPlatform(platform.impl));
    const deps = net.connectedFetchDepsFor(db);
    expect(deps.transportPolicy).toEqual({ allowHttpForPrivateHosts: true });
  });

  it('web default: NO transportPolicy seat at all — the browser profile is untouched', async () => {
    const { db, net } = await fresh();
    const deps = net.connectedFetchDepsFor(db);
    expect(deps.transportPolicy).toBeUndefined();
  });
});
