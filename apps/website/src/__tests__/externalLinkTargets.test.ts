// Every EXTERNAL anchor in the site's .astro surfaces opens in a new tab (owner
// report, 2026-08-23: the header GitHub icon and footer repo links navigated the
// visitor away from the site same-tab). External = an href literal to another
// origin or any `{site.*}` config value (all of which are cross-origin by
// construction — same-site routes are root-relative strings). Markdown/MDX
// content autolinks are out of scope: remark controls their rendering, and the
// one such link (the whitepaper citation) is a same-origin asset.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.astro')) out.push(path);
  }
  return out;
}

describe('external anchors in .astro surfaces', () => {
  it('every external <a> carries target="_blank"', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<a\b[^>]*>/gs)) {
        const tag = match[0];
        const external = /href=\{site\./.test(tag) || /href="https?:\/\//.test(tag);
        if (!external) continue;
        if (!tag.includes('target="_blank"')) {
          offenders.push(`${file.slice(SRC_ROOT.length)}: ${tag.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    expect(offenders, `external links must open in a new tab:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the two Starlight-layer halves stay wired (they render anchors this scan cannot see)', () => {
    // Markdown/MDX content links: rehype-external-links adds the target at render
    // time; the docs-header GitHub icon: the SocialIcons override carries it.
    // Deleting either wiring silently reverts ~40 built anchors to same-tab.
    const config = readFileSync(join(SRC_ROOT, '..', 'astro.config.mjs'), 'utf8');
    expect(config).toContain("rehypeExternalLinks, { target: '_blank'");
    expect(config).toContain("SocialIcons: './src/components/HeaderSocialIcons.astro'");
    const override = readFileSync(join(SRC_ROOT, 'components', 'HeaderSocialIcons.astro'), 'utf8');
    expect(override).toContain('target="_blank"');
  });
});
