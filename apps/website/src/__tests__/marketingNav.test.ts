// TASK-20260826-website-architecture-page — AC2–AC6: the marketing header's destinations
// survive every viewport, and the nav cannot point at a page that was never built.
//
// Why source AND dist. The header is authored once in MarketingLayout.astro and inherited
// by every marketing page, so its STRUCTURE (which links exist, which element discloses
// them, which breakpoint governs) is a source fact — grepping dist/ for it would assert
// the same string four times and prove nothing extra. Whether those links RESOLVE is a
// dist fact, because only the build knows what pages exist (socialMeta.test.ts makes the
// same split for the same reason).
//
// The bug this file exists to prevent (AC4): before this task the header hid every
// non-CTA link below 560px with NOTHING in its place — Docs, Spec and Playground were
// unreachable on a phone. `hidden destinations have a disclosure home` is written to go
// RED against that layout, so the regression cannot come back quietly.
//
// Turbo runs `build` before `test` (turbo.json: test dependsOn build), so dist/ exists in
// any root run; the dist-dependent tests name that requirement when it does not
// (lessons 2026-08-19: a harness failing before results must say so).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = join(ROOT, 'dist');
const LAYOUT = join(ROOT, 'src', 'layouts', 'MarketingLayout.astro');

const layoutSource = (): string => readFileSync(LAYOUT, 'utf8');

/** The `<header class="nav-wrap">…</header>` block — the header's markup, not the footer's. */
function headerMarkup(source: string): string {
  const start = source.indexOf('<header');
  const end = source.indexOf('</header>');
  expect(start, 'MarketingLayout.astro has no <header>').toBeGreaterThan(-1);
  expect(end, 'MarketingLayout.astro has no </header>').toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The layout's `<style>` block — where the responsive rules live. */
function layoutStyles(source: string): string {
  const start = source.lastIndexOf('<style>');
  expect(start, 'MarketingLayout.astro has no <style> block').toBeGreaterThan(-1);
  return source.slice(start);
}

/**
 * Every href in a markup fragment, in document order.
 * Astro attribute values may be quoted strings (`href="/docs/"`) or expressions
 * (`href={site.playground}`); both are captured so an expression link cannot slip a
 * destination past the desktop/disclosure comparison in AC4.
 */
function hrefs(markup: string): string[] {
  return [...markup.matchAll(/href=(?:"([^"]*)"|\{([^}]*)\})/g)].map((m) => (m[1] ?? m[2]).trim());
}

/** Internal site destinations only — the ones dist/ can be asked about. */
function internalHrefs(list: string[]): string[] {
  return list.filter((h) => h.startsWith('/'));
}

/** `/docs/` → `dist/docs/index.html`; `/` → `dist/index.html`. */
function builtFileFor(href: string): string {
  const clean = href.split('#')[0].split('?')[0].replace(/^\/+|\/+$/g, '');
  return clean === '' ? join(DIST, 'index.html') : join(DIST, clean, 'index.html');
}

describe('marketing header — destinations', () => {
  it('links to the how-it-works page at /architecture/ (AC2)', () => {
    const header = headerMarkup(layoutSource());
    expect(hrefs(header)).toContain('/architecture/');
  });

  it('labels that page "How it works", not the route word (AC2)', () => {
    // The ROUTE is /architecture/ (durable, linkable); the visible LABEL speaks to a
    // general audience. Owner decision 2026-08-26. Pinned separately from the href so a
    // later edit cannot silently collapse one into the other.
    //
    // A visible label is an API for tests, screen readers and docs — never let it become
    // a bare glyph (lessons 2026-08-18).
    const header = headerMarkup(layoutSource());
    expect(header).toMatch(/>\s*How it works\s*</);
  });

  it('every internal header link was actually built into dist (AC3)', () => {
    expect(existsSync(DIST), 'dist/ missing — run `pnpm --filter website build` first').toBe(true);
    const internal = internalHrefs(hrefs(headerMarkup(layoutSource())));
    expect(internal.length, 'header has no internal links — the selector broke').toBeGreaterThan(0);
    const missing = internal.filter((href) => !existsSync(builtFileFor(href)));
    expect(missing, 'header links with no built page').toEqual([]);
  });
});

describe('marketing header — mobile disclosure (the AC4 regression)', () => {
  it('uses a native <details>/<summary> disclosure and no client script (AC5)', () => {
    const source = layoutSource();
    const header = headerMarkup(source);
    expect(header).toMatch(/<details[\s>]/);
    expect(header).toMatch(/<summary[\s>]/);
    // Zero-JS is the point of choosing <details>: no hydration, keyboard and AT support
    // for free. A <script> in this layout would mean the disclosure grew a JS dependency.
    expect(source).not.toMatch(/<script[\s>]/);
  });

  it('the disclosure control has a real accessible name (AC5)', () => {
    // Not a bare ☰ glyph: an icon-only control with no name is unreachable by name for
    // AT and for any future locator (lessons 2026-08-18).
    const header = headerMarkup(layoutSource());
    const summary = header.slice(header.indexOf('<summary'), header.indexOf('</summary>'));
    const hasVisibleText = /<summary[^>]*>[^<]*[A-Za-z]/.test(summary);
    const hasAriaLabel = /aria-label="[^"]*[A-Za-z][^"]*"/.test(summary);
    expect(hasVisibleText || hasAriaLabel, '<summary> needs visible text or an aria-label').toBe(
      true,
    );
  });

  it('the ☰ mark is inline SVG, never an emoji (AC5)', () => {
    // An emoji ignores currentColor and cannot be themed — it would render as a foreign
    // monochrome glyph beside its neighbours (lessons 2026-08-18).
    const header = headerMarkup(layoutSource());
    const summary = header.slice(header.indexOf('<summary'), header.indexOf('</summary>'));
    expect(summary).toMatch(/<svg[\s>]/);
    expect(summary, 'no pictographic emoji in the disclosure control').not.toMatch(
      /\p{Extended_Pictographic}/u,
    );
  });

  it('hidden destinations have a disclosure home — no link is amputated (AC4)', () => {
    // THE REGRESSION TEST. Written to fail against the pre-task layout, where
    // `@media (max-width:560px) { .nav-links > a:not(.nav-cta):not(.nav-gh) { display:none } }`
    // removed Docs/Spec/Playground on phones with no replacement.
    const header = headerMarkup(layoutSource());
    const detailsStart = header.indexOf('<details');
    expect(detailsStart, 'no mobile disclosure in the header').toBeGreaterThan(-1);

    const disclosure = header.slice(detailsStart);
    const desktopRow = header.slice(0, detailsStart);

    const brandHrefs = new Set(['/']);
    const desktop = new Set(hrefs(desktopRow).filter((h) => !brandHrefs.has(h)));
    const inDisclosure = new Set(hrefs(disclosure));

    expect(desktop.size, 'desktop nav row has no links — selector broke').toBeGreaterThan(0);
    const unreachable = [...desktop].filter((href) => !inDisclosure.has(href));
    expect(unreachable, 'destinations reachable on desktop but not inside the mobile menu').toEqual(
      [],
    );
  });
});

describe('marketing header — the breakpoint pair (AC6)', () => {
  // lessons 2026-08-23: the band BETWEEN breakpoints is a device class nobody's suite
  // lives in, and a width-keyed behaviour needs a check in EACH band. These assert the
  // rule PAIR is complementary, which covers every width including the ones between.
  const BREAKPOINT_RE = /--nav-breakpoint:\s*(\d+)px/;

  it('states the breakpoint exactly once, as a custom property', () => {
    const styles = layoutStyles(layoutSource());
    const matches = [...styles.matchAll(/--nav-breakpoint:\s*\d+px/g)];
    expect(matches.length, 'the breakpoint must be single-homed').toBe(1);
  });

  it('the desktop row and the disclosure are governed by complementary rules', () => {
    // Complementary = one `min-width: Npx` and one `max-width: (N - 0.02)px` over the same
    // N, so no width shows both navs and none shows neither. The 0.02px step is the
    // standard non-overlapping media pair (a `max-width:N` + `min-width:N` pair BOTH match
    // at exactly N).
    const styles = layoutStyles(layoutSource());
    const bp = styles.match(BREAKPOINT_RE);
    expect(bp, 'no --nav-breakpoint declared').not.toBeNull();
    const n = Number(bp![1]);

    const mins = [...styles.matchAll(/@media\s*\(min-width:\s*([\d.]+)px\)/g)].map((m) =>
      Number(m[1]),
    );
    const maxes = [...styles.matchAll(/@media\s*\(max-width:\s*([\d.]+)px\)/g)].map((m) =>
      Number(m[1]),
    );

    expect(mins, `no @media (min-width: ${n}px) governing the desktop row`).toContain(n);
    expect(maxes, `no @media (max-width: ${n - 0.02}px) governing the disclosure`).toContain(
      n - 0.02,
    );
  });

  it.each([375, 768, 850, 1280])('width %ipx resolves to exactly one nav', (width) => {
    // 375 = phone · 768 = iPad portrait · 850 = phone in landscape · 1280 = desktop.
    // 768 and 850 are the "between" band that the old 560px breakpoint served wrongly.
    const styles = layoutStyles(layoutSource());
    const n = Number(styles.match(BREAKPOINT_RE)![1]);
    const desktopShown = width >= n;
    const disclosureShown = width <= n - 0.02;
    expect(
      desktopShown !== disclosureShown,
      `at ${width}px: desktop=${desktopShown} disclosure=${disclosureShown} — must be exactly one`,
    ).toBe(true);
  });

  it('the breakpoint clears an iPad portrait (768px) and a phone in landscape (~850px)', () => {
    // The old 560px value put both device classes on the desktop row, where six items plus
    // the wordmark do not fit. Pinning the intent, not just the arithmetic.
    const styles = layoutStyles(layoutSource());
    const n = Number(styles.match(BREAKPOINT_RE)![1]);
    expect(n).toBeGreaterThan(850);
  });
});
