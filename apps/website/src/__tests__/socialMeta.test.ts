// AC1–AC4 — every built page hands a scraper a usable social card.
//
// Asserted over dist/, never over source. Two lessons force this seam: a claim about
// rendered output cannot be proven by grepping source (2026-08-23), and the two shells
// here emit DIFFERENT markup for the same tag — Astro pages write `<meta ...>`, Starlight
// writes `<meta .../>` — so a source-shaped matcher would silently half-pass.
//
// Turbo runs `build` before `test` (turbo.json: test dependsOn build), so dist/ exists in
// any root run. A bare `vitest` without a build gets a NAMED failure, not a mystery
// (lessons 2026-08-19), which is what the first test in this file is for.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const ORIGIN = 'https://snugprotocol.org';

/** The pages built from MarketingLayout.astro (src/pages/*.astro). */
const MARKETING = [
  'index.html',
  join('architecture', 'index.html'),
  join('download', 'index.html'),
  join('privacy', 'index.html'),
  join('terms', 'index.html'),
];

function walkHtml(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkHtml(path, out);
    else if (name.endsWith('.html')) out.push(path);
  }
  return out;
}

/** dist-relative page paths, sep-normalised so the names read the same on any platform. */
function builtPages(): string[] {
  return walkHtml(DIST).map((p) => relative(DIST, p).split(sep).join('/'));
}

/**
 * Read one meta tag's content. Handles BOTH shells' markup (`>` and `/>`) and either
 * attribute order, and is deliberately attribute-name-aware: og:* is carried on
 * `property=`, twitter:* on `name=`, and a scraper reading the wrong one finds nothing.
 */
function meta(html: string, key: string): string | undefined {
  const attr = key.startsWith('twitter:') ? 'name' : 'property';
  const pattern = new RegExp(
    `<meta[^>]*${attr}="${key.replace(':', ':')}"[^>]*content="([^"]*)"[^>]*/?>|` +
      `<meta[^>]*content="([^"]*)"[^>]*${attr}="${key}"[^>]*/?>`,
  );
  const m = html.match(pattern);
  return m ? (m[1] ?? m[2]) : undefined;
}

function read(page: string): string {
  return readFileSync(join(DIST, page), 'utf8');
}

describe('social meta', () => {
  it('dist/ exists (run `pnpm --filter website build` first — turbo does this for you)', () => {
    expect(existsSync(DIST)).toBe(true);
  });

  it('every marketing page this suite pins was actually built', () => {
    for (const page of MARKETING) expect(existsSync(join(DIST, page)), page).toBe(true);
  });

  // AC1 — the bug this task exists for. A root-relative og:image is DROPPED by every
  // real scraper (X, Slack, LinkedIn, Facebook, iMessage), not resolved against the page
  // URL, so the card renders imageless. Absolute-or-nothing.
  describe('AC1 — og:image is an absolute URL on every page', () => {
    it.each(builtPages())('%s', (page) => {
      const value = meta(read(page), 'og:image');
      expect(value, `${page} has no og:image at all`).toBeTruthy();
      // new URL() on a relative value throws — assert the parse explicitly so the
      // failure names the real defect rather than surfacing as a TypeError.
      expect(() => new URL(value as string), `${page}: og:image "${value}" is not absolute`).not.toThrow();
      const url = new URL(value as string);
      expect(url.protocol, `${page}: og:image must be https`).toBe('https:');
      expect(url.origin, `${page}: og:image must live on the site's own origin`).toBe(ORIGIN);
    });
  });

  // AC2 — a correct-looking absolute URL pointing at a 404 is the same broken card.
  describe('AC2 — the og:image URL resolves to a file that actually ships', () => {
    it.each(builtPages())('%s', (page) => {
      const value = meta(read(page), 'og:image');
      expect(value, `${page} has no og:image at all`).toBeTruthy();
      const { pathname } = new URL(value as string);
      const asset = join(DIST, pathname.split('/').join(sep));
      expect(existsSync(asset), `${page}: og:image points at ${pathname}, absent from dist/`).toBe(true);
      expect(statSync(asset).size, `${page}: og:image asset is empty`).toBeGreaterThan(0);
    });
  });

  // AC3 — the rest of the card. Without twitter:card X renders the small summary card
  // even once og:image resolves; without dimensions a scraper may defer or crop.
  describe('AC3 — the full card is declared on every page', () => {
    it.each(builtPages())('%s carries twitter:card=summary_large_image', (page) => {
      expect(meta(read(page), 'twitter:card')).toBe('summary_large_image');
    });

    it.each(builtPages())('%s carries an absolute og:url matching its own route', (page) => {
      const value = meta(read(page), 'og:url');
      expect(value, `${page} has no og:url`).toBeTruthy();
      const url = new URL(value as string);
      expect(url.origin).toBe(ORIGIN);
      // index.html → /, docs/spec/index.html → /docs/spec/ — the page's own route.
      const route = '/' + page.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '');
      expect(url.pathname.replace(/\/$/, ''), `${page}: og:url points elsewhere`).toBe(
        route.replace(/\/$/, ''),
      );
    });

    it.each(builtPages())('%s carries og:site_name', (page) => {
      expect(meta(read(page), 'og:site_name')).toBeTruthy();
    });

    it.each(builtPages())('%s declares the image dimensions', (page) => {
      const width = meta(read(page), 'og:image:width');
      const height = meta(read(page), 'og:image:height');
      expect(width, `${page} has no og:image:width`).toMatch(/^\d+$/);
      expect(height, `${page} has no og:image:height`).toMatch(/^\d+$/);
      expect(Number(width)).toBeGreaterThan(0);
      expect(Number(height)).toBeGreaterThan(0);
    });

    it.each(builtPages())('%s labels the image for screen readers', (page) => {
      expect((meta(read(page), 'og:image:alt') ?? '').trim().length).toBeGreaterThan(0);
    });
  });

  // AC4 — the Starlight half. These pages already claim summary_large_image and carry
  // og:url/og:site_name out of the box; og:image is the ONE tag Starlight never emits,
  // which is why the docs and the whole rendered spec preview bare today.
  describe('AC4 — the docs shell', () => {
    const docs = builtPages().filter((p) => p.startsWith('docs/') || p === '404.html');

    it('there are docs pages to check (guards against an empty-glob pass)', () => {
      expect(docs.length).toBeGreaterThan(10);
    });

    it.each(docs)('%s carries the same absolute og:image as the marketing shell', (page) => {
      const marketing = meta(read('index.html'), 'og:image');
      expect(meta(read(page), 'og:image')).toBe(marketing);
    });
  });

  // The declared dimensions must be the image's REAL ones, or a scraper that trusts them
  // lays out the wrong box (lessons 2026-08-22: a delivered image's container dimensions
  // are not its content's dimensions).
  it('the declared og:image dimensions match the shipped file', () => {
    const value = meta(read('index.html'), 'og:image') as string;
    const { pathname } = new URL(value);
    const bytes = readFileSync(join(DIST, pathname.split('/').join(sep)));
    const declared = {
      width: Number(meta(read('index.html'), 'og:image:width')),
      height: Number(meta(read('index.html'), 'og:image:height')),
    };
    expect(readImageSize(bytes), 'declared og:image:width/height must be the file\'s real pixels').toEqual(
      declared,
    );
  });
});

/** Pixel dimensions from the file's own bytes — PNG IHDR or JPEG SOF marker. */
export function readImageSize(bytes: Buffer): { width: number; height: number } {
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (isPng) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length - 9) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0–SOF15, excluding the non-frame markers DHT (c4), JPG (c8) and DAC (cc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  throw new Error('unrecognised image format — expected PNG or JPEG');
}
