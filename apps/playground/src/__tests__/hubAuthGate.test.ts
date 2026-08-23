// hubAuth flag gate — TASK-20260822-feedback-loop AC5 (ADR-0052 §5): the Google
// SSO surface is hidden STRUCTURALLY by default. Before this gate the absence of
// sign-in on the static deploy was probe-dependent (/auth/me 404 → 'unavailable');
// now the probe itself does not fire unless the platform opts in — so a static
// host that happened to answer 401 can no longer conjure a sign-in button.
//
// getPlatform() locks on first read (the documented platform test trap), so every
// case builds fresh modules and installs its platform before importing the store.

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

async function freshAuth(platform?: SnugPlatform): Promise<typeof import('../state/auth.js')> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  return import('../state/auth.js');
}

const flagOn: SnugPlatform = {
  kind: 'web',
  capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, hubAuth: true },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hubAuth off (the default)', () => {
  it('refreshAuth resolves unavailable WITHOUT probing — even a 401-answering host shows no sign-in', async () => {
    const auth = await freshAuth();
    const fetchSpy = vi.fn(async () => new Response('', { status: 401 }));
    const state = await auth.refreshAuth(fetchSpy);
    expect(state).toEqual({ state: 'unavailable' });
    expect(auth.authStore.get()).toEqual({ state: 'unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('desktop platforms are hard-off too (no hubAuth seat set)', async () => {
    const auth = await freshAuth({
      kind: 'desktop',
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    });
    const fetchSpy = vi.fn(async () => new Response('', { status: 401 }));
    expect(await auth.refreshAuth(fetchSpy)).toEqual({ state: 'unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('hubAuth on (self-hosters, VITE_SNUG_HUB_AUTH=1 at build)', () => {
  it('probes /auth/me and keeps the prior mapping — 401 → anonymous', async () => {
    const auth = await freshAuth(flagOn);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 401 }));
    expect(await auth.refreshAuth(fetchSpy)).toEqual({ state: 'anonymous' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe('/auth/me');
  });

  it('200 → signed-in, unchanged', async () => {
    const auth = await freshAuth(flagOn);
    const state = await auth.refreshAuth(
      async () => new Response(JSON.stringify({ userId: 'u1', name: 'Jeetu' }), { status: 200 }),
    );
    expect(state).toEqual({ state: 'signed-in', user: { userId: 'u1', name: 'Jeetu' } });
  });

  it('the web default reads the build flag', async () => {
    vi.stubEnv('VITE_SNUG_HUB_AUTH', '1');
    const auth = await freshAuth(); // no setPlatform — the WEB_DEFAULT path
    const fetchSpy = vi.fn(async () => new Response('', { status: 401 }));
    expect(await auth.refreshAuth(fetchSpy)).toEqual({ state: 'anonymous' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('login() gate + hub-origin conjunction (Gate-5 findings)', () => {
  it('login() is a no-op when the flag is off — no /auth/login navigation from a hidden surface', async () => {
    const auth = await freshAuth();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, pathname: '/' });
    auth.login();
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('the hub sync origin needs BOTH seats — hubSyncOrigin alone is not enough', async () => {
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform({
      kind: 'web',
      capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false },
    });
    const sync = await import('../state/sync.js');
    expect(sync.hubOriginAvailable()).toBe(false);
  });

  it('…and is available when both are on', async () => {
    vi.resetModules();
    const platformModule = await import('../platform/platform.js');
    platformModule.setPlatform(flagOn);
    const sync = await import('../state/sync.js');
    expect(sync.hubOriginAvailable()).toBe(true);
  });
});
