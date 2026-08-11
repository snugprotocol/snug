// AL-02 AC5: packages/auth is browser-safe and exposes NO configurable-security
// surface (C1 / finding 4 / lesson "never reintroduce configurable security"):
//   - no node: imports, no Buffer, no process.env anywhere in src/
//   - no strictness/skip-validation/bypass parameter in any exported API
// This is the lint the plan calls the "browser-safety lint test" + "signature walk".
// AL-04 (M7) extends it with an import-SPECIFIER lint and a clean-isolation load
// gate: the AL-03 merge blocker was a phantom third dependency — an undeclared
// source import masked by batch-resolver warming — and package.json checking alone
// never catches that shape.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = join(__dirname, '..');

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

describe('AC5 — browser safety (async-first WebCrypto, plan D6)', () => {
  it('src/ contains no node: imports', () => {
    const offenders = walkSources()
      .filter(({ text }) => /from\s+['"]node:|require\(['"]node:/.test(text))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('src/ never touches Buffer or process.env', () => {
    for (const { name, text } of walkSources()) {
      expect(/\bBuffer\b/.test(text), `${name} uses Buffer`).toBe(false);
      expect(/\bprocess\.env\b/.test(text), `${name} reads process.env`).toBe(false);
    }
  });

  it('runtime dependency surface is the two workspace packages only', () => {
    const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['@snugprotocol/db', '@snugprotocol/protocol']);
  });
});

describe('AL-04 M7 — import-specifier lint + clean-isolation load gate (mutation M22)', () => {
  // package.json pinning is necessary but NOT sufficient: an undeclared bare import
  // in src/ can still resolve when a batch run has warmed the resolver (the AL-03
  // phantom-dep merge blocker). So every import/export specifier in src/ must be a
  // relative path or one of the two pinned workspace packages — nothing else. The
  // inferrer is exactly the module tempted to import `zod`; it must reuse protocol
  // exports (parseAgentReply, inferrerProposalSchema, authSpecSchema) instead.
  const ALLOWED_BARE = new Set(['@snugprotocol/db', '@snugprotocol/protocol']);
  const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^;'"]*from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

  it('every import specifier in src/ is relative or a pinned workspace package', () => {
    const offenders: string[] = [];
    for (const { name, text } of walkSources()) {
      for (const match of text.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined) continue;
        if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
        if (ALLOWED_BARE.has(specifier)) continue;
        offenders.push(`${name}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('auth-spec-inferrer.test.ts loads and passes standalone — not only in a warmed batch run', () => {
    // A child vitest run of ONLY the inferrer suite: an import that resolves solely
    // because a sibling suite warmed the resolver fails here, where it belongs.
    const packageRoot = join(srcDir, '..');
    execFileSync('pnpm', ['exec', 'vitest', 'run', 'src/__tests__/auth-spec-inferrer.test.ts'], {
      cwd: packageRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
  }, 150_000);
});

// P3: `spec-scope.ts` was deleted with the v3 grant surface; this walk now covers the
// inferrer alone. The no-knobs / no-env claims it pins are unchanged.
describe('AL-04 — inferrer walk (D2: no knobs, pinned arity)', () => {
  it('createAuthSpecInferrer takes exactly the deps object', async () => {
    const { createAuthSpecInferrer } = await import('../auth-spec-inferrer.js');
    expect(createAuthSpecInferrer.length).toBe(1);
  });

  it('the inferrer exposes no strictness knob and reads no environment', () => {
    const files = walkSources().filter(({ name }) => ['auth-spec-inferrer.ts'].includes(name));
    expect(files.map(({ name }) => name).sort()).toEqual(['auth-spec-inferrer.ts']);
    for (const { name, text } of files) {
      expect(/\bprocess\.env\b|\bimport\.meta\.env\b/.test(text), `${name} reads environment`).toBe(false);
      expect(/skipValidation|allowInsecure|bypass|insecureMode/i.test(text), `${name} carries a knob`).toBe(false);
    }
  });
});

describe('AC5 — no strictness knob anywhere (C1 / finding 4)', () => {
  it('no identifier in src/ matches a configurable-security shape', () => {
    // The exact anti-patterns the audit found in the source systems (an env-read
    // strict-host flag defaulting off) plus the generic escape-hatch names.
    const forbidden = /\b(strictHost\w*|skipValidation|skipHostCheck|allowInsecure|insecureMode|disableHostCheck|bypassHost\w*|unsafeAllow\w*|noVerify)\b/;
    for (const { name, text } of walkSources()) {
      const match = forbidden.exec(text);
      expect(match, `${name} exposes a security knob: ${match?.[0]}`).toBeNull();
    }
  });

  it('the exported API accepts no boolean that could relax host checking (signature walk on built exports)', async () => {
    const mod = await import('../index.js');
    // Every exported symbol's source text (via toString for functions/classes) must be
    // free of the knob shapes too — this walks the REAL export surface, not files.
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') {
        const text = String(value);
        expect(/strict|skipValidation|allowInsecure|bypass/i.test(text), `${name} carries a knob`).toBe(false);
      }
    }
  });
});

describe('AL-03 named AC — audit bug 3 dies by construction (no strictness flag exists anywhere)', () => {
  // The source-system anti-pattern was an env-read flag (STRICT_AUTH_HOST_INJECTION)
  // defaulting OFF, evaluated per call. The connected-fetch seat must carry NOTHING of
  // that shape: no env read, no per-call mode, no injection toggle of any spelling.
  it('the connected-fetch executor source carries no injection-mode conditional', () => {
    const files = walkSources().filter(({ name }) => ['connected-fetch.ts', 'net-guards.ts', 'scrub.ts', 'session-confirm.ts'].includes(name));
    expect(files.map(({ name }) => name).sort()).toEqual(['connected-fetch.ts', 'net-guards.ts', 'scrub.ts', 'session-confirm.ts']);
    const knob = /STRICT_AUTH_HOST_INJECTION|off[-_]?list[-_]?injection|injectionMode|hostCheckMode|enforceHosts?\b|process\.env/i;
    for (const { name, text } of files) {
      const match = knob.exec(text);
      expect(match, `${name} reintroduces the audit-bug-3 shape: ${match?.[0]}`).toBeNull();
    }
  });

  it('createConnectedFetch deps accept exactly the pinned DI seams — no extra boolean/mode parameter', async () => {
    const { createConnectedFetch } = await import('../connected-fetch.js');
    // Runtime probe: an executor built from ONLY the pinned deps works; there is no
    // required extra parameter, and the factory arity is exactly 1 (the deps object).
    expect(createConnectedFetch.length).toBe(1);
    const executor = createConnectedFetch({
      credentialStore: {
        getCredential: async () => undefined,
        setCredential: async () => undefined,
        deleteCredential: async () => undefined,
        listCredentialFields: async () => [],
        getConnectionState: async () => undefined,
        setConnectionState: async () => undefined,
        clearConnectionState: async () => undefined,
        clearApp: async () => undefined,
        getOrCreateStateHmacKey: async () => 'k',
      },
      connectionReader: { listConnections: () => [] },
      fetchImpl: async () => new Response(''),
      confirmGate: { confirm: async () => false },
    });
    expect(Object.keys(executor)).toEqual(['execute']);
  });
});
