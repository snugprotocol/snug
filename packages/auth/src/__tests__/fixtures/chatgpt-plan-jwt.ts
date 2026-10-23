/**
 * ID-token fixtures for the ChatGPT-plan keeper tests (TASK-20261023-siwc-chatgpt-plan, AC3).
 *
 * A REAL RSA key pair built with WebCrypto at test time (no key material checked in), the JWKS
 * document a fake `jwks_uri` serves, and signers for the token shapes the keeper must accept
 * (RS256 with a `kid`) and refuse (`alg: none`, HS256, RS256 by a key the JWKS does not hold).
 * The measured shape (spike, 2026-10-23): header `{ alg: 'RS256', kid }`; claims `iss, sub, aud`
 * (an ARRAY), `nonce, auth_time, email, email_verified, name, sid, iat, exp, jti, at_hash` — no
 * plan-type claim, no `azp`.
 */
import { bytesToBase64Url, utf8ToBase64Url } from '../../base64url.js';

export const TEST_KID = 'snug-test-kid-1';

/** A public RSA JWK as a JWKS lists it (a type alias, so it is a plain record). */
export type PublicRsaJwk = { kty: string; n: string; e: string; kid: string; use: string; alg: string };

export interface RsaFixtureKey {
  kid: string;
  privateKey: CryptoKey;
  /** The public half as a JWK with `kid`, `use: 'sig'`, `alg: 'RS256'` — what `jwks_uri` lists. */
  publicJwk: PublicRsaJwk;
}

/** A fresh RSASSA-PKCS1-v1_5 / SHA-256 key pair, exported the way OpenAI's JWKS lists one. */
export async function makeRsaKey(kid: string = TEST_KID): Promise<RsaFixtureKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // Only the public members a real JWKS carries — never `d`/`p`/`q`, and no `key_ops`/`ext`
  // (a verifier that imports a JWK with `key_ops: ['verify']` is fine, but a real JWKS has none).
  const publicJwk: PublicRsaJwk = {
    kty: 'RSA',
    n: exported.n!,
    e: exported.e!,
    kid,
    use: 'sig',
    alg: 'RS256',
  };
  return { kid, privateKey: pair.privateKey, publicJwk };
}

/** The JWKS document a fake `jwks_uri` answers. Extra entries let a test add noise keys. */
export function jwksDocument(keys: ReadonlyArray<Record<string, unknown>>): { keys: Array<Record<string, unknown>> } {
  return { keys: keys.map((k) => ({ ...k })) };
}

export type IdTokenClaims = Record<string, unknown>;

function encodeSegment(value: unknown): string {
  return utf8ToBase64Url(JSON.stringify(value));
}

/** Sign an ID token RS256 with `key` (header `{ alg: 'RS256', typ: 'JWT', kid }` unless overridden). */
export async function signIdToken(
  claims: IdTokenClaims,
  key: RsaFixtureKey,
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = encodeSegment({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const body = encodeSegment(claims);
  const signingInput = `${head}.${body}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

/** An `alg: none` token — header names the trusted kid, no signature. Must be refused. */
export function unsignedIdToken(claims: IdTokenClaims, kid: string = TEST_KID): string {
  return `${encodeSegment({ alg: 'none', typ: 'JWT', kid })}.${encodeSegment(claims)}.`;
}

/**
 * An HS256 token MACed with `secret` — the classic algorithm-confusion attack uses the public
 * key's bytes as the HMAC secret, so the caller passes the JWKS `n`. Must be refused.
 */
export async function hs256IdToken(claims: IdTokenClaims, secret: string, kid: string = TEST_KID): Promise<string> {
  const head = encodeSegment({ alg: 'HS256', typ: 'JWT', kid });
  const body = encodeSegment(claims);
  const signingInput = `${head}.${body}`;
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${bytesToBase64Url(mac)}`;
}

/** Decode a JWT's payload (no verification) — for assertions on what the keeper stored. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as Record<string, unknown>;
}
