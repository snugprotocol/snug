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

  it('the exported source is the scanner’s own shape — anchoring it reproduces the whole-value rule', () => {
    const anchored = new RegExp(`^${JWT_SHAPE_SOURCE}$`);
    expect(anchored.test(JWT)).toBe(true);
    expect(anchored.test('eyJ.short.x')).toBe(false);
    expect(anchored.test(`${JWT} trailing`)).toBe(false);
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
