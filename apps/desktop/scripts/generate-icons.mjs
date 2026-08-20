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
// derives from one source of truth: the same 32-unit "Ember Niche" path the app
// renders (ui/Logo.tsx) and the favicon ships.
//
// TASK-20260819: the set is now built from TWO masters, because macOS and Windows
// disagree about what an icon file is:
//   mac master  → icon.icns, icon.png   Apple grid: 824px artwork centred in a 1024
//                                       canvas with a transparent margin, outer shape
//                                       an Apple-radius squircle. macOS does NOT mask
//                                       or inset icons — shape and margin must be
//                                       baked into the pixels, or the dock shows an
//                                       oversized square with baked-background chips.
//   win master  → 32x32.png,            Full-bleed and fully opaque on a dark plate
//                 128x128.png,          (Windows expects no margin); the tile keeps
//                 128x128@2x.png        the mark's own corner radius.
// In BOTH masters the arched niche is painted the dark ground #171310 — matching how
// the web logo's evenodd knockout reads over the dark theme background. The niche
// dark is a solid single-subpath layer underneath; the previous revision drew the
// full mark path nonzero as the backing and the inner subpath's opposite winding
// knocked the niche out of THAT too, so the page background (white) showed through.
//
// TASK-20260820: `icon.ico` is NO LONGER SHIPPED — ADR-0021 D8 restricted the bundle
// to macOS targets, and a Windows-only container in a macOS-only bundle reads as
// intent. The win master stays: these three PNGs are generic sizes tauri reads on
// every platform, not Windows-only assets. If Windows is reconsidered post-1.0 (its
// own ADR), re-adding `['icon.ico', winOut]` to SHIP below is the whole change —
// the master that produces it is untouched. Pinned by bundleTargets.test.ts.
//
// Usage:  node scripts/generate-icons.mjs
// Then:   pnpm --filter desktop test   (src/__tests__/appIcon.test.ts locks the result)
//
// Requires no new dependency: it renders with the Chromium that Playwright already
// installs for the e2e suites, then hands each master to `tauri icon`. NOTE: `tauri
// icon` only resizes/repackages its source — it does not add the macOS margin or
// squircle, which is why the mac master carries them itself.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
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

// The niche subpath alone (the arch knocked out of the tile), same units.
const NICHE_PATH =
  'M16 11a5 5 0 0 0-5 5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6a5 5 0 0 0-5-5z';

const NICHE = '#171310'; // the dark-theme ground, showing through the knocked-out niche
const EMBER = '#e8873a'; // the ember tile itself; holds contrast on light and dark docks

const SIZE = 1024;

const TILE_INSET = 2; // the mark path's own margin inside its 32-unit viewBox
const TILE_SPAN = 32 - TILE_INSET * 2; // 28 units of actual tile

// Apple icon grid: 824px of artwork centred in a 1024 canvas (margin 100 per side),
// squircle corner radius ≈ 185.4/824 of the artwork. Owner decision 2026-08-19: the
// mac icon uses Apple's radius (dock consistency), not the mark's own rounder 8/28 —
// the brand shape stays canonical everywhere else (Logo.tsx, favicon, win files).
const MAC_MARGIN = 100;
const MAC_ART = SIZE - MAC_MARGIN * 2; // 824
const APPLE_RADIUS_FRACTION = 185.4 / 824;

/** Rounded-rect subpath in mark units, spanning the tile bounds 2..30. */
function tileSubpath(radius) {
  const lo = TILE_INSET;
  const hi = TILE_INSET + TILE_SPAN;
  const r = radius;
  return (
    `M${lo + r} ${lo}` +
    `H${hi - r}` +
    `A${r} ${r} 0 0 1 ${hi} ${lo + r}` +
    `V${hi - r}` +
    `A${r} ${r} 0 0 1 ${hi - r} ${hi}` +
    `H${lo + r}` +
    `A${r} ${r} 0 0 1 ${lo} ${hi - r}` +
    `V${lo + r}` +
    `A${r} ${r} 0 0 1 ${lo + r} ${lo}` +
    'Z'
  );
}

/**
 * Compose a master SVG. Layering is deliberately winding-proof:
 *   1. an optional full-canvas plate (win only) — solid dark, no subpaths;
 *   2. the niche alone, filled dark — a solid single-subpath shape;
 *   3. the outer tile with the niche knocked out via evenodd, filled ember —
 *      evenodd holes regardless of subpath winding, and the dark layer beneath is
 *      what shows through.
 */
function masterSvg({ plate, tilePath, scale, shift }) {
  const plateRect = plate ? `<rect width="${SIZE}" height="${SIZE}" fill="${NICHE}" />` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  ${plateRect}
  <g transform="translate(${shift} ${shift}) scale(${scale})">
    <path fill="${NICHE}" d="${NICHE_PATH}" />
    <path fill="${EMBER}" fill-rule="evenodd" d="${tilePath}${NICHE_PATH}" />
  </g>
</svg>`;
}

// mac: Apple-radius squircle on the 824 grid, transparent margin all round.
const macScale = MAC_ART / TILE_SPAN;
const macSvg = masterSvg({
  plate: false,
  tilePath: tileSubpath(TILE_SPAN * APPLE_RADIUS_FRACTION),
  scale: macScale,
  shift: MAC_MARGIN - TILE_INSET * macScale,
});

// win: the mark's own tile (brand radius 8), full-bleed on an opaque dark plate —
// the plate owns the corners outside the rounded tile, so nothing is ever white.
const winScale = SIZE / TILE_SPAN;
const winSvg = masterSvg({
  plate: true,
  // The mark's outer tile IS a radius-8 rounded rect over 2..30; rebuilt via
  // tileSubpath(8) so both masters share one geometry helper.
  tilePath: tileSubpath(8),
  scale: winScale,
  shift: -TILE_INSET * winScale,
});

const work = mkdtempSync(join(tmpdir(), 'snug-icon-'));

/** Screenshot an SVG at SIZE×SIZE with a transparent page → clean RGBA master. */
async function rasterize(chromium, name, svgSource) {
  const svgPath = join(work, `${name}.svg`);
  const pngPath = join(work, `${name}.png`);
  writeFileSync(svgPath, svgSource);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.goto(`file://${svgPath}`);
  // omitBackground keeps the page background OUT of the pixels — baking it in is how
  // the 2026-08-13 set shipped with opaque white corners and a white niche.
  await page.screenshot({ path: pngPath, omitBackground: true });
  await browser.close();
  return pngPath;
}

try {
  // Rasterize with Playwright's Chromium — already a devDependency of the repo, so no
  // new tool. Resolved from apps/playground, which owns the Playwright dependency
  // (the e2e suites live there); apps/desktop should not gain one for a script that
  // runs by hand a few times a year.
  const playwrightEntry = resolve(
    desktopRoot,
    '../playground/node_modules/@playwright/test/index.mjs',
  );
  const { chromium } = await import(`file://${playwrightEntry}`);
  const macPng = await rasterize(chromium, 'mac', macSvg);
  const winPng = await rasterize(chromium, 'win', winSvg);

  // `tauri icon` fans a master out into a directory. Two masters → two runs into
  // scratch dirs, then place each shipped file from the run that owns it.
  const macOut = join(work, 'out-mac');
  const winOut = join(work, 'out-win');
  for (const [png, out] of [[macPng, macOut], [winPng, winOut]]) {
    mkdirSync(out, { recursive: true });
    execFileSync('pnpm', ['exec', 'tauri', 'icon', png, '--output', out], {
      cwd: desktopRoot,
      stdio: 'inherit',
    });
  }

  // tauri.conf.json's bundle.icon lists four files and tauri reads `icon.png` as the
  // macOS master implicitly — five in all; `tauri icon` also writes a full mobile +
  // Windows-Store matrix nobody reads. Copy the five, never the rest.
  const iconsDir = resolve(desktopRoot, 'src-tauri/icons');
  const SHIP = [
    ['icon.icns', macOut],
    ['icon.png', macOut],
    ['32x32.png', winOut],
    ['128x128.png', winOut],
    ['128x128@2x.png', winOut],
  ];
  for (const entry of readdirSync(iconsDir, { withFileTypes: true })) {
    rmSync(join(iconsDir, entry.name), { recursive: true, force: true });
  }
  for (const [name, from] of SHIP) {
    copyFileSync(join(from, name), join(iconsDir, name));
  }

  console.log(
    `\nicons regenerated from two ${SIZE}px masters:` +
      `\n  mac (icon.icns, icon.png): Apple-grid squircle, transparent margin, #171310 niche` +
      `\n  win master (32/128px):     full-bleed brand tile on an opaque #171310 plate` +
      `\nshipped ${SHIP.length} files; mobile/store variants never copied`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
