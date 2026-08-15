// TASK-20260815-coinbase-ed25519 (ADR-0030, superseding ADR-0022 §2's ES256-only
// clause) — the `cdp_jwt` template helper, rewritten RED-FIRST at Gate 3 against an
// engine that still signs ES256.
//
// WHAT IT MINTS. `{{cdp_jwt(api_key, ed25519_private_key)}}` renders a fresh EdDSA CDP
// JWT per render pass: protected header { alg:'EdDSA', kid:<api_key value>, typ:'JWT',
// nonce:<16-byte hex> }, payload { iss:'cdp', sub:<api_key value>,
// uri:'<METHOD> <host><path>' (NO scheme, NO query — pinned below), nbf:now,
// exp:now+120 }. The claim shape is byte-identical to the ES256 era (verified against
// Coinbase's own jwt_generator); only the algorithm and key import changed. WebCrypto's
// raw 64-byte Ed25519 signature IS the JWS EdDSA format (RFC 8037 §3.2 — no conversion).
//
// ACCEPTED SECRET SHAPES (ADR-0030 §2, armor first): PKCS#8 PEM with the Ed25519 OID;
// armorless base64 — 64-byte seed‖pubkey, 32-byte bare seed, or the 48-byte DER of a
// PEM body pasted without its BEGIN/END lines. Every shape canonicalizes to the seed and
// is re-wrapped by us, which is why ANY post-validation import failure is a RUNTIME
// failure (the total rule, ADR-0030 §3).
//
// THE VERIFICATION IS INDEPENDENT (AC1). The signature is checked with
// `crypto.subtle.verify` against the PUBLIC key derived (offline) from the checked-in
// fixture private key — never by re-running the helper and comparing it to itself
// (lesson 2026-08-11: a guard that compares two values computed by the same function
// verifies agreement, not correctness).
//
// FIXTURE KEYS ARE TEST KEYS. `fixtures/ed25519-test-key.*` were generated for this
// suite and appear in no provider account; the EC pair (`fixtures/cdp-test-key.*`) is
// kept as the REJECTION fixture — the exact legacy shape the error message must name
// the fix for. The base64 constants below are shapes of the same fixture key, derived
// offline. No real secret appears in this file (C1).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthTemplateError, renderAuthHeaderTemplate, renderAuthTemplateString } from '../template-engine.js';

const fixturesDir = join(__dirname, 'fixtures');
const ED25519_PEM = readFileSync(join(fixturesDir, 'ed25519-test-key.pkcs8.pem'), 'utf8');
const ED25519_PUB_PEM = readFileSync(join(fixturesDir, 'ed25519-test-key.pub.pem'), 'utf8');
const EC_SEC1_PEM = readFileSync(join(fixturesDir, 'cdp-test-key.sec1.pem'), 'utf8');
const EC_PKCS8_PEM = readFileSync(join(fixturesDir, 'cdp-test-key.pkcs8.pem'), 'utf8');

// The fixture key's other paste shapes, derived offline (node:crypto export; see the
// task file). SEED is bytes 16..48 of the PKCS#8 DER; SEEDPUB appends the raw public
// key — the exact 64-byte shape the CDP portal downloads.
const SEED_B64 = 'LzhZSQY4C261sQ9/dgYKXEyEW2EsWXx8uYZP8lPdH9w=';
const SEEDPUB_B64 = 'LzhZSQY4C261sQ9/dgYKXEyEW2EsWXx8uYZP8lPdH9x8G8d0KyeJEw4asa558Cq0syvtCokmvNHsCR3CkTOuwg==';
/** The PEM body pasted without its armor lines — decodes to the whole 48-byte DER. */
const ARMORLESS_BODY_B64 = 'MC4CAQAwBQYDK2VwBCIEIC84WUkGOAtutbEPf3YGClxMhFthLFl8fLmGT/JT3R/c';

/** The CDP key NAME — the non-secret identifier that rides kid/sub. */
const KEY_NAME = 'organizations/11111111-2222-3333-4444-555555555555/apiKeys/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const DECLARED = ['api_key', 'ed25519_private_key'] as const;

const TEMPLATE = { Authorization: 'Bearer {{cdp_jwt(api_key, ed25519_private_key)}}' };

function ctxWith(privateKey: string, request?: { method: string; url: string; body?: string }) {
  return {
    fields: { api_key: KEY_NAME, ed25519_private_key: privateKey },
    declaredFieldKeys: [...DECLARED],
    ...(request !== undefined ? { request } : {}),
  };
}

const ACCOUNTS_REQUEST = { method: 'GET', url: 'https://api.coinbase.com/api/v3/brokerage/accounts' };

const b64urlToBytes = (segment: string): Uint8Array => new Uint8Array(Buffer.from(segment, 'base64url'));
const b64urlToJson = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;

async function renderJwt(privateKey: string, request = ACCOUNTS_REQUEST): Promise<string> {
  const headers = await renderAuthHeaderTemplate({ ...TEMPLATE }, ctxWith(privateKey, request));
  const value = headers['Authorization']!;
  expect(value.startsWith('Bearer ')).toBe(true);
  return value.slice('Bearer '.length);
}

async function importPublicKey(): Promise<CryptoKey> {
  const body = ED25519_PUB_PEM.replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  const spki = new Uint8Array(Buffer.from(body, 'base64'));
  return crypto.subtle.importKey('spki', spki as BufferSource, { name: 'Ed25519' }, false, ['verify']);
}

async function verifyJwt(jwt: string): Promise<boolean> {
  const [headerSeg, payloadSeg, sigSeg] = jwt.split('.');
  const publicKey = await importPublicKey();
  const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const signature = b64urlToBytes(sigSeg!);
  expect(signature.byteLength, 'EdDSA JWS signature is the raw Ed25519 output — exactly 64 bytes').toBe(64);
  return crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature as BufferSource, signingInput as BufferSource);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// AC1 — independent decode + EdDSA verify against the fixture public key
// ---------------------------------------------------------------------------

describe('AC1 — cdp_jwt mints a verifiable EdDSA CDP JWT (PKCS#8 PEM fixture key)', () => {
  it('renders three base64url segments, no padding', async () => {
    const jwt = await renderJwt(ED25519_PEM);
    const segments = jwt.split('.');
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe alphabet, unpadded
    }
  });

  it('protected header has EXACTLY {alg, kid, typ, nonce} with the pinned values', async () => {
    const jwt = await renderJwt(ED25519_PEM);
    const header = b64urlToJson(jwt.split('.')[0]!);
    expect(Object.keys(header).sort()).toEqual(['alg', 'kid', 'nonce', 'typ']);
    expect(header['alg']).toBe('EdDSA');
    expect(header['typ']).toBe('JWT');
    expect(header['kid'], 'kid is the API key NAME — never key material').toBe(KEY_NAME);
    expect(header['nonce'], '16 random bytes as lowercase hex').toMatch(/^[0-9a-f]{32}$/);
  });

  it('payload has EXACTLY {iss, sub, uri, nbf, exp} — iss cdp, sub key name, exp = nbf+120', async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await renderJwt(ED25519_PEM);
    const after = Math.floor(Date.now() / 1000);
    const payload = b64urlToJson(jwt.split('.')[1]!);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iss', 'nbf', 'sub', 'uri']);
    expect(payload['iss']).toBe('cdp');
    expect(payload['sub']).toBe(KEY_NAME);
    expect(payload['uri']).toBe('GET api.coinbase.com/api/v3/brokerage/accounts');
    const nbf = payload['nbf'] as number;
    expect(nbf).toBeGreaterThanOrEqual(before);
    expect(nbf).toBeLessThanOrEqual(after);
    expect(payload['exp'], 'exp is pinned at nbf + 120 seconds').toBe(nbf + 120);
  });

  it('the signature VERIFIES with WebCrypto against the fixture public key', async () => {
    const jwt = await renderJwt(ED25519_PEM);
    await expect(verifyJwt(jwt)).resolves.toBe(true);
  });

  it('a tampered payload FAILS verification — the verify above is not vacuous', async () => {
    const jwt = await renderJwt(ED25519_PEM);
    const [headerSeg, payloadSeg, sigSeg] = jwt.split('.');
    const payload = b64urlToJson(payloadSeg!);
    payload['uri'] = 'GET evil.example/steal';
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    await expect(verifyJwt(`${headerSeg}.${forged}.${sigSeg}`)).resolves.toBe(false);
  });

  it('uri claim carries METHOD + host + pathname — NO scheme, NO query (pin)', async () => {
    const jwt = await renderJwt(ED25519_PEM, {
      method: 'GET',
      url: 'https://api.coinbase.com/api/v3/brokerage/accounts?limit=5&cursor=abc',
    });
    const payload = b64urlToJson(jwt.split('.')[1]!);
    expect(payload['uri']).toBe('GET api.coinbase.com/api/v3/brokerage/accounts');
    expect(String(payload['uri'])).not.toContain('https');
    expect(String(payload['uri'])).not.toContain('limit');
  });

  it('every render mints a FRESH JWT — nonces differ between two renders', async () => {
    const first = await renderJwt(ED25519_PEM);
    const second = await renderJwt(ED25519_PEM);
    const nonceOf = (jwt: string): unknown => b64urlToJson(jwt.split('.')[0]!)['nonce'];
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });
});

// ---------------------------------------------------------------------------
// AC1 — every portal paste shape canonicalizes to the same signing seed
// ---------------------------------------------------------------------------

describe('AC1 — accepted secret shapes (base64 64-byte, base64 32-byte, armorless body, pasted PEM)', () => {
  it('the 64-byte seed‖pubkey base64 (the portal download shape) signs and verifies', async () => {
    const jwt = await renderJwt(SEEDPUB_B64);
    await expect(verifyJwt(jwt)).resolves.toBe(true);
  });

  it('the bare 32-byte seed base64 signs and verifies', async () => {
    const jwt = await renderJwt(SEED_B64);
    await expect(verifyJwt(jwt)).resolves.toBe(true);
  });

  it('a base64 paste with a trailing newline and padding whitespace still signs (whitespace-normalized)', async () => {
    // The default shape of a copy from a key file: trailing newline, stray spaces.
    const jwt = await renderJwt(`  ${SEEDPUB_B64}\n`);
    await expect(verifyJwt(jwt)).resolves.toBe(true);
  });

  it('a PEM body pasted WITHOUT its BEGIN/END lines (48-byte DER) has its seed extracted', async () => {
    const jwt = await renderJwt(ARMORLESS_BODY_B64);
    await expect(verifyJwt(jwt)).resolves.toBe(true);
  });

  it('a pasted PEM with escaped \\n and stray whitespace normalizes and verifies', async () => {
    // The shape a key takes after riding a JSON string or a form paste: literal
    // backslash-n instead of newlines, plus surrounding whitespace.
    const pasted = `  ${ED25519_PEM.trimEnd().split('\n').join('\\n')}  `;
    const jwt = await renderJwt(pasted);
    await expect(verifyJwt(jwt)).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 — honest typed errors, armor first, never an echo (C5)
// ---------------------------------------------------------------------------

describe('AC2 — legacy/invalid shapes earn honest fix-naming errors, no key echo', () => {
  it('an EC SEC1 PEM (the legacy CDP download) names the Ed25519 fix — NOT a base64 error', async () => {
    const attempt = renderJwt(EC_SEC1_PEM);
    await expect(attempt).rejects.toThrow(AuthTemplateError);
    await expect(attempt).rejects.toThrow(/Ed25519 API key/);
    const err = await renderJwt(EC_SEC1_PEM).catch((e: unknown) => e as Error);
    // Armor-first detection: the SEC1 paste must never fall through to the base64
    // decoder and earn a misdiagnosis.
    expect((err as Error).message).not.toMatch(/base64/i);
    const keyBody = EC_SEC1_PEM.split('\n')[1]!;
    expect((err as Error).message).not.toContain(keyBody);
  });

  it('an EC PKCS#8 PEM earns the same fix-naming error', async () => {
    const attempt = renderJwt(EC_PKCS8_PEM);
    await expect(attempt).rejects.toThrow(AuthTemplateError);
    await expect(attempt).rejects.toThrow(/Ed25519 API key/);
  });

  it('unrecognizable armor earns a typed error that never echoes the pasted content', async () => {
    const pasted = '-----BEGIN OPENSSH PRIVATE KEY-----\nZm9vYmFyCg==\n-----END OPENSSH PRIVATE KEY-----';
    const attempt = renderJwt(pasted);
    await expect(attempt).rejects.toThrow(AuthTemplateError);
    const err = await renderJwt(pasted).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain('Zm9vYmFy');
    expect((err as Error).message).not.toContain('OPENSSH');
  });

  it('a non-base64 armorless paste earns a typed error, no echo', async () => {
    const attempt = renderJwt('definitely-not-base64!!!');
    await expect(attempt).rejects.toThrow(AuthTemplateError);
    const err = await renderJwt('definitely-not-base64!!!').catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain('definitely-not-base64');
  });

  it('a base64url-alphabet paste is refused with a typed error naming standard base64 (pinned posture)', async () => {
    // Deliberate rejection, not silent acceptance of an alphabet the portal never
    // delivers (ADR-0030 §2). base64url of the seed: '/' → '_', '+' → '-'.
    const b64url = SEEDPUB_B64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(b64url).not.toBe(SEEDPUB_B64.replace(/=+$/, '')); // fixture genuinely exercises the alphabet
    await expect(renderJwt(b64url)).rejects.toThrow(AuthTemplateError);
  });

  it('a decodable base64 of the WRONG length names the expected shapes and the PEM hint', async () => {
    const wrongLength = Buffer.alloc(40, 7).toString('base64'); // neither 32, 48, nor 64
    const attempt = renderJwt(wrongLength);
    await expect(attempt).rejects.toThrow(AuthTemplateError);
    await expect(attempt).rejects.toThrow(/BEGIN\/END/);
    const err = await renderJwt(wrongLength).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain(wrongLength);
  });
});

// ---------------------------------------------------------------------------
// AC2 — the TOTAL runtime rule (ADR-0030 §3): post-validation import/sign
// failures are runtime failures, whatever error shape the runtime throws
// ---------------------------------------------------------------------------

describe('AC2 — a runtime without WebCrypto Ed25519 fails LOUDLY, never "re-create your key"', () => {
  it('crypto without subtle → AuthTemplateError naming WebCrypto Ed25519', async () => {
    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues });
    const attempt = renderAuthHeaderTemplate({ ...TEMPLATE }, ctxWith(ED25519_PEM, ACCOUNTS_REQUEST));
    await expect(attempt).rejects.toThrow(AuthTemplateError);
    await expect(
      renderAuthHeaderTemplate({ ...TEMPLATE }, ctxWith(ED25519_PEM, ACCOUNTS_REQUEST)),
    ).rejects.toThrow(/WebCrypto|Ed25519/);
  });

  it('a subtle whose importKey throws a PLAIN Error (the desktop fallback shape) → the runtime error, not key advice', async () => {
    // The desktop subtle-fallback throws `Error('subtle-fallback: only raw HMAC
    // keys')` — no NotSupportedError name to allowlist on. The blob being imported
    // was constructed by US from a validated seed, so the failure cannot be the
    // user's key; telling them to re-create it would be a lie (review finding 5b).
    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', {
      getRandomValues: realGetRandomValues,
      subtle: {
        importKey: () => {
          throw new Error('subtle-fallback: only raw HMAC keys');
        },
      },
    });
    const attempt = renderAuthHeaderTemplate({ ...TEMPLATE }, ctxWith(SEEDPUB_B64, ACCOUNTS_REQUEST));
    await expect(attempt).rejects.toThrow(AuthTemplateError);
    const err = await renderAuthHeaderTemplate({ ...TEMPLATE }, ctxWith(SEEDPUB_B64, ACCOUNTS_REQUEST)).catch(
      (e: unknown) => e as Error,
    );
    expect((err as Error).message).toMatch(/runtime|WebCrypto/i);
    expect((err as Error).message).not.toMatch(/create|portal/i);
  });
});

// ---------------------------------------------------------------------------
// The engine's own half of the argument contract (the lint is the other half)
// ---------------------------------------------------------------------------

describe("cdp_jwt engine-half guards (the lint's rules are tested in template-lint.test.ts)", () => {
  it('no request context → honest error (the uri claim cannot be minted)', async () => {
    await expect(renderAuthHeaderTemplate({ ...TEMPLATE }, ctxWith(ED25519_PEM))).rejects.toThrow(
      /request context/i,
    );
  });

  it('wrong arity throws the honest (api_key, private_key) message', async () => {
    // Direct string render — below the lint gate — so this is the ENGINE refusing.
    // The message names the ROLES of the two arguments, not the registry's field keys.
    await expect(
      renderAuthTemplateString('{{cdp_jwt(api_key)}}', ctxWith(ED25519_PEM, ACCOUNTS_REQUEST)),
    ).rejects.toThrow(/cdp_jwt requires \(api_key, private_key\)/);
  });

  it('a BLANK declared ed25519_private_key field throws honestly instead of signing with nothing', async () => {
    const ctx = {
      fields: { api_key: KEY_NAME },
      declaredFieldKeys: [...DECLARED],
      request: ACCOUNTS_REQUEST,
    };
    await expect(
      renderAuthTemplateString('{{cdp_jwt(api_key, ed25519_private_key)}}', ctx),
    ).rejects.toThrow(AuthTemplateError);
  });
});
