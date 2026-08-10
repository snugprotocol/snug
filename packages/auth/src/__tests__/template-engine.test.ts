// AL-02 D6/D7: the header-template engine, ported with its source tests ADAPTED to the
// async-first WebCrypto rewrite (every helper returns a Promise; hmac/sha outputs are
// verified against independently computed digests via crypto.subtle — never node:crypto).
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../base64url.js';
import { AuthTemplateError, renderAuthHeaderTemplate, renderAuthTemplateString } from '../template-engine.js';
import { AuthTemplateLintError } from '../template-lint.js';

/** Independent HMAC-SHA256 hex via WebCrypto (test-side oracle). */
async function hmacHex(algorithm: 'SHA-256' | 'SHA-512', secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}

const ctx = {
  fields: {
    api_key: 'AKID',
    api_secret: 'SUPERSECRET',
    passphrase: 'phrase42',
  },
  request: {
    method: 'POST',
    url: 'https://api.example.com/v2/orders?limit=10',
    pathAndQuery: '/v2/orders?limit=10',
    body: '{"x":1}',
  },
};

describe('renderAuthHeaderTemplate (async)', () => {
  it('substitutes plain field placeholders', async () => {
    const headers = await renderAuthHeaderTemplate(
      { 'CB-ACCESS-KEY': '{{api_key}}', 'CB-ACCESS-PASSPHRASE': '{{passphrase}}' },
      ctx,
    );
    expect(headers).toEqual({ 'CB-ACCESS-KEY': 'AKID', 'CB-ACCESS-PASSPHRASE': 'phrase42' });
  });

  it('runs hmac_sha256 over the request body', async () => {
    const headers = await renderAuthHeaderTemplate(
      { 'CB-ACCESS-SIGN': '{{hmac_sha256(api_secret, request.body)}}' },
      ctx,
    );
    expect(headers['CB-ACCESS-SIGN']).toBe(await hmacHex('SHA-256', 'SUPERSECRET', '{"x":1}'));
  });

  // WAS: "runs hmac_sha512 and sha256 helpers". Dynamic Auth v2 P0 TRIMMED both from the
  // pinned enum (fold S-M2a) — they shipped with no requirement behind them, and an
  // unreachable helper is still reachable signing surface. The test is INVERTED rather
  // than deleted: the claim "these two helpers work" was replaced by the claim "these two
  // helpers are gone", which is the contract that now needs defending. The old assertion
  // is preserved above in git; the `hmacHex` SHA-512 oracle is kept because the negative
  // assertion below is only meaningful if a SHA-512 HMAC was ever computable here.
  it('no longer runs the TRIMMED hmac_sha512 / sha256 helpers', async () => {
    await expect(
      renderAuthHeaderTemplate({ 'X-512': '{{hmac_sha512(api_secret, request.pathAndQuery)}}' }, ctx),
    ).rejects.toThrow(/hmac_sha512/);
    await expect(renderAuthHeaderTemplate({ 'X-256': "{{sha256('abc')}}" }, ctx)).rejects.toThrow(/sha256/);
    // The oracle still proves the trim is a POLICY choice, not a capability gap: WebCrypto
    // computes the SHA-512 HMAC fine, the engine simply refuses to expose it.
    expect(await hmacHex('SHA-512', 'SUPERSECRET', '/v2/orders?limit=10')).toMatch(/^[0-9a-f]{128}$/);
  });

  it('runs the ADDED hmac_sha256_b64 variant — base64 digest over a base64-decoded key', async () => {
    // Coinbase-Exchange's CB-ACCESS-SIGN (fold F-m3), previously inexpressible: hex-only
    // HMAC, utf8-only base64, and no nesting in the grammar. The variadic tail is the real
    // four-part prehash (timestamp + method + path + body) that a comma-splitting parser
    // cannot receive as one argument.
    const headers = await renderAuthHeaderTemplate(
      { 'CB-ACCESS-SIGN': '{{hmac_sha256_b64(api_secret, request.method, request.pathAndQuery, request.body)}}' },
      { ...ctx, fields: { ...ctx.fields, api_secret: 'MTIzNA==' } },
    );
    // Independent oracle: HMAC over the raw bytes of base64decode('MTIzNA==') === "1234".
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('1234'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const raw = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('POST/v2/orders?limit=10{"x":1}')),
    );
    expect(headers['CB-ACCESS-SIGN']).toBe(btoa(String.fromCharCode(...raw)));
  });

  it('signs the SAME timestamp it sends (one evaluation per render pass)', async () => {
    // A signing scheme sends the timestamp AND signs it. Two independent `Date.now()`
    // reads can straddle a second boundary, producing a signature over a timestamp that
    // differs from the one in the header — an intermittent ~1-in-N auth failure. The
    // render pass memoizes, so the two agree by construction.
    const headers = await renderAuthHeaderTemplate(
      { 'CB-ACCESS-TIMESTAMP': '{{timestamp()}}', 'X-Echo': '{{timestamp()}}' },
      ctx,
    );
    expect(headers['CB-ACCESS-TIMESTAMP']).toBe(headers['X-Echo']);
  });

  it('returns numeric timestamp for timestamp() helper', async () => {
    const headers = await renderAuthHeaderTemplate({ 'X-Time': '{{timestamp()}}' }, ctx);
    expect(headers['X-Time']).toMatch(/^\d{10}$/);
  });

  it('renders quoted literals + base64 helper', async () => {
    const headers = await renderAuthHeaderTemplate({ 'X-Encoded': "{{base64('hello')}}" }, ctx);
    expect(headers['X-Encoded']).toBe('aGVsbG8=');
  });

  it('resolves request.pathAndQuery from the url when not supplied', async () => {
    const rendered = await renderAuthTemplateString('{{request.pathAndQuery}}', {
      fields: {},
      request: { method: 'GET', url: 'https://x.example/v1/a?b=1' },
    });
    expect(rendered).toBe('/v1/a?b=1');
  });

  it('rejects unknown placeholders, unknown helpers, and request refs without a request', async () => {
    // The REJECTION is unchanged; only WHERE it lands moved. P0 put the lint in front of
    // `renderAuthHeaderTemplate` (AC8), so an unknown token or helper is now caught
    // statically — before any credential is read — and surfaces as AuthTemplateLintError
    // rather than AuthTemplateError. Widened to the base `Error` for the two header-seat
    // cases so this test pins the CLAIM ("these never render") instead of which of two
    // layers happened to catch it first.
    await expect(renderAuthHeaderTemplate({ 'X-Bad': '{{nope}}' }, ctx)).rejects.toThrow(AuthTemplateLintError);
    await expect(renderAuthHeaderTemplate({ 'X-Bad': '{{md5(api_key)}}' }, ctx)).rejects.toThrow(AuthTemplateLintError);
    // The string seat has no lint gate (it is the primitive the lint's own tests use to
    // demonstrate the engine's raw behavior), so the ENGINE's own rejection still stands
    // here — the defense-in-depth half of AC8.
    await expect(
      renderAuthTemplateString('{{request.body}}', { fields: {} }),
    ).rejects.toThrow(AuthTemplateError);
    await expect(renderAuthTemplateString('{{nope}}', ctx)).rejects.toThrow(AuthTemplateError);
  });

  it('hmac helpers require both arguments', async () => {
    await expect(
      renderAuthTemplateString('{{hmac_sha256(api_secret)}}', ctx),
    ).rejects.toThrow(AuthTemplateError);
  });
});
