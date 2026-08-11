// Dynamic Auth v2 P0 — the LINT/ENGINE PARITY contract (Gate-2 review blockers B1 + B2).
//
// `template-lint.ts:118-124` claims the lint's scanner is kept "byte-for-byte parallel to
// the engine's scanner ... so a template cannot lint one way and render another". Two
// EXECUTED probes showed that claim was false in both directions, and this file is the
// standing proof that it is now true. Both suites were RED before the fix and are the
// mutation seat for it.
//
// B1 — QUOTING PARITY (credential exfiltration). The lint skips a quoted argument as "a
// literal by authorial intent" (:203-205) and therefore never checks it. The engine's
// `parseHelperArgs` stripped the quotes and then LOST the fact they were there, so
// `resolveArgToken` looked the dequoted text up in `ctx.fields` and resolved it as a
// FIELD. Probe, against the built package:
//     lint  {X: "{{base64('api_key')}}"} with fieldKeys ['api_key']  -> ok: TRUE
//     render same with fields {api_key:'SUPERSECRET'}                -> {"X":"U1VQRVJTRUNSRVQ="}
// which is base64('SUPERSECRET'). A template that passes review as an innocuous constant
// emits the live credential — a C1 breach reachable from an approved template, since the
// reviewer reads quotes and reasonably concludes no credential is referenced.
//
// B2 — the timestamp must be SIGNED and SENT as one value. `RenderState`'s memoization
// (template-engine.ts) is pinned by ADR-0017 as the fix for a real intermittent auth
// failure, but it protected nothing reachable: the Coinbase-Exchange prehash needs the
// timestamp INSIDE the signature argument list, and no argument form could carry it.
// `request.timestamp` is that form. The property under test is not "the two headers match"
// (a weaker claim two frozen clocks would also satisfy) but "the HMAC recomputed from the
// SENT timestamp equals the SENT signature".
import { describe, expect, it } from 'vitest';
import { renderAuthHeaderTemplate, renderAuthTemplateString } from '../template-engine.js';
import { lintAuthHeaderTemplate } from '../template-lint.js';

const COINBASE_FIELDS = ['api_key', 'api_secret', 'passphrase'] as const;

// ---------------------------------------------------------------------------
// B1 — a quoted argument is a literal in the ENGINE too, not only in the lint
// ---------------------------------------------------------------------------

describe('B1 — quoted helper arguments render VERBATIM (lint/engine quoting parity)', () => {
  it('{{base64(\'api_key\')}} renders base64 of the literal "api_key", NOT the credential', async () => {
    // The exact probe that proved the leak. `YXBpX2tleQ==` is base64('api_key');
    // `U1VQRVJTRUNSRVQ=` is base64('SUPERSECRET') and is what shipped before the fix.
    const headers = await renderAuthHeaderTemplate(
      { 'X-Enc': "{{base64('api_key')}}" },
      { fields: { api_key: 'SUPERSECRET' } },
    );
    expect(headers['X-Enc']).toBe('YXBpX2tleQ==');
    expect(headers['X-Enc'], 'the credential reached the wire through a quoted argument').not.toBe(
      'U1VQRVJTRUNSRVQ=',
    );
  });

  it('holds for double quotes and for the request-token namespace', async () => {
    // Every path `resolveArgToken` could take must be cut off by quoting, not just the
    // ctx.fields one — a quoted 'request.body' previously resolved the real body.
    const ctx = {
      fields: { api_key: 'SUPERSECRET' },
      request: { method: 'POST', url: 'https://x.example/v1/a?b=1', body: '{"live":1}' },
    };
    await expect(renderAuthTemplateString('{{base64("api_key")}}', ctx)).resolves.toBe('YXBpX2tleQ==');
    // base64('request.body') — the token text, not '{"live":1}'.
    await expect(renderAuthTemplateString("{{base64('request.body')}}", ctx)).resolves.toBe('cmVxdWVzdC5ib2R5');
  });

  it('an EMPTY quoted argument is an empty literal, not an empty-token fallthrough', async () => {
    // '' must reach the helper as the empty string. The engine short-circuits zero-length
    // tokens before the quoting check, so this pins that the short-circuit is harmless.
    await expect(renderAuthTemplateString("{{base64('')}}", { fields: {} })).resolves.toBe('');
  });

  it('UNQUOTED arguments still resolve as fields — the fix does not blanket-literalize', async () => {
    // The complement, and the reason this cannot be "make everything a literal": the
    // signature path depends on unquoted field resolution actually working.
    const rendered = await renderAuthTemplateString('{{base64(api_key)}}', { fields: { api_key: 'SUPERSECRET' } });
    expect(rendered).toBe('U1VQRVJTRUNSRVQ=');
  });

  it('the LINT and the ENGINE agree on every quoting shape (the parity claim itself)', async () => {
    // The comment at template-lint.ts's `splitHelperArgs` promises a template cannot lint
    // one way and render another. Asserted as a property over a corpus rather than trusted
    // as prose: for each template the lint ACCEPTS, no credential value may appear in the
    // render output unless the template referenced that credential UNQUOTED.
    const fields = { api_key: 'AKID-LIVE-VALUE', api_secret: 'MTIzNA==', passphrase: 'phrase42' };
    const request = { method: 'POST', url: 'https://api.exchange.coinbase.com/orders', body: '{"x":1}' };
    const corpus = [
      "{{base64('api_key')}}",
      '{{base64("api_key")}}',
      "{{base64('passphrase')}}",
      "{{hmac_sha256(api_secret, 'api_key')}}",
      "{{hmac_sha256('api_secret', request.body)}}",
    ];

    for (const template of corpus) {
      const lint = lintAuthHeaderTemplate({ 'X-H': template }, { fieldKeys: Object.keys(fields) });
      expect(lint.ok, `expected the lint to accept ${template}`).toBe(true);
      const rendered = await renderAuthTemplateString(template, { fields, request });
      // Only quoted references appear in this corpus, so no live value may be recoverable.
      // Checked in BOTH plaintext and base64 form, because `base64` is the encoder a
      // quoted-argument leak would exit through and a raw-substring check would miss it.
      for (const value of Object.values(fields)) {
        expect(rendered, `${template} leaked a credential value verbatim`).not.toContain(value);
        expect(rendered, `${template} leaked a base64-encoded credential value`).not.toContain(btoa(value));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B2 — the Coinbase-Exchange template is expressible, and the signed timestamp
//      byte-equals the sent one
// ---------------------------------------------------------------------------

/** The real Coinbase-Exchange header set, as ADR-0017 §Consequences claims is buildable. */
const COINBASE_TEMPLATE = {
  'CB-ACCESS-KEY': '{{api_key}}',
  'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
  'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
  'CB-ACCESS-SIGN':
    '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
} as const;

describe('B2 — the pinned Coinbase-Exchange template is expressible end to end', () => {
  it('the lint ACCEPTS the four-header Exchange template', () => {
    const result = lintAuthHeaderTemplate({ ...COINBASE_TEMPLATE }, { fieldKeys: [...COINBASE_FIELDS] });
    expect(result.ok, `lint rejected the pinned Exchange template: ${JSON.stringify(result)}`).toBe(true);
  });

  it('the timestamp SIGNED byte-equals the timestamp SENT', async () => {
    // THE property. Recompute the signature independently from the value that actually
    // shipped in CB-ACCESS-TIMESTAMP; if the signing site read a different clock tick the
    // recomputation cannot match. This is strictly stronger than comparing two rendered
    // timestamp headers to each other, because it ties the signature's INPUT to the wire.
    const headers = await renderAuthHeaderTemplate(
      { ...COINBASE_TEMPLATE },
      {
        // 'MTIzNA==' is base64('1234') — hmac_sha256_b64 decodes the key before signing.
        fields: { api_key: 'AKID', api_secret: 'MTIzNA==', passphrase: 'phrase42' },
        request: {
          method: 'POST',
          url: 'https://api.exchange.coinbase.com/orders?limit=10',
          pathAndQuery: '/orders?limit=10',
          body: '{"x":1}',
        },
      },
    );

    const sentTimestamp = headers['CB-ACCESS-TIMESTAMP']!;
    expect(sentTimestamp, 'CB-ACCESS-TIMESTAMP is not a unix-seconds value').toMatch(/^\d{10}$/);

    const prehash = `${sentTimestamp}POST/orders?limit=10{"x":1}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('1234'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(prehash)));
    const expected = btoa(String.fromCharCode(...raw));

    expect(
      headers['CB-ACCESS-SIGN'],
      'CB-ACCESS-SIGN was not computed over the timestamp that CB-ACCESS-TIMESTAMP sent',
    ).toBe(expected);

    expect(headers['CB-ACCESS-KEY']).toBe('AKID');
    expect(headers['CB-ACCESS-PASSPHRASE']).toBe('phrase42');
  });

  it('request.timestamp and timestamp() are the SAME value within one render pass', async () => {
    // Both forms are served from the one memoized RenderState slot, so a template mixing
    // them (the shape a hand-edit produces) cannot straddle a second boundary either.
    const headers = await renderAuthHeaderTemplate(
      { 'X-Token': '{{request.timestamp}}', 'X-Helper': '{{timestamp()}}' },
      { fields: {}, request: { method: 'GET', url: 'https://x.example/a' } },
    );
    expect(headers['X-Token']).toBe(headers['X-Helper']);
  });

  it('request.timestamp is a RENDER fact, so it needs no request context', async () => {
    // Unlike request.method/url/body it is not read off the request — it is minted by the
    // render pass. Rendering it without a request must therefore succeed, not throw the
    // "no request context was provided" error the other request tokens raise.
    await expect(renderAuthTemplateString('{{request.timestamp}}', { fields: {} })).resolves.toMatch(/^\d{10}$/);
  });

  it('a nested helper call in argument position is still REJECTED by lint and engine', async () => {
    // The grammar stays FLAT. `request.timestamp` was added precisely so nesting did not
    // have to be, and nesting must not creep in as a side effect: it would make argument
    // evaluation recursive and open an unbounded evaluation surface.
    const lint = lintAuthHeaderTemplate(
      { 'X-Bad': '{{hmac_sha256_b64(api_secret, timestamp(), request.body)}}' },
      { fieldKeys: [...COINBASE_FIELDS] },
    );
    expect(lint.ok, 'the lint accepted a nested helper call in argument position').toBe(false);

    // And the engine must not quietly evaluate it either — the lint is not the only wall.
    const rendered = await renderAuthTemplateString('{{base64(timestamp())}}', {
      fields: {},
      request: { method: 'GET', url: 'https://x.example/a' },
    });
    // base64('timestamp()') — treated as an inert unknown token, never invoked.
    expect(rendered).toBe(btoa('timestamp()'));
  });
});
