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
});
