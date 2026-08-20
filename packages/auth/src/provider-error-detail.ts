/**
 * PROVIDER ERROR TEXT — the one place a provider's error bytes become forwardable prose.
 *
 * Two seats need this and they need it for DIFFERENT reasons, which is why it lives here
 * rather than in either of them:
 *
 *   1. `connected-fetch`'s auth-shaped-failure observer, reading the gate-10-scrubbed
 *      delivered body to fill a ≤160-char `detail` for the wizard's attention gate.
 *   2. `oauth-service`'s token/refresh/revoke POST, whose non-2xx response is RAW
 *      transport bytes on a path where the scrubber has no candidate set at all
 *      (injection throws before one is built) and could not match the leaking values
 *      anyway (they are POST BODY parameters — `refresh_token`, `client_secret` — which
 *      were never injected headers). See TASK-20260820 audit finding D2.
 *
 * THIS FUNCTION IS NOT A CREDENTIAL GUARD. It bounds VOLUME (160 chars) and SHAPE (a
 * named field of a recognized error envelope, or nothing) — it decides which FIELD is
 * forwarded, and it does not and cannot decide what that field CONTAINS. A provider that
 * echoes a submitted secret inside `error_description` — the very field a reader wants —
 * would be forwarded verbatim. That was a real Gate-5 finding against the first cut of
 * seat 2, where this shape allowlist was mistaken for a value guard.
 *
 * THE VALUE SCRUB IS THE CONTROL, and every caller must supply the candidate set only it
 * can build:
 *   - seat 1 receives a body gate 10 already scrubbed against that request's injected
 *     credentials;
 *   - seat 2 scrubs against the `URLSearchParams` it just submitted, which is the one
 *     place those POST-body values are known at all.
 * Scrub first, extract second — a secret straddling the 160-char cut must be redacted
 * rather than half-forwarded. Removing either bound on the belief that the other covers
 * it reopens the leak; they cover different value sets, not the same one twice.
 */

import { scrubAuthValues } from './scrub.js';

/** TASK-20260815 AC4: max chars of provider error text forwarded to a caller. */
export const MAX_AUTH_FAILURE_DETAIL_CHARS = 160;

/**
 * Bodies above this size yield no detail at all. A real provider error envelope is a
 * few hundred bytes; a delivered body can be up to the 1 MiB gate-10 cap, and parsing
 * a megabyte of JSON to pull 160 chars on every credentialed 401/403 is work an
 * adversarial or verbose provider gets to bill us for (Gate-5 review, efficiency).
 */
export const MAX_AUTH_FAILURE_BODY_CHARS = 8_192;

/**
 * Extract a short human-readable reason from a provider error body.
 *
 * Recognized shapes, in order: Spotify's `{"error":{"message":…}}`, RFC 6749
 * `error_description`, a bare `message` string, a bare `error` string. Everything
 * structured-but-unrecognized yields NOTHING — raw JSON in a banner is noise, not
 * diagnosis — and the Gate-5 review found the first cut leaking exactly that: a
 * MALFORMED `{` body (a >1 MiB JSON error truncated mid-token by gate 10 no longer
 * parses) fell through to the text head, and JSON ARRAYS (Hue CLIP v1 errors),
 * JSON strings and `)]}'`-guarded bodies skipped the JSON branch entirely. So: a `{`
 * body parses or yields nothing, and a body opening with `[`, `<`, `"` or `)` is
 * structure/markup, never prose. Plain text becomes the head, hard-capped — a
 * plain-text reason like "quota exceeded" is exactly the honesty a banner wants.
 *
 * `scrubCandidates` is OPTIONAL only so the no-secrets case stays byte-identical; every
 * caller that has a candidate set must pass it. See the note above `cap` for why passing
 * it matters even when the caller already scrubbed the input.
 *
 * A NOTE THAT WAS WRONG AND IS WORTH KEEPING CORRECTED: an earlier version of this
 * comment argued the plain-text branch was safe because "an OAuth endpoint echoing
 * submitted parameters does so inside a JSON or HTML envelope, both of which are handled
 * above". HTML is refused, but JSON is *not* handled — it is the shape most likely to be
 * FORWARDED, since a provider puts its echo inside `error_description`, exactly the field
 * a reader wants. Shape recognition chooses a field; it never vouches for the field's
 * contents. Only the scrub does that.
 */
export function extractProviderErrorDetail(
  body: string,
  scrubCandidates?: Record<string, string>,
): string | undefined {
  if (body.length > MAX_AUTH_FAILURE_BODY_CHARS) return undefined;
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  // Re-scrub what we RETURN, not only what the caller handed in. `JSON.parse` below
  // decodes `\u` escapes, so a secret the caller correctly scrubbed out of the raw text
  // can be reconstituted here, character-for-character, inside a recognized field. The
  // decode is this function's own act, so the responsibility for undoing its effect is
  // this function's too — a seat that scrubs on the way in should not have to know that
  // a decode happens downstream of it.
  const cap = (text: string): string =>
    (scrubCandidates === undefined ? text : scrubAuthValues(text, scrubCandidates)).slice(
      0,
      MAX_AUTH_FAILURE_DETAIL_CHARS,
    );
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const error = parsed['error'];
      const candidates: unknown[] = [
        typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['message'] : undefined,
        parsed['error_description'],
        parsed['message'],
        typeof error === 'string' ? error : undefined,
      ];
      const hit = candidates.find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      );
      return hit !== undefined ? cap(hit.trim()) : undefined;
    } catch {
      // Malformed or truncated JSON: brace noise is not a diagnosis.
      return undefined;
    }
  }
  if ('[<")'.includes(trimmed[0]!)) return undefined;
  return cap(trimmed);
}
