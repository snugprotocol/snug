// Shared browser-safe base64url helper (AL-02 plan D6): RFC 4648 url-safe alphabet,
// unpadded output, padding-tolerant input. Built on btoa/atob + TextEncoder — no node
// byte-buffer API anywhere (the AC5 lint test enforces this for the whole package).

const BASE64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(encoded: string): Uint8Array {
  if (!BASE64URL_RE.test(encoded)) {
    throw new Error('input is not base64url (RFC 4648 url-safe alphabet)');
  }
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export function base64UrlToUtf8(encoded: string): string {
  return new TextDecoder().decode(base64UrlToBytes(encoded));
}

/** STANDARD (non-url, padded) base64 of arbitrary BYTES — digests, raw keys, ciphertext. */
export function bytesToBase64(bytes: Uint8Array): string {
  const url = bytesToBase64Url(bytes);
  const base64 = url.replace(/-/g, '+').replace(/_/g, '/');
  return base64 + '='.repeat((4 - (base64.length % 4)) % 4);
}

/** STANDARD (non-url) base64 of a utf8 string — what Basic auth and signing schemes expect. */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * Decode STANDARD (non-url) base64 to bytes. Separate from `base64UrlToBytes` because
 * `BASE64URL_RE` REJECTS the standard alphabet — and real provider secrets (Coinbase
 * Exchange's, notably) routinely contain `+` and `/`, so routing them through the
 * url-safe decoder would throw on perfectly valid credentials.
 *
 * Padding-tolerant on input; throws on anything outside the standard alphabet. Throwing
 * is load-bearing: the one caller (`hmac_sha256_b64`) must never fall back to signing
 * with the raw string as the key, or the helper's behavior would depend on the exact
 * bytes a user pasted and a malformed secret would produce a valid-LOOKING but wrong
 * signature instead of a diagnosable error.
 */
const BASE64_STD_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function base64ToBytes(encoded: string): Uint8Array {
  if (!BASE64_STD_RE.test(encoded)) {
    throw new Error('input is not standard base64 (RFC 4648 alphabet)');
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `byteLength` random bytes from WebCrypto, base64url-encoded. */
export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** Lowercase hex of arbitrary bytes (digest/HMAC rendering). */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
