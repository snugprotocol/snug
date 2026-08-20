/**
 * THE SHARED PROVIDER-ERROR EXTRACTOR — and the decode-after-scrub trap.
 *
 * Two seats forward a short reason from a provider's error body: the auth-shaped-failure
 * observer (reading a gate-10-scrubbed delivered body) and the OAuth token/refresh POST
 * (reading raw transport bytes, scrubbed against the params it just submitted). Both
 * scrub, then extract.
 *
 * The Gate-5 review found that ordering is not sufficient by itself. `JSON.parse` DECODES
 * `\u` escapes, and it runs INSIDE the extractor — after the caller's scrub. So a provider
 * that escapes its echo defeats an exact-substring scrub of the raw text, and the secret
 * is reconstituted character-for-character in the extracted field:
 *
 *   scrub('{"error_description":"key SU..."}', {k: 'SUPER+SECRET/KEY=='})
 *     -> unchanged (the raw text contains no matching substring)
 *   extract(...)  -> "key SUPER+SECRET/KEY=="        <- cleartext, on both seats
 *
 * This is NOT the documented re-encoding boundary (`scrub.ts:16-19`). That boundary covers
 * a value arriving in a genuinely DIFFERENT form — base64, hex — which no exact-substring
 * matcher can be expected to catch. Here the value arrives in the SAME form after a decode
 * step WE perform; the scrub was simply on the wrong side of it.
 *
 * The fix belongs in the extractor rather than at each call site, because the decode is the
 * extractor's own act: a seat that scrubs correctly on the way in should not have to know
 * that a decode happens downstream. `extractProviderErrorDetail` therefore takes the
 * candidate set and re-scrubs what it returns.
 */

import { describe, expect, it } from 'vitest';
import { extractProviderErrorDetail } from '../provider-error-detail.js';
import { scrubAuthValues } from '../scrub.js';

const SECRET = 'SUPER+SECRET/KEY==';
const CANDIDATES = { 'x-api-key': SECRET };

/** Every char as `\uXXXX` — legal JSON that decodes back to the exact secret. */
const escaped = (s: string): string =>
  [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

/** What a caller does: scrub the raw body, then extract from it. */
const deliver = (raw: string): string | undefined =>
  extractProviderErrorDetail(scrubAuthValues(raw, CANDIDATES), CANDIDATES);

describe('extractProviderErrorDetail — a decode inside the extractor cannot resurrect a secret', () => {
  it('a \\u-escaped echo in a recognized JSON field is not reconstituted in cleartext', () => {
    const detail = deliver(`{"error_description":"rejected key ${escaped(SECRET)}"}`);

    expect(detail).not.toContain(SECRET);
    // Not vacuous — the surrounding reason must survive, or a fix that returned nothing
    // would satisfy the assertion above while destroying the diagnosis.
    expect(detail).toContain('rejected key');
  });

  it('holds for the nested Spotify-shaped field too', () => {
    const detail = deliver(`{"error":{"message":"bad ${escaped(SECRET)}"}}`);

    expect(detail).not.toContain(SECRET);
    expect(detail).toContain('bad');
  });

  it('a verbatim echo is still scrubbed by the caller, as before', () => {
    const detail = deliver(`{"error_description":"rejected key ${SECRET}"}`);

    expect(detail).not.toContain(SECRET);
  });

  it('is a no-op when no candidates are supplied — the seat decides what is secret', () => {
    // The extractor never invents a candidate set; a caller with nothing to scrub gets
    // the same behaviour it always had.
    expect(extractProviderErrorDetail('{"error_description":"plain reason"}')).toBe('plain reason');
  });

  it('still refuses the shapes it always refused', () => {
    expect(extractProviderErrorDetail('<html>error</html>', CANDIDATES)).toBeUndefined();
    expect(extractProviderErrorDetail('{"blob":"unrecognized"}', CANDIDATES)).toBeUndefined();
    expect(extractProviderErrorDetail('{ truncated', CANDIDATES)).toBeUndefined();
    expect(extractProviderErrorDetail('   ', CANDIDATES)).toBeUndefined();
  });

  it('still caps the forwarded reason at 160 chars', () => {
    const long = 'x'.repeat(500);
    expect(extractProviderErrorDetail(`{"error_description":"${long}"}`)?.length).toBe(160);
  });
});
