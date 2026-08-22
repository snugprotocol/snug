// AC2 — the landing page picks the teaser rendition from the viewport: the portrait
// cut for portrait screens (phones), the landscape cut for everything else, landscape
// as the default when the viewport is unknown or degenerate (0×0, square).
import { describe, expect, it } from 'vitest';
import { pickTeaserSource, TEASER_RENDITIONS } from '../lib/teaser';

describe('pickTeaserSource', () => {
  it('picks portrait for a portrait viewport (phone)', () => {
    expect(pickTeaserSource(390, 844)).toBe('portrait');
  });

  it('picks landscape for a landscape viewport (desktop)', () => {
    expect(pickTeaserSource(1440, 900)).toBe('landscape');
  });

  it('picks landscape for a square viewport (tie breaks to landscape)', () => {
    expect(pickTeaserSource(800, 800)).toBe('landscape');
  });

  it('defaults to landscape for a degenerate viewport', () => {
    expect(pickTeaserSource(0, 0)).toBe('landscape');
    expect(pickTeaserSource(-1, -1)).toBe('landscape');
  });

  it('both renditions name real files under /videos with posters', () => {
    for (const rendition of Object.values(TEASER_RENDITIONS)) {
      expect(rendition.src).toMatch(/^\/videos\/teaser-(landscape|portrait)\.mp4$/);
      expect(rendition.poster).toMatch(/^\/videos\/poster-(landscape|portrait)\.jpg$/);
    }
  });
});
