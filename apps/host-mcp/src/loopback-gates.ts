// Who may speak to the data plane (D-B18).
//
// The listener binds 127.0.0.1 on a fixed port, so "reachable" already means "on this
// machine". What is left to decide is which BROWSER CONTEXT a request came from — and the
// answer is not the one the plan first assumed.
//
// MEASURED 2026-09-07, headless Chromium under `--host-resolver-rules=MAP evil.test
// 127.0.0.1`: after a DNS rebind the attacker's page is same-origin in the browser's eyes.
// Its GET arrived with NO `Origin` and NO `Sec-Fetch-Site` at all; its POST carried
// `Origin: http://evil.test:<port>`. The only header naming the attacker in both cases was
// `Host`. So `Host` is the wall, and the original "the Host header is never consulted" is
// reversed: a browser always sends the name from the URL bar and a page cannot forge it.
//
// Two more measured facts shape the rest:
//  * A different PORT on 127.0.0.1 reads as `same-site`, not `cross-site` — port is not
//    part of a "site". Only the literal `same-origin` may pass, or every other loopback
//    service on the machine becomes a launcher into this data plane.
//  * Safari implements no `Sec-Fetch-*` at all, and `Origin` is omitted on same-origin GET.
//    So neither may be REQUIRED: requiring them 403s every legitimate GET (`/events`, the
//    userdb read leg) on the default browser of a Mac. The bearer is the guard; these are
//    the second proof where the browser offers one.
//
// None of this binds a non-browser client: `curl` sends whatever it likes. Against another
// process running as this user the bearer is the only guard, and that is the standard
// desktop trust boundary — recorded in the ADR rather than papered over.

import { timingSafeEqual } from 'node:crypto';

export interface InboundRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
}

export interface GateContext {
  port: number;
  token: string;
}

export type GateResult = { ok: true } | { ok: false; status: 401 | 403 };

/** Constant-time compare. Hygiene rather than a defence — a local attacker has better options. */
function secretEquals(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function bearerOf(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers.authorization;
  if (raw === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(raw);
  return match?.[1];
}

/**
 * The one admission decision for every data-plane route (`/fetch`, `/userdb/*`, `/events`,
 * `/v1/*`). Bodies are deliberately empty on refusal: a 401 that explains itself tells a
 * prober which half it got right.
 */
export function admitDataPlaneRequest(request: InboundRequest, context: GateContext): GateResult {
  const served = `127.0.0.1:${context.port}`;
  const origin = `http://${served}`;

  // A preflight is answered without CORS headers, so the real request never follows. It is
  // refused here rather than admitted-and-ignored so no route can accidentally grow one.
  if (request.method === 'OPTIONS') return { ok: false, status: 403 };

  // THE BEARER FIRST — it is the actual guard, and requiring it is also what forces every
  // data-plane route through a CORS preflight. A route reachable by a SIMPLE request (auth
  // in a cookie or a query parameter) would let a foreign page fire the side effect blind,
  // unable to read the answer but perfectly able to cause it.
  if (!secretEquals(bearerOf(request.headers), context.token)) return { ok: false, status: 401 };

  // THE HOST — the rebinding wall.
  if (request.headers.host !== served) return { ok: false, status: 403 };

  // Where the browser sends them, these must agree. Where it does not, `Host` has already
  // proven the origin.
  const sentOrigin = request.headers.origin;
  if (sentOrigin !== undefined && sentOrigin !== origin) return { ok: false, status: 403 };

  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return { ok: false, status: 403 };

  return { ok: true };
}
