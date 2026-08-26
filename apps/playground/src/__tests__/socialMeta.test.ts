// The playground hands a scraper a usable social card.
//
// playground.snugprotocol.org is a shareable URL and had NO social meta at all until
// TASK-20260825-flip-public-execute — a link to it unfurled bare.
//
// Asserted over dist/index.html, never over source, for the reason the website's
// socialMeta.test.ts records: a claim about rendered output cannot be proven by grepping
// source. Vite rewrites asset URLs and can transform head content during build, so the
// shipped bytes are the only honest subject. turbo.json makes `test` dependsOn `build`,
// so dist/ exists in any root run; the first test below turns a bare `vitest` with no
// prior build into a NAMED failure rather than a mystery (lessons 2026-08-19).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolved from cwd (the package root under vitest), matching this suite's convention —
// see hueStarterManifest.test.ts. `import.meta.url` is NOT a file: URL under the
// playground's vitest environment, so fileURLToPath throws at import time.
const DIST_INDEX = path.resolve(process.cwd(), 'dist', 'index.html');

/** The marketing origin that serves the shared card image. */
const IMAGE_ORIGIN = 'https://snugprotocol.org';

/**
 * Read one meta tag's content from raw HTML.
 *
 * Deliberately attribute-name-aware: og:* is carried on `property=`, twitter:* on
 * `name=`, and a scraper reading the wrong one finds nothing. Tolerates either
 * attribute order and both `>` and `/>` endings so a formatter change cannot
 * silently turn a real assertion into a vacuous one.
 */
function meta(html: string, key: string): string | undefined {
  const attr = key.startsWith('og:') ? 'property' : 'name';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\s+${attr}=["']${escaped}["']\\s+content=["']([^"']*)["']\\s*/?>`, 'i'),
    new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+${attr}=["']${escaped}["']\\s*/?>`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return undefined;
}

function readDist(): string {
  return readFileSync(DIST_INDEX, 'utf8');
}

describe('playground social card', () => {
  it('has a built dist/index.html to assert over', () => {
    expect(
      existsSync(DIST_INDEX),
      `dist/index.html missing — run \`pnpm --filter playground build\` first (turbo does this automatically via test dependsOn build)`,
    ).toBe(true);
  });

  it('declares the core Open Graph set', () => {
    const html = readDist();
    expect(meta(html, 'og:title')).toBeTruthy();
    expect(meta(html, 'og:description')).toBeTruthy();
    expect(meta(html, 'og:type')).toBe('website');
    expect(meta(html, 'og:site_name')).toBe('Snug Protocol');
  });

  // The bug this whole file exists to prevent. A root-relative og:image is not resolved
  // by scrapers — it is DROPPED, so the card renders imageless while every other check
  // still passes. This shipped to production on the marketing site (TASK-20260825).
  it('serves og:image and twitter:image as ABSOLUTE https URLs', () => {
    const html = readDist();
    for (const key of ['og:image', 'twitter:image']) {
      const value = meta(html, key);
      expect(value, `${key} is missing`).toBeTruthy();
      expect(value, `${key} must be absolute, not root-relative`).toMatch(/^https:\/\//);
      expect(() => new URL(value as string)).not.toThrow();
    }
  });

  it('points og:url at the playground origin, absolute', () => {
    const url = meta(readDist(), 'og:url');
    expect(url).toBeTruthy();
    expect(url).toMatch(/^https:\/\/playground\.snugprotocol\.org\//);
  });

  // Cross-origin is intentional: the card image is the landing teaser's poster frame,
  // already shipped by the marketing site. Copying it here would fork one asset into two.
  it('reuses the marketing origin for the card image rather than forking the asset', () => {
    const image = meta(readDist(), 'og:image') as string;
    expect(image.startsWith(`${IMAGE_ORIGIN}/`)).toBe(true);
  });

  // Declared dimensions are a claim about the file's bytes that a scraper trusts when
  // allocating the card's box. These mirror the website's socialImage.ts, where
  // socialMeta.test.ts probes the real JPEG SOF marker — this test cannot re-probe a
  // file it does not ship, so it pins the pair to that single source of truth.
  it('declares image dimensions matching the website source of truth', () => {
    const html = readDist();
    expect(meta(html, 'og:image:width')).toBe('1920');
    expect(meta(html, 'og:image:height')).toBe('1080');
    expect(meta(html, 'og:image:alt')).toBeTruthy();
  });

  it('asks for a large summary card', () => {
    expect(meta(readDist(), 'twitter:card')).toBe('summary_large_image');
  });
});
