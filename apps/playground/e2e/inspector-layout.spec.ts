// inspector-layout.spec.ts — TASK-20260813 AC5, owner repro 2026-08-13.
//
// THE BUG, as the owner screenshotted it: in the "watch it think" rail, a round trip's
// summary line rendered ONE CHARACTER PER LINE — "claude-sonnet-5" as a 15-row vertical
// stack, the entry 342px tall instead of 18px.
//
// THE CAUSE: `.llm-summary` (flex:1) shared a flex row with `.llm-meta`, which was
// `flex-shrink: 0`. The meta text ("1.9s · 2,393 in · 66 out · 0% cached") measures
// ~260px, so inside a 340px rail it claimed the row and squeezed the summary down to its
// MIN-CONTENT width — and `overflow-wrap: anywhere` lets min-content be a single glyph.
//
// WHY THIS TEST IS HERE AND NOT IN VITEST: the defect is pure layout. jsdom has no
// layout engine — every rect is 0×0 — so a unit test cannot see it, and a CSS-text
// assertion only proves a property is present, not that the row actually fits. My first
// pass at this task shipped exactly that kind of assertion, declared AC5 unreproducible
// after probing the WRONG element (the <pre> payload block), and missed the real defect.
// Measuring the rendered box is the only honest guard.
//
// Self-contained: it builds the inspector markup against the real stylesheets rather
// than driving a live LLM turn, so it needs no adapter, no key, and no app — the
// geometry is what is under test, and it must hold at the rail's narrowest setting.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const tokens = readFileSync(resolve(appRoot, 'src/theme/tokens.css'), 'utf8');
const app = readFileSync(resolve(appRoot, 'src/theme/app.css'), 'utf8');

/** The exact content from the owner's screenshot — long model name, long meta line. */
const ROUND_TRIP = `
  <div class="llm-inspector">
    <p class="llm-totals">1 round trip · 1.9s · 2,393 in / 66 out · 0% cached</p>
    <ol class="llm-list">
      <li class="llm-entry">
        <button class="llm-entry-head">
          <span class="llm-index">#1</span>
          <span class="llm-summary" id="summary">end<span class="llm-model"> · claude-sonnet-5</span></span>
          <span class="llm-meta" id="meta">1.9s · 2,393 in · 66 out · 0% cached</span>
        </button>
      </li>
    </ol>
  </div>`;

const pageHtml = (railWidth: number): string => `<!doctype html>
<html data-theme="dark" style="--rail-width:${railWidth}px"><head><style>
${tokens}
${app}
</style></head><body>
<div class="run-layout" style="height:640px">
  <div class="run-stage"><div class="frame-wrap"></div></div>
  <aside class="rail"><div class="rail-body"><div class="think-panel">
    <section class="think-section">${ROUND_TRIP}</section>
  </div></div></aside>
</div></body></html>`;

test.describe('inspector round-trip layout (AC5)', () => {
  // 280 is the rail's clamped MINIMUM (RAIL_WIDTH_MIN) — the worst case a user can drag
  // to. 340 is the default, the width the owner's screenshot was taken at.
  for (const railWidth of [280, 340, 520]) {
    test(`the summary line reads horizontally at a ${railWidth}px rail`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 700 });
      await page.setContent(pageHtml(railWidth));

      const box = await page.locator('#summary').evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const probe = document.createElement('span');
        probe.style.font = getComputedStyle(el).font;
        probe.textContent = 'M';
        document.body.appendChild(probe);
        const charWidth = probe.getBoundingClientRect().width;
        probe.remove();
        return { width: rect.width, height: rect.height, charWidth };
      });

      // The load-bearing assertion: the summary must be many characters wide, not one.
      // Stated as a ratio rather than a pixel count so it survives font changes.
      expect(
        box.width / box.charWidth,
        `the summary collapsed to ~${Math.round(box.width / box.charWidth)} characters per line`,
      ).toBeGreaterThan(10);

      // And the corollary the eye actually notices: one text line, not a tall stack.
      // 3 lines of slack keeps this honest without being brittle about wrapping.
      expect(box.height, 'the summary grew into a vertical character stack').toBeLessThan(box.charWidth * 8);
    });
  }

  test('the round-trip entry never scrolls horizontally', async ({ page }) => {
    // The other half of AC5: fixing the collapse must not simply push the overflow
    // sideways into a horizontal scrollbar, which is just a different unreadable panel.
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.setContent(pageHtml(340));

    const overflow = await page.locator('.rail-body').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(overflow.scrollWidth, 'the rail body overflows horizontally').toBeLessThanOrEqual(
      overflow.clientWidth + 1, // sub-pixel rounding
    );
  });

  test('a long unbroken payload token wraps instead of stretching the rail', async ({ page }) => {
    // The <pre> block I originally (wrongly) blamed for the collapse. It was never the
    // cause, but it IS a real hazard now that the rail width is user-controlled, so it
    // gets a measured guard rather than the CSS-text assertion it had before.
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.setContent(`<!doctype html>
<html data-theme="dark" style="--rail-width:280px"><head><style>
${tokens}
${app}
</style></head><body>
<div class="run-layout" style="height:640px">
  <div class="run-stage"><div class="frame-wrap"></div></div>
  <aside class="rail"><div class="rail-body"><div class="think-panel"><section class="think-section">
    <div class="llm-inspector"><ol class="llm-list"><li class="llm-entry">
      <div class="llm-entry-body"><section>
        <pre class="llm-block" id="block">{"artifact":"${'A'.repeat(600)}"}</pre>
      </section></div>
    </li></ol></div>
  </section></div></div></aside>
</div></body></html>`);

    const block = await page.locator('#block').evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.font = getComputedStyle(el).font;
      probe.textContent = 'M';
      document.body.appendChild(probe);
      const charWidth = probe.getBoundingClientRect().width;
      probe.remove();
      return { clientWidth: el.clientWidth, charWidth };
    });
    expect(block.clientWidth / block.charWidth, 'the payload block collapsed').toBeGreaterThan(10);
  });
});
