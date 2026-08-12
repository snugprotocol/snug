// @vitest-environment node
// (jsdom's SubtleCrypto rejects cross-realm buffers; parity needs the real one.)
//
// Byte-parity for the desktop crypto.subtle fallback (plan decision 12).
// These run under Node, where REAL WebCrypto exists — the pure-JS
// implementation must match it bit-for-bit, or the desktop HMAC state
// signatures would diverge from every other host.

import { describe, expect, it } from 'vitest';

import { hmacSha256Bytes, sha256Bytes } from '../subtle-fallback.js';

const enc = new TextEncoder();

/** Copy into a fresh ArrayBuffer — WebCrypto's BufferSource rejects ArrayBufferLike views. */
function toAB(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

async function realSha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toAB(data)));
}

async function realHmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    toAB(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, toAB(data)));
}

describe('subtle-fallback parity with WebCrypto', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['abc', enc.encode('abc')],
    ['one block boundary (55)', new Uint8Array(55).fill(0x61)],
    ['exactly 56 (forces extra block)', new Uint8Array(56).fill(0x62)],
    ['64', new Uint8Array(64).fill(0x63)],
    ['1000 mixed', Uint8Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) & 0xff)],
    ['unicode', enc.encode('snug — désktop ✓ 🧶')],
  ];

  it.each(cases)('SHA-256 parity: %s', async (_name, data) => {
    expect(Buffer.from(sha256Bytes(data)).toString('hex')).toBe(
      Buffer.from(await realSha256(data)).toString('hex'),
    );
  });

  it.each(cases)('HMAC-SHA-256 parity (short key): %s', async (_name, data) => {
    const key = enc.encode('snug-hmac-test-key');
    expect(Buffer.from(hmacSha256Bytes(key, data)).toString('hex')).toBe(
      Buffer.from(await realHmac(key, data)).toString('hex'),
    );
  });

  it('HMAC parity with an over-64-byte key (key-hash branch)', async () => {
    const key = new Uint8Array(100).fill(0x4b);
    const data = enc.encode('state-payload');
    expect(Buffer.from(hmacSha256Bytes(key, data)).toString('hex')).toBe(
      Buffer.from(await realHmac(key, data)).toString('hex'),
    );
  });

  it('RFC 4231 test case 2 fixed vector', () => {
    const mac = hmacSha256Bytes(enc.encode('Jefe'), enc.encode('what do ya want for nothing?'));
    expect(Buffer.from(mac).toString('hex')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});
