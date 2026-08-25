// AC5 + AC6 — the repo social-preview images, and the framework wiring whose removal
// would silently blank the rendered half.
//
// AC5 is the second layer of a two-layered guard (lessons 2026-08-23): socialMeta.test.ts
// asserts what the build RENDERED, this asserts the config that makes it render. Deleting
// the Starlight Head override is a one-line edit that reverts 22 pages; without this pin
// the only detector would be a human pasting a docs link into Slack.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readImageSize } from './socialMeta.test';

const WEBSITE = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = join(WEBSITE, '..', '..');
const SOCIAL = join(REPO_ROOT, 'docs', 'assets', 'social');

/** GitHub renders a repo's social preview at 1280×640; anything else is cropped or blurred. */
const GITHUB_PREVIEW = { width: 1280, height: 640 };
const MAX_BYTES = 1024 * 1024;

/** One file per repo that gets a preview uploaded — the "2 uploads". */
const PREVIEWS = ['snug-repo-preview.png', 'spec-repo-preview.png'];

describe('AC6 — repo social-preview images', () => {
  it.each(PREVIEWS)('%s exists', (name) => {
    expect(existsSync(join(SOCIAL, name)), `${name} missing from docs/assets/social/`).toBe(true);
  });

  // Probed from the file's own IHDR bytes, never from the filename or the generator's
  // intent — lessons 2026-08-22: a delivered image's container dimensions are not its
  // content's dimensions, and the only way to know is to look.
  it.each(PREVIEWS)('%s is exactly 1280×640', (name) => {
    const bytes = readFileSync(join(SOCIAL, name));
    expect(readImageSize(bytes)).toEqual(GITHUB_PREVIEW);
  });

  it.each(PREVIEWS)('%s is a real PNG and under 1 MB', (name) => {
    const path = join(SOCIAL, name);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${name} is not a PNG`).toBe(true);
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES);
  });

  // The images are generated, not hand-made binaries with no source. If the generator
  // is gone the images cannot be regenerated or corrected, only replaced by hand.
  it('the generator script that produces them is committed', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts', 'build-social-previews.mjs'))).toBe(true);
  });
});

describe('AC5 — framework wiring', () => {
  const config = readFileSync(join(WEBSITE, 'astro.config.mjs'), 'utf8');

  // Astro.site is what every absolute URL in SocialMeta.astro is built from. Unset it and
  // `new URL(path, Astro.site)` throws at build time, but a value CHANGED to the wrong
  // origin builds green and ships cards pointing at another host.
  it('astro.config.mjs still declares the production site origin', () => {
    expect(config).toMatch(/site:\s*'https:\/\/snugprotocol\.org'/);
  });

  it('the Starlight Head override is still registered', () => {
    // Same components map the SocialIcons override already lives in.
    expect(config).toMatch(/Head:\s*'\.\/src\/components\/Head\.astro'/);
  });

  it('the Head override renders Starlight\'s stock head as well as ours', () => {
    const head = readFileSync(join(WEBSITE, 'src', 'components', 'Head.astro'), 'utf8');
    // Dropping <Default /> would strip Starlight's own og:url/og:site_name/twitter:card
    // and every canonical + theme tag with them — a regression AC3 would catch on docs
    // pages, but this names the cause instead of the symptom.
    expect(head).toMatch(/<Default\b/);
    expect(head).toMatch(/SocialMeta/);
  });

  // The tag set is spelled ONCE and both shells import it (ADR-0048's single-homing
  // doctrine, the same reason site.ts exists). A second hand-rolled copy is how the two
  // shells drift back apart.
  it('both shells route their social meta through the one component', () => {
    const marketing = readFileSync(join(WEBSITE, 'src', 'layouts', 'MarketingLayout.astro'), 'utf8');
    expect(marketing).toMatch(/SocialMeta/);
    expect(marketing, 'MarketingLayout must not hand-roll og: tags beside the component').not.toMatch(
      /<meta\s+property="og:/,
    );
  });
});
