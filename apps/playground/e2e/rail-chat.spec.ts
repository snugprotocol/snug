// rail-chat.spec.ts — TASK-20261013-rail-chat-access (AC5): the chat beside an app keeps its input.
//
// THE OWNER'S BUG: after one message the rail chat showed no input box. The composer was still
// mounted — pushed below the rail's fold by a static position at the end of a full-height column
// (see src/__tests__/railChatComposer.test.tsx). Only a real layout can prove it is back on screen.
import { expect, test } from '@playwright/test';

import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

test.describe('AC5 — the rail chat’s composer stays inside the visible rail', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('with the build conversation in the rail, and after a further message, the composer is on screen', async ({ page }) => {
    // The demo brain builds in-page (byok + demo is the portable default) — build-run.spec.ts's flow.
    await page.goto('/build');
    const idea = page.getByRole('textbox', { name: 'describe your app' });
    await idea.fill('build me a habit tracker');
    await idea.press('Enter');
    const card = page.getByTestId('artifact-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('link', { name: /run it/i }).click();
    await expect(page).toHaveURL(/\/run\//);

    // The installed app opens on its chat, which already holds the build conversation.
    const composer = page.getByRole('textbox', { name: 'message the agent' });
    await expect(composer).toBeAttached({ timeout: 20_000 });
    await expect(composer).toBeInViewport();

    await composer.fill('what does this app do?');
    await composer.press('Enter');
    await expect(page.locator('.rail').getByText('what does this app do?')).toBeVisible({ timeout: 20_000 });
    await expect(composer).toBeInViewport();
    await expect(composer).toBeEditable();
  });
});
