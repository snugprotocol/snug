// AL-02 AC5: packages/auth is browser-safe and exposes NO configurable-security
// surface (C1 / finding 4 / lesson "never reintroduce configurable security"):
//   - no node: imports, no Buffer, no process.env anywhere in src/
//   - no strictness/skip-validation/bypass parameter in any exported API
// This is the lint the plan calls the "browser-safety lint test" + "signature walk".
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
