// The token-claim mint (ADR-0038, TASK-20260818): trade a one-time setup token for a
// permanent basic_auth pair — SimpleFIN's shape, expressed provider-agnostically.
//
// WHY THIS IS A PURE MODULE. The wizard owns session state and the write path; this
// module owns the part that must be provable in isolation: the decode, every refusal,
// the one-shot claim POST, the access-URL parse, and the ADR-0025 verify. The caller
// injects `commit` — its implementation is the write-together act (credentials + the
// `claimVerifiedAt` connected state, one function, no window in which a verified claim
// is not a stored one — the `completeDeviceLink` lesson).
//
// C1: the minted pair reaches exactly ONE seat — `commit`. No result object, success or
// failure, carries the setup token, a decoded URL, or either credential half; every
// failure message is a fixed sentence (the ed25519-key rule: a paste's "context" IS the
// secret, so pasted content is never echoed).
//
// THE CEILING IS THE WALL (ADR-0023's binding order, applied to a pasted target): the
// decoded claim URL and the returned access URL are both checked against the row's
// FROZEN ceiling — https only, exact host membership (punycode-normalized by
// `normalizeAuthHost` under `isHostAllowed`), default port, and, for the claim target,
// no userinfo of its own. `redirect:'error'` on both requests: a redirect is a refusal,
// never a hop that could carry the POST — or the minted Basic header — off-host.

import { isHostAllowed } from './app-host-freeze.js';
import { utf8ToBase64 } from './base64url.js';
import type { WellKnownTokenClaimPairing } from './well-known-providers.js';

export type TokenClaimErrorReason =
  | 'malformed_token'
  | 'claim_target_refused'
  | 'token_used_or_expired'
  | 'claim_failed'
  | 'access_url_refused'
  | 'verify_failed'
  | 'commit_failed';

export interface TokenClaimError {
  ok: false;
  reason: TokenClaimErrorReason;
  /** A fixed, user-renderable sentence. NEVER derived from pasted or fetched bytes. */
  message: string;
}

export interface TokenClaimSuccess {
  ok: true;
}

export type TokenClaimResult = TokenClaimSuccess | TokenClaimError;

export interface TokenClaimRequest {
  /** The pasted one-time token — consumed here, never persisted, never echoed. */
  setupToken: string;
  /** The approved row's FROZEN ceiling (a singleton for every token-claim provider). */
  allowedHosts: readonly string[];
  pairing: WellKnownTokenClaimPairing;
  fetchImpl: typeof fetch;
  /**
   * The write-together act: persist the pair AND the connected state in one function.
   * Called exactly once, only after the verify read answered 2xx.
   */
  commit: (mint: { username: string; password: string; verifiedAt: number }) => Promise<void>;
}

/** An access URL is one line; anything larger is not one (bound before parse, B1 spirit). */
const MAX_CLAIM_RESPONSE_BYTES = 4096;

function refuse(reason: TokenClaimErrorReason, message: string): TokenClaimError {
  return { ok: false, reason, message };
}

/**
 * Decode the pasted token to its claim URL. SimpleFIN mints STANDARD base64, but users
 * paste from mail clients and chat apps, so whitespace is stripped and the url-safe
 * alphabet is tolerated. Anything else is a fixed-sentence refusal.
 */
function decodeSetupToken(setupToken: string): URL | undefined {
  const compact = setupToken.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return undefined;
  let decoded: string;
  try {
    decoded = atob(compact.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return undefined;
  }
  try {
    return new URL(decoded);
  } catch {
    return undefined;
  }
}

/**
 * The shared target gates: https, exact ceiling membership, default port. `withUserinfo`
 * distinguishes the two callers — a CLAIM target may carry none, while the ACCESS URL
 * must carry both halves (they ARE the mint).
 */
function targetViolation(url: URL, allowedHosts: readonly string[]): string | undefined {
  if (url.protocol !== 'https:') return 'scheme';
  if (!isHostAllowed(url.hostname, allowedHosts)) return 'host';
  if (url.port !== '') return 'port';
  return undefined;
}

export async function performTokenClaim(request: TokenClaimRequest): Promise<TokenClaimResult> {
  const { setupToken, allowedHosts, pairing, fetchImpl, commit } = request;

  const claimUrl = decodeSetupToken(setupToken);
  if (claimUrl === undefined) {
    return refuse(
      'malformed_token',
      'that does not look like a setup token — copy the whole token from SimpleFIN Bridge and paste it unchanged',
    );
  }
  if (targetViolation(claimUrl, allowedHosts) !== undefined || claimUrl.username !== '' || claimUrl.password !== '') {
    // One sentence for every shape of bad target: naming WHICH gate fired would echo
    // facts about a URL the user cannot see and did not author.
    return refuse(
      'claim_target_refused',
      'this token points somewhere other than the SimpleFIN Bridge this connection was approved for — get a fresh token from SimpleFIN Bridge and try again',
    );
  }

  // THE CLAIM — one POST, empty body, no headers (it is the request that CREATES the
  // credential), and a redirect is a refusal rather than a hop.
  let claimResponse: Response;
  try {
    claimResponse = await fetchImpl(claimUrl.href, { method: 'POST', redirect: 'error' });
  } catch {
    return refuse('claim_failed', 'the SimpleFIN Bridge could not be reached — check your connection and try again');
  }
  if (claimResponse.status === 403) {
    return refuse(
      'token_used_or_expired',
      'a setup token works exactly once, and this one has already been used or has expired — create a new token in SimpleFIN Bridge and paste the fresh one',
    );
  }
  if (claimResponse.status < 200 || claimResponse.status >= 300) {
    return refuse('claim_failed', 'the SimpleFIN Bridge refused the claim — try again, and if it repeats, create a new setup token');
  }

  let accessBody: string;
  try {
    accessBody = (await claimResponse.text()).trim();
  } catch {
    return refuse('claim_failed', 'the SimpleFIN Bridge answered unreadably — try again');
  }

  const accessRefusal = refuse(
    'access_url_refused',
    'the SimpleFIN Bridge answered with something other than the access key this connection was approved for — nothing has been saved',
  );
  if (accessBody.length === 0 || accessBody.length > MAX_CLAIM_RESPONSE_BYTES) return accessRefusal;
  let accessUrl: URL;
  try {
    accessUrl = new URL(accessBody);
  } catch {
    return accessRefusal;
  }
  if (targetViolation(accessUrl, allowedHosts) !== undefined) return accessRefusal;
  if (accessUrl.username === '' || accessUrl.password === '') return accessRefusal;
  // THE CHECKED INVARIANT (review Blocker 3): apps address paths under the pinned
  // `accessPath`, so an access URL minted under any other prefix would break silently
  // mid-sync. Refusing here turns that into a loud claim-time answer.
  if (accessUrl.pathname.replace(/\/$/, '') !== pairing.accessPath) return accessRefusal;

  // The URL API keeps userinfo percent-encoded; the Basic header needs the real bytes.
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(accessUrl.username);
    password = decodeURIComponent(accessUrl.password);
  } catch {
    return accessRefusal;
  }

  // THE VERIFY READ (ADR-0025), before anything durable exists: prove the minted pair
  // at the same spelling the connection's declared test probe uses.
  const verifyFailure = refuse(
    'verify_failed',
    'the new access key could not be confirmed, so nothing has been saved — try again with a fresh setup token',
  );
  try {
    const verifyResponse = await fetchImpl(`https://${accessUrl.hostname}${pairing.verify.pathAndQuery}`, {
      method: pairing.verify.method,
      redirect: 'error',
      headers: { Authorization: `Basic ${utf8ToBase64(`${username}:${password}`)}` },
    });
    if (verifyResponse.status < 200 || verifyResponse.status >= 300) return verifyFailure;
  } catch {
    return verifyFailure;
  }

  // THE MINT LANDS IN `commit`, not in the return value.
  try {
    await commit({ username, password, verifiedAt: Date.now() });
  } catch {
    return refuse(
      'commit_failed',
      'the access key was confirmed but could not be saved to your file — nothing is stored; try again',
    );
  }
  return { ok: true };
}
