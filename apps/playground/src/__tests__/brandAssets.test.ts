// brandAssets — TASK-20260804-hub-polish Phase D, AC8/AC9.
//
// Covers the static brand assets, which no other test can reach: they are files in
// public/ plus a <link> in index.html, so a break in them is invisible to every
// component test and only shows up as a missing icon in the browser.
//
// The XML-comment assertion is not hypothetical: the first version of favicon.svg
// documented its own color as "--ember" inside an XML comment. A double hyphen is
// illegal inside an XML comment, so the whole file failed to parse and the icon
// silently did not render — the exact 404-class symptom AC8 exists to fix. It was
// caught by rasterizing the file, not by reading it, hence this guard.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '../..');
const read = (rel: string): string => readFileSync(resolve(appRoot, rel), 'utf8');

const ICONS = ['public/favicon.svg', 'public/apple-touch-icon.svg'] as const;

describe('brand assets (AC8)', () => {
  it.each(ICONS)('%s is well-formed XML with no illegal double hyphen in a comment', (rel) => {
    const svg = read(rel);
    // ADVERSARIAL-REVIEW FIX (2026-08-04): this test was named "well-formed XML" but only
    // grepped comments — the reviewer put an unescaped `&` in <title> (a genuine fatal
    // parse error) and all 11 tests stayed GREEN while the icon was broken. That is the
    // exact silent-favicon failure this file exists to prevent, so actually PARSE it.
    // DOMParser is native to the jsdom environment these tests already run under — no
    // new dependency (the task forbids one).
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const parseError = doc.querySelector('parsererror');
    expect(parseError?.textContent ?? '', `${rel} is not well-formed XML`).toBe('');
    expect(doc.documentElement.nodeName).toBe('svg');

    for (const comment of svg.match(/<!--[\s\S]*?-->/g) ?? []) {
      // Strip the delimiters, then any remaining `--` is a hard XML parse error.
      expect(comment.slice(4, -3)).not.toContain('--');
    }
  });

  it.each(ICONS)('%s declares intrinsic width/height so it can render as an image', (rel) => {
    const svg = read(rel);
    expect(svg).toMatch(/<svg[^>]*\swidth="\d+"/);
    expect(svg).toMatch(/<svg[^>]*\sheight="\d+"/);
    expect(svg).toMatch(/<svg[^>]*\sviewBox="/);
  });

  it.each(ICONS)('%s is self-contained — no external refs (AC8)', (rel) => {
    const svg = read(rel);
    expect(svg).not.toMatch(/<image\b/);
    expect(svg).not.toMatch(/href\s*=/);
    expect(svg).not.toMatch(/url\(\s*['"]?https?:/);
  });

  it('favicon inlines the ember hex — currentColor has no meaning without a CSS context', () => {
    const svg = read('public/favicon.svg');
    expect(svg).toContain('#e8873a');
    // Assert on the paint attributes, not the raw file: <desc> legitimately mentions
    // the word "currentColor" when explaining why it is not used here.
    const fills = [...svg.matchAll(/\bfill="([^"]*)"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills).not.toContain('currentColor');
  });

  it('index.html links both the favicon and an apple-touch-icon (the item-12 404)', () => {
    const html = read('index.html');
    expect(html).toMatch(/<link\s+rel="icon"[^>]*href="\/favicon\.svg"/);
    expect(html).toMatch(/<link\s+rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.svg"/);
  });
});

describe('brand sizing (AC9)', () => {
  it('doubles the wordmark to 2.5rem via a token rather than a hardcoded value', () => {
    const tokens = read('src/theme/tokens.css');
    expect(tokens).toMatch(/--text-brand:\s*2\.5rem/);
    const css = read('src/theme/app.css');
    // .brand must consume the token, not restate the number.
    expect(css).toMatch(/\.brand\s*\{[^}]*font-size:\s*var\(--text-brand\)/);
  });

  it('steps the brand down in the 760px rule so it stays readable on a phone', () => {
    const tokens = read('src/theme/tokens.css');
    expect(tokens).toMatch(/--text-brand-narrow:/);
    const css = read('src/theme/app.css');
    const narrow = css.slice(css.indexOf('@media (max-width: 760px)'));
    expect(narrow).toMatch(/\.brand\s*\{[^}]*font-size:\s*var\(--text-brand-narrow\)/);
  });

  it('keeps .identity-name hidden under 830px (pre-existing behavior)', () => {
    const css = read('src/theme/app.css');
    const at830 = css.slice(css.indexOf('@media (max-width: 830px)'));
    expect(at830).toMatch(/\.identity-name\s*\{\s*display:\s*none/);
  });
});
