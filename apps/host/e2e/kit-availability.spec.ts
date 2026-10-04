// kit-availability.spec.ts — the capability-true shelf on the REAL built page
// (TASK-20261003 R3, ADR-0072 §4): S2 (the shelf), S3 (the run route), S5 (the host passport)
// and S6 — the design acceptance jsdom cannot give: no horizontal scroll at 375px, a real
// hit-test on the reason and its link, keyboard order and a visible focus ring, reduced
// motion, and a screenshot of every new surface in both themes at 1280 and 375.
//
// The page served over loopback http with no host globals carries no transport seat and
// has the connections surface off, so it offers NOTHING an app can need: every connected
// starter is disabled with its own reason. (Which `binding` that page reports is R2's to
// decide; nothing here depends on it — the verdict is derived from seats, not from a name.)
//
// Run via `pnpm --filter host test:e2e` (cwd = apps/host), after `pnpm --filter host build`.
import { expect, test, type Locator, type Page } from '@playwright/test';

import { installHostedFake } from './artifact-helpers';
import { KIT_URL, installRoutePolicy, watchConsole } from './helpers';

/** Folder → the reason its tile shows where nothing is offered. The four keepers have none. */
const BLOCKED: Record<string, string> = {
  github: 'needs live connections',
  gmail: 'needs live connections',
  hue: 'needs your home network',
  ledger: 'needs live connections',
  spotify: 'needs live connections',
  'trade copilot': 'needs live connections',
  weather: 'needs live connections',
  whatsapp: 'needs the phone helper',
};
const KEEPERS = ['adventure quest', 'chess', 'flying pig', 'quiz me'];

const tile = (page: Page, name: string): Locator => page.locator(`[data-testid="starter-tile"][data-starter-name="${name}"]`);

async function expectNoHorizontalScroll(page: Page, what: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${what}: the page must never scroll horizontally`).toBeLessThanOrEqual(1);
}

/** A REAL hit-test: the element under the centre of `target` is `target` itself (or inside it). */
async function expectTappable(target: Locator, what: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const hit = await target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return under !== null && (under === el || el.contains(under));
  });
  expect(hit, `${what} must be the thing a finger lands on`).toBe(true);
}

/** The focus ring is the theme's: a 2px solid outline (tokens.css `:focus-visible`). */
async function expectFocusRing(target: Locator, what: string): Promise<void> {
  await expect(target, `${what} takes keyboard focus`).toBeFocused();
  const ring = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(ring.style, `${what} shows a focus ring`).toBe('solid');
  expect(ring.width).toBeGreaterThanOrEqual(2);
}

async function tabTo(page: Page, target: Locator, limit = 80): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error('the target was never reached by Tab');
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.dataset.theme);
  if (current !== theme) await page.getByRole('button', { name: `switch to ${theme} theme` }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test.describe('S2 — the shelf offers only what this host can run', () => {
  test('every connected starter is disabled at first paint with its own reason; the four keepers play; the web badge is not used here', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('starter-tile')).toHaveCount(KEEPERS.length + Object.keys(BLOCKED).length);

    await expect(page.getByTestId('tile-blocked-reason')).toHaveCount(Object.keys(BLOCKED).length);
    await expect(page.getByTestId('desktop-only-badge')).toHaveCount(0);
    for (const [name, reason] of Object.entries(BLOCKED)) {
      await expect(tile(page, name).getByTestId('tile-blocked-reason')).toHaveText(reason);
      const control = tile(page, name).locator('.tile-card-button');
      await expect(control).toHaveAttribute('aria-disabled', 'true');
      // aria-disabled, never the `disabled` attribute: the reason stays reachable by keyboard.
      // (Read off the element — Playwright's own enabled/disabled matchers count aria-disabled.)
      expect(await control.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false);
    }
    for (const name of KEEPERS) {
      await expect(tile(page, name).locator('.tile-card-button')).not.toHaveAttribute('aria-disabled', 'true');
      await expect(tile(page, name).getByTestId('tile-blocked-reason')).toHaveCount(0);
    }
    // Where each runs: a browser cannot carry Trade Copilot (its provider refuses browsers).
    await expect(tile(page, 'trade copilot').getByTestId('tile-runs-in')).toHaveText('runs in Snug for Mac · your agent’s plugin');
    await expect(tile(page, 'weather').getByTestId('tile-runs-in')).toHaveText('runs in Snug for Mac · your agent’s plugin · the web playground');
    await expect(tile(page, 'hue').getByTestId('tile-runs-in')).toHaveText('runs in Snug for Mac');
    expect(errors).toEqual([]);
  });

  test('a blocked tile is focusable, shows a focus ring, is described by its reason — and activating it goes nowhere', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    const control = tile(page, 'hue').locator('.tile-card-button');
    await expect(control).toBeVisible();

    await tabTo(page, control);
    await expectFocusRing(control, 'the blocked tile');
    const describedBy = await control.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText('needs your home network');

    const before = page.url();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    // `force`: Playwright waits for a target to be enabled, and aria-disabled counts as not.
    await control.click({ force: true });
    expect(page.url(), 'no navigation from a blocked tile').toBe(before);

    // The next Tab stop is the reason's own link — the one thing on the tile that acts.
    await page.keyboard.press('Tab');
    const link = tile(page, 'hue').getByTestId('runs-in-desktop');
    await expectFocusRing(link, 'the "runs in" link');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/download$/);
    await expect(page.getByTestId('download-page')).toBeVisible();
  });
});

test.describe('S3 — the run route obeys the same verdict (no bypass by URL)', () => {
  test('#/run/starter--weather shows the reason instead of the frame; the header stays; a starter with no needs still mounts its frame', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(`${KIT_URL}#/run/starter--weather`);

    const panel = page.getByTestId('run-blocked');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Should I? can’t run here');
    await expect(panel).toContainText('needs live connections');
    await expect(panel).toContainText('connections aren’t available in this host');
    await expect(page.locator('[data-testid="frame-wrap"] iframe'), 'the app frame never mounts').toHaveCount(0);
    await expect(page.getByText('sample mode')).toHaveCount(0);
    // The header stays — but it does NOT offer install (MIGRATED in R4; this pinned the
    // button as visible): installing a starter this host cannot run only makes a tile that
    // is blocked the moment it appears.
    await expect(page.locator('.run-header .run-name')).toHaveText('Should I?');
    await expect(page.getByTestId('starter-install')).toHaveCount(0);

    await panel.getByTestId('run-blocked-download').click();
    await expect(page).toHaveURL(/#\/download$/);

    // The positive twin, on the same page: chess declares nothing, runs, and is offered.
    await page.goto(`${KIT_URL}#/run/starter--chess`);
    await expect(page.locator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('run-blocked')).toHaveCount(0);
    await expect(page.getByTestId('starter-install')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('reduced motion is honoured: the panel does not animate in', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#/run/starter--weather`);
    const card = page.locator('.run-blocked-card');
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).animationName), 'the positive twin: it animates by default').toBe('run-blocked-in');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });
});

test.describe('S5 — the host passport', () => {
  test('one chip beside the brain and your-file chips; six rows, each a yes or a no; opens and closes from the keyboard', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    const chip = page.getByTestId('host-passport');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    // Chip-row order: brain, (your file, where the host carries a custody seat), passport.
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('.shell-nav [data-testid]')].map((el) => el.getAttribute('data-testid')).filter((id) => id === 'brain-chip' || id === 'your-file-chip' || id === 'host-passport'),
    );
    expect(order[0]).toBe('brain-chip');
    expect(order[order.length - 1]).toBe('host-passport');

    await tabTo(page, chip);
    await expectFocusRing(chip, 'the passport chip');
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('host-passport-menu');
    await expect(menu).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');

    const rows = menu.locator('[data-testid^="host-passport-row-"]');
    await expect(rows).toHaveCount(6);
    // No connections here, so nothing that rides them — the same table the shelf above obeys.
    for (const key of ['connections', 'sign-in', 'home-network', 'phone-helper']) {
      await expect(page.getByTestId(`host-passport-row-${key}`)).toHaveAttribute('data-can', 'false');
    }
    await expect(page.getByTestId('host-passport-row-thinks')).toHaveAttribute('data-can', 'false');
    await expect(page.getByTestId('host-passport-row-connections')).toContainText('connections aren’t available in this host');

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(chip, 'Escape returns focus to the chip').toBeFocused();
  });

  test('inside a hosted artifact (faked runtime) the host thinks and keeps the file — and still has no connections', async ({ page }) => {
    await installHostedFake(page);
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    await page.getByTestId('host-passport').click();
    await expect(page.getByTestId('host-passport-menu')).toContainText('a Claude artifact');
    await expect(page.getByTestId('host-passport-row-thinks')).toHaveAttribute('data-can', 'true');
    await expect(page.getByTestId('host-passport-row-file')).toHaveAttribute('data-can', 'true');
    await expect(page.getByTestId('host-passport-row-connections')).toHaveAttribute('data-can', 'false');
    await expect(page.getByTestId('tile-blocked-reason')).toHaveCount(Object.keys(BLOCKED).length);
  });
});

test.describe('S6 — 375px: nothing scrolls sideways, and the reason and its link can be tapped', () => {
  // hasTouch: `tap()` is a touch event, and the project's Desktop Chrome device has none.
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('the hub', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    await expect(page.getByTestId('tile-blocked-reason')).toHaveCount(Object.keys(BLOCKED).length);
    await expectNoHorizontalScroll(page, 'the hub at 375px');

    for (const name of ['hue', 'trade copilot', 'weather']) {
      await expectTappable(tile(page, name).getByTestId('tile-blocked-reason'), `${name}: the reason`);
      await expectTappable(tile(page, name).getByTestId('runs-in-desktop'), `${name}: the "runs in" link`);
      // Nothing in a tile is wider than the tile.
      const fits = await tile(page, name).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(fits, `${name}: the tile's own content fits`).toBe(true);
    }
    // A real tap (coordinates + hit-testing), not a dispatched click.
    await tile(page, 'hue').getByTestId('runs-in-desktop').tap();
    await expect(page).toHaveURL(/#\/download$/);
  });

  test('the passport popover fits the screen with a gutter on each side', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    const chip = page.getByTestId('host-passport');
    await expectTappable(chip, 'the passport chip');
    await chip.tap();
    const menu = page.getByTestId('host-passport-menu');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x, 'left gutter').toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width, 'right gutter').toBeLessThanOrEqual(375 - 8);
    await expectNoHorizontalScroll(page, 'the hub with the passport open');
    await expect(menu.locator('[data-testid^="host-passport-row-"]')).toHaveCount(6);
  });

  test('the blocked run route', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#/run/starter--trade-copilot`);
    const panel = page.getByTestId('run-blocked');
    await expect(panel).toBeVisible();
    // Two blockers under a host with nothing: the network, and a provider that refuses browsers.
    await expect(panel.getByTestId('run-blocked-need')).toHaveCount(2);
    await expectNoHorizontalScroll(page, 'the blocked run route at 375px');
    await expectTappable(panel.getByTestId('run-blocked-download'), 'the Snug for Mac action');
  });
});

test.describe('S6 — screenshots: every new surface, both themes, 1280 and 375', () => {
  for (const width of [1280, 375] as const) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${theme} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await installRoutePolicy(page, { allowJsDelivr: true });
        await page.goto(KIT_URL);
        await setTheme(page, theme);

        await expect(page.getByTestId('tile-blocked-reason')).toHaveCount(Object.keys(BLOCKED).length);
        await expectNoHorizontalScroll(page, `hub ${theme} ${width}`);
        await page.screenshot({ path: `test-results/kit-availability-shelf-${theme}-${width}.png`, fullPage: true });

        await page.getByTestId('host-passport').click();
        await expect(page.getByTestId('host-passport-menu')).toBeVisible();
        await expectNoHorizontalScroll(page, `passport ${theme} ${width}`);
        await page.screenshot({ path: `test-results/kit-availability-passport-${theme}-${width}.png` });
        await page.keyboard.press('Escape');

        await page.goto(`${KIT_URL}#/run/starter--trade-copilot`);
        await expect(page.getByTestId('run-blocked')).toBeVisible();
        await expectNoHorizontalScroll(page, `run route ${theme} ${width}`);
        await page.screenshot({ path: `test-results/kit-availability-run-blocked-${theme}-${width}.png` });
      });
    }
  }
});
