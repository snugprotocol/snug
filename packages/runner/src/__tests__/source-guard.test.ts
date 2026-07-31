// AC-2 (C2 no-bypass): text-level guards over the shipped sources — the sandbox
// attribute is the exact literal `allow-scripts`, `allow-same-origin` appears nowhere,
// no sandbox value is built dynamically, and the CSP is a frozen constant no API
// parameterizes.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CDN_ALLOWLIST } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';
import { RUNNER_CSP, injectCsp } from '../csp.js';

const srcDir = join(__dirname, '..');

function shippedSources(dir = srcDir): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...shippedSources(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) out.push({ path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

describe('source guard — sandbox integrity (C2)', () => {
  const sources = shippedSources();

  it('collects the shipped sources', () => {
    const names = sources.map((s) => s.path);
    expect(names.some((n) => n.endsWith('csp.ts'))).toBe(true);
    expect(names.some((n) => n.endsWith('SnugAppFrame.tsx'))).toBe(true);
  });

  it("the string 'allow-same-origin' appears in NO shipped source", () => {
    for (const { path, text } of sources) {
      expect(text.includes('allow-same-origin'), path).toBe(false);
    }
  });

  it('every sandbox attribute is the exact literal "allow-scripts"; none is built dynamically', () => {
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/sandbox\s*=\s*(.{0,20})/g)) {
        expect(match[1]!.startsWith('"allow-scripts"'), `${path}: ${match[0]}`).toBe(true);
      }
      expect(text.includes('sandbox={'), path).toBe(false);
      expect(/setAttribute\(\s*['"]sandbox['"]/g.test(text), path).toBe(false);
    }
  });

  it('injectCsp takes only the html argument — the policy is not parameterizable', () => {
    expect(injectCsp.length).toBe(1);
  });

  it('RUNNER_CSP is interpolated only from the protocol CDN_ALLOWLIST', () => {
    const urls = RUNNER_CSP.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set(CDN_ALLOWLIST));
  });

  it('only csp.ts mentions Content-Security-Policy among shipped sources (single policy authority)', () => {
    const holders = sources.filter(({ text }) => text.includes("'Content-Security-Policy'"));
    expect(holders.map(({ path }) => path.split('/').at(-1))).toEqual(['csp.ts']);
  });

  it('no shipped source mutates or shadows RUNNER_CSP', () => {
    for (const { path, text } of sources) {
      expect(/RUNNER_CSP\s*=/.test(text.replace('export const RUNNER_CSP: string =', '')), path).toBe(false);
    }
  });
});
