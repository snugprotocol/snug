// AC1 + AC2 (sizes) — the static build contains every promised surface, and each
// video rendition stays under the 20 MB budget (Cloudflare Pages refuses files over
// 25 MB; the margin is deliberate).
//
// Turbo runs `build` before `test` (turbo.json: test dependsOn build), so dist/ exists
// in any root run. A bare `vitest` without a build gets a NAMED failure, not a
// mystery (lessons 2026-08-19: a harness failing before results must say so).
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

describe('build output', () => {
  it('dist/ exists (run `pnpm --filter website build` first — turbo does this for you)', () => {
    expect(existsSync(DIST)).toBe(true);
  });

  it.each([
    'index.html',
    join('download', 'index.html'),
    join('docs', 'index.html'),
    join('docs', 'spec', 'index.html'),
    join('docs', 'whitepaper', 'index.html'),
    join('whitepaper', 'snug-protocol-whitepaper.pdf'),
    'favicon.svg',
  ])('ships %s', (path) => {
    expect(existsSync(join(DIST, path))).toBe(true);
  });

  it.each([
    join('videos', 'teaser-landscape.mp4'),
    join('videos', 'teaser-portrait.mp4'),
  ])('%s exists and is ≤ 20 MB', (path) => {
    const full = join(DIST, path);
    expect(existsSync(full)).toBe(true);
    expect(statSync(full).size).toBeLessThanOrEqual(MAX_VIDEO_BYTES);
  });

  it.each([join('videos', 'poster-landscape.jpg'), join('videos', 'poster-portrait.jpg')])(
    'ships poster %s',
    (path) => {
      expect(existsSync(join(DIST, path))).toBe(true);
    },
  );
});
