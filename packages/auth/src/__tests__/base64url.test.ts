// AL-02 AC4/D6: the shared browser-safe base64url helper — no Buffer anywhere.
// Vectors from RFC 4648 §10 (base64, translated to the url-safe alphabet, unpadded)
// plus a byte pattern that exercises the '-'/'_' alphabet positions.
import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  base64UrlToUtf8,
  bytesToBase64Url,
  randomBase64Url,
  utf8ToBase64Url,
} from '../base64url.js';

const RFC4648_VECTORS: Array<[string, string]> = [
  ['', ''],
  ['f', 'Zg'],
  ['fo', 'Zm8'],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg'],
  ['fooba', 'Zm9vYmE'],
  ['foobar', 'Zm9vYmFy'],
];

describe('base64url (RFC 4648, unpadded url-safe alphabet)', () => {
  it('encodes the RFC 4648 test vectors', () => {
    for (const [plain, encoded] of RFC4648_VECTORS) {
      expect(utf8ToBase64Url(plain), plain).toBe(encoded);
    }
  });

  it('decodes the RFC 4648 test vectors (with or without padding)', () => {
    for (const [plain, encoded] of RFC4648_VECTORS) {
      expect(base64UrlToUtf8(encoded), encoded).toBe(plain);
    }
    expect(base64UrlToUtf8('Zg==')).toBe('f'); // padded input tolerated
  });

  it('uses - and _ (never + or /) and emits no padding', () => {
    const encoded = bytesToBase64Url(new Uint8Array([0xfb, 0xff]));
    expect(encoded).toBe('-_8');
    expect(base64UrlToBytes('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
  });

  it('round-trips arbitrary bytes, including NUL and multi-byte utf8', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 62, 63]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    expect(base64UrlToUtf8(utf8ToBase64Url('tälé ⚡'))).toBe('tälé ⚡');
  });

  it('rejects input outside the base64url alphabet', () => {
    expect(() => base64UrlToBytes('not/valid+chars')).toThrow();
    expect(() => base64UrlToBytes('white space')).toThrow();
  });

  it('randomBase64Url draws from getRandomValues with the requested entropy', () => {
    const a = randomBase64Url(32);
    const b = randomBase64Url(32);
    expect(a).not.toBe(b);
    expect(base64UrlToBytes(a)).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
