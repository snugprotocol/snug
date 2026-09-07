// Binding B, end to end (ADR-0068 AC2/AC3/AC6/AC7).
//
// A real Chromium, the real built page, and the real local host process. The point of the
// suite is the seams the unit tests cannot reach: whether the page actually claims its
// token, whether the executor's request actually reaches a provider through the process,
// and whether the refusals hold against a browser rather than against a fake request.

import { expect, test, type Browser } from '@playwright/test';
import { chromium } from '@playwright/test';

import { startLocalHost, STUB_HOST, type LocalHarness } from './local-setup.js';

let browser: Browser;

test.beforeAll(async () => {
  // Its own browser: the stub is self-signed, and that allowance must not leak into the
  // kit's own project, which asserts that nothing outside the page's origin is reachable.
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  });
});
test.afterAll(async () => {
  await browser?.close();
});

const withHost = async (fn: (harness: LocalHarness) => Promise<void>, options: Parameters<typeof startLocalHost>[0] = {}): Promise<void> => {
  const harness = await startLocalHost(options);
  try {
    await fn(harness);
  } finally {
    await harness.stop();
  }
};

test('AC2 — the page opens on the launch URL and reports this binding', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(harness.url);

    // The token is claimed and STRIPPED before the router runs: the address bar must not
    // keep the credential, and the hash must be a route rather than a token.
    await expect.poll(() => page.url()).not.toContain('token=');
    expect(page.url()).toContain('#/');

    // The kit rendered — not the refusal surface.
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
    await page.close();
  });
});

test('AC2 — a reload keeps working, because the token was remembered for this tab', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await page.goto(harness.url);
    await expect(page.locator('#root')).not.toBeEmpty();
    // The fragment is gone by now; only sessionStorage can carry this.
    await page.reload();
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.getByText(/Open Snug from your agent/i)).toHaveCount(0);
    await page.close();
  });
});

test('AC2 — a tab opened WITHOUT a token says how to get one, rather than rendering a dead page', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${harness.port}/`);
    await expect(page.getByText(/Open Snug from your agent/i)).toBeVisible();
    await page.close();
  });
});

test('AC7 — with the file held, the page REFUSES to open and names the holder', async () => {
  // Not read-only: the db swallows failed saves, so an opened page would take an hour of
  // work and lose it. The refusal names Snug for Mac because closing it is the remedy.
  await withHost(
    async (harness) => {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await expect(page.getByText(/Snug for Mac has your file/i)).toBeVisible();
      await page.close();
    },
    { holder: 'Snug for Mac' },
  );
});

test('AC6 — the data plane refuses a request from a page on another origin', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    // A foreign origin that resolves to loopback — the rebinding shape, in a real browser.
    await page.goto(`https://${STUB_HOST}:43520/`).catch(() => {});
    const status = await page.evaluate(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: 'Bearer ' + 'a'.repeat(64) } });
        return response.status;
      } catch {
        return 'blocked';
      }
    }, harness.port);
    // Either the browser refuses it (CORS, no preflight answer) or the process does. Both
    // are correct; what must never happen is a 200.
    expect(status).not.toBe(200);
    await page.close();
  });
});

test('AC6 — the bearer is required: the page’s own origin cannot call without it', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await page.goto(harness.url);
    const status = await page.evaluate(async () => (await fetch('/status')).status);
    expect(status).toBe(401);
    await page.close();
  });
});
