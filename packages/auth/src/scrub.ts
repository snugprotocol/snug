/**
 * Response scrubber — ported from an ancestor system's auth-fetch (AL-03 plan D4).
 *
 * Threat model: the app (or a prompt-injected LLM driving it) controls the URL within
 * the frozen host ceiling. If it targets a debug/echo endpoint on an approved host,
 * the provider reflects our injected `Authorization`/`X-Api-Key` values back into the
 * response. The executor therefore redacts every injected header VALUE — from the body
 * AND from each whitelisted response header value (amendment R1) — before the frame
 * crosses the bridge.
 *
 * Strategy mirrors the source system: exact-substring replacement with `***` via
 * split/join (safe against ReDoS and accidental regex wildcards). Bearer/Basic/Token
 * schemes also scrub the bare token portion (echo endpoints often split the scheme).
 * Values shorter than 4 chars are skipped (false-positive prone, not real secrets).
 *
 * DOCUMENTED BOUNDARY (amendment A3 — a named forward-constraint for AL-11's threat
 * model): only exact substrings are matched. A provider that RE-ENCODES the value
 * (base64, hex, URL-escaping) defeats the scrubber; the frozen allowlist remains the
 * primary wall. `scrub.test.ts` pins this boundary honestly.
 */
export function scrubAuthValues(text: string, authHeaders: Record<string, string>): string {
  if (!text) return text;
  let out = text;
  const seen = new Set<string>();
  for (const value of Object.values(authHeaders)) {
    if (!value || typeof value !== 'string') continue;
    const candidates: string[] = [value];
    const schemed = /^(Bearer|Basic|Token|Digest|Negotiate)\s+(.+)$/i.exec(value);
    if (schemed?.[2] !== undefined) candidates.push(schemed[2]);
    for (const candidate of candidates) {
      if (candidate.length < 4 || seen.has(candidate)) continue;
      seen.add(candidate);
      if (out.includes(candidate)) out = out.split(candidate).join('***');
    }
  }
  return out;
}
