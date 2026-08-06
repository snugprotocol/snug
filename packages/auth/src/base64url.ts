// Shared browser-safe base64url helper (AL-02 plan D6): RFC 4648 url-safe alphabet,
// unpadded output, padding-tolerant input. Built on btoa/atob + TextEncoder — no
// Buffer, no node: imports (the AC5 lint test enforces this for the whole package).

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
