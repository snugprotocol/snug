// sha256.test.ts — the kit's one hex SHA-256 agrees with the standard vectors on BOTH paths
// (WebCrypto where present, the pure implementation everywhere), so a manifest written on
// one page verifies on another.
import { describe, expect, it } from 'vitest';

import { sha256Hex, sha256HexPure } from '../storage/sha256.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const LONG = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'; // "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"

describe('sha256Hex', () => {
  it('matches the FIPS vectors on the pure path', () => {
    expect(sha256HexPure(enc('abc'))).toBe(ABC);
    expect(sha256HexPure(enc(''))).toBe(EMPTY);
    expect(sha256HexPure(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(LONG);
    // Two blocks with the length word straddling the padding boundary.
    expect(sha256HexPure(enc('a'.repeat(56)))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a');
  });
  it('matches on whichever path the page has, and does not mutate the input', async () => {
    const bytes = enc('abc');
    expect(await sha256Hex(bytes)).toBe(ABC);
    expect(bytes).toEqual(enc('abc'));
    expect(await sha256Hex(new Uint8Array(1000).fill(7))).toBe(sha256HexPure(new Uint8Array(1000).fill(7)));
  });
});
