// desktop-badge.spec.ts — TASK-20260821-site-playground-polish AC3.
//
// The desktop-only tile badge is a real /download LINK, and — the part jsdom cannot
// see — a REAL POINTER CLICK must reach it. Before this task the tile's flex-stretched
// card button covered the badge in hit-testing (both position-static siblings under an
// absolutely-positioned badge with z-index auto), so the tag looked clickable while
// every actual click landed on the disabled button and went nowhere. Found by the
// task's browser walk; the fix is an explicit z-index on `.tile-desktop-badge`.
// Playwright clicks by coordinates with hit-testing, so a regression reds this spec.

import { expect, test } from '@playwright/test';

test.describe('desktop-only badge — really clickable', () => {
  test('a pointer click on the DESKTOP tag reaches /download', async ({ page }) => {
    await page.goto('/');
    const badge = page.getByTestId('desktop-only-badge').first();
    await expect(badge).toBeVisible();
    // The tag copy is the short owner-picked word; the explanation rides the title.
    await expect(badge).toHaveText(/^\s*desktop\s*$/i);
    await badge.click();
    await expect(page).toHaveURL(/\/download$/, { timeout: 10_000 });
  });

  // MIGRATED (TASK-20261003 S2, ADR-0072 §4 — the reason TEXT only; the badge above is
  // untouched). The three locked starters used to share one title — "this starter reaches
  // things a web page cannot" — over a button whose own title blamed the home network for
  // all three. Each lock is derived from what the starter declares now, so each badge says
  // its own reason after the same lead-in.
  test('each locked starter’s badge carries ITS reason in the title', async ({ page }) => {
    await page.goto('/');
    const badgeOf = (folder: string) => page.locator(`[data-testid="starter-tile"][data-starter-name="${folder}"]`).getByTestId('desktop-only-badge');
    await expect(badgeOf('hue')).toBeVisible({ timeout: 20_000 });
    for (const [folder, reason] of [
      ['hue', /home network/],
      ['trade copilot', /requests sent from a web page/],
      ['whatsapp', /helper program/],
    ] as const) {
      await expect(badgeOf(folder)).toHaveText(/^\s*desktop\s*$/i);
      await expect(badgeOf(folder)).toHaveAttribute('title', /^needs the Snug desktop app \(a free download\) — /);
      await expect(badgeOf(folder)).toHaveAttribute('title', reason);
    }
    await expect(page.getByTestId('desktop-only-badge')).toHaveCount(3);
  });
});
