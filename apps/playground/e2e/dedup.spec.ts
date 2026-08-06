// dedup.spec.ts — living-apps umbrella AC8 (TASK-20260803-hub-retrofit): a marketplace
// starter installs AT MOST once. The regression this kills: every click on a starter
// tile minted a fresh UUID app row, filling "your apps" with duplicates. Now the tile
// is find-or-open — the second click connects to the existing install.

import { expect, test } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

test.describe('AC8 — marketplace install dedup', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('clicking a starter twice connects to the same installed app', async ({ page }) => {
    await page.goto('/');
    // A starter now OPENS read-only first; Install lives in the run view, so owning a
    // copy is a deliberate two-step act (owner request, 2026-08-04).
    await page.getByRole('button', { name: /open chess/i }).click();
    await page.getByTestId('starter-install').click();
    // Wait for the INSTALLED url shape (uuid), not just /run/ — the read-only starter
    // route already matches /\/run\//, so the unanchored wait captured firstUrl BEFORE
    // the install navigation landed and the later toHaveURL(firstUrl) raced it (flaky
    // 2-of-3 full runs; found by the AL-08 adversarial review).
    await expect(page).toHaveURL(/\/run\/[0-9a-f-]{36}/, { timeout: 20_000 });
    const firstUrl = page.url();

    // SPA navigation back (ephemeral-context OPFS does not survive hard reloads —
    // 2026-08-03 lesson; persistence-across-reload is AC2's covered claim, not ours).
    await page.getByRole('link', { name: 'your apps' }).click();
    // the tile now shows its installed state…
    await expect(page.locator('.tile-installed-badge')).toBeVisible();
    // …and clicking it OPENS the existing copy instead of installing another
    await page.getByRole('button', { name: /open chess/i }).click();
    await expect(page).toHaveURL(firstUrl, { timeout: 20_000 });

    await page.getByRole('link', { name: 'your apps' }).click();
    // exactly one app row exists in "your apps" (first tile grid on the page)
    await expect(page.locator('.tile-grid').first().locator('.app-tile')).toHaveCount(1);
  });
});
