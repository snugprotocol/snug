// Hub account state (child 5 playground half): /auth/me drives the store; a hub
// without an auth surface degrades to 'unavailable' (UI hides the account card);
// logout echoes the double-submit CSRF header from the snug_csrf cookie.

import { describe, expect, it } from 'vitest';

import { authStore, logout, readCsrfToken, refreshAuth } from '../state/auth.js';

describe('refreshAuth', () => {
  it('maps 200 → signed-in with the user payload', async () => {
    const state = await refreshAuth(async () =>
      new Response(JSON.stringify({ userId: 'u1', email: 'j@example.com', name: 'Jeetu' }), { status: 200 }),
    );
    expect(state).toEqual({ state: 'signed-in', user: { userId: 'u1', email: 'j@example.com', name: 'Jeetu' } });
    expect(authStore.get()).toEqual(state);
  });

  it('maps 401 → anonymous and 404/network → unavailable', async () => {
    expect(await refreshAuth(async () => new Response('', { status: 401 }))).toEqual({ state: 'anonymous' });
    expect(await refreshAuth(async () => new Response('', { status: 404 }))).toEqual({ state: 'unavailable' });
    expect(await refreshAuth(() => Promise.reject(new Error('down')))).toEqual({ state: 'unavailable' });
  });
});

describe('logout', () => {
  it('sends the x-snug-csrf header read from the snug_csrf cookie', async () => {
    document.cookie = 'snug_csrf=tok-123';
    expect(readCsrfToken()).toBe('tok-123');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await logout(async (url, init) => {
      calls.push({ url, init });
      return new Response('', { status: url === '/auth/me' ? 401 : 204 });
    });
    const logoutCall = calls.find((c) => c.url === '/auth/logout');
    expect(logoutCall?.init?.method).toBe('POST');
    expect((logoutCall?.init?.headers as Record<string, string>)['x-snug-csrf']).toBe('tok-123');
    expect(authStore.get()).toEqual({ state: 'anonymous' });
  });
});
