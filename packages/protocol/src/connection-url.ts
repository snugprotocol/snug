/**
 * Connection-relative addressing (ADR-0026, TASK-20260814-hue-starter-real-connection).
 *
 * `snug-connection://<slot><pathAndQuery>` lets an app name its CONNECTION instead of a
 * host it cannot know — the executor resolves the slot to the connection's single
 * frozen-ceiling host and runs every existing gate on the result. This module owns the
 * GRAMMAR and nothing else: no resolution, no host, no policy. The grammar lives in
 * `packages/protocol` because it is contract, not implementation (C3) — the same reason
 * the frame schemas live here.
 *
 * THE THREE-WAY RESULT IS THE CONTRACT:
 *  - `not-connection-url` — the string does not carry the scheme; callers fall through
 *    to the literal-URL path UNTOUCHED. This arm is what keeps every existing app
 *    byte-identical.
 *  - `malformed` — the app TRIED to write a connection URL and got it wrong (bad slot,
 *    missing path, smuggling shapes). Refused loudly by the caller, never guessed at:
 *    collapsing this arm into the previous one would turn typos into mystifying
 *    scheme-blocked refusals three gates later.
 *  - `ok` — a slot the SLOT RULE admits plus an opaque `pathAndQuery`.
 *
 * WHAT THE PARSER REFUSES, and why each is load-bearing:
 *  - A slot outside `CONNECTION_SLOT_RULE` — IMPORTED, never restated, so an
 *    addressable slot is by definition a declarable one and the two grammars cannot
 *    drift (Gate-2 review advisory).
 *  - A missing path: apps address resources, not devices; there is no meaningful "root
 *    request" to default to.
 *  - A `//` path opener, a backslash, a fragment: the resolved URL is
 *    `https://<host><pathAndQuery>`, and each of these is a smuggling or ambiguity
 *    shape a strict refusal is cheaper than reasoning about. (`@` and `:` inside the
 *    slot fall out of the slot rule itself.)
 *
 * The scheme match is CASE-INSENSITIVE (URL schemes are, per RFC 3986); everything
 * after it is matched exactly — slots are lowercase by rule.
 */

import { CONNECTION_SLOT_RULE } from './connection-requirement.js';

export const CONNECTION_URL_SCHEME = 'snug-connection:';

export type ConnectionUrlParse =
  | { ok: true; slot: string; pathAndQuery: string }
  | { ok: false; reason: 'not-connection-url' | 'malformed' };

export function parseConnectionUrl(url: string): ConnectionUrlParse {
  const schemeEnd = CONNECTION_URL_SCHEME.length;
  if (url.slice(0, schemeEnd).toLowerCase() !== CONNECTION_URL_SCHEME) {
    return { ok: false, reason: 'not-connection-url' };
  }
  if (url.slice(schemeEnd, schemeEnd + 2) !== '//') return { ok: false, reason: 'malformed' };
  const rest = url.slice(schemeEnd + 2);
  const slashIndex = rest.indexOf('/');
  if (slashIndex === -1) return { ok: false, reason: 'malformed' };
  const slot = rest.slice(0, slashIndex);
  const pathAndQuery = rest.slice(slashIndex);
  if (!CONNECTION_SLOT_RULE.test(slot)) return { ok: false, reason: 'malformed' };
  if (pathAndQuery.startsWith('//')) return { ok: false, reason: 'malformed' };
  if (pathAndQuery.includes('\\') || pathAndQuery.includes('#')) return { ok: false, reason: 'malformed' };
  return { ok: true, slot, pathAndQuery };
}
