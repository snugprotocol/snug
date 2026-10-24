// TASK-20261023-siwc-chatgpt-plan L0 (AC10, plan D3): the JWT shape has ONE home. The C1
// scanner already tests whole values against it (`scanForCredentialValues`, anchored); the
// Responses adapter's error-body backstop and the playground inspector's display redaction
// need the SAME shape found INSIDE text (unanchored, global). Two regexes written by hand
// in two packages would drift the day one is widened (lesson L191: one home for a shape), so
// the source pattern is exported and both consumers build from it.
import { describe, expect, it } from 'vitest';

import { JWT_SHAPE_SOURCE, jwtShapeInText, scanForCredentialValues } from '../index.js';

// A token-shaped triple: header.payload.signature, each segment base64url and long enough.
const JWT = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImF1ZCI6WyJvYWlhcHAiXX0.c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIz';

describe('L0 — the JWT shape is single-homed in the protocol (AC10, lesson L191)', () => {
  it('the scanner still rejects a bare JWT value on the whole-value rule (behaviour unchanged)', () => {
    const scan = scanForCredentialValues({ token: JWT });
    expect(scan.rejects).toEqual([{ path: 'token', reason: 'jwt-shape' }]);
  });

  it('the scanner is still anchored: a JWT embedded in prose is NOT a whole-value reject (R-24 stays honest)', () => {
    const scan = scanForCredentialValues({ note: `use ${JWT} please` });
    expect(scan.rejects.filter((f) => f.reason === 'jwt-shape')).toEqual([]);
  });

  it('the exported source and the scanner’s whole-value rule agree for segments up to 4 096 characters; the scanner also accepts longer ones (S7)', () => {
    const anchored = new RegExp(`^${JWT_SHAPE_SOURCE}$`);
    const whole = (value: string): boolean => scanForCredentialValues({ v: value }).rejects.some((f) => f.reason === 'jwt-shape');
    for (const value of [JWT, 'eyJ.short.x', `${JWT} trailing`, `eyJ${'A'.repeat(4093)}.${'B'.repeat(4096)}.${'C'.repeat(4096)}`, 'eyJabcdefgh.ijklmnop.qrstuvwx', 'eyJabcdefgh.ijklmnop']) {
      expect(whole(value), value.slice(0, 40)).toBe(anchored.test(value));
    }
    // Beyond the in-text matcher's bound the two part ways on purpose: the scanner is unbounded.
    const long = `eyJ${'A'.repeat(4094)}.${'B'.repeat(4096)}.${'C'.repeat(4096)}`;
    expect(anchored.test(long)).toBe(false);
    expect(whole(long)).toBe(true);
  });

  it('jwtShapeInText finds the token inside prose, after a Bearer scheme, inside JSON and glued to `=`', () => {
    const inputs = [
      `Incorrect API key provided: ${JWT}. You can find your key at …`,
      `Authorization: Bearer ${JWT}`,
      `{"error":{"message":"bad token ${JWT}"}}`,
      `token=${JWT}&x=1`,
    ];
    for (const text of inputs) {
      expect(text.replace(jwtShapeInText(), '***'), text).not.toContain(JWT);
      expect(text.replace(jwtShapeInText(), '***')).toContain('***');
    }
  });

  it('jwtShapeInText replaces EVERY occurrence (global), not just the first', () => {
    const twice = `${JWT} and again ${JWT}`;
    expect(twice.replace(jwtShapeInText(), '***')).toBe('*** and again ***');
  });

  it('jwtShapeInText leaves short `eyJ…` fragments and ordinary prose alone', () => {
    for (const text of ['eyJ', 'eyJabc.def.ghi', 'the key eyJ was short', 'Basic authentication failed']) {
      expect(text.replace(jwtShapeInText(), '***')).toBe(text);
    }
  });

  it('every call returns a FRESH regex — a shared global regex would carry lastIndex between callers', () => {
    const a = jwtShapeInText();
    const b = jwtShapeInText();
    expect(a).not.toBe(b);
    expect(a.flags).toContain('g');
    // Exercise `a` so its lastIndex moves; `b` must be unaffected.
    a.test(`x ${JWT}`);
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(b.lastIndex).toBe(0);
  });
});

describe('§12 L5-7 — the shape is BOUNDED so every consumer stays linear on large payloads', () => {
  // Measured by the L5 test lane on Node 22 (2026-10-24): the unbounded `[\\w-]{8,}` segments made
  // `jwtShapeInText()` throw "Maximum call stack size exceeded" over an 8 MiB unbroken `eyJ…` run
  // (V8's backtracking stack). A real JWT segment is a few KB; a megabyte run is not a token.
  it('an 8 MiB unbroken `eyJ…` run completes and is NOT matched (no stack overflow)', () => {
    const run = `eyJ${'a'.repeat(8 * 1024 * 1024)}`;
    expect(run.replace(jwtShapeInText(), '***')).toBe(run);
    expect(scanForCredentialValues({ blob: run }).rejects).toEqual([]);
  });

  it('a 4 096-character segment still matches; a 4 097-character one does not', () => {
    const seg = (n: number): string => 'A'.repeat(n);
    const within = `eyJ${seg(4093)}.${seg(4096)}.${seg(4096)}`; // header segment incl. its `eyJ` prefix = 4 096
    const beyond = `eyJ${seg(4094)}.${seg(4096)}.${seg(4096)}`;
    expect(within.replace(jwtShapeInText(), '***')).toBe('***');
    expect(beyond.replace(jwtShapeInText(), '***')).toBe(beyond);
  });
});

describe('S7 — the ANCHORED whole-value rule is not weakened by the bound', () => {
  // Measured at Gate 5: with the whole-value rule built from the bounded source, a JWT whose payload
  // ran past 4 096 characters sailed through the C1 scanner. A whole value is judged by splitting on
  // `.` into exactly three `[\w-]` segments of at least 8 characters, the first a JSON header — a
  // charset walk, linear, no length limit — while the in-text matcher keeps its bound.
  const seg = (ch: string, n: number): string => ch.repeat(n);

  it('a JWT with a 5 KB payload is REJECTED by the scanner', () => {
    const big = `eyJ${seg('A', 29)}.${seg('B', 5 * 1024)}.${seg('C', 43)}`;
    expect(scanForCredentialValues({ token: big }).rejects).toEqual([{ path: 'token', reason: 'jwt-shape' }]);
    expect(scanForCredentialValues({ note: big }).rejects).toEqual([{ path: 'note', reason: 'jwt-shape' }]);
  });

  it('the rule is still exact: a bad character, a fourth segment, a short segment, or a non-`eyJ` head is not a token', () => {
    for (const value of [
      `eyJ${seg('A', 29)}.${seg('B', 5000)}.${seg('C', 43)}.extra`,
      `eyJ${seg('A', 29)}.${seg('B', 5000)}=.${seg('C', 43)}`,
      `eyJ${seg('A', 29)}.${seg('B', 5000)}.short`,
      `ABC${seg('A', 29)}.${seg('B', 5000)}.${seg('C', 43)}`,
      `eyJ${seg('A', 29)}.${seg('B', 5000)}.${seg('C', 43)} `,
    ]) {
      expect(scanForCredentialValues({ v: value }).rejects.filter((f) => f.reason === 'jwt-shape'), value.slice(0, 40)).toEqual([]);
    }
  });

  it('an 8 MiB value still completes: an unbroken run is not a token, a dotted one is judged linearly', () => {
    const run = `eyJ${'a'.repeat(8 * 1024 * 1024)}`;
    expect(scanForCredentialValues({ blob: run }).rejects).toEqual([]);
    const dotted = `eyJ${'a'.repeat(4 * 1024 * 1024)}.${'b'.repeat(4 * 1024 * 1024)}.${'c'.repeat(64)}`;
    expect(scanForCredentialValues({ blob: dotted }).rejects).toEqual([{ path: 'blob', reason: 'jwt-shape' }]);
    const broken = `eyJ${'a'.repeat(4 * 1024 * 1024)}.${'b'.repeat(4 * 1024 * 1024)}!.${'c'.repeat(64)}`;
    expect(scanForCredentialValues({ blob: broken }).rejects.filter((f) => f.reason === 'jwt-shape')).toEqual([]);
  });
});
