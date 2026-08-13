// Desktop native-fetch transport contract (TASK-20260812 review finding 1).
//
// WHY THIS FILE EXISTS — the redirect gap, stated once:
//
// connected-fetch passes `redirect: 'manual'` (packages/auth connected-fetch.ts
// gate 9) and oauth-service's `postForm` relies on the same for its B2 guard
// ("a credential POST never follows a redirect"). In the BROWSER that is enough.
// In the SHELL it is not: `@tauri-apps/plugin-http`'s JS shim reads exactly four
// fields off `init` — maxRedirections, connectTimeout, proxy, danger — and never
// looks at `init.redirect`. Whatever `redirect` says is dropped on the floor by
// `new Request(input, init)` on the way to Rust. Rust then sets
// `Policy::none()` ONLY when maxRedirections == Some(0); otherwise reqwest's
// default `Policy::limited(10)` silently follows up to ten hops. reqwest strips
// only Authorization / Cookie / Proxy-Authorization across hosts — every
// INJECTED custom header (X-API-Key, HMAC signature seats) rides along. An open
// redirect on an APPROVED host would therefore hand a connection's credential to
// an attacker host while the executor sees only the final 200.
//
// So on desktop, 'manual' MUST be expressed as `maxRedirections: 0`. These tests
// pin that on every outbound call the platform makes, and they are what a future
// plugin upgrade has to keep green: if a newer shim starts honouring
// `init.redirect`, re-prove it here before dropping the explicit field.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCalls: Array<{ input: unknown; init: Record<string, unknown> | undefined }> = [];

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async (input: unknown, init?: Record<string, unknown>) => {
    // Snapshot the init the platform handed the plugin. The real shim MUTATES
    // init (it `delete`s maxRedirections & friends before building the Request),
    // so a shallow copy at call time is the only faithful record.
    fetchCalls.push({ input, init: init === undefined ? undefined : { ...init } });
    return new Response('{"models":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  }),
}));

// Tauri IPC is absent under vitest; the platform only touches it lazily
// (export/opened-files), so a throwing stub keeps construction honest.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('no IPC in vitest');
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));

const { createDesktopPlatform } = await import('../platform-desktop.js');

describe('desktop fetch transport: redirects are never followed', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
  });

  it('carries maxRedirections: 0 on a connected-fetch style call', async () => {
    const platform = createDesktopPlatform();
    expect(platform.fetchImpl).toBeTypeOf('function');

    await platform.fetchImpl?.('https://api.example.test/v2/accounts', {
      method: 'GET',
      headers: { 'X-API-Key': 'injected-secret' },
      redirect: 'manual',
    });

    expect(fetchCalls).toHaveLength(1);
    const [call] = fetchCalls;
    // The load-bearing assertion: 'manual' alone is inert against this plugin.
    expect(call?.init?.maxRedirections).toBe(0);
  });

  it('carries maxRedirections: 0 on a credential POST (oauth postForm shape)', async () => {
    const platform = createDesktopPlatform();

    await platform.fetchImpl?.('https://idp.example.test/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=abc',
      redirect: 'manual',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.maxRedirections).toBe(0);
  });

  it('carries maxRedirections: 0 even when the caller passes NO init at all', async () => {
    const platform = createDesktopPlatform();

    await platform.fetchImpl?.('https://api.example.test/ping');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init?.maxRedirections).toBe(0);
  });

  // The Ollama probe does NOT go through `fetchImpl` — it calls the plugin
  // directly (platform-desktop.ts `probeOllama`). This test states that fact so
  // it can never drift silently: if the probe is ever re-pointed at fetchImpl,
  // or at a non-loopback endpoint, this assertion is where it surfaces.
  //
  // Why the gap is tolerable TODAY and not a second instance of finding 1: the
  // probe targets a hardcoded `http://127.0.0.1:11434` loopback URL, injects no
  // credential, and reads only model names (threat-model delta §3.5 already
  // books it as an accepted residual outside the connected-fetch guards). A
  // redirect from a local Ollama could still send the probe elsewhere, but it
  // carries nothing worth stealing. Tighten it if the probe ever gains headers.
  it('documents that the Ollama probe bypasses fetchImpl (loopback, no credential)', async () => {
    const platform = createDesktopPlatform();

    await platform.probeOllama?.();

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0]?.input)).toBe('http://127.0.0.1:11434/api/tags');
    // No injected headers ⇒ a followed redirect leaks no credential.
    expect(fetchCalls[0]?.init?.headers).toBeUndefined();
  });

  it('leaves every other init field untouched (the merge is additive)', async () => {
    const platform = createDesktopPlatform();
    const signal = AbortSignal.timeout(5_000);
    const headers = { 'X-API-Key': 'injected-secret', accept: 'application/json' };

    await platform.fetchImpl?.('https://api.example.test/v2/accounts', {
      method: 'POST',
      headers,
      body: 'payload',
      redirect: 'manual',
      signal,
    });

    const init = fetchCalls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual(headers);
    expect(init?.body).toBe('payload');
    expect(init?.signal).toBe(signal);
    // `redirect` is kept as the portable statement of intent even though this
    // plugin ignores it — the browser profile and any future shim read it.
    expect(init?.redirect).toBe('manual');
  });

  it('does not mutate the caller-owned init object', async () => {
    const platform = createDesktopPlatform();
    const callerInit: RequestInit = { method: 'GET', redirect: 'manual' };

    await platform.fetchImpl?.('https://api.example.test/v2/accounts', callerInit);

    expect('maxRedirections' in (callerInit as Record<string, unknown>)).toBe(false);
    expect(fetchCalls[0]?.init?.maxRedirections).toBe(0);
  });

  it('still applies the gate host remap to the URL', async () => {
    const { installGateRemap } = await import('../net-remap.js');
    installGateRemap({ remap: { 'api.example.test': 'http://127.0.0.1:43120' } });
    try {
      const platform = createDesktopPlatform();
      await platform.fetchImpl?.('https://api.example.test/v2/accounts', { redirect: 'manual' });
      expect(String(fetchCalls[0]?.input)).toBe('http://127.0.0.1:43120/v2/accounts');
      expect(fetchCalls[0]?.init?.maxRedirections).toBe(0);
    } finally {
      installGateRemap(null);
    }
  });
});
