// TASK-20260826-website-architecture-page — AC7–AC9: the how-it-works page uses the site's
// own design system, keeps its honest half, and is reachable from the landing page.
//
// (AC11 — "drop the unused `cookie` dependency" — was WITHDRAWN at Gate 6, not implemented:
// next-steps 2026-08-24 records an owner decision to keep it. Astro 7 imports `parseCookie`
// from `cookie@2`, and the explicit declaration is a shim against a hoisted stray shadowing
// it on another machine or a CI runner — not a claim that this package imports it.)
//
// Source-asserted by design. These are authoring facts (which tokens a stylesheet uses,
// whether a section still exists, what a component links to) — reading dist/ would assert
// the same authored strings after a template pass and prove nothing extra. The one claim
// about RENDERED output that matters here (the page ships at all) is AC1, and it lives in
// buildOutput.test.ts with the rest of the shipped-surface list.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PAGE = join(ROOT, 'src', 'pages', 'architecture.astro');
const FIGURES = join(ROOT, 'src', 'components', 'ArchitectureFigures.astro');
const LAYOUT = join(ROOT, 'src', 'layouts', 'MarketingLayout.astro');
const DIFFERENTIATORS = join(ROOT, 'src', 'components', 'Differentiators.astro');

const read = (path: string): string => readFileSync(path, 'utf8');

/** The files this task authors — the surface AC7's design-system rules govern. */
const AUTHORED = [PAGE, FIGURES, LAYOUT];

describe('how-it-works page — the design system, not a second one (AC7)', () => {
  it.each(AUTHORED)('%s hard-codes no hex colour', (file) => {
    // Every colour must resolve through tokens.css custom properties, so the page follows
    // the brand (and the light theme the tokens carry) instead of pinning its own palette.
    // The drafted artifact this page derives from was light-first cream with its own hexes;
    // this is the check that the restyle actually happened.
    const source = read(file);
    const hexes = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    // SVG path data and ids never carry a #rrggbb; a fragment-internal url(#id) reference
    // is `#id`, which the \b-anchored 3–8 hex-digit pattern does not match unless the id is
    // itself hex-shaped — so anything caught here is a real colour literal.
    expect(hexes, `hard-coded colours in ${file} — use tokens.css custom properties`).toEqual([]);
  });

  it.each(AUTHORED)('%s requests nothing from a third-party host', (file) => {
    // The site's zero-third-party-request property is what makes the privacy page's
    // "no analytics script" claim verifiable in the built output — the built dist/ today
    // reaches only snugprotocol.org, github.com, json-schema.org and the playground
    // subdomain. A font/CDN <link> on this page would quietly end that.
    const source = read(file);
    const offenders = [
      /fonts\.googleapis\.com/,
      /fonts\.gstatic\.com/,
      /cdn\.jsdelivr\.net/,
      /unpkg\.com/,
      /cdnjs\.cloudflare\.com/,
      /<link[^>]+href="https?:\/\//,
      /<script[^>]+src="https?:\/\//,
    ].filter((re) => re.test(source));
    expect(offenders.map(String), `third-party asset reference in ${file}`).toEqual([]);
  });

  it('the figures are inline SVG with an accessible name', () => {
    // artifact-diagramming: one figure, one claim — role="img" plus an aria-label carrying
    // the same claim as the visible caption, for readers who cannot see the drawing.
    const source = read(FIGURES);
    const svgs = [...source.matchAll(/<svg[^>]*>/g)].map((m) => m[0]);
    expect(svgs.length, 'no inline SVG figures found').toBeGreaterThanOrEqual(6);

    const decorative = svgs.filter((tag) => /aria-hidden="true"/.test(tag));
    const meaningful = svgs.filter((tag) => !/aria-hidden="true"/.test(tag));
    expect(meaningful.length, 'every figure is marked decorative').toBeGreaterThanOrEqual(6);
    for (const tag of meaningful) {
      expect(tag, 'a meaningful figure needs role="img"').toMatch(/role="img"/);
      expect(tag, 'a meaningful figure needs an aria-label').toMatch(/aria-label="[^"]{20,}"/);
    }
    expect(decorative.length).toBeGreaterThanOrEqual(0);
  });

  it('every figure is sized by viewBox so it scales instead of overflowing', () => {
    const svgs = [...read(FIGURES).matchAll(/<svg[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/aria-hidden="true"/.test(tag));
    for (const tag of svgs) {
      expect(tag, 'figure needs a viewBox').toMatch(/viewBox="0 0 \d+ \d+"/);
    }
  });

  it('wide figures scroll inside their own container, never the page body', () => {
    // A diagram wider than a phone must not make the whole document scroll sideways —
    // "no horizontal scroll at 375px" is a standing tripwire (lessons 2026-08-23).
    const source = `${read(PAGE)}\n${read(FIGURES)}`;
    expect(source).toMatch(/overflow-x:\s*auto/);
  });
});

describe('how-it-works page — the honest half stays (AC8)', () => {
  // The page's credibility with a skeptical public audience rests on naming what Snug
  // does NOT do. Each residual below is already public in docs/threat-model.md §6 (or is
  // the plainly-stated model-sees-data fact). Pinned so a later copy edit cannot quietly
  // delete the uncomfortable half while leaving the claims.
  const RESIDUALS: ReadonlyArray<readonly [string, RegExp]> = [
    ['the model does see app data', /\bmodel\b[^.]{0,80}\bsee\b|\bsee\b[^.]{0,80}\byour (?:app'?s? )?data\b/i],
    ['Windows / WebView2 sandbox break', /windows/i],
    ['unrecoverable if both secrets are lost', /recovery key|lose (?:the |your )?passphrase|unrecoverab/i],
    ['hosted credential custody is unbuilt', /broker/i],
    ['implementation packages are pre-1\\.0', /pre-1\.0|still moving|may break between releases/i],
  ];

  it.each(RESIDUALS)('names: %s', (_label, pattern) => {
    expect(read(PAGE)).toMatch(pattern);
  });

  it('has a dedicated limits section, not one buried sentence', () => {
    const source = read(PAGE);
    expect(source).toMatch(/What this doesn'?t do|What it doesn'?t do/i);
  });

  it('claims no intermediary that ACCUMULATES — not "no intermediary" (AC8)', () => {
    // The single most likely public objection: SimpleFIN is itself an aggregator/bridge
    // (examples/ledger/connection.json pins beta-bridge.simplefin.org). The page concedes
    // that before it is raised; this pins the concession so it cannot be edited into an
    // overclaim later.
    const source = read(`${FIGURES}`) + read(PAGE);
    expect(source).toMatch(/accumulat/i);
  });
});

describe('rendered prose — no lost spaces at inline-tag boundaries', () => {
  // Astro trims the newline between running text and an inline tag on the next line, so
  // `…the app itself has\n<em>no network</em>` renders as "hasno network". Three of these
  // shipped into the first build of this page and were invisible in source review — only
  // the RENDERED text shows them (lessons 2026-08-23: a claim about rendered output cannot
  // be proven by grepping source).
  //
  // Scoped to text-level inline tags: <a> and <span> are excluded because adjacent nav and
  // footer links are separate flex items whose lack of whitespace is correct.
  const INLINE = '(?:b|i|em|strong|code|small|abbr)';

  const MARKETING_PAGES = [
    'index.html',
    join('architecture', 'index.html'),
    join('download', 'index.html'),
    join('privacy', 'index.html'),
    join('terms', 'index.html'),
  ];

  it.each(MARKETING_PAGES)('%s has no word-tag-word joins in running text', (page) => {
    const file = join(ROOT, 'dist', page);
    expect(existsSync(file), `${page} missing — run \`pnpm --filter website build\``).toBe(true);

    const body = readFileSync(file, 'utf8').replace(
      /<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/g,
      '',
    );
    const joins = [...body.matchAll(new RegExp(`\\w(?:</?${INLINE}(?:\\s[^>]*)?>)+\\w`, 'g'))].map(
      (m) => body.slice(Math.max(0, m.index - 50), m.index + m[0].length + 25).replace(/<[^>]+>/g, ''),
    );
    expect(joins, `lost space(s) at an inline-tag boundary in ${page}`).toEqual([]);
  });
});

describe('how-it-works page — reachable from the landing page (AC9)', () => {
  it('Differentiators links onward to /architecture/', () => {
    expect(read(DIFFERENTIATORS)).toMatch(/href="\/architecture\/"/);
  });
});
