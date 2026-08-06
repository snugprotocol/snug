// AL-02 D6/D7: the header-template engine, ported with its source tests ADAPTED to the
// async-first WebCrypto rewrite (every helper returns a Promise; hmac/sha outputs are
// verified against independently computed digests via crypto.subtle — never node:crypto).
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../base64url.js';
import { AuthTemplateError, renderAuthHeaderTemplate, renderAuthTemplateString } from '../template-engine.js';

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

  it('runs hmac_sha512 and sha256 helpers', async () => {
    const headers = await renderAuthHeaderTemplate(
      { 'X-512': '{{hmac_sha512(api_secret, request.pathAndQuery)}}', 'X-256': "{{sha256('abc')}}" },
      ctx,
    );
    expect(headers['X-512']).toBe(await hmacHex('SHA-512', 'SUPERSECRET', '/v2/orders?limit=10'));
    // NIST vector: SHA-256("abc")
    expect(headers['X-256']).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
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
    await expect(renderAuthHeaderTemplate({ 'X-Bad': '{{nope}}' }, ctx)).rejects.toThrow(AuthTemplateError);
    await expect(renderAuthHeaderTemplate({ 'X-Bad': '{{md5(api_key)}}' }, ctx)).rejects.toThrow(AuthTemplateError);
    await expect(
      renderAuthTemplateString('{{request.body}}', { fields: {} }),
    ).rejects.toThrow(AuthTemplateError);
  });

  it('hmac helpers require both arguments', async () => {
    await expect(
      renderAuthTemplateString('{{hmac_sha256(api_secret)}}', ctx),
    ).rejects.toThrow(AuthTemplateError);
  });
});
