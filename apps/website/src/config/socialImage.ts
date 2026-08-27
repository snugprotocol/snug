// socialImage.ts — the card image every page advertises, and its REAL dimensions.
//
// Single-homed beside site.ts for the same reason (ADR-0048 §1): the path is referenced
// by both shells through SocialMeta.astro, and the width/height are a claim about the
// file's bytes that a scraper trusts when laying out the card.
//
// The dimensions are PROBED, not assumed — `socialMeta.test.ts` reads the shipped file's
// JPEG SOF marker and fails if these drift from the real pixels. Lessons 2026-08-22: a
// delivered image's container dimensions are not its content's dimensions, and declaring
// the wrong ones tells a scraper to allocate a box the image does not fill.
//
// TASK-20260827: this was the landing teaser's POSTER FRAME — a real still, but a still of
// the Playground hub, so the card kept showing the product's old "talk. build. run." hero
// long after the site stopped saying it. A card whose picture contradicts its own title is
// worse than a plain one, and social caches are keyed per URL and sticky, so a stale image
// outlives the fix by weeks. It is now a DRAWN card carrying the positioning itself
// (scripts/build-social-previews.mjs → ogCardSvg), which cannot go stale behind a UI change
// and shares the org banner's lockup and palette.
//
// 1200×630 is Open Graph's documented size. It is deliberately NOT the 1280×640 repo
// previews in docs/assets/social/: those are GitHub's repo-page format and are uploaded by
// hand to each repo's settings, not served by the website (docs/runbooks/social-preview.md).

export interface SocialImage {
  /** Root-relative path within the built site; made absolute against `Astro.site`. */
  path: string;
  width: number;
  height: number;
  alt: string;
}

export const OG_IMAGE: SocialImage = {
  path: '/social/site-og-card.png',
  width: 1200,
  height: 630,
  // Describes what the card SHOWS — the words on it, in reading order — because that is
  // what a reader who cannot see it is missing. Not a restatement of the page's own
  // description, which the card already carries in og:description beside this.
  alt: 'Snug — “Your software shouldn’t need a landlord. Your app. Your data. Your choice of intelligence.” An open protocol for portable, agent-backed personal software.',
};
