// registry-template-parity.test.ts — TASK-20260810-p4-starters P4-AC12, RE-POINTED by
// TASK-20260812-desktop-auth-awareness P3 (ADR-0022 §1/§5, amendment AC9).
//
// THE FORK CLASS THIS EXISTS TO PREVENT: a request template referencing a field key the
// field list does not declare. The template engine resolves a `{{token}}` against the
// FIELD KEY, so a forked key renders a header present-but-EMPTY (or a signing helper
// throwing), and the provider answers a generic 401 with nothing in the UI to explain
// it. The founding instance was the registry keying Coinbase's third secret
// `api_passphrase` while the taught template signed with `{{passphrase}}`.
//
// WHAT CHANGED AT P3 (the migration, classified):
//
//   - MIGRATED: the Coinbase parity. The registry now carries its OWN pinned
//     `request.headerTemplate` (ADR-0022 §1) — `Authorization: Bearer
//     {{cdp_jwt(api_key, private_key)}}` — so the parity is between the ENTRY's template
//     tokens and the ENTRY's field keys, both read from the same reviewed object. The
//     old suite compared the registry against a transcription of the KB-taught HMAC
//     template; the transcription seat is gone because the artifact it transcribed is
//     now first-class registry data.
//   - OBSOLETE: the `passphrase`-vs-`api_passphrase` pins. The HMAC + passphrase scheme
//     described retail keys Coinbase EXPIRED 2025-02-05 (ADR-0022 §5 drops the
//     institutional Exchange surface); no registry entry declares a passphrase seat any
//     more. The KB still teaches the HMAC shape — deliberately — as the FICTIONAL
//     "Meridian Exchange" authored-provider example, and THAT text is linted against its
//     own declared keys by the playground's `taughtTemplatesLint.test.ts`, which reads
//     the rendered KB rather than a transcription.
//   - KEPT: the whole-registry key-shape discipline, now extended to lint EVERY entry's
//     (and option's) templates against its own field list, so the next data entry
//     cannot fork on arrival.
//
// C1 — field keys and template SHAPES only. The EC key used by the end-to-end render is
// the checked-in openssl TEST fixture from cdp-jwt.test.ts, in no provider account.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { lintAuthHeaderTemplate } from '../template-lint.js';
import { renderAuthRequestTemplates } from '../template-engine.js';
import { WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

const registryFieldKeys = (key: string): string[] =>
  (WELL_KNOWN_PROVIDERS_REGISTRY[key]?.fields ?? []).map((field) => field.key);

/** Every field-key `{{...}}` token in a template, helper calls unwrapped to their args. */
function templateFieldTokens(template: Record<string, string>): Set<string> {
  const tokens = new Set<string>();
  for (const value of Object.values(template)) {
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

describe('P3 (MIGRATED) — the Coinbase pinned template and field keys CANNOT fork', () => {
  it('every token the pinned template references IS a declared field key — and vice versa', () => {
    // Both directions on purpose: an unreferenced credential field is a value the user
    // is asked to paste that no request ever uses — the "saved api_secret read by no
    // code path" defect this task closed (ADR-0022 context).
    const template = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.request?.headerTemplate;
    expect(template, 'the coinbase entry must pin a request template for this to mean anything').toBeDefined();
    const referenced = [...templateFieldTokens(template!)].sort();
    expect(referenced).toEqual([...registryFieldKeys('coinbase')].sort());
  });

  it('the pinned template LINTS CLEAN against the registry field list (one resolution)', () => {
    const template = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!.request!.headerTemplate!;
    const result = lintAuthHeaderTemplate({ ...template }, { fieldKeys: registryFieldKeys('coinbase') });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('EVERY token RESOLVES end to end — the pinned template renders a real Bearer JWT', async () => {
    // The proof that would have caught the founding fork by itself: render the PINNED
    // template with a value under each REGISTRY key and assert no header comes out
    // empty or still carrying `{{...}}`. The private key is the checked-in SEC1 test
    // fixture — the exact PEM shape the CDP portal downloads (amendment 4).
    const sec1Pem = readFileSync(join(__dirname, 'fixtures', 'cdp-test-key.sec1.pem'), 'utf8');
    const values: Record<string, string> = {
      api_key: 'organizations/11111111-2222-3333-4444-555555555555/apiKeys/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      private_key: sec1Pem,
    };
    expect(Object.keys(values).sort()).toEqual([...registryFieldKeys('coinbase')].sort());

    const { headers } = await renderAuthRequestTemplates(
      { headerTemplate: { ...WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!.request!.headerTemplate! } },
      {
        fields: values,
        declaredFieldKeys: registryFieldKeys('coinbase'),
        request: { method: 'GET', url: 'https://api.coinbase.com/api/v3/brokerage/accounts' },
      },
    );

    for (const [name, value] of Object.entries(headers)) {
      expect(value, `${name} rendered EMPTY — a field key fork sends a blank auth header`).not.toBe('');
      expect(value, `${name} still carries an unresolved token`).not.toMatch(/\{\{/);
    }
    // The Authorization header specifically: a minted three-segment JWT, never key bytes.
    const authorization = headers['Authorization']!;
    expect(authorization.startsWith('Bearer ')).toBe(true);
    expect(authorization.slice('Bearer '.length).split('.')).toHaveLength(3);
    expect(authorization, 'the private key must never appear in a rendered header (C1)').not.toContain('PRIVATE KEY');
  });

  it('the testRequest probe path targets the SAME surface the template signs for', () => {
    // The uri claim of the minted JWT is '<METHOD> <host><path>'; a probe aimed at a
    // different host would freeze a ceiling the signature never matches. Path-only by
    // schema; the host is the entry's pinned apiHosts — asserted together here.
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.testRequest).toEqual({
      method: 'GET',
      pathAndQuery: '/api/v3/brokerage/accounts',
    });
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.apiHosts).toEqual(['api.coinbase.com']);
  });
});

describe('P3 — the whole-registry parity discipline (the next entry cannot fork on arrival)', () => {
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    const flows = [
      { name: key, fields: entry.fields, request: entry.request },
      ...(entry.authOptions ?? []).map((option) => ({
        name: `${key}.${option.id}`,
        fields: option.fields,
        request: option.request,
      })),
    ];
    for (const flow of flows) {
      if (flow.request === undefined) continue;
      it(`${flow.name}: every pinned template lints clean against its OWN field keys`, () => {
        const fieldKeys = (flow.fields ?? []).map((field) => field.key);
        for (const template of [flow.request?.headerTemplate, flow.request?.queryTemplate]) {
          if (template === undefined) continue;
          const result = lintAuthHeaderTemplate({ ...template }, { fieldKeys });
          expect(result.ok, `${flow.name}: ${JSON.stringify(result)}`).toBe(true);
        }
      });
    }
  }

  it('every registry entry with fields uses lowercase snake_case keys a template can reference', () => {
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      for (const field of entry.fields ?? []) {
        expect(field.key, `${key}.${field.key} must be a referenceable template token`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('no registry entry declares a passphrase seat any more (the OBSOLETE pin, stated)', () => {
    // The old suite pinned `passphrase` IN; this pins it OUT, so the classification is
    // enforced rather than narrated: the HMAC+passphrase surface was dropped
    // (ADR-0022 §5 — institutional Exchange, out of product scope), and a passphrase
    // seat reappearing in ANY entry should be a deliberate decision that moves this
    // fence, not a drive-by.
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      for (const field of entry.fields ?? []) {
        expect(field.key, `${key} re-grew a passphrase seat`).not.toBe('passphrase');
      }
    }
  });
});
