// build-continuity.spec.ts — TASK-20260903-build-thread-continuity AC10 (ADR-0062).
//
// The real-browser proof that a build survives navigation (lesson 2026-08-20: run the
// product before claiming a UI feature works). jsdom proves the signal is never aborted;
// this proves the artifact card actually arrives on a page the user left and came back
// to, on the default serverless byok + demo-brain configuration — the whole build runs
// in-page, so there is no server to keep the turn alive for us.

import { expect, test } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

test.describe('a build keeps running while the user is elsewhere', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('start on /build → your apps → back: the artifact card lands; the sidebar listed the thread throughout', async ({
    page,
  }) => {
    // `?demoslow=1500` paces each of the demo brain's three round trips (adapter.ts e2e
    // seam): unpaced, the whole scripted build settles in ~15 ms — faster than the
    // navigation this test exists to prove the build survives.
    await page.goto('/build?demoslow=1500');
    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await composer.fill('build me tic-tac-toe');
    await composer.press('Enter');
    // The turn is visibly in flight and the sidebar badges it.
    await expect(page.getByTestId('status-line')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('thread-busy')).toBeVisible();

    // Leave immediately — before the demo brain's scripted turns can finish.
    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page.getByRole('textbox', { name: 'describe the app to build' })).toBeVisible();
    await page.getByRole('link', { name: 'build' }).click();

    // Back on the same thread: the user bubble is there (scoped to the chat — the sidebar
    // row carries the same words as the thread's title) and the reply arrives.
    await expect(page.locator('.chat-log').getByText('build me tic-tac-toe')).toBeVisible();
    const card = page.getByTestId('artifact-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('thread-busy')).toHaveCount(0);
    // The thread got its row and title from its first message.
    await expect(page.getByTestId('thread-row').filter({ hasText: 'build me tic-tac-toe' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  test('the hub create bar starts a NEW thread rather than continuing the previous one', async ({ page }) => {
    await page.goto('/build');
    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await composer.fill('build me tic-tac-toe');
    await composer.press('Enter');
    await expect(page.getByTestId('artifact-card')).toBeVisible({ timeout: 20_000 });

    await page.getByRole('link', { name: 'your apps' }).click();
    const idea = page.getByRole('textbox', { name: 'describe the app to build' });
    await idea.fill('a haiku machine');
    await idea.press('Enter');
    await expect(page).toHaveURL(/\/build/);
    // A fresh thread: the previous conversation is NOT on screen, but it IS in the list.
    await expect(page.getByText('a haiku machine').first()).toBeVisible();
    await expect(page.locator('.chat-log')).not.toContainText('tic-tac-toe');
    await expect(page.getByTestId('thread-row')).toHaveCount(2);
    await expect(page.getByTestId('thread-row').filter({ hasText: 'tic-tac-toe' })).toBeVisible();
  });
});
