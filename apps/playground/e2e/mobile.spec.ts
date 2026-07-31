// mobile.spec.ts — 375px viewport smoke (design brief: fully usable at 375px, rails
// become sheets, touch targets ≥44px, no horizontal body scroll). Runs only in the
// mobile-chromium project (see playwright.config.ts); skips until the app shell
// (workstream A) lands — selector contract in e2e/helpers.ts.

import { expect, test, type Page } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, 'page body must never scroll horizontally at 375px').toBeLessThanOrEqual(1);
}

test.describe('375px viewport', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('hub renders with the always-visible create bar, no horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'describe the app to build' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('builder composer is usable: type, ≥44px touch targets', async ({ page }) => {
    await page.goto('/build');
    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await expect(composer).toBeVisible();
    await composer.fill('build me tic-tac-toe');
    await expect(composer).toHaveValue('build me tic-tac-toe');
    // The build affordance itself must be a real touch target (brief: ≥44px).
    const build = page.getByRole('button', { name: 'build' });
    await expect(build).toBeEnabled();
    const box = await build.boundingBox();
    expect(box, 'build button must have a bounding box').not.toBeNull();
    expect(box!.height, 'build button touch target ≥44px').toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
  });

  test('run view rails collapse to a sheet behind an always-visible toggle', async ({ page }) => {
    // A starter app: runs with no server round and no mock-script consumption.
    await page.goto('/run/starter--chess');

    // At 375px the Inspector must NOT sit open as a side rail…
    await expect(page.locator('aside.rail')).toHaveCount(0);
    // …but must open as a sheet from an always-reachable toggle (no hover-only affordances).
    const toggle = page.getByRole('button', { name: 'open inspector' });
    await expect(toggle).toBeVisible();
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox, 'toggle must have a bounding box').not.toBeNull();
    expect(toggleBox!.height, 'inspector toggle touch target ≥44px').toBeGreaterThanOrEqual(44);
    await toggle.tap();
    const sheet = page.getByRole('dialog', { name: 'watch it think' });
    await expect(sheet).toBeVisible();
    // Rail tabs are reachable inside the sheet.
    await expect(sheet.getByRole('button', { name: 'inspector' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'chat' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
