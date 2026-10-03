// kit-boot.spec.ts — the ONE boot on the REAL built page, where no runner is (TASK-20261003
// K2/K3, ADR-0072 §2). The unit matrix (`src/__tests__/boot.test.tsx`) proves the decision
// against fake windows; this proves the built page makes it in a real browser:
//
//   * served from the literal http://127.0.0.1 by a STATIC server, the page asks its own
//     origin `/status` exactly once, takes the 404 as "not a runner", and boots file-class;
//   * a fragment that LOOKS like a launch token is still claimed there (the origin is the
//     runner's; whether a runner answers is what the request finds out) — and then the page
//     boots on the hub, not on a route called `token=…`;
//   * opened from file:// it asks nobody;
//   * `/oauth/callback` cannot be reached on this server at all (it serves one path), which
//     is the artifact shape — the runner's callback leg is `local-oauth.spec.ts`.
//
// Run via `pnpm --filter host test:e2e` (cwd = apps/host), after `pnpm --filter host build`.
import { expect, test } from '@playwright/test';

import { KIT_FILE_URL, KIT_ORIGIN, KIT_URL, installRoutePolicy, watchConsole } from './helpers';

const sameOriginPaths = (all: string[]): string[] => all.filter((url) => url.startsWith(KIT_ORIGIN)).map((url) => new URL(url).pathname);

test.describe('K2 — at loopback http with no runner behind it', () => {
  test('the page asks its own origin ONE question — /status — and boots file-class on the 404', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    expect(sameOriginPaths(policy.all)).toEqual(['/snug-host.html', '/status']);
    // File-class: the hub, the "in this browser" custody copy, a passport that says so.
    await expect(page.getByTestId('your-file-chip')).toContainText('in this browser');
    await page.getByTestId('host-passport').click();
    await expect(page.getByTestId('host-passport-menu')).toContainText('this host: a page in your browser');
    await expect(page.getByText(/Open Snug from your agent/)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the request carries NO bearer when the page holds none — and none is invented', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    const status = page.waitForRequest((request) => request.url() === `${KIT_ORIGIN}/status`);
    await page.goto(KIT_URL);
    expect((await status).headers()['authorization']).toBeUndefined();
  });

  test('a launch-token fragment is stripped before the router sees it: the page lands on the hub, never on a route named `token=…`', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#token=${'a'.repeat(64)}`);
    await expect(page.getByTestId('starter-tile').first()).toBeVisible();
    expect(page.url()).toBe(`${KIT_URL}#/`);
    expect(page.url()).not.toContain('token=');
  });

  test('a deep link keeps its route across the boot (K3: HashRouter, exactly as before)', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#/settings`);
    await expect(page.getByTestId('settings-section-your-file')).toBeVisible();
    expect(page.url()).toBe(`${KIT_URL}#/settings`);
    // …and navigation still writes the address bar: the hash router is the one mounted.
    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page).toHaveURL(`${KIT_URL}#/`);
    await page.goBack();
    await expect(page).toHaveURL(`${KIT_URL}#/settings`);
  });
});

test.describe('K2 — opened from file://', () => {
  test('asks nobody whether it is a runner, and claims no token', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: false, allowStarters: false });
    await page.goto(`${KIT_FILE_URL}#token=${'a'.repeat(64)}`);
    // The fragment is not a route, so the hub's routes do not match — and that is the point:
    // nothing treated it as a credential, stripped it or stored it.
    await page.waitForLoadState('load');
    expect(policy.all.filter((url) => /\/status(\?|$)/.test(url))).toEqual([]);
    expect(page.url()).toContain(`#token=${'a'.repeat(64)}`);
    expect(await page.evaluate(() => {
      try {
        return sessionStorage.getItem('snug-host-token');
      } catch {
        return null;
      }
    })).toBeNull();
    await page.goto(`${KIT_FILE_URL}#/`);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
  });
});
