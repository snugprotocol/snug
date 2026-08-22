// AC3 + AC11 + AC12 — every cross-surface URL is single-homed in src/config/site.ts.
//
// The download URLs must be IDENTITY-equal to the playground's releaseChannel.ts
// exports (one contract, one home — ADR-0047 §2, lessons 2026-08-13: assert the seam's
// identity from the integrating side). The grep half asserts no second spelling of any
// release URL exists anywhere in the website source.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_DOWNLOAD_URL,
  DESKTOP_RELEASES_PAGE_URL,
} from '@playground/desktop/releaseChannel';
import { currentMode, resolveSiteLinks } from '../config/site';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|mts|astro|mdx?|css|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

describe('site config — production links', () => {
  const links = resolveSiteLinks('production');

  it('download URLs are the releaseChannel exports, not a restatement', () => {
    expect(links.download.dmg).toBe(DESKTOP_DOWNLOAD_URL);
    expect(links.download.releasesPage).toBe(DESKTOP_RELEASES_PAGE_URL);
  });

  it('playground lives on its subdomain', () => {
    expect(links.playground).toBe('https://playground.snugprotocol.org');
  });

  it('GitHub links point at the org (both repos visible) and the two repos', () => {
    expect(links.githubOrg).toBe('https://github.com/snugprotocol');
    expect(links.githubRepo).toBe('https://github.com/snugprotocol/snug');
    expect(links.specRepo).toBe('https://github.com/snugprotocol/spec');
  });
});

describe('site config — local E2E mode (AC12)', () => {
  const links = resolveSiteLinks('local');

  it('playground points at the local dev server', () => {
    expect(links.playground).toBe('http://localhost:5173');
  });

  it('download points at the locally staged DMG', () => {
    expect(links.download.dmg).toBe('/local-artifacts/Snug.dmg');
  });

  it('mode resolution: local only on the explicit flag, production otherwise', () => {
    expect(currentMode({ PUBLIC_SITE_MODE: 'local' })).toBe('local');
    expect(currentMode({ PUBLIC_SITE_MODE: 'production' })).toBe('production');
    expect(currentMode({ PUBLIC_SITE_MODE: 'anything-else' })).toBe('production');
    expect(currentMode({})).toBe('production');
  });
});

describe('single-homing — no second spelling of shared URLs in website source', () => {
  // site.ts re-exports the releaseChannel values; every OTHER file must go through it.
  const files = walk(SRC_ROOT).filter((f) => !f.includes('__tests__'));

  it('the GitHub releases URL appears nowhere in website source', () => {
    const offenders = files.filter((f) =>
      readFileSync(f, 'utf8').includes('github.com/snugprotocol/snug/releases'),
    );
    expect(offenders).toEqual([]);
  });

  it('the playground URL is spelled only in site.ts', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith(`config${'/'}site.ts`) &&
        readFileSync(f, 'utf8').includes('playground.snugprotocol.org'),
    );
    expect(offenders).toEqual([]);
  });
});
