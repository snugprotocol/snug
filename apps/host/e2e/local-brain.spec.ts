// local-brain.spec.ts — when no brain is ready the DEMO brain answers (TASK-20261003 D4).
//
// The owner's walk found a logged-out CLI surfacing as a bare 502 at the first think. D-B35
// put the reason on the chip; the think was still sent to the shim and still came back a
// 502 — the chip said "demo brain" for a machine with no CLI while nothing demo-shaped ever
// answered. The runner's platform now pins the demo brain while it KNOWS the CLI cannot
// answer, so an app's think is answered and nothing is sent to a brain that is not there.
//
// The test build's brain THROWS unless a model is pinned ("the test build has no brain…"),
// which is exactly what a missing or logged-out CLI does to the shim: a think that reached
// it would be the 502 this leg forbids.
import fs from 'node:fs';
import path from 'node:path';

import { chromium, expect, test, type Browser } from '@playwright/test';

import { IDP_HOST, STUB_HOST, startLocalHost, type LocalHarness, type LocalHostOptions } from './local-setup.js';

let browser: Browser;

test.beforeAll(async () => {
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1,MAP ${IDP_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  });
});
test.afterAll(async () => {
  await browser?.close();
});

const withHost = async (fn: (harness: LocalHarness) => Promise<void>, options: LocalHostOptions = {}): Promise<void> => {
  const harness = await startLocalHost(options);
  try {
    await fn(harness);
  } finally {
    await harness.stop();
  }
};

for (const state of ['logged-out', 'absent', 'outdated'] as const) {
  test(`D4 — with the CLI ${state}, an app’s think is ANSWERED by the demo brain — nothing is sent to the shim, so never a 502`, async () => {
    await withHost(
      async (harness) => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        // The starter script, served from the repo (jsDelivr is not reachable from this harness).
        const chess = path.resolve(process.cwd(), 'starters-pkg/chess.js');
        await page.route('**/@snugprotocol/starters@*/chess.js', (route) =>
          route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' }, body: fs.readFileSync(chess) }));
        const thinks: number[] = [];
        const rechecks: string[] = [];
        page.on('response', (response) => {
          if (response.url().endsWith('/v1/chat/completions')) thinks.push(response.status());
        });
        page.on('request', (request) => {
          if (request.url().endsWith('/brain/recheck')) rechecks.push(request.method());
        });

        await page.goto(harness.url);
        await expect(page.getByTestId('brain-chip')).toHaveAttribute('data-brain', 'demo', { timeout: 20_000 });

        await page.getByRole('button', { name: 'open chess' }).click();
        await page.getByTestId('starter-install').click();
        const app = page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
        await expect(app.getByRole('grid', { name: 'chessboard' })).toBeVisible({ timeout: 30_000 });
        await app.getByRole('button', { name: /^e2 / }).click();
        await app.getByRole('button', { name: /^e4 / }).click();

        // The demo brain's reply is off-script for chess, so the app plays a legal move FOR
        // it and says so. A think that went to the shim reads "the agent went quiet".
        await expect(app.getByText(/a legal move was played/), 'the think must be answered').toBeVisible({ timeout: 30_000 });
        await expect(app.getByRole('status').first()).toHaveText(/your move/);
        expect(thinks, 'no think may reach the shim while the brain is known not ready').toEqual([]);

        // The page asked the runner to look again — the user may have just fixed it — and
        // did not ask in a loop: once per floor, however often the brain was read.
        expect(rechecks.length).toBeGreaterThanOrEqual(1);
        expect(rechecks.length).toBeLessThanOrEqual(2);
        expect(rechecks.every((method) => method === 'POST')).toBe(true);
        expect(errors).toEqual([]);
        await page.close();
      },
      { brain: state },
    );
  });
}
