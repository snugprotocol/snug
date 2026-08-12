// TASK-20260812 P1 (AC5): the transport-agnostic desktop loopback OAuth core. The
// Tauri shell injects the real listener; these tests inject a fake to pin the
// contract: exact `127.0.0.1` URI shape (never `localhost`), recorded-string
// lifecycle across BOTH oauth-service call sites (authorize URL + token exchange,
// even after listener teardown), cancel-old single-flight, STATE_TTL_MS-mirrored
// auto-cancel, delivery-only callback parsing (unsigned peek for channel naming,
// mirroring OAuthCallbackPage — signature/nonce/flowId binding stay downstream in
// `handleCallback`), and honest fixed-port collision errors (never a fallback port).
import { describe, expect, it } from 'vitest';

import { utf8ToBase64Url } from '../base64url.js';
import type { CallbackDelivery } from '../oauth-service.js';
import {
  DESKTOP_FLOW_TTL_MS,
  SNUG_DESKTOP_OAUTH_PORT,
  buildLoopbackRedirectUri,
  createDesktopOAuthTransport,
  type LoopbackListener,
} from '../desktop-transport.js';

// ------------------------------------------------------------------- fixtures

const APP = 'app-spotify';
const FLOW = 'flow-abc123';

/** A state token shaped like `signState`'s output: base64url(JSON).signature. */
function makeState(payload: unknown, signature = 'not-a-real-signature'): string {
  return `${utf8ToBase64Url(JSON.stringify(payload))}.${signature}`;
}

function callbackUrl(port: number, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `http://127.0.0.1:${port}/callback?${search.toString()}`;
}

interface FakeHandle {
  port: number;
  stopped: boolean;
}

/**
 * Fake listener: records every `start` call, binds the requested fixed port (or an
 * ascending ephemeral one), and exposes the handles so tests can assert teardown.
 */
function makeListener(opts: { bindPort?: (fixedPort?: number) => number; failWith?: Error } = {}): {
  listener: LoopbackListener;
  starts: Array<{ fixedPort?: number }>;
  handles: FakeHandle[];
} {
  const starts: Array<{ fixedPort?: number }> = [];
  const handles: FakeHandle[] = [];
  let nextEphemeral = 49152;
  const listener: LoopbackListener = {
    start(startOpts) {
      starts.push(startOpts);
      if (opts.failWith !== undefined) return Promise.reject(opts.failWith);
      const port = opts.bindPort !== undefined ? opts.bindPort(startOpts.fixedPort) : (startOpts.fixedPort ?? nextEphemeral++);
      const handle: FakeHandle = { port, stopped: false };
      handles.push(handle);
      return Promise.resolve({
        port,
        stop: () => {
          handle.stopped = true;
          return Promise.resolve();
        },
      });
    },
  };
  return { listener, starts, handles };
}

function makeTransport(opts: { listener?: LoopbackListener; clock?: () => number } = {}) {
  const fake = makeListener();
  const deliveries: CallbackDelivery[] = [];
  const transport = createDesktopOAuthTransport({
    listener: opts.listener ?? fake.listener,
    onDelivery: (d) => deliveries.push(d),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  });
  return { transport, deliveries, fake };
}

// ------------------------------------------------- 1. fixed-port URI shape

describe('fixed-port posture URI shape', () => {
  it('yields exactly http://127.0.0.1:41420/callback and starts the listener on the pinned port', async () => {
    const { transport, fake } = makeTransport();
    const { redirectUri } = await transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP });
    expect(redirectUri).toBe('http://127.0.0.1:41420/callback');
    expect(fake.starts).toEqual([{ fixedPort: SNUG_DESKTOP_OAUTH_PORT }]);
  });

  it('builder can never emit localhost — always the 127.0.0.1 literal', () => {
    for (const port of [1, 80, 8080, SNUG_DESKTOP_OAUTH_PORT, 49152, 65535]) {
      const uri = buildLoopbackRedirectUri(port);
      expect(uri.startsWith('http://127.0.0.1:')).toBe(true);
      expect(uri.includes('localhost')).toBe(false);
      expect(uri.endsWith('/callback')).toBe(true);
    }
  });

  it('refuses (and tears down) a listener that bound a port other than the registered one', async () => {
    const fake = makeListener({ bindPort: () => 50_000 });
    const { transport } = makeTransport({ listener: fake.listener });
    await expect(transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP })).rejects.toThrow(/41420/);
    expect(fake.handles[0]?.stopped).toBe(true);
  });
});

// ------------------------------- 2. ephemeral posture + recorded-string lifecycle

describe('ephemeral posture recorded-string lifecycle', () => {
  it('starts the listener with no fixedPort and builds the URI from the ACTUAL bound port', async () => {
    const { transport, fake } = makeTransport();
    const { redirectUri } = await transport.beginFlow({ posture: 'loopback', appId: APP });
    expect(fake.starts[0]?.fixedPort).toBeUndefined();
    expect(redirectUri).toBe('http://127.0.0.1:49152/callback');
  });

  it('redirectUri() returns the recorded string byte-identical on repeated calls, including after listener teardown', async () => {
    // The oauth-service two-call-sites invariant: authorize URL (call 1) and token
    // exchange (call 2) must see the SAME bytes — and the exchange happens after the
    // callback already arrived and the listener was torn down.
    const { transport, deliveries, fake } = makeTransport();
    const { redirectUri } = await transport.beginFlow({ posture: 'loopback', appId: APP });
    const first = await transport.redirectUriProvider.redirectUri(APP);
    expect(first).toBe(redirectUri);

    const port = fake.handles[0]?.port ?? 0;
    transport.handleCallbackUrl(callbackUrl(port, { code: 'c0de', state: makeState({ appId: APP, flowId: FLOW }) }));
    expect(deliveries).toHaveLength(1);
    expect(fake.handles[0]?.stopped).toBe(true); // teardown happened between the two calls

    const second = await transport.redirectUriProvider.redirectUri(APP);
    expect(second).toBe(first);
  });

  it('a new flow re-binds and re-records — redirectUri() follows the newest flow', async () => {
    const { transport } = makeTransport();
    const one = await transport.beginFlow({ posture: 'loopback', appId: APP });
    const two = await transport.beginFlow({ posture: 'loopback', appId: APP });
    expect(two.redirectUri).not.toBe(one.redirectUri);
    expect(await transport.redirectUriProvider.redirectUri(APP)).toBe(two.redirectUri);
  });

  it('redirectUri() before any flow throws instead of guessing a URI', async () => {
    const { transport } = makeTransport();
    await expect(async () => transport.redirectUriProvider.redirectUri(APP)).rejects.toThrow(/beginFlow/);
  });
});

// ------------------------------------------------------------- 3. single-flight

describe('single-flight', () => {
  it('beginFlow while a flow is active stops the old listener before binding the new one', async () => {
    const { transport, deliveries, fake } = makeTransport();
    await transport.beginFlow({ posture: 'loopback', appId: APP });
    await transport.beginFlow({ posture: 'loopback', appId: 'app-other' });
    expect(fake.handles[0]?.stopped).toBe(true);
    expect(fake.handles[1]?.stopped).toBe(false);

    // The new flow is live: its callback delivers.
    const port = fake.handles[1]?.port ?? 0;
    transport.handleCallbackUrl(callbackUrl(port, { code: 'c', state: makeState({ appId: 'app-other', flowId: 'f2' }) }));
    expect(deliveries).toHaveLength(1);
  });
});

// ------------------------------------------------------------------- 4. TTL

describe('flow TTL', () => {
  it('mirrors the oauth-service STATE_TTL_MS (10 minutes)', () => {
    expect(DESKTOP_FLOW_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('a callback for a flow older than the TTL auto-cancels: listener stopped, nothing delivered', async () => {
    let now = 1_000;
    const fake = makeListener();
    const deliveries: CallbackDelivery[] = [];
    const transport = createDesktopOAuthTransport({
      listener: fake.listener,
      onDelivery: (d) => deliveries.push(d),
      clock: () => now,
    });
    await transport.beginFlow({ posture: 'loopback', appId: APP });
    now += DESKTOP_FLOW_TTL_MS + 1;
    transport.handleCallbackUrl(callbackUrl(49152, { code: 'c', state: makeState({ appId: APP, flowId: FLOW }) }));
    expect(deliveries).toHaveLength(0);
    expect(fake.handles[0]?.stopped).toBe(true);
  });

  it('a callback at EXACTLY the TTL boundary still delivers (only strictly older expires, like verifyState)', async () => {
    let now = 1_000;
    const fake = makeListener();
    const deliveries: CallbackDelivery[] = [];
    const transport = createDesktopOAuthTransport({
      listener: fake.listener,
      onDelivery: (d) => deliveries.push(d),
      clock: () => now,
    });
    await transport.beginFlow({ posture: 'loopback', appId: APP });
    now += DESKTOP_FLOW_TTL_MS;
    transport.handleCallbackUrl(callbackUrl(49152, { code: 'c', state: makeState({ appId: APP, flowId: FLOW }) }));
    expect(deliveries).toHaveLength(1);
  });

  it('handleCallbackUrl after cancel() is a no-op', async () => {
    const { transport, deliveries, fake } = makeTransport();
    await transport.beginFlow({ posture: 'loopback', appId: APP });
    await transport.cancel();
    expect(fake.handles[0]?.stopped).toBe(true);
    transport.handleCallbackUrl(callbackUrl(49152, { code: 'c', state: makeState({ appId: APP, flowId: FLOW }) }));
    expect(deliveries).toHaveLength(0);
  });

  it('a second callback after a successful delivery is a no-op (one-shot flow)', async () => {
    const { transport, deliveries, fake } = makeTransport();
    await transport.beginFlow({ posture: 'loopback', appId: APP });
    const url = callbackUrl(fake.handles[0]?.port ?? 0, { code: 'c', state: makeState({ appId: APP, flowId: FLOW }) });
    transport.handleCallbackUrl(url);
    transport.handleCallbackUrl(url);
    expect(deliveries).toHaveLength(1);
  });
});

// ------------------------------------------------------- 5. callback parsing

describe('handleCallbackUrl parsing', () => {
  it('delivers {appId, flowId, code, state} parsed from the callback URL', async () => {
    const { transport, deliveries } = makeTransport();
    await transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP });
    const state = makeState({ appId: APP, flowId: FLOW, nonce: 'n', exp: 9e12 });
    transport.handleCallbackUrl(callbackUrl(SNUG_DESKTOP_OAUTH_PORT, { code: 'auth-code-1', state }));
    expect(deliveries).toEqual([{ appId: APP, flowId: FLOW, code: 'auth-code-1', state }]);
  });

  it('missing or empty code delivers nothing', async () => {
    const { transport, deliveries } = makeTransport();
    await transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP });
    const state = makeState({ appId: APP, flowId: FLOW });
    transport.handleCallbackUrl(callbackUrl(SNUG_DESKTOP_OAUTH_PORT, { state }));
    transport.handleCallbackUrl(callbackUrl(SNUG_DESKTOP_OAUTH_PORT, { code: '', state }));
    expect(deliveries).toHaveLength(0);
  });

  it('missing or empty state delivers nothing', async () => {
    const { transport, deliveries } = makeTransport();
    await transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP });
    transport.handleCallbackUrl(callbackUrl(SNUG_DESKTOP_OAUTH_PORT, { code: 'c' }));
    transport.handleCallbackUrl(callbackUrl(SNUG_DESKTOP_OAUTH_PORT, { code: 'c', state: '' }));
    expect(deliveries).toHaveLength(0);
  });

  it('MALFORMED state (unparseable base64url / non-JSON / wrong shape) neither crashes nor delivers', async () => {
    const { transport, deliveries } = makeTransport();
    await transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP });
    const malformed = [
      '!!!not-base64url.sig', // rejected by the base64url alphabet
      `${utf8ToBase64Url('not json at all')}.sig`, // decodes but is not JSON
      makeState({ appId: 42, flowId: FLOW }), // wrong shape: non-string appId
      makeState({ appId: APP }), // wrong shape: missing flowId
      makeState('just-a-string'), // JSON but not an object
    ];
    for (const state of malformed) {
      expect(() =>
        transport.handleCallbackUrl(callbackUrl(SNUG_DESKTOP_OAUTH_PORT, { code: 'c', state })),
      ).not.toThrow();
    }
    expect(deliveries).toHaveLength(0);
  });

  it('a garbage URL string neither crashes nor delivers', async () => {
    const { transport, deliveries } = makeTransport();
    await transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP });
    expect(() => transport.handleCallbackUrl('::::not a url')).not.toThrow();
    expect(deliveries).toHaveLength(0);
  });

  it('does NOT validate the state signature — delivery-only, mirroring OAuthCallbackPage', async () => {
    // The unsigned peek serves appId/flowId channel naming ONLY. Signature, nonce and
    // flowId binding are enforced downstream by `handleCallback` (which the caller
    // feeds its OWN held expectedFlowId). The code-injection-with-VALID-state attack
    // (a local process racing the redirect with its own code) is defeated by provider
    // PKCE binding — which is exactly why the step-B registry test structurally
    // refuses `pkce:false` + a loopback posture.
    const { transport, deliveries } = makeTransport();
    await transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP });
    const forged = makeState({ appId: APP, flowId: FLOW }, 'completely-forged-signature');
    transport.handleCallbackUrl(callbackUrl(SNUG_DESKTOP_OAUTH_PORT, { code: 'attacker-code', state: forged }));
    expect(deliveries).toHaveLength(1); // delivered — and it will DIE in handleCallback's verifyState
  });
});

// --------------------------------------------------------- 6. listener failure

describe('listener start failure', () => {
  it('fixed-port bind failure rejects with an error naming port 41420 — no silent fallback port', async () => {
    const fake = makeListener({ failWith: new Error('EADDRINUSE: address already in use') });
    const { transport } = makeTransport({ listener: fake.listener });
    await expect(transport.beginFlow({ posture: 'loopback-fixed-port', appId: APP })).rejects.toThrow(/41420/);
    expect(fake.starts).toHaveLength(1); // exactly one attempt: a fallback port would break the registered URI
  });

  it('after a failed beginFlow nothing is recorded and callbacks are no-ops', async () => {
    const fake = makeListener({ failWith: new Error('EADDRINUSE') });
    const deliveries: CallbackDelivery[] = [];
    const transport = createDesktopOAuthTransport({ listener: fake.listener, onDelivery: (d) => deliveries.push(d) });
    await expect(transport.beginFlow({ posture: 'loopback', appId: APP })).rejects.toThrow();
    await expect(async () => transport.redirectUriProvider.redirectUri(APP)).rejects.toThrow();
    transport.handleCallbackUrl(callbackUrl(49152, { code: 'c', state: makeState({ appId: APP, flowId: FLOW }) }));
    expect(deliveries).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- cancel

describe('cancel', () => {
  it('stops the listener, clears the recorded URI, and is idempotent', async () => {
    const { transport, fake } = makeTransport();
    await transport.beginFlow({ posture: 'loopback', appId: APP });
    await transport.cancel();
    expect(fake.handles[0]?.stopped).toBe(true);
    await expect(async () => transport.redirectUriProvider.redirectUri(APP)).rejects.toThrow();
    await transport.cancel(); // second cancel: no throw, no second stop target
  });
});
