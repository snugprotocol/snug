// AC6 — the inbound trust rule for the loopback data plane (D-B18).
//
// WHY `Host` IS THE WALL, measured 2026-09-07 with headless Chromium under
// `--host-resolver-rules=MAP evil.test 127.0.0.1`: after a DNS rebind the attacker's page
// is same-origin in the browser's eyes, so its GET arrives with NO `Origin` and NO
// `Sec-Fetch-Site` at all, and its POST carries `Origin: http://evil.test:<port>`. The one
// header that names the attacker in both cases is `Host`. The original plan said the Host
// header is never consulted; that would have left the data plane open to any domain an
// attacker points at 127.0.0.1. This file pins the reversal.
//
// Two further measured facts pinned here: a different PORT on 127.0.0.1 reads as
// `same-site` (so only the literal `same-origin` may pass), and every data-plane route must
// require a header that forces a CORS preflight — a route reachable by a SIMPLE request
// lets a foreign page cause the side effect it cannot read.

import { describe, expect, it } from 'vitest';

import { admitDataPlaneRequest, type InboundRequest } from '../loopback-gates.js';

const PORT = 43127;
const TOKEN = 'a'.repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const inbound = (over: Partial<InboundRequest> = {}): InboundRequest => ({
  method: 'POST',
  path: '/fetch',
  headers: {
    host: `127.0.0.1:${PORT}`,
    authorization: `Bearer ${TOKEN}`,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  },
  ...over,
});

const admit = (over: Partial<InboundRequest> = {}) => admitDataPlaneRequest(inbound(over), { port: PORT, token: TOKEN });

describe('the bearer', () => {
  it('admits the right one', () => {
    expect(admit()).toEqual({ ok: true });
  });

  it('401s a missing bearer, with no body detail', () => {
    const headers = { ...inbound().headers };
    delete headers.authorization;
    expect(admit({ headers })).toEqual({ ok: false, status: 401 });
  });

  it('401s a wrong bearer', () => {
    expect(admit({ headers: { ...inbound().headers, authorization: `Bearer ${'b'.repeat(64)}` } })).toEqual({ ok: false, status: 401 });
  });

  it('401s a bearer of the right length that differs in one character', () => {
    const near = `${'a'.repeat(63)}b`;
    expect(admit({ headers: { ...inbound().headers, authorization: `Bearer ${near}` } })).toEqual({ ok: false, status: 401 });
  });

  it('does not accept the token in the query string — logs and Referer carry query strings', () => {
    const headers = { ...inbound().headers };
    delete headers.authorization;
    expect(admit({ path: `/fetch?token=${TOKEN}`, headers })).toEqual({ ok: false, status: 401 });
  });
});

describe('the Host header is the rebinding wall', () => {
  it('403s a rebound POST — Origin names the attacker', () => {
    expect(
      admit({
        headers: { ...inbound().headers, host: 'evil.test:43127', origin: 'http://evil.test:43127' },
      }),
    ).toEqual({ ok: false, status: 403 });
  });

  it('403s a rebound GET — the shape the browser actually sent: no Origin, no Sec-Fetch-Site', () => {
    // This is the measured case. With `Host` unconsulted and no other header present,
    // nothing would have distinguished this from a legitimate same-origin GET.
    expect(
      admit({
        method: 'GET',
        path: '/events',
        headers: { host: 'evil.test:43127', authorization: `Bearer ${TOKEN}` },
      }),
    ).toEqual({ ok: false, status: 403 });
  });

  it('403s a Host naming the right port on the wrong name', () => {
    expect(admit({ headers: { ...inbound().headers, host: `localhost:${PORT}` } })).toEqual({ ok: false, status: 403 });
  });

  it('403s a Host on the wrong port', () => {
    expect(admit({ headers: { ...inbound().headers, host: '127.0.0.1:1' } })).toEqual({ ok: false, status: 403 });
  });

  it('403s a missing Host', () => {
    const headers = { ...inbound().headers };
    delete headers.host;
    expect(admit({ headers })).toEqual({ ok: false, status: 403 });
  });
});

describe('Origin and Sec-Fetch-Site, where the browser sends them', () => {
  it('admits a same-origin GET that carries NEITHER — Safari sends no Sec-Fetch-*, and Origin is omitted on same-origin GET', () => {
    // The rule cannot REQUIRE either one: doing so 403s every legitimate GET on the
    // default browser of a Mac. `Host` has already proven the origin by this point.
    expect(admit({ method: 'GET', path: '/events', headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` } })).toEqual({ ok: true });
  });

  it('403s a foreign Origin even when Host is right (a stale tab, an extension)', () => {
    expect(admit({ headers: { ...inbound().headers, origin: 'https://evil.example' } })).toEqual({ ok: false, status: 403 });
  });

  it('403s `same-site` — a DIFFERENT PORT on 127.0.0.1 reads as same-site, not cross-site', () => {
    // Measured. Port is not part of a "site", so accepting `same-site` would open every
    // other loopback service on the machine (a dev server, Jupyter, another app) as a
    // launcher into this data plane.
    expect(admit({ headers: { ...inbound().headers, origin: `http://127.0.0.1:${PORT + 1}`, 'sec-fetch-site': 'same-site' } })).toEqual({
      ok: false,
      status: 403,
    });
  });

  it('403s cross-site', () => {
    expect(admit({ headers: { ...inbound().headers, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } })).toEqual({ ok: false, status: 403 });
  });
});

describe('every data-plane route forces a CORS preflight', () => {
  it('refuses a simple-request shape — no bearer header means no preflight, and no preflight means a foreign page can fire it blind', () => {
    // The bearer requirement is what forces the preflight; this test states the property
    // directly so a future route that moves auth into a cookie or a query param fails here
    // rather than silently becoming reachable from any page on the internet.
    const headers = { host: `127.0.0.1:${PORT}`, 'content-type': 'text/plain' };
    expect(admit({ headers })).toEqual({ ok: false, status: 401 });
  });

  it('answers a preflight OPTIONS without CORS headers, so the real request never follows', () => {
    const out = admitDataPlaneRequest(inbound({ method: 'OPTIONS' }), { port: PORT, token: TOKEN });
    expect(out).toEqual({ ok: false, status: 403 });
  });
});
