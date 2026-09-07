// AC3 / AC4 / AC6 — the network side of the executor (ADR-0068 §1).
//
// What this proxy is: the seam Snug Desktop fills with `plugin-http`, written in Node. It
// receives a request the page's executor has ALREADY gated and injected, so it is
// TRANSIT-ONLY — it handles credential values because forwarding them is its job, and it
// never logs, persists, echoes or exposes them. ("Value-blind" is taken: the repo defines
// it as `packages/runner` never importing the credential layer at all, proven by a source
// lint. This process imports it deliberately.)
//
// The gates below are the executor's OWN gates run a second time, on the far side of a
// socket anything on this machine can open. They are not a new policy, which is why there
// is deliberately NO resolved-address check here: the executor's gate 5 is literal-only
// (`net-guards.ts`), and adding resolution would be a policy the desktop does not have.

import { isForbiddenNetHost } from '@snugprotocol/auth/dist/net-guards.js';
import { isForbiddenNetHost as barrelGuard } from '@snugprotocol/auth';
import { LIMITS } from '@snugprotocol/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createFetchProxy, PROXY_TIMEOUT_MS, type ProxyRequest } from '../fetch-proxy.js';

const CANARY = 'sk-live-CANARY-4a91f0c7d2e8';

/** A request shaped as the page's `fetchImpl` sends it, credentials already injected. */
const req = (over: Partial<ProxyRequest> = {}): ProxyRequest => ({
  url: 'https://api.example.com/v1/things',
  method: 'GET',
  headers: { authorization: `Bearer ${CANARY}` },
  body: undefined,
  ...over,
});

/** A fake `node:https`-shaped transport: one call in, one scripted answer out. */
function fakeTransport(answer: {
  status?: number;
  headers?: Record<string, string | string[]>;
  chunks?: Uint8Array[];
  error?: Error;
  hang?: boolean;
}) {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string> } }> = [];
  const send = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }, onChunk: (c: Uint8Array) => boolean) => {
    calls.push({ url, init });
    if (answer.error !== undefined) throw answer.error;
    if (answer.hang === true) await new Promise(() => {});
    for (const chunk of answer.chunks ?? []) {
      // `onChunk` returns false once the cap is exceeded — the transport must stop.
      if (!onChunk(chunk)) return { status: answer.status ?? 200, headers: answer.headers ?? {}, aborted: true };
    }
    return { status: answer.status ?? 200, headers: answer.headers ?? {}, aborted: false };
  });
  return { send, calls };
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('the guard is IMPORTED, never re-implemented', () => {
  it('uses the very function packages/auth exports (identity, not equivalence)', () => {
    // D-B30: the bundle deep-imports to keep sql.js and the provider registry out, so this
    // asserts the deep path and the public export are the SAME binding. A second copy of
    // the SSRF table would drift the day the package learns a new form.
    expect(isForbiddenNetHost).toBe(barrelGuard);
  });
});

describe('the re-checks (the executor’s own gates, run twice)', () => {
  it('refuses a plain-http target before any socket opens', async () => {
    const t = fakeTransport({});
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req({ url: 'http://api.example.com/x' }));
    expect(out.ok).toBe(false);
    expect(t.send).not.toHaveBeenCalled();
  });

  it.each([
    ['loopback', 'https://127.0.0.1/x'],
    ['loopback by name', 'https://localhost/x'],
    ['private', 'https://192.168.1.10/x'],
    ['link-local metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['ipv6 loopback', 'https://[::1]/x'],
    ['.local suffix', 'https://printer.local/x'],
  ])('refuses a %s target with a NET_INVALID_REQUEST-class code and opens no socket', async (_label, url) => {
    const t = fakeTransport({});
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req({ url }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('NET_INVALID_REQUEST');
    expect(t.send).not.toHaveBeenCalled();
  });

  it('returns a 3xx as DATA and never follows it', async () => {
    // The executor refuses the redirect itself (connected-fetch gate 9); the proxy's job
    // is to make sure the hop never happened — a followed redirect would carry the
    // injected header to a host outside the frozen ceiling.
    const t = fakeTransport({ status: 302, headers: { location: 'https://evil.example/steal' } });
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.status).toBe(302);
    expect(t.send).toHaveBeenCalledTimes(1); // one hop, not two
  });

  it('drops Set-Cookie on the way back', async () => {
    const t = fakeTransport({ headers: { 'set-cookie': 'session=abc', 'content-type': 'application/json' } });
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const names = out.headers.map(([n]) => n.toLowerCase());
      expect(names).not.toContain('set-cookie');
      expect(names).toContain('content-type');
    }
  });

  it('trips the cap WHILE READING at the protocol’s own limit and discards the bytes', async () => {
    // D-B17: this is the load-bearing copy of the cap. The page-side executor also caps,
    // but a reconstructed Response has already fully materialised there — only here can
    // the read actually be stopped.
    const cap = LIMITS.MAX_NET_RESPONSE_BODY_BYTES;
    const half = new Uint8Array(Math.ceil(cap / 2) + 1);
    const t = fakeTransport({ chunks: [half, half, half] });
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('NET_SIZE_EXCEEDED');
  });

  it('passes a body just under the cap', async () => {
    const t = fakeTransport({ chunks: [new Uint8Array(LIMITS.MAX_NET_RESPONSE_BODY_BYTES - 1)] });
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req());
    expect(out.ok).toBe(true);
  });
});

describe('the wall clock', () => {
  it('is STRICTLY GREATER than the executor’s 60s so the executor owns the sentence', () => {
    // D-B20. At a tie, whichever timer fires first is a scheduling race; when the process
    // wins, `timeoutSignal.aborted` is false in the page and the user reads the transport's
    // spelling instead of "the provider did not answer within 60s". This is the defect
    // next-steps already records for the LAN leg, in the other direction.
    expect(PROXY_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it('names itself when it fires', async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransport({ hang: true });
      const proxy = createFetchProxy({ send: t.send });
      const pending = proxy.handle(req());
      await vi.advanceTimersByTimeAsync(PROXY_TIMEOUT_MS + 10);
      const out = await pending;
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toMatch(/did not answer within \d+s/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('C1 — the credential is in transit and nowhere else', () => {
  it('forwards the injected header verbatim to the provider', async () => {
    const t = fakeTransport({});
    const proxy = createFetchProxy({ send: t.send });
    await proxy.handle(req());
    expect(t.calls[0]?.init.headers.authorization).toBe(`Bearer ${CANARY}`);
  });

  it('scrubs the credential out of a transport error message', async () => {
    // Fetch errors routinely embed the request URL and sometimes the headers; this message
    // crosses back to the page and thence to the app.
    const t = fakeTransport({ error: new Error(`connect ECONNREFUSED while sending Bearer ${CANARY}`) });
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).not.toContain(CANARY);
      expect(out.message).toContain('***');
    }
  });

  it('scrubs a credential the PROVIDER echoes back in the body', async () => {
    const t = fakeTransport({ chunks: [utf8(JSON.stringify({ echoed: `Bearer ${CANARY}` }))] });
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req());
    expect(out.ok).toBe(true);
    if (out.ok) expect(Buffer.from(out.bodyBase64, 'base64').toString('utf8')).not.toContain(CANARY);
  });

  it('scrubs a credential echoed in a RESPONSE HEADER value', async () => {
    const t = fakeTransport({ headers: { etag: `W/"${CANARY}"`, 'content-type': 'text/plain' } });
    const proxy = createFetchProxy({ send: t.send });
    const out = await proxy.handle(req());
    expect(out.ok).toBe(true);
    if (out.ok) expect(JSON.stringify(out.headers)).not.toContain(CANARY);
  });

  it('writes NOTHING anywhere — no console, no sink — on a successful call', async () => {
    // The canary grep in the e2e covers logs and the lock file; this is the unit-level
    // twin, and it fails loudly if someone adds a debug `console.log(url)`.
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    try {
      const t = fakeTransport({ chunks: [utf8('{"ok":true}')] });
      const proxy = createFetchProxy({ send: t.send });
      await proxy.handle(req());
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('does not retain the request after answering (no history to leak)', async () => {
    const t = fakeTransport({ chunks: [utf8('x')] });
    const proxy = createFetchProxy({ send: t.send });
    await proxy.handle(req());
    expect(JSON.stringify(proxy)).not.toContain(CANARY);
  });
});
