// generate-icons — regenerate the Tauri app icon set from the canonical mark.
//
// WHY THIS EXISTS (TASK-20260813 AC3): the committed icons were made by hand once,
// with nothing to reproduce them. The composition was wrong — the ember mark sat at
// x 116..497 of a 1024 canvas (gap 116 left, 526 right), so it filled only ~37% of
// the tile and hugged the top-left corner while the rest was empty black plate. The
// dock showed a small mark adrift in a dark square.
//
// The fix is a SCRIPT rather than six replacement bitmaps, because a hand-made asset
// with no generator is exactly how the defect happened in the first place. Every icon
// now derives from one source of truth: the same 32-unit "Ember Niche" path the app
// renders (ui/Logo.tsx) and the favicon ships, composed like apple-touch-icon.svg —
// full-bleed plate, mark centred with a proportional inset.
//
// Usage:  node scripts/generate-icons.mjs
// Then:   pnpm --filter desktop test   (src/__tests__/appIcon.test.ts locks the result)
//
// Requires no new dependency: it renders with the Chromium that Playwright already
// installs for the e2e suites, then hands the 1024 master to `tauri icon`, which is
// what produces the platform-correct .icns/.ico (including the macOS rounded-square
// safe area) from a single square source.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');

// The mark, byte-identical to apps/playground/src/ui/Logo.tsx and public/favicon.svg.
// Kept as a literal because this script must run without importing app source (it is
// plain node, not vite) — appIcon.test.ts locks the RESULT, so a drift here shows up
// as a failing composition test rather than a silent mismatch.
const MARK_PATH =
  'M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8zm6 9a5 5 0 0 0-5 5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6a5 5 0 0 0-5-5z';

const NICHE = '#171310'; // the dark-theme ground, showing through the knocked-out niche
const EMBER = '#e8873a'; // the ember tile itself; holds contrast on light and dark docks

const SIZE = 1024;

/**
 * THE LOGO *IS* THE ICON (owner, 2026-08-13: "the logo should cover it completely").
 *
 * The first pass centred the mark on a dark plate at 61% of the tile, copying
 * apple-touch-icon.svg. That is right for iOS — which squares off transparency and
 * composites onto white, so the plate is load-bearing there — but on a desktop dock it
 * reads as a small logo adrift in a dark square, which is what the owner screenshotted.
 *
 * The mark is ALREADY a tile: its path draws a rounded square spanning units 2..30 of a
 * 32 viewBox, with the arched niche knocked out via evenodd. So the icon is that tile
 * scaled until it fills the canvas edge to edge — no second plate, no inset. The niche
 * is painted with the dark ground BEHIND the tile rather than left transparent, so the
 * shelter still reads as a shape instead of a hole punched through to the wallpaper.
 *
 * 32/28 scales units 2..30 (the tile's own bounds) up to the full 0..SIZE canvas.
 */
const TILE_INSET = 2; // the mark path's own margin inside its 32-unit viewBox
const TILE_SPAN = 32 - TILE_INSET * 2; // 28 units of actual tile
const scale = SIZE / TILE_SPAN;
const shift = -TILE_INSET * scale; // pull unit 2 back to canvas 0

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <g transform="translate(${shift} ${shift}) scale(${scale})">
    <!-- The niche ground first, clipped to the tile: the knockout reveals THIS, not the
         desktop behind the icon. Drawing the same path filled dark, then the evenodd
         ember tile on top, keeps the two shapes registered to the same geometry. -->
    <path fill="${NICHE}" d="${MARK_PATH}" />
    <path fill="${EMBER}" fill-rule="evenodd" d="${MARK_PATH}" />
  </g>
</svg>`;

const work = mkdtempSync(join(tmpdir(), 'snug-icon-'));
const svgPath = join(work, 'icon.svg');
const pngPath = join(work, 'icon.png');

try {
  writeFileSync(svgPath, svg);

  // Rasterize with Playwright's Chromium — already a devDependency of the repo, so no
  // new tool. A headless screenshot of the SVG at exactly SIZE x SIZE gives a clean
  // 8-bit RGBA master with no resampling.
  //
  // Resolved from apps/playground, which is the workspace that owns the Playwright
  // dependency (the e2e suites live there). Importing a bare 'playwright' here would
  // fail — apps/desktop has no such dependency and should not gain one for a script
  // that runs by hand a few times a year.
  const playwrightEntry = resolve(
    desktopRoot,
    '../playground/node_modules/@playwright/test/index.mjs',
  );
  const { chromium } = await import(`file://${playwrightEntry}`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.goto(`file://${svgPath}`);
  await page.screenshot({ path: pngPath, omitBackground: false });
  await browser.close();

  // `tauri icon` fans the master out into src-tauri/icons/.
  execFileSync('pnpm', ['exec', 'tauri', 'icon', pngPath, '--output', 'src-tauri/icons'], {
    cwd: desktopRoot,
    stdio: 'inherit',
  });

  // `tauri icon` always writes the FULL mobile + Windows-Store matrix, but this app
  // ships desktop only — tauri.conf.json's bundle.icon lists exactly six files. Drop
  // the rest rather than committing ~30 unused binaries that no build reads and that
  // would go stale silently.
  const iconsDir = resolve(desktopRoot, 'src-tauri/icons');
  const KEEP = new Set(['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns', 'icon.ico']);
  let dropped = 0;
  for (const entry of readdirSync(iconsDir, { withFileTypes: true })) {
    if (KEEP.has(entry.name)) continue;
    rmSync(join(iconsDir, entry.name), { recursive: true, force: true });
    dropped += 1;
  }

  console.log(
    `\nicons regenerated from a ${SIZE}px master (the mark tile fills the canvas edge to edge)` +
      `\nkept ${KEEP.size} shipped targets, dropped ${dropped} unused mobile/store variants`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
