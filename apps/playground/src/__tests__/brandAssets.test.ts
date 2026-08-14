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
  it('sizes the wordmark via a token rather than a hardcoded value', () => {
    // The exact size was 2.5rem here and is now 2rem (AC3 of the observability-caching
    // task reduced it 20%). The value lives in starterCardBrand.test.tsx, which owns
    // that decision; the durable assertion HERE is that a token is what carries it.
    const tokens = read('src/theme/tokens.css');
    expect(tokens).toMatch(/--text-brand:\s*[0-9.]+rem/);
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

// TASK-20260813 AC1/AC2 — the wordmark's descender.
//
// The bug: `.brand` set `line-height: 1`, which makes the line box exactly the em box,
// so the tail of the "g" in "snug." falls OUTSIDE it — and `.brand-word`'s
// `overflow: hidden` (present for the ellipsis) turned that overflow into a visible
// cut. `--font-display` is a serif with a deep descender, so it is unmissable.
//
// Asserted in CSS rather than by measuring a rendered glyph: jsdom has no layout engine
// and no font metrics, so `getBoundingClientRect()` returns zeros and could never see
// this. These two rules ARE the defect, so they are what the guard must pin.
describe('brand wordmark descender (TASK-20260813 AC1/AC2)', () => {
  const brandRule = (css: string): string => {
    // The base `.brand` rule — anchored at line start so `.brand .brand-word` and the
    // `@media` override cannot be mistaken for it.
    const match = css.match(/^\.brand\s*\{([^}]*)\}/m);
    if (match === null) throw new Error('no .brand rule found in app.css');
    return match[1];
  };

  const brandWordRule = (css: string): string => {
    const match = css.match(/\.brand\s+\.brand-word\s*\{([^}]*)\}/);
    if (match === null) throw new Error('no .brand .brand-word rule found in app.css');
    return match[1];
  };

  it('AC1 — .brand does not pin line-height to 1, which clips the descender', () => {
    const rule = brandRule(read('src/theme/app.css'));
    // `line-height: 1` is the defect exactly. A larger value (or none) leaves the line
    // box room for the tail. Unitless 1.0/100%/1em are the same bug spelled differently.
    expect(rule).not.toMatch(/line-height:\s*(1(\.0+)?|100%|1em|1rem)\s*[;}]/);
  });

  it('AC1 — the lockup leaves descender room below the wordmark baseline', () => {
    const css = read('src/theme/app.css');
    const rule = brandRule(css);
    const word = brandWordRule(css);
    // Either the line box itself is generous (line-height >= 1.2 on .brand), or the
    // wordmark carries explicit padding-bottom to hold the tail inside its clip box.
    // One of the two MUST be true or the "g" is cut again.
    const lineHeight = rule.match(/line-height:\s*([0-9.]+)\s*[;}]/);
    const generousLineBox = lineHeight !== null && Number(lineHeight[1]) >= 1.2;
    const paddedWord = /padding-bottom:\s*[^;}]+/.test(word);
    expect(
      generousLineBox || paddedWord,
      '.brand needs line-height >= 1.2 or .brand-word needs padding-bottom for the "g" tail',
    ).toBe(true);
  });

  it('AC2 — the wordmark still ellipsizes rather than overflowing the header', () => {
    // The overflow:hidden that caused the clip was there for a REASON — a narrow header
    // must truncate the brand, not spill it. The fix must not trade one bug for another.
    const word = brandWordRule(read('src/theme/app.css'));
    expect(word).toMatch(/text-overflow:\s*ellipsis/);
    expect(word).toMatch(/white-space:\s*nowrap/);
    expect(word).toMatch(/overflow:\s*hidden/);
  });
});
