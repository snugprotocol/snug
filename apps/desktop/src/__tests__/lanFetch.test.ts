// The webview half of the pinned-TLS LAN transport (ADR-0023 D3; P0 amendment 6).
//
// The Rust side owns every DECISION (host class, pin match, redirect policy,
// size cap) and is tested at its own boundary in src-tauri/src/lanfetch.rs.
// What this file owns is the TRANSLATION, and the two ways a translation layer
// silently breaks a guard:
//
//   1. it drops something on the way IN — an injected credential header that
//      never arrives, or a mode string that turns a pinned call into a
//      trust-anything one;
//   2. it launders something on the way OUT — a Rust refusal turned into a
//      synthetic Response, or a 30x turned into a followed hop, either of which
//      makes the executor's gate 9 see a success where there was a refusal.
//
// The 2026-08-12 lesson is the reason both directions get tests rather than a
// glance: the desktop redirect incident was exactly a translation layer quietly
// declining to carry a guard it was handed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let invokeResult: unknown = { status: 200, headers: {}, body: '{"ok":true}' };
let invokeError: unknown = null;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    invokeCalls.push({ cmd, args });
    if (invokeError !== null) throw invokeError;
    return invokeResult;
  }),
}));

const { lanFetch, lanPair } = await import('../lan-fetch.js');

const PIN = 'a'.repeat(64);
const URL_ = 'https://192.168.1.50/clip/v2/resource/light';

beforeEach(() => {
  invokeCalls.length = 0;
  invokeError = null;
  invokeResult = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
});

describe('lanFetch — the executor-facing seam', () => {
  it('invokes lan_fetch in PINNED mode, carrying the pin verbatim', async () => {
    await lanFetch(URL_, { method: 'GET', headers: {} }, PIN);

    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0]?.cmd).toBe('lan_fetch');
    expect(invokeCalls[0]?.args.mode, 'the executor path is ALWAYS pinned mode').toBe('pinned');
    expect(invokeCalls[0]?.args.pin).toBe(PIN);
    expect(invokeCalls[0]?.args.url).toBe(URL_);
  });

  it('carries the injected credential headers through — a dropped header is a 401 nobody can explain', async () => {
    await lanFetch(URL_, { method: 'GET', headers: { 'hue-application-key': 'minted-key' } }, PIN);
    expect(invokeCalls[0]?.args.headers).toEqual({ 'hue-application-key': 'minted-key' });
  });

  it('normalizes a Headers instance and an entry array, not just a plain object', async () => {
    await lanFetch(URL_, { method: 'GET', headers: new Headers({ 'hue-application-key': 'k1' }) }, PIN);
    expect(invokeCalls[0]?.args.headers).toEqual({ 'hue-application-key': 'k1' });

    await lanFetch(URL_, { method: 'GET', headers: [['hue-application-key', 'k2']] }, PIN);
    expect(invokeCalls[1]?.args.headers).toEqual({ 'hue-application-key': 'k2' });
  });

  it('carries the method and a string body for a mutating request', async () => {
    await lanFetch(URL_, { method: 'PUT', body: '{"on":{"on":true}}', headers: {} }, PIN);
    expect(invokeCalls[0]?.args.method).toBe('PUT');
    expect(invokeCalls[0]?.args.body).toBe('{"on":{"on":true}}');
  });

  it('defaults an absent method to GET rather than sending undefined', async () => {
    await lanFetch(URL_, { headers: {} }, PIN);
    expect(invokeCalls[0]?.args.method).toBe('GET');
  });

  it('omits the body key entirely when there is none (never `body: undefined`)', async () => {
    await lanFetch(URL_, { method: 'GET', headers: {} }, PIN);
    expect(Object.prototype.hasOwnProperty.call(invokeCalls[0]?.args ?? {}, 'body')).toBe(false);
  });

  it('returns the status and body as a Response the executor reads like any other', async () => {
    invokeResult = { status: 207, headers: { 'content-type': 'application/json' }, body: '{"data":[1]}' };
    const response = await lanFetch(URL_, { method: 'GET', headers: {} }, PIN);
    expect(response.status).toBe(207);
    expect(await response.text()).toBe('{"data":[1]}');
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('passes a 30x back INTACT — the executor refuses it, this layer never follows it', async () => {
    // Rust installs Policy::none(), so a redirect arrives as a status. Turning
    // it into anything else here would hide gate 9's refusal.
    invokeResult = { status: 302, headers: { location: 'https://evil.example/steal' }, body: '' };
    const response = await lanFetch(URL_, { method: 'GET', headers: {} }, PIN);
    expect(response.status).toBe(302);
  });

  it('REJECTS when Rust refuses — a refusal is never laundered into a Response', async () => {
    // A synthetic 4xx here would make a host-class or pin refusal look like the
    // DEVICE said no, and the executor would deliver it to the app as ok:true.
    invokeError = "'8.8.8.8' is not a private network address";
    await expect(lanFetch('https://8.8.8.8/api', { method: 'GET', headers: {} }, PIN)).rejects.toBeTruthy();
  });

  it('sends no `danger` / accept-invalid flag of any kind', async () => {
    // The trust decision is the pin, inside a rustls verifier. A flag here would
    // be the guard-as-flag failure mode this whole design exists to avoid.
    await lanFetch(URL_, { method: 'GET', headers: {} }, PIN);
    const args = invokeCalls[0]?.args ?? {};
    expect(Object.keys(args).sort()).toEqual(['headers', 'method', 'mode', 'pin', 'url']);
  });
});

describe('lanPair — the wizard-only pairing exchange', () => {
  it('invokes PAIR mode and sends NO pin (there is nothing recorded yet)', async () => {
    invokeResult = {
      status: 200,
      headers: {},
      body: '[{"success":{"username":"minted"}}]',
      pin: { fingerprint: PIN, cn: 'ECB5FAFFFE123456' },
    };
    await lanPair('https://192.168.1.50/api', { method: 'POST', body: '{"devicetype":"snug#hub"}' });

    expect(invokeCalls[0]?.args.mode).toBe('pair');
    expect(Object.prototype.hasOwnProperty.call(invokeCalls[0]?.args ?? {}, 'pin')).toBe(false);
  });

  it('returns the CAPTURED pin beside the response, so the wizard writes both in one step', async () => {
    invokeResult = {
      status: 200,
      headers: {},
      body: '[{"success":{"username":"minted"}}]',
      pin: { fingerprint: PIN, cn: 'ECB5FAFFFE123456' },
    };
    const result = await lanPair('https://192.168.1.50/api', { method: 'POST', body: '{}' });

    expect(result.pin).toEqual({ fingerprint: PIN, cn: 'ECB5FAFFFE123456' });
    expect(result.body).toContain('minted');
    expect(result.status).toBe(200);
  });

  it('a pair response with NO captured pin yields no pin key — never a fabricated one', async () => {
    // If the verifier never ran (an error path), the wizard must see the
    // absence and refuse to record, not store an empty fingerprint that would
    // later fail every pinned request with a mystifying error.
    invokeResult = { status: 200, headers: {}, body: '[]' };
    const result = await lanPair('https://192.168.1.50/api', { method: 'POST', body: '{}' });
    expect(Object.prototype.hasOwnProperty.call(result, 'pin')).toBe(false);
  });

  it('is NOT reachable through the platform seam — pairing is a wizard step, not a request path', async () => {
    // `lanPair` is exported for the wizard alone. The platform contributes only
    // `lanFetch`, so the executor has no way to reach pair mode: a request-time
    // fallback to accept-and-capture would silently trust anything answering at
    // the address.
    const platform = await import('../platform-desktop.js');
    const src = platform as unknown as Record<string, unknown>;
    expect(Object.keys(src)).not.toContain('lanPair');
  });
});

// THE WIRING ITSELF (added after a surviving mutant — the P5-shape lane's
// lesson, one lane later: a guard that survives its own deletion is decoration).
//
// Deleting `lanFetch,` from the desktop platform object left all 80 tests green,
// because every other test in this file drives the module function directly and
// the playground's wiring suite stubs the platform rather than building the real
// one. Nothing asserted that the SHELL hands the executor this transport — which
// is the one fact that makes the whole lane reachable in production.
describe('the desktop platform actually exposes the transport (wiring, not just the function)', () => {
  it('createDesktopPlatform() carries lanFetch, and it is THE module function', async () => {
    // The identity check is what makes this more than "some function is
    // present": a locally-defined wrapper that forgot the pin, or an
    // accidentally-rebound `fetchImpl`, would satisfy a typeof check and fail
    // this one.
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();
    expect(platform.lanFetch).toBe(lanFetch);
  });

  it('lanFetch and fetchImpl are DIFFERENT transports on the platform', async () => {
    // The tempting simplification — pointing lanFetch at the plugin fetch —
    // would verify the bridge against the public root store and refuse every
    // real device, while every type check stayed green.
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();
    expect(platform.lanFetch).not.toBe(platform.fetchImpl);
  });

  it('the platform declares the LAN capability that makes the executor route to it', async () => {
    // Half-on states are the failure mode: a transport nothing routes to, or a
    // policy with no transport behind it. Both come from this one object.
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();
    expect(platform.capabilities.lanHttpPrivate).toBe(true);
    expect(platform.lanFetch).toBeTypeOf('function');
  });
});
