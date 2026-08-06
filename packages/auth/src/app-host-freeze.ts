/**
 * Host-freeze predicates — IProject's pure ⊆ check ported (AL-02 plan D7), plus the
 * outbound-ceiling membership test the OAuth service runs before EVERY token/refresh/
 * revoke POST (plan D5/N2b: a spec whose refresh host escaped the frozen ceiling
 * cannot refresh). The freeze itself is enforced at the db write boundary
 * (`HostFreezeViolation` in @snugprotocol/db) — these are the pure halves both sides
 * of the seam share.
 *
 * Matching is EXACT hostname, case-insensitive. No suffix or parent-domain matching:
 * `api.spotify.com.evil.com` and `spotify.com` are both outside a ceiling of
 * `api.spotify.com`. Empty sets fail closed. There is no strictness knob anywhere in
 * this package (C1 / finding 4) — strict is the only mode that exists.
 */

import { normalizeAuthHost } from '@snugprotocol/protocol';

/** The submitted hosts NOT present in the declared set (case-insensitive ⊆ check). */
export function undeclaredHosts(submitted: readonly string[], declared: readonly string[]): string[] {
  const declaredSet = new Set(declared.map(normalizeAuthHost));
  return submitted.filter((host) => !declaredSet.has(normalizeAuthHost(host)));
}

/** True when `host` is exactly one of `allowedHosts` (case-insensitive). */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const target = normalizeAuthHost(host);
  return allowedHosts.some((allowed) => normalizeAuthHost(allowed) === target);
}

/** True when the URL parses AND its hostname is within `allowedHosts`. Fails closed. */
export function isUrlWithinHosts(url: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return isHostAllowed(host, allowedHosts);
}
