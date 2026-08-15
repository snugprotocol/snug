// TASK-20260814-hue-starter-real-connection (ADR-0026 §1) — the connection-relative
// URL grammar, written RED-FIRST at Gate 3.
//
// ONE parser, protocol-owned, strict: `snug-connection://<slot><pathAndQuery>`. The
// slot grammar is CONNECTION_SLOT_RULE — imported by the parser, asserted here — so an
// addressable slot is by definition a declarable one (the Gate-2 review's drift guard:
// a restated grammar could make a legit slot unaddressable).
//
// THE THREE-WAY RESULT is the contract: `not-connection-url` (fall through to the
// literal-URL path untouched), `malformed` (the app TRIED to write a connection URL and
// got it wrong — refuse loudly, never guess), and `ok`. A parser that collapsed the
// first two would either swallow typos into mystifying scheme-blocked refusals or
// hijack literal URLs.

import { describe, expect, it } from 'vitest';

import { CONNECTION_URL_SCHEME, parseConnectionUrl } from '../connection-url.js';
import { CONNECTION_SLOT_RULE } from '../connection-requirement.js';

describe('ADR-0026 §1 — parseConnectionUrl', () => {
  it('parses the canonical shape into slot + pathAndQuery', () => {
    const parsed = parseConnectionUrl('snug-connection://hue/clip/v2/resource/room');
    expect(parsed).toEqual({ ok: true, slot: 'hue', pathAndQuery: '/clip/v2/resource/room' });
  });

  it('keeps the query string with the path — one opaque remainder', () => {
    const parsed = parseConnectionUrl('snug-connection://hue/clip/v2/resource/light?page=2&x=a%20b');
    expect(parsed).toEqual({ ok: true, slot: 'hue', pathAndQuery: '/clip/v2/resource/light?page=2&x=a%20b' });
  });

  it('a scheme-looking string INSIDE the path is just path — the host can only ever come from the ceiling', () => {
    const parsed = parseConnectionUrl('snug-connection://hue/https://evil.example/steal');
    expect(parsed).toEqual({ ok: true, slot: 'hue', pathAndQuery: '/https://evil.example/steal' });
  });

  it('the scheme match is case-insensitive — an uppercase scheme is the same request, not a literal URL', () => {
    const parsed = parseConnectionUrl('SNUG-CONNECTION://hue/clip/v2/resource/room');
    expect(parsed).toEqual({ ok: true, slot: 'hue', pathAndQuery: '/clip/v2/resource/room' });
  });

  it('anything not carrying the scheme is not-connection-url — the literal path is untouched', () => {
    for (const url of [
      'https://api.example.com/v1',
      'http://192.168.1.50/api',
      'snugconnection://hue/x',
      'snug-connection-extra://hue/x',
      '',
    ]) {
      expect(parseConnectionUrl(url)).toEqual({ ok: false, reason: 'not-connection-url' });
    }
  });

  it('the scheme WITHOUT the authority form is malformed — the app tried and missed', () => {
    for (const url of ['snug-connection:hue/x', 'snug-connection:/hue/x', 'snug-connection://']) {
      expect(parseConnectionUrl(url)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it.each([
    ['an empty slot', 'snug-connection:///clip/v2'],
    ['an uppercase slot', 'snug-connection://HUE/clip/v2'],
    ['a slot with @', 'snug-connection://hue@evil/clip'],
    ['a slot with a port-looking colon', 'snug-connection://hue:443/clip'],
    ['a slot with a backslash', 'snug-connection://hu\\e/clip'],
    ['a slot starting with a hyphen', 'snug-connection://-hue/clip'],
    ['a 41-character slot (rule caps at 40)', `snug-connection://${'a'.repeat(41)}/clip`],
    ['a missing path', 'snug-connection://hue'],
    ['a double-slash path opener', 'snug-connection://hue//evil.example/x'],
    ['a backslash in the path', 'snug-connection://hue/clip\\v2'],
    ['a fragment', 'snug-connection://hue/clip#frag'],
  ])('refuses %s as malformed', (_label, url) => {
    expect(parseConnectionUrl(url)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('every slot the rule admits is addressable, and every slot it refuses is not — the SAME rule, by identity', () => {
    // The parser must consult CONNECTION_SLOT_RULE itself; equivalence is pinned by
    // sampling both sides of the rule's own boundary.
    for (const slot of ['a', 'hue', 'hue-2', '0slot', 'a'.repeat(40)]) {
      expect(CONNECTION_SLOT_RULE.test(slot), `${slot} must be a legal slot`).toBe(true);
      expect(parseConnectionUrl(`snug-connection://${slot}/x`)).toEqual({ ok: true, slot, pathAndQuery: '/x' });
    }
    for (const slot of ['A', '-a', 'a_b', 'a'.repeat(41)]) {
      expect(CONNECTION_SLOT_RULE.test(slot), `${slot} must be an illegal slot`).toBe(false);
      expect(parseConnectionUrl(`snug-connection://${slot}/x`)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('exports the scheme constant the executor and docs share', () => {
    expect(CONNECTION_URL_SCHEME).toBe('snug-connection:');
  });
});
