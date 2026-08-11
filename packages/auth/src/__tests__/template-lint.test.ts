// Dynamic Auth v2 P0 — Gate 3 (RED). Template lint + helper trim: AC6, AC7, AC8.
//
// Fold S-M2: the shipped engine and the pinned enum disagree. `template-engine.ts:65-84`
// ships SIX helpers (timestamp, unix_ms, base64, hmac_sha256, hmac_sha512, sha256)
// against a pinned enum of FOUR, and `resolveArgToken:180-190` treats any unrecognized
// token as a LITERAL — so a typo'd field name silently signs the string "api_secrt"
// instead of failing. That fallback is the hole the lint exists to close: it must be
// UNREACHABLE from a linted template, which is a stronger claim than "the engine throws".
//
// The lint module does not exist yet. It is imported dynamically per suite so a missing
// module fails THESE tests with a readable message instead of collapsing the file at
// load time — AC7 tests the ALREADY-SHIPPED engine and must fail for its own reason
// (three helpers still present), not for a resolution error it does not own.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(__dirname, '..');

/**
 * The pinned helper enum. FOUR names, per the P0 encoding decision (fold F-m3):
 * `hmac_sha256_b64` is the added encoding-capable variant that makes Coinbase-Exchange's
 * base64(HMAC(base64decode(secret), msg)) expressible — verified inexpressible today
 * because `hmacHex:49-54` returns hex unconditionally and the grammar has no nesting.
 */
const PINNED_HELPERS = ['timestamp', 'hmac_sha256', 'hmac_sha256_b64', 'base64'] as const;

/**
 * The pinned request tokens — this IS `readRequestField`'s switch, not an inference.
 * `request.timestamp` is the render-minted one (review blocker B2): it is what makes the
 * timestamp writable in ARGUMENT position, which is what the Coinbase-Exchange prehash
 * needs and what no helper-call form could supply.
 */
const PINNED_REQUEST_TOKENS = [
  'request.method',
  'request.url',
  'request.pathAndQuery',
  'request.body',
  'request.timestamp',
] as const;

/** Declared field keys for the Coinbase-shaped fixture the lint is exercised against. */
const DECLARED_FIELDS = ['api_key', 'api_secret', 'passphrase'] as const;

type LintModule = typeof import('../template-lint.js');

async function loadLint(): Promise<LintModule> {
  return (await import('../template-lint.js')) as LintModule;
}

function walkSources(): Array<{ name: string; text: string }> {
  const files: Array<{ name: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push({ name: entry.name, text: readFileSync(full, 'utf8') });
    }
  };
  walk(srcDir);
  return files;
}

// ---------------------------------------------------------------------------
// AC7 — the engine's HELPERS map equals the pinned enum EXACTLY
// ---------------------------------------------------------------------------

describe('AC7 — HELPERS map equals the pinned enum exactly (fold S-M2a)', () => {
  // Asserting the map's key set (not just "the extras are gone") is what keeps the trim
  // honest in both directions — a future helper added without an enum amendment fails here.
  it('the pinned enum lists exactly the four agreed names', async () => {
    // Test-side literal vs the exported enum. This half only pins the ENUM's contents; on
    // its own it says nothing about the engine — see the next test for that.
    const { AUTH_TEMPLATE_HELPERS } = await loadLint();
    expect([...AUTH_TEMPLATE_HELPERS].sort()).toEqual([...PINNED_HELPERS].sort());
  });

  it("the ENGINE's helper map set-equals the pinned enum", async () => {
    // The real AC7, and previously a TAUTOLOGY: this suite compared the local
    // `PINNED_HELPERS` array to `AUTH_TEMPLATE_HELPERS` and stopped there. Both are
    // lint/test-side constants, so the assertion was the enum equalling itself — the
    // engine's `HELPERS` map was never read, and a helper added to the engine alone would
    // have passed. `AUTH_ENGINE_HELPER_NAMES` is the engine's actual `Object.keys(HELPERS)`,
    // so this compares the two SIDES the invariant is about.
    const { AUTH_TEMPLATE_HELPERS } = await loadLint();
    const { AUTH_ENGINE_HELPER_NAMES } = await import('../template-engine.js');
    expect(
      [...AUTH_ENGINE_HELPER_NAMES].sort(),
      'the engine implements a different helper set than the lint enforces',
    ).toEqual([...AUTH_TEMPLATE_HELPERS].sort());
  });

  it('unix_ms, hmac_sha512 and sha256 are GONE from the engine', async () => {
    // Probed through the render surface rather than by reaching into the private map:
    // the trim only counts if it is unreachable from a template, which is the only way
    // a caller can touch a helper at all.
    const { renderAuthTemplateString, AuthTemplateError } = await import('../template-engine.js');
    const ctx = { fields: { api_secret: 'S' }, request: { method: 'GET', url: 'https://x.example/a' } };

    for (const gone of ['unix_ms', 'hmac_sha512', 'sha256']) {
      const template = gone === 'unix_ms' ? `{{${gone}()}}` : `{{${gone}(api_secret, request.body)}}`;
      await expect(
        renderAuthTemplateString(template, ctx),
        `${gone} still renders — the trim did not happen`,
      ).rejects.toThrow(AuthTemplateError);
    }
  });

  it('the four pinned helpers all still render (the trim did not overshoot)', async () => {
    const { renderAuthTemplateString } = await import('../template-engine.js');
    const ctx = {
      fields: { api_secret: 'MTIzNA==' },
      request: { method: 'POST', url: 'https://x.example/a?b=1', body: '{}' },
    };
    await expect(renderAuthTemplateString('{{timestamp()}}', ctx)).resolves.toMatch(/^\d{10}$/);
    await expect(renderAuthTemplateString("{{base64('hello')}}", ctx)).resolves.toBe('aGVsbG8=');
    await expect(renderAuthTemplateString('{{hmac_sha256(api_secret, request.body)}}', ctx)).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    );
    // The added variant: standard-base64 digest, NOT hex — the whole point of F-m3.
    await expect(renderAuthTemplateString('{{hmac_sha256_b64(api_secret, request.body)}}', ctx)).resolves.toMatch(
      /^[A-Za-z0-9+/]{43}=$/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC6 — the lint rejects out-of-enum helpers and undeclared bare tokens
// ---------------------------------------------------------------------------

describe('AC6(a) — helper name must be in the pinned enum (negative)', () => {
  it('accepts every pinned helper', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    const result = lintAuthHeaderTemplate(
      {
        'CB-ACCESS-KEY': '{{api_key}}',
        'CB-ACCESS-TIMESTAMP': '{{timestamp()}}',
        'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
        'CB-ACCESS-SIGN': '{{hmac_sha256_b64(api_secret, request.body)}}',
        'X-Alt': '{{hmac_sha256(api_secret, request.pathAndQuery)}}',
        'X-Enc': "{{base64('literal')}}",
      },
      { fieldKeys: [...DECLARED_FIELDS] },
    );
    expect(result.ok, `lint rejected a valid template: ${JSON.stringify(result)}`).toBe(true);
  });

  it('rejects the three TRIMMED helpers by name', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    // These are exactly the names AC7 deletes from the engine. The lint must reject them
    // INDEPENDENTLY of the engine — defense in depth: a template linted under an older
    // enum must not become renderable if a helper is ever re-added to the map.
    for (const gone of ['unix_ms', 'hmac_sha512', 'sha256']) {
      const result = lintAuthHeaderTemplate(
        { 'X-Bad': `{{${gone}(api_secret, request.body)}}` },
        { fieldKeys: [...DECLARED_FIELDS] },
      );
      expect(result.ok, `lint accepted trimmed helper ${gone}`).toBe(false);
      expect(JSON.stringify(result)).toContain(gone);
    }
  });

  it('rejects helpers that were never in the enum', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    for (const bogus of ['md5', 'eval', 'fetch', 'base64decode', 'constructor', '__proto__']) {
      const result = lintAuthHeaderTemplate(
        { 'X-Bad': `{{${bogus}(api_secret)}}` },
        { fieldKeys: [...DECLARED_FIELDS] },
      );
      expect(result.ok, `lint accepted unknown helper ${bogus}`).toBe(false);
    }
  });

  it('rejects a helper ARGUMENT that is neither a declared field, a pinned request token, nor a quoted literal', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    // The literal fallback lives in ARGUMENT position (`resolveArgToken:188-189`), so
    // arg-position linting is where the hole actually is. `api_secrt` is the typo shape:
    // today it signs the eight-character string instead of the credential.
    const typo = lintAuthHeaderTemplate(
      { 'CB-ACCESS-SIGN': '{{hmac_sha256(api_secrt, request.body)}}' },
      { fieldKeys: [...DECLARED_FIELDS] },
    );
    expect(typo.ok, 'lint accepted a typo\'d field key in argument position').toBe(false);

    const badRequestToken = lintAuthHeaderTemplate(
      { 'CB-ACCESS-SIGN': '{{hmac_sha256(api_secret, request.headers)}}' },
      { fieldKeys: [...DECLARED_FIELDS] },
    );
    expect(badRequestToken.ok, 'lint accepted request.headers, which is not a pinned token').toBe(false);
  });
});

describe('AC6(b) — bare tokens must be a declared field key or a pinned request token (negative)', () => {
  it('accepts every declared field key as a bare token', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    for (const key of DECLARED_FIELDS) {
      const result = lintAuthHeaderTemplate({ 'X-H': `{{${key}}}` }, { fieldKeys: [...DECLARED_FIELDS] });
      expect(result.ok, `lint rejected declared field ${key}`).toBe(true);
    }
  });

  it('accepts every pinned request token as a bare token, and NO others', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    for (const token of PINNED_REQUEST_TOKENS) {
      const result = lintAuthHeaderTemplate({ 'X-H': `{{${token}}}` }, { fieldKeys: [...DECLARED_FIELDS] });
      expect(result.ok, `lint rejected pinned request token ${token}`).toBe(true);
    }
    // `readRequestField:206-207` throws on anything else; the lint must agree statically.
    for (const token of ['request.headers', 'request.host', 'request.query', 'request.', 'request.body.raw']) {
      const result = lintAuthHeaderTemplate({ 'X-H': `{{${token}}}` }, { fieldKeys: [...DECLARED_FIELDS] });
      expect(result.ok, `lint accepted non-pinned request token ${token}`).toBe(false);
    }
  });

  it('rejects a bare token that is neither — including one that is a field key of a DIFFERENT connection', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    const undeclared = lintAuthHeaderTemplate({ 'X-H': '{{client_secret}}' }, { fieldKeys: [...DECLARED_FIELDS] });
    expect(undeclared.ok, 'lint accepted an undeclared bare token').toBe(false);

    // The empty-fieldKeys case: with nothing declared, only request tokens may appear.
    const nothingDeclared = lintAuthHeaderTemplate({ 'X-H': '{{api_key}}' }, { fieldKeys: [] });
    expect(nothingDeclared.ok, 'lint accepted a field token when no fields are declared').toBe(false);
  });
});

describe('AC6(c) — the unknown-token-to-literal fallback is UNREACHABLE through a linted template', () => {
  // The load-bearing test of the whole lint. `resolveArgToken:188-189` returns the token
  // itself when it matches neither `request.*` nor a declared field. That is a SILENT
  // wrong-signature bug, not a loud one — the engine throws for bare placeholders
  // (`resolveExpression:138`) but NOT for helper arguments. So "the engine rejects it"
  // is false today, and the lint is the only thing standing between a typo and a
  // signature computed over the literal string "api_secrt".
  it('proves the fallback is live in the engine today (the hole the lint must close)', async () => {
    const { renderAuthTemplateString } = await import('../template-engine.js');
    const rendered = await renderAuthTemplateString('{{base64(api_secrt)}}', {
      fields: { api_secret: 'SUPERSECRET' },
      request: { method: 'GET', url: 'https://x.example/a' },
    });
    // base64('api_secrt') — the LITERAL, not the credential. Documented, not asserted away.
    expect(rendered).toBe('YXBpX3NlY3J0');
  });

  it('every template the lint accepts renders with zero literal-fallback resolutions', async () => {
    const { lintAuthHeaderTemplate } = await loadLint();
    const fields = { api_key: 'AKID', api_secret: 'MTIzNA==', passphrase: 'phrase42' };
    const request = { method: 'POST', url: 'https://api.exchange.coinbase.com/orders', body: '{"x":1}' };

    // A corpus mixing valid templates with the fallback-triggering shapes. For EVERY
    // member the claim is the same: lint-rejected, or renders without any argument
    // resolving to its own token text.
    const corpus = [
      '{{api_key}}',
      '{{hmac_sha256(api_secret, request.body)}}',
      '{{hmac_sha256_b64(api_secret, request.body)}}',
      '{{base64(api_secrt)}}', // typo -> literal today
      '{{hmac_sha256(api_secret, request.bdy)}}', // typo'd request token
      '{{hmac_sha256(NOT_A_FIELD, request.body)}}',
      '{{unix_ms()}}',
    ];

    for (const template of corpus) {
      const lint = lintAuthHeaderTemplate({ 'X-H': template }, { fieldKeys: Object.keys(fields) });
      if (!lint.ok) continue; // rejected before render — the lint did its job

      const { renderAuthTemplateString } = await import('../template-engine.js');
      const rendered = await renderAuthTemplateString(template, { fields, request });
      // No accepted template may render to the literal text of an identifier inside it.
      for (const identifier of ['api_secrt', 'NOT_A_FIELD', 'request.bdy']) {
        expect(rendered, `lint ACCEPTED ${template}, which then rendered the literal ${identifier}`).not.toContain(
          identifier,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC8 — no render path reaches renderAuthHeaderTemplate without a passing lint
// ---------------------------------------------------------------------------

describe('AC8 — no render path bypasses the lint (unit + source proof)', () => {
  it('renderAuthHeaderTemplate refuses an unlinted template at runtime', async () => {
    // The unit half. A template carrying a trimmed helper must not render even when the
    // caller skips the lint entirely — the render seat enforces, it does not merely trust.
    const { renderAuthHeaderTemplate } = await import('../template-engine.js');
    await expect(
      renderAuthHeaderTemplate(
        { 'X-Bad': '{{hmac_sha512(api_secret, request.body)}}' },
        { fields: { api_secret: 'S' }, request: { method: 'GET', url: 'https://x.example/a' } },
      ),
    ).rejects.toThrow();
  });

  it('renderAuthHeaderTemplate refuses a template whose tokens are not declared fields', async () => {
    const { renderAuthHeaderTemplate } = await import('../template-engine.js');
    // Precisely the AC6(c) hole, at the header-object seat: the argument is undeclared,
    // so this must throw rather than sign the literal.
    await expect(
      renderAuthHeaderTemplate(
        { 'CB-ACCESS-SIGN': '{{hmac_sha256(api_secrt, request.body)}}' },
        { fields: { api_secret: 'S' }, request: { method: 'GET', url: 'https://x.example/a' } },
      ),
    ).rejects.toThrow();
  });

  it('the UNLINTED render primitive is not reachable from outside the package', () => {
    // THE STRUCTURAL HALF, and the one that actually carries AC8 outside this package.
    //
    // `renderAuthTemplateString` is the primitive with NO lint gate — the gate sits on the
    // header-object seat (`renderAuthHeaderTemplate`), which is the seat every production
    // caller uses. So the honest way to stop an external caller from rendering unlinted is
    // not to grep for one, it is to make the unlinted function unimportable: it is no
    // longer re-exported from `index.ts`. External packages can reach ONLY the gated seat.
    //
    // What this proves: no module outside `packages/auth` can call the unlinted primitive
    // at all, because the package does not expose it.
    // What it does NOT prove: anything about modules INSIDE this package, which can still
    // import it by relative path — that case is carried by the sweep below.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(
      /renderAuthHeaderTemplate/.test(index),
      'the gated render seat should stay exported — narrowing must not remove the supported API',
    ).toBe(true);
    expect(
      /renderAuthTemplateString/.test(index),
      'index.ts re-exports the UNLINTED render primitive — an external caller can bypass the gate',
    ).toBe(false);
  });

  it('source proof: no in-package module calls a render function without importing the lint', () => {
    // The grep half (precedent: browser-safe.test.ts), retained for in-package callers now
    // that the export surface covers external ones. A runtime test can only cover the paths
    // it thinks to call; this one fails when a NEW unlinted call site is added.
    //
    // STATED PLAINLY, because this was previously over-claimed as a bypass proof:
    // this test proves CO-OCCURRENCE — that a rendering module also imports the lint module
    // — and nothing more. It does NOT prove ORDERING (that the lint runs BEFORE the render),
    // it does not prove the imported symbol is actually CALLED, and it does not prove the
    // lint was called with the right field keys. Those three are carried by the runtime
    // tests above and by `connected-fetch.test.ts`, not here. Its real value is as a
    // tripwire: a new module that renders without even importing the lint is caught the day
    // it is added, which grep can honestly do and a fixed set of runtime tests cannot.
    const offenders: string[] = [];
    for (const { name, text } of walkSources()) {
      if (name === 'template-engine.ts' || name === 'template-lint.ts') continue; // definition + lint itself
      if (name === 'index.ts') continue; // pure re-export barrel; covered by the export test above
      if (!/renderAuthHeaderTemplate|renderAuthTemplateString/.test(text)) continue;
      if (!/from '\.\/template-lint\.js'/.test(text)) {
        offenders.push(`${name} renders a template without importing the lint`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('source proof: the engine module itself gates rendering on the lint', () => {
    // The engine is excluded from the sweep above (it DEFINES the render functions), so
    // its own gate is asserted directly — otherwise the sweep is vacuous for the one
    // file that matters most.
    const engine = readFileSync(join(srcDir, 'template-engine.ts'), 'utf8');
    expect(
      /lintAuthHeaderTemplate|assertLintedTemplate|template-lint\.js/.test(engine),
      'template-engine.ts renders without consulting the lint',
    ).toBe(true);
  });
});
