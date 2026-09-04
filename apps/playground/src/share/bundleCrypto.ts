// bundleCrypto.ts — the link transport's blindness (ADR-0064 §2, AC19).
//
// A share LINK is `https://playground.snugprotocol.org/s/<id>#<key>`: the relay holds
// ciphertext under `<id>`, the KEY rides only in the fragment, and browsers never send
// a fragment to any server (nor put it in `Referer`). So the relay cannot read what it
// stores, and a substituted or damaged blob fails the AEAD tag on the recipient's side.
//
// AES-256-GCM through WebCrypto (available in every target: the browser, the desktop
// webview, Node 20+ for tests). Wire shape: 12-byte random nonce || ciphertext+tag. The
// key is 32 random bytes, base64url without padding (43 chars) — one URL-safe token.
//
// This module never touches the network: `relayClient.ts` moves bytes, and the test for
// "the key is in no request" spies on fetch there, not here.

export const SHARE_KEY_BYTES = 32;
export const SHARE_NONCE_BYTES = 12;
export const SHARE_KEY_RULE = /^[A-Za-z0-9_-]{43}$/;

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (c?.subtle === undefined) throw new Error('WebCrypto is unavailable — share links need it');
  return c.subtle;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export interface EncryptedBundle {
  /** The link's fragment: 43 base64url chars of a 256-bit key. */
  key: string;
  /** nonce || ciphertext+tag — what the relay stores, byte for byte. */
  ciphertext: Uint8Array;
}

export async function encryptBundle(plaintext: Uint8Array): Promise<EncryptedBundle> {
  const rawKey = crypto.getRandomValues(new Uint8Array(SHARE_KEY_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(SHARE_NONCE_BYTES));
  const cryptoKey = await subtle().importKey('raw', rawKey as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, cryptoKey, plaintext as BufferSource));
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, nonce.length);
  return { key: toBase64Url(rawKey), ciphertext: out };
}

export type DecryptResult = { ok: true; plaintext: Uint8Array } | { ok: false; reason: 'bad-key' | 'bad-ciphertext' | 'tamper' };

/** Fails CLOSED: a wrong key, a short blob and a flipped byte all report a reason and no bytes. */
export async function decryptBundle(ciphertext: Uint8Array, key: string): Promise<DecryptResult> {
  if (!SHARE_KEY_RULE.test(key)) return { ok: false, reason: 'bad-key' };
  const rawKey = fromBase64Url(key);
  if (rawKey === undefined || rawKey.length !== SHARE_KEY_BYTES) return { ok: false, reason: 'bad-key' };
  if (ciphertext.length <= SHARE_NONCE_BYTES + 16) return { ok: false, reason: 'bad-ciphertext' };
  const nonce = ciphertext.subarray(0, SHARE_NONCE_BYTES);
  const sealed = ciphertext.subarray(SHARE_NONCE_BYTES);
  try {
    const cryptoKey = await subtle().importKey('raw', rawKey as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, cryptoKey, sealed as BufferSource);
    return { ok: true, plaintext: new Uint8Array(plain) };
  } catch {
    return { ok: false, reason: 'tamper' };
  }
}
