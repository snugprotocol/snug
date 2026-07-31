// strictmode.spec.ts — runner review F-4: React.StrictMode double-invokes the mount
// effect (host destroy + recreate) and re-runs the srcdoc effect, so the frame's
// document loads more times than a naive host would expect. A false `onNavigatedAway`
// here would permanently cut off a perfectly healthy app. jsdom cannot reproduce real
// iframe load timing — this is the real-browser proof.

import { expect, test } from '@playwright/test';
import { FIXTURE_URL, echoAppHtml } from './helpers';

test.describe('SnugAppFrame under React.StrictMode (F-4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${FIXTURE_URL}/harness.html`);
    await page.waitForFunction(() => (window as { __harnessReady?: boolean }).__harnessReady === true);
  });

  test('double mount + srcdoc reassignment fires no false onNavigatedAway within 2s', async ({ page }) => {
    await page.evaluate(
      ({ html }) =>
        (window as unknown as { __mount: (o: object) => void }).__mount({
          html,
          strict: true,
          replyJson: '{"answer":"pong"}',
        }),
      { html: echoAppHtml() },
    );

    // The bridge must come up healthy: the app announces and completes a round-trip.
    await page.waitForFunction(() => (window as unknown as { __announces: unknown[] }).__announces.length >= 1);
    const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(frame.locator('#status')).toHaveText('done');

    // F-4 assertion window: no navigation cutoff within 2s of the StrictMode mount.
    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => (window as unknown as { __navigatedAway: number }).__navigatedAway)).toBe(0);
  });

  test('html swap flows through the reset path, not a navigation cutoff', async ({ page }) => {
    await page.evaluate(
      ({ html }) =>
        (window as unknown as { __mount: (o: object) => void }).__mount({
          html,
          strict: true,
          replyJson: '{"answer":"first"}',
        }),
      { html: echoAppHtml({ displayName: 'first app' }) },
    );
    await page.waitForFunction(() => (window as unknown as { __announces: unknown[] }).__announces.length >= 1);

    // Reassign srcdoc via the html prop (SnugAppFrame's documented RESET path).
    await page.evaluate(
      ({ html }) => (window as unknown as { __setHtml: (h: string) => void }).__setHtml(html),
      { html: echoAppHtml({ appId: 'e2e-echo-2', displayName: 'second app' }) },
    );

    // The NEW document announces and completes a round-trip — host still alive.
    await page.waitForFunction(() =>
      (window as unknown as { __announces: Array<{ appId: string }> }).__announces.some(
        (a) => a.appId === 'e2e-echo-2',
      ),
    );
    const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(frame.locator('#status')).toHaveText('done');

    await page.waitForTimeout(2000);
    expect(await page.evaluate(() => (window as unknown as { __navigatedAway: number }).__navigatedAway)).toBe(0);
  });
});
