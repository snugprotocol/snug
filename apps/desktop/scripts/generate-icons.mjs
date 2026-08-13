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

const PLATE = '#171310'; // the dark-theme background, as apple-touch-icon.svg uses
const EMBER = '#e8873a'; // the dark-theme ember; holds contrast on light and dark docks

const SIZE = 1024;
// apple-touch-icon.svg insets the 32-unit mark by 26/180 ≈ 14.4% per side. Keeping that
// exact ratio means the desktop icon and the iOS home-screen icon are the same artwork.
const INSET_RATIO = 26 / 180;
const inset = Math.round(SIZE * INSET_RATIO);
const markSize = SIZE - inset * 2;
const scale = markSize / 32;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${PLATE}" />
  <g transform="translate(${inset} ${inset}) scale(${scale})">
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
    `\nicons regenerated from a ${SIZE}px master (mark inset ${inset}px per side)` +
      `\nkept ${KEEP.size} shipped targets, dropped ${dropped} unused mobile/store variants`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
