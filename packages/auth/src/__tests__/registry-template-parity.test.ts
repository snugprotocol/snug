// registry-template-parity.test.ts — TASK-20260810-p4-starters, P4-AC12 (RED-FIRST).
//
// THE FORK THIS EXISTS TO PREVENT, stated as the concrete failure it produced.
//
// P4 added `fields` to the Coinbase registry entry and keyed the third secret
// `api_passphrase`. Every OTHER site in the repo keys it `passphrase` — the KB-taught
// header template (`CB-ACCESS-PASSPHRASE: {{passphrase}}`), the template lint's
// DECLARED_FIELDS, the template-parity and template-engine suites, the playground's
// taught-templates lint, the demo requirement, and the protocol's own contract test.
//
// The template engine resolves a `{{token}}` against the FIELD KEY. So once the registry's
// fields actually reached the wizard (they did not, until the substitution fix landed
// alongside this file), a Coinbase connection would collect a value under `api_passphrase`
// while the signing template asked for `passphrase` — leaving `CB-ACCESS-PASSPHRASE`
// present but EMPTY and producing a generic 401 with nothing in the UI to explain it.
//
// That ordering is why this test is not optional: the substitution fix converts a
// dead-data bug into a wrong-signature bug, and a wrong signature is strictly harder to
// diagnose than a missing box. The rename and the substitution had to land together.
//
// WHY A LINT RATHER THAN A CORRECTED LITERAL. The repo already has a written lesson about
// exactly this — `examples/validate.test.mjs` cherry-picks a security literal from its
// source "so the two tasks cannot fork" (the 2026-08-03 shared-literal lesson). Renaming
// `api_passphrase` fixes today; only a test that reads BOTH sides and compares them stops
// the next author from forking it again. This file is that comparison.
//
// C1 — reads field KEYS and template SHAPES only. No credential value appears here.

import { describe, expect, it } from 'vitest';

import { lintAuthHeaderTemplate } from '../template-lint.js';
import { renderAuthHeaderTemplate } from '../template-engine.js';
import { WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

/**
 * The KB-taught Coinbase header template, transcribed from
 * `packages/knowledge/.../90-auth-and-connected-apis.md` and from the inferrer tool
 * prompt, which teach the SAME shape.
 *
 * This is the artifact the registry's field keys must satisfy. It is written out rather
 * than imported because the KB ships as generated content in another package and this
 * assertion must fail on a REGISTRY edit, not merely on a KB edit — but it is the tokens
 * that matter, and those are pinned against the registry below in both directions.
 */
const TAUGHT_COINBASE_HEADERS: Record<string, string> = {
  'CB-ACCESS-KEY': '{{api_key}}',
  'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
  'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
  'CB-ACCESS-SIGN':
    '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
};

/** Every `{{...}}` token in a template, helper calls unwrapped to their first argument. */
function templateFieldTokens(headers: Record<string, string>): Set<string> {
  const tokens = new Set<string>();
  for (const value of Object.values(headers)) {
    for (const match of value.matchAll(/\{\{([^}]+)\}\}/g)) {
      const inner = (match[1] ?? '').trim();
      // Request facts are not field keys — they come from the outgoing request.
      if (inner.startsWith('request.')) continue;
      const call = /^[a-z0-9_]+\(([^)]*)\)$/i.exec(inner);
      if (call !== null) {
        for (const arg of (call[1] ?? '').split(',')) {
          const trimmed = arg.trim();
          if (trimmed === '' || trimmed.startsWith('request.')) continue;
          // A QUOTED argument is a literal, never a field reference (the B1 lesson in
          // template-parity.test.ts — quoting is what stopped a credential leak).
          if (/^['"]/.test(trimmed)) continue;
          tokens.add(trimmed);
        }
        continue;
      }
      tokens.add(inner);
    }
  }
  return tokens;
}

const registryFieldKeys = (key: string): string[] =>
  (WELL_KNOWN_PROVIDERS_REGISTRY[key]?.fields ?? []).map((field) => field.key);

describe('P4-AC12 — the registry field keys and the taught template CANNOT fork', () => {
  it('every field key the taught Coinbase template references EXISTS in the registry entry', () => {
    // The direction that produces the wrong-signature bug: a template asking for
    // `passphrase` against a registry that offers only `api_passphrase` renders the header
    // present-but-empty. The provider answers 401 and nothing in the product explains it.
    const referenced = [...templateFieldTokens(TAUGHT_COINBASE_HEADERS)];
    const declared = registryFieldKeys('coinbase');

    expect(declared.length, 'the coinbase entry must declare fields for this to mean anything').toBeGreaterThan(0);
    for (const token of referenced) {
      expect(declared, `the taught template signs with {{${token}}} — the registry must offer that key`).toContain(
        token,
      );
    }
  });

  it('the registry declares the passphrase as `passphrase`, matching all seven other sites', () => {
    // Named explicitly rather than left implicit in the set comparison, so the failure
    // message points at the actual fork rather than at a set difference.
    const declared = registryFieldKeys('coinbase');
    expect(declared).toContain('passphrase');
    expect(declared, 'api_passphrase is the fork — every other declaration site uses `passphrase`').not.toContain(
      'api_passphrase',
    );
  });

  it('the taught Coinbase template LINTS CLEAN against the registry field list', () => {
    // The composed claim: registry fields + taught template is a combination the host
    // will actually accept. A rename that satisfied the token check but broke the lint
    // (a field key the lint's own grammar rejects) would still ship a dead connection.
    const result = lintAuthHeaderTemplate({ ...TAUGHT_COINBASE_HEADERS }, { fieldKeys: registryFieldKeys('coinbase') });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('EVERY token in the taught template RESOLVES against the registry keys — no empty header', async () => {
    // The end-to-end proof, and the one that would have caught the fork by itself: render
    // the taught template with a value under each REGISTRY key and assert no header comes
    // out empty or still carrying an unresolved `{{...}}`.
    //
    // Values here are obvious non-secrets. `api_secret` is base64 because the HMAC helper
    // decodes it; a real secret never appears in this repo (C1).
    const values: Record<string, string> = {};
    for (const key of registryFieldKeys('coinbase')) {
      values[key] = key === 'api_secret' ? 'MTIzNA==' : `not-a-real-${key}`;
    }

    const headers = await renderAuthHeaderTemplate(
      { ...TAUGHT_COINBASE_HEADERS },
      {
        fields: values,
        // The signing template references request facts; a context without them throws
        // before any field-key question can be answered.
        request: {
          method: 'GET',
          url: 'https://api.coinbase.com/v2/accounts',
          pathAndQuery: '/v2/accounts',
          body: '',
        },
      },
    );

    for (const [name, value] of Object.entries(headers)) {
      expect(value, `${name} rendered EMPTY — a field key fork sends a blank auth header`).not.toBe('');
      expect(value, `${name} still carries an unresolved token`).not.toMatch(/\{\{/);
    }
    // The passphrase header specifically: this is the value the fork blanked.
    expect(headers['CB-ACCESS-PASSPHRASE']).toBe(values['passphrase']);
  });

  it('every registry entry with fields uses lowercase snake_case keys a template can reference', () => {
    // Applies the discipline to the whole registry rather than to Coinbase alone, so the
    // next static-kind entry cannot introduce a key shape the template grammar refuses.
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      for (const field of entry.fields ?? []) {
        expect(field.key, `${key}.${field.key} must be a referenceable template token`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });
});
