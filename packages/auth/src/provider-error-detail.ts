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
 * THIS FUNCTION IS HALF OF THE BOUND, NEVER THE WHOLE OF IT. It is an allowlist of
 * recognized error-envelope SHAPES: it decides which FIELD is forwarded, and it does not
 * and cannot decide what that field CONTAINS. A provider that echoes a submitted secret
 * inside `error_description` — the very field a reader wants — is forwarded verbatim.
 * That was a real Gate-5 finding against the first cut of seat 2, where the shape
 * allowlist was mistaken for a value guard.
 *
 * So EVERY caller must scrub values before calling, and each does it with the candidate
 * set only it can build:
 *   - seat 1 receives a body gate 10 already scrubbed against that request's injected
 *     credentials;
 *   - seat 2 scrubs against the `URLSearchParams` it just submitted, which is the one
 *     place those POST-body values are known at all.
 * Scrub first, extract second — a secret straddling the 160-char cut must be redacted
 * rather than half-forwarded. Removing either bound on the belief that the other covers
 * it reopens the leak; they cover different value sets, not the same one twice.
 */

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
 * NOTE for the raw-bytes caller (seat 2): the plain-text branch forwards a bounded head
 * of a body that opened with none of the structural markers. That is deliberate and it
 * is safe for the reason the whole function is safe — an OAuth endpoint echoing
 * submitted parameters does so inside a JSON or HTML envelope, both of which are
 * handled above; a body that is bare prose from the first character is a human-authored
 * reason string. It is capped at 160 chars regardless.
 */
export function extractProviderErrorDetail(body: string): string | undefined {
  if (body.length > MAX_AUTH_FAILURE_BODY_CHARS) return undefined;
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  const cap = (text: string): string => text.slice(0, MAX_AUTH_FAILURE_DETAIL_CHARS);
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
