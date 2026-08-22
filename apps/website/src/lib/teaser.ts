// teaser.ts — which teaser rendition a viewport gets (AC2).
//
// Two cuts of the same 48-second teaser exist: a 1920×1080 landscape master and a
// 1080×1920 portrait master. The page ships BOTH <source> candidates and this pure
// function makes the pick, so the choice is unit-testable without a browser.

export type TeaserRendition = 'landscape' | 'portrait';

export interface TeaserSource {
  src: string;
  poster: string;
  width: number;
  height: number;
}

export const TEASER_RENDITIONS: Record<TeaserRendition, TeaserSource> = {
  landscape: {
    src: '/videos/teaser-landscape.mp4',
    poster: '/videos/poster-landscape.jpg',
    width: 1920,
    height: 1080,
  },
  portrait: {
    src: '/videos/teaser-portrait.mp4',
    poster: '/videos/poster-portrait.jpg',
    width: 1080,
    height: 1920,
  },
};

/**
 * Portrait only when the viewport is genuinely portrait-oriented; square and
 * degenerate viewports fall back to landscape (the cut that exists for "everything
 * that is not clearly a phone held upright").
 */
export function pickTeaserSource(viewportWidth: number, viewportHeight: number): TeaserRendition {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 'landscape';
  return viewportHeight > viewportWidth ? 'portrait' : 'landscape';
}
