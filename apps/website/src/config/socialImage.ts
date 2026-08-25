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
// This is the landing teaser's poster frame — a real, on-brand 16:9 still that already
// ships with the site. It is deliberately NOT the 1280×640 repo previews in
// docs/assets/social/: those are GitHub's repo-page format and are uploaded by hand to
// each repo's settings, not served by the website (see docs/runbooks/social-preview.md).

export interface SocialImage {
  /** Root-relative path within the built site; made absolute against `Astro.site`. */
  path: string;
  width: number;
  height: number;
  alt: string;
}

export const OG_IMAGE: SocialImage = {
  path: '/videos/poster-landscape.jpg',
  width: 1920,
  height: 1080,
  alt: 'Snug — an open protocol for tiny, user-built apps that live in one portable file you own.',
};
