// AL-03 plan D4 — the response scrubber, ported from an ancestor system's auth-fetch with its
// source tests adapted, plus the amendment R1 property tests: injected values planted
// in WHITELISTED response headers (etag, cache-control, x-ratelimit-*), not just bodies.
// The base64-of-exact-value boundary is DOCUMENTED as not caught — the honest test
// below pins that boundary so AL-11's threat model can cite it (amendment A3).
import { describe, expect, it } from 'vitest';
import { scrubAuthValues } from '../scrub.js';

const HEADERS = { Authorization: 'Bearer secret-token-abc123', 'X-Api-Key': 'key-9876543210' };

describe('scrubAuthValues (ancestor-system port)', () => {
  it('redacts every occurrence of an injected header value from a body', () => {
    const body = 'first secret-token-abc123 then again secret-token-abc123 end';
    const out = scrubAuthValues(body, { Authorization: 'secret-token-abc123' });
    expect(out).toBe('first *** then again *** end');
  });

  it('redacts the token portion of Bearer/Basic schemes when reflected without the prefix', () => {
    const out = scrubAuthValues('{"headers":{"authorization":"Bearer secret-token-abc123","echo":"secret-token-abc123"}}', HEADERS);
    expect(out).not.toContain('secret-token-abc123');
    expect(out).toContain('***');
  });

  it('redacts values embedded inside JSON structures (property: no whole-value survivor)', () => {
    const value = 'sk-live-EXAMPLEVALUE0001';
    const bodies = [
      JSON.stringify({ nested: { deep: [{ echoed: value }] } }),
      `<html><body>${value}</body></html>`,
      `prefix${value}suffix`,
      JSON.stringify({ headers: { 'x-api-key': value } }),
    ];
    for (const body of bodies) {
      expect(scrubAuthValues(body, { 'X-Api-Key': value })).not.toContain(value);
    }
  });

  it('skips values shorter than 4 chars (false-positive guard from the source system)', () => {
    expect(scrubAuthValues('a body with the letter a everywhere', { 'X-Short': 'a' })).toBe(
      'a body with the letter a everywhere',
    );
  });

  it('leaves unrelated text untouched', () => {
    expect(scrubAuthValues('hello world', { 'X-Api-Key': 'something-else-1234' })).toBe('hello world');
  });

  it('handles empty input and empty header sets', () => {
    expect(scrubAuthValues('', HEADERS)).toBe('');
    expect(scrubAuthValues('body', {})).toBe('body');
  });

  it('R1: redacts injected values planted in WHITELISTED response header values', () => {
    // The executor scrubs each whitelisted header value with the same function — this
    // pins the function-level behavior on realistic header-value shapes.
    const token = 'secret-token-abc123';
    const planted: Record<string, string> = {
      etag: `W/"${token}"`,
      'cache-control': `private, max-age=0, note=${token}`,
      'x-ratelimit-remaining': `99;debug=${token}`,
      link: `<https://api.example.com/next?probe=${token}>; rel="next"`,
    };
    for (const [name, value] of Object.entries(planted)) {
      const out = scrubAuthValues(value, HEADERS);
      expect(out, `${name} must not leak the injected value`).not.toContain(token);
      expect(out).toContain('***');
    }
  });

  it('A3 boundary (documented, NOT caught): base64 of the exact value passes through', () => {
    // Named forward-constraint for AL-11's threat model: the scrubber matches exact
    // substrings only. An endpoint that re-encodes the injected value (base64, hex,
    // URL-encoding of non-ASCII) defeats it — the frozen host ceiling is the primary
    // wall; this test keeps the documentation honest rather than claiming coverage.
    const value = 'secret-token-abc123';
    const base64 = btoa(value);
    const out = scrubAuthValues(`echo:${base64}`, { Authorization: value });
    expect(out).toContain(base64);
  });
});
