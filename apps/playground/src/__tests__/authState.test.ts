// Hub account state (child 5 playground half): /auth/me drives the store; a hub
// without an auth surface degrades to 'unavailable' (UI hides the account card);
// logout echoes the double-submit CSRF header from the snug_csrf cookie.
//
// Since TASK-20260822-feedback-loop (ADR-0052 §5) the probe is FLAG-GATED off by
// default, so this suite installs a hubAuth-enabled platform before importing the
// store — these are the self-hoster (flag-on) mappings; the gate itself and the
// default-off behavior are pinned in hubAuthGate.test.ts.

import { beforeAll, describe, expect, it, vi } from 'vitest';

let auth: typeof import('../state/auth.js');

beforeAll(async () => {
  vi.resetModules();
  const { setPlatform } = await import('../platform/platform.js');
  setPlatform({
    kind: 'web',
    capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, hubAuth: true },
  });
  auth = await import('../state/auth.js');
});

describe('refreshAuth', () => {
  it('maps 200 → signed-in with the user payload', async () => {
    const state = await auth.refreshAuth(
      async () => new Response(JSON.stringify({ userId: 'u1', email: 'j@example.com', name: 'Jeetu' }), { status: 200 }),
    );
    expect(state).toEqual({ state: 'signed-in', user: { userId: 'u1', email: 'j@example.com', name: 'Jeetu' } });
    expect(auth.authStore.get()).toEqual(state);
  });

  it('maps 401 → anonymous and 404/network → unavailable', async () => {
    expect(await auth.refreshAuth(async () => new Response('', { status: 401 }))).toEqual({ state: 'anonymous' });
    expect(await auth.refreshAuth(async () => new Response('', { status: 404 }))).toEqual({ state: 'unavailable' });
    expect(await auth.refreshAuth(() => Promise.reject(new Error('down')))).toEqual({ state: 'unavailable' });
  });
});

describe('logout', () => {
  it('sends the x-snug-csrf header read from the snug_csrf cookie', async () => {
    document.cookie = 'snug_csrf=tok-123';
    expect(auth.readCsrfToken()).toBe('tok-123');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await auth.logout(async (url, init) => {
      calls.push({ url, init });
      return new Response('', { status: url === '/auth/me' ? 401 : 204 });
    });
    const logoutCall = calls.find((c) => c.url === '/auth/logout');
    expect(logoutCall?.init?.method).toBe('POST');
    expect((logoutCall?.init?.headers as Record<string, string>)['x-snug-csrf']).toBe('tok-123');
    expect(auth.authStore.get()).toEqual({ state: 'anonymous' });
  });
});
