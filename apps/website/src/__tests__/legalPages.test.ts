// legalPages.test.ts — TASK-20260823-legal-terms-privacy-eula AC12 (ADR-0055 §4).
//
// /terms/ and /privacy/ are rendered from the PLAYGROUND's content modules through the
// @playground alias — one source, two renderers. Two things can silently break that:
// the alias path not resolving at build time (a page that builds empty), or the
// footer losing its Legal column. So this pins the built HTML, not the source: the
// pages exist in dist/, they carry sentences only the shared modules can supply (the
// counterparty definition, the byte-pinned R-30 sentence — lesson 2026-08-08: mutation-
// check the wiring, not just the logic), and every marketing page's footer links them.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { UPDATE_CHECK_DISCLOSURE } from '@playground/legal/legalShared';
import { THIRD_PARTIES } from '@playground/legal/privacy';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const unescape = (html: string): string =>
  html.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

function page(rel: string): string {
  const path = join(DIST, rel, 'index.html');
  expect(existsSync(path), `${rel}/index.html must be built (pnpm --filter website build)`).toBe(true);
  return unescape(readFileSync(path, 'utf8'));
}

describe('legal pages (built output)', () => {
  it('/terms/ renders the shared terms — the alias really resolved', () => {
    const html = page('terms');
    expect(html).toContain('<h1');
    expect(html).toContain('Terms of use');
    expect(html).toContain('mean Jeetu Maker and TechVoyage LLC together');
    expect(html).toContain('PROVIDED "AS IS"');
    expect(html).toContain('That is the whole of it.');
  });

  it('/privacy/ renders the shared statement with the third-party table, one row per party', () => {
    const html = page('privacy');
    expect(html).toContain('Privacy');
    expect(html).toContain(UPDATE_CHECK_DISCLOSURE);
    // Astro stamps its scoped-style class on every element, so match tags, not literals.
    const rows = html.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/)?.[0].match(/<tr\b/g) ?? [];
    expect(rows.length).toBe(THIRD_PARTIES.length);
  });

  it('in-app paths became site routes; external links open in a new tab', () => {
    const html = page('terms');
    expect(html).toMatch(/href="\/privacy\/"/);
    expect(html).toMatch(/href="https:\/\/github\.com\/snugprotocol\/snug\/blob\/main\/docs\/threat-model\.md"[^>]*target="_blank"/);
  });

  it.each(['', 'download', 'terms', 'privacy'])('the footer on /%s carries the Legal column', (rel) => {
    const html = page(rel);
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(footer).toContain('aria-label="Legal"');
    expect(footer).toContain('href="/terms/"');
    expect(footer).toContain('href="/privacy/"');
    expect(footer).toMatch(/threat-model\.md"[^>]*target="_blank"/);
    expect(footer).toMatch(/SECURITY\.md"[^>]*target="_blank"/);
  });
});
