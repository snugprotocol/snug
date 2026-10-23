/**
 * ID-token verification against a JWKS (TASK-20261023-siwc-chatgpt-plan, AC3 / ADR-0078 §2).
 *
 * The one place a ChatGPT-plan ID token is believed. RS256 only: `alg: none` and HS256 are
 * refused by the header check before any key is consulted, and every key is imported as
 * RSASSA-PKCS1-v1_5 / SHA-256 whatever the header or the JWK says — the classic algorithm
 * confusion (HS256 keyed with the public modulus) cannot pass because no HMAC key ever
 * exists here. JWKS entries are filtered to `kty: RSA` signing keys; a `kid` the cached
 * document does not hold earns one refetch, never a loop.
 *
 * Verdicts are data, not throws, and they tell `invalid` from `network` apart on purpose: the
 * keeper persists a rotated token set BEFORE re-verifying its ID token (crash-safe rotation),
 * so a JWKS outage must keep the tokens and re-verify later, while a bad signature or a
 * `sub` mismatch clears them by name (plan D4).
 *
 * Browser-safe and DI-pure like the rest of the package: WebCrypto only, the fetch injected.
 */

import { base64UrlToBytes, base64UrlToUtf8 } from './base64url.js';
import type { FetchLike } from './oauth-service.js';

/** How far an `exp` may sit in the past before the token is stale (AC3: "a bounded skew"). */
export const ID_TOKEN_CLOCK_SKEW_S = 120;

/** The claims a verified ID token must agree with. `nonce` binds a sign-in token to its attempt; `subject` binds a refresh token to the stored account. */
export interface IdTokenExpectation {
  issuer: string;
  clientId: string;
  nonce?: string;
  subject?: string;
}

/** The verified account identity — only the display claims the keeper stores (R-131). */
export interface VerifiedIdToken {
  sub: string;
  email?: string;
  name?: string;
}

export type IdTokenVerdict =
  | { ok: true; claims: VerifiedIdToken }
  | { ok: false; kind: 'invalid' | 'network'; reason: string };

export interface IdTokenVerifier {
  verifyIdToken(token: string, expected: IdTokenExpectation, opts: { jwksUri: string; nowMs: number }): Promise<IdTokenVerdict>;
}

const RSA_VERIFY = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const KEY_FETCH_ATTEMPTS = 2;

interface ParsedJwt {
  kid: string;
  claims: Record<string, unknown>;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

function invalid(reason: string): IdTokenVerdict {
  return { ok: false, kind: 'invalid', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split and decode a compact JWS; the header must name RS256 and a `kid`. Anything else is undefined. */
function parseRs256Jwt(token: string): ParsedJwt | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const header: unknown = JSON.parse(base64UrlToUtf8(head));
    const claims: unknown = JSON.parse(base64UrlToUtf8(body));
    if (!isRecord(header) || !isRecord(claims)) return undefined;
    if (header['alg'] !== 'RS256') return undefined;
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid.length === 0) return undefined;
    // A copy into a fresh ArrayBuffer: what WebCrypto's `BufferSource` wants, typed exactly so.
    const signature = new Uint8Array(base64UrlToBytes(sig));
    if (signature.length === 0) return undefined;
    return { kid, claims, signingInput: new TextEncoder().encode(`${head}.${body}`), signature };
  } catch {
    return undefined;
  }
}

/** A JWKS entry usable here: an RSA signing key with a `kid`. `use` is optional in RFC 7517 §4.2; `enc` is refused. */
function importableRsaKey(entry: unknown): { kid: string; jwk: JsonWebKey } | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry['kty'] !== 'RSA') return undefined;
  if (entry['use'] !== undefined && entry['use'] !== 'sig') return undefined;
  if (entry['alg'] !== undefined && entry['alg'] !== 'RS256') return undefined;
  const kid = entry['kid'];
  const n = entry['n'];
  const e = entry['e'];
  if (typeof kid !== 'string' || typeof n !== 'string' || typeof e !== 'string') return undefined;
  // Only the public members travel into WebCrypto: no `key_ops`/`ext`/`alg` from the document
  // can steer the import away from RSASSA-PKCS1-v1_5 / SHA-256.
  return { kid, jwk: { kty: 'RSA', n, e } };
}

function audienceContains(aud: unknown, clientId: string): boolean {
  if (typeof aud === 'string') return aud === clientId;
  return Array.isArray(aud) && aud.includes(clientId);
}

/** Every claim check, after the signature held. Order matters only for the reason named. */
function checkClaims(claims: Record<string, unknown>, expected: IdTokenExpectation, nowMs: number): IdTokenVerdict {
  if (claims['iss'] !== expected.issuer) return invalid('iss');
  if (!audienceContains(claims['aud'], expected.clientId)) return invalid('aud');
  const azp = claims['azp'];
  if (azp !== undefined && azp !== expected.clientId) return invalid('azp');
  const exp = claims['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return invalid('exp');
  if (Math.floor(nowMs / 1000) - exp > ID_TOKEN_CLOCK_SKEW_S) return invalid('expired');
  if (expected.nonce !== undefined && claims['nonce'] !== expected.nonce) return invalid('nonce');
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.length === 0) return invalid('sub');
  if (expected.subject !== undefined && sub !== expected.subject) return invalid('subject');
  const email = claims['email'];
  const name = claims['name'];
  return {
    ok: true,
    claims: {
      sub,
      ...(typeof email === 'string' && email.length > 0 ? { email } : {}),
      ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
    },
  };
}

/**
 * A verifier with a per-instance key cache. `fetch` is expected to carry its own timeout and
 * `redirect: 'manual'` (the keeper wraps it); a rejection, a non-2xx or an unreadable document
 * is a `network` verdict — transient by definition, never a reason to drop a session.
 */
export function createIdTokenVerifier(deps: { fetch: FetchLike }): IdTokenVerifier {
  const cache = new Map<string, CryptoKey>();
  let cachedFor: string | undefined;

  async function loadKeys(jwksUri: string): Promise<'loaded' | 'network'> {
    let entries: unknown;
    try {
      const response = await deps.fetch(jwksUri, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!response.ok) return 'network';
      const document: unknown = await response.json();
      entries = isRecord(document) ? document['keys'] : undefined;
    } catch {
      return 'network';
    }
    if (!Array.isArray(entries)) return 'network';
    if (cachedFor !== jwksUri) cache.clear();
    cachedFor = jwksUri;
    for (const entry of entries) {
      const key = importableRsaKey(entry);
      if (key === undefined) continue;
      try {
        cache.set(key.kid, await crypto.subtle.importKey('jwk', key.jwk, RSA_VERIFY, false, ['verify']));
      } catch {
        // A malformed `n`/`e` is this entry's defect; the rest of the document still counts.
      }
    }
    return 'loaded';
  }

  /** The key for `kid`: from the cache, else fetched — at most `KEY_FETCH_ATTEMPTS` documents per verification. */
  async function keyFor(kid: string, jwksUri: string): Promise<CryptoKey | 'missing' | 'network'> {
    if (cachedFor === jwksUri) {
      const hit = cache.get(kid);
      if (hit !== undefined) return hit;
    }
    for (let attempt = 0; attempt < KEY_FETCH_ATTEMPTS; attempt++) {
      const outcome = await loadKeys(jwksUri);
      if (outcome === 'network') return 'network';
      const hit = cache.get(kid);
      if (hit !== undefined) return hit;
    }
    return 'missing';
  }

  return {
    async verifyIdToken(token, expected, { jwksUri, nowMs }) {
      const parsed = parseRs256Jwt(token);
      if (parsed === undefined) return invalid('shape');
      const key = await keyFor(parsed.kid, jwksUri);
      if (key === 'network') return { ok: false, kind: 'network', reason: 'jwks' };
      if (key === 'missing') return invalid('kid');
      let holds: boolean;
      try {
        holds = await crypto.subtle.verify(RSA_VERIFY.name, key, parsed.signature, parsed.signingInput);
      } catch {
        holds = false;
      }
      if (!holds) return invalid('signature');
      return checkClaims(parsed.claims, expected, nowMs);
    },
  };
}
