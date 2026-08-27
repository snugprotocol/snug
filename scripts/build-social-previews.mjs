#!/usr/bin/env node
// build-social-previews.mjs — generates the two GitHub repo social-preview PNGs.
//
//   node scripts/build-social-previews.mjs
//
// Output: docs/assets/social/{snug,spec}-repo-preview.png, each exactly 1280×640
// (GitHub's documented repo-preview size; anything else is cropped or upscaled).
//
// These are the "2 uploads": GitHub exposes a repo's social preview ONLY through
// Settings → General → Social preview in the dashboard — no REST or GraphQL field
// writes it — so the upload itself stays a human act. This script exists so the images
// are reproducible from source rather than being opaque binaries nobody can correct:
// the brand colours are READ OUT of the playground's tokens.css (the same file the
// website's own theme uses), so a palette change here is a re-run, not a redraw.
//
// Rendering is SVG → PNG via the platform's own converter. No image library is added to
// the dependency tree for a script that runs by hand a few times a year (ADR-0056's
// posture on dependency surface); macOS ships `qlmanage`/`sips`, and the script fails
// loudly with the manual step if no converter is present rather than writing a
// wrong-sized file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(ROOT, 'apps', 'playground', 'src', 'theme', 'tokens.css');
const OUT_DIR = join(ROOT, 'docs', 'assets', 'social');
/** The site card ships WITH the site, so it lives under the website's public/ tree. */
const WEBSITE_PUBLIC = join(ROOT, 'apps', 'website', 'public', 'social');

/** GitHub's repo social preview; anything else is cropped or upscaled. */
const CARD = { width: 1280, height: 640 };

/** The org profile banner (snugprotocol/.github → profile/README.md), rendered at 800px
 *  wide in the README. Shorter than a repo card so the org's own copy stays above the fold. */
const BANNER = { width: 1280, height: 520 };

/** The WEBSITE's own social card — what unfurls when snugprotocol.org is pasted anywhere.
 *  1200×630 is Open Graph's documented size; X, LinkedIn, Facebook, Slack and iMessage all
 *  lay out against it. Served by the site (apps/website/public/), NOT hand-uploaded — see
 *  docs/runbooks/social-preview.md §2 and apps/website/src/config/socialImage.ts. */
const OG = { width: 1200, height: 630 };

/**
 * Read a CSS custom property's value from the FIRST (dark) block of tokens.css.
 * The file declares the light theme lower down with the same names, so a global match
 * would silently pick the light value — take the first hit only.
 */
function token(css, name) {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`token --${name} not found in ${TOKENS}`);
  return match[1].trim();
}

const css = readFileSync(TOKENS, 'utf8');
const palette = {
  bg: token(css, 'bg-deep'),
  fg: token(css, 'fg'),
  muted: token(css, 'fg-muted'),
  ember: token(css, 'ember'),
  emberBright: token(css, 'ember-bright'),
  border: token(css, 'border'),
};

// The rounded-square mark, identical to the inline SVG path in MarketingLayout.astro —
// same brand, one shape. Kept verbatim so a visual diff against the site is meaningful.
const MARK_PATH =
  'M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8zm6 9a5 5 0 0 0-5 5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6a5 5 0 0 0-5-5z';

/** Serif display face matching --font-display; the fallback chain mirrors tokens.css. */
const DISPLAY = "Iowan Old Style, Georgia, 'Times New Roman', serif";
const UI = "system-ui, -apple-system, 'Helvetica Neue', sans-serif";

/** Shared chrome: the ember wash, the base rule, and the gradient defs both layouts use. */
function frame({ width, height }, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.emberBright}" stop-opacity="0.20"/>
      <stop offset="55%" stop-color="${palette.ember}" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="${palette.bg}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${palette.emberBright}"/>
      <stop offset="100%" stop-color="${palette.ember}"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="${palette.bg}"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <rect x="0" y="${height - 6}" width="${width}" height="6" fill="url(#mark)"/>
${body}
</svg>`;
}

/** The mark + serif wordmark lockup, as it sits on the website's own nav. */
function lockup(x, y, scale = 2.6, fontSize = 76) {
  return `  <g transform="translate(${x}, ${y}) scale(${scale})">
    <path fill="url(#mark)" fill-rule="evenodd" d="${MARK_PATH}"/>
  </g>
  <text x="${x + 32 * scale + 26}" y="${y + 32 * scale * 0.75}" font-family="${DISPLAY}" font-size="${fontSize}" fill="${palette.fg}">snug.</text>`;
}

/** A repo card: one headline, one supporting line, the repo path along the bottom. */
function cardSvg({ wordmark, headline, sub }) {
  return frame(
    CARD,
    `${lockup(96, 176)}

  <text x="96" y="352" font-family="${DISPLAY}" font-size="54" fill="${palette.fg}">${headline}</text>
  <text x="96" y="416" font-family="${UI}" font-size="27" fill="${palette.muted}">${sub}</text>

  <text x="96" y="536" font-family="${UI}" font-size="23" fill="${palette.ember}" letter-spacing="2.5">${wordmark}</text>`,
  );
}

/**
 * The org banner. Carries the positioning line the org README leads with, then names the
 * two repos side by side — the same two messages the repo cards carry, in one image, so
 * the org front door says what each repo IS before a visitor clicks into either.
 *
 * Deliberately NOT a product screenshot: this replaces one (hub-talk-build-run.png), and a
 * screenshot of the hub shows the UI rather than the proposition. The org page is read by
 * people who do not yet know what Snug is.
 *
 * TASK-20260827: the headline was "MCP connects agents to tools. / Snug connects agents to
 * apps." — a definition by comparison, with another protocol as the reference point. It is
 * now the site's own headline plus the SHORT subline (owner call): the full website
 * subheadline does not fit this canvas at a readable size, and shrinking type to fit is how
 * a banner becomes unreadable on a phone.
 */
function bannerSvg() {
  const colY = 372;
  // Both columns are set against the same 96px margin the headline uses; the gap spreads
  // them across the canvas so the right half is not dead space beside a left-weighted block.
  const colGap = 616;
  const left = 96;
  const right = left + colGap;

  const column = (x, label, line) => `
  <rect x="${x}" y="${colY - 30}" width="44" height="3" fill="${palette.ember}"/>
  <text x="${x}" y="${colY + 26}" font-family="${UI}" font-size="22" fill="${palette.ember}" letter-spacing="2.2">${label}</text>
  <text x="${x}" y="${colY + 66}" font-family="${UI}" font-size="25" fill="${palette.muted}">${line}</text>`;

  // SVG text neither wraps nor shrinks to fit — an overlong line runs off the canvas and
  // renders with no warning (an early draft lost the last word off the right edge). Both
  // lines below are therefore SET, not trusted: the headline at 52px and the subline at
  // 27px each measure inside the 1088px of usable width (1280 less the two 96px margins),
  // which is why the longer website subheadline is not used here.
  return frame(
    BANNER,
    `${lockup(96, 84, 2.0, 58)}

  <text x="96" y="252" font-family="${DISPLAY}" font-size="52" fill="${palette.fg}">Your software shouldn&#8217;t need a <tspan fill="${palette.emberBright}" font-style="italic">landlord</tspan>.</text>
  <text x="96" y="306" font-family="${UI}" font-size="27" fill="${palette.muted}">Your app. Your data. Your choice of intelligence.</text>
${column(left, 'SNUGPROTOCOL/SNUG', 'The reference implementation')}
${column(right, 'SNUGPROTOCOL/SPEC', 'The protocol specification')}`,
  );
}

/**
 * The site card. Until TASK-20260827 this slot was filled by the landing teaser's poster
 * frame — a real screenshot, but a screenshot OF THE PLAYGROUND HUB, so it showed the
 * product's old "talk. build. run." hero long after the site stopped saying it. A card
 * whose picture contradicts its own title is worse than a plain one, and social caches are
 * keyed per URL and sticky, so the wrong image outlives the fix by weeks.
 *
 * This is therefore drawn, not captured: it carries the positioning itself, so it cannot
 * go stale behind a UI change. Same lockup, palette and rules as the org banner — one
 * visual system across every surface a link can land on.
 */
function ogCardSvg() {
  return frame(
    OG,
    `${lockup(84, 74, 1.8, 52)}

  <text x="84" y="270" font-family="${DISPLAY}" font-size="62" fill="${palette.fg}">Your software shouldn&#8217;t need</text>
  <text x="84" y="344" font-family="${DISPLAY}" font-size="62" fill="${palette.fg}">a <tspan fill="${palette.emberBright}" font-style="italic">landlord</tspan>.</text>

  <text x="84" y="410" font-family="${UI}" font-size="29" fill="${palette.muted}">Your app. Your data. Your choice of intelligence.</text>

  <rect x="84" y="470" width="52" height="3" fill="${palette.ember}"/>
  <text x="84" y="522" font-family="${UI}" font-size="25" fill="${palette.muted}">An open protocol for portable, agent-backed personal software.</text>
  <text x="84" y="562" font-family="${UI}" font-size="23" fill="${palette.ember}" letter-spacing="2.4">SNUGPROTOCOL.ORG &#183; OPEN SPEC &#183; MIT</text>`,
  );
}

/** GitHub's card is small on a phone — keep to short, high-contrast lines. */
const OUTPUTS = [
  {
    file: 'snug-repo-preview.png',
    size: CARD,
    svg: () =>
      cardSvg({
        wordmark: 'SNUGPROTOCOL/SNUG',
        headline: 'The reference implementation',
        sub: 'Desktop app, runtime, SDK and starters — MIT licensed.',
      }),
  },
  {
    file: 'spec-repo-preview.png',
    size: CARD,
    svg: () =>
      cardSvg({
        wordmark: 'SNUGPROTOCOL/SPEC',
        headline: 'The protocol specification',
        sub: 'Wire frames, the portable user file, runtime contracts.',
      }),
  },
  { file: 'org-profile-banner.png', size: BANNER, svg: bannerSvg },
  // The one output the WEBSITE serves rather than a human uploading: it is written into
  // apps/website/public/social/ so a deploy ships it (see the OUT_DIRS note below).
  { file: 'site-og-card.png', size: OG, svg: ogCardSvg, out: WEBSITE_PUBLIC },
];

function has(bin) {
  try {
    execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

/**
 * SVG → PNG at exactly the requested geometry.
 *
 * Converters are tried in order of how precisely they honour output geometry. Deliberately
 * NOT tried: `qlmanage`, which reports "produced one thumbnail" on success, writes nothing
 * for these files, and exits non-zero either way — it is a thumbnailer, not a renderer, and
 * its success message cannot be trusted as evidence a file exists.
 *
 * The caller re-reads the written bytes regardless, so a converter that silently produces
 * the wrong size fails the run rather than shipping a bad card.
 */
function renderPng(svgPath, pngPath, { width, height }) {
  if (has('rsvg-convert')) {
    execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', pngPath, svgPath]);
    return;
  }
  if (has('inkscape')) {
    execFileSync(
      'inkscape',
      [svgPath, '--export-type=png', `--export-filename=${pngPath}`, `--export-width=${width}`, `--export-height=${height}`],
      { stdio: 'ignore' },
    );
    return;
  }
  if (has('magick')) {
    execFileSync('magick', ['-background', 'none', '-density', '144', svgPath, '-resize', `${width}x${height}!`, pngPath]);
    return;
  }
  throw new Error(
    'no SVG renderer found. Install one of: rsvg-convert (brew install librsvg), inkscape, or imagemagick.\n' +
      `The SVG sources are written beside the PNGs in ${OUT_DIR} — they can be exported by hand at each output's size.`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });

for (const output of OUTPUTS) {
  // Most outputs are hand-uploaded or committed elsewhere, so they land in docs/assets/social/.
  // An output carrying `out` ships WITH the site instead (the OG card), and its directory is
  // created here rather than assumed to exist — a fresh clone has no public/social/.
  const pngDir = output.out ?? OUT_DIR;
  if (pngDir !== OUT_DIR) mkdirSync(pngDir, { recursive: true });
  // The SVG source stays beside its siblings in docs/assets/social/ either way: it is the
  // editable original, not a shipped asset, and the website's public/ tree is served verbatim.
  const svgPath = join(OUT_DIR, output.file.replace(/\.png$/, '.svg'));
  const pngPath = join(pngDir, output.file);
  writeFileSync(svgPath, output.svg(), 'utf8');
  renderPng(svgPath, pngPath, output.size);

  // Verify the bytes we just wrote rather than trusting the converter: PNG IHDR carries
  // width/height as big-endian uint32 at offsets 16 and 20. Lessons 2026-08-22 — a
  // delivered image's container dimensions are not its content's dimensions.
  const bytes = readFileSync(pngPath);
  const got = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (got.width !== output.size.width || got.height !== output.size.height) {
    throw new Error(
      `${output.file} rendered ${got.width}×${got.height}, expected ${output.size.width}×${output.size.height}`,
    );
  }
  console.log(`  ${output.file}  ${got.width}×${got.height}  ${(bytes.length / 1024).toFixed(0)} KB`);
}

console.log('\nwritten to docs/assets/social/ (site-og-card.png → apps/website/public/social/)');
console.log('Repo cards upload by hand; the org banner is committed to snugprotocol/.github;');
console.log('the site card ships with the next website deploy — see docs/runbooks/social-preview.md');
