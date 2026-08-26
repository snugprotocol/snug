// demo-brain-clarity.spec.ts — TASK-20260826 AC7 (ADR-0059): the assembled product
// proves the disclosure story end to end on the zero-key default.
//
//   1. First contact: the header chip names the demo brain and the builder shows the
//      one-time callout — while the composer stays fully usable beside it (a note,
//      never a gate).
//   2. Dismissal holds across SPA navigation (build → hub → build). The cross-RELOAD
//      half of the latch claim lives in demoCallout.test.tsx's re-init row instead:
//      an ephemeral context's OPFS does not survive hard reloads (lessons 2026-08-03),
//      so a reload here would test the harness, not the latch.
//   3. A demo build's assistant turn carries the pinned provenance tag.
//   4. The chip's menu opens with the honest copy and its settings door works.
//
// Selector contract additions (e2e/helpers.ts doctrine): data-testid brain-chip /
// brain-menu / brain-menu-settings / demo-brain-callout / demo-callout-dismiss /
// demo-turn-tag; the chip's accessible name is pinned by the mobile spec.

import { expect, test } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

test.describe('ADR-0059 — demo-brain disclosure', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('first visit: chip says demo brain, callout shows, composer stays usable; dismissal holds across SPA nav', async ({
    page,
  }) => {
    await page.goto('/build');

    const chip = page.getByTestId('brain-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-brain', 'demo');
    await expect(chip).toContainText('demo brain');

    const callout = page.getByTestId('demo-brain-callout');
    await expect(callout).toBeVisible();
    // A note, never a gate: the composer accepts input while the callout is up.
    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await composer.fill('still typing freely');
    await expect(composer).toHaveValue('still typing freely');

    await page.getByTestId('demo-callout-dismiss').click();
    await expect(callout).toHaveCount(0);

    // SPA navigation away and back: the latch holds (the store is set and the
    // write is on its way to the file; the reload half is unit-pinned).
    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page.getByRole('textbox', { name: 'describe the app to build' })).toBeVisible();
    await page.getByRole('link', { name: 'build' }).click();
    await expect(page.getByRole('textbox', { name: 'describe your app' })).toBeVisible();
    await expect(page.getByTestId('demo-brain-callout')).toHaveCount(0);
    // The chip is still there — the ambient surface never dismisses.
    await expect(page.getByTestId('brain-chip')).toBeVisible();
  });

  test('a demo build turn carries the pinned scripted-demo tag', async ({ page }) => {
    await page.goto('/build');
    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await composer.fill('build me tic-tac-toe');
    await composer.press('Enter');

    // The tag appears on the streaming assistant turn (stamped at send, not at
    // completion) and persists on the settled message.
    const tag = page.getByTestId('demo-turn-tag').first();
    await expect(tag).toBeVisible({ timeout: 20_000 });
    await expect(tag).toContainText('scripted demo — not an AI response');
    // …and the artifact still lands (the tag never blocks the build flow).
    await expect(page.getByTestId('artifact-card')).toBeVisible({ timeout: 20_000 });
  });

  test('the chip menu opens with the honest copy, and the settings door works', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('brain-chip').click();

    const menu = page.getByTestId('brain-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('no AI model or service is called');
    await expect(menu).toContainText('never to Snug’s servers');
    // The forbidden overclaim, asserted on the REAL rendered surface too.
    await expect(menu).not.toContainText('never leaves your device');

    await page.getByTestId('brain-menu-settings').click();
    await expect(page).toHaveURL(/\/settings/);
    // Acting on the menu closed it.
    await expect(page.getByTestId('brain-menu')).toHaveCount(0);
  });
});
